import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { preparar } from '../../aplicacao/__tests__/apoio';
import { normalizarCodigo, validaISO6346 } from '../../../auditoria/preAlerta/normalizacao';
import { CamposDocumentaisExtraidos, persistirExtracoesAuditoria } from '../../../auditoria/fatos/extracoes';
import { evidenciasDoMbl } from '../../../auditoria/fatos/evidenciasDoMbl';
import { valorNoFormato } from '../dominio/formatos';
import { situacaoDaAgencia } from '../../dominio';
import { armador } from '../../dominio/__tests__/l1b/fixtures';
import {
  DadoNaoPublicado, DefinicaoDoModelo, DepsDocumentos, LeituraDoMbl, MENSAGEM_VIGENCIA_NAO_VERIFICAVEL, ModeloEmUso, TEXTO_DOCUMENTO_DISPONIVEL, TipoDocumento,
  ValorObservado, avaliarDocumentacao, cadastrarModelo, dadosDoMbl, estadoDoDado, fatosDocumentaisParaL1b, fontesConfiaveisPostgres, planejarPreenchimento,
  prepararDocumento, prepararRascunho, registrarAssinatura, repositorioDocumentalPostgres, validarModelo,
} from '..';
import {
  GERADOR_DE_TESTE, PERMITIDA, arquivoSintetico, caixaMonitoradaFalsa, definicaoEvergreen, definicaoMemorando, destinatarios, outlookFalso, relogio,
} from './fixtures';

/**
 * Entrega 1 / H1 — o motor documental consome os campos do MBL que a Auditoria JÁ extraiu e persistiu (0106), só quando
 * confiáveis pelas regras aprovadas, com a origem de cada valor; versões diferentes nunca são resolvidas sozinhas.
 * Fixtures sintéticas; os fatos do S2 entram pelo caminho do dono (`persistirExtracoesAuditoria`). Nenhum OCR, nenhuma IA.
 */

const url = testDatabaseUrl();
const PB001 = { normalizar: normalizarCodigo, valido: validaISO6346 };

function conteiner(base: string): string {
  for (let d = 0; d <= 9; d++) if (validaISO6346(`${base}${d}`)) return `${base}${d}`;
  throw new Error(base);
}
const C1 = conteiner('TSTU000001');
const C2 = conteiner('TSTU000002');
const INVALIDO = `${C1.slice(0, 10)}${(Number(C1[10]) + 1) % 10}`;

const NAVIO = 'NAVIO_E_VIAGEM';
const CONTEINERES = 'CONTEINERES_DO_MASTER';
const CONSIGNATARIO = 'CONSIGNATARIO_RAZAO_SOCIAL';

/** Uma versão do MBL com os campos como o OCR os devolveu, pelo contrato de evidências da Auditoria (o dono classifica). */
const leitura = (id: string, campos: CamposDocumentaisExtraidos | null, masterId = 'M1', observadoEm = '2026-09-01T08:00:00.000Z'): LeituraDoMbl => {
  const ev = evidenciasDoMbl(masterId, true, [{
    extracaoId: id, masterId, processoIds: [], conhecimento: null, campos, extrator: 'auditoria.docExtractor', extratorVersao: '2', modelo: 'teste',
    extraidaEm: new Date(observadoEm),
    origem: { messageId: `m-${id}`, internetMessageId: null, attachmentId: `a-${id}`, attachmentNome: 'MBL.pdf', remetente: null, recebidaEm: new Date(observadoEm), arquivoSha256: null },
  }]);
  const v = ev.versoes[0];
  return { extracaoId: id, masterId, observadoEm: v.observadoEm.toISOString(), estados: v.estados };
};

/* ------------------------------------------------ puro ------------------------------------------------ */

