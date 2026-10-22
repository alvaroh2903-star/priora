import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { ManifestoDoPiloto, emailMascarado } from './manifesto';
import { Acao, Conflito, EstadoAtual, Plano, SituacaoDaCaixa, SituacaoDoMembro, planejar } from './plano';

/**
 * I4 — aplicação do plano no PostgreSQL. Uma execução = UMA transação:
 *  - trava consultiva única (`pg_advisory_xact_lock`): execuções simultâneas do provisionamento são serializadas;
 *  - o estado é lido DEPOIS da trava e o plano é refeito dentro da transação (nada de plano velho);
 *  - simulação (padrão) roda em transação SOMENTE LEITURA e termina em ROLLBACK: não grava nada;
 *  - conflito → ROLLBACK, nada gravado; qualquer erro no meio → ROLLBACK, nada gravado (sem estado parcial);
 *  - pós-condição: depois de aplicar, o mesmo manifesto precisa ter zero ações e zero conflitos; senão, ROLLBACK;
 *  - escreve só nas tabelas dos contratos existentes (`organizations`, `usuarios`, `organization_memberships`),
 *    sempre com INSERT de linhas novas ou o vínculo de conta ainda vazio; nunca DELETE, nunca troca de papel, e
 *    nunca toca `email_caixas` (o vínculo da caixa é da rota existente).
 * Os constraints do banco (slug, e-mail e conta únicos; um papel por pessoa e organização) continuam valendo.
 */

export const CHAVE_DA_TRAVA = 'priora-piloto/provisionamento';

export type ModoDoRelatorio = 'SIMULACAO' | 'APLICADO' | 'RECUSADO';

export type Pendencia =
  | { codigo: 'CONTA_PENDENTE'; membros: number[] }
  | { codigo: 'CAIXA_NAO_DECLARADA' | 'CAIXA_PENDENTE_DE_VINCULO' | 'CAIXA_PAUSADA' | 'SEM_ADMIN_DECLARADO' };

export interface Contagem { organizacoes: number; usuarios: number; contasVinculadas: number; memberships: number }

export interface RelatorioDoProvisionamento {
  formato: 'priora-piloto-relatorio/v1';
  modo: ModoDoRelatorio;
  manifestoSha256: string;
  organizacao: { slug: string; situacao: Plano['organizacao'] };
  membros: Array<Omit<SituacaoDoMembro, 'membro'> & { membro: number; email: string }>;
  caixa: SituacaoDaCaixa;
  conflitos: Conflito[];
  /** O que o plano faria (simulação) ou fez (aplicado). */
  previsto: Contagem;
  /** O que foi efetivamente gravado (zero na simulação e na recusa). */
  gravado: Contagem;
  admins: number;
  membrosForaDoManifesto: number;
  pendencias: Pendencia[];
}

export function sha256DoManifesto(m: ManifestoDoPiloto): string {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex');
}

export async function lerEstado(c: PoolClient, m: ManifestoDoPiloto): Promise<EstadoAtual> {
  const { rows: [org] } = await c.query(`SELECT id, nome FROM organizations WHERE slug = $1`, [m.organizacao.slug]);
  const emails = m.membros.map((x) => x.email);
  const contas = m.membros.map((x) => x.homeAccountId).filter((x): x is string => !!x);
  const { rows: usuarios } = await c.query(
    `SELECT id, nome, email, home_account_id FROM usuarios
      WHERE lower(btrim(email)) = ANY($1::text[]) OR home_account_id = ANY($2::text[])
      ORDER BY id`,
    [emails, contas],
  );
  const { rows: memberships } = await c.query(
    `SELECT id, organization_id, usuario_id, papel::text AS papel FROM organization_memberships WHERE usuario_id = ANY($1::uuid[]) ORDER BY id`,
    [usuarios.map((u) => u.id)],
  );
  const { rows: caixas } = m.caixa
    ? await c.query(
      `SELECT id, organization_id, home_account_id, estado, vinculada_por_membership_id FROM email_caixas
        WHERE home_account_id = $1 AND estado <> 'removida' ORDER BY id`,
      [m.caixa.homeAccountId],
    )
    : { rows: [] as any[] };
  const fora = org
    ? Number((await c.query(
      `SELECT count(*) AS n FROM organization_memberships om JOIN usuarios u ON u.id = om.usuario_id
        WHERE om.organization_id = $1 AND NOT (lower(btrim(u.email)) = ANY($2::text[]))`,
      [org.id, emails],
    )).rows[0].n)
    : 0;
  return {
    organizacao: org ? { id: org.id, nome: org.nome } : null,
    usuarios: usuarios.map((u) => ({ id: u.id, nome: u.nome, email: u.email, homeAccountId: u.home_account_id })),
    memberships: memberships.map((x) => ({ id: x.id, organizationId: x.organization_id, usuarioId: x.usuario_id, papel: x.papel })),
    caixas: caixas.map((x) => ({
      id: x.id, organizationId: x.organization_id, homeAccountId: x.home_account_id, estado: x.estado, vinculadaPorMembershipId: x.vinculada_por_membership_id,
    })),
    membrosForaDoManifesto: fora,
  };
}

const ZERO: Contagem = { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 };

