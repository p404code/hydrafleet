// Einmalig vom Betreiber:  node scripts/gmail-zugang-speichern.js ~/Downloads/hydralink-google.json
// Oeffnet die Google-Anmeldung, holt einen Refresh-Token fuer sw.hydrafleet@gmail.com
// (gmail.send + gmail.readonly) und legt ihn im Vault ab (anbieter 'gmail'). Gibt keine Geheimnisse aus.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DATEI = process.argv[2];
if (!DATEI) { console.error('Aufruf: node scripts/gmail-zugang-speichern.js <client.json>'); process.exit(1); }
const c = JSON.parse(fs.readFileSync(DATEI, 'utf8')).installed;
const PORT = 8765, REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

function serviceKey() {
  const p = path.join(__dirname, '..', '.n8n-backup', 'AbrechnungsBot-v13-20260911.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const n of d.nodes) for (const h of (n.parameters?.headerParameters?.parameters || []))
    if (h.name === 'apikey' && JSON.parse(Buffer.from(h.value.split('.')[1], 'base64').toString()).role === 'service_role') return h.value;
  throw new Error('service_role-Key nicht gefunden');
}

const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
  access_type: 'offline', prompt: 'consent', login_hint: 'sw.hydrafleet@gmail.com',
});
const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.end('kein code'); return; }
  res.end('HYDRAlink: Anmeldung erhalten, Fenster kann zu.');
  server.close();
  try {
    const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) })).json();
    if (!t.refresh_token) throw new Error('kein refresh_token: ' + (t.error_description || t.error || 'unbekannt'));
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    if (prof.emailAddress !== 'sw.hydrafleet@gmail.com') throw new Error(`falsches Konto: ${prof.emailAddress} - nichts gespeichert`);
    const key = serviceKey();
    const r = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_anbieter: 'gmail', p_firma: 'hydrafleet_kg', p_externe_id: prof.emailAddress,
        p_secret: { client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token },
        p_bezeichnung: 'gmail_sw_hydrafleet' }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    console.log('Gmail-Verbindung:', (await r.text()).replace(/"/g, ''), '|', prof.emailAddress);
    process.exit(0);
  } catch (e) { console.error('FEHLER:', e.message); process.exit(1); }
}).listen(PORT, '127.0.0.1', () => { console.log('Browser oeffnet sich …'); execFileSync('open', [auth]); });
