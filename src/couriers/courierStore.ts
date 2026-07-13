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
