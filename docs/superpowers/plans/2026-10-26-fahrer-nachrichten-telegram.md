# Fahrer-Nachrichten über Telegram – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat zwischen Fahrer (Fahrerapp, Reiter „Nachrichten“) und Büro (Telegram-Team-Gruppe, ein Thema je Fahrer), Antworten kommen mit Web-Push in der App an.

**Architecture:** Fahrer-RPC schreibt `nachrichten` → Trigger (pg_net) → Edge Function `telegram-senden` postet ins Thema des Fahrers (legt es beim ersten Mal an). Telegram → Edge Function `telegram-webhook` (Secret-Header) speichert Team-Nachrichten aus Fahrer-Themen → Trigger → Edge Function `push-senden` (Web-Push, eigene aes128gcm/VAPID-Implementierung mit WebCrypto). Fahrerapp liest per RPC, lädt alle 15 s neu, solange der Chat offen ist.

**Tech Stack:** Supabase Postgres (RLS, security-definer-RPCs, pg_net, pg_cron, Vault), Supabase Edge Functions (Deno), Telegram Bot API (Forum Topics), Web Push (RFC 8291/8292), Vanilla JS (`fahrer/index.html`, `sw.js`). Tests: PGlite (`/tmp/pglite`), `node --test` (Node 25 importiert `.ts` direkt).

**Spec:** `docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md`

## Global Constraints

- Schlüssel überall ist die **Notion-Fahrer-Nr.** (`fahrer.notion_fahrer_id`, in den Tabellen `fahrer_nr`), nie `fahrer.id` (nicht stabil, ids 626–3127 bei 69 Fahrern).
- Kein Bot-Token, kein Service-Key, kein privater VAPID-Key im Frontend, im Repo oder im Klartext in Tabellen. Fehlermeldungen von `fetch()` an `api.telegram.org` nie weiterreichen (die URL enthält das Token).
- Text 1–2000 Zeichen (nach `btrim`); Spam-Limit: höchstens 10 Fahrer-Nachrichten in 10 Minuten.
- Telegram: nur die eine Gruppen-ID (`TELEGRAM_GRUPPE_ID`), Webhook nur mit `X-Telegram-Bot-Api-Secret-Token`, alles nach Telegram HTML-escaped (`parse_mode: HTML`). Themen-Name max. 128, Nachricht max. 4096 Zeichen.
- „Allgemein“ und alles außerhalb von Fahrer-Themen wird nie gespeichert und nie geloggt. In Telegram wird nichts gelöscht.
- Projekt `pkxcwfkfaaorwnbdmylg`. Edge Functions mit `verify_jwt = true`, einzige Ausnahme `telegram-webhook` (`false`).
- Migrationen und Edge-Function-Deploys erst nach ausdrücklichem OK des Betreibers im Gespräch (Auto-Mode blockiert sonst). Die Migration wird ihm vorher gezeigt.
- Frontend geht live erst per Push auf `main` – das macht der Betreiber: `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`.
- Deutsche UI-Texte; Fahrerapp-Design: bestehende Tokens (`--surface`, `--text`, `--accent`, …), keine neuen Farben, keine Schatten.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Token in Fehlermeldungen** – Deno-`fetch` meldet Netzfehler mit voller URL (`…/bot<TOKEN>/sendMessage`); landet das in `nachrichten.tg_fehler` (Büro liest die Tabelle) oder im Log, ist der Bot übernommen. Erwartung: `tg()` wirft nur eigene Texte. Gesichert durch Code-Review-Schritt in Task 4/5 (grep).
2. **Anonyme Admins** – wer in der Gruppe als Admin „anonym bleiben“ eingestellt hat, schreibt als `GroupAnonymousBot` (`from.is_bot = true`, `sender_chat` = Gruppe). Erwartung: zählt trotzdem als Team-Nachricht. Test in Task 2.
3. **Gerät wechselt den Fahrer** (Handy weitergegeben, anderer Fahrer meldet sich an) – Erwartung: Push geht an den, der zuletzt angemeldet war, nie an beide. Test in Task 1 (Upsert verschiebt das Abo) und `pushStatus()` meldet das Abo je Sitzung neu (Task 8).
4. **Thema in Telegram gelöscht oder geschlossen** – Erwartung: nächste Fahrer-Nachricht kommt trotzdem an (geschlossen → wieder geöffnet, gelöscht → neues Thema). Live-Test in Task 7.
5. **Telegram wiederholt einen Webhook** (Antwort zu langsam, 500) – Erwartung: Team-Nachricht genau einmal beim Fahrer. Test in Task 1 (Unique-Index) + Function behandelt 409 als Erfolg (Task 5).

## Dateien

| Datei | Zweck |
|---|---|
| `migrations/2026-10-22-fahrer-nachrichten.sql` (neu) | Tabellen `nachrichten`, `tg_themen`, `push_abos`, RPCs, Trigger, Nachhol-Lauf |
| `scripts/test-nachrichten.mjs` (neu) | DB-Test in PGlite |
| `supabase/functions/_shared/telegram-logik.ts` (neu) | Reine Logik: Escape, Themen-Name, Kopf-Post, Update einordnen, Push-Text |
| `scripts/test-telegram-logik.mjs` (neu) | Tests dazu |
| `supabase/functions/_shared/webpush.ts` (neu) | aes128gcm + VAPID mit WebCrypto, `pushSenden()` |
| `scripts/test-webpush.mjs` (neu) | RFC-8291-Testvektor, Gegenprobe mit node:crypto, VAPID-Signatur |
| `supabase/functions/telegram-senden/index.ts` (neu) | Fahrer-Nachricht ins Thema |
| `supabase/functions/telegram-webhook/index.ts` (neu) | Team-Nachricht aus dem Thema speichern |
| `supabase/functions/push-senden/index.ts` (neu) | Web-Push an die Geräte des Fahrers |
| `scripts/telegram-einrichten.mjs` (neu) | Gruppe finden/prüfen, Secrets setzen, Webhook setzen |
| `sw.js` (ändern) | `push`, `notificationclick`, Cache-Version |
| `fahrer/index.html` (ändern) | Reiter Nachrichten: Chat, Badge, Senden, Benachrichtigungen |
| `CLAUDE.md` (ändern) | Abschnitt „Nachrichten“ |

Vorbereitung (einmalig, außerhalb des Repos): `ls /tmp/pglite/node_modules/@electric-sql/pglite/dist/index.js || npm i --prefix /tmp/pglite @electric-sql/pglite`

---

### Task 1: Datenbank – Tabellen, RPCs, Trigger, Nachhol-Lauf

**Files:**
- Create: `migrations/2026-10-22-fahrer-nachrichten.sql`
- Test: `scripts/test-nachrichten.mjs`

**Interfaces:**
- Consumes (bestehend, live): `is_app_user()`, `mein_fahrer_id()`, `fahrer_app_ziel(int)`, `fahrer_app_profil(int)` (Spalten `fahrer_nr, name, kennzeichen, fahrzeug_modell`), Vault-Secret `service_role_key`, `net.http_post`, `cron.schedule`.
- Produces:
  - Tabelle `nachrichten(id bigint, fahrer_nr int, richtung 'fahrer'|'team', text, kopf jsonb {name, fahrer_nr, kennzeichen, modell}, team_name, tg_message_id bigint, tg_versuche int, tg_fehler, gelesen_am, erstellt_am)`; unique `tg_message_id` für `richtung='team'` (Duplikat → PostgREST 409).
  - Tabelle `tg_themen(fahrer_nr int PK, thread_id bigint unique null, name, kennzeichen, erstellt_am)`.
  - Tabelle `push_abos(id, fahrer_nr, endpoint unique, p256dh, auth, erstellt_am)`.
  - RPC `fahrer_app_nachrichten(p_fahrer_id int default null)` → `(id, richtung, text, team_name, erstellt_am, gelesen_am)`, älteste zuerst, max. 50.
  - RPC `fahrer_app_nachricht_senden(p_text text)` → `bigint`; Fehlertexte `Nachricht ist leer`, `Nachricht ist zu lang (höchstens 2000 Zeichen)`, `Zu viele Nachrichten – bitte kurz warten`, `Nachrichten senden kann nur der Fahrer selbst`.
  - RPC `fahrer_app_nachrichten_gelesen()` → `int` (Anzahl).
  - RPC `fahrer_app_push_abo(p_endpoint, p_p256dh, p_auth)` → `void`; Fehler `Push-Adresse ungültig`, `Push-Schlüssel ungültig`, `In der Vorschau nicht möglich`.
  - RPC `tg_thema_reservieren(p_fahrer_nr int)` → `(thread_id bigint, name, kennzeichen, reserviert boolean)`, nur `service_role`.
  - Trigger: Insert `fahrer` → POST `functions/v1/telegram-senden` `{id}`; Insert `team` → POST `functions/v1/push-senden` `{id}`.
  - Cron `nachrichten-nachholen` (`*/5 * * * *`) → POST `telegram-senden` `{"nachholen": true}`, nur wenn etwas offen ist.

- [ ] **Step 1: Test schreiben** – `scripts/test-nachrichten.mjs`:

```js
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
grant usage on schema public, auth to anon, authenticated, service_role;
-- Attrappen: pg_net merkt sich die Aufrufe, Vault liefert einen Schluessel, pg_cron eine Job-Tabelle
create schema net;
create table net.aufrufe (nr serial, url text, headers jsonb, body jsonb);
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
                                 (3, 'Anna Alt', 'W-9999TX', false, 101), (4, 'Cem Ohne', null, true, 103);
insert into public.fahrer_app_zugang values (101, '00000000-0000-0000-0000-000000000101', false),
                                            (102, '00000000-0000-0000-0000-000000000102', false),
                                            (103, '00000000-0000-0000-0000-000000000103', false);
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

  console.log('Nachrichten: alle Pruefungen bestanden');
} finally {
  await db.close();
}
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `PGLITE=/tmp/pglite node scripts/test-nachrichten.mjs`
Expected: FAIL mit `ENOENT … migrations/2026-10-22-fahrer-nachrichten.sql`

- [ ] **Step 3: Migration schreiben** – `migrations/2026-10-22-fahrer-nachrichten.sql`:

```sql
-- Fahrer-Nachrichten ueber Telegram: Fahrer schreibt in der App, das Buero antwortet in seinem Telegram-Thema.
-- Spec: docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md
-- Schluessel ist die Notion-Fahrer-Nr. (fahrer.id ist nicht stabil, der n8n-Sync legt Zeilen neu an).
-- Kein Protokoll-Trigger: das Buero schreibt hier nicht (nur Fahrer-RPCs und service_role).

