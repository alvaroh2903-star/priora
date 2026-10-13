import { DisponibilidadeFonte, Evidencia, FatoOficial, Instante } from './tipos';

/**
 * Fato da Liberação com as três dimensões do N-17 e a regra de mudança
 * material do N-16. Função pura: recebe o estado e uma observação e devolve o
 * novo estado e a descrição do que mudou. Não grava nada.
 *
 *  - mesma observação oficial → não muda o fato; só o frescor pode avançar;
 *  - valor oficial diferente → mudança material (o anterior vai ao histórico);
 *  - fonte indisponível/disponível → muda só a disponibilidade, nunca o fato;
 *  - evidência não oficial válida e incompatível → divergência aberta, sem
 *    sobrescrever o fato oficial (N-9, N-14, cap. 22); duplicada → nada;
 *    inválida (genérica, sem vínculo) → nada (cap. 5, 41);
 *  - reconfirmação do mesmo estado não resolve a divergência; só uma nova
 *    observação oficial que elimine a incompatibilidade a resolve (N-16a);
 *  - fato oficial terminal não é reaberto por observação posterior (cap. 39).
 *
 * Ciclo da divergência (N-14), também puro (`transicionarDivergencia`):
 * ABERTA → EM_ANALISE → ABERTA (as duas evidências continuam válidas) |
 * ENCERRADA_POR_EVIDENCIA_INVALIDA (só contra a evidência NÃO oficial, com
 * prova e justificativa) | RESOLVIDA_PELA_FONTE_DE_VERDADE (só por observação
 * oficial que elimina o conflito, também a partir de ABERTA). Análise humana
 * sozinha nunca fecha um conflito válido; estados finais são imutáveis; um
 * conflito posterior abre outra divergência; indisponibilidade da fonte não
 * abre nem resolve divergência. Autor, instante, evidência e justificativa
 * vêm na entrada: nada é gerado aqui.
 */

export interface EvidenciaNaoOficial<V> {
  valor: V;
  observadoEm: Instante;
  evidencia: Evidencia;
}

export type EstadoDivergencia = 'ABERTA' | 'EM_ANALISE' | 'ENCERRADA_POR_EVIDENCIA_INVALIDA' | 'RESOLVIDA_PELA_FONTE_DE_VERDADE';

/** Uma transição registrada: autor, instante, estado anterior e posterior, evidência e justificativa (cap. 6). */
export interface TransicaoDivergencia {
  de: EstadoDivergencia | null;
  para: EstadoDivergencia;
  em: Instante;
  /** null = a própria fonte de verdade (observação oficial). */
  autor: string | null;
  justificativa: string | null;
  evidencia: Evidencia;
}

export interface Divergencia<V> {
  estado: EstadoDivergencia;
  valorDivergente: V;
  /** Evidência NÃO oficial que diverge do fato oficial. */
  evidencia: Evidencia;
  abertaEm: Instante;
  transicoes: ReadonlyArray<TransicaoDivergencia>;
}

export interface EstadoDoFato<V> {
  oficial: FatoOficial<V> | null;
  fonte: DisponibilidadeFonte;
  /** Valores oficiais substituídos por mudança oficial (N-16b), do mais antigo ao mais recente. */
  historico: ReadonlyArray<FatoOficial<V>>;
  evidenciasNaoOficiais: ReadonlyArray<EvidenciaNaoOficial<V>>;
  divergencias: ReadonlyArray<Divergencia<V>>;
}

export type Observacao<V> =
  | { tipo: 'OFICIAL'; valor: V; observadoEm: Instante; evidencia: Evidencia }
  | { tipo: 'FONTE_INDISPONIVEL'; em: Instante }
  | { tipo: 'FONTE_DISPONIVEL'; em: Instante }
  | { tipo: 'NAO_OFICIAL'; valor: V; observadoEm: Instante; evidencia: Evidencia; valida: boolean };

export type Mudanca<V> =
  | { tipo: 'FATO_OFICIAL_ESTABELECIDO'; valor: V }
  | { tipo: 'FATO_OFICIAL_ALTERADO'; anterior: V; atual: V }
  | { tipo: 'CONFIRMACAO_ATUALIZADA'; em: Instante }
  | { tipo: 'DISPONIBILIDADE_ALTERADA'; disponivel: boolean; desde: Instante }
  | { tipo: 'EVIDENCIA_NAO_OFICIAL_REGISTRADA'; evidencia: Evidencia }
  | { tipo: 'DIVERGENCIA_ABERTA'; valorDivergente: V; evidencia: Evidencia }
  | { tipo: 'DIVERGENCIA_EM_ANALISE'; autor: string }
  | { tipo: 'DIVERGENCIA_MANTIDA_ABERTA'; autor: string }
  | { tipo: 'DIVERGENCIA_ENCERRADA_POR_EVIDENCIA_INVALIDA'; autor: string; prova: Evidencia }
  | { tipo: 'DIVERGENCIA_RESOLVIDA_PELA_FONTE_DE_VERDADE'; evidencia: Evidencia }
  | { tipo: 'TERMINAL_PRESERVADO'; observado: V; evidencia: Evidencia };

