# Autoliste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Dashboard eine Autoliste, in der das Büro einem Auto Fahrer aus der ganzen Notion-Fahrerliste zuordnet und dabei die Pauschale setzt. Wirkt sofort auf die Abrechnung und wird nach Notion zurückgeschrieben.

**Architecture:** Verlauf `fahrer_auto` (nur anhängen) ist führend für Fahrer↔Auto. `auto_fahrer_setzen`/`_entfernen` schreiben Verlauf, `fahrer` und Pauschale in einer Transaktion und merken das Auto in `fuhrpark_notion_offen` vor. Die Edge Function `fuhrpark-notion` setzt in Notion „Fahrer aktuell“, `notion-sync` holt Offenes alle 10 Minuten nach und spiegelt den Notion-Stand in `fuhrpark`. Der Wächter auf `fahrer` bekommt einen zweiten Teil fürs Kennzeichen.

**Tech Stack:** Supabase Postgres (PL/pgSQL), Deno Edge Functions, Vanilla-JS-Dashboard (`dashboard.html`), PGlite + `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-01-autoliste-design.md` (mit den zwei Änderungen aus Task 0)

## Global Constraints

- Schlüssel des Fahrers ist die **Notion-Fahrer-Nr.** (`notion_fahrer_id`), Auto ist `kennzeichen_key()`.
- `fahrer_mietmodell_check` erlaubt nur `fix`/`f11`/`f12` – nie etwas anderes nach `fahrer` schreiben.
- Name eines neuen Fahrers: `btrim(notion_fahrer.name)` (wie der n8n-Full-Sync, der `on_conflict=name` upsertet).
- Kennzeichen-Anzeigeform wie der Full-Sync: Teil vor `(`, Leerzeichen zusammengezogen, getrimmt.
- Wer schreibt: `auth.jwt()->'app_metadata'->>'app_name'`, sonst 'Büro' / 'Automatik'. Nie als Parameter.
- Dashboard: Präfix `au` (ps = Post, pau = Pauschalen), Schalter `AU_AKTIV`, schlichter Stil (siehe `feedback-ui-schlicht`).
- Live: Migrationen nur nach „spiel … ein“ des Betreibers, nicht Montag 04–08 Wien. Edge-Function-Deploy ebenso.

## Review Focus

1. **Fahrer auf zwei Autos in Notion** (Übernahme): eine Zuordnung wählen (die mit `fahrer.kennzeichen` übereinstimmt, sonst die erste), nicht abbrechen. → Test in Task 1.
2. **Doppelklick / zweimal speichern**: zweites `auto_fahrer_setzen` mit gleichem Auto ist harmlos (kein Doppel-Fahrer, Verlauf darf zweite Zeile haben). → Test in Task 1.
3. **Notion nicht erreichbar**: Zuordnung in HL bleibt gültig, Auto bleibt in `fuhrpark_notion_offen`, Dashboard zeigt „Notion noch offen“. → Test in Task 3.
4. **Fahrer ohne `fahrer`-Zeile und ohne Pauschale** (Pavel): Speichern ohne Pauschale wird abgelehnt, mit Pauschale entsteht genau eine `fahrer`-Zeile. → Test in Task 1.
5. **Full-Sync-Upsert nach dem Scharfschalten** schreibt das alte Notion-Kennzeichen: HL-Kennzeichen bleibt. → Test in Task 2.

---

### Task 0: Spec nachziehen

**Files:** Modify `docs/superpowers/specs/2026-11-01-autoliste-design.md`

- [ ] Abschnitt `fahrer_auto`: Spalte `notion_ok_am` streichen. Neu: Tabelle `fuhrpark_notion_offen(kennzeichen_key pk, seit)` = Autos, deren Notion-Feld „Fahrer aktuell“ noch nachgezogen werden muss.
- [ ] Abschnitt „Start“: Übernahme aus **Notion** (`fuhrpark.notion_fahrer`), nur für Fahrer mit `fahrer`-Zeile. Fahrer ohne Zeile erscheinen im Auto als „in Notion, nicht übernommen“ mit Knopf „übernehmen“ (öffnet das Pauschalen-Formular).
- [ ] Commit `spec: autoliste – warteschlange statt notion_ok_am, uebernahme aus notion`.

