import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aplicarPortaoCompartilhado, decidirProcesso, itemDeFila, montarVisao, ordenarPorPrioridade, validarTermoPorEmbarque,
} from '../../index';
import {
  FORA, T, acaoPrincipal, apresentacao, armador, clienteOk, courier, data, decidir, encaminhado, etapaDe, ev, evento, fato, instante,
  integ, item, mundo, oficial, override, pagamento, procedimento, vazio, viagem, vinculo,
} from './fixtures';

/** Os 15 cenários de aceitação do cap. 43, na ordem do Blueprint. */

test('[cap.43 #1] físico Recebido + cliente OK + Unimar → agendamento → Finalizado = apresentado → condição financeira → SISCARGA sem pendências', () => {
  const base = { ...clienteOk(), armador: armador('ONE') };
  const apto = decidir(base);
  assert.equal(etapaDe(apto), 'APTO_PARA_PROCEDIMENTO');
  assert.equal(acaoPrincipal(apto), 'AGENDAR_NO_PORTAL');
  assert.equal(apto.principal?.classe, 'C');
  assert.equal(apto.principal?.exigePortaoN13, 'INICIAR_PROCEDIMENTO');

  const iniciado = decidir({ ...base, procedimento: procedimento([evento('AGENDAMENTO_INICIADO', T(3))]) });
  assert.equal(etapaDe(iniciado), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.equal(acaoPrincipal(iniciado), 'AGUARDAR_CONFIRMACAO_DO_AGENDAMENTO');
  assert.equal(iniciado.principal?.classe, 'D');

  const eventos = [evento('AGENDAMENTO_INICIADO', T(3)), evento('AGENDAMENTO_CONFIRMADO', T(4))];
  const confirmado = decidir({ ...base, procedimento: procedimento(eventos) });
  assert.equal(etapaDe(confirmado), 'APTO_PARA_APRESENTACAO');
  assert.equal(acaoPrincipal(confirmado), 'APRESENTAR_MASTER');
  assert.equal(confirmado.principal?.exigePortaoN13, 'APRESENTAR');

  // Status Finalizado: suficiente, sem confirmação humana adicional (cap. 27, 30).
  const finalizado = procedimento(eventos, [apresentacao('STATUS_FINALIZADO_PORTAL', T(5))]);
  const apresentado = decidir({ ...base, procedimento: finalizado, pagamentoArmador: pagamento('PENDENTE', T(5)) });
  assert.equal(etapaDe(apresentado), 'MASTER_APRESENTADO');
  assert.equal(acaoPrincipal(apresentado), 'PAGAR_ARMADOR');
  assert.equal(apresentado.principal?.responsavel, 'ROCKET_FINANCEIRO');

  const pago = { ...base, procedimento: finalizado, pagamentoArmador: pagamento('FINALIZADO', T(6)) };
  assert.equal(etapaDe(decidir(pago)), 'ACOMPANHANDO_DESBLOQUEIO');

  const liberado = decidir({
    ...pago, ceHouse: integ(oficial({ numero: 'CEH1' }, T(6))), siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(8))),
    siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(8))),
    verificacaoFinal: { ceHouse: 'CEH1', sucesso: true, executadaEm: T(9), frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', evidencia: ev('siscarga-final') },
  });
  assert.equal(etapaDe(liberado), 'LIBERADO');
  assert.deepEqual(liberado.liberado, {
    tipo: 'PROVA_SISCARGA', em: T(9), evidencia: ev('siscarga-final'), ceHouse: 'CEH1', frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', fonte: 'SISCARGA',
  });
  assert.deepEqual(liberado.progresso.map((m) => m.marco), [
    'MASTER_RESOLVIDO', 'HOUSE_RESOLVIDO', 'CLIENTE_CONCLUIDO', 'PROCEDIMENTO_INICIADO', 'MASTER_APRESENTADO', 'CONDICAO_FINANCEIRA_DO_ARMADOR', 'LIBERADO',
  ]);
});

