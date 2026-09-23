# Fahrerapp: Schnittstellenvertrag

**Datum:** 2026-09-23
**Stand:** verbindlich für den Bau. Nichts davon ist deployt.
**Gehört zu:** `docs/2026-09-23-fahrerapp-plan.md` (Abschnitt 0 hat Vorrang),
`docs/2026-09-23-fahrerapp-admin-plan.md` (Abschnitt 6 inkl. Nachtrag hat Vorrang),
`docs/2026-09-23-fahrerapp-design.md`.

Vier Bausteine werden parallel gegen dieses Dokument gebaut: SQL-Migration, Edge
Function, `dashboard.html`, `/fahrer/`. **Was hier steht, gilt. Was hier nicht
steht, wird nicht gebaut.** Wer eine Abweichung braucht, ändert zuerst dieses
Dokument.

> **Nachgeprüft am 23.09. gegen die Datenbank:** Alle Spalten unten stehen so in
> `information_schema`. `fahrer.notion_fahrer_id` ist die Notion-Spalte „Fahrer ID“
> (`notion-sync`: `notion_fahrer_id: nummer(s, "Fahrer ID")`, unique_id), 63 von 63
> Fahrern haben einen Treffer in `notion_fahrer`. Die SQL in Abschnitt 1 lief
> vollständig in einer Transaktion mit `ROLLBACK` (Ergebnisse in Abschnitt 1.9).
> Danach war nichts übrig.

---

## 0. Kernentscheidungen

| # | Entscheidung | Grund |
|---|---|---|
| E1 | Anker: `app_metadata.fahrer_nr` = `fahrer.notion_fahrer_id`, nur aktive Fahrer, `having count(*) = 1`, **zusätzlich** `auth.uid()` muss in `fahrer_app_zugang` für diese Nr. stehen und darf nicht gesperrt sein. | Die Nr. allein reicht nicht: gesperrte Zugänge wären sonst bis Ablauf des Access-Tokens (bis 1 h) noch lesbar. So wirkt „Sperren“ sofort. |
| E2 | Neue Tabelle `fahrer_app_zugang`, gepflegt **nur** von der Edge Function (service_role). Das Dashboard liest sie über RLS, `fahrer_uebersicht` joint sie. | `fahrer_uebersicht` ist `security_invoker` und darf `auth.users` nicht lesen. Eine Definer-View auf `auth.users` wäre die grössere Öffnung. Schlüssel ist die stabile Notion-Nr., daher überlebt der Eintrag das Löschen/Neuanlegen von `fahrer` durch n8n. |
| E3 | Zuordnung Abrechnungszeile → Fahrer über die bestehende Funktion `settlement_fahrer(s.telefon, s.fahrer_name)`. | Dieselbe Regel wie `abrechnung_abgleich`. Jede Zeile gehört genau einem Fahrer (Telefon vor Name, dann kleinste ID), damit kann keine Zeile bei zwei Fahrern auftauchen. |
| E4 | Abrechnungen: die **3 neuesten Einträge in `abrechnung_freigaben`** (Sortierung `woche desc` als Text; `2026-W37k` liegt zwischen W37 und W38). Offen: **alle** freigegebenen Wochen mit offenem Betrag > 0. | Vorgabe. Die Freigabeliste ist die einzige Grenze, keine Konstante. |
| E5 | Offen-Rechnung **identisch zu `getOpenDebts()`**: `schuld = abs(auszahlung)` bei `auszahlung < 0`, `kassiert = sum(kassier_zahlungen.betrag)` über `(fahrer_name, woche)`, `offen = max(0, schuld − kassiert)`. Lohn geht **nicht** ein. | Der Fahrer muss dieselbe Zahl sehen wie das Büro im Tab „Müssen zahlen“. |
| E6 | Konten zuordnen/lösen: jeder `is_app_user()`. | Annahme für die offene Frage 4 im Admin-Plan. Umstellen: in `konto_zuordnen` und `konto_loesen` je eine Zeile `is_app_user()` → `is_app_admin()`. |
| E7 | PIN wird **vom Server erzeugt** (6 Ziffern, kryptographisch zufällig) und genau einmal in der Antwort zurückgegeben. Das Büro tippt keinen PIN. | Keine schwachen PINs wie 123456, keine PINs im Browserverlauf von Formularen. |
| E8 | **Upload-Tab wird nicht angefasst.** Die Freigabe wird nach einem erneuten CSV-Import *nicht* automatisch zurückgenommen. Sicherheitsnetz ist allein der Zustand „Seit Freigabe geändert“ (Schnappschuss). | Harte Regel: CSV-Upload bleibt unverändert. Weicht vom Admin-Plan Abschnitt 1 „Upload-Tab“ ab. |
| E9 | Nicht in v1: PDFs, Dienstgeber-Block, WhatsApp-Nummer und -Knopf, Nachrichten, Fahrzeug-Screen, Lohnzettel-Screen, „Als Bild speichern“, Fehlversuch-Sperre ausser den Supabase-Rate-Limits, „zuletzt angemeldet“. Reiter „Nachrichten“ und „Fahrzeug“ sind sichtbar, ausgegraut, mit „bald“. | Vorgabe. |

---

## 1. Datenbank — `migrations/2026-09-23-fahrerapp.sql`

**Eine Datei.** Reihenfolge in der Datei wie in diesem Abschnitt. Alle Objekte in
`public`. Alle neuen Tabellen: RLS an, `revoke all … from anon`, keine Insert-/
Update-Policy (geschrieben wird nur über `security definer`-RPCs bzw. die Edge
Function mit service_role).

Fehlercodes der RPCs (PostgREST reicht `message` und `code` an `supabase-js` als
`error.message` / `error.code` durch):

| `code` | Bedeutung | Frontend zeigt |
|---|---|---|
| `42501` | Aufrufer ist kein Büro-User | „Keine Berechtigung.“ |
| `P0002` | Woche/Fahrer/Konto nicht gefunden | `error.message` |
| `P0001` | Notion-Nr. doppelt | `error.message` |
| `22023` | Unbekannter Anbieter | `error.message` |

### 1.1 Tabelle `abrechnung_freigaben`

| Spalte | Typ | Bedeutung |
|---|---|---|
| `woche` | `text` PK | wie `settlements.woche`, auch `2026-W37k` |
| `freigegeben_am` | `timestamptz not null default now()` | |
| `freigegeben_von` | `text not null` | `app_metadata.app_name` des Aufrufers, sonst `'unbekannt'` |
| `anzahl` | `integer not null` | Schnappschuss: Zeilen mit `status='berechnet'` |
| `summe` | `numeric not null` | Schnappschuss: `round(sum(auszahlung − coalesce(lohn,0)), 2)` über dieselben Zeilen |

Policies: `select` und `delete` für `authenticated using (is_app_user())`. Kein Insert/Update per Policy.
**Zurücknehmen** = `supabase.from('abrechnung_freigaben').delete().eq('woche', w)`.

### 1.2 Tabelle `fahrer_app_zugang`

| Spalte | Typ | Bedeutung |
|---|---|---|
| `notion_fahrer_id` | `integer` PK | = `app_metadata.fahrer_nr` |
| `auth_user_id` | `uuid not null unique` | `auth.users.id`, **kein FK** auf `auth.users` (Schema `auth` bleibt unberührt) |
| `angelegt_am` | `timestamptz not null default now()` | |
| `angelegt_von` | `text not null` | `app_name` des Büro-Users |
| `pin_geaendert_am` | `timestamptz` | null bis zum ersten „PIN neu“ |
| `gesperrt` | `boolean not null default false` | |
| `gesperrt_am` | `timestamptz` | null wenn nicht gesperrt |

