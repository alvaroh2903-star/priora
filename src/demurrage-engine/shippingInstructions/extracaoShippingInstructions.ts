import { createHash } from 'crypto';

/**
 * Extrator DEDICADO da Shipping Instructions (SI). Módulo PURO: sem banco, sem
 * Graph, sem IA — recebe só a PRIMEIRA mensagem cronológica da conversa de
 * pré-alerta e devolve ocorrências estruturadas de Master Free Time.
 *
 * Separado do `ExtractionSchema` genérico da auditoria de pré-alerta: a regra e
 * a proveniência da SI são específicas e não devem forçar leitura de campos
 * irrelevantes nem poluir o schema de auditoria.
 *
 * Regras:
 * - Corpo: parser textual DETERMINÍSTICO. Aceita inteiro >= 0 (zero é válido)
 *   ligado inequivocamente a Free Time/Demurrage. Negativo/decimal → inválido.
 * - Menção de House/cliente não é Master Free Time e é ignorada.
 * - Mais de um valor distinto no mesmo alcance → ambíguo (pendência).
 * - Anexos: o resultado da leitura documental só é aceito com confiança
 *   >= 0.90, âncora explícita, valor legível e sem múltiplos valores.
 */

export const CONFIANCA_MINIMA_OCR = 0.9;

