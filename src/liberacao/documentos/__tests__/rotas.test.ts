import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { NextFunction, Response } from 'express';
import { AddressInfo } from 'net';
import { criarDocumentosRouter } from '../../../routes/documentosRoutes';
import { AuthedRequest } from '../../../middleware/requireAuth';
import { AcessoDaPessoa } from '../../../auth/pessoa';
import { sha256 } from '..';
import {
  ANALISTA, CLIENTE, ORG, OUTRO_ANALISTA, SIGNATARIO_SINTETICO, TERCEIRO_ANALISTA, assinadoSintetico, cenarioDocumental, definicaoEvergreen, definicaoMemorando, valor,
} from './fixtures';

/**
 * Rotas HTTP dos documentos (S4): portão de rollout, pessoa interna, organização
 * do servidor, PDF preparado e assinado, e o Outlook da PRÓPRIA pessoa. Tudo em
 * memória: autenticação, repositório e Outlook são simulados.
 */

const MASTER_UUID = '11111111-1111-4111-8111-111111111111';
const pessoa = (p: Partial<AcessoDaPessoa> = {}): AcessoDaPessoa => ({
  usuarioId: 'u-1', homeAccountId: 'conta-analista', nome: 'Analista', membershipId: ANALISTA, papel: 'ANALYST', organizationId: ORG, caixaId: 'caixa-1', ...p,
});

