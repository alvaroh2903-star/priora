import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import * as graph from '../../../graph/graphService';
import * as gemini from '../../../ai/geminiClient';
import { FullEmailMessage, LogisticsSummary } from '../../../graph/graphService';
import { DocTipo, DocumentoExtraido } from '../../playbooks';
import { ReusoPorConteudo, extrairDocumento } from '../../docExtractor';
import { validaISO6346 } from '../../preAlerta/normalizacao';
import { resolverContextoOperacional } from '../../../operacional/contexto';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { servir } from '../../../operacional/__tests__/http';
import { criarAuditoriaRouter } from '../../../routes/auditoriaRoutes';
import { EXTRATOR_VERSAO, resultadoPorConteudo } from '../extracoes';
import { leiturasDoMblDoMaster } from '../camposDoMbl';

/**
 * Entrega 1 — versões do MBL e campos documentais (0106). Política aprovada: cada anexo é identificado pela mensagem +
 * anexo do Outlook (nunca pelo nome); conteúdo idêntico (hash dos bytes já obtidos) não passa de novo pelo OCR; conteúdo
 * diferente com o mesmo nome é outra versão, lida UMA vez; todas as versões ficam, nenhuma é escolhida.
 * Fixtures sintéticas: caixa postal e OCR falsos (sem Graph, sem IA, sem documento real).
 */

const url = testDatabaseUrl();
const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');

/** Número de contêiner sintético com o dígito verificador ISO 6346 correto. */
function conteiner(base: string): string {
  for (let d = 0; d <= 9; d++) if (validaISO6346(`${base}${d}`)) return `${base}${d}`;
  throw new Error(`sem dígito para ${base}`);
}
const C1 = conteiner('TSTU000001');
const C2 = conteiner('TSTU000002');

interface Anexo { id: string; nome: string; bytes: string; ocr: Partial<DocumentoExtraido> }
interface Email { id: string; assunto: string; corpo: string; recebido: string; anexos: Anexo[] }

/** Caixa postal e extrator falsos que seguem o contrato do `extrairDocumento`: bytes → hash → reuso? → OCR. */
function caixaPostal(emails: () => Email[]) {
  const resumo = (e: Email): LogisticsSummary => ({
    id: e.id, conversationId: `c-${e.id}`, subject: e.assunto, bodyPreview: e.corpo.slice(0, 40),
    body: { contentType: 'text', content: e.corpo }, from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } },
    receivedDateTime: e.recebido, isRead: true, hasAttachments: e.anexos.length > 0, webLink: '',
  });
  const completo = (e: Email): FullEmailMessage => ({
    id: e.id, internetMessageId: `<${e.id}@agente.com>`, conversationId: `c-${e.id}`, subject: e.assunto,
    from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: e.recebido,
    body: { contentType: 'text', content: e.corpo }, bodyPreview: e.corpo.slice(0, 40), hasAttachments: e.anexos.length > 0,
    attachments: e.anexos.map((a) => ({ id: a.id, name: a.nome, contentType: 'application/pdf', size: 10, isInline: false })),
  });
  const anexo = (m: string, a: string) => emails().find((e) => e.id === m)!.anexos.find((x) => x.id === a)!;
  const chamadasOcr: string[] = [];
  const downloads: string[] = [];
  return {
    chamadasOcr, downloads,
    graph: {
      searchLogisticsMessages: async () => emails().map(resumo),
      listRecentSummaries: async () => [],
      getFullMessage: async (_t: string, id: string) => completo(emails().find((e) => e.id === id)!),
    },
    extrair: async (_t: string, messageId: string, attachmentId: string, nome: string, tipo: DocTipo, reuso?: ReusoPorConteudo) => {
      downloads.push(`${messageId}/${attachmentId}`);
      const a = anexo(messageId, attachmentId);
      const arquivoSha256 = sha(a.bytes);
      const r = reuso ? await reuso(arquivoSha256) : null;
      if (r) return { ...r, nome, tipo, arquivoSha256 };
      chamadasOcr.push(`${messageId}/${attachmentId}`);
      return {
        nome, tipo, tipoDetectado: null, conhecimento: null, portoOrigem: null, portoDestino: null, navio: null, shipper: null,
        consignee: null, notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: null, containers: [], legivel: true,
        ...a.ocr, arquivoSha256,
      } as DocumentoExtraido & { arquivoSha256: string };
    },
  };
}

