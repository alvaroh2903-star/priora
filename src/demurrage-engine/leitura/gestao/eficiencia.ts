import { Pool } from 'pg';
import { CivilDate, toOrdinal } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { ErroLeitura } from '../contrato';
import { buscarEnvelopesSelecionadosDaOrganizacao } from './selecaoFinanceira';

/**
 * Fase D14 (Gate G4) — Grupo D: eficiência e conclusão (Cap. 30.4).
 *
 * Metodologia aprovada (diagnóstico `b137a07`, §5 Grupo D, decisões #1–#5/#7):
 *  - só `processos.apuracao_status = 'FINAL'` entra em qualquer média ou
 *    indicador de conclusão (decisão #2 — processos abertos excluídos);
 *  - dias CORRIDOS (decisão #3), nunca úteis — subtração de `DATE` no
 *    próprio Postgres, nunca `CivilDate` reimplementada;
 *  - "dias de demurrage" usa `valores_apurados.dias_cobrados` da linha ATIVA
 *    selecionada (decisão #1), nunca uma soma bruta de todas as linhas FINAL;
 *  - um processo com reaberturas conta UMA VEZ, pelo ciclo mais recente —
 *    automático aqui: `processos` tem uma única linha por processo (nunca
 *    duplicada por reabertura); o histórico de ciclos anteriores fica no
 *    drill-down via `closing_events`/`reaberturas`, nunca contado de novo
 *    aqui (decisão #5);
 *  - totais somam TODOS os contêineres aplicáveis, nunca só o líder
 *    (decisão #7) — cada contêiner do processo FINAL entra na contagem;
 *  - data natural fixa por família (decisão #4, SEM override genérico):
 *    Empty Return para G-D1/D2/D3; 1º dia de demurrage para G-D4;
 *    fechamento para G-D5/D6 e os 8 indicadores de conclusão.
 *
 * Correção bloqueante 2 (D14 V1) — G-D7/G-D8 (ambíguos) substituídos por 8
 * indicadores separados, cada um com tratamento explícito de pendente/
 * indisponível (nunca "sem custo" por omissão) e um indicador de
 * integridade que nunca deixa pendência virar zero.
 *
 * D14 v1.1 — correções #1/#2/#3 do achado corretivo sobre o commit `60f2a4e`:
 *  #1 `periodo` agora é OBRIGATÓRIO (tipo `PeriodoObrigatorio`, não mais
 *     opcional) — toda a rota é inerentemente histórica (só processos
 *     FINAL), então "sem período" nunca mais significa "desde sempre": o
 *     TIPO não permite chamar esta função sem `inicio`/`fim`, e a validação
 *     de forma/ordem (`inicio <= fim`, datas civis reais) é feita na rota
 *     (`demurrageGestaoRoutes.ts`) e aqui de novo em `validarPeriodoObrigatorio`
 *     (defesa em profundidade — nenhum chamador interno, inclusive o
 *     drill-down, pode acidentalmente pular a validação);
 *  #2 G-D4 deixou de somar `valores_apurados.dias_cobrados` cru (podia
 *     contar duas linhas do mesmo contêiner/lado se dois motores comerciais
 *     estivessem ativos ao mesmo tempo — o mesmo risco que o G1 da D14 V1 já
 *     tinha corrigido para a seleção financeira, nunca propagado para esta
 *     consulta). Agora reaproveita `buscarEnvelopesSelecionadosDaOrganizacao`
 *     (G1 — `selecionarValorAtivo`/`motorClienteAplicavelDe`), que já reduz a
 *     no máximo uma linha por lado/contêiner. Cliente e Rocket NUNCA mais são
 *     misturados num único "por contêiner": `mediaDiasDemurrageCliente` e
 *     `mediaDiasDemurrageRocket` são médias SEPARADAS, cada uma com a própria
 *     amostra;
 *  #3 G-D3 (`mediaDiasDescargaAteEmptyReturn`) usava só
 *     `tracking_return_date` na subtração, ignorando `effective_return_date`
 *     — um contêiner com SÓ minuta validada (sem *tracking_return_date*
 *     correspondente, caso raro mas possível) saía silenciosamente da média.
 *     Agora usa a MESMA data canônica de Empty Return de G-D1/D2:
 *     `COALESCE(effective_return_date, tracking_return_date)`.
 */

