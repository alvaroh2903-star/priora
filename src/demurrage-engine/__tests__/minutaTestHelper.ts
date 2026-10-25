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
    // Produção P1 (filas pessoais): registrar minuta é ação PESSOAL — o
    // ANALYST precisa ser o responsável do processo. Sem responsável, o
    // analista criado aqui passa a sê-lo; com responsável, é ele quem registra.
    const { rows } = await pool.query(
      `SELECT c.organization_id, c.processo_id, p.responsavel_operacional_membership_id AS responsavel, m.papel::text AS papel
         FROM containers c JOIN processos p ON p.id = c.processo_id
         LEFT JOIN organization_memberships m ON m.id = p.responsavel_operacional_membership_id
        WHERE c.id = $1`,
      [p.containerId],
    );
    const responsavel: string | null = rows[0].responsavel ?? null;
    // O ator padrão deste helper é sempre um ANALYST: um responsável prévio de
    // outro papel trocaria o ator em silêncio — o teste precisa passar `membershipId`.
    if (responsavel && rows[0].papel !== 'ANALYST') {
      throw new Error(`registrarMinutaDeTeste: o responsável do processo é ${rows[0].papel}, não ANALYST — passe membershipId`);
    }
    const ator = responsavel ?? await novoMembro(pool, rows[0].organization_id, 'ANALYST');
    if (!responsavel) {
      await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [rows[0].processo_id, ator]);
    }
    membershipId = ator;
  }
  const r = await new ClosingService(pool).registrarMinuta({
    containerId: p.containerId, membershipId, numeroInformado: p.numero, dataInformada: p.data,
    evidenciaRef: p.evidenciaRef ?? null, documento: documentoDeTeste(), config: { hoje: p.hoje },
  });
  if (!r.ok) throw new Error(`registrarMinutaDeTeste: registro recusado (${r.motivo})`);
  return r;
}
