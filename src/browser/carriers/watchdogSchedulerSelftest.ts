import http from 'http';
import type { AddressInfo } from 'net';
import { isDue, nextSlot, buildAlert, deliverAlert, WatchdogRowLite } from './watchdogScheduler';

/**
 * Priora — Self-test OFFLINE do watchdog AUTOMÁTICO:
 *  - agenda: roda uma vez por dia depois do horário; não repete no mesmo dia;
 *  - alerta: silêncio quando tudo segue saudável; avisa quando quebra, quando
 *    volta e (todo dia) enquanto houver falha grave;
 *  - entrega: POST no webhook (servidor local) + e-mail (função injetada) e
 *    erro de canal registrado sem derrubar a volta.
 *
 *   npm run watchdogauto:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

const row = (carrierId: string, health: WatchdogRowLite['health'], severity: WatchdogRowLite['severity']): WatchdogRowLite => ({
  carrierId,
  carrierName: carrierId.toUpperCase(),
  ref: 'REF123',
  health,
  severity,
  eventsCount: severity === 'ok' ? 10 : 0,
  message: null,
  action: severity === 'ok' ? 'ok' : 'investigar o layout',
});

async function main(): Promise<void> {
  console.log('[selftest] agenda (06:00 UTC)');
  const d = (iso: string) => new Date(iso);
  check('antes das 06:00 não roda', !isDue(d('2026-10-12T05:59:00Z'), d('2026-10-11T06:10:00Z'), 6));
  check('depois das 06:00, última ontem → roda', isDue(d('2026-10-12T06:01:00Z'), d('2026-10-11T06:10:00Z'), 6));
  check('já rodou hoje → não repete', !isDue(d('2026-10-12T15:00:00Z'), d('2026-10-12T06:05:00Z'), 6));
  check('serviço dormiu às 06:00 e acordou às 09:00 → roda', isDue(d('2026-10-12T09:00:00Z'), d('2026-10-11T06:05:00Z'), 6));
  check('próxima depois de rodar hoje = amanhã 06:00', nextSlot(d('2026-10-12T10:00:00Z'), d('2026-10-12T06:05:00Z'), 6).toISOString() === '2026-10-13T06:00:00.000Z');
  check('próxima antes do horário = hoje 06:00', nextSlot(d('2026-10-12T03:00:00Z'), d('2026-10-11T06:05:00Z'), 6).toISOString() === '2026-10-12T06:00:00.000Z');

  console.log('[selftest] quando avisar');
  const ok = [row('msc', 'healthy', 'ok'), row('zim', 'healthy', 'ok')];
  check('tudo saudável e igual → silêncio', !buildAlert(ok, ok).shouldAlert);
  const broke = [row('msc', 'broken', 'fail'), row('zim', 'healthy', 'ok')];
  const a1 = buildAlert(ok, broke);
  check('MSC quebrou → avisa', a1.shouldAlert && /Saíram de saudável/.test(a1.text) && /MSC: QUEBRADO/.test(a1.text), a1.text);
  check('assunto conta o grave', /1 armador\(es\) com problema \(1 grave\)/.test(a1.subject), a1.subject);
  check('segue quebrado no dia seguinte → avisa de novo', buildAlert(broke, broke).shouldAlert);
  const a2 = buildAlert(broke, ok);
  check('voltou → avisa "Voltaram ao normal"', a2.shouldAlert && /Voltaram ao normal/.test(a2.text), a2.text);
  const maint = [row('msc', 'maintenance', 'warn'), row('zim', 'healthy', 'ok')];
  check('entrou em manutenção (warn) → avisa uma vez', buildAlert(ok, maint).shouldAlert);
  check('manutenção igual no dia seguinte → silêncio', !buildAlert(maint, maint).shouldAlert);
  check('1ª volta já com problema → avisa', buildAlert(null, maint).shouldAlert);
  check('1ª volta toda saudável → silêncio', !buildAlert(null, ok).shouldAlert);

  console.log('[selftest] entrega (webhook local + e-mail injetado)');
  const got: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(body);
      res.statusCode = req.url === '/falha' ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const mails: Array<{ to: string[]; subject: string }> = [];
  const r1 = await deliverAlert('Assunto X', 'corpo Y', { enabled: true, hourUtc: 6, alertTo: ['a@b.com'], webhook: `http://127.0.0.1:${port}/ok` }, {
    sendEmail: async (to, subject) => {
      mails.push({ to, subject });
    },
  });
  const posted = got[0] ? JSON.parse(got[0]) : {};
  check('webhook recebeu {text, content}', /Assunto X/.test(posted.text) && /corpo Y/.test(posted.content), posted);
  check('e-mail enviado aos destinatários', mails.length === 1 && mails[0].to[0] === 'a@b.com' && mails[0].subject === 'Assunto X', mails);
  check('os dois canais ok', r1.channels.length === 2 && r1.channels.every((c) => c.ok), r1.channels);
  const r2 = await deliverAlert('S', 'T', { enabled: true, hourUtc: 6, alertTo: ['a@b.com'], webhook: `http://127.0.0.1:${port}/falha` }, {
    sendEmail: async () => {
      throw new Error('sem conta Microsoft vinculada');
    },
  });
  check('falha de canal fica registrada, sem exceção', r2.channels.every((c) => !c.ok) && r2.channels.some((c) => /HTTP 500/.test(c.error || '')), r2.channels);
  srv.close();

  if (failures === 0) console.log('\n[selftest] ✅ watchdog automático (agenda + alerta) OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
