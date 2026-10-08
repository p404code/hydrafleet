# Protokoll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein fälschungssicheres Protokoll „wer hat was geändert“ (Mensch + Automatik) in HYDRAlink, sichtbar nur für die Rolle `admin`.

**Architecture:** Ein gemeinsamer Postgres-Trigger schreibt jede Änderung an zwölf Tabellen in `public.protokoll` (gesperrt gegen UPDATE/DELETE/TRUNCATE, lesbar nur für `is_app_admin()`). Die Funktion `protokoll_verlauf()` mischt das mit `sync_runs`, `post_ausgang` und `kassabuch` zu einem Verlauf. Das Dashboard zeigt ihn im neuen Reiter „Protokoll“ und baut die Sätze im Browser.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Vanilla JS in `dashboard.html`, `node --test` für die Satz-Logik. Kein `psql`/Supabase-CLI auf dem Rechner – SQL läuft über das Supabase-MCP (`execute_sql`, Projekt `pkxcwfkfaaorwnbdmylg`).

**Spec:** `docs/superpowers/specs/2026-10-08-protokoll-design.md`

## Global Constraints

- `settlements`, AbrechnungsBot, Notion, CSV-Upload werden **nur beobachtet**. Kein Trigger darf einen Schreibvorgang scheitern lassen (Fehler → `raise warning`).
- Wer (`akteur`) kommt nur aus `auth.jwt()`, nie aus einem Parameter.
- `protokoll`: kein INSERT/UPDATE/DELETE für `anon`, `authenticated`, `service_role`; SELECT nur `is_app_admin()`.
- Reiter nur bei `app_role = admin`; die Sperre selbst liegt in der Datenbank.
- Namensschema: `contentProtokoll`, JS-Hülle `Proto`, IDs/Klassen `pr…`. Tabellen statt Karten.
- Migration `migrations/2026-10-08-protokoll.sql` enthält **kein** `begin`/`commit` und ist wiederholbar (`if not exists`, `create or replace`, `drop trigger if exists`).
- Live einspielen erst nach ausdrücklichem OK des Betreibers (Task 5). Push macht der Betreiber: `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`.
- Bei jeder Dashboard-Änderung `sw.js` `CACHE_NAME` hochzählen (jetzt `hydralink-v31` → `hydralink-v32`).

### SQL-Test ausführen (gilt für Task 1 und 2)

Der Test läuft gegen die echte Datenbank, aber komplett in einer Transaktion, die zurückgerollt wird (DDL ist in Postgres transaktional):

```bash
{ echo 'begin;'; cat migrations/2026-10-08-protokoll.sql scripts/test-protokoll.sql; echo 'rollback;'; } > "$SCRATCH/protokoll-lauf.sql"
```

Den Inhalt von `protokoll-lauf.sql` als `query` an `mcp__claude_ai_Supabase__execute_sql` (project_id `pkxcwfkfaaorwnbdmylg`) geben. **Bestanden = kein Fehler.** Ein fehlgeschlagenes `assert` kommt als Fehler mit der Assert-Meldung zurück. Danach prüfen, dass nichts hängen blieb:

```sql
select to_regclass('public.protokoll') as tabelle;   -- vor Task 5: null
```

Nicht montags zwischen 06:00 und 09:00 laufen lassen (AbrechnungsBot/Syncs schreiben; der Test hält kurz Sperren auf `settlements`).

## Review Focus

1. **Bot rechnet eine Woche neu (viele Zeilen in einer Minute)** → der Verlauf zeigt eine Sammelzeile mit Anzahl, nicht 52 Einzelzeilen. Test: Task 2, Schritt 1 (`anzahl = 3`).
2. **Zeile ohne Fahrer und ohne Woche (z. B. `name_aliases`, `customers`)** → Protokollzeile entsteht trotzdem, `woche` leer. Test: Task 1, Schritt 1 (Block „name_aliases“).
3. **Zusammengesetzter Primärschlüssel (`lohn_personen`, `zuordnung_manuell`)** → `zeile` = Teile mit `/` verbunden. Test: Task 1, Schritt 1 (Block „lohn_personen“).
4. **Unbekannte Tabelle/Feld im Browser (später angehängte Tabelle)** → Satz fällt auf „Feld alt → neu“ zurück statt zu crashen. Test: Task 3, Schritt 1 (`unbekannte tabelle`).
5. **`user` hat `hydralink_tab = protokoll` im localStorage oder ruft `switchTab('protokoll')` in der Konsole** → landet auf „Abrechnungen“; die DB gibt ihm ohnehin nichts. Tests: Task 3 (`protoErlaubt`), Task 2 (`42501`).

---

### Task 1: Tabelle `protokoll`, Sperre und Trigger

**Files:**
- Create: `migrations/2026-10-08-protokoll.sql`
- Create: `scripts/test-protokoll.sql`

**Interfaces:**
- Produces: Tabelle `public.protokoll(id bigint, zeit timestamptz, akteur_art text, akteur text, auth_uid uuid, tabelle text, aktion text, zeile text, fahrer text, woche text, felder text[], alt jsonb, neu jsonb, altbestand boolean)`; `akteur_art ∈ {buero, fahrer, automatik, sql}`, `aktion ∈ {neu, geaendert, geloescht}`. Trigger `protokoll_mitschreiben` auf zwölf Tabellen.

- [ ] **Step 1: Test schreiben** – `scripts/test-protokoll.sql`

```sql
-- Test fuer migrations/2026-10-08-protokoll.sql. Laeuft NUR innerhalb begin; … rollback;
-- (siehe docs/superpowers/plans/2026-10-08-protokoll.md). Bestanden = kein Fehler.

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
```

- [ ] **Step 2: Test laufen lassen – muss scheitern**

`migrations/2026-10-08-protokoll.sql` zuerst als leere Datei anlegen (`: > migrations/2026-10-08-protokoll.sql`), dann wie oben unter „SQL-Test ausführen“.
Erwartet: Fehler `relation "public.protokoll" does not exist`.

- [ ] **Step 3: Migration schreiben** – `migrations/2026-10-08-protokoll.sql`