export interface PeriodoFiltro {
  inicio?: CivilDate;
  fim?: CivilDate;
}

/** Período histórico OBRIGATÓRIO (D14 v1.1 #1) — nunca um "desde sempre" implícito. */
export interface PeriodoObrigatorio {
  inicio: CivilDate;
  fim: CivilDate;
}

/**
 * Valida que o período tem as duas datas, que são datas civis REAIS (não só
 * o formato `AAAA-MM-DD` — `toOrdinal` rejeita `2026-02-30`/`2026-13-01`/etc.)
 * e que `inicio <= fim`. Lança `ErroLeitura(400, ...)` determinístico — nunca
 * um `throw` genérico que vire 500.
 */
export function validarPeriodoObrigatorio(periodo: PeriodoObrigatorio | null | undefined): PeriodoObrigatorio {
  if (!periodo || periodo.inicio === undefined || periodo.inicio === null || periodo.fim === undefined || periodo.fim === null) {
    throw new ErroLeitura(400, 'periodo_obrigatorio', { campos: ['periodoInicio', 'periodoFim'] });
  }
  let inicioOrdinal: number;
  let fimOrdinal: number;
  try {
    inicioOrdinal = toOrdinal(periodo.inicio);
  } catch {
    throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoInicio' });
  }
  try {
    fimOrdinal = toOrdinal(periodo.fim);
  } catch {
    throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoFim' });
  }
  if (inicioOrdinal > fimOrdinal) {
    throw new ErroLeitura(400, 'periodo_invertido', { periodoInicio: periodo.inicio, periodoFim: periodo.fim });
  }
  return { inicio: periodo.inicio, fim: periodo.fim };
}

export interface MediaComAmostra {
  media: number | null;
  amostra: number;
}

export interface GestaoEficienciaV1 {
  contrato: 'demurrage.gestao.eficiencia.v1';
  periodo: PeriodoObrigatorio;
  /** G-D1. */
  percentualDevolvidoDentroHouseFT: { percentual: number | null; numerador: number; denominador: number };
  /** G-D2. */
  percentualDevolvidoDentroMasterFT: { percentual: number | null; numerador: number; denominador: number };
  /** G-D3 — dias corridos descarga→Empty Return, data canônica COALESCE(effective_return_date, tracking_return_date). */
  mediaDiasDescargaAteEmptyReturn: MediaComAmostra;
  /** G-D4-CLIENTE — dias_cobrados da linha ATIVA selecionada do lado cliente (D14 v1.1 #2: nunca misturado com o Rocket). */
  mediaDiasDemurrageCliente: MediaComAmostra;
  /** G-D4-ROCKET — idem, lado Rocket. */
  mediaDiasDemurrageRocket: MediaComAmostra;
  /** G-D5. */
  mediaDiasEmptyReturnAteConclusao: MediaComAmostra;
  /** G-D6. */
  mediaDiasResolucaoPendencias: MediaComAmostra;
  /** Correção bloqueante 2 — 8 indicadores de conclusão separados, grão contêiner (6/7/8 grão contêiner via decisão vigente). */
  concluidos: {
    semCustoCliente: number;
    comCustoCliente: number;
    semExposicaoRocket: number;
    comExposicaoRocket: number;
    semValorNenhumLado: number;
    responsabilidadeConfirmadaRocket: number;
    responsabilidadeConfirmadaCliente: number;
    responsabilidadeDividida: number;
    /** Contêineres de processo FINAL cujo envelope cliente OU Rocket ainda está pendente/indisponível — nunca contados como "sem custo"; esperado 0, medido sempre. */
    integridadePendenciaRemanescente: number;
    /** Contêineres de processo FINAL sem decisão de responsabilidade vigente — fora das 3 contagens de responsabilidade acima, nunca escondidos. */
    semResponsabilidadeAtribuida: number;
    totalContaineresFinal: number;
  };
}

function condicaoPeriodo(campo: string, periodo: PeriodoObrigatorio, params: unknown[]): string {
  params.push(periodo.inicio, periodo.fim);
  return ` AND ${campo} >= $${params.length - 1} AND ${campo} <= $${params.length}`;
}

