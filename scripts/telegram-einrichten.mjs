// Telegram-Bot fuer die Fahrer-Nachrichten einrichten (Spec docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md).
// Das Bot-Token kommt von stdin (Zwischenablage) und wird nie ausgegeben. Secrets setzt das Skript selbst ueber die
// Supabase-CLI (~/.hydrafleet-supabase-cli, einmal `supabase login`), ueber eine kurzlebige Datei (0600) – nie auf der Kommandozeile.
//
//   pbpaste | node scripts/telegram-einrichten.mjs pruefen [--gruppe -100…]   Bot, Webhook, Secrets (und Gruppe) anzeigen, aendert nichts
//   pbpaste | node scripts/telegram-einrichten.mjs einrichten                Gruppe finden, pruefen, Secrets setzen, Webhook setzen
//   … einrichten --gruppe -100…                                              Gruppen-ID vorgeben (wenn mehrere/keine gefunden)
//   … einrichten --neue-vapid                                                VAPID neu erzeugen (alle Push-Abos werden ungueltig!)
//   pbpaste | node scripts/telegram-einrichten.mjs menue --gruppe -100…      Menue in "Allgemein" posten und anheften (Teil 2)
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { menueKnoepfe, menueText } from '../supabase/functions/_shared/telegram-logik.ts';

const PROJEKT = 'pkxcwfkfaaorwnbdmylg';
const WEBHOOK = `https://${PROJEKT}.supabase.co/functions/v1/telegram-webhook`;
const VAPID_SUBJECT = 'mailto:sw.hydrafleet@gmail.com';
const SECRETS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_GRUPPE_ID', 'TELEGRAM_WEBHOOK_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
const CLI = process.env.SUPABASE_CLI || join(homedir(), '.hydrafleet-supabase-cli/node_modules/.bin/supabase');
const args = process.argv.slice(2);
const schritt = args[0];
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : null; };
const raus = (t) => { console.error(t); process.exit(1); };

let TOKEN = '';
for await (const c of process.stdin) TOKEN += c;
TOKEN = TOKEN.trim();
if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(TOKEN)) raus('Kein Bot-Token auf stdin. Token von @BotFather kopieren, dann: pbpaste | node scripts/telegram-einrichten.mjs …');

// Fehler nie mit URL ausgeben – dort steckt das Token
async function tg(methode, body = {}) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { raus(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) raus(`Telegram ${methode}: ${j.error_code ?? r.status} ${j.description ?? ''}`);
  return j.result;
}
function cliFehler(e) {
  return String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ') + '\n→ einmal im eigenen Terminal: ' + CLI + ' login';
}
function secretNamen() {
  try {
    const aus = execFileSync(CLI, ['secrets', 'list', '--project-ref', PROJEKT, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(aus).map((s) => s.name);
  } catch (e) { raus('Supabase-CLI: ' + cliFehler(e)); }
}
function secretsSetzen(werte) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-')), datei = join(dir, 'secrets.env');
  const zeile = (k, v) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  writeFileSync(datei, Object.entries(werte).map(([k, v]) => zeile(k, v)).join('\n') + '\n', { mode: 0o600 });
  try { execFileSync(CLI, ['secrets', 'set', '--project-ref', PROJEKT, '--env-file', datei], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { raus('Secrets setzen fehlgeschlagen: ' + cliFehler(e)); }
  finally { try { unlinkSync(datei); } catch {} rmSync(dir, { recursive: true, force: true }); }
  console.log('In Supabase gesetzt: ' + Object.keys(werte).join(', '));
}
function vapidErzeugen() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  return { pub, priv: j.d };
}
async function gruppeFinden() {
  if (opt('--gruppe')) return opt('--gruppe');
  const info = await tg('getWebhookInfo');
  if (info.url) await tg('deleteWebhook', { drop_pending_updates: false });   // mit Webhook liefert getUpdates nichts
  const updates = await tg('getUpdates', { allowed_updates: ['message', 'my_chat_member'], timeout: 0 });
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message ?? u.my_chat_member)?.chat;
    if (c && c.type === 'supergroup') chats.set(String(c.id), c);   // mit Themen ist die Gruppe immer eine Supergruppe
  }
  if (chats.size === 1) return [...chats.keys()][0];
  if (!chats.size) raus('Keine Gruppe gefunden. Bitte in der Team-Gruppe unter „Allgemein“ kurz etwas schreiben und nochmal starten.');
  raus('Mehrere Gruppen gefunden – bitte mit --gruppe <id> wählen:\n' + [...chats.values()].map((c) => `  ${c.id}  ${c.title}`).join('\n'));
}
async function gruppePruefen(gruppe, me) {
  const chat = await tg('getChat', { chat_id: gruppe });
  const mitglied = await tg('getChatMember', { chat_id: gruppe, user_id: me.id });
  const probleme = [];
  if (!chat.is_forum) probleme.push('In der Gruppe sind die Themen nicht eingeschaltet (Gruppeninfo → Bearbeiten → Themen).');
  if (mitglied.status !== 'administrator') probleme.push('Der Bot ist kein Admin der Gruppe.');
  else {
    if (!mitglied.can_manage_topics) probleme.push('Dem Bot fehlt das Admin-Recht „Themen verwalten“.');
    if (!mitglied.can_pin_messages) probleme.push('Dem Bot fehlt das Admin-Recht „Nachrichten anheften“ (für das Menü).');
  }
  console.log(`Gruppe: ${chat.title} (${gruppe}) · Themen ${chat.is_forum ? 'an' : 'AUS'} · Bot ${mitglied.status}`
    + (mitglied.can_manage_topics ? ' mit „Themen verwalten“' : '') + (mitglied.can_pin_messages ? ', „Nachrichten anheften“' : ''));
  return probleme;
}

