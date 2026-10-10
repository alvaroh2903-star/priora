import { z } from 'zod/v4';
import { generateStructured, isAiConfigured } from '../../ai/geminiClient';
import { TrackingEvent } from './types';
import { classifyEvent } from './eventTypes';
import { parseDateToISO } from './scrapers/hapag';

/**
 * Priora — CAMADA DE RESILIÊNCIA (IA / Clara) do bot de armadores.
 *
 * Quando o parser DEDICADO de um armador não reconhece o layout (o portal mudou,
 * ou é um armador sem parser próprio), esta camada entra: a Clara (Gemini) lê o
 * TEXTO CRU já renderizado da página e extrai a LINHA DO TEMPO de eventos de
 * rastreio — adaptando-se a QUALQUER layout SEM mexer no código. É o que mantém a
 * API no ar quando um armador muda o site (em vez de devolver "0 eventos" e exigir
 * reescrever o scraper no susto).
 *
 * Importante: devolve EVENTOS (não datas prontas). Eles passam pelo MESMO pipeline
 * validado (`classifyEvent` + `deriveContainers`) dos parsers dedicados — então
 * descarga/retirada/devolução saem com as mesmas regras (transbordo, origem×destino).
 * Regra da casa: a Clara NUNCA inventa — campo ausente = null.
 */

const EventSchema = z.object({
  /** Data do evento em AAAA-MM-DD (ou null se não houver/não parseável). */
  date: z.string().nullable(),
  /** Descrição do movimento, FIEL ao texto (ex.: "Discharged", "Empty Returned"). */
  status: z.string(),
  location: z.string().nullable(),
  /** Nº do contêiner (ISO 6346) a que o evento pertence, se identificável. */
  container: z.string().nullable(),
  vessel: z.string().nullable(),
  voyage: z.string().nullable(),
});

const Schema = z.object({
  events: z.array(EventSchema),
  /** 0..1 — quão confiante a IA está de que achou a linha do tempo real. */
  confidence: z.number(),
});

const SYSTEM_PROMPT = `Você é a Clara, especialista em logística e demurrage. Vou te dar o TEXTO CRU já renderizado de uma página de rastreio de um armador. Sua tarefa: extrair a LINHA DO TEMPO de eventos de movimentação, por contêiner.

Para CADA evento devolva:
- date: a data do evento em AAAA-MM-DD. null se não houver.
- status: a descrição do movimento, FIEL ao texto (ex.: "Discharged", "Discharged from vessel", "Gate out", "Empty returned", "Loaded", "Vessel arrival/departure", "Gate in"). Mantenha o termo original do portal.
- location: cidade/terminal do evento, se houver; senão null.
- container: o número do contêiner (ISO 6346: 4 letras + 7 dígitos) a que este evento pertence, se der para identificar; senão null.
- vessel / voyage: navio e viagem, se aparecerem; senão null.

MUITO IMPORTANTE: inclua TODOS os eventos que achar, com atenção especial a:
- DESCARGA no destino (discharge / discharged from vessel / descarregado);
- RETIRADA do cheio (gate out / picked up / saída do terminal);
- DEVOLUÇÃO do vazio (empty returned / empty return / devolução).
Ignore itens de navegação/menu/rodapé do site — só interessa o rastreio.

PREVISÕES NÃO SÃO EVENTOS: ignore tudo que for estimado/planejado (ETA, ETD, "Estimated", "Estimate", "Expected", "Planned", "Previsto", datas de chegada/descarga/devolução que ainda não aconteceram). Só devolva movimentos que JÁ OCORRERAM ("Actual"). Uma previsão lida como fato faria o contêiner parecer descarregado/devolvido antes da hora.

Regras: NUNCA invente datas ou números. Normalize datas para AAAA-MM-DD. Campo ausente = null. Se não houver nenhum evento de rastreio real no texto, devolva events vazio e confidence baixa. Responda só com o objeto estruturado.`;

/** Normaliza a data vinda da IA: aceita AAAA-MM-DD direto; senão tenta parsear. */
function normalizeAiDate(d: string | null | undefined): string | null {
  const s = (d || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return parseDateToISO(s);
}

/**
 * Extrai eventos de rastreio do texto cru via IA (Clara). Devolve [] quando a IA
 * não está configurada, o texto é vazio, ou nada foi reconhecido — nunca lança.
 */
export async function extractEventsViaAI(
  carrierName: string,
  reference: string,
  text: string,
): Promise<TrackingEvent[]> {
  // "Sem IA / sem texto" não é erro — só não há o que fazer. Erro REAL da chamada
  // (schema/quota/timeout do Gemini) PROPAGA, p/ o trackShipment registrar no aiDiag.
  if (!isAiConfigured() || !text || !text.trim()) return [];
  const out = await generateStructured(
    Schema,
    SYSTEM_PROMPT,
    `Armador: ${carrierName}\nReferência consultada: ${reference}\n\n` +
      // Janela generosa: o rastreio costuma vir DEPOIS do menu/nav no texto.
      `Texto da página de rastreio:\n${text.slice(0, 30000)}`,
  );
  if (!Array.isArray(out?.events)) return [];
  return out.events
    .filter((e) => e && typeof e.status === 'string' && e.status.trim())
    .map((e) => {
      const status = e.status.trim();
      return {
        date: normalizeAiDate(e.date),
        status,
        location: e.location ? e.location.trim() || null : null,
        vessel: e.vessel ? e.vessel.trim() || null : null,
        voyage: e.voyage ? e.voyage.trim() || null : null,
        type: classifyEvent(status),
        container: e.container ? e.container.trim().toUpperCase() || null : null,
        tipo: null,
      } as TrackingEvent;
    });
}
