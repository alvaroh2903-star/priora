import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import {
  AgregadoFinanceiroLado, SituacaoValor, agregarLado,
} from '../contrato';
import { centavosExatos, formatarCentavos } from '../moedaExata';
import { buscarEnvelopesSelecionadosDaOrganizacao, EnvelopesContainer } from './selecaoFinanceira';

/**
 * Fase D14 (Gate G2) — agregação financeira exata de organização e
 * diferença potencial. Generaliza `agregarLado` (D12 v1.2.1, exportada SEM
 * reescrita — ver `contrato.ts`) para o grão de organização: ela já soma em
 * centavos `bigint`, nunca `Number`/`+`, nunca mistura moeda, nunca converte
 * pendente/indisponível em zero — nada disso é reescrito aqui, só chamado com
 * uma lista maior de envelopes.
 */

export type QualidadeDiferenca = 'confirmado' | 'estimado' | 'provisorio';
export type MotivoInelegibilidade = 'pendente' | 'indisponivel' | 'incompativel_moeda' | 'periodo_incompativel' | 'obsoleto';

export interface DiferencaPotencialElegivel {
  elegivel: true;
  containerId: string;
  processoId: string;
  moeda: string;
  /** String decimal exata (centavos `bigint` → `formatarCentavos`) — cliente menos Rocket, nunca convertida de moeda. */
  subtotalExato: string;
  qualidade: QualidadeDiferenca;
}

export interface DiferencaPotencialInelegivel {
  elegivel: false;
  containerId: string;
  processoId: string;
  motivo: MotivoInelegibilidade;
}

export type DiferencaPotencialResultado = DiferencaPotencialElegivel | DiferencaPotencialInelegivel;

/** Pior qualidade entre os dois lados — nunca a melhor (Cap. 30.2, decisão #8 aprovada). */
function qualidadeDe(cliente: SituacaoValor, rocket: SituacaoValor): QualidadeDiferenca {
  if (cliente === 'ESTIMADO_PROVISORIO' || rocket === 'ESTIMADO_PROVISORIO') return 'provisorio';
  if (cliente === 'CONFIRMADO' && rocket === 'CONFIRMADO') return 'confirmado';
  return 'estimado';
}

/**
 * Elegibilidade e cálculo da diferença potencial de UM contêiner — função
 * PURA sobre o `EnvelopesContainer` já selecionado (§6/§7 do diagnóstico
 * `b137a07`). Nunca chamada sobre linhas brutas de `valores_apurados`.
 *
 * Ordem das checagens (cada uma reporta um motivo ESTRUTURADO, nunca
 * `null`/zero silencioso):
 *  1. `pendente` — qualquer lado com envelope PENDENTE.
 *  2. `indisponivel` — qualquer lado INDISPONIVEL ou NAO_APLICAVEL (sem
 *     número para comparar — NAO_APLICAVEL tem `total`/`moeda` nulos, não dá
 *     para subtrair; tratado como indisponível PARA FINS DESTA
 *     COMPARAÇÃO, decisão explícita desta implementação, documentada no
 *     relatório de entrega).
 *  3. `incompativel_moeda` — moedas diferentes.
 *  4. `periodo_incompativel` — `data_final_apuracao` dos dois relógios
 *     diverge (não é a mesma apuração).
 *  5. `obsoleto` — a apuração de algum lado ainda não cobre o dia
 *     operacional de hoje (cache do relógio desatualizado em relação a
 *     "hoje"), e o contêiner não foi devolvido (devolução congela a
 *     apuração — não é "obsoleta", é final).
 */
