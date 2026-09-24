import { Pool, PoolClient } from 'pg';
import { DayCountBasis, QualidadeFonte } from '../types';

/**
 * As tabelas de armador do Blueprint (Cap. 24.3.1), valores LITERAIS. São
 * tabelas PÚBLICAS (organization_id = NULL) usadas para ESTIMAR a exposição da
 * Rocket — nunca custo confirmado. Vigência desconhecida (revisão 8):
 * `vigencia_inicio = NULL`, `verificada_em` = data de verificação.
 *
 * Regras respeitadas ao transcrever:
 *  - Agrupamento de equipamento preservado EXATAMENTE como o Blueprint
 *    (ex.: CMA "40/45 Dry" é uma chave só; Maersk "20/40 Reefer" idem). Não
 *    dividir nem juntar classes.
 *  - Hapag-Lloyd é a exceção aprovada: `EXCESS_OVER_FREE_TIME`. Todas as demais
 *    `SINCE_DISCHARGE_ABSOLUTE`.
 *  - "FT padrão" da fonte é informativo e NÃO é cadastrado: o cálculo usa o
 *    Master FT real do processo.
 *  - Faixa/equipamento sem limites cronológicos definidos (Especial de Yang
 *    Ming / COSCO / ZIM) NÃO é cadastrada — o motor devolve UNAVAILABLE em vez
 *    de inventar limites.
 *  - PIL é PROVISORIA_INCOMPLETA (→ ESTIMATED_PROVISIONAL); as demais são
 *    estimativas públicas (→ ESTIMATED). Nenhuma vira CONFIRMED por si só.
 */

export const VERIFICADA_ARMADOR = '2026-09-24T00:00:00Z';

export interface FaixaSeed {
  equipamento: string;
  diaInicial: number;
  diaFinal: number | null;
  valorDia: number;
}

export interface ArmadorTabelaSeed {
  armadorNome: string;
  armadorCodigo: string;
  dayCountBasis: DayCountBasis;
  qualidadeFonte: QualidadeFonte;
  moeda: string;
  faixas: FaixaSeed[];
}

const f = (equipamento: string, diaInicial: number, diaFinal: number | null, valorDia: number): FaixaSeed => ({
  equipamento, diaInicial, diaFinal, valorDia,
});

