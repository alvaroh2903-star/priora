import { PoolClient } from 'pg';
import { abrirPendenciaComClient, resolverPendenciasComClient } from '../registro/pendencias';

/**
 * Fase D15-B (R05/31.4b) — histórico APPEND-ONLY de tentativas de obtenção de
 * Free Time (House/Master), ligado à pendência `free_time_ausente` quando uma
 * existe. Satisfaz o enunciado literal do Blueprint: "Priora mostra as
 * fontes consultadas; Priora mostra o horário da última tentativa" — sem essa
 * tabela, só o valor final promovido ficava visível, nunca o histórico de
 * tentativas (inclusive as que não encontraram nada).
 *
 * `fonte_tentada` cobre tanto um sucesso (uma fonte real forneceu um valor —
 * `resultado: 'encontrado'`, registrado pelo chamador no momento em que
 * `applyObservationComClient`/`promoverMasterFreeTimeComClient` aceitam uma
 * observação NOVA e não-`manual_fallback`) quanto uma busca que não achou
 * nada (`resultado: 'nao_encontrado'`, hoje só na ingestão de Shipping
 * Instructions, que já detecta a ausência — ver `ingestaoShippingInstructions.ts`).
 * `manual_fallback` NUNCA é registrado aqui: é uma afirmação humana, não uma
 * fonte consultada.
 */

/** Sanitização leve (mesmo padrão já usado em `registrarIncidenteSync`): colapsa espaços, remove controle, limita tamanho — nunca uma redação profunda de PII. */
export function sanitizarEvidencia(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const limpa = String(raw).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return limpa ? limpa.slice(0, 500) : null;
}

export type CampoFreeTime = 'houseFreeTimeDays' | 'masterFreeTimeDays';

async function pendenciaAbertaId(db: PoolClient, processoId: string, containerId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id FROM demurrage_pendencias WHERE processo_id = $1 AND container_id = $2 AND tipo = 'free_time_ausente' AND estado = 'aberta'`,
    [processoId, containerId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Tentativa com SUCESSO: uma fonte real (nunca `manual_fallback`) forneceu um
 * valor novo, aceito no ledger (`criada = true` em `insertComClient`). Grava a
 * tentativa (ligada à pendência aberta, se houver) e resolve a pendência
 * `free_time_ausente` — o valor deixou de estar ausente.
 */
export async function registrarTentativaEncontrada(
  db: PoolClient,
  input: { organizationId: string; processoId: string; containerId: string; campo: CampoFreeTime; fonte: string; valor: unknown; observadoEm: Date; evidenciaRef?: string | null },
): Promise<void> {
  const pendenciaId = await pendenciaAbertaId(db, input.processoId, input.containerId);
  await db.query(
    `INSERT INTO free_time_tentativas (organization_id, processo_id, container_id, pendencia_id, campo, fonte_tentada, resultado, evidencia_sanitizada, detalhe)
     VALUES ($1,$2,$3,$4,$5,$6,'encontrado',$7,$8)`,
    [input.organizationId, input.processoId, input.containerId, pendenciaId, input.campo, input.fonte,
     sanitizarEvidencia(input.evidenciaRef ?? null), JSON.stringify({ valor: input.valor, observadoEm: input.observadoEm })],
  );
  if (pendenciaId) await resolverPendenciasComClient(db, input.processoId, input.containerId, ['free_time_ausente']);
}

/**
 * Tentativa SEM SUCESSO: uma fonte foi consultada e não encontrou o Free
 * Time. Abre (ou reaproveita) a pendência `free_time_ausente` e grava a
 * tentativa ligada a ela — idempotente por natureza do índice parcial de
 * `demurrage_pendencias` (uma ABERTA por processo/contêiner/tipo).
 */
export async function registrarTentativaNaoEncontrada(
  db: PoolClient,
  input: { organizationId: string; processoId: string; containerId: string; campo: CampoFreeTime; fonteTentada: string; motivo: string; evidenciaRef?: string | null },
): Promise<void> {
  const { id: pendenciaId } = await abrirPendenciaComClient(
    db, input.organizationId, input.processoId, input.containerId, 'free_time_ausente', { campo: input.campo, motivo: input.motivo },
  );
  await db.query(
    `INSERT INTO free_time_tentativas (organization_id, processo_id, container_id, pendencia_id, campo, fonte_tentada, resultado, evidencia_sanitizada, detalhe)
     VALUES ($1,$2,$3,$4,$5,$6,'nao_encontrado',$7,$8)`,
    [input.organizationId, input.processoId, input.containerId, pendenciaId, input.campo, input.fonteTentada,
     sanitizarEvidencia(input.evidenciaRef ?? null), JSON.stringify({ motivo: input.motivo })],
  );
}

export interface UltimaTentativaFreeTime {
  fonteTentada: string;
  resultado: 'encontrado' | 'nao_encontrado';
  tentativaEm: Date;
  evidenciaSanitizada: string | null;
}

/** Projeção read-only: a ÚLTIMA tentativa (de qualquer resultado) por contêiner+campo — "horário da última tentativa" exigido pelo Blueprint. */
export async function ultimaTentativaFreeTime(db: PoolClient, containerId: string, campo: CampoFreeTime): Promise<UltimaTentativaFreeTime | null> {
  const { rows } = await db.query(
    `SELECT fonte_tentada, resultado, tentativa_em, evidencia_sanitizada FROM free_time_tentativas
      WHERE container_id = $1 AND campo = $2 ORDER BY tentativa_em DESC, id DESC LIMIT 1`,
    [containerId, campo],
  );
  if (!rows.length) return null;
  return { fonteTentada: rows[0].fonte_tentada, resultado: rows[0].resultado, tentativaEm: rows[0].tentativa_em, evidenciaSanitizada: rows[0].evidencia_sanitizada };
}

/** Todas as fontes já consultadas (sucesso ou não) por contêiner+campo — "fontes consultadas" exigido pelo Blueprint. */
export async function fontesConsultadasFreeTime(db: PoolClient, containerId: string, campo: CampoFreeTime): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT fonte_tentada FROM free_time_tentativas WHERE container_id = $1 AND campo = $2 ORDER BY fonte_tentada`,
    [containerId, campo],
  );
  return rows.map((r) => r.fonte_tentada);
}
