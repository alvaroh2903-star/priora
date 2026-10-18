import { Agencia, ArmadorDoMaster, Evidencia, Instante, ModalidadeMaster, agenciaDoArmador, codigoCanonicoDoArmador } from '../../dominio';

/**
 * Documentos de apresentação — catálogo de modelos por armador/agência e
 * contrato da DEFINIÇÃO de cada versão de modelo (cap. 28–30; decisões 14.1–14.9).
 *
 * Domínio puro: nenhum I/O, relógio, acaso ou ambiente.
 *
 *  - O CATÁLOGO (identidade de cada tipo de documento e a escolha pelo
 *    armador) sai da matriz congelada do cap. 26 e da decisão de produto que
 *    trouxe os quatro modelos. A escolha é pelo ARMADOR, nunca só pela
 *    agência: Hapag-Lloyd e ZIM são da Rochamar e têm memorandos diferentes.
 *  - A DEFINIÇÃO (campos variáveis, texto fixo, opções, regras de seleção,
 *    lugar da assinatura) pertence a uma VERSÃO de modelo cadastrada a partir
 *    do arquivo oficial e validada por uma pessoa (ver `versoes.ts`). Os
 *    arquivos recebidos do produto são EXEMPLOS PREENCHIDOS: identificam a
 *    estrutura, nunca são fonte de dados.
 *  - O que a Priora faz depois de gerar depende do PROCEDIMENTO de cada modelo (DOC-31), nunca de uma regra
 *    global de assinatura: MSC, Hapag-Lloyd e ZIM terminam no PDF gerado e disponível (o Analista assina e
 *    encaminha fora da Priora); só o termo Evergreen (Grieg) segue o ciclo completo — PDF assinado devolvido,
 *    conferido, guardado e encaminhado com o MBL (DOC-23, DOC-24). Preparado nunca é assinado.
 */

export type TipoDocumento = 'TERMO_EVERGREEN' | 'MEMORANDO_MSC' | 'MEMORANDO_HAPAG_ROCHAMAR' | 'MEMORANDO_ZIM_ROCHAMAR';

export const TIPOS_DE_DOCUMENTO: ReadonlyArray<TipoDocumento> = [
  'TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR',
];

/**
 * DOC-31 — procedimento documental aprovado de cada modelo (o que a Priora faz com o documento):
 *  - GERAR_E_DISPONIBILIZAR (MSC, Hapag-Lloyd, ZIM): a Priora preenche com os dados confiáveis, gera o PDF e o
 *    deixa para visualizar e baixar — e para aí. O Analista assina (Adobe) e encaminha FORA da Priora: a Priora não
 *    recebe, não confere e não guarda o arquivo assinado, não prepara rascunho e não envia. PDF gerado e disponível
 *    encerra a responsabilidade documental da Priora; não é encaminhamento, apresentação do Master nem Liberação concluída.
 *  - CICLO_COMPLETO (Evergreen/Grieg): além disso, recebe o PDF assinado, exige a conferência humana do arquivo final,
 *    guarda o arquivo e as evidências e prepara a solicitação de agendamento (termo + MBL) no Outlook do Analista.
 */
export type ProcedimentoDocumental = 'GERAR_E_DISPONIBILIZAR' | 'CICLO_COMPLETO';

export interface EntradaDoCatalogo {
  tipo: TipoDocumento;
  /** Código canônico do armador na matriz (`codigoCanonicoDoArmador`). */
  armador: string;
  agencia: Agencia;
  /** Exemplo PREENCHIDO recebido do produto. Identifica o modelo; nunca é fonte de dados nem modelo vazio. */
  exemploDeReferencia: string;
  /** DOC-31: o que a Priora faz com o documento deste modelo. */
  procedimento: ProcedimentoDocumental;
}

const CATALOGO: Readonly<Record<TipoDocumento, EntradaDoCatalogo>> = {
  TERMO_EVERGREEN: {
    tipo: 'TERMO_EVERGREEN', armador: 'EVERGREEN', agencia: 'GRIEG', exemploDeReferencia: 'EVERGREEN TERMO EGLV102600060211.pdf', procedimento: 'CICLO_COMPLETO',
  },
  MEMORANDO_MSC: {
    tipo: 'MEMORANDO_MSC', armador: 'MSC', agencia: 'MSC', exemploDeReferencia: 'Memorando - MSC LIBERAÃ_Ã_O 1 - Copia.pdf', procedimento: 'GERAR_E_DISPONIBILIZAR',
  },
  MEMORANDO_HAPAG_ROCHAMAR: {
    tipo: 'MEMORANDO_HAPAG_ROCHAMAR', armador: 'HAPAG_LLOYD', agencia: 'ROCHAMAR', exemploDeReferencia: 'MEMORANDO HAPAG - IM1879att.pdf',
    procedimento: 'GERAR_E_DISPONIBILIZAR',
  },
  MEMORANDO_ZIM_ROCHAMAR: {
    tipo: 'MEMORANDO_ZIM_ROCHAMAR', armador: 'ZIM', agencia: 'ROCHAMAR', exemploDeReferencia: 'MEMO PADRAO ZIM-ROCHAMAR ZIMUXIA8574637 .pdf',
    procedimento: 'GERAR_E_DISPONIBILIZAR',
  },
};

