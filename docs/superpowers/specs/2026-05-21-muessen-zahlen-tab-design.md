# Müssen zahlen — Tab mit Kassier-Erfassung

**Datum:** 2026-05-21
**Branch:** `feature/muessen-zahlen-tab`
**Status:** Design — wartet auf User-Review

## Ziel

Einen eigenen Tab "Müssen zahlen" im Dashboard, in dem alle Fahrer-Schulden über alle Wochen sichtbar sind. Eingeloggte User können kassierte Beträge eintragen (auch Teilzahlungen), und es ist nachvollziehbar wer wann wieviel kassiert hat.

## Harte Randbedingung

**Die bestehende Berechnungs-Logik darf nicht verändert werden.** Konkret:
- `settlements.auszahlung` wird durch den neuen Tab niemals geschrieben.
- Die `korrektur`-Spalte und der bestehende Korrektur-Workflow bleiben unangetastet.
- Der n8n-CSV-Workflow bleibt unverändert.
- Der bestehende Filter-Button "Müssen zahlen" im Abrechnungen-Tab bleibt erhalten (KW-spezifische Schnellansicht).

Der "offene Restbetrag" einer Schuld wird **beim Anzeigen** berechnet:
`offen = abs(settlements.auszahlung) − Σ kassier_zahlungen.betrag` (für `auszahlung < 0`).

## Datenmodell

Neue Supabase-Tabelle `kassier_zahlungen`:

| Spalte | Typ | Hinweis |
|---|---|---|
| `id` | uuid PK, default `gen_random_uuid()` | |
| `fahrer_name` | text, NOT NULL | Referenz auf `settlements.fahrer_name` |
| `woche` | text, NOT NULL | Referenz auf `settlements.woche` (z.B. "KW17") |
| `betrag` | numeric(10,2), NOT NULL, CHECK > 0 | Positiv = wie viel kassiert wurde |
| `typ` | text, NOT NULL, CHECK in (`bar`, `ueberweisung`, `verrechnet`) | |
| `verrechnet_mit_woche` | text, NULL | Nur gesetzt wenn `typ='verrechnet'` |
| `kassiert_von` | text, NOT NULL | Wert aus `localStorage.hydralink_session.name` |
| `kassiert_at` | timestamptz, default `now()` | |
| `note` | text, NULL | Freitext optional |

Index auf `(fahrer_name, woche)` für schnelle Aggregation.

**RLS-Policies** (analog zu `name_aliases`, `customers`):
- `anon` darf SELECT (alle dürfen sehen)
- `anon` darf INSERT (alle eingeloggten User dürfen eintragen)
- `anon` darf DELETE — wird **clientseitig** auf `role='admin'` beschränkt (konsistent mit dem bestehenden Sicherheits-Pattern: anon-Key + offene RLS, Trust-the-Client)
- KEIN UPDATE — falsche Einträge werden gelöscht (Admin) und neu erfasst

**Migration:** Neue Datei `migrations/2026-05-21-add-kassier-zahlungen.sql`

## UI: Neuer Tab "Müssen zahlen"

### Tab-Reihenfolge (neu)
1. Abrechnungen
2. CSV Upload  *(verschoben)*
3. **Müssen zahlen**  *(neu)*
4. Rechnungen  *(verschoben)*

Bestehende `switchTab()`-Logik und Tab-Buttons in `dashboard.html` werden entsprechend umsortiert. Tab-Reihenfolge in Mobile-CSS prüfen.

### Default-Ansicht
Liste aller Schulden über alle Wochen, sortiert: `offen` → `teilweise` → `erledigt` (innerhalb der Gruppen: neueste Woche oben).

**Erledigte Schulden älter als 60 Tage** (Berechnung: letzte Zahlung > 60 Tage her) werden automatisch ausgeblendet. Toggle "Alte erledigte zeigen" am Tab-Header blendet sie ein.

### Filter-Leiste (oben im Tab)
- Status-Chips: `Alle` | `Offen` | `Teilweise` | `Erledigt`
- Fahrer-Suche (Textfeld)
- Wochenfilter (optional, Dropdown, Default = alle Wochen)
- Toggle "Alte erledigte (>60 Tage) zeigen"

### Tabellen-Zeile pro Schuld
```
Fahrer Mustermann      KW17    Schuld: 120,00 €
                                Kassiert: 50,00 € (Boyko, 12.05.)
                                Offen: 70,00 €    [Status: teilweise]
                                [+ Kassieren eintragen]  [▾ Historie]
```

Status-Logik:
- `offen`: keine Zahlungen vorhanden
- `teilweise`: Σ Zahlungen > 0 und < abs(auszahlung)
- `erledigt`: Σ Zahlungen ≥ abs(auszahlung)

