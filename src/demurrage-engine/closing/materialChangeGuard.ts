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
 *    `true` (o chamador traduz isso para `outcome: 'bloqueada_final'` e
 *    `exigeReabertura: true` — contrato canônico da D15-A v1.1, §3);
 *  - reprocessar a MESMA tentativa bloqueada (mesmo contêiner + campo +
 *    valorAnterior + valorNovo) não duplica o evento — dedupe por conteúdo,
 *    e é seguro sob concorrência real porque todo chamador (v1.1) só chega
 *    aqui depois de ter adquirido `lockProcesso` — nunca duas transações
 *    material-writer do MESMO processo executam esta checagem
 *    simultaneamente (ver `lockProcesso` abaixo e o documento de entrega).
 *
 * Não implementa aqui as regras gerais de D15-B (recência entre fontes,
 * cronologia, conflito de mesma fonte) — só a integridade de FINAL (D15-A).
 *
 * Fase D15-A v1.1 — ORDEM UNIVERSAL DE LOCK (corretiva, achados #1/#2):
 * toda escrita capaz de promover um dos cinco campos materiais, e toda
 * operação de fechamento/reabertura, segue a MESMA sequência, nesta ordem,
 * dentro de uma única transação:
 *   1. identifica o processo pelo contêiner/recurso, SEM lock de linha
 *      mutável (a FK `processo_id` é estável — nunca reatribuída);
 *   2. `lockProcesso` — `pg_advisory_xact_lock` por processo, ANTES de
 *      qualquer linha mutável;
 *   3. relê e trava (`FOR UPDATE`) a linha do processo;
 *   4. relê e trava (`FOR UPDATE`) a(s) linha(s) de contêiner (ordenadas por
 *      id quando mais de uma) e, quando aplicável, a linha de minuta/
 *      reabertura;
 *   5. persiste a observação bruta / executa a lógica de negócio;
 *   6. decide prioridade/gates reavaliando o estado relido no passo 3-4
 *      (nunca uma leitura anterior ao lock);
 *   7. promove OU bloqueia+registra, e comita tudo junto.
 * Como o lock consultivo (passo 2) é sempre o PRIMEIRO lock de qualquer
 * operação D15-A, duas operações no MESMO processo nunca disputam uma linha
 * em ordens opostas — a segunda fica bloqueada no passo 2 até a primeira
 * comitar/abortar, antes de tocar qualquer linha. Isso elimina tanto a
 * corrida do achado #1 (promoção depois de FINAL) quanto o deadlock do
 * achado #2 (ordens de lock inconsistentes).
 */

export type ExecutorSql = Pool | PoolClient;

/** Namespace do lock consultivo por processo (D15-A) — ver `closingService.ts`. */
export function chaveLockProcesso(processoId: string): string {
  return `demurrage:closing:${processoId}`;
}

/**
 * Lock consultivo por PROCESSO, escopo de transação (`pg_advisory_xact_lock`
 * — liberado automaticamente no COMMIT/ROLLBACK). ÚNICA implementação
 * reusada por `closingService.ts` e por todo escritor material (D15-A
 * v1.1) — garante que todas as operações usem exatamente a MESMA chave de
 * lock, nunca uma variante acidental que deixaria de serializar.
 */
export async function lockProcesso(db: ExecutorSql, processoId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [chaveLockProcesso(processoId)]);
}

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
  /**
   * Quando o chamador já relê `processo_id`/`apuracao_status` sob o lock
   * (passo 3-4 do protocolo universal — ver cabeçalho do arquivo), informa
   * aqui para evitar uma consulta redundante. Omitido → a função consulta
   * por conta própria (ainda correto, já que quem chama já está dentro da
   * mesma transação com os locks adquiridos — só uma consulta extra).
   */
  processoIdConhecido?: string;
  apuracaoStatusConhecido?: string;
  /**
   * SÓ TESTE (D15-A v1.1) — ponto único de pausa reusado por TODO escritor
   * material (contêiner, House/Master Free Time): dispara exatamente antes
   * da decisão final (promover × bloquear), já com o lock consultivo do
   * processo e as linhas relidas sob `FOR UPDATE` adquiridos pelo chamador.
   * Usado pelos testes de corrida (§ "Observation ... pauses before the
   * final decision"). Nunca usado em produção; nenhuma rota o expõe.
   */
  _testeAntesDaDecisaoFinal?: () => void | Promise<void>;
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
  if (input._testeAntesDaDecisaoFinal) await input._testeAntesDaDecisaoFinal();
  let processoId = input.processoIdConhecido;
  let status = input.apuracaoStatusConhecido;
  if (!processoId || !status) {
    const { rows } = await db.query(
      `SELECT c.processo_id, p.apuracao_status FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.id = $1`,
      [input.containerId],
    );
    if (!rows.length) return false;
    processoId = rows[0].processo_id;
    status = rows[0].apuracao_status;
  }
  if (status !== 'FINAL') return false;
  await registrarFatoMaterialPosFinal(db, {
    processoId: processoId!, containerId: input.containerId, campo: input.campo,
    valorAnterior: input.valorAnterior, valorNovo: input.valorNovo, origem: input.origem,
    atorUsuarioId: input.atorUsuarioId, evidenciaRef: input.evidenciaRef, extra: input.extra,
  });
  return true;
}