create table if not exists public.nachrichten (
  id            bigint generated always as identity primary key,
  fahrer_nr     integer not null,
  richtung      text not null check (richtung in ('fahrer', 'team')),
  text          text not null check (char_length(btrim(text)) between 1 and 2000),
  kopf          jsonb,                       -- Snapshot {name, fahrer_nr, kennzeichen, modell} beim Senden
  team_name     text,                        -- Telegram-Vorname des Teammitglieds
  tg_message_id bigint,                      -- fahrer: Post des Bots; team: Nachricht des Teammitglieds
  tg_versuche   integer not null default 0,
  tg_fehler     text,
  gelesen_am    timestamptz,
  erstellt_am   timestamptz not null default now()
);
create index if not exists nachrichten_fahrer_zeit on public.nachrichten (fahrer_nr, erstellt_am desc);
-- Telegram wiederholt Webhooks: dieselbe Team-Nachricht nur einmal
create unique index if not exists nachrichten_team_tg_einmal on public.nachrichten (tg_message_id) where richtung = 'team';
create index if not exists nachrichten_offen on public.nachrichten (id) where richtung = 'fahrer' and tg_message_id is null;

-- Ein Telegram-Thema je Fahrer. thread_id null = wird gerade angelegt (Reservierung)
create table if not exists public.tg_themen (
  fahrer_nr   integer primary key,
  thread_id   bigint unique,
  name        text,
  kennzeichen text,
  erstellt_am timestamptz not null default now()
);

create table if not exists public.push_abos (
  id          bigint generated always as identity primary key,
  fahrer_nr   integer not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  erstellt_am timestamptz not null default now()
);
create index if not exists push_abos_fahrer on public.push_abos (fahrer_nr);

alter table public.nachrichten enable row level security;
alter table public.tg_themen enable row level security;
alter table public.push_abos enable row level security;
revoke all on public.nachrichten, public.tg_themen, public.push_abos from public, anon, authenticated;
grant select on public.nachrichten to authenticated;
drop policy if exists nachrichten_buero_liest on public.nachrichten;
create policy nachrichten_buero_liest on public.nachrichten for select to authenticated using (public.is_app_user());
grant all on public.nachrichten, public.tg_themen, public.push_abos to service_role;

-- Notion-Nr. des Ziels (Fahrer selbst oder Buero-Vorschau), null wenn keiner
create or replace function public.nachrichten_nr(p_fahrer_id integer) returns integer
language sql stable security definer set search_path = public as $$
  select f.notion_fahrer_id from public.fahrer f where f.id = public.fahrer_app_ziel(p_fahrer_id)
$$;

-- Nur echte Push-Dienste (sonst koennte ein Fahrer push-senden an beliebige Adressen schicken lassen)
create or replace function public.push_endpoint_erlaubt(p text) returns boolean
language sql immutable as $$
  select coalesce(p, '') ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
$$;

create or replace function public.fahrer_app_nachrichten(p_fahrer_id integer default null)
returns table (id bigint, richtung text, text text, team_name text, erstellt_am timestamptz, gelesen_am timestamptz)
language sql stable security definer set search_path = public as $$
  select x.id, x.richtung, x.text, x.team_name, x.erstellt_am, x.gelesen_am
  from (select n.* from public.nachrichten n
        where n.fahrer_nr = public.nachrichten_nr(p_fahrer_id)
        order by n.erstellt_am desc, n.id desc limit 50) x
  order by x.erstellt_am, x.id
$$;

create or replace function public.fahrer_app_nachricht_senden(p_text text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_p    record;
  v_id   bigint;
begin
  if public.is_app_user() or public.mein_fahrer_id() is null then
    raise exception 'Nachrichten senden kann nur der Fahrer selbst' using errcode = '42501';
  end if;
  select * into v_p from public.fahrer_app_profil(null) limit 1;
  if v_p.fahrer_nr is null then
    raise exception 'Nachrichten senden kann nur der Fahrer selbst' using errcode = '42501';
  end if;
  if char_length(v_text) = 0 then raise exception 'Nachricht ist leer'; end if;
  if char_length(v_text) > 2000 then raise exception 'Nachricht ist zu lang (höchstens 2000 Zeichen)'; end if;
  if (select count(*) from public.nachrichten n
      where n.fahrer_nr = v_p.fahrer_nr and n.richtung = 'fahrer' and n.erstellt_am > now() - interval '10 minutes') >= 10 then
    raise exception 'Zu viele Nachrichten – bitte kurz warten';
  end if;
  insert into public.nachrichten (fahrer_nr, richtung, text, kopf)
  values (v_p.fahrer_nr, 'fahrer', v_text, jsonb_build_object(
    'name', v_p.name, 'fahrer_nr', v_p.fahrer_nr,
    'kennzeichen', nullif(btrim(coalesce(v_p.kennzeichen, '')), ''),
    'modell', nullif(btrim(coalesce(v_p.fahrzeug_modell, '')), '')))
  returning nachrichten.id into v_id;
  return v_id;
end $$;

create or replace function public.fahrer_app_nachrichten_gelesen() returns integer
language plpgsql security definer set search_path = public as $$
declare v_nr integer; v_n integer;
begin
  if public.is_app_user() then return 0; end if;          -- Vorschau setzt nichts
  v_nr := public.nachrichten_nr(null);
  if v_nr is null then return 0; end if;
  update public.nachrichten set gelesen_am = now()
   where fahrer_nr = v_nr and richtung = 'team' and gelesen_am is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.fahrer_app_push_abo(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare v_nr integer;
begin
  if public.is_app_user() then raise exception 'In der Vorschau nicht möglich' using errcode = '42501'; end if;
  v_nr := public.nachrichten_nr(null);
  if v_nr is null then raise exception 'Nachrichten nur für Fahrer' using errcode = '42501'; end if;
  if not public.push_endpoint_erlaubt(p_endpoint) then raise exception 'Push-Adresse ungültig'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_=-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_=-]{16,32}$' then
    raise exception 'Push-Schlüssel ungültig';
  end if;
  -- ein Geraet gehoert immer dem zuletzt angemeldeten Fahrer
  insert into public.push_abos (fahrer_nr, endpoint, p256dh, auth) values (v_nr, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set fahrer_nr = excluded.fahrer_nr, p256dh = excluded.p256dh,
                                       auth = excluded.auth, erstellt_am = now();
end $$;

-- Atomar: nur wer reserviert, legt das Thema in Telegram an (zwei schnelle Nachrichten -> ein Thema).
-- Haengt eine Reservierung > 2 Minuten (Function abgebrochen), darf sie neu uebernommen werden.
create or replace function public.tg_thema_reservieren(p_fahrer_nr integer)
returns table (thread_id bigint, name text, kennzeichen text, reserviert boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  insert into public.tg_themen (fahrer_nr) values (p_fahrer_nr) on conflict (fahrer_nr) do nothing;
  if found then return query select null::bigint, null::text, null::text, true; return; end if;
  update public.tg_themen t set erstellt_am = now()
   where t.fahrer_nr = p_fahrer_nr and t.thread_id is null and t.erstellt_am < now() - interval '2 minutes';
  if found then return query select null::bigint, null::text, null::text, true; return; end if;
  return query select t.thread_id, t.name, t.kennzeichen, false from public.tg_themen t where t.fahrer_nr = p_fahrer_nr;
end $$;

-- Neue Zeile -> Edge Function (pg_net, nach dem Commit). Darf das Speichern nie blockieren.
create or replace function public.nachrichten_weiterleiten() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/'
             || case new.richtung when 'fahrer' then 'telegram-senden' else 'push-senden' end,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := jsonb_build_object('id', new.id),
      timeout_milliseconds := 30000);
  exception when others then
    raise warning 'nachrichten_weiterleiten(%): %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists nachrichten_weiterleiten on public.nachrichten;
create trigger nachrichten_weiterleiten after insert on public.nachrichten
  for each row execute function public.nachrichten_weiterleiten();

revoke all on function public.nachrichten_nr(integer), public.tg_thema_reservieren(integer),
  public.nachrichten_weiterleiten() from public, anon, authenticated;
grant execute on function public.tg_thema_reservieren(integer) to service_role;
revoke all on function public.fahrer_app_nachrichten(integer), public.fahrer_app_nachricht_senden(text),
  public.fahrer_app_nachrichten_gelesen(), public.fahrer_app_push_abo(text, text, text) from public, anon;
grant execute on function public.fahrer_app_nachrichten(integer), public.fahrer_app_nachricht_senden(text),
  public.fahrer_app_nachrichten_gelesen(), public.fahrer_app_push_abo(text, text, text) to authenticated;

-- Nachhol-Lauf: was nach 2 Minuten nicht in Telegram ist, nochmal (die Function nimmt sie der Reihe nach)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'nachrichten-nachholen') then
    perform cron.unschedule('nachrichten-nachholen');
  end if;
  perform cron.schedule('nachrichten-nachholen', '*/5 * * * *', $job$
    select net.http_post(
      url := 'https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-senden',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"nachholen": true}'::jsonb, timeout_milliseconds := 120000)
    where exists (select 1 from public.nachrichten where richtung = 'fahrer' and tg_message_id is null
                  and tg_versuche < 5 and erstellt_am < now() - interval '2 minutes');
  $job$);
end $$;
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `PGLITE=/tmp/pglite node scripts/test-nachrichten.mjs`
Expected: `Nachrichten: alle Pruefungen bestanden`

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-10-22-fahrer-nachrichten.sql scripts/test-nachrichten.mjs
git commit -m "nachrichten: tabellen, fahrer-rpcs, trigger nach telegram/push, nachhol-lauf (schluessel notion-nr.)"
```

- [ ] **Step 6: Dem Betreiber die Migration zeigen und einspielen** – Datei im Gespräch zusammenfassen (drei neue Tabellen, vier Fahrer-RPCs, ein Trigger, ein Cron-Job; nichts Bestehendes wird geändert), auf sein OK warten. Dann per Supabase-MCP `apply_migration` (project `pkxcwfkfaaorwnbdmylg`, name `fahrer_nachrichten`, query = Dateiinhalt).

- [ ] **Step 7: Live prüfen** – per MCP `execute_sql`:

```sql
select (select count(*) from information_schema.tables where table_schema = 'public'
          and table_name in ('nachrichten', 'tg_themen', 'push_abos')) as tabellen,
       (select schedule from cron.job where jobname = 'nachrichten-nachholen') as cron,
       (select count(*) from pg_proc where proname like 'fahrer_app_nachricht%' or proname = 'fahrer_app_push_abo') as rpcs,
       has_function_privilege('anon', 'public.fahrer_app_nachrichten(integer)', 'execute') as anon_darf;
```
Expected: `tabellen = 3`, `cron = */5 * * * *`, `rpcs = 4`, `anon_darf = false`. Danach `get_advisors` (security): keine neuen Fehler zu den drei Tabellen (RLS an).

---

### Task 2: Telegram-Logik (rein, ohne Netz)

**Files:**
- Create: `supabase/functions/_shared/telegram-logik.ts`
- Test: `scripts/test-telegram-logik.mjs`

**Interfaces:**
- Produces (von Task 4–6 benutzt):
  - `type Kopf = { name?, fahrer_nr?, kennzeichen?, modell? }`
  - `type Einordnung = { art: "team"; thread_id; message_id; text; team_name } | { art: "ohne_text"; thread_id } | { art: "ignorieren"; grund }`
  - `esc(t): string`, `kuerzen(s, max): string`, `vorname(name): string`
  - `themenName(k: Kopf): string` (≤ 128), `kopfPost(k)`, `autoZeile(k)`, `fahrerZeile(k, text)` (≤ 4096, HTML)
  - `pushText(teamName, text): string` (≤ 120, Klartext)
  - `gleich(a, b): boolean` (konstante Zeit)
  - `einordnen(update, gruppeId): Einordnung`

- [ ] **Step 1: Test schreiben** – `scripts/test-telegram-logik.mjs`:

```js
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
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `node --test scripts/test-telegram-logik.mjs`
Expected: FAIL mit `Cannot find module …/_shared/telegram-logik.ts`

- [ ] **Step 3: Modul schreiben** – `supabase/functions/_shared/telegram-logik.ts` (nur löschbares TypeScript, keine Parameter-Properties/Enums – Node muss es direkt laden):

```ts
// Reine Logik fuer telegram-senden / telegram-webhook / push-senden (ohne Netz, ohne Datenbank).
// Tests: node --test scripts/test-telegram-logik.mjs

export type Kopf = { name?: string | null; fahrer_nr?: number | null; kennzeichen?: string | null; modell?: string | null };
export type Einordnung =
  | { art: "team"; thread_id: number; message_id: number; text: string; team_name: string }
  | { art: "ohne_text"; thread_id: number }
  | { art: "ignorieren"; grund: string };

// parse_mode HTML: nur diese drei Zeichen muessen escaped werden
export function esc(t: unknown): string {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const sauber = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();

// Auf max UTF-16-Einheiten kuerzen (so zaehlt Telegram), ohne ein Emoji zu zerschneiden
export function kuerzen(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const z of s) { if (out.length + z.length > max - 1) break; out += z; }
  return out + "…";
}

export function vorname(name: unknown): string {
  return sauber(name).split(" ")[0] || "Fahrer";
}

// "🚕 Max Mustermann · #123 · W-1234TX" – Telegram erlaubt 1–128 Zeichen
export function themenName(k: Kopf): string {
  const teile = [sauber(k.name) || "Fahrer"];
  if (k.fahrer_nr != null) teile.push("#" + k.fahrer_nr);
  if (sauber(k.kennzeichen)) teile.push(sauber(k.kennzeichen));
  return kuerzen("🚕 " + teile.join(" · "), 128);
}

function autoText(k: Kopf): string {
  return [sauber(k.kennzeichen), sauber(k.modell)].filter(Boolean).map(esc).join(" · ");
}

// Erster Post in einem neuen Thema
export function kopfPost(k: Kopf): string {
  const z1 = `🚕 <b>${esc(sauber(k.name) || "Fahrer")}</b>` + (k.fahrer_nr != null ? ` · #${k.fahrer_nr}` : "");
  const hinweis = `Alles, was ihr in diesem Thema schreibt, geht an ${esc(vorname(k.name))} in die App.`;
  return [z1, autoText(k), hinweis].filter(Boolean).join("\n");
}

