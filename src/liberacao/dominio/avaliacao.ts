import { FatoDoMasterHerdado, SituacaoMaster, VinculoTardio, fatosDoMasterVisiveis, situacaoDoMaster } from './master';
import {
  CourierDoProcesso, DisponibilidadeFonte, Evidencia, FatoDoMaster, FonteNaoIntegrada, Instante, Liberado, VinculoProcessoMaster,
} from './tipos';

/**
 * Avaliação de UM processo na Vertical 1 (cap. 4, 7, 14, 33, 41; N-13; D-6).
 * Etapa, bloqueador e próxima ação são saídas independentes. A etapa sai só de
 * marcos confirmados; "fonte não integrada" nunca vale "não ocorreu": o
 * resultado diz que não é determinável e quais fontes faltam. A avaliação lê
 * só os fatos do próprio processo e os fatos de escopo Master do seu Master:
 * a pendência de outro processo vinculado nunca altera esta avaliação.
 */

export interface EntradaAvaliacao {
  processoId: string;
  vinculo: VinculoProcessoMaster | null;
  /** Fatos de escopo Master vigentes; só os do Master vinculado são considerados. */
  fatosDoMaster: ReadonlyArray<FatoDoMaster>;
  courier: CourierDoProcesso;
  /** Terminal, produzido por fase posterior (L5). A L1a não calcula a conclusão. */
  liberado: Liberado | null;
}

export type SituacaoHouse =
  | {
    tipo: 'RESOLVIDO'; caminho: 'B_ORIGINAL_RECEBIDO_PELA_ROCKET'; resolvidoEm: Instante; ultimaConfirmacaoEm: Instante;
    evidencia: Evidencia; fonteCourier: DisponibilidadeFonte;
  }
  | { tipo: 'NAO_DETERMINAVEL'; semFonteIntegrada: FonteNaoIntegrada[]; fontesIndisponiveis: Array<'COURIER'> };

export type Marco = 'MASTER_RESOLVIDO' | 'HOUSE_RESOLVIDO' | 'MASTER_APRESENTADO' | 'LIBERADO';

export interface MarcoConfirmado {
  marco: Marco;
  escopo: 'MASTER' | 'PROCESSO';
  /** Instante original do marco (num fato herdado, o da ação do Master, não o do vínculo). */
  em: Instante;
  evidencia: Evidencia;
  vinculoTardio: VinculoTardio | null;
}

export type EtapaPrincipal =
  | 'PREPARACAO_PARA_LIBERACAO' | 'PREPARACAO_OPERACIONAL' | 'APTO_PARA_PROCEDIMENTO' | 'PROCEDIMENTO_EM_ANDAMENTO'
  | 'APTO_PARA_APRESENTACAO' | 'MASTER_APRESENTADO' | 'ACOMPANHANDO_DESBLOQUEIO' | 'LIBERADO';

/** "Não determinável com as fontes atuais": quais fontes faltam, quais estão fora e quais não observaram nada. */
export interface Indeterminacao {
  tipo: 'NAO_DETERMINAVEL';
  semFonteIntegrada: FonteNaoIntegrada[];
  fontesIndisponiveis: Array<'COURIER'>;
  semObservacao: Array<'COURIER'>;
}

export type SaidaEtapa = { tipo: 'DETERMINADA'; etapa: EtapaPrincipal } | Indeterminacao;
export type SaidaBloqueador =
  | { tipo: 'NENHUM' }
  | { tipo: 'CONHECIDO'; motivo: 'MASTER_FISICO_NAO_RECEBIDO'; escopo: 'MASTER'; masterId: string | null }
  | Indeterminacao;
export type SaidaProximaAcao = { tipo: 'NENHUMA' } | Indeterminacao;

export interface AvaliacaoProcesso {
  processoId: string;
  master: SituacaoMaster;
  house: SituacaoHouse;
  /** Progresso factual conhecido: só marcos confirmados. */
  progresso: MarcoConfirmado[];
  etapa: SaidaEtapa;
  bloqueador: SaidaBloqueador;
  proximaAcao: SaidaProximaAcao;
}

const CAMINHOS_HOUSE_SEM_FONTE: FonteNaoIntegrada[] = ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'];