```sql
-- Protokoll: wer hat was geaendert. Spec: docs/superpowers/specs/2026-10-08-protokoll-design.md
-- * Die Datenbank schreibt selbst mit (Trigger protokoll_mitschreiben), nicht das Dashboard.
-- * Wer = auth.jwt(): Buero-Name, Fahrer-Nr., service_role (Automatik) oder kein JWT (SQL-Fenster).
-- * protokoll ist gesperrt: kein UPDATE/DELETE/TRUNCATE, auch nicht im SQL-Fenster.
-- * Lesen nur is_app_admin(). NICHT aufweichen.
-- Wiederholbar; ohne begin/commit.

create table if not exists public.protokoll (
  id         bigint generated always as identity primary key,
  zeit       timestamptz not null default now(),
  akteur_art text not null check (akteur_art in ('buero', 'fahrer', 'automatik', 'sql')),
  akteur     text not null,
  auth_uid   uuid,
  tabelle    text not null,
  aktion     text not null check (aktion in ('neu', 'geaendert', 'geloescht')),
  zeile      text,                 -- Primaerschluessel als Text, Teile mit / verbunden
  fahrer     text,
  woche      text,
  felder     text[],               -- geaenderte Spalten (nur bei geaendert)
  alt        jsonb,
  neu        jsonb,
  altbestand boolean not null default false
);
create index if not exists protokoll_zeit_idx on public.protokoll (zeit desc);
create index if not exists protokoll_tabelle_zeit_idx on public.protokoll (tabelle, zeit desc);

alter table public.protokoll enable row level security;
revoke all on public.protokoll from public, anon, authenticated, service_role;
grant select on public.protokoll to authenticated;
drop policy if exists protokoll_nur_admin on public.protokoll;
create policy protokoll_nur_admin on public.protokoll for select to authenticated using (public.is_app_admin());

create or replace function public.protokoll_gesperrt() returns trigger
language plpgsql as $$
begin
  raise exception 'Das Protokoll wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists protokoll_gesperrt on public.protokoll;
create trigger protokoll_gesperrt before update or delete on public.protokoll
  for each row execute function public.protokoll_gesperrt();
drop trigger if exists protokoll_gesperrt_alles on public.protokoll;
create trigger protokoll_gesperrt_alles before truncate on public.protokoll
  for each statement execute function public.protokoll_gesperrt();

-- Nur ueberwachte Spalten behalten. modus 'nur' = nur diese, 'ohne' = alle ausser diesen.
create or replace function public.protokoll_filter(p_zeile jsonb, p_modus text, p_spalten text[])
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(p_zeile) e
   where case when p_modus = 'nur' then e.key = any (p_spalten) else not (e.key = any (p_spalten)) end
$$;

-- Trigger-Argumente: (pk-spalten, modus, spalten, flag)
--   pk-spalten  'id' oder 'firma_nr,ma_nr'
--   modus       'ohne' | 'nur'
--   spalten     kommagetrennt, darf leer sein
--   flag        'ohne_neu' = INSERT nicht protokollieren
create or replace function public.protokoll_schreiben() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pk      text[] := string_to_array(tg_argv[0], ',');
  v_modus   text   := tg_argv[1];
  v_spalten text[] := string_to_array(coalesce(tg_argv[2], ''), ',');
  v_jwt jsonb; v_art text; v_wer text; v_uid uuid;
  v_voll jsonb; v_alt jsonb; v_neu jsonb; v_felder text[]; v_zeile text; v_fahrer text; v_fid text;
begin
  if tg_op = 'INSERT' and coalesce(tg_argv[3], '') = 'ohne_neu' then return null; end if;
  -- Ein Fehler hier darf den eigentlichen Schreibvorgang nie scheitern lassen.
  begin
    v_jwt := auth.jwt();
    if nullif(btrim(v_jwt->'app_metadata'->>'app_name'), '') is not null then
      v_art := 'buero';     v_wer := btrim(v_jwt->'app_metadata'->>'app_name');
    elsif nullif(v_jwt->'app_metadata'->>'fahrer_nr', '') is not null then
      v_art := 'fahrer';    v_wer := 'Fahrer ' || (v_jwt->'app_metadata'->>'fahrer_nr');
    elsif v_jwt->>'role' = 'service_role' then
      v_art := 'automatik'; v_wer := 'Automatik';
    elsif v_jwt is null then
      v_art := 'sql';       v_wer := 'SQL-Fenster';
    else
      v_art := 'sql';       v_wer := 'Unbekannt (' || coalesce(v_jwt->>'role', '?') || ')';
    end if;
    if (v_jwt->>'sub') ~ '^[0-9a-f-]{36}$' then v_uid := (v_jwt->>'sub')::uuid; end if;

    if tg_op = 'DELETE' then v_voll := to_jsonb(old); else v_voll := to_jsonb(new); end if;
    if tg_op <> 'INSERT' then v_alt := public.protokoll_filter(to_jsonb(old), v_modus, v_spalten); end if;
    if tg_op <> 'DELETE' then v_neu := public.protokoll_filter(to_jsonb(new), v_modus, v_spalten); end if;
    if tg_op = 'UPDATE' then
      select array_agg(k order by k) into v_felder
        from jsonb_object_keys(v_neu) k where v_alt->k is distinct from v_neu->k;
      if v_felder is null then return null; end if;
    end if;

    select string_agg(v_voll->>u.k, '/' order by u.ord) into v_zeile
      from unnest(v_pk) with ordinality u(k, ord);
    v_fahrer := nullif(v_voll->>'fahrer_name', '');
    if v_fahrer is null then
      v_fid := coalesce(v_voll->>'notion_fahrer_id', v_voll->>'fahrer_id');
      if v_fid ~ '^[0-9]+$' then
        select f.name into v_fahrer from public.notion_fahrer f where f.notion_fahrer_id = v_fid::int limit 1;
        v_fahrer := coalesce(v_fahrer, 'Fahrer-ID ' || v_fid);
      end if;
    end if;

    insert into public.protokoll (akteur_art, akteur, auth_uid, tabelle, aktion, zeile, fahrer, woche, felder, alt, neu)
    values (v_art, v_wer, v_uid, tg_table_name,
            case tg_op when 'INSERT' then 'neu' when 'UPDATE' then 'geaendert' else 'geloescht' end,
            v_zeile, v_fahrer, nullif(v_voll->>'woche', ''), v_felder, v_alt, v_neu);
  exception when others then
    raise warning 'protokoll_schreiben(%): %', tg_table_name, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.protokoll_schreiben() from public, anon, authenticated;

-- Trigger je Tabelle. Neue Tabelle ueberwachen = hier eine Zeile anhaengen.
do $$
declare r record;
begin
  for r in select * from (values
    ('settlements',          'id',                   'ohne', 'telegram_gesendet,created_at', ''),
    ('abrechnung_posten',    'id',                   'ohne', '', ''),
    ('kassier_zahlungen',    'id',                   'ohne', '', ''),
    ('abrechnung_freigaben', 'woche',                'ohne', '', ''),
    ('post_eingang',         'id',                   'nur',  'fahrer_id,status,freigegeben_am,freigegeben_von,erledigt_am,erledigt_von,notiz,betrag,art', 'ohne_neu'),
    ('mietverhaeltnisse',    'id',                   'ohne', '', ''),
    ('zuordnung_manuell',    'anbieter,driver_uuid', 'ohne', '', ''),
    ('lohn_personen',        'firma_nr,ma_nr',       'ohne', '', ''),
    ('name_aliases',         'csv_name',             'ohne', '', ''),
    ('fahrer_app_zugang',    'notion_fahrer_id',     'ohne', '', ''),
    ('customers',            'id',                   'ohne', '', ''),
    ('companies',            'id',                   'ohne', '', '')
  ) t(tab, pk, modus, spalten, flag) loop
    execute format('drop trigger if exists protokoll_mitschreiben on public.%I', r.tab);
    execute format('create trigger protokoll_mitschreiben after insert or update or delete on public.%I
                    for each row execute function public.protokoll_schreiben(%L, %L, %L, %L)',
                   r.tab, r.pk, r.modus, r.spalten, r.flag);
  end loop;
end $$;
```

- [ ] **Step 4: Test laufen lassen – muss bestehen**

