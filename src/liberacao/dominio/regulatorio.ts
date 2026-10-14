import { compararInstantes } from './fato';
import { IndeterminacaoL1b, Integrado, Leitura, indeterminacao } from './fontes';
import { CodigoAcao, Responsavel } from './operacao';
import { CeHouse, PendenciaFiscal } from './siscarga';
import { OrigemDoFuso, atingido, limiarAntes } from './tempo';
import { SituacaoViagem } from './viagem';
import { Evidencia, FatoOficial, Instante } from './tipos';

/**
 * L1b — CE / Prazos Regulatórios (cap. 9, 10, 12, 13; H-17, N-19; P9). Visão
 * própria: nenhuma condição daqui vira classe da Fila nem desloca processos
 * aptos (cap. 10, 35; D-1).
 *  - T-48h sem CE House = risco/atenção ("CE House não identificado —
 *    verificar desconsolidação"), nunca culpa automática. Falha da Rocket só
 *    com fato confiável que a prove contra uma obrigação explícita (H-17);
 *    nenhum prazo é inventado aqui.
 *  - Fonte do CE House fora sem fato anterior → nenhuma condição "CE House ausente".
 *  - Base do T-48h: atracação prevista no porto final; na falta, a ETA (N-19).
 *    Só data → 00:00 de D−2 no fuso aplicável; sem fuso seguro → nenhum
 *    limiar. Uma única condição ativa (episódio estável), recalculada quando a
 *    precisão melhora.
 *  - CE Master: existência inferível pelo CE House; tempestividade de 72h não
 *    verificável na V1 (sem CE Mercante).
 *  - Retificação por mudança de rota: primeiro o armador retifica o CE Master
 *    (fato consumido); só depois Rocket/desconsolidação retificam o CE House.
 */

/** Alteração de rota e retificações (fonte ROTA_E_RETIFICACAO: tracking/comunicado do armador e registros). */
export interface RotaERetificacao {
  alteracao: FatoOficial<{ descricao: string }> | null;
  ceMasterRetificado: FatoOficial<true> | null;
  ceHouseRetificado: FatoOficial<true> | null;
}

/** Falha da Rocket provada por fato confiável (ex.: envio do pré-alerta à desconsolidação depois da obrigação explícita). */
export interface FalhaDaRocket {
  obrigacao: string;
  evidencia: Evidencia;
}