export function situacaoDaHouse(courier: CourierDoProcesso): SituacaoHouse {
  const hbl = courier.hblOriginal;
  if (hbl?.valor === 'RECEBIDO_E_CONFERIDO') {
    return {
      tipo: 'RESOLVIDO', caminho: 'B_ORIGINAL_RECEBIDO_PELA_ROCKET', resolvidoEm: hbl.vigenteDesde,
      ultimaConfirmacaoEm: hbl.ultimaConfirmacaoEm, evidencia: hbl.evidencia, fonteCourier: courier.fonte,
    };
  }
  // Caminho A (foto + Analista) e Telex não têm fonte na L1a: ausência deles não é "House pendente".
  return {
    tipo: 'NAO_DETERMINAVEL',
    semFonteIntegrada: [...CAMINHOS_HOUSE_SEM_FONTE],
    fontesIndisponiveis: courier.fonte.disponivel ? [] : ['COURIER'],
  };
}

function progressoConfirmado(
  master: SituacaoMaster, house: SituacaoHouse, visiveis: ReadonlyArray<FatoDoMasterHerdado>, liberado: Liberado | null,
): MarcoConfirmado[] {
  const marcos: MarcoConfirmado[] = [];
  if (master.resolucao.tipo === 'RESOLVIDO') {
    marcos.push({
      // Resolução do Master é fato de escopo Master (N-9); a origem fica em `master.resolucao.via`.
      marco: 'MASTER_RESOLVIDO', escopo: 'MASTER',
      em: master.resolucao.resolvidoEm, evidencia: master.resolucao.evidencia, vinculoTardio: master.resolucao.vinculoTardio,
    });
  }
  if (house.tipo === 'RESOLVIDO') {
    marcos.push({ marco: 'HOUSE_RESOLVIDO', escopo: 'PROCESSO', em: house.resolvidoEm, evidencia: house.evidencia, vinculoTardio: null });
  }
  for (const h of visiveis) {
    if (h.fato.tipo === 'MASTER_APRESENTADO') {
      marcos.push({ marco: 'MASTER_APRESENTADO', escopo: 'MASTER', em: h.fato.acaoEm, evidencia: h.fato.evidencia, vinculoTardio: h.vinculoTardio });
    }
  }
  if (liberado) marcos.push({ marco: 'LIBERADO', escopo: 'PROCESSO', em: liberado.em, evidencia: liberado.evidencia, vinculoTardio: null });
  return marcos;
}

const indeterminado = (
  semFonteIntegrada: FonteNaoIntegrada[], fontesIndisponiveis: Array<'COURIER'> = [], semObservacao: Array<'COURIER'> = [],
): Indeterminacao => ({
  tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: [...new Set(semFonteIntegrada)], fontesIndisponiveis: [...new Set(fontesIndisponiveis)],
  semObservacao: [...new Set(semObservacao)],
});

/**
 * Conhecimento operacional POSITIVO de que o MBL deste processo ainda não foi
 * recebido: envelope em trânsito ou conferência que registrou o MBL ausente.
 * Envelope entregue sem conferência não basta; ausência de observação, menos ainda.
 */
const fisicoSabidamenteNaoRecebido = (master: SituacaoMaster): boolean =>
  master.fisicoDoProcesso.envelope?.valor === 'EM_TRANSITO' || master.fisicoDoProcesso.mbl?.valor === 'AUSENTE_NA_CONFERENCIA';

/** Fontes que faltam para decidir o Master quando ele não está resolvido. */
function fontesDaModalidade(master: SituacaoMaster): FonteNaoIntegrada[] {
  switch (master.modalidadeIdentificada) {
    case 'FISICO': return [];
    case 'WAVE': return ['EMAIL_WAVE'];
    case 'EMISSAO_DESTINO': return ['EMAIL_EMISSAO_DESTINO'];
    default: return ['EMAIL_WAVE', 'EMAIL_EMISSAO_DESTINO'];
  }
}

