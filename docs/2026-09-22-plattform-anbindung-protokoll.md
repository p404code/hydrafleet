# Plattform-Anbindung: Bolt, Uber, Notion

**Datum:** 2026-09-22
**Stand:** in Betrieb, im Dashboard sichtbar, nicht abrechnungsrelevant

## Warum

Bisher wurden Bolt-, Uber- und myPOS-CSVs händisch hochgeladen; der
AbrechnungsBot ordnete die Fahrer per Fuzzy-Namensvergleich zu (Schwelle 0,92).
Das erzeugt regelmäßig "unbekannt"-Fehler, sobald ein Name in der CSV anders
geschrieben ist als in Notion.

Ziel: Daten direkt per API holen, Zuordnung über die IDs der Anbieter statt über
Namen.

## Leitsatz

**HYDRAlink ist der Spiegel, der zeigt was wirklich passiert.**

Die neuen Syncs schreiben ausschliesslich in eigene Tabellen. `settlements`,
`fahrer` und der AbrechnungsBot bleiben unberührt. Über Geld entscheiden
weiterhin Notion und das alte System. Der CSV-Upload bleibt als Notfallweg.

## Was gebaut wurde

### Drei Edge Functions

| Function | Zugang | Schreibt nach |
|---|---|---|
| `bolt-sync` | Bolt Fleet Integration API, OIDC `client_credentials`, Token 10 Min gültig | `bolt_orders`, `bolt_drivers`, `bolt_vehicles` |
| `uber-sync` | Uber Fleet-Portal mit gespeicherter Sitzung | `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips` |
| `notion-sync` | Notion API, Datenquellen-Endpunkt | `fuhrpark`, `notion_fahrer` |

Jeder Lauf protokolliert nach `sync_runs`. Zeitplan über `pg_cron` + `pg_net`:
Notion alle 10 Minuten, Bolt Montag 04:00, Uber Montag 05:00, Aufräumen täglich 02:20.

### Warum bei Uber das Portal und nicht die offizielle API

Die offizielle Supplier-Platform-API liefert nur 24 Stunden Rückschau — für eine
Wochenabrechnung unbrauchbar. Deshalb die interne Schnittstelle von
`fleethub.uber.com` mit gespeicherter Anmeldesitzung: eigenes Konto, eigene
Daten, Zugriff selbst erteilt.

`uber-sync` fordert drei Berichte gleichzeitig an und pollt sie gemeinsam, damit
die Wartezeit nur einmal anfällt:

- `REPORT_TYPE_PAYMENTS_DRIVER` → Wochenabrechnung je Fahrer
- `REPORT_TYPE_VEHICLE_PERFORMANCE` → Ubers Fahrzeugliste
- `REPORT_TYPE_TRIP_ACTIVITY` → Fahrten mit Fahrer **und** Fahrzeug

Die Fahrt-Tabelle ist der eigentliche Gewinn: sie verbindet Fahrer mit Auto und
macht die Zuordnung überprüfbar, statt sie zu glauben.

### Drei neue Tabs

- **Fahrer** — Notion-Fahrer neben ihren Bolt- und Uber-Konten
- **Fuhrpark** — Fahrzeuge aus Notion, Bolt und Uber nebeneinander
- **Verbindungen** — Statusseite der Zugänge, zeigt abgelaufene Sitzungen

Drei Quellen nebeneinander statt einer zusammengeführten Wahrheit: solange
Notion die Stammdaten führt, muss sichtbar sein **wo** die Quellen auseinandergehen.

## Sicherheit

- Zugangsdaten ausschliesslich im **Supabase Vault**, nie im Code, nie im
  Klartext in Tabellen, nie im Frontend.
- `verbindungen` hält nur Metadaten und den Vault-Verweis. Lesen nur über
  `verbindung_zugang()` mit `service_role`.
- RLS auf allen zwölf neuen Tabellen, `anon` ohne Rechte. Alle fünf Views mit
  `security_invoker = true`.
- Jeder importierte Datensatz trägt die ID des Anbieters als Unique-Key →
  Upsert, doppelter Import unmöglich.
- Die Uber-Cookies werden per CDP aus dem laufenden Browser gelesen und direkt in
  den Vault geschrieben. Sie landen nie auf der Platte.

