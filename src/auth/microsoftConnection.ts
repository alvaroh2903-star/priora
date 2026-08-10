import { purgeMsalAccounts } from './msalClient';
import {
  getActiveAccount,
  setActiveAccount,
  clearActiveAccount,
  ActiveAccount,
} from './activeAccount';
import { resetCourierStore } from '../couriers/courierStore';
import { resetDemurrageStore } from '../demurrage/demurrageStore';

/**
 * Gestão da CONEXÃO Microsoft do MVP — a regra de negócio "uma conta por vez,
 * troca = reset completo" concentrada num único lugar.
 *
 * MVP (hoje): não há Supabase nem persistência por usuário. A Priora mantém UMA
 * conexão Microsoft por vez; conectar outra conta apaga por completo a anterior
 * (tokens + todos os dados derivados dela). Nada vaza nem se mistura entre
 * contas.
 *
 * Futuro (Supabase): a mesma API pública (`connectMicrosoftAccount` /
 * `disconnectMicrosoftAccount`) passa a operar sobre a conexão ISOLADA de cada
 * usuário Priora — os tokens/dados deixam de ser globais e viram por-usuário,
 * criptografados. O restante do backend não muda: continua conectando/
 * desconectando pela mesma porta. Para estender o reset a novas camadas de dados
 * derivados da conta, registre a limpeza em `wipeConnectionData`.
 */

/**
 * Limpa os tokens (todos, exceto `keepHomeAccountId`) e TODOS os dados derivados
 * da conta anterior. Não mexe na "conta ativa" nem na sessão do Express — isso é
 * responsabilidade dos pontos de entrada abaixo.
 */
async function wipeConnectionData(
  keepHomeAccountId: string | null,
): Promise<void> {
  await purgeMsalAccounts(keepHomeAccountId);
  resetCourierStore();
  resetDemurrageStore();
}

/**
 * Conecta (ou TROCA para) uma conta Microsoft recém-autenticada.
 *
 * Se for uma conta DIFERENTE da atual, faz o reset COMPLETO da anterior (tokens
 * + dados derivados) antes de ativar a nova — mantendo apenas os tokens
 * recém-emitidos desta conta. Reautenticar a MESMA conta preserva os dados dela.
 */
export async function connectMicrosoftAccount(
  homeAccountId: string,
  username: string,
): Promise<ActiveAccount> {
  const previous = getActiveAccount();
  const trocouDeConta =
    !previous || previous.homeAccountId !== homeAccountId;
  if (trocouDeConta) {
    // Mantém só os tokens da nova conta; apaga o resto (tokens antigos + dados).
    await wipeConnectionData(homeAccountId);
  }
  return setActiveAccount(homeAccountId, username);
}

/**
 * Desconecta a conta Microsoft atual: reset COMPLETO (remove TODOS os tokens e
 * dados derivados) e zera a conta ativa. A sessão do Express é destruída por
 * quem chama (rota de logout).
 */
export async function disconnectMicrosoftAccount(): Promise<void> {
  await wipeConnectionData(null);
  clearActiveAccount();
}
