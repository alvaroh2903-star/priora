import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Produção P1 (Entrega 1) — assinatura HMAC das requisições M2M do handoff.
 *
 * String canônica assinada: método + caminho normalizado + timestamp + nonce
 * + SHA-256 do corpo EXATO da requisição (hex) — nessa ordem, separados por
 * `\n`. Por incluir timestamp e nonce dentro do que é assinado, uma
 * assinatura válida também prova que esses dois campos não foram adulterados
 * depois de assinados.
 */

export interface EntradaAssinatura {
  metodo: string;
  /** Caminho normalizado (sem query string, sem barra final, minúsculo). */
  caminho: string;
  /** Timestamp Unix em segundos, como veio no cabeçalho (string, não Number — preserva o valor exato assinado). */
  timestamp: string;
  nonce: string;
  /** Corpo EXATO da requisição (bytes crus, antes de qualquer parse). */
  corpoBruto: Buffer | string;
}

export function normalizarCaminho(caminho: string): string {
  const semQuery = caminho.split('?')[0];
  const semBarraFinal = semQuery.length > 1 ? semQuery.replace(/\/+$/, '') : semQuery;
  return semBarraFinal.toLowerCase();
}

export function construirStringCanonica(e: EntradaAssinatura): string {
  const hashCorpo = createHash('sha256').update(e.corpoBruto).digest('hex');
  return [e.metodo.toUpperCase(), normalizarCaminho(e.caminho), e.timestamp, e.nonce, hashCorpo].join('\n');
}

export function calcularAssinatura(segredo: string, stringCanonica: string): string {
  return createHmac('sha256', segredo).update(stringCanonica, 'utf8').digest('hex');
}

/**
 * Compara duas assinaturas em tempo constante. Nunca usa `===`/`!==` em
 * segredo derivado: tamanhos diferentes são tratados sem atalho (comparação
 * de tamanho completo substituída por uma comparação de tamanho fixo contra
 * si mesma, para não revelar o tamanho esperado por timing).
 */
export function assinaturasIguaisEmTempoConstante(calculada: string, recebida: string): boolean {
  const a = Buffer.from(calculada, 'hex');
  const b = Buffer.from(recebida, 'hex');
  if (a.length !== b.length) {
    // Ainda gasta um tempo proporcional ao comparar `a` com ela mesma —
    // nunca retorna imediatamente só por causa do tamanho.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Janela de tolerância do timestamp (segundos). Documentado e testado — ver relatório da Entrega 1. */
export const TOLERANCIA_TIMESTAMP_SEGUNDOS = 5 * 60;

export function timestampDentroDaTolerancia(timestampSegundos: string, agora: Date = new Date(), toleranciaSegundos = TOLERANCIA_TIMESTAMP_SEGUNDOS): boolean {
  const t = Number(timestampSegundos);
  if (!Number.isFinite(t) || !Number.isInteger(t)) return false;
  const diffSegundos = Math.abs(agora.getTime() / 1000 - t);
  return diffSegundos <= toleranciaSegundos;
}
