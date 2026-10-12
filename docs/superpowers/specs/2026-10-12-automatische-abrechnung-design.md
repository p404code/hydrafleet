# Automatische Abrechnung — Design (Stufe 1)

**Datum:** 2026-10-12
**Stand:** Schnitt in zwei Stufen vom Betreiber bestätigt. Nichts davon gebaut.
**Wartet auf:** myPOS-Zugangsdaten (Client-ID + Client-Secret aus dem myPOS-Webkonto) —
der Betreiber kam am 12.10. nicht ins Konto.
**Gehört zu:** `2026-09-23-api-abrechnung-design.md` (View `api_abrechnung`, nur Ansicht).

## Ziel

Die Wochenabrechnung soll aus den API-Daten kommen. Die CSVs bleiben als
Gegenkontrolle.

## Entscheidungen des Betreibers (12.10.)

| Frage | Entscheidung |
|---|---|
| myPOS | Per REST-API anbinden, nicht mehr aus der CSV |
| Terminal → Fahrer | Aus Notion wie heute. Die Terminals heißen wie Kennzeichen, das sagt aber nicht, wer fährt |
| API und CSV weichen ab | **Die CSV gilt** |
| Freigabe ohne CSV | **Vorerst nein** — erst nach dem Abgleich, „bis wir wissen, ob alles passt“ |

Folge: In Stufe 1 wird weiter nach der CSV-Abrechnung (`settlements`) ausgezahlt.
Stufe 1 ändert nicht, welches Geld fließt — sie macht die API-Abrechnung
vollständig und liefert je Woche den Nachweis, ob sie stimmt. Lohn und
Zu-/Abschläge hängen weiter an den `settlements`-Zeilen und bleiben unberührt.

## Ausgangslage (Test vom 12.10.)

| Woche | auf den Cent gleich | Rundung | weicht ab | nicht vergleichbar |
|---|---|---|---|---|
| KW40 | 45 | 0 | 0 | 9 |
| KW39 | 45 | 1 | 2 | 7 |
| KW38 | 40 | 3 | 3 | 4 |

Die Rechnung stimmt. Was nicht vergleichbar ist, sind Zuordnungen:

- **Dombaew doppelt:** „Aslambek“ (alt) und „Aslanbek“ (API) sind zwei `fahrer`-Einträge.
- **Muhammet Usta** fährt auf dem Bolt-Konto „Kamiran Haqqi“ (`bolt 69b35183`), das keinem Fahrer zugeordnet ist.
- **Konten ohne Fahrer in KW41** (7, rund 6.800 € Umsatz): Bashiir Mohamud (`uber 809dc76d`),
  Davoud Haghnejad (`uber f103bca5`), Kamiran Haqqi (`bolt 69b35183`), Ossama Eid
  (`bolt 9a757e6b`, `uber 4ee57f15`), Zahra Houshangpanah (`uber b2d6a006`, `bolt 876cfe15`).
- **Alte Zeilen ohne Fahrer:** Bashiir Mohamud, Mahmoud Hemdan (langer Name), Ossama Eid.

## Stufe 1 — Bausteine

### 1. myPOS per API

- **Zugang:** OAuth „client credentials“, Token von `https://auth-api.mypos.com/oauth/token`
  (Basic-Auth mit Client-ID/Secret), API `https://transactions-api.mypos.com/v1.1/`,
  60 Abfragen/Minute. Zugangsdaten in den Vault, Anbieter `mypos` (steht schon im
  Check von `verbindungen.anbieter`).
- **Edge Function `mypos-sync`** nach dem Muster von `bolt-sync`: holt die
  Transaktionen einer Woche, schreibt nach `mypos_transaktionen` (roh + Terminal,
  Betrag, Zeit, Woche), eine Zeile je Lauf in `sync_runs`, Aufrufschutz wie die
  anderen Syncs. Zeitplan Montag früh.
- **Erst mit echten Zugangsdaten zu klären:** Enthält die Antwort den
  Terminal-*Namen* (so ordnet die CSV zu) oder nur eine Geräte-ID? Bei nur ID:
  Geräteliste über die Devices API dazuholen. Wochengrenze und Vorzeichen von
  Storno/Erstattung gegen die CSV von KW40 prüfen (CSV-Summe 1.190,74 € bei 14
  Fahrern, dazu vier nicht zugeordnete Terminals).

### 2. Terminal-Zuordnung aus Notion

- Quelle: Notion-Datenbank `29d48504a3eb8057b60ae6cd69b36652`, Felder „Name des
  Terminals“ und „Text“ (Fahrername als freier Text). Heute liest sie der
  n8n-Workflow „MyPOS Terminal API“ (`bFcgUd0T9ZbaAfph`) für den AbrechnungsBot.
- `notion-sync` bekommt sie als dritte Datenquelle → Tabelle `mypos_terminals`
  (Terminal, Fahrertext, aufgelöste `fahrer_id`). Die Integration muss in Notion
  für diese Datenbank freigegeben sein.
- Abgleich Terminalname wie im Bot: exakt → klein geschrieben → normalisiert
  (nur Buchstaben und Ziffern), siehe `.n8n-backup/berechnung-v15.js` ab Zeile 305.
- **Bekannte Grenze, wie heute:** Notion kennt nur den aktuellen Stand. Wechselt
  ein Terminal mitten in der Woche den Fahrer, geht die ganze Woche an den, der
  beim Abrechnen eingetragen ist.
- Terminals ohne Eintrag erscheinen als „nicht zugeordnet“ (heute `__MYPOS:…`).

### 3. `api_abrechnung` rechnet myPOS selbst

`mypos_summe` kommt aus `mypos_transaktionen` über `mypos_terminals`, nicht mehr
aus `settlements`. Daneben `alt_mypos_summe` zum Vergleich. Der Befund
`unvollständig` gilt auch, wenn myPOS für die Woche nicht gesynct ist.

### 4. Zuordnungen bereinigen

Die Konten aus „Ausgangslage“ zuordnen, Dombaew zusammenführen. Braucht je Konto
die Ansage des Betreibers, wer das ist. Unabhängig von myPOS, kann vorgezogen werden.

### 5. Freigabe erst nach Abgleich

Eine Woche lässt sich erst freigeben, wenn die CSV-Abrechnung da ist. Beim
Freigeben steht die Liste der abweichenden Fahrer; ausgezahlt wird nach CSV.

### 6. Wochenbilanz

Je Woche festhalten, wie viele Fahrer auf den Cent gleich waren — Grundlage für
die Entscheidung, wann der Upload freiwillig wird.

## Stufe 2 — später, eigenes Design

Die API-Abrechnung wird gespeichert und maßgeblich, der CSV-Upload freiwillig,
Lohn und Zu-/Abschläge hängen an der API-Abrechnung statt an der CSV-Zeile.
Erst wenn Stufe 1 einige Wochen ohne Abweichung gelaufen ist.

## Offen

- myPOS-Zugangsdaten anlegen (Betreiber).
- Antwortfelder der myPOS-API mit echtem Abruf prüfen (siehe Baustein 1).
- Wie hart die Freigabe-Sperre sein soll (sperren oder nur warnen) — noch nicht gefragt.
- Abnahmekriterien und Implementierungsplan folgen, sobald die Zugangsdaten da sind.
