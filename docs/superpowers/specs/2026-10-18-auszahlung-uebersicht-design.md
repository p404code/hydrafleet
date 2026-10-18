# Auszahlung in der Abrechnungs-Übersicht – Design

**Datum:** 2026-10-18 · **Stand:** im Gespräch mit dem Betreiber abgestimmt (Ansatz A, Abschnitte 1–3 bestätigt,
Korrektur „bar ist in der Fahrerapp keine Option“).

## Ziel

Der Großteil der Wochenauszahlung läuft über Revolut (Serdo, Payment-Drafts), ein kleiner Rest wird bar ausgezahlt.
Die Abrechnungs-Übersicht zeigt je Fahrer und Woche **eindeutig, was schon bezahlt ist und auf welchem Weg**, und hat
statt einer langen Knopfreihe **eine Wochen-Leiste** mit drei Kacheln. Nichts darf doppelt bezahlt werden.

Erfolg: Ein Blick auf eine Woche beantwortet „wer bekommt noch Geld, wie, und wieviel liegt dafür auf dem Konto“.

## Entscheidungen des Betreibers

| Frage | Entscheidung |
|---|---|
| Weg je Fahrer | Automatisch: geprüfte Bankdaten → Revolut, sonst bar; je Woche umstellbar |
| Bar festhalten | Je Fahrer „bar ausgezahlt“ → eigene Kassabuch-Zeile |
| Aufbau | Ansatz A: Status-Spalte + Wochen-Leiste in der Übersicht, Nebenfunktionen im ⋯-Menü |
| Fahrerapp | Zeigt nur Überweisungen; **bar kommt in der App nicht vor** |
| Revolut-Entwürfe | für alle freigegebenen Wochen möglich (ältere mit Warnhinweis, Stand 18.10.) |

## 1. Logik: ein Status je Fahrer und Woche

Neue Funktion `auszahlung_status(p_woche text)` (security definer, nur `is_app_user()`) ist die **einzige** Stelle,
die rechnet. Übersicht, Kacheln, Revolut-Entwurf (`revolut_kandidaten` wird darauf umgestellt) und Bar-Liste lesen
nur daraus. Je Fahrer der Woche (Zuordnung wie bisher über `settlement_fahrer`, Summe über alle seine Zeilen):

- `betrag` = Σ (`auszahlung − lohn`) der `berechnet`-Zeilen ohne `__…`.
- `weg`: `auszahlung_weg` (Hand-Umstellung der Woche) gewinnt, sonst `revolut` bei `fahrer_bank.geprueft`, sonst `bar`.
- `bezahlt_revolut`: `revolut_zahlungen` (pending/completed, Betrag der Zeile) + zugeordnete `revolut_buchungen`
  seit Freigabe ohne Vorschuss und ohne Referenz auf eine andere KW (Regel wie heute in `revolut_kandidaten`;
  eine Buchung, die schon über `revolut_zahlungen` zählt, nur einmal) + `auszahlung_export` (alte CSV).
- `bezahlt_bar`: Summe aktiver Zeilen in `bar_auszahlungen`.
- `entwurf`: offene Zeile in `revolut_zahlungen` (`reserviert`/`entwurf`).
- `status` (genau einer), in dieser Reihenfolge:
  1. `betrag < 0` → **schulden** · `betrag = 0` und nichts bezahlt → **nichts**
  2. Woche gesamt ins Kassabuch übernommen (`kassabuch.quelle = 'abrechnung'`) und `weg = bar` → **bar_woche**
     („bar (Woche im Kassabuch)“, Altbestand – keine Aktion)
  3. `entwurf` → **entwurf** · Revolut `pending` → **unterwegs**
  4. bezahlt gesamt = `betrag` (±0,01) → **ueberwiesen** bzw. **bar_ok** (nach Weg der Zahlung)
  5. bezahlt gesamt > 0 und < `betrag` → **rest_offen** (`rest` = Differenz)
  6. bezahlt gesamt > `betrag` → **zu_viel** (`rest` negativ)
  7. sonst **revolut_offen** bzw. **bar_offen** (nach `weg`)
- Rückgabe zusätzlich: Datum der letzten Zahlung, Herkunft (revolut/app/csv/bar), Fehlertext (z. B. `declined`).

**Neue Tabellen** (RLS an, Büro liest, Schreiben nur über Funktionen, Protokoll-Trigger, in `protokoll_bereich` = geld):

