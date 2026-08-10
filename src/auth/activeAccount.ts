import fs from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * Fonte ÚNICA da verdade da conta Microsoft ATUALMENTE conectada (MVP).
 *
 * Enquanto não há Supabase / persistência por usuário, a Priora trabalha com UMA
 * conexão Microsoft por vez. Este módulo guarda qual é essa conta (em memória +
 * disco, para sobreviver ao "sleep"/redeploy da instância gratuita do Render).
 *
 * Seam para o futuro: quando entrar o Supabase, "conta ativa" deixa de ser
 * global e passa a ser "a conexão Microsoft do usuário Priora X". O resto do
 * backend só pergunta `getActiveAccount()` — não muda quando a fonte mudar.
 */
export interface ActiveAccount {
  /** homeAccountId do MSAL — chave para renovar tokens silenciosamente. */
  homeAccountId: string;
  /** E-mail/UPN da conta, para exibição. */
  username: string;
  /** Quando esta conexão foi estabelecida (ISO). */
  connectedAt: string;
}

const ACTIVE_PATH = path.join(config.dataDir, 'active-account.json');

// undefined = ainda não lido do disco; null = lido e não há conta ativa.
let cache: ActiveAccount | null | undefined;

function read(): ActiveAccount | null {
  if (cache !== undefined) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(ACTIVE_PATH, 'utf8')) as ActiveAccount;
  } catch {
    cache = null;
  }
  return cache;
}

/** Conta Microsoft conectada agora (ou null se nenhuma). */
export function getActiveAccount(): ActiveAccount | null {
  return read();
}

/** Define a conta Microsoft conectada (substitui a anterior). */
export function setActiveAccount(
  homeAccountId: string,
  username: string,
): ActiveAccount {
  const active: ActiveAccount = {
    homeAccountId,
    username,
    connectedAt: new Date().toISOString(),
  };
  cache = active;
  try {
    fs.mkdirSync(path.dirname(ACTIVE_PATH), { recursive: true });
    fs.writeFileSync(ACTIVE_PATH, JSON.stringify(active, null, 2));
  } catch (err) {
    console.error('[activeAccount] falha ao gravar conta ativa:', err);
  }
  return active;
}

/** Zera a conta ativa (desconexão total). */
export function clearActiveAccount(): void {
  cache = null;
  try {
    fs.rmSync(ACTIVE_PATH, { force: true });
  } catch (err) {
    console.error('[activeAccount] falha ao limpar conta ativa:', err);
  }
}