const me = await tg('getMe');
console.log(`Bot: @${me.username}`);

if (schritt === 'pruefen') {
  const info = await tg('getWebhookInfo');
  console.log(`Webhook: ${info.url || '(keiner)'} · wartend ${info.pending_update_count}`
    + (info.last_error_message ? ` · letzter Fehler: ${info.last_error_message}` : ''));
  if (opt('--gruppe')) {
    const p = await gruppePruefen(opt('--gruppe'), me);
    p.forEach((x) => console.log('✗ ' + x));
    if (!p.length) console.log('✓ Gruppe passt');
  }
  const namen = secretNamen();
  for (const n of SECRETS) console.log(`${namen.includes(n) ? '✓' : '✗'} ${n}`);
} else if (schritt === 'einrichten') {
  const gruppe = await gruppeFinden();
  const probleme = await gruppePruefen(gruppe, me);
  if (probleme.length) raus(probleme.join('\n'));
  const geheim = randomBytes(32).toString('hex');   // Telegram erlaubt A-Z a-z 0-9 _ -, 1–256 Zeichen
  const werte = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GRUPPE_ID: gruppe, TELEGRAM_WEBHOOK_SECRET: geheim };
  let vapid = null;
  if (args.includes('--neue-vapid') || !secretNamen().includes('VAPID_PRIVATE_KEY')) {
    vapid = vapidErzeugen();
    Object.assign(werte, { VAPID_PUBLIC_KEY: vapid.pub, VAPID_PRIVATE_KEY: vapid.priv, VAPID_SUBJECT });
  }
  secretsSetzen(werte);
  await tg('setWebhook', { url: WEBHOOK, secret_token: geheim, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true, max_connections: 10 });
  console.log(`Webhook gesetzt: ${WEBHOOK}`);
  if (vapid) console.log(`\nVAPID (öffentlich) – in fahrer/index.html als VAPID_PUBLIC eintragen:\n${vapid.pub}`);
  else console.log('VAPID bleibt wie es ist (steht schon in fahrer/index.html).');
} else if (schritt === 'menue') {
  const gruppe = opt('--gruppe') || raus('Bitte --gruppe <id> angeben (steht in CLAUDE.md, Abschnitt „Nachrichten“).');
  const probleme = await gruppePruefen(gruppe, me);
  if (probleme.length) raus(probleme.join('\n'));
  const m = await tg('sendMessage', { chat_id: gruppe, text: menueText(), parse_mode: 'HTML', reply_markup: menueKnoepfe() });
  await tg('pinChatMessage', { chat_id: gruppe, message_id: m.message_id, disable_notification: true });
  console.log('Menü gepostet und angeheftet (Nachricht ' + m.message_id + ').');
} else {
  raus('Schritt fehlt: pruefen | einrichten | menue');
}
