import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PagamentoDoArmador, ProvaDeLiberacao, chaveDaEta, frentePagamento, itemDeFila, precedeComCerteza, situacaoDaViagem, validarTermoPorEmbarque,
} from '../../index';
import {
  T, apresentacao, armador, clienteOk, data, decidir, encaminhado, etapaDe, ev, evento, execucaoRocket, fato, instante, integ, item, oficial,
  pagamento, procedimento, vazio, viagem, vinculo,
} from './fixtures';

/** Correções finais da L1b: P10–P13 e as correções técnicas aprovadas ([N1]…[N15]). */

const griegElegivel = {
  ...clienteOk(), armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(8)) }),
};
const marcos = (d: ReturnType<typeof decidir>) => d.progresso.map((m) => m.marco);

/* ------------------------------------------ P10 ------------------------------------------ */

test('[N1] P10: Grieg depois de "Enviar para apresentação" continua em Apto para Apresentação, com APRESENTACAO_EM_ANDAMENTO', () => {
  const apta = decidir({ ...griegElegivel, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))]) });
  assert.equal(etapaDe(apta), 'APTO_PARA_APRESENTACAO');
  assert.equal(apta.subEtapa, null);
  const enviado = decidir({ ...griegElegivel, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(9))]) });
  assert.equal(etapaDe(enviado), 'APTO_PARA_APRESENTACAO', 'não regride para Procedimento em Andamento');
  assert.equal(enviado.subEtapa?.tipo, 'APRESENTACAO_EM_ANDAMENTO');
  assert.equal(enviado.subEtapa?.mensagem, 'Apresentação em andamento — aguardando protocolo carimbado');
  assert.equal(enviado.subEtapa?.desde, T(9));
  assert.equal(enviado.principal?.acao, 'AGUARDAR_PROTOCOLO_CARIMBADO');
  // Nova pendência financeira DEPOIS de um envio válido: a etapa 5 é preservada (decisão final 13.5) e a pendência aparece.
  const revertido = decidir({
    ...griegElegivel, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(9))]),
    pagamentoArmador: pagamento('PENDENTE', T(9, 6), 'M1', [fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(2))]),
  });
  assert.equal(etapaDe(revertido), 'APTO_PARA_APRESENTACAO');
  assert.ok(item(revertido, 'PAGAMENTO_AO_ARMADOR_PENDENTE'));
  assert.equal(revertido.subEtapa?.tipo, 'APRESENTACAO_EM_ANDAMENTO');
});

test('[N2] P10: Grieg só é MASTER_APRESENTADO com protocolo carimbado + confirmação do Analista', () => {
  const eventos = [evento('PREPARACAO_REGISTRADA', T(3))];
  const enc = [encaminhado(T(9))];
  const semProtocolo = decidir({ ...griegElegivel, procedimento: procedimento(eventos, [], enc) });
  const voltou = decidir({ ...griegElegivel, procedimento: procedimento([...eventos, evento('RETORNO_CARIMBADO_RECEBIDO', T(10))], [], enc) });
  const semAnalista = decidir({ ...griegElegivel, procedimento: procedimento(eventos, [apresentacao('PROTOCOLO_CARIMBADO', T(10), null)], enc) });
  const outraEvidencia = decidir({ ...griegElegivel, procedimento: procedimento(eventos, [apresentacao('STATUS_FINALIZADO_PORTAL', T(10), 'ana')], enc) });
  for (const d of [semProtocolo, voltou, semAnalista, outraEvidencia]) {
    assert.equal(d.apresentacao, null);
    assert.ok(!marcos(d).includes('MASTER_APRESENTADO'));
    assert.equal(etapaDe(d), 'APTO_PARA_APRESENTACAO');
  }
  assert.equal(voltou.principal?.acao, 'CONFIRMAR_APRESENTACAO');
  const confirmado = decidir({ ...griegElegivel, procedimento: procedimento(eventos, [apresentacao('PROTOCOLO_CARIMBADO', T(10), 'ana')], enc) });
  assert.ok(marcos(confirmado).includes('MASTER_APRESENTADO'));
  assert.equal(etapaDe(confirmado), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.equal(confirmado.subEtapa, null);
});

/* ------------------------------------------ P13 ------------------------------------------ */

test('[N5] P13: BL_ENCAMINHADO_PARA_APRESENTACAO preservado com Master, fluxo, autor, instante e evidência; sem autor não vale', () => {
  const enc = encaminhado(T(9), 'ana', 'MSC');
  const d = decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [enc]) });
  assert.deepEqual(d.procedimento.tipo === 'CONHECIDO' && d.procedimento.encaminhamentos, [enc]);
  const m = d.progresso.find((x) => x.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO');
  assert.deepEqual([m?.ator, m?.em, m?.escopo, m?.evidencia], ['ana', T(9), 'MASTER', ev(`encaminhado@${T(9)}`, 'analista')]);
  assert.deepEqual(d.subEtapa?.encaminhamento, enc);
  const semAutor = decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [], [encaminhado(T(9), '  ')]) });
  assert.equal(semAutor.procedimento.tipo === 'CONHECIDO' && semAutor.procedimento.encaminhamentosRecusados.length, 1);
  assert.equal(semAutor.subEtapa, null);
  assert.ok(!marcos(semAutor).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'));
  // Encaminhamento de outro Master não é deste.
  assert.ok(!marcos(decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [], [encaminhado(T(9), 'ana', 'MSC', 'M2')]) })).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'));
});

