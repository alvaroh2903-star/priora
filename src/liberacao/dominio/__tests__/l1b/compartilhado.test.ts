import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisaoDoProcesso, EntradaDecisao, aplicarPortaoCompartilhado, decidirAcaoDeMaster, decidirProcesso, montarVisao, processosAtivosDoMaster } from '../../index';
import { T, armador, clienteOk, etapaDe, ev, integ, item, mundo, oficial, override, vinculo } from './fixtures';

/** Master M1 (Unimar) resolvido por Wave, compartilhado; cada processo com o seu lado cliente. */
const wave = integ([{ masterId: 'M1', acaoEm: T(2), ultimaConfirmacaoEm: T(2), evidencia: ev('wave'), processosVinculadosNaAcao: ['IM100', 'IM101', 'IM102'] }]);
const processo = (processoId: string, p: Partial<EntradaDecisao> = {}): DecisaoDoProcesso => decidirProcesso(mundo({
  ...clienteOk(), processoId, vinculo: { tipo: 'VINCULADO', vinculo: vinculo(processoId, 'M1') }, wave, armador: armador('ONE'), ...p,
}));
const termoPendente = {
  termoUnico: integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))),
  termoEmbarque: integ({ situacao: 'AGUARDANDO_CLIENTE' as const, desde: T(2), evidencia: ev('portal-termo') }),
};
const financeiroPendente = { financeiroCliente: integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(2))) };

