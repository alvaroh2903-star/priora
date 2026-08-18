/**
 * PB-001 — Família V-004 · Volumes da Carga (fonte da verdade: MBL)
 *  - V-004.1 Quantidade de Volumes (total; multi-House = soma dos Houses)
 *  - V-004.2 Tipo de Volume (comparação LITERAL no v1 — Q2, sem tabela de equivalência)
 *  - V-004.3 Consistência (consolidação)
 * Nível do conhecimento (não por contêiner). Depende de V-003 (agrupamento).
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { numeroIgual } from './normalizacao';
import { cmpTextoLiteral } from './comparadores';
import { Evidencia, Operacao, ResultadoFamilia } from './modelo';

const FONTE = 'MBL';
const fmt = (n: number | null): string => (n == null ? '—' : String(n));

function mk(
  subvalidacao: string,
  campo: string,
  resultado: ResultadoValidacao,
  criticidade: Criticidade,
  houseId: string | null,
  valores: Evidencia['valores'],
  motivo: string,
): Evidencia {
  return { subvalidacao, campo, resultado, criticidade, fonteDaVerdade: FONTE, houseId, container: null, valores, motivo };
}

export function familiaV004(op: Operacao): ResultadoFamilia {
  const ev: Evidencia[] = [];
  const master = op.master;
  if (!master || !master.legivel) {
    ev.push(mk('V-004.1', 'Quantidade de Volumes', 'NaoAvaliada', 'Alta', null, [], 'MBL ausente ou ilegível — família não avaliada.'));
    return { familia: 'V-004', resultado: 'NaoAvaliada', evidencias: ev };
  }

  // V-004.1 — Quantidade (soma dos Houses = total do Master); sem tolerância.
  const totalM = master.qtdVolumesTotal;
  const totais = op.houses.map((h) => h.qtdVolumesTotal);
  const soma = totais.every((v) => v != null) ? (totais as number[]).reduce((a, b) => a + b, 0) : null;
  const val1: Evidencia['valores'] = [
    { doc: 'MBL', valor: fmt(totalM) },
    { doc: 'Σ Houses', valor: fmt(soma) },
  ];
  if (totalM == null || soma == null) {
    ev.push(mk('V-004.1', 'Quantidade de Volumes', 'NaoAvaliada', 'Alta', null, val1, 'Quantidade de volumes ausente no MBL ou em algum House.'));
  } else {
    const igual = numeroIgual(totalM, soma);
    ev.push(mk('V-004.1', 'Quantidade de Volumes', igual ? 'Consistente' : 'Divergencia', 'Alta', null, val1,
      igual ? `Quantidade coincide (${totalM}).` : `Divergência na quantidade: Master ${totalM} × Σ Houses ${soma}.`));
  }

  // V-004.2 — Tipo de Volume (literal, por House contra o Master).
  for (const h of op.houses) {
    const inc = (master.leituraIncerta ?? []).includes('tipoVolume') || (h.leituraIncerta ?? []).includes('tipoVolume');
    const cmp = cmpTextoLiteral(master.tipoVolume, h.tipoVolume, inc);
    ev.push(mk('V-004.2', 'Tipo de Volume', cmp.resultado, 'Media', h.nome, [
      { doc: 'MBL', valor: master.tipoVolume ?? '—' },
      { doc: `HBL ${h.nome}`, valor: h.tipoVolume ?? '—' },
    ], cmp.motivo));
  }

  // V-004.3 — Consistência (consolidação).
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk('V-004.3', 'Consistência dos Volumes', resultado, 'Alta', null, [], `Consolidação da Família V-004: ${resultado}.`));

  return { familia: 'V-004', resultado, evidencias: ev };
}
