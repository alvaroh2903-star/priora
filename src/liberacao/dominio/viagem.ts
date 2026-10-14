import { EstadoOficial, IndeterminacaoL1b, Integrado, indeterminacao } from './fontes';
import { MarcoTemporal, OrigemDoFuso, ReferenciaDoPorto, atingido, dataLocal, limiarAntes, lerMarco } from './tempo';
import { Evidencia, FatoOficial, Instante } from './tipos';

/**
 * L1b — viagem (H-8, N-5, N-10, N-11, D-2, D-3; P8). Consome os fatos do
 * VesselCall/tracking compartilhado (S3); não cria modelo próprio de ETA.
 *  - ATA conhecida = chegada ocorrida; sem ATA, ETA (H-8, N-11). A atracação
 *    real NÃO substitui a ATA na ordenação: ela só tem os papéis aprovados
 *    (gate da Evergreen e cobrança da P8).
 *  - ETA oficial vigente (N-16) decide; indisponibilidade da fonte não a apaga (D-3).
 *  - T-10 é o único limiar desta frente: ETA exata − 10×24h; só data D →
 *    00:00 de D−10 no fuso aplicável (N-19 + fallback); sem fuso seguro, nenhum limiar.
 *  - Contêineres do mesmo processo em viagens finais diferentes (N-10): nenhuma
 *    ETA é escolhida; a condição é Classe A.
 */

export interface ViagemFinalDoConteiner {
  conteiner: string;
  viagemFinal: string;
  evidencia: Evidencia;
}

export interface Viagem {
  /** Referência do porto final (fuso confiável cadastrado, porto brasileiro com segurança). */
  porto: ReferenciaDoPorto;
  eta: EstadoOficial<MarcoTemporal>;
  ata: FatoOficial<MarcoTemporal> | null;
  /** Atracação prevista no porto final: base do T-48h (cap. 10). */
  atracacaoPrevista: FatoOficial<MarcoTemporal> | null;
  /** Atracação REAL confirmada (gate da Evergreen e da cobrança, H-8, P8). ATA não substitui. */
  atracacao: FatoOficial<MarcoTemporal> | null;
  viagensFinais: ReadonlyArray<ViagemFinalDoConteiner>;
}

export type GrupoTemporal = 'CHEGADA_OCORRIDA' | 'ETA_CONHECIDA' | 'REFERENCIA_TEMPORAL_INDISPONIVEL';

/**
 * ETA para ordenação: instante exato com o seu dia de calendário factual, ou
 * só a data (sem 00:00 fictício). O dia nunca é trocado por conversão de fuso:
 * é o dia local num fuso confiável (fonte ou porto) ou, sem ele, o dia escrito
 * pela própria fonte.
 */
export type ChaveEta = { tipo: 'INSTANTE'; t: number; data: string } | { tipo: 'DATA'; data: string };

export type EstadoT10 =
  | { estado: 'ANTES' | 'ATINGIDO'; limiar: Instante; precisao: 'DATA' | 'DATA_HORA'; origemDoFuso: OrigemDoFuso }
  | { estado: 'CHEGADA_OCORRIDA' }
  | {
    estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL';
    motivo: 'ETA_DESCONHECIDA' | 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA' | 'DIVERGENCIA_DE_VIAGEM';
  };