### Task 1: Datenbank – Verlauf, Setzen, Entfernen, Übernahme, Liste

**Files:**
- Create: `migrations/2026-11-01-autoliste.sql`
- Create: `scripts/test-autoliste.mjs`

**Interfaces – Produces:**
- Tabelle `fahrer_auto(id, notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von, am)`; View `fahrer_auto_aktuell` (letzte Zeile je Nr.)
- Tabelle `fuhrpark_notion_offen(kennzeichen_key text pk, seit timestamptz)`
- `fuhrpark.notion_page_id text`, `fuhrpark.notion_fahrer int[]`; `fuhrpark_ersetzen(p_zeilen jsonb)` nimmt zusätzlich `notion_page_id`, `notion_fahrer` (jsonb-Array von Zahlen)
- `kennzeichen_anzeige(text) returns text`
- `auto_fahrer_setzen(p_kennzeichen_key text, p_nr int, p_art text default null, p_betrag numeric default null, p_prozent_satz numeric default null, p_prozent_schwelle numeric default null, p_gilt_ab text default null, p_gilt_bis text default null, p_grund text default null) returns jsonb` → `{"autos": [keys, die nach Notion müssen]}`
- `auto_fahrer_entfernen(p_nr int) returns jsonb` → `{"autos": [...]}`
- `fahrer_auto_uebernehmen() returns int`
- View `autoliste` (security_invoker): `kennzeichen_key, kennzeichen, modell, firma, fahrer jsonb, notion_nicht_uebernommen jsonb, notion_offen bool`
- `pauschale_setzen` akzeptiert jetzt auch eine Nr., die nur in `notion_fahrer` steht.

- [ ] **Step 1: Test schreiben** `scripts/test-autoliste.mjs` – gleicher Aufbau wie `scripts/test-pauschalen.mjs` (PGlite, Rollen, `auth.jwt()`, `is_app_user()`, `protokoll_schreiben`-Attrappe, `kennzeichen_key`-Nachbau wie live: `upper(regexp_replace(coalesce(x,''), '[^A-Za-z0-9]', '', 'g'))`), Tabellen `fahrer` (mit `fahrer_mietmodell_check`, `kennzeichen`, `telefon`), `abrechnung_freigaben` (W42, W43), `notion_fahrer(notion_page_id, notion_fahrer_id, name, telefon)`, `fuhrpark(kennzeichen_key pk, kennzeichen, modell, firma, pauschale, pauschal_modell, eigentuemer text[], vin, kilometerstand, ablauf_pickerl date, polizze, versicherung_monatlich, taxameter text[], bolt_werbung bool, dashcam bool, aktualisiert_am)`. Dann alle Pauschalen-Migrationen (Übernahme, setzen, eigene-als-fix, scharf, in Repo-Reihenfolge) und `2026-11-01-autoliste.sql`. Daten: 3 Autos (W-1TX HYD, W-2TX HYD, W-3TX Abgemeldet), Notion-Fahrer 101 Ali, 102 Bea, 103 Pavel (nur Notion), 104 Doppel; `fahrer` für 101 (W-1TX), 102 (W-2TX), 104 (W-2TX). Prüfungen:

```js
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
});
await pruefe('Wechsel: Ali von W1TX auf W2TX, beide Autos nach Notion, Pauschale bleibt', async () => {
  const r = await eins(`select auto_fahrer_setzen('W2TX', 101) r`);
  assert.deepEqual(r.r.autos.sort(), ['W1TX', 'W2TX']);
  assert.equal((await eins(`select kennzeichen from fahrer where notion_fahrer_id = 101`)).kennzeichen, 'W-2TX');
});
await pruefe('Doppelt speichern ist harmlos', async () => {
  await eins(`select auto_fahrer_setzen('W2TX', 101)`);
  assert.equal((await eins(`select count(*)::int n from fahrer_auto_aktuell where notion_fahrer_id = 101`)).n, 1);
});
await pruefe('Entfernen: kennzeichen null, aktiv bleibt', async () => {
  const r = await eins(`select auto_fahrer_entfernen(102) r`);
  assert.deepEqual(r.r.autos, ['W2TX']);
  assert.deepEqual(await eins(`select kennzeichen, aktiv from fahrer where notion_fahrer_id = 102`), { kennzeichen: null, aktiv: true });
});
await pruefe('Regeln: abgemeldetes Auto, unbekannter Fahrer, nicht Buero', async () => {
  await assert.rejects(eins(`select auto_fahrer_setzen('W3TX', 101)`), /nicht angemeldet/);
  await assert.rejects(eins(`select auto_fahrer_setzen('W1TX', 999, 'f12', 1)`), /nicht in Notion/);
  await db.exec(`select set_config('request.jwt.claims', '{"app_metadata":{"fahrer_nr":101}}', false)`);
  await assert.rejects(eins(`select auto_fahrer_setzen('W1TX', 101)`), /Nicht autorisiert/);
});
await pruefe('Verlauf gesperrt', async () => {
  await assert.rejects(db.exec(`update fahrer_auto set kennzeichen = 'x'`), /nicht geändert/);
  await assert.rejects(db.exec(`delete from fahrer_auto`), /nicht geändert/);
});
```
(`alsBuero`, `eins`, `q`, `pruefe` wie in `test-pauschalen.mjs`; Notion-Fahrer 103 mit Telefon `0660 1234`.)

