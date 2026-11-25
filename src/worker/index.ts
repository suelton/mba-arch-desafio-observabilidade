import http from 'node:http';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import { consumirPedido, criarConexaoRedis } from '../fila/fila';
import { ROOT_CONTEXT, SpanKind, propagation, trace } from '@opentelemetry/api';
import { log, registrarNoSpan } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar, pedidosConfirmados } from '../telemetria/metricas';
import { decidirStatusDoPedido } from './conciliacao';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);

const tracer = trace.getTracer('loja-pedidos');

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('worker ouvindo na porta ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: Record<string, unknown>): Promise<void> {
  const pedidoId = Number(mensagem.pedido_id);
  const clienteId = String(mensagem.cliente_id);
  const valorTotal = Number(mensagem.valor_total);

  // continua o trace da api: extrai sobre um contexto raiz, nao sobre o ativo do worker
  const contextoPai = propagation.extract(
    ROOT_CONTEXT,
    (mensagem.contexto_trace ?? {}) as Record<string, string>
  );

  await tracer.startActiveSpan(
    'pedido.processar',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'pedido.id': pedidoId,
        'pedido.cliente_id': clienteId,
        'pedido.valor_total': valorTotal,
      },
    },
    contextoPai,
    async (span) => {
      try {
        log.info('mensagem do pedido ' + pedidoId + ' recebida da fila', pedidoId);

        const status = await decidirStatusDoPedido(clienteId, valorTotal, pedidoId);
        await atualizarStatusPedido(pedidoId, status);
        if (status === 'confirmado') {
          pedidosConfirmados.inc();
        }
        span.setAttribute('pedido.status', status);

        log.info('pedido ' + pedidoId + ' ficou ' + status, pedidoId);
      } catch (erro) {
        registrarNoSpan(erro);
        throw erro;
      } finally {
        span.end();
      }
    }
  );
}

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  const encerrar = () => {
    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('worker consumindo a fila de pedidos');

  while (rodando) {
    try {
      const mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      log.error('erro ao ler a fila: ' + (erro as Error).message);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  log.error('worker nao conseguiu iniciar: ' + erro.message);
  process.exit(1);
});
