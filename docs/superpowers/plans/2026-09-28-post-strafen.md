# Post & Strafen – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** USP-Postkorb von Hydrafleet KG in HYDRAlink ablegen (PDF, Volltext, Suche), Lenkererhebungen per Knopf mit „vermietet an“ über Gmail beantworten, Straf-/Anonymverfügungen einem Fahrer zuordnen und für die Fahrerapp freigeben, Rückstand aus dem USP nachholen.

**Architecture:** Das USP-Skript auf `taxi` schickt jedes PDF zusätzlich an die Edge Function `post-eingang` (speichert in Bucket `post`, liest mit Claude aus, prüft mit reiner Logik aus `_shared/post-logik.ts`). `post-senden` beantwortet Lenkererhebungen über die Gmail-API und gleicht mit Gmail „Gesendet“ ab. Büro-UI ist die neue Seite `post.html` (Muster `lohn.html`), Fahrer sehen freigegebene Strafen unter „Mehr → Strafen“ in `fahrer/index.html`.

**Tech Stack:** Supabase (Postgres 17, RLS, Storage, Edge Functions/Deno), Vanilla-JS-HTML-Seiten, Bash auf dem Hetzner-Server `taxi`, Gmail API, Anthropic Messages API (`claude-sonnet-5`), Node 25 für lokale Tests (`node --test`, TypeScript-Import ohne Build).

**Spec:** `docs/superpowers/specs/2026-09-28-post-strafen-design.md`

## Global Constraints

- Supabase-Projekt `pkxcwfkfaaorwnbdmylg`; Migrationen als Datei in `migrations/` UND per Supabase-MCP `apply_migration` eingespielt; Edge Functions per MCP `deploy_edge_function`, danach Repo-Datei = deployte Fassung (CLAUDE.md).
- `verify_jwt` bleibt bei allen Functions **an**.
- `settlements`, AbrechnungsBot, n8n, Notion werden nicht angefasst.
- Telegram-Teil von `/root/usp-bot.sh` bleibt unverändert; HYDRAlink-Aufruf darf ihn nie blockieren.
- Mieter: Sorhan Taxi KG, Seitenstettengasse 5/37, 1010 Wien — bis **10.01.2026 inkl.**; EH Limousinenservice KG, Thalhaimergasse 47/4, 1160 Wien, ATU74849827, FN 521134 z — ab **11.01.2026**, offen. Maßgeblich: Datum der Tatzeit in Europe/Vienna.
- Absender der Antworten: `sw.hydrafleet@gmail.com` (Gmail-API). Betreff `GZ: <gz>`. Ohne Anhang.
- Senden nur auf Knopfdruck. Nie zweimal an dieselbe GZ.
- Fahrer sieht eine Strafe nur, wenn `freigegeben_am is not null` und `fahrer_id` = er selbst.
- Alle Zugangsdaten nur im Vault (`verbindung_setzen` / `verbindung_zugang`), nie im Repo, nie in der Ausgabe.
- UI-Texte deutsch; Seiten ohne Build-Step, eine HTML-Datei je Seite; Tabellen statt Karten.
- Fahrerapp: PDF öffnet per signierter URL im neuen Tab (kein iframe, iPhone). Service-Worker-Cache hochzählen (`sw.js` `hydralink-v19` → `v20`).
- Push auf `main` macht der Betreiber (`! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`).
- Skripte, die den service_role-Key aus `.n8n-backup/` lesen, startet der Betreiber selbst per `!` (Claude-Auto-Mode blockiert das), ausgenommen die freigegebene Regel `node scripts/uber-sync-aufrufen.js`.

## Review Focus

1. **Zweites PDF derselben Zustellung / erneuter Upload** → kein Doppel-Eintrag, keine zweite Mail (sha256 unique + GZ-Sperre). Test in Task 3 und Task 5.
2. **Tatzeit genau am Stichtag 10.01. / 11.01. spätabends UTC** → Mieter nach Wiener Datum (10.01. 23:30 Wien = Sorhan, 11.01. 00:30 Wien = EH, obwohl UTC noch 10.01.). Test in Task 2.
3. **Claude liefert eine Mailadresse, die nicht im PDF steht, oder eine Nicht-`.gv.at`-Adresse** → Status `pruefen`, kein Sende-Knopf. Test in Task 2.
4. **Fahrer ruft PDF-Pfad eines fremden oder nicht freigegebenen Eintrags ab** → Storage verweigert. Test in Task 1.
5. **HYDRAlink nicht erreichbar, während usp-bot.sh läuft** → Telegram + CloseDelivery laufen trotzdem, Log-Zeile „HYDRAlink: HTTP 000“. Test in Task 6.

---

## Datei-Übersicht

| Datei | Zweck |
|---|---|
| `migrations/2026-09-28-post.sql` | Tabellen, RLS, RPCs, Bucket, Policies, Mieter-Startdaten, Anbieter `usp`/`gmail`/`anthropic` |
| `supabase/functions/_shared/post-logik.ts` | reine Funktionen: Mieter zur Tatzeit, Prüfung der Auslese, Mailtext, Knopftext, MIME |
| `scripts/test-post-logik.mjs` | `node --test` für post-logik |
| `supabase/functions/post-eingang/index.ts` | Eingang: Auth, Hash, Storage, Claude-Auslese, Vorschlag |
| `supabase/functions/post-senden/index.ts` | Gmail: senden, Abgleich „Gesendet“ |
| `scripts/post-zugaenge-einrichten.js` | Betreiber: USP-Schlüssel erzeugen, Anthropic-Key speichern (Vault), Schlüssel nach taxi |
| `scripts/gmail-zugang-speichern.js` | Betreiber: Google-OAuth einmalig, Refresh-Token → Vault |
| `scripts/usp-rueckstand.sh` | auf taxi: abgeschlossene Zustellungen aus USP holen → post-eingang |
| `/root/usp-bot.sh` (taxi) | + HYDRAlink-Aufruf |
| `post.html` | Büro-Seite „Post“ |
| `dashboard.html`, `lohn.html` | Link „Post“ in der Kopfleiste |
| `fahrer/index.html`, `sw.js` | „Mehr → Strafen“, Cache v20 |
| `CLAUDE.md`, `docs/2026-09-23-uebergabe.md` | Doku |

---

### Task 1: Datenbank (Migration)

**Files:**
- Create: `migrations/2026-09-28-post.sql`

**Interfaces:**
- Produces: Tabellen `mietverhaeltnisse`, `post_eingang`, `post_ausgang`; Bucket `post`;
  `mieter_zur_tatzeit(timestamptz) returns setof mietverhaeltnisse`,
  `post_fahrer_vorschlag(text) returns integer`,
  `post_zuordnen(uuid, integer)`, `post_freigeben(uuid)`, `post_freigabe_zuruecknehmen(uuid)`,
  `post_erledigt(uuid, text)`, `post_wieder_oeffnen(uuid)`, `post_notiz(uuid, text)` (alle `returns void`),
  `fahrer_app_strafen(integer default null) returns table(id uuid, art text, behoerde text, gz text, tatzeit timestamptz, tatort text, delikt text, betrag numeric, frist date, pfad text)`,
  `post_pfad_erlaubt(text) returns boolean`.

- [ ] **Step 1: Migration schreiben**

```sql
-- Post & Strafen (Spec docs/superpowers/specs/2026-09-28-post-strafen-design.md)
-- USP-Postkorb Hydrafleet KG: Eingang, Antworten, Mieter. Schreibt nichts Bestehendes um.

-- Zugänge im Vault: USP-Eingangsschlüssel, Gmail, Anthropic
alter table public.verbindungen drop constraint if exists verbindungen_anbieter_check;
alter table public.verbindungen add constraint verbindungen_anbieter_check
  check (anbieter in ('bolt', 'uber', 'mypos', 'notion', 'usp', 'gmail', 'anthropic'));

-- === Mieter der ganzen Flotte, nach Zeitraum =================================
create table if not exists public.mietverhaeltnisse (
  id          serial primary key,
  kurz        text not null,                 -- 'EH', 'Sorhan' (Knopf)
  name        text not null,
  adresse     text not null,
  uid         text,
  fn          text,
  gueltig_von date,                          -- null = seit jeher
  gueltig_bis date,                          -- null = offen; inklusive
  constraint mietverhaeltnisse_zeitraum check (gueltig_von is null or gueltig_bis is null or gueltig_von <= gueltig_bis),
  constraint mietverhaeltnisse_keine_ueberschneidung
    exclude using gist (daterange(gueltig_von, gueltig_bis, '[]') with &&)
);
insert into public.mietverhaeltnisse (kurz, name, adresse, uid, fn, gueltig_von, gueltig_bis)
select * from (values
  ('Sorhan', 'Sorhan Taxi KG', 'Seitenstettengasse 5/37, 1010 Wien', null, null, null::date, date '2026-01-10'),
  ('EH', 'EH Limousinenservice KG', 'Thalhaimergasse 47/4, 1160 Wien', 'ATU74849827', '521134 z', date '2026-01-11', null::date)
) v where not exists (select 1 from public.mietverhaeltnisse);

-- === Eingang: ein Eintrag je PDF ===========================================
create table if not exists public.post_eingang (
  id                  uuid primary key default gen_random_uuid(),
  quelle              text not null check (quelle in ('usp', 'upload')),
  delivery_id         text unique,
  sha256              text not null unique,
  datei_pfad          text not null,
  dateiname           text,
  usp_absender        text,
  usp_betreff         text,
  zugestellt_am       timestamptz,
  eingelesen_am       timestamptz not null default now(),
  art                 text check (art in ('lenkererhebung','strafverfuegung','anonymverfuegung',
                                          'zahlungsaufforderung','mahnung','sonstige')),
  gz                  text,
  behoerde            text,
  kennzeichen         text,
  kennzeichen_key     text,          -- kein FK: fuhrpark wird bei jedem Notion-Sync ersetzt
  tatzeit             timestamptz,
  tatort              text,
  delikt              text,
  betrag              numeric(10,2),
  frist               date,
  antwort_email       text,
  volltext            text,
  auslese_roh         jsonb,
  pruef_grund         text,
  fahrer_vorschlag_id integer references public.fahrer(id) on delete set null,
  fahrer_id           integer references public.fahrer(id) on delete set null,
  status              text not null default 'neu'
                      check (status in ('neu','pruefen','offen','beantwortet','freigegeben','erledigt')),
  freigegeben_am      timestamptz,
  freigegeben_von     uuid,
  erledigt_am         timestamptz,
  erledigt_von        uuid,
  notiz               text,
  suche               tsvector generated always as (to_tsvector('german'::regconfig,
                        coalesce(gz,'') || ' ' || coalesce(kennzeichen,'') || ' ' || coalesce(behoerde,'') || ' ' ||
                        coalesce(usp_absender,'') || ' ' || coalesce(usp_betreff,'') || ' ' ||
                        coalesce(delikt,'') || ' ' || coalesce(tatort,'') || ' ' || coalesce(volltext,''))) stored
);
create index if not exists post_eingang_suche_idx on public.post_eingang using gin (suche);
create index if not exists post_eingang_gz_idx on public.post_eingang (gz);
create index if not exists post_eingang_status_idx on public.post_eingang (status, frist);

-- === Ausgang: jede Antwort im Wortlaut ======================================
create table if not exists public.post_ausgang (
  id                 uuid primary key default gen_random_uuid(),
  eingang_id         uuid references public.post_eingang(id) on delete set null,
  gz                 text not null,
  an                 text not null,
  betreff            text not null,
  text               text not null,
  mietverhaeltnis_id integer references public.mietverhaeltnisse(id),
  gmail_message_id   text,
  gmail_thread_id    text,
  gesendet_am        timestamptz,
  gesendet_von       uuid,
  test_an            text,           -- gesetzt = Probemail an diese Adresse, zählt nicht als Antwort
  fehler             text,
  quelle             text not null check (quelle in ('hydralink', 'gmail_abgleich')),
  erstellt_am        timestamptz not null default now()
);
create index if not exists post_ausgang_gz_idx on public.post_ausgang (gz);
-- Eine echte, erfolgreiche Antwort je GZ
create unique index if not exists post_ausgang_gz_einmal
  on public.post_ausgang (gz) where test_an is null and fehler is null;

-- === RLS: Büro liest alles, schreibt nur Mieter direkt ======================
alter table public.mietverhaeltnisse enable row level security;
alter table public.post_eingang      enable row level security;
alter table public.post_ausgang      enable row level security;

drop policy if exists app_users_all on public.mietverhaeltnisse;
create policy app_users_all on public.mietverhaeltnisse for all to authenticated
  using (public.is_app_user()) with check (public.is_app_user());
drop policy if exists app_users_read on public.post_eingang;
create policy app_users_read on public.post_eingang for select to authenticated using (public.is_app_user());
drop policy if exists app_users_read on public.post_ausgang;
create policy app_users_read on public.post_ausgang for select to authenticated using (public.is_app_user());
revoke all on public.mietverhaeltnisse, public.post_eingang, public.post_ausgang from anon;
grant select, insert, update, delete on public.mietverhaeltnisse to authenticated;
grant usage on sequence public.mietverhaeltnisse_id_seq to authenticated;
grant select on public.post_eingang, public.post_ausgang to authenticated;

-- === Hilfsfunktionen =========================================================
create or replace function public.mieter_zur_tatzeit(p_tatzeit timestamptz)
returns setof public.mietverhaeltnisse language sql stable security definer set search_path = public as $$
  select m.* from public.mietverhaeltnisse m
  where p_tatzeit is not null
    and (p_tatzeit at time zone 'Europe/Vienna')::date <@ daterange(m.gueltig_von, m.gueltig_bis, '[]')
$$;

-- Genau ein aktiver Fahrer mit diesem Kennzeichen -> seine id, sonst null
create or replace function public.post_fahrer_vorschlag(p_kennzeichen text)
returns integer language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then min(f.id) end
  from public.fahrer f
  where f.aktiv and coalesce(f.kennzeichen, '') <> ''
    and public.kennzeichen_key(p_kennzeichen) <> ''
    and public.kennzeichen_key(f.kennzeichen) = public.kennzeichen_key(p_kennzeichen)
$$;

create or replace function public.post_nur_buero() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'nicht_berechtigt' using errcode = '42501'; end if;
end $$;

create or replace function public.post_zuordnen(p_id uuid, p_fahrer_id integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set fahrer_id = p_fahrer_id where id = p_id and freigegeben_am is null;
  if not found then raise exception 'nicht_gefunden_oder_freigegeben'; end if;
end $$;

create or replace function public.post_freigeben(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang
     set status = 'freigegeben', freigegeben_am = now(), freigegeben_von = auth.uid()
   where id = p_id and fahrer_id is not null
     and art in ('strafverfuegung','anonymverfuegung','zahlungsaufforderung','mahnung');
  if not found then raise exception 'freigabe_nicht_moeglich'; end if;
end $$;

create or replace function public.post_freigabe_zuruecknehmen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set status = 'offen', freigegeben_am = null, freigegeben_von = null
   where id = p_id and freigegeben_am is not null;
end $$;

create or replace function public.post_erledigt(p_id uuid, p_notiz text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang
     set status = 'erledigt', erledigt_am = now(), erledigt_von = auth.uid(),
         notiz = coalesce(nullif(p_notiz, ''), notiz)
   where id = p_id;
end $$;

create or replace function public.post_wieder_oeffnen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang e
     set erledigt_am = null, erledigt_von = null,
         status = case
           when exists (select 1 from public.post_ausgang a where a.gz = e.gz and a.test_an is null and a.fehler is null)
             then 'beantwortet'
           when e.freigegeben_am is not null then 'freigegeben'
           when e.pruef_grund is not null then 'pruefen'
           else 'offen' end
   where e.id = p_id;
end $$;

create or replace function public.post_notiz(p_id uuid, p_notiz text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.post_nur_buero();
  update public.post_eingang set notiz = nullif(p_notiz, '') where id = p_id;
end $$;

-- === Fahrerapp ===============================================================
create or replace function public.fahrer_app_strafen(p_fahrer_id integer default null)
returns table (id uuid, art text, behoerde text, gz text, tatzeit timestamptz, tatort text,
               delikt text, betrag numeric, frist date, pfad text)
language sql stable security definer set search_path = public as $$
  select e.id, e.art, e.behoerde, e.gz, e.tatzeit, e.tatort, e.delikt, e.betrag, e.frist, e.datei_pfad
  from public.post_eingang e
  where e.freigegeben_am is not null
    and e.fahrer_id = public.fahrer_app_ziel(p_fahrer_id)
  order by coalesce(e.tatzeit, e.eingelesen_am) desc
$$;

create or replace function public.post_pfad_erlaubt(p_pfad text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_app_user() or exists (
    select 1 from public.post_eingang e
    where e.datei_pfad = p_pfad and e.freigegeben_am is not null
      and e.fahrer_id = public.mein_fahrer_id()
  )
$$;

revoke all on function public.mieter_zur_tatzeit(timestamptz), public.post_fahrer_vorschlag(text),
  public.post_nur_buero(), public.post_zuordnen(uuid, integer), public.post_freigeben(uuid),
  public.post_freigabe_zuruecknehmen(uuid), public.post_erledigt(uuid, text), public.post_wieder_oeffnen(uuid),
  public.post_notiz(uuid, text), public.fahrer_app_strafen(integer), public.post_pfad_erlaubt(text)
  from public, anon;
grant execute on function public.mieter_zur_tatzeit(timestamptz), public.post_fahrer_vorschlag(text),
  public.post_zuordnen(uuid, integer), public.post_freigeben(uuid),
  public.post_freigabe_zuruecknehmen(uuid), public.post_erledigt(uuid, text), public.post_wieder_oeffnen(uuid),
  public.post_notiz(uuid, text), public.fahrer_app_strafen(integer), public.post_pfad_erlaubt(text)
  to authenticated;

-- === Storage: privater Bucket, Schreiben nur service_role (Edge Function) ===
insert into storage.buckets (id, name, public)
values ('post', 'post', false) on conflict (id) do nothing;
drop policy if exists post_lesen on storage.objects;
create policy post_lesen on storage.objects for select to authenticated
  using (bucket_id = 'post' and public.post_pfad_erlaubt(name));
```

