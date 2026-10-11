import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AvaliacaoProcesso, CourierDoProcesso, MENSAGEM_APRESENTADO_ANTES_DO_VINCULO, avaliarProcesso, fatoFisicoDoMaster,
  fatosDoMasterVisiveis, processosAtingidosPeloMaster,
} from '../index';
import { INDISPONIVEL, T, apresentado, courier, entrada, ev, fato, modalidade, vinculo } from './fixtures';

const resolvidoNoCourier = (hora: number) => courier({ envelope: fato('ENTREGUE', T(hora - 1)), mbl: fato('RECEBIDO', T(hora)) });

/* -------------------------------- Master físico -------------------------------- */

test('1. MBL do processo confirmado como recebido no Courier → Master resolvido pelo físico', () => {
  const a = avaliarProcesso(entrada({ processoId: 'A', courier: resolvidoNoCourier(2) }));
  assert.deepEqual(a.master.resolucao, {
    tipo: 'RESOLVIDO', modalidade: 'FISICO', resolvidoEm: T(2), ultimaConfirmacaoEm: T(2), evidencia: ev(`RECEBIDO@${T(2)}`),
    via: 'CONFERENCIA_DO_PROPRIO_PROCESSO', vinculoTardio: null,
  });
  assert.deepEqual(a.progresso.map((m) => [m.marco, m.escopo]), [['MASTER_RESOLVIDO', 'MASTER']]);
});

test('2. envelope entregue (ou só rastreio) sem MBL confirmado → Master não resolvido', () => {
  for (const c of [
    courier({ envelope: fato('ENTREGUE', T(3)) }),
    courier({ envelope: fato('EM_TRANSITO', T(3)) }),
    courier({ envelope: fato('ENTREGUE', T(3)), mbl: fato('AUSENTE_NA_CONFERENCIA', T(4)) }),
  ]) {
    const a = avaliarProcesso(entrada({ processoId: 'A', courier: c }));
    assert.deepEqual(a.master.resolucao, { tipo: 'NAO_RESOLVIDO' });
    assert.deepEqual(a.progresso, []);
  }
});

test('3. Courier indisponível depois de MBL confirmado → o fato anterior continua, com frescor e disponibilidade (N-17)', () => {
  const c = courier({ fonte: INDISPONIVEL(T(8)), mbl: fato('RECEBIDO', T(2), T(5)) });
  const a = avaliarProcesso(entrada({ processoId: 'A', courier: c }));
  assert.equal(a.master.resolucao.tipo, 'RESOLVIDO');
  assert.ok(a.master.resolucao.tipo === 'RESOLVIDO' && a.master.resolucao.ultimaConfirmacaoEm === T(5));
  assert.deepEqual(a.master.fonteCourier, INDISPONIVEL(T(8)));
});

test('Courier indisponível sem confirmação anterior → "não confirmável", nunca "não recebido" (cap. 41)', () => {
  const c = courier({ fonte: INDISPONIVEL(T(8)), envelope: fato('EM_TRANSITO', T(3)) });
  const a = avaliarProcesso(entrada({ processoId: 'A', courier: c, vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'FISICO', T(1))] }));
  assert.deepEqual(a.master.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'FONTE_INDISPONIVEL', indisponivelDesde: T(8) });
  assert.deepEqual(a.master.fisicoDoProcesso.envelope, fato('EM_TRANSITO', T(3)), 'último evento válido preservado');
  assert.equal(a.bloqueador.tipo, 'NAO_DETERMINAVEL');
  assert.ok(a.bloqueador.tipo === 'NAO_DETERMINAVEL' && a.bloqueador.fontesIndisponiveis.includes('COURIER'));
});

test('modalidade identificada ≠ Master resolvido (cap. 21)', () => {
  const fisico = avaliarProcesso(entrada({
    processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'FISICO', T(1))],
    courier: courier({ envelope: fato('EM_TRANSITO', T(2)) }),
  }));
  assert.deepEqual([fisico.master.modalidadeIdentificada, fisico.master.resolucao.tipo], ['FISICO', 'NAO_RESOLVIDO']);

  const wave = avaliarProcesso(entrada({ processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'WAVE', T(1))] }));
  assert.deepEqual([wave.master.modalidadeIdentificada, wave.master.resolucao.tipo], ['WAVE', 'NAO_CONFIRMAVEL']);
  assert.deepEqual(wave.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['EMAIL_WAVE'], fontesIndisponiveis: [], semObservacao: [] },
    'Wave sem fonte: não determinável, nunca "não localizado"');

  const destino = avaliarProcesso(entrada({ processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'EMISSAO_DESTINO', T(1))] }));
  assert.deepEqual([destino.master.modalidadeIdentificada, destino.master.resolucao.tipo], ['EMISSAO_DESTINO', 'NAO_CONFIRMAVEL']);

  const semIdentificacao = avaliarProcesso(entrada({ processoId: 'A', courier: resolvidoNoCourier(2) }));
  assert.deepEqual([semIdentificacao.master.modalidadeIdentificada, semIdentificacao.master.resolucao.tipo], [null, 'RESOLVIDO']);
});