const ocrMbl = (navio: string, conteineres: string[], consignee = 'EMPRESA SINTETICA DE TESTE LTDA'): Partial<DocumentoExtraido> => ({
  tipoDetectado: 'MBL', conhecimento: 'MEDU1234567', navio, consignee,
  containers: conteineres.map((numero) => ({ numero, pesoBrutoKg: 1000, cubagemM3: 10, lacre: 'L1', ncm: [], descricao: 'CARGA SINTETICA' })),
});
const HBL: Anexo = { id: 'a-hbl', nome: 'HBL.pdf', bytes: 'HBL sintetico', ocr: { tipoDetectado: 'HBL', conhecimento: 'HBLSINT0001', navio: 'NAVIO SINTETICO A V.001' } };
const email = (id: string, recebido: string, anexos: Anexo[], assunto = 'Pre-alert IM2151-026'): Email =>
  ({ id, assunto, corpo: 'Please find attached the documents.', recebido, anexos });

/** Router da Auditoria com a caixa e o extrator falsos; `atual` permite trocar de caixa/organização no MESMO router. */
function routerAuditoria(pool: Pool, emails: () => Email[], atual: () => Cenario) {
  const cx = caixaPostal(emails);
  const persistencias: Promise<unknown>[] = [];
  const router = criarAuditoriaRouter({
    auth: (_req, _res, next) => next(),
    graph: cx.graph as never,
    extrair: cx.extrair,
    resumir: async () => ({ linhas: ['ok'], proximoPasso: 'ok', fonte: 'deterministico' }),
    iaConfigurada: () => true,
    modelo: () => 'modelo-teste',
    fatos: {
      habilitado: () => true, pool: () => pool,
      contexto: () => resolverContextoOperacional(pool, { caixaHomeAccountId: atual().homeCaixa, pessoa: { homeAccountId: atual().homePessoa } }),
    },
    aoPersistir: (p) => { persistencias.push(p); },
    escopoDoCache: () => atual().homeCaixa,
  });
  return { cx, router, persistencias, concluir: () => Promise.all(persistencias.splice(0)) };
}

async function chamar(r: ReturnType<typeof routerAuditoria>, atual: () => Cenario, caminho = '/IM2151/auditoria') {
  const srv = await servir(r.router, () => ({ homeAccountId: atual().homePessoa }));
  try {
    const resposta = await srv.chamar('GET', caminho);
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const persistido = await r.concluir();
    for (const p of persistido) assert.equal((p as { persistido: boolean }).persistido, true, JSON.stringify(p));
    return resposta;
  } finally {
    await srv.fechar();
  }
}

const MBLS = (pool: Pool, org: string) => pool.query(
  `SELECT message_id, attachment_id, attachment_nome, internet_message_id, remetente, mensagem_recebida_em, extrator_versao, modelo,
          campos_documentais, arquivo_sha256, conhecimento FROM auditoria_extracoes
    WHERE organization_id = $1 AND tipo_detectado = 'MBL' ORDER BY mensagem_recebida_em, message_id`, [org]).then((r) => r.rows);

const masterDe = async (pool: Pool, org: string) =>
  (await pool.query(`SELECT DISTINCT master_id FROM processo_master_vinculos WHERE organization_id = $1`, [org])).rows.map((r) => r.master_id as string);

/* ---------------------------------- extrator real (Graph e Gemini substituídos em memória) ---------------------------------- */

