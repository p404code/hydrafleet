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
2. **Müssen zahlen** (Kassieren) — wochenübergreifende Schulden (`settlements.auszahlung < 0`), Zahlungen in `kassier_zahlungen`, "offen" wird live gerechnet. Nur anlegen + löschen, kein Update.
3. **Fahrer** — Fahrer aus Notion neben ihren Bolt- und Uber-Konten (`fahrer_uebersicht`). Zeigt nicht zugeordnete Plattform-Konten.
4. **Fuhrpark** — Fahrzeuge aus Notion, Bolt und Uber nebeneinander (`fuhrpark_uebersicht`), inkl. Fahrer-Zuordnung je Quelle und Konfliktmarkierung.
5. **Verbindungen** — Statusseite der API-Zugänge (`verbindungen_status`): letzter Lauf, Fehler, abgelaufene Sitzungen.
6. **CSV Upload** (AbrBot) — Bolt/Uber/myPOS-CSVs je Woche an n8n. **Bleibt als Notfallweg, nie entfernen.**
7. **Rechnungen** — Rechnungserstellung und Archiv, fortlaufende Nummer (HF-YYYY-NNNN), PDF in Supabase Storage.

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

Jeder Lauf schreibt eine Zeile nach `sync_runs`.

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

**Die Uber-Sitzung läuft ab** (Stand 2026-09-22: gültig bis 2026-10-06). Danach
schreibt `uber-sync` `sitzung_abgelaufen:` in `verbindungen.letzter_fehler`, der
Verbindungen-Tab zeigt es an. Erneuern mit dem Skript oben.

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

**Views (alle `security_invoker = true`):**
`bolt_abgleich`, `fahrer_uebersicht`, `fuhrpark_uebersicht`, `zuordnung_abgleich`, `verbindungen_status`

**Funktionen:** `verbindung_zugang`, `verbindung_setzen`, `kennzeichen_key`,
`tel_key`, `name_key`, `fuhrpark_ersetzen`, `notion_zuordnung_aktualisieren`, `sync_takt`

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
  Das Fenster wird bei Uber erfragt (`GetReportingTimeWindows`), nie gerechnet.
- **CSV braucht einen echten RFC-4180-Parser.** Ein Fahrername wie "Ahmed Safa, Beng"
  hat am 14.09. einen ganzen Import zerlegt.
- **Notion-Feld `"Pauschale "` hat ein Leerzeichen am Ende.** Nicht wegkürzen.
- **Notion API**: Datenbanken sind seit Version 2025-09-03 in Datenquellen geteilt.
  `/v1/databases/{id}/query` ist abgekündigt → `/v1/data_sources/{id}/query`.
- **FKs auf `fahrer(id)` brauchen `ON DELETE SET NULL`**, sonst scheitert der
  bestehende n8n-Sync beim Löschen eines Fahrers.
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
