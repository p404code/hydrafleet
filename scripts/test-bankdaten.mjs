// Datenbank-Test fuer die Bankdaten, lokal in PGlite – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs
//
// Nachbau der benutzten Tabellen/Funktionen (Stand 15.10.2026, nur noetige Spalten), dann die Migrationen.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const basis = process.env.PGLITE;
if (!basis) { console.error('PGLITE fehlt – siehe Kopf dieser Datei.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(basis, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
create function public.is_app_user() returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'app_role') in ('admin','user'), false) $$;
create function public.tel_key(t text) returns text language sql immutable as $$
  select case when d like '00%' then substr(d, 3) when d like '0%' then '43' || substr(d, 2) else d end
  from (select regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g') as d) x $$;
create function public.name_key(t text) returns text language sql immutable as $$
  select coalesce((select string_agg(w, ' ' order by w)
    from unnest(string_to_array(lower(regexp_replace(coalesce(t, ''), '[^a-zA-Z]', ' ', 'g')), ' ')) w where w <> ''), '') $$;
create function public.protokoll_schreiben() returns trigger language plpgsql as $$ begin return null; end $$;
create table public.fahrer (id integer primary key, name text not null, telefon text, aktiv boolean default true, notion_fahrer_id integer);
create table public.fahrer_app_zugang (notion_fahrer_id integer primary key, auth_user_id uuid not null, gesperrt boolean default false);
create table public.abrechnung_freigaben (woche text primary key, freigegeben_am timestamptz default now());
create table public.settlements (id serial primary key, woche text, fahrer_name text, telefon text, status text default 'berechnet',
  auszahlung numeric(10,2) default 0, lohn numeric default 0);
create table public.fahrer_iban (id bigint primary key, erstellt_am timestamptz default now(), vorname text not null, nachname text not null,
  telefon text, kontoinhaber text not null, iban text not null, bic text, revtag text, status text not null default 'neu', notiz text,
  constraint fahrer_iban_status_check check (status = any (array['neu','geprueft','abgelehnt'])));  -- wie live
insert into public.fahrer_iban (id, erstellt_am, vorname, nachname, telefon, kontoinhaber, iban, bic, revtag) values
  (1, '2026-10-06', 'Cem', 'Fahr', '0660 3333333', 'Cem Fahr', 'DE89 3704 0044 0532 0130 00', null, null),
  (2, '2026-10-08', 'Cem', 'Fahr', '06603333333', 'Cem Fahr', 'GB82WEST12345698765432', 'westgb2l', 'cem'),  -- neuester gewinnt
  (3, '2026-10-07', 'Unbe', 'Kannt', '0699 0000000', 'Unbe Kannt', 'AT611904300234573201', null, null),       -- kein Fahrer
  (4, '2026-10-07', 'Anna', 'Fahr', '+43 660 1111111', 'Anna Fahr', 'AT611904300234573202', null, null),    -- IBAN kaputt
  -- Das Formular hat live keine Telefonnummern (12 von 13 leer): Zuordnung ueber den Namen
  (5, '2026-10-07', 'Vier', 'Dora', null, 'Dora Vier', 'DE89370400440532013000', null, null),     -- Reihenfolge vertauscht
  (6, '2026-10-07', 'Emil', 'Weiss', null, 'Emil Weiss', 'BG80BNBG96611020345678', null, null),   -- ueber name_aliases
  (7, '2026-10-07', 'Gleich', 'Name', null, 'Gleich Name', 'LT121000011101001000', null, null),   -- zwei Fahrer passen
  (8, '2026-10-20', 'Hans', 'Neu', null, 'Hans Neu', 'DE89370400440532013000', null, null);       -- nach dem Stichtag: nie automatisch
create function public.settlement_fahrer(p_telefon text, p_name text) returns integer language sql stable as $$
  select f.id from public.fahrer f
  where (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) or f.name = p_name
  order by (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) desc, f.aktiv desc nulls last, f.id
  limit 1 $$;
create function public.mein_fahrer_id() returns integer language sql stable security definer set search_path = public as $$
  select min(f.id) from public.fahrer f
  join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id and z.auth_user_id = auth.uid() and not z.gesperrt
  where f.aktiv and coalesce(auth.jwt()->'app_metadata'->>'fahrer_nr', '') ~ '^[0-9]{1,9}$'
    and f.notion_fahrer_id = (auth.jwt()->'app_metadata'->>'fahrer_nr')::integer
  having count(*) = 1 $$;
create function public.fahrer_app_ziel(p_fahrer_id integer) returns integer language sql stable security definer set search_path = public as $$
  select case when p_fahrer_id is not null and public.is_app_user() then (select f.id from public.fahrer f where f.id = p_fahrer_id)
              when public.is_app_user() then null else public.mein_fahrer_id() end $$;
grant usage on schema public, auth to anon, authenticated;
-- wie live: Buero liest fahrer/settlements/freigaben ueber RLS (app_users_all), Fahrer sehen nichts direkt
alter table public.fahrer enable row level security;
create policy app_users_all on public.fahrer for all to authenticated using (public.is_app_user());
grant select on public.fahrer, public.settlements, public.abrechnung_freigaben to authenticated;

insert into public.fahrer values (1, 'Anna Fahr', '+436601111111', true, 101), (2, 'Bert Fahr', '+436602222222', true, 102),
                                 (3, 'Cem Fahr', '+436603333333', true, 103),
                                 (4, 'Dora Vier', null, true, 104), (5, 'Emil Fuenf', null, true, 105),
                                 (6, 'Gleich Name', null, true, 106), (7, 'Name Gleich', null, true, 107),
                                 (8, 'Hans Neu', null, true, 108);  -- 6/7: gleicher name_key
create table public.name_aliases (csv_name text primary key, fahrer_name text not null);
-- Notion-Fahrerseiten: 120 steht nur in Notion (kein fahrer-Eintrag, z. B. noch nicht im Fuhrpark)
create table public.notion_fahrer (notion_page_id text primary key, notion_fahrer_id integer, name text, telefon text, status text);
insert into public.notion_fahrer values ('p101', 101, 'Anna Fahr', null, null), ('p102', 102, 'Bert Fahr', null, null),
  ('p103', 103, 'Cem Fahr', null, null), ('p120', 120, 'Nur Notion', null, null);
grant select on public.notion_fahrer to authenticated;
insert into public.name_aliases values ('emil weiss', 'Emil Fuenf');
insert into public.fahrer_app_zugang values (101, '00000000-0000-0000-0000-000000000101', false),
                                            (102, '00000000-0000-0000-0000-000000000102', false);
insert into public.abrechnung_freigaben (woche) values ('2026-W40'), ('2026-W41');
insert into public.settlements (woche, fahrer_name, telefon, auszahlung, lohn) values
  ('2026-W41', 'Anna Fahr', '+436601111111', 500, 100),        -- Anna: 400
  ('2026-W41', 'Anna Alias', '+436601111111', 50, 0),          -- zweite Zeile derselben Person: +50
  ('2026-W41', 'Bert Fahr', '+436602222222', 100, 300),        -- Bert: -200
  ('2026-W40', 'Anna Fahr', '+436601111111', 999, 0),
  ('2026-W41', 'Cem Fahr', '+436603333333', 300, 0);           -- Cem: 300, IBAN nur hinterlegt (nicht bestaetigt)
`);
await db.exec(lies('../migrations/2026-10-15-bankdaten.sql'));
const uebernahme = '../migrations/2026-10-15-bankdaten-uebernahme.sql';

const als = (claims) => db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false); set role authenticated;`);
const raus = () => db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
const ANNA = { sub: '00000000-0000-0000-0000-000000000101', app_metadata: { fahrer_nr: '101' } };
const BERT = { sub: '00000000-0000-0000-0000-000000000102', app_metadata: { fahrer_nr: '102' } };
const BUERO = { sub: '00000000-0000-0000-0000-000000000900', app_metadata: { app_role: 'user', app_name: 'Stefan' } };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const nein = async (sql, p, muster) => assert.rejects(db.query(sql, p), (e) => { assert.match(e.message, muster); return true; });

