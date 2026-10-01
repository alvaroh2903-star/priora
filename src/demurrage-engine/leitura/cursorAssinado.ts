import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../../config';
import { ErroLeitura } from './contrato';

/**
 * Fase D12 v1.1 — cursor opaco com assinatura de integridade (HMAC-SHA256
 * com o segredo de sessão do servidor), compartilhado pela fila e pela
 * timeline. Formato: `base64url(json).base64url(hmac(json))`. Qualquer
 * cursor malformado, adulterado ou com assinatura que não confere vira
 * `400 cursor_invalido` — o conteúdo nunca é aceito sem a assinatura.
 * A validação do CONTEXTO (organização, processo, filtros, versão) fica
 * com quem consome o payload.
 */

export function hmacLeitura(texto: string): string {
  return createHmac('sha256', config.sessionSecret).update(texto).digest('base64url');
}

export function codificarCursorAssinado(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return `${Buffer.from(json, 'utf8').toString('base64url')}.${hmacLeitura(json)}`;
}

export function decodificarCursorAssinado(cursor: string): Record<string, unknown> {
  const partes = cursor.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) throw new ErroLeitura(400, 'cursor_invalido');
  const json = Buffer.from(partes[0], 'base64url').toString('utf8');
  const esperada = Buffer.from(hmacLeitura(json));
  const recebida = Buffer.from(partes[1]);
  if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  try {
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('forma');
    return payload as Record<string, unknown>;
  } catch {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
}
