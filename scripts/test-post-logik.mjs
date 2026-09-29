// node --test scripts/test-post-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wienDatum, mieterZurTatzeit, pruefeAuslese, antwortMail, behoerdeKurz, knopfText, mimeRaw, fristErgaenzen, sendbarGrund }
  from '../supabase/functions/_shared/post-logik.ts';

const SORHAN = { id: 1, kurz: 'Sorhan', name: 'Sorhan Taxi KG', adresse: 'Seitenstettengasse 5/37, 1010 Wien', uid: null, fn: null, gueltig_von: null, gueltig_bis: '2026-01-10' };
const EH = { id: 2, kurz: 'EH', name: 'EH Limousinenservice KG', adresse: 'Thalhaimergasse 47/4, 1160 Wien', uid: 'ATU74849827', fn: '521134 z', gueltig_von: '2026-01-11', gueltig_bis: null };
const MIETER = [SORHAN, EH];

test('wienDatum nimmt Wiener Kalendertag', () => {
  assert.equal(wienDatum('2026-01-10T23:30:00Z'), '2026-01-11');   // Winter +1h
  assert.equal(wienDatum('2026-07-01T22:30:00Z'), '2026-07-02');   // Sommer +2h
  assert.equal(wienDatum('2026-07-01T21:30:00Z'), '2026-07-01');
});

test('mieter am Stichtag nach Wiener Datum', () => {
  assert.equal(mieterZurTatzeit(MIETER, '2026-01-10T22:30:00Z').kurz, 'Sorhan');  // 23:30 Wien
  assert.equal(mieterZurTatzeit(MIETER, '2026-01-10T23:30:00Z').kurz, 'EH');      // 00:30 Wien am 11.
  assert.equal(mieterZurTatzeit(MIETER, '2025-06-01T10:00:00Z').kurz, 'Sorhan');
  assert.equal(mieterZurTatzeit(MIETER, '2026-09-14T15:32:00Z').kurz, 'EH');
  assert.equal(mieterZurTatzeit(MIETER, null), null);
  assert.equal(mieterZurTatzeit([SORHAN], '2026-09-14T15:32:00Z'), null);
});

const LE = {
  art: 'lenkererhebung', gz: 'MA67/266700676804/2026', behoerde: 'MA 67', kennzeichen: 'W-1234TX',
  tatzeit: '2026-09-14T15:32:00Z', tatort: 'Wien 16', delikt: 'Parken', betrag: null, frist: '2026-10-05',
  antwort_email: 'lenkererhebung@ma67.wien.gv.at',
  volltext: 'GZ MA67/266700676804/2026 ... W-1234TX ... Antwort an lenkererhebung@ma67.wien.gv.at',
};

test('pruefeAuslese: saubere Lenkererhebung ist ok', () => {
  assert.deepEqual(pruefeAuslese(LE, '2026-09-28T10:00:00Z'), []);
});

test('pruefeAuslese: Mail nicht im PDF oder nicht .gv.at', () => {
  assert.ok(pruefeAuslese({ ...LE, antwort_email: 'x@ma67.wien.gv.at' }, null).some(g => g.includes('nicht im PDF')));
  assert.ok(pruefeAuslese({ ...LE, antwort_email: 'a@gmail.com', volltext: LE.volltext + ' a@gmail.com' }, null).some(g => g.includes('.gv.at')));
});

test('pruefeAuslese: GZ nicht im PDF, Tatzeit nach Zustellung, fehlende Pflichtfelder', () => {
  assert.ok(pruefeAuslese({ ...LE, gz: 'MA67/999/2026' }, null).some(g => g.includes('GZ')));
  assert.ok(pruefeAuslese(LE, '2026-09-01T00:00:00Z').some(g => g.includes('Tatzeit')));
  assert.ok(pruefeAuslese({ ...LE, kennzeichen: null }, null).some(g => g.includes('Kennzeichen')));
});

test('pruefeAuslese: sonstige Post braucht nichts', () => {
  assert.deepEqual(pruefeAuslese({ art: 'sonstige', gz: null, behoerde: 'WKO', kennzeichen: null, tatzeit: null, tatort: null, delikt: null, betrag: null, frist: null, antwort_email: null, volltext: 'Mahnung' }, null), []);
});

test('pruefeAuslese: Strafverfügung braucht Betrag', () => {
  const sv = { ...LE, art: 'strafverfuegung', betrag: null, antwort_email: null };
  assert.ok(pruefeAuslese(sv, null).some(g => g.includes('Betrag')));
  assert.deepEqual(pruefeAuslese({ ...sv, betrag: 90 }, null), []);
});

