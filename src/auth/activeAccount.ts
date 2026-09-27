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

/**
 * Persistência DURÁVEL (PostgreSQL) da conta ativa. Configurada na inicialização
 * (`configurarContaAtivaDuravel`); a partir daí o banco é a fonte de verdade e o
 * arquivo legado deixa de ser escrito. `getActiveAccount()` continua síncrono:
 * lê a cópia em memória carregada do banco.
 */
export interface StoreContaAtiva {
  carregar(): Promise<{ existe: boolean; conta: ActiveAccount | null }>;
  salvar(conta: ActiveAccount | null, opts?: { importadaDeArquivo?: boolean }): Promise<void>;
}

let storeDuravel: StoreContaAtiva | null = null;

/** Liga a persistência durável e importa UMA vez a conta do arquivo legado, se o banco ainda não tiver. */
export async function configurarContaAtivaDuravel(store: StoreContaAtiva, arquivoLegado: string = ACTIVE_PATH): Promise<void> {
  let { existe, conta } = await store.carregar();
  if (!existe && fs.existsSync(arquivoLegado)) {
    try {
      const doArquivo = JSON.parse(fs.readFileSync(arquivoLegado, 'utf8')) as ActiveAccount;
      if (doArquivo?.homeAccountId && doArquivo?.username) {
        await store.salvar(doArquivo, { importadaDeArquivo: true });
        const confirmado = await store.carregar();
        // Só tira o arquivo de uso depois de CONFIRMAR a gravação no banco.
        if (confirmado.conta?.homeAccountId === doArquivo.homeAccountId) {
          fs.renameSync(arquivoLegado, `${arquivoLegado}.importado-${Date.now()}`);
        }
        conta = confirmado.conta;
      }
    } catch (err) {
      console.error('[activeAccount] conta legada não importada:', (err as Error).message);
    }
  }
  storeDuravel = store;
  cache = conta;
}

/** A conta ativa está em armazenamento durável? */
export function contaAtivaDuravel(): boolean {
  return storeDuravel !== null;
}

/** Grava no banco a conta ativa atual (após set/clear). No-op sem persistência durável. */
export async function persistirContaAtiva(): Promise<void> {
  if (storeDuravel) await storeDuravel.salvar(read());
}

/** Relê a conta ativa do banco (outra instância pode tê-la trocado). */
export async function recarregarContaAtiva(): Promise<ActiveAccount | null> {
  if (storeDuravel) cache = (await storeDuravel.carregar()).conta;
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
  if (storeDuravel) return active; // o banco é a fonte de verdade (persistirContaAtiva)
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
  if (storeDuravel) return;
  try {
    fs.rmSync(ACTIVE_PATH, { force: true });
  } catch (err) {
    console.error('[activeAccount] falha ao limpar conta ativa:', err);
  }
}
