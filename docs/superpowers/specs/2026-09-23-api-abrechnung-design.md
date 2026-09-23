# API-Abrechnung — Design

**Datum:** 2026-09-23
**Stand:** Design vom Betreiber freigegeben, nichts davon gebaut.
**Gehört zu:** `docs/2026-09-22-plattform-anbindung-protokoll.md` (API-Sync),
`docs/2026-09-23-datenpruefung.md` (bekannte Abweichungen).

## Ziel

Im Dashboard eine zweite Wochenabrechnung sehen, die Bolt und Uber **aus der API**
nimmt statt aus den CSV-Dateien — neben der alten, nicht an ihrer Stelle.

- **Die alte Abrechnung bleibt maßgeblich.** Notion, AbrechnungsBot, CSV-Upload,
  `settlements`, Abrechnungen-Tab und Fahrerapp werden nicht verändert.
- **Nur ansehen.** Die API-Abrechnung wird live gerechnet, nichts gespeichert,
  nichts gedruckt, nichts an Fahrer geschickt.
- **Später umstellen** ist ein eigener Schritt mit eigener Spec, wenn die Zahlen
  ein paar Wochen stimmen.

## Entscheidungen des Betreibers (23.09.)

| Frage | Entscheidung |
|---|---|
| Wo im Dashboard | Eigener Reiter **„API-Abrechnung“** |
| myPOS | Aus der alten Abrechnung derselben Woche, als „aus CSV“ markiert |
| Zweck | Erst ansehen, später umstellen — kein Speichern |
| Rechenort | **Datenbank-View** (Ansatz A), nicht im Browser |

## Bausteine

| Baustein | Datei | Inhalt |
|---|---|---|
| View `api_abrechnung` | `migrations/2026-09-23-api-abrechnung.sql` | Eine Zeile je Woche × Fahrer, Bot-Formel mit API-Eingaben, daneben die alten Werte |
| View `api_abrechnung_wochen` | dieselbe Migration | Je Woche: Bolt gesynct?, Uber gesynct?, Anzahl Fahrer |
| Reiter „API-Abrechnung“ | `dashboard.html` | Wochenwahl, Tabelle, Zettel im Detail, Konten ohne Fahrer |

Keine neue Tabelle, keine Edge Function, keine n8n-Änderung.

---

## 1. Die Rechnung

Nachgebaut aus `.n8n-backup/berechnung-v15.js` (Zeilen ~281–300 und ~318–332).

### Eingaben je Woche × `fahrer_id`

| Feld | Quelle | Definition |
|---|---|---|
| `bolt_brutto` | `bolt_orders` über `bolt_drivers.fahrer_id` | `sum(ride_price + cancellation_fee)` |
| `bolt_auszahlung` | dto. | `sum(net_earnings) − sum(ride_price where payment_method='cash')` |
| `uber_fahrpreis` | `uber_reports` über `uber_drivers.fahrer_id`, `umsaetze is not null` | `sum(fahrpreis)` |
| `uber_auszahlung` | dto. | `sum(gezahlt)` |
| `mypos_summe` | `settlements` derselben Woche, `settlement_fahrer(telefon, fahrer_name) = fahrer_id` | `sum(mypos_summe)` — **aus CSV** |
| `lohn`, `korrektur` | dto. | `sum(lohn)`, `sum(korrektur)`; `korrektur_note` per `string_agg` — **aus CSV** |
| `mietmodell`, `miete` | alte Abrechnung der Woche, sonst `fahrer` | siehe unten |
| `prozent_satz`, `prozent_schwelle` | `fahrer` (heutiger Stand) | |

Die Bolt- und Uber-Definitionen sind **wörtlich dieselben wie in
`abrechnung_abgleich`** — dort cent-genau geprüft (Bolt KW38 42/48, Uber 47/47).
Sammelzeilen (`__TRANSFER__`, `__MYPOS:…`, Uber `umsaetze is null`) sind
ausgeschlossen.