- [ ] **Step 2: Einspielen**

Supabase-MCP `apply_migration` mit `name: "2026-09-28-post"` und dem Dateiinhalt.
Erwartet: Erfolg. Falls `exclude using gist` wegen fehlender Operatorklasse scheitert: Zeile
`create extension if not exists btree_gist;` an den Anfang, erneut einspielen.

- [ ] **Step 3: Rechte- und Logiktest (MCP `execute_sql`, alles in Transaktion mit rollback)**

```sql
begin;
-- Testdaten
insert into public.post_eingang (id, quelle, sha256, datei_pfad, art, gz, kennzeichen, status, fahrer_id, freigegeben_am)
select '00000000-0000-0000-0000-0000000000a1', 'upload', 'test-a1', 'test/a1.pdf', 'strafverfuegung', 'T/1/2026', 'W-1TX', 'freigegeben', f.id, now()
from public.fahrer f join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
where f.aktiv and not z.gesperrt order by f.id limit 1;
insert into public.post_eingang (id, quelle, sha256, datei_pfad, art, gz, status, fahrer_id)
select '00000000-0000-0000-0000-0000000000a2', 'upload', 'test-a2', 'test/a2.pdf', 'strafverfuegung', 'T/2/2026', 'offen', fahrer_id
from public.post_eingang where id = '00000000-0000-0000-0000-0000000000a1';

-- Mieter am Stichtag (Wiener Datum)
select (select kurz from public.mieter_zur_tatzeit('2026-01-10 22:30+00')) as "10.01. 23:30 Wien = Sorhan",
       (select kurz from public.mieter_zur_tatzeit('2026-01-10 23:30+00')) as "11.01. 00:30 Wien = EH",
       (select count(*) from public.mieter_zur_tatzeit(null)) as "null = 0";

-- Als Fahrer (der freigegebene Eintrag gehört ihm)
select set_config('request.jwt.claims', json_build_object(
  'sub', z.auth_user_id, 'role', 'authenticated',
  'app_metadata', json_build_object('fahrer_nr', f.notion_fahrer_id))::text, true)
from public.post_eingang e join public.fahrer f on f.id = e.fahrer_id
join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
where e.id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;
select count(*) as "fahrer sieht tabelle direkt (0)" from public.post_eingang;
select count(*) as "fahrer_app_strafen (1)" from public.fahrer_app_strafen();
select public.post_pfad_erlaubt('test/a1.pdf') as "a1 erlaubt (true)",
       public.post_pfad_erlaubt('test/a2.pdf') as "a2 nicht freigegeben (false)";
rollback;
```

Erwartet: `Sorhan`, `EH`, `0`; Fahrer: `0`, `1`, `true`, `false`.
(Die Mieter-Abfrage läuft vor `set local role`.)

- [ ] **Step 4: Büro-Test** (neue Transaktion)

```sql
begin;
insert into public.post_eingang (id, quelle, sha256, datei_pfad, art, gz, status)
values ('00000000-0000-0000-0000-0000000000b1','upload','test-b1','test/b1.pdf','strafverfuegung','T/3/2026','offen');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"app_role":"admin"}}', true);
set local role authenticated;
select count(*) >= 1 as "buero sieht" from public.post_eingang;
do $$ begin perform public.post_freigeben('00000000-0000-0000-0000-0000000000b1');
  raise exception 'FEHLER: Freigabe ohne Fahrer ging durch';
exception when others then if sqlerrm like 'FEHLER%' then raise; end if; end $$;
select 'ok: Freigabe ohne Fahrer gesperrt' as ergebnis;
rollback;
```

Erwartet: `buero sieht = true`, `ok: Freigabe ohne Fahrer gesperrt`.

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-09-28-post.sql
git commit -m "post: tabellen, rpcs, bucket, mieter (sorhan bis 10.01., eh ab 11.01.)"
```

---

### Task 2: Reine Logik + Tests

**Files:**
- Create: `supabase/functions/_shared/post-logik.ts`
- Test: `scripts/test-post-logik.mjs`

**Interfaces:**
- Produces (für Task 3 und 5):
  - `type Art = 'lenkererhebung'|'strafverfuegung'|'anonymverfuegung'|'zahlungsaufforderung'|'mahnung'|'sonstige'`
  - `interface Auslese { art: Art; gz: string|null; behoerde: string|null; kennzeichen: string|null; tatzeit: string|null; tatort: string|null; delikt: string|null; betrag: number|null; frist: string|null; antwort_email: string|null; volltext: string }`
  - `interface Mieter { id: number; kurz: string; name: string; adresse: string; uid: string|null; fn: string|null; gueltig_von: string|null; gueltig_bis: string|null }`
  - `wienDatum(iso: string): string` → `YYYY-MM-DD`
  - `mieterZurTatzeit(liste: Mieter[], tatzeitIso: string|null): Mieter|null`
  - `pruefeAuslese(a: Auslese, zugestelltAm: string|null): string[]` (leer = ok)
  - `antwortMail(e: { gz: string; kennzeichen: string|null; tatzeit: string; antwort_email: string }, m: Mieter): { an: string; betreff: string; text: string }`
  - `behoerdeKurz(email: string): string`
  - `knopfText(email: string, m: Mieter): string`
  - `mimeRaw(an: string, betreff: string, text: string): string` (base64url, fertig für Gmail `raw`)

- [ ] **Step 1: Failing test schreiben** — `scripts/test-post-logik.mjs`

```js
// node --test scripts/test-post-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wienDatum, mieterZurTatzeit, pruefeAuslese, antwortMail, behoerdeKurz, knopfText, mimeRaw }
  from '../supabase/functions/_shared/post-logik.ts';

const SORHAN = { id: 1, kurz: 'Sorhan', name: 'Sorhan Taxi KG', adresse: 'Seitenstettengasse 5/37, 1010 Wien', uid: null, fn: null, gueltig_von: null, gueltig_bis: '2026-01-10' };
const EH = { id: 2, kurz: 'EH', name: 'EH Limousinenservice KG', adresse: 'Thalhaimergasse 47/4, 1160 Wien', uid: 'ATU74849827', fn: '521134 z', gueltig_von: '2026-01-11', gueltig_bis: null };
const MIETER = [SORHAN, EH];

test('wienDatum nimmt Wiener Kalendertag', () => {
  assert.equal(wienDatum('2026-01-10T23:30:00Z'), '2026-01-11');   // Winter +1h
  assert.equal(wienDatum('2026-07-01T22:30:00Z'), '2026-07-02');   // Sommer +2h
  assert.equal(wienDatum('2026-07-01T21:30:00Z'), '2026-07-01');
});

test('mieter am Stichtag nach Wiener Datum', () => {
  assert.equal(mieterZurTatzeit(MIETER, '2026-01-10T22:30:00Z').kurz, 'Sorhan');  // 23:30 Wien
  assert.equal(mieterZurTatzeit(MIETER, '2026-01-10T23:30:00Z').kurz, 'EH');      // 00:30 Wien am 11.
  assert.equal(mieterZurTatzeit(MIETER, '2025-06-01T10:00:00Z').kurz, 'Sorhan');
  assert.equal(mieterZurTatzeit(MIETER, '2026-09-14T15:32:00Z').kurz, 'EH');
  assert.equal(mieterZurTatzeit(MIETER, null), null);
  assert.equal(mieterZurTatzeit([SORHAN], '2026-09-14T15:32:00Z'), null);
});

const LE = {
  art: 'lenkererhebung', gz: 'MA67/266700676804/2026', behoerde: 'MA 67', kennzeichen: 'W-1234TX',
  tatzeit: '2026-09-14T15:32:00Z', tatort: 'Wien 16', delikt: 'Parken', betrag: null, frist: '2026-10-05',
  antwort_email: 'lenkererhebung@ma67.wien.gv.at',
  volltext: 'GZ MA67/266700676804/2026 ... W-1234TX ... Antwort an lenkererhebung@ma67.wien.gv.at',
};

test('pruefeAuslese: saubere Lenkererhebung ist ok', () => {
  assert.deepEqual(pruefeAuslese(LE, '2026-09-28T10:00:00Z'), []);
});

test('pruefeAuslese: Mail nicht im PDF oder nicht .gv.at', () => {
  assert.ok(pruefeAuslese({ ...LE, antwort_email: 'x@ma67.wien.gv.at' }, null).some(g => g.includes('nicht im PDF')));
  assert.ok(pruefeAuslese({ ...LE, antwort_email: 'a@gmail.com', volltext: LE.volltext + ' a@gmail.com' }, null).some(g => g.includes('.gv.at')));
});

test('pruefeAuslese: GZ nicht im PDF, Tatzeit nach Zustellung, fehlende Pflichtfelder', () => {
  assert.ok(pruefeAuslese({ ...LE, gz: 'MA67/999/2026' }, null).some(g => g.includes('GZ')));
  assert.ok(pruefeAuslese(LE, '2026-09-01T00:00:00Z').some(g => g.includes('Tatzeit')));
  assert.ok(pruefeAuslese({ ...LE, kennzeichen: null }, null).some(g => g.includes('Kennzeichen')));
});