const RE_ANCORA = /free\s*-?\s*time|demurrage|dias?\s+livres|livre\s+de\s+demurrage/i;
const RE_NAO_MASTER = /\b(house|hbl|h\.b\/l|cliente|client|consignee|importador)\b/i;
const RE_CONTAINER = /\b([A-Z]{4})[\s-]?(\d{6})[\s-]?(\d)\b/g;
const RE_PROCESSO = /\bIM\d{3,6}(?:-\d{1,3})?\b/gi;
const RE_MBL = /\b(?:MBL|M\.?\s?B\/?L|MASTER\s*B\/?L|MASTER\s*BILL(?:\s+OF\s+LADING)?)\s*(?:N[Ooº°.]*|#|NUMBER)?\s*[:\-]?\s*([A-Z0-9]{6,20})\b/gi;

export interface AnexoMetaSI {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline?: boolean;
  lastModifiedDateTime?: string | null;
}

export interface MensagemSI {
  id: string;
  conversationId: string;
  receivedDateTime: string;
  subject?: string | null;
  body: string;
  attachments: AnexoMetaSI[];
}

/** Resultado bruto da leitura documental de um anexo (porta de OCR/visão). */
export interface OcrResultadoSI {
  legivel: boolean;
  masterFreeTimeDays: number | null;
  ancoraTexto: string | null;
  trecho: string | null;
  confianca: number;
  containers: string[];
  mbl: string | null;
  processo: string | null;
  multiplosValores: boolean;
}

/** Uma ocorrência ACEITA de Master Free Time, com sua evidência. */
export interface OcorrenciaFreeTime {
  valor: number;
  /** Contêineres (ISO 6346 normalizados) do alcance; vazio = MBL/processo inteiro. */
  containers: string[];
  encontradoEm: 'corpo' | 'anexo';
  attachmentId: string | null;
  attachmentNome: string | null;
  trecho: string;
  metodo: 'texto' | 'ocr_visao';
  confianca: number;
}

export type ProblemaExtracao =
  | { tipo: 'free_time_ambiguo'; motivo: string; trecho?: string; attachmentId?: string | null; containers?: string[] }
  | { tipo: 'ocr_baixa_confianca'; motivo: string; attachmentId: string; attachmentNome: string; confianca: number };

/** ISO 6346: 4 letras + 7 dígitos, sem espaços/hífens. Null se inválido. */
export function normalizarContainer(numero: string | null | undefined): string | null {
  const n = String(numero ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{4}\d{7}$/.test(n) ? n : null;
}

/** MBL normalizado para comparação (maiúsculas, sem espaços/hífens/pontos/barras). */
export function normalizarMbl(v: string | null | undefined): string {
  return String(v ?? '').toUpperCase().replace(/[\s\-./]/g, '');
}

/** Número do processo reduzido à base (IM1234-01 → IM1234). */
export function baseProcesso(v: string | null | undefined): string {
  return String(v ?? '').toUpperCase().replace(/-\d{1,3}$/, '').trim();
}

export function normalizarCorpo(texto: string | null | undefined): string {
  return String(texto ?? '').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

export interface ReferenciasSI {
  processos: string[]; // bases IM normalizadas
  mbls: string[];      // normalizados
  containers: string[]; // ISO 6346 normalizados
}

/** Referências de processo/MBL/contêiner citadas no assunto + corpo. */
export function extrairReferencias(texto: string): ReferenciasSI {
  const processos = new Set<string>();
  for (const m of texto.matchAll(RE_PROCESSO)) processos.add(baseProcesso(m[0]));
  const mbls = new Set<string>();
  for (const m of texto.matchAll(RE_MBL)) {
    const v = normalizarMbl(m[1]);
    if (/\d/.test(v) && !/^IM\d+$/.test(v)) mbls.add(v);
  }
  const containers = new Set<string>();
  for (const m of texto.toUpperCase().matchAll(RE_CONTAINER)) {
    const n = normalizarContainer(`${m[1]}${m[2]}${m[3]}`);
    if (n) containers.add(n);
  }
  return { processos: [...processos], mbls: [...mbls], containers: [...containers] };
}

/** Candidato bruto encontrado num trecho do corpo. */
interface CandidatoCorpo {
  valores: string[]; // números ligados a dias (validados depois)
  /** Números sem unidade de dias no trecho ancorado (ex.: "Demurrage: 140"). */
  semUnidade: string[];
  containers: string[];
  trecho: string;
}

/**
 * Candidatos do corpo: cada trecho (linha ou parte separada por ';' / '|')
 * com âncora explícita de Free Time/Demurrage e sem contexto de House/cliente.
 */
function candidatosDoCorpo(corpo: string): CandidatoCorpo[] {
  const out: CandidatoCorpo[] = [];
  const trechos = corpo.split(/\n|;|\|/).map((t) => t.trim()).filter(Boolean);
  for (const trecho of trechos) {
    if (!RE_ANCORA.test(trecho) || RE_NAO_MASTER.test(trecho)) continue;
    const containers: string[] = [];
    let limpo = trecho.toUpperCase().replace(RE_CONTAINER, (_m, a, b, c) => {
      const n = normalizarContainer(`${a}${b}${c}`);
      if (n) containers.push(n);
      return ' ';
    });
    // Remove referências que carregam dígitos e não são dias.
    limpo = limpo.replace(RE_PROCESSO, ' ').replace(/\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' ');
    // Só conta número EXPLICITAMENTE ligado a dias ("14 days", "0 dias", "zero days").
    const valores: string[] = [];
    for (const m of limpo.matchAll(/(-?\d+(?:[.,]\d+)?)\s*(?:FREE\s+)?(?:DAYS?|DIAS?)\b/g)) valores.push(m[1]);
    if (/\b(?:ZERO|NIL)\s+(?:FREE\s+)?(?:DAYS?|DIAS?)\b/.test(limpo)) valores.push('0');
    // Número colado à âncora SEM unidade de dias (e sem moeda) é ambíguo.
    const semUnidade: string[] = [];
    for (const m of limpo.matchAll(/(?:FREE\s*-?\s*TIME|DEMURRAGE)\s*(?:MASTER\s*)?[:=\-–]?\s*(-?\d+(?:[.,]\d+)?)(?!\s*(?:DAYS?|DIAS?|USD|US\$|\$|%|\/|[.,]\d|\d))/g)) semUnidade.push(m[1]);
    if (valores.length || semUnidade.length) {
      out.push({ valores: [...new Set(valores)], semUnidade: [...new Set(semUnidade)], containers: [...new Set(containers)], trecho: trecho.slice(0, 500) });
    }
  }
  return out;
}

/** Converte o texto numérico bruto: inteiro >= 0, senão null (negativo/decimal são inválidos). */
export function parseDias(bruto: string): number | null {
  if (!/^\d+$/.test(bruto.trim())) return null;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export interface ResultadoCorpo {
  ocorrencias: OcorrenciaFreeTime[];
  problemas: ProblemaExtracao[];
}

/** Extração determinística do corpo da primeira mensagem. */
export function extrairFreeTimeDoCorpo(corpo: string): ResultadoCorpo {
  const ocorrencias: OcorrenciaFreeTime[] = [];
  const problemas: ProblemaExtracao[] = [];
  for (const c of candidatosDoCorpo(normalizarCorpo(corpo))) {
    if (!c.valores.length) {
      problemas.push({ tipo: 'free_time_ambiguo', trecho: c.trecho, containers: c.containers, motivo: `numero_sem_unidade_dias:${c.semUnidade.join(',')}` });
      continue;
    }
    const validos = [...new Set(c.valores.map(parseDias).filter((v): v is number => v !== null))];
    const invalidos = c.valores.filter((v) => parseDias(v) === null);
    if (invalidos.length || validos.length !== 1) {
      problemas.push({
        tipo: 'free_time_ambiguo', trecho: c.trecho, containers: c.containers,
        motivo: invalidos.length ? `valor_invalido:${invalidos.join(',')}` : `multiplos_valores:${validos.join(',')}`,
      });
      continue;
    }
    ocorrencias.push({
      valor: validos[0], containers: c.containers, encontradoEm: 'corpo', attachmentId: null, attachmentNome: null,
      trecho: c.trecho, metodo: 'texto', confianca: 1,
    });
  }
  return { ocorrencias, problemas };
}

/** Anexo que a leitura documental aceita (PDF/imagem, não inline). */
export function anexoDocumental(a: AnexoMetaSI): boolean {
  if (a.isInline) return false;
  const ct = (a.contentType || '').toLowerCase();
  const n = (a.name || '').toLowerCase();
  return ct.includes('pdf') || n.endsWith('.pdf') || /image\/(png|jpe?g|tiff|webp)/.test(ct) || /\.(png|jpe?g|tiff?|webp)$/.test(n);
}

/**
 * Avalia o resultado da leitura documental de um anexo. Aceita automaticamente
 * só com: legível, confiança >= 0.90, âncora explícita de Free Time/Demurrage,
 * inteiro >= 0 e valor único. Caso contrário devolve o problema (pendência).
 * `null` em ambos = o anexo não menciona Free Time (nada a registrar).
 */
export function avaliarOcr(anexo: AnexoMetaSI, r: OcrResultadoSI): { ocorrencia: OcorrenciaFreeTime | null; problema: ProblemaExtracao | null } {
  const confianca = Number.isFinite(r.confianca) ? Math.max(0, Math.min(1, r.confianca)) : 0;
  const temAncora = !!r.ancoraTexto && RE_ANCORA.test(r.ancoraTexto) && !RE_NAO_MASTER.test(r.ancoraTexto);
  // Ilegível: não dá para afirmar que o anexo não traz Free Time → pendência.
  if (!r.legivel) {
    return { ocorrencia: null, problema: { tipo: 'ocr_baixa_confianca', motivo: 'ilegivel', attachmentId: anexo.id, attachmentNome: anexo.name, confianca } };
  }
  if (r.masterFreeTimeDays === null && !r.multiplosValores) return { ocorrencia: null, problema: null };
  if (confianca < CONFIANCA_MINIMA_OCR) {
    return { ocorrencia: null, problema: { tipo: 'ocr_baixa_confianca', motivo: r.legivel ? `confianca:${confianca}` : 'ilegivel', attachmentId: anexo.id, attachmentNome: anexo.name, confianca } };
  }
  const valor = r.masterFreeTimeDays;
  const valido = typeof valor === 'number' && Number.isInteger(valor) && valor >= 0;
  if (r.multiplosValores || !valido || !temAncora) {
    const motivo = r.multiplosValores ? 'multiplos_valores' : !valido ? `valor_invalido:${valor}` : 'sem_ancora_explicita';
    return { ocorrencia: null, problema: { tipo: 'free_time_ambiguo', motivo, attachmentId: anexo.id, trecho: r.trecho ?? undefined } };
  }
  const containers = [...new Set(r.containers.map(normalizarContainer).filter((n): n is string => !!n))];
  return {
    ocorrencia: {
      valor: valor as number, containers, encontradoEm: 'anexo', attachmentId: anexo.id, attachmentNome: anexo.name,
      trecho: (r.trecho || r.ancoraTexto || '').slice(0, 500), metodo: 'ocr_visao', confianca,
    },
    problema: null,
  };
}

/**
 * Hash da VERSÃO do conteúdo analisado: message_id, receivedDateTime, corpo
 * normalizado e, por anexo, id/nome/tamanho/tipo (+ lastModifiedDateTime quando
 * a API fornecer). Mesma versão → mesmo hash → não repete leitura/OCR.
 */
export function hashConteudo(m: MensagemSI): string {
  const anexos = [...m.attachments]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, lastModified: a.lastModifiedDateTime ?? null }));
  const base = JSON.stringify({ messageId: m.id, receivedDateTime: m.receivedDateTime, corpo: normalizarCorpo(m.body), anexos });
  return createHash('sha256').update(base).digest('hex');
}

/** Ordena cronologicamente (receivedDateTime, desempate por id) e devolve a PRIMEIRA. */
export function primeiraMensagem<T extends { id: string; receivedDateTime: string }>(msgs: T[]): T | null {
  const ord = [...msgs].sort((a, b) => {
    const ta = Date.parse(a.receivedDateTime), tb = Date.parse(b.receivedDateTime);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ord[0] ?? null;
}

/** Alcance consolidado: um valor por MBL/processo inteiro e exceções por contêiner. */
export interface Consolidacao {
  /** Valor do nível MBL/processo (sem contêiner específico), ou null. */
  nivelMbl: OcorrenciaFreeTime | null;
  /** Exceções por contêiner (ISO 6346) → ocorrência. */
  porContainer: Map<string, OcorrenciaFreeTime>;
  problemas: ProblemaExtracao[];
}

/**
 * Consolida as ocorrências aceitas (corpo + anexos). Valores DISTINTOS no mesmo
 * alcance → ambíguo (pendência, nada promovido naquele alcance). Valores iguais
 * vindos de fontes diferentes se corroboram: prevalece o corpo (determinístico).
 */
export function consolidarOcorrencias(ocorrencias: OcorrenciaFreeTime[]): Consolidacao {
  const ordem = [...ocorrencias].sort((a, b) => (a.metodo === b.metodo ? 0 : a.metodo === 'texto' ? -1 : 1));
  const problemas: ProblemaExtracao[] = [];
  const mbl = ordem.filter((o) => o.containers.length === 0);
  let nivelMbl: OcorrenciaFreeTime | null = null;
  const valoresMbl = [...new Set(mbl.map((o) => o.valor))];
  if (valoresMbl.length === 1) nivelMbl = mbl[0];
  else if (valoresMbl.length > 1) problemas.push({ tipo: 'free_time_ambiguo', motivo: `valores_distintos_mbl:${valoresMbl.sort((a, b) => a - b).join(',')}` });

  const porNumero = new Map<string, OcorrenciaFreeTime[]>();
  for (const o of ordem) for (const n of o.containers) {
    if (!porNumero.has(n)) porNumero.set(n, []);
    porNumero.get(n)!.push(o);
  }
  const porContainer = new Map<string, OcorrenciaFreeTime>();
  for (const [n, lista] of [...porNumero.entries()].sort()) {
    const vals = [...new Set(lista.map((o) => o.valor))];
    if (vals.length === 1) porContainer.set(n, lista[0]);
    else problemas.push({ tipo: 'free_time_ambiguo', motivo: `valores_distintos_container:${vals.sort((a, b) => a - b).join(',')}`, containers: [n] });
  }
  return { nivelMbl, porContainer, problemas };
}
