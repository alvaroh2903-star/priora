import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARMADORES_DA_MATRIZ, NAO_INTEGRADA, agenciaDoArmador, codigoCanonicoDoArmador } from '../../index';
import {
  FORA, T, acaoPrincipal, apresentacao, armador, clienteOk, decidir, encaminhado, etapaDe, evento, execucaoRocket, fato, instante, integ, item,
  oficial, pagamento, procedimento, vazio, viagem,
} from './fixtures';

test('matriz armador × agência: exatamente a do cap. 26, por código canônico, sem aproximação', () => {
  assert.deepEqual([...ARMADORES_DA_MATRIZ].sort(), ['CMA_CGM', 'COSCO', 'EVERGREEN', 'HAPAG_LLOYD', 'HMM', 'MAERSK', 'MSC', 'ONE', 'OOCL', 'PIL', 'YANG_MING', 'ZIM']);
  const esperado: Record<string, string> = {
    ONE: 'UNIMAR', PIL: 'UNIMAR', HMM: 'UNIMAR', CMA_CGM: 'UNIMAR', COSCO: 'UNIMAR', OOCL: 'UNIMAR', YANG_MING: 'UNIMAR',
    MAERSK: 'MAERSK', MSC: 'MSC', HAPAG_LLOYD: 'ROCHAMAR', ZIM: 'ROCHAMAR', EVERGREEN: 'GRIEG',
  };
  for (const [a, ag] of Object.entries(esperado)) assert.equal(agenciaDoArmador(a), ag, a);
  for (const parecido of ['MAERSK LINE', 'CMACGM', 'CMA CGM LINES', 'C.M.A. CGM', 'HAPAG', 'MSCU', 'toString', 'constructor', '__proto__', '']) {
    assert.equal(agenciaDoArmador(parecido), null, parecido);
  }
});

