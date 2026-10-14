import { compararInstantes } from './fato';
import { EstadoOficial, IndeterminacaoL1b, Integrado, indeterminacao, ler } from './fontes';
import { SituacaoHouse, situacaoDaHouse } from './avaliacao';
import { CourierDoProcesso, Evidencia, FatoOficial, Instante } from './tipos';
import { CodigoAcao, Responsavel } from './operacao';

/**
 * L1b — House (cap. 14–16, 20, 41; H-2, H-5; P6). Caminho B (HBL original
 * conferido pela Rocket no Courier) continua sendo a L1a (`situacaoDaHouse`,
 * reutilizada sem mudança). A L1b acrescenta, só com as fontes existentes:
 *  - caminho A: foto do HBL original no Portal; a decisão é sempre do
 *    Analista; alertas do OCR/IA são atenção, nunca reprovação;
 *  - Telex: só e-mail operacionalmente válido do agente (o cliente não confirma Telex);
 *  - modalidade do House (físico × Telex) conhecida ou desconhecida —
 *    desconhecida nunca é adivinhada: a próxima ação é identificá-la.
 */

export interface FotoDoHbl {
  recebidaEm: Instante;
  evidencia: Evidencia;
  /** Alertas do OCR/IA (número divergente, baixa legibilidade…): só atenção (cap. 15, 41). */
  alertasOcr: ReadonlyArray<string>;
  decisao: null | { tipo: 'CONFIRMADO' | 'REPROVADO'; por: string; em: Instante; motivo: string | null; evidencia: Evidencia };
}

/** Modalidade do House informada pelo agente. Físico: a quem o original foi encaminhado, quando se sabe. */
export type ModalidadeHouse = { tipo: 'TELEX' } | { tipo: 'FISICO'; encaminhadoA: 'CLIENTE' | 'ROCKET' | null };

/** Informação de modalidade do HBL/MBL (fonte MODALIDADE_BL) e os pedidos dela já feitos ao agente (P6). */
export interface InformacaoDeModalidade {
  house: FatoOficial<ModalidadeHouse> | null;
  pedidos: ReadonlyArray<{ em: Instante; evidencia: Evidencia; house: boolean; master: boolean }>;
}

export interface EntradaDaHouse {
  courier: CourierDoProcesso;
  fotosHbl: Integrado<ReadonlyArray<FotoDoHbl>>;
  /** Telex Release por e-mail válido do agente (nunca declaração do cliente). */
  telex: Integrado<EstadoOficial<'APTO'>>;
  modalidade: Integrado<InformacaoDeModalidade>;
  /** Confirmação do pré-alerta: depois dela, modalidade faltante vira pedido ao agente (P6). */
  preAlerta: Integrado<EstadoOficial<'CONFIRMADO'>>;
}

export type CaminhoHouse = 'A_FOTO_CONFIRMADA_PELO_ANALISTA' | 'B_ORIGINAL_RECEBIDO_PELA_ROCKET' | 'TELEX';

export type CondicaoHouse =
  | 'FOTO_DO_HBL_AGUARDANDO_ANALISTA'
  | 'FOTO_DO_HBL_REPROVADA'
  | 'FOTO_DO_HBL_PENDENTE'
  | 'TELEX_AGUARDANDO_AGENTE'
  | 'HBL_FISICO_EM_TRANSITO'
  | 'CONFERENCIA_DO_HBL_PENDENTE'
  | 'HBL_AUSENTE_NA_CONFERENCIA'
  | 'HBL_FISICO_AGUARDANDO'
  | 'MODALIDADE_DO_HOUSE_DESCONHECIDA';