- [ ] **Step 2: laufen lassen** – `PGLITE=<dir> node scripts/test-autoliste.mjs` → FAIL (Migration fehlt).

- [ ] **Step 3: Migration schreiben** `migrations/2026-11-01-autoliste.sql`:

```sql
-- Autoliste: Fahrer↔Auto in HYDRAlink (Spec docs/superpowers/specs/2026-11-01-autoliste-design.md)
-- Rollback: drop view autoliste, fahrer_auto_aktuell; drop function auto_fahrer_setzen, auto_fahrer_entfernen,
--   fahrer_auto_uebernehmen, kennzeichen_anzeige, telefon_wie_fullsync, fahrer_auto_gesperrt;
--   drop table fuhrpark_notion_offen, fahrer_auto; alter table fuhrpark drop column notion_page_id, drop column notion_fahrer;
--   fuhrpark_ersetzen + pauschale_setzen aus ihren vorigen Migrationen neu anlegen

alter table public.fuhrpark add column if not exists notion_page_id text, add column if not exists notion_fahrer int[];

create table if not exists public.fahrer_auto (
  id bigint generated always as identity primary key,
  notion_fahrer_id integer not null,
  kennzeichen_key text,
  kennzeichen text,
  quelle text not null check (quelle in ('hand', 'uebernahme', 'notion')),
  von text not null,
  am timestamptz not null default now(),
  check ((kennzeichen_key is null) = (kennzeichen is null))
);
create index if not exists fahrer_auto_nr on public.fahrer_auto (notion_fahrer_id, am desc, id desc);
create table if not exists public.fuhrpark_notion_offen (kennzeichen_key text primary key, seit timestamptz not null default now());

create or replace function public.fahrer_auto_gesperrt() returns trigger language plpgsql set search_path = public as $$
begin raise exception 'Der Auto-Verlauf wird nicht geändert oder gelöscht' using errcode = '42501'; end $$;
drop trigger if exists fahrer_auto_gesperrt on public.fahrer_auto;
create trigger fahrer_auto_gesperrt before update or delete on public.fahrer_auto for each row execute function public.fahrer_auto_gesperrt();
drop trigger if exists fahrer_auto_gesperrt_alles on public.fahrer_auto;
create trigger fahrer_auto_gesperrt_alles before truncate on public.fahrer_auto for each statement execute function public.fahrer_auto_gesperrt();
drop trigger if exists protokoll_mitschreiben on public.fahrer_auto;
create trigger protokoll_mitschreiben after insert on public.fahrer_auto for each row execute function public.protokoll_schreiben('id', 'ohne', '', '');

alter table public.fahrer_auto enable row level security;
alter table public.fuhrpark_notion_offen enable row level security;
revoke all on public.fahrer_auto, public.fuhrpark_notion_offen from public, anon, authenticated;
grant select on public.fahrer_auto, public.fuhrpark_notion_offen to authenticated;
drop policy if exists buero_liest on public.fahrer_auto;
create policy buero_liest on public.fahrer_auto for select to authenticated using (public.is_app_user());
drop policy if exists buero_liest on public.fuhrpark_notion_offen;
create policy buero_liest on public.fuhrpark_notion_offen for select to authenticated using (public.is_app_user());

create or replace view public.fahrer_auto_aktuell with (security_invoker = true) as
  select distinct on (notion_fahrer_id) * from public.fahrer_auto order by notion_fahrer_id, am desc, id desc;

-- wie der n8n-Full-Sync: Teil vor "(", Leerzeichen zusammengezogen
create or replace function public.kennzeichen_anzeige(p text) returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(split_part(coalesce(p, ''), '(', 1), '\s+', ' ', 'g')), '')
$$;
-- wie der n8n-Full-Sync ("Merge All Data")
create or replace function public.telefon_wie_fullsync(p text) returns text language sql immutable set search_path = public as $$
  select case when t is null or t = '' then null
              when t like '0043%' then '+43' || substr(t, 5)
              when t like '00%' then '+' || substr(t, 3)
              when t like '0%' then '+43' || substr(t, 2)
              when t like '+%' then t else '+43' || t end
    from (select regexp_replace(coalesce(p, ''), '[\s\-/]', '', 'g') t) x
$$;
```
Danach `fuhrpark_ersetzen` neu: **live-Definition holen** (`select pg_get_functiondef('public.fuhrpark_ersetzen(jsonb)'::regprocedure)`, am 01.11. = `migrations/2026-09-22-notion-sync.sql`) und nur ergänzen: im `jsonb_to_recordset` `notion_page_id text, notion_fahrer jsonb`, im INSERT die Spalten `notion_page_id`, `notion_fahrer` mit `case when z.notion_fahrer is null then null else array(select (jsonb_array_elements_text(z.notion_fahrer))::int) end`, im `do update set` beide Spalten.

