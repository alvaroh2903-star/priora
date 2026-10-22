import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario } from '../../../operacional/__tests__/cenario';
import { persistirExtracoesAuditoria } from '../../../auditoria/fatos/extracoes';
import { leiturasDocumentaisDoMaster } from '../../../auditoria/fatos/leiturasDocumentaisDoMaster';
import { LeitorDeEvidenciaOcr, OCR_SOURCE_SCHEMA, ResultadoDaLeituraDeEvidencia, SourceOcrEvidenceV1, assinaturaFonte } from '../../../auditoria/ocr/evidenciaOcr';
import { transportadorDoMbl } from '../../../auditoria/parser/transportador';
import type { AssinaturaDoDocumento, DeclaracaoDoTransportador } from '../../../auditoria/parser/transportador';
import type { DocumentoConferido } from '../../../couriers/fatos/courierFatos';
import { FontesPosteriores, SEM_FONTES_POSTERIORES, avaliarLiberacao, canonico, carregarEntrada, obterLiberacaoDoProcesso, recalcularLiberacaoProcesso } from '..';
import { armadorAutomatico, armadorParaL1b } from '../armadorDoMaster';
import { FalhaDoProdutor, combinarFontesPosteriores } from '../fontesPosteriores';
import {
  FONTE_DOCUMENTAL_DO_ARMADOR, LocalizadorDeDeclaracoes, ResultadoDoLocalizador, produtorDoArmador,
} from '../produtorDoArmador';

/** O localizador e o seu resultado com os tipos do contrato documental da O2.1-C (ligados aqui, na composição). */
type Localizador = LocalizadorDeDeclaracoes<DeclaracaoDoTransportador, AssinaturaDoDocumento>;
type Resultado = ResultadoDoLocalizador<DeclaracaoDoTransportador, AssinaturaDoDocumento>;
import { cenarioConfirmado, conferir, eventos, idDoProcesso, preparar, processo, semInvencao } from './apoio';

/**
 * I2 — produtor documental do armador, ponta a ponta SÓ NOS TESTES: leituras do Master (I1) → identidade das evidências
 * (I1) → regra de reconhecimento (O2.1-C) → produtor (I2) → combinador (I1) → decisão da L1b (motor oficial, pela
 * projeção). Tudo sintético: banco temporário, armazenamento de evidências em memória, e um localizador FALSO por
 * tabela (o teste diz o que "foi localizado" em cada evidência; nenhuma regra de localização é implementada ou presumida).
 */

const url = testDatabaseUrl();
const T0 = '2026-10-10T12:00:00.000Z';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MSC = 'MSC MEDITERRANEAN SHIPPING COMPANY S.A.';
const HAPAG = 'HAPAG-LLOYD AG';
const MAERSK = 'MAERSK A/S';
const ZIM = 'ZIM INTEGRATED SHIPPING SERVICES LTD.';
const AGENCIA = 'AGENCIA MARITIMA SINTETICA LTDA';
const NVOCC = 'GAMA CONSOLIDADORA DE CARGAS LTDA';

/* ------------------------------------------------ apoio sintético ------------------------------------------------ */

interface Origem { escopo: string; messageId: string; attachmentId: string; bytes: string }
const assinaturaDe = (o: Origem, v = 1) => assinaturaFonte({ escopo: o.escopo, source: o, contentHash: sha(o.bytes), capturaVersao: v });
const refDe = (o: Origem, v = 1) => `ocr-source:v1:${assinaturaDe(o, v)}`;

function evidencia(o: Origem, v = 1, s: Partial<SourceOcrEvidenceV1> = {}, texto = 'MBL SINTETICO'): SourceOcrEvidenceV1 {
  return {
    schemaVersion: OCR_SOURCE_SCHEMA, assinatura: assinaturaDe(o, v), source: { messageId: o.messageId, attachmentId: o.attachmentId, nome: 'MBL.pdf' },
    contentHash: sha(o.bytes), capturaVersao: v, usable: true, provider: 'mistral', model: 'mistral-ocr-sintetico', capturedAt: `2026-10-0${v}T10:00:00.000Z`,
    pagesProcessed: 1, docSizeBytes: 10, durationMs: 1, pages: [{ pageIndex: 0, markdown: texto, dimensions: null }], ...s,
  };
}

