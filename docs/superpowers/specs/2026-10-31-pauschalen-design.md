# Pauschalen in HYDRAlink – Design

Stand 31.10.2026. Abgestimmt im Gespräch mit dem Betreiber. Das ist der erste Schritt, Notion abzulösen,
angefangen bei den Pauschalen.

## Ziel

Pauschalen werden **im Dashboard gepflegt, je Fahrer**, mit **Verlauf**: Man sieht, wer wann was geändert hat
(„Mohamed hat die Pauschale am 10.10. geändert“) und ab welcher Woche es gilt. Notion zählt für die Pauschale nicht mehr.
Der Weg soll **überschaubar und schnell** sein: AbrechnungsBot und n8n-Syncs bleiben im Aufbau, wie sie sind.

Festgelegt vom Betreiber:
- Was stört heute: **kein Verlauf**, **Sync unzuverlässig** (Notion → `fahrer` kommt nicht oder zu spät an),
  **Pauschale hängt am Auto statt am Fahrer**.
- Die Pauschale gilt **nur je Fahrer**. Das Auto hat keine Pauschale mehr.
- Eine Änderung gilt **nur für Wochen, die noch nicht freigegeben sind**. Freigegebene Wochen bleiben, Korrekturen
  dort weiter über Zu-/Abschläge.
- **Alle Büro-Benutzer** (admin und user) dürfen ändern. Der Verlauf zeigt, wer es war.
- Die f-Modelle bleiben, dazu kommen Sonderfälle: **Pauschale 0**, **% vom ganzen Umsatz**, **befristet andere
  Pauschale**, **anderer % / andere Schwelle**.
- Für „% vom ganzen Umsatz“ wird **eine Zeile im Bot** geändert (Schwelle 0 darf nicht zu 1.200 werden).

Nicht in diesem Schritt: Fuhrpark und Zuordnung Fahrer↔Auto aus Notion lösen · Pauschale für schon freigegebene
Wochen · Pauschale in der Fahrerapp bearbeiten · Umbau des AbrechnungsBots über die eine Zeile hinaus.

## Heute (31.10.2026)

- Notion-Fuhrpark: Felder `"Pauschale "` (mit Leerzeichen) und „Pauschal Modell“ (fix/f11/f12) **je Auto**.
- Der n8n-Fahrer-Sync / Full-Sync schreibt sie in `fahrer.basis_miete`, `mietmodell`, `prozent_satz`, `prozent_schwelle`.
- Der **AbrechnungsBot** stößt vor jeder Berechnung den Notion-Full-Sync an, liest dann
  `fahrer?select=*&aktiv=eq.true` und rechnet (`.n8n-backup/berechnung-v15.js`, Z. 540–546):
  - `f11`: Pauschale + 10 % über 1.100 €
  - `f12`: Pauschale + 10 % über 1.200 €
  - sonst, falls `prozent_satz > 0`: Pauschale + `prozent_satz` % über `prozent_schwelle`
  - `prozent_schwelle: parseFloat(f.prozent_schwelle) || 1200` → **0 wird 1.200**
- Dieselbe Regel steht in `api_abrechnung` (automatische Abrechnung, `coalesce(nullif(prozent_schwelle, 0), 1200)`),
  in `prozent_nach_regel()` (myPOS-Zuordnung) und im Dashboard (`dashboard.html` ≈ Z. 3218, Neu-Rechnen nach
  Namens-Zuordnung, `fahrer.prozent_schwelle || 1200`).
- Daten: 68 aktive Fahrer, 39× f12, 25× fix, 4× f11. Bei 7 Autos mit 2 Fahrern zahlt jeder die volle Pauschale.
  1 Fahrer weicht vom Auto ab (W4181TX: 500 € statt 450 €). 4 Fix-Fahrer haben kein Fuhrpark-Auto (230 €).
  Eigene Regel (`prozent_satz > 0` bei fix) nutzt heute niemand.

## Grundidee

```
Büro speichert im Dashboard ──► pauschalen (Verlauf, nur anhängen)
                                     │
                    pauschale_fuer(nr, woche)  ◄── welche Zeile gilt in Woche X
                                     │
     Stichwoche = nächste abzurechnende Woche (letzte freigegebene + 1)
                                     │
                                     ▼
        fahrer.basis_miete / mietmodell / prozent_*   ◄── Wächter-Trigger: n8n darf das nicht überschreiben
                                     │
     AbrechnungsBot · api_abrechnung · myPOS · Dashboard · Fahrerapp   (lesen wie bisher `fahrer`)
```

