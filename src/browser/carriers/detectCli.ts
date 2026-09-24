import { detect } from './index';

/**
 * Priora — CLI/teste de detecção de armador (sem rede).
 *   npm run carriers:detect                      # roda a amostra de verificação
 *   npm run carriers:detect -- MSCU1234567 ...    # detecta as referências dadas
 */

// Amostra de verificação: contêineres reais (com check digit válido) por armador.
const SAMPLES = [
  'MSKU0439695', // Maersk
  'MSCU5087560', // MSC
  'ONEU1234563', // ONE (owner ONEU)
  'OOLU1417851', // OOCL
  'CMAU1234563', // CMA CGM
  'HLXU1234561', // Hapag-Lloyd
  'YMLU1234560', // Yang Ming
  'HDMU1234566', // HMM
  'ZIMU1234564', // ZIM
  'EGHU1234565', // Evergreen
  'COSU1234565', // COSCO (SCAC/owner COSU)
  'ONEY123456789', // ONE por BL/SCAC
  'PABV1234567', // PIL por SCAC
  'ABCD1234567', // desconhecido
];

const args = process.argv.slice(2);
const refs = args.length ? args : SAMPLES;

let unknown = 0;
for (const ref of refs) {
  const d = detect(ref);
  const carrier = d.carrier ? d.carrier.name : '❓ desconhecido';
  if (!d.carrier) unknown++;
  const valid = d.referenceType === 'container' ? (d.isValidContainer ? '✓' : '✗ check') : '—';
  console.log(
    `${ref.padEnd(16)} → ${carrier.padEnd(28)} [${d.referenceType}, checkdigit ${valid}, via ${d.matchedBy}]`,
  );
  if (d.carrier?.trackingUrl) console.log(`${''.padEnd(18)}${d.carrier.trackingUrl}`);
}

if (!args.length) {
  // Na amostra, só "ABCD..." deve ficar desconhecido.
  console.log(`\nDesconhecidos: ${unknown} (esperado: 1)`);
  process.exit(unknown === 1 ? 0 : 1);
}
