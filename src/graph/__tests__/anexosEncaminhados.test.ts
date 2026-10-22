import '../../operacional/__tests__/ambiente'; // DATA_DIR temporário: o store legado (Courier/Demurrage) nunca toca dados reais
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestHandler, Router } from 'express';
import { getGraphClient, getItemAttachmentTexts } from '../graphService';
import { criarCourierRouter } from '../../routes/courierRoutes';
import { criarDemurrageRouter } from '../../routes/demurrageRoutes';
import { servir } from '../../operacional/__tests__/http';

/**
 * O3.1 — memória dos anexos no Courier e na Demurrage. O Graph é SIMULADO no
 * `fetch` global (só o host graph.microsoft.com; o resto passa direto). Dados
 * sintéticos. Prova: (1) o texto dos e-mails encaminhados como anexo é o MESMO de
 * antes; (2) os arquivos (PDFs) não são mais baixados; (3) falhas seguem
 * devolvendo []; (4) no máximo 5 e-mails por vez, e todos continuam processados.
 */

type Anexo =
  | { tipo: 'arquivo'; id: string; nome: string; bytes: number }
  | { tipo: 'item'; id: string; nome: string; assunto?: string; corpo?: string; resumo?: string };

const KB = 1024;

/** Implementação ANTERIOR (até o commit 0ae78a9), congelada aqui como oráculo da equivalência. */
async function textosComoAntes(accessToken: string, messageId: string): Promise<string[]> {
  try {
    const res = await getGraphClient(accessToken)
      .api(`/me/messages/${messageId}/attachments`)
      .header('Prefer', 'outlook.body-content-type="text"')
      .expand('microsoft.graph.itemAttachment/item')
      .get();
    const texts: string[] = [];
    for (const att of (res.value as any[]) || []) {
      if (att['@odata.type'] === '#microsoft.graph.itemAttachment' && att.item) {
        const joined = `${att.item.subject || ''}\n${att.item.body?.content || att.item.bodyPreview || ''}`.trim();
        if (joined) texts.push(joined);
      }
    }
    return texts;
  } catch {
    return [];
  }
}

/** Graph falso: responde às duas formas de listagem (com e sem $select) e à leitura de um anexo. */
function grafoFalso(anexos: Record<string, Anexo[]>, opcoes: { atrasoMs?: number; falhas?: Set<string>; mensagens?: unknown[] } = {}) {
  const pedidos: Array<{ caminho: string; select: string | null; expand: string | null; bytes: number }> = [];
  let emVoo = 0;
  let maxEmVoo = 0;
  const original = globalThis.fetch;
  const item = (a: Extract<Anexo, { tipo: 'item' }>) => ({
    subject: a.assunto, bodyPreview: a.resumo, body: a.corpo === undefined ? undefined : { contentType: 'text', content: a.corpo },
  });
  const meta = (a: Anexo) => ({
    '@odata.type': a.tipo === 'arquivo' ? '#microsoft.graph.fileAttachment' : '#microsoft.graph.itemAttachment',
    id: a.id, name: a.nome, contentType: a.tipo === 'arquivo' ? 'application/pdf' : null, size: a.tipo === 'arquivo' ? a.bytes : 2 * KB, isInline: false,
  });
  const responder = (url: URL): { status: number; corpo: unknown } => {
    const m = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)\/attachments(?:\/([^/]+))?$/);
    if (url.pathname === '/v1.0/me/messages' || url.pathname === '/v1.0/me/mailFolders/inbox/messages') {
      return { status: 200, corpo: { value: opcoes.mensagens ?? [] } };
    }
    if (!m) return { status: 404, corpo: { error: { code: 'ErrorItemNotFound' } } };
    const [, mid, aid] = m;
    if (opcoes.falhas?.has(aid ? `${mid}/${aid}` : mid)) return { status: 500, corpo: { error: { code: 'ErrorInternalServerError' } } };
    const lista = anexos[mid] ?? [];
    if (aid) {
      const a = lista.find((x) => x.id === aid);
      if (!a) return { status: 404, corpo: { error: { code: 'ErrorItemNotFound' } } };
      return { status: 200, corpo: a.tipo === 'item' ? { ...meta(a), item: item(a) } : { ...meta(a), contentBytes: 'A'.repeat(Math.ceil(a.bytes / 3) * 4) } };
    }
    if (url.searchParams.get('$select')) return { status: 200, corpo: { value: lista.map(meta) } };
    // Sem $select: como o Graph real, cada arquivo vem com o contentBytes (base64) inteiro.
    return {
      status: 200,
      corpo: { value: lista.map((a) => (a.tipo === 'arquivo' ? { ...meta(a), contentBytes: 'A'.repeat(Math.ceil(a.bytes / 3) * 4) } : { ...meta(a), item: item(a) })) },
    };
  };
  const falso = async (entrada: any, init?: any): Promise<Response> => {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url);
    if (url.hostname !== 'graph.microsoft.com') return original(entrada, init);
    emVoo++;
    maxEmVoo = Math.max(maxEmVoo, emVoo);
    try {
      if (opcoes.atrasoMs) await new Promise((ok) => setTimeout(ok, opcoes.atrasoMs));
      const r = responder(url);
      const texto = JSON.stringify(r.corpo);
      pedidos.push({ caminho: url.pathname, select: url.searchParams.get('$select'), expand: url.searchParams.get('$expand'), bytes: texto.length });
      return new Response(texto, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    } finally {
      emVoo--;
    }
  };
  globalThis.fetch = falso as typeof fetch;
  return { pedidos, maxEmVoo: () => maxEmVoo, restaurar: () => { globalThis.fetch = original; } };
}

