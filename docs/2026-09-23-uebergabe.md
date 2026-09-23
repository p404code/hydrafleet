# Übergabe: Stand 2026-09-23

Dieses Dokument ist für jemanden geschrieben, der den bisherigen Gesprächsverlauf
**nicht** kennt — für eine neue Planungs-Session und für eine frische
Code-Session. Es verweist auf nichts, was nicht im Repo steht.

---

## In einem Absatz

HYDRAlink ist das interne Dashboard von HYDRAFLEET, einer Wiener Taxi- und
Mietwagenflotte mit rund 57 Fahrzeugen und 52 Fahrern auf Bolt, Uber und myPOS.
Bis zum 22.09.2026 wurden die Wochendaten der Plattformen als CSV hochgeladen und
über Fuzzy-Namensvergleich den Fahrern zugeordnet. Seitdem holt HYDRAlink Bolt,
Uber und Notion selbst per API und ordnet über die IDs der Anbieter zu. Das alte
System läuft unverändert weiter: **über Geld entscheiden nach wie vor Notion und
der AbrechnungsBot.** Die neuen Daten sind ein Spiegel, der zeigt, wo die Quellen
auseinandergehen.

## Stand im Git

```
Branch plattform-anbindung  (3 Commits, NICHT gepusht)
  f5e6a2b  docs: plan fuer die fahrerapp
  df3dcbd  abrechnungen: plattform-abgleich im tab
  be97b4a  plattform-anbindung: bolt, uber und notion holen sich die daten selbst
Branch main
  677ccb0  auth: PIN-Login über Supabase Auth, RLS für alle Tabellen
```

**Push auf `main` deployt sofort auf Cloudflare Pages.** Der Branch ist bewusst
nicht gepusht — der Plattform-Abgleich ist im Dashboard also noch nicht live.

Datenbank und Edge Functions sind dagegen **schon in Betrieb**: Migrationen sind
angewendet, Functions deployt, Cron läuft. Repo und Produktion stimmen überein;
wer eine Edge Function ändert, muss beides nachziehen.

## Was man gelesen haben muss

| Datei | Wofür |
|---|---|
| `CLAUDE.md` | Architektur, Regeln, die vollständige Fallstrickliste |
| `docs/2026-09-22-plattform-anbindung-protokoll.md` | Was gebaut wurde, welche Zahlen geprüft sind, was der Abgleich gefunden hat |
| `docs/2026-09-23-fahrerapp-plan.md` | Plan für die Fahrerapp, noch nichts davon gebaut |
| `migrations/2026-09-22-*.sql` | Das gesamte neue Schema, chronologisch |

---

## Die Regeln des Betreibers

Diese sind nicht verhandelbar und haben Vorrang vor jeder technischen Vorliebe.

1. **Kein Overengineering. Die einfachste Lösung, die stabil läuft.**
2. **Notion bleibt Stammdaten** (Fahrer, Fuhrpark), **Supabase nur Transaktionen.**
   Nicht zusammenlegen.
3. **Zugangsdaten nur verschlüsselt im Supabase Vault** — nie im Code, nie im
   Klartext in Tabellen, nie im Frontend.
4. **RLS auf allen neuen Tabellen**, `anon` ohne Rechte.
5. **Jeder importierte Datensatz trägt die ID des Anbieters als Unique-Key** →
   Upsert, doppelter Import unmöglich.
6. **Der CSV-Upload bleibt.** Er ist der Notfallweg und wird nicht entfernt.
7. **Keine Daten erfinden** — keine IDs, Endpunkte oder Feldnamen, die nicht im
   Repo oder in der Datenbank nachweisbar sind. Was fehlt, wird gefragt.
8. **Muss am Handy funktionieren.** Die Fahrer haben nichts anderes.

Zur Arbeitsweise: der Betreiber will Ergebnisse sehen, keine Optionslisten. Wenn
etwas nicht stimmt, sagt er es direkt — und erwartet dasselbe zurück. Zahlen
gehören gegen die Datenbank geprüft, nicht aus dem Gedächtnis geschrieben.

