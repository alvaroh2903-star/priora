import {
  BlocoFixo, CampoVariavel, DefinicaoDoModelo, FonteDeDado, FonteDoDesenho, GrupoDeOpcoes, LayoutDoModelo, LugarDoCampo, MarcaDaAlternativa, Retangulo,
  TipoDocumento,
} from './modelos';
import { DADO_SIGNATARIO_CPF, DADO_SIGNATARIO_NOME } from './signatario';

/**
 * Definições PROPOSTAS dos quatro modelos oficiais, lidas dos arquivos
 * recebidos do produto (exemplos PREENCHIDOS exportados do Word, sem campos de
 * formulário). Nada aqui vale sozinho: cada definição só entra em uso depois
 * de cadastrada com o arquivo oficial correspondente (o hash abaixo) e
 * VALIDADA por uma pessoa (`validarModelo`).
 *
 *  - Coordenadas: espaço da página do PDF, em pontos, origem embaixo à esquerda;
 *    medidas a partir dos operadores de conteúdo de cada arquivo.
 *  - `limpeza`: onde o exemplo tem dados (BL, contêiner, navio, datas, nomes,
 *    CPF/CNPJ, e-mails, telefone, marcação de opção). O gerador remove esses
 *    trechos sem deslocar o texto fixo; nenhum dado do exemplo é copiado.
 *  - Texto jurídico, tabelas e estrutura: reproduzidos do arquivo como estão;
 *    os blocos abaixo são o texto que o documento gerado TEM de conter.
 *  - Fontes dos dados: só donos confiáveis. Dados sem fonte integrada hoje
 *    (navio/viagem, contêineres e consignatário do MBL; cadastro da organização;
 *    cadastro do signatário legal) ficam FALTANDO e bloqueiam a geração — nada é inventado.
 *  - Quem assina (DOC-23): o SIGNATÁRIO LEGAL (representante legal) da
 *    organização, com nome e CPF do cadastro confiável e validado DELE (fonte
 *    `CADASTRO_DO_SIGNATARIO_LEGAL`, escopo SIGNATARIO) — nunca os dados do
 *    Analista que prepara, anexa, confere ou encaminha, nem a conta Microsoft.
 *    A assinatura digital é aplicada fora da Priora, no leitor de PDF, com o
 *    certificado do signatário (procedimento corporativo). Onde o texto do
 *    modelo põe quem assina como representante da empresa, a definição declara
 *    a exigência de poderes; a Priora só a cobra no ciclo completo (termo
 *    Evergreen). MSC, Hapag-Lloyd e ZIM (DOC-31) terminam no PDF gerado: o
 *    Analista assina e encaminha fora da Priora, que não recebe o assinado.
 *  - `marcadoresDoExemplo`: identificadores NÃO pessoais do exemplo (BL,
 *    contêiner, navio, datas, empresa) para provar que nada passa. Nome, CPF e
 *    e-mail de pessoas do exemplo nunca ficam no código: o teste os obtém do
 *    próprio arquivo oficial (o que a limpeza remove) na hora de conferir.
 *  - Contêineres do termo Evergreen (DOC-27): lista do MBL, um por linha, sem
 *    repetição. Até 6 cabem no quadro do modelo; acima disso, o quadro recebe a
 *    remissão e todos os contêineres vão numa relação em páginas adicionais ao
 *    final do mesmo PDF (extensão proposta pela Priora, pendente de aceite da agência).
 *  - Exportador/Importador (Hapag-Lloyd e ZIM, DOC-17): o consignatário do MBL
 *    do Master, por regra ESPECÍFICA desses modelos — não há equivalência global.
 *  - Seleção dos serviços (DOC-18): MSC, exatamente uma ("Preencher com X apenas
 *    a opção desejada"); Hapag-Lloyd e ZIM, uma ou mais ("solicito os serviços
 *    listados abaixo" — o modelo não manda escolher só uma). Nenhuma regra
 *    automática (não há regra operacional aprovada): o Analista escolhe.
 *  - Agendamento e local (DOC-19): nenhuma fonte do sistema produz esses dados
 *    hoje; o Analista informa (com autor, instante e proveniência). Quando uma
 *    fonte confiável existir, ela entra na definição e o informado nunca a sobrepõe.
 *  - Placeholders de preenchimento do Word (Hapag: "Clique ou toque aqui para
 *    inserir o texto.") saem do documento; o quadro e a área de protocolo da
 *    Rochamar ficam como estão.
 */

/** Dados operacionais usados pelos modelos. */
export const DADOS_DOS_MODELOS = {
  MBL: 'MBL',
  DATA_DA_GERACAO: 'DATA_DA_GERACAO',
  NAVIO_E_VIAGEM: 'NAVIO_E_VIAGEM',
  CONTEINERES_DO_MASTER: 'CONTEINERES_DO_MASTER',
  /** Consignatário do MBL: razão social. */
  CONSIGNATARIO_RAZAO_SOCIAL: 'CONSIGNATARIO_RAZAO_SOCIAL',
  /** Consignatário do MBL: razão social, CNPJ e endereço, uma informação por linha. */
  CONSIGNATARIO_QUALIFICACAO: 'CONSIGNATARIO_QUALIFICACAO',
  ORGANIZACAO_RAZAO_SOCIAL: 'ORGANIZACAO_RAZAO_SOCIAL',
  ORGANIZACAO_CNPJ: 'ORGANIZACAO_CNPJ',
  ORGANIZACAO_ENDERECO: 'ORGANIZACAO_ENDERECO',
  ORGANIZACAO_TELEFONE: 'ORGANIZACAO_TELEFONE',
  /** Nome civil do signatário legal (cadastro confiável dele — DOC-23). */
  SIGNATARIO_NOME: DADO_SIGNATARIO_NOME,
  /** CPF do signatário legal (cadastro confiável dele — DOC-23). */
  SIGNATARIO_CPF: DADO_SIGNATARIO_CPF,
  CONTATO_SOBREESTADIA_NOME: 'CONTATO_SOBREESTADIA_NOME',
  CONTATO_SOBREESTADIA_EMAIL: 'CONTATO_SOBREESTADIA_EMAIL',
  EMAILS_PARA_RECIBO: 'EMAILS_PARA_RECIBO',
  AGENDAMENTO_DATA: 'AGENDAMENTO_DATA',
  AGENDAMENTO_HORA: 'AGENDAMENTO_HORA',
  LOCAL_DE_RETIRADA_OU_ENTREGA: 'LOCAL_DE_RETIRADA_OU_ENTREGA',
} as const;

const D = DADOS_DOS_MODELOS;

/** Arquivo oficial recebido para cada tipo (o cadastro da versão exige exatamente estes bytes). */
export interface ArquivoOficialRecebido {
  tipo: TipoDocumento;
  nomeRecebido: string;
  sha256: string;
  paginas: number;
}

