/* IBAN/BIC/Revtag pruefen und anzeigen - gleiche Regeln wie iban_gueltig() in der Datenbank
   (migrations/2026-10-15-bankdaten.sql). Browser: window.BankLogik, Node: module.exports. */
(function (root) {
  const LAENGE = { AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
    GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MT: 31, NL: 18, NO: 15,
    PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, TR: 26, RS: 22, BA: 20, MK: 19, AL: 28, XK: 20, ME: 22, UA: 29,
    GE: 22, AZ: 28 };
  function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function mod97(i) {
    const r = i.slice(4) + i.slice(0, 4);
    let rest = 0;
    for (const c of r) {
      const d = c >= 'A' ? String(c.charCodeAt(0) - 55) : c;
      for (const z of d) rest = (rest * 10 + (z.charCodeAt(0) - 48)) % 97;
    }
    return rest;
  }
  function ibanFehler(s) {
    const i = norm(s);
    if (!i) return 'IBAN fehlt.';
    if (!/^[A-Z]{2}/.test(i)) return 'IBAN beginnt mit dem Ländercode, z. B. AT oder LT.';
    const soll = LAENGE[i.slice(0, 2)];
    if (soll ? i.length !== soll : (i.length < 15 || i.length > 34))
      return 'IBAN hat die falsche Länge' + (soll ? ' (' + i.slice(0, 2) + ': ' + soll + ' Zeichen).' : '.');
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(i)) return 'IBAN enthält ungültige Zeichen.';
    if (mod97(i) !== 1) return 'IBAN stimmt nicht (Prüfziffer) – bitte vergleichen.';
    return '';
  }
  function gruppiert(iban) { return norm(iban).replace(/(.{4})(?=.)/g, '$1 '); }
  function kurz(iban) { const i = norm(iban); return i.length > 8 ? i.slice(0, 4) + ' •••• ' + i.slice(-4) : i; }
  function bicFehler(s) {
    const b = norm(s);
    return !b || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(b) ? '' : 'BIC hat 8 oder 11 Zeichen, z. B. REVOLT21.';
  }
  function revtagFehler(s) {
    const r = String(s == null ? '' : s).trim();
    return !r || /^@?[A-Za-z0-9._-]{2,40}$/.test(r) ? '' : 'Revtag ohne Leerzeichen, z. B. @deinname.';
  }
  function inhaberFehler(s) {
    const n = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    return n.length >= 2 && n.length <= 140 ? '' : 'Kontoinhaber fehlt.';
  }
  const api = { norm, ibanFehler, gruppiert, kurz, bicFehler, revtagFehler, inhaberFehler };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BankLogik = api;
})(this);
