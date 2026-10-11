import { ms } from './fato';
import {
  CourierDoProcesso, DisponibilidadeFonte, Evidencia, FatoDoMaster, FatoOficial, Instante, ModalidadeMaster, VinculoProcessoMaster,
  EstadoEnvelope, ConferenciaMbl,
} from './tipos';

/**
 * Master na Vertical 1 (cap. 21, 22; H-2; N-9; N-15; D-7; D-9).
 *  - O Master físico resolve-se pela conferência do MBL do próprio processo no
 *    Courier. Envelope ou rastreio, sozinhos, não resolvem nada.
 *  - É fato de escopo Master: chega aos outros processos só pelo vínculo
 *    documental Processo↔Master (S2), que a L1a consome e nunca infere.
 *  - Modalidade identificada ≠ Master resolvido.
 *  - Vínculo tardio herda o fato vigente do Master com o instante original da
 *    ação, a data do vínculo e a evidência que o causou; não cria culpa nem
 *    override retroativos.
 *  - Wave e emissão no destino não existem na L1a; por isso a L1a nunca afirma
 *    "Master não localizado".
 */

/** Fato de escopo Master como um processo vinculado o vê. */
export interface FatoDoMasterHerdado {
  fato: FatoDoMaster;
  vinculo: VinculoProcessoMaster;
  /** Presente quando o fato do Master é anterior ao vínculo deste processo (N-15). */
  vinculoTardio: VinculoTardio | null;
}

export interface VinculoTardio {
  acaoEm: Instante;
  vinculadoEm: Instante;
  evidenciaDoVinculo: Evidencia;
  processosVinculadosNaAcao: ReadonlyArray<string>;
  /** Só para a apresentação (D-7); para os outros fatos de Master vale o mesmo mecanismo, sem mensagem. */
  mensagem: string | null;
}

export const MENSAGEM_APRESENTADO_ANTES_DO_VINCULO = 'Master apresentado antes deste processo ser vinculado.';

const snapshot = (vinculos: ReadonlyArray<VinculoProcessoMaster>, masterId: string, em: Instante): string[] =>
  vinculos.filter((v) => v.masterId === masterId && ms(v.vinculadoEm) <= ms(em)).map((v) => v.processoId).sort();

/**
 * Fato MASTER_FISICO_RECEBIDO de um Master, derivado das conferências de MBL
 * dos processos vinculados a ele. O MBL chega uma vez: vale a primeira
 * conferência RECEBIDO vigente. Sem conferência RECEBIDO vigente → null.
 */
export function fatoFisicoDoMaster(
  masterId: string,
  vinculos: ReadonlyArray<VinculoProcessoMaster>,
  courierPorProcesso: ReadonlyMap<string, CourierDoProcesso>,
): FatoDoMaster | null {
  const recebidos = vinculos
    .filter((v) => v.masterId === masterId)
    .map((v) => ({ processoId: v.processoId, mbl: courierPorProcesso.get(v.processoId)?.mbl ?? null }))
    .filter((r): r is { processoId: string; mbl: FatoOficial<ConferenciaMbl> } => r.mbl?.valor === 'RECEBIDO')
    .sort((a, b) => ms(a.mbl.vigenteDesde) - ms(b.mbl.vigenteDesde) || a.processoId.localeCompare(b.processoId));
  const primeiro = recebidos[0];
  if (!primeiro) return null;
  return {
    tipo: 'MASTER_FISICO_RECEBIDO',
    masterId,
    acaoEm: primeiro.mbl.vigenteDesde,
    ultimaConfirmacaoEm: primeiro.mbl.ultimaConfirmacaoEm,
    evidencia: primeiro.mbl.evidencia,
    origemProcessoId: primeiro.processoId,
    processosVinculadosNaAcao: snapshot(vinculos, masterId, primeiro.mbl.vigenteDesde),
  };
}

/** Fatos do Master que este processo vê: só pelo vínculo, só do seu Master. */
export function fatosDoMasterVisiveis(
  vinculo: VinculoProcessoMaster | null, fatosDoMaster: ReadonlyArray<FatoDoMaster>,
): FatoDoMasterHerdado[] {
  if (!vinculo) return [];
  return fatosDoMaster
    .filter((f) => f.masterId === vinculo.masterId)
    .map((fato) => {
      const tardio = ms(fato.acaoEm) < ms(vinculo.vinculadoEm);
      return {
        fato,
        vinculo,
        vinculoTardio: tardio
          ? {
            acaoEm: fato.acaoEm,
            vinculadoEm: vinculo.vinculadoEm,
            evidenciaDoVinculo: vinculo.evidencia,
            processosVinculadosNaAcao: fato.tipo === 'MODALIDADE_IDENTIFICADA' ? [] : fato.processosVinculadosNaAcao,
            mensagem: fato.tipo === 'MASTER_APRESENTADO' ? MENSAGEM_APRESENTADO_ANTES_DO_VINCULO : null,
          }
          : null,
      };
    });
}

