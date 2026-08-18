/** PB-001 — Família V-005 · Peso Bruto (zero tolerância). Usa o motor numérico. */
import { Operacao, RelacaoContainer, ResultadoFamilia } from './modelo';
import { familiaNumericaPorContainer } from './familiaNumerica';

export function familiaV005(op: Operacao, relacoes: RelacaoContainer[]): ResultadoFamilia {
  return familiaNumericaPorContainer(op, relacoes, {
    familia: 'V-005',
    rotulo: 'Peso Bruto',
    unidade: 'kg',
    valorContainer: (c) => c.pesoBrutoKg,
    valorTotal: (d) => d.pesoBrutoTotalKg,
    campoIncerto: 'pesoBrutoKg',
  });
}