`pauschale_setzen`: live-Definition übernehmen, die Fahrer-Prüfung ersetzen durch
```sql
  if not exists (select 1 from public.fahrer where notion_fahrer_id = p_nr)
     and not exists (select 1 from public.notion_fahrer where notion_fahrer_id = p_nr) then
    raise exception 'Fahrer Nr. % nicht gefunden', p_nr using errcode = '22023'; end if;
```

Setzen / Entfernen / Übernahme:
```sql
create or replace function public.auto_fahrer_setzen(
  p_kennzeichen_key text, p_nr integer, p_art text default null, p_betrag numeric default null,
  p_prozent_satz numeric default null, p_prozent_schwelle numeric default null,
  p_gilt_ab text default null, p_gilt_bis text default null, p_grund text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_auto public.fuhrpark; v_nf public.notion_fahrer; v_alt public.fahrer_auto;
  v_wer text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
  v_kz text; v_fid integer; v_autos text[];
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_auto from public.fuhrpark where kennzeichen_key = p_kennzeichen_key;
  if v_auto.kennzeichen_key is null or coalesce(v_auto.firma, '') = 'Abgemeldet' then
    raise exception 'Auto % ist nicht angemeldet', p_kennzeichen_key using errcode = '22023'; end if;
  select * into v_nf from public.notion_fahrer where notion_fahrer_id = p_nr order by aktualisiert_am desc limit 1;
  if v_nf.notion_fahrer_id is null or nullif(btrim(v_nf.name), '') is null then
    raise exception 'Fahrer Nr. % ist nicht in Notion', p_nr using errcode = '22023'; end if;

  if p_art is not null then
    perform public.pauschale_setzen(p_nr, p_art, p_betrag, p_prozent_satz, p_prozent_schwelle, p_gilt_ab, p_gilt_bis, p_grund);
  elsif (public.pauschale_fuer(p_nr, public.pauschale_stichwoche())).id is null then
    raise exception 'Pauschale fehlt – bitte für % festlegen', v_nf.name using errcode = '22023';
  end if;

  v_kz := public.kennzeichen_anzeige(v_auto.kennzeichen);
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  values (p_nr, p_kennzeichen_key, v_kz, 'hand', v_wer);

  select max(id) into v_fid from public.fahrer where notion_fahrer_id = p_nr;
  if v_fid is null then
    insert into public.fahrer (name, telefon, kennzeichen, aktiv, notion_fahrer_id, mietmodell, basis_miete, prozent_satz, prozent_schwelle)
    values (btrim(v_nf.name), public.telefon_wie_fullsync(v_nf.telefon), v_kz, true, p_nr, 'fix', 0, 0, 0);
  else
    update public.fahrer set kennzeichen = v_kz, aktiv = true where id = v_fid;
  end if;
  perform public.pauschalen_anwenden(p_nr);

  v_autos := array_remove(array[p_kennzeichen_key, case when v_alt.kennzeichen_key is distinct from p_kennzeichen_key then v_alt.kennzeichen_key end], null);
  insert into public.fuhrpark_notion_offen (kennzeichen_key) select unnest(v_autos) on conflict do nothing;
  return jsonb_build_object('autos', to_jsonb(v_autos));
end $$;

create or replace function public.auto_fahrer_entfernen(p_nr integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_alt public.fahrer_auto; v_wer text := coalesce(nullif(btrim(auth.jwt()->'app_metadata'->>'app_name'), ''), 'Büro');
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into v_alt from public.fahrer_auto_aktuell where notion_fahrer_id = p_nr;
  if v_alt.kennzeichen_key is null then return jsonb_build_object('autos', '[]'::jsonb); end if;
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von) values (p_nr, null, null, 'hand', v_wer);
  update public.fahrer set kennzeichen = null where id = (select max(id) from public.fahrer where notion_fahrer_id = p_nr);
  insert into public.fuhrpark_notion_offen (kennzeichen_key) values (v_alt.kennzeichen_key) on conflict do nothing;
  return jsonb_build_object('autos', jsonb_build_array(v_alt.kennzeichen_key));
end $$;

-- Start: Notion-Stand übernehmen, nur Fahrer mit fahrer-Zeile und ohne Verlauf. Doppel-Auto: das von fahrer.kennzeichen, sonst das erste.
create or replace function public.fahrer_auto_uebernehmen() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
  select distinct on (x.nr) x.nr, x.kennzeichen_key, public.kennzeichen_anzeige(x.kennzeichen), 'uebernahme', 'Übernahme aus Notion'
    from (select unnest(fp.notion_fahrer) nr, fp.kennzeichen_key, fp.kennzeichen from public.fuhrpark fp
           where coalesce(fp.firma, '') <> 'Abgemeldet') x
    join public.fahrer f on f.notion_fahrer_id = x.nr and f.aktiv
   where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = x.nr)
   order by x.nr, (public.kennzeichen_key(f.kennzeichen) = x.kennzeichen_key) desc, x.kennzeichen_key;
  get diagnostics n = row_count;
  update public.fahrer f set kennzeichen = a.kennzeichen from public.fahrer_auto_aktuell a
   where a.notion_fahrer_id = f.notion_fahrer_id and f.aktiv and a.quelle = 'uebernahme' and f.kennzeichen is distinct from a.kennzeichen;
  return n;
end $$;

create or replace view public.autoliste with (security_invoker = true) as
with s as (select public.pauschale_stichwoche() w),
akt as (select a.*, nf.name, p.art, p.betrag, p.prozent_satz, p.prozent_schwelle
          from public.fahrer_auto_aktuell a cross join s
          left join public.notion_fahrer nf on nf.notion_fahrer_id = a.notion_fahrer_id
          left join lateral public.pauschale_fuer(a.notion_fahrer_id, s.w) p on true
         where a.kennzeichen_key is not null)
select fp.kennzeichen_key, fp.kennzeichen, fp.modell, fp.firma,
  coalesce((select jsonb_agg(jsonb_build_object('nr', akt.notion_fahrer_id, 'name', akt.name, 'art', akt.art, 'betrag', akt.betrag,
            'prozent_satz', akt.prozent_satz, 'prozent_schwelle', akt.prozent_schwelle, 'seit', akt.am) order by akt.name)
            from akt where akt.kennzeichen_key = fp.kennzeichen_key), '[]') as fahrer,
  coalesce((select jsonb_agg(jsonb_build_object('nr', nf.notion_fahrer_id, 'name', nf.name, 'telefon', nf.telefon) order by nf.name)
            from unnest(fp.notion_fahrer) u(nr) join public.notion_fahrer nf on nf.notion_fahrer_id = u.nr
           where not exists (select 1 from public.fahrer_auto a where a.notion_fahrer_id = u.nr)), '[]') as notion_nicht_uebernommen,
  exists (select 1 from public.fuhrpark_notion_offen o where o.kennzeichen_key = fp.kennzeichen_key) as notion_offen
from public.fuhrpark fp
where coalesce(fp.firma, '') <> 'Abgemeldet';

revoke all on function public.auto_fahrer_setzen(text, integer, text, numeric, numeric, numeric, text, text, text),
  public.auto_fahrer_entfernen(integer) from public, anon;
grant execute on function public.auto_fahrer_setzen(text, integer, text, numeric, numeric, numeric, text, text, text),
  public.auto_fahrer_entfernen(integer) to authenticated;
revoke all on function public.fahrer_auto_uebernehmen() from public, anon, authenticated;
-- protokoll_bereich: 'fahrer_auto' -> 'zuordnungen' (live-Definition übernehmen und Zeile ergänzen)
```