async function subir(p: { habilitado?: boolean; acesso?: AcessoDaPessoa | null; outlook?: boolean; grieg?: boolean; comSignatario?: boolean } = {}) {
  const quemAssina = { id: 'nome', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' } as const;
  const com = <D extends { campos: ReadonlyArray<unknown> }>(d: D) => (p.comSignatario ? { campos: [...d.campos, quemAssina] } : {});
  const c = await cenarioDocumental({
    armador: { masterId: MASTER_UUID, codigo: p.grieg ? 'EVERGREEN' : 'MSC' }, idsUuid: true,
    defs: p.grieg ? { TERMO_EVERGREEN: definicaoEvergreen(com(definicaoEvergreen()) as never) }
      : { MEMORANDO_MSC: definicaoMemorando('MEMORANDO_MSC', com(definicaoMemorando('MEMORANDO_MSC')) as never) },
    valores: [
      valor('MBL', 'MBLSINTETICO0001', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER_UUID }),
      valor('NOME_DO_NAVIO', 'NAVIO SINTETICO', 'S3_VIAGEM', { tipo: 'MASTER', masterId: MASTER_UUID }),
    ],
  });
  let acesso = p.acesso === undefined ? pessoa() : p.acesso;
  const app = express();
  app.use(express.json());
  app.use('/api/liberacao/documentos', criarDocumentosRouter({
    habilitado: () => p.habilitado ?? true,
    auth: (req: AuthedRequest, _res: Response, next: NextFunction) => { if (acesso) { req.pessoa = acesso; req.accessToken = 'token-da-caixa'; } next(); },
    documentos: () => c.deps,
    outlookDaPessoa: async () => (p.outlook ? { tipo: 'DISPONIVEL', outlook: c.outlook } : { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' }),
    caixaMonitorada: () => c.caixa,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/liberacao/documentos`;
  return {
    c, base, fechar: () => new Promise<void>((ok) => server.close(() => ok())), mudarAcesso: (a: AcessoDaPessoa | null) => { acesso = a; },
  };
}

const json = (corpo: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
const campos = (s: { c: Awaited<ReturnType<typeof cenarioDocumental>> }) =>
  (s.c.repo.m.documentos.at(-1)!.plano as { conteudo: { campos: Array<{ campo: string; valor: string }> } }).conteudo.campos;

test('[ROTA-01] portão: rollout desligado → 404; sem pessoa → 403; CLIENT → 403', async () => {
  const desligado = await subir({ habilitado: false });
  assert.equal((await fetch(`${desligado.base}/masters/${MASTER_UUID}`)).status, 404);
  await desligado.fechar();
  const s = await subir({ acesso: null });
  assert.equal((await fetch(`${s.base}/masters/${MASTER_UUID}`)).status, 403);
  s.mudarAcesso(pessoa({ papel: 'CLIENT', membershipId: CLIENTE }));
  assert.equal((await fetch(`${s.base}/masters/${MASTER_UUID}`)).status, 403);
  await s.fechar();
});

test('[ROTA-02] DOC-31 pela API (MSC): preparar → ver/baixar o PDF e parar; sem upload, conferência ou envio; baixar não grava nada; autor e organização da sessão', async () => {
  const s = await subir({ comSignatario: true });
  try {
    assert.equal((await fetch(`${s.base}/masters/nao-e-uuid`)).status, 404);
    const r = await fetch(`${s.base}/masters/${MASTER_UUID}/preparar`, json({ escolhas: [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: 'm-forjado' }] }));
    const preparo = await r.json() as { tipo: string; documentoId: string };
    assert.deepEqual([r.status, preparo.tipo], [200, 'PREPARADO']);
    const doc = s.c.repo.m.documentos[0];
    assert.equal(doc.preparadoPor, ANALISTA);
    assert.equal(doc.escolhas[0].por, ANALISTA, 'o autor da escolha vem da sessão, nunca do corpo');
    // Situação do fluxo A: modelo, dados preenchidos, opções e versões — e só. Nada de assinatura, conferência ou envio.
    type Sit = Record<string, unknown> & { procedimento: string; situacao: { proximoPasso: { passo: string; documentoId: string }; pendencias: unknown[]; preenchimento: { tipo: string } } };
    const resposta = await fetch(`${s.base}/masters/${MASTER_UUID}`);
    assert.equal(resposta.headers.get('cache-control'), 'private, no-store');
    const sit = await resposta.json() as Sit;
    assert.deepEqual([sit.procedimento, sit.situacao.proximoPasso, sit.situacao.pendencias, sit.situacao.preenchimento.tipo],
      ['GERAR_E_DISPONIBILIZAR', { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId: preparo.documentoId }, [], 'PRONTO']);
    // O1.8: + a identidade do consignatário conferida pelo CNPJ (só informa; nada de assinatura, conferência do arquivo ou envio).
    assert.deepEqual(Object.keys(sit).sort(), ['documentos', 'identidadeDoConsignatario', 'procedimento', 'signatarioLegal', 'situacao', 'tipo']);
    assert.equal(campos(s).find((x) => x.campo === 'nome')?.valor, SIGNATARIO_SINTETICO.nome, 'os campos de quem assina continuam preenchidos pelo cadastro');
    // Baixar e visualizar: o PDF preparado, com o hash da versão; nenhuma gravação.
    const antes = JSON.stringify([s.c.repo.m.documentos.length, s.c.repo.m.assinaturas, s.c.repo.m.conferencias, s.c.repo.m.tentativas, s.c.repo.m.eventosDoEnvio]);
    const arq = await fetch(`${s.base}/arquivos/${preparo.documentoId}`);
    assert.deepEqual([arq.headers.get('content-type'), arq.headers.get('content-disposition')?.split(';')[0], arq.headers.get('x-priora-arquivo-sha256'), arq.headers.get('cache-control')],
      ['application/pdf', 'attachment', doc.arquivoSha256, 'private, no-store']);
    const bytes = Buffer.from(await arq.arrayBuffer());
    assert.equal(sha256(new Uint8Array(bytes)), doc.arquivoSha256);
    const ver = await fetch(`${s.base}/arquivos/${preparo.documentoId}?modo=visualizar`);
    assert.deepEqual([ver.status, ver.headers.get('content-disposition')?.split(';')[0]], [200, 'inline']);
    await ver.arrayBuffer();
    assert.equal(JSON.stringify([s.c.repo.m.documentos.length, s.c.repo.m.assinaturas, s.c.repo.m.conferencias, s.c.repo.m.tentativas, s.c.repo.m.eventosDoEnvio]), antes,
      'ver/baixar não registra assinatura, envio nem nada');
    // O Analista assina e encaminha fora da Priora: upload e conferência recusados.
    const up = await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.from(assinadoSintetico('MEMORANDO ASSINADO')) });
    assert.deepEqual([up.status, ((await up.json()) as { motivo: string }).motivo], [422, 'FLUXO_NAO_APLICAVEL']);
    const conf = await fetch(`${s.base}/arquivos/${preparo.documentoId}/conferencia`, json({ assinaturaId: '00000000-0000-4000-8000-000000000001', arquivoSha256: 'a'.repeat(64), resultado: 'CONFORME' }));
    assert.deepEqual([conf.status, ((await conf.json()) as { motivo: string }).motivo], [422, 'FLUXO_NAO_APLICAVEL']);
    assert.deepEqual([s.c.repo.m.assinaturas.length, s.c.repo.m.conferencias.length], [0, 0]);
    s.mudarAcesso(pessoa({ organizationId: 'outra-org' }));
    assert.equal((await fetch(`${s.base}/arquivos/${preparo.documentoId}`)).status, 404);
    assert.equal((await fetch(`${s.base}/arquivos/${preparo.documentoId}?modo=visualizar`)).status, 404);
  } finally {
    await s.fechar();
  }
});

test('[ROTA-03] rascunho, envio e conciliação exigem o Outlook da PRÓPRIA pessoa conectado; nada é chamado sem ele', async () => {
  const s = await subir({ outlook: false });
  try {
    const r = await fetch(`${s.base}/masters/${MASTER_UUID}/rascunho`, json({}));
    assert.deepEqual([r.status, ((await r.json()) as { motivo: string }).motivo], [409, 'NAO_CONECTADO']);
    const e = await fetch(`${s.base}/envios/00000000-0000-4000-8000-000000000999/conciliar`, json({}));
    assert.equal(e.status, 409);
    assert.deepEqual(s.c.outlook.chamadas, [], 'nada foi chamado no Outlook');
  } finally {
    await s.fechar();
  }
  const g = await subir({ outlook: true });
  try {
    // MSC não tem solicitação de agendamento (é fluxo da Grieg).
    const r = await fetch(`${g.base}/masters/${MASTER_UUID}/rascunho`, json({}));
    assert.deepEqual([r.status, ((await r.json()) as { motivo: string }).motivo], [422, 'FLUXO_NAO_APLICAVEL']);
    const m = await fetch(`${g.base}/envios/00000000-0000-4000-8000-000000000999/conciliacao-manual`, json({ justificativa: 'x', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }));
    assert.deepEqual([m.status, ((await m.json()) as { motivo: string }).motivo], [422, 'TENTATIVA_INEXISTENTE']);
  } finally {
    await g.fechar();
  }
});

test('[ROTA-04] Grieg pela API: termo preparado e assinado, Outlook conectado, mas a permissão da ação na L1b não tem fonte → nenhum rascunho é criado', async () => {
  const s = await subir({ grieg: true, outlook: true });
  try {
    const preparo = await (await fetch(`${s.base}/masters/${MASTER_UUID}/preparar`, json({}))).json() as { documentoId: string };
    const assinado = assinadoSintetico('TERMO ASSINADO');
    const a = await (await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.from(assinado) })).json() as { assinaturaId: string };
    // Sem conferência, o termo assinado ainda não pode ir no e-mail.
    const antes = await (await fetch(`${s.base}/masters/${MASTER_UUID}/rascunho`, json({}))).json() as { avaliacao: { motivos: string[] } };
    assert.ok(antes.avaliacao.motivos.includes('CONFERENCIA_DA_ASSINATURA_PENDENTE'), JSON.stringify(antes));
    await fetch(`${s.base}/arquivos/${preparo.documentoId}/conferencia`, json({ assinaturaId: a.assinaturaId, arquivoSha256: sha256(assinado), resultado: 'CONFORME' }));
    const r = await fetch(`${s.base}/masters/${MASTER_UUID}/rascunho`, json({}));
    const corpo = await r.json() as { motivo: string; avaliacao: { motivos: string[] } };
    assert.deepEqual([r.status, corpo.motivo, corpo.avaliacao.motivos], [422, 'BLOQUEADO', ['PERMISSAO_DA_ACAO_NAO_DETERMINADA']]);
    assert.deepEqual(s.c.outlook.chamadas, []);
    assert.equal(s.c.repo.m.tentativas.length, 0);
  } finally {
    await s.fechar();
  }
});

test('[ROTA-05] DOC-22/23/24/25 pela API (termo Evergreen — ciclo completo): A prepara, B anexa, C confere; o signatário é o legal; substituição só com justificativa; cada papel com o seu autor', async () => {
  const s = await subir({ grieg: true, comSignatario: true });
  const pdfBody = (b: Uint8Array, h: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/pdf', ...h }, body: Buffer.from(b) });
  try {
    const preparo = await (await fetch(`${s.base}/masters/${MASTER_UUID}/preparar`, json({ assumirComoSignatario: true }))).json() as { documentoId: string };
    assert.equal(campos(s).find((x) => x.campo === 'nome')?.valor, SIGNATARIO_SINTETICO.nome, 'o signatário legal, nunca a pessoa da sessão');
    // B anexa (não precisa ter preparado); outro arquivo para a mesma versão só como substituição justificada.
    s.mudarAcesso(pessoa({ membershipId: OUTRO_ANALISTA, homeAccountId: 'conta-outro' }));
    const a1 = await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, pdfBody(assinadoSintetico('ARQUIVO 1')));
    assert.equal(a1.status, 200);
    const sem = await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, pdfBody(assinadoSintetico('ARQUIVO 2')));
    assert.deepEqual([sem.status, ((await sem.json()) as { motivo: string }).motivo], [422, 'SUBSTITUICAO_SEM_JUSTIFICATIVA']);
    const mal = await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, pdfBody(assinadoSintetico('ARQUIVO 2'), {
      'X-Priora-Substituicao-Motivo': 'OUTRO', 'X-Priora-Substituicao-Justificativa': '%E0%A4%A',
    }));
    assert.deepEqual([mal.status, ((await mal.json()) as { motivo: string }).motivo], [422, 'JUSTIFICATIVA_MAL_CODIFICADA']);
    const a2 = await fetch(`${s.base}/arquivos/${preparo.documentoId}/assinatura`, pdfBody(assinadoSintetico('ARQUIVO 2'), {
      'X-Priora-Substituicao-Motivo': 'OUTRO', 'X-Priora-Substituicao-Justificativa': encodeURIComponent('Arquivo reexportado após revisão'),
    }));
    const r2 = await a2.json() as { assinaturaId: string; substituicao: { motivo: string; justificativa: string } };
    assert.deepEqual([a2.status, r2.substituicao.motivo, r2.substituicao.justificativa], [200, 'OUTRO', 'Arquivo reexportado após revisão']);
    // C confere e recusa com a constatação (o que viu no leitor de PDF).
    s.mudarAcesso(pessoa({ membershipId: TERCEIRO_ANALISTA, homeAccountId: 'conta-terceiro' }));
    const k = await fetch(`${s.base}/arquivos/${preparo.documentoId}/conferencia`, json({
      assinaturaId: r2.assinaturaId, arquivoSha256: sha256(assinadoSintetico('ARQUIVO 2')), resultado: 'NAO_CONFORME', constatacao: 'SIGNATARIO_DIFERENTE_DO_ESPERADO',
      observacao: 'certificado de outra pessoa',
    }));
    assert.equal(k.status, 200);
    const sit = await (await fetch(`${s.base}/masters/${MASTER_UUID}`)).json() as {
      procedimento: string;
      signatarioLegal: { tipo: string; signatario: { signatarioId: string; nome: string } };
      rastreabilidade: Array<{ preparacao: { por: string }; signatario: unknown; arquivosAssinados: Array<{ operador: string; vigente: boolean }>; conferencias: Array<{ conferente: string; constatacao: string }> }>;
      situacao: { proximoPasso: { passo: string } };
    };
    assert.equal(sit.procedimento, 'CICLO_COMPLETO');
    assert.deepEqual(sit.signatarioLegal, { tipo: 'DEFINIDO', signatario: { signatarioId: SIGNATARIO_SINTETICO.signatarioId, nome: SIGNATARIO_SINTETICO.nome } });
    assert.ok(!JSON.stringify(sit.signatarioLegal).includes(SIGNATARIO_SINTETICO.cpf), 'o cadastro (CPF) do signatário não sai pela situação');
    const p = sit.rastreabilidade[0];
    assert.deepEqual([p.preparacao.por, p.arquivosAssinados.map((x) => [x.operador, x.vigente]), p.conferencias.map((x) => [x.conferente, x.constatacao])],
      [ANALISTA, [[OUTRO_ANALISTA, false], [OUTRO_ANALISTA, true]], [[TERCEIRO_ANALISTA, 'SIGNATARIO_DIFERENTE_DO_ESPERADO']]]);
    assert.equal(sit.situacao.proximoPasso.passo, 'SUBSTITUIR_ARQUIVO_ASSINADO');
    // O pedido antigo de "assumir como signatário" não existe mais: preparar de novo não muda quem assina.
    assert.equal(s.c.repo.m.documentos.length, 1);
  } finally {
    await s.fechar();
  }
});