const FIXTURA: Record<string, Anexo[]> = {
  M1: [
    { tipo: 'arquivo', id: 'f1', nome: 'BL.pdf', bytes: 300 * KB },
    { tipo: 'item', id: 'i1', nome: 'Fwd 1', assunto: 'Assunto encaminhado 1', corpo: 'Corpo sintético 1 IM0001' },
    { tipo: 'arquivo', id: 'f2', nome: 'Invoice.pdf', bytes: 300 * KB },
    { tipo: 'item', id: 'i2', nome: 'Fwd 2', assunto: 'Assunto 2', resumo: 'Só o resumo 2' },
  ],
  M2: [{ tipo: 'arquivo', id: 'f3', nome: 'Packing.pdf', bytes: 200 * KB }],
  M3: [{ tipo: 'item', id: 'i3', nome: 'Vazio', assunto: '', corpo: '' }],
  M4: [],
};

test('G-01 equivalência: o texto dos e-mails encaminhados como anexo é o mesmo da implementação anterior', async () => {
  const g = grafoFalso(FIXTURA);
  try {
    for (const mid of Object.keys(FIXTURA)) {
      assert.deepEqual(await getItemAttachmentTexts('token-sintetico', mid), await textosComoAntes('token-sintetico', mid), mid);
    }
    assert.deepEqual(await getItemAttachmentTexts('token-sintetico', 'M1'), [
      'Assunto encaminhado 1\nCorpo sintético 1 IM0001',
      'Assunto 2\nSó o resumo 2',
    ]);
  } finally {
    g.restaurar();
  }
});

