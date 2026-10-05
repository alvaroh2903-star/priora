import { Pool, PoolClient } from 'pg';

/**
 * Fase D15-A (Blueprint 31.7b) — guarda central de "fato material recebido
 * após FINAL". Cobre exatamente os cinco fatos listados no escopo aprovado:
 * descarga, House/Master Free Time, tipo de equipamento e retorno de
 * tracking — todos campos físicos do contêiner que, uma vez congelados pelo
 * fechamento (processo FINAL), nunca podem ser alterados silenciosamente.
 *
 * Comportamento exigido:
 *  - a observação BRUTA (ledger `field_observations`) já é preservada por
 *    quem chama esta função ANTES de chamá-la — esta guarda nunca impede o
 *    registro da evidência, só a PROMOÇÃO ao valor selecionado;
 *  - reprocessar o MESMO valor (idêntico ao já selecionado) nunca bloqueia
 *    nem gera evento — idempotente, nunca cria uma exigência de reabertura
 *    falsa;
 *  - um valor DIFERENTE, com o processo FINAL, nunca é promovido: a função
 *    registra um evento auditável (`FATO_MATERIAL_POS_FINAL`) e devolve
 *    `bloqueadoPorFinal: true`; quem chama deve então pular o UPDATE que
 *    promoveria o fato;
 *  - reprocessar a MESMA tentativa bloqueada (mesmo contêiner + campo +
 *    valorAnterior + valorNovo) não duplica o evento — dedupe por conteúdo.
 *
 * Não implementa aqui as regras gerais de D15-B (recência entre fontes,
 * cronologia, conflito de mesma fonte) — só a integridade de FINAL (D15-A).
 */

export type ExecutorSql = Pool | PoolClient;

function valoresIguais(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  return JSON.stringify(na) === JSON.stringify(nb);
}

export interface RegistrarFatoMaterialInput {
  processoId: string;
  containerId: string;
  /** Rótulo do fato: 'dischargeDate' | 'houseFreeTimeDays' | 'masterFreeTimeDays' | 'containerType' | 'trackingReturnDate' | 'minutaDivergente' | ... */
  campo: string;
  valorAnterior: unknown;
  valorNovo: unknown;
  origem?: 'automatico' | 'humano';
  atorUsuarioId?: string | null;
  evidenciaRef?: string | null;
  /** Dados adicionais do evento (ex.: minutaId, observationId, fonte) — nunca o payload documental bruto. */
  extra?: Record<string, unknown>;
}

/**
 * Registra o evento `FATO_MATERIAL_POS_FINAL`, idempotente por conteúdo
 * (mesmo contêiner + campo + par de valores não duplica). Não verifica por
 * si só se o processo está FINAL — quem chama já decidiu que deve registrar.
 */
export async function registrarFatoMaterialPosFinal(
  db: ExecutorSql,
  input: RegistrarFatoMaterialInput,
): Promise<{ jaRegistrado: boolean }> {
  const valorAnteriorJson = JSON.stringify(input.valorAnterior === undefined ? null : input.valorAnterior);
  const valorNovoJson = JSON.stringify(input.valorNovo === undefined ? null : input.valorNovo);
  const { rows } = await db.query(
    `SELECT 1 FROM closing_events
      WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'
        AND payload->>'campo' = $2
        AND payload->'valorAnterior' = $3::jsonb AND payload->'valorNovo' = $4::jsonb
      LIMIT 1`,
    [input.containerId, input.campo, valorAnteriorJson, valorNovoJson],
  );
  if (rows.length) return { jaRegistrado: true };
  const payload = {
    campo: input.campo, valorAnterior: input.valorAnterior ?? null, valorNovo: input.valorNovo ?? null,
    ...(input.extra ?? {}),
  };
  await db.query(
    `INSERT INTO closing_events (processo_id, container_id, tipo_evento, origem, ator_usuario_id, evidencia_ref, payload)
     VALUES ($1, $2, 'FATO_MATERIAL_POS_FINAL', $3, $4, $5, $6)`,
    [
      input.processoId, input.containerId, input.origem ?? 'automatico',
      input.atorUsuarioId ?? null, input.evidenciaRef ?? null, JSON.stringify(payload),
    ],
  );
  return { jaRegistrado: false };
}

export interface FatoMaterialBloqueadoInput {
  containerId: string;
  campo: string;
  valorAnterior: unknown;
  valorNovo: unknown;
  origem?: 'automatico' | 'humano';
  atorUsuarioId?: string | null;
  evidenciaRef?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * Decide se a promoção de `campo` para `valorNovo` deve ser BLOQUEADA porque
 * o processo do contêiner está FINAL. Três saídas:
 *  - valores iguais → nunca bloqueia (reconfirmação idempotente, sem evento);
 *  - processo não é FINAL → nunca bloqueia (comportamento normal, D15-B decide o resto);
 *  - processo FINAL e valores diferentes → registra o evento e bloqueia.
 */
export async function fatoMaterialBloqueadoPorFinal(
  db: ExecutorSql,
  input: FatoMaterialBloqueadoInput,
): Promise<boolean> {
  if (valoresIguais(input.valorAnterior, input.valorNovo)) return false;
  const { rows } = await db.query(
    `SELECT c.processo_id, p.apuracao_status FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.id = $1`,
    [input.containerId],
  );
  if (!rows.length || rows[0].apuracao_status !== 'FINAL') return false;
  await registrarFatoMaterialPosFinal(db, {
    processoId: rows[0].processo_id, containerId: input.containerId, campo: input.campo,
    valorAnterior: input.valorAnterior, valorNovo: input.valorNovo, origem: input.origem,
    atorUsuarioId: input.atorUsuarioId, evidenciaRef: input.evidenciaRef, extra: input.extra,
  });
  return true;
}
