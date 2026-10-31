// Pauschalen-Block im Dashboard (Fahrer -> App) mit Attrappe statt Supabase ansehen – die Live-Datenbank wird nicht beruehrt.
//
//   node scripts/test-pauschalen-ansicht.mjs <ausgabe-ordner>
//
// Baut eine Testkopie _test-pauschalen.html (im Repo-Stamm, wird am Ende geloescht) mit einem Supabase-Ersatz,
// startet einen lokalen Server und macht mit scripts/shot.js Bilder: Desktop (Formular offen, eigene Regel) und Handy.
// Prueft nebenbei die Zelle in der Liste, die Vorschau und den Speichern-Aufruf.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const aus = process.argv[2];
if (!aus) { console.error('Aufruf: node scripts/test-pauschalen-ansicht.mjs <ausgabe-ordner>'); process.exit(2); }

const ATTRAPPE = `<script>
window.__GESETZT = [];
(function () {
  const FAHRER = [
    { fahrer_id: 1, name: 'Ali Demir', telefon: '+43 660 1', aktiv: true, notion_fahrer_id: 286, kennzeichen: 'W-204TX', marke: 'Toyota', modell: 'Prius', mietmodell: 'f12' },
    { fahrer_id: 2, name: 'Kemal Yildiz', telefon: '+43 660 2', aktiv: true, notion_fahrer_id: 214, kennzeichen: 'W-4181TX', marke: 'Toyota', modell: 'Corolla', mietmodell: 'f12' },
    { fahrer_id: 3, name: 'Petra Huber', telefon: '+43 660 3', aktiv: true, notion_fahrer_id: 92, kennzeichen: 'W-5625TX', marke: 'Skoda', modell: 'Octavia', mietmodell: 'eigene' },
  ];
  const P = (id, nr, art, betrag, ab, bis, grund, von, am, satz, schwelle) => ({ id, notion_fahrer_id: nr, art, betrag, prozent_satz: satz ?? null,
    prozent_schwelle: schwelle ?? null, gilt_ab: ab, gilt_bis: bis, grund, quelle: von.startsWith('Übernahme') ? 'uebernahme' : 'hand', von, am });
  const PAUSCH = [
    P(1, 286, 'f12', 550, '2026-W44', null, null, 'Übernahme aus Notion', '2026-10-31T20:00:00Z'),
    P(2, 214, 'f12', 500, '2026-W44', null, null, 'Übernahme aus Notion', '2026-10-31T20:00:00Z'),
    P(3, 214, 'fix', 300, '2026-W45', '2026-W48', 'Einstieg nach Unfall', 'Mohamed', '2026-10-31T21:10:00Z'),
    P(4, 92, 'fix', 230, '2026-W44', null, null, 'Übernahme aus Notion', '2026-10-31T20:00:00Z'),
    P(5, 92, 'eigene', 0, '2026-W44', null, 'Eigenes Auto', 'Stefan', '2026-10-31T21:20:00Z', 25, 0),
  ];
  const TAB = { fahrer_uebersicht: FAHRER, pauschalen: PAUSCH, fahrer: FAHRER.map((f) => ({ id: f.fahrer_id })) };
  const q = (t) => { const r = { data: TAB[t] || [], error: null }; const b = { then: (ok, no) => Promise.resolve(r).then(ok, no) };
    ['select', 'order', 'is', 'not', 'eq', 'neq', 'limit', 'in', 'gte', 'lte', 'range', 'single', 'maybeSingle'].forEach((m) => { b[m] = () => b; }); return b; };
  const fake = {
    from: q,
    rpc: async (name, args) => {
      if (name === 'pauschale_stichwoche') return { data: '2026-W44', error: null };
      if (name === 'pauschale_setzen') { window.__GESETZT.push(args); return { data: null, error: null }; }
      return { data: [], error: null };
    },
    auth: { getSession: async () => ({ data: { session: { user: { app_metadata: { app_role: 'admin', app_name: 'Test' } } } } }),
            onAuthStateChange: () => {}, signOut: async () => {} },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  window.supabase.createClient = () => fake;
})();
</script>`;