test('G-02 só metadados na listagem e só os itemAttachment são abertos: nenhum PDF é baixado', async () => {
  const g = grafoFalso(FIXTURA);
  try {
    await getItemAttachmentTexts('token-sintetico', 'M1');
    const novos = g.pedidos.splice(0);
    assert.deepEqual(novos.map((p) => p.caminho), [
      '/v1.0/me/messages/M1/attachments',
      '/v1.0/me/messages/M1/attachments/i1',
      '/v1.0/me/messages/M1/attachments/i2',
    ], 'uma listagem + um pedido por e-mail anexado; nenhum pedido aos arquivos f1/f2');
    assert.equal(novos[0].select, 'id,name,contentType,size,isInline');
    assert.equal(novos[0].expand, null, 'a listagem não expande nada');
    assert.equal(novos[1].expand, 'microsoft.graph.itemAttachment/item');
    await textosComoAntes('token-sintetico', 'M1');
    const antes = g.pedidos.splice(0).reduce((s, p) => s + p.bytes, 0);
    const depois = novos.reduce((s, p) => s + p.bytes, 0);
    assert.ok(antes > 800 * KB, `antes trafegavam os PDFs em base64 (${antes} bytes)`);
    assert.ok(depois < 2 * KB, `depois só metadados e o texto (${depois} bytes)`);
  } finally {
    g.restaurar();
  }
});

test('G-03 falhas seguem a regra de antes: listagem ou leitura do anexo com erro → [] (best-effort)', async () => {
  const g = grafoFalso(FIXTURA, { falhas: new Set(['M2', 'M1/i2']) });
  try {
    assert.deepEqual(await getItemAttachmentTexts('token-sintetico', 'M2'), []);
    assert.deepEqual(await textosComoAntes('token-sintetico', 'M2'), [], 'antes: a mesma falha também dava []');
    assert.deepEqual(await getItemAttachmentTexts('token-sintetico', 'M1'), []);
  } finally {
    g.restaurar();
  }
});

test('G-04 e-mail sem e-mail anexado: um único pedido de metadados', async () => {
  const g = grafoFalso(FIXTURA);
  try {
    assert.deepEqual(await getItemAttachmentTexts('token-sintetico', 'M2'), []);
    assert.deepEqual(await getItemAttachmentTexts('token-sintetico', 'M4'), []);
    assert.deepEqual(g.pedidos.map((p) => p.caminho), ['/v1.0/me/messages/M2/attachments', '/v1.0/me/messages/M4/attachments']);
  } finally {
    g.restaurar();
  }
});

/* ------------------------------ rotas: no máximo 5 por vez, todos processados ------------------------------ */

const auth: RequestHandler = (req, _res, next) => { (req as any).accessToken = 'token-sintetico'; next(); };
const resumo = (i: number) => ({
  id: `MSG${String(i).padStart(2, '0')}`, conversationId: `CONV${i}`, subject: `Courier sintético ${i}`,
  from: { emailAddress: { address: 'agente@exemplo.example', name: 'Agente' } },
  receivedDateTime: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(), bodyPreview: 'Demurrage container MSKU0000001',
  body: { contentType: 'text', content: 'Demurrage container MSKU0000001' }, isRead: false, hasAttachments: true, webLink: 'https://outlook.exemplo.example/m',
});

function espiaoDeAnexos(atrasoMs: number) {
  let emVoo = 0;
  let max = 0;
  const chamados: string[] = [];
  const f = async (_t: string, id: string) => {
    chamados.push(id);
    emVoo++;
    max = Math.max(max, emVoo);
    await new Promise((ok) => setTimeout(ok, atrasoMs));
    emVoo--;
    return [`TEXTO-${id}`];
  };
  return { f, chamados, max: () => max };
}

test('R-01 Courier (listagem): os 25 primeiros e-mails com anexo são todos lidos, no máximo 5 por vez', async () => {
  const e = espiaoDeAnexos(15);
  const router = criarCourierRouter({
    auth,
    ia: { configurada: () => false },
    graph: { searchLogisticsMessages: async () => Array.from({ length: 30 }, (_, i) => resumo(i)) as any, getItemAttachmentTexts: e.f },
  });
  const s = await servir(Router().use('/couriers', router), () => ({}));
  try {
    const r = await s.chamar('GET', '/couriers');
    assert.equal(r.status, 200);
    assert.equal(e.chamados.length, 25, 'o teto de 25 e-mails continua o mesmo');
    assert.deepEqual([...e.chamados].sort(), Array.from({ length: 25 }, (_, i) => `MSG${String(i).padStart(2, '0')}`).sort());
    assert.ok(e.max() <= 5, `no máximo 5 em voo (foram ${e.max()})`);
    assert.ok(e.max() > 1, 'continua em paralelo, só limitado');
  } finally {
    await s.fechar();
  }
});

