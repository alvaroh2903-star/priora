import { Pool, PoolClient } from 'pg';
import { Db } from '../../identidade';
import { fatosDuraveisHabilitados } from '../../operacional/contexto';
import { FonteTerminal, FontesPosteriores } from './entrada';
import { ResultadoRecalculo, VERSAO_PROJECAO, ehUuid, recalcularNaTransacao, travarProcesso } from './projecao';

/**
 * G-3c — reconstrução controlada das projeções anteriores ao motor oficial (L1b).
 *
 * Fila durável (`liberacao_reconstrucoes`), em lotes, retomável e isolada por organização:
 *  - só entram projeções de versão anterior à oficial (ou um pedido explícito de uma pessoa ADMIN);
 *  - posse com dono, token e expiração; a finalização é cercada pelo token (quem perdeu a posse não grava);
 *  - posse expirada é recuperada por outro trabalhador; tentativas limitadas, esgotamento visível;
 *  - a finalização trava o processo com o MESMO bloqueio do recálculo normal, recarrega os fatos depois do
 *    bloqueio e roda o adaptador oficial (`projecao.ts`); projeção e estado do item na MESMA transação;
 *  - nenhum serviço externo é chamado e nada é inventado: as fontes não integradas continuam NAO_INTEGRADA.
 * Um LIBERADO legado nunca é copiado: a reavaliação decide e a divergência vira revisão (`revisoes.ts`).
 */

export type EstadoReconstrucao = 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDA' | 'ESGOTADA';
export type ResultadoReconstrucao = 'RECONSTRUIDA' | 'SEM_MUDANCA_MATERIAL' | 'JA_ATUAL' | 'PROCESSO_NAO_ENCONTRADO';
export type MotivoReconstrucao = 'PROJECAO_LEGADA' | 'PEDIDO_ADMIN';

export const RECONSTRUCAO_PADRAO = Object.freeze({
  posseMs: 5 * 60_000,
  maxTentativas: 5,
  backoffMs: 60_000,
  enfileirarPorChamada: 500,
  descobertaPorTick: 100,
  limitePorTick: 25,
  intervaloMs: 5 * 60_000,
});

/** Interruptor próprio da reconstrução (só ela): ligada apenas com `PRIORA_LIBERACAO_RECONSTRUCAO=on`. */
export function reconstrucaoHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PRIORA_LIBERACAO_RECONSTRUCAO ?? '').trim().toLowerCase() === 'on';
}

export interface ItemReivindicado {
  id: string;
  organizationId: string;
  processoId: string;
  motivo: MotivoReconstrucao;
  dono: string;
  token: string;
  tentativas: number;
  maxTentativas: number;
}

/** Portas de teste (fontes simuladas em memória). Em produção: nenhuma — o mesmo padrão do recálculo normal. */
export interface FontesDaReconstrucao {
  terminal?: FonteTerminal;
  posteriores?: FontesPosteriores;
}

/* ------------------------------------- enfileirar ------------------------------------- */

/**
 * Projeções legadas da organização: linha atual de versão anterior à oficial, ou (sem linha atual) último evento
 * de versão anterior. Fora: processo com item ativo, ou cujo último item esgotou (só um pedido ADMIN reabre).
 */
const LEGADOS_SEM_ITEM = `
  WITH legados AS (
    SELECT a.processo_id FROM liberacao_avaliacoes a WHERE a.organization_id = $1 AND a.versao_projecao < $2
    UNION
    SELECT e.processo_id FROM liberacao_avaliacao_eventos e
     WHERE e.organization_id = $1 AND e.versao_projecao < $2
       AND NOT EXISTS (SELECT 1 FROM liberacao_avaliacoes a WHERE a.organization_id = e.organization_id AND a.processo_id = e.processo_id)
       AND e.sequencia = (SELECT max(x.sequencia) FROM liberacao_avaliacao_eventos x
                           WHERE x.organization_id = e.organization_id AND x.processo_id = e.processo_id)
  )
  SELECT l.processo_id FROM legados l
   WHERE COALESCE((SELECT r.situacao FROM liberacao_reconstrucoes r
                    WHERE r.organization_id = $1 AND r.processo_id = l.processo_id
                    ORDER BY r.criado_em DESC, r.id DESC LIMIT 1), 'NENHUM') IN ('NENHUM', 'CONCLUIDA')`;

