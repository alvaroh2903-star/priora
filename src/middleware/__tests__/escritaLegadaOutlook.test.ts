import '../../operacional/__tests__/ambiente'; // DATA_DIR temporário: o store legado (Courier/Demurrage) nunca toca dados reais
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { RequestHandler, Router } from 'express';
import {
  MOTIVO_ESCRITA_LEGADA_DESLIGADA,
  VARIAVEL_ESCRITA_LEGADA_OUTLOOK,
  escritaLegadaNoOutlookHabilitada,
} from '../escritaLegadaOutlook';
import { criarEmailRouter, emailRouter } from '../../routes/emailRoutes';
import { criarCourierRouter, courierRouter } from '../../routes/courierRoutes';
import { criarDemurrageRouter, demurrageRouter } from '../../routes/demurrageRoutes';
import { escritaNoOutlookHabilitada } from '../../liberacao/documentos/aplicacao/outlook';
import { DATA_DIR_TESTE } from '../../operacional/__tests__/ambiente';
import { servir } from '../../operacional/__tests__/http';

/**
 * O2.9/P3 — `PRIORA_ESCRITA_LEGADA_OUTLOOK`: as três escritas legadas no Outlook
 * da caixa (envio de e-mail, rascunho do Courier, rascunho do pedido de minuta)
 * são recusadas ANTES da autenticação, do Graph e de qualquer gravação; ligada
 * (ausente/`on`), o comportamento é o de sempre. Dados sintéticos; nenhum Graph real.
 */

const SRC = path.join(__dirname, '..', '..');
const ligada = () => true;
const desligada = () => false;

/** Registro de TUDO o que a requisição alcançou: autenticação, Graph e store. */
function cenario() {
  const chamadas: Array<{ nome: string; args: unknown[] }> = [];
  const espiao = <T>(nome: string, resposta: T) => async (...args: unknown[]) => {
    chamadas.push({ nome, args });
    return resposta;
  };
  const auth: RequestHandler = (req, _res, next) => {
    chamadas.push({ nome: 'auth', args: [] });
    (req as any).accessToken = 'token-sintetico';
    next();
  };
  const conversa = [
    { id: 'msg-caixa', from: { emailAddress: { address: 'caixa@exemplo.example', name: 'Caixa' } }, receivedDateTime: '2026-10-01T09:00:00Z' },
    { id: 'msg-agente', from: { emailAddress: { address: 'agente@exemplo.example', name: 'Agente' } }, receivedDateTime: '2026-10-01T10:00:00Z' },
  ];
  const graph = {
    listMessages: espiao('listMessages', []),
    getMessage: espiao('getMessage', { id: 'm1' }),
    sendMail: espiao('sendMail', undefined),
    getConversation: espiao('getConversation', conversa),
    getMyAddresses: espiao('getMyAddresses', ['caixa@exemplo.example']),
    createReplyDraft: espiao('createReplyDraft', { id: 'rascunho-sintetico', webLink: 'https://outlook.exemplo.example/rascunho' }),
  } as any;
  const store = {
    setMinutaSolicitada: (...args: unknown[]) => { chamadas.push({ nome: 'setMinutaSolicitada', args }); },
    logAtividade: (...args: unknown[]) => { chamadas.push({ nome: 'logAtividade', args }); },
  } as any;
  return { chamadas, auth, graph, store, nomes: () => chamadas.map((c) => c.nome) };
}

const CORPO_ENVIO = { subject: 'Assunto sintético', body: 'Corpo sintético', to: 'destino@exemplo.example', cc: 'copia@exemplo.example' };
const CORPO_RASCUNHO = { conversationId: 'conv-sintetica', body: 'Texto sintético do follow-up' };
const CORPO_MINUTA = { processo: 'IM0001', conversationId: 'conv-sintetica', cliente: 'Cliente Sintético' };

/** As três rotas, montadas como em `src/index.ts` (prefixos reais). */
function montar(c: ReturnType<typeof cenario>, escritaLegada: () => boolean): Router {
  const r = Router();
  r.use('/emails', criarEmailRouter({ auth: c.auth, graph: c.graph, escritaLegada }));
  r.use('/couriers', criarCourierRouter({ auth: c.auth, graph: c.graph, escritaLegada }));
  r.use('/demurrage', criarDemurrageRouter({ auth: c.auth, graph: c.graph, store: c.store, escritaLegada }));
  return r;
}

