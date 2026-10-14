import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EstadoOficial, Integrado, ProvaDeLiberacao, SituacaoFrete, VerificacaoFinalSiscarga, concluirPeloSiscarga, ler, restaurarProva } from '../../index';
import { FORA, T, apresentacao, armador, clienteOk, decidir, etapaDe, ev, integ, item, oficial, pagamento, procedimento, vazio } from './fixtures';

const final = (p: Partial<VerificacaoFinalSiscarga> = {}): VerificacaoFinalSiscarga =>
  ({ ceHouse: 'CEH1', sucesso: true, executadaEm: T(9), frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', evidencia: ev('final'), ...p });
const frete = (v: 'COM_PENDENCIA' | 'SEM_PENDENCIA', em = T(8)) => ler('SISCARGA_FRETE', integ(oficial(v, em)));
const fiscal = (v: 'COM_PENDENCIA' | 'SEM_PENDENCIA', em = T(8)) => ler('SISCARGA_FISCAL', integ(oficial({ situacao: v, causa: null }, em)));
const motivos = (r: ReturnType<typeof concluirPeloSiscarga>) => (r.tipo === 'NAO_CONCLUIDO' ? r.motivos : []);

test('[R30] LIBERADO só por verificação final fresca, bem-sucedida, do CE House atual, com frete E fiscal sem pendência', () => {
  const ok = concluirPeloSiscarga(final(), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'));
  assert.equal(ok.tipo, 'LIBERADO');
  assert.deepEqual(motivos(concluirPeloSiscarga(null, 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['SEM_VERIFICACAO_FINAL']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final(), null, frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['SEM_CE_HOUSE']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final({ sucesso: false }), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['VERIFICACAO_SEM_SUCESSO']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final({ ceHouse: 'CEH0' }), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['VERIFICACAO_DE_OUTRO_CE_HOUSE']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final({ fiscal: null }), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['VERIFICACAO_PARCIAL']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final({ frete: 'COM_PENDENCIA' }), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['PENDENCIA_DE_FRETE']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final({ fiscal: 'COM_PENDENCIA' }), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA'))), ['PENDENCIA_FISCAL']);
  // Pendência oficial confirmada DEPOIS da verificação a torna velha; antes dela, a verificação é a palavra mais recente.
  assert.deepEqual(motivos(concluirPeloSiscarga(final(), 'CEH1', frete('COM_PENDENCIA', T(9, 1)), fiscal('SEM_PENDENCIA'))), ['VERIFICACAO_DESATUALIZADA']);
  assert.deepEqual(motivos(concluirPeloSiscarga(final(), 'CEH1', frete('SEM_PENDENCIA'), fiscal('COM_PENDENCIA', T(9, 1)))), ['VERIFICACAO_DESATUALIZADA']);
  assert.equal(concluirPeloSiscarga(final(), 'CEH1', frete('COM_PENDENCIA', T(8)), fiscal('SEM_PENDENCIA')).tipo, 'LIBERADO');
});

test('[R30] último estado conhecido "sem pendência" sem verificação final não conclui; SISCARGA fora não muda o estado', () => {
  const pos = {
    ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(3))]),
    pagamentoArmador: pagamento('FINALIZADO', T(4)), ceHouse: integ(oficial({ numero: 'CEH1' }, T(4))),
  };
  const semFinal = decidir({ ...pos, siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(8))), siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(8))) });
  assert.equal(etapaDe(semFinal), 'ACOMPANHANDO_DESBLOQUEIO');
  assert.equal(item(semFinal, 'VERIFICACAO_FINAL_DO_SISCARGA_PENDENTE')?.classe, null);
  const fora = decidir({ ...pos, siscargaFrete: integ(vazio(), FORA()), siscargaFiscal: integ(vazio(), FORA()), verificacaoFinal: final({ sucesso: false }) });
  assert.equal(fora.liberado, null);
  assert.equal(etapaDe(fora), 'ACOMPANHANDO_DESBLOQUEIO');
});

test('acompanhando desbloqueio sem saber o frete (não integrado, fora ou sem consulta): bloqueador e próxima ação não determináveis, nunca "nenhum"', () => {
  const pos = {
    ...clienteOk(), armador: armador('ONE'), procedimento: procedimento([], [apresentacao('STATUS_FINALIZADO_PORTAL', T(3))]),
    pagamentoArmador: pagamento('FINALIZADO', T(4)), ceHouse: integ(oficial({ numero: 'CEH1' }, T(4))),
  };
  const casos: Array<[Integrado<EstadoOficial<SituacaoFrete>>, 'semFonteIntegrada' | 'fontesIndisponiveis' | 'semObservacao']> = [
    [{ tipo: 'NAO_INTEGRADA' }, 'semFonteIntegrada'], [integ(vazio<SituacaoFrete>(), FORA()), 'fontesIndisponiveis'], [integ(vazio<SituacaoFrete>()), 'semObservacao'],
  ];
  for (const [siscargaFrete, onde] of casos) {
    const d = decidir({ ...pos, siscargaFrete });
    assert.equal(etapaDe(d), 'ACOMPANHANDO_DESBLOQUEIO');
    assert.equal(d.bloqueador.tipo, 'NAO_DETERMINAVEL', onde);
    assert.equal(d.proximaAcao.tipo, 'NAO_DETERMINAVEL', onde);
    assert.ok(d.indeterminacao[onde].includes('SISCARGA_FRETE'), onde);
  }
});

test('[R31] LIBERADO terminal: contradições posteriores (frete, fiscal, Master, CE House, rota) não o invalidam', () => {
  const prova = (concluirPeloSiscarga(final(), 'CEH1', frete('SEM_PENDENCIA'), fiscal('SEM_PENDENCIA')) as { prova: ProvaDeLiberacao }).prova;
  const depois = decidir({
    liberado: prova, agora: T(20),
    siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(15))), siscargaFiscal: integ(oficial({ situacao: 'COM_PENDENCIA' as const, causa: 'x' }, T(15))),
    ceHouse: integ(oficial({ numero: 'CEH2' }, T(15))), verificacaoFinal: final({ sucesso: false, executadaEm: T(16) }),
    rota: integ({ alteracao: { valor: { descricao: 'omissão' }, vigenteDesde: T(15), ultimaConfirmacaoEm: T(15), evidencia: ev('rota') }, ceMasterRetificado: null, ceHouseRetificado: null }),
  });
  assert.equal(etapaDe(depois), 'LIBERADO');
  assert.deepEqual(depois.liberado, prova);
  assert.deepEqual([depois.itens, depois.regulatorio, depois.filtros], [[], [], []]);
  assert.equal(depois.conclusao, null, 'o terminal registrado não é recalculado');
});

test('prova preservada: CE House, retorno, data/hora e fonte; reidratação só verifica consistência intrínseca', () => {
  const prova: ProvaDeLiberacao = { tipo: 'PROVA_SISCARGA', em: T(9), evidencia: ev('final'), ceHouse: 'CEH1', frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', fonte: 'SISCARGA' };
  assert.deepEqual(restaurarProva(prova), prova);
  assert.equal(restaurarProva({ ...prova, frete: 'COM_PENDENCIA' as unknown as 'SEM_PENDENCIA' }), null);
  assert.equal(restaurarProva({ ...prova, ceHouse: ' ' }), null);
  assert.equal(restaurarProva({ ...prova, em: 'ontem' }), null);
  assert.equal(restaurarProva({ ...prova, evidencia: { fonte: '', ref: 'x' } }), null);
});
