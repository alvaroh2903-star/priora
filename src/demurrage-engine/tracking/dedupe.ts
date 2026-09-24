import { createHash } from 'crypto';

/**
 * Chave de deduplicação de um evento de tracking (Fase 5). A API central real
 * NÃO fornece id estável de evento, então usamos o fallback aprovado: armador +
 * target + contêiner + tipo normalizado + data + descrição/local normalizados.
 * Nunca a posição no array nem o timestamp da consulta — reconsultar o mesmo
 * evento histórico amanhã tem que dar a MESMA chave (idempotência).
 */
export interface DedupeCampos {
  armador: string | null;
  trackingTargetId: string;
  containerNumero: string | null;
  tipoEvento: string;
  dataEvento: string | null;
  statusDesc: string | null;
  location: string | null;
}

function norm(s: string | null): string {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function dedupeHash(c: DedupeCampos): string {
  const payload = JSON.stringify([
    norm(c.armador),
    c.trackingTargetId,
    norm(c.containerNumero),
    c.tipoEvento,
    c.dataEvento || '',
    norm(c.statusDesc),
    norm(c.location),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}