const ESCRITAS: Array<[string, unknown]> = [
  ['/emails/send', CORPO_ENVIO],
  ['/couriers/reply-draft', CORPO_RASCUNHO],
  ['/demurrage/solicitar-minuta', CORPO_MINUTA],
];

function comAmbiente<T>(valores: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const antes: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(valores)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return f().finally(() => {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('P3-01 leitura da flag: ausente, vazia ou "on" liga; "off" e qualquer valor não reconhecido desligam', () => {
  for (const v of [undefined, '', '  ', 'on', 'ON', ' On ']) {
    assert.equal(escritaLegadaNoOutlookHabilitada({ [VARIAVEL_ESCRITA_LEGADA_OUTLOOK]: v } as NodeJS.ProcessEnv), true, String(v));
  }
  for (const v of ['off', 'OFF', ' off ', 'false', '0', 'desligado', 'no']) {
    assert.equal(escritaLegadaNoOutlookHabilitada({ [VARIAVEL_ESCRITA_LEGADA_OUTLOOK]: v } as NodeJS.ProcessEnv), false, v);
  }
  assert.equal(escritaLegadaNoOutlookHabilitada({} as NodeJS.ProcessEnv), true, 'sem a variável = produção atual');
});

test('P3-02 desligada: as três escritas respondem 403 com o motivo estável, sem autenticação, Graph nem store', async () => {
  const c = cenario();
  const arquivosAntes = fs.readdirSync(DATA_DIR_TESTE!).sort();
  const s = await servir(montar(c, desligada), () => ({}));
  try {
    for (const [caminho, corpo] of ESCRITAS) {
      const r = await s.chamar('POST', caminho, corpo);
      assert.equal(r.status, 403, caminho);
      assert.equal(r.body.motivo, MOTIVO_ESCRITA_LEGADA_DESLIGADA, caminho);
      assert.deepEqual(Object.keys(r.body).sort(), ['error', 'motivo'], 'a recusa não expõe mais nada');
    }
    assert.deepEqual(c.nomes(), [], 'nenhuma autenticação, chamada ao Graph ou gravação no store');
    assert.deepEqual(fs.readdirSync(DATA_DIR_TESTE!).sort(), arquivosAntes, 'nenhum arquivo do store legado criado');
  } finally {
    await s.fechar();
  }
});

test('P3-03 ligada: o envio de e-mail segue idêntico (mesmo payload ao Graph, 202)', async () => {
  const c = cenario();
  const s = await servir(montar(c, ligada), () => ({}));
  try {
    const r = await s.chamar('POST', '/emails/send', CORPO_ENVIO);
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { status: 'sent' });
    assert.deepEqual(c.nomes(), ['auth', 'sendMail']);
    assert.deepEqual(c.chamadas[1].args, ['token-sintetico', {
      subject: 'Assunto sintético', body: 'Corpo sintético', contentType: undefined,
      to: ['destino@exemplo.example'], cc: ['copia@exemplo.example'], bcc: undefined, saveToSentItems: undefined,
    }]);
    const invalido = await s.chamar('POST', '/emails/send', { subject: 'x' });
    assert.equal(invalido.status, 400, 'a validação de antes continua');
  } finally {
    await s.fechar();
  }
});

test('P3-04 ligada: o rascunho do Courier segue idêntico (responde ao último e-mail do agente)', async () => {
  const c = cenario();
  const s = await servir(montar(c, ligada), () => ({}));
  try {
    const r = await s.chamar('POST', '/couriers/reply-draft', CORPO_RASCUNHO);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { draftId: 'rascunho-sintetico', webLink: 'https://outlook.exemplo.example/rascunho', repliedTo: 'msg-agente' });
    assert.deepEqual(c.nomes().sort(), ['auth', 'createReplyDraft', 'getConversation', 'getMyAddresses']);
    assert.deepEqual(c.chamadas.find((x) => x.nome === 'createReplyDraft')!.args, ['token-sintetico', 'msg-agente', 'Texto sintético do follow-up']);
  } finally {
    await s.fechar();
  }
});

test('P3-05 ligada: o pedido de minuta segue idêntico (rascunho + registro no store)', async () => {
  const c = cenario();
  const s = await servir(montar(c, ligada), () => ({}));
  try {
    const r = await s.chamar('POST', '/demurrage/solicitar-minuta', CORPO_MINUTA);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, processo: 'IM0001', via: 'draft', draftId: 'rascunho-sintetico', webLink: 'https://outlook.exemplo.example/rascunho' });
    const rascunho = c.chamadas.find((x) => x.nome === 'createReplyDraft')!;
    assert.equal(rascunho.args[1], 'msg-agente');
    assert.match(String(rascunho.args[2]), /^Prezados,\n\nReferente ao processo IM0001 \(Cliente Sintético\), solicitamos/);
    assert.deepEqual(c.chamadas.find((x) => x.nome === 'setMinutaSolicitada')!.args, ['IM0001', 'draft']);
    assert.deepEqual(c.chamadas.find((x) => x.nome === 'logAtividade')!.args, ['minuta_solicitada', 'Minuta solicitada', 'IM0001 — Cliente Sintético']);
    // Sem conversa: registro manual, sem Graph de escrita (comportamento de antes).
    const c2 = cenario();
    const s2 = await servir(montar(c2, ligada), () => ({}));
    try {
      const m = await s2.chamar('POST', '/demurrage/solicitar-minuta', { processo: 'IM0002' });
      assert.equal(m.status, 200);
      assert.equal(m.body.via, 'manual');
      assert.deepEqual(c2.nomes(), ['auth', 'setMinutaSolicitada', 'logAtividade']);
    } finally {
      await s2.fechar();
    }
  } finally {
    await s.fechar();
  }
});

