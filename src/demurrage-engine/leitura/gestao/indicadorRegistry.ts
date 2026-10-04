/**
 * Fase D14 v1.1 (correção #8) — registro EXPLÍCITO de todo indicador público
 * dos 5 contratos de Gestão (`operacional`, `financeiro`, `responsabilidade`,
 * `eficiencia`, `qualidade`). Existe para que a rota de composição nunca
 * devolva um 404 "surpresa" para um indicador PUBLICADO: todo ID aqui
 * presente é um ID real de algum contrato; a rota de drill-down (`drilldown.ts`)
 * consulta este registro ANTES de decidir entre calcular a composição real
 * ou devolver `drilldownDisponivel: false` explícito.
 *
 * Um ID que não aparece aqui nunca foi publicado por nenhum contrato — para
 * esse caso (e só esse), a rota de composição continua devolvendo
 * `404 nao_encontrado`.
 *
 * Médias e percentuais (Grupo D-D1/D2/D3/D4/D5/D6, Grupo E histórico) NUNCA
 * fingem ter uma lista única de composição — o próprio indicador já expõe
 * numerador/denominador ou amostra; `drilldownDisponivel: false` é a
 * resposta HONESTA, não uma lacuna escondida.
 */

export type GrupoIndicador = 'A' | 'B' | 'C' | 'D' | 'E';
export type GraoIndicador = 'container' | 'processo' | 'agregado' | 'fetch' | 'tracking_target';
export type TipoIndicador = 'contagem' | 'percentual' | 'media' | 'soma_dias' | 'lista_agrupada' | 'valor_monetario';

export interface IndicadorDescritor {
  id: string;
  grupo: GrupoIndicador;
  grao: GraoIndicador;
  tipo: TipoIndicador;
  drilldownDisponivel: boolean;
  /** Descrição humana da estratégia de composição (ou do motivo pelo qual não há uma). */
  estrategiaComposicao: string;
  /** Data natural usada pelo indicador (decisão #4 do diagnóstico D14), ou `null` para indicadores vivos. */
  dataNatural: string | null;
  /** Exige `periodoInicio`/`periodoFim` para a composição reconciliar com a contagem (indicadores históricos de período OBRIGATÓRIO — D14 v1.1 #1). */
  requerPeriodo: boolean;
  /** Aceita os filtros operacionais de `/operacional` (cliente/armador/responsável/tipoEquipamento) na composição. */
  aceitaFiltrosOperacionais: boolean;
}

const r = (d: IndicadorDescritor): IndicadorDescritor => d;

