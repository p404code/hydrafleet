# Lohnzettel — Design

**Datum:** 2026-09-23
**Stand:** Design vom Betreiber freigegeben, nichts davon gebaut.
**Gehört zu:** `docs/2026-09-23-fahrerapp-design.md` (Screen 8 „Lohnzettel“),
`docs/2026-09-23-fahrerapp-schnittstelle.md` (Fahrer-Anker `fahrer_app_ziel`).

## Ziel

Die Lohnverrechnung schickt je Firma und Monat zwei PDFs. HYDRAlink nimmt sie
entgegen, teilt die Lohnzettel auf die Personen auf und zeigt **jedem Fahrer in der
App seine eigenen Lohnzettel als PDF**. Das Büro bekommt eine Übersicht je Firma
und Monat.

**Primär:** das richtige PDF beim richtigen Fahrer. Die Lohnbeträge in den
Wochenabrechnungen müssen **nicht** mit den Lohnzetteln übereinstimmen; es gibt
keinen Saldo, keinen Stichtag, keine Abgleich-Warnung.

## Die Eingangsdateien (geprüft an `AJ 0826.PDF` / `LZ 0826.PDF`)

| Datei | Inhalt | Erkennbar an |
|---|---|---|
| `AJ MMYY.PDF` Auszahlungsjournal | Kopf: Datum, „Auszahlungsjournal“, Monat („August 2026“), `Firma: <Nr> <Name>`. Je Dienstnehmer eine Zeile `<Ma-Nr> <NACHNAME, Vorname> <Zahlungsart> <Betrag>`. Danach `Anzahl Dienstnehmer`, `Summe Dienstnehmer`, Körperschaften (ÖGK, Finanzamt mit L/DB/DZ, Stadt Wien mit KommSt/DGA), `Gesamt-Summe`. Mehrseitig. | Text „Auszahlungsjournal“ |
| `LZ MMYY.PDF` Lohnzettel | **Eine Seite je Dienstverhältnis.** Kopf: `Lohn / Gehaltsabrechnung <Monat Jahr>`, `Firma : <Nr> <Name>`, `Person : <Ma-Nr> ( <DV-Nr> ) <NACHNAME, Vorname>`. Enthält SV-Nr. und Adresse. Beträge `Brutto`, `Netto`, `Auszahlung`. | Text „Lohn / Gehaltsabrechnung“ |

Beobachtet in 08/26 (Firma 1000032 EH Limousinenservice KG): 40 Dienstnehmer im
Journal, 41 Lohnzettel-Seiten (Ma-Nr 56 hat zwei Dienstverhältnisse), Summe der
Lohnzettel-Auszahlungen = `Summe Dienstnehmer` = 25.275,87 € auf den Cent.

Es gibt **mehrere operative Firmen**; jede kommt als eigenes Paar. Die Firma steht
im PDF, nicht im Dateinamen.

## Entscheidungen des Betreibers (23.09.)

| Frage | Entscheidung |
|---|---|
| Zweck | PDF je Person in der Fahrerapp; Übersicht fürs Büro |
| Abgleich mit Wochenabrechnung | Nicht nötig. Nur ein **bearbeitbarer Hinweis** beim Lohn-Feld |
| Zuordnung | Firma + Personalnummer → Fahrer, einmal bestätigt, danach automatisch |

## Bausteine

| Baustein | Wo |
|---|---|
| Migration: 3 Tabellen, Bucket, Policies, 2 RPCs, 1 View | `migrations/2026-09-23-lohnzettel.sql` |
| Upload + Übersicht + Zuordnung | `dashboard.html`, Reiter Fahrer/App, neuer Bereich „Lohn“ |
| Hinweis beim Lohn-Feld | `dashboard.html`, Reiter Abrechnungen |
| Lohnzettel-Screen | `fahrer/index.html` |

Keine Edge Function, keine n8n-Änderung. `settlements`, AbrechnungsBot und
CSV-Upload bleiben unberührt.

---

## 1. Datenmodell

