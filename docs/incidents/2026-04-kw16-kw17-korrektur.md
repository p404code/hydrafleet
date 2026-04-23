# Incident: KW16 2026 Abrechnungsfehler → Korrektur in KW17

**Zeitraum:** 2026-04-20 bis 2026-04-23
**Status:** Abgeschlossen
**Schweregrad:** Produktionsvorfall — Fahrer-Auszahlungen betroffen

## Was passiert ist

In 2026-KW16 wurde im AbrechnungsBot eine falsche **Uber**-CSV hochgeladen (die Bolt- und MyPOS-CSVs waren korrekt). Die Berechnung lief formal fehlerfrei, aber auf Basis falscher Uber-Daten. Ergebnis: manche Fahrer bekamen zu viel, manche zu wenig ausgezahlt.

Ursache: **manueller Fehler** (falsche Datei beim Upload), kein Bug im n8n-Workflow.

## Reaktion / Lösung

1. **DB-Schema:** Zwei additive Spalten zu `settlements` hinzugefügt: `korrektur` (NUMERIC(10,2) DEFAULT 0) und `korrektur_note` (TEXT). Migration: `migrations/2026-04-20-add-korrektur-columns.sql`.

2. **Einmal-Tool** `korrektur-kw16.html` entwickelt — standalone, nicht im Dashboard verlinkt. Funktionsweise:
   - User lädt korrekte KW16-CSVs hoch (Bolt + Uber)
   - Tool re-rechnet KW16 mit korrekten Daten
   - Vergleicht mit bestehenden KW16-settlements → Delta pro Fahrer
   - User reviewt + freigibt pro Fahrer
   - Schreibt idempotenten UPDATE in KW17: `auszahlung = auszahlung - korrektur + delta, korrektur = delta, korrektur_note = '...'`

3. **Dashboard-Anzeige:** Print-Modal, Batch-Druck, CSV-Export und Abrechnungs-Tabelle zeigen Korrektur konditional (nur wenn `korrektur != 0`). Normalbetrieb bit-identisch wenn `korrektur == 0`.

4. **n8n-Workflow:** NICHT angefasst. Korrektur läuft komplett außerhalb des n8n-Pfads.

## Bug im Korrektur-Tool (während Rollout entdeckt)

**Symptom:** Beim ersten Lauf hatte Hamzat Denisultanov ein Delta von −199,77 €, obwohl nur Uber-Korrektur gemacht wurde. Spot-Check ergab: Tool rechnete zu viel Miete ab.

**Root Cause:** Tool nutzte `fahrer.basis_miete` aus Notion-Stammdaten (aktueller Wert) zum Re-Rechnen. Wenn sich die Miete seit KW16 geändert hatte (z.B. 357 → 500), kam ein verfälschter korrekt_auszahlung-Wert raus.

**Besonders kritisch:** Bei Fahrern die der Tool-Lookup gar nicht matchen konnte (z.B. Yussuf Hasan Adow nicht in `fahrer`-Tabelle) wurde `miete = 0` verwendet, obwohl KW16 eine Miete von 480 € hatte → Delta-Vorzeichen umgedreht (+402,61 statt ~−77).

**Betroffene Fahrer (mit miete-Diff):**
| Fahrer | KW16-Miete | Stamm-Miete | Diff |
|---|---|---|---|
| Aslanbek Dombaew | 110 | 450 | +340 |
| Hüseyin Coskun | 500 | 214 | −286 |
| Yussuf Hasan Adow | 480 | (nicht gematcht) | −480 |
| Hamzat Denisultanov | 357 | 500 | +143 |
| Saifullah Gadaev | 250 | 350 | +100 |
| Georgios Vavilin | 150 | 238 | +88 |
| Adam Idigov | 250 | 200 | −50 |

## Fix

**Commit:** `ef5ca54` — *"fix: use stored KW16 miete+mietmodell in recalc instead of fahrer stammdaten"*

Tool nutzt jetzt `existing.miete` und `existing.mietmodell` aus der gespeicherten KW16-Zeile. Stammdaten dienen nur noch als Fallback wenn keine KW16-Zeile existiert (neue Fahrer).

Nach Fix:
- Hamzat: −56,77 € (vorher −199,77) ✓
- Aslanbek: −47,62 € (vorher −387,62) ✓
- Yussuf: −77,39 € (vorher fälschlich +402,61) ✓

Neue Diagnose-Log-Zeilen zeigen "Miete-Override:" und "Multi-Spelling:" für Transparenz.