export const entradaDoCatalogo = (tipo: TipoDocumento): EntradaDoCatalogo => CATALOGO[tipo];

/** DOC-31: o procedimento vem do modelo (catálogo), nunca de quem chama. */
export const procedimentoDoModelo = (tipo: TipoDocumento): ProcedimentoDocumental => CATALOGO[tipo].procedimento;

/** Modelo por armador canônico. Só estes quatro existem; nada se aproxima. */
const MODELO_DO_ARMADOR: Readonly<Record<string, TipoDocumento>> = {
  EVERGREEN: 'TERMO_EVERGREEN',
  MSC: 'MEMORANDO_MSC',
  HAPAG_LLOYD: 'MEMORANDO_HAPAG_ROCHAMAR',
  ZIM: 'MEMORANDO_ZIM_ROCHAMAR',
};

export type SelecaoDeModelo =
  | { tipo: 'SELECIONADO'; entrada: EntradaDoCatalogo; codigoInformado: string }
  /** Armador na matriz, mas nenhum modelo foi fornecido para ele (ex.: Unimar, Maersk). Nada se gera nem se improvisa. */
  | { tipo: 'SEM_MODELO_CONFIGURADO'; armador: string; agencia: Agencia }
  /** H-12 / P11: armador conhecido fora da matriz. Nunca se infere agência nem modelo. */
  | { tipo: 'PROCEDIMENTO_NAO_MAPEADO'; armador: string }
  /** P12: sem fato confiável de armador para ESTE Master. Nada se infere de prefixo, padrão ou semelhança. */
  | { tipo: 'ARMADOR_NAO_IDENTIFICADO' };

/** Escolhe o tipo de documento pelo fato CONFIÁVEL de armador do Master (o mesmo contrato da L1b). */
export function selecionarModelo(masterId: string, armador: ArmadorDoMaster | null): SelecaoDeModelo {
  if (!armador || armador.masterId !== masterId || String(armador.codigo ?? '').trim() === '') return { tipo: 'ARMADOR_NAO_IDENTIFICADO' };
  const canonico = codigoCanonicoDoArmador(armador.codigo);
  const agencia = agenciaDoArmador(armador.codigo);
  if (!agencia) return { tipo: 'PROCEDIMENTO_NAO_MAPEADO', armador: canonico };
  const tipo = Object.prototype.hasOwnProperty.call(MODELO_DO_ARMADOR, canonico) ? MODELO_DO_ARMADOR[canonico] : null;
  if (!tipo) return { tipo: 'SEM_MODELO_CONFIGURADO', armador: canonico, agencia };
  return { tipo: 'SELECIONADO', entrada: CATALOGO[tipo], codigoInformado: armador.codigo };
}

/* -------------------------------------- definição -------------------------------------- */

/**
 * Donos dos dados que podem preencher um campo. Cada valor chega com a sua
 * fonte e evidência; um campo só aceita as fontes que a definição declara.
 *  - S6_PROCESSO / S6_MASTER: identidade central (código do processo; referência documental do MBL);
 *  - S2_AUDITORIA: fato documental extraído pela Auditoria;
 *  - S3_VIAGEM: VesselCall/tracking compartilhado;
 *  - S4_PESSOA: identidade da pessoa autenticada;
 *  - HEADCARGO: fonte financeira/comercial;
 *  - GERACAO: o próprio ato de geração (ex.: data do documento);
 *  - CADASTRO_DA_ORGANIZACAO: dados da própria organização validados por pessoa;
 *  - CADASTRO_DO_SIGNATARIO_LEGAL: dados do signatário legal da organização (nome civil, CPF), do cadastro
 *    confiável e validado dele — nunca da conta Microsoft nem do cadastro do Analista que opera o leitor de PDF (DOC-23);
 *  - ANALISTA: valor informado pelo Analista para o documento, com autor, instante e proveniência — só onde a
 *    definição o aceita e nunca por cima de um dado confirmado do sistema (DOC-19).
 * Opções de serviço não são dados: vêm de regra explícita ou de escolha do Analista.
 */
