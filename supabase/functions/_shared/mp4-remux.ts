// Fragmentiertes MP4 (wie es das iPhone bei Sprachaufnahmen liefert: Dauer im Kopf 0, Ton in moof/trun-Stuecken) ohne
// Neukodierung in ein normales MP4 umpacken: ftyp + moov (mit Dauer und vollstaendigen Probentabellen) + mdat.
// Telegram spielte von den fragmentierten Dateien nur die erste Sekunde (26.10.2026).
// Tests: node --test scripts/test-mp4-remux.mjs. Nur eine Tonspur (das liefert der Rekorder).

type Box = { typ: string; off: number; size: number; kopf: number };

function boxen(b: Uint8Array, off: number, end: number): Box[] {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength), out: Box[] = [];
  while (off + 8 <= end) {
    let size = d.getUint32(off), kopf = 8;
    const typ = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (size === 1) { size = Number(d.getBigUint64(off + 8)); kopf = 16; }
    else if (size === 0) size = end - off;
    if (size < kopf || off + size > end) break;
    out.push({ typ, off, size, kopf });
    off += size;
  }
  return out;
}
const kind = (b: Uint8Array, p: Box, typ: string) => boxen(b, p.off + p.kopf, p.off + p.size).find((x) => x.typ === typ);
const alle = (b: Uint8Array, p: Box, typ: string) => boxen(b, p.off + p.kopf, p.off + p.size).filter((x) => x.typ === typ);
const roh = (b: Uint8Array, x: Box) => b.subarray(x.off, x.off + x.size);

function neueBox(typ: string, ...teile: Uint8Array[]): Uint8Array {
  const n = 8 + teile.reduce((s, t) => s + t.length, 0), out = new Uint8Array(n);
  new DataView(out.buffer).setUint32(0, n);
  for (let i = 0; i < 4; i++) out[4 + i] = typ.charCodeAt(i);
  let o = 8; for (const t of teile) { out.set(t, o); o += t.length; }
  return out;
}
function u32s(...werte: number[]): Uint8Array {
  const out = new Uint8Array(werte.length * 4), d = new DataView(out.buffer);
  werte.forEach((w, i) => d.setUint32(i * 4, w >>> 0));
  return out;
}
const vollBox = (typ: string, ...werte: number[]) => neueBox(typ, u32s(0, ...werte));   // version 0, flags 0

// Kopie einer Box mit neuer Dauer (mvhd/mdhd: nach creation/modification/timescale; tkhd: nach creation/modification/track_ID/reserved)
function mitDauer(b: Uint8Array, x: Box, dauer: number, tkhd = false): Uint8Array {
  const c = roh(b, x).slice(), d = new DataView(c.buffer), v = c[x.kopf];
  const pos = x.kopf + 4 + (v === 1 ? (tkhd ? 24 : 20) : (tkhd ? 16 : 12));
  if (v === 1) d.setBigUint64(pos, BigInt(dauer)); else d.setUint32(pos, dauer >>> 0);
  return c;
}
function zeitskala(b: Uint8Array, x: Box): number {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength), v = b[x.off + x.kopf];
  return d.getUint32(x.off + x.kopf + 4 + (v === 1 ? 16 : 8));
}

