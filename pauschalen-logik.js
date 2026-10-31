/* Pauschalen anzeigen und pruefen - gleiche Regeln wie pauschale_fuer() / pauschale_setzen() in der Datenbank
   (migrations/2026-10-31-pauschalen-*.sql). Browser: window.PauschalenLogik, Node: module.exports. */
(function (root) {
  // ISO-Woche 'JJJJ-Wnn' -> Montag (UTC) und zurueck
  function montag(w) {
    const m = /^(\d{4})-W(\d{2})$/.exec(w || '');
    if (!m) return null;
    const jan4 = new Date(Date.UTC(+m[1], 0, 4));
    const mo1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5);
    return new Date(mo1.getTime() + (+m[2] - 1) * 7 * 864e5);
  }
  function woche(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const j = t.getUTCFullYear();
    const nr = Math.ceil(((t - Date.UTC(j, 0, 1)) / 864e5 + 1) / 7);
    return j + '-W' + String(nr).padStart(2, '0');
  }
  function wochePlus(w, n) { const d = montag(w); return d ? woche(new Date(d.getTime() + (n || 0) * 7 * 864e5)) : null; }
  function wochenAb(w, anzahl) { const r = []; for (let i = 0; i < anzahl; i++) r.push(wochePlus(w, i)); return r; }
  // 'KW45', im Folgejahr 'KW01/27'
  function kw(w, bezug) {
    if (!w) return '';
    const j = w.slice(0, 4);
    return 'KW' + w.slice(-2) + (bezug && bezug.slice(0, 4) !== j ? '/' + j.slice(2) : '');
  }

  // Eintraege = Zeilen aus pauschalen (eines Fahrers). Es gilt der zuletzt gespeicherte, der die Woche abdeckt.
  function neuesteZuerst(a, b) { return String(b.am).localeCompare(String(a.am)) || (b.id - a.id); }
  function gilt(eintraege, w) {
    return (eintraege || []).filter(function (e) { return e.gilt_ab <= w && (!e.gilt_bis || e.gilt_bis >= w); })
      .sort(neuesteZuerst)[0] || null;
  }
  // Kommende Wechsel nach der Stichwoche (hoechstens n, Blick 2 Jahre voraus)
  function ausblick(eintraege, stich, n) {
    const out = []; let vor = gilt(eintraege, stich);
    const grenzen = {};
    (eintraege || []).forEach(function (e) {
      if (e.gilt_ab > stich) grenzen[e.gilt_ab] = true;
      if (e.gilt_bis && e.gilt_bis >= stich) grenzen[wochePlus(e.gilt_bis, 1)] = true;
    });
    Object.keys(grenzen).sort().forEach(function (w) {
      if (out.length >= (n || 3)) return;
      const g = gilt(eintraege, w);
      if (g !== vor) { out.push({ ab: w, eintrag: g }); vor = g; }
    });
    return out;
  }

  function zahl(x) { const v = parseFloat(x); return isFinite(v) ? v : 0; }
  function eur(x) {
    const v = zahl(x);
    return v.toLocaleString('de-AT', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
  }
  // knapp = fuer Tabellenzellen: eigene Regel ohne Schwelle ("400 € + 15 %")
  function kurz(e, knapp) {
    if (!e) return '–';
    if (e.art === 'eigene') return eur(e.betrag) + ' + ' + zahl(e.prozent_satz).toLocaleString('de-AT') + ' %' +
      (knapp ? '' : zahl(e.prozent_schwelle) > 0 ? ' über ' + eur(e.prozent_schwelle) : ' vom Umsatz');
    return e.art + ' · ' + eur(e.betrag);
  }
  function regel(e) {
    if (!e) return '';
    if (e.art === 'fix') return zahl(e.betrag) ? 'fix – nur Pauschale' : 'fix – keine Pauschale';
    if (e.art === 'f11') return 'f11 – plus 10 % über 1.100 € Umsatz';
    if (e.art === 'f12') return 'f12 – plus 10 % über 1.200 € Umsatz';
    return 'eigene Regel – plus ' + zahl(e.prozent_satz).toLocaleString('de-AT') + ' % ' +
      (zahl(e.prozent_schwelle) > 0 ? 'über ' + eur(e.prozent_schwelle) + ' Umsatz' : 'vom ganzen Umsatz');
  }
  // Abzug fuer einen Wochenumsatz (wie der Bot: Pauschale + Prozent ueber der Schwelle)
  function abzug(e, umsatz) {
    if (!e) return 0;
    const s = e.art === 'f11' ? [10, 1100] : e.art === 'f12' ? [10, 1200]
      : e.art === 'eigene' ? [zahl(e.prozent_satz), zahl(e.prozent_schwelle)] : [0, 0];
    return Math.round((zahl(e.betrag) + (s[0] ? Math.max(umsatz - s[1], 0) * s[0] / 100 : 0)) * 100) / 100;
  }

  // Eingaben aus dem Formular pruefen (wie pauschale_setzen). Leerer Text = Fehlermeldung.
  function lies(t) { const s = String(t == null ? '' : t).trim().replace(/\s/g, '').replace(',', '.'); return s === '' ? NaN : Number(s); }
  function formFehler(f, stich) {
    if (['fix', 'f11', 'f12', 'eigene'].indexOf(f.art) < 0) return 'Art wählen.';
    const b = lies(f.betrag);
    if (!(b >= 0 && b <= 5000)) return 'Pauschale zwischen 0 und 5.000 € angeben (0 ist erlaubt).';
    if (f.art === 'eigene') {
      const s = lies(f.satz), w = lies(f.schwelle);
      if (!(s > 0 && s <= 100)) return 'Prozentsatz größer 0 und höchstens 100 angeben.';
      if (!(w >= 0)) return 'Umsatzschwelle angeben (0 € = vom ganzen Umsatz).';
    }
    if (!f.ab || f.ab < stich) return 'Gilt frühestens ab ' + kw(stich) + ' – frühere Wochen sind schon freigegeben.';
    if (f.bis && f.bis < f.ab) return '„bis“ liegt vor „gilt ab“.';
    return '';
  }
  // Formular -> Eintrag (fuer Vorschau und RPC)
  function eintragAus(f) {
    const e = { art: f.art, betrag: lies(f.betrag), gilt_ab: f.ab, gilt_bis: f.bis || null, grund: String(f.grund || '').trim() || null };
    if (f.art === 'eigene') { e.prozent_satz = lies(f.satz); e.prozent_schwelle = lies(f.schwelle); }
    return e;
  }

  const api = { montag, woche, wochePlus, wochenAb, kw, gilt, ausblick, eur, kurz, regel, abzug, formFehler, eintragAus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PauschalenLogik = api;
})(typeof window !== 'undefined' ? window : globalThis);