test('[E1-00] extrator real: hash dos bytes JÁ obtidos para o OCR (um download); conteúdo idêntico já extraído não chama a IA; prompt e schema intocados', async () => {
  const g = graph as unknown as Record<string, unknown>;
  const ia = gemini as unknown as Record<string, unknown>;
  const originais = { baixar: g.getAttachmentContent, ler: ia.generateStructuredFromDocument };
  const bytes = Buffer.from('%PDF-1.4 MBL SINTETICO');
  const downloads: string[] = [];
  const leituras: Array<{ prompt: string; dados: string }> = [];
  g.getAttachmentContent = async (_t: string, m: string, a: string) => {
    downloads.push(`${m}/${a}`);
    return { name: 'MBL.pdf', contentType: 'application/pdf', contentBytes: bytes.toString('base64') };
  };
  ia.generateStructuredFromDocument = async (_schema: unknown, prompt: string, doc: { data: string }) => {
    leituras.push({ prompt, dados: doc.data });
    return {
      legivel: true, tipoDetectado: 'MBL', conhecimento: 'MEDU1234567', portoOrigem: null, portoDestino: null, navio: 'NAVIO SINTETICO A V.001',
      shipper: null, consignee: 'EMPRESA SINTETICA DE TESTE LTDA', notify: null, cliente: null, freteValor: null, freteMoeda: null, thcValor: null,
      containers: [{ numero: C1, pesoBrutoKg: null, cubagemM3: null, lacre: null, ncm: [], descricao: null }],
    };
  };
  try {
    const esperado = createHash('sha256').update(bytes).digest('hex');
    const pedidos: string[] = [];
    const lido = await extrairDocumento('t', 'm1', 'a1', 'MBL.pdf', 'MBL', async (h) => { pedidos.push(h); return null; });
    assert.equal(lido.arquivoSha256, esperado, 'hash dos bytes que vieram do Graph');
    assert.deepEqual(pedidos, [esperado], 'o reuso é consultado com o hash, antes do OCR');
    assert.equal(leituras.length, 1);
    assert.equal(leituras[0].dados, bytes.toString('base64'), 'os mesmos bytes vão ao OCR (nenhum download a mais)');
    assert.match(leituras[0].prompt, /^Você é a camada de OCR\/Parser da Auditoria Documental da Priora/);
    assert.equal(lido.navio, 'NAVIO SINTETICO A V.001');

    const reaproveitado = await extrairDocumento('t', 'm2', 'a2', 'MBL-copia.pdf', 'MBL', async () => ({ ...lido }));
    assert.equal(leituras.length, 1, 'conteúdo idêntico já extraído: a IA não é chamada');
    assert.deepEqual([reaproveitado.nome, reaproveitado.arquivoSha256, reaproveitado.navio], ['MBL-copia.pdf', esperado, 'NAVIO SINTETICO A V.001']);
    assert.deepEqual(downloads, ['m1/a1', 'm2/a2'], 'um download por anexo, nenhum a mais');
  } finally {
    g.getAttachmentContent = originais.baixar;
    ia.generateStructuredFromDocument = originais.ler;
  }
});

/* ---------------------------------------------------- com o banco ---------------------------------------------------- */

