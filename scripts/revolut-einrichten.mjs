// Revolut Business API einrichten (nur Serdo-Konto). Schluessel liegen in ~/revolut (nur fuer den Benutzer lesbar).
// Refresh-Token, Webhook-Secret und privater Schluessel werden NIE ausgegeben, sondern direkt als
// Edge-Function-Secrets in Supabase gesetzt (Supabase-CLI, einmal `supabase login` noetig).
//
//   node scripts/revolut-einrichten.mjs zertifikat           publiccert.cer in die Zwischenablage (fuer Revolut)
//   node scripts/revolut-einrichten.mjs link <client-id>     Zustimmungs-Link oeffnen (Client-ID wird gemerkt)
//   node scripts/revolut-einrichten.mjs token <code|url>     Code tauschen → Secrets setzen, Konto waehlen, Webhook anlegen
//   node scripts/revolut-einrichten.mjs konto <account-id>   REVOLUT_ACCOUNT_ID setzen (falls mehrere EUR-Konten)
//   node scripts/revolut-einrichten.mjs pruefen              welche Secrets gesetzt sind (nur Namen)
// REVOLUT_ENV=production fuer die Produktion (erst nach OK des Betreibers). Standard: sandbox.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clientAssertion } from '../supabase/functions/_shared/revolut-logik.ts';

const PROD = process.env.REVOLUT_ENV === 'production';
const API = PROD ? 'https://b2b.revolut.com/api' : 'https://sandbox-b2b.revolut.com/api';
const APP = PROD ? 'https://business.revolut.com' : 'https://sandbox-business.revolut.com';
const REDIRECT = 'https://hydrafleet.pages.dev/revolut-ok';
const ISS = new URL(REDIRECT).host;
const PROJEKT = 'pkxcwfkfaaorwnbdmylg';
const WEBHOOK = `https://${PROJEKT}.supabase.co/functions/v1/revolut-webhook`;
const DIR = join(homedir(), 'revolut');
const KEY = join(DIR, 'privatecert.pem'), CERT = join(DIR, 'publiccert.cer');
const CID = join(DIR, PROD ? 'client_id.produktion' : 'client_id.sandbox');
const CLI = process.env.SUPABASE_CLI || join(homedir(), '.hydrafleet-supabase-cli/node_modules/.bin/supabase');

const [schritt, arg] = process.argv.slice(2);
const raus = (t) => { console.error(t); process.exit(1); };
console.log(`Umgebung: ${PROD ? 'PRODUKTION' : 'Sandbox'}`);

