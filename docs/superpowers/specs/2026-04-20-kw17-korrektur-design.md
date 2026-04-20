# Design — KW17-Korrektur für KW16-Abrechnungsfehler

**Datum:** 2026-04-20
**Autor:** pepe (via Claude-Brainstorming)
**Status:** Entwurf zur Review

## Kontext

In KW16/2026 wurde im AbrechnungsBot eine falsche CSV hochgeladen. Die Berechnung lief formal korrekt, aber auf Basis falscher Eingangsdaten. Ergebnis: manche Fahrer haben zu viel, manche zu wenig ausgezahlt bekommen. Ursache war ein manueller Fehler (falsche Datei), **kein Bug in der Kalkulationslogik**.

Die Korrektur erfolgt in KW17 über einen einmalig eingesetzten Delta-Mechanismus. Das System bleibt im Kern unverändert, die Abrechnungslogik wird nicht angefasst.

## Ziele

1. Fahrer, die zu wenig bekommen haben, bekommen in KW17 das Delta zusätzlich ausgezahlt
2. Fahrer, die zu viel bekommen haben, bekommen in KW17 das Delta abgezogen
3. Die Korrektur ist für den Fahrer auf Beleg/CSV/WhatsApp transparent nachvollziehbar
4. Nicht-Ziel: Automatisierung für zukünftige Fälle. Das Schema bleibt zwar drin (wiederverwendbar), das Tool ist wegwerfbar.

## Constraints

- **Produktionskritisches System** — Ausfallrisiko minimieren
- **n8n-Kalkulationsworkflow** darf nicht angefasst werden
- Änderungen an `dashboard.html` nur konditional (`if korrektur != 0`), Normalbetrieb bit-identisch
- DB-Änderungen strikt additiv (nullable / DEFAULT 0)
- Rollback-Pfad für jeden Schritt dokumentiert

## Architektur-Überblick

### Komponenten

| Komponente | Änderung | Risiko |
|---|---|---|
| `settlements` Tabelle | 2 neue Spalten (additiv) | Niedrig |
| n8n AbrechnungsBot | **Keine** | Kein |
| `dashboard.html` Anzeige/Export | Konditionale Zeile in PDF/WhatsApp/CSV | Niedrig |
| `korrektur-kw16.html` | Neue isolierte Datei | Niedrig (kein Einfluss auf Bestand) |

### Datenfluss KW17-Korrekturweek

```
1. KW17-CSVs → n8n AbrBot (unverändert)
   → settlements KW17 geschrieben (korrektur = 0)

2. Einmal-Tool korrektur-kw16.html:
   a. Liest settlements WHERE woche='2026-W16' (= ausgezahlte Beträge)
   b. Parst korrigierte KW16-CSV, rechnet neu
   c. Delta = korrekt - ausgezahlt
   d. User reviewt Tabelle, hakt ab, editiert ggf.
   e. UPDATE settlements SET korrektur=?, korrektur_note=?,
        auszahlung=auszahlung+? WHERE woche='2026-W17' AND fahrer_name=?

3. Dashboard-Export KW17 → zeigt Korrektur transparent
```

## Schema-Änderung

```sql
ALTER TABLE settlements
  ADD COLUMN korrektur NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN korrektur_note TEXT;
```

- `korrektur` NUMERIC(10,2) mit DEFAULT 0 — konsistent mit anderen Geldfeldern
- `korrektur_note` TEXT nullable
- Additive DDL, instant in PostgreSQL, keine Locks
- Bestehende und neue Zeilen ohne Korrektur bleiben semantisch identisch

**Rollback:** `ALTER TABLE settlements DROP COLUMN korrektur, DROP COLUMN korrektur_note;`

## Einmal-Tool `korrektur-kw16.html`

Standalone HTML-Datei im Repo. **Nicht** im Dashboard verlinkt — nur per direkter URL erreichbar.

### Auth
- PIN-Login via `app_users` (gleicher Flow wie `index.html`)

### Eingaben
- Upload-Feld: korrekte KW16-CSVs (Bolt + Uber + MyPOS)
- Zielwoche-Feld, Default `2026-W17` (gegen Fehlbedienung)

### Verarbeitung (clientseitig)
1. Lädt `settlements WHERE woche = '2026-W16'` aus Supabase
2. Parst hochgeladene korrekte CSVs
3. Berechnet KW16 neu via **inline kopierter Formel** (ca. 30 Zeilen aus `abrechnungsbot-berechnung-fixed.js`):
   - `bruttoumsatz_gesamt = bolt_brutto + uber_fahrpreis + mypos_summe`
   - `wir_bekommen = bolt_auszahlung + uber_auszahlung + mypos_summe`
   - Miete/Prozent-Abzug wie im Original (mietmodell f11/f12/prozent_satz)
   - `korrekt_auszahlung = wir_bekommen - miete - prozent_abzug`
4. Delta pro Fahrer: `korrekt_auszahlung - ausgezahlt_auszahlung`

**Warum kopierte Formel statt shared lib:** Minimales Risiko, keine Refactor-Exposition im n8n-Pfad. Einmalnutzung rechtfertigt keine Shared-Library.

