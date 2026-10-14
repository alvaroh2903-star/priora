import { AvaliacaoProcesso, EntradaAvaliacao, Indeterminacao, Marco, MarcoConfirmado, SaidaBloqueador, SaidaEtapa, SaidaProximaAcao } from './avaliacao';
import { DecisaoDoProcesso, decidirProcesso, entradaSemIntegracoes, EntradaDecisao } from './decisao';
import { FonteL1b } from './fontes';
import { ResultadoDimensao } from './house';
import { FonteNaoIntegrada } from './tipos';

/**
 * L1b — fachada de compatibilidade com a L1a congelada. Projeta a decisão
 * fina da L1b no contrato grosso da L1a (`AvaliacaoProcesso`), sem chamar
 * `avaliarProcesso`: a composição sai das frentes da L1b (situação do Master,
 * House, Termo, Financeiro e marcos). Propriedade provada nos testes: com
 * toda fonte posterior à L1a NAO_INTEGRADA, a projeção é igual ao resultado
 * congelado da L1a para a mesma entrada.
 */

/** "Agora" neutro: com todas as fontes posteriores não integradas, nenhuma regra temporal tem o que ler. */
export const AGORA_NEUTRO = '1970-01-01T00:00:00.000Z';

/** Correspondência fina → grossa das fontes (as que a L1a não conhecia somem). */
const GROSSA: Partial<Record<FonteL1b, FonteNaoIntegrada>> = {
  EMAIL_WAVE: 'EMAIL_WAVE',
  EMAIL_EMISSAO_DESTINO: 'EMAIL_EMISSAO_DESTINO',
  PORTAL_FOTO_HBL: 'PORTAL_FOTO_HBL',
  EMAIL_TELEX: 'EMAIL_TELEX',
  HEADCARGO_TERMO_UNICO: 'HEADCARGO',
  PORTAL_TERMO_EMBARQUE: 'HEADCARGO',
  HEADCARGO_FINANCEIRO_CLIENTE: 'HEADCARGO',
  HEADCARGO_PAGAMENTO_ARMADOR: 'HEADCARGO',
  ARMADOR: 'PROCEDIMENTO_AGENCIA',
  PROCEDIMENTO_AGENCIA: 'PROCEDIMENTO_AGENCIA',
  AUDITORIA_CE_HOUSE: 'SISCARGA',
  SISCARGA_FRETE: 'SISCARGA',
  SISCARGA_FISCAL: 'SISCARGA',
};

const grossas = (fontes: ReadonlyArray<FonteL1b>): FonteNaoIntegrada[] =>
  fontes.map((f) => GROSSA[f]).filter((f): f is FonteNaoIntegrada => !!f);
const soCourier = (fontes: ReadonlyArray<FonteL1b>): Array<'COURIER'> => (fontes.includes('COURIER') ? ['COURIER'] : []);
const ind1a = (sem: FonteNaoIntegrada[], fora: Array<'COURIER'> = [], semObs: Array<'COURIER'> = []): Indeterminacao => ({
  tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: [...new Set(sem)], fontesIndisponiveis: [...new Set(fora)], semObservacao: [...new Set(semObs)],
});
const indDa = (r: ResultadoDimensao) => (r.estado === 'NAO_DETERMINAVEL' || r.estado === 'DESCONHECIDO' ? r.ind : null);

const MARCOS_L1A: ReadonlyArray<Marco> = ['MASTER_RESOLVIDO', 'HOUSE_RESOLVIDO', 'MASTER_APRESENTADO', 'LIBERADO'];

/** Entrada da L1b equivalente a uma entrada da L1a: tudo o que veio depois da L1a fica NAO_INTEGRADA. */
export function entradaL1bDaL1a(e: EntradaAvaliacao): EntradaDecisao {
  return {
    ...entradaSemIntegracoes(e.processoId, AGORA_NEUTRO, e.courier),
    vinculo: e.vinculo ? { tipo: 'VINCULADO', vinculo: e.vinculo } : { tipo: 'SEM_VINCULO' },
    fatosDoMasterL1a: e.fatosDoMaster,
    liberado: e.liberado,
  };
}

