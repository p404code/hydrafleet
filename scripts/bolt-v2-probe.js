// Probe: ist unser Bolt-Zugang fuer die Fleet API v2 freigeschaltet, und was liefert getVehicles?
// Nur lesend. Gibt NIE Schluessel/Token aus, nur Fehlercodes, Zaehlungen und Feldbefuellung.
//   node scripts/bolt-v2-probe.js

const fs = require('fs');
const REPO = '/Users/pepe/Projects/hydrafleet';
const SB = 'https://pkxcwfkfaaorwnbdmylg.supabase.co';
const V2 = 'https://node.bolt.eu/fleet-integration-gateway-v2/fleetIntegration/v2';

function serviceKey() {
  const d = JSON.parse(fs.readFileSync(`${REPO}/.n8n-backup/AbrechnungsBot-v13-20260911.json`, 'utf8'));
  for (const n of d.nodes) for (const h of (n.parameters?.headerParameters?.parameters || []))
    if (h.name === 'apikey' && JSON.parse(Buffer.from(h.value.split('.')[1], 'base64')).role === 'service_role') return h.value;
  throw new Error('service_role-Key nicht gefunden');
}

async function sb(pfad, opt = {}) {
  const k = serviceKey();
  const r = await fetch(`${SB}/rest/v1/${pfad}`, { ...opt, headers: { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Supabase ${pfad}: HTTP ${r.status}`);
  return r.json();
}

async function token(z) {
  const r = await fetch('https://oidc.bolt.eu/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'fleet-integration:api', client_id: z.client_id, client_secret: z.client_secret }),
  });
  if (!r.ok) throw new Error(`Token HTTP ${r.status}`);
  return (await r.json()).access_token;
}

async function v2(t, pfad, body) {
  const r = await fetch(`${V2}/${pfad}`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j; try { j = await r.json(); } catch { j = { code: 'kein JSON' }; }
  return { http: r.status, code: j.code, message: j.message, data: j.data };
}

const voll = (a, f) => a.filter((x) => { const v = f(x); return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length); }).length;

(async () => {
  // Neue Zugangsdaten vor dem Eintragen testen: BOLT_CLIENT_ID + BOLT_CLIENT_SECRET setzen, dann kein Tresor.
  const env = process.env.BOLT_CLIENT_ID && process.env.BOLT_CLIENT_SECRET;
  const verb = env ? [{ firma: 'aus Umgebungsvariablen', status: '-' }]
    : await sb('verbindungen?anbieter=eq.bolt&select=id,firma,status');
  for (const v of verb) {
    console.log(`\n=== Verbindung ${v.firma} (status=${v.status})`);
    const z = env ? { client_id: process.env.BOLT_CLIENT_ID, client_secret: process.env.BOLT_CLIENT_SECRET }
      : await sb('rpc/verbindung_zugang', { method: 'POST', body: JSON.stringify({ p_verbindung_id: v.id }) });
    const t = await token(z);
    const c = await v2(t, 'getCompanies');
    console.log('getCompanies:', c.http, c.code, c.message, JSON.stringify(c.data)?.slice(0, 300));
    const ids = (c.data?.companies || c.data?.company_ids || []).map((x) => x.id ?? x.company_id ?? x);
    for (const co of ids) {
      const alle = []; let offset = 0, r;
      do {
        r = await v2(t, 'getVehicles', { company_id: co, limit: 1000, offset });
        if (r.code !== 0) break;
        alle.push(...(r.data.vehicles || [])); offset += 1000;
      } while (alle.length < (r.data.total_rows || 0));
      console.log(`\n-- Firma ${co}: getVehicles ${r.http} ${r.code} ${r.message}, Fahrzeuge ${alle.length}`);
      if (!alle.length) continue;
      const st = {}; alle.forEach((x) => (st[x.status] = (st[x.status] || 0) + 1));
      console.log('Status:', JSON.stringify(st));
      console.log('befuellt: vin', voll(alle, (x) => x.vin), '| konzession', voll(alle, (x) => x.transport_licence_number),
        '| make', voll(alle, (x) => x.make), '| added_to_fleet', voll(alle, (x) => x.added_to_fleet),
        '| deactivated_since', voll(alle, (x) => x.deactivated_since), '| eligible_categories', voll(alle, (x) => x.eligible_categories),
        '| suspension.current', voll(alle, (x) => x.suspension?.current), '| suspension.upcoming', voll(alle, (x) => x.suspension?.upcoming),
        '| drivers_with_selected_vehicle', voll(alle, (x) => x.drivers_with_selected_vehicle));
      const kat = {}; alle.forEach((x) => (x.eligible_categories || []).forEach((k) => (kat[k.name] = (kat[k.name] || 0) + 1)));
      console.log('Kategorien:', JSON.stringify(kat));
      const sp = alle.flatMap((x) => [...(x.suspension?.current || []).map((s) => ['jetzt', x, s]), ...(x.suspension?.upcoming || []).map((s) => ['kommt', x, s])]);
      sp.slice(0, 15).forEach(([w, x, s]) => console.log(`Sperre ${w}: ${x.registration_number} | ${s.category?.code} | ${s.type?.code}/${s.type?.name} | Dok ${s.document_type?.code || '-'} | ${s.start} -> ${s.end || 'offen'} | ${s.message || ''}`));
      const mehr = alle.filter((x) => (x.drivers_with_selected_vehicle || []).length > 1).length;
      console.log('Autos mit >1 Fahrer gewaehlt:', mehr);
      const b = alle.find((x) => (x.drivers_with_selected_vehicle || []).length) || alle[0];
      console.log('Beispiel (gekuerzt):', JSON.stringify({ ...b, drivers_with_selected_vehicle: (b.drivers_with_selected_vehicle || []).map((d) => ({ display_name: d.display_name, is_online: d.is_online, status: d.status, suspension_reason: d.suspension_reason })) }).slice(0, 1200));
    }
  }
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
