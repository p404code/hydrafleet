// Datenbank-Test fuer die Fahrer-Nachrichten, lokal in PGlite – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-nachrichten.mjs
//
// Nachbau der benutzten Tabellen/Funktionen (Stand 22.10.2026, nur noetige Spalten), pg_net/Vault/pg_cron als Attrappe.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const basis = process.env.PGLITE;
if (!basis) { console.error('PGLITE fehlt – siehe Kopf dieser Datei.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(basis, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const migration = readFileSync(new URL('../migrations/2026-10-22-fahrer-nachrichten.sql', import.meta.url), 'utf8');
const migration2 = () => readFileSync(new URL('../migrations/2026-10-26-nachrichten-menue.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../migrations/2026-10-26-nachrichten-buero.sql', import.meta.url), 'utf8');

await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
create function public.is_app_user() returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'app_role') in ('admin','user'), false) $$;
create table public.fahrer (id integer primary key, name text not null, kennzeichen text, aktiv boolean default true, notion_fahrer_id integer);
create table public.fahrer_app_zugang (notion_fahrer_id integer primary key, auth_user_id uuid not null, gesperrt boolean default false);
create function public.mein_fahrer_id() returns integer language sql stable security definer set search_path = public as $$
  select min(f.id) from public.fahrer f
  join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id and z.auth_user_id = auth.uid() and not z.gesperrt
  where f.aktiv and coalesce(auth.jwt()->'app_metadata'->>'fahrer_nr', '') ~ '^[0-9]{1,9}$'
    and f.notion_fahrer_id = (auth.jwt()->'app_metadata'->>'fahrer_nr')::integer
  having count(*) = 1 $$;
create function public.fahrer_app_ziel(p_fahrer_id integer) returns integer language sql stable security definer set search_path = public as $$
  select case when p_fahrer_id is not null and public.is_app_user() then (select f.id from public.fahrer f where f.id = p_fahrer_id)
              when public.is_app_user() then null else public.mein_fahrer_id() end $$;
-- wie live (Spalten), Fahrzeug vereinfacht: Modell fest
create function public.fahrer_app_profil(p_fahrer_id integer default null)
returns table (fahrer_id integer, fahrer_nr integer, name text, kennzeichen text, mietmodell text, fahrzeug_modell text,
               vorschau boolean, nr_eindeutig boolean, app_zugang text, fahrzeug_vin text, fahrzeug_bild text)
language sql stable security definer set search_path = public as $$
  select f.id, f.notion_fahrer_id, f.name, f.kennzeichen, null::text,
         case when f.kennzeichen is null then null else 'Toyota Corolla' end,
         (p_fahrer_id is not null and public.is_app_user()), true, 'aktiv', null::text, null::text
  from public.fahrer f where f.id = public.fahrer_app_ziel(p_fahrer_id) $$;
create function public.kennzeichen_key(t text) returns text language sql immutable as $$
  select regexp_replace(upper(split_part(coalesce(t, ''), '(', 1)), '[^A-Z0-9]', '', 'g') $$;   -- wie live
create table public.fuhrpark (kennzeichen_key text primary key, modell text);
insert into public.fuhrpark values ('W1111TX', 'Toyota Corolla'), ('W2222TX', 'Skoda Octavia');
grant usage on schema public, auth to anon, authenticated, service_role;
-- Attrappen: pg_net merkt sich die Aufrufe, Vault liefert einen Schluessel, pg_cron eine Job-Tabelle
create schema net;
create table net.aufrufe (nr serial, url text, headers jsonb, body jsonb);
grant usage on schema net to service_role; grant select on net.aufrufe to service_role;   -- nur fuer die Pruef-Hilfe aufrufe()
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}',
  timeout_milliseconds integer default 5000) returns bigint language sql as $$
  insert into net.aufrufe (url, headers, body) values (url, headers, body) returning nr::bigint $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('service_role_key', 'test-schluessel');