export function projetarNaL1a(d: DecisaoDoProcesso): AvaliacaoProcesso {
  // Os marcos da L1a sempre têm evidência; uma apresentação só com data é projetada com a data (nenhuma hora inventada).
  const progresso: MarcoConfirmado[] = d.progresso
    .filter((m): m is typeof m & { marco: Marco; evidencia: NonNullable<typeof m.evidencia> } =>
      (MARCOS_L1A as ReadonlyArray<string>).includes(m.marco) && m.evidencia !== null)
    .map((m) => ({
      marco: m.marco, escopo: m.escopo, em: m.em ?? (m.momento.precisao === 'DATA' ? m.momento.data : m.momento.instante), evidencia: m.evidencia,
      vinculoTardio: m.vinculoTardio,
    }));
  const avaliacao = (etapa: SaidaEtapa, bloqueador: SaidaBloqueador, proximaAcao: SaidaProximaAcao): AvaliacaoProcesso => ({
    processoId: d.processoId, master: d.master.l1a, house: d.house.l1a, progresso, etapa, bloqueador, proximaAcao,
  });
  if (d.liberado) return avaliacao({ tipo: 'DETERMINADA', etapa: 'LIBERADO' }, { tipo: 'NENHUM' }, { tipo: 'NENHUMA' });

  const { TERMO, FINANCEIRO, HOUSE } = d.cliente.dimensoes;
  const indHouse = indDa(HOUSE);
  const ladoCliente: FonteNaoIntegrada[] = [
    ...grossas([...(indDa(TERMO)?.semFonteIntegrada ?? []), ...(indDa(FINANCEIRO)?.semFonteIntegrada ?? [])]),
    ...(HOUSE.estado === 'RESOLVIDO' ? [] : grossas(indHouse?.semFonteIntegrada ?? [])),
  ];
  const courierFora = HOUSE.estado === 'RESOLVIDO' ? [] : soCourier(indHouse?.fontesIndisponiveis ?? []);
  const acoes = ind1a([...ladoCliente, 'PROCEDIMENTO_AGENCIA'], courierFora);

  if (progresso.some((m) => m.marco === 'MASTER_APRESENTADO')) {
    const posApresentacao = ind1a(['SISCARGA']);
    return avaliacao(posApresentacao, posApresentacao, posApresentacao);
  }

  const frente = d.master.frente;
  if (frente.estado === 'RESOLVIDO') {
    return avaliacao(ind1a([...ladoCliente, 'PROCEDIMENTO_AGENCIA', 'SISCARGA'], courierFora), ind1a(ladoCliente, courierFora), acoes);
  }
  if (frente.estado === 'NAO_DETERMINAVEL') {
    const fm = grossas(frente.ind.semFonteIntegrada);
    const fora = soCourier(frente.ind.fontesIndisponiveis);
    const semObs = soCourier(frente.ind.semObservacao);
    if (fora.length || semObs.length) {
      // Master não confirmável pelo Courier (fora, ou sem nenhuma observação).
      const situacao = ind1a(fm, fora, semObs);
      return avaliacao(situacao, situacao, ind1a([...fm, ...acoes.semFonteIntegrada], [...fora, ...courierFora], semObs));
    }
    return avaliacao(ind1a(fm), ind1a(fm), ind1a([...fm, ...acoes.semFonteIntegrada], courierFora));
  }
  switch (frente.condicao) {
    case 'MASTER_FISICO_EM_TRANSITO':
    case 'MBL_AUSENTE_NA_CONFERENCIA':
      return avaliacao(
        { tipo: 'DETERMINADA', etapa: 'PREPARACAO_PARA_LIBERACAO' },
        { tipo: 'CONHECIDO', motivo: 'MASTER_FISICO_NAO_RECEBIDO', escopo: 'MASTER', masterId: d.masterId },
        acoes,
      );
    case 'CONFERENCIA_DO_MBL_PENDENTE': {
      // A L1a não tinha a ação de conferir: na sua linguagem falta a observação do Courier.
      const semConferencia = ind1a([], [], ['COURIER']);
      return avaliacao(semConferencia, semConferencia, ind1a(acoes.semFonteIntegrada, courierFora, ['COURIER']));
    }
    default: {
      // Condições que só existem com fontes posteriores à L1a: na linguagem da L1a, faltam as fontes de modalidade.
      const fm: FonteNaoIntegrada[] = ['EMAIL_WAVE', 'EMAIL_EMISSAO_DESTINO'];
      return avaliacao(ind1a(fm), ind1a(fm), ind1a([...fm, ...acoes.semFonteIntegrada], courierFora));
    }
  }
}

/** A L1a recalculada pela L1b (L1b → fachada), para a prova de compatibilidade. */
export const avaliarPelaL1b = (e: EntradaAvaliacao): AvaliacaoProcesso => projetarNaL1a(decidirProcesso(entradaL1bDaL1a(e)));