Policy: `select` für `authenticated using (is_app_user())`. Schreiben nur service_role (Edge Function).

### 1.3 Tabelle `zuordnung_manuell`

Wie Admin-Plan Abschnitt 3: `anbieter text check in ('bolt','uber')`,
`driver_uuid text`, `notion_fahrer_id integer`, `gesetzt_von text`,
`gesetzt_am timestamptz default now()`, PK `(anbieter, driver_uuid)`. Policy
`select` für `is_app_user()`. Nachtrag in der Migration:
`('bolt', '9877577f-d44a-4c3c-8114-4c701e38547f', 282, 'Migration') on conflict do nothing`
(geprüft: Konto steht heute auf `fahrer` 637 „Muhammet Usta“, Nr. 282, `manuell`).

### 1.4 Fahrer-Funktionen

Alle: `language sql stable security definer set search_path = public`,
`revoke all … from public, anon`, `grant execute … to authenticated`.

**Wer wird angezeigt — eine Regel für alle drei Fahrer-RPCs** (`fahrer_app_ziel`):

| Aufrufer | `p_fahrer_id` | Ergebnis |
|---|---|---|
| Fahrer-JWT (kein `app_role`) | egal, **wird ignoriert** | der eigene Fahrer über `mein_fahrer_id()`, sonst leer |
| Büro-JWT (`is_app_user()`) | `null` | **leer** |
| Büro-JWT | Fahrer-ID | dieser Fahrer (auch ohne App-Zugang, auch inaktiv) |
| Büro-JWT | unbekannte ID | leer |
| JWT mit falscher `sub`, gesperrt, doppelte Nr., keine Nr. | egal | leer |

Nie ein Fehler, immer leere Menge — das Frontend unterscheidet nur „Daten da“ / „leer“.

```sql
create or replace function public.mein_fahrer_id() returns integer
language sql stable security definer set search_path = public as $$
  select min(f.id)
  from public.fahrer f
  join public.fahrer_app_zugang z
    on z.notion_fahrer_id = f.notion_fahrer_id
   and z.auth_user_id = auth.uid()
   and not z.gesperrt
  where f.aktiv
    and coalesce(auth.jwt()->'app_metadata'->>'fahrer_nr', '') ~ '^[0-9]{1,9}$'
    and f.notion_fahrer_id = (auth.jwt()->'app_metadata'->>'fahrer_nr')::integer
  having count(*) = 1
$$;

create or replace function public.fahrer_app_ziel(p_fahrer_id integer) returns integer
language sql stable security definer set search_path = public as $$
  select case
    when p_fahrer_id is not null and public.is_app_user()
      then (select f.id from public.fahrer f where f.id = p_fahrer_id)
    when public.is_app_user() then null
    else public.mein_fahrer_id()
  end
$$;
```

#### `fahrer_app_profil(p_fahrer_id integer default null)` → 0 oder 1 Zeile

| Spalte | Typ | Quelle |
|---|---|---|
| `fahrer_id` | integer | `fahrer.id` |
| `fahrer_nr` | integer | `fahrer.notion_fahrer_id` → Anzeige `FHR-<nr>` |
| `name` | text | `fahrer.name` |
| `kennzeichen` | text | `fahrer.kennzeichen` |
| `mietmodell` | text | `fahrer.mietmodell` |
| `fahrzeug_modell` | text | `fuhrpark.modell` über `fuhrpark.kennzeichen_key = kennzeichen_key(fahrer.kennzeichen)`, sonst null |
| `vorschau` | boolean | `p_fahrer_id is not null and is_app_user()` |
| `nr_eindeutig` | boolean | Notion-Nr. gesetzt und genau einmal unter aktiven Fahrern |
| `app_zugang` | text | `'aktiv'` / `'gesperrt'` / `'kein_zugang'` aus `fahrer_app_zugang` |

Nicht enthalten (bewusst): `telefon`, `basis_miete`, `prozent_satz`, `prozent_schwelle`, `pin`, `telegram_chat_id`.

```sql
create or replace function public.fahrer_app_profil(p_fahrer_id integer default null)
returns table (
  fahrer_id integer, fahrer_nr integer, name text, kennzeichen text, mietmodell text,
  fahrzeug_modell text, vorschau boolean, nr_eindeutig boolean, app_zugang text
)
language sql stable security definer set search_path = public as $$
  select f.id, f.notion_fahrer_id, f.name, f.kennzeichen, f.mietmodell,
         fp.modell,
         (p_fahrer_id is not null and public.is_app_user()),
         (f.notion_fahrer_id is not null
          and (select count(*) from public.fahrer x where x.aktiv and x.notion_fahrer_id = f.notion_fahrer_id) = 1),
         case when z.notion_fahrer_id is null then 'kein_zugang'
              when z.gesperrt then 'gesperrt' else 'aktiv' end
  from public.fahrer f
  left join public.fuhrpark fp
    on fp.kennzeichen_key = public.kennzeichen_key(f.kennzeichen) and coalesce(f.kennzeichen,'') <> ''
  left join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id
  where f.id = public.fahrer_app_ziel(p_fahrer_id)
$$;
```

#### `fahrer_app_abrechnungen(p_fahrer_id integer default null)` → 0–3 Zeilen, `woche desc`

Genau die Felder des Druckzettels (`printDriver()` / `detailHtml()` in `dashboard.html`).

| Spalte | Typ | Zettel-Zeile |
|---|---|---|
| `woche` | text | Kopf |
| `freigegeben_am` | timestamptz | „freigegeben am …“ |
| `mietmodell` | text | Unterzeile „Modell …“ |
| `bolt_brutto` | numeric | Einnahmen brutto · Bolt |
| `uber_fahrpreis` | numeric | Einnahmen brutto · Uber |
| `mypos_summe` | numeric | Einnahmen brutto · MyPOS (und Netto · MyPOS, wie `printMyposNetto`) |
| `bruttoumsatz_gesamt` | numeric | Einnahmen brutto · Gesamt |
| `bolt_auszahlung` | numeric | Netto · Bolt Auszahlung |
| `uber_auszahlung` | numeric | Netto · Uber Auszahlung |
| `wir_bekommen` | numeric | Netto · Wir bekommen |
| `miete` | numeric | Abzüge · Pauschale |
| `prozent_abzug` | numeric | Abzüge · Prozent |
| `abzug_gesamt` | numeric | Abzüge · gesamt |
| `korrektur` | numeric | nur zeigen wenn `≠ 0`, Vorzeichen `+` bei > 0 |
| `korrektur_note` | text | Beschriftung der Korrektur, Fallback „Korrektur“ |
| `lohn` | numeric | „Lohn bereits überwiesen“ (Anzeige `−x` wenn > 0, sonst „–“) |
| `auszahlung` | numeric | „Auszahlung vor Lohn“ |
| `du_bekommst` | numeric | **= `coalesce(auszahlung,0) − coalesce(lohn,0)`** = `netAuszahlung()` |

Filter: `status = 'berechnet'`, `fahrer_name not like '\_\_%'`,
`settlement_fahrer(telefon, fahrer_name) = ziel`, Woche unter den 3 neuesten Freigaben.
Nicht enthalten: `id`, `telefon`, `status`, `telegram_gesendet`, `created_at`, `fahrer_name`.

