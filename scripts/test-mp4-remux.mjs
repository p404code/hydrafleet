// node --test scripts/test-mp4-remux.mjs
// Das iPhone nimmt Sprache als fragmentiertes MP4 auf (Dauer im Kopf = 0, Ton in moof/trun-Stuecken); Telegram spielt davon nur
// die erste Sekunde (26.10.2026). fmp4ZuMp4 packt so eine Datei ohne Neukodierung in ein normales MP4 um.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmp4ZuMp4 } from '../supabase/functions/_shared/mp4-remux.ts';

import { box, boxen, finde, fragmentiert } from './mp4-testdatei.mjs';

const proben = Array.from({ length: 7 }, (_, i) => Buffer.alloc(10 + i * 3, i + 1));

test('fragmentiert -> normal: kein moof/mvex mehr, Dauer und Probentabellen stimmen, Ton unveraendert', () => {
  const ein = fragmentiert(proben);
  const aus = Buffer.from(fmp4ZuMp4(new Uint8Array(ein)));
  const oben = boxen(aus).map((x) => x.typ);
  assert.deepEqual(oben, ['ftyp', 'moov', 'mdat']);
  assert.ok(!boxen(aus, finde(aus, ['moov']).off + 8, finde(aus, ['moov']).off + finde(aus, ['moov']).size).some((x) => x.typ === 'mvex'));
  // Dauer: 7 Proben * 1024 bei 48000 -> mdhd 7168, mvhd (600er Takt) 90
  const mdhd = finde(aus, ['moov', 'trak', 'mdia', 'mdhd']);
  assert.equal(aus.readUInt32BE(mdhd.off + 8 + 16), 7 * 1024);
  const mvhd = finde(aus, ['moov', 'mvhd']);
  assert.equal(aus.readUInt32BE(mvhd.off + 8 + 16), Math.round(7 * 1024 / 48000 * 600));
  const tkhd = finde(aus, ['moov', 'trak', 'tkhd']);
  assert.equal(aus.readUInt32BE(tkhd.off + 8 + 20), Math.round(7 * 1024 / 48000 * 600));
  // stsz: Anzahl und Groessen, stco zeigt auf die Daten, die Daten sind genau die Proben in Reihenfolge
  const stsz = finde(aus, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  assert.equal(aus.readUInt32BE(stsz.off + 16), 7);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => aus.readUInt32BE(stsz.off + 20 + i * 4)), proben.map((p) => p.length));
  const stco = finde(aus, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  const daten = aus.readUInt32BE(stco.off + 16);
  assert.deepEqual(aus.subarray(daten, daten + 7 * 10 + 63), Buffer.concat(proben));
  const stts = finde(aus, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
  assert.deepEqual([aus.readUInt32BE(stts.off + 12), aus.readUInt32BE(stts.off + 16), aus.readUInt32BE(stts.off + 20)], [1, 7, 1024]);
  // stsd (Codec-Beschreibung) unveraendert uebernommen
  assert.ok(finde(aus, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']));
});

test('nicht fragmentiert oder kein MP4: null (Datei bleibt wie sie ist)', () => {
  const normal = Buffer.concat([box('ftyp', Buffer.from('M4A ', 'latin1')), box('moov', box('mvhd', Buffer.alloc(100))), box('mdat', Buffer.alloc(10))]);
  assert.equal(fmp4ZuMp4(new Uint8Array(normal)), null);
  assert.equal(fmp4ZuMp4(new Uint8Array(Buffer.from('OggS kein mp4'))), null);
  assert.equal(fmp4ZuMp4(new Uint8Array(0)), null);
});
