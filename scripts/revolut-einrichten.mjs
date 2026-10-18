// Revolut Business API einrichten (Serdo-Konto). Laeuft NUR lokal im eigenen Terminal des Betreibers -
// nicht ueber Claude (`!`), denn Refresh-Token und Webhook-Secret werden hier einmal angezeigt.
// Nichts wird gespeichert; die Werte traegt der Betreiber selbst als Edge-Function-Secrets ein
// (Supabase → Edge Functions → Secrets).
//
//   export REVOLUT_KEY_FILE=~/revolut/privatecert.pem REVOLUT_CLIENT_ID=… REVOLUT_ENV=sandbox
//   node scripts/revolut-einrichten.mjs link      1. Zustimmungs-Link (im Browser oeffnen, bestaetigen)
//   node scripts/revolut-einrichten.mjs token     2. Code von hydrafleet.pages.dev/revolut-ok eingeben → Refresh-Token
//   node scripts/revolut-einrichten.mjs konten    3. Konten mit id (→ REVOLUT_ACCOUNT_ID)
//   node scripts/revolut-einrichten.mjs webhook   4. Webhook anlegen → Signing-Secret (→ REVOLUT_WEBHOOK_SECRET)
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { clientAssertion } from '../supabase/functions/_shared/revolut-logik.ts';

const PROD = process.env.REVOLUT_ENV === 'production';
const API = PROD ? 'https://b2b.revolut.com/api' : 'https://sandbox-b2b.revolut.com/api';
const APP = PROD ? 'https://business.revolut.com' : 'https://sandbox-business.revolut.com';
const REDIRECT = 'https://hydrafleet.pages.dev/revolut-ok';
const ISS = new URL(REDIRECT).host;
const WEBHOOK = 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/revolut-webhook';

const schritt = process.argv[2];
const clientId = process.env.REVOLUT_CLIENT_ID;
if (!clientId) { console.error('REVOLUT_CLIENT_ID fehlt (Revolut Business → Settings → APIs → Business API).'); process.exit(2); }
console.log(`Umgebung: ${PROD ? 'PRODUKTION' : 'Sandbox'}`);

const frage = async (t) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(t); rl.close(); return a.trim(); };
function schluessel() {
  const f = (process.env.REVOLUT_KEY_FILE || '').replace(/^~/, homedir());
  if (!f) { console.error('REVOLUT_KEY_FILE fehlt (Pfad zu privatecert.pem).'); process.exit(2); }
  return readFileSync(f, 'utf8');
}
async function tokenAnfrage(felder) {
  const body = new URLSearchParams({ ...felder, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(schluessel(), clientId, ISS) });
  const r = await fetch(`${API}/1.0/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`Revolut ${r.status}: ${j.error || ''} ${j.error_description || ''}`); process.exit(1); }
  return j;
}
async function access() {
  const refresh = process.env.REVOLUT_REFRESH_TOKEN || await frage('Refresh-Token: ');
  return (await tokenAnfrage({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).access_token;
}

if (schritt === 'link') {
  const u = new URL(`${APP}/app-confirm`);
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: 'READ,WRITE' }).toString();
  console.log('\nIm Browser öffnen, im Revolut-Konto (Serdo) zustimmen – Rechte nur READ + WRITE, KEIN PAY:\n\n' + u + '\n');
  console.log('Danach zeigt hydrafleet.pages.dev/revolut-ok den Code. Er gilt nur ~2 Minuten → sofort Schritt "token".');
} else if (schritt === 'token') {
  const roh = await frage('Code (oder die ganze Adresse aus dem Browser): ');
  const code = roh.includes('code=') ? new URL(roh).searchParams.get('code') : roh;
  const j = await tokenAnfrage({ grant_type: 'authorization_code', code });
  console.log('\nREVOLUT_REFRESH_TOKEN (als Edge-Function-Secret eintragen, nirgends sonst speichern):\n\n' + j.refresh_token + '\n');
  if (j.refresh_token_expires_in) console.log(`Gültig noch ${Math.round(j.refresh_token_expires_in / 86400)} Tage.`);
} else if (schritt === 'konten') {
  const t = await access();
  const r = await fetch(`${API}/1.0/accounts`, { headers: { Authorization: `Bearer ${t}` } });
  const konten = await r.json();
  if (!r.ok) { console.error(`Revolut ${r.status}: ${JSON.stringify(konten)}`); process.exit(1); }
  console.log('\nREVOLUT_ACCOUNT_ID = id des EUR-Kontos, von dem ausgezahlt wird:\n');
  for (const k of konten) console.log(`${k.id}  ${k.currency}  ${String(k.balance).padStart(12)}  ${k.name || ''}  ${k.state}`);
} else if (schritt === 'webhook') {
  const t = await access();
  const r = await fetch(`${API}/2.0/webhooks`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: WEBHOOK, events: ['TransactionCreated', 'TransactionStateChanged'] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`Revolut ${r.status}: ${JSON.stringify(j)}`); process.exit(1); }
  console.log(`\nWebhook angelegt (${j.id}) → ${j.url}\n\nREVOLUT_WEBHOOK_SECRET (als Edge-Function-Secret eintragen):\n\n${j.signing_secret}\n`);
} else {
  console.log('Schritte: link | token | konten | webhook (siehe Kopf dieser Datei)');
}
