// Liest die Uber-Sitzung aus dem laufenden Mitschnitt-Browser und legt sie
// verschluesselt im Supabase-Vault ab. Die Cookies landen NICHT auf der Platte
// und NICHT in der Ausgabe - hier kommt nur die Verbindungs-ID zurueck.
//
//   node scripts/uber-session-speichern.js <firma> [org_id]
//
// Zum Erneuern spaeter genauso aufrufen: im Browser neu anmelden, Skript laufen lassen.

const fs = require('fs');
const path = require('path');
const PORT = 9333;
const FIRMA = process.argv[2];
const ORG = process.argv[3] || null;
if (!FIRMA) { console.error('Aufruf: node scripts/uber-session-speichern.js <firma> [org_id]'); process.exit(1); }

function serviceKey() {
  const p = path.join(__dirname, '..', '.n8n-backup', 'AbrechnungsBot-v13-20260911.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const n of d.nodes) {
    for (const h of (n.parameters?.headerParameters?.parameters || [])) {
      if (h.name === 'apikey') {
        const rolle = JSON.parse(Buffer.from(h.value.split('.')[1], 'base64').toString()).role;
        if (rolle === 'service_role') return h.value;
      }
    }
  }
  throw new Error('service_role-Key nicht gefunden');
}

(async () => {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const p = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p[m.id]) { p[m.id](m); delete p[m.id]; } };
  const send = (m, pa = {}) => new Promise((r) => { const i = ++id; p[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: pa })); });

  const r = await send('Storage.getCookies', {});
  const host = 'fleethub.uber.com';
  const passt = (c) => { const d = c.domain.replace(/^\./, ''); return host === d || host.endsWith('.' + d); };
  const cs = (r.result.cookies || []).filter(passt);
  ws.close();
  if (!cs.length) throw new Error('Keine Cookies gefunden - im Browserfenster angemeldet?');

  const cookieHeader = cs.map((c) => `${c.name}=${c.value}`).join('; ');
  const ablauf = cs.filter((c) => c.expires > 0).map((c) => c.expires);
  const laeuftAb = ablauf.length ? new Date(Math.min(...ablauf) * 1000).toISOString() : null;

  // Neue Sitzung bei Uber pruefen, BEVOR die alte im Vault ueberschrieben wird -
  // sonst ersetzt ein abgemeldetes Fenster eine noch gueltige Sitzung.
  // Gleicher Aufruf wie in uber-sync (portal()).
  const probe = await fetch('https://fleethub.uber.com/api/vs-sp-reports-management/GetUserOrganizations?localeCode=de-DE', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-csrf-token': 'x', Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
    body: '{}',
  });
  let pj = null; try { pj = JSON.parse(await probe.text()); } catch {}
  if (!probe.ok || pj?.status !== 'success')
    throw new Error(`Neue Sitzung ungueltig (HTTP ${probe.status}) - Vault NICHT geaendert. Im Fenster anmelden.`);
  if (ORG && !(pj.data || []).some((o) => o.uuid === ORG))
    throw new Error('org_id gehoert nicht zu dieser Sitzung - Vault NICHT geaendert');

  const key = serviceKey();
  const res = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_anbieter: 'uber',
      p_firma: FIRMA,
      p_externe_id: ORG,
      p_secret: { cookie: cookieHeader, laeuft_ab: laeuftAb, gesetzt_am: new Date().toISOString() },
      p_bezeichnung: `uber_portal_${FIRMA}`,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);

  console.log('Verbindung:', text.replace(/"/g, ''));
  console.log('Cookies gespeichert:', cs.length, '| kuerzeste Gueltigkeit bis', (laeuftAb || 'Sitzungsende').slice(0, 16));
  process.exit(0);
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
