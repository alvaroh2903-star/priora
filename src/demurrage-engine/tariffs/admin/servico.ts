import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  ConteudoVersao, DimensaoTabela, ErroTarifa, ErroValidacao, FaixaAdmin, MetadadosVersao, TermoComercial,
  erroValidacao, faixasOrdenadas, hashConteudo, hashPedido, tipoDoLado,
} from './contrato';
import { dimensaoEhEmbarque, lerFaixasDoCorpo, lerMetadadosDoCorpo, sobreposicoes, validarConteudo } from './validacao';
import {
  LinhaVersao, armadorExiste, carregarFaixas, carregarLinha, carregarLinhaDaOrganizacao, carregarLinhaVisivel, catalogoEquipamentos,
  chaveLockDimensao, chaveLockMutacao, conteudoDe, dimensaoDe, revisaoDimensao, versaoExistenteDe, versoesParaPlano, vigenciaEfetivaDe,
} from './repositorio';
import { PlanoAtivacao, planejarAtivacao, versoesExpostasPorDesativacao } from './vigencia';
import { MAX_TENTATIVAS_RECALCULO } from '../../freeTime/recalculoOutbox';
import { filtroEscopo, registrarExpansao } from './recalculo';
import { TariffTableRepository } from '../../persistence/tariffTableRepository';

/**
 * Produção P1 (administração tarifária) — MUTAÇÕES. Cada operação é UMA
 * transação curta, só de banco (nenhuma chamada externa dentro dela), que:
 *  1. trava a chave de idempotência `(organização, chave)` (lock consultivo);
 *  2. relê o membership do ator SOB LOCK (`FOR SHARE`): MANAGER ou ADMIN
 *     ativo da organização da SESSÃO — nunca um papel em cache;
 *  3. devolve a resposta gravada se a chave já foi usada com o MESMO pedido
 *     (replay, sem efeito), ou 409 se com outro pedido;
 *  4. trava a DIMENSÃO da versão (lock consultivo) e depois a linha alvo
 *     (`FOR NO KEY UPDATE` — não conflita com o KEY SHARE que as FKs do
 *     recálculo pegam em `tariff_tables`, então nunca forma ciclo com ele);
 *  5. valida de novo, aplica, grava UM evento de auditoria (que é também o
 *     registro de idempotência) e, quando muda o que é aplicável, enfileira o
 *     recálculo dos processos ABERTOS afetados no outbox existente;
 *  6. COMMIT.
 * A organização vem SEMPRE do ator (sessão); a versão de outra organização é
 * 404. Uma falha (4xx ou 5xx) desfaz tudo e nunca consome a chave.
 */

export interface AtorTarifa {
  organizationId: string;
  membershipId: string;
}

