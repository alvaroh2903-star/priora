import { PoolClient } from 'pg';
import { Db, ErroIdentidade, Evidencia, Origem, emTransacao, travar, validarEvidencia } from './comum';
import { ChaveMaster, armadorDoPrefixo, chaveMaster } from './normalizacao';
import {
  EstadoPendencia, GatilhoReavaliacao, REFERENCIA_MASTER_ATIVA, abrirPendencia, resolverPendenciasMasterPelaFonte,
} from './pendencias';

/**
 * Identidade do Master (N-18): UUID próprio em `masters`; as referências
 * documentais (MBL + armador declarado + evidência) ficam em
 * `master_referencias`. Organização + MBL não é identidade infalível:
 *  - nenhum Master com referência ATIVA na chave → cria;
 *  - um Master compatível (armador igual, ou ausente de um dos lados) → anexa
 *    a referência (a mesma forma repetida não grava nada);
 *  - armador incompatível com o Master da chave, ou armador declarado que
 *    contradiz o prefixo do próprio MBL → pendência ARMADOR_INCOMPATIVEL;
 *    nada é anexado nem criado, e o histórico fica intacto.
 * Referência cuja evidência foi provada inválida fica no histórico e não conta
 * como candidata; a mesma evidência nunca volta a dar identidade.
 * O vínculo Processo↔Master é fato do S2; o S6 só devolve o `masterId`.
 */

export type ResultadoRegistroMaster =
  | { status: 'RESOLVIDO'; masterId: string; criado: boolean; referenciaNova: boolean }
  | {
    status: 'NAO_RESOLVIDO'; motivo: 'ARMADOR_INCOMPATIVEL' | 'EVIDENCIA_INVALIDADA';
    pendenciaId: string; estadoPendencia: EstadoPendencia; candidatos: string[];
  };

export type ResultadoResolucaoMaster =
  | { status: 'RESOLVIDO'; masterId: string }
  | { status: 'NAO_RESOLVIDO'; motivo: 'MASTER_NAO_ENCONTRADO' | 'ARMADOR_INCOMPATIVEL'; candidatos: string[] };

type Avaliacao =
  | { tipo: 'NOVO' }
  | { tipo: 'COMPATIVEL'; masterId: string }
  | { tipo: 'INCOMPATIVEL'; candidatos: string[] };

/** Masters com referência ATIVA na chave e os armadores de cada um (declarado ou, sem ele, o do prefixo forte do MBL). */
async function referenciasAtivas(db: Db, organizationId: string, chave: string): Promise<{ candidatos: string[]; armadores: Map<string, Set<string>> }> {
  const { rows } = await db.query(
    `SELECT r.master_id, r.mbl_limpo, r.armador_codigo FROM master_referencias r
      WHERE r.organization_id = $1 AND r.chave_canonica = $2 AND ${REFERENCIA_MASTER_ATIVA}`,
    [organizationId, chave],
  );
  const armadores = new Map<string, Set<string>>();
  for (const r of rows) {
    const conjunto = armadores.get(r.master_id) ?? new Set<string>();
    const efetivo: string | null = r.armador_codigo ?? armadorDoPrefixo(r.mbl_limpo);
    if (efetivo) conjunto.add(efetivo);
    armadores.set(r.master_id, conjunto);
  }
  const candidatos = [...armadores.keys()].sort();
  if (candidatos.length > 1) {
    throw new ErroIdentidade('INVARIANTE_VIOLADA', `mais de um Master ativo na chave ${chave} da organização ${organizationId}`);
  }
  return { candidatos, armadores };
}

async function avaliar(db: Db, organizationId: string, k: ChaveMaster): Promise<Avaliacao> {
  const { candidatos, armadores } = await referenciasAtivas(db, organizationId, k.chave);
  if (k.incoerente) return { tipo: 'INCOMPATIVEL', candidatos };
  if (candidatos.length === 0) return { tipo: 'NOVO' };
  const doMaster = armadores.get(candidatos[0])!;
  const compativel = k.armadorEfetivo === null || doMaster.size === 0 || (doMaster.size === 1 && doMaster.has(k.armadorEfetivo));
  return compativel ? { tipo: 'COMPATIVEL', masterId: candidatos[0] } : { tipo: 'INCOMPATIVEL', candidatos };
}

