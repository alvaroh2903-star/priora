import fs from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * Priora — Módulo Demurrage
 * Persistência da camada de AÇÃO DO OPERADOR (separada dos dados extraídos do
 * Outlook pela Clara). Duas coisas ficam aqui:
 *
 * 1. "Minuta solicitada": quando o operador aciona "Solicitar Minuta" num
 *    processo, registramos o fato (rascunho criado / manual) para não cobrar em
 *    duplicidade e refletir na UI. Isto é ESTADO DE FLUXO, não um dado do
 *    negócio — os números (free time, diária, datas) continuam vindo do e-mail.
 *
 * 2. Log de atividades recentes: alimenta o painel "Atividades recentes". As
 *    ações do operador entram aqui; eventos derivados do e-mail (container
 *    devolvido, demurrage iniciado) são calculados na rota e mesclados na
 *    exibição.
 */

/** Normaliza a chave do processo (só alfanumérico, maiúsculo). */
export function procKey(processo: string): string {
  return String(processo || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Minuta solicitada
 * ------------------------------------------------------------------ */

export interface MinutaRegistro {
  /** Como foi registrada: rascunho no Outlook ou ação manual do operador. */
  via: 'draft' | 'manual';
  at: string;
}

const MINUTA_PATH = path.join(config.dataDir, 'demurrage-minutas.json');

let minutaCache: Record<string, MinutaRegistro> | null = null;

function loadMinutas(): Record<string, MinutaRegistro> {
  if (minutaCache) return minutaCache;
  try {
    minutaCache = JSON.parse(fs.readFileSync(MINUTA_PATH, 'utf8'));
  } catch {
    minutaCache = {};
  }
  return minutaCache!;
}

function persistMinutas(): void {
  try {
    fs.mkdirSync(path.dirname(MINUTA_PATH), { recursive: true });
    fs.writeFileSync(MINUTA_PATH, JSON.stringify(minutaCache || {}, null, 2));
  } catch (err) {
    console.error('[demurrageStore] falha ao gravar minutas:', err);
  }
}

/** Todas as solicitações de minuta (para mesclar na lista). */
export function getAllMinutas(): Record<string, MinutaRegistro> {
  return { ...loadMinutas() };
}

/** Registra (ou remove, com via null) a solicitação de minuta de um processo. */
export function setMinutaSolicitada(
  processo: string,
  via: MinutaRegistro['via'] | null,
): Record<string, MinutaRegistro> {
  const store = loadMinutas();
  const key = procKey(processo);
  if (via === null) {
    delete store[key];
  } else {
    store[key] = { via, at: new Date().toISOString() };
  }
  persistMinutas();
  return { ...store };
}

/* ------------------------------------------------------------------ *
 * Log de atividades
 * ------------------------------------------------------------------ */

export type AtividadeTipo =
  | 'minuta_solicitada'
  | 'minuta_recebida'
  | 'container_devolvido'
  | 'demurrage_iniciado';

export interface AtividadeRegistro {
  tipo: AtividadeTipo;
  /** Título curto (ex.: "Minuta solicitada"). */
  label: string;
  /** Subtítulo (ex.: "IM2550 — JBS" ou o nº do container). */
  sub: string;
  at: string;
}

const ATIV_PATH = path.join(config.dataDir, 'demurrage-atividades.json');
const ATIV_MAX = 50;

let ativCache: AtividadeRegistro[] | null = null;

function loadAtividades(): AtividadeRegistro[] {
  if (ativCache) return ativCache;
  try {
    const raw = JSON.parse(fs.readFileSync(ATIV_PATH, 'utf8'));
    ativCache = Array.isArray(raw) ? raw : [];
  } catch {
    ativCache = [];
  }
  return ativCache!;
}

function persistAtividades(): void {
  try {
    fs.mkdirSync(path.dirname(ATIV_PATH), { recursive: true });
    fs.writeFileSync(ATIV_PATH, JSON.stringify(ativCache || [], null, 2));
  } catch (err) {
    console.error('[demurrageStore] falha ao gravar atividades:', err);
  }
}

/** Registra uma atividade do operador no topo do feed (mantém as últimas ATIV_MAX). */
export function logAtividade(
  tipo: AtividadeTipo,
  label: string,
  sub: string,
): AtividadeRegistro {
  const store = loadAtividades();
  const registro: AtividadeRegistro = {
    tipo,
    label,
    sub,
    at: new Date().toISOString(),
  };
  store.unshift(registro);
  if (store.length > ATIV_MAX) store.length = ATIV_MAX;
  persistAtividades();
  return registro;
}

/** Atividades registradas pelo operador (mais recentes primeiro). */
export function getAtividades(): AtividadeRegistro[] {
  return [...loadAtividades()];
}

/* ------------------------------------------------------------------ *
 * Reset da conta Microsoft (MVP)
 * ------------------------------------------------------------------ */

/**
 * Apaga minutas solicitadas e o log de atividades — memória E disco. Derivados
 * dos processos da conta Microsoft conectada; some tudo ao trocar de conta para
 * não vazar/misturar com a nova. Chamado pelo "reset" da conexão Microsoft
 * (ver src/auth/microsoftConnection.ts).
 */
export function resetDemurrageStore(): void {
  minutaCache = {};
  ativCache = [];
  for (const p of [MINUTA_PATH, ATIV_PATH]) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.error('[demurrageStore] falha ao limpar', p, err);
    }
  }
}
