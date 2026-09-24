import { z } from 'zod/v4';
import { generateStructured, isAiConfigured } from '../ai/geminiClient';
import { ContainerInfo } from '../browser/carriers/types';

/**
 * Priora — Camada de I.A. que ORGANIZA o texto cru raspado de um portal de
 * armador em dados por contêiner. Usada quando o scraper específico ainda não
 * existe (o portal devolveu só texto): a Clara estrutura datas/status.
 *
 * Mesmo princípio de sempre: a Clara NUNCA inventa. Campo ausente = null.
 * Sem GEMINI_API_KEY, devolve null e o loop segue com o que o scraper já deu.
 */

const ContainerSchema = z.object({
  numero: z.string().nullable(),
  gateOut: z.string().nullable(), // retirada do cheio (AAAA-MM-DD)
  emptyReturn: z.string().nullable(), // devolução do vazio (AAAA-MM-DD)
  lastFreeDay: z.string().nullable(), // último dia livre, se aparecer
  status: z.string().nullable(), // último movimento
});

const Schema = z.object({
  containers: z.array(ContainerSchema),
  confidence: z.number(),
});

const SYSTEM_PROMPT = `Você é a Clara, especialista em logística e demurrage. Vou te dar um TEXTO CRU copiado da página de rastreio de um armador. Extraia, por CONTÊINER, as datas de movimentação. Seja fiel ao texto — NUNCA invente datas nem números.

Para cada contêiner devolva:
- numero: número do contêiner (ISO 6346), se aparecer; senão null.
- gateOut: data em que o contêiner CHEIO saiu do terminal (retirada pelo importador), AAAA-MM-DD. null se não houver.
- emptyReturn: data de devolução do contêiner VAZIO, AAAA-MM-DD. null se ainda não devolvido.
- lastFreeDay: último dia livre (last free day/demurrage), se explicitado. null caso contrário.
- status: descrição do último movimento conhecido. null se não der.

Regras: responda em português; normalize datas para AAAA-MM-DD; campo ausente = null; se não houver contêiner identificável, devolva containers vazio e confidence baixa. Responda só com o objeto estruturado.`;

/**
 * Organiza o texto cru de um portal em contêineres estruturados (ou null se a
 * IA não estiver configurada / texto vazio / falha).
 */
export async function organizeScrapedTracking(
  carrierName: string,
  reference: string,
  rawText: string,
): Promise<ContainerInfo[] | null> {
  if (!isAiConfigured() || !rawText || !rawText.trim()) return null;
  try {
    const out = await generateStructured(
      Schema,
      SYSTEM_PROMPT,
      `Armador: ${carrierName}\nReferência consultada: ${reference}\n\n` +
        `Texto da página de rastreio:\n${rawText.slice(0, 8000)}`,
    );
    return out.containers.map((c) => ({
      numero: c.numero,
      tipo: null,
      status: c.status,
      dischargeDate: null, // o texto cru raramente separa; fica p/ refinamento
      availableDate: null,
      gateOut: c.gateOut,
      emptyReturn: c.emptyReturn,
      lastFreeDay: c.lastFreeDay,
    }));
  } catch (err) {
    console.error('[trackingOrganizer] falha ao organizar via IA:', err);
    return null;
  }
}
