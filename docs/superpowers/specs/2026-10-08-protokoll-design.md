# Protokoll – wer hat was gemacht

Stand 08.10.2026 · Status: Entwurf zur Freigabe durch den Betreiber

## Ziel

Der Betreiber will nachweisen können, **wer im Büro was geändert hat** – Beträge, Freigaben,
Zuordnungen, Löschungen – mit Vorher- und Nachher-Wert. Dazu kommt, im selben Reiter, was die
**Automatik** getan hat (Syncs, AbrechnungsBot, Postversand).

- Lückenlos: auch Änderungen am Dashboard vorbei (Browser-Konsole, n8n, SQL-Fenster) stehen drin.
- Nicht änderbar und nicht löschbar, so streng wie das Kassabuch.
- Lesbar: eine Zeile je Ereignis, als Satz; Details per Klick.
- **Nur der Betreiber** (Rolle `admin`) sieht das Protokoll.

Nicht Teil von v1: Anmeldungen (wer hat sich wann eingeloggt), Lesezugriffe (wer hat was
angesehen), Benachrichtigungen bei bestimmten Ereignissen.

## Vorgaben des Betreibers

1. Ein Reiter für beides: Mensch und Automatik, mit Filter.
2. Zweck ist Kontrolle der Mitarbeiter – Vorher/Nachher, nicht löschbar.
3. Die Datenbank schreibt selbst mit (Trigger), nicht das Dashboard.
4. Sichtbar nur für den Betreiber.
5. `settlements`, AbrechnungsBot, Notion und der klassische Abrechnungsweg werden **nur
   beobachtet**, nicht verändert.

## Befunde (08.10.2026)

- Büro-Benutzer: Boyko (`admin`), Stefan, Bislan, Mohamed (`user`). Name und Rolle stehen in
  `app_metadata` (`app_name`, `app_role`); `is_app_user()` und `is_app_admin()` gibt es schon.
- Das Dashboard schreibt teils über RPCs (`posten_anlegen`, `woche_freigeben`, `konto_zuordnen`,
  `lohn_person_zuordnen` …), teils **direkt** in Tabellen: `settlements` (update),
  `kassier_zahlungen` (insert), `mietverhaeltnisse` (insert/update), `name_aliases` (upsert),
  `customers`/`companies` (insert/delete), `abrechnung_freigaben` (delete).
  `settlements` erlaubt Büro-Benutzern laut Policy alles (`app_users_all`).
- Einige Tabellen merken sich schon einen Namen (`freigegeben_von`, `gesetzt_von`,
  `angelegt_von`, `kassiert_von`, `gesendet_von`), aber nur für das Anlegen – Änderungen und
  Löschungen hinterlassen keine Spur.
- Das Kassabuch ist bereits fälschungssicher (`nr`, `pruefsumme`, Sperr-Trigger).
- Die Automatik-Läufe stehen in `sync_runs` (je Verbindung: Start, Ende, Zeitraum, Anzahl,
  Status, Fehler), der Postversand in `post_ausgang`.

## Lösung

### 1. Tabelle `protokoll`

| Spalte | Inhalt |
|---|---|
| `id` | bigint, fortlaufend |
| `zeit` | Zeitpunkt der Änderung |
| `akteur_art` | `buero`, `fahrer`, `automatik`, `sql` |
| `akteur` | Name des Büro-Benutzers, Fahrer-Nr., „Automatik“ oder „SQL-Fenster“ |
| `auth_uid` | Benutzer-ID aus der Anmeldung, falls vorhanden |
| `tabelle` | überwachte Tabelle |
| `aktion` | `neu`, `geaendert`, `geloescht` |
| `zeile` | Primärschlüssel der betroffenen Zeile als Text |
| `fahrer` | Fahrername bzw. Fahrer-ID, wo die Zeile einen hat (für den Filter) |
| `woche` | Kalenderwoche `JJJJ-Wnn`, wo die Zeile eine hat |
| `felder` | Liste der geänderten Spalten (bei `geaendert`) |
| `alt`, `neu` | Zeile vorher / nachher als JSON, nur überwachte Spalten |

**Akteur** wird in der Datenbank bestimmt, nie vom Aufrufer mitgegeben:

1. `app_metadata.app_name` vorhanden → `buero`, Name.
2. sonst `app_metadata.fahrer_nr` vorhanden → `fahrer`, Nummer.
3. sonst JWT-Rolle `service_role` → `automatik` (n8n/AbrechnungsBot, Edge Functions).
4. sonst (kein JWT) → `sql` („SQL-Fenster“).

**Schutz:**

- RLS an; einzige Policy: `select` für `is_app_admin()`. Keine Rechte für insert/update/delete.
- Geschrieben wird ausschließlich von der Trigger-Funktion (`security definer`).
- Trigger `protokoll_gesperrt` verbietet UPDATE, DELETE und TRUNCATE – auch im SQL-Fenster,
  nach dem Muster von `kassa_gesperrt`.
- Keine Prüfsummen-Kette: SQL-Zugang hat nur der Betreiber selbst; gegen die Mitarbeiter
  reicht die Sperre. (Bewusste Grenze, siehe unten.)

### 2. Trigger `protokoll_schreiben`

Eine gemeinsame Funktion, als `after insert or update or delete … for each row` auf:

| Bereich | Tabelle | überwachte Spalten |
|---|---|---|
| Geld | `settlements` | alle außer `telegram_gesendet`, `created_at` |
| Geld | `abrechnung_posten` | alle |
| Geld | `kassier_zahlungen` | alle |
| Freigaben | `abrechnung_freigaben` | alle |
| Post/Strafen | `post_eingang` | nur `fahrer_id`, `status`, `freigegeben_am`, `freigegeben_von`, `erledigt_am`, `erledigt_von`, `notiz`, `betrag`, `art` |
| Post/Strafen | `mietverhaeltnisse` | alle |
| Zuordnungen | `zuordnung_manuell`, `lohn_personen`, `name_aliases` | alle |
| Zugänge | `fahrer_app_zugang` | alle (der PIN steht nicht in dieser Tabelle) |
| Stammdaten | `customers`, `companies` | alle |

Regeln:

- Welche Spalten je Tabelle zählen, steht als Trigger-Argument an der Tabelle; die Funktion
  bleibt eine.
- UPDATE, bei dem sich keine überwachte Spalte ändert → keine Zeile.
- `post_eingang`: Einfügen durch die Automatik (neue Post) wird **nicht** protokolliert, nur
  Änderungen und Löschungen – der Eingang selbst ist im Post-Reiter sichtbar.
- Schreibt eine Edge Function im Auftrag eines Mitarbeiters (Akteur technisch `automatik`) und
  trägt die Zeile einen Namen (`…_von`), zeigt der Reiter diesen Namen als „über Automatik“.
- Der Trigger darf den eigentlichen Schreibvorgang nie scheitern lassen: Fehler beim
  Protokollieren werden abgefangen und als `warning` gemeldet. (Abwägung: ein kaputtes
  Protokoll darf die Abrechnung nicht blockieren; der SQL-Test prüft, dass es schreibt.)

### 3. Funktion `protokoll_verlauf(…)` – nur admin

Liefert den gemischten Verlauf, neueste zuerst, seitenweise (100 Zeilen), mit Filtern
(Art, Akteur, Bereich, Fahrer, von/bis, nur Löschungen). Wirft `42501`, wenn nicht
`is_app_admin()`. Quellen:

- `protokoll` (Mensch, Automatik, SQL)
- `sync_runs` + `verbindungen` → „Automatik · Uber-Sync EH · 1 676 · ok“ bzw. Fehlertext
- `post_ausgang` → „Post gesendet an … (GZ …)“, Akteur `gesendet_von`
- `kassabuch` → Buchungen und Stornos, Akteur `name`

Kassabuch, Läufe und Postversand werden nur gelesen, nicht kopiert.

**Bündelung:** Zeilen mit gleichem Akteur, gleicher Tabelle, gleicher Woche und `akteur_art =
automatik` innerhalb derselben Minute kommen als eine Sammelzeile mit Anzahl zurück
(„Automatik hat KW40 neu gerechnet – 52 Zeilen“); die Einzelzeilen holt der Reiter beim Aufklappen.

### 4. Reiter „Protokoll“

