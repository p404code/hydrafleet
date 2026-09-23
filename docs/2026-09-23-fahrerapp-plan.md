# Fahrerapp HYDRAFLEET — Plan

**Datum:** 2026-09-23
**Stand:** Plan, nichts davon gebaut.
**Gehört zu:** `docs/2026-09-23-fahrerapp-admin-plan.md` — die Admin-Seite im
Dashboard (Wochenfreigabe, Vorschau als Fahrer, Zuordnungs-Werkzeug, Ampel).
**Achtung:** Abschnitt 7 unten ist der *ursprüngliche* Fragenstand. Fünf der neun
Fragen sind inzwischen entschieden — der gültige Stand steht im Admin-Plan,
Abschnitte 6 und 7.
**Entscheidungen 23.09.:** Anmeldung, Rückblick und Freigabe sind entschieden — siehe Abschnitt 0, hat Vorrang vor Abschnitt 2 und 7.
**Erstellt von:** Claude Fable. Die Zahlen sind nachgeprüft, siehe *Nachgeprüft*-Kästen.

## Ergebnis in drei Sätzen

Eine zusätzliche Seite `/fahrer/index.html` im bestehenden Repo (Vanilla, eine
Datei, Cloudflare Pages), Anmeldung per **SMS-Code auf die Telefonnummer, die
ohnehin in Notion steht**, Daten ausschliesslich über **drei `security definer`-
Funktionen**, die den Fahrer live über `tel_key(telefon)` auflösen. Die erste
Fassung zeigt genau das, was heute auf dem Druckzettel steht — Wochenabrechnung
und offener Betrag —, und nur für **freigegebene Wochen**. Kein Framework, keine
neue Stammdatenhaltung; `settlements`, der AbrechnungsBot und der CSV-Upload
bleiben unangetastet, die einzige neue Tabelle ist die Wochenfreigabe.

---

## 0. Entscheidungen des Betreibers (23.09.2026)

**Design:** `docs/2026-09-23-fahrerapp-design.md` (Screens, Inhalte, Phasen) und
`docs/fahrerapp-design.html` (alle Screens zum Ansehen im Browser).

Haben Vorrang vor allem, was weiter unten anders steht.

1. **Anmeldung: Fahrer-ID + 6-stelliger PIN.** Kein SMS-Provider. Die Fahrer-ID
   ist die Notion-Spalte „Fahrer ID" (Anzeige `FHR-123`, als Zahl `123`).
   Ersetzt die Empfehlung C aus Abschnitt 2.
2. **Rückblick: die aktuelle freigegebene Woche plus 2 Wochen davor.** Mehr sieht
   der Fahrer nicht.
3. **Freigeben darf jeder mit Dashboard-Zugang** (`is_app_user()`).

### Was sich dadurch technisch ändert

- **Anker ist die Fahrer-ID statt der Telefonnummer.** `mein_fahrer_id()` löst
  über `app_metadata.fahrer_nr` gegen `fahrer.notion_fahrer_id` auf, weiterhin mit
  `having count(*) = 1`. **Vor dem Bauen prüfen:** dass `fahrer.notion_fahrer_id`
  wirklich dieselbe Zahl ist wie die Notion-Spalte „Fahrer ID".
- **Ein Auth-User pro Fahrer**, angelegt vom Büro. Interne E-Mail nach dem
  Muster der Büro-User (z. B. `fhr-123@hydralink.local`), `app_metadata.fahrer_nr`
  gesetzt, **kein** `app_role` — damit greift keine bestehende Policy, das
  Dashboard bleibt für Fahrer leer wie im Plan vorgesehen.
- **Der PIN ist das Passwort**, ohne Umrechnung im Quelltext. Mindestlänge im
  Supabase-Dashboard auf 6 stellen. Gegen Durchprobieren: Sign-in-Rate-Limits
  prüfen, dazu eine Sperre nach wenigen Fehlversuchen (Umsetzung offen).
- **Neue Edge Function für das Büro** (weicht vom Admin-Plan „keine neue Edge Function“ ab — Auth-User anlegen geht nur mit service_role): Zugang anlegen und PIN zurücksetzen
  (service_role, nur für `is_app_user()`). Im Dashboard ein Bereich „App-Zugang"
  mit Anlegen / PIN neu / Sperren.
- **Guards:** `/fahrer/` verlangt `app_metadata.fahrer_nr` statt des
  `phone`-Claims. `index.html` und `dashboard.html` wie in Abschnitt 3.