```sql
create or replace function public.fahrer_app_abrechnungen(p_fahrer_id integer default null)
returns table (
  woche text, freigegeben_am timestamptz, mietmodell text,
  bolt_brutto numeric, uber_fahrpreis numeric, mypos_summe numeric, bruttoumsatz_gesamt numeric,
  bolt_auszahlung numeric, uber_auszahlung numeric, wir_bekommen numeric,
  miete numeric, prozent_abzug numeric, abzug_gesamt numeric,
  korrektur numeric, korrektur_note text, lohn numeric, auszahlung numeric, du_bekommst numeric
)
language sql stable security definer set search_path = public as $$
  with ziel as (select public.fahrer_app_ziel(p_fahrer_id) as id),
  wochen as (
    select fr.woche, fr.freigegeben_am from public.abrechnung_freigaben fr
    order by fr.woche desc limit 3
  )
  select s.woche, w.freigegeben_am, s.mietmodell,
         s.bolt_brutto, s.uber_fahrpreis, s.mypos_summe, s.bruttoumsatz_gesamt,
         s.bolt_auszahlung, s.uber_auszahlung, s.wir_bekommen,
         s.miete, s.prozent_abzug, s.abzug_gesamt,
         s.korrektur, s.korrektur_note, s.lohn, s.auszahlung,
         coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0)
  from wochen w
  join public.settlements s on s.woche = w.woche
  cross join ziel
  where ziel.id is not null
    and s.status = 'berechnet'
    and s.fahrer_name not like '\_\_%'
    and public.settlement_fahrer(s.telefon, s.fahrer_name) = ziel.id
  order by s.woche desc, s.id
$$;
```

Hinweis für das Frontend: Ein Fahrer, der in einer der 3 Wochen nicht gefahren
ist, bekommt für diese Woche **keine** Zeile — es gibt also 0 bis 3 Zeilen.

#### `fahrer_app_offen(p_fahrer_id integer default null)` → je offene Woche eine Zeile, `woche desc`

| Spalte | Typ | Bedeutung |
|---|---|---|
| `woche` | text | |
| `freigegeben_am` | timestamptz | |
| `schuld` | numeric | `round(abs(auszahlung), 2)` |
| `kassiert` | numeric | `round(sum(kassier_zahlungen.betrag), 2)` für `(fahrer_name, woche)` |
| `offen` | numeric | `round(greatest(schuld − kassiert, 0), 2)`, immer > 0 |
| `status` | text | `'offen'` (nichts kassiert) oder `'teilweise'` |
| `zahlungen` | jsonb | Array `[{"datum": timestamptz, "art": text, "betrag": numeric}]`, nach Datum aufsteigend, `[]` wenn keine. Quelle `kassiert_at`, `typ`, `betrag`. **Ohne `note`, ohne `kassiert_von`, ohne `id`.** |

Erledigte Wochen (`offen = 0`) kommen nicht zurück. Alle freigegebenen Wochen zählen,
nicht nur die 3 neuesten.

```sql
create or replace function public.fahrer_app_offen(p_fahrer_id integer default null)
returns table (woche text, freigegeben_am timestamptz, schuld numeric, kassiert numeric, offen numeric,
               status text, zahlungen jsonb)
language sql stable security definer set search_path = public as $$
  with ziel as (select public.fahrer_app_ziel(p_fahrer_id) as id),
  zeilen as (
    select s.woche, fr.freigegeben_am, s.fahrer_name, abs(s.auszahlung) as schuld
    from public.settlements s
    join public.abrechnung_freigaben fr on fr.woche = s.woche
    cross join ziel
    where ziel.id is not null
      and s.status = 'berechnet'
      and s.fahrer_name not like '\_\_%'
      and s.auszahlung < 0
      and public.settlement_fahrer(s.telefon, s.fahrer_name) = ziel.id
  ),
  mit as (
    select z.woche, z.freigegeben_am, z.schuld,
           coalesce((select sum(k.betrag) from public.kassier_zahlungen k
                     where k.fahrer_name = z.fahrer_name and k.woche = z.woche), 0) as kassiert,
           coalesce((select jsonb_agg(jsonb_build_object('datum', k.kassiert_at, 'art', k.typ, 'betrag', k.betrag)
                                      order by k.kassiert_at)
                     from public.kassier_zahlungen k
                     where k.fahrer_name = z.fahrer_name and k.woche = z.woche), '[]'::jsonb) as zahlungen
    from zeilen z
  )
  select woche, freigegeben_am, round(schuld, 2), round(kassiert, 2),
         round(greatest(schuld - kassiert, 0), 2),
         case when kassiert <= 0 then 'offen' else 'teilweise' end,
         zahlungen
  from mit
  where schuld - kassiert > 0
  order by woche desc
$$;
```

`kassier_zahlungen.typ` hat heute nur den Wert `bar` → Anzeige „bar“.

### 1.5 Büro-RPCs

Alle: `language plpgsql security definer set search_path = public`, erste Zeile
`if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;`,
`revoke all … from public, anon`, `grant execute … to authenticated`.

#### `woche_freigeben(p_woche text)` → `public.abrechnung_freigaben` (eine Zeile als JSON-Objekt)

Legt an oder erneuert (`on conflict do update`, neuer Schnappschuss, neues Datum).
Keine berechneten Zeilen in der Woche → `P0002` „Keine berechneten Zeilen für <woche>“.
Fahrer-JWT → `42501`.

```sql
create or replace function public.woche_freigeben(p_woche text) returns public.abrechnung_freigaben
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_freigaben;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  insert into public.abrechnung_freigaben (woche, freigegeben_von, anzahl, summe)
  select p_woche, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'),
         count(*), round(coalesce(sum(auszahlung - coalesce(lohn,0)), 0), 2)
  from public.settlements where woche = p_woche and status = 'berechnet'
  having count(*) > 0
  on conflict (woche) do update set freigegeben_am = now(), freigegeben_von = excluded.freigegeben_von,
                                   anzahl = excluded.anzahl, summe = excluded.summe
  returning * into r;
  if r.woche is null then raise exception 'Keine berechneten Zeilen für %', p_woche using errcode = 'P0002'; end if;
  return r;
end $$;
```

#### `konto_zuordnen(p_anbieter text, p_driver_uuid text, p_fahrer_id integer)` → `void`

Prüft: Anbieter (`22023`), Fahrer aktiv mit Notion-Nr. (`P0002`), Nr. eindeutig
unter aktiven (`P0001`), Konto existiert (`P0002`). Setzt am Konto
`fahrer_id = p_fahrer_id, zuordnung_quelle = 'manuell'` und schreibt/überschreibt
`zuordnung_manuell` mit der Notion-Nr. Überschreibt auch eine automatische Zuordnung.

#### `konto_loesen(p_anbieter text, p_driver_uuid text)` → `boolean`

Löscht die Zeile in `zuordnung_manuell`; setzt `fahrer_id = null, zuordnung_quelle = null`
**nur** wenn `zuordnung_quelle = 'manuell'`. `true` wenn etwas geändert wurde,
sonst `false` (kein Fehler). Automatische Zuordnungen bleiben unberührt — wer eine
falsche Auto-Zuordnung korrigieren will, ordnet per `konto_zuordnen` neu zu.