export type FonteDeDado =
  | 'S6_PROCESSO' | 'S6_MASTER' | 'S2_AUDITORIA' | 'S3_VIAGEM' | 'S4_PESSOA' | 'HEADCARGO' | 'GERACAO'
  /** Cadastro da própria organização (razão social, CNPJ, representante, contatos), validado por pessoa. */
  | 'CADASTRO_DA_ORGANIZACAO'
  /** Dados do signatário legal da organização (nome civil, CPF), do cadastro confiável e validado (DOC-23). Só em campos de escopo SIGNATARIO. */
  | 'CADASTRO_DO_SIGNATARIO_LEGAL'
  /** Valor informado pelo Analista para ESTE documento (com autor e instante), só onde a definição validada o aceita. */
  | 'ANALISTA';

export const FONTES_DE_DADO: ReadonlyArray<FonteDeDado> = [
  'S6_PROCESSO', 'S6_MASTER', 'S2_AUDITORIA', 'S3_VIAGEM', 'S4_PESSOA', 'HEADCARGO', 'GERACAO', 'CADASTRO_DA_ORGANIZACAO', 'CADASTRO_DO_SIGNATARIO_LEGAL', 'ANALISTA',
];

export interface CampoVariavel {
  id: string;
  rotulo: string;
  /** O dado operacional que o preenche (ex.: MBL). Vários campos podem mostrar o mesmo dado. */
  dado: string;
  obrigatorio: boolean;
  fontesAceitas: ReadonlyArray<FonteDeDado>;
  /**
   * MASTER: valor do próprio Master; PROCESSO: de um processo vinculado; DOCUMENTO: do ato de geração;
   * SIGNATARIO: do signatário legal que assina este documento (só dele — DOC-23).
   */
  escopo: 'MASTER' | 'PROCESSO' | 'DOCUMENTO' | 'SIGNATARIO';
  /** Regra ESPECÍFICA deste modelo que liga o rótulo ao dado (ex.: DOC-17). Não vale para outros modelos. */
  fundamento?: string;
}

/** Texto jurídico, tabela tarifária ou estrutura do modelo oficial: reproduzido como está, nunca alterado automaticamente. */
export interface BlocoFixo {
  id: string;
  natureza: 'TEXTO_JURIDICO' | 'TABELA_TARIFARIA' | 'ESTRUTURA';
  texto: string;
}

export interface AlternativaDeOpcao {
  id: string;
  rotulo: string;
  /**
   * Modalidades do Master com que a alternativa é compatível, quando o modelo oficial as restringe.
   * Ausente = sem restrição declarada.
   */
  modalidadesCompativeis?: ReadonlyArray<ModalidadeMaster>;
}

/** Alternativas que dependem da operação (ex.: serviços do memorando). Cada modelo tem as suas; nada é equivalente por nome. */
export interface GrupoDeOpcoes {
  id: string;
  rotulo: string;
  alternativas: ReadonlyArray<AlternativaDeOpcao>;
  selecao: 'EXATAMENTE_UMA' | 'UMA_OU_MAIS';
  obrigatorio: boolean;
  /** Pares de alternativas que não podem ser escolhidas juntas (do modelo oficial). */
  incompativeis: ReadonlyArray<readonly [string, string]>;
}

/**
 * Regra explícita de seleção automática (decisão 14.6): quando a modalidade
 * do Master é a indicada, a alternativa é determinada. Só entra com
 * fundamento escrito (capítulo do Blueprint ou decisão aprovada) — nenhuma
 * matriz de serviços é inventada aqui.
 */
export interface RegraDeSelecao {
  id: string;
  grupo: string;
  alternativa: string;
  quandoModalidade: ModalidadeMaster;
  fundamento: string;
}

/* ------------------------- layout: onde e como preencher o arquivo oficial ------------------------- */

/** Retângulo no espaço da página do PDF (pontos; origem no canto inferior esquerdo). */
export interface Retangulo { x: number; y: number; largura: number; altura: number }

/** Fontes padrão do PDF usadas no preenchimento (as do modelo vêm embutidas só com os glifos do exemplo). */
export type FonteDoDesenho = 'HELVETICA' | 'HELVETICA_NEGRITO' | 'TIMES' | 'TIMES_NEGRITO';
export const FONTES_DO_DESENHO: ReadonlyArray<FonteDoDesenho> = ['HELVETICA', 'HELVETICA_NEGRITO', 'TIMES', 'TIMES_NEGRITO'];

