# Autoliste – Fahrer↔Auto in HYDRAlink – Design

Stand 01.11.2026, im Gespräch mit dem Betreiber abgestimmt.

## Ziel

Im Dashboard eine **schlanke Autoliste**: Wer fährt welches Auto, und zu welcher Pauschale. Ein Auto antippen, einen Fahrer
aus der **gesamten Notion-Fahrerliste** auswählen, Pauschale festlegen, fertig. Die Änderung gilt **sofort für die Abrechnung**.
Damit ist der Pavel-Fall gelöst: Fahrer steht in Notion, kam aber nie in `fahrer`.

Festgelegt vom Betreiber:
- **Notion bleibt die Liste** für Fahrer und Autos. Das Onboarding-Webformular schreibt weiter nach Notion.
- **HYDRAlink entscheidet, wer welches Auto fährt.** HL schreibt die Zuordnung zusätzlich nach Notion („Fahrer aktuell“).
- Bedienung von der **Autoliste** aus. Sie **ersetzt** den alten Fuhrpark-Reiter unter „Experimentell“.
- Schlichtes Design (Tabellen, Schlüssel-Wert-Zeilen, keine Kästen/Badges).
- Danach, eigener Schritt: das Fahrer-Detail kürzen.

Nicht in diesem Schritt: Autos anlegen oder abmelden (bleibt in Notion), Fahrer anlegen (Webformular → Notion),
Fahrer-Detail aufräumen, Bolt-Abgleich.

## Bedienung

**Fahrer → Autos** (`contentAutos`, Präfix `au`):
- Tabelle aller angemeldeten Autos (`fuhrpark.firma` ≠ Abgemeldet): **Kennzeichen · Modell · Fahrer · Pauschale**.
  Je Fahrer eine Zeile im Feld, z. B. „Ali Demir · f12 500 €“. Freie Autos zuerst, dann nach Kennzeichen.
- Oben: Suchfeld (Kennzeichen oder Name), Chips **Alle · Frei · Belegt**.
- Auto antippen → Detail (rechts bzw. am Handy aufgeklappt):
  - je Fahrer: Name, Pauschale, „entfernen“
  - **„Fahrer hinzufügen“** → Suchfeld über alle Fahrer aus `notion_fahrer` (Name, Fahrer-ID, Telefon). Ein Fahrer, der
    schon auf einem anderen Auto sitzt, ist markiert („sitzt auf W-123TX – wird dort entfernt“).
  - nach der Auswahl: Pauschale-Formular (dasselbe wie im Fahrer-Detail), vorbelegt mit der bisherigen Pauschale des
    Fahrers, sonst leer. **Ohne Pauschale kein Speichern.**
  - Verlauf des Autos: „01.11. 14:20 · Mohamed · Pavel Paunov eingesetzt“ / „… entfernt“.
- Am Handy: drei Spalten (Kennzeichen · Fahrer · Pauschale), Rest im Aufklapper.

## Daten

### `fahrer_auto` (Verlauf, nur anhängen)

| Spalte | |
|---|---|
| `id` bigint PK | |
| `notion_fahrer_id` int not null | Fahrer |
| `kennzeichen_key` text | Auto (`kennzeichen_key()`); **null = kein Auto** |
| `kennzeichen` text | Anzeigeform wie der n8n-Full-Sync sie schreibt (Klammerzusatz weg, Leerzeichen zusammengezogen) |
| `quelle` | `hand` (HL) · `uebernahme` (Start) · `notion` (neuer Fahrer, der nur über Notion kam) |
| `von`, `am` | Büro-Name aus dem JWT bzw. „Automatik“ |
| `notion_ok_am` timestamptz | wann Notion bestätigt wurde (null = noch offen) |

Je Fahrer gilt der **letzte Eintrag**. UPDATE/DELETE gesperrt (außer `notion_ok_am`), Protokoll-Bereich `zuordnungen`.

### `fuhrpark` (Notion-Spiegel) bekommt dazu
`notion_page_id` (für das Zurückschreiben) und `notion_fahrer` (int[] – „Fahrer aktuell“ in Notion als Fahrer-IDs).
`notion-sync` füllt beides, alle 10 Minuten wie bisher.

## Ablauf

1. **`auto_fahrer_setzen(p_kennzeichen, p_nr, p_pauschale…)`** (RPC, Büro), in einer Transaktion:
   - hängt `fahrer_auto` an. Saß der Fahrer woanders, gilt das alte Auto damit als verlassen.
   - legt die `fahrer`-Zeile an, falls es keine gibt: Name (getrimmt, wie der Full-Sync) und Telefon aus `notion_fahrer`,
     `aktiv = true`. Sonst setzt sie `kennzeichen` und `aktiv = true`.
   - setzt die Pauschale über `pauschale_setzen` (gleiche Regeln: ab Stichwoche, Verlauf).
2. **`auto_fahrer_entfernen(p_nr)`**: Eintrag mit `kennzeichen_key = null` → `fahrer.kennzeichen = null`. `aktiv` bleibt,
   damit Umsätze der laufenden Woche noch abgerechnet werden.
3. **Wächter** (Erweiterung von `fahrer_pauschale_waechter`): hat der Fahrer Einträge in `fahrer_auto`, gilt deren
   Kennzeichen, egal was der n8n-Full-Sync schickt. Hat er keine (Fahrer kam nur über Notion), wird der Notion-Wert einmal
   als `quelle = 'notion'` übernommen. So funktioniert Onboarding über Notion weiter.
4. **Notion nachziehen:** Edge Function `fuhrpark-notion` (Büro-JWT, Notion-Token aus dem Vault) setzt bei den betroffenen
   Autos „Fahrer aktuell“ und schreibt `notion_ok_am`. Das Dashboard ruft sie direkt nach dem Speichern auf.
   Was offen bleibt (Notion nicht erreichbar), holt `notion-sync` beim nächsten 10-Minuten-Lauf nach. Liste mit
   „Notion noch nicht aktualisiert“ im Detail des Autos.
5. **Start:** die heutigen `fahrer.kennzeichen` der aktiven Fahrer als `uebernahme` eintragen.

## Grenzen
- Ändert jemand nach dem Start „Fahrer aktuell“ direkt in Notion, gewinnt HL (Wächter). Das Team ordnet nur noch in HL zu.
- Der n8n-Full-Sync läuft unverändert weiter (legt neue Fahrer an, setzt `aktiv`). Ihn abzulösen ist ein späterer Schritt.
- Die Notion-Felder „Pauschale “/„Pauschal Modell“ bleiben, solange der Full-Sync sie braucht.

## Tests
PGlite (Nachbau inkl. `fahrer_mietmodell_check`): setzen, Wechsel zwischen Autos, entfernen, neuer Fahrer ohne `fahrer`-Zeile
(Pavel-Fall), Wächter gegen Full-Sync-Upsert (`on_conflict=name`), Onboarding über Notion. Logik für die Liste in JS mit
`node --test`. Dashboard mit Attrappe + Screenshots (390 px / Desktop). Edge Function mit Attrappen für Notion.

## Ausrollen
1. Migration + Übernahme (wirkt erst mit dem Wächter). 2. `notion-sync` + `fuhrpark-notion` deployen (Freigabe im Gespräch).
3. Dashboard (Schalter wie bei den Pauschalen). 4. Wächter scharf, Team informieren („Zuordnen nur noch in HL“).