interface AutorRelido {
  usuarioId: string;
  papel: 'MANAGER' | 'ADMIN';
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_HASH = /^[0-9a-f]{64}$/;
const VERSAO_HASH_PEDIDO = 'tarifas.pedido.v1';

/** Ganchos SÓ DE TESTE (nenhuma rota os expõe). */
export interface GanchosTeste {
  /** Dentro da transação, depois de todos os locks e validações, antes de escrever. */
  aposLocks?: () => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Infraestrutura da transação administrativa
 * ------------------------------------------------------------------ */

async function relerAutor(client: PoolClient, ator: AtorTarifa): Promise<AutorRelido> {
  const { rows } = await client.query(
    `SELECT usuario_id, papel, desativado_em FROM organization_memberships
      WHERE id = $1 AND organization_id = $2 FOR SHARE`,
    [ator.membershipId, ator.organizationId],
  );
  const m = rows[0];
  if (!m || m.desativado_em !== null || (m.papel !== 'MANAGER' && m.papel !== 'ADMIN')) {
    throw new ErroTarifa(403, 'apenas_manager_admin');
  }
  return { usuarioId: m.usuario_id, papel: m.papel };
}

async function lockConsultivo(client: PoolClient, chave: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [chave]);
}

type Resultado = Record<string, unknown>;

/**
 * Esqueleto comum: transação, lock da chave, autor relido, replay. `executar`
 * recebe o client já dentro da transação e devolve a resposta (que ele mesmo
 * gravou no evento).
 */
async function comTransacao(
  pool: Pool, ator: AtorTarifa, chave: string, hash: string,
  executar: (client: PoolClient, autor: AutorRelido) => Promise<Resultado>,
): Promise<Resultado & { replay: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockConsultivo(client, `demurrage:tarifa:idempotencia:${ator.organizationId}:${chave}`);
    const autor = await relerAutor(client, ator);
    const { rows: anteriores } = await client.query(
      `SELECT idempotencia_hash, resultado FROM tariff_admin_eventos WHERE organization_id = $1 AND idempotencia_chave = $2`,
      [ator.organizationId, chave],
    );
    if (anteriores.length) {
      await client.query('ROLLBACK');
      if (anteriores[0].idempotencia_hash !== hash) throw new ErroTarifa(409, 'idempotency_key_reutilizada');
      return { ...anteriores[0].resultado, replay: true };
    }
    const resultado = await executar(client, autor);
    await client.query('COMMIT');
    return { ...resultado, replay: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface EventoInput {
  id?: string;
  linha: Pick<LinhaVersao, 'id' | 'tipo' | 'armador_id' | 'termo_comercial' | 'versao'>;
  operacao: 'CRIAR_RASCUNHO' | 'CRIAR_VERSAO_DE' | 'ATUALIZAR_METADADOS' | 'SUBSTITUIR_FAIXAS' | 'ATIVAR' | 'DESATIVAR' | 'REPROCESSAR_RECALCULO';
  motivo: string | null;
  anteriores: unknown;
  novos: unknown;
  conteudoHash: string;
  resultado: Resultado;
  origemId?: string | null;
}

async function gravarEvento(client: PoolClient, ator: AtorTarifa, autor: AutorRelido, chave: string, hash: string, e: EventoInput): Promise<string> {
  const id = e.id ?? randomUUID();
  await client.query(
    `INSERT INTO tariff_admin_eventos
       (id, organization_id, tariff_table_id, operacao, tipo, armador_id, termo_comercial, versao,
        autor_membership_id, autor_usuario_id, autor_papel, motivo, valores_anteriores, valores_novos,
        conteudo_hash, idempotencia_chave, idempotencia_hash, resultado, recalculo_evento_origem_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18::jsonb,$19)`,
    [
      id, ator.organizationId, e.linha.id, e.operacao, e.linha.tipo, e.linha.armador_id, e.linha.termo_comercial, e.linha.versao,
      ator.membershipId, autor.usuarioId, autor.papel, e.motivo,
      e.anteriores === null ? null : JSON.stringify(e.anteriores), e.novos === null ? null : JSON.stringify(e.novos),
      e.conteudoHash, chave, hash, JSON.stringify(e.resultado), e.origemId ?? null,
    ],
  );
  return id;
}

/** Linha da organização do ator, travada para escrita; pública → 409; ausente/outra organização → 404. */
async function travarVersaoDaOrganizacao(client: PoolClient, ator: AtorTarifa, tabelaId: string): Promise<LinhaVersao> {
  if (!RE_UUID.test(tabelaId)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  const vis = await carregarLinhaVisivel(client, tabelaId, ator.organizationId);
  if (!vis) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  if (vis.organization_id === null) throw new ErroTarifa(409, 'tabela_publica_somente_leitura');
  // A dimensão nunca muda pela API; trava-a ANTES da linha (ordem universal:
  // chave → membership → dimensão/versão → linha).
  const dimensaoTravada = dimensaoDe(vis);
  await lockConsultivo(client, chaveLockMutacao(dimensaoTravada, tabelaId));
  await client.query(`SELECT 1 FROM tariff_tables WHERE id = $1 FOR NO KEY UPDATE`, [tabelaId]);
  const l = await carregarLinhaDaOrganizacao(client, tabelaId, ator.organizationId);
  if (!l) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  // Defesa: a dimensão relida sob lock é a que foi travada (SQL direto num
  // rascunho poderia tê-la mudado entre a leitura e o lock).
  if (JSON.stringify(dimensaoDe(l)) !== JSON.stringify(dimensaoTravada)) throw new ErroTarifa(409, 'conflito_concorrente');
  return l;
}

function motivoObrigatorio(corpo: Record<string, unknown>): string {
  const m = corpo.motivo;
  if (typeof m !== 'string' || !m.trim() || m.length > 1000) throw new ErroTarifa(400, 'campo_invalido', { campo: 'motivo' });
  return m.trim();
}

function motivoOpcional(corpo: Record<string, unknown>): string | null {
  if (corpo.motivo === undefined || corpo.motivo === null) return null;
  return motivoObrigatorio(corpo);
}

async function validacaoCompleta(client: PoolClient, l: LinhaVersao, conteudo: ConteudoVersao): Promise<{ erros: ErroValidacao[]; plano: PlanoAtivacao }> {
  const erros = validarConteudo(conteudo, { equipamentos: await catalogoEquipamentos(client) });
  const d = conteudo.dimensao;
  if (d.tipo === 'armador' && d.armadorId && !(await armadorExiste(client, d.armadorId))) {
    erros.push({ codigo: 'armador_inexistente', campo: 'armadorId' });
  }
  let plano: PlanoAtivacao = { substituicoes: [], conflitos: [] };
  // Termo por Embarque: o motor fixa a versão por ID na condição e ignora a
  // vigência — versões dessa dimensão nunca se substituem nem conflitam por
  // data (cada embarque usa a que fixou); a vigência é só informativa.
  if (!dimensaoEhEmbarque(d) && conteudo.vigenciaInicio && (conteudo.vigenciaFim === null || conteudo.vigenciaFim >= conteudo.vigenciaInicio)) {
    plano = planejarAtivacao({ inicio: conteudo.vigenciaInicio, fim: conteudo.vigenciaFim }, await versoesParaPlano(client, d, l.id));
    for (const c of plano.conflitos) {
      erros.push({ codigo: 'conflito_com_versao_ativa', campo: 'vigenciaInicio', detalhe: { tabelaId: c.tabelaId, versao: c.versao, inicio: c.inicio, fim: c.fim } });
    }
  }
  return { erros, plano };
}

/**
 * Resultado da validação sem ativar (somente leitura). Uma única fotografia
 * do banco (REPEATABLE READ): revisão, plano de substituição, impacto e hash
 * saem do MESMO instante — o If-Match devolvido nunca é mais novo que o plano
 * exibido; qualquer mudança posterior na dimensão torna a revisão velha e a
 * ativação responde 409.
 */
export async function validarVersao(pool: Pool, organizationId: string, tabelaId: string, ganchos: { aposPlano?: () => Promise<void> } = {}): Promise<Resultado> {
  if (!RE_UUID.test(tabelaId)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const vis = await carregarLinhaVisivel(client, tabelaId, organizationId);
    if (!vis) throw new ErroTarifa(404, 'tabela_nao_encontrada');
    if (vis.organization_id === null) throw new ErroTarifa(409, 'tabela_publica_somente_leitura');
    const l = vis;
    const revisao = await revisaoDimensao(client, dimensaoDe(l), l.id);
    const faixas = await carregarFaixas(client, l.id);
    const conteudo = conteudoDe(l, faixas);
    const { erros, plano } = await validacaoCompleta(client, l, conteudo);
    if (ganchos.aposPlano) await ganchos.aposPlano();
    const resultado = {
      contrato: 'demurrage.tarifas.validacao.v1',
      tabelaId: l.id, versao: l.versao, estado: l.estado,
      ativavel: l.estado === 'RASCUNHO' && erros.length === 0,
      valida: erros.length === 0,
      erros,
      avisos: l.qualidade_fonte === 'PROVISORIA_INCOMPLETA'
        ? [{ codigo: 'qualidade_provisoria_bloqueia_encerramento', campo: 'qualidadeFonte' }] : [],
      efeitos: { substituicoes: plano.substituicoes, escopo: await impactoOperacao(client, organizationId, l, 'ativacao') },
      revisaoDimensao: revisao,
      conteudoHash: hashConteudo(conteudo),
    };
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Recálculo dos processos ABERTOS afetados (outbox existente)
 * ------------------------------------------------------------------ */

/**
 * Prévia (somente leitura, e relida SOB LOCK na ativação/desativação) do que
 * a operação alcança: processos e contêineres ABERTOS no escopo e, no lado
 * cliente, quantas decisões de responsabilidade com base RELOGIO_CLIENTE o
 * valor novo vai INVALIDAR — toda mudança do valor ativo do cliente invalida
 * essa decisão, mesmo com diária idêntica (regra congelada da 0033), e o
 * processo volta a exigir decisão humana antes do encerramento. Por isso a
 * operação exige `confirmarInvalidacoes` igual a este número.
 *  - ativação, Termo Único: contêineres cujo 1º dia de demurrage cai na
 *    vigência da versão (depois da ativação ela é a única que vale ali);
 *  - ativação, Termo por Embarque: contêineres cuja condição aponta para ela;
 *  - desativação: contêineres cujo valor ativo do cliente é desta versão
 *    (ou, com equipamento não reconhecido, cuja seleção é esta versão).
 * Armador (exposição estimada) nunca invalida decisão de responsabilidade.
 */
async function impactoOperacao(
  client: PoolClient, organizationId: string, l: LinhaVersao, modo: 'ativacao' | 'desativacao',
): Promise<Record<string, number>> {
  const d = dimensaoDe(l);
  const params: unknown[] = [organizationId];
  const filtro = filtroEscopo(d, l.id, params);
  const { rows: esc } = await client.query(
    `SELECT count(DISTINCT p.id)::int AS processos, count(c.id)::int AS conteineres
       FROM processos p JOIN containers c ON c.processo_id = p.id
      WHERE p.organization_id = $1 AND p.apuracao_status = 'OPEN' AND ${filtro}`,
    params,
  );
  let decisoes = 0;
  let finalReferenciando = 0;
  if (d.tipo === 'rocket_cliente') {
    const p2: unknown[] = [organizationId, l.id];
    let alvo: string;
    if (modo === 'desativacao') {
      // Valor ATIVO (OPEN ou FINAL): num processo reaberto o valor que não
      // mudou continua FINAL com o processo já OPEN — e será recalculado.
      // Equipamento não reconhecido: o motor grava `tabela_id` NULL, mas a
      // vigência da versão SELECIONADA entra no hash do valor — a decisão só
      // é invalidada se a vigência da seleção MUDA ao sair desta versão.
      // Embarque (fixado por ID): sem ela a seleção fica vazia, então muda
      // se esta versão tem alguma vigência gravada. Termo Único: contado
      // abaixo, contêiner a contêiner, pela própria regra de seleção.
      const semEquipamentoEmbarque = d.termoComercial === 'embarque'
        ? ` OR (va.tabela_id IS NULL AND ct.codigo IS NULL AND cc.termo_tipo = 'embarque' AND cc.tabela_id = $2 AND $3::boolean)` : '';
      if (d.termoComercial === 'embarque') p2.push(l.vigencia_inicio !== null || l.vigencia_fim !== null);
      alvo = `EXISTS (SELECT 1 FROM valores_apurados va WHERE va.container_id = c.id AND va.relogio_tipo = 'cliente'
                        AND va.calculation_status IN ('OPEN', 'FINAL')
                        AND (va.tabela_id = $2${semEquipamentoEmbarque}))`;
    } else if (d.termoComercial === 'embarque') {
      alvo = `cc.termo_tipo = 'embarque' AND cc.tabela_id = $2`;
    } else {
      p2.push(l.vigencia_inicio, l.vigencia_fim);
      alvo = `cc.termo_tipo = 'unico' AND $2::uuid IS NOT NULL AND r.primeiro_dia_demurrage >= $3::date
              AND ($4::date IS NULL OR r.primeiro_dia_demurrage <= $4::date)`;
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM containers c
         JOIN processos p ON p.id = c.processo_id
         LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
         LEFT JOIN container_types ct ON ct.id = c.container_type_id
         JOIN responsabilidade_decisoes rd ON rd.id = c.responsabilidade_decisao_id AND rd.base_relogio = 'RELOGIO_CLIENTE'
         JOIN relogios r ON r.container_id = c.id AND r.tipo = 'cliente' AND r.estado = 'OK' AND r.dias_demurrage >= 1
        WHERE p.organization_id = $1 AND p.apuracao_status = 'OPEN' AND ${alvo}`,
      p2,
    );
    decisoes = rows[0].n;
    if (modo === 'desativacao' && d.termoComercial === 'unico') {
      decisoes += await decisoesSemEquipamentoQueMudam(client, organizationId, l);
    }
  }
  let afetados = 0;
  if (modo === 'desativacao') {
    // Processos ABERTOS (inclusive reabertos) que a desativação tira da
    // tarifa: valor ativo (de qualquer lado) calculado com ela, ou condição
    // de Termo por Embarque fixada nela (ainda sem valor). Eles serão
    // recalculados e, sem outra versão aplicável, ficarão INDISPONÍVEIS
    // (motivo estável na leitura).
    const { rows: af } = await client.query(
      `SELECT count(*)::int AS n FROM processos p
        WHERE p.organization_id = $1 AND p.apuracao_status = 'OPEN'
          AND (EXISTS (SELECT 1 FROM containers c JOIN valores_apurados va ON va.container_id = c.id
                        WHERE c.processo_id = p.id AND va.calculation_status IN ('OPEN', 'FINAL') AND va.tabela_id = $2)
               OR EXISTS (SELECT 1 FROM condicoes_comerciais cc WHERE cc.id = p.condicao_comercial_id AND cc.tabela_id = $2))`,
      [organizationId, l.id],
    );
    afetados = af[0].n;
    const { rows } = await client.query(
      `SELECT count(DISTINCT c.processo_id)::int AS n
         FROM valores_apurados va JOIN containers c ON c.id = va.container_id JOIN processos p ON p.id = c.processo_id
        WHERE p.organization_id = $1 AND p.apuracao_status = 'FINAL' AND va.tabela_id = $2 AND va.calculation_status = 'FINAL'`,
      [organizationId, l.id],
    );
    finalReferenciando = rows[0].n;
  }
  return {
    processosAbertos: esc[0].processos, conteineresAbertos: esc[0].conteineres,
    decisoesResponsabilidadeInvalidadas: decisoes,
    // FINAL nunca muda; só informativo: uma REABERTURA futura recalcula com a
    // seleção vigente e não encontrará esta versão (motivo estável na leitura).
    ...(modo === 'desativacao' ? { processosAfetados: afetados, processosFinalReferenciando: finalReferenciando } : {}),
  };
}

/**
 * Termo Único, desativação: decisões RELOGIO_CLIENTE de contêineres com
 * equipamento não reconhecido (`ct.codigo IS NULL`, a definição do motor;
 * valor ativo sem tabela) que a saída desta versão invalida. Pela MESMA regra
 * de seleção do motor (nenhuma cópia dela), uma vez por data: conta quando
 * esta versão é a selecionada hoje e a vigência da seleção sem ela (outra
 * versão, ou nenhuma) é diferente — só a vigência da seleção entra no hash de
 * um valor sem equipamento. Supõe o valor em dia com a seleção atual: se a
 * desativação vier antes de o recálculo da própria ativação ser consumido, o
 * número pode ser maior que o real (nunca menor).
 */
async function decisoesSemEquipamentoQueMudam(client: PoolClient, organizationId: string, l: LinhaVersao): Promise<number> {
  const ef = vigenciaEfetivaDe(l);
  if (!ef) return 0;
  const { rows } = await client.query(
    `SELECT r.primeiro_dia_demurrage AS data, count(*)::int AS n
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id AND cc.termo_tipo = 'unico'
       LEFT JOIN container_types ct ON ct.id = c.container_type_id
       JOIN responsabilidade_decisoes rd ON rd.id = c.responsabilidade_decisao_id AND rd.base_relogio = 'RELOGIO_CLIENTE'
       JOIN relogios r ON r.container_id = c.id AND r.tipo = 'cliente' AND r.estado = 'OK' AND r.dias_demurrage >= 1
      WHERE p.organization_id = $1 AND p.apuracao_status = 'OPEN' AND ct.codigo IS NULL
        AND r.primeiro_dia_demurrage >= $2::date AND ($3::date IS NULL OR r.primeiro_dia_demurrage <= $3::date)
        AND EXISTS (SELECT 1 FROM valores_apurados va WHERE va.container_id = c.id AND va.relogio_tipo = 'cliente'
                      AND va.motor_comercial = 'termo_unico' AND va.calculation_status IN ('OPEN', 'FINAL') AND va.tabela_id IS NULL)
        -- já contado pela consulta principal (valor calculado com a versão)
        AND NOT EXISTS (SELECT 1 FROM valores_apurados va WHERE va.container_id = c.id AND va.relogio_tipo = 'cliente'
                          AND va.calculation_status IN ('OPEN', 'FINAL') AND va.tabela_id = $4)
      GROUP BY r.primeiro_dia_demurrage`,
    [organizationId, ef.inicio, ef.fim, l.id],
  );
  const tariffs = new TariffTableRepository(client as unknown as Pool);
  const sel = { tipo: 'rocket_cliente' as const, organizationId, termoComercial: 'unico' as const };
  let total = 0;
  for (const { data, n } of rows) {
    const agora = await tariffs.candidataVigente({ ...sel, referenceDate: data });
    if (agora?.id !== l.id) continue;
    const sem = await tariffs.candidataVigente({ ...sel, referenceDate: data, excluirTabelaId: l.id });
    if ((sem?.vigencia_inicio ?? null) !== agora.vigencia_inicio || (sem?.vigencia_fim ?? null) !== agora.vigencia_fim) total += n;
  }
  return total;
}

/** Impacto de desativação (prévia para quem vai desativar uma versão publicada). */
export async function previaDesativacao(client: PoolClient, organizationId: string, l: LinhaVersao): Promise<Record<string, number> | null> {
  if (l.estado === 'RASCUNHO' || l.estado === 'DESATIVADA' || l.organization_id === null) return null;
  return impactoOperacao(client, organizationId, l, 'desativacao');
}

function confirmacaoExigida(corpo: Record<string, unknown>): number | null {
  const v = corpo.confirmarInvalidacoes;
  if (v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ErroTarifa(400, 'campo_invalido', { campo: 'confirmarInvalidacoes' });
  return v;
}

/**
 * If-Match do impacto: o número confirmado no corpo precisa ser o número
 * relido AGORA, sob o lock. Decisões só no lado cliente (o armador nunca
 * invalida responsabilidade); processos afetados só na desativação.
 */
function conferirImpacto(
  impacto: Record<string, number>, lado: 'rocket_cliente' | 'armador',
  confirmado: { invalidacoes: number | null; processos?: number | null },
): void {
  const decisoesDivergem = lado === 'rocket_cliente' && confirmado.invalidacoes !== impacto.decisoesResponsabilidadeInvalidadas;
  const processosDivergem = impacto.processosAfetados !== undefined && confirmado.processos !== impacto.processosAfetados;
  if (decisoesDivergem || processosDivergem) {
    throw new ErroTarifa(409, 'impacto_alterado', {
      decisoesResponsabilidadeInvalidadas: impacto.decisoesResponsabilidadeInvalidadas,
      ...(impacto.processosAfetados !== undefined ? { processosAfetados: impacto.processosAfetados } : {}),
    });
  }
}

function confirmacaoProcessos(corpo: Record<string, unknown>): number | null {
  const v = corpo.confirmarProcessosAfetados;
  if (v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ErroTarifa(400, 'campo_invalido', { campo: 'confirmarProcessosAfetados' });
  return v;
}

/* ------------------------------------------------------------------ *
 * Operações
 * ------------------------------------------------------------------ */

function corpoObjeto(corpo: unknown): Record<string, unknown> {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new ErroTarifa(400, 'corpo_invalido');
  return corpo as Record<string, unknown>;
}

function respostaEdicao(l: LinhaVersao, conteudo: ConteudoVersao, erros: ErroValidacao[], operacao: string): Resultado {
  return {
    contrato: 'demurrage.tarifas.operacao.v1', operacao, tabelaId: l.id, versao: l.versao, estado: 'RASCUNHO',
    conteudoHash: hashConteudo(conteudo),
    validacao: { valida: erros.length === 0, erros },
  };
}

function resumoConteudo(c: ConteudoVersao): Record<string, unknown> {
  return {
    vigenciaInicio: c.vigenciaInicio, vigenciaFim: c.vigenciaFim, qualidadeFonte: c.qualidadeFonte, dayCountBasis: c.dayCountBasis,
    fonte: c.fonte, verificadaEm: c.verificadaEm, faixas: faixasOrdenadas(c.faixas),
  };
}

async function inserirFaixas(client: PoolClient, tabelaId: string, faixas: readonly FaixaAdmin[]): Promise<void> {
  for (const f of faixas) {
    await client.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,$2,$3,$4,$5::numeric,$6)`,
      [tabelaId, f.equipamento, f.diaInicial, f.diaFinal, f.valorDia, f.moeda],
    );
  }
}

async function proximaVersao(client: PoolClient, d: DimensaoTabela): Promise<number> {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(versao), 0) + 1 AS proxima FROM tariff_tables
      WHERE tipo = $1 AND organization_id IS NOT DISTINCT FROM $2
        AND armador_id IS NOT DISTINCT FROM $3 AND termo_comercial IS NOT DISTINCT FROM $4`,
    [d.tipo, d.organizationId, d.armadorId, d.termoComercial],
  );
  return Number(rows[0].proxima);
}

async function inserirVersao(client: PoolClient, d: DimensaoTabela, versao: number, m: MetadadosVersao): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO tariff_tables
       (organization_id, tipo, armador_id, termo_comercial, versao, vigencia_inicio, vigencia_fim,
        qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [d.organizationId, d.tipo, d.armadorId, d.termoComercial, versao, m.vigenciaInicio, m.vigenciaFim,
      m.qualidadeFonte, m.dayCountBasis, m.fonte, m.verificadaEm],
  );
  return rows[0].id;
}

/** 3 — Criar rascunho (dimensão + metadados + faixas opcionais). */
export async function criarRascunho(pool: Pool, ator: AtorTarifa, chave: string, corpoBruto: unknown, ganchos: GanchosTeste = {}): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const erros: ErroValidacao[] = [];
  const lado = corpo.lado;
  if (lado !== 'cliente' && lado !== 'armador') erros.push({ codigo: 'campo_invalido', campo: 'lado' });
  let termo: TermoComercial | null = null;
  let armadorId: string | null = null;
  if (lado === 'cliente') {
    if (corpo.termoComercial === 'unico' || corpo.termoComercial === 'embarque') termo = corpo.termoComercial;
    else erros.push({ codigo: corpo.termoComercial === undefined || corpo.termoComercial === null ? 'dimensao_obrigatoria_ausente' : 'campo_invalido', campo: 'termoComercial' });
    if (corpo.armadorId !== undefined && corpo.armadorId !== null) erros.push({ codigo: 'campo_invalido', campo: 'armadorId' });
  } else if (lado === 'armador') {
    if (typeof corpo.armadorId === 'string' && RE_UUID.test(corpo.armadorId)) armadorId = corpo.armadorId.toLowerCase();
    else erros.push({ codigo: corpo.armadorId === undefined || corpo.armadorId === null ? 'dimensao_obrigatoria_ausente' : 'campo_invalido', campo: 'armadorId' });
    if (corpo.termoComercial !== undefined && corpo.termoComercial !== null) erros.push({ codigo: 'campo_invalido', campo: 'termoComercial' });
  }
  const { metadados, erros: errosMeta } = lerMetadadosDoCorpo(corpo, false, ['lado', 'termoComercial', 'armadorId', 'faixas', 'motivo']);
  erros.push(...errosMeta);
  const lidas = corpo.faixas === undefined ? { faixas: [], erros: [] } : lerFaixasDoCorpo(corpo.faixas);
  erros.push(...lidas.erros, ...sobreposicoes(lidas.faixas));
  const m = metadados as MetadadosVersao;
  if (!errosMeta.length && m.vigenciaInicio && m.vigenciaFim && m.vigenciaFim < m.vigenciaInicio) {
    erros.push({ codigo: 'vigencia_incoerente', campo: 'vigenciaFim' });
  }
  const motivo = motivoOpcional(corpo);
  if (erros.length) throw erroValidacao(erros);

  const dimensao: DimensaoTabela = { organizationId: ator.organizationId, tipo: tipoDoLado(lado as 'cliente' | 'armador'), armadorId, termoComercial: termo };
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'CRIAR_RASCUNHO', dimensao, m, faixasOrdenadas(lidas.faixas), motivo]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    if (armadorId && !(await armadorExiste(client, armadorId))) throw erroValidacao([{ codigo: 'armador_inexistente', campo: 'armadorId' }]);
    await lockConsultivo(client, chaveLockDimensao(dimensao));
    const versao = await proximaVersao(client, dimensao);
    if (ganchos.aposLocks) await ganchos.aposLocks();
    const id = await inserirVersao(client, dimensao, versao, m);
    await inserirFaixas(client, id, lidas.faixas);
    const l = (await carregarLinha(client, id))!;
    const conteudo = conteudoDe(l, await carregarFaixas(client, id));
    const { erros: pendentes } = await validacaoCompleta(client, l, conteudo);
    const resultado = respostaEdicao(l, conteudo, pendentes, 'CRIAR_RASCUNHO');
    await gravarEvento(client, ator, autor, chave, hash, {
      linha: l, operacao: 'CRIAR_RASCUNHO', motivo, anteriores: null, novos: resumoConteudo(conteudo),
      conteudoHash: hashConteudo(conteudo), resultado,
    });
    return resultado;
  });
}

/** 4 — Atualizar metadados de um rascunho (PATCH: só os campos enviados). */
export async function atualizarMetadados(pool: Pool, ator: AtorTarifa, chave: string, tabelaId: string, corpoBruto: unknown): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const { metadados, erros } = lerMetadadosDoCorpo(corpo, true, ['motivo']);
  const motivo = motivoOpcional(corpo);
  if (erros.length) throw erroValidacao(erros);
  if (!Object.keys(metadados).length) throw new ErroTarifa(400, 'nada_a_alterar');
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'ATUALIZAR_METADADOS', tabelaId, metadados, motivo]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    const l = await travarVersaoDaOrganizacao(client, ator, tabelaId);
    if (l.estado !== 'RASCUNHO') throw new ErroTarifa(409, 'versao_imutavel', { estado: l.estado });
    const faixas = await carregarFaixas(client, l.id);
    const antes = conteudoDe(l, faixas);
    const depois: ConteudoVersao = { ...antes, ...metadados };
    if (depois.vigenciaInicio && depois.vigenciaFim && depois.vigenciaFim < depois.vigenciaInicio) {
      throw erroValidacao([{ codigo: 'vigencia_incoerente', campo: 'vigenciaFim', detalhe: { vigenciaInicio: depois.vigenciaInicio, vigenciaFim: depois.vigenciaFim } }]);
    }
    await client.query(
      `UPDATE tariff_tables SET vigencia_inicio = $2, vigencia_fim = $3, qualidade_fonte = $4, day_count_basis = $5, fonte = $6, verificada_em = $7
        WHERE id = $1`,
      [l.id, depois.vigenciaInicio, depois.vigenciaFim, depois.qualidadeFonte, depois.dayCountBasis, depois.fonte, depois.verificadaEm],
    );
    const anteriores: Record<string, unknown> = {};
    const novos: Record<string, unknown> = {};
    for (const k of Object.keys(metadados) as Array<keyof MetadadosVersao>) {
      anteriores[k] = antes[k];
      novos[k] = depois[k];
    }
    const l2 = (await carregarLinha(client, l.id))!;
    const conteudo = conteudoDe(l2, faixas);
    const { erros: pendentes } = await validacaoCompleta(client, l2, conteudo);
    const resultado = respostaEdicao(l2, conteudo, pendentes, 'ATUALIZAR_METADADOS');
    await gravarEvento(client, ator, autor, chave, hash, {
      linha: l2, operacao: 'ATUALIZAR_METADADOS', motivo, anteriores, novos, conteudoHash: hashConteudo(conteudo), resultado,
    });
    return resultado;
  });
}

/** 5 — Definir ou substituir TODAS as faixas de um rascunho. */
export async function substituirFaixas(pool: Pool, ator: AtorTarifa, chave: string, tabelaId: string, corpoBruto: unknown): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const desconhecidos = Object.keys(corpo).filter((k) => k !== 'faixas' && k !== 'motivo');
  const lidas = lerFaixasDoCorpo(corpo.faixas);
  const erros: ErroValidacao[] = [...desconhecidos.map((k) => ({ codigo: 'campo_invalido' as const, campo: k })), ...lidas.erros, ...sobreposicoes(lidas.faixas)];
  const motivo = motivoOpcional(corpo);
  if (erros.length) throw erroValidacao(erros);
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'SUBSTITUIR_FAIXAS', tabelaId, faixasOrdenadas(lidas.faixas), motivo]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    const l = await travarVersaoDaOrganizacao(client, ator, tabelaId);
    if (l.estado !== 'RASCUNHO') throw new ErroTarifa(409, 'versao_imutavel', { estado: l.estado });
    const antes = await carregarFaixas(client, l.id);
    await client.query(`DELETE FROM tariff_brackets WHERE tariff_table_id = $1`, [l.id]);
    await inserirFaixas(client, l.id, lidas.faixas);
    const faixas = await carregarFaixas(client, l.id);
    const conteudo = conteudoDe(l, faixas);
    const { erros: pendentes } = await validacaoCompleta(client, l, conteudo);
    const resultado = respostaEdicao(l, conteudo, pendentes, 'SUBSTITUIR_FAIXAS');
    await gravarEvento(client, ator, autor, chave, hash, {
      linha: l, operacao: 'SUBSTITUIR_FAIXAS', motivo, anteriores: { faixas: antes }, novos: { faixas },
      conteudoHash: hashConteudo(conteudo), resultado,
    });
    return resultado;
  });
}

/**
 * 8 — Ativar. Exige no corpo o que o ativador VIU (`revisaoDimensao` e
 * `conteudoHash`, de `GET …/validacao`): se outra ativação/desativação
 * mudou a dimensão ou alguém editou o rascunho nesse meio-tempo, 409 — nunca
 * publica o que ninguém validou. Duas ativações concorrentes na mesma
 * dimensão: exatamente uma vence (a outra encontra a revisão já mudada).
 */
export async function ativar(pool: Pool, ator: AtorTarifa, chave: string, tabelaId: string, corpoBruto: unknown, ganchos: GanchosTeste = {}): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const desconhecidos = Object.keys(corpo).filter((k) => !['revisaoDimensao', 'conteudoHash', 'motivo', 'confirmarInvalidacoes', 'aceitarQualidadeProvisoria'].includes(k));
  if (desconhecidos.length) throw new ErroTarifa(400, 'campo_invalido', { campo: desconhecidos[0] });
  const confirmado = confirmacaoExigida(corpo);
  if (corpo.aceitarQualidadeProvisoria !== undefined && typeof corpo.aceitarQualidadeProvisoria !== 'boolean') {
    throw new ErroTarifa(400, 'campo_invalido', { campo: 'aceitarQualidadeProvisoria' });
  }
  const aceitaProvisoria = corpo.aceitarQualidadeProvisoria === true;
  const revisao = corpo.revisaoDimensao;
  if (typeof revisao !== 'number' || !Number.isInteger(revisao) || revisao < 0) throw new ErroTarifa(400, 'campo_invalido', { campo: 'revisaoDimensao' });
  const conteudoHashEsperado = corpo.conteudoHash;
  if (typeof conteudoHashEsperado !== 'string' || !RE_HASH.test(conteudoHashEsperado)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'conteudoHash' });
  const motivo = motivoObrigatorio(corpo);
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'ATIVAR', tabelaId, revisao, conteudoHashEsperado, motivo, confirmado, aceitaProvisoria]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    const l = await travarVersaoDaOrganizacao(client, ator, tabelaId);
    if (l.estado !== 'RASCUNHO') throw new ErroTarifa(409, 'transicao_invalida', { estado: l.estado });
    const dimensao = dimensaoDe(l);
    const revisaoAtual = await revisaoDimensao(client, dimensao, l.id);
    if (revisaoAtual !== revisao) throw new ErroTarifa(409, 'revisao_dimensao_desatualizada', { revisaoDimensao: revisaoAtual });
    const faixas = await carregarFaixas(client, l.id);
    const conteudo = conteudoDe(l, faixas);
    const conteudoHash = hashConteudo(conteudo);
    if (conteudoHash !== conteudoHashEsperado) throw new ErroTarifa(409, 'conteudo_alterado', { conteudoHash });
    const { erros, plano } = await validacaoCompleta(client, l, conteudo);
    // Qualidade provisória: o motor produz ESTIMADO_PROVISORIO, que bloqueia o
    // encerramento até haver versão definitiva — só com aceite explícito.
    if (l.qualidade_fonte === 'PROVISORIA_INCOMPLETA' && !aceitaProvisoria) {
      erros.push({ codigo: 'qualidade_provisoria_bloqueia_encerramento', campo: 'qualidadeFonte' });
    }
    if (erros.length) throw erroValidacao(erros);
    const impacto = await impactoOperacao(client, ator.organizationId, l, 'ativacao');
    conferirImpacto(impacto, l.tipo, { invalidacoes: confirmado });
    if (ganchos.aposLocks) await ganchos.aposLocks();

    const eventoId = randomUUID();
    const { rows: at } = await client.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1 AND ativada_em IS NULL RETURNING ativada_em`, [l.id]);
    if (!at.length) throw new ErroTarifa(409, 'transicao_invalida', { estado: 'ATIVA' });
    const resultado: Resultado = {
      contrato: 'demurrage.tarifas.operacao.v1', operacao: 'ATIVAR', tabelaId: l.id, versao: l.versao, estado: 'ATIVA',
      ativadaEm: new Date(at[0].ativada_em).toISOString(), conteudoHash,
      substituicoes: plano.substituicoes, impacto,
      // Itens por contêiner são criados DEPOIS do COMMIT (ver recalculo.ts);
      // progresso em GET /eventos/:eventoId/recalculo.
      recalculo: { eventoId },
    };
    await gravarEvento(client, ator, autor, chave, hash, {
      id: eventoId, linha: l, operacao: 'ATIVAR', motivo,
      anteriores: { estado: 'RASCUNHO', revisaoDimensao: revisaoAtual },
      novos: { estado: 'ATIVA', vigencia: { inicio: conteudo.vigenciaInicio, fim: conteudo.vigenciaFim }, substituicoes: plano.substituicoes, impacto },
      conteudoHash, resultado,
    });
    await registrarExpansao(client, ator.organizationId, eventoId, l.id);
    await client.query(
      `INSERT INTO tariff_versao_transicoes (tariff_table_id, organization_id, tipo, evento_id) VALUES ($1, $2, 'ATIVACAO', $3)`,
      [l.id, ator.organizationId, eventoId],
    );
    for (const s of plano.substituicoes) {
      await client.query(
        `INSERT INTO tariff_versao_transicoes (tariff_table_id, organization_id, tipo, vigencia_efetiva_fim, substituida_por_id, evento_id)
         VALUES ($1, $2, 'SUBSTITUICAO', $3, $4, $5)`,
        [s.tabelaId, ator.organizationId, s.vigenciaEfetivaFim, l.id, eventoId],
      );
    }
    return resultado;
  });
}

/** 9 — Nova versão (rascunho) a partir de uma existente: copia metadados e faixas; dimensão da organização do ator. */
export async function novaVersaoDe(pool: Pool, ator: AtorTarifa, chave: string, baseId: string, corpoBruto: unknown): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const desconhecidos = Object.keys(corpo).filter((k) => k !== 'motivo');
  if (desconhecidos.length) throw new ErroTarifa(400, 'campo_invalido', { campo: desconhecidos[0] });
  const motivo = motivoObrigatorio(corpo);
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'CRIAR_VERSAO_DE', baseId, motivo]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    if (!RE_UUID.test(baseId)) throw new ErroTarifa(404, 'tabela_nao_encontrada');
    const base = await carregarLinhaVisivel(client, baseId, ator.organizationId);
    if (!base) throw new ErroTarifa(404, 'tabela_nao_encontrada');
    const dimensao: DimensaoTabela = { ...dimensaoDe(base), organizationId: ator.organizationId };
    await lockConsultivo(client, chaveLockDimensao(dimensao));
    const versao = await proximaVersao(client, dimensao);
    const faixasBase = await carregarFaixas(client, base.id);
    const metadados: MetadadosVersao = {
      vigenciaInicio: base.vigencia_inicio, vigenciaFim: base.vigencia_fim, qualidadeFonte: base.qualidade_fonte,
      dayCountBasis: base.day_count_basis, fonte: base.fonte, verificadaEm: new Date(base.verificada_em).toISOString(),
    };
    const id = await inserirVersao(client, dimensao, versao, metadados);
    await inserirFaixas(client, id, faixasBase);
    const l = (await carregarLinha(client, id))!;
    const conteudo = conteudoDe(l, await carregarFaixas(client, id));
    const { erros: pendentes } = await validacaoCompleta(client, l, conteudo);
    // Termo por Embarque: cada condição fixa a versão por ID — a versão nova
    // NÃO é adotada pelos processos fixados na base (repontar = novo
    // registro/handoff com o novo tabelaId). Dito explicitamente na resposta.
    let fixadosNaBase: number | null = null;
    if (dimensaoEhEmbarque(dimensao)) {
      const { rows: fx } = await client.query(
        `SELECT count(DISTINCT p.id)::int AS n FROM processos p JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
          WHERE p.organization_id = $1 AND p.apuracao_status = 'OPEN' AND cc.tabela_id = $2`,
        [ator.organizationId, base.id],
      );
      fixadosNaBase = fx[0].n;
    }
    const resultado = {
      ...respostaEdicao(l, conteudo, pendentes, 'CRIAR_VERSAO_DE'), baseId: base.id,
      ...(fixadosNaBase === null ? {} : { termoEmbarque: { processosAbertosFixadosNaBase: fixadosNaBase, adotadaPorEles: false } }),
    };
    await gravarEvento(client, ator, autor, chave, hash, {
      linha: l, operacao: 'CRIAR_VERSAO_DE', motivo,
      anteriores: { baseId: base.id, baseVersao: base.versao, baseEscopo: base.organization_id === null ? 'PUBLICA' : 'ORGANIZACAO', baseEstado: base.estado },
      novos: resumoConteudo(conteudo), conteudoHash: hashConteudo(conteudo), resultado,
    });
    return resultado;
  });
}

