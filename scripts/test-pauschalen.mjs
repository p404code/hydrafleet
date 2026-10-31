// Datenbank-Test fuer die Pauschalen, lokal in PGlite – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-pauschalen.mjs
//
// Nachbau der benutzten Tabellen/Funktionen (Stand 31.10.2026, nur noetige Spalten), dann die Migrationen.
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

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function public.is_app_user() returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'app_role') in ('admin','user'), false) $$;
create table public.fahrer (id integer primary key, name text not null, aktiv boolean default true, notion_fahrer_id integer,
  mietmodell text, basis_miete numeric, prozent_satz numeric, prozent_schwelle numeric);
create table public.abrechnung_freigaben (woche text primary key, freigegeben_am timestamptz default now());
create function public.protokoll_schreiben() returns trigger language plpgsql as $$ begin return null; end $$;
insert into public.abrechnung_freigaben (woche) values ('2026-W42'), ('2026-W43');
insert into public.fahrer values
  (1, 'F12 Fahrer',   true,  101, 'f12', 550, 10, 1200),
  (2, 'F11 Fahrer',   true,  102, 'f11', 500, 10, 1100),
  (3, 'Fix Fahrer',   true,  103, 'fix', 230, 0, 0),
  (4, 'Fix mit Satz', true,  104, 'fix', 100, 15, 1000),
  (5, 'Null-Fahrer',  true,  105, 'fix', 0, 0, 0),
  (6, 'Inaktiv',      false, 106, 'f12', 500, 10, 1200),
  (7, 'Ohne Nr',      true,  null, 'f12', 500, 10, 1200);
`);
await db.exec(lies('../migrations/2026-10-31-pauschalen-uebernahme.sql'));

await pruefe('Wochenrechnung ueber den Jahreswechsel', async () => {
  const r = await eins(`select woche_plus('2026-W43') a, woche_plus('2026-W53') b, woche_plus('2025-W52') c, woche_plus('2026-W52') d`);
  assert.deepEqual(r, { a: '2026-W44', b: '2027-W01', c: '2026-W01', d: '2026-W53' });
});

await pruefe('Stichwoche = Woche nach der letzten Freigabe', async () => {
  assert.equal((await eins(`select pauschale_stichwoche() w`)).w, '2026-W44');
});

await pruefe('Uebernahme: je aktivem Fahrer mit Nr. genau eine Zeile, richtige Art', async () => {
  const z = await q(`select fahrer_nr, art, betrag::float, prozent_satz::float s, prozent_schwelle::float w, gilt_ab, quelle, von
                       from pauschalen order by fahrer_nr`);
  assert.deepEqual(z.map((x) => [x.fahrer_nr, x.art, x.betrag, x.s, x.w]), [
    [101, 'f12', 550, null, null], [102, 'f11', 500, null, null], [103, 'fix', 230, null, null],
    [104, 'eigene', 100, 15, 1000], [105, 'fix', 0, null, null]]);
  assert.ok(z.every((x) => x.gilt_ab === '2026-W44' && x.quelle === 'uebernahme' && x.von === 'Übernahme aus Notion'));
});

await pruefe('Abweichung nach der Uebernahme leer, zweiter Lauf uebernimmt nichts', async () => {
  assert.equal((await eins(`select count(*)::int n from pauschalen_abweichung`)).n, 0);
  assert.equal((await eins(`select pauschalen_uebernehmen() n`)).n, 0);
});

await pruefe('Notion-Aenderung vor dem Scharfschalten -> neue Uebernahme-Zeile, die gilt', async () => {
  await db.exec(`update fahrer set basis_miete = 600 where id = 1`);
  assert.equal((await eins(`select befund from pauschalen_abweichung where fahrer_nr = 101`)).befund, 'weicht ab');
  assert.equal((await eins(`select pauschalen_uebernehmen() n`)).n, 1);
  assert.equal((await eins(`select (pauschale_fuer(101, '2026-W44')).betrag::float b`)).b, 600);
  assert.equal((await eins(`select count(*)::int n from pauschalen where fahrer_nr = 101`)).n, 2);
});

await pruefe('pauschale_fuer: befristet mit Rueckfall, neuester gewinnt', async () => {
  await db.exec(`insert into pauschalen (fahrer_nr, art, betrag, gilt_ab, gilt_bis, quelle, von, am)
                 values (102, 'fix', 300, '2026-W45', '2026-W48', 'hand', 'Test', now() + interval '1 minute')`);
  const b = async (w) => (await eins(`select (pauschale_fuer(102, $1)).betrag::float b`, [w])).b;
  assert.equal(await b('2026-W44'), 500);
  assert.equal(await b('2026-W45'), 300);
  assert.equal(await b('2026-W48'), 300);
  assert.equal(await b('2026-W49'), 500);
  await db.exec(`insert into pauschalen (fahrer_nr, art, betrag, gilt_ab, quelle, von, am)
                 values (102, 'f12', 520, '2026-W47', 'hand', 'Test', now() + interval '2 minutes')`);
  assert.equal(await b('2026-W46'), 300);
  assert.equal(await b('2026-W47'), 520);
  assert.equal(await b('2026-W49'), 520);
});

await pruefe('Verlauf ist gesperrt (UPDATE, DELETE, TRUNCATE)', async () => {
  await assert.rejects(db.exec(`update pauschalen set betrag = 1`), /nicht geändert/);
  await assert.rejects(db.exec(`delete from pauschalen`), /nicht geändert/);
  await assert.rejects(db.exec(`truncate pauschalen`), /nicht geändert/);
});

await pruefe('Pruefregeln der Tabelle', async () => {
  const ein = (sql) => db.exec(`insert into pauschalen (fahrer_nr, art, betrag, prozent_satz, prozent_schwelle, gilt_ab, gilt_bis, quelle, von) values ${sql}`);
  await assert.rejects(ein(`(101, 'f12', -1, null, null, '2026-W44', null, 'hand', 'T')`));
  await assert.rejects(ein(`(101, 'eigene', 0, null, null, '2026-W44', null, 'hand', 'T')`));
  await assert.rejects(ein(`(101, 'f12', 1, 10, 1200, '2026-W44', null, 'hand', 'T')`));
  await assert.rejects(ein(`(101, 'fix', 1, null, null, '2026-W46', '2026-W45', 'hand', 'T')`));
  await assert.rejects(ein(`(101, 'fix', 1, null, null, '2026-44', null, 'hand', 'T')`));
  await ein(`(105, 'eigene', 0, 25, 0, '2026-W45', null, 'hand', 'T')`);   // % vom ganzen Umsatz
});

await pruefe('RLS: Buero liest, Fahrer/anon nicht', async () => {
  await db.exec(`grant usage on schema public, auth to authenticated, anon`);
  const als = async (claims, rolle = 'authenticated') => {
    await db.exec(`set role ${rolle}; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false)`);
    try { return (await eins(`select count(*)::int n from pauschalen`)).n; } finally { await db.exec(`reset role`); }
  };
  assert.ok(await als({ app_metadata: { app_role: 'user' } }) > 0);
  assert.equal(await als({ app_metadata: { app_role: 'fahrer' } }), 0);
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"app_metadata":{"app_role":"fahrer"}}', false)`);
  try { assert.equal((await eins(`select (pauschale_fuer(101, '2026-W44')).betrag b`)).b, null); } finally { await db.exec(`reset role`); }
  await assert.rejects(als({}, 'anon'));
});

