# HYDRAFLEET / HYDRAlink Dashboard

## What is this?

HYDRAlink is the internal web dashboard for **HYDRAFLEET**, a taxi/ride-sharing fleet (~57 vehicles, ~52 drivers) operating on Bolt, Uber, and MyPOS in Austria. The dashboard handles driver settlements, invoice management, CSV upload processing — and since 2026-09-22 it also mirrors Bolt, Uber and Notion directly via their APIs.

## Tech Stack

- **Frontend**: Single-page HTML/JS app (no framework, vanilla JS)
- **Database**: Supabase (project: `pkxcwfkfaaorwnbdmylg.supabase.co`)
- **Hosting**: Cloudflare Pages — Dashboard läuft auf `hydrafleet.pages.dev` (`hydrafleet.at` ist eine andere Seite, NICHT das Dashboard)
- **Automation**: n8n (self-hosted on Hetzner) — CSV processing, invoice PDF generation, Notion→`fahrer` sync
- **Plattform-Sync**: Supabase Edge Functions (Deno) + `pg_cron`/`pg_net` — Bolt, Uber, Notion
- **Driver/Vehicle master data**: Notion (source of truth — never replace)
- **Notifications**: Telegram (implemented but currently deactivated)
- **Fonts**: Fraunces (logo), Inter (UI)
- **Branding**: "HYDRA" bold + "link" in gold (#F5B51B), dark theme default

## Repo Structure

```
index.html            — Login page (PIN-based auth via app_users table)
dashboard.html        — Main dashboard, Redesign v2 seit 2026-09-11
dashboard-alt.html    — vorherige Version, Rueckfall, nicht verlinkt
migrations/           — SQL, chronologisch benannt; von Hand/MCP angewendet
supabase/functions/   — Edge Functions (Deno). MUSS mit dem Deployten uebereinstimmen.
scripts/              — Hilfsskripte (Syntax-Check, Zugangs-Skripte, Uber-Capture)
docs/                 — Specs, Incidents, Protokolle
setup.sql             — Supabase schema for app_users + customers tables
manifest.json / sw.js — PWA
```

## Dashboard Tabs

Das Dashboard (`dashboard.html`) hat **7 Tabs**. Auf Mobil ersetzt ein Burger-Menü
die Tab-Leiste; Tabellen werden dort zu 3 Spalten + aufklappbarer `detail-row`.

1. **Abrechnungen** — Wochenabrechnung je Fahrer aus `settlements`. Filter Woche/Fahrer/Status, Druck/WhatsApp.
   Darüber der **Plattform-Abgleich** (`abrechnung_abgleich`): was Bolt und Uber für die Woche
   melden, neben dem was abgerechnet wurde. Fahrer mit Abweichung bekommen ein `≠`.
2. **Müssen zahlen** (Kassieren) — wochenübergreifende Schulden (`settlements.auszahlung < 0`), Zahlungen in `kassier_zahlungen`, "offen" wird live gerechnet. Nur anlegen + löschen, kein Update.
3. **Fahrer** — Fahrer aus Notion neben ihren Bolt- und Uber-Konten (`fahrer_uebersicht`). Zeigt nicht zugeordnete Plattform-Konten.
4. **Fuhrpark** — Fahrzeuge aus Notion, Bolt und Uber nebeneinander (`fuhrpark_uebersicht`), inkl. Fahrer-Zuordnung je Quelle und Konfliktmarkierung.
5. **Verbindungen** — Statusseite der API-Zugänge (`verbindungen_status`): letzter Lauf, Fehler, abgelaufene Sitzungen.
6. **CSV Upload** (AbrBot) — Bolt/Uber/myPOS-CSVs je Woche an n8n. **Bleibt als Notfallweg, nie entfernen.**
7. **Rechnungen** — Rechnungserstellung und Archiv, fortlaufende Nummer (HF-YYYY-NNNN), PDF in Supabase Storage.

**Kopfleiste seit 2026-10-03:** Abrechnung (Übersicht, Upload, Kassieren, Kassabuch, Löhne) · Fahrer (App, Post) ·
Rechnungen · **Experimentell** (API-Abrechnung, Fuhrpark, Verbindungen — funktionieren noch nicht verlässlich,
bewusst abgestellt). **Löhne** ist ein Reiter (`contentLohn`, JS in der Hülle `Lohn`, IDs/Klassen `lo…`);
`lohn.html` leitet nur noch weiter.

**Zu-/Abschläge (seit 2026-10-03):** Posten je Fahrer und Woche in `abrechnung_posten` („Pickerl selbst
bezahlt +70“), Eingabe im Seitenpanel der Abrechnung. Geschrieben wird nur über `posten_anlegen` /
`posten_loeschen`; die Summe landet in `settlements.korrektur` (+ Notiz) und steckt in `auszahlung`.
Rechnet der AbrechnungsBot die Woche neu, fällt sie heraus: `abrechnung_posten_offen` zeigt das, das
Dashboard bietet „Wieder einrechnen“ (`posten_neu_anwenden`). `korrektur` nie von Hand setzen.

**Kassabuch (seit 2026-10-03):** Reiter Abrechnung → Kassabuch (`contentKassabuch`, Hülle `Kassa`, Präfix `kb`).
Eine Bargeldkassa in `kassabuch`, geführt **je Kalenderwoche** wie die Abrechnung (ISO-Woche `JJJJ-Wnn`):
`anfang` (genau einmal), `ein`, `aus`. Hängt bewusst nicht an Kassieren. Absicherung – nicht aufweichen:
- **Wer** (`name`) ist immer der angemeldete Benutzer (`app_metadata.app_name`), nie ein Eingabefeld.
- Schreiben nur über `kassa_buchen` / `kassa_storno` / `kassa_anfang` / `kassa_abschliessen`.
  UPDATE, DELETE, TRUNCATE sperrt ein Trigger (`kassa_gesperrt`) – auch im SQL-Fenster. Storno = Gegenbuchung.
- Jede Buchung trägt `nr` (lückenlos) und `pruefsumme` (sha256 inkl. der Summe davor). `kassa_pruefen()` rechnet
  die Kette und die Abschlüsse nach; das Dashboard zeigt „Unverändert“ bzw. die erste auffällige Nummer.
- **Wochenabschluss** (`kassa_abschluss`): hält Anfangsbestand/Übertrag, Einnahmen, Ausgaben, Endbestand und den
  gezählten Betrag samt Differenz fest. Erst ab Sonntag der Woche, Wochen der Reihe nach. Danach nimmt die Woche
  keine Buchung mehr an; der Endbestand ist der Übertrag in die nächste KW.

- **Anfangsbestand korrigieren** (`kassa_anfang_korrigieren`): eigene Zeile `quelle = 'anfang'` am Tag des
  Anfangsbestands, zählt zum Anfangsbestand statt zu Ein/Aus. Nur solange noch keine Woche abgeschlossen ist.
- **Abrechnung → Kassabuch:** „Unterm Strich“ (Σ `auszahlung − lohn` der `berechnet`-Zeilen, ohne `__…` und ohne
  `WARNUNG_KEIN_FAHRER`) wird bar ausgezahlt. Knopf „Ins Kassabuch übernehmen“ im Kassabuch (`kassa_abrechnung_buchen`):
  eine Zeile Abrechnung ohne Zu-/Abschläge + je Zu-/Abschlag eine Zeile (Zuschlag = Ausgabe). Spätere Änderungen
  kommen als Zeile „Änderung“ (Differenz). Ist die Woche übernommen, bucht `posten_anlegen` sofort mit und
  `posten_loeschen` storniert. Diese Zeilen (`quelle` ≠ `hand`) lassen sich nicht von Hand stornieren.
  Kassieren (`kassier_zahlungen`) fließt bewusst NICHT ins Kassabuch. `kassa_summe` nie ändern – es gibt Buchungen.

## Plattform-Sync (seit 2026-09-22)

Grundsatz: **HYDRAlink ist der Spiegel.** Die Syncs schreiben ausschliesslich in
eigene Tabellen. `settlements`, `fahrer` und der AbrechnungsBot bleiben unberührt —
Geld entscheidet weiterhin das alte System.

### Edge Functions

| Function | Quelle | Schreibt nach |
|---|---|---|
| `bolt-sync` | Bolt Fleet Integration API (OIDC client_credentials) | `bolt_orders`, `bolt_drivers`, `bolt_vehicles` |
| `uber-sync` | Uber Fleet-Portal (gespeicherte Sitzung, 3 Berichte) | `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips` |
| `notion-sync` | Notion API (`/v1/data_sources/{id}/query`) | `fuhrpark`, `notion_fahrer`, setzt `fahrer.notion_fahrer_id` wo leer |
| `post-eingang` | PDF vom USP-Skript oder Upload, Claude-Auslese | `post_eingang`, Storage `post` |
| `post-senden` | SMTP Gmail (`sw.hydrafleet@gmail.com`, App-Passwort) | `post_ausgang`, Status in `post_eingang` |

Jeder Lauf schreibt eine Zeile nach `sync_runs`.

**Aufrufschutz (seit 2026-09-28):** Die drei Syncs nehmen nur den service_role-Key
(Zeitplan) oder Buero-User (`app_metadata.app_role` admin/user) an, sonst 403 —
der anon-Key steht im Frontend und ist ein gueltiges JWT. Die Rolle wird aus dem
Token gelesen, die Signatur prueft das Gateway: `verify_jwt` NIE abschalten.
`uber-probe` ist stillgelegt (410) und kann im Supabase-Dashboard geloescht werden.

### Zeitplan (`pg_cron`)

```
*/10 * * * *   notion-sync-laufend        Notion-Aenderungen binnen ~10 Min sichtbar
0 4 * * 1      bolt-sync-woechentlich     Montag 04:00
0 5 * * 1      uber-sync-woechentlich     Montag 05:00 (nach Bolt)
20 2 * * *     sync-runs-aufraeumen       reines SQL, alte Laeufe loeschen
```

### Zugangsdaten

Ausschliesslich im **Supabase Vault**. Nie im Code, nie im Klartext in Tabellen,
nie im Frontend. `verbindungen` speichert nur Metadaten (Anbieter, Firma,
`externe_id`, Status, letzter Fehler) und den Vault-Verweis.

- Lesen: `verbindung_zugang(p_verbindung_id)` — nur `service_role`
- Setzen: `verbindung_setzen(...)` — legt/ersetzt das Vault-Secret
- Uber-Sitzung erneuern: `node scripts/uber-session-speichern.js`
  (liest die Cookies per CDP aus dem laufenden Browser und schreibt sie direkt in
  den Vault — die Cookies landen nie auf der Platte)
- Notion-Token setzen: `node scripts/notion-token-speichern.js`

**Zwei Uber-Verbindungen** seit 2026-09-28: `eh_limousinenservice_kg` (Org `08fc2f53-…`)
und `ee_taxi_kg` (E&E Taxi KG, Org `c566f3b3-…`, eigener Login, Browser-Profil
`~/.hydrafleet-uber-profile-ee`). Die Fahrer sind am 25.09. von EH zu E&E gewechselt.

**Die Uber-Sitzungen laufen ab** (EH: gültig bis 2026-10-06; E&E: gesetzt 2026-09-28). Danach
schreibt `uber-sync` `sitzung_abgelaufen:` in `verbindungen.letzter_fehler`, der
Verbindungen-Tab zeigt es an. Erneuern mit dem Skript oben.

## Post & Strafen (seit 2026-09-28)

Behördenpost an **Hydrafleet KG** (USP „Mein Postkorb“) landet zusätzlich zu Telegram in
HYDRAlink. Spec: `docs/superpowers/specs/2026-09-28-post-strafen-design.md`, Plan:
`docs/superpowers/plans/2026-09-28-post-strafen.md`.

- **Eingang:** `/root/usp-bot.sh` auf `taxi` (stündlich) schickt jedes PDF zusätzlich an die
  Edge Function `post-eingang` (Header `x-post-key` aus `/root/.post-eingang-key`, Vault-Anbieter
  `usp`). Telegram und `CloseDelivery` laufen auch, wenn HYDRAlink nicht antwortet. Repo-Kopie
  ohne Token: `scripts/server/usp-bot.sh`.
- **Auslesen:** Claude (`claude-sonnet-5`, Key im Vault, Anbieter `anthropic`) liest Art, GZ,
  Kennzeichen, Tatzeit, Betrag, Frist, Antwortadresse. Reine Logik und Prüfregeln in
  `supabase/functions/_shared/post-logik.ts` (Tests: `node --test scripts/test-post-logik.mjs`).
  Lenkererhebung ohne Datum: Frist = Zustellung + 14 Tage.
- **Lenkererhebung beantworten:** `post-senden` schickt per SMTP (`smtp.gmail.com:465`, App-Passwort im Vault, Anbieter `gmail`) von `sw.hydrafleet@gmail.com`
  „vermietet an <Mieter zur Tatzeit>“ — nur per Knopf im Dashboard-Reiter **Fahrer → Post** (`contentPost`, JS-Präfix `ps`; `post.html` leitet nur noch dorthin). Mieter der ganzen Flotte
  stehen in `mietverhaeltnisse` (Wiener Datum der Tatzeit, bis inklusive; im Post-Reiter → Mieter
  pflegen, Knopf „Mieter“ im Post-Reiter). Nie zweimal je GZ: Reservierung in `post_ausgang` vor dem Versand + Unique-Index `post_ausgang_gz_einmal`. Alte Handantworten wurden am 30.09. einmalig aus Gmail abgeglichen (`quelle='gmail_abgleich'`).
- **Strafen:** Fahrer-Vorschlag über Kennzeichen (`post_fahrer_vorschlag`), Büro bestätigt und
  gibt frei (`post_freigeben`) → Fahrerapp „Mehr → Strafen“ (`fahrer_app_strafen`, Bucket `post`,
  Policy `post_pfad_erlaubt`).
- **Rückstand / Nachholen:** Das USP hebt abgeschlossene Zustellungen noch eine Zeit auf.
  `/root/usp-rueckstand.sh --liste | --eine <ID> | --alle` holt sie (nur die laut Log
  abgeschlossenen) und schickt sie an `post-eingang`; Doppelte erkennt der sha256.
- **USP-Proxy** (`/root/usp-proxy.js`, systemd `usp-proxy`) lauscht seit 28.09. nur auf
  `127.0.0.1:9999` — vorher war er offen im Internet. Nie wieder auf `0.0.0.0`.
- **Zugänge einrichten:** `scripts/post-zugaenge-einrichten.js` (USP-Schlüssel + Anthropic,
  `pbpaste | … --nur-anthropic`, `… --nur-gmail` für das Gmail-App-Passwort). `scripts/gmail-zugang-speichern.js` (Google-OAuth) ist nicht mehr in Gebrauch.

## Key Supabase Tables

**Bestehend (altes System, nicht anfassen):**
- `settlements` — Processed driver settlement data per week
- `fahrer` — Driver records (synced from Notion **via n8n**)
- `rechnungen`, `companies`, `customers`, `app_users`, `kassier_zahlungen`

**Neu (Plattform-Spiegel, alle mit RLS, `anon` ohne Rechte):**
- `verbindungen`, `sync_runs` — Zugänge und Laufprotokoll
- `bolt_orders`, `bolt_drivers`, `bolt_vehicles`, `bolt_state_logs`
- `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips`
- `fuhrpark`, `notion_fahrer` — Notion-Lesekopien

**Post & Strafen:** `post_eingang`, `post_ausgang`, `mietverhaeltnisse` (RLS: Büro liest, Fahrer nur über `fahrer_app_strafen`)

**Views (alle `security_invoker = true`):**
`abrechnung_abgleich`, `bolt_abgleich`, `fahrer_uebersicht`, `fuhrpark_uebersicht`, `zuordnung_abgleich`, `verbindungen_status`

**Funktionen:** `verbindung_zugang`, `verbindung_setzen`, `kennzeichen_key`,
`tel_key`, `name_key`, `fuhrpark_ersetzen`, `notion_zuordnung_aktualisieren`,
`settlement_fahrer`, `sync_takt`

## Key n8n Workflows

- **AbrechnungsBot** (`RTeVugetfAjSTPQs`) — CSV settlement processing
- **Fahrer-Sync** (`ERBnlIVSkteL90Bg`) — Notion → Supabase `fahrer` via webhook
- **Full-Sync** (`bCyUwmFeuoG762yC`) — Full Notion → Supabase sync
- **Webhook endpoints:**
  - Dashboard → n8n: `https://n8n.hydrafleet.at/webhook/abrechnung-upload` + `/webhook/invoice`
  - Notion → n8n (fahrer-sync): `https://webhook.hydrafleet.at/webhook/fahrer-sync`

Hinweis: im n8n-MCP sind nur die Workflows sichtbar, bei denen "Available in MCP"
aktiviert ist — aktuell zwei.

## Important Patterns & Gotchas

### Code Style
- Everything is in a single HTML file per page (no build step, no bundler)
- CSS variables for theming (light/dark via `data-theme` attribute; hell = Attribut entfernt)
- Supabase JS client loaded via CDN, initialized lazily
- All German UI labels

### Known Pitfalls
- **Ein Fahrer hat pro Bolt-Firma eine eigene Driver-UUID.** Deshalb gibt es kein
  `fahrer.bolt_driver_uuid`, sondern `bolt_drivers.fahrer_id` (viele Konten → ein Fahrer).
  Gleiches Muster bei `uber_drivers.fahrer_id`.
- **Bolt-Zeitfilter**: `time_range_filter_type: "price_review"`, nicht `created`.
  Mit `created` streuen die Werte über Wochengrenzen.
- **PostgREST antwortet bei `return=minimal` mit 201 und leerem Body**, nicht 204.
  Immer erst `await r.text()`, dann nur parsen wenn nicht leer.
- **Ubers Abrechnungswoche beginnt Montag ~04:00 Wien**, nicht Mitternacht UTC.
  Ubers Fenster (`GetReportingTimeWindows`) sind **Auszahlungszeiträume, keine Wochen**:
  eine Auszahlung mitten in der Woche teilt sie (KW39: EH 14.09.–25.09. 10:48). Ihre
  Grenzen liefern nur die genaue Uhrzeit des Montagswechsels (±12 h), sonst wird
  Montag 04:00 Wien gerechnet. Kontrolle: `node scripts/uber-sync-aufrufen.js <JJJJ-Wnn> test`
  zeigt Fenster und Ubers Rohfenster, ohne Daten zu schreiben.
- **Uber benennt Berichtsspalten um.** Seit KW40/2026 heißt „An dein Unternehmen gezahlt …“ im Bericht
  „An dich gezahlt …“. Der AbrechnungsBot kennt nur die alte Schreibweise → Uber war in KW40 überall 0.
  Der Upload im Dashboard benennt deshalb die Kopfzeile zurück (`uberKopfAngleichen`). **Offen:** `uber-sync`
  liest ebenfalls nur die alten Namen (`P` in index.ts) – `uber_reports` KW40 hat leere Beträge, `roh` stimmt.
- **CSV braucht einen echten RFC-4180-Parser.** Ein Fahrername wie "Ahmed Safa, Beng"
  hat am 14.09. einen ganzen Import zerlegt.
- **Notion-Feld `"Pauschale "` hat ein Leerzeichen am Ende.** Nicht wegkürzen.
- **Notion API**: Datenbanken sind seit Version 2025-09-03 in Datenquellen geteilt.
  `/v1/databases/{id}/query` ist abgekündigt → `/v1/data_sources/{id}/query`.
- **FKs auf `fahrer(id)` brauchen `ON DELETE SET NULL`**, sonst scheitert der
  bestehende n8n-Sync beim Löschen eines Fahrers.
- **Fehlende Daten sind keine Abweichung.** Wird eine Plattform für eine Woche nicht
  gesynct, darf der Abgleich das nicht als Fehlbetrag zeigen — `abrechnung_abgleich`
  prüft deshalb je Woche, ob die Plattform überhaupt Daten hat.
- **Eine Summe kann auf beiden Seiten dieselbe Lücke haben und trotzdem stimmen.**
  Ein nicht zugeordnetes Plattformkonto fehlt sowohl in der API-Summe als auch in der
  Abrechnung. Deshalb zählt `abrechnung_abgleich` Konten ohne Fahrer ausdrücklich mit.
- **Die Uber-Sammelzeile der Organisation** (`uber_reports.umsaetze is null`, in KW38
  −35.556,55 €) ist kein Fahrer und darf nie mitsummiert werden — dasselbe Muster wie
  `__TRANSFER__` in `settlements`.
- **Mobile**: Flex-Items haben `min-width: auto` — 7 Tab-Buttons sprengen 390px.
  Deshalb Burger-Menü. Jede neue Tab-Leiste am Handy prüfen.
- **Dark Mode / Kennzeichen**: `.fz-main b` hat dieselbe Spezifität wie `.kz b`,
  steht aber später im Stylesheet. Darum `span.kz b`. Kommentar im Code nicht entfernen.
- **Duplicate form field names** create arrays instead of strings → sanitize form payloads
- **Fuzzy name matching** (threshold 0.92) im AbrechnungsBot: "unbekannt"-Fehler durch
  Angleichen der Notion-Namen lösen, nicht durch ein Alias-System.
- **JSON in HTML**: Escape `<` und `>` als Unicode-Escapes
- **n8n API updates**: Only `name`, `nodes`, `connections`, `settings`
- **Supabase anon key** is in the frontend (public, RLS-protected) — intentional

### Design Principles
- **Keep it simple** — no overengineering. Always offer the simpler path first.
- **Notion bleibt Stammdaten** (Fahrer, Fuhrpark), **Supabase nur Transaktionen.** Nicht zusammenlegen.
- **Jeder importierte Datensatz trägt die ID des Anbieters als Unique-Key** → Upsert,
  doppelter Import unmöglich.
- **Keine Daten erfinden** (IDs, Endpunkte, Feldnamen). Wenn etwas fehlt: fragen.
- **Iterate fast** — working solutions over lengthy planning

## Deployment

Push to `main` branch → Cloudflare Pages auto-deploys (nur das Frontend).

```bash
git add .
git commit -m "description"
git push origin main
```

Edge Functions und SQL werden **nicht** vom Push deployt — die laufen über den
Supabase-MCP bzw. die CLI. Nach jeder Änderung an einer Function: Repo-Datei und
deployte Fassung wieder angleichen.

## External Services

| Service | Purpose | Access |
|---------|---------|--------|
| Supabase | Database + storage + Edge Functions | `pkxcwfkfaaorwnbdmylg.supabase.co` |
| n8n | Workflow automation | Self-hosted on Hetzner (Docker) |
| Notion | Driver/vehicle master data | Fuhrpark DB, Fahrer DB |
| Bolt | Fleet Integration API | 2 Firmen: EH Limo (262554), Serdo (182009) |
| Uber | Fleet-Portal (Sitzung) | `fleethub.uber.com` |
| Cloudflare Pages | Static hosting | Auto-deploy from GitHub |
| Nginx Proxy Manager | SSL for webhooks | `webhook.hydrafleet.at` |
| Telegram | Driver notifications | Implemented, currently deactivated |