/**
 * 10 — Desativar. Rascunho → abandonado (terminal, nunca apagado). Ativa ou
 * substituída (ainda aplicável a alguma data) → deixa de ser selecionada; os
 * processos abertos afetados são recalculados. Nunca restaura a antecessora
 * que esta versão substituiu (restaurar = nova versão + ativação, auditadas).
 */
export async function desativar(pool: Pool, ator: AtorTarifa, chave: string, tabelaId: string, corpoBruto: unknown): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const desconhecidos = Object.keys(corpo).filter((k) => !['motivo', 'aceitarVersoesExpostas', 'estadoEsperado', 'revisaoDimensao', 'confirmarInvalidacoes', 'confirmarProcessosAfetados'].includes(k));
  if (desconhecidos.length) throw new ErroTarifa(400, 'campo_invalido', { campo: desconhecidos[0] });
  const motivo = motivoObrigatorio(corpo);
  // If-Match: desativa o que o operador VIU — nunca uma versão que outra
  // pessoa acabou de ativar quando a intenção era abandonar o rascunho.
  const estadoEsperado = corpo.estadoEsperado;
  if (estadoEsperado !== 'RASCUNHO' && estadoEsperado !== 'ATIVA' && estadoEsperado !== 'SUBSTITUIDA') {
    throw new ErroTarifa(400, 'campo_invalido', { campo: 'estadoEsperado' });
  }
  const revisao = corpo.revisaoDimensao;
  if (typeof revisao !== 'number' || !Number.isInteger(revisao) || revisao < 0) throw new ErroTarifa(400, 'campo_invalido', { campo: 'revisaoDimensao' });
  const aceitasBruto = corpo.aceitarVersoesExpostas ?? [];
  if (!Array.isArray(aceitasBruto) || aceitasBruto.length > 100 || !aceitasBruto.every((x) => typeof x === 'string' && RE_UUID.test(x))) {
    throw new ErroTarifa(400, 'campo_invalido', { campo: 'aceitarVersoesExpostas' });
  }
  const aceitas = [...new Set((aceitasBruto as string[]).map((x) => x.toLowerCase()))].sort();
  const confirmado = confirmacaoExigida(corpo);
  const confirmadoProcessos = confirmacaoProcessos(corpo);
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'DESATIVAR', tabelaId, motivo, aceitas, estadoEsperado, revisao, confirmado, confirmadoProcessos]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    const l = await travarVersaoDaOrganizacao(client, ator, tabelaId);
    if (l.estado === 'DESATIVADA') throw new ErroTarifa(409, 'transicao_invalida', { estado: l.estado });
    const dimensao = dimensaoDe(l);
    if (l.estado !== estadoEsperado) throw new ErroTarifa(409, 'estado_alterado', { estado: l.estado });
    const revisaoAtual = await revisaoDimensao(client, dimensao, l.id);
    if (revisaoAtual !== revisao) throw new ErroTarifa(409, 'revisao_dimensao_desatualizada', { revisaoDimensao: revisaoAtual });
    const embarque = dimensaoEhEmbarque(dimensao);
    if (!embarque && l.estado === 'SUBSTITUIDA' && vigenciaEfetivaDe(l) === null) {
      throw new ErroTarifa(409, 'transicao_invalida', { estado: l.estado, regra: 'versao_integralmente_substituida' });
    }
    // Nunca deixar uma versão antiga voltar a valer em silêncio: a lista das
    // que a desativação exporia precisa vir aceita, exatamente, no corpo.
    const expostas = embarque || l.estado === 'RASCUNHO'
      ? []
      : versoesExpostasPorDesativacao(versaoExistenteDe(l), await versoesParaPlano(client, dimensao, l.id));
    const idsExpostos = expostas.map((e) => e.tabelaId).sort();
    if (JSON.stringify(idsExpostos) !== JSON.stringify(aceitas)) {
      throw new ErroTarifa(409, 'desativacao_exporia_versao_anterior', { versoesExpostas: expostas });
    }
    const conteudo = conteudoDe(l, await carregarFaixas(client, l.id));
    const eventoId = randomUUID();
    const publicada = l.estado !== 'RASCUNHO';
    const impacto = publicada ? await impactoOperacao(client, ator.organizationId, l, 'desativacao') : null;
    if (impacto) conferirImpacto(impacto, l.tipo, { invalidacoes: confirmado, processos: confirmadoProcessos });
    const resultado: Resultado = {
      contrato: 'demurrage.tarifas.operacao.v1', operacao: 'DESATIVAR', tabelaId: l.id, versao: l.versao,
      estadoAnterior: l.estado, estado: 'DESATIVADA', versoesExpostas: expostas, impacto,
      // Rascunho abandonado nunca foi aplicável: nada a recalcular.
      recalculo: publicada ? { eventoId } : null,
    };
    await gravarEvento(client, ator, autor, chave, hash, {
      id: eventoId, linha: l, operacao: 'DESATIVAR', motivo,
      anteriores: { estado: l.estado, vigenciaEfetiva: vigenciaEfetivaDe(l) }, novos: { estado: 'DESATIVADA', versoesExpostasAceitas: expostas, impacto },
      conteudoHash: hashConteudo(conteudo), resultado,
    });
    if (publicada) await registrarExpansao(client, ator.organizationId, eventoId, l.id);
    await client.query(
      `INSERT INTO tariff_versao_transicoes (tariff_table_id, organization_id, tipo, evento_id) VALUES ($1, $2, 'DESATIVACAO', $3)`,
      [l.id, ator.organizationId, eventoId],
    );
    return resultado;
  });
}

