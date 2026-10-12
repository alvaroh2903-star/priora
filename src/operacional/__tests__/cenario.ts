import { Pool } from 'pg';
import { ContextoOperacional } from '../contexto';

/**
 * Cenário de teste dos fatos duráveis (S1/S2): uma organização com
 *  - a caixa Microsoft monitorada (vinculada pelo ADMIN que é a própria conta da caixa);
 *  - uma PESSOA (ANALYST) com conta própria, distinta da caixa;
 *  - um CLIENT.
 */
export interface Cenario {
  orgId: string;
  caixaId: string;
  homeCaixa: string;
  homePessoa: string;
  homeCliente: string;
  membershipPessoa: string;
  membershipCaixa: string;
  membershipCliente: string;
  ctx: ContextoOperacional;
}

export async function cenario(pool: Pool, slug: string): Promise<Cenario> {
  const org: string = (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ($1, $1) RETURNING id`, [slug])).rows[0].id;
  const usuario = async (rotulo: string, papel: string) => {
    const home = `home-${rotulo}-${slug}`;
    const u = await pool.query(`INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [`${rotulo} ${slug}`, `${rotulo}-${slug}@x.com`, home]);
    const m = await pool.query(`INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, $3) RETURNING id`,
      [org, u.rows[0].id, papel]);
    return { home, membership: m.rows[0].id as string };
  };
  const caixaConta = await usuario('caixa', 'ADMIN');
  const pessoa = await usuario('pessoa', 'ANALYST');
  const cliente = await usuario('cliente', 'CLIENT');
  const caixa = await pool.query(
    `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [org, caixaConta.home, `operacao@${slug}.com`, caixaConta.membership],
  );
  const caixaId: string = caixa.rows[0].id;
  return {
    orgId: org, caixaId, homeCaixa: caixaConta.home, homePessoa: pessoa.home, homeCliente: cliente.home,
    membershipPessoa: pessoa.membership, membershipCaixa: caixaConta.membership, membershipCliente: cliente.membership,
    ctx: { organizationId: org, membershipId: pessoa.membership, caixaId },
  };
}

export async function contar(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await pool.query(sql, params)).rows[0].n);
}
