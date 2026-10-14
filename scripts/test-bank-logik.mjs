// node --test scripts/test-bank-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const B = createRequire(import.meta.url)('../bank-logik.js');

test('gueltige IBANs aus mehreren Laendern', () => {
  for (const i of ['AT611904300234573201', 'DE89370400440532013000', 'GB82WEST12345698765432',
                   'LT121000011101001000', 'BG80BNBG96611020345678']) {
    assert.equal(B.ibanFehler(i), '', i);
  }
});
test('Schreibweise egal: Leerzeichen, klein, Bindestrich', () => {
  assert.equal(B.norm(' lt12 1000 0111-0100 1000 '), 'LT121000011101001000');
  assert.equal(B.ibanFehler('lt12 1000 0111-0100 1000'), '');
});
test('kaputte IBANs', () => {
  assert.match(B.ibanFehler(''), /fehlt/);
  assert.match(B.ibanFehler('AT611904300234573202'), /Prüfziffer/);   // letzte Ziffer falsch
  assert.match(B.ibanFehler('AT6119043002345732'), /Länge/);          // AT braucht 20
  assert.match(B.ibanFehler('1234567890123456'), /Ländercode/);
  assert.match(B.ibanFehler('XX00'), /Ländercode|Länge/);
});
test('Anzeige', () => {
  assert.equal(B.gruppiert('LT121000011101001000'), 'LT12 1000 0111 0100 1000');
  assert.equal(B.kurz('LT121000011101001000'), 'LT12 •••• 1000');
});
test('BIC, Revtag, Kontoinhaber', () => {
  assert.equal(B.bicFehler(''), ''); assert.equal(B.bicFehler('revolt21'), ''); assert.equal(B.bicFehler('REVOLT21XXX'), '');
  assert.match(B.bicFehler('REV'), /BIC/);
  assert.equal(B.revtagFehler(''), ''); assert.equal(B.revtagFehler('@max.m'), ''); assert.equal(B.revtagFehler('max_m'), '');
  assert.match(B.revtagFehler('@ m'), /Revtag/);
  assert.match(B.inhaberFehler(' '), /Kontoinhaber/); assert.equal(B.inhaberFehler('Max Muster'), '');
});