- **Freigabe:** wie im Admin-Plan (`woche_freigeben()` + Delete-Policy auf `is_app_user()`) — passt schon so.
- **`fahrer_app_abrechnungen()`** liefert nur die letzten 3 freigegebenen Wochen.
- **Blockiert weiterhin:** Dombaew-Duplikat (zwei Zeilen, dieselbe Nummer 93 →
  `having count(*) = 1` sperrt ihn). **Blockiert nicht mehr:** fehlende
  Telefonnummern bei Murad Izrailov und Alik Selmurzaev.
- **Entfällt:** SMS-Provider, Turnstile, E.164-Normalisierung, Admin-Plan Schritt 8.
- **Ampel im Admin-Plan** prüft dann nicht mehr die Telefonnummer, sondern: Notion-Nr. eindeutig + App-Zugang angelegt.

### Noch offen

- Offene Beträge: nur aus den 3 sichtbaren Wochen, oder bleiben ältere offene
  Wochen (ab KW37) sichtbar, bis sie bezahlt sind?
- Wo liegen Dienstvertrag, GISA, Mietvertrag, Vollmacht, Polizze und Lohnzettel
  als PDF? Der Betreiber will sie in der App (Design: Start-Seite und Fahrzeug),
  Abschnitt 1 hatte die Personalakte bewusst ausgeschlossen.

---

## 1. Wofür ist die App da

| # | Funktion | Daten vorhanden | Was fehlt | Wem nützt es |
|---|---|---|---|---|
| 1 | **Meine Abrechnung** — der Druckzettel am Handy, plus Historie | `settlements` vollständig; Rechenweg identisch zu `printDriver()` / `netAuszahlung()` in `dashboard.html` | **Eine Freigabe-Markierung.** `status='berechnet'` steht sofort nach dem Bot, danach ändert das Büro noch `lohn` und `korrektur`. Ohne Freigabe sieht der Fahrer eine Zwischenzahl. | Fahrer: hoch. Büro: spart das Verschicken per WhatsApp und Papier. |
| 2 | **Was ich noch schulde** — je Woche, mit Teilzahlungen | `settlements.auszahlung < 0` + `kassier_zahlungen`, Logik `getOpenDebts()` | Technisch nichts. **Datenhygiene:** die Altlasten dürfen nie erscheinen (siehe Kasten). | Ehrlich: **hilft der Flotte mindestens so sehr wie dem Fahrer.** Für den Fahrer: keine Überraschung beim Kassieren. |
| 3 | **Mein Auto** — Kennzeichen, Modell, Pauschale, Pickerl | `fahrer.kennzeichen`, `fuhrpark.*`, `zuordnung_abgleich.auto_tatsaechlich` | Pickerl ist nur bei 26 von 73 Fahrzeugen gepflegt. | Fahrer: mittel. **Flotte: hoch** — der Fahrer ist der beste Prüfer seiner eigenen Zuordnung. |
| 4 | **Laufende Woche** — Fahrten und Umsatz bis jetzt | `bolt_orders` je Auftrag, `uber_trips` (ohne Betrag je Fahrt) | Der Sync läuft nur montags — „laufend" ist es nicht. Ein täglicher `pg_cron`-Eintrag für Bolt würde reichen; Uber täglich belastet die Portal-Sitzung. myPOS wird gar nicht gesynct. | Fahrer: attraktiv. Aber **grösster Quell für „die Zahl stimmt nicht mit meiner Abrechnung"**. |
| 5 | **Büro-Kontakt & Hinweise** | nichts nötig, statisch | — | Senkt Supportanrufe. Klein, gratis, gehört in v1. |

**Bewusst nicht:** Personalakte aus Notion (Meldezettel, Ausweis, IBAN, SVN
bleiben dort), Rechnungen (das sind Kundenrechnungen, nicht Fahrersache).

> **Nachgeprüft, 2026-09-23:** Offene Schulden aus `settlements` (ohne
> `__TRANSFER__`, ohne Abzug geleisteter Zahlungen): **354.006,80 € gesamt**,
> davon **339.395,97 € aus der Zeit vor KW27** und nur **14.610,83 € ab KW27**.
> Das Verhältnis ist das, worauf es ankommt: was vor KW27 liegt, ist Altbestand
> und darf in einer Fahrerapp nie auftauchen.