export interface ResultadoObservacao<V> {
  estado: EstadoDoFato<V>;
  /** O fato oficial mudou (estabelecido ou alterado). Frescor, disponibilidade e evidência não oficial não são materiais. */
  material: boolean;
  /** O que mudou; vazio = nada mudou (observação idêntica, antiga, duplicada ou inválida). */
  mudancas: ReadonlyArray<Mudanca<V>>;
}

export interface OpcoesFato<V> {
  /** Valor terminal (ex.: LIBERADO): uma vez oficial, não é reaberto. */
  terminal?: (valor: V) => boolean;
}

export const ms = (instante: Instante): number => {
  const t = Date.parse(instante);
  if (Number.isNaN(t)) throw new Error(`instante inválido: ${instante}`);
  return t;
};

const ISO_COM_FRACAO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** Segundos absolutos (o fuso entra aqui) e a fração em nanossegundos, como texto de 9 dígitos. */
function emPartes(instante: Instante): { segundos: number; fracao: string } {
  const m = ISO_COM_FRACAO.exec(instante);
  if (m) {
    const t = Date.parse(`${m[1]}${m[3]}`);
    if (!Number.isNaN(t)) return { segundos: t / 1000, fracao: (m[2] ?? '').slice(0, 9).padEnd(9, '0') };
  }
  const t = ms(instante);
  const resto = ((t % 1000) + 1000) % 1000;
  return { segundos: (t - resto) / 1000, fracao: String(resto).padStart(3, '0').padEnd(9, '0') };
}

/**
 * Ordem exata de dois instantes (N-16): negativo, zero ou positivo. Não perde a
 * fração além do milissegundo — o banco grava microssegundos e `Date.parse`
 * truncaria uma observação realmente posterior para "simultânea". O fuso vale
 * pelo instante absoluto; instantes sem fração ou em ms comparam como antes.
 */
export function compararInstantes(a: Instante, b: Instante): number {
  const x = emPartes(a);
  const y = emPartes(b);
  if (x.segundos !== y.segundos) return x.segundos < y.segundos ? -1 : 1;
  return x.fracao === y.fracao ? 0 : x.fracao < y.fracao ? -1 : 1;
}

export function estadoInicial<V>(fonte: DisponibilidadeFonte): EstadoDoFato<V> {
  return { oficial: null, fonte, historico: [], evidenciasNaoOficiais: [], divergencias: [] };
}

const ATIVOS: ReadonlyArray<EstadoDivergencia> = ['ABERTA', 'EM_ANALISE'];

/** A divergência ativa do fato (ABERTA ou EM_ANALISE); no máximo uma por vez. */
export const divergenciaAtiva = <V>(estado: EstadoDoFato<V>): Divergencia<V> | null =>
  estado.divergencias.find((d) => ATIVOS.includes(d.estado)) ?? null;

const transicionar = <V>(
  estado: EstadoDoFato<V>, alvo: Divergencia<V>, para: EstadoDivergencia,
  t: Omit<TransicaoDivergencia, 'de' | 'para'>,
): EstadoDoFato<V> => ({
  ...estado,
  divergencias: estado.divergencias.map((d) => (d === alvo
    ? { ...d, estado: para, transicoes: [...d.transicoes, { de: d.estado, para, ...t }] }
    : d)),
});

