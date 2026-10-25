import { Pool } from 'pg';
import { ErroTarifa, ESTADOS_VERSAO, EstadoVersao, LadoTarifa, tipoDoLado } from './contrato';
import { LinhaVersao, SELECT_VERSAO, carregarFaixas, carregarLinhaVisivel, detalheVersao, versaoSaida } from './repositorio';
import {
  codificarCursorKeyset, decodificarCursorKeyset, expressaoChaveExata, hashFiltrosKeyset,
} from '../../leitura/cursorKeyset';
import { MAX_TENTATIVAS_RECALCULO } from '../../freeTime/recalculoOutbox';
import { previaDesativacao } from './servico';
import { CODIGOS_ERRO_RECALCULO } from './recalculo';

/**
 * Produção P1 (administração tarifária) — leituras paginadas. Cursores
 * keyset ASSINADOS e presos a (versão do contrato, organização da sessão,
 * filtros): um cursor de outra organização, de outros filtros ou adulterado
 * é `400 cursor_invalido` — nunca uma página de outro recorte.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CURSOR_VERSOES = 'p1.tarifas.versoes.v1';
export const CURSOR_HISTORICO = 'p1.tarifas.historico.v1';
const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;

export interface Papel { papel: 'ANALYST' | 'MANAGER' | 'ADMIN' }

function lerLimite(bruto: unknown): number {
  if (bruto === undefined) return LIMITE_PADRAO;
  if (typeof bruto !== 'string' || !/^\d{1,4}$/.test(bruto)) throw new ErroTarifa(400, 'parametro_invalido', { campo: 'limite' });
  const n = Number(bruto);
  if (n < 1 || n > LIMITE_MAXIMO) throw new ErroTarifa(400, 'parametro_invalido', { campo: 'limite' });
  return n;
}

function lerCursor(bruto: unknown): string | null {
  if (bruto === undefined) return null;
  if (typeof bruto !== 'string' || !bruto || bruto.length > 2000) throw new ErroTarifa(400, 'cursor_invalido');
  return bruto;
}

function ehGestor(p: Papel): boolean {
  return p.papel === 'MANAGER' || p.papel === 'ADMIN';
}

/* ------------------------------------------------------------------ *
 * 1 — Lista de versões
 * ------------------------------------------------------------------ */

export interface FiltrosVersoes {
  lado: LadoTarifa | null;
  estado: EstadoVersao | null;
  armadorId: string | null;
  termoComercial: 'unico' | 'embarque' | null;
  escopo: 'ORGANIZACAO' | 'PUBLICA';
}

export function lerFiltrosVersoes(q: Record<string, unknown>): FiltrosVersoes {
  const conhecidos = ['lado', 'estado', 'armadorId', 'termoComercial', 'escopo', 'limite', 'cursor'];
  const extra = Object.keys(q).find((k) => !conhecidos.includes(k));
  if (extra) throw new ErroTarifa(400, 'parametro_nao_aceito', { campo: extra });
  const um = (k: string) => {
    const v = q[k];
    if (v === undefined) return null;
    if (typeof v !== 'string' || !v) throw new ErroTarifa(400, 'parametro_invalido', { campo: k });
    return v;
  };
  const lado = um('lado');
  if (lado !== null && lado !== 'cliente' && lado !== 'armador') throw new ErroTarifa(400, 'parametro_invalido', { campo: 'lado' });
  const estado = um('estado');
  if (estado !== null && !(ESTADOS_VERSAO as readonly string[]).includes(estado)) throw new ErroTarifa(400, 'parametro_invalido', { campo: 'estado' });
  const armadorId = um('armadorId');
  if (armadorId !== null && !RE_UUID.test(armadorId)) throw new ErroTarifa(400, 'parametro_invalido', { campo: 'armadorId' });
  const termo = um('termoComercial');
  if (termo !== null && termo !== 'unico' && termo !== 'embarque') throw new ErroTarifa(400, 'parametro_invalido', { campo: 'termoComercial' });
  const escopo = um('escopo') ?? 'ORGANIZACAO';
  if (escopo !== 'ORGANIZACAO' && escopo !== 'PUBLICA') throw new ErroTarifa(400, 'parametro_invalido', { campo: 'escopo' });
  return {
    lado: lado as LadoTarifa | null, estado: estado as EstadoVersao | null,
    armadorId: armadorId ? armadorId.toLowerCase() : null, termoComercial: termo as 'unico' | 'embarque' | null, escopo,
  };
}