/** Como o valor do dado é escrito no documento (o valor guardado é sempre o canônico). */
/** LISTA: um item por linha, sem item vazio nem repetido (ex.: contêineres do Master — DOC-27). */
export type FormatoDoValor = 'TEXTO' | 'DATA_POR_EXTENSO' | 'DATA_DD_MM_AAAA' | 'HORA_HH_MM' | 'CPF' | 'CNPJ' | 'LISTA';
export const FORMATOS_DO_VALOR: ReadonlyArray<FormatoDoValor> = ['TEXTO', 'DATA_POR_EXTENSO', 'DATA_DD_MM_AAAA', 'HORA_HH_MM', 'CPF', 'CNPJ', 'LISTA'];

export interface LugarDoCampo {
  /** Página do arquivo oficial (a partir de 1). */
  pagina: number;
  /** Linha de base do primeiro caractere. */
  x: number;
  y: number;
  fonte: FonteDoDesenho;
  tamanho: number;
  /** Corpo mínimo quando o valor não cabe (igual a `tamanho`: não reduz). Não cabendo nem assim, nada é gerado. */
  tamanhoMinimo: number;
  larguraMaxima: number;
  linhasMaximas: number;
  entrelinha: number;
  formato: FormatoDoValor;
  /** Texto FIXO do modelo que estava no mesmo trecho do exemplo e é redesenhado junto com o valor (ex.: "Itajaí, "). */
  prefixo: string;
  sufixo: string;
}

/**
 * Marca de uma alternativa de opção:
 *  - LETRA_X: a caixa é desenho do próprio modelo; a Priora só escreve o "X" na escolhida;
 *  - CAIXA: a caixa era um glifo ☐/☒ do exemplo; a Priora desenha a caixa de todas e o X na escolhida.
 */
export type MarcaDaAlternativa =
  | { tipo: 'LETRA_X'; pagina: number; x: number; y: number; fonte: FonteDoDesenho; tamanho: number }
  | { tipo: 'CAIXA'; pagina: number; caixa: Retangulo };

/**
 * DOC-27 — relação anexa de um campo LISTA que pode não caber no lugar do modelo oficial (ex.: contêineres do termo
 * Evergreen). Até `maximoNoLugar` itens, a lista vai no próprio lugar, como sempre. Acima disso, o lugar recebe só a
 * remissão (total e páginas) e TODOS os itens, na ordem do conteúdo, numerados, vão em páginas adicionais ao FINAL do
 * mesmo PDF — sem truncar, repetir nem perder item; as páginas oficiais (texto jurídico, cláusulas, tarifas) não mudam.
 * Cada página da relação identifica o documento (título, BL do Master, data) e a paginação.
 * É uma extensão PROPOSTA pela Priora: enquanto a agência não a aceitar (com evidência), fica PENDENTE_DE_ACEITE_DA_AGENCIA.
 */
export interface RelacaoAnexa {
  /** Campo de formato LISTA que a relação continua. */
  campo: string;
  maximoNoLugar: number;
  itensPorPagina: number;
  titulo: string;
  /** Texto que liga a relação ao documento (ex.: "Anexo ao Termo de Responsabilidade ... — Evergreen"). */
  vinculo: string;
  /** Campos que identificam o documento em cada página da relação (ex.: BL e data), com o rótulo. */
  identificacao: ReadonlyArray<{ campo: string; rotulo: string }>;
  /** Nome do item no singular (cabeçalho da relação) e no plural (remissão) — ex.: "CONTÊINER" / "CONTÊINERES". */
  item: string;
  itens: string;
  aceiteDaAgencia: { estado: 'PENDENTE_DE_ACEITE_DA_AGENCIA' } | { estado: 'ACEITO_PELA_AGENCIA'; evidencia: Evidencia; registradoPor: string; em: Instante };
}

export interface LayoutDoModelo {
  /** Páginas do arquivo oficial (largura × altura): conferidas antes de gerar. */
  paginas: ReadonlyArray<{ largura: number; altura: number }>;
  /**
   * Onde o EXEMPLO tem dados: todo texto que começa e toda imagem desenhada dentro destas áreas sai do modelo
   * antes do preenchimento (sem deslocar o texto fixo). Anotações e formulários do exemplo nunca passam.
   */
  limpeza: ReadonlyArray<{
    pagina: number; area: Retangulo; motivo: string;
    /** Também os traços desenhados INTEIRAMENTE dentro da área (ex.: sublinhado de link do exemplo). Nunca recorte. */
    removerTracos?: boolean;
  }>;
  /** Por id de campo. */
  campos: Readonly<Record<string, LugarDoCampo>>;
  /** Por grupo → alternativa. */
  opcoes: Readonly<Record<string, Readonly<Record<string, MarcaDaAlternativa>>>>;
  /** Lugar da assinatura humana: nada é desenhado nele. */
  assinatura: { pagina: number; area: Retangulo };
  /** DOC-27: continuação de um campo LISTA em páginas adicionais. */
  relacaoAnexa?: RelacaoAnexa | null;
}