export function aplicarObservacao<V>(estado: EstadoDoFato<V>, obs: Observacao<V>, opcoes: OpcoesFato<V> = {}): ResultadoObservacao<V> {
  const nada: ResultadoObservacao<V> = { estado, material: false, mudancas: [] };

  if (obs.tipo === 'FONTE_INDISPONIVEL' || obs.tipo === 'FONTE_DISPONIVEL') {
    const disponivel = obs.tipo === 'FONTE_DISPONIVEL';
    if (estado.fonte.disponivel === disponivel) return nada;
    return {
      estado: { ...estado, fonte: { disponivel, desde: obs.em } },
      material: false,
      mudancas: [{ tipo: 'DISPONIBILIDADE_ALTERADA', disponivel, desde: obs.em }],
    };
  }

  if (obs.tipo === 'NAO_OFICIAL') {
    if (!obs.valida) return nada;
    const duplicada = estado.evidenciasNaoOficiais.some(
      (e) => e.evidencia.fonte === obs.evidencia.fonte && e.evidencia.ref === obs.evidencia.ref,
    );
    if (duplicada) return nada;
    const registrada: EvidenciaNaoOficial<V> = { valor: obs.valor, observadoEm: obs.observadoEm, evidencia: obs.evidencia };
    const mudancas: Mudanca<V>[] = [{ tipo: 'EVIDENCIA_NAO_OFICIAL_REGISTRADA', evidencia: obs.evidencia }];
    let divergencias = estado.divergencias;
    const incompativel = estado.oficial !== null && !Object.is(estado.oficial.valor, obs.valor);
    if (incompativel && !divergenciaAtiva(estado)) {
      divergencias = [...divergencias, {
        estado: 'ABERTA', valorDivergente: obs.valor, evidencia: obs.evidencia, abertaEm: obs.observadoEm,
        transicoes: [{ de: null, para: 'ABERTA', em: obs.observadoEm, autor: null, justificativa: null, evidencia: obs.evidencia }],
      }];
      mudancas.push({ tipo: 'DIVERGENCIA_ABERTA', valorDivergente: obs.valor, evidencia: obs.evidencia });
    }
    return {
      estado: { ...estado, evidenciasNaoOficiais: [...estado.evidenciasNaoOficiais, registrada], divergencias },
      material: false,
      mudancas,
    };
  }

  // Observação da fonte de verdade: a fonte respondeu, então está disponível.
  const mudancas: Mudanca<V>[] = [];
  let fonte = estado.fonte;
  if (!fonte.disponivel) {
    fonte = { disponivel: true, desde: obs.observadoEm };
    mudancas.push({ tipo: 'DISPONIBILIDADE_ALTERADA', disponivel: true, desde: obs.observadoEm });
  }
  const atual = estado.oficial;
  const novo: FatoOficial<V> = { valor: obs.valor, vigenteDesde: obs.observadoEm, ultimaConfirmacaoEm: obs.observadoEm, evidencia: obs.evidencia };

  if (!atual) {
    mudancas.push({ tipo: 'FATO_OFICIAL_ESTABELECIDO', valor: obs.valor });
    return { estado: { ...estado, fonte, oficial: novo }, material: true, mudancas };
  }

  if (Object.is(atual.valor, obs.valor)) {
    if (compararInstantes(obs.observadoEm, atual.ultimaConfirmacaoEm) > 0) {
      mudancas.push({ tipo: 'CONFIRMACAO_ATUALIZADA', em: obs.observadoEm });
      return { estado: { ...estado, fonte, oficial: { ...atual, ultimaConfirmacaoEm: obs.observadoEm } }, material: false, mudancas };
    }
    return { estado: { ...estado, fonte }, material: false, mudancas };
  }

  // Valor diferente, mas observação mais antiga que a última confirmação: não volta no tempo.
  if (compararInstantes(obs.observadoEm, atual.ultimaConfirmacaoEm) <= 0) return { estado: { ...estado, fonte }, material: false, mudancas };

  if (opcoes.terminal?.(atual.valor)) {
    mudancas.push({ tipo: 'TERMINAL_PRESERVADO', observado: obs.valor, evidencia: obs.evidencia });
    return { estado: { ...estado, fonte }, material: false, mudancas };
  }

  mudancas.push({ tipo: 'FATO_OFICIAL_ALTERADO', anterior: atual.valor, atual: obs.valor });
  let proximo: EstadoDoFato<V> = { ...estado, fonte, oficial: novo, historico: [...estado.historico, atual] };
  const ativa = divergenciaAtiva(estado);
  if (ativa && Object.is(ativa.valorDivergente, obs.valor)) {
    proximo = transicionar(proximo, ativa, 'RESOLVIDA_PELA_FONTE_DE_VERDADE',
      { em: obs.observadoEm, autor: null, justificativa: null, evidencia: obs.evidencia });
    mudancas.push({ tipo: 'DIVERGENCIA_RESOLVIDA_PELA_FONTE_DE_VERDADE', evidencia: obs.evidencia });
  }
  return { estado: proximo, material: true, mudancas };
}

/* ------------------------- ciclo da divergência (N-14) ------------------------- */

export type ComandoDivergencia =
  | { tipo: 'INICIAR_ANALISE'; autor: string; em: Instante; evidencia: Evidencia }
  /** EM_ANALISE → ABERTA: a análise concluiu que as duas evidências continuam válidas. */
  | { tipo: 'MANTER_ABERTA'; autor: string; em: Instante; justificativa: string; evidencia: Evidencia }
  /** EM_ANALISE → ENCERRADA_POR_EVIDENCIA_INVALIDA: a evidência NÃO oficial divergente foi provada inválida. */
  | {
    tipo: 'ENCERRAR_POR_EVIDENCIA_INVALIDA'; autor: string; em: Instante; justificativa: string;
    evidenciaInvalidada: Evidencia; provaDaInvalidade: Evidencia;
  };

