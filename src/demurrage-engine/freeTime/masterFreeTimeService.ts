import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { FieldObservationRepository, assertFonteAutorizada } from '../persistence/fieldObservationRepository';

/**
 * Serviço CENTRAL de promoção do Master Free Time.
 *
 * Toda entrada que registra `masterFreeTimeDays` passa por aqui — Shipping
 * Instructions, Master BL, HeadCargo, confirmação manual e backfill (via
 * `ContainerRepository.applyObservation`). Assim a divergência SI × Master é
 * detectada independentemente da ordem de chegada e de qual pipeline trouxe o
 * fato: SI hoje com 14 e Master amanhã com 10 abre a divergência no momento em
 * que o Master é gravado, sem precisar reprocessar a SI.
 *
 * Numa ÚNICA transação (a do `client` do chamador), grava: a observação; a
 * promoção do valor selecionado; a divergência (abrir/atualizar/resolver/
 * reabrir); seus eventos append-only; as entregas PENDING; e o outbox de
 * recálculo — só quando o valor efetivamente selecionado muda. O cálculo NÃO
 * roda aqui: o worker do outbox chama `recalcularApuracaoContainer`.
 *
 * Seleção: a mesma regra de `applyObservation` (fonte nova promove quando sua
 * prioridade é >= a da fonte do valor atual). Hierarquia do Master FT:
 * master_bl 90 > shipping_instructions 85 > headcargo 80 > manual_fallback 70 >
 * email_heuristic 50 > outro 10. `tracking_service` é rejeitado.
 */

export const CAMPO_MASTER_FT = 'masterFreeTimeDays';

export class ValorFreeTimeInvalidoError extends Error {
  constructor(valor: unknown) {
    super(`Master Free Time inválido: ${JSON.stringify(valor)} (aceita apenas inteiro >= 0).`);
    this.name = 'ValorFreeTimeInvalidoError';
  }
}

