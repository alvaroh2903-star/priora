import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { hojeOperacional } from '../time/operationalDate';
import { FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { EquipmentMapping, normalizarEquipamento } from '../domain/containerType';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { promoverMasterFreeTimeComClient } from '../freeTime/masterFreeTimeService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { fatoMaterialBloqueadoPorFinal } from '../closing/materialChangeGuard';
import { atualizarFotografia } from './fotografia';
import {
  ErroContratoDemurrage, ManualFallbackGovernanca, Observado, RegistroNormalizado, RegistroProcessoDemurrageV1, validarRegistro,
} from './contrato';

/**
 * Fase D10 — serviço de aplicação da Demurrage chamado pelo contrato
 * `demurrage.registro.v1`. Não há rota nem tela que o exponha.
 *
 * Em UMA transação:
 *  1. lock consultivo por (organização, processo) e depois por contêiner (ordem
 *     fixa → sem deadlock); duas chamadas iguais concorrentes se serializam e a
 *     segunda devolve o registro da primeira (ledger idempotente);
 *  2. cria ou recupera o processo por (organization_id, numero_processo) — o
 *     código integral, nunca reduzido;
 *  3. campos do processo (MBL, House, armador, cliente, condição, responsável)
 *     viram observações no ledger append-only e só alteram a coluna tipada pela
 *     hierarquia de fontes existente (FIELD_OBSERVATION_SOURCE_PRIORITY), agora
 *     restrita pela MATRIZ campo×fonte do contrato (v1.1 — `FONTES_POR_CAMPO`);
 *  4. cria ou recupera os contêineres DENTRO do processo; um contêiner que já
 *     pertence a OUTRO processo da organização rejeita a chamada inteira;
 *  5. tipo original preservado + normalização pelas regras existentes
 *     (`normalizarEquipamento`, mapeamentos com vigência, sem fuzzy) — v1.1: o
 *     tipo original SELECIONADO e o tipo NORMALIZADO são sempre derivados da
 *     MESMA observação vencedora pela hierarquia (nunca dois de fontes diferentes);
 *  6. House/Master Free Time pelos writers congelados (promoverHouse/Master…);
 *     `manual_fallback` grava a governança própria (justificativa + autor, v1.1);
 *  7. vínculo do tracking pelo MBL + armador (TrackingTargetRepository, target
 *     reaproveitado), SEM consulta ao armador — o scheduler existente consulta;
 *     sem MBL/armador suficiente → pendência explícita, nenhum target inventado;
 *  8. UMA linha pendente por contêiner no outbox de pós-commit (v1.1).
 * Qualquer erro → ROLLBACK de tudo (processo, contêineres, observações, vínculos).
 *
 * Depois do COMMIT (caches recomputáveis, sem transação longa): o reparo do
 * outbox (recálculo + fotografia) roda SEMPRE — 'registrado' ou 'ja_registrado'
 * — e é durável: uma falha no reparo nunca perde a linha pendente (v1.1,
 * `repararPosCommitOutbox`); a próxima chamada idempotente a repara.
 */

export interface ResultadoRegistroDemurrage {
  status: 'registrado' | 'ja_registrado';
  registroId: string;
  processoId: string;
  numeroProcesso: string;
  processoCriado: boolean;
  containers: Array<{ numero: string; containerId: string; criado: boolean }>;
  pendenciasAbertas: Array<{ tipo: string; containerNumero: string | null }>;
  conflitosMesmaFonte: Array<{ campo: string; containerNumero: string | null }>;
  tracking: { vinculado: boolean; carrier: string | null; referencia: string | null; targetId: string | null };
}

export interface OpcoesRegistro {
  pool?: Pool;
  /** Data civil operacional do recálculo pós-commit (default: hojeOperacional()). */
  hojeReferencia?: CivilDate;
  /** Identificador do worker que reivindica as linhas do outbox (default: único por chamada). */
  workerId?: string;
  /**
   * SÓ TESTE (Fase D10 v1.1/v1.2) — gancho executado depois do claim e antes
   * do trabalho de um contêiner: pode lançar (simula crash entre o COMMIT
   * principal e o recálculo/fotografia) ou aguardar (simula worker lento).
   * Nunca usado em produção; nenhuma rota ou integração expõe este parâmetro.
   */
  _testeFalhaPosCommit?: (containerId: string) => void | Promise<void>;
}

/** Pós-commit incompleto: o registro principal (processo/contêineres/ledger)
 * foi confirmado, mas 1+ contêiner falhou no recálculo/fotografia. O estado
 * do outbox é DURÁVEL — repita a MESMA chamada para reparar (idempotente). */
export class PosCommitIncompletoError extends Error {
  constructor(public readonly processoId: string, public readonly falhas: Array<{ containerId: string; erro: string }>) {
    super(
      `Pós-commit incompleto para o processo ${processoId}: ${falhas.length} contêiner(es) com falha ` +
      `(${falhas.map((f) => `${f.containerId}: ${f.erro}`).join('; ')}). O processo, os contêineres e o ledger já ` +
      `estão confirmados — repita exatamente a mesma chamada para reparar (idempotente).`,
    );
    this.name = 'PosCommitIncompletoError';
  }
}

type Db = PoolClient;

const lock = (db: Db, chave: string) => db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [chave]);

function dataObs(o: Observado<unknown>): Date {
  return new Date(o.observadoEm);
}