export interface DefinicaoDoModelo {
  tipo: TipoDocumento;
  campos: ReadonlyArray<CampoVariavel>;
  blocosFixos: ReadonlyArray<BlocoFixo>;
  opcoes: ReadonlyArray<GrupoDeOpcoes>;
  regras: ReadonlyArray<RegraDeSelecao>;
  /** Lugar da assinatura humana. Nunca é um campo: a Priora não o preenche (nem simula, nem reaproveita). */
  assinatura: { id: string; rotulo: string } | null;
  /**
   * Dados específicos do EXEMPLO (BL, contêiner, navio, data, responsável, assinatura). Nenhum pode aparecer
   * no texto fixo: é a prova de que o exemplo não vazou para o modelo. Obrigatório quando a definição deriva
   * de um exemplo preenchido.
   */
  marcadoresDoExemplo: ReadonlyArray<string>;
  /** Origem do arquivo de onde a definição foi lida. */
  natureza: 'MODELO_EM_BRANCO_OFICIAL' | 'DERIVADA_DE_EXEMPLO_PREENCHIDO';
  /** Onde e como preencher o arquivo oficial desta versão. Sem layout, nada é gerado. */
  layout: LayoutDoModelo | null;
  /**
   * O texto do modelo coloca quem assina como representante da empresa. Os poderes são do SIGNATÁRIO LEGAL e vêm do
   * cadastro dele, com evidência (DOC-23): sem comprovação registrada, o encaminhamento fica pendente — nada é
   * presumido nem fabricado. Ausente/null = o modelo não exige poderes específicos.
   */
  poderesDeRepresentacao?: { fundamento: string } | null;
}

export type ProblemaDeDefinicao =
  | { tipo: 'TIPO_DIFERENTE_DO_CATALOGO'; esperado: TipoDocumento; recebido: TipoDocumento }
  | { tipo: 'ID_DUPLICADO'; id: string }
  | { tipo: 'CAMPO_SEM_FONTE'; campo: string }
  | { tipo: 'CAMPO_SEM_DADO'; campo: string }
  | { tipo: 'FONTE_DESCONHECIDA'; campo: string; fonte: string }
  | { tipo: 'BLOCO_FIXO_VAZIO'; bloco: string }
  | { tipo: 'EXEMPLO_NO_TEXTO_FIXO'; bloco: string; marcador: string }
  | { tipo: 'EXEMPLO_SEM_MARCADORES' }
  | { tipo: 'OPCAO_SEM_ALTERNATIVAS'; grupo: string }
  | { tipo: 'INCOMPATIBILIDADE_DESCONHECIDA'; grupo: string; alternativa: string }
  | { tipo: 'REGRA_INVALIDA'; regra: string; motivo: 'GRUPO_OU_ALTERNATIVA_INEXISTENTE' | 'SEM_FUNDAMENTO' | 'ALTERNATIVA_INCOMPATIVEL_COM_A_MODALIDADE' }
  | { tipo: 'ASSINATURA_EXIGIDA_SEM_LUGAR' }
  | { tipo: 'SEM_LAYOUT' }
  | {
    tipo: 'LAYOUT_INVALIDO'; item: string;
    motivo: 'CAMPO_SEM_LUGAR' | 'LUGAR_SEM_CAMPO' | 'ALTERNATIVA_SEM_MARCA' | 'MARCA_SEM_ALTERNATIVA' | 'PAGINA_INEXISTENTE' | 'MEDIDA_INVALIDA' | 'FONTE_OU_FORMATO_DESCONHECIDO'
      | 'RELACAO_ANEXA_INVALIDA';
  }
  | { tipo: 'LAYOUT_SOBRE_A_ASSINATURA'; item: string }
  /** Campo de escopo SIGNATARIO só aceita o cadastro do signatário legal, e esse cadastro só preenche campo de escopo SIGNATARIO. */
  | { tipo: 'ESCOPO_E_FONTE_INCOMPATIVEIS'; campo: string }
  | { tipo: 'PODERES_SEM_FUNDAMENTO' };

