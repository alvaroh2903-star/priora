import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DimensaoCliente, Override, ResultadoDimensao, indeterminacao, overrideCobre, portaoDoCliente, problemasDoOverride, situacaoDoFinanceiro,
  situacaoDoOverride, situacaoDoTermo, validarTermoPorEmbarque,
} from '../../index';
import { FORA, T, courier, decidir, ev, fato, integ, item, oficial, override, vazio } from './fixtures';

/* ------------------------------ tabela-verdade do portão ------------------------------ */

type Estado = ResultadoDimensao['estado'];
const ESTADOS: Estado[] = ['RESOLVIDO', 'PENDENTE', 'DESCONHECIDO', 'NAO_DETERMINAVEL'];
const DIMS: DimensaoCliente[] = ['TERMO', 'FINANCEIRO', 'HOUSE'];

const dimensao = (dim: DimensaoCliente, e: Estado): ResultadoDimensao => {
  switch (e) {
    case 'RESOLVIDO': return { estado: 'RESOLVIDO', detalhe: 'OK', em: T(1), evidencia: ev(`${dim}-ok`) };
    case 'PENDENTE': return { estado: 'PENDENTE', motivo: `${dim}_PENDENTE`, responsavel: 'CLIENTE', acao: null, classe: 'D', episodio: `${dim}|pendente`, desde: T(2) };
    case 'DESCONHECIDO': return { estado: 'DESCONHECIDO', motivo: 'FONTE_INDISPONIVEL', ind: indeterminacao([], ['HEADCARGO_FINANCEIRO_CLIENTE']), episodio: `${dim}|desconhecido` };
    default: return { estado: 'NAO_DETERMINAVEL', ind: indeterminacao(['HEADCARGO_TERMO_UNICO']) };
  }
};

const overridesPara = (estados: Record<DimensaoCliente, Estado>, aceita: boolean): Override[] => DIMS.map((d, n) => override({
  id: `OV-${d}`, pendencia: { dimensao: d, episodio: `${d}|${estados[d] === 'PENDENTE' ? 'pendente' : 'desconhecido'}` },
  cobreCondicaoDesconhecida: true,
  decisao: { tipo: 'APROVADO', por: { pessoaId: `gestor-${n}`, papel: 'MANAGER' }, em: T(4), justificativa: 'ok', aceitaCondicaoDesconhecida: aceita },
}));

/** Oráculo independente da regra: concluído → override cobrindo tudo → pendente descoberto bloqueia → não determinável → informação indisponível. */
function esperado(estados: Record<DimensaoCliente, Estado>, comOverride: boolean, aceita: boolean): string {
  const abertos = DIMS.filter((d) => estados[d] !== 'RESOLVIDO');
  if (!abertos.length) return 'PERMITIDO/CLIENTE_CONCLUIDO';
  const coberto = (d: DimensaoCliente) => comOverride && (estados[d] === 'PENDENTE' || (estados[d] === 'DESCONHECIDO' && aceita));
  const descobertos = abertos.filter((d) => !coberto(d));
  if (!descobertos.length) return 'PERMITIDO/OVERRIDE';
  if (descobertos.some((d) => estados[d] === 'PENDENTE')) return 'BLOQUEADO';
  if (descobertos.some((d) => estados[d] === 'NAO_DETERMINAVEL')) return 'NAO_DETERMINAVEL';
  return 'INFORMACAO_INDISPONIVEL';
}

test('[R11] tabela-verdade Termo × Financeiro × House × Override (192 combinações); possível ≠ permitido', () => {
  let n = 0;
  for (const t of ESTADOS) for (const f of ESTADOS) for (const h of ESTADOS) {
    const estados = { TERMO: t, FINANCEIRO: f, HOUSE: h };
    const dims = { TERMO: dimensao('TERMO', t), FINANCEIRO: dimensao('FINANCEIRO', f), HOUSE: dimensao('HOUSE', h) };
    for (const [comOverride, aceita] of [[false, false], [true, false], [true, true]] as const) {
      const g = portaoDoCliente('IM100', dims, 'INICIAR_PROCEDIMENTO', comOverride ? overridesPara(estados, aceita) : []);
      const obtido = g.tipo === 'PERMITIDO' ? `PERMITIDO/${g.via}` : g.tipo;
      assert.equal(obtido, esperado(estados, comOverride, aceita), JSON.stringify({ estados, comOverride, aceita }));
      assert.equal(g.tecnicamentePossivel, true);
      if (g.tipo === 'BLOQUEADO') assert.deepEqual(g.pendencias, DIMS.filter((d) => estados[d] === 'PENDENTE' && !comOverride));
      n++;
    }
  }
  assert.equal(n, 192);
});