test('[cap.43 #2] Wave confirmado + cliente com prazo → apresentação antecipada → acompanhamento sem falso alerta de 48h com ETA distante', () => {
  const d = decidir({
    ...clienteOk(),
    courier: courier({ hblOriginal: fato('RECEBIDO_E_CONFERIDO' as const, T(2)) }),
    wave: integ([{ masterId: 'M1', acaoEm: T(2), ultimaConfirmacaoEm: T(2), evidencia: ev('email-wave'), processosVinculadosNaAcao: ['IM100'] }]),
    financeiroCliente: integ(oficial({ situacao: 'PRAZO' as const, validoAte: T(30), reconfirmarAte: null }, T(1))),
    armador: armador('MSC'),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [apresentacao('MEMORANDO_CARIMBADO', T(5), 'ana')], [encaminhado(T(4))]),
    pagamentoArmador: pagamento('FINALIZADO', T(5)),
    viagem: viagem({ eta: data('2026-12-01') }),
    ceHouse: integ(oficial({ numero: 'CEH1' }, T(5))),
    siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(6))),
    agora: T(12),
  });
  assert.equal(d.master.modalidadeAtual?.tipo === 'UNICA' && d.master.modalidadeAtual.modalidade, 'WAVE');
  assert.equal(etapaDe(d), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.equal(d.janela.estado, 'VENCIDA', 'a janela venceu');
  assert.equal(d.cobranca.estado, 'AGUARDANDO_ATRACACAO', 'mas o navio está longe: nada de cobrança');
  assert.ok(!d.itens.some((i) => i.acao === 'COBRAR_ARMADOR_DESBLOQUEIO'));
  assert.ok(!d.itens.some((i) => i.classe === 'A'));
  assert.equal(acaoPrincipal(d), 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA');
  assert.equal(d.principal?.visao, 'ACOMPANHAMENTO');
});

test('[cap.43 #3] emissão no destino informada, autorização da origem ainda não recebida → Master não resolvido', () => {
  const identificada = { fatosDoMasterL1a: [{ tipo: 'MODALIDADE_IDENTIFICADA' as const, masterId: 'M1', modalidade: 'EMISSAO_DESTINO' as const, acaoEm: T(2), evidencia: ev('email-agente') }] };
  const semConsulta = decidir(identificada);
  assert.deepEqual(semConsulta.master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'EMISSAO_DESTINO_SEM_CONSULTA_AO_ARMADOR' });
  assert.equal(etapaDe(semConsulta), 'PREPARACAO_PARA_LIBERACAO');
  assert.equal(acaoPrincipal(semConsulta), 'CONSULTAR_ARMADOR_EMISSAO_DESTINO');
  assert.equal(semConsulta.principal?.classe, 'C');

  const consultado = decidir({
    ...identificada, emissaoDestino: integ({ consultasAoArmador: [{ masterId: 'M1', em: T(3), evidencia: ev('consulta') }], autorizacoes: [] }),
  });
  assert.deepEqual(consultado.master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'EMISSAO_DESTINO_AGUARDANDO_AUTORIZACAO' });
  const espera = item(consultado, 'EMISSAO_DESTINO_AGUARDANDO_AUTORIZACAO');
  assert.equal(espera?.responsavel, 'ARMADOR');
  assert.equal(espera?.acao, 'AGUARDAR_AUTORIZACAO_DA_ORIGEM');
  assert.equal(espera?.classe, 'D');
  assert.equal(etapaDe(consultado), 'PREPARACAO_PARA_LIBERACAO');
  assert.ok(!consultado.progresso.some((m) => m.marco === 'MASTER_RESOLVIDO'));
});