test('pruefeAuslese: sonstige Post braucht nichts', () => {
  assert.deepEqual(pruefeAuslese({ art: 'sonstige', gz: null, behoerde: 'WKO', kennzeichen: null, tatzeit: null, tatort: null, delikt: null, betrag: null, frist: null, antwort_email: null, volltext: 'Mahnung' }, null), []);
});

test('pruefeAuslese: Strafverfügung braucht Betrag', () => {
  const sv = { ...LE, art: 'strafverfuegung', betrag: null, antwort_email: null };
  assert.ok(pruefeAuslese(sv, null).some(g => g.includes('Betrag')));
  assert.deepEqual(pruefeAuslese({ ...sv, betrag: 90 }, null), []);
});

test('antwortMail: Text, Betreff, Empfänger', () => {
  const m = antwortMail(LE, EH);
  assert.equal(m.an, 'lenkererhebung@ma67.wien.gv.at');
  assert.equal(m.betreff, 'GZ: MA67/266700676804/2026');
  assert.match(m.text, /Fahrzeug W-1234TX zur Tatzeit 14\.09\.2026 17:32 vermietet war an:/);
  assert.match(m.text, /EH Limousinenservice KG, Thalhaimergasse 47\/4, 1160 Wien, ATU74849827, FN 521134 z/);
  assert.match(m.text, /Hydrafleet KG$/);
  const s = antwortMail({ ...LE, tatzeit: '2025-12-01T10:00:00Z' }, SORHAN);
  assert.match(s.text, /Sorhan Taxi KG, Seitenstettengasse 5\/37, 1010 Wien\n/);   // ohne UID/FN
});

test('behoerdeKurz und knopfText', () => {
  assert.equal(behoerdeKurz('lenkererhebung@ma67.wien.gv.at'), 'MA 67');
  assert.equal(behoerdeKurz('PK-W-15-Kanzlei@polizei.gv.at'), 'PK W 15');
  assert.equal(behoerdeKurz('LPD-W-SVA-5-Verkehrsamt@polizei.gv.at'), 'LPD W SVA 5');
  assert.equal(behoerdeKurz('post@bhmd.noe.gv.at'), 'bhmd.noe.gv.at');
  assert.equal(knopfText('lenkererhebung@ma67.wien.gv.at', EH), 'An MA 67 senden → EH');
});

test('mimeRaw: UTF-8-Betreff und Body, base64url', () => {
  const raw = mimeRaw('a@b.gv.at', 'GZ: Ä/1', 'Grüße');
  const txt = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(txt, /^To: a@b\.gv\.at\r\n/);
  assert.match(txt, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  assert.match(txt, /Content-Type: text\/plain; charset=UTF-8/);
  assert.ok(!/[+/=]/.test(raw));
  const body = txt.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Grüße');
});
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `node --test scripts/test-post-logik.mjs`
Expected: FAIL (`Cannot find module …/post-logik.ts`)

- [ ] **Step 3: Implementierung** — `supabase/functions/_shared/post-logik.ts`

```ts
// Reine Logik fuer post-eingang und post-senden. Keine Deno-/Netz-APIs:
// laeuft unveraendert in Deno (Edge Function) und in Node (node --test).

export type Art = "lenkererhebung" | "strafverfuegung" | "anonymverfuegung" |
  "zahlungsaufforderung" | "mahnung" | "sonstige";

export interface Auslese {
  art: Art; gz: string | null; behoerde: string | null; kennzeichen: string | null;
  tatzeit: string | null; tatort: string | null; delikt: string | null; betrag: number | null;
  frist: string | null; antwort_email: string | null; volltext: string;
}

export interface Mieter {
  id: number; kurz: string; name: string; adresse: string; uid: string | null; fn: string | null;
  gueltig_von: string | null; gueltig_bis: string | null;
}

const WIEN = "Europe/Vienna";

export function wienDatum(iso: string): string {
  // en-CA liefert YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: WIEN, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso));
}

function wienZeit(iso: string): string {
  const p = new Intl.DateTimeFormat("de-AT", {
    timeZone: WIEN, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}.${g("month")}.${g("year")} ${g("hour")}:${g("minute")}`;
}

export function mieterZurTatzeit(liste: Mieter[], tatzeitIso: string | null): Mieter | null {
  if (!tatzeitIso) return null;
  const d = wienDatum(tatzeitIso);
  return liste.find((m) => (!m.gueltig_von || m.gueltig_von <= d) && (!m.gueltig_bis || d <= m.gueltig_bis)) ?? null;
}

const STRAFEN: Art[] = ["strafverfuegung", "anonymverfuegung", "zahlungsaufforderung", "mahnung"];

export function pruefeAuslese(a: Auslese, zugestelltAm: string | null): string[] {
  const g: string[] = [];
  const text = (a.volltext ?? "").toLowerCase();
  const verkehr = a.art === "lenkererhebung" || STRAFEN.includes(a.art);
  if (!verkehr) return g;
  if (!a.gz) g.push("GZ fehlt");
  else if (!text.includes(a.gz.toLowerCase())) g.push("GZ steht nicht im PDF-Text");
  if (a.tatzeit && zugestelltAm && Date.parse(a.tatzeit) > Date.parse(zugestelltAm)) g.push("Tatzeit liegt nach der Zustellung");
  if (a.art === "lenkererhebung") {
    if (!a.kennzeichen) g.push("Kennzeichen fehlt");
    if (!a.tatzeit) g.push("Tatzeit fehlt");
    const m = (a.antwort_email ?? "").trim().toLowerCase();
    if (!m) g.push("Antwort-Mailadresse fehlt");
    else {
      if (!m.endsWith(".gv.at")) g.push("Antwort-Mailadresse endet nicht auf .gv.at");
      if (!text.includes(m)) g.push("Antwort-Mailadresse steht nicht im PDF-Text");
    }
  }
  if (a.art !== "lenkererhebung" && a.art !== "mahnung" && (a.betrag == null || !(a.betrag >= 0))) g.push("Betrag fehlt");
  return g;
}

export function antwortMail(
  e: { gz: string; kennzeichen: string | null; tatzeit: string; antwort_email: string }, m: Mieter,
): { an: string; betreff: string; text: string } {
  const firma = [m.name, m.adresse, m.uid, m.fn ? `FN ${m.fn}` : null].filter(Boolean).join(", ");
  const fz = e.kennzeichen ? `das Fahrzeug ${e.kennzeichen}` : "das Fahrzeug";
  const text = [
    "Sehr geehrte Damen und Herren!",
    "",
    `Hiermit teilen wir mit, dass ${fz} zur Tatzeit ${wienZeit(e.tatzeit)} vermietet war an:`,
    firma,
    "",
    "Mit freundlichen Grüßen",
    "Hydrafleet KG",
  ].join("\n");
  return { an: e.antwort_email.trim(), betreff: `GZ: ${e.gz}`, text };
}

export function behoerdeKurz(email: string): string {
  const [lokal, domain] = email.toLowerCase().split("@");
  const ma = domain?.match(/^ma(\d+)\./);
  if (ma) return `MA ${ma[1]}`;
  if (domain === "polizei.gv.at") {
    return email.split("@")[0].split("-").filter((t) => !/^(kanzlei|verkehrsamt)$/i.test(t)).join(" ").toUpperCase();
  }
  return domain ?? lokal;
}