export interface ResultadoEnfileirar { enfileirados: number; restantes: number }

/** Enfileira (limitado) as projeções legadas DESTA organização. Repetir sem legados é um no-op estrito. */
export async function enfileirarLegados(
  db: Db, organizationId: string, o: { limite?: number; maxTentativas?: number } = {},
): Promise<ResultadoEnfileirar> {
  const limite = Math.max(1, Math.min(o.limite ?? RECONSTRUCAO_PADRAO.enfileirarPorChamada, 1000));
  const { rows } = await db.query(
    `INSERT INTO liberacao_reconstrucoes (organization_id, processo_id, motivo, versao_alvo, max_tentativas)
     SELECT $1, s.processo_id, 'PROJECAO_LEGADA', $2, $4 FROM (${LEGADOS_SEM_ITEM} ORDER BY l.processo_id LIMIT $3) s
     ON CONFLICT (organization_id, processo_id) WHERE situacao IN ('PENDENTE', 'PROCESSANDO') DO NOTHING
     RETURNING id`,
    [organizationId, VERSAO_PROJECAO, limite, o.maxTentativas ?? RECONSTRUCAO_PADRAO.maxTentativas],
  );
  const { rows: [{ n }] } = await db.query(`SELECT count(*)::int n FROM (${LEGADOS_SEM_ITEM}) s`, [organizationId, VERSAO_PROJECAO]);
  return { enfileirados: rows.length, restantes: n };
}

/** Descoberta do agendador: organização por organização, até o limite total do tick. */
export async function descobrirLegados(db: Db, o: { limite?: number; maxTentativas?: number } = {}): Promise<number> {
  let resta = Math.max(0, o.limite ?? RECONSTRUCAO_PADRAO.descobertaPorTick);
  if (resta === 0) return 0;
  const { rows: orgs } = await db.query(
    `SELECT organization_id FROM liberacao_avaliacoes WHERE versao_projecao < $1
     UNION
     SELECT e.organization_id FROM liberacao_avaliacao_eventos e
      WHERE e.versao_projecao < $1
        AND NOT EXISTS (SELECT 1 FROM liberacao_avaliacoes a WHERE a.organization_id = e.organization_id AND a.processo_id = e.processo_id)
        AND e.sequencia = (SELECT max(x.sequencia) FROM liberacao_avaliacao_eventos x
                            WHERE x.organization_id = e.organization_id AND x.processo_id = e.processo_id)
     ORDER BY 1`, [VERSAO_PROJECAO]);
  let total = 0;
  for (const { organization_id: org } of orgs) {
    if (resta <= 0) break;
    const r = await enfileirarLegados(db, org, { limite: resta, maxTentativas: o.maxTentativas });
    total += r.enfileirados;
    resta -= r.enfileirados;
  }
  return total;
}

export type ResultadoSolicitacao =
  | { status: 'PROCESSO_NAO_ENCONTRADO' }
  | { status: 'ENFILEIRADA' | 'JA_ATIVA'; itemId: string };

/**
 * Pedido explícito de UMA pessoa ADMIN para um processo DESTA organização. Processo de outra organização é
 * indistinguível de processo inexistente.
 */