export const TABELAS_ARMADOR: readonly ArmadorTabelaSeed[] = [
  {
    armadorNome: 'MSC', armadorCodigo: 'MSC', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 7, 9, 55), f('20DRY', 10, null, 110),
      f('40DRYHC', 7, 9, 95), f('40DRYHC', 10, null, 190),
      f('45DRY', 7, 9, 109), f('45DRY', 10, null, 218),
      f('20REEFER', 3, 5, 190), f('20REEFER', 6, null, 290),
      f('40REEFER', 3, 5, 250), f('40REEFER', 6, null, 420),
      f('45REEFER', 3, 5, 250), f('45REEFER', 6, null, 420),
    ],
  },
  {
    armadorNome: 'Hapag-Lloyd', armadorCodigo: 'HAPAG', dayCountBasis: 'excess_over_free_time', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 1, 16, 113), f('20DRY', 17, null, 160),
      f('40DRYHC', 1, 16, 218), f('40DRYHC', 17, null, 360),
      f('20REEFER', 1, 17, 240), f('20REEFER', 18, null, 350),
      f('40REEFERHC', 1, 17, 430), f('40REEFERHC', 18, null, 600),
      f('20ESPECIAL', 1, 16, 115), f('20ESPECIAL', 17, null, 190),
      f('40ESPECIAL', 1, 16, 225), f('40ESPECIAL', 17, null, 380),
    ],
  },
  {
    armadorNome: 'CMA CGM', armadorCodigo: 'CMA', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 60), f('20DRY', 15, null, 110),
      f('40_45DRY', 8, 14, 110), f('40_45DRY', 15, null, 185),
      f('20REEFER', 4, 9, 160), f('20REEFER', 10, null, 215),
      f('40_45REEFER', 4, 9, 285), f('40_45REEFER', 10, null, 425),
      f('20ESPECIAL', 6, 11, 105), f('20ESPECIAL', 12, null, 145),
      f('40_45ESPECIAL', 6, 11, 155), f('40_45ESPECIAL', 12, null, 215),
    ],
  },
  {
    armadorNome: 'Maersk', armadorCodigo: 'MAERSK', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 6, 10, 55), f('20DRY', 11, 14, 100), f('20DRY', 15, 21, 110), f('20DRY', 22, null, 120),
      f('40DRYHC', 6, 10, 90), f('40DRYHC', 11, 14, 175), f('40DRYHC', 15, 21, 200), f('40DRYHC', 22, null, 220),
      f('20_40REEFER', 6, 10, 200), f('20_40REEFER', 11, 15, 295), f('20_40REEFER', 16, 21, 395), f('20_40REEFER', 22, null, 400),
      f('20_40ESPECIAL', 6, 10, 115), f('20_40ESPECIAL', 11, 15, 155), f('20_40ESPECIAL', 16, 21, 205), f('20_40ESPECIAL', 22, null, 210),
    ],
  },
  {
    armadorNome: 'ONE', armadorCodigo: 'ONE', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, 21, 75), f('20DRY', 22, null, 115),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, 21, 140), f('40DRYHC', 22, null, 210),
      f('20REEFER', 4, 7, 165), f('20REEFER', 8, 14, 225), f('20REEFER', 15, null, 325),
      f('40REEFER', 4, 7, 270), f('40REEFER', 8, 14, 380), f('40REEFER', 15, null, 520),
      f('20ESPECIAL', 6, 12, 110), f('20ESPECIAL', 13, null, 170),
      f('40ESPECIAL', 6, 12, 160), f('40ESPECIAL', 13, null, 270),
    ],
  },
  {
    armadorNome: 'PIL', armadorCodigo: 'PIL', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PROVISORIA_INCOMPLETA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 50), f('20DRY', 15, 21, 67.5), f('20DRY', 22, null, 107.5),
      f('40DRYHC', 8, 14, 92.5), f('40DRYHC', 15, 21, 125), f('40DRYHC', 22, null, 205),
      f('20REEFER', 4, 7, 157.5), f('20REEFER', 8, null, 220),
      f('40REEFER', 4, 7, 260), f('40REEFER', 8, null, 380),
    ],
  },
  {
    // Especial: só "faixa inicial" sem limites → NÃO cadastrado → UNAVAILABLE.
    armadorNome: 'Yang Ming', armadorCodigo: 'YANGMING', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, null, 90),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, null, 170),
      f('20REEFER', 4, 7, 160), f('20REEFER', 8, null, 260),
      f('40REEFERHC', 4, 7, 260), f('40REEFERHC', 8, null, 410),
    ],
  },
  {
    armadorNome: 'HMM', armadorCodigo: 'HMM', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, 21, 80), f('20DRY', 22, null, 120),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, 21, 145), f('40DRYHC', 22, null, 220),
      f('20REEFER', 4, 7, 165), f('20REEFER', 8, null, 270),
      f('40REEFER', 4, 7, 275), f('40REEFER', 8, null, 420),
    ],
  },
  {
    armadorNome: 'Evergreen', armadorCodigo: 'EVERGREEN', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, 21, 80), f('20DRY', 22, null, 120),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, 21, 150), f('40DRYHC', 22, null, 220),
      f('20REEFER', 4, 7, 165), f('20REEFER', 8, null, 270),
      f('40REEFER', 4, 7, 275), f('40REEFER', 8, null, 425),
    ],
  },
  {
    // Especial incompleto → não cadastrado → UNAVAILABLE.
    armadorNome: 'COSCO', armadorCodigo: 'COSCO', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, 21, 75), f('20DRY', 22, null, 115),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, 21, 140), f('40DRYHC', 22, null, 210),
      f('20REEFER', 4, 7, 165), f('20REEFER', 8, null, 265),
      f('40REEFER', 4, 7, 270), f('40REEFER', 8, null, 425),
    ],
  },
  {
    armadorNome: 'OOCL', armadorCodigo: 'OOCL', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 11, 17, 60), f('20DRY', 18, null, 90),
      f('40DRYHC', 11, 17, 110), f('40DRYHC', 18, null, 160),
      f('20REEFER', 11, 19, 120), f('20REEFER', 20, null, 140),
      f('40REEFER', 11, 19, 240), f('40REEFER', 20, null, 280),
      f('20ESPECIAL', 7, 13, 65), f('20ESPECIAL', 14, null, 100),
      f('40ESPECIAL', 7, 13, 130), f('40ESPECIAL', 14, null, 200),
    ],
  },
  {
    // Especial incompleto → não cadastrado → UNAVAILABLE.
    armadorNome: 'ZIM', armadorCodigo: 'ZIM', dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', moeda: 'USD',
    faixas: [
      f('20DRY', 8, 14, 55), f('20DRY', 15, 21, 75), f('20DRY', 22, null, 115),
      f('40DRYHC', 8, 14, 95), f('40DRYHC', 15, 21, 140), f('40DRYHC', 22, null, 210),
      f('20REEFER', 4, 7, 165), f('20REEFER', 8, null, 265),
      f('40REEFER', 4, 7, 270), f('40REEFER', 8, null, 425),
    ],
  },
];

/**
 * Cadastra todas as tabelas de armador (idempotente por armador+versão).
 * Retorna um mapa codigo→tabelaId.
 */
export async function seedArmadorTables(
  db: Pool | PoolClient,
  opts: { verificadaEm?: string } = {},
): Promise<Map<string, string>> {
  const verificadaEm = opts.verificadaEm ?? VERIFICADA_ARMADOR;
  const ids = new Map<string, string>();
  for (const t of TABELAS_ARMADOR) {
    await db.query(
      `INSERT INTO armadores (nome, codigo_interno) VALUES ($1, $2)
       ON CONFLICT (codigo_interno) DO NOTHING`,
      [t.armadorNome, t.armadorCodigo],
    );
    const { rows: [arm] } = await db.query(`SELECT id FROM armadores WHERE codigo_interno = $1`, [t.armadorCodigo]);
    const { rows: [tab] } = await db.query(
      `INSERT INTO tariff_tables
         (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES (NULL, 'armador', $1, 1, NULL, $2, $3, $4, $5)
       RETURNING id`,
      [arm.id, t.qualidadeFonte, t.dayCountBasis, `Blueprint Cap. 24.3.1 (${t.armadorNome})`, verificadaEm],
    );
    for (const fx of t.faixas) {
      await db.query(
        `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tab.id, fx.equipamento, fx.diaInicial, fx.diaFinal, fx.valorDia, t.moeda],
      );
    }
    ids.set(t.armadorCodigo, tab.id);
  }
  return ids;
}