test('[N6] P13: encaminhado ≠ apresentado, em todos os fluxos', () => {
  const casos: Array<[string, Parameters<typeof decidir>[0]]> = [
    ['ONE', { ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([evento('AGENDAMENTO_INICIADO', T(3)), evento('AGENDAMENTO_CONFIRMADO', T(4))], [], [encaminhado(T(5))]) }],
    ['MAERSK', { ...clienteOk(), armador: armador('MAERSK'), procedimento: procedimento([evento('AGENDAMENTO_CONFIRMADO', T(4))], [], [encaminhado(T(5))]) }],
    ['MSC', { ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(5))]) }],
    ['ZIM', { ...clienteOk(), armador: armador('ZIM'), procedimento: procedimento([], [], [encaminhado(T(5))]) }],
    ['EVERGREEN', { ...griegElegivel, procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [], [encaminhado(T(9))]) }],
  ];
  for (const [codigo, p] of casos) {
    const d = decidir(p);
    assert.equal(d.apresentacao, null, codigo);
    assert.ok(!marcos(d).includes('MASTER_APRESENTADO'), codigo);
    assert.ok(marcos(d).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'), codigo);
    assert.notEqual(etapaDe(d), 'MASTER_APRESENTADO', codigo);
    assert.notEqual(etapaDe(d), 'ACOMPANHANDO_DESBLOQUEIO', codigo);
    assert.equal(d.janela.estado, 'NAO_INICIADA', `${codigo}: sem apresentação, a janela de 48h não começa`);
  }
});

test('[N7] P13: Unimar/Maersk — status Finalizado prova a apresentação sem marca de encaminhamento; a marca nunca é gate', () => {
  for (const codigo of ['ONE', 'MAERSK']) {
    const eventos = [evento('AGENDAMENTO_INICIADO', T(3)), evento('AGENDAMENTO_CONFIRMADO', T(4))];
    const semMarca = decidir({ ...clienteOk(), armador: armador(codigo), pagamentoArmador: pagamento('FINALIZADO', T(2)), procedimento: procedimento(eventos, [apresentacao('STATUS_FINALIZADO_PORTAL', T(6))]) });
    assert.ok(marcos(semMarca).includes('MASTER_APRESENTADO'), codigo);
    assert.ok(!marcos(semMarca).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'), codigo);
    assert.equal(etapaDe(semMarca), 'ACOMPANHANDO_DESBLOQUEIO', codigo);
    // Finalizado mesmo sem eventos de agendamento registrados.
    assert.ok(marcos(decidir({ ...clienteOk(), armador: armador(codigo), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(6))]) })).includes('MASTER_APRESENTADO'));
  }
});

/* ------------------------------------- tempo / viagem ------------------------------------- */

