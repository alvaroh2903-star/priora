import { calcContainer } from '../routes/demurrageRoutes';
import { DemurrageContainer } from './demurrageParser';

/**
 * Priora — Self-test OFFLINE da reconciliação portal × e-mail no cálculo.
 * Garante que o início da contagem segue a prioridade DESCARGA > DISPONIBILIDADE >
 * RETIRADA e que as datas do portal (não descartadas) entram na conta.
 *
 *   npm run reconciliation:selftest
 */

function ct(part: Partial<DemurrageContainer>): DemurrageContainer {
  return {
    numero: 'TRHU1477661',
    dataRetirada: null,
    freeTimeDias: null,
    diaria: null,
    moeda: null,
    dataDevolucao: null,
    minutaRecebida: null,
    ...part,
  };
}

const HOJE = Date.parse('2026-09-12');
let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] início da contagem — prioridade descarga > disponib. > retirada');
  const c1 = calcContainer(
    ct({ dischargeDate: '2026-08-26', availableDate: '2026-08-28', dataRetirada: '2026-08-27', freeTimeDias: 7 }),
    HOJE,
  );
  check('início = descarga (2026-08-26)', c1.inicioContagem === '2026-08-26', c1.inicioContagem);
  check('deadline = descarga + 7 (2026-09-02)', c1.deadline === '2026-09-02', c1.deadline);

  const c2 = calcContainer(ct({ availableDate: '2026-08-28', dataRetirada: '2026-08-27', freeTimeDias: 7 }), HOJE);
  check('sem descarga → disponibilidade (2026-08-28)', c2.inicioContagem === '2026-08-28', c2.inicioContagem);

  const c3 = calcContainer(ct({ dataRetirada: '2026-08-27', freeTimeDias: 7 }), HOJE);
  check('sem descarga/disponib. → retirada (2026-08-27)', c3.inicioContagem === '2026-08-27', c3.inicioContagem);

  console.log('[selftest] cálculo do demurrage (exemplo Maersk real)');
  // Maersk TRHU1477661: descarga 26/08, devolução 09/09, free time 7, diária 100.
  const m = calcContainer(
    ct({ dischargeDate: '2026-08-26', dataDevolucao: '2026-09-09', freeTimeDias: 7, diaria: 100 }),
    HOJE,
  );
  // deadline = 26/08 + 7 = 02/09; devolução 09/09 → 7 dias de demurrage; 7*100 = 700.
  check('deadline 2026-09-02', m.deadline === '2026-09-02', m.deadline);
  check('demurrageDias = 7 (02/09 → 09/09)', m.demurrageDias === 7, m.demurrageDias);
  check('valor = 700 (7 * 100)', m.valor === 700, m.valor);
  check('status pendência/encerrado (devolvido)', m.status === 'pendencia' || m.status === 'encerrado', m.status);

  console.log('[selftest] sem free time → indefinido, sem inventar');
  const semFt = calcContainer(ct({ dischargeDate: '2026-08-26' }), HOJE);
  check('deadline null (sem free time)', semFt.deadline === null, semFt.deadline);
  check('status indefinido', semFt.status === 'indefinido', semFt.status);
  check('início ainda exposto (2026-08-26)', semFt.inicioContagem === '2026-08-26', semFt.inicioContagem);

  if (failures === 0) console.log('\n[selftest] ✅ reconciliação portal × e-mail: lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