export function knopfText(email: string, m: Mieter): string {
  return `An ${behoerdeKurz(email)} senden → ${m.kurz}`;
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function mimeRaw(an: string, betreff: string, text: string): string {
  const msg = [
    `To: ${an}`,
    `Subject: =?UTF-8?B?${b64(betreff)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
  ].join("\r\n");
  return b64(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

Hinweis `behoerdeKurz('PK-W-15-Kanzlei@polizei.gv.at')`: Tokens `PK`,`W`,`15`,`Kanzlei` → ohne `Kanzlei` → `PK W 15`. `LPD-W-SVA-5-Verkehrsamt` → `LPD W SVA 5`.

- [ ] **Step 4: Test laufen lassen**

Run: `node --test scripts/test-post-logik.mjs`
Expected: alle Tests PASS. (Node 25 lädt `.ts` ohne Flag; falls nicht: `node --experimental-strip-types --test …`.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/post-logik.ts scripts/test-post-logik.mjs
git commit -m "post: reine logik (mieter zur tatzeit, pruefung, mailtext, mime) + tests"
```

---

### Task 3: Zugänge im Vault + Edge Function `post-eingang`

**Files:**
- Create: `scripts/post-zugaenge-einrichten.js`
- Create: `supabase/functions/post-eingang/index.ts`

**Interfaces:**
- Consumes: Task 1 (Tabellen, `post_fahrer_vorschlag`, Bucket `post`), Task 2 (`Auslese`, `pruefeAuslese`).
- Produces: `POST /functions/v1/post-eingang`
  - multipart: `datei` (PDF), optional `delivery_id`, `usp_absender`, `usp_betreff`, `zugestellt_am`, `quelle` (`usp`|`upload`)
  - JSON `{ "aktion": "neu_auslesen", "id": "<uuid>" }` (nur Büro)
  - Antwort `{ id, status, art, doppelt: boolean, pruef_grund }`
  - Auth: Header `x-post-key` = Vault-Secret `usp.post_key` **oder** Büro-JWT.

- [ ] **Step 1: Einrichtungs-Skript** — `scripts/post-zugaenge-einrichten.js`

```js
// Einmalig vom Betreiber auszufuehren (liest den service_role-Key wie uber-session-speichern.js):
//   node scripts/post-zugaenge-einrichten.js
// 1) erzeugt den Eingangsschluessel fuer usp-bot.sh -> Vault (anbieter 'usp') + /root/.post-eingang-key auf taxi
// 2) fragt den Anthropic-API-Key verdeckt ab -> Vault (anbieter 'anthropic')
// Gibt keine Geheimnisse aus.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('readline');

function serviceKey() {
  const p = path.join(__dirname, '..', '.n8n-backup', 'AbrechnungsBot-v13-20260911.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const n of d.nodes) for (const h of (n.parameters?.headerParameters?.parameters || []))
    if (h.name === 'apikey' && JSON.parse(Buffer.from(h.value.split('.')[1], 'base64').toString()).role === 'service_role') return h.value;
  throw new Error('service_role-Key nicht gefunden');
}
async function setzen(key, anbieter, secret) {
  const r = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_anbieter: anbieter, p_firma: 'hydrafleet_kg', p_externe_id: null, p_secret: secret, p_bezeichnung: `post_${anbieter}` }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return (await r.text()).replace(/"/g, '');
}
function verdeckt(frage) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = () => {};
    process.stdout.write(frage);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}
(async () => {
  const key = serviceKey();
  const postKey = crypto.randomBytes(32).toString('hex');
  console.log('USP-Eingang:', await setzen(key, 'usp', { post_key: postKey }));
  execFileSync('ssh', ['taxi', 'umask 077; cat > /root/.post-eingang-key'], { input: postKey });
  console.log('Schluessel auf taxi: /root/.post-eingang-key (600)');
  const ak = await verdeckt('Anthropic-API-Key (Eingabe unsichtbar): ');
  if (!/^sk-ant-/.test(ak)) throw new Error('sieht nicht wie ein Anthropic-Key aus - nichts gespeichert');
  console.log('Anthropic:', await setzen(key, 'anthropic', { api_key: ak }));
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
```

- [ ] **Step 2: Betreiber führt aus**

Betreiber: `! node ~/Projects/hydrafleet/scripts/post-zugaenge-einrichten.js`
Erwartet: zwei Verbindungs-IDs, keine Geheimnisse in der Ausgabe.
Prüfen (MCP): `select anbieter, firma, status from verbindungen where anbieter in ('usp','anthropic');` → 2 Zeilen `aktiv`.

- [ ] **Step 3: Edge Function** — `supabase/functions/post-eingang/index.ts`

```ts
// post-eingang - nimmt ein Behoerden-PDF an (USP-Skript auf taxi oder Upload im Buero),
// legt es in Bucket 'post' ab, liest es mit Claude aus und prueft das Ergebnis.
// Schreibt nur post_eingang und storage 'post'. Spec: docs/superpowers/specs/2026-09-28-post-strafen-design.md
import { type Auslese, pruefeAuslese } from "../_shared/post-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (n: string, a: unknown) => db(`rpc/${n}`, { method: "POST", body: JSON.stringify(a) });

async function geheimnis(anbieter: string): Promise<Record<string, string>> {
  const [v] = await db(`verbindungen?anbieter=eq.${anbieter}&status=eq.aktiv&select=id`);
  if (!v) throw new Error(`keine aktive Verbindung '${anbieter}'`);
  return await rpc("verbindung_zugang", { p_verbindung_id: v.id });
}

function rolle(req: Request): "buero" | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")));
    return ["admin", "user"].includes(p.app_metadata?.app_role) ? "buero" : null;
  } catch { return null; }
}

async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64(b: Uint8Array) {
  let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const WERKZEUG = {
  name: "auslese",
  description: "Strukturierte Daten aus einem oesterreichischen Behoerdenschreiben an die Hydrafleet KG.",
  input_schema: {
    type: "object",
    properties: {
      art: { type: "string", enum: ["lenkererhebung", "strafverfuegung", "anonymverfuegung", "zahlungsaufforderung", "mahnung", "sonstige"],
        description: "VStVF 37 / 'Lenkererhebung' / 'Aufforderung zur Bekanntgabe des Lenkers' = lenkererhebung; VStVF 47 = strafverfuegung; VStVF 64 = anonymverfuegung; VStVF 57 = zahlungsaufforderung; VStVF 38a oder Mahnung zu einer Verkehrsstrafe = mahnung; alles andere (WKO, OeGK, Gericht, Steuer) = sonstige" },
      gz: { type: ["string", "null"], description: "Geschaeftszahl exakt wie im Dokument, z.B. MA67/266700676804/2026 oder VStV/926301390535/2026" },
      behoerde: { type: ["string", "null"] },
      kennzeichen: { type: ["string", "null"], description: "Kennzeichen exakt wie im Dokument, z.B. W-1234TX" },
      tatzeit: { type: ["string", "null"], description: "ISO 8601 mit Offset Europe/Vienna, z.B. 2026-09-14T17:32:00+02:00" },
      tatort: { type: ["string", "null"] },
      delikt: { type: ["string", "null"], description: "kurz, z.B. 'Parken ohne Parkschein'" },
      betrag: { type: ["number", "null"], description: "zu zahlender Betrag in Euro" },
      frist: { type: ["string", "null"], description: "Antwort-/Zahlungsfrist als YYYY-MM-DD" },
      antwort_email: { type: ["string", "null"], description: "E-Mail-Adresse der Behoerde fuer die Antwort, exakt wie im Dokument" },
      volltext: { type: "string", description: "vollstaendiger Text des Dokuments" },
    },
    required: ["art", "gz", "behoerde", "kennzeichen", "tatzeit", "tatort", "delikt", "betrag", "frist", "antwort_email", "volltext"],
  },
};

async function auslesen(pdf: Uint8Array): Promise<Auslese> {
  const { api_key } = await geheimnis("anthropic");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 8000,
      tools: [WERKZEUG], tool_choice: { type: "tool", name: "auslese" },
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(pdf) } },
        { type: "text", text: "Lies dieses Schreiben aus. Nichts erfinden: was nicht im Dokument steht, ist null." },
      ] }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const t = (j.content ?? []).find((c: any) => c.type === "tool_use");
  if (!t) throw new Error("Anthropic lieferte kein Ergebnis");
  return t.input as Auslese;
}

async function verarbeiten(id: string, pdf: Uint8Array, zugestelltAm: string | null) {
  try {
    const a = await auslesen(pdf);
    const gruende = pruefeAuslese(a, zugestelltAm);
    const vorschlag = a.kennzeichen && a.art !== "lenkererhebung" && a.art !== "sonstige"
      ? await rpc("post_fahrer_vorschlag", { p_kennzeichen: a.kennzeichen }) : null;
    const kk = a.kennzeichen ? await rpc("kennzeichen_key", { t: a.kennzeichen }) : null;
    await db(`post_eingang?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      art: a.art, gz: a.gz, behoerde: a.behoerde, kennzeichen: a.kennzeichen, kennzeichen_key: kk,
      tatzeit: a.tatzeit, tatort: a.tatort, delikt: a.delikt, betrag: a.betrag, frist: a.frist,
      antwort_email: a.antwort_email?.trim().toLowerCase() ?? null, volltext: a.volltext, auslese_roh: a,
      fahrer_vorschlag_id: vorschlag, fahrer_id: vorschlag,
      pruef_grund: gruende.length ? gruende.join("; ") : null,
      status: gruende.length ? "pruefen" : "offen",
    }) });
    return { status: gruende.length ? "pruefen" : "offen", art: a.art, pruef_grund: gruende.join("; ") || null };
  } catch (e) {
    await db(`post_eingang?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      status: "pruefen", pruef_grund: `Auslesen fehlgeschlagen: ${String(e).slice(0, 300)}` }) });
    return { status: "pruefen", art: null, pruef_grund: String(e).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  try {
    const istBuero = rolle(req) === "buero";
    let istServer = false;
    const pk = req.headers.get("x-post-key");
    if (pk) istServer = pk === (await geheimnis("usp")).post_key;
    if (!istBuero && !istServer) return antwort(403, { fehler: "nicht_berechtigt" });

    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const b = await req.json();
      if (b.aktion !== "neu_auslesen" || !istBuero) return antwort(400, { fehler: "unbekannte_aktion" });
      const [e] = await db(`post_eingang?id=eq.${b.id}&select=id,datei_pfad,zugestellt_am`);
      if (!e) return antwort(404, { fehler: "nicht_gefunden" });
      const d = await fetch(`${SUPABASE_URL}/storage/v1/object/post/${e.datei_pfad}`, { headers: kopf });
      if (!d.ok) throw new Error(`Storage ${d.status}`);
      return antwort(200, { id: e.id, doppelt: false, ...(await verarbeiten(e.id, new Uint8Array(await d.arrayBuffer()), e.zugestellt_am)) });
    }

    const f = await req.formData();
    const datei = f.get("datei");
    if (!(datei instanceof File)) return antwort(400, { fehler: "datei_fehlt" });
    const pdf = new Uint8Array(await datei.arrayBuffer());
    if (pdf.length < 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") return antwort(400, { fehler: "kein_pdf" });
    const hash = await sha256(pdf);
    const deliveryId = (f.get("delivery_id") as string | null)?.trim() || null;

    const [alt] = await db(`post_eingang?sha256=eq.${hash}&select=id,status,art,pruef_grund,delivery_id`);
    if (alt) {
      if (deliveryId && !alt.delivery_id) {
        await db(`post_eingang?id=eq.${alt.id}`, { method: "PATCH", body: JSON.stringify({ delivery_id: deliveryId }) });
      }
      return antwort(200, { id: alt.id, status: alt.status, art: alt.art, pruef_grund: alt.pruef_grund, doppelt: true });
    }

    const jetzt = new Date();
    const pfad = `${jetzt.getUTCFullYear()}/${String(jetzt.getUTCMonth() + 1).padStart(2, "0")}/${hash}.pdf`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/post/${pfad}`, {
      method: "POST", headers: { ...kopf, "Content-Type": "application/pdf", "x-upsert": "true" }, body: pdf,
    });
    if (!up.ok) throw new Error(`Storage-Upload ${up.status}: ${await up.text()}`);

    const zugestellt = (f.get("zugestellt_am") as string | null)?.trim() || null;
    const [neu] = await db("post_eingang", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        quelle: f.get("quelle") === "upload" || istBuero ? "upload" : "usp",
        delivery_id: deliveryId, sha256: hash, datei_pfad: pfad, dateiname: datei.name || null,
        usp_absender: (f.get("usp_absender") as string | null) || null,
        usp_betreff: (f.get("usp_betreff") as string | null) || null,
        zugestellt_am: zugestellt && !isNaN(Date.parse(zugestellt)) ? zugestellt : null,
        status: "neu",
      }),
    });
    return antwort(200, { id: neu.id, doppelt: false, ...(await verarbeiten(neu.id, pdf, neu.zugestellt_am)) });
  } catch (e) {
    return antwort(500, { fehler: String(e).slice(0, 500) });
  }
});
```

- [ ] **Step 4: Deploy**

MCP `deploy_edge_function`: `name: post-eingang`, `verify_jwt: true`, `entrypoint_path: index.ts`, files:
`[{name:"index.ts", content:<post-eingang/index.ts>}, {name:"../_shared/post-logik.ts", content:<post-logik.ts>}]`.
Lehnt der Deploy den Pfad `../_shared/` ab: Datei als `post-logik.ts` mit in den Function-Ordner legen, Import in
`index.ts` auf `"./post-logik.ts"` ändern, im Repo `supabase/functions/post-eingang/post-logik.ts` als Kopie mit
Kopfkommentar „Kopie von _shared/post-logik.ts – bei Änderung beide“ anlegen (gleich in Task 5 für `post-senden`).
Danach `get_edge_function post-eingang` → Inhalt = Repo.

- [ ] **Step 5: Funktionstest mit einem echten PDF** (braucht Task 4 Step 2 oder ein PDF aus Telegram)

Den öffentlichen anon-Key (steht im Frontend) auf taxi ablegen – wird auch von Task 4 und 6 gebraucht:

```bash
grep -oP "SUPABASE_KEY = '\K[^']+" lohn.html | ssh taxi 'umask 077; cat > /root/.supabase-anon-key'
```

Ein Lenkererhebungs-PDF holen: in der USP-Telegram-Gruppe eines speichern oder (nach Task 4 Step 2) per
`usp-rueckstand.sh`. Für diesen Test auf taxi als `/tmp/le-test.pdf` ablegen (`scp <datei> taxi:/tmp/le-test.pdf`), dann:

```bash
ssh taxi 'sende() { curl -s -X POST https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/post-eingang \
    -H "Authorization: Bearer $(cat /root/.supabase-anon-key)" "$@" \
    -F "datei=@/tmp/le-test.pdf;type=application/pdf" --form-string "quelle=usp"; echo; }
  sende -H "x-post-key: $(cat /root/.post-eingang-key)"
  sende -H "x-post-key: $(cat /root/.post-eingang-key)"
  sende -H "x-post-key: falsch" -w " HTTP %{http_code}"
  rm -f /tmp/le-test.pdf'
```

Erwartet: 1. Antwort `"doppelt":false`, `"status":"offen"` (oder `pruefen` mit nachvollziehbarem Grund), `"art":"lenkererhebung"`; 2. Antwort `"doppelt":true`, gleiche `id`; 3. `{"fehler":"nicht_berechtigt"} HTTP 403`.
MCP: `select art, gz, kennzeichen, tatzeit, antwort_email, status, pruef_grund from post_eingang order by eingelesen_am desc limit 1;` gegen das PDF von Hand prüfen.

- [ ] **Step 6: Commit**

```bash
git add scripts/post-zugaenge-einrichten.js supabase/functions/post-eingang/index.ts
git commit -m "post-eingang: pdf annehmen, speichern, mit claude auslesen, pruefen; zugaenge-skript"
```

---

### Task 4: Rückstand aus dem USP (auf taxi)

**Files:**
- Create: `scripts/usp-rueckstand.sh` (wird nach `/root/usp-rueckstand.sh` kopiert)

**Interfaces:**
- Consumes: `post-eingang` (Task 3), Proxy `http://localhost:9999/soap` und `/attachment?delivery_id=&attachment_id=`, `/var/log/usp-bot.log`.
- Produces: `usp-rueckstand.sh [--liste | --eine <DeliveryID> | --alle]`

- [ ] **Step 1: Skript schreiben**

```bash
#!/bin/bash
# Holt BEREITS ABGESCHLOSSENE Zustellungen erneut aus dem USP und schickt sie an HYDRAlink.
# Nur Zustellungen, die usp-bot.sh laut Log abgeschlossen hat ("Abgeschlossen: <ID>") -
# alles andere wird uebersprungen (usp-bot.sh holt sie regulaer, inkl. Telegram).
#   --liste          nur zaehlen/auflisten, nichts laden
#   --eine <ID>      genau eine Zustellung
#   --alle           alle abgeschlossenen
set -u
PROXY="http://localhost:9999"
LOG="/var/log/usp-bot.log"
URL="https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/post-eingang"
ANON="$(cat /root/.supabase-anon-key)"
KEY="$(cat /root/.post-eingang-key)"
NS='xmlns:aa="http://reference.e-government.gv.at/namespace/zustellung/autoabholung/phase2/20181206#"'
MODUS="${1:---liste}"

soap() { curl -s "$PROXY/soap" -X POST -H "Content-Type: application/soap+xml" --max-time 60 --data-raw "$1" | tr -d '\n\r'; }

ids_alle() {
  local start=0 limit=50 alle="" seite
  while :; do
    seite=$(soap "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:QueryDeliveriesRequest aa:Version=\"2.4.0-004\" $NS><aa:AllDeliveries><aa:Paging><aa:Start>$start</aa:Start><aa:Limit>$limit</aa:Limit></aa:Paging></aa:AllDeliveries></aa:QueryDeliveriesRequest></env:Body></env:Envelope>" \
      | grep -oP '(?:[\w:]*DeliveryID)>\K[^<]+')
    [ -z "$seite" ] && break
    alle="$alle"$'\n'"$seite"
    [ "$(echo "$seite" | grep -c .)" -lt "$limit" ] && break
    start=$((start + limit))
  done
  echo "$alle" | grep . | sort -u
}

eine() {
  local ID="$1"
  if ! grep -q "Abgeschlossen: $ID" "$LOG"; then echo "SKIP (nicht abgeschlossen): $ID"; return 0; fi
  local D; D=$(soap "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:GetDeliveryRequest aa:Version=\"2.4.0-004\" $NS><aa:DeliveryID>$ID</aa:DeliveryID></aa:GetDeliveryRequest></env:Body></env:Envelope>")
  local SENDER SUBJECT TS ATT FN TMP HTTP
  SENDER=$(echo "$D" | grep -oP '(?:[\w:]*FullName)>\K[^<]+' | head -1)
  SUBJECT=$(echo "$D" | grep -oP '(?:[\w:]*Subject)>\K[^<]+' | head -1)
  TS=$(echo "$D" | grep -oP '(?:[\w:]*DeliveryTimestamp)>\K[^<]+' | head -1)
  ATT=$(echo "$D" | grep -oP '(?:[\w:]*AttachmentID)>\K[^<]+' | grep -v '^$' | tail -1)
  FN=$(echo "$D" | grep -oP '(?:[\w:]*FileName)>\K[^<]+\.pdf' | head -1); FN="${FN:-dokument.pdf}"
  if [ -z "$ATT" ]; then echo "FEHLER keine AttachmentID: $ID"; return 1; fi
  TMP="/tmp/rueck_${ID}.pdf"
  curl -s "$PROXY/attachment?delivery_id=$ID&attachment_id=$ATT" -o "$TMP" --max-time 60
  if [ ! -s "$TMP" ]; then echo "FEHLER Download: $ID"; rm -f "$TMP"; return 1; fi
  HTTP=$(curl -s -o /tmp/rueck_antwort.json -w "%{http_code}" --max-time 180 -X POST "$URL" \
    -H "Authorization: Bearer $ANON" -H "x-post-key: $KEY" \
    -F "datei=@$TMP;type=application/pdf;filename=$FN" \
    --form-string "delivery_id=$ID" --form-string "usp_absender=$SENDER" \
    --form-string "usp_betreff=$SUBJECT" --form-string "zugestellt_am=$TS" --form-string "quelle=usp")
  echo "HTTP $HTTP $ID | $SENDER | $SUBJECT | $(head -c 200 /tmp/rueck_antwort.json)"
  rm -f "$TMP" /tmp/rueck_antwort.json
}

case "$MODUS" in
  --liste) IDS=$(ids_alle); echo "USP gesamt: $(echo "$IDS" | grep -c .)";
           echo "davon abgeschlossen laut Log: $(for i in $IDS; do grep -q "Abgeschlossen: $i" "$LOG" && echo x; done | grep -c x)";;
  --eine)  eine "$2";;
  --alle)  for i in $(ids_alle); do eine "$i"; sleep 2; done;;
  *) echo "Aufruf: $0 --liste | --eine <DeliveryID> | --alle"; exit 1;;
esac
```

