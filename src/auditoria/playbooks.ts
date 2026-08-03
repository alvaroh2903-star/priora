/**
 * Priora — Módulo Auditoria Documental
 * CORE + PLAYBOOKS (Blueprint Cap. 3, 4 e 6).
 *
 * O Core NÃO lê PDFs. Recebe documentos JÁ extraídos (objetos) e:
 *  1. organiza a estrutura Processo → Conhecimentos(Master/Houses) → Containers;
 *  2. executa os Playbooks (Pré-Alerta, CE Mercante) — comparações 100%
 *     DETERMINÍSTICAS (nunca IA — princípios 9.11/9.12);
 *  3. devolve EVIDÊNCIAS padronizadas com um dos 5 estados (3.10) e criticidade.
 *
 * A Clara (outra camada) só interpreta essas evidências. Aqui não há IA.
 */

export type EstadoValidacao =
  | 'Consistente'
  | 'Divergência'
  | 'Validação Humana'
  | 'Informativo'
  | 'Não Avaliado';

export type Criticidade = 'Baixa' | 'Média' | 'Alta' | 'Crítica';

export type DocTipo =
  | 'MBL'
  | 'HBL'
  | 'CE_MASTER'
  | 'CE_HOUSE'
  | 'ITEM'
  | 'OUTRO';

/** Container extraído de um documento (Cap. 3.4). */
export interface ContainerExtraido {
  numero: string | null;
  pesoBrutoKg: number | null;
  cubagemM3: number | null;
  lacre: string | null;
  ncm: string[];
  descricao: string | null;
}

/** Documento já extraído pelo OCR/Parser (camada anterior). */
export interface DocumentoExtraido {
  nome: string; // nome do arquivo (evidência de origem)
  tipo: DocTipo;
  /**
   * Tipo que o OCR *identificou pelo conteúdo* do documento (não pelo nome do
   * arquivo). Usado para reclassificar anexos com nome genérico ("doc1.pdf")
   * antes da comparação. Opcional: só a camada OCR preenche.
   */
  tipoDetectado?: DocTipo | null;
  conhecimento: string | null;
  portoOrigem: string | null;
  portoDestino: string | null;
  navio: string | null;
  shipper: string | null;
  consignee: string | null;
  notify: string | null;
  freteValor: number | null;
  freteMoeda: string | null;
  thcValor: number | null;
  cliente: string | null;
  containers: ContainerExtraido[];
  legivel: boolean; // false = documento ilegível (Cap. 6.3)
}

/** Evidência padronizada (Cap. 5.7). */
export interface Evidencia {
  campo: string;
  resultado: EstadoValidacao;
  criticidade: Criticidade;
  container: string | null;
  documentos: string[];
  valores: Array<{ doc: string; valor: string }>;
  motivo: string;
  playbook: string;
}

export interface ResultadoAuditoria {
  playbooksExecutados: string[];
  evidencias: Evidencia[];
  documentosAusentes: string[];
  resumo: {
    total: number;
    consistentes: number;
    divergencias: number;
    validacoesHumanas: number;
    naoAvaliados: number;
    informativos: number;
  };
  status:
    | 'Concluída sem pendências'
    | 'Concluída com divergências'
    | 'Aguardando validação humana'
    | 'Auditoria parcial';
}

/* ------------------------------------------------------------------ *
 * Normalização e comparadores determinísticos
 * ------------------------------------------------------------------ */

