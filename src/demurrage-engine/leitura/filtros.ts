import { Pool } from 'pg';
import { ESTADOS_OPERACIONAIS, EstadoOperacional, ORDEM_BALDE, PrioridadeBalde } from '../lifecycle/types';
import { CivilDate } from '../temporal/civilDate';
import {
  CampoPeriodo, ComMetaEscopo, CONTRATO_LEITURA_V1, ErroLeitura, FiltroFila, FiltrosDisponiveisV1, SituacaoApuracaoFiltro, filtroFilaVazio,
} from './contrato';
import { contarEstadosEBaldes } from './filaOperacional';
import { AutorizacaoInterna } from './autorizacao';
import { EscopoAplicado, ehGestorDaSessao, escopoEquipeOrganizacao, filtrosDoEscopo, sufixoEscopo } from './escopoFila';

/**
 * Fase D12 (Gate G5, v1.2 item 5) — normalização dos filtros da query string
 * (seção 6) e o agregado de `GET /filtros`. A tradução filtro→SQL fica só em
 * `filaOperacional.ts` (nenhuma regra duplicada); este módulo só garante que
 * a entrada é válida ANTES de chegar lá, com erro explícito (`400
 * valor_invalido`) em vez de ignorar silenciosamente um parâmetro estranho.
 *
 * DV-04 (v1.2): as contagens por estado/balde usavam `GROUP BY` sobre as
 * colunas persistidas (`estado_mais_relevante`/`prioridade_balde`), que podem
 * estar atrasadas em relação ao `hoje` operacional — exatamente a
 * inconsistência que a fila já tinha corrigido na v1.1. Agora vêm de
 * `contarEstadosEBaldes` (mesma derivação atual, mesmas funções congeladas),
 * para que fila, detalhe e `/filtros` concordem sempre sobre o mesmo
 * instante. Nenhuma soma financeira aqui (DV-01 fica só na fila/detalhe).
 *
 * Produção P1 (reabertura controlada): `apuracaoStatus` (`OPEN` padrão,
 * `FINAL`, `TODOS`) seleciona explicitamente a situação da apuração na fila
 * e em `/filtros` — opções e contagens da visão ativa nunca incluem processo
 * FINAL; `apuracao.{abertos,finalizados}` dá os dois totais separados.
 *
 * Produção P1 (filas pessoais): as QUATRO leituras de dados de `/filtros`
 * (clientes, armadores, contagens por estado/balde e `apuracao`) aplicam o
 * MESMO predicado SQL de escopo da fila — um ANALYST nunca vê clientes,
 * armadores ou contagens da equipe. `responsaveis` é por PAPEL, não por
 * escopo: MANAGER/ADMIN recebem todo membership interno ATIVO da organização
 * (inclusive quem ainda não tem processo — é a lista de quem pode ser
 * atribuído); ANALYST recebe só a si mesmo. Desativado nunca aparece.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const BALDES: PrioridadeBalde[] = Object.keys(ORDEM_BALDE) as PrioridadeBalde[];
const CAMPOS_PERIODO: CampoPeriodo[] = ['descarga', 'devolucao'];
const SITUACOES_APURACAO: SituacaoApuracaoFiltro[] = ['OPEN', 'FINAL', 'TODOS'];

function erroValor(campo: string): never {
  throw new ErroLeitura(400, 'valor_invalido', { campo });
}

function uuidOuErro(valor: string, campo: string): string {
  if (!RE_UUID.test(valor)) erroValor(campo);
  return valor;
}

function boolOuErro(valor: string, campo: string): boolean {
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  erroValor(campo);
}

function primeiraString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

/** `apuracaoStatus` da query string: `OPEN` (padrão), `FINAL` ou `TODOS`; qualquer outro valor é `400 valor_invalido`. */
export function normalizarSituacaoApuracao(query: Record<string, unknown>): SituacaoApuracaoFiltro {
  const v = primeiraString(query.apuracaoStatus);
  if (v === undefined) return 'OPEN';
  if (!SITUACOES_APURACAO.includes(v as SituacaoApuracaoFiltro)) erroValor('apuracaoStatus');
  return v as SituacaoApuracaoFiltro;
}

/**
 * Traduz a query string (já sem `organizationId` — G6 garante isso antes) em
 * um `FiltroFila` validado. Valor desconhecido em qualquer campo de lista
 * fechada (estado, balde, periodoCampo) é `400 valor_invalido`, não ignorado.
 */