/* ------------------------------------ Termo ------------------------------------ */

test('Termo: Único válido resolve; validade explícita ou revalidação vencidas pedem reconfirmação (com a fonte fora, dito explicitamente)', () => {
  const tu = (validoAte: string | null, reconfirmarAte: string | null) => oficial({ situacao: 'POSSUI' as const, validoAte, reconfirmarAte }, T(1));
  assert.equal(situacaoDoTermo({ agora: T(10), termoUnico: integ(tu(T(20), null)), termoEmbarque: integ(null) }).estado, 'RESOLVIDO');
  const vencido = situacaoDoTermo({ agora: T(10), termoUnico: integ(tu(T(5), null)), termoEmbarque: integ(null) });
  assert.equal(vencido.estado === 'DESCONHECIDO' && vencido.motivo, 'RECONFIRMACAO_NECESSARIA');
  const foraDoAr = situacaoDoTermo({ agora: T(10), termoUnico: integ(tu(null, T(8)), FORA()), termoEmbarque: integ(null) });
  assert.equal(foraDoAr.estado === 'DESCONHECIDO' && foraDoAr.motivo, 'RECONFIRMACAO_NECESSARIA_FONTE_INDISPONIVEL');
  // Indisponibilidade sozinha não invalida o dado (N-17).
  assert.equal(situacaoDoTermo({ agora: T(10), termoUnico: integ(tu(T(20), null), FORA()), termoEmbarque: integ(null) }).estado, 'RESOLVIDO');
});

test('Termo por Embarque: revisão do Analista é ação da Rocket (C); reprovação é do cliente (D); sem segurança, nunca aprovação', () => {
  const base = {
    camposObrigatoriosFaltantes: [] as string[], assinadoEm: T(3), signatario: { identificavel: true, identificador: 'CPF:1' },
    procuracao: { conteudoInequivoco: true, outorgados: ['CPF:1'], validaAte: T(30), poderes: 'SUFICIENTES' as const },
  };
  assert.deepEqual(validarTermoPorEmbarque({ ...base, signatario: { identificavel: false, identificador: null } }), { resultado: 'REVISAO', motivos: ['ASSINATURA_NAO_IDENTIFICA_O_SIGNATARIO'] });
  assert.deepEqual(validarTermoPorEmbarque({ ...base, procuracao: { ...base.procuracao, poderes: 'AMBIGUOS' } }), { resultado: 'REVISAO', motivos: ['PODERES_AMBIGUOS'] });
  assert.deepEqual(validarTermoPorEmbarque({ ...base, procuracao: { ...base.procuracao, validaAte: T(2) } }), { resultado: 'REPROVADO', motivos: ['PROCURACAO_VENCIDA'] });
  assert.deepEqual(validarTermoPorEmbarque({ ...base, signatario: { identificavel: true, identificador: 'CPF:9' }, procuracao: { ...base.procuracao, poderes: 'AMBIGUOS' } }),
    { resultado: 'REPROVADO', motivos: ['SIGNATARIO_NAO_OUTORGADO'] }, 'reprovação explícita prevalece sobre revisão');

  const naoPossui = integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1)));
  const emRevisao = decidir({ termoUnico: naoPossui, termoEmbarque: integ({ situacao: 'ENVIADO', em: T(3), evidencia: ev('t'), validacao: validarTermoPorEmbarque({ ...base, procuracao: { ...base.procuracao, conteudoInequivoco: false } }), revisao: null }) });
  const r = item(emRevisao, 'TERMO_POR_EMBARQUE_EM_REVISAO');
  assert.deepEqual([r?.responsavel, r?.acao, r?.classe], ['ROCKET', 'REVISAR_TERMO_POR_EMBARQUE', 'C']);
  const aprovadoNaRevisao = decidir({ termoUnico: naoPossui, termoEmbarque: integ({ situacao: 'ENVIADO', em: T(3), evidencia: ev('t'), validacao: { resultado: 'REVISAO', motivos: ['PROCURACAO_AMBIGUA'] }, revisao: { decisao: 'APROVADO', por: 'ana', em: T(4), motivo: null, evidencia: ev('rev') } }) });
  assert.equal(aprovadoNaRevisao.cliente.dimensoes.TERMO.estado, 'RESOLVIDO');
  const aguardando = decidir({ termoUnico: naoPossui, termoEmbarque: integ({ situacao: 'AGUARDANDO_CLIENTE', desde: T(2), evidencia: ev('portal') }) });
  assert.deepEqual([item(aguardando, 'TERMO_POR_EMBARQUE_PENDENTE')?.responsavel, item(aguardando, 'TERMO_POR_EMBARQUE_PENDENTE')?.classe], ['CLIENTE', 'D']);
});