## Abgleich: stimmen die Zahlen?

### Bolt, KW 2026-W38

Bruttoumsatz aus `bolt_orders` gegen die Abrechnung: **16.990,60 € = 16.990,60 €**,
30 von 30 Fahrern. Auszahlung 2 Cent Differenz (Rundung).

Nötig dafür waren beide Firmen (EH Limo 262554, Serdo 182009) und drei
Namenskorrekturen, die erst durch den UUID-Abgleich sichtbar wurden:

- "Dragan Kovács" / "Dragan Kovacs" — ein Fahrer, zwei Firmen
- "Ahmed Safa, Beng" — der Name mit Komma, der am 14.09. den CSV-Import zerlegt hat
- "Kamiran Haqqi" = "Muhammet Usta" — vom Betreiber bestätigt, zusätzlich
  bestätigt durch das gemeinsame Kennzeichen W 973BTX

Zwei Formeln, die vorher nicht sauber waren:

- **Zeitfilter:** `time_range_filter_type: "price_review"`, nicht `created`.
  Mit `created` streuen Fahrten über die Wochengrenze.
- **Stornogebühren** zählen in den Bruttoumsatz. Von der Auszahlung wird der
  **Bar-`ride_price`** abgezogen, nicht `net_earnings` der Barfahrten.

### Uber

Die gesyncten Daten gegen die händisch heruntergeladene CSV: **47 von 47 Zeilen
identisch.** Die verbleibenden drei Abweichungen gegenüber `settlements` sind
Ubers eigene nachträgliche Korrekturen.

Ubers Abrechnungswoche beginnt Montag gegen 04:00 Wiener Zeit, nicht um
Mitternacht UTC, und der genaue Zeitpunkt schwankt um Minuten. Das Fenster wird
deshalb bei Uber erfragt (`GetReportingTimeWindows`) und nie selbst gerechnet.

### Notion, live geprüft

Pauschale von W 755 TX in Notion auf 240 € geändert → `notion-sync-laufend` lief
um 21:10:00, der Wert stand um 21:10:06 in Supabase. Die Summe der
Fuhrpark-Pauschalen bewegte sich von 20.825 € auf 20.835 €, also exakt +10 €.

## Was der Abgleich an echtem Geld gefunden hat

Alles aus `zuordnung_abgleich`, Zahlen vom 2026-09-22. **Nichts davon wurde
verändert** — das ist eine Anzeige, keine Korrektur.

| Fahrer | Auto laut Notion | Pauschale | Tatsächlich gefahren | Fahrten | Pauschale dort | Differenz |
|---|---|---|---|---|---|---|
| Aslan Abubakarov | SW-88FTX | 230 € | W-204TX | 53 von 57 | 550 € | **+320 €/Woche** |
| Aslan Nagaev | W 580CTX | 200 € | W-755TX | 160 von 160 | 240 € | +40 € |
| Khozhakhmed Visaitov | W 755 TX | 240 € | W-580CTX | 90 von 98 | 200 € | −40 € |
| Alik Selmurzaev | *kein Auto* | — | W-844ATX | 71 von 71 | *nicht im Fuhrpark* | unbekannt |
| Oktay Coskun | *kein Auto* | — | W-4262TX | 1 | 800 € | offen |

Die beiden mittleren Zeilen sind **ein vertauschtes Paar**: W 755 TX und
W 580CTX stehen in Notion über Kreuz. Für die Flotte gleicht sich das aus, für
die beiden Fahrer nicht. Bolt und Uber sagen unabhängig voneinander dasselbe.

Aslan Abubakarov zahlt seit unbekannter Zeit 230 € Pauschale für einen
abgemeldeten Audi, während er tatsächlich ein 550-€-Fahrzeug fährt.

### Drei Uber-Konten ohne Fahrer-Zuordnung, KW 2026-W38

| Uber-Konto | Umsätze brutto | an die Firma gezahlt |
|---|---|---|
| Ossama Eid | 865,29 € | 775,95 € |
| Suleiman Akhmadov | 308,63 € | 332,39 € |
| Bislan Madaev | 275,29 € | 232,94 € |
| **Summe** | **1.449,21 €** | **1.341,28 €** |

