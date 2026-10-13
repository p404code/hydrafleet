# KW41/2026: Bolt-Umsatz vom EH-Konto in die Abrechnung nachgetragen

**Datum:** 2026-10-13 · **Auftrag:** Betreiber („API-Daten von Bolt, die fehlen, direkt in die Endabrechnung“)

## Was war

Für KW41 wurde nur die Bolt-CSV von SERDO TAXI KG hochgeladen. Drei Fahrer fuhren aber noch auf dem
Bolt-Konto von EH Limousinenservice KG (`company_id` 262554). Der AbrechnungsBot rechnete ihren
Bolt-Umsatz deshalb mit 0. Die API-Abrechnung (`api_abrechnung`) hatte die Aufträge, weil `bolt-sync`
beide Konten abruft.

## Was geändert wurde

Drei Zeilen in `settlements`, Woche `2026-W41`, per SQL aus `api_abrechnung` übernommen
(Bolt-Felder und alles, was daraus folgt; Uber, myPOS, Miete, Korrektur, Lohn unverändert):

| id | Fahrer | bolt_brutto | bolt_auszahlung | prozent_abzug | auszahlung vorher → nachher |
|---|---|---|---|---|---|
| 158014 | Aaron Brown | 0 → 272,00 | 0 → 137,14 | 0 → 0 | 1.120,16 → 1.257,30 |
| 158036 | Alik Selmurzaev | 0 → 203,30 | 0 → 109,81 | 0 → 0 | 371,87 → 481,68 |
| 158002 | Dschunid Saluev | 0 → 316,80 | 0 → 193,24 | 7,43 → 39,11 | 500,84 → 662,40 |

Summe der Auszahlungen +408,51 €. Vorher geprüft: keine Zu-/Abschläge, keine Kassier-Zahlung, kein
Kassabuch-Eintrag für diese Fahrer in KW41. Die Woche war schon freigegeben (13.10. 16:08, Summe
27.313,57 €) – die gespeicherte Freigabe-Summe ist seither um 408,51 € zu niedrig, bis neu freigegeben wird.

## Zusätzlich: Mahmoud Hemdan

Die Bolt-CSV führt ihn als „Mahmoud Mahmoud Deif Alla Mohamed Deif Alla Hemdan“. Der Bot fand ihn nicht und
rechnete „UNBEKANNT“ ohne Pauschale (Status `WARNUNG_KEIN_FAHRER`). Alias in `name_aliases` eingetragen
(greift ab dem nächsten Bot-Lauf) und die KW41-Zeile `158055` so gesetzt, wie der Bot sie mit Alias schreibt:

| Feld | vorher | nachher |
|---|---|---|
| fahrer_name | Mahmoud Mahmoud Deif Alla Mohamed Deif Alla Hemdan | Mahmoud Hemdan |
| telefon | (leer) | +436602345533 |
| mietmodell / miete | UNBEKANNT / 0 | f12 / 550 |
| prozent_abzug / abzug_gesamt | 0 / 0 | 179,71 / 729,71 |
| auszahlung | 1.241,65 | 511,94 |
| status | WARNUNG_KEIN_FAHRER | berechnet |

Bolt-Umsatz (2.997,10 / 1.241,65) unverändert. Die Woche hat damit 53 statt 52 berechnete Zeilen.

## Rückweg

Die Werte „vorher“ aus der Tabelle zurückschreiben; `bruttoumsatz_gesamt`, `wir_bekommen` und
`abzug_gesamt` stehen im Protokoll (Quelle „SQL-Fenster“, 13.10.2026).

## Damit es nicht wieder passiert

Solange auf dem EH-Bolt-Konto gefahren wird, gehört die EH-Bolt-CSV mit in den Upload – oder die
Fahrer ziehen zu Serdo um. Lädt jemand KW41 neu hoch, ohne die EH-Datei, überschreibt der Bot diese
drei Zeilen wieder mit Bolt = 0.
