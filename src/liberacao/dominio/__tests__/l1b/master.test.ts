import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAO_INTEGRADA, situacaoDoMasterL1b } from '../../index';
import { FORA, T, acoes, courier, decidir, etapaDe, ev, fato, integ, item, oficial, vinculo } from './fixtures';

const wave = (em: string, masterId = 'M1') => ({ masterId, acaoEm: em, ultimaConfirmacaoEm: em, evidencia: ev(`wave@${em}`), processosVinculadosNaAcao: ['IM100'] });
const modalidade = (m: 'FISICO' | 'WAVE' | 'EMISSAO_DESTINO', em = T(1)) =>
  ({ tipo: 'MODALIDADE_IDENTIFICADA' as const, masterId: 'M1', modalidade: m, acaoEm: em, evidencia: ev(`modalidade-${m}`) });

test('[R4] resolução pelo físico, pelo Wave e pela emissão no destino; cada uma com via e evidência', () => {
  const fisico = decidir({ courier: courier({ mbl: fato('RECEBIDO' as const, T(2)) }) });
  assert.deepEqual(fisico.master.resolucoes.map((r) => [r.modalidade, r.via]), [['FISICO', 'CONFERENCIA_DO_PROPRIO_PROCESSO']]);
  assert.equal(fisico.master.frente.estado, 'RESOLVIDO');

  const w = decidir({ wave: integ([wave(T(3))]) });
  assert.deepEqual(w.master.resolucoes.map((r) => [r.modalidade, r.via, r.evidencia.ref]), [['WAVE', 'FATO_DO_MASTER', `wave@${T(3)}`]]);

  const destino = decidir({ emissaoDestino: integ({ consultasAoArmador: [], autorizacoes: [wave(T(4))] }) });
  assert.deepEqual(destino.master.resolucoes.map((r) => r.modalidade), ['EMISSAO_DESTINO']);
  assert.equal(destino.master.frente.estado, 'RESOLVIDO');

  // Fato de outro Master não resolve este; sem vínculo, nada de escopo Master se atribui.
  assert.equal(decidir({ wave: integ([wave(T(3), 'M2')]) }).master.frente.estado, 'NAO_RESOLVIDO');
  assert.deepEqual(decidir({ vinculo: { tipo: 'SEM_VINCULO' }, wave: integ([wave(T(3))]) }).master.resolucoes, []);
});

test('[R5] várias modalidades válidas: todas preservadas; a corrente é a de instante factual mais recente; um fato mais novo a troca', () => {
  const d = decidir({ courier: courier({ mbl: fato('RECEBIDO' as const, T(2)) }), wave: integ([wave(T(5))]) });
  assert.deepEqual(d.master.resolucoes.map((r) => r.modalidade), ['FISICO', 'WAVE']);
  assert.deepEqual(d.master.modalidadeAtual, { tipo: 'UNICA', modalidade: 'WAVE', em: T(5) });
  assert.ok(!d.itens.some((i) => /DIVERGENCIA/.test(i.motivo)), 'várias modalidades não criam divergência sozinhas');

  const depois = decidir({ courier: courier({ mbl: fato('RECEBIDO' as const, T(7)) }), wave: integ([wave(T(5))]) });
  assert.deepEqual(depois.master.modalidadeAtual, { tipo: 'UNICA', modalidade: 'FISICO', em: T(7) });
  // A ordem de chegada dos fatos não importa.
  const a = decidir({ wave: integ([wave(T(5))]), emissaoDestino: integ({ consultasAoArmador: [], autorizacoes: [wave(T(6))] }) });
  assert.equal(a.master.modalidadeAtual?.tipo === 'UNICA' && a.master.modalidadeAtual.modalidade, 'EMISSAO_DESTINO');
});

test('[R6] empate exato de instante: nenhuma precedência por ordem de array, lexical ou técnica; o Master continua resolvido', () => {
  const emp = (ordemInvertida: boolean) => {
    const fatos = { courier: courier({ mbl: fato('RECEBIDO' as const, T(5)) }), wave: integ([wave(T(5))]) };
    return decidir(ordemInvertida ? { wave: fatos.wave, courier: fatos.courier } : fatos);
  };
  for (const d of [emp(false), emp(true)]) {
    assert.equal(d.master.frente.estado, 'RESOLVIDO');
    assert.deepEqual(d.master.modalidadeAtual, { tipo: 'AMBIGUA', modalidades: ['FISICO', 'WAVE'], em: T(5) });
  }
  // A ambiguidade da modalidade não escolhe nem inventa procedimento: a agência vem da matriz.
  const comAgencia = decidir({ courier: courier({ mbl: fato('RECEBIDO' as const, T(5)) }), wave: integ([wave(T(5))]), armador: integ(oficial({ masterId: 'M1', codigo: 'MSC' }, T(1))) });
  assert.equal(comAgencia.agencia.tipo === 'MAPEADA' && comAgencia.agencia.agencia, 'MSC');
});