test('[E1-08] confiabilidade por dado: extraído ≠ confiável; contêiner fora do ISO 6346 ou repetido, consignatário e extração antiga não viram fato', () => {
  const l = leitura('x1', { navio: '  NAVIO SINTETICO A V.001 ', consignee: 'EMPRESA SINTETICA LTDA', conteineres: [`${C1.slice(0, 4)} ${C1.slice(4)}`, C2.toLowerCase()] });
  assert.deepEqual(estadoDoDado(l, NAVIO), { tipo: 'CONFIAVEL', valor: 'NAVIO SINTETICO A V.001' });
  assert.deepEqual(estadoDoDado(l, CONTEINERES), { tipo: 'CONFIAVEL', valor: `${C1}\n${C2}` }, 'normalização do PB-001 (só o código)');
  assert.deepEqual(estadoDoDado(l, CONSIGNATARIO), { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' });
  assert.deepEqual(estadoDoDado(l, 'CONSIGNATARIO_QUALIFICACAO'), { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' });
  const ruim = (conteineres: Array<string | null>) => estadoDoDado(leitura('x', { navio: null, consignee: null, conteineres }), CONTEINERES);
  assert.deepEqual(ruim([C1, INVALIDO]), { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_FORA_DO_PADRAO_ISO_6346' }, 'um item fora do padrão: a lista não vale');
  assert.deepEqual(ruim([C1, null]), { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_FORA_DO_PADRAO_ISO_6346' }, 'contêiner sem número lido');
  assert.deepEqual(ruim([C1, C1.toLowerCase()]), { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_REPETIDO' }, 'DOC-27: repetido não é descartado em silêncio');
  assert.deepEqual(ruim([]), { tipo: 'AUSENTE', motivo: 'NAO_LIDO' });
  assert.deepEqual(estadoDoDado(leitura('x', { navio: '   ', consignee: null, conteineres: [] }), NAVIO), { tipo: 'AUSENTE', motivo: 'NAO_LIDO' });
  assert.deepEqual(estadoDoDado(leitura('antiga', null), NAVIO), { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' }, 'extração anterior à 0106');

  const { valores, naoPublicados } = dadosDoMbl('M1', [l, leitura('outro', { navio: 'NAVIO DE OUTRO MASTER', consignee: null, conteineres: [] }, 'M2')], [NAVIO, CONTEINERES, CONSIGNATARIO]);
  assert.deepEqual(valores.map((v) => [v.dado, v.valor, v.fonte, v.escopo, v.evidencia.ref]), [
    [NAVIO, 'NAVIO SINTETICO A V.001', 'S2_AUDITORIA', { tipo: 'MASTER', masterId: 'M1' }, 'auditoria_extracao:x1'],
    [CONTEINERES, `${C1}\n${C2}`, 'S2_AUDITORIA', { tipo: 'MASTER', masterId: 'M1' }, 'auditoria_extracao:x1'],
  ], 'só o que é confiável, só deste Master, cada valor com a sua origem');
  assert.deepEqual(naoPublicados.map((n) => [n.dado, n.motivo]), [[CONSIGNATARIO, 'CONSIGNATARIO_SEM_CRITERIO_APROVADO']]);
});

test('[E1-07] versões: cada versão é uma observação própria; uma leitura não confiável de QUALQUER versão retém o dado (não dá para afirmar que não há divergência)', () => {
  const v1 = leitura('v1', { navio: 'NAVIO A', consignee: null, conteineres: [C1, INVALIDO] }, 'M1', '2026-09-01T08:00:00.000Z');
  const v2 = leitura('v2', { navio: 'NAVIO B', consignee: null, conteineres: [C1, C2] }, 'M1', '2026-09-05T08:00:00.000Z');
  const { valores, naoPublicados } = dadosDoMbl('M1', [v1, v2], [NAVIO, CONTEINERES]);
  assert.deepEqual(valores.map((v) => [v.dado, v.valor, v.evidencia.ref]), [[NAVIO, 'NAVIO A', 'auditoria_extracao:v1'], [NAVIO, 'NAVIO B', 'auditoria_extracao:v2']],
    'as duas versões do navio seguem (a divergência fica para o preenchimento); nenhuma é escolhida');
  assert.deepEqual(naoPublicados.map((n) => [n.dado, n.motivo, n.evidencia.ref]), [
    [CONTEINERES, 'CONTEINER_FORA_DO_PADRAO_ISO_6346', 'auditoria_extracao:v1'], [CONTEINERES, 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL', 'auditoria_extracao:v2'],
  ], 'a versão corrigida não vence sozinha a leitura não confiável da outra');
  const antiga = dadosDoMbl('M1', [leitura('v0', null), v2], [NAVIO]);
  assert.deepEqual(antiga.valores.map((v) => v.valor), ['NAVIO B'], 'extração anterior à 0106 (sem campos) não bloqueia: não há leitura para comparar');
});

/* ---------------- E1: oráculo — a implementação anterior (congelada aqui) e a nova dão EXATAMENTE o mesmo resultado ---------------- */

/** Implementação anterior à E1 (classificação documental na Liberação), copiada sem mudança para servir de oráculo. */
type LeituraAnterior = { extracaoId: string; masterId: string; observadoEm: string; campos: CamposDocumentaisExtraidos | null };
const vazioAnterior = (v: string | null | undefined) => String(v ?? '').trim() === '';
function estadoDoDadoAnterior(l: LeituraAnterior, dado: string): ReturnType<typeof estadoDoDado> {
  const c = l.campos;
  if (!c) return { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' };
  switch (dado) {
    case NAVIO:
      return vazioAnterior(c.navio) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'CONFIAVEL', valor: String(c.navio).trim() };
    case CONTEINERES: {
      if (!c.conteineres.length) return { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
      if (!c.conteineres.every((n) => PB001.valido(n))) return { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_FORA_DO_PADRAO_ISO_6346' };
      const lista = c.conteineres.map((n) => PB001.normalizar(n)).join('\n');
      return valorNoFormato('LISTA', lista) ? { tipo: 'CONFIAVEL', valor: lista } : { tipo: 'NAO_CONFIAVEL', motivo: 'CONTEINER_REPETIDO' };
    }
    case CONSIGNATARIO:
    case 'CONSIGNATARIO_QUALIFICACAO':
      return vazioAnterior(c.consignee) ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' };
    default:
      return { tipo: 'AUSENTE', motivo: 'NAO_LIDO' };
  }
}
function dadosDoMblAnterior(masterId: string, leituras: ReadonlyArray<LeituraAnterior>, dados: ReadonlyArray<string>): ReturnType<typeof dadosDoMbl> {
  const valores: ValorObservado[] = [];
  const naoPublicados: DadoNaoPublicado[] = [];
  const doMaster = leituras.filter((l) => l.masterId === masterId);
  for (const dado of dados) {
    if (![NAVIO, CONTEINERES, CONSIGNATARIO, 'CONSIGNATARIO_QUALIFICACAO'].includes(dado)) continue;
    const estados = doMaster.map((l) => ({ l, e: estadoDoDadoAnterior(l, dado) }));
    const algumaNaoConfiavel = estados.some((x) => x.e.tipo === 'NAO_CONFIAVEL');
    for (const { l, e } of estados) {
      const base = { dado, fonte: 'S2_AUDITORIA' as const, evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${l.extracaoId}` }, observadoEm: l.observadoEm };
      if (e.tipo === 'NAO_CONFIAVEL') naoPublicados.push({ ...base, motivo: e.motivo });
      else if (e.tipo === 'CONFIAVEL' && algumaNaoConfiavel) naoPublicados.push({ ...base, motivo: 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL' });
      else if (e.tipo === 'CONFIAVEL') valores.push({ ...base, valor: e.valor, escopo: { tipo: 'MASTER', masterId } });
    }
  }
  return { valores, naoPublicados };
}

test('[E1-ORACULO] a mesma entrada dá o MESMO resultado de antes da E1 (estado por dado e dados publicados/retidos), em todas as combinações', () => {
  const navios = [null, '', '   ', 'NAVIO A', '  NAVIO  A  ', 'NAVIO A\nV.001', 'NAVIO A\r\nV.001 ', 'NAVIO A \nV.001'];
  const consignatarios = [null, '', ' EMPRESA SINTETICA ', 'EMPRESA SINTETICA\nRUA FICTICIA 1', 'EMPRESA SINTETICA\r\nRUA FICTICIA 1'];
  const listas: Array<Array<string | null>> = [[], [C1], [C1, C2], [C2.toLowerCase(), `${C1.slice(0, 4)} ${C1.slice(4)}`], [C1, INVALIDO], [C1, null], [C1, C1.toLowerCase()], [null]];
  const camposDe: Array<CamposDocumentaisExtraidos | null> = [null];
  for (const navio of navios) for (const consignee of consignatarios) for (const conteineres of listas) camposDe.push({ navio, consignee, conteineres });
  const dados = [NAVIO, CONTEINERES, CONSIGNATARIO, 'CONSIGNATARIO_QUALIFICACAO', 'OUTRO_DADO'];
  const par = (id: string, c: CamposDocumentaisExtraidos | null, masterId = 'M1', em = '2026-09-01T08:00:00.000Z') =>
    ({ nova: leitura(id, c, masterId, em), anterior: { extracaoId: id, masterId, observadoEm: em, campos: c } as LeituraAnterior });
  let comparacoes = 0;
  camposDe.forEach((c, i) => {
    const { nova, anterior } = par(`v${i}`, c);
    for (const d of dados) { assert.deepEqual(estadoDoDado(nova, d), estadoDoDadoAnterior(anterior, d), `estado ${i}/${d}`); comparacoes++; }
    assert.deepEqual(dadosDoMbl('M1', [nova], dados), dadosDoMblAnterior('M1', [anterior], dados), `uma versão ${i}`);
    comparacoes++;
  });
  // Duas e três versões (e uma de outro Master), em todas as combinações de uma amostra que cobre cada estado.
  const amostra = [0, 1, 2, 9, 17, 40, 77, 120, 161, 200, 250, 300, 320].filter((i) => i < camposDe.length);
  for (const a of amostra) for (const b of amostra) {
    const versoes = [par(`a${a}`, camposDe[a], 'M1', '2026-09-01T08:00:00.000Z'), par(`b${b}`, camposDe[b], 'M1', '2026-09-05T08:00:00.000Z'), par(`o${a}`, camposDe[b], 'M2')];
    assert.deepEqual(dadosDoMbl('M1', versoes.map((x) => x.nova), dados), dadosDoMblAnterior('M1', versoes.map((x) => x.anterior), dados), `versões ${a}×${b}`);
    comparacoes++;
  }
  assert.ok(comparacoes > 900, `comparações: ${comparacoes}`);
});

const definicaoSintetica = (tipo: TipoDocumento, campos: DefinicaoDoModelo['campos']): DefinicaoDoModelo => {
  const d = tipo === 'TERMO_EVERGREEN' ? definicaoEvergreen({ campos }) : definicaoMemorando(tipo, { campos, opcoes: [] });
  const lugar = d.layout?.campos.conteineres;
  return lugar && d.layout ? { ...d, layout: { ...d.layout, campos: { ...d.layout.campos, conteineres: { ...lugar, formato: 'LISTA', linhasMaximas: 6 } } } } : d;
};
const BL = { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' } as const;
const DATA = { id: 'data', rotulo: 'Data', dado: 'DATA_DA_GERACAO', obrigatorio: true, fontesAceitas: ['GERACAO'], escopo: 'DOCUMENTO' } as const;
const CAMPO_NAVIO = { id: 'navio', rotulo: 'Navio e viagem', dado: NAVIO, obrigatorio: true, fontesAceitas: ['S3_VIAGEM', 'S2_AUDITORIA'], escopo: 'MASTER' } as const;
const CAMPO_CONTEINERES = { id: 'conteineres', rotulo: 'Contêineres', dado: CONTEINERES, obrigatorio: true, fontesAceitas: ['S2_AUDITORIA'], escopo: 'MASTER' } as const;
const CAMPO_EXPORTADOR = { id: 'exportador', rotulo: 'Exportador/Importador', dado: CONSIGNATARIO, obrigatorio: true, fontesAceitas: ['S2_AUDITORIA'], escopo: 'MASTER' } as const;

test('[E1-12a] divergência pela MESMA escrita da DOC-31.B: leituras que só diferem em espaços concordam (as duas origens ficam); valores diferentes divergem e nada é escolhido', () => {
  const d = definicaoSintetica('MEMORANDO_MSC', [CAMPO_NAVIO]);
  const modelo: ModeloEmUso = { modeloId: 'm', versao: '1', arquivoSha256: 'a'.repeat(64), definicao: d };
  const v = (id: string, valor: string): ValorObservado => ({
    dado: NAVIO, valor, fonte: 'S2_AUDITORIA', escopo: { tipo: 'MASTER', masterId: 'M1' }, evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${id}` }, observadoEm: '2026-09-01T00:00:00.000Z',
  });
  const ctx = { masterId: 'M1', processoIds: [], modalidade: { tipo: 'DESCONHECIDA' as const }, signatario: null };
  const iguais = planejarPreenchimento(modelo, [v('v1', 'NAVIO SINTETICO  A   V.001'), v('v2', 'NAVIO SINTETICO A V.001')], [], ctx);
  assert.equal(iguais.tipo, 'PRONTO');
  if (iguais.tipo === 'PRONTO') {
    assert.equal(iguais.plano.proveniencia[0].fontes.length, 2, 'as duas versões ficam na proveniência');
    assert.equal(iguais.plano.conteudo.campos[0].valor.replace(/\s+/g, ' '), 'NAVIO SINTETICO A V.001');
  }
  const diferentes = planejarPreenchimento(modelo, [v('v1', 'NAVIO SINTETICO A V.001'), v('v2', 'NAVIO SINTETICO B V.002')], [], ctx);
  assert.equal(diferentes.tipo, 'INCOMPLETO');
  if (diferentes.tipo === 'INCOMPLETO') {
    assert.deepEqual(diferentes.divergentes.map((x) => [x.campo, x.natureza, x.valores.map((y) => y.evidencia.ref)]),
      [['navio', 'ENTRE_FONTES_DO_SISTEMA', ['auditoria_extracao:v1', 'auditoria_extracao:v2']]]);
    assert.deepEqual(diferentes.resolvidos.campos, [], 'nem a mais recente nem a mais antiga é escolhida');
  }
});

test('[E1-10/11] o adaptador documental não dispara OCR nem chama IA: nenhum import de extrator, Graph de anexos ou cliente de IA no caminho de leitura', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  const caminho = ['liberacao/documentos/aplicacao/postgres.ts', 'liberacao/documentos/dominio/fatosDoMbl.ts', 'auditoria/fatos/camposDoMbl.ts', 'auditoria/fatos/evidenciasDoMbl.ts', 'auditoria/fatos/vinculos.ts'];
  for (const f of caminho) {
    const fonte = fs.readFileSync(path.join(raiz, f), 'utf8');
    for (const [, imp] of fonte.matchAll(/from\s+'([^']+)'/g)) {
      assert.doesNotMatch(imp, /docExtractor|extracaoPreAlerta|geminiClient|\/ai\/|graphService|auditClara|shippingInstructions/, `${f} importa ${imp}`);
    }
  }
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of todos(path.join(raiz, 'liberacao', 'documentos')).filter((x) => x.endsWith('.ts') && !x.includes('__tests__'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /geminiClient|generateStructured|docExtractor|extracaoPreAlerta/, `${path.relative(raiz, f)} não usa OCR nem IA`);
  }
});

/* ------------------------------------------------ PostgreSQL ------------------------------------------------ */

interface Mundo { c: Cenario; masterId: string; deps: DepsDocumentos; ator: { organizationId: string; membershipId: string } }

const SHA = (n: number) => n.toString(16).padStart(64, '0');

/** Uma versão do MBL entra pelo caminho do DONO (S2), com os campos como o OCR os teria devolvido. */
async function versaoDoMbl(pool: Pool, c: Cenario, v: { id: string; recebida: string; navio: string | null; conteineres?: Array<string | null>; consignee?: string | null; sha: number }) {
  const r = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: `msg-${v.id}`, internetMessageId: `<${v.id}@agente.teste>`, attachmentId: `anexo-${v.id}`, attachmentNome: 'MBL.pdf', contentType: 'application/pdf',
      remetente: 'agente@agente.teste', recebidaEm: new Date(v.recebida), referenciasBrutas: ['IM100'], associacao: 'CITADA',
    },
    resultado: {
      tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: true, conhecimento: 'MEDU1234567',
      camposDocumentais: { navio: v.navio, consignee: v.consignee ?? 'EMPRESA SINTETICA LTDA', conteineres: v.conteineres ?? [C1] }, arquivoSha256: SHA(v.sha),
    },
    modelo: 'modelo-teste', extraidaEm: new Date(v.recebida),
  }]);
  return (r[0] as { extracaoId: string }).extracaoId;
}

async function mundo(pool: Pool, slug: string, tipo: TipoDocumento, campos: DefinicaoDoModelo['campos'], codigo: string): Promise<Mundo> {
  const c = await cenario(pool, slug);
  await versaoDoMbl(pool, c, { id: `${slug}-v1`, recebida: '2026-09-01T08:00:00Z', navio: 'NAVIO SINTETICO A V.001', conteineres: [C1, C2], sha: 1 });
  const masterId = (await pool.query(`SELECT master_id FROM processo_master_vinculos WHERE organization_id = $1 LIMIT 1`, [c.orgId])).rows[0].master_id;
  const deps: DepsDocumentos = {
    repo: repositorioDocumentalPostgres(pool), fontes: fontesConfiaveisPostgres(pool),
    armador: { armadorDoMaster: async (_o, m) => (m === masterId ? { masterId: m, codigo } : null) },
    gerador: GERADOR_DE_TESTE, destinatarios: { daAgencia: async () => destinatarios(), remetentesConfiaveis: async () => null }, relogio: relogio(),
  };
  const ator = { organizationId: c.orgId, membershipId: c.membershipPessoa };
  const r = await cadastrarModelo(deps, ator, { tipo, versao: 'sintetica-1', arquivo: arquivoSintetico(tipo, slug), definicao: definicaoSintetica(tipo, campos) });
  assert.equal((await validarModelo(deps, ator, (r as { modeloId: string }).modeloId)).tipo, 'OK');
  return { c, masterId, deps, ator };
}

const situacao = async (m: Mundo) => (await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId)).situacao;
const documentosDe = (pool: Pool, m: Mundo) => contar(pool, `SELECT count(*) n FROM documentos_apresentacao WHERE organization_id = $1`, [m.c.orgId]);

test('Entrega 1 — motor documental sobre os fatos do MBL persistidos', { skip: !url && 'DEMURRAGE_TEST_DATABASE_URL não definida' }, async (t) => {
  const pool = testPool();
  await preparar(pool);
  try {
    await t.test('[E1-09] o adaptador lê os fatos JÁ persistidos do MBL do Master certo, com a origem; o não confiável só é informado', async () => {
      const m = await mundo(pool, 'e1-adapt', 'MEMORANDO_MSC', [BL, CAMPO_NAVIO, DATA], 'MSC');
      const pedidos = [{ dado: NAVIO, fonte: 'S2_AUDITORIA' as const }, { dado: CONTEINERES, fonte: 'S2_AUDITORIA' as const }, { dado: CONSIGNATARIO, fonte: 'S2_AUDITORIA' as const }];
      const valores = await m.deps.fontes.valores(m.c.orgId, m.masterId, [], pedidos);
      const extracaoId = (await pool.query(`SELECT id FROM auditoria_extracoes WHERE organization_id = $1`, [m.c.orgId])).rows[0].id;
      assert.deepEqual(valores.map((v) => [v.dado, v.valor, v.fonte, v.evidencia.ref, v.observadoEm]), [
        [NAVIO, 'NAVIO SINTETICO A V.001', 'S2_AUDITORIA', `auditoria_extracao:${extracaoId}`, '2026-09-01T08:00:00.000Z'],
        [CONTEINERES, `${C1}\n${C2}`, 'S2_AUDITORIA', `auditoria_extracao:${extracaoId}`, '2026-09-01T08:00:00.000Z'],
      ]);
      const nao: DadoNaoPublicado[] = await m.deps.fontes.dadosNaoPublicados!(m.c.orgId, m.masterId, pedidos);
      assert.deepEqual(nao.map((n) => [n.dado, n.motivo]), [[CONSIGNATARIO, 'CONSIGNATARIO_SEM_CRITERIO_APROVADO']]);
      assert.deepEqual(await m.deps.fontes.valores(m.c.orgId, '00000000-0000-0000-0000-000000000000', [], pedidos), [], 'outro Master: nada');
      const outra = await cenario(pool, 'e1-adapt-outra-org');
      assert.deepEqual(await m.deps.fontes.valores(outra.orgId, m.masterId, [], pedidos), [], 'outra organização: nada');
    });

    await t.test('[E1-14] MSC, Hapag e ZIM: os dados do MBL preenchem e o documento só é gerado e disponibilizado (sem upload, sem conferência, sem Outlook)', async () => {
      const casos: Array<[TipoDocumento, string]> = [['MEMORANDO_MSC', 'MSC'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']];
      for (const [tipo, codigo] of casos) {
        const m = await mundo(pool, `e1-a-${codigo}`, tipo, [BL, CAMPO_NAVIO, DATA], codigo);
        const r = await prepararDocumento(m.deps, m.ator, m.masterId);
        assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
        const av = await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId);
        assert.equal(av.procedimento, 'GERAR_E_DISPONIBILIZAR');
        assert.deepEqual(av.documentos[0].conteudo.campos.find((x) => x.campo === 'navio'), { campo: 'navio', valor: 'NAVIO SINTETICO A V.001' }, 'navio do MBL (S2), sem Clara');
        assert.deepEqual([av.situacao.proximoPasso?.passo, av.situacao.texto], ['DOCUMENTO_DISPONIVEL', TEXTO_DOCUMENTO_DISPONIVEL]);
        const documentoId = (r as { documentoId: string }).documentoId;
        assert.deepEqual(await registrarAssinatura(m.deps, m.ator, documentoId, arquivoSintetico(tipo, 'assinado')), { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' });
        const acesso = { outlook: outlookFalso(m.c.membershipPessoa, m.c.homePessoa), caixaMonitorada: caixaMonitoradaFalsa(m.c.caixaId) };
        const rascunho = await prepararRascunho(m.deps, m.ator, m.masterId, acesso, { autorizacao: PERMITIDA });
        assert.deepEqual([rascunho.tipo, (rascunho as { motivo?: string }).motivo], ['NAO_PREPARADO', 'FLUXO_NAO_APLICAVEL'], `${tipo}: sem Outlook`);
        assert.equal(acesso.outlook.chamadas.length, 0, 'nenhuma chamada ao Outlook');
      }
      // Hapag/ZIM: "Exportador/Importador" (DOC-17) vem do consignatário do MBL, que não tem critério aprovado → falta, com o motivo.
      const h = await mundo(pool, 'e1-a-hapag-exp', 'MEMORANDO_HAPAG_ROCHAMAR', [BL, CAMPO_EXPORTADOR, DATA], 'HAPAG_LLOYD');
      const s = await situacao(h);
      const faltando = s.pendencias.find((p) => p.passo === 'OBTER_DADOS_FALTANTES') as { faltantes: Array<{ campo: string; naoPublicados?: DadoNaoPublicado[] }> } | undefined;
      assert.deepEqual(faltando?.faltantes.map((f) => [f.campo, f.naoPublicados?.map((n) => n.motivo)]), [['exportador', ['CONSIGNATARIO_SEM_CRITERIO_APROVADO']]]);
      assert.equal((await prepararDocumento(h.deps, h.ator, h.masterId)).tipo, 'NAO_PREPARADO', 'nada é inventado nem promovido');
    });

    await t.test('[E1-15] Evergreen: navio e contêineres do MBL preenchem o termo; o fluxo próprio (assinatura, conferência, Outlook) continua', async () => {
      const m = await mundo(pool, 'e1-evg', 'TERMO_EVERGREEN', [BL, CAMPO_NAVIO, CAMPO_CONTEINERES, DATA], 'EVERGREEN');
      const r = await prepararDocumento(m.deps, m.ator, m.masterId);
      assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
      const av = await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId);
      assert.equal(av.procedimento, 'CICLO_COMPLETO');
      assert.deepEqual(av.documentos[0].conteudo.campos.find((x) => x.campo === 'conteineres'), { campo: 'conteineres', valor: `${C1}\n${C2}` });
      assert.equal(av.situacao.proximoPasso?.passo, 'ASSINAR_DOCUMENTO', 'a assinatura continua sendo o próximo passo da Evergreen');
      assert.equal(av.situacao.texto, null);
    });

    await t.test('[E1-12] alteração irrelevante não gera pendência: nova versão com o mesmo navio escrito (só espaços) e consignatário diferente (não impresso)', async () => {
      const m = await mundo(pool, 'e1-irrel', 'MEMORANDO_MSC', [BL, CAMPO_NAVIO, DATA], 'MSC');
      const r1 = (await prepararDocumento(m.deps, m.ator, m.masterId)) as { documentoId: string };
      await versaoDoMbl(pool, m.c, { id: 'e1-irrel-v2', recebida: '2026-09-05T08:00:00Z', navio: 'NAVIO  SINTETICO A   V.001', consignee: 'OUTRA EMPRESA SINTETICA', sha: 2 });
      await versaoDoMbl(pool, m.c, { id: 'e1-irrel-v3', recebida: '2026-09-06T08:00:00Z', navio: 'NAVIO SINTETICO A V.001', sha: 1 });
      const s = await situacao(m);
      assert.deepEqual([s.preparo.tipo, s.proximoPasso?.passo, s.texto, s.pendencias], ['PREPARADO', 'DOCUMENTO_DISPONIVEL', TEXTO_DOCUMENTO_DISPONIVEL, []]);
      const r2 = (await prepararDocumento(m.deps, m.ator, m.masterId)) as { documentoId: string };
      assert.equal(r2.documentoId, r1.documentoId, 'nenhuma versão nova do documento');
      assert.equal(await documentosDe(pool, m), 1);
    });

    await t.test('[E1-13] campo impresso diferente em outra versão do MBL: pendência da DOC-31.B, as duas versões aparecem e nenhuma é escolhida (nem a mais recente)', async () => {
      const m = await mundo(pool, 'e1-imp', 'MEMORANDO_MSC', [BL, CAMPO_NAVIO, DATA], 'MSC');
      await prepararDocumento(m.deps, m.ator, m.masterId);
      const v2 = await versaoDoMbl(pool, m.c, { id: 'e1-imp-v2', recebida: '2026-09-05T08:00:00Z', navio: 'NAVIO SINTETICO B V.002', sha: 3 });
      const s = await situacao(m);
      assert.equal(s.preparo.tipo, 'DESATUALIZADO');
      if (s.preparo.tipo === 'DESATUALIZADO') {
        assert.equal(s.preparo.motivo, 'VIGENCIA_NAO_VERIFICAVEL');
        assert.deepEqual(s.preparo.naoVerificados, [{ tipo: 'CAMPO', campo: 'navio' }]);
      }
      assert.equal(s.texto, MENSAGEM_VIGENCIA_NAO_VERIFICAVEL);
      const div = s.pendencias.find((p) => p.passo === 'ANALISAR_DIVERGENCIA_DE_DADOS') as { divergentes: Array<{ campo: string; valores: ValorObservado[] }> } | undefined;
      assert.deepEqual(div?.divergentes.map((d) => [d.campo, d.valores.map((v) => v.valor).sort()]), [['navio', ['NAVIO SINTETICO A V.001', 'NAVIO SINTETICO B V.002']]]);
      assert.ok(div?.divergentes[0].valores.some((v) => v.evidencia.ref === `auditoria_extracao:${v2}`), 'cada versão com a sua origem');
      assert.equal((await prepararDocumento(m.deps, m.ator, m.masterId)).tipo, 'NAO_PREPARADO', 'nenhuma versão nova automática');
      assert.equal(await documentosDe(pool, m), 1, 'o PDF anterior continua no histórico');
    });

    await t.test('[E1-08b] versão com contêiner fora do ISO 6346: a lista não é publicada (nem a da outra versão) e o motivo aparece no que falta', async () => {
      const m = await mundo(pool, 'e1-iso', 'TERMO_EVERGREEN', [BL, CAMPO_NAVIO, CAMPO_CONTEINERES, DATA], 'EVERGREEN');
      await versaoDoMbl(pool, m.c, { id: 'e1-iso-v2', recebida: '2026-09-05T08:00:00Z', navio: 'NAVIO SINTETICO A V.001', conteineres: [C1, INVALIDO], sha: 4 });
      const s = await situacao(m);
      const faltando = s.pendencias.find((p) => p.passo === 'OBTER_DADOS_FALTANTES') as { faltantes: Array<{ campo: string; naoPublicados?: DadoNaoPublicado[] }> } | undefined;
      assert.deepEqual(faltando?.faltantes.map((f) => [f.campo, f.naoPublicados?.map((n) => n.motivo).sort()]),
        [['conteineres', ['CONTEINER_FORA_DO_PADRAO_ISO_6346', 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL']]]);
      assert.equal((await prepararDocumento(m.deps, m.ator, m.masterId)).tipo, 'NAO_PREPARADO');
    });

    await t.test('[E1-16] a L1b recebe exatamente o mesmo fato de antes: só PREPARACAO_REGISTRADA da primeira preparação (MSC), nada sobre os campos do MBL', async () => {
      const m = await mundo(pool, 'e1-l1b', 'MEMORANDO_MSC', [BL, CAMPO_NAVIO, DATA], 'MSC');
      await prepararDocumento(m.deps, m.ator, m.masterId);
      const av = await avaliarDocumentacao(m.deps, m.c.orgId, m.masterId);
      const fatos = fatosDocumentaisParaL1b(m.masterId, situacaoDaAgencia(m.masterId, armador('MSC', m.masterId)), av.documentos, av.assinaturas, av.tentativas, av.conferencias);
      assert.deepEqual(fatos.eventos.map((e) => [e.tipo, e.em]), [['PREPARACAO_REGISTRADA', av.documentos[0].preparadoEm]]);
      assert.ok(!JSON.stringify(fatos).includes('NAVIO'), 'nenhum dado do MBL chega à L1b');
    });

    await t.test('[E1-10] o adaptador não carrega OCR nem IA em tempo de execução', async () => {
      const carregados = Object.keys(require.cache);
      for (const proibido of ['docExtractor', 'extracaoPreAlerta', 'geminiClient', 'auditClara']) {
        assert.ok(!carregados.some((k) => k.includes(proibido)), `${proibido} não foi carregado pelo caminho documental`);
      }
    });
  } finally {
    await pool.end();
  }
});
