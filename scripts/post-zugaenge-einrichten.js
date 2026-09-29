// Einmalig vom Betreiber auszufuehren (liest den service_role-Key wie uber-session-speichern.js):
//   node scripts/post-zugaenge-einrichten.js
//   pbpaste | node scripts/post-zugaenge-einrichten.js --nur-anthropic   (Key aus der Zwischenablage)
//   pbpaste | node scripts/post-zugaenge-einrichten.js --nur-gmail       (Gmail-App-Passwort fuer SMTP)
// 1) erzeugt den Eingangsschluessel fuer usp-bot.sh -> Vault (anbieter 'usp') + /root/.post-eingang-key auf taxi
// 2) fragt den Anthropic-API-Key verdeckt ab -> Vault (anbieter 'anthropic')
// Gibt keine Geheimnisse aus.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('readline');

function serviceKey() {
  const p = path.join(__dirname, '..', '.n8n-backup', 'AbrechnungsBot-v13-20260911.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const n of d.nodes) for (const h of (n.parameters?.headerParameters?.parameters || []))
    if (h.name === 'apikey' && JSON.parse(Buffer.from(h.value.split('.')[1], 'base64').toString()).role === 'service_role') return h.value;
  throw new Error('service_role-Key nicht gefunden');
}
async function setzen(key, anbieter, secret) {
  const r = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_anbieter: anbieter, p_firma: 'hydrafleet_kg', p_externe_id: null, p_secret: secret, p_bezeichnung: `post_${anbieter}` }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return (await r.text()).replace(/"/g, '');
}
function verdeckt(frage) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = () => {};
    process.stdout.write(frage);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}
// Ohne Terminal (z.B. "! pbpaste | node …" in Claude Code) kommt der Key aus stdin.
function ausStdin() {
  return new Promise((res) => { let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => res(d.trim())); });
}
(async () => {
  const key = serviceKey();
  if (process.argv.includes('--nur-gmail')) {
    // Gmail-App-Passwort (16 Zeichen, Leerzeichen egal) fuer SMTP-Versand von sw.hydrafleet@gmail.com
    const pw = (process.stdin.isTTY ? await verdeckt('Gmail-App-Passwort (Eingabe unsichtbar): ') : await ausStdin()).replace(/\s+/g, '');
    if (!/^[a-z]{16}$/i.test(pw)) throw new Error('sieht nicht wie ein 16-stelliges App-Passwort aus - nichts gespeichert');
    console.log('Gmail (SMTP):', await setzen(key, 'gmail', { user: 'sw.hydrafleet@gmail.com', app_passwort: pw }));
    return;
  }
  if (!process.argv.includes('--nur-anthropic')) {
    const postKey = crypto.randomBytes(32).toString('hex');
    console.log('USP-Eingang:', await setzen(key, 'usp', { post_key: postKey }));
    execFileSync('ssh', ['taxi', 'umask 077; cat > /root/.post-eingang-key'], { input: postKey });
    console.log('Schluessel auf taxi: /root/.post-eingang-key (600)');
  }
  const ak = process.stdin.isTTY ? await verdeckt('Anthropic-API-Key (Eingabe unsichtbar): ') : await ausStdin();
  if (!/^sk-ant-/.test(ak)) throw new Error('sieht nicht wie ein Anthropic-Key aus - nichts gespeichert');
  console.log('Anthropic:', await setzen(key, 'anthropic', { api_key: ak }));
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