```sql
create or replace function public.konto_zuordnen(p_anbieter text, p_driver_uuid text, p_fahrer_id integer)
returns void
language plpgsql security definer set search_path = public as $$
declare v_nid integer; v_n integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;  -- E6
  if p_anbieter not in ('bolt','uber') then raise exception 'Unbekannter Anbieter %', p_anbieter using errcode = '22023'; end if;
  select f.notion_fahrer_id into v_nid from public.fahrer f where f.id = p_fahrer_id and f.aktiv;
  if v_nid is null then raise exception 'Fahrer % nicht gefunden oder ohne Notion-Nr.', p_fahrer_id using errcode = 'P0002'; end if;
  select count(*) into v_n from public.fahrer f where f.aktiv and f.notion_fahrer_id = v_nid;
  if v_n <> 1 then raise exception 'Notion-Nr. % ist doppelt vergeben', v_nid using errcode = 'P0001'; end if;
  if p_anbieter = 'bolt' then
    update public.bolt_drivers set fahrer_id = p_fahrer_id, zuordnung_quelle = 'manuell' where driver_uuid = p_driver_uuid;
  else
    update public.uber_drivers set fahrer_id = p_fahrer_id, zuordnung_quelle = 'manuell' where driver_uuid = p_driver_uuid;
  end if;
  if not found then raise exception 'Konto % nicht gefunden', p_driver_uuid using errcode = 'P0002'; end if;
  insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von)
  values (p_anbieter, p_driver_uuid, v_nid, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'))
  on conflict (anbieter, driver_uuid) do update
    set notion_fahrer_id = excluded.notion_fahrer_id, gesetzt_von = excluded.gesetzt_von, gesetzt_am = now();
end $$;

create or replace function public.konto_loesen(p_anbieter text, p_driver_uuid text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_weg integer;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;  -- E6
  if p_anbieter not in ('bolt','uber') then raise exception 'Unbekannter Anbieter %', p_anbieter using errcode = '22023'; end if;
  delete from public.zuordnung_manuell where anbieter = p_anbieter and driver_uuid = p_driver_uuid;
  get diagnostics v_weg = row_count;
  if p_anbieter = 'bolt' then
    update public.bolt_drivers set fahrer_id = null, zuordnung_quelle = null
    where driver_uuid = p_driver_uuid and zuordnung_quelle = 'manuell';
  else
    update public.uber_drivers set fahrer_id = null, zuordnung_quelle = null
    where driver_uuid = p_driver_uuid and zuordnung_quelle = 'manuell';
  end if;
  return v_weg > 0 or found;
end $$;
```

Grants für alle Funktionen dieses Abschnitts und 1.4:

```sql
revoke all on function public.mein_fahrer_id(), public.fahrer_app_ziel(integer),
  public.fahrer_app_profil(integer), public.fahrer_app_abrechnungen(integer), public.fahrer_app_offen(integer),
  public.woche_freigeben(text), public.konto_zuordnen(text, text, integer), public.konto_loesen(text, text)
  from public, anon;
grant execute on function public.mein_fahrer_id(), public.fahrer_app_ziel(integer),
  public.fahrer_app_profil(integer), public.fahrer_app_abrechnungen(integer), public.fahrer_app_offen(integer),
  public.woche_freigeben(text), public.konto_zuordnen(text, text, integer), public.konto_loesen(text, text)
  to authenticated;
```

### 1.6 `notion_zuordnung_aktualisieren()` — neuer Block 0

Die Funktion wird **vollständig** neu definiert: bestehender Text aus
`migrations/2026-09-22-notion-sync.sql` (identisch mit der DB, geprüft) plus
`v_manuell int := 0;` im `declare` und folgendem Block **vor** Block 1. Rückgabe
bekommt den Schlüssel `'manuell', v_manuell` dazu. Revoke/Grant wie bisher
(`service_role` only). Getestet mit `ROLLBACK`: Konto auf `null` gesetzt → Block 0
stellt 637/`manuell` wieder her.

```sql
  -- 0) Handzuordnungen wieder anwenden, bevor der Auto-Matcher die null-Zeilen sieht
  with ziel as (
    select z.anbieter, z.driver_uuid, min(f.id) as fahrer_id
    from public.zuordnung_manuell z
    join public.fahrer f on f.notion_fahrer_id = z.notion_fahrer_id and f.aktiv
    group by z.anbieter, z.driver_uuid having count(f.id) = 1   -- doppelte Notion-Nr.: nichts tun
  ),
  b as (
    update public.bolt_drivers bd set fahrer_id = ziel.fahrer_id, zuordnung_quelle = 'manuell'
    from ziel where ziel.anbieter = 'bolt' and bd.driver_uuid = ziel.driver_uuid
      and (bd.fahrer_id is distinct from ziel.fahrer_id or bd.zuordnung_quelle is distinct from 'manuell')
    returning 1
  ),
  u as (
    update public.uber_drivers ud set fahrer_id = ziel.fahrer_id, zuordnung_quelle = 'manuell'
    from ziel where ziel.anbieter = 'uber' and ud.driver_uuid = ziel.driver_uuid
      and (ud.fahrer_id is distinct from ziel.fahrer_id or ud.zuordnung_quelle is distinct from 'manuell')
    returning 1
  )
  select (select count(*) from b) + (select count(*) from u) into v_manuell;
```

Die Edge Function `notion-sync` wird **nicht** geändert (sie ruft die RPC nur auf).

### 1.7 View `plattform_konten` (`security_invoker = true`, `grant select to authenticated`)

Eine Zeile je Plattformkonto (heute 160: alle `bolt_drivers` + alle `uber_drivers`).

| Spalte | Typ | Quelle |
|---|---|---|
| `anbieter` | text | `'bolt'` / `'uber'` |
| `driver_uuid` | text | |
| `konto_name` | text | Bolt `first_name last_name`, Uber `vorname nachname`, getrimmt |
| `telefon` | text | Bolt `phone`, Uber `telefon` |
| `firma` | text | `verbindungen.firma` über `externe_id = company_id::text` (Bolt) bzw. `= org_id` (Uber); Werte heute `eh_limousinenservice_kg`, `serdo` |
| `state` | text | Bolt `state`, Uber immer null |
| `fahrer_id` | integer | |
| `fahrer_name` | text | `fahrer.name` |
| `notion_fahrer_id` | integer | `fahrer.notion_fahrer_id` |
| `zuordnung_quelle` | text | `telefon` / `name` / `manuell` / null |
| `manuell_seit` | timestamptz | `zuordnung_manuell.gesetzt_am` |
| `manuell_von` | text | `zuordnung_manuell.gesetzt_von` |
| `umsatz_letzte_woche` | numeric | Bolt: `sum(ride_price + cancellation_fee)` in `max(bolt_orders.woche)`; Uber: `sum(fahrpreis)` in `max(uber_reports.woche)` mit `umsaetze is not null` (ohne Sammelzeile). 0 wenn nichts. |
| `fahrten_30t` | integer | Bolt `order_status='finished'` letzte 30 Tage; Uber `uber_trips.status='completed'` letzte 30 Tage |
| `vorschlag_fahrer_id` | integer | nur wenn `fahrer_id is null`: (a) eindeutiger `name_key`-Treffer unter aktiven Fahrern, sonst (b) **cent-genauer Betrag**: genau eine `settlements`-Zeile (`status='berechnet'`) derselben letzten Woche mit `bolt_brutto` bzw. `uber_fahrpreis` = `umsatz_letzte_woche ≠ 0` → `settlement_fahrer()` |
| `vorschlag_grund` | text | `'name'` / `'betrag'` / null |

