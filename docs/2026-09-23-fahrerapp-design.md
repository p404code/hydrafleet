# Fahrerapp — Design

**Datum:** 2026-09-23
**Stand:** Design abgestimmt mit dem Betreiber, nichts davon gebaut.
**Gehört zu:** `docs/2026-09-23-fahrerapp-plan.md` (Abschnitt 0 hat Vorrang) und
`docs/2026-09-23-fahrerapp-admin-plan.md`.
**Ansehen:** `docs/fahrerapp-design.html` im Browser öffnen — alle 9 Screens in
390 × 844 px, die Links springen zwischen den Screens.

Die Beispielzahlen sind echte Daten (Mohamed Nasef, KW 38, aus `settlements`,
`fahrer` und dem Notion-Fuhrpark, Stand 23.09.). Sie zeigen, dass der Aufbau mit
realen Werten funktioniert — auch mit Nullen, einer negativen Woche und einer
Sonderwoche `2026-W37k`.

---

## Look

Exakt das Redesign v2 aus `dashboard.html` (Spec
`docs/superpowers/specs/2026-09-10-hydralink-redesign-design.md`):

- Hell als Standard, Dunkel als Schalter unter „Mehr".
- Tokens: `--bg #FBFBFC`, `--surface #FFF`, `--surface-2 #F1F3F5`, `--border #E6E8EB`,
  `--border-strong #CFD4DA`, `--text #101418`, `--text-mut #6B7280`, `--text-dim #B0B6BF`,
  `--accent #0B6B4F`, `--err #B42318`, `--warn #B45309`.
- Zahlen in `--mono` mit `tabular-nums`, Nullen grau, Status als 7-px-Punkt.
- Kopfleiste 46 px mit „HYDRA link", Kopfbereich wie `.hero` (Titel links, grosse
  Zahl rechts), Kennzahlen wie `.kpi-item`, Detailzeilen wie `.detail-kv`.
- Buttons wie `.btn-primary` (schwarz) und `.btn-ghost` (weiss mit Rahmen), Chips
  wie `.chip`. Keine Schatten, keine farbigen Badges.
- Leiste unten, 5 Reiter: **Start · Abrechnung · Nachrichten · Fahrzeug · Mehr**.
  Aktiver Reiter schwarz und fett.

## Screens

| # | Screen | Inhalt | Datenquelle | Phase |
|---|---|---|---|---|
| 1 | **Login** | Fahrer-ID (`FHR-` fest, Zahl eingeben) + 6 PIN-Kästchen, „Anmelden", Hinweis „PIN vergessen? Bitte im Büro melden." | Supabase Auth | v1 |
| 2 | **Start** | Kopf: aktuelle freigegebene KW, Datum, grosse Zahl „Du bekommst". Kacheln: Umsatz brutto, Pauschale + %, Lohn überwiesen, Noch offen. Knopf „Abrechnung KW ansehen". Block **Dienstgeber**: Firma, „Dienstvertrag PDF", Geschäftsführer/Ansprechperson. **Frühere Wochen: max. 2.** | `fahrer_app_abrechnungen()`, `fahrer_app_profil()` | v1 (Dienstgeber-Block: sobald Firma/GF/PDF-Quelle geklärt) |
| 3 | **Abrechnung KW** | Name, `FHR-…`, Kennzeichen, Modell. Genau der Druckzettel: Einnahmen brutto (Bolt, Uber, MyPOS, Gesamt), Netto (Bolt/Uber Auszahlung, Wir bekommen), Abzüge (Pauschale, Prozent, gesamt), Korrektur falls ≠ 0, „Lohn bereits überwiesen", Auszahlung vor Lohn, **Du bekommst**. Knöpfe „Als Bild speichern" und „Frage per WhatsApp". | wie `detailHtml()` / `printDriver()` | v1 |
| 4 | **Offen** | Summe offen gross (rot), Kacheln Schuld / Kassiert / Wochen. Je Woche: Status-Punkt, „Schuld x · kassiert y", offener Betrag, darunter die Zahlungen (Datum · Art · Betrag). Leer-Zustand „Du schuldest uns nichts". | `settlements.auszahlung < 0` + `kassier_zahlungen`, nur freigegebene Wochen | v1 |
| 5 | **Kontakt** | **WhatsApp-Bot**: „In WhatsApp öffnen", Beispielchat, Befehle (Abrechnung, Lohnzettel, Schaden, Büro), Notfall 112. | statisch + WhatsApp-Nummer | v1 (Nummer offen) |
| 6 | **Mehr** | Name, `FHR-…`, Modell, Kennzeichen. Links: Lohnzettel, Offene Beträge, Kontakt. Dunkles Design, Abmelden. | `fahrer_app_profil()` | v1 |
| 7 | **Fahrzeug** | Kennzeichen, Modell, Firma, Status. Kacheln: Pickerl bis, Kilometerstand, Reifen, Dashcam, Taxameter, Modell. **Dokumente als PDF: GISA, Mietvertrag, Vollmacht, Polizze.** Kontrolle & Schäden, „Neuen Schaden melden (Foto)". | `fuhrpark` (Notion) | Phase 2, erst nach Notion-Korrektur |
| 8 | **Lohnzettel** | Jahr, Firma, Summe Lohn. Monatliche Lohnzettel als PDF. „Lohn in der Wochenabrechnung" je KW. | `settlements.lohn` + PDF-Ablage | Phase 2 |
| 9 | **Nachrichten** | Liste vom Büro (ungelesen grün hinterlegt), Chips Alle / Ungelesen / Wichtig, „Antworten über WhatsApp". | neue Tabelle, noch nicht geplant | Phase 2 |

## Offen für das Design

- **PDF-Ablage** für Dienstvertrag, GISA, Mietvertrag, Vollmacht, Polizze,
  Lohnzettel: wo liegen die Dateien (Notion-Datei-Spalte? Supabase Storage,
  privater Bucket pro Fahrer?). Notion hat heute nur `Zulassungschein` als
  Datei-Spalte, `Polizze` ist Text.
- **Dienstgeber und Geschäftsführer** kommen heute nirgends aus der Datenbank.
  Im Beispiel: E&E Taxi KG, Ladislav Kallay (vom Betreiber genannt).
- **WhatsApp-Nummer** des Bots.
- **Rückblick** laut Abschnitt 0: aktuelle Woche + 2 davor — Start zeigt das so.
- Screens für v1 sind 1–6; 7–9 sind gezeichnet, damit die Navigation von Anfang
  an stimmt. Bis Phase 2 können die Reiter „Nachrichten" und „Fahrzeug" fehlen
  oder ausgegraut sein — das entscheidet die Code-Session mit dem Betreiber.
