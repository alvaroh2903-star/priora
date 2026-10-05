import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { OrganizationRole } from '../domain/types';
import { decidirResponsabilidade, DecidirResponsabilidadeResultado } from '../responsabilidade/decidirResponsabilidade';
import { DecidirResponsabilidadeInput } from '../responsabilidade/contrato';

/**
 * Fase D11 — helper de teste que só existe para os testes CONGELADOS (D8/D10)
 * pararem de escrever `containers.responsabilidade` diretamente (ajuste
 * aprovado 6: "atualize os testes congelados de forma mecânica para criarem
 * a decisão pelo serviço da D11"). Passa SEMPRE pelo mesmo serviço de
 * produção (`decidirResponsabilidade`) — não é um bypass; é só conveniência
 * para não repetir a criação de um Gestor MANAGER em cada teste.
 */

export async function novoGestor(pool: Pool, organizationId: string): Promise<string> {
  return novoMembro(pool, organizationId, 'MANAGER');
}

/**
 * Fase D15-A — membership real de QUALQUER papel, para os testes de RBAC do
 * `closingService` (que agora resolve o ator por `membershipId`, nunca por
 * `papel` informado pelo chamador).
 */
export async function novoMembro(pool: Pool, organizationId: string, papel: OrganizationRole): Promise<string> {
  const usuario = await new UsuarioRepository(pool).create(`${papel} ${randomUUID()}`, `${papel.toLowerCase()}-${randomUUID()}@rocket.example`);
  const membership = await new OrganizationMembershipRepository(pool).create(organizationId, usuario.id, papel);
  return membership.id;
}

async function relogioContainer(pool: Pool, containerId: string, tipo: 'cliente' | 'rocket') {
  const { rows } = await pool.query(
    `SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = $2`,
    [containerId, tipo],
  );
  if (!rows.length) throw new Error(`responsabilidadeTestHelper: relogio ${tipo} ausente para o container ${containerId}`);
  return rows[0] as { primeiro_dia_demurrage: CivilDate; data_final_apuracao: CivilDate };
}

async function decidirOuFalhar(
  pool: Pool, input: DecidirResponsabilidadeInput & { hojeReferencia: CivilDate },
): Promise<DecidirResponsabilidadeResultado> {
  const r = await decidirResponsabilidade(pool, input);
  if (!r.ok) throw new Error(`decidirResponsabilidade falhou: ${JSON.stringify(r)}`);
  return r;
}

/**
 * Equivalente ao antigo `UPDATE containers SET responsabilidade =
 * 'CONFIRMADA_CLIENTE'` — TODOS os dias do relógio do cliente atribuídos ao
 * próprio cliente (caso mais comum dos testes congelados: demurrage do
 * cliente sem qualquer causa da Rocket alegada).
 */
export async function confirmarResponsabilidadeClienteIntegral(
  pool: Pool,
  params: { containerId: string; hoje: CivilDate; justificativa?: string; evidenciaRef?: string; organizationId?: string },
): Promise<DecidirResponsabilidadeResultado> {
  const orgId = params.organizationId ?? (await pool.query(`SELECT organization_id FROM containers WHERE id = $1`, [params.containerId])).rows[0].organization_id;
  const autorMembershipId = await novoGestor(pool, orgId);
  const rel = await relogioContainer(pool, params.containerId, 'cliente');
  return decidirOuFalhar(pool, {
    organizationId: orgId, containerId: params.containerId, autorMembershipId,
    status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
    periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
    justificativa: params.justificativa ?? 'Teste de regressão: demurrage integralmente do cliente, sem causa Rocket alegada.',
    evidenciaRef: params.evidenciaRef ?? 'teste://responsabilidade/cliente-integral',
    hojeReferencia: params.hoje,
  });
}
