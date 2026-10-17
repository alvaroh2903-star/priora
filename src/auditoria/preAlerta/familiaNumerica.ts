/**
 * PB-001 — Motor de Família Numérica por Contêiner (fonte da verdade: MBL)
 *
 * Reúso (blueprint 4.8): Peso Bruto (V-005), Peso Líquido (V-006) e Cubagem
 * (V-007) são o MESMO padrão — muda só o campo e a unidade. Q6: ZERO tolerância.
 *  - .1 valor por contêiner (sobre as relações da V-003)
 *  - .2 total: soma dos Houses = total do Master
 *  - .3 consolidação da família
 *
 * UNIDADES (regra do Blueprint: a Priora NÃO converte — KG ≠ LB, CBM ≠ FT³):
 * documentos do parser determinístico trazem `medidas` (valor + unidade). Com
 * elas: mesma unidade → comparação numérica (zero tolerância, inalterada);
 * unidades diferentes → Divergência; unidade ausente/não aprovada ou leitura
 * incerta → Validação Humana. Documentos SEM `medidas` (pipeline legado) seguem
 * exatamente o comportamento anterior.
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { numeroIgual } from './normalizacao';
import { cmpNumeroExato, Comparacao } from './comparadores';
import { rotuloUnidade, UnidadeMedida } from '../unidades';
import {
  ContainerDoc,
  DocPreAlerta,
  Evidencia,
  MedidaDoc,
  Operacao,
  RelacaoContainer,
  ResultadoFamilia,
} from './modelo';

export interface CfgFamiliaNumerica {
  familia: string; // ex.: "V-005"
  rotulo: string; // ex.: "Peso Bruto"
  unidade: string; // ex.: "kg" (exibição no caminho legado)
  valorContainer: (c: ContainerDoc) => number | null;
  valorTotal: (d: DocPreAlerta) => number | null;
  campoIncerto: string; // nome do campo p/ checar leitura incerta (ex.: "pesoBrutoKg")
  /** Medida COM unidade do contêiner (quando o documento traz `medidas`). */
  medidaContainer?: (c: ContainerDoc) => MedidaDoc | null;
  /** Medida COM unidade do total (quando o documento traz `medidas`). */
  medidaTotal?: (d: DocPreAlerta) => MedidaDoc | null;
  /** Nome do campo do TOTAL em `leituraIncerta` do documento (ex.: "pesoBrutoTotalKg"). */
  campoIncertoTotal?: string;
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

/** Um lado da comparação COM unidade. */
interface Lado {
  presente: boolean; // há leitura (certa ou incerta)
  valor: number | null;
  unidade: UnidadeMedida | null;
  incerta: boolean;
}

function lado(m: MedidaDoc | null | undefined, legado: number | null, temMedidas: boolean, incertoCampo: boolean): Lado {
  if (temMedidas) {
    if (!m) return { presente: false, valor: null, unidade: null, incerta: incertoCampo };
    return { presente: m.valor != null || !!m.incerta, valor: m.valor, unidade: m.unidade, incerta: !!m.incerta || incertoCampo };
  }
  // Documento sem `medidas` numa comparação com unidade: valor SEM unidade conhecida.
  return { presente: legado != null, valor: legado, unidade: null, incerta: incertoCampo };
}

const fmtLado = (l: Lado): string => (l.presente ? `${l.valor ?? '?'} ${rotuloUnidade(l.unidade)}` : '—');

