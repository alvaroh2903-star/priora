import {
  Agencia, ApresentacaoDoMaster, BlEncaminhadoParaApresentacao, CourierDoProcesso, DecisaoDoProcesso, DisponibilidadeFonte, EntradaDecisao, EstadoOficial, EventoDeProcedimento, Evidencia,
  FatoOficial, Instante, Integrado, ItemOperacional, MarcoTemporal, Override, TipoEventoProcedimento, VinculoProcessoMaster, decidirProcesso,
} from '../../index';

/** Fixtures em memória da L1b (nenhum banco, nenhuma fonte real, nenhum relógio). */

/** Instante de outubro de 2026 em UTC. */
export const T = (dia: number, hora = 0, minuto = 0): Instante => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `2026-10-${p(dia)}T${p(hora)}:${p(minuto)}:00.000Z`;
};

export const ev = (ref: string, fonte = 'teste'): Evidencia => ({ fonte, ref });

export const fato = <V>(valor: V, em: Instante, confirmadoEm: Instante = em, ref = `${JSON.stringify(valor)}@${em}`): FatoOficial<V> => ({
  valor, vigenteDesde: em, ultimaConfirmacaoEm: confirmadoEm, evidencia: ev(ref),
});

export const DISP: DisponibilidadeFonte = { disponivel: true, desde: T(1) };
export const FORA = (desde: Instante = T(9)): DisponibilidadeFonte => ({ disponivel: false, desde });

export const integ = <V>(valor: V, fonte: DisponibilidadeFonte = DISP): Integrado<V> => ({ tipo: 'INTEGRADA', fonte, valor });
export const oficial = <V>(valor: V, em: Instante, historico: ReadonlyArray<FatoOficial<V>> = []): EstadoOficial<V> =>
  ({ oficial: fato(valor, em), historico });
export const vazio = <V>(): EstadoOficial<V> => ({ oficial: null, historico: [] });

export const vinculo = (processoId: string, masterId: string, em: Instante = T(1)): VinculoProcessoMaster =>
  ({ processoId, masterId, vinculadoEm: em, evidencia: ev(`pre-alerta-${processoId}`, 'auditoria') });

export const courier = (p: Partial<CourierDoProcesso> = {}): CourierDoProcesso => ({
  fonte: DISP, envelope: null, mbl: null, hblOriginal: null, ...p,
});

export const PORTO_SANTOS = { fusoConfiavel: 'America/Sao_Paulo', brasileiro: true };

export const data = (valor: string): MarcoTemporal => ({ bruto: valor, precisao: 'DATA', valor });
export const instante = (valor: Instante): MarcoTemporal => ({ bruto: valor, precisao: 'DATA_HORA_COM_FUSO', valor });

/**
 * Mundo da L1b com TODAS as fontes integradas, disponíveis e sem nenhum fato
 * (ausência observável). Cada teste acrescenta só o que precisa.
 */
export function mundo(p: Partial<EntradaDecisao> = {}): EntradaDecisao {
  const processoId = p.processoId ?? 'IM100';
  return {
    processoId,
    agora: T(10),
    vinculo: { tipo: 'VINCULADO', vinculo: vinculo(processoId, 'M1') },
    fatosDoMasterL1a: [],
    courier: courier(),
    wave: integ([]),
    emissaoDestino: integ({ consultasAoArmador: [], autorizacoes: [] }),
    preAlerta: integ(vazio()),
    modalidadeBl: integ({ house: null, pedidos: [] }),
    fotosHbl: integ([]),
    telex: integ(vazio()),
    termoUnico: integ(vazio()),
    termoEmbarque: integ(null),
    financeiroCliente: integ(vazio()),
    overrides: [],
    armador: integ(vazio()),
    procedimento: integ({ eventos: [], encaminhamentos: [], apresentacoes: [] }),
    pagamentoArmador: integ({ masterId: 'M1', estado: vazio() }),
    pagamentosExecutadosPelaRocket: [],
    invalidacoesDePagamentoAoArmador: [],
    viagem: integ({
      porto: PORTO_SANTOS, eta: vazio(), ata: null, atracacaoPrevista: null, atracacao: null, viagensFinais: [],
    }),
    ceHouse: integ(vazio()),
    siscargaFrete: integ(vazio()),
    siscargaFiscal: integ(vazio()),
    verificacaoFinal: null,
    ecac: [],
    rota: integ({ alteracao: null, ceMasterRetificado: null, ceHouseRetificado: null }),
    falhaDaRocket: null,
    liberado: null,
    ...p,
  };
}

/* ---------------------------------- atalhos ---------------------------------- */

export const MBL_RECEBIDO = (em: Instante = T(2)) => courier({ mbl: fato('RECEBIDO' as const, em), hblOriginal: fato('RECEBIDO_E_CONFERIDO' as const, em) });