```sql
lohn_laeufe (                         -- ein Lauf = eine Firma, ein Monat
  id uuid pk default gen_random_uuid(),
  firma_nr text not null,             -- '1000032'
  firma_name text not null,           -- 'EH Limousinenservice KG'
  monat date not null,                -- erster des Monats, 2026-08-01
  journal_datum date,                 -- 13.09.2026
  anzahl_dienstnehmer integer not null,
  summe_dienstnehmer numeric not null,
  koerperschaften jsonb not null,     -- [{bezeichnung, betrag, posten:{L:..,DB:..}}], gesamt_summe
  gesamt_summe numeric,
  aj_pfad text not null,              -- Storage-Pfad des Journals
  hochgeladen_von text not null,
  hochgeladen_am timestamptz not null default now(),
  unique (firma_nr, monat)
)

lohn_zettel (                         -- ein Zettel = eine Person in einem Lauf (alle DV-Seiten zusammen)
  id uuid pk default gen_random_uuid(),
  lauf_id uuid not null references lohn_laeufe(id) on delete cascade,
  ma_nr integer not null,
  name text not null,                 -- 'DOMBAEV, Aslanbek' wie im PDF
  seiten integer not null,            -- 1, bei mehreren DV 2+
  brutto numeric, netto numeric,
  auszahlung numeric not null,        -- Summe ueber alle DV-Seiten
  journal_betrag numeric,             -- Betrag laut Journal (Kontrolle)
  pfad text not null,                 -- Storage-Pfad des Einzel-PDFs
  unique (lauf_id, ma_nr)
)

lohn_personen (                       -- stabile Zuordnung, ueberlebt n8n-Neuaufbau
  firma_nr text not null,
  ma_nr integer not null,
  notion_fahrer_id integer not null,
  gesetzt_von text not null,
  gesetzt_am timestamptz not null default now(),
  primary key (firma_nr, ma_nr)
)
```

- RLS an allen drei, `anon` ohne Rechte. Büro (`is_app_user()`) liest alles.
- **Schreiben nur über RPCs** (siehe 3.), keine Insert-/Update-Policies.
- Keine SV-Nummer, keine Adresse in Tabellen — die stehen nur im PDF.

**Storage:** privater Bucket `lohnzettel`, Pfade
`<firma_nr>/<YYYY-MM>/journal.pdf` und `<firma_nr>/<YYYY-MM>/<ma_nr>.pdf`.
Policies auf `storage.objects` für `bucket_id = 'lohnzettel'`:
- `insert`/`update`/`delete`: `is_app_user()`
- `select`: `is_app_user()` **oder** der Pfad gehört zu einem Zettel des
  angemeldeten Fahrers (`lohn_zettel.pfad = name` über `lohn_personen` →
  `fahrer.notion_fahrer_id` = `fahrer_app_ziel(null)`-Fahrer).

## 2. Hochladen (Dashboard)

Reiter **Fahrer/App**, neuer Bereich „Lohn“ unter der Fahrerliste (Karte wie
„Plattformkonten ohne Fahrer“).

1. Zwei Dateien wählen (oder beide auf einmal ziehen). Welche AJ und welche LZ
   ist, erkennt der Browser am Inhalt, nicht am Namen.
2. **pdf.js** (`cdn.jsdelivr.net/npm/pdfjs-dist`) liest den Text je Seite,
   **pdf-lib** (`cdn.jsdelivr.net/npm/pdf-lib`) schneidet das LZ in ein PDF je
   Ma-Nr (alle DV-Seiten einer Person in ein PDF).
3. **Prüfungen, alle müssen bestehen, sonst wird nichts gespeichert:**
   - AJ und LZ: gleiche Firma, gleicher Monat.
   - Jede Ma-Nr aus dem LZ steht im AJ und umgekehrt.
   - Je Ma-Nr: Summe der LZ-Auszahlungen = AJ-Betrag (± 0,05 €).
   - Summe aller LZ-Auszahlungen = `Summe Dienstnehmer` (± 0,05 €).
   - `Anzahl Dienstnehmer` = Anzahl Ma-Nr.
4. **Vorschau** vor dem Speichern: Firma, Monat, Anzahl, Summe, je Person Name,
   Betrag, zugeordneter Fahrer oder „neu — bitte zuordnen“.
5. **Speichern:** Dateien in den Bucket (upsert), dann RPC `lohn_lauf_speichern`.
   Derselbe Monat derselben Firma erneut → ersetzt den alten Lauf samt Zetteln
   und Dateien.

## 3. RPCs

- `lohn_lauf_speichern(p_lauf jsonb) returns uuid` — `security definer`,
  `is_app_user()`. Legt `lohn_laeufe` an oder ersetzt ihn (gleiche Firma+Monat:
  alte Zettel löschen, neue einfügen). Schreibt `hochgeladen_von` aus
  `app_metadata.app_name`.
