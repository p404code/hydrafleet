# Bolt-Flotte (Fleet API v2) – Design

Stand 31.10.2026. Im Gespräch mit dem Betreiber abgestimmt: Weg A (eigener stündlicher Abruf),
Meldungen **nur im Dashboard**, als **eigene schlanke Liste** (der Fuhrpark-Reiter bleibt, wie er ist).

## Ziel

Bolt hat eine neue **Fleet API v2** (`https://node.bolt.eu/fleet-integration-gateway-v2/fleetIntegration/v2/…`,
Doku developer.bolt.eu → Fleet API; die OpenAPI-Datei liegt unter
`developer.bolt.eu/versions/<ver>/docs/fleet-integration/main.yaml`). Sie liefert zu Fahrzeugen und Fahrern
deutlich mehr als v1. Daraus wird **eine Liste im Dashboard, die zeigt, wo Bolt und HYDRAlink sich widersprechen**:

1. **Fahrer↔Auto** – welches Auto ein Fahrer laut Bolt gerade gewählt hat, gegen unsere Zuordnung
   (`fahrer.kennzeichen` aus Notion). Anlass: Pavel Paunov fuhr ab 26.10. W 204TX, `fahrer` wusste nichts davon.
2. **Fuhrpark** – Bolt-Autos, die im Fuhrpark fehlen, Fuhrpark-Autos, die bei Bolt nicht aktiv sind, FIN-Abweichungen.
3. **Sperren** – aktuelle und angekündigte Bolt-Sperren von Fahrern und Autos.

Die Liste zeigt nur an. Korrigiert wird wie bisher in Notion bzw. im Bolt-Portal.

## Was v2 liefert (Probe 31.10.2026, nur Serdo)

`scripts/bolt-v2-probe.js`, nur lesend:

| | Ergebnis |
|---|---|
| Zugang | Die v1-Zugangsdaten gelten für v2 **nicht** (`498811 FLEET_API_AUTHENTICATION_FAILED`). Neue v2-Zugangsdaten vom Betreiber: nur **Serdo (182009)**. |
| `getVehicles` | 64 Autos (60 aktiv, 4 deaktiviert). FIN 53, Marke 64, `added_to_fleet` 64, `deactivated_since` 1, Kategorien 64 (Bolt/Pet 64, XL 24, Comfort 5). **Konzessionsnummer 0.** Sperren 0 (aktuell und angekündigt). |
| `drivers_with_selected_vehicle` | bei 46 Autos befüllt, 3 Autos mit mehr als einem Fahrer |
| `getDrivers` | 55 Fahrer (49 aktiv, 1 gesperrt, 5 deaktiviert), 54 mit gewähltem Auto (`vehicles.selected`). 1 Sperre (Kategorie `fraud`, `unusual_trip_activity`, seit 31.03.2026, offen). |
| IDs | Fahrzeug-UUIDs sind dieselben wie in v1 (`bolt_vehicles.uuid`) → die bestehende Fahrer-Zuordnung `bolt_drivers.fahrer_id` gilt weiter. |

v2 hat **kein** `ride_price`, `net_earnings`, `commission` und keinen Zeitfilter `price_review`.
Deshalb bleibt die Abrechnung auf v1 (`bolt-sync`), und dieses Vorhaben fasst `bolt-sync` nicht an.

## Nicht in diesem Schritt

EH-Bolt (kein v2-Zugang, Konto seit 14.10. ohne Aufträge) · Telegram-Meldungen · Bearbeiten oder Zurückschreiben
nach Notion/Bolt · Konzessionsnummer (Bolt liefert sie nicht) · `getOnlineDrivers` (Live-Status/Karte) ·
Umstellung von `bolt-sync` auf v2 · Änderungen am Fuhrpark-Reiter · Anzeige in der Fahrerapp.

## Teil 1 – Abruf

### Zugang

- `verbindungen` bekommt eine Zeile **Anbieter `bolt_v2`, Firma `serdo`**, `externe_id` `182009`.
  Der Check auf `verbindungen.anbieter` wird um `bolt_v2` erweitert (die Liste live vor der Migration auslesen,
  sie wurde seit 22.09. schon erweitert).
