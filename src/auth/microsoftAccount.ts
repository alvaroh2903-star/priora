import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { clearAccountsExcept } from './msalClient';
import * as demurrageStore from '../demurrage/demurrageStore';
import * as demurrageBotStore from '../demurrage/demurrageBotStore';
import * as courierStore from '../couriers/courierStore';

/**
 * Priora — Contexto da conta Microsoft ATIVA (MVP, sem Supabase ainda).
 * ------------------------------------------------------------------------
 * Enquanto não há persistência por usuário (Supabase), a Priora trabalha com
 * UMA conta Microsoft por vez, GLOBAL ao processo. Regra do MVP:
 *
 *   Conectar conta A  → ambiente da A
 *   Conectar conta B  → RESET completo da A (tokens + dados) → ambiente da B
 *
 * Este módulo é o ponto único de verdade da "conta conectada" e concentra o
 * RESET. Quando o Supabase entrar, troca-se este comportamento global por um
 * contexto isolado por conta Priora — sem espalhar a regra pelo resto do código.
 *
 * Nada de dados de negócio da Microsoft é persistido permanentemente: os e-mails
 * são buscados ao vivo. O que fica em disco é só o token da conta ATUAL (para o
 * login sobreviver ao "sleep" do Render) e ações do operador — tudo apagado na
 * troca de conta.
 */

export interface ActiveAccount {
  homeAccountId: string;
  username: string;
  connectedAt: string;
}

const ACCOUNT_PATH = path.join(config.dataDir, 'microsoft-account.json');

// undefined = ainda não carregado do disco; null = sem conta conectada.
let active: ActiveAccount | null | undefined = undefined;

function load(): ActiveAccount | null {
  if (active !== undefined) return active;
  try {
    active = JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
  } catch {
    active = null;
  }
  return active!;
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_PATH), { recursive: true });
    if (active) {
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(active, null, 2));
    } else {
      fs.rmSync(ACCOUNT_PATH, { force: true });
    }
  } catch (err) {
    console.error('[microsoftAccount] falha ao persistir conta ativa:', err);
  }
}

/** Conta Microsoft atualmente conectada (ou null). */
export function getActiveAccount(): ActiveAccount | null {
  return load();
}

/** homeAccountId da conta ativa (ou null) — usado pelo requireAuth. */
export function getActiveHomeAccountId(): string | null {
  return load()?.homeAccountId ?? null;
}

/**
 * Apaga TODOS os dados derivados da conta Microsoft (couriers + demurrage + bot).
 * Ponto único: qualquer novo store que guarde dado da conta entra aqui.
 */
function clearDerivedData(): void {
  demurrageStore.clearAll();
  demurrageBotStore.clearAll();
  courierStore.clearAll();
}

/**
 * Conecta uma conta Microsoft. Se for DIFERENTE da conta ativa anterior (ou se
 * havia tokens de outra conta no cache), executa um RESET completo: remove os
 * tokens das outras contas do MSAL e apaga todos os dados derivados. Garante um
 * ambiente de uma conta só. Retorna se houve troca.
 */
export async function connectMicrosoftAccount(
  homeAccountId: string,
  username: string,
): Promise<{ switched: boolean }> {
  const prev = getActiveAccount();
  // Remove do MSAL qualquer conta que não seja a nova (defensivo + troca).
  const removedOthers = await clearAccountsExcept(homeAccountId);
  const switched =
    (!!prev && prev.homeAccountId !== homeAccountId) ||
    (!prev && removedOthers > 0);

  if (switched) {
    // Troca de conta: nada da conta anterior pode sobreviver.
    clearDerivedData();
    console.log(
      `[microsoftAccount] troca de conta detectada → reset completo (nova: ${username}).`,
    );
  }

  active = { homeAccountId, username, connectedAt: new Date().toISOString() };
  persist();
  return { switched };
}

/**
 * Desconecta a conta atual: remove TODOS os tokens do MSAL, apaga os dados
 * derivados e limpa a conta ativa. Reset total da conexão Microsoft.
 */
export async function disconnectMicrosoftAccount(): Promise<void> {
  await clearAccountsExcept(); // remove todas as contas do cache
  clearDerivedData();
  active = null;
  persist();
}
