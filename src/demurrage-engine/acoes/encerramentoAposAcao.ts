import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ResultadoEncerramentoAutomatico } from '../closing/closingService';
import { avaliarEncerramentoAposAcao } from '../closing/encerramentoAutomatico';

/**
 * Produção P1 (reabertura controlada) — adaptador das rotas de ação: executa
 * a ação (um serviço congelado, passado como closure) e, SÓ quando ela
 * sucede, dispara a avaliação AUTOMÁTICA de encerramento do processo afetado
 * (`closing/encerramentoAutomatico.ts`). A rota continua chamando uma única
 * função; nenhuma regra de negócio aqui — só a ordem "ação comitada →
 * avaliação". Falha inesperada da avaliação nunca vira erro da ação (já
 * comitada): o resultado diz `avaliacao_adiada` e a varredura reavalia.
 */
export async function comEncerramentoAutomatico<T>(
  pool: Pool,
  processoId: string | null,
  hoje: CivilDate,
  acao: () => Promise<T>,
  sucedeu: (resultado: T) => boolean,
): Promise<{ resultado: T; encerramento: ResultadoEncerramentoAutomatico | null }> {
  const resultado = await acao();
  if (!sucedeu(resultado)) return { resultado, encerramento: null };
  const encerramento = await avaliarEncerramentoAposAcao(pool, processoId, hoje);
  return { resultado, encerramento };
}
