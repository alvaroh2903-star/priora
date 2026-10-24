import { Pool, PoolClient } from 'pg';
import { revogarSessoesDoUsuario } from '../../auth/sessaoStore';

/**
 * Produção P1 (autenticação) — PROVISIONAMENTO mínimo e seguro (só backend).
 *
 * Um único serviço com todas as regras, usado por duas superfícies:
 *  - CLI do OPERADOR DE PLATAFORMA (`identidade/cli.ts`): cria/vincula a
 *    identidade Microsoft (oid + tid → `usuarios.home_account_id`), concede o
 *    papel de administrador de plataforma, revoga sessões e ADICIONA
 *    memberships (inclusive o primeiro administrador de uma organização);
 *  - HTTP do ADMIN da organização ativa (`routes/demurrageAdminRoutes.ts`):
 *    só membros QUE JÁ EXISTEM na organização — define papel, desativa e
 *    reativa. Adicionar alguém por HTTP permitiria a um ADMIN puxar usuário
 *    de outra organização (tornando-o "multi-organização" sem pedir) e
 *    descobrir quais e-mails existem na plataforma.
 *
 * Regras (todas aqui, nunca na rota):
 *  - papéis concedidos só ANALYST | MANAGER | ADMIN — nunca CLIENT; um
 *    membership CLIENT nunca vira interno por aqui;
 *  - ninguém altera o PRÓPRIO membership (sem autoconcessão; também um CHECK
 *    da trilha `membership_eventos`);
 *  - ator membership precisa ser ADMIN ATIVO da MESMA organização;
 *  - a organização nunca fica sem ADMIN ativo (checagem aqui + constraint
 *    trigger adiável da migration 0049); mudanças da mesma organização são
 *    serializadas por lock consultivo;
 *  - vínculo Microsoft só pelo operador; nunca sobrescreve outro vínculo;
 *  - toda mudança grava trilha append-only, na MESMA transação.
 */

export const PAPEIS_PROVISIONAVEIS = ['ANALYST', 'MANAGER', 'ADMIN'] as const;
export type PapelProvisionavel = (typeof PAPEIS_PROVISIONAVEIS)[number];

export type AtorProvisionamento =
  | { tipo: 'membership'; membershipId: string }
  | { tipo: 'operador_plataforma'; descricao: string };

export type CodigoProvisionamento =
  | 'ator_nao_autorizado' | 'autoalteracao_proibida' | 'papel_invalido' | 'cliente_sem_acesso_interno'
  | 'membership_nao_encontrado' | 'usuario_nao_encontrado' | 'membership_ja_existe' | 'organizacao_sem_admin'
  | 'identidade_ja_vinculada' | 'identidade_invalida' | 'motivo_obrigatorio' | 'organizacao_nao_encontrada'
  | 'dados_invalidos' | 'email_ambiguo';

const STATUS: Record<CodigoProvisionamento, number> = {
  ator_nao_autorizado: 403, autoalteracao_proibida: 403, papel_invalido: 400, cliente_sem_acesso_interno: 409,
  membership_nao_encontrado: 404, usuario_nao_encontrado: 404, membership_ja_existe: 409, organizacao_sem_admin: 409,
  identidade_ja_vinculada: 409, identidade_invalida: 400, motivo_obrigatorio: 400, organizacao_nao_encontrada: 404,
  dados_invalidos: 400, email_ambiguo: 409,
};

export class ErroProvisionamento extends Error {
  readonly status: number;
  constructor(public readonly codigo: CodigoProvisionamento, public readonly detalhe: Record<string, unknown> = {}) {
    super(codigo);
    this.name = 'ErroProvisionamento';
    this.status = STATUS[codigo];
  }
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function exigirMotivo(motivo: unknown): string {
  if (typeof motivo !== 'string' || !motivo.trim()) throw new ErroProvisionamento('motivo_obrigatorio');
  return motivo.trim().slice(0, 1000);
}

function exigirPapel(papel: unknown): PapelProvisionavel {
  if (papel === 'CLIENT') throw new ErroProvisionamento('cliente_sem_acesso_interno');
  if (!PAPEIS_PROVISIONAVEIS.includes(papel as PapelProvisionavel)) throw new ErroProvisionamento('papel_invalido');
  return papel as PapelProvisionavel;
}

function exigirOperador(ator: AtorProvisionamento): string {
  if (ator.tipo !== 'operador_plataforma' || !ator.descricao?.trim()) throw new ErroProvisionamento('ator_nao_autorizado');
  return ator.descricao.trim();
}

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    if ((err as { message?: string })?.message?.includes('ORGANIZACAO_SEM_ADMIN')) throw new ErroProvisionamento('organizacao_sem_admin');
    throw err;
  } finally {
    c.release();
  }
}

