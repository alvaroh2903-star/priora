/**
 * Priora — Detecção de MANUTENÇÃO do portal do armador.
 *
 * Visto ao vivo (Hapag-Lloyd, 10/10/2026): o rastreio redirecionava para uma
 * página sem dados e parecia "site mudou" / "página vazia" — era manutenção
 * programada: "En raison d'une courte maintenance, nos services Online Business
 * ne sont pas disponibles pour le moment. Ils devraient être disponibles à 21:30
 * UTC (2026-10-10)." (em francês porque o IP residencial era da França).
 *
 * Manutenção não é defeito do scraper nem do número do BL: não vale gastar outra
 * sessão no mesmo minuto nem chamar a IA — o próximo ciclo tenta de novo, e o
 * histórico já salvo continua valendo.
 */

export interface PortalMaintenance {
  /** Volta prevista, como o portal informou (ex.: "21:30 UTC (2026-10-10)"), ou null. */
  until: string | null;
}

// "manutenção" nos idiomas que os portais servem conforme o país do IP.
const MAINT_RE = /maint[ea]n[ae]nce|manuten[cç][aã]o|mantenimiento|manutenzione|wartung|维护|メンテナンス/i;
// …perto de "indisponível" — sozinha, a palavra aparece em menus ("Container
// maintenance & repair") sem ser aviso de nada.
const UNAVAILABLE_RE =
  /not (?:be )?available|unavailable|indispon[ií]ve|pas disponibles?|no (?:est[aá]n? )?disponibles?|non (?:sono )?disponibil|nicht verf[uü]gbar|暂停|不可用/i;
const NEAR = 250;

/** O texto da página é um aviso de manutenção? Devolve a volta prevista, se houver. */
export function detectMaintenance(text: string): PortalMaintenance | null {
  const t = (text || '').replace(/\s+/g, ' ');
  const re = new RegExp(MAINT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const win = t.slice(Math.max(0, m.index - NEAR), m.index + NEAR);
    if (!UNAVAILABLE_RE.test(win)) continue;
    // Horário de volta: "21:30 UTC (2026-10-10)" / "21:30 UTC" / "2026-10-10 21:30".
    const after = t.slice(m.index, m.index + 400);
    const until =
      after.match(/\b\d{1,2}:\d{2}\s*(?:UTC|GMT|CET|CEST)(?:\s*\(\d{4}-\d{2}-\d{2}\))?/i)?.[0] ||
      after.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\b/)?.[0] ||
      null;
    return { until };
  }
  return null;
}

/** Mensagem padrão (pt-BR) para o operador. */
export function maintenanceMessage(m: PortalMaintenance): string {
  return (
    `Portal do armador em MANUTENÇÃO${m.until ? ` (volta prevista: ${m.until})` : ''} — ` +
    'não é erro do scraper nem do número; o próximo ciclo tenta de novo e o histórico salvo continua valendo.'
  );
}
