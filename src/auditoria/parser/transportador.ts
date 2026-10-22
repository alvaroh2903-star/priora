/**
 * Regra DETERMINÍSTICA do papel de transportador marítimo num trecho literal de documento (P1-A, preservada na O2.1-C).
 *
 * PURA e NÃO LIGADA: nenhum I/O, nenhum banco, nenhuma IA, nenhum OCR, nenhuma lista de armadores, e nenhum caminho de
 * produção a importa. Não depende de extrator nenhum: recebe declarações candidatas (nome + trecho, como o documento as
 * imprime) e diz, só pelo texto, se o trecho atribui ao nome o papel de transportador. A fonte prevista é a evidência de
 * OCR do Mistral (`SourceOcrEvidenceV1`, chave `ocr-source:v1:`), depois da convergência documental aprovada.
 *
 * Uma declaração só é ACEITA quando o próprio trecho a sustenta, em qualquer posição do documento:
 *  - o nome está no trecho;
 *  - o trecho atribui a esse nome, explicitamente, o papel de transportador ("Carrier: X", "for the Carrier X",
 *    "X as Carrier", "X (the Carrier)"), e nenhum outro papel;
 *  - o nome não é o do signatário que assina como agente, nem designa agência, NVOCC ou agente de cargas.
 * Logotipo, cabeçalho sem o papel, prefixo do BL ou do contêiner (SCAC), rastreamento e remetente nunca são aceitos:
 * sem o papel escrito no trecho, nada é aceito.
 */

/** Onde o documento declara o transportador. Qualquer posição vale; a declaração explícita do papel é o que conta. */
export type PosicaoDaDeclaracao = 'CAMPO_TRANSPORTADOR' | 'CLAUSULA_DE_ASSINATURA' | 'CLAUSULA_DE_TERMOS' | 'OUTRA_DECLARACAO';

/** Declaração candidata, literal (nome e trecho como impressos). */
export interface DeclaracaoDoTransportador {
  nome: string | null;
  posicao: PosicaoDaDeclaracao | null;
  trecho: string | null;
}

/** Quem assina e em que papel, quando a fonte o informa (opcional). */
export interface AssinaturaDoDocumento {
  signatario: string | null;
  papel: 'TRANSPORTADOR' | 'AGENTE_DO_TRANSPORTADOR' | 'OUTRO' | null;
}

