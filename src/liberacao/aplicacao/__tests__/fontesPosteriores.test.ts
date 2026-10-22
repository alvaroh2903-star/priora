import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario } from '../../../operacional/__tests__/cenario';
import type { ArmadorDoMaster, EstadoOficial, FonteL1b, Integrado } from '../../dominio';
import {
  FatosPosteriores, FontesPosteriores, SEM_FONTES_POSTERIORES, avaliarLiberacao, canonico, carregarEntrada, obterLiberacaoDoProcesso,
  recalcularLiberacaoProcesso,
} from '..';
import {
  CAMPOS_DE_FONTE, ErroDeComposicao, FONTE_DO_CAMPO, FalhaDoProdutor, ProdutorDeFatos, combinarFontesPosteriores,
} from '../fontesPosteriores';
import { cenarioConfirmado, conferir, eventos, idDoProcesso, preparar, processo, semInvencao, vincular } from './apoio';

/**
 * I1 — combinador de produtores independentes das fontes posteriores da L1b. Produtores SINTÉTICOS, só nos testes
 * (nenhum produtor real existe nesta entrega, nenhum HeadCargo). A L1b só é chamada pelos caminhos oficiais
 * (`avaliarLiberacao` / recálculo), como em produção.
 */

const url = testDatabaseUrl();
const T0 = '2026-10-01T10:00:00.000Z';
const db = {} as never; // os produtores sintéticos não usam o banco

const armadorConhecido = (masterId: string, codigo = 'MSC'): Integrado<EstadoOficial<ArmadorDoMaster>> => ({
  tipo: 'INTEGRADA', fonte: { disponivel: true, desde: T0 },
  valor: { oficial: { valor: { masterId, codigo }, vigenteDesde: T0, ultimaConfirmacaoEm: T0, evidencia: { fonte: 'sintetica', ref: 'sintetica:1' } }, historico: [] },
});
const armadorIndisponivel: Integrado<EstadoOficial<ArmadorDoMaster>> = { tipo: 'INTEGRADA', fonte: { disponivel: false, desde: T0 }, valor: { oficial: null, historico: [] } };
const preAlertaConfirmado: FatosPosteriores['preAlerta'] = {
  tipo: 'INTEGRADA', fonte: { disponivel: true, desde: T0 },
  valor: { oficial: { valor: 'CONFIRMADO', vigenteDesde: T0, ultimaConfirmacaoEm: T0, evidencia: { fonte: 'sintetica', ref: 'sintetica:2' } }, historico: [] },
};

function produtor<C extends keyof typeof FONTE_DO_CAMPO>(nome: string, campos: C[], produzir: ProdutorDeFatos<C>['produzir']): ProdutorDeFatos {
  return { nome, campos, produzir } as unknown as ProdutorDeFatos;
}

/* ------------------------------------------------ o combinador, isolado ------------------------------------------------ */

test('[FP-01] combinador vazio: é exatamente a porta atual (SEM_FONTES_POSTERIORES) e não fornece nada', async () => {
  const vazio = combinarFontesPosteriores([]);
  assert.equal(vazio, SEM_FONTES_POSTERIORES);
  assert.deepEqual(await vazio(db, 'org', 'proc'), {});
});

test('[FP-02] dois produtores com campos distintos: cada campo vem do seu dono, com os mesmos argumentos', async () => {
  const chamadas: string[] = [];
  const f = combinarFontesPosteriores([
    produtor('documental-sintetico', ['armador'], async (_d, o, p) => { chamadas.push(`a:${o}:${p}`); return { armador: armadorConhecido('m1') }; }),
    produtor('pre-alerta-sintetico', ['preAlerta'], async (_d, o, p) => { chamadas.push(`b:${o}:${p}`); return { preAlerta: preAlertaConfirmado }; }),
  ]);
  const fatos = await f(db, 'org-x', 'proc-y');
  assert.deepEqual(Object.keys(fatos).sort(), ['armador', 'preAlerta']);
  assert.deepEqual(fatos.armador, armadorConhecido('m1'));
  assert.deepEqual(fatos.preAlerta, preAlertaConfirmado);
  assert.deepEqual(chamadas.sort(), ['a:org-x:proc-y', 'b:org-x:proc-y']);
  // Campo não fornecido (ou undefined) não entra: fica a NAO_INTEGRADA padrão da L1b, nunca um valor vazio inventado.
  const parcial = combinarFontesPosteriores([produtor('p', ['armador', 'viagem'], async () => ({ armador: undefined }))]);
  assert.deepEqual(await parcial(db, 'o', 'p'), {});
});