/**
 * 11 — Reprocessar o recálculo de um evento: REARMA as mesmas linhas do
 * outbox (chave = id do evento de origem) que esgotaram as tentativas
 * automáticas — volta a PENDING, tentativas zeradas, sem dono — para o worker
 * tentar de novo. Nada de linha nova: a falha técnica sai da fila e da linha
 * do tempo assim que o item conclui (nunca fica um FAILED "fantasma" ao lado
 * de um DONE). Nunca desfaz nem repete a ativação; o recálculo é idempotente
 * por hash. Recusado (409) enquanto a expansão ou algum item com retentativa
 * automática do evento ainda estiver em andamento, e quando não há nada
 * esgotado. Os contêineres rearmados ficam no evento de auditoria.
 */
export async function reprocessarRecalculo(pool: Pool, ator: AtorTarifa, chave: string, eventoOrigemId: string, corpoBruto: unknown): Promise<Resultado> {
  const corpo = corpoObjeto(corpoBruto);
  const desconhecidos = Object.keys(corpo).filter((k) => k !== 'motivo');
  if (desconhecidos.length) throw new ErroTarifa(400, 'campo_invalido', { campo: desconhecidos[0] });
  const motivo = motivoObrigatorio(corpo);
  const hash = hashPedido([VERSAO_HASH_PEDIDO, ator.membershipId, 'REPROCESSAR_RECALCULO', eventoOrigemId, motivo]);
  return comTransacao(pool, ator, chave, hash, async (client, autor) => {
    if (!RE_UUID.test(eventoOrigemId)) throw new ErroTarifa(404, 'evento_nao_encontrado');
    const { rows: ev } = await client.query(
      `SELECT e.* FROM tariff_admin_eventos e WHERE e.id = $1 AND e.organization_id = $2`,
      [eventoOrigemId, ator.organizationId],
    );
    if (!ev.length) throw new ErroTarifa(404, 'evento_nao_encontrado');
    const origem = ev[0];
    const l = await travarVersaoDaOrganizacao(client, ator, origem.tariff_table_id);
    const { rows: exp } = await client.query(`SELECT concluida_em FROM tariff_recalculo_expansoes WHERE evento_id = $1 FOR UPDATE`, [eventoOrigemId]);
    if (!exp.length) throw new ErroTarifa(409, 'evento_sem_recalculo');
    const { rows: andamento } = await client.query(
      `SELECT count(*)::int AS n FROM recalculo_outbox
        WHERE tipo = 'tarifa' AND chave = $1::text AND organization_id = $2
          AND (estado IN ('PENDING', 'PROCESSING') OR (estado = 'FAILED' AND tentativas < $3))`,
      [eventoOrigemId, ator.organizationId, MAX_TENTATIVAS_RECALCULO],
    );
    if (exp[0].concluida_em === null || andamento[0].n > 0) {
      throw new ErroTarifa(409, 'recalculo_em_andamento', { expansaoConcluida: exp[0].concluida_em !== null, itensEmAndamento: andamento[0].n });
    }
    const { rows: rearmados } = await client.query(
      `UPDATE recalculo_outbox
          SET estado = 'PENDING', tentativas = 0, erro = NULL, worker_id = NULL, expira_em = NULL, desfecho = NULL, atualizado_em = now()
        WHERE tipo = 'tarifa' AND chave = $1::text AND organization_id = $2 AND estado = 'FAILED' AND tentativas >= $3
        RETURNING container_id`,
      [eventoOrigemId, ator.organizationId, MAX_TENTATIVAS_RECALCULO],
    );
    if (!rearmados.length) throw new ErroTarifa(409, 'nada_a_reprocessar');
    const conteineres = rearmados.map((r) => r.container_id as string).sort();
    const resultado: Resultado = {
      contrato: 'demurrage.tarifas.operacao.v1', operacao: 'REPROCESSAR_RECALCULO', tabelaId: l.id, versao: l.versao,
      eventoOrigemId, recalculo: { eventoId: eventoOrigemId, itensRearmados: conteineres.length },
    };
    await gravarEvento(client, ator, autor, chave, hash, {
      linha: l, operacao: 'REPROCESSAR_RECALCULO', motivo,
      anteriores: { eventoOrigemId, itensEsgotados: conteineres.length }, novos: { itensRearmados: conteineres },
      conteudoHash: origem.conteudo_hash, resultado, origemId: eventoOrigemId,
    });
    return resultado;
  });
}