export const ARQUIVOS_OFICIAIS_RECEBIDOS: Readonly<Record<TipoDocumento, ArquivoOficialRecebido>> = {
  TERMO_EVERGREEN: {
    tipo: 'TERMO_EVERGREEN', nomeRecebido: 'EVERGREEN_TERMO_EGLV102600060211.pdf', paginas: 3,
    sha256: 'c6164262d564f428df610b736006bc9ac3c175ea20f0814ff8f4974b0f262f9f',
  },
  MEMORANDO_MSC: {
    tipo: 'MEMORANDO_MSC', nomeRecebido: 'Memorando_-_MSC_LIBERAA__A__O_1_-_Copia.pdf', paginas: 1,
    sha256: 'a000db4b91f76993530118b10a48c078fc42fd1c2bd7ad380215a6a8fa6f34f0',
  },
  MEMORANDO_HAPAG_ROCHAMAR: {
    tipo: 'MEMORANDO_HAPAG_ROCHAMAR', nomeRecebido: 'MEMORANDO_HAPAG_-_IM1879att.pdf', paginas: 1,
    sha256: '12d3b1bfbed6cf4ebd5aa927897336184d6d0992e4cd9c90f9a19071dc578b14',
  },
  MEMORANDO_ZIM_ROCHAMAR: {
    tipo: 'MEMORANDO_ZIM_ROCHAMAR', nomeRecebido: 'MEMO_PADRAO_ZIM-ROCHAMAR_ZIMUXIA8574637_.pdf', paginas: 1,
    sha256: 'acbf83746b22f9bf2a6d5d11b5006ce52c964a00530c5f0da67e2c1f0004525d',
  },
};

/* ------------------------------------------------ apoio ------------------------------------------------ */

const campo = (id: string, rotulo: string, dado: string, fontesAceitas: FonteDeDado[], escopo: CampoVariavel['escopo'], obrigatorio = true): CampoVariavel =>
  ({ id, rotulo, dado, obrigatorio, fontesAceitas, escopo });

const lugar = (pagina: number, x: number, y: number, fonte: FonteDoDesenho, tamanho: number, larguraMaxima: number, p: Partial<LugarDoCampo> = {}): LugarDoCampo => ({
  pagina, x, y, fonte, tamanho, tamanhoMinimo: tamanho, larguraMaxima, linhasMaximas: 1, entrelinha: tamanho * 1.15, formato: 'TEXTO', prefixo: '', sufixo: '', ...p,
});

const area = (x: number, y: number, largura: number, altura: number): Retangulo => ({ x, y, largura, altura });

/** Caixa ☐ do MS Gothic a 11,04 pt: 8,16 × 8,16 pt, 1,32 pt à direita da origem do glifo (medida na renderização). */
const caixaDoGlifo = (pagina: number, x: number, y: number): MarcaDaAlternativa => ({ tipo: 'CAIXA', pagina, caixa: area(x + 1.32, y, 8.16, 8.16) });
/** Área de limpeza do glifo ☐/☒ (e de imagem que o exemplo pôs por cima dele). */
const areaDoGlifo = (x: number, y: number) => area(x - 3.5, y - 4, 15, 13);

const ASSINATURA = {
  id: 'ASSINATURA_DO_SIGNATARIO_LEGAL',
  rotulo: 'Assinatura digital do signatário legal (aplicada fora da Priora, no leitor de PDF, com o certificado dele; a Priora não assina)',
};

const FONTES_DO_MBL: FonteDeDado[] = ['S2_AUDITORIA'];
const FONTES_DA_VIAGEM: FonteDeDado[] = ['S3_VIAGEM', 'S2_AUDITORIA'];
const CADASTRO: FonteDeDado[] = ['CADASTRO_DA_ORGANIZACAO'];
/** DOC-23: dados do signatário legal, só do cadastro confiável dele. */
const DO_SIGNATARIO_LEGAL: FonteDeDado[] = ['CADASTRO_DO_SIGNATARIO_LEGAL'];
/** DOC-19: nenhuma fonte do sistema produz hoje agendamento nem local; o Analista informa. */
const INFORMADO_PELO_ANALISTA: FonteDeDado[] = ['ANALISTA'];

/* ----------------------------------------- Termo Evergreen (Grieg) ----------------------------------------- */

const PAGINA_EVERGREEN = { largura: 596.52, altura: 842.52 };

const layoutEvergreen: LayoutDoModelo = {
  paginas: [PAGINA_EVERGREEN, PAGINA_EVERGREEN, PAGINA_EVERGREEN],
  limpeza: [
    { pagina: 1, area: area(27, 657, 135, 12), motivo: 'data do exemplo' },
    { pagina: 1, area: area(60, 557, 420, 11), motivo: 'navio e viagem do exemplo' },
    { pagina: 1, area: area(30, 444, 158, 71), motivo: 'BL do exemplo' },
    { pagina: 1, area: area(190, 444, 168, 71), motivo: 'contêiner do exemplo' },
    { pagina: 1, area: area(195, 504.5, 80, 2.5), motivo: 'sublinhado do link do contêiner do exemplo', removerTracos: true },
    { pagina: 1, area: area(360, 444, 205, 71), motivo: 'consignatário do exemplo' },
    { pagina: 3, area: area(27, 638, 540, 11), motivo: 'empresa do exemplo' },
    { pagina: 3, area: area(109, 627.5, 460, 10), motivo: 'endereço do exemplo' },
    { pagina: 3, area: area(254, 617, 310, 10), motivo: 'contato de demurrage do exemplo' },
    { pagina: 3, area: area(122, 607, 440, 9.5), motivo: 'e-mail do exemplo' },
    { pagina: 3, area: area(160, 596.5, 400, 9.5), motivo: 'e-mails de recibo do exemplo' },
    { pagina: 3, area: area(159, 597, 280, 1.5), motivo: 'sublinhado dos links de e-mail do exemplo', removerTracos: true },
    { pagina: 3, area: area(27, 531.5, 135, 11), motivo: 'data do exemplo' },
    { pagina: 3, area: area(27, 452, 250, 10), motivo: 'signatário do exemplo' },
    { pagina: 3, area: area(285, 452, 280, 10), motivo: 'empresa signatária do exemplo' },
  ],
  campos: {
    DATA_DO_TERMO: lugar(1, 28.1, 660.1, 'TIMES', 9.96, 300, { formato: 'DATA_POR_EXTENSO', prefixo: 'Itajaí, ', sufixo: '.' }),
    NAVIO: lugar(1, 61.1, 559.8, 'HELVETICA_NEGRITO', 9, 480, { tamanhoMinimo: 7 }),
    BL: lugar(1, 33.7, 507.2, 'TIMES_NEGRITO', 9, 150, { tamanhoMinimo: 7 }),
    CONTEINERES: lugar(1, 196.3, 507.3, 'TIMES_NEGRITO', 9, 155, { tamanhoMinimo: 7, linhasMaximas: 6, entrelinha: 10.4, formato: 'LISTA' }),
    CONSIGNATARIO: lugar(1, 362.7, 507.3, 'TIMES_NEGRITO', 9, 195, { tamanhoMinimo: 7, linhasMaximas: 6, entrelinha: 10.4 }),
    EMPRESA_DAS_FATURAS: lugar(3, 28.1, 641.0, 'HELVETICA', 9, 535, { prefixo: 'Empresa: ' }),
    ENDERECO_DAS_FATURAS: lugar(3, 109.7, 630.3, 'HELVETICA', 9, 455, { tamanhoMinimo: 7 }),
    CONTATO_SOBREESTADIA: lugar(3, 255.1, 619.8, 'HELVETICA', 9, 305),
    EMAIL_DO_RESPONSAVEL: lugar(3, 122.2, 609.5, 'HELVETICA', 9, 440),
    EMAILS_PARA_RECIBO: lugar(3, 160.5, 599.0, 'HELVETICA', 9, 400, { tamanhoMinimo: 7 }),
    DATA_DA_ASSINATURA: lugar(3, 28.1, 534.4, 'HELVETICA', 9, 300, { formato: 'DATA_POR_EXTENSO', prefixo: 'Itajaí, ', sufixo: '.' }),
    // Nome civil completo pode ser longo: reduz até 7 pt antes da coluna da empresa (x = 285); além disso, recusa.
    SIGNATARIO: lugar(3, 29.0, 455.2, 'HELVETICA', 9, 245, { tamanhoMinimo: 7 }),
    EMPRESA_SIGNATARIA: lugar(3, 288.9, 455.2, 'HELVETICA', 9, 275, { tamanhoMinimo: 7 }),
  },
  opcoes: {},
  assinatura: { pagina: 3, area: area(28, 466, 535, 58) },
  // DOC-27: acima de 6 contêineres, o quadro recebe a remissão e a relação completa vai em páginas ao final (4, 5, ...).
  relacaoAnexa: {
    campo: 'CONTEINERES', maximoNoLugar: 6, itensPorPagina: 25, titulo: 'RELAÇÃO DE CONTÊINERES',
    vinculo: 'Anexo ao TERMO DE RESPONSABILIDADE PARA RETORNO DE CONTAINER(S) VAZIO(S) AO PORTO DE DESCARGA (Evergreen), parte integrante do mesmo documento.',
    identificacao: [{ campo: 'BL', rotulo: 'BL (Master)' }, { campo: 'DATA_DO_TERMO', rotulo: 'Data do termo' }],
    item: 'CONTÊINER', itens: 'CONTÊINERES',
    aceiteDaAgencia: { estado: 'PENDENTE_DE_ACEITE_DA_AGENCIA' },
  },
};

