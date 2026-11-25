# Post-mortem: pedidos confirmados sem cobrança

## Resumo

Quando o gateway de pagamento falha para um cliente, o worker trata a falha como se tudo tivesse dado certo: o pedido é marcado como `confirmado` sem que a cobrança tenha sido feita. Do lado de fora tudo é 2xx, então nenhum painel de caixa preta mostrou algo, e o problema só apareceu quando o financeiro fechou o mês e o dinheiro não bateu. Na reprodução (`cenario-a`), 111 de 243 pedidos confirmados (46%), R$ 107.547,28, não foram cobrados; agora a falha é visível em log, trace e métrica, e um alerta dispara em ~1m40s.

## Impacto

Período reproduzido: `cenario-a` de 2026-11-25 13:11:36Z a 13:14:12Z (~2m36s), 261 pedidos criados.

| Medida | Valor | Origem |
| --- | --- | --- |
| Pedidos afetados (confirmados sem cobrança) | **111** | Banco: `pedidos` criados na janela, `status='confirmado'` e `cliente_id` terminando em 7 (clientes cujo gateway falha) |
| Valor envolvido | **R$ 107.547,28** | Banco: `SUM(valor_total)` dos mesmos 111 pedidos |
| Pedidos afetados, conferência | 111 | Log: 111 linhas `level=error` "falha na cobranca do cliente ..." do worker na janela, cada uma com `pedido_id` |
| Pedidos afetados, estimativa da métrica | ~121 | PromQL `sum(increase(cobrancas_processadas_total{resultado="falha"}[164s]))` avaliado às 13:14:20Z |
| Pedidos confirmados / recusados na janela | 243 / 18 | Banco (`status`) |
| Valor total confirmado na janela | R$ 237.563,39 | Banco |

A métrica responde **quantos** (cobranças com `falha`), mas **não responde quanto vale**: os contadores contam eventos, não somam dinheiro, e por regra de cardinalidade não carregam o `pedido_id`. O valor só sai do banco (ou do log, via `pedido_id`). A estimativa de ~121 diverge de 111 porque `increase()` extrapola a janela de 164s para as bordas e porque a janela da consulta é um pouco mais larga que a do cenário; a contagem exata é a do banco e do log, que coincidem.

## Detecção

- **Hoje (sem este trabalho):** o problema foi descoberto pelo financeiro ao conciliar o mês, ou seja, após até ~30 dias de exposição, por uma pessoa e não por um sistema. O Grafana não mostrou nada porque as requisições são todas 2xx.
- **Com o alerta `FalhaEmCobrancas`:** na reprodução (normal rodando, depois `cenario-a`), a regra entrou em *firing* ~93s após o início da carga e o webhook chegou ao `receptor-alertas` em ~101s (T0 = 13:11:36Z, firing 13:13:09Z, webhook 13:13:17Z).
- **O que a diferença significa:** a exposição cai de semanas para menos de dois minutos (e esses dois minutos já incluem a janela de 2m do `rate()` diluindo o tráfego saudável, o `for` de 45s e o `group_wait` do Alertmanager). O alerta transforma uma descoberta contábil, tardia e manual, em detecção operacional no mesmo incidente, antes que o prejuízo cresça.

## Causa raiz

Arquivo `src/worker/conciliacao.ts`, função `decidirStatusDoPedido`. O `catch` engole a exceção do processador de pagamento (só a guarda num registro em memória que ninguém lê) e `recusado` continua `false`, então o retorno é `'confirmado'`:

```ts
export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
  } catch (erro) {
    registrarFalhaLegado(erro);          // falha engolida: nada é relançado
  }

  return recusado ? 'recusado' : 'confirmado';   // falha de cobrança vira 'confirmado'
}
```

(O código acima é o original; a instrumentação acrescentou ao `catch` o contador `falha`, o log `error` e o registro no span, sem alterar o fluxo.) O defeito foi **observado, não corrigido**, como pede o desafio.

## Evidências

- **trace_id (Jaeger):** `6f402e65319e6848d79585124578c546` (pedido 1806, cliente `cli-0367`). Um único trace com spans de `api` e `worker`, incluindo `pedido.criar` e `pedido.processar`; o span `pedido.processar` está marcado como erro (evento de exceção "gateway respondeu de forma inesperada"). URL: `http://localhost:16686/trace/6f402e65319e6848d79585124578c546`.
- **Comando de busca no log:** `docker compose logs api worker --no-log-prefix | grep 6f402e65319e6848d79585124578c546`. Resultado: 4 linhas, 1 da `api` ("pedido 1806 criado para cli-0367") e 3 do `worker` ("mensagem do pedido 1806 recebida da fila", **error** "falha na cobranca do cliente cli-0367: gateway respondeu de forma inesperada", "pedido 1806 ficou confirmado"), todas com o mesmo `trace_id` e `pedido_id=1806`. Para o conjunto: `docker compose logs worker | grep '"level":"error"'` devolveu 111 linhas na janela.
- **PromQL:** `sum(rate(pedidos_confirmados_total[2m])) - sum(rate(cobrancas_processadas_total{resultado="aprovada"}[2m]))` mostra a diferença entre pedidos confirmados e cobranças aprovadas (deveria ser ~0; fica positiva durante o cenário); e `sum(increase(cobrancas_processadas_total{resultado="falha"}[164s]))` retornou **121,36** (estimativa) contra 111 contados no banco/log. SLI durante o normal: `1 - sli:cobrancas_sem_falha:ratio_rate2m` = 0; durante o `cenario-a` subiu a dezenas de pontos percentuais, acima do limiar de 14,4%.