export const REGISTRO_INDICADORES: readonly IndicadorDescritor[] = [
  // ---- Grupo A — operacional.ts (todos vivos, grão já documentado em cada um) ----
  r({ id: 'G-A1', grupo: 'A', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'containers.estado IS NOT NULL', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A2', grupo: 'A', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "containers.estado = 'PRAZO_PROXIMO'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A3', grupo: 'A', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "containers.estado = 'EM_DEMURRAGE_ATENCAO'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A4', grupo: 'A', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "processos.prioridade_balde = 'CRITICA_7_14'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A5', grupo: 'A', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "processos.prioridade_balde = 'CRITICA_15'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A6', grupo: 'A', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "'rocketExposta' = ANY(containers.estado_badges)", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A7', grupo: 'A', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "'trackingDesatualizado' = ANY(containers.estado_badges)", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A8', grupo: 'A', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'estado_mais_relevante=PENDENCIA_DE_DADOS OR pendência aberta', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A9', grupo: 'A', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),
  r({ id: 'G-A10', grupo: 'A', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "apuracao_status = 'FINAL'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: true }),

  // ---- Grupo B — financeiro.ts (agregados monetários; numerador/denominador/grupos já estão na própria resposta) ----
  r({ id: 'G-B1', grupo: 'B', grao: 'agregado', tipo: 'valor_monetario', drilldownDisponivel: false, estrategiaComposicao: 'valorBrutoCliente já expõe grupos por moeda/qualidade na resposta do indicador — nenhuma lista única de contêineres é fiel (um contêiner contribui a um grupo moeda×qualidade específico)', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-B2', grupo: 'B', grao: 'agregado', tipo: 'valor_monetario', drilldownDisponivel: false, estrategiaComposicao: 'valorAtribuidoCliente vem de responsabilidade_decisoes — ver Grupo C para a composição por decisão', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-B3', grupo: 'B', grao: 'agregado', tipo: 'valor_monetario', drilldownDisponivel: false, estrategiaComposicao: 'valorAtribuidoRocket vem de responsabilidade_decisoes — ver Grupo C para a composição por decisão', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-B4', grupo: 'B', grao: 'agregado', tipo: 'valor_monetario', drilldownDisponivel: false, estrategiaComposicao: 'exposicaoRocket já expõe grupos por moeda/qualidade na resposta do indicador', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-B5', grupo: 'B', grao: 'agregado', tipo: 'valor_monetario', drilldownDisponivel: false, estrategiaComposicao: 'diferencaPotencial já expõe grupos elegíveis e contagens de inelegíveis por motivo na resposta do indicador', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),

  // ---- Grupo C — responsabilidade.ts ----
  r({ id: 'G-C-CONFIRMADA_ROCKET', grupo: 'C', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "responsabilidade_decisoes vigente com status='CONFIRMADA_ROCKET'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-C-CONFIRMADA_CLIENTE', grupo: 'C', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "responsabilidade_decisoes vigente com status='CONFIRMADA_CLIENTE'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-C-DIVIDIDA', grupo: 'C', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "responsabilidade_decisoes vigente com status='DIVIDIDA'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-C-NAO_APLICAVEL', grupo: 'C', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "responsabilidade_decisoes vigente com status='NAO_APLICAVEL'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-C2-DIARIAS-CONFIRMADAS-ROCKET', grupo: 'C', grao: 'agregado', tipo: 'soma_dias', drilldownDisponivel: false, estrategiaComposicao: 'soma de dias (não uma contagem de contêineres) — a lista de decisões que contribuem já está em GestaoResponsabilidadeV1.decisoes', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),

  // ---- Grupo D — eficiencia.ts (período OBRIGATÓRIO — D14 v1.1 #1) ----
  r({ id: 'G-D1', grupo: 'D', grao: 'agregado', tipo: 'percentual', drilldownDisponivel: false, estrategiaComposicao: 'percentual já expõe numerador/denominador na resposta do indicador', dataNatural: 'Empty Return (COALESCE(effective_return_date, tracking_return_date))', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D2', grupo: 'D', grao: 'agregado', tipo: 'percentual', drilldownDisponivel: false, estrategiaComposicao: 'percentual já expõe numerador/denominador na resposta do indicador', dataNatural: 'Empty Return (COALESCE(effective_return_date, tracking_return_date))', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D3', grupo: 'D', grao: 'agregado', tipo: 'media', drilldownDisponivel: false, estrategiaComposicao: 'média já expõe a amostra (quantidade) na resposta do indicador', dataNatural: 'Empty Return (COALESCE(effective_return_date, tracking_return_date))', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D4-CLIENTE', grupo: 'D', grao: 'agregado', tipo: 'media', drilldownDisponivel: false, estrategiaComposicao: 'média (lado cliente, seleção autoritativa G1) já expõe a amostra na resposta do indicador', dataNatural: '1º dia de demurrage (relogios.primeiro_dia_demurrage, lado cliente)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D4-ROCKET', grupo: 'D', grao: 'agregado', tipo: 'media', drilldownDisponivel: false, estrategiaComposicao: 'média (lado Rocket, seleção autoritativa G1) já expõe a amostra na resposta do indicador', dataNatural: '1º dia de demurrage (relogios.primeiro_dia_demurrage, lado rocket)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D5', grupo: 'D', grao: 'agregado', tipo: 'media', drilldownDisponivel: false, estrategiaComposicao: 'média já expõe a amostra na resposta do indicador', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D6', grupo: 'D', grao: 'agregado', tipo: 'media', drilldownDisponivel: false, estrategiaComposicao: 'média já expõe a amostra na resposta do indicador', dataNatural: 'resolução da pendência (demurrage_pendencias.resolvido_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-SEM-CUSTO-CLIENTE', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + envelope cliente NAO_APLICAVEL (seleção autoritativa G1)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-COM-CUSTO-CLIENTE', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + envelope cliente com valor (CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-SEM-EXPOSICAO-ROCKET', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + envelope Rocket NAO_APLICAVEL', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-COM-EXPOSICAO-ROCKET', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + envelope Rocket com valor', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-SEM-VALOR-NENHUM-LADO', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + os dois envelopes NAO_APLICAVEL', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-INTEGRIDADE', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + algum envelope PENDENTE/INDISPONIVEL (esperado 0 — ver docs/demurrage-fase-d14.md §8)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-RESP-CONFIRMADA-ROCKET', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + decisão vigente CONFIRMADA_ROCKET (população restrita ao período — NUNCA a mesma de G-C-CONFIRMADA_ROCKET, que é org-wide sem período)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-RESP-CONFIRMADA-CLIENTE', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + decisão vigente CONFIRMADA_CLIENTE (população restrita ao período)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-RESP-DIVIDIDA', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + decisão vigente DIVIDIDA (população restrita ao período)', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-SEM-RESPONSABILIDADE', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'processo FINAL no período + nenhuma decisão vigente', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-D-TOTAL-FINAL', grupo: 'D', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'todos os contêineres de processo FINAL no período — denominador comum dos 8 indicadores de conclusão', dataNatural: 'fechamento (processos.fechado_em)', requerPeriodo: true, aceitaFiltrosOperacionais: false }),

  // ---- Grupo E — qualidade.ts ----
  r({ id: 'G-E1', grupo: 'E', grao: 'fetch', tipo: 'contagem', drilldownDisponivel: false, estrategiaComposicao: 'grão de fetch (tracking_fetches), fora do escopo desta correção — os totais já são auditáveis via a própria resposta do indicador (historico.consultasRealizadas)', dataNatural: 'criado_em do fetch', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E2', grupo: 'E', grao: 'fetch', tipo: 'contagem', drilldownDisponivel: false, estrategiaComposicao: 'grão de fetch (tracking_fetches), fora do escopo desta correção', dataNatural: 'criado_em do fetch', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E4', grupo: 'E', grao: 'fetch', tipo: 'lista_agrupada', drilldownDisponivel: false, estrategiaComposicao: 'já é uma lista agrupada por armador na própria resposta do indicador (historico.taxaSucessoPorArmador)', dataNatural: 'criado_em do fetch', requerPeriodo: true, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E5', grupo: 'E', grao: 'tracking_target', tipo: 'contagem', drilldownDisponivel: false, estrategiaComposicao: 'grão de tracking_target (não contêiner/processo) — um target pode servir vários contêineres; composição em linha própria fora do escopo desta correção', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E6', grupo: 'E', grao: 'container', tipo: 'contagem', drilldownDisponivel: false, estrategiaComposicao: 'freeTimePorFonte tem 4 subcategorias (house/master × automático/manual) — fora do escopo desta correção', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E7', grupo: 'E', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "demurrage_pendencias aberta com tipo IN ('tipo_ausente','tipo_nao_reconhecido')", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E8', grupo: 'E', grao: 'container', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: "valores_apurados ativo com confirmation_status='UNAVAILABLE'", dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
  r({ id: 'G-E9', grupo: 'E', grao: 'processo', tipo: 'contagem', drilldownDisponivel: true, estrategiaComposicao: 'reexecução em lote de avaliarCadencia (congelada) — mesmo cálculo da contagem, agrupado por processo_id', dataNatural: null, requerPeriodo: false, aceitaFiltrosOperacionais: false }),
];

const POR_ID = new Map(REGISTRO_INDICADORES.map((d) => [d.id, d]));

export function buscarDescritorIndicador(id: string): IndicadorDescritor | undefined {
  return POR_ID.get(id);
}

export function listarIndicadoresRegistrados(): readonly IndicadorDescritor[] {
  return REGISTRO_INDICADORES;
}