export function autoZeile(k: Kopf): string {
  return "🚗 Fahrzeug jetzt " + autoText(k);
}

// "<b>Max:</b> Text" – hoechstens 4096 Zeichen nach dem Escapen, nie mitten in einem &amp;
export function fahrerZeile(k: Kopf, text: string): string {
  const vor = `<b>${esc(vorname(k.name))}:</b> `;
  let roh = String(text ?? "");
  let s = vor + esc(roh);
  while (s.length > 4096) { roh = kuerzen(roh, Math.floor(roh.length * 0.9)); s = vor + esc(roh); }
  return s;
}

// Push-Text: "Boyko: Fahr zur Werkstatt" (Klartext, kein HTML)
export function pushText(teamName: unknown, text: unknown): string {
  return kuerzen(`${sauber(teamName) || "Büro"}: ${sauber(text)}`, 120);
}

// Vergleich in konstanter Zeit (Webhook-Secret)
export function gleich(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const SERVICE = ["forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "new_chat_members", "left_chat_member",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "pinned_message", "migrate_from_chat_id"];

// Welches Telegram-Update ist eine Team-Nachricht an einen Fahrer? (Ob das Thema einem Fahrer gehoert, prueft die Function.)
export function einordnen(update: any, gruppeId: string | number): Einordnung {
  const m = update?.message;
  if (!m) return { art: "ignorieren", grund: "kein message" };
  if (String(m.chat?.id) !== String(gruppeId)) return { art: "ignorieren", grund: "fremder chat" };
  if (!m.is_topic_message || !m.message_thread_id) return { art: "ignorieren", grund: "allgemein" };
  if (SERVICE.some((k) => k in m)) return { art: "ignorieren", grund: "service" };
  // Anonyme Admins schreiben "als Gruppe": from = GroupAnonymousBot, sender_chat = die Gruppe
  const anonym = m.sender_chat && String(m.sender_chat.id) === String(gruppeId);
  if (!anonym && (!m.from || m.from.is_bot)) return { art: "ignorieren", grund: "bot" };
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (!text) return { art: "ohne_text", thread_id: m.message_thread_id };
  const name = anonym ? sauber(m.author_signature) || "Büro" : sauber(m.from.first_name) || "Büro";
  return { art: "team", thread_id: m.message_thread_id, message_id: m.message_id, text: kuerzen(text, 2000), team_name: name };
}
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `node --test scripts/test-telegram-logik.mjs`
Expected: `pass 10`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/telegram-logik.ts scripts/test-telegram-logik.mjs
git commit -m "nachrichten: telegram-logik (escape, themen-name, kopf-post, update einordnen) mit tests"
```

---

### Task 3: Web-Push ohne Bibliothek

**Files:**
- Create: `supabase/functions/_shared/webpush.ts`
- Test: `scripts/test-webpush.mjs`

**Interfaces:**
- Produces (von Task 6 benutzt): `type Abo = { endpoint, p256dh, auth }`, `type Vapid = { publicKey, privateKey, subject }` (base64url: 65-Byte-Punkt / 32-Byte `d`), `pushSenden(abo, nutzlast: string, v: Vapid, ttl = 86400): Promise<number>` (HTTP-Status), außerdem `verschluesseln`, `vapidKopf`, `b64u`, `vonB64u` für Tests.

Hinweis: Die Werte im ersten Test stammen aus RFC 8291, Abschnitt 5 und Anhang A (am 26.10.2026 gegen https://www.rfc-editor.org/rfc/rfc8291.txt abgeglichen). Nicht von Hand ändern.

- [ ] **Step 1: Test schreiben** – `scripts/test-webpush.mjs`:

```js
// node --test scripts/test-webpush.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { verschluesseln, vapidKopf, vonB64u, b64u } from '../supabase/functions/_shared/webpush.ts';

const te = new TextEncoder();

test('aes128gcm: genau das Beispiel aus RFC 8291 (Abschnitt 5 / Anhang A)', async () => {
  const abo = { endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const out = await verschluesseln(abo, te.encode('When I grow up, I want to be a watermelon'), {
    salt: vonB64u('DGv6ra1nlYgDCS1FRnbzlw'),
    asPublic: vonB64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    asPrivate: vonB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('aes128gcm: mit Zufallsschluesseln, unabhaengig mit node:crypto entschluesselt', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  const abo = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const nutzlast = JSON.stringify({ title: 'HYDRAlink', body: 'Boyko: Fahr zur Werkstatt – äöü 🚕' });
  const body = Buffer.from(await verschluesseln(abo, te.encode(nutzlast)));
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const ecdh = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const chiffre = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(chiffre.subarray(-16));
  const klar = Buffer.concat([d.update(chiffre.subarray(0, -16)), d.final()]);
  assert.equal(klar[klar.length - 1], 2, 'Trenner 0x02 am Ende');
  assert.equal(klar.subarray(0, -1).toString('utf8'), nutzlast);
});

test('VAPID: JWT fuer den Push-Dienst, mit dem oeffentlichen Schluessel pruefbar', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  const kopf = await vapidKopf('https://fcm.googleapis.com/fcm/send/abc', { publicKey: pub, privateKey: j.d, subject: 'mailto:sw.hydrafleet@gmail.com' }, 1000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(kopf);
  assert.ok(m, kopf);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(m[2], 'base64url')), { aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:sw.hydrafleet@gmail.com' });
  assert.equal(m[4], pub);
  assert.ok(verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `node --test scripts/test-webpush.mjs`
Expected: FAIL mit `Cannot find module …/_shared/webpush.ts`

- [ ] **Step 3: Modul schreiben** – `supabase/functions/_shared/webpush.ts`:

```ts
// Web-Push ohne Bibliothek: Verschluesselung aes128gcm (RFC 8291 / RFC 8188) und VAPID (RFC 8292), nur WebCrypto.
// Laeuft unter Deno (Edge Function push-senden) und Node (Tests: node --test scripts/test-webpush.mjs).

export type Abo = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string }; // base64url: 65-Byte-Punkt / 32-Byte d
// Nur fuer den Test mit festen Werten (RFC 8291 Anhang A); im Betrieb zufaellig
export type Fest = { salt: Uint8Array; asPublic: Uint8Array; asPrivate: Uint8Array };
const te = new TextEncoder();
export function b64u(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function vonB64u(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const r = atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="));
  return Uint8Array.from(r, (c) => c.charCodeAt(0));
}
function verbinde(...teile: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(teile.reduce((n, t) => n + t.length, 0));
  let i = 0; for (const t of teile) { out.set(t, i); i += t.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, laenge: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, laenge * 8));
}
function privatKey(d: Uint8Array, pub: Uint8Array, art: "ECDH" | "ECDSA"): Promise<CryptoKey> {
  const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: art, namedCurve: "P-256" }, false, art === "ECDH" ? ["deriveBits"] : ["sign"]);
}
export async function verschluesseln(abo: Abo, klartext: Uint8Array, fest?: Fest): Promise<Uint8Array> {
  const uaPublic = vonB64u(abo.p256dh), authSecret = vonB64u(abo.auth);
  let asPublic: Uint8Array, asKey: CryptoKey;
  if (fest) { asPublic = fest.asPublic; asKey = await privatKey(fest.asPrivate, fest.asPublic, "ECDH"); }
  else {
    const paar = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", paar.publicKey)); asKey = paar.privateKey;
  }
  const salt = fest ? fest.salt : crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKey, 256));
  const ikm = await hkdf(authSecret, ecdh, verbinde(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, verbinde(klartext, new Uint8Array([2]))));
  const kopf = new Uint8Array(86);
  kopf.set(salt, 0); new DataView(kopf.buffer).setUint32(16, 4096); kopf[20] = 65; kopf.set(asPublic, 21);
  return verbinde(kopf, chiffre);
}
export async function vapidKopf(endpoint: string, v: Vapid, jetzt = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const kopf = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const nutz = b64u(te.encode(JSON.stringify({ aud, exp: jetzt + 12 * 3600, sub: v.subject })));
  const key = await privatKey(vonB64u(v.privateKey), vonB64u(v.publicKey), "ECDSA");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${kopf}.${nutz}`)));
  return `vapid t=${kopf}.${nutz}.${b64u(sig)}, k=${v.publicKey}`;
}

// Eine Nachricht an ein Abo schicken. Rueckgabe: HTTP-Status des Push-Dienstes (404/410 = Abo tot).
export async function pushSenden(abo: Abo, nutzlast: string, v: Vapid, ttl = 86400): Promise<number> {
  const body = await verschluesseln(abo, te.encode(nutzlast));
  const r = await fetch(abo.endpoint, {
    method: "POST", body,
    headers: { Authorization: await vapidKopf(abo.endpoint, v), "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high" } });
  await r.body?.cancel();
  return r.status;
}
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `node --test scripts/test-webpush.mjs`
Expected: `pass 3`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/webpush.ts scripts/test-webpush.mjs
git commit -m "nachrichten: web-push (aes128gcm + vapid, webcrypto) mit rfc-8291-testvektor"
```

---

### Task 4: Edge Function `telegram-senden`

**Files:**
- Create: `supabase/functions/telegram-senden/index.ts`

**Interfaces:**
- Consumes: `tg_thema_reservieren` (Task 1), `themenName`, `kopfPost`, `autoZeile`, `fahrerZeile`, `Kopf` (Task 2). Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`.
- Produces: `POST /functions/v1/telegram-senden` mit `{id}` oder `{nachholen: true}` → `200 {ergebnis: [{id, ok, fehler?}]}`; `403` ohne service_role; `500 {fehler: "nicht_eingerichtet"}` ohne Secrets. Schreibt `nachrichten.tg_message_id / tg_versuche / tg_fehler`, `tg_themen`.

- [ ] **Step 1: Function schreiben** – `supabase/functions/telegram-senden/index.ts`:

```ts
// telegram-senden – Fahrer-Nachricht ins Telegram-Thema des Fahrers (Team-Gruppe); legt das Thema beim ersten Mal an.
// Nur service_role: Trigger nachrichten_weiterleiten ({id}) und Nachhol-Lauf nachrichten-nachholen ({nachholen: true}).
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_GRUPPE_ID setzt scripts/telegram-einrichten.mjs.
// Das Token steckt in der URL – Fehlermeldungen deshalb nie aus fetch() durchreichen (sie enthalten die URL).
import { autoZeile, fahrerZeile, kopfPost, themenName, type Kopf } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const patch = (pfad: string, werte: Record<string, unknown>) =>
  db(pfad, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(werte) });
const loeschen = (pfad: string) => db(pfad, { method: "DELETE", headers: { Prefer: "return=minimal" } });

// Rolle aus dem Token; die Signatur prueft das Gateway (verify_jwt = true)
function rolle(req: Request): string | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="))).role ?? null;
  } catch { return null; }
}

class TgFehler extends Error {}
async function tg(methode: string, body: Record<string, unknown>) {
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new TgFehler(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new TgFehler(`Telegram ${methode} ${j.error_code ?? r.status}: ${j.description ?? "ohne Beschreibung"}`);
  return j.result;
}
const themaWeg = (e: unknown) => e instanceof TgFehler && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.message);

async function themaAnlegen(nr: number, k: Kopf): Promise<number> {
  const name = themenName(k);
  let thread: number;
  try {
    thread = (await tg("createForumTopic", { chat_id: GRUPPE, name })).message_thread_id;
  } catch (e) {
    await loeschen(`tg_themen?fahrer_nr=eq.${nr}&thread_id=is.null`).catch(() => {});   // naechster Versuch sofort
    throw e;
  }
  await patch(`tg_themen?fahrer_nr=eq.${nr}`, { thread_id: thread, name, kennzeichen: k.kennzeichen ?? null });
  await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: kopfPost(k), parse_mode: "HTML" });
  return thread;
}

async function autoGewechselt(nr: number, thread: number, k: Kopf) {
  const name = themenName(k);
  await tg("editForumTopic", { chat_id: GRUPPE, message_thread_id: thread, name }).catch((e) => console.warn("editForumTopic", e.message));
  if (k.kennzeichen) await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: autoZeile(k), parse_mode: "HTML" });
  await patch(`tg_themen?fahrer_nr=eq.${nr}`, { name, kennzeichen: k.kennzeichen ?? null });
}

// Thema des Fahrers; gibt es keins, legt es genau ein Aufruf an (tg_thema_reservieren), die anderen warten kurz
async function themaHolen(nr: number, k: Kopf): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const [t] = await db("rpc/tg_thema_reservieren", { method: "POST", body: JSON.stringify({ p_fahrer_nr: nr }) });
    if (t.reserviert) return await themaAnlegen(nr, k);
    if (t.thread_id) {
      if ((k.kennzeichen ?? null) !== (t.kennzeichen ?? null)) await autoGewechselt(nr, t.thread_id, k);
      return t.thread_id;
    }
    await warte(1000);
  }
  throw new Error("Thema wird noch angelegt");
}

async function senden(id: number): Promise<{ id: number; ok: boolean; fehler?: string }> {
  const [n] = await db(`nachrichten?id=eq.${id}&select=id,fahrer_nr,richtung,text,kopf,tg_message_id,tg_versuche`);
  if (!n || n.richtung !== "fahrer" || n.tg_message_id) return { id, ok: true };   // nichts zu tun, doppelter Aufruf harmlos
  await patch(`nachrichten?id=eq.${id}`, { tg_versuche: n.tg_versuche + 1 });
  const k: Kopf = n.kopf ?? {};
  try {
    let msg: { message_id: number } | null = null;
    for (let versuch = 0; versuch < 2 && !msg; versuch++) {
      const thread = await themaHolen(n.fahrer_nr, k);
      // geschlossenes Thema wieder oeffnen; bei offenem meldet Telegram einen Fehler – egal
      await tg("reopenForumTopic", { chat_id: GRUPPE, message_thread_id: thread }).catch(() => {});
      try {
        msg = await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: thread, text: fahrerZeile(k, n.text),
          parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch (e) {
        if (!themaWeg(e) || versuch > 0) throw e;
        await loeschen(`tg_themen?fahrer_nr=eq.${n.fahrer_nr}`);   // Thema in Telegram geloescht: im 2. Durchgang neu anlegen
      }
    }
    await patch(`nachrichten?id=eq.${id}`, { tg_message_id: msg!.message_id, tg_fehler: null });
    return { id, ok: true };
  } catch (e) {
    const fehler = String((e as Error)?.message ?? e).slice(0, 500);
    console.warn("telegram-senden", id, fehler);
    await patch(`nachrichten?id=eq.${id}`, { tg_fehler: fehler }).catch(() => {});
    return { id, ok: false, fehler };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return antwort(405, { fehler: "nur_post" });
  if (rolle(req) !== "service_role") return antwort(403, { fehler: "nicht_berechtigt" });
  if (!TOKEN || !GRUPPE) return antwort(500, { fehler: "nicht_eingerichtet" });
  const b = await req.json().catch(() => ({}));
  let ids: number[];
  if (b?.nachholen === true) {
    const grenze = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const offen = await db(`nachrichten?richtung=eq.fahrer&tg_message_id=is.null&tg_versuche=lt.5` +
      `&erstellt_am=lt.${encodeURIComponent(grenze)}&select=id&order=id.asc&limit=20`);
    ids = offen.map((x: { id: number }) => x.id);
  } else if (Number.isInteger(b?.id)) ids = [b.id];
  else return antwort(400, { fehler: "id_fehlt" });
  const ergebnis = [];
  for (const id of ids) ergebnis.push(await senden(id));   // der Reihe nach, damit die Reihenfolge im Thema stimmt
  return antwort(200, { ergebnis });
});
```

- [ ] **Step 2: Syntax und Token-Regel prüfen**

Run: `node --check supabase/functions/telegram-senden/index.ts && grep -n 'bot\${TOKEN}' supabase/functions/telegram-senden/index.ts`
Expected: keine Syntaxfehler; genau **eine** Fundstelle, innerhalb von `tg()`, deren `catch` eine eigene Meldung wirft (kein `e.message` aus `fetch`).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/telegram-senden/index.ts
git commit -m "nachrichten: edge function telegram-senden (thema je fahrer, kopf-post, autowechsel, nachholen)"
```

- [ ] **Step 4: Deployen (nach OK des Betreibers)** – Supabase-MCP `deploy_edge_function`: name `telegram-senden`, `entrypoint_path` `index.ts`, `verify_jwt` **true**, files: `index.ts` (Dateiinhalt) und `../_shared/telegram-logik.ts` (Dateiinhalt). Danach `get_edge_function telegram-senden` – Inhalt muss der Repo-Datei entsprechen.

- [ ] **Step 5: Aufrufschutz prüfen** – ohne service_role muss 403 kommen:

```bash
ANON=$(grep -o "SUPABASE_KEY = '[^']*'" fahrer/index.html | cut -d"'" -f2)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-senden \
  -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' -d '{"id":1}'
```
Expected: `403`

---

### Task 5: Edge Function `telegram-webhook`

**Files:**
- Create: `supabase/functions/telegram-webhook/index.ts`

**Interfaces:**
- Consumes: `einordnen`, `gleich` (Task 2); Tabellen `tg_themen`, `nachrichten` (Task 1). Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`, `TELEGRAM_WEBHOOK_SECRET`.
- Produces: `POST /functions/v1/telegram-webhook` (von Telegram) → immer `200`, außer `401` (Secret falsch/fehlt) und `500` (DB nicht erreichbar → Telegram wiederholt). Schreibt `nachrichten` (`richtung 'team'`), setzt 👍.

- [ ] **Step 1: Function schreiben** – `supabase/functions/telegram-webhook/index.ts`:

```ts
// telegram-webhook – Telegram meldet Gruppennachrichten. Der Bot ist Admin („Themen verwalten“) und bekommt deshalb alle;
// gespeichert wird nur, was ein Teammitglied in ein Fahrer-Thema schreibt (nachrichten, richtung 'team').
// „Allgemein“ und alles andere wird verworfen, ohne es zu speichern oder zu loggen.
// verify_jwt = false (Telegram schickt kein Supabase-JWT); Schutz: Header X-Telegram-Bot-Api-Secret-Token.
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_GRUPPE_ID, TELEGRAM_WEBHOOK_SECRET setzt scripts/telegram-einrichten.mjs.
import { einordnen, gleich } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const GRUPPE = Deno.env.get("TELEGRAM_GRUPPE_ID") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const HINWEIS = "Fotos, Sprachnachrichten und Sticker kommen noch nicht beim Fahrer an – bitte als Text schreiben.";
const letzterHinweis = new Map<number, number>();   // je Thema; gilt nur, solange diese Instanz lebt
const leer = (s: number) => new Response(null, { status: s });

const dbRoh = (pfad: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });

// Das Token steckt in der URL – Fehlermeldungen aus fetch() nie durchreichen
async function tg(methode: string, body: Record<string, unknown>) {
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new Error(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${methode} ${j.error_code ?? r.status}: ${j.description ?? "ohne Beschreibung"}`);
  return j.result;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return leer(405);
  if (!SECRET || !gleich(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", SECRET)) return leer(401);
  let u: unknown;
  try { u = await req.json(); } catch { return leer(200); }
  const e = einordnen(u, GRUPPE);
  if (e.art === "ignorieren") return leer(200);

  const t = await dbRoh(`tg_themen?thread_id=eq.${e.thread_id}&select=fahrer_nr`);
  if (!t.ok) { console.error("telegram-webhook: tg_themen", t.status); return leer(500); }   // Telegram wiederholt
  const [thema] = await t.json();
  if (!thema) return leer(200);                          // Thema gehoert keinem Fahrer (von Hand angelegt)

  if (e.art === "ohne_text") {
    const jetzt = Date.now();
    if (jetzt - (letzterHinweis.get(e.thread_id) ?? 0) > 10 * 60 * 1000) {
      letzterHinweis.set(e.thread_id, jetzt);
      await tg("sendMessage", { chat_id: GRUPPE, message_thread_id: e.thread_id, text: HINWEIS })
        .catch((x) => console.warn("telegram-webhook: Hinweis", x.message));
    }
    return leer(200);
  }

  const r = await dbRoh("nachrichten", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ fahrer_nr: thema.fahrer_nr, richtung: "team", text: e.text, team_name: e.team_name, tg_message_id: e.message_id }) });
  const rt = await r.text();
  if (r.status === 409) return leer(200);                // schon gespeichert (Telegram hat wiederholt)
  if (!r.ok) { console.error("telegram-webhook: nachrichten", r.status, rt.slice(0, 200)); return leer(500); }
  // 👍 = beim Fahrer angekommen (gespeichert, Push ausgeloest)
  await tg("setMessageReaction", { chat_id: GRUPPE, message_id: e.message_id, reaction: [{ type: "emoji", emoji: "👍" }] })
    .catch((x) => console.warn("telegram-webhook: Reaktion", x.message));
  return leer(200);
});
```

- [ ] **Step 2: Syntax und Token-Regel prüfen**

Run: `node --check supabase/functions/telegram-webhook/index.ts && grep -n 'bot\${TOKEN}' supabase/functions/telegram-webhook/index.ts`
Expected: keine Syntaxfehler; genau eine Fundstelle in `tg()`, `catch` ohne `e.message`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/telegram-webhook/index.ts
git commit -m "nachrichten: edge function telegram-webhook (team-nachricht aus fahrer-thema, 👍, secret-header)"
```

- [ ] **Step 4: Deployen (nach OK des Betreibers)** – MCP `deploy_edge_function`: name `telegram-webhook`, `entrypoint_path` `index.ts`, `verify_jwt` **false**, files `index.ts` + `../_shared/telegram-logik.ts`. Vergleich mit `get_edge_function`.

- [ ] **Step 5: Schutz prüfen**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/telegram-webhook \
  -H 'Content-Type: application/json' -H 'X-Telegram-Bot-Api-Secret-Token: falsch' -d '{"update_id":1}'
```
Expected: `401`

---

### Task 6: Edge Function `push-senden`

**Files:**
- Create: `supabase/functions/push-senden/index.ts`

**Interfaces:**
- Consumes: `pushSenden` (Task 3), `pushText` (Task 2), Tabellen `nachrichten`, `push_abos`. Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Produces: `POST /functions/v1/push-senden` `{id}` (nur service_role) → `200 {gesendet, geloescht, abos}`. Nutzlast an den Service Worker: `{title: "HYDRAlink", body, url: "/fahrer/#nachrichten", tag: "nachrichten"}`.

- [ ] **Step 1: Function schreiben** – `supabase/functions/push-senden/index.ts`:

```ts
// push-senden – neue Team-Nachricht als Web-Push an alle Geraete des Fahrers. Nur service_role (Trigger nachrichten_weiterleiten).
// Abos, die der Push-Dienst mit 404/410 ablehnt, werden geloescht.
// Secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT setzt scripts/telegram-einrichten.mjs.
import { pushSenden } from "../_shared/webpush.ts";
import { pushText } from "../_shared/telegram-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID = { publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "", privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:sw.hydrafleet@gmail.com" };
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad.split("?")[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
function rolle(req: Request): string | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="))).role ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return antwort(405, { fehler: "nur_post" });
  if (rolle(req) !== "service_role") return antwort(403, { fehler: "nicht_berechtigt" });
  if (!VAPID.publicKey || !VAPID.privateKey) return antwort(500, { fehler: "nicht_eingerichtet" });
  const b = await req.json().catch(() => ({}));
  if (!Number.isInteger(b?.id)) return antwort(400, { fehler: "id_fehlt" });
  const [n] = await db(`nachrichten?id=eq.${b.id}&select=id,fahrer_nr,richtung,text,team_name`);
  if (!n || n.richtung !== "team") return antwort(200, { gesendet: 0 });
  const abos = await db(`push_abos?fahrer_nr=eq.${n.fahrer_nr}&select=id,endpoint,p256dh,auth`);
  const nutzlast = JSON.stringify({ title: "HYDRAlink", body: pushText(n.team_name, n.text), url: "/fahrer/#nachrichten", tag: "nachrichten" });
  let gesendet = 0, geloescht = 0;
  for (const a of abos) {
    try {
      const status = await pushSenden(a, nutzlast, VAPID);
      if (status === 404 || status === 410) { await db(`push_abos?id=eq.${a.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); geloescht++; }
      else if (status >= 200 && status < 300) gesendet++;
      else console.warn("push-senden: Abo", a.id, "Status", status);
    } catch (e) { console.warn("push-senden: Abo", a.id, (e as Error).message); }
  }
  return antwort(200, { gesendet, geloescht, abos: abos.length });
});
```

- [ ] **Step 2: Syntax prüfen**

Run: `node --check supabase/functions/push-senden/index.ts`
Expected: keine Ausgabe

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/push-senden/index.ts
git commit -m "nachrichten: edge function push-senden (web-push an alle geraete des fahrers, tote abos loeschen)"
```

- [ ] **Step 4: Deployen (nach OK des Betreibers)** – MCP `deploy_edge_function`: name `push-senden`, `entrypoint_path` `index.ts`, `verify_jwt` **true**, files `index.ts`, `../_shared/webpush.ts`, `../_shared/telegram-logik.ts`. Vergleich mit `get_edge_function`.

- [ ] **Step 5: Aufrufschutz prüfen** – wie Task 4 Step 5 mit URL `…/functions/v1/push-senden`. Expected: `403`

---

### Task 7: Einrichtungsskript, Bot verbinden, Telegram live testen

**Files:**
- Create: `scripts/telegram-einrichten.mjs`

**Interfaces:**
- Consumes: Supabase-CLI `~/.hydrafleet-supabase-cli/node_modules/.bin/supabase` (Betreiber ist eingeloggt), Bot-Token von stdin.
- Produces: Edge-Function-Secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`, `TELEGRAM_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; Telegram-Webhook → `telegram-webhook`; gibt den **öffentlichen** VAPID-Key aus (braucht Task 8).

- [ ] **Step 1: Skript schreiben** – `scripts/telegram-einrichten.mjs`:

```js
// Telegram-Bot fuer die Fahrer-Nachrichten einrichten (Spec docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md).
// Das Bot-Token kommt von stdin (Zwischenablage) und wird nie ausgegeben. Secrets setzt das Skript selbst ueber die
// Supabase-CLI (~/.hydrafleet-supabase-cli, einmal `supabase login`), ueber eine kurzlebige Datei (0600) – nie auf der Kommandozeile.
//
//   pbpaste | node scripts/telegram-einrichten.mjs pruefen [--gruppe -100…]   Bot, Webhook, Secrets (und Gruppe) anzeigen, aendert nichts
//   pbpaste | node scripts/telegram-einrichten.mjs einrichten                Gruppe finden, pruefen, Secrets setzen, Webhook setzen
//   … einrichten --gruppe -100…                                              Gruppen-ID vorgeben (wenn mehrere/keine gefunden)
//   … einrichten --neue-vapid                                                VAPID neu erzeugen (alle Push-Abos werden ungueltig!)
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJEKT = 'pkxcwfkfaaorwnbdmylg';
const WEBHOOK = `https://${PROJEKT}.supabase.co/functions/v1/telegram-webhook`;
const VAPID_SUBJECT = 'mailto:sw.hydrafleet@gmail.com';
const SECRETS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_GRUPPE_ID', 'TELEGRAM_WEBHOOK_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
const CLI = process.env.SUPABASE_CLI || join(homedir(), '.hydrafleet-supabase-cli/node_modules/.bin/supabase');
const args = process.argv.slice(2);
const schritt = args[0];
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : null; };
const raus = (t) => { console.error(t); process.exit(1); };

let TOKEN = '';
for await (const c of process.stdin) TOKEN += c;
TOKEN = TOKEN.trim();
if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(TOKEN)) raus('Kein Bot-Token auf stdin. Token von @BotFather kopieren, dann: pbpaste | node scripts/telegram-einrichten.mjs …');

// Fehler nie mit URL ausgeben – dort steckt das Token
async function tg(methode, body = {}) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { raus(`Telegram nicht erreichbar (${methode})`); }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) raus(`Telegram ${methode}: ${j.error_code ?? r.status} ${j.description ?? ''}`);
  return j.result;
}
function cliFehler(e) {
  return String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ') + '\n→ einmal im eigenen Terminal: ' + CLI + ' login';
}
function secretNamen() {
  try {
    const aus = execFileSync(CLI, ['secrets', 'list', '--project-ref', PROJEKT, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(aus).map((s) => s.name);
  } catch (e) { raus('Supabase-CLI: ' + cliFehler(e)); }
}
function secretsSetzen(werte) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-')), datei = join(dir, 'secrets.env');
  const zeile = (k, v) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  writeFileSync(datei, Object.entries(werte).map(([k, v]) => zeile(k, v)).join('\n') + '\n', { mode: 0o600 });
  try { execFileSync(CLI, ['secrets', 'set', '--project-ref', PROJEKT, '--env-file', datei], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { raus('Secrets setzen fehlgeschlagen: ' + cliFehler(e)); }
  finally { try { unlinkSync(datei); } catch {} rmSync(dir, { recursive: true, force: true }); }
  console.log('In Supabase gesetzt: ' + Object.keys(werte).join(', '));
}
function vapidErzeugen() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  return { pub, priv: j.d };
}
async function gruppeFinden() {
  if (opt('--gruppe')) return opt('--gruppe');
  const info = await tg('getWebhookInfo');
  if (info.url) await tg('deleteWebhook', { drop_pending_updates: false });   // mit Webhook liefert getUpdates nichts
  const updates = await tg('getUpdates', { allowed_updates: ['message', 'my_chat_member'], timeout: 0 });
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message ?? u.my_chat_member)?.chat;
    if (c && c.type === 'supergroup') chats.set(String(c.id), c);   // mit Themen ist die Gruppe immer eine Supergruppe
  }
  if (chats.size === 1) return [...chats.keys()][0];
  if (!chats.size) raus('Keine Gruppe gefunden. Bitte in der Team-Gruppe unter „Allgemein“ kurz etwas schreiben und nochmal starten.');
  raus('Mehrere Gruppen gefunden – bitte mit --gruppe <id> wählen:\n' + [...chats.values()].map((c) => `  ${c.id}  ${c.title}`).join('\n'));
}
async function gruppePruefen(gruppe, me) {
  const chat = await tg('getChat', { chat_id: gruppe });
  const mitglied = await tg('getChatMember', { chat_id: gruppe, user_id: me.id });
  const probleme = [];
  if (!chat.is_forum) probleme.push('In der Gruppe sind die Themen nicht eingeschaltet (Gruppeninfo → Bearbeiten → Themen).');
  if (mitglied.status !== 'administrator') probleme.push('Der Bot ist kein Admin der Gruppe.');
  else if (!mitglied.can_manage_topics) probleme.push('Dem Bot fehlt das Admin-Recht „Themen verwalten“.');
  console.log(`Gruppe: ${chat.title} (${gruppe}) · Themen ${chat.is_forum ? 'an' : 'AUS'} · Bot ${mitglied.status}`
    + (mitglied.can_manage_topics ? ' mit „Themen verwalten“' : ''));
  return probleme;
}

const me = await tg('getMe');
console.log(`Bot: @${me.username}`);

if (schritt === 'pruefen') {
  const info = await tg('getWebhookInfo');
  console.log(`Webhook: ${info.url || '(keiner)'} · wartend ${info.pending_update_count}`
    + (info.last_error_message ? ` · letzter Fehler: ${info.last_error_message}` : ''));
  if (opt('--gruppe')) {
    const p = await gruppePruefen(opt('--gruppe'), me);
    p.forEach((x) => console.log('✗ ' + x));
    if (!p.length) console.log('✓ Gruppe passt');
  }
  const namen = secretNamen();
  for (const n of SECRETS) console.log(`${namen.includes(n) ? '✓' : '✗'} ${n}`);
} else if (schritt === 'einrichten') {
  const gruppe = await gruppeFinden();
  const probleme = await gruppePruefen(gruppe, me);
  if (probleme.length) raus(probleme.join('\n'));
  const geheim = randomBytes(32).toString('hex');   // Telegram erlaubt A-Z a-z 0-9 _ -, 1–256 Zeichen
  const werte = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_GRUPPE_ID: gruppe, TELEGRAM_WEBHOOK_SECRET: geheim };
  let vapid = null;
  if (args.includes('--neue-vapid') || !secretNamen().includes('VAPID_PRIVATE_KEY')) {
    vapid = vapidErzeugen();
    Object.assign(werte, { VAPID_PUBLIC_KEY: vapid.pub, VAPID_PRIVATE_KEY: vapid.priv, VAPID_SUBJECT });
  }
  secretsSetzen(werte);
  await tg('setWebhook', { url: WEBHOOK, secret_token: geheim, allowed_updates: ['message'], drop_pending_updates: true, max_connections: 10 });
  console.log(`Webhook gesetzt: ${WEBHOOK}`);
  if (vapid) console.log(`\nVAPID (öffentlich) – in fahrer/index.html als VAPID_PUBLIC eintragen:\n${vapid.pub}`);
  else console.log('VAPID bleibt wie es ist (steht schon in fahrer/index.html).');
} else {
  raus('Schritt fehlt: pruefen | einrichten');
}
```

- [ ] **Step 2: Ohne Token muss es sauber abbrechen**

Run: `echo "" | node scripts/telegram-einrichten.mjs pruefen; echo "exit $?"`
Expected: `Kein Bot-Token auf stdin. …` und `exit 1`

- [ ] **Step 3: Commit**

```bash
git add scripts/telegram-einrichten.mjs
git commit -m "nachrichten: skript telegram-einrichten (gruppe finden/pruefen, secrets, webhook, vapid)"
```

- [ ] **Step 4: Betreiber richtet ein** – Betreiber schreibt in der Gruppe unter „Allgemein“ kurz etwas, kopiert das Bot-Token und tippt im Claude-Code-Prompt:

```
! pbpaste | node ~/Projects/hydrafleet/scripts/telegram-einrichten.mjs einrichten
```
Expected: `Gruppe: … · Themen an · Bot administrator mit „Themen verwalten“`, `In Supabase gesetzt: …`, `Webhook gesetzt: …`, VAPID-Public-Key. Den VAPID-Public-Key für Task 8 notieren (er ist öffentlich). Meldet das Skript ein Problem (Themen aus, kein Admin, Recht fehlt), Betreiber behebt es in Telegram, dann nochmal.
Danach: `! pbpaste | node ~/Projects/hydrafleet/scripts/telegram-einrichten.mjs pruefen` → Webhook-URL gesetzt, alle sechs Secrets ✓, kein „letzter Fehler“.

- [ ] **Step 5: Live-Test Telegram ohne App** (Testfahrer Nr. 999999, kein echter Fahrer) – per MCP `execute_sql`:

```sql
insert into public.nachrichten (fahrer_nr, richtung, text, kopf)
values (999999, 'fahrer', 'Test: Ich hab Problem mit den <Reifen> & so',
        '{"name":"Test Fahrer","fahrer_nr":999999,"kennzeichen":"W-0000TX","modell":"Testauto"}');