test('guarda do fato negativo: sem observação do Courier, MASTER_FISICO_NAO_RECEBIDO nunca é afirmado', () => {
  const comModalidadeFisica = (c: CourierDoProcesso) => avaliarProcesso(entrada({
    processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'FISICO', T(1))], courier: c,
  }));

  const nada = comModalidadeFisica(courier());
  assert.deepEqual(nada.master.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' });
  const semObservacao = { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: [], fontesIndisponiveis: [], semObservacao: ['COURIER'] };
  assert.deepEqual([nada.etapa, nada.bloqueador], [semObservacao, semObservacao]);

  const entregueSemConferencia = comModalidadeFisica(courier({ envelope: fato('ENTREGUE', T(3)) }));
  assert.equal(entregueSemConferencia.master.resolucao.tipo, 'NAO_RESOLVIDO');
  assert.deepEqual(entregueSemConferencia.bloqueador, semObservacao, 'envelope entregue sem conferência não é "não recebido"');

  const fora = comModalidadeFisica(courier({ fonte: INDISPONIVEL(T(4)) }));
  assert.equal(fora.bloqueador.tipo, 'NAO_DETERMINAVEL');

  for (const r of [nada, entregueSemConferencia, fora]) assert.ok(!JSON.stringify(r).includes('MASTER_FISICO_NAO_RECEBIDO'));

  // Só conhecimento operacional positivo dá o bloqueador conhecido.
  for (const c of [courier({ envelope: fato('EM_TRANSITO', T(3)) }), courier({ envelope: fato('ENTREGUE', T(3)), mbl: fato('AUSENTE_NA_CONFERENCIA', T(4)) })]) {
    const r = comModalidadeFisica(c);
    assert.deepEqual(r.bloqueador, { tipo: 'CONHECIDO', motivo: 'MASTER_FISICO_NAO_RECEBIDO', escopo: 'MASTER', masterId: 'M' });
    assert.deepEqual(r.etapa, { tipo: 'DETERMINADA', etapa: 'PREPARACAO_PARA_LIBERACAO' });
  }
});

/* ------------------------------------ House ------------------------------------ */

test('4. HBL original recebido e conferido pela Rocket no Courier → House resolvido (caminho B)', () => {
  const a = avaliarProcesso(entrada({ processoId: 'A', courier: courier({ hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) }) }));
  assert.equal(a.house.tipo, 'RESOLVIDO');
  assert.ok(a.house.tipo === 'RESOLVIDO' && a.house.caminho === 'B_ORIGINAL_RECEBIDO_PELA_ROCKET' && a.house.resolvidoEm === T(3));
  assert.deepEqual(a.progresso.map((m) => m.marco), ['HOUSE_RESOLVIDO']);
});

test('5. sem fonte de foto do cliente: o caminho B resolve sozinho; sem HBL conferido, House é "não determinável", não pendente', () => {
  const b = avaliarProcesso(entrada({ processoId: 'A', courier: courier({ hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) }) }));
  assert.equal(b.house.tipo, 'RESOLVIDO', 'nenhuma foto do cliente é exigida (H-2)');
  for (const c of [courier(), courier({ hblOriginal: fato('AUSENTE_NA_CONFERENCIA', T(3)) })]) {
    const a = avaliarProcesso(entrada({ processoId: 'A', courier: c }));
    assert.deepEqual(a.house, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'], fontesIndisponiveis: [] });
  }
  const fora = avaliarProcesso(entrada({ processoId: 'A', courier: courier({ fonte: INDISPONIVEL(T(9)), hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) }) }));
  assert.equal(fora.house.tipo, 'RESOLVIDO', 'queda posterior do Courier não nega o House confirmado');
});

/* --------------------------- propagação e vínculo tardio --------------------------- */

const VINCULOS = [vinculo('A', 'M', T(1)), vinculo('B', 'M', T(1)), vinculo('C', 'M', T(1))];