// ---------- Schritt 1: Speichern ----------
await db.exec(lies('../migrations/2026-10-31-pauschalen-setzen.sql'));
const alsBuero = (name = 'Mohamed') => db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ app_metadata: { app_role: 'user', app_name: name } })}', false)`);
const setzen = (nr, art, betrag, satz, schwelle, ab, bis, grund) => eins(
  `select * from pauschale_setzen($1, $2, $3, $4, $5, $6, $7, $8)`, [nr, art, betrag, satz ?? null, schwelle ?? null, ab ?? null, bis ?? null, grund ?? null]);
const fz = (id) => eins(`select mietmodell, basis_miete::float b, prozent_satz::float s, prozent_schwelle::float w from fahrer where id = $1`, [id]);

await pruefe('Umbenennung: notion_fahrer_id, Abfragen laufen weiter', async () => {
  assert.equal((await eins(`select count(*)::int n from information_schema.columns where table_name = 'pauschalen' and column_name = 'notion_fahrer_id'`)).n, 1);
  assert.equal((await eins(`select (pauschale_fuer(101, '2026-W44')).betrag::float b`)).b, 600);
  assert.equal((await eins(`select count(*)::int n from pauschalen_abweichung`)).n, 0);
});

await pruefe('pauschale_setzen: Buero, ab Stichwoche, wirkt sofort auf fahrer', async () => {
  await alsBuero();
  const r = await setzen(103, 'f12', 480, null, null, null, null, '  ');
  assert.equal(r.von, 'Mohamed'); assert.equal(r.gilt_ab, '2026-W44'); assert.equal(r.quelle, 'hand'); assert.equal(r.grund, null);
  assert.deepEqual(await fz(3), { mietmodell: 'f12', b: 480, s: 10, w: 1200 });
});

await pruefe('pauschale_setzen: spaeter gueltig -> fahrer bleibt bis dahin', async () => {
  await alsBuero('Stefan');
  const r = await setzen(101, 'fix', 300, null, null, '2026-W45', '2026-W48', 'Einstieg nach Unfall');
  assert.equal(r.gilt_bis, '2026-W48'); assert.equal(r.grund, 'Einstieg nach Unfall');
  assert.deepEqual(await fz(1), { mietmodell: 'f12', b: 600, s: 10, w: 1200 });
});

