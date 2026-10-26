// node --test scripts/test-telegram-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, kuerzen, vorname, themenName, kopfPost, autoZeile, fahrerZeile, pushText, gleich, einordnen,
  menueText, menueKnoepfe, infoText, aufforderung, vorschau, vorschauKnoepfe, gesendetText, themaLink, trefferKnoepfe, knopfLesen,
  dauerText, anhangZeile, anhangPruefen }
  from '../supabase/functions/_shared/telegram-logik.ts';

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

test('pushText: immer "Büro", nie der Name des Teammitglieds; Klartext, max 120', () => {
  assert.equal(pushText('Fahr zur\nWerkstatt'), 'Büro: Fahr zur Werkstatt');
  assert.ok(pushText('y'.repeat(500)).length <= 120);
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
  // seit Teil 2 werden Knopf-Klicks ausgewertet – ohne Gruppen-Chat bleiben sie ignoriert
  assert.deepEqual(einordnen({ update_id: 3, callback_query: {} }, G), { art: 'ignorieren', grund: 'fremder chat' });
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

// ---------------- Teil 2: Menue ----------------
const BOT = 8960907965;
const knopf = (x) => ({ update_id: 5, callback_query: { id: 'cb1', data: 'menue:alle', from: { id: 9, is_bot: false, first_name: 'Boyko' },
  message: { message_id: 3, chat: { id: G, type: 'supergroup' } }, ...x } });
const allgemein = (x) => ({ update_id: 6, message: { message_id: 60, chat: { id: G, type: 'supergroup', is_forum: true },
  from: { id: 9, is_bot: false, first_name: 'Boyko' }, text: 'Morgen Kontrolle',
  reply_to_message: { message_id: 55, from: { id: BOT, is_bot: true, first_name: 'HydraLink' } }, ...x } });

test('einordnen: Knopf-Klick nur aus der Gruppe', () => {
  assert.deepEqual(einordnen(knopf({}), G, BOT), { art: 'knopf', id: 'cb1', daten: 'menue:alle', von: { id: 9, name: 'Boyko' }, message_id: 3 });
  assert.deepEqual(einordnen(knopf({ message: { message_id: 3, chat: { id: -100999 } } }), G, BOT), { art: 'ignorieren', grund: 'fremder chat' });
});

test('einordnen: Antwort in Allgemein nur auf eine Nachricht des Bots', () => {
  assert.deepEqual(einordnen(allgemein({}), G, BOT),
    { art: 'allgemein_antwort', antwort_auf: 55, text: 'Morgen Kontrolle', von: { id: 9, name: 'Boyko' }, message_id: 60 });
  assert.equal(einordnen(allgemein({ reply_to_message: { message_id: 55, from: { id: 7, is_bot: false } } }), G, BOT).art, 'ignorieren');
  assert.equal(einordnen(allgemein({ reply_to_message: { message_id: 55, from: { id: 123, is_bot: true } } }), G, BOT).art, 'ignorieren', 'anderer Bot');
  assert.equal(einordnen(allgemein({ reply_to_message: undefined }), G, BOT).art, 'ignorieren');
  assert.equal(einordnen(allgemein({ text: undefined, photo: [{}] }), G, BOT).art, 'ignorieren');
  assert.equal(einordnen(allgemein({ from: { id: 1, is_bot: true } }), G, BOT).art, 'ignorieren');
  // Themen-Nachricht bleibt wie in Teil 1
  assert.equal(einordnen(nachricht({}), G, BOT).art, 'team');
});

test('knopfLesen', () => {
  assert.deepEqual(knopfLesen('menue:alle'), { aktion: 'menue', wert: 'alle' });
  assert.deepEqual(knopfLesen('menue:info'), { aktion: 'menue', wert: 'info' });
  assert.deepEqual(knopfLesen('alle:ok:123'), { aktion: 'alle_ok', id: 123 });
  assert.deepEqual(knopfLesen('alle:nein:123'), { aktion: 'alle_nein', id: 123 });
  assert.deepEqual(knopfLesen('start:201'), { aktion: 'start', nr: 201 });
  assert.equal(knopfLesen('start:abc'), null);
  assert.equal(knopfLesen('menue:boese'), null);
  assert.equal(knopfLesen('alle:ok:x'), null);
  assert.equal(knopfLesen(undefined), null);
});

test('Menue, Info, Aufforderung', () => {
  assert.match(menueText(), /Fahrer-Chat/);
  assert.deepEqual(menueKnoepfe().inline_keyboard.map((z) => z[0].callback_data), ['menue:alle', 'menue:suche', 'menue:info']);
  assert.match(infoText(), /👍/); assert.match(infoText(), /👀/);
  assert.match(infoText(), /Fotos und Sprachnachrichten kommen beim Fahrer an/);
  assert.equal(aufforderung('alle', '<Bo>', 9), '📢 <a href="tg://user?id=9">&lt;Bo&gt;</a>, schreib die Nachricht an alle Fahrer (als Antwort hierauf):');
  assert.equal(aufforderung('suche', 'Bo', 9), '🔎 <a href="tg://user?id=9">Bo</a>, Name, Fahrer-Nr. oder Kennzeichen? (als Antwort hierauf)');
});

test('Vorschau und Bestaetigung: escaped, Knoepfe mit Id, Laenge begrenzt', () => {
  assert.equal(vorschau('a < b', 54), '📢 An 54 Fahrer senden?\n\n„a &lt; b“');
  assert.ok(vorschau('&'.repeat(2000), 54).length <= 4096);
  assert.deepEqual(vorschauKnoepfe(77).inline_keyboard[0].map((k) => k.callback_data), ['alle:ok:77', 'alle:nein:77']);
  assert.equal(gesendetText(54, 'Boyko', 'Hi'), '✅ An 54 Fahrer geschickt (von Boyko):\n„Hi“');
});

test('Themen-Link und Treffer-Knoepfe', () => {
  assert.equal(themaLink(-1004453022013, 13), 'https://t.me/c/4453022013/13');
  const k = trefferKnoepfe([{ fahrer_nr: 200, name: 'Murad Izrailov', kennzeichen: 'W-1TX', thread_id: 13 },
                           { fahrer_nr: 201, name: 'Ohne Thema', kennzeichen: null, thread_id: null }], -1004453022013);
  // ohne Thema: Knopf "Chat starten" – das Thema entsteht erst beim Klick (Themen fuer alle wurde am 26.10. verworfen)
  assert.deepEqual(k.inline_keyboard, [[{ text: '🚕 Murad Izrailov · #200 · W-1TX', url: 'https://t.me/c/4453022013/13' }],
                                       [{ text: '💬 Chat starten: Ohne Thema · #201', callback_data: 'start:201' }]]);
});

test('pushText an alle', () => {
  assert.equal(pushText('Kontrolle', true), 'Büro (an alle): Kontrolle');
  assert.equal(pushText('Kontrolle', false), 'Büro: Kontrolle');
});

// ---------------- Teil 3: Fotos und Sprachnachrichten ----------------
test('einordnen: Foto (groesste Aufloesung) und Sprache im Fahrer-Thema', () => {
  const foto = nachricht({ text: undefined, caption: ' Schaden hinten ', photo: [{ file_id: 'klein', width: 90 }, { file_id: 'gross', width: 1280 }] });
  assert.deepEqual(einordnen(foto, G), { art: 'team', thread_id: 7, message_id: 50, text: 'Schaden hinten', team_name: 'Boyko', anhang: 'foto', file_id: 'gross' });
  const ohneCaption = nachricht({ text: undefined, photo: [{ file_id: 'p', width: 800 }] });
  assert.equal(einordnen(ohneCaption, G).text, '');
  assert.deepEqual(einordnen(nachricht({ text: undefined, voice: { file_id: 'v', duration: 7 } }), G),
    { art: 'team', thread_id: 7, message_id: 50, text: '', team_name: 'Boyko', anhang: 'sprache', file_id: 'v', dauer: 7 });
  assert.equal(einordnen(nachricht({ text: undefined, audio: { file_id: 'a', duration: 30 } }), G).anhang, 'sprache');
  for (const x of [{ video: {} }, { document: {} }, { sticker: {} }, { video_note: {} }, { animation: {} }])
    assert.deepEqual(einordnen(nachricht({ text: undefined, ...x }), G), { art: 'ohne_text', thread_id: 7 });
  assert.ok(!('anhang' in einordnen(nachricht({}), G)), 'Text-Nachricht unveraendert');
});

test('dauerText und Push-Text fuer Anhaenge', () => {
  assert.equal(dauerText(7), '0:07'); assert.equal(dauerText(75), '1:15'); assert.equal(dauerText(null), '');
  assert.equal(pushText('', false, 'foto'), 'Büro: 📷 Foto');
  assert.equal(pushText('schau mal', false, 'foto'), 'Büro: 📷 Foto – schau mal');
  assert.equal(pushText('', false, 'sprache', 12), 'Büro: 🎤 Sprachnachricht (0:12)');
  assert.equal(pushText('', true, 'foto'), 'Büro (an alle): 📷 Foto');
});

test('anhangZeile: Bildunterschrift fuer Telegram, escaped, max 1024', () => {
  assert.equal(anhangZeile(MAX, 'foto', ''), '<b>Max:</b> 📷');
  assert.equal(anhangZeile(MAX, 'sprache', 'a<b'), '<b>Max:</b> 🎤 a&lt;b');
  assert.ok(anhangZeile(MAX, 'foto', '&'.repeat(2000)).length <= 1024);
});

test('anhangPruefen: Art, Typ, Groesse, Dauer', () => {
  assert.equal(anhangPruefen('foto', 'image/jpeg', 300000), null);
  assert.equal(anhangPruefen('foto', 'image/png', 300000), null);
  assert.deepEqual(anhangPruefen('foto', 'application/pdf', 1000), { code: 415, fehler: 'Nur Fotos (JPEG, PNG, HEIC)' });
  assert.deepEqual(anhangPruefen('foto', 'image/jpeg', 6 * 1024 * 1024), { code: 413, fehler: 'Datei zu groß (höchstens 5 MB)' });
  assert.equal(anhangPruefen('sprache', 'audio/mp4', 200000, 30), null);
  assert.equal(anhangPruefen('sprache', 'audio/webm;codecs=opus', 200000, 30), null);
  assert.equal(anhangPruefen('sprache', 'audio/ogg; codecs=opus', 200000, 30), null);
  assert.deepEqual(anhangPruefen('sprache', 'audio/mp4', 200000, 181), { code: 413, fehler: 'Sprachnachricht zu lang (höchstens 3 Minuten)' });
  assert.deepEqual(anhangPruefen('sprache', 'image/jpeg', 1000, 3), { code: 415, fehler: 'Nur Sprachaufnahmen' });
  assert.deepEqual(anhangPruefen('video', 'video/mp4', 1000), { code: 415, fehler: 'Unbekannte Art' });
  assert.deepEqual(anhangPruefen('foto', 'image/jpeg', 0), { code: 415, fehler: 'Leere Datei' });
});
