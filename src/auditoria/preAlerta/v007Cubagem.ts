/** PB-001 — Família V-007 · Cubagem/CBM (zero tolerância). Usa o motor numérico. */
import { Operacao, RelacaoContainer, ResultadoFamilia } from './modelo';
import { familiaNumericaPorContainer } from './familiaNumerica';

export function familiaV007(op: Operacao, relacoes: RelacaoContainer[]): ResultadoFamilia {
  return familiaNumericaPorContainer(op, relacoes, {
    familia: 'V-007',
    rotulo: 'Cubagem',
    unidade: 'm³',
    valorContainer: (c) => c.cubagemM3,
    valorTotal: (d) => d.cubagemTotalM3,
    campoIncerto: 'cubagemM3',
  });
}