/**
 * Processos atingidos por um fato (ou mudança) de escopo Master: os
 * vinculados agora. Processo já LIBERADO não é reaberto (N-16, cap. 39).
 */
export function processosAtingidosPeloMaster(
  masterId: string, vinculos: ReadonlyArray<VinculoProcessoMaster>, liberados: ReadonlySet<string>,
): { atingidos: string[]; preservadosPorTerminal: string[] } {
  const vinculados = [...new Set(vinculos.filter((v) => v.masterId === masterId).map((v) => v.processoId))].sort();
  return {
    atingidos: vinculados.filter((p) => !liberados.has(p)),
    preservadosPorTerminal: vinculados.filter((p) => liberados.has(p)),
  };
}

/* ------------------------------ situação ------------------------------ */

export type ResolucaoMaster =
  | {
    tipo: 'RESOLVIDO'; modalidade: 'FISICO'; resolvidoEm: Instante; ultimaConfirmacaoEm: Instante; evidencia: Evidencia;
    via: 'CONFERENCIA_DO_PROPRIO_PROCESSO' | 'MASTER_VINCULADO'; vinculoTardio: VinculoTardio | null;
  }
  /** Há observação do Courier (envelope ou conferência) e nenhuma modalidade válida confirmada (não é "Master não localizado"). */
  | { tipo: 'NAO_RESOLVIDO' }
  /**
   * Courier indisponível, ou sem nenhuma observação do físico deste processo, e
   * sem confirmação anterior: não se conclui "não recebido" (cap. 41).
   */
  | { tipo: 'NAO_CONFIRMAVEL'; fonte: 'COURIER'; motivo: 'FONTE_INDISPONIVEL'; indisponivelDesde: Instante }
  | { tipo: 'NAO_CONFIRMAVEL'; fonte: 'COURIER'; motivo: 'SEM_OBSERVACAO' };

export interface SituacaoMaster {
  masterId: string | null;
  /** Modalidade identificada (fato de escopo Master) — independente de estar resolvido (cap. 21). */
  modalidadeIdentificada: ModalidadeMaster | null;
  resolucao: ResolucaoMaster;
  /** Últimos eventos válidos do físico deste processo, preservados mesmo com a fonte fora. */
  fisicoDoProcesso: { envelope: FatoOficial<EstadoEnvelope> | null; mbl: FatoOficial<ConferenciaMbl> | null };
  fonteCourier: DisponibilidadeFonte;
}

export function situacaoDoMaster(
  vinculo: VinculoProcessoMaster | null, visiveis: ReadonlyArray<FatoDoMasterHerdado>, courier: CourierDoProcesso,
): SituacaoMaster {
  const identificacao = visiveis
    .map((h) => h.fato)
    .filter((f): f is Extract<FatoDoMaster, { tipo: 'MODALIDADE_IDENTIFICADA' }> => f.tipo === 'MODALIDADE_IDENTIFICADA')
    .sort((a, b) => ms(b.acaoEm) - ms(a.acaoEm))[0];
  const base = {
    masterId: vinculo?.masterId ?? null,
    modalidadeIdentificada: identificacao?.modalidade ?? null,
    fisicoDoProcesso: { envelope: courier.envelope, mbl: courier.mbl },
    fonteCourier: courier.fonte,
  };

  if (courier.mbl?.valor === 'RECEBIDO') {
    return {
      ...base,
      resolucao: {
        tipo: 'RESOLVIDO', modalidade: 'FISICO', resolvidoEm: courier.mbl.vigenteDesde, ultimaConfirmacaoEm: courier.mbl.ultimaConfirmacaoEm,
        evidencia: courier.mbl.evidencia, via: 'CONFERENCIA_DO_PROPRIO_PROCESSO', vinculoTardio: null,
      },
    };
  }
  const herdado = visiveis.find((h) => h.fato.tipo === 'MASTER_FISICO_RECEBIDO');
  if (herdado && herdado.fato.tipo === 'MASTER_FISICO_RECEBIDO') {
    return {
      ...base,
      resolucao: {
        tipo: 'RESOLVIDO', modalidade: 'FISICO', resolvidoEm: herdado.fato.acaoEm, ultimaConfirmacaoEm: herdado.fato.ultimaConfirmacaoEm,
        evidencia: herdado.fato.evidencia, via: 'MASTER_VINCULADO', vinculoTardio: herdado.vinculoTardio,
      },
    };
  }
  if (!courier.fonte.disponivel) {
    return { ...base, resolucao: { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'FONTE_INDISPONIVEL', indisponivelDesde: courier.fonte.desde } };
  }
  // Ausência de observação não é fato negativo.
  if (!courier.envelope && !courier.mbl) return { ...base, resolucao: { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' } };
  return { ...base, resolucao: { tipo: 'NAO_RESOLVIDO' } };
}