Wie unter „SQL-Test ausführen“. Erwartet: kein Fehler. Danach `select to_regclass('public.protokoll')` → `null` (Rollback hat gegriffen).

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-10-08-protokoll.sql scripts/test-protokoll.sql
git commit -m "protokoll: tabelle, sperre und trigger auf 12 tabellen (noch nicht eingespielt); sql-test mit rollback"
```

---

### Task 2: `protokoll_verlauf()` und Altbestand

**Files:**
- Modify: `migrations/2026-10-08-protokoll.sql` (anhängen)
- Modify: `scripts/test-protokoll.sql` (anhängen)

**Interfaces:**
- Consumes: Tabelle `public.protokoll` aus Task 1.
- Produces: `public.protokoll_verlauf(p_art text, p_akteur text, p_bereich text, p_fahrer text, p_von date, p_bis date, p_nur_loeschungen boolean, p_limit int, p_offset int)` → Zeilen `(zeit timestamptz, quelle text, akteur_art text, akteur text, auftrag text, tabelle text, bereich text, aktion text, zeile text, fahrer text, woche text, anzahl int, ids bigint[], felder text[], alt jsonb, neu jsonb, altbestand boolean)`.
  - `quelle ∈ {protokoll, sync, post, kassa}`; `p_art ∈ {null, 'mensch', 'automatik'}`.
  - `bereich ∈ {geld, freigaben, post, zuordnungen, zugaenge, stammdaten, kassa, sync, sonst}`.
  - `aktion`: bei `protokoll` `neu|geaendert|geloescht|gemischt`; bei `sync` `ok|fehler`; bei `post` `gesendet`; bei `kassa` `ein|aus|anfang|storno`.
  - Sammelzeile: `anzahl > 1`, `ids` gefüllt, `alt`/`neu`/`zeile`/`fahrer` leer.
  - `neu` bei `sync`: `{anbieter, firma, zeilen, fehler}`; bei `post`: `{an, gz, betreff, test_an, quelle}`; bei `kassa`: `{nr, datum, art, betrag, text, quelle, storno_von}`.

- [ ] **Step 1: Test anhängen** – ans Ende von `scripts/test-protokoll.sql`

```sql
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
```

- [ ] **Step 2: Test laufen lassen – muss scheitern**

Erwartet: Fehler `function public.protokoll_verlauf() does not exist`.

- [ ] **Step 3: Migration erweitern** – ans Ende von `migrations/2026-10-08-protokoll.sql`

```sql
-- === Verlauf: protokoll + sync_runs + post_ausgang + kassabuch, nur admin ===
create or replace function public.protokoll_bereich(p_tabelle text) returns text
language sql immutable as $$
  select case p_tabelle
    when 'settlements' then 'geld' when 'abrechnung_posten' then 'geld' when 'kassier_zahlungen' then 'geld'
    when 'abrechnung_freigaben' then 'freigaben'
    when 'post_eingang' then 'post' when 'mietverhaeltnisse' then 'post' when 'post_ausgang' then 'post'
    when 'zuordnung_manuell' then 'zuordnungen' when 'lohn_personen' then 'zuordnungen' when 'name_aliases' then 'zuordnungen'
    when 'fahrer_app_zugang' then 'zugaenge'
    when 'customers' then 'stammdaten' when 'companies' then 'stammdaten'
    when 'kassabuch' then 'kassa' when 'sync_runs' then 'sync'
    else 'sonst' end
$$;

create or replace function public.protokoll_verlauf(
  p_art text default null, p_akteur text default null, p_bereich text default null, p_fahrer text default null,
  p_von date default null, p_bis date default null, p_nur_loeschungen boolean default false,
  p_limit int default 100, p_offset int default 0)
returns table (zeit timestamptz, quelle text, akteur_art text, akteur text, auftrag text, tabelle text, bereich text,
               aktion text, zeile text, fahrer text, woche text, anzahl int, ids bigint[], felder text[],
               alt jsonb, neu jsonb, altbestand boolean)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_app_admin() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  return query
  with p as (
    -- Automatik-Zeilen gleicher Tabelle/Woche/Minute werden zu einer Sammelzeile
    select max(x.zeit) as zeit, 'protokoll'::text as quelle, x.akteur_art, x.akteur,
           case when count(*) = 1 and x.akteur_art = 'automatik' and min(x.aktion) = 'neu'
                then nullif(coalesce((array_agg(x.neu))[1]->>'angelegt_von', (array_agg(x.neu))[1]->>'gesetzt_von'), '') end as auftrag,
           x.tabelle, public.protokoll_bereich(x.tabelle) as bereich,
           case when min(x.aktion) = max(x.aktion) then min(x.aktion) else 'gemischt' end as aktion,
           case when count(*) = 1 then min(x.zeile) end as zeile,
           case when count(*) = 1 then min(x.fahrer) end as fahrer,
           x.woche, count(*)::int as anzahl,
           case when count(*) > 1 then array_agg(x.id order by x.id) end as ids,
           case when count(*) = 1 then min(x.id) end as eine_id,
           case when count(*) = 1 then (array_agg(x.alt))[1] end as alt,
           case when count(*) = 1 then (array_agg(x.neu))[1] end as neu,
           x.altbestand
      from public.protokoll x
     where (p_fahrer is null or x.fahrer ilike '%' || p_fahrer || '%')
       and (not p_nur_loeschungen or x.aktion = 'geloescht')
     group by x.akteur_art, x.akteur, x.tabelle, x.woche, x.altbestand,
              case when x.akteur_art = 'automatik' and not x.altbestand then date_trunc('minute', x.zeit) end,
              case when x.akteur_art = 'automatik' and not x.altbestand then null else x.id end
  ), alle as (
    select p.zeit, p.quelle, p.akteur_art, p.akteur, p.auftrag, p.tabelle, p.bereich, p.aktion, p.zeile, p.fahrer,
           p.woche, p.anzahl, p.ids,
           (select q.felder from public.protokoll q where q.id = p.eine_id) as felder,
           p.alt, p.neu, p.altbestand
      from p
    union all
    -- Sync-Laeufe: je Verbindung, Wiener Tag und Status eine Zeile
    select max(coalesce(s.ende, s.start)), 'sync'::text, 'automatik'::text, 'Automatik'::text, null::text,
           'sync_runs'::text, 'sync'::text, s.status, null::text, null::text, null::text, count(*)::int,
           null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('anbieter', v.anbieter, 'firma', v.firma, 'zeilen', sum(s.anzahl), 'fehler', max(s.fehler)),
           false
      from public.sync_runs s join public.verbindungen v on v.id = s.verbindung_id
     where s.status <> 'laeuft'
     group by v.id, v.anbieter, v.firma, s.status, (coalesce(s.ende, s.start) at time zone 'Europe/Vienna')::date
    union all
    select a.gesendet_am, 'post'::text, case when u.name is null then 'automatik' else 'buero' end,
           coalesce(u.name, 'Automatik'), null::text, 'post_ausgang'::text, 'post'::text, 'gesendet'::text,
           a.id::text, null::text, null::text, 1, null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('an', a.an, 'gz', a.gz, 'betreff', a.betreff, 'test_an', a.test_an, 'quelle', a.quelle),
           false
      from public.post_ausgang a left join public.app_users u on u.auth_id = a.gesendet_von
     where a.gesendet_am is not null
    union all
    select k.angelegt_am, 'kassa'::text, 'buero'::text, coalesce(nullif(k.name, ''), nullif(k.angelegt_von, ''), 'unbekannt'),
           null::text, 'kassabuch'::text, 'kassa'::text, case when k.storno_von is not null then 'storno' else k.art end,
           k.nr::text, null::text, k.woche_abr, 1, null::bigint[], null::text[], null::jsonb,
           jsonb_build_object('nr', k.nr, 'datum', k.datum, 'art', k.art, 'betrag', k.betrag, 'text', k.text,
                              'quelle', k.quelle, 'storno_von', k.storno_von),
           false
      from public.kassabuch k
  )
  select a.zeit, a.quelle, a.akteur_art, a.akteur, a.auftrag, a.tabelle, a.bereich, a.aktion, a.zeile, a.fahrer,
         a.woche, a.anzahl, a.ids, a.felder, a.alt, a.neu, a.altbestand
    from alle a
   where a.zeit is not null
     and (p_art is null or (p_art = 'automatik' and a.akteur_art = 'automatik')
                        or (p_art = 'mensch' and a.akteur_art <> 'automatik'))
     and (p_akteur is null or a.akteur = p_akteur or a.auftrag = p_akteur)
     and (p_bereich is null or a.bereich = p_bereich)
     and (p_fahrer is null or a.quelle = 'protokoll')
     and (not p_nur_loeschungen or a.quelle = 'protokoll' or a.aktion = 'storno')
     and (p_von is null or (a.zeit at time zone 'Europe/Vienna')::date >= p_von)
     and (p_bis is null or (a.zeit at time zone 'Europe/Vienna')::date <= p_bis)
   order by a.zeit desc, a.quelle, a.tabelle, a.zeile
   limit least(greatest(coalesce(p_limit, 100), 1), 1000) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.protokoll_verlauf(text, text, text, text, date, date, boolean, int, int) from public, anon;