- [ ] **Step 4: Test grün** – `PGLITE=<dir> node scripts/test-autoliste.mjs` → alle ok; `test-pauschalen.mjs` weiter grün.
- [ ] **Step 5: Commit** `autoliste: fahrer_auto, setzen/entfernen/uebernahme, liste; tests`.

### Task 2: Wächter fürs Kennzeichen (Scharfschalten-Datei)

**Files:** Create `migrations/2026-11-01-autoliste-scharf.sql`; Modify `scripts/test-autoliste.mjs`

**Interfaces – Consumes:** `fahrer_auto_aktuell`, `kennzeichen_anzeige`, bestehender `fahrer_pauschale_waechter`.
**Produces:** Trigger `fahrer_auto_waechter` (BEFORE INSERT OR UPDATE ON fahrer). Postgres führt BEFORE-Trigger alphabetisch aus (dieser vor `fahrer_pauschale_waechter`); egal, beide setzen verschiedene Spalten.

- [ ] **Step 1: Tests anhängen**
```js
await db.exec(lies('../migrations/2026-11-01-autoliste-scharf.sql'));
await pruefe('Full-Sync-Upsert kann das Kennzeichen nicht zurueckdrehen', async () => {
  await db.exec(`insert into fahrer (name, kennzeichen, mietmodell, basis_miete, prozent_satz, prozent_schwelle, aktiv)
                 values ('Pavel Paunov', 'W-9TX', 'fix', 1, 0, 0, true)
                 on conflict (name) do update set kennzeichen = excluded.kennzeichen`);
  assert.equal((await eins(`select kennzeichen from fahrer where notion_fahrer_id = 103`)).kennzeichen, 'W-2TX');
});
await pruefe('Entfernter Fahrer bleibt ohne Auto, auch wenn Notion ihn noch fuehrt', async () => {
  await db.exec(`update fahrer set kennzeichen = 'W-2TX' where notion_fahrer_id = 102`);
  assert.equal((await eins(`select kennzeichen from fahrer where notion_fahrer_id = 102`)).kennzeichen, null);
});
await pruefe('Onboarding nur ueber Notion: einmalige Uebernahme als quelle notion', async () => {
  await db.exec(`insert into notion_fahrer values ('p105', 105, 'Neu Fahrer', null)`);
  await db.exec(`insert into fahrer (name, kennzeichen, mietmodell, basis_miete, prozent_satz, prozent_schwelle, aktiv, notion_fahrer_id)
                 values ('Neu Fahrer', 'W 1TX (neu)', 'f12', 500, 10, 1200, true, 105)`);
  assert.deepEqual(await eins(`select kennzeichen_key k, kennzeichen, quelle from fahrer_auto_aktuell where notion_fahrer_id = 105`),
    { k: 'W1TX', kennzeichen: 'W 1TX', quelle: 'notion' });
});
```
(Test-Setup: `fahrer` braucht `unique (name)` wie live – im Nachbau ergänzen.)
- [ ] **Step 2:** FAIL bestätigen.
- [ ] **Step 3: Migration**
```sql
-- Autoliste scharf: HYDRAlink entscheidet das Kennzeichen. Erst mit Dashboard + Notion-Rückschreiben einspielen.
select public.fahrer_auto_uebernehmen() as uebernommen;
create or replace function public.fahrer_auto_waechter() returns trigger language plpgsql security definer set search_path = public as $$
declare v public.fahrer_auto; v_kz text; v_key text;
begin
  if new.notion_fahrer_id is null then return new; end if;
  begin
    select * into v from public.fahrer_auto_aktuell where notion_fahrer_id = new.notion_fahrer_id;
    if v.id is not null then
      new.kennzeichen := v.kennzeichen;
    elsif coalesce(new.aktiv, false) and public.kennzeichen_anzeige(new.kennzeichen) is not null then
      v_kz := public.kennzeichen_anzeige(new.kennzeichen);
      -- Schlüssel des Autos aus dem Fuhrpark (Notion-Titel kann Zusätze wie "(neu)" haben), sonst aus der Anzeigeform
      select fp.kennzeichen_key into v_key from public.fuhrpark fp
       where fp.kennzeichen_key in (public.kennzeichen_key(new.kennzeichen), public.kennzeichen_key(v_kz))
       order by (fp.kennzeichen_key = public.kennzeichen_key(v_kz)) desc limit 1;
      insert into public.fahrer_auto (notion_fahrer_id, kennzeichen_key, kennzeichen, quelle, von)
      values (new.notion_fahrer_id, coalesce(v_key, public.kennzeichen_key(v_kz)), v_kz, 'notion', 'Automatik (aus Notion)');
      new.kennzeichen := v_kz;
    end if;
  exception when others then raise warning 'fahrer_auto_waechter(Nr. %): %', new.notion_fahrer_id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.fahrer_auto_waechter() from public, anon, authenticated;
drop trigger if exists fahrer_auto_waechter on public.fahrer;
create trigger fahrer_auto_waechter before insert or update on public.fahrer for each row execute function public.fahrer_auto_waechter();
```
- [ ] **Step 4:** grün. **Step 5:** Commit `autoliste scharf: waechter fuers kennzeichen (noch nicht live)`.