test('[cap.43 #4] Master não localizado existe enquanto não há modalidade/evidência válida; a partir de T-10 a atenção cresce (C → B)', () => {
  const longe = decidir({ viagem: viagem({ eta: data('2026-11-30') }) });
  assert.deepEqual(longe.master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'MASTER_NAO_LOCALIZADO' });
  assert.equal(longe.principal?.motivo, 'MASTER_NAO_LOCALIZADO');
  assert.equal(longe.principal?.classe, 'C');
  assert.ok(longe.filtros.includes('MASTER_NAO_LOCALIZADO'));

  const t10 = decidir({ viagem: viagem({ eta: data('2026-10-19') }), agora: T(9, 12) });
  assert.equal(t10.principal?.classe, 'B');

  const resolvido = decidir({
    viagem: viagem({ eta: data('2026-10-19') }), agora: T(9, 12),
    wave: integ([{ masterId: 'M1', acaoEm: T(5), ultimaConfirmacaoEm: T(5), evidencia: ev('wave'), processosVinculadosNaAcao: ['IM100'] }]),
  });
  assert.equal(resolvido.master.frente.estado, 'RESOLVIDO');
  assert.ok(!resolvido.itens.some((i) => i.motivo === 'MASTER_NAO_LOCALIZADO'));
});

test('[cap.43 #5] HBL físico: decisão final sempre do Analista; divergência da IA e baixa legibilidade são alerta, não bloqueio', () => {
  const foto = { recebidaEm: T(3), evidencia: ev('foto-hbl', 'portal'), alertasOcr: ['NUMERO_DIVERGENTE', 'BAIXA_LEGIBILIDADE'] };
  const aguardando = decidir({ fotosHbl: integ([{ ...foto, decisao: null }]) });
  assert.equal(aguardando.house.resultado.estado, 'PENDENTE');
  const pendente = item(aguardando, 'FOTO_DO_HBL_AGUARDANDO_ANALISTA');
  assert.equal(pendente?.acao, 'VALIDAR_HBL_FISICO');
  assert.equal(pendente?.responsavel, 'ROCKET');
  assert.equal(pendente?.classe, 'C');
  assert.deepEqual(aguardando.house.alertasOcr, ['NUMERO_DIVERGENTE', 'BAIXA_LEGIBILIDADE']);

  const confirmado = decidir({
    fotosHbl: integ([{ ...foto, decisao: { tipo: 'CONFIRMADO', por: 'ana', em: T(4), motivo: null, evidencia: ev('analista-ok') } }]),
  });
  assert.equal(confirmado.house.resultado.estado, 'RESOLVIDO');
  assert.equal(confirmado.house.resultado.estado === 'RESOLVIDO' && confirmado.house.resultado.detalhe, 'A_FOTO_CONFIRMADA_PELO_ANALISTA');
});

test('[cap.43 #6] Termo por Embarque: outorgado válido com assinatura digital → aprovação automática; signatário fora da procuração → reprovação explícita', () => {
  const extracao = {
    camposObrigatoriosFaltantes: [], assinadoEm: T(3), signatario: { identificavel: true, identificador: 'CPF:111' },
    procuracao: { conteudoInequivoco: true, outorgados: ['CPF:111', 'CPF:222'], validaAte: T(30), poderes: 'SUFICIENTES' as const },
  };
  assert.deepEqual(validarTermoPorEmbarque(extracao), { resultado: 'APROVADO_AUTOMATICO' });
  assert.deepEqual(
    validarTermoPorEmbarque({ ...extracao, signatario: { identificavel: true, identificador: 'CPF:999' } }),
    { resultado: 'REPROVADO', motivos: ['SIGNATARIO_NAO_OUTORGADO'] },
  );
  const reprovado = decidir({
    termoUnico: integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))),
    termoEmbarque: integ({ situacao: 'ENVIADO', em: T(3), evidencia: ev('termo'), validacao: validarTermoPorEmbarque({ ...extracao, signatario: { identificavel: true, identificador: 'CPF:999' } }), revisao: null }),
  });
  const t = item(reprovado, 'TERMO_POR_EMBARQUE_REPROVADO');
  assert.equal(t?.responsavel, 'CLIENTE');
  assert.deepEqual(t?.detalhe?.motivos, ['SIGNATARIO_NAO_OUTORGADO']);
});

