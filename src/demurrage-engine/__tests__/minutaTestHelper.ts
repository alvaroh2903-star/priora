import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ClosingService } from '../closing/closingService';
import { novoMembro } from './responsabilidadeTestHelper';

/**
 * Produção P1 (correção de minuta) — conveniência dos testes para o fluxo
 * ÚNICO de minuta: o ANALISTA registra a minuta com o documento (referência
 * auditável) e a verificação técnica automática decide o estado no próprio
 * registro. Substitui, nos testes congelados que só precisavam de "uma minuta
 * comprovando a devolução", o par antigo `registrarMinuta` + `validarMinuta`
 * (aprovação de gestor, removida). Não é um bypass: chama o serviço real.
 */
export function documentoDeTeste(tag: string = randomUUID()) {
  return {
    origem: 'referencia_externa', referencia: `teste://minuta/${tag}`, nomeArquivo: `minuta-${tag}.pdf`,
    tipoConteudo: 'application/pdf', tamanhoBytes: 4096, hashConteudo: createHash('sha256').update(tag).digest('hex'),
  };
}

export async function registrarMinutaDeTeste(
  pool: Pool,
  p: { containerId: string; numero: string | null; data: string | null; hoje: CivilDate; membershipId?: string; evidenciaRef?: string | null },
) {
  let membershipId = p.membershipId;
  if (!membershipId) {
    const { rows } = await pool.query(`SELECT organization_id FROM containers WHERE id = $1`, [p.containerId]);
    membershipId = await novoMembro(pool, rows[0].organization_id, 'ANALYST');
  }
  const r = await new ClosingService(pool).registrarMinuta({
    containerId: p.containerId, membershipId, numeroInformado: p.numero, dataInformada: p.data,
    evidenciaRef: p.evidenciaRef ?? null, documento: documentoDeTeste(), config: { hoje: p.hoje },
  });
  if (!r.ok) throw new Error(`registrarMinutaDeTeste: registro recusado (${r.motivo})`);
  return r;
}