test('[N8] CMA CGM → Unimar: diferença só de formatação no fato confiável não desmapeia; nada de aproximação nem prefixo', () => {
  for (const grafia of ['CMA CGM', 'CMA_CGM', 'cma-cgm', ' CMA  CGM ']) {
    assert.equal(codigoCanonicoDoArmador(grafia), 'CMA_CGM', grafia);
    assert.equal(agenciaDoArmador(grafia), 'UNIMAR', grafia);
  }
  for (const [grafia, agencia] of [['Hapag-Lloyd', 'ROCHAMAR'], ['Yang Ming', 'UNIMAR'], ['maersk', 'MAERSK']] as const) assert.equal(agenciaDoArmador(grafia), agencia);
  const d = decidir({ ...clienteOk(), armador: armador('CMA CGM') });
  assert.deepEqual(d.agencia.tipo === 'MAPEADA' && [d.agencia.agencia, d.agencia.armador, d.agencia.codigoInformado], ['UNIMAR', 'CMA_CGM', 'CMA CGM']);
  assert.equal(acaoPrincipal(d), 'AGENDAR_NO_PORTAL');
  // Parecido não é aceito: fora da matriz, segue a P11 (validar/mapear), nunca uma agência inferida.
  const parecido = decidir({ ...clienteOk(), armador: armador('CMA CGM LINES') });
  assert.equal(parecido.agencia.tipo, 'NAO_MAPEADA');
  // Nenhuma inferência por prefixo do MBL: sem fato de armador, não há agência (o MBL "CMDU…" não diz nada).
  const semFato = decidir({ ...clienteOk(), vinculo: { tipo: 'VINCULADO', vinculo: { processoId: 'IM100', masterId: 'CMDU1234567', vinculadoEm: T(1), evidencia: { fonte: 'auditoria', ref: 'x' } } } });
  assert.equal(semFato.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
});

test('[R17] Unimar e Maersk: agendar → aguardando confirmação (4) → confirmado (5) → Finalizado = apresentado (6/7); outra evidência não vale', () => {
  for (const codigo of ['ONE', 'MAERSK']) {
    const base = { ...clienteOk(), armador: armador(codigo) };
    assert.equal(acaoPrincipal(decidir(base)), 'AGENDAR_NO_PORTAL', codigo);
    const eventos = [evento('AGENDAMENTO_INICIADO', T(3)), evento('AGENDAMENTO_CONFIRMADO', T(4))];
    const enviado = decidir({ ...base, procedimento: procedimento(eventos, [], [encaminhado(T(5))]) });
    assert.equal(etapaDe(enviado), 'APTO_PARA_APRESENTACAO');
    assert.equal(acaoPrincipal(enviado), 'AGUARDAR_STATUS_FINALIZADO');
    assert.equal(enviado.subEtapa, null, 'Unimar/Maersk: o encaminhamento é só rastreabilidade');
    const recusado = decidir({ ...base, procedimento: procedimento(eventos, [apresentacao('MEMORANDO_CARIMBADO', T(6), 'ana')], [encaminhado(T(5))]) });
    assert.equal(recusado.apresentacao, null, `${codigo}: só o status Finalizado comprova`);
    assert.equal(recusado.apresentacoesRecusadas.length, 1);
  }
});

test('[R17] MSC e Rochamar: memorando (3) → enviar para apresentação (4) → carimbado + Analista (6); nunca etapa 5; preparar não é apresentar', () => {
  for (const codigo of ['MSC', 'HAPAG_LLOYD', 'ZIM']) {
    const base = { ...clienteOk(), armador: armador(codigo), pagamentoArmador: pagamento('PENDENTE', T(2)) };
    const inicio = decidir(base);
    assert.equal(etapaDe(inicio), 'APTO_PARA_PROCEDIMENTO', codigo);
    assert.equal(acaoPrincipal(inicio), 'PREPARAR_MEMORANDO');
    assert.equal(inicio.principal?.exigePortaoN13, 'INICIAR_PROCEDIMENTO');

    const preparado = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))]) });
    assert.equal(etapaDe(preparado), 'APTO_PARA_PROCEDIMENTO', 'memorando preparado não muda a etapa');
    assert.equal(acaoPrincipal(preparado), 'ENVIAR_PARA_APRESENTACAO');
    assert.equal(preparado.principal?.exigePortaoN13, 'APRESENTAR');
    assert.equal(preparado.apresentacao, null);

    const eventos = [evento('PREPARACAO_REGISTRADA', T(3))];
    const enc = [encaminhado(T(4))];
    const enviado = decidir({ ...base, procedimento: procedimento(eventos, [], enc) });
    assert.equal(etapaDe(enviado), 'PROCEDIMENTO_EM_ANDAMENTO');
    assert.equal(acaoPrincipal(enviado), 'AGUARDAR_MEMORANDO_CARIMBADO');
    assert.equal(enviado.subEtapa?.tipo, 'APRESENTACAO_EM_ANDAMENTO');
    assert.equal(enviado.subEtapa?.mensagem, 'Apresentação em andamento — aguardando memorando carimbado');
    const voltou = decidir({ ...base, procedimento: procedimento([...eventos, evento('RETORNO_CARIMBADO_RECEBIDO', T(5))], [], enc) });
    assert.equal(voltou.itens.find((i) => i.acao === 'CONFIRMAR_APRESENTACAO')?.classe, 'C');
    assert.equal(etapaDe(voltou), 'PROCEDIMENTO_EM_ANDAMENTO');

    const semAnalista = decidir({ ...base, procedimento: procedimento(eventos, [apresentacao('MEMORANDO_CARIMBADO', T(6), null)], enc) });
    assert.equal(semAnalista.apresentacao, null, 'carimbado sem confirmação do Analista não é apresentação');
    const apresentado = decidir({ ...base, procedimento: procedimento(eventos, [apresentacao('MEMORANDO_CARIMBADO', T(6), 'ana')], enc) });
    assert.equal(etapaDe(apresentado), 'MASTER_APRESENTADO');
    // Evento de outra agência é ignorado (não existe agendamento na MSC).
    const alheio = decidir({ ...base, procedimento: procedimento([evento('AGENDAMENTO_CONFIRMADO', T(3))]) });
    assert.equal(etapaDe(alheio), 'APTO_PARA_PROCEDIMENTO');
    assert.equal(alheio.procedimento.tipo === 'CONHECIDO' && alheio.procedimento.ignorados.length, 1);
  }
});