test('Financeiro: PAGO e PRAZO válido resolvem; sem pagamento e sem prazo é pendência do cliente (D); reversão é mudança oficial', () => {
  const f = (situacao: 'PAGO' | 'PRAZO' | 'SEM_PAGAMENTO_SEM_PRAZO', validoAte: string | null = null) => ({ situacao, validoAte, reconfirmarAte: null });
  assert.equal(situacaoDoFinanceiro(T(10), integ(oficial(f('PAGO'), T(1)))).estado, 'RESOLVIDO');
  assert.equal(situacaoDoFinanceiro(T(10), integ(oficial(f('PRAZO', T(20)), T(1)))).estado, 'RESOLVIDO');
  assert.equal(situacaoDoFinanceiro(T(10), integ(oficial(f('PRAZO', T(5)), T(1)))).estado, 'DESCONHECIDO');
  const revertido = situacaoDoFinanceiro(T(10), integ(oficial(f('SEM_PAGAMENTO_SEM_PRAZO'), T(6), [fato(f('PAGO'), T(1))])));
  assert.equal(revertido.estado, 'PENDENTE');
  assert.equal(revertido.mudancaOficial, true);
  const fora = situacaoDoFinanceiro(T(10), integ(vazio(), FORA()));
  assert.equal(fora.estado === 'DESCONHECIDO' && fora.motivo, 'FONTE_INDISPONIVEL', 'fora sem fato anterior: informação indisponível, nunca "não pago"');
  assert.equal(situacaoDoFinanceiro(T(10), { tipo: 'NAO_INTEGRADA' }).estado, 'NAO_DETERMINAVEL');
});

/* ------------------------------------ House ------------------------------------ */

