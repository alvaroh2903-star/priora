import { Evidencia, Instante, ModalidadeMaster } from '../../dominio';
import { valorEscritoNoLugar, valorNoFormato } from './formatos';
import { CampoVariavel, DefinicaoDoModelo, FonteDeDado, GrupoDeOpcoes, TipoDeConfirmacao, TipoDocumento } from './modelos';

/**
 * Preenchimento de uma versão de modelo (decisões 14.1 e 14.6): só com dados
 * de fontes confiáveis, cada valor com a sua fonte e evidência. Nunca:
 *  - inventar ou completar dado ausente (falta → INCOMPLETO, com o que falta e de onde viria);
 *  - copiar dado do exemplo (a definição não carrega valor nenhum);
 *  - escolher entre valores divergentes (as duas evidências ficam, nada é escolhido);
 *  - deixar valor informado pelo Analista passar por cima de dado confirmado do sistema (DOC-19): igual →
 *    concordante (as duas proveniências ficam); diferente → divergência para resolução;
 *  - usar como dado de quem assina algo que não seja do cadastro do signatário legal definido para o documento
 *    (DOC-23): nunca dado do Analista, da conta Microsoft ou de outro cadastro;
 *  - tocar texto fixo, tabela tarifária ou o lugar da assinatura.
 * Opções de serviço:
 *  - regra explícita + modalidade do Master conhecida e única → a Priora seleciona (origem: a regra e a evidência);
 *  - regras em conflito ou modalidade ambígua → o Analista escolhe;
 *  - sem regra ou sem evidência → nada é selecionado; o Analista escolhe;
 *  - escolha incompatível com a modalidade, com o modelo ou com a regra → recusada.
 */

/** Um dado observado numa fonte confiável, para este Master/processo. */
export interface ValorObservado {
  dado: string;
  valor: string;
  fonte: FonteDeDado;
  evidencia: Evidencia;
  observadoEm: Instante;
  /** De quem é o dado: o Master do documento, um processo vinculado a ele, o próprio ato de geração, ou o signatário legal. */
  escopo: { tipo: 'MASTER'; masterId: string } | { tipo: 'PROCESSO'; processoId: string } | { tipo: 'DOCUMENTO' } | { tipo: 'SIGNATARIO'; signatarioId: string };
  /**
   * 14.20: a confirmação documental que o valor carrega (proveniência dupla). A ORIGEM do valor continua sendo `fonte`
   * e `evidencia` (ex.: o cadastro da organização); aqui ficam só as evidências que confirmaram o seu uso (ex.: as
   * versões do MBL lidas pela Auditoria). Nunca transforma o valor em dado da Auditoria.
   */
  confirmacao?: ConfirmacaoDoValor;
}

export interface ConfirmacaoDoValor {
  tipo: TipoDeConfirmacao;
  evidencias: ReadonlyArray<Evidencia>;
}

/** Escolha explícita do Analista num grupo de opções (nunca default). */
export interface EscolhaDeOpcao {
  grupo: string;
  alternativas: ReadonlyArray<string>;
  por: string;
  em: Instante;
}

/** Modalidade do Master como fato confiável (resolução do Master, cap. 21). */
export type ModalidadeObservada =
  | { tipo: 'UNICA'; modalidade: ModalidadeMaster; evidencia: Evidencia }
  | { tipo: 'AMBIGUA'; modalidades: ReadonlyArray<ModalidadeMaster> }
  | { tipo: 'DESCONHECIDA' };

export interface ContextoDoPreenchimento {
  masterId: string;
  /** Processos vinculados ao Master no momento (S2). */
  processoIds: ReadonlyArray<string>;
  modalidade: ModalidadeObservada;
  /**
   * Cadastro do signatário legal que assina ESTE documento (DOC-23): só os dados dele preenchem campos de escopo
   * SIGNATARIO. null = nenhum signatário definido (os campos ficam faltando).
   */
  signatario: string | null;
}

