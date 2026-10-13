import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Db } from '../../identidade';
import { mastersCitadosPeloProcesso, processosVinculadosAoMaster } from '../../auditoria/fatos/vinculos';
import { AvaliacaoProcesso, avaliarProcesso } from '../dominio';
import { DivergenciaDeConferencia, divergenciasDoCourier } from './divergencias';
import { EntradaCarregada, FontesDaAvaliacao, FonteTerminal, SEM_PRODUTOR_TERMINAL, carregarEntrada } from './entrada';

/**
 * L2 — projeção persistida da Liberação. Fluxo único e reconstruível:
 *   fatos vigentes (S1, S2, S6) → adaptador → L1a → comparação → gravação.
 *
 * Material × frescor: a impressão material é o sha256 da avaliação da L1a SEM
 * o que é só frescor ou eco de disponibilidade (`ultimaConfirmacaoEm`,
 * `fonteCourier`, `indisponivelDesde`). Assim:
 *  - mesma avaliação → nada é gravado;
 *  - só frescor/ponteiros mudaram → a linha atual é atualizada, sem evento;
 *  - disponibilidade da fonte só vira evento se mudar uma saída da L1a
 *    (resolução, House, etapa, bloqueador, próxima ação);
 *  - mudança material → linha atual + UM evento, na mesma transação.
 * Tudo sob bloqueio por processo: reexecução e retentativa são idempotentes.
 * Terminal (LIBERADO) nunca é reaberto: o recálculo devolve a projeção como está.
 */

/** 2: a avaliação passa a levar as divergências do físico (L4). */
export const VERSAO_PROJECAO = 2;

/**
 * Avaliação da Liberação de um processo: a saída da L1a (`avaliarProcesso`)
 * mais as divergências do físico, também da L1a (`aplicarObservacao`). As
 * divergências não mudam o fato oficial nem a etapa: só ficam registradas.
 */
export interface AvaliacaoLiberacao extends AvaliacaoProcesso {
  divergencias: DivergenciaDeConferencia[];
}

export function avaliarLiberacao(c: EntradaCarregada): AvaliacaoLiberacao {
  return { ...avaliarProcesso(c.entrada), divergencias: divergenciasDoCourier(c.conferencias, c.entrada.courier.fonte) };
}

export type GatilhoRecalculo =
  | 'COURIER_CONFERENCIA' | 'COURIER_ENVELOPE' | 'AUDITORIA_VINCULO' | 'IDENTIDADE_RESOLVIDA' | 'MASTER_COMPARTILHADO'
  | 'RECONSTRUCAO' | 'RECONSTRUCAO_MANUAL';

export interface ProjecaoLiberacao {
  organizationId: string;
  processoId: string;
  /** Saída da L1a, como ela devolveu (inclusive NAO_DETERMINAVEL / NAO_CONFIRMAVEL), com as divergências do físico. */
  avaliacao: AvaliacaoLiberacao;
  fontes: FontesDaAvaliacao;
  impressaoMaterial: string;
  versaoProjecao: number;
  /** Evento que estabeleceu o estado material atual. */
  sequencia: number;
  terminal: boolean;
  /** Avaliação que produziu o conteúdo gravado. */
  avaliadoEm: string;
  /** Quando o estado material atual foi estabelecido. */
  alteradoEm: string;
}

export type ResultadoRecalculo =
  | { status: 'PROCESSO_NAO_ENCONTRADO' }
  | { status: 'PRIMEIRA_AVALIACAO' | 'MUDANCA_MATERIAL'; evento: { id: string; sequencia: number }; projecao: ProjecaoLiberacao }
  | { status: 'SEM_MUDANCA_MATERIAL'; atualizada: boolean; projecao: ProjecaoLiberacao }
  | { status: 'TERMINAL_PRESERVADO'; projecao: ProjecaoLiberacao };

export interface OpcoesRecalculo {
  gatilho?: GatilhoRecalculo;
  /** Só na reconstrução pedida por uma pessoa (S4); recálculo interno não tem ator. */
  acionadoPorMembershipId?: string | null;
  terminal?: FonteTerminal;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ehUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/* ----------------------------- impressão material ----------------------------- */

const SO_FRESCOR = new Set(['ultimaConfirmacaoEm', 'fonteCourier', 'indisponivelDesde']);

function podar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(podar);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => !SO_FRESCOR.has(k) && x !== undefined).map(([k, x]) => [k, podar(x)]));
  }
  return v;
}

