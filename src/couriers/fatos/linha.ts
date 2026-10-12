import crypto from 'crypto';
import { limparCodigoProcesso } from '../../identidade';

/**
 * Proveniência da LINHA de conferência, determinada pelo servidor (correção 1).
 *
 * Ao montar a visão do Courier, o servidor sabe como cada processo chegou ao
 * envelope e emite, por linha, um identificador opaco assinado (HMAC) que fixa
 * envelope + referência exata + classificação + formas brutas, ligado à caixa
 * monitorada que gerou a visão. O navegador só devolve o identificador; não
 * declara nada. Identificador ausente, alterado, de outra linha, de outra
 * caixa ou vencido → NAO_VERIFICADA (preservado como evidência, nunca oficial).
 *
 *  - CITADA: citado diretamente numa conversa do envelope que tem só este tracking;
 *  - AMBIGUA: só citado em conversas com mais de um tracking (qual envelope?);
 *  - INFERIDA: achado por referência cruzada (HBL/MBL/booking de outro e-mail);
 *  - CLARA: lido pela Clara e presente literalmente nas conversas analisadas.
 */
export type AssociacaoLinha = 'CITADA' | 'AMBIGUA' | 'INFERIDA' | 'CLARA';
export type AssociacaoVerificada = AssociacaoLinha | 'NAO_VERIFICADA';

export interface ProvenienciaLinha {
  associacao: AssociacaoVerificada;
  /** Formas exatamente como apareceram nos e-mails (vazio quando não verificada ou inferida). */
  brutas: string[];
  emitidaEm: Date | null;
}

export const NAO_VERIFICADA: ProvenienciaLinha = { associacao: 'NAO_VERIFICADA', brutas: [], emitidaEm: null };

const ASSOCIACOES: ReadonlyArray<AssociacaoLinha> = ['CITADA', 'AMBIGUA', 'INFERIDA', 'CLARA'];
export const VALIDADE_LINHA_MS = 7 * 24 * 3_600_000;
const TOLERANCIA_RELOGIO_MS = 5 * 60_000;

interface Carga { v: 1; t: string; r: string; a: AssociacaoLinha; b: string[]; e: number }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const assinar = (segredo: string, caixa: string, carga: string) =>
  crypto.createHmac('sha256', segredo).update(`priora:courier-linha:v1\n${caixa}\n${carga}`).digest('base64url');

export function emitirLinha(
  segredo: string, caixa: string,
  linha: { trackingChave: string; processoRef: string; associacao: AssociacaoLinha; brutas: string[] },
  agora: Date = new Date(),
): string {
  const carga: Carga = { v: 1, t: linha.trackingChave, r: linha.processoRef, a: linha.associacao, b: linha.brutas, e: agora.getTime() };
  const texto = b64(JSON.stringify(carga));
  return `${texto}.${assinar(segredo, caixa, texto)}`;
}

/** Verifica o identificador contra a linha que a requisição diz conferir. Nunca lança. */
export function verificarLinha(
  segredo: string | null, caixa: string | null, token: unknown,
  esperado: { trackingChave: string; processoRef: string },
  agora: Date = new Date(),
): ProvenienciaLinha {
  if (!segredo || !caixa || typeof token !== 'string' || token.length > 4096) return NAO_VERIFICADA;
  const [texto, mac, resto] = token.split('.');
  if (!texto || !mac || resto !== undefined) return NAO_VERIFICADA;
  const esperadoMac = Buffer.from(assinar(segredo, caixa, texto));
  const recebidoMac = Buffer.from(mac);
  if (esperadoMac.length !== recebidoMac.length || !crypto.timingSafeEqual(esperadoMac, recebidoMac)) return NAO_VERIFICADA;
  let carga: Carga;
  try {
    carga = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8'));
  } catch {
    return NAO_VERIFICADA;
  }
  const idade = agora.getTime() - Number(carga?.e);
  if (carga?.v !== 1 || carga.t !== esperado.trackingChave || carga.r !== esperado.processoRef
      || !ASSOCIACOES.includes(carga.a) || !Array.isArray(carga.b)
      || carga.b.some((b) => typeof b !== 'string' || limparCodigoProcesso(b) !== carga.r)
      || !Number.isFinite(idade) || idade < -TOLERANCIA_RELOGIO_MS || idade > VALIDADE_LINHA_MS) {
    return NAO_VERIFICADA;
  }
  return { associacao: carga.a, brutas: carga.b, emitidaEm: new Date(carga.e) };
}

/**
 * Segredo das linhas, derivado do SESSION_SECRET. Sem SESSION_SECRET explícito
 * (o padrão de desenvolvimento é público), não há segredo: nenhuma linha é
 * emitida e toda proveniência fica NAO_VERIFICADA.
 */
export function segredoLinhaPadrao(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = String(env.SESSION_SECRET ?? '').trim();
  return base ? crypto.createHmac('sha256', base).update('priora:courier-linha').digest('base64url') : null;
}
