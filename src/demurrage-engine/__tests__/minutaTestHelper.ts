import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Readable } from 'stream';
import { CivilDate } from '../temporal/civilDate';
import { ClosingService } from '../closing/closingService';
import { ArmazenamentoMemoria } from '../documentos/armazenamentoMemoria';
import { novaChaveObjeto } from '../documentos/servico';
import { registrarMinutaTecnica } from '../closing/minutaTecnica';
import { novoGestor, novoMembro } from './responsabilidadeTestHelper';

/**
 * Produção P1 (correção de minuta) — conveniência dos testes para o fluxo
 * ÚNICO de minuta: o ANALISTA registra a minuta com o documento e a
 * verificação técnica automática decide o estado no próprio registro.
 * Substitui, nos testes congelados que só precisavam de "uma minuta
 * comprovando a devolução", o par antigo `registrarMinuta` + `validarMinuta`
 * (aprovação de gestor, removida). Não é um bypass: chama o serviço real.
 *
 * Produção P1 (arquivos de minuta): o documento da minuta passa a ser um
 * ARQUIVO armazenado (`documento: { documentoId }`). Os testes congelados que
 * só precisam de "uma minuta com documento" usam `documentoArmazenadoDeTeste`:
 * uma fixture que grava EXATAMENTE o que o serviço de upload grava ao fim do
 * fluxo (documento DISPONIVEL, tentativa ACEITA, objeto no provedor em
 * memória `armazenamentoDeTeste`) — o upload em si (autorização, streaming,
 * assinatura, hash) é coberto pelos testes de `arquivosMinutaP1*.test.ts`.
 */

/** Provedor em memória compartilhado pelos testes que não injetam o próprio. */
export const armazenamentoDeTeste = new ArmazenamentoMemoria();

/** PDF mínimo válido (assinatura `%PDF-` e trailer `%%EOF`), único por `tag`. */
export function pdfDeTeste(tag: string = randomUUID()): Buffer {
  return Buffer.from(`%PDF-1.4\n% minuta de teste ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

export async function documentoArmazenadoDeTeste(
  pool: Pool, p: { containerId: string; autorMembershipId?: string; conteudo?: Buffer; nome?: string },
): Promise<string> {
  const conteudo = p.conteudo ?? pdfDeTeste();
  const { rows: c } = await pool.query(
    `SELECT c.organization_id, c.processo_id, pr.responsavel_operacional_membership_id AS responsavel
       FROM containers c JOIN processos pr ON pr.id = c.processo_id WHERE c.id = $1`,
    [p.containerId],
  );
  if (!c.length) throw new Error('documentoArmazenadoDeTeste: contêiner inexistente');
  let autor = p.autorMembershipId ?? c[0].responsavel ?? null;
  if (!autor) {
    const { rows: m } = await pool.query(
      `SELECT id FROM organization_memberships WHERE organization_id = $1 AND desativado_em IS NULL ORDER BY criado_em, id LIMIT 1`,
      [c[0].organization_id],
    );
    autor = m[0]?.id ?? await novoMembro(pool, c[0].organization_id, 'ANALYST');
  }
  const { rows: u } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [autor]);
  const id = randomUUID();
  const chave = novaChaveObjeto();
  const sha256 = createHash('sha256').update(conteudo).digest('hex');
  await armazenamentoDeTeste.gravar(chave, Readable.from([conteudo]), conteudo.length, 'application/pdf');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO documentos_armazenados (
         id, organization_id, processo_id, container_id, finalidade, chave_objeto, nome_original, tipo_declarado, tamanho_declarado,
         tipo_detectado, tamanho_bytes, sha256, estado, autor_membership_id, autor_usuario_id, expira_em, recebido_em, disponivel_em,
         correlacao_id, idempotencia_chave, idempotencia_hash
       ) VALUES ($1, $2, $3, $4, 'minuta_devolucao', $5, $6, 'application/pdf', $7, 'application/pdf', $7, $8, 'DISPONIVEL', $9, $10,
                 now() + interval '1 day', now(), now(), $11, $12, $13)`,
      [id, c[0].organization_id, c[0].processo_id, p.containerId, chave, p.nome ?? `minuta-${id.slice(0, 8)}.pdf`, conteudo.length, sha256,
        autor, u[0].usuario_id, randomUUID(), `fixture:${id}`, createHash('sha256').update(`fixture:${id}`).digest('hex')],
    );
    await client.query(
      `INSERT INTO documentos_armazenados_envios (id, organization_id, documento_id, chave_objeto, token, estado, idempotencia_chave, encerrado_em)
       VALUES ($1, $2, $3, $4, $5, 'ACEITO', $6, now())`,
      [randomUUID(), c[0].organization_id, id, chave, randomUUID(), `fixture:${id}`],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return id;
}

/** `documento` do corpo de registro de minuta com um arquivo armazenado novo do contêiner. */
export async function documentoDeTeste(pool: Pool, containerId: string, autorMembershipId?: string): Promise<{ documentoId: string }> {
  return { documentoId: await documentoArmazenadoDeTeste(pool, { containerId, autorMembershipId }) };
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
    evidenciaRef: p.evidenciaRef ?? null, documento: await documentoDeTeste(pool, p.containerId, membershipId), config: { hoje: p.hoje },
  });
  if (!r.ok) throw new Error(`registrarMinutaDeTeste: registro recusado (${r.motivo})`);
  return r;
}

/**
 * Produção P1 (arquivos de minuta) — COMPROVAÇÃO para os testes congelados
 * que encerram um contêiner com demurrage: antes, uma minuta legada VALIDADA
 * (aprovação humana antiga) bastava; agora o encerramento exige a minuta
 * técnica ACEITA com o ARQUIVO armazenado e disponível. Registra pelo serviço
 * técnico (`registrarMinutaTecnica`, que NÃO dispara o encerramento — o teste
 * continua acionando a finalização como antes), com a devolução do tracking
 * igual à data da minuta (a efetiva legada do cenário não muda: os relógios
 * seguem a mesma data final).
 */
export async function minutaAceitaComArquivoDeTeste(
  pool: Pool, p: { containerId: string; numero: string | null; data: string; hoje: CivilDate },
): Promise<string> {
  await pool.query(`UPDATE containers SET tracking_return_date = $2 WHERE id = $1 AND tracking_return_date IS NULL`, [p.containerId, p.data]);
  const { rows } = await pool.query(`SELECT organization_id FROM containers WHERE id = $1`, [p.containerId]);
  const gestor = await novoGestor(pool, rows[0].organization_id);
  const r = await registrarMinutaTecnica(pool, {
    containerId: p.containerId, membershipId: gestor, numeroInformado: p.numero, dataInformada: p.data,
    documento: await documentoDeTeste(pool, p.containerId, gestor), hoje: p.hoje,
  });
  if (!r.ok || r.minuta.estado !== 'ACEITA') throw new Error(`minutaAceitaComArquivoDeTeste: ${JSON.stringify(r.ok ? r.minuta.estado : r)}`);
  return r.minuta.id;
}