function contagemDe(acoes: ReadonlyArray<Acao>): Contagem {
  const n = (t: Acao['tipo']) => acoes.filter((a) => a.tipo === t).length;
  return { organizacoes: n('CRIAR_ORGANIZACAO'), usuarios: n('CRIAR_USUARIO'), contasVinculadas: n('VINCULAR_CONTA') + acoes.filter((a) => a.tipo === 'CRIAR_USUARIO' && a.homeAccountId).length, memberships: n('CRIAR_MEMBERSHIP') };
}

async function aplicarAcoes(c: PoolClient, plano: Plano, estado: EstadoAtual): Promise<void> {
  let orgId = estado.organizacao?.id ?? null;
  const criados = new Map<number, string>();
  for (const a of plano.acoes) {
    if (a.tipo === 'CRIAR_ORGANIZACAO') {
      orgId = (await c.query(`INSERT INTO organizations (nome, slug) VALUES ($1, $2) RETURNING id`, [a.nome, a.slug])).rows[0].id;
    } else if (a.tipo === 'CRIAR_USUARIO') {
      const { rows: [u] } = await c.query(
        `INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING id`, [a.nome, a.email, a.homeAccountId],
      );
      criados.set(a.membro, u.id);
    } else if (a.tipo === 'VINCULAR_CONTA') {
      const r = await c.query(`UPDATE usuarios SET home_account_id = $2 WHERE id = $1 AND home_account_id IS NULL`, [a.usuarioId, a.homeAccountId]);
      if (r.rowCount !== 1) throw new ErroDoProvisionamento('ESTADO_MUDOU_DURANTE_A_EXECUCAO');
    } else {
      const usuarioId = a.usuarioId ?? criados.get(a.membro);
      if (!orgId || !usuarioId) throw new ErroDoProvisionamento('PLANO_INCONSISTENTE');
      await c.query(`INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, $3)`, [orgId, usuarioId, a.papel]);
    }
  }
}

export class ErroDoProvisionamento extends Error {
  constructor(readonly codigo: 'ESTADO_MUDOU_DURANTE_A_EXECUCAO' | 'PLANO_INCONSISTENTE' | 'POS_CONDICAO_FALHOU') {
    super(`provisionamento: ${codigo} (transação desfeita, nada gravado)`);
    this.name = 'ErroDoProvisionamento';
  }
}

function pendenciasDe(m: ManifestoDoPiloto, plano: Plano): Pendencia[] {
  const p: Pendencia[] = [];
  const semConta = plano.membros.filter((x) => x.conta === 'PENDENTE').map((x) => x.membro);
  if (semConta.length) p.push({ codigo: 'CONTA_PENDENTE', membros: semConta });
  if (plano.caixa === 'NAO_DECLARADA') p.push({ codigo: 'CAIXA_NAO_DECLARADA' });
  if (plano.caixa === 'PENDENTE_DE_VINCULO') p.push({ codigo: 'CAIXA_PENDENTE_DE_VINCULO' });
  if (plano.caixa === 'PAUSADA') p.push({ codigo: 'CAIXA_PAUSADA' });
  if (!m.membros.some((x) => x.papel === 'ADMIN')) p.push({ codigo: 'SEM_ADMIN_DECLARADO' });
  return p;
}

function relatorio(m: ManifestoDoPiloto, plano: Plano, modo: ModoDoRelatorio, gravado: Contagem): RelatorioDoProvisionamento {
  return {
    formato: 'priora-piloto-relatorio/v1', modo, manifestoSha256: sha256DoManifesto(m),
    organizacao: { slug: m.organizacao.slug, situacao: plano.organizacao },
    membros: plano.membros.map((x) => ({ ...x, email: emailMascarado(m.membros[x.membro].email) })),
    caixa: plano.caixa, conflitos: plano.conflitos, previsto: contagemDe(plano.acoes), gravado,
    admins: plano.admins, membrosForaDoManifesto: plano.membrosForaDoManifesto, pendencias: pendenciasDe(m, plano),
  };
}

/** Simula (padrão) ou aplica o manifesto. Lança só em erro inesperado — e então nada foi gravado. */
export async function provisionar(pool: Pool, m: ManifestoDoPiloto, opcoes: { aplicar: boolean }): Promise<RelatorioDoProvisionamento> {
  const c = await pool.connect();
  try {
    await c.query(opcoes.aplicar ? 'BEGIN' : 'BEGIN READ ONLY');
    await c.query(`SET LOCAL lock_timeout = '10s'`);
    await c.query(`SET LOCAL statement_timeout = '60s'`);
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [CHAVE_DA_TRAVA]);
    const estado = await lerEstado(c, m);
    const plano = planejar(m, estado);
    if (!opcoes.aplicar || plano.conflitos.length) {
      await c.query('ROLLBACK');
      return relatorio(m, plano, plano.conflitos.length ? 'RECUSADO' : 'SIMULACAO', ZERO);
    }
    await aplicarAcoes(c, plano, estado);
    const depois = planejar(m, await lerEstado(c, m));
    if (depois.acoes.length || depois.conflitos.length) throw new ErroDoProvisionamento('POS_CONDICAO_FALHOU');
    await c.query('COMMIT');
    return relatorio(m, plano, 'APLICADO', contagemDe(plano.acoes));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
