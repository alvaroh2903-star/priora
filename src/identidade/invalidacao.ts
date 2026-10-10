import { PoolClient } from 'pg';
import { Db, ErroIdentidade, emTransacao, travar } from './comum';
import { reavaliarChaveMaster } from './master';
import { DecisaoPorEvidenciaInvalida, EstadoPendencia, GatilhoReavaliacao, validarDecisao } from './pendencias';
import { reavaliarChaveProcesso } from './processo';

/**
 * Evidência provada inválida (N-14) — os dois pontos de entrada, ambos com
 * autor, justificativa e a evidência da invalidade. Invalidar é mudança
 * material (N-16): na mesma transação, só a chave de identidade afetada é
 * reavaliada (`reavaliarChaveProcesso` / `reavaliarChaveMaster`). Sem varredura,
 * sem fila, sem polling. A trava da chave é tomada antes da linha, na mesma
 * ordem do registro.
 */

const travarChave = (c: PoolClient, organizationId: string, entidadeTipo: 'PROCESSO' | 'MASTER', chave: string) =>
  travar(c, `s6:${entidadeTipo === 'PROCESSO' ? 'processo' : 'master'}:${organizationId}:${chave}`);

/**
 * ABERTA/EM_ANALISE → ENCERRADA_POR_EVIDENCIA_INVALIDA: a evidência da própria
 * pendência é declarada inválida. Nada é criado, vinculado ou fundido por
 * escolha; se ela era um dos lados de um conflito, a chave é reavaliada.
 */
export async function encerrarPendenciaPorEvidenciaInvalida(
  db: Db, organizationId: string, pendenciaId: string, p: DecisaoPorEvidenciaInvalida,
): Promise<{ estado: 'ENCERRADA_POR_EVIDENCIA_INVALIDA' }> {
  const d = validarDecisao(p);
  return emTransacao(db, async (c) => {
    const alvo = await c.query(
      `SELECT entidade_tipo, chave FROM identidade_pendencias WHERE id = $1 AND organization_id = $2`,
      [pendenciaId, organizationId],
    );
    if (!alvo.rows[0]) throw new ErroIdentidade('PENDENCIA_INEXISTENTE', `pendência ${pendenciaId} não existe nesta organização`);
    const { entidade_tipo: entidadeTipo, chave } = alvo.rows[0];
    await travarChave(c, organizationId, entidadeTipo, chave);
    const { rows: [pend] } = await c.query(
      `SELECT estado, motivo FROM identidade_pendencias WHERE id = $1 FOR UPDATE`, [pendenciaId],
    );
    const estado: EstadoPendencia = pend.estado;
    if (estado !== 'ABERTA' && estado !== 'EM_ANALISE') {
      throw new ErroIdentidade('TRANSICAO_INVALIDA', `pendência ${pendenciaId} já está em ${estado}`);
    }
    await c.query(
      `UPDATE identidade_pendencias
          SET estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA', decidido_em = now(), decidido_por_membership_id = $2,
              justificativa = $3, resolucao_fonte = $4, resolucao_evidencia_ref = $5
        WHERE id = $1`,
      [pendenciaId, p.membershipId, d.justificativa, d.fonte, d.evidenciaRef],
    );
    const gatilho: GatilhoReavaliacao = { tipo: 'INVALIDACAO', causaId: pendenciaId, autorMembershipId: p.membershipId, ...d };
    if (entidadeTipo === 'PROCESSO' && pend.motivo === 'ALIAS_CONFLITANTE') {
      await reavaliarChaveProcesso(c, organizationId, chave, gatilho, null);
    } else if (entidadeTipo === 'MASTER') {
      await reavaliarChaveMaster(c, organizationId, chave, gatilho);
    }
    return { estado: 'ENCERRADA_POR_EVIDENCIA_INVALIDA' };
  });
}

/**
 * A evidência que sustenta um ALIAS de processo ou uma referência de Master foi
 * provada inválida. Grava, uma única vez e já terminal, o registro
 * EVIDENCIA_INVALIDADA (autor, data, justificativa, evidência da invalidade)
 * apontando para a referência. A referência fica no histórico, intacta, e deixa
 * de resolver identidade; o Master e as outras referências não mudam. Em
 * seguida, só a chave afetada é reavaliada. Idempotente: invalidar de novo
 * devolve o mesmo registro e não reavalia nada.
 */