export async function solicitarReconstrucao(
  db: Db, organizationId: string, processoId: string, membershipId: string, o: { maxTentativas?: number } = {},
): Promise<ResultadoSolicitacao> {
  if (!ehUuid(processoId)) return { status: 'PROCESSO_NAO_ENCONTRADO' };
  const { rows: [proc] } = await db.query(`SELECT 1 FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId]);
  if (!proc) return { status: 'PROCESSO_NAO_ENCONTRADO' };
  const { rows: [novo] } = await db.query(
    `INSERT INTO liberacao_reconstrucoes (organization_id, processo_id, motivo, solicitado_por_membership_id, versao_alvo, max_tentativas)
     VALUES ($1, $2, 'PEDIDO_ADMIN', $3, $4, $5)
     ON CONFLICT (organization_id, processo_id) WHERE situacao IN ('PENDENTE', 'PROCESSANDO') DO NOTHING RETURNING id`,
    [organizationId, processoId, membershipId, VERSAO_PROJECAO, o.maxTentativas ?? RECONSTRUCAO_PADRAO.maxTentativas],
  );
  if (novo) return { status: 'ENFILEIRADA', itemId: novo.id };
  const { rows: [ativo] } = await db.query(
    `SELECT id FROM liberacao_reconstrucoes WHERE organization_id = $1 AND processo_id = $2 AND situacao IN ('PENDENTE', 'PROCESSANDO')`,
    [organizationId, processoId],
  );
  return { status: 'JA_ATIVA', itemId: ativo.id };
}

/* -------------------------------------- reivindicar -------------------------------------- */

const daLinhaReivindicada = (r: Record<string, any>): ItemReivindicado => ({
  id: r.id, organizationId: r.organization_id, processoId: r.processo_id, motivo: r.motivo, dono: r.dono, token: r.posse_token,
  tentativas: r.tentativas, maxTentativas: r.max_tentativas,
});

/**
 * Reivindica até `limite` itens: pendentes disponíveis e posses expiradas (recuperadas com token novo). Cada
 * reivindicação conta uma tentativa; posse expirada sem tentativas restantes esgota. SKIP LOCKED: dois
 * trabalhadores nunca recebem o mesmo item.
 */
export async function reivindicar(
  db: Db, o: { dono: string; limite?: number; posseMs?: number; organizationId?: string },
): Promise<ItemReivindicado[]> {
  const limite = Math.max(1, Math.min(o.limite ?? RECONSTRUCAO_PADRAO.limitePorTick, 100));
  const segundos = (o.posseMs ?? RECONSTRUCAO_PADRAO.posseMs) / 1000;
  const org = o.organizationId ?? null;
  await db.query(
    `UPDATE liberacao_reconstrucoes SET situacao = 'ESGOTADA', dono = NULL, posse_token = NULL, posse_expira_em = NULL,
            ultimo_erro = 'POSSE_EXPIRADA_SEM_TENTATIVAS', concluido_em = now(), atualizado_em = now()
      WHERE id IN (SELECT id FROM liberacao_reconstrucoes
                    WHERE situacao = 'PROCESSANDO' AND posse_expira_em < now() AND tentativas >= max_tentativas
                      AND ($1::uuid IS NULL OR organization_id = $1)
                    FOR UPDATE SKIP LOCKED)`, [org]);
  const { rows } = await db.query(
    `UPDATE liberacao_reconstrucoes r
        SET situacao = 'PROCESSANDO', dono = $1, posse_token = gen_random_uuid(),
            posse_expira_em = now() + make_interval(secs => $2), tentativas = r.tentativas + 1, atualizado_em = now()
      WHERE r.id IN (SELECT id FROM liberacao_reconstrucoes
                      WHERE ((situacao = 'PENDENTE' AND disponivel_em <= now())
                             OR (situacao = 'PROCESSANDO' AND posse_expira_em < now() AND tentativas < max_tentativas))
                        AND ($4::uuid IS NULL OR organization_id = $4)
                      ORDER BY disponivel_em, criado_em, id
                      FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING r.*`,
    [o.dono, segundos, limite, org],
  );
  return rows.map(daLinhaReivindicada);
}

/* --------------------------------------- finalizar --------------------------------------- */

export type DesfechoItem =
  | { status: 'CONCLUIDA'; resultado: ResultadoReconstrucao }
  | { status: 'JA_CONCLUIDA' }
  | { status: 'POSSE_PERDIDA' }
  | { status: 'FALHOU'; estado: 'PENDENTE' | 'ESGOTADA' };

/** Erro saneado para a fila e os logs: o nome e uma mensagem curta sem e-mails, UUIDs nem números longos. */
export function erroSaneado(e: unknown): string {
  const nome = e instanceof Error ? e.name : 'Erro';
  const msg = (e instanceof Error ? e.message : String(e))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/\d{5,}/g, '[n]');
  return `${nome}: ${msg}`.slice(0, 200);
}

const resultadoDe = (r: ResultadoRecalculo): { resultado: ResultadoReconstrucao; sequencia: number | null } => {
  switch (r.status) {
    case 'PRIMEIRA_AVALIACAO': case 'MUDANCA_MATERIAL': return { resultado: 'RECONSTRUIDA', sequencia: r.evento.sequencia };
    case 'SEM_MUDANCA_MATERIAL': return { resultado: 'SEM_MUDANCA_MATERIAL', sequencia: r.projecao.sequencia };
    case 'TERMINAL_PRESERVADO': return { resultado: 'JA_ATUAL', sequencia: r.projecao.sequencia };
    default: return { resultado: 'PROCESSO_NAO_ENCONTRADO', sequencia: null };
  }
};

/** A projeção do processo ainda é anterior à versão oficial? (lido DEPOIS do bloqueio do processo) */
async function aindaLegada(c: PoolClient, organizationId: string, processoId: string): Promise<boolean> {
  const { rows: [x] } = await c.query(
    `SELECT (SELECT versao_projecao FROM liberacao_avaliacoes WHERE organization_id = $1 AND processo_id = $2) AS atual,
            (SELECT versao_projecao FROM liberacao_avaliacao_eventos WHERE organization_id = $1 AND processo_id = $2
              ORDER BY sequencia DESC LIMIT 1) AS ultimo`, [organizationId, processoId]);
  return x.atual !== null ? x.atual < VERSAO_PROJECAO : x.ultimo !== null && x.ultimo < VERSAO_PROJECAO;
}

/**
 * Finaliza UM item reivindicado. Concluído → no-op estrito (nenhuma escrita). Token diferente → posse perdida
 * (registrada; nada gravado). Dono → trava o processo, recarrega os fatos e reconstrói pelo adaptador oficial,
 * gravando projeção e estado do item na mesma transação. Erro → retentável (ou esgotado), cercado pelo token.
 */
export async function processarItem(
  pool: Pool, item: ItemReivindicado, o: FontesDaReconstrucao & { backoffMs?: number } = {},
): Promise<DesfechoItem> {
  const { rows: [antes] } = await pool.query(`SELECT situacao FROM liberacao_reconstrucoes WHERE id = $1 AND organization_id = $2`,
    [item.id, item.organizationId]);
  if (!antes || antes.situacao === 'CONCLUIDA') return { status: 'JA_CONCLUIDA' };

  const c = await pool.connect();
  let falha: unknown = null;
  try {
    await c.query('BEGIN');
    const { rows: [r] } = await c.query(
      `SELECT * FROM liberacao_reconstrucoes WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [item.id, item.organizationId]);
    if (r.situacao === 'CONCLUIDA') { await c.query('ROLLBACK'); return { status: 'JA_CONCLUIDA' }; }
    if (r.situacao !== 'PROCESSANDO' || r.posse_token !== item.token) {
      await c.query('ROLLBACK');
      await pool.query(`INSERT INTO liberacao_reconstrucao_posses_perdidas (organization_id, reconstrucao_id, dono) VALUES ($1, $2, $3)`,
        [item.organizationId, item.id, item.dono]);
      return { status: 'POSSE_PERDIDA' };
    }
    // O MESMO bloqueio do recálculo normal; tudo o que decide é lido depois dele.
    await travarProcesso(c, item.organizationId, item.processoId);
    let desfecho: { resultado: ResultadoReconstrucao; sequencia: number | null };
    if (r.motivo === 'PROJECAO_LEGADA' && !(await aindaLegada(c, item.organizationId, item.processoId))) {
      desfecho = { resultado: 'JA_ATUAL', sequencia: null };
    } else {
      desfecho = resultadoDe(await recalcularNaTransacao(c, item.organizationId, item.processoId, {
        gatilho: 'RECONSTRUCAO', terminal: o.terminal, posteriores: o.posteriores,
      }));
    }
    await c.query(
      `UPDATE liberacao_reconstrucoes SET situacao = 'CONCLUIDA', resultado = $3, evento_sequencia = $4, concluido_em = now(),
              dono = NULL, posse_token = NULL, posse_expira_em = NULL, ultimo_erro = NULL, atualizado_em = now()
        WHERE id = $1 AND posse_token = $2`,
      [item.id, item.token, desfecho.resultado, desfecho.sequencia]);
    await c.query('COMMIT');
    return { status: 'CONCLUIDA', resultado: desfecho.resultado };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    falha = e;
  } finally {
    c.release();
  }
  const backoff = (o.backoffMs ?? RECONSTRUCAO_PADRAO.backoffMs) * 2 ** Math.max(0, item.tentativas - 1) / 1000;
  const { rows: [depois] } = await pool.query(
    `UPDATE liberacao_reconstrucoes
        SET situacao = CASE WHEN tentativas >= max_tentativas THEN 'ESGOTADA' ELSE 'PENDENTE' END,
            concluido_em = CASE WHEN tentativas >= max_tentativas THEN now() ELSE NULL END,
            disponivel_em = now() + make_interval(secs => $3), ultimo_erro = $4,
            dono = NULL, posse_token = NULL, posse_expira_em = NULL, atualizado_em = now()
      WHERE id = $1 AND posse_token = $2 AND situacao = 'PROCESSANDO'
      RETURNING situacao`,
    [item.id, item.token, Math.min(backoff, 6 * 3600), erroSaneado(falha)]);
  if (!depois) {
    await pool.query(`INSERT INTO liberacao_reconstrucao_posses_perdidas (organization_id, reconstrucao_id, dono) VALUES ($1, $2, $3)`,
      [item.organizationId, item.id, item.dono]);
    return { status: 'POSSE_PERDIDA' };
  }
  return { status: 'FALHOU', estado: depois.situacao };
}

