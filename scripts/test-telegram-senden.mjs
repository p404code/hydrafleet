// Test der Edge Function telegram-senden mit Attrappen fuer Deno, PostgREST und Telegram (ohne Netz).
//   node --test scripts/test-telegram-senden.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Attrappen ---------------------------------------------------------------
let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'k',
  TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_GRUPPE_ID: '-100' })[k] }, serve: (h) => { handler = h; } };

let W;   // Welt: Tabellen + Telegram
function neueWelt() {
  W = { nachrichten: [], tg_themen: [], weg: new Set(), naechsterThread: 100, naechsteMsg: 1, tg: [], dauer: () => 0 };
}
const tick = () => new Promise((r) => setImmediate(r));
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
function filter(rows, params) {
  return rows.filter((z) => [...params].every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v === 'is.null') return z[k] == null;
    if (v.startsWith('eq.')) return String(z[k]) === v.slice(3);
    if (v.startsWith('lt.')) return z[k] < (isNaN(+v.slice(3)) ? v.slice(3) : +v.slice(3));
    throw new Error('Filter fehlt: ' + k + '=' + v);
  }));
}
globalThis.fetch = async (url, init = {}) => {
  await tick();                                   // jede Anfrage dauert einen Moment -> echte Verschraenkung
  const u = new URL(url), body = init.body ? JSON.parse(init.body) : {};
  if (u.host === 'api.telegram.org') {
    const methode = u.pathname.split('/').pop();
    const ms = W.dauer(methode, body);              // Telegram antwortet unterschiedlich schnell
    if (ms) await new Promise((r) => setTimeout(r, ms));
    W.tg.push({ methode, ...body });
    const t = body.message_thread_id;
    if (t && W.weg.has(t) && ['sendMessage', 'editForumTopic', 'reopenForumTopic'].includes(methode))
      return json(400, { ok: false, error_code: 400, description: 'Bad Request: message thread not found' });
    if (methode === 'createForumTopic') return json(200, { ok: true, result: { message_thread_id: W.naechsterThread++, name: body.name } });
    if (methode === 'reopenForumTopic') return json(400, { ok: false, error_code: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED' });
    return json(200, { ok: true, result: { message_id: W.naechsteMsg++ } });
  }
  const [tabelle, rpc] = u.pathname.replace('/rest/v1/', '').split('/').reverse();
  if (rpc === undefined && tabelle === 'tg_thema_reservieren') throw new Error('unerwartet');
  if (u.pathname.endsWith('/rpc/tg_thema_reservieren')) {
    const nr = body.p_fahrer_nr, z = W.tg_themen.find((t) => t.fahrer_nr === nr);
    if (!z) { W.tg_themen.push({ fahrer_nr: nr, thread_id: null, name: null, kennzeichen: null, erstellt_am: Date.now() });
      return json(200, [{ thread_id: null, name: null, kennzeichen: null, reserviert: true }]); }
    return json(200, [{ thread_id: z.thread_id, name: z.name, kennzeichen: z.kennzeichen, reserviert: false }]);
  }
  const rows = W[tabelle], treffer = filter(rows, u.searchParams);
  if ((init.method ?? 'GET') === 'GET') return json(200, treffer.map((z) => ({ ...z })));
  if (init.method === 'PATCH') { treffer.forEach((z) => Object.assign(z, body)); return json(204, null); }
  if (init.method === 'DELETE') { W[tabelle] = rows.filter((z) => !treffer.includes(z)); return json(204, null); }
  throw new Error('Methode fehlt: ' + init.method);
};
await import('../supabase/functions/telegram-senden/index.ts');

const SERVICE = 'x.' + btoa(JSON.stringify({ role: 'service_role' })) + '.y';
const senden = (id) => handler(new Request('http://f', { method: 'POST', headers: { Authorization: 'Bearer ' + SERVICE }, body: JSON.stringify({ id }) }))
  .then((r) => r.json());
const kopf = (kz) => ({ name: 'Max Muster', fahrer_nr: 7, kennzeichen: kz, modell: 'Corolla' });
const nachricht = (id, text, kz) => W.nachrichten.push({ id, fahrer_nr: 7, richtung: 'fahrer', text, kopf: kopf(kz), tg_message_id: null, tg_versuche: 0, tg_fehler: null });
const gesendet = () => W.tg.filter((c) => c.methode === 'sendMessage').map((c) => [c.message_thread_id, c.text]);

// --- Tests --------------------------------------------------------------------
test('Autowechsel und Thema in Telegram geloescht: neues Thema, Nachricht kommt an', async () => {
  neueWelt();
  W.tg_themen.push({ fahrer_nr: 7, thread_id: 4, name: 'alt', kennzeichen: 'W-0000TX' });
  W.weg.add(4);
  nachricht(1, 'Hallo', 'W-1111TX');
  const r = await senden(1);
  assert.deepEqual(r.ergebnis, [{ id: 1, ok: true }], JSON.stringify(r));
  assert.equal(W.tg_themen.length, 1);
  assert.equal(W.tg_themen[0].thread_id, 100);
  assert.equal(W.tg_themen[0].kennzeichen, 'W-1111TX');
  assert.deepEqual(gesendet().at(-1), [100, '<b>Max:</b> Hallo']);
});

test('zwei Nachrichten gleichzeitig, Thema geloescht: genau ein neues Thema, beide darin', async () => {
  neueWelt();
  W.tg_themen.push({ fahrer_nr: 7, thread_id: 4, name: 'alt', kennzeichen: 'W-1111TX' });
  W.weg.add(4);
  // B merkt erst spaet, dass das Thema weg ist – A hat bis dahin schon ein neues angelegt
  W.dauer = (m, b) => (m === 'sendMessage' && b.message_thread_id === 4 && /zwei/.test(b.text) ? 300 : 0);
  nachricht(1, 'eins', 'W-1111TX'); nachricht(2, 'zwei', 'W-1111TX');
  const [a, b] = await Promise.all([senden(1), senden(2)]);
  assert.ok(a.ergebnis[0].ok && b.ergebnis[0].ok, JSON.stringify([a, b]));
  assert.equal(W.tg.filter((c) => c.methode === 'createForumTopic').length, 1, 'nur ein neues Thema');
  const thread = W.tg_themen[0].thread_id;
  assert.deepEqual(gesendet().filter(([t]) => t !== 4).map(([t]) => t), [thread, thread, thread], 'Kopf + beide Nachrichten im neuen Thema');
});

test('neuer Fahrer, zwei Nachrichten gleichzeitig: Kopf-Post kommt vor den Nachrichten', async () => {
  neueWelt();
  // der Kopf-Post braucht laenger als eine Warterunde (1 s) des zweiten Aufrufs
  W.dauer = (m, b) => (m === 'sendMessage' && /^🚕/.test(b.text) ? 1500 : 0);
  nachricht(1, 'eins', 'W-1111TX'); nachricht(2, 'zwei', 'W-1111TX');
  await Promise.all([senden(1), senden(2)]);
  const texte = gesendet().map(([, t]) => t);
  assert.match(texte[0], /^🚕 <b>Max Muster<\/b>/, JSON.stringify(texte));
  assert.equal(texte.length, 3);
});
