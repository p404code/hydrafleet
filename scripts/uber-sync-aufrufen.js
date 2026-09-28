// Startet die Edge Function uber-sync von Hand, wie der Montags-Zeitplan
// (service_role). Gibt nur die Antwort der Funktion aus, nie den Schluessel.
//
//   node scripts/uber-sync-aufrufen.js <woche> [test]
//   node scripts/uber-sync-aufrufen.js 2026-W39 test   # nur Verbindungstest, schreibt keine Daten
//   node scripts/uber-sync-aufrufen.js 2026-W39        # Woche neu holen (upsert)

const fs = require('fs');
const path = require('path');

const WOCHE = process.argv[2];
const TEST = process.argv[3] === 'test';
if (!/^\d{4}-W\d{2}$/.test(WOCHE || '') || (process.argv[3] && !TEST)) {
  console.error('Aufruf: node scripts/uber-sync-aufrufen.js <JJJJ-Wnn> [test]');
  process.exit(1);
}

// gleiche Quelle wie scripts/uber-session-speichern.js
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
  const key = serviceKey();
  const r = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST ? { woche: WOCHE, test: true } : { woche: WOCHE }),
  });
  console.log('HTTP', r.status);
  console.log(await r.text());
  process.exit(r.ok || r.status === 207 ? 0 : 1);
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
