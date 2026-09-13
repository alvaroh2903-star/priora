/**
 * SMOKE TEST isolado do OCR da Mistral (OCR 4.1). Prova apenas: chave válida,
 * chamada funcionando, páginas/texto retornados, tempo, usage e tratamento de erro.
 *
 * NÃO conecta a PB-001, Rule Engine, UI, comparação MBL/HBL nem banco operacional.
 * Registra SOMENTE metadados seguros (provider, model, pagesProcessed, docSizeBytes,
 * textLength, durationMs, status/error) — NUNCA o markdown/texto.
 *
 * CLI:  npm run mistral:selftest   (exige MISTRAL_OCR_API_KEY no ambiente)
 * Rota: POST /health/mistral-selftest  (usa a mesma função abaixo)
 */
import fs from 'fs';
import path from 'path';
import {
  ocrDocumentoMistral,
  resumoSeguroMistralOcr,
  isMistralOcrConfigured,
  MistralOcrResumoSeguro,
} from './mistralOcrClient';

/** Fixture rasterizado (imagem, SEM camada de texto) — exercita OCR de verdade. */
function caminhoFixtureSample(): string {
  const candidatos = [
    path.join(__dirname, 'fixtures', 'ocr-sample.pdf'), // ts-node: src/ai/fixtures
    path.join(process.cwd(), 'src', 'ai', 'fixtures', 'ocr-sample.pdf'), // dist: src copiado na imagem
    path.join(__dirname, '..', '..', 'src', 'ai', 'fixtures', 'ocr-sample.pdf'), // dist/ai → src
  ];
  for (const c of candidatos) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* tenta o próximo */
    }
  }
  return candidatos[0];
}

/** Monta o data URI base64 do PDF de fixture (aprovado só para este teste pequeno). */
function fixtureDataUri(): string {
  const pdf = fs.readFileSync(caminhoFixtureSample());
  return `data:application/pdf;base64,${pdf.toString('base64')}`;
}

/**
 * Roda o self-test e devolve APENAS o resumo seguro (o resultado rico, com o
 * markdown, fica interno em `ocrDocumentoMistral` e não sai daqui). Reusado pela
 * CLI e pela rota de health.
 */
export async function rodarSelfTestMistralOcr(): Promise<MistralOcrResumoSeguro> {
  const resultado = await ocrDocumentoMistral(fixtureDataUri());
  return resumoSeguroMistralOcr(resultado);
}

/** Execução via CLI (`npm run mistral:selftest`). */
async function main(): Promise<void> {
  if (!isMistralOcrConfigured()) {
    console.log(
      '[mistral-ocr-selftest]',
      JSON.stringify({
        ok: false,
        provider: 'mistral',
        error: 'MISTRAL_OCR_API_KEY ausente — defina no ambiente para rodar o self-test.',
      }),
    );
    process.exit(0);
    return;
  }
  const safe = await rodarSelfTestMistralOcr();
  console.log('[mistral-ocr-selftest]', JSON.stringify(safe)); // só metadados seguros
  process.exit(safe.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    const e = err as { message?: string };
    console.log('[mistral-ocr-selftest] erro fatal:', String(e?.message || err).slice(0, 300));
    process.exit(1);
  });
}