async function lockOrganizacao(c: PoolClient, organizationId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`priora:organizacao:membros:${organizationId}`]);
}

/** Ator membership: ADMIN ATIVO da MESMA organização. Devolve o usuário do ator. */
async function validarAtor(c: PoolClient, organizationId: string, ator: AtorProvisionamento): Promise<{ usuarioId: string | null }> {
  if (ator.tipo === 'operador_plataforma') { exigirOperador(ator); return { usuarioId: null }; }
  if (!RE_UUID.test(ator.membershipId)) throw new ErroProvisionamento('ator_nao_autorizado');
  const { rows } = await c.query(
    `SELECT usuario_id, papel, desativado_em FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
    [ator.membershipId, organizationId],
  );
  const a = rows[0];
  if (!a || a.papel !== 'ADMIN' || a.desativado_em !== null) throw new ErroProvisionamento('ator_nao_autorizado');
  return { usuarioId: a.usuario_id };
}

async function registrarEvento(c: PoolClient, e: {
  organizationId: string; membershipId: string; usuarioId: string; tipo: 'CRIADA' | 'PAPEL_ALTERADO' | 'DESATIVADA' | 'REATIVADA';
  papelAnterior: string | null; papelNovo: string | null; ator: AtorProvisionamento; motivo: string;
}): Promise<void> {
  await c.query(
    `INSERT INTO membership_eventos (organization_id, membership_id, usuario_id, tipo, papel_anterior, papel_novo,
                                     ator_tipo, ator_membership_id, ator_descricao, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.organizationId, e.membershipId, e.usuarioId, e.tipo, e.papelAnterior, e.papelNovo, e.ator.tipo,
      e.ator.tipo === 'membership' ? e.ator.membershipId : null,
      e.ator.tipo === 'operador_plataforma' ? e.ator.descricao.trim() : null, e.motivo,
    ],
  );
}

async function outrosAdminsAtivos(c: PoolClient, organizationId: string, exceto: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM organization_memberships
      WHERE organization_id = $1 AND papel = 'ADMIN' AND desativado_em IS NULL AND id <> $2`,
    [organizationId, exceto],
  );
  return rows[0].n;
}

async function alvoTravado(c: PoolClient, organizationId: string, membershipId: string) {
  if (!RE_UUID.test(membershipId)) throw new ErroProvisionamento('membership_nao_encontrado');
  const { rows } = await c.query(
    `SELECT id, usuario_id, papel, desativado_em FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [membershipId, organizationId],
  );
  if (!rows[0]) throw new ErroProvisionamento('membership_nao_encontrado');
  return rows[0] as { id: string; usuario_id: string; papel: string; desativado_em: Date | null };
}

export interface ResultadoMembership {
  membershipId: string;
  usuarioId: string;
  papel: PapelProvisionavel;
  ativo: boolean;
  alterado: boolean;
}

export async function adicionarMembership(pool: Pool, input: {
  organizationId: string; usuarioId: string; papel: unknown; ator: AtorProvisionamento; motivo: unknown;
}): Promise<ResultadoMembership> {
  const papel = exigirPapel(input.papel);
  const motivo = exigirMotivo(input.motivo);
  if (!RE_UUID.test(input.usuarioId)) throw new ErroProvisionamento('usuario_nao_encontrado');
  return emTransacao(pool, async (c) => {
    await lockOrganizacao(c, input.organizationId);
    const { rows: org } = await c.query(`SELECT 1 FROM organizations WHERE id = $1`, [input.organizationId]);
    if (!org.length) throw new ErroProvisionamento('organizacao_nao_encontrada');
    const ator = await validarAtor(c, input.organizationId, input.ator);
    if (ator.usuarioId === input.usuarioId) throw new ErroProvisionamento('autoalteracao_proibida');
    const { rows: u } = await c.query(`SELECT id FROM usuarios WHERE id = $1 FOR SHARE`, [input.usuarioId]);
    if (!u.length) throw new ErroProvisionamento('usuario_nao_encontrado');
    const { rows: existente } = await c.query(
      `SELECT id, papel FROM organization_memberships WHERE organization_id = $1 AND usuario_id = $2 FOR UPDATE`,
      [input.organizationId, input.usuarioId],
    );
    if (existente[0]) {
      if (existente[0].papel === 'CLIENT') throw new ErroProvisionamento('cliente_sem_acesso_interno');
      throw new ErroProvisionamento('membership_ja_existe', { membershipId: existente[0].id });
    }
    const { rows } = await c.query(
      `INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, $3) RETURNING id`,
      [input.organizationId, input.usuarioId, papel],
    );
    await registrarEvento(c, {
      organizationId: input.organizationId, membershipId: rows[0].id, usuarioId: input.usuarioId, tipo: 'CRIADA',
      papelAnterior: null, papelNovo: papel, ator: input.ator, motivo,
    });
    return { membershipId: rows[0].id, usuarioId: input.usuarioId, papel, ativo: true, alterado: true };
  });
}

