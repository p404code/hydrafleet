# Fahrerapp: die Admin-Seite in HYDRAlink

**Datum:** 2026-09-23
**Stand:** Plan, nichts davon gebaut.
**Gehört zu:** `docs/2026-09-23-fahrerapp-plan.md` (die Fahrerseite).
**Erstellt von:** Claude Fable. Zahlen nachgeprüft, siehe *Nachgeprüft*-Kästen.

Was das Büro können muss, damit die Fahrerapp überhaupt betreibbar ist. Vier
Bausteine, eine Migration, **keine neue Edge Function, keine n8n-Änderung.**

| Baustein | Wo im Dashboard | Datenbank |
|---|---|---|
| Wochenfreigabe | Abrechnungen-Tab, Kopf neben der Wochenwahl; Haken im Upload-Tab | Tabelle `abrechnung_freigaben` + RPC `woche_freigeben(p_woche)` |
| Vorschau als Fahrer | Fahrer-Tab, Detailansicht → `/fahrer/?vorschau=<fahrer_id>` | Parameter `p_fahrer_id` in den Fahrer-RPCs, nur wirksam mit `is_app_user()` |
| Zuordnungs-Werkzeug | Fahrer-Tab, Abschnitt "Plattformkonten ohne Fahrer" + "Lösen" im Detail | Tabelle `zuordnung_manuell`, RPCs `konto_zuordnen`/`konto_loesen`, View `plattform_konten` |
| Telefonnummern-Ampel | Fahrer-Tab: KPI-Kachel, Filter-Chip, Eintrag in der Problemliste | zwei Einträge mehr im Array `probleme`, Spalte `app_faehig` in `fahrer_uebersicht` |

> **Die wichtigste Erkenntnis für die Reihenfolge:** die Vorschau funktioniert
> mit der Büro-Session und braucht **keinen SMS-Provider**. Das Büro kann die
> Fahrerseite für alle 63 Fahrer prüfen, bevor die erste SMS existiert. Deshalb
> kommt die Vorschau vor dem Provider, nicht danach.

---

## Ausgangslage

- Büro-Login: Supabase Auth mit E-Mail-Alias, Rolle in `app_metadata.app_role`.
  `is_app_user()` prüft `app_role in ('admin','user')`, `is_app_admin()` prüft
  `= 'admin'`. Ein Fahrer (Phone-Login, geplant) hat kein `app_role` und sieht
  auf keiner Tabelle etwas — bewusst.
- `fahrer` wird vom n8n-Workflow aus Notion befüllt und dabei **gelöscht und neu
  angelegt**. Deshalb `ON DELETE SET NULL` auf `bolt_drivers.fahrer_id` und
  `uber_drivers.fahrer_id`. Stabil ist `fahrer.notion_fahrer_id`, nicht `fahrer.id`.
- Der AbrechnungsBot schreibt `settlements` per Upsert auf `(woche, fahrer_name)`.
  Ein erneuter Import behält IDs und `created_at`; ein `aktualisiert_am` gibt es
  nicht. Eine Änderung ist also nur über einen Schnappschuss der Zahlen erkennbar.
- Zuordnung Plattformkonto → Fahrer macht heute allein
  `notion_zuordnung_aktualisieren()` (alle 10 Minuten über `notion-sync`), und
  zwar **nur wo `fahrer_id` null ist**, über Telefon oder Name.

> **Nachgeprüft, 2026-09-23:** `zuordnung_quelle` — Bolt: 63 `telefon`, 17
> `name`, 1 `manuell`, 9 ohne. Uber: 39 `telefon`, 15 `name`, 16 ohne.
> Die eine Handzuordnung ist `9877577f-d44a-4c3c-8114-4c701e38547f`
> ("Kamiran Haqqi") → `fahrer` 637 "Muhammet Usta", Notion-Nr. 282.
> **Sie überlebt den nächsten n8n-Neuanlauf nicht:** `SET NULL`, dann greift der
> Auto-Matcher, der über Telefon und Name nichts findet.