test('[FP-03] sobrescrita impossível: campo com dois donos, campo alheio, campo desconhecido, nome repetido', async () => {
  const comp = (ps: ProdutorDeFatos[], codigo: string) => assert.throws(() => combinarFontesPosteriores(ps), (e: unknown) => e instanceof ErroDeComposicao && e.codigo === codigo, codigo);
  const nada = async () => ({});
  comp([produtor('a', ['armador'], nada), produtor('b', ['armador', 'viagem'], nada)], 'CAMPO_COM_DOIS_DONOS');
  comp([produtor('a', ['armador'], nada), produtor('a', ['viagem'], nada)], 'NOME_REPETIDO');
  comp([produtor('a', [], nada)], 'SEM_CAMPOS');
  comp([produtor('', ['armador'], nada)], 'SEM_NOME');
  comp([produtor('a', ['armador', 'armador'], nada)], 'CAMPO_REPETIDO');
  comp([produtor('a', ['overrides' as never], nada)], 'CAMPO_DESCONHECIDO'); // não é fonte Integrado: não entra por aqui
  comp([produtor('a', ['liberado' as never], nada)], 'CAMPO_DESCONHECIDO');
  // Em execução: o produtor "a" tenta escrever o campo do produtor "b" → a combinação inteira é recusada.
  const f = combinarFontesPosteriores([
    produtor('a', ['armador'], async () => ({ armador: armadorConhecido('m1'), preAlerta: preAlertaConfirmado } as never)),
    produtor('b', ['preAlerta'], async () => ({ preAlerta: preAlertaConfirmado })),
  ]);
  await assert.rejects(f(db, 'o', 'p'), (e: unknown) => e instanceof FalhaDoProdutor && e.produtor === 'a' && e.codigo === 'CAMPO_ALHEIO' && e.campo === 'preAlerta');
});

test('[FP-04] falha de um produtor: recusa a combinação inteira, com o nome do produtor; nada parcial, nada vira sucesso', async () => {
  const causa = new Error('fonte quebrada');
  const ok = produtor('ok', ['preAlerta'], async () => ({ preAlerta: preAlertaConfirmado }));
  const f = combinarFontesPosteriores([ok, produtor('quebrado', ['armador'], async () => { throw causa; })]);
  await assert.rejects(f(db, 'o', 'p'), (e: unknown) => e instanceof FalhaDoProdutor && e.produtor === 'quebrado' && e.codigo === 'EXCECAO' && e.causa === causa);
  for (const [resposta, codigo] of [
    [null, 'RESPOSTA_INVALIDA'],
    [[], 'RESPOSTA_INVALIDA'],
    [{ armador: { tipo: 'TALVEZ' } }, 'VALOR_FORA_DO_CONTRATO'],
    [{ armador: { tipo: 'INTEGRADA', valor: {} } }, 'VALOR_FORA_DO_CONTRATO'], // sem disponibilidade da fonte
    [{ armador: { tipo: 'NAO_INTEGRADA', valor: 'x' } }, 'VALOR_FORA_DO_CONTRATO'],
    [{ armador: 'MSC' }, 'VALOR_FORA_DO_CONTRATO'],
  ] as Array<[unknown, string]>) {
    const g = combinarFontesPosteriores([ok, produtor('ruim', ['armador'], async () => resposta as never)]);
    await assert.rejects(g(db, 'o', 'p'), (e: unknown) => e instanceof FalhaDoProdutor && e.produtor === 'ruim' && e.codigo === codigo, codigo);
  }
});

