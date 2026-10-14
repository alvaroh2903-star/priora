import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarcoTemporal, limiarAntes, situacaoDaJanela } from '../../index';
import {
  FORA, T, apresentacao, armador, clienteOk, data, decidir, ev, fato, instante, integ, item, oficial, pagamento, procedimento, vazio, viagem,
} from './fixtures';

const naoLocalizado = (p: Parameters<typeof decidir>[0]) => item(decidir(p), 'MASTER_NAO_LOCALIZADO');
const SEM_FUSO = { fusoConfiavel: null, brasileiro: true };
const PORTO_INCERTO = { fusoConfiavel: null, brasileiro: null };

/* ------------------------------------------ T-10 ------------------------------------------ */

test('[R25] T-10 exato: ETA − 10×24h; antes → C, a partir dele → B', () => {
  const eta = instante('2026-10-20T15:00:00.000Z');
  const antes = naoLocalizado({ viagem: viagem({ eta }), agora: T(10, 14, 59) });
  assert.equal(antes?.classe, 'C');
  const no = naoLocalizado({ viagem: viagem({ eta }), agora: T(10, 15) });
  assert.equal(no?.classe, 'B');
  const d = decidir({ viagem: viagem({ eta }), agora: T(10, 15) });
  assert.deepEqual(d.viagem.t10, { estado: 'ATINGIDO', limiar: '2026-10-10T15:00:00.000Z', precisao: 'DATA_HORA', origemDoFuso: 'FONTE' });
});

test('[R25] T-10 só com data: 00:00 de D−10 no fuso confiável do porto; porto brasileiro sem fuso → fallback operacional', () => {
  const comFuso = decidir({ viagem: viagem({ eta: data('2026-10-20') }), agora: T(10, 3) });
  assert.deepEqual(comFuso.viagem.t10, { estado: 'ATINGIDO', limiar: '2026-10-10T03:00:00.000Z', precisao: 'DATA', origemDoFuso: 'PORTO_CONFIAVEL' });
  assert.equal(item(comFuso, 'MASTER_NAO_LOCALIZADO')?.classe, 'B');
  const umMinutoAntes = decidir({ viagem: viagem({ eta: data('2026-10-20') }), agora: T(10, 2, 59) });
  assert.equal(item(umMinutoAntes, 'MASTER_NAO_LOCALIZADO')?.classe, 'C');
  const fallback = decidir({ viagem: viagem({ eta: data('2026-10-20'), porto: SEM_FUSO }), agora: T(10, 3) });
  assert.equal(fallback.viagem.t10.estado === 'ATINGIDO' && fallback.viagem.t10.origemDoFuso, 'OPERATIONAL_FALLBACK');
});