### Pauschale

`mietmodell` und `miete` aus der alten Abrechnung der Woche, wenn es dort eine
Zeile für den Fahrer gibt (so wird mit dem Wert gerechnet, der damals galt). Hat
der Fahrer mehrere Zeilen in der Woche (Alias-Fall, z. B. Madaev/Abubakarov),
**wird die Pauschale nur einmal abgezogen**: `max(miete)` der Zeilen. Ohne alte
Zeile: `fahrer.mietmodell`, `fahrer.basis_miete`.

### Formel

```
bruttoumsatz_gesamt = bolt_brutto + uber_fahrpreis + mypos_summe
wir_bekommen        = bolt_auszahlung + uber_auszahlung + mypos_summe
prozent_abzug       = f11: greatest(brutto − 1100, 0) × 0,10
                      f12: greatest(brutto − 1200, 0) × 0,10
                      sonst wenn prozent_satz > 0 und brutto > prozent_schwelle:
                            (brutto − prozent_schwelle) × prozent_satz / 100
                      sonst 0
abzug_gesamt        = miete + prozent_abzug
auszahlung          = wir_bekommen − abzug_gesamt + korrektur
du_bekommst         = auszahlung − lohn          (= netAuszahlung() im Dashboard)
```

`+ korrektur` ist nachgeprüft: in `settlements` gilt
`auszahlung = wir_bekommen − abzug_gesamt + korrektur` für 25 von 26 Zeilen mit
Korrektur (Stand 23.09.).

`prozent_schwelle` fällt wie im Bot auf 1200 zurück, wenn sie leer ist.

### Vergleichsspalten

Je Zeile zusätzlich aus der alten Abrechnung: `alt_bolt_brutto`,
`alt_uber_fahrpreis`, `alt_miete`, `alt_prozent_abzug`, `alt_auszahlung`,
`alt_du_bekommst`, `alt_zeilen` (Anzahl `settlements`-Zeilen), und
`diff = du_bekommst − alt_du_bekommst`.

### Status je Zeile

| `befund` | Wann |
|---|---|
| `ok` | `abs(diff) < 0,01` |
| `rundung` | `< 1,00` |
| `weicht ab` | sonst |
| `nur API` | keine Zeile in der alten Abrechnung |
| `nur alt` | alte Zeile, aber weder Bolt- noch Uber-Umsatz in der API |
| `unvollständig` | für die Woche fehlt Bolt **oder** Uber in der API |

Reihenfolge der Prüfung: `unvollständig` → `nur API` → `nur alt` → `ok` /
`rundung` / `weicht ab`.

**Fehlende Daten sind keine Abweichung:** Ist eine Plattform für die Woche nicht
gesynct, werden ihre Felder `null`, nicht 0, und der Befund ist
`unvollständig` statt `weicht ab`.

### Konten ohne Fahrer

Eigener Teil der View (wie `lose` in `abrechnung_abgleich`), `fahrer_id = null`,
`befund = 'Konto ohne Fahrer'`, mit Kontoname und API-Umsatz. Sie fehlen sonst in
beiden Summen.

## 2. Die View

- `create view public.api_abrechnung with (security_invoker = true)`,
  `revoke all from anon`, `grant select to authenticated`. Sichtbar also nur für
  `is_app_user()` über die RLS der Basistabellen — Fahrer sehen nichts.
- **Wochen ab `2026-W37`** (`where woche >= '2026-W37'`). Davor sind die
  Bolt-Zahlen der alten Abrechnung um eine Woche verschoben
  (`docs/2026-09-23-datenpruefung.md`, Punkt 5) — der Vergleich wäre wertlos.
- Sonderwochen wie `2026-W37k`: nur wenn API-Daten mit dieser Wochenkennung
  existieren. `bolt_orders.woche` kennt keine `k`-Wochen, also erscheint
  `2026-W37k` nur mit ihren alten Zeilen als `nur alt`. Das ist so gewollt und im
  Tab erklärt.