> **Nachgeprüft (Rollback-Test):** ohne Fahrer mit Umsatz: 3 Konten. Vorschläge:
> Suleiman Akhmadov → 2760 (Betrag 386,66), Bislan Madaev → 1870 (Betrag 348,58),
> Ossama Eid → keiner. Deckt sich mit der Übergabe (Punkt 6). Ein Vorschlag über
> gemeinsame Namensteile wurde verworfen: er schlug u. a. „Martin Vassilev → Rumen
> Vassilev“ vor.

Die vollständige View-SQL steht in Anhang A.

### 1.8 Ergänzung `fahrer_uebersicht`

`create or replace view` mit dem bestehenden Text aus
`migrations/2026-09-22-bolt-sync-ergaenzungen.sql` und diesen Änderungen
(neue Spalten **hinten anhängen**, sonst verweigert Postgres das Replace):

- CTE `zugang as (select notion_fahrer_id, gesperrt, angelegt_am from public.fahrer_app_zugang)`,
  `left join zugang za on za.notion_fahrer_id = f.notion_fahrer_id`.
- Zwei neue Einträge im Array `probleme`, vor „Kennzeichen nicht bei Bolt“:
  - `'kein App-Zugang'` — Notion-Nr. gesetzt, nicht doppelt, kein Eintrag in `fahrer_app_zugang`
  - `'App-Zugang gesperrt'` — `za.gesperrt`
- Neue Spalten am Ende:

| Spalte | Typ | Formel |
|---|---|---|
| `app_faehig` | boolean | `aktiv and notion_fahrer_id is not null and nicht doppelt` |
| `app_zugang` | text | `'aktiv'` / `'gesperrt'` / `'kein_zugang'` |
| `app_zugang_seit` | timestamptz | `za.angelegt_am` |
| `app_bereit` | boolean | `app_faehig and app_zugang = 'aktiv'` — **das ist die grüne Ampel** |

„Doppelt“ nutzt den bestehenden CTE `doppelt` (alle Fahrer, nicht nur aktive). Heute
sind alle 63 aktiv, also deckungsgleich mit `mein_fahrer_id()`.
Test: `app_faehig` 61 von 63 (Dombaew doppelt).

### 1.9 Testprotokoll (Rollback, 23.09.)

| Fall | Ergebnis |
|---|---|
| Büro-JWT, `woche_freigeben('2026-W38')` | 48 Zeilen, Summe 25.487,93 |
| Büro-JWT ohne Parameter, alle drei RPCs | leer, `mein_fahrer_id()` = null |
| Büro-JWT, Vorschau 637 | Profil Muhammet Usta, Nr. 282, Corolla 22; Abrechnungen W38 / W37k / W37 (W36 auch freigegeben, fällt korrekt raus) |
| Fahrer-JWT Nr. 282 mit passender `sub` | `mein_fahrer_id()` = 637, drei Wochen |
| Fahrer-JWT Nr. 282 mit `p_fahrer_id = 2760` | liefert trotzdem 637 (Parameter ignoriert) |
| Fahrer-JWT Nr. 282 mit fremder `sub` | null |
| Fahrer-JWT Nr. 93 (Dombaew, doppelt) | null |
| Fahrer-JWT auf `settlements`, `fahrer_uebersicht`, `fahrer_app_zugang` | je 0 Zeilen |

---

## 2. Edge Function `fahrer-zugang`

**Datei:** `supabase/functions/fahrer-zugang/index.ts`. Deno, **ohne** npm-Pakete,
Stil wie `notion-sync` (`fetch` gegen REST und Auth). Env: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (Standard-Variablen der Plattform).
Deploy später mit `verify_jwt = true` — **nicht** in diesem Bauschritt.

### 2.1 Aufruf

```
POST {SUPABASE_URL}/functions/v1/fahrer-zugang
Authorization: Bearer <access_token des Büro-Users>
apikey: <anon key>
Content-Type: application/json
```

Aus dem Dashboard: `getSupabase().functions.invoke('fahrer-zugang', { body })` —
`supabase-js` setzt die Header selbst. Bei Status ≠ 2xx liefert `invoke` ein
`error`; den Body liest man mit `await error.context.json()`.

CORS: `OPTIONS` → 204 mit `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: authorization, apikey, content-type, x-client-info`,
`Access-Control-Allow-Methods: POST, OPTIONS`. Dieselben `Allow-Origin`-Header auf
jeder Antwort.

### 2.2 Berechtigung

1. `GET {SUPABASE_URL}/auth/v1/user` mit dem `Authorization`-Header des Aufrufers
   und `apikey: SUPABASE_ANON_KEY`. Nicht 200 → `401 nicht_angemeldet`.
2. `user.app_metadata.app_role` in `('admin','user')`, sonst `403 nicht_berechtigt`.
   (Umstellbar auf nur `admin` an dieser einen Stelle.)
3. `aufrufer = user.app_metadata.app_name ?? user.email` → wird `angelegt_von`.

Alles Weitere mit `SUPABASE_SERVICE_ROLE_KEY`.

### 2.3 Request

```json
{ "aktion": "anlegen" | "pin_neu" | "sperren" | "entsperren", "fahrer_nr": 282 }
```

`fahrer_nr`: ganze Zahl 1–999999999 (JSON-Zahl oder Ziffern-String). Sonst
`400 ungueltige_anfrage`. Kein PIN im Request (E7).

E-Mail des Auth-Users: **`fhr-<nr>@hydralink.local`**, `<nr>` ohne führende Nullen
(`String(parseInt(nr, 10))`).

PIN: 6 Ziffern aus `crypto.getRandomValues` (Zahl 0–999999 ohne Modulo-Verzerrung
per Verwerfen), `padStart(6, '0')`.

### 2.4 Aktionen

**`anlegen`**
1. `GET /rest/v1/fahrer?select=id,name&aktiv=is.true&notion_fahrer_id=eq.<nr>`
   — 0 Treffer → `404 fahrer_nicht_gefunden`; > 1 → `409 fahrer_nr_doppelt`.
2. `GET /rest/v1/fahrer_app_zugang?notion_fahrer_id=eq.<nr>` — vorhanden → `409 zugang_existiert`.
3. `POST /auth/v1/admin/users`
   `{ "email": "fhr-<nr>@hydralink.local", "password": "<pin>", "email_confirm": true, "app_metadata": { "fahrer_nr": <nr als Zahl> } }`
   — E-Mail existiert schon (Status 422) → `409 auth_user_existiert`; anderer Fehler → `502 auth_fehler`.
   **Kein `app_role`**, keine `user_metadata`.
4. `POST /rest/v1/fahrer_app_zugang` `{ notion_fahrer_id, auth_user_id, angelegt_von }`.
   Scheitert das → `DELETE /auth/v1/admin/users/<id>` (aufräumen), dann `500 db_fehler`.

**`pin_neu`** — Zugang muss existieren (`404 kein_zugang`).
`PUT /auth/v1/admin/users/<auth_user_id>` `{ "password": "<pin>" }`, dann
`PATCH fahrer_app_zugang set pin_geaendert_am = now()`. Sperre bleibt, wie sie ist.
Bestehende Sitzungen laufen weiter — wer sofort raus soll, wird gesperrt.

