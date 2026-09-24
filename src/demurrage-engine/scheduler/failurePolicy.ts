import { FetchStatus } from '../persistence/trackingRepository';

/**
 * Regras de falha e de atualização manual (Fase 6). Puras.
 *
 * Uma falha nunca apaga o último resultado, nunca interrompe relógios, nunca
 * presume Empty Return. A 3ª falha CONSECUTIVA de um TrackingTarget abre o
 * incidente técnico; a supressão vale até um sucesso. Um sucesso zera a
 * sequência; uma nova sequência de 3 falhas é um novo incidente.
 */

export const LIMIAR_INCIDENTE = 3;
/** Cooldown de atualização manual por TrackingTarget (~2h). */
export const COOLDOWN_MANUAL_MS = 2 * 60 * 60 * 1000;

/** Uma consulta conta como falha só quando não trouxe resultado utilizável. */
export function ehFalha(status: FetchStatus): boolean {
  return status === 'falha';
}

/** Falhas consecutivas a partir do TOPO (consulta mais recente primeiro). */
export function falhasConsecutivas(statusesMaisRecentePrimeiro: FetchStatus[]): number {
  let n = 0;
  for (const s of statusesMaisRecentePrimeiro) {
    if (ehFalha(s)) n++;
    else break;
  }
  return n;
}

/** Abre incidente exatamente na 3ª falha consecutiva, e só se não houver um aberto. */
export function deveAbrirIncidente(consecutivas: number, incidenteAberto: boolean): boolean {
  return consecutivas >= LIMIAR_INCIDENTE && !incidenteAberto;
}

export type PapelRbac = 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT';

export interface DecisaoManual {
  permitido: boolean;
  motivo?: 'apenas_manager_admin' | 'cooldown';
}

/**
 * Atualização manual: só MANAGER/ADMIN; cooldown ~2h por target. Quem chama
 * ainda deve reutilizar o cache se houver resposta válida (sem nova puxada) e
 * executar em background — a interface nunca bloqueia esperando o armador.
 */
export function podeAtualizarManual(
  papel: PapelRbac,
  ultimaManualEm: Date | null,
  agora: Date,
): DecisaoManual {
  if (papel !== 'MANAGER' && papel !== 'ADMIN') return { permitido: false, motivo: 'apenas_manager_admin' };
  if (ultimaManualEm && agora.getTime() - ultimaManualEm.getTime() < COOLDOWN_MANUAL_MS) {
    return { permitido: false, motivo: 'cooldown' };
  }
  return { permitido: true };
}