test('[R25][R32] T-10 sem ETA → C com "Referência temporal indisponível"; sem fuso seguro → nenhum limiar inventado (C)', () => {
  const semEta = naoLocalizado({});
  assert.equal(semEta?.classe, 'C');
  assert.equal(semEta?.detalhe?.referenciaTemporal, 'REFERENCIA_TEMPORAL_INDISPONIVEL');
  const inseguro = decidir({ viagem: viagem({ eta: data('2026-10-11'), porto: PORTO_INCERTO }), agora: T(10, 12) });
  assert.deepEqual(inseguro.viagem.t10, { estado: 'REFERENCIA_TEMPORAL_INDISPONIVEL', motivo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA' });
  assert.equal(item(inseguro, 'MASTER_NAO_LOCALIZADO')?.classe, 'C', 'não se presume iminência sem referência confiável');
  assert.equal(limiarAntes(data('2026-10-11'), PORTO_INCERTO, 10).tipo, 'NAO_MATERIALIZAVEL');
  // Hora sem fuso, sem regra explícita de hora local do porto, cai para DATA (N-19).
  const semFusoHora: MarcoTemporal = { bruto: '2026-10-20T15:00', precisao: 'DATA_HORA_SEM_FUSO', valor: '2026-10-20T15:00' };
  const l = limiarAntes(semFusoHora, { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }, 10);
  assert.deepEqual(l, { tipo: 'MATERIALIZADO', instante: '2026-10-10T03:00:00.000Z', precisao: 'DATA', origemDoFuso: 'PORTO_CONFIAVEL' });
  const horaLocal = limiarAntes({ ...semFusoHora, horaLocalDoPorto: true }, { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }, 10);
  assert.deepEqual(horaLocal, { tipo: 'MATERIALIZADO', instante: '2026-10-10T18:00:00.000Z', precisao: 'DATA_HORA', origemDoFuso: 'PORTO_CONFIAVEL' });
});

test('[R25] T-10: ETA nova que afasta volta a C (D-3); fonte fora mantém a ETA confirmada', () => {
  const viagemCom = (eta: ReturnType<typeof oficial<MarcoTemporal>>, fonte = undefined as undefined | ReturnType<typeof FORA>) => integ({
    porto: { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }, eta, ata: null, atracacaoPrevista: null, atracacao: null, viagensFinais: [],
  }, fonte);
  const perto = oficial(data('2026-10-15'), T(1));
  assert.equal(naoLocalizado({ viagem: viagemCom(perto), agora: T(10) })?.classe, 'B');
  const adiada = oficial(data('2026-11-30'), T(9), [fato(data('2026-10-15'), T(1))]);
  assert.equal(naoLocalizado({ viagem: viagemCom(adiada), agora: T(10) })?.classe, 'C');
  const fora = decidir({ viagem: viagemCom(perto, FORA()), agora: T(10) });
  assert.equal(item(fora, 'MASTER_NAO_LOCALIZADO')?.classe, 'B', 'indisponibilidade não volta o processo a C');
  assert.ok(fora.indeterminacao.fontesIndisponiveis.includes('VIAGEM'));
});

test('[R27] N-10: contêineres em viagens finais diferentes → Classe A, nenhuma ETA escolhida', () => {
  const d = decidir({ viagem: viagem({ eta: data('2026-10-12'), viagens: ['V1', 'V2', 'V1'] }), agora: T(10, 12) });
  const n10 = item(d, 'DIVERGENCIA_DE_VIAGEM');
  assert.deepEqual([n10?.classe, n10?.responsavel, n10?.acao], ['A', 'ROCKET', 'VERIFICAR_POSSIVEL_ROLAGEM']);
  assert.equal(n10?.detalhe?.mensagem, 'Divergência de viagem detectada — verificar possível rolagem e necessidade de abertura de novo processo.');
  assert.equal(d.principal?.motivo, 'DIVERGENCIA_DE_VIAGEM');
  assert.equal(d.viagem.grupo, 'REFERENCIA_TEMPORAL_INDISPONIVEL');
  assert.equal(d.viagem.chaveEta, null);
  assert.ok(!d.regulatorio.some((c) => c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48'), 'nenhuma ETA escolhida, nenhum limiar');
  assert.equal(item(d, 'MASTER_NAO_LOCALIZADO')?.classe, 'C');
  assert.equal(item(decidir({ viagem: viagem({ eta: data('2026-10-30'), viagens: ['V1', 'V1'] }) }), 'DIVERGENCIA_DE_VIAGEM'), undefined);
});

/* ------------------------------------------ T-48h ------------------------------------------ */

const t48 = (p: Parameters<typeof decidir>[0]) => decidir(p).regulatorio.find((c) => c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48');

test('[R26] T-48h exato pela atracação prevista (antes da ETA); só data → 00:00 de D−2; fallback brasileiro; sem segurança → nenhum limiar', () => {
  const exato = t48({ viagem: viagem({ atracacaoPrevista: instante('2026-10-12T15:00:00.000Z'), eta: instante('2026-10-11T00:00:00.000Z') }), agora: T(10, 15) });
  assert.equal(exato?.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && exato.limiar, '2026-10-10T15:00:00.000Z');
  assert.equal(exato?.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && exato.base, 'ATRACACAO_PREVISTA');
  assert.equal(t48({ viagem: viagem({ atracacaoPrevista: instante('2026-10-12T15:00:00.000Z') }), agora: T(10, 14, 59) }), undefined);
  const soEta = t48({ viagem: viagem({ eta: data('2026-10-12') }), agora: T(10, 3) });
  assert.deepEqual(soEta && soEta.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && [soEta.base, soEta.limiar, soEta.precisao, soEta.origemDoFuso],
    ['ETA', '2026-10-10T03:00:00.000Z', 'DATA', 'PORTO_CONFIAVEL']);
  const fallback = t48({ viagem: viagem({ eta: data('2026-10-12'), porto: SEM_FUSO }), agora: T(10, 3) });
  assert.equal(fallback?.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && fallback.origemDoFuso, 'OPERATIONAL_FALLBACK');
  const inseguro = decidir({ viagem: viagem({ eta: data('2026-10-12'), porto: PORTO_INCERTO }), agora: T(11) });
  assert.ok(!inseguro.regulatorio.some((c) => c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48'));
  assert.ok(inseguro.regulatorio.some((c) => c.tipo === 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA'));
});

test('[R26] T-48h: precisão melhor recalcula o mesmo episódio (uma condição ativa); CE House presente ou fonte fora sem fato → nenhuma condição', () => {
  const soData = t48({ viagem: viagem({ eta: data('2026-10-12') }), agora: T(10, 6) });
  assert.ok(soData, 'alerta conservador às 00:00 de D−2');
  // O timestamp mostra que o T-48h real ainda não chegou: a condição sai.
  const melhor = { viagem: viagem({ eta: data('2026-10-12'), atracacaoPrevista: instante('2026-10-12T20:00:00.000Z') }) };
  assert.equal(t48({ ...melhor, agora: T(10, 6) }), undefined);
  const real = decidir({ ...melhor, agora: T(10, 20) });
  const condicoes = real.regulatorio.filter((c) => c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48');
  assert.equal(condicoes.length, 1);
  assert.equal(condicoes[0].tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && condicoes[0].episodio, soData?.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && soData.episodio);
  assert.equal(t48({ ...melhor, agora: T(11), ceHouse: integ(oficial({ numero: 'CEH1' }, T(9))) }), undefined);
  const fonteFora = decidir({ ...melhor, agora: T(11), ceHouse: integ(vazio(), FORA()) });
  assert.ok(!fonteFora.regulatorio.some((c) => c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48'));
  assert.ok(fonteFora.regulatorio.some((c) => c.tipo === 'INFORMACAO_INDISPONIVEL' && c.sobre === 'CE_HOUSE'));
  // Nunca classe da Fila.
  assert.ok(!real.itens.some((i) => i.acao === 'VERIFICAR_DESCONSOLIDACAO'));
});

/* ------------------------------------- janela de 48h ------------------------------------- */

const posApresentacao = (p: Parameters<typeof decidir>[0] = {}) => decidir({
  ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(3))]),
  pagamentoArmador: pagamento('FINALIZADO', T(4)), ceHouse: integ(oficial({ numero: 'CEH1' }, T(4))), siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(4))),
  ...p,
});

test('[R23] 48h vencidas antes da atracação → nenhuma cobrança (só ETA/ATA não bastam)', () => {
  const d = posApresentacao({ agora: T(9), viagem: viagem({ eta: data('2026-10-20'), ata: instante(T(8)) }) });
  assert.equal(d.janela.estado, 'VENCIDA');
  assert.equal(d.janela.estado === 'VENCIDA' && d.janela.inicio.ate, '2026-10-04T00:00:00.000Z', 'começa pela condição mais recente (pagamento)');
  assert.equal(d.cobranca.estado, 'AGUARDANDO_ATRACACAO');
  assert.ok(!d.itens.some((i) => i.acao === 'COBRAR_ARMADOR_DESBLOQUEIO'));
});

test('[R24] atracação confirmada com a janela já vencida → cobrança imediata, Classe A, no Acompanhamento', () => {
  const d = posApresentacao({ agora: T(9), viagem: viagem({ atracacao: instante(T(8, 10)) }) });
  assert.equal(d.cobranca.estado, 'DEVIDA');
  const c = item(d, 'DESBLOQUEIO_NAO_OCORREU_NA_JANELA_DE_48H');
  assert.deepEqual([c?.classe, c?.acao, c?.visao, c?.responsavel], ['A', 'COBRAR_ARMADOR_DESBLOQUEIO', 'ACOMPANHAMENTO', 'ROCKET']);
  assert.equal(d.principal, c);
  // Ainda dentro da janela na atracação: acompanhar normalmente, sem cobrança.
  const dentro = posApresentacao({ agora: T(4, 12), viagem: viagem({ atracacao: instante(T(4, 12)) }) });
  assert.equal(dentro.janela.estado, 'EM_CURSO');
  assert.equal(dentro.cobranca.estado, 'NAO_APLICAVEL');
  assert.equal(dentro.principal?.acao, 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA');
  // Já desbloqueado no SISCARGA: nada a cobrar.
  assert.equal(posApresentacao({ agora: T(9), viagem: viagem({ atracacao: instante(T(8)) }), siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(8))) }).cobranca.estado, 'DESBLOQUEADO');
});

test('D-8: nunca inventar hora; precisão insuficiente → janela INCERTA, sem cobrança, com a incerteza exposta', () => {
  const soData = situacaoDaJanela({ momento: { precisao: 'DATA', data: '2026-10-03', fuso: 'America/Sao_Paulo' } }, { estado: 'ISENTO_MAERSK' }, T(5, 12));
  assert.deepEqual(soData, {
    estado: 'INCERTA', motivo: 'PRECISAO_TEMPORAL_INSUFICIENTE',
    inicio: { de: '2026-10-03T03:00:00.000Z', ate: '2026-10-04T02:59:59.999Z' }, vencimento: { de: '2026-10-05T03:00:00.000Z', ate: '2026-10-06T02:59:59.999Z' },
  });
  // Pagamento sem momento factual: ocorreu até a observação; antes da apresentação + 48h, certamente em curso.
  const pg = { estado: 'RESOLVIDO' as const, momento: null, observadoEm: T(6), evidencia: ev('hc'), fonte: { disponivel: true, desde: T(1) } };
  assert.equal(situacaoDaJanela({ momento: { precisao: 'INSTANTE', instante: T(3) } }, pg, T(4)).estado, 'EM_CURSO');
  assert.equal(situacaoDaJanela({ momento: { precisao: 'INSTANTE', instante: T(3) } }, pg, T(7)).estado, 'INCERTA');
  assert.equal(situacaoDaJanela({ momento: { precisao: 'INSTANTE', instante: T(3) } }, pg, T(8)).estado, 'VENCIDA');
  const incerta = posApresentacao({
    agora: T(5, 12), viagem: viagem({ atracacao: instante(T(5)) }), pagamentoArmador: { tipo: 'NAO_INTEGRADA' }, armador: armador('MAERSK'),
    procedimento: procedimento([], [{ ...apresentacao('STATUS_FINALIZADO_PORTAL', T(3)), momento: { precisao: 'DATA', data: '2026-10-03', fuso: null } }]),
  });
  assert.equal(incerta.janela.estado, 'INCERTA');
  assert.equal(incerta.cobranca.estado, 'NAO_APLICAVEL');
  assert.ok(!incerta.itens.some((i) => i.classe === 'A'));
  assert.equal(item(incerta, 'AGUARDANDO_DESBLOQUEIO')?.detalhe?.janela, 'INCERTA');
});
