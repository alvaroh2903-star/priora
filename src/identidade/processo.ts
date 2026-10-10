import { PoolClient } from 'pg';
import { Db, ErroIdentidade, Evidencia, Origem, emTransacao, travar, validarEvidencia } from './comum';
import { ehCodigoCompleto, limparCodigoProcesso } from './normalizacao';
import {
  ALIAS_ATIVO, EstadoPendencia, GatilhoReavaliacao, MotivoPendenciaProcesso, abrirPendencia, resolverPendenciasProcessoPelaFonte,
} from './pendencias';

/**
 * Identidade do Processo (N-3) sobre `processos.id`, a tabela central:
 *  1. casamento exato do código limpo em `processos.numero_processo`;
 *  2. alias comprovado e persistido (`processo_referencias`), reutilizado sem
 *     ser resolvido de novo — enquanto sua evidência não for provada inválida;
 *  3. sem identidade: código completo + origem DOCUMENTAL cria o processo
 *     (só organization_id + numero_processo); qualquer outro caso abre
 *     pendência de identidade e nada é criado.
 * Nunca há casamento por base sem sufixo, por similaridade ou por inferência:
 * quem chama passa a referência bruta, nunca o resultado de `processBase`.
 */

export type ResultadoResolucaoProcesso =
  | { status: 'RESOLVIDO'; processoId: string; via: 'CODIGO' | 'ALIAS' }
  | { status: 'NAO_RESOLVIDO'; motivo: MotivoSemIdentidade };

export type ResultadoRegistroProcesso =
  | { status: 'RESOLVIDO'; processoId: string; via: 'CODIGO' | 'ALIAS' | 'CRIADO' }
  | { status: 'NAO_RESOLVIDO'; motivo: MotivoSemIdentidade; pendenciaId: string; estadoPendencia: EstadoPendencia };

export type ResultadoAliasProcesso =
  | { status: 'ALIAS_REGISTRADO'; aliasId: string; criado: boolean; pendenciasResolvidas: string[] }
  | { status: 'CONFLITO'; motivo: 'REFERENCIA_E_OUTRO_PROCESSO' | 'REFERENCIA_JA_VINCULADA'; pendenciaId: string; estadoPendencia: EstadoPendencia }
  | { status: 'EVIDENCIA_INVALIDADA'; invalidacaoId: string };

type MotivoSemIdentidade = Exclude<MotivoPendenciaProcesso, 'ALIAS_CONFLITANTE' | 'EVIDENCIA_INVALIDADA'>;

function limpar(referencia: string): string {
  const limpa = limparCodigoProcesso(referencia);
  if (!limpa) throw new ErroIdentidade('REFERENCIA_VAZIA', 'referência de processo vazia');
  return limpa;
}

const motivoSemIdentidade = (limpa: string): MotivoSemIdentidade =>
  ehCodigoCompleto(limpa) ? 'PROCESSO_NAO_ENCONTRADO' : 'REFERENCIA_INCOMPLETA';

async function buscar(db: Db, organizationId: string, limpa: string): Promise<{ processoId: string; via: 'CODIGO' | 'ALIAS' } | null> {
  const exato = await db.query(
    `SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`,
    [organizationId, limpa],
  );
  if (exato.rows[0]) return { processoId: exato.rows[0].id, via: 'CODIGO' };
  const alias = await db.query(
    `SELECT r.processo_id FROM processo_referencias r
      WHERE r.organization_id = $1 AND r.referencia = $2 AND r.tipo = 'ALIAS' AND ${ALIAS_ATIVO}`,
    [organizationId, limpa],
  );
  if (alias.rows[0]) return { processoId: alias.rows[0].processo_id, via: 'ALIAS' };
  return null;
}

const travarReferencia = (c: PoolClient, organizationId: string, limpa: string) =>
  travar(c, `s6:processo:${organizationId}:${limpa}`);