### Review-UI
| Spalte | Verhalten |
|---|---|
| Fahrer | read-only |
| Ausgezahlt KW16 | read-only |
| Korrekt KW16 | read-only |
| Delta | editierbar (override möglich) |
| Note | editierbar (Default "Nachzahlung KW16 falsche CSV") |
| ✅ übernehmen | Checkbox, Default angehakt |

- Default-Filter: nur Zeilen mit `delta != 0`
- Toggle "Alle anzeigen"
- Gesamtsumme Delta als Sanity-Check angezeigt (Nullsummenspiel? Wenn nicht, warum?)

### Schreibmodus
1. Button **"SQL-Preview"** → zeigt alle UPDATE-Statements im Modal, nichts passiert
2. Button **"In KW17 schreiben"** → Confirm-Dialog mit Zielwoche + Anzahl Zeilen
3. Pre-Check: Zielwoche-settlements existieren? Wenn nicht → Abort mit Hinweis
4. UPDATE pro Fahrer:
   ```sql
   UPDATE settlements
   SET korrektur = <delta>,
       korrektur_note = <note>,
       auszahlung = auszahlung + <delta>
   WHERE woche = '2026-W17' AND fahrer_name = <name>
   ```
5. Nach Abschluss: Download-Button "Audit-Log als .txt" (Zeitstempel, User, Deltas)

### Idempotenz
- **Problem:** `auszahlung = auszahlung + delta` ist nicht idempotent — zweimal ausgeführt doppelt addiert.
- **Lösung:** Vor UPDATE aktuelle `korrektur` der Zeile lesen. Wenn `!= 0`: Warnung "Zeile schon korrigiert (X €), überschreiben?". SQL:
  ```sql
  UPDATE settlements
  SET auszahlung = auszahlung - korrektur + <neuer_delta>,
      korrektur = <neuer_delta>,
      korrektur_note = <note>
  WHERE woche = '2026-W17' AND fahrer_name = <name>
  ```
  PostgreSQL evaluiert RHS vor Assignment — `korrektur` in RHS ist der alte Wert. Damit idempotent.

## n8n AbrechnungsBot

**Keine Änderung.** Der Workflow schreibt KW17 weiterhin mit `korrektur = 0` (DEFAULT). Die Korrektur wird im Anschluss durch das Tool per UPDATE reingeschrieben.

**Begründung:** Null Deploy-Risiko im kritischen Pfad. Das Tool übernimmt die gesamte Korrektur-Verantwortung.

## Dashboard-Anzeige & Export

Änderungen in `dashboard.html` **strikt konditional**:

- Wenn `korrektur == 0`: Ausgabe exakt wie bisher
- Wenn `korrektur != 0`: zusätzliche Zeile/Spalte mit Betrag + Note

Betroffene Stellen (bei Implementierung zu lokalisieren):
1. Abrechnungs-Detailansicht (Einzel-Fahrer-Card)
2. CSV-Export
3. WhatsApp-Share-Text
4. Print/PDF

Format der neuen Zeile:
- `Korrektur KW16 (falsche CSV): +25,00 €` (positive → grün)
- `Korrektur KW16 (falsche CSV): -30,00 €` (negative → rot)

Die finale Auszahlung zeigt den **bereits korrigierten** Wert. Die Korrektur-Zeile erklärt die Differenz zum sonst erwarteten Betrag.

## Test & Rollout

### Vor Produktion
1. Schema-Migration in Staging/Test-Setup oder gegen Dummy-`woche='TEST'`-Zeilen
2. Einmal-Tool gegen manuell eingefügte Test-settlements (Fake-KW16 + Fake-KW17) prüfen
3. SQL-Preview-Button immer zuerst verwenden
4. Dashboard-Ausgabe mit Test-Korrektur prüfen (CSV, WhatsApp, PDF)

### Rollout-Reihenfolge
1. `ALTER TABLE` ausführen (keine Auswirkung auf Normalbetrieb)
2. `korrektur-kw16.html` deployen (nicht verlinken)
3. `dashboard.html` konditionale Änderungen deployen
4. KW17-CSVs regulär verarbeiten — Baseline-Test: alles normal?
5. Einmal-Tool anwenden, SQL-Preview, Audit-Log archivieren
6. Dashboard-Review pro Fahrer
7. CSV/PDF/WhatsApp rausschicken

### Notbremse
```sql
UPDATE settlements
SET auszahlung = auszahlung - korrektur,
    korrektur = 0,
    korrektur_note = NULL
WHERE woche = '2026-W17';
```
Danach Export neu generieren → zurück auf unkorrigierten Zustand.

## Offene Punkte (bei Implementierung zu klären)

- Wo genau in `dashboard.html` sitzt der CSV-Export-Code und der WhatsApp-Text-Builder
- PDF-Generierung: läuft die im Dashboard oder in n8n? (betrifft Ort der Änderung)
- Sollen `korrektur != 0` Zeilen auch irgendwo als Dashboard-Badge markiert werden?

## Nicht-Ziele / YAGNI

- Keine allgemeine Korrektur-UI im Dashboard
- Keine Audit-Tabelle in Supabase (Client-Download reicht für einmaligen Fall)
- Keine Telegram-Benachrichtigung (ist eh deaktiviert)
- Keine Historie mehrerer Korrekturen pro Zeile (nur letzte gewinnt)
