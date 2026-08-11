import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Priora — Self-test do reset de troca de conta Microsoft (MVP).
 * Valida os critérios de aceitação SEM precisar da Microsoft:
 *   A conectada → dados de A presentes
 *   A re-login  → dados de A preservados
 *   B conectada → dados de A APAGADOS, conta ativa vira B
 *   logout      → tudo apagado, sem conta ativa
 *
 *   npm run auth:selftest
 *
 * Usa um DATA_DIR temporário; por isso os módulos que leem config.dataDir são
 * carregados via require() DEPOIS de definir a env (imports estáticos leriam
 * o dataDir padrão cedo demais).
 */
process.env.DATA_DIR = path.join(os.tmpdir(), `priora-auth-selftest-${Date.now()}`);

/* eslint-disable @typescript-eslint/no-var-requires */
const demurrageStore = require('../demurrage/demurrageStore');
const demurrageBotStore = require('../demurrage/demurrageBotStore');
const courierStore = require('../couriers/courierStore');
const {
  connectMicrosoftAccount,
  disconnectMicrosoftAccount,
  getActiveAccount,
} = require('./microsoftAccount');
/* eslint-enable @typescript-eslint/no-var-requires */

let fails = 0;
const ok = (label: string, cond: boolean, got?: unknown) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : ` -> ${JSON.stringify(got)}`));
  if (!cond) fails++;
};

function seed(): void {
  demurrageStore.setMinutaSolicitada('IM1234', 'manual');
  demurrageStore.logAtividade('minuta_solicitada', 'Minuta', 'IM1234');
  demurrageBotStore.saveBotResult('HLCUSHA2606GIPM7', {
    carrierId: 'hapag',
    reference: 'HLCUSHA2606GIPM7',
    containers: [],
    events: [],
  });
  courierStore.setEstado('TRACK123', 'Recebido');
}

function counts() {
  return {
    minutas: Object.keys(demurrageStore.getAllMinutas()).length,
    ativ: demurrageStore.getAtividades().length,
    bot: Object.keys(demurrageBotStore.getAllBotResults()).length,
    courier: Object.keys(courierStore.getAllEstados()).length,
  };
}

async function main(): Promise<void> {
  // 1) Conecta A e semeia dados
  await connectMicrosoftAccount('HOME-A', 'contaA@microsoft.com');
  seed();
  let c = counts();
  ok('A: dados presentes', c.minutas > 0 && c.ativ > 0 && c.bot > 0 && c.courier > 0, c);
  ok('A: conta ativa = A', getActiveAccount()?.homeAccountId === 'HOME-A');

  // 2) Re-login com a MESMA conta A → dados preservados
  await connectMicrosoftAccount('HOME-A', 'contaA@microsoft.com');
  c = counts();
  ok('A re-login: dados preservados', c.minutas > 0 && c.courier > 0, c);

  // 3) Conecta B (troca) → RESET completo da A
  await connectMicrosoftAccount('HOME-B', 'contaB@microsoft.com');
  c = counts();
  ok('B: dados da A apagados', c.minutas === 0 && c.ativ === 0 && c.bot === 0 && c.courier === 0, c);
  ok('B: conta ativa = B', getActiveAccount()?.homeAccountId === 'HOME-B');

  // 4) Semeia B e desconecta → tudo limpo + sem conta ativa
  seed();
  await disconnectMicrosoftAccount();
  c = counts();
  ok('logout: dados apagados', c.minutas === 0 && c.bot === 0 && c.courier === 0, c);
  ok('logout: sem conta ativa', getActiveAccount() === null);

  try {
    fs.rmSync(process.env.DATA_DIR as string, { recursive: true, force: true });
  } catch {
    /* ok */
  }

  console.log(
    fails === 0
      ? '\n[auth] ✅ reset de troca de conta Microsoft OK'
      : `\n[auth] ❌ ${fails} verificação(ões) falharam`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main();