Nicht zugeordnete Konten **mit Geld** sind nur drei, alle bei Uber: Ossama Eid
1.073,12 €, Suleiman Akhmadov 386,66 €, Bislan Madaev 348,58 €. Die übrigen 9
Bolt- und 13 Uber-Konten ohne Fahrer haben null Fahrten.

---

## 1. Wochenfreigabe

Der Fahrer sieht eine Woche erst, wenn das Büro sie freigibt — weil nach dem
Bot-Lauf noch `lohn` und `korrektur` geändert werden.

```sql
create table public.abrechnung_freigaben (
  woche            text primary key,              -- wie settlements.woche, auch '2026-W37k'
  freigegeben_am   timestamptz not null default now(),
  freigegeben_von  text not null,                 -- app_metadata.app_name
  anzahl           integer not null,              -- Schnappschuss: Zeilen mit status='berechnet'
  summe            numeric not null               -- Schnappschuss: sum(auszahlung - coalesce(lohn,0))
);
alter table public.abrechnung_freigaben enable row level security;
create policy app_users_read   on public.abrechnung_freigaben for select to authenticated using (is_app_user());
create policy app_users_delete on public.abrechnung_freigaben for delete to authenticated using (is_app_user());
-- Kein insert/update per Policy: Anlegen nur ueber die RPC, damit der
-- Schnappschuss serverseitig entsteht und nicht vom Client kommt.

create or replace function public.woche_freigeben(p_woche text) returns public.abrechnung_freigaben
language plpgsql security definer set search_path = public as $$
declare r public.abrechnung_freigaben;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  insert into public.abrechnung_freigaben (woche, freigegeben_von, anzahl, summe)
  select p_woche, coalesce(auth.jwt()->'app_metadata'->>'app_name', 'unbekannt'),
         count(*), coalesce(sum(auszahlung - coalesce(lohn,0)), 0)
  from public.settlements where woche = p_woche and status = 'berechnet'
  having count(*) > 0
  on conflict (woche) do update set freigegeben_am = now(), freigegeben_von = excluded.freigegeben_von,
                                   anzahl = excluded.anzahl, summe = excluded.summe
  returning * into r;
  if r.woche is null then raise exception 'Keine berechneten Zeilen fuer %', p_woche; end if;
  return r;
end $$;
revoke all on function public.woche_freigeben(text) from public, anon;
grant execute on function public.woche_freigeben(text) to authenticated;
```

Umschalten auf "nur Admin darf freigeben": `is_app_user()` → `is_app_admin()` in
der RPC und in der Delete-Policy. Eine Zeile je Stelle.

**Eine Rückblick-Konstante gibt es bewusst nicht — die Freigabeliste *ist* die
Grenze.** Wochen vor KW37 gibt das Büro einfach nicht frei. Die Fahrer-RPC
`fahrer_app_abrechnungen()` bekommt
`join public.abrechnung_freigaben fr on fr.woche = s.woche`, für Abrechnung
**und** offene Beträge.

### Bedienung

Im Abrechnungen-Kopf unter der Wochenzeile, drei Zustände:

1. **Nicht freigegeben** — graue Pille "Für Fahrer nicht sichtbar" + Knopf
   `Für Fahrer freigeben`. Der Bestätigungsdialog zeigt, was der Fahrer danach
   sieht: *"KW 2026-W38 · 48 Fahrer · Auszahlungen 12.345,00 € · 4 mit Schulden ·
   5 ≠-Abweichungen · 1 Warnung (für Fahrer nicht sichtbar). Freigeben?"*
   Warnungen und ≠ blockieren nicht, sie stehen im Dialog.
2. **Freigegeben** — grüne Pille "Fahrer sehen diese Woche · seit 23.09. 08:12 ·
   Boyko" + Link `zurücknehmen`.