export type MotivoRecusa =
  | 'DADO_SEM_CAMPO' | 'FONTE_NAO_ACEITA' | 'OUTRO_MASTER' | 'PROCESSO_NAO_VINCULADO' | 'ESCOPO_INCOMPATIVEL' | 'VALOR_VAZIO'
  /** O valor não está no formato que o lugar do campo exige (data, hora, CPF/CNPJ com dígitos verificadores, texto sem controle). */
  | 'FORA_DO_FORMATO'
  /** Dado de um cadastro que não é o do signatário legal definido para este documento (DOC-23). */
  | 'OUTRO_SIGNATARIO'
  /** 14.20: o campo exige confirmação documental (ex.: identidade do consignatário no MBL) e o valor não a traz. */
  | 'SEM_CONFIRMACAO_DOCUMENTAL';

/** Valor que só o Analista conhece, informado para ESTE documento (vale só onde a definição aceita a fonte ANALISTA). */
export interface ValorInformado {
  dado: string;
  valor: string;
  por: string;
  em: Instante;
  /** Proveniência declarada pelo Analista (ex.: "agendado por telefone com a agência"), quando informada. */
  referencia?: string;
}

/** O valor informado vira observação da fonte ANALISTA, com autor e instante como evidência. */
export function observacaoDoValorInformado(v: ValorInformado): ValorObservado {
  return {
    dado: v.dado, valor: v.valor, fonte: 'ANALISTA', escopo: { tipo: 'DOCUMENTO' }, observadoEm: v.em,
    // A proveniência declarada (`referencia`) fica no próprio valor informado, guardado com o documento.
    evidencia: { fonte: 'liberacao.documentos', ref: `informado:${v.por}@${v.em}` },
  };
}

export interface Recusado { valor: ValorObservado; motivo: MotivoRecusa }

/**
 * Por que uma fonte que tem o dado extraído não o publicou como confiável (ex.: contêiner fora do padrão ISO 6346,
 * consignatário sem critério aprovado). Só informa: nunca preenche nem escolhe nada.
 */
export interface DadoNaoPublicado {
  dado: string;
  fonte: FonteDeDado;
  motivo: string;
  evidencia: Evidencia;
  observadoEm: Instante;
  /** 14.20: a causa precisa (ex.: o motivo da exceção na identidade do consignatário) e todas as evidências dela. */
  causa?: string;
  evidencias?: ReadonlyArray<Evidencia>;
}

export interface Faltante {
  campo: string; rotulo: string; dado: string; fontesAceitas: ReadonlyArray<FonteDeDado>;
  /** O que as fontes aceitas têm do dado sem confiabilidade suficiente (o campo continua faltando). */
  naoPublicados?: ReadonlyArray<DadoNaoPublicado>;
}
/**
 * Valores aceitos e diferentes para o mesmo campo: nada é escolhido; resolve-se na fonte ou retirando o informado.
 *  - ENTRE_FONTES_DO_SISTEMA: duas fontes confiáveis discordam;
 *  - INFORMADO_DIVERGE_DO_SISTEMA: o Analista informou valor diferente do dado confirmado do sistema (DOC-19).
 */
export interface Divergente {
  campo: string; dado: string; valores: ReadonlyArray<ValorObservado>;
  natureza: 'ENTRE_FONTES_DO_SISTEMA' | 'INFORMADO_DIVERGE_DO_SISTEMA' | 'ENTRE_INFORMADOS';
}