const definicaoTermoEvergreen: DefinicaoDoModelo = {
  tipo: 'TERMO_EVERGREEN',
  campos: [
    campo('DATA_DO_TERMO', 'Data (cabeçalho)', D.DATA_DA_GERACAO, ['GERACAO'], 'DOCUMENTO'),
    campo('NAVIO', 'Navio e viagem', D.NAVIO_E_VIAGEM, FONTES_DA_VIAGEM, 'MASTER'),
    campo('BL', 'BL (Master)', D.MBL, ['S6_MASTER'], 'MASTER'),
    campo('CONTEINERES', 'Contêiner(es) do Master', D.CONTEINERES_DO_MASTER, FONTES_DO_MBL, 'MASTER'),
    campo('CONSIGNATARIO', 'Consignatário (razão social, CNPJ e endereço)', D.CONSIGNATARIO_QUALIFICACAO, FONTES_DO_MBL, 'MASTER'),
    campo('EMPRESA_DAS_FATURAS', 'Empresa para as faturas de demurrage', D.ORGANIZACAO_RAZAO_SOCIAL, CADASTRO, 'DOCUMENTO'),
    campo('ENDERECO_DAS_FATURAS', 'Endereço completo', D.ORGANIZACAO_ENDERECO, CADASTRO, 'DOCUMENTO'),
    campo('CONTATO_SOBREESTADIA', 'Pessoa de contato do setor de demurrage', D.CONTATO_SOBREESTADIA_NOME, CADASTRO, 'DOCUMENTO'),
    campo('EMAIL_DO_RESPONSAVEL', 'E-mail do responsável', D.CONTATO_SOBREESTADIA_EMAIL, CADASTRO, 'DOCUMENTO'),
    campo('EMAILS_PARA_RECIBO', 'E-mail(s) para o recibo', D.EMAILS_PARA_RECIBO, CADASTRO, 'DOCUMENTO'),
    campo('DATA_DA_ASSINATURA', 'Data (assinatura)', D.DATA_DA_GERACAO, ['GERACAO'], 'DOCUMENTO'),
    campo('SIGNATARIO', 'Nome de quem assina (o signatário legal)', D.SIGNATARIO_NOME, DO_SIGNATARIO_LEGAL, 'SIGNATARIO'),
    campo('EMPRESA_SIGNATARIA', 'Empresa que assina', D.ORGANIZACAO_RAZAO_SOCIAL, CADASTRO, 'DOCUMENTO'),
  ],
  blocosFixos: [
    { id: "TIMBRE", natureza: "ESTRUTURA", texto: "Rua Manoel Dono Morgado, 48 – Sala 101A CEP: 88.301-462 Itajai – SC – Brasil" },
    { id: "DESTINATARIO", natureza: "ESTRUTURA", texto: "À EVERGREENLINE E/OU O ARMADOR, PREPOSTO OU AGENTES EM ITAJAÍ. PREZADOS SENHORES," },
    { id: "TITULO", natureza: "ESTRUTURA", texto: "TERMO DE RESPONSABILIDADE PARA RETORNO DE CONTAINER(S) VAZIO(S) AO PORTO DEDESCARGA" },
    { id: "CABECALHO_DA_TABELA", natureza: "ESTRUTURA", texto: "BL: número do bl(s): CNTRS: número(s) do(s) container(s): Consignatário: (Razão Social, Endereço, CNPJ)" },
    { id: "CLAUSULA_COMPROMISSO", natureza: "TEXTO_JURIDICO", texto: "Pelo presente instrumento e nos melhores termos de direito, COMPROMETEMO-NOS, na qualidade de CONSIGNATÁRIO(S), e/ou IMPORTADOR(ES) e/ou AGENTES, e/ou TRANSITÁRIOS DOS PROPRIETÁRIOS (agentes desconsolidadores de carga) e/ou REPRESENTANTE(S) LEGAL(IS) DO(S) DESTINATÁRIO(S) DO(S) CONTAINER(S) ACIMA RELACIONADO(S), a efetuar a devolução do(s) mesmo(s) limpo(s) e/ou lavado(s), (entende-se como limpo(s) e/ou lavado(s), a(s) unidade(s) sem resíduos da carga transportada), e em perfeitas condições para receber cargas, no prazo avençado, reiterando-se os termos e condições do conhecimento de transporte marítimo, esclarecendo ainda o que segue :" },
    { id: "CLAUSULA_LOCAL_DE_ENTREGA", natureza: "TEXTO_JURIDICO", texto: "Assumimos, outrossim, o compromisso de entregar o(s) container(s) em local a ser indicado pelos agentes do navio, após nosso pedido de tal informação, e ainda os custos relativos ao reposicionamento e remoção do(s) container(s) colocado(s) à disposição, inclusive, caso seja constatado a entrega em local diverso do estabelecido." },
    { id: "CLAUSULA_RESPONSABILIDADE_INTEGRAL", natureza: "TEXTO_JURIDICO", texto: "Estamos cientes que serão por nossa conta a responsabilidade integral por quaisquer despesas provenientes de avarias, perdas, limpeza e conservação da(s) unidade(s) de carga, necessárias após o momento da retirada do(s) equipamento(s), independentemente do exercício de eventual direito de regresso." },
    { id: "CLAUSULA_AVARIAS", natureza: "TEXTO_JURIDICO", texto: "Caso se verifique qual(is)quer avaria(s) na(s) unidades em questão no momento da retirada da zona primária, Terminal onde se encontra depositado, providenciaremos imediatamente notificação por escrito a V.Sas, (c/c: ao departamento de containers dos agentes de V.Sas, no Porto de Santos), informando inclusive a data da retirada do(s) mesmo(s), bem como avarias(s) nele(s) preexistente(s) caso haja. Na ausência de tal notificação, comprometemo-nos pelo presente a indenizá-los e/ou seus(s) Principais por todos os reparos efetuados, bem como as perdas e custos financeiros (inclusive reclamações de clientes ou seus representantes legais) advindas de tal(is) avarias(s) que o(s) containers(s) porventura venha(m) a sofrer durante o período que permaneceu sob nossa custódia." },
    { id: "CLAUSULA_SOBREESTADIAS", natureza: "TEXTO_JURIDICO", texto: "Assumimos todas as despesas relativas às Sobreestadias do(s) Container(s), calculada(s) por dia, até a efetiva entrega da(s) unidade(s) vazia(s), na hipótese do(s) container(s) ser(em) devolvido(s) após o prazo livre padrão (05 ou 07 dias), cujo valor final poderá ser descontado do depósito exigível em reais (R$1.000,00/20, R$2.000,00/40, ou R$3.000,00/ REEFER) (não passível de correção monetária), caso o mesmo seja efetuado através de comprovação por recibo, juntamente com eventuais despesas com conserto ou limpeza dos containers sob a responsabilidade dos donos da carga." },
    { id: "CLAUSULA_FRANQUIA", natureza: "TEXTO_JURIDICO", texto: "Estamos cientes de que o período de franquia (“dias livres” / free time) ajustado, inicia-se na data da efetiva descarga da(s) unidade(s) do navio no porto brasileiro de destino indicado no B/L, e que as “DEMURRAGES” serão cobradas com base na TARIFA DE SOBREESTADIAS abaixo descriminada." },
    { id: "TABELA_DE_SOBREESTADIAS", natureza: "TABELA_TARIFARIA", texto: "VALORES EXPRESSOS EM USD POR CADA DIA ULTRAPASSAD DIAS LIVRES PERIODO EM DIAS B O X FLAT RACK HIGH CUBE M A F I OPEN TOP REEFER / N.O.R. 20' 40' 20' 40' 20' 40' 20' 40' 20' 40' 20' 40' 07 Dias Corridos 08º ao 20º dia USD 50.00 USD 90.00 USD 45.00 USD 95.00 USD 90.00 USD 45.00 USD 95.00 21º dia até a devolução USD 65.00 USD 130.00 USD 50.00 USD 110.00 USD 130.00 USD 50.00 USD 110.00 05 Dias Corridos 06º ao 09º dia USD 180.00 10º dia até a devolução USD 245.00" },
    { id: "NOTAS_DA_TABELA_DE_SOBREESTADIAS", natureza: "TABELA_TARIFARIA", texto: "TARIFA DE SOBREESTADIAS DE CONTAINERS OS DIAS RELACIONADOS CORRESPONDEM AOS DIAS DE ATRASO (DESCONTANDO-SE O PERÍODO LIVRE) OS VALORES ACIMA FORAM APLICADOS COM BASE NA TARIFA DE SOBREESTADIA DO(S) ARMADOR(ES) OBS: CASO SEJA NEGOCIADO UM PERÍODO SUPERIOR A 05 OU 07 DIAS LIVRES (FREE TIME PADRÃO) PARA DEVOLUÇÃO DA(S) UNIDADE(S) DE CARGA APÓS O DESEMBARQUE, SERÁ CONSIDERADO PARA CÁLCULO DA DEMURRAGE O SEGUNDO PERÍODO DA TABELA DE TARIFA DE SOBREESTADIAS DE CONTAINERS." },
    { id: "CLAUSULA_PERDA_TOTAL", natureza: "TEXTO_JURIDICO", texto: "Na hipótese de ocorrência de perda total do(s) container(s), quer seja por avarias, roubo, furto, ou quaisquer outras causas, deveremos arcar com a indenização relativa ao(s) mesmo(s), sem prejuízo da aplicação da tarifa de sobrestadia (demurrage), cujo tempo de contagem somente cessará no dia do pagamento da mencionada indenização, a qual nos comprometemos a efetuar no prazo máximo de 15 (quinze) dias úteis a contar da data de recebimento da respectiva Nota de Sobreestadia de Container emitida por V.Sas. Manifestamos nossa concordância com as bases propugnadas por V.Sas para as devidas indenizações, como segue:" },
    { id: "TABELA_DE_INDENIZACOES", natureza: "TABELA_TARIFARIA", texto: "1. US$ 3,300.00 Dry Cargo/20’ 2. US$ 5,300.00 Dry Cargo/40’ 3. US$ 5,600.00 High Cube40’ 4. US$ 4,500.00 Full High Open Top/20’ 5. US$ 7,400.00 Full High Open Top/40’ 6. US$ 7,000.00 Flat Rack/20’ 7. US$ 9,900.00 Flat Rack/40’ and Platform/40’ 8. US$ 25,000.00 Reefer/20’ 9. US$ 33,000.00 High Cube Reefer/40’" },
    { id: "CLAUSULA_VALOR_RESIDUAL", natureza: "TEXTO_JURIDICO", texto: "Caso optemos em efetuar o pagamento do valor residual da(s) unidade(s) de carga, com mero intuito de cessar a incidência diária de sobreestadia até a devolução dos container(s), assumimos toda a responsabilidade pela nacionalização do(s) containe r(s), de acordo com as leis e normas da Alfândega brasileira, e a recolher os impostos e tributos devidos por esta nacionalização." },
    { id: "CLAUSULA_NACIONALIZACAO", natureza: "TEXTO_JURIDICO", texto: "Assumimos, também, caso haja qualquer penalidade ou intimação decorrente do procedimento de nacionalização pela Receita Federal do Brasil e/ou qualquer outro órgão público, ou caso não seja concluída esta nacionalização, em indenizar ou reembolsar a Agência de Vapores Grieg S/A. e/ou seus principais pelos prejuízos que lhes forem causados." },
    { id: "CLAUSULA_FATURAS_DO_AGENTE", natureza: "TEXTO_JURIDICO", texto: "O Agente Marítimo encontra-se autorizado pelo armador a emitir faturas de cobrança de demurrage, e que na hipótese de não pagamento em qualquer das circunstâncias, o valor em moeda estrangeira será convertido para moeda nacional ao câmbio da data do efetivo pagamento, nos termos do que dispõe o Decreto 24.038/34 c/c Decreto Lei 857/69." },
    { id: "CLAUSULA_MEDIDAS_LEGAIS", natureza: "TEXTO_JURIDICO", texto: "Na hipótese de serem tomadas as medidas legais para a reposição da(s) unidade(s) em epígrafe, o transportador marítimo e seus agentes ficarão isentos de qualquer responsabilidade pelas avarias supostamente ocorridas no momento da desunitização (desova) das respectivas mercadorias, sendo que todas e quaisquer despesas serão arcadas pelo consignatário/importador." },
    { id: "CLAUSULA_TRANSPORTADOR", natureza: "TEXTO_JURIDICO", texto: "O Transportador Marítimo e seus agentes não serão responsáveis por quaisquer avarias/perda de containers e/ou reboques e/ou outros veículos entre a descarga no destino e reembarque na viagem de volta." },
    { id: "CLAUSULA_NVOCC", natureza: "TEXTO_JURIDICO", texto: "Em se tratando de armadores NVOCC, o(s) seu(s) representante(s) legal(is), que reconhece(m) também, a exatidão deste Termo, não será permitido solicitar, em hipótese alguma, o repasse das responsabilidades aqui assumidas ao Importador Final, e/ou terceiros, mesmo que as mercadorias venham a ser abandonadas pelos mesmos e/ou apreendidas pela Alfândega." },
    { id: "CLAUSULA_FORO", natureza: "TEXTO_JURIDICO", texto: "Fica eleito o FORO da Comarca de Santos, no Estado de São Paulo, para eventuais disputas judiciais que venham a surgir no presente Termo de Responsabilidade." },
    { id: "ENDERECAMENTO_DAS_FATURAS", natureza: "TEXTO_JURIDICO", texto: "Informamos ainda, que todas as faturas de demurrage e/ou avarias nos containers, deverão ser enviadas à:" },
    { id: "CLAUSULA_FINAL", natureza: "TEXTO_JURIDICO", texto: "Finalmente, firmamos o presente Instrumento em caráter irrevogável e irretratável, sendo datilografado em duas vias de igual teor e forma, para que produza todos os seus efeitos legais e de direito. Assinam o presente Termo:" },
  ] as BlocoFixo[],
  opcoes: [],
  regras: [],
  assinatura: ASSINATURA,
  marcadoresDoExemplo: [
    'EGLV102600060211', 'EMCU1748669', 'COSCO SHIPPING ARGENTINA', '011W', '14 de Outubro de 2026', 'ROCKET LOGISTICA', '27.909.874/0001-12',
    '@rocketlogistics.com.br',
  ],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  layout: layoutEvergreen,
  poderesDeRepresentacao: {
    fundamento: 'O termo obriga a empresa em caráter irrevogável e irretratável ("COMPROMETEMO-NOS, na qualidade de CONSIGNATÁRIO(S) ... e/ou '
      + 'REPRESENTANTE(S) LEGAL(IS)"; "Assinam o presente Termo:" com o nome de quem assina e a empresa).',
  },
};