export type Atracacao =
  | { estado: 'CONFIRMADA'; fato: FatoOficial<MarcoTemporal> }
  | { estado: 'NAO_CONFIRMADA' }
  | { estado: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

export interface SituacaoViagem {
  grupo: GrupoTemporal;
  chaveEta: ChaveEta | null;
  eta: FatoOficial<MarcoTemporal> | null;
  ata: FatoOficial<MarcoTemporal> | null;
  atracacaoPrevista: FatoOficial<MarcoTemporal> | null;
  porto: ReferenciaDoPorto | null;
  t10: EstadoT10;
  atracacao: Atracacao;
  /** N-10: viagens finais incompatíveis entre contêineres do mesmo processo. */
  divergenciaDeViagem: null | { viagens: string[]; conteineres: string[] };
  /** Fonte não integrada ou fora (com o que se preservou dela). */
  ind: IndeterminacaoL1b | null;
}

export const MENSAGEM_DIVERGENCIA_DE_VIAGEM = 'Divergência de viagem detectada — verificar possível rolagem e necessidade de abertura de novo processo.';

/**
 * Chave de ordenação da ETA. Hora sem confiança já degrada para DATA em
 * `lerMarco`. Para um instante, o dia é o local num fuso CONFIÁVEL (da fonte
 * ou do porto — o fallback operacional do N-19 só serve ao T-48h/T-10, não
 * dá dia factual); sem fuso confiável, é o dia que a fonte escreveu, sem
 * converter para UTC.
 */
export function chaveDaEta(eta: MarcoTemporal, porto: ReferenciaDoPorto): ChaveEta {
  const l = lerMarco(eta, porto);
  if (l.tipo === 'DATA') return { tipo: 'DATA', data: l.data };
  const fuso = eta.fusoDaFonte ?? porto.fusoConfiavel;
  return { tipo: 'INSTANTE', t: l.t, data: fuso ? dataLocal(l.t, fuso) : eta.valor.slice(0, 10) };
}

export function situacaoDaViagem(entrada: Integrado<Viagem>, agora: Instante): SituacaoViagem {
  if (entrada.tipo === 'NAO_INTEGRADA') {
    const ind = indeterminacao(['VIAGEM']);
    return {
      grupo: 'REFERENCIA_TEMPORAL_INDISPONIVEL', chaveEta: null, eta: null, ata: null, atracacaoPrevista: null, porto: null,
      t10: { estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL', motivo: 'ETA_DESCONHECIDA' },
      atracacao: { estado: 'NAO_DETERMINAVEL', ind }, divergenciaDeViagem: null, ind,
    };
  }
  const v = entrada.valor;
  const fora = !entrada.fonte.disponivel;
  const ind = fora ? indeterminacao([], ['VIAGEM']) : null;
  const viagens = [...new Set(v.viagensFinais.map((c) => c.viagemFinal))].sort();
  const base = { eta: v.eta.oficial, ata: v.ata, atracacaoPrevista: v.atracacaoPrevista, porto: v.porto, ind };
  const atracacao: Atracacao = v.atracacao
    ? { estado: 'CONFIRMADA', fato: v.atracacao }
    : fora ? { estado: 'NAO_DETERMINAVEL', ind: indeterminacao([], ['VIAGEM']) } : { estado: 'NAO_CONFIRMADA' };

  if (viagens.length > 1) {
    // N-10: a Priora não escolhe uma ETA.
    return {
      ...base, grupo: 'REFERENCIA_TEMPORAL_INDISPONIVEL', chaveEta: null,
      t10: { estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL', motivo: 'DIVERGENCIA_DE_VIAGEM' },
      atracacao: { estado: 'NAO_DETERMINAVEL', ind: indeterminacao([], [], ['VIAGEM']) },
      divergenciaDeViagem: { viagens, conteineres: [...new Set(v.viagensFinais.map((c) => c.conteiner))].sort() },
    };
  }
  if (v.ata) {
    return { ...base, grupo: 'CHEGADA_OCORRIDA', chaveEta: null, t10: { estado: 'CHEGADA_OCORRIDA' }, atracacao, divergenciaDeViagem: null };
  }
  const eta = v.eta.oficial;
  if (!eta) {
    return {
      ...base, grupo: 'REFERENCIA_TEMPORAL_INDISPONIVEL', chaveEta: null,
      t10: { estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL', motivo: 'ETA_DESCONHECIDA' }, atracacao, divergenciaDeViagem: null,
    };
  }
  const limiar = limiarAntes(eta.valor, v.porto, 10);
  const t10: EstadoT10 = limiar.tipo === 'MATERIALIZADO'
    ? {
      estado: atingido(limiar, agora) ? 'ATINGIDO' : 'ANTES', limiar: limiar.instante, precisao: limiar.precisao,
      origemDoFuso: limiar.origemDoFuso,
    }
    : { estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL', motivo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA' };
  return { ...base, grupo: 'ETA_CONHECIDA', chaveEta: chaveDaEta(eta.valor, v.porto), t10, atracacao, divergenciaDeViagem: null };
}