const normalizar = (t: string) => t.toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * Confere uma definição antes de qualquer uso. Uma definição com problema não
 * gera documento: melhor nada do que um documento com o exemplo vazado, sem
 * fonte, com regra sem fundamento ou com o lugar da assinatura preenchível.
 */
export function verificarDefinicao(d: DefinicaoDoModelo, esperado: TipoDocumento): ProblemaDeDefinicao[] {
  const p: ProblemaDeDefinicao[] = [];
  if (d.tipo !== esperado) p.push({ tipo: 'TIPO_DIFERENTE_DO_CATALOGO', esperado, recebido: d.tipo });
  const ids = [...d.campos.map((c) => c.id), ...d.blocosFixos.map((b) => b.id), ...d.opcoes.map((o) => o.id), ...(d.assinatura ? [d.assinatura.id] : [])];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) p.push({ tipo: 'ID_DUPLICADO', id });
  for (const c of d.campos) {
    if (String(c.dado ?? '').trim() === '') p.push({ tipo: 'CAMPO_SEM_DADO', campo: c.id });
    if (!c.fontesAceitas.length) p.push({ tipo: 'CAMPO_SEM_FONTE', campo: c.id });
    for (const f of c.fontesAceitas) if (!FONTES_DE_DADO.includes(f)) p.push({ tipo: 'FONTE_DESCONHECIDA', campo: c.id, fonte: f });
    const doSignatario = c.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL');
    if ((c.escopo === 'SIGNATARIO') !== doSignatario || (doSignatario && c.fontesAceitas.length !== 1)) p.push({ tipo: 'ESCOPO_E_FONTE_INCOMPATIVEIS', campo: c.id });
  }
  if (d.poderesDeRepresentacao && String(d.poderesDeRepresentacao.fundamento ?? '').trim() === '') p.push({ tipo: 'PODERES_SEM_FUNDAMENTO' });
  for (const b of d.blocosFixos) {
    if (b.texto.trim() === '') p.push({ tipo: 'BLOCO_FIXO_VAZIO', bloco: b.id });
    for (const m of d.marcadoresDoExemplo) {
      if (normalizar(m) !== '' && normalizar(b.texto).includes(normalizar(m))) p.push({ tipo: 'EXEMPLO_NO_TEXTO_FIXO', bloco: b.id, marcador: m });
    }
  }
  if (d.natureza === 'DERIVADA_DE_EXEMPLO_PREENCHIDO' && !d.marcadoresDoExemplo.some((m) => m.trim() !== '')) p.push({ tipo: 'EXEMPLO_SEM_MARCADORES' });
  for (const g of d.opcoes) {
    if (!g.alternativas.length) p.push({ tipo: 'OPCAO_SEM_ALTERNATIVAS', grupo: g.id });
    const alt = new Set(g.alternativas.map((a) => a.id));
    for (const par of g.incompativeis) for (const a of par) if (!alt.has(a)) p.push({ tipo: 'INCOMPATIBILIDADE_DESCONHECIDA', grupo: g.id, alternativa: a });
  }
  for (const r of d.regras) {
    const alternativa = d.opcoes.find((g) => g.id === r.grupo)?.alternativas.find((a) => a.id === r.alternativa);
    if (!alternativa) p.push({ tipo: 'REGRA_INVALIDA', regra: r.id, motivo: 'GRUPO_OU_ALTERNATIVA_INEXISTENTE' });
    else if (alternativa.modalidadesCompativeis && !alternativa.modalidadesCompativeis.includes(r.quandoModalidade)) {
      p.push({ tipo: 'REGRA_INVALIDA', regra: r.id, motivo: 'ALTERNATIVA_INCOMPATIVEL_COM_A_MODALIDADE' });
    }
    if (String(r.fundamento ?? '').trim() === '') p.push({ tipo: 'REGRA_INVALIDA', regra: r.id, motivo: 'SEM_FUNDAMENTO' });
  }
  // Decisões 14.2, 14.9 e DOC-23: todo documento de apresentação é assinado (pelo signatário legal, fora da Priora).
  if (!d.assinatura) p.push({ tipo: 'ASSINATURA_EXIGIDA_SEM_LUGAR' });
  if (!d.layout) p.push({ tipo: 'SEM_LAYOUT' });
  else p.push(...problemasDoLayout(d, d.layout));
  return p;
}

const positivo = (n: number) => Number.isFinite(n) && n > 0;
const finito = (n: number) => Number.isFinite(n);
const retanguloValido = (r: Retangulo) => finito(r.x) && finito(r.y) && positivo(r.largura) && positivo(r.altura);
const intersecta = (a: Retangulo, b: Retangulo) =>
  a.x < b.x + b.largura && b.x < a.x + a.largura && a.y < b.y + b.altura && b.y < a.y + a.altura;

