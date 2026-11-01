// Autoliste im Dashboard (Fahrer -> Autos) mit Attrappe statt Supabase ansehen – die Live-Datenbank wird nicht beruehrt.
//
//   node scripts/test-autoliste-ansicht.mjs <ausgabe-ordner>
//
// Baut eine Testkopie (Repo-Stamm, wird am Ende geloescht) mit Supabase-Ersatz, schaltet AU_AKTIV ein, setzt Pavel
// auf W-204TX und prueft Liste, Suche, Formular, den RPC-Aufruf und das Nachziehen in Notion. Bilder: Desktop + Handy.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const aus = process.argv[2];
if (!aus) { console.error('Aufruf: node scripts/test-autoliste-ansicht.mjs <ausgabe-ordner>'); process.exit(2); }

const ATTRAPPE = `<script>
window.__RPC = []; window.__INVOKE = [];
(function () {
  const P = (id, nr, art, betrag) => ({ id, notion_fahrer_id: nr, art, betrag, prozent_satz: null, prozent_schwelle: null,
    gilt_ab: '2026-W44', gilt_bis: null, grund: null, quelle: 'uebernahme', von: 'Übernahme aus Notion', am: '2026-10-31T20:00:00Z' });
  const TAB = {
    autoliste: [
      { kennzeichen_key: 'W204TX', kennzeichen: 'W 204TX', modell: 'Toyota Prius+', firma: 'HYD', notion_offen: false,
        fahrer: [{ nr: 202, name: 'Ramzan Alibekov', art: 'f12', betrag: 550 }],
        notion_nicht_uebernommen: [{ nr: 163, name: 'Pavel Paunov', telefon: '0660 1234' }] },
      { kennzeichen_key: 'W1061TX', kennzeichen: 'W-1061TX', modell: 'Corolla 22', firma: 'HYD', notion_offen: true,
        fahrer: [{ nr: 214, name: 'Kemal Yildiz', art: 'f12', betrag: 500 }, { nr: 92, name: 'Petra Huber', art: 'eigene', betrag: 0, prozent_satz: 25, prozent_schwelle: 0 }],
        notion_nicht_uebernommen: [] },
      { kennzeichen_key: 'W9237TX', kennzeichen: 'W-9237TX', modell: 'Toyota Prius', firma: 'HYD', notion_offen: false, fahrer: [], notion_nicht_uebernommen: [] },
    ],
    notion_fahrer: [
      { notion_fahrer_id: 202, name: 'Ramzan Alibekov', telefon: null }, { notion_fahrer_id: 163, name: 'Pavel Paunov', telefon: '0660 1234' },
      { notion_fahrer_id: 214, name: 'Kemal Yildiz', telefon: null }, { notion_fahrer_id: 92, name: 'Petra Huber', telefon: null },
      { notion_fahrer_id: 300, name: 'Paul Pichler', telefon: null },
    ],
    pauschalen: [P(1, 202, 'f12', 550), P(2, 214, 'f12', 500)],
    fahrer_auto: [{ id: 1, notion_fahrer_id: 202, kennzeichen_key: 'W204TX', kennzeichen: 'W 204TX', quelle: 'uebernahme', von: 'Übernahme aus Notion', am: '2026-11-01T10:00:00Z' }],
  };
  const q = (t) => { const r = { data: TAB[t] || [], error: null }; const b = { then: (ok, no) => Promise.resolve(r).then(ok, no) };
    ['select', 'order', 'is', 'not', 'eq', 'neq', 'limit', 'in', 'gte', 'lte', 'range', 'or'].forEach((m) => { b[m] = () => b; }); return b; };
  const fake = {
    from: q,
    rpc: async (name, args) => {
      if (name === 'pauschale_stichwoche') return { data: '2026-W44', error: null };
      window.__RPC.push([name, args]);
      if (name === 'auto_fahrer_setzen') return { data: { autos: [args.p_kennzeichen_key] }, error: null };
      if (name === 'auto_fahrer_entfernen') return { data: { autos: ['W204TX'] }, error: null };
      return { data: [], error: null };
    },
    functions: { invoke: async (name, opt) => { window.__INVOKE.push([name, opt && opt.body]); return { data: { ok: (opt.body.autos || []), fehler: [] }, error: null }; } },
    auth: { getSession: async () => ({ data: { session: { user: { app_metadata: { app_role: 'admin', app_name: 'Test' } } } } }),
            onAuthStateChange: () => {}, signOut: async () => {} },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  window.supabase.createClient = () => fake;
})();
</script>`;

