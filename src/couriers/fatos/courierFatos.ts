import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Db, limparCodigoProcesso, registrarReferenciaProcesso, resolverProcesso } from '../../identidade';
import { referenciaUnica } from '../../identidade/captura';
import { ContextoOperacional, validarContextoOperacional } from '../../operacional/contexto';
import { CourierEstado, ESTADOS_VALIDOS, trackingKey } from '../courierStore';
import { AssociacaoVerificada, ProvenienciaLinha } from './linha';

/**
 * S1 — Courier durável (H-2, H-6, N-7). Grava, append-only, só o que o
 * OPERADOR confirma: conferência de MBL / HBL original por (envelope,
 * referência exata do processo) e o estado do envelope. As regras do Courier
 * (agrupamento por tracking, vários processos por envelope, pendente antes da
 * chegada, conferência por processo depois dela, Telex fora do Courier) não
 * mudam: este módulo só torna duráveis os atos e lhes dá identidade e autoria.
 *
 * Identidade: a referência é a EXATA (limpa pelo S6); a observação vai ao S6
 * como OPERACIONAL — resolve um processo existente (código ou alias) ou abre
 * pendência, nunca cria. A operação no S6 e a linha do fato são gravadas na
 * MESMA transação: ou as duas existem, ou nenhuma (sem evidência pendurada).
 */

export type DocumentoConferido = 'MBL' | 'HBL_ORIGINAL';
export type ValorConferencia = 'RECEBIDO' | 'AUSENTE_NA_CONFERENCIA' | 'DESMARCADO';

export type CodigoErroFatoCourier =
  | 'TRACKING_INVALIDO' | 'DOCUMENTO_INVALIDO' | 'VALOR_INVALIDO' | 'REFERENCIA_NAO_RECONHECIDA' | 'BRUTA_INCOERENTE';

export class ErroFatoCourier extends Error {
  constructor(readonly codigo: CodigoErroFatoCourier, mensagem: string) {
    super(mensagem);
    this.name = 'ErroFatoCourier';
  }
}

export type IdentidadeDoFato =
  | { tipo: 'NAO_APLICAVEL' }
  | { tipo: 'RESOLVIDA'; processoId: string; via: 'CODIGO' | 'ALIAS' }
  | { tipo: 'PENDENTE'; pendenciaId: string; motivo: string };

export type ResultadoFatoCourier =
  | { status: 'REGISTRADO'; fatoId: string; sequencia: number; valorAnterior: string | null; identidade: IdentidadeDoFato }
  | { status: 'SEM_MUDANCA'; fatoId: string | null; sequencia: number | null };

export interface EntradaConferencia {
  trackingBruto: string;
  /** Código da linha como a tela o enviou (precisa ser exatamente UMA referência capturável). */
  processoRef: string;
  documento: DocumentoConferido;
  valor: ValorConferencia;
  /** Determinada pelo servidor (`verificarLinha`), nunca pelo corpo da requisição. */
  proveniencia: ProvenienciaLinha;
}

const DOCUMENTOS: DocumentoConferido[] = ['MBL', 'HBL_ORIGINAL'];
const VALORES: ValorConferencia[] = ['RECEBIDO', 'AUSENTE_NA_CONFERENCIA', 'DESMARCADO'];
/** Estados do envelope em que o operador já confirmou a chegada física. */
export const ESTADOS_RECEBIDOS: CourierEstado[] = ['Recebido', 'Em Conferência', 'Divergência', 'Concluído'];

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (erro) {
    await c.query('ROLLBACK');
    throw erro;
  } finally {
    c.release();
  }
}

const travarAssunto = (c: PoolClient, chave: string) =>
  c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [chave]);

function chaveDoTracking(bruto: string): string {
  const chave = trackingKey(bruto);
  if (!chave) throw new ErroFatoCourier('TRACKING_INVALIDO', 'tracking vazio');
  return chave;
}