test('[R12] House: caminho A (foto + Analista), caminho B (original na Rocket) e Telex (e-mail do agente)', () => {
  const foto = (decisao: null | 'CONFIRMADO' | 'REPROVADO') => ({
    recebidaEm: T(3), evidencia: ev('foto'), alertasOcr: [],
    decisao: decisao ? { tipo: decisao, por: 'ana', em: T(4), motivo: decisao === 'REPROVADO' ? 'ilegível' : null, evidencia: ev(`analista-${decisao}`) } : null,
  });
  const a = decidir({ fotosHbl: integ([foto('CONFIRMADO')]) });
  assert.deepEqual(a.house.caminhos.map((c) => c.caminho), ['A_FOTO_CONFIRMADA_PELO_ANALISTA']);
  const b = decidir({ courier: courier({ hblOriginal: fato('RECEBIDO_E_CONFERIDO' as const, T(3)) }) });
  assert.deepEqual(b.house.caminhos.map((c) => c.caminho), ['B_ORIGINAL_RECEBIDO_PELA_ROCKET']);
  assert.equal(b.house.l1a.tipo, 'RESOLVIDO', 'o caminho B continua sendo a L1a congelada');
  const telex = decidir({ telex: integ(oficial('APTO' as const, T(3))) });
  assert.deepEqual(telex.house.caminhos.map((c) => c.caminho), ['TELEX']);

  const modalidade = (m: { tipo: 'TELEX' } | { tipo: 'FISICO'; encaminhadoA: 'CLIENTE' | 'ROCKET' | null }) => integ({ house: fato(m, T(2)), pedidos: [] });
  const casos: Array<[Parameters<typeof decidir>[0], string, string, string, string]> = [
    [{ modalidadeBl: modalidade({ tipo: 'TELEX' }) }, 'TELEX_AGUARDANDO_AGENTE', 'AGENTE', 'AGUARDAR_TELEX_DO_AGENTE', 'D'],
    [{ modalidadeBl: modalidade({ tipo: 'FISICO', encaminhadoA: 'CLIENTE' }) }, 'FOTO_DO_HBL_PENDENTE', 'CLIENTE', 'AGUARDAR_FOTO_DO_HBL', 'D'],
    [{ fotosHbl: integ([foto('REPROVADO')]) }, 'FOTO_DO_HBL_REPROVADA', 'CLIENTE', 'AGUARDAR_NOVA_FOTO_DO_HBL', 'D'],
    [{ fotosHbl: integ([foto(null)]) }, 'FOTO_DO_HBL_AGUARDANDO_ANALISTA', 'ROCKET', 'VALIDAR_HBL_FISICO', 'C'],
    [{ modalidadeBl: modalidade({ tipo: 'FISICO', encaminhadoA: 'ROCKET' }), courier: courier({ envelope: fato('EM_TRANSITO' as const, T(3)) }) }, 'HBL_FISICO_EM_TRANSITO', 'TERCEIRO', 'AGUARDAR_HBL_FISICO', 'D'],
    [{ modalidadeBl: modalidade({ tipo: 'FISICO', encaminhadoA: 'ROCKET' }), courier: courier({ envelope: fato('ENTREGUE' as const, T(3)) }) }, 'CONFERENCIA_DO_HBL_PENDENTE', 'ROCKET', 'CONFERIR_HBL_NO_COURIER', 'C'],
    [{ modalidadeBl: modalidade({ tipo: 'FISICO', encaminhadoA: 'ROCKET' }), courier: courier({ hblOriginal: fato('AUSENTE_NA_CONFERENCIA' as const, T(3)) }) }, 'HBL_AUSENTE_NA_CONFERENCIA', 'AGENTE', 'ACOMPANHAR_HBL_AUSENTE_COM_O_AGENTE', 'D'],
    [{}, 'MODALIDADE_DO_HOUSE_DESCONHECIDA', 'ROCKET', 'IDENTIFICAR_MODALIDADE_DO_HOUSE', 'C'],
  ];
  for (const [p, motivo, responsavel, acao, classe] of casos) {
    const i = item(decidir(p), motivo);
    assert.deepEqual([i?.responsavel, i?.acao, i?.classe], [responsavel, acao, classe], motivo);
  }
  // Telex sem fonte de e-mail: não se adivinha; não determinável.
  assert.equal(decidir({ modalidadeBl: modalidade({ tipo: 'TELEX' }), telex: { tipo: 'NAO_INTEGRADA' } }).house.resultado.estado, 'NAO_DETERMINAVEL');
});

/* ----------------------------------- override ----------------------------------- */