- Eigener Punkt in der Kopfleiste (und im Handy-Menü), **nur bei `app_role = admin`** gerendert.
  Die Sperre selbst liegt in der Datenbank; das Ausblenden ist nur Aufgeräumtheit.
- `contentProtokoll`, JS in der Hülle `Proto`, IDs/Klassen `pr…`. Stil wie Löhne/Post:
  Tabelle, keine Karten.
- Spalten: Zeit · Wer · Was (Satz) · Fahrer/Woche. Auf dem Handy 3 Spalten + `detail-row`.
- Sätze je Tabelle im Dashboard zusammengesetzt, z. B.
  - „Korrektur 0,00 → −70,00 · Notiz ‚Pickerl‘“ (`settlements`)
  - „Zuschlag +70,00 ‚Pickerl selbst bezahlt‘ angelegt“ (`abrechnung_posten`)
  - „Zahlung 150,00 gelöscht“ (`kassier_zahlungen`)
  - „KW40 freigegeben“ / „Freigabe KW40 zurückgenommen“
  - „Strafe GZ … Fahrer X zugeordnet / freigegeben“
  - „App-Zugang gesperrt“
  Unbekannte Felder fallen auf „Feld: alt → neu“ zurück.
- Löschungen und Akteur „SQL-Fenster“ sind farblich hervorgehoben.
- Filter: Mensch/Automatik/alle, Person, Bereich, Fahrer (Suche), Zeitraum, „nur Löschungen“.
- Klick auf eine Zeile: Vorher/Nachher Feld für Feld.

### 5. Altbestand

Einmalig beim Einspielen: aus vorhandenen Namensspalten je eine Zeile `neu` mit dem
ursprünglichen Zeitpunkt und Vermerk „Altbestand“ – `abrechnung_freigaben`, `abrechnung_posten`,
`kassier_zahlungen`, `zuordnung_manuell`, `lohn_personen`, `fahrer_app_zugang`. Alles andere
beginnt am Tag der Einführung. Der Nachtrag läuft in derselben Migration, bevor die Sperre greift.

## Grenzen

- Wer das SQL-Fenster hat (der Betreiber), kann Trigger abschalten. Gegen Büro-Benutzer dicht,
  gegen den Datenbank-Eigentümer nicht.
- Schreibt n8n oder eine Edge Function ohne Namen in der Zeile, steht nur „Automatik“ da –
  welcher Dienst es war, ergibt sich aus Tabelle und Zeitpunkt.
- Notion-Änderungen (Fahrer, Fuhrpark) sind nicht erfasst; Notion bleibt führend und hat eine
  eigene Versionsgeschichte.

## Dateien

- `migrations/2026-10-08-protokoll.sql` – Tabelle, Sperre, Trigger-Funktion, Trigger je Tabelle,
  `protokoll_verlauf`, Altbestand.
- `dashboard.html` – Kopfleiste/Handy-Menü (admin), `contentProtokoll`, Hülle `Proto`.
- `sw.js` – Cache-Version hochzählen.
- `scripts/test-protokoll.sql` – Test mit Rollback (siehe unten).
- `CLAUDE.md` – Abschnitt „Protokoll“ (Regeln: nie aufweichen, neue Tabellen anhängen).

## Prüfung

SQL-Test in einer Transaktion mit `rollback`, JWT per `set local request.jwt.claims`:

1. Büro-Benutzer ändert `settlements.korrektur` → eine Zeile, Akteur = sein Name, `felder`,
   `alt`/`neu` stimmen.
2. Änderung ohne überwachte Spalte → keine Zeile.
3. Löschen in `kassier_zahlungen` → Zeile `geloescht` mit vollem `alt`.
4. `service_role` → `automatik`; ohne JWT → `sql`.
5. `user` ruft `protokoll_verlauf` → Fehler `42501`; `select` auf `protokoll` → 0 Zeilen.
6. UPDATE/DELETE/TRUNCATE auf `protokoll` → Fehler.
7. Fahrer-JWT → sieht nichts.

Danach: `scripts/check-dashboard.sh`, Reiter im Browser als admin und als `user` (Reiter fehlt),
ein echter Durchlauf (Zuschlag anlegen und löschen) sichtbar im Verlauf.

## Einspielen

Migration erst nach Freigabe des Betreibers; Push auf `main` durch den Betreiber.
