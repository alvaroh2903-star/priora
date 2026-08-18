/**
 * PB-001 — Família V-012 · NCM (documental) · criticidade Crítica
 *  - V-012.1 Existência dos NCMs
 *  - V-012.2 Correspondência (menor nível de dígitos comum: 4/6/8)
 *  - V-012.4 Consolidação DOCUMENTAL (consolida .1/.2)
 *
 * V-012.3 (Verificação Contextual do Histórico) e a dimensão contextual da
 * V-012.4 pertencem à Fase 2 (ETL/Context Builder). Aqui só a consistência
 * documental. Comparação: conjunto do MBL × união dos Houses (ordem irrelevante).
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { Evidencia, Operacao, ResultadoFamilia } from './modelo';

const FONTE = 'MBL';

function mk(
  subvalidacao: string,
  campo: string,
  resultado: ResultadoValidacao,
  criticidade: Criticidade,
  valores: Evidencia['valores'],
  motivo: string,
): Evidencia {
  return { subvalidacao, campo, resultado, criticidade, fonteDaVerdade: FONTE, houseId: null, container: null, valores, motivo };
}

/** Só dígitos. */
const soDigitos = (s: string): string => s.replace(/\D/g, '');

/** Compatível quando um é prefixo do outro no menor nível comum (≥4 dígitos). */
export function ncmCompativeis(a: string, b: string): boolean {
  const da = soDigitos(a);
  const db = soDigitos(b);
  const l = Math.min(da.length, db.length);
  if (l < 4) return false;
  return da.slice(0, l) === db.slice(0, l);
}

/** Conjunto de NCMs (só dígitos, sem vazios/duplicados). */
function conjunto(codigos: string[]): string[] {
  const out = new Set<string>();
  for (const c of codigos) {
    const d = soDigitos(c || '');
    if (d) out.add(d);
  }
  return [...out];
}

export function familiaV012(op: Operacao): ResultadoFamilia {
  const ev: Evidencia[] = [];
  const master = op.master;
  if (!master || !master.legivel) {
    ev.push(mk('V-012.1', 'Existência dos NCMs', 'NaoAvaliada', 'Critica', [], 'MBL ausente ou ilegível — família não avaliada.'));
    return { familia: 'V-012', resultado: 'NaoAvaliada', evidencias: ev };
  }

  const ncmMaster = conjunto(master.ncm);
  const ncmHouses = conjunto(op.houses.flatMap((h) => h.ncm));
  const val: Evidencia['valores'] = [
    { doc: 'MBL', valor: ncmMaster.join(', ') || '—' },
    { doc: 'Houses', valor: ncmHouses.join(', ') || '—' },
  ];

  // V-012.1 Existência.
  if (ncmMaster.length === 0 || ncmHouses.length === 0) {
    ev.push(mk('V-012.1', 'Existência dos NCMs', 'NaoAvaliada', 'Critica', val, 'Nenhum NCM localizado em um dos lados — comparação não avaliada.'));
    ev.push(mk('V-012.2', 'Correspondência dos NCMs', 'NaoAvaliada', 'Critica', val, 'Correspondência não avaliada — existência não confirmada.'));
    const r0 = consolidar(ev.map((e) => e.resultado));
    ev.push(mk('V-012.4', 'Consistência do NCM (documental)', r0, 'Critica', [], `Consolidação documental da Família V-012: ${r0}.`));
    return { familia: 'V-012', resultado: r0, evidencias: ev };
  }
  ev.push(mk('V-012.1', 'Existência dos NCMs', 'Consistente', 'Critica', val, 'Ambos os lados apresentam ao menos um NCM.'));

  // V-012.2 Correspondência (menor nível de dígitos comum; ordem irrelevante).
  const semParNoHouse = ncmMaster.filter((a) => !ncmHouses.some((b) => ncmCompativeis(a, b)));
  const semParNoMaster = ncmHouses.filter((b) => !ncmMaster.some((a) => ncmCompativeis(a, b)));
  if (semParNoHouse.length === 0 && semParNoMaster.length === 0) {
    ev.push(mk('V-012.2', 'Correspondência dos NCMs', 'Consistente', 'Critica', val, 'Todos os NCMs correspondem (no menor nível de dígitos comum).'));
  } else {
    const partes: string[] = [];
    if (semParNoHouse.length) partes.push(`ausentes nos Houses: ${semParNoHouse.join(', ')}`);
    if (semParNoMaster.length) partes.push(`adicionais nos Houses: ${semParNoMaster.join(', ')}`);
    ev.push(mk('V-012.2', 'Correspondência dos NCMs', 'Divergencia', 'Critica', val, `Divergência de NCM — ${partes.join('; ')}.`));
  }

  // V-012.4 Consolidação documental.
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk('V-012.4', 'Consistência do NCM (documental)', resultado, 'Critica', [], `Consolidação documental da Família V-012: ${resultado}. (V-012.3 contextual: Fase 2.)`));

  return { familia: 'V-012', resultado, evidencias: ev };
}
