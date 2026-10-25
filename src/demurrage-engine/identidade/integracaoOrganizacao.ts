import { Pool, PoolClient } from 'pg';

/**
 * Produção P1 (isolamento da integração Microsoft) — ORGANIZAÇÃO DONA da
 * caixa postal da integração (migration 0051, `integracao_microsoft_vinculos`).
 *
 * A integração Microsoft é UMA caixa postal (`msal_conta_ativa`). Tudo o que
 * se lê dela (V1, captura do pré-alerta, reprocessamento da SI) e tudo o que
 * se envia por ela (avisos) pertence a UMA organização: a dona, vinculada
 * EXPLICITAMENTE pelo operador de plataforma (CLI). Conceitos separados:
 *  - identidade humana = sessão (inalterada);
 *  - papel organizacional = membership interno ATIVO;
 *  - permissão OPERACIONAL de usar a caixa = membership interno ATIVO
 *    (ANALYST/MANAGER/ADMIN) na organização DONA — a pessoa não precisa ser a
 *    conta Microsoft, e a conta técnica não precisa ser usuária da Priora;
 *  - administração da integração (conectar/desconectar/substituir) =
 *    administrador de plataforma (inalterado) — sem acesso a dado da caixa
 *    por si só;
 *  - vínculo da organização dona = operador de plataforma (CLI).
 *
 * Dona = vínculo ATIVO da conta ATUAL da integração, relido do BANCO a cada
 * chamada (nunca de memória do processo). Trocar a conta deixa a nova SEM
 * dona até um vínculo novo (a chave é o `home_account_id`: nada é herdado).
 */

type Consulta = Pool | PoolClient;

export interface DonoIntegracao {
  homeAccountId: string;
  organizationId: string;
}

export interface IntegracaoAtual {
  homeAccountId: string;
  username: string;
  /** Organização dona (vínculo ATIVO desta conta); `null` = conectada, mas sem dona. */
  organizationId: string | null;
  vinculoId: string | null;
}

/** Conta ATUAL da integração + organização dona, do banco. `null` = integração desconectada. */
export async function integracaoAtual(pool: Consulta): Promise<IntegracaoAtual | null> {
  const { rows } = await pool.query(
    `SELECT c.home_account_id, c.username, v.id AS vinculo_id, v.organization_id
       FROM msal_conta_ativa c
       LEFT JOIN integracao_microsoft_vinculos v
              ON v.home_account_id = c.home_account_id AND v.desvinculado_em IS NULL
      WHERE c.id = 'default' AND c.home_account_id IS NOT NULL`,
  );
  const r = rows[0];
  if (!r) return null;
  return { homeAccountId: r.home_account_id, username: r.username, organizationId: r.organization_id ?? null, vinculoId: r.vinculo_id ?? null };
}

/** Organização dona da integração ATUAL — `null` se desconectada ou sem vínculo. */
export async function organizacaoDonaDaIntegracao(pool: Consulta): Promise<DonoIntegracao | null> {
  const atual = await integracaoAtual(pool);
  return atual?.organizationId ? { homeAccountId: atual.homeAccountId, organizationId: atual.organizationId } : null;
}