export type ProblemaDeOpcao =
  | { tipo: 'ESCOLHA_PENDENTE'; grupo: string; motivo: 'SEM_REGRA_OU_EVIDENCIA' | 'REGRAS_AMBIGUAS' | 'MODALIDADE_AMBIGUA' }
  | { tipo: 'GRUPO_INEXISTENTE'; grupo: string }
  | { tipo: 'ALTERNATIVA_INEXISTENTE'; grupo: string; alternativa: string }
  | { tipo: 'QUANTIDADE_INVALIDA'; grupo: string; escolhidas: number }
  | { tipo: 'ALTERNATIVAS_INCOMPATIVEIS'; grupo: string; par: readonly [string, string] }
  | { tipo: 'INCOMPATIVEL_COM_A_MODALIDADE'; grupo: string; alternativa: string; modalidade: ModalidadeMaster }
  | { tipo: 'MODALIDADE_NECESSARIA_PARA_A_ALTERNATIVA'; grupo: string; alternativa: string }
  | { tipo: 'ESCOLHA_DIVERGE_DA_REGRA'; grupo: string; determinada: ReadonlyArray<string>; escolhida: ReadonlyArray<string> }
  | { tipo: 'ESCOLHA_SEM_AUTOR'; grupo: string }
  | { tipo: 'ESCOLHAS_CONFLITANTES'; grupo: string };

export type AtencaoDocumental = { tipo: 'VERSAO_DO_MODELO_A_CONFERIR'; mensagem: string };

/** Origem de cada seleção de opção (registrada no documento). */
export type OrigemDaSelecao =
  | { tipo: 'REGRA'; regras: ReadonlyArray<{ id: string; fundamento: string }>; evidencia: Evidencia }
  | { tipo: 'ANALISTA'; por: string; em: Instante };

export interface SelecaoDeOpcao {
  grupo: string;
  alternativas: ReadonlyArray<string>;
  origem: OrigemDaSelecao;
}

/** Conteúdo MATERIAL do documento: o que o PDF mostra. Proveniência e horários de observação ficam fora (N-16). */
export interface ConteudoDoDocumento {
  tipo: TipoDocumento;
  /** Versão de modelo usada (cadastrada e validada). */
  modelo: { modeloId: string; versao: string; arquivoSha256: string };
  masterId: string;
  campos: ReadonlyArray<{ campo: string; valor: string }>;
  opcoes: ReadonlyArray<{ grupo: string; alternativas: ReadonlyArray<string> }>;
  blocosFixos: ReadonlyArray<string>;
  /** Lugar da assinatura, reservado à pessoa. */
  assinaturaReservada: string | null;
}

export interface PlanoDePreenchimento {
  conteudo: ConteudoDoDocumento;
  /** De onde veio cada valor (todas as fontes concordantes ficam registradas). */
  proveniencia: ReadonlyArray<{
    campo: string;
    /** A origem de cada valor concordante; `confirmacao` (14.20) só com as evidências que confirmaram o uso dele. */
    fontes: ReadonlyArray<{ fonte: FonteDeDado; evidencia: Evidencia; observadoEm: Instante; confirmacao?: ConfirmacaoDoValor }>;
  }>;
  selecoes: ReadonlyArray<SelecaoDeOpcao>;
  /** Só as escolhas humanas usadas (continuam valendo até nova decisão). */
  escolhas: ReadonlyArray<EscolhaDeOpcao>;
  /** Só os valores informados pelo Analista que preencheram algum campo. */
  informados: ReadonlyArray<ValorInformado>;
  processoIds: ReadonlyArray<string>;
}

export type ResultadoDoPreenchimento =
  | { tipo: 'PRONTO'; plano: PlanoDePreenchimento; recusados: Recusado[]; atencoes: AtencaoDocumental[] }
  | {
    tipo: 'INCOMPLETO'; faltantes: Faltante[]; divergentes: Divergente[]; problemasDeOpcao: ProblemaDeOpcao[]; recusados: Recusado[];
    atencoes: AtencaoDocumental[];
    /** DOC-31.B: o que JÁ se resolve com os dados de agora (para comparar com o PDF disponibilizado campo a campo). */
    resolvidos: Pick<ConteudoDoDocumento, 'campos' | 'opcoes'>;
  };

/** Versão de modelo que o preenchimento usa (só uma versão VALIDADA chega aqui). */
export interface ModeloEmUso {
  modeloId: string;
  versao: string;
  arquivoSha256: string;
  definicao: DefinicaoDoModelo;
}

const vazio = (t: string | null | undefined) => String(t ?? '').trim() === '';