/* -------------------------------------------- Memorando MSC -------------------------------------------- */

/** Caixas do memorando MSC (desenho do modelo, 28,5 × 22,5 pt); o "X" vai na posição do X do exemplo. */
const CAIXAS_MSC: ReadonlyArray<readonly [string, number]> = [
  ['APRESENTACAO_COM_DESBLOQUEIO', 526.13], ['APRESENTACAO_SEM_DESBLOQUEIO', 482.93], ['RETIRADA_SEM_DESBLOQUEIO', 438.18],
  ['RETIRADA_COM_DESBLOQUEIO', 390.98], ['DESBLOQUEIO_SEM_RETIRADA', 348.82],
];

const layoutMsc: LayoutDoModelo = {
  paginas: [{ largura: 595.25, altura: 842 }],
  limpeza: [
    { pagina: 1, area: area(239, 584, 210, 16), motivo: 'data do exemplo' },
    { pagina: 1, area: area(163.9, 276, 370, 13), motivo: 'consignatário do exemplo' },
    { pagina: 1, area: area(114.5, 261, 420, 12.5), motivo: 'navio e viagem do exemplo' },
    { pagina: 1, area: area(116.5, 246.5, 420, 12.5), motivo: 'BL do exemplo' },
    { pagina: 1, area: area(70, 171, 300, 13), motivo: 'nome do signatário do exemplo' },
    { pagina: 1, area: area(97, 158, 250, 11), motivo: 'CPF do exemplo' },
    ...CAIXAS_MSC.map(([, y]) => ({ pagina: 1, area: area(71, y, 30, 23), motivo: 'marcação de opção do exemplo' })),
  ],
  campos: {
    DATA: lugar(1, 240.3, 587.0, 'HELVETICA', 14, 284, { formato: 'DATA_POR_EXTENSO', prefixo: 'Itajaí, ' }),
    CONSIGNATARIO: lugar(1, 164.4, 278.3, 'HELVETICA', 12, 360, { tamanhoMinimo: 8 }),
    NAVIO: lugar(1, 115.0, 263.7, 'HELVETICA', 12, 409, { tamanhoMinimo: 8 }),
    BL: lugar(1, 121.2, 249.1, 'HELVETICA', 12, 400),
    SIGNATARIO: lugar(1, 71.0, 173.7, 'HELVETICA', 12, 300, { tamanhoMinimo: 9 }),
    CPF_DO_SIGNATARIO: lugar(1, 97.8, 160.9, 'HELVETICA', 10, 200, { formato: 'CPF' }),
  },
  opcoes: {
    SERVICO_REQUERIDO: Object.fromEntries(CAIXAS_MSC.map(([id, y]) => [id, { tipo: 'LETRA_X', pagina: 1, x: 71.65 + 8.768, y: y + 9.319, fonte: 'TIMES', tamanho: 14 }])),
  },
  assinatura: { pagina: 1, area: area(71, 190, 200, 52) },
};