**Das drittwichtigste Argument für Funktion 3:** die drei bekannten
Fehlzuordnungen (vertauschtes Paar W 755 TX / W 580CTX, Aslan Abubakarovs
Pauschale) würden dem Fahrer sofort auffallen. Deshalb **erst nach der
Notion-Korrektur freischalten** — sonst wird die App zum Beschwerdekanal für
einen Fehler, den das Büro schon kennt.

---

## 2. Anmeldung

> **Überholt durch Abschnitt 0, Entscheidung 1** (Fahrer-ID + 6-stelliger PIN statt SMS).
> Der Teil *Türsteher: Funktionen statt Policies* gilt weiter, nur mit
> `app_metadata.fahrer_nr` statt `phone` als Anker.

### Was in der Datenbank tatsächlich eindeutig ist

> **Nachgeprüft, 2026-09-23:** 63 Fahrer, alle aktiv. 61 haben eine
> Telefonnummer, davon **60 verschieden** — also genau ein Duplikat. Alle 63
> haben eine `notion_fahrer_id` und einen Treffer in `notion_fahrer`. Aber nur
> **16 von 63** tragen dort den Status „Angemeldet".

- **`fahrer.id` ist nicht stabil.** Der n8n-Sync löscht und legt neu an — 63
  Zeilen verteilen sich über IDs 626–2784 und 15 verschiedene Anlagetage.
  Genau deshalb wurde `ON DELETE SET NULL` nötig. Als gespeicherter Anker unbrauchbar.
- **`fahrer.notion_fahrer_id`** ist stabil und überall gefüllt, hat aber ein
  Duplikat: Aslambek/Aslanbek Dombaew, beide Nr. 93, gleiche Nummer.
- **`settlements.telefon` trifft 48/48** über `tel_key` — der Bot schreibt die
  Nummer aus `fahrer` mit. Vier Nummern tauchen unter mehreren
  Namensschreibweisen auf: **die Nummer ist der bessere Schlüssel als der Name.**
- **`notion_fahrer.status = 'Angemeldet'`** deckt nur 16 von 63 → als
  Zugangsschalter unbrauchbar. Siehe Frage 2.

**Anker ist also die Telefonnummer, live aufgelöst, nichts gespeichert.**
JWT-Claim `phone` gegen `tel_key(fahrer.telefon)`. Das überlebt das Löschen und
Neuanlegen durch n8n, weil nie eine ID abgelegt wird.

### Die drei Wege im Vergleich

| | A) PIN wie bisher | B) Magic Link per E-Mail | **C) SMS-OTP** |
|---|---|---|---|
| Kosten | 0 | 0, aber eigener SMTP nötig | ~0,05–0,10 € je SMS, bei 52 Fahrern und 30-Tage-Session **≈ 5–10 €/Monat** |
| Aufwand je Fahrer | **Büro legt jeden Account an**, PIN übermitteln, PIN-Resets — bei wechselnder Besetzung Dauerarbeit | E-Mail-Kopplung über zwei Sprünge; `fahrer` hat gar keine E-Mail-Spalte | **Null.** Nummer in Notion = Zugang. Austritt = Nummer weg = nichts mehr sichtbar. |
| Handy / PWA | Session landet dort, wo getippt wird ✓ | Link öffnet in Safari statt in der Home-Screen-App → Session weg, Supportfall | Code wird in der App getippt ✓ |
| Missbrauch | 4 Ziffern, die Transformation steht im Quelltext, Benutzername = Name → der Kollege rät. Mindestens 6-stellig nötig. | gering | Besitz des Telefons. Risiko **SMS-Pumping** → **Cloudflare Turnstile** (Supabase unterstützt es nativ, die Seite läuft ohnehin auf Cloudflare) plus OTP-Rate-Limits. |

**Empfehlung: C.** Nichts zu merken, nichts zu verteilen, Onboarding und
Offboarding sind reine Notion-Pflege — und es ist dieselbe Nummer, über die der
Sync schon heute Bolt und Uber zuordnet. Einzige Voraussetzung: ein
SMS-Provider-Konto (Frage 1). Fällt das aus, bleibt A mit 6-stelligem PIN und
einer Admin-Edge-Function. Ausdrücklich zweite Wahl.

Einzustellen im Supabase-Dashboard, keine Migration nötig: Phone-Provider an,
SMS-Provider eintragen, OTP-Länge 6, **Ablauf hochsetzen** (Standard 60 s ist zu
kurz), Turnstile-Secret unter „Bot and Abuse Protection", Rate-Limits vor dem
Rollout-Tag prüfen. Der Client normalisiert die Eingabe nach E.164
(`0676…` → `+43676…`).