test('[R7] guarda do "não localizado" (D-6): só com Courier, Wave e emissão no destino integrados e observáveis', () => {
  assert.deepEqual(decidir().master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'MASTER_NAO_LOCALIZADO' });
  for (const falta of [{ wave: NAO_INTEGRADA }, { emissaoDestino: NAO_INTEGRADA }] as const) {
    const d = decidir(falta);
    assert.equal(d.master.frente.estado, 'NAO_DETERMINAVEL');
    assert.ok(!d.itens.some((i) => i.motivo === 'MASTER_NAO_LOCALIZADO'));
  }
  // Modalidade identificada, evidência física ou conflito impedem a condição.
  assert.notDeepEqual(decidir({ fatosDoMasterL1a: [modalidade('WAVE')] }).master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'MASTER_NAO_LOCALIZADO' });
  assert.notDeepEqual(decidir({ courier: courier({ envelope: fato('EM_TRANSITO' as const, T(2)) }) }).master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'MASTER_NAO_LOCALIZADO' });
  assert.deepEqual(decidir({ vinculo: { tipo: 'CONFLITO', masterIds: ['M1', 'M2'] } }).master.frente, { estado: 'NAO_RESOLVIDO', condicao: 'CONFLITO_DE_IDENTIDADE_DO_MASTER' });
});

test('[R8] fonte fora do ar impede falso negativo: nada de "não localizado" nem "não recebido"', () => {
  for (const p of [{ courier: courier({ fonte: FORA() }) }, { wave: integ([], FORA()) }, { emissaoDestino: integ({ consultasAoArmador: [], autorizacoes: [] }, FORA()) }]) {
    const d = decidir(p);
    assert.equal(d.master.frente.estado, 'NAO_DETERMINAVEL', JSON.stringify(p));
    assert.ok(d.master.frente.estado === 'NAO_DETERMINAVEL' && d.master.frente.ind.fontesIndisponiveis.length > 0);
    assert.ok(!d.itens.some((i) => i.motivo === 'MASTER_NAO_LOCALIZADO'));
  }
  // Fato anterior com a fonte fora: o Wave confirmado continua resolvendo (N-17).
  assert.equal(decidir({ wave: integ([wave(T(3))], FORA()) }).master.frente.estado, 'RESOLVIDO');
});

test('identificado mas não resolvido ≠ não localizado: cada caso com responsável e ação próprios', () => {
  const casos: Array<[Parameters<typeof decidir>[0], string, string, string, string]> = [
    [{ fatosDoMasterL1a: [modalidade('FISICO')], courier: courier({ envelope: fato('EM_TRANSITO' as const, T(2)) }) }, 'MASTER_FISICO_EM_TRANSITO', 'TERCEIRO', 'AGUARDAR_MASTER_FISICO_EM_TRANSITO', 'D'],
    [{ fatosDoMasterL1a: [modalidade('FISICO')], courier: courier({ envelope: fato('ENTREGUE' as const, T(2)) }) }, 'CONFERENCIA_DO_MBL_PENDENTE', 'ROCKET', 'CONFERIR_MBL_NO_COURIER', 'C'],
    [{ fatosDoMasterL1a: [modalidade('FISICO')], courier: courier({ mbl: fato('AUSENTE_NA_CONFERENCIA' as const, T(2)) }) }, 'MBL_AUSENTE_NA_CONFERENCIA', 'AGENTE', 'ACOMPANHAR_MBL_AUSENTE_COM_O_AGENTE', 'D'],
    [{ fatosDoMasterL1a: [modalidade('WAVE')] }, 'WAVE_AGUARDANDO_CONFIRMACAO', 'AGENTE', 'AGUARDAR_CONFIRMACAO_DO_WAVE', 'D'],
    [{ fatosDoMasterL1a: [modalidade('EMISSAO_DESTINO')] }, 'EMISSAO_DESTINO_SEM_CONSULTA_AO_ARMADOR', 'ROCKET', 'CONSULTAR_ARMADOR_EMISSAO_DESTINO', 'C'],
  ];
  for (const [p, motivo, responsavel, acao, classe] of casos) {
    const d = decidir(p);
    const i = item(d, motivo);
    assert.ok(i, motivo);
    assert.deepEqual([i.responsavel, i.acao, i.classe], [responsavel, acao, classe], motivo);
    assert.equal(etapaDe(d), 'PREPARACAO_PARA_LIBERACAO', motivo);
    assert.ok(!d.filtros.includes('MASTER_NAO_LOCALIZADO'), motivo);
  }
});

