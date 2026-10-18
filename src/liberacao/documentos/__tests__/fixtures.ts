import { ArmadorDoMaster } from '../../dominio';
import {
  AnexoDoManifesto, AssinaturaRegistrada, CandidatoCopiaDoMbl, CaixaMonitorada, ComprovacaoDePoderes, ConferenciaDaAssinatura, DefinicaoDoModelo, DepsDocumentos, DestinatariosValidados,
  SignatarioLegal,
  DocumentoPreparado, EventoDoEnvio, FalhaAntesDoEnvio, FonteDeDado, FontesConfiaveis, GeradorDePdf, LayoutDoModelo, ModalidadeObservada, ObservacaoDaMensagem,
  OutlookDoAnalista, RemetentesConfiaveisDaAgencia, RepositorioDocumental, SinalPendente, TentativaDeEnvio, TipoDocumento, ValorObservado, VeredictoDoSinal,
  VersaoDoModelo, canonico, sha256, SinalDeRejeicao,
} from '..';

/**
 * Fixtures em memória do domínio documental.
 *
 * ATENÇÃO: os modelos abaixo são SINTÉTICOS, feitos só para exercitar o
 * mecanismo. NÃO são os modelos oficiais da Evergreen, MSC, Hapag-Lloyd ou
 * ZIM: nenhum texto, campo, opção ou dado deles foi recriado de memória. Os
 * testes provam regras e guardas; não provam a geração dos documentos reais.
 * O gerador, o Outlook e a caixa monitorada daqui são SIMULADOS.
 */

export const TEXTO_SINTETICO = 'MODELO SINTÉTICO DE TESTE — NÃO É O MODELO OFICIAL';

/** Bytes do "arquivo oficial" sintético de cada tipo/versão. */
export const arquivoSintetico = (tipo: TipoDocumento, rotulo = 'v1') => new TextEncoder().encode(`%PDF-1.4\n% ${TEXTO_SINTETICO} — ${tipo} — ${rotulo}\n`);

export const CLAUSULA = `CLÁUSULA SINTÉTICA DE TESTE: ${TEXTO_SINTETICO}. Este texto fixo nunca muda.`;
export const TABELA = 'TABELA TARIFÁRIA SINTÉTICA | ITEM A | 1,00 | ITEM B | 2,00';

/** Layout SINTÉTICO (posições fictícias numa página A4) que acompanha as definições sintéticas. */
export const layoutSintetico = (d: Omit<DefinicaoDoModelo, 'layout'>): LayoutDoModelo => ({
  paginas: [{ largura: 595, altura: 842 }],
  limpeza: [],
  campos: Object.fromEntries(d.campos.map((c, i) => [c.id, {
    pagina: 1, x: 72, y: 700 - i * 20, fonte: 'HELVETICA' as const, tamanho: 10, tamanhoMinimo: 10, larguraMaxima: 400, linhasMaximas: 1, entrelinha: 12,
    formato: c.dado === 'DATA_DA_GERACAO' ? 'DATA_POR_EXTENSO' as const : 'TEXTO' as const, prefixo: '', sufixo: '',
  }])),
  opcoes: Object.fromEntries(d.opcoes.map((g) => [g.id, Object.fromEntries(g.alternativas.map((a, k) => [a.id, {
    tipo: 'CAIXA' as const, pagina: 1, caixa: { x: 72 + k * 20, y: 400, largura: 8, altura: 8 },
  }]))])),
  assinatura: { pagina: 1, area: { x: 72, y: 100, largura: 200, altura: 50 } },
});

const comLayout = (d: Omit<DefinicaoDoModelo, 'layout'> & { layout?: DefinicaoDoModelo['layout'] }): DefinicaoDoModelo =>
  ({ ...d, layout: d.layout !== undefined ? d.layout : layoutSintetico(d) });