export function normalizarFiltrosFila(query: Record<string, unknown>): FiltroFila {
  const f: FiltroFila = filtroFilaVazio();

  const responsavel = primeiraString(query.responsavel);
  if (responsavel) f.responsavelMembershipId = uuidOuErro(responsavel, 'responsavel');

  const cliente = primeiraString(query.cliente);
  if (cliente) f.clienteId = uuidOuErro(cliente, 'cliente');

  const armador = primeiraString(query.armador);
  if (armador) f.armadorId = uuidOuErro(armador, 'armador');

  const estado = primeiraString(query.estado);
  if (estado) {
    if (!ESTADOS_OPERACIONAIS.includes(estado as EstadoOperacional)) erroValor('estado');
    f.estado = estado as EstadoOperacional;
  }

  const prioridade = primeiraString(query.prioridade);
  if (prioridade) {
    if (!BALDES.includes(prioridade as PrioridadeBalde)) erroValor('prioridade');
    f.balde = prioridade as PrioridadeBalde;
  }

  const comPendencia = primeiraString(query.comPendencia);
  if (comPendencia !== undefined) f.comPendencia = boolOuErro(comPendencia, 'comPendencia');

  const comFalhaTecnica = primeiraString(query.comFalhaTecnica);
  if (comFalhaTecnica !== undefined) f.comFalhaTecnica = boolOuErro(comFalhaTecnica, 'comFalhaTecnica');

  const dentroDoFreeTime = primeiraString(query.dentroDoFreeTime);
  if (dentroDoFreeTime !== undefined) f.dentroDoFreeTime = boolOuErro(dentroDoFreeTime, 'dentroDoFreeTime');

  const emDemurrage = primeiraString(query.emDemurrage);
  if (emDemurrage !== undefined) f.emDemurrage = boolOuErro(emDemurrage, 'emDemurrage');

  const devolvido = primeiraString(query.devolvido);
  if (devolvido !== undefined) f.devolvido = boolOuErro(devolvido, 'devolvido');

  const respEmAnalise = primeiraString(query.responsabilidadeEmAnalise);
  if (respEmAnalise !== undefined) f.responsabilidadeEmAnalise = boolOuErro(respEmAnalise, 'responsabilidadeEmAnalise');

  const expIndisponivel = primeiraString(query.exposicaoIndisponivel);
  if (expIndisponivel !== undefined) f.exposicaoIndisponivel = boolOuErro(expIndisponivel, 'exposicaoIndisponivel');

  const incluirSilenciosos = primeiraString(query.incluirSilenciosos);
  if (incluirSilenciosos !== undefined) f.incluirSilenciosos = boolOuErro(incluirSilenciosos, 'incluirSilenciosos');

  const periodoCampo = primeiraString(query.periodoCampo);
  if (periodoCampo !== undefined) {
    if (!CAMPOS_PERIODO.includes(periodoCampo as CampoPeriodo)) erroValor('periodoCampo');
    f.periodoCampo = periodoCampo as CampoPeriodo;
  }

  const periodoInicio = primeiraString(query.periodoInicio);
  const periodoFim = primeiraString(query.periodoFim);
  if ((periodoInicio === undefined) !== (periodoFim === undefined)) {
    // Nunca misturar descarga e devolução implicitamente: exige os dois extremos juntos.
    erroValor('periodo');
  }
  if (periodoInicio !== undefined && periodoFim !== undefined) {
    if (!RE_DATA.test(periodoInicio)) erroValor('periodoInicio');
    if (!RE_DATA.test(periodoFim)) erroValor('periodoFim');
    if (periodoFim < periodoInicio) erroValor('periodo');
    f.periodoInicio = periodoInicio;
    f.periodoFim = periodoFim;
  }

  const busca = primeiraString(query.busca);
  if (busca !== undefined && busca.trim().length > 0) f.busca = busca.trim();

  f.apuracaoStatus = normalizarSituacaoApuracao(query);
  // Produção P1 (achado da revisão): encerrado sem demurrage é CONCLUIDO_PARA_ROCKET
  // → balde SILENCIOSO. Quem pede explicitamente FINAL/TODOS quer encontrar os
  // finalizados — então, sem `incluirSilenciosos` explícito, eles entram (o valor
  // efetivo é o que vai para o hash do cursor e para `incluiuSilenciosos`).
  if (incluirSilenciosos === undefined && f.apuracaoStatus !== 'OPEN') f.incluirSilenciosos = true;

  return f;
}