"Suleiman Akhmadov" ist vermutlich der in Notion als "Suleyman" geführte Fahrer —
**nicht bestätigt**, deshalb nicht zugeordnet.

## Offene Punkte

1. **Uber-Sitzung läuft am 2026-10-06 ab.** Erneuern mit
   `node scripts/uber-session-speichern.js`. Der Weg ist gebaut, aber noch nie
   unter echten Bedingungen durchgespielt worden. Vor dem 06.10. einmal testen.
2. **Bolt-Zahlen in `settlements` bis einschliesslich KW36 sind vermutlich um
   eine Woche zu spät beschriftet.** Das korreliert mit Commit `4885cb0`
   ("upload: vorauswahl auf ISO-vorwoche statt laufender woche", 11.09.2026).
   KW37 und KW38 wurden nach der Korrektur importiert und stimmen exakt.
   Nicht angefasst — das ist eine Entscheidung des Betreibers, keine technische.
3. **`bolt_state_logs` ist angelegt, aber leer.** Offen, ob `lat`/`lng`
   gespeichert werden sollen (Standortdaten der Fahrer).
4. **Die drei Uber-Konten oben** brauchen eine Bestätigung, wem sie gehören.
5. **`uber-probe`** ist eine Wegwerf-Function aus der Erkundungsphase und noch
   deployt. Kann gelöscht werden.
6. **Vertauschtes Kennzeichenpaar und Aslan Abubakarovs Pauschale** müssen in
   Notion korrigiert werden, sonst rechnet der AbrechnungsBot weiter falsch.

## Fallen, die Zeit gekostet haben

- **PostgREST antwortet bei `Prefer: return=minimal` mit 201 und leerem Body**,
  nicht mit 204. `r.json()` wirft dann. Erst `await r.text()`, dann nur parsen
  wenn nicht leer.
- **Ein Fahrer hat pro Bolt-Firma eine eigene Driver-UUID** — zehn Fahrer hatten
  zwei. Ein Feld `fahrer.bolt_driver_uuid` kann es deshalb gar nicht geben; die
  Zuordnung gehört auf die Kontoseite (`bolt_drivers.fahrer_id`).
- **Fremdschlüssel auf `fahrer(id)` brauchen `ON DELETE SET NULL`.** Ohne
  Löschregel wäre der bestehende n8n-Sync beim Löschen eines Fahrers gescheitert.
- **`fuhrpark_uebersicht` v1 nahm `min(id)` und `min(name)` unabhängig** — bei
  einem geteilten Kennzeichen (W-7298TX) ergab das die ID des einen Fahrers mit
  dem Namen des anderen. Jetzt `distinct on`. Zusätzlich eine Schwelle von
  5 Fahrten, damit 4 Bolt-Fahrten nicht 96 Uber-Fahrten überstimmen.
- **CSV braucht einen echten RFC-4180-Parser.** "Ahmed Safa, Beng".
- **Notion-Feld heisst `"Pauschale "`** — mit Leerzeichen am Ende.
- **Notion hat Datenbanken seit Version 2025-09-03 in Datenquellen geteilt.**
  `/v1/databases/{id}/query` ist abgekündigt.
- **Dunkles Theme, Kennzeichentafel:** `.fz-main b` hat dieselbe Spezifität wie
  `.kz b`, steht aber später im Stylesheet — die Tafelschrift wurde weiss auf
  hellem Grund. Behoben mit `span.kz b`, Kommentar steht im Code.
- **Mobil war komplett kaputt:** sieben Tab-Buttons ergeben 396px auf einem
  390px-Gerät, weil Flex-Items `min-width: auto` haben. Behoben mit Burger-Menü;
  Tabellen zu drei Spalten plus aufklappbarer Detailzeile umgebaut.

## Die Notion-Fahrer-Datenbank hat keine Plattform-Felder

Die "Dash"-Seite in Notion zeigt ein Diagramm mit Bolt- und Uber-Namensfeldern.
Das ist ein Zielbild, kein Schema — die echte Fahrer-Datenbank hat diese Felder
nicht. Deshalb läuft die Zuordnung über `bolt_drivers.fahrer_id` und
`uber_drivers.fahrer_id` in Supabase.
