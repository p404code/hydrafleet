// node --test scripts/test-uber-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spalte, berichtWaehlen } from '../supabase/functions/_shared/uber-logik.ts';

test('spalte liest alte und neue Kopfzeile (Uber hat in KW40/2026 umbenannt)', () => {
  const alt = { 'An dein Unternehmen gezahlt': '12.50', 'An dein Unternehmen gezahlt : Deine Umsätze': '20' };
  const neu = { 'An dich gezahlt': '7.25', 'An dich gezahlt:Deine Umsätze:Trinkgeld': '1' };
  assert.equal(spalte(alt, 'An dein Unternehmen gezahlt'), '12.50');
  assert.equal(spalte(alt, 'An dein Unternehmen gezahlt : Deine Umsätze'), '20');
  assert.equal(spalte(neu, 'An dein Unternehmen gezahlt'), '7.25');
  assert.equal(spalte(neu, 'An dein Unternehmen gezahlt:Deine Umsätze:Trinkgeld'), '1');
  assert.equal(spalte(neu, 'An dein Unternehmen gezahlt:Deine Umsätze:Servicegebühr'), undefined);
});

const JETZT = Date.parse('2026-10-12T05:10:00Z');
const F = { vonMs: 1791165600000, bisMs: 1791770400000 };
const b = (id, typ, status, erstellt, von = F.vonMs, bis = F.bisMs) => ({
  id: { uuid: { value: id } }, reportType: typ, status,
  createdAt: { value: String(Date.parse(erstellt)) },
  unixTimeRange: { startTimeUnixMillis: { value: String(von) }, endTimeUnixMillis: { value: String(bis) } },
});
const ZAHL = 'REPORT_TYPE_PAYMENTS_DRIVER';

test('berichtWaehlen nimmt den Bericht des vorigen Laufs wieder auf', () => {
  const liste = [
    b('fahrten', 'REPORT_TYPE_TRIP_ACTIVITY', 'REPORT_STATUS_COMPLETED', '2026-10-12T05:00:11Z'),
    b('zahl', ZAHL, 'REPORT_STATUS_IN_PROGRESS', '2026-10-12T05:00:08Z'),
  ];
  assert.equal(berichtWaehlen(liste, ZAHL, F, JETZT), 'zahl');
  assert.equal(berichtWaehlen(liste, 'REPORT_TYPE_TRIP_ACTIVITY', F, JETZT), 'fahrten');
  assert.equal(berichtWaehlen(liste, 'REPORT_TYPE_VEHICLE_PERFORMANCE', F, JETZT), null);
});

test('berichtWaehlen: der neueste passende gewinnt', () => {
  const liste = [
    b('alt', ZAHL, 'REPORT_STATUS_COMPLETED', '2026-10-12T04:40:00Z'),
    b('neu', ZAHL, 'REPORT_STATUS_COMPLETED', '2026-10-12T05:00:08Z'),
  ];
  assert.equal(berichtWaehlen(liste, ZAHL, F, JETZT), 'neu');
});

test('berichtWaehlen verwirft alte, fehlgeschlagene und Berichte mit anderem Fenster', () => {
  // aelter als eine Stunde: koennte einen frueheren Datenstand zeigen
  assert.equal(berichtWaehlen([b('x', ZAHL, 'REPORT_STATUS_COMPLETED', '2026-10-12T04:05:00Z')], ZAHL, F, JETZT), null);
  assert.equal(berichtWaehlen([b('x', ZAHL, 'REPORT_STATUS_FAILED', '2026-10-12T05:00:08Z')], ZAHL, F, JETZT), null);
  // von Hand im Portal erzeugt, Fenster beginnt 88 s spaeter
  assert.equal(berichtWaehlen([b('x', ZAHL, 'REPORT_STATUS_COMPLETED', '2026-10-12T05:00:08Z', F.vonMs + 88000)], ZAHL, F, JETZT), null);
  assert.equal(berichtWaehlen([], ZAHL, F, JETZT), null);
  assert.equal(berichtWaehlen(undefined, ZAHL, F, JETZT), null);
});