### Türsteher: Funktionen statt Policies auf den Basistabellen

Bewusst **keine** Fahrer-Policies auf `settlements`, `kassier_zahlungen` oder
`fahrer`. Drei Gründe:

1. Alle bestehenden Policies laufen über `is_app_user()`. Ein Phone-User hat
   kein `app_role`, sieht also auf allen Tabellen weiterhin nichts — **null Umbau
   am Bestehenden.**
2. Spaltenkontrolle: `kassier_zahlungen.note`, `fahrer.prozent_schwelle` und
   `settlements.status` sollen nicht nach draussen.
3. Genau **eine** Stelle, an der der Fahrer-Filter steht. Das Risiko „Fahrer
   sieht fremde Daten" hängt damit an einer Funktion statt an sechs Policies.

```sql
-- Wer bin ich? Bei Duplikaten: niemand, nicht irgendwer.
create or replace function public.mein_fahrer_id() returns integer
language sql stable security definer set search_path = public as $$
  select min(f.id) from public.fahrer f
  where f.aktiv and coalesce(f.telefon,'') <> ''
    and coalesce(auth.jwt()->>'phone','') <> ''
    and public.tel_key(f.telefon) = public.tel_key(auth.jwt()->>'phone')
  having count(*) = 1
$$;

create or replace function public.fahrer_app_abrechnungen()
returns table (woche text, bolt_brutto numeric, uber_fahrpreis numeric, mypos_summe numeric,
               bruttoumsatz_gesamt numeric, miete numeric, prozent_abzug numeric, abzug_gesamt numeric,
               korrektur numeric, korrektur_note text, lohn numeric, auszahlung numeric,
               kassiert numeric, freigegeben_am timestamptz)
language sql stable security definer set search_path = public as $$
  with f as (select id, name, public.tel_key(telefon) tel
             from public.fahrer where id = public.mein_fahrer_id())
  select s.woche, s.bolt_brutto, s.uber_fahrpreis, s.mypos_summe, s.bruttoumsatz_gesamt,
         s.miete, s.prozent_abzug, s.abzug_gesamt, s.korrektur, s.korrektur_note,
         s.lohn, s.auszahlung,
         coalesce((select sum(k.betrag) from public.kassier_zahlungen k
                   where k.fahrer_name = s.fahrer_name and k.woche = s.woche), 0),
         fr.freigegeben_am
  from public.settlements s
  join f on (public.tel_key(s.telefon) = f.tel or s.fahrer_name = f.name)
  join public.abrechnung_freigaben fr on fr.woche = s.woche
  where s.status = 'berechnet'
  order by s.woche desc
$$;

revoke all on function public.mein_fahrer_id(), public.fahrer_app_abrechnungen() from public, anon;
grant execute on function public.mein_fahrer_id(), public.fahrer_app_abrechnungen() to authenticated;
```

Dazu `fahrer_app_profil()` für Name, Telefon, Kennzeichen, Mietmodell und die
Fuhrpark-Daten über `fuhrpark.kennzeichen_key = kennzeichen_key(fahrer.kennzeichen)`.

**Das `having count(*) = 1` ist der Kern der Sache:** bei einer doppelt
vergebenen Nummer liefert die Funktion *niemanden* statt irgendwen. Genau dieser
Fall existiert heute einmal.

Optional für den Support: ein Parameter `p_fahrer_id`, der nur greift, wenn
`is_app_user()` — das Büro sieht dann exakt, was der Fahrer sieht. Ohne das wird
jede Rückfrage zum Telefonpingpong.

**Testen ohne Schreibzugriff**, drei Durchgänge — mit Fahrernummer, mit Büro-JWT
(muss leer bleiben), mit unbekannter Nummer (muss leer bleiben):

```sql
select set_config('request.jwt.claims','{"role":"authenticated","phone":"43676…"}',true);
set local role authenticated;
select * from fahrer_app_abrechnungen();
```

---

## 3. Auslieferung

**Ordner `/fahrer/` im bestehenden Repo, gleicher Cloudflare-Pages-Deploy.**
Ein `index.html` wie überall hier, eigenes `/fahrer/manifest.json`
(`scope: "/fahrer/"`), **kein eigener Service Worker** — der bestehende `sw.js`
deckt die Seite ab; `/fahrer/` in `PRECACHE_URLS` aufnehmen und `CACHE_NAME`
hochzählen.

