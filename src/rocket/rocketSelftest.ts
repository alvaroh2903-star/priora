import { rocketToDemurrage, RocketProcesso } from './rocketClient';

/**
 * Priora — Self-test do mapeamento Rocket → demurrage (offline).
 * Usa o exemplo de retorno real da API. Valida que a DESCARGA (início da
 * contagem), os BLs e os navios são extraídos corretamente.
 *   npm run rocket:selftest
 */

// Exemplo de retorno da API Rocket (fornecido pelo usuário).
const EXEMPLO: RocketProcesso = {
  idLogisticaHouse: 140,
  numeroProcesso: 'IM0154-24',
  numeroCourrier: '2953956224',
  dataEmbarque: '2024-12-19T00:00:00',
  origem: { id: 8926, name: 'QINGDAO', code: 'CNTAO', display: 'QINGDAO (CNTAO)' },
  destino: { id: 8366, name: 'ITAPOA', code: 'BRIOA', display: 'ITAPOA (BRIOA)' },
  dataPrevisaoEmbarque: '2024-12-19T00:00:00',
  dataPrevisaoDesembarque: '2025-02-11T00:00:00',
  dataDesembarque: '2025-02-11T00:00:00',
  blsHouse: 'NBFC2412067',
  blsHouseLista: ['NBFC2412067'],
  blMaster: '247707492',
  viagens: [
    {
      idLogisticaHouse: 0,
      viagemVoo: '450w',
      previsaoChegadaTransbordo: '2024-12-19T00:00:00',
      chegadaTransbordo: '2024-12-19T00:00:00',
      previsaoEmbarqueTransbordo: '2024-12-23T00:00:00',
      confirmacaoSaidaTransbordo: '2024-12-23T00:00:00',
      origem: { id: 8926, name: 'QINGDAO', code: 'CNTAO', display: 'QINGDAO (CNTAO)' },
      destino: { id: 8741, name: 'NINGBO', code: 'CNNGB', display: 'NINGBO (CNNGB)' },
      navio: 'MARSTAL MAERSK',
    },
    {
      idLogisticaHouse: 0,
      viagemVoo: '501W',
      previsaoChegadaTransbordo: '2025-01-06T00:00:00',
      chegadaTransbordo: '2025-01-06T00:00:00',
      previsaoEmbarqueTransbordo: '2025-02-11T00:00:00',
      confirmacaoSaidaTransbordo: '2025-02-11T00:00:00',
      origem: { id: 8741, name: 'NINGBO', code: 'CNNGB', display: 'NINGBO (CNNGB)' },
      destino: { id: 8366, name: 'ITAPOA', code: 'BRIOA', display: 'ITAPOA (BRIOA)' },
      navio: 'MAERSK LEBU',
    },
  ],
};

let fails = 0;
const ok = (label: string, cond: boolean, got?: unknown) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : ` -> ${JSON.stringify(got)}`));
  if (!cond) fails++;
};

const d = rocketToDemurrage(EXEMPLO);
console.log('[rocket] reduzido:', JSON.stringify(d));

ok('processo', d.numeroProcesso === 'IM0154-24');
ok('BL House', d.blHouse === 'NBFC2412067', d.blHouse);
ok('BL Master', d.blMaster === '247707492', d.blMaster);
ok('descarga (início da contagem) = 2025-02-11', d.dataDesembarque === '2025-02-11', d.dataDesembarque);
ok('inicioContagem = descarga', d.inicioContagem === '2025-02-11', d.inicioContagem);
ok('origem/destino', d.origem === 'QINGDAO (CNTAO)' && d.destino === 'ITAPOA (BRIOA)');
ok('navios (2, dedup)', d.navios.length === 2 && d.navios.includes('MAERSK LEBU'), d.navios);

// Caso: ainda não desembarcou → usa a previsão como início.
const semDescarga = rocketToDemurrage({ ...EXEMPLO, dataDesembarque: null });
ok('sem descarga → usa previsão', semDescarga.inicioContagem === '2025-02-11', semDescarga.inicioContagem);

console.log(fails === 0 ? '\n[rocket] ✅ mapeamento Rocket → demurrage OK' : `\n[rocket] ❌ ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
