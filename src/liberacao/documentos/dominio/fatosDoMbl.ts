import { Instante } from '../../dominio';
import { DADOS_DOS_MODELOS } from './modelosOficiais';
import { DadoNaoPublicado, ValorObservado } from './preenchimento';

/**
 * Entrega 1 / H1 — o que a Auditoria já extraiu do MBL vira dado do documento SÓ quando é confiável pelas regras
 * aprovadas. Puro: nenhum banco, nenhum OCR, nenhuma IA, nenhuma escolha entre versões.
 *
 * E1: o estado DOCUMENTAL de cada campo (presente, ausente, não utilizável) vem pronto do dono — o contrato de
 * evidências do MBL da Auditoria (`auditoria/fatos/evidenciasDoMbl.ts`), sobre a leitura já restrita ao documento
 * certo pelo S2 (MBL pelo conteúdo, legível, sustentando vínculo válido com ESTE Master; origem rastreável
 * `auditoria_extracao:{id}`). Aqui fica SÓ a regra de uso da Liberação, por dado:
 *  - navio e viagem: o texto que o OCR leu, quando presente. Só o do MBL: nunca o do rastreamento (S3) sem regra aprovada;
 *  - contêineres: a lista no padrão do PB-001 (ISO 6346, sem repetição — DOC-27); não utilizável → não confiável, com
 *    o motivo da Auditoria;
 *  - consignatário: o OCR devolve um texto livre só, e não há critério aprovado para isolar a razão social nem a
 *    forma "uma informação por linha" → nunca publicado (14.18; fica preservado como extraído).
 * Cada versão do MBL é uma observação própria: valores iguais concordam e valores diferentes divergem no
 * preenchimento (nada é escolhido). Se alguma versão tem leitura NÃO confiável de um dado, nenhuma versão o
 * publica: não dá para afirmar que não há divergência.
 */

/** Campos documentais do MBL como a Auditoria os entrega (espelho estrutural do contrato do dono). */
export type CampoDocumentalDoMbl = 'navio' | 'consignee' | 'conteineres';

/** Estado documental de UM campo numa versão do MBL, decidido pela Auditoria (nunca recalculado aqui). */
export type EstadoDocumentalDoMbl =
  | { tipo: 'PRESENTE'; valor: string }
  | { tipo: 'AUSENTE'; motivo: 'NAO_LIDO' | 'NAO_PRESERVADO' }
  | { tipo: 'NAO_UTILIZAVEL'; motivo: 'DOCUMENTO_ILEGIVEL' | 'CONTEINER_FORA_DO_PADRAO_ISO_6346' | 'CONTEINER_REPETIDO' };

/** Uma versão do MBL deste Master, com o estado documental de cada campo. */
export interface LeituraDoMbl {
  extracaoId: string;
  masterId: string;
  /** Data da fonte (recebimento do e-mail; sem ela, a da extração). */
  observadoEm: Instante;
  estados: Readonly<Record<CampoDocumentalDoMbl, EstadoDocumentalDoMbl>>;
}

export type MotivoNaoConfiavel =
  | 'CONTEINER_FORA_DO_PADRAO_ISO_6346'
  | 'CONTEINER_REPETIDO'
  | 'CONSIGNATARIO_SEM_CRITERIO_APROVADO'
  /** A leitura desta versão é confiável, mas outra versão do mesmo MBL tem leitura não confiável do dado. */
  | 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL';

export type EstadoDoDadoDoMbl =
  | { tipo: 'CONFIAVEL'; valor: string }
  | { tipo: 'AUSENTE'; motivo: 'NAO_PRESERVADO' | 'NAO_LIDO' }
  | { tipo: 'NAO_CONFIAVEL'; motivo: MotivoNaoConfiavel };

/** Dados do documento que vêm do MBL extraído (S2). */
export const DADOS_DO_MBL = [
  DADOS_DOS_MODELOS.NAVIO_E_VIAGEM, DADOS_DOS_MODELOS.CONTEINERES_DO_MASTER,
  DADOS_DOS_MODELOS.CONSIGNATARIO_RAZAO_SOCIAL, DADOS_DOS_MODELOS.CONSIGNATARIO_QUALIFICACAO,
] as const;

