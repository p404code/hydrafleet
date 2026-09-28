# Post & Strafen – USP-Postkorb in HYDRAlink

Stand 28.09.2026 · Status: Entwurf zur Freigabe durch den Betreiber

## Ziel

Die Behördenpost an **Hydrafleet KG** (USP „Mein Postkorb“) landet nicht mehr nur in
Telegram, sondern zusätzlich in HYDRAlink: gespeichert, durchsuchbar, mit PDF-Ansicht.

- **Lenkererhebungen** werden per Knopf mit „vermietet an <Mieter zur Tatzeit>“ per Mail
  beantwortet; was verschickt wurde, ist jederzeit sichtbar.
- **Strafverfügungen / Anonymverfügungen** werden einem Fahrer zugeordnet (Vorschlag über
  das Kennzeichen, Bestätigung durch das Büro) und nach **Freigabe** in der Fahrerapp gezeigt.
- **Sonstige Post** (WKO, ÖGK, Gerichte …) wird nur abgelegt und kann „erledigt“ werden.
- Der **Rückstand** an unbeantworteten Lenkererhebungen wird über einen Telegram-Export
  eingespielt und abgearbeitet.

Nicht Teil davon (eigenes Projekt, später): Abzug beim Fahrer und Überweisung.

## Vorgaben des Betreibers

1. Der Telegram-Bot (`/root/usp-bot.sh` auf `taxi`) bleibt, wie er ist; HYDRAlink kommt dazu.
2. Nur Hydrafleet KG. Post an EH, E&E, Sorhan erledigen diese Firmen selbst.
3. Lenkererhebungen werden **immer** mit „vermietet an“ beantwortet – die Firma, an die
   **die ganze Flotte zur Tatzeit** vermietet war. Kein Fahrer wird genannt.
4. Senden erst auf Knopfdruck, mit sichtbarer Vorschau; Sammel-Senden für den Rückstand.
5. Strafen: Zuordnung über das Kennzeichen → Fahrer laut Notion (aktuell), nur als Vorschlag.
   Der Fahrer sieht nichts, bevor das Büro freigibt.
6. Alles gespeichert und durchsuchbar, inkl. Text im PDF.
7. PDF-Ansicht in HYDRAlink wie bei den Lohnzetteln.
8. `settlements`, AbrechnungsBot und Notion werden nicht angefasst.

## Befunde (28.09.2026)

- `usp-bot.sh` läuft stündlich (Cron `5 * * * *`), holt über `usp-proxy.js` (localhost:9999,
  SOAP „Autoabholung“) neue Zustellungen, lädt das PDF, schickt Text + PDF an Telegram und
  **schließt die Zustellung im USP ab** (`CloseDeliveryRequest`). Danach existiert das PDF
  nur noch in Telegram → HYDRAlink muss es im selben Lauf bekommen.
- Log seit 16.01.2026: 259 Zustellungen. Großteil **VStVF 37 Lenkererhebung** (MA 67,
  Polizeikommissariate, BH), dazu VStVF 47 Strafverfügung, 64 Anonymverfügung,
  57 Zahlungsaufforderung, 38a Mahnung; sonstige: ÖGK, WKO, Bezirksgerichte.
- Bisherige Antworten (Gmail `sw.hydrafleet@gmail.com`, Ordner Gesendet, ~200):
  An = Adresse aus dem PDF (`lenkererhebung@ma67.wien.gv.at`, `PK-W-15-Kanzlei@polizei.gv.at`, …),
  Betreff = Geschäftszahl, Text „Hiermit teilen wir mit das das Fahrzeug vermietet wurde:
  Firma …“, ohne Anhang. MA 67 hat vereinzelt den Mietvertrag nachgefordert.
- Notion-Feld „FA.“ ist **nicht** der Mieter (55× HYD, 6× E&E, 12× Abgemeldet).

## Mietverhältnisse

| Mieter | gültig von | gültig bis |
|---|---|---|
| Sorhan Taxi KG, Seitenstettengasse 5/37, 1010 Wien | – | 10.01.2026 (inkl.) |
| EH Limousinenservice KG, Thalhaimergasse 47/4, 1160 Wien, ATU74849827, FN 521134 z | 11.01.2026 | offen |

Maßgeblich ist das **Datum der Tatzeit** (Europe/Vienna). Die Tabelle ist im Dashboard
editierbar (Wechsel Mitte Oktober trägt der Betreiber selbst ein). Überschneidungen sind
per Constraint ausgeschlossen.