/** Sessão que pediu `/filtros` — decide a lista de `responsaveis` (por papel). Ausente = visão de gestor (chamador interno). */
export type SessaoFiltros = Pick<AutorizacaoInterna, 'papel' | 'membershipId'>;

export interface OpcoesFiltrosInput {
  /** Escopo resolvido pela rota (`resolverEscopo`); ausente = EQUIPE inteira (chamador interno). */
  escopo?: EscopoAplicado;
  sessao?: SessaoFiltros;
}

/**
 * `GET /filtros` (seção 6, v1.2 item 5): opções em uso no ESCOPO + contagens
 * por estado/balde com a derivação ATUAL (`contarEstadosEBaldes`, mesmas
 * funções congeladas e mesmo predicado de escopo da fila) — nunca `GROUP BY`
 * sobre coluna persistida. Aditivo: o resumo futuro da D13 lê as contagens
 * já prontas daqui, sem precisar chamar a fila uma vez por balde.
 */
export async function buscarOpcoesFiltros(
  pool: Pool, organizationId: string, hoje?: CivilDate, apuracaoStatus: SituacaoApuracaoFiltro = 'OPEN', opcoes: OpcoesFiltrosInput = {},
): Promise<ComMetaEscopo<FiltrosDisponiveisV1>> {
  const escopo = opcoes.escopo ?? escopoEquipeOrganizacao();
  // Mesma seleção de situação da fila: `$2` NULL = TODOS.
  const situacao = apuracaoStatus === 'TODOS' ? null : apuracaoStatus;

  const paramsOpcao: unknown[] = [organizationId, situacao];
  const escopoOpcao = sufixoEscopo(escopo, 'p.responsavel_operacional_membership_id', paramsOpcao);
  const paramsApuracao: unknown[] = [organizationId];
  const escopoApuracao = sufixoEscopo(escopo, 'p.responsavel_operacional_membership_id', paramsApuracao);

  const gestor = !opcoes.sessao || ehGestorDaSessao(opcoes.sessao);
  const paramsResponsaveis: unknown[] = [organizationId];
  if (!gestor) paramsResponsaveis.push(opcoes.sessao!.membershipId);

  const [responsaveis, clientes, armadores, contagens, porSituacao] = await Promise.all([
    pool.query(
      `SELECT m.id AS membership_id, u.nome, m.papel
         FROM organization_memberships m
         JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.organization_id = $1 AND m.papel IN ('ANALYST', 'MANAGER', 'ADMIN') AND m.desativado_em IS NULL${gestor ? '' : ' AND m.id = $2'}
        ORDER BY u.nome, m.id`,
      paramsResponsaveis,
    ),
    pool.query(
      `SELECT DISTINCT c.id, c.nome FROM processos p JOIN clientes c ON c.id = p.cliente_id
        WHERE p.organization_id = $1 AND ($2::text IS NULL OR p.apuracao_status = $2)${escopoOpcao} ORDER BY c.nome`,
      paramsOpcao,
    ),
    pool.query(
      `SELECT DISTINCT a.id, a.codigo_interno, a.nome FROM processos p JOIN armadores a ON a.id = p.armador_id
        WHERE p.organization_id = $1 AND ($2::text IS NULL OR p.apuracao_status = $2)${escopoOpcao} ORDER BY a.nome`,
      paramsOpcao,
    ),
    contarEstadosEBaldes(pool, organizationId, hoje, apuracaoStatus, escopo),
    pool.query(
      `SELECT count(*) FILTER (WHERE p.apuracao_status = 'OPEN')::int AS abertos,
              count(*) FILTER (WHERE p.apuracao_status = 'FINAL')::int AS finalizados
         FROM processos p WHERE p.organization_id = $1${escopoApuracao}`,
      paramsApuracao,
    ),
  ]);

  return {
    contrato: CONTRATO_LEITURA_V1,
    escopo: escopo.escopo,
    membershipResolvido: escopo.membershipResolvido,
    filtros: { ...filtrosDoEscopo(escopo), apuracaoStatus },
    apuracaoStatus,
    apuracao: { abertos: porSituacao.rows[0].abertos, finalizados: porSituacao.rows[0].finalizados },
    responsaveis: responsaveis.rows.map((r) => ({ membershipId: r.membership_id, nome: r.nome, papel: r.papel })),
    clientes: clientes.rows.map((r) => ({ id: r.id, nome: r.nome })),
    armadores: armadores.rows.map((r) => ({ id: r.id, codigo: r.codigo_interno, nome: r.nome })),
    estados: contagens.estados,
    baldes: contagens.baldes,
  };
}
