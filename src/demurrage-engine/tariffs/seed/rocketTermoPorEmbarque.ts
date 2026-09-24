import { Pool, PoolClient } from 'pg';
import { CivilDate } from '../../temporal/civilDate';

/**
 * Tabelas Rocket×cliente — Termo por Embarque (Cap. 24.1) e Termo Único
 * (Cap. 24.2), valores LITERAIS do Blueprint. As duas coincidem numericamente
 * hoje, mas são tabelas e motores separados; nunca compartilham linha.
 *
 * DV e HC compartilham a mesma diária ("20' DV/HC → US$150"), então cada preço
 * vira duas linhas de equipamento — literal, não aproximação.
 *
 * Vigência desconhecida (revisão 8): `vigencia_inicio = NULL`, `verificada_em`
 * = 24/09/2026 (data em que os valores foram conferidos, não de início).
 */

export const TERMO_ROCKET_MOEDA = 'USD';
export const VERIFICADA_ROCKET = '2026-09-24T00:00:00Z';

/** Diária por classe de equipamento (USD/dia), literal do Blueprint. */
export const DIARIAS_ROCKET: ReadonlyArray<{ equipamento: string; valorDia: number }> = [
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

// Compat: nome antigo usado por testes existentes.
export const TERMO_POR_EMBARQUE_ROCKET_DIARIAS = DIARIAS_ROCKET;
export const TERMO_POR_EMBARQUE_ROCKET_MOEDA = TERMO_ROCKET_MOEDA;

export interface SeedRocketOptions {
  organizationId: string;
  versao?: number;
  /** Início de vigência; undefined/null = desconhecido (usa verificada_em). */
  vigenciaInicio?: CivilDate | null;
  vigenciaFim?: CivilDate | null;
  verificadaEm?: string;
  /** Sobrescreve as diárias (p/ seedar uma versão fictícia em teste); default = Blueprint. */
  diarias?: ReadonlyArray<{ equipamento: string; valorDia: number }>;
  fonte?: string;
}

async function seedRocket(
  db: Pool | PoolClient,
  termo: 'embarque' | 'unico',
  opts: SeedRocketOptions,
): Promise<string> {
  const versao = opts.versao ?? 1;
  const vigenciaInicio = opts.vigenciaInicio ?? null;
  const vigenciaFim = opts.vigenciaFim ?? null;
  const verificadaEm = opts.verificadaEm ?? VERIFICADA_ROCKET;
  const diarias = opts.diarias ?? DIARIAS_ROCKET;
  const fonte = opts.fonte ?? (termo === 'embarque' ? 'Blueprint Cap. 24.1' : 'Blueprint Cap. 24.2 (verificada 24/09/2026)');

  const { rows } = await db.query(
    `INSERT INTO tariff_tables
       (organization_id, tipo, termo_comercial, versao, vigencia_inicio, vigencia_fim,
        qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES ($1, 'rocket_cliente', $2, $3, $4, $5, 'OFICIAL_VALIDADA', 'since_discharge_absolute', $6, $7)
     RETURNING id`,
    [opts.organizationId, termo, versao, vigenciaInicio, vigenciaFim, fonte, verificadaEm],
  );
  const tabelaId: string = rows[0].id;
  for (const d of diarias) {
    await db.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
       VALUES ($1, $2, 1, NULL, $3, $4)`,
      [tabelaId, d.equipamento, d.valorDia, TERMO_ROCKET_MOEDA],
    );
  }
  return tabelaId;
}

/** Tabela Rocket do Termo por Embarque (uma faixa aberta [1,∞) por equipamento). */
export function seedRocketTermoPorEmbarque(db: Pool | PoolClient, opts: SeedRocketOptions): Promise<string> {
  return seedRocket(db, 'embarque', opts);
}

/** Tabela Rocket do Termo Único (mesmos valores hoje, motor/tabela separados). */
export function seedRocketTermoUnico(db: Pool | PoolClient, opts: SeedRocketOptions): Promise<string> {
  return seedRocket(db, 'unico', opts);
}
