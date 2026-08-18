/**
 * PB-001 — Família V-005 · Peso Bruto (fonte da verdade: MBL)
 *
 * Q6: ZERO tolerância. Qualquer diferença após normalização numérica =
 * divergência. Sem conversão de unidade (KG≠LB). Depende de V-003 (relações).
 *  - V-005.1 Peso Bruto por Contêiner
 *  - V-005.2 Peso Bruto Total (soma dos Houses = total do Master)
 *  - V-005.3 Consistência (consolidação)
 *
 * V-006 (Peso Líquido) e V-007 (Cubagem) seguem exatamente este molde.
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { numeroIgual } from './normalizacao';
import { cmpNumeroExato } from './comparadores';
import { Evidencia, Operacao, RelacaoContainer, ResultadoFamilia } from './modelo';

const FONTE = 'MBL';

function mk(
  subvalidacao: string,
  campo: string,
  resultado: ResultadoValidacao,
  criticidade: Criticidade,
  houseId: string | null,
  container: string | null,
  valores: Evidencia['valores'],
  motivo: string,
): Evidencia {
  return { subvalidacao, campo, resultado, criticidade, fonteDaVerdade: FONTE, houseId, container, valores, motivo };
}

const fmt = (n: number | null, u: string): string => (n == null ? '—' : `${n} ${u}`.trim());

export function familiaV005(op: Operacao, relacoes: RelacaoContainer[]): ResultadoFamilia {
  const ev: Evidencia[] = [];

  // V-005.1 — Peso Bruto por Contêiner
  for (const r of relacoes) {
    const incerto = (r.master.leituraIncerta ?? []).includes('pesoBrutoKg') || (r.house.leituraIncerta ?? []).includes('pesoBrutoKg');
    const cmp = cmpNumeroExato(r.master.pesoBrutoKg, r.house.pesoBrutoKg, 'kg', incerto);
    ev.push(mk('V-005.1', 'Peso Bruto (contêiner)', cmp.resultado, 'Alta', r.houseId, r.numero, [
      { doc: 'MBL', valor: fmt(r.master.pesoBrutoKg, 'kg') },
      { doc: `HBL ${r.houseId}`, valor: fmt(r.house.pesoBrutoKg, 'kg') },
    ], cmp.motivo));
  }

  // V-005.2 — Peso Bruto Total (soma dos Houses = total do Master)
  const totalMaster = op.master?.pesoBrutoTotalKg ?? null;
  const totaisHouses = op.houses.map((h) => h.pesoBrutoTotalKg);
  const somaHouses = totaisHouses.every((v) => v != null)
    ? (totaisHouses as number[]).reduce((a, b) => a + b, 0)
    : null;
  const valoresTotal: Evidencia['valores'] = [
    { doc: 'MBL', valor: fmt(totalMaster, 'kg') },
    { doc: 'Σ Houses', valor: fmt(somaHouses, 'kg') },
  ];
  if (totalMaster == null || somaHouses == null) {
    ev.push(mk('V-005.2', 'Peso Bruto Total', 'NaoAvaliada', 'Alta', null, null, valoresTotal, 'Peso total ausente no MBL ou em algum House.'));
  } else {
    const igual = numeroIgual(totalMaster, somaHouses);
    ev.push(mk('V-005.2', 'Peso Bruto Total', igual ? 'Consistente' : 'Divergencia', 'Alta', null, null, valoresTotal,
      igual
        ? `Soma dos Houses corresponde ao total do Master (${totalMaster} kg).`
        : `Divergência: Master ${totalMaster} kg × Σ Houses ${somaHouses} kg (sem tolerância).`));
  }

  // V-005.3 — Consistência (consolidação da família)
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk('V-005.3', 'Consistência do Peso Bruto', resultado, 'Critica', null, null, [], `Consolidação da Família V-005: ${resultado}.`));

  return { familia: 'V-005', resultado, evidencias: ev };
}