/** 14.20: a confirmação exigida pelo campo, com ao menos uma evidência documental da Auditoria. */
const confirmado = (v: ValorObservado, c: CampoVariavel) =>
  !c.confirmacao || (v.confirmacao?.tipo === c.confirmacao.tipo && v.confirmacao.evidencias.some((e) => e.fonte === 'auditoria'));

function motivoDeRecusa(v: ValorObservado, c: CampoVariavel, ctx: ContextoDoPreenchimento, formato: Parameters<typeof valorNoFormato>[0] | null): MotivoRecusa | null {
  if (vazio(v.valor)) return 'VALOR_VAZIO';
  if (formato && !valorNoFormato(formato, v.valor)) return 'FORA_DO_FORMATO';
  if (!c.fontesAceitas.includes(v.fonte)) return 'FONTE_NAO_ACEITA';
  if (v.escopo.tipo !== c.escopo) return 'ESCOPO_INCOMPATIVEL';
  if (v.escopo.tipo === 'MASTER' && v.escopo.masterId !== ctx.masterId) return 'OUTRO_MASTER';
  if (v.escopo.tipo === 'PROCESSO' && !ctx.processoIds.includes(v.escopo.processoId)) return 'PROCESSO_NAO_VINCULADO';
  if (v.escopo.tipo === 'SIGNATARIO' && (ctx.signatario === null || v.escopo.signatarioId !== ctx.signatario)) return 'OUTRO_SIGNATARIO';
  if (!confirmado(v, c)) return 'SEM_CONFIRMACAO_DOCUMENTAL';
  return null;
}

/** Problemas de um conjunto de alternativas dentro do grupo (existência, quantidade, pares, modalidade). */
function problemasDoConjunto(g: GrupoDeOpcoes, alternativas: ReadonlyArray<string>, modalidade: ModalidadeObservada): ProblemaDeOpcao[] {
  const p: ProblemaDeOpcao[] = [];
  for (const a of alternativas) if (!g.alternativas.some((x) => x.id === a)) p.push({ tipo: 'ALTERNATIVA_INEXISTENTE', grupo: g.id, alternativa: a });
  if (!alternativas.length || (g.selecao === 'EXATAMENTE_UMA' && alternativas.length !== 1)) p.push({ tipo: 'QUANTIDADE_INVALIDA', grupo: g.id, escolhidas: alternativas.length });
  for (const par of g.incompativeis) if (alternativas.includes(par[0]) && alternativas.includes(par[1])) p.push({ tipo: 'ALTERNATIVAS_INCOMPATIVEIS', grupo: g.id, par });
  for (const a of alternativas) {
    const restricao = g.alternativas.find((x) => x.id === a)?.modalidadesCompativeis;
    if (!restricao) continue;
    // Restrição declarada: só se aceita com a modalidade provada e compatível.
    if (modalidade.tipo !== 'UNICA') p.push({ tipo: 'MODALIDADE_NECESSARIA_PARA_A_ALTERNATIVA', grupo: g.id, alternativa: a });
    else if (!restricao.includes(modalidade.modalidade)) p.push({ tipo: 'INCOMPATIVEL_COM_A_MODALIDADE', grupo: g.id, alternativa: a, modalidade: modalidade.modalidade });
  }
  return p;
}

const naOrdem = (g: GrupoDeOpcoes, ids: Iterable<string>) => {
  const s = new Set(ids);
  return g.alternativas.map((x) => x.id).filter((id) => s.has(id));
};

