import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { processarRecalculosPendentes, ProcessarRecalculosResultado } from '../../freeTime/recalculoOutbox';
import { recalcularApuracaoContainer } from '../../apuracao/recalcularApuracao';
import { DimensaoTabela } from './contrato';
import { lockProcesso } from '../../closing/materialChangeGuard';
import { ClosingService } from '../../closing/closingService';

/**
 * Produção P1 (administração tarifária) — RECÁLCULO dos processos abertos
 * afetados por uma ativação/desativação, pelo outbox EXISTENTE
 * (`recalculo_outbox`, `tipo = 'tarifa'`, `chave` = id do evento).
 *
 * A transação administrativa NÃO cria os itens por contêiner: ela só grava a
 * expansão pendente (`tariff_recalculo_expansoes`). O fan-out acontece DEPOIS
 * do COMMIT, aqui:
 *  - processo a processo, em ordem de id, cada um numa transação curta que
 *    toma `lockProcesso` — o MESMO lock de reabertura, registro e recálculo —,
 *    relê o status e, se OPEN, insere um item por contêiner (ordem de id).
 *    Quem estava recalculando ou reabrindo com a tarifa anterior termina
 *    antes e recebe o item; quem começa depois já lê a tarifa nova. Nenhum
 *    processo aberto do escopo fica sem item por corrida;
 *  - nenhum lock tarifário (chave/dimensão) fica retido enquanto o INSERT
 *    pega KEY SHARE (FK) nos contêineres, sempre na ordem de id — a mesma do
 *    encerramento (`ORDER BY id FOR UPDATE`): sem ciclo de espera;
 *  - processo FINAL nunca entra (e o pipeline também é NO-OP em FINAL);
 *  - posse com prazo e cursor: retomável depois de queda, nunca dois
 *    expansores no mesmo evento ao mesmo tempo.
 * A expansão começa logo depois da resposta da ativação (melhor esforço,
 * orçamento curto); o restante a etapa isolada do tick faz. Falha de
 * expansão nunca desfaz a ativação: fica pendente, visível em
 * `GET /eventos/:id/recalculo`, e é retomada.
 */

/** Filtro SQL do escopo de processos afetados por uma dimensão (`p` = processos). */
export function filtroEscopo(d: DimensaoTabela, tabelaId: string, params: unknown[]): string {
  if (d.tipo === 'armador') {
    params.push(d.armadorId);
    return `p.armador_id = $${params.length}`;
  }
  if (d.termoComercial === 'unico') {
    return `EXISTS (SELECT 1 FROM condicoes_comerciais cc WHERE cc.id = p.condicao_comercial_id AND cc.termo_tipo = 'unico')`;
  }
  // Termo por Embarque: fixado por ID — só quem aponta para ESTA versão.
  params.push(tabelaId);
  return `EXISTS (SELECT 1 FROM condicoes_comerciais cc WHERE cc.id = p.condicao_comercial_id AND cc.termo_tipo = 'embarque' AND cc.tabela_id = $${params.length})`;
}

/** Registra a expansão pendente (dentro da transação administrativa). */
export async function registrarExpansao(client: PoolClient, organizationId: string, eventoId: string, tabelaId: string): Promise<void> {
  await client.query(
    `INSERT INTO tariff_recalculo_expansoes (evento_id, organization_id, tariff_table_id) VALUES ($1, $2, $3)`,
    [eventoId, organizationId, tabelaId],
  );
}

export interface OpcoesExpansao {
  /** Prefixo do dono (log/diagnóstico); cada execução recebe um token próprio. */
  workerId?: string;
  /** Prazo da posse (ms) — depois dele outro expansor pode retomar do cursor. */
  posseMs?: number;
  /** `lock_timeout` de cada transação por processo (ms). */
  lockTimeoutMs?: number;
  /** Teto de tempo desta execução (ms); o restante fica para a próxima. */
  orcamentoMs?: number;
  /** Prazo ABSOLUTO (em `agora()`) comum a várias execuções (etapa do tick). */
  prazo?: number;
  loteProcessos?: number;
  agora?: () => number;
  /** SÓ TESTE: chamado depois de cada processo comitado (nenhuma rota o expõe). */
  aposProcesso?: (processoId: string) => Promise<void>;
}

export interface ResultadoExpansao { processos: number; itens: number; concluida: boolean }