async function mediaDiasDescargaRetorno(pool: Pool, organizationId: string, periodo: PeriodoObrigatorio) {
  const params: unknown[] = [organizationId];
  // D14 v1.1 #3 — mesma data canônica de Empty Return nas três consultas (G-D1/D2/D3): nunca só `tracking_return_date`.
  const condPeriodo = condicaoPeriodo('COALESCE(c.effective_return_date, c.tracking_return_date)', periodo, params);
  const { rows } = await pool.query(
    `SELECT
        count(*) FILTER (WHERE c.house_free_time_days IS NOT NULL)::int AS d1_denom,
        count(*) FILTER (
          WHERE c.house_free_time_days IS NOT NULL
            AND COALESCE(c.effective_return_date, c.tracking_return_date) <= c.discharge_date + (c.house_free_time_days - 1)
        )::int AS d1_numer,
        count(*) FILTER (WHERE c.master_free_time_days IS NOT NULL)::int AS d2_denom,
        count(*) FILTER (
          WHERE c.master_free_time_days IS NOT NULL
            AND COALESCE(c.effective_return_date, c.tracking_return_date) <= c.discharge_date + (c.master_free_time_days - 1)
        )::int AS d2_numer,
        avg(COALESCE(c.effective_return_date, c.tracking_return_date) - c.discharge_date) FILTER (
          WHERE COALESCE(c.effective_return_date, c.tracking_return_date) IS NOT NULL AND c.discharge_date IS NOT NULL
        ) AS d3_media,
        count(*) FILTER (
          WHERE COALESCE(c.effective_return_date, c.tracking_return_date) IS NOT NULL AND c.discharge_date IS NOT NULL
        )::int AS d3_n
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
      WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL'
        AND COALESCE(c.effective_return_date, c.tracking_return_date) IS NOT NULL${condPeriodo}`,
    params,
  );
  return rows[0];
}

/**
 * G-D4 (D14 v1.1 #2) — contêineres de processo FINAL cujo relógio (cliente OU
 * Rocket) teve seu PRIMEIRO dia de demurrage dentro do período, com a MÉDIA
 * calculada sobre `dias_cobrados` da linha ATIVA SELECIONADA (G1,
 * `buscarEnvelopesSelecionadosDaOrganizacao`) — nunca uma soma bruta de
 * `valores_apurados`. Cliente e Rocket são universos e médias SEPARADOS.
 */
async function mediaDiasDemurrageFinal(
  pool: Pool, organizationId: string, periodo: PeriodoObrigatorio, hoje: CivilDate,
): Promise<{ cliente: MediaComAmostra; rocket: MediaComAmostra }> {
  const paramsCliente: unknown[] = [organizationId];
  const condCliente = condicaoPeriodo('r.primeiro_dia_demurrage', periodo, paramsCliente);
  const { rows: clienteRows } = await pool.query(
    `SELECT DISTINCT c.id AS container_id
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       JOIN relogios r ON r.container_id = c.id AND r.tipo = 'cliente'
      WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL'${condCliente}`,
    paramsCliente,
  );

  const paramsRocket: unknown[] = [organizationId];
  const condRocket = condicaoPeriodo('r.primeiro_dia_demurrage', periodo, paramsRocket);
  const { rows: rocketRows } = await pool.query(
    `SELECT DISTINCT c.id AS container_id
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       JOIN relogios r ON r.container_id = c.id AND r.tipo = 'rocket'
      WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL'${condRocket}`,
    paramsRocket,
  );

  const clienteIds = new Set<string>(clienteRows.map((r) => r.container_id as string));
  const rocketIds = new Set<string>(rocketRows.map((r) => r.container_id as string));
  const todosIds = Array.from(new Set<string>([...clienteIds, ...rocketIds]));

  const media = (valores: number[]): MediaComAmostra => ({
    media: valores.length === 0 ? null : Math.round((valores.reduce((a, b) => a + b, 0) / valores.length) * 100) / 100,
    amostra: valores.length,
  });

  if (todosIds.length === 0) return { cliente: media([]), rocket: media([]) };

  const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, organizationId, hoje, { containerIds: todosIds });
  const clienteValores: number[] = [];
  const rocketValores: number[] = [];
  for (const env of envelopes) {
    if (clienteIds.has(env.containerId) && env.clienteDiasCobrados != null && env.clienteDiasCobrados > 0) {
      clienteValores.push(env.clienteDiasCobrados);
    }
    if (rocketIds.has(env.containerId) && env.rocketDiasCobrados != null && env.rocketDiasCobrados > 0) {
      rocketValores.push(env.rocketDiasCobrados);
    }
  }
  return { cliente: media(clienteValores), rocket: media(rocketValores) };
}