- [ ] **Step 2: Auf taxi bringen, anon-Key ablegen, Liste prüfen**

```bash
scp scripts/usp-rueckstand.sh taxi:/root/usp-rueckstand.sh
ssh taxi 'chmod 700 /root/usp-rueckstand.sh'
# anon-Key ist öffentlich (steht im Frontend); aus lohn.html übernehmen:
grep -oP "SUPABASE_KEY = '\K[^']+" lohn.html | ssh taxi 'umask 077; cat > /root/.supabase-anon-key'
ssh taxi '/root/usp-rueckstand.sh --liste'
```

Expected: `USP gesamt: 65` (± neue), `davon abgeschlossen laut Log: <n>` mit n ≤ gesamt.

- [ ] **Step 3: Eine Zustellung testen** (eine Lenkererhebung aus dem Log wählen)

```bash
ssh taxi 'ID=$(grep -B3 "Lenkererhebung" /var/log/usp-bot.log | grep -oP "Verarbeite: \K\S+" | tail -1); /root/usp-rueckstand.sh --eine "$ID"'
```

Expected: `HTTP 200 … "art":"lenkererhebung" …`. Falls `GetDelivery` für abgeschlossene Zustellungen einen Fault liefert: STOPP, Betreiber informieren, Rückfall Telegram-Export (Task 7 Upload).

- [ ] **Step 4: Commit** (der Lauf `--alle` kommt in Task 9)

```bash
git add scripts/usp-rueckstand.sh
git commit -m "usp-rueckstand: abgeschlossene zustellungen aus dem usp an post-eingang"
```

---

### Task 5: Gmail-Zugang + Edge Function `post-senden`

**Files:**
- Create: `scripts/gmail-zugang-speichern.js`
- Create: `supabase/functions/post-senden/index.ts`

**Interfaces:**
- Consumes: Task 1, Task 2 (`antwortMail`, `mieterZurTatzeit`, `mimeRaw`, `Mieter`).
- Produces: `POST /functions/v1/post-senden` (nur Büro-JWT)
  - `{ "aktion": "vorschau", "ids": [uuid] }` → `[{ id, ok, grund?, an, betreff, text, mieter_kurz, knopf }]`
  - `{ "aktion": "senden", "ids": [uuid], "test_an"?: string }` → `[{ id, ok, grund?, gmail_message_id? }]`
  - `{ "aktion": "abgleich" }` → `{ geprueft, gefunden }`

- [ ] **Step 1: Google-Projekt (Betreiber, einmalig, ~10 Min)**

1. https://console.cloud.google.com → Projekt „HYDRAlink“ anlegen.
2. „APIs & Dienste“ → Bibliothek → **Gmail API** aktivieren.
3. „OAuth-Zustimmungsbildschirm“: Extern, App-Name „HYDRAlink“, Support-Mail `sw.hydrafleet@gmail.com`, Bereiche `gmail.send` und `gmail.readonly`, Testnutzer `sw.hydrafleet@gmail.com` → danach **„App veröffentlichen“ (In Produktion)**.
4. „Anmeldedaten“ → OAuth-Client-ID → Typ **Desktop-App** → JSON herunterladen nach `~/Downloads/hydralink-google.json`.

- [ ] **Step 2: Skript** — `scripts/gmail-zugang-speichern.js`

```js
// Einmalig vom Betreiber:  node scripts/gmail-zugang-speichern.js ~/Downloads/hydralink-google.json
// Oeffnet die Google-Anmeldung, holt einen Refresh-Token fuer sw.hydrafleet@gmail.com
// (gmail.send + gmail.readonly) und legt ihn im Vault ab (anbieter 'gmail'). Gibt keine Geheimnisse aus.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DATEI = process.argv[2];
if (!DATEI) { console.error('Aufruf: node scripts/gmail-zugang-speichern.js <client.json>'); process.exit(1); }
const c = JSON.parse(fs.readFileSync(DATEI, 'utf8')).installed;
const PORT = 8765, REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

function serviceKey() {
  const p = path.join(__dirname, '..', '.n8n-backup', 'AbrechnungsBot-v13-20260911.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const n of d.nodes) for (const h of (n.parameters?.headerParameters?.parameters || []))
    if (h.name === 'apikey' && JSON.parse(Buffer.from(h.value.split('.')[1], 'base64').toString()).role === 'service_role') return h.value;
  throw new Error('service_role-Key nicht gefunden');
}

const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
  access_type: 'offline', prompt: 'consent', login_hint: 'sw.hydrafleet@gmail.com',
});
const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.end('kein code'); return; }
  res.end('HYDRAlink: Anmeldung erhalten, Fenster kann zu.');
  server.close();
  try {
    const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) })).json();
    if (!t.refresh_token) throw new Error('kein refresh_token: ' + (t.error_description || t.error || 'unbekannt'));
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    if (prof.emailAddress !== 'sw.hydrafleet@gmail.com') throw new Error(`falsches Konto: ${prof.emailAddress} - nichts gespeichert`);
    const key = serviceKey();
    const r = await fetch('https://pkxcwfkfaaorwnbdmylg.supabase.co/rest/v1/rpc/verbindung_setzen', {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_anbieter: 'gmail', p_firma: 'hydrafleet_kg', p_externe_id: prof.emailAddress,
        p_secret: { client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token },
        p_bezeichnung: 'gmail_sw_hydrafleet' }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    console.log('Gmail-Verbindung:', (await r.text()).replace(/"/g, ''), '|', prof.emailAddress);
    process.exit(0);
  } catch (e) { console.error('FEHLER:', e.message); process.exit(1); }
}).listen(PORT, '127.0.0.1', () => { console.log('Browser oeffnet sich …'); execFileSync('open', [auth]); });
```

Betreiber: `! node ~/Projects/hydrafleet/scripts/gmail-zugang-speichern.js ~/Downloads/hydralink-google.json`
Expected: `Gmail-Verbindung: <uuid> | sw.hydrafleet@gmail.com`.

- [ ] **Step 3: Edge Function** — `supabase/functions/post-senden/index.ts`

```ts
// post-senden - beantwortet Lenkererhebungen ueber die Gmail-API (sw.hydrafleet@gmail.com)
// und gleicht offene GZ mit Gmail "Gesendet" ab. Nur Buero. Nie zweimal je GZ.
import { antwortMail, knopfText, type Mieter, mieterZurTatzeit, mimeRaw } from "../_shared/post-logik.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const kopf = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const antwort = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function db(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pfad}`, { ...init, headers: { ...kopf, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} bei ${pfad}: ${t}`);
  return t ? JSON.parse(t) : null;
}
function nutzer(req: Request): { id: string } | null {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const t = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(t.padEnd(Math.ceil(t.length / 4) * 4, "=")));
    return ["admin", "user"].includes(p.app_metadata?.app_role) ? { id: p.sub } : null;
  } catch { return null; }
}

let token: { wert: string; bis: number } | null = null;
async function gmailToken() {
  if (token && token.bis > Date.now() + 60000) return token.wert;
  const [v] = await db("verbindungen?anbieter=eq.gmail&status=eq.aktiv&select=id");
  if (!v) throw new Error("keine aktive Gmail-Verbindung");
  const z = await db("rpc/verbindung_zugang", { method: "POST", body: JSON.stringify({ p_verbindung_id: v.id }) });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    client_id: z.client_id, client_secret: z.client_secret, refresh_token: z.refresh_token, grant_type: "refresh_token" }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google-Token ${r.status}: ${j.error_description ?? j.error}`);
  token = { wert: j.access_token, bis: Date.now() + j.expires_in * 1000 };
  return token.wert;
}
async function gmail(pfad: string, init: RequestInit = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pfad}`, {
    ...init, headers: { Authorization: `Bearer ${await gmailToken()}`, "Content-Type": "application/json" } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
// Gesendete Mail mit dieser GZ im Betreff?
async function inGmailGesendet(gz: string): Promise<{ id: string; threadId: string; datum: string | null } | null> {
  const q = encodeURIComponent(`in:sent subject:"${gz}"`);
  const j = await gmail(`messages?q=${q}&maxResults=1`);
  const m = j.messages?.[0];
  if (!m) return null;
  const d = await gmail(`messages/${m.id}?format=metadata&metadataHeaders=Date`);
  return { id: m.id, threadId: m.threadId, datum: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null };
}

async function laden(ids: string[]) {
  const liste = ids.map((i) => `"${i}"`).join(",");
  const rows = await db(`post_eingang?id=in.(${liste})&select=id,art,gz,kennzeichen,tatzeit,antwort_email,status,pruef_grund`);
  const mieter: Mieter[] = await db("mietverhaeltnisse?select=*");
  return { rows, mieter };
}
function entwurf(e: any, mieter: Mieter[]) {
  if (e.art !== "lenkererhebung") return { ok: false, grund: "keine Lenkererhebung" };
  if (e.status === "beantwortet") return { ok: false, grund: "bereits beantwortet" };
  if (e.status === "pruefen") return { ok: false, grund: `prüfen: ${e.pruef_grund ?? ""}` };
  if (!e.gz || !e.tatzeit || !e.antwort_email) return { ok: false, grund: "GZ, Tatzeit oder Mailadresse fehlt" };
  const m = mieterZurTatzeit(mieter, e.tatzeit);
  if (!m) return { ok: false, grund: "kein Mieter zur Tatzeit" };
  return { ok: true, m, mail: antwortMail(e, m) };
}

Deno.serve(async (req) => {
  const u = nutzer(req);
  if (!u) return antwort(403, { fehler: "nicht_berechtigt" });
  try {
    const b = await req.json();

    if (b.aktion === "abgleich") {
      const offen = await db("post_eingang?art=eq.lenkererhebung&status=in.(offen,pruefen)&gz=not.is.null&select=id,gz");
      let gefunden = 0;
      for (const e of offen) {
        const g = await inGmailGesendet(e.gz);
        if (!g) continue;
        await db("post_ausgang", { method: "POST", body: JSON.stringify({
          eingang_id: e.id, gz: e.gz, an: "(aus Gmail)", betreff: `GZ: ${e.gz}`, text: "(von Hand in Gmail gesendet)",
          gmail_message_id: g.id, gmail_thread_id: g.threadId, gesendet_am: g.datum, quelle: "gmail_abgleich" }) })
          .catch(() => null);   // unique je GZ: schon vorhanden = ok
        await db(`post_eingang?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "beantwortet" }) });
        gefunden++;
      }
      return antwort(200, { geprueft: offen.length, gefunden });
    }

    const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string") : [];
    if (!ids.length || ids.length > 100) return antwort(400, { fehler: "ids_fehlen_oder_zu_viele" });
    const { rows, mieter } = await laden(ids);

    if (b.aktion === "vorschau") {
      return antwort(200, rows.map((e: any) => {
        const x = entwurf(e, mieter);
        return x.ok ? { id: e.id, ok: true, ...x.mail, mieter_kurz: x.m!.kurz, knopf: knopfText(x.mail!.an, x.m!) }
                    : { id: e.id, ok: false, grund: x.grund };
      }));
    }

    if (b.aktion === "senden") {
      const testAn = typeof b.test_an === "string" && b.test_an.includes("@") ? b.test_an.trim() : null;
      const erg = [];
      for (const e of rows) {
        const x = entwurf(e, mieter);
        if (!x.ok) { erg.push({ id: e.id, ok: false, grund: x.grund }); continue; }
        if (!testAn) {
          const schon = await db(`post_ausgang?gz=eq.${encodeURIComponent(e.gz)}&test_an=is.null&fehler=is.null&select=id`);
          const g = schon.length ? null : await inGmailGesendet(e.gz);
          if (schon.length || g) {
            if (g) await db("post_ausgang", { method: "POST", body: JSON.stringify({ eingang_id: e.id, gz: e.gz,
              an: "(aus Gmail)", betreff: `GZ: ${e.gz}`, text: "(von Hand in Gmail gesendet)", gmail_message_id: g.id,
              gmail_thread_id: g.threadId, gesendet_am: g.datum, quelle: "gmail_abgleich" }) }).catch(() => null);
            await db(`post_eingang?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "beantwortet" }) });
            erg.push({ id: e.id, ok: false, grund: "bereits beantwortet" }); continue;
          }
        }
        const an = testAn ?? x.mail!.an;
        const zeile: any = { eingang_id: e.id, gz: e.gz, an, betreff: x.mail!.betreff, text: x.mail!.text,
          mietverhaeltnis_id: x.m!.id, gesendet_von: u.id, test_an: testAn, quelle: "hydralink" };
        try {
          const s = await gmail("messages/send", { method: "POST", body: JSON.stringify({ raw: mimeRaw(an, x.mail!.betreff, x.mail!.text) }) });
          Object.assign(zeile, { gmail_message_id: s.id, gmail_thread_id: s.threadId, gesendet_am: new Date().toISOString() });
          await db("post_ausgang", { method: "POST", body: JSON.stringify(zeile) });
          if (!testAn) await db(`post_eingang?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "beantwortet" }) });
          erg.push({ id: e.id, ok: true, gmail_message_id: s.id });
        } catch (err) {
          zeile.fehler = String(err).slice(0, 500);
          await db("post_ausgang", { method: "POST", body: JSON.stringify(zeile) }).catch(() => null);
          erg.push({ id: e.id, ok: false, grund: zeile.fehler });
        }
      }
      return antwort(200, erg);
    }
    return antwort(400, { fehler: "unbekannte_aktion" });
  } catch (e) {
    return antwort(500, { fehler: String(e).slice(0, 500) });
  }
});
```

- [ ] **Step 4: Deploy**

MCP `deploy_edge_function`: `name: post-senden`, `verify_jwt: true`, files `index.ts` + `../_shared/post-logik.ts`. Danach Inhalt gegen Repo prüfen.

- [ ] **Step 5: Tests** (im Browser als Büro-User über `post.html` aus Task 7, oder per Konsole mit `getSupabase().functions.invoke('post-senden', { body })`)

1. `{"aktion":"abgleich"}` → `gefunden` > 0, falls der Test-Eintrag aus Task 3 schon im August per Hand beantwortet wurde; sonst 0.
2. `{"aktion":"vorschau","ids":["<id aus Task 3>"]}` → Text mit „vermietet war an: EH Limousinenservice KG …“, `knopf` „An MA 67 senden → EH“ (bzw. passende Behörde).
3. `{"aktion":"senden","ids":["<id>"],"test_an":"sw.hydrafleet@gmail.com"}` → `ok:true`; Mail kommt im eigenen Posteingang an, Umlaute korrekt; `post_eingang.status` bleibt unverändert; `post_ausgang.test_an` gesetzt.
4. Zweimal hintereinander echt senden simulieren: in einer Transaktion `insert into post_ausgang (gz, an, betreff, text, quelle) values ('<gz>','x','x','x','hydralink')` → zweiter identischer Insert muss am Unique-Index `post_ausgang_gz_einmal` scheitern; `rollback`.
5. Aufruf mit Fahrer-JWT → 403.

- [ ] **Step 6: Commit**

```bash
git add scripts/gmail-zugang-speichern.js supabase/functions/post-senden/index.ts
git commit -m "post-senden: lenkererhebung per gmail beantworten, abgleich mit gesendet, nie doppelt"
```

---

### Task 6: `usp-bot.sh` an HYDRAlink anbinden

**Files:**
- Modify: `/root/usp-bot.sh` auf `taxi` (Sicherung `/root/usp-bot.sh.bak2`)

**Interfaces:**
- Consumes: `post-eingang` (Task 3), `/root/.post-eingang-key`, `/root/.supabase-anon-key` (Task 3/4).

- [ ] **Step 1: Sicherung + Rohzeitstempel merken**

```bash
ssh taxi 'cp -p /root/usp-bot.sh /root/usp-bot.sh.bak2'
```

In `usp-bot.sh` direkt nach der Zeile `TIMESTAMP=$(… | tr 'T' ' ')` einfügen:

```bash
    TS_ROH=$(echo "$DETAILS" | grep -oP '(?:[\w:]*DeliveryTimestamp)>\K[^<]+' | head -1)