/** Só leitura: nunca cria processo nem pendência. */
export async function resolverProcesso(db: Db, organizationId: string, referencia: string): Promise<ResultadoResolucaoProcesso> {
  const limpa = limpar(referencia);
  const achado = await buscar(db, organizationId, limpa);
  if (achado) return { status: 'RESOLVIDO', ...achado };
  return { status: 'NAO_RESOLVIDO', motivo: motivoSemIdentidade(limpa) };
}

/**
 * Registra uma observação de referência de processo. Idempotente: a mesma
 * observação devolve o mesmo resultado sem gravar nada novo.
 */
export async function registrarReferenciaProcesso(
  db: Db, organizationId: string, referencia: string, origem: Origem,
): Promise<ResultadoRegistroProcesso> {
  validarEvidencia(origem);
  const limpa = limpar(referencia);
  return emTransacao(db, async (c) => {
    await travarReferencia(c, organizationId, limpa);
    const achado = await buscar(c, organizationId, limpa);
    if (achado) return { status: 'RESOLVIDO', ...achado };

    if (ehCodigoCompleto(limpa) && origem.tipo === 'DOCUMENTAL') {
      const ins = await c.query(
        `INSERT INTO processos (organization_id, numero_processo) VALUES ($1, $2)
         ON CONFLICT (organization_id, numero_processo) DO NOTHING
         RETURNING id`,
        [organizationId, limpa],
      );
      // Sem linha: o processo acabou de ser criado por fora do S6 (caminho legado da Demurrage).
      if (!ins.rows[0]) {
        const depois = await buscar(c, organizationId, limpa);
        if (!depois) throw new ErroIdentidade('INVARIANTE_VIOLADA', `processo ${limpa} em conflito e não encontrado`);
        return { status: 'RESOLVIDO', ...depois };
      }
      const processoId: string = ins.rows[0].id;
      // Geração seguinte da referência: se o código já foi um alias, esse alias está invalidado (senão teria resolvido acima).
      await c.query(
        `INSERT INTO processo_referencias
           (organization_id, processo_id, tipo, referencia_original, referencia, geracao, fonte, evidencia_ref, observado_em)
         SELECT $1, $2, 'ORIGEM', $3, $4, coalesce(max(geracao), 0) + 1, $5, $6, $7
           FROM processo_referencias WHERE organization_id = $1 AND referencia = $4`,
        [organizationId, processoId, referencia, limpa, origem.fonte, origem.evidenciaRef, origem.observadoEm],
      );
      await resolverPendenciasProcessoPelaFonte(c, organizationId, limpa, processoId, origem, null);
      return { status: 'RESOLVIDO', processoId, via: 'CRIADO' };
    }

    const motivo = motivoSemIdentidade(limpa);
    const pendencia = await abrirPendencia(c, {
      organizationId, entidadeTipo: 'PROCESSO', motivo, referenciaOriginal: referencia, chave: limpa, armadorCodigo: null, evidencia: origem,
    });
    return { status: 'NAO_RESOLVIDO', motivo, pendenciaId: pendencia.id, estadoPendencia: pendencia.estado };
  });
}

/**
 * Alias comprovado (N-3): a evidência inequívoca liga `referencia` a um
 * processo da mesma organização e fecha, com ela, as pendências abertas da
 * referência. Se a evidência contradiz uma identidade existente — a referência
 * é o código de outro processo (IM2151 e IM2151-26 existentes são identidades
 * distintas) ou já é alias de outro processo —, nada é fundido nem
 * sobrescrito: abre-se ALIAS_CONFLITANTE com a evidência e o processo indicado.
 * Um alias cuja evidência foi invalidada fica no histórico e não resolve mais;
 * uma evidência NOVA pode restabelecer a referência na geração seguinte, mas a
 * evidência já declarada inválida nunca volta a sustentar o mesmo alias.
 */