test('Entrega 1 — versões do MBL e campos documentais (0106)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('[E1-01/02] o OCR existente devolve os campos do MBL e a persistência os preserva como vieram, com a origem documental e o hash do arquivo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-campos');
      const bytes = 'MBL sintetico v1';
      const lista = () => [email('pa1', '2026-09-01T08:00:00Z', [{ id: 'a-mbl', nome: 'MBL.pdf', bytes, ocr: ocrMbl('NAVIO SINTETICO A V.001', [`${C1.slice(0, 4)} ${C1.slice(4)}`, C2]) }, HBL])];
      const r = routerAuditoria(pool, lista, () => a);
      await chamar(r, () => a);
      assert.deepEqual(r.cx.chamadasOcr.sort(), ['pa1/a-hbl', 'pa1/a-mbl'], 'OCR uma vez por anexo, como antes');
      const [mbl] = await MBLS(pool, a.orgId);
      assert.deepEqual(mbl.campos_documentais, {
        navio: 'NAVIO SINTETICO A V.001', consignee: 'EMPRESA SINTETICA DE TESTE LTDA', conteineres: [`${C1.slice(0, 4)} ${C1.slice(4)}`, C2],
      }, 'exatamente como o OCR devolveu (sem normalização na gravação)');
      assert.equal(mbl.arquivo_sha256, sha(bytes), 'hash dos bytes do anexo lido');
      assert.deepEqual(
        [mbl.message_id, mbl.attachment_id, mbl.attachment_nome, mbl.internet_message_id, mbl.remetente, new Date(mbl.mensagem_recebida_em).toISOString(), mbl.extrator_versao, mbl.modelo],
        ['pa1', 'a-mbl', 'MBL.pdf', '<pa1@agente.com>', 'agente@agente.com', '2026-09-01T08:00:00.000Z', EXTRATOR_VERSAO, 'modelo-teste'],
      );
      assert.equal(EXTRATOR_VERSAO, '2');
      const [masterId] = await masterDe(pool, a.orgId);
      const leituras = await leiturasDoMblDoMaster(pool, a.orgId, masterId);
      assert.equal(leituras.length, 1);
      assert.deepEqual([leituras[0].origem.messageId, leituras[0].origem.attachmentId, leituras[0].origem.arquivoSha256], ['pa1', 'a-mbl', sha(bytes)]);
      assert.equal(leituras[0].processoIds.length, 1);
      await assert.rejects(pool.query(`UPDATE auditoria_extracoes SET campos_documentais = '{}'::jsonb`), /append-only/, 'continua append-only');
    });

    await t.test('[E1-03] cada leitura fica com o Master certo: outro Master, MBL sem vínculo (referência cruzada) e MBL ilegível não entram', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-master');
      const emails = [
        email('m-a', '2026-09-01T08:00:00Z', [{ id: 'x1', nome: 'MBL.pdf', bytes: 'A', ocr: ocrMbl('NAVIO A', [C1]) }], 'Pre-alert IM3001-26'),
        email('m-b', '2026-09-02T08:00:00Z', [{ id: 'x2', nome: 'MBL.pdf', bytes: 'B', ocr: { ...ocrMbl('NAVIO B', [C2]), conhecimento: 'MEDU7654321' } }], 'Pre-alert IM3002-26'),
        email('m-ilegivel', '2026-09-03T08:00:00Z', [{ id: 'x3', nome: 'MBL.pdf', bytes: 'C', ocr: { ...ocrMbl('NAVIO C', [C2]), legivel: false } }], 'Pre-alert IM3001-26'),
      ];
      const r = routerAuditoria(pool, () => emails, () => a);
      await chamar(r, () => a, '/IM3001-26/auditoria');
      await chamar(r, () => a, '/IM3002-26/auditoria');
      const masters = await pool.query(
        `SELECT DISTINCT v.master_id, e.conhecimento FROM processo_master_vinculos v JOIN auditoria_extracoes e ON e.id = v.extracao_id WHERE v.organization_id = $1`, [a.orgId]);
      const de = (mbl: string) => masters.rows.find((x) => x.conhecimento === mbl)!.master_id as string;
      const la = await leiturasDoMblDoMaster(pool, a.orgId, de('MEDU1234567'));
      const lb = await leiturasDoMblDoMaster(pool, a.orgId, de('MEDU7654321'));
      assert.deepEqual(la.map((l) => [l.origem.messageId, l.campos?.navio]), [['m-a', 'NAVIO A']], 'só o MBL deste Master; o ilegível não entra');
      assert.deepEqual(lb.map((l) => [l.origem.messageId, l.campos?.navio]), [['m-b', 'NAVIO B']]);
    });

    await t.test('[E1-04] organizações diferentes não compartilham leitura, cache nem reuso, mesmo com o MESMO arquivo, no mesmo router', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-org-a');
      const b = await cenario(pool, 'e1-org-b');
      let atual = a;
      const lista = () => [email('pa1', '2026-09-01T08:00:00Z', [{ id: 'a-mbl', nome: 'MBL.pdf', bytes: 'MBL compartilhado', ocr: ocrMbl('NAVIO A', [C1]) }, HBL])];
      const r = routerAuditoria(pool, lista, () => atual);
      await chamar(r, () => atual);
      assert.equal(r.cx.chamadasOcr.length, 2);
      assert.equal(await resultadoPorConteudo(pool, b.orgId, sha('MBL compartilhado')), null, 'o conteúdo extraído na organização A não serve à B');
      atual = b;
      await chamar(r, () => atual);
      assert.equal(r.cx.chamadasOcr.length, 4, 'outra caixa/organização: nada reaproveitado da memória de A');
      for (const org of [a.orgId, b.orgId]) assert.equal((await MBLS(pool, org)).length, 1);
      const [masterA] = await masterDe(pool, a.orgId);
      assert.deepEqual(await leiturasDoMblDoMaster(pool, b.orgId, masterA), [], 'o Master de A não é lido pela organização B');
    });

    await t.test('[E1-05] duplicata idêntica (mesmo arquivo reenviado em outro e-mail, mesmo nome) não provoca novo OCR; cada anexo fica com a própria origem', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-dup');
      const mbl = (id: string) => ({ id, nome: 'MBL.pdf', bytes: 'MBL identico', ocr: ocrMbl('NAVIO A', [C1]) });
      let emails = [email('e1', '2026-09-01T08:00:00Z', [mbl('a1'), HBL]), email('e2', '2026-09-02T08:00:00Z', [mbl('a2')], 'FW: Pre-alert IM2151-026')];
      const r = routerAuditoria(pool, () => emails, () => a);
      await chamar(r, () => a);
      assert.deepEqual(r.cx.chamadasOcr.sort(), ['e1/a-hbl', 'e1/a1'], 'o MBL reenviado foi reconhecido pelo hash: nenhum OCR para ele');
      const linhas = await MBLS(pool, a.orgId);
      assert.deepEqual(linhas.map((l) => [l.message_id, l.attachment_id, l.arquivo_sha256 === sha('MBL identico')]), [['e1', 'a1', true], ['e2', 'a2', true]],
        'os dois anexos ficam, cada um com a sua origem e o mesmo hash');
      assert.deepEqual(linhas[0].campos_documentais, linhas[1].campos_documentais);
      await chamar(r, () => a);
      assert.equal(r.cx.chamadasOcr.length, 2, 'repetir não lê nada de novo');
      assert.equal((await MBLS(pool, a.orgId)).length, 2, 'nem grava de novo (idempotente)');

      // "Reinício": memória vazia. A versão já gravada não é baixada nem lida; um terceiro e-mail com o MESMO arquivo
      // reaproveita a extração persistida (pelo hash), sem OCR.
      emails = [email('e9', '2026-09-09T08:00:00Z', [{ id: 'a9', nome: 'MBL.pdf', bytes: 'MBL corrigido', ocr: ocrMbl('NAVIO A', [C1]) }, HBL]), ...emails,
        email('e3', '2026-09-03T08:00:00Z', [mbl('a3')], 'FW: FW: Pre-alert IM2151-026')];
      const depois = routerAuditoria(pool, () => emails, () => a);
      await chamar(depois, () => a);
      assert.ok(!depois.cx.downloads.includes('e2/a2') && !depois.cx.downloads.includes('e1/a1'), 'versões já gravadas: nem download');
      assert.ok(!depois.cx.chamadasOcr.includes('e3/a3'), 'conteúdo idêntico ao já persistido: sem OCR');
      assert.ok(depois.cx.downloads.includes('e3/a3'));
      const e3 = (await MBLS(pool, a.orgId)).find((l) => l.message_id === 'e3')!;
      assert.equal(e3.arquivo_sha256, sha('MBL identico'));
      assert.equal(e3.modelo, 'modelo-teste', 'a extração reaproveitada mantém o modelo de quem a fez');
    });

    await t.test('[E1-06] MBL corrigido com o MESMO nome e conteúdo diferente não é duplicata: vira outra versão, lida UMA vez; nenhuma substitui a outra', async () => {
      for (const ordem of ['corrigido-por-ultimo', 'corrigido-primeiro'] as const) {
        await truncateAll(pool);
        const a = await cenario(pool, `e1-corr-${ordem}`);
        const original = email('e1', '2026-09-01T08:00:00Z', [{ id: 'a1', nome: 'MBL.pdf', bytes: 'MBL v1', ocr: ocrMbl('NAVIO A V.001', [C1]) }, HBL]);
        const corrigido = email('e2', '2026-09-05T08:00:00Z', [{ id: 'a2', nome: 'MBL.pdf', bytes: 'MBL v2', ocr: ocrMbl('NAVIO B V.002', [C1]) }], 'RE: Pre-alert IM2151-026');
        let emails = [original];
        const r = routerAuditoria(pool, () => emails, () => a);
        const antes = await chamar(r, () => a);
        emails = ordem === 'corrigido-por-ultimo' ? [original, corrigido] : [corrigido, original];
        const depois = await chamar(r, () => a);
        await chamar(r, () => a);
        assert.deepEqual([...r.cx.chamadasOcr].sort(), ['e1/a-hbl', 'e1/a1', 'e2/a2'], `${ordem}: cada anexo lido uma única vez (o HBL já lido não volta ao OCR)`);
        assert.deepEqual([...r.cx.downloads].sort(), ['e1/a-hbl', 'e1/a1', 'e2/a2'], `${ordem}: anexo já lido nesta execução nem é baixado de novo`);
        const linhas = await MBLS(pool, a.orgId);
        assert.deepEqual(linhas.map((l) => [l.message_id, l.attachment_nome, l.arquivo_sha256, l.campos_documentais.navio]),
          [['e1', 'MBL.pdf', sha('MBL v1'), 'NAVIO A V.001'], ['e2', 'MBL.pdf', sha('MBL v2'), 'NAVIO B V.002']], `${ordem}: duas versões, cada uma com a sua origem`);
        if (ordem === 'corrigido-primeiro') assert.notDeepEqual(depois.body, antes.body, 'o cache não devolve mais a auditoria do anexo antigo');
        else assert.deepEqual(depois.body, antes.body, 'o Playbook continua com o mesmo MBL (a escolha de um documento por tipo não mudou)');
        const [masterId] = await masterDe(pool, a.orgId);
        const leituras = await leiturasDoMblDoMaster(pool, a.orgId, masterId);
        assert.deepEqual(leituras.map((l) => l.campos?.navio), ['NAVIO A V.001', 'NAVIO B V.002'], `${ordem}: as duas versões chegam ao contrato; nenhuma é escolhida`);
      }
    });

    await t.test('[E1-03b] defesa: mesmo que um vínculo aponte para uma extração ilegível, ela não vira leitura do MBL do Master', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-defesa');
      const emails = [
        email('m-ok', '2026-09-01T08:00:00Z', [{ id: 'y1', nome: 'MBL.pdf', bytes: 'OK', ocr: ocrMbl('NAVIO OK', [C1]) }], 'Pre-alert IM3001-26'),
        email('m-ileg', '2026-09-02T08:00:00Z', [{ id: 'y2', nome: 'MBL.pdf', bytes: 'ILEG', ocr: { ...ocrMbl('NAVIO ILEGIVEL', [C1]), legivel: false } }], 'Pre-alert IM3001-26'),
      ];
      const r = routerAuditoria(pool, () => emails, () => a);
      await chamar(r, () => a, '/IM3001-26/auditoria');
      const { rows: [v] } = await pool.query(`SELECT processo_id, master_id FROM processo_master_vinculos WHERE organization_id = $1`, [a.orgId]);
      const { rows: [ileg] } = await pool.query(`SELECT id FROM auditoria_extracoes WHERE organization_id = $1 AND message_id = 'm-ileg'`, [a.orgId]);
      await pool.query(
        `INSERT INTO processo_master_vinculos (organization_id, processo_id, master_id, extracao_id, processo_ref_bruta, processo_via, mbl_bruto, fonte)
         VALUES ($1, $2, $3, $4, 'IM3001-26', 'CODIGO', 'MEDU1234567', 'auditoria_extracao')`, [a.orgId, v.processo_id, v.master_id, ileg.id]);
      const leituras = await leiturasDoMblDoMaster(pool, a.orgId, v.master_id);
      assert.deepEqual(leituras.map((l) => l.campos?.navio), ['NAVIO OK'], 'só a extração legível');
    });

    await t.test('[E1-06b] o mesmo anexo relido a pedido (refresh=1) com resultado diferente vira outra evidência: nada é sobrescrito nem descartado', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-refresh');
      const mbl: Anexo = { id: 'a1', nome: 'MBL.pdf', bytes: 'MBL unico', ocr: ocrMbl('NAVIO A V.001', [C1]) };
      const lista = () => [email('e1', '2026-09-01T08:00:00Z', [mbl, HBL])];
      const r = routerAuditoria(pool, lista, () => a);
      await chamar(r, () => a);
      mbl.ocr = ocrMbl('NAVIO A  V.OO1', [C1]);
      await chamar(r, () => a, '/IM2151/auditoria?refresh=1');
      const linhas = await MBLS(pool, a.orgId);
      assert.deepEqual(linhas.map((l) => [l.attachment_id, l.campos_documentais.navio]), [['a1', 'NAVIO A V.001'], ['a1', 'NAVIO A  V.OO1']],
        'as duas leituras do mesmo arquivo ficam (append-only), com o mesmo hash');
      assert.equal(new Set(linhas.map((l) => l.arquivo_sha256)).size, 1);
    });

    await t.test('[E1-07] sem os fatos duráveis, as demais versões nem são lidas (nada a persistir): zero OCR além do de sempre', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'e1-off');
      const emails = [
        email('e1', '2026-09-01T08:00:00Z', [{ id: 'a1', nome: 'MBL.pdf', bytes: 'v1', ocr: ocrMbl('NAVIO A', [C1]) }, HBL]),
        email('e2', '2026-09-05T08:00:00Z', [{ id: 'a2', nome: 'MBL.pdf', bytes: 'v2', ocr: ocrMbl('NAVIO B', [C1]) }]),
      ];
      const cx = caixaPostal(() => emails);
      const persistencias: Promise<unknown>[] = [];
      const router = criarAuditoriaRouter({
        auth: (_q, _s, n) => n(), graph: cx.graph as never, extrair: cx.extrair, resumir: async () => ({ linhas: [], proximoPasso: '', fonte: 'deterministico' }),
        iaConfigurada: () => true, modelo: () => 'modelo-teste', escopoDoCache: () => a.homeCaixa, aoPersistir: (p) => { persistencias.push(p); },
        fatos: { habilitado: () => false, pool: () => pool, contexto: async () => ({ ok: false, motivo: 'FATOS_DURAVEIS_DESLIGADOS' }) },
      });
      const srv = await servir(router, () => ({ homeAccountId: a.homePessoa }));
      try {
        assert.equal((await srv.chamar('GET', '/IM2151/auditoria')).status, 200);
        await Promise.all(persistencias);
      } finally {
        await srv.fechar();
      }
      assert.deepEqual(cx.chamadasOcr.sort(), ['e1/a-hbl', 'e1/a1']);
      assert.equal(await contar(pool, `SELECT count(*) n FROM auditoria_extracoes`), 0);
    });
  } finally {
    await pool.end();
  }
});
