/**
 * Liberação L1a — tipos do domínio puro (sem I/O). Identidades vêm resolvidas
 * do S6 (`processoId`, `masterId`); o vínculo Processo↔Master é fato do S2; os
 * fatos de Courier são do S1. A L1a só avalia: não cria identidade, não
 * infere vínculo e não persiste nada.
 */

/** Instante ISO-8601 com fuso (ex.: '2026-10-01T12:00:00Z'). */
export type Instante = string;

export interface Evidencia {
  fonte: string;
  ref: string;
}

/** Disponibilidade atual de uma fonte — 3ª dimensão do N-17. */
export interface DisponibilidadeFonte {
  disponivel: boolean;
  desde: Instante;
}

/**
 * Fato oficial com as duas primeiras dimensões do N-17: o estado (`valor`) e
 * o frescor (`ultimaConfirmacaoEm`). `vigenteDesde` é a observação que
 * estabeleceu este valor; reconfirmações só avançam o frescor.
 */
export interface FatoOficial<V> {
  valor: V;
  vigenteDesde: Instante;
  ultimaConfirmacaoEm: Instante;
  evidencia: Evidencia;
}

/** Fontes que a Vertical 1 ainda não tem; um resultado "não determinável" diz quais faltam. */
export type FonteNaoIntegrada =
  | 'EMAIL_WAVE' // Master por Wave (cap. 23)
  | 'EMAIL_EMISSAO_DESTINO' // Master por emissão no destino (cap. 24)
  | 'PORTAL_FOTO_HBL' // House pelo caminho A (cap. 15)
  | 'EMAIL_TELEX' // House por Telex (cap. 16)
  | 'HEADCARGO' // Termo e financeiro do cliente (cap. 17–19)
  | 'PROCEDIMENTO_AGENCIA' // procedimento e apresentação (cap. 26–30)
  | 'SISCARGA'; // desbloqueio e conclusão (cap. 11, 39)

export type ModalidadeMaster = 'FISICO' | 'WAVE' | 'EMISSAO_DESTINO';

/* --------------------------- fatos consumidos --------------------------- */

/** Vínculo Processo↔Master confirmado: fato documental do S2/Auditoria (H-7). Consumido, nunca inferido. */
export interface VinculoProcessoMaster {
  processoId: string;
  masterId: string;
  vinculadoEm: Instante;
  evidencia: Evidencia;
}

export type EstadoEnvelope = 'EM_TRANSITO' | 'ENTREGUE';
export type ConferenciaMbl = 'RECEBIDO' | 'AUSENTE_NA_CONFERENCIA';
export type ConferenciaHblOriginal = 'RECEBIDO_E_CONFERIDO' | 'AUSENTE_NA_CONFERENCIA';

/** Fatos do Courier (fonte de verdade do físico, cap. 5 e 22) sobre UM processo. */
export interface CourierDoProcesso {
  fonte: DisponibilidadeFonte;
  /** Rastreio do envelope: nunca resolve nada sozinho (cap. 22, H-2). */
  envelope: FatoOficial<EstadoEnvelope> | null;
  /** Conferência do MBL deste processo; null = ainda não conferido. */
  mbl: FatoOficial<ConferenciaMbl> | null;
  /** Conferência do HBL original recebido pela Rocket (caminho B, H-2); null = não conferido. */
  hblOriginal: FatoOficial<ConferenciaHblOriginal> | null;
}

/**
 * Fato de escopo Master (N-9 §4): registrado uma vez no Master e visto pelos
 * processos vinculados. `acaoEm` é o instante original do fato e nunca é
 * reescrito por um vínculo posterior (N-15).
 */
export type FatoDoMaster =
  | {
    tipo: 'MODALIDADE_IDENTIFICADA'; masterId: string; modalidade: ModalidadeMaster;
    acaoEm: Instante; evidencia: Evidencia;
  }
  | {
    tipo: 'MASTER_FISICO_RECEBIDO'; masterId: string; acaoEm: Instante; ultimaConfirmacaoEm: Instante;
    evidencia: Evidencia; origemProcessoId: string; processosVinculadosNaAcao: ReadonlyArray<string>;
  }
  | {
    tipo: 'MASTER_APRESENTADO'; masterId: string; acaoEm: Instante; evidencia: Evidencia;
    processosVinculadosNaAcao: ReadonlyArray<string>;
  };

/** Conclusão terminal produzida por fase posterior (L5, SISCARGA). A L1a não calcula; só respeita. */
export interface Liberado {
  em: Instante;
  evidencia: Evidencia;
}