test('P3-06 o escopo não foi ampliado: desligada, leituras e escritas locais que não usam o Outlook seguem iguais', async () => {
  const c = cenario();
  const s = await servir(montar(c, desligada), () => ({}));
  try {
    assert.equal((await s.chamar('GET', '/emails')).status, 200);
    assert.equal((await s.chamar('GET', '/emails/m1')).status, 200);
    const f = await s.chamar('POST', '/couriers/TRK0001SINT/followup', { processo: 'IM0001', documento: 'mbl', via: 'manual' });
    assert.equal(f.status, 200, 'o registro local de follow-up do Courier não é escrita no Outlook');
    assert.deepEqual(c.nomes(), ['auth', 'listMessages', 'auth', 'getMessage', 'auth']);
  } finally {
    await s.fechar();
  }
});

test('P3-07 fiação de produção: nos routers reais, desligada responde 403 ANTES do requireAuth; ausente, o requireAuth responde como antes', async () => {
  const real = Router();
  real.use('/emails', emailRouter);
  real.use('/couriers', courierRouter);
  real.use('/demurrage', demurrageRouter);
  const s = await servir(real, () => ({})); // sem sessão: o requireAuth real recusaria com 401
  try {
    await comAmbiente({ [VARIAVEL_ESCRITA_LEGADA_OUTLOOK]: 'off' }, async () => {
      for (const [caminho, corpo] of ESCRITAS) {
        const r = await s.chamar('POST', caminho, corpo);
        assert.equal(r.status, 403, caminho);
        assert.equal(r.body.motivo, MOTIVO_ESCRITA_LEGADA_DESLIGADA, caminho);
        assert.deepEqual(Object.keys(r.body).sort(), ['error', 'motivo'], `${caminho}: a recusa não expõe o ambiente`);
      }
    });
    await comAmbiente({ [VARIAVEL_ESCRITA_LEGADA_OUTLOOK]: undefined }, async () => {
      for (const [caminho, corpo] of ESCRITAS) {
        const r = await s.chamar('POST', caminho, corpo);
        assert.equal(r.status, 401, `${caminho}: sem a variável, chega ao requireAuth como antes`);
      }
    });
  } finally {
    await s.fechar();
  }
});