## Ablauf

### 1. Eingang

```
usp-bot.sh (taxi, stündlich)
  ├─ Telegram (unverändert)
  └─ NEU: POST /functions/v1/post-eingang   (multipart: PDF + delivery_id, absender, betreff, zugestellt_am)
                                            Header x-post-key: <eigener Schlüssel>
Dashboard „PDFs hochladen“ (Rückstand, Nachträge) ─→ gleiche Funktion, als Büro-User
```

`post-eingang`:
1. Prüft Aufrufer: `x-post-key` (Server-Skript) **oder** Büro-User (`app_metadata.app_role`).
   Sonst 403. `verify_jwt` bleibt an; der Server schickt den anon-Key als Bearer plus `x-post-key`.
2. SHA-256 des PDFs; existiert schon ein Eintrag mit gleichem Hash → nur `delivery_id`
   ergänzen, fertig (kein Doppel).
3. PDF nach Storage-Bucket `post` (privat), Pfad `JJJJ/MM/<sha256>.pdf`.
4. Eintrag in `post_eingang` mit Status `neu`, dann Auslesen (Schritt 2). Das Auslesen darf
   scheitern, ohne den Eingang zu verlieren (Status `pruefen`, Fehlertext).

Das Server-Skript bekommt nur **einen** zusätzlichen `curl` vor dem `rm -f "$TMPFILE"`;
schlägt er fehl, wird es geloggt, Telegram und `CloseDelivery` laufen trotzdem.

### 2. Auslesen

Claude (`claude-sonnet-5`, PDF als Dokument) liefert strukturiert:

| Feld | Beispiel | Prüfung danach |
|---|---|---|
| `art` | `lenkererhebung` · `strafverfuegung` · `anonymverfuegung` · `zahlungsaufforderung` · `mahnung` · `sonstige` | Enum |
| `gz` | `MA67/266700676804/2026`, `VStV/926301390535/2026`, `MDS2-V-2679991` | nicht leer und steht wörtlich im PDF-Text (andere Behörden haben eigene Formate) |
| `behoerde` | `MA 67 – Parkraumüberwachung` | – |
| `kennzeichen` | `W-1234TX` | über `kennzeichen_key()` in `fuhrpark` gefunden? |
| `tatzeit` | `2026-09-14T17:32+02:00` | plausibel (≤ Zustelldatum) |
| `tatort`, `delikt` | Freitext | – |
| `betrag` | `90.00` | ≥ 0 |
| `frist` | `2026-10-05` | – |
| `antwort_email` | `lenkererhebung@ma67.wien.gv.at` | endet auf `.gv.at`, steht wörtlich im PDF-Text |
| `volltext` | gesamter Text | für die Suche |

Scheitert eine Prüfung, die für die jeweilige Art nötig ist, wird der Eintrag auf `pruefen`
gesetzt, mit Grund. Anthropic-Schlüssel im Supabase-Vault. Kosten ca. 1 Cent/PDF.

### 3. Lenkererhebung beantworten

- Mieter = `mietverhaeltnisse` zum Datum der Tatzeit. Ohne Tatzeit oder ohne Treffer:
  kein Knopf, Hinweis „Mieter nicht bestimmbar“.
- Mail-Vorschau (genau das, was rausgeht):

  ```
  An:      <antwort_email>
  Betreff: GZ: <gz>
  Text:    Sehr geehrte Damen und Herren!
           Hiermit teilen wir mit, dass das Fahrzeug <kennzeichen> zur Tatzeit
           <tatzeit TT.MM.JJJJ HH:MM> vermietet war an:
           <Mieter Name>, <Adresse>[, <UID>][, FN <FN>]
           Mit freundlichen Grüßen
           Hydrafleet KG
  ```

- Knopf: **„An <Behörde kurz> senden → <Mieter kurz>“** (z. B. „An MA 67 senden → EH“).
- **Sammel-Senden:** Einträge ankreuzen → „N Lenkererhebungen senden“ → Übersicht aller N
  Mails (An, Betreff, Mieter, Frist) → „Jetzt senden“. Überfällige Fristen oben, rot.
- **Nie doppelt:** vor dem Senden wird geprüft (a) `post_ausgang` hat die GZ schon,
  (b) Gmail „Gesendet“ enthält die GZ im Betreff (Suche `in:sent "<gz>"`). Treffer →
  Knopf wird zu „bereits beantwortet am … (Gmail)“, Eintrag auf `beantwortet`.