### Eintrags-Modal (Klick "+ Kassieren eintragen")
Felder:
- **Betrag** (numerisch, Default = aktueller offener Restbetrag)
- **Typ** (Radio/Dropdown): `Bar` / `Überweisung` / `Verrechnet mit Woche…`
  - Bei `Verrechnet`: Pflichtfeld Wochen-Auswahl (`verrechnet_mit_woche`)
- **Notiz** (Textfeld, optional)
- Submit → INSERT in `kassier_zahlungen` mit `kassiert_von` aus Session
- Nach Erfolg: Modal zu, Liste refresh

**Validation:**
- `betrag > 0`
- `betrag` darf den offenen Restbetrag überschreiten (z.B. Trinkgeld) — Warnung, aber kein Block. Note wird empfohlen.

### Historie pro Schuld (ausklappbar)
Alle Zahlungen tabellarisch:
- Betrag, Typ (mit Icon), kassiert_von, kassiert_at, Notiz
- Falls `typ=verrechnet`: zusätzlich `verrechnet_mit_woche`
- Wenn `role='admin'`: 🗑 Löschen-Button pro Zeile (Confirm-Dialog)

## Auth / Session-Nutzung

Bestehender Session-Mechanismus (`localStorage.hydralink_session` mit `name`, `role`) wird wiederverwendet:
- `kassiert_von` = `session.name`
- Löschen-Button nur sichtbar wenn `session.role === 'admin'`

## Komponenten-Übersicht

Alles innerhalb von `dashboard.html` (Pattern bleibt: ein File, vanilla JS). Neue Funktionen:

| Funktion | Zweck |
|---|---|
| `loadKassierZahlungen()` | SELECT aus `kassier_zahlungen`, in globale `KASSIER` Variable cachen |
| `renderMuessenZahlen()` | Tab-Inhalt rendern: Schulden aus `SETTLEMENTS` (auszahlung<0) mit `KASSIER` aggregieren |
| `getMuessenZahlenData()` | Filter/Sortier-Logik (analog zu `getData()`) |
| `openKassierModal(fahrer, woche, offen)` | Modal öffnen, Defaults setzen |
| `submitKassier()` | INSERT in `kassier_zahlungen`, reload |
| `deleteKassier(id)` | DELETE (nur admin), reload |
| `switchTab('muessenzahlen')` | Tab-Wechsel — bestehende Funktion erweitern |

## Test-Strategie

Da das Projekt keine automatisierten Tests hat, manuelle Test-Szenarien:

1. **Schuld voll kassieren (Bar)** → Status `offen` → `erledigt`, Historie zeigt Eintrag mit korrektem User
2. **Teilzahlung** → Status → `teilweise`, Offen-Betrag korrekt reduziert
3. **Zweite Teilzahlung erledigt Schuld** → Status → `erledigt`
4. **Verrechnung** → Eintrag mit `typ=verrechnet`, `verrechnet_mit_woche` korrekt gespeichert und in Historie sichtbar
5. **Admin löscht Eintrag** → Schuld geht zurück zu `teilweise`/`offen`
6. **Non-Admin** sieht keinen Lösch-Button
7. **Filter Status=Offen** zeigt nur Schulden mit Restbetrag > 0
8. **60-Tage-Cutoff**: Schuld die vor >60 Tagen erledigt wurde, ist standardmäßig ausgeblendet; Toggle macht sie sichtbar
9. **Abrechnungen-Tab unverändert**: bestehender "Müssen zahlen"-Filter funktioniert wie vorher
10. **CSV-Upload unverändert**: neue Wochen erscheinen automatisch in Müssen-zahlen-Tab

## Rollout

1. Migration in Supabase ausführen (`kassier_zahlungen` Tabelle + RLS-Policies)
2. Branch `feature/muessen-zahlen-tab` → PR → review → merge in `main`
3. Cloudflare Pages deployed automatisch
4. Smoke-Test auf Production (`hydrafleet.pages.dev`) mit 1-2 Test-Einträgen
5. CLAUDE.md updaten: Tab-Liste auf 4 Tabs erweitern, neue Tabelle `kassier_zahlungen` in Tabellen-Sektion ergänzen

## Out of Scope (explizit nicht in dieser Iteration)

- Export der Kassier-Historie (CSV/PDF)
- Telegram-Benachrichtigung an Fahrer bei Kassierung
- Automatische Verrechnung mit nächster positiver Abrechnung (bleibt manuell via Korrektur-Feld bzw. `typ=verrechnet` Marker)
- Edit-Funktion für Zahlungen (stattdessen: löschen + neu)
- Audit-Trail für gelöschte Einträge