In `fahrer` steht also **immer die Pauschale der nächsten abzurechnenden Woche**. Damit rechnen Bot und
automatische Abrechnung ohne Umbau mit dem richtigen Wert.

## Daten

### Tabelle `pauschalen` (Verlauf)

| Spalte | Bedeutung |
|---|---|
| `id` bigint identity PK | |
| `fahrer_nr` integer not null | Notion-Fahrer-Nr. (`fahrer.notion_fahrer_id`), wie bei Bankdaten und Nachrichten |
| `art` text | `fix` · `f11` · `f12` · `eigene` |
| `betrag` numeric ≥ 0 | Pauschale je Woche (0 erlaubt) |
| `prozent_satz` numeric | nur `eigene`: 0 < x ≤ 100 |
| `prozent_schwelle` numeric | nur `eigene`: ≥ 0, **0 = vom ganzen Umsatz** |
| `gilt_ab` text | ISO-Woche `JJJJ-Wnn` |
| `gilt_bis` text null | ISO-Woche, inklusive. Leer = unbefristet |
| `grund` text | Pflicht bei `eigene`, bei Betrag 0 und bei befristeten Einträgen, sonst optional (max. 200) |
| `quelle` text | `hand` · `uebernahme` (Start) · `neuanlage` (neuer Fahrer aus Notion) |
| `von` text | Büro-Name aus dem JWT (`app_metadata.app_name`), sonst „Automatik“. Nie ein Parameter. |
| `am` timestamptz default now() | |

- **UPDATE, DELETE und TRUNCATE sperrt ein Trigger** (wie `kassabuch`). Zurücknehmen = neuer Eintrag.
- RLS: Büro liest, niemand schreibt direkt. Geschrieben wird nur über `pauschale_setzen` und die Automatik.
- Protokoll-Trigger anhängen (neue Tabelle mit Büro-Schreibzugriff), in `protokoll_bereich` und `PR_TAB` eintragen.

### Welche Zeile gilt: `pauschale_fuer(fahrer_nr, woche)`

Von allen Einträgen mit `gilt_ab ≤ woche` und (`gilt_bis` leer oder `≥ woche`) gilt der **zuletzt gespeicherte**
(größtes `am`, bei Gleichstand größte `id`). ISO-Wochen im Format `JJJJ-Wnn` lassen sich als Text richtig vergleichen.

Beispiel: am 01.09. „f12 500 ab KW36“, am 03.11. „fix 300 KW45–KW48, Grund Einstieg nach Unfall“
→ KW44: f12 500 · KW45–48: fix 300 · ab KW49: wieder f12 500, ohne dass jemand etwas tun muss.
Wird während der Befristung neu unbefristet gespeichert, gewinnt der neuere Eintrag und die Befristung endet früher.
So ist es auch zu erwarten: Was zuletzt gespeichert wurde, gilt.

Umsetzen in die `fahrer`-Spalten:

| `art` | `mietmodell` | `basis_miete` | `prozent_satz` | `prozent_schwelle` |
|---|---|---|---|---|
| fix | `fix` | betrag | 0 | 0 |
| f11 | `f11` | betrag | 10 | 1100 |
| f12 | `f12` | betrag | 10 | 1200 |
| eigene | `eigene` | betrag | satz | schwelle |

### Stichwoche: `pauschale_stichwoche()`

= die ISO-Woche nach der **letzten freigegebenen Woche** (`max(abrechnung_freigaben.woche)` + 1).
Montag früh vor der Freigabe von KW43 ist das KW43, nach der automatischen Freigabe um 05:00 ist es KW44.

## Funktionen und Trigger

- **`pauschale_setzen(p_fahrer_nr, p_art, p_betrag, p_prozent_satz, p_prozent_schwelle, p_gilt_ab, p_gilt_bis, p_grund)`**
  (security definer, nur Büro-Rolle admin/user):
  prüft die Regeln (Fahrer existiert; `gilt_ab ≥ Stichwoche` = nur offene Wochen; `gilt_bis ≥ gilt_ab`;
  Felder je Art; Grund-Pflicht), hängt die Zeile an und setzt danach die `fahrer`-Spalten neu
  (`pauschalen_anwenden(nr)`). Gibt die gültige Pauschale der Stichwoche zurück.