export async function registrarAliasProcesso(db: Db, organizationId: string, p: {
  referencia: string;
  processoId: string;
  evidencia: Evidencia;
  registradoPorMembershipId?: string | null;
}): Promise<ResultadoAliasProcesso> {
  validarEvidencia(p.evidencia);
  const limpa = limpar(p.referencia);
  return emTransacao(db, async (c) => {
    await travarReferencia(c, organizationId, limpa);
    const alvo = await c.query(
      `SELECT numero_processo FROM processos WHERE id = $1 AND organization_id = $2`,
      [p.processoId, organizationId],
    );
    if (!alvo.rows[0]) throw new ErroIdentidade('PROCESSO_INEXISTENTE', `processo ${p.processoId} não existe nesta organização`);
    if (alvo.rows[0].numero_processo === limpa) {
      throw new ErroIdentidade('REFERENCIA_E_O_PROPRIO_CODIGO', `${limpa} já é o código do processo`);
    }
    const conflito = async (motivo: 'REFERENCIA_E_OUTRO_PROCESSO' | 'REFERENCIA_JA_VINCULADA'): Promise<ResultadoAliasProcesso> => {
      const pendencia = await abrirPendencia(c, {
        organizationId, entidadeTipo: 'PROCESSO', motivo: 'ALIAS_CONFLITANTE', referenciaOriginal: p.referencia, chave: limpa,
        armadorCodigo: null, processoIndicadoId: p.processoId, evidencia: p.evidencia,
      });
      return { status: 'CONFLITO', motivo, pendenciaId: pendencia.id, estadoPendencia: pendencia.estado };
    };
    const outro = await c.query(
      `SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`,
      [organizationId, limpa],
    );
    if (outro.rows[0]) return conflito('REFERENCIA_E_OUTRO_PROCESSO');
    const { rows: geracoes } = await c.query(
      `SELECT r.id, r.processo_id, r.geracao, r.fonte, r.evidencia_ref,
              (SELECT i.id FROM identidade_pendencias i WHERE i.processo_referencia_id = r.id) AS invalidacao_id
         FROM processo_referencias r WHERE r.organization_id = $1 AND r.referencia = $2
        ORDER BY r.geracao`,
      [organizationId, limpa],
    );
    const ativa = geracoes.find((g) => !g.invalidacao_id);
    if (ativa) {
      if (ativa.processo_id !== p.processoId) return conflito('REFERENCIA_JA_VINCULADA');
      return { status: 'ALIAS_REGISTRADO', aliasId: ativa.id, criado: false, pendenciasResolvidas: [] };
    }
    const invalidada = geracoes.find((g) => g.fonte === p.evidencia.fonte && g.evidencia_ref === p.evidencia.evidenciaRef);
    if (invalidada) return { status: 'EVIDENCIA_INVALIDADA', invalidacaoId: invalidada.invalidacao_id };
    const ins = await c.query(
      `INSERT INTO processo_referencias
         (organization_id, processo_id, tipo, referencia_original, referencia, geracao, fonte, evidencia_ref, observado_em,
          registrado_por_membership_id)
       VALUES ($1, $2, 'ALIAS', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [organizationId, p.processoId, p.referencia, limpa, Math.max(0, ...geracoes.map((g) => g.geracao)) + 1, p.evidencia.fonte, p.evidencia.evidenciaRef,
        p.evidencia.observadoEm, p.registradoPorMembershipId ?? null],
    );
    const pendenciasResolvidas = await resolverPendenciasProcessoPelaFonte(
      c, organizationId, limpa, p.processoId, p.evidencia, p.registradoPorMembershipId ?? null,
    );
    return { status: 'ALIAS_REGISTRADO', aliasId: ins.rows[0].id, criado: true, pendenciasResolvidas };
  });
}

/**
 * Reavaliação LOCAL da chave de um processo depois que uma evidência caiu
 * (alias invalidado ou ALIAS_CONFLITANTE encerrado por evidência inválida).
 * Nada fora da chave é lido ou escrito. Se a referência ainda tem identidade
 * ativa, os conflitos com ela continuam. Senão:
 *  - observações que só resolviam pela identidade que caiu voltam a ficar
 *    pendentes (a pendência resolvida fica no histórico);
 *  - reivindicações de alias com evidência válida apontando para UM único
 *    processo → o alias é registrado (geração seguinte) com a evidência da
 *    primeira, e as pendências da chave são resolvidas, com a causa;
 *  - nenhuma reivindicação, ou várias para processos diferentes → nada é
 *    escolhido: nenhuma identidade é inventada e os conflitos seguem abertos.
 */
export async function reavaliarChaveProcesso(
  c: PoolClient, organizationId: string, chave: string,
  gatilho: Extract<GatilhoReavaliacao, { tipo: 'INVALIDACAO' }>, processoQueCaiu: string | null,
): Promise<void> {
  if (await buscar(c, organizationId, chave)) return;

  if (processoQueCaiu) {
    const { rows } = await c.query(
      `SELECT DISTINCT ON (motivo, fonte, evidencia_ref) motivo, referencia_original, fonte, evidencia_ref, observado_em
         FROM identidade_pendencias
        WHERE organization_id = $1 AND entidade_tipo = 'PROCESSO' AND chave = $2 AND estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE'
          AND motivo IN ('REFERENCIA_INCOMPLETA', 'PROCESSO_NAO_ENCONTRADO') AND resolvido_processo_id = $3
        ORDER BY motivo, fonte, evidencia_ref`,
      [organizationId, chave, processoQueCaiu],
    );
    for (const p of rows) {
      await abrirPendencia(c, {
        organizationId, entidadeTipo: 'PROCESSO', motivo: p.motivo, referenciaOriginal: p.referencia_original, chave, armadorCodigo: null,
        evidencia: { fonte: p.fonte, evidenciaRef: p.evidencia_ref, observadoEm: p.observado_em },
      });
    }
  }

  const { rows: reivindicacoes } = await c.query(
    `SELECT p.id, p.processo_indicado_id, p.referencia_original, p.fonte, p.evidencia_ref, p.observado_em
       FROM identidade_pendencias p
      WHERE p.organization_id = $1 AND p.entidade_tipo = 'PROCESSO' AND p.chave = $2 AND p.motivo = 'ALIAS_CONFLITANTE'
        AND p.estado IN ('ABERTA', 'EM_ANALISE')
        AND NOT EXISTS (
          SELECT 1 FROM processo_referencias r JOIN identidade_pendencias i ON i.processo_referencia_id = r.id
           WHERE r.organization_id = p.organization_id AND r.referencia = p.chave AND r.fonte = p.fonte AND r.evidencia_ref = p.evidencia_ref)
      ORDER BY p.observado_em, p.criado_em, p.id`,
    [organizationId, chave],
  );
  if (new Set(reivindicacoes.map((r) => r.processo_indicado_id)).size !== 1) return;
  const primeira = reivindicacoes[0];
  const alvo: string = primeira.processo_indicado_id;
  await c.query(
    `INSERT INTO processo_referencias
       (organization_id, processo_id, tipo, referencia_original, referencia, geracao, fonte, evidencia_ref, observado_em)
     SELECT $1, $2, 'ALIAS', $3, $4, coalesce(max(geracao), 0) + 1, $5, $6, $7
       FROM processo_referencias WHERE organization_id = $1 AND referencia = $4`,
    [organizationId, alvo, primeira.referencia_original, chave, primeira.fonte, primeira.evidencia_ref, primeira.observado_em],
  );
  await c.query(
    `UPDATE identidade_pendencias
        SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), resolucao_fonte = fonte, resolucao_evidencia_ref = evidencia_ref,
            resolvido_processo_id = $2, causa_invalidacao_id = $3
      WHERE id = ANY($1::uuid[])`,
    [reivindicacoes.map((r) => r.id), alvo, gatilho.causaId],
  );
  await c.query(
    `UPDATE identidade_pendencias
        SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), resolucao_fonte = $3, resolucao_evidencia_ref = $4,
            resolvido_processo_id = $5, causa_invalidacao_id = $6
      WHERE organization_id = $1 AND entidade_tipo = 'PROCESSO' AND chave = $2 AND estado IN ('ABERTA', 'EM_ANALISE')
        AND motivo IN ('REFERENCIA_INCOMPLETA', 'PROCESSO_NAO_ENCONTRADO')`,
    [organizationId, chave, primeira.fonte, primeira.evidencia_ref, alvo, gatilho.causaId],
  );
}