### Task 3: Notion – Spiegeln und Zurückschreiben

**Files:**
- Create: `supabase/functions/_shared/fuhrpark-logik.ts`, `supabase/functions/fuhrpark-notion/index.ts`, `scripts/test-fuhrpark-logik.mjs`
- Modify: `supabase/functions/notion-sync/index.ts`

**Interfaces – Produces:**
- `fahrerIdsAusRelation(seite, nrJePageId: Map<string, number>): number[]` – „Fahrer aktuell“ (`properties["Fahrer aktuell"].relation[].id`, Bindestriche egal) → Fahrer-Nr.
- `relationBody(pageIds: string[]): object` → `{ properties: { "Fahrer aktuell": { relation: pageIds.map((id) => ({ id })) } } }`
- `notionNachziehen(keys: string[] | null, deps)`: liest je Auto `fahrer_auto_aktuell` (Nr.), `notion_fahrer.notion_page_id`, `fuhrpark.notion_page_id`; PATCH `https://api.notion.com/v1/pages/{page}` mit `relationBody`; bei Erfolg Zeile aus `fuhrpark_notion_offen` löschen; Rückgabe `{ ok: string[], fehler: {key, text}[] }`. `keys = null` → alle offenen.
- Edge Function `fuhrpark-notion`: POST `{ autos?: string[] }`, nur Büro-JWT oder service_role (gleiche Prüfung wie `bolt-sync`, `verify_jwt` an), Notion-Token über `verbindung_zugang` der Verbindung `anbieter = 'notion'`.