function resolverOpcoes(d: DefinicaoDoModelo, escolhas: ReadonlyArray<EscolhaDeOpcao>, ctx: ContextoDoPreenchimento):
  { problemas: ProblemaDeOpcao[]; selecoes: SelecaoDeOpcao[]; escolhasUsadas: EscolhaDeOpcao[] } {
  const problemas: ProblemaDeOpcao[] = [];
  const selecoes: SelecaoDeOpcao[] = [];
  const escolhasUsadas: EscolhaDeOpcao[] = [];
  for (const e of escolhas) if (!d.opcoes.some((g) => g.id === e.grupo)) problemas.push({ tipo: 'GRUPO_INEXISTENTE', grupo: e.grupo });
  for (const g of d.opcoes) {
    // 1) Regras explícitas do grupo, só com a modalidade provada e única.
    const regras = d.regras.filter((r) => r.grupo === g.id);
    const disparadas = ctx.modalidade.tipo === 'UNICA' ? regras.filter((r) => r.quandoModalidade === (ctx.modalidade as { modalidade: ModalidadeMaster }).modalidade) : [];
    const determinada = naOrdem(g, disparadas.map((r) => r.alternativa));
    const regraValida = determinada.length > 0 && problemasDoConjunto(g, determinada, ctx.modalidade).length === 0;
    // 2) Escolha humana (uma forma só por grupo).
    const doGrupo = escolhas.filter((e) => e.grupo === g.id);
    const formas = new Set(doGrupo.map((e) => [...new Set(e.alternativas)].sort().join('|')));
    if (formas.size > 1) {
      problemas.push({ tipo: 'ESCOLHAS_CONFLITANTES', grupo: g.id });
      continue;
    }
    const escolha = doGrupo[0] ?? null;
    if (escolha) {
      const antes = problemas.length;
      if (vazio(escolha.por)) problemas.push({ tipo: 'ESCOLHA_SEM_AUTOR', grupo: g.id });
      const alternativas = [...new Set(escolha.alternativas)];
      problemas.push(...problemasDoConjunto(g, alternativas, ctx.modalidade));
      if (regraValida && [...alternativas].sort().join('|') !== [...determinada].sort().join('|')) {
        problemas.push({ tipo: 'ESCOLHA_DIVERGE_DA_REGRA', grupo: g.id, determinada, escolhida: naOrdem(g, alternativas) });
      }
      if (problemas.length === antes) {
        selecoes.push({ grupo: g.id, alternativas: naOrdem(g, alternativas), origem: { tipo: 'ANALISTA', por: escolha.por, em: escolha.em } });
        escolhasUsadas.push(escolha);
      }
      continue;
    }
    if (regraValida) {
      const evidencia = (ctx.modalidade as { evidencia: Evidencia }).evidencia;
      selecoes.push({
        grupo: g.id, alternativas: determinada,
        origem: { tipo: 'REGRA', regras: disparadas.map((r) => ({ id: r.id, fundamento: r.fundamento })), evidencia },
      });
      continue;
    }
    if (!g.obrigatorio) continue;
    const motivo = determinada.length ? 'REGRAS_AMBIGUAS' : ctx.modalidade.tipo === 'AMBIGUA' && regras.length ? 'MODALIDADE_AMBIGUA' : 'SEM_REGRA_OU_EVIDENCIA';
    problemas.push({ tipo: 'ESCOLHA_PENDENTE', grupo: g.id, motivo });
  }
  return { problemas, selecoes, escolhasUsadas };
}