/** Cliente concluído: Termo Único válido, financeiro pago, House pelo caminho B (HBL original conferido). */
export const clienteOk = (): Partial<EntradaDecisao> => ({
  termoUnico: integ(oficial({ situacao: 'POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))),
  financeiroCliente: integ(oficial({ situacao: 'PAGO' as const, validoAte: null, reconfirmarAte: null }, T(1))),
  courier: MBL_RECEBIDO(),
});

export const armador = (codigo: string, masterId = 'M1') => integ(oficial({ masterId, codigo }, T(1)));

export const evento = (tipo: TipoEventoProcedimento, em: Instante, masterId = 'M1'): EventoDeProcedimento =>
  ({ masterId, tipo, em, evidencia: ev(`${tipo}@${em}`, 'agencia') });

export const apresentacao = (
  tipoEvidencia: ApresentacaoDoMaster['tipoEvidencia'], em: Instante, confirmadaPor: string | null = null, masterId = 'M1',
): ApresentacaoDoMaster => ({
  masterId, momento: { precisao: 'INSTANTE', instante: em }, registradaEm: em, evidencia: ev(`apresentacao@${em}`, 'agencia'), tipoEvidencia,
  confirmacaoDoAnalista: confirmadaPor ? { por: confirmadaPor, em } : null, processosVinculadosNaAcao: ['IM100'],
});

/** P13: o Analista registrou o BL encaminhado para apresentação. */
export const encaminhado = (em: Instante, ator = 'ana', agencia: Agencia | null = null, masterId = 'M1'): BlEncaminhadoParaApresentacao =>
  ({ tipo: 'BL_ENCAMINHADO_PARA_APRESENTACAO', masterId, agencia, ator, em, evidencia: ev(`encaminhado@${em}`, 'analista') });

export const procedimento = (eventos: EventoDeProcedimento[], apresentacoes: ApresentacaoDoMaster[] = [], encaminhamentos: BlEncaminhadoParaApresentacao[] = []) =>
  integ({ eventos, encaminhamentos, apresentacoes });

export const pagamento = (situacao: 'PENDENTE' | 'FINALIZADO', em: Instante, masterId = 'M1', historico: Array<FatoOficial<{ situacao: 'PENDENTE' | 'FINALIZADO'; finalizadoEm: null }>> = []) =>
  integ({ masterId, estado: oficial({ situacao, finalizadoEm: null }, em, historico) });

export const execucaoRocket = (em: Instante, masterId = 'M1') => ({ masterId, por: 'financeiro-rocket', em, evidencia: ev(`pagamento-rocket@${em}`, 'financeiro') });

export const viagem = (p: Partial<{ eta: MarcoTemporal; ata: MarcoTemporal; atracacaoPrevista: MarcoTemporal; atracacao: MarcoTemporal; viagens: string[]; porto: typeof PORTO_SANTOS | { fusoConfiavel: string | null; brasileiro: boolean | null } }> = {}, fonte: DisponibilidadeFonte = DISP) =>
  integ({
    porto: p.porto ?? PORTO_SANTOS,
    eta: p.eta ? oficial(p.eta, T(1)) : vazio<MarcoTemporal>(),
    ata: p.ata ? fato(p.ata, T(1)) : null,
    atracacaoPrevista: p.atracacaoPrevista ? fato(p.atracacaoPrevista, T(1)) : null,
    atracacao: p.atracacao ? fato(p.atracacao, T(1)) : null,
    viagensFinais: (p.viagens ?? []).map((v, i) => ({ conteiner: `CONT${i}`, viagemFinal: v, evidencia: ev(`viagem-${i}`, 'tracking') })),
  }, fonte);

export const override = (p: Partial<Override> = {}): Override => ({
  id: 'OV1', processoId: 'IM100', pendencia: { dimensao: 'FINANCEIRO', episodio: 'FINANCEIRO|SEM_PAGAMENTO_E_SEM_PRAZO|x' },
  acao: 'INICIAR_PROCEDIMENTO', cobreCondicaoDesconhecida: false, justificativa: 'cliente garante pagamento', evidencias: [ev('email-cliente')],
  solicitadoPor: { pessoaId: 'ana', papel: 'ANALYST' }, solicitadoEm: T(3),
  decisao: { tipo: 'APROVADO', por: { pessoaId: 'gil', papel: 'MANAGER' }, em: T(4), justificativa: 'cliente histórico', aceitaCondicaoDesconhecida: false },
  executadoEm: null, ...p,
});

/* -------------------------------- leitura do resultado -------------------------------- */

export const decidir = (p: Partial<EntradaDecisao> = {}): DecisaoDoProcesso => decidirProcesso(mundo(p));

export const etapaDe = (d: DecisaoDoProcesso) => (d.etapa.tipo === 'DETERMINADA' ? d.etapa.etapa : 'NAO_DETERMINAVEL');
export const acaoPrincipal = (d: DecisaoDoProcesso) => d.principal?.acao ?? null;
export const item = (d: DecisaoDoProcesso, motivo: string): ItemOperacional | undefined => d.itens.find((i) => i.motivo === motivo);
export const acoes = (d: DecisaoDoProcesso) => d.itens.map((i) => i.acao).filter((a) => a !== null);