test('9. fato de escopo Master se propaga a todos os processos vinculados', () => {
  const courierPorProcesso = new Map<string, CourierDoProcesso>([['A', resolvidoNoCourier(2)]]);
  const fisico = fatoFisicoDoMaster('M', VINCULOS, courierPorProcesso);
  assert.ok(fisico && fisico.tipo === 'MASTER_FISICO_RECEBIDO');
  assert.deepEqual([fisico.acaoEm, fisico.origemProcessoId, fisico.processosVinculadosNaAcao], [T(2), 'A', ['A', 'B', 'C']]);
  for (const p of ['B', 'C']) {
    const r = avaliarProcesso(entrada({ processoId: p, vinculo: VINCULOS.find((v) => v.processoId === p)!, fatosDoMaster: [fisico] }));
    assert.ok(r.master.resolucao.tipo === 'RESOLVIDO' && r.master.resolucao.via === 'MASTER_VINCULADO', p);
    assert.deepEqual(r.progresso.map((m) => [m.marco, m.escopo]), [['MASTER_RESOLVIDO', 'MASTER']]);
  }
  assert.deepEqual(processosAtingidosPeloMaster('M', VINCULOS, new Set()), { atingidos: ['A', 'B', 'C'], preservadosPorTerminal: [] });
});

test('10. fato de escopo Processo não se propaga; sem vínculo documental, nada se propaga (H-7)', () => {
  const courierPorProcesso = new Map<string, CourierDoProcesso>([['A', courier({ hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) })]]);
  const a = avaliarProcesso(entrada({ processoId: 'A', vinculo: VINCULOS[0], courier: courierPorProcesso.get('A')! }));
  const b = avaliarProcesso(entrada({ processoId: 'B', vinculo: VINCULOS[1], fatosDoMaster: [] }));
  assert.equal(a.house.tipo, 'RESOLVIDO');
  assert.equal(b.house.tipo, 'NAO_DETERMINAVEL', 'o HBL de A não resolve o House de B');
  assert.equal(fatoFisicoDoMaster('M', VINCULOS, courierPorProcesso), null, 'House não vira fato do Master');

  // A tem o MBL recebido, mas não há vínculo A↔M: B não herda (nunca se infere vínculo).
  const semVinculoDeA = new Map<string, CourierDoProcesso>([['A', resolvidoNoCourier(2)]]);
  assert.equal(fatoFisicoDoMaster('M', [VINCULOS[1]], semVinculoDeA), null);
  const vistoPorOutroMaster = fatosDoMasterVisiveis(vinculo('B', 'OUTRO', T(1)), [fatoFisicoDoMaster('M', VINCULOS, semVinculoDeA)!]);
  assert.deepEqual(vistoPorOutroMaster, [], 'fato de outro Master não é visto');
});

test('11. vínculo tardio herda o fato vigente do Master, com o instante original e sem culpa ou override retroativos (N-15)', () => {
  const fisico = fatoFisicoDoMaster('M', [vinculo('A', 'M', T(1))], new Map([['A', resolvidoNoCourier(2)]]))!;
  const apresentacao = apresentado('M', T(3), ['A']);
  const tardio = vinculo('D', 'M', T(5));
  const d = avaliarProcesso(entrada({ processoId: 'D', vinculo: tardio, fatosDoMaster: [fisico, apresentacao] }));

  assert.ok(d.master.resolucao.tipo === 'RESOLVIDO');
  assert.equal(d.master.resolucao.resolvidoEm, T(2), 'o instante é o da ação do Master, não o do vínculo');
  assert.deepEqual(d.master.resolucao.vinculoTardio, {
    acaoEm: T(2), vinculadoEm: T(5), evidenciaDoVinculo: ev('pre-alerta-D', 'auditoria'), processosVinculadosNaAcao: ['A'], mensagem: null,
  }, 'Master físico: mesmo mecanismo, sem mensagem (D-7)');

  const marcoApresentado = d.progresso.find((m) => m.marco === 'MASTER_APRESENTADO')!;
  assert.equal(marcoApresentado.em, T(3));
  assert.equal(marcoApresentado.vinculoTardio?.mensagem, MENSAGEM_APRESENTADO_ANTES_DO_VINCULO);
  assert.equal(MENSAGEM_APRESENTADO_ANTES_DO_VINCULO, 'Master apresentado antes deste processo ser vinculado.');

  assert.deepEqual(Object.keys(d).sort(), ['bloqueador', 'etapa', 'house', 'master', 'processoId', 'progresso', 'proximaAcao'],
    'nenhum campo de culpa, atraso ou override');
  assert.equal(d.bloqueador.tipo, 'NAO_DETERMINAVEL', 'nada é atribuído à Rocket pelo vínculo tardio');

  const vinculadoAntes = avaliarProcesso(entrada({ processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [fisico, apresentacao] }));
  assert.equal(vinculadoAntes.progresso.find((m) => m.marco === 'MASTER_APRESENTADO')?.vinculoTardio, null);
});