grant execute on function public.protokoll_verlauf(text, text, text, text, date, date, boolean, int, int) to authenticated;
```

`felder` wird bewusst per Unterabfrage über `eine_id` geholt: Arrays unterschiedlicher Länge lassen sich mit `array_agg` nicht aggregieren.

Dann den Altbestand anhängen:

```sql
-- === Altbestand: einmalig, was schon einen Namen traegt ===
do $$
begin
  if exists (select 1 from public.protokoll where altbestand) then return; end if;
  insert into public.protokoll (zeit, akteur_art, akteur, tabelle, aktion, zeile, fahrer, woche, neu, altbestand)
  select coalesce(f.freigegeben_am, now()), 'buero', coalesce(nullif(f.freigegeben_von, ''), 'unbekannt'),
         'abrechnung_freigaben', 'neu', f.woche, null, f.woche, to_jsonb(f), true
    from public.abrechnung_freigaben f
  union all
  select coalesce(p.angelegt_am, now()), 'buero', coalesce(nullif(p.angelegt_von, ''), 'unbekannt'),
         'abrechnung_posten', 'neu', p.id::text, p.fahrer_name, p.woche, to_jsonb(p), true
    from public.abrechnung_posten p
  union all
  select coalesce(z.kassiert_at, now()), 'buero', coalesce(nullif(z.kassiert_von, ''), 'unbekannt'),
         'kassier_zahlungen', 'neu', z.id::text, z.fahrer_name, z.woche, to_jsonb(z), true
    from public.kassier_zahlungen z
  union all
  select coalesce(m.gesetzt_am, now()), 'buero', coalesce(nullif(m.gesetzt_von, ''), 'unbekannt'),
         'zuordnung_manuell', 'neu', m.anbieter || '/' || m.driver_uuid,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = m.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || m.notion_fahrer_id), null, to_jsonb(m), true
    from public.zuordnung_manuell m
  union all
  select coalesce(l.gesetzt_am, now()), 'buero', coalesce(nullif(l.gesetzt_von, ''), 'unbekannt'),
         'lohn_personen', 'neu', l.firma_nr || '/' || l.ma_nr,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = l.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || l.notion_fahrer_id), null, to_jsonb(l), true
    from public.lohn_personen l
  union all
  select coalesce(a.angelegt_am, now()), 'buero', coalesce(nullif(a.angelegt_von, ''), 'unbekannt'),
         'fahrer_app_zugang', 'neu', a.notion_fahrer_id::text,
         coalesce((select n.name from public.notion_fahrer n where n.notion_fahrer_id = a.notion_fahrer_id limit 1),
                  'Fahrer-ID ' || a.notion_fahrer_id), null, to_jsonb(a), true
    from public.fahrer_app_zugang a;
end $$;
```

Hinweis: Der Altbestand steht in der Datei **nach** den Triggern; das stört nicht, weil er nur in `protokoll` schreibt und INSERT dort nicht gesperrt ist.

- [ ] **Step 4: Test laufen lassen – muss bestehen**

Erwartet: kein Fehler; `to_regclass('public.protokoll')` danach `null`.
Schlägt `altbestand: X statt Y` fehl, hat eine Quelltabelle `null` in einer der verketteten Schlüsselspalten – dann dort `coalesce(…::text, '')` ergänzen.

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-10-08-protokoll.sql scripts/test-protokoll.sql
git commit -m "protokoll: protokoll_verlauf (nur admin, buendelt automatik und sync-laeufe) + altbestand"
```

---

### Task 3: Satz-Logik im Dashboard (reine Funktionen)

**Files:**
- Modify: `dashboard.html` – neuer Block direkt **nach** dem Ende der Hülle `Kassa` (`return { init: init }; })();`, vor `/* Reiter-Gruppen: …`)
- Create: `scripts/test-protokoll-satz.mjs`

**Interfaces:**
- Consumes: Zeilenform von `protokoll_verlauf` (Task 2).
- Produces: `protoSatz(r) → string` (Klartext, **nicht** HTML-escaped), `protoErlaubt(session) → boolean`, `prWert(feld, wert) → string`, Konstanten `PR_TAB`, `PR_FELD`. Der Block steht zwischen den Markern `/* PROTO-SATZ START */` und `/* PROTO-SATZ ENDE */`.

- [ ] **Step 1: Test schreiben** – `scripts/test-protokoll-satz.mjs`

```js
// node --test scripts/test-protokoll-satz.mjs
// Holt den Block zwischen den PROTO-SATZ-Markern aus dashboard.html und prueft die reinen Funktionen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const m = html.match(/\/\* PROTO-SATZ START \*\/([\s\S]*?)\/\* PROTO-SATZ ENDE \*\//);
assert.ok(m, 'PROTO-SATZ-Block fehlt in dashboard.html');
const { protoSatz, protoErlaubt } = new Function(m[1] + '; return { protoSatz, protoErlaubt };')();
const z = (x) => Object.assign({ quelle: 'protokoll', anzahl: 1, alt: null, neu: null, felder: null, woche: null }, x);

test('korrektur geaendert', () => {
  assert.equal(protoSatz(z({ tabelle: 'settlements', aktion: 'geaendert', felder: ['korrektur', 'korrektur_note'],
    alt: { korrektur: 0, korrektur_note: null }, neu: { korrektur: -70, korrektur_note: 'Pickerl' } })),
    'Korrektur 0,00 → −70,00 · Notiz – → Pickerl');
});
test('zuschlag angelegt und geloescht', () => {
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_posten', aktion: 'neu', neu: { betrag: 70, text: 'Pickerl selbst bezahlt' } })),
    'Zuschlag +70,00 ‚Pickerl selbst bezahlt‘ angelegt');
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_posten', aktion: 'geloescht', alt: { betrag: -20, text: 'Schaden' } })),
    'Abschlag −20,00 ‚Schaden‘ gelöscht');
});
test('zahlung geloescht', () => {
  assert.equal(protoSatz(z({ tabelle: 'kassier_zahlungen', aktion: 'geloescht', alt: { betrag: 150 } })), 'Zahlung 150,00 gelöscht');
  assert.equal(protoSatz(z({ tabelle: 'kassier_zahlungen', aktion: 'neu', neu: { betrag: 150 } })), 'Zahlung 150,00 kassiert');
});
test('freigabe', () => {
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_freigaben', aktion: 'neu', woche: '2026-W40' })), 'KW 40 freigegeben');
  assert.equal(protoSatz(z({ tabelle: 'abrechnung_freigaben', aktion: 'geloescht', woche: '2026-W40' })), 'Freigabe KW 40 zurückgenommen');
});
test('app-zugang', () => {
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['gesperrt', 'gesperrt_am'],
    alt: { gesperrt: false }, neu: { gesperrt: true } })), 'App-Zugang gesperrt');
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['gesperrt'],
    alt: { gesperrt: true }, neu: { gesperrt: false } })), 'App-Zugang entsperrt');
  assert.equal(protoSatz(z({ tabelle: 'fahrer_app_zugang', aktion: 'geaendert', felder: ['pin_geaendert_am'], alt: {}, neu: {} })), 'App-Zugang: PIN neu gesetzt');
});
test('sammelzeile der automatik', () => {
  assert.equal(protoSatz(z({ tabelle: 'settlements', aktion: 'gemischt', anzahl: 52, woche: '2026-W40' })),
    'Abrechnung KW 40 – 52 Zeilen neu geschrieben');
});
test('sync, post, kassa', () => {
  assert.equal(protoSatz({ quelle: 'sync', aktion: 'ok', anzahl: 24, neu: { anbieter: 'uber', firma: 'ee_taxi_kg', zeilen: 310, fehler: null } }),
    'Uber-Sync ee_taxi_kg · 24 Läufe · 310 Zeilen · ok');
  assert.equal(protoSatz({ quelle: 'sync', aktion: 'fehler', anzahl: 1, neu: { anbieter: 'bolt', firma: null, zeilen: 0, fehler: 'HTTP 401' } }),
    'Bolt-Sync · 1 Lauf · 0 Zeilen · Fehler: HTTP 401');
  assert.equal(protoSatz({ quelle: 'post', aktion: 'gesendet', anzahl: 1, neu: { an: 'a@b.at', gz: 'MA67/1', test_an: null } }),
    'Post gesendet an a@b.at (GZ MA67/1)');
  assert.equal(protoSatz({ quelle: 'kassa', aktion: 'aus', anzahl: 1, neu: { nr: 7, art: 'aus', betrag: 40, text: 'Tanken' } }),
    'Kassabuch Nr. 7 · Ausgabe 40,00 ‚Tanken‘');
  assert.equal(protoSatz({ quelle: 'kassa', aktion: 'storno', anzahl: 1, neu: { nr: 8, art: 'ein', betrag: 40, text: 'Storno', storno_von: 7 } }),
    'Kassabuch Nr. 8 · Storno · Einnahme 40,00 ‚Storno‘');
});
test('unbekannte tabelle und unbekanntes feld fallen auf roh zurueck', () => {
  assert.equal(protoSatz(z({ tabelle: 'neue_tabelle', aktion: 'geaendert', felder: ['xyz'], alt: { xyz: 1 }, neu: { xyz: { a: 1 } } })),
    'neue_tabelle geändert: xyz 1 → {"a":1}');
  assert.equal(protoSatz(z({ tabelle: 'neue_tabelle', aktion: 'neu', neu: {} })), 'neue_tabelle angelegt');
  assert.equal(protoSatz(z({ tabelle: 'customers', aktion: 'geloescht', alt: { name: 'Hotel X' } })), 'Kunde ‚Hotel X‘ gelöscht');
  assert.doesNotThrow(() => protoSatz({}));
  assert.doesNotThrow(() => protoSatz(z({ tabelle: 'settlements', aktion: 'geaendert' })));
});
test('nur admin darf den reiter', () => {
  assert.equal(protoErlaubt({ name: 'Boyko', role: 'admin' }), true);
  assert.equal(protoErlaubt({ name: 'Stefan', role: 'user' }), false);
  assert.equal(protoErlaubt(null), false);
  assert.equal(protoErlaubt({}), false);
});
```

