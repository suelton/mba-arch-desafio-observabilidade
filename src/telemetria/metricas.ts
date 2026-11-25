import client from 'prom-client';

export const registro = new client.Registry();

client.collectDefaultMetrics({ register: registro });

export const TIPO_DE_CONTEUDO = registro.contentType;

export function coletar(): Promise<string> {
  return registro.metrics();
}

export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Pedidos gravados como pendentes pela api',
  registers: [registro],
});

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Pedidos que o worker marcou como confirmados',
  registers: [registro],
});

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Cobrancas processadas pelo worker, por resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

// Series nascem em zero na subida, para existirem antes do primeiro evento.
pedidosCriados.inc(0);
pedidosConfirmados.inc(0);
for (const resultado of ['aprovada', 'recusada', 'falha']) {
  cobrancasProcessadas.labels(resultado).inc(0);
}
