// Test der Edge Function anhang-senden mit Attrappen fuer Deno, PostgREST, telegram-senden und Telegram (ohne Netz).
//   node --test scripts/test-anhang-senden.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fragmentiert, boxen } from './mp4-testdatei.mjs';

const G = '-1004453022013';
let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon',
  TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_GRUPPE_ID: G })[k] }, serve: (h) => { handler = h; } };

const MURAD = { fahrer_id: 5, fahrer_nr: 200, name: 'Murad Izrailov', kennzeichen: 'W 9911 TX', fahrzeug_modell: 'Corolla', vorschau: false };
let W;
function neueWelt() { W = { nachrichten: [], tg: [], themen: [], voiceFehler: false, naechsteId: 1 }; }
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
globalThis.fetch = async (url, init = {}) => {
  await new Promise((r) => setImmediate(r));
  const u = new URL(url);
  if (u.host === 'api.telegram.org') {
    const methode = u.pathname.split('/').pop();
    const felder = Object.fromEntries(init.body.entries());
    W.tg.push({ methode, ...felder });
    if (methode === 'sendPhoto') return json(200, { ok: true, result: { message_id: 900, photo: [{ file_id: 'klein', width: 90 }, { file_id: 'GROSS', width: 1280 }] } });
    if (methode === 'sendVoice') return W.voiceFehler ? json(400, { ok: false, error_code: 400, description: 'Bad Request: wrong file type' })
      : json(200, { ok: true, result: { message_id: 901, voice: { file_id: 'VO', duration: 12 } } });
    if (methode === 'sendAudio') return json(200, { ok: true, result: { message_id: 902, audio: { file_id: 'AU', duration: 12 } } });
  }
  if (u.pathname === '/functions/v1/telegram-senden') { W.themen.push(JSON.parse(init.body)); return json(200, { thread_id: 21 }); }
  if (u.pathname === '/rest/v1/rpc/fahrer_app_profil') {
    const wer = init.headers.Authorization;
    return json(200, wer === 'Bearer FAHRER' ? [MURAD] : []);
  }
  if (u.pathname === '/rest/v1/nachrichten') {
    if ((init.method ?? 'GET') === 'GET') {
      const seit = u.searchParams.get('erstellt_am').slice(3);
      return json(200, W.nachrichten.filter((n) => n.fahrer_nr === 200 && n.richtung === 'fahrer' && n.erstellt_am > seit).map((n) => ({ id: n.id })));
    }
    const z = { id: W.naechsteId++, erstellt_am: new Date().toISOString(), ...JSON.parse(init.body) };
    W.nachrichten.push(z);
    return json(201, [{ id: z.id }]);
  }
  throw new Error('unerwartet: ' + url);
};
await import('../supabase/functions/anhang-senden/index.ts');

const senden = (felder, wer = 'FAHRER', methode = 'POST') => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return handler(new Request('http://f', { method: methode, headers: { Authorization: 'Bearer ' + wer }, body: methode === 'POST' ? fd : undefined }));
};
const datei = (typ, groesse = 1000, name = 'x') => new File([new Uint8Array(groesse)], name, { type: typ });

test('Foto: ins Thema mit Bildunterschrift, Zeile mit Telegram-Kennungen', async () => {
  neueWelt();
  const r = await senden({ art: 'foto', datei: datei('image/jpeg'), text: 'Schaden hinten' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 1 });
  assert.deepEqual(W.themen, [{ thema: 200 }]);
  const t = W.tg.find((c) => c.methode === 'sendPhoto');
  assert.equal(t.chat_id, G); assert.equal(t.message_thread_id, '21');
  assert.equal(t.caption, '<b>Murad:</b> 📷 Schaden hinten'); assert.equal(t.parse_mode, 'HTML');
  assert.ok(t.photo instanceof Blob);
  const z = W.nachrichten[0];
  assert.deepEqual([z.fahrer_nr, z.richtung, z.anhang, z.tg_file_id, z.tg_message_id, z.text, z.dauer],
                   [200, 'fahrer', 'foto', 'GROSS', 900, 'Schaden hinten', null]);
  assert.equal(z.kopf.kennzeichen, 'W 9911 TX');
});

test('Sprache: sendVoice mit Dauer; lehnt Telegram ab, dann sendAudio', async () => {
  neueWelt();
  let r = await senden({ art: 'sprache', datei: datei('audio/mp4'), dauer: '12' });
  assert.equal(r.status, 200);
  const v = W.tg.find((c) => c.methode === 'sendVoice');
  assert.equal(v.duration, '12'); assert.ok(v.voice instanceof Blob); assert.equal(v.caption, '<b>Murad:</b> 🎤');
  assert.deepEqual([W.nachrichten[0].anhang, W.nachrichten[0].tg_file_id, W.nachrichten[0].dauer], ['sprache', 'VO', 12]);
  W.voiceFehler = true;
  r = await senden({ art: 'sprache', datei: datei('audio/mp4'), dauer: '12' });
  assert.equal(r.status, 200);
  assert.ok(W.tg.find((c) => c.methode === 'sendAudio').audio instanceof Blob);
  assert.equal(W.nachrichten[1].tg_file_id, 'AU');
});

test('abgelehnt ohne Telegram-Aufruf: Buero/Vorschau, zu gross, falscher Typ, zu lang, GET', async () => {
  neueWelt();
  assert.equal((await senden({ art: 'foto', datei: datei('image/jpeg') }, 'BUERO')).status, 403);
  assert.equal((await senden({ art: 'foto', datei: datei('image/jpeg', 6 * 1024 * 1024) })).status, 413);
  assert.equal((await senden({ art: 'foto', datei: datei('application/pdf') })).status, 415);
  assert.equal((await senden({ art: 'sprache', datei: datei('audio/mp4'), dauer: '200' })).status, 413);
  assert.equal((await senden({ art: 'foto' })).status, 400);
  assert.equal((await senden({}, 'FAHRER', 'GET')).status, 405);
  const r = await senden({ art: 'foto', datei: datei('application/pdf') });
  assert.deepEqual(await r.json(), { fehler: 'Nur Fotos (JPEG, PNG, HEIC)' });
  assert.equal(W.tg.length, 0); assert.equal(W.nachrichten.length, 0);
});

test('Spam-Limit gemeinsam mit Text: 10 in 10 Minuten', async () => {
  neueWelt();
  for (let i = 0; i < 10; i++) W.nachrichten.push({ id: 100 + i, fahrer_nr: 200, richtung: 'fahrer', erstellt_am: new Date().toISOString() });
  const r = await senden({ art: 'foto', datei: datei('image/jpeg') });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { fehler: 'Zu viele Nachrichten – bitte kurz warten' });
  assert.equal(W.tg.length, 0);
});

test('Sprache vom iPhone (fragmentiertes MP4) wird vor Telegram umgepackt', async () => {
  neueWelt();
  const ein = fragmentiert(Array.from({ length: 5 }, (_, i) => Buffer.alloc(20, i + 1)));
  const r = await senden({ art: 'sprache', datei: new File([ein], 'sprache.m4a', { type: 'audio/mp4' }), dauer: '1' });
  assert.equal(r.status, 200);
  const v = W.tg.find((c) => c.methode === 'sendVoice').voice;
  const typen = boxen(Buffer.from(await v.arrayBuffer())).map((x) => x.typ);
  assert.deepEqual(typen, ['ftyp', 'moov', 'mdat'], 'kein moof mehr');
  assert.equal(v.type, 'audio/mp4');
});