test('R-02 Courier (análise da conversa): todos os e-mails com anexo recebem o texto encaminhado, no máximo 5 por vez', async () => {
  const e = espiaoDeAnexos(15);
  let recebidas: Array<{ id: string; body?: { content: string } }> = [];
  const mensagens = Array.from({ length: 12 }, (_, i) => ({ ...resumo(i), conversationId: 'CONV-A' }));
  const router = criarCourierRouter({
    auth,
    ia: {
      configurada: () => true,
      // Mesmo formato mínimo de análise usado nos testes do Courier (courierFatos.test.ts).
      analisar: (async (msgs: any[]) => {
        recebidas = msgs;
        return { processNumbers: [], documents: [], evidences: [], hblResolution: null, confidence: 0.9, externalReferences: [] };
      }) as any,
    },
    graph: { getConversationFull: async () => mensagens.map((m) => ({ ...m, body: { ...m.body } })) as any, getItemAttachmentTexts: e.f },
  });
  const s = await servir(Router().use('/couriers', router), () => ({}));
  try {
    const r = await s.chamar('GET', '/couriers/CONV-A/analysis');
    assert.equal(r.status, 200);
    assert.equal(e.chamados.length, 12);
    assert.ok(e.max() <= 5 && e.max() > 1, `no máximo 5 em voo (foram ${e.max()})`);
    assert.equal(recebidas.length, 12);
    for (const m of recebidas) {
      assert.ok(m.body!.content.endsWith(`\n\n--- E-mail encaminhado (anexo) ---\nTEXTO-${m.id}`), `${m.id}: o texto encaminhado entrou no corpo como antes`);
    }
  } finally {
    await s.fechar();
  }
});

test('R-03 Demurrage (aba): os 25 primeiros e-mails com anexo são todos lidos pelo Graph, no máximo 5 por vez, sem baixar PDFs', async () => {
  const mensagens = Array.from({ length: 30 }, (_, i) => resumo(i));
  const anexos: Record<string, Anexo[]> = {};
  for (const m of mensagens) {
    anexos[m.id] = [
      { tipo: 'arquivo', id: `${m.id}-pdf`, nome: 'BL.pdf', bytes: 500 * KB },
      { tipo: 'item', id: `${m.id}-fwd`, nome: 'Fwd', assunto: `Fwd ${m.id}`, corpo: 'Demurrage sintético' },
    ];
  }
  const g = grafoFalso(anexos, { atrasoMs: 10, mensagens });
  const s = await servir(Router().use('/demurrage', criarDemurrageRouter({ auth })), () => ({}));
  try {
    const r = await s.chamar('GET', '/demurrage');
    assert.equal(r.status, 200);
    const listagens = g.pedidos.filter((p) => /\/attachments$/.test(p.caminho));
    const leituras = g.pedidos.filter((p) => /\/attachments\/[^/]+$/.test(p.caminho));
    assert.equal(listagens.length, 25, 'os 25 e-mails continuam processados');
    assert.ok(listagens.every((p) => p.select === 'id,name,contentType,size,isInline'), 'listagem só de metadados');
    assert.equal(leituras.length, 25, 'um e-mail encaminhado aberto por mensagem');
    assert.ok(leituras.every((p) => p.caminho.endsWith('-fwd')), 'nenhum PDF lido');
    assert.ok(g.maxEmVoo() <= 5, `no máximo 5 pedidos ao Graph em voo (foram ${g.maxEmVoo()})`);
  } finally {
    await s.fechar();
    g.restaurar();
  }
});
