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

| Uber-Konto | Fahrpreis | an die Firma gezahlt | abgerechnet? |
|---|---|---|---|
| Ossama Eid | 1.073,12 € | 775,95 € | ja, aber als `WARNUNG_KEIN_FAHRER` |
| Suleiman Akhmadov | 386,66 € | 332,39 € | ja, auf "Suleyman Akhmadov" |
| Bislan Madaev | 348,58 € | 232,94 € | ja, auf "Bislan Madaev" |
| **Summe** | **1.808,36 €** | **1.341,28 €** | |

Wichtig: dieses Geld ist **nicht verloren**. Der CSV-Import hat es abgerechnet,
nur ohne saubere Fahrerzuordnung. Die Beträge stimmen auf den Cent mit
`settlements.uber_fahrpreis` überein — das **beweist**, dass "Suleiman
Akhmadov" und "Suleyman Akhmadov" dieselbe Person sind. Ossama Eid trägt bis
heute den Status `WARNUNG_KEIN_FAHRER`, also genau den Fehler, gegen den dieses
Projekt gebaut wurde.

Was fehlt, ist die Verknüpfung der drei Uber-Konten mit `fahrer.id`, damit der
Abgleich künftig greift.

## Der Abgleich im Abrechnungen-Tab

View `abrechnung_abgleich`: je Woche und Fahrer stehen Bolt- und Uber-Zahlen aus
der API neben `settlements`. Rein lesend. Im Abrechnungen-Tab erscheint darüber
ein Kasten mit den Wochensummen, und Fahrer mit Abweichung bekommen ein **≠** in
der Liste.

Eine Plattform wird nur verglichen, wenn sie für die Woche überhaupt gesynct
ist. Der erste Entwurf hatte das nicht: KW37 hat keine Uber-Daten, und die View
meldete prompt 31 Abweichungen, die es nicht gab.

### Was der Abgleich in KW 2026-W38 zeigt

48 Fahrer: **42 stimmen exakt**, 5 weichen ab, 1 Fahrer liegt doppelt in `fahrer`.

**Bislan Madaev: 758,70 € Bolt-Umsatz, nicht abgerechnet.**
57 Fahrten in beiden Firmen (53 Serdo, 4 EH Limo), davon 30 bar über 352,60 €.
In `settlements` steht `bolt_brutto = 0,00`, seine Auszahlung war 2,94 €. Das
Bargeld ist bei ihm geblieben, die App-Fahrten (333,46 € netto) bei der Firma —
verrechnet wurde nichts davon. **Das ist der Betrag, den der alte Weg übersehen
hat, weil ein nicht zugeordneter Fahrer auf beiden Seiten unsichtbar ist.**

**Aslanbek Dombaew liegt zweimal in `fahrer`** (633 und 639, beide Notion-Nr. 93,
gleiche Telefonnummer). Das Uber-Konto hängt an 639, die Abrechnung an 633, also
1.391,42 € auf zwei Zeilen. Kein Geldverlust, aber jede Zuordnung über diesen
Fahrer ist Zufall, solange die Altzeile existiert.

**Drei kleine Abweichungen** — Dragan Kovacs +33,11 €, Georgios Vavilin +32,75 €,
Abdurakhman Eskiev +8,14 €, zusammen die bekannten 74,00 €. Das sind Ubers
nachträgliche Korrekturen, kein Fehler im Import.

### Korrektur zu den Bolt-Summen weiter oben

Die geprüfte Gleichheit **16.990,60 € = 16.990,60 €** gilt für die Fahrer, die zu
diesem Zeitpunkt zugeordnet waren. Sie war unvollständig: Bislan Madaevs 758,70 €
fehlten auf **beiden** Seiten und fielen deshalb nicht auf. Mit Zuordnung lautet
die Bolt-Summe aus der API **17.749,30 €** gegen 16.990,60 € abgerechnet.

Daraus die eigentliche Lehre: eine Summe, die auf beiden Seiten dieselbe Lücke
hat, stimmt und ist trotzdem falsch. Deshalb zählt `abrechnung_abgleich` auch
Plattformkonten ohne Fahrer mit.

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
4. **Die drei Uber-Konten oben** mit `fahrer.id` verknüpfen. Bei Suleiman/Suleyman
   und Bislan Madaev ist die Identität über die Beträge belegt, bei Ossama Eid nicht.
5. **Bislan Madaevs 758,70 € Bolt aus KW38** nachverrechnen — oder bewusst lassen.
6. **Aslanbek Dombaew doppelt in `fahrer`** (633/639): die Altzeile gehört weg,
   sonst bleibt jede Zuordnung über ihn Zufall.
7. **`uber-probe`** ist eine Wegwerf-Function aus der Erkundungsphase und noch
   deployt. Kann gelöscht werden.
8. **Vertauschtes Kennzeichenpaar und Aslan Abubakarovs Pauschale** müssen in
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