test('[cap.43 #7] cliente pendente + tentativa de prosseguir → só por override solicitado pelo Analista e aprovado pelo Gestor', () => {
  const semPagamento = integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(2), []));
  const episodio = `FINANCEIRO|SEM_PAGAMENTO_E_SEM_PRAZO|${semPagamento.tipo === 'INTEGRADA' ? semPagamento.valor.oficial!.evidencia.ref : ''}`;
  const base = { ...clienteOk(), financeiroCliente: semPagamento, armador: armador('ONE') };

  const bloqueado = decidir(base);
  assert.equal(etapaDe(bloqueado), 'PREPARACAO_OPERACIONAL');
  assert.equal(bloqueado.cliente.portoes.INICIAR_PROCEDIMENTO.tipo, 'BLOQUEADO');
  assert.ok(!bloqueado.itens.some((i) => i.acao === 'AGENDAR_NO_PORTAL'), 'sem override, a ação não é execução normal');

  const pedido = override({ pendencia: { dimensao: 'FINANCEIRO', episodio }, decisao: null });
  const aguardando = decidir({ ...base, overrides: [pedido] });
  assert.equal(aguardando.cliente.portoes.INICIAR_PROCEDIMENTO.tipo, 'BLOQUEADO');
  assert.deepEqual(aguardando.cliente.overrides, [{ id: 'OV1', situacao: 'AGUARDANDO_APROVACAO' }]);

  const aprovado = decidir({ ...base, overrides: [override({ pendencia: { dimensao: 'FINANCEIRO', episodio } })] });
  assert.equal(etapaDe(aprovado), 'APTO_PARA_PROCEDIMENTO');
  assert.deepEqual(aprovado.cliente.portoes.INICIAR_PROCEDIMENTO, {
    tipo: 'PERMITIDO', via: 'OVERRIDE', tecnicamentePossivel: true, overrides: ['OV1'], pendenciasCobertas: ['FINANCEIRO'],
  });
  assert.ok(item(aprovado, 'FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO'), 'a pendência original continua visível');
  assert.equal(aprovado.cliente.dimensoes.FINANCEIRO.estado, 'PENDENTE');
  assert.equal(aprovado.cliente.portoes.APRESENTAR.tipo, 'BLOQUEADO', 'INICIAR_PROCEDIMENTO não autoriza APRESENTAR');
});

test('[cap.43 #8] Evergreen antes da atracação ou sem pagamento → não apta para apresentação', () => {
  const base = { ...clienteOk(), armador: armador('EVERGREEN'), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))]) };
  const semAtracacao = decidir({ ...base, pagamentoArmador: pagamento('FINALIZADO', T(3)) });
  assert.equal(etapaDe(semAtracacao), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.ok(item(semAtracacao, 'AGUARDANDO_ATRACACAO'));
  assert.ok(!semAtracacao.itens.some((i) => i.acao === 'APRESENTAR_EVERGREEN'));

  const semPagamento = decidir({ ...base, pagamentoArmador: pagamento('PENDENTE', T(3)), viagem: viagem({ atracacao: instante(T(8)) }) });
  assert.equal(etapaDe(semPagamento), 'PROCEDIMENTO_EM_ANDAMENTO');
  assert.equal(acaoPrincipal(semPagamento), 'PAGAR_ARMADOR');

  const apta = decidir({ ...base, pagamentoArmador: pagamento('FINALIZADO', T(3)), viagem: viagem({ atracacao: instante(T(8)) }) });
  assert.equal(etapaDe(apta), 'APTO_PARA_APRESENTACAO');
  assert.equal(acaoPrincipal(apta), 'APRESENTAR_EVERGREEN');
});

