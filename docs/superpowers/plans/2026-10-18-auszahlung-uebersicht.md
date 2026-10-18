# Auszahlung in der Abrechnungs-Übersicht – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Betreiber 18.10.: „bau es“, schnell – native).

**Goal:** Status je Fahrer/Woche (Revolut/bar/Schulden) an einer Stelle rechnen und in einer aufgeräumten Übersicht zeigen.
**Architecture:** SQL-Basisfunktion `auszahlung_status_basis(woche)` → Wrapper für Büro, Revolut-Edge-Function und Fahrerapp.
Neue Tabellen `auszahlung_weg`, `bar_auszahlungen`. Dashboard lädt den Status je Woche und zeichnet Kacheln + Spalte.
**Tech Stack:** Supabase Postgres (PGlite-Test), Deno Edge Function, Vanilla JS.
**Spec:** `docs/superpowers/specs/2026-10-18-auszahlung-uebersicht-design.md`

## Global Constraints
- Beträge nie aus dem Browser; Sperren in der Datenbank. Kassabuch nur über `kassa_einfuegen`, nie UPDATE/DELETE.
- Fahrerapp zeigt nur Überweisungen, nie „bar“.
- Deutsch, Muster aus `migrations/2026-09-23-fahrerapp.sql` (security definer, search_path, revoke/grant).

## Abweichung von der Spec (bewusst, Tempo)
- *rest_offen* wird immer **bar** beglichen („bar ausgezahlt“ zahlt den Rest). Ein zweiter Revolut-Posten je Woche/Fahrer
  würde `revolut_zahlungen unique(woche, nr)` sprengen – nicht in diesem Schritt.

## Review Focus
1. Zahlung in Revolut-App + CSV + Bar für denselben Fahrer → Summe zählt jede Quelle einmal, Status *zu_viel* sichtbar.
2. Woche schon gesamt im Kassabuch → kein „bar ausgezahlt“, Wochenbuchung nach Bar-Zeile gesperrt.
3. Doppelklick „bar ausgezahlt“ → nur eine Kassabuch-Zeile (Status-Prüfung unter Sperre).
4. Fahrer mit zwei Abrechnungszeilen (Alias) → ein Status, an beiden Zeilen.
5. Revolut nicht erreichbar → Übersicht/Kacheln trotzdem da, nur Kontostand fehlt.

## Tasks
### Task 1: Datenbank `migrations/2026-10-19-auszahlung-status.sql` + Test `scripts/test-bankdaten.mjs`
Tabellen, `auszahlung_status_basis`, `auszahlung_status` (Büro), `auszahlung_weg_setzen`, `bar_auszahlen`, `bar_rueckgaengig`,
Kassabuch-Trigger `kassa_bar_sperre`, `kassa_abrechnung_stand` ohne Bar-Wochen, `revolut_kandidaten` auf Status umgestellt,
`fahrer_app_auszahlung`. Test: alle Statuswerte, Sperren, Kassabuch-Zeile/Storno, Fahrerapp. → live einspielen, Commit.
### Task 2: Edge Function `revolut-auszahlung` – Aktion `konto` (nur Kontostand, schnell). Deploy, Commit.
### Task 3: Dashboard – Wochen-Leiste (3 Kacheln), Filter Alle/Offen/Revolut/Bar/Schulden, ⋯-Menü, Spalte „Auszahlung“
mit Aktionen, Bar-Liste drucken; entfernt: IBAN-Punkt, „bereits überwiesen“, Knopfreihe. `check-dashboard.sh`, Commit.
### Task 4: Fahrerapp – Zeile „Wird überwiesen / Überwiesen am … auf ••••1234“ auf Start. Syntax-Check, Commit.
### Task 5: CLAUDE.md, Cache-Version, Push, Sichtprüfung.