test('[R9] pré-alerta confirmado e HBL + MBL sem modalidade → UMA ação combinada da Rocket pedindo as duas', () => {
  const d = decidir({ preAlerta: integ(oficial('CONFIRMADO' as const, T(2))) });
  const pedidos = d.itens.filter((i) => i.acao === 'SOLICITAR_MODALIDADE_AO_AGENTE');
  assert.equal(pedidos.length, 1);
  assert.deepEqual(pedidos[0].detalhe?.pedir, { house: true, master: true });
  assert.equal(pedidos[0].responsavel, 'ROCKET');
  assert.equal(pedidos[0].classe, 'C');
  assert.equal(d.principal?.acao, 'SOLICITAR_MODALIDADE_AO_AGENTE');
  // Sem pré-alerta confirmado não se pede nada: as ações são verificar/identificar.
  const antes = decidir();
  assert.ok(!acoes(antes).includes('SOLICITAR_MODALIDADE_AO_AGENTE'));
  assert.ok(acoes(antes).includes('IDENTIFICAR_MODALIDADE_DO_HOUSE'));
  assert.ok(acoes(antes).includes('VERIFICAR_SITUACAO_DO_MASTER'));
});

test('[R10] só se pede o que falta; pedido feito não se repete; informação obtida encerra o pedido', () => {
  const preAlerta = integ(oficial('CONFIRMADO' as const, T(2)));
  // MBL já identificado: só o HBL.
  const soHouse = decidir({ preAlerta, fatosDoMasterL1a: [modalidade('WAVE')] });
  const p1 = soHouse.itens.filter((i) => i.acao === 'SOLICITAR_MODALIDADE_AO_AGENTE');
  assert.equal(p1.length, 1);
  assert.deepEqual(p1[0].detalhe?.pedir, { house: true, master: false });
  // HBL já informado: só o MBL.
  const soMaster = decidir({ preAlerta, modalidadeBl: integ({ house: fato({ tipo: 'TELEX' as const }, T(2)), pedidos: [] }) });
  const p2 = soMaster.itens.filter((i) => i.acao === 'SOLICITAR_MODALIDADE_AO_AGENTE');
  assert.equal(p2.length, 1);
  assert.deepEqual(p2[0].detalhe?.pedir, { house: false, master: true });
  // Pedido já feito para os dois: nenhum pedido novo; House aguarda o agente, Master segue em verificação.
  const pedido = { em: T(3), evidencia: ev('email-pedido'), house: true, master: true };
  const feito = decidir({ preAlerta, modalidadeBl: integ({ house: null, pedidos: [pedido] }) });
  assert.ok(!acoes(feito).includes('SOLICITAR_MODALIDADE_AO_AGENTE'));
  assert.equal(item(feito, 'MODALIDADE_DO_HOUSE_DESCONHECIDA')?.acao, 'AGUARDAR_RESPOSTA_DE_MODALIDADE');
  assert.equal(item(feito, 'MASTER_NAO_LOCALIZADO')?.acao, 'VERIFICAR_SITUACAO_DO_MASTER');
  // Tudo informado: nenhum pedido.
  const tudo = decidir({ preAlerta, fatosDoMasterL1a: [modalidade('WAVE')], modalidadeBl: integ({ house: fato({ tipo: 'TELEX' as const }, T(2)), pedidos: [] }) });
  assert.ok(!acoes(tudo).some((a) => a === 'SOLICITAR_MODALIDADE_AO_AGENTE' || a === 'AGUARDAR_RESPOSTA_DE_MODALIDADE'));
});

test('[R15] conflito no S2: nenhum Master é escolhido, nada se propaga, Rocket resolve (C), etapa Preparação para Liberação', () => {
  const d = decidir({
    vinculo: { tipo: 'CONFLITO', masterIds: ['M1', 'M2'] },
    wave: integ([wave(T(3), 'M1')]),
    fatosDoMasterL1a: [{ tipo: 'MASTER_APRESENTADO', masterId: 'M1', acaoEm: T(4), evidencia: ev('apr'), processosVinculadosNaAcao: [] }],
    armador: integ(oficial({ masterId: 'M1', codigo: 'MSC' }, T(1))),
  });
  assert.equal(d.masterId, null);
  assert.deepEqual(d.master.conflito, ['M1', 'M2']);
  assert.deepEqual(d.master.resolucoes, []);
  assert.equal(d.apresentacao, null, 'nada se propaga dos candidatos');
  assert.equal(d.agencia.tipo, 'SEM_MASTER');
  assert.equal(etapaDe(d), 'PREPARACAO_PARA_LIBERACAO');
  const c = item(d, 'CONFLITO_DE_IDENTIDADE_DO_MASTER');
  assert.deepEqual([c?.responsavel, c?.acao, c?.classe], ['ROCKET', 'RESOLVER_CONFLITO_DE_IDENTIDADE_DO_MASTER', 'C']);
  assert.ok(!d.filtros.includes('MASTER_NAO_LOCALIZADO'));
});

test('Master no contrato da L1b reaproveita a L1a congelada para o físico (mesma situação L1a)', () => {
  const s = situacaoDoMasterL1b({
    vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM100', 'M1') }, fatosDoMasterL1a: [], courier: courier({ mbl: fato('RECEBIDO' as const, T(2)) }),
    wave: NAO_INTEGRADA, emissaoDestino: NAO_INTEGRADA,
  });
  assert.equal(s.l1a.resolucao.tipo, 'RESOLVIDO');
  assert.equal(s.frente.estado, 'RESOLVIDO');
});
