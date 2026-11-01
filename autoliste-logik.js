/* Autoliste (Fahrer -> Autos): sortieren, filtern, Fahrer suchen. Browser: window.AutolisteLogik, Node: module.exports.
   Spec docs/superpowers/specs/2026-11-01-autoliste-design.md. Tests: scripts/test-autoliste-logik.mjs */
(function (root) {
  // klein, ohne Akzente/Umlaut-Punkte, nur Buchstaben/Ziffern/Leerzeichen
  function norm(t) {
    return String(t == null ? '' : t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const kompakt = (t) => norm(t).replace(/ /g, '');
  // W-2TX vor W-10TX
  const vergleich = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

  function sortiere(autos) {
    return autos.slice().sort(function (a, b) {
      const fa = (a.fahrer || []).length ? 1 : 0, fb = (b.fahrer || []).length ? 1 : 0;
      return (fa - fb) || vergleich.compare(a.kennzeichen || '', b.kennzeichen || '');
    });
  }

  function filtere(autos, text, chip) {
    const t = norm(text), tk = kompakt(text);
    return autos.filter(function (a) {
      const belegt = (a.fahrer || []).length > 0;
      if (chip === 'frei' && belegt) return false;
      if (chip === 'belegt' && !belegt) return false;
      if (!t) return true;
      if (kompakt(a.kennzeichen).indexOf(tk) >= 0) return true;
      const namen = (a.fahrer || []).concat(a.notion_nicht_uebernommen || []).map(function (f) { return f.name; });
      return [a.modell].concat(namen).some(function (x) { return norm(x).indexOf(t) >= 0; });
    });
  }

  // alle = notion_fahrer-Zeilen; sitzt = { nr: Kennzeichen } fuer Fahrer, die schon auf einem Auto sitzen
  function sucheFahrer(alle, text, sitzt) {
    const t = norm(text), ziffern = String(text || '').replace(/\D/g, '');
    if (!t) return [];
    const treffer = [];
    for (const f of alle) {
      if (!f.name) continue;
      const nrTreffer = ziffern && String(f.notion_fahrer_id) === ziffern;
      const telTreffer = ziffern.length >= 4 && String(f.telefon || '').replace(/\D/g, '').indexOf(ziffern) >= 0;
      if (nrTreffer || telTreffer || norm(f.name).indexOf(t) >= 0) {
        treffer.push({ nr: f.notion_fahrer_id, name: f.name.trim(), telefon: f.telefon || null, sitzt: (sitzt || {})[f.notion_fahrer_id] || null });
      }
      if (treffer.length >= 20) break;
    }
    return treffer;
  }

  const api = { norm, sortiere, filtere, sucheFahrer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutolisteLogik = api;
})(typeof window !== 'undefined' ? window : globalThis);
