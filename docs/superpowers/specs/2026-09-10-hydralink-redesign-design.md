# HYDRAlink Redesign v2 — Design-Spec

**Datum:** 2026-09-10
**Status:** Vom User freigegeben (Brainstorming-Session mit Mockups, siehe `.superpowers/brainstorm/47675-1789070903/content/`)
**Grundlage:** `main` ab Commit `62c514e` (inkl. Lohn-Spalte, 1000-Zeilen-Pagination, Mobil-Fixes Müssen-zahlen)

## Ziel

Das Dashboard wirkt "billig und unübersichtlich" und ist am Handy schlecht benutzbar. Ziel: hochwertiger, ruhiger Look mit deutlich weniger Elementen, und ein mobil-taugliches Layout für die beiden Handy-Hauptfälle:

1. Abrechnungen einer Woche anschauen, einzelne Fahrer nachschlagen
2. Kassieren im Tab "Müssen zahlen"

Upload und Rechnungen bleiben Desktop-lastig und werden nur umgefärbt.

## Harte Regel

**Die Funktionsweise ändert sich nicht.** Berechnung, Datenladen, Speichern (Lohn, Kassier-Zahlungen), Drucken, Batch-Druck, WhatsApp-Share, CSV-Export, Ausschließen, Alias-Zuordnung, Rollen/Rechte (Admin-Löschen, `LOHN_EDITORS`), Session-Handling, n8n-Webhooks: alles bleibt 1:1. Es ändern sich Aussehen, Anordnung und Interaktionsform (Aufklappen/Panel statt Modal).

## Nutzer

Der Betreiber plus ein bis zwei Büro-Personen, alle mit denselben Aufgaben. Keine getrennten Ansichten pro Rolle nötig.

## Vorgehen

- Neue Datei `dashboard-neu.html` neben `dashboard.html`, gleiche JS-Logik (kopiert, nicht geteilt). Cloudflare Pages liefert beide aus, Parallelbetrieb ca. eine Woche.
- Nach Freigabe: `dashboard-neu.html` → `dashboard.html`, alte Version bleibt als `dashboard-alt.html` im Repo als Rückfall (nicht verlinkt).
- Weiterhin eine HTML-Datei pro Seite, kein Build, kein Framework, Supabase-JS per CDN (CLAUDE.md).
- Reihenfolge: (1) Tokens + Navigation + Shell, (2) Abrechnung, (3) Kassieren, (4) Upload + Rechnungen Recolor, (5) Umbenennung/Go-live.

## Visuelle Sprache

- **Hell als Standard**, Dunkel bleibt als Schalter (Theme-Toggle in der Kopfleiste, `data-theme` wie heute).
- **Farben (hell):** Hintergrund `#fbfbfc`, Flächen `#fff`, Linien `#e6e8eb`, Text `#101418`, sekundär `#6b7280`. Akzente sparsam: Grün `#0b6b4f` für Auszahlung/erledigt, Rot `#b42318` für Schulden/offen, Orange `#b45309` für teilweise. Gold/Glow entfällt.
- **Schrift:** System-Sans (Inter-Fallback) für Text, Monospace (JetBrains Mono, tabular-nums) für alle Zahlen.
- **Weniger Elemente:** keine Schatten, keine farbigen Badges pro Mietmodell, keine Icon-Kacheln. Status als 7px-Punkt vor dem Namen. Nullen in Zahlenspalten grau.
- **Chips** statt Filter-Buttons: schwarz gefüllt wenn aktiv, sonst weiß mit Rahmen.

## Navigation

- **Handy (< 768px):** Tab-Leiste fest unten (Abrechnung · Kassieren · Upload · Rechnungen), Safe-Area beachtet.
- **Desktop:** Kopfleiste oben mit Logo "HYDRA link", Tabs, Theme-Schalter, Benutzername/Logout.
- Gleiche vier Tabs, gleiche IDs/Handler (`switchTab`).

## Tab Abrechnung

**Kopf (beide Breiten):**
- Wochenwähler `KW 37 ▾` mit Von-bis-Datum (Mo–So der ISO-Woche, z.B. "7. – 13. Sept 2026") und Fahreranzahl.
- **"Auszahlungen (tatsächlich)"** als größte Zahl (grün). Berechnung wie heute (`auszahlungPositiv`).
- Kennzahlen: Zu kassieren, Bei uns bleibt, Probleme; am Desktop zusätzlich Fahrer und "Eingänge am Konto" (Bolt/Uber/MyPOS, Werte wie heute aus `__TRANSFER__`).

**Filterleiste (sticky):** Suche (Fahrer, live), Chips: Alle · Schulden · Warnung · Ausgeschlossen (n) · **Lohn eingetragen (n)**. Desktop rechts: Alle drucken, Export, Reload.
- "Lohn eingetragen": zeigt nur Zeilen mit `lohn > 0`, sortiert nach Lohn absteigend, Hinweiszeile mit Anzahl und Lohnsumme.
- "Schulden" entspricht dem heutigen `warningFilter` (Müssen zahlen), "Warnung" = Status enthält WARNUNG.