/**
 * G7 (benchmark) — reescrita de desempenho, SEM mudar o resultado: filtra os
 * processos FINAL (`processos_final`) ANTES de agregar `containers` (nunca
 * depois). A forma original agregava TODOS os contêineres da organização e
 * só filtrava por processo FINAL no JOIN externo; o planner do PostgreSQL 16
 * reexecutava essa agregação uma vez por processo FINAL (plano de Nested
 * Loop com a função de agregação como lado interno), O(processos × contêineres)
 * — medido em ~4,7s com 10.000 processos. Filtrar primeiro reduz o conjunto
 * agregado ao universo relevante (ordens de grandeza menor) e deixa os dois
 * lados pequenos o bastante para um Hash Join — medido em ~6ms com os mesmos
 * 10.000 processos. Nenhum índice novo: é só reescrita da consulta.
 *
 * `MATERIALIZED` explícito nas duas CTEs (PostgreSQL 12+): sem ele, o plano
 * às vezes volta a reexecutar a segunda CTE uma vez por linha externa quando
 * a estimativa de linhas da primeira CTE é subestimada (depende de
 * estatísticas recém-atualizadas após carga em lote) — medido ~700ms com o
 * plano instável vs. ~7ms com `MATERIALIZED`, que torna o plano determinístico
 * independente da qualidade da estimativa.
 */
async function mediaEmptyReturnAteConclusao(pool: Pool, organizationId: string, periodo: PeriodoObrigatorio) {
  const params: unknown[] = [organizationId];
  const condPeriodo = condicaoPeriodo('p.fechado_em::date', periodo, params);
  const { rows } = await pool.query(
    `WITH processos_final AS MATERIALIZED (
        SELECT p.id, p.fechado_em FROM processos p
         WHERE p.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em IS NOT NULL${condPeriodo}
     ),
     retorno_processo AS MATERIALIZED (
        SELECT c.processo_id, max(COALESCE(c.effective_return_date, c.tracking_return_date)) AS devolucao
          FROM containers c
          JOIN processos_final pf ON pf.id = c.processo_id
         GROUP BY c.processo_id
     )
     SELECT avg(pf.fechado_em::date - rp.devolucao) AS media, count(*)::int AS n
       FROM processos_final pf
       JOIN retorno_processo rp ON rp.processo_id = pf.id
      WHERE rp.devolucao IS NOT NULL`,
    params,
  );
  return rows[0];
}

async function mediaResolucaoPendencias(pool: Pool, organizationId: string, periodo: PeriodoObrigatorio) {
  const params: unknown[] = [organizationId];
  const condPeriodo = condicaoPeriodo('dp.resolvido_em::date', periodo, params);
  const { rows } = await pool.query(
    `SELECT avg(dp.resolvido_em::date - dp.criado_em::date) AS media, count(*)::int AS n
       FROM demurrage_pendencias dp
      WHERE dp.organization_id = $1 AND dp.estado = 'resolvida'${condPeriodo}`,
    params,
  );
  return rows[0];
}