/**
 * Lista por `criado_em DESC, id DESC`. ANALYST nunca vê rascunho (nem
 * rascunho abandonado): só versões que já foram ativadas, o que a operação
 * precisa para entender o que é aplicado.
 */
export async function listarVersoes(
  pool: Pool, organizationId: string, papel: Papel, filtros: FiltrosVersoes, limiteBruto: unknown, cursorBruto: unknown,
): Promise<Record<string, unknown>> {
  const limite = lerLimite(limiteBruto);
  const cursor = lerCursor(cursorBruto);
  const somenteAtivadas = !ehGestor(papel);
  if (somenteAtivadas && filtros.estado === 'RASCUNHO') throw new ErroTarifa(403, 'escopo_nao_permitido');
  const filtrosHash = hashFiltrosKeyset([
    ['lado', filtros.lado], ['estado', filtros.estado], ['armadorId', filtros.armadorId],
    ['termoComercial', filtros.termoComercial], ['escopo', filtros.escopo], ['somenteAtivadas', somenteAtivadas],
  ]);
  const params: unknown[] = [organizationId];
  const conds: string[] = [filtros.escopo === 'PUBLICA'
    ? `t.organization_id IS NULL AND t.tipo = 'armador'`
    : `t.organization_id = $1`];
  if (filtros.escopo === 'PUBLICA') conds.push(`$1::uuid IS NOT NULL`);
  if (filtros.lado) { params.push(tipoDoLado(filtros.lado)); conds.push(`t.tipo = $${params.length}::tariff_table_tipo`); }
  if (filtros.armadorId) { params.push(filtros.armadorId); conds.push(`t.armador_id = $${params.length}`); }
  if (filtros.termoComercial) { params.push(filtros.termoComercial); conds.push(`t.termo_comercial = $${params.length}::termo_comercial_tipo`); }
  if (somenteAtivadas) conds.push(`t.ativada_em IS NOT NULL`);
  let posicao = '';
  if (cursor) {
    const c = decodificarCursorKeyset(cursor, CURSOR_VERSOES, organizationId, filtrosHash);
    params.push(c.ultimaChave, c.ultimoId);
    posicao = `AND (v.chave_criado < $${params.length - 1} OR (v.chave_criado = $${params.length - 1} AND v.id < $${params.length}::uuid))`;
  }
  let filtroEstado = '';
  if (filtros.estado) { params.push(filtros.estado); filtroEstado = `AND v.estado = $${params.length}`; }
  params.push(limite + 1);
  const { rows } = await pool.query<LinhaVersao>(
    `SELECT * FROM (${SELECT_VERSAO} WHERE ${conds.join(' AND ')}) v
      WHERE TRUE ${filtroEstado} ${posicao}
      ORDER BY v.chave_criado DESC, v.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const pagina = rows.slice(0, limite);
  const itens = [];
  for (const l of pagina) itens.push(versaoSaida(l, await carregarFaixas(pool, l.id)));
  const ultimo = pagina[pagina.length - 1];
  return {
    contrato: 'demurrage.tarifas.versoes.v1',
    itens,
    proximoCursor: rows.length > limite && ultimo
      ? codificarCursorKeyset({ v: CURSOR_VERSOES, organizationId, filtrosHash, ultimaChave: ultimo.chave_criado, ultimoId: ultimo.id })
      : null,
  };
}

/**
 * 2 — Versão (com faixas). ANALYST: rascunho (ou abandonado) → 404. Uma
 * única fotografia (REPEATABLE READ): estado, revisão e prévia de impacto que
 * o operador devolve na desativação saem do mesmo instante.
 */
export async function obterVersao(pool: Pool, organizationId: string, papel: Papel, tabelaId: string): Promise<Record<string, unknown>> {
  if (!RE_UUID.test(tabelaId)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  const client = await pool.connect();
  let detalhe: Awaited<ReturnType<typeof detalheVersao>> & { impactoDesativacao: Record<string, number> | null };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const l = await carregarLinhaVisivel(client, tabelaId, organizationId);
    if (!l || (!ehGestor(papel) && l.ativada_em === null)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
    detalhe = {
      ...(await detalheVersao(client, l)),
      // Prévia do impacto de desativar (o operador confirma esse número); só
      // para quem pode desativar, só em versão publicada da própria organização.
      impactoDesativacao: ehGestor(papel) && l.organization_id === organizationId
        ? await previaDesativacao(client, organizationId, l) : null,
    };
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (!ehGestor(papel)) {
    // ANALYST: o que a operação precisa (dimensão, versão, estado, vigência,
    // faixas, moeda, qualidade) — nunca as alças de administração.
    const { conteudoHash: _h, revisaoDimensao: _r, impactoDesativacao: _i, ...operacional } = detalhe;
    return { contrato: 'demurrage.tarifas.versao.v1', versao: operacional };
  }
  return { contrato: 'demurrage.tarifas.versao.v1', versao: detalhe };
}

/* ------------------------------------------------------------------ *
 * 11 — Histórico (auditoria) de uma versão e situação do recálculo
 * ------------------------------------------------------------------ */

function eventoSaida(r: any): Record<string, unknown> {
  return {
    id: r.id, operacao: r.operacao, tabelaId: r.tariff_table_id, versao: r.versao,
    lado: r.tipo === 'rocket_cliente' ? 'cliente' : 'armador', armadorId: r.armador_id, termoComercial: r.termo_comercial,
    autor: { membershipId: r.autor_membership_id, usuarioId: r.autor_usuario_id, papel: r.autor_papel },
    em: new Date(r.criado_em).toISOString(),
    motivo: r.motivo, valoresAnteriores: r.valores_anteriores, valoresNovos: r.valores_novos,
    conteudoHash: r.conteudo_hash, idempotencyKey: r.idempotencia_chave,
    recalculo: { eventoOrigemId: r.recalculo_evento_origem_id },
  };
}

export async function historicoVersao(
  pool: Pool, organizationId: string, tabelaId: string, limiteBruto: unknown, cursorBruto: unknown,
): Promise<Record<string, unknown>> {
  if (!RE_UUID.test(tabelaId)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  const limite = lerLimite(limiteBruto);
  const cursor = lerCursor(cursorBruto);
  const l = await carregarLinhaVisivel(pool, tabelaId, organizationId);
  if (!l) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  const filtrosHash = hashFiltrosKeyset([['tabelaId', l.id]]);
  const params: unknown[] = [organizationId, l.id];
  let posicao = '';
  if (cursor) {
    const c = decodificarCursorKeyset(cursor, CURSOR_HISTORICO, organizationId, filtrosHash);
    params.push(c.ultimaChave, c.ultimoId);
    posicao = `AND (${expressaoChaveExata('e.criado_em')} > $3 OR (${expressaoChaveExata('e.criado_em')} = $3 AND e.id > $4::uuid))`;
  }
  params.push(limite + 1);
  // Versão pública: só os eventos DESTA organização sobre ela (cópias), nunca os de outra.
  const { rows } = await pool.query(
    `SELECT e.*, ${expressaoChaveExata('e.criado_em')} AS chave
       FROM tariff_admin_eventos e
      WHERE e.organization_id = $1 AND e.tariff_table_id = $2 ${posicao}
      ORDER BY e.criado_em ASC, e.id ASC
      LIMIT $${params.length}`,
    params,
  );
  const pagina = rows.slice(0, limite);
  const ultimo = pagina[pagina.length - 1];
  const { rows: transicoes } = await pool.query(
    `SELECT tipo, vigencia_efetiva_fim::text AS vigencia_efetiva_fim, substituida_por_id, evento_id, criado_em
       FROM tariff_versao_transicoes WHERE tariff_table_id = $1 AND organization_id = $2 ORDER BY criado_em, id`,
    [l.id, organizationId],
  );
  return {
    contrato: 'demurrage.tarifas.historico.v1',
    tabelaId: l.id, versao: l.versao, estado: l.estado,
    eventos: pagina.map(eventoSaida),
    transicoes: transicoes.map((t) => ({
      tipo: t.tipo, vigenciaEfetivaFim: t.vigencia_efetiva_fim, substituidaPorId: t.substituida_por_id,
      eventoId: t.evento_id, em: new Date(t.criado_em).toISOString(),
    })),
    proximoCursor: rows.length > limite && ultimo
      ? codificarCursorKeyset({ v: CURSOR_HISTORICO, organizationId, filtrosHash, ultimaChave: ultimo.chave, ultimoId: ultimo.id })
      : null,
  };
}

/**
 * Situação do recálculo correlacionado a um evento (`recalculo_outbox.chave`
 * = id do evento). Expõe só estados, tentativas e ids — nunca o texto do
 * erro (pode conter detalhe interno de banco); o log do worker tem o resto.
 */
export async function situacaoRecalculo(pool: Pool, organizationId: string, eventoId: string): Promise<Record<string, unknown>> {
  if (!RE_UUID.test(eventoId)) throw new ErroTarifa(404, 'evento_nao_encontrado');
  const { rows: ev } = await pool.query(
    `SELECT e.id, e.operacao, e.tariff_table_id, e.recalculo_evento_origem_id,
            x.evento_id AS expansao_id, x.processos, x.itens, x.concluida_em,
            COALESCE(x.posse_ate > now(), false) AS em_execucao
       FROM tariff_admin_eventos e LEFT JOIN tariff_recalculo_expansoes x ON x.evento_id = e.id
      WHERE e.id = $1 AND e.organization_id = $2`,
    [eventoId, organizationId],
  );
  if (!ev.length) throw new ErroTarifa(404, 'evento_nao_encontrado');
  const e = ev[0];
  const { rows: cont } = await pool.query(
    `SELECT count(*) FILTER (WHERE estado = 'PENDING')::int AS pendentes,
            count(*) FILTER (WHERE estado = 'PROCESSING')::int AS processando,
            count(*) FILTER (WHERE estado = 'DONE' AND desfecho = 'RECALCULADO')::int AS recalculados,
            count(*) FILTER (WHERE estado = 'DONE' AND desfecho = 'IGNORADO_FINAL')::int AS ignorados_final,
            count(*) FILTER (WHERE estado = 'FAILED' AND tentativas < $3)::int AS falhados_retentaveis,
            count(*) FILTER (WHERE estado = 'FAILED' AND tentativas >= $3)::int AS esgotados
       FROM recalculo_outbox WHERE tipo = 'tarifa' AND chave = $1::text AND organization_id = $2`,
    [eventoId, organizationId, MAX_TENTATIVAS_RECALCULO],
  );
  const { rows: falhas } = await pool.query(
    `SELECT o.container_id, c.processo_id, o.tentativas, o.atualizado_em, o.erro
       FROM recalculo_outbox o JOIN containers c ON c.id = o.container_id
      WHERE o.tipo = 'tarifa' AND o.chave = $1::text AND o.organization_id = $2 AND o.estado = 'FAILED'
      ORDER BY o.atualizado_em, o.container_id LIMIT 200`,
    [eventoId, organizationId],
  );
  const c = cont[0];
  const expansao = e.expansao_id === null ? null : {
    concluida: e.concluida_em !== null, processosPercorridos: e.processos, itensEnfileirados: e.itens,
    // Posse VIGENTE: um expansor que caiu deixa a posse vencer — não está mais "em execução".
    emExecucao: e.em_execucao,
  };
  return {
    contrato: 'demurrage.tarifas.recalculo.v1',
    eventoId, operacao: e.operacao, tabelaId: e.tariff_table_id, eventoOrigemId: e.recalculo_evento_origem_id,
    expansao,
    pendentes: c.pendentes, processando: c.processando, recalculados: c.recalculados, ignoradosFinal: c.ignorados_final,
    falhadosRetentaveis: c.falhados_retentaveis, esgotados: c.esgotados,
    maxTentativas: MAX_TENTATIVAS_RECALCULO,
    concluido: expansao !== null && expansao.concluida && c.pendentes + c.processando + c.falhados_retentaveis + c.esgotados === 0,
    falhas: falhas.map((f) => ({
      containerId: f.container_id, processoId: f.processo_id, tentativas: f.tentativas,
      // Só o vocabulário fechado gravado pela etapa tarifária; qualquer outro texto nunca sai.
      erroCodigo: CODIGOS_ERRO_RECALCULO.includes(f.erro) ? f.erro : 'ERRO_INTERNO',
      esgotado: f.tentativas >= MAX_TENTATIVAS_RECALCULO, atualizadoEm: new Date(f.atualizado_em).toISOString(),
    })),
  };
}