Warum ein Unterordner und nicht `fahrer.html`: das Manifest braucht einen Scope,
der das Büro-Dashboard **nicht** einschliesst. Sonst landet der Fahrer nach „Zum
Home-Bildschirm" auf `/` — dem Büro-Login.

**Same-Origin-Folgen, das ist Pflicht und leicht zu übersehen:** Supabase hält
eine Session pro Origin. Heute schickt `index.html` *jede* Session zum
Dashboard, und der Guard dort prüft nur, ob überhaupt eine Session da ist. Also:

- `index.html` leitet nur bei `app_metadata.app_role` zum Dashboard, sonst nach `/fahrer/`
- Dashboard-Guard verlangt `app_role`, sonst `replace('/fahrer/')`
- `/fahrer/` verlangt den `phone`-Claim, sonst Login

Nebenwirkung: wer Büro-User **und** Fahrer ist, braucht zwei Browser oder Profile.

Mobil von Anfang an: eine Spalte, grosse Zahlen, keine Tabellen, drei Reiter
unten (Abrechnung / Offen / Ich), auf 390 px prüfen. Das ist die Lektion aus dem
Dashboard, die uns diese Woche schon einmal eingeholt hat.

---

## 4. Datenmodell

- **Keine neuen Lesetabellen, keine neuen Views.** Drei Funktionen:
  `mein_fahrer_id()`, `fahrer_app_profil()`, `fahrer_app_abrechnungen()`.
  Später `fahrer_app_fahrten(p_woche)`.
- **Eine neue Tabelle:**
  `abrechnung_freigaben (woche text primary key, freigegeben_am timestamptz default now(), freigegeben_von text)`.
  RLS an, `anon` nichts, `select`/`insert` für `is_app_user()`, `delete` für Admin.
  Dazu ein Knopf „KW freigeben" im Abrechnungen-Tab.
- Verworfene Alternativen: `settlements.telegram_gesendet` umdeuten (falscher
  Name, und der Bot könnte es setzen); `status` auf `'freigegeben'` setzen (rührt
  an die Statussemantik des Bots und der Filter).
- Nichts in Notion. Keine Zuordnungstabelle Auth↔Fahrer — **der Auth-User *ist*
  die Nummer.**

---

## 5. Erster Schritt

Login per SMS, dann eine einzige Seite: Kopf mit Name und Kennzeichen, Karte
„Abrechnung KW38 · Auszahlung X €" zum Aufklappen (Brutto, Netto, Abzüge,
Korrektur, Lohn — exakt der Zettel), darunter die früheren freigegebenen Wochen
mit „offen X €", unten die Büro-Kontaktzeile. Sonst nichts.

**Reihenfolge:**

0. **Betreiber:** SMS-Provider-Konto; Turnstile-Widget in Cloudflare anlegen;
   Notion bereinigen (Dombaew-Duplikat, fehlende Nummern).
1. Supabase-Dashboard: Phone-Provider, SMS-Provider, OTP-Ablauf, Turnstile, Rate-Limits.
2. Migration (drei Funktionen + `abrechnung_freigaben`), Lesetests wie oben.
3. `/fahrer/index.html`, `/fahrer/manifest.json`, `sw.js`-Precache, Guards in
   `index.html` und `dashboard.html`.
4. Abrechnungen-Tab: „KW freigeben" und Anzeige „freigegeben am".
5. Pilot mit 3–5 Fahrern über eine Woche, dann Link per WhatsApp an alle.

**Phase 2:** Mein Auto, plus im Fahrer-Tab ein Hinweis „App: Nummer eindeutig /
fehlt / doppelt".
**Phase 3:** laufende Woche, nur Bolt, täglicher `pg_cron`; Rückmeldung „Auto
stimmt nicht" — das wäre der erste Schreibpfad, eigene Tabelle mit
`insert`-Policy auf `mein_fahrer_id()`.

---

## 6. Risiken

**Fahrer sieht fremde Daten**

- Doppelte Nummer → `having count(*) = 1` liefert niemanden. Heute ein Fall.
- **Falsche Nummer in Notion** → der andere sieht dessen Abrechnung. Damit wird
  die Notion-Telefonpflege sicherheitsrelevant. Das ist der ernsteste Punkt der
  ganzen Liste.
