import { CivilDate } from '../temporal/civilDate';

/**
 * Fase 9 — Bloco 1: fase OPERACIONAL de tracking de um contêiner, PURA e DERIVADA.
 *
 * A fase NÃO é persistida (aprovado): é sempre consequência de fatos já gravados
 * (associação ao VesselCall, chegada/atracação confirmadas, descarga, devolução).
 * O histórico continua sendo os próprios eventos/fatos que causaram as transições.
 * Esta função não lê banco, não usa relógio e não decide consulta/cadência — só
 * classifica o contêiner na etapa correta para orientar QUAL canal é dominante.
 *
 * Princípio: o VesselCall acompanha o navio até a chegada/atracação; o tracking
 * individual acompanha o contêiner da descarga até a devolução. Isto é um OVERLAY
 * somente-leitura: não altera a cadência congelada, os claims, os targets, o
 * consumo de créditos, os relógios nem as tarifas.
 *
 * IMPORTANTE (contrato atual): `chegada` e `atracacao` só são "confirmadas" quando
 * houver FONTE VÁLIDA no VesselCall. Como o contrato atual não distingue evento
 * previsto de confirmado, hoje esses campos permanecem nulos e `EM_PORTO`
 * praticamente não ocorre — o contêiner salta de `PRE_CHEGADA`/`SEM_VESSELCALL`
 * direto para `POS_DESCARGA`. A máquina já suporta `EM_PORTO` para quando a fonte
 * existir; nunca inferir chegada de ETA, `berth` ambíguo ou passagem do tempo.
 */

export type TrackingPhase =
  | 'SEM_VESSELCALL'
  | 'PRE_CHEGADA'
  | 'EM_PORTO'
  | 'POS_DESCARGA'
  | 'DEVOLVIDO';

/** Fatos JÁ persistidos necessários para derivar a fase (nenhum é inventado aqui). */
export interface FatosFaseTracking {
  /** Existe associação ATIVA e confiável do contêiner a um VesselCall. */
  associacaoVesselCallAtiva: boolean;
  /** Chegada ao porto CONFIRMADA por fonte válida (vessel_calls.chegada não-nula). */
  chegadaConfirmada: boolean;
  /** Atracação CONFIRMADA por fonte válida (vessel_calls.atracacao não-nula). */
  atracacaoConfirmada: boolean;
  /** Descarga confirmada do contêiner (containers.discharge_date). */
  dischargeDate: CivilDate | null;
  /** Devolução do vazio confirmada (effective tem precedência; senão tracking). */
  effectiveReturnDate: CivilDate | null;
  trackingReturnDate: CivilDate | null;
}

/**
 * Deriva a fase avaliando os fatos do MAIS conclusivo ao menos conclusivo, de modo
 * que um fato posterior sempre prevaleça — sem depender de ter observado todas as
 * transições intermediárias (saltos são válidos):
 *   1. devolução confirmada        → DEVOLVIDO
 *   2. descarga confirmada         → POS_DESCARGA
 *   3. chegada OU atracação        → EM_PORTO
 *   4. associação ativa ao VesselCall → PRE_CHEGADA
 *   5. sem associação              → SEM_VESSELCALL
 */
export function derivarFaseTracking(fatos: FatosFaseTracking): TrackingPhase {
  const devolvido = fatos.effectiveReturnDate !== null || fatos.trackingReturnDate !== null;
  if (devolvido) return 'DEVOLVIDO';
  if (fatos.dischargeDate !== null) return 'POS_DESCARGA';
  if (fatos.chegadaConfirmada || fatos.atracacaoConfirmada) return 'EM_PORTO';
  if (fatos.associacaoVesselCallAtiva) return 'PRE_CHEGADA';
  return 'SEM_VESSELCALL';
}