/* --------------------------------------- lote e tick --------------------------------------- */

export interface ContadoresLote {
  reivindicados: number;
  concluidos: number;
  jaAtuais: number;
  falhas: number;
  esgotados: number;
  possesPerdidas: number;
}

/** Um lote limitado. Um item que falha não impede os outros (cada um na sua transação). */
export async function processarLote(
  pool: Pool, o: FontesDaReconstrucao & { dono: string; limite?: number; posseMs?: number; organizationId?: string; backoffMs?: number },
): Promise<ContadoresLote> {
  const cont: ContadoresLote = { reivindicados: 0, concluidos: 0, jaAtuais: 0, falhas: 0, esgotados: 0, possesPerdidas: 0 };
  const itens = await reivindicar(pool, o);
  cont.reivindicados = itens.length;
  for (const item of itens) {
    let d: DesfechoItem;
    try {
      d = await processarItem(pool, item, o);
    } catch (e) {
      console.error('[liberacao-reconstrucao] item isolado falhou fora da transação:', erroSaneado(e));
      cont.falhas++;
      continue;
    }
    if (d.status === 'CONCLUIDA') { cont.concluidos++; if (d.resultado === 'JA_ATUAL') cont.jaAtuais++; }
    else if (d.status === 'FALHOU') { cont.falhas++; if (d.estado === 'ESGOTADA') cont.esgotados++; }
    else if (d.status === 'POSSE_PERDIDA') cont.possesPerdidas++;
  }
  return cont;
}