/** Anexa a forma ao Master; se a forma só existe invalidada, abre a geração seguinte. Devolve se gravou. */
async function anexarReferencia(
  c: PoolClient, organizationId: string, masterId: string, mblOriginal: string, k: ChaveMaster, evidencia: Evidencia,
): Promise<boolean> {
  const { rows: [ultima] } = await c.query(
    `SELECT r.geracao, ${REFERENCIA_MASTER_ATIVA} AS ativa FROM master_referencias r
      WHERE r.master_id = $1 AND r.chave_canonica = $2 AND r.armador_codigo IS NOT DISTINCT FROM $3::text
      ORDER BY r.geracao DESC LIMIT 1`,
    [masterId, k.chave, k.armadorDeclarado],
  );
  if (ultima?.ativa) return false;
  const ins = await c.query(
    `INSERT INTO master_referencias
       (organization_id, master_id, mbl_original, mbl_limpo, chave_canonica, armador_codigo, geracao, regra, fonte, evidencia_ref, observado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (master_id, chave_canonica, armador_codigo, geracao) DO NOTHING
     RETURNING id`,
    [organizationId, masterId, mblOriginal, k.limpo, k.chave, k.armadorDeclarado, (ultima?.geracao ?? 0) + 1, k.regra,
      evidencia.fonte, evidencia.evidenciaRef, evidencia.observadoEm],
  );
  return ins.rows.length > 0;
}

/**
 * Reavaliação LOCAL das pendências abertas de uma chave de Master, depois de
 * uma mudança material nela (evidência invalidada ou Master criado). Nada fora
 * da chave é lido ou escrito. Contradição interna (armador declarado × prefixo
 * do próprio MBL) não depende dos candidatos e fica aberta.
 *  - um candidato e todas as evidências compatíveis entre si e com ele → as
 *    referências são anexadas e as pendências resolvidas (com a causa);
 *  - evidências válidas incompatíveis continuam → nada muda, o conflito segue;
 *  - nenhum candidato válido → nenhuma identidade é inventada: o conflito com
 *    um Master que deixou de valer é encerrado pela causa e a referência volta
 *    a ficar pendente como MASTER_NAO_ENCONTRADO.
 */
export async function reavaliarChaveMaster(c: PoolClient, organizationId: string, chave: string, gatilho: GatilhoReavaliacao): Promise<void> {
  const { rows: abertas } = await c.query(
    `SELECT id, motivo, referencia_original, armador_codigo, fonte, evidencia_ref, observado_em FROM identidade_pendencias
      WHERE organization_id = $1 AND entidade_tipo = 'MASTER' AND chave = $2 AND estado IN ('ABERTA', 'EM_ANALISE')
        AND motivo IN ('ARMADOR_INCOMPATIVEL', 'MASTER_NAO_ENCONTRADO')
      ORDER BY observado_em, criado_em, id`,
    [organizationId, chave],
  );
  const pendentes = abertas
    .map((p) => ({ p, k: chaveMaster(p.referencia_original, p.armador_codigo) }))
    .filter(({ k }) => !k.incoerente);
  if (!pendentes.length) return;
  const causaId = gatilho.tipo === 'INVALIDACAO' ? gatilho.causaId : null;
  const { candidatos, armadores } = await referenciasAtivas(c, organizationId, chave);

  if (candidatos.length === 0) {
    if (gatilho.tipo !== 'INVALIDACAO') return;
    for (const { p } of pendentes.filter(({ p }) => p.motivo === 'ARMADOR_INCOMPATIVEL')) {
      await c.query(
        `UPDATE identidade_pendencias
            SET estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA', decidido_em = now(), decidido_por_membership_id = $2,
                justificativa = $3, resolucao_fonte = $4, resolucao_evidencia_ref = $5, causa_invalidacao_id = $6
          WHERE id = $1`,
        [p.id, gatilho.autorMembershipId, gatilho.justificativa, gatilho.fonte, gatilho.evidenciaRef, gatilho.causaId],
      );
      await abrirPendencia(c, {
        organizationId, entidadeTipo: 'MASTER', motivo: 'MASTER_NAO_ENCONTRADO', referenciaOriginal: p.referencia_original, chave,
        armadorCodigo: p.armador_codigo, evidencia: { fonte: p.fonte, evidenciaRef: p.evidencia_ref, observadoEm: p.observado_em },
      });
    }
    return;
  }

  const masterId = candidatos[0];
  const uniao = new Set(armadores.get(masterId));
  for (const { k } of pendentes) if (k.armadorEfetivo) uniao.add(k.armadorEfetivo);
  if (uniao.size > 1) return;

  for (const { p, k } of pendentes) {
    const propria: Evidencia = { fonte: p.fonte, evidenciaRef: p.evidencia_ref, observadoEm: p.observado_em };
    await anexarReferencia(c, organizationId, masterId, p.referencia_original, k, propria);
    const resolucao = gatilho.tipo === 'OBSERVACAO' ? gatilho.evidencia : propria;
    await c.query(
      `UPDATE identidade_pendencias
          SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(),
              resolucao_fonte = $2, resolucao_evidencia_ref = $3, resolvido_master_id = $4, causa_invalidacao_id = $5
        WHERE id = $1`,
      [p.id, resolucao.fonte, resolucao.evidenciaRef, masterId, causaId],
    );
  }
}