export function calcularDiferencaPotencial(env: EnvelopesContainer, hoje: CivilDate): DiferencaPotencialResultado {
  const base = { containerId: env.containerId, processoId: env.processoId };
  const { cliente: cli, rocket: roc } = env;

  if (cli.situacao === 'PENDENTE' || roc.situacao === 'PENDENTE') return { ...base, elegivel: false, motivo: 'pendente' };
  if (cli.situacao === 'INDISPONIVEL' || roc.situacao === 'INDISPONIVEL') return { ...base, elegivel: false, motivo: 'indisponivel' };
  if (cli.situacao === 'NAO_APLICAVEL' || roc.situacao === 'NAO_APLICAVEL') return { ...base, elegivel: false, motivo: 'indisponivel' };

  if (cli.moeda !== roc.moeda) return { ...base, elegivel: false, motivo: 'incompativel_moeda' };

  const dfaCliente = env.clienteRelogio?.dataFinalApuracao ?? null;
  const dfaRocket = env.rocketRelogio?.dataFinalApuracao ?? null;
  if (dfaCliente === null || dfaRocket === null || dfaCliente !== dfaRocket) {
    return { ...base, elegivel: false, motivo: 'periodo_incompativel' };
  }

  if (!env.emptyReturn && (dfaCliente < hoje || dfaRocket < hoje)) {
    return { ...base, elegivel: false, motivo: 'obsoleto' };
  }

  const centavos = centavosExatos(cli.total as number) - centavosExatos(roc.total as number);
  return {
    ...base,
    elegivel: true,
    moeda: cli.moeda as string,
    subtotalExato: formatarCentavos(centavos),
    qualidade: qualidadeDe(cli.situacao, roc.situacao),
  };
}

export interface DiferencaPotencialGrupo {
  moeda: string;
  qualidade: QualidadeDiferenca;
  /** Soma exata (centavos bigint) das diferenças elegíveis deste grupo — NUNCA a subtração de dois totais já agregados. */
  subtotalExato: string;
  quantidade: number;
}

export interface DiferencaPotencialOrganizacao {
  grupos: DiferencaPotencialGrupo[];
  /** Contagens de contêineres fora da soma, por motivo — nunca escondidas (Cap. 30.7). */
  inelegiveis: Record<MotivoInelegibilidade, number>;
}

/**
 * Soma de organização da diferença potencial — SEMPRE a soma das diferenças
 * JÁ ELEGÍVEIS por contêiner (nunca `totalCliente - totalRocket` de dois
 * agregados de organização já somados, o que misturaria contêineres onde só
 * um lado está disponível). Agrupada por moeda × qualidade — nunca combinada.
 */
export function agregarDiferencaPotencial(resultados: DiferencaPotencialResultado[]): DiferencaPotencialOrganizacao {
  const porGrupo = new Map<string, { moeda: string; qualidade: QualidadeDiferenca; centavos: bigint[]; quantidade: number }>();
  const inelegiveis: Record<MotivoInelegibilidade, number> = { pendente: 0, indisponivel: 0, incompativel_moeda: 0, periodo_incompativel: 0, obsoleto: 0 };

  for (const r of resultados) {
    if (!r.elegivel) { inelegiveis[r.motivo]++; continue; }
    const chave = `${r.moeda}:${r.qualidade}`;
    if (!porGrupo.has(chave)) porGrupo.set(chave, { moeda: r.moeda, qualidade: r.qualidade, centavos: [], quantidade: 0 });
    const g = porGrupo.get(chave)!;
    g.centavos.push(centavosExatos(r.subtotalExato));
    g.quantidade++;
  }

  const grupos: DiferencaPotencialGrupo[] = Array.from(porGrupo.values())
    .map((g) => ({
      moeda: g.moeda, qualidade: g.qualidade, quantidade: g.quantidade,
      subtotalExato: formatarCentavos(g.centavos.reduce((acc, c) => acc + c, 0n)),
    }))
    .sort((a, b) => (a.moeda === b.moeda ? a.qualidade.localeCompare(b.qualidade) : a.moeda.localeCompare(b.moeda)));

  return { grupos, inelegiveis };
}

export interface ResponsabilidadeSoma {
  gruposPorMoeda: Array<{ moeda: string; subtotalExato: string }>;
  /** Decisões cujo `valor_status` não é CALCULADO — nunca somadas, sempre contadas à parte. */
  naoCalculadas: number;
}