test('[cap.43 #9] CE House ausente a T-48h → risco regulatório, não culpa da Rocket; atraso comprovado + bloqueio fiscal → e-CAC → reconsulta', () => {
  const risco = decidir({ viagem: viagem({ atracacaoPrevista: data('2026-10-12') }), agora: T(10, 5) });
  const c = risco.regulatorio.find((x) => x.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48');
  assert.ok(c && c.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48');
  assert.equal(c.mensagem, 'CE House não identificado — verificar desconsolidação');
  assert.equal(c.falhaDaRocket, null);
  assert.ok(!risco.itens.some((i) => i.acao === 'VERIFICAR_DESCONSOLIDACAO'), 'regulatório não vira item da Fila');
  assert.ok(risco.filtros.includes('CE_PRAZOS_REGULATORIOS'));

  const falha = { obrigacao: 'enviar o pré-alerta à desconsolidação', evidencia: ev('email-enviado-tarde', 'auditoria') };
  const comFalha = decidir({ viagem: viagem({ atracacaoPrevista: data('2026-10-12') }), agora: T(10, 5), falhaDaRocket: falha });
  assert.deepEqual(comFalha.regulatorio.find((x) => x.tipo === 'CE_HOUSE_NAO_IDENTIFICADO_T48' && x.falhaDaRocket)?.tipo, 'CE_HOUSE_NAO_IDENTIFICADO_T48');

  const fiscal = { ceHouse: integ(oficial({ numero: 'CEH1' }, T(11))), siscargaFiscal: integ(oficial({ situacao: 'COM_PENDENCIA' as const, causa: 'CE_HOUSE_FORA_DO_PRAZO' }, T(12))), agora: T(12, 1) };
  const antesDoEcac = decidir(fiscal);
  const p1 = antesDoEcac.regulatorio.find((x) => x.tipo === 'PENDENCIA_FISCAL');
  assert.equal(p1?.tipo === 'PENDENCIA_FISCAL' && p1.acao, 'SOLICITAR_DESBLOQUEIO_FISCAL_NO_ECAC');
  assert.equal(p1?.tipo === 'PENDENCIA_FISCAL' && p1.causa, 'CE_HOUSE_FORA_DO_PRAZO');
  const depoisDoEcac = decidir({ ...fiscal, ecac: [{ em: T(12, 2), evidencia: ev('ecac') }] });
  const p2 = depoisDoEcac.regulatorio.find((x) => x.tipo === 'PENDENCIA_FISCAL');
  assert.equal(p2?.tipo === 'PENDENCIA_FISCAL' && p2.acao, 'RECONSULTAR_PENDENCIA_FISCAL');
  const liberadoDepois = decidir({
    ...fiscal, siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(13))), siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(13))),
    verificacaoFinal: { ceHouse: 'CEH1', sucesso: true, executadaEm: T(13, 1), frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', evidencia: ev('final') }, agora: T(13, 2),
  });
  assert.equal(etapaDe(liberadoDepois), 'LIBERADO');
});

