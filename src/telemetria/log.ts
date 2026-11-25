import { isSpanContextValid, SpanStatusCode, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

function escrever(level: Nivel, msg: string, pedidoId?: number): void {
  // trace_id e span_id sempre presentes; vazios quando nao ha span ativo
  const contexto = trace.getActiveSpan()?.spanContext();
  const ativo = contexto !== undefined && isSpanContextValid(contexto);

  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    trace_id: ativo ? contexto.traceId : '',
    span_id: ativo ? contexto.spanId : '',
    ...(pedidoId !== undefined ? { pedido_id: pedidoId } : {}),
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, pedidoId?: number): void {
    escrever('info', msg, pedidoId);
  },
  warn(msg: string, pedidoId?: number): void {
    escrever('warn', msg, pedidoId);
  },
  error(msg: string, pedidoId?: number): void {
    escrever('error', msg, pedidoId);
  },
};

// Marca a excecao no span ativo (evento + status de erro), sem log.
export function registrarNoSpan(erro: unknown): void {
  const span = trace.getActiveSpan();
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  span?.recordException(erro instanceof Error ? erro : mensagem);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: mensagem });
}

// Excecao capturada: span em erro + linha de log error com o motivo.
export function registrarExcecao(erro: unknown, contexto: string, pedidoId?: number): void {
  registrarNoSpan(erro);
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  log.error(contexto + ': ' + mensagem, pedidoId);
}