**`sperren`** — `404 kein_zugang` wenn keiner.
`PUT /auth/v1/admin/users/<id>` `{ "ban_duration": "876000h" }`, dann
`PATCH gesperrt = true, gesperrt_am = now()`. Wirkt sofort, weil
`mein_fahrer_id()` `gesperrt` prüft. Idempotent.

**`entsperren`** — `404 kein_zugang` wenn keiner.
`PUT … { "ban_duration": "none" }`, dann `PATCH gesperrt = false, gesperrt_am = null`. Idempotent.

Reihenfolge immer: **erst Auth, dann Tabelle.** Scheitert die Tabelle nach
erfolgreichem Auth-Schritt → `500 db_fehler` mit Meldung, dass Auth schon geändert
ist (erneuter Aufruf ist gefahrlos, alle Aktionen ausser `anlegen` sind idempotent).

### 2.5 Response

Erfolg, Status 200:

```json
{ "ok": true, "aktion": "anlegen", "fahrer_nr": 282, "name": "Muhammet Usta",
  "login": "FHR-282", "pin": "048213", "gesperrt": false }
```

- `pin` nur bei `anlegen` und `pin_neu`, sonst fehlt das Feld.
- `name` nur bei `anlegen` (aus `fahrer`), sonst fehlt das Feld.
- `gesperrt` immer, Zustand nach der Aktion.

Fehler:

```json
{ "ok": false, "fehler": "zugang_existiert", "meldung": "Für FHR-282 gibt es schon einen Zugang." }
```

| HTTP | `fehler` | `meldung` (deutsch, so anzeigen) |
|---|---|---|
| 400 | `ungueltige_anfrage` | „Ungültige Anfrage.“ |
| 401 | `nicht_angemeldet` | „Bitte neu anmelden.“ |
| 403 | `nicht_berechtigt` | „Keine Berechtigung.“ |
| 404 | `fahrer_nicht_gefunden` | „Kein aktiver Fahrer mit Nr. <nr>.“ |
| 404 | `kein_zugang` | „FHR-<nr> hat noch keinen App-Zugang.“ |
| 409 | `fahrer_nr_doppelt` | „Nr. <nr> ist in Notion doppelt vergeben. Erst bereinigen.“ |
| 409 | `zugang_existiert` | „Für FHR-<nr> gibt es schon einen Zugang.“ |
| 409 | `auth_user_existiert` | „Login fhr-<nr> existiert schon ohne Eintrag. Bitte melden.“ |
| 405 | `methode` | „Nur POST.“ |
| 502 | `auth_fehler` | „Supabase Auth hat abgelehnt: <Text>“ |
| 500 | `db_fehler` | „Datenbankfehler: <Text>“ |

Nie Service-Key, Passwort-Hashes oder den Auth-User als Ganzes zurückgeben.

---

## 3. Frontend-Guards

Alle drei Seiten nutzen denselben Supabase-Client (URL + anon key wie heute) und
damit **dieselbe gespeicherte Sitzung** (Same Origin). Rollen ergeben sich allein
aus `session.user.app_metadata`:

- **Büro:** `app_role` ∈ `admin`, `user`
- **Fahrer:** kein `app_role`, `fahrer_nr` gesetzt
- **Sonst:** keines von beiden → `signOut()`

| Seite | keine Sitzung | Büro | Fahrer | sonst |
|---|---|---|---|---|
| `index.html` (`checkSession`) | Login-Maske | → `dashboard.html` | → `/fahrer/` | `signOut()`, Login-Maske |
| `dashboard.html` | → `index.html` (wie heute) | bleibt | `location.replace('/fahrer/')` | `signOut()`, → `index.html` |
| `/fahrer/` ohne `?vorschau` | Fahrer-Login | `location.replace('/dashboard.html')` | App | `signOut()`, Fahrer-Login |
| `/fahrer/?vorschau=<id>` | Fahrer-Login, Parameter verworfen | **Vorschau** | App, Parameter verworfen (`history.replaceState` auf `/fahrer/`) | `signOut()`, Fahrer-Login |

Einzelheiten:

- **`index.html`:** Büro-Login bleibt unverändert (4-stelliger PIN, `pinToPassword`,
  nur mit `app_role`). Neu nur die Weiche in `checkSession()` und unter dem
  Formular ein Link „Fahrer? Hier anmelden“ → `/fahrer/`.
- **`dashboard.html`:** im bestehenden `DOMContentLoaded`-Guard nach `getSession()`
  die Rolle prüfen. Der vorgelagerte `hydralink_session`-Guard bleibt; ein Fahrer
  hat keinen `hydralink_session`-Eintrag, landet also zuerst auf `index.html` und
  von dort auf `/fahrer/`.
- **`/fahrer/` setzt nie `hydralink_session`** und ruft in der Vorschau **nie**
  `signOut()` auf (das würde das Büro abmelden). „Abmelden“ ist in der Vorschau
  ausgeblendet.
- **Fahrer-Login:** `signInWithPassword({ email: 'fhr-' + parseInt(nr, 10) + '@hydralink.local', password: pin })`.
  Eingabe: `FHR-` fest, dahinter nur Ziffern; 6 PIN-Kästchen (`inputmode="numeric"`).
  Fehler nach `error.code`: `invalid_credentials` → „Fahrer-ID oder PIN falsch.“;
  `user_banned` → „Dein Zugang ist gesperrt. Bitte im Büro melden.“;
  `over_request_rate_limit` oder Status 429 → „Zu viele Versuche. Bitte später erneut versuchen.“;
  sonst „Verbindungsfehler. Bitte erneut versuchen.“. Nach Erfolg:
  hat die Sitzung **kein** `fahrer_nr` → `signOut()` und „Fahrer-ID oder PIN falsch.“
- **Leeres Profil** (Fahrer-JWT, `fahrer_app_profil()` liefert 0 Zeilen: gesperrt,
  Nr. doppelt, Fahrer in Notion gelöscht): Seite „Kein Zugang“ — „Dein Zugang ist
  gerade nicht aktiv. Bitte im Büro melden.“ + Knopf Abmelden.
- **Vorschau:** `vorschau` muss `^[0-9]+$` sein, sonst wie ohne Parameter. Alle drei
  RPCs mit `{ p_fahrer_id: <id> }`. Gelbes Band oben:
  „Vorschau: <name> (FHR-<nr>) — so sieht der Fahrer die App · [Zurück zum Dashboard]“
  (`/dashboard.html`), darunter „Kann sich anmelden: ja“ wenn
  `nr_eindeutig && app_zugang === 'aktiv'`, sonst „nein — “ + erster zutreffender
  Grund: `!nr_eindeutig` → „Fahrer-Nr. in Notion doppelt“, `'kein_zugang'` →
  „noch kein App-Zugang angelegt“, `'gesperrt'` → „Zugang gesperrt“.
  Leeres Profil in der Vorschau → „Fahrer <id> nicht gefunden.“
- Im Fahrer-Modus werden die RPCs **ohne** Argument aufgerufen (`sb.rpc('fahrer_app_profil')`).

---

## 4. Was die Oberflächen damit machen

### 4.1 `/fahrer/` (Screens aus `docs/2026-09-23-fahrerapp-design.md`)

Beim Start drei Aufrufe parallel: `fahrer_app_profil`, `fahrer_app_abrechnungen`,
`fahrer_app_offen`. Keine weiteren Datenquellen.