- **`pauschalen_anwenden(p_fahrer_nr default null)`**: schreibt `pauschale_fuer(nr, Stichwoche)` in alle `fahrer`-Zeilen
  dieser Nr. (bzw. aller Fahrer), nur wo sich etwas ändert. Nicht direkt aufrufbar.
- **Wächter `fahrer_pauschale_waechter`** (BEFORE INSERT OR UPDATE auf `fahrer`):
  - Hat die Fahrer-Nr. Einträge in `pauschalen` → die vier Spalten werden mit `pauschale_fuer(nr, Stichwoche)`
    überschrieben, egal was n8n schickt.
  - Hat sie keine (neuer oder reaktivierter Fahrer) → **einmalige Übernahme** der ankommenden Notion-Werte als
    Eintrag `quelle = 'neuanlage'`, `gilt_ab = Stichwoche`. Danach gilt nur noch HYDRAlink.
  - Ohne `notion_fahrer_id` wird nichts gemacht.
  - Fehler schluckt der Trigger (`raise warning`), damit der n8n-Sync nie blockiert. Das Sicherheitsnetz ist die
    Ansicht `pauschalen_abweichung`, siehe unten.
- **Trigger auf `abrechnung_freigaben`** (AFTER INSERT): `pauschalen_anwenden()`. Mit der Freigabe rückt die
  Stichwoche weiter, Befristungen beginnen bzw. enden dadurch von selbst. Das gilt auch für die automatische Freigabe
  um 05:00.
- **Ansicht `pauschalen_abweichung`**: aktive Fahrer, bei denen die `fahrer`-Spalten nicht zu
  `pauschale_fuer(nr, Stichwoche)` passen oder für die es gar keinen Eintrag gibt. Normal ist sie leer.

## Start (Übernahme)

Einmalig in der Migration, **nicht** Montag 04:00–08:00 Wien (Bot/automatische Abrechnung):
je `notion_fahrer_id` mit aktivem Fahrer ein Eintrag `quelle = 'uebernahme'`, `gilt_ab = Stichwoche`,
`von = 'Übernahme aus Notion'`, aus den heutigen `fahrer`-Werten:
`f11`/`f12` → gleiche Art · `fix` mit `prozent_satz > 0` → `eigene` · sonst `fix`.
Inaktive Fahrer bekommen ihren Eintrag erst beim Reaktivieren (Wächter, `neuanlage`).
Vorher prüfen: gibt es eine `notion_fahrer_id` mit mehreren aktiven `fahrer`-Zeilen und unterschiedlichen Werten?
→ dem Betreiber zeigen, nicht raten.

## Anzeige (Dashboard)

**Fahrer → App → Fahrer-Detail**, neuer Block „Pauschale“:
- Oben die Pauschale der Stichwoche, groß: z. B. „**f12 · 500 €** + 10 % über 1.200 €“, dazu „gilt für KW44“.
  Läuft eine Befristung oder ist eine angekündigt: „KW45–KW48: fix 300 € (Einstieg), danach f12 500 €“.
- Knopf **„Pauschale ändern“** → Formular:
  - **Art** als Chips: fix · f11 · f12 · eigene Regel
  - **Betrag** €, 0 ist erlaubt
  - nur bei „eigene Regel“: **%** und **ab Umsatz €**, Hinweis „0 € = vom ganzen Umsatz“
  - **gilt ab**: Auswahl ab der Stichwoche (frühere Wochen gibt es nicht zur Auswahl), Standard ist die Stichwoche
  - **bis** (optional, „unbefristet“ voreingestellt)
  - **Grund** (Pflicht bei eigene, bei 0 € und bei befristeten Einträgen)
  - Vorschau vor dem Speichern: „Ab KW44 zahlt Ali f12 500 € statt fix 450 €.“
- **Verlauf** darunter, neueste zuerst: „10.10. 14:32 · Mohamed · fix 450 € → f12 500 € · ab KW42 · Grund …“,
  Übernahme-Zeilen grau („Übernahme aus Notion, 31.10.“).
