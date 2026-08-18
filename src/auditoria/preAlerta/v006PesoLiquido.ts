/** PB-001 — Família V-006 · Peso Líquido (zero tolerância). Usa o motor numérico. */
import { Operacao, RelacaoContainer, ResultadoFamilia } from './modelo';
import { familiaNumericaPorContainer } from './familiaNumerica';

export function familiaV006(op: Operacao, relacoes: RelacaoContainer[]): ResultadoFamilia {
  return familiaNumericaPorContainer(op, relacoes, {
    familia: 'V-006',
    rotulo: 'Peso Líquido',
    unidade: 'kg',
    valorContainer: (c) => c.pesoLiquidoKg,
    valorTotal: (d) => d.pesoLiquidoTotalKg,
    campoIncerto: 'pesoLiquidoKg',
  });
}
