import type { LeituraDoMblDoMaster } from './camposDoMbl';
import { normalizarCodigo, validaISO6346 } from '../preAlerta/normalizacao';

/**
 * Contrato de evidências do MBL (S2, dono: Auditoria) — o que as leituras JÁ persistidas do MBL de UM Master permitem
 * afirmar sobre cada campo documental, com a origem de cada versão. Puro: nenhum banco, nenhum OCR, nenhuma IA,
 * nenhuma escolha entre versões. A entrada é a de `leiturasDoMblDoMaster` (o documento certo pelas regras já aprovadas).
 *
 * Estado DOCUMENTAL, não de uso: "PRESENTE" quer dizer que o documento traz o campo legível e no padrão — nunca que o
 * dado está autorizado para uma decisão operacional. Cada consumidor aplica a própria regra de uso por cima (ex.: a
 * Liberação mantém o consignatário não publicado pela 14.18).
 *
 * Por versão e por campo:
 *  - PRESENTE: o texto que o OCR leu (pontas aparadas); contêineres na normalização do PB-001, um por linha;
 *  - AUSENTE: NAO_LIDO (o OCR não devolveu o campo) ou NAO_PRESERVADO (extração anterior à 0106, sem campos);
 *  - NAO_UTILIZAVEL: documento ilegível, ou lista de contêineres com item fora do ISO 6346 / repetido (PB-001, DOC-27).
 * Por campo, no Master (todas as versões; IGUAL, SO_FORMATACAO e DIVERGENTE trazem TODOS os textos originais
 * distintos, na ordem das versões — nenhum é escolhido):
 *  - SEM_VINCULO_DOCUMENTAL: o Master não tem vínculo válido e publicado (S2/S6) — nenhuma leitura é dele;
 *  - AUSENTE: nenhuma versão traz o campo;
 *  - NAO_UTILIZAVEL: alguma versão tem leitura não utilizável do campo (não dá para afirmar que não há divergência);
 *  - IGUAL: o mesmo valor escrito da DOC-31.B em todas (espaços horizontais repetidos não contam; quebra de linha conta);
 *  - SO_FORMATACAO: diferença COMPROVADAMENTE cosmética, e só ela: CRLF × LF e espaço horizontal no fim da linha.
 *    Nenhuma quebra entre textos é criada ou removida e nenhuma linha muda de conteúdo (indentação e linha em
 *    branco contam);
 *  - DIVERGENTE: qualquer outra diferença — inclusive quebra de linha acrescentada ou retirada entre textos, que pode
 *    mudar onde termina a razão social, o endereço ou o navio. Na dúvida, diverge: não provar a divergência não prova
 *    a equivalência.
 * Uma versão ilegível não traz nenhum campo e não decide nada; só ilegíveis → NAO_UTILIZAVEL.
 */

export const CAMPOS_DO_MBL = ['navio', 'consignee', 'conteineres'] as const;
export type CampoDoMbl = typeof CAMPOS_DO_MBL[number];

export type MotivoNaoUtilizavel = 'DOCUMENTO_ILEGIVEL' | 'CONTEINER_FORA_DO_PADRAO_ISO_6346' | 'CONTEINER_REPETIDO';

export type EstadoDocumental =
  | { tipo: 'PRESENTE'; valor: string }
  | { tipo: 'AUSENTE'; motivo: 'NAO_LIDO' | 'NAO_PRESERVADO' }
  | { tipo: 'NAO_UTILIZAVEL'; motivo: MotivoNaoUtilizavel };

/** Uma versão do MBL deste Master (uma extração persistida), com a sua origem e o estado de cada campo. */
export interface VersaoDoMbl {
  extracaoId: string;
  evidencia: { fonte: 'auditoria'; ref: string };
  /** Processos vinculados ao Master por ESTA extração. */
  processoIds: string[];
  /** Mensagem e anexo do Outlook, remetente, recebimento e sha256 dos bytes lidos. */
  origem: LeituraDoMblDoMaster['origem'];
  extrator: string;
  extratorVersao: string;
  modelo: string;
  extraidaEm: Date;
  /** Data da fonte: o recebimento do e-mail; sem ela, a da extração. */
  observadoEm: Date;
  /** Número do conhecimento como o OCR leu (literal, sem normalização). */
  conhecimento: string | null;
  /** Os campos exatamente como a Auditoria os persistiu (pontas, quebras de linha e CR preservados); null = anterior à 0106. */
  campos: LeituraDoMblDoMaster['campos'];
  legivel: boolean;
  estados: Readonly<Record<CampoDoMbl, EstadoDocumental>>;
}

export type SituacaoDoCampo =
  | { tipo: 'SEM_VINCULO_DOCUMENTAL' }
  | { tipo: 'AUSENTE' }
  | { tipo: 'NAO_UTILIZAVEL'; motivos: MotivoNaoUtilizavel[] }
  | { tipo: 'IGUAL'; valores: string[] }
  | { tipo: 'SO_FORMATACAO'; valores: string[] }
  | { tipo: 'DIVERGENTE'; valores: string[] };

export interface EvidenciasDoMbl {
  masterId: string;
  vinculo: 'VINCULADO' | 'SEM_VINCULO_VALIDO';
  /** Todas as versões, na ordem das leituras (recebimento, extração, id). Nada é deduplicado: cada origem fica. */
  versoes: VersaoDoMbl[];
  situacao: Readonly<Record<CampoDoMbl, SituacaoDoCampo>>;
}