export async function invalidarEvidenciaDeReferencia(db: Db, organizationId: string, p: DecisaoPorEvidenciaInvalida & {
  referencia: { aliasId: string } | { masterReferenciaId: string };
}): Promise<{ invalidacaoId: string; criada: boolean }> {
  const d = validarDecisao(p);
  return emTransacao(db, async (c) => {
    let alvo: {
      coluna: 'processo_referencia_id' | 'master_referencia_id'; id: string; entidadeTipo: 'PROCESSO' | 'MASTER'; processoId: string | null;
      referenciaOriginal: string; chave: string; armadorCodigo: string | null; fonte: string; evidenciaRef: string; observadoEm: Date;
    };
    if ('aliasId' in p.referencia) {
      const { rows } = await c.query(
        `SELECT id, processo_id, referencia, referencia_original, fonte, evidencia_ref, observado_em
           FROM processo_referencias WHERE id = $1 AND organization_id = $2 AND tipo = 'ALIAS'`,
        [p.referencia.aliasId, organizationId],
      );
      if (!rows[0]) throw new ErroIdentidade('REFERENCIA_INEXISTENTE', `alias ${p.referencia.aliasId} não existe nesta organização`);
      const r = rows[0];
      alvo = { coluna: 'processo_referencia_id', id: r.id, entidadeTipo: 'PROCESSO', processoId: r.processo_id,
        referenciaOriginal: r.referencia_original, chave: r.referencia, armadorCodigo: null, fonte: r.fonte, evidenciaRef: r.evidencia_ref,
        observadoEm: r.observado_em };
    } else {
      const { rows } = await c.query(
        `SELECT id, chave_canonica, armador_codigo, mbl_original, fonte, evidencia_ref, observado_em
           FROM master_referencias WHERE id = $1 AND organization_id = $2`,
        [p.referencia.masterReferenciaId, organizationId],
      );
      if (!rows[0]) {
        throw new ErroIdentidade('REFERENCIA_INEXISTENTE', `referência de Master ${p.referencia.masterReferenciaId} não existe nesta organização`);
      }
      const r = rows[0];
      alvo = { coluna: 'master_referencia_id', id: r.id, entidadeTipo: 'MASTER', processoId: null,
        referenciaOriginal: r.mbl_original, chave: r.chave_canonica, armadorCodigo: r.armador_codigo, fonte: r.fonte,
        evidenciaRef: r.evidencia_ref, observadoEm: r.observado_em };
    }
    await travarChave(c, organizationId, alvo.entidadeTipo, alvo.chave);
    const ins = await c.query(
      `INSERT INTO identidade_pendencias
         (organization_id, entidade_tipo, motivo, referencia_original, chave, armador_codigo, fonte, evidencia_ref, observado_em,
          estado, decidido_em, decidido_por_membership_id, justificativa, resolucao_fonte, resolucao_evidencia_ref, ${alvo.coluna})
       VALUES ($1, $2, 'EVIDENCIA_INVALIDADA', $3, $4, $5, $6, $7, $8,
               'ENCERRADA_POR_EVIDENCIA_INVALIDA', now(), $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [organizationId, alvo.entidadeTipo, alvo.referenciaOriginal, alvo.chave, alvo.armadorCodigo, alvo.fonte, alvo.evidenciaRef,
        alvo.observadoEm, p.membershipId, d.justificativa, d.fonte, d.evidenciaRef, alvo.id],
    );
    if (!ins.rows[0]) {
      const { rows } = await c.query(`SELECT id FROM identidade_pendencias WHERE ${alvo.coluna} = $1`, [alvo.id]);
      if (!rows[0]) throw new ErroIdentidade('INVARIANTE_VIOLADA', `invalidação da referência ${alvo.id} em conflito e não encontrada`);
      return { invalidacaoId: rows[0].id, criada: false };
    }
    const invalidacaoId: string = ins.rows[0].id;
    const gatilho: Extract<GatilhoReavaliacao, { tipo: 'INVALIDACAO' }> = {
      tipo: 'INVALIDACAO', causaId: invalidacaoId, autorMembershipId: p.membershipId, ...d,
    };
    if (alvo.entidadeTipo === 'PROCESSO') await reavaliarChaveProcesso(c, organizationId, alvo.chave, gatilho, alvo.processoId);
    else await reavaliarChaveMaster(c, organizationId, alvo.chave, gatilho);
    return { invalidacaoId, criada: true };
  });
}
