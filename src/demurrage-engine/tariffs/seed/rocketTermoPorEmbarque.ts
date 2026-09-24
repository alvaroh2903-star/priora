import { Pool, PoolClient } from 'pg';
import { CivilDate } from '../../temporal/civilDate';

/**
 * Tabela Rocket×cliente — Termo por Embarque, valores LITERAIS do Blueprint
 * (Cap. 24.1), como aprovados na autorização da Fase 4. DV e HC compartilham a
 * mesma diária ("20' DV/HC → US$150"), então cada preço vira duas linhas de
 * equipamento — o que é literal, não aproximação por semelhança.
 *
 * É tabela PRIVADA de organização (tipo `rocket_cliente`), então mora num módulo
 * de seed inserido por organização, não numa migration global.
 */

export const TERMO_POR_EMBARQUE_ROCKET_MOEDA = 'USD';

/** Diária por classe de equipamento (USD/dia), literal do Blueprint Cap. 24.1. */
export const TERMO_POR_EMBARQUE_ROCKET_DIARIAS: ReadonlyArray<{ equipamento: string; valorDia: number }> = [
  { equipamento: '20DV', valorDia: 150 },
  { equipamento: '20HC', valorDia: 150 },
  { equipamento: '40DV', valorDia: 250 },
  { equipamento: '40HC', valorDia: 250 },
  { equipamento: '20OT', valorDia: 230 },
  { equipamento: '40OT', valorDia: 300 },
  { equipamento: '20FR', valorDia: 230 },
  { equipamento: '40FR', valorDia: 300 },
  { equipamento: '20NOR', valorDia: 275 },
  { equipamento: '40NOR', valorDia: 400 },
  { equipamento: '20RE', valorDia: 450 },
  { equipamento: '40RE', valorDia: 600 },
];

export interface SeedRocketOptions {
  organizationId: string;
  versao?: number;
  vigenciaInicio?: CivilDate;
  vigenciaFim?: CivilDate | null;
  /** Sobrescreve as diárias (para seedar uma 2ª versão em teste); default = Blueprint. */
  diarias?: ReadonlyArray<{ equipamento: string; valorDia: number }>;
  fonte?: string;
}

/**
 * Insere a tabela Rocket (Termo por Embarque) e suas faixas (uma faixa aberta
 * [1,∞) por equipamento — tarifa fixa por dia). Retorna o id da tabela.
 */
export async function seedRocketTermoPorEmbarque(
  db: Pool | PoolClient,
  opts: SeedRocketOptions,
): Promise<string> {
  const versao = opts.versao ?? 1;
  const vigenciaInicio = opts.vigenciaInicio ?? '2026-01-01';
  const vigenciaFim = opts.vigenciaFim ?? null;
  const diarias = opts.diarias ?? TERMO_POR_EMBARQUE_ROCKET_DIARIAS;
  const fonte = opts.fonte ?? 'Blueprint Cap. 24.1';

  const { rows } = await db.query(
    `INSERT INTO tariff_tables
       (organization_id, tipo, termo_comercial, versao, vigencia_inicio, vigencia_fim,
        qualidade_fonte, day_count_basis, fonte)
     VALUES ($1, 'rocket_cliente', 'embarque', $2, $3, $4, 'OFICIAL_VALIDADA', 'since_discharge_absolute', $5)
     RETURNING id`,
    [opts.organizationId, versao, vigenciaInicio, vigenciaFim, fonte],
  );
  const tabelaId: string = rows[0].id;

  for (const d of diarias) {
    await db.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
       VALUES ($1, $2, 1, NULL, $3, $4)`,
      [tabelaId, d.equipamento, d.valorDia, TERMO_POR_EMBARQUE_ROCKET_MOEDA],
    );
  }
  return tabelaId;
}
