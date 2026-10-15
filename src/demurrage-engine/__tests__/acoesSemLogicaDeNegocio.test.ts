import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Produção P1 (Entrega 2) — auditoria ESTÁTICA (AST do compilador
 * TypeScript, mesmo mecanismo de `closingD15AV12.test.ts`, D15-A v1.3):
 * prova que `routes/demurrageAcoesRoutes.ts` nunca grava nem calcula nada
 * de negócio diretamente — todo o trabalho passa por EXATAMENTE um serviço
 * de aplicação já congelado (ClosingService, decidirResponsabilidade,
 * resolverPendenciaManual, aplicarFallbackManualContainer) ou por um helper
 * de leitura/isolamento desta própria entrega.
 *
 * Dois testes, independentes:
 *  1) o arquivo da rota nunca contém `.query(` — NENHUMA leitura/escrita SQL
 *     direta, nem para a checagem de organização (que vive nos helpers de
 *     `acoes/organizacaoRecurso.ts`/`acoes/leituraIdempotente.ts`).
 *  2) o arquivo da rota nunca CHAMA nenhuma das funções de escrita/cálculo
 *     que os serviços congelados usam internamente — a lista é a MESMA que
 *     `materialChangeGuard.ts` já documenta como sensíveis (relógio,
 *     Free Time, apuração, observação) mais os writers de responsabilidade/
 *     minuta/fechamento/reabertura/pendência automática.
 */

const CAMINHO_ROTA = path.resolve(__dirname, '..', '..', 'routes', 'demurrageAcoesRoutes.ts');

function lerFonte(caminho: string): ts.SourceFile {
  const codigo = fs.readFileSync(caminho, 'utf8');
  return ts.createSourceFile(caminho, codigo, ts.ScriptTarget.Latest, true);
}

function contemChamadaDeQuery(sourceFile: ts.SourceFile): boolean {
  let encontrado = false;
  const visitar = (node: ts.Node): void => {
    if (encontrado) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') {
      encontrado = true;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  visitar(sourceFile);
  return encontrado;
}

const FUNCOES_PROIBIDAS = [
  'promoverHouseFreeTimeComClient', 'promoverMasterFreeTimeComClient', 'promoverHouseFreeTime', 'promoverMasterFreeTime',
  'applyObservationComClient', 'applyObservation',
  'recalcularApuracaoContainerComClient', 'recalcularApuracaoProcessoComClient', 'recalcularApuracaoContainer', 'recalcularApuracaoProcesso',
  'abrirPendenciaComClient', 'resolverPendenciasComClient', 'resolverPendenciaManualComClient',
  'marcarValidada', 'marcarRejeitada', 'registrarFatoMaterialPosFinal', 'lockProcesso',
];

function chamadasDeFuncaoNoArquivo(sourceFile: ts.SourceFile): Set<string> {
  const achadas = new Set<string>();
  const visitar = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const alvo = node.expression;
      const nome = ts.isIdentifier(alvo) ? alvo.text
        : (ts.isPropertyAccessExpression(alvo) && ts.isIdentifier(alvo.name)) ? alvo.name.text
        : undefined;
      if (nome && FUNCOES_PROIBIDAS.includes(nome)) achadas.add(nome);
    }
    ts.forEachChild(node, visitar);
  };
  visitar(sourceFile);
  return achadas;
}

test('Entrega 2 — auditoria estática (AST): a rota de ações nunca executa SQL diretamente (zero `.query(`)', () => {
  const sourceFile = lerFonte(CAMINHO_ROTA);
  assert.equal(contemChamadaDeQuery(sourceFile), false, 'demurrageAcoesRoutes.ts não deve conter nenhuma chamada `.query(` — toda leitura/escrita passa por um helper ou serviço congelado');
});

test('Entrega 2 — auditoria estática (AST): a rota de ações nunca chama diretamente nenhum writer/calculador de negócio congelado', () => {
  const sourceFile = lerFonte(CAMINHO_ROTA);
  const achadas = chamadasDeFuncaoNoArquivo(sourceFile);
  assert.deepEqual([...achadas], [], `demurrageAcoesRoutes.ts chama função(ões) proibida(s) diretamente: ${[...achadas].join(', ')}`);
});

test('Entrega 2 — auditoria estática (AST): os adaptadores desta entrega (acoes/*.ts) também nunca chamam os writers/calculadores proibidos diretamente', () => {
  const dirAcoes = path.resolve(__dirname, '..', 'acoes');
  for (const nome of fs.readdirSync(dirAcoes)) {
    if (!nome.endsWith('.ts')) continue;
    const sourceFile = lerFonte(path.join(dirAcoes, nome));
    const achadas = chamadasDeFuncaoNoArquivo(sourceFile);
    assert.deepEqual([...achadas], [], `${nome} chama função(ões) proibida(s) diretamente: ${[...achadas].join(', ')}`);
  }
});
