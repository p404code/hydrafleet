// node --test scripts/test-autoliste-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../autoliste-logik.js');

const AUTOS = [
  { kennzeichen_key: 'W2TX', kennzeichen: 'W-2TX', modell: 'Corolla', fahrer: [{ nr: 101, name: 'Ali Demir' }], notion_nicht_uebernommen: [] },
  { kennzeichen_key: 'W10TX', kennzeichen: 'W-10TX', modell: 'Prius', fahrer: [], notion_nicht_uebernommen: [] },
  { kennzeichen_key: 'W1TX', kennzeichen: 'W-1TX', modell: 'Škoda Octavia', fahrer: [{ nr: 102, name: 'Bea Müller' }], notion_nicht_uebernommen: [{ nr: 103, name: 'Pavel Paunov' }] },
];

test('sortiere: freie Autos zuerst, dann Kennzeichen natuerlich (W-2 vor W-10)', () => {
  assert.deepEqual(L.sortiere(AUTOS).map((a) => a.kennzeichen_key), ['W10TX', 'W1TX', 'W2TX']);
});

test('filtere: Chips und Suche (Kennzeichen ohne Bindestrich, Modell, Fahrer, Umlaute)', () => {
  assert.deepEqual(L.filtere(AUTOS, '', 'frei').map((a) => a.kennzeichen_key), ['W10TX']);
  assert.deepEqual(L.filtere(AUTOS, '', 'belegt').map((a) => a.kennzeichen_key).sort(), ['W1TX', 'W2TX']);
  assert.deepEqual(L.filtere(AUTOS, 'w 2tx', 'alle').map((a) => a.kennzeichen_key), ['W2TX']);
  assert.deepEqual(L.filtere(AUTOS, 'muller', 'alle').map((a) => a.kennzeichen_key), ['W1TX']);
  assert.deepEqual(L.filtere(AUTOS, 'skoda', 'alle').map((a) => a.kennzeichen_key), ['W1TX']);
  assert.deepEqual(L.filtere(AUTOS, 'pavel', 'alle').map((a) => a.kennzeichen_key), ['W1TX']);
  assert.equal(L.filtere(AUTOS, '', 'alle').length, 3);
});

const ALLE = [
  { notion_fahrer_id: 101, name: 'Ali Demir', telefon: '+43 660 1' },
  { notion_fahrer_id: 103, name: 'Pavel Paunov', telefon: '0660 1234' },
  { notion_fahrer_id: 213, name: 'Ali Özdemir', telefon: null },
  { notion_fahrer_id: 7, name: null, telefon: null },
  { notion_fahrer_id: 101, name: 'S—T—E—H—T', telefon: null },
  { notion_fahrer_id: 232, name: 'BIS', telefon: null },
];

test('sucheFahrer: Name (Umlaute), Nr., Telefon; "sitzt auf"; leer = nichts', () => {
  const sitzt = { 101: 'W-2TX' };
  const r = L.sucheFahrer(ALLE, 'ali', sitzt);
  assert.deepEqual(r.map((x) => [x.nr, x.sitzt]), [[101, 'W-2TX'], [213, null]]);
  assert.deepEqual(L.sucheFahrer(ALLE, 'ozdemir', sitzt).map((x) => x.nr), [213]);
  assert.deepEqual(L.sucheFahrer(ALLE, '103', sitzt).map((x) => x.nr), [103]);
  assert.deepEqual(L.sucheFahrer(ALLE, '1234', sitzt).map((x) => x.nr), [103]);
  assert.deepEqual(L.sucheFahrer(ALLE, '', sitzt), []);
  assert.deepEqual(L.sucheFahrer(ALLE, 'steht', sitzt), []);
  assert.deepEqual(L.sucheFahrer(ALLE, 'bis', sitzt), []);
  assert.deepEqual(L.sucheFahrer(ALLE, 'a', sitzt).length <= 20, true);
});
