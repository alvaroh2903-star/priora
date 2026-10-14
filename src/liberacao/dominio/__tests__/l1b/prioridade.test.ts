import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChaveEta, EtapaPrincipal, ItemDeFila, comparadorDePrioridade, ordenarPorPrioridade, precedeComCerteza } from '../../index';
import { T, courier, decidir, ev, fato, instante, item, viagem } from './fixtures';

const DIA = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
const eta = (d: number, hora?: number): ChaveEta => (hora === undefined
  ? { tipo: 'DATA', data: DIA(d) }
  : { tipo: 'INSTANTE', t: Date.parse(`${DIA(d)}T${String(hora).padStart(2, '0')}:00:00.000Z`), data: DIA(d) });

const fila = (id: string, p: Partial<ItemDeFila> = {}): ItemDeFila => ({
  id, processos: [id], masterId: null,
  item: { motivo: 'X', natureza: 'ACAO', responsavel: 'ROCKET', acao: 'CONFERIR_MBL_NO_COURIER', classe: 'C', escopo: 'PROCESSO', visao: 'FILA_PRINCIPAL', desde: null },
  classe: 'C', visao: 'FILA_PRINCIPAL', grupo: 'ETA_CONHECIDA', chaveEta: eta(20), etapa: 'PREPARACAO_PARA_LIBERACAO', desde: null,
  referenciaTemporalIndisponivel: false, ...p,
});
const ids = (xs: ItemDeFila[]) => ordenarPorPrioridade(xs).map((x) => x.id);

/** Todas as permutações (conjuntos pequenos). */
function permutacoes<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('[R28] classe primeiro: A > B > C > D, qualquer que seja o ETA/ATA (urgência + capacidade de ação)', () => {
  const xs = [
    fila('d', { classe: 'D', grupo: 'CHEGADA_OCORRIDA', chaveEta: null }),
    fila('c', { classe: 'C', chaveEta: eta(11) }),
    fila('b', { classe: 'B', chaveEta: eta(30) }),
    fila('a', { classe: 'A', grupo: 'REFERENCIA_TEMPORAL_INDISPONIVEL', chaveEta: null }),
  ];
  assert.deepEqual(ids(xs), ['a', 'b', 'c', 'd']);
});

test('[R28] na mesma classe: chegada ocorrida → ETA conhecida (mais próxima primeiro) → referência temporal indisponível', () => {
  const xs = [
    fila('sem-eta', { grupo: 'REFERENCIA_TEMPORAL_INDISPONIVEL', chaveEta: null, etapa: 'ACOMPANHANDO_DESBLOQUEIO' }),
    fila('eta-25', { chaveEta: eta(25) }),
    fila('chegou', { grupo: 'CHEGADA_OCORRIDA', chaveEta: null }),
    fila('eta-12', { chaveEta: eta(12, 18) }),
    fila('eta-12-cedo', { chaveEta: eta(12, 6) }),
  ];
  assert.deepEqual(ids(xs), ['chegou', 'eta-12-cedo', 'eta-12', 'eta-25', 'sem-eta']);
});

test('[R28] ETA só com data: nenhum 00:00 fictício — mesma data empata e decide a proximidade da liberação; datas diferentes ordenam', () => {
  const xs = [fila('instante', { chaveEta: eta(12, 1), etapa: 'PREPARACAO_PARA_LIBERACAO' }), fila('data', { chaveEta: eta(12), etapa: 'APTO_PARA_PROCEDIMENTO' })];
  assert.deepEqual(ids(xs), ['data', 'instante'], 'na mesma data, o instante 01:00 não "ganha" de uma data sem hora');
  assert.deepEqual(ids([fila('d13', { chaveEta: eta(13), etapa: 'ACOMPANHANDO_DESBLOQUEIO' }), fila('i12', { chaveEta: eta(12, 23) })]), ['i12', 'd13']);
});

test('[N11] precisão misturada preserva toda ordem comprovada: A (08:00) vem antes de C (20:00), haja ou não B só com data', () => {
  // Adversarial: B e C "querem" passar à frente de A pelos critérios posteriores (etapa mais avançada, espera mais antiga).
  const a = fila('A', { chaveEta: eta(12, 8), etapa: 'PREPARACAO_PARA_LIBERACAO', desde: T(9) });
  const b = fila('B', { chaveEta: eta(12), etapa: 'APTO_PARA_APRESENTACAO', desde: T(1) });
  const c = fila('C', { chaveEta: eta(12, 20), etapa: 'ACOMPANHANDO_DESBLOQUEIO', desde: T(2) });
  assert.equal(precedeComCerteza(a, c), true);
  assert.equal(precedeComCerteza(a, b) || precedeComCerteza(b, a) || precedeComCerteza(b, c) || precedeComCerteza(c, b), false, 'B é incomparável pela ETA');
  for (const p of permutacoes([a, b, c])) {
    const r = ids(p);
    assert.ok(r.indexOf('A') < r.indexOf('C'), r.join(','));
    assert.deepEqual(r, ['B', 'A', 'C'], 'B decide contra A pela etapa; C só depois de A');
  }
  // Sem B, a mesma ordem comprovada entre A e C.
  assert.deepEqual(ids([c, a]), ['A', 'C']);
  // O comparador do conjunto é transitivo e coerente com a ordem comprovada.
  const conjunto = [a, b, c];
  const cmp = comparadorDePrioridade(conjunto);
  assert.ok(cmp(b, a) < 0 && cmp(a, c) < 0 && cmp(b, c) < 0);
  assert.equal(cmp(a, a), 0);
  assert.throws(() => cmp(a, fila('fora')));
});

