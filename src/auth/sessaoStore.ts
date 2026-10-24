import crypto from 'crypto';
import { Pool } from 'pg';
import session, { SessionData, Store } from 'express-session';

/**
 * Store do `express-session` em PostgreSQL (tabela `sessoes_humanas`,
 * migration 0049) — a SESSÃO HUMANA da aplicação, compartilhada entre
 * instâncias e que sobrevive a reinícios sem misturar identidades.
 *
 * - A chave é o SHA-256 do identificador da sessão: o identificador em claro
 *   (que só existe no cookie assinado do navegador) nunca é gravado no banco
 *   nem em log.
 * - Expiração no SERVIDOR, independente do cookie (nunca derivada de
 *   `cookie.expires`): `expira_em` = o menor entre agora + ociosidade e
 *   `autenticadoEm` + vida absoluta. Renovada pelo uso (touch, no máximo uma
 *   vez por `intervaloToqueMs`) só até o limite absoluto. Expirada ou revogada
 *   → `get` não devolve nada → a requisição segue sem sessão (401 nas rotas
 *   humanas).
 * - Revogar (logout, regenerate, revogação administrativa) marca a linha e
 *   apaga os dados; `set`/`touch` atrasados de uma requisição que começou
 *   antes nunca ressuscitam sessão revogada ou expirada (as duas escritas só
 *   alcançam linha viva).
 * - Nenhum token Microsoft: o login de identidade descarta os tokens.
 */

export interface OpcoesStoreSessao {
  pool: () => Pool;
  /** Ociosidade máxima (ms) entre requisições. */
  ociosidadeMs: number;
  /** Vida máxima (ms) desde o login, mesmo com uso contínuo. */
  absolutoMs: number;
  /** Intervalo mínimo (ms) entre renovações de ociosidade (`touch`) — evita um UPDATE por requisição. Padrão 60 s. */
  intervaloToqueMs?: number;
}

/** SHA-256 hex do identificador da sessão. */
export function hashSid(sid: string): string {
  return crypto.createHash('sha256').update(sid, 'utf8').digest('hex');
}

function usuarioDaSessao(sess: SessionData): string | null {
  const u = (sess as { usuarioId?: unknown }).usuarioId;
  return typeof u === 'string' && /^[0-9a-f-]{36}$/i.test(u) ? u : null;
}

function autenticadoEm(sess: SessionData): string | null {
  const a = (sess as { autenticadoEm?: unknown }).autenticadoEm;
  return typeof a === 'string' && !Number.isNaN(Date.parse(a)) ? a : null;
}

export class PgSessionStore extends Store {
  constructor(private readonly opts: OpcoesStoreSessao) {
    super();
  }

  get = (sid: string, callback: (err: unknown, session?: SessionData | null) => void): void => {
    this.opts.pool()
      .query(
        `SELECT dados FROM sessoes_humanas WHERE sid_hash = $1 AND revogada_em IS NULL AND expira_em > now()`,
        [hashSid(sid)],
      )
      .then(({ rows }) => callback(null, rows[0] ? (rows[0].dados as SessionData) : null))
      .catch((err) => callback(err));
  };

  set = (sid: string, sess: SessionData, callback?: (err?: unknown) => void): void => {
    const dados = JSON.parse(JSON.stringify(sess)) as Record<string, unknown>;
    this.opts.pool()
      .query(
        `INSERT INTO sessoes_humanas (sid_hash, usuario_id, dados, expira_em)
         VALUES ($1, $2, $3::jsonb,
                 LEAST(now() + ($4::bigint * interval '1 millisecond'),
                       COALESCE($6::timestamptz, now()) + ($5::bigint * interval '1 millisecond')))
         ON CONFLICT (sid_hash) DO UPDATE
            SET usuario_id = EXCLUDED.usuario_id, dados = EXCLUDED.dados, atualizada_em = now(),
                expira_em = LEAST(now() + ($4::bigint * interval '1 millisecond'),
                                  COALESCE($6::timestamptz, sessoes_humanas.criada_em) + ($5::bigint * interval '1 millisecond'))
          WHERE sessoes_humanas.revogada_em IS NULL AND sessoes_humanas.expira_em > now()`,
        [hashSid(sid), usuarioDaSessao(sess), JSON.stringify(dados), this.opts.ociosidadeMs, this.opts.absolutoMs, autenticadoEm(sess)],
      )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  };

  touch = (sid: string, sess: SessionData, callback?: (err?: unknown) => void): void => {
    this.opts.pool()
      .query(
        `UPDATE sessoes_humanas
            SET atualizada_em = now(),
                expira_em = LEAST(now() + ($2::bigint * interval '1 millisecond'),
                                  COALESCE($4::timestamptz, criada_em) + ($3::bigint * interval '1 millisecond'))
          WHERE sid_hash = $1 AND revogada_em IS NULL AND expira_em > now()
            AND atualizada_em < now() - ($5::bigint * interval '1 millisecond')`,
        [hashSid(sid), this.opts.ociosidadeMs, this.opts.absolutoMs, autenticadoEm(sess), this.opts.intervaloToqueMs ?? 60_000],
      )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  };

  destroy = (sid: string, callback?: (err?: unknown) => void): void => {
    this.opts.pool()
      .query(
        `UPDATE sessoes_humanas SET revogada_em = now(), revogada_motivo = 'encerrada', dados = '{}'::jsonb
          WHERE sid_hash = $1 AND revogada_em IS NULL`,
        [hashSid(sid)],
      )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  };
}

/** A linha desta sessão ainda está viva (não revogada, não expirada)? */
export async function sessaoViva(pool: Pool, sid: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM sessoes_humanas WHERE sid_hash = $1 AND revogada_em IS NULL AND expira_em > now()`,
    [hashSid(sid)],
  );
  return rows.length > 0;
}

/** Revoga TODAS as sessões ativas de um usuário (provisionamento: identidade desvinculada/comprometida). */
export async function revogarSessoesDoUsuario(pool: Pool, usuarioId: string, motivo: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE sessoes_humanas SET revogada_em = now(), revogada_motivo = $2, dados = '{}'::jsonb
      WHERE usuario_id = $1 AND revogada_em IS NULL`,
    [usuarioId, motivo],
  );
  return rowCount ?? 0;
}

/**
 * Purga as sessões expiradas ou revogadas há mais de `retencaoDias` (as
 * revogadas ficam algum tempo como trilha). Segura com várias instâncias.
 */
export async function purgarSessoes(pool: Pool, retencaoDias = 30): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sessoes_humanas
      WHERE expira_em < now() - ($1::int * interval '1 day')
         OR revogada_em < now() - ($1::int * interval '1 day')`,
    [retencaoDias],
  );
  return rowCount ?? 0;
}

export function criarPgSessionStore(opts: OpcoesStoreSessao): session.Store {
  return new PgSessionStore(opts);
}
