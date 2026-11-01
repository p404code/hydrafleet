// Datenbank-Test fuer die Autoliste (Fahrer↔Auto), lokal in PGlite – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-autoliste.mjs
//
// Nachbau der benutzten Tabellen (Stand 01.11.2026, nur noetige Spalten, Pruefregeln wie live),
// dann die Pauschalen-Migrationen in Einspiel-Reihenfolge und die Autoliste.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const basis = process.env.PGLITE;
if (!basis) { console.error('PGLITE fehlt – siehe Kopf dieser Datei.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(basis, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const q = async (sql, p) => (await db.query(sql, p)).rows;
const eins = async (sql, p) => (await q(sql, p))[0];
let ok = 0;
const pruefe = async (name, fn) => { await fn(); ok++; console.log('ok  ', name); };
const alsBuero = (name = 'Mohamed') =>
  db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ app_metadata: { app_role: 'user', app_name: name } })}', false)`);

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function public.is_app_user() returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'app_role') in ('admin','user'), false) $$;
create function public.kennzeichen_key(t text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')) $$;
create function public.protokoll_schreiben() returns trigger language plpgsql as $$ begin return null; end $$;
create table public.fahrer (id serial primary key, name text not null unique, telefon text, kennzeichen text,
  aktiv boolean default true, notion_fahrer_id integer,
  mietmodell text, basis_miete numeric, prozent_satz numeric, prozent_schwelle numeric,
  constraint fahrer_mietmodell_check check (mietmodell = any (array['fix', 'f11', 'f12'])));  -- wie live
create table public.abrechnung_freigaben (woche text primary key, freigegeben_am timestamptz default now());
insert into public.abrechnung_freigaben (woche) values ('2026-W42'), ('2026-W43');
create table public.notion_fahrer (notion_page_id text primary key, notion_fahrer_id integer, name text, telefon text,
  aktualisiert_am timestamptz default now());
create table public.fuhrpark (kennzeichen_key text primary key, kennzeichen text, modell text, firma text, pauschale numeric,
  pauschal_modell text, eigentuemer text[], vin text, kilometerstand text, ablauf_pickerl date, polizze text,
  versicherung_monatlich text, taxameter text[], bolt_werbung boolean, dashcam boolean, aktualisiert_am timestamptz);
insert into public.fuhrpark (kennzeichen_key, kennzeichen, modell, firma) values
  ('W1TX', 'W-1TX', 'Prius', 'HYD'), ('W2TX', 'W-2TX', 'Corolla', 'HYD'), ('W3TX', 'W-3TX', 'Prius', 'Abgemeldet');
insert into public.notion_fahrer (notion_page_id, notion_fahrer_id, name, telefon) values
  ('p101', 101, 'Ali Demir', null), ('p102', 102, 'Bea Berg', null), ('p103', 103, ' Pavel Paunov ', '0660 1234'), ('p104', 104, 'Doppel Fahrer', null);
insert into public.fahrer (id, name, kennzeichen, aktiv, notion_fahrer_id, mietmodell, basis_miete, prozent_satz, prozent_schwelle) values
  (1, 'Ali Demir', 'W-1TX', true, 101, 'f12', 500, 10, 1200),
  (2, 'Bea Berg', 'W-2TX', true, 102, 'fix', 230, 0, 0),
  (4, 'Doppel Fahrer', 'W-2TX', true, 104, 'f11', 450, 10, 1100);
select setval('fahrer_id_seq', 10);
`);
for (const m of ['2026-10-31-pauschalen-uebernahme', '2026-10-31-pauschalen-setzen', '2026-11-01-pauschalen-eigene-als-fix',
  '2026-10-31-pauschalen-scharf', '2026-11-01-autoliste']) {
  await db.exec(lies(`../migrations/${m}.sql`));
}

await pruefe('Uebernahme aus Notion: Notion gewinnt, Doppel-Auto waehlt fahrer.kennzeichen, Pavel nicht', async () => {
  await db.exec(`update fuhrpark set notion_page_id = 'p-'||kennzeichen_key,
    notion_fahrer = case kennzeichen_key when 'W1TX' then array[101,104] when 'W2TX' then array[102,103,104] else null end`);
  assert.equal((await eins(`select fahrer_auto_uebernehmen() n`)).n, 3);
  const a = await q(`select notion_fahrer_id nr, kennzeichen_key k, quelle from fahrer_auto_aktuell order by nr`);
  assert.deepEqual(a.map((x) => [x.nr, x.k, x.quelle]), [[101, 'W1TX', 'uebernahme'], [102, 'W2TX', 'uebernahme'], [104, 'W2TX', 'uebernahme']]);
  assert.equal((await eins(`select fahrer_auto_uebernehmen() n`)).n, 0);
});

await pruefe('Liste: Pavel als "in Notion, nicht uebernommen", Abgemeldete fehlen', async () => {
  const l = await q(`select kennzeichen_key k, jsonb_array_length(fahrer) n, notion_nicht_uebernommen nu from autoliste order by k`);
  assert.deepEqual(l.map((x) => x.k), ['W1TX', 'W2TX']);
  assert.deepEqual(l[1].nu.map((x) => x.nr), [103]);
  assert.deepEqual(l.map((x) => x.n), [1, 2]);
});

await pruefe('Pavel einsetzen: ohne Pauschale abgelehnt, mit Pauschale genau eine fahrer-Zeile', async () => {
  await alsBuero('Mohamed');
  await assert.rejects(eins(`select auto_fahrer_setzen('W2TX', 103)`), /Pauschale fehlt/);
  const r = await eins(`select auto_fahrer_setzen('W2TX', 103, 'f12', 550) r`);
  assert.deepEqual(r.r.autos, ['W2TX']);
  const f = await q(`select name, kennzeichen, aktiv, mietmodell, basis_miete::float b, telefon from fahrer where notion_fahrer_id = 103`);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], { name: 'Pavel Paunov', kennzeichen: 'W-2TX', aktiv: true, mietmodell: 'f12', b: 550, telefon: '+436601234' });
  assert.equal((await eins(`select count(*)::int n from pauschalen where notion_fahrer_id = 103 and quelle = 'neuanlage'`)).n, 0);
  assert.equal((await eins(`select count(*)::int n from fuhrpark_notion_offen where kennzeichen_key = 'W2TX'`)).n, 1);
  assert.equal((await eins(`select von from fahrer_auto_aktuell where notion_fahrer_id = 103`)).von, 'Mohamed');
});

await pruefe('Wechsel: Ali von W1TX auf W2TX, beide Autos nach Notion, Pauschale bleibt', async () => {
  const r = await eins(`select auto_fahrer_setzen('W2TX', 101) r`);
  assert.deepEqual(r.r.autos.sort(), ['W1TX', 'W2TX']);
  assert.deepEqual(await eins(`select kennzeichen, mietmodell, basis_miete::float b from fahrer where notion_fahrer_id = 101`),
    { kennzeichen: 'W-2TX', mietmodell: 'f12', b: 500 });
});

await pruefe('Doppelt speichern ist harmlos', async () => {
  await eins(`select auto_fahrer_setzen('W2TX', 101)`);
  assert.equal((await eins(`select count(*)::int n from fahrer_auto_aktuell where notion_fahrer_id = 101`)).n, 1);
  assert.equal((await eins(`select count(*)::int n from fahrer where notion_fahrer_id = 101`)).n, 1);
});

await pruefe('Entfernen: kennzeichen null, aktiv bleibt', async () => {
  const r = await eins(`select auto_fahrer_entfernen(102) r`);
  assert.deepEqual(r.r.autos, ['W2TX']);
  assert.deepEqual(await eins(`select kennzeichen, aktiv from fahrer where notion_fahrer_id = 102`), { kennzeichen: null, aktiv: true });
  assert.deepEqual((await eins(`select auto_fahrer_entfernen(102) r`)).r.autos, []);
});

await pruefe('Regeln: abgemeldetes Auto, unbekannter Fahrer, nicht Buero', async () => {
  await assert.rejects(eins(`select auto_fahrer_setzen('W3TX', 101)`), /nicht angemeldet/);
  await assert.rejects(eins(`select auto_fahrer_setzen('W1TX', 999, 'f12', 1)`), /nicht in Notion/);
  await db.exec(`select set_config('request.jwt.claims', '{"app_metadata":{"fahrer_nr":101}}', false)`);
  await assert.rejects(eins(`select auto_fahrer_setzen('W1TX', 101)`), /Nicht autorisiert/);
  await assert.rejects(eins(`select auto_fahrer_entfernen(101)`), /Nicht autorisiert/);
});

await pruefe('Verlauf gesperrt', async () => {
  await assert.rejects(db.exec(`update fahrer_auto set kennzeichen = 'x'`), /nicht geändert/);
  await assert.rejects(db.exec(`delete from fahrer_auto`), /nicht geändert/);
});

await pruefe('fuhrpark_ersetzen nimmt Notion-Seite und Fahrer aktuell mit', async () => {
  await db.exec(`select fuhrpark_ersetzen('[{"kennzeichen":"W-1TX","firma":"HYD","notion_page_id":"pg1","notion_fahrer":[101,104]}]'::jsonb)`);
  assert.deepEqual(await eins(`select notion_page_id, notion_fahrer from fuhrpark where kennzeichen_key = 'W1TX'`),
    { notion_page_id: 'pg1', notion_fahrer: [101, 104] });
});

console.log(`\n${ok} Pruefungen bestanden`);