- Versand über **Gmail-API** als `sw.hydrafleet@gmail.com` → erscheint dort unter Gesendet.
  Jede Mail wird in `post_ausgang` im Wortlaut mit Gmail-Message-ID und -Thread-ID
  gespeichert; im Dashboard Link „in Gmail öffnen“.
- Fehler beim Senden → Eintrag bleibt offen, Fehlertext sichtbar, nichts wird als gesendet
  markiert.

### 4. Strafe zuordnen und freigeben

- Vorschlag: Kennzeichen → Fahrzeug in `fuhrpark` → aktueller Fahrer laut Notion.
  Angezeigt als „Vorschlag“, neben der Tatzeit (Rückstand: Zuordnung kann veraltet sein).
- Büro wählt/bestätigt Fahrer → **„Freigeben“** → sichtbar in der Fahrerapp.
  „Freigabe zurücknehmen“ möglich, solange nichts abgezogen ist (Teil 3).
- Kein Kennzeichen / nicht im Fuhrpark → Fahrer frei wählbar.

### 5. Sonstige Post

Nur Ansicht, PDF, Notizfeld, „Erledigt“ (mit Zeitpunkt und Benutzer). Wieder öffnen möglich.

## Datenmodell (Migration `2026-09-28-post.sql`)

```sql
mietverhaeltnisse (
  id serial pk, name text not null, adresse text not null, uid text, fn text,
  gueltig_von date, gueltig_bis date,           -- null = offen
  kurz text not null,                           -- 'EH', 'Sorhan' (für den Knopf)
  exclude using gist (daterange(gueltig_von, gueltig_bis, '[]') with &&)
)

post_eingang (
  id uuid pk, quelle text check in ('usp','upload'),
  delivery_id text unique, sha256 text unique not null, datei_pfad text not null,
  dateiname text, usp_absender text, usp_betreff text, zugestellt_am timestamptz,
  eingelesen_am timestamptz default now(),
  art text, gz text, behoerde text, kennzeichen text,
  kennzeichen_key text,                         -- kein FK: fuhrpark wird bei jedem Notion-Sync ersetzt
  tatzeit timestamptz,
  tatort text, delikt text, betrag numeric(10,2), frist date, antwort_email text,
  volltext text, auslese_roh jsonb, pruef_grund text,
  fahrer_id int references fahrer(id) on delete set null,            -- bestätigt vom Büro
  fahrer_vorschlag_id int references fahrer(id) on delete set null,  -- aus Kennzeichen
  status text check in ('neu','pruefen','offen','beantwortet','freigegeben','erledigt'),
  freigegeben_am timestamptz, freigegeben_von uuid,
  erledigt_am timestamptz, erledigt_von uuid, notiz text,
  suche tsvector generated always as (to_tsvector('german',
        coalesce(gz,'')||' '||coalesce(kennzeichen,'')||' '||coalesce(behoerde,'')||' '||
        coalesce(usp_absender,'')||' '||coalesce(usp_betreff,'')||' '||coalesce(volltext,''))) stored
)
index gin (suche); index (gz); index (status, frist)

post_ausgang (
  id uuid pk, eingang_id uuid references post_eingang, gz text not null,
  an text not null, betreff text not null, text text not null,
  mietverhaeltnis_id int references mietverhaeltnisse,
  gmail_message_id text, gmail_thread_id text,
  gesendet_am timestamptz, gesendet_von uuid, fehler text,
  quelle text check in ('hydralink','gmail_abgleich')
)
```

Status:

| Status | Bedeutung |
|---|---|
| `neu` | gespeichert, Auslesen läuft |
| `pruefen` | Auslesen gescheitert oder Pflichtfeld unplausibel (`pruef_grund`) |
| `offen` | ausgelesen, wartet auf Senden / Zuordnen / Erledigen |
| `beantwortet` | Lenkererhebung: Antwort gesendet (HydraLink oder im Gmail-Abgleich gefunden) |
| `freigegeben` | Strafe: Fahrer bestätigt und in der App sichtbar |
| `erledigt` | vom Büro abgeschlossen (jede Art) |