```

- [ ] **Step 2: HYDRAlink-Aufruf einfügen** — direkt **vor** `rm -f "$TMPFILE"` im Block `if [ "$PDF_OK" = true ]`:

```bash
        # HYDRAlink (Post & Strafen) - darf Telegram/CloseDelivery nie blockieren
        if [ -r /root/.post-eingang-key ] && [ -r /root/.supabase-anon-key ]; then
            HL=$(curl -s -o /dev/null -w "%{http_code}" --max-time 180 -X POST \
                "https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/post-eingang" \
                -H "Authorization: Bearer $(cat /root/.supabase-anon-key)" \
                -H "x-post-key: $(cat /root/.post-eingang-key)" \
                -F "datei=@$TMPFILE;type=application/pdf;filename=$FILENAME" \
                --form-string "delivery_id=$DELIVERY_ID" --form-string "usp_absender=$SENDER" \
                --form-string "usp_betreff=$SUBJECT" --form-string "zugestellt_am=$TS_ROH" \
                --form-string "quelle=usp" || true)
            log "  HYDRAlink: HTTP $HL"
        fi
```

(Einfügen per `ssh taxi` + Python-Ersetzung an den eindeutigen Ankern, nicht per sed über Zeilennummern; danach `bash -n /root/usp-bot.sh`.)

- [ ] **Step 3: Syntax + Trockentest**

```bash
ssh taxi 'bash -n /root/usp-bot.sh && echo SYNTAX_OK; diff /root/usp-bot.sh.bak2 /root/usp-bot.sh'
```

Expected: `SYNTAX_OK`, Diff zeigt genau die zwei Einfügungen.

- [ ] **Step 4: Ausfalltest (Review Focus 5)** — Kopie mit falscher URL, ohne echte Zustellung:

```bash
ssh taxi 'TMPFILE=/tmp/x.pdf; printf "%%PDF-1.4" > $TMPFILE; \
  curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST https://nicht-da.invalid/ -F "datei=@$TMPFILE" || true; echo " <- erwartet 000"; rm -f $TMPFILE'
```

Expected: `000 <- erwartet 000`, Skript läuft weiter (kein Abbruch durch `|| true`).

- [ ] **Step 5: Beobachten** — nach dem nächsten Lauf mit neuer Zustellung:
`ssh taxi 'grep -A12 "Gefunden:" /var/log/usp-bot.log | tail -15'` → Zeile `HYDRAlink: HTTP 200`, danach `Telegram gesendet`, `Abgeschlossen`.

- [ ] **Step 6: Repo-Kopie + Commit**

```bash
scp taxi:/root/usp-bot.sh scripts/server/usp-bot.sh
sed -i '' -E 's/^BOT="[^"]*"/BOT="<im Server-Original>"/; s/^CHAT="[^"]*"/CHAT="<im Server-Original>"/' scripts/server/usp-bot.sh
git add scripts/server/usp-bot.sh
git commit -m "usp-bot.sh: pdf zusaetzlich an hydralink post-eingang (repo-kopie ohne token)"
```

---

### Task 7: Seite `post.html`

**Files:**
- Create: `post.html`
- Modify: `dashboard.html` (Kopfleiste), `lohn.html:149` (Kopfleiste)

**Interfaces:**
- Consumes: Tabellen/RPCs Task 1, `post-eingang` (Upload, `neu_auslesen`), `post-senden` (`vorschau`, `senden`, `abgleich`).

- [ ] **Step 1: Gerüst aus `lohn.html` übernehmen**

`post.html` beginnt als Kopie der Rahmenteile von `lohn.html`: `<head>` (Fonts, CSS-Variablen, Dark-Mode, `.pdfv*`-Stile Zeile ~130–145), Kopfleiste mit `← Dashboard`, Supabase-Client (`SUPABASE_URL`, `SUPABASE_KEY`, `getSupabase()`), Auth-Guard (Zeilen ~937–950, nur `app_role` admin/user, Fahrer → `/fahrer/`), `forceLogout()`, und die Funktion `pdfAnsicht(bucket, pfad, titel)` (Zeilen ~460–488) unverändert. Nichts Lohn-spezifisches übernehmen. Titel „Post – HYDRAlink“.

- [ ] **Step 2: Markup**

```html
<main class="wrap">
  <div class="kopf-zeile">
    <h1>Post</h1>
    <div class="aktionen">
      <button class="btn" id="btnAbgleich" title="Gmail „Gesendet“ nach GZ durchsuchen">Mit Gmail abgleichen</button>
      <label class="btn">PDFs hochladen<input type="file" id="upload" accept="application/pdf" multiple webkitdirectory hidden></label>
      <label class="btn">Einzelne PDFs<input type="file" id="uploadDateien" accept="application/pdf" multiple hidden></label>
      <button class="btn" id="btnMieter">Mieter</button>
    </div>
  </div>
  <input type="search" id="suche" placeholder="Suche: GZ, Kennzeichen, Fahrer, Behörde, Text im PDF …" autocomplete="off">
  <div class="chips" id="reiter" role="tablist"></div>
  <div id="sammel" class="sammel" hidden></div>
  <div id="uploadStatus" class="hinweis" hidden></div>
  <table class="tab" id="liste">
    <thead><tr><th class="w-cb"><input type="checkbox" id="alleWahl" aria-label="Alle wählen"></th>
      <th>Eingang</th><th>Absender</th><th>Art</th><th>Kennz.</th><th>Fahrer</th><th class="num">Betrag</th><th>Frist</th><th>Status</th></tr></thead>
    <tbody id="zeilen"><tr><td colspan="9">Lade …</td></tr></tbody>
  </table>
</main>
<dialog id="detail" class="detail"></dialog>
<dialog id="mieterDlg" class="detail"></dialog>
<dialog id="sammelDlg" class="detail"></dialog>
```

- [ ] **Step 3: Zustand, Laden, Suche, Reiter**

```js
const ART = { lenkererhebung: 'Lenkererhebung', strafverfuegung: 'Strafverfügung', anonymverfuegung: 'Anonymverfügung',
  zahlungsaufforderung: 'Zahlungsaufforderung', mahnung: 'Mahnung', sonstige: 'Sonstige' };
const STRAFE = ['strafverfuegung', 'anonymverfuegung', 'zahlungsaufforderung', 'mahnung'];
const REITER = [
  ['offen', 'Offen', q => q.in('status', ['neu', 'pruefen', 'offen'])],
  ['le', 'Lenkererhebungen', q => q.eq('art', 'lenkererhebung')],
  ['strafen', 'Strafen', q => q.in('art', STRAFE)],
  ['sonstige', 'Sonstige', q => q.eq('art', 'sonstige')],
  ['gesendet', 'Gesendet', null],
  ['erledigt', 'Erledigt', q => q.eq('status', 'erledigt')],
  ['alle', 'Alle', q => q],
];
const S = { reiter: 'offen', q: '', rows: [], fahrer: [], mieter: [], ausgang: {}, wahl: new Set() };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const datum = d => d ? new Date(d).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
const zeit = d => d ? new Date(d).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const euro = n => n == null ? '' : Number(n).toLocaleString('de-AT', { style: 'currency', currency: 'EUR' });
const heute = () => new Date().toISOString().slice(0, 10);