/**
 * G-B2/G-B3 — valor efetivamente atribuído ao cliente / à Rocket, por decisão
 * de responsabilidade VIGENTE (não superseded) com `valor_status='CALCULADO'`.
 * Soma exata em centavos, nunca combinada com a agregação de
 * `valores_apurados` (são fontes diferentes — Cap. 26 vs. Cap. 24).
 */
export async function somarResponsabilidadePorLado(
  pool: Pool, organizationId: string, lado: 'valor_cliente' | 'valor_rocket',
): Promise<ResponsabilidadeSoma> {
  const coluna = lado === 'valor_cliente' ? 'd.valor_cliente' : 'd.valor_rocket';
  const { rows } = await pool.query(
    `SELECT d.moeda, ${coluna} AS valor, d.valor_status
       FROM responsabilidade_decisoes d
      WHERE d.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
    [organizationId],
  );
  const porMoeda = new Map<string, bigint[]>();
  let naoCalculadas = 0;
  for (const r of rows) {
    if (r.valor_status !== 'CALCULADO' || r.valor === null) { naoCalculadas++; continue; }
    if (!porMoeda.has(r.moeda)) porMoeda.set(r.moeda, []);
    porMoeda.get(r.moeda)!.push(centavosExatos(r.valor));
  }
  const gruposPorMoeda = Array.from(porMoeda.entries())
    .map(([moeda, cs]) => ({ moeda, subtotalExato: formatarCentavos(cs.reduce((acc, c) => acc + c, 0n)) }))
    .sort((a, b) => a.moeda.localeCompare(b.moeda));
  return { gruposPorMoeda, naoCalculadas };
}

export interface GestaoFinanceiroV1 {
  contrato: 'demurrage.gestao.financeiro.v1';
  dataOperacional: CivilDate;
  /** G-B1 — valor bruto do cliente (todos os contêineres selecionados, D12 v1.2 DV-01 generalizada). */
  valorBrutoCliente: AgregadoFinanceiroLado;
  /** G-B2. */
  valorAtribuidoCliente: ResponsabilidadeSoma;
  /** G-B3 — acessível só a MANAGER/ADMIN na rota (campo nunca omitido aqui; a rota decide a visibilidade). */
  valorAtribuidoRocket: ResponsabilidadeSoma;
  /** G-B4/G-B5 juntos — `AgregadoFinanceiroLado` já separa por `confirmation_status` dentro do grupo de moeda (confirmados/estimados/estimativasProvisorias). */
  exposicaoRocket: AgregadoFinanceiroLado;
  /** G-B6 — estritamente interno (MANAGER/ADMIN); a rota decide se inclui. */
  diferencaPotencial: DiferencaPotencialOrganizacao;
}

export async function montarGestaoFinanceiro(pool: Pool, organizationId: string, hoje?: CivilDate): Promise<GestaoFinanceiroV1> {
  const h = hoje ?? hojeOperacional();
  const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, organizationId, h);

  const valorBrutoCliente = agregarLado(envelopes.map((e) => e.cliente));
  const exposicaoRocket = agregarLado(envelopes.map((e) => e.rocket));

  const [valorAtribuidoCliente, valorAtribuidoRocket] = await Promise.all([
    somarResponsabilidadePorLado(pool, organizationId, 'valor_cliente'),
    somarResponsabilidadePorLado(pool, organizationId, 'valor_rocket'),
  ]);

  const diferencas = envelopes.map((e) => calcularDiferencaPotencial(e, h));
  const diferencaPotencial = agregarDiferencaPotencial(diferencas);

  return {
    contrato: 'demurrage.gestao.financeiro.v1',
    dataOperacional: h,
    valorBrutoCliente,
    valorAtribuidoCliente,
    valorAtribuidoRocket,
    exposicaoRocket,
    diferencaPotencial,
  };
}
