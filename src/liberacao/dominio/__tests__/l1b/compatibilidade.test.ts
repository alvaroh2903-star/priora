import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AvaliacaoProcesso, CourierDoProcesso, EntradaAvaliacao, FatoDoMaster, avaliarPelaL1b, decidirProcesso, entradaL1bDaL1a,
} from '../../index';

/**
 * Prova de compatibilidade com a L1a congelada: com toda fonte posterior à
 * L1a NAO_INTEGRADA, a L1b projetada pela fachada é igual ao resultado
 * congelado de `avaliarProcesso` para a mesma entrada.
 *
 * 1. Sonda: os cenários da L1a (arquivo inalterado) rodam aqui com
 *    `avaliarProcesso` envolvido só para CAPTURAR cada entrada que eles usam;
 *    o resultado devolvido é o original, e as asserções deles continuam valendo.
 * 2. Gerador combinatório sobre todo o vocabulário de entrada da L1a.
 */

type Avaliar = (e: EntradaAvaliacao) => AvaliacaoProcesso;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const modulo = require('../../avaliacao') as { avaliarProcesso: Avaliar };
const original: Avaliar = modulo.avaliarProcesso;
const capturadas: EntradaAvaliacao[] = [];
modulo.avaliarProcesso = (e) => {
  capturadas.push(e);
  return original(e);
};

describe('sonda: cenários congelados da L1a (inalterados), capturando cada entrada', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../avaliacao.test');
});

test('[R2] cada entrada usada pelos cenários da L1a: fachada(L1b) === L1a congelada', () => {
  modulo.avaliarProcesso = original;
  assert.ok(capturadas.length >= 30, `entradas capturadas: ${capturadas.length}`);
  for (const e of capturadas) assert.deepStrictEqual(avaliarPelaL1b(e), original(e), JSON.stringify(e));
});

test('[R2] gerador combinatório (vínculo × fatos de Master × Courier × LIBERADO): fachada(L1b) === L1a em todas as combinações', () => {
  const T = (h: number) => `2026-10-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  const ev = (ref: string) => ({ fonte: 'gerador', ref });
  const f = <V>(valor: V, h: number) => ({ valor, vigenteDesde: T(h), ultimaConfirmacaoEm: T(h + 1), evidencia: ev(`${String(valor)}@${h}`) });
  const vinculos = [null, { processoId: 'IM1', masterId: 'M1', vinculadoEm: T(5), evidencia: ev('vinculo') }];
  const conjuntos: FatoDoMaster[][] = [];
  for (const m of [null, 'FISICO', 'WAVE', 'EMISSAO_DESTINO'] as const) for (const fisico of [false, true]) for (const apr of [0, 1, 2]) for (const alheio of [false, true]) {
    const fs: FatoDoMaster[] = [];
    if (m) fs.push({ tipo: 'MODALIDADE_IDENTIFICADA', masterId: 'M1', modalidade: m, acaoEm: T(1), evidencia: ev('modalidade') });
    if (fisico) fs.push({ tipo: 'MASTER_FISICO_RECEBIDO', masterId: 'M1', acaoEm: T(3), ultimaConfirmacaoEm: T(3), evidencia: ev('fisico'), origemProcessoId: 'IM2', processosVinculadosNaAcao: ['IM2'] });
    if (apr) fs.push({ tipo: 'MASTER_APRESENTADO', masterId: 'M1', acaoEm: T(apr === 1 ? 2 : 8), evidencia: ev('apresentacao'), processosVinculadosNaAcao: ['IM2'] });
    if (alheio) fs.push({ tipo: 'MODALIDADE_IDENTIFICADA', masterId: 'M9', modalidade: 'WAVE', acaoEm: T(2), evidencia: ev('alheio') });
    conjuntos.push(fs);
  }
  const couriers: CourierDoProcesso[] = [];
  for (const disponivel of [true, false]) for (const env of [null, 'EM_TRANSITO', 'ENTREGUE'] as const) for (const mbl of [null, 'RECEBIDO', 'AUSENTE_NA_CONFERENCIA'] as const) for (const hbl of [null, 'RECEBIDO_E_CONFERIDO', 'AUSENTE_NA_CONFERENCIA'] as const) {
    couriers.push({ fonte: { disponivel, desde: T(0) }, envelope: env ? f(env, 2) : null, mbl: mbl ? f(mbl, 4) : null, hblOriginal: hbl ? f(hbl, 6) : null });
  }
  let n = 0;
  for (const vinculo of vinculos) for (const fatosDoMaster of conjuntos) for (const courier of couriers) for (const liberado of [null, { em: T(20), evidencia: ev('liberado') }]) {
    const e: EntradaAvaliacao = { processoId: 'IM1', vinculo, fatosDoMaster, courier, liberado };
    assert.deepStrictEqual(avaliarPelaL1b(e), original(e), JSON.stringify(e));
    n++;
  }
  assert.equal(n, 10368);
});

test('na equivalência, a L1b nunca afirma o que a L1a não podia: sem classe, sem "não localizado", sem LIBERADO inventado', () => {
  for (const e of capturadas) {
    const d = decidirProcesso(entradaL1bDaL1a(e));
    assert.ok(!d.itens.some((i) => i.motivo === 'MASTER_NAO_LOCALIZADO'), e.processoId);
    assert.ok(!d.itens.some((i) => i.classe === 'A' || i.classe === 'B'), e.processoId);
    assert.equal(d.liberado, e.liberado);
  }
});