test('[R13] override: escopo processo + pendência/episódio + ação; separação de papéis; mudança material, execução e resolução encerram', () => {
  const pendente: ResultadoDimensao = { estado: 'PENDENTE', motivo: 'X', responsavel: 'CLIENTE', acao: null, classe: 'D', episodio: 'FINANCEIRO|ep1', desde: T(2) };
  const o = override({ pendencia: { dimensao: 'FINANCEIRO', episodio: 'FINANCEIRO|ep1' } });
  assert.equal(overrideCobre(o, 'IM100', 'FINANCEIRO', pendente, 'INICIAR_PROCEDIMENTO'), true);
  assert.equal(overrideCobre(o, 'IM100', 'FINANCEIRO', pendente, 'APRESENTAR'), false, 'INICIAR_PROCEDIMENTO não autoriza APRESENTAR');
  assert.equal(overrideCobre(o, 'IM101', 'FINANCEIRO', pendente, 'INICIAR_PROCEDIMENTO'), false, 'outro processo');
  assert.equal(overrideCobre(o, 'IM100', 'TERMO', { ...pendente, episodio: 'FINANCEIRO|ep1' }, 'INICIAR_PROCEDIMENTO'), false, 'outra pendência');
  assert.equal(overrideCobre(o, 'IM100', 'FINANCEIRO', { ...pendente, episodio: 'FINANCEIRO|ep2' }, 'INICIAR_PROCEDIMENTO'), false, 'mudança material');
  assert.equal(overrideCobre({ ...o, executadoEm: T(6) }, 'IM100', 'FINANCEIRO', pendente, 'INICIAR_PROCEDIMENTO'), false, 'executado');

  // Papéis: ANALYST solicita, MANAGER/ADMIN decide, pessoas diferentes, justificativa e evidência.
  assert.deepEqual(problemasDoOverride(override({ solicitadoPor: { pessoaId: 'gil', papel: 'MANAGER' } })), ['SOLICITANTE_NAO_E_ANALYST', 'SOLICITANTE_E_APROVADOR_SAO_A_MESMA_PESSOA']);
  assert.deepEqual(problemasDoOverride(override({ decisao: { tipo: 'APROVADO', por: { pessoaId: 'ana', papel: 'ANALYST' }, em: T(4), justificativa: 'x', aceitaCondicaoDesconhecida: false } })),
    ['DECISAO_SEM_PAPEL_DE_GESTOR', 'SOLICITANTE_E_APROVADOR_SAO_A_MESMA_PESSOA']);
  assert.deepEqual(problemasDoOverride(override({ justificativa: ' ', evidencias: [] })), ['SEM_JUSTIFICATIVA', 'SEM_EVIDENCIA']);
  assert.ok(problemasDoOverride(override({ decisao: { tipo: 'APROVADO', por: { pessoaId: 'z', papel: 'ADMIN' }, em: T(4), justificativa: 'ok', aceitaCondicaoDesconhecida: false } })).length === 0);
  assert.equal(overrideCobre(override({ solicitadoPor: { pessoaId: 'x', papel: 'CLIENT' } }), 'IM100', 'FINANCEIRO', pendente, 'INICIAR_PROCEDIMENTO'), false);

  // Situações para exibição.
  const dims = { TERMO: pendente, FINANCEIRO: pendente, HOUSE: pendente };
  assert.equal(situacaoDoOverride(o, 'IM100', { ...dims, FINANCEIRO: pendente }), 'VALIDO_E_APLICAVEL');
  assert.equal(situacaoDoOverride(o, 'IM100', { ...dims, FINANCEIRO: { estado: 'RESOLVIDO', detalhe: 'PAGO', em: T(5), evidencia: ev('pago') } }), 'SEM_EFEITO', 'pendência resolvida');
  assert.equal(situacaoDoOverride(override({ decisao: { tipo: 'REJEITADO', por: { pessoaId: 'gil', papel: 'MANAGER' }, em: T(4), justificativa: 'não', aceitaCondicaoDesconhecida: false } }), 'IM100', dims), 'REJEITADO');
  assert.equal(situacaoDoOverride(override({ solicitadoPor: { pessoaId: 'gil', papel: 'ANALYST' } }), 'IM100', dims), 'INVALIDO');
});

test('[R13] condição desconhecida só com identificação explícita E aceite expresso; fonte não integrada nunca', () => {
  const desconhecido: ResultadoDimensao = { estado: 'DESCONHECIDO', motivo: 'FONTE_INDISPONIVEL', ind: indeterminacao([], ['HEADCARGO_FINANCEIRO_CLIENTE']), episodio: 'FINANCEIRO|desc' };
  const base = { pendencia: { dimensao: 'FINANCEIRO' as const, episodio: 'FINANCEIRO|desc' } };
  const aceite = (aceita: boolean) => ({ tipo: 'APROVADO' as const, por: { pessoaId: 'gil', papel: 'MANAGER' as const }, em: T(4), justificativa: 'ok', aceitaCondicaoDesconhecida: aceita });
  assert.equal(overrideCobre(override({ ...base, cobreCondicaoDesconhecida: false, decisao: aceite(true) }), 'IM100', 'FINANCEIRO', desconhecido, 'INICIAR_PROCEDIMENTO'), false);
  assert.equal(overrideCobre(override({ ...base, cobreCondicaoDesconhecida: true, decisao: aceite(false) }), 'IM100', 'FINANCEIRO', desconhecido, 'INICIAR_PROCEDIMENTO'), false);
  assert.equal(overrideCobre(override({ ...base, cobreCondicaoDesconhecida: true, decisao: aceite(true) }), 'IM100', 'FINANCEIRO', desconhecido, 'INICIAR_PROCEDIMENTO'), true);
  const naoIntegrada: ResultadoDimensao = { estado: 'NAO_DETERMINAVEL', ind: indeterminacao(['HEADCARGO_FINANCEIRO_CLIENTE']) };
  assert.equal(overrideCobre(override({ ...base, cobreCondicaoDesconhecida: true, decisao: aceite(true) }), 'IM100', 'FINANCEIRO', naoIntegrada, 'INICIAR_PROCEDIMENTO'), false);
});