test('[N9] atracação real sem ATA NÃO coloca o processo no grupo de chegada ocorrida (ordenação normal do N-11)', () => {
  const v = situacaoDaViagem(viagem({ atracacao: instante(T(8)), eta: instante('2026-10-25T12:00:00.000Z') }), T(10));
  assert.equal(v.grupo, 'ETA_CONHECIDA');
  assert.equal(v.t10.estado, 'ANTES');
  assert.equal(v.atracacao.estado, 'CONFIRMADA', 'a atracação continua disponível para os papéis aprovados');
  const d = decidir({ viagem: viagem({ atracacao: instante(T(8)), eta: instante('2026-10-25T12:00:00.000Z') }) });
  assert.equal(item(d, 'MASTER_NAO_LOCALIZADO')?.classe, 'C', 'sem ATA, não há escalada por chegada');
  assert.equal(itemDeFila(d, 'FILA_PRINCIPAL')?.grupo, 'ETA_CONHECIDA');
  assert.equal(situacaoDaViagem(viagem({ ata: instante(T(8)) }), T(10)).grupo, 'CHEGADA_OCORRIDA');
  assert.equal(situacaoDaViagem(viagem({ atracacao: instante(T(8)) }), T(10)).grupo, 'REFERENCIA_TEMPORAL_INDISPONIVEL');
});

test('[N10] fuso não confiável nunca troca o dia de calendário por conversão para UTC', () => {
  const tardeComOffset = { bruto: '2026-10-20T23:30:00-03:00', precisao: 'DATA_HORA_COM_FUSO' as const, valor: '2026-10-20T23:30:00-03:00' };
  // Sem fuso confiável: o dia é o que a fonte escreveu (em UTC seria 21).
  assert.deepEqual(chaveDaEta(tardeComOffset, { fusoConfiavel: null, brasileiro: null }), { tipo: 'INSTANTE', t: Date.parse('2026-10-21T02:30:00.000Z'), data: '2026-10-20' });
  // O fallback operacional (porto brasileiro sem fuso) não serve para dar dia factual.
  const zulu = { bruto: '2026-10-21T01:00:00Z', precisao: 'DATA_HORA_COM_FUSO' as const, valor: '2026-10-21T01:00:00Z' };
  assert.equal(chaveDaEta(zulu, { fusoConfiavel: null, brasileiro: true }).data, '2026-10-21');
  // Com fuso confiável do porto, a data local é factual.
  assert.equal(chaveDaEta(zulu, { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true }).data, '2026-10-20');
  // Hora sem fuso nem regra de hora local: degrada para a data escrita.
  assert.deepEqual(chaveDaEta({ bruto: '2026-10-20T23:30', precisao: 'DATA_HORA_SEM_FUSO', valor: '2026-10-20T23:30' }, { fusoConfiavel: null, brasileiro: null }),
    { tipo: 'DATA', data: '2026-10-20' });
  // Consequência na fila: o dia 20 vem antes de uma ETA só com data 21 (com UTC teriam empatado).
  const porto = { fusoConfiavel: null, brasileiro: null };
  const x = itemDeFila(decidir({ processoId: 'X', viagem: viagem({ eta: tardeComOffset, porto }) }), 'FILA_PRINCIPAL')!;
  const y = itemDeFila(decidir({ processoId: 'Y', viagem: viagem({ eta: data('2026-10-21'), porto }) }), 'FILA_PRINCIPAL')!;
  assert.equal(precedeComCerteza(x, y), true);
});

/* ---------------------------------------- pagamento ---------------------------------------- */

