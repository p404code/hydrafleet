// Test der Edge Function anhang (Datei aus Telegram fuer die App) mit Attrappen (ohne Netz).
//   node --test scripts/test-anhang.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', TELEGRAM_BOT_TOKEN: '1:GEHEIM' })[k] },
  serve: (h) => { handler = h; } };

let W;
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/rest/v1/rpc/fahrer_app_anhang') {
    const b = JSON.parse(init.body);
    W.rpc.push({ wer: init.headers.Authorization, ...b });
    // Anna (FAHRER) darf Nachricht 5; Buero nur mit Vorschau-Id 1
    const darf = (init.headers.Authorization === 'Bearer ANNA' && b.p_id === 5 && b.p_fahrer_id == null)
              || (init.headers.Authorization === 'Bearer BUERO' && b.p_id === 5 && b.p_fahrer_id === 1);
    return json(200, darf ? [{ tg_file_id: W.fileId, anhang: W.art }] : []);
  }
  if (u.host === 'api.telegram.org' && u.pathname.endsWith('/getFile')) {
    if (W.weg) return json(400, { ok: false, error_code: 400, description: 'Bad Request: file not found' });
    return json(200, { ok: true, result: { file_id: W.fileId, file_path: W.pfad } });
  }
  if (u.host === 'api.telegram.org' && u.pathname.startsWith('/file/bot')) {
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }
  throw new Error('unerwartet: ' + url);
};
await import('../supabase/functions/anhang/index.ts');

const holen = (query, wer = 'ANNA') => handler(new Request('http://f/anhang?' + query, { headers: { Authorization: 'Bearer ' + wer } }));

test('eigene Datei: Bytes mit passendem Typ, privat zwischenspeicherbar', async () => {
  W = { rpc: [], fileId: 'F1', art: 'foto', pfad: 'photos/file_7.jpg', weg: false };
  const r = await holen('id=5');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /private/);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(W.rpc, [{ wer: 'Bearer ANNA', p_id: 5, p_fahrer_id: null }]);
});

test('Sprache von Telegram: audio/ogg', async () => {
  W = { rpc: [], fileId: 'V1', art: 'sprache', pfad: 'voice/file_9.oga', weg: false };
  const r = await holen('id=5');
  assert.equal(r.headers.get('content-type'), 'audio/ogg');
  W.pfad = 'music/file_3.m4a';
  assert.equal((await holen('id=5')).headers.get('content-type'), 'audio/mp4');
});

test('fremde oder unbekannte Nachricht: 404 ohne Telegram', async () => {
  W = { rpc: [], fileId: 'F1', art: 'foto', pfad: 'photos/a.jpg', weg: false };
  assert.equal((await holen('id=6')).status, 404);
  assert.equal((await holen('id=5', 'BERT')).status, 404);
  assert.equal((await holen('id=abc')).status, 400);
});

test('Buero-Vorschau mit Fahrer-Id', async () => {
  W = { rpc: [], fileId: 'F1', art: 'foto', pfad: 'photos/a.jpg', weg: false };
  assert.equal((await holen('id=5&fahrer=1', 'BUERO')).status, 200);
  assert.equal((await holen('id=5', 'BUERO')).status, 404);
});

test('Datei bei Telegram weg: 404 "nicht mehr verfuegbar", nie das Token', async () => {
  W = { rpc: [], fileId: 'F1', art: 'foto', pfad: 'photos/a.jpg', weg: true };
  const r = await holen('id=5');
  assert.equal(r.status, 404);
  const t = await r.text();
  assert.match(t, /nicht mehr verfügbar/);
  assert.doesNotMatch(t, /GEHEIM|bot1:/);
});