export const definicaoEvergreen = (p: Partial<DefinicaoDoModelo> = {}): DefinicaoDoModelo => comLayout({
  tipo: 'TERMO_EVERGREEN',
  campos: [
    { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
    { id: 'navio', rotulo: 'Navio', dado: 'NOME_DO_NAVIO', obrigatorio: true, fontesAceitas: ['S3_VIAGEM'], escopo: 'MASTER' },
    { id: 'data', rotulo: 'Data', dado: 'DATA_DA_GERACAO', obrigatorio: true, fontesAceitas: ['GERACAO'], escopo: 'DOCUMENTO' },
  ],
  blocosFixos: [
    { id: 'clausula', natureza: 'TEXTO_JURIDICO', texto: CLAUSULA },
    { id: 'tarifas', natureza: 'TABELA_TARIFARIA', texto: TABELA },
  ],
  opcoes: [],
  regras: [],
  assinatura: { id: 'assinatura', rotulo: 'Assinatura do responsável' },
  marcadoresDoExemplo: ['BL-DO-EXEMPLO-0001', 'NAVIO DO EXEMPLO', '01/01/2001', 'RESPONSAVEL DO EXEMPLO'],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  ...p,
});

/** Grupo de serviços SINTÉTICO (alternativas, restrições e regras reais só virão dos modelos oficiais + decisão de produto). */
export const definicaoMemorando = (tipo: Exclude<TipoDocumento, 'TERMO_EVERGREEN'>, p: Partial<DefinicaoDoModelo> = {}): DefinicaoDoModelo => comLayout({
  tipo,
  campos: [{ id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' }],
  blocosFixos: [{ id: 'texto', natureza: 'TEXTO_JURIDICO', texto: `${TEXTO_SINTETICO} — memorando ${tipo}` }],
  opcoes: [{
    id: 'servico', rotulo: 'Serviço', selecao: 'UMA_OU_MAIS', obrigatorio: true,
    alternativas: [
      { id: 'SERVICO_A', rotulo: 'Serviço A', modalidadesCompativeis: ['FISICO'] },
      { id: 'SERVICO_B', rotulo: 'Serviço B' },
      { id: 'SERVICO_C', rotulo: 'Serviço C' },
    ],
    incompativeis: [['SERVICO_A', 'SERVICO_B']],
  }],
  regras: [],
  assinatura: { id: 'assinatura', rotulo: 'Assinatura' },
  marcadoresDoExemplo: ['BL-DO-EXEMPLO-0002'],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  ...p,
});

/** MOCK identificado: gerador determinístico de TESTE. Copia o texto fixo da definição como está e deixa a assinatura em branco. */
export const GERADOR_DE_TESTE: GeradorDePdf & { chamadas: number } = {
  id: 'MOCK_DETERMINISTICO_DE_TESTE', versao: '1', chamadas: 0,
  async gerar({ definicao, conteudo, modeloOficial }) {
    GERADOR_DE_TESTE.chamadas++;
    return new TextEncoder().encode(`%PDF-1.4\n% MOCK DE TESTE\n${canonico({
      modelo: sha256(modeloOficial), versao: conteudo.modelo.versao,
      blocos: definicao.blocosFixos.map((b) => b.texto), campos: conteudo.campos, opcoes: conteudo.opcoes,
      assinatura: conteudo.assinaturaReservada ? `[${conteudo.assinaturaReservada}: EM BRANCO — ASSINATURA HUMANA]` : null,
    })}`);
  },
};

export const texto = (b: Uint8Array) => new TextDecoder().decode(b);
export const pdf = (conteudo: string) => new TextEncoder().encode(`%PDF-1.7\n${conteudo}`);
/**
 * "PDF assinado" SINTÉTICO: só a ESTRUTURA de um campo de assinatura (/Type /Sig + /ByteRange), sem certificado, chave ou
 * assinatura criptográfica reais (DOC-23: nenhum certificado real nos testes). Serve para o indício dos bytes, nunca prova nada.
 */
export const ESTRUTURA_DE_ASSINATURA_SINTETICA = '\n<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 0 0 0] /Contents <00> >>\n% ASSINATURA SINTETICA DE TESTE - SEM CERTIFICADO\n';
export const assinadoSintetico = (rotulo: string) => pdf(`${rotulo}${ESTRUTURA_DE_ASSINATURA_SINTETICA}`);
/** Assinatura sintética APLICADA SOBRE o PDF preparado (atualização incremental), como faz o leitor de PDF. */
export const assinarSobre = (preparado: Uint8Array, rotulo = 'assinatura') =>
  new Uint8Array([...preparado, ...new TextEncoder().encode(`\n% ${rotulo}${ESTRUTURA_DE_ASSINATURA_SINTETICA}`)]);

export function relogio(inicio = '2026-10-14T13:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { agora: () => new Date(t), avancar: (ms: number) => { t += ms; } };
}

/* ---------------------------------------- repositório ---------------------------------------- */

interface EventoDeModelo { id: string; org: string; modeloId: string; tipo: string; origem: string; por: string | null; detalhe: any; em: string }

export interface Memoria {
  versoes: Array<VersaoDoModelo & { org: string; arquivo: Uint8Array }>;
  eventosDeModelo: EventoDeModelo[];
  documentos: Array<DocumentoPreparado & { arquivo: Uint8Array; org: string; plano: unknown }>;
  assinaturas: Array<AssinaturaRegistrada & { arquivo: Uint8Array; org: string }>;
  conferencias: Array<ConferenciaDaAssinatura & { org: string }>;
  tentativas: Array<TentativaDeEnvio & { org: string }>;
  eventosDoEnvio: Array<EventoDoEnvio & { org: string }>;
}

const TERMINAIS = ['ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO'];

/** Repositório em memória com a mesma semântica do PostgreSQL (idempotência, transições condicionais, unicidades). */
export function repositorioEmMemoria(opcoes: { idsUuid?: boolean } = {}): RepositorioDocumental & { m: Memoria } {
  const m: Memoria = { versoes: [], eventosDeModelo: [], documentos: [], assinaturas: [], conferencias: [], tentativas: [], eventosDoEnvio: [] };
  let seq = 0;
  // Ids legíveis por padrão; UUID quando o teste passa pelas rotas HTTP (que só aceitam UUID).
  const id = (p: string) => (opcoes.idsUuid ? `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` : `${p}-${++seq}`);
  const semInterno = <T extends object>(x: T, ...chaves: string[]) => {
    const c: any = { ...x };
    for (const k of ['org', 'arquivo', 'plano', ...chaves]) delete c[k];
    return c;
  };
  const eventoDeModelo = (org: string, modeloId: string, tipo: string, origem: string, por: string | null, detalhe: any, em: Date) => {
    const e = { id: id('evm'), org, modeloId, tipo, origem, por, detalhe, em: em.toISOString() };
    m.eventosDeModelo.push(e);
    return e;
  };
  const decidido = (org: string, sinalId: string) =>
    m.eventosDeModelo.some((e) => e.org === org && ['REJEICAO_CONFIRMADA', 'SINAL_DESCARTADO'].includes(e.tipo) && e.detalhe?.sinalId === sinalId);
  return {
    m,
    async versoes(org, tipo) { return m.versoes.filter((v) => v.org === org && v.tipo === tipo).map((v) => semInterno(v)); },
    async versao(org, modeloId) {
      const v = m.versoes.find((x) => x.org === org && x.modeloId === modeloId);
      return v ? semInterno(v) : null;
    },
    async arquivoDoModelo(org, modeloId) { return m.versoes.find((x) => x.org === org && x.modeloId === modeloId)?.arquivo ?? null; },
    async cadastrarVersao(org, n) {
      const igual = m.versoes.find((v) => v.org === org && v.tipo === n.tipo && v.arquivoSha256 === n.arquivoSha256);
      if (igual) return { modeloId: igual.modeloId, nova: false };
      if (m.versoes.some((v) => v.org === org && v.tipo === n.tipo && v.versao === n.versao)) throw new Error('versão já existe com outro arquivo');
      const modeloId = id('modelo');
      m.versoes.push({
        org, modeloId, tipo: n.tipo, versao: n.versao, arquivoSha256: n.arquivoSha256, arquivo: n.arquivo, definicao: n.definicao, estado: 'PENDENTE_DE_VALIDACAO',
        cadastradoEm: n.em.toISOString(), validacao: null, rejeicao: null,
        origem: n.origem.tipo === 'CADASTRO' ? { tipo: 'CADASTRO', por: n.origem.por }
          : { tipo: 'SUBSTITUTO_DA_AGENCIA', substitui: n.origem.substitui, email: n.origem.email, anexo: n.origem.anexo },
      });
      eventoDeModelo(org, modeloId, n.origem.tipo === 'CADASTRO' ? 'MODELO_CADASTRADO' : 'SUBSTITUTO_RECEBIDO', n.origem.tipo === 'CADASTRO' ? 'PESSOA' : 'INTEGRACAO',
        n.origem.tipo === 'CADASTRO' ? n.origem.por : null, { sinalId: n.origem.tipo === 'SUBSTITUTO_DA_AGENCIA' ? n.origem.sinalId : null }, n.em);
      return { modeloId, nova: true };
    },
    async definirLeitura(org, modeloId, definicao, por, em) {
      const v = m.versoes.find((x) => x.org === org && x.modeloId === modeloId);
      if (!v || v.estado !== 'PENDENTE_DE_VALIDACAO') return false;
      v.definicao = definicao;
      eventoDeModelo(org, modeloId, 'LEITURA_DO_MODELO_DEFINIDA', 'PESSOA', por, {}, em);
      return true;
    },
    async mudarEstadoDoModelo(org, modeloId, de, para, e, em) {
      const v = m.versoes.find((x) => x.org === org && x.modeloId === modeloId);
      if (!v || v.estado !== de) return false;
      v.estado = para;
      if (para === 'VALIDADO') v.validacao = { por: e.por!, em: em.toISOString() };
      if (para === 'REJEITADO_PELA_AGENCIA') {
        v.rejeicao = { em: em.toISOString(), sinalId: (e.detalhe as any)?.sinalId, confirmadaPor: e.origem === 'PESSOA' ? { tipo: 'PESSOA', por: e.por! } : { tipo: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' } };
      }
      eventoDeModelo(org, modeloId, e.tipo, e.origem, e.por, e.detalhe ?? {}, em);
      return true;
    },
    async registrarSinal(org, sinal, veredicto, em) {
      const igual = m.eventosDeModelo.find((x) => x.org === org && x.modeloId === sinal.modeloId && x.tipo === 'SINAL_DE_REJEICAO' && x.detalhe.messageId === sinal.email.messageId);
      if (igual) return { sinalId: igual.id, novo: false };
      const e = eventoDeModelo(org, sinal.modeloId, 'SINAL_DE_REJEICAO', 'INTEGRACAO', null, { messageId: sinal.email.messageId, sinal, veredicto }, em);
      return { sinalId: e.id, novo: true };
    },
    async sinal(org, sinalId) {
      const e = m.eventosDeModelo.find((x) => x.org === org && x.id === sinalId && x.tipo === 'SINAL_DE_REJEICAO');
      return e ? { sinal: { ...(e.detalhe.sinal as Omit<SinalDeRejeicao, 'sinalId'>), sinalId: e.id }, veredicto: e.detalhe.veredicto as VeredictoDoSinal, decidido: decidido(org, e.id) } : null;
    },
    async descartarSinal(org, sinalId, modeloId, por, justificativa, em) { eventoDeModelo(org, modeloId, 'SINAL_DESCARTADO', 'PESSOA', por, { sinalId, justificativa }, em); },
    async sinaisPendentes(org, tipo): Promise<SinalPendente[]> {
      return m.eventosDeModelo
        .filter((e) => e.org === org && e.tipo === 'SINAL_DE_REJEICAO' && e.detalhe.veredicto.tipo === 'VALIDACAO_HUMANA' && !decidido(org, e.id)
          && m.versoes.some((v) => v.modeloId === e.modeloId && v.tipo === tipo && v.estado === 'VALIDADO'))
        .map((e) => ({ sinalId: e.id, modeloId: e.modeloId, motivos: e.detalhe.veredicto.motivos }));
    },

    async documentos(org, masterId, tipo) { return m.documentos.filter((d) => d.org === org && d.masterId === masterId && d.tipo === tipo).map((d) => semInterno(d)); },
    async documento(org, documentoId) {
      const d = m.documentos.find((x) => x.org === org && x.documentoId === documentoId);
      return d ? semInterno(d) : null;
    },
    async gravarDocumento(org, n) {
      const igual = m.documentos.find((d) => d.org === org && d.masterId === n.masterId && d.tipo === n.tipo && d.conteudoSha256 === n.conteudoSha256
        && d.gerador.id === n.gerador.id && d.gerador.versao === n.gerador.versao);
      if (igual) return { documentoId: igual.documentoId, novo: false };
      const documentoId = id('doc');
      const versao = m.versoes.find((v) => v.modeloId === n.modeloId)!;
      m.documentos.push({
        org, documentoId, tipo: n.tipo, masterId: n.masterId, modelo: { modeloId: n.modeloId, versao: versao.versao }, conteudoSha256: n.conteudoSha256, conteudo: n.plano.conteudo,
        arquivoSha256: n.arquivoSha256, gerador: n.gerador, processoIdsNaPreparacao: [...n.plano.processoIds], preparadoEm: n.preparadoEm.toISOString(),
        preparadoPor: n.preparadoPor, signatario: n.signatario, selecoes: n.plano.selecoes, escolhas: n.plano.escolhas, informados: n.plano.informados,
        arquivo: n.arquivo, plano: n.plano,
      });
      return { documentoId, novo: true };
    },
    async arquivoDoDocumento(org, documentoId) { return m.documentos.find((d) => d.org === org && d.documentoId === documentoId)?.arquivo ?? null; },
    async assinaturas(org, ids) { return m.assinaturas.filter((a) => a.org === org && ids.includes(a.documentoId)).map((a) => semInterno(a)); },
    async gravarAssinatura(org, a) {
      const doc = m.documentos.find((d) => d.org === org && d.documentoId === a.documentoId);
      // Mesma regra do banco (DOC-31): arquivo assinado só do termo Evergreen (ciclo completo).
      if (doc?.tipo !== 'TERMO_EVERGREEN') throw new Error('arquivo assinado só do termo Evergreen');
      if (doc?.arquivoSha256 === a.arquivoSha256) return { tipo: 'IGUAL_AO_PREPARADO' };
      // Mesmas regras do banco (DOC-22/23/25): a identidade esperada é a do documento (nunca a de quem anexa) e a cadeia
      // de substituições é linear (o novo arquivo substitui o último; o primeiro não substitui nada).
      if (JSON.stringify(doc?.signatario ?? null) !== JSON.stringify(a.signatarioEsperado)) throw new Error('o signatário esperado não é o representado no documento');
      const doDocumento = m.assinaturas.filter((x) => x.org === org && x.documentoId === a.documentoId);
      const ultima = doDocumento.find((x) => !doDocumento.some((y) => y.substituicao?.de === x.assinaturaId))?.assinaturaId ?? null;
      if (ultima !== (a.substituicao?.de ?? null)) return { tipo: 'SUBSTITUICAO_DESATUALIZADA' };
      if (a.substituicao && !a.substituicao.justificativa.trim()) throw new Error('substituição sem justificativa');
      if (m.assinaturas.some((x) => x.org === org && x.arquivoSha256 === a.arquivoSha256)) return { tipo: 'ARQUIVO_JA_REGISTRADO' };
      const assinaturaId = id('ass');
      m.assinaturas.push({
        org, assinaturaId, documentoId: a.documentoId, arquivoSha256: a.arquivoSha256, registradoPor: a.registradoPor, registradoEm: a.registradoEm.toISOString(),
        verificacao: a.verificacao, signatarioEsperado: a.signatarioEsperado, substituicao: a.substituicao, arquivo: a.arquivo,
      });
      return { tipo: 'GRAVADA', assinaturaId };
    },
    async arquivoDaAssinatura(org, assinaturaId) { return m.assinaturas.find((a) => a.org === org && a.assinaturaId === assinaturaId)?.arquivo ?? null; },
    async conferencias(org, ids) { return m.conferencias.filter((c) => c.org === org && ids.includes(c.documentoId)).map((c) => semInterno(c)); },
    async gravarConferencia(org, c) {
      // Mesmas regras do banco (DOC-20/24): o arquivo conferido é o do registro de assinatura, com a mesma identidade esperada.
      const a = m.assinaturas.find((x) => x.org === org && x.assinaturaId === c.assinaturaId && x.documentoId === c.documentoId && x.arquivoSha256 === c.arquivoSha256);
      if (!a) throw new Error('o arquivo conferido não é o do registro de assinatura');
      if (JSON.stringify(a.signatarioEsperado) !== JSON.stringify(c.signatarioEsperado)) throw new Error('o signatário esperado não é o do arquivo assinado');
      if ((c.resultado === 'NAO_CONFORME') !== (c.constatacao !== null)) throw new Error('constatação só (e sempre) em NAO_CONFORME');
      const conferenciaId = id('conf');
      m.conferencias.push({ ...c, org, conferenciaId, conferidoEm: c.conferidoEm.toISOString() });
      return { conferenciaId };
    },

    async tentativas(org, masterId, fluxo) { return m.tentativas.filter((t) => t.org === org && t.masterId === masterId && t.fluxo === fluxo).map((t) => semInterno(t)); },
    async tentativa(org, envioId) {
      const t = m.tentativas.find((x) => x.org === org && x.envioId === envioId);
      return t ? semInterno(t) : null;
    },
    async eventosDoEnvio(org, envioId) { return m.eventosDoEnvio.filter((e) => e.org === org && e.envioId === envioId).map((e) => semInterno(e)); },
    async abrirTentativa(org, n, por, em) {
      const abertas = m.tentativas.filter((t) => t.org === org && t.masterId === n.masterId && t.fluxo === n.fluxo && !TERMINAIS.includes(t.estado));
      const reenvioRepetido = n.reenvio && m.tentativas.some((t) => t.org === org && t.reenvio?.de === n.reenvio!.de && t.estado !== 'ENVIO_NAO_REALIZADO');
      if (abertas.length || reenvioRepetido) return { tipo: 'CONFLITO' };
      const confirmadas = m.tentativas.filter((t) => t.org === org && t.masterId === n.masterId && t.fluxo === n.fluxo && t.estado === 'ENVIO_CONFIRMADO');
      if (!n.reenvio && confirmadas.length) throw new Error('já há envio confirmado; nova tentativa só como reenvio explícito');
      if (n.reenvio && (!confirmadas.some((t) => t.envioId === n.reenvio!.de) || confirmadas.some((t) => t.reenvio?.de === n.reenvio!.de))) {
        throw new Error('reenvio exige o envio confirmado vigente');
      }
      const envioId = id('envio');
      m.tentativas.push({
        org, envioId, fluxo: n.fluxo, masterId: n.masterId, documentoId: n.documentoId, assinaturaId: n.assinaturaId, modeloId: n.modeloId, chave: n.chaveSha256,
        analista: n.analista, reenvio: n.reenvio, estado: 'PREPARANDO_RASCUNHO', abertoEm: em.toISOString(), atualizadoEm: em.toISOString(), concluidoEm: null,
        composicao: n.composicao, anexos: [], rascunho: null, confirmacao: null, falha: null,
      });
      m.eventosDoEnvio.push({ org, eventoId: id('eve'), envioId, tipo: 'TENTATIVA_ABERTA', estadoAnterior: null, estadoNovo: 'PREPARANDO_RASCUNHO', origem: 'PESSOA', por, em: em.toISOString(), detalhe: {} });
      return { tipo: 'ABERTA', envioId };
    },
    async transicionar(org, envioId, de, para, mud, e, em) {
      const t = m.tentativas.find((x) => x.org === org && x.envioId === envioId);
      if (!t || t.estado !== de) return false;
      t.estado = para;
      t.atualizadoEm = em.toISOString();
      t.concluidoEm = TERMINAIS.includes(para) ? em.toISOString() : null;
      if (mud.rascunho) t.rascunho = mud.rascunho;
      if (mud.anexos) t.anexos = mud.anexos as AnexoDoManifesto[];
      if (mud.confirmacao) t.confirmacao = mud.confirmacao;
      if (mud.falha) t.falha = mud.falha;
      m.eventosDoEnvio.push({ org, eventoId: id('eve'), envioId, tipo: e.tipo, estadoAnterior: de, estadoNovo: para, origem: e.origem, por: e.por, em: em.toISOString(), detalhe: e.detalhe ?? {} });
      return true;
    },
    async registrarEventoDoEnvio(org, envioId, estado, e, em) {
      m.eventosDoEnvio.push({ org, eventoId: id('eve'), envioId, tipo: e.tipo, estadoAnterior: estado, estadoNovo: estado, origem: e.origem, por: e.por, em: em.toISOString(), detalhe: e.detalhe ?? {} });
    },
  };
}

/* ------------------------------------------ fontes ------------------------------------------ */

export interface MundoDeFontes {
  processos: string[];
  valores: ValorObservado[];
  copias: CandidatoCopiaDoMbl[];
  papeis: Record<string, string>;
  contas: Record<string, string>;
  caixas: Record<string, string>;
  modalidade: ModalidadeObservada;
  /** Cadastro(s) SINTÉTICO(S) do signatário legal da organização (DOC-23). */
  signatarios: SignatarioLegal[];
}

export const valor = (dado: string, v: string, fonte: FonteDeDado, escopo: ValorObservado['escopo'], ref = `${dado}:${v}`): ValorObservado => ({
  dado, valor: v, fonte, escopo, evidencia: { fonte: fonte.toLowerCase(), ref }, observadoEm: '2026-10-01T12:00:00.000Z',
});

export const copiaMbl = (p: Partial<CandidatoCopiaDoMbl> = {}): CandidatoCopiaDoMbl => ({
  extracaoId: 'ext-1', caixaId: 'caixa-1', messageId: 'msg-1', attachmentId: 'anexo-1', nome: 'MBL.pdf', contentType: 'application/pdf',
  recebidaEm: '2026-10-01T10:00:00.000Z', ...p,
});

export function fontes(mundo: MundoDeFontes): FontesConfiaveis {
  return {
    processosDoMaster: async () => [...mundo.processos],
    valores: async (_org, _master, _proc, pedidos) => mundo.valores.filter((v) => pedidos.some((p) => p.dado === v.dado && p.fonte === v.fonte)),
    copiasDoMbl: async () => [...mundo.copias],
    papelDaPessoa: async (_org, m) => mundo.papeis[m] ?? null,
    contaMicrosoftDaPessoa: async (_org, m) => mundo.contas[m] ?? null,
    contaDaCaixaMonitorada: async (_org, c) => mundo.caixas[c] ?? null,
    modalidadeDoMaster: async () => mundo.modalidade,
    signatariosLegais: async () => mundo.signatarios.map((x) => ({ ...x })),
  };
}

/**
 * Signatário legal SINTÉTICO da organização dos testes (nenhum dado real: nome fictício, CPF de teste com dígitos
 * válidos). Não é membership: o signatário não precisa ser usuário da Priora (DOC-23).
 */
export const SIGNATARIO_SINTETICO: SignatarioLegal = {
  signatarioId: 'sig-legal-1', nome: 'SIGNATARIO LEGAL SINTETICO', cpf: '52998224725', qualificacao: 'REPRESENTANTE LEGAL (SINTÉTICO)',
  cadastro: { evidencia: { fonte: 'cadastro-sintetico', ref: 'signatario-legal-v1' }, validadoPor: 'm-gestor', validadoEm: '2026-10-01T00:00:00.000Z' },
  poderes: null,
};

/** Comprovação SINTÉTICA dos poderes do signatário (evidência fictícia). */
export const PODERES_SINTETICOS = (signatarioId = SIGNATARIO_SINTETICO.signatarioId, validoAte: string | null = null): ComprovacaoDePoderes => ({
  signatarioId, evidencia: { fonte: 'cadastro-sintetico', ref: 'contrato-social-sintetico' }, registradoPor: 'm-gestor', registradoEm: '2026-10-01T00:00:00.000Z', validoAte,
});

/** O mesmo signatário com os poderes comprovados. */
export const SIGNATARIO_COM_PODERES: SignatarioLegal = { ...SIGNATARIO_SINTETICO, poderes: PODERES_SINTETICOS() };

/** Dados que o Analista teria no próprio cadastro/identidade — NUNCA podem aparecer como dados de quem assina. */
export const DADOS_DOS_ANALISTAS_SINTETICOS = { nomes: ['ANALISTA SINTETICA UM', 'ANALISTA SINTETICO DOIS'], cpfs: ['12345678909', '98765432100'] };

/* ------------------------------------------ Outlook ------------------------------------------ */

interface MensagemFalsa {
  isDraft: boolean; changeKey: string; enviadaEm: string | null; assunto: string; para: string[]; cc: string[];
  anexos: Array<{ nome: string; bytes: Uint8Array }>; internetMessageId: string; conversationId: string;
}

export interface OutlookFalso extends OutlookDoAnalista {
  chamadas: string[];
  caixa: Map<string, MensagemFalsa>;
  ligado: boolean;
  falhar: { criar?: Error; enviar?: Error; ler?: Error };
  /** O pedido de envio é aceito, mas a mensagem ainda não aparece como enviada. */
  envioSemEfeitoImediato: boolean;
  /** Ações do Analista DIRETO no Outlook (fora da Priora). */
  enviarPeloOutlook(id: string): void;
  editarNoOutlook(id: string, mudar?: (m: MensagemFalsa) => void): void;
  apagarNoOutlook(id: string): void;
  /** A mensagem continua na caixa, mas com outro id (ex.: movida para outra caixa/pasta que muda o id). */
  trocarIdNoOutlook(id: string, novoId: string): void;
}

/** MOCK identificado do Outlook do Analista: nada sai da memória do teste. */
export function outlookFalso(membershipId = 'm-analista', contaMicrosoft = 'conta-analista', agora: () => Date = () => new Date('2026-10-14T15:00:00.000Z')): OutlookFalso {
  let n = 0;
  const caixa = new Map<string, MensagemFalsa>();
  const enviar = (id: string) => {
    const msg = caixa.get(id)!;
    msg.isDraft = false;
    msg.enviadaEm = agora().toISOString();
    msg.changeKey = `ck-enviado-${id}`;
  };
  const observar = (msg: MensagemFalsa | undefined): ObservacaoDaMensagem => {
    if (!msg) return { tipo: 'NAO_ENCONTRADA' };
    if (msg.isDraft) return { tipo: 'RASCUNHO', changeKey: msg.changeKey };
    return {
      tipo: 'ENVIADA', enviadaEm: msg.enviadaEm!, internetMessageId: msg.internetMessageId, conversationId: msg.conversationId, assunto: msg.assunto,
      para: msg.para, cc: msg.cc, anexos: msg.anexos.map((a) => ({ nome: a.nome, sha256: sha256(a.bytes), tamanho: a.bytes.length })),
    };
  };
  const o: OutlookFalso = {
    membershipId, contaMicrosoft, chamadas: [], caixa, ligado: true, falhar: {}, envioSemEfeitoImediato: false,
    escritaHabilitada: () => o.ligado,
    async criarRascunho(m) {
      o.chamadas.push('criarRascunho');
      if (o.falhar.criar) throw o.falhar.criar;
      const id = `rascunho-${++n}`;
      caixa.set(id, {
        isDraft: true, changeKey: `ck-${id}-1`, enviadaEm: null, assunto: m.assunto, para: [...m.para], cc: [...m.cc],
        anexos: m.anexos.map((a) => ({ nome: a.nome, bytes: a.bytes })), internetMessageId: `<${id}@teste>`, conversationId: `conv-${id}`,
      });
      return { id, internetMessageId: `<${id}@teste>`, conversationId: `conv-${id}`, changeKey: `ck-${id}-1` };
    },
    async lerMensagem(id): Promise<ObservacaoDaMensagem> {
      o.chamadas.push('lerMensagem');
      if (o.falhar.ler) throw o.falhar.ler;
      return observar(caixa.get(id));
    },
    async buscarPorInternetMessageId(imid): Promise<ObservacaoDaMensagem> {
      o.chamadas.push('buscarPorInternetMessageId');
      if (o.falhar.ler) throw o.falhar.ler;
      const achadas = [...caixa.values()].filter((m) => m.internetMessageId === imid);
      return observar(achadas.find((m) => !m.isDraft) ?? achadas[0]);
    },
    async enviarRascunho(id) {
      o.chamadas.push('enviarRascunho');
      if (o.falhar.enviar) throw o.falhar.enviar;
      if (!caixa.get(id)?.isDraft) throw new FalhaAntesDoEnvio('RECUSADO_PELO_GRAPH_404');
      if (!o.envioSemEfeitoImediato) enviar(id);
    },
    async descartarRascunho(id) {
      o.chamadas.push('descartarRascunho');
      caixa.delete(id);
    },
    enviarPeloOutlook: (id) => enviar(id),
    editarNoOutlook: (id, mudar) => {
      const msg = caixa.get(id)!;
      mudar?.(msg);
      msg.changeKey = `${msg.changeKey}+`;
    },
    apagarNoOutlook: (id) => { caixa.delete(id); },
    trocarIdNoOutlook: (id, novoId) => {
      const msg = caixa.get(id)!;
      caixa.delete(id);
      caixa.set(novoId, msg);
    },
  };
  return o;
}

export interface CaixaMonitoradaFalsa extends CaixaMonitorada {
  anexos: Record<string, { nome: string; contentType: string; bytes: Uint8Array }>;
  leituras: number;
}

export const MBL_BYTES = pdf('MBL ORIGINAL DO AGENTE');

export function caixaMonitoradaFalsa(caixaId = 'caixa-1'): CaixaMonitoradaFalsa {
  const c: CaixaMonitoradaFalsa = {
    caixaId, leituras: 0,
    anexos: { 'msg-1|anexo-1': { nome: 'MBL.pdf', contentType: 'application/pdf', bytes: MBL_BYTES } },
    async lerAnexo(ref) {
      c.leituras++;
      return c.anexos[`${ref.messageId}|${ref.attachmentId}`] ?? null;
    },
  };
  return c;
}

export { FalhaAntesDoEnvio };

/* ------------------------------------------ mundo ------------------------------------------ */

export const ORG = 'org-1';
export const MASTER = 'M1';
export const ANALISTA = 'm-analista';
export const GESTOR = 'm-gestor';
export const OUTRO_ANALISTA = 'm-outro';
/** Terceiro Analista da mesma organização (DOC-22: preparar, anexar, conferir e encaminhar podem ser pessoas diferentes). */
export const TERCEIRO_ANALISTA = 'm-terceiro';
export const CLIENTE = 'm-cliente';
/** Pessoa cuja conta Microsoft vinculada é a própria caixa monitorada (ex.: o ADMIN que conectou a caixa). */
export const DONO_DA_CAIXA = 'm-dono-da-caixa';
export const ATOR = { organizationId: ORG, membershipId: ANALISTA };
export const PERMITIDA = { tipo: 'PERMITIDA' as const, referencia: 'l1b:acao-de-master:M1' };

export const destinatarios = (p: Partial<DestinatariosValidados> = {}): DestinatariosValidados => ({
  agencia: 'GRIEG', para: ['agendamento@agencia.teste'], cc: [], validadoPor: GESTOR, validadoEm: '2026-10-01T00:00:00.000Z',
  evidencia: { fonte: 'configuracao', ref: 'destinatarios-grieg-v1' }, ...p,
});

export interface CenarioDocumental {
  deps: DepsDocumentos;
  repo: ReturnType<typeof repositorioEmMemoria>;
  mundo: MundoDeFontes;
  relogio: ReturnType<typeof relogio>;
  outlook: OutlookFalso;
  caixa: CaixaMonitoradaFalsa;
  modelos: Partial<Record<TipoDocumento, string>>;
}

/**
 * Cenário em memória. As versões sintéticas passam pelo MESMO caminho do
 * serviço (cadastro + validação) usando o repositório: nenhuma versão entra
 * em uso sem estar VALIDADA.
 */
export async function cenarioDocumental(p: {
  armador?: ArmadorDoMaster | null; defs?: Partial<Record<TipoDocumento, DefinicaoDoModelo>>; valores?: ValorObservado[]; copias?: CandidatoCopiaDoMbl[];
  destinatarios?: DestinatariosValidados | null; gerador?: GeradorDePdf | null; processos?: string[]; modalidade?: ModalidadeObservada; validar?: boolean;
  remetentesConfiaveis?: RemetentesConfiaveisDaAgencia | null; arquivos?: Partial<Record<TipoDocumento, Uint8Array>>; idsUuid?: boolean;
  signatarios?: SignatarioLegal[];
} = {}): Promise<CenarioDocumental> {
  const repo = repositorioEmMemoria({ idsUuid: p.idsUuid });
  const mundo: MundoDeFontes = {
    processos: p.processos ?? ['IM100'],
    valores: p.valores ?? [
      valor('MBL', 'EGLVTESTE0001', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER }),
      valor('NOME_DO_NAVIO', 'NAVIO TESTE', 'S3_VIAGEM', { tipo: 'MASTER', masterId: MASTER }),
    ],
    copias: p.copias ?? [copiaMbl()],
    papeis: { [ANALISTA]: 'ANALYST', [GESTOR]: 'MANAGER', [OUTRO_ANALISTA]: 'ANALYST', [TERCEIRO_ANALISTA]: 'ANALYST', [CLIENTE]: 'CLIENT', [DONO_DA_CAIXA]: 'ADMIN' },
    contas: {
      [ANALISTA]: 'conta-analista', [GESTOR]: 'conta-gestor', [OUTRO_ANALISTA]: 'conta-outro', [TERCEIRO_ANALISTA]: 'conta-terceiro', [DONO_DA_CAIXA]: 'conta-clara',
    },
    caixas: { 'caixa-1': 'conta-clara' },
    modalidade: p.modalidade ?? { tipo: 'DESCONHECIDA' },
    signatarios: p.signatarios ?? [SIGNATARIO_SINTETICO],
  };
  const r = relogio();
  const defs = p.defs ?? { TERMO_EVERGREEN: definicaoEvergreen() };
  const modelos: Partial<Record<TipoDocumento, string>> = {};
  for (const [tipo, def] of Object.entries(defs) as Array<[TipoDocumento, DefinicaoDoModelo]>) {
    const arquivo = p.arquivos?.[tipo] ?? arquivoSintetico(tipo);
    const { modeloId } = await repo.cadastrarVersao(ORG, {
      tipo, versao: 'sintetica-1', arquivo, arquivoSha256: sha256(arquivo), definicao: def, origem: { tipo: 'CADASTRO', por: ANALISTA }, em: r.agora(),
    });
    if (p.validar !== false) await repo.mudarEstadoDoModelo(ORG, modeloId, 'PENDENTE_DE_VALIDACAO', 'VALIDADO', { tipo: 'MODELO_VALIDADO', origem: 'PESSOA', por: GESTOR }, r.agora());
    modelos[tipo] = modeloId;
  }
  return {
    repo, mundo, relogio: r, outlook: outlookFalso(ANALISTA, 'conta-analista', () => r.agora()), caixa: caixaMonitoradaFalsa(), modelos,
    deps: {
      repo, fontes: fontes(mundo), armador: { armadorDoMaster: async () => (p.armador === undefined ? { masterId: MASTER, codigo: 'EVERGREEN' } : p.armador) },
      gerador: p.gerador === undefined ? GERADOR_DE_TESTE : p.gerador,
      destinatarios: {
        daAgencia: async () => (p.destinatarios === undefined ? destinatarios() : p.destinatarios),
        remetentesConfiaveis: async () => p.remetentesConfiaveis ?? null,
      },
      relogio: r,
    },
  };
}