```
Expected in Telegram (≤ 10 s): neues Thema „🚕 Test Fahrer · #999999 · W-0000TX“ mit Kopf-Post und „**Test:** Ich hab Problem mit den <Reifen> & so“. In der DB: `select tg_message_id, tg_fehler from nachrichten where fahrer_nr = 999999` → `tg_message_id` gesetzt, `tg_fehler` null. Steht nach 10 s nichts da: `get_logs` (edge-function) und `tg_fehler` ansehen; „nicht_eingerichtet“ → Function neu deployen, damit sie die Secrets sieht.

- [ ] **Step 6: Live-Test Antworten** – Betreiber schreibt im Thema „Test Fahrer“ „Welcher Reifen?“, dann in „Allgemein“ „intern“, dann ein Foto ins Thema.
Expected: 👍 auf „Welcher Reifen?“; `select richtung, text, team_name from nachrichten where fahrer_nr = 999999 order by id` zeigt genau eine `team`-Zeile „Welcher Reifen?“ mit Vornamen; „intern“ steht nirgends; auf das Foto antwortet der Bot mit dem Hinweis (Text, kein Foto gespeichert).

- [ ] **Step 7: Live-Test zweite Nachricht, Autowechsel, geschlossenes/gelöschtes Thema**

```sql
insert into public.nachrichten (fahrer_nr, richtung, text, kopf)
values (999999, 'fahrer', 'Test 2: gleiches Thema', '{"name":"Test Fahrer","fahrer_nr":999999,"kennzeichen":"W-0000TX","modell":"Testauto"}');
```
Expected: im selben Thema. Dann mit `"kennzeichen":"W-1111TX"` → Thema umbenannt + „🚗 Fahrzeug jetzt W-1111TX · Testauto“. Dann Betreiber schließt das Thema in Telegram, nächste Test-Nachricht → Thema wieder offen, Nachricht da. Dann Betreiber löscht das Thema, nächste Test-Nachricht → neues Thema mit Kopf-Post.

- [ ] **Step 8: Live-Test Nachhol-Lauf** – eine Zeile anlegen, die der Trigger nicht weiterreicht (wie nach einem Ausfall), per MCP `execute_sql` in einem Aufruf:

```sql
alter table public.nachrichten disable trigger nachrichten_weiterleiten;
insert into public.nachrichten (fahrer_nr, richtung, text, kopf, erstellt_am)
values (999999, 'fahrer', 'Test: nachgeholt', '{"name":"Test Fahrer","fahrer_nr":999999}', now() - interval '3 minutes');
alter table public.nachrichten enable trigger nachrichten_weiterleiten;
```
Expected: spätestens nach 5 Minuten steht „Test: nachgeholt“ im Thema, `tg_versuche = 1`. Lehnt das MCP die `alter table`-Zeilen ab: Zeile ohne Trigger-Umweg nicht testbar → stattdessen nach dem nächsten echten Ausfall `tg_fehler`/`tg_versuche` ansehen und das im Abschlussbericht so sagen.
Testzeilen (`fahrer_nr = 999999`) bleiben stehen; sie stören niemanden (kein Fahrer hat diese Nr.).

---

### Task 8: Fahrerapp – Reiter „Nachrichten“ und Push im Service Worker

**Files:**
- Modify: `sw.js` (Cache-Version Zeile 1, Push-Handler am Ende)
- Modify: `fahrer/index.html` (CSS nach `.tab-label`, Tab-Leiste Zeile ~278, Zustand ~293–296, Routing ~577–601, Ereignisse ~945–1000, `startApp`)

**Interfaces:**
- Consumes: RPCs aus Task 1, Nutzlast aus Task 6 (`{title, body, url, tag}`), VAPID-Public-Key aus Task 7 Step 4.
- Produces: Route `#nachrichten`; Service-Worker-Nachricht `{typ: 'nachrichten'}` an offene Fahrerapp-Fenster.