const servicoMsc: GrupoDeOpcoes = {
  id: 'SERVICO_REQUERIDO', rotulo: 'Serviço requerido (preencher com X apenas a opção desejada)', selecao: 'EXATAMENTE_UMA', obrigatorio: true, incompativeis: [],
  alternativas: [
    { id: 'APRESENTACAO_COM_DESBLOQUEIO', rotulo: 'Apresentamos uma via original do BL e solicitamos o desbloqueio no SISCARGA do(s) B/L(s) abaixo mediante o pagamento das taxas' },
    { id: 'APRESENTACAO_SEM_DESBLOQUEIO', rotulo: 'Apresentamos uma via original do BL sem solicitação de desbloqueio no SISCARGA - valores pendentes' },
    { id: 'RETIRADA_SEM_DESBLOQUEIO', rotulo: 'Solicitamos a retirada das 3 vias originais do(s) B/L(s) abaixo mencionados sem solicitação de desbloqueio no SISCARGA' },
    { id: 'RETIRADA_COM_DESBLOQUEIO', rotulo: 'Solicitamos a retirada das 3 vias originais dos(s) B/L(s) abaixo mencionados, juntamento com desbloqueio SISCARGA' },
    { id: 'DESBLOQUEIO_SEM_RETIRADA', rotulo: 'Solicitamos o desbloqueio SISCARGA, sem retirada do OBL (instrucao de Telex Release solicitado na origem)' },
  ],
};

