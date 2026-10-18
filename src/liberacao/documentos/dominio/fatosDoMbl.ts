import { Instante } from '../../dominio';
import { valorNoFormato } from './formatos';
import { DADOS_DOS_MODELOS } from './modelosOficiais';
import { DadoNaoPublicado, ValorObservado } from './preenchimento';

/**
 * Entrega 1 / H1 — o que a Auditoria já extraiu do MBL vira dado do documento SÓ quando é confiável pelas regras
 * aprovadas. Puro: nenhum banco, nenhum OCR, nenhuma IA, nenhuma escolha entre versões.
 *
 * A leitura chega aqui já restrita ao documento certo pelo S2 (MBL pelo conteúdo, legível, sustentando vínculo
 * válido com ESTE Master; origem rastreável `auditoria_extracao:{id}`). Por dado:
 *  - navio e viagem: o texto que o OCR leu (não vazio). Só o do MBL: nunca o do rastreamento (S3) sem regra aprovada;
 *  - contêineres: cada número no padrão ISO 6346, com dígito verificador (PB-001, N13: fora do padrão → validação
 *    humana) e sem repetição (DOC-27: repetido → falta, nada descartado em silêncio); um item fora → a lista não vale;
 *  - consignatário: o OCR devolve um texto livre só, e não há critério aprovado para isolar a razão social nem a
 *    forma "uma informação por linha" → nunca publicado (fica preservado como extraído).
 * Cada versão do MBL é uma observação própria: valores iguais concordam e valores diferentes divergem no
 * preenchimento (nada é escolhido). Se alguma versão tem leitura NÃO confiável de um dado, nenhuma versão o
 * publica: não dá para afirmar que não há divergência.
 */

export interface CamposLidosDoMbl {
  navio: string | null;
  consignee: string | null;
  conteineres: ReadonlyArray<string | null>;
}

export interface LeituraDoMbl {
  extracaoId: string;
  masterId: string;
  /** Data da fonte (recebimento do e-mail; sem ela, a da extração). */
  observadoEm: Instante;
  /** null = extração anterior à 0106 (os campos não foram preservados na época). */
  campos: CamposLidosDoMbl | null;
}

export type MotivoNaoConfiavel =
  | 'CONTEINER_FORA_DO_PADRAO_ISO_6346'
  | 'CONTEINER_REPETIDO'
  | 'CONSIGNATARIO_SEM_CRITERIO_APROVADO'
  /** A leitura desta versão é confiável, mas outra versão do mesmo MBL tem leitura não confiável do dado. */
  | 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL';

/**
 * Regra do número de contêiner, fornecida pela aplicação: a MESMA do PB-001 (`normalizarCodigo`, `validaISO6346`),
 * para não haver uma segunda regra de contêiner no domínio documental.
 */
export interface RegraDoConteiner {
  normalizar(numero: string | null): string;
  valido(numero: string | null): boolean;
}

export type EstadoDoDadoDoMbl =
  | { tipo: 'CONFIAVEL'; valor: string }
  | { tipo: 'AUSENTE'; motivo: 'NAO_PRESERVADO' | 'NAO_LIDO' }
  | { tipo: 'NAO_CONFIAVEL'; motivo: MotivoNaoConfiavel };

/** Dados do documento que vêm do MBL extraído (S2). */
export const DADOS_DO_MBL = [
  DADOS_DOS_MODELOS.NAVIO_E_VIAGEM, DADOS_DOS_MODELOS.CONTEINERES_DO_MASTER,
  DADOS_DOS_MODELOS.CONSIGNATARIO_RAZAO_SOCIAL, DADOS_DOS_MODELOS.CONSIGNATARIO_QUALIFICACAO,
] as const;

const vazio = (v: string | null | undefined) => String(v ?? '').trim() === '';

/** Estado de UM dado em UMA leitura do MBL. */
export function estadoDoDado(leitura: LeituraDoMbl, dado: string, conteiner: RegraDoConteiner): EstadoDoDadoDoMbl {
  const c = leitura.campos;
  if (!c) return { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' };
  switch (dado) {
    case DADOS_DOS_MODELOS.NAVIO_E_VIAGEM:
      return vazio(c.navio) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'CONFIAVEL', valor: String(c.navio).trim() };
    case DADOS_DOS_MODELOS.CONTEINERES_DO_MASTER: {
      if (!c.conteineres.length) return { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
      if (!c.conteineres.every((n) => conteiner.valido(n))) return { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_FORA_DO_PADRAO_ISO_6346' };
      const lista = c.conteineres.map((n) => conteiner.normalizar(n)).join('\n');
      return valorNoFormato('LISTA', lista) ? { tipo: 'CONFIAVEL', valor: lista } : { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_REPETIDO' };
    }
    case DADOS_DOS_MODELOS.CONSIGNATARIO_RAZAO_SOCIAL:
    case DADOS_DOS_MODELOS.CONSIGNATARIO_QUALIFICACAO:
      return vazio(c.consignee) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' };
    default:
      return { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
  }
}

const evidenciaDa = (l: LeituraDoMbl) => ({ fonte: 'auditoria', ref: `auditoria_extracao:${l.extracaoId}` });

/**
 * Os dados pedidos (`dados`) das leituras do MBL deste Master: os confiáveis viram `ValorObservado` (fonte
 * S2_AUDITORIA, escopo MASTER, um por versão, cada um com a sua evidência); os extraídos sem confiabilidade
 * suficiente ficam em `naoPublicados`, com o motivo. Leitura de outro Master nunca entra.
 */
export function dadosDoMbl(masterId: string, leituras: ReadonlyArray<LeituraDoMbl>, dados: ReadonlyArray<string>, conteiner: RegraDoConteiner):
  { valores: ValorObservado[]; naoPublicados: DadoNaoPublicado[] } {
  const valores: ValorObservado[] = [];
  const naoPublicados: DadoNaoPublicado[] = [];
  const doMaster = leituras.filter((l) => l.masterId === masterId);
  for (const dado of dados) {
    if (!(DADOS_DO_MBL as ReadonlyArray<string>).includes(dado)) continue;
    const estados = doMaster.map((l) => ({ l, e: estadoDoDado(l, dado, conteiner) }));
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