/** Vínculo ATIVO de UMA conta (atual ou não) — usado onde a conta já é conhecida (caixa da captura). */
export async function vinculoAtivoDaConta(pool: Consulta, homeAccountId: string): Promise<{ id: string; organizationId: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, organization_id FROM integracao_microsoft_vinculos WHERE home_account_id = $1 AND desvinculado_em IS NULL`,
    [homeAccountId],
  );
  return rows[0] ? { id: rows[0].id, organizationId: rows[0].organization_id } : null;
}

/* ------------------------------------------------------------------ *
 * Regra única de uso da caixa (guard V1 e `/api/me`)
 * ------------------------------------------------------------------ */

export type CodigoRecusaCaixaIntegracao = 'integracao_desconectada' | 'integracao_sem_organizacao' | 'integracao_de_outra_organizacao';

export type AvaliacaoCaixaIntegracao =
  | { ok: true; homeAccountId: string; organizationId: string; membershipId: string }
  | { ok: false; codigo: CodigoRecusaCaixaIntegracao };

/**
 * Pode a pessoa (memberships internos ATIVOS dela) usar a caixa da
 * integração? Só com integração conectada, organização dona vinculada e
 * membership interno ativo NESSA organização. Função pura: o chamador já leu
 * a integração e os memberships do banco nesta requisição.
 */
export function avaliarUsoDaCaixaDaIntegracao(
  integracao: { homeAccountId: string; organizationId: string | null } | null,
  internosAtivos: ReadonlyArray<{ organizationId: string; membershipId: string }>,
): AvaliacaoCaixaIntegracao {
  if (!integracao) return { ok: false, codigo: 'integracao_desconectada' };
  if (!integracao.organizationId) return { ok: false, codigo: 'integracao_sem_organizacao' };
  const m = internosAtivos.find((x) => x.organizationId === integracao.organizationId);
  if (!m) return { ok: false, codigo: 'integracao_de_outra_organizacao' };
  return { ok: true, homeAccountId: integracao.homeAccountId, organizationId: integracao.organizationId, membershipId: m.membershipId };
}

/* ------------------------------------------------------------------ *
 * Vínculo pelo operador de plataforma (CLI)
 * ------------------------------------------------------------------ */

export type CodigoIntegracaoOrganizacao =
  | 'integracao_desconectada' | 'organizacao_nao_encontrada' | 'integracao_vinculada_a_outra_organizacao'
  | 'operador_obrigatorio' | 'motivo_obrigatorio' | 'dados_invalidos';

export class ErroIntegracaoOrganizacao extends Error {
  constructor(public readonly codigo: CodigoIntegracaoOrganizacao, public readonly detalhe: Record<string, unknown> = {}) {
    super(codigo);
    this.name = 'ErroIntegracaoOrganizacao';
  }
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Serializa vínculo/desvínculo (e a leitura da conta atual) entre instâncias. */
const LOCK_INTEGRACAO = 'priora:integracao:microsoft:organizacao';

function exigirTexto(v: unknown, codigo: 'operador_obrigatorio' | 'motivo_obrigatorio'): string {
  if (typeof v !== 'string' || !v.trim()) throw new ErroIntegracaoOrganizacao(codigo);
  return v.trim().slice(0, 1000);
}

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [LOCK_INTEGRACAO]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Conta atual da integração, travada contra troca concorrente durante a transação. */
async function contaAtualTravada(c: PoolClient): Promise<{ homeAccountId: string; username: string }> {
  const { rows } = await c.query(
    `SELECT home_account_id, username FROM msal_conta_ativa WHERE id = 'default' AND home_account_id IS NOT NULL FOR SHARE`,
  );
  if (!rows[0]) throw new ErroIntegracaoOrganizacao('integracao_desconectada');
  return { homeAccountId: rows[0].home_account_id, username: rows[0].username };
}

/**
 * Vincula a conta ATUAL da integração a uma organização (dona). Idempotente
 * para a mesma organização; recusa se a conta já tem OUTRA dona (é preciso
 * desvincular antes — a troca de dona é sempre explícita e fica na trilha).
 * Na MESMA transação, encerra (`removida`) todo vínculo de captura LEGADO
 * dessa conta em OUTRA organização (modelo anterior, em que a caixa podia ser
 * vinculada a qualquer organização): sem isso, a caixa ficaria presa — a nova
 * dona não a vincularia (índice único de `email_caixas`) e a antiga já não
 * pode removê-la (não é dona).
 */
export async function vincularIntegracaoAOrganizacao(pool: Pool, input: { organizationId: string; operador: string; motivo: string }): Promise<{
  vinculoId: string; homeAccountId: string; organizationId: string; alterado: boolean; caixasLegadasEncerradas: number;
}> {
  if (typeof input.organizationId !== 'string' || !RE_UUID.test(input.organizationId)) throw new ErroIntegracaoOrganizacao('dados_invalidos', { campo: 'organizationId' });
  const operador = exigirTexto(input.operador, 'operador_obrigatorio');
  const motivo = exigirTexto(input.motivo, 'motivo_obrigatorio');
  return emTransacao(pool, async (c) => {
    const conta = await contaAtualTravada(c);
    const { rows: org } = await c.query(`SELECT id FROM organizations WHERE id = $1`, [input.organizationId]);
    if (!org[0]) throw new ErroIntegracaoOrganizacao('organizacao_nao_encontrada');
    const atual = await vinculoAtivoDaConta(c, conta.homeAccountId);
    if (atual) {
      if (atual.organizationId === input.organizationId) {
        return { vinculoId: atual.id, homeAccountId: conta.homeAccountId, organizationId: atual.organizationId, alterado: false, caixasLegadasEncerradas: 0 };
      }
      throw new ErroIntegracaoOrganizacao('integracao_vinculada_a_outra_organizacao', { organizationId: atual.organizationId });
    }
    const { rows } = await c.query(
      `INSERT INTO integracao_microsoft_vinculos (home_account_id, organization_id, vinculado_por, motivo)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [conta.homeAccountId, input.organizationId, operador, motivo],
    );
    const legadas = await encerrarCaixasDaConta(c, conta.homeAccountId, { excetoOrganizacao: input.organizationId });
    return { vinculoId: rows[0].id, homeAccountId: conta.homeAccountId, organizationId: input.organizationId, alterado: true, caixasLegadasEncerradas: legadas };
  });
}

/**
 * Encerra (`removida`) os vínculos de captura de uma conta — só na organização
 * indicada, ou em todas exceto uma. `alterada_por_membership_id` vira NULL: a
 * remoção é do OPERADOR de plataforma (a trilha fica em
 * `integracao_microsoft_vinculos`), nunca atribuída ao último ADMIN que mexeu
 * na caixa.
 */
