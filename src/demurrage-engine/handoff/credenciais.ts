import { Pool } from 'pg';
import {
  carregarChavesCredencialDoAmbiente, cifrarSegredo, decifrarSegredo, gerarSegredoNovo, ChavesCredencial,
} from './credencialCrypto';

/**
 * Produção P1 (Entrega 1) — ciclo de vida das credenciais M2M do handoff.
 *
 * Deliberadamente SEM rota HTTP: provisionamento/rotação/desabilitação são
 * ações administrativas internas (chamadas de código/console), fora do
 * escopo desta entrega (nenhuma "rota de ação operacional" nova — ver limite
 * do diagnóstico). A verificação de assinatura (rota HTTP) só LÊ.
 *
 * Modelo de rotação: substituição ATÔMICA e IMEDIATAMENTE efetiva — o
 * segredo anterior para de validar no instante em que a rotação é
 * confirmada; não há janela de sobreposição nesta entrega (limitação
 * documentada no relatório final).
 */

let chavesCache: ChavesCredencial | null = null;
function chaves(): ChavesCredencial {
  if (!chavesCache) chavesCache = carregarChavesCredencialDoAmbiente();
  return chavesCache;
}

/** SÓ TESTE — força a releitura das chaves do ambiente na próxima chamada. */
export function _resetChavesCacheParaTeste(): void {
  chavesCache = null;
}

export interface CredencialProvisionada {
  id: string;
  /** Texto claro do segredo — devolvido SÓ UMA VEZ, no provisionamento/rotação. Nunca persistido em texto claro, nunca logado. */
  segredo: string;
}

export async function provisionarCredencial(pool: Pool, organizationId: string, nome: string): Promise<CredencialProvisionada> {
  const segredo = gerarSegredoNovo();
  // O AAD amarra o cifrado ao id da linha (ver `credencialCrypto.ts`); como o
  // id só existe após o INSERT, gera-se o id ANTES de cifrar (uma consulta
  // barata), em vez de deixar o Postgres escolher um id que a cifra não conheceria.
  const { rows } = await pool.query(`SELECT gen_random_uuid() AS id`);
  const id: string = rows[0].id;
  const enc = cifrarSegredo(chaves(), id, segredo);
  await pool.query(
    `INSERT INTO demurrage_handoff_credenciais (id, organization_id, nome, chave_versao, iv, auth_tag, segredo_cifrado)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, organizationId, nome, enc.chaveVersao, enc.iv, enc.authTag, enc.dados],
  );
  return { id, segredo };
}

export async function rotacionarCredencial(pool: Pool, credencialId: string): Promise<CredencialProvisionada> {
  const segredo = gerarSegredoNovo();
  const enc = cifrarSegredo(chaves(), credencialId, segredo);
  const { rowCount } = await pool.query(
    `UPDATE demurrage_handoff_credenciais
        SET chave_versao = $2, iv = $3, auth_tag = $4, segredo_cifrado = $5, rotacionada_em = now()
      WHERE id = $1`,
    [credencialId, enc.chaveVersao, enc.iv, enc.authTag, enc.dados],
  );
  if (!rowCount) throw new Error(`Credencial ${credencialId} não encontrada`);
  return { id: credencialId, segredo };
}

export async function desabilitarCredencial(pool: Pool, credencialId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE demurrage_handoff_credenciais SET status = 'DESABILITADA', desabilitada_em = now() WHERE id = $1 AND status = 'ATIVA'`,
    [credencialId],
  );
  if (!rowCount) throw new Error(`Credencial ${credencialId} não encontrada ou já desabilitada`);
}

export interface CredencialParaVerificacao {
  id: string;
  organizationId: string;
  status: 'ATIVA' | 'DESABILITADA';
  segredo: string;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Busca uma credencial para verificação de assinatura. Devolve `null` para
 * QUALQUER motivo de recusa (id mal formado, inexistente, desabilitada, ou
 * falha de descriptografia) — nunca distingue o motivo para quem chama, que
 * por sua vez devolve a MESMA resposta genérica de falha de autenticação
 * (não revela se a credencial existe).
 */
export async function buscarCredencialParaVerificacao(pool: Pool, credencialId: string): Promise<CredencialParaVerificacao | null> {
  if (!RE_UUID.test(credencialId)) return null;
  const { rows } = await pool.query(
    `SELECT id, organization_id, status, chave_versao, iv, auth_tag, segredo_cifrado
       FROM demurrage_handoff_credenciais WHERE id = $1`,
    [credencialId],
  );
  if (!rows.length || rows[0].status !== 'ATIVA') return null;
  const r = rows[0];
  try {
    const segredo = decifrarSegredo(chaves(), credencialId, {
      chaveVersao: r.chave_versao, iv: r.iv, authTag: r.auth_tag, dados: r.segredo_cifrado,
    });
    return { id: r.id, organizationId: r.organization_id, status: 'ATIVA', segredo };
  } catch {
    return null;
  }
}

/** Registra o uso de um nonce. `false` = nonce JÁ USADO para esta credencial (replay). */
export async function registrarNonce(pool: Pool, credencialId: string, nonce: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO demurrage_handoff_nonces (credencial_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [credencialId, nonce],
  );
  return (rowCount ?? 0) > 0;
}