/** Forma de comparação: sem diacríticos, maiúsculas, cada sequência não alfanumérica vira um espaço. Nada mais é removido. */
export function normalizarNome(texto: string): string {
  return texto.normalize('NFKD').replace(/\p{M}+/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

type Papel = 'TRANSPORTADOR' | 'AGENTE' | 'NVOCC_OU_AGENTE_DE_CARGAS' | 'OUTRA_PARTE';

/** Expressões de papel, já na forma normalizada. A mais longa vale primeiro ("NON VESSEL OPERATING COMMON CARRIER" não é transportador). */
const EXPRESSOES_POR_PAPEL: Readonly<Record<Papel, ReadonlyArray<string>>> = {
  NVOCC_OU_AGENTE_DE_CARGAS: ['NON VESSEL OPERATING COMMON CARRIER', 'NON VESSEL OPERATING CARRIER', 'NVOCC', 'NVO', 'FREIGHT FORWARDER', 'FORWARDER',
    'FORWARDING AGENT', 'AGENTE DE CARGAS', 'AGENTE DE CARGA', 'CONSOLIDATOR', 'CONSOLIDADOR', 'CONSOLIDADORA'],
  AGENTE: ['FOR DELIVERY APPLY TO', 'DELIVERY AGENT', 'AGENT', 'AGENTS', 'AGENTE', 'AGENTES', 'AGENCY', 'AGENCIES', 'AGENCIA', 'AGENCIAS'],
  TRANSPORTADOR: ['OCEAN CARRIER', 'CARRIER', 'CARRIERS', 'TRANSPORTADOR', 'ARMADOR', 'TRANSPORTISTA'],
  OUTRA_PARTE: ['NOTIFY PARTY', 'NOTIFY', 'SHIPPER', 'CONSIGNEE', 'EMBARCADOR', 'CONSIGNATARIO', 'EXPORTER', 'EXPORTADOR', 'IMPORTER', 'IMPORTADOR'],
};
const EXPRESSOES = (Object.entries(EXPRESSOES_POR_PAPEL) as Array<[Papel, ReadonlyArray<string>]>)
  .flatMap(([papel, lista]) => lista.map((e) => ({ papel, palavras: e.split(' ') })))
  .sort((a, b) => b.palavras.length - a.palavras.length);

/** Palavras que, DENTRO do nome, já dizem que ele não é o transportador. */
const NOME_DE_AGENCIA = new Set(['AGENT', 'AGENTS', 'AGENTE', 'AGENTES', 'AGENCY', 'AGENCIES', 'AGENCIA', 'AGENCIAS']);
const NOME_DE_AGENTE_DE_CARGAS = new Set(['NVOCC', 'NVO', 'FORWARDER', 'FORWARDERS', 'FORWARDING', 'FREIGHT', 'LOGISTICS', 'LOGISTIC', 'LOGISTICA',
  'CONSOLIDATOR', 'CONSOLIDADOR', 'CONSOLIDADORA']);

/** Ligação explícita do papel ao nome que o PRECEDE ("X as Carrier", "X (the Carrier)", "X acting as agent"). */
const LIGACAO_POSTERIOR = new Set(['AS', 'COMO', 'THE', 'ACTING', 'ATUANDO', 'NA', 'QUALIDADE', 'DE', 'O', 'A']);
const MAX_LIGACAO = 3;
/** Distância máxima (em palavras) entre o papel e o nome que ele rotula ("Carrier: X", "for the Carrier X"). */
const MAX_ROTULO = 3;
/** "agent(s) for X": X é o representado, não o agente (o papel dele não está escrito ali). */
const REPRESENTADO = new Set(['FOR', 'OF', 'BEHALF', 'PARA', 'DE', 'DO', 'DA', 'POR']);

interface Marca { papel: Papel; inicio: number; fim: number }

function marcasDe(palavras: ReadonlyArray<string>): Marca[] {
  const out: Marca[] = [];
  for (let i = 0; i < palavras.length;) {
    const achada = EXPRESSOES.find((e) => e.palavras.every((p, k) => palavras[i + k] === p));
    if (achada) {
      out.push({ papel: achada.papel, inicio: i, fim: i + achada.palavras.length });
      i += achada.palavras.length;
    } else i++;
  }
  return out;
}

function ocorrencias(palavras: ReadonlyArray<string>, nome: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  for (let i = 0; i + nome.length <= palavras.length; i++) if (nome.every((p, k) => palavras[i + k] === p)) out.push(i);
  return out;
}

/** O papel que o trecho atribui a UMA ocorrência do nome: depois (ligação explícita) e antes (rótulo). Discordância = conflito. */
function papelDaOcorrencia(palavras: ReadonlyArray<string>, marcas: ReadonlyArray<Marca>, inicio: number, fim: number): Papel | 'CONFLITO' | null {
  let depois: Papel | null = null;
  for (let k = fim, ligacoes = 0; k < palavras.length && ligacoes <= MAX_LIGACAO; k++) {
    const m = marcas.find((x) => x.inicio === k);
    if (m) { if (ligacoes > 0) depois = m.papel; break; }
    if (!LIGACAO_POSTERIOR.has(palavras[k])) break;
    ligacoes++;
  }
  const anterior = marcas.filter((m) => m.fim <= inicio && inicio - m.fim <= MAX_ROTULO).pop();
  const representado = anterior?.papel === 'AGENTE' && palavras.slice(anterior.fim, inicio).some((p) => REPRESENTADO.has(p));
  const antes = anterior && !representado ? anterior.papel : null;
  if (depois && antes && depois !== antes) return 'CONFLITO';
  return depois ?? antes;
}

export type MotivoDeRecusa =
  | 'SEM_NOME' | 'SEM_TRECHO' | 'NOME_FORA_DO_TRECHO' | 'PAPEL_NAO_DECLARADO' | 'PAPEL_DE_AGENTE' | 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS'
  | 'PAPEL_DE_OUTRA_PARTE' | 'PAPEIS_CONFLITANTES' | 'SIGNATARIO_AGENTE';

export type VeredictoDaDeclaracao =
  | { tipo: 'ACEITA'; nome: string; normalizado: string; posicao: PosicaoDaDeclaracao | null; trecho: string }
  | { tipo: 'RECUSADA'; motivo: MotivoDeRecusa; nome: string | null; posicao: PosicaoDaDeclaracao | null; trecho: string | null };

const RECUSA_DO_PAPEL: Record<Exclude<Papel, 'TRANSPORTADOR'>, MotivoDeRecusa> = {
  AGENTE: 'PAPEL_DE_AGENTE', NVOCC_OU_AGENTE_DE_CARGAS: 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS', OUTRA_PARTE: 'PAPEL_DE_OUTRA_PARTE',
};

/** Aceita ou recusa UMA declaração candidata (nome + trecho literal do documento), só pelo texto (determinístico). */
export function veredictoDaDeclaracao(d: DeclaracaoDoTransportador, assinatura: AssinaturaDoDocumento | null = null): VeredictoDaDeclaracao {
  const recusa = (motivo: MotivoDeRecusa): VeredictoDaDeclaracao => ({ tipo: 'RECUSADA', motivo, nome: d.nome, posicao: d.posicao, trecho: d.trecho });
  const normalizado = normalizarNome(d.nome ?? '');
  if (!normalizado) return recusa('SEM_NOME');
  const trecho = normalizarNome(d.trecho ?? '');
  if (!trecho) return recusa('SEM_TRECHO');
  const nome = normalizado.split(' ');
  const palavras = trecho.split(' ');
  const posicoes = ocorrencias(palavras, nome);
  if (!posicoes.length) return recusa('NOME_FORA_DO_TRECHO');
  if (nome.some((p) => NOME_DE_AGENCIA.has(p))) return recusa('PAPEL_DE_AGENTE');
  if (nome.some((p) => NOME_DE_AGENTE_DE_CARGAS.has(p))) return recusa('PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS');
  if (assinatura?.papel === 'AGENTE_DO_TRANSPORTADOR' && normalizarNome(assinatura.signatario ?? '') === normalizado) return recusa('SIGNATARIO_AGENTE');
  const marcas = marcasDe(palavras);
  const papeis = new Set(posicoes.map((i) => papelDaOcorrencia(palavras, marcas, i, i + nome.length)).filter((p): p is Papel | 'CONFLITO' => p !== null));
  if (papeis.has('CONFLITO') || (papeis.has('TRANSPORTADOR') && papeis.size > 1)) return recusa('PAPEIS_CONFLITANTES');
  if (papeis.has('TRANSPORTADOR')) return { tipo: 'ACEITA', nome: d.nome!.trim(), normalizado, posicao: d.posicao, trecho: d.trecho! };
  if (papeis.size > 1) return recusa('PAPEIS_CONFLITANTES');
  const [outro] = [...papeis] as Array<Exclude<Papel, 'TRANSPORTADOR'>>;
  return recusa(outro ? RECUSA_DO_PAPEL[outro] : 'PAPEL_NAO_DECLARADO');
}

/**
 * O transportador de UMA leitura (versão) do documento:
 *  - NAO_EXTRAIDO: a fonte não forneceu declarações para esta leitura — não contribui;
 *  - NAO_DECLARADO: há leitura, sem nenhuma declaração aceita (as recusadas ficam visíveis);
 *  - DECLARADO: as declarações aceitas, com os nomes distintos (pode haver mais de um: nada é escolhido aqui);
 *  - AMBIGUO: alguma declaração atribui papéis conflitantes ao mesmo nome.
 */
export type TransportadorDaVersao =
  | { tipo: 'NAO_EXTRAIDO' }
  | { tipo: 'NAO_DECLARADO'; recusadas: VeredictoDaDeclaracao[] }
  | { tipo: 'DECLARADO'; nomes: Array<{ normalizado: string; literais: string[] }>; aceitas: VeredictoDaDeclaracao[]; recusadas: VeredictoDaDeclaracao[] }
  | { tipo: 'AMBIGUO'; aceitas: VeredictoDaDeclaracao[]; recusadas: VeredictoDaDeclaracao[] };

export function transportadorDaVersao(
  declaracoes: ReadonlyArray<DeclaracaoDoTransportador> | undefined, assinatura: AssinaturaDoDocumento | null = null,
): TransportadorDaVersao {
  if (!declaracoes) return { tipo: 'NAO_EXTRAIDO' };
  const vereditos = declaracoes.map((d) => veredictoDaDeclaracao(d, assinatura));
  const aceitas = vereditos.filter((v) => v.tipo === 'ACEITA');
  // Declaração sem nome é ausência, não informação: não aparece como recusa.
  const recusadas = vereditos.filter((v) => v.tipo === 'RECUSADA' && v.motivo !== 'SEM_NOME');
  if (recusadas.some((v) => v.tipo === 'RECUSADA' && v.motivo === 'PAPEIS_CONFLITANTES')) return { tipo: 'AMBIGUO', aceitas, recusadas };
  if (!aceitas.length) return { tipo: 'NAO_DECLARADO', recusadas };
  const nomes = new Map<string, Set<string>>();
  for (const a of aceitas) if (a.tipo === 'ACEITA') nomes.set(a.normalizado, (nomes.get(a.normalizado) ?? new Set()).add(a.nome));
  return {
    tipo: 'DECLARADO', aceitas, recusadas,
    nomes: [...nomes.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([normalizado, l]) => ({ normalizado, literais: [...l].sort() })),
  };
}

/**
 * Uma leitura de um documento do Master, de QUALQUER fonte documental: a referência da evidência (ex.: a assinatura
 * `ocr-source:v1:` do Mistral), o hash dos bytes, os instantes e as declarações candidatas (ausente = não fornecidas).
 */
export interface LeituraParaTransportador {
  evidenciaRef: string;
  arquivoSha256: string | null;
  /** Instante do documento (ex.: recebimento do e-mail). */
  observadaEm: Date;
  /** Instante da leitura (OCR). */
  extraidaEm: Date;
  declaracoes?: ReadonlyArray<DeclaracaoDoTransportador>;
  assinatura?: AssinaturaDoDocumento | null;
}

export interface LeituraDoTransportador {
  evidenciaRef: string;
  arquivoSha256: string | null;
  observadaEm: Date;
  extraidaEm: Date;
  estado: TransportadorDaVersao;
}

/**
 * Por arquivo (mesmos bytes): as leituras com declarações concordam (CONCLUSIVO) ou não (LEITURAS_DIVERGENTES).
 * Arquivo sem leitura que forneça declarações: SEM_LEITURA. Leitura sem hash é um arquivo próprio.
 */
export interface ArquivoDoTransportador {
  arquivoSha256: string | null;
  evidenciaRefs: string[];
  situacao: 'CONCLUSIVO' | 'LEITURAS_DIVERGENTES' | 'SEM_LEITURA';
}

export interface TransportadorDoMbl {
  masterId: string;
  leituras: LeituraDoTransportador[];
  arquivos: ArquivoDoTransportador[];
}

/** A mesma leitura, independente do trecho exato: o estado e os nomes aceitos. */
const assinaturaDoEstado = (e: TransportadorDaVersao): string =>
  JSON.stringify([e.tipo, e.tipo === 'DECLARADO' ? e.nomes.map((n) => n.normalizado) : []]);

/** As leituras do Master → o transportador de cada uma, agrupado por arquivo. Nada é escolhido entre versões. */
export function transportadorDoMbl(masterId: string, leituras: ReadonlyArray<LeituraParaTransportador>): TransportadorDoMbl {
  const lidas: LeituraDoTransportador[] = leituras.map((l) => ({
    evidenciaRef: l.evidenciaRef, arquivoSha256: l.arquivoSha256, observadaEm: l.observadaEm, extraidaEm: l.extraidaEm,
    estado: transportadorDaVersao(l.declaracoes, l.assinatura ?? null),
  }));
  const grupos = new Map<string, LeituraDoTransportador[]>();
  for (const l of lidas) {
    const chave = l.arquivoSha256 ? `sha:${l.arquivoSha256}` : `evidencia:${l.evidenciaRef}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), l]);
  }
  const arquivos: ArquivoDoTransportador[] = [...grupos.values()].map((g) => {
    const lidasComDeclaracao = g.filter((l) => l.estado.tipo !== 'NAO_EXTRAIDO');
    const situacao = !lidasComDeclaracao.length ? 'SEM_LEITURA'
      : new Set(lidasComDeclaracao.map((l) => assinaturaDoEstado(l.estado))).size === 1 ? 'CONCLUSIVO' : 'LEITURAS_DIVERGENTES';
    return { arquivoSha256: g[0].arquivoSha256, evidenciaRefs: g.map((l) => l.evidenciaRef), situacao };
  });
  return { masterId, leituras: lidas, arquivos };
}