function norm(s: string | null): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}
/** Só alfanumérico maiúsculo — para códigos (container, lacre). */
function normCode(s: string | null): string {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const ORDEM_ESTADO: Record<EstadoValidacao, number> = {
  Divergência: 0,
  'Validação Humana': 1,
  'Não Avaliado': 2,
  Consistente: 3,
  Informativo: 4,
};
const ORDEM_CRIT: Record<Criticidade, number> = {
  Crítica: 0,
  Alta: 1,
  Média: 2,
  Baixa: 3,
};

/** Compara TEXTO. Ausente em algum lado → Não Avaliado (Cap. 6.7). */
function cmpTexto(
  campo: string,
  crit: Criticidade,
  a: string | null,
  b: string | null,
  docs: [string, string],
  playbook: string,
  container: string | null = null,
): Evidencia {
  const va = a == null || a === '' ? null : String(a);
  const vb = b == null || b === '' ? null : String(b);
  const valores = [
    { doc: docs[0], valor: va ?? '—' },
    { doc: docs[1], valor: vb ?? '—' },
  ];
  if (va == null || vb == null) {
    return {
      campo,
      resultado: 'Não Avaliado',
      criticidade: crit,
      container,
      documentos: docs,
      valores,
      motivo: `Campo ausente em ${va == null ? docs[0] : docs[1]}.`,
      playbook,
    };
  }
  const igual = norm(va) === norm(vb);
  return {
    campo,
    resultado: igual ? 'Consistente' : 'Divergência',
    criticidade: crit,
    container,
    documentos: docs,
    valores,
    motivo: igual
      ? `${campo} coincide entre ${docs[0]} e ${docs[1]}.`
      : `${campo} difere: ${docs[0]} informa "${va}" e ${docs[1]} informa "${vb}".`,
    playbook,
  };
}

/** Compara CÓDIGO (container/lacre) — igualdade estrita alfanumérica. */
function cmpCodigo(
  campo: string,
  crit: Criticidade,
  a: string | null,
  b: string | null,
  docs: [string, string],
  playbook: string,
  container: string | null = null,
): Evidencia {
  const ev = cmpTexto(campo, crit, a, b, docs, playbook, container);
  if (ev.resultado === 'Não Avaliado') return ev;
  const igual = normCode(a) === normCode(b);
  ev.resultado = igual ? 'Consistente' : 'Divergência';
  ev.motivo = igual
    ? `${campo} confere.`
    : `${campo} divergente: ${docs[0]}=${a} × ${docs[1]}=${b}.`;
  return ev;
}

/** Compara NÚMERO com tolerância relativa (peso/cubagem). */
function cmpNumero(
  campo: string,
  crit: Criticidade,
  a: number | null,
  b: number | null,
  unidade: string,
  tolPct: number,
  docs: [string, string],
  playbook: string,
  container: string | null = null,
): Evidencia {
  const valores = [
    { doc: docs[0], valor: a == null ? '—' : `${a} ${unidade}`.trim() },
    { doc: docs[1], valor: b == null ? '—' : `${b} ${unidade}`.trim() },
  ];
  if (a == null || b == null) {
    return {
      campo,
      resultado: 'Não Avaliado',
      criticidade: crit,
      container,
      documentos: docs,
      valores,
      motivo: `Campo ausente em ${a == null ? docs[0] : docs[1]}.`,
      playbook,
    };
  }
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  const difPct = Math.abs(a - b) / base;
  const igual = difPct <= tolPct;
  return {
    campo,
    resultado: igual ? 'Consistente' : 'Divergência',
    criticidade: crit,
    container,
    documentos: docs,
    valores,
    motivo: igual
      ? `${campo} coincide (${a} ≈ ${b} ${unidade}).`
      : `${campo} difere: ${docs[0]}=${a} ${unidade} × ${docs[1]}=${b} ${unidade}.`,
    playbook,
  };
}

/** Campo que SEMPRE exige o analista (frete/THC) — Cap. 4.4/6.7. */
function humano(
  campo: string,
  crit: Criticidade,
  a: string | null,
  b: string | null,
  docs: [string, string],
  playbook: string,
): Evidencia {
  return {
    campo,
    resultado: 'Validação Humana',
    criticidade: crit,
    container: null,
    documentos: docs,
    valores: [
      { doc: docs[0], valor: a ?? '—' },
      { doc: docs[1], valor: b ?? '—' },
    ],
    motivo: `${campo} depende de validação humana — a Priora apresenta os valores, o analista confere.`,
    playbook,
  };
}

/* ------------------------------------------------------------------ *
 * Playbook: Pré-Alerta (MBL × HBL)
 * ------------------------------------------------------------------ */

function paresContainers(
  a: ContainerExtraido[],
  b: ContainerExtraido[],
): Array<{ numero: string | null; ca: ContainerExtraido | null; cb: ContainerExtraido | null }> {
  const idx = new Map<string, ContainerExtraido>();
  for (const c of b) if (c.numero) idx.set(normCode(c.numero), c);
  const out: Array<{ numero: string | null; ca: ContainerExtraido | null; cb: ContainerExtraido | null }> = [];
  const usados = new Set<string>();
  for (const c of a) {
    const k = c.numero ? normCode(c.numero) : '';
    const match = k ? idx.get(k) || null : null;
    if (match) usados.add(k);
    out.push({ numero: c.numero, ca: c, cb: match });
  }
  for (const c of b) {
    const k = c.numero ? normCode(c.numero) : '';
    if (k && !usados.has(k)) out.push({ numero: c.numero, ca: null, cb: c });
  }
  return out;
}

function playbookComparaBLs(
  master: DocumentoExtraido,
  house: DocumentoExtraido,
  nomes: [string, string],
  playbook: string,
): Evidencia[] {
  const ev: Evidencia[] = [];
  // Campos do conhecimento (Cap. 4.4 — automáticos)
  ev.push(cmpTexto('Porto de Origem', 'Alta', master.portoOrigem, house.portoOrigem, nomes, playbook));
  ev.push(cmpTexto('Porto de Destino', 'Alta', master.portoDestino, house.portoDestino, nomes, playbook));
  ev.push(cmpTexto('Navio', 'Média', master.navio, house.navio, nomes, playbook));
  // Frete e THC — validação humana (nunca conclui, Cap. 7.10)
  ev.push(
    humano(
      'Frete Básico',
      'Alta',
      master.freteValor != null ? `${master.freteMoeda || ''} ${master.freteValor}`.trim() : null,
      house.freteValor != null ? `${house.freteMoeda || ''} ${house.freteValor}`.trim() : null,
      nomes,
      playbook,
    ),
  );
  if (master.thcValor != null || house.thcValor != null) {
    ev.push(
      humano(
        'THC',
        'Média',
        master.thcValor != null ? String(master.thcValor) : null,
        house.thcValor != null ? String(house.thcValor) : null,
        nomes,
        playbook,
      ),
    );
  }
  // Por container: peso, cubagem, lacre, NCM (automáticos)
  for (const { numero, ca, cb } of paresContainers(master.containers, house.containers)) {
    if (!ca || !cb) {
      ev.push({
        campo: 'Container',
        resultado: 'Não Avaliado',
        criticidade: 'Crítica',
        container: numero,
        documentos: nomes,
        valores: [
          { doc: nomes[0], valor: ca ? ca.numero || '—' : '—' },
          { doc: nomes[1], valor: cb ? cb.numero || '—' : '—' },
        ],
        motivo: `Container ${numero || '(sem número)'} aparece só em ${ca ? nomes[0] : nomes[1]}.`,
        playbook,
      });
      continue;
    }
    ev.push(cmpNumero('Peso Bruto', 'Alta', ca.pesoBrutoKg, cb.pesoBrutoKg, 'kg', 0.01, nomes, playbook, numero));
    ev.push(cmpNumero('Cubagem', 'Média', ca.cubagemM3, cb.cubagemM3, 'm³', 0.02, nomes, playbook, numero));
    ev.push(cmpCodigo('Lacre', 'Crítica', ca.lacre, cb.lacre, nomes, playbook, numero));
    ev.push(
      cmpTexto('NCM', 'Média', ca.ncm.join(', ') || null, cb.ncm.join(', ') || null, nomes, playbook, numero),
    );
    // Descrição — informativo (Cap. 4.4)
    ev.push({
      campo: 'Descrição da mercadoria',
      resultado: 'Informativo',
      criticidade: 'Baixa',
      container: numero,
      documentos: nomes,
      valores: [
        { doc: nomes[0], valor: ca.descricao || '—' },
        { doc: nomes[1], valor: cb.descricao || '—' },
      ],
      motivo: 'Descrição exibida apenas para conferência visual — não gera divergência (V1).',
      playbook,
    });
  }
  return ev;
}

/* ------------------------------------------------------------------ *
 * Motor: executa os Playbooks aplicáveis e consolida
 * ------------------------------------------------------------------ */

export function executarAuditoria(docs: DocumentoExtraido[]): ResultadoAuditoria {
  const legiveis = docs.filter((d) => d.legivel);
  const pick = (t: DocTipo) => legiveis.filter((d) => d.tipo === t);
  const mbl = pick('MBL')[0] || null;
  const hbl = pick('HBL')[0] || null;
  const ceMaster = pick('CE_MASTER')[0] || null;
  const ceHouse = pick('CE_HOUSE')[0] || null;

  const evidencias: Evidencia[] = [];
  const playbooksExecutados: string[] = [];
  const documentosAusentes: string[] = [];

  // Pré-Alerta (MBL × HBL)
  if (mbl && hbl) {
    playbooksExecutados.push('Pré-Alerta');
    evidencias.push(...playbookComparaBLs(mbl, hbl, ['MBL', 'HBL'], 'Pré-Alerta'));
  } else {
    if (!mbl) documentosAusentes.push('Master BL');
    if (!hbl) documentosAusentes.push('House BL');
  }

  // CE Mercante (CE Master × CE House)
  if (ceMaster && ceHouse) {
    playbooksExecutados.push('CE Mercante');
    evidencias.push(...playbookComparaBLs(ceMaster, ceHouse, ['CE Master', 'CE House'], 'CE Mercante'));
  } else {
    if (!ceMaster) documentosAusentes.push('CE Master');
    if (!ceHouse) documentosAusentes.push('CE House');
  }

  // Ordena por estado (divergência primeiro) e criticidade (Cap. 5.7/8.12).
  evidencias.sort(
    (a, b) =>
      ORDEM_ESTADO[a.resultado] - ORDEM_ESTADO[b.resultado] ||
      ORDEM_CRIT[a.criticidade] - ORDEM_CRIT[b.criticidade],
  );

  const resumo = {
    total: evidencias.length,
    consistentes: evidencias.filter((e) => e.resultado === 'Consistente').length,
    divergencias: evidencias.filter((e) => e.resultado === 'Divergência').length,
    validacoesHumanas: evidencias.filter((e) => e.resultado === 'Validação Humana').length,
    naoAvaliados: evidencias.filter((e) => e.resultado === 'Não Avaliado').length,
    informativos: evidencias.filter((e) => e.resultado === 'Informativo').length,
  };

  // Status (Cap. 6.6). Divergência > validação humana > parcial > sem pendências.
  let status: ResultadoAuditoria['status'];
  if (resumo.divergencias > 0) status = 'Concluída com divergências';
  else if (resumo.validacoesHumanas > 0) status = 'Aguardando validação humana';
  else if (documentosAusentes.length > 0 || resumo.naoAvaliados > 0) status = 'Auditoria parcial';
  else status = 'Concluída sem pendências';

  return { playbooksExecutados, evidencias, documentosAusentes, resumo, status };
}