/**
 * Executa (ou continua) a expansão de `eventoId`. Devolve null quando não
 * havia nada a fazer por esta chamada (já concluída, ou com posse de outro
 * expansor). O orçamento é conferido ANTES DE CADA PROCESSO (no pior caso a
 * execução passa dele por uma espera de `lock_timeout`). Uma espera de lock
 * acima do `lock_timeout` encerra a execução sem perder nada: o cursor fica
 * antes do processo e a posse é liberada.
 *
 * Posse: token próprio por execução (nunca só o pid, que se repete entre
 * réplicas). O progresso de cada processo (cursor, contadores, renovação da
 * posse) é gravado NA MESMA transação dos itens, condicionado ao token: se a
 * posse foi tomada por outro expansor (venceu), a transação é desfeita e a
 * execução para sem tocar mais no registro — nunca dois cursores, nunca
 * contadores perdidos ou duplicados.
 */
export async function expandirEvento(pool: Pool, eventoId: string, opts: OpcoesExpansao = {}): Promise<ResultadoExpansao | null> {
  const workerId = `${opts.workerId ?? `expansor-${process.pid}`}:${randomUUID()}`;
  const agora = opts.agora ?? (() => Date.now());
  const limite = Math.min(agora() + Math.max(0, opts.orcamentoMs ?? 60_000), opts.prazo ?? Number.POSITIVE_INFINITY);
  const posseMs = Math.max(1000, opts.posseMs ?? 5 * 60_000);
  const lote = Math.max(1, Math.min(opts.loteProcessos ?? 200, 1000));
  const lockTimeout = `${Math.max(1, Math.floor(opts.lockTimeoutMs ?? 30_000))}ms`;

  // A dimensão vem no próprio claim: nada entre o claim e o try que libera a posse.
  const { rows: posse } = await pool.query(
    `UPDATE tariff_recalculo_expansoes x
        SET worker_id = $2, posse_ate = now() + ($3 || ' milliseconds')::interval, atualizado_em = now()
       FROM tariff_tables t
      WHERE x.evento_id = $1 AND t.id = x.tariff_table_id
        AND x.concluida_em IS NULL AND (x.posse_ate IS NULL OR x.posse_ate < now())
      RETURNING x.organization_id, x.tariff_table_id, x.cursor_processo_id, t.tipo, t.armador_id, t.termo_comercial`,
    [eventoId, workerId, String(posseMs)],
  );
  if (!posse.length) return null;
  const { organization_id: org, tariff_table_id: tabelaId } = posse[0];
  let cursor: string | null = posse[0].cursor_processo_id;
  const dimensao: DimensaoTabela = { organizationId: org, tipo: posse[0].tipo, armadorId: posse[0].armador_id, termoComercial: posse[0].termo_comercial };
  const r: ResultadoExpansao = { processos: 0, itens: 0, concluida: false };

  /** Solta a posse (o progresso já está gravado, processo a processo). */
  const liberar = async (concluir: boolean) => {
    await pool.query(
      `UPDATE tariff_recalculo_expansoes
          SET worker_id = NULL, posse_ate = NULL, concluida_em = CASE WHEN $3 THEN now() END, atualizado_em = now()
        WHERE evento_id = $1 AND worker_id = $2`,
      [eventoId, workerId, concluir],
    );
    r.concluida = concluir;
  };

  try {
    for (;;) {
      if (agora() >= limite) { await liberar(false); return r; }
      // Candidatos: OPEN, ou FINAL com reabertura em curso (a autorização
      // pode estar comitando agora — o status é relido sob o lock).
      const params: unknown[] = [org];
      const filtro = filtroEscopo(dimensao, tabelaId, params);
      params.push(cursor, lote);
      const { rows: procs } = await pool.query(
        `SELECT p.id FROM processos p
          WHERE p.organization_id = $1 AND ${filtro}
            AND ($${params.length - 1}::uuid IS NULL OR p.id > $${params.length - 1}::uuid)
            AND (p.apuracao_status = 'OPEN'
                 OR EXISTS (SELECT 1 FROM reaberturas ra WHERE ra.processo_id = p.id AND ra.estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA')))
          ORDER BY p.id LIMIT $${params.length}`,
        params,
      );
      if (!procs.length) { await liberar(true); return r; }
      for (const { id: processoId } of procs) {
        if (agora() >= limite) { await liberar(false); return r; }
        const client = await pool.connect();
        let possePerdida = false;
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('lock_timeout', $1, true)`, [lockTimeout]);
          await lockProcesso(client, processoId);
          const { rows: st } = await client.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processoId]);
          let inseridos = 0;
          if (st[0]?.apuracao_status === 'OPEN') {
            const ins = await client.query(
              `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave)
               SELECT c.organization_id, c.id, 'tarifa', $2 FROM containers c
                WHERE c.processo_id = $1 AND c.organization_id = $3
                ORDER BY c.id
               ON CONFLICT (container_id, tipo, chave) DO NOTHING`,
              [processoId, eventoId, org],
            );
            inseridos = ins.rowCount ?? 0;
          }
          // Progresso + renovação da posse, atômicos com os itens e só para o dono.
          const prog = await client.query(
            `UPDATE tariff_recalculo_expansoes
                SET cursor_processo_id = $3, processos = processos + 1, itens = itens + $4,
                    posse_ate = now() + ($5 || ' milliseconds')::interval, atualizado_em = now()
              WHERE evento_id = $1 AND worker_id = $2`,
            [eventoId, workerId, processoId, inseridos, String(posseMs)],
          );
          if (!prog.rowCount) {
            possePerdida = true;
            await client.query('ROLLBACK');
          } else {
            await client.query('COMMIT');
            r.processos += 1;
            r.itens += inseridos;
            cursor = processoId;
          }
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
        // Posse tomada por outro expansor: ele segue do cursor gravado.
        if (possePerdida) return r;
        if (opts.aposProcesso) await opts.aposProcesso(processoId);
      }
    }
  } catch (err) {
    await liberar(false).catch(() => undefined);
    throw err;
  }
}

/** Etapa do tick: expansões pendentes (ordem de criação), com limite e prazo comum. */
export async function expandirPendentes(pool: Pool, opts: OpcoesExpansao & { limite?: number } = {}): Promise<{ expansoes: number; itens: number; falhas: number }> {
  const agora = opts.agora ?? (() => Date.now());
  const prazo = Math.min(agora() + Math.max(0, opts.orcamentoMs ?? 60_000), opts.prazo ?? Number.POSITIVE_INFINITY);
  const { rows } = await pool.query(
    `SELECT evento_id FROM tariff_recalculo_expansoes
      WHERE concluida_em IS NULL AND (posse_ate IS NULL OR posse_ate < now())
      ORDER BY criado_em, evento_id LIMIT $1`,
    [Math.max(1, opts.limite ?? 100)],
  );
  const r = { expansoes: 0, itens: 0, falhas: 0 };
  for (const { evento_id } of rows) {
    if (agora() >= prazo) break;
    try {
      const e = await expandirEvento(pool, evento_id, { ...opts, agora, prazo });
      if (e) { r.expansoes++; r.itens += e.itens; }
    } catch (e) {
      r.falhas++;
      // eslint-disable-next-line no-console
      console.error('[demurrage-tarifas] expansão adiada (retomada no próximo tick):', codigoErroRecalculo(e));
    }
  }
  return r;
}

/**
 * Vocabulário FECHADO do erro gravado em `recalculo_outbox.erro` pelos itens
 * `tarifa`: o texto cru do banco (constraint, trigger, ids, SQL) nunca é
 * persistido nem exposto — só a classe da falha. O log do worker leva o
 * mesmo código.
 */
export const CODIGOS_ERRO_RECALCULO = ['DEADLOCK', 'LOCK_TIMEOUT', 'SERIALIZACAO', 'REGRA_DE_BANCO', 'RESTRICAO_DE_INTEGRIDADE', 'ERRO_INTERNO'];

export function codigoErroRecalculo(err: unknown): string {
  const c = (err as { code?: unknown })?.code;
  if (c === '40P01') return 'DEADLOCK';
  if (c === '55P03') return 'LOCK_TIMEOUT';
  if (c === '40001') return 'SERIALIZACAO';
  if (c === 'P0001') return 'REGRA_DE_BANCO';
  if (typeof c === 'string' && c.startsWith('23')) return 'RESTRICAO_DE_INTEGRIDADE';
  return 'ERRO_INTERNO';
}

export interface RecalculoTarifarioResultado extends ProcessarRecalculosResultado {
  expansao: { expansoes: number; itens: number; falhas: number };
  /** Encerramento avaliado nos processos recalculados nesta etapa (erro = código fechado; a varredura cobre). */
  encerramento: { avaliados: number; finalizados: number; erro: string | null };
}

/** Máximo de processos recalculados cujo encerramento a etapa avalia (o resto a varredura cobre). */
const ENCERRAMENTO_POR_ETAPA = 200;

/**
 * Etapa isolada do tick: expande o que for devido e consome os itens
 * `tarifa` em lotes até esvaziar a fila ou esgotar o orçamento de tempo
 * (uma ativação de Termo Único pode alcançar milhares de contêineres — não
 * cabe esperar ~1 tick por lote de 50).
 *  - Orçamento ÚNICO para a etapa: a expansão usa no máximo a metade; o
 *    consumo, o que sobrar.
 *  - No máximo UMA tentativa por item por etapa: um item que falhou nesta
 *    etapa só volta a ser reivindicado na próxima (claim de FAILED só se a
 *    falha é anterior ao início da etapa) — sem parar a etapa inteira por um
 *    item problemático.
 *  - Encerramento: os processos ABERTOS recalculados nesta etapa são
 *    avaliados aqui, pelo mesmo núcleo e com a mesma regra da varredura
 *    (reabertura em curso respeitada) — a varredura do tick, limitada e em
 *    ordem justa, continua como rede de segurança.
 */
export async function processarRecalculoTarifario(input: {
  pool: Pool; hoje: CivilDate; workerId: string;
  orcamentoMs?: number; limitePorLote?: number; maxTentativas?: number;
  expansao?: OpcoesExpansao;
  recalcular?: Parameters<typeof processarRecalculosPendentes>[0]['recalcular'];
  /** Relógio injetável (teste). */
  agora?: () => number;
}): Promise<RecalculoTarifarioResultado> {
  const agora = input.agora ?? (() => Date.now());
  const inicio = agora();
  const orcamento = Math.max(0, input.orcamentoMs ?? 60_000);
  const prazo = inicio + orcamento;
  // Instante do BANCO (mesma base de `atualizado_em`/`concluido_em`).
  const { rows: t0 } = await input.pool.query(`SELECT clock_timestamp() AS inicio`);
  const inicioBanco: Date = t0[0].inicio;
  const expansao = await expandirPendentes(input.pool, {
    workerId: input.workerId, agora, ...(input.expansao ?? {}), prazo: inicio + Math.floor(orcamento / 2),
  });
  const base: (pool: Pool, containerId: string, config: { dataReferencia: CivilDate }) => Promise<unknown> = input.recalcular ?? recalcularApuracaoContainer;
  const recalcular = async (pool: Pool, containerId: string, config: { dataReferencia: CivilDate }): Promise<unknown> => {
    try {
      return await base(pool, containerId, config);
    } catch (err) {
      const codigo = codigoErroRecalculo(err);
      // eslint-disable-next-line no-console
      console.error(`[demurrage-tarifas] recálculo de contêiner falhou: ${codigo}`);
      throw new Error(codigo);
    }
  };
  const total: RecalculoTarifarioResultado = {
    reivindicados: 0, concluidos: 0, falhados: 0, restantes: 0, esgotados: 0, expansao, encerramento: { avaliados: 0, finalizados: 0, erro: null },
  };
  for (let lote = 0; lote < 1000; lote++) {
    const r = await processarRecalculosPendentes({
      pool: input.pool, hoje: input.hoje, workerId: input.workerId, tipos: ['tarifa'], falhadosAntesDe: inicioBanco,
      limite: input.limitePorLote ?? 50, maxTentativas: input.maxTentativas, recalcular,
    });
    total.reivindicados += r.reivindicados;
    total.concluidos += r.concluidos;
    total.falhados += r.falhados;
    total.restantes = r.restantes;
    total.esgotados = r.esgotados;
    if (r.reivindicados === 0 || agora() >= prazo) break;
  }
  if (total.concluidos > 0) {
    // Os itens já estão concluídos (comitados): uma falha aqui não apaga os
    // contadores da etapa — fica registrada e a varredura do tick cobre.
    try {
      total.encerramento = { ...(await avaliarEncerramentoDosRecalculados(input.pool, input.hoje, inicioBanco)), erro: null };
    } catch (err) {
      const codigo = codigoErroRecalculo(err);
      // eslint-disable-next-line no-console
      console.error(`[demurrage-tarifas] avaliação de encerramento dos recalculados adiada para a varredura: ${codigo}`);
      total.encerramento = { avaliados: 0, finalizados: 0, erro: codigo };
    }
  }
  return total;
}

async function avaliarEncerramentoDosRecalculados(pool: Pool, hoje: CivilDate, desde: Date): Promise<{ avaliados: number; finalizados: number }> {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.processo_id FROM recalculo_outbox o
       JOIN containers c ON c.id = o.container_id
       JOIN processos p ON p.id = c.processo_id
      WHERE o.tipo = 'tarifa' AND o.estado = 'DONE' AND o.desfecho = 'RECALCULADO' AND o.concluido_em >= $1
        AND p.apuracao_status = 'OPEN'
      ORDER BY c.processo_id LIMIT $2`,
    [desde, ENCERRAMENTO_POR_ETAPA],
  );
  const svc = new ClosingService(pool);
  const r = { avaliados: 0, finalizados: 0 };
  for (const { processo_id } of rows) {
    r.avaliados++;
    const res = await svc.avaliarEncerramentoAutomaticoSeguro({ processoId: processo_id, config: { hoje }, respeitarReabertura: true });
    if (res.resultado === 'finalizado') r.finalizados++;
  }
  return r;
}