test('[R14] N-13: um vinculado bloqueado bloqueia a ação de Master (D), listando processos e pendências; etapa continua individual', () => {
  const decisoes = aplicarPortaoCompartilhado([processo('IM100'), processo('IM101', termoPendente), processo('IM102', financeiroPendente)]);
  const [im100, im101, im102] = decisoes;
  assert.equal(etapaDe(im100), 'APTO_PARA_PROCEDIMENTO', 'IM100 continua apto (etapa individual)');
  assert.equal(etapaDe(im101), 'PREPARACAO_OPERACIONAL');
  assert.equal(etapaDe(im102), 'PREPARACAO_OPERACIONAL');
  const b = item(im100, 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS');
  assert.equal(b?.classe, 'D');
  assert.equal(b?.detalhe?.mensagem, 'Master tecnicamente apto, mas bloqueado por processos vinculados');
  assert.deepEqual(b?.detalhe?.bloqueios, [{ processoId: 'IM101', pendencias: ['TERMO'] }, { processoId: 'IM102', pendencias: ['FINANCEIRO'] }]);
  assert.ok(!im100.itens.some((i) => i.acao === 'AGENDAR_NO_PORTAL'), 'não se recomenda a ação de Master');
  assert.deepEqual(im100.bloqueador.tipo === 'CONHECIDO' && im100.bloqueador.item.motivo, 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS');
});

test('[R14] todos aptos → UMA ação de Master na Fila (N-12) que impacta todos; override de um processo libera só o que cobre', () => {
  const todos = aplicarPortaoCompartilhado([processo('IM100'), processo('IM101'), processo('IM102')]);
  const fila = montarVisao(todos, 'FILA_PRINCIPAL');
  assert.equal(fila.length, 1);
  assert.equal(fila[0].id, 'MASTER:M1:AGENDAR_NO_PORTAL');
  assert.deepEqual(fila[0].processos, ['IM100', 'IM101', 'IM102']);
  assert.deepEqual(todos[0].itens.find((i) => i.acao === 'AGENDAR_NO_PORTAL')?.detalhe?.impacta, ['IM100', 'IM101', 'IM102']);

  // IM101 com override para INICIAR_PROCEDIMENTO da sua pendência de Termo; IM102 ainda pendente → bloqueia só por IM102.
  const episodio = (d: DecisaoDoProcesso) => (d.cliente.dimensoes.TERMO.estado === 'PENDENTE' ? d.cliente.dimensoes.TERMO.episodio : '');
  const im101Sem = processo('IM101', termoPendente);
  const ov = override({ id: 'OV-101', processoId: 'IM101', pendencia: { dimensao: 'TERMO', episodio: episodio(im101Sem) } });
  const parcial = aplicarPortaoCompartilhado([processo('IM100'), processo('IM101', { ...termoPendente, overrides: [ov] }), processo('IM102', financeiroPendente)]);
  assert.deepEqual(item(parcial[0], 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS')?.detalhe?.bloqueios, [{ processoId: 'IM102', pendencias: ['FINANCEIRO'] }]);
  // Sem IM102 pendente, a ação volta a execução normal, registrando a exceção do IM101.
  const liberada = aplicarPortaoCompartilhado([processo('IM100'), processo('IM101', { ...termoPendente, overrides: [ov] }), processo('IM102')]);
  const acao = liberada[0].itens.find((i) => i.acao === 'AGENDAR_NO_PORTAL');
  assert.deepEqual(acao?.detalhe?.viaOverride, [{ processoId: 'IM101', overrides: ['OV-101'], pendenciasCobertas: ['TERMO'] }]);
  // O mesmo override não serve para APRESENTAR.
  assert.equal(decidirAcaoDeMaster('M1', 'APRESENTAR', liberada).tipo, 'BLOQUEADA_POR_VINCULADOS');
});

test('[R16] processo ativo vinculado = vínculo publicado + não LIBERADO; CONFLITO e LIBERADO não bloqueiam o Master candidato', () => {
  const liberado = processo('IM103', { ...financeiroPendente, liberado: { em: T(9), evidencia: ev('siscarga') } });
  const conflito = decidirProcesso(mundo({ ...termoPendente, processoId: 'IM104', vinculo: { tipo: 'CONFLITO', masterIds: ['M1', 'M2'] } }));
  const outroMaster = decidirProcesso(mundo({ ...termoPendente, processoId: 'IM105', vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM105', 'M9') } }));
  const decisoes = [processo('IM100'), liberado, conflito, outroMaster];
  assert.deepEqual(processosAtivosDoMaster('M1', decisoes).map((d) => d.processoId), ['IM100']);
  const r = aplicarPortaoCompartilhado(decisoes);
  assert.ok(r[0].itens.some((i) => i.acao === 'AGENDAR_NO_PORTAL'), 'nenhum deles bloqueia M1');
  assert.equal(etapaDe(r[1]), 'LIBERADO', 'LIBERADO não reabre');
});

test('N-13 com vinculado não determinável → ação de Master não determinável (sem classe), nunca execução normal', () => {
  const nd = processo('IM101', { financeiroCliente: { tipo: 'NAO_INTEGRADA' } });
  const r = aplicarPortaoCompartilhado([processo('IM100'), nd]);
  const i = item(r[0], 'ACAO_DE_MASTER_NAO_DETERMINAVEL_PELOS_VINCULADOS');
  assert.equal(i?.classe, null);
  assert.ok(!r[0].itens.some((x) => x.acao === 'AGENDAR_NO_PORTAL'));
});

test('N-15: processo vinculado depois da apresentação herda o fato com o instante original e a mensagem; sem culpa nem override retroativos', () => {
  const tardio = decidirProcesso(mundo({
    ...clienteOk(), ...financeiroPendente, processoId: 'IM106', vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM106', 'M1', T(8)) }, wave,
    fatosDoMasterL1a: [{ tipo: 'MASTER_APRESENTADO', masterId: 'M1', acaoEm: T(5), evidencia: ev('apr'), processosVinculadosNaAcao: ['IM100'] }],
  }));
  const m = tardio.progresso.find((x) => x.marco === 'MASTER_APRESENTADO');
  assert.equal(m?.em, T(5));
  assert.equal(m?.vinculoTardio?.mensagem, 'Master apresentado antes deste processo ser vinculado.');
  assert.deepEqual(m?.vinculoTardio?.processosVinculadosNaAcao, ['IM100']);
  assert.ok(item(tardio, 'FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO'), 'a obrigação do cliente continua como bloqueador');
  assert.ok(!tardio.itens.some((i) => i.responsavel === 'ROCKET' && /FALHA/.test(i.motivo)));
});