test('12. um processo vinculado com pendência própria não altera a etapa nem o progresso de outro (etapa individual)', () => {
  const vinculos = [vinculo('A', 'M', T(1)), vinculo('B', 'M', T(1))];
  const courierB = courier({ mbl: fato('RECEBIDO', T(2)), hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) });
  const courierAComPendencias = courier({ envelope: fato('EM_TRANSITO', T(4)), mbl: fato('AUSENTE_NA_CONFERENCIA', T(5)), hblOriginal: fato('AUSENTE_NA_CONFERENCIA', T(5)) });
  const fatosDoMaster = [fatoFisicoDoMaster('M', vinculos, new Map([['A', courierAComPendencias], ['B', courierB]]))!];

  const avaliarB = (): AvaliacaoProcesso => avaliarProcesso(entrada({ processoId: 'B', vinculo: vinculos[1], fatosDoMaster, courier: courierB }));
  const bSozinho = avaliarB();
  const a = avaliarProcesso(entrada({ processoId: 'A', vinculo: vinculos[0], fatosDoMaster, courier: courierAComPendencias }));

  assert.deepEqual(a.progresso.map((m) => m.marco), ['MASTER_RESOLVIDO'], 'A herda o Master; seu House continua sem fonte');
  assert.ok(a.etapa.tipo === 'NAO_DETERMINAVEL' && a.etapa.semFonteIntegrada.includes('PORTAL_FOTO_HBL'));
  assert.deepEqual(bSozinho.progresso.map((m) => m.marco), ['MASTER_RESOLVIDO', 'HOUSE_RESOLVIDO']);
  assert.ok(bSozinho.etapa.tipo === 'NAO_DETERMINAVEL' && !bSozinho.etapa.semFonteIntegrada.includes('PORTAL_FOTO_HBL'));
  assert.deepEqual(avaliarB(), bSozinho, 'B é avaliado só com os próprios fatos e os do Master');

  // O envelope de A sem o MBL não desfaz o Master resolvido por B (o MBL chega uma vez).
  assert.ok(a.master.resolucao.tipo === 'RESOLVIDO' && a.master.resolucao.via === 'MASTER_VINCULADO');

  // Outro processo vinculado, sem o Master resolvido, com o Master identificado como físico: bloqueador conhecido só no seu Master.
  const n = avaliarProcesso(entrada({
    processoId: 'N', vinculo: vinculo('N', 'OUTRO', T(1)), fatosDoMaster: [modalidade('OUTRO', 'FISICO', T(1))],
    courier: courier({ envelope: fato('EM_TRANSITO', T(4)) }),
  }));
  assert.equal(n.bloqueador.tipo, 'CONHECIDO');
  assert.deepEqual(avaliarB(), bSozinho);
});

/* -------------------------- fontes futuras e saídas independentes -------------------------- */

const NEGATIVOS_PROIBIDOS = ['NAO_LOCALIZADO', 'NAO_PAGO', 'SEM_TELEX', 'SEM_TERMO', 'NAO_APRESENTADO', 'SEM_CE', 'CE_AUSENTE', 'NAO_LIBERADO'];

