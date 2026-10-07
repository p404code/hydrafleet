// Holt die Fahrzeugliste einer Uber-Organisation aus dem Fleet-Portal (nur lesend):
// GraphQL "vehiclesTableVehicles" auf der Fahrzeugseite, mit der gespeicherten Sitzung
// aus dem Browserprofil. Liefert je Fahrzeug Kennzeichen, Marke, Modell, Baujahr, Farbe
// und imageURL (Ubers Modellbild, kein Foto des echten Autos).
//
//   node scripts/uber-fahrzeugbilder.js <profil> <org-id> <ausgabe.json>
//   node scripts/uber-fahrzeugbilder.js .hydrafleet-uber-profile-ee c566f3b3-772f-4b28-b644-877451d2d173 /tmp/fz.json
//
// Danach: neue Bilder nach img/fahrzeuge/ laden und uber_fahrzeuge aktualisieren
// (siehe migrations/2026-10-07-uber-fahrzeugbilder.sql). Stand 07.10.2026: 106 Fahrzeuge
// bei E&E Taxi KG, 32 verschiedene Bilder; EH hat im Portal keine Fahrzeuge mehr.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const BIN = '/Users/pepe/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const [profil, org, out] = process.argv.slice(2);
const PORT = 9400 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(BIN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.homedir(), profil)}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000', '--headless=new', 'about:blank'], { stdio: 'ignore' });
(async () => {
  let ziele;
  for (let i = 0; i < 100; i++) { try { ziele = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (ziele.find(z => z.type === 'page')) break; } catch (e) {} await sleep(200); }
  const ws = new WebSocket(ziele.find(z => z.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const offen = {}; let anfrage = null;
  const send = (method, params = {}) => new Promise(r => { const i = ++id; offen[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && offen[m.id]) { offen[m.id](m); delete offen[m.id]; return; }
    if (m.method === 'Network.requestWillBeSent') { const r = m.params.request; if (/\/graphql/.test(r.url) && r.postData && /vehiclesTableVehicles/.test(r.postData) && !anfrage) anfrage = { post: r.postData, headers: r.headers }; }
  };
  await send('Network.enable', { maxPostDataSize: 1000000 }); await send('Page.enable');
  await send('Page.navigate', { url: `https://fleethub.uber.com/orgs/${org}/vehicles` });
  for (let i = 0; i < 60 && !anfrage; i++) await sleep(500);
  const wo = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (!anfrage) { console.log('KEINE ANFRAGE – Seite:', wo.result.result.value); ws.close(); chrome.kill(); return; }
  const kopf = {}; for (const k of Object.keys(anfrage.headers)) if (/^(content-type|x-csrf-token|x-uber-|accept$)/i.test(k)) kopf[k] = anfrage.headers[k];
  const js = `(async () => {
    const basis = ${anfrage.post}; const alle = []; let token = ''; let seiten = 0;
    do {
      basis.variables.pageToken = token; basis.variables.pageSize = 50;
      const r = await fetch('/graphql', { method: 'POST', credentials: 'include', headers: ${JSON.stringify(kopf)}, body: JSON.stringify(basis) });
      const j = await r.json();
      if (!j.data || !j.data.getSupplierVehicles) return JSON.stringify({ fehler: JSON.stringify(j).slice(0, 500), status: r.status });
      const g = j.data.getSupplierVehicles; alle.push.apply(alle, g.vehicles || []);
      token = g.nextPageToken || (g.pageInfo && g.pageInfo.nextPageToken) || ''; seiten++;
      if (seiten === 1) window.__k = Object.keys(g);
    } while (token && seiten < 20);
    return JSON.stringify({ keys: window.__k, seiten, alle });
  })()`;
  const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
  const v = r.result.result && r.result.result.value;
  if (!v) { console.log('FEHLER', JSON.stringify(r.result).slice(0, 600)); }
  else { const j = JSON.parse(v); if (j.fehler) console.log('FEHLER', j); else { fs.writeFileSync(out, JSON.stringify(j.alle)); console.log('keys', j.keys, 'seiten', j.seiten, 'fahrzeuge', j.alle.length); } }
  ws.close(); chrome.kill();
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
