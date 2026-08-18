/**
 * PB-001 — Família V-003 · Containers (fonte da verdade: MBL)
 *
 * Roda PRIMEIRO no DAG: constrói o relacionamento Master↔House por contêiner,
 * pré-requisito das famílias por-contêiner (V-005/006/007/008). Q1: são 3
 * subvalidações — Existência, Correspondência, Relacionamento (sem "Quantidade").
 */
import { consolidar, Criticidade, ResultadoValidacao } from './estados';
import { normalizarCodigo } from './normalizacao';
import { cmpCodigo } from './comparadores';
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

/**
 * Executa a Família V-003. Retorna os relacionamentos (para as famílias
 * seguintes) e as evidências. Master ausente/ilegível → família Não Avaliada.
 */
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

  // Índice dos contêineres do MBL por número normalizado.
  const idxMaster = new Map<string, ContainerDoc>();
  for (const c of master.containers) {
    const k = c.numero ? normalizarCodigo(c.numero) : '';
    if (k) idxMaster.set(k, c);
  }
  const vinculados = new Set<string>(); // contêineres com relacionamento criado (V-003.3)
  const vistosNoHouse = new Set<string>(); // contêineres do MBL que existem em algum House (V-003.1)

  for (const house of op.houses) {
    const hid = house.nome;
    if (!house.legivel) {
      ev.push(mk('V-003.1', 'Existência de contêiner', 'NaoAvaliada', 'Alta', hid, null, [], `HBL ${hid} ilegível.`));
      continue;
    }

    for (const ch of house.containers) {
      const kh = ch.numero ? normalizarCodigo(ch.numero) : '';
      const cm = kh ? idxMaster.get(kh) ?? null : null;
      const par: Evidencia['valores'] = [
        { doc: 'MBL', valor: cm?.numero ?? '—' },
        { doc: `HBL ${hid}`, valor: ch.numero ?? '—' },
      ];

      // V-003.1 — Existência
      if (!cm) {
        ev.push(mk('V-003.1', 'Existência de contêiner', 'Divergencia', 'Alta', hid, ch.numero, par, `Contêiner ${ch.numero ?? '(sem número)'} do House não foi localizado no MBL.`));
        continue; // sem par no MBL não há o que corresponder/relacionar
      }
      vistosNoHouse.add(kh);
      ev.push(mk('V-003.1', 'Existência de contêiner', 'Consistente', 'Alta', hid, cm.numero, par, `Contêiner ${cm.numero} presente no MBL e no HBL.`));

      // V-003.2 — Correspondência (char-a-char; leitura incerta → Validação Humana)
      const cmp = cmpCodigo(cm.numero, ch.numero, incerto(cm, 'numero') || incerto(ch, 'numero'));
      ev.push(mk('V-003.2', 'Número do contêiner', cmp.resultado, 'Critica', hid, cm.numero, par, cmp.motivo));

      // V-003.3 — Relacionamento (só quando existência+correspondência confirmadas; unicidade: um contêiner, um vínculo)
      if (cmp.resultado === 'Consistente') {
        if (vinculados.has(kh)) {
          ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', 'Divergencia', 'Critica', hid, cm.numero, par, `Contêiner ${cm.numero} já vinculado a outro House — relacionamento ambíguo.`));
        } else {
          vinculados.add(kh);
          relacoes.push({ numero: kh, houseId: hid, master: cm, house: ch });
          ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', 'Consistente', 'Critica', hid, cm.numero, [], `Relacionamento criado para o contêiner ${cm.numero}.`));
        }
      } else {
        const r: ResultadoValidacao = cmp.resultado === 'ValidacaoHumana' ? 'ValidacaoHumana' : 'NaoAvaliada';
        ev.push(mk('V-003.3', 'Relacionamento MBL↔HBL', r, 'Critica', hid, ch.numero, [], `Relacionamento não criado (correspondência: ${cmp.resultado}).`));
      }
    }
  }

  // Contêineres do MBL que não apareceram em nenhum House (existência).
  for (const [k, cm] of idxMaster) {
    if (!vistosNoHouse.has(k)) {
      ev.push(mk('V-003.1', 'Existência de contêiner', 'Divergencia', 'Alta', null, cm.numero, [
        { doc: 'MBL', valor: cm.numero ?? '—' },
        { doc: 'HBL', valor: '—' },
      ], `Contêiner ${cm.numero} do MBL não aparece em nenhum House.`));
    }
  }

  const resultado = consolidar(ev.map((e) => e.resultado));
  return { relacoes, familia: { familia: 'V-003', resultado, evidencias: ev } };
}