- Secret `{"client_id": …, "client_secret": …}` im Vault über `verbindung_setzen`.
- Eintragen mit **`scripts/bolt-v2-zugang-speichern.mjs`**, das der Betreiber selbst startet:
  `pbpaste | node scripts/bolt-v2-zugang-speichern.mjs`. Es liest „Client-ID Secret“ aus der Zwischenablage
  (getrennt durch Leerzeichen, Zeilenumbruch oder ` - `), testet mit Token + `getCompanies`, ob die Firma 182009
  dabei ist, und schreibt erst dann in den Vault. Ausgegeben werden nur Firma und Ergebnis, nie die Zugangsdaten.
  Den service_role-Key holt es wie `uber-sync-aufrufen.js`.
- Hinweis an den Betreiber: Das Secret stand am 31.10. im Klartext im Chat. Nach dem Eintragen kann er es im
  Bolt-Portal neu erzeugen und mit demselben Skript ersetzen. Das ist optional, er entscheidet.

### Edge Function `bolt-flotte`

- Läuft über alle `verbindungen` mit `anbieter = 'bolt_v2'` und `status = 'aktiv'`.
- Je Verbindung: Token (`oidc.bolt.eu/token`, `scope=fleet-integration:api`, pro Lauf frisch, nie gespeichert),
  `getCompanies`, dann je Firma `getVehicles` und `getDrivers` seitenweise (`limit` 1000, `offset`).
- Bolt-Fehler kommen als HTTP 200 mit `code != 0` (außer `1005 TOO_MANY_REQUESTS` = HTTP 429) → wie in `bolt-sync`
  immer `code` prüfen.
- Jeder Lauf schreibt eine Zeile nach `sync_runs`. Bei Fehler gilt `status = 'fehler'` und `verbindungen.letzter_fehler`,
  die Tabellen bleiben unverändert (die Liste zeigt dann „veraltet“, siehe Teil 2).
- **Aufrufschutz** wie bei `bolt-sync`: nur service_role (Zeitplan) oder Büro-User (`app_metadata.app_role`
  admin/user), sonst 403. `verify_jwt` bleibt an.
- Zeitplan `pg_cron` **`bolt-flotte-stuendlich`**: `5 * * * *` (stündlich, Minute 5, um nicht mit den Montagsläufen
  zur vollen Stunde zusammenzufallen).

### Tabellen

**`bolt_flotte_fahrzeuge`**, eine Zeile je Bolt-Auto:

| Spalte | Herkunft |
|---|---|
| `uuid` text PK | `uuid` |
| `company_id` int | Firma |
| `kennzeichen` text, `kennzeichen_key` text | `registration_number`, `kennzeichen_key(…)` |
| `vin` text | `vin` (leer → null) |
| `marke`, `modell` text, `baujahr`, `sitze` int, `farbe` text | `make`, `model`, `year`, `seats`, `colour` |
| `status` text | `active` / `suspended` / `deactivated` |
| `in_flotte_seit` timestamptz, `deaktiviert_seit` date | `added_to_fleet`, `deactivated_since` |
| `kategorien` text[] | `eligible_categories[].name` |
| `sperren` jsonb | `suspension.current` + `upcoming`, je Eintrag `{wann: 'jetzt'|'kommt', kategorie, typ, typ_name, dokument, start, ende, text}` |
| `fahrer_gewaehlt` jsonb | `drivers_with_selected_vehicle` gekürzt auf `{uuid, name, status, online}` |
| `roh` jsonb | ganze Antwort |
| `sync_run_id` uuid, `aktualisiert_am` timestamptz | Lauf |

**`bolt_flotte_fahrer`**, eine Zeile je Bolt-Fahrer:

| Spalte | Herkunft |
|---|---|
| `uuid` text PK | `uuid` (= v1 `driver_uuid`) |
| `company_id` int | Firma |
| `vorname`, `nachname`, `anzeige_name` text | `first_name`, `last_name`, `display_name` |
| `status` text | `active` / `suspended` / `deactivated` |
| `auto_uuid`, `auto_kennzeichen`, `auto_kennzeichen_key` text | `vehicles.selected` |
| `auto_seit` timestamptz | **von uns gesetzt**: Trigger setzt `now()`, wenn sich `auto_uuid` ändert (beim ersten Lauf = erste Sichtung). Bolt liefert keinen Zeitpunkt. |
| `sperren` jsonb | wie oben |
| `roh` jsonb, `sync_run_id`, `aktualisiert_am` | |

