/**
 * PB-001 — Família V-003 · Containers (fonte da verdade: MBL)
 *
 * Roda PRIMEIRO no DAG: constrói o relacionamento Master↔House por contêiner,
 * pré-requisito das famílias por-contêiner (V-005/006/007/008). Q1: 3
 * subvalidações — Existência, Correspondência, Relacionamento.
 *
 * Pareamento (Q9): primeiro por número EXATO. Sobras são adiadas; quando houver
 * exatamente 1 contêiner sobrando de cada lado (1 MBL × 1 HBL), eles são
 * pareados APENAS para diagnóstico de correspondência — número diferente vira
 * V-003.2 Divergência (não "dois contêineres ausentes"). O relacionamento
 * (V-003.3) só nasce após a correspondência ser confirmada.
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { normalizarCodigo } from './normalizacao';
import {
  ContainerDoc,
  Evidencia,
  Operacao,
  RelacaoContainer,
  ResultadoFamilia,
} from './modelo';

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

function incerto(c: ContainerDoc, campo: string): boolean {
  return (c.leituraIncerta ?? []).includes(campo);
}

function par(hid: string, cm: ContainerDoc | null, ch: ContainerDoc | null): Evidencia['valores'] {
  return [
    { doc: 'MBL', valor: cm?.numero ?? '—' },
    { doc: `HBL ${hid}`, valor: ch?.numero ?? '—' },
  ];
}

export function familiaV003(op: Operacao): {
  relacoes: RelacaoContainer[];
  familia: ResultadoFamilia;
} {
  const ev: Evidencia[] = [];
  const relacoes: RelacaoContainer[] = [];
  const master = op.master;

  if (!master || !master.legivel) {
    ev.push(mk('V-003.1', 'Existência de contêiner', 'NaoAvaliada', 'Alta', null, null, [], 'MBL ausente ou ilegível — família não avaliada.'));
    return { relacoes, familia: { familia: 'V-003', resultado: 'NaoAvaliada', evidencias: ev } };
  }

  const idxMaster = new Map<string, ContainerDoc>();
  for (const c of master.containers) {
    const k = c.numero ? normalizarCodigo(c.numero) : '';
    if (k) idxMaster.set(k, c);
  }
  const vistos = new Set<string>(); // contêineres do MBL casados por número exato
  const vinculados = new Set<string>(); // contêineres com relacionamento criado
  const houseLeftover: Array<{ houseId: string; ch: ContainerDoc }> = []; // sobras (Q9)

  for (const house of op.houses) {
    const hid = house.nome;
    if (!house.legivel) {
      ev.push(mk('V-003.1', 'Existência de contêiner', 'NaoAvaliada', 'Alta', hid, null, [], `HBL ${hid} ilegível.`));
      continue;
    }
    for (const ch of house.containers) {
      const kh = ch.numero ? normalizarCodigo(ch.numero) : '';
      const cm = kh ? idxMaster.get(kh) ?? null : null;
      if (!cm) {
        houseLeftover.push({ houseId: hid, ch }); // adiado — pode virar par 1×1 (Q9)
        continue;
      }
      vistos.add(kh);
      // V-003.1 — Existência
      ev.push(mk('V-003.1', 'Existência de contêiner', 'Consistente', 'Alta', hid, cm.numero, par(hid, cm, ch), `Contêiner ${cm.numero} presente no MBL e no HBL.`));
      // V-003.2 — Correspondência (números casaram; só leitura incerta desvia p/ 👤)
      const inc = incerto(cm, 'numero') || incerto(ch, 'numero');
      const corr: ResultadoValidacao = inc ? 'ValidacaoHumana' : 'Consistente';
      ev.push(mk('V-003.2', 'Número do contêiner', corr, 'Critica', hid, cm.numero, par(hid, cm, ch), inc ? 'Leitura incerta — confirmar número no documento.' : 'Número confere entre MBL e HBL.'));
      // V-003.3 — Relacionamento (só após correspondência confirmada; unicidade)
      if (corr === 'Consistente') {
        if (vinculados.has(kh)) {
          ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', 'Divergencia', 'Critica', hid, cm.numero, par(hid, cm, ch), `Contêiner ${cm.numero} já vinculado a outro House — relacionamento ambíguo.`));
        } else {
          vinculados.add(kh);
          relacoes.push({ numero: kh, houseId: hid, master: cm, house: ch });
          ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', 'Consistente', 'Critica', hid, cm.numero, [], `Relacionamento criado para o contêiner ${cm.numero}.`));
        }
      } else {
        ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', 'ValidacaoHumana', 'Critica', hid, cm.numero, [], 'Relacionamento não criado — correspondência pendente de confirmação.'));
      }
    }
  }

  const masterLeftover = [...idxMaster.entries()].filter(([k]) => !vistos.has(k)).map(([, cm]) => cm);

  // Q9 — Fallback 1×1: pareia para diagnóstico de correspondência.
  if (masterLeftover.length === 1 && houseLeftover.length === 1) {
    const cm = masterLeftover[0];
    const { houseId, ch } = houseLeftover[0];
    ev.push(mk('V-003.1', 'Existência de contêiner', 'Consistente', 'Alta', houseId, cm.numero, par(houseId, cm, ch), 'Um contêiner em cada documento — pareados para conferência do número.'));
    const inc = incerto(cm, 'numero') || incerto(ch, 'numero');
    const corr: ResultadoValidacao = inc ? 'ValidacaoHumana' : 'Divergencia';
    ev.push(mk('V-003.2', 'Número do contêiner', corr, 'Critica', houseId, cm.numero, par(houseId, cm, ch),
      inc ? 'Leitura incerta do número — confirmar no documento.' : `Número do contêiner divergente: MBL ${cm.numero} × HBL ${ch.numero}.`));
    ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', inc ? 'ValidacaoHumana' : 'NaoAvaliada', 'Critica', houseId, ch.numero, [], 'Relacionamento não criado — correspondência não confirmada.'));
  } else {
    for (const { houseId, ch } of houseLeftover) {
      ev.push(mk('V-003.1', 'Existência de contêiner', 'Divergencia', 'Alta', houseId, ch.numero, par(houseId, null, ch), `Contêiner ${ch.numero ?? '(sem número)'} do House não foi localizado no MBL.`));
    }
    for (const cm of masterLeftover) {
      ev.push(mk('V-003.1', 'Existência de contêiner', 'Divergencia', 'Alta', null, cm.numero, [
        { doc: 'MBL', valor: cm.numero ?? '—' },
        { doc: 'HBL', valor: '—' },
      ], `Contêiner ${cm.numero} do MBL não aparece em nenhum House.`));
    }
  }

  const resultado = consolidar(ev.map((e) => e.resultado));
  return { relacoes, familia: { familia: 'V-003', resultado, evidencias: ev } };
}
