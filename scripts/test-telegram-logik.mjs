// node --test scripts/test-telegram-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, kuerzen, vorname, themenName, kopfPost, autoZeile, fahrerZeile, pushText, gleich, einordnen } from '../supabase/functions/_shared/telegram-logik.ts';

const MAX = { name: 'Max Mustermann', fahrer_nr: 123, kennzeichen: 'W-1234TX', modell: 'Toyota Corolla' };
const G = -1001234567890;
const nachricht = (x) => ({ update_id: 1, message: { message_id: 50, chat: { id: G, type: 'supergroup', is_forum: true },
  is_topic_message: true, message_thread_id: 7, from: { id: 9, is_bot: false, first_name: 'Boyko' }, text: 'Fahr zur Werkstatt', ...x } });

test('esc: < > & werden escaped, Anfuehrungszeichen bleiben', () => {
  assert.equal(esc('<b>Tom & "Jerry"</b>'), '&lt;b&gt;Tom &amp; "Jerry"&lt;/b&gt;');
  assert.equal(esc(null), '');
});

test('kuerzen: zaehlt UTF-16, zerschneidet kein Emoji', () => {
  assert.equal(kuerzen('abc', 3), 'abc');
  assert.equal(kuerzen('abcdef', 4), 'abc…');
  assert.equal(kuerzen('ab🚕cd', 4), 'ab…');      // 🚕 = 2 Einheiten, passt nicht mehr mit …
  assert.ok(kuerzen('x'.repeat(5000), 2000).length <= 2000);
});

test('themenName: mit und ohne Auto, max 128', () => {
  assert.equal(themenName(MAX), '🚕 Max Mustermann · #123 · W-1234TX');
  assert.equal(themenName({ name: 'Cem  Ohne', fahrer_nr: 5, kennzeichen: null }), '🚕 Cem Ohne · #5');
  assert.equal(themenName({ name: '', fahrer_nr: null }), '🚕 Fahrer');
  const lang = themenName({ name: 'A'.repeat(300), fahrer_nr: 1 });
  assert.ok(lang.length <= 128 && lang.endsWith('…'));
});

test('kopfPost und autoZeile: escaped, ohne Auto ohne Autozeile', () => {
  assert.equal(kopfPost(MAX), '🚕 <b>Max Mustermann</b> · #123\nW-1234TX · Toyota Corolla\nAlles, was ihr in diesem Thema schreibt, geht an Max in die App.');
  assert.equal(kopfPost({ name: '<Ali>', fahrer_nr: 8 }), '🚕 <b>&lt;Ali&gt;</b> · #8\nAlles, was ihr in diesem Thema schreibt, geht an &lt;Ali&gt; in die App.');
  assert.equal(autoZeile({ kennzeichen: 'W-5521TX', modell: 'Škoda <Octavia>' }), '🚗 Fahrzeug jetzt W-5521TX · Škoda &lt;Octavia&gt;');
  assert.equal(vorname('  Max   Mustermann'), 'Max');
});

test('fahrerZeile: escaped und nie ueber 4096, kein zerschnittenes &amp;', () => {
  assert.equal(fahrerZeile(MAX, 'a < b & c'), '<b>Max:</b> a &lt; b &amp; c');
  const s = fahrerZeile(MAX, '&'.repeat(2000));
  assert.ok(s.length <= 4096, String(s.length));
  assert.doesNotMatch(s.replace(/&amp;/g, ''), /&/);
});

test('pushText: Name + Text, Klartext, max 120', () => {
  assert.equal(pushText('Boyko', 'Fahr zur\nWerkstatt'), 'Boyko: Fahr zur Werkstatt');
  assert.equal(pushText(null, 'x'), 'Büro: x');
  assert.ok(pushText('B', 'y'.repeat(500)).length <= 120);
});

test('gleich: Secret-Vergleich', () => {
  assert.ok(gleich('abc', 'abc'));
  assert.ok(!gleich('abc', 'abd') && !gleich('abc', 'ab') && !gleich('', ''));
});

test('einordnen: nur Text von Menschen in einem Thema der Gruppe', () => {
  assert.deepEqual(einordnen(nachricht({}), G), { art: 'team', thread_id: 7, message_id: 50, text: 'Fahr zur Werkstatt', team_name: 'Boyko' });
  assert.equal(einordnen(nachricht({}), String(G)).art, 'team');
  assert.deepEqual(einordnen(nachricht({ chat: { id: -100999 } }), G), { art: 'ignorieren', grund: 'fremder chat' });
  assert.deepEqual(einordnen(nachricht({ is_topic_message: undefined, message_thread_id: undefined }), G), { art: 'ignorieren', grund: 'allgemein' });
  assert.deepEqual(einordnen(nachricht({ from: { id: 1, is_bot: true, first_name: 'HydraBot' } }), G), { art: 'ignorieren', grund: 'bot' });
  assert.deepEqual(einordnen(nachricht({ forum_topic_created: { name: 'x' }, text: undefined }), G), { art: 'ignorieren', grund: 'service' });
  assert.deepEqual(einordnen(nachricht({ text: undefined, photo: [{}], caption: 'Schaden' }), G), { art: 'ohne_text', thread_id: 7 });
  assert.deepEqual(einordnen(nachricht({ text: '   ' }), G), { art: 'ohne_text', thread_id: 7 });
  assert.deepEqual(einordnen({ update_id: 2, edited_message: nachricht({}).message }, G), { art: 'ignorieren', grund: 'kein message' });
  assert.deepEqual(einordnen({ update_id: 3, callback_query: {} }, G), { art: 'ignorieren', grund: 'kein message' });
});

test('einordnen: anonymer Admin zaehlt als Team, Name aus der Signatur', () => {
  const anonym = nachricht({ from: { id: 1087968824, is_bot: true, first_name: 'Group' }, sender_chat: { id: G, type: 'supergroup' } });
  assert.deepEqual(einordnen(anonym, G), { art: 'team', thread_id: 7, message_id: 50, text: 'Fahr zur Werkstatt', team_name: 'Büro' });
  assert.equal(einordnen(nachricht({ ...anonym.message, author_signature: 'Stefan' }), G).team_name, 'Stefan');
});

test('einordnen: Text wird auf 2000 gekuerzt', () => {
  const e = einordnen(nachricht({ text: 'z'.repeat(3000) }), G);
  assert.equal(e.art, 'team'); assert.ok(e.text.length <= 2000);
});
