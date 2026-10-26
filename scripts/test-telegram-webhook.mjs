// Test der Edge Function telegram-webhook mit Attrappen fuer Deno, PostgREST und Telegram (ohne Netz).
//   node --test scripts/test-telegram-webhook.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const G = -1004453022013, BOT = 8960907965, SECRET = 'geheim';
let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'k', TELEGRAM_BOT_TOKEN: BOT + ':abc',
  TELEGRAM_GRUPPE_ID: String(G), TELEGRAM_WEBHOOK_SECRET: SECRET })[k] }, serve: (h) => { handler = h; } };

let W;
const FAHRER = [{ fahrer_nr: 200, name: 'Murad Izrailov', kennzeichen: 'W-1TX', modell: null },
                { fahrer_nr: 201, name: 'Anna Fahr', kennzeichen: 'W-2TX', modell: null }];
function neueWelt() {
  W = { tg_menue: [], tg_themen: [{ fahrer_nr: 200, thread_id: 13 }], nachrichten: [], naechsteMsg: 1000, tg: [] };
}
const tick = () => new Promise((r) => setImmediate(r));
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
function filter(rows, params) {
  return rows.filter((z) => [...params].every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v.startsWith('eq.')) return String(z[k]) === v.slice(3);
    throw new Error('Filter fehlt: ' + k + '=' + v);
  }));
}
globalThis.fetch = async (url, init = {}) => {
  await tick();
  const u = new URL(url), body = init.body ? JSON.parse(init.body) : {};
  if (u.host === 'api.telegram.org') {
    const methode = u.pathname.split('/').pop();
    W.tg.push({ methode, ...body });
    return json(200, { ok: true, result: methode === 'sendMessage' ? { message_id: W.naechsteMsg++ } : true });
  }
  const pfad = u.pathname.replace('/rest/v1/', '');
  if (pfad === 'rpc/tg_fahrer_liste') return json(200, FAHRER);
  if (pfad === 'rpc/tg_fahrer_suchen') {
    const q = body.p_q.toLowerCase();
    return json(200, FAHRER.filter((f) => f.name.toLowerCase().includes(q) || String(f.fahrer_nr) === q)
      .map((f) => ({ ...f, thread_id: W.tg_themen.find((t) => t.fahrer_nr === f.fahrer_nr)?.thread_id ?? null })));
  }
  if (pfad === 'rpc/tg_an_alle') {
    let n = 0;
    for (const f of FAHRER) {
      if (W.nachrichten.some((x) => x.tg_message_id === body.p_tg_message_id && x.fahrer_nr === f.fahrer_nr)) continue;
      W.nachrichten.push({ fahrer_nr: f.fahrer_nr, richtung: 'team', an_alle: true, text: body.p_text, team_name: body.p_team_name, tg_message_id: body.p_tg_message_id });
      n++;
    }
    return json(200, n);
  }
  const rows = W[pfad], treffer = filter(rows, u.searchParams);
  const m = init.method ?? 'GET';
  if (m === 'GET') return json(200, treffer.map((z) => ({ ...z })));
  if (m === 'POST') {
    if (pfad === 'nachrichten' && rows.some((x) => x.tg_message_id === body.tg_message_id && x.fahrer_nr === body.fahrer_nr)) return json(409, { code: '23505' });
    rows.push({ erstellt_am: new Date().toISOString(), ...body }); return json(201, null);
  }
  if (m === 'PATCH') { treffer.forEach((z) => Object.assign(z, body)); return json(204, null); }
  if (m === 'DELETE') { W[pfad] = rows.filter((z) => !treffer.includes(z)); return json(204, null); }
  throw new Error('Methode fehlt');
};
await import('../supabase/functions/telegram-webhook/index.ts');

const senden = (update, secret = SECRET) => handler(new Request('http://f', { method: 'POST',
  headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(update) }));
const klick = (daten, von = { id: 9, first_name: 'Boyko' }, message_id = 3) =>
  senden({ update_id: 1, callback_query: { id: 'cb' + Math.random(), data: daten, from: { is_bot: false, ...von }, message: { message_id, chat: { id: G } } } });
const antwort = (aufId, text, von = { id: 9, first_name: 'Boyko' }, message_id = 500) =>
  senden({ update_id: 2, message: { message_id, chat: { id: G, type: 'supergroup' }, from: { is_bot: false, ...von }, text,
    reply_to_message: { message_id: aufId, from: { id: BOT, is_bot: true } } } });
const letzte = (methode) => W.tg.filter((c) => c.methode === methode).at(-1);

test('ohne richtiges Secret: 401', async () => {
  neueWelt();
  assert.equal((await senden({ update_id: 1 }, 'falsch')).status, 401);
});

