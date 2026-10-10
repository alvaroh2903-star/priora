import { PoolClient } from 'pg';
import { Db, ErroIdentidade, Evidencia, emTransacao } from './comum';

/**
 * Pendência de identidade (N-3, N-18) na máquina de estados do N-14. Uma
 * pendência por EVIDÊNCIA; reingerir a mesma evidência nunca abre outra (N-16).
 *
 * Nenhuma escolha humana livre resolve identidade:
 *  - EM_ANALISE: registra quem analisa; não resolve nada;
 *  - ENCERRADA_POR_EVIDENCIA_INVALIDA: exige autor, justificativa e a evidência
 *    da invalidade (`invalidacao.ts`);
 *  - RESOLVIDA_PELA_FONTE_DE_VERDADE: só como efeito de uma nova observação que
 *    elimina a causa, ou da invalidação da evidência do outro lado.
 * Se as evidências continuam válidas e incompatíveis, a pendência continua
 * aberta, mesmo depois da análise humana.
 */

export type EstadoPendencia = 'ABERTA' | 'EM_ANALISE' | 'ENCERRADA_POR_EVIDENCIA_INVALIDA' | 'RESOLVIDA_PELA_FONTE_DE_VERDADE';
export type MotivoPendenciaProcesso = 'REFERENCIA_INCOMPLETA' | 'PROCESSO_NAO_ENCONTRADO' | 'ALIAS_CONFLITANTE' | 'EVIDENCIA_INVALIDADA';
export type MotivoPendenciaMaster = 'ARMADOR_INCOMPATIVEL' | 'MASTER_NAO_ENCONTRADO' | 'EVIDENCIA_INVALIDADA';

export interface PendenciaRegistrada {
  id: string;
  estado: EstadoPendencia;
  criada: boolean;
}

/** O que dispara a reavaliação local de uma chave: a invalidação de uma evidência ou uma observação nova. */
export type GatilhoReavaliacao =
  | { tipo: 'INVALIDACAO'; causaId: string; autorMembershipId: string; justificativa: string; fonte: string; evidenciaRef: string }
  | { tipo: 'OBSERVACAO'; evidencia: Evidencia };

/** Subconsultas de "referência ativa": nenhuma invalidação aponta para ela. */
export const ALIAS_ATIVO = `NOT EXISTS (SELECT 1 FROM identidade_pendencias i WHERE i.processo_referencia_id = r.id)`;
export const REFERENCIA_MASTER_ATIVA = `NOT EXISTS (SELECT 1 FROM identidade_pendencias i WHERE i.master_referencia_id = r.id)`;

/** Mesma condição do índice `identidade_pendencias_evidencia_unique`. */
const PENDENCIA_DA_EVIDENCIA = `(estado IN ('ABERTA', 'EM_ANALISE') OR (estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA' AND causa_invalidacao_id IS NULL))`;