test('[N11] ordem comprovada é parcial estrita e a fila é uma extensão linear dela, independente da ordem de entrada (adversarial)', () => {
  let semente = 11;
  const aleatorio = (n: number) => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente % n; };
  const etapas: Array<EtapaPrincipal | null> = [null, 'PREPARACAO_PARA_LIBERACAO', 'APTO_PARA_PROCEDIMENTO', 'MASTER_APRESENTADO', 'ACOMPANHANDO_DESBLOQUEIO'];
  const grupos = ['CHEGADA_OCORRIDA', 'ETA_CONHECIDA', 'ETA_CONHECIDA', 'REFERENCIA_TEMPORAL_INDISPONIVEL'] as const;
  for (let rodada = 0; rodada < 300; rodada++) {
    const xs = Array.from({ length: 7 }, (_, i) => {
      const grupo = grupos[aleatorio(4)];
      return fila(`p${i}`, {
        classe: (['A', 'B', 'C', 'D'] as const)[aleatorio(3) + 1],
        grupo,
        chaveEta: grupo === 'ETA_CONHECIDA' ? (aleatorio(2) ? eta(12 + aleatorio(2), aleatorio(24)) : eta(12 + aleatorio(2))) : null,
        etapa: etapas[aleatorio(5)],
        desde: aleatorio(3) ? T(1 + aleatorio(4)) : null,
      });
    });
    // Ordem comprovada: irreflexiva, assimétrica, transitiva.
    for (const x of xs) {
      assert.equal(precedeComCerteza(x, x), false);
      for (const y of xs) {
        if (precedeComCerteza(x, y)) assert.equal(precedeComCerteza(y, x), false);
        for (const z of xs) if (precedeComCerteza(x, y) && precedeComCerteza(y, z)) assert.ok(precedeComCerteza(x, z));
      }
    }
    // A fila respeita toda ordem comprovada e não depende da ordem de entrada.
    const ordem = ordenarPorPrioridade(xs);
    for (let i = 0; i < ordem.length; i++) for (let j = i + 1; j < ordem.length; j++) assert.equal(precedeComCerteza(ordem[j], ordem[i]), false);
    const base = ordem.map((x) => x.id);
    assert.deepEqual(ids([...xs].reverse()), base);
    assert.deepEqual(ids([xs[3], xs[0], xs[6], xs[1], xs[5], xs[2], xs[4]]), base);
    // O comparador do conjunto é transitivo.
    const cmp = comparadorDePrioridade(xs);
    for (const x of xs) for (const y of xs) for (const z of xs) if (cmp(x, y) < 0 && cmp(y, z) < 0) assert.ok(cmp(x, z) < 0);
  }
});

test('[R29] etapa não determinável: nenhuma proximidade inventada — decide o tempo aguardando; entre etapas conhecidas a proximidade vale', () => {
  const xs = [
    fila('nd-antigo', { etapa: null, desde: T(1) }),
    fila('avancado-recente', { etapa: 'ACOMPANHANDO_DESBLOQUEIO', desde: T(5) }),
    fila('inicio-medio', { etapa: 'PREPARACAO_PARA_LIBERACAO', desde: T(3) }),
  ];
  assert.deepEqual(ids(xs), ['nd-antigo', 'avancado-recente', 'inicio-medio']);
  assert.deepEqual(ids(xs.slice(1)), ['avancado-recente', 'inicio-medio']);
});

test('[R28] tempo aguardando: mais antigo primeiro; desconhecido não ganha nem perde por espera; identificador estável só no fim', () => {
  assert.deepEqual(ids([fila('b', { desde: T(5) }), fila('a', { desde: T(2) })]), ['a', 'b']);
  assert.deepEqual(ids([fila('b', { desde: T(5) }), fila('a', { desde: null }), fila('c', { desde: T(1) })]), ['a', 'c', 'b']);
});

test('D-4: ação C continua C depois da chegada; a urgência aparece pela ordem do grupo de chegada', () => {
  const fisico = [{ tipo: 'MODALIDADE_IDENTIFICADA' as const, masterId: 'M1', modalidade: 'FISICO' as const, acaoEm: T(1), evidencia: ev('m') }];
  const d = decidir({ fatosDoMasterL1a: fisico, courier: courier({ envelope: fato('ENTREGUE' as const, T(2)) }), viagem: viagem({ ata: instante(T(9)) }) });
  assert.equal(item(d, 'CONFERENCIA_DO_MBL_PENDENTE')?.classe, 'C');
  assert.equal(d.viagem.grupo, 'CHEGADA_OCORRIDA');
});
