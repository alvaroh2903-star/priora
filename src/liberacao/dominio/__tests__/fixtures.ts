import {
  CourierDoProcesso, DisponibilidadeFonte, EntradaAvaliacao, Evidencia, FatoDoMaster, FatoOficial, Instante, ModalidadeMaster,
  VinculoProcessoMaster,
} from '../index';

/** Fixtures em memória para os testes do domínio puro (nenhum banco, nenhuma fonte real). */

export const T = (hora: number): Instante => new Date(Date.UTC(2026, 9, 1, hora)).toISOString();

export const ev = (ref: string, fonte = 'courier'): Evidencia => ({ fonte, ref });

export const fato = <V>(valor: V, em: Instante, confirmadoEm: Instante = em, ref = `${String(valor)}@${em}`): FatoOficial<V> => ({
  valor, vigenteDesde: em, ultimaConfirmacaoEm: confirmadoEm, evidencia: ev(ref),
});

export const DISPONIVEL: DisponibilidadeFonte = { disponivel: true, desde: T(0) };
export const INDISPONIVEL = (desde: Instante): DisponibilidadeFonte => ({ disponivel: false, desde });

export const courier = (p: Partial<CourierDoProcesso> = {}): CourierDoProcesso => ({
  fonte: DISPONIVEL, envelope: null, mbl: null, hblOriginal: null, ...p,
});

export const vinculo = (processoId: string, masterId: string, em: Instante): VinculoProcessoMaster => ({
  processoId, masterId, vinculadoEm: em, evidencia: ev(`pre-alerta-${processoId}`, 'auditoria'),
});

export const modalidade = (masterId: string, m: ModalidadeMaster, em: Instante): FatoDoMaster => ({
  tipo: 'MODALIDADE_IDENTIFICADA', masterId, modalidade: m, acaoEm: em, evidencia: ev(`modalidade-${masterId}`, 'auditoria'),
});

export const apresentado = (masterId: string, em: Instante, vinculadosNaAcao: string[]): FatoDoMaster => ({
  tipo: 'MASTER_APRESENTADO', masterId, acaoEm: em, evidencia: ev(`protocolo-${masterId}`, 'agencia'),
  processosVinculadosNaAcao: vinculadosNaAcao,
});

export const entrada = (p: Partial<EntradaAvaliacao> & { processoId: string }): EntradaAvaliacao => ({
  vinculo: null, fatosDoMaster: [], courier: courier(), liberado: null, ...p,
});
