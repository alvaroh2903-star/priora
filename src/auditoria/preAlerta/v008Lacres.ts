/**
 * PB-001 — Família V-008 · Lacres (fonte da verdade: MBL) · criticidade Crítica
 *  - V-008.1 Existência do Lacre (por contêiner relacionado)
 *  - V-008.2 Correspondência do Lacre (igualdade estrita; incerto → 👤)
 *  - V-008.3 Unicidade do Lacre (um lacre = um contêiner em TODA a operação)
 *  - V-008.4 Consistência (consolidação)
 * Depende de V-003 (relações). A unicidade varre todos os contêineres.
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { normalizarCodigo } from './normalizacao';
import { cmpCodigo } from './comparadores';
import { ContainerDoc, Evidencia, Operacao, RelacaoContainer, ResultadoFamilia } from './modelo';

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

const incerto = (c: ContainerDoc, campo: string): boolean => (c.leituraIncerta ?? []).includes(campo);
const semLacre = (c: ContainerDoc): boolean => c.lacre == null || c.lacre === '';

export function familiaV008(op: Operacao, relacoes: RelacaoContainer[]): ResultadoFamilia {
  const ev: Evidencia[] = [];

  // V-008.1 Existência + V-008.2 Correspondência (por contêiner relacionado).
  for (const r of relacoes) {
    const val: Evidencia['valores'] = [
      { doc: 'MBL', valor: r.master.lacre ?? '—' },
      { doc: `HBL ${r.houseId}`, valor: r.house.lacre ?? '—' },
    ];
    if (semLacre(r.master) || semLacre(r.house)) {
      const inc = incerto(r.master, 'lacre') || incerto(r.house, 'lacre');
      ev.push(mk('V-008.1', 'Existência do Lacre', inc ? 'ValidacaoHumana' : 'NaoAvaliada', 'Critica', r.houseId, r.numero, val, 'Lacre ausente em um dos documentos.'));
      ev.push(mk('V-008.2', 'Correspondência do Lacre', 'NaoAvaliada', 'Critica', r.houseId, r.numero, val, 'Correspondência não avaliada — existência do lacre não confirmada.'));
      continue;
    }
    ev.push(mk('V-008.1', 'Existência do Lacre', 'Consistente', 'Critica', r.houseId, r.numero, val, 'Lacre presente nos dois documentos.'));
    const cmp = cmpCodigo(r.master.lacre, r.house.lacre, incerto(r.master, 'lacre') || incerto(r.house, 'lacre'));
    ev.push(mk('V-008.2', 'Correspondência do Lacre', cmp.resultado, 'Critica', r.houseId, r.numero, val, cmp.motivo));
  }

  // V-008.3 Unicidade — um lacre não pode estar em mais de um contêiner na operação.
  const porLacre = new Map<string, Set<string>>();
  const registra = (c: ContainerDoc): void => {
    if (semLacre(c) || !c.numero) return;
    const kl = normalizarCodigo(c.lacre);
    const kc = normalizarCodigo(c.numero);
    if (!porLacre.has(kl)) porLacre.set(kl, new Set());
    porLacre.get(kl)!.add(kc);
  };
  if (op.master) op.master.containers.forEach(registra);
  for (const h of op.houses) h.containers.forEach(registra);
  const duplicados = [...porLacre.entries()].filter(([, cs]) => cs.size > 1);
  if (duplicados.length === 0) {
    ev.push(mk('V-008.3', 'Unicidade do Lacre', 'Consistente', 'Critica', null, null, [], 'Todos os lacres são únicos na operação.'));
  } else {
    for (const [lacre, cs] of duplicados) {
      ev.push(mk('V-008.3', 'Unicidade do Lacre', 'Divergencia', 'Critica', null, null, [
        { doc: 'Lacre', valor: lacre },
        { doc: 'Contêineres', valor: [...cs].join(', ') },
      ], `Lacre ${lacre} associado a mais de um contêiner (${[...cs].join(', ')}).`));
    }
  }

  // V-008.4 Consolidação.
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk('V-008.4', 'Consistência dos Lacres', resultado, 'Critica', null, null, [], `Consolidação da Família V-008: ${resultado}.`));

  return { familia: 'V-008', resultado, evidencias: ev };
}