export type CondicaoRegulatoria =
  | {
    tipo: 'CE_HOUSE_NAO_IDENTIFICADO_T48'; episodio: string; mensagem: string; limiar: Instante; precisao: 'DATA' | 'DATA_HORA';
    origemDoFuso: OrigemDoFuso; base: 'ATRACACAO_PREVISTA' | 'ETA'; responsavel: Responsavel; acao: CodigoAcao;
    falhaDaRocket: FalhaDaRocket | null;
  }
  | { tipo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA'; marco: 'T48' }
  | { tipo: 'CE_MASTER_INFERIDO'; existencia: 'INFERIDA_PELO_CE_HOUSE'; tempestividade72h: 'NAO_VERIFICAVEL' }
  | {
    tipo: 'PENDENCIA_FISCAL'; causa: string | null; desde: Instante; evidencia: Evidencia; responsavel: Responsavel; acao: CodigoAcao;
    ecacSolicitadoEm: Instante | null;
  }
  | {
    tipo: 'RETIFICACAO_POR_ALTERACAO_DE_ROTA'; fase: 'AGUARDANDO_RETIFICACAO_DO_CE_MASTER' | 'RETIFICAR_CE_HOUSE' | 'CONCLUIDA';
    responsavel: Responsavel | null; acao: CodigoAcao | null; alteracao: string; desde: Instante; possivelBloqueioFiscal: boolean;
  }
  | { tipo: 'INFORMACAO_INDISPONIVEL'; sobre: 'CE_HOUSE' | 'SISCARGA_FISCAL' | 'ROTA_E_RETIFICACAO'; ind: IndeterminacaoL1b };

export interface EntradaRegulatoria {
  processoId: string;
  agora: Instante;
  viagem: SituacaoViagem;
  ceHouse: Leitura<CeHouse>;
  fiscal: Leitura<PendenciaFiscal>;
  /** Solicitações de desbloqueio no e-CAC registradas pela Rocket. */
  ecac: ReadonlyArray<{ em: Instante; evidencia: Evidencia }>;
  rota: Integrado<RotaERetificacao>;
  falhaDaRocket: FalhaDaRocket | null;
}

export const MENSAGEM_CE_HOUSE_T48 = 'CE House não identificado — verificar desconsolidação';

export function condicoesRegulatorias(e: EntradaRegulatoria): CondicaoRegulatoria[] {
  const c: CondicaoRegulatoria[] = [];

  // CE House a T-48h.
  if (e.ceHouse.tipo === 'CONHECIDO') {
    c.push({ tipo: 'CE_MASTER_INFERIDO', existencia: 'INFERIDA_PELO_CE_HOUSE', tempestividade72h: 'NAO_VERIFICAVEL' });
  } else if (e.ceHouse.tipo === 'NAO_DETERMINAVEL') {
    c.push({ tipo: 'INFORMACAO_INDISPONIVEL', sobre: 'CE_HOUSE', ind: e.ceHouse.ind });
  } else {
    const v = e.viagem;
    const base = v.atracacaoPrevista ? { marco: v.atracacaoPrevista.valor, nome: 'ATRACACAO_PREVISTA' as const }
      : v.eta ? { marco: v.eta.valor, nome: 'ETA' as const } : null;
    // Divergência de viagem (N-10): nenhuma ETA é escolhida, logo nenhum limiar.
    if (base && v.porto && !v.divergenciaDeViagem) {
      const limiar = limiarAntes(base.marco, v.porto, 2);
      if (limiar.tipo === 'NAO_MATERIALIZAVEL') c.push({ tipo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA', marco: 'T48' });
      else if (atingido(limiar, e.agora)) {
        c.push({
          tipo: 'CE_HOUSE_NAO_IDENTIFICADO_T48', episodio: `T48|${e.processoId}`, mensagem: MENSAGEM_CE_HOUSE_T48, limiar: limiar.instante,
          precisao: limiar.precisao, origemDoFuso: limiar.origemDoFuso, base: base.nome, responsavel: 'ROCKET', acao: 'VERIFICAR_DESCONSOLIDACAO',
          falhaDaRocket: e.falhaDaRocket,
        });
      }
    }
  }

  // Pendência fiscal (exceção): causa, responsável, ação e reconsulta visíveis.
  if (e.fiscal.tipo === 'CONHECIDO' && e.fiscal.fato.valor.situacao === 'COM_PENDENCIA') {
    const desde = e.fiscal.fato.vigenteDesde;
    const pedido = e.ecac.filter((x) => compararInstantes(x.em, desde) >= 0).sort((a, b) => compararInstantes(a.em, b.em))[0] ?? null;
    c.push({
      tipo: 'PENDENCIA_FISCAL', causa: e.fiscal.fato.valor.causa, desde, evidencia: e.fiscal.fato.evidencia, responsavel: 'ROCKET',
      acao: pedido ? 'RECONSULTAR_PENDENCIA_FISCAL' : 'SOLICITAR_DESBLOQUEIO_FISCAL_NO_ECAC', ecacSolicitadoEm: pedido?.em ?? null,
    });
  } else if (e.fiscal.tipo === 'NAO_DETERMINAVEL' && e.fiscal.ind.fontesIndisponiveis.length) {
    c.push({ tipo: 'INFORMACAO_INDISPONIVEL', sobre: 'SISCARGA_FISCAL', ind: e.fiscal.ind });
  }

  // Alteração de rota → retificação sequencial.
  if (e.rota.tipo === 'INTEGRADA') {
    const r = e.rota.valor;
    if (r.alteracao) {
      const depois = (f: FatoOficial<true> | null) => (f && compararInstantes(f.vigenteDesde, r.alteracao!.vigenteDesde) >= 0 ? f : null);
      const master = depois(r.ceMasterRetificado);
      const house = master && r.ceHouseRetificado && compararInstantes(r.ceHouseRetificado.vigenteDesde, master.vigenteDesde) >= 0
        ? r.ceHouseRetificado : null;
      const comum = { tipo: 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' as const, alteracao: r.alteracao.valor.descricao };
      if (!master) {
        c.push({ ...comum, fase: 'AGUARDANDO_RETIFICACAO_DO_CE_MASTER', responsavel: 'ARMADOR', acao: 'AGUARDAR_RETIFICACAO_DO_CE_MASTER', desde: r.alteracao.vigenteDesde, possivelBloqueioFiscal: true });
      } else if (!house) {
        c.push({ ...comum, fase: 'RETIFICAR_CE_HOUSE', responsavel: 'DESCONSOLIDACAO', acao: 'RETIFICAR_CE_HOUSE', desde: master.vigenteDesde, possivelBloqueioFiscal: true });
      } else {
        c.push({ ...comum, fase: 'CONCLUIDA', responsavel: null, acao: null, desde: house.vigenteDesde, possivelBloqueioFiscal: false });
      }
    } else if (!e.rota.fonte.disponivel) {
      c.push({ tipo: 'INFORMACAO_INDISPONIVEL', sobre: 'ROTA_E_RETIFICACAO', ind: indeterminacao([], ['ROTA_E_RETIFICACAO']) });
    }
  }
  return c;
}