- [ ] **Step 2: Test laufen lassen – muss scheitern**

Run: `node --test scripts/test-protokoll-satz.mjs`
Erwartet: FAIL „PROTO-SATZ-Block fehlt in dashboard.html“.

- [ ] **Step 3: Block einfügen** – in `dashboard.html` direkt nach der Zeile `return { init: init };` + `})();` der Hülle `Kassa` (die Zeile vor `/* Reiter-Gruppen: oben die Gruppe, daneben ihre Unterreiter */`)

```js
        /* PROTO-SATZ START */
        // Protokoll: Saetze aus einer Zeile von protokoll_verlauf. Reine Funktionen (scripts/test-protokoll-satz.mjs).
        const PR_TAB = { settlements: 'Abrechnung', abrechnung_posten: 'Zu-/Abschlag', kassier_zahlungen: 'Kassieren',
            abrechnung_freigaben: 'Freigabe', post_eingang: 'Post', mietverhaeltnisse: 'Mieter', zuordnung_manuell: 'Konto-Zuordnung',
            lohn_personen: 'Lohn-Zuordnung', name_aliases: 'Namens-Alias', fahrer_app_zugang: 'App-Zugang', customers: 'Kunde', companies: 'Firma' };
        const PR_FELD = { korrektur: 'Korrektur', korrektur_note: 'Notiz', auszahlung: 'Auszahlung', miete: 'Miete', lohn: 'Lohn',
            status: 'Status', betrag: 'Betrag', notiz: 'Notiz', fahrer_id: 'Fahrer', gesperrt: 'Gesperrt', gueltig_von: 'Gültig von',
            gueltig_bis: 'Gültig bis', mietmodell: 'Mietmodell', prozent_abzug: 'Abzug %', fahrer_name: 'Fahrer', art: 'Art' };
        const PR_GELD = ['korrektur', 'auszahlung', 'miete', 'lohn', 'betrag', 'bolt_brutto', 'bolt_auszahlung', 'uber_fahrpreis',
            'uber_auszahlung', 'mypos_summe', 'bruttoumsatz_gesamt', 'wir_bekommen', 'abzug_gesamt', 'summe'];
        const PR_AKT = { neu: 'angelegt', geaendert: 'geändert', geloescht: 'gelöscht', gemischt: 'neu geschrieben' };
        function prGeld(v) {
            const n = parseFloat(v);
            if (v == null || isNaN(n)) return '–';
            return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        function prWert(f, v) {
            if (v == null || v === '') return '–';
            if (PR_GELD.indexOf(f) >= 0) return prGeld(v);
            if (v === true) return 'ja';
            if (v === false) return 'nein';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return s.length > 80 ? s.slice(0, 79) + '…' : s;
        }
        function prKw(w) { return /^\d{4}-W\d+/.test(w || '') ? 'KW ' + parseInt(w.slice(6), 10) : (w || ''); }
        function prZitat(t) { return t ? ' ‚' + t + '‘' : ''; }
        function prFelder(r) {
            const a = r.alt || {}, n = r.neu || {};
            return (r.felder || []).map(function (f) { return (PR_FELD[f] || f) + ' ' + prWert(f, a[f]) + ' → ' + prWert(f, n[f]); }).join(' · ');
        }
        function protoSatz(r) {
            r = r || {};
            const n = r.neu || {}, a = r.alt || {}, t = r.tabelle || '', akt = r.aktion || '', v = akt === 'geloescht' ? a : n;
            const name = PR_TAB[t] || t, f = r.felder || [];
            if (r.quelle === 'sync') {
                const wer = String(n.anbieter || '?'), lauf = r.anzahl === 1 ? ' Lauf' : ' Läufe';
                return wer.charAt(0).toUpperCase() + wer.slice(1) + '-Sync' + (n.firma ? ' ' + n.firma : '') + ' · ' + (r.anzahl || 0) + lauf
                    + ' · ' + (parseInt(n.zeilen, 10) || 0) + ' Zeilen' + (akt === 'fehler' ? ' · Fehler: ' + (n.fehler || '?') : ' · ok');
            }
            if (r.quelle === 'post') return 'Post gesendet an ' + (n.an || '?') + (n.gz ? ' (GZ ' + n.gz + ')' : '') + (n.test_an ? ' · Test' : '');
            if (r.quelle === 'kassa') {
                const art = { ein: 'Einnahme', aus: 'Ausgabe', anfang: 'Anfangsbestand' }[n.art] || n.art || '';
                return 'Kassabuch Nr. ' + n.nr + ' · ' + (akt === 'storno' ? 'Storno · ' : '') + art + ' ' + prGeld(n.betrag) + prZitat(n.text);
            }
            if (r.anzahl > 1) return name + (r.woche ? ' ' + prKw(r.woche) : '') + ' – ' + r.anzahl + ' Zeilen ' + (PR_AKT[akt] || akt);
            if (t === 'abrechnung_posten' && akt !== 'geaendert') {
                const b = parseFloat(v.betrag) || 0;
                return (b < 0 ? 'Abschlag ' : 'Zuschlag ') + (b < 0 ? '−' : '+') + prGeld(Math.abs(b)) + prZitat(v.text) + ' ' + PR_AKT[akt];
            }
            if (t === 'kassier_zahlungen' && akt !== 'geaendert') return 'Zahlung ' + prGeld(v.betrag) + (akt === 'neu' ? ' kassiert' : ' gelöscht');
            if (t === 'abrechnung_freigaben' && akt === 'neu') return prKw(r.woche) + ' freigegeben';
            if (t === 'abrechnung_freigaben' && akt === 'geloescht') return 'Freigabe ' + prKw(r.woche) + ' zurückgenommen';
            if (t === 'fahrer_app_zugang' && akt === 'geaendert') {
                if (f.indexOf('gesperrt') >= 0) return n.gesperrt ? 'App-Zugang gesperrt' : 'App-Zugang entsperrt';
                if (f.indexOf('pin_geaendert_am') >= 0) return 'App-Zugang: PIN neu gesetzt';
            }
            if (t === 'settlements' && akt === 'geaendert' && f.length) return prFelder(r);
            if (akt === 'geaendert') return name + ' geändert' + (f.length ? ': ' + prFelder(r) : '');
            const titel = v.name || v.kurz || v.csv_name || v.gz || '';
            return name + prZitat(titel) + ' ' + (PR_AKT[akt] || akt);
        }
        function protoErlaubt(session) { return !!(session && session.role === 'admin'); }
        /* PROTO-SATZ ENDE */
```