test('[R17][R20] Grieg/Evergreen: preparar (4) → atracação real + pagamento finalizado + portão (5) → protocolo + Analista (6); ATA não é atracação', () => {
  const base = { ...clienteOk(), armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)) };
  assert.equal(acaoPrincipal(decidir(base)), 'PREPARAR_MEMORANDO_E_AVISAR_APRESENTACAO');
  const prep = procedimento([evento('PREPARACAO_REGISTRADA', T(3))]);
  const soAta = decidir({ ...base, procedimento: prep, viagem: viagem({ ata: instante(T(8)) }) });
  assert.equal(etapaDe(soAta), 'PROCEDIMENTO_EM_ANDAMENTO', 'ATA sem atracação real não habilita');
  const atracado = decidir({ ...base, procedimento: prep, viagem: viagem({ atracacao: instante(T(8)) }) });
  assert.equal(etapaDe(atracado), 'APTO_PARA_APRESENTACAO');
  assert.equal(atracado.principal?.exigePortaoN13, 'APRESENTAR');
  const semViagem = decidir({ ...base, procedimento: prep, viagem: NAO_INTEGRADA });
  assert.equal(etapaDe(semViagem), 'NAO_DETERMINAVEL', 'atracação sem fonte: não se afirma nem 4 nem 5');

  const enviado = decidir({ ...base, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(9))]), viagem: viagem({ atracacao: instante(T(8)) }) });
  assert.equal(etapaDe(enviado), 'APTO_PARA_APRESENTACAO');
  assert.equal(acaoPrincipal(enviado), 'AGUARDAR_PROTOCOLO_CARIMBADO');
  const apresentado = decidir({
    ...base, viagem: viagem({ atracacao: instante(T(8)) }),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [apresentacao('PROTOCOLO_CARIMBADO', T(9, 6), 'ana')], [encaminhado(T(9))]),
  });
  assert.equal(etapaDe(apresentado), 'ACOMPANHANDO_DESBLOQUEIO', 'entregar o Master não é desbloqueio; acompanha-se o SISCARGA');
});

test('[R20] override do cliente não cobre a impossibilidade externa da Evergreen (atracação)', () => {
  const semPagamentoCliente = integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(2)));
  const ref = semPagamentoCliente.tipo === 'INTEGRADA' ? semPagamentoCliente.valor.oficial!.evidencia.ref : '';
  const ov = (acao: 'INICIAR_PROCEDIMENTO' | 'APRESENTAR', id: string) => ({
    id, processoId: 'IM100', pendencia: { dimensao: 'FINANCEIRO' as const, episodio: `FINANCEIRO|SEM_PAGAMENTO_E_SEM_PRAZO|${ref}` }, acao,
    cobreCondicaoDesconhecida: false, justificativa: 'ok', evidencias: [{ fonte: 'x', ref: 'y' }], solicitadoPor: { pessoaId: 'ana', papel: 'ANALYST' as const },
    solicitadoEm: T(3), decisao: { tipo: 'APROVADO' as const, por: { pessoaId: 'gil', papel: 'MANAGER' as const }, em: T(4), justificativa: 'ok', aceitaCondicaoDesconhecida: false }, executadoEm: null,
  });
  const d = decidir({
    ...clienteOk(), financeiroCliente: semPagamentoCliente, armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))]), overrides: [ov('INICIAR_PROCEDIMENTO', 'OV1'), ov('APRESENTAR', 'OV2')],
  });
  assert.equal(d.cliente.portoes.APRESENTAR.tipo, 'PERMITIDO');
  assert.equal(etapaDe(d), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.ok(!d.itens.some((i) => i.acao === 'APRESENTAR_EVERGREEN'));
  assert.ok(item(d, 'AGUARDANDO_ATRACACAO'));
});