export type ErroTransicaoDivergencia =
  | 'SEM_DIVERGENCIA_ATIVA'
  | 'TRANSICAO_INVALIDA'
  | 'AUTOR_OBRIGATORIO'
  | 'JUSTIFICATIVA_OBRIGATORIA'
  | 'PROVA_DA_INVALIDADE_OBRIGATORIA'
  | 'EVIDENCIA_OFICIAL_NAO_E_INVALIDAVEL'
  | 'EVIDENCIA_NAO_E_A_DIVERGENTE';

export type ResultadoTransicao<V> =
  | { ok: true; estado: EstadoDoFato<V>; mudancas: ReadonlyArray<Mudanca<V>> }
  | { ok: false; erro: ErroTransicaoDivergencia };

const preenchido = (texto: string | null | undefined) => String(texto ?? '').trim() !== '';
const mesmaEvidencia = (a: Evidencia, b: Evidencia) => a.fonte === b.fonte && a.ref === b.ref;
const evidenciaCompleta = (e: Evidencia | null | undefined) => !!e && preenchido(e.fonte) && preenchido(e.ref);

/**
 * Transição humana do N-14 sobre a divergência ativa do fato. Só valida e
 * devolve o novo estado; o fato oficial nunca muda aqui. Nenhum comando fecha
 * um conflito válido: o único fechamento humano exige provar inválida a
 * evidência NÃO oficial; a resolução pela fonte de verdade só vem de
 * `aplicarObservacao`.
 */
export function transicionarDivergencia<V>(estado: EstadoDoFato<V>, comando: ComandoDivergencia): ResultadoTransicao<V> {
  const ativa = divergenciaAtiva(estado);
  if (!ativa) return { ok: false, erro: 'SEM_DIVERGENCIA_ATIVA' };
  if (!preenchido(comando.autor)) return { ok: false, erro: 'AUTOR_OBRIGATORIO' };

  switch (comando.tipo) {
    case 'INICIAR_ANALISE': {
      if (ativa.estado !== 'ABERTA') return { ok: false, erro: 'TRANSICAO_INVALIDA' };
      return {
        ok: true,
        estado: transicionar(estado, ativa, 'EM_ANALISE', { em: comando.em, autor: comando.autor, justificativa: null, evidencia: comando.evidencia }),
        mudancas: [{ tipo: 'DIVERGENCIA_EM_ANALISE', autor: comando.autor }],
      };
    }
    case 'MANTER_ABERTA': {
      if (ativa.estado !== 'EM_ANALISE') return { ok: false, erro: 'TRANSICAO_INVALIDA' };
      if (!preenchido(comando.justificativa)) return { ok: false, erro: 'JUSTIFICATIVA_OBRIGATORIA' };
      return {
        ok: true,
        estado: transicionar(estado, ativa, 'ABERTA',
          { em: comando.em, autor: comando.autor, justificativa: comando.justificativa.trim(), evidencia: comando.evidencia }),
        mudancas: [{ tipo: 'DIVERGENCIA_MANTIDA_ABERTA', autor: comando.autor }],
      };
    }
    case 'ENCERRAR_POR_EVIDENCIA_INVALIDA': {
      if (ativa.estado !== 'EM_ANALISE') return { ok: false, erro: 'TRANSICAO_INVALIDA' };
      if (!preenchido(comando.justificativa)) return { ok: false, erro: 'JUSTIFICATIVA_OBRIGATORIA' };
      if (!evidenciaCompleta(comando.provaDaInvalidade)) return { ok: false, erro: 'PROVA_DA_INVALIDADE_OBRIGATORIA' };
      if (estado.oficial && mesmaEvidencia(comando.evidenciaInvalidada, estado.oficial.evidencia)) {
        return { ok: false, erro: 'EVIDENCIA_OFICIAL_NAO_E_INVALIDAVEL' };
      }
      if (!mesmaEvidencia(comando.evidenciaInvalidada, ativa.evidencia)) return { ok: false, erro: 'EVIDENCIA_NAO_E_A_DIVERGENTE' };
      return {
        ok: true,
        estado: transicionar(estado, ativa, 'ENCERRADA_POR_EVIDENCIA_INVALIDA',
          { em: comando.em, autor: comando.autor, justificativa: comando.justificativa.trim(), evidencia: comando.provaDaInvalidade }),
        mudancas: [{ tipo: 'DIVERGENCIA_ENCERRADA_POR_EVIDENCIA_INVALIDA', autor: comando.autor, prova: comando.provaDaInvalidade }],
      };
    }
  }
}