test('an alle: Aufforderung, Entwurf, Vorschau, Senden – jeder Fahrer genau einmal', async () => {
  neueWelt();
  await klick('menue:alle');
  const auf = letzte('sendMessage');
  assert.match(auf.text, /schreib die Nachricht an alle Fahrer/);
  assert.equal(auf.reply_markup.force_reply, true); assert.equal(auf.reply_markup.selective, true);
  const promptId = 1000;
  assert.equal(W.tg_menue[0].prompt_message_id, promptId);
  await antwort(promptId, 'Morgen Kontrolle am Flughafen');
  const vor = letzte('sendMessage');
  assert.equal(vor.text, '📢 An 2 Fahrer senden?\n\n„Morgen Kontrolle am Flughafen“');
  assert.deepEqual(vor.reply_markup.inline_keyboard[0].map((k) => k.callback_data), ['alle:ok:1000', 'alle:nein:1000']);
  assert.equal(W.nachrichten.length, 0, 'vor dem Bestaetigen nichts verschickt');
  await klick('alle:ok:1000', { id: 9, first_name: 'Boyko' }, 1001);
  assert.equal(W.nachrichten.length, 2);
  assert.ok(W.nachrichten.every((n) => n.an_alle && n.team_name === 'Boyko' && n.text === 'Morgen Kontrolle am Flughafen'));
  assert.equal(letzte('editMessageText').text, '✅ An 2 Fahrer geschickt (von Boyko):\n„Morgen Kontrolle am Flughafen“');
  assert.equal(W.tg_menue.length, 0);
  // Doppelklick: nichts doppelt, kein "An 0 Fahrer"
  const edits = W.tg.filter((c) => c.methode === 'editMessageText').length;
  await klick('alle:ok:1000', { id: 9, first_name: 'Boyko' }, 1001);
  assert.equal(W.nachrichten.length, 2);
  assert.equal(W.tg.filter((c) => c.methode === 'editMessageText').length, edits);
});

test('an alle: nur der Klicker darf antworten und bestaetigen', async () => {
  neueWelt();
  await klick('menue:alle');
  await antwort(1000, 'Von Stefan', { id: 77, first_name: 'Stefan' });
  assert.equal(W.tg_menue[0].entwurf ?? null, null, 'Antwort von jemand anderem zaehlt nicht');
  await antwort(1000, 'Von Boyko');
  await klick('alle:ok:1000', { id: 77, first_name: 'Stefan' }, 1001);
  assert.equal(W.nachrichten.length, 0);
  assert.equal(letzte('answerCallbackQuery').text, 'Nur Boyko kann das senden');
});

test('an alle: Abbrechen und abgelaufen', async () => {
  neueWelt();
  await klick('menue:alle');
  await antwort(1000, 'Doch nicht');
  await klick('alle:nein:1000', { id: 9, first_name: 'Boyko' }, 1001);
  assert.equal(letzte('editMessageText').text, '✖ Abgebrochen');
  assert.equal(W.nachrichten.length, 0); assert.equal(W.tg_menue.length, 0);
  await klick('alle:ok:1000', { id: 9, first_name: 'Boyko' }, 1001);
  assert.equal(letzte('answerCallbackQuery').text, 'Abgelaufen – bitte neu über das Menü');
  // aelter als 24 h
  await klick('menue:alle');
  const p = W.tg_menue.at(-1);
  await antwort(p.prompt_message_id, 'Alt');
  p.erstellt_am = new Date(Date.now() - 25 * 3600e3).toISOString();
  await klick('alle:ok:' + p.prompt_message_id);
  assert.equal(W.nachrichten.length, 0);
  assert.equal(letzte('answerCallbackQuery').text, 'Abgelaufen – bitte neu über das Menü');
});

test('Fahrer finden: Treffer als Link ins Thema, sonst Hinweis', async () => {
  neueWelt();
  await klick('menue:suche');
  await antwort(1000, 'murad');
  const t = letzte('sendMessage');
  assert.deepEqual(t.reply_markup.inline_keyboard, [[{ text: '🚕 Murad Izrailov · #200 · W-1TX', url: 'https://t.me/c/4453022013/13' }]]);
  assert.equal(W.tg_menue.length, 0);
  await klick('menue:suche');
  await antwort(W.tg_menue[0].prompt_message_id, 'xyz');
  assert.equal(letzte('sendMessage').text, 'Kein Fahrer gefunden.');
});

test('Info-Knopf und unbekannte Antworten', async () => {
  neueWelt();
  await klick('menue:info');
  assert.match(letzte('sendMessage').text, /So funktioniert's/);
  const vorher = W.tg.length;
  await antwort(4242, 'Antwort auf irgendeine Bot-Nachricht');
  assert.equal(W.tg.length, vorher, 'nichts passiert');
  assert.equal(W.nachrichten.length, 0);
});

test('Team-Nachricht im Fahrer-Thema wie in Teil 1 (👍)', async () => {
  neueWelt();
  await senden({ update_id: 3, message: { message_id: 70, chat: { id: G }, is_topic_message: true, message_thread_id: 13,
    from: { id: 9, is_bot: false, first_name: 'Boyko' }, text: 'Hallo Murad' } });
  assert.deepEqual(W.nachrichten.map((n) => [n.fahrer_nr, n.text, n.team_name]), [[200, 'Hallo Murad', 'Boyko']]);
  assert.equal(letzte('setMessageReaction').reaction[0].emoji, '👍');
});