---

## Was läuft

**Drei Edge Functions** (Deno, Quelle in `supabase/functions/`):

| Function | Quelle | Schreibt nach |
|---|---|---|
| `bolt-sync` | Bolt Fleet Integration API, OIDC, zwei Firmen | `bolt_orders`, `bolt_drivers`, `bolt_vehicles` |
| `uber-sync` | Uber Fleet-Portal, gespeicherte Sitzung, drei Berichte | `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips` |
| `notion-sync` | Notion API, Datenquellen-Endpunkt | `fuhrpark`, `notion_fahrer`, setzt `fahrer.notion_fahrer_id` wo leer |

**Zeitplan** (`pg_cron` + `pg_net`): Notion alle 10 Minuten, Bolt Montag 04:00,
Uber Montag 05:00, Aufräumen täglich 02:20. Jeder Lauf schreibt nach `sync_runs`,
der Verbindungen-Tab zeigt den Status.

**Sieben Tabs:** Abrechnungen, Müssen zahlen, Fahrer, Fuhrpark, Verbindungen,
CSV-Upload, Rechnungen. Am Handy Burger-Menü statt Tab-Leiste.

**Zwölf neue Tabellen**, alle mit RLS und `is_app_user()`-Policy.
**Sechs Views**, alle `security_invoker = true`.

## Was geprüft ist

- **Bolt KW 2026-W38:** 42 von 48 Fahrern stimmen auf den Cent mit der Abrechnung.
- **Uber:** die gesyncten Daten waren 47 von 47 Zeilen identisch mit der von Hand
  heruntergeladenen CSV.
- **Notion live:** eine Änderung in Notion stand nach 6 Sekunden in Supabase.
- **Spaltenzuordnung**, empirisch bestimmt und im Migrationskopf dokumentiert:
  `bolt_orders.ride_price + cancellation_fee` → `settlements.bolt_brutto`;
  `uber_reports.fahrpreis` → `settlements.uber_fahrpreis`;
  `uber_reports.gezahlt` → `settlements.uber_auszahlung`.

## Was offen ist

### Mit Frist

1. **Die Uber-Sitzung läuft am 06.10.2026 ab.** Erneuern mit
   `node scripts/uber-session-speichern.js`. Der Weg ist gebaut, aber noch nie
   unter echten Bedingungen durchgespielt. **Vor dem 06.10. einmal testen,
   solange die alte Sitzung noch gültig ist.**
2. **Zwei Notion-Korrekturen**, sonst rechnet der AbrechnungsBot weiter falsch:
   - `W 755 TX` und `W 580CTX` sind über Kreuz eingetragen (Aslan Nagaev /
     Khozhakhmed Visaitov). Bolt und Uber sagen unabhängig voneinander dasselbe.
   - Aslan Abubakarov zahlt 230 € Pauschale für einen abgemeldeten Audi, fährt
     aber ein 550-€-Fahrzeug. **+320 €/Woche.**

### Geld, noch nicht entschieden

3. **Bislan Madaev, 758,70 € Bolt-Umsatz aus KW38, nicht abgerechnet.**
   57 Fahrten in beiden Firmen, davon 30 bar über 352,60 €. In `settlements`
   steht `bolt_brutto = 0,00`, seine Auszahlung war 2,94 €. Nachverrechnen oder
   bewusst liegen lassen — das ist eine Entscheidung des Betreibers.
4. **Bolt-Zahlen in `settlements` bis einschliesslich KW36 sind vermutlich um
   eine Woche zu spät beschriftet.** Korreliert mit Commit `4885cb0` vom
   11.09.2026. KW37 und KW38 wurden danach importiert und stimmen exakt.

### Datenhygiene, blockiert die Fahrerapp

5. **Aslanbek Dombaew liegt doppelt in `fahrer`** (IDs 633 und 639, beide
   Notion-Nr. 93, dieselbe Telefonnummer). Solange das so ist, ist jede
   Zuordnung über ihn Zufall — und die per Telefonnummer geplante
   Fahrer-Anmeldung würde ihn aussperren.