- `api_abrechnung_wochen`: `woche`, `bolt_gesynct`, `uber_gesynct`, `fahrer`,
  `summe_du_bekommst`, `summe_alt`, `anzahl_abweichend`.

## 3. Der Reiter „API-Abrechnung“

Position: direkt nach „Abrechnungen“. Aufbau nach dem Muster des Abrechnungen-Tabs
(`.hero`, `.kpi`, `.toolbar`, `.data-table`, `.split`), Design-Tokens wie überall.

- **Kopf:** Wochenwahl (nur Wochen aus `api_abrechnung_wochen`), grosse Zahl
  „Auszahlung API“, Kacheln: Auszahlung alt · Differenz · Abweichend · Quelle
  (z. B. „Bolt ✓ · Uber ✓ · myPOS aus CSV“; fehlt eine Plattform: „Uber nicht
  gesynct“ in `--warn`).
- **Hinweisband** oben, dauerhaft: „Nur zur Ansicht. Ausgezahlt wird nach der
  Abrechnung im Reiter Abrechnungen.“
- **Filter-Chips:** Alle · Abweichend · Nur API · Nur alt · Konten ohne Fahrer.
- **Tabelle (Desktop):** Fahrer | Brutto | Pauschale | Prozent | Du bekommst (API)
  | Du bekommst (alt) | ≠. Sortierbar. **Handy:** Fahrer | API | ≠, Rest im
  Aufklapper.
- **Detail (Klick):** der Zettel wie `detailHtml()` mit API-Werten. Jede Zeile,
  die von der alten abweicht, bekommt den alten Wert klein daneben. myPOS, Lohn
  und Korrektur tragen den Zusatz „aus CSV“.
- **Kein** Drucken, **kein** WhatsApp, **kein** CSV-Export in v1.
- Fehlt die View (Migration nicht eingespielt): „Noch nicht verfügbar“, der Rest
  des Dashboards läuft weiter.

## 4. Abnahme

1. **Formel-Gegenprobe:** die View-Formel auf die **alten** Eingaben
   (`settlements.bolt_brutto` usw.) angewandt muss `settlements.auszahlung` für
   KW37 und KW38 auf den Cent treffen (einzige erlaubte Ausnahme: Zeilen mit
   Handänderung ohne Korrektur-Eintrag — einzeln begründen). Das beweist, dass
   die Formel stimmt, bevor die API-Eingaben ins Spiel kommen.
2. **KW38:** Summe `bolt_brutto` der View = Summe API im Abgleich; Fahrer mit
   `befund='ok'` mindestens so viele wie im bestehenden Abgleich (42).
3. **Madaev/Abubakarov KW38** erscheint mit `diff ≈ +230,00` (einmal Pauschale
   statt zweimal).
4. **KW37:** Uber ist nicht gesynct → alle Zeilen `unvollständig`, keine
   `weicht ab`.
5. Als Fahrer-JWT: `select * from api_abrechnung` liefert 0 Zeilen; `anon`: kein
   Recht.
6. `bash scripts/check-dashboard.sh` grün; Reiter auf 390 px ohne seitliches
   Scrollen; hell und dunkel.
7. `settlements` vor und nach: gleiche Zeilenzahl, gleiche Summen.

## 5. Nicht in diesem Schritt

- Speichern, Freigeben, Drucken oder Versenden der API-Abrechnung.
- myPOS per API (erst prüfen, ob myPOS eine API hat).
- Uber-Daten vor KW38 nachholen. `uber-sync` holt bisher nur KW38; ob ein
  Nachholen von KW37 über das Abrechnungsfenster geht, ist offen und gehört in
  einen eigenen Schritt.
- Umstellung der Fahrerapp oder des AbrechnungsBots.
- Historische Prozent-Sätze: es gilt der heutige Stand in `fahrer`.
