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

-- ====================== Task 2: protokoll_verlauf + Altbestand ======================
-- user -> 42501
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"app_role":"user","app_name":"Testuser"}}', true);
set local role authenticated;
do $$ begin
  begin perform * from public.protokoll_verlauf(); assert false, 'verlauf fuer user offen';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- admin
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"app_role":"admin","app_name":"Testadmin"}}', true);
set local role authenticated;
do $$ declare r record; n int; m int; begin
  -- Sammelzeile: die 3 Automatik-Aenderungen an settlements aus Task-1-Test
  select * into r from public.protokoll_verlauf(p_art => 'automatik', p_bereich => 'geld');
  assert found, 'keine automatik-zeile';
  assert r.anzahl = 3 and array_length(r.ids, 1) = 3, format('sammelzeile: anzahl %s', r.anzahl);
  assert r.aktion = 'geaendert' and r.alt is null and r.neu is null, 'sammelzeile hat einzelwerte';
  assert r.woche is not null, 'sammelzeile ohne woche';

  -- Einzelzeile Mensch mit alt/neu
  select * into r from public.protokoll_verlauf(p_akteur => 'Testuser');
  assert found and r.anzahl = 1 and r.tabelle = 'settlements' and r.bereich = 'geld', 'testuser-zeile falsch';
  assert r.felder = array['korrektur','korrektur_note'] and r.neu ? 'korrektur', 'einzelzeile ohne werte';

  -- Filter Mensch: nichts von der Automatik
  select count(*) into n from public.protokoll_verlauf(p_art => 'mensch', p_limit => 1000) v where v.akteur_art = 'automatik';
  assert n = 0, 'mensch-filter laesst automatik durch';

  -- Nur Loeschungen
  select count(*), count(*) filter (where v.aktion in ('geloescht', 'storno')) into n, m
    from public.protokoll_verlauf(p_nur_loeschungen => true, p_limit => 1000) v;
  assert n >= 1 and n = m, format('nur_loeschungen: %s zeilen, davon %s loeschungen', n, m);

  -- Fahrer-Filter trifft den Alias-Test, und nur protokoll-Zeilen
  select count(*), count(*) filter (where v.quelle = 'protokoll') into n, m
    from public.protokoll_verlauf(p_fahrer => 'Test Fahrer') v;
  assert n = 2 and m = 2, format('fahrer-filter: %s/%s', n, m);

  -- Sync-Laeufe gebuendelt: je Verbindung, Tag und Status hoechstens eine Zeile
  select count(*) into n from (
    select 1 from public.protokoll_verlauf(p_bereich => 'sync', p_limit => 1000) v
     group by v.neu->>'anbieter', v.neu->>'firma', v.aktion, (v.zeit at time zone 'Europe/Vienna')::date
    having count(*) > 1) d;
  assert n = 0, 'sync-laeufe nicht gebuendelt';

  -- Seitenweise, neueste zuerst
  select count(*) into n from public.protokoll_verlauf(p_limit => 5);
  assert n <= 5, 'limit greift nicht';
  select count(*) into n from (
    select v.zeit, lag(v.zeit) over () as davor from public.protokoll_verlauf(p_limit => 50) v) s
   where s.davor < s.zeit;
  assert n = 0, 'nicht absteigend sortiert';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- Altbestand: je Quellzeile genau eine Zeile
do $$ declare n int; soll int; begin
  select count(*) into n from public.protokoll where altbestand;
  select (select count(*) from public.abrechnung_freigaben) + (select count(*) from public.abrechnung_posten)
       + (select count(*) from public.kassier_zahlungen)    + (select count(*) from public.zuordnung_manuell)
       + (select count(*) from public.lohn_personen)        + (select count(*) from public.fahrer_app_zugang) into soll;
  assert n = soll, format('altbestand: %s statt %s', n, soll);
  select count(*) into n from public.protokoll where altbestand and (aktion <> 'neu' or akteur_art <> 'buero');
  assert n = 0, 'altbestand mit falscher aktion/akteur';
end $$;

-- Edge Function schreibt im Auftrag eines Mitarbeiters (service_role, Name in der Zeile) -> auftrag
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.fahrer_app_zugang (notion_fahrer_id, auth_user_id, angelegt_von) values (77, gen_random_uuid(), 'Stefan');
reset role;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"app_role":"admin","app_name":"Testadmin"}}', true);
set local role authenticated;
do $$ declare r record; begin
  select * into r from public.protokoll_verlauf(p_akteur => 'Stefan', p_bereich => 'zugaenge');
  assert found, 'auftrag: zeile ueber den namen nicht gefunden';
  assert r.akteur_art = 'automatik' and r.auftrag = 'Stefan' and r.fahrer = 'Fahrer-ID 77', 'auftrag falsch: ' || coalesce(r.auftrag, 'null');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ====================== Nach der Pruefung (Review) ======================
-- post_eingang.fahrer_id zeigt auf fahrer(id), nicht auf die Notion-Nummer; GZ steht immer dabei
update public.post_eingang set fahrer_id = 14, status = 'zugeordnet' where gz = 'MA67/1';
do $$ declare r public.protokoll; begin
  select * into r from public.protokoll where tabelle = 'post_eingang' and 'fahrer_id' = any (felder);
  assert found, 'post zuordnung fehlt';
  assert r.fahrer = 'Karl Probe', 'post: falscher fahrer ' || coalesce(r.fahrer, 'null');
  assert r.neu->>'gz' = 'MA67/1' and r.alt->>'gz' = 'MA67/1', 'post: gz fehlt';
  assert r.felder = array['fahrer_id','status'], 'post felder ' || r.felder::text;
end $$;

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"app_role":"admin","app_name":"Testadmin"}}', true);
set local role authenticated;
do $$ declare n int; a text[]; begin
  -- im Auftrag eines Mitarbeiters = Mensch, nicht Automatik
  select count(*) into n from public.protokoll_verlauf(p_art => 'mensch', p_limit => 1000) v where v.auftrag = 'Stefan';
  assert n = 1, format('mensch-filter: auftrag-zeile %s mal', n);
  select count(*) into n from public.protokoll_verlauf(p_art => 'automatik', p_limit => 1000) v where v.auftrag is not null;
  assert n = 0, 'automatik-filter zeigt auftrag-zeilen';
  -- gleiche Zeit: spaeter geschriebene Zeile zuerst (stabile Reihenfolge fuers Blaettern)
  select array_agg(v.aktion) into a from public.protokoll_verlauf(p_fahrer => 'Test Fahrer') v;
  assert a = array['geloescht','neu'], 'reihenfolge bei gleicher zeit: ' || a::text;
  select count(distinct coalesce(v.zeile, '') || v.aktion || v.tabelle || coalesce(v.felder::text, '')) into n from (
    select * from public.protokoll_verlauf(p_art => 'mensch', p_limit => 3, p_offset => 0)
    union all select * from public.protokoll_verlauf(p_art => 'mensch', p_limit => 3, p_offset => 3)) v;
  assert n = 6, format('blaettern liefert doppelte: %s von 6 verschieden', n);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
