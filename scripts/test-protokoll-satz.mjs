// node --test scripts/test-protokoll-satz.mjs
// Holt den Block zwischen den PROTO-SATZ-Markern aus dashboard.html und prueft die reinen Funktionen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const m = html.match(/\/\* PROTO-SATZ START \*\/([\s\S]*?)\/\* PROTO-SATZ ENDE \*\//);
assert.ok(m, 'PROTO-SATZ-Block fehlt in dashboard.html');
const { protoSatz, protoErlaubt } = new Function(m[1] + '; return { protoSatz, protoErlaubt };')();
const z = (x) => Object.assign({ quelle: 'protokoll', anzahl: 1, alt: null, neu: null, felder: null, woche: null }, x);

test('korrektur geaendert', () => {
  assert.equal(protoSatz(z({ tabelle: 'settlements', aktion: 'geaendert', felder: ['korrektur', 'korrektur_note'],
    alt: { korrektur: 0, korrektur_note: null }, neu: { korrektur: -70, korrektur_note: 'Pickerl' } })),
    'Korrektur 0,00 → −70,00 · Notiz – → Pickerl');
});
test('zuschlag angelegt und geloescht', () => {
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_posten', aktion: 'neu', neu: { betrag: 70, text: 'Pickerl selbst bezahlt' } })),
    'Zuschlag +70,00 ‚Pickerl selbst bezahlt‘ angelegt');
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_posten', aktion: 'geloescht', alt: { betrag: -20, text: 'Schaden' } })),
    'Abschlag −20,00 ‚Schaden‘ gelöscht');
});
test('zahlung geloescht', () => {
  assert.equal(protoSatz(z({ tabelle: 'kassier_zahlungen', aktion: 'geloescht', alt: { betrag: 150 } })), 'Zahlung 150,00 gelöscht');
  assert.equal(protoSatz(z({ tabelle: 'kassier_zahlungen', aktion: 'neu', neu: { betrag: 150 } })), 'Zahlung 150,00 kassiert');
});
test('freigabe', () => {
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_freigaben', aktion: 'neu', woche: '2026-W40' })), 'KW 40 freigegeben');
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_freigaben', aktion: 'geloescht', woche: '2026-W40' })), 'Freigabe KW 40 zurückgenommen');
});
test('app-zugang', () => {
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['gesperrt', 'gesperrt_am'],
    alt: { gesperrt: false }, neu: { gesperrt: true } })), 'App-Zugang gesperrt');
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['gesperrt'],
    alt: { gesperrt: true }, neu: { gesperrt: false } })), 'App-Zugang entsperrt');
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['pin_geaendert_am'], alt: {}, neu: {} })), 'App-Zugang: PIN neu gesetzt');
});
test('sammelzeile der automatik', () => {
  assert.equal(protoSatz(z({ tabelle: 'settlements', aktion: 'gemischt', anzahl: 52, woche: '2026-W40' })),
    'Abrechnung KW 40 – 52 Zeilen neu geschrieben');
});
test('sync, post, kassa', () => {
  assert.equal(protoSatz({ quelle: 'sync', aktion: 'ok', anzahl: 24, neu: { anbieter: 'uber', firma: 'ee_taxi_kg', zeilen: 310, fehler: null } }),
    'Uber-Sync ee_taxi_kg · 24 Läufe · 310 Zeilen · ok');
  assert.equal(protoSatz({ quelle: 'sync', aktion: 'fehler', anzahl: 1, neu: { anbieter: 'bolt', firma: null, zeilen: 0, fehler: 'HTTP 401' } }),
    'Bolt-Sync · 1 Lauf · 0 Zeilen · Fehler: HTTP 401');
  assert.equal(protoSatz({ quelle: 'post', aktion: 'gesendet', anzahl: 1, neu: { an: 'a@b.at', gz: 'MA67/1', test_an: null } }),
    'Post gesendet an a@b.at (GZ MA67/1)');
  assert.equal(protoSatz({ quelle: 'kassa', aktion: 'aus', anzahl: 1, neu: { nr: 7, art: 'aus', betrag: 40, text: 'Tanken' } }),
    'Kassabuch Nr. 7 · Ausgabe 40,00 ‚Tanken‘');
  assert.equal(protoSatz({ quelle: 'kassa', aktion: 'storno', anzahl: 1, neu: { nr: 8, art: 'ein', betrag: 40, text: 'Storno', storno_von: 7 } }),
    'Kassabuch Nr. 8 · Storno · Einnahme 40,00 ‚Storno‘');
});
test('unbekannte tabelle und unbekanntes feld fallen auf roh zurueck', () => {
  assert.equal(protoSatz(z({ tabelle: 'neue_tabelle', aktion: 'geaendert', felder: ['xyz'], alt: { xyz: 1 }, neu: { xyz: { a: 1 } } })),
    'neue_tabelle geändert: xyz 1 → {"a":1}');
  assert.equal(protoSatz(z({ tabelle: 'neue_tabelle', aktion: 'neu', neu: {} })), 'neue_tabelle angelegt');
  assert.equal(protoSatz(z({ tabelle: 'customers', aktion: 'geloescht', alt: { name: 'Hotel X' } })), 'Kunde ‚Hotel X‘ gelöscht');
  assert.doesNotThrow(() => protoSatz({}));
  assert.doesNotThrow(() => protoSatz(z({ tabelle: 'settlements', aktion: 'geaendert' })));
});
test('nur admin darf den reiter', () => {
  assert.equal(protoErlaubt({ name: 'Boyko', role: 'admin' }), true);
  assert.equal(protoErlaubt({ name: 'Stefan', role: 'user' }), false);
  assert.equal(protoErlaubt(null), false);
  assert.equal(protoErlaubt({}), false);
});
test('post: gz steht dabei, zuordnung und freigabe als satz', () => {
  assert.equal(protoSatz(z({ tabelle: 'post_eingang', aktion: 'geaendert', felder: ['fahrer_id', 'status'],
    alt: { gz: 'MA67/1', fahrer_id: null, status: 'neu' }, neu: { gz: 'MA67/1', fahrer_id: 14, status: 'zugeordnet' } })),
    'Post GZ MA67/1: Fahrer zugeordnet · Status neu → zugeordnet');
  assert.equal(protoSatz(z({ tabelle: 'post_eingang', aktion: 'geaendert', felder: ['freigegeben_am', 'freigegeben_von', 'status'],
    alt: { gz: 'MA67/1', status: 'zugeordnet' }, neu: { gz: 'MA67/1', status: 'freigegeben', freigegeben_am: '2026-10-09T10:00:00Z', freigegeben_von: 'uuid' } })),
    'Post GZ MA67/1: freigegeben');
  assert.equal(protoSatz(z({ tabelle: 'post_eingang', aktion: 'geaendert', felder: ['fahrer_id'],
    alt: { gz: 'MA67/1', fahrer_id: 14 }, neu: { gz: 'MA67/1', fahrer_id: null } })), 'Post GZ MA67/1: Fahrer-Zuordnung entfernt');
  assert.equal(protoSatz(z({ tabelle: 'post_eingang', aktion: 'geaendert', felder: ['notiz'], alt: { gz: null, notiz: null }, neu: { gz: null, notiz: 'x' } })),
    'Post: Notiz – → x');
  assert.equal(protoSatz(z({ tabelle: 'post_eingang', aktion: 'geloescht', alt: { gz: 'MA67/1', art: 'strafverfuegung' } })), 'Post ‚MA67/1‘ gelöscht');
});
test('post-abgleich aus gmail ist kein versand aus hydralink', () => {
  assert.equal(protoSatz({ quelle: 'post', aktion: 'gesendet', anzahl: 1, neu: { an: 'a@b.at', gz: 'MA67/2', quelle: 'gmail_abgleich' } }),
    'Post von Hand beantwortet, per Gmail-Abgleich erkannt: a@b.at (GZ MA67/2)');
});
