/**
 * Datas dos portos → ISO no horário de Brasília (os portos publicam hora local,
 * sem fuso; o Brasil não tem horário de verão desde 2019, então é sempre -03:00).
 *
 * Aceita: "2026-09-15 05:30:00" (Itapoá), "15/09/26 05:30" (Rio Brasil),
 * "15/09/2026 05:30" (APPA) e as mesmas sem hora. Vazio/inválido → null.
 */
const OFFSET = '-03:00';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function build(y: number, mo: number, d: number, h?: number, mi?: number, s?: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (h === undefined || Number.isNaN(h)) return date;
  if (h > 23 || (mi ?? 0) > 59 || (s ?? 0) > 59) return null;
  return `${date}T${pad(h)}:${pad(mi ?? 0)}:${pad(s ?? 0)}${OFFSET}`;
}

/**
 * Instante UTC (epoch ms) → ISO no horário de Brasília. É o "/Date(ms)/" do
 * .NET (Santos Brasil, BTP): o valor é UTC de verdade — as próprias páginas o
 * convertem para a hora local do navegador (conferido em 17/10: "Chegada"
 * /Date/ da BTP bate com a "PrevisaoChegada" em texto, hora local).
 */
export function epochMsToIsoBrt(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms - 3 * 3_600_000); // UTC → -03:00
  return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

export function toIsoBrt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  // "/Date(1791812160000)/" (.NET)
  const dn = t.match(/^\/?Date\((-?\d+)(?:[+-]\d{4})?\)\/?$/);
  if (dn) return epochMsToIsoBrt(+dn[1]);
  // 2026-09-15[ T]05:30[:00]
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return build(+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : undefined, m[5] !== undefined ? +m[5] : undefined, m[6] !== undefined ? +m[6] : undefined);
  // 15/09/2026 05:30 ou 15/09/26 05:30
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return build(y, +m[2], +m[1], m[4] !== undefined ? +m[4] : undefined, m[5] !== undefined ? +m[5] : undefined, m[6] !== undefined ? +m[6] : undefined);
  }
  return null;
}
