import fs from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * Persistência dos estados de Courier confirmados pelo OPERADOR.
 *
 * Regra do domínio (Manual do Courier): o Outlook nunca confirma recebimento
 * físico nem conferência. Esses estados só existem por ação humana. Aqui
 * guardamos exatamente essa camada — separada das conclusões da Clara (que vêm
 * do Outlook) — para manter a rastreabilidade de "de onde veio a informação".
 *
 * Estados oficiais: Identificado (padrão, inferido pela Clara) → Recebido →
 * Em Conferência → Divergência → Concluído.
 */
export type CourierEstado =
  | 'Identificado'
  | 'Recebido'
  | 'Em Conferência'
  | 'Divergência'
  | 'Concluído';

export const ESTADOS_VALIDOS: CourierEstado[] = [
  'Identificado',
  'Recebido',
  'Em Conferência',
  'Divergência',
  'Concluído',
];

export interface CourierEstadoRegistro {
  estado: CourierEstado;
  /** Observação livre do operador (ex.: divergência encontrada). */
  nota?: string;
  updatedAt: string;
}

const STORE_PATH = path.join(config.dataDir, 'courier-estados.json');

let cache: Record<string, CourierEstadoRegistro> | null = null;

function load(): Record<string, CourierEstadoRegistro> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache || {}, null, 2));
  } catch (err) {
    console.error('[courierStore] falha ao gravar estados:', err);
  }
}

/** Normaliza o tracking para servir de chave estável (só alfanumérico, maiúsculo). */
export function trackingKey(tracking: string): string {
  return String(tracking || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Estado atual confirmado pelo operador (ou "Identificado" se nunca tocado). */
export function getEstado(tracking: string): CourierEstadoRegistro {
  const store = load();
  return (
    store[trackingKey(tracking)] || {
      estado: 'Identificado',
      updatedAt: '',
    }
  );
}

/** Todos os estados confirmados (para mesclar na lista de couriers). */
export function getAllEstados(): Record<string, CourierEstadoRegistro> {
  return { ...load() };
}

/** Registra um novo estado (ação do operador). */
export function setEstado(
  tracking: string,
  estado: CourierEstado,
  nota?: string,
): CourierEstadoRegistro {
  const store = load();
  const registro: CourierEstadoRegistro = {
    estado,
    nota: nota?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  store[trackingKey(tracking)] = registro;
  persist();
  return registro;
}

/* ------------------------------------------------------------------ *
 * Conferência documental (Etapa 7 do Manual): o operador marca, por
 * processo, se cada documento esperado chegou. Também é ação humana —
 * persistida separadamente das conclusões da Clara.
 * ------------------------------------------------------------------ */

/** Documentos conferíveis no card (os dois que definem a liberação). */
export type DocKey = 'mbl' | 'hbl';
export type DocStatus = 'recebido' | 'nao_recebido';
/** Conferência de um processo: status por documento. */
export type ProcConferencia = Partial<Record<DocKey, DocStatus>>;
/** Conferência de um courier: por código de processo (IMxxxx). */
export type CourierConferencia = Record<string, ProcConferencia>;

const CONF_PATH = path.join(config.dataDir, 'courier-conferencia.json');

let confCache: Record<string, CourierConferencia> | null = null;

function loadConf(): Record<string, CourierConferencia> {
  if (confCache) return confCache;
  try {
    confCache = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  } catch {
    confCache = {};
  }
  return confCache!;
}

function persistConf(): void {
  try {
    fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
    fs.writeFileSync(CONF_PATH, JSON.stringify(confCache || {}, null, 2));
  } catch (err) {
    console.error('[courierStore] falha ao gravar conferência:', err);
  }
}

/** Conferência atual de um courier (por processo). */
export function getConferencia(tracking: string): CourierConferencia {
  return loadConf()[trackingKey(tracking)] || {};
}

/** Todas as conferências (para mesclar na lista). */
export function getAllConferencias(): Record<string, CourierConferencia> {
  return { ...loadConf() };
}

/** Marca (ou desmarca, com status null) um documento de um processo. */
export function setConferenciaDoc(
  tracking: string,
  processo: string,
  documento: DocKey,
  status: DocStatus | null,
): CourierConferencia {
  const store = loadConf();
  const key = trackingKey(tracking);
  const proc = processo.toUpperCase();
  if (!store[key]) store[key] = {};
  if (!store[key][proc]) store[key][proc] = {};
  if (status === null) {
    delete store[key][proc][documento];
  } else {
    store[key][proc][documento] = status;
  }
  persistConf();
  return store[key];
}

/* ------------------------------------------------------------------ *
 * Follow-up de divergência: registro de que o analista JÁ cobrou o agente
 * sobre um documento esperado e não recebido. NÃO resolve a divergência —
 * o documento continua pendente; apenas evita cobrança em duplicidade.
 * (Futuro: será substituído pela detecção automática da resposta na thread.)
 * ------------------------------------------------------------------ */

export interface FollowUpRegistro {
  /** Como foi registrado: rascunho criado no Outlook ou marcado manualmente. */
  via: 'draft' | 'manual';
  at: string;
}
/** Follow-ups de um courier: por processo -> documento. */
export type CourierFollowUps = Record<string, Partial<Record<DocKey, FollowUpRegistro>>>;

const FUP_PATH = path.join(config.dataDir, 'courier-followups.json');

let fupCache: Record<string, CourierFollowUps> | null = null;

function loadFup(): Record<string, CourierFollowUps> {
  if (fupCache) return fupCache;
  try {
    fupCache = JSON.parse(fs.readFileSync(FUP_PATH, 'utf8'));
  } catch {
    fupCache = {};
  }
  return fupCache!;
}

function persistFup(): void {
  try {
    fs.mkdirSync(path.dirname(FUP_PATH), { recursive: true });
    fs.writeFileSync(FUP_PATH, JSON.stringify(fupCache || {}, null, 2));
  } catch (err) {
    console.error('[courierStore] falha ao gravar follow-ups:', err);
  }
}

/** Todos os follow-ups (para mesclar na lista de couriers). */
export function getAllFollowUps(): Record<string, CourierFollowUps> {
  return { ...loadFup() };
}

/** Registra o follow-up de um documento (ou remove, com via null). */
export function setFollowUp(
  tracking: string,
  processo: string,
  documento: DocKey,
  via: FollowUpRegistro['via'] | null,
): CourierFollowUps {
  const store = loadFup();
  const key = trackingKey(tracking);
  const proc = processo.toUpperCase();
  if (!store[key]) store[key] = {};
  if (!store[key][proc]) store[key][proc] = {};
  if (via === null) {
    delete store[key][proc][documento];
  } else {
    store[key][proc][documento] = { via, at: new Date().toISOString() };
  }
  persistFup();
  return store[key];
}

/* ------------------------------------------------------------------ *
 * Reset da conta Microsoft (MVP)
 * ------------------------------------------------------------------ */

/**
 * Apaga TODOS os estados/conferências/follow-ups de courier — memória E disco.
 *
 * Estes dados são derivados dos e-mails (trackings/processos) da conta Microsoft
 * conectada. Ao trocar de conta, precisam sumir por completo para não vazar nem
 * se misturar com a nova conta. Chamado pelo "reset" da conexão Microsoft
 * (ver src/auth/microsoftConnection.ts).
 */
export function resetCourierStore(): void {
  cache = {};
  confCache = {};
  fupCache = {};
  for (const p of [STORE_PATH, CONF_PATH, FUP_PATH]) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.error('[courierStore] falha ao limpar', p, err);
    }
  }
}