- [ ] **Step 4: Tests laufen lassen – müssen bestehen**

Run: `node --test scripts/test-protokoll-satz.mjs && bash scripts/check-dashboard.sh`
Erwartet: alle Tests `pass`, danach `OK: dashboard.html`.

- [ ] **Step 5: Commit**

```bash
git add dashboard.html scripts/test-protokoll-satz.mjs
git commit -m "protokoll: satz-logik (protoSatz, protoErlaubt) mit node-test"
```

---

### Task 4: Reiter „Protokoll“ im Dashboard

**Files:**
- Modify: `dashboard.html` – CSS (nach dem Kassabuch-Block, vor `/* Loehne-Reiter */`), Kopfleiste (`.tab-nav`), Markup (`contentProtokoll` nach `contentKassabuch`), Handy-Menü (`#menue`), `GRUPPEN`, `switchTab`, Hülle `Proto` (direkt nach `/* PROTO-SATZ ENDE */`), Start (vor `switchTab(savedTab || 'abrechnungen')`)
- Modify: `sw.js:1`
- Modify: `CLAUDE.md` (neuer Abschnitt)

**Interfaces:**
- Consumes: `protoSatz`, `protoErlaubt`, `prWert`, `PR_TAB`, `PR_FELD` (Task 3); RPC `protokoll_verlauf` mit den Parametern aus Task 2; vorhandene Helfer `getSupabase()`, `esc(str)` (verträgt **nur Strings** – immer `String(x)` übergeben), `menueZu()`.
- Produces: `Proto.init()`; Reiter-Schlüssel `protokoll`.

- [ ] **Step 1: CSS** – nach der Zeile `@media (max-width: 768px) { #contentKassabuch .kpi …}` einfügen

```css
        /* Protokoll (nur admin) */
        [data-nur-admin][hidden] { display: none !important; }
        #contentProtokoll td.l, #contentProtokoll th.l { text-align: left; font-family: var(--sans); }
        #prTable tbody tr:not(.detail-row) { cursor: pointer; }
        #prTable td.pr-zeit { color: var(--text-mut); font-family: var(--mono); font-weight: 400; white-space: nowrap; }
        #prTable td.pr-wer { color: var(--text); font-weight: 500; white-space: nowrap; }
        #prTable td.pr-wer small, #prTable td.pr-was small { display: block; font-size: 10.5px; color: var(--text-mut); font-weight: 400; }
        #prTable td.pr-was { white-space: normal; }
        #prTable tr.pr-weg td.pr-was, #prTable tr.pr-sql td.pr-wer { color: var(--danger, #e5484d); }
        #prTable tr.pr-auto td.pr-wer { color: var(--text-mut); font-weight: 400; }
        .pr-diff { width: 100%; border-collapse: collapse; font-size: 12px; }
        .pr-diff td { padding: 3px 8px 3px 0; vertical-align: top; border: 0; background: none; white-space: normal; word-break: break-word; }
        .pr-diff td:first-child { color: var(--text-mut); white-space: nowrap; }
        .pr-diff td.pr-alt { color: var(--text-dim); text-decoration: line-through; }
        .pr-mehr { display: flex; justify-content: center; padding: 14px; }
        #prToolbar input[type=date] { height: 30px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
        #prToolbar select { max-width: 160px; }
        @media (max-width: 768px) { #prTable .pr-breit { display: none; } }
```

- [ ] **Step 2: Kopfleiste** – in `.tab-nav` nach dem Knopf „Experimentell“ (vor `</div>` der `.tab-nav`)

```html
                <button class="tab-btn" onclick="switchTab('protokoll')" data-gruppe="protokoll" data-nur-admin hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                    Protokoll
                </button>
```

- [ ] **Step 3: Markup** – nach dem schließenden `</div>` von `contentKassabuch`, vor `<div class="tab-content" id="contentLohn">`

```html
    <div class="tab-content" id="contentProtokoll">
        <div class="hero">
            <div class="hero-top">
                <div class="week-pick"><span style="font-size:18px;font-weight:700">Protokoll</span><span class="week-range">wer hat was gemacht – nur für dich sichtbar</span></div>
                <div class="hero-big"><b id="prBig">--</b><small>Einträge geladen</small></div>
            </div>
        </div>
        <div class="toolbar" id="prToolbar">
            <button class="chip active" data-pr-art="">Alle</button>
            <button class="chip" data-pr-art="mensch">Mensch</button>
            <button class="chip" data-pr-art="automatik">Automatik</button>
            <select class="chip" id="prWer" aria-label="Person"><option value="">Alle Personen</option></select>
            <select class="chip" id="prBereich" aria-label="Bereich">
                <option value="">Alle Bereiche</option><option value="geld">Geld</option><option value="freigaben">Freigaben</option>
                <option value="post">Post &amp; Strafen</option><option value="zuordnungen">Zuordnungen</option><option value="zugaenge">App-Zugänge</option>
                <option value="stammdaten">Stammdaten</option><option value="kassa">Kassabuch</option><option value="sync">Syncs</option>
            </select>
            <input type="text" class="search" id="prFahrer" placeholder="Fahrer">
            <input type="date" id="prVon" class="desktop-only" aria-label="von">
            <input type="date" id="prBis" class="desktop-only" aria-label="bis">
            <button class="chip" id="prWeg">Nur Löschungen</button>
            <div class="sp"></div>
            <button class="btn" id="prRefresh" title="Neu laden">↺</button>
        </div>
        <table class="data-table" id="prTable">
            <thead><tr><th class="l">Zeit</th><th class="l">Wer</th><th class="l">Was</th><th class="l pr-breit">Fahrer / Woche</th></tr></thead>
            <tbody id="prBody"><tr><td colspan="4" class="empty">Laden…</td></tr></tbody>
        </table>
        <div class="pr-mehr"><button class="btn" id="prMehr" hidden>Ältere laden</button></div>
    </div>
```

- [ ] **Step 4: Handy-Menü** – in `#menue .menue-liste` nach dem Knopf `data-menue="verbindungen"`

```html
            <div class="menue-gruppe" data-nur-admin hidden>Protokoll</div>
            <button onclick="switchTab('protokoll')" data-menue="protokoll" data-nur-admin hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>Protokoll</button>
```

Die übrigen Menü-Knöpfe ansehen und ihre innere Struktur (Text direkt nach dem `<svg>` oder in einem `<span>`) genauso übernehmen.

- [ ] **Step 5: Hülle `Proto`** – direkt nach `/* PROTO-SATZ ENDE */`