test('antwortMail: Text, Betreff, Empfänger', () => {
  const m = antwortMail(LE, EH);
  assert.equal(m.an, 'lenkererhebung@ma67.wien.gv.at');
  assert.equal(m.betreff, 'GZ: MA67/266700676804/2026');
  assert.match(m.text, /Fahrzeug W-1234TX zur Tatzeit 14\.09\.2026 17:32 vermietet war an:/);
  assert.match(m.text, /EH Limousinenservice KG, Thalhaimergasse 47\/4, 1160 Wien, ATU74849827, FN 521134 z/);
  assert.match(m.text, /Hydrafleet KG$/);
  const s = antwortMail({ ...LE, tatzeit: '2025-12-01T10:00:00Z' }, SORHAN);
  assert.match(s.text, /Sorhan Taxi KG, Seitenstettengasse 5\/37, 1010 Wien\n/);   // ohne UID/FN
});

test('behoerdeKurz und knopfText', () => {
  assert.equal(behoerdeKurz('lenkererhebung@ma67.wien.gv.at'), 'MA 67');
  assert.equal(behoerdeKurz('PK-W-15-Kanzlei@polizei.gv.at'), 'PK W 15');
  assert.equal(behoerdeKurz('LPD-W-SVA-5-Verkehrsamt@polizei.gv.at'), 'LPD W SVA 5');
  assert.equal(behoerdeKurz('post@bhmd.noe.gv.at'), 'bhmd.noe.gv.at');
  assert.equal(knopfText('lenkererhebung@ma67.wien.gv.at', EH), 'An MA 67 senden → EH');
});

test('mimeRaw: UTF-8-Betreff und Body, base64url', () => {
  const raw = mimeRaw('a@b.gv.at', 'GZ: Ä/1', 'Grüße');
  const txt = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(txt, /^To: a@b\.gv\.at\r\n/);
  assert.match(txt, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  assert.match(txt, /Content-Type: text\/plain; charset=UTF-8/);
  assert.ok(!/[+/=]/.test(raw));
  const body = txt.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Grüße');
});

test('fristErgaenzen: Lenkererhebung ohne Datum = Zustellung + 14 Tage (Wiener Datum)', () => {
  assert.equal(fristErgaenzen('lenkererhebung', null, '2026-09-18T10:05:03Z'), '2026-10-02');
  assert.equal(fristErgaenzen('lenkererhebung', null, '2026-09-17T22:30:00Z'), '2026-10-02');  // 18.09. 00:30 Wien
  assert.equal(fristErgaenzen('lenkererhebung', '2026-10-05', '2026-09-18T10:05:03Z'), '2026-10-05');  // Datum im PDF gewinnt
  assert.equal(fristErgaenzen('strafverfuegung', null, '2026-09-18T10:05:03Z'), null);
  assert.equal(fristErgaenzen('lenkererhebung', null, null), null);
});

test('pruefeAuslese: Tatzeit ohne Zeitzone ist ein Pruefgrund', () => {
  assert.ok(pruefeAuslese({ ...LE, tatzeit: '2026-01-10T23:30:00' }, null).some(g => g.includes('Zeitzone')));
  assert.deepEqual(pruefeAuslese({ ...LE, tatzeit: '2026-09-14T17:32:00+02:00' }, '2026-09-28T10:00:00Z'), []);
});

test('sendbarGrund: nur offen, ohne Pruefgrund, strikte .gv.at-Adresse', () => {
  const ok = { art: 'lenkererhebung', status: 'offen', pruef_grund: null, gz: 'MA67/1/2026', tatzeit: '2026-09-14T15:32:00Z', antwort_email: 'lenkererhebung@ma67.wien.gv.at' };
  assert.equal(sendbarGrund(ok), null);
  assert.match(sendbarGrund({ ...ok, status: 'erledigt' }), /nicht offen/);
  assert.match(sendbarGrund({ ...ok, status: 'beantwortet' }), /bereits beantwortet/);
  assert.match(sendbarGrund({ ...ok, pruef_grund: 'x' }), /prüfen/);
  assert.match(sendbarGrund({ ...ok, art: 'strafverfuegung' }), /keine Lenkererhebung/);
  assert.match(sendbarGrund({ ...ok, antwort_email: 'a@gmail.com' }), /Mailadresse/);
  assert.match(sendbarGrund({ ...ok, antwort_email: 'a@b.gv.at\r\nBcc: x@y.at' }), /Mailadresse/);
  assert.match(sendbarGrund({ ...ok, gz: null }), /fehlt/);
});