export type ResultadoPasso = { desligada: true } | ({ desligada: false; descobertos: number } & ContadoresLote);

/** Um passo do agendador: interruptor próprio, descoberta limitada e um lote limitado. */
export async function executarPassoReconstrucao(
  pool: Pool,
  o: FontesDaReconstrucao & { dono: string; habilitada?: () => boolean; limitePorTick?: number; descobertaPorTick?: number; posseMs?: number; backoffMs?: number },
): Promise<ResultadoPasso> {
  const habilitada = o.habilitada ?? (() => reconstrucaoHabilitada() && fatosDuraveisHabilitados());
  if (!habilitada()) return { desligada: true };
  const descobertos = await descobrirLegados(pool, { limite: o.descobertaPorTick ?? RECONSTRUCAO_PADRAO.descobertaPorTick });
  const lote = await processarLote(pool, { ...o, limite: o.limitePorTick ?? RECONSTRUCAO_PADRAO.limitePorTick });
  return { desligada: false, descobertos, ...lote };
}

/* ----------------------------------------- leitura ----------------------------------------- */

export interface StatusReconstrucao {
  pendentes: number;
  processando: number;
  concluidos: number;
  falhasRetentaveis: number;
  esgotados: number;
  possesPerdidas: number;
  divergenciasHistoricas: number;
  legadosSemItem: number;
}