test('[cap.43 #10] alteração de rota → o armador retifica o CE Master antes de a Rocket retificar o CE House', () => {
  const alteracao = fato({ descricao: 'omissão do porto de Itajaí' }, T(3));
  const antes = decidir({ rota: integ({ alteracao, ceMasterRetificado: null, ceHouseRetificado: null }) });
  const r1 = antes.regulatorio.find((x) => x.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA');
  assert.equal(r1?.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && r1.responsavel, 'ARMADOR');
  assert.equal(r1?.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && r1.fase, 'AGUARDANDO_RETIFICACAO_DO_CE_MASTER');

  // CE House "retificado" antes do CE Master não conta: a sequência é obrigatória.
  const foraDeOrdem = decidir({ rota: integ({ alteracao, ceMasterRetificado: null, ceHouseRetificado: fato(true as const, T(4)) }) });
  const r2 = foraDeOrdem.regulatorio.find((x) => x.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA');
  assert.equal(r2?.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && r2.fase, 'AGUARDANDO_RETIFICACAO_DO_CE_MASTER');

  const masterOk = decidir({ rota: integ({ alteracao, ceMasterRetificado: fato(true as const, T(5)), ceHouseRetificado: null }) });
  const r3 = masterOk.regulatorio.find((x) => x.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA');
  assert.equal(r3?.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && r3.fase, 'RETIFICAR_CE_HOUSE');
  assert.equal(r3?.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && r3.responsavel, 'DESCONSOLIDACAO');
});

test('[cap.43 #11] Master compartilhado: apresentação propagada a todas as Houses; CE House e liberação individuais', () => {
  const apresentadoNoMaster = { tipo: 'MASTER_APRESENTADO' as const, masterId: 'M1', acaoEm: T(5), evidencia: ev('apresentacao'), processosVinculadosNaAcao: ['IM100', 'IM101'] };
  const comum = { ...clienteOk(), armador: armador('MAERSK'), fatosDoMasterL1a: [apresentadoNoMaster] };
  const im100 = decidirProcesso(mundo({
    ...comum, processoId: 'IM100', vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM100', 'M1') },
    ceHouse: integ(oficial({ numero: 'CEH100' }, T(6))), siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(8))),
    siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(8))),
    verificacaoFinal: { ceHouse: 'CEH100', sucesso: true, executadaEm: T(9), frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', evidencia: ev('final-100') },
  }));
  const im101 = decidirProcesso(mundo({
    ...comum, processoId: 'IM101', vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM101', 'M1') },
    ceHouse: integ(oficial({ numero: 'CEH101' }, T(6))), siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(8))),
  }));
  for (const d of [im100, im101]) assert.ok(d.progresso.some((m) => m.marco === 'MASTER_APRESENTADO'), d.processoId);
  assert.equal(etapaDe(im100), 'LIBERADO');
  assert.equal(etapaDe(im101), 'ACOMPANHANDO_DESBLOQUEIO');
});

test('[cap.43 #12] HeadCargo/SISCARGA/Courier indisponíveis → desconhecido/não confirmável; nunca não pago, não recebido ou não liberado', () => {
  const d = decidir({
    courier: courier({ fonte: FORA() }),
    financeiroCliente: integ(vazio(), FORA()),
    termoUnico: integ(vazio(), FORA()),
    siscargaFrete: integ(vazio(), FORA()),
  });
  assert.equal(d.master.frente.estado, 'NAO_DETERMINAVEL', 'Courier fora: nada de "não recebido"');
  assert.ok(!d.itens.some((i) => i.motivo === 'MASTER_NAO_LOCALIZADO'));
  assert.equal(d.cliente.dimensoes.FINANCEIRO.estado, 'DESCONHECIDO');
  assert.ok(!d.itens.some((i) => i.responsavel === 'CLIENTE'), 'nunca "não pago"');
  assert.equal(d.liberado, null);

  // Fato anterior: PAGO às 10h, HeadCargo fora às 11h → continua pago (N-17).
  const pagoAntes = decidir({ ...clienteOk(), financeiroCliente: integ(oficial({ situacao: 'PAGO' as const, validoAte: null, reconfirmarAte: null }, T(1)), FORA()) });
  assert.equal(pagoAntes.cliente.dimensoes.FINANCEIRO.estado, 'RESOLVIDO');

  // SISCARGA fora depois de sem pendência, sem verificação final: não se declara LIBERADO.
  const semFinal = decidir({ ceHouse: integ(oficial({ numero: 'CEH1' }, T(2))), siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(3)), FORA()), siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(3)), FORA()) });
  assert.equal(semFinal.liberado, null);
});

test('[cap.43 #13] CE House "Não Há Pendência" → LIBERADO terminal com prova preservada; nada posterior reabre', () => {
  const prova = { tipo: 'PROVA_SISCARGA' as const, em: T(9), evidencia: ev('final'), ceHouse: 'CEH1', frete: 'SEM_PENDENCIA' as const, fiscal: 'SEM_PENDENCIA' as const, fonte: 'SISCARGA' as const };
  const depois = decidir({
    liberado: prova, siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(11))), agora: T(12),
    fatosDoMasterL1a: [{ tipo: 'MODALIDADE_IDENTIFICADA', masterId: 'M1', modalidade: 'WAVE', acaoEm: T(11), evidencia: ev('nova') }],
  });
  assert.equal(etapaDe(depois), 'LIBERADO');
  assert.deepEqual(depois.liberado, prova);
  assert.deepEqual(depois.itens, []);
  assert.deepEqual(depois.bloqueador, { tipo: 'NENHUM' });
  assert.deepEqual(depois.proximaAcao, { tipo: 'NENHUMA' });
});