- Fahrer-Liste: Spalte/Unterzeile „Pauschale“ zeigt `art · betrag`, befristete mit Kennzeichen „befristet“.
- Hinweis-Karte, wenn `pauschalen_abweichung` nicht leer ist („n Fahrer: Pauschale passt nicht – bitte melden“).

## Die eine Bot-Änderung (und ihre Geschwister)

Schwelle 0 muss 0 bleiben:
- **AbrechnungsBot**, Knoten „Berechnung“: `prozent_schwelle: parseFloat(f.prozent_schwelle) || 1200`
  → leer/ungültig = 1200, **0 bleibt 0**. Vorher den **live** Code aus n8n holen (das Backup `berechnung-v15.js`
  ist evtl. nicht der letzte Stand) und gegen eine echte Woche nachrechnen: alte und neue Fassung müssen für alle
  Fahrer gleiche Ergebnisse liefern (heute hat niemand `eigene`). Änderung in n8n nur nach OK des Betreibers.
- Gleiches Muster in `api_abrechnung` (`nullif(…, 0)` raus), `prozent_nach_regel()` und `dashboard.html` (Neu-Rechnen).
- `mietmodell = 'eigene'` ist neu. Der Bot rechnet es über den dritten Zweig richtig. In der Telegram-Nachricht des
  Bots steht dann „Pauschalmodell eigene“ ohne Prozentzeile (nur Darstellung, Betrag stimmt). Optional ergänzen wir dort
  eine Zeile „📊 Prozent €x“, wenn `prozent_abzug > 0`.

## Grenzen (bewusst)

- Wird eine **schon freigegebene** Woche neu hochgeladen oder im Dashboard neu gerechnet, kommt die Pauschale der
  Stichwoche zum Einsatz, nicht die von damals. Das ist heute auch so. Dafür bleibt der Bot unverändert.
- Ändert jemand weiter das Notion-Feld, passiert nichts. → Betreiber benennt es um in
  **„Pauschale (alt – gilt nicht mehr)“** und sagt es dem Team.
- `fuhrpark.pauschale` (Notion-Kopie) und der Hinweis „keine Pauschale“ im Fuhrpark-Reiter bleiben vorerst stehen,
  sind aber bedeutungslos (Reiter ist „Experimentell“).

## Tests

- **PGlite** (`PGLITE=<dir> node scripts/test-pauschalen.mjs`, Nachbau `fahrer`, `abrechnung_freigaben`):
  `pauschale_fuer` (unbefristet, befristet mit Rückfall, neuester gewinnt, Wochen über den Jahreswechsel),
  Stichwoche, `pauschale_setzen` (Regeln, Rolle, `gilt_ab` vor Stichwoche abgelehnt, `von` aus JWT),
  Sperre UPDATE/DELETE, Wächter (n8n-Update mit anderen Werten → HYDRAlink-Wert bleibt; Neuanlage → Eintrag),
  Freigabe → Befristung beginnt/endet, `pauschalen_abweichung` leer.
- **Bot-Zeile**: Berechnung alt vs. neu mit einer echten Woche (Daten aus `settlements`/CSV), gleiche Ergebnisse,
  dazu ein Fall `eigene` mit Schwelle 0.
- **Übernahme** in einer Probe (Transaktion mit Rollback) auf Live: Anzahl Einträge = aktive Fahrer-Nr.,
  `pauschalen_abweichung` leer, Stichproben (W204TX beide 550, W4181TX 500, Fix-Fahrer 230).
- **Dashboard**: Formular und Verlauf im headless Chromium mit Attrappen, 390 px und Desktop.

## Ausrollen

1. Migration `2026-10-3x-pauschalen.sql` (Tabelle, Funktionen, Trigger, Ansicht, Protokoll, Übernahme), einspielen nach
   Freigabe im Gespräch, nicht Montag früh.
2. Dashboard (Fahrer-Detail, Liste, Hinweis-Karte) auf `plattform-anbindung`. Push nach `main` macht der Betreiber.
3. Bot-Zeile + SQL/Dashboard-Geschwister, nach Nachrechnung und OK.
4. Betreiber: Notion-Feld umbenennen, Team informieren („Pauschalen nur noch im Dashboard“).
5. CLAUDE.md: Grundsatz „Notion bleibt Stammdaten“ anpassen (Pauschale jetzt HYDRAlink), neuer Abschnitt „Pauschalen“.