export function avaliarProcesso(entrada: EntradaAvaliacao): AvaliacaoProcesso {
  const visiveis = fatosDoMasterVisiveis(entrada.vinculo, entrada.fatosDoMaster);
  const master = situacaoDoMaster(entrada.vinculo, visiveis, entrada.courier);
  const house = situacaoDaHouse(entrada.courier);
  const progresso = progressoConfirmado(master, house, visiveis, entrada.liberado);
  const avaliacao = (etapa: SaidaEtapa, bloqueador: SaidaBloqueador, proximaAcao: SaidaProximaAcao): AvaliacaoProcesso => ({
    processoId: entrada.processoId, master, house, progresso, etapa, bloqueador, proximaAcao,
  });

  // Terminal (cap. 39): nada reabre; fatos posteriores de Master não mudam a etapa.
  if (entrada.liberado) return avaliacao({ tipo: 'DETERMINADA', etapa: 'LIBERADO' }, { tipo: 'NENHUM' }, { tipo: 'NENHUMA' });

  const ladoCliente: FonteNaoIntegrada[] = ['HEADCARGO', ...(house.tipo === 'RESOLVIDO' ? [] : house.semFonteIntegrada)];
  const courierFora: Array<'COURIER'> = house.tipo === 'NAO_DETERMINAVEL' ? house.fontesIndisponiveis : [];
  const acoes = indeterminado([...ladoCliente, 'PROCEDIMENTO_AGENCIA'], courierFora);

  // Apresentação confirmada (escopo Master): o que vem depois depende do SISCARGA.
  if (progresso.some((m) => m.marco === 'MASTER_APRESENTADO')) {
    const posApresentacao = indeterminado(['SISCARGA']);
    return avaliacao(posApresentacao, posApresentacao, posApresentacao);
  }

  switch (master.resolucao.tipo) {
    case 'RESOLVIDO':
      // Master resolvido: a etapa pode ser Preparação Operacional ou posterior, e os marcos seguintes não têm fonte.
      return avaliacao(
        indeterminado([...ladoCliente, 'PROCEDIMENTO_AGENCIA', 'SISCARGA'], courierFora),
        indeterminado(ladoCliente, courierFora),
        acoes,
      );
    case 'NAO_CONFIRMAVEL': {
      // Sem observação do Courier só pesa quando o Master pode ser físico (modalidade física ou não identificada).
      const podeSerFisico = master.modalidadeIdentificada === null || master.modalidadeIdentificada === 'FISICO';
      const [fora, semObs]: [Array<'COURIER'>, Array<'COURIER'>] = master.resolucao.motivo === 'FONTE_INDISPONIVEL'
        ? [['COURIER'], []] : [[], podeSerFisico ? ['COURIER'] : []];
      const situacao = indeterminado(fontesDaModalidade(master), fora, semObs);
      return avaliacao(situacao, situacao,
        indeterminado([...fontesDaModalidade(master), ...acoes.semFonteIntegrada], [...fora, ...courierFora], semObs));
    }
    case 'NAO_RESOLVIDO':
      if (master.modalidadeIdentificada === 'FISICO' && !fisicoSabidamenteNaoRecebido(master)) {
        // Envelope entregue e MBL ainda não conferido: falta a observação do Courier, não há fato negativo.
        const semConferencia = indeterminado([], [], ['COURIER']);
        return avaliacao(semConferencia, semConferencia, indeterminado(acoes.semFonteIntegrada, courierFora, ['COURIER']));
      }
      if (master.modalidadeIdentificada === 'FISICO') {
        // Modalidade física identificada e o físico sabidamente ainda não recebido: o Master não está resolvido.
        return avaliacao(
          { tipo: 'DETERMINADA', etapa: 'PREPARACAO_PARA_LIBERACAO' },
          { tipo: 'CONHECIDO', motivo: 'MASTER_FISICO_NAO_RECEBIDO', escopo: 'MASTER', masterId: master.masterId },
          acoes,
        );
      }
      // Sem modalidade identificada (ou Wave/emissão no destino sem fonte): não se afirma "Master não localizado".
      return avaliacao(
        indeterminado(fontesDaModalidade(master)),
        indeterminado(fontesDaModalidade(master)),
        indeterminado([...fontesDaModalidade(master), ...acoes.semFonteIntegrada], courierFora),
      );
  }
}