function armazem() {
  const itens = new Map<string, ResultadoDaLeituraDeEvidencia>();
  const pedidas: string[] = [];
  const leitor: LeitorDeEvidenciaOcr = { porAssinatura: async (a) => { pedidas.push(a); return itens.get(a) ?? { tipo: 'AUSENTE' }; } };
  return {
    leitor, pedidas,
    colocar: (a: string, bruto: unknown) => itens.set(a, { tipo: 'ENCONTRADA', bruto }),
    /** O armazenamento não responde para esta chave. */
    falhar: (a: string) => itens.set(a, { tipo: 'INDISPONIVEL' }),
  };
}

/** Localizador FALSO por tabela: devolve o que o teste declarar para cada evidência (padrão: sem resultado confiável). */
function localizadorDeTabela(tabela: Record<string, Resultado>) {
  const vistas: string[] = [];
  const localizador: Localizador = {
    localizar: async (e) => { vistas.push(e.ref); return tabela[e.ref] ?? { tipo: 'SEM_RESULTADO_CONFIAVEL' }; },
  };
  return { localizador, vistas };
}
const declaracao = (nome: string, trecho: string, posicao: DeclaracaoDoTransportador['posicao'] = 'CAMPO_TRANSPORTADOR'): DeclaracaoDoTransportador => ({ nome, posicao, trecho });
const localizado = (declaracoes: DeclaracaoDoTransportador[], assinatura: AssinaturaDoDocumento | null = null): Resultado =>
  ({ tipo: 'LOCALIZADO', declaracoes, assinatura });
const carrier = (nome: string) => localizado([declaracao(nome, `Carrier: ${nome}`)]);

/** A raiz de composição — SÓ NOS TESTES: I1 + O2.1-C + I2 + combinador. `mastersPedidos` registra de quais Masters o produtor pediu leituras. */
function compor(leitor: LeitorDeEvidenciaOcr, localizador: Localizador | null, mastersPedidos: string[] = []): FontesPosteriores {
  return combinarFontesPosteriores([produtorDoArmador({
    leiturasDoMaster: (db, org, masterId) => { mastersPedidos.push(masterId); return leiturasDocumentaisDoMaster(db, org, masterId, leitor); },
    localizador,
    regra: (masterId, leituras) => armadorParaL1b(armadorAutomatico(transportadorDoMbl(masterId, leituras)), FONTE_DOCUMENTAL_DO_ARMADOR),
    agora: () => new Date(T0),
  })]);
}

async function extrair(pool: Pool, c: Cenario, x: { ref: string; mbl: string } & Omit<Origem, 'escopo'>): Promise<string> {
  const [r] = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: x.messageId, internetMessageId: null, attachmentId: x.attachmentId, attachmentNome: 'MBL.pdf', contentType: 'application/pdf',
      remetente: 'operacoes@msc-sintetica.com', recebidaEm: new Date('2026-09-01T08:00:00Z'), referenciasBrutas: [x.ref], associacao: 'CITADA',
    },
    resultado: { tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: true, conhecimento: x.mbl, arquivoSha256: sha(x.bytes) },
    modelo: 'modelo-teste', extraidaEm: new Date('2026-09-01T09:00:00Z'),
  }]);
  return r.extracaoId;
}