| Screen | Daten |
|---|---|
| Login | — |
| **Start** | Kopf = erste Zeile aus `abrechnungen` (neueste Woche): Woche, `freigegeben_am`, grosse Zahl `du_bekommst` mit Label „Du bekommst“ (bei < 0 in `--err`). Kacheln: Umsatz brutto = `bruttoumsatz_gesamt`; Pauschale + % = `abzug_gesamt` (Unterzeile `miete` · `prozent_abzug`); Lohn überwiesen = `lohn`; Noch offen = `Σ offen` aus `fahrer_app_offen` (Tipp → Offen). Knopf „Abrechnung KW … ansehen“. „Frühere Wochen“ = Zeilen 2 und 3. **Kein Dienstgeber-Block.** Keine Abrechnung → „Noch keine Abrechnung freigegeben.“ |
| **Abrechnung KW** | Kopf: `name`, `FHR-<fahrer_nr>`, `kennzeichen`, `fahrzeug_modell`. Zettel in der Reihenfolge der Tabelle in 1.4, `du_bekommst` als „Du bekommst“. Wochenwahl zwischen den 0–3 Zeilen. **Keine** Knöpfe „Als Bild speichern“ / „Frage per WhatsApp“. |
| **Offen** | Summe `Σ offen` gross in `--err`. Kacheln Schuld `Σ schuld`, Kassiert `Σ kassiert`, Wochen `Anzahl`. Je Zeile: Punkt (`offen` rot / `teilweise` orange), „Schuld x · kassiert y“, `offen`, darunter `zahlungen` als „TT.MM.JJJJ · bar · Betrag“. Leer: „Du schuldest uns nichts“. |
| **Mehr** | `name`, `FHR-<nr>`, `fahrzeug_modell`, `kennzeichen`. Links: Offene Beträge. Hell/Dunkel. Abmelden (nicht in der Vorschau). Kontakt-Zeile statisch: „Fragen? Bitte im Büro melden.“ — **keine** Telefon-/WhatsApp-Nummer, keine Lohnzettel. |
| Nachrichten, Fahrzeug | Reiter sichtbar, ausgegraut, Beschriftung darunter „bald“, nicht klickbar. |

Anzeige: Beträge wie `fmt()` im Dashboard (`de-AT`, 2 Nachkommastellen, „ €“),
`null` → „–“. Woche `2026-W38` → „KW 38“, Sonderwoche `2026-W37k` → „KW 37k“,
Zeitraum wie `weekRangeNumeric()` (bei `…k` ohne Zeitraum). Nur eine Spalte,
funktioniert auf 390 px, Leiste unten mit 5 Reitern ohne horizontales Scrollen.

### 4.2 `dashboard.html`

| Ort | Was | Schnittstelle |
|---|---|---|
| Abrechnungen-Kopf, unter der Wochenwahl | Freigabe-Kasten, 3 Zustände (Admin-Plan Abschnitt 1) | Lesen `from('abrechnung_freigaben').select('*')` beim `loadData()`; Freigeben `rpc('woche_freigeben', { p_woche })`; Zurücknehmen `delete().eq('woche', w)` |
| | Zustand „Seit Freigabe geändert“ | live aus `SETTLEMENTS`: Zeilen mit `woche = w` und `status === 'berechnet'`; `anzahl = count`, `summe = round2(Σ (auszahlung − lohnOf(s)))` über Zeilen mit `auszahlung != null`. Abweichung wenn `anzahl ≠ fr.anzahl` oder `|summe − fr.summe| ≥ 0,01`. |
| | Bestätigungsdialog vor dem Freigeben | Zahlen aus `SETTLEMENTS`/`ABGLEICH` wie im Admin-Plan; blockiert nicht |
| `weekFilter` | `✓` hinter freigegebenen Wochen | |
| **Upload-Tab** | **keine Änderung** (E8) | — |
| Fahrer-Tab, Liste | Ampel: KPI „App bereit x / y“ (`app_bereit`), Filter-Chip „ohne App“ (`!app_bereit`), die zwei neuen `probleme` erscheinen automatisch | `fahrer_uebersicht` |
| Fahrer-Tab, Detail | Block „App-Zugang“: Status aus `app_zugang`/`app_zugang_seit`; Knöpfe je Zustand — `kein_zugang` + `app_faehig`: „Zugang anlegen“; `aktiv`: „PIN neu“, „Sperren“; `gesperrt`: „PIN neu“, „Entsperren“. PIN nach Erfolg **einmal** gross anzeigen mit „FHR-<nr> · PIN ……“ und Hinweis „Wird nicht noch einmal angezeigt“. Danach `initFahrer()` neu laden. | Edge Function, Abschnitt 2 |
| Fahrer-Tab, Detail | Knopf „Als Fahrer ansehen“ → `/fahrer/?vorschau=<fahrer_id>`; Desktop `window.open(url, '_blank')`, mobil `location.href = url` | Abschnitt 3 |
| Fahrer-Tab, Detail | „Plattformkonten“: Konten des Fahrers aus `plattform_konten` (`fahrer_id = f.fahrer_id`), bei `zuordnung_quelle = 'manuell'` Knopf „Lösen“ | `rpc('konto_loesen', { p_anbieter, p_driver_uuid })` |
| Fahrer-Tab, unter der Liste | Karte „Plattformkonten ohne Fahrer“ als **Kartenliste** (auch am Desktop): Chips „mit Umsatz“ (Standard, `umsatz_letzte_woche ≠ 0`) / „alle“. Je Karte: Anbieter, `konto_name`, `telefon`, `firma`, `umsatz_letzte_woche`, Vorschlag (`vorschlag_fahrer_id` → Name, Grund „Name gleich“ / „Betrag gleich“), Knopf „Zuordnen“ → `<select>` aller aktiven Fahrer, Vorschlag vorausgewählt | `from('plattform_konten').select('*').is('fahrer_id', null)`; `rpc('konto_zuordnen', { p_anbieter, p_driver_uuid, p_fahrer_id })` |
| Auth-Guard | Rollenprüfung | Abschnitt 3 |

Nach jeder Änderung `bash scripts/check-dashboard.sh`.

---

## 5. Dateizuordnung

Jeder Baustein fasst **nur** seine Dateien an.

| Baustein | Dateien | Nicht anfassen |
|---|---|---|
| **SQL** | `migrations/2026-09-23-fahrerapp.sql` (neu, eine Datei) | alle bestehenden Migrationen; `settlements`, `fahrer`, `kassier_zahlungen` (nur lesen) |
| **Edge Function** | `supabase/functions/fahrer-zugang/index.ts` (neu) | `bolt-sync`, `uber-sync`, `notion-sync` |
| **Dashboard** | `dashboard.html` | Upload-Tab-Code, `index.html` |
| **Fahrerseite** | `fahrer/index.html` (neu), `fahrer/manifest.json` (neu), `index.html` (nur `checkSession` + Link), `sw.js` (`/fahrer/` und `/fahrer/manifest.json` in `PRECACHE_URLS`, `CACHE_NAME` → `hydralink-v10`) | `dashboard.html` |
| Vertrag | `docs/2026-09-23-fahrerapp-schnittstelle.md` | — |

`fahrer/manifest.json`: `name` „HYDRAlink Fahrer“, `short_name` „HYDRAlink“,
`start_url` und `scope` und `id` `/fahrer/`, `display` `standalone`, Farben und
Icons wie `/manifest.json` (absolute Pfade `/icon-192x192.png` usw.).