/** Comparação COM unidade (sem conversão). */
function cmpComUnidade(a: Lado, b: Lado): Comparacao {
  if (!a.presente || !b.presente) {
    return { resultado: 'NaoAvaliada', motivo: 'Valor numérico ausente em um dos documentos.' };
  }
  if (a.incerta || b.incerta) {
    return { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta — confirmar valor no documento.' };
  }
  if (!a.unidade || !b.unidade) {
    return { resultado: 'ValidacaoHumana', motivo: 'Unidade de medida não identificada — confirmar no documento (não é presumida).' };
  }
  if (a.unidade !== b.unidade) {
    return {
      resultado: 'Divergencia',
      motivo: `Unidades diferentes: ${fmtLado(a)} × ${fmtLado(b)} — a Priora não converte unidades (PB-001).`,
    };
  }
  return cmpNumeroExato(a.valor, b.valor, rotuloUnidade(a.unidade));
}

const incertoEm = (lista: string[] | undefined, campo: string | undefined): boolean =>
  !!campo && (lista ?? []).includes(campo);

export function familiaNumericaPorContainer(
  op: Operacao,
  relacoes: RelacaoContainer[],
  cfg: CfgFamiliaNumerica,
): ResultadoFamilia {
  const ev: Evidencia[] = [];

  // .1 — Valor por contêiner
  for (const r of relacoes) {
    const incM = (r.master.leituraIncerta ?? []).includes(cfg.campoIncerto);
    const incH = (r.house.leituraIncerta ?? []).includes(cfg.campoIncerto);
    const inc = incM || incH;
    const vm = cfg.valorContainer(r.master);
    const vh = cfg.valorContainer(r.house);
    const comUnidade = !!cfg.medidaContainer && (r.master.medidas !== undefined || r.house.medidas !== undefined);
    if (!comUnidade) {
      // Caminho LEGADO (documento sem unidade explícita) — comportamento inalterado.
      const cmp = cmpNumeroExato(vm, vh, cfg.unidade, inc);
      ev.push(mk(`${cfg.familia}.1`, `${cfg.rotulo} (contêiner)`, cmp.resultado, 'Alta', r.houseId, r.numero, [
        { doc: 'MBL', valor: fmt(vm, cfg.unidade) },
        { doc: `HBL ${r.houseId}`, valor: fmt(vh, cfg.unidade) },
      ], cmp.motivo));
      continue;
    }
    const lm = lado(r.master.medidas ? cfg.medidaContainer!(r.master) : null, vm, r.master.medidas !== undefined, incM);
    const lh = lado(r.house.medidas ? cfg.medidaContainer!(r.house) : null, vh, r.house.medidas !== undefined, incH);
    const cmp = cmpComUnidade(lm, lh);
    ev.push(mk(`${cfg.familia}.1`, `${cfg.rotulo} (contêiner)`, cmp.resultado, 'Alta', r.houseId, r.numero, [
      { doc: 'MBL', valor: fmtLado(lm) },
      { doc: `HBL ${r.houseId}`, valor: fmtLado(lh) },
    ], cmp.motivo));
  }

  // .2 — Total: soma dos Houses = total do Master
  const comUnidadeTotal =
    !!cfg.medidaTotal && (op.master?.medidas !== undefined || op.houses.some((h) => h.medidas !== undefined));
  const incTotal = (d: DocPreAlerta): boolean => incertoEm(d.leituraIncerta, cfg.campoIncertoTotal);

  if (!comUnidadeTotal) {
    const totalMaster = op.master ? cfg.valorTotal(op.master) : null;
    const totais = op.houses.map((h) => cfg.valorTotal(h));
    // Sem Houses não há soma a comparar (evita "Σ Houses = 0" enganoso quando a
    // operação vem sem HBL). Só soma quando há House(s) e todos têm o valor.
    const soma =
      op.houses.length > 0 && totais.every((v) => v != null)
        ? (totais as number[]).reduce((a, b) => a + b, 0)
        : null;
    const valTotal: Evidencia['valores'] = [
      { doc: 'MBL', valor: fmt(totalMaster, cfg.unidade) },
      { doc: 'Σ Houses', valor: fmt(soma, cfg.unidade) },
    ];
    if (totalMaster == null || soma == null) {
      ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, 'NaoAvaliada', 'Alta', null, null, valTotal, `${cfg.rotulo} total ausente no MBL ou em algum House.`));
    } else if ((op.master && incTotal(op.master)) || op.houses.some(incTotal)) {
      ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, 'ValidacaoHumana', 'Alta', null, null, valTotal, 'Leitura incerta do total — confirmar valor no documento.'));
    } else {
      const igual = numeroIgual(totalMaster, soma);
      ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, igual ? 'Consistente' : 'Divergencia', 'Alta', null, null, valTotal,
        igual
          ? `Soma dos Houses corresponde ao total do Master (${totalMaster} ${cfg.unidade}).`
          : `Divergência: Master ${totalMaster} × Σ Houses ${soma} ${cfg.unidade} (sem tolerância).`));
    }
  } else {
    const ladoTotal = (d: DocPreAlerta): Lado =>
      lado(d.medidas ? cfg.medidaTotal!(d) : null, cfg.valorTotal(d), d.medidas !== undefined, incTotal(d));
    const lm: Lado = op.master ? ladoTotal(op.master) : { presente: false, valor: null, unidade: null, incerta: false };
    const lhs = op.houses.map(ladoTotal);
    const somaVal =
      lhs.length > 0 && lhs.every((l) => l.presente && !l.incerta && l.valor != null)
        ? lhs.reduce((a, l) => a + (l.valor as number), 0)
        : null;
    const unidadesH = Array.from(new Set(lhs.map((l) => l.unidade)));
    const fmtSoma = somaVal == null ? '—' : unidadesH.length === 1 ? `${somaVal} ${rotuloUnidade(unidadesH[0])}` : `${somaVal} (unidades mistas)`;
    const valTotal: Evidencia['valores'] = [
      { doc: 'MBL', valor: fmtLado(lm) },
      { doc: 'Σ Houses', valor: fmtSoma },
    ];
    let res: Comparacao;
    if (!lm.presente || lhs.length === 0 || lhs.some((l) => !l.presente)) {
      res = { resultado: 'NaoAvaliada', motivo: `${cfg.rotulo} total ausente no MBL ou em algum House.` };
    } else if (lm.incerta || lhs.some((l) => l.incerta)) {
      res = { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta do total — confirmar valor no documento.' };
    } else if (!lm.unidade || lhs.some((l) => !l.unidade)) {
      res = { resultado: 'ValidacaoHumana', motivo: 'Unidade de medida do total não identificada — confirmar no documento (não é presumida).' };
    } else if (lhs.some((l) => l.unidade !== lm.unidade)) {
      res = {
        resultado: 'Divergencia',
        motivo: `Unidades diferentes entre Master (${rotuloUnidade(lm.unidade)}) e Houses (${unidadesH.map(rotuloUnidade).join(', ')}) — a Priora não converte unidades (PB-001).`,
      };
    } else {
      const u = rotuloUnidade(lm.unidade);
      const igual = numeroIgual(lm.valor as number, somaVal as number);
      res = igual
        ? { resultado: 'Consistente', motivo: `Soma dos Houses corresponde ao total do Master (${lm.valor} ${u}).` }
        : { resultado: 'Divergencia', motivo: `Divergência: Master ${lm.valor} × Σ Houses ${somaVal} ${u} (sem tolerância).` };
    }
    ev.push(mk(`${cfg.familia}.2`, `${cfg.rotulo} Total`, res.resultado, 'Alta', null, null, valTotal, res.motivo));
  }

  // .3 — Consolidação
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk(`${cfg.familia}.3`, `Consistência de ${cfg.rotulo}`, resultado, 'Critica', null, null, [], `Consolidação da Família ${cfg.familia}: ${resultado}.`));

  return { familia: cfg.familia, resultado, evidencias: ev };
}