/** Zero é válido e explícito; negativo, decimal, NaN ou não numérico são inválidos. */
export function valorFreeTimeValido(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export interface PromoverMasterFreeTimeInput {
  organizationId: string;
  containerId: string;
  valor: number;
  fonte: FieldObservationSource;
  observadoEm: Date;
  evidenciaRef?: string | null;
  criadoPor?: string | null;
  /** Quem/qual processamento originou (auditoria dos eventos). */
  autor: string;
}

export interface DivergenciaAvaliada {
  id: string;
  estado: 'aberta' | 'reconhecida' | 'resolvida' | 'reaberta';
  ocorrenciaSeq: number;
  evento: 'aberta' | 'reaberta' | 'atualizada' | 'resolvida' | null;
}

export interface PromoverMasterFreeTimeResultado {
  observationId: string;
  /** false = a observação já existia (reprocessamento da mesma fonte/instante). */
  criada: boolean;
  outcome: 'promovida' | 'registrada_sem_promover';
  valorSelecionadoAnterior: number | null;
  valorSelecionado: number | null;
  valorMudou: boolean;
  recalculoEnfileirado: boolean;
  divergencia: DivergenciaAvaliada | null;
  /**
   * A mesma fonte já registrou este campo no MESMO instante com OUTRO valor
   * (ex.: nova versão da mesma mensagem). Nada é promovido; o chamador decide
   * a pendência. O ledger nunca é sobrescrito.
   */
  conflitoMesmaFonte: boolean;
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Promove um Master Free Time DENTRO da transação do chamador. Não faz
 * BEGIN/COMMIT: quem chama agrupa observação, proveniência, pendências etc. na
 * mesma unidade atômica.
 */
export async function promoverMasterFreeTimeComClient(
  client: PoolClient,
  input: PromoverMasterFreeTimeInput,
): Promise<PromoverMasterFreeTimeResultado> {
  if (!valorFreeTimeValido(input.valor)) throw new ValorFreeTimeInvalidoError(input.valor);
  assertFonteAutorizada(CAMPO_MASTER_FT, input.fonte);

  // Serializa promoções concorrentes do mesmo contêiner.
  const { rows: cr } = await client.query(
    `SELECT id, organization_id, processo_id, master_free_time_days, master_free_time_observation_id
       FROM containers WHERE id = $1 FOR UPDATE`,
    [input.containerId],
  );
  const c = cr[0];
  if (!c) throw new Error(`Contêiner ${input.containerId} não encontrado.`);
  if (c.organization_id !== input.organizationId) {
    throw new Error(`Contêiner ${input.containerId} não pertence à organização ${input.organizationId}.`);
  }

  const { observacao, criada } = await FieldObservationRepository.insertComClient(client, {
    organizationId: input.organizationId, entidadeTipo: 'container', entidadeId: input.containerId,
    campo: CAMPO_MASTER_FT, valor: input.valor, fonte: input.fonte, observadoEm: input.observadoEm,
    evidenciaRef: input.evidenciaRef, criadoPor: input.criadoPor,
  });

  const anterior = numero(c.master_free_time_days);
  const conflito = !criada && numero(observacao.valor) !== input.valor;

  let outcome: 'promovida' | 'registrada_sem_promover' = 'registrada_sem_promover';
  let selecionado = anterior;
  // Só um fato NOVO altera a seleção: reprocessar uma observação existente
  // nunca muda o estado (sua promoção já foi decidida na transação original).
  if (criada) {
    let promover = true;
    if (c.master_free_time_observation_id) {
      const { rows: atual } = await client.query(`SELECT fonte FROM field_observations WHERE id = $1`, [c.master_free_time_observation_id]);
      const fonteAtual = atual[0]?.fonte as FieldObservationSource | undefined;
      if (fonteAtual) promover = FIELD_OBSERVATION_SOURCE_PRIORITY[input.fonte] >= FIELD_OBSERVATION_SOURCE_PRIORITY[fonteAtual];
    }
    if (promover) {
      await client.query(
        `UPDATE containers SET master_free_time_days = $2, master_free_time_observation_id = $3, atualizado_em = now() WHERE id = $1`,
        [input.containerId, input.valor, observacao.id],
      );
      outcome = 'promovida';
      selecionado = input.valor;
    }
  } else if (c.master_free_time_observation_id === observacao.id) {
    outcome = 'promovida';
  }

  const valorMudou = selecionado !== anterior;
  let recalculoEnfileirado = false;
  if (valorMudou) {
    // Outbox na MESMA transação; idempotente por (contêiner, tipo, observação promovida).
    const { rowCount } = await client.query(
      `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave)
       VALUES ($1, $2, 'master_free_time', $3)
       ON CONFLICT (container_id, tipo, chave) DO NOTHING`,
      [input.organizationId, input.containerId, observacao.id],
    );
    recalculoEnfileirado = (rowCount ?? 0) > 0;
  }

  const divergencia = await avaliarDivergenciaComClient(client, {
    organizationId: input.organizationId, containerId: input.containerId, processoId: c.processo_id, autor: input.autor,
  });

  return {
    observationId: observacao.id, criada, outcome, valorSelecionadoAnterior: anterior, valorSelecionado: selecionado,
    valorMudou, recalculoEnfileirado, divergencia, conflitoMesmaFonte: conflito,
  };
}

/** Variante autônoma: abre e fecha a própria transação (para entradas pontuais). */
export async function promoverMasterFreeTime(
  pool: Pool = getPool(),
  input: PromoverMasterFreeTimeInput,
): Promise<PromoverMasterFreeTimeResultado> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await promoverMasterFreeTimeComClient(client, input);
    await client.query('COMMIT');
    return r;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

async function ultimaObservacao(client: PoolClient, containerId: string, fonte: FieldObservationSource): Promise<{ id: string; valor: number } | null> {
  const { rows } = await client.query(
    `SELECT id, valor FROM field_observations
      WHERE entidade_tipo = 'container' AND entidade_id = $1 AND campo = $2 AND fonte = $3
      ORDER BY observado_em DESC, coletado_em DESC, id DESC LIMIT 1`,
    [containerId, CAMPO_MASTER_FT, fonte],
  );
  const v = rows[0] ? numero(rows[0].valor) : null;
  return rows[0] && v !== null ? { id: rows[0].id, valor: v } : null;
}

async function registrarEvento(
  client: PoolClient,
  e: { organizationId: string; divergenciaId: string; ocorrenciaSeq: number; tipo: string; autor: string; detalhe?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.organizationId, e.divergenciaId, e.ocorrenciaSeq, e.tipo, e.autor, JSON.stringify(e.detalhe ?? {})],
  );
}

/**
 * Compara a observação MAIS RECENTE da SI com a MAIS RECENTE do Master BL do
 * contêiner e ajusta a divergência corrente. Independe da ordem de chegada.
 * Idempotente: reprocessar sem mudança de valores não gera evento nem aviso.
 *
 * - valores diferentes, sem divergência → abre (ocorrência 1) + avisos;
 * - valores diferentes e divergência resolvida → reabre (nova ocorrência) +
 *   avisos, se a resolução foi por convergência ou o par de valores mudou;
 * - valores diferentes e divergência ativa com par diferente → atualizada;
 * - valores iguais (ou uma das fontes ausente) e divergência ativa → resolvida
 *   por convergência.
 */
export async function avaliarDivergenciaComClient(
  client: PoolClient,
  input: { organizationId: string; containerId: string; processoId: string; autor: string },
): Promise<DivergenciaAvaliada | null> {
  const si = await ultimaObservacao(client, input.containerId, 'shipping_instructions');
  const master = await ultimaObservacao(client, input.containerId, 'master_bl');
  const { rows } = await client.query(
    `SELECT * FROM ft_divergencias WHERE container_id = $1 AND campo = $2 FOR UPDATE`,
    [input.containerId, CAMPO_MASTER_FT],
  );
  const d = rows[0];
  const diverge = !!(si && master && si.valor !== master.valor);

  if (!d) {
    if (!diverge) return null;
    const { rows: nova } = await client.query(
      `INSERT INTO ft_divergencias (organization_id, processo_id, container_id, valor_si, obs_si_id, valor_master, obs_master_id, estado, ocorrencia_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'aberta', 1)
       ON CONFLICT (container_id, campo) DO NOTHING
       RETURNING id`,
      [input.organizationId, input.processoId, input.containerId, si!.valor, si!.id, master!.valor, master!.id],
    );
    if (!nova[0]) return null; // corrida improvável (há FOR UPDATE no contêiner)
    await registrarEvento(client, {
      organizationId: input.organizationId, divergenciaId: nova[0].id, ocorrenciaSeq: 1, tipo: 'aberta', autor: input.autor,
      detalhe: { valorSi: si!.valor, valorMaster: master!.valor, obsSiId: si!.id, obsMasterId: master!.id },
    });
    await enfileirarAvisosComClient(client, { organizationId: input.organizationId, divergenciaId: nova[0].id, processoId: input.processoId, ocorrenciaSeq: 1, autor: input.autor });
    return { id: nova[0].id, estado: 'aberta', ocorrenciaSeq: 1, evento: 'aberta' };
  }

  const seq: number = d.ocorrencia_seq;
  const mesmoPar = diverge && si!.valor === d.valor_si && master!.valor === d.valor_master;

  if (d.estado === 'resolvida') {
    if (!diverge) return { id: d.id, estado: 'resolvida', ocorrenciaSeq: seq, evento: null };
    // Resolução MANUAL com o mesmo par permanece resolvida (reprocessar não reabre).
    if (d.resolvida_motivo === 'manual' && mesmoPar) return { id: d.id, estado: 'resolvida', ocorrenciaSeq: seq, evento: null };
    const novaSeq = seq + 1;
    await client.query(
      `UPDATE ft_divergencias SET estado = 'reaberta', ocorrencia_seq = $2, valor_si = $3, obs_si_id = $4,
         valor_master = $5, obs_master_id = $6, reconhecida_por = NULL, reconhecida_em = NULL,
         resolvida_por = NULL, resolvida_em = NULL, resolvida_motivo = NULL, atualizado_em = now()
       WHERE id = $1`,
      [d.id, novaSeq, si!.valor, si!.id, master!.valor, master!.id],
    );
    await registrarEvento(client, {
      organizationId: input.organizationId, divergenciaId: d.id, ocorrenciaSeq: novaSeq, tipo: 'reaberta', autor: input.autor,
      detalhe: { valorSi: si!.valor, valorMaster: master!.valor, obsSiId: si!.id, obsMasterId: master!.id },
    });
    await enfileirarAvisosComClient(client, { organizationId: input.organizationId, divergenciaId: d.id, processoId: d.processo_id, ocorrenciaSeq: novaSeq, autor: input.autor });
    return { id: d.id, estado: 'reaberta', ocorrenciaSeq: novaSeq, evento: 'reaberta' };
  }

  // Divergência ativa (aberta / reaberta / reconhecida).
  if (!diverge) {
    await client.query(
      `UPDATE ft_divergencias SET estado = 'resolvida', resolvida_por = $2, resolvida_em = now(),
         resolvida_motivo = 'convergencia', atualizado_em = now() WHERE id = $1`,
      [d.id, input.autor],
    );
    await registrarEvento(client, {
      organizationId: input.organizationId, divergenciaId: d.id, ocorrenciaSeq: seq, tipo: 'resolvida', autor: input.autor,
      detalhe: { motivo: 'convergencia', valorSi: si?.valor ?? null, valorMaster: master?.valor ?? null },
    });
    return { id: d.id, estado: 'resolvida', ocorrenciaSeq: seq, evento: 'resolvida' };
  }
  if (mesmoPar) return { id: d.id, estado: d.estado, ocorrenciaSeq: seq, evento: null };
  await client.query(
    `UPDATE ft_divergencias SET valor_si = $2, obs_si_id = $3, valor_master = $4, obs_master_id = $5, atualizado_em = now() WHERE id = $1`,
    [d.id, si!.valor, si!.id, master!.valor, master!.id],
  );
  await registrarEvento(client, {
    organizationId: input.organizationId, divergenciaId: d.id, ocorrenciaSeq: seq, tipo: 'atualizada', autor: input.autor,
    detalhe: { valorSiAnterior: d.valor_si, valorMasterAnterior: d.valor_master, valorSi: si!.valor, valorMaster: master!.valor },
  });
  return { id: d.id, estado: d.estado, ocorrenciaSeq: seq, evento: 'atualizada' };
}

/**
 * Cria as entregas PENDING da OCORRÊNCIA: responsável operacional do processo +
 * memberships MANAGER/ADMIN da organização. Idempotente por (divergência,
 * ocorrência, destinatário). Sem responsável operacional → só gestores, com o
 * fato registrado no evento. Sem nenhum destinatário → evento `aviso_falhou`.
 */
export async function enfileirarAvisosComClient(
  client: PoolClient,
  input: { organizationId: string; divergenciaId: string; processoId: string; ocorrenciaSeq: number; autor: string },
): Promise<number> {
  const { rows: p } = await client.query(`SELECT responsavel_operacional_membership_id FROM processos WHERE id = $1`, [input.processoId]);
  const responsavel: string | null = p[0]?.responsavel_operacional_membership_id ?? null;
  const { rows: gestores } = await client.query(
    `SELECT id FROM organization_memberships WHERE organization_id = $1 AND papel IN ('MANAGER', 'ADMIN') ORDER BY id`,
    [input.organizationId],
  );
  const destinatarios: Array<{ tipo: 'responsavel_operacional' | 'gestor'; membershipId: string }> = [];
  if (responsavel) destinatarios.push({ tipo: 'responsavel_operacional', membershipId: responsavel });
  for (const g of gestores) if (g.id !== responsavel) destinatarios.push({ tipo: 'gestor', membershipId: g.id });

  if (!destinatarios.length) {
    await registrarEvento(client, {
      organizationId: input.organizationId, divergenciaId: input.divergenciaId, ocorrenciaSeq: input.ocorrenciaSeq,
      tipo: 'aviso_falhou', autor: input.autor, detalhe: { motivo: 'sem_destinatarios', semResponsavelOperacional: !responsavel },
    });
    return 0;
  }
  let criadas = 0;
  for (const dst of destinatarios) {
    const { rowCount } = await client.query(
      `INSERT INTO ft_divergencia_entregas (organization_id, divergencia_id, ocorrencia_seq, destinatario_tipo, destinatario_membership_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (divergencia_id, ocorrencia_seq, destinatario_membership_id) DO NOTHING`,
      [input.organizationId, input.divergenciaId, input.ocorrenciaSeq, dst.tipo, dst.membershipId],
    );
    criadas += rowCount ?? 0;
  }
  if (criadas > 0) {
    await registrarEvento(client, {
      organizationId: input.organizationId, divergenciaId: input.divergenciaId, ocorrenciaSeq: input.ocorrenciaSeq,
      tipo: 'aviso_emitido', autor: input.autor,
      detalhe: { entregas: criadas, semResponsavelOperacional: !responsavel },
    });
  }
  return criadas;
}