```js
        function istAdmin() { try { return protoErlaubt(JSON.parse(localStorage.getItem('hydralink_session') || 'null')); } catch (e) { return false; } }
        /* Protokoll-Reiter: Verlauf aus protokoll_verlauf (nur admin; die Sperre liegt in der Datenbank) */
        const Proto = (function () {
            const SEITE = 100;
            let bereit = false, ROWS = [], offen = null, mehr = false, fehler = '', laeuft = 0, UNTER = {};
            const F = { art: '', wer: '', bereich: '', fahrer: '', von: '', bis: '', weg: false };
            function h(x) { return esc(String(x == null ? '' : x)); }
            function zeitText(d) { return d ? new Date(d).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'; }
            function fehlerText(e) { return e && e.code === '42501' ? 'Keine Berechtigung.' : (e && e.message) || String(e); }
            function param(offset) {
                return { p_art: F.art || null, p_akteur: F.wer || null, p_bereich: F.bereich || null, p_fahrer: F.fahrer || null,
                    p_von: F.von || null, p_bis: F.bis || null, p_nur_loeschungen: F.weg, p_limit: SEITE + 1, p_offset: offset };
            }
            async function laden(anhaengen) {
                const nr = ++laeuft, offset = anhaengen ? ROWS.length : 0;
                let res;
                try { res = await getSupabase().rpc('protokoll_verlauf', param(offset)); } catch (e) { res = { error: e }; }
                if (nr !== laeuft) return;                       // ein neuerer Aufruf hat ueberholt
                fehler = res.error ? fehlerText(res.error) : '';
                const neu = res.error ? [] : (res.data || []);
                mehr = neu.length > SEITE;
                ROWS = (anhaengen ? ROWS : []).concat(neu.slice(0, SEITE));
                if (!anhaengen) { offen = null; UNTER = {}; }
                render();
            }
            async function personenLaden() {
                let res;
                try { res = await getSupabase().from('app_users').select('name').order('name'); } catch (e) { res = { error: e }; }
                if (res.error || !res.data) return;
                document.getElementById('prWer').innerHTML = '<option value="">Alle Personen</option>'
                    + res.data.map(function (u) { return '<option value="' + h(u.name) + '">' + h(u.name) + '</option>'; }).join('')
                    + '<option value="SQL-Fenster">SQL-Fenster</option>';
            }
            function wer(r) {
                if (r.auftrag) return h(r.auftrag) + '<small>über Automatik</small>';
                return h(r.akteur) + (r.altbestand ? '<small>Altbestand</small>' : '');
            }
            function diff(r) {
                const a = r.alt || {}, n = r.neu || {};
                const keys = r.aktion === 'geaendert' && r.felder ? r.felder : Object.keys(r.aktion === 'geloescht' ? a : n).sort();
                if (!keys.length) return '<div class="placeholder">Keine Einzelwerte.</div>';
                return '<table class="pr-diff">' + keys.map(function (k) {
                    const alt = r.aktion === 'neu' ? '' : prWert(k, a[k]), neu = r.aktion === 'geloescht' ? '' : prWert(k, n[k]);
                    return '<tr><td>' + h(PR_FELD[k] || k) + '</td>' + (r.aktion === 'geaendert'
                        ? '<td class="pr-alt">' + h(alt) + '</td><td>' + h(neu) + '</td>'
                        : '<td colspan="2">' + h(r.aktion === 'geloescht' ? alt : neu) + '</td>') + '</tr>';
                }).join('') + '</table>';
            }
            function detail(r, i) {
                if (r.anzahl > 1 && r.ids) {
                    const u = UNTER[i];
                    if (!u) return '<div class="placeholder">Laden…</div>';
                    if (u.fehler) return '<div class="placeholder">Fehler: ' + h(u.fehler) + '</div>';
                    return '<table class="pr-diff">' + u.rows.map(function (x) {
                        x.quelle = 'protokoll'; x.anzahl = 1;
                        return '<tr><td>' + h(x.fahrer || x.zeile || '') + '</td><td colspan="2">' + h(protoSatz(x)) + '</td></tr>';
                    }).join('') + '</table>';
                }
                return diff(r);
            }
            async function unterLaden(i) {
                const r = ROWS[i];
                if (!r || !(r.anzahl > 1) || !r.ids || UNTER[i]) return;
                let res;
                try { res = await getSupabase().from('protokoll').select('*').in('id', r.ids.slice(0, 300)).order('fahrer'); } catch (e) { res = { error: e }; }
                UNTER[i] = res.error ? { fehler: fehlerText(res.error) } : { rows: res.data || [] };
                if (offen === i) render();
            }
            function render() {
                document.getElementById('prBig').textContent = fehler ? '–' : String(ROWS.length) + (mehr ? '+' : '');
                document.querySelectorAll('#prToolbar [data-pr-art]').forEach(function (b) { b.classList.toggle('active', b.dataset.prArt === F.art); });
                document.getElementById('prWeg').classList.toggle('active', F.weg);
                document.getElementById('prMehr').hidden = !mehr;
                document.getElementById('prBody').innerHTML = fehler ? '<tr><td class="empty" colspan="4">Fehler: ' + h(fehler) + '</td></tr>'
                    : !ROWS.length ? '<tr><td class="empty" colspan="4">Keine Einträge für diese Auswahl.</td></tr>'
                    : ROWS.map(function (r, i) {
                        const weg = r.aktion === 'geloescht' || r.aktion === 'storno', an = offen === i;
                        const kl = (an ? 'selected ' : '') + (weg ? 'pr-weg ' : '') + (r.akteur_art === 'sql' ? 'pr-sql ' : '') + (r.akteur_art === 'automatik' && !r.auftrag ? 'pr-auto' : '');
                        const ort = [r.fahrer, prKw(r.woche)].filter(Boolean).join(' · ');
                        return '<tr class="' + kl + '" data-pr-zeile="' + i + '">'
                            + '<td class="l pr-zeit">' + h(zeitText(r.zeit)) + '</td>'
                            + '<td class="l pr-wer">' + wer(r) + '</td>'
                            + '<td class="l pr-was">' + h(protoSatz(r)) + '</td>'
                            + '<td class="l pr-breit">' + h(ort) + '</td></tr>'
                            + (an ? '<tr class="detail-row"><td colspan="4">' + (ort ? '<div style="margin-bottom:6px;font-weight:600">' + h(ort) + '</div>' : '') + detail(r, i) + '</td></tr>' : '');
                    }).join('');
            }
            function init() {
                if (!istAdmin()) return;
                if (bereit) { laden(false); return; }
                bereit = true;
                let t;
                document.getElementById('contentProtokoll').addEventListener('click', function (e) {
                    let b;
                    if ((b = e.target.closest('[data-pr-art]'))) { F.art = b.dataset.prArt; laden(false); return; }
                    if (e.target.closest('#prWeg')) { F.weg = !F.weg; laden(false); return; }
                    if (e.target.closest('#prRefresh')) { laden(false); return; }
                    if (e.target.closest('#prMehr')) { laden(true); return; }
                    if (e.target.closest('.detail-row')) return;
                    if ((b = e.target.closest('[data-pr-zeile]'))) {
                        const i = parseInt(b.dataset.prZeile, 10);
                        offen = offen === i ? null : i; render();
                        if (offen != null) unterLaden(offen);
                    }
                });
                document.getElementById('prWer').addEventListener('change', function (e) { F.wer = e.target.value; laden(false); });
                document.getElementById('prBereich').addEventListener('change', function (e) { F.bereich = e.target.value; laden(false); });
                document.getElementById('prVon').addEventListener('change', function (e) { F.von = e.target.value; laden(false); });
                document.getElementById('prBis').addEventListener('change', function (e) { F.bis = e.target.value; laden(false); });
                document.getElementById('prFahrer').addEventListener('input', function (e) {
                    clearTimeout(t); t = setTimeout(function () { F.fahrer = e.target.value.trim(); laden(false); }, 300);
                });
                personenLaden();
                laden(false);
            }
            return { init: init };
        })();
```

- [ ] **Step 6: Reiter verdrahten** – drei kleine Änderungen in `dashboard.html`