test('[R18][N3] P11: armador conhecido fora da matriz → Preparação Operacional; a Rocket valida/mapeia o procedimento (C); nada de agendar/memorando/apresentar', () => {
  const fora = decidir({ ...clienteOk(), armador: armador('KMTC') });
  assert.equal(fora.agencia.tipo, 'NAO_MAPEADA');
  assert.equal(etapaDe(fora), 'PREPARACAO_OPERACIONAL');
  const i = item(fora, 'PROCEDIMENTO_DE_APRESENTACAO_NAO_MAPEADO');
  assert.deepEqual([i?.responsavel, i?.acao, i?.classe], ['ROCKET', 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO', 'C']);
  assert.equal(fora.principal, i, 'não some da atenção operacional');
  assert.ok(!fora.itens.some((x) => x.exigePortaoN13), 'nenhuma ação de procedimento/apresentação');
  assert.ok(!fora.itens.some((x) => ['AGENDAR_NO_PORTAL', 'PREPARAR_MEMORANDO', 'APRESENTAR_MASTER', 'ENVIAR_PARA_APRESENTACAO', 'APRESENTAR_EVERGREEN'].includes(x.acao ?? '')));
  // Mesmo com eventos de procedimento registrados, nenhuma agência é inferida.
  const comEventos = decidir({ ...clienteOk(), armador: armador('KMTC'), procedimento: procedimento([evento('AGENDAMENTO_CONFIRMADO', T(3))]) });
  assert.equal(etapaDe(comEventos), 'PREPARACAO_OPERACIONAL');

  // Fonte não integrada: não determinável (D-6), não é o caso P11 nem o P12.
  const semFonte = decidir({ ...clienteOk(), armador: NAO_INTEGRADA });
  assert.equal(semFonte.agencia.tipo, 'NAO_DETERMINAVEL');
  assert.equal(etapaDe(semFonte), 'NAO_DETERMINAVEL');
  assert.ok(semFonte.indeterminacao.semFonteIntegrada.includes('ARMADOR'));
  assert.ok(!item(semFonte, 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO'));
  // Fonte fora sem fato anterior: P9 (sem classe).
  assert.equal(decidir({ ...clienteOk(), armador: integ(vazio(), FORA()) }).agencia.tipo, 'NAO_DETERMINAVEL');
});

test('[N4] P12: Master resolvido sem armador confiável → inconsistência defensiva; a Rocket identifica o armador (C); nada inferido', () => {
  for (const armadorAusente of [integ(vazio<{ masterId: string; codigo: string }>()), armador('MSC', 'M2')]) {
    const d = decidir({ ...clienteOk(), armador: armadorAusente });
    assert.equal(d.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
    assert.equal(etapaDe(d), 'PREPARACAO_OPERACIONAL');
    const i = item(d, 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO');
    assert.deepEqual([i?.responsavel, i?.acao, i?.classe], ['ROCKET', 'IDENTIFICAR_ARMADOR_DO_MASTER', 'C']);
    assert.equal(i?.detalhe?.atencao, 'INCONSISTENCIA_DE_DADOS_DO_MASTER');
    assert.ok(!d.itens.some((x) => x.exigePortaoN13));
  }
  // Master NÃO resolvido sem armador: o caso P12 não se aplica (não há Master resolvido).
  assert.ok(!item(decidir({ armador: integ(vazio<{ masterId: string; codigo: string }>()) }), 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO'));
  // Com o fato confiável, a matriz normal vale.
  assert.equal(decidir({ ...clienteOk(), armador: armador('ONE') }).agencia.tipo, 'MAPEADA');
});

test('[R19] pagamento ao armador: pendente do lado Rocket (C, financeiro) × já pago aguardando baixa (D, externo); fonte fora não vira "não pago"', () => {
  const apresentado = { ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [apresentacao('MEMORANDO_CARIMBADO', T(5), 'ana')]) };
  const rocket = item(decidir({ ...apresentado, pagamentoArmador: pagamento('PENDENTE', T(5)) }), 'PAGAMENTO_AO_ARMADOR_PENDENTE');
  assert.deepEqual([rocket?.responsavel, rocket?.acao, rocket?.classe, rocket?.escopo], ['ROCKET_FINANCEIRO', 'PAGAR_ARMADOR', 'C', 'MASTER']);
  const externo = item(decidir({ ...apresentado, pagamentoArmador: pagamento('PENDENTE', T(5)), pagamentosExecutadosPelaRocket: [execucaoRocket(T(6))] }), 'PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO');
  assert.deepEqual([externo?.responsavel, externo?.acao, externo?.classe], ['ARMADOR', 'AGUARDAR_CONFIRMACAO_DO_PAGAMENTO_AO_ARMADOR', 'D']);

  const semRegistro = decidir({ ...apresentado });
  assert.equal(semRegistro.pagamentoArmador.estado, 'DESCONHECIDO');
  assert.equal(item(semRegistro, 'PAGAMENTO_AO_ARMADOR_INFORMACAO_INDISPONIVEL')?.classe, null);
  assert.equal(etapaDe(semRegistro), 'NAO_DETERMINAVEL');
  const foraSemFato = decidir({ ...apresentado, pagamentoArmador: integ({ masterId: 'M1', estado: vazio() }, FORA()) });
  assert.equal(foraSemFato.pagamentoArmador.estado, 'NAO_DETERMINAVEL');
  assert.ok(!foraSemFato.itens.some((i) => i.acao === 'PAGAR_ARMADOR'));
  const foraComFato = decidir({ ...apresentado, pagamentoArmador: integ({ masterId: 'M1', estado: oficial({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(5)) }, FORA()) });
  assert.equal(etapaDe(foraComFato), 'ACOMPANHANDO_DESBLOQUEIO', 'N-17: PAGO continua pago com o HeadCargo fora');
  assert.equal(decidir({ ...apresentado, pagamentoArmador: pagamento('FINALIZADO', T(5), 'M2') }).pagamentoArmador.estado, 'DESCONHECIDO', 'pagamento de outro Master não conta');
});

test('[R21] etapa 6 → 7: apresentado fica em Master Apresentado até a condição financeira; reversão volta a 6 e desfaz a janela', () => {
  const apresentado = { ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(5))]) };
  const seis = decidir({ ...apresentado, pagamentoArmador: pagamento('PENDENTE', T(5)) });
  assert.equal(etapaDe(seis), 'MASTER_APRESENTADO');
  assert.deepEqual(seis.janela, { estado: 'NAO_INICIADA', faltam: ['CONDICAO_FINANCEIRA'] });
  const sete = decidir({ ...apresentado, pagamentoArmador: pagamento('FINALIZADO', T(6)) });
  assert.equal(etapaDe(sete), 'ACOMPANHANDO_DESBLOQUEIO');
  const revertido = decidir({ ...apresentado, pagamentoArmador: pagamento('PENDENTE', T(7), 'M1', [fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(6))]) });
  assert.equal(etapaDe(revertido), 'MASTER_APRESENTADO');
  assert.equal(item(revertido, 'PAGAMENTO_AO_ARMADOR_PENDENTE')?.detalhe?.reversao, true);
  assert.equal(revertido.janela.estado, 'NAO_INICIADA');
});

test('[R22] Maersk: a apresentação basta; a janela de 48h começa na apresentação', () => {
  const maersk = { ...clienteOk(), armador: armador('MAERSK'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(5))]) };
  const d = decidir({ ...maersk, agora: T(6) });
  assert.equal(etapaDe(d), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.equal(d.pagamentoArmador.estado, 'ISENTO_MAERSK');
  assert.ok(!d.itens.some((i) => i.acao === 'PAGAR_ARMADOR'));
  assert.equal(d.janela.estado, 'EM_CURSO');
  assert.equal(d.janela.estado === 'EM_CURSO' && d.janela.vencimento.ate, '2026-10-07T00:00:00.000Z');
  assert.equal(decidir({ ...maersk, agora: T(7) }).janela.estado, 'VENCIDA');
});
