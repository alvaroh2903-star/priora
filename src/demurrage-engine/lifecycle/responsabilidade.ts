import { ApuracaoDemurrageStatus, Responsabilidade } from './types';

/**
 * Responsabilidade por contêiner (Fase 8), função PURA.
 *
 * Fonte de verdade é o contêiner. Enquanto a Fase 11 não gravar uma decisão
 * (`stored`), a responsabilidade é DERIVADA da existência da demurrage:
 *  - stored != null → a decisão da Fase 11 prevalece;
 *  - demurrage confirmada e sem decisão → EM_ANALISE;
 *  - sem demurrage confirmada → NAO_APLICAVEL.
 *
 * `INDETERMINADA` (apuração incompleta) NÃO é "demurrage confirmada" — logo
 * responsabilidade fica NAO_APLICAVEL até a apuração se tornar determinável.
 */
export function derivarResponsabilidade(
  apuracao: ApuracaoDemurrageStatus,
  stored: Responsabilidade | null,
): Responsabilidade {
  if (stored) return stored;
  return apuracao === 'DEMURRAGE_CONFIRMADA' ? 'EM_ANALISE' : 'NAO_APLICAVEL';
}