- `auszahlung_weg (woche, notion_fahrer_id, weg check in ('revolut','bar'), geaendert_von, geaendert_am)`, PK (woche, nr).
  `auszahlung_weg_setzen(p_woche, p_nr, p_weg)` – nur solange Status *revolut_offen*/*bar_offen*.
- `bar_auszahlungen (id, woche, notion_fahrer_id, betrag, kassabuch_id, storno_kassabuch_id, ausgezahlt_am, ausgezahlt_von)`.
  - `bar_auszahlen(p_woche, p_nr)` – Betrag = aktueller `rest` bzw. `betrag` aus `auszahlung_status`, nie aus dem Browser.
    Nur bei Status *bar_offen* oder *rest_offen* (Rest bar). Bucht über `kassa_einfuegen` eine Ausgabe
    `quelle = 'bar'` (neuer Wert im Check), `woche_abr = p_woche`, Text „Auszahlung KW42 · Name“.
  - `bar_rueckgaengig(p_id)` – Gegenbuchung im Kassabuch (wie Storno), Zeile bleibt mit `storno_kassabuch_id`.
    `kassa_storno` lehnt `quelle = 'bar'` ab (nur über `bar_rueckgaengig`), wie heute bei `abrechnung`/`posten`.
- **Kassabuch-Wochenbuchung:** `kassa_abrechnung_buchen` lehnt eine Woche ab, sobald es für sie eine
  `bar_auszahlungen`-Zeile gibt; `bar_auszahlen` lehnt eine schon gesamt übernommene Woche ab (dort *bar_woche*).
  `posten_anlegen/-loeschen` buchen weiterhin nur in übernommene Wochen.
- **Sperren in der Datenbank:** `bar_auszahlen` nur ohne offenen Entwurf/Revolut-Zahlung; `revolut_kandidaten`
  nimmt nur *revolut_offen* (und *rest_offen* mit `weg = revolut`, dann mit dem Rest als Betrag).

## 2. Abrechnungs-Übersicht

- **Kopf:** Woche ▾ · „freigegeben am …“ · Suche · **⋯-Menü** (Alle drucken, Export, Neu laden, Revolut abrufen,
  Revolut-CSV (Notfall), Häkchen „Ausgeschlossene zeigen“, „Nur Warnung“, „Nur mit Lohn“).
- **Wochen-Leiste, drei Kacheln** (aus `auszahlung_status`):
  - **Revolut:** Anzahl · Summe · „x offen · y überwiesen“ · Kontostand Main (Warnung, wenn zu wenig) ·
    **[Entwurf anlegen (n)]** → schlanker Dialog, Vorauswahl alle *revolut_offen*, abwählbar, ältere Woche mit Warnhinweis.
  - **Bar:** Anzahl · Summe · „x offen · y ✓“ · **[Bar-Liste drucken]** (Name, Betrag, Unterschriftsfeld).
  - **Schulden:** Anzahl · Summe · Link zu Kassieren.
  - Nicht freigegebene Woche: Kacheln grau mit „Erst freigeben“.
- **Filter-Chips:** Alle · Offen · Revolut · Bar · Schulden.
- **Neue Spalte „Auszahlung“** (letzte Spalte): Status-Punkt + Text + Datum, rechts genau eine Aktion:
  *⇄ bar* / *⇄ Revolut* (bei offen), *bar ausgezahlt* (bar_offen, rest_offen bar), *rückgängig* (bar_ok).
  Klick auf den Status → Details (Herkunft, Referenz, Revolut-Status, Fehler).
- **Entfällt:** blauer IBAN-Punkt mit Ring, Chip „bereits überwiesen“, Knöpfe Revolut-CSV/Revolut-Entwurf/Export/
  Alle drucken in der Kopfzeile, `ueberwiesenFilter`-Logik.
- **Handy:** Kacheln untereinander; Tabelle Fahrer · Du bekommst · Status, Aktion in der aufklappbaren Zeile.

## 3. Fahrerapp

Unter „Du bekommst“ der neuesten freigegebenen Woche eine Zeile, **nur für Überweisungen**:
*„Wird überwiesen“* (Entwurf/unterwegs) oder *„Überwiesen am 15.10. auf ••••9859“*. Bei Weg bar, bar ausgezahlt,
Schulden oder nichts: **keine Zeile**. Quelle: `fahrer_app_auszahlung(p_fahrer_id)` (eigener Fahrer, Vorschau-Muster),
liefert nur `status in ('entwurf','unterwegs','ueberwiesen')`, Datum, IBAN-Ende. Die Überweisungsliste unter
Bankdaten bleibt.

## Übergang

- KW41 und früher: Status aus vorhandenen Daten (CSV, Revolut-Buchungen, Entwürfe). Gesamt übernommene
  Kassabuch-Wochen → Bar-Fahrer *bar_woche*.
- Ab der ersten nicht übernommenen Woche nur noch „bar ausgezahlt“ je Fahrer.
- `auszahlung_liste` / Revolut-CSV-Dialog bleiben unverändert für den Notfall (⋯-Menü).

## Fehlerfälle

- Revolut nicht erreichbar → Revolut-Kachel zeigt „Kontostand nicht abrufbar“, Rest der Seite funktioniert.
- Bar ausgezahlt bei laufendem Entwurf / Entwurf bei bar ausgezahlt → Datenbank lehnt mit Grund ab.
- Betrag ändert sich nach Zahlung → *rest_offen* / *zu_viel*, nichts wird still angepasst.
- Kassabuch-Woche abgeschlossen → `kassa_einfuegen` meldet das wie heute („bitte morgen buchen“).

## Tests

- PGlite (`scripts/test-bankdaten.mjs` bzw. neue `scripts/test-auszahlung.mjs`): jeder Statuswert, jede Quelle,
  Reihenfolge der Regeln, Sperren in beide Richtungen, `bar_auszahlen` + Kassabuch-Zeile + `bar_rueckgaengig`,
  Wochenbuchung gesperrt, Weg-Umstellung, Fahrerapp sieht nie „bar“ und nie fremde Fahrer.
- Bestehende Tests (Bankdaten, Revolut-Logik, Kassabuch/Protokoll) laufen weiter grün.
- `scripts/check-dashboard.sh`, Syntax-Check Fahrerapp, Sichtprüfung Desktop + 390 px.

## Bewusst nicht dabei

Automatischer Zeitplan für Entwürfe · Aufteilung eines Fahrers auf Revolut **und** bar in einer Woche
(außer Rest über *rest_offen*) · Änderungen an Kassieren/Schulden · Abschalten der Revolut-CSV.