test('[FP-05] contrato exaustivo: os campos de fonte são exatamente os Integrado da L1b; os do HeadCargo são três e não têm produtor', () => {
  assert.equal(CAMPOS_DE_FONTE.length, 17);
  assert.equal(new Set(Object.values(FONTE_DO_CAMPO)).size, 17, 'uma fonte semântica por campo');
  assert.ok(!(Object.values(FONTE_DO_CAMPO) as FonteL1b[]).includes('COURIER'), 'o Courier já entra pela L2, não por produtor');
  assert.deepEqual(CAMPOS_DE_FONTE.filter((c) => FONTE_DO_CAMPO[c].startsWith('HEADCARGO_')).sort(), ['financeiroCliente', 'pagamentoArmador', 'termoUnico']);
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'fontesPosteriores.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Os únicos "HEADCARGO" admitidos são as chaves de fonte da própria L1b no mapeamento (literais do domínio).
  assert.doesNotMatch(codigo.replace(/'HEADCARGO_[A-Z_]+'/g, "''"), /headcargo|https?:|fetch\(|process\.env/i, 'nenhum produtor, endpoint ou credencial do HeadCargo');
  assert.ok([...codigo.matchAll(/^import\s+(?!type\b).*from\s+'\.\.\/dominio'/gm)].length === 0, 'do domínio, só tipos (R33)');
});

/* ------------------------------------------------ com a L1b, no cluster temporário ------------------------------------------------ */

test('[FP-06] combinador com a L1b real: decisões idênticas sem produtor; HeadCargo ausente; indisponível ≠ negativo; falha não grava nada', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await preparar(pool);
    /** Master real (S2) com o MBL conferido no Courier e o HBL original de cada processo. */
    const masterReal = async (a: Cenario, codigos: string[], mbl: string) => {
      for (const [i, codigo] of codigos.entries()) await vincular(pool, a, codigo, mbl, { messageId: `${mbl}-${i}` });
      await conferir(pool, a, `DHL ${mbl}`, codigos[0], 'MBL', 'RECEBIDO');
      for (const codigo of codigos) await conferir(pool, a, `DHL ${mbl}`, codigo, 'HBL_ORIGINAL', 'RECEBIDO');
      const ids = await Promise.all(codigos.map((c) => idDoProcesso(pool, a, c)));
      const { rows } = await pool.query(`SELECT DISTINCT master_id FROM processo_master_vinculos WHERE organization_id = $1`, [a.orgId]);
      return { ids, masterId: rows[0].master_id as string };
    };
    const decisao = async (a: Cenario, p: string, posteriores: FontesPosteriores, agora = T0) =>
      avaliarLiberacao((await carregarEntrada(pool, a.orgId, p, undefined, posteriores))!, agora);

    await t.test('regressão: com o combinador vazio, a decisão e a projeção são idênticas às atuais (processo vazio, Master compartilhado)', async () => {
      const a = await cenarioConfirmado(pool, 'fp-reg');
      const vazio = await processo(pool, a, 'IM8001-26');
      const { ids } = await masterReal(a, ['IM8002-26', 'IM8003-26'], 'MEDU8002001');
      for (const p of [vazio, ...ids]) {
        assert.equal(canonico(await decisao(a, p, combinarFontesPosteriores([]))), canonico(await decisao(a, p, SEM_FONTES_POSTERIORES)));
        const r1 = await recalcularLiberacaoProcesso(pool, a.orgId, p);
        assert.equal(r1.status, 'PRIMEIRA_AVALIACAO');
        const antes = await obterLiberacaoDoProcesso(pool, a.orgId, p);
        const r2 = await recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: combinarFontesPosteriores([]) });
        assert.equal(r2.status, 'SEM_MUDANCA_MATERIAL', 'o combinador vazio não muda nada material');
        assert.equal(canonico((await obterLiberacaoDoProcesso(pool, a.orgId, p))!.avaliacao), canonico(antes!.avaliacao));
        assert.equal(await eventos(pool, p), 1, 'nenhum evento novo');
        semInvencao((await obterLiberacaoDoProcesso(pool, a.orgId, p))!);
      }
    });

    await t.test('HeadCargo ausente: com um produtor documental ativo, Termo Único, financeiro e pagamento ficam NÃO INTEGRADOS (nunca atendidos)', async () => {
      const a = await cenarioConfirmado(pool, 'fp-hc');
      const { ids: [p], masterId } = await masterReal(a, ['IM8101-26'], 'MEDU8101001');
      const documental = combinarFontesPosteriores([produtor('documental-sintetico', ['armador'], async () => ({ armador: armadorConhecido(masterId) }))]);
      const d = await decisao(a, p, documental);
      const sem = d.indeterminacao.semFonteIntegrada;
      for (const f of ['HEADCARGO_TERMO_UNICO', 'HEADCARGO_FINANCEIRO_CLIENTE'] as FonteL1b[]) assert.ok(sem.includes(f), `${f} segue não integrada`);
      // Pagamento ao armador: a frente fica não determinável pela fonte não integrada (nunca "pago" nem "não pago").
      assert.deepEqual([d.pagamentoArmador.estado, d.pagamentoArmador.estado === 'NAO_DETERMINAVEL' && d.pagamentoArmador.ind.semFonteIntegrada],
        ['NAO_DETERMINAVEL', ['HEADCARGO_PAGAMENTO_ARMADOR']]);
      assert.ok(!sem.includes('ARMADOR'), 'o armador veio do produtor documental');
      assert.deepEqual([d.agencia.tipo, d.agencia.tipo === 'MAPEADA' && d.agencia.agencia], ['MAPEADA', 'MSC'], 'o fato documental chega à L1b e determina a agência pela matriz');
      const marcos = d.progresso.map((m) => m.marco);
      for (const m of ['CLIENTE_CONCLUIDO', 'CONDICAO_FINANCEIRA_DO_ARMADOR', 'LIBERADO']) assert.ok(!marcos.includes(m as never), `${m} nunca presumido sem a fonte`);
      assert.equal(d.liberado, null);
      // Sem nenhum produtor, o mesmo processo continua com o armador não integrado (comportamento atual).
      assert.ok((await decisao(a, p, SEM_FONTES_POSTERIORES)).indeterminacao.semFonteIntegrada.includes('ARMADOR'));
    });

    await t.test('fonte integrada e indisponível: "não determinável", nem positivo nem negativo', async () => {
      const a = await cenarioConfirmado(pool, 'fp-ind');
      const { ids: [p] } = await masterReal(a, ['IM8201-26'], 'MEDU8201001');
      const d = await decisao(a, p, combinarFontesPosteriores([produtor('documental-sintetico', ['armador'], async () => ({ armador: armadorIndisponivel }))]));
      assert.ok(d.indeterminacao.fontesIndisponiveis.includes('ARMADOR'));
      assert.ok(!d.indeterminacao.semFonteIntegrada.includes('ARMADOR'));
      assert.equal(d.agencia.tipo, 'NAO_DETERMINAVEL', 'nenhuma agência sem o fato (nem negativa, nem inferida)');
    });

    await t.test('falha de um produtor no recálculo: o recálculo falha com o nome do produtor e a projeção vigente não muda', async () => {
      const a = await cenarioConfirmado(pool, 'fp-falha');
      const { ids: [p] } = await masterReal(a, ['IM8301-26'], 'MEDU8301001');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const antes = await obterLiberacaoDoProcesso(pool, a.orgId, p);
      const quebrado = combinarFontesPosteriores([produtor('quebrado', ['armador'], async () => { throw new Error('indisponível por bug'); })]);
      await assert.rejects(recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: quebrado }), (e: unknown) => e instanceof FalhaDoProdutor && e.produtor === 'quebrado');
      assert.equal(canonico((await obterLiberacaoDoProcesso(pool, a.orgId, p))!), canonico(antes!), 'nada gravado');
      assert.equal(await eventos(pool, p), 1);
    });
  } finally {
    await pool.end();
  }
});