/** JSON canônico (chaves ordenadas, `undefined` omitido como no JSON/JSONB). */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonico(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const pares = Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonico((v as Record<string, unknown>)[k])}`);
    return `{${pares.join(',')}}`;
  }
  return JSON.stringify(v);
}

/** O significado operacional da avaliação, sem frescor nem eco de disponibilidade. */
export const vistaMaterial = (avaliacao: AvaliacaoProcesso): unknown => podar(avaliacao);

export const impressaoMaterial = (avaliacao: AvaliacaoProcesso): string =>
  createHash('sha256').update(canonico(vistaMaterial(avaliacao))).digest('hex');

const ehTerminal = (avaliacao: AvaliacaoProcesso): boolean => avaliacao.etapa.tipo === 'DETERMINADA' && avaliacao.etapa.etapa === 'LIBERADO';

/* ----------------------------------- leitura ----------------------------------- */

function projecaoDaLinha(r: Record<string, any>): ProjecaoLiberacao {
  return {
    organizationId: r.organization_id, processoId: r.processo_id, avaliacao: r.avaliacao, fontes: r.fontes,
    impressaoMaterial: r.impressao_material, versaoProjecao: r.versao_projecao, sequencia: r.sequencia, terminal: r.terminal,
    avaliadoEm: new Date(r.avaliado_em).toISOString(), alteradoEm: new Date(r.alterado_em).toISOString(),
  };
}

/**
 * Contrato de leitura (Liberação UI, Home, Fila, Clara — depois): a projeção
 * atual do processo nesta organização, ou null se ainda não foi avaliado. Só
 * leitura: nunca recalcula nem grava.
 */
export async function obterLiberacaoDoProcesso(db: Db, organizationId: string, processoId: string): Promise<ProjecaoLiberacao | null> {
  if (!ehUuid(processoId)) return null;
  const { rows: [r] } = await db.query(
    `SELECT * FROM liberacao_avaliacoes WHERE organization_id = $1 AND processo_id = $2`, [organizationId, processoId],
  );
  return r ? projecaoDaLinha(r) : null;
}

/* --------------------------------- recálculo --------------------------------- */

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (erro) {
    await c.query('ROLLBACK');
    throw erro;
  } finally {
    c.release();
  }
}

async function gravarLinha(
  c: PoolClient, organizationId: string, processoId: string,
  l: { avaliacao: AvaliacaoLiberacao; fontes: FontesDaAvaliacao; impressao: string; sequencia: number; avaliadoEm: Date; alteradoEm: Date },
): Promise<ProjecaoLiberacao> {
  const { rows: [r] } = await c.query(
    `INSERT INTO liberacao_avaliacoes
       (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (organization_id, processo_id) DO UPDATE SET
       avaliacao = EXCLUDED.avaliacao, fontes = EXCLUDED.fontes, impressao_material = EXCLUDED.impressao_material,
       versao_projecao = EXCLUDED.versao_projecao, sequencia = EXCLUDED.sequencia, terminal = EXCLUDED.terminal,
       avaliado_em = EXCLUDED.avaliado_em, alterado_em = EXCLUDED.alterado_em
     RETURNING *`,
    [organizationId, processoId, JSON.stringify(l.avaliacao), JSON.stringify(l.fontes), l.impressao, VERSAO_PROJECAO, l.sequencia,
      ehTerminal(l.avaliacao), l.avaliadoEm, l.alteradoEm],
  );
  return projecaoDaLinha(r);
}

/**
 * Recalcula a Liberação de UM processo a partir dos fatos vigentes:
 * 1) carrega os fatos; 2) converte para a L1a; 3) avalia; 4) compara com a
 * projeção atual; 5) grava só o que mudou (evento só se material); 6) devolve
 * a projeção vigente. Sem a linha atual (projeção derivada apagada), compara
 * com o último evento: reconstruir não duplica histórico.
 */
export async function recalcularLiberacaoProcesso(
  pool: Pool, organizationId: string, processoId: string, opcoes: OpcoesRecalculo = {},
): Promise<ResultadoRecalculo> {
  if (!ehUuid(processoId)) return { status: 'PROCESSO_NAO_ENCONTRADO' };
  const gatilho = opcoes.gatilho ?? 'RECONSTRUCAO';
  const acionadoPor = gatilho === 'RECONSTRUCAO_MANUAL' ? (opcoes.acionadoPorMembershipId ?? null) : null;
  if (gatilho === 'RECONSTRUCAO_MANUAL' && !acionadoPor) throw new Error('reconstrução manual exige a pessoa (membership) que a pediu');

  return emTransacao(pool, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`l2:${organizationId}:${processoId}`]);
    const { rows: [proc] } = await c.query(`SELECT 1 FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId]);
    if (!proc) return { status: 'PROCESSO_NAO_ENCONTRADO' };

    const { rows: [atual] } = await c.query(
      `SELECT * FROM liberacao_avaliacoes WHERE organization_id = $1 AND processo_id = $2 FOR UPDATE`, [organizationId, processoId],
    );
    if (atual?.terminal) return { status: 'TERMINAL_PRESERVADO', projecao: projecaoDaLinha(atual) };
    const { rows: [ultimo] } = await c.query(
      `SELECT * FROM liberacao_avaliacao_eventos WHERE organization_id = $1 AND processo_id = $2 ORDER BY sequencia DESC LIMIT 1`,
      [organizationId, processoId],
    );
    if (!atual && ultimo && ehTerminal(ultimo.avaliacao_nova)) {
      // Terminal sem a linha atual (só por remoção administrativa): restaura do histórico, nunca reavalia.
      const projecao = await gravarLinha(c, organizationId, processoId, {
        avaliacao: ultimo.avaliacao_nova, fontes: ultimo.fontes, impressao: ultimo.impressao_nova, sequencia: ultimo.sequencia,
        avaliadoEm: ultimo.registrado_em, alteradoEm: ultimo.registrado_em,
      });
      return { status: 'TERMINAL_PRESERVADO', projecao };
    }

    const carregada = await carregarEntrada(c, organizationId, processoId, opcoes.terminal ?? SEM_PRODUTOR_TERMINAL);
    if (!carregada) return { status: 'PROCESSO_NAO_ENCONTRADO' };
    const avaliacao = avaliarLiberacao(carregada);
    const { fontes } = carregada;
    const impressao = impressaoMaterial(avaliacao);
    const { rows: [{ agora }] } = await c.query(`SELECT now() AS agora`);

    const referencia = atual
      ? { impressao: atual.impressao_material as string, avaliacao: atual.avaliacao, sequencia: atual.sequencia as number, alteradoEm: atual.alterado_em }
      : ultimo
        ? { impressao: ultimo.impressao_nova as string, avaliacao: ultimo.avaliacao_nova, sequencia: ultimo.sequencia as number, alteradoEm: ultimo.registrado_em }
        : null;

    if (referencia && referencia.impressao === impressao) {
      const identica = atual && atual.versao_projecao === VERSAO_PROJECAO
        && canonico(atual.avaliacao) === canonico(avaliacao) && canonico(atual.fontes) === canonico(fontes);
      if (identica) return { status: 'SEM_MUDANCA_MATERIAL', atualizada: false, projecao: projecaoDaLinha(atual) };
      const projecao = await gravarLinha(c, organizationId, processoId, {
        avaliacao, fontes, impressao, sequencia: referencia.sequencia, avaliadoEm: agora, alteradoEm: referencia.alteradoEm,
      });
      return { status: 'SEM_MUDANCA_MATERIAL', atualizada: true, projecao };
    }

    const sequencia = (ultimo?.sequencia ?? 0) + 1;
    const { rows: [evento] } = await c.query(
      `INSERT INTO liberacao_avaliacao_eventos
         (organization_id, processo_id, sequencia, impressao_anterior, impressao_nova, avaliacao_anterior, avaliacao_nova, fontes,
          gatilho, acionado_por_membership_id, versao_projecao, registrado_em)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [organizationId, processoId, sequencia, referencia?.impressao ?? null, impressao,
        referencia ? JSON.stringify(referencia.avaliacao) : null, JSON.stringify(avaliacao), JSON.stringify(fontes),
        gatilho, acionadoPor, VERSAO_PROJECAO, agora],
    );
    const projecao = await gravarLinha(c, organizationId, processoId, {
      avaliacao, fontes, impressao, sequencia, avaliadoEm: agora, alteradoEm: agora,
    });
    return {
      status: referencia ? 'MUDANCA_MATERIAL' : 'PRIMEIRA_AVALIACAO', evento: { id: evento.id, sequencia }, projecao,
    };
  });
}

/**
 * Recalcula o processo e os que compartilham com ele um Master (o fato físico
 * do Master chega a todos os vinculados). Inclui os Masters de qualquer linha
 * de vínculo do processo, válida ou não, para cobrir a passagem de vínculo
 * publicado para CONFLITO. Sem varredura global: só os processos desses Masters.
 */
export async function recalcularAfetadosPeloProcesso(
  pool: Pool, organizationId: string, processoId: string, gatilho: GatilhoRecalculo, opcoes: Omit<OpcoesRecalculo, 'gatilho'> = {},
): Promise<Map<string, ResultadoRecalculo>> {
  const resultados = new Map<string, ResultadoRecalculo>();
  resultados.set(processoId, await recalcularLiberacaoProcesso(pool, organizationId, processoId, { ...opcoes, gatilho }));
  const outros = new Set<string>();
  for (const masterId of await mastersCitadosPeloProcesso(pool, organizationId, processoId)) {
    for (const v of await processosVinculadosAoMaster(pool, organizationId, masterId)) {
      if (v.processoId !== processoId) outros.add(v.processoId);
    }
  }
  for (const outro of [...outros].sort()) {
    resultados.set(outro, await recalcularLiberacaoProcesso(pool, organizationId, outro, { ...opcoes, gatilho: 'MASTER_COMPARTILHADO' }));
  }
  return resultados;
}