- `lohn_person_zuordnen(p_firma_nr text, p_ma_nr integer, p_fahrer_id integer)` —
  `is_app_user()`, schlägt `notion_fahrer_id` nach (aktiv, eindeutig), upsert in
  `lohn_personen`. Mit `p_fahrer_id = null`: Zuordnung löschen.
- Beide `revoke all from public, anon`, `grant execute to authenticated`.

**Zuordnungs-Vorschlag** (View `lohn_zettel_uebersicht`, `security_invoker`):
je Zettel Firma, Monat, Ma-Nr, Name, Betrag, `fahrer_id`/`fahrer_name` aus
`lohn_personen`, sonst `vorschlag_fahrer_id`: eindeutiger Treffer von
`name_key('Vorname Nachname')` gegen `name_key(fahrer.name)`, sonst eindeutiger
Treffer nur über den Nachnamen. Der Vorschlag wird nie automatisch gespeichert.

## 4. Übersicht (Dashboard)

Im Bereich „Lohn“:
- Liste der Läufe: Firma · Monat · Dienstnehmer · Summe Auszahlung · Abgaben
  gesamt · „Journal öffnen“.
- Klick auf einen Lauf: Personen mit Name (PDF), Betrag, Fahrer. Ohne Fahrer:
  Auswahl mit Vorschlag vorausgewählt + „Zuordnen“. Mit Fahrer: „Lösen“.
- Chip „ohne Fahrer“ mit Zähler.
- Handy: Kartenliste, keine Tabelle.

PDFs öffnen über `createSignedUrl` (60 s).

## 5. Hinweis beim Lohn-Feld (Abrechnungen)

Im Detail eines Fahrers, neben dem bestehenden Lohn-Eingabefeld: der Betrag des
**neuesten** Lohnzettels dieses Fahrers, z. B. „LZ 08/26: 733,10“. Klick setzt
den Wert ins Feld; gespeichert wird wie heute über `saveLohn()`. Keine Prüfung,
kein Saldo, keine Markierung, wenn der eingetragene Lohn abweicht. Hat ein Fahrer
im selben Monat Zettel mehrerer Firmen: je Firma ein Hinweis.

## 6. Fahrerapp

Screen „Lohnzettel“ (Design Screen 8), erreichbar über „Mehr“ → Lohnzettel:
- Kopf: Jahr (Chips, falls mehrere).
- Je Monat und Firma eine Zeile: „August 2026 · EH Limousinenservice KG ·
  733,10 €“ und „PDF öffnen“ (Signed URL, öffnet im neuen Tab bzw. im
  iOS-Viewer).
- Leer: „Noch keine Lohnzettel.“
- Vorschau-Modus (`?vorschau=`) zeigt die Zettel des angesehenen Fahrers.

Daten über neue RPC `fahrer_app_lohnzettel(p_fahrer_id integer default null)`
(`security definer`, Ziel über `fahrer_app_ziel`), liefert `monat, firma_name,
auszahlung, pfad`. Der Fahrer holt das PDF selbst über Storage; die
`select`-Policy lässt nur seine Pfade zu.

## 7. Abnahme

1. Upload von `AJ 0826.PDF` + `LZ 0826.PDF`: 40 Zettel, Summe 25.275,87, Ma-Nr 56
   als ein PDF mit zwei Seiten.
2. Erneuter Upload desselben Paars: weiterhin 1 Lauf, 40 Zettel, keine
   Waisen-Dateien im Bucket.
3. Manipuliertes Paar (AJ eines anderen Monats): Abbruch vor dem Speichern.
4. Fahrer-JWT (Raffael, Nr. 286): `fahrer_app_lohnzettel()` liefert nur seinen
   Zettel; Signed URL für seinen Pfad geht, für einen fremden Pfad nicht.
5. Büro-JWT ohne Parameter: leer; mit `p_fahrer_id`: die Zettel des Fahrers.
6. `anon`: keine Rechte auf Tabellen, RPCs, Bucket.
7. `settlements` vor/nach: unverändert.
8. `check-dashboard.sh` grün, 390 px ohne seitliches Scrollen.

## 8. Nicht in diesem Schritt

- Saldo „Lohn offen“, Stichtag, Abgleich Lohnzettel ↔ Wochenabrechnung.
- Automatischer Eingang per E-Mail (Anhänge landen heute in Mail).
- Jahreslohnzettel (L16), Dienstverträge, andere Personaldokumente.
- Benachrichtigung des Fahrers bei neuem Lohnzettel.