test('[N12] nenhum status HeadCargo inventado: oficial só PENDENTE/FINALIZADO; "Rocket já executou" é fato operacional separado', () => {
  type Igual<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;
  const soOficial: Igual<PagamentoDoArmador['situacao'], 'PENDENTE' | 'FINALIZADO'> = true;
  assert.equal(soOficial, true);
  const agencia = { tipo: 'MAPEADA' as const, armador: 'MSC', codigoInformado: 'MSC', agencia: 'MSC' as const, evidencia: ev('a') };
  const pendente = pagamento('PENDENTE', T(5));
  const semExecucao = frentePagamento(agencia, 'M1', pendente, []);
  assert.equal(semExecucao.estado === 'PENDENTE' && semExecucao.lado, 'ROCKET');
  const comExecucao = frentePagamento(agencia, 'M1', pendente, [execucaoRocket(T(6))]);
  assert.equal(comExecucao.estado === 'PENDENTE' && comExecucao.lado, 'EXTERNO');
  assert.deepEqual(comExecucao.estado === 'PENDENTE' && comExecucao.execucaoPelaRocket, execucaoRocket(T(6)));
  // O oficial continua independente: a execução não resolve a condição financeira.
  assert.equal(comExecucao.estado, 'PENDENTE');
  const deOutroMaster = frentePagamento(agencia, 'M1', pendente, [execucaoRocket(T(6), 'M2')]);
  assert.equal(deOutroMaster.estado === 'PENDENTE' && deOutroMaster.lado, 'ROCKET');
  // Depois de reversão oficial, só conta execução a partir dela.
  const revertido = pagamento('PENDENTE', T(7), 'M1', [fato({ situacao: 'FINALIZADO' as const, finalizadoEm: null }, T(4))]);
  const antiga = frentePagamento(agencia, 'M1', revertido, [execucaoRocket(T(3))]);
  assert.equal(antiga.estado === 'PENDENTE' && antiga.lado, 'ROCKET');
  const nova = frentePagamento(agencia, 'M1', revertido, [execucaoRocket(T(8))]);
  assert.equal(nova.estado === 'PENDENTE' && nova.lado, 'EXTERNO');
  // Sem registro oficial no HeadCargo, a execução operacional não cria condição: continua desconhecido.
  assert.equal(frentePagamento(agencia, 'M1', integ({ masterId: 'M1', estado: vazio() }), [execucaoRocket(T(6))]).estado, 'DESCONHECIDO');
});

/* ------------------------------------------ Termo ------------------------------------------ */

test('[N13] Termo incompleto = pendente de correção (cliente, campos concretos), não reprovação explícita', () => {
  const base = {
    camposObrigatoriosFaltantes: [] as string[], assinadoEm: T(3), signatario: { identificavel: true, identificador: 'CPF:1' },
    procuracao: { conteudoInequivoco: true, outorgados: ['CPF:1'], validaAte: T(30), poderes: 'SUFICIENTES' as const },
  };
  assert.deepEqual(validarTermoPorEmbarque({ ...base, camposObrigatoriosFaltantes: ['NUMERO_DO_PROCESSO', 'CNPJ_DO_IMPORTADOR'] }),
    { resultado: 'PENDENTE_DE_CORRECAO', camposFaltantes: ['NUMERO_DO_PROCESSO', 'CNPJ_DO_IMPORTADOR'] });
  // Incompleto + ambíguo: primeiro a correção pelo cliente (não revisão).
  assert.equal(validarTermoPorEmbarque({ ...base, camposObrigatoriosFaltantes: ['CNPJ'], procuracao: { ...base.procuracao, poderes: 'AMBIGUOS' } }).resultado, 'PENDENTE_DE_CORRECAO');
  // Invalidade conclusiva continua sendo reprovação.
  assert.deepEqual(validarTermoPorEmbarque({ ...base, camposObrigatoriosFaltantes: ['CNPJ'], signatario: { identificavel: true, identificador: 'CPF:9' } }),
    { resultado: 'REPROVADO', motivos: ['SIGNATARIO_NAO_OUTORGADO'] });

  const naoPossui = integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1)));
  const termo = (validacao: ReturnType<typeof validarTermoPorEmbarque>) => decidir({
    termoUnico: naoPossui, termoEmbarque: integ({ situacao: 'ENVIADO', em: T(3), evidencia: ev('termo'), validacao, revisao: null }),
  });
  const incompleto = item(termo(validarTermoPorEmbarque({ ...base, camposObrigatoriosFaltantes: ['CNPJ'] })), 'TERMO_POR_EMBARQUE_PENDENTE_DE_CORRECAO');
  assert.deepEqual([incompleto?.responsavel, incompleto?.acao, incompleto?.classe], ['CLIENTE', 'AGUARDAR_CORRECAO_DO_TERMO', 'D']);
  assert.deepEqual(incompleto?.detalhe?.camposFaltantes, ['CNPJ']);
  const reprovado = termo(validarTermoPorEmbarque({ ...base, procuracao: { ...base.procuracao, validaAte: T(2) } }));
  assert.ok(!item(reprovado, 'TERMO_POR_EMBARQUE_PENDENTE_DE_CORRECAO'));
  assert.equal(item(reprovado, 'TERMO_POR_EMBARQUE_REPROVADO')?.acao, 'AGUARDAR_NOVO_TERMO_DO_CLIENTE');
});