/** Resultado de uma dimensão do lado cliente (Termo, Financeiro, House). `episodio` muda a cada mudança material (P5). */
export type ResultadoDimensao =
  | { estado: 'RESOLVIDO'; detalhe: string; em: Instante; evidencia: Evidencia }
  | {
    estado: 'PENDENTE'; motivo: string; responsavel: Responsavel; acao: CodigoAcao | null; classe: 'C' | 'D';
    episodio: string; desde: Instante | null; detalhe?: ReadonlyArray<string>;
    /** Campos obrigatórios que faltam (Termo pendente de correção). */
    camposFaltantes?: ReadonlyArray<string>;
  }
  /** Fonte integrada fora sem fato anterior, reconfirmação necessária ou sem observação: desconhecido, nunca negativo. */
  | { estado: 'DESCONHECIDO'; motivo: string; ind: IndeterminacaoL1b; episodio: string }
  /** Fonte não integrada (D-6). */
  | { estado: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

export interface SituacaoHouseL1b {
  /** Visão congelada da L1a (caminho B), reutilizada sem mudança. */
  l1a: SituacaoHouse;
  caminhos: Array<{ caminho: CaminhoHouse; em: Instante; evidencia: Evidencia }>;
  resultado: ResultadoDimensao;
  modalidade: ModalidadeHouse | null;
  alertasOcr: ReadonlyArray<string>;
}

export const indeterminadoOuDesconhecido = (ind: IndeterminacaoL1b, motivo: string, episodio: string): ResultadoDimensao =>
  ind.semFonteIntegrada.length ? { estado: 'NAO_DETERMINAVEL', ind } : { estado: 'DESCONHECIDO', motivo, ind, episodio };

export function situacaoDaHouseL1b(e: EntradaDaHouse): SituacaoHouseL1b {
  const l1a = situacaoDaHouse(e.courier);
  const caminhos: SituacaoHouseL1b['caminhos'] = [];
  if (l1a.tipo === 'RESOLVIDO') caminhos.push({ caminho: 'B_ORIGINAL_RECEBIDO_PELA_ROCKET', em: l1a.resolvidoEm, evidencia: l1a.evidencia });
  const telex = ler('EMAIL_TELEX', e.telex);
  if (telex.tipo === 'CONHECIDO') caminhos.push({ caminho: 'TELEX', em: telex.fato.vigenteDesde, evidencia: telex.fato.evidencia });
  const fotos = e.fotosHbl.tipo === 'INTEGRADA' ? [...e.fotosHbl.valor].sort((a, b) => compararInstantes(a.recebidaEm, b.recebidaEm)) : [];
  const confirmada = fotos.find((f) => f.decisao?.tipo === 'CONFIRMADO');
  if (confirmada?.decisao) caminhos.push({ caminho: 'A_FOTO_CONFIRMADA_PELO_ANALISTA', em: confirmada.decisao.em, evidencia: confirmada.decisao.evidencia });
  caminhos.sort((a, b) => compararInstantes(a.em, b.em));

  const info = e.modalidade.tipo === 'INTEGRADA' ? e.modalidade.valor : null;
  const modalidade = info?.house?.valor ?? null;
  const alertasOcr = fotos.flatMap((f) => f.alertasOcr);
  const base = { l1a, caminhos, modalidade, alertasOcr };
  if (caminhos.length) {
    const c = caminhos[0];
    return { ...base, resultado: { estado: 'RESOLVIDO', detalhe: c.caminho, em: c.em, evidencia: c.evidencia } };
  }
  const pendente = (motivo: CondicaoHouse, responsavel: Responsavel, acao: CodigoAcao | null, classe: 'C' | 'D', ref: string, desde: Instante | null): SituacaoHouseL1b =>
    ({ ...base, resultado: { estado: 'PENDENTE', motivo, responsavel, acao, classe, episodio: `HOUSE|${motivo}|${ref}`, desde } });

  // Caminho A em curso: a decisão é do Analista.
  const ultima = fotos[fotos.length - 1];
  if (ultima && !ultima.decisao) return pendente('FOTO_DO_HBL_AGUARDANDO_ANALISTA', 'ROCKET', 'VALIDAR_HBL_FISICO', 'C', ultima.evidencia.ref, ultima.recebidaEm);
  if (ultima?.decisao?.tipo === 'REPROVADO') {
    return pendente('FOTO_DO_HBL_REPROVADA', 'CLIENTE', 'AGUARDAR_NOVA_FOTO_DO_HBL', 'D', ultima.decisao.evidencia.ref, ultima.decisao.em);
  }

  const courierFora = !e.courier.fonte.disponivel;
  const fotosFonte = e.fotosHbl.tipo === 'NAO_INTEGRADA' ? 'NAO_INTEGRADA' : e.fotosHbl.fonte.disponivel ? 'OBSERVAVEL' : 'INDISPONIVEL';
  const telexFonte = telex.tipo === 'NAO_DETERMINAVEL' ? (telex.ind.semFonteIntegrada.length ? 'NAO_INTEGRADA' : 'INDISPONIVEL') : 'OBSERVAVEL';
  const modalidadeFonte = e.modalidade.tipo === 'NAO_INTEGRADA' ? 'NAO_INTEGRADA'
    : e.modalidade.fonte.disponivel || info?.house ? 'OBSERVAVEL' : 'INDISPONIVEL';
  const falta = (pares: ReadonlyArray<readonly ['NAO_INTEGRADA' | 'INDISPONIVEL' | 'OBSERVAVEL', 'PORTAL_FOTO_HBL' | 'EMAIL_TELEX' | 'MODALIDADE_BL']>, foraCourier: boolean) =>
    indeterminacao(
      pares.filter(([s]) => s === 'NAO_INTEGRADA').map(([, c]) => c),
      [...pares.filter(([s]) => s === 'INDISPONIVEL').map(([, c]) => c), ...(foraCourier ? ['COURIER' as const] : [])],
    );
  const semFonte = (ind: IndeterminacaoL1b, motivo: string): SituacaoHouseL1b =>
    ({ ...base, resultado: indeterminadoOuDesconhecido(ind, motivo, `HOUSE|DESCONHECIDO|${[...ind.fontesIndisponiveis, ...ind.semObservacao].join(',')}`) });

  if (!modalidade) {
    // Modalidade desconhecida: nunca adivinhar físico × Telex (P6). Sem as fontes, "não determinável" (L1a: foto e Telex sem fonte).
    const ind = falta([[fotosFonte, 'PORTAL_FOTO_HBL'], [telexFonte, 'EMAIL_TELEX'], [modalidadeFonte, 'MODALIDADE_BL']], courierFora);
    if (ind.semFonteIntegrada.length || ind.fontesIndisponiveis.length) return semFonte(ind, 'FONTE_INDISPONIVEL');
    // P6: depois do pré-alerta confirmado, pede-se ao agente (uma vez); antes, a ação é identificar a modalidade.
    if (ler('PRE_ALERTA', e.preAlerta).tipo === 'CONHECIDO') {
      const pedido = info!.pedidos.filter((p) => p.house).sort((a, b) => compararInstantes(a.em, b.em))[0];
      if (pedido) return pendente('MODALIDADE_DO_HOUSE_DESCONHECIDA', 'AGENTE', 'AGUARDAR_RESPOSTA_DE_MODALIDADE', 'D', pedido.evidencia.ref, pedido.em);
      return pendente('MODALIDADE_DO_HOUSE_DESCONHECIDA', 'ROCKET', 'SOLICITAR_MODALIDADE_AO_AGENTE', 'C', 'PRE_ALERTA', null);
    }
    return pendente('MODALIDADE_DO_HOUSE_DESCONHECIDA', 'ROCKET', 'IDENTIFICAR_MODALIDADE_DO_HOUSE', 'C', '-', null);
  }
  if (modalidade.tipo === 'TELEX') {
    if (telexFonte !== 'OBSERVAVEL') return semFonte(falta([[telexFonte, 'EMAIL_TELEX']], false), 'FONTE_INDISPONIVEL');
    return pendente('TELEX_AGUARDANDO_AGENTE', 'AGENTE', 'AGUARDAR_TELEX_DO_AGENTE', 'D', info!.house!.evidencia.ref, info!.house!.vigenteDesde);
  }
  // Físico.
  const ref = info!.house!.evidencia.ref;
  const desde = info!.house!.vigenteDesde;
  const viaCourier = (): SituacaoHouseL1b | null => {
    if (courierFora) return null;
    const { envelope, hblOriginal } = e.courier;
    if (hblOriginal?.valor === 'AUSENTE_NA_CONFERENCIA') return pendente('HBL_AUSENTE_NA_CONFERENCIA', 'AGENTE', 'ACOMPANHAR_HBL_AUSENTE_COM_O_AGENTE', 'D', hblOriginal.evidencia.ref, hblOriginal.vigenteDesde);
    if (envelope?.valor === 'EM_TRANSITO') return pendente('HBL_FISICO_EM_TRANSITO', 'TERCEIRO', 'AGUARDAR_HBL_FISICO', 'D', envelope.evidencia.ref, envelope.vigenteDesde);
    if (envelope?.valor === 'ENTREGUE') return pendente('CONFERENCIA_DO_HBL_PENDENTE', 'ROCKET', 'CONFERIR_HBL_NO_COURIER', 'C', envelope.evidencia.ref, envelope.vigenteDesde);
    return null;
  };
  if (modalidade.encaminhadoA === 'CLIENTE') {
    if (fotosFonte !== 'OBSERVAVEL') return semFonte(falta([[fotosFonte, 'PORTAL_FOTO_HBL']], false), 'FONTE_INDISPONIVEL');
    return pendente('FOTO_DO_HBL_PENDENTE', 'CLIENTE', 'AGUARDAR_FOTO_DO_HBL', 'D', ref, desde);
  }
  if (modalidade.encaminhadoA === 'ROCKET') {
    const c = viaCourier();
    if (c) return c;
    if (courierFora) return semFonte(indeterminacao([], ['COURIER']), 'FONTE_INDISPONIVEL');
    return semFonte(indeterminacao([], [], ['COURIER']), 'SEM_OBSERVACAO');
  }
  // Físico sem saber a quem foi o original: espera externa (foto do cliente ou original na Rocket), sem adivinhar.
  const c = viaCourier();
  if (c) return c;
  const ind = falta([[fotosFonte, 'PORTAL_FOTO_HBL']], courierFora);
  if (ind.semFonteIntegrada.length || ind.fontesIndisponiveis.length) return semFonte(ind, 'FONTE_INDISPONIVEL');
  return pendente('HBL_FISICO_AGUARDANDO', 'TERCEIRO', 'AGUARDAR_HBL_FISICO', 'D', ref, desde);
}