3. **Seit Freigabe geändert** — orange Pille mit altem und neuem Wert +
   `Erneut freigeben`. Erkennung über den Schnappschuss gegen die Live-Zahlen.
   Fahrer sehen in diesem Zustand weiterhin die **Live-Zahlen** — eine
   Lohn-Korrektur soll beim Fahrer ankommen. Die Pille ist eine Erinnerung ans
   Büro, nicht eine Sperre.

Freigegebene Wochen bekommen im `weekFilter` ein `✓` hinter dem Label.

### Erneuter CSV-Import derselben Woche

Zwei Ebenen, **kein Trigger auf `settlements`** — ein Trigger könnte den
Schreibvorgang des Bots zum Scheitern bringen, und das alte System darf nie
ausgebremst werden.

1. **Upload-Tab:** ist die Woche freigegeben, sagt der Bestätigungstext das und
   kündigt an, dass die Freigabe zurückgenommen wird. Nach erfolgreichem Import
   `delete().eq('woche', weekVal)`. Der Fahrer sieht die Woche ab diesem Moment
   nicht mehr, bis das Büro sie erneut freigibt.
2. **Sicherheitsnetz** für jeden anderen Weg (Import direkt über n8n,
   Handänderung in Supabase): der orange Zustand über den Schnappschuss.

---

## 2. Vorschau als Fahrer

Alle Fahrer-RPCs bekommen `p_fahrer_id integer default null`:

```sql
with ich as (
  select case when p_fahrer_id is not null and public.is_app_user() then p_fahrer_id
              else public.mein_fahrer_id() end as id
)
```

**Für ein Fahrer-JWT wird `p_fahrer_id` ignoriert, nicht mit Fehler quittiert** —
ein Fahrer kann über den Parameter niemals einen anderen sehen. Für ein Büro-JWT
ohne Parameter kommt leer zurück, weil `mein_fahrer_id()` über die Büro-E-Mail
keine Telefonnummer findet.

Bedienung: im Fahrer-Tab, Detailansicht, Knopf `Als Fahrer ansehen` →
`/fahrer/?vorschau=<fahrer_id>` (Desktop neues Fenster, mobil gleiche Seite).
Die Fahrerseite aktiviert den Vorschau-Modus **nur**, wenn die Session ein
`app_role` trägt; sonst wird der Parameter verworfen und normal die Login-Maske
gezeigt. Oben ein gelbes Band: *"Vorschau: Muhammet Usta (Nr. 282) — so sieht
der Fahrer die App · [Zurück zum Dashboard]"*, dazu der Anmeldestatus aus der
Ampel ("Kann sich anmelden: nein — Telefonnummer fehlt"). Damit ist die
Rückfrage "ich komm nicht rein" mit einem Blick beantwortet.

---

## 3. Zuordnungs-Werkzeug

### Warum eine eigene Tabelle

`bolt_drivers.fahrer_id` verliert beim n8n-Neuanlauf seinen Wert. Der
Auto-Matcher findet Telefon- und Namenstreffer wieder — eine Handzuordnung per
Definition nicht, sonst hätte man sie nicht von Hand gebraucht. Die Zuordnung
muss deshalb an der stabilen `notion_fahrer_id` hängen und bei jedem Lauf **neu
angewendet** werden.

```sql
create table public.zuordnung_manuell (
  anbieter         text not null check (anbieter in ('bolt','uber')),
  driver_uuid      text not null,
  notion_fahrer_id integer not null,
  gesetzt_von      text not null,
  gesetzt_am       timestamptz not null default now(),
  primary key (anbieter, driver_uuid)
);
alter table public.zuordnung_manuell enable row level security;
create policy app_users_read on public.zuordnung_manuell for select to authenticated using (is_app_user());
-- Schreiben nur ueber die beiden RPCs.
```

`konto_zuordnen(p_anbieter, p_driver_uuid, p_fahrer_id)` schlägt die
`notion_fahrer_id` nach, schreibt die Zeile und setzt zusätzlich sofort
`fahrer_id` und `zuordnung_quelle = 'manuell'` am Konto.
`konto_loesen(p_anbieter, p_driver_uuid)` macht beides rückgängig. Beide prüfen
`is_app_user()` und sind `security definer` mit `revoke … from public, anon`.