export function fmp4ZuMp4(b: Uint8Array): Uint8Array | null {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const oben = boxen(b, 0, b.length);
  const moov = oben.find((x) => x.typ === "moov"), moofs = oben.filter((x) => x.typ === "moof");
  if (!moov || !moofs.length) return null;   // kein MP4 oder schon normal
  const trak = kind(b, moov, "trak"), mvhd = kind(b, moov, "mvhd");
  const tkhd = trak && kind(b, trak, "tkhd"), mdia = trak && kind(b, trak, "mdia");
  const mdhd = mdia && kind(b, mdia, "mdhd"), hdlr = mdia && kind(b, mdia, "hdlr"), minf = mdia && kind(b, mdia, "minf");
  const stbl = minf && kind(b, minf, "stbl"), stsd = stbl && kind(b, stbl, "stsd");
  if (!trak || !mvhd || !tkhd || !mdhd || !hdlr || !minf || !stbl || !stsd) return null;
  const mvex = kind(b, moov, "mvex"), trex = mvex && kind(b, mvex, "trex");
  const trexDauer = trex ? d.getUint32(trex.off + trex.kopf + 12) : 0;
  const trexGroesse = trex ? d.getUint32(trex.off + trex.kopf + 16) : 0;

  // Proben aus allen moof/traf/trun sammeln: absolute Lage, Groesse, Dauer
  const proben: { off: number; size: number; dauer: number }[] = [];
  for (const moof of moofs) {
    for (const traf of alle(b, moof, "traf")) {
      const tfhd = kind(b, traf, "tfhd");
      if (!tfhd) return null;
      const tf = d.getUint32(tfhd.off + tfhd.kopf) & 0xffffff;
      let p = tfhd.off + tfhd.kopf + 8, basis = moof.off, stdDauer = trexDauer, stdGroesse = trexGroesse;
      if (tf & 0x1) { basis = Number(d.getBigUint64(p)); p += 8; }
      if (tf & 0x2) p += 4;
      if (tf & 0x8) { stdDauer = d.getUint32(p); p += 4; }
      if (tf & 0x10) { stdGroesse = d.getUint32(p); p += 4; }
      let weiter = basis;   // ohne data_offset: direkt hinter dem vorigen trun
      for (const trun of alle(b, traf, "trun")) {
        const fl = d.getUint32(trun.off + trun.kopf) & 0xffffff, n = d.getUint32(trun.off + trun.kopf + 4);
        let q = trun.off + trun.kopf + 8;
        let lage = weiter;
        if (fl & 0x1) { lage = basis + d.getInt32(q); q += 4; }
        if (fl & 0x4) q += 4;
        for (let i = 0; i < n; i++) {
          let dauer = stdDauer, size = stdGroesse;
          if (fl & 0x100) { dauer = d.getUint32(q); q += 4; }
          if (fl & 0x200) { size = d.getUint32(q); q += 4; }
          if (fl & 0x400) q += 4;
          if (fl & 0x800) q += 4;
          if (lage + size > b.length) return null;
          proben.push({ off: lage, size, dauer });
          lage += size;
        }
        weiter = lage;
      }
    }
  }
  if (!proben.length) return null;

  const mediaTakt = zeitskala(b, mdhd), filmTakt = zeitskala(b, mvhd);
  const summe = proben.reduce((s, x) => s + x.dauer, 0);
  const filmDauer = Math.round(summe / mediaTakt * filmTakt);
  // stts als Laeufe gleicher Dauer
  const laeufe: number[][] = [];
  for (const x of proben) { const l = laeufe[laeufe.length - 1]; if (l && l[1] === x.dauer) l[0]++; else laeufe.push([1, x.dauer]); }
  const stts = vollBox("stts", laeufe.length, ...laeufe.flat());
  const stsc = vollBox("stsc", 1, 1, proben.length, 1);   // alles ein Block
  const stsz = vollBox("stsz", 0, proben.length, ...proben.map((x) => x.size));
  const baueMoov = (datenOff: number) => neueBox("moov", mitDauer(b, mvhd, filmDauer),
    neueBox("trak", mitDauer(b, tkhd, filmDauer, true),
      neueBox("mdia", mitDauer(b, mdhd, summe), roh(b, hdlr),
        neueBox("minf", ...boxen(b, minf.off + minf.kopf, minf.off + minf.size).filter((x) => x.typ !== "stbl").map((x) => roh(b, x)),
          neueBox("stbl", roh(b, stsd), stts, stsc, stsz, vollBox("stco", 1, datenOff))))));
  const ftyp = neueBox("ftyp", new TextEncoder().encode("M4A "), u32s(0), new TextEncoder().encode("M4A isommp42"));
  const groesse = proben.reduce((s, x) => s + x.size, 0);
  const moovNeu = baueMoov(ftyp.length + baueMoov(0).length + 8);
  const mdat = new Uint8Array(8 + groesse);
  new DataView(mdat.buffer).setUint32(0, mdat.length); mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  let o = 8; for (const x of proben) { mdat.set(b.subarray(x.off, x.off + x.size), o); o += x.size; }
  const out = new Uint8Array(ftyp.length + moovNeu.length + mdat.length);
  out.set(ftyp, 0); out.set(moovNeu, ftyp.length); out.set(mdat, ftyp.length + moovNeu.length);
  return out;
}
