import { Pool } from 'pg';

/**
 * Produção P1 (Entrega 2) — resolução de propriedade do recurso ANTES de
 * chamar qualquer serviço congelado.
 *
 * Os serviços congelados chamados por esta entrega (ClosingService,
 * `decidirResponsabilidade`, `resolverPendenciaManual`) OU não recebem
 * `organizationId` nenhum (derivam a organização da própria linha do
 * recurso) OU, quando recebem, simplesmente não encontram a linha e
 * devolvem um código de erro (`processo_nao_encontrado`, `apenas_manager_admin`
 * etc.) que PODE diferir de um "não encontrado" — o que vazaria a
 * EXISTÊNCIA do recurso de outra organização (ex.: "apenas_manager_admin"
 * implica que o processo existe, só que o papel não serve).
 *
 * Por isso toda rota desta entrega resolve e CONFERE a organização do
 * recurso-alvo aqui, numa leitura estreita e própria — nunca delegada ao
 * serviço — ANTES de decidir prosseguir. Recurso inexistente E recurso de
 * outra organização produzem exatamente o mesmo resultado (`null`), que a
 * rota traduz para o MESMO `404`, indistinguível em ambos os casos (mesmo
 * padrão já estabelecido em D12 `leitura/detalhe.ts`).
 */

export async function organizacaoDoContainer(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT organization_id FROM containers WHERE id = $1`, [containerId]);
  return rows[0]?.organization_id ?? null;
}

export async function organizacaoDoProcesso(pool: Pool, processoId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT organization_id FROM processos WHERE id = $1`, [processoId]);
  return rows[0]?.organization_id ?? null;
}

/** Processo do contêiner (isolamento já conferido pela rota) — só para disparar a avaliação de encerramento depois de uma ação. */
export async function processoDoContainer(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT processo_id FROM containers WHERE id = $1`, [containerId]);
  return rows[0]?.processo_id ?? null;
}

export async function organizacaoDaMinuta(pool: Pool, minutaId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT c.organization_id FROM minutas m JOIN containers c ON c.id = m.container_id WHERE m.id = $1`,
    [minutaId],
  );
  return rows[0]?.organization_id ?? null;
}

export async function organizacaoDaReabertura(pool: Pool, reaberturaId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT p.organization_id FROM reaberturas r JOIN processos p ON p.id = r.processo_id WHERE r.id = $1`,
    [reaberturaId],
  );
  return rows[0]?.organization_id ?? null;
}

/**
 * Entrega 2 v1.1: substituída, para a rota de pendência, por
 * `acoes/pendenciaVerificacao.ts`'s `buscarPendenciaPersistida` — a MESMA
 * leitura, mas já trazendo `tipo`/`estado` junto da organização (achado #3
 * da auditoria: a rota precisa do tipo persistido para verificar contra o
 * tipo pedido, não só da organização).
 */

/** Busca `numeroProcesso` + `numero` do contêiner, já conferindo a organização (usado pelo adaptador de fallback manual). */
export async function processoENumeroDoContainer(
  pool: Pool, organizationId: string, containerId: string,
): Promise<{ numeroProcesso: string; numeroContainer: string } | null> {
  const { rows } = await pool.query(
    `SELECT p.numero_processo AS "numeroProcesso", c.numero AS "numeroContainer"
       FROM containers c JOIN processos p ON p.id = c.processo_id
      WHERE c.id = $1 AND c.organization_id = $2`,
    [containerId, organizationId],
  );
  return rows[0] ?? null;
}