/** Área que um campo pode ocupar (todas as linhas, com folga para descendentes e ascendentes). */
export function areaDoCampo(l: LugarDoCampo): Retangulo {
  const abaixo = (l.linhasMaximas - 1) * l.entrelinha + l.tamanho * 0.25;
  return { x: l.x, y: l.y - abaixo, largura: l.larguraMaxima, altura: abaixo + l.tamanho };
}

export function areaDaMarca(m: MarcaDaAlternativa): Retangulo {
  return m.tipo === 'CAIXA' ? m.caixa : { x: m.x, y: m.y - m.tamanho * 0.25, largura: m.tamanho, altura: m.tamanho * 1.25 };
}

function problemasDoLayout(d: DefinicaoDoModelo, l: LayoutDoModelo): ProblemaDeDefinicao[] {
  const p: ProblemaDeDefinicao[] = [];
  const pagina = (n: number) => Number.isInteger(n) && n >= 1 && n <= l.paginas.length;
  if (!l.paginas.length || l.paginas.some((x) => !positivo(x.largura) || !positivo(x.altura))) p.push({ tipo: 'LAYOUT_INVALIDO', item: 'paginas', motivo: 'MEDIDA_INVALIDA' });
  for (const [i, x] of l.limpeza.entries()) {
    if (!pagina(x.pagina)) p.push({ tipo: 'LAYOUT_INVALIDO', item: `limpeza#${i}`, motivo: 'PAGINA_INEXISTENTE' });
    if (!retanguloValido(x.area) || String(x.motivo ?? '').trim() === '') p.push({ tipo: 'LAYOUT_INVALIDO', item: `limpeza#${i}`, motivo: 'MEDIDA_INVALIDA' });
  }
  const assinatura = l.assinatura;
  if (!pagina(assinatura.pagina)) p.push({ tipo: 'LAYOUT_INVALIDO', item: 'assinatura', motivo: 'PAGINA_INEXISTENTE' });
  if (!retanguloValido(assinatura.area)) p.push({ tipo: 'LAYOUT_INVALIDO', item: 'assinatura', motivo: 'MEDIDA_INVALIDA' });
  const sobreAAssinatura = (pg: number, r: Retangulo) => pg === assinatura.pagina && intersecta(r, assinatura.area);

  for (const c of d.campos) if (!l.campos[c.id]) p.push({ tipo: 'LAYOUT_INVALIDO', item: c.id, motivo: 'CAMPO_SEM_LUGAR' });
  for (const [id, lugar] of Object.entries(l.campos)) {
    if (!d.campos.some((c) => c.id === id)) p.push({ tipo: 'LAYOUT_INVALIDO', item: id, motivo: 'LUGAR_SEM_CAMPO' });
    if (!pagina(lugar.pagina)) p.push({ tipo: 'LAYOUT_INVALIDO', item: id, motivo: 'PAGINA_INEXISTENTE' });
    if (!FONTES_DO_DESENHO.includes(lugar.fonte) || !FORMATOS_DO_VALOR.includes(lugar.formato)) p.push({ tipo: 'LAYOUT_INVALIDO', item: id, motivo: 'FONTE_OU_FORMATO_DESCONHECIDO' });
    if (!finito(lugar.x) || !finito(lugar.y) || !positivo(lugar.tamanho) || !positivo(lugar.tamanhoMinimo) || lugar.tamanhoMinimo > lugar.tamanho
      || !positivo(lugar.larguraMaxima) || !Number.isInteger(lugar.linhasMaximas) || lugar.linhasMaximas < 1 || !positivo(lugar.entrelinha)) {
      p.push({ tipo: 'LAYOUT_INVALIDO', item: id, motivo: 'MEDIDA_INVALIDA' });
    } else if (sobreAAssinatura(lugar.pagina, areaDoCampo(lugar))) p.push({ tipo: 'LAYOUT_SOBRE_A_ASSINATURA', item: id });
    // Texto fixo redesenhado também não pode carregar dado do exemplo.
    for (const m of d.marcadoresDoExemplo) {
      for (const t of [lugar.prefixo, lugar.sufixo]) {
        if (normalizar(m) !== '' && normalizar(t ?? '').includes(normalizar(m))) p.push({ tipo: 'EXEMPLO_NO_TEXTO_FIXO', bloco: id, marcador: m });
      }
    }
  }
  for (const g of d.opcoes) {
    for (const a of g.alternativas) {
      const marca = l.opcoes[g.id]?.[a.id];
      if (!marca) {
        p.push({ tipo: 'LAYOUT_INVALIDO', item: `${g.id}.${a.id}`, motivo: 'ALTERNATIVA_SEM_MARCA' });
        continue;
      }
      if (!pagina(marca.pagina)) p.push({ tipo: 'LAYOUT_INVALIDO', item: `${g.id}.${a.id}`, motivo: 'PAGINA_INEXISTENTE' });
      if (!retanguloValido(areaDaMarca(marca))) p.push({ tipo: 'LAYOUT_INVALIDO', item: `${g.id}.${a.id}`, motivo: 'MEDIDA_INVALIDA' });
      else if (sobreAAssinatura(marca.pagina, areaDaMarca(marca))) p.push({ tipo: 'LAYOUT_SOBRE_A_ASSINATURA', item: `${g.id}.${a.id}` });
    }
  }
  for (const [grupo, marcas] of Object.entries(l.opcoes)) {
    for (const alt of Object.keys(marcas)) {
      if (!d.opcoes.some((g) => g.id === grupo && g.alternativas.some((a) => a.id === alt))) p.push({ tipo: 'LAYOUT_INVALIDO', item: `${grupo}.${alt}`, motivo: 'MARCA_SEM_ALTERNATIVA' });
    }
  }
  if (l.relacaoAnexa && !relacaoAnexaValida(d, l, l.relacaoAnexa)) p.push({ tipo: 'LAYOUT_INVALIDO', item: 'relacaoAnexa', motivo: 'RELACAO_ANEXA_INVALIDA' });
  return p;
}