test('P3-08 independência da flag da Liberação documental (PRIORA_LIBERACAO_OUTLOOK_ESCRITA)', () => {
  const LIB = 'PRIORA_LIBERACAO_OUTLOOK_ESCRITA';
  for (const legada of [undefined, 'on', 'off']) {
    for (const lib of [undefined, 'on', 'off']) {
      const env = { [VARIAVEL_ESCRITA_LEGADA_OUTLOOK]: legada, [LIB]: lib } as NodeJS.ProcessEnv;
      assert.equal(escritaLegadaNoOutlookHabilitada(env), legada !== 'off', `legada=${legada} lib=${lib}`);
      assert.equal(escritaNoOutlookHabilitada(env), lib === 'on', `lib=${lib} legada=${legada}`);
    }
  }
  const guarda = fs.readFileSync(path.join(SRC, 'middleware', 'escritaLegadaOutlook.ts'), 'utf8');
  const liberacao = fs.readFileSync(path.join(SRC, 'liberacao', 'documentos', 'aplicacao', 'outlook.ts'), 'utf8');
  assert.ok(!guarda.includes(`'${LIB}'`) && !/process\.env\.PRIORA_LIBERACAO/.test(guarda), 'a guarda legada não lê a flag da Liberação');
  assert.ok(!liberacao.includes(VARIAVEL_ESCRITA_LEGADA_OUTLOOK), 'a Liberação não lê a flag legada');
});

test('P3-09 inventário: toda escrita do Graph no código está coberta por uma flag ou por um isolamento conhecido', () => {
  const NOMES = 'sendMail|createReplyDraft|createDraftMessage|sendDraftMessage|deleteDraftMessage';
  // Quem IMPORTA uma escrita do graphService (inclusive com alias) ou a chama por dependência injetada (`g.sendMail(`).
  const IMPORTA = new RegExp(`import\\s*\\{[^}]*\\b(${NOMES})\\b[^}]*\\}\\s*from\\s*['"][./]*graph/graphService['"]`);
  const CHAMA = new RegExp(`\\.(${NOMES})\\(`);
  const CONHECIDOS: Record<string, string> = {
    'routes/emailRoutes.ts': 'PRIORA_ESCRITA_LEGADA_OUTLOOK',
    'routes/courierRoutes.ts': 'PRIORA_ESCRITA_LEGADA_OUTLOOK',
    'routes/demurrageRoutes.ts': 'PRIORA_ESCRITA_LEGADA_OUTLOOK',
    'liberacao/documentos/aplicacao/outlook.ts': 'PRIORA_LIBERACAO_OUTLOOK_ESCRITA',
    'demurrage/alertTransportGraph.ts': 'scheduler da Demurrage (sem dados no piloto)',
    'demurrage/avisoDivergenciaTransportGraph.ts': 'scheduler da Demurrage (sem dados no piloto)',
    'demurrage/avisoFallbackManualTransportGraph.ts': 'scheduler da Demurrage (sem dados no piloto)',
  };
  const arquivos: string[] = [];
  const varrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') varrer(p); } else if (e.name.endsWith('.ts')) arquivos.push(p);
    }
  };
  varrer(SRC);
  const encontrados = arquivos
    .map((p) => path.relative(SRC, p).split(path.sep).join('/'))
    .filter((rel) => rel !== 'graph/graphService.ts')
    .filter((rel) => {
      const fonte = fs.readFileSync(path.join(SRC, rel), 'utf8');
      return IMPORTA.test(fonte) || fonte.split('\n').some((l) => CHAMA.test(l) && !/^\s*(\*|\/\/)/.test(l));
    });
  assert.deepEqual(encontrados.filter((rel) => !(rel in CONHECIDOS)), [], 'caminho NOVO de escrita no Graph: decidir a flag antes de seguir');
  assert.deepEqual([...encontrados].sort(), Object.keys(CONHECIDOS).sort(), 'o inventário é exato (inclusive imports com alias)');
  for (const rel of ['routes/emailRoutes.ts', 'routes/courierRoutes.ts', 'routes/demurrageRoutes.ts']) {
    assert.ok(encontrados.includes(rel), `${rel} continua no inventário`);
    assert.match(fs.readFileSync(path.join(SRC, rel), 'utf8'), /exigirEscritaLegadaNoOutlook\(/, `${rel} registra a guarda`);
  }
});
