import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidacaoDeConfirmacaoDePagamento, PagamentoDoArmador, pagamentoFinalizadoNoInstante } from '../../index';
import {
  T, apresentacao, armador, clienteOk, decidir, encaminhado, etapaDe, ev, evento, execucaoRocket, fato, instante, integ, item, oficial,
  pagamento, procedimento, vazio, viagem, vinculo,
} from './fixtures';

/** Decisões finais da L1b, aprovadas antes do commit ([F1]…[F4]). */

const marcos = (d: ReturnType<typeof decidir>) => d.progresso.map((m) => m.marco);
const acoesDe = (d: ReturnType<typeof decidir>) => d.itens.map((i) => i.acao);

/* ------------------------------------- 1. P12 aprovada ------------------------------------- */

test('[F1] P12: Master resolvido sem armador confiável → Preparação Operacional, Rocket identifica o armador (C), atenção de inconsistência; nada inferido', () => {
  const d = decidir({ ...clienteOk(), armador: integ(vazio<{ masterId: string; codigo: string }>()) });
  assert.equal(etapaDe(d), 'PREPARACAO_OPERACIONAL');
  const i = item(d, 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO');
  assert.deepEqual([i?.responsavel, i?.acao, i?.classe], ['ROCKET', 'IDENTIFICAR_ARMADOR_DO_MASTER', 'C']);
  assert.deepEqual(d.atencoes.map((a) => a.tipo), ['INCONSISTENCIA_DE_DADOS_DO_MASTER']);
  assert.equal(d.principal, i);
  // Nada de prefixo/semelhança/heurística: MBL com cara de CMA CGM e armador de OUTRO Master não identificam este.
  const heuristica = decidir({
    ...clienteOk(), vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM100', 'CMDU5550001') }, armador: armador('CMA CGM', 'CMDU5550002'),
  });
  assert.equal(heuristica.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
  assert.ok(!heuristica.itens.some((x) => x.exigePortaoN13));
  // Com o fato confiável, a matriz normal.
  const normal = decidir({ ...clienteOk(), armador: armador('CMA CGM') });
  assert.equal(normal.agencia.tipo === 'MAPEADA' && normal.agencia.agencia, 'UNIMAR');
  assert.deepEqual(normal.atencoes, []);
});

/* ------------------------------ 2. Grieg — envio antecipado ------------------------------ */

const grieg = { ...clienteOk(), armador: armador('EVERGREEN') };

test('[F2] Grieg: BL encaminhado antes da aptidão não promove para Apto; fato preservado, bloqueadores reais mantidos, atenção sinalizada', () => {
  const enc = encaminhado(T(5), 'ana', 'GRIEG');
  const antecipado = decidir({
    ...grieg, pagamentoArmador: pagamento('PENDENTE', T(2)), viagem: viagem({ eta: instante('2026-10-20T12:00:00.000Z') }),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enc]),
  });
  assert.equal(etapaDe(antecipado), 'PROCEDIMENTO_EM_ANDAMENTO', 'não promove para Apto para Apresentação');
  assert.equal(antecipado.subEtapa, null, 'P10 não se aplica sem aptidão');
  // Fato do envio preservado com autor, horário e evidência.
  assert.deepEqual(antecipado.procedimento.tipo === 'CONHECIDO' && antecipado.procedimento.encaminhamentos, [enc]);
  const m = antecipado.progresso.find((x) => x.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO');
  assert.deepEqual([m?.ator, m?.em, m?.evidencia], ['ana', T(5), enc.evidencia]);
  // Bloqueadores reais: atracação efetiva e pagamento ao armador.
  assert.ok(item(antecipado, 'AGUARDANDO_ATRACACAO'));
  assert.ok(item(antecipado, 'PAGAMENTO_AO_ARMADOR_PENDENTE'));
  assert.ok(!acoesDe(antecipado).includes('AGUARDAR_PROTOCOLO_CARIMBADO'));
  // Sinalização.
  const a = antecipado.atencoes.find((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO');
  assert.deepEqual(a && a.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO' && [a.encaminhamento, a.condicoesPendentes], [enc, ['ATRACACAO', 'PAGAMENTO_AO_ARMADOR']]);
  // Nunca Master apresentado.
  assert.equal(antecipado.apresentacao, null);
  assert.ok(!marcos(antecipado).includes('MASTER_APRESENTADO'));
  // Mesmo sem o evento de preparação registrado, o envio não vale aptidão.
  const semPreparo = decidir({ ...grieg, pagamentoArmador: pagamento('FINALIZADO', T(2)), procedimento: procedimento([], [], [enc]) });
  assert.equal(etapaDe(semPreparo), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.deepEqual(semPreparo.atencoes.map((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO' && x.condicoesPendentes), [['ATRACACAO']]);
});

test('[F2] Grieg: cumpridos os requisitos, aplica-se a P10 normalmente; a apresentação só pela evidência real', () => {
  const enc = encaminhado(T(5), 'ana', 'GRIEG');
  const base = { ...grieg, pagamentoArmador: pagamento('FINALIZADO', T(6)), viagem: viagem({ atracacao: instante(T(8)) }) };
  const apta = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enc]) });
  assert.equal(etapaDe(apta), 'APTO_PARA_APRESENTACAO');
  assert.equal(apta.subEtapa?.mensagem, 'Apresentação em andamento — aguardando protocolo carimbado');
  // Enviado (T5) antes da finalização do pagamento (T6): a P10 se aplica, mas a irregularidade do envio continua visível (13.7).
  assert.deepEqual(apta.atencoes.map((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO' && x.condicoesPendentes), [['PAGAMENTO_AO_ARMADOR']]);
  assert.equal(apta.apresentacao, null);
  const confirmada = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [apresentacao('PROTOCOLO_CARIMBADO', T(9), 'ana')], [enc]) });
  assert.ok(marcos(confirmada).includes('MASTER_APRESENTADO'));
  assert.equal(pagamentoFinalizadoNoInstante('M1', pagamento('PENDENTE', T(9, 6), 'M1', [fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(6))]), T(9)), true);
  assert.equal(pagamentoFinalizadoNoInstante('M1', pagamento('PENDENTE', T(9, 6), 'M1', [fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(6))]), T(10)), false);
});

/* -------------------------- 3. Unimar/Maersk — BL encaminhado -------------------------- */

test('[F3] Unimar/Maersk: BL encaminhado sem Finalizado → aguardar Finalizado; o mesmo envio nunca é recomendado de novo; registro é só rastreabilidade', () => {
  for (const codigo of ['ONE', 'MAERSK']) {
    const base = { ...clienteOk(), armador: armador(codigo) };
    const enc = encaminhado(T(5));
    const casos = [
      { eventos: [evento('AGENDAMENTO_INICIADO', T(3)), evento('AGENDAMENTO_CONFIRMADO', T(4))], etapa: 'APTO_PARA_APRESENTACAO' },
      { eventos: [evento('AGENDAMENTO_INICIADO', T(3))], etapa: 'PROCEDIMENTO_EM_ANDAMENTO' },
      { eventos: [], etapa: 'APTO_PARA_PROCEDIMENTO' },
    ];
    for (const c of casos) {
      const d = decidir({ ...base, procedimento: procedimento(c.eventos, [], [enc]) });
      assert.equal(etapaDe(d), c.etapa, `${codigo}: o registro não muda a etapa`);
      assert.equal(d.principal?.acao, 'AGUARDAR_STATUS_FINALIZADO', codigo);
      for (const repetido of ['APRESENTAR_MASTER', 'AGENDAR_NO_PORTAL', 'AGUARDAR_CONFIRMACAO_DO_AGENDAMENTO']) {
        assert.ok(!acoesDe(d).includes(repetido as never), `${codigo}: não recomenda ${repetido}`);
      }
      assert.equal(d.apresentacao, null);
      assert.equal(d.subEtapa, null);
    }
    // Finalizado prova sozinho, com ou sem o registro manual.
    for (const encs of [[], [enc]]) {
      const d = decidir({ ...base, pagamentoArmador: pagamento('FINALIZADO', T(2)), procedimento: procedimento([evento('AGENDAMENTO_CONFIRMADO', T(4))], [apresentacao('STATUS_FINALIZADO_PORTAL', T(7))], encs) });
      assert.ok(marcos(d).includes('MASTER_APRESENTADO'), `${codigo} com ${encs.length} registro(s)`);
    }
  }
});

/* ------------------------------ 4. Agência incompatível ------------------------------ */

test('[F4] encaminhamento com agência diferente da matriz: preservado como veio, sinalizado ao Analista, não avança etapa nem prova apresentação', () => {
  const errado = encaminhado(T(5), 'ana', 'GRIEG');
  const d = decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [errado]) });
  // Registro original intacto, com a evidência.
  assert.deepEqual(d.procedimento.tipo === 'CONHECIDO' && d.procedimento.encaminhamentosIncompativeis, [errado]);
  assert.deepEqual(d.procedimento.tipo === 'CONHECIDO' && d.procedimento.encaminhamentos, []);
  assert.equal(errado.agencia, 'GRIEG', 'nada corrigido em silêncio');
  // Sinalização para análise do Analista.
  const a = d.atencoes.find((x) => x.tipo === 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL');
  assert.deepEqual(a && a.tipo === 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL' && [a.encaminhamento, a.agenciaDaMatriz], [errado, 'MSC']);
  const i = item(d, 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL');
  assert.deepEqual([i?.responsavel, i?.acao, i?.classe], ['ROCKET', 'ANALISAR_ENCAMINHAMENTO_INCOMPATIVEL', 'C']);
  assert.equal(d.principal, i, 'a análise vem antes de seguir o procedimento');
  // Não avança a etapa (sem ele, MSC preparado continua em Apto para Procedimento) nem cria subestado/marco/apresentação.
  assert.equal(etapaDe(d), 'APTO_PARA_PROCEDIMENTO');
  assert.equal(d.subEtapa, null);
  assert.ok(!marcos(d).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'));
  assert.ok(!marcos(d).includes('MASTER_APRESENTADO'));
  assert.equal(d.apresentacao, null);
  // Evergreen com envio registrado como MSC: não aciona a P10.
  const g = decidir({
    ...clienteOk(), armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(8)) }),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(9), 'ana', 'MSC')]),
  });
  assert.equal(g.subEtapa, null);
  assert.equal(g.principal?.acao, 'ANALISAR_ENCAMINHAMENTO_INCOMPATIVEL');
  // Agência compatível ou não informada: o encaminhamento vale normalmente.
  for (const agenciaRegistrada of ['MSC', null] as const) {
    const ok = decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [], [encaminhado(T(5), 'ana', agenciaRegistrada)]) });
    assert.equal(etapaDe(ok), 'PROCEDIMENTO_EM_ANDAMENTO');
    assert.equal(ok.subEtapa?.tipo, 'APRESENTACAO_EM_ANDAMENTO');
    assert.deepEqual(ok.atencoes, []);
  }
});