const definicaoMemorandoMsc: DefinicaoDoModelo = {
  tipo: 'MEMORANDO_MSC',
  campos: [
    campo('DATA', 'Data', D.DATA_DA_GERACAO, ['GERACAO'], 'DOCUMENTO'),
    campo('CONSIGNATARIO', 'Consignatário', D.CONSIGNATARIO_RAZAO_SOCIAL, FONTES_DO_MBL, 'MASTER'),
    campo('NAVIO', 'Navio e viagem', D.NAVIO_E_VIAGEM, FONTES_DA_VIAGEM, 'MASTER'),
    campo('BL', 'B/L nr. (Master)', D.MBL, ['S6_MASTER'], 'MASTER'),
    campo('SIGNATARIO', 'Nome de quem assina (o signatário legal)', D.SIGNATARIO_NOME, DO_SIGNATARIO_LEGAL, 'SIGNATARIO'),
    campo('CPF_DO_SIGNATARIO', 'CPF de quem assina (o signatário legal)', D.SIGNATARIO_CPF, DO_SIGNATARIO_LEGAL, 'SIGNATARIO'),
  ],
  blocosFixos: [
    { id: "TIMBRE", natureza: "ESTRUTURA", texto: "Rua Manoel Dono Morgado – 48, Sala 101A CEP: 88.301-462 ITAJAI – SC" },
    { id: "TITULO", natureza: "ESTRUTURA", texto: "MEMORANDO – LIBERAÇÃO DE B/L" },
    { id: "INSTRUCAO_DE_PREENCHIMENTO", natureza: "ESTRUTURA", texto: "Serviço requerido: (Preencher com X apenas a opção desejada)." },
    { id: "OPCAO_APRESENTACAO_COM_DESBLOQUEIO", natureza: "ESTRUTURA", texto: "Apresentamos uma via original do BL e solicitamos o desbloqueio no SISCARGA do(s) B/L(s) abaixo mediante o pagamento das taxas:" },
    { id: "OPCAO_APRESENTACAO_SEM_DESBLOQUEIO", natureza: "ESTRUTURA", texto: "Apresentamos uma via original do BL sem solicitação de desbloqueio no SISCARGA - valores pendentes;" },
    { id: "OPCAO_RETIRADA_SEM_DESBLOQUEIO", natureza: "ESTRUTURA", texto: "Solicitamos a retirada das 3 vias originais do(s) B/L(s) abaixo mencionados sem solicitação de desbloqueio no SISCARGA;" },
    { id: "OPCAO_RETIRADA_COM_DESBLOQUEIO", natureza: "ESTRUTURA", texto: "Solicitamos a retirada das 3 vias originais dos(s) B/L(s) abaixo mencionados, juntamento com desbloqueio SISCARGA." },
    { id: "OPCAO_DESBLOQUEIO_SEM_RETIRADA", natureza: "ESTRUTURA", texto: "Solicitamos o desbloqueio SISCARGA, sem retirada do OBL (instrucao de Telex Release solicitado na origem)." },
  ] as BlocoFixo[],
  opcoes: [servicoMsc],
  regras: [],
  assinatura: ASSINATURA,
  marcadoresDoExemplo: ['MEDUXX193980', 'MSC VANCOUVER', 'UA619A', '17 de Junho de 2026', 'ROCKET LOGISTICA'],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  layout: layoutMsc,
  // O memorando MSC só traz a linha de assinatura com nome e CPF: o texto não qualifica quem assina como representante.
  poderesDeRepresentacao: null,
};

/* -------------------------------------- Memorando Hapag-Lloyd (Rochamar) -------------------------------------- */

/** Origens dos glifos ☐/☒ do exemplo Hapag (x, linha de base). */
const GLIFOS_HAPAG: ReadonlyArray<readonly [string, number, number]> = [
  ['APRESENTACAO_PARA_DESBLOQUEIO', 274.8, 470.4], ['RETIRADA_E_DESBLOQUEIO', 209.5, 456.7], ['RETIRADA_DE_BL', 217.9, 441.8],
  ['DEVOLUCAO_E_SEA_WAYBILL', 310.8, 427.5], ['SOMENTE_DEVOLUCAO', 433.2, 470.4], ['DEVOLUCAO_E_TROCA_DE_BL', 454.3, 456.1],
];

