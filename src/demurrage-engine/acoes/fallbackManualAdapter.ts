import { Pool } from 'pg';
import {
  CONTRATO_REGISTRO_DEMURRAGE_V1, ErroContratoDemurrage, ManualFallbackGovernanca, RegistroProcessoDemurrageV1,
} from '../registro/contrato';
import { PosCommitIncompletoError, ResultadoRegistroDemurrage, registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';

/**
 * Produção P1 (Entrega 2) — adaptador de aplicação ESTREITO em torno do
 * registro congelado (D10), exigido porque `registrarProcessoDemurrage` só
 * aceita o contrato COMPLETO `demurrage.registro.v1` (organização,
 * `numeroProcesso`, `origem`, lista de contêineres) — não existe um método
 * "só aplica um fallback manual neste contêiner" no serviço congelado.
 *
 * Isto NÃO reescreve o D10: monta a entrada MÍNIMA válida do contrato
 * (apenas o contêiner e o campo de Free Time em questão; nenhum outro campo
 * de processo/contêiner é tocado) e delega inteiramente a
 * `registrarProcessoDemurrage` — a MESMA função que o handoff (Entrega 1) e
 * qualquer outro chamador de produção usam. A governança (justificativa,
 * `autorMembershipId` real, evidência obrigatória, papel permitido, nunca
 * `tracking_service`) é toda imposta pelo contrato/serviço já congelados
 * (achados D10 v1.1 §2 / v1.2) — este adaptador nunca verifica nada disso
 * por conta própria, nunca escreve em `field_observations`/`containers`
 * diretamente, e nunca chama `promoverHouseFreeTimeComClient`/
 * `promoverMasterFreeTimeComClient` diretamente (isso pularia a governança).
 *
 * `numeroProcesso` é resolvido PELO CHAMADOR (rota) a partir do próprio
 * `containerId` — nunca aceito do corpo da requisição — para que a chamada
 * sempre seja tratada como ATUALIZAÇÃO do processo já existente, nunca como
 * criação de um processo novo.
 */

export type CampoFreeTime = 'house' | 'master';

export interface EntradaFallbackManual {
  organizationId: string;
  numeroProcesso: string;
  numeroContainer: string;
  campo: CampoFreeTime;
  valorDias: number;
  observadoEm: string;
  evidenciaRef: string;
  autorMembershipId: string;
  justificativa: string;
}

function construirEntradaRegistro(entrada: EntradaFallbackManual): RegistroProcessoDemurrageV1 {
  const governanca: ManualFallbackGovernanca = { justificativa: entrada.justificativa, autorMembershipId: entrada.autorMembershipId };
  const observado = { valor: entrada.valorDias, fonte: 'manual_fallback' as const, observadoEm: entrada.observadoEm, evidenciaRef: entrada.evidenciaRef, manualFallback: governanca };
  return {
    versao: CONTRATO_REGISTRO_DEMURRAGE_V1,
    organizationId: entrada.organizationId,
    numeroProcesso: entrada.numeroProcesso,
    origem: { sistema: 'acoes-operacionais', referencia: 'fallback_manual' },
    containers: [{
      numero: entrada.numeroContainer,
      tipoOriginal: null,
      houseFreeTimeDays: entrada.campo === 'house' ? observado : null,
      masterFreeTimeDays: entrada.campo === 'master' ? observado : null,
    }],
  };
}

export type ResultadoFallbackManual =
  | { ok: true; resultado: ResultadoRegistroDemurrage }
  | { ok: false; motivo: 'pos_commit_incompleto'; processoId: string }
  | { ok: false; motivo: 'contrato_invalido'; codigo: string; detalhe: Record<string, unknown> };

/** Único ponto de chamada ao D10 para o fallback manual governado — ver cabeçalho do arquivo. */
export async function aplicarFallbackManualContainer(pool: Pool, entrada: EntradaFallbackManual): Promise<ResultadoFallbackManual> {
  const entradaRegistro = construirEntradaRegistro(entrada);
  try {
    const resultado = await registrarProcessoDemurrage(entradaRegistro, { pool });
    return { ok: true, resultado };
  } catch (erro) {
    if (erro instanceof PosCommitIncompletoError) return { ok: false, motivo: 'pos_commit_incompleto', processoId: erro.processoId };
    if (erro instanceof ErroContratoDemurrage) return { ok: false, motivo: 'contrato_invalido', codigo: erro.codigo, detalhe: erro.detalhe };
    throw erro;
  }
}