- [ ] **Step 1: `sw.js`** – `CACHE_NAME` um eins erhöhen (z. B. `'hydralink-v56'` → `'hydralink-v57'`; steht inzwischen eine höhere Zahl da, diese +1) und ans Dateiende anhängen:

```js

/* Web-Push (Fahrer-Nachrichten): Text kommt von push-senden, Klick öffnet den Chat */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'HYDRAlink', {
    body: d.body || 'Neue Nachricht vom Büro',
    tag: d.tag || 'nachrichten',
    renotify: true,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    data: { url: d.url || '/fahrer/#nachrichten' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ziel = (e.notification.data && e.notification.data.url) || '/fahrer/#nachrichten';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => {
    const app = fenster.find((c) => new URL(c.url).pathname.startsWith('/fahrer'));
    if (app) { app.postMessage({ typ: 'nachrichten' }); return app.focus(); }
    return clients.openWindow(ziel);
  }));
});
```

- [ ] **Step 2: CSS** – in `fahrer/index.html` direkt nach der Zeile `.tab-label { … }` einfügen:

```css

        /* ---------- Nachrichten ---------- */
        .tab { position: relative; }
        .tab .badge { position: absolute; top: 4px; left: calc(50% + 5px); min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--err); color: #FFFFFF; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; }
        .push-karte { margin: 10px 12px 0; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; color: var(--text-mut); line-height: 1.5; }
        .push-karte .btn-ghost { height: 40px; }
        .chat { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px calc(84px + var(--safe-bot)); }
        .chat.ohne-eingabe { padding-bottom: 12px; }
        .chat .empty { margin: 12px 0 0; }
        .chat-tag { align-self: center; font-size: 10.5px; font-weight: 600; color: var(--text-mut); margin: 10px 0 2px; }
        .bubble { max-width: 82%; padding: 7px 10px 5px; border-radius: 10px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
        .bubble.ich { align-self: flex-end; background: var(--text); color: var(--bg); border-bottom-right-radius: 3px; }
        .bubble.team { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 3px; }
        .bubble .wer { display: block; font-size: 11px; font-weight: 700; color: var(--accent); margin-bottom: 1px; white-space: normal; }
        .bubble .zeit { display: block; font-size: 10px; opacity: .6; text-align: right; margin-top: 2px; white-space: normal; }
        .bubble.wartet { opacity: .55; }
        .composer { position: fixed; left: 0; right: 0; bottom: calc(54px + var(--safe-bot)); z-index: 19; padding: 8px 12px; background: var(--surface); border-top: 1px solid var(--border); }
        .composer-row { display: flex; gap: 6px; align-items: flex-end; }
        .composer-err { color: var(--err); font-size: 12px; font-weight: 500; }
        .composer-err:not(:empty) { margin-bottom: 6px; }
        .composer textarea { flex: 1; min-width: 0; height: 40px; max-height: 120px; resize: none; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface-2); color: var(--text); font-family: inherit; font-size: 16px; line-height: 1.3; padding: 9px 10px; outline: none; }
        .composer textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-faint); }
        .composer .btn-primary { height: 40px; width: auto; flex-shrink: 0; }
```