- [ ] **Step 1: Tests** `scripts/test-fuhrpark-logik.mjs` (`node --test`, Import der TS-Datei wie bei `test-uber-logik.mjs`): Relation mit/ohne Bindestriche, unbekannte Page-ID wird ausgelassen; `relationBody([])` leert das Feld; `notionNachziehen` mit Attrappen: Erfolg löscht aus offen, HTTP 502 lässt das Auto offen und meldet Fehler (Review Focus 3).
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. In `notion-sync`: Fahrer **vor** dem Fuhrpark holen, `nrJePageId` bauen, je Auto `notion_page_id: s.id` und `notion_fahrer: fahrerIdsAusRelation(s, nrJePageId)` mitschicken; nach `fuhrpark_ersetzen` `notionNachziehen(null, …)` aufrufen (Fehler nur loggen, Lauf nicht abbrechen).
- [ ] **Step 4:** grün; `deno check` beider Functions. **Step 5:** Commit `autoliste: notion spiegeln (page-id, fahrer aktuell) und zurueckschreiben; tests`.

### Task 4: Dashboard – Fahrer → Autos

**Files:**
- Create: `autoliste-logik.js` (Browser + Node, wie `pauschalen-logik.js`), `scripts/test-autoliste-logik.mjs`, `scripts/test-autoliste-ansicht.mjs` (Muster `test-pauschalen-ansicht.mjs`)
- Modify: `dashboard.html` (neuer Reiter `contentAutos`, Menüpunkt unter „Fahrer“, Fuhrpark-Punkt unter „Experimentell“ entfernen), `sw.js` (Datei vorladen, Cache v64)