test('I2 — produtor documental do armador: caminho completo, só nos testes, sobre dados sintéticos', { skip: !url }, async (t) => {
  const pool = testPool();
  const decisao = async (a: Cenario, p: string, posteriores: FontesPosteriores) =>
    avaliarLiberacao((await carregarEntrada(pool, a.orgId, p, undefined, posteriores))!, T0);
  /**
   * Processo com o MBL legível vinculado ao Master (S2), com o hash dos bytes; devolve o processo e a origem. Na
   * primeira extração, a conferência física (Courier, regra atual) recebe o MBL e o HBL original, para que a frente do
   * Master esteja resolvida e a decisão chegue à agência (onde o armador pesa na etapa, como no G-3).
   */
  const comMbl = async (a: Cenario, ref: string, mbl: string, n = 1, bytes = `bytes-${mbl}`, fisico: DocumentoConferido[] = n === 1 ? ['MBL', 'HBL_ORIGINAL'] : []) => {
    const o: Origem = { escopo: a.homeCaixa, messageId: `MSG-${ref}-${n}`, attachmentId: `ATT-${ref}-${n}`, bytes };
    await extrair(pool, a, { ref, mbl, ...o });
    for (const documento of fisico) await conferir(pool, a, `DHL ${mbl}`, ref, documento, 'RECEBIDO');
    return { p: await idDoProcesso(pool, a, ref), o };
  };
  try {
    await preparar(pool);

    await t.test('[I2-01] armador explicitamente identificado em MBL válido → fato da L1b com a evidência OCR, agência pela matriz', async () => {
      const a = await cenarioConfirmado(pool, 'i2-01');
      const { p, o } = await comMbl(a, 'IM9101-26', 'MEDU9101001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o, 1, {}, `MASTER BILL OF LADING\nCarrier: ${MSC}`));
      const d = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: carrier(MSC) }).localizador));
      assert.deepEqual(d.agencia, { tipo: 'MAPEADA', armador: 'MSC', codigoInformado: 'MSC', agencia: 'MSC', evidencia: { fonte: FONTE_DOCUMENTAL_DO_ARMADOR, ref: refDe(o) } });
      assert.ok(!d.indeterminacao.semFonteIntegrada.includes('ARMADOR'));
      // As datas do fato: vigente desde a chegada do MBL (o e-mail), confirmado e com a fonte desde a captura OCR.
      const mastersPedidos: string[] = [];
      const fatos = await compor(s.leitor, localizadorDeTabela({ [refDe(o)]: carrier(MSC) }).localizador, mastersPedidos)(pool, a.orgId, p);
      assert.deepEqual(mastersPedidos, [d.masterId], 'as leituras pedidas são as do Master publicado, e só dele');
      const armador = fatos.armador?.tipo === 'INTEGRADA' ? fatos.armador : null;
      assert.deepEqual([armador?.fonte, armador?.valor.oficial?.vigenteDesde, armador?.valor.oficial?.ultimaConfirmacaoEm, armador?.valor.oficial?.valor.masterId],
        [{ disponivel: true, desde: '2026-10-01T10:00:00.000Z' }, '2026-09-01T08:00:00.000Z', '2026-10-01T10:00:00.000Z', d.masterId]);
      // A projeção (banco temporário) grava a mesma decisão quando o recálculo recebe a composição.
      await recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: compor(s.leitor, localizadorDeTabela({ [refDe(o)]: carrier(MSC) }).localizador) });
      assert.equal((await obterLiberacaoDoProcesso(pool, a.orgId, p))!.avaliacao.agencia.tipo, 'MAPEADA');
    });

    await t.test('[I2-02] ausência de armador: sem declaração → exceção visível (P12); sem evidência → não integrada (como hoje)', async () => {
      const a = await cenarioConfirmado(pool, 'i2-02');
      const { p, o } = await comMbl(a, 'IM9201-26', 'MEDU9201001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      // O localizador encontrou só o embarcador: nenhum papel de transportador declarado.
      const semDeclaracao = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: localizado([declaracao('EXPORTADORA SINTETICA LTDA', 'Shipper: EXPORTADORA SINTETICA LTDA', 'OUTRA_DECLARACAO')]) }).localizador));
      assert.equal(semDeclaracao.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
      assert.ok(semDeclaracao.itens.some((i) => i.acao === 'IDENTIFICAR_ARMADOR_DO_MASTER'), 'exceção visível; nenhum armador escolhido');
      // Nenhuma evidência no armazenamento: nada se afirma; a L1b continua com o armador não integrado.
      const semEvidencia = await decisao(a, p, compor(armazem().leitor, localizadorDeTabela({}).localizador));
      assert.ok(semEvidencia.indeterminacao.semFonteIntegrada.includes('ARMADOR'));
      assert.equal(canonico(semEvidencia), canonico(await decisao(a, p, SEM_FONTES_POSTERIORES)), 'idêntica à decisão de hoje');
      // Localizador sem resultado confiável para a única evidência: o armador permanece indeterminado (sem escolha provável).
      const semConfianca = await decisao(a, p, compor(s.leitor, localizadorDeTabela({}).localizador));
      assert.equal(canonico(semConfianca), canonico(await decisao(a, p, SEM_FONTES_POSTERIORES)));
    });

    await t.test('[I2-03] agência confundida com armador: a agência que assina "as agent" nunca vira armador', async () => {
      const a = await cenarioConfirmado(pool, 'i2-03');
      const { p, o } = await comMbl(a, 'IM9301-26', 'MEDU9301001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      const soAgencia = localizado([declaracao(AGENCIA, `Signed by ${AGENCIA} as agents for the Carrier`, 'CLAUSULA_DE_ASSINATURA')], { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' });
      const d = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: soAgencia }).localizador));
      assert.equal(d.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
      // Com a cláusula completa, vale o transportador representado, nunca a agência.
      const representado = localizado([
        declaracao(AGENCIA, `Signed by ${AGENCIA} as agent for and on behalf of the Carrier ${HAPAG}`, 'CLAUSULA_DE_ASSINATURA'),
        declaracao(HAPAG, `Signed by ${AGENCIA} as agent for and on behalf of the Carrier ${HAPAG}`, 'CLAUSULA_DE_ASSINATURA'),
      ], { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' });
      const d2 = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: representado }).localizador));
      assert.deepEqual([d2.agencia.tipo, d2.agencia.tipo === 'MAPEADA' && d2.agencia.armador], ['MAPEADA', 'HAPAG_LLOYD']);
      // O signatário "as agent" tem nome de transportador da lista: a assinatura do documento o recusa (nunca vira armador).
      const agenteComNomeDeArmador = localizado([declaracao(MSC, `Carrier: ${MSC}`)], { signatario: MSC, papel: 'AGENTE_DO_TRANSPORTADOR' });
      const d3 = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: agenteComNomeDeArmador }).localizador));
      assert.equal(d3.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO', 'o signatário agente não é o transportador');
    });

    await t.test('[I2-04] NVOCC confundido com transportador marítimo: recusado; com o transportador declarado, vale o transportador', async () => {
      const a = await cenarioConfirmado(pool, 'i2-04');
      const { p, o } = await comMbl(a, 'IM9401-26', 'MEDU9401001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      const nvocc = declaracao(NVOCC, `${NVOCC}, a Non-Vessel Operating Common Carrier`, 'OUTRA_DECLARACAO');
      const so = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: localizado([nvocc]) }).localizador));
      assert.equal(so.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
      const com = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: localizado([nvocc, declaracao(ZIM, `Carrier: ${ZIM}`)]) }).localizador));
      assert.deepEqual([com.agencia.tipo, com.agencia.tipo === 'MAPEADA' && com.agencia.armador], ['MAPEADA', 'ZIM']);
    });

    await t.test('[I2-05] evidências contraditórias: versões ou capturas com transportadores diferentes → exceção, nada escolhido (nem pela ordem)', async () => {
      const a = await cenarioConfirmado(pool, 'i2-05');
      const { p, o: v1 } = await comMbl(a, 'IM9501-26', 'MEDU9501001', 1, 'bytes-versao-1');
      const { o: v2 } = await comMbl(a, 'IM9501-26', 'MEDU9501001', 2, 'bytes-versao-2');
      const s = armazem(); s.colocar(assinaturaDe(v1), evidencia(v1)); s.colocar(assinaturaDe(v2), evidencia(v2));
      for (const tabela of [{ [refDe(v1)]: carrier(MSC), [refDe(v2)]: carrier(MAERSK) }, { [refDe(v2)]: carrier(MSC), [refDe(v1)]: carrier(MAERSK) }]) {
        const d = await decisao(a, p, compor(s.leitor, localizadorDeTabela(tabela).localizador));
        assert.equal(d.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO', 'versões com transportadores diferentes');
      }
      // Duas capturas do MESMO arquivo que divergem.
      const s2 = armazem(); s2.colocar(assinaturaDe(v1, 1), evidencia(v1, 1)); s2.colocar(assinaturaDe(v1, 2), evidencia(v1, 2));
      const d = await decisao(a, p, compor(s2.leitor, localizadorDeTabela({ [refDe(v1, 1)]: carrier(MSC), [refDe(v1, 2)]: carrier(HAPAG) }).localizador));
      assert.equal(d.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO', 'leituras divergentes do mesmo arquivo');
      // Concordantes (as duas versões dizem MSC): fato.
      const d3 = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(v1)]: carrier(MSC), [refDe(v2)]: carrier(MSC) }).localizador));
      assert.equal(d3.agencia.tipo, 'MAPEADA');
    });

    await t.test('[I2-06] documento de outra organização: nunca lido; sob a chave errada, recusado → fonte indisponível, nunca armador', async () => {
      const a = await cenarioConfirmado(pool, 'i2-06a');
      const b = await cenarioConfirmado(pool, 'i2-06b');
      const { p, o: oa } = await comMbl(a, 'IM9601-26', 'MEDU9601001');
      const { o: ob } = await comMbl(b, 'IM9601-26', 'MEDU9601001');
      const s = armazem(); s.colocar(assinaturaDe(ob), evidencia(ob));
      const loc = localizadorDeTabela({ [refDe(ob)]: carrier(MSC) });
      const d = await decisao(a, p, compor(s.leitor, loc.localizador));
      assert.ok(!s.pedidas.includes(assinaturaDe(ob)), 'a chave da organização B nunca é pedida por A');
      assert.deepEqual(loc.vistas, [], 'nenhuma evidência de B chega ao localizador');
      assert.ok(d.indeterminacao.semFonteIntegrada.includes('ARMADOR'));
      // A evidência de B colocada sob a chave de A: a assinatura não fecha com o escopo de A.
      s.colocar(assinaturaDe(oa), evidencia(ob));
      const d2 = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(oa)]: carrier(MSC), [refDe(ob)]: carrier(MSC) }).localizador));
      assert.ok(d2.indeterminacao.fontesIndisponiveis.includes('ARMADOR'));
      assert.equal(d2.agencia.tipo, 'NAO_DETERMINAVEL');
    });

    await t.test('[I2-07] captura ou hash divergente na evidência: recusada → fonte indisponível, nunca armador', async () => {
      const a = await cenarioConfirmado(pool, 'i2-07');
      const { p, o } = await comMbl(a, 'IM9701-26', 'MEDU9701001');
      for (const adulteracao of [{ contentHash: sha('outros-bytes') }, { capturaVersao: 2 }] as Array<Partial<SourceOcrEvidenceV1>>) {
        const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o, 1, adulteracao));
        const loc = localizadorDeTabela({ [refDe(o)]: carrier(MSC) });
        const d = await decisao(a, p, compor(s.leitor, loc.localizador));
        assert.deepEqual([d.agencia.tipo, d.indeterminacao.fontesIndisponiveis.includes('ARMADOR')], ['NAO_DETERMINAVEL', true], JSON.stringify(adulteracao));
        assert.deepEqual(loc.vistas, [], 'evidência recusada nem chega ao localizador');
      }
    });

    await t.test('[I2-08] Master compartilhado entre Houses: o mesmo fato do Master chega a cada processo vinculado', async () => {
      const a = await cenarioConfirmado(pool, 'i2-08');
      const { p: p1, o } = await comMbl(a, 'IM9801-26', 'MEDU9801001');
      const { p: p2 } = await comMbl(a, 'IM9802-26', 'MEDU9801001', 1, `bytes-MEDU9801001`, ['HBL_ORIGINAL']);
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      const fontes = compor(s.leitor, localizadorDeTabela({ [refDe(o)]: carrier(MSC) }).localizador);
      const [d1, d2] = [await decisao(a, p1, fontes), await decisao(a, p2, fontes)];
      assert.equal(d1.masterId, d2.masterId);
      assert.deepEqual([d1.agencia, d2.agencia].map((x) => x.tipo === 'MAPEADA' && [x.agencia, x.evidencia.ref]), [['MSC', refDe(o)], ['MSC', refDe(o)]]);
    });

    await t.test('[I2-09] localizador indisponível: fonte indisponível ("não determinável"), sem exceção operacional e sem armador', async () => {
      const a = await cenarioConfirmado(pool, 'i2-09');
      const { p, o } = await comMbl(a, 'IM9901-26', 'MEDU9901001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      const d = await decisao(a, p, compor(s.leitor, localizadorDeTabela({ [refDe(o)]: { tipo: 'INDISPONIVEL' } }).localizador));
      assert.ok(d.indeterminacao.fontesIndisponiveis.includes('ARMADOR'));
      assert.equal(d.agencia.tipo, 'NAO_DETERMINAVEL');
      assert.ok(!d.itens.some((i) => i.acao === 'IDENTIFICAR_ARMADOR_DO_MASTER'), 'indisponibilidade não vira tarefa humana');
      // Falha (exceção) do localizador: comportamento atual — o combinador recusa a combinação inteira.
      const quebrado: Localizador = { localizar: async () => { throw new Error('falha sintética'); } };
      await assert.rejects(decisao(a, p, compor(s.leitor, quebrado)), (e: unknown) => e instanceof FalhaDoProdutor && e.produtor === 'documental-armador');
    });

    await t.test('[I2-14] armazenamento sem resposta ou capturas além do limite: fonte indisponível, nem com outra versão concordante', async () => {
      const a = await cenarioConfirmado(pool, 'i2-14');
      const { p, o: v1 } = await comMbl(a, 'IM9141-26', 'MEDU9141001', 1, 'bytes-versao-1');
      const { o: v2 } = await comMbl(a, 'IM9141-26', 'MEDU9141001', 2, 'bytes-versao-2');
      const todosMsc = localizadorDeTabela(Object.fromEntries([1, 2, 3, 4, 5].flatMap((v) => [[refDe(v1, v), carrier(MSC)], [refDe(v2, v), carrier(MSC)]])));
      const confere = async (s: ReturnType<typeof armazem>, oQue: string) => {
        const d = await decisao(a, p, compor(s.leitor, todosMsc.localizador));
        assert.deepEqual([d.agencia.tipo, d.indeterminacao.fontesIndisponiveis.includes('ARMADOR')], ['NAO_DETERMINAVEL', true], oQue);
        assert.ok(!d.itens.some((i) => i.acao === 'IDENTIFICAR_ARMADOR_DO_MASTER'), `${oQue}: indisponibilidade não vira tarefa humana`);
      };
      // A versão 1 diz MSC; a versão 2 não pôde ser consultada: nada se conclui (ela poderia dizer outro transportador).
      const s1 = armazem(); s1.colocar(assinaturaDe(v1), evidencia(v1)); s1.falhar(assinaturaDe(v2));
      await confere(s1, 'uma versão sem resposta do armazenamento');
      // Cinco capturas da versão 1 (o limite sondado): pode haver uma sexta, não vista.
      const s2 = armazem();
      for (const v of [1, 2, 3, 4, 5]) s2.colocar(assinaturaDe(v1, v), evidencia(v1, v));
      s2.colocar(assinaturaDe(v2), evidencia(v2));
      await confere(s2, 'capturas além do limite');
      // Controle: as mesmas duas versões, ambas respondidas e concordantes → fato.
      const s3 = armazem(); s3.colocar(assinaturaDe(v1), evidencia(v1)); s3.colocar(assinaturaDe(v2), evidencia(v2));
      assert.equal((await decisao(a, p, compor(s3.leitor, todosMsc.localizador))).agencia.tipo, 'MAPEADA');
    });

    await t.test('[I2-10] produtor desligado (sem localizador): nada é lido e a decisão é a de hoje', async () => {
      const a = await cenarioConfirmado(pool, 'i2-10');
      const { p, o } = await comMbl(a, 'IM9111-26', 'MEDU9111001');
      const s = armazem(); s.colocar(assinaturaDe(o), evidencia(o));
      const d = await decisao(a, p, compor(s.leitor, null));
      assert.deepEqual(s.pedidas, [], 'desligado: nenhuma evidência consultada');
      assert.equal(canonico(d), canonico(await decisao(a, p, SEM_FONTES_POSTERIORES)));
    });

    await t.test('[I2-13] processo sem Master publicado (sem vínculo ou em conflito): o produtor não fornece nada nem escolhe um Master', async () => {
      const a = await cenarioConfirmado(pool, 'i2-13');
      const p = await processo(pool, a, 'IM9131-26');
      const s = armazem();
      const loc = localizadorDeTabela({});
      const pedidos: string[] = [];
      const d = await decisao(a, p, compor(s.leitor, loc.localizador, pedidos));
      assert.deepEqual([pedidos, s.pedidas, loc.vistas, d.agencia.tipo], [[], [], [], 'SEM_MASTER']);
      assert.equal(canonico(d), canonico(await decisao(a, p, SEM_FONTES_POSTERIORES)));
      // Vínculo em CONFLITO (dois MBLs diferentes para o mesmo processo): nenhum Master é escolhido, nada é lido.
      const { p: pc, o: m1 } = await comMbl(a, 'IM9132-26', 'MEDU9132001');
      const { o: m2 } = await comMbl(a, 'IM9132-26', 'MEDU9132002', 2, 'bytes-MEDU9132002');
      const s2 = armazem(); s2.colocar(assinaturaDe(m1), evidencia(m1)); s2.colocar(assinaturaDe(m2), evidencia(m2));
      const loc2 = localizadorDeTabela({ [refDe(m1)]: carrier(MSC), [refDe(m2)]: carrier(MSC) });
      const pedidosNoConflito: string[] = [];
      const dc = await decisao(a, pc, compor(s2.leitor, loc2.localizador, pedidosNoConflito));
      assert.deepEqual([pedidosNoConflito, s2.pedidas, loc2.vistas, dc.agencia.tipo], [[], [], [], 'SEM_MASTER'], 'nenhum dos Masters em conflito é escolhido');
      assert.equal(canonico(dc), canonico(await decisao(a, pc, SEM_FONTES_POSTERIORES)));
    });

    await t.test('[I2-11] combinador sem novos fatos: projeção sem mudança material, nenhum evento novo', async () => {
      const a = await cenarioConfirmado(pool, 'i2-11');
      const { p } = await comMbl(a, 'IM9121-26', 'MEDU9121001');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'PRIMEIRA_AVALIACAO');
      const antes = await obterLiberacaoDoProcesso(pool, a.orgId, p);
      for (const fontes of [compor(armazem().leitor, localizadorDeTabela({}).localizador), compor(armazem().leitor, null)]) {
        assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: fontes })).status, 'SEM_MUDANCA_MATERIAL');
      }
      assert.equal(canonico((await obterLiberacaoDoProcesso(pool, a.orgId, p))!.avaliacao), canonico(antes!.avaliacao));
      assert.equal(await eventos(pool, p), 1);
      semInvencao((await obterLiberacaoDoProcesso(pool, a.orgId, p))!);
    });
  } finally {
    await pool.end();
  }
});

