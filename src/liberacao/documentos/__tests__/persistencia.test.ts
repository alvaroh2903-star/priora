import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { preparar, vincular } from '../../aplicacao/__tests__/apoio';
import {
  DefinicaoDoModelo, DepsDocumentos, TipoDocumento, avaliarDocumentacao, cadastrarModelo, conciliarEnvio, conferirAssinatura, decidirSinalDeRejeicao, fontesConfiaveisPostgres,
  prepararDocumento, prepararRascunho, registrarAssinatura, registrarSinalDeRejeicao, repositorioDocumentalPostgres, sha256, validarModelo,
} from '..';
import {
  GERADOR_DE_TESTE, PERMITIDA, SIGNATARIO_COM_PODERES, arquivoSintetico, assinadoSintetico, caixaMonitoradaFalsa, definicaoEvergreen, definicaoMemorando, destinatarios,
  outlookFalso, pdf, relogio, texto,
} from './fixtures';

/**
 * Persistência e rastreabilidade (migration 0104) com os fatos REAIS dos donos
 * (S6, S2, S4) gravados pelos caminhos deles. Só o armador (sem produtor
 * ainda), o modelo (sintético), o gerador (MOCK) e o Outlook/caixa (falsos)
 * são simulados. Exige o preflight do banco.
 */

const url = testDatabaseUrl();
const MBL = 'EGLV123456789012';

