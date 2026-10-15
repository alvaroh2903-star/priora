import { Pool } from 'pg';
import { TipoDemurragePendencia, TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS } from './pendenciaCatalogo';

/**
 * Produção P1 (Entrega 2 v1.1, corretiva — achado #3 da auditoria):
 * `validarComandoPendencia` (acoes/pendenciaCatalogo.ts) só confere que a
 * combinação família/ação/tipo PEDIDA NO CORPO pertence ao catálogo
 * suportado — nunca compara contra o tipo REALMENTE persistido na linha de
 * `demurrage_pendencias`. Isso deixava uma lacuna: um chamador podia pedir
 * um tipo suportado qualquer (ex.: `armador_ausente`) enquanto o
 * `pendenciaId` apontava para uma linha persistida de OUTRO tipo
 * (ex.: `mbl_ausente`) — `resolverPendenciaManual` resolve pelo `id`, sem
 * olhar `tipo`, e resolveria do mesmo jeito.
 *
 * Esta leitura resolve a lacuna: carrega a linha persistida (organização,
 * tipo, estado) e `verificarTipoPendenciaPersistido` exige que o tipo
 * pedido seja EXATAMENTE o tipo persistido — E que o tipo persistido
 * pertença ao catálogo suportado (defesa em profundidade: mesmo que uma
 * migration futura amplie o `CHECK` de `demurrage_pendencias.tipo` antes
 * deste catálogo acompanhar, uma linha do tipo novo nunca é resolvível por
 * aqui "disfarçada" de um tipo antigo suportado). VesselCall/tracking/
 * tarifa nunca entram: `buscarPendenciaPersistida` só lê
 * `demurrage_pendencias` — um id de outra tabela simplesmente não é
 * encontrado (a rota já trata isso como 404, idêntico a inexistente).
 */

export interface PendenciaPersistida {
  organizationId: string;
  tipo: string;
  estado: 'aberta' | 'resolvida';
}

export async function buscarPendenciaPersistida(pool: Pool, pendenciaId: string): Promise<PendenciaPersistida | null> {
  const { rows } = await pool.query(
    `SELECT organization_id AS "organizationId", tipo, estado FROM demurrage_pendencias WHERE id = $1`,
    [pendenciaId],
  );
  return rows[0] ?? null;
}

/**
 * `null` quando o tipo pedido bate com o persistido E o persistido está no
 * catálogo suportado; uma string explicando a rejeição quando não bate —
 * sempre ANTES de qualquer chamada a `resolverPendenciaManual` (zero escrita
 * no caminho de rejeição).
 */
export function verificarTipoPendenciaPersistido(persistida: PendenciaPersistida, tipoPedido: unknown): string | null {
  if (!TIPOS_DEMURRAGE_PENDENCIA_SUPORTADOS.includes(persistida.tipo as TipoDemurragePendencia)) {
    return 'tipo_persistido_nao_suportado';
  }
  if (persistida.tipo !== tipoPedido) return 'tipo_divergente_do_persistido';
  return null;
}