- [ ] **Step 3: Tab freischalten** – die Zeile `<span class="tab off" aria-disabled="true" title="Kommt bald">…<span class="tab-label">Nachrichten</span><span class="soon">bald</span></span>` ersetzen durch:

```html
            <a class="tab" href="#nachrichten" data-tab="nachrichten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"></path></svg><span class="tab-label">Nachrichten</span><span class="badge" id="naBadge" hidden></span></a>
```

- [ ] **Step 4: Zustand** – in der Zeile `const S = { … st: stLeer() };` vor `};` ergänzen: `, na: naLeer(), push: null, pushFehler: false, aboGemeldet: false`. Nach `function stLeer() { … }` einfügen:

```js
        function naLeer() { return { rows: [], wartend: [], err: false, loadedAt: 0, loading: false, nochmal: false }; }
```

- [ ] **Step 5: Routing** – in `route()` die Liste `['start', 'abrechnung', 'offen', 'kontakt', 'mehr', 'lohnzettel', 'fahrzeug', 'strafen', 'bank']` um `'nachrichten'` ergänzen; in `TAB_FOR` `nachrichten: 'nachrichten'` ergänzen; in der View-Tabelle in `render()` `nachrichten: viewNachrichten` ergänzen. Am Ende von `render()` (nach der `forEach`-Schleife über die Tabs) einfügen:

```js
            badgeSetzen();
            if (r.name === 'nachrichten') naGeoeffnet();
```

- [ ] **Step 6: Laden beim Start und Scrollen** – in `startApp()` nach dem letzten `render();` einfügen: `ladenNachrichten();`. Den Listener `window.addEventListener('hashchange', function() { render(); window.scrollTo(0, 0); });` ersetzen durch:

```js
        window.addEventListener('hashchange', function() { render(); if (route().name !== 'nachrichten') window.scrollTo(0, 0); });
```

- [ ] **Step 7: Klick „Benachrichtigungen aktivieren“** – im Klick-Listener (`document.addEventListener('click', …)`) nach `else if (act === 'pdf') { … }` ergänzen:

```js
            else if (act === 'push') { e.preventDefault(); pushAktivieren(t); }
```

- [ ] **Step 8: Chat-Code** – direkt vor `/* ---------- Ereignisse ---------- */` einfügen und in `VAPID_PUBLIC` den Key aus Task 7 Step 4 eintragen:

```js
        /* ---------- Nachrichten (Chat mit dem Büro, Spec 2026-10-22-fahrer-nachrichten-telegram) ---------- */
        // Öffentlicher VAPID-Schlüssel (gibt scripts/telegram-einrichten.mjs aus). Leer = Benachrichtigungen noch nicht eingerichtet.
        const VAPID_PUBLIC = '';
        function naAlt() { return !S.na.loadedAt || Date.now() - S.na.loadedAt > 15 * 1000; }
        async function ladenNachrichten() {
            if (!S.profil) return;
            if (S.na.loading) { S.na.nochmal = true; return; }
            S.na.loading = true;
            const arg = S.mode === 'vorschau' ? { p_fahrer_id: S.vorschauId } : null;
            try {
                const r = await (arg ? sb.rpc('fahrer_app_nachrichten', arg) : sb.rpc('fahrer_app_nachrichten')).then(x => x, e => ({ error: e }));
                if (r.error) { S.na.err = true; console.warn('Nachrichten:', r.error); }
                else { S.na.rows = r.data || []; S.na.err = false; S.na.loadedAt = Date.now(); }
            } finally { S.na.loading = false; }
            badgeSetzen();
            if (route().name === 'nachrichten') { listeZeichnen(); gelesenMelden(); }
            if (S.na.nochmal) { S.na.nochmal = false; ladenNachrichten(); }
        }
        function ungelesen() { return S.na.rows.filter(m => m.richtung === 'team' && !m.gelesen_am).length; }
        function badgeSetzen() {
            const b = document.getElementById('naBadge');
            if (!b) return;
            const n = S.mode === 'fahrer' ? ungelesen() : 0;
            b.hidden = n === 0;
            b.textContent = n > 9 ? '9+' : String(n);
        }
        async function gelesenMelden() {
            if (S.mode !== 'fahrer' || !ungelesen()) return;
            const r = await sb.rpc('fahrer_app_nachrichten_gelesen').then(x => x, e => ({ error: e }));
            if (r.error) return;
            const jetzt = new Date().toISOString();
            S.na.rows.forEach(m => { if (m.richtung === 'team' && !m.gelesen_am) m.gelesen_am = jetzt; });
            badgeSetzen();
        }
        function wienTag(d) { return d.toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' }); }
        function tagText(ts) {
            const t = wienTag(new Date(ts));
            if (t === wienTag(new Date())) return 'Heute';
            if (t === wienTag(new Date(Date.now() - 864e5))) return 'Gestern';
            return t;
        }
        function uhrzeit(ts) { return new Date(ts).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' }); }
        function chatHtml() {
            const rows = S.na.rows.concat(S.na.wartend);
            if (!rows.length && S.na.err) return '<div class="empty"><b>Nachrichten konnten nicht geladen werden</b><span>Bitte Internetverbindung prüfen.</span></div>';
            if (!rows.length && !S.na.loadedAt) return '<div class="note" style="text-align:center">Lade …</div>';
            if (!rows.length) return '<div class="empty"><b>Noch keine Nachrichten</b><span>Schreib uns – das Büro antwortet hier.</span></div>';
            let tag = '', out = '';
            rows.forEach(function (m) {
                const t = tagText(m.erstellt_am);
                if (t !== tag) { tag = t; out += '<div class="chat-tag">' + esc(t) + '</div>'; }
                const ich = m.richtung === 'fahrer';
                out += '<div class="bubble ' + (ich ? 'ich' : 'team') + (m.wartet ? ' wartet' : '') + '">'
                    + (ich ? '' : '<span class="wer">' + esc(m.team_name || 'Büro') + '</span>')
                    + esc(m.text)
                    + '<span class="zeit">' + (m.wartet ? 'wird gesendet …' : esc(uhrzeit(m.erstellt_am))) + '</span></div>';
            });
            return out;
        }
        function nachUnten() { window.scrollTo(0, document.body.scrollHeight); }
        function listeZeichnen() {
            const el = document.getElementById('naListe');
            if (!el) return;
            const neu = chatHtml();
            if (el.innerHTML === neu) return;
            const unten = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
            el.innerHTML = neu;
            if (unten) nachUnten();
        }
        function viewNachrichten() {
            const vorschau = S.mode === 'vorschau';
            const html = '<div id="naPush"></div>'
                + (vorschau ? '<div class="note">Vorschau: so sieht der Fahrer den Chat. Antworten kommen aus Telegram.</div>' : '')
                + '<div class="chat' + (vorschau ? ' ohne-eingabe' : '') + '" id="naListe">' + chatHtml() + '</div>'
                + (vorschau ? '' : '<form class="composer" id="naForm" autocomplete="off">'
                    + '<div class="composer-err" id="naFehler" role="alert"></div>'
                    + '<div class="composer-row"><textarea id="naText" rows="1" maxlength="2000" placeholder="Nachricht an das Büro" aria-label="Nachricht an das Büro"></textarea>'
                    + '<button type="submit" class="btn-primary" id="naSenden">Senden</button></div></form>');
            return { html: html };
        }
        function naGeoeffnet() {
            nachUnten();
            gelesenMelden();
            pushStatus();
            if (naAlt()) ladenNachrichten();
        }
        function naMeldung(err) {
            const m = (err && err.message) || '';
            if (/Zu viele|leer|zu lang|nur der Fahrer/.test(m)) return m;
            if (/fetch|network|Failed|Load failed/i.test(m)) return 'Keine Verbindung – bitte nochmal senden.';
            return 'Senden hat nicht geklappt – bitte nochmal versuchen.';
        }
        function feldHoehe(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
        document.addEventListener('input', function (e) { if (e.target && e.target.id === 'naText') feldHoehe(e.target); });
        document.addEventListener('submit', async function (e) {
            if (!e.target || e.target.id !== 'naForm') return;
            e.preventDefault();
            if (S.mode !== 'fahrer') return;
            const feld = document.getElementById('naText'), fehler = document.getElementById('naFehler'), knopf = document.getElementById('naSenden');
            const text = feld.value.trim();
            fehler.textContent = '';
            if (!text || knopf.disabled) return;
            knopf.disabled = true;
            const w = { richtung: 'fahrer', text: text, erstellt_am: new Date().toISOString(), wartet: true };
            S.na.wartend.push(w);
            feld.value = ''; feldHoehe(feld);
            listeZeichnen(); nachUnten();
            const r = await sb.rpc('fahrer_app_nachricht_senden', { p_text: text }).then(x => x, err => ({ error: err }));
            S.na.wartend = S.na.wartend.filter(x => x !== w);
            knopf.disabled = false;
            if (r.error) {
                // Text nicht verlieren: zurück ins Feld (vor das, was inzwischen getippt wurde)
                feld.value = feld.value ? text + '\n' + feld.value : text; feldHoehe(feld);
                fehler.textContent = naMeldung(r.error);
                listeZeichnen();
                return;
            }
            await ladenNachrichten();
            nachUnten();
        });
        // Solange der Chat offen und sichtbar ist: alle 15 Sekunden neu (kein Realtime)
        setInterval(function () {
            if (S.profil && document.visibilityState === 'visible' && route().name === 'nachrichten') ladenNachrichten();
        }, 15 * 1000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && S.profil) ladenNachrichten();
        });
        // Klick auf eine Benachrichtigung (sw.js schickt {typ: 'nachrichten'} an das offene Fenster)
        if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
            if (!e.data || e.data.typ !== 'nachrichten' || !S.profil) return;
            if (location.hash !== '#nachrichten') location.hash = '#nachrichten';
            ladenNachrichten();
        });

        /* Benachrichtigungen (Web-Push). iPhone: nur als Home-Bildschirm-App (iOS 16.4+). */
        function istIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
        function istHomescreen() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
        function b64uBytes(s) { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const r = atob(t + '='.repeat((4 - t.length % 4) % 4)); return Uint8Array.from(r, c => c.charCodeAt(0)); }
        async function aboMelden(sub, immer) {
            if (S.aboGemeldet && !immer) return true;
            const j = sub.toJSON();
            const r = await sb.rpc('fahrer_app_push_abo', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }).then(x => x, e => ({ error: e }));
            if (r.error) { console.warn('Push-Abo:', r.error); return false; }
            S.aboGemeldet = true;
            return true;
        }
        async function pushStatus() {
            if (S.mode !== 'fahrer' || !VAPID_PUBLIC) S.push = 'nicht_moeglich';
            else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) S.push = istIos() && !istHomescreen() ? 'ios_install' : 'nicht_moeglich';
            else if (Notification.permission === 'denied') S.push = 'abgelehnt';
            else {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    const sub = await reg.pushManager.getSubscription();
                    // vorhandenes Abo einmal je Sitzung melden: das Gerät gehört dem, der gerade angemeldet ist
                    if (sub && Notification.permission === 'granted') { S.push = 'an'; aboMelden(sub, false); }
                    else S.push = 'aus';
                } catch (e) { S.push = 'aus'; }
            }
            pushZeichnen();
        }
        function pushZeichnen() {
            const el = document.getElementById('naPush');
            if (!el) return;
            const t = {
                aus: '<span>Bekomm Bescheid, wenn das Büro antwortet.</span><button type="button" class="btn-ghost" data-act="push">Benachrichtigungen aktivieren</button>'
                    + (S.pushFehler ? '<span class="neg">Das hat nicht geklappt. Bitte später nochmal versuchen.</span>' : ''),
                ios_install: '<span>Für Benachrichtigungen am iPhone: unten auf <b>Teilen</b> → <b>Zum Home-Bildschirm</b>, die App dann von dort öffnen und hier aktivieren.</span>',
                abgelehnt: '<span>Benachrichtigungen sind blockiert. Du kannst sie in den Einstellungen des Handys für HYDRAlink wieder erlauben.</span>'
            }[S.push];
            el.className = t ? 'push-karte' : '';
            el.innerHTML = t || '';
        }
        async function pushAktivieren(btn) {
            btn.disabled = true;
            S.pushFehler = false;
            try {
                const erlaubnis = await Notification.requestPermission();
                if (erlaubnis !== 'granted') { S.push = erlaubnis === 'denied' ? 'abgelehnt' : 'aus'; pushZeichnen(); return; }
                const reg = await navigator.serviceWorker.ready;
                const sub = (await reg.pushManager.getSubscription())
                    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(VAPID_PUBLIC) });
                S.push = (await aboMelden(sub, true)) ? 'an' : 'aus';
                S.pushFehler = S.push !== 'an';
            } catch (e) { console.warn('Push:', e); S.push = 'aus'; S.pushFehler = true; }
            pushZeichnen();
        }
```