/** Leitura de entrada: a do contrato S2; `legivel` ausente = legível (o S2 só publica leitura legível). */
export type LeituraParaEvidencia = LeituraDoMblDoMaster & { legivel?: boolean };

const vazio = (v: string | null | undefined) => String(v ?? '').trim() === '';
/** O valor escrito da DOC-31.B (`valorEscritoNoLugar` sem o formato do lugar): espaços horizontais repetidos não contam. */
const escritaDoc31B = (v: string) => v.replace(/[^\S\n]+/g, ' ').trim();
/**
 * Além disso, só o comprovadamente cosmético: espaço horizontal antes da quebra (invisível, não delimita nada). O CR
 * é espaço horizontal, então CRLF = LF por esta mesma regra.
 */
const semFormatacaoCosmetica = (v: string) => escritaDoc31B(v.replace(/[^\S\n]+\n/g, '\n'));

function estadoDoCampo(l: LeituraParaEvidencia, campo: CampoDoMbl): EstadoDocumental {
  if (l.legivel === false) return { tipo: 'NAO_UTILIZAVEL', motivo: 'DOCUMENTO_ILEGIVEL' };
  const c = l.campos;
  if (!c) return { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' };
  switch (campo) {
    case 'navio':
      return vazio(c.navio) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'PRESENTE', valor: String(c.navio).trim() };
    case 'consignee':
      return vazio(c.consignee) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'PRESENTE', valor: String(c.consignee).trim() };
    case 'conteineres': {
      if (!c.conteineres.length) return { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
      // Regra do PB-001 (N13): um item fora do ISO 6346, ou sem número lido, invalida a lista inteira.
      if (!c.conteineres.every((n) => validaISO6346(n))) return { tipo: 'NAO_UTILIZAVEL', motivo: 'CONTEINER_FORA_DO_PADRAO_ISO_6346' };
      const itens = c.conteineres.map((n) => normalizarCodigo(n));
      // DOC-27: repetição é dado inconsistente — nada é descartado em silêncio.
      if (new Set(itens.map((x) => x.toUpperCase())).size !== itens.length) return { tipo: 'NAO_UTILIZAVEL', motivo: 'CONTEINER_REPETIDO' };
      return { tipo: 'PRESENTE', valor: itens.join('\n') };
    }
  }
}

function situacaoDoCampo(vinculado: boolean, versoes: ReadonlyArray<VersaoDoMbl>, campo: CampoDoMbl): SituacaoDoCampo {
  if (!vinculado) return { tipo: 'SEM_VINCULO_DOCUMENTAL' };
  if (!versoes.length) return { tipo: 'AUSENTE' };
  const legiveis = versoes.filter((v) => v.legivel);
  if (!legiveis.length) return { tipo: 'NAO_UTILIZAVEL', motivos: ['DOCUMENTO_ILEGIVEL'] };
  const estados = legiveis.map((v) => v.estados[campo]);
  const motivos = [...new Set(estados.flatMap((e) => (e.tipo === 'NAO_UTILIZAVEL' ? [e.motivo] : [])))];
  if (motivos.length) return { tipo: 'NAO_UTILIZAVEL', motivos };
  const valores = [...new Set(estados.flatMap((e) => (e.tipo === 'PRESENTE' ? [e.valor] : [])))];
  if (!valores.length) return { tipo: 'AUSENTE' };
  if (new Set(valores.map(escritaDoc31B)).size === 1) return { tipo: 'IGUAL', valores };
  if (new Set(valores.map(semFormatacaoCosmetica)).size === 1) return { tipo: 'SO_FORMATACAO', valores };
  return { tipo: 'DIVERGENTE', valores };
}

/**
 * As evidências do MBL de UM Master. `vinculado` = o Master tem vínculo válido e publicado (S2/S6); leitura de outro
 * Master nunca entra.
 */
export function evidenciasDoMbl(masterId: string, vinculado: boolean, leituras: ReadonlyArray<LeituraParaEvidencia>): EvidenciasDoMbl {
  const versoes: VersaoDoMbl[] = !vinculado ? [] : leituras.filter((l) => l.masterId === masterId).map((l) => ({
    extracaoId: l.extracaoId,
    evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${l.extracaoId}` },
    processoIds: [...l.processoIds],
    origem: l.origem,
    extrator: l.extrator,
    extratorVersao: l.extratorVersao,
    modelo: l.modelo,
    extraidaEm: l.extraidaEm,
    observadoEm: l.origem.recebidaEm ?? l.extraidaEm,
    conhecimento: l.conhecimento,
    campos: l.campos,
    legivel: l.legivel !== false,
    estados: { navio: estadoDoCampo(l, 'navio'), consignee: estadoDoCampo(l, 'consignee'), conteineres: estadoDoCampo(l, 'conteineres') },
  }));
  return {
    masterId,
    vinculo: vinculado ? 'VINCULADO' : 'SEM_VINCULO_VALIDO',
    versoes,
    situacao: {
      navio: situacaoDoCampo(vinculado, versoes, 'navio'),
      consignee: situacaoDoCampo(vinculado, versoes, 'consignee'),
      conteineres: situacaoDoCampo(vinculado, versoes, 'conteineres'),
    },
  };
}