/** Modelo sintético com um campo de processo além do MBL e da data. */
const definicao = (): DefinicaoDoModelo => definicaoEvergreen({
  campos: [
    { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
    { id: 'im', rotulo: 'Processo', dado: 'CODIGO_DO_PROCESSO', obrigatorio: true, fontesAceitas: ['S6_PROCESSO'], escopo: 'PROCESSO' },
    { id: 'data', rotulo: 'Data', dado: 'DATA_DA_GERACAO', obrigatorio: true, fontesAceitas: ['GERACAO'], escopo: 'DOCUMENTO' },
  ],
});

interface Mundo {
  c: Cenario; slug: string; masterId: string; processoId: string; deps: DepsDocumentos; ator: { organizationId: string; membershipId: string }; modeloId: string;
}

async function mundo(pool: Pool, slug: string, p: { validar?: boolean; definicao?: DefinicaoDoModelo; armador?: string } = {}): Promise<Mundo> {
  const c = await cenario(pool, slug);
  await vincular(pool, c, 'IM100', MBL);
  const v = (await pool.query(`SELECT processo_id, master_id FROM processo_master_vinculos WHERE organization_id = $1`, [c.orgId])).rows[0];
  const deps: DepsDocumentos = {
    repo: repositorioDocumentalPostgres(pool), fontes: fontesConfiaveisPostgres(pool),
    armador: { armadorDoMaster: async (_org, m) => (m === v.master_id ? { masterId: m, codigo: p.armador ?? 'EVERGREEN' } : null) },
    gerador: GERADOR_DE_TESTE, destinatarios: { daAgencia: async () => destinatarios(), remetentesConfiaveis: async () => null }, relogio: relogio(),
  };
  const ator = { organizationId: c.orgId, membershipId: c.membershipPessoa };
  const tipo: TipoDocumento = p.definicao?.tipo ?? 'TERMO_EVERGREEN';
  const r = await cadastrarModelo(deps, ator, { tipo, versao: 'sintetica-1', arquivo: arquivoSintetico(tipo, slug), definicao: p.definicao ?? definicao() });
  const modeloId = (r as { modeloId: string }).modeloId;
  if (p.validar !== false) assert.equal((await validarModelo(deps, ator, modeloId)).tipo, 'OK');
  return { c, slug, masterId: v.master_id, processoId: v.processo_id, deps, ator, modeloId };
}

const outlookDe = (m: Mundo) => outlookFalso(m.c.membershipPessoa, `home-pessoa-${m.slug}`);
const caixaDe = (m: Mundo) => {
  const caixa = caixaMonitoradaFalsa(m.c.caixaId);
  caixa.anexos[`msg-IM100-${MBL}|anexo-${MBL}`] = { nome: 'MBL.pdf', contentType: 'application/pdf', bytes: pdf(`MBL ${MBL}`) };
  return caixa;
};

const falha = async (p: Promise<unknown>, padrao: RegExp) => assert.rejects(p, (e: Error) => padrao.test(e.message));
const APPEND_ONLY = /append-only|nao e permitido/;

/** Preparado, com o arquivo assinado (sintético) anexado e conferido (DOC-24). */
async function assinado(m: Mundo, conteudo = 'ASSINADO') {
  const { documentoId } = (await prepararDocumento(m.deps, m.ator, m.masterId)) as { documentoId: string };
  const arquivo = assinadoSintetico(`${conteudo} ${m.slug}`);
  const { assinaturaId } = (await registrarAssinatura(m.deps, m.ator, documentoId, arquivo)) as { assinaturaId: string };
  const k = await conferirAssinatura(m.deps, m.ator, documentoId, { assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
  assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA', JSON.stringify(k));
  return { documentoId, assinaturaId };
}

test('documentos de apresentação — PostgreSQL', { skip: !url && 'DEMURRAGE_TEST_DATABASE_URL não definida' }, async (t) => {
  const pool = testPool();
  await preparar(pool);
  try {
    await t.test('[DB-01] leitores dos donos: processos (S2), MBL e código do processo (S6), cópia do MBL (S2), papel e contas (S4)', async () => {
      const m = await mundo(pool, 'doc-db-01');
      const f = m.deps.fontes;
      assert.deepEqual(await f.processosDoMaster(m.c.orgId, m.masterId), [m.processoId]);
      const valores = await f.valores(m.c.orgId, m.masterId, [m.processoId], [{ dado: 'MBL', fonte: 'S6_MASTER' }, { dado: 'CODIGO_DO_PROCESSO', fonte: 'S6_PROCESSO' }, { dado: 'NOME_DO_NAVIO', fonte: 'S3_VIAGEM' }]);
      assert.deepEqual(valores.map((v) => [v.dado, v.valor, v.fonte]), [['MBL', MBL, 'S6_MASTER'], ['CODIGO_DO_PROCESSO', 'IM100', 'S6_PROCESSO']]);
      assert.match(valores[0].evidencia.ref, /^master_referencia:/);
      const copias = await f.copiasDoMbl(m.c.orgId, m.masterId);
      assert.deepEqual(copias.map((x) => [x.caixaId, x.messageId, x.attachmentId, x.contentType]), [[m.c.caixaId, `msg-IM100-${MBL}`, `anexo-${MBL}`, 'application/pdf']]);
      assert.equal(await f.papelDaPessoa(m.c.orgId, m.c.membershipCliente), 'CLIENT');
      assert.equal(await f.contaMicrosoftDaPessoa(m.c.orgId, m.c.membershipPessoa), `home-pessoa-doc-db-01`);
      assert.equal(await f.contaDaCaixaMonitorada(m.c.orgId, m.c.caixaId), `home-caixa-doc-db-01`);
      assert.deepEqual(await f.modalidadeDoMaster(m.c.orgId, m.masterId), { tipo: 'DESCONHECIDA' });
    });

    await t.test('[DB-02] versões de modelo: cadastro pendente, validação humana, idempotência pelo arquivo; transições e imutabilidade no banco', async () => {
      const m = await mundo(pool, 'doc-db-02', { validar: false });
      const linha = async () => (await pool.query(`SELECT * FROM documentos_apresentacao_modelos WHERE id = $1`, [m.modeloId])).rows[0];
      assert.equal((await linha()).estado, 'PENDENTE_DE_VALIDACAO');
      assert.equal((await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId)).situacao.proximoPasso?.passo, 'VALIDAR_VERSAO_DO_MODELO');
      const de_novo = await cadastrarModelo(m.deps, m.ator, { tipo: 'TERMO_EVERGREEN', versao: 'outra', arquivo: arquivoSintetico('TERMO_EVERGREEN', 'doc-db-02') });
      assert.deepEqual(de_novo, { tipo: 'OK', modeloId: m.modeloId, novo: false });
      assert.equal((await validarModelo(m.deps, m.ator, m.modeloId)).tipo, 'OK');
      const v = await linha();
      assert.deepEqual([v.estado, v.validado_por_membership_id], ['VALIDADO', m.c.membershipPessoa]);
      const eventos = (await pool.query(`SELECT tipo FROM documentos_apresentacao_eventos WHERE modelo_id = $1 ORDER BY sequencia`, [m.modeloId])).rows.map((r) => r.tipo);
      assert.deepEqual(eventos, ['MODELO_CADASTRADO', 'MODELO_VALIDADO']);
      await falha(pool.query(`UPDATE documentos_apresentacao_modelos SET estado = 'PENDENTE_DE_VALIDACAO', validado_em = NULL, validado_por_membership_id = NULL WHERE id = $1`, [m.modeloId]), /transição VALIDADO/);
      await falha(pool.query(`UPDATE documentos_apresentacao_modelos SET definicao = '{}' WHERE id = $1`, [m.modeloId]), /só a leitura de uma versão pendente/);
      await falha(pool.query(`UPDATE documentos_apresentacao_modelos SET arquivo = '\\x25504446' WHERE id = $1`, [m.modeloId]), /imutáveis/);
      await falha(pool.query(`DELETE FROM documentos_apresentacao_modelos WHERE id = $1`, [m.modeloId]), /não pode ser apagada/);
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao_modelos (organization_id, tipo, versao, arquivo, arquivo_sha256, origem, cadastrado_em)
         VALUES ($1, 'TERMO_EVERGREEN', 'sub', '\\x25504446', $2, 'SUBSTITUTO_DA_AGENCIA', now())`, [m.c.orgId, 'e'.repeat(64)]), /modelos_origem/);
    });

    await t.test('[DB-03] preparação persistida e rastreável (versão do modelo, conteúdo, proveniência, processos); idempotente e append-only', async () => {
      const m = await mundo(pool, 'doc-db-03');
      const r = await prepararDocumento(m.deps, m.ator, m.masterId);
      assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
      const row = (await pool.query(`SELECT * FROM documentos_apresentacao WHERE organization_id = $1`, [m.c.orgId])).rows[0];
      assert.deepEqual([row.modelo_id, row.arquivo_sha256], [m.modeloId, sha256(row.arquivo)]);
      assert.ok(texto(row.arquivo).includes(MBL) && texto(row.arquivo).includes('IM100'));
      assert.deepEqual(row.proveniencia.map((x: { fontes: Array<{ fonte: string }> }) => x.fontes[0].fonte), ['S6_MASTER', 'S6_PROCESSO', 'GERACAO']);
      assert.deepEqual((await pool.query(`SELECT processo_id FROM documentos_apresentacao_processos WHERE documento_id = $1`, [row.id])).rows.map((x) => x.processo_id), [m.processoId]);
      assert.equal(((await prepararDocumento(m.deps, m.ator, m.masterId)) as { novo: boolean }).novo, false);
      assert.equal(await contar(pool, `SELECT count(*) n FROM documentos_apresentacao WHERE organization_id = $1`, [m.c.orgId]), 1);
      await falha(pool.query(`UPDATE documentos_apresentacao SET gerador = 'x' WHERE id = $1`, [row.id]), APPEND_ONLY);
      await falha(pool.query(`DELETE FROM documentos_apresentacao_processos WHERE documento_id = $1`, [row.id]), APPEND_ONLY);
    });

    await t.test('[DB-04] assinatura: nunca o PDF preparado (gatilho), nunca um arquivo reaproveitado (único), append-only', async () => {
      const m = await mundo(pool, 'doc-db-04');
      const { documentoId } = (await prepararDocumento(m.deps, m.ator, m.masterId)) as { documentoId: string };
      const preparado: Buffer = (await pool.query(`SELECT arquivo FROM documentos_apresentacao WHERE id = $1`, [documentoId])).rows[0].arquivo;
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao_assinaturas (organization_id, documento_id, arquivo, arquivo_sha256, registrado_por_membership_id, registrado_em) VALUES ($1, $2, $3, $4, $5, now())`,
        [m.c.orgId, documentoId, preparado, sha256(preparado), m.c.membershipPessoa]), /idêntico ao PDF preparado/);
      const arquivo = pdf('ASSINADO DB-04');
      assert.equal((await registrarAssinatura(m.deps, m.ator, documentoId, arquivo)).tipo, 'REGISTRADA');
      assert.deepEqual(await registrarAssinatura(m.deps, m.ator, documentoId, arquivo, { substituicao: { motivo: 'OUTRO', justificativa: 'de novo' } }),
        { tipo: 'RECUSADA', motivo: 'ARQUIVO_JA_REGISTRADO' });
      await falha(pool.query(`UPDATE documentos_apresentacao_assinaturas SET arquivo_sha256 = $2 WHERE documento_id = $1`, [documentoId, 'f'.repeat(64)]), APPEND_ONLY);
    });

    await t.test('[DB-05] solicitação de agendamento: rascunho do Analista, envio confirmado pela conciliação, eventos em ordem; garantias do banco', async () => {
      const m = await mundo(pool, 'doc-db-05');
      const { documentoId, assinaturaId } = await assinado(m);
      const outlook = outlookDe(m);
      const r = await prepararRascunho(m.deps, m.ator, m.masterId, { outlook, caixaMonitorada: caixaDe(m) }, { autorizacao: PERMITIDA });
      assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
      const envioId = (r as { envioId: string }).envioId;
      const rascunhoId = (r as { rascunho: { id: string } }).rascunho.id;
      outlook.enviarPeloOutlook(rascunhoId);
      assert.equal((await conciliarEnvio(m.deps, m.ator, envioId, outlook)).tipo, 'ENVIO_CONFIRMADO');
      const e = (await pool.query(`SELECT * FROM documentos_apresentacao_envios WHERE id = $1`, [envioId])).rows[0];
      assert.deepEqual([e.estado, e.documento_id, e.assinatura_id, e.modelo_id, e.analista_conta_microsoft], ['ENVIO_CONFIRMADO', documentoId, assinaturaId, m.modeloId, 'home-pessoa-doc-db-05']);
      assert.equal(e.composicao.assunto, `Solicitação de agendamento de apresentação de BL – ${MBL}`);
      assert.deepEqual([e.confirmacao.internetMessageId, e.confirmacao.conferencia], [`<${rascunhoId}@teste>`, { tipo: 'CONFORME' }]);
      assert.deepEqual(e.anexos.map((a: { papel: string; sha256: string }) => [a.papel, a.sha256]), [
        ['TERMO_EVERGREEN_ASSINADO', sha256(assinadoSintetico('ASSINADO doc-db-05'))], ['COPIA_DO_MBL', sha256(pdf(`MBL ${MBL}`))],
      ]);
      const eventos = (await pool.query(`SELECT tipo, origem FROM documentos_apresentacao_eventos WHERE envio_id = $1 ORDER BY sequencia`, [envioId])).rows;
      assert.deepEqual(eventos.map((x) => `${x.tipo}/${x.origem}`), ['TENTATIVA_ABERTA/PESSOA', 'RASCUNHO_CRIADO/PESSOA', 'ENVIO_CONFIRMADO/INTEGRACAO']);
      // Banco: depois de confirmado, tentativa comum é recusada; reenvio de envio não confirmado também.
      const inserir = (reenvioDe: string | null) => pool.query(
        `INSERT INTO documentos_apresentacao_envios (organization_id, master_id, fluxo, documento_id, assinatura_id, modelo_id, chave_sha256, composicao,
           analista_membership_id, analista_conta_microsoft, reenvio_de, reenvio_motivo, reenvio_autorizado_por_membership_id, aberto_em, atualizado_em)
         VALUES ($1, $2, 'AGENDAMENTO_APRESENTACAO_GRIEG', $3, $4, $5, $6, '{}', $7, 'conta', $8, $9, $10, now(), now())`,
        [m.c.orgId, m.masterId, documentoId, assinaturaId, m.modeloId, 'e'.repeat(64), m.c.membershipPessoa, reenvioDe, reenvioDe ? 'motivo' : null, reenvioDe ? m.c.membershipPessoa : null]);
      await falha(inserir(null), /nova tentativa só como reenvio explícito/);
      await falha(inserir('00000000-0000-0000-0000-000000000000'), /reenvio exige o envio confirmado vigente/);
      await inserir(envioId);
      await falha(inserir(envioId), /envios_uma_aberta|envios_um_reenvio/);
      // Resultado gravado é definitivo; nada se apaga; composição imutável.
      await falha(pool.query(`UPDATE documentos_apresentacao_envios SET estado = 'RESULTADO_INCERTO' WHERE id = $1`, [envioId]), /transição ENVIO_CONFIRMADO/);
      await falha(pool.query(`UPDATE documentos_apresentacao_envios SET composicao = '{"x":1}' WHERE id = $1`, [envioId]), /só o estado e a evidência/);
      await falha(pool.query(`DELETE FROM documentos_apresentacao_envios WHERE id = $1`, [envioId]), /não pode ser apagada/);
      await falha(pool.query(`UPDATE documentos_apresentacao_eventos SET tipo = 'ENVIO_SOLICITADO' WHERE envio_id = $1`, [envioId]), APPEND_ONLY);
    });

    await t.test('[DB-06] concorrência: duas aberturas simultâneas → uma tentativa; confirmação sem evidência é recusada pelo banco', async () => {
      const m = await mundo(pool, 'doc-db-06');
      const { documentoId, assinaturaId } = await assinado(m);
      const nova = {
        masterId: m.masterId, fluxo: 'AGENDAMENTO_APRESENTACAO_GRIEG' as const, documentoId, assinaturaId, modeloId: m.modeloId, chaveSha256: 'a'.repeat(64),
        composicao: { assunto: 'a', corpo: 'c', para: ['x@y'], cc: [] }, analista: { membershipId: m.c.membershipPessoa, contaMicrosoft: 'conta' }, reenvio: null,
      };
      const [a, b] = await Promise.all([m.deps.repo.abrirTentativa(m.c.orgId, nova, m.c.membershipPessoa, new Date()), m.deps.repo.abrirTentativa(m.c.orgId, nova, m.c.membershipPessoa, new Date())]);
      assert.deepEqual([a.tipo, b.tipo].sort(), ['ABERTA', 'CONFLITO']);
      const id = ((a.tipo === 'ABERTA' ? a : b) as { envioId: string }).envioId;
      await falha(pool.query(`UPDATE documentos_apresentacao_envios SET estado = 'RASCUNHO_DISPONIVEL' WHERE id = $1`, [id]), /envios_rascunho/);
      assert.equal(await m.deps.repo.transicionar(m.c.orgId, id, 'PREPARANDO_RASCUNHO', 'RASCUNHO_DISPONIVEL', { rascunho: { id: 'r', internetMessageId: null, conversationId: null } },
        { tipo: 'RASCUNHO_CRIADO', origem: 'PESSOA', por: m.c.membershipPessoa }, new Date()), true);
      await falha(pool.query(`UPDATE documentos_apresentacao_envios SET estado = 'ENVIO_CONFIRMADO', concluido_em = now() WHERE id = $1`, [id]), /confirmado_com_evidencia/);
      assert.equal(await m.deps.repo.transicionar(m.c.orgId, id, 'PREPARANDO_RASCUNHO', 'RASCUNHO_DISPONIVEL', {}, { tipo: 'RASCUNHO_CRIADO', origem: 'PESSOA', por: null }, new Date()), false,
        'transição condicional: o estado já mudou');
    });

    await t.test('[DB-07] sinais de rejeição: um por mensagem; inequívoco e confiável rejeita a versão; ambíguo fica pendente até decisão humana', async () => {
      const m = await mundo(pool, 'doc-db-07');
      await assinado(m);
      const outlook = outlookDe(m);
      const r = await prepararRascunho(m.deps, m.ator, m.masterId, { outlook, caixaMonitorada: caixaDe(m) }, { autorizacao: PERMITIDA });
      const envioId = (r as { envioId: string }).envioId;
      outlook.enviarPeloOutlook((r as { rascunho: { id: string } }).rascunho.id);
      await conciliarEnvio(m.deps, m.ator, envioId, outlook);
      const conf = (await m.deps.repo.tentativa(m.c.orgId, envioId))!.confirmacao!;
      const email = (messageId: string) => ({ messageId, internetMessageId: null, conversationId: conf.conversationId, emRespostaA: null, remetente: 'agendamento@agencia.teste', recebidaEm: '2026-10-15T10:00:00.000Z' });
      const ambiguo = await registrarSinalDeRejeicao(m.deps, m.c.orgId, { modeloId: m.modeloId, envioId, email: email('resp-1'), leitura: 'AMBIGUA', trecho: 'verificar' });
      assert.equal((await registrarSinalDeRejeicao(m.deps, m.c.orgId, { modeloId: m.modeloId, envioId, email: email('resp-1'), leitura: 'AMBIGUA', trecho: 'verificar' }) as { novo: boolean }).novo, false);
      assert.deepEqual((await m.deps.repo.sinaisPendentes(m.c.orgId, 'TERMO_EVERGREEN')).map((s) => s.motivos), [['LEITURA_AMBIGUA']]);
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao_eventos (organization_id, modelo_id, tipo, origem, detalhe, registrado_em) VALUES ($1, $2, 'SINAL_DE_REJEICAO', 'INTEGRACAO', '{"messageId":"resp-1"}', now())`,
        [m.c.orgId, m.modeloId]), /sinal_unico/);
      assert.deepEqual(await decidirSinalDeRejeicao(m.deps, m.ator, (ambiguo as { sinalId: string }).sinalId, 'DESCARTAR', 'pedido de conferência'), { tipo: 'OK' });
      assert.deepEqual(await m.deps.repo.sinaisPendentes(m.c.orgId, 'TERMO_EVERGREEN'), []);
      const inequivoco = await registrarSinalDeRejeicao(m.deps, m.c.orgId, { modeloId: m.modeloId, envioId, email: email('resp-2'), leitura: 'INEQUIVOCA', trecho: 'não é mais aceito' });
      assert.deepEqual((inequivoco as { veredicto: unknown }).veredicto, { tipo: 'REJEICAO_CONFIRMADA' });
      const v = (await pool.query(`SELECT estado, rejeicao FROM documentos_apresentacao_modelos WHERE id = $1`, [m.modeloId])).rows[0];
      assert.deepEqual([v.estado, v.rejeicao.confirmadaPor], ['REJEITADO_PELA_AGENCIA', { tipo: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' }]);
      assert.equal((await pool.query(`SELECT estado FROM documentos_apresentacao_envios WHERE id = $1`, [envioId])).rows[0].estado, 'ENVIO_CONFIRMADO', 'histórico preservado');
    });

    await t.test('[DB-09] valores informados pelo Analista e verificação do arquivo assinado ficam gravados, com autor; valores fora do domínio são recusados pelo banco', async () => {
      const comAgendamento = definicaoEvergreen({
        campos: [
          { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
          { id: 'agendamento', rotulo: 'Agendamento', dado: 'AGENDAMENTO_DATA', obrigatorio: true, fontesAceitas: ['ANALISTA'], escopo: 'DOCUMENTO' },
        ],
      });
      const m = await mundo(pool, 'doc-db-09', { definicao: comAgendamento });
      assert.equal((await prepararDocumento(m.deps, m.ator, m.masterId)).tipo, 'NAO_PREPARADO', 'sem a data que só o Analista conhece');
      const r = await prepararDocumento(m.deps, m.ator, m.masterId, { informados: [{ dado: 'AGENDAMENTO_DATA', valor: '2026-10-20' }] });
      assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
      const documentoId = (r as { documentoId: string }).documentoId;
      const doc = (await m.deps.repo.documento(m.c.orgId, documentoId))!;
      assert.deepEqual(doc.informados.map((i) => [i.dado, i.valor, i.por]), [['AGENDAMENTO_DATA', '2026-10-20', m.c.membershipPessoa]]);
      const preparado = (await m.deps.repo.arquivoDoDocumento(m.c.orgId, documentoId))!;
      const assinado = new Uint8Array([...preparado, ...new TextEncoder().encode('\n7 0 obj << /Type /Sig /ByteRange [0 1 2 3] >> endobj\n%%EOF')]);
      const a = await registrarAssinatura(m.deps, m.ator, documentoId, assinado);
      assert.equal((a as { verificacao: string }).verificacao, 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO');
      assert.deepEqual((await m.deps.repo.assinaturas(m.c.orgId, [documentoId])).map((x) => x.verificacao), ['INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO']);
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao_assinaturas (organization_id, documento_id, arquivo, arquivo_sha256, registrado_por_membership_id, registrado_em, verificacao)
         VALUES ($1, $2, '\\x01', $3, $4, now(), 'ASSINADA_PELA_PRIORA')`, [m.c.orgId, documentoId, 'f'.repeat(64), m.c.membershipPessoa]), /verificacao/);
    });

    await t.test('[DB-10] DOC-22..25/30 no banco: qualquer pessoa interna anexa (cliente não); identidade esperada = a do documento; cadeia de substituições linear e justificada; conferência com constatação; nada se apaga', async () => {
      // Termo SINTÉTICO com o signatário legal; o cadastro dele vem de uma porta SIMULADA (no Postgres a fonte ainda não existe).
      const comSignatario = definicaoEvergreen({
        campos: [
          { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
          { id: 'nome', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
        ],
      });
      const m = await mundo(pool, 'doc-db-10', { definicao: comSignatario });
      assert.equal((await prepararDocumento(m.deps, m.ator, m.masterId)).tipo, 'NAO_PREPARADO', 'Postgres: sem cadastro do signatário legal, nada é preenchido');
      m.deps = { ...m.deps, fontes: { ...m.deps.fontes, signatariosLegais: async () => [SIGNATARIO_COM_PODERES] } };
      const { documentoId } = (await prepararDocumento(m.deps, m.ator, m.masterId)) as { documentoId: string };
      const doc = (await pool.query(`SELECT preparado_por_membership_id, signatario_id, signatario_nome FROM documentos_apresentacao WHERE id = $1`, [documentoId])).rows[0];
      assert.deepEqual([doc.preparado_por_membership_id, doc.signatario_id, doc.signatario_nome], [m.c.membershipPessoa, 'sig-legal-1', 'SIGNATARIO LEGAL SINTETICO']);
      // Outra pessoa interna (aqui o ADMIN) anexa o arquivo — o operador fica registrado, separado do signatário.
      const outro = { organizationId: m.c.orgId, membershipId: m.c.membershipCaixa };
      const arquivo1 = assinadoSintetico('ASSINADO DB-10');
      const a1 = (await registrarAssinatura(m.deps, outro, documentoId, arquivo1)) as { assinaturaId: string; tipo: string };
      assert.equal(a1.tipo, 'REGISTRADA', JSON.stringify(a1));
      const linhaA1 = (await pool.query(`SELECT * FROM documentos_apresentacao_assinaturas WHERE id = $1`, [a1.assinaturaId])).rows[0];
      assert.deepEqual([linhaA1.registrado_por_membership_id, linhaA1.signatario_esperado_id, linhaA1.signatario_esperado_nome, linhaA1.substitui_assinatura_id],
        [m.c.membershipCaixa, 'sig-legal-1', 'SIGNATARIO LEGAL SINTETICO', null]);
      const inserir = (p: { por?: string; sig?: [string | null, string | null]; de?: string | null; motivo?: string | null; justificativa?: string | null; sha?: string }) => pool.query(
        `INSERT INTO documentos_apresentacao_assinaturas (organization_id, documento_id, arquivo, arquivo_sha256, registrado_por_membership_id, registrado_em, verificacao,
           signatario_esperado_id, signatario_esperado_nome, substitui_assinatura_id, substituicao_motivo, substituicao_justificativa)
         VALUES ($1, $2, '\\x255044462d78', $3, $4, now(), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL', $5, $6, $7, $8, $9)`,
        [m.c.orgId, documentoId, p.sha ?? 'c'.repeat(64), p.por ?? m.c.membershipPessoa, ...(p.sig ?? ['sig-legal-1', 'SIGNATARIO LEGAL SINTETICO']),
          p.de ?? null, p.motivo ?? null, p.justificativa ?? null]);
      await falha(inserir({ por: m.c.membershipCliente, de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'x' }), /cliente não anexa/);
      await falha(inserir({ sig: ['sig-outro', 'OUTRO'], de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'x' }), /signatário esperado não é o representado/);
      await falha(inserir({ sig: [null, null], de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'x' }), /signatário esperado não é o representado/);
      await falha(inserir({}), /primeiro_unico/);
      await falha(inserir({ de: a1.assinaturaId, motivo: 'OUTRO' }), /assinaturas_substituicao/);
      await falha(inserir({ de: a1.assinaturaId, motivo: 'OUTRO', justificativa: ' ' }), /assinaturas_substituicao/);
      // Conferência: arquivo registrado, identidade do registro, constatação só (e sempre) quando não conforme; cliente não confere.
      const conferir = (p: { sha?: string; resultado?: string; por?: string; constatacao?: string | null; observacao?: string | null; sig?: [string | null, string | null] }) => pool.query(
        `INSERT INTO documentos_apresentacao_conferencias (organization_id, documento_id, assinatura_id, arquivo_sha256, resultado, constatacao, conferido_por_membership_id,
           conferido_em, observacao, signatario_esperado_id, signatario_esperado_nome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10)`,
        [m.c.orgId, documentoId, a1.assinaturaId, p.sha ?? sha256(arquivo1), p.resultado ?? 'CONFORME', p.constatacao ?? null, p.por ?? m.c.membershipPessoa,
          p.observacao ?? null, ...(p.sig ?? ['sig-legal-1', 'SIGNATARIO LEGAL SINTETICO'])]);
      await falha(conferir({ sha: 'd'.repeat(64) }), /não é o do registro de assinatura/);
      await falha(conferir({ sig: ['sig-outro', 'X'] }), /signatário esperado não é o do arquivo assinado/);
      await falha(conferir({ resultado: 'NAO_CONFORME', observacao: 'x' }), /conferencias_constatacao/);
      await falha(conferir({ resultado: 'NAO_CONFORME', constatacao: 'ASSINATURA_INVALIDA' }), /conferencias_motivo/);
      await falha(conferir({ constatacao: 'ASSINATURA_INVALIDA' }), /conferencias_constatacao/);
      await falha(conferir({ por: m.c.membershipCliente }), /cliente não confere/);
      const k = await conferirAssinatura(m.deps, m.ator, documentoId, {
        assinaturaId: a1.assinaturaId, arquivoSha256: sha256(arquivo1), resultado: 'NAO_CONFORME', constatacao: 'SIGNATARIO_DIFERENTE_DO_ESPERADO', observacao: 'certificado de outra pessoa',
      });
      assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA', JSON.stringify(k));
      const linha = (await pool.query(`SELECT * FROM documentos_apresentacao_conferencias WHERE documento_id = $1`, [documentoId])).rows[0];
      assert.deepEqual([linha.arquivo_sha256, linha.conferido_por_membership_id, linha.constatacao, linha.signatario_esperado_id],
        [sha256(arquivo1), m.c.membershipPessoa, 'SIGNATARIO_DIFERENTE_DO_ESPERADO', 'sig-legal-1']);
      // Substituição justificada pelo serviço; a mesma linha não é substituída duas vezes; nada se altera nem se apaga.
      const arquivo2 = assinadoSintetico('ASSINADO DB-10 CORRIGIDO');
      const a2 = (await registrarAssinatura(m.deps, outro, documentoId, arquivo2, { substituicao: { motivo: 'ARQUIVO_ANTERIOR_NAO_CONFORME', justificativa: 'reassinado' } })) as { assinaturaId: string };
      assert.equal((await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId)).situacao.assinatura.tipo, 'AGUARDANDO_CONFERENCIA', 'a conferência anterior não é reaproveitada');
      await falha(inserir({ de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'paralelo', sha: 'e'.repeat(64) }), /substituida_uma_vez/);
      assert.deepEqual(await m.deps.repo.gravarAssinatura(m.c.orgId, {
        documentoId, arquivo: assinadoSintetico('paralelo'), arquivoSha256: sha256(assinadoSintetico('paralelo')), registradoPor: m.c.membershipPessoa, registradoEm: new Date(),
        verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO', signatarioEsperado: { signatarioId: 'sig-legal-1', nome: 'SIGNATARIO LEGAL SINTETICO' },
        substituicao: { de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'x' },
      }), { tipo: 'SUBSTITUICAO_DESATUALIZADA' });
      await conferirAssinatura(m.deps, outro, documentoId, { assinaturaId: a2.assinaturaId, arquivoSha256: sha256(arquivo2), resultado: 'CONFORME' });
      assert.equal((await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId)).situacao.assinatura.tipo, 'CONFERIDA');
      await falha(pool.query(`UPDATE documentos_apresentacao_assinaturas SET arquivo = '\\x2550' WHERE id = $1`, [a1.assinaturaId]), APPEND_ONLY);
      await falha(pool.query(`DELETE FROM documentos_apresentacao_assinaturas WHERE id = $1`, [a1.assinaturaId]), APPEND_ONLY);
      await falha(pool.query(`UPDATE documentos_apresentacao_conferencias SET resultado = 'CONFORME' WHERE documento_id = $1`, [documentoId]), APPEND_ONLY);
      const guardados = (await pool.query(`SELECT id, arquivo, arquivo_sha256, substitui_assinatura_id, substituicao_motivo FROM documentos_apresentacao_assinaturas
        WHERE documento_id = $1 ORDER BY sequencia`, [documentoId])).rows;
      assert.deepEqual(guardados.map((r) => [sha256(r.arquivo) === r.arquivo_sha256, r.substitui_assinatura_id, r.substituicao_motivo]),
        [[true, null, null], [true, a1.assinaturaId, 'ARQUIVO_ANTERIOR_NAO_CONFORME']]);
      // O documento só guarda a identidade inteira (id e nome juntos).
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao (organization_id, master_id, tipo, modelo_id, conteudo, conteudo_sha256, proveniencia, gerador, gerador_versao, arquivo,
           arquivo_sha256, preparado_em, preparado_por_membership_id, signatario_id)
         VALUES ($1, $2, 'TERMO_EVERGREEN', $3, '{}', $4, '[]', 'g', '9', '\\x25504446', $4, now(), $5, 'sig-legal-1')`,
        [m.c.orgId, m.masterId, m.modeloId, 'd'.repeat(64), m.c.membershipPessoa]), /documentos_apresentacao_signatario/);
    });

    await t.test('[DB-11] DOC-31 no banco: memorando preparado vive sem assinatura, conferência, envio ou Outlook; arquivo assinado de memorando é recusado pelo gatilho', async () => {
      for (const [tipo, armador] of [['MEMORANDO_MSC', 'MSC'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']] as const) {
        const m = await mundo(pool, `doc-db-11-${armador.toLowerCase()}`, { armador, definicao: definicaoMemorando(tipo) });
        const escolhas = [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: m.ator.membershipId, em: '2026-10-14T12:00:00.000Z' }];
        const r = await prepararDocumento(m.deps, m.ator, m.masterId, { escolhas });
        assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
        const documentoId = (r as { documentoId: string }).documentoId;
        const preparado: Buffer = (await pool.query(`SELECT arquivo FROM documentos_apresentacao WHERE id = $1`, [documentoId])).rows[0].arquivo;
        assert.equal(sha256((await m.deps.repo.arquivoDoDocumento(m.c.orgId, documentoId))!), sha256(preparado), tipo);
        const av = await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId);
        assert.deepEqual([av.situacao.proximoPasso?.passo, av.situacao.texto], ['DOCUMENTO_DISPONIVEL', 'Documento disponível para download'], tipo);
        // DOC-31.B: o conteúdo renderizado volta do banco igual ao planejado (é a base da comparação campo a campo).
        assert.deepEqual((await m.deps.repo.documento(m.c.orgId, documentoId))!.conteudo, av.plano!.conteudo, tipo);
        const assinado = pdf(`${tipo} ASSINADO FORA DA PRIORA`);
        assert.deepEqual(await registrarAssinatura(m.deps, m.ator, documentoId, assinado), { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
        // Mesmo por fora do serviço, o banco não guarda arquivo assinado de memorando (DOC-31 restringe DOC-30).
        await falha(pool.query(
          `INSERT INTO documentos_apresentacao_assinaturas (organization_id, documento_id, arquivo, arquivo_sha256, registrado_por_membership_id, registrado_em, verificacao)
           VALUES ($1, $2, $3, $4, $5, now(), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL')`,
          [m.c.orgId, documentoId, Buffer.from(assinado), sha256(assinado), m.c.membershipPessoa]), /só do termo Evergreen/);
        for (const tabela of ['documentos_apresentacao_assinaturas', 'documentos_apresentacao_conferencias', 'documentos_apresentacao_envios']) {
          assert.equal(await contar(pool, `SELECT count(*) n FROM ${tabela} WHERE organization_id = $1`, [m.c.orgId]), 0, `${tipo}: ${tabela}`);
        }
      }
    });

    await t.test('[DB-08] isolamento por organização: nada de uma organização aparece para outra; FKs compostas impedem referência cruzada', async () => {
      const a = await mundo(pool, 'doc-db-08a');
      const b = await mundo(pool, 'doc-db-08b');
      const { documentoId } = (await prepararDocumento(a.deps, a.ator, a.masterId)) as { documentoId: string };
      assert.equal(await b.deps.repo.documento(b.c.orgId, documentoId), null);
      assert.equal(await b.deps.repo.arquivoDoDocumento(b.c.orgId, documentoId), null);
      assert.equal(await b.deps.repo.versao(b.c.orgId, a.modeloId), null);
      await falha(pool.query(
        `INSERT INTO documentos_apresentacao (organization_id, master_id, tipo, modelo_id, conteudo, conteudo_sha256, proveniencia, gerador, gerador_versao, arquivo,
           arquivo_sha256, preparado_em, preparado_por_membership_id)
         VALUES ($1, $2, 'TERMO_EVERGREEN', $3, '{}', $4, '[]', 'g', '1', '\\x25504446', $4, now(), $5)`,
        [a.c.orgId, b.masterId, a.modeloId, 'd'.repeat(64), a.c.membershipPessoa]), /documentos_apresentacao_master_fk/);
    });
  } finally {
    await pool.end();
  }
});