/* ------------------------------ pendências ------------------------------ */

async function abrirPendencia(db: Db, org: string, processoId: string, containerId: string | null, tipo: string, contexto: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo) WHERE estado = 'aberta' DO NOTHING`,
    [org, processoId, containerId, tipo, JSON.stringify(contexto)],
  );
}

async function resolverPendencias(db: Db, processoId: string, containerId: string | null, tipos: string[]): Promise<void> {
  await db.query(
    `UPDATE demurrage_pendencias SET estado = 'resolvida', resolvido_em = now()
      WHERE processo_id = $1 AND container_id IS NOT DISTINCT FROM $2 AND tipo = ANY($3::text[]) AND estado = 'aberta'`,
    [processoId, containerId, tipos],
  );
}

/* ------------------------------ campos do processo ------------------------------ */

type CampoProcesso = 'mbl' | 'hbl' | 'armador' | 'cliente' | 'condicaoComercial' | 'responsavelOperacional';
const COLUNA: Record<CampoProcesso, string> = {
  mbl: 'mbl', hbl: 'hbl', armador: 'armador_id', cliente: 'cliente_id',
  condicaoComercial: 'condicao_comercial_id', responsavelOperacional: 'responsavel_operacional_membership_id',
};

/**
 * Observação do campo do processo no ledger + promoção pela MESMA regra dos
 * contêineres: só um fato NOVO altera a seleção, e só se a prioridade da fonte
 * nova for >= a da fonte do valor atual. `valorColuna` é resolvido só quando a
 * promoção ocorre (ex.: cria a condição comercial); `undefined` = não promovível.
 */
async function aplicarCampoProcesso(
  db: Db, org: string, processoId: string, campo: CampoProcesso, obs: Observado<unknown>,
  valorColuna: () => Promise<unknown>,
): Promise<{ promovida: boolean; conflito: boolean }> {
  const { observacao, criada } = await FieldObservationRepository.insertComClient(db, {
    organizationId: org, entidadeTipo: 'processo', entidadeId: processoId, campo,
    valor: obs.valor, fonte: obs.fonte as FieldObservationSource, observadoEm: dataObs(obs), evidenciaRef: obs.evidenciaRef ?? null,
  });
  const conflito = !criada && JSON.stringify(observacao.valor) !== JSON.stringify(obs.valor);
  if (!criada) return { promovida: false, conflito };
  const { rows } = await db.query(
    `SELECT fo.fonte FROM processo_campos_selecionados s JOIN field_observations fo ON fo.id = s.observation_id
      WHERE s.processo_id = $1 AND s.campo = $2 FOR UPDATE OF s`,
    [processoId, campo],
  );
  const atual = rows[0]?.fonte as FieldObservationSource | undefined;
  if (atual && FIELD_OBSERVATION_SOURCE_PRIORITY[obs.fonte as FieldObservationSource] < FIELD_OBSERVATION_SOURCE_PRIORITY[atual]) {
    return { promovida: false, conflito };
  }
  const valor = await valorColuna();
  if (valor === undefined) return { promovida: false, conflito };
  await db.query(`UPDATE processos SET ${COLUNA[campo]} = $2 WHERE id = $1`, [processoId, valor]);
  await db.query(
    `INSERT INTO processo_campos_selecionados (processo_id, organization_id, campo, observation_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (processo_id, campo) DO UPDATE SET observation_id = EXCLUDED.observation_id, atualizado_em = now()`,
    [processoId, org, campo, observacao.id],
  );
  return { promovida: true, conflito };
}

/* ------------------------------ equipamento ------------------------------ */

async function carregarMapeamentos(db: Db): Promise<{ mappings: EquipmentMapping[]; conhecidos: string[]; idPorCodigo: Map<string, string> }> {
  const { rows: tipos } = await db.query(`SELECT id, codigo FROM container_types`);
  const { rows: maps } = await db.query(
    `SELECT m.valor_original, m.fonte, ct.codigo, to_char(m.vigente_desde, 'YYYY-MM-DD') AS desde,
            to_char(m.vigente_ate, 'YYYY-MM-DD') AS ate
       FROM container_type_mappings m JOIN container_types ct ON ct.id = m.container_type_id`,
  );
  return {
    mappings: maps.map((m) => ({ valorOriginal: m.valor_original, fonte: m.fonte, codigoNormalizado: m.codigo, vigenteDesde: m.desde, vigenteAte: m.ate })),
    conhecidos: tipos.map((t) => t.codigo),
    idPorCodigo: new Map(tipos.map((t) => [t.codigo as string, t.id as string])),
  };
}

/* ------------------------------ governança do manual_fallback (v1.1/v1.2) ------------------------------ */

/**
 * Papéis INTERNOS autorizados a registrar um fallback manual — a MESMA regra já
 * aprovada para o responsável operacional (migration 0007, Decisão 3): ANALYST
 * (operacional), MANAGER e ADMIN. CLIENT nunca. Nenhum papel novo é criado.
 */
export const PAPEIS_AUTOR_FALLBACK_MANUAL: readonly string[] = ['ANALYST', 'MANAGER', 'ADMIN'];

/** Gestores que recebem o aviso do fallback manual (mesmo critério dos avisos de divergência de Free Time). */
const PAPEIS_GESTOR = ['MANAGER', 'ADMIN'];

/**
 * Valida o autor do `manual_fallback`: membership REAL da MESMA organização e
 * com papel interno autorizado. Devolve o `usuario_id` correspondente —
 * `field_observations.criado_por` referencia `usuarios(id)` (governança já
 * existente desde a Fase 1). `FOR SHARE` impede que o papel mude para CLIENT
 * enquanto esta transação usa o membership (mesmo cuidado da migration 0007).
 */
async function resolverAutorManualFallback(db: Db, org: string, autorMembershipId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT usuario_id, papel FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
    [autorMembershipId, org],
  );
  if (!rows.length) {
    throw new ErroContratoDemurrage('MANUAL_FALLBACK_INCOMPLETO', { motivo: 'autor_membership_invalido', autorMembershipId });
  }
  if (!PAPEIS_AUTOR_FALLBACK_MANUAL.includes(rows[0].papel)) {
    throw new ErroContratoDemurrage('MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO', { autorMembershipId, papel: rows[0].papel });
  }
  return rows[0].usuario_id;
}

/**
 * Grava a governança do `manual_fallback` (Free Time apenas — a matriz do
 * contrato já garante isso) e o AVISO DURÁVEL aos gestores, na MESMA transação
 * do registro. Nenhuma comunicação externa acontece aqui: as entregas nascem
 * PENDING em `demurrage_fallback_manual_avisos` e só o worker
 * (`processarAvisosFallbackManualPendentes`) fala com o transporte, fora de
 * qualquer transação. Idempotente: uma justificativa por observação e uma
 * entrega por (justificativa, gestor) — reprocessar nunca duplica o aviso.
 */
async function registrarGovernancaManualFallback(
  db: Db, org: string, observationId: string, mf: ManualFallbackGovernanca,
): Promise<void> {
  const ins = await db.query(
    `INSERT INTO demurrage_fallback_manual_justificativas (organization_id, observation_id, justificativa, autor_membership_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (observation_id) DO NOTHING RETURNING id`,
    [org, observationId, mf.justificativa.trim(), mf.autorMembershipId],
  );
  const justificativaId: string = ins.rows[0]?.id
    ?? (await db.query(`SELECT id FROM demurrage_fallback_manual_justificativas WHERE observation_id = $1`, [observationId])).rows[0].id;
  await db.query(
    `INSERT INTO demurrage_fallback_manual_avisos (organization_id, justificativa_id, destinatario_membership_id)
     SELECT $1, $2, m.id FROM organization_memberships m
      WHERE m.organization_id = $1 AND m.papel::text = ANY($3::text[])
     ON CONFLICT (justificativa_id, destinatario_membership_id) DO NOTHING`,
    [org, justificativaId, PAPEIS_GESTOR],
  );
}

/* ------------------------------ serviço ------------------------------ */

export async function registrarProcessoDemurrage(
  entrada: RegistroProcessoDemurrageV1,
  opcoes: OpcoesRegistro = {},
): Promise<ResultadoRegistroDemurrage> {
  const reg = validarRegistro(entrada); // puro: falha antes de tocar o banco
  const pool = opcoes.pool ?? getPool();
  const client = await pool.connect();
  let resultado: ResultadoRegistroDemurrage;
  try {
    await client.query('BEGIN');
    resultado = await aplicar(client, reg);
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
  // v1.1 — reparo do pós-commit roda SEMPRE (registrado OU ja_registrado), fora
  // da transação principal (sem transação longa envolvendo os cálculos
  // derivados) e é DURÁVEL: dirigido pelo estado do outbox, não pelo status
  // desta chamada. Uma falha aqui nunca perde a linha pendente — a PRÓXIMA
  // chamada idempotente (mesma entrada/chave) repara sem duplicar nada.
  const { falhas } = await repararPosCommitOutbox(pool, resultado.processoId, {
    hojeReferencia: opcoes.hojeReferencia ?? hojeOperacional(),
    workerId: opcoes.workerId,
    ganchoTeste: opcoes._testeFalhaPosCommit,
  });
  if (falhas.length) throw new PosCommitIncompletoError(resultado.processoId, falhas);
  return resultado;
}

export interface OpcoesReparoPosCommit {
  hojeReferencia: CivilDate;
  /** Dono do claim (default: identificador único desta chamada). */
  workerId?: string;
  /** Prazo da posse; PROCESSANDO vencido é recuperável por outro worker. */
  ttlMs?: number;
  /** SÓ TESTE: executado depois do claim e antes do trabalho (pode lançar ou aguardar). */
  ganchoTeste?: (containerId: string) => void | Promise<void>;
  /** Máximo de claims nesta chamada (v1.3 — limite por ciclo do scheduler). Default: sem limite. */
  limite?: number;
}

export interface ResultadoReparoPosCommit {
  /** Claims obtidos nesta chamada (inclui o reclaim de uma linha cuja geração mudou durante o claim). */
  reivindicados: number;
  reparados: string[];
  falhas: Array<{ containerId: string; erro: string }>;
  /** Contêineres cuja posse foi perdida (claim vencido e assumido por outro): nada foi finalizado por este worker. */
  possePerdida: string[];
}

/**
 * Reparo IDEMPOTENTE e DURÁVEL do outbox de pós-commit (recálculo + fotografia),
 * com CLAIM de posse inequívoca (v1.2 — mesmo padrão de `ft_divergencia_entregas`
 * e `recalculo_outbox`):
 *
 * 1. CLAIM de UMA linha por vez (UPDATE autocommit + `FOR UPDATE SKIP LOCKED`):
 *    `pendente`, `falha` ou `processando` com prazo vencido vira `processando`
 *    com `claim_token` novo, `worker_id` e `expira_em`. Dois workers nunca
 *    reivindicam a mesma linha viva;
 * 2. confirma a posse e executa recálculo + fotografia FORA de transação longa
 *    (cada um tem a sua transação curta);
 * 3. FINALIZA só se o `claim_token` ainda for o vigente: `concluido` (ou de
 *    volta a `pendente`, se um registro novo incrementou a `geracao` durante o
 *    claim) ou `falha` com o erro. Worker que perdeu a posse não finaliza nem
 *    toca a posse do novo dono.
 *
 * `concluido` nunca é reivindicado (reexecutar quando tudo está completo é
 * NO-OP). Uma linha nunca fica presa: `processando` vence e é recuperada;
 * `falha`/`pendente` são reivindicadas pela próxima chamada. No intervalo
 * residual de um claim vencido ainda em execução, o recálculo é idempotente
 * (`input_hash`) e a fotografia é deduplicada por hash sob lock consultivo —
 * não há fotografia nem valor duplicado.
 */
export async function repararPosCommitOutbox(
  pool: Pool,
  processoId: string,
  opts: OpcoesReparoPosCommit,
): Promise<ResultadoReparoPosCommit> {
  const workerId = opts.workerId ?? `registro:${process.pid}:${randomUUID()}`;
  const ttl = Math.max(1, Math.floor((opts.ttlMs ?? 10 * 60_000) / 1000));
  const out: ResultadoReparoPosCommit = { reivindicados: 0, reparados: [], falhas: [], possePerdida: [] };
  const tentados: string[] = [];
  const limite = opts.limite ?? Number.POSITIVE_INFINITY;
  while (out.reivindicados < limite) {
    const { rows } = await pool.query(
      `UPDATE demurrage_pos_commit_outbox o
          SET estado = 'processando', claim_token = gen_random_uuid(), worker_id = $2,
              expira_em = now() + ($3 || ' seconds')::interval, tentativas = o.tentativas + 1, atualizado_em = now()
        WHERE o.id = (
          SELECT id FROM demurrage_pos_commit_outbox
           WHERE processo_id = $1
             AND (estado IN ('pendente', 'falha') OR (estado = 'processando' AND expira_em < now()))
             AND NOT (id = ANY($4::uuid[]))
           ORDER BY container_id, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING o.id, o.container_id, o.claim_token, o.geracao`,
      [processoId, workerId, String(ttl), tentados],
    );
    const claim = rows[0];
    if (!claim) break;
    out.reivindicados++;
    tentados.push(claim.id);
    const containerId: string = claim.container_id;
    const vigente = `id = $1 AND estado = 'processando' AND claim_token = $2`;
    try {
      await opts.ganchoTeste?.(containerId);
      // O perdedor (posse vencida e assumida por outro) nem executa o trabalho.
      const posse = await pool.query(`SELECT 1 FROM demurrage_pos_commit_outbox WHERE ${vigente}`, [claim.id, claim.claim_token]);
      if (!posse.rowCount) { out.possePerdida.push(containerId); continue; }
      await recalcularApuracaoContainer(pool, containerId, { dataReferencia: opts.hojeReferencia });
      await atualizarFotografia(pool, containerId, { origem: { tipo: 'registro_contrato' } });
      const fim = await pool.query(
        `UPDATE demurrage_pos_commit_outbox
            SET estado = CASE WHEN geracao = $3 THEN 'concluido' ELSE 'pendente' END,
                concluido_em = CASE WHEN geracao = $3 THEN now() ELSE concluido_em END,
                claim_token = NULL, worker_id = NULL, expira_em = NULL, ultimo_erro = NULL, atualizado_em = now()
          WHERE ${vigente}
        RETURNING estado`,
        [claim.id, claim.claim_token, claim.geracao],
      );
      if (!fim.rowCount) { out.possePerdida.push(containerId); continue; }
      if (fim.rows[0].estado === 'concluido') out.reparados.push(containerId);
      else tentados.pop(); // novo pedido chegou durante o claim: reivindica de novo nesta chamada
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      const fim = await pool.query(
        `UPDATE demurrage_pos_commit_outbox
            SET estado = 'falha', ultimo_erro = $3, claim_token = NULL, worker_id = NULL, expira_em = NULL, atualizado_em = now()
          WHERE ${vigente}`,
        [claim.id, claim.claim_token, mensagem.slice(0, 500)],
      );
      if (fim.rowCount) out.falhas.push({ containerId, erro: mensagem });
      else out.possePerdida.push(containerId);
    }
  }
  return out;
}

/**
 * Varredura de TODO o outbox de pós-commit (qualquer processo com linha
 * reivindicável: `pendente`, `falha` ou `processando` vencido). v1.3: ligada ao
 * tick do scheduler da Demurrage como etapa própria de manutenção — não depende
 * de um novo registro do processo. `limite` é o orçamento de CLAIMS do ciclo
 * inteiro (somado entre processos). `restantes` = linhas ainda não concluídas
 * ao fim da etapa (contagem pelo índice parcial `estado <> 'concluido'`).
 */
export async function processarPosCommitOutboxPendentes(
  pool: Pool, opts: OpcoesReparoPosCommit & { limiteProcessos?: number },
): Promise<ResultadoReparoPosCommit & { restantes: number }> {
  const orcamento = opts.limite ?? 50;
  const { rows } = await pool.query(
    `SELECT processo_id FROM demurrage_pos_commit_outbox
      WHERE estado IN ('pendente', 'falha') OR (estado = 'processando' AND expira_em < now())
      GROUP BY processo_id ORDER BY min(atualizado_em)
      LIMIT $1`,
    [opts.limiteProcessos ?? 100],
  );
  const total: ResultadoReparoPosCommit = { reivindicados: 0, reparados: [], falhas: [], possePerdida: [] };
  for (const r of rows) {
    const saldo = orcamento - total.reivindicados;
    if (saldo <= 0) break;
    const parcial = await repararPosCommitOutbox(pool, r.processo_id, { ...opts, limite: saldo });
    total.reivindicados += parcial.reivindicados;
    total.reparados.push(...parcial.reparados);
    total.falhas.push(...parcial.falhas);
    total.possePerdida.push(...parcial.possePerdida);
  }
  const { rows: rest } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_pos_commit_outbox WHERE estado <> 'concluido'`);
  return { ...total, restantes: rest[0].n };
}

async function aplicar(db: Db, reg: RegistroNormalizado): Promise<ResultadoRegistroDemurrage> {
  const e = reg.entrada;
  const org = e.organizationId;

  const { rows: orgRows } = await db.query(`SELECT 1 FROM organizations WHERE id = $1`, [org]);
  if (!orgRows.length) throw new ErroContratoDemurrage('ORGANIZACAO_INEXISTENTE', { organizationId: org });

  // 1) Serialização: processo, depois contêineres em ordem fixa.
  await lock(db, `demurrage:processo:${org}:${reg.numeroProcesso}`);
  for (const n of reg.containers.map((c) => c.numeroNormalizado).sort()) await lock(db, `demurrage:container:${org}:${n}`);

  // 2) Idempotência pelo ledger.
  const { rows: prev } = await db.query(
    `SELECT id, payload_hash, resultado FROM demurrage_registros WHERE organization_id = $1 AND chave_idempotencia = $2`,
    [org, reg.chaveIdempotencia],
  );
  if (prev[0]) {
    if (prev[0].payload_hash !== reg.payloadHash) throw new ErroContratoDemurrage('CHAVE_IDEMPOTENCIA_REUTILIZADA', { chave: reg.chaveIdempotencia });
    return { ...(prev[0].resultado as ResultadoRegistroDemurrage), status: 'ja_registrado', registroId: prev[0].id };
  }

  // 3) Processo por (organização, número integral).
  const ins = await db.query(
    `INSERT INTO processos (organization_id, numero_processo, cliente_id) VALUES ($1, $2, NULL)
     ON CONFLICT (organization_id, numero_processo) DO NOTHING RETURNING id`,
    [org, reg.numeroProcesso],
  );
  const processoCriado = ins.rows.length > 0;
  const { rows: pr } = await db.query(
    `SELECT id, apuracao_status, condicao_comercial_id FROM processos WHERE organization_id = $1 AND numero_processo = $2 FOR UPDATE`,
    [org, reg.numeroProcesso],
  );
  const processoId: string = pr[0].id;
  if (pr[0].apuracao_status === 'FINAL') throw new ErroContratoDemurrage('PROCESSO_FINAL', { numeroProcesso: reg.numeroProcesso });

  const conflitos: ResultadoRegistroDemurrage['conflitosMesmaFonte'] = [];
  const campo = async (nome: CampoProcesso, obs: Observado<unknown> | null | undefined, valorColuna: () => Promise<unknown>) => {
    if (!obs) return;
    const r = await aplicarCampoProcesso(db, org, processoId, nome, obs, valorColuna);
    if (r.conflito) conflitos.push({ campo: nome, containerNumero: null });
  };

  // 4) Campos do processo pela hierarquia de fontes.
  await campo('mbl', e.mbl, async () => String(e.mbl!.valor).trim().toUpperCase() || undefined);
  await campo('hbl', e.house, async () => String(e.house!.valor).trim().toUpperCase() || undefined);
  const codigoArmador = e.armador ? String(e.armador.valor).trim().toUpperCase() : null;
  let armadorId: string | null = null;
  if (codigoArmador) {
    const { rows } = await db.query(`SELECT id FROM armadores WHERE codigo_interno = $1`, [codigoArmador]);
    armadorId = rows[0]?.id ?? null;
  }
  await campo('armador', e.armador, async () => armadorId ?? undefined);
  await campo('cliente', e.cliente, async () => {
    const nome = String(e.cliente!.valor).trim();
    if (!nome) return undefined;
    return (await new ClienteRepository(db as unknown as Pool).findOrCreate(org, nome)).cliente.id;
  });
  await campo('condicaoComercial', e.condicaoComercial, async () => {
    const c = e.condicaoComercial!.valor;
    const tabela = c.termoTipo === 'embarque' ? c.tabelaId ?? null : null;
    if (pr[0].condicao_comercial_id) {
      const { rows } = await db.query(`SELECT termo_tipo, tabela_id FROM condicoes_comerciais WHERE id = $1`, [pr[0].condicao_comercial_id]);
      if (rows[0] && rows[0].termo_tipo === c.termoTipo && (rows[0].tabela_id ?? null) === tabela) return pr[0].condicao_comercial_id;
    }
    const { rows } = await db.query(
      `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1, $2, $3, $4) RETURNING id`,
      [org, c.termoTipo, tabela, c.fonteDocumental ?? e.condicaoComercial!.evidenciaRef ?? null],
    );
    return rows[0].id;
  });
  await campo('responsavelOperacional', e.responsavelOperacionalMembershipId, async () => e.responsavelOperacionalMembershipId!.valor);

  // 5) Contêineres dentro do processo.
  const mapeamento = await carregarMapeamentos(db);
  const containers: ResultadoRegistroDemurrage['containers'] = [];
  for (const c of reg.containers) {
    const { rows: outro } = await db.query(
      `SELECT p.numero_processo FROM containers ct JOIN processos p ON p.id = ct.processo_id
        WHERE ct.organization_id = $1 AND ct.numero = $2 AND ct.processo_id <> $3 LIMIT 1`,
      [org, c.numeroNormalizado, processoId],
    );
    if (outro[0]) {
      throw new ErroContratoDemurrage('CONTAINER_EM_OUTRO_PROCESSO', { numero: c.numeroNormalizado, processo: outro[0].numero_processo });
    }
    const ci = await db.query(
      `INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, $3)
       ON CONFLICT (processo_id, numero) DO NOTHING RETURNING id`,
      [org, processoId, c.numeroNormalizado],
    );
    const criado = ci.rows.length > 0;
    const containerId: string = criado ? ci.rows[0].id
      : (await db.query(`SELECT id FROM containers WHERE processo_id = $1 AND numero = $2`, [processoId, c.numeroNormalizado])).rows[0].id;
    containers.push({ numero: c.numeroNormalizado, containerId, criado });

    // 5a) Tipo: original preservado (ledger, SEMPRE) e normalização existente.
    // v1.1 — o tipo original SELECIONADO e o tipo NORMALIZADO nunca mais são
    // decididos por dois caminhos independentes: uma ÚNICA comparação de
    // prioridade (contra a fonte hoje selecionada em `container_equipamento_
    // original`) decide se esta observação vence; só quando vence é que os
    // dois — original exibido E normalizado (`containers.container_type_id`)
    // — são atualizados juntos, a partir da MESMA observação.
    if (c.tipoOriginal) {
      const t = c.tipoOriginal;
      const bruto = String(t.valor).trim();
      const { observacao: obsTipo, criada: criadaTipo } = await FieldObservationRepository.insertComClient(db, {
        organizationId: org, entidadeTipo: 'container', entidadeId: containerId, campo: 'tipoEquipamentoOriginal',
        valor: bruto, fonte: t.fonte as FieldObservationSource, observadoEm: dataObs(t), evidenciaRef: t.evidenciaRef ?? null,
      });
      // Mesma fonte, mesmo instante, valor diferente: conflito auditável (a
      // observação ORIGINAL desse instante é preservada; esta chamada não a
      // sobrescreve — mesma regra usada nos campos do processo). Em QUALQUER
      // caso de `!criadaTipo` (replay idêntico OU conflito) a observação já
      // existia — esta chamada nunca introduziu um fato novo, então nem tenta
      // reavaliar a seleção (mesmo padrão de `aplicarCampoProcesso`).
      const conflitoMesmoInstante = !criadaTipo && JSON.stringify(obsTipo.valor) !== JSON.stringify(bruto);
      if (conflitoMesmoInstante) {
        conflitos.push({ campo: 'tipoEquipamentoOriginal', containerNumero: c.numeroNormalizado });
      }
      const { rows: selAtual } = await db.query(
        `SELECT fonte FROM container_equipamento_original WHERE container_id = $1 FOR UPDATE`, [containerId],
      );
      const fonteAtual = selAtual[0]?.fonte as FieldObservationSource | undefined;
      const venceu = criadaTipo && (!fonteAtual || FIELD_OBSERVATION_SOURCE_PRIORITY[t.fonte as FieldObservationSource] >= FIELD_OBSERVATION_SOURCE_PRIORITY[fonteAtual]);
      if (venceu) {
        const norm = normalizarEquipamento({
          valorOriginal: bruto, fonte: t.fonte, referenceDate: t.observadoEm.slice(0, 10),
          mappings: mapeamento.mappings, codigosConhecidos: mapeamento.conhecidos,
        });
        await db.query(
          `INSERT INTO container_equipamento_original
             (container_id, organization_id, tipo_original, fonte, observado_em, evidencia_ref, codigo_normalizado, regra_aplicada, observation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (container_id) DO UPDATE SET tipo_original = EXCLUDED.tipo_original, fonte = EXCLUDED.fonte,
             observado_em = EXCLUDED.observado_em, evidencia_ref = EXCLUDED.evidencia_ref,
             codigo_normalizado = EXCLUDED.codigo_normalizado, regra_aplicada = EXCLUDED.regra_aplicada,
             observation_id = EXCLUDED.observation_id, atualizado_em = now()`,
          [containerId, org, bruto, t.fonte, dataObs(t), t.evidenciaRef ?? null, norm.codigoNormalizado, norm.regraAplicada, obsTipo.id],
        );
        // Fase D15-A (31.7b): o tipo normalizado é um fato material do
        // contêiner (afeta a seleção de tarifa). Em processo FINAL, qualquer
        // mudança MATERIAL (incluindo zerar para NULL) é bloqueada: a
        // observação acima já preserva a evidência; só a promoção é recusada.
        // NOTA: este caminho (registro/reenvio do contrato) já é inalcançável
        // em FINAL — `aplicar()` lança `PROCESSO_FINAL` mais acima (linha
        // ~454, regra congelada de D10, com teste de regressão próprio) antes
        // de chegar aqui. A guarda abaixo é defensiva (nunca fica
        // desatualizada se essa rejeição de alto nível mudar) e documenta a
        // mesma regra; o caso exigido "correção de tipo de equipamento após
        // FINAL" é exercido de fato pelo caminho genérico e compartilhado
        // `ContainerRepository.applyObservation`/`applyObservationComClient`
        // (campo `containerType`), que outros chamadores (ex.: backfill)
        // também usam e que esta função NÃO chama para este campo.
        const { rows: tipoAntesRows } = await db.query(`SELECT container_type_id FROM containers WHERE id = $1`, [containerId]);
        const tipoAntes: string | null = tipoAntesRows[0]?.container_type_id ?? null;
        if (norm.codigoNormalizado) {
          // O normalizado segue a MESMA decisão de vitória — não uma promoção
          // independente (por isso grava direto, em vez de reconsultar a
          // prioridade de `container_type_source_observation_id`, que poderia,
          // em tese, divergir da de `container_equipamento_original`).
          const tipoId = mapeamento.idPorCodigo.get(norm.codigoNormalizado)!;
          const { observacao: obsNormalizado } = await FieldObservationRepository.insertComClient(db, {
            organizationId: org, entidadeTipo: 'container', entidadeId: containerId, campo: 'containerType',
            valor: tipoId, fonte: t.fonte as FieldObservationSource, observadoEm: dataObs(t), evidenciaRef: t.evidenciaRef ?? null,
          });
          const bloqueado = await fatoMaterialBloqueadoPorFinal(db, {
            containerId, campo: 'containerType', valorAnterior: tipoAntes, valorNovo: tipoId,
            origem: 'automatico', extra: { fonte: t.fonte, observationId: obsNormalizado.id },
          });
          if (!bloqueado) {
            await db.query(
              `UPDATE containers SET container_type_id = $2, container_type_source_observation_id = $3, atualizado_em = now() WHERE id = $1`,
              [containerId, tipoId, obsNormalizado.id],
            );
            await resolverPendencias(db, processoId, containerId, ['tipo_ausente', 'tipo_nao_reconhecido']);
          }
        } else {
          const bloqueado = await fatoMaterialBloqueadoPorFinal(db, {
            containerId, campo: 'containerType', valorAnterior: tipoAntes, valorNovo: null,
            origem: 'automatico', extra: { fonte: t.fonte, observationId: obsTipo.id, motivo: 'tipo_nao_normalizado' },
          });
          if (!bloqueado) {
            // A observação vencedora não normaliza: o normalizado ACOMPANHA (nunca
            // fica um código normalizado "órfão" de uma fonte agora superada) —
            // é exatamente o que impedia a fotografia de mostrar tipo original de
            // uma fonte e tipo normalizado de outra.
            await db.query(
              `UPDATE containers SET container_type_id = NULL, container_type_source_observation_id = NULL, atualizado_em = now() WHERE id = $1`,
              [containerId],
            );
            await resolverPendencias(db, processoId, containerId, ['tipo_ausente']);
            await abrirPendencia(db, org, processoId, containerId, 'tipo_nao_reconhecido', { tipoOriginal: bruto, fonte: t.fonte });
          }
        }
      }
      // Não venceu: a observação já está no ledger (acima) — preservada, auditável
      // — mas NÃO substitui a seleção atual (nem o original exibido, nem o normalizado).
    } else {
      const { rows: jaTem } = await db.query(`SELECT container_type_id FROM containers WHERE id = $1`, [containerId]);
      if (!jaTem[0].container_type_id) await abrirPendencia(db, org, processoId, containerId, 'tipo_ausente', {});
    }

    // 5b) Free Time pelos writers congelados (sobreposição do contêiner > nível do processo).
    const autor = `demurrage.registro.v1:${e.origem.sistema}`;
    const house = c.houseFreeTimeDays ?? e.houseFreeTimeDays;
    if (house) {
      const autorUsuarioId = house.fonte === 'manual_fallback' ? await resolverAutorManualFallback(db, org, house.manualFallback!.autorMembershipId) : undefined;
      const r = await promoverHouseFreeTimeComClient(db, {
        organizationId: org, containerId, valor: house.valor, fonte: house.fonte as FieldObservationSource,
        observadoEm: dataObs(house), evidenciaRef: house.evidenciaRef ?? null, criadoPor: autorUsuarioId,
      });
      if (r.conflitoMesmaFonte) conflitos.push({ campo: 'houseFreeTimeDays', containerNumero: c.numeroNormalizado });
      if (house.fonte === 'manual_fallback') {
        await registrarGovernancaManualFallback(db, org, r.observationId, house.manualFallback!);
      }
    }
    const master = c.masterFreeTimeDays ?? e.masterFreeTimeDays;
    if (master) {
      const autorUsuarioId = master.fonte === 'manual_fallback' ? await resolverAutorManualFallback(db, org, master.manualFallback!.autorMembershipId) : undefined;
      const r = await promoverMasterFreeTimeComClient(db, {
        organizationId: org, containerId, valor: master.valor, fonte: master.fonte as FieldObservationSource,
        observadoEm: dataObs(master), evidenciaRef: master.evidenciaRef ?? null, autor, criadoPor: autorUsuarioId,
      });
      if (r.conflitoMesmaFonte) conflitos.push({ campo: 'masterFreeTimeDays', containerNumero: c.numeroNormalizado });
      if (master.fonte === 'manual_fallback') {
        await registrarGovernancaManualFallback(db, org, r.observationId, master.manualFallback!);
      }
    }
  }

  // 6) Tracking pelo MBL + armador SELECIONADOS no processo (sem consulta ao armador).
  const { rows: sel } = await db.query(
    `SELECT p.mbl, a.codigo_interno, act.carrier_tracking
       FROM processos p
       LEFT JOIN armadores a ON a.id = p.armador_id
       LEFT JOIN armador_codigos_tracking act ON act.codigo_interno = a.codigo_interno
      WHERE p.id = $1`,
    [processoId],
  );
  const mbl: string | null = sel[0].mbl ?? null;
  const carrier: string | null = sel[0].carrier_tracking ?? null;
  const tracking: ResultadoRegistroDemurrage['tracking'] = { vinculado: false, carrier, referencia: mbl, targetId: null };
  if (mbl) await resolverPendencias(db, processoId, null, ['mbl_ausente']);
  else await abrirPendencia(db, org, processoId, null, 'mbl_ausente', {});
  if (sel[0].codigo_interno) {
    await resolverPendencias(db, processoId, null, ['armador_ausente', 'armador_nao_cadastrado']);
    if (carrier) await resolverPendencias(db, processoId, null, ['armador_sem_tracking']);
    else await abrirPendencia(db, org, processoId, null, 'armador_sem_tracking', { codigo: sel[0].codigo_interno });
  } else if (codigoArmador) {
    await resolverPendencias(db, processoId, null, ['armador_ausente']);
    await abrirPendencia(db, org, processoId, null, 'armador_nao_cadastrado', { codigo: codigoArmador });
  } else {
    await abrirPendencia(db, org, processoId, null, 'armador_ausente', {});
  }
  if (mbl && carrier) {
    const targets = new TrackingTargetRepository(db as unknown as Pool);
    const { target } = await targets.upsert({ carrier, reference: mbl });
    const { rows: todos } = await db.query(`SELECT id FROM containers WHERE processo_id = $1`, [processoId]);
    for (const t of todos) await targets.linkContainer(t.id, target.id, { referenceType: 'mbl', referenceRaw: mbl });
    Object.assign(tracking, { vinculado: todos.length > 0, targetId: target.id });
  }

  const { rows: pend } = await db.query(
    `SELECT p.tipo, c.numero FROM demurrage_pendencias p LEFT JOIN containers c ON c.id = p.container_id
      WHERE p.processo_id = $1 AND p.estado = 'aberta' ORDER BY p.tipo, c.numero`,
    [processoId],
  );
  const resultado: ResultadoRegistroDemurrage = {
    status: 'registrado', registroId: '', processoId, numeroProcesso: reg.numeroProcesso, processoCriado, containers,
    pendenciasAbertas: pend.map((p) => ({ tipo: p.tipo, containerNumero: p.numero ?? null })),
    conflitosMesmaFonte: conflitos, tracking,
  };

  // v1.1 — uma linha PENDENTE por contêiner do processo, na MESMA transação
  // que confirma processo/contêineres/ledger: se o pós-commit falhar depois do
  // COMMIT, esta linha sobrevive e guia o reparo (nunca perde o rastro do que
  // falta recalcular/fotografar). TODOS os contêineres do processo entram
  // (não só os desta chamada) — o registro pode ter mudado fatos de nível de
  // processo que afetam contêineres não citados nesta entrada.
  const { rows: todosContainersDoProcesso } = await db.query(`SELECT id FROM containers WHERE processo_id = $1`, [processoId]);
  for (const tc of todosContainersDoProcesso) {
    await db.query(
      `INSERT INTO demurrage_pos_commit_outbox (organization_id, processo_id, container_id, estado)
       VALUES ($1, $2, $3, 'pendente')
       ON CONFLICT (processo_id, container_id) DO UPDATE SET
         geracao = demurrage_pos_commit_outbox.geracao + 1,
         -- em processamento: mantém a posse do worker; a geração nova faz a
         -- finalização dele devolver a linha a pendente (nada se perde).
         estado = CASE WHEN demurrage_pos_commit_outbox.estado = 'processando' THEN 'processando' ELSE 'pendente' END,
         atualizado_em = now()`,
      [org, processoId, tc.id],
    );
  }

  const { rows: led } = await db.query(
    `INSERT INTO demurrage_registros
       (organization_id, processo_id, versao_contrato, chave_idempotencia, payload_hash, origem_sistema, origem_referencia, resultado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [org, processoId, e.versao, reg.chaveIdempotencia, reg.payloadHash, e.origem.sistema, e.origem.referencia ?? null, JSON.stringify(resultado)],
  );
  resultado.registroId = led[0].id;
  return resultado;
}