const SCHRITTE = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const feld = () => isMobile() ? document.getElementById('fzBody') : document.getElementById('fzPanel');
  switchTab('fahrer'); await warte(400); await ladeFahrer();
  selectFahrer(2); await warte(150);
  feld().querySelector('[data-pauauf]').click(); await warte(100);
  feld().querySelector('[data-pauart="eigene"]').click(); await warte(100);
  const setze = (k, v) => { const el = feld().querySelector('[data-pau="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  setze('betrag', '400'); setze('satz', '15'); setze('schwelle', '1000'); setze('grund', 'Sondervereinbarung Nachtschicht');
  const bis = feld().querySelector('[data-pau="ab"]'); bis.value = '2026-W45'; bis.dispatchEvent(new Event('change', { bubbles: true })); await warte(100);
  const zellen = [...document.querySelectorAll('#fzBody tr')].map((tr) => tr.lastElementChild && tr.lastElementChild.textContent);
  const vorschau = feld().querySelector('[data-pauvorschau]').textContent;
  const geplant = [...feld().querySelectorAll('.detail-kv')].map((d) => d.textContent).filter((t) => /KW/.test(t));
  const ergebnis = { zellen, vorschau, geplant, wertBetrag: feld().querySelector('[data-pau="betrag"]').value };
  if (!SPEICHERN) return JSON.stringify(ergebnis);
  feld().querySelector('[data-pausave]').click(); await warte(300);
  return JSON.stringify({ ...ergebnis, gesetzt: window.__GESETZT });
})().catch((e) => 'FEHLER ' + e.message)`;

const html = readFileSync(join(repo, 'dashboard.html'), 'utf8');
const cdn = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>';
assert.ok(html.includes(cdn), 'Supabase-CDN-Zeile nicht gefunden');
const testDatei = join(repo, '_test-pauschalen.html');
assert.ok(html.includes('const PAU_AKTIV = '), 'Schalter PAU_AKTIV fehlt');
writeFileSync(testDatei, html.replace(cdn, cdn + '\n' + ATTRAPPE).replace(/const PAU_AKTIV = (true|false);/, 'const PAU_AKTIV = true;'));
const sitzung = join(repo, '_test-sitzung.html');
writeFileSync(sitzung, `<!doctype html><meta charset="utf-8"><script>localStorage.setItem('hydralink_session', JSON.stringify({name:'test', role:'admin', timestamp: Date.now()}));localStorage.setItem('theme','light');location.replace('_test-pauschalen.html');</script>`);
const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn('python3', ['-m', 'http.server', String(port)], { cwd: repo, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const shot = (datei, b, h, js) => execFileSync('node', [join(repo, 'scripts/shot.js'), `http://localhost:${port}/_test-sitzung.html`, join(aus, datei), b, h, js, '600'], { encoding: 'utf8' });
try {
  const d = shot('pauschale-desktop.png', '1400', '1150', SCHRITTE.replace('SPEICHERN', 'false'));
  const m = shot('pauschale-handy.png', '390', '2200', SCHRITTE.replace('SPEICHERN', 'false'));
  const s = shot('pauschale-gespeichert.png', '1400', '900', SCHRITTE.replace('SPEICHERN', 'true'));
  const lies = (out) => { const z = out.split('\n').find((l) => l.startsWith('EVAL:')); assert.ok(z && !z.includes('FEHLER'), out); return JSON.parse(z.slice(6)); };
  const D = lies(d), M = lies(m), S = lies(s);
  console.log(JSON.stringify(D, null, 1));
  assert.ok(D.zellen.some((z) => /f12 · 500 €befristet/.test(z)), 'Zelle Kemal');
  assert.ok(D.zellen.some((z) => /^0 € \+ 25 %$/.test(z)), 'Zelle Petra');
  assert.match(D.vorschau, /KW45 zahlt Kemal 400 € \+ 15 % über 1\s000 € statt fix · 300 €/);
  assert.deepEqual(D.geplant.length >= 2, true, 'Geplant-Zeilen');
  assert.match(M.vorschau, /zahlt Kemal/);
  assert.deepEqual(S.gesetzt, [{ p_nr: 214, p_art: 'eigene', p_betrag: 400, p_prozent_satz: 15, p_prozent_schwelle: 1000,
    p_gilt_ab: '2026-W45', p_gilt_bis: null, p_grund: 'Sondervereinbarung Nachtschicht' }]);
  console.log('ok – Bilder in', aus);
} finally {
  server.kill();
  rmSync(testDatei, { force: true }); rmSync(sitzung, { force: true });
}
