import { searchLogisticsMessages, listRecentSummaries, LogisticsSummary } from '../graph/graphService';
import { evaluateDemurrageEmail } from './demurrageFilters';
import { detect } from '../browser/carriers';
import { config } from '../config';

/**
 * Priora — Coleta dos BLs/contêineres de demurrage nos e-mails (Microsoft Graph).
 *
 * Extraído do GET /api/demurrage/sync-refs para que o DISPARO AUTOMÁTICO
 * (autoSync) rode a mesma coleta em segundo plano, sem requisição HTTP. Só
 * devolve refs cujo armador a Priora reconhece (senão não dá para raspar).
 */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms)),
  ]);
}

/**
 * Varre os e-mails e devolve as referências raspáveis, sem repetição.
 * `limit` corta a lista: o botão usa um teto baixo (cada ref vira uma chamada do
 * front); o disparo automático pode ir mais longe, porque roda sem ninguém
 * esperando e o TTL adaptativo já evita re-raspar o que está fresco.
 */
export async function collectEmailRefs(accessToken: string, limit: number): Promise<string[]> {
  const keywords = config.logisticsKeywords;
  let messages = await withTimeout(
    searchLogisticsMessages(accessToken, { keywords, top: 60 }),
    20000,
    'syncRefsSearch',
  ).catch(() => [] as LogisticsSummary[]);
  if (messages.length === 0) {
    messages = await withTimeout(listRecentSummaries(accessToken, { top: 40 }), 20000, 'syncRefsInbox').catch(
      () => [] as LogisticsSummary[],
    );
  }
  const refs = new Set<string>();
  for (const m of messages) {
    const text = [m.bodyPreview || '', m.body?.content || ''].join('\n');
    const ev = evaluateDemurrageEmail({
      id: m.id,
      conversationId: m.conversationId || m.id,
      subject: m.subject,
      bodyPreview: m.bodyPreview,
      bodyText: text,
      senderAddress: m.from?.emailAddress.address,
      receivedDateTime: m.receivedDateTime,
    });
    if (!ev.isCandidate) continue;
    for (const bl of ev.extracted.blNumbers) refs.add(bl);
    for (const ct of ev.extracted.containerNumbers) refs.add(ct);
    // Varredura AMPLA: BLs com prefixo de porto (SGNM…, NBOZ…, QGD3…) e numéricos
    // (COSCO 10díg, Maersk 9díg, Evergreen 12díg). O detect() — que já conhece
    // esses formatos — é quem filtra o que é de fato ref de armador (o resto cai fora).
    const up = (text + ' ' + (m.subject || '')).toUpperCase();
    const cands = [...(up.match(/\b[A-Z]{3,4}[A-Z0-9]{5,15}\b/g) || []), ...(up.match(/\b\d{9,12}\b/g) || [])];
    for (const cand of cands) {
      if (detect(cand).carrier) refs.add(cand);
    }
  }
  // Só refs cujo armador é reconhecido (dupla checagem após normalizar).
  return Array.from(refs)
    .filter((r) => detect(r).carrier)
    .slice(0, limit);
}