async function laden() {
  const sb = getSupabase();
  const r = REITER.find(x => x[0] === S.reiter);
  if (S.reiter === 'gesendet') {
    const { data, error } = await sb.from('post_ausgang').select('*, post_eingang(id, art, gz, kennzeichen, usp_absender, behoerde, datei_pfad)')
      .is('test_an', null).order('gesendet_am', { ascending: false, nullsFirst: false }).limit(500);
    S.gesendet = error ? [] : data; zeichnen(); return;
  }
  let q = sb.from('post_eingang').select('id,quelle,usp_absender,usp_betreff,zugestellt_am,eingelesen_am,art,gz,behoerde,kennzeichen,tatzeit,betrag,frist,antwort_email,fahrer_id,fahrer_vorschlag_id,status,pruef_grund,freigegeben_am,erledigt_am,notiz,datei_pfad,delikt,tatort')
    .order('zugestellt_am', { ascending: false, nullsFirst: false }).order('eingelesen_am', { ascending: false }).limit(500);
  q = r[2](q);
  const such = S.q.replace(/[,()"]/g, ' ').trim();
  if (such) q = q.or(`gz.ilike.*${such}*,kennzeichen.ilike.*${such}*,suche.wfts(german).${such}`);
  const { data, error } = await q;
  S.rows = error ? [] : data;
  if (error) console.warn('Post laden:', error);
  const gz = S.rows.map(r => r.gz).filter(Boolean);
  S.ausgang = {};
  if (gz.length) {
    const { data: a } = await sb.from('post_ausgang').select('gz, gesendet_am, an, gmail_thread_id, quelle')
      .in('gz', gz).is('test_an', null).is('fehler', null);
    (a || []).forEach(x => { S.ausgang[x.gz] = x; });
  }
  zeichnen();
}
async function stammdaten() {
  const sb = getSupabase();
  const [f, m] = await Promise.all([
    sb.from('fahrer').select('id,name,kennzeichen,aktiv').order('name'),
    sb.from('mietverhaeltnisse').select('*').order('gueltig_von', { ascending: true, nullsFirst: true }),
  ]);
  S.fahrer = f.data || []; S.mieter = m.data || [];
}
const fahrerName = id => (S.fahrer.find(f => f.id === id) || {}).name || '';
let suchTimer = null;
document.getElementById('suche').addEventListener('input', e => {
  clearTimeout(suchTimer); suchTimer = setTimeout(() => { S.q = e.target.value; laden(); }, 300);
});
```

- [ ] **Step 4: Tabelle zeichnen (inkl. Status-Text, Frist rot, Sammelauswahl)**

```js
function statusText(r) {
  const a = r.gz && S.ausgang[r.gz];
  if (r.status === 'beantwortet' && a) return '✓ beantwortet ' + datum(a.gesendet_am) + (a.quelle === 'gmail_abgleich' ? ' (Gmail)' : '');
  return ({ neu: 'wird gelesen …', pruefen: '⚠ prüfen', offen: r.art === 'lenkererhebung' ? 'zu beantworten'
    : STRAFE.includes(r.art) ? (r.fahrer_id ? 'freigeben' : 'zuordnen') : 'offen',
    beantwortet: '✓ beantwortet', freigegeben: '✓ freigegeben', erledigt: 'erledigt' })[r.status] || r.status;
}
function zeichnen() {
  document.getElementById('reiter').innerHTML = REITER.map(([k, t]) =>
    '<button class="chip' + (k === S.reiter ? ' on' : '') + '" data-r="' + k + '" role="tab">' + t + '</button>').join('');
  const tb = document.getElementById('zeilen');
  if (S.reiter === 'gesendet') {
    tb.innerHTML = (S.gesendet || []).map(a => '<tr data-id="' + esc(a.post_eingang?.id || '') + '">'
      + '<td></td><td>' + zeit(a.gesendet_am) + '</td><td>' + esc(a.an) + '</td><td>' + esc(a.betreff) + '</td><td>'
      + esc(a.post_eingang?.kennzeichen) + '</td><td colspan="3">' + (a.fehler ? '⚠ ' + esc(a.fehler) : esc((a.text || '').split('\n')[3] || '')) + '</td><td>'
      + (a.gmail_thread_id ? '<a target="_blank" rel="noopener" href="https://mail.google.com/mail/?authuser=sw.hydrafleet@gmail.com#all/' + esc(a.gmail_thread_id) + '">Gmail</a>' : '') + '</td></tr>').join('')
      || '<tr><td colspan="9">Noch nichts gesendet.</td></tr>';
    return;
  }
  tb.innerHTML = S.rows.map(r => {
    const ueberfaellig = r.frist && r.frist < heute() && ['neu', 'pruefen', 'offen'].includes(r.status);
    const waehlbar = r.art === 'lenkererhebung' && r.status === 'offen';
    const fahrer = r.fahrer_id ? esc(fahrerName(r.fahrer_id)) + (r.fahrer_id === r.fahrer_vorschlag_id && !r.freigegeben_am ? ' <span class="leise">(Vorschl.)</span>' : '') : '';
    return '<tr data-id="' + r.id + '"' + (ueberfaellig ? ' class="rot"' : '') + '>'
      + '<td class="w-cb">' + (waehlbar ? '<input type="checkbox" data-w="' + r.id + '"' + (S.wahl.has(r.id) ? ' checked' : '') + '>' : '') + '</td>'
      + '<td>' + datum(r.zugestellt_am || r.eingelesen_am) + '</td>'
      + '<td>' + esc(r.behoerde || r.usp_absender) + '</td>'
      + '<td>' + esc(ART[r.art] || '–') + '</td>'
      + '<td>' + esc(r.kennzeichen) + '</td><td>' + fahrer + '</td>'
      + '<td class="num">' + euro(r.betrag) + '</td><td>' + datum(r.frist) + '</td>'
      + '<td>' + esc(statusText(r)) + '</td></tr>';
  }).join('') || '<tr><td colspan="9">Nichts gefunden.</td></tr>';
  const n = S.wahl.size, s = document.getElementById('sammel');
  s.hidden = n === 0;
  s.innerHTML = '<button class="btn primär" id="btnSammel">' + n + ' Lenkererhebung' + (n === 1 ? '' : 'en') + ' senden …</button>';
}
document.getElementById('reiter').addEventListener('click', e => {
  const b = e.target.closest('[data-r]'); if (!b) return; S.reiter = b.dataset.r; S.wahl.clear(); laden();
});
document.getElementById('zeilen').addEventListener('click', e => {
  const cb = e.target.closest('[data-w]');
  if (cb) { cb.checked ? S.wahl.add(cb.dataset.w) : S.wahl.delete(cb.dataset.w); zeichnen(); return; }
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr[data-id]'); if (tr && tr.dataset.id) detailOeffnen(tr.dataset.id);
});
document.getElementById('alleWahl').addEventListener('change', e => {
  S.rows.filter(r => r.art === 'lenkererhebung' && r.status === 'offen').forEach(r => e.target.checked ? S.wahl.add(r.id) : S.wahl.delete(r.id));
  zeichnen();
});
```

CSS ergänzen: `tr.rot td { color: var(--rot, #c0392b); } .leise { opacity:.6 } .sammel { position: sticky; top: 0; padding: 8px 0; }` und die Tabellen-/Chip-Stile aus `lohn.html`.

- [ ] **Step 5: Detail-Dialog (PDF + Arbeitsbereich je Art)**

```js
async function fn(name, body) {
  const { data, error } = await getSupabase().functions.invoke(name, { body });
  if (error) { let t = error.message; try { t = (await error.context.json()).fehler || t; } catch (e) {} throw new Error(t); }
  return data;
}
async function rpc(name, args) { const { error } = await getSupabase().rpc(name, args); if (error) throw error; }

async function detailOeffnen(id) {
  const r = S.rows.find(x => x.id === id); if (!r) return;
  const d = document.getElementById('detail');
  const kopf = '<div class="d-kopf"><b>' + esc(ART[r.art] || 'Post') + ' · ' + esc(r.gz || r.usp_betreff || '') + '</b>'
    + '<button class="btn" id="dPdf">PDF ansehen</button><button data-zu aria-label="Schließen">✕</button></div>';
  const info = '<dl class="d-info"><dt>Absender</dt><dd>' + esc(r.behoerde || r.usp_absender) + '</dd>'
    + '<dt>Kennzeichen</dt><dd>' + esc(r.kennzeichen) + '</dd><dt>Tatzeit</dt><dd>' + zeit(r.tatzeit) + '</dd>'
    + '<dt>Ort / Delikt</dt><dd>' + esc([r.tatort, r.delikt].filter(Boolean).join(' · ')) + '</dd>'
    + '<dt>Betrag</dt><dd>' + euro(r.betrag) + '</dd><dt>Frist</dt><dd>' + datum(r.frist) + '</dd></dl>'
    + (r.pruef_grund ? '<p class="warn">⚠ ' + esc(r.pruef_grund) + ' <button class="btn" id="dNeu">Neu auslesen</button></p>' : '');
  let arbeit = '<div id="dArbeit">Lade …</div>';
  d.innerHTML = kopf + info + arbeit
    + '<label>Notiz<textarea id="dNotiz" rows="2">' + esc(r.notiz) + '</textarea></label>'
    + '<div class="d-fuss">' + (r.status === 'erledigt' ? '<button class="btn" id="dAuf">Wieder öffnen</button>' : '<button class="btn" id="dErl">Erledigt</button>') + '</div>';
  d.showModal();
  d.querySelector('[data-zu]').onclick = () => d.close();
  d.querySelector('#dPdf').onclick = () => pdfAnsicht('post', r.datei_pfad, (ART[r.art] || 'Post') + ' ' + (r.gz || ''));
  const neu = d.querySelector('#dNeu'); if (neu) neu.onclick = async () => { neu.disabled = true; neu.textContent = 'Lese …'; try { await fn('post-eingang', { aktion: 'neu_auslesen', id: r.id }); d.close(); laden(); } catch (e) { neu.textContent = 'Fehler: ' + e.message; } };
  d.querySelector('#dNotiz').onchange = e => rpc('post_notiz', { p_id: r.id, p_notiz: e.target.value }).catch(err => alert(err.message));
  const erl = d.querySelector('#dErl'); if (erl) erl.onclick = async () => { await rpc('post_erledigt', { p_id: r.id, p_notiz: d.querySelector('#dNotiz').value }); d.close(); laden(); };
  const auf = d.querySelector('#dAuf'); if (auf) auf.onclick = async () => { await rpc('post_wieder_oeffnen', { p_id: r.id }); d.close(); laden(); };
  const box = d.querySelector('#dArbeit');

  if (r.art === 'lenkererhebung') {
    const a = S.ausgang[r.gz];
    if (a) { box.innerHTML = '<p>✓ beantwortet ' + zeit(a.gesendet_am) + ' an ' + esc(a.an) + (a.gmail_thread_id ? ' · <a target="_blank" rel="noopener" href="https://mail.google.com/mail/?authuser=sw.hydrafleet@gmail.com#all/' + esc(a.gmail_thread_id) + '">in Gmail</a>' : '') + '</p>'; return; }
    try {
      const [v] = await fn('post-senden', { aktion: 'vorschau', ids: [r.id] });
      if (!v.ok) { box.innerHTML = '<p class="warn">Nicht sendbar: ' + esc(v.grund) + '</p>'; return; }
      box.innerHTML = '<pre class="mail">An:      ' + esc(v.an) + '\nBetreff: ' + esc(v.betreff) + '\n\n' + esc(v.text) + '</pre>'
        + '<button class="btn primär" id="dSend">' + esc(v.knopf) + '</button> '
        + '<button class="btn" id="dTest">Probe an mich</button>';
      box.querySelector('#dSend').onclick = async ev => {
        ev.target.disabled = true; ev.target.textContent = 'Sende …';
        const [e] = await fn('post-senden', { aktion: 'senden', ids: [r.id] });
        ev.target.textContent = e.ok ? '✓ gesendet' : 'Nicht gesendet: ' + e.grund; laden();
      };
      box.querySelector('#dTest').onclick = async ev => {
        ev.target.disabled = true;
        const [e] = await fn('post-senden', { aktion: 'senden', ids: [r.id], test_an: 'sw.hydrafleet@gmail.com' });
        ev.target.textContent = e.ok ? '✓ Probe an sw.hydrafleet@gmail.com' : 'Fehler: ' + e.grund;
      };
    } catch (e) { box.innerHTML = '<p class="warn">' + esc(e.message) + '</p>'; }
    return;
  }

  if (STRAFE.includes(r.art)) {
    const opts = '<option value="">– Fahrer wählen –</option>' + S.fahrer.filter(f => f.aktiv || f.id === r.fahrer_id)
      .map(f => '<option value="' + f.id + '"' + (f.id === r.fahrer_id ? ' selected' : '') + '>' + esc(f.name) + (f.kennzeichen ? ' · ' + esc(f.kennzeichen) : '') + '</option>').join('');
    box.innerHTML = r.freigegeben_am
      ? '<p>✓ für <b>' + esc(fahrerName(r.fahrer_id)) + '</b> freigegeben am ' + zeit(r.freigegeben_am) + '</p><button class="btn" id="dZurueck">Freigabe zurücknehmen</button>'
      : '<label>Fahrer ' + (r.fahrer_vorschlag_id ? '<span class="leise">(Vorschlag über Kennzeichen, Stand heute – Tatzeit ' + zeit(r.tatzeit) + ')</span>' : '') + '<select id="dFahrer">' + opts + '</select></label>'
        + '<button class="btn primär" id="dFrei"' + (r.fahrer_id ? '' : ' disabled') + '>Für Fahrer freigeben</button>';
    const sel = box.querySelector('#dFahrer');
    if (sel) sel.onchange = async () => { await rpc('post_zuordnen', { p_id: r.id, p_fahrer_id: sel.value ? Number(sel.value) : null }); r.fahrer_id = sel.value ? Number(sel.value) : null; box.querySelector('#dFrei').disabled = !r.fahrer_id; };
    const fr = box.querySelector('#dFrei'); if (fr) fr.onclick = async () => { try { await rpc('post_freigeben', { p_id: r.id }); d.close(); laden(); } catch (e) { alert(e.message); } };
    const zu = box.querySelector('#dZurueck'); if (zu) zu.onclick = async () => { await rpc('post_freigabe_zuruecknehmen', { p_id: r.id }); d.close(); laden(); };
    return;
  }
  box.innerHTML = '';
}
```

- [ ] **Step 6: Sammel-Senden, Upload, Abgleich, Mieter**

```js
document.getElementById('sammel').addEventListener('click', async e => {
  if (!e.target.closest('#btnSammel')) return;
  const ids = [...S.wahl], dlg = document.getElementById('sammelDlg');
  dlg.innerHTML = '<p>Lade Vorschau …</p>'; dlg.showModal();
  const v = await fn('post-senden', { aktion: 'vorschau', ids });
  const ok = v.filter(x => x.ok);
  dlg.innerHTML = '<h2>' + ok.length + ' von ' + v.length + ' sendbar</h2><table class="tab"><thead><tr><th>GZ</th><th>An</th><th>Mieter</th></tr></thead><tbody>'
    + v.map(x => '<tr><td>' + esc(x.betreff || '') + '</td><td>' + esc(x.an || '') + '</td><td>' + (x.ok ? esc(x.mieter_kurz) : '⚠ ' + esc(x.grund)) + '</td></tr>').join('')
    + '</tbody></table><div class="d-fuss"><button class="btn" data-zu>Abbrechen</button> <button class="btn primär" id="jetzt"' + (ok.length ? '' : ' disabled') + '>Jetzt ' + ok.length + ' senden</button></div>';
  dlg.querySelector('[data-zu]').onclick = () => dlg.close();
  dlg.querySelector('#jetzt').onclick = async ev => {
    ev.target.disabled = true; ev.target.textContent = 'Sende …';
    const erg = await fn('post-senden', { aktion: 'senden', ids: ok.map(x => x.id) });
    const n = erg.filter(x => x.ok).length;
    ev.target.textContent = n + ' gesendet' + (erg.length - n ? ', ' + (erg.length - n) + ' nicht' : '');
    S.wahl.clear(); laden();
  };
});

async function hochladen(files) {
  const liste = [...files].filter(f => /\.pdf$/i.test(f.name));
  const st = document.getElementById('uploadStatus'); st.hidden = false;
  let neu = 0, doppelt = 0, fehler = 0;
  for (let i = 0; i < liste.length; i++) {
    st.textContent = 'Lade ' + (i + 1) + '/' + liste.length + ': ' + liste[i].name + ' …';
    const fd = new FormData(); fd.append('datei', liste[i], liste[i].name); fd.append('quelle', 'upload');
    try { const r = await fn('post-eingang', fd); r.doppelt ? doppelt++ : neu++; } catch (e) { fehler++; console.warn(liste[i].name, e); }
  }
  st.textContent = liste.length + ' PDFs: ' + neu + ' neu, ' + doppelt + ' schon vorhanden' + (fehler ? ', ' + fehler + ' Fehler (Konsole)' : '') + '. Jetzt „Mit Gmail abgleichen“.';
  laden();
}
document.getElementById('upload').addEventListener('change', e => hochladen(e.target.files));
document.getElementById('uploadDateien').addEventListener('change', e => hochladen(e.target.files));
document.getElementById('btnAbgleich').addEventListener('click', async e => {
  e.target.disabled = true; e.target.textContent = 'Gleiche ab …';
  try { const r = await fn('post-senden', { aktion: 'abgleich' }); e.target.textContent = r.gefunden + ' von ' + r.geprueft + ' schon in Gmail'; }
  catch (err) { e.target.textContent = 'Fehler: ' + err.message; }
  setTimeout(() => { e.target.disabled = false; e.target.textContent = 'Mit Gmail abgleichen'; }, 5000); laden();
});

document.getElementById('btnMieter').addEventListener('click', () => {
  const d = document.getElementById('mieterDlg');
  const zeile = m => '<tr data-m="' + (m.id || '') + '">' + ['kurz', 'name', 'adresse', 'uid', 'fn', 'gueltig_von', 'gueltig_bis']
    .map(k => '<td><input data-k="' + k + '" ' + (k.startsWith('gueltig') ? 'type="date" ' : '') + 'value="' + esc(m[k] || '') + '"></td>').join('') + '</tr>';
  d.innerHTML = '<h2>Mieter der Flotte</h2><p class="leise">Die Antwort nennt den Mieter, der am Tag der Tatzeit gilt (bis-Datum inklusive).</p>'
    + '<table class="tab"><thead><tr><th>Kurz</th><th>Firma</th><th>Adresse</th><th>UID</th><th>FN</th><th>von</th><th>bis</th></tr></thead><tbody>'
    + S.mieter.map(zeile).join('') + zeile({}) + '</tbody></table><p id="mFehler" class="warn"></p>'
    + '<div class="d-fuss"><button class="btn" data-zu>Schließen</button> <button class="btn primär" id="mSpeichern">Speichern</button></div>';
  d.showModal();
  d.querySelector('[data-zu]').onclick = () => d.close();
  d.querySelector('#mSpeichern').onclick = async () => {
    const sb = getSupabase();
    try {
      for (const tr of d.querySelectorAll('tr[data-m]')) {
        const o = {}; tr.querySelectorAll('input').forEach(i => { o[i.dataset.k] = i.value.trim() || null; });
        if (!o.kurz && !o.name) continue;
        const q = tr.dataset.m ? sb.from('mietverhaeltnisse').update(o).eq('id', Number(tr.dataset.m)) : sb.from('mietverhaeltnisse').insert(o);
        const { error } = await q; if (error) throw error;
      }
      await stammdaten(); d.close();
    } catch (e) { d.querySelector('#mFehler').textContent = /ueberschneidung/.test(e.message) ? 'Zeiträume überschneiden sich.' : e.message; }
  };
});

(async () => { await stammdaten(); await laden(); })();
```

- [ ] **Step 7: Link in den Kopfleisten**

`lohn.html:149` daneben: `<a class="hbtn" href="post.html">Post</a>`.
`dashboard.html`: in der Kopfleisten-Gruppe (dort, wo `lohn.html` verlinkt ist — `grep -n 'lohn.html' dashboard.html`) einen Eintrag `Post` → `post.html` im gleichen Markup wie der Lohn-Link.

- [ ] **Step 8: Prüfen**

Run: `bash scripts/check-dashboard.sh post.html && bash scripts/check-dashboard.sh dashboard.html && bash scripts/check-dashboard.sh lohn.html`
Expected: `OK: …` für alle drei.
Im Browser (lokal `python3 -m http.server` im Repo, als Büro angemeldet):
Reiter wechseln; Suche nach einer GZ-Teilzahl und nach einem Wort nur aus dem PDF (z. B. Straßenname) findet den Eintrag; PDF-Ansicht öffnet im Fenster mit „Neuer Tab“/„Herunterladen“; Mieter-Dialog: überschneidenden Zeitraum speichern → Meldung „Zeiträume überschneiden sich.“; Handybreite 390 px ohne horizontales Scrollen.

- [ ] **Step 9: Commit**

```bash
git add post.html dashboard.html lohn.html
git commit -m "post.html: postkorb-ansicht mit suche, pdf, lenkererhebung per knopf, sammel-senden, strafen freigeben, mieter"
```

---

### Task 8: Fahrerapp „Mehr → Strafen“

**Files:**
- Modify: `fahrer/index.html` (Routing `:534`, `:537`, `:543`, Menü `viewMehr` bei `:779`, neue `viewStrafen`), `sw.js:1`

**Interfaces:**
- Consumes: `fahrer_app_strafen()`, Storage-Policy `post_lesen` (Task 1).

- [ ] **Step 1: Laden** — neben `ladenLohn` ein eigener, fauler Ladezustand:

```js
        /* Strafen: eigener Ladezustand, lazy beim ersten Öffnen, nach >5 Min neu */
        S.st = { rows: [], err: false, loading: false, at: 0 };
        async function ladenStrafen() {
            S.st.loading = true;
            try {
                const res = await call('fahrer_app_strafen');
                if (res.error) { console.warn('Strafen:', res.error); S.st.err = true; S.st.rows = []; }
                else { S.st.err = false; S.st.rows = res.data || []; }
            } catch (err) { console.warn('Strafen laden:', err); S.st.err = true; }
            S.st.loading = false; S.st.at = Date.now();
            if (route().name === 'strafen') render();
        }
```

(`call` und `route()` sind die bestehenden Helfer; `call` reicht bei Büro-Vorschau `p_fahrer_id` durch wie bei `fahrer_app_lohnzettel`.)

- [ ] **Step 2: Routing** — `'strafen'` in die Namensliste (`:534`), `TAB_FOR` mit `strafen: 'mehr'` (`:537`), Nachladen `if (r.name === 'strafen' && (Date.now() - S.st.at > 300000) && !S.st.loading) ladenStrafen();` neben `:542`, und `strafen: viewStrafen` in die View-Tabelle (`:543`).

- [ ] **Step 3: Menüpunkt** — in `viewMehr` direkt unter dem Lohnzettel-Eintrag (`:779`):

```js
                + '<a class="item" href="#strafen">' + ICON_DOC + '<span class="grow">Strafen</span>' + ICON_CHEV + '</a>'
```

- [ ] **Step 4: Ansicht**

```js
        /* Strafen – nur vom Büro freigegebene, eigene; PDF per signierter URL im neuen Tab (iPhone) */
        const ST_ART = { strafverfuegung: 'Strafverfügung', anonymverfuegung: 'Anonymverfügung', zahlungsaufforderung: 'Zahlungsaufforderung', mahnung: 'Mahnung' };
        function viewStrafen() {
            const base = { back: '#mehr', title: 'Strafen', right: '' };
            if (S.st.loading && !S.st.at) return Object.assign(base, { html: '<div class="empty"><b>Lade …</b></div>' });
            if (S.st.err) return Object.assign(base, { html: '<div class="empty"><b>Strafen noch nicht verfügbar.</b><span>Bitte später erneut versuchen.</span></div>' });
            if (!S.st.rows.length) return Object.assign(base, { html: '<div class="empty"><b>Keine Strafen.</b><span>Wenn das Büro eine Strafe für dich freigibt, steht sie hier mit PDF.</span></div>' });
            const eur = n => n == null ? '' : Number(n).toLocaleString('de-AT', { style: 'currency', currency: 'EUR' });
            const dt = d => d ? new Date(d).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const html = '<div class="list">' + S.st.rows.map(r =>
                '<div class="item col">'
                + '<div class="row"><span class="grow"><b>' + esc(ST_ART[r.art] || 'Strafe') + '</b> · ' + esc(dt(r.tatzeit)) + '</span><span class="num">' + esc(eur(r.betrag)) + '</span></div>'
                + '<div class="sub">' + esc([r.delikt, r.tatort].filter(Boolean).join(' · ')) + '</div>'
                + '<div class="sub">' + esc(r.behoerde || '') + (r.gz ? ' · ' + esc(r.gz) : '') + (r.frist ? ' · Frist ' + esc(new Date(r.frist).toLocaleDateString('de-AT')) : '') + '</div>'
                + '<button class="btn pdf" data-strafe-pdf="' + esc(r.pfad) + '">PDF öffnen</button>'
                + '</div>').join('') + '</div><div class="note">Fragen zur Strafe? Bitte im Büro melden.</div>';
            return Object.assign(base, { html });
        }
```

PDF-Knopf: denselben Klick-Handler wie beim Lohnzettel (Zeilen ~688–706) verallgemeinern — Bucket aus dem Attribut ableiten:

```js
            const pdfBtn = e.target.closest('[data-lz-pdf],[data-strafe-pdf]');
            // …
            const bucket = pdfBtn.hasAttribute('data-strafe-pdf') ? 'post' : 'lohnzettel';
            const pfad = pdfBtn.getAttribute('data-strafe-pdf') || pdfBtn.getAttribute('data-lz-pdf');
            // … sb.storage.from(bucket).createSignedUrl(pfad, 60) …
```

(Vorher mit `grep -n "data-lz-pdf" fahrer/index.html` die exakten Attributnamen/Zeilen des bestehenden Handlers bestätigen und nur Bucket/Pfad-Ermittlung ändern.)

- [ ] **Step 5: Cache hochzählen** — `sw.js:1`: `const CACHE_NAME = 'hydralink-v20';`

- [ ] **Step 6: Prüfen**

Run: `bash scripts/check-dashboard.sh fahrer/index.html`
Expected: `OK: fahrer/index.html`.
Im Browser: Büro-Vorschau der Fahrerapp für den Fahrer aus dem Test (freigegebene Strafe) → „Mehr → Strafen“ zeigt 1 Eintrag, „PDF öffnen“ öffnet einen neuen Tab. Als echter Fahrer ohne Freigabe: „Keine Strafen.“

- [ ] **Step 7: Commit**

```bash
git add fahrer/index.html sw.js
git commit -m "fahrerapp: mehr -> strafen (nur freigegebene), pdf im neuen tab; cache v20"
```

---

### Task 9: Inbetriebnahme, Rückstand, Doku

**Files:**
- Modify: `CLAUDE.md`, `docs/2026-09-23-uebergabe.md`

- [ ] **Step 1: Rückstand holen** — `ssh taxi '/root/usp-rueckstand.sh --alle' | tee …/scratchpad/rueckstand.log`
Expected: je Zustellung `HTTP 200`; am Ende MCP:
`select art, status, count(*) from post_eingang group by 1,2 order by 1,2;`

- [ ] **Step 2: Gmail-Abgleich** — in `post.html` „Mit Gmail abgleichen“. Danach
`select count(*) filter (where status='beantwortet') beantwortet, count(*) filter (where status='offen') offen, count(*) filter (where status='pruefen') pruefen from post_eingang where art='lenkererhebung';`
Ergebnis dem Betreiber melden (offene = echter Rückstand).

- [ ] **Step 3: `pruefen`-Fälle durchsehen** — für jeden Grund prüfen, ob die Auslese oder die Prüfung falsch ist; bei Auslesefehlern Beschreibung im `WERKZEUG` (Task 3) schärfen, neu deployen, „Neu auslesen“.

- [ ] **Step 4: Erste echte Antwort** — Betreiber wählt eine offene Lenkererhebung, sieht die Vorschau, „Probe an mich“, dann echter Knopf. Prüfen: Mail in Gmail „Gesendet“, Eingangsbestätigung der Behörde im selben Verlauf, Eintrag „✓ beantwortet“, Reiter „Gesendet“ zeigt sie.

- [ ] **Step 5: Doku** — `CLAUDE.md`: Abschnitt „Post & Strafen“ (Tabellen, Functions `post-eingang`/`post-senden`, Bucket `post`, Mieter-Tabelle und Stichtag-Regel, Server-Anbindung `usp-bot.sh` + `usp-rueckstand.sh`, Proxy nur 127.0.0.1, Gmail-Zugang im Vault, Neuer Tab in der Kopfleiste). Tabelle „Edge Functions“ und „Key Supabase Tables“ ergänzen. `docs/2026-09-23-uebergabe.md`: Stand + offene Punkte (Mieterwechsel Mitte Oktober in `post.html → Mieter` eintragen; Telegram-Bot-Token rotieren).

- [ ] **Step 6: Commit + Push-Hinweis**

```bash
git add CLAUDE.md docs/2026-09-23-uebergabe.md
git commit -m "doku: post & strafen"
```

Betreiber: `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`