**Interfaces – Consumes:** View `autoliste`, `notion_fahrer`, `fahrer_auto` (Verlauf je Auto), RPCs aus Task 1, Edge Function aus Task 3, `PauschalenLogik` + Pauschalen-Formularbausteine (`pauVorschauHtml`, `pauWerteLesen` – auf `au` übertragen, nicht duplizieren: Formular-HTML in eine Funktion `pauFormHtml(nr, werte, stich)` herausziehen, die beide Reiter nutzen).
**Produces:** `AutolisteLogik.sortiere(autos)` (frei zuerst, dann Kennzeichen), `AutolisteLogik.filtere(autos, text, chip)` (Kennzeichen, Modell, Fahrername; chip `alle|frei|belegt`), `AutolisteLogik.sucheFahrer(alle, text, sitzt)` (Name/Nr./Telefon, max. 20, Markierung „sitzt auf …“).

- [ ] **Step 1: Logik-Tests** (sortiere, filtere inkl. Umlaute und Kennzeichen ohne Bindestrich, sucheFahrer mit Nr.-Treffer und „sitzt auf“). **Step 2:** FAIL. **Step 3:** `autoliste-logik.js`. **Step 4:** grün.
- [ ] **Step 5: Reiter bauen** – Tabelle `Kennzeichen · Modell · Fahrer · Pauschale` (Fahrer/Pauschale je Fahrer eine Zeile im Feld, `zeile-sub` für zweite Zeile), Suchfeld, Chips Alle/Frei/Belegt. Detail: Fahrer mit „entfernen“ (confirm), „Fahrer hinzufügen“ → Suchfeld + Trefferliste → Auswahl → `pauFormHtml` (vorbelegt mit `pauJetzt`, sonst leer; Speichern-Knopf deaktiviert, solange keine gültige Pauschale) → RPC `auto_fahrer_setzen` (mit Pauschale nur, wenn geändert) → `functions.invoke('fuhrpark-notion', {body:{autos}})` → bei Fehler Hinweis „Notion noch offen – wird automatisch nachgeholt“. „In Notion, nicht übernommen“-Zeilen mit Knopf „übernehmen“ (öffnet dasselbe Formular). Verlauf des Autos (letzte 10 Zeilen aus `fahrer_auto` mit diesem `kennzeichen_key` oder Wechsel weg davon). Schalter `const AU_AKTIV = false`.
- [ ] **Step 6: Ansichtstest** mit Attrappe (Desktop 1400 + Handy 390): Liste, Detail, Fahrer suchen, Pavel einsetzen schickt `{p_kennzeichen_key:'W2TX', p_nr:103, p_art:'f12', p_betrag:550, …}`; `bash scripts/check-dashboard.sh`.
- [ ] **Step 7:** Commit `autoliste: dashboard fahrer -> autos (schalter aus); tests`.

### Task 5: Live

- [ ] Betreiber-OK „spiel … ein“: `2026-11-01-autoliste.sql` einspielen (wirkt noch nicht).
- [ ] `notion-sync` und `fuhrpark-notion` deployen (Freigabe), Handlauf `notion-sync` → `fuhrpark.notion_page_id`/`notion_fahrer` gefüllt (61 Autos), `autoliste` zeigt Pavel unter „in Notion, nicht übernommen“.
- [ ] `2026-11-01-autoliste-scharf.sql` einspielen; Prüfen mit Rollback-Transaktion: Full-Sync-Upsert ändert Kennzeichen nicht.
- [ ] `AU_AKTIV = true`, Commit, Betreiber pusht; Pavel gemeinsam mit dem Betreiber einsetzen; Notion zeigt ihn auf W 204TX.
- [ ] CLAUDE.md-Abschnitt „Autoliste“, Erinnerung aktualisieren, Team-Satz: „Fahrer werden nur noch in HYDRAlink einem Auto zugeordnet.“
