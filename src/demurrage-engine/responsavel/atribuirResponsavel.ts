import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { lockProcesso } from '../closing/materialChangeGuard';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';

/**
 * Produção P1 (filas pessoais) — ATRIBUIR / REATRIBUIR / RETIRAR o
 * responsável operacional de um processo.
 *
 * Reutiliza o contrato existente: o responsável continua sendo
 * `processos.responsavel_operacional_membership_id` (FK composta por
 * organização, CLIENT barrado por trigger da 0007, membership inativo barrado
 * pela 0049), e a escrita passa pelo MESMO ledger de observações do registro
 * (`field_observations` + `processo_campos_selecionados`) com a fonte nova
 * `atribuicao_interna` — prioridade acima de todas, então uma observação
 * posterior do handoff (fonte `outro`) nunca desfaz uma atribuição interna.
 *
 * Regras:
 *  - autor: membership MANAGER/ADMIN ATIVO da organização (o da sessão —
 *    nunca um id do cliente); ANALYST nunca atribui (nem a si mesmo). Fora do
 *    HTTP, só o operador de plataforma (CLI de implantação: atribuição
 *    inicial dos processos que chegaram sem responsável), registrado como tal;
 *  - novo responsável: membership interno ATIVO da MESMA organização, ou
 *    `null` (sem responsável); outra organização = mesmo erro de inexistente;
 *  - concorrência: `responsavelAtual` é OBRIGATÓRIO (compare-and-set) — se
 *    alguém mudou o responsável desde a leitura, `responsavel_alterado` com o
 *    valor atual; nenhuma atribuição se perde em silêncio. Tudo sob o lock
 *    consultivo do processo + `FOR UPDATE`;
 *  - processo FINAL → `processo_final_exige_reabertura` (reaberto = OPEN, pode);
 *  - idempotência ATÔMICA: `(organização, Idempotency-Key)` única na trilha;
 *    mesma chave + mesmo pedido DO MESMO AUTOR = mesma resposta, zero escrita;
 *    mesma chave + outro pedido ou outro autor = `idempotency_key_reutilizada`
 *    (o papel do autor é conferido ANTES do replay — um ANALYST nunca recebe
 *    o resultado de outra pessoa);
 *  - trilha append-only `processo_atribuicoes`: autor, anterior, novo, data,
 *    motivo (também para o pedido que não mudou nada — INALTERADO).
 */

export const VERSAO_HASH_ATRIBUICAO = 'acoes.atribuir_responsavel.v2';
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AutorAtribuicao =
  | { tipo: 'membership'; membershipId: string }
  | { tipo: 'operador_plataforma'; descricao: string };

export interface AtribuirResponsavelInput {
  organizationId: string;
  processoId: string;
  autor: AutorAtribuicao;
  novoMembershipId: string | null;
  responsavelAtual: string | null;
  motivo: string;
  idempotenciaChave: string;
  /** SÓ TESTE — dispara com o lock retido, logo antes do COMMIT. */
  _testeAntesDoCommit?: () => void | Promise<void>;
}

export type ResultadoAtribuicao =
  | {
      ok: true;
      resultado: 'ATRIBUIDO' | 'INALTERADO';
      replay: boolean;
      atribuicaoId: string;
      processoId: string;
      anterior: string | null;
      novo: string | null;
      em: string;
    }
  | {
      ok: false;
      motivo:
        | 'dados_invalidos' | 'processo_nao_encontrado' | 'apenas_manager_admin' | 'responsavel_invalido'
        | 'responsavel_alterado' | 'processo_final_exige_reabertura' | 'idempotency_key_reutilizada';
      campo?: string;
      responsavelAtual?: string | null;
    };

function chaveAutor(a: AutorAtribuicao): string {
  return a.tipo === 'membership' ? `membership:${a.membershipId}` : `operador:${a.descricao.trim()}`;
}

export function hashPedidoAtribuicao(i: Pick<AtribuirResponsavelInput, 'processoId' | 'autor' | 'novoMembershipId' | 'responsavelAtual' | 'motivo'>): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([VERSAO_HASH_ATRIBUICAO, i.processoId, chaveAutor(i.autor), i.novoMembershipId, i.responsavelAtual, i.motivo.trim()]))
    .digest('hex');
}

function deLinha(r: any, replay: boolean): Extract<ResultadoAtribuicao, { ok: true }> {
  return {
    ok: true, resultado: r.resultado, replay, atribuicaoId: r.id, processoId: r.processo_id,
    anterior: r.anterior_membership_id ?? null, novo: r.novo_membership_id ?? null, em: new Date(r.criado_em).toISOString(),
  };
}

async function replay(db: Pool | PoolClient, organizationId: string, chave: string, hash: string): Promise<ResultadoAtribuicao | null> {
  const { rows } = await db.query(
    `SELECT * FROM processo_atribuicoes WHERE organization_id = $1 AND idempotencia_chave = $2`,
    [organizationId, chave],
  );
  if (!rows.length) return null;
  if (rows[0].idempotencia_hash !== hash) return { ok: false, motivo: 'idempotency_key_reutilizada' };
  return deLinha(rows[0], true);
}