const SCHRITTE = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const feld = () => isMobile() ? document.getElementById('auBody') : document.getElementById('auPanel');
  switchTab('autos'); await warte(400); await ladeAutos();
  const reihen = [...document.querySelectorAll('#auBody tr[data-au]')].map((tr) => tr.dataset.au);
  const zellen = [...document.querySelectorAll('#auBody tr[data-au]')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim());
  auWaehlen('W204TX'); await warte(150);
  const detail1 = feld().textContent.replace(/\\s+/g, ' ');
  feld().querySelector('[data-auneu]').click(); await warte(100);
  const suche = feld().querySelector('[data-ausuche]'); suche.value = 'pav'; suche.dispatchEvent(new Event('input', { bubbles: true })); await warte(100);
  const treffer = [...feld().querySelectorAll('[data-autreffer] [data-auwahl]')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim());
  feld().querySelector('[data-auwahl="163"]').click(); await warte(100);
  feld().querySelector('[data-pauart="f12"]').click(); await warte(80);
  const be = feld().querySelector('[data-pau="betrag"]'); be.value = '550'; be.dispatchEvent(new Event('input', { bubbles: true }));
  const vorschau = feld().querySelector('[data-pauvorschau]').textContent;
  if (!SPEICHERN) return JSON.stringify({ reihen, zellen, detail1, treffer, vorschau });
  feld().querySelector('[data-ausave]').click(); await warte(400);
  return JSON.stringify({ reihen, zellen, detail1, treffer, vorschau, rpc: window.__RPC, invoke: window.__INVOKE });
})().catch((e) => 'FEHLER ' + e.message)`;

const html = readFileSync(join(repo, 'dashboard.html'), 'utf8');
const cdn = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>';
assert.ok(html.includes(cdn), 'Supabase-CDN-Zeile nicht gefunden');
assert.ok(/const AU_AKTIV = (true|false);/.test(html), 'Schalter AU_AKTIV fehlt');
const testDatei = join(repo, '_test-autoliste.html');
writeFileSync(testDatei, html.replace(cdn, cdn + '\n' + ATTRAPPE).replace(/const AU_AKTIV = (true|false);/, 'const AU_AKTIV = true;'));
const sitzung = join(repo, '_test-sitzung-au.html');
writeFileSync(sitzung, `<!doctype html><meta charset="utf-8"><script>localStorage.setItem('hydralink_session', JSON.stringify({name:'test', role:'admin', timestamp: Date.now()}));localStorage.setItem('theme','light');location.replace('_test-autoliste.html');</script>`);
const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn('python3', ['-m', 'http.server', String(port)], { cwd: repo, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const shot = (datei, b, h, js) => execFileSync('node', [join(repo, 'scripts/shot.js'), `http://localhost:${port}/_test-sitzung-au.html`, join(aus, datei), b, h, js, '600'], { encoding: 'utf8' });
try {
  const lies = (out) => { const z = out.split('\n').find((l) => l.startsWith('EVAL:')); assert.ok(z && !z.includes('FEHLER'), out); return JSON.parse(z.slice(6)); };
  const D = lies(shot('autoliste-desktop.png', '1400', '1000', SCHRITTE.replace('SPEICHERN', 'false')));
  const M = lies(shot('autoliste-handy.png', '390', '1800', SCHRITTE.replace('SPEICHERN', 'false')));
  const S = lies(shot('autoliste-gespeichert.png', '1400', '900', SCHRITTE.replace('SPEICHERN', 'true')));
  console.log(JSON.stringify(D, null, 1));
  assert.deepEqual(D.reihen, ['W9237TX', 'W204TX', 'W1061TX'], 'freie Autos zuerst, dann Kennzeichen');
  assert.match(D.zellen[0], /frei/);
  assert.match(D.zellen[1], /Ramzan Alibekov/);
  assert.match(D.zellen[1], /Pavel Paunov/);   // in Notion, nicht uebernommen
  assert.match(D.zellen[2], /Notion offen/);
  assert.match(D.detail1, /Ramzan Alibekov/);
  assert.match(D.detail1, /nicht übernommen/);
  assert.deepEqual(D.treffer.length, 1);
  assert.match(D.treffer[0], /Pavel Paunov/);
  assert.match(D.vorschau, /zahlt Pavel f12 · 550 €/);
  assert.match(M.vorschau, /zahlt Pavel/);
  assert.deepEqual(S.rpc.filter((r) => r[0].startsWith('auto_fahrer')), [['auto_fahrer_setzen', { p_kennzeichen_key: 'W204TX', p_nr: 163, p_art: 'f12', p_betrag: 550,
    p_prozent_satz: null, p_prozent_schwelle: null, p_gilt_ab: '2026-W44', p_gilt_bis: null, p_grund: null }]]);
  assert.deepEqual(S.invoke, [['fuhrpark-notion', { autos: ['W204TX'] }]]);
  console.log('ok – Bilder in', aus);
} finally {
  server.kill();
  rmSync(testDatei, { force: true }); rmSync(sitzung, { force: true });
}