## Lições aprendidas

**O que correu bem**

- Depois da correlação log↔trace, partir de um único `trace_id` levou às linhas dos dois processos e ao span com erro em segundos.
- A métrica de negócio (`cobrancas_processadas_total{resultado="falha"}` contra `pedidos_confirmados_total`) expôs o que 2xx escondia, e o alerta derivado do SLO distinguiu o normal (recusas legítimas) do cenário com defeito.
- O contexto atravessa a fila: api e worker viram um trace só.

**O que correu mal**

- Ninguém era avisado: o defeito durou o mês inteiro e foi descoberto por conciliação manual.
- O `catch` engolia o erro e o contrato de saída (`confirmado`) mentia; a "falha legada" ficava num array em memória, sem log, métrica ou trace.
- Monitoramento só de caixa preta (HTTP 2xx, latência) é cego a este tipo de defeito.
- Durante os testes, a primeira versão da regra disparou no tráfego normal com volume mínimo (1 falha em 2 pedidos); foi preciso acrescentar uma guarda de volume.

**Onde tivemos sorte**

- A falha atinge um subconjunto de clientes e os pedidos continuam no banco com `cliente_id` e valor, então a recobrança é possível por conciliação.
- O volume era baixo o bastante para o financeiro perceber a diferença no fechamento; com volume maior ou valores menores poderia ter passado como arredondamento.

## Itens de ação

| Ação | Tipo | Prioridade |
| ---- | ---- | ---------- |
| Corrigir `decidirStatusDoPedido`: falha do gateway não pode virar `confirmado` (marcar `falha_pagamento`/reprocessar e não notificar o cliente como confirmado). **Descrita, não executada neste desafio.** | Evitar | P0 |
| Conciliar e recobrar os pedidos `confirmado` sem cobrança do período (query por `cliente_id`/log com `pedido_id`) | Mitigar | P0 |
| Manter o alerta `FalhaEmCobrancas` (SLO 99%/30d, burn rate 14,4) e criar um alerta de ticket para burn rate lento (ex.: 6h) | Mitigar | P1 |
| Alerta/painel de divergência `pedidos_confirmados_total` vs `cobrancas_processadas_total{resultado="aprovada"}` | Mitigar | P1 |
| Proibir `catch` que engole exceção sem log/métrica (lint + revisão), e testes de contrato para `decidirStatusDoPedido` com gateway falhando | Evitar | P2 |

## Timeline

Horários em UTC, 2026-11-25, reconstruídos dos logs, do Prometheus e do receptor de alertas. Nota: li o código ao subir o ambiente (para instrumentá-lo); a causa raiz foi, contudo, confirmada pela telemetria e não só pela leitura.

- **Mês anterior:** defeito em produção, sem sinal em nenhum painel (tudo 2xx).
- **Fechamento do mês:** o financeiro cruza pedidos confirmados com o recebido e encontra pedidos sem cobrança; circula a hipótese "problema do banco".
- **12:54:45** Instrumentação pronta; pedido de teste do `cli-0007` aparece com `level=error` "falha na cobranca" e termina `confirmado`: primeira evidência da hipótese correta.
- **12:56:02** A primeira versão do alerta dispara no tráfego normal (volume baixo logo após subir a stack); adicionada guarda de volume mínimo (≥ 20 cobranças em 2m).
- **12:59–13:03** Cenário normal por mais de 3 minutos após reiniciar o `receptor-alertas`: nenhum alerta. **13:03–13:07** teste com normal e `cenario-a` sobrepostos (alerta às 13:05:17, resolvido às 13:07:47), descartado como medição de detecção.
- **13:11:36** T0: `cenario-a` inicia logo após o normal. **13:11:39** primeira linha `error` com `pedido_id` e `trace_id`.
- **13:13:09** `FalhaEmCobrancas` passa a *firing* no Prometheus (+93s). **13:13:17** webhook chega ao `receptor-alertas` (+101s).
- **13:14:10** Carga interrompida; consultas ao banco/log/PromQL para quantificar (111 pedidos, R$ 107.547,28).
- **Pendente (fora do escopo):** correção definitiva do defeito e recobrança dos pedidos afetados.