/** Registra uma conferência (ou a retração dela). Idempotente: o mesmo estado não grava nada. */
export async function registrarConferenciaCourier(
  pool: Pool, ctx: ContextoOperacional, e: EntradaConferencia,
): Promise<ResultadoFatoCourier> {
  const trackingChave = chaveDoTracking(e.trackingBruto);
  if (!DOCUMENTOS.includes(e.documento)) throw new ErroFatoCourier('DOCUMENTO_INVALIDO', `documento inválido: ${e.documento}`);
  if (!VALORES.includes(e.valor)) throw new ErroFatoCourier('VALOR_INVALIDO', `valor inválido: ${e.valor}`);
  const linha = referenciaUnica(e.processoRef);
  if (!linha) throw new ErroFatoCourier('REFERENCIA_NAO_RECONHECIDA', `referência de processo não reconhecida: ${e.processoRef}`);
  const processoRef = linha.limpa;
  const brutas = Array.from(new Set(e.proveniencia.brutas));
  if (brutas.some((b) => limparCodigoProcesso(b) !== processoRef)) {
    throw new ErroFatoCourier('BRUTA_INCOERENTE', 'forma bruta não corresponde à referência da linha');
  }
  const processoRefBruta = brutas[0] ?? linha.bruta;
  const associacao: AssociacaoVerificada = e.proveniencia.associacao;
  const oficial = associacao === 'CITADA';

  return emTransacao(pool, async (c) => {
    await validarContextoOperacional(c, ctx);
    await travarAssunto(c, `s1:${ctx.organizationId}:${trackingChave}:CONFERENCIA_DOCUMENTO:${e.documento}:${processoRef}`);
    const { rows: [ultima] } = await c.query(
      `SELECT id, sequencia, valor, associacao FROM courier_fatos
        WHERE organization_id = $1 AND tracking_chave = $2 AND tipo = 'CONFERENCIA_DOCUMENTO' AND documento = $3 AND processo_ref = $4
        ORDER BY sequencia DESC LIMIT 1`,
      [ctx.organizationId, trackingChave, e.documento, processoRef],
    );
    // N-16a: o mesmo estado não é mudança. Só a mesma marca com proveniência agora oficial vira linha nova.
    if (ultima && ultima.valor === e.valor && !(oficial && ultima.associacao !== 'CITADA')) {
      return { status: 'SEM_MUDANCA', fatoId: ultima.id, sequencia: ultima.sequencia };
    }
    if (!ultima && e.valor === 'DESMARCADO') return { status: 'SEM_MUDANCA', fatoId: null, sequencia: null };

    const { rows: [{ agora }] } = await c.query(`SELECT now() AS agora`);
    const id = randomUUID();
    let identidade: IdentidadeDoFato = { tipo: 'NAO_APLICAVEL' };
    if (e.valor !== 'DESMARCADO') {
      const r = await registrarReferenciaProcesso(c, ctx.organizationId, processoRefBruta, {
        tipo: 'OPERACIONAL', fonte: 'courier_conferencia', evidenciaRef: `courier_fato:${id}`, observadoEm: agora,
      });
      if (r.status === 'RESOLVIDO') {
        if (r.via === 'CRIADO') throw new Error('invariante: observação OPERACIONAL não pode criar processo');
        identidade = { tipo: 'RESOLVIDA', processoId: r.processoId, via: r.via };
      } else {
        identidade = { tipo: 'PENDENTE', pendenciaId: r.pendenciaId, motivo: r.motivo };
      }
    }
    const sequencia = (ultima?.sequencia ?? 0) + 1;
    await c.query(
      `INSERT INTO courier_fatos
         (id, organization_id, caixa_id, tracking_bruto, tracking_chave, tipo, documento, processo_ref_bruta, processo_ref,
          referencias_brutas, associacao, linha_emitida_em, valor, valor_anterior, sequencia, processo_id, identidade_pendencia_id,
          autor_membership_id, registrado_em)
       VALUES ($1, $2, $3, $4, $5, 'CONFERENCIA_DOCUMENTO', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, ctx.organizationId, ctx.caixaId, e.trackingBruto, trackingChave, e.documento, processoRefBruta, processoRef,
        brutas, associacao, e.proveniencia.emitidaEm, e.valor, ultima?.valor ?? null, sequencia,
        identidade.tipo === 'RESOLVIDA' ? identidade.processoId : null,
        identidade.tipo === 'PENDENTE' ? identidade.pendenciaId : null,
        ctx.membershipId, agora],
    );
    return { status: 'REGISTRADO', fatoId: id, sequencia, valorAnterior: ultima?.valor ?? null, identidade };
  });
}

/** Estado do envelope confirmado pelo operador (Recebido, Em Conferência, …). Idempotente. */
export async function registrarEstadoEnvelope(
  pool: Pool, ctx: ContextoOperacional, e: { trackingBruto: string; estado: CourierEstado; nota?: string | null },
): Promise<ResultadoFatoCourier> {
  const trackingChave = chaveDoTracking(e.trackingBruto);
  if (!ESTADOS_VALIDOS.includes(e.estado)) throw new ErroFatoCourier('VALOR_INVALIDO', `estado inválido: ${e.estado}`);
  const nota = String(e.nota ?? '').trim() || null;
  return emTransacao(pool, async (c) => {
    await validarContextoOperacional(c, ctx);
    await travarAssunto(c, `s1:${ctx.organizationId}:${trackingChave}:ESTADO_ENVELOPE`);
    const { rows: [ultima] } = await c.query(
      `SELECT id, sequencia, valor, nota FROM courier_fatos
        WHERE organization_id = $1 AND tracking_chave = $2 AND tipo = 'ESTADO_ENVELOPE'
        ORDER BY sequencia DESC LIMIT 1`,
      [ctx.organizationId, trackingChave],
    );
    if (ultima && ultima.valor === e.estado && (ultima.nota ?? null) === nota) {
      return { status: 'SEM_MUDANCA', fatoId: ultima.id, sequencia: ultima.sequencia };
    }
    const sequencia = (ultima?.sequencia ?? 0) + 1;
    const { rows: [ins] } = await c.query(
      `INSERT INTO courier_fatos
         (organization_id, caixa_id, tracking_bruto, tracking_chave, tipo, valor, valor_anterior, nota, sequencia, autor_membership_id)
       VALUES ($1, $2, $3, $4, 'ESTADO_ENVELOPE', $5, $6, $7, $8, $9) RETURNING id`,
      [ctx.organizationId, ctx.caixaId, e.trackingBruto, trackingChave, e.estado, ultima?.valor ?? null, nota, sequencia, ctx.membershipId],
    );
    return { status: 'REGISTRADO', fatoId: ins.id, sequencia, valorAnterior: ultima?.valor ?? null, identidade: { tipo: 'NAO_APLICAVEL' } };
  });
}

/* ------------------------------------------------------------------ *
 * Leitura para a tela do Courier (reapresentação depois da troca de conta)
 * ------------------------------------------------------------------ */

export type MarcaTela = 'recebido' | 'nao_recebido';
export interface ProjecaoCourierTela {
  estados: Record<string, { estado: CourierEstado; nota?: string; updatedAt: string }>;
  /** tracking → código da linha → documento → marca atual (null = desmarcado). */
  conferencias: Record<string, Record<string, Partial<Record<'mbl' | 'hbl', MarcaTela | null>>>>;
}

const MARCA: Record<string, MarcaTela | null> = { RECEBIDO: 'recebido', AUSENTE_NA_CONFERENCIA: 'nao_recebido', DESMARCADO: null };
const CHAVE_DOC: Record<DocumentoConferido, 'mbl' | 'hbl'> = { MBL: 'mbl', HBL_ORIGINAL: 'hbl' };

/** Estado atual (última linha de cada assunto) dos envelopes pedidos, na organização. Só leitura. */
export async function projecaoCourierParaTela(db: Db, organizationId: string, trackingChaves: string[]): Promise<ProjecaoCourierTela> {
  const out: ProjecaoCourierTela = { estados: {}, conferencias: {} };
  if (trackingChaves.length === 0) return out;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (tracking_chave, tipo, documento, processo_ref)
            tracking_chave, tipo, documento, processo_ref, valor, nota, registrado_em
       FROM courier_fatos
      WHERE organization_id = $1 AND tracking_chave = ANY($2::text[])
      ORDER BY tracking_chave, tipo, documento, processo_ref, sequencia DESC`,
    [organizationId, trackingChaves],
  );
  for (const r of rows) {
    if (r.tipo === 'ESTADO_ENVELOPE') {
      out.estados[r.tracking_chave] = {
        estado: r.valor, ...(r.nota ? { nota: r.nota } : {}), updatedAt: new Date(r.registrado_em).toISOString(),
      };
    } else {
      const porProc = (out.conferencias[r.tracking_chave] ??= {});
      (porProc[r.processo_ref] ??= {})[CHAVE_DOC[r.documento as DocumentoConferido]] = MARCA[r.valor];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Contrato de saída por processo (consumido depois pela Liberação; sem cópia)
 * ------------------------------------------------------------------ */

export interface FatoConferenciaCourier {
  valor: 'RECEBIDO' | 'AUSENTE_NA_CONFERENCIA';
  vigenteDesde: Date;
  trackingChave: string;
  autorMembershipId: string;
  evidencia: { fonte: 'courier'; ref: string };
}

export interface EnvelopeDoProcesso {
  trackingChave: string;
  estado: CourierEstado | null;
  recebido: boolean;
  desde: Date | null;
}

export interface FatoNaoPublicado {
  fatoId: string;
  trackingChave: string;
  documento: DocumentoConferido;
  valor: ValorConferencia;
  associacao: AssociacaoVerificada;
  motivo: 'PROVENIENCIA_NAO_OFICIAL';
}

export interface FatosCourierDoProcesso {
  processoId: string;
  mbl: FatoConferenciaCourier | null;
  hblOriginal: FatoConferenciaCourier | null;
  /** Envelopes com conferência oficial deste processo e o estado confirmado de cada um. */
  envelopes: EnvelopeDoProcesso[];
  /** Marcas preservadas como evidência, sem efeito de fato oficial (linha inferida, ambígua, Clara ou não verificada). */
  naoPublicados: FatoNaoPublicado[];
}

/**
 * Fatos oficiais do Courier para UM processo. A identidade é resolvida AGORA
 * pelo S6 (código exato ou alias vigente): uma pendência resolvida depois passa
 * a valer sem regravar nada; um alias invalidado deixa de valer. Por documento,
 * vale a última marca de cada envelope; recebido em algum envelope prevalece
 * sobre ausente em outro. Só linhas CITADA publicam.
 */
export async function fatosCourierDoProcesso(db: Db, organizationId: string, processoId: string): Promise<FatosCourierDoProcesso> {
  const out: FatosCourierDoProcesso = { processoId, mbl: null, hblOriginal: null, envelopes: [], naoPublicados: [] };
  const { rows: refs } = await db.query(
    `SELECT numero_processo AS ref FROM processos WHERE id = $1 AND organization_id = $2 AND numero_processo IS NOT NULL
     UNION SELECT referencia FROM processo_referencias WHERE processo_id = $1 AND organization_id = $2`,
    [processoId, organizationId],
  );
  const candidatas: string[] = [];
  for (const { ref } of refs) {
    const r = await resolverProcesso(db, organizationId, ref);
    if (r.status === 'RESOLVIDO' && r.processoId === processoId) candidatas.push(ref);
  }
  if (candidatas.length === 0) return out;

  const { rows } = await db.query(
    `SELECT DISTINCT ON (tracking_chave, documento, processo_ref)
            id, tracking_chave, documento, processo_ref, valor, associacao, autor_membership_id, registrado_em
       FROM courier_fatos
      WHERE organization_id = $1 AND tipo = 'CONFERENCIA_DOCUMENTO' AND processo_ref = ANY($2::text[])
      ORDER BY tracking_chave, documento, processo_ref, sequencia DESC`,
    [organizationId, candidatas],
  );
  const oficiais: Record<DocumentoConferido, FatoConferenciaCourier[]> = { MBL: [], HBL_ORIGINAL: [] };
  const trackings = new Set<string>();
  for (const r of rows) {
    if (r.valor === 'DESMARCADO') continue;
    if (r.associacao !== 'CITADA') {
      out.naoPublicados.push({
        fatoId: r.id, trackingChave: r.tracking_chave, documento: r.documento, valor: r.valor, associacao: r.associacao,
        motivo: 'PROVENIENCIA_NAO_OFICIAL',
      });
      continue;
    }
    trackings.add(r.tracking_chave);
    oficiais[r.documento as DocumentoConferido].push({
      valor: r.valor, vigenteDesde: new Date(r.registrado_em), trackingChave: r.tracking_chave,
      autorMembershipId: r.autor_membership_id, evidencia: { fonte: 'courier', ref: `courier_fato:${r.id}` },
    });
  }
  const consolidar = (fatos: FatoConferenciaCourier[]): FatoConferenciaCourier | null => {
    const recebidos = fatos.filter((f) => f.valor === 'RECEBIDO');
    const escolha = recebidos.length ? recebidos : fatos;
    return escolha.sort((a, b) => a.vigenteDesde.getTime() - b.vigenteDesde.getTime())[0] ?? null;
  };
  out.mbl = consolidar(oficiais.MBL);
  out.hblOriginal = consolidar(oficiais.HBL_ORIGINAL);

  if (trackings.size) {
    const { rows: estados } = await db.query(
      `SELECT DISTINCT ON (tracking_chave) tracking_chave, valor, registrado_em FROM courier_fatos
        WHERE organization_id = $1 AND tipo = 'ESTADO_ENVELOPE' AND tracking_chave = ANY($2::text[])
        ORDER BY tracking_chave, sequencia DESC`,
      [organizationId, [...trackings]],
    );
    const porTracking = new Map(estados.map((r) => [r.tracking_chave, r]));
    out.envelopes = [...trackings].sort().map((t) => {
      const r = porTracking.get(t);
      return {
        trackingChave: t, estado: r?.valor ?? null, recebido: !!r && ESTADOS_RECEBIDOS.includes(r.valor),
        desde: r ? new Date(r.registrado_em) : null,
      };
    });
  }
  return out;
}