RLS: alles nur `is_app_user()` (Büro). Schreiben über RPCs/Edge Functions.
Fahrerapp: `fahrer_app_strafen()` (security definer) liefert nur `status='freigegeben'`
und `fahrer_id = eigener Fahrer`; PDF über eine RPC, die für genau diese Einträge eine
kurzlebige signierte URL ausstellt. Bucket `post` hat keine Policy für Fahrer.

## Oberfläche

### Dashboard: Seite `post.html` (Kopfleiste: eigener Punkt „Post“)

Aufbau wie `lohn.html` (Tabelle, keine Karten).

- Suche über `suche` (GZ, Kennzeichen, Fahrer, Behörde, Text im PDF).
- Reiter: **Offen** · Lenkererhebungen · Strafen · Sonstige · Gesendet · Erledigt · Alle.
- Spalten: Eingang · Absender · Art · Kennzeichen · Fahrer · Betrag · Frist · Status.
- Klick auf Zeile → **PDF-Ansicht im Fenster** (gleicher Baustein wie `lohn.html`:
  Download aus privatem Bucket, `<iframe>`, „Neuer Tab“, „Herunterladen“), daneben bzw.
  darunter der Arbeitsbereich je Art (Mail-Vorschau + Senden / Fahrer + Freigeben /
  Notiz + Erledigt).
- „PDFs hochladen“: mehrere Dateien oder Ordner (Telegram-Export), Fortschritt je Datei.
- „Mieter“: kleine Tabelle `mietverhaeltnisse`, editierbar.
- Mobil: 3 Spalten + aufklappbare Detailzeile (wie bestehende Tabellen).

### Fahrerapp: Reiter „Strafen“

Nur freigegebene eigene Strafen: Datum, Ort, Delikt, Betrag, Frist, PDF.
PDF öffnet als **neuer Tab / Download** (nicht eingebettet – iPhone, siehe Lohnzettel).

## Rückstand

1. Betreiber exportiert in Telegram Desktop die USP-Gruppe (nur Dateien).
2. Upload des Ordners in `post.html` → alle PDFs durch `post-eingang` (Doppelte fallen raus).
3. Gmail-Abgleich markiert bereits beantwortete GZ als `beantwortet (Gmail)`.
4. Übrig bleiben die offenen Lenkererhebungen → Sammel-Senden.

## Einmalige Einrichtung (Betreiber)

1. **Google-Zugang** für `sw.hydrafleet@gmail.com`: Claude bereitet ein Google-Cloud-Projekt/
   OAuth-Client und ein Skript vor (Muster `uber-session-speichern.js`); der Betreiber
   meldet sich einmal an. Rechte: `gmail.send`, `gmail.readonly`. App-Status
   **„In Produktion“**, sonst läuft die Freigabe nach 7 Tagen ab. Token → Vault.
2. **Anthropic-Schlüssel** für HYDRAlink → Vault (eigener Schlüssel, nicht der aus n8n).
3. **Server:** eine Zeile in `usp-bot.sh` + Schlüsseldatei `/root/.post-eingang-key`
   (chmod 600). Änderung macht Claude per SSH nach Freigabe; Sicherung `usp-bot.sh.bak2`.

## Tests

- 5–10 echte PDFs aus dem Export (je Art mind. eines, MA 67 und Polizei) durch das Auslesen;
  Ergebnis gegen das PDF von Hand prüfen.
- Erste Mail an eine **eigene Adresse** (Testmodus: Empfänger überschrieben), dann eine echte.
- Doppelschutz: gleiche GZ zweimal senden → zweites Mal gesperrt; GZ aus Gmail-Gesendet → erkannt.
- Fahrer sieht vor Freigabe nichts, nach Freigabe nur eigene; PDF-Link fremder Einträge → verweigert.
- Server-Skript: HYDRAlink nicht erreichbar → Telegram kommt trotzdem, Log-Eintrag.

## Nicht in diesem Projekt

- Abzug beim Fahrer, Überweisung (Teil 3).
- Automatisches Senden ohne Knopf.
- Nachforderung des Mietvertrags durch MA 67 (kommt als normale Mail in Gmail).
- Zuordnungsverlauf Fahrer↔Auto über die Zeit (Vorschlag = aktueller Stand).
- Post an EH / E&E / Sorhan.

## Hinweis Sicherheit

Beim Lesen von `usp-bot.sh` am 28.09. ist der Telegram-Bot-Token im Klartext in einer
Claude-Sitzung gelandet. Empfehlung: bei @BotFather `/revoke`, neuen Token in `usp-bot.sh`.