**Ergänzung in `notion_zuordnung_aktualisieren()`**, als neuer *erster* Block vor
der Telefon-/Namenslogik — Handzuordnungen wieder anwenden, bevor der
Auto-Matcher die `null`-Zeilen sieht:

```sql
with ziel as (
  select z.anbieter, z.driver_uuid, min(f.id) as fahrer_id
  from public.zuordnung_manuell z
  join public.fahrer f on f.notion_fahrer_id = z.notion_fahrer_id and f.aktiv
  group by z.anbieter, z.driver_uuid having count(f.id) = 1   -- doppelte Notion-Nr.: nichts tun
)
update public.bolt_drivers bd set fahrer_id = ziel.fahrer_id, zuordnung_quelle = 'manuell'
from ziel where ziel.anbieter = 'bolt' and bd.driver_uuid = ziel.driver_uuid
  and (bd.fahrer_id is distinct from ziel.fahrer_id);
-- identisch fuer uber_drivers
```

Damit ist eine Handzuordnung spätestens 10 Minuten nach einem n8n-Neuanlauf
wieder da. Die Migration trägt die bestehende nach:
`('bolt', '9877577f-d44a-4c3c-8114-4c701e38547f', 282, 'Migration')`.

**Lösen heisst "meine Hand weg", nicht "nie zuordnen"** — danach darf der
Auto-Matcher das Konto wieder über Telefon oder Name aufgreifen. Eine Sperre
"nie automatisch" ist bewusst nicht dabei.

**Das Werkzeug ändert nur den Spiegel** (`abrechnung_abgleich`,
`fahrer_uebersicht`, künftig Livezahlen). **Geld bleibt unberührt** — der Bot
rechnet weiter über Namen. Für Ossama Eid, der in `settlements` als
`WARNUNG_KEIN_FAHRER` steht, löst die Zuordnung die Abrechnungsseite **nicht**;
das ist Notion- und Alias-Pflege.

### Lesequelle

View `plattform_konten` (`security_invoker = true`): `anbieter`, `driver_uuid`,
`konto_name`, `telefon`, `firma`, `state`, `fahrer_id`, `fahrer_name`,
`notion_fahrer_id`, `zuordnung_quelle`, `manuell_seit`, `umsatz_letzte_woche`,
`fahrten_30t`, `vorschlag_fahrer_id` (bester `name_key`-Treffer, nur wenn eindeutig).

### Bedienung

Im Fahrer-Tab unter der Tabelle eine Karte "Plattformkonten ohne Fahrer",
Chip-Filter `mit Umsatz` (Standard, zeigt heute 3) / `alle`. Je Zeile Badge,
Kontoname, Telefon, Firma, Umsatz letzte Woche, Vorschlag und Knopf `Zuordnen`,
der in der Zeile ein `<select>` aller aktiven Fahrer aufklappt. In der
Detailansicht eines Fahrers stehen seine Konten mit `Lösen`.

Mobil ist das eine **Kartenliste, keine Tabelle** — das Drei-Spalten-Muster
gilt hier nicht. Auf 390 px prüfen.

---

## 4. Telefonnummern-Ampel

Kleinste Fassung: **keine neue Seite, keine neue Tabelle.** Der Fahrer-Tab zeigt
Probleme bereits (Punkt vor dem Namen, KPI, Filter-Chip, Liste im Detail) — es
kommen zwei Einträge im Array `probleme` und eine Spalte `app_faehig` in
`fahrer_uebersicht` dazu.