// Secrets ueber eine kurzlebige Datei (0600) setzen - nie auf der Kommandozeile, nie im Terminal
function secretsSetzen(werte) {
  const datei = join(DIR, `.secrets-${process.pid}.env`);
  const zeile = (k, v) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
  writeFileSync(datei, Object.entries(werte).map(([k, v]) => zeile(k, v)).join('\n') + '\n', { mode: 0o600 });
  try { execFileSync(CLI, ['secrets', 'set', '--project-ref', PROJEKT, '--env-file', datei], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { raus('Secrets setzen fehlgeschlagen: ' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ') +
    '\n→ einmal im eigenen Terminal: ' + CLI + ' login'); }
  finally { if (existsSync(datei)) unlinkSync(datei); }
  console.log('In Supabase gesetzt: ' + Object.keys(werte).join(', '));
}
async function tokenAnfrage(felder) {
  const clientId = readFileSync(CID, 'utf8').trim();
  const body = new URLSearchParams({ ...felder, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(readFileSync(KEY, 'utf8'), clientId, ISS) });
  const r = await fetch(`${API}/1.0/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) raus(`Revolut ${r.status}: ${j.error || ''} ${j.error_description || ''}`);
  return { ...j, clientId };
}
async function rv(token, pfad, init = {}) {
  const r = await fetch(`${API}${pfad}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) raus(`Revolut ${r.status} bei ${pfad}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

if (schritt === 'zertifikat') {
  execFileSync('pbcopy', { input: readFileSync(CERT) });
  console.log('publiccert.cer ist in der Zwischenablage (öffentlich, unbedenklich). In Revolut: Settings → APIs → Business API → einfügen.');
} else if (schritt === 'link') {
  if (!arg) raus('Client-ID fehlt: node scripts/revolut-einrichten.mjs link <client-id>');
  writeFileSync(CID, arg.trim() + '\n', { mode: 0o600 });
  const u = new URL(`${APP}/app-confirm`);
  u.search = new URLSearchParams({ client_id: arg.trim(), redirect_uri: REDIRECT, response_type: 'code', scope: 'READ,WRITE' }).toString();
  console.log('\nZustimmen (nur READ + WRITE, KEIN PAY):\n' + u);
  try { execFileSync('open', [u.toString()]); } catch { /* Link steht oben */ }
} else if (schritt === 'token') {
  if (!arg) raus('Code fehlt');
  // Der Code gilt nur einmal: erst sicherstellen, dass die Secrets danach auch gespeichert werden koennen
  try { execFileSync(CLI, ['secrets', 'list', '--project-ref', PROJEKT], { stdio: 'ignore' }); }
  catch { raus('Supabase-CLI nicht angemeldet – Code NICHT verbraucht. Erst: ' + CLI + ' login, dann neu zustimmen.'); }
  const code = arg.includes('code=') ? new URL(arg).searchParams.get('code') : arg.trim();
  const t = await tokenAnfrage({ grant_type: 'authorization_code', code });
  const geheim = { REVOLUT_PRIVATE_KEY: readFileSync(KEY, 'utf8'), REVOLUT_CLIENT_ID: t.clientId,
    REVOLUT_REFRESH_TOKEN: t.refresh_token, REVOLUT_ENV: PROD ? 'production' : 'sandbox' };
  if (t.refresh_token_expires_in) console.log(`Refresh-Token gültig: ${Math.round(t.refresh_token_expires_in / 86400)} Tage`);

  const konten = (await rv(t.access_token, '/1.0/accounts')).filter((k) => k.currency === 'EUR' && k.state === 'active');
  console.log('\nEUR-Konten:');
  for (const k of konten) console.log(`  ${k.id}  ${String(k.balance).padStart(12)} EUR  ${k.name || ''}`);
  if (konten.length === 1) geheim.REVOLUT_ACCOUNT_ID = konten[0].id;
  else console.log('Mehrere/keine EUR-Konten → danach: node scripts/revolut-einrichten.mjs konto <id>');

  // Webhook: vorhandenen fuer dieselbe URL ersetzen, damit es genau ein Signing-Secret gibt
  const hooks = await rv(t.access_token, '/2.0/webhooks');
  for (const h of hooks || []) if (h.url === WEBHOOK) await rv(t.access_token, `/2.0/webhooks/${h.id}`, { method: 'DELETE' });
  const h = await rv(t.access_token, '/2.0/webhooks', { method: 'POST',
    body: JSON.stringify({ url: WEBHOOK, events: ['TransactionCreated', 'TransactionStateChanged'] }) });
  if (!h.signing_secret) raus('Webhook angelegt, aber Revolut hat kein Signing-Secret geliefert');
  geheim.REVOLUT_WEBHOOK_SECRET = h.signing_secret;
  console.log(`Webhook ${h.id} → ${h.url}`);
  secretsSetzen(geheim);
} else if (schritt === 'konto') {
  if (!/^[0-9a-f-]{36}$/i.test(arg || '')) raus('Konto-id (UUID) fehlt');
  secretsSetzen({ REVOLUT_ACCOUNT_ID: arg });
} else if (schritt === 'pruefen') {
  let aus;
  try { aus = execFileSync(CLI, ['secrets', 'list', '--project-ref', PROJEKT, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { raus('Supabase-CLI nicht angemeldet → einmal im eigenen Terminal: ' + CLI + ' login'); }
  const namen = JSON.parse(aus).map((s) => s.name).filter((n) => n.startsWith('REVOLUT_'));
  console.log('Gesetzt: ' + (namen.join(', ') || 'keine'));
} else {
  console.log('Schritte: zertifikat | link <client-id> | token <code> | konto <id> | pruefen (siehe Kopf)');
}