create schema cron;
create table cron.job (jobid serial, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid::bigint $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  delete from cron.job where jobname = job_name returning true $$;

-- id != Notion-Nr. (wie live); 3 = alte Zeile derselben Person (inaktiv); 4 ohne Auto
insert into public.fahrer values (1, 'Anna Fahr', 'W-1111TX', true, 101), (2, 'Bert Fahr', 'W-2222TX', true, 102),
                                 (3, 'Anna Alt', 'W-9999TX', false, 101), (4, 'Cem Ohne', null, true, 103),
                                 (5, 'Dora Gesperrt', 'W-5555TX', true, 104);
insert into public.fahrer_app_zugang values (101, '00000000-0000-0000-0000-000000000101', false),
                                            (102, '00000000-0000-0000-0000-000000000102', false),
                                            (103, '00000000-0000-0000-0000-000000000103', false),
                                            (104, '00000000-0000-0000-0000-000000000104', true);
`);
await db.exec(migration);
await db.exec(migration);   // zweimal einspielen geht

const als = (claims) => db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false); set role authenticated;`);
const raus = () => db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
const ANNA = { sub: '00000000-0000-0000-0000-000000000101', app_metadata: { fahrer_nr: '101' } };
const BERT = { sub: '00000000-0000-0000-0000-000000000102', app_metadata: { fahrer_nr: '102' } };
const CEM = { sub: '00000000-0000-0000-0000-000000000103', app_metadata: { fahrer_nr: '103' } };
const BUERO = { sub: '00000000-0000-0000-0000-000000000900', app_metadata: { app_role: 'user', app_name: 'Stefan' } };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const nein = async (sql, p, muster) => assert.rejects(db.query(sql, p), (e) => { assert.match(e.message, muster); return true; });
const ENDPUNKT = 'https://fcm.googleapis.com/fcm/send/abc123';
const P256 = 'B' + 'x'.repeat(86), AUTH = 'a'.repeat(22);

