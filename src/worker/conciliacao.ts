import { registrarExcecao } from '../telemetria/log';
import { cobrancasProcessadas } from '../telemetria/metricas';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number,
  pedidoId?: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    cobrancasProcessadas.labels(recusado ? 'recusada' : 'aprovada').inc();
  } catch (erro) {
    cobrancasProcessadas.labels('falha').inc();
    registrarExcecao(erro, 'falha na cobranca do cliente ' + clienteId, pedidoId);
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