- [ ] **Step 9: Prüfen**

Vorher (schon heute so): `check-dashboard.sh fahrer/index.html` bricht mit `FEHLENDE IDs im Markup: bkIban-f` ab – die ID entsteht im Bankformular als `id + '-f'`. In `scripts/check-dashboard.sh` deshalb `dynamic_ok = set()` ersetzen durch `dynamic_ok = {"bkIban-f"}  # Fahrerapp-Bankformular: id + '-f'`.

Run: `bash scripts/check-dashboard.sh fahrer/index.html && node --check sw.js`
Expected: `OK: fahrer/index.html`, keine Ausgabe von `node --check`.
(Die per `innerHTML` erzeugten IDs `naListe`, `naPush`, `naText`, `naFehler`, `naSenden` stehen als `id="…"` in den JS-Strings und werden vom Skript gefunden.)

- [ ] **Step 10: Lokal ansehen** – `python3 -m http.server 8080` im Repo, im Browser `http://localhost:8080/fahrer/` mit einer Büro-Sitzung öffnen ist nicht möglich (Supabase-Login nötig) – deshalb: Betreiber öffnet nach dem Push im Dashboard Fahrer/App → Vorschau eines Fahrers → Reiter Nachrichten: Chat sichtbar, keine Eingabe, kein Push-Knopf, Hinweis „Vorschau …“.

- [ ] **Step 11: Commit**

```bash
git add sw.js fahrer/index.html scripts/check-dashboard.sh
git commit -m "fahrerapp: reiter nachrichten (chat mit dem buero, badge, senden, benachrichtigungen per web-push); cache v57"
```

- [ ] **Step 12: Live** – vorher `git log --oneline origin/main..HEAD` zeigen (was mit live geht). Betreiber pusht: `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`. Cloudflare Pages deployt in ~1 Minute.

---

### Task 9: Ende-zu-Ende mit echtem Fahrer-Zugang, Doku

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Ende-zu-Ende** (Betreiber, mit einem echten App-Zugang, z. B. FHR-14, am Handy):
  1. App öffnen → Reiter Nachrichten → „Schreib uns …“ → Nachricht senden → erscheint sofort grau „wird gesendet …“, dann normal; in Telegram neues Thema mit Kopf.
  2. „Benachrichtigungen aktivieren“ → Erlaubnis → Knopf verschwindet; `select fahrer_nr, left(endpoint, 40) from push_abos` zeigt das Gerät.
     iPhone: vorher über Safari „Teilen → Zum Home-Bildschirm“, App von dort öffnen (sonst Hinweis statt Knopf).
  3. App zu → im Thema antworten → 👍 + Push „Boyko: …“ am Handy → Tippen öffnet den Chat mit der Antwort, Badge verschwindet.
  4. App offen auf dem Chat lassen → im Thema antworten → Antwort erscheint binnen 15 s ohne Push-Klick.
  5. Zweiter Fahrer (anderer Zugang) schreibt → eigenes Thema; Antworten landen jeweils beim richtigen; jeder sieht nur seinen Chat.
  6. 11 Nachrichten schnell hintereinander → die 11. zeigt „Zu viele Nachrichten – bitte kurz warten“, Text bleibt im Feld.
  7. Abgelaufenes Abo: in der Browser-/Handy-Einstellung die Benachrichtigungen für die Seite entfernen (Abo wird ungültig), Team antwortet → `push-senden` liefert `geloescht: 1`, Zeile in `push_abos` weg (`get_logs` / Tabelle prüfen).

- [ ] **Step 2: CLAUDE.md** – nach dem Abschnitt „Automatische Abrechnung“ (vor „## Key Supabase Tables“) einfügen:

```markdown
## Nachrichten (seit 2026-10-26)

Spec `docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md`, Plan `docs/superpowers/plans/2026-10-26-fahrer-nachrichten-telegram.md`.
Chat Fahrer ↔ Büro: Fahrer schreibt in der Fahrerapp (Reiter Nachrichten), das Büro antwortet in der **Telegram-Team-Gruppe,
ein Thema je Fahrer**. Alles, was im Fahrer-Thema geschrieben wird, geht an den Fahrer; „Allgemein“ ist intern und wird nie gespeichert.
- Schlüssel ist die **Notion-Fahrer-Nr.** (`fahrer_nr`), nicht `fahrer.id`. Tabellen `nachrichten`, `tg_themen` (Nr. → Thema),
  `push_abos` – RLS, Büro liest nur `nachrichten`, geschrieben wird nur über `fahrer_app_nachricht_senden` / `_gelesen` / `fahrer_app_push_abo`
  (Fahrer) und `service_role` (Functions). Kein Protokoll-Trigger (das Büro schreibt hier nicht).
- Trigger `nachrichten_weiterleiten` (pg_net): `fahrer` → `telegram-senden`, `team` → `push-senden`. Cron `nachrichten-nachholen`
  (5 Min) schickt Fahrer-Nachrichten ohne `tg_message_id` nach (max. 5 Versuche, Fehler in `tg_fehler`).
- `telegram-senden` legt das Thema beim ersten Mal an (`tg_thema_reservieren`, atomar), öffnet geschlossene wieder, legt gelöschte neu an,
  benennt bei Autowechsel um. `telegram-webhook` (`verify_jwt = false`, Header `X-Telegram-Bot-Api-Secret-Token`) speichert Team-Nachrichten
  aus Fahrer-Themen und setzt 👍 (= angekommen). Bot ist Admin mit „Themen verwalten“ und bekommt deshalb alle Gruppennachrichten.
- `push-senden`: Web-Push ohne Bibliothek (`_shared/webpush.ts`, aes128gcm + VAPID), 404/410 löscht das Abo. iPhone nur als Home-Bildschirm-App.
- Secrets (nur Edge Functions): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`, `TELEGRAM_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`. Einrichten/prüfen: `pbpaste | node scripts/telegram-einrichten.mjs einrichten|pruefen` (Token aus der Zwischenablage).
  `--neue-vapid` macht alle Push-Abos ungültig. Der öffentliche VAPID-Key steht als `VAPID_PUBLIC` in `fahrer/index.html`.
  Nicht derselbe Bot wie der USP-Bot.
- Team-Regeln: im Fahrer-Thema = an den Fahrer; Absprache in „Allgemein“; Bearbeiten kommt nicht an; Fotos/Sprachnachrichten noch nicht.
- Tests: `PGLITE=/tmp/pglite node scripts/test-nachrichten.mjs`, `node --test scripts/test-telegram-logik.mjs scripts/test-webpush.mjs`.
  Testzeilen mit `fahrer_nr = 999999` stammen vom Live-Test am Einrichtungstag.
```

Außerdem in „Tech Stack“ die Zeile `- **Notifications**: Telegram (implemented but currently deactivated)` ersetzen durch `- **Notifications**: Fahrer-Nachrichten über Telegram-Themen + Web-Push (seit 2026-10-26, Abschnitt „Nachrichten“)` und in „External Services“ die Telegram-Zeile auf `| Telegram | Fahrer-Nachrichten (Team-Gruppe, ein Thema je Fahrer) | Bot-Token als Edge-Function-Secret |` ändern.

- [ ] **Step 3: Alle Tests einmal zusammen**

Run: `PGLITE=/tmp/pglite node scripts/test-nachrichten.mjs && node --test scripts/test-telegram-logik.mjs scripts/test-webpush.mjs`
Expected: `Nachrichten: alle Pruefungen bestanden`, `pass 13`, `fail 0`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "doku: nachrichten (telegram-themen + web-push) in CLAUDE.md"
```