/** Só leitura: nunca cria Master, referência nem pendência. */
export async function resolverMaster(
  db: Db, organizationId: string, ref: { mbl: string; armadorCodigo?: string | null },
): Promise<ResultadoResolucaoMaster> {
  const av = await avaliar(db, organizationId, chaveMaster(ref.mbl, ref.armadorCodigo));
  if (av.tipo === 'COMPATIVEL') return { status: 'RESOLVIDO', masterId: av.masterId };
  if (av.tipo === 'NOVO') return { status: 'NAO_RESOLVIDO', motivo: 'MASTER_NAO_ENCONTRADO', candidatos: [] };
  return { status: 'NAO_RESOLVIDO', motivo: 'ARMADOR_INCOMPATIVEL', candidatos: av.candidatos };
}

export async function registrarReferenciaMaster(
  db: Db, organizationId: string, ref: { mbl: string; armadorCodigo?: string | null }, origem: Origem,
): Promise<ResultadoRegistroMaster> {
  validarEvidencia(origem);
  if (origem.tipo !== 'DOCUMENTAL') {
    throw new ErroIdentidade('ORIGEM_NAO_DOCUMENTAL', 'referência de Master só é registrada a partir de fato documental');
  }
  const k = chaveMaster(ref.mbl, ref.armadorCodigo);
  return emTransacao(db, async (c) => {
    await travar(c, `s6:master:${organizationId}:${k.chave}`);

    const invalidada = await c.query(
      `SELECT i.id FROM master_referencias r JOIN identidade_pendencias i ON i.master_referencia_id = r.id
        WHERE r.organization_id = $1 AND r.chave_canonica = $2 AND r.armador_codigo IS NOT DISTINCT FROM $3::text
          AND r.fonte = $4 AND r.evidencia_ref = $5`,
      [organizationId, k.chave, k.armadorDeclarado, origem.fonte, origem.evidenciaRef],
    );
    if (invalidada.rows[0]) {
      return {
        status: 'NAO_RESOLVIDO', motivo: 'EVIDENCIA_INVALIDADA', pendenciaId: invalidada.rows[0].id,
        estadoPendencia: 'ENCERRADA_POR_EVIDENCIA_INVALIDA', candidatos: [],
      };
    }

    const av = await avaliar(c, organizationId, k);
    if (av.tipo !== 'INCOMPATIVEL') {
      const criado = av.tipo === 'NOVO';
      const masterId: string = criado
        ? (await c.query(`INSERT INTO masters (organization_id) VALUES ($1) RETURNING id`, [organizationId])).rows[0].id
        : av.masterId;
      const referenciaNova = await anexarReferencia(c, organizationId, masterId, ref.mbl, k, origem);
      await resolverPendenciasMasterPelaFonte(c, organizationId, k.chave, k.armadorDeclarado, origem, masterId);
      // Um Master novo na chave pode dar identidade às referências que tinham ficado sem candidato.
      if (criado) await reavaliarChaveMaster(c, organizationId, k.chave, { tipo: 'OBSERVACAO', evidencia: origem });
      return { status: 'RESOLVIDO', masterId, criado, referenciaNova };
    }

    const pendencia = await abrirPendencia(c, {
      organizationId, entidadeTipo: 'MASTER', motivo: 'ARMADOR_INCOMPATIVEL', referenciaOriginal: ref.mbl, chave: k.chave,
      armadorCodigo: k.armadorDeclarado, evidencia: origem,
    });
    return {
      status: 'NAO_RESOLVIDO', motivo: 'ARMADOR_INCOMPATIVEL', pendenciaId: pendencia.id, estadoPendencia: pendencia.estado,
      candidatos: av.candidatos,
    };
  });
}
