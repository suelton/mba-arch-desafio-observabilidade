# Do sintoma ao post-mortem

Loja online (TypeScript): `api` (8080), `worker` (8081), Postgres, Redis e a stack de observabilidade (Prometheus, Alertmanager, Grafana, Jaeger). Este repositório completa a instrumentação, define um SLO com alerta e investiga a queixa do financeiro em [`reports/post-mortem.md`](reports/post-mortem.md). O defeito da aplicação **não** foi corrigido, de propósito.

## Como rodar

```bash
git clone <url-do-fork> && cd mba-arch-desafio-observabilidade
cp .env.example .env
docker compose up -d --build

curl -s localhost:8080/health          # api
curl -s localhost:8081/health          # worker
```

| O quê | Onde |
| --- | --- |
| Prometheus (targets, regras) | http://localhost:9090/targets · http://localhost:9090/rules |
| Grafana (dashboard **Pedidos**, `admin`/`admin` do `.env`) | http://localhost:3000 |
| Jaeger | http://localhost:16686 |
| Receptor de alertas | http://localhost:9099 (`docker compose logs receptor-alertas`) |

Cargas e verificações:

```bash
docker compose run --rm carga normal       # tráfego saudável (Ctrl+C para parar)
docker compose run --rm carga cenario-a    # reproduz a queixa

docker compose logs api | tail -20
docker compose logs worker | tail -20
docker compose logs api worker | grep <trace_id>     # as linhas dos dois processos do mesmo trace
```

Depois de editar `src/`, rode `docker compose restart api worker` (o `package.json` exige `up -d --build`). Para provar que o dashboard vem sozinho: `docker compose down -v && docker compose up -d`.

## Equivalências com o curso

| Tema | Curso (Java) | Aqui (TypeScript) |
| --- | --- | --- |
| Métricas | Micrometer + Actuator (`/actuator/prometheus`) | `prom-client` (`Counter`, `Histogram`, `Registry`) e rota `/metrics` em `src/telemetria/metricas.ts` |
| Tracing | OpenTelemetry Java agent / bridge do Micrometer Tracing (`@Observed`, `Tracer`) | `@opentelemetry/sdk-node` + `auto-instrumentations-node` (`src/telemetria/otel.ts`); spans manuais com `trace.getTracer().startActiveSpan()` (`pedido.criar`, `pedido.processar`), exporter OTLP/HTTP para o Jaeger |
| Logs estruturados | Logback + encoder JSON, `traceId`/`spanId` no MDC | `log.ts` escreve JSON no stdout; `trace_id`/`span_id` lidos de `trace.getActiveSpan().spanContext()` a cada linha |
| Propagação de contexto | Propagação W3C automática em HTTP/mensageria pelo agent | `propagation.inject()` ao publicar na fila Redis (campo `contexto_trace` da mensagem) e `propagation.extract(ROOT_CONTEXT, ...)` no consumo, formato W3C `traceparent` |

## Decisões técnicas

**Erro de cardinalidade.** O histograma `http_request_duration_seconds` usava `requisicao.path` (caminho concreto, como `/produtos/42`) como label `route`, então cada id de produto/pedido criava uma série nova (× buckets × métodos × status) e o Prometheus acumularia séries sem limite até estourar a memória em produção. Corrigido para o template da rota (`requisicao.route.path` → `/produtos/:id`), e `nao_encontrada` para rotas sem handler.

**Métricas de negócio** (todas inicializadas em zero na subida, inclusive cada `resultado`):

- `pedidos_criados_total`: pedidos que a api gravou como pendentes (demanda de entrada).
- `pedidos_confirmados_total`: pedidos que o worker marcou como `confirmado` (o que o cliente e o financeiro enxergam como "vendido").
- `cobrancas_processadas_total{resultado}`: o que de fato aconteceu na cobrança: `aprovada`, `recusada` (resultado legítimo de negócio) ou `falha` (gateway quebrou). Confirmados − aprovadas = pedidos confirmados sem cobrança.

**Painéis do dashboard Pedidos** (4, por arquivo em `grafana/provisioning/dashboards/pedidos.json`):

| Painel | Pergunta |
| --- | --- |
| O sistema está com erro? Falhas de cobrança e respostas 5xx (% do total) | **O sistema está com erro?** |
| O sistema está lento? Latência p95 por rota | **O sistema está lento?** |
| O dinheiro está entrando? Cobranças por resultado (por segundo) | **O dinheiro está entrando?** |
| O dinheiro está entrando? Pedidos confirmados vs cobranças aprovadas (por segundo) | **O dinheiro está entrando?** |

O painel de tráfego que veio no arquivo foi removido: não respondia nenhuma das três perguntas.

**Instrumentação sem mudar comportamento.** Exceções capturadas são registradas no span (`recordException` + status `ERROR`) e geram log `error`; os `catch` relançam o erro, então o `POST /pedidos` continua se comportando como antes. `pedido_id` vai no log e nos atributos dos spans (onde identificador é barato), nunca em label de métrica.

## SLO e alerta

**SLI.** Fração das cobrancas processadas que não falharam (`recusada` é resultado de negócio legítimo, não falha):

```promql
sum(rate(cobrancas_processadas_total{resultado!="falha"}[2m]))
/
sum(rate(cobrancas_processadas_total[2m]))
```

(gravada como `sli:cobrancas_sem_falha:ratio_rate2m` em `prometheus/regras/cobrancas.yml`).

**SLO.** 99% das cobranças sem falha, em janela de 30 dias. **Error budget:** 1% (100% − 99%). Uma falha que corrompe dinheiro (pedido confirmado sem cobrança) não é tolerável em volume, e 99% deixa uma folga pequena para falhas isoladas do gateway.

**Da meta ao limiar.** Alerta por *burn rate* (velocidade de consumo do budget):

- Burn rate 1 consome exatamente o budget em 30 dias (taxa de falha = 1%).
- Escolhi burn rate **14,4**, o clássico de "página imediata": mantido por 1h consome 2% do budget mensal (14,4 × 1h / 720h = 2%).
- **Limiar = 14,4 × 1% = 14,4%** de cobranças com falha, na janela de 2m.

```promql
(1 - sli:cobrancas_sem_falha:ratio_rate2m) > 14.4 * (1 - 0.99)
and
sum(increase(cobrancas_processadas_total[2m])) >= 20
```

`for: 45s` (dentro do limite de 30s–1m). A segunda condição é uma guarda de volume mínimo: com poucas cobranças a proporção é ruído (durante os meus testes, 1 falha em 2 pedidos = 50% disparou a regra). O tráfego normal tem 0% de falha (só aprovadas e recusadas); o `cenario-a` tem ~40% de clientes que falham, bem acima de 14,4%.

Medido na reprodução: normal por 3 minutos sem nenhum alerta; no `cenario-a` (logo após o normal) a regra entrou em firing em ~93s e o webhook chegou ao receptor em ~101s.