**Tabelle:** fünf Spalten **Fahrer · MyPOS · Lohn · Pauschale · Auszahlung**. Alle Spaltentitel sortierbar (Pfeil zeigt Richtung). Auszahlung fett, 2 Dezimalen, breiteste Zahlenspalte; MyPOS/Lohn/Pauschale ganze Euro. `table-layout: fixed`, Spaltenbreiten prozentual (Name 31%, MyPOS 12%, Lohn 16%, Pauschale 13%, Auszahlung 28% am Handy); lange Namen mit Ellipsis. Korrektur-Hinweis (`korrektur != 0`) bleibt sichtbar unter dem Namen.

**Detail (Klick auf Fahrer):**
- Handy: Zeile klappt darunter auf (nur eine offen).
- Desktop: Seitenpanel rechts (330px), Tabelle bleibt sichtbar, Klick auf anderen Fahrer wechselt das Panel.
- Inhalt: voller Name, Telefon, Modell, Kennzeichen; Einnahmen brutto (Bolt, Uber, MyPOS, Gesamt); Netto (Bolt/Uber Auszahlung, Wir bekommen); Abzüge (Pauschale, Prozent, Abzug gesamt); Korrektur falls vorhanden; **Lohn-Feld** (editierbar nur für `LOHN_EDITORS`, gleiche `saveLohn`-Logik, Enter/Blur speichert); Netto nach Lohn; Aktionen Drucken · WhatsApp · Ausschließen.
- Print-Modal, Batch-Druck, Alias-Modal, Excluded-Panel bleiben funktional gleich, werden nur umgefärbt.

## Tab Kassieren (Müssen zahlen)

**Kopf:** Summe "Noch offen" (rot, groß) mit Anzahl Fahrer; Kennzahlen: diese Woche kassiert, Teilweise, Erledigt. Wochenbereich-Wähler (Standard: letzte 4 Wochen wie heute, "Alle Wochen" und "Alte erledigte > 60 Tage" bleiben als Optionen).

**Filterleiste:** Suche + Chips Offen · Teilweise · Erledigt · Alle (heutige `data-mz-status`).

**Liste:** nach Wochen gruppiert (neueste zuerst) mit Wochensumme offen. Pro Zeile: Name, "Schuld x · kassiert y" klein, offener Betrag groß (rot/orange/grün nach Status), Kassieren-Knopf. Desktop: Tabelle Fahrer · Schuld · Kassiert · Offen · Status-Pille · Letzte Zahlung (Datum · Art · Kassierer).

**Detail (Klick / Kassieren):**
- Handy: Zeile klappt auf; Desktop: Seitenpanel.
- Zahlungshistorie (Datum, Art, Kassierer, Betrag; Papierkorb nur für Admin, Bestätigung wie heute).
- Formular **inline statt Modal**: Betrag (mit "Rest übernehmen"), Art als Segment Bar · Überweisung · Verrechnet mit KW… (bei Verrechnet erscheint Wochenwahl), Notiz, Speichern/Abbrechen. Validierung, Warnungen und Insert-Logik identisch zu `mzModal*`.

## Tabs Upload und Rechnungen

Nur Tokens/Farben/Schrift/Chips übernehmen. Layout, Formulare, Handler, IDs unverändert. Am Handy müssen sie benutzbar bleiben (keine horizontalen Überläufe), mehr nicht.

## Responsiv

- Breakpoint 768px. Handy: Bottom-Nav, aufklappbare Zeilen, Kopf kompakt. Desktop: Top-Nav, Seitenpanel.
- Kleinstes Ziel 320px Breite: nichts wird abgeschnitten, Tabellen nie horizontal scrollen.
- `viewport-fit` und iOS-Overflow-Erkenntnisse aus früheren Fixes beibehalten.

## Nicht im Umfang

- Keine Änderung an Supabase-Schema, n8n, Notion, Login-Seite (`index.html` nur Recolor optional später).
- Keine neuen Features außer Chip "Lohn eingetragen" und Spaltensortierung (beides reine Anzeige).
- Kein Framework, kein Build.

## Abnahme

- Alle heutigen Aktionen in beiden Layouts durchgespielt (Lohn speichern, Kassieren eintragen, Admin-Löschen, Drucken einzeln/alle, WhatsApp, Export, Ausschließen, Alias).
- Zahlen in Kopf und Tabelle identisch zur alten `dashboard.html` für dieselbe Woche.
- Test auf 320px, 390px und Desktop, hell und dunkel.
- Eine Woche Parallelbetrieb, dann Umbenennung.