Einzustellen vom Betreiber, nicht Teil des Codes: Supabase Auth
Mindest-Passwortlänge ≤ 6 (sonst lehnt `admin/users` den PIN ab),
Sign-in-Rate-Limits prüfen, Migration einspielen, Function deployen
(`verify_jwt = true`), Wochen freigeben.

---

## 6. Bekannte Grenzen

- **Dombaew (Nr. 93, zwei Zeilen):** `anlegen` antwortet `409 fahrer_nr_doppelt`,
  `mein_fahrer_id()` liefert null. Bleibt so, bis Notion bereinigt ist.
- **Sonderwoche `2026-W37k`** zählt als eigene Woche, bei Abrechnungen und bei
  offenen Beträgen — genau wie heute im Tab „Müssen zahlen“. Im Test hatten
  Fahrer offene Beträge sowohl in W37 als auch in W37k. Ob das Doppelzählung ist,
  entscheidet das Büro vor der Freigabe; die App zeigt, was `getOpenDebts()` zeigt.
- **Erneuter CSV-Import** einer freigegebenen Woche: Fahrer sehen sofort die neuen
  Zahlen; das Büro sieht die orange Pille (E8).
- **`settlement_fahrer()`** ordnet über Telefon vor Name zu. Steht in Notion eine
  falsche Nummer, landet die Abrechnung beim Falschen — Notion-Telefonpflege ist
  damit weiterhin sicherheitsrelevant, auch ohne SMS-Login.
- **PIN neu** beendet keine laufenden Sitzungen; dafür gibt es Sperren.

---

## Anhang A: View `plattform_konten`

```sql
create or replace view public.plattform_konten with (security_invoker = true) as
with f_aktiv as (select id, name, notion_fahrer_id, public.name_key(name) nk from public.fahrer where aktiv),
e_name as (select nk, min(id) fid from f_aktiv where nk <> '' group by nk having count(*) = 1),
bw as (select max(woche) w from public.bolt_orders),
uw as (select max(woche) w from public.uber_reports where umsaetze is not null),
b_umsatz as (
  select o.driver_uuid, round(sum(coalesce(o.ride_price,0) + coalesce(o.cancellation_fee,0)), 2) u
  from public.bolt_orders o, bw where o.woche = bw.w group by o.driver_uuid
),
b_fahrten as (
  select driver_uuid, count(*)::integer n from public.bolt_orders
  where order_status = 'finished' and order_finished_at > now() - interval '30 days' group by driver_uuid
),
u_umsatz as (
  select r.driver_uuid, round(sum(coalesce(r.fahrpreis,0)), 2) u
  from public.uber_reports r, uw where r.woche = uw.w and r.umsaetze is not null group by r.driver_uuid
),
u_fahrten as (
  select driver_uuid, count(*)::integer n from public.uber_trips
  where status = 'completed' and bestellt_am > (now() at time zone 'Europe/Vienna') - interval '30 days'
  group by driver_uuid
),
konten as (
  select 'bolt'::text anbieter, bd.driver_uuid,
         trim(coalesce(bd.first_name,'') || ' ' || coalesce(bd.last_name,'')) konto_name,
         bd.phone telefon, v.firma, bd.state, bd.fahrer_id, bd.zuordnung_quelle,
         coalesce(bu.u, 0) umsatz_letzte_woche, coalesce(bf.n, 0) fahrten_30t
  from public.bolt_drivers bd
  left join public.verbindungen v on v.anbieter = 'bolt' and v.externe_id = bd.company_id::text
  left join b_umsatz bu on bu.driver_uuid = bd.driver_uuid
  left join b_fahrten bf on bf.driver_uuid = bd.driver_uuid
  union all
  select 'uber', ud.driver_uuid,
         trim(coalesce(ud.vorname,'') || ' ' || coalesce(ud.nachname,'')),
         ud.telefon, v.firma, null::text, ud.fahrer_id, ud.zuordnung_quelle,
         coalesce(uu.u, 0), coalesce(uf.n, 0)
  from public.uber_drivers ud
  left join public.verbindungen v on v.anbieter = 'uber' and v.externe_id = ud.org_id
  left join u_umsatz uu on uu.driver_uuid = ud.driver_uuid
  left join u_fahrten uf on uf.driver_uuid = ud.driver_uuid
)
select k.anbieter, k.driver_uuid, k.konto_name, k.telefon, k.firma, k.state,
       k.fahrer_id, f.name as fahrer_name, f.notion_fahrer_id, k.zuordnung_quelle,
       zm.gesetzt_am as manuell_seit, zm.gesetzt_von as manuell_von,
       k.umsatz_letzte_woche, k.fahrten_30t,
       case when k.fahrer_id is null then coalesce(en.fid, bt.fid) end as vorschlag_fahrer_id,
       case when k.fahrer_id is null then case when en.fid is not null then 'name'
                                               when bt.fid is not null then 'betrag' end end as vorschlag_grund
from konten k
left join public.fahrer f on f.id = k.fahrer_id
left join public.zuordnung_manuell zm on zm.anbieter = k.anbieter and zm.driver_uuid = k.driver_uuid
left join e_name en on en.nk = public.name_key(k.konto_name) and en.nk <> ''
left join lateral (
  select min(public.settlement_fahrer(s.telefon, s.fahrer_name)) fid
  from public.settlements s
  where k.fahrer_id is null and k.umsatz_letzte_woche <> 0 and s.status = 'berechnet'
    and s.woche = case k.anbieter when 'bolt' then (select w from bw) else (select w from uw) end
    and round(case k.anbieter when 'bolt' then s.bolt_brutto else s.uber_fahrpreis end, 2) = k.umsatz_letzte_woche
  having count(*) = 1
) bt on true;
grant select on public.plattform_konten to authenticated;
```

## Anhang B: Tabellen-DDL

```sql
create table public.abrechnung_freigaben (
  woche            text primary key,
  freigegeben_am   timestamptz not null default now(),
  freigegeben_von  text not null,
  anzahl           integer not null,
  summe            numeric not null
);
alter table public.abrechnung_freigaben enable row level security;
revoke all on public.abrechnung_freigaben from anon;
create policy app_users_read   on public.abrechnung_freigaben for select to authenticated using (public.is_app_user());
create policy app_users_delete on public.abrechnung_freigaben for delete to authenticated using (public.is_app_user());

create table public.fahrer_app_zugang (
  notion_fahrer_id integer primary key,
  auth_user_id     uuid not null unique,
  angelegt_am      timestamptz not null default now(),
  angelegt_von     text not null,
  pin_geaendert_am timestamptz,
  gesperrt         boolean not null default false,
  gesperrt_am      timestamptz
);
alter table public.fahrer_app_zugang enable row level security;
revoke all on public.fahrer_app_zugang from anon;
create policy app_users_read on public.fahrer_app_zugang for select to authenticated using (public.is_app_user());

create table public.zuordnung_manuell (
  anbieter         text not null check (anbieter in ('bolt','uber')),
  driver_uuid      text not null,
  notion_fahrer_id integer not null,
  gesetzt_von      text not null,
  gesetzt_am       timestamptz not null default now(),
  primary key (anbieter, driver_uuid)
);
alter table public.zuordnung_manuell enable row level security;
revoke all on public.zuordnung_manuell from anon;
create policy app_users_read on public.zuordnung_manuell for select to authenticated using (public.is_app_user());

insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von)
values ('bolt', '9877577f-d44a-4c3c-8114-4c701e38547f', 282, 'Migration')
on conflict do nothing;
```