/** Contagens DESTA organização (só leitura). */
export async function statusDaReconstrucao(db: Db, organizationId: string): Promise<StatusReconstrucao> {
  const { rows: [x] } = await db.query(
    `SELECT count(*) FILTER (WHERE situacao = 'PENDENTE' AND tentativas = 0)::int AS pendentes,
            count(*) FILTER (WHERE situacao = 'PROCESSANDO')::int AS processando,
            count(*) FILTER (WHERE situacao = 'CONCLUIDA')::int AS concluidos,
            count(*) FILTER (WHERE situacao = 'PENDENTE' AND tentativas > 0)::int AS falhas_retentaveis,
            count(*) FILTER (WHERE situacao = 'ESGOTADA')::int AS esgotados,
            (SELECT count(*)::int FROM liberacao_reconstrucao_posses_perdidas WHERE organization_id = $1) AS posses_perdidas,
            (SELECT count(*)::int FROM liberacao_revisoes WHERE organization_id = $1) AS divergencias,
            (SELECT count(*)::int FROM (${LEGADOS_SEM_ITEM}) s) AS legados
       FROM liberacao_reconstrucoes WHERE organization_id = $1`,
    [organizationId, VERSAO_PROJECAO]);
  return {
    pendentes: x.pendentes, processando: x.processando, concluidos: x.concluidos, falhasRetentaveis: x.falhas_retentaveis,
    esgotados: x.esgotados, possesPerdidas: x.posses_perdidas, divergenciasHistoricas: x.divergencias, legadosSemItem: x.legados,
  };
}

export interface ReconstrucaoDoProcesso {
  estado: EstadoReconstrucao;
  tentativas: number;
  maxTentativas: number;
  atualizadoEm: string;
}

/** O item mais recente do processo (só leitura). */
export async function reconstrucaoDoProcesso(db: Db, organizationId: string, processoId: string): Promise<ReconstrucaoDoProcesso | null> {
  const { rows: [x] } = await db.query(
    `SELECT situacao, tentativas, max_tentativas, atualizado_em FROM liberacao_reconstrucoes
      WHERE organization_id = $1 AND processo_id = $2 ORDER BY criado_em DESC, id DESC LIMIT 1`, [organizationId, processoId]);
  return x ? { estado: x.situacao, tentativas: x.tentativas, maxTentativas: x.max_tentativas, atualizadoEm: new Date(x.atualizado_em).toISOString() } : null;
}

/** Estado do item mais recente de cada processo da organização (só leitura). */
export async function estadosDaReconstrucao(db: Db, organizationId: string): Promise<Map<string, EstadoReconstrucao>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (processo_id) processo_id, situacao FROM liberacao_reconstrucoes
      WHERE organization_id = $1 ORDER BY processo_id, criado_em DESC, id DESC`, [organizationId]);
  return new Map(rows.map((x) => [x.processo_id as string, x.situacao as EstadoReconstrucao]));
}