- Upsert über die UUID (Projekt-Grundsatz: Anbieter-ID als Unique-Key).
- Was Bolt nicht mehr liefert, bleibt stehen, trägt aber eine alte `sync_run_id` → **aktuell ist nur, was zum letzten
  erfolgreichen Lauf der Verbindung gehört.** So verschwindet nichts still, und nichts Altes zählt mit.
- RLS: Büro liest (gleiches Muster wie `bolt_vehicles`), `anon` und Fahrer ohne Rechte, geschrieben wird nur mit
  service_role. Da das Büro hier nicht schreibt, braucht es keinen Protokoll-Trigger.
- `bolt_vehicles` / `bolt_drivers` (v1, Montagslauf) bleiben unverändert.

## Teil 2 – Abgleich

### `bolt_flotte_stand` (View)

Je `bolt_v2`-Verbindung: `letzter_ok` (Ende des letzten `ok`-Laufs), `letzter_fehler`, **`veraltet`**
(= kein `ok`-Lauf in den letzten 3 Stunden). Ist die Verbindung veraltet, liefert `bolt_flotte_abgleich` für sie
**keine Befunde**: Fehlende Daten sind keine Abweichung.

### `bolt_flotte_abgleich` (View, `security_invoker = true`)

Eine Zeile je Befund: `gruppe`, `art`, `kennzeichen`, `fahrer_id`, `fahrer_name`, `bolt_sagt`, `wir_sagen`, `seit`,
`nur_hinweis` (bool). Grundlage sind nur die aktuellen Zeilen (letzter `ok`-Lauf), Kennzeichen-Vergleich immer über
`kennzeichen_key()`.

**Gruppe `fahrer_auto`** (nur Bolt-Fahrer mit `status` ≠ `deactivated`):

| `art` | Wann | `bolt_sagt` / `wir_sagen` | `seit` |
|---|---|---|---|
| `anderes_auto` | Bolt-Fahrer hat ein Auto gewählt, sein HYDRAlink-Fahrer (`bolt_drivers.fahrer_id` → `fahrer`, aktiv) hat ein anderes `kennzeichen` oder keines | gewähltes Kennzeichen / `fahrer.kennzeichen` oder „kein Auto“ | `auto_seit` |
| `fahrer_unbekannt` | Bolt-Fahrer mit gewähltem Auto ohne `fahrer_id` (kein v1-Konto oder nicht zugeordnet) | Name + Kennzeichen / „kein Fahrer in HYDRAlink“ | `auto_seit` |
| `mehrere_fahrer` | mehr als ein aktiver Fahrer hat dasselbe Auto gewählt – **nur Hinweis** (Schichtbetrieb ist normal) | Namen / – | – |

**Gruppe `fuhrpark`**:

| `art` | Wann |
|---|---|
| `nicht_im_fuhrpark` | aktives Bolt-Auto, Kennzeichen nicht in `fuhrpark` |
| `abgemeldet_aber_aktiv` | `fuhrpark.firma = 'Abgemeldet'`, bei Bolt aktiv |
| `nicht_bei_bolt` | `fuhrpark.firma = 'HYD'`, bei Bolt nicht vorhanden oder nicht aktiv. E&E und Abgemeldete werden hier bewusst nicht geprüft, sie laufen nicht über das Serdo-Bolt-Konto. |
| `fin_abweichung` | beide FIN vorhanden, `upper(trim(…))` verschieden |

`seit` = `in_flotte_seit` bzw. `deaktiviert_seit`, sonst leer.

**Gruppe `sperre`**: je Eintrag in `sperren` eines aktuellen Fahrers (`sperre_fahrer`) oder Autos (`sperre_auto`).
`bolt_sagt` = „jetzt“/„angekündigt“ · Kategorie · Grund (`typ_name`) · Dokument · bis. `seit` = `start`.

## Teil 3 – Anzeige

