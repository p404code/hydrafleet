-- Asserts fuer migrations/2026-10-08-protokoll.sql. Laeuft ueber scripts/test-protokoll.mjs (lokales Postgres,
-- Tabellen-Nachbau in test-protokoll-schema.sql) in einer Transaktion. Bestanden = kein Fehler.

-- === 1) Buero-Benutzer aendert eine Korrektur ===
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"app_role":"user","app_name":"Testuser"}}', true);
set local role authenticated;
update public.settlements
   set korrektur = coalesce(korrektur, 0) - 70, korrektur_note = 'Protokolltest'
 where id = (select max(id) from public.settlements);
-- 2) nur eine nicht ueberwachte Spalte -> keine Zeile
update public.settlements set created_at = created_at + interval '1 second'
 where id = (select max(id) from public.settlements);
-- 5) user sieht nichts
do $$ declare n int; begin
  select count(*) into n from public.protokoll;
  assert n = 0, format('user sieht %s protokollzeilen', n);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$ declare r public.protokoll; n int; begin
  select count(*) into n from public.protokoll where not altbestand and tabelle = 'settlements';
  assert n = 1, format('settlements: erwartet 1 zeile, sind %s', n);
  select * into r from public.protokoll where not altbestand and tabelle = 'settlements';
  assert r.akteur_art = 'buero' and r.akteur = 'Testuser', 'akteur falsch: ' || r.akteur_art || '/' || r.akteur;
  assert r.auth_uid = '00000000-0000-0000-0000-000000000001', 'auth_uid fehlt';
  assert r.aktion = 'geaendert', 'aktion ' || r.aktion;
  assert r.felder = array['korrektur','korrektur_note'], 'felder ' || r.felder::text;
  assert (r.neu->>'korrektur')::numeric = coalesce((r.alt->>'korrektur')::numeric, 0) - 70, 'alt/neu stimmen nicht';
  assert r.neu->>'korrektur_note' = 'Protokolltest', 'notiz fehlt';
  assert r.woche is not null and r.zeile is not null, 'woche/zeile leer';
  assert not (r.neu ? 'created_at'), 'nicht ueberwachte spalte im protokoll';
end $$;

-- === 3) name_aliases: anlegen + loeschen ohne JWT (= SQL-Fenster), ohne Woche ===
insert into public.name_aliases (csv_name, fahrer_name) values ('__protokolltest__', 'Test Fahrer');
delete from public.name_aliases where csv_name = '__protokolltest__';
do $$ declare r public.protokoll; begin
  select * into r from public.protokoll where tabelle = 'name_aliases' and aktion = 'neu' and zeile = '__protokolltest__';
  assert found, 'name_aliases neu fehlt';
  assert r.akteur_art = 'sql' and r.akteur = 'SQL-Fenster', 'sql-akteur falsch: ' || r.akteur;
  assert r.woche is null and r.fahrer = 'Test Fahrer', 'fahrer/woche falsch';
  assert r.alt is null and r.neu->>'fahrer_name' = 'Test Fahrer', 'neu falsch';
  select * into r from public.protokoll where tabelle = 'name_aliases' and aktion = 'geloescht' and zeile = '__protokolltest__';
  assert found, 'name_aliases geloescht fehlt';
  assert r.neu is null and r.alt->>'fahrer_name' = 'Test Fahrer', 'alt beim loeschen falsch';
end $$;

-- === lohn_personen: zusammengesetzter Schluessel ===
update public.lohn_personen set gesetzt_von = coalesce(gesetzt_von, '') || ' (Test)'
 where ctid = (select ctid from public.lohn_personen limit 1);
do $$ declare r public.protokoll; begin
  select * into r from public.protokoll where not altbestand and tabelle = 'lohn_personen';
  assert found, 'lohn_personen fehlt';
  assert r.zeile like '%/%', 'zeile nicht zusammengesetzt: ' || r.zeile;
end $$;

-- === post_eingang: nur Entscheidungsfelder ===
update public.post_eingang set volltext = coalesce(volltext, '') || ' x'
 where id = (select id from public.post_eingang limit 1);
update public.post_eingang set notiz = 'Protokolltest'
 where id = (select id from public.post_eingang limit 1);
do $$ declare r public.protokoll; n int; begin
  select count(*) into n from public.protokoll where tabelle = 'post_eingang';
  assert n = 1, format('post_eingang: erwartet 1, sind %s', n);
  select * into r from public.protokoll where tabelle = 'post_eingang';
  assert r.felder = array['notiz'], 'post felder ' || r.felder::text;
  assert not (r.neu ? 'volltext'), 'volltext im protokoll';
end $$;

-- === 4) service_role = Automatik, darf selbst nicht ins Protokoll schreiben ===
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
update public.settlements set miete = coalesce(miete, 0) + 1
 where id in (select id from public.settlements
               where woche = (select max(woche) from public.settlements) order by id limit 3);
do $$ begin
  begin
    insert into public.protokoll (akteur_art, akteur, tabelle, aktion) values ('buero', 'Gefaelscht', 'settlements', 'neu');
    assert false, 'service_role kann ins protokoll schreiben';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
do $$ declare n int; begin
  select count(*) into n from public.protokoll where akteur_art = 'automatik' and akteur = 'Automatik' and tabelle = 'settlements';
  assert n = 3, format('automatik: erwartet 3, sind %s', n);
end $$;

-- === 7) Fahrer sieht nichts ===
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"fahrer_nr":14}}', true);
set local role authenticated;
do $$ declare n int; begin
  select count(*) into n from public.protokoll;
  assert n = 0, 'fahrer sieht protokoll';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- === 6) Sperre: auch ohne JWT kein UPDATE/DELETE/TRUNCATE ===
do $$ begin
  begin update public.protokoll set akteur = 'x'; assert false, 'update moeglich';
  exception when insufficient_privilege then null; end;
  begin delete from public.protokoll; assert false, 'delete moeglich';
  exception when insufficient_privilege then null; end;
  begin truncate public.protokoll; assert false, 'truncate moeglich';
  exception when insufficient_privilege then null; end;
end $$;
