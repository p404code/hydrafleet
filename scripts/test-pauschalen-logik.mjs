// node --test scripts/test-pauschalen-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../pauschalen-logik.js');

test('Wochen wie Postgres (IYYY-"W"IW), auch ueber den Jahreswechsel', () => {
  assert.equal(L.wochePlus('2026-W43', 1), '2026-W44');
  assert.equal(L.wochePlus('2026-W52', 1), '2026-W53');
  assert.equal(L.wochePlus('2026-W53', 1), '2027-W01');
  assert.equal(L.wochePlus('2025-W52', 1), '2026-W01');
  assert.equal(L.wochePlus('2027-W01', -1), '2026-W53');
  assert.equal(L.woche(new Date(Date.UTC(2026, 9, 31))), '2026-W44');
  assert.deepEqual(L.wochenAb('2026-W52', 3), ['2026-W52', '2026-W53', '2027-W01']);
  assert.equal(L.kw('2027-W01', '2026-W44'), 'KW01/27');
  assert.equal(L.kw('2026-W45', '2026-W44'), 'KW45');
});

const E = [
  { id: 1, am: '2026-10-31T09:00:00Z', art: 'f12', betrag: 500, gilt_ab: '2026-W44', gilt_bis: null },
  { id: 2, am: '2026-10-31T11:00:00Z', art: 'fix', betrag: 300, gilt_ab: '2026-W45', gilt_bis: '2026-W48', grund: 'Einstieg' },
  { id: 3, am: '2026-10-31T12:00:00Z', art: 'f12', betrag: 520, gilt_ab: '2026-W47', gilt_bis: null },
];

test('gilt: neuester gewinnt, Befristung mit Rueckfall (wie pauschale_fuer)', () => {
  assert.equal(L.gilt(E, '2026-W44').id, 1);
  assert.equal(L.gilt(E, '2026-W45').id, 2);
  assert.equal(L.gilt(E, '2026-W46').id, 2);
  assert.equal(L.gilt(E, '2026-W47').id, 3);
  assert.equal(L.gilt(E, '2026-W49').id, 3);
  assert.equal(L.gilt(E.slice(0, 2), '2026-W49').id, 1);
  assert.equal(L.gilt([], '2026-W44'), null);
});

test('ausblick: kommende Wechsel nach der Stichwoche', () => {
  assert.deepEqual(L.ausblick(E.slice(0, 2), '2026-W44').map((x) => [x.ab, x.eintrag.id]), [['2026-W45', 2], ['2026-W49', 1]]);
  assert.deepEqual(L.ausblick(E, '2026-W44').map((x) => [x.ab, x.eintrag.id]), [['2026-W45', 2], ['2026-W47', 3]]);
  assert.deepEqual(L.ausblick(E.slice(0, 1), '2026-W44'), []);
});

test('Texte', () => {
  assert.equal(L.kurz({ art: 'f12', betrag: 500 }), 'f12 · 500 €');
  assert.equal(L.kurz({ art: 'eigene', betrag: 0, prozent_satz: 25, prozent_schwelle: 0 }), '0 € + 25 % vom Umsatz');
  // de-AT wie fmt() im Dashboard: Tausender mit schmalem Leerzeichen
  assert.match(L.kurz({ art: 'eigene', betrag: 400, prozent_satz: 15, prozent_schwelle: 1000 }), /^400 € \+ 15 % über 1\s000 €$/);
  assert.equal(L.kurz({ art: 'eigene', betrag: 400, prozent_satz: 15, prozent_schwelle: 1000 }, true), '400 € + 15 %');
  assert.equal(L.kurz({ art: 'f12', betrag: 500 }, true), 'f12 · 500 €');
  assert.equal(L.regel({ art: 'fix', betrag: 0 }), 'fix – keine Pauschale');
  assert.equal(L.regel({ art: 'f11', betrag: 500 }), 'f11 – plus 10 % über 1.100 € Umsatz');  // fester Text
});

test('abzug wie der Bot', () => {
  assert.equal(L.abzug({ art: 'f12', betrag: 500 }, 1500), 530);
  assert.equal(L.abzug({ art: 'f11', betrag: 500 }, 1000), 500);
  assert.equal(L.abzug({ art: 'eigene', betrag: 0, prozent_satz: 25, prozent_schwelle: 0 }, 1500), 375);
  assert.equal(L.abzug({ art: 'fix', betrag: 230 }, 5000), 230);
});

test('formFehler wie pauschale_setzen', () => {
  const ok = { art: 'f12', betrag: '500', ab: '2026-W44' };
  assert.equal(L.formFehler(ok, '2026-W44'), '');
  assert.equal(L.formFehler({ ...ok, betrag: '0' }, '2026-W44'), '');
  assert.equal(L.formFehler({ ...ok, betrag: '1.234,5'.replace('.', '') }, '2026-W44'), '');
  assert.match(L.formFehler({ ...ok, betrag: '' }, '2026-W44'), /zwischen 0 und 5.000/);
  assert.match(L.formFehler({ ...ok, betrag: '6000' }, '2026-W44'), /zwischen 0 und 5.000/);
  assert.match(L.formFehler({ ...ok, ab: '2026-W43' }, '2026-W44'), /frühestens ab KW44/);
  assert.match(L.formFehler({ ...ok, bis: '2026-W43' }, '2026-W43'), /bis/);
  assert.match(L.formFehler({ ...ok, art: 'eigene', satz: '', schwelle: '0' }, '2026-W44'), /Prozentsatz/);
  assert.match(L.formFehler({ ...ok, art: 'eigene', satz: '25', schwelle: '' }, '2026-W44'), /Umsatzschwelle/);
  assert.equal(L.formFehler({ ...ok, art: 'eigene', satz: '25', schwelle: '0' }, '2026-W44'), '');
  assert.deepEqual(L.eintragAus({ art: 'eigene', betrag: '0', satz: '25', schwelle: '0', ab: '2026-W44', bis: '', grund: ' ' }),
    { art: 'eigene', betrag: 0, prozent_satz: 25, prozent_schwelle: 0, gilt_ab: '2026-W44', gilt_bis: null, grund: null });
});
