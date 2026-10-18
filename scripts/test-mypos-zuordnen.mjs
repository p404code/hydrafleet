// Test fuer migrations/2026-10-19-mypos-zuordnen.sql, lokal in PGlite (Live-Datenbank wird nicht beruehrt).
//   PGLITE=<dir> node scripts/test-mypos-zuordnen.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const q = async (sql) => (await db.query(sql)).rows;
const nein = async (sql, muster) => assert.rejects(db.query(sql), (e) => { assert.match(e.message, muster); return true; });
await db.exec(`
  create role authenticated; create role anon; create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function public.is_app_user() returns boolean language sql stable as $$ select coalesce((auth.jwt()->'app_metadata'->>'app_role') in ('admin','user'), false) $$;
  create table public.fahrer (id int primary key, name text, telefon text, aktiv boolean default true, prozent_satz numeric, prozent_schwelle numeric);
  create table public.settlements (id serial primary key, woche text, fahrer_name text, telefon text, mietmodell text, miete numeric default 0,
    bolt_brutto numeric default 0, uber_fahrpreis numeric default 0, mypos_summe numeric default 0, bruttoumsatz_gesamt numeric default 0,
    wir_bekommen numeric default 0, prozent_abzug numeric default 0, abzug_gesamt numeric default 0, auszahlung numeric default 0,
    status text default 'berechnet', korrektur numeric default 0, korrektur_note text, lohn numeric default 0, unique (woche, fahrer_name));
  create function public.settlement_fahrer(p_telefon text, p_name text) returns int language sql stable as $$ select id from public.fahrer where name = p_name $$;
  insert into public.fahrer values (1, 'Anna F12', null, true, 0, 1200), (2, 'Bert Prozent', null, true, 10, 1000), (3, 'Cem Fix', null, true, 0, 1200);
  insert into public.settlements (id, woche, fahrer_name, mietmodell, miete, bruttoumsatz_gesamt, wir_bekommen, prozent_abzug, abzug_gesamt, auszahlung) values
    (1, '2026-W41', 'Anna F12', 'f12', 300, 1250, 1100, 5, 305, 795),       -- f12: (1250-1200)*10% = 5
    (2, '2026-W41', 'Bert Prozent', 'fix', 250, 900, 800, 0, 250, 550),     -- unter Schwelle 1000
    (3, '2026-W41', 'Cem Fix', 'fix', 250, 2000, 1800, 0, 250, 1550),
    (4, '2026-W40', 'Anna F12', 'f12', 300, 1000, 900, 0, 300, 600);
  insert into public.settlements (id, woche, fahrer_name, mypos_summe, status) values
    (10, '2026-W41', '__MYPOS:W-1TX__', 100, 'MYPOS_UNASSIGNED'), (11, '2026-W41', '__MYPOS:W-2TX__', 150, 'MYPOS_UNASSIGNED'),
    (12, '2026-W41', '__MYPOS:W-3TX__', 40, 'MYPOS_UNASSIGNED');
  grant usage on schema public, auth to authenticated; grant select on public.settlements to authenticated;
`);
await db.exec(readFileSync(new URL('../migrations/2026-10-19-mypos-zuordnen.sql', import.meta.url), 'utf8'));
const als = (c) => db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(c)}', false); set role authenticated;`);
const raus = () => db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
const zeile = async (id) => (await q(`select mypos_summe m, bruttoumsatz_gesamt b, wir_bekommen w, prozent_abzug p, abzug_gesamt a, auszahlung z, status s from public.settlements where id = ${id}`))[0];
const N = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
try {
  await als({ app_metadata: { fahrer_nr: '5' } });
  await nein(`select public.mypos_zuordnen(10, 1)`, /Nicht autorisiert/);
  await raus();
  await als({ app_metadata: { app_role: 'user', app_name: 'Stefan' } });
  // f12: 1250 -> 1350, Prozent 5 -> 15, Auszahlung 795 + 100 - 10 = 885
  let r = (await q(`select public.mypos_zuordnen(10, 1) r`))[0].r;
  assert.deepEqual([Number(r.prozent_nachher), Number(r.auszahlung_nachher)], [15, 885]);
  assert.deepEqual(N(await zeile(1)), { m: 100, b: 1350, w: 1200, p: 15, a: 315, z: 885, s: 'berechnet' });
  assert.equal((await zeile(10)).s, 'MYPOS_ZUGEORDNET');
  await nein(`select public.mypos_zuordnen(10, 2)`, /schon zugeordnet/);
  // Prozent ueber Schwelle: 900 + 150 = 1050 -> (1050-1000)*10% = 5, Auszahlung 550 + 150 - 5 = 695
  await q(`select public.mypos_zuordnen(11, 2)`);
  assert.deepEqual(N(await zeile(2)), { m: 150, b: 1050, w: 950, p: 5, a: 255, z: 695, s: 'berechnet' });
  // Fix ohne Prozent: nur +40
  await q(`select public.mypos_zuordnen(12, 3)`);
  assert.equal(Number((await zeile(3)).z), 1590);
  await nein(`select public.mypos_zuordnen(12, 4)`, /schon zugeordnet|dieser Woche/);
  // Rueckgaengig stellt die Werte wieder her und gibt die myPOS-Zeile frei
  const id = (await q(`select id from public.mypos_zuordnungen where mypos_zeile_id = 11`))[0].id;
  await q(`select public.mypos_zuordnung_zurueck(${id})`);
  assert.deepEqual(N(await zeile(2)), { m: 0, b: 900, w: 800, p: 0, a: 250, z: 550, s: 'berechnet' });
  assert.equal((await zeile(11)).s, 'MYPOS_UNASSIGNED');
  await nein(`select public.mypos_zuordnung_zurueck(${id})`, /schon zurückgenommen/);
  // Zeile inzwischen geaendert (z. B. Neu-Upload) -> kein stilles Zurueckrechnen
  await raus(); await db.exec(`update public.settlements set auszahlung = 999 where id = 1`);
  await als({ app_metadata: { app_role: 'user', app_name: 'Stefan' } });
  const id1 = (await q(`select id from public.mypos_zuordnungen where mypos_zeile_id = 10`))[0].id;
  await nein(`select public.mypos_zuordnung_zurueck(${id1})`, /seitdem geändert/);
  await nein(`select public.mypos_zuordnen(11, 4)`, /dieser Woche/);   // andere Woche
  await raus();
  console.log('OK');
} catch (e) { console.error('FEHLER: ' + e.message); process.exit(1); }
