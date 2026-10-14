import { compararInstantes, ms } from './fato';
import { FonteL1b, IndeterminacaoL1b, Integrado, indeterminacao } from './fontes';
import { SituacaoMaster, VinculoTardio, fatosDoMasterVisiveis, situacaoDoMaster } from './master';
import { CourierDoProcesso, Evidencia, FatoDoMaster, Instante, ModalidadeMaster, VinculoProcessoMaster } from './tipos';

/**
 * L1b — resolução completa do Master (cap. 7, 21–25; N-9, N-15, N-18; D-6, D-9; P3, P4).
 *
 * O físico continua sendo a L1a congelada (`situacaoDoMaster`, reutilizada sem
 * mudança): conferência do MBL do próprio processo ou fato físico do Master
 * pelo vínculo. A L1b acrescenta, só quando as fontes existem:
 *  - Wave confirmado por e-mail válido do agente (fato do Master);
 *  - emissão no destino: anúncio (modalidade identificada) → consulta da
 *    Rocket ao armador → autorização da origem confirmada pelo armador;
 *  - MASTER_NAO_LOCALIZADO, só com Courier, Wave e emissão no destino
 *    integrados e observáveis e nenhuma evidência válida;
 *  - conflito de identidade no S2: nenhum Master é escolhido nem propaga;
 *  - várias modalidades válidas ao longo do tempo (P4): todas preservadas; a
 *    corrente é a de instante factual mais recente; empate exato não é
 *    desempatado por ordem técnica.
 * A modalidade corrente nunca escolhe o procedimento da agência (matriz).
 */

/** Situação do vínculo Processo↔Master no S2, sem colapsar o CONFLITO (P3). */
export type SituacaoVinculoL1b =
  | { tipo: 'SEM_VINCULO' }
  | { tipo: 'VINCULADO'; vinculo: VinculoProcessoMaster }
  | { tipo: 'CONFLITO'; masterIds: ReadonlyArray<string> };

/** Fato de escopo Master que resolve uma modalidade (Wave confirmado, autorização da origem confirmada pelo armador). */
export interface FatoDeModalidadeDoMaster {
  masterId: string;
  acaoEm: Instante;
  ultimaConfirmacaoEm: Instante;
  evidencia: Evidencia;
  processosVinculadosNaAcao: ReadonlyArray<string>;
}

/** Emissão no destino (cap. 24): consulta da Rocket ao armador e autorizações confirmadas pelo armador. */
export interface EmissaoNoDestino {
  consultasAoArmador: ReadonlyArray<{ masterId: string; em: Instante; evidencia: Evidencia }>;
  autorizacoes: ReadonlyArray<FatoDeModalidadeDoMaster>;
}

export interface EntradaDoMaster {
  vinculo: SituacaoVinculoL1b;
  /** Fatos de Master no vocabulário congelado da L1a (modalidade identificada, físico, apresentação legada). */
  fatosDoMasterL1a: ReadonlyArray<FatoDoMaster>;
  courier: CourierDoProcesso;
  wave: Integrado<ReadonlyArray<FatoDeModalidadeDoMaster>>;
  emissaoDestino: Integrado<EmissaoNoDestino>;
}

export interface ResolucaoValida {
  modalidade: ModalidadeMaster;
  em: Instante;
  ultimaConfirmacaoEm: Instante;
  evidencia: Evidencia;
  via: 'CONFERENCIA_DO_PROPRIO_PROCESSO' | 'MASTER_VINCULADO' | 'FATO_DO_MASTER';
  vinculoTardio: VinculoTardio | null;
}

export type ModalidadeAtual =
  | { tipo: 'UNICA'; modalidade: ModalidadeMaster; em: Instante }
  /** Duas ou mais modalidades válidas no MESMO instante factual: nenhuma é escolhida (P4). */
  | { tipo: 'AMBIGUA'; modalidades: ModalidadeMaster[]; em: Instante };

export type CondicaoMaster =
  | 'MASTER_NAO_LOCALIZADO'
  | 'CONFLITO_DE_IDENTIDADE_DO_MASTER'
  | 'MASTER_FISICO_EM_TRANSITO'
  | 'CONFERENCIA_DO_MBL_PENDENTE'
  | 'MBL_AUSENTE_NA_CONFERENCIA'
  | 'WAVE_AGUARDANDO_CONFIRMACAO'
  | 'EMISSAO_DESTINO_SEM_CONSULTA_AO_ARMADOR'
  | 'EMISSAO_DESTINO_AGUARDANDO_AUTORIZACAO';