async function encerrarCaixasDaConta(
  c: PoolClient, homeAccountId: string, alvo: { daOrganizacao: string } | { excetoOrganizacao: string },
): Promise<number> {
  const { rowCount } = await c.query(
    `UPDATE email_caixas SET estado = 'removida', removida_em = now(), atualizado_em = now(), alterada_por_membership_id = NULL
      WHERE home_account_id = $1 AND estado <> 'removida'
        AND (CASE WHEN $3 THEN organization_id = $2 ELSE organization_id <> $2 END)`,
    [homeAccountId, 'daOrganizacao' in alvo ? alvo.daOrganizacao : alvo.excetoOrganizacao, 'daOrganizacao' in alvo],
  );
  return rowCount ?? 0;
}

/**
 * Desvincula a conta da integração da sua organização dona (a linha fica no
 * histórico) — a conta ATUAL, ou, com `homeAccountId`, uma conta ANTERIOR
 * cujo vínculo ficou ativo depois de uma troca de conta (senão, se ela fosse
 * reconectada, voltaria em silêncio à dona antiga). Na MESMA transação,
 * encerra (`removida`) o vínculo de captura dessa caixa naquela organização:
 * a captura só existe enquanto a organização é dona da caixa — e um vínculo
 * de captura remanescente impediria a nova dona de vincular a mesma caixa
 * (índice único de `email_caixas`). Idempotente: sem vínculo ativo, nada muda.
 */
export async function desvincularIntegracao(pool: Pool, input: { operador: string; motivo: string; homeAccountId?: string }): Promise<{
  desvinculado: boolean; homeAccountId: string; vinculoId: string | null; organizationId: string | null; caixasCapturaEncerradas: number;
}> {
  const operador = exigirTexto(input.operador, 'operador_obrigatorio');
  const motivo = exigirTexto(input.motivo, 'motivo_obrigatorio');
  if (input.homeAccountId !== undefined && (typeof input.homeAccountId !== 'string' || !input.homeAccountId.trim())) {
    throw new ErroIntegracaoOrganizacao('dados_invalidos', { campo: 'homeAccountId' });
  }
  return emTransacao(pool, async (c) => {
    const homeAccountId = input.homeAccountId?.trim() ?? (await contaAtualTravada(c)).homeAccountId;
    const { rows } = await c.query(
      `UPDATE integracao_microsoft_vinculos
          SET desvinculado_em = now(), desvinculado_por = $2, desvinculo_motivo = $3
        WHERE home_account_id = $1 AND desvinculado_em IS NULL
        RETURNING id, organization_id`,
      [homeAccountId, operador, motivo],
    );
    if (!rows[0]) return { desvinculado: false, homeAccountId, vinculoId: null, organizationId: null, caixasCapturaEncerradas: 0 };
    const encerradas = await encerrarCaixasDaConta(c, homeAccountId, { daOrganizacao: rows[0].organization_id });
    return { desvinculado: true, homeAccountId, vinculoId: rows[0].id, organizationId: rows[0].organization_id, caixasCapturaEncerradas: encerradas };
  });
}

/** Vínculos ATIVOS de contas que NÃO são a conta atual da integração (sobras de uma troca de conta) — para o CLI. */
export async function vinculosAtivosDeOutrasContas(pool: Consulta) {
  const { rows } = await pool.query(
    `SELECT v.id, v.home_account_id, v.organization_id, o.nome AS organizacao_nome, v.vinculado_em
       FROM integracao_microsoft_vinculos v JOIN organizations o ON o.id = v.organization_id
      WHERE v.desvinculado_em IS NULL
        AND v.home_account_id IS DISTINCT FROM (SELECT home_account_id FROM msal_conta_ativa WHERE id = 'default')
      ORDER BY v.vinculado_em, v.id`,
  );
  return rows.map((r) => ({
    id: r.id as string, homeAccountId: r.home_account_id as string, organizationId: r.organization_id as string,
    organizacaoNome: r.organizacao_nome as string, vinculadoEm: r.vinculado_em,
  }));
}

/** Histórico de vínculos de uma conta (mais recente primeiro) — para o CLI. */
export async function historicoVinculosDaConta(pool: Consulta, homeAccountId: string) {
  const { rows } = await pool.query(
    `SELECT v.id, v.organization_id, o.nome AS organizacao_nome, v.vinculado_em, v.vinculado_por, v.motivo,
            v.desvinculado_em, v.desvinculado_por, v.desvinculo_motivo
       FROM integracao_microsoft_vinculos v JOIN organizations o ON o.id = v.organization_id
      WHERE v.home_account_id = $1
      ORDER BY v.vinculado_em DESC, v.id`,
    [homeAccountId],
  );
  return rows.map((r) => ({
    id: r.id as string, organizationId: r.organization_id as string, organizacaoNome: r.organizacao_nome as string,
    vinculadoEm: r.vinculado_em, vinculadoPor: r.vinculado_por as string, motivo: r.motivo as string,
    desvinculadoEm: r.desvinculado_em ?? null, desvinculadoPor: r.desvinculado_por ?? null, desvinculoMotivo: r.desvinculo_motivo ?? null,
  }));
}