export async function atribuirResponsavel(pool: Pool, input: AtribuirResponsavelInput): Promise<ResultadoAtribuicao> {
  if (typeof input.motivo !== 'string' || !input.motivo.trim()) return { ok: false, motivo: 'dados_invalidos', campo: 'motivo' };
  if (input.autor.tipo === 'membership' ? !RE_UUID.test(input.autor.membershipId) : !input.autor.descricao?.trim()) {
    return { ok: false, motivo: 'apenas_manager_admin' };
  }
  if (input.novoMembershipId !== null && !RE_UUID.test(input.novoMembershipId)) return { ok: false, motivo: 'dados_invalidos', campo: 'membershipId' };
  if (input.responsavelAtual !== null && !RE_UUID.test(input.responsavelAtual)) return { ok: false, motivo: 'dados_invalidos', campo: 'responsavelAtual' };
  const motivo = input.motivo.trim().slice(0, 1000);
  const hash = hashPedidoAtribuicao(input);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockProcesso(client, input.processoId);
    const { rows: pr } = await client.query(
      `SELECT apuracao_status, responsavel_operacional_membership_id FROM processos WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.processoId, input.organizationId],
    );
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'processo_nao_encontrado' }; }

    let autorUsuarioId: string | null = null;
    if (input.autor.tipo === 'membership') {
      const { rows: autor } = await client.query(
        `SELECT usuario_id, papel, desativado_em FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
        [input.autor.membershipId, input.organizationId],
      );
      if (!autor.length || autor[0].desativado_em !== null || (autor[0].papel !== 'MANAGER' && autor[0].papel !== 'ADMIN')) {
        await client.query('ROLLBACK');
        return { ok: false, motivo: 'apenas_manager_admin' };
      }
      autorUsuarioId = autor[0].usuario_id;
    }

    const repetido = await replay(client, input.organizationId, input.idempotenciaChave, hash);
    if (repetido) { await client.query('ROLLBACK'); return repetido; }

    if (pr[0].apuracao_status === 'FINAL') { await client.query('ROLLBACK'); return { ok: false, motivo: 'processo_final_exige_reabertura' }; }

    if (input.novoMembershipId !== null) {
      const { rows: alvo } = await client.query(
        `SELECT 1 FROM organization_memberships
          WHERE id = $1 AND organization_id = $2 AND papel IN ('ANALYST', 'MANAGER', 'ADMIN') AND desativado_em IS NULL
          FOR SHARE`,
        [input.novoMembershipId, input.organizationId],
      );
      if (!alvo.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'responsavel_invalido' }; }
    }

    const atual: string | null = pr[0].responsavel_operacional_membership_id ?? null;
    if (atual !== input.responsavelAtual) {
      await client.query('ROLLBACK');
      return { ok: false, motivo: 'responsavel_alterado', responsavelAtual: atual };
    }

    let observationId: string | null = null;
    if (input.novoMembershipId !== atual) {
      // Instante estritamente crescente para a mesma fonte (chave única do ledger).
      const { rows: ult } = await client.query(
        `SELECT max(observado_em) AS ultimo FROM field_observations
          WHERE entidade_tipo = 'processo' AND entidade_id = $1 AND campo = 'responsavelOperacional' AND fonte = 'atribuicao_interna'`,
        [input.processoId],
      );
      const ultimo = ult[0].ultimo ? new Date(ult[0].ultimo).getTime() : 0;
      const observadoEm = new Date(Math.max(Date.now(), ultimo + 1));
      const { observacao } = await FieldObservationRepository.insertComClient(client, {
        organizationId: input.organizationId, entidadeTipo: 'processo', entidadeId: input.processoId, campo: 'responsavelOperacional',
        valor: input.novoMembershipId, fonte: 'atribuicao_interna', observadoEm, evidenciaRef: null, criadoPor: autorUsuarioId,
      });
      observationId = observacao.id;
      await client.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [input.processoId, input.novoMembershipId]);
      await client.query(
        `INSERT INTO processo_campos_selecionados (processo_id, organization_id, campo, observation_id)
         VALUES ($1, $2, 'responsavelOperacional', $3)
         ON CONFLICT (processo_id, campo) DO UPDATE SET observation_id = EXCLUDED.observation_id, atualizado_em = now()`,
        [input.processoId, input.organizationId, observationId],
      );
    }

    const { rows: ins } = await client.query(
      `INSERT INTO processo_atribuicoes (organization_id, processo_id, resultado, anterior_membership_id, novo_membership_id,
                                         autor_tipo, autor_membership_id, autor_usuario_id, autor_descricao,
                                         motivo, observation_id, idempotencia_chave, idempotencia_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (organization_id, idempotencia_chave) DO NOTHING
       RETURNING *`,
      [
        input.organizationId, input.processoId, observationId ? 'ATRIBUIDO' : 'INALTERADO', atual, input.novoMembershipId,
        input.autor.tipo, input.autor.tipo === 'membership' ? input.autor.membershipId : null, autorUsuarioId,
        input.autor.tipo === 'operador_plataforma' ? input.autor.descricao.trim().slice(0, 200) : null,
        motivo, observationId, input.idempotenciaChave, hash,
      ],
    );
    if (!ins.length) {
      // A mesma chave foi usada, ao mesmo tempo, em OUTRO processo: desfaz e
      // responde pela linha vencedora (pela mesma conexão, fora de transação).
      await client.query('ROLLBACK');
      return (await replay(client, input.organizationId, input.idempotenciaChave, hash)) ?? { ok: false, motivo: 'idempotency_key_reutilizada' };
    }
    if (input._testeAntesDoCommit) await input._testeAntesDoCommit();
    await client.query('COMMIT');
    return deLinha(ins[0], false);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