test('[I2-12] guardas: o produtor não está ligado, não importa o contrato nem a regra da O2.1-C nem a I1, não usa flags, prefixo, remetente nem tracking', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'produtorDoArmador.ts'), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const imports = [...codigo.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)].map((m) => `${m[1] ? 'type ' : ''}${m[2]}`).sort();
  assert.deepEqual(imports, [
    '../../auditoria/fatos/vinculos', 'type ../../identidade', 'type ../dominio', 'type ./entrada',
  ], 'só o vínculo S2 e TIPOS (o contrato documental e a regra da O2.1-C, a I1 e o combinador entram por injeção: P1A-10, L04 e LD-08 intactas)');
  for (const proibido of ['process.env', 'PRIORA_', 'armadorDoMaster', 'leiturasDocumentaisDoMaster', 'evidenciaOcr', 'fontesPosteriores', 'docExtractor',
    'parser/transportador', 'transportadorDoMbl', 'gemini', 'mistral', 'graph', 'remetente', 'tracking', 'prefixo', 'chaveMaster', 'conhecimento', 'agenciaDoArmador', 'decidirProcesso', 'query(']) {
    assert.ok(!codigo.includes(proibido), `produtorDoArmador.ts não usa ${proibido}`);
  }
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : todos(path.join(d, e.name))) : [path.join(d, e.name)]));
  // Qualquer referência ao módulo (import com from, import só de efeito, require ou import dinâmico).
  assert.deepEqual(todos(raiz).filter((f) => f.endsWith('.ts') && /['"`][^'"`]*\/produtorDoArmador(\.ts)?['"`]/.test(fs.readFileSync(f, 'utf8'))), [], 'nenhum arquivo de produção usa o produtor');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'projecao.ts'), 'utf8'), /opcoes\.posteriores \?\? SEM_FONTES_POSTERIORES/, 'a projeção segue sem fontes posteriores');
  assert.match(fs.readFileSync(path.join(raiz, 'liberacao', 'documentos', 'aplicacao', 'postgres.ts'), 'utf8'), /armador: FONTE_DO_ARMADOR_PENDENTE/, 'os documentos seguem com o armador pendente');
});