/* ------------------------------------ apresentação só data ------------------------------------ */

test('[N14] apresentação só com data continua só data: nenhuma hora inventada no marco, na janela ou no vínculo tardio', () => {
  const soData = {
    ...apresentacao('MEMORANDO_CARIMBADO', T(9), 'ana'), momento: { precisao: 'DATA' as const, data: '2026-10-05', fuso: 'America/Sao_Paulo' },
  };
  const pagoAntes = integ({ masterId: 'M1', estado: oficial({ situacao: 'FINALIZADO' as const, finalizadoEm: { precisao: 'INSTANTE' as const, instante: T(4) } }, T(4)) });
  const d = decidir({ ...clienteOk(), armador: armador('MSC'), pagamentoArmador: pagoAntes, procedimento: procedimento([], [soData]), agora: T(7, 12) });
  const m = d.progresso.find((x) => x.marco === 'MASTER_APRESENTADO');
  assert.equal(m?.em, null, 'o registro técnico (T9) não vira momento da apresentação');
  assert.deepEqual(m?.momento, { precisao: 'DATA', data: '2026-10-05', fuso: 'America/Sao_Paulo' });
  assert.equal(d.apresentacao?.em, null);
  assert.deepEqual(d.apresentacao?.confirmacaoDoAnalista, { por: 'ana', em: T(9) }, 'a confirmação do Analista é preservada como fato próprio');
  assert.equal(d.janela.estado, 'INCERTA');
  assert.equal(d.janela.estado === 'INCERTA' && d.janela.inicio.de, '2026-10-05T03:00:00.000Z');
  // Quando a própria confirmação é o evento factual, quem registra informa esse instante: aí ele vale.
  const confirmacaoFactual = { ...soData, momento: { precisao: 'INSTANTE' as const, instante: T(9) } };
  assert.equal(decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [confirmacaoFactual]) }).apresentacao?.em, T(9));
  // Vínculo tardio só quando o dia inteiro é anterior ao vínculo.
  const comVinculo = (vinculadoEm: string) => decidir({
    ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([], [soData]), vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM100', 'M1', vinculadoEm) },
  }).apresentacao?.vinculoTardio;
  assert.equal(comVinculo(T(5, 12)), null, 'vínculo no mesmo dia: incerto, não se afirma');
  assert.equal(comVinculo(T(7))?.acaoEm, '2026-10-05');
});

/* ----------------------------------------- terminal ----------------------------------------- */

test('[N15] SISCARGA: contradição ANTES da conclusão impede LIBERADO; DEPOIS do terminal, a prova é preservada', () => {
  const pos = {
    ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(3))]),
    pagamentoArmador: pagamento('FINALIZADO', T(4)), ceHouse: integ(oficial({ numero: 'CEH1' }, T(4))),
    siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(8))),
  };
  const final = { ceHouse: 'CEH1', sucesso: true, executadaEm: T(9), frete: 'SEM_PENDENCIA' as const, fiscal: 'SEM_PENDENCIA' as const, evidencia: ev('final') };
  const contradicao = integ(oficial('COM_PENDENCIA' as const, T(9, 1)));
  // Antes: a verificação final ficou velha diante de uma pendência confirmada depois dela.
  const antes = decidir({ ...pos, verificacaoFinal: final, siscargaFrete: contradicao });
  assert.equal(antes.liberado, null);
  assert.deepEqual(antes.conclusao, { tipo: 'NAO_CONCLUIDO', motivos: ['VERIFICACAO_DESATUALIZADA'] });
  assert.notEqual(etapaDe(antes), 'LIBERADO');
  // Depois: a mesma contradição, com a prova já registrada, não reabre nada.
  const prova: ProvaDeLiberacao = { tipo: 'PROVA_SISCARGA', em: T(9), evidencia: ev('final'), ceHouse: 'CEH1', frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', fonte: 'SISCARGA' };
  const depois = decidir({ ...pos, liberado: prova, verificacaoFinal: final, siscargaFrete: contradicao });
  assert.equal(etapaDe(depois), 'LIBERADO');
  assert.deepEqual(depois.liberado, prova);
  assert.equal(depois.conclusao, null);
  assert.deepEqual(depois.itens, []);
});