/** De qual campo documental do MBL cada dado do documento sai. */
const CAMPO_DO_DADO: Readonly<Record<string, CampoDocumentalDoMbl>> = {
  [DADOS_DOS_MODELOS.NAVIO_E_VIAGEM]: 'navio',
  [DADOS_DOS_MODELOS.CONTEINERES_DO_MASTER]: 'conteineres',
  [DADOS_DOS_MODELOS.CONSIGNATARIO_RAZAO_SOCIAL]: 'consignee',
  [DADOS_DOS_MODELOS.CONSIGNATARIO_QUALIFICACAO]: 'consignee',
};

const ilegivel = (l: LeituraDoMbl) => Object.values(l.estados).some((e) => e.tipo === 'NAO_UTILIZAVEL' && e.motivo === 'DOCUMENTO_ILEGIVEL');

/** Estado de UM dado em UMA leitura do MBL: o estado documental da Auditoria com a regra de uso da Liberação por cima. */
export function estadoDoDado(leitura: LeituraDoMbl, dado: string): EstadoDoDadoDoMbl {
  const campo = Object.prototype.hasOwnProperty.call(CAMPO_DO_DADO, dado) ? CAMPO_DO_DADO[dado] : null;
  // Extração anterior à 0106 não preservou nenhum campo (o estado vem igual em todos).
  if (!campo) return leitura.estados.navio.tipo === 'AUSENTE' && leitura.estados.navio.motivo === 'NAO_PRESERVADO' ? { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' } : { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
  const e = leitura.estados[campo];
  if (e.tipo === 'AUSENTE') return { tipo: 'AUSENTE', motivo: e.motivo };
  // Documento ilegível não traz dado nenhum (o S2 nem o vincula ao Master).
  if (e.tipo === 'NAO_UTILIZAVEL') return e.motivo === 'DOCUMENTO_ILEGIVEL' ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'NAO_CONFIAVEL', motivo: e.motivo };
  // 14.18: o consignatário extraído não é publicado — não há critério aprovado (presente no documento ≠ autorizado).
  if (campo === 'consignee') return { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' };
  return { tipo: 'CONFIAVEL', valor: e.valor };
}

const evidenciaDa = (l: LeituraDoMbl) => ({ fonte: 'auditoria', ref: `auditoria_extracao:${l.extracaoId}` });

/**
 * Os dados pedidos (`dados`) das leituras do MBL deste Master: os confiáveis viram `ValorObservado` (fonte
 * S2_AUDITORIA, escopo MASTER, um por versão, cada um com a sua evidência); os extraídos sem confiabilidade
 * suficiente ficam em `naoPublicados`, com o motivo. Leitura de outro Master nunca entra; versão ilegível não conta.
 */
export function dadosDoMbl(masterId: string, leituras: ReadonlyArray<LeituraDoMbl>, dados: ReadonlyArray<string>):
  { valores: ValorObservado[]; naoPublicados: DadoNaoPublicado[] } {
  const valores: ValorObservado[] = [];
  const naoPublicados: DadoNaoPublicado[] = [];
  const doMaster = leituras.filter((l) => l.masterId === masterId && !ilegivel(l));
  for (const dado of dados) {
    if (!(DADOS_DO_MBL as ReadonlyArray<string>).includes(dado)) continue;
    const estados = doMaster.map((l) => ({ l, e: estadoDoDado(l, dado) }));
    const algumaNaoConfiavel = estados.some((x) => x.e.tipo === 'NAO_CONFIAVEL');
    for (const { l, e } of estados) {
      const base = { dado, fonte: 'S2_AUDITORIA' as const, evidencia: evidenciaDa(l), observadoEm: l.observadoEm };
      if (e.tipo === 'NAO_CONFIAVEL') naoPublicados.push({ ...base, motivo: e.motivo });
      else if (e.tipo === 'CONFIAVEL' && algumaNaoConfiavel) naoPublicados.push({ ...base, motivo: 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL' });
      else if (e.tipo === 'CONFIAVEL') valores.push({ ...base, valor: e.valor, escopo: { tipo: 'MASTER', masterId } });
    }
  }
  return { valores, naoPublicados };
}