- Neuer Punkt **Fahrer → Bolt-Abgleich** in der Kopfleiste und im Burger-Menü (`contentBoltAbgleich`,
  JS-Präfix `ba`). Am Handy prüfen (Pitfall Tab-Leiste).
- Oben: **Chips mit Zähler** je Gruppe: „Alle · Fahrer↔Auto n · Fuhrpark n · Sperren n“. Hinweise
  (`nur_hinweis`) zählen nicht mit und stehen ausgegraut am Ende der Gruppe. Daneben „Stand HH:MM“ aus
  `bolt_flotte_stand` und ein Knopf „Jetzt abrufen“ (ruft `bolt-flotte` mit dem Büro-JWT).
- Ist der Stand **veraltet**: gelber Hinweis „Bolt-Daten veraltet (letzter Abruf …, Fehler: …)“ statt der Liste.
- Tabelle mit 4 Spalten: **Kennzeichen · Fahrer · Was weicht ab** (Art als Text + „Bolt: … / wir: …“) **· seit**.
  Am Handy: Kennzeichen · Fahrer · Art, der Rest in der aufklappbaren `detail-row` (wie die anderen Tabellen).
- Leere Liste: „Bolt und HYDRAlink sind sich einig.“
- Gleicher Stil wie der Rest (Tabellen statt Karten, Kennzeichen als `span.kz`).

## Fehler und Grenzen

- Token ungültig/abgelaufen (`503 NOT_AUTHORIZED`) oder Zugang entzogen (`49881x`) → Lauf `fehler`, Text in
  `verbindungen.letzter_fehler`, sichtbar im Verbindungen-Reiter und als „veraltet“ in der Liste.
- `1005 TOO_MANY_REQUESTS` → Lauf `fehler`, der nächste Stundenlauf versucht es wieder (kein eigener Wiederholversuch).
- Ein Bolt-Fahrer kann mehrere Konten haben (je Firma eine UUID). Mit nur einer Firma spielt das jetzt keine Rolle,
  die Zuordnung läuft trotzdem über `bolt_drivers.fahrer_id`, nie über den Namen.
- Die Größe ist unkritisch (≈ 64 Autos, 55 Fahrer, je eine Seite), die Function bleibt weit unter 150 s.

## Tests

- **Logik** in `supabase/functions/_shared/bolt-flotte-logik.ts` (Bolt-Antwort → Tabellenzeile, Sperren kürzen,
  leere FIN → null, Seitenschleife, Fehlercodes). Tests: `node --test scripts/test-bolt-flotte-logik.mjs` mit den
  Beispielen aus der Bolt-Doku und anonymisierten Ausschnitten der Probe.
- **Views** lokal mit PGlite wie beim Protokoll: `PGLITE=<dir> node scripts/test-bolt-flotte.mjs`
  (Nachbau von `fuhrpark`, `fahrer`, `bolt_drivers`, `sync_runs`, `verbindungen`; je `art` ein Fall plus
  „veraltet → keine Befunde“ und „alte sync_run_id zählt nicht“). Berührt die Live-Datenbank nicht.
- **Dashboard**: Liste mit Attrappen im headless Chromium (Muster `scripts/test-fahrer-nachrichten.sh`), Breite 390 px
  und Desktop.
- **Live-Abnahme**: nach Deploy ein Handlauf, Zahlen gegen die Probe vom 31.10. halten (64 Autos, 55 Fahrer),
  Stichproben mit dem Betreiber (W 204TX, die 4 FIN-Abweichungen, die 3 Autos mit mehreren Fahrern).

## Ausrollen

1. Betreiber trägt den Zugang ein (`pbpaste | node scripts/bolt-v2-zugang-speichern.mjs`).
2. Migration (Tabellen, Trigger `auto_seit`, Views, Check `anbieter`, RLS) – einspielen erst nach Freigabe im Gespräch.
3. Edge Function `bolt-flotte` deployen (Freigabe im Gespräch nötig, Auto-Mode), Handlauf, dann `pg_cron`-Job.
4. Dashboard auf `plattform-anbindung`; Push nach `main` macht der Betreiber.
5. CLAUDE.md: Tabelle Edge Functions, Zeitplan, Tabellen/Views, Abschnitt „Bolt-Flotte“.
