/**
 * PB-001 — Motor de Família Numérica por Contêiner (fonte da verdade: MBL)
 *
 * Reúso (blueprint 4.8): Peso Bruto (V-005), Peso Líquido (V-006) e Cubagem
 * (V-007) são o MESMO padrão — muda só o campo e a unidade. Q6: ZERO tolerância.
 *  - .1 valor por contêiner (sobre as relações da V-003)
 *  - .2 total: soma dos Houses = total do Master
 *  - .3 consolidação da família
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { numeroIgual } from './normalizacao';
import { cmpNumeroExato } from './comparadores';
import {
  ContainerDoc,
  DocPreAlerta,
  Evidencia,
  Operacao,
  RelacaoContainer,
  ResultadoFamilia,
} from './modelo';

export interface CfgFamiliaNumerica {
  familia: string; // ex.: "V-005"
  rotulo: string; // ex.: "Peso Bruto"
  unidade: string; // ex.: "kg"
  valorContainer: (c: ContainerDoc) => number | null;
  valorTotal: (d: DocPreAlerta) => number | null;
  campoIncerto: string; // nome do campo p/ checar leitura incerta (ex.: "pesoBrutoKg")
}

const FONTE = 'MBL';
const fmt = (n: number | null, u: string): string => (n == null ? '—' : `${n} ${u}`.trim());

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

export function familiaNumericaPorContainer(
  op: Operacao,
  relacoes: RelacaoContainer[],
  cfg: CfgFamiliaNumerica,
): ResultadoFamilia {
  const ev: Evidencia[] = [];

  // .1 — Valor por contêiner
  for (const r of relacoes) {
    const inc =
      (r.master.leituraIncerta ?? []).includes(cfg.campoIncerto) ||
      (r.house.leituraIncerta ?? []).includes(cfg.campoIncerto);
    const vm = cfg.valorContainer(r.master);
    const vh = cfg.valorContainer(r.house);
    const cmp = cmpNumeroExato(vm, vh, cfg.unidade, inc);
    ev.push(mk(`${cfg.familia}.1`, `${cfg.rotulo} (contêiner)`, cmp.resultado, 'Alta', r.houseId, r.numero, [
      { doc: 'MBL', valor: fmt(vm, cfg.unidade) },
      { doc: `HBL ${r.houseId}`, valor: fmt(vh, cfg.unidade) },
    ], cmp.motivo));
  }

  // .2 — Total: soma dos Houses = total do Master
  const totalMaster = op.master ? cfg.valorTotal(op.master) : null;
  const totais = op.houses.map((h) => cfg.valorTotal(h));
  const soma = totais.every((v) => v != null)
    ? (totais as number[]).reduce((a, b) => a + b, 0)
    : null;
  const valTotal: Evidencia['valores'] = [
    { doc: 'MBL', valor: fmt(totalMaster, cfg.unidade) },
    { doc: 'Σ Houses', valor: fmt(soma, cfg.unidade) },
  ];
  if (totalMaster == null || soma == null) {
    ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, 'NaoAvaliada', 'Alta', null, null, valTotal, `${cfg.rotulo} total ausente no MBL ou em algum House.`));
  } else {
    const igual = numeroIgual(totalMaster, soma);
    ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, igual ? 'Consistente' : 'Divergencia', 'Alta', null, null, valTotal,
      igual
        ? `Soma dos Houses corresponde ao total do Master (${totalMaster} ${cfg.unidade}).`
        : `Divergência: Master ${totalMaster} × Σ Houses ${soma} ${cfg.unidade} (sem tolerância).`));
  }

  // .3 — Consolidação
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk(`${cfg.familia}.3`, `Consistência de ${cfg.rotulo}`, resultado, 'Critica', null, null, [], `Consolidação da Família ${cfg.familia}: ${resultado}.`));

  return { familia: cfg.familia, resultado, evidencias: ev };
}