```sql
tel_doppelt as (
  select public.tel_key(telefon) as t from public.fahrer
  where aktiv and coalesce(telefon,'') <> '' group by 1 having count(*) > 1
),
-- im select:
case when coalesce(f.telefon,'') <> '' and td.t is not null then 'Telefonnummer doppelt' end,
case when coalesce(f.telefon,'') <> '' and public.tel_key(f.telefon) !~ '^[1-9][0-9]{7,14}$'
     then 'Telefonnummer nicht wählbar' end,
(coalesce(f.telefon,'') <> '' and td.t is null
 and public.tel_key(f.telefon) ~ '^[1-9][0-9]{7,14}$') as app_faehig
```

> **Nachgeprüft, 2026-09-23:** **59 app-fähig, 2 ohne Nummer** (Alik Selmurzaev,
> Murad Izrailov), **2 doppelt** (Aslambek und Aslanbek Dombaew, beide
> Notion-Nr. 93). Macht 63.

UI: KPI-Kachel `App-fähig 59 / 63`, Filter-Chip, Zeile `App-Anmeldung: möglich /
nicht möglich` im Detail. `fahrer_app_profil` liefert dasselbe als Feld
`anmeldung`, damit das Vorschau-Band es zeigen kann.

Nicht in v1: "zuletzt angemeldet" — bräuchte eine Definer-View auf `auth.users`.
Erst, wenn Fahrer tatsächlich eingeloggt sind.

---

## 5. Reihenfolge

**Vor dem Fahrer-Pilot, blockierend:**

1. **Notion bereinigen** (Büro): Dombaew-Altzeile löschen, Nummern für Murad
   Izrailov und Alik Selmurzaev eintragen. Fertig, wenn die Ampel `63 / 63` zeigt.
2. Migration `2026-09-23-fahrerapp-admin.sql`: `abrechnung_freigaben`,
   `woche_freigeben()`, Ampel-Ergänzung in `fahrer_uebersicht`.
3. Migration `2026-09-23-fahrerapp.sql`: `mein_fahrer_id()`,
   `fahrer_app_profil(p_fahrer_id)`, `fahrer_app_abrechnungen(p_fahrer_id)` —
   **mit Vorschau-Parameter von Anfang an.** Lesetest als Fahrer, als Büro ohne
   Parameter (muss leer sein), als Büro mit Parameter.
4. `dashboard.html`: Freigabe-Kasten, Upload-Haken, Ampel, Knopf "Als Fahrer
   ansehen", Guard auf `app_role`.
5. `/fahrer/index.html` + Manifest inkl. `?vorschau=`; `index.html` leitet nur
   mit `app_role` zum Dashboard; `sw.js`-Precache.
6. **Büro prüft über die Vorschau mindestens zehn Fahrer** — mit Schuld, mit
   Lohn, mit Korrektur, mit Sonderwoche `2026-W37k`. Kein SMS-Provider nötig.
7. Betreiber gibt KW37 und KW38 frei.
8. Betreiber: SMS-Provider, Turnstile, OTP-Ablauf, Rate-Limits. **Erst jetzt**
   Pilot mit 3–5 Fahrern.

**Danach, parallel möglich:**

9. Zuordnungs-Werkzeug. Unabhängig von der App, für den Abgleich sofort
   wertvoll — und **Pflicht vor Phase 3**, weil die Livezahlen an
   `bolt_drivers.fahrer_id` hängen.
10. "Als Fahrer ansehen" auch aus dem Abrechnungen-Tab.
11. "zuletzt angemeldet".
12. Phase 2 und 3 aus dem Fahrerapp-Plan.

---

## 6. Was jetzt entschieden ist

