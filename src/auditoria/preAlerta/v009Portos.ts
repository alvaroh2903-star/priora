/**
 * PB-001 — Família V-009 · Portos (fonte da verdade: MBL)
 *  - V-009.1 Existência dos Portos (POL/POD obrigatórios; demais condicionais)
 *  - V-009.2 Correspondência (equivalência canônica UN/LOCODE; sem match → 👤)
 *  - V-009.3 Consistência da Rota (detecta origem/destino invertidos)
 *  - V-009.4 Consistência (consolidação)
 * Depende de V-003 (agrupamento). Comparação por House contra o MBL.
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { DocPreAlerta, Evidencia, Operacao, ResultadoFamilia } from './modelo';
import { equivalenciaPorto } from './unlocode';

const FONTE = 'MBL';

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

const presente = (s: string | null): boolean => s != null && s !== '';
const incertoDoc = (d: DocPreAlerta, campo: string): boolean => (d.leituraIncerta ?? []).includes(campo);

/** Compara um campo de porto entre MBL e House e devolve a evidência. */
function comparaPorto(
  sub: string,
  campo: string,
  crit: Criticidade,
  master: DocPreAlerta,
  house: DocPreAlerta,
  get: (d: DocPreAlerta) => string | null,
  chaveIncerto: string,
): Evidencia {
  const vm = get(master);
  const vh = get(house);
  const val: Evidencia['valores'] = [
    { doc: 'MBL', valor: vm ?? '—' },
    { doc: `HBL ${house.nome}`, valor: vh ?? '—' },
  ];
  if (incertoDoc(master, chaveIncerto) || incertoDoc(house, chaveIncerto)) {
    return mk(sub, campo, 'ValidacaoHumana', crit, house.nome, val, 'Leitura incerta — confirmar porto no documento.');
  }
  const eq = equivalenciaPorto(vm, vh);
  if (eq === 'igual') return mk(sub, campo, 'Consistente', crit, house.nome, val, `${campo} equivalente entre MBL e HBL.`);
  if (eq === 'diferente') return mk(sub, campo, 'Divergencia', crit, house.nome, val, `${campo} divergente: MBL "${vm}" × HBL "${vh}".`);
  return mk(sub, campo, 'ValidacaoHumana', crit, house.nome, val, `${campo}: sem correspondência canônica segura — confirmar (sem inferência geográfica).`);
}

export function familiaV009(op: Operacao): ResultadoFamilia {
  const ev: Evidencia[] = [];
  const master = op.master;
  if (!master || !master.legivel) {
    ev.push(mk('V-009.1', 'Existência dos Portos', 'NaoAvaliada', 'Alta', null, [], 'MBL ausente ou ilegível — família não avaliada.'));
    return { familia: 'V-009', resultado: 'NaoAvaliada', evidencias: ev };
  }

  for (const house of op.houses) {
    if (!house.legivel) {
      ev.push(mk('V-009.1', 'Existência dos Portos', 'NaoAvaliada', 'Alta', house.nome, [], `HBL ${house.nome} ilegível.`));
      continue;
    }

    // V-009.1 Existência — POL e POD obrigatórios.
    const faltando: string[] = [];
    if (!presente(master.pol) || !presente(house.pol)) faltando.push('POL');
    if (!presente(master.pod) || !presente(house.pod)) faltando.push('POD');
    const existOk = faltando.length === 0;
    ev.push(mk('V-009.1', 'Existência dos Portos', existOk ? 'Consistente' : 'Divergencia', 'Alta', house.nome, [
      { doc: 'MBL', valor: `${master.pol ?? '—'} → ${master.pod ?? '—'}` },
      { doc: `HBL ${house.nome}`, valor: `${house.pol ?? '—'} → ${house.pod ?? '—'}` },
    ], existOk ? 'POL e POD presentes nos dois documentos.' : `Porto(s) obrigatório(s) ausente(s): ${faltando.join(', ')}.`));

    // V-009.2 Correspondência — POL/POD (Alta) e condicionais quando presentes nos dois (Média).
    if (existOk) {
      ev.push(comparaPorto('V-009.2', 'POL', 'Alta', master, house, (d) => d.pol, 'pol'));
      ev.push(comparaPorto('V-009.2', 'POD', 'Alta', master, house, (d) => d.pod, 'pod'));
    }
    if (presente(master.placeOfReceipt) && presente(house.placeOfReceipt)) {
      ev.push(comparaPorto('V-009.2', 'Place of Receipt', 'Media', master, house, (d) => d.placeOfReceipt, 'placeOfReceipt'));
    }
    if (presente(master.placeOfDelivery) && presente(house.placeOfDelivery)) {
      ev.push(comparaPorto('V-009.2', 'Place of Delivery', 'Media', master, house, (d) => d.placeOfDelivery, 'placeOfDelivery'));
    }

    // V-009.3 Consistência da Rota — detecta origem/destino invertidos.
    if (existOk) {
      const invertido =
        equivalenciaPorto(master.pol, house.pod) === 'igual' &&
        equivalenciaPorto(master.pod, house.pol) === 'igual' &&
        equivalenciaPorto(master.pol, master.pod) !== 'igual';
      ev.push(mk('V-009.3', 'Consistência da Rota', invertido ? 'Divergencia' : 'Consistente', 'Alta', house.nome, [
        { doc: 'MBL', valor: `${master.pol} → ${master.pod}` },
        { doc: `HBL ${house.nome}`, valor: `${house.pol} → ${house.pod}` },
      ], invertido ? 'Origem e destino invertidos entre MBL e HBL.' : 'Sequência de rota coerente.'));
    }
  }

  // V-009.4 Consolidação.
  const resultado = consolidar(ev.map((e) => e.resultado));
  ev.push(mk('V-009.4', 'Consistência dos Portos', resultado, 'Alta', null, [], `Consolidação da Família V-009: ${resultado}.`));

  return { familia: 'V-009', resultado, evidencias: ev };
}