export async function montarGestaoEficiencia(
  pool: Pool, organizationId: string, periodoEntrada: PeriodoObrigatorio, hoje?: CivilDate,
): Promise<GestaoEficienciaV1> {
  const h = hoje ?? hojeOperacional();
  const periodo = validarPeriodoObrigatorio(periodoEntrada);

  const [devolucao, demurrageFinal, emptyReturnConclusao, resolucaoPendencias] = await Promise.all([
    mediaDiasDescargaRetorno(pool, organizationId, periodo),
    mediaDiasDemurrageFinal(pool, organizationId, periodo, h),
    mediaEmptyReturnAteConclusao(pool, organizationId, periodo),
    mediaResolucaoPendencias(pool, organizationId, periodo),
  ]);

  // Containers de processos FINAL, filtrados pela data natural de fechamento (decisão #4).
  const paramsContainers: unknown[] = [organizationId];
  const condPeriodoFechamento = condicaoPeriodo('p.fechado_em::date', periodo, paramsContainers);
  const { rows: containerRows } = await pool.query(
    `SELECT c.id AS container_id
       FROM containers c JOIN processos p ON p.id = c.processo_id
      WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL'${condPeriodoFechamento}`,
    paramsContainers,
  );
  const containerIds: string[] = containerRows.map((r) => r.container_id);

  let semCustoCliente = 0, comCustoCliente = 0, semExposicaoRocket = 0, comExposicaoRocket = 0, semValorNenhumLado = 0, integridadePendenciaRemanescente = 0;
  let respRocket = 0, respCliente = 0, respDividida = 0, semResponsabilidade = 0;

  if (containerIds.length > 0) {
    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, organizationId, h, { containerIds });
    const COM_VALOR = new Set(['CONFIRMADO', 'ESTIMADO', 'ESTIMADO_PROVISORIO']);
    const PENDENTE_INDISPONIVEL = new Set(['PENDENTE', 'INDISPONIVEL']);
    for (const env of envelopes) {
      const cli = env.cliente.situacao, roc = env.rocket.situacao;
      if (PENDENTE_INDISPONIVEL.has(cli) || PENDENTE_INDISPONIVEL.has(roc)) { integridadePendenciaRemanescente++; continue; }
      const semCliente = cli === 'NAO_APLICAVEL';
      const semRocket = roc === 'NAO_APLICAVEL';
      if (semCliente) semCustoCliente++;
      if (COM_VALOR.has(cli)) comCustoCliente++;
      if (semRocket) semExposicaoRocket++;
      if (COM_VALOR.has(roc)) comExposicaoRocket++;
      if (semCliente && semRocket) semValorNenhumLado++;
    }

    const { rows: decisoes } = await pool.query(
      `SELECT d.container_id, d.status
         FROM responsabilidade_decisoes d
        WHERE d.organization_id = $1 AND d.container_id = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
      [organizationId, containerIds],
    );
    const decisaoPorContainer = new Map(decisoes.map((d) => [d.container_id as string, d.status as string]));
    for (const id of containerIds) {
      const status = decisaoPorContainer.get(id);
      if (status === 'CONFIRMADA_ROCKET') respRocket++;
      else if (status === 'CONFIRMADA_CLIENTE') respCliente++;
      else if (status === 'DIVIDIDA') respDividida++;
      else semResponsabilidade++;
    }
  }

  const pct = (numer: number, denom: number): number | null => (denom === 0 ? null : Math.round((numer / denom) * 10000) / 100);
  const media = (row: { media: unknown; n?: number; d3_n?: number }, n: number): MediaComAmostra => ({
    media: row.media === null || n === 0 ? null : Math.round(Number(row.media) * 100) / 100,
    amostra: n,
  });

  return {
    contrato: 'demurrage.gestao.eficiencia.v1',
    periodo,
    percentualDevolvidoDentroHouseFT: { percentual: pct(devolucao.d1_numer, devolucao.d1_denom), numerador: devolucao.d1_numer, denominador: devolucao.d1_denom },
    percentualDevolvidoDentroMasterFT: { percentual: pct(devolucao.d2_numer, devolucao.d2_denom), numerador: devolucao.d2_numer, denominador: devolucao.d2_denom },
    mediaDiasDescargaAteEmptyReturn: media(devolucao, devolucao.d3_n),
    mediaDiasDemurrageCliente: demurrageFinal.cliente,
    mediaDiasDemurrageRocket: demurrageFinal.rocket,
    mediaDiasEmptyReturnAteConclusao: media(emptyReturnConclusao, emptyReturnConclusao.n),
    mediaDiasResolucaoPendencias: media(resolucaoPendencias, resolucaoPendencias.n),
    concluidos: {
      semCustoCliente, comCustoCliente, semExposicaoRocket, comExposicaoRocket, semValorNenhumLado,
      responsabilidadeConfirmadaRocket: respRocket, responsabilidadeConfirmadaCliente: respCliente, responsabilidadeDividida: respDividida,
      integridadePendenciaRemanescente, semResponsabilidadeAtribuida: semResponsabilidade, totalContaineresFinal: containerIds.length,
    },
  };
}