const layoutHapag: LayoutDoModelo = {
  paginas: [{ largura: 594.96, altura: 842.04 }],
  limpeza: [
    { pagina: 1, area: area(205.5, 706.5, 300, 13), motivo: 'exportador/importador do exemplo' },
    { pagina: 1, area: area(185.5, 693.5, 120, 12), motivo: 'data de agendamento do exemplo' },
    { pagina: 1, area: area(186.2, 680.5, 120, 12), motivo: 'hora de agendamento do exemplo' },
    { pagina: 1, area: area(119.2, 627, 300, 12), motivo: 'BL do exemplo' },
    ...GLIFOS_HAPAG.map(([, x, y]) => ({ pagina: 1, area: areaDoGlifo(x, y), motivo: 'marcação de opção do exemplo (glifo e imagem sobreposta)' })),
    { pagina: 1, area: area(89, 382, 300, 10), motivo: 'nome do representante do exemplo' },
    { pagina: 1, area: area(108.2, 369, 200, 10), motivo: 'CPF do exemplo' },
    { pagina: 1, area: area(139, 355.5, 300, 10), motivo: 'empresa do exemplo' },
    { pagina: 1, area: area(121.6, 342, 200, 10), motivo: 'CNPJ do exemplo' },
    { pagina: 1, area: area(127.1, 329, 200, 10), motivo: 'telefone do exemplo' },
    { pagina: 1, area: area(89, 302, 150, 10), motivo: 'data do exemplo' },
    // Cambria 12 na linha de base 395,5 a partir de x = 160,4; o rótulo "Representante" (x = 89,9) e o quadro ficam.
    { pagina: 1, area: area(158, 391.5, 230, 17.5), motivo: 'placeholder do Word ("Clique ou toque aqui para inserir o texto.")' },
  ],
  campos: {
    EXPORTADOR_IMPORTADOR: lugar(1, 209.3, 709.5, 'HELVETICA_NEGRITO', 11.04, 300, { tamanhoMinimo: 8 }),
    AGENDAMENTO_DATA: lugar(1, 186.0, 696.3, 'HELVETICA', 11.04, 110, { formato: 'DATA_DD_MM_AAAA' }),
    AGENDAMENTO_HORA: lugar(1, 186.5, 683.0, 'HELVETICA', 11.04, 110, { formato: 'HORA_HH_MM' }),
    BL: lugar(1, 119.5, 629.9, 'HELVETICA', 11.04, 300),
    REPRESENTANTE: lugar(1, 89.9, 384.4, 'HELVETICA', 11.04, 400, { prefixo: 'Nome:', tamanhoMinimo: 9 }),
    CPF_DO_REPRESENTANTE: lugar(1, 108.4, 371.1, 'HELVETICA', 11.04, 130, { formato: 'CPF' }),
    EMPRESA: lugar(1, 142.6, 357.9, 'HELVETICA_NEGRITO', 11.04, 360, { tamanhoMinimo: 8 }),
    CNPJ: lugar(1, 125.2, 344.6, 'HELVETICA_NEGRITO', 11.04, 118, { formato: 'CNPJ', tamanhoMinimo: 9 }),
    TELEFONE: lugar(1, 127.3, 331.4, 'HELVETICA', 11.04, 116, { tamanhoMinimo: 9 }),
    DATA: lugar(1, 89.9, 304.8, 'HELVETICA', 11.04, 150, { formato: 'DATA_DD_MM_AAAA', prefixo: 'Itajaí,' }),
  },
  opcoes: { SERVICOS: Object.fromEntries(GLIFOS_HAPAG.map(([id, x, y]) => [id, caixaDoGlifo(1, x, y)])) },
  assinatura: { pagina: 1, area: area(246, 307, 182, 43) },
};

/** "Pelo presente memorando solicito os serviços listados abaixo": uma ou mais; nenhuma incompatibilidade é presumida (DOC-18). */
const servicosHapag: GrupoDeOpcoes = {
  id: 'SERVICOS', rotulo: 'Serviços solicitados', selecao: 'UMA_OU_MAIS', obrigatorio: true, incompativeis: [],
  alternativas: [
    { id: 'APRESENTACAO_PARA_DESBLOQUEIO', rotulo: 'Apresentação do bl para Desbloqueio' },
    { id: 'RETIRADA_E_DESBLOQUEIO', rotulo: 'Retirada e Desbloqueio' },
    { id: 'RETIRADA_DE_BL', rotulo: 'Retirada de bl (IMP/EXP)' },
    { id: 'DEVOLUCAO_E_SEA_WAYBILL', rotulo: 'Devolução e Sea waybill/Originais no destino' },
    { id: 'SOMENTE_DEVOLUCAO', rotulo: 'Somente Devolução' },
    { id: 'DEVOLUCAO_E_TROCA_DE_BL', rotulo: 'Devolução e Troca de BL' },
  ],
};

/** DOC-17: regra ESPECÍFICA dos memorandos Rochamar (Hapag-Lloyd e ZIM); nenhuma equivalência global entre exportador, importador e consignatário. */
export const FUNDAMENTO_EXPORTADOR_IMPORTADOR =
  'DOC-17: nos memorandos Rochamar (Hapag-Lloyd e ZIM), "Exportador/Importador" é o consignatário do MBL do Master. Sem consignatário confiável, o campo fica faltando.';

const camposRochamar = (comLocal: boolean): CampoVariavel[] => [
  { ...campo('EXPORTADOR_IMPORTADOR', 'Exportador/Importador', D.CONSIGNATARIO_RAZAO_SOCIAL, FONTES_DO_MBL, 'MASTER'), fundamento: FUNDAMENTO_EXPORTADOR_IMPORTADOR },
  campo('AGENDAMENTO_DATA', 'Agendamento — data', D.AGENDAMENTO_DATA, INFORMADO_PELO_ANALISTA, 'DOCUMENTO'),
  campo('AGENDAMENTO_HORA', 'Agendamento — hora', D.AGENDAMENTO_HORA, INFORMADO_PELO_ANALISTA, 'DOCUMENTO'),
  campo('BL', 'Bl(s) (Master)', D.MBL, ['S6_MASTER'], 'MASTER'),
  ...(comLocal ? [campo('LOCAL_DE_RETIRADA_OU_ENTREGA', 'Local de retirada ou entrega', D.LOCAL_DE_RETIRADA_OU_ENTREGA, INFORMADO_PELO_ANALISTA, 'DOCUMENTO')] : []),
  campo('REPRESENTANTE', 'Representante — nome (o signatário legal)', D.SIGNATARIO_NOME, DO_SIGNATARIO_LEGAL, 'SIGNATARIO'),
  campo('CPF_DO_REPRESENTANTE', 'Representante — CPF (o signatário legal)', D.SIGNATARIO_CPF, DO_SIGNATARIO_LEGAL, 'SIGNATARIO'),
  campo('EMPRESA', 'Empresa', D.ORGANIZACAO_RAZAO_SOCIAL, CADASTRO, 'DOCUMENTO'),
  campo('CNPJ', 'CNPJ', D.ORGANIZACAO_CNPJ, CADASTRO, 'DOCUMENTO'),
  campo('TELEFONE', 'Telefone', D.ORGANIZACAO_TELEFONE, CADASTRO, 'DOCUMENTO'),
  campo('DATA', 'Data', D.DATA_DA_GERACAO, ['GERACAO'], 'DOCUMENTO'),
];

const definicaoMemorandoHapag: DefinicaoDoModelo = {
  tipo: 'MEMORANDO_HAPAG_ROCHAMAR',
  campos: camposRochamar(false),
  blocosFixos: [
    { id: "ROTULO_EXPORTADOR_IMPORTADOR", natureza: "ESTRUTURA", texto: "Exportador/Importador" },
    { id: "PEDIDO_DE_SERVICOS", natureza: "ESTRUTURA", texto: "Pelo presente memorando solicito os serviços listados abaixo para os respectivos conhecimento de carga (BL):" },
    { id: "PROTOCOLO_DA_AGENCIA", natureza: "ESTRUTURA", texto: "*Protocolo - uso exclusivo da Rochamar" },
  ] as BlocoFixo[],
  opcoes: [servicosHapag],
  regras: [],
  assinatura: ASSINATURA,
  marcadoresDoExemplo: ['HLCUME3260358183', '05/06/2026', '11:30', 'ROCKET LOGISTICA', '27.909.874/0001-12', '3344-1759'],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  layout: layoutHapag,
  poderesDeRepresentacao: { fundamento: 'Quadro "Representante" com nome, CPF, empresa e CNPJ: quem assina o faz como representante da empresa.' },
};