/** Linhas que a remissão ocupa no lugar do campo ("VIDE RELAÇÃO ANEXA", total, páginas). */
export const LINHAS_DA_REMISSAO = 3;
/** Teto de itens por página da relação (legibilidade: uma coluna, um item por linha). */
export const MAXIMO_DE_ITENS_POR_PAGINA = 40;

function relacaoAnexaValida(d: DefinicaoDoModelo, l: LayoutDoModelo, r: RelacaoAnexa): boolean {
  const lugar = l.campos[r.campo];
  const inteiro = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  return !!lugar && lugar.formato === 'LISTA' && d.campos.some((c) => c.id === r.campo)
    && inteiro(r.maximoNoLugar, 1, lugar.linhasMaximas) && lugar.linhasMaximas >= LINHAS_DA_REMISSAO
    && inteiro(r.itensPorPagina, 1, MAXIMO_DE_ITENS_POR_PAGINA)
    && [r.titulo, r.vinculo, r.item, r.itens].every((t) => String(t ?? '').trim() !== '')
    && r.identificacao.length > 0 && r.identificacao.every((x) => d.campos.some((c) => c.id === x.campo && c.obrigatorio) && String(x.rotulo ?? '').trim() !== '')
    && (r.aceiteDaAgencia?.estado === 'PENDENTE_DE_ACEITE_DA_AGENCIA'
      || (r.aceiteDaAgencia?.estado === 'ACEITO_PELA_AGENCIA' && String(r.aceiteDaAgencia.evidencia?.ref ?? '').trim() !== ''
        && String(r.aceiteDaAgencia.registradoPor ?? '').trim() !== ''));
}

/** Itens de um valor LISTA, na ordem (linhas não vazias, sem espaços nas pontas). */
export const itensDaLista = (valor: string): string[] => String(valor ?? '').split('\n').map((x) => x.trim()).filter((x) => x !== '');

/**
 * DOC-27: como o conteúdo usa a relação anexa. `null` = o modelo não tem relação ou a lista cabe no lugar.
 * Senão: quantos itens e quantas páginas adicionais (a primeira é a seguinte à última página oficial).
 */
export function usoDaRelacaoAnexa(d: DefinicaoDoModelo, campos: ReadonlyArray<{ campo: string; valor: string }>):
  { itens: number; paginas: number; primeiraPagina: number; aceite: RelacaoAnexa['aceiteDaAgencia']['estado'] } | null {
  const r = d.layout?.relacaoAnexa;
  if (!r || !d.layout) return null;
  const valor = campos.find((c) => c.campo === r.campo)?.valor;
  const itens = valor === undefined ? 0 : itensDaLista(valor).length;
  if (itens <= r.maximoNoLugar) return null;
  return { itens, paginas: Math.ceil(itens / r.itensPorPagina), primeiraPagina: d.layout.paginas.length + 1, aceite: r.aceiteDaAgencia.estado };
}