| Frage aus dem Fahrerapp-Plan | Entscheidung |
|---|---|
| Ab welcher Woche Rückblick | **Technisch entschieden:** keine Konstante, die Freigabeliste ist die Grenze. |
| Import hebt Freigabe auf? | **Ja** — Upload-Tab nimmt sie zurück, Schnappschuss als Sicherheitsnetz. |
| Bedeutung `notion_fahrer.status` | **Wird nicht für den Zugang benutzt.** "Angemeldet" deckt 16 von 63 und würde 47 Fahrer aussperren. Zugang = Zeile in `fahrer`, `aktiv`, eindeutige Nummer. |
| Sichtbare Felder | `korrektur_note` und `lohn` **ja** (stehen heute auf dem Druckzettel). `kassier_zahlungen.note`, `settlements.status`, `fahrer.prozent_schwelle/basis_miete/prozent_satz` **nein**. Die RPCs listen Spalten explizit. |
| Domain | **`hydrafleet.pages.dev/fahrer/`** für Pilot und Rollout. Eigene Domain nur auf Nachfrage — sie würde das ganze Pages-Projekt inklusive Dashboard darunter erreichbar machen. |
| Notion-Bereinigung | **Keine Frage, eine Aufgabe.** Schritt 1 oben. |
| Bolt-Sync täglich | **Nicht vor Phase 3.** Bis dahin zeigt die App nur `settlements`. |
| Pilotfahrer | **Kriterien entschieden, das Büro wählt:** Ampel grün, in KW37 und KW38 `status='berechnet'`, kein ≠-Marker, darunter einer mit Schuld und einer mit Lohn-Eintrag. |

### Nachtrag Betreiber, 23.09.

| Frage | Entscheidung |
|---|---|
| SMS-Provider | **Nein.** Anmeldung mit Fahrer-ID (Notion „Fahrer ID“, `FHR-…`) + 6-stelligem PIN. Details: Fahrerapp-Plan, Abschnitt 0. |
| Rückblick | **Aktuelle freigegebene Woche + 2 davor.** |
| Freigeben / Zurücknehmen | **Jeder mit Dashboard-Zugang** (`is_app_user()`), mit Namensprotokoll wie geplant. |

Folgen hier im Admin-Plan: Schritt 8 (SMS, Turnstile, OTP) entfällt, stattdessen
„App-Zugang anlegen / PIN zurücksetzen“ im Fahrer-Tab. Die Ampel prüft
Notion-Nr. eindeutig + Zugang angelegt statt Telefonnummer.

## 7. Was der Betreiber noch entscheiden muss

~~1–3~~ entschieden, siehe Nachtrag oben. Offen bleibt nur Punkt 4.

1. ~~**SMS-Provider** (Twilio, MessageBird, Vonage): Konto anlegen — ja oder nein?
   Wer verwaltet und zahlt?~~
2. ~~**Rückwirkende Freigabe:** nur KW37 und KW38, oder weiter zurück?
   (Vorschlag: nur diese beiden.)~~
3. ~~**Freigeben und Zurücknehmen:** jeder Büro-User — Vorschlag, mit
   Namensprotokoll — oder nur Admin?~~
4. **Plattformkonten zuordnen und lösen:** jeder Büro-User (Vorschlag) oder nur Admin?

---

## Dateien, die angefasst werden

| Datei | Wofür |
|---|---|
| `dashboard.html` | Abrechnungen-Kopf `.week-pick` für den Freigabe-Kasten; `loadData()` und `renderAbgleich()` als Lade- und Render-Muster; Upload-Prüfung und Erfolgspfad für den Import-Haken; Fahrer-Tab `initFahrer`/`fzListe`/`fzDetailHtml` für Ampel, Vorschau-Knopf und Zuordnungsabschnitt |
| `migrations/2026-09-22-notion-sync.sql` | `notion_zuordnung_aktualisieren()`, in die der Block "Handzuordnungen wieder anwenden" kommt; `tel_key()`, `name_key()` |
| `migrations/2026-09-22-bolt-sync-ergaenzungen.sql` | View `fahrer_uebersicht`, die um die zwei Probleme und `app_faehig` erweitert wird |
| `migrations/2026-05-22-kassier-admin-delete-rpc.sql` | Muster für `security definer`-RPC mit Rollenprüfung, Revoke und Grant |
| `docs/2026-09-23-fahrerapp-plan.md` | Der Fahrer-Teil, dessen RPCs hier `p_fahrer_id` und den Join auf `abrechnung_freigaben` bekommen |
