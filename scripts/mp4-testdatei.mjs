// Testdateien: fragmentiertes MP4 wie vom iPhone (fuer test-mp4-remux.mjs und test-anhang-senden.mjs)
// --- kleine Box-Werkstatt fuer Testdateien ---
export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
export const box = (typ, ...teile) => { const inhalt = Buffer.concat(teile); return Buffer.concat([u32(8 + inhalt.length), Buffer.from(typ, 'latin1'), inhalt]); };
const voll = (typ, version, flags, ...teile) => box(typ, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...teile);
export function boxen(buf, off = 0, end = buf.length) {
  const out = [];
  while (off + 8 <= end) { const size = buf.readUInt32BE(off); out.push({ typ: buf.toString('latin1', off + 4, off + 8), off, size }); off += size; }
  return out;
}
export const finde = (buf, pfad) => {
  let off = 0, end = buf.length, b;
  for (const typ of pfad) {
    b = boxen(buf, off, end).find((x) => x.typ === typ);
    if (!b) return null;
    off = b.off + 8 + (['stsd'].includes(typ) ? 8 : 0); end = b.off + b.size;
  }
  return b;
};

// fragmentiertes MP4 wie vom iPhone: Dauer 0 im Kopf, zwei trun mit je eigenen Groessen, Daten in einem mdat
export function fragmentiert(proben) {
  const ftyp = box('ftyp', Buffer.from('iso5', 'latin1'), u32(1), Buffer.from('iso5isom', 'latin1'));
  const mvhd = voll('mvhd', 0, 0, u32(0), u32(0), u32(600), u32(0), Buffer.alloc(80));
  const tkhd = voll('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(60));
  const mdhd = voll('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(0), u32(0));
  const hdlr = voll('hdlr', 0, 0, u32(0), Buffer.from('soun', 'latin1'), Buffer.alloc(12), Buffer.from('ton\0', 'latin1'));
  const stsd = voll('stsd', 0, 0, u32(1), box('mp4a', Buffer.alloc(28)));
  const leer = (typ) => voll(typ, 0, 0, u32(0));
  const stbl = box('stbl', stsd, leer('stts'), leer('stsc'), voll('stsz', 0, 0, u32(0), u32(0)), leer('stco'));
  const minf = box('minf', voll('smhd', 0, 0, u32(0)), box('dinf', voll('dref', 0, 0, u32(1), voll('url ', 0, 1))), stbl);
  const trak = box('trak', tkhd, box('edts', voll('elst', 0, 0, u32(1), u32(0), u32(0), u32(0x10000))), box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', voll('trex', 0, 0, u32(1), u32(1), u32(1024), u32(0), u32(0)));
  const moov = box('moov', mvhd, trak, mvex);
  // zwei trun: Dauer aus trex (1024), Groessen je Probe; data_offset relativ zum moof-Anfang
  const halb = Math.ceil(proben.length / 2), a = proben.slice(0, halb), b = proben.slice(halb);
  const trun = (liste, dataOff) => voll('trun', 0, 0x201, u32(liste.length), u32(dataOff), ...liste.map((p) => u32(p.length)));
  const baue = (o1, o2) => box('moof', voll('mfhd', 0, 0, u32(1)),
    box('traf', voll('tfhd', 0, 0x20000, u32(1)), voll('tfdt', 0, 0, u32(0)), trun(a, o1), trun(b, o2)));
  const probe = baue(0, 0);
  const start = probe.length + 8;   // Daten beginnen nach moof + mdat-Kopf
  const moof = baue(start, start + a.reduce((n, p) => n + p.length, 0));
  const mdat = box('mdat', ...proben);
  return Buffer.concat([ftyp, moov, moof, mdat]);
}