await pruefe('pauschale_setzen: eigene Regel, % vom ganzen Umsatz (Schwelle 0)', async () => {
  await alsBuero();
  await setzen(105, 'eigene', 0, 25, 0, null, null, 'Eigenes Auto');
  assert.deepEqual(await fz(5), { mietmodell: 'eigene', b: 0, s: 25, w: 0 });
  const r = await eins(`select prozent_satz::float s, prozent_schwelle::float w from pauschalen where notion_fahrer_id = 105 order by id desc limit 1`);
  assert.deepEqual(r, { s: 25, w: 0 });
  assert.equal((await eins(`select count(*)::int n from pauschalen_abweichung`)).n, 0);
});

await pruefe('pauschale_setzen: Satz/Schwelle bei f-Modellen werden ignoriert', async () => {
  await alsBuero();
  const r = await setzen(102, 'f11', 500, 99, 5, '2026-W53');
  assert.equal(r.prozent_satz, null); assert.equal(r.prozent_schwelle, null);
});

await pruefe('pauschale_setzen: Regeln und Rechte', async () => {
  await alsBuero();
  await assert.rejects(setzen(101, 'f12', 500, null, null, '2026-W43'), /frühestens ab 2026-W44/);
  await assert.rejects(setzen(101, 'f12', 500, null, null, '2026-W46', '2026-W45'), /bis/);
  await assert.rejects(setzen(999, 'f12', 500), /nicht gefunden/);
  await assert.rejects(setzen(101, 'f13', 500), /Unbekannte Art/);
  await assert.rejects(setzen(101, 'f12', 5001), /zwischen 0 und 5.000/);
  await assert.rejects(setzen(101, 'f12', -1), /zwischen 0 und 5.000/);
  await assert.rejects(setzen(101, 'eigene', 100), /Prozentsatz/);
  await assert.rejects(setzen(101, 'eigene', 100, 10), /Umsatzschwelle/);
  await assert.rejects(setzen(101, 'f12', 500, null, null, 'KW45'), /JJJJ-Wnn/);
  await db.exec(`select set_config('request.jwt.claims', '{"app_metadata":{"app_role":"fahrer","fahrer_nr":101}}', false)`);
  await assert.rejects(setzen(101, 'f12', 1), /Nicht autorisiert/);
  await db.exec(`select set_config('request.jwt.claims', '', false)`);
  await assert.rejects(setzen(101, 'f12', 1), /Nicht autorisiert/);
});

// ---------- Scharfschalten ----------
await db.exec(lies('../migrations/2026-10-31-pauschalen-scharf.sql'));

await pruefe('Waechter: Notion-Sync kann die Pauschale nicht mehr ueberschreiben', async () => {
  await db.exec(`update fahrer set basis_miete = 999, mietmodell = 'fix', prozent_satz = 0, prozent_schwelle = 0, name = 'F12 Fahrer neu' where id = 1`);
  assert.deepEqual(await fz(1), { mietmodell: 'f12', b: 600, s: 10, w: 1200 });
  assert.equal((await eins(`select name from fahrer where id = 1`)).name, 'F12 Fahrer neu');
});

await pruefe('Waechter: neuer Fahrer aus Notion -> einmalige Uebernahme, danach gilt HYDRAlink', async () => {
  await db.exec(`insert into fahrer values (8, 'Neu', true, 108, 'f12', 480, 10, 1200)`);
  const e = await eins(`select art, betrag::float b, quelle, von, gilt_ab from pauschalen where notion_fahrer_id = 108`);
  assert.deepEqual(e, { art: 'f12', b: 480, quelle: 'neuanlage', von: 'Automatik (neu aus Notion)', gilt_ab: '2026-W44' });
  await db.exec(`update fahrer set basis_miete = 700 where id = 8`);
  assert.equal((await fz(8)).b, 480);
  await db.exec(`insert into fahrer values (9, 'Neu inaktiv', false, 109, 'f12', 480, 10, 1200)`);
  assert.equal((await eins(`select count(*)::int n from pauschalen where notion_fahrer_id = 109`)).n, 0);
});

await pruefe('Freigabe schiebt die Stichwoche: Befristung beginnt und endet von selbst', async () => {
  await db.exec(`insert into abrechnung_freigaben (woche) values ('2026-W44')`);
  assert.equal((await eins(`select pauschale_stichwoche() w`)).w, '2026-W45');
  assert.deepEqual(await fz(1), { mietmodell: 'fix', b: 300, s: 0, w: 0 });
  await db.exec(`insert into abrechnung_freigaben (woche) values ('2026-W45'), ('2026-W46'), ('2026-W47')`);
  assert.equal((await fz(1)).b, 300);
  await db.exec(`insert into abrechnung_freigaben (woche) values ('2026-W48')`);
  assert.deepEqual(await fz(1), { mietmodell: 'f12', b: 600, s: 10, w: 1200 });
  assert.equal((await eins(`select count(*)::int n from pauschalen_abweichung`)).n, 0);
});

console.log(`\n${ok} Pruefungen bestanden`);