test('13. integrações futuras ausentes → "não determinável", nunca falso negativo', () => {
  const nada = avaliarProcesso(entrada({ processoId: 'A' }));
  assert.deepEqual(nada.master.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' });
  const semModalidade = {
    tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['EMAIL_WAVE', 'EMAIL_EMISSAO_DESTINO'], fontesIndisponiveis: [], semObservacao: ['COURIER'],
  };
  assert.deepEqual([nada.etapa, nada.bloqueador], [semModalidade, semModalidade], 'sem Wave/emissão no destino integrados: não se afirma "Master não localizado"');

  const tudoQueExiste = avaliarProcesso(entrada({
    processoId: 'A', courier: courier({ mbl: fato('RECEBIDO', T(2)), hblOriginal: fato('RECEBIDO_E_CONFERIDO', T(3)) }),
  }));
  assert.deepEqual(tudoQueExiste.etapa, {
    tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['HEADCARGO', 'PROCEDIMENTO_AGENCIA', 'SISCARGA'], fontesIndisponiveis: [], semObservacao: [],
  }, 'Termo, financeiro, procedimento e SISCARGA sem fonte: não pago, sem Termo ou não apresentado nunca são inferidos');
  assert.deepEqual(tudoQueExiste.bloqueador,
    { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['HEADCARGO'], fontesIndisponiveis: [], semObservacao: [] });

  for (const a of [nada, tudoQueExiste]) {
    const json = JSON.stringify(a);
    for (const negativo of NEGATIVOS_PROIBIDOS) assert.ok(!json.includes(negativo), `${negativo} em ${json}`);
  }
});

test('14. etapa, bloqueador e próxima ação são saídas independentes', () => {
  const emTransito = avaliarProcesso(entrada({
    processoId: 'A', vinculo: vinculo('A', 'M', T(1)), fatosDoMaster: [modalidade('M', 'FISICO', T(1))],
    courier: courier({ envelope: fato('EM_TRANSITO', T(2)) }),
  }));
  assert.deepEqual(emTransito.etapa, { tipo: 'DETERMINADA', etapa: 'PREPARACAO_PARA_LIBERACAO' });
  assert.deepEqual(emTransito.bloqueador, { tipo: 'CONHECIDO', motivo: 'MASTER_FISICO_NAO_RECEBIDO', escopo: 'MASTER', masterId: 'M' });
  assert.deepEqual(emTransito.proximaAcao, {
    tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['HEADCARGO', 'PORTAL_FOTO_HBL', 'EMAIL_TELEX', 'PROCEDIMENTO_AGENCIA'], fontesIndisponiveis: [],
    semObservacao: [],
  });

  const resolvido = avaliarProcesso(entrada({ processoId: 'A', courier: resolvidoNoCourier(2) }));
  assert.notDeepEqual(resolvido.etapa, resolvido.bloqueador);
  assert.notDeepEqual(resolvido.bloqueador, resolvido.proximaAcao);

  const liberado = avaliarProcesso(entrada({ processoId: 'A', courier: resolvidoNoCourier(2), liberado: { em: T(9), evidencia: ev('siscarga', 'siscarga') } }));
  assert.deepEqual([liberado.etapa, liberado.bloqueador, liberado.proximaAcao],
    [{ tipo: 'DETERMINADA', etapa: 'LIBERADO' }, { tipo: 'NENHUM' }, { tipo: 'NENHUMA' }]);
});

/* ------------------------------ cenários do cap. 43 ------------------------------ */

test('cap. 43 §11: Master compartilhado → apresentação propagada; CE House/liberação individuais; LIBERADO não é reaberto', () => {
  const apresentacao = apresentado('M', T(4), ['A', 'B', 'C']);
  const avaliar = (p: string, liberado = false) => avaliarProcesso(entrada({
    processoId: p, vinculo: VINCULOS.find((v) => v.processoId === p)!, fatosDoMaster: [apresentacao],
    liberado: liberado ? { em: T(9), evidencia: ev(`siscarga-${p}`, 'siscarga') } : null,
  }));
  const [a, b, c] = [avaliar('A', true), avaliar('B'), avaliar('C')];
  for (const r of [a, b, c]) assert.ok(r.progresso.some((m) => m.marco === 'MASTER_APRESENTADO' && m.escopo === 'MASTER'), r.processoId);
  assert.deepEqual(a.etapa, { tipo: 'DETERMINADA', etapa: 'LIBERADO' });
  for (const r of [b, c]) {
    assert.deepEqual(r.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['SISCARGA'], fontesIndisponiveis: [], semObservacao: [] });
  }
  assert.deepEqual(processosAtingidosPeloMaster('M', VINCULOS, new Set(['A'])), { atingidos: ['B', 'C'], preservadosPorTerminal: ['A'] });
});

test('cap. 43 §12: HeadCargo/SISCARGA/Courier indisponíveis → desconhecido/não confirmável; nunca não pago, não recebido ou não liberado', () => {
  const a = avaliarProcesso(entrada({ processoId: 'A', courier: courier({ fonte: INDISPONIVEL(T(5)), envelope: fato('ENTREGUE', T(3)) }) }));
  assert.deepEqual(a.master.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'FONTE_INDISPONIVEL', indisponivelDesde: T(5) });
  assert.deepEqual(a.house, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'], fontesIndisponiveis: ['COURIER'] });
  for (const saida of [a.etapa, a.bloqueador, a.proximaAcao]) {
    assert.ok(saida.tipo === 'NAO_DETERMINAVEL' && saida.fontesIndisponiveis.includes('COURIER'));
  }
  const json = JSON.stringify(a);
  for (const negativo of [...NEGATIVOS_PROIBIDOS, 'NAO_RECEBIDO']) assert.ok(!json.includes(negativo), negativo);
});