6. **Drei Uber-Konten ohne `fahrer_id`:** Ossama Eid (1.073,12 €), Suleiman
   Akhmadov (386,66 €), Bislan Madaev (348,58 €). Das Geld **ist** abgerechnet,
   nur die Zuordnung fehlt. Bei Suleiman/Suleyman und Madaev ist die Identität
   über die Cent-genaue Übereinstimmung mit `settlements.uber_fahrpreis` belegt,
   bei Ossama Eid nicht — er läuft als `WARNUNG_KEIN_FAHRER`.
7. **Zwei Fahrer ohne Telefonnummer** (Murad Izrailov, Alik Selmurzaev). Ohne
   Nummer keine SMS-Anmeldung.

### Kleinkram

8. `bolt_state_logs` ist angelegt und leer — offen, ob `lat`/`lng` gespeichert
   werden sollen.
9. `uber-probe` ist eine Wegwerf-Function aus der Erkundungsphase und noch
   deployt. Kann gelöscht werden.

---

## Für die frische Code-Session

**Vor der ersten Änderung lesen:** `CLAUDE.md`, Abschnitt *Known Pitfalls*. Die
Punkte dort sind alle teuer erkauft. Die drei, die am ehesten wieder zuschlagen:

- **Fehlende Daten sind keine Abweichung.** Wird eine Plattform für eine Woche
  nicht gesynct, darf ein Vergleich das nicht als Fehlbetrag zeigen.
  `abrechnung_abgleich` prüft deshalb je Woche, ob die Plattform Daten hat. Der
  erste Entwurf tat das nicht und meldete 31 Abweichungen, die es nicht gab.
- **Eine Summe kann auf beiden Seiten dieselbe Lücke haben und trotzdem stimmen.**
  Ein nicht zugeordnetes Plattformkonto fehlt in der API-Summe *und* in der
  Abrechnung. Genau so blieben Bislan Madaevs 758,70 € unsichtbar.
- **Sammelzeilen sind keine Fahrer.** `settlements.__TRANSFER__` und in
  `uber_reports` die Zeile mit `umsaetze is null` (in KW38 −35.556,55 €) dürfen
  nie mitsummiert werden.

**Arbeitsweise, die sich bewährt hat:**
- `bash scripts/check-dashboard.sh` nach jeder Änderung an `dashboard.html`.
  Prüft Syntax der Inline-Scripts und dass jede referenzierte ID existiert.
- Frontend am Handy prüfen, nicht nur am Desktop. 390 px ist die Messlatte.
- Zahlen vor dem Aufschreiben gegen die Datenbank prüfen.

**Womit man anfangen könnte**, in dieser Reihenfolge:
1. Uber-Sitzungserneuerung einmal durchspielen (Frist 06.10.).
2. Die Datenhygiene-Punkte 5–7 — sie blockieren die Fahrerapp.
3. Die Admin-Seite der Fahrerapp im Dashboard (Freigabe, Vorschau als Fahrer,
   Zuordnungs-Werkzeug, Telefonnummern-Ampel).
4. Die Fahrerapp selbst nach `docs/2026-09-23-fahrerapp-plan.md`.

## Für die Planungs-Session

Das Design von `dashboard.html` ist in einer einzigen Datei ohne Build-Schritt:
CSS-Variablen für hell und dunkel (`data-theme="dark"`; hell = Attribut
entfernt), Fraunces für das Logo, Inter für die Oberfläche, Akzent Gold #F5B51B.
Am Handy Burger-Menü, Tabellen auf drei Spalten reduziert mit aufklappbarer
Detailzeile.

Die drei Entscheidungen, die die Fahrerapp blockieren, stehen in
`docs/2026-09-23-fahrerapp-plan.md`, Abschnitt 7: SMS-Provider ja oder nein, ab
welcher Woche Fahrer zurückschauen dürfen, und wer eine Woche freigeben darf.