## Ablauf im Überblick

1. **2026-04-20:** DB-Migration + Code-Deploy (PR #18 merged). Alles ready, aber noch nicht angewandt.
2. **2026-04-23:** User startet KW17-AbrBot-Run. **Fehler:** n8n-Webhook unreachable — Domain `hydrafleet.at` abgelaufen wegen Zahlungsausfall (7 Tage Sperre).
3. **Workaround:** Temporäre Webhook-Subdomain `n8n.vertrag-erstellen.at` angelegt (User hat Domain bei Helloly registriert, DNS via Netlify verwaltet). NPM Proxy Host + Let's Encrypt Cert eingerichtet.
4. **Code-Fix:** Webhook-URLs in `dashboard.html` umgestellt von `n8n.hydrafleet.at` → `n8n.vertrag-erstellen.at`. Commit `f43bbb8`.
5. **KW17 regulär abgerechnet** via AbrBot.
6. **Korrektur-Tool 1. Lauf:** Hamzat-Delta auffällig → Tool-Bug entdeckt.
7. **Rollback** aller KW17-Korrekturen via SQL. Tool-Fix deployed.
8. **Korrektur-Tool 2. Lauf:** Zahlen plausibel. 28 Fahrer korrigiert, 5 ausgeschlossen (unmatched + unklare Fälle: Alik Selmurzaev, Ali BIJBULATOV, Alichan Musaitov, Diini Abdi Ali, Skarleta Szilagyiova).
9. **Nettosumme −649,50 €** — Fahrer haben in Summe 650 € zu viel bekommen in KW16, wird über KW17 zurückgezogen.

## Nachgelagerte Aufgaben

- [ ] **Domain `hydrafleet.at`** nach 7-Tage-Sperre reaktivieren. Dann:
  - Webhook-URLs zurück auf `n8n.hydrafleet.at` stellen (Commit `f43bbb8` revertable)
  - Alternativ: dauerhaft bei `vertrag-erstellen.at` bleiben
  - Notion-Sync → `webhook.hydrafleet.at` ist derzeit tot (Fahrer-Sync aus Notion läuft nicht bis Domain wieder da)
- [ ] **Ausgeschlossene Fahrer** (Alik Selmurzaev, Ali BIJBULATOV, Alichan Musaitov, Diini Abdi Ali, Skarleta Szilagyiova) manuell prüfen und ggf. separat auszahlen/abziehen.
- [ ] **Stammdaten-Matching in Notion prüfen:** Yussuf Hasan Adow ist in settlements aber nicht im aktiven `fahrer`-Table. Warum?

## Rollback-Pfad (falls nötig)

```sql
UPDATE settlements
SET auszahlung = auszahlung - korrektur, korrektur = 0, korrektur_note = NULL
WHERE woche = '2026-W17';
```

## Lessons Learned

1. **Re-Kalkulationen sollten immer die historisch-angewandten Parameter nutzen** (stored values), nicht die aktuellen Stammdaten. Sonst fließen spätere Datenänderungen rückwirkend in Korrekturen ein.
2. **Unmatched-Fahrer-Fälle explizit behandeln** statt stillschweigend miete=0 anzunehmen.
3. **Spot-Checks vor dem Schreiben sind Gold wert** — User hat den Bug beim ersten Delta-Review entdeckt, bevor auch nur ein Fahrer falsch bezahlt wurde.
4. **Domain-Zahlungen im Kalender** — dieser Workaround war in 1-2 Stunden machbar, aber nur weil eine Ersatz-Domain verfügbar war. Ohne Ersatz-Domain wären 7 Tage Ausfall die Folge gewesen.

## Artefakte

- **Code-Repo:** `https://github.com/p404code/hydrafleet`
- **PR:** `#18` (gemerged am 2026-04-20)
- **Spec:** `docs/superpowers/specs/2026-04-20-kw17-korrektur-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-20-kw17-korrektur.md`
- **Migration:** `migrations/2026-04-20-add-korrektur-columns.sql`
- **Tool:** `korrektur-kw16.html` (standalone, nicht im Dashboard-Menü verlinkt)
- **Key Commits:**
  - `250b3ce` — DB-Migration
  - `441b0b9` — Tool Delta+Review-UI
  - `3ccd687` — SQL-Preview + idempotenter Write
  - `f43bbb8` — Webhook-URL-Wechsel wegen Domain-Outage
  - `ef5ca54` — **Bug-Fix:** stored miete statt stammdaten