export async function definirPapel(pool: Pool, input: {
  organizationId: string; membershipId: string; papel: unknown; ator: AtorProvisionamento; motivo: unknown;
}): Promise<ResultadoMembership> {
  const papel = exigirPapel(input.papel);
  const motivo = exigirMotivo(input.motivo);
  return emTransacao(pool, async (c) => {
    await lockOrganizacao(c, input.organizationId);
    const ator = await validarAtor(c, input.organizationId, input.ator);
    const alvo = await alvoTravado(c, input.organizationId, input.membershipId);
    if (input.ator.tipo === 'membership' && (alvo.id === input.ator.membershipId || alvo.usuario_id === ator.usuarioId)) {
      throw new ErroProvisionamento('autoalteracao_proibida');
    }
    if (alvo.papel === 'CLIENT') throw new ErroProvisionamento('cliente_sem_acesso_interno');
    const resultado = { membershipId: alvo.id, usuarioId: alvo.usuario_id, papel, ativo: alvo.desativado_em === null };
    if (alvo.papel === papel) return { ...resultado, alterado: false };
    if (alvo.papel === 'ADMIN' && alvo.desativado_em === null && (await outrosAdminsAtivos(c, input.organizationId, alvo.id)) === 0) {
      throw new ErroProvisionamento('organizacao_sem_admin');
    }
    await c.query(`UPDATE organization_memberships SET papel = $2 WHERE id = $1`, [alvo.id, papel]);
    await registrarEvento(c, {
      organizationId: input.organizationId, membershipId: alvo.id, usuarioId: alvo.usuario_id, tipo: 'PAPEL_ALTERADO',
      papelAnterior: alvo.papel, papelNovo: papel, ator: input.ator, motivo,
    });
    return { ...resultado, alterado: true };
  });
}

/**
 * Ativa/desativa um membership. Desativar o ÚLTIMO acesso interno ativo de
 * alguém revoga, depois do COMMIT, todas as sessões dessa pessoa (as demais
 * sessões já perdem o acesso àquela organização na próxima requisição, que
 * revalida o membership).
 */
export async function definirAtivo(pool: Pool, input: {
  organizationId: string; membershipId: string; ativo: boolean; ator: AtorProvisionamento; motivo: unknown;
}): Promise<ResultadoMembership> {
  const r = await definirAtivoEmTransacao(pool, input);
  if (r.alterado && !r.ativo) {
    const { rows } = await pool.query(
      `SELECT 1 FROM organization_memberships
        WHERE usuario_id = $1 AND papel IN ('ANALYST', 'MANAGER', 'ADMIN') AND desativado_em IS NULL LIMIT 1`,
      [r.usuarioId],
    );
    if (!rows.length) await revogarSessoesDoUsuario(pool, r.usuarioId, 'acesso_interno_removido');
  }
  return r;
}