test('[cap.43 #14] CE Master: existência inferível pelo CE House; tempestividade de 72h não verificável', () => {
  const d = decidir({ ceHouse: integ(oficial({ numero: 'CEH1' }, T(5))) });
  assert.deepEqual(d.regulatorio.find((c) => c.tipo === 'CE_MASTER_INFERIDO'), {
    tipo: 'CE_MASTER_INFERIDO', existencia: 'INFERIDA_PELO_CE_HOUSE', tempestividade72h: 'NAO_VERIFICAVEL',
  });
  const sem = decidir();
  assert.ok(!sem.regulatorio.some((c) => c.tipo === 'CE_MASTER_INFERIDO'));
});

test('[cap.43 #15] prioridade: ATA = chegada ocorrida; sem ATA, ETA; mesma classe → temporalidade → proximidade → tempo aguardando', () => {
  const conferir = (processoId: string, p: Parameters<typeof mundo>[0]) => decidirProcesso(mundo({
    processoId, vinculo: { tipo: 'VINCULADO', vinculo: vinculo(processoId, `M-${processoId}`) },
    fatosDoMasterL1a: [{ tipo: 'MODALIDADE_IDENTIFICADA', masterId: `M-${processoId}`, modalidade: 'FISICO', acaoEm: T(1), evidencia: ev('m') }],
    courier: courier({ envelope: fato('ENTREGUE' as const, T(2)) }), ...p,
  }));
  const chegou = conferir('IM1', { viagem: viagem({ ata: instante(T(9)), eta: instante(T(9)) }) });
  const etaPerto = conferir('IM2', { viagem: viagem({ eta: instante(T(15)) }) });
  const etaLonge = conferir('IM3', { viagem: viagem({ eta: instante(T(25)) }) });
  const semEta = conferir('IM4', {});
  for (const d of [chegou, etaPerto, etaLonge, semEta]) assert.equal(d.principal?.classe, 'C', d.processoId);
  const fila = ordenarPorPrioridade([semEta, etaLonge, chegou, etaPerto].map((d) => itemDeFila(d, 'FILA_PRINCIPAL')!));
  assert.deepEqual(fila.map((i) => i.processos[0]), ['IM1', 'IM2', 'IM3', 'IM4']);
  assert.equal(fila[3].referenciaTemporalIndisponivel, true);

  // Mesmo ETA: a etapa mais avançada vem antes; mesma etapa: há mais tempo aguardando.
  const mesmaEta = { viagem: viagem({ eta: instante(T(20)) }), ...clienteOk() };
  const procedimentoM = (pid: string) => ({ processoId: pid, vinculo: { tipo: 'VINCULADO' as const, vinculo: vinculo(pid, `M-${pid}`) } });
  const apto = decidirProcesso(mundo({ ...mesmaEta, ...procedimentoM('IM5'), armador: armador('ONE', 'M-IM5') }));
  const confirmar = decidirProcesso(mundo({
    ...mesmaEta, ...procedimentoM('IM6'), armador: armador('MSC', 'M-IM6'),
    procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3), 'M-IM6'), evento('RETORNO_CARIMBADO_RECEBIDO', T(5), 'M-IM6')], [], [encaminhado(T(4), 'ana', 'MSC', 'M-IM6')]),
  }));
  assert.equal(etapaDe(apto), 'APTO_PARA_PROCEDIMENTO');
  assert.equal(etapaDe(confirmar), 'PROCEDIMENTO_EM_ANDAMENTO');
  const ordem = montarVisao(aplicarPortaoCompartilhado([apto, confirmar]), 'FILA_PRINCIPAL');
  assert.deepEqual(ordem.map((i) => i.processos[0]), ['IM6', 'IM5']);
});