try {
  // --- Pruefung in SQL wie im Browser
  const g = await q(`select public.iban_gueltig('lt12 1000 0111-0100 1000') a, public.iban_gueltig('AT611904300234573202') b,
                            public.iban_gueltig('AT6119043002345732') c, public.iban_gueltig('DE89370400440532013000') d`);
  assert.deepEqual(g[0], { a: true, b: false, c: false, d: true });

  // --- Anna: noch nichts da -> eine Zeile mit leeren Bankdaten, Betrag 450 (zwei Zeilen), Woche W41
  await als(ANNA);
  let [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.iban, null); assert.equal(a.woche, '2026-W41'); assert.equal(Number(a.betrag), 450);
  await nein(`select public.bank_bestaetigen('2026-W41', 'LT121000011101001000')`, [], /zuerst Bankdaten/);
  await nein(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573202')`, [], /IBAN ungültig/);
  await nein(`select public.fahrer_bank_setzen(' ', 'AT611904300234573201')`, [], /Kontoinhaber/);
  await nein(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573201', 'REV')`, [], /BIC/);
  await q(`select public.fahrer_bank_setzen('  Anna   Fahr ', 'lt12 1000 0111-0100 1000', 'revolt21', 'anna.f')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.iban, 'LT121000011101001000'); assert.equal(a.kontoinhaber, 'Anna Fahr');
  assert.equal(a.bic, 'REVOLT21'); assert.equal(a.revtag, '@anna.f');
  // Bestaetigen: nur aktuelle Woche
  await nein(`select public.bank_bestaetigen('2026-W40', 'LT121000011101001000')`, [], /aktuelle Woche/);
  // Final-Review I2: bestaetigt wird nur die IBAN, die der Fahrer gesehen hat
  await nein(`select public.bank_bestaetigen('2026-W41', 'AT611904300234573201')`, [], /inzwischen geändert/);
  await q(`select public.bank_bestaetigen('2026-W41', 'lt12 1000 0111 0100 1000')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.bestaetigt_iban, 'LT121000011101001000'); assert.ok(a.bestaetigt_am);
  // Gleiche Daten nochmal: kein Verlauf, Bestaetigung bleibt
  await q(`select public.fahrer_bank_setzen('Anna Fahr', 'LT121000011101001000', 'REVOLT21', '@anna.f')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.ok(a.bestaetigt_am, 'Bestaetigung darf bei gleichen Daten bleiben');
  // Fahrer liest Tabellen nicht direkt
  assert.equal((await q('select count(*)::int n from public.fahrer_bank'))[0].n, 0);
  assert.equal((await q('select count(*)::int n from public.fahrer_bank_verlauf'))[0].n, 0);
  // Neue IBAN -> Bestaetigung weg
  await q(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573201')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.bestaetigt_am, null); assert.equal(a.iban, 'AT611904300234573201');
  // Betrag eines anderen Fahrers ist nicht abfragbar (nur intern in den RPCs)
  await nein(`select public.bank_betrag(2, '2026-W41')`, [], /permission denied/);
  // Vorschau-Parameter wird fuer Fahrer ignoriert (sieht nur sich)
  [a] = await q('select * from public.fahrer_app_bank(2)');
  assert.equal(a.iban, 'AT611904300234573201');
  await raus();

  // --- Bert: Betrag negativ -> Bestaetigen abgelehnt
  await als(BERT);
  await q(`select public.fahrer_bank_setzen('Bert Fahr', 'DE89370400440532013000')`);
  await nein(`select public.bank_bestaetigen('2026-W41', 'DE89370400440532013000')`, [], /keine Auszahlung/);
  await raus();

  // --- Buero: sieht alles, kann nicht als Fahrer speichern/bestaetigen, kann ueber buero_bank_setzen eintragen
  await als(BUERO);
  await nein(`select public.fahrer_bank_setzen('X Y', 'DE89370400440532013000')`, [], /Fahrerapp/);
  await nein(`select public.bank_bestaetigen('2026-W41', 'DE89370400440532013000')`, [], /Fahrerapp/);
  [a] = await q('select * from public.fahrer_app_bank(1)');         // Vorschau Anna
  assert.equal(a.iban, 'AT611904300234573201');
  await q(`select public.buero_bank_setzen(103, 'Cem Fahr', 'GB82WEST12345698765432')`);
  await nein(`select public.buero_bank_setzen(999, 'Niemand', 'GB82WEST12345698765432')`, [], /Fahrer/);
  // Bankdaten gehen auch fuer Notion-Fahrer ohne fahrer-Eintrag (Korrektur Betreiber 16.10.)
  await q(`select public.buero_bank_setzen(120, 'Nur Notion', 'BG80BNBG96611020345678')`);
  assert.equal((await q('select iban from public.fahrer_bank where notion_fahrer_id = 120'))[0].iban, 'BG80BNBG96611020345678');
  const ue = await q('select notion_fahrer_id, iban, geaendert_von, aenderungen from public.bank_uebersicht where iban is not null and notion_fahrer_id < 120 order by 1');
  assert.deepEqual(ue.map((r) => [r.notion_fahrer_id, r.iban, r.geaendert_von, r.aenderungen]), [
    [101, 'AT611904300234573201', 'fahrer', 2], [102, 'DE89370400440532013000', 'fahrer', 1], [103, 'GB82WEST12345698765432', 'Stefan', 1]]);
  const v = await q('select alt_iban, neu_iban, von from public.fahrer_bank_verlauf where notion_fahrer_id = 101 order by id');
  assert.deepEqual(v.map((r) => [r.alt_iban, r.neu_iban, r.von]),
    [[null, 'LT121000011101001000', 'fahrer'], ['LT121000011101001000', 'AT611904300234573201', 'fahrer']]);
  await raus();

  // --- Ohne Anmeldung: nichts
  await db.exec('set role anon');
  await nein('select * from public.fahrer_bank', [], /permission denied/);
  await nein(`select public.fahrer_bank_setzen('X Y', 'DE89370400440532013000')`, [], /permission denied/);
  await raus();

  // --- Verlauf ist unveraenderlich, auch fuer den Besitzer der Tabelle
  await nein('update public.fahrer_bank_verlauf set von = $1', ['x'], /nicht geändert/);
  await nein('delete from public.fahrer_bank_verlauf', [], /nicht geändert/);

  if (existsSync(new URL(uebernahme, import.meta.url))) {
    // vorher: Cem hat (aus dem Buero-Test) GB82…; Uebernahme darf vorhandene Bankdaten NICHT ueberschreiben
    await db.exec(lies(uebernahme));
    let r = await q('select id, status, uebernommen_nr from public.fahrer_iban order by id');
    assert.deepEqual(r.map((x) => [x.id, x.status, x.uebernommen_nr]),
      [[1, 'neu', null], [2, 'neu', null], [3, 'neu', null], [4, 'neu', null], [5, 'uebernommen', 104], [6, 'uebernommen', 105], [7, 'neu', null], [8, 'neu', null]]);
    // Cem neu aufsetzen: Buero-Eintrag weg, damit die Uebernahme greift (Verlauf bleibt, nur fahrer_bank leeren)
    await db.exec(`delete from public.fahrer_bank where notion_fahrer_id = 103`);
    await db.exec(lies(uebernahme));
    r = await q('select id, status, uebernommen_nr from public.fahrer_iban order by id');
    assert.deepEqual(r.map((x) => [x.id, x.status, x.uebernommen_nr]),
      [[1, 'ueberholt', 103], [2, 'uebernommen', 103], [3, 'neu', null], [4, 'neu', null], [5, 'uebernommen', 104], [6, 'uebernommen', 105], [7, 'neu', null], [8, 'neu', null]]);
    const [c] = await q('select iban, bic, revtag, geaendert_von from public.fahrer_bank where notion_fahrer_id = 103');
    assert.deepEqual([c.iban, c.bic, c.revtag, c.geaendert_von], ['GB82WEST12345698765432', 'WESTGB2L', '@cem', 'formular']);

    await als(BUERO);
    const offen = await q('select id, grund from public.formular_iban_offen order by id');
    assert.deepEqual(offen.map((x) => [x.id, x.grund]), [[3, 'kein passender Fahrer (Name/Telefon)'], [4, 'IBAN ungültig'], [7, 'mehrere Fahrer passen'], [8, 'passt zu Hans Neu (Nr. 108)']]);
    await nein('select public.formular_iban_zuordnen(4, 101)', [], /IBAN ungültig/);
    // Final-Review I1: Bert hat schon Bankdaten -> nur mit ausdruecklichem Ueberschreiben
    await nein('select public.formular_iban_zuordnen(3, 102)', [], /hat schon Bankdaten/);
    await q('select public.formular_iban_zuordnen(3, 102, true)');       // Buero ordnet Eintrag 3 Bert zu
    await q('select public.formular_iban_zuordnen(8, 120, true)');       // Notion-Fahrer ohne fahrer-Eintrag
    assert.equal((await q('select status from public.fahrer_iban where id = 8'))[0].status, 'uebernommen');
    await q('select public.formular_iban_verwerfen(7)');
    assert.equal((await q('select status from public.fahrer_iban where id = 7'))[0].status, 'abgelehnt');
    const [b] = await q(`select iban, geaendert_von from public.fahrer_bank where notion_fahrer_id = 102`);
    assert.deepEqual([b.iban, b.geaendert_von], ['AT611904300234573201', 'formular (Stefan)']);
    assert.equal((await q('select count(*)::int n from public.formular_iban_offen'))[0].n, 1);   // nur noch 4 (IBAN kaputt)
    await raus();
    await als(ANNA);
    await nein('select public.formular_iban_zuordnen(4, 101)', [], /Nicht autorisiert/);
    await nein('select public.formular_iban_verwerfen(4)', [], /Nicht autorisiert/);
    // Fahrer koennen ueber die Zuordnungsfunktion keine fremden Fahrer-Nummern erfragen
    assert.equal((await q(`select (public.formular_iban_fahrer('06603333333', 'Cem', 'Fahr')).p_nr as nr`))[0].nr, null);
    await raus();
  }
  // --- Revolut-Export (migrations/2026-10-15-auszahlung-export.sql)
  await db.exec(lies('../migrations/2026-10-15-auszahlung-export.sql'));
  await als(ANNA);
  await q(`select public.bank_bestaetigen('2026-W41', 'AT611904300234573201')`);   // Anna bestaetigt ihre aktuelle IBAN
  await nein(`select * from public.auszahlung_liste('2026-W41')`, [], /Nicht autorisiert/);
  await nein(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":101,"betrag":450}]'::jsonb)`, [], /Nicht autorisiert/);
  await raus();
  await als(BUERO);
  let li = await q(`select * from public.auszahlung_liste('2026-W41') order by name`);
  // Korrektur Betreiber 15.10.: auch nicht bestaetigte IBANs kommen auf die Liste (aktuell hinterlegte IBAN)
  assert.deepEqual(li.map((r) => [r.name, r.notion_fahrer_id, Number(r.du_bekommst), r.iban, r.kontoinhaber, r.bestaetigt, Number(r.exportiert)]), [
    ['Anna Fahr', 101, 450, 'AT611904300234573201', 'Anna Fahr', true, 0],        // zwei Zeilen (Alias) summiert, bestaetigt
    ['Bert Fahr', 102, -200, 'AT611904300234573201', 'Unbe Kannt', false, 0],     // negativ; IBAN aus dem Formular-Eintrag 3
    ['Cem Fahr', 103, 300, 'GB82WEST12345698765432', 'Cem Fahr', false, 0]]);     // hinterlegt, nicht bestaetigt
  // Speichern: Betrag aenderbar, IBAN/Inhaber kommen aus der Bestaetigung, nie vom Browser
  let ex = await q(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":101,"betrag":400.5}]'::jsonb)`);
  assert.deepEqual(ex.map((r) => [r.name, r.iban, r.land, Number(r.betrag), r.referenz, r.bestaetigt]),
    [['Anna Fahr', 'AT611904300234573201', 'AT', 400.5, 'Auszahlung KW41 FHR-101', true]]);
  await nein(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":101,"betrag":400.5}]'::jsonb)`, [], /schon exportiert/);
  ex = await q(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":101,"betrag":49.5}]'::jsonb, true)`);
  assert.equal(ex.length, 1);
  ex = await q(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":103,"betrag":300}]'::jsonb)`);
  assert.deepEqual(ex.map((r) => [r.name, r.iban, r.land, r.bestaetigt]), [['Cem Fahr', 'GB82WEST12345698765432', 'GB', false]]);
  assert.equal((await q(`select bestaetigt from public.auszahlung_export where notion_fahrer_id = 103`))[0].bestaetigt, false);
  await nein(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":108,"betrag":10}]'::jsonb)`, [], /keine IBAN/);
  await nein(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":101,"betrag":0}]'::jsonb, true)`, [], /Betrag/);
  ex = await q(`select * from public.auszahlung_export_speichern('2026-W40', '[{"nr":101,"betrag":10}]'::jsonb)`);   // W40 nie bestaetigt
  assert.deepEqual(ex.map((r) => [r.iban, r.bestaetigt]), [['AT611904300234573201', false]]);
  await nein(`select * from public.auszahlung_export_speichern('2026-W41', '[]'::jsonb)`, [], /Keine Fahrer/);
  li = await q(`select name, exportiert from public.auszahlung_liste('2026-W41') where notion_fahrer_id = 101`);
  assert.equal(Number(li[0].exportiert), 450);
  assert.equal((await q(`select count(*)::int n from public.auszahlung_export where woche = '2026-W41'`))[0].n, 3);
  await raus();
  await als(ANNA);
  assert.equal((await q('select count(*)::int n from public.auszahlung_export'))[0].n, 0);   // Fahrer sehen keine Exporte
  await raus();

  // --- Buero-Pruefung statt Wochen-Bestaetigung (migrations/2026-10-18-fahrer-bankdaten.sql)
  await db.exec(lies('../migrations/2026-10-18-fahrer-bankdaten.sql'));
  // Uebernahme: Anna hat ihre aktuelle IBAN bestaetigt -> geprueft; Cem nie bestaetigt -> offen
  let gp = await q(`select notion_fahrer_id nr, geprueft, geprueft_von from public.fahrer_bank where notion_fahrer_id in (101, 103) order by 1`);
  assert.deepEqual(gp.map((r) => [r.nr, r.geprueft]), [[101, true], [103, false]]);
  assert.match(gp[0].geprueft_von, /Übernahme/);
  assert.equal(String((await q(`select public.iban_maskiert('LT12 1000 0111 0100 9859') m`))[0].m), 'LT•• •••• •••• •••• 9859');
  await als(ANNA);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.deepEqual([a.iban, a.geprueft, a.kontoinhaber], ['AT•• •••• •••• •••• 3201', true, 'Anna Fahr']);   // nur maskiert
  await nein(`select public.bank_bestaetigen('2026-W41', 'AT611904300234573201')`, [], /permission denied/);   // abgeschaltet
  await nein(`select public.bank_pruefen(101, 'AT611904300234573201')`, [], /Nicht autorisiert/);
  await raus();
  await db.exec(`update public.fahrer_bank set revolut_counterparty_id = 'cp-alt' where notion_fahrer_id = 101`);
  await als(ANNA);
  await q(`select public.fahrer_bank_setzen('Anna Fahr', 'DE89 3704 0044 0532 0130 00')`);   // neue IBAN gilt, aber ungeprueft
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.deepEqual([a.iban, a.geprueft], ['DE•• •••• •••• •••• ••30 00', false]);
  await raus();
  assert.deepEqual(Object.values((await q(`select geprueft, geprueft_am, revolut_counterparty_id from public.fahrer_bank where notion_fahrer_id = 101`))[0]),
    [false, null, null]);
  await als(BUERO);
  let [ub] = await q(`select geprueft, iban_geaendert_am from public.bank_uebersicht where notion_fahrer_id = 101`);
  assert.equal(ub.geprueft, false); assert.ok(ub.iban_geaendert_am);   // echter IBAN-Wechsel -> 14-Tage-Hinweis
  [ub] = await q(`select iban_geaendert_am from public.bank_uebersicht where notion_fahrer_id = 103`);
  assert.equal(ub.iban_geaendert_am, null);                            // nur Ersteintragung: kein Hinweis
  await nein(`select public.bank_pruefen(101, 'AT611904300234573201')`, [], /inzwischen geändert/);   // alte IBAN gesehen
  await nein(`select public.bank_pruefen(108, 'AT611904300234573201')`, [], /Keine Bankdaten/);
  await q(`select public.bank_pruefen(101, 'DE89370400440532013000')`);
  gp = await q(`select geprueft, geprueft_von from public.bank_uebersicht where notion_fahrer_id = 101`);
  assert.deepEqual([gp[0].geprueft, gp[0].geprueft_von], [true, 'Stefan']);
  li = await q(`select name, iban, bestaetigt from public.auszahlung_liste('2026-W41') where notion_fahrer_id in (101, 103) order by name`);
  assert.deepEqual(li.map((r) => [r.name, r.iban, r.bestaetigt]),
    [['Anna Fahr', 'DE89370400440532013000', true], ['Cem Fahr', 'GB82WEST12345698765432', false]]);
  ex = await q(`select * from public.auszahlung_export_speichern('2026-W41', '[{"nr":103,"betrag":5}]'::jsonb, true)`);
  assert.deepEqual(ex.map((r) => [r.iban, r.bestaetigt]), [['GB82WEST12345698765432', false]]);
  // Buero aendert -> ebenfalls wieder ungeprueft
  await q(`select public.buero_bank_setzen(101, 'Anna Fahr', 'DE89370400440532013000', 'COBADEFF')`);
  assert.equal((await q(`select geprueft from public.bank_uebersicht where notion_fahrer_id = 101`))[0].geprueft, false);
  await raus();
  await db.exec('set role anon');
  await nein('select * from public.fahrer_app_bank()', [], /permission denied/);
  await nein(`select public.bank_pruefen(101, 'x')`, [], /permission denied/);
  await raus();

  // --- Revolut-API (migrations/2026-10-18-revolut-zahlungen.sql)
  await db.exec(`create role service_role bypassrls; grant usage on schema public to service_role;`);
  await db.exec(lies('../migrations/2026-10-18-revolut-zahlungen.sql'));
  await db.exec(`grant select, insert, update on public.revolut_zahlungen, public.revolut_webhook_events, public.fahrer_bank to service_role`);
  await als(BUERO);
  await q(`select public.bank_pruefen(101, 'DE89370400440532013000')`);
  await raus();
  await db.exec('set role service_role');
  let rk = await q(`select * from public.revolut_kandidaten('2026-W41')`);
  assert.deepEqual(rk.map((r) => [r.notion_fahrer_id, Number(r.betrag), r.geprueft, Number(r.csv_exportiert) > 0]),
    [[101, 450, true, true], [102, -200, false, false], [103, 300, false, true]]);
  assert.equal((await q(`select count(*)::int n from public.revolut_kandidaten('2026-W39')`))[0].n, 0);   // nicht freigegeben
  // Gegenpartei nur bei unveraenderter, gepruefter IBAN
  assert.equal((await q(`select public.revolut_counterparty_setzen(101, 'AT611904300234573201', 'cp1', 'acc1', 'iban') ok`))[0].ok, false);
  assert.equal((await q(`select public.revolut_counterparty_setzen(101, 'DE89370400440532013000', 'cp1', 'acc1', 'iban') ok`))[0].ok, true);
  const P = (nr, ref) => JSON.stringify([{ nr, name: 'Anna Fahr', betrag: 450, iban_ende: '3000', empfaenger: 'iban', referenz: ref, cp: 'cp1' }]);
  assert.deepEqual((await q(`select public.revolut_reservieren('2026-W41', $1::jsonb, 'Stefan') nr`, [P(101, 'Auszahlung KW41/26 FHR-101')])).map((r) => r.nr), [101]);
  assert.equal((await q(`select public.revolut_reservieren('2026-W41', $1::jsonb, 'Stefan') nr`, [P(101, 'Auszahlung KW41/26 FHR-101')])).length, 0);   // nie doppelt
  await db.exec(`update public.revolut_zahlungen set status = 'entwurf', revolut_draft_id = 'd1'`);
  assert.equal((await q(`select public.revolut_reservieren('2026-W41', $1::jsonb, 'Stefan') nr`, [P(101, 'Auszahlung KW41/26 FHR-101')])).length, 0);
  await db.exec(`update public.revolut_zahlungen set status = 'verworfen'`);
  assert.equal((await q(`select public.revolut_reservieren('2026-W41', $1::jsonb, 'Stefan') nr`, [P(101, 'Auszahlung KW41/26 FHR-101')])).length, 1);   // nach Verwerfen neu
  assert.deepEqual(Object.values((await q(`select status, revolut_draft_id from public.revolut_zahlungen`))[0]), ['reserviert', null]);
  rk = await q(`select zahlung_status, counterparty_id from public.revolut_kandidaten('2026-W41') where notion_fahrer_id = 101`);
  assert.deepEqual(Object.values(rk[0]), ['reserviert', 'cp1']);
  await raus();
  // Bankdaten geaendert (auch per Hand/SQL) -> Gegenpartei und Pruefung weg
  await db.exec(`update public.fahrer_bank set bic = 'DEUTDEFF' where notion_fahrer_id = 101`);
  assert.deepEqual(Object.values((await q(`select geprueft, revolut_counterparty_id, revolut_counterparty_account_id from public.fahrer_bank where notion_fahrer_id = 101`))[0]),
    [false, null, null]);
  await als(BUERO);
  assert.equal((await q('select count(*)::int n from public.revolut_zahlungen'))[0].n, 1);
  await nein(`select * from public.revolut_kandidaten('2026-W41')`, [], /permission denied/);
  await nein(`select public.revolut_reservieren('2026-W41', '[]'::jsonb, 'x')`, [], /permission denied/);
  await nein(`insert into public.revolut_zahlungen (woche, notion_fahrer_id, name, betrag, empfaenger, referenz, erstellt_von) values ('x', 1, 'x', 1, 'iban', 'r', 'x')`, [], /permission denied/);
  await raus();
  await als(ANNA);
  assert.equal((await q('select count(*)::int n from public.revolut_zahlungen'))[0].n, 0);   // Fahrer sehen nichts
  await nein('select * from public.revolut_webhook_events', [], /permission denied/);
  await raus();

  // --- Ueberweisungshistorie (migrations/2026-10-18-revolut-buchungen.sql)
  await db.exec(lies('../migrations/2026-10-18-revolut-buchungen.sql'));
  await db.exec(`grant select, insert, update on public.revolut_buchungen, public.revolut_abruf to service_role;
    update public.revolut_zahlungen set revolut_transaction_id = 'tx-ent', status = 'completed' where notion_fahrer_id = 101;
    insert into public.revolut_buchungen (id, typ, state, erstellt_am, betrag, referenz, gegen_name, gegen_iban) values
      ('tx-ent', 'transfer', 'completed', now(), 450, 'egal', 'Anna Fahr', null),                          -- eigener Entwurf
      ('tx-ref', 'transfer', 'completed', now(), 300, 'Auszahlung KW41 FHR-103', 'Cem', null),            -- Referenz
      ('tx-alt', 'transfer', 'completed', now(), 99, 'Auszahlung KW40 FHR-103', 'Cem', null),             -- andere KW
      ('tx-ib1', 'transfer', 'completed', '2026-01-05', 120, null, 'C. Fahr', 'GB82WEST12345698765432'),  -- IBAN eindeutig (Cem)
      ('tx-ib2', 'transfer', 'completed', '2026-01-06', 80, null, 'Unbe Kannt', 'AT611904300234573201'),  -- IBAN Anna (alt) UND Bert
      ('tx-lief', 'transfer', 'completed', '2026-02-01', 1000, 'Rechnung 17', 'Reifen GmbH', null),
      ('tx-lief2', 'transfer', 'completed', '2026-03-01', 500, 'Rechnung 18', 'Reifen GmbH', null)`);
  await db.exec('set role service_role');
  assert.equal((await q('select public.revolut_buchungen_zuordnen() n'))[0].n, 3);   // offen: ib2 + 2x Lieferant
  await raus();
  const zu = Object.fromEntries((await q(`select id, notion_fahrer_id nr, zuordnung from public.revolut_buchungen`)).map((r) => [r.id, [r.nr, r.zuordnung]]));
  assert.deepEqual(zu, { 'tx-ent': [101, 'entwurf'], 'tx-ref': [103, 'referenz'], 'tx-alt': [103, 'referenz'],
    'tx-ib1': [103, 'iban'], 'tx-ib2': [null, null], 'tx-lief': [null, null], 'tx-lief2': [null, null] });
  await als(BUERO);
  let off = await q(`select schluessel, anzahl, summe from public.revolut_buchungen_offen order by schluessel`);
  assert.deepEqual(off.map((r) => [r.schluessel, r.anzahl, Number(r.summe)]),
    [['iban:AT611904300234573201', 1, 80], ['name:reifen gmbh', 2, 1500]]);
  assert.equal((await q(`select public.revolut_gegenpartei_zuordnen('name:reifen gmbh', null) n`))[0].n, 1);   // kein Fahrer
  assert.equal((await q(`select public.revolut_gegenpartei_zuordnen('iban:AT611904300234573201', 102) n`))[0].n, 0);
  assert.equal((await q(`select notion_fahrer_id nr from public.revolut_buchungen where id = 'tx-ib2'`))[0].nr, 102);
  await nein(`select public.revolut_gegenpartei_zuordnen('name:x', 999)`, [], /Kein Fahrer/);
  // "kein Fahrer" fuer eine Gegenpartei darf eine Auszahlung mit FHR-Referenz nie ueberstimmen
  await q(`select public.revolut_gegenpartei_zuordnen('name:cem', null)`);
  assert.deepEqual(Object.values((await q(`select notion_fahrer_id, zuordnung from public.revolut_buchungen where id = 'tx-ref'`))[0]), [103, 'referenz']);
  await raus();
  await als(ANNA);
  await nein(`select public.revolut_gegenpartei_zuordnen('name:x', 101)`, [], /Nicht autorisiert/);
  assert.deepEqual((await q('select betrag from public.fahrer_app_ueberweisungen()')).map((r) => Number(r.betrag)), [450]);   // nur eigene
  assert.equal((await q('select count(*)::int n from public.revolut_buchungen'))[0].n, 0);   // direkt: nichts
  await raus();
  // Sperre: Cem bekam seit der Freigabe von W41 schon 300 (KW41); die KW40-Zahlung zaehlt nicht mit
  await db.exec('set role service_role');
  rk = await q(`select notion_fahrer_id nr, seit_freigabe_ueberwiesen s from public.revolut_kandidaten('2026-W41') order by 1`);
  assert.deepEqual(rk.map((r) => [r.nr, Number(r.s)]), [[101, 0], [102, 0], [103, 300]]);
  await raus();

  console.log('OK');
} catch (e) {
  console.error('FEHLER: ' + (e && e.message || e)); console.error(e && e.stack);
  process.exit(1);
}