In `GRUPPEN` nach der Zeile `experimentell: [...]` (Komma an der Zeile davor ergänzen):

```js
            experimentell: [['api', 'API-Abrechnung'], ['fuhrpark', 'Fuhrpark'], ['verbindungen', 'Verbindungen']],
            protokoll: [['protokoll']]
```

In `switchTab`: im Objekt `inhalt` `protokoll: 'contentProtokoll'` ergänzen und direkt danach die Sperre:

```js
                fahrer: 'contentFahrer', fuhrpark: 'contentFuhrpark', post: 'contentPost', verbindungen: 'contentVerbindungen', rechnungen: 'contentRechnungen',
                protokoll: 'contentProtokoll' };
            if (tab === 'protokoll' && !istAdmin()) tab = 'abrechnungen';
            if (!inhalt[tab]) tab = 'abrechnungen';
```

In der `else if`-Kette von `switchTab` nach `else if (tab === 'kassabuch') Kassa.init();`:

```js
            else if (tab === 'protokoll') Proto.init();
```

Direkt **vor** der Zeile `switchTab(savedTab || 'abrechnungen');` (ca. Zeile 5235):

```js
        if (istAdmin()) document.querySelectorAll('[data-nur-admin]').forEach(function (e) { e.hidden = false; });
```

- [ ] **Step 7: Cache und Doku**

`sw.js` Zeile 1: `const CACHE_NAME = 'hydralink-v32';`

`CLAUDE.md`, nach dem Abschnitt **Kassabuch** einfügen:

```markdown
**Protokoll (seit 2026-10-09):** eigener Punkt in der Kopfleiste, **nur für `admin`** (`contentProtokoll`, Hülle `Proto`,
Präfix `pr`). Kontrolle „wer hat was geändert“. Absicherung – nicht aufweichen:
- Die Datenbank schreibt selbst mit: Trigger `protokoll_mitschreiben` (Funktion `protokoll_schreiben`) auf `settlements`,
  `abrechnung_posten`, `kassier_zahlungen`, `abrechnung_freigaben`, `post_eingang` (nur Entscheidungsfelder, kein INSERT),
  `mietverhaeltnisse`, `zuordnung_manuell`, `lohn_personen`, `name_aliases`, `fahrer_app_zugang`, `customers`, `companies`.
  **Neue Tabelle mit Büro-Schreibzugriff → Trigger anhängen** (Liste am Ende von `migrations/2026-10-08-protokoll.sql`)
  und in `protokoll_bereich`, `PR_TAB` eintragen.
- Wer = `auth.jwt()`: Büro-Name, „Fahrer n“, „Automatik“ (`service_role`: n8n, Edge Functions) oder „SQL-Fenster“ (kein JWT –
  auch das Supabase-MCP). Nie als Parameter.
- `protokoll`: UPDATE/DELETE/TRUNCATE per Trigger gesperrt, kein INSERT-Recht für irgendeine Rolle, SELECT nur `is_app_admin()`.
- Der Trigger schluckt eigene Fehler (`raise warning`) – das Protokoll darf die Abrechnung nie blockieren.
- `protokoll_verlauf(…)` mischt `protokoll` + `sync_runs` (je Verbindung/Tag/Status) + `post_ausgang` + `kassabuch`;
  Automatik-Zeilen gleicher Tabelle/Woche/Minute kommen als Sammelzeile (`anzahl`, `ids`).
- Tests: `scripts/test-protokoll.sql` (mit Migration in `begin … rollback` über das MCP), `node --test scripts/test-protokoll-satz.mjs`.
```

- [ ] **Step 8: Prüfen**

Run: `node --test scripts/test-protokoll-satz.mjs && bash scripts/check-dashboard.sh`
Erwartet: Tests `pass`, `OK: dashboard.html` (insbesondere keine „FEHLENDE IDs“ – `prBig`, `prWer`, `prBereich`, `prFahrer`, `prVon`, `prBis`, `prWeg`, `prMehr`, `prBody`, `prRefresh`, `contentProtokoll` stehen im Markup).

- [ ] **Step 9: Commit**

```bash
git add dashboard.html sw.js CLAUDE.md
git commit -m "protokoll: reiter nur fuer admin (verlauf, filter, vorher/nachher, sammelzeilen aufklappbar); cache v32"
```

---

### Task 5: Einspielen und am lebenden System prüfen

**Files:** keine neuen. **Braucht das OK des Betreibers vor Schritt 2.**

**Interfaces:**
- Consumes: alles aus Task 1–4.

- [ ] **Step 1: Letzter Trockenlauf**

Beide Tests noch einmal: SQL-Test (begin … rollback über das MCP, kein Fehler) und `node --test scripts/test-protokoll-satz.mjs`.

- [ ] **Step 2: Betreiber fragen, dann Migration einspielen**

Frage: „Migration `2026-10-08-protokoll.sql` jetzt in die Live-Datenbank einspielen?“ Erst nach „ja“:
`mcp__claude_ai_Supabase__apply_migration` (project_id `pkxcwfkfaaorwnbdmylg`, name `protokoll`, query = Inhalt von `migrations/2026-10-08-protokoll.sql`). Schema dafür vorher per ToolSearch `select:mcp__claude_ai_Supabase__apply_migration` laden.

- [ ] **Step 3: Live prüfen (nur lesen)**

```sql
select (select count(*) from public.protokoll) as zeilen,
       (select count(*) from public.protokoll where altbestand) as altbestand,
       (select count(*) from information_schema.triggers where trigger_schema = 'public' and trigger_name = 'protokoll_mitschreiben') as trigger_ereignisse,
       (select count(distinct event_object_table) from information_schema.triggers where trigger_schema = 'public' and trigger_name = 'protokoll_mitschreiben') as tabellen;
```

Erwartet: `zeilen = altbestand > 0`, `tabellen = 12`.
Sicherheits-Advisor ansehen (`mcp__claude_ai_Supabase__get_advisors`, type `security`): keine neue Meldung zu `protokoll` (RLS an, Policy vorhanden).

- [ ] **Step 4: Im Browser prüfen**

Lokal starten wie im Repo üblich (`scripts/server` ansehen) und mit dem Betreiber-Konto anmelden, oder nach dem Push auf `hydrafleet.pages.dev`:
1. Als admin: Punkt „Protokoll“ ist da; Liste zeigt Altbestand, Sync-Läufe, Kassabuch.
2. In der Abrechnung einen Zuschlag +1 „Protokolltest“ anlegen und wieder löschen → zwei Zeilen mit dem eigenen Namen, die Löschung rot; Klick zeigt die Werte. (Das sind echte Einträge und bleiben im Protokoll stehen – vorher dem Betreiber sagen.)
3. Filter „Mensch“, Person, „Nur Löschungen“, Fahrer-Suche, „Ältere laden“.
4. Handy-Breite: drei Spalten, Detail klappt auf.
5. Als `user` (Betreiber bittet einen Mitarbeiter oder prüft mit dessen Konto): kein Punkt „Protokoll“; in der Konsole `switchTab('protokoll')` → landet auf Abrechnungen; `await getSupabase().from('protokoll').select('id').limit(1)` → `[]`.

- [ ] **Step 5: Push durch den Betreiber**

Betreiber tippt: `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`
Danach auf `hydrafleet.pages.dev` hart neu laden (Cache v32) und Punkt 1 wiederholen.

- [ ] **Step 6: Montag nach dem ersten Bot-Lauf nachsehen**

```sql
select tabelle, akteur_art, aktion, count(*) from public.protokoll
 where not altbestand and zeit > now() - interval '1 day' group by 1, 2, 3 order by 4 desc;
```

Erwartet: `settlements`/`automatik` als wenige Sammelzeilen im Reiter; in den Postgres-Logs (`mcp__claude_ai_Supabase__query_logs` bzw. Supabase-Dashboard) keine `protokoll_schreiben(`-Warnungen.