async function definirAtivoEmTransacao(pool: Pool, input: {
  organizationId: string; membershipId: string; ativo: boolean; ator: AtorProvisionamento; motivo: unknown;
}): Promise<ResultadoMembership> {
  const motivo = exigirMotivo(input.motivo);
  return emTransacao(pool, async (c) => {
    await lockOrganizacao(c, input.organizationId);
    const ator = await validarAtor(c, input.organizationId, input.ator);
    const alvo = await alvoTravado(c, input.organizationId, input.membershipId);
    if (input.ator.tipo === 'membership' && (alvo.id === input.ator.membershipId || alvo.usuario_id === ator.usuarioId)) {
      throw new ErroProvisionamento('autoalteracao_proibida');
    }
    if (alvo.papel === 'CLIENT') throw new ErroProvisionamento('cliente_sem_acesso_interno');
    const ativoAgora = alvo.desativado_em === null;
    const resultado = { membershipId: alvo.id, usuarioId: alvo.usuario_id, papel: alvo.papel as PapelProvisionavel, ativo: input.ativo };
    if (ativoAgora === input.ativo) return { ...resultado, alterado: false };
    if (!input.ativo) {
      if (alvo.papel === 'ADMIN' && (await outrosAdminsAtivos(c, input.organizationId, alvo.id)) === 0) {
        throw new ErroProvisionamento('organizacao_sem_admin');
      }
      await c.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = $2 WHERE id = $1`, [alvo.id, motivo]);
    } else {
      await c.query(`UPDATE organization_memberships SET desativado_em = NULL, desativado_motivo = NULL WHERE id = $1`, [alvo.id]);
    }
    await registrarEvento(c, {
      organizationId: input.organizationId, membershipId: alvo.id, usuarioId: alvo.usuario_id,
      tipo: input.ativo ? 'REATIVADA' : 'DESATIVADA', papelAnterior: alvo.papel, papelNovo: alvo.papel, ator: input.ator, motivo,
    });
    return { ...resultado, alterado: true };
  });
}

export interface MembroListado {
  membershipId: string;
  usuarioId: string;
  nome: string;
  email: string;
  papel: string;
  ativo: boolean;
}

/** Membros INTERNOS da organização (para o ADMIN dela). Nunca de outra organização. */
export async function listarMembros(pool: Pool, organizationId: string): Promise<MembroListado[]> {
  const { rows } = await pool.query(
    `SELECT m.id, m.usuario_id, u.nome, u.email, m.papel, m.desativado_em
       FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.organization_id = $1 AND m.papel IN ('ANALYST', 'MANAGER', 'ADMIN')
      ORDER BY u.nome, m.id`,
    [organizationId],
  );
  return rows.map((r) => ({ membershipId: r.id, usuarioId: r.usuario_id, nome: r.nome, email: r.email, papel: r.papel, ativo: r.desativado_em === null }));
}

/** Usuário já provisionado, pelo e-mail (comparação sem diferenciar maiúsculas). */
export async function usuarioPorEmail(pool: Pool, email: unknown): Promise<string> {
  if (typeof email !== 'string' || !RE_EMAIL.test(email.trim())) throw new ErroProvisionamento('dados_invalidos', { campo: 'email' });
  const { rows } = await pool.query(`SELECT id FROM usuarios WHERE lower(email) = lower($1)`, [email.trim()]);
  if (rows.length > 1) throw new ErroProvisionamento('email_ambiguo');
  if (rows.length !== 1) throw new ErroProvisionamento('usuario_nao_encontrado');
  return rows[0].id;
}

/* ------------------------------------------------------------------ *
 * Somente operador de plataforma (CLI).
 * ------------------------------------------------------------------ */

async function eventoUsuario(c: PoolClient, usuarioId: string, tipo: string, operador: string, motivo: string, detalhe: Record<string, unknown> = {}): Promise<void> {
  await c.query(
    `INSERT INTO usuario_eventos (usuario_id, tipo, detalhe, ator_descricao, motivo) VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [usuarioId, tipo, JSON.stringify(detalhe), operador, motivo],
  );
}

/**
 * Cria o usuário (ou vincula um existente pelo e-mail) à identidade Microsoft
 * `oid` + `tid` (o `home_account_id` que o login devolve é `oid.tid`).
 * Idempotente para o mesmo par usuário/identidade; nunca sobrescreve vínculo.
 */
export async function vincularIdentidadeMicrosoft(pool: Pool, input: {
  nome: unknown; email: unknown; oid: unknown; tid: unknown; ator: AtorProvisionamento; motivo: unknown;
}): Promise<{ usuarioId: string; criado: boolean; vinculado: boolean }> {
  const operador = exigirOperador(input.ator);
  const motivo = exigirMotivo(input.motivo);
  if (typeof input.oid !== 'string' || !RE_UUID.test(input.oid) || typeof input.tid !== 'string' || !RE_UUID.test(input.tid)) {
    throw new ErroProvisionamento('identidade_invalida');
  }
  if (typeof input.nome !== 'string' || !input.nome.trim()) throw new ErroProvisionamento('dados_invalidos', { campo: 'nome' });
  if (typeof input.email !== 'string' || !RE_EMAIL.test(input.email.trim())) throw new ErroProvisionamento('dados_invalidos', { campo: 'email' });
  const home = `${input.oid.toLowerCase()}.${input.tid.toLowerCase()}`;
  const email = input.email.trim();
  return emTransacao(pool, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['priora:usuarios:vinculo']);
    const { rows: porHome } = await c.query(`SELECT id, lower(email) AS email FROM usuarios WHERE home_account_id = $1`, [home]);
    const { rows: porEmail } = await c.query(`SELECT id, home_account_id FROM usuarios WHERE lower(email) = lower($1) FOR UPDATE`, [email]);
    if (porHome[0]) {
      if (porHome[0].email === email.toLowerCase()) return { usuarioId: porHome[0].id, criado: false, vinculado: false };
      throw new ErroProvisionamento('identidade_ja_vinculada');
    }
    // E-mails que diferem só em maiúsculas/minúsculas podem coexistir
    // (`usuarios_email_unique` é sensível a caixa): nunca escolhe "o primeiro".
    if (porEmail.length > 1) throw new ErroProvisionamento('email_ambiguo');
    if (porEmail[0]) {
      if (porEmail[0].home_account_id) throw new ErroProvisionamento('identidade_ja_vinculada');
      await c.query(`UPDATE usuarios SET home_account_id = $2 WHERE id = $1`, [porEmail[0].id, home]);
      await eventoUsuario(c, porEmail[0].id, 'IDENTIDADE_VINCULADA', operador, motivo, { oid: input.oid, tid: input.tid });
      return { usuarioId: porEmail[0].id, criado: false, vinculado: true };
    }
    const { rows } = await c.query(
      `INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [(input.nome as string).trim(), email, home],
    );
    await eventoUsuario(c, rows[0].id, 'USUARIO_CRIADO', operador, motivo);
    await eventoUsuario(c, rows[0].id, 'IDENTIDADE_VINCULADA', operador, motivo, { oid: input.oid, tid: input.tid });
    return { usuarioId: rows[0].id, criado: true, vinculado: true };
  });
}

/** Remove o vínculo Microsoft e revoga todas as sessões do usuário (o histórico fica). */
export async function desvincularIdentidade(pool: Pool, input: { usuarioId: string; ator: AtorProvisionamento; motivo: unknown }): Promise<{ sessoesRevogadas: number }> {
  const operador = exigirOperador(input.ator);
  const motivo = exigirMotivo(input.motivo);
  const r = await emTransacao(pool, async (c) => {
    const { rowCount } = await c.query(`UPDATE usuarios SET home_account_id = NULL WHERE id = $1 AND home_account_id IS NOT NULL`, [input.usuarioId]);
    if (!rowCount) throw new ErroProvisionamento('usuario_nao_encontrado');
    await eventoUsuario(c, input.usuarioId, 'IDENTIDADE_DESVINCULADA', operador, motivo);
    return true;
  });
  const sessoesRevogadas = r ? await revogarSessoesDoUsuario(pool, input.usuarioId, 'identidade_desvinculada') : 0;
  return { sessoesRevogadas };
}

export async function definirAdministradorPlataforma(pool: Pool, input: { usuarioId: string; ativo: boolean; ator: AtorProvisionamento; motivo: unknown }): Promise<{ alterado: boolean }> {
  const operador = exigirOperador(input.ator);
  const motivo = exigirMotivo(input.motivo);
  return emTransacao(pool, async (c) => {
    const { rows } = await c.query(`SELECT administrador_plataforma FROM usuarios WHERE id = $1 FOR UPDATE`, [input.usuarioId]);
    if (!rows[0]) throw new ErroProvisionamento('usuario_nao_encontrado');
    if (rows[0].administrador_plataforma === input.ativo) return { alterado: false };
    await c.query(`UPDATE usuarios SET administrador_plataforma = $2 WHERE id = $1`, [input.usuarioId, input.ativo]);
    await eventoUsuario(c, input.usuarioId, input.ativo ? 'ADMIN_PLATAFORMA_CONCEDIDO' : 'ADMIN_PLATAFORMA_REVOGADO', operador, motivo);
    return { alterado: true };
  });
}

export async function revogarSessoes(pool: Pool, input: { usuarioId: string; ator: AtorProvisionamento; motivo: unknown }): Promise<{ sessoesRevogadas: number }> {
  const operador = exigirOperador(input.ator);
  const motivo = exigirMotivo(input.motivo);
  const { rows } = await pool.query(`SELECT 1 FROM usuarios WHERE id = $1`, [input.usuarioId]);
  if (!rows.length) throw new ErroProvisionamento('usuario_nao_encontrado');
  const n = await revogarSessoesDoUsuario(pool, input.usuarioId, 'revogacao_administrativa');
  await emTransacao(pool, (c) => eventoUsuario(c, input.usuarioId, 'SESSOES_REVOGADAS', operador, motivo, { sessoes: n }));
  return { sessoesRevogadas: n };
}