/* ---------------- 5. Grieg — reversão financeira após encaminhamento válido (13.5) ---------------- */

const finalizadoValido = fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(6), T(6), 'hc-pagamento-ok');
const envioValido = {
  ...clienteOk(), armador: armador('EVERGREEN'), viagem: viagem({ atracacao: instante(T(8)) }),
  // Atracação confirmada (observada em T1) e pagamento finalizado (T6) antes do envio (T9); nova pendência oficial em T10.
  pagamentoArmador: pagamento('PENDENTE', T(10), 'M1', [finalizadoValido]),
};
const enviadoEm9 = encaminhado(T(9), 'ana', 'GRIEG');

test('[F5] nova pendência financeira depois de um envio válido: etapa 5 preservada, envio preservado, pendência explícita', () => {
  const d = decidir({ ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]), agora: T(11) });
  assert.equal(etapaDe(d), 'APTO_PARA_APRESENTACAO', 'não regride para Procedimento em Andamento');
  assert.equal(d.subEtapa?.tipo, 'APRESENTACAO_EM_ANDAMENTO');
  // Fato do envio preservado com autor, instante e evidência.
  const m = d.progresso.find((x) => x.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO');
  assert.deepEqual([m?.ator, m?.em, m?.evidencia], ['ana', T(9), enviadoEm9.evidencia]);
  // Pendência financeira explícita: responsável e próxima ação.
  const p = item(d, 'PAGAMENTO_AO_ARMADOR_PENDENTE');
  assert.deepEqual([p?.responsavel, p?.acao, p?.classe], ['ROCKET_FINANCEIRO', 'PAGAR_ARMADOR', 'C']);
  assert.equal(d.principal, p);
  const a = d.atencoes.find((x) => x.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO');
  assert.deepEqual(a && a.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO' && [a.encaminhamento, a.pendenteDesde], [enviadoEm9, T(10)]);
  assert.ok(!d.atencoes.some((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO'), 'o envio foi válido');
  // Nada de apresentação nem LIBERADO inferidos.
  assert.equal(d.apresentacao, null);
  assert.ok(!marcos(d).includes('MASTER_APRESENTADO'));
  assert.equal(d.liberado, null);
  // O protocolo carimbado voltou: a confirmação do Analista segue disponível (13.6), ao lado da pendência financeira.
  const voltou = decidir({ ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3)), evento('RETORNO_CARIMBADO_RECEBIDO', T(10, 6))], [], [enviadoEm9]) });
  assert.equal(voltou.itens.find((x) => x.acao === 'CONFIRMAR_APRESENTACAO')?.classe, 'C');
  assert.ok(item(voltou, 'PAGAMENTO_AO_ARMADOR_PENDENTE'));
  assert.ok(!item(voltou, 'CONFIRMACAO_BLOQUEADA_PELA_PENDENCIA_FINANCEIRA'));
  // Rocket já pagou, aguardando baixa: a pendência continua explícita, agora como espera externa.
  const pago = decidir({ ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]), pagamentosExecutadosPelaRocket: [execucaoRocket(T(10, 6))] });
  assert.equal(etapaDe(pago), 'APTO_PARA_APRESENTACAO');
  assert.deepEqual([item(pago, 'PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO')?.responsavel, item(pago, 'PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO')?.classe], ['ARMADOR', 'D']);
  // Atracação só confirmada DEPOIS do envio: o envio não era válido; a nova pendência não preserva a etapa 5.
  const atracacaoTardia = integ({
    porto: { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }, eta: vazio<{ bruto: string; precisao: 'DATA'; valor: string }>(), ata: null,
    atracacaoPrevista: null, atracacao: fato(instante(T(9, 3)), T(9, 3)), viagensFinais: [],
  });
  const tardio = decidir({ ...envioValido, viagem: atracacaoTardia, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]) });
  assert.equal(etapaDe(tardio), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.ok(!tardio.atencoes.some((x) => x.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO'));
  // Regularizado: segue a P10 sem atenção de pendência.
  const regularizado = decidir({
    ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]),
    pagamentoArmador: integ({ masterId: 'M1', estado: oficial({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(12)) }),
  });
  assert.equal(etapaDe(regularizado), 'APTO_PARA_APRESENTACAO');
  assert.ok(!regularizado.atencoes.some((x) => x.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO'));
});

test('[F6] invalidação retroativa da confirmação original: aptidão reavaliada pelas evidências válidas, histórico preservado', () => {
  const invalidacao: InvalidacaoDeConfirmacaoDePagamento = {
    masterId: 'M1', confirmacaoInvalidada: finalizadoValido.evidencia, em: T(10, 6), evidencia: ev('estorno-hc', 'headcargo'), motivo: 'baixa lançada por engano',
  };
  const d = decidir({
    ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]), invalidacoesDePagamentoAoArmador: [invalidacao],
  });
  // Sem pagamento validamente confirmado no envio, não havia aptidão: volta ao procedimento em andamento.
  assert.equal(etapaDe(d), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.equal(d.subEtapa, null);
  const antes = d.atencoes.find((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO');
  assert.deepEqual(antes && antes.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO' && antes.condicoesPendentes, ['PAGAMENTO_AO_ARMADOR']);
  assert.ok(!d.atencoes.some((x) => x.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO'));
  assert.ok(d.atencoes.some((x) => x.tipo === 'CONFIRMACAO_DE_PAGAMENTO_INVALIDADA_RETROATIVAMENTE' && x.invalidacao === invalidacao));
  assert.ok(item(d, 'PAGAMENTO_AO_ARMADOR_PENDENTE'));
  // Histórico preservado: o fato do envio e a confirmação original continuam lá; só não valem como prova.
  assert.ok(marcos(d).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'));
  assert.equal(envioValido.pagamentoArmador.tipo === 'INTEGRADA' && envioValido.pagamentoArmador.valor.estado.historico[0], finalizadoValido);
  assert.equal(pagamentoFinalizadoNoInstante('M1', envioValido.pagamentoArmador, T(9)), true, 'sem invalidação: válido no envio');
  assert.equal(pagamentoFinalizadoNoInstante('M1', envioValido.pagamentoArmador, T(9), [invalidacao]), null, 'invalidada: nenhum oficial válido vigente no envio');
  // Invalidação de OUTRA confirmação não afeta este envio.
  const outra = { ...invalidacao, confirmacaoInvalidada: ev('outra-confirmacao') };
  assert.equal(etapaDe(decidir({ ...envioValido, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enviadoEm9]), invalidacoesDePagamentoAoArmador: [outra] })), 'APTO_PARA_APRESENTACAO');
});

/* -------------- 6. Opção B — apresentação × pagamento são dimensões independentes (13.6) -------------- */

const comRetorno = [evento('PREPARACAO_REGISTRADA', T(3)), evento('RETORNO_CARIMBADO_RECEBIDO', T(10, 6))];
const protocoloConfirmado = { ...apresentacao('PROTOCOLO_CARIMBADO', T(10, 12), 'ana'), registradaEm: T(10, 12) };

test('[F7] envio válido → nova pendência → protocolo carimbado → confirmação do Analista → etapa 6 (MASTER_APRESENTADO), tudo preservado', () => {
  const d = decidir({ ...envioValido, procedimento: procedimento(comRetorno, [protocoloConfirmado], [enviadoEm9]), agora: T(11) });
  assert.equal(etapaDe(d), 'MASTER_APRESENTADO');
  // Preservados: encaminhamento (autor/instante/evidência), retorno do protocolo e confirmação do Analista.
  const enc = d.progresso.find((x) => x.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO');
  assert.deepEqual([enc?.ator, enc?.em, enc?.evidencia], ['ana', T(9), enviadoEm9.evidencia]);
  assert.ok(d.procedimento.tipo === 'CONHECIDO' && d.procedimento.eventos.some((x) => x.tipo === 'RETORNO_CARIMBADO_RECEBIDO' && x.em === T(10, 6)));
  assert.deepEqual(d.apresentacao?.confirmacaoDoAnalista, { por: 'ana', em: T(10, 12) });
  assert.deepEqual(d.apresentacao?.evidencia, protocoloConfirmado.evidencia);
  assert.ok(marcos(d).includes('MASTER_APRESENTADO'));
  // Pendência financeira atual, com responsável e próxima ação.
  const p = item(d, 'PAGAMENTO_AO_ARMADOR_PENDENTE');
  assert.deepEqual([p?.responsavel, p?.acao, p?.classe], ['ROCKET_FINANCEIRO', 'PAGAR_ARMADOR', 'C']);
  assert.equal(d.principal, p);
  // Nada de etapa 7 nem LIBERADO.
  assert.equal(d.liberado, null);
  assert.ok(!marcos(d).includes('LIBERADO'));
  assert.ok(!marcos(d).includes('CONDICAO_FINANCEIRA_DO_ARMADOR'));
});

test('[F8] etapa 6 com pagamento pendente não avança para a etapa 7, nem com o tempo, a atracação ou o frete pendente no SISCARGA', () => {
  const base = {
    ...envioValido, procedimento: procedimento(comRetorno, [protocoloConfirmado], [enviadoEm9]),
    ceHouse: integ(oficial({ numero: 'CEH1' }, T(9))), siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(9))),
  };
  for (const agora of [T(11), T(20), T(30)]) {
    const d = decidir({ ...base, agora });
    assert.equal(etapaDe(d), 'MASTER_APRESENTADO', agora);
    assert.deepEqual(d.janela, { estado: 'NAO_INICIADA', faltam: ['CONDICAO_FINANCEIRA'] }, 'a janela de 48h não começa sem a condição financeira');
    assert.equal(d.cobranca.estado, 'NAO_APLICAVEL');
    assert.ok(!acoesDe(d).includes('COBRAR_ARMADOR_DESBLOQUEIO'));
    assert.ok(!acoesDe(d).includes('ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA'));
  }
  // Rocket já pagou e aguarda baixa: continua na etapa 6, com espera externa explícita.
  const aguardandoBaixa = decidir({ ...base, pagamentosExecutadosPelaRocket: [execucaoRocket(T(11))] });
  assert.equal(etapaDe(aguardandoBaixa), 'MASTER_APRESENTADO');
  assert.equal(item(aguardandoBaixa, 'PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO')?.responsavel, 'ARMADOR');
});

test('[F9] regularização financeira posterior permite reavaliar o avanço para a etapa 7, com a janela de 48h a partir dela', () => {
  const regularizado = integ({
    masterId: 'M1',
    estado: oficial<PagamentoDoArmador>({ situacao: 'FINALIZADO', finalizadoEm: null }, T(13), [finalizadoValido, fato<PagamentoDoArmador>({ situacao: 'PENDENTE', finalizadoEm: null }, T(10))]),
  });
  const base = { ...envioValido, pagamentoArmador: regularizado, procedimento: procedimento(comRetorno, [protocoloConfirmado], [enviadoEm9]) };
  const d = decidir({ ...base, agora: T(14) });
  assert.equal(etapaDe(d), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.ok(marcos(d).includes('CONDICAO_FINANCEIRA_DO_ARMADOR'));
  assert.ok(!item(d, 'PAGAMENTO_AO_ARMADOR_PENDENTE'));
  // P1: a janela começa no instante válido mais recente (a regularização), nunca na finalização revertida.
  assert.equal(d.janela.estado, 'INCERTA');
  assert.equal(d.janela.estado === 'INCERTA' && d.janela.inicio.ate, '2026-10-13T00:00:00.000Z');
  assert.equal(decidir({ ...base, agora: T(16) }).janela.estado, 'VENCIDA');
  assert.equal(d.liberado, null);
});

test('[F10] invalidação retroativa da confirmação original continua respeitada: a Opção B não valida um envio irregular', () => {
  const invalidacao: InvalidacaoDeConfirmacaoDePagamento = {
    masterId: 'M1', confirmacaoInvalidada: finalizadoValido.evidencia, em: T(10, 6), evidencia: ev('estorno-hc', 'headcargo'), motivo: 'baixa lançada por engano',
  };
  const d = decidir({ ...envioValido, procedimento: procedimento(comRetorno, [], [enviadoEm9]), invalidacoesDePagamentoAoArmador: [invalidacao] });
  assert.equal(etapaDe(d), 'PROCEDIMENTO_EM_ANDAMENTO', 'sem aptidão válida no envio, nem a etapa 5 é preservada');
  assert.ok(!acoesDe(d).includes('CONFIRMAR_APRESENTACAO'), 'a confirmação não é recomendada a partir de um envio irregular');
  assert.ok(!d.atencoes.some((x) => x.tipo === 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO'));
  assert.ok(d.atencoes.some((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO'));
  assert.ok(d.atencoes.some((x) => x.tipo === 'CONFIRMACAO_DE_PAGAMENTO_INVALIDADA_RETROATIVAMENTE'));
  assert.equal(d.subEtapa, null);
  assert.ok(!marcos(d).includes('MASTER_APRESENTADO'));
  // O mesmo vale para um envio originalmente antecipado (sem atracação confirmada): nada de confirmação recomendada.
  const antecipado = decidir({
    ...envioValido, viagem: viagem({ eta: instante('2026-10-20T12:00:00.000Z') }), procedimento: procedimento(comRetorno, [], [enviadoEm9]),
  });
  assert.equal(etapaDe(antecipado), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.ok(!acoesDe(antecipado).includes('CONFIRMAR_APRESENTACAO'));
});

/* ------- 7. Envio irregular seguido de apresentação factual (13.7): estado factual × conformidade do processo ------- */

test('[F11] envio irregular + protocolo carimbado + confirmação do Analista → etapa 6; irregularidade, motivos e pendências preservados', () => {
  const enviadoCedo = encaminhado(T(5), 'ana', 'GRIEG');
  const semPagamentoCliente = integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(2)));
  const base = {
    ...grieg, financeiroCliente: semPagamentoCliente,
    // No envio (T5): sem atracação (só em T8) e com pagamento ao armador pendente.
    viagem: integ({
      porto: { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }, eta: vazio<{ bruto: string; precisao: 'DATA'; valor: string }>(), ata: null,
      atracacaoPrevista: null, atracacao: fato(instante(T(8)), T(8)), viagensFinais: [],
    }),
    pagamentoArmador: pagamento('PENDENTE', T(2)),
  };
  const antes = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3)), evento('RETORNO_CARIMBADO_RECEBIDO', T(9))], [], [enviadoCedo]) });
  assert.ok(!acoesDe(antes).includes('CONFIRMAR_APRESENTACAO'), 'a confirmação nunca foi recomendada a partir do envio irregular');

  const confirmado = { ...apresentacao('PROTOCOLO_CARIMBADO', T(9, 6), 'ana'), registradaEm: T(9, 6) };
  const d = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3)), evento('RETORNO_CARIMBADO_RECEBIDO', T(9))], [confirmado], [enviadoCedo]), agora: T(12) });
  // ESTADO FACTUAL: apresentado.
  assert.equal(etapaDe(d), 'MASTER_APRESENTADO');
  assert.ok(marcos(d).includes('MASTER_APRESENTADO'));
  assert.deepEqual(d.apresentacao?.confirmacaoDoAnalista, { por: 'ana', em: T(9, 6) });
  // CONFORMIDADE: o envio irregular, o motivo e a atenção continuam visíveis; nada o torna recomendado/autorizado.
  const m = d.progresso.find((x) => x.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO');
  assert.deepEqual([m?.ator, m?.em], ['ana', T(5)]);
  const a = d.atencoes.find((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO');
  assert.deepEqual(a && a.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO' && [a.encaminhamento, a.condicoesPendentes], [enviadoCedo, ['ATRACACAO', 'PAGAMENTO_AO_ARMADOR']]);
  // Pré-condições/pendências que faltavam continuam: a do cliente (sem override) e a do pagamento ao armador.
  assert.ok(item(d, 'FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO'));
  assert.equal(item(d, 'PAGAMENTO_AO_ARMADOR_PENDENTE')?.acao, 'PAGAR_ARMADOR');
  // Sem etapa 7 nem janela enquanto o pagamento estiver pendente; nada de LIBERADO.
  assert.deepEqual(d.janela, { estado: 'NAO_INICIADA', faltam: ['CONDICAO_FINANCEIRA'] });
  assert.equal(d.liberado, null);

  // Pagamento válido depois (T11): etapa 7; a janela começa no mais recente entre apresentação (T9:06) e pagamento (T11).
  const pago = decidir({
    ...base, pagamentoArmador: integ({ masterId: 'M1', estado: oficial<PagamentoDoArmador>({ situacao: 'FINALIZADO', finalizadoEm: { precisao: 'INSTANTE', instante: T(11) } }, T(11)) }),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3)), evento('RETORNO_CARIMBADO_RECEBIDO', T(9))], [confirmado], [enviadoCedo]), agora: T(12),
  });
  assert.equal(etapaDe(pago), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.deepEqual(pago.janela.estado === 'EM_CURSO' && pago.janela.inicio, { de: T(11), ate: T(11) });
  assert.ok(pago.atencoes.some((x) => x.tipo === 'BL_ENCAMINHADO_ANTES_DA_APTIDAO'), 'a irregularidade do envio não some com o pagamento');
});