/* ------------------------------------------ Memorando ZIM (Rochamar) ------------------------------------------ */

const GLIFOS_ZIM: ReadonlyArray<readonly [string, number, number]> = [
  ['APRESENTACAO_PARA_DESBLOQUEIO', 274.4, 376.1], ['RETIRADA_E_DESBLOQUEIO', 207.8, 361.7], ['RETIRADA_DE_BL', 216.7, 347.3],
  ['SOMENTE_DEVOLUCAO', 431.2, 376.1], ['TROCA_DE_BL', 391.8, 361.7],
];

const layoutZim: LayoutDoModelo = {
  paginas: [{ largura: 594.96, altura: 842.52 }],
  limpeza: [
    { pagina: 1, area: area(202.2, 666, 300, 12), motivo: 'exportador/importador do exemplo' },
    { pagina: 1, area: area(185.8, 639.5, 120, 12), motivo: 'data de agendamento do exemplo' },
    { pagina: 1, area: area(185.3, 613.5, 120, 12), motivo: 'hora de agendamento do exemplo' },
    { pagina: 1, area: area(118.6, 546.5, 300, 12), motivo: 'BL do exemplo' },
    ...GLIFOS_ZIM.map(([, x, y]) => ({ pagina: 1, area: areaDoGlifo(x, y), motivo: 'marcação de opção do exemplo' })),
    { pagina: 1, area: area(233.7, 330.5, 250, 12), motivo: 'local de retirada do exemplo' },
    { pagina: 1, area: area(121.4, 262.8, 300, 12), motivo: 'nome do representante do exemplo' },
    { pagina: 1, area: area(107.9, 249.5, 200, 12), motivo: 'CPF do exemplo' },
    { pagina: 1, area: area(135.6, 236, 340, 12), motivo: 'empresa do exemplo' },
    { pagina: 1, area: area(117.7, 223, 200, 12), motivo: 'CNPJ do exemplo' },
    { pagina: 1, area: area(123.8, 210, 200, 12), motivo: 'telefone do exemplo' },
    { pagina: 1, area: area(89.5, 143, 150, 12), motivo: 'data do exemplo' },
  ],
  campos: {
    EXPORTADOR_IMPORTADOR: lugar(1, 204.9, 668.5, 'HELVETICA', 11.04, 300, { tamanhoMinimo: 8 }),
    AGENDAMENTO_DATA: lugar(1, 189.5, 641.9, 'HELVETICA', 11.04, 110, { formato: 'DATA_DD_MM_AAAA' }),
    AGENDAMENTO_HORA: lugar(1, 188.9, 615.8, 'HELVETICA', 11.04, 110, { formato: 'HORA_HH_MM' }),
    BL: lugar(1, 122.3, 549.0, 'HELVETICA', 11.04, 300),
    LOCAL_DE_RETIRADA_OU_ENTREGA: lugar(1, 233.9, 333.1, 'HELVETICA', 11.04, 260, { tamanhoMinimo: 8 }),
    REPRESENTANTE: lugar(1, 125.1, 265.3, 'HELVETICA', 11.04, 360, { tamanhoMinimo: 9 }),
    CPF_DO_REPRESENTANTE: lugar(1, 111.5, 251.9, 'HELVETICA', 11.04, 200, { formato: 'CPF' }),
    EMPRESA: lugar(1, 138.5, 238.7, 'HELVETICA_NEGRITO', 9, 360, { tamanhoMinimo: 7 }),
    CNPJ: lugar(1, 121.3, 225.4, 'HELVETICA', 11.04, 200, { formato: 'CNPJ' }),
    TELEFONE: lugar(1, 127.3, 212.5, 'HELVETICA', 11.04, 200),
    DATA: lugar(1, 89.9, 145.7, 'HELVETICA', 11.04, 150, { formato: 'DATA_DD_MM_AAAA', prefixo: 'Itajaí,' }),
  },
  opcoes: { SERVICOS: Object.fromEntries(GLIFOS_ZIM.map(([id, x, y]) => [id, caixaDoGlifo(1, x, y)])) },
  assinatura: { pagina: 1, area: area(116, 160, 380, 35) },
};

/** Mesmo texto do Hapag: uma ou mais; nenhuma incompatibilidade é presumida (DOC-18). */
const servicosZim: GrupoDeOpcoes = {
  id: 'SERVICOS', rotulo: 'Serviços solicitados', selecao: 'UMA_OU_MAIS', obrigatorio: true, incompativeis: [],
  alternativas: [
    { id: 'APRESENTACAO_PARA_DESBLOQUEIO', rotulo: 'Apresentação do bl para Desbloqueio' },
    { id: 'RETIRADA_E_DESBLOQUEIO', rotulo: 'Retirada e Desbloqueio' },
    { id: 'RETIRADA_DE_BL', rotulo: 'Retirada de bl (IMP/EXP)' },
    { id: 'SOMENTE_DEVOLUCAO', rotulo: 'Somente Devolução' },
    { id: 'TROCA_DE_BL', rotulo: 'Troca de BL' },
  ],
};

const definicaoMemorandoZim: DefinicaoDoModelo = {
  tipo: 'MEMORANDO_ZIM_ROCHAMAR',
  campos: camposRochamar(true),
  blocosFixos: [
    { id: "ROTULO_EXPORTADOR_IMPORTADOR", natureza: "ESTRUTURA", texto: "Exportador/Importador" },
    { id: "PEDIDO_DE_SERVICOS", natureza: "ESTRUTURA", texto: "Pelo presente memorando solicito os serviços listados abaixo para os respectivos conhecimento de carga (BL):" },
    { id: "TITULO_DO_REPRESENTANTE", natureza: "ESTRUTURA", texto: "Dados do Representante Legal" },
  ] as BlocoFixo[],
  opcoes: [servicosZim],
  regras: [],
  assinatura: ASSINATURA,
  marcadoresDoExemplo: ['ZIMUXIA8574637', '11/09/2026', '15 30', 'ROCKET LOGISTICA', '27.909.874/0001-12', '3344-1759'],
  natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO',
  layout: layoutZim,
  poderesDeRepresentacao: { fundamento: 'Quadro "Dados do Representante Legal": quem assina o faz como representante legal da empresa.' },
};

/** Definições propostas (a validar por pessoa no cadastro de cada versão). */
export const DEFINICOES_PROPOSTAS: Readonly<Record<TipoDocumento, DefinicaoDoModelo>> = {
  TERMO_EVERGREEN: definicaoTermoEvergreen,
  MEMORANDO_MSC: definicaoMemorandoMsc,
  MEMORANDO_HAPAG_ROCHAMAR: definicaoMemorandoHapag,
  MEMORANDO_ZIM_ROCHAMAR: definicaoMemorandoZim,
};