export async function abrirPendencia(c: PoolClient, p: {
  organizationId: string;
  entidadeTipo: 'PROCESSO' | 'MASTER';
  motivo: Exclude<MotivoPendenciaProcesso | MotivoPendenciaMaster, 'EVIDENCIA_INVALIDADA'>;
  referenciaOriginal: string;
  chave: string;
  armadorCodigo: string | null;
  /** Só ALIAS_CONFLITANTE: o processo que a evidência do alias indica. */
  processoIndicadoId?: string | null;
  evidencia: Evidencia;
}): Promise<PendenciaRegistrada> {
  const chaveEvidencia = [p.organizationId, p.entidadeTipo, p.motivo, p.chave, p.armadorCodigo, p.evidencia.fonte, p.evidencia.evidenciaRef];
  const ins = await c.query(
    `INSERT INTO identidade_pendencias
       (organization_id, entidade_tipo, motivo, chave, armador_codigo, fonte, evidencia_ref,
        referencia_original, observado_em, processo_indicado_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (organization_id, entidade_tipo, motivo, chave, armador_codigo, fonte, evidencia_ref)
       WHERE ${PENDENCIA_DA_EVIDENCIA} DO NOTHING
     RETURNING id, estado`,
    [...chaveEvidencia, p.referenciaOriginal, p.evidencia.observadoEm, p.processoIndicadoId ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, estado: ins.rows[0].estado, criada: true };
  const { rows } = await c.query(
    `SELECT id, estado FROM identidade_pendencias
      WHERE organization_id = $1 AND entidade_tipo = $2 AND motivo = $3 AND chave = $4
        AND armador_codigo IS NOT DISTINCT FROM $5::text AND fonte = $6 AND evidencia_ref = $7
        AND ${PENDENCIA_DA_EVIDENCIA}`,
    chaveEvidencia,
  );
  return { id: rows[0].id, estado: rows[0].estado, criada: false };
}

/**
 * Efeito de uma nova observação que dá identidade a `chave`: fecha as pendências
 * abertas de referência sem identidade e, se for a MESMA evidência, o
 * ALIAS_CONFLITANTE que indicava este processo (o conflito deixou de existir).
 */
export async function resolverPendenciasProcessoPelaFonte(
  c: PoolClient, organizationId: string, chave: string, processoId: string,
  resolucao: Evidencia, decididoPorMembershipId: string | null,
): Promise<string[]> {
  const { rows } = await c.query(
    `UPDATE identidade_pendencias
        SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), decidido_por_membership_id = $5,
            resolucao_fonte = $3, resolucao_evidencia_ref = $4, resolvido_processo_id = $6
      WHERE organization_id = $1 AND entidade_tipo = 'PROCESSO' AND chave = $2 AND estado IN ('ABERTA', 'EM_ANALISE')
        AND (motivo IN ('REFERENCIA_INCOMPLETA', 'PROCESSO_NAO_ENCONTRADO')
             OR (motivo = 'ALIAS_CONFLITANTE' AND processo_indicado_id = $6 AND fonte = $3 AND evidencia_ref = $4))
      RETURNING id`,
    [organizationId, chave, resolucao.fonte, resolucao.evidenciaRef, decididoPorMembershipId, processoId],
  );
  return rows.map((r) => r.id as string).sort();
}

/** A mesma evidência, antes sem identidade ou incompatível, agora dá identidade ao Master: fecha a pendência dela. */
export async function resolverPendenciasMasterPelaFonte(
  c: PoolClient, organizationId: string, chave: string, armadorCodigo: string | null, resolucao: Evidencia, masterId: string,
): Promise<void> {
  await c.query(
    `UPDATE identidade_pendencias
        SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(),
            resolucao_fonte = $4, resolucao_evidencia_ref = $5, resolvido_master_id = $6
      WHERE organization_id = $1 AND entidade_tipo = 'MASTER' AND motivo IN ('ARMADOR_INCOMPATIVEL', 'MASTER_NAO_ENCONTRADO')
        AND chave = $2 AND armador_codigo IS NOT DISTINCT FROM $3::text AND fonte = $4 AND evidencia_ref = $5
        AND estado IN ('ABERTA', 'EM_ANALISE')`,
    [organizationId, chave, armadorCodigo, resolucao.fonte, resolucao.evidenciaRef, masterId],
  );
}

export interface DecisaoPorEvidenciaInvalida {
  justificativa: string;
  evidencia: Pick<Evidencia, 'fonte' | 'evidenciaRef'>;
  membershipId: string;
}

export function validarDecisao(p: DecisaoPorEvidenciaInvalida): { justificativa: string; fonte: string; evidenciaRef: string } {
  const justificativa = String(p.justificativa ?? '').trim();
  if (!justificativa) throw new ErroIdentidade('JUSTIFICATIVA_OBRIGATORIA', 'evidência inválida exige justificativa');
  const fonte = String(p.evidencia?.fonte ?? '').trim();
  const evidenciaRef = String(p.evidencia?.evidenciaRef ?? '').trim();
  if (!fonte || !evidenciaRef) throw new ErroIdentidade('EVIDENCIA_INCOMPLETA', 'evidência inválida exige a evidência da invalidade');
  return { justificativa, fonte, evidenciaRef };
}

/** ABERTA → EM_ANALISE. Idempotente para quem já está em análise. */
export async function iniciarAnalisePendencia(
  db: Db, organizationId: string, pendenciaId: string, membershipId: string,
): Promise<{ estado: 'EM_ANALISE' }> {
  return emTransacao(db, async (c) => {
    const { rows } = await c.query(
      `SELECT estado FROM identidade_pendencias WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [pendenciaId, organizationId],
    );
    if (!rows[0]) throw new ErroIdentidade('PENDENCIA_INEXISTENTE', `pendência ${pendenciaId} não existe nesta organização`);
    const estado: EstadoPendencia = rows[0].estado;
    if (estado === 'EM_ANALISE') return { estado };
    if (estado !== 'ABERTA') throw new ErroIdentidade('TRANSICAO_INVALIDA', `pendência ${pendenciaId} está em ${estado}`);
    await c.query(
      `UPDATE identidade_pendencias SET estado = 'EM_ANALISE', em_analise_em = now(), em_analise_por_membership_id = $2 WHERE id = $1`,
      [pendenciaId, membershipId],
    );
    return { estado: 'EM_ANALISE' };
  });
}