export function planejarPreenchimento(
  modelo: ModeloEmUso, observados: ReadonlyArray<ValorObservado>, escolhas: ReadonlyArray<EscolhaDeOpcao>, ctx: ContextoDoPreenchimento,
  atencoes: ReadonlyArray<AtencaoDocumental> = [], informados: ReadonlyArray<ValorInformado> = [],
): ResultadoDoPreenchimento {
  const d = modelo.definicao;
  const deInformado = new Map<ValorObservado, ValorInformado>(informados.map((i) => [observacaoDoValorInformado(i), i]));
  const valores: ValorObservado[] = [...observados, ...deInformado.keys()];
  const informadosUsados = new Set<ValorInformado>();
  const recusados: Recusado[] = [];
  const faltantes: Faltante[] = [];
  const divergentes: Divergente[] = [];
  const dadosDoModelo = new Set(d.campos.map((c) => c.dado));
  for (const v of valores) if (!dadosDoModelo.has(v.dado)) recusados.push({ valor: v, motivo: 'DADO_SEM_CAMPO' });

  const campos: Array<{ campo: string; valor: string }> = [];
  const proveniencia: PlanoDePreenchimento['proveniencia'][number][] = [];
  for (const c of d.campos) {
    const aceitos: ValorObservado[] = [];
    for (const v of valores.filter((x) => x.dado === c.dado)) {
      const motivo = motivoDeRecusa(v, c, ctx, d.layout?.campos[c.id]?.formato ?? null);
      if (motivo) recusados.push({ valor: v, motivo });
      else aceitos.push(v);
    }
    // Iguais = o PDF escreveria o mesmo texto naquele lugar (a mesma comparação da DOC-31.B): leituras que só
    // diferem em espaços ou na forma do formato concordam; valores realmente diferentes divergem e nada é escolhido.
    const escrita = (v: ValorObservado) => valorEscritoNoLugar(d, c.id, v.valor);
    const porEscrita = new Map<string, string>();
    for (const v of aceitos) if (!porEscrita.has(escrita(v))) porEscrita.set(escrita(v), v.valor.trim());
    const distintos = [...porEscrita.values()];
    if (distintos.length > 1) {
      // DOC-19: o informado nunca vence o dado confirmado do sistema; a divergência fica para resolução.
      const doSistema = new Set(aceitos.filter((v) => v.fonte !== 'ANALISTA').map(escrita));
      const natureza = doSistema.size > 1 ? 'ENTRE_FONTES_DO_SISTEMA' : doSistema.size === 1 ? 'INFORMADO_DIVERGE_DO_SISTEMA' : 'ENTRE_INFORMADOS';
      divergentes.push({ campo: c.id, dado: c.dado, valores: aceitos, natureza });
    } else if (distintos.length === 1) {
      for (const v of aceitos) if (deInformado.has(v)) informadosUsados.add(deInformado.get(v)!);
      campos.push({ campo: c.id, valor: distintos[0] });
      proveniencia.push({
        campo: c.id,
        fontes: aceitos.map((v) => ({ fonte: v.fonte, evidencia: v.evidencia, observadoEm: v.observadoEm, ...(v.confirmacao ? { confirmacao: v.confirmacao } : {}) })),
      });
    } else if (c.obrigatorio) faltantes.push({ campo: c.id, rotulo: c.rotulo, dado: c.dado, fontesAceitas: c.fontesAceitas });
  }
  const { problemas, selecoes, escolhasUsadas } = resolverOpcoes(d, escolhas, ctx);
  if (faltantes.length || divergentes.length || problemas.length) {
    return {
      tipo: 'INCOMPLETO', faltantes, divergentes, problemasDeOpcao: problemas, recusados, atencoes: [...atencoes],
      resolvidos: { campos, opcoes: selecoes.map((s) => ({ grupo: s.grupo, alternativas: s.alternativas })) },
    };
  }
  return {
    tipo: 'PRONTO',
    plano: {
      conteudo: {
        tipo: d.tipo,
        modelo: { modeloId: modelo.modeloId, versao: modelo.versao, arquivoSha256: modelo.arquivoSha256 },
        masterId: ctx.masterId,
        campos,
        opcoes: selecoes.map((s) => ({ grupo: s.grupo, alternativas: s.alternativas })),
        blocosFixos: d.blocosFixos.map((b) => b.id),
        assinaturaReservada: d.assinatura?.id ?? null,
      },
      proveniencia,
      selecoes,
      escolhas: escolhasUsadas,
      informados: informados.filter((i) => informadosUsados.has(i)),
      processoIds: [...new Set(ctx.processoIds)].sort(),
    },
    recusados,
    atencoes: [...atencoes],
  };
}

/**
 * Serialização canônica (chaves ordenadas, sem espaços): a mesma entrada dá
 * sempre o mesmo texto, que a aplicação usa para o hash do conteúdo e para a
 * idempotência (N-16).
 */
export function canonico(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(',')}}`;
}