- Büro-User haben die Rolle `authenticated`; die Funktionen liefern für sie leer.
  Muss getestet werden, nicht angenommen.
- SMS-Pumping ohne Turnstile: kostet Geld, leakt aber nichts.

**Fahrer sieht eine Zahl, die von seiner Abrechnung abweicht**

Ursachen: `lohn` und `korrektur` werden nach dem Bot-Lauf geändert;
Sonderwochen wie `2026-W37k`; Ubers Nachkorrekturen; die vermutete
Wochenverschiebung der Bolt-Zahlen bis KW36.

Gegenmittel: **nur freigegebene Wochen**, Start frühestens KW37, Zeile
„freigegeben am …", **eine** Zahl als Auszahlung, **keine** Plattform-Livezahlen
in v1, und Schulden nur aus freigegebenen Wochen — nie die Altlasten.

**Support-Aufwand im Büro**

- SMS kommt nicht an: Nummer in Notion nicht E.164-fähig, oder Rate-Limit am Rollout-Tag.
- „Warum steht KW38 nicht drin?" → Freigabe-Status im Abrechnungen-Tab sichtbar machen.
- Nummernwechsel: die alte Session läuft weiter, der `phone`-Claim bleibt alt →
  nach der Notion-Änderung ist die Ansicht leer, der Fahrer muss sich neu anmelden.
  Gehört in der App erklärt.
- Same-Origin: wer Büro-Person und Fahrer ist, sieht mit Fahrersession ein leeres
  Dashboard. Die Guards fangen das ab, erklären muss man es trotzdem.

---

## 7. Offene Fragen an den Betreiber

Die ersten drei blockieren alles Weitere.

1. **SMS-Provider** (Twilio, MessageBird, Vonage): anlegen — ja oder nein? Wer
   verwaltet und zahlt? Bei nein: Fallback auf 6-stelligen PIN mit
   Admin-Edge-Function, ausdrücklich zweite Wahl.
2. **Ab welcher Woche** dürfen Fahrer zurückschauen? Vorschlag **KW37**. Davor
   liegt die vermutete Wochenverschiebung, und in den Schulden stecken
   339.395,97 € aus der Zeit vor KW27, die nie erscheinen dürfen.
3. **Wer darf freigeben** — jeder Büro-User oder nur Admin? Und soll ein erneuter
   CSV-Import derselben Woche die Freigabe aufheben?
4. **`notion_fahrer.status`:** „Angemeldet" deckt nur 16 von 63. Was bedeutet der
   Status wirklich, und soll er den App-Zugang steuern?
5. **Sichtbare Felder:** `korrektur_note` und `lohn` stehen heute auf dem Zettel
   — in der App zeigen? (Annahme: ja.) `kassier_zahlungen.note`: Vorschlag nein.
6. **Adresse:** reicht `hydrafleet.pages.dev/fahrer/`, oder eigene Domain wie
   `fahrer.hydrafleet.at`? Letzteres macht das ganze Pages-Projekt inklusive
   Dashboard darunter erreichbar.
7. **Notion-Bereinigung** vor dem Pilot: Dombaew-Duplikat, fehlende Nummern bei
   Murad Izrailov und Alik Selmurzaev.
8. **Phase 3:** Bolt-Sync täglich gewünscht? Ist ein API-Kontingent bei Bolt bekannt?
9. **Pilotfahrer:** wer? Mit dem Hinweis auf zwei Browser wegen Same-Origin-Session.

---

## Dateien, die beim Bauen angefasst werden

| Datei | Wofür |
|---|---|
| `index.html` | Login-Fluss und `checkSession`: nur bei `app_role` zum Dashboard, sonst nach `/fahrer/` |
| `dashboard.html` | Auth-Guard; `getOpenDebts()`, `detailHtml`/`printDriver`/`netAuszahlung` als Vorlage für den Fahrerzettel; Freigabe-Knopf im Abrechnungen-Tab; Design-Tokens |
| `migrations/2026-09-22-notion-sync.sql` | `tel_key()`, `name_key()` und das RLS-Muster `is_app_user()`, auf denen `mein_fahrer_id()` aufsetzt |
| `migrations/2026-05-22-kassier-admin-delete-rpc.sql` | bestehendes Muster für `security definer`-RPC mit Grants und Revokes |
| `sw.js`, `manifest.json` | Precache und Scope; Vorlage für `/fahrer/manifest.json` |