export type FrenteMaster =
  | { estado: 'RESOLVIDO' }
  | { estado: 'NAO_RESOLVIDO'; condicao: CondicaoMaster }
  | { estado: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

export interface SituacaoMasterL1b {
  /** Visão congelada da L1a (físico/Courier), reutilizada sem mudança. */
  l1a: SituacaoMaster;
  masterId: string | null;
  modalidadeIdentificada: ModalidadeMaster | null;
  /** Todas as resoluções válidas, em ordem factual (histórico preservado, P4). */
  resolucoes: ResolucaoValida[];
  modalidadeAtual: ModalidadeAtual | null;
  frente: FrenteMaster;
  /** Conflito de identidade (S2): os Masters candidatos, nenhum escolhido. */
  conflito: ReadonlyArray<string> | null;
}

const ORDEM_EXIBICAO: ModalidadeMaster[] = ['FISICO', 'WAVE', 'EMISSAO_DESTINO'];

/** Vínculo tardio (N-15, D-7): mesmo mecanismo da L1a; mensagem só para a apresentação. */
export function vinculoTardioDe(
  acaoEm: Instante, vinculo: VinculoProcessoMaster, processosVinculadosNaAcao: ReadonlyArray<string>, mensagem: string | null,
): VinculoTardio | null {
  if (ms(acaoEm) >= ms(vinculo.vinculadoEm)) return null;
  return {
    acaoEm, vinculadoEm: vinculo.vinculadoEm, evidenciaDoVinculo: vinculo.evidencia,
    processosVinculadosNaAcao: [...processosVinculadosNaAcao], mensagem,
  };
}

function modalidadeAtualDe(resolucoes: ResolucaoValida[]): ModalidadeAtual | null {
  if (!resolucoes.length) return null;
  const ultima = resolucoes.reduce((a, b) => (compararInstantes(b.em, a.em) > 0 ? b : a));
  const noMesmoInstante = [...new Set(resolucoes.filter((r) => compararInstantes(r.em, ultima.em) === 0).map((r) => r.modalidade))];
  if (noMesmoInstante.length === 1) return { tipo: 'UNICA', modalidade: noMesmoInstante[0], em: ultima.em };
  // Exibição estável apenas; nenhuma das modalidades é escolhida.
  return { tipo: 'AMBIGUA', modalidades: ORDEM_EXIBICAO.filter((m) => noMesmoInstante.includes(m)), em: ultima.em };
}

/** Estado de uma fonte de e-mail de modalidade (Wave / emissão no destino) para o Master deste processo. */
function leituraEmail<T>(fonte: Integrado<T>, temFatos: boolean): 'OBSERVAVEL' | 'NAO_INTEGRADA' | 'INDISPONIVEL' {
  if (fonte.tipo === 'NAO_INTEGRADA') return 'NAO_INTEGRADA';
  if (fonte.fonte.disponivel || temFatos) return 'OBSERVAVEL';
  return 'INDISPONIVEL';
}

export function situacaoDoMasterL1b(e: EntradaDoMaster): SituacaoMasterL1b {
  const vinculo = e.vinculo.tipo === 'VINCULADO' ? e.vinculo.vinculo : null;
  const visiveis = fatosDoMasterVisiveis(vinculo, e.fatosDoMasterL1a);
  const l1a = situacaoDoMaster(vinculo, visiveis, e.courier);
  const masterId = vinculo?.masterId ?? null;

  const resolucoes: ResolucaoValida[] = [];
  if (l1a.resolucao.tipo === 'RESOLVIDO') {
    const r = l1a.resolucao;
    resolucoes.push({
      modalidade: 'FISICO', em: r.resolvidoEm, ultimaConfirmacaoEm: r.ultimaConfirmacaoEm, evidencia: r.evidencia, via: r.via,
      vinculoTardio: r.vinculoTardio,
    });
  }
  const doMaster = <T extends { masterId: string }>(lista: ReadonlyArray<T>): T[] => (masterId ? lista.filter((f) => f.masterId === masterId) : []);
  const waveFatos = e.wave.tipo === 'INTEGRADA' ? doMaster(e.wave.valor) : [];
  const destino = e.emissaoDestino.tipo === 'INTEGRADA' ? e.emissaoDestino.valor : { consultasAoArmador: [], autorizacoes: [] };
  const autorizacoes = doMaster(destino.autorizacoes);
  const consultas = doMaster(destino.consultasAoArmador);
  if (vinculo) {
    for (const [modalidade, fatos] of [['WAVE', waveFatos], ['EMISSAO_DESTINO', autorizacoes]] as const) {
      for (const f of fatos) {
        resolucoes.push({
          modalidade, em: f.acaoEm, ultimaConfirmacaoEm: f.ultimaConfirmacaoEm, evidencia: f.evidencia, via: 'FATO_DO_MASTER',
          vinculoTardio: vinculoTardioDe(f.acaoEm, vinculo, f.processosVinculadosNaAcao, null),
        });
      }
    }
  }
  resolucoes.sort((a, b) => compararInstantes(a.em, b.em));
  const base = { l1a, masterId, modalidadeIdentificada: l1a.modalidadeIdentificada, resolucoes };

  // P3: conflito de identidade — nenhum Master é escolhido; nada de candidato se propaga.
  if (e.vinculo.tipo === 'CONFLITO') {
    return { ...base, modalidadeAtual: modalidadeAtualDe(resolucoes), frente: { estado: 'NAO_RESOLVIDO', condicao: 'CONFLITO_DE_IDENTIDADE_DO_MASTER' }, conflito: e.vinculo.masterIds };
  }
  if (resolucoes.length) return { ...base, modalidadeAtual: modalidadeAtualDe(resolucoes), frente: { estado: 'RESOLVIDO' }, conflito: null };

  const naoResolvido = (condicao: CondicaoMaster): SituacaoMasterL1b => ({ ...base, modalidadeAtual: null, frente: { estado: 'NAO_RESOLVIDO', condicao }, conflito: null });
  const naoDeterminavel = (ind: IndeterminacaoL1b): SituacaoMasterL1b => ({ ...base, modalidadeAtual: null, frente: { estado: 'NAO_DETERMINAVEL', ind }, conflito: null });

  const modalidade = l1a.modalidadeIdentificada;
  const { envelope, mbl } = e.courier;
  const courierFora = !e.courier.fonte.disponivel;
  const observouCourier = !!(envelope || mbl);
  const wave = leituraEmail(e.wave, waveFatos.length > 0);
  const dest = leituraEmail(e.emissaoDestino, autorizacoes.length > 0 || consultas.length > 0);

  /** O físico: só conhecimento positivo do Courier (L1a: indisponibilidade vem antes e não vira "não recebido"). */
  const fisicoConhecido = (): CondicaoMaster | null => {
    if (mbl?.valor === 'AUSENTE_NA_CONFERENCIA') return 'MBL_AUSENTE_NA_CONFERENCIA';
    if (envelope?.valor === 'EM_TRANSITO') return 'MASTER_FISICO_EM_TRANSITO';
    if (envelope?.valor === 'ENTREGUE') return 'CONFERENCIA_DO_MBL_PENDENTE';
    return null;
  };
  const faltaDaFonte = (estado: 'OBSERVAVEL' | 'NAO_INTEGRADA' | 'INDISPONIVEL', chave: FonteL1b) => ({
    sem: estado === 'NAO_INTEGRADA' ? [chave] : [], fora: estado === 'INDISPONIVEL' ? [chave] : [],
  });

  switch (modalidade) {
    case 'FISICO': {
      if (courierFora) return naoDeterminavel(indeterminacao([], ['COURIER']));
      const c = fisicoConhecido();
      // Sem nenhuma observação do Courier: falta observação, não há fato negativo (L1a, congelado).
      return c ? naoResolvido(c) : naoDeterminavel(indeterminacao([], [], ['COURIER']));
    }
    case 'WAVE': {
      if (wave !== 'OBSERVAVEL') {
        const f = faltaDaFonte(wave, 'EMAIL_WAVE');
        return naoDeterminavel(indeterminacao(f.sem, [...f.fora, ...(courierFora ? ['COURIER' as const] : [])]));
      }
      return naoResolvido('WAVE_AGUARDANDO_CONFIRMACAO');
    }
    case 'EMISSAO_DESTINO': {
      if (dest !== 'OBSERVAVEL') {
        const f = faltaDaFonte(dest, 'EMAIL_EMISSAO_DESTINO');
        return naoDeterminavel(indeterminacao(f.sem, [...f.fora, ...(courierFora ? ['COURIER' as const] : [])]));
      }
      return naoResolvido(consultas.length ? 'EMISSAO_DESTINO_AGUARDANDO_AUTORIZACAO' : 'EMISSAO_DESTINO_SEM_CONSULTA_AO_ARMADOR');
    }
    default: {
      // Sem modalidade identificada: "não localizado" só com as três fontes integradas e observáveis (D-6).
      const w = faltaDaFonte(wave, 'EMAIL_WAVE');
      const d = faltaDaFonte(dest, 'EMAIL_EMISSAO_DESTINO');
      const sem = [...w.sem, ...d.sem];
      const fora: FonteL1b[] = [...(courierFora ? ['COURIER' as const] : []), ...w.fora, ...d.fora];
      if (sem.length || fora.length) {
        return naoDeterminavel(indeterminacao(sem, fora, !courierFora && !observouCourier ? ['COURIER'] : []));
      }
      const c = fisicoConhecido();
      return naoResolvido(c ?? 'MASTER_NAO_LOCALIZADO');
    }
  }
}