try {
  // --- Anna schreibt: Zeile mit Kopf-Snapshot, Trigger ruft telegram-senden
  await als(ANNA);
  const [{ id: n1 }] = await q(`select public.fahrer_app_nachricht_senden('  Ich hab Problem mit den Reifen  ') id`);
  await raus();
  let [z] = await q('select * from public.nachrichten where id = $1', [n1]);
  assert.equal(z.fahrer_nr, 101); assert.equal(z.richtung, 'fahrer'); assert.equal(z.text, 'Ich hab Problem mit den Reifen');
  assert.deepEqual(z.kopf, { name: 'Anna Fahr', fahrer_nr: 101, kennzeichen: 'W-1111TX', modell: 'Toyota Corolla' });
  let [a] = await q('select * from net.aufrufe order by nr desc limit 1');
  assert.match(a.url, /\/functions\/v1\/telegram-senden$/); assert.deepEqual(a.body, { id: Number(n1) });
  assert.equal(a.headers.Authorization, 'Bearer test-schluessel');

  // --- ohne Auto: Kopf ohne Kennzeichen/Modell
  await als(CEM);
  const [{ id: c1 }] = await q(`select public.fahrer_app_nachricht_senden('Hallo') id`);
  await raus();
  [z] = await q('select kopf from public.nachrichten where id = $1', [c1]);
  assert.deepEqual(z.kopf, { name: 'Cem Ohne', fahrer_nr: 103, kennzeichen: null, modell: null });

  // --- Textpruefung und Rechte
  await als(ANNA);
  await nein(`select public.fahrer_app_nachricht_senden('   ')`, [], /leer/);
  await nein(`select public.fahrer_app_nachricht_senden(null)`, [], /leer/);
  await nein(`select public.fahrer_app_nachricht_senden(repeat('x', 2001))`, [], /zu lang/);
  await q(`select public.fahrer_app_nachricht_senden(repeat('ä', 2000))`);   // 2000 Zeichen gehen (Umlaute zaehlen einfach)
  await nein(`insert into public.nachrichten (fahrer_nr, richtung, text) values (101, 'team', 'x')`, [], /permission denied/);
  await nein(`update public.nachrichten set text = 'x'`, [], /permission denied/);
  assert.equal((await q('select count(*)::int n from public.nachrichten'))[0].n, 0, 'Fahrer liest die Tabelle nicht direkt');
  await nein(`select * from public.tg_themen`, [], /permission denied/);
  await nein(`select * from public.push_abos`, [], /permission denied/);
  await nein(`select * from public.tg_thema_reservieren(101)`, [], /permission denied/);
  await nein(`select public.nachrichten_nr(1)`, [], /permission denied/);

  // --- Anna sieht nur ihre eigenen, auch mit fremder p_fahrer_id
  let v = await q('select * from public.fahrer_app_nachrichten()');
  assert.equal(v.length, 2); assert.equal(v[0].text, 'Ich hab Problem mit den Reifen');
  v = await q('select * from public.fahrer_app_nachrichten(2)');
  assert.equal(v.length, 2); assert.ok(v.every((m) => m.richtung === 'fahrer'));
  await als(BERT);
  assert.equal((await q('select * from public.fahrer_app_nachrichten()')).length, 0);
  assert.equal((await q('select * from public.fahrer_app_nachrichten(1)')).length, 0, 'Bert liest Anna nicht');

  // --- Spam-Limit: 10 in 10 Minuten (Anna hat schon 2)
  await als(ANNA);
  for (let i = 0; i < 8; i++) await q(`select public.fahrer_app_nachricht_senden('Nr ' || $1)`, [i]);
  await nein(`select public.fahrer_app_nachricht_senden('eine zu viel')`, [], /Zu viele Nachrichten/);
  await als(BERT);
  await q(`select public.fahrer_app_nachricht_senden('Bert geht noch')`);   // Limit gilt je Fahrer

  // --- Buero: Vorschau lesen ja, senden nein, Tabelle lesen ja
  await als(BUERO);
  await nein(`select public.fahrer_app_nachricht_senden('Büro')`, [], /nur der Fahrer/);
  assert.equal((await q('select * from public.fahrer_app_nachrichten(1)')).length, 10);
  assert.equal((await q('select * from public.fahrer_app_nachrichten()')).length, 0, 'ohne Vorschau-Id nichts');
  assert.ok((await q('select count(*)::int n from public.nachrichten'))[0].n >= 12);
  assert.equal((await q('select public.fahrer_app_nachrichten_gelesen() n'))[0].n, 0);
  await nein(`select public.fahrer_app_push_abo($1, $2, $3)`, [ENDPUNKT, P256, AUTH], /Vorschau/);

  // --- anon darf nichts
  await raus(); await db.exec('set role anon');
  await nein(`select * from public.fahrer_app_nachrichten()`, [], /permission denied/);
  await nein(`select public.fahrer_app_nachricht_senden('x')`, [], /permission denied/);
  await raus();

  // --- Team-Antworten (schreibt telegram-webhook als service_role): Trigger ruft push-senden, Duplikat abgewiesen
  await db.exec('set role service_role');
  const [{ id: t1 }] = await q(`insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id)
                                values (101, 'team', 'Welcher Reifen?', 'Boyko', 555) returning id`);
  await nein(`insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id) values (101, 'team', 'x', 'Boyko', 555)`,
             [], /duplicate key|unique/);
  await q(`insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id) values (101, 'team', 'Vorne links?', 'Stefan', 556)`);
  await raus();
  [a] = await q(`select * from net.aufrufe where body = $1`, [{ id: Number(t1) }]);
  assert.match(a.url, /\/functions\/v1\/push-senden$/);

  // --- gelesen: nur eigene Team-Nachrichten
  await als(BERT);
  assert.equal((await q('select public.fahrer_app_nachrichten_gelesen() n'))[0].n, 0);
  await als(ANNA);
  v = await q('select * from public.fahrer_app_nachrichten()');
  assert.deepEqual(v.slice(-2).map((m) => [m.richtung, m.team_name, m.gelesen_am]), [['team', 'Boyko', null], ['team', 'Stefan', null]]);
  assert.equal((await q('select public.fahrer_app_nachrichten_gelesen() n'))[0].n, 2);
  assert.equal((await q('select public.fahrer_app_nachrichten_gelesen() n'))[0].n, 0);
  v = await q('select * from public.fahrer_app_nachrichten()');
  assert.ok(v.slice(-2).every((m) => m.gelesen_am));

  // --- hoechstens 50, aelteste zuerst, die neuesten
  await raus(); await db.exec('set role service_role');
  await q(`insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id, erstellt_am)
           select 102, 'team', 'T' || g, 'Boyko', 1000 + g, now() - interval '1 day' + g * interval '1 second' from generate_series(1, 60) g`);
  await raus();
  await als(BERT);
  v = await q('select * from public.fahrer_app_nachrichten()');
  assert.equal(v.length, 50); assert.equal(v[v.length - 1].text, 'Bert geht noch'); assert.equal(v[0].text, 'T12');

  // --- Push-Abo: Upsert, Geraet wechselt den Fahrer, nur echte Push-Dienste
  await als(ANNA);
  await q(`select public.fahrer_app_push_abo($1, $2, $3)`, [ENDPUNKT, P256, AUTH]);
  await q(`select public.fahrer_app_push_abo($1, $2, $3)`, [ENDPUNKT, P256, AUTH]);
  await nein(`select public.fahrer_app_push_abo($1, $2, $3)`, ['https://boese.example/x', P256, AUTH], /Push-Adresse/);
  await nein(`select public.fahrer_app_push_abo($1, $2, $3)`, ['http://fcm.googleapis.com/x', P256, AUTH], /Push-Adresse/);
  await nein(`select public.fahrer_app_push_abo($1, $2, $3)`, ['https://fcm.googleapis.com.boese.example/x', P256, AUTH], /Push-Adresse/);
  await nein(`select public.fahrer_app_push_abo($1, $2, $3)`, [ENDPUNKT, 'kurz', AUTH], /Schlüssel/);
  await q(`select public.fahrer_app_push_abo($1, $2, $3)`, ['https://web.push.apple.com/QGuQ', P256, AUTH]);
  await als(BERT);
  await q(`select public.fahrer_app_push_abo($1, $2, $3)`, [ENDPUNKT, P256, AUTH]);
  await raus();
  assert.deepEqual((await q('select fahrer_nr, endpoint from public.push_abos order by id')).map((r) => [r.fahrer_nr, r.endpoint]),
                   [[102, ENDPUNKT], [101, 'https://web.push.apple.com/QGuQ']]);

  // --- Thema reservieren: einmal anlegen, sonst warten bzw. vorhandenes liefern, Haenger nach 2 Minuten uebernehmen
  await db.exec('set role service_role');
  let [r] = await q('select * from public.tg_thema_reservieren(101)');
  assert.deepEqual([r.thread_id, r.reserviert], [null, true]);
  [r] = await q('select * from public.tg_thema_reservieren(101)');
  assert.deepEqual([r.thread_id, r.reserviert], [null, false], 'zweiter Aufruf wartet');
  await q(`update public.tg_themen set thread_id = 77, name = 'Anna', kennzeichen = 'W-1111TX' where fahrer_nr = 101`);
  [r] = await q('select * from public.tg_thema_reservieren(101)');
  assert.deepEqual([Number(r.thread_id), r.kennzeichen, r.reserviert], [77, 'W-1111TX', false]);
  await q(`insert into public.tg_themen (fahrer_nr, erstellt_am) values (102, now() - interval '3 minutes')`);
  [r] = await q('select * from public.tg_thema_reservieren(102)');
  assert.equal(r.reserviert, true, 'haengende Reservierung uebernommen');
  await raus();

  // --- Trigger-Fehler blockiert das Speichern nicht
  await db.exec(`create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$
    begin raise exception 'pg_net kaputt'; end $$;`);
  await als(CEM);
  await q(`select public.fahrer_app_nachricht_senden('trotzdem gespeichert')`);
  await raus();
  assert.equal((await q(`select count(*)::int n from public.nachrichten where text = 'trotzdem gespeichert'`))[0].n, 1);

  // --- Nachhol-Lauf eingeplant
  const [job] = await q(`select * from cron.job where jobname = 'nachrichten-nachholen'`);
  assert.equal(job.schedule, '*/5 * * * *'); assert.match(job.command, /"nachholen": true/);

  // ===================== Teil 2: Menue, Themen fuer alle, Gelesen =====================
  await db.exec(`create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}',
    timeout_milliseconds integer default 5000) returns bigint language sql as $$
    insert into net.aufrufe (url, headers, body) values (url, headers, body) returning nr::bigint $$;`);
  await db.exec(migration2());
  await db.exec(migration2());   // zweimal einspielen geht
  const aufrufe = async (fn) => (await q(`select body from net.aufrufe where url like '%/' || $1 order by nr`, [fn])).map((x) => x.body);

  await db.exec('set role service_role');
  // berechtigte Fahrer: aktiv, Zugang nicht gesperrt, Nr. eindeutig – mit Kopf aus dem Fuhrpark
  const liste = await q('select * from public.tg_fahrer_liste()');
  assert.deepEqual(liste.map((x) => x.fahrer_nr).sort(), [101, 102, 103]);
  assert.deepEqual(liste.find((x) => x.fahrer_nr === 101), { fahrer_nr: 101, name: 'Anna Fahr', kennzeichen: 'W-1111TX', modell: 'Toyota Corolla' });
  assert.equal(liste.find((x) => x.fahrer_nr === 103).modell, null);
  // Suche: Name, Nr., Kennzeichen ohne Strich; gesperrte nie; Thema mitliefern
  const such = async (t) => (await q('select * from public.tg_fahrer_suchen($1)', [t])).map((x) => x.fahrer_nr);
  assert.deepEqual(await such('anna'), [101]);
  assert.deepEqual(await such('FAHR'), [101, 102]);
  assert.deepEqual(await such('102'), [102]);
  assert.deepEqual(await such('w1111'), [101]);
  assert.deepEqual(await such('xyz'), []);
  assert.deepEqual(await such('dora'), []);
  assert.deepEqual(await such('  '), []);
  assert.equal(Number((await q(`select thread_id from public.tg_fahrer_suchen('anna')`))[0].thread_id), 77);
  // an alle: eine Zeile je berechtigtem Fahrer, doppelt = nichts, Push je Fahrer
  const pushVorher = (await aufrufe('push-senden')).length;
  assert.equal((await q(`select public.tg_an_alle('Morgen Kontrolle', 'Boyko', 900) n`))[0].n, 3);
  assert.equal((await q(`select public.tg_an_alle('Morgen Kontrolle', 'Boyko', 900) n`))[0].n, 0, 'Doppelklick legt nichts doppelt an');
  const alle = await q(`select fahrer_nr, richtung, an_alle, team_name, text from public.nachrichten where tg_message_id = 900 order by fahrer_nr`);
  assert.deepEqual(alle.map((x) => [x.fahrer_nr, x.richtung, x.an_alle, x.team_name, x.text]),
    [[101, 'team', true, 'Boyko', 'Morgen Kontrolle'], [102, 'team', true, 'Boyko', 'Morgen Kontrolle'], [103, 'team', true, 'Boyko', 'Morgen Kontrolle']]);
  assert.equal((await aufrufe('push-senden')).length - pushVorher, 3);
  await nein(`select public.tg_an_alle('   ', 'Boyko', 901)`, [], /leer/);
  // neue Team-Nachricht mit Telegram-Id (fuer die Gelesen-Pruefung)
  const [{ id: t700 }] = await q(`insert into public.nachrichten (fahrer_nr, richtung, text, team_name, tg_message_id) values (101, 'team', 'Neu', 'Stefan', 700) returning id`);
  await raus();

  // App: zugestellt / an alle
  await als(ANNA);
  v = await q('select * from public.fahrer_app_nachrichten()');
  const anAlle = v.find((m) => m.an_alle);
  assert.ok(anAlle && anAlle.richtung === 'team' && anAlle.zugestellt === true);
  // Fahrer sieht nie, wer im Buero geantwortet hat (Betreiber 26.10.) – nur "Büro"
  assert.ok(v.filter((m) => m.richtung === 'team').every((m) => m.team_name === 'Büro'), JSON.stringify(v.filter((m) => m.richtung === 'team')));
  assert.ok(v.filter((m) => m.richtung === 'fahrer').every((m) => m.team_name === null));
  assert.ok(v.filter((m) => m.richtung === 'fahrer').every((m) => m.zugestellt === false), 'ohne tg_message_id: noch nicht zugestellt');
  await raus();
  await q(`update public.nachrichten set tg_message_id = 4711 where id = (select max(id) from public.nachrichten where fahrer_nr = 101 and richtung = 'fahrer')`);
  await als(ANNA);
  v = await q('select * from public.fahrer_app_nachrichten()');
  assert.equal(v.filter((m) => m.richtung === 'fahrer' && m.zugestellt).length, 1);

  // Gelesen: Trigger meldet nur normale Team-Nachrichten mit Telegram-Id, nicht "an alle"
  await raus();
  const gelesenVorher = (await aufrufe('telegram-senden')).filter((b) => b.gelesen).length;
  await als(ANNA);
  assert.equal((await q('select public.fahrer_app_nachrichten_gelesen() n'))[0].n, 2);   // 700 + an-alle-Zeile
  await raus();
  const gelesen = (await aufrufe('telegram-senden')).filter((b) => b.gelesen).slice(gelesenVorher);
  assert.deepEqual(gelesen, [{ gelesen: Number(t700) }]);

  // Rechte und Zeitplan
  await als(ANNA);
  await nein(`select * from public.tg_fahrer_liste()`, [], /permission denied/);
  await nein(`select * from public.tg_fahrer_suchen('a')`, [], /permission denied/);
  await nein(`select public.tg_an_alle('x', 'y', 1)`, [], /permission denied/);
  await nein(`select * from public.tg_menue`, [], /permission denied/);
  await raus();
  const [job2] = await q(`select * from cron.job where jobname = 'themen-pflegen'`);
  assert.equal(job2.schedule, '*/5 * * * *'); assert.match(job2.command, /"themen": true/);

  console.log('Nachrichten: alle Pruefungen bestanden');
} finally {
  await db.close();
}
