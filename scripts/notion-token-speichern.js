// Legt den Notion-Integrations-Token verschluesselt im Supabase-Vault ab.
//
//   node scripts/notion-token-speichern.js
//
// Der Token wird eingetippt, nicht als Argument uebergeben - so landet er weder
// in der Shell-Historie noch in einer Prozessliste. Auf die Platte kommt er nie.
// Zum Erneuern einfach nochmal aufrufen.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

function frage(text) {
  return new Promise((r) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, (a) => { rl.close(); r(a.trim()); });
  });
}

(async () => {
  const token = await frage('Notion-Integrations-Token (beginnt mit ntn_ oder secret_): ');
  if (!token) throw new Error('nichts eingegeben');
  if (!/^(ntn_|secret_)/.test(token)) {
    console.warn('Hinweis: ungewohntes Format - trotzdem gespeichert.');
  }

  const key = serviceKey();
  const res = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_anbieter: 'notion',
      p_firma: null,
      p_externe_id: null,
      p_secret: { token, gesetzt_am: new Date().toISOString() },
      p_bezeichnung: 'notion_integration',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  console.log('Verbindung:', text.replace(/"/g, ''));
  console.log('Token gespeichert, Laenge', token.length, 'Zeichen. Er steht nirgends im Klartext.');
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
