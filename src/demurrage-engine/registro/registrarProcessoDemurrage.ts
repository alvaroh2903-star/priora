import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { hojeOperacional } from '../time/operationalDate';
import { FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { EquipmentMapping, normalizarEquipamento } from '../domain/containerType';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { promoverMasterFreeTimeComClient } from '../freeTime/masterFreeTimeService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { atualizarFotografia } from './fotografia';
import {
  ErroContratoDemurrage, Observado, RegistroNormalizado, RegistroProcessoDemurrageV1, validarRegistro,
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
 *     hierarquia de fontes existente (FIELD_OBSERVATION_SOURCE_PRIORITY);
 *  4. cria ou recupera os contêineres DENTRO do processo; um contêiner que já
 *     pertence a OUTRO processo da organização rejeita a chamada inteira;
 *  5. tipo original preservado + normalização pelas regras existentes
 *     (`normalizarEquipamento`, mapeamentos com vigência, sem fuzzy);
 *  6. House/Master Free Time pelos writers congelados (promoverHouse/Master…);
 *  7. vínculo do tracking pelo MBL + armador (TrackingTargetRepository, target
 *     reaproveitado), SEM consulta ao armador — o scheduler existente consulta;
 *     sem MBL/armador suficiente → pendência explícita, nenhum target inventado.
 * Qualquer erro → ROLLBACK de tudo (processo, contêineres, observações, vínculos).
 *
 * Depois do COMMIT (caches recomputáveis): apuração/lifecycle/consolidação pelo
 * orquestrador congelado e fotografia (só existe com descarga).
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
  if (resultado.status === 'registrado') await posCommit(pool, resultado.processoId, opcoes.hojeReferencia ?? hojeOperacional());
  return resultado;
}

/** Caches recomputáveis (apuração → relógios → valores → lifecycle → consolidação) + fotografia. */
async function posCommit(pool: Pool, processoId: string, hoje: CivilDate): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM containers WHERE processo_id = $1 ORDER BY id`, [processoId]);
  for (const r of rows) {
    await recalcularApuracaoContainer(pool, r.id, { dataReferencia: hoje });
    await atualizarFotografia(pool, r.id, { origem: { tipo: 'registro_contrato' } });
  }
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

    // 5a) Tipo: original preservado (ledger + tabela) e normalização existente.
    if (c.tipoOriginal) {
      const t = c.tipoOriginal;
      const bruto = String(t.valor).trim();
      await FieldObservationRepository.insertComClient(db, {
        organizationId: org, entidadeTipo: 'container', entidadeId: containerId, campo: 'tipoEquipamentoOriginal',
        valor: bruto, fonte: t.fonte as FieldObservationSource, observadoEm: dataObs(t), evidenciaRef: t.evidenciaRef ?? null,
      });
      const norm = normalizarEquipamento({
        valorOriginal: bruto, fonte: t.fonte, referenceDate: t.observadoEm.slice(0, 10),
        mappings: mapeamento.mappings, codigosConhecidos: mapeamento.conhecidos,
      });
      await db.query(
        `INSERT INTO container_equipamento_original
           (container_id, organization_id, tipo_original, fonte, observado_em, evidencia_ref, codigo_normalizado, regra_aplicada)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (container_id) DO UPDATE SET tipo_original = EXCLUDED.tipo_original, fonte = EXCLUDED.fonte,
           observado_em = EXCLUDED.observado_em, evidencia_ref = EXCLUDED.evidencia_ref,
           codigo_normalizado = EXCLUDED.codigo_normalizado, regra_aplicada = EXCLUDED.regra_aplicada, atualizado_em = now()`,
        [containerId, org, bruto, t.fonte, dataObs(t), t.evidenciaRef ?? null, norm.codigoNormalizado, norm.regraAplicada],
      );
      if (norm.codigoNormalizado) {
        const r = await ContainerRepository.applyObservationComClient(db, {
          containerId, organizationId: org, campo: 'containerType', valor: mapeamento.idPorCodigo.get(norm.codigoNormalizado)!,
          fonte: t.fonte as FieldObservationSource, observadoEm: dataObs(t), evidenciaRef: t.evidenciaRef ?? null,
        });
        if (r.conflitoMesmaFonte) conflitos.push({ campo: 'containerType', containerNumero: c.numeroNormalizado });
        await resolverPendencias(db, processoId, containerId, ['tipo_ausente', 'tipo_nao_reconhecido']);
      } else {
        await resolverPendencias(db, processoId, containerId, ['tipo_ausente']);
        await abrirPendencia(db, org, processoId, containerId, 'tipo_nao_reconhecido', { tipoOriginal: bruto, fonte: t.fonte });
      }
    } else {
      const { rows: jaTem } = await db.query(`SELECT container_type_id FROM containers WHERE id = $1`, [containerId]);
      if (!jaTem[0].container_type_id) await abrirPendencia(db, org, processoId, containerId, 'tipo_ausente', {});
    }

    // 5b) Free Time pelos writers congelados (sobreposição do contêiner > nível do processo).
    const autor = `demurrage.registro.v1:${e.origem.sistema}`;
    const house = c.houseFreeTimeDays ?? e.houseFreeTimeDays;
    if (house) {
      const r = await promoverHouseFreeTimeComClient(db, {
        organizationId: org, containerId, valor: house.valor, fonte: house.fonte as FieldObservationSource,
        observadoEm: dataObs(house), evidenciaRef: house.evidenciaRef ?? null,
      });
      if (r.conflitoMesmaFonte) conflitos.push({ campo: 'houseFreeTimeDays', containerNumero: c.numeroNormalizado });
    }
    const master = c.masterFreeTimeDays ?? e.masterFreeTimeDays;
    if (master) {
      const r = await promoverMasterFreeTimeComClient(db, {
        organizationId: org, containerId, valor: master.valor, fonte: master.fonte as FieldObservationSource,
        observadoEm: dataObs(master), evidenciaRef: master.evidenciaRef ?? null, autor,
      });
      if (r.conflitoMesmaFonte) conflitos.push({ campo: 'masterFreeTimeDays', containerNumero: c.numeroNormalizado });
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
  const { rows: led } = await db.query(
    `INSERT INTO demurrage_registros
       (organization_id, processo_id, versao_contrato, chave_idempotencia, payload_hash, origem_sistema, origem_referencia, resultado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [org, processoId, e.versao, reg.chaveIdempotencia, reg.payloadHash, e.origem.sistema, e.origem.referencia ?? null, JSON.stringify(resultado)],
  );
  resultado.registroId = led[0].id;
  return resultado;
}
