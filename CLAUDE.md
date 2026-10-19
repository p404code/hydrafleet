# HYDRAFLEET / HYDRAlink Dashboard

## What is this?

HYDRAlink is the internal web dashboard for **HYDRAFLEET**, a taxi/ride-sharing fleet (~57 vehicles, ~52 drivers) operating on Bolt, Uber, and MyPOS in Austria. The dashboard handles driver settlements, invoice management, CSV upload processing — and since 2026-09-22 it also mirrors Bolt, Uber and Notion directly via their APIs.

## Tech Stack

- **Frontend**: Single-page HTML/JS app (no framework, vanilla JS)
- **Database**: Supabase (project: `pkxcwfkfaaorwnbdmylg.supabase.co`)
- **Hosting**: Cloudflare Pages — Dashboard läuft auf `hydrafleet.pages.dev` (`hydrafleet.at` ist eine andere Seite, NICHT das Dashboard)
- **Automation**: n8n (self-hosted on Hetzner) — CSV processing, invoice PDF generation, Notion→`fahrer` sync
- **Plattform-Sync**: Supabase Edge Functions (Deno) + `pg_cron`/`pg_net` — Bolt, Uber, Notion
- **Driver/Vehicle master data**: Notion (source of truth — never replace)
- **Notifications**: Telegram (implemented but currently deactivated)
- **Fonts**: Fraunces (logo), Inter (UI)
- **Branding**: "HYDRA" bold + "link" in gold (#F5B51B), dark theme default

## Repo Structure

```
index.html            — Login page (PIN-based auth via app_users table)
dashboard.html        — Main dashboard, Redesign v2 seit 2026-09-11
dashboard-alt.html    — vorherige Version, Rueckfall, nicht verlinkt
migrations/           — SQL, chronologisch benannt; von Hand/MCP angewendet
supabase/functions/   — Edge Functions (Deno). MUSS mit dem Deployten uebereinstimmen.
scripts/              — Hilfsskripte (Syntax-Check, Zugangs-Skripte, Uber-Capture)
docs/                 — Specs, Incidents, Protokolle
setup.sql             — Supabase schema for app_users + customers tables
manifest.json / sw.js — PWA
```

## Dashboard Tabs

Das Dashboard (`dashboard.html`) hat **7 Tabs**. Auf Mobil ersetzt ein Burger-Menü
die Tab-Leiste; Tabellen werden dort zu 3 Spalten + aufklappbarer `detail-row`.

1. **Abrechnungen** — Wochenabrechnung je Fahrer aus `settlements`. Filter Woche/Fahrer/Status, Druck/WhatsApp.
   Darüber der **Plattform-Abgleich** (`abrechnung_abgleich`): was Bolt und Uber für die Woche
   melden, neben dem was abgerechnet wurde. Fahrer mit Abweichung bekommen ein `≠`.
2. **Müssen zahlen** (Kassieren) — wochenübergreifende Schulden (`settlements.auszahlung < 0`), Zahlungen in `kassier_zahlungen`, "offen" wird live gerechnet. Nur anlegen + löschen, kein Update.
3. **Fahrer** — Fahrer aus Notion neben ihren Bolt- und Uber-Konten (`fahrer_uebersicht`). Zeigt nicht zugeordnete Plattform-Konten.
4. **Fuhrpark** — Fahrzeuge aus Notion, Bolt und Uber nebeneinander (`fuhrpark_uebersicht`), inkl. Fahrer-Zuordnung je Quelle und Konfliktmarkierung.
5. **Verbindungen** — Statusseite der API-Zugänge (`verbindungen_status`): letzter Lauf, Fehler, abgelaufene Sitzungen.
6. **CSV Upload** (AbrBot) — Bolt/Uber/myPOS-CSVs je Woche an n8n. **Bleibt als Notfallweg, nie entfernen.**
7. **Rechnungen** — Rechnungserstellung und Archiv, fortlaufende Nummer (HF-YYYY-NNNN), PDF in Supabase Storage.

**Kopfleiste seit 2026-10-03:** Abrechnung (Übersicht, Upload, Kassieren, Kassabuch, Löhne) · Fahrer (App, Post) ·
Rechnungen · **Experimentell** (API-Abrechnung, Fuhrpark, Verbindungen — funktionieren noch nicht verlässlich,
bewusst abgestellt). **Löhne** ist ein Reiter (`contentLohn`, JS in der Hülle `Lohn`, IDs/Klassen `lo…`);
`lohn.html` leitet nur noch weiter. Seit 07.10.: eine durchgehende Liste aller Lohnzettel des Monats, gruppiert je Firma
(Zwischenzeile mit Summen + Journal), Zuordnung direkt in der Zeile, Firmen als Chips – keine Seitenleiste.

**Zu-/Abschläge (seit 2026-10-03):** Posten je Fahrer und Woche in `abrechnung_posten` („Pickerl selbst
bezahlt +70“), Eingabe im Seitenpanel der Abrechnung. Geschrieben wird nur über `posten_anlegen` /
`posten_loeschen`; die Summe landet in `settlements.korrektur` (+ Notiz) und steckt in `auszahlung`.
Rechnet der AbrechnungsBot die Woche neu, fällt sie heraus: `abrechnung_posten_offen` zeigt das, das
Dashboard bietet „Wieder einrechnen“ (`posten_neu_anwenden`). `korrektur` nie von Hand setzen.

**Kassabuch (seit 2026-10-03):** Reiter Abrechnung → Kassabuch (`contentKassabuch`, Hülle `Kassa`, Präfix `kb`).
Eine Bargeldkassa in `kassabuch`, geführt **je Kalenderwoche** wie die Abrechnung (ISO-Woche `JJJJ-Wnn`):
`anfang` (genau einmal), `ein`, `aus`. Hängt bewusst nicht an Kassieren. Absicherung – nicht aufweichen:
- **Wer** (`name`) ist immer der angemeldete Benutzer (`app_metadata.app_name`), nie ein Eingabefeld.
- Schreiben nur über `kassa_buchen` / `kassa_storno` / `kassa_anfang` / `kassa_abschliessen`.
  UPDATE, DELETE, TRUNCATE sperrt ein Trigger (`kassa_gesperrt`) – auch im SQL-Fenster. Storno = Gegenbuchung.
- Jede Buchung trägt `nr` (lückenlos) und `pruefsumme` (sha256 inkl. der Summe davor). `kassa_pruefen()` rechnet
  die Kette und die Abschlüsse nach; das Dashboard zeigt „Unverändert“ bzw. die erste auffällige Nummer.
- **Wochenabschluss** (`kassa_abschluss`): hält Anfangsbestand/Übertrag, Einnahmen, Ausgaben, Endbestand und den
  gezählten Betrag samt Differenz fest. Erst ab Sonntag der Woche, Wochen der Reihe nach. Danach nimmt die Woche
  keine Buchung mehr an; der Endbestand ist der Übertrag in die nächste KW.

- **Anfangsbestand korrigieren** (`kassa_anfang_korrigieren`): eigene Zeile `quelle = 'anfang'` am Tag des
  Anfangsbestands, zählt zum Anfangsbestand statt zu Ein/Aus. Nur solange noch keine Woche abgeschlossen ist.
- **Abrechnung → Kassabuch:** „Unterm Strich“ (Σ `auszahlung − lohn` der `berechnet`-Zeilen, ohne `__…` und ohne
  `WARNUNG_KEIN_FAHRER`) wird bar ausgezahlt. Knopf „Ins Kassabuch übernehmen“ im Kassabuch (`kassa_abrechnung_buchen`):
  eine Zeile Abrechnung ohne Zu-/Abschläge + je Zu-/Abschlag eine Zeile (Zuschlag = Ausgabe). Spätere Änderungen
  kommen als Zeile „Änderung“ (Differenz). Ist die Woche übernommen, bucht `posten_anlegen` sofort mit und
  `posten_loeschen` storniert. Diese Zeilen (`quelle` ≠ `hand`) lassen sich nicht von Hand stornieren.
  Kassieren (`kassier_zahlungen`) fließt bewusst NICHT ins Kassabuch. `kassa_summe` nie ändern – es gibt Buchungen.

**Protokoll (seit 2026-10-09):** eigener Punkt in der Kopfleiste, **nur für `admin`** (`contentProtokoll`, Hülle `Proto`,
Präfix `pr`). Kontrolle „wer hat was geändert“. Absicherung – nicht aufweichen:
- Die Datenbank schreibt selbst mit: Trigger `protokoll_mitschreiben` (Funktion `protokoll_schreiben`) auf `settlements`,
  `abrechnung_posten`, `kassier_zahlungen`, `abrechnung_freigaben`, `post_eingang` (nur Entscheidungsfelder, kein INSERT),
  `mietverhaeltnisse`, `zuordnung_manuell`, `lohn_personen`, `name_aliases`, `fahrer_app_zugang`, `customers`, `companies`.
  Fahrername: `notion_fahrer_id` → `notion_fahrer`, `fahrer_id` (Post) → `fahrer.id` – zwei Nummernkreise.
  **Neue Tabelle mit Büro-Schreibzugriff → Trigger anhängen** (Liste am Ende von `migrations/2026-10-08-protokoll.sql`)
  und in `protokoll_bereich`, `PR_TAB` eintragen.
- Wer = `auth.jwt()`: Büro-Name, „Fahrer n“, „Automatik“ (`service_role`: n8n, Edge Functions) oder „SQL-Fenster“ (kein JWT –
  auch das Supabase-MCP). Nie als Parameter.
- `protokoll`: UPDATE/DELETE/TRUNCATE per Trigger gesperrt, kein INSERT-Recht für irgendeine Rolle, SELECT nur `is_app_admin()`.
- Der Trigger schluckt eigene Fehler (`raise warning`) – das Protokoll darf die Abrechnung nie blockieren.
- `protokoll_verlauf(…)` mischt `protokoll` + `sync_runs` (je Verbindung/Tag/Status) + `post_ausgang` + `kassabuch`;
  Automatik-Zeilen gleicher Tabelle/Woche/Minute kommen als Sammelzeile (`anzahl`, `ids`).
- Tests: `PGLITE=/tmp/pglite node scripts/test-protokoll.mjs` (lokales Postgres per PGlite, Tabellen-Nachbau in
  `scripts/test-protokoll-schema.sql`, Asserts in `scripts/test-protokoll.sql` – berührt die Live-Datenbank nicht),
  `node --test scripts/test-protokoll-satz.mjs`.

## Plattform-Sync (seit 2026-09-22)

Grundsatz: **HYDRAlink ist der Spiegel.** Die Syncs schreiben ausschliesslich in
eigene Tabellen. `settlements`, `fahrer` und der AbrechnungsBot bleiben unberührt —
Geld entscheidet weiterhin das alte System.

### Edge Functions

| Function | Quelle | Schreibt nach |
|---|---|---|
| `bolt-sync` | Bolt Fleet Integration API (OIDC client_credentials) | `bolt_orders`, `bolt_drivers`, `bolt_vehicles` |
| `uber-sync` | Uber Fleet-Portal (gespeicherte Sitzung, 3 Berichte) | `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips` |
| `notion-sync` | Notion API (`/v1/data_sources/{id}/query`) | `fuhrpark`, `notion_fahrer`, setzt `fahrer.notion_fahrer_id` wo leer |
| `post-eingang` | PDF vom USP-Skript oder Upload, Claude-Auslese | `post_eingang`, Storage `post` |
| `post-senden` | SMTP Gmail (`sw.hydrafleet@gmail.com`, App-Passwort) | `post_ausgang`, Status in `post_eingang` |
| `revolut-auszahlung` | Revolut Business API (Serdo, READ+WRITE) | `revolut_zahlungen`, Gegenpartei in `fahrer_bank` |
| `revolut-webhook` | Revolut-Webhook (HMAC, `verify_jwt = false`) | Status in `revolut_zahlungen`, `revolut_webhook_events` |

Jeder Lauf schreibt eine Zeile nach `sync_runs`.

**Aufrufschutz (seit 2026-09-28):** Die drei Syncs nehmen nur den service_role-Key
(Zeitplan) oder Buero-User (`app_metadata.app_role` admin/user) an, sonst 403 —
der anon-Key steht im Frontend und ist ein gueltiges JWT. Die Rolle wird aus dem
Token gelesen, die Signatur prueft das Gateway: `verify_jwt` NIE abschalten (einzige Ausnahme: `revolut-webhook`, HMAC-geschützt).
`uber-probe` ist stillgelegt (410) und kann im Supabase-Dashboard geloescht werden.

### Zeitplan (`pg_cron`)

```
*/10 * * * *   notion-sync-laufend        Notion-Aenderungen binnen ~10 Min sichtbar
0 4 * * 1      bolt-sync-woechentlich     Montag 04:00
0,10,30 5 * * 1  uber-sync-woechentlich   Montag 05:00, 05:10, 05:30 (nach Bolt), Body {"nur_offene": true}
20 2 * * *     sync-runs-aufraeumen       reines SQL, alte Laeufe loeschen
```

### Zugangsdaten

Ausschliesslich im **Supabase Vault**. Nie im Code, nie im Klartext in Tabellen,
nie im Frontend. `verbindungen` speichert nur Metadaten (Anbieter, Firma,
`externe_id`, Status, letzter Fehler) und den Vault-Verweis.

- Lesen: `verbindung_zugang(p_verbindung_id)` — nur `service_role`
- Setzen: `verbindung_setzen(...)` — legt/ersetzt das Vault-Secret
- Uber-Sitzung erneuern: `node scripts/uber-session-speichern.js`
  (liest die Cookies per CDP aus dem laufenden Browser und schreibt sie direkt in
  den Vault — die Cookies landen nie auf der Platte)
- Notion-Token setzen: `node scripts/notion-token-speichern.js`

**Zwei Uber-Verbindungen** seit 2026-09-28: `eh_limousinenservice_kg` (Org `08fc2f53-…`)
und `ee_taxi_kg` (E&E Taxi KG, Org `c566f3b3-…`, eigener Login, Browser-Profil
`~/.hydrafleet-uber-profile-ee`). Die Fahrer sind am 25.09. von EH zu E&E gewechselt.
**EH ist seit 2026-10-12 `pausiert`** (fährt nicht mehr über Uber, Sitzung abgelaufen) – `uber-sync` ruft nur
`aktiv` ab, `verbindungen_status` blendet pausierte aus. Abgerufen wird nur noch E&E.

**Die Uber-Sitzungen laufen ab** (EH: gültig bis 2026-10-06; E&E: gesetzt 2026-09-28). Danach
schreibt `uber-sync` `sitzung_abgelaufen:` in `verbindungen.letzter_fehler`, der
Verbindungen-Tab zeigt es an. Erneuern mit dem Skript oben.

## Post & Strafen (seit 2026-09-28)

Behördenpost an **Hydrafleet KG** (USP „Mein Postkorb“) landet zusätzlich zu Telegram in
HYDRAlink. Spec: `docs/superpowers/specs/2026-09-28-post-strafen-design.md`, Plan:
`docs/superpowers/plans/2026-09-28-post-strafen.md`.

- **Eingang:** `/root/usp-bot.sh` auf `taxi` (stündlich) schickt jedes PDF zusätzlich an die
  Edge Function `post-eingang` (Header `x-post-key` aus `/root/.post-eingang-key`, Vault-Anbieter
  `usp`). Telegram und `CloseDelivery` laufen auch, wenn HYDRAlink nicht antwortet. Repo-Kopie
  ohne Token: `scripts/server/usp-bot.sh`.
- **Auslesen:** Claude (`claude-sonnet-5`, Key im Vault, Anbieter `anthropic`) liest Art, GZ,
  Kennzeichen, Tatzeit, Betrag, Frist, Antwortadresse. Reine Logik und Prüfregeln in
  `supabase/functions/_shared/post-logik.ts` (Tests: `node --test scripts/test-post-logik.mjs`).
  Lenkererhebung ohne Datum: Frist = Zustellung + 14 Tage.
- **Lenkererhebung beantworten:** `post-senden` schickt per SMTP (`smtp.gmail.com:465`, App-Passwort im Vault, Anbieter `gmail`) von `sw.hydrafleet@gmail.com`
  „vermietet an <Mieter zur Tatzeit>“ — nur per Knopf im Dashboard-Reiter **Fahrer → Post** (`contentPost`, JS-Präfix `ps`; `post.html` leitet nur noch dorthin). Mieter der ganzen Flotte
  stehen in `mietverhaeltnisse` (Wiener Datum der Tatzeit, bis inklusive; im Post-Reiter → Mieter
  pflegen, Knopf „Mieter“ im Post-Reiter). Nie zweimal je GZ: Reservierung in `post_ausgang` vor dem Versand + Unique-Index `post_ausgang_gz_einmal`. Alte Handantworten wurden am 30.09. einmalig aus Gmail abgeglichen (`quelle='gmail_abgleich'`).
- **Strafen:** Fahrer-Vorschlag über Kennzeichen (`post_fahrer_vorschlag`), Büro bestätigt und
  gibt frei (`post_freigeben`) → Fahrerapp „Mehr → Strafen“ (`fahrer_app_strafen`, Bucket `post`,
  Policy `post_pfad_erlaubt`).
- **Rückstand / Nachholen:** Das USP hebt abgeschlossene Zustellungen noch eine Zeit auf.
  `/root/usp-rueckstand.sh --liste | --eine <ID> | --alle` holt sie (nur die laut Log
  abgeschlossenen) und schickt sie an `post-eingang`; Doppelte erkennt der sha256.
- **USP-Proxy** (`/root/usp-proxy.js`, systemd `usp-proxy`) lauscht seit 28.09. nur auf
  `127.0.0.1:9999` — vorher war er offen im Internet. Nie wieder auf `0.0.0.0`.
- **Zugänge einrichten:** `scripts/post-zugaenge-einrichten.js` (USP-Schlüssel + Anthropic,
  `pbpaste | … --nur-anthropic`, `… --nur-gmail` für das Gmail-App-Passwort). `scripts/gmail-zugang-speichern.js` (Google-OAuth) ist nicht mehr in Gebrauch.

## Bankdaten (seit 2026-10-15)

Spec `docs/superpowers/specs/2026-10-15-iban-fahrerapp-design.md`, Plan `docs/superpowers/plans/2026-10-15-iban-fahrerapp.md`.
- Tabellen `fahrer_bank` (aktuell, je Notion-Nr.), `fahrer_bank_verlauf` (jede Änderung, Trigger sperrt Update/Delete),
  `bank_bestaetigung` (je Woche). Lesen nur Büro; schreiben nur über `fahrer_bank_setzen` / `bank_bestaetigen` (Fahrer)
  und `buero_bank_setzen` / `formular_iban_zuordnen` (Büro), alle über `bank_schreiben()` (nicht aufrufbar).
  `bank_betrag()` ist ebenfalls nicht aufrufbar – sonst könnte ein Fahrer fremde Auszahlungen abfragen.
- **Seit 18.10.2026 Büro-Prüfung statt Wochen-Bestätigung** (`migrations/2026-10-18-fahrer-bankdaten.sql`):
  `fahrer_bank.geprueft/_am/_von` + `revolut_counterparty_id`; jede Änderung (Fahrer oder Büro) setzt beides zurück.
  Büro bestätigt per `bank_pruefen(nr, gesehene_iban)`. `bank_bestaetigen` ist abgeschaltet (kein execute),
  `bank_bestaetigung` nur noch Verlauf. Übernahme: wer aktuelle IBAN+Inhaber schon bestätigt hatte → geprüft (16/27).
  `fahrer_app_bank()` liefert die IBAN nur maskiert (`iban_maskiert`), das App-Formular startet mit leerer IBAN.
  `bank_uebersicht.iban_geaendert_am` = letzter echter IBAN-Wechsel → Hinweis „IBAN neu“ (14 Tage).
- Fahrerapp: Karte auf Start nur, solange Bankdaten fehlen; Mehr → Bankdaten (maskiert, Status In Prüfung/Bestätigt).
  Dashboard: Fahrer/App → Detail „Bankdaten“ (Knopf „Bankdaten bestätigen“), Filter „Bankdaten fehlen“ / „Bank ungeprüft“,
  Spalte „Bank“ (fehlt/ungeprüft/geprüft), Karte „Bankdaten aus dem Formular, nicht zugeordnet“.
- IBAN-Prüfung doppelt mit gleichen Regeln: `bank-logik.js` (Browser, `node --test scripts/test-bank-logik.mjs`) und
  `iban_gueltig()` (SQL; ersetzt seit 15.10. die ältere Funktion gleichen Namens, die der Check von `fahrer_iban` nutzt).
  DB-Test: `PGLITE=<dir> node scripts/test-bankdaten.mjs`.
- Das öffentliche Formular `~/Projects/iban-formular` (Netlify, `fahrer_iban`) sammelt kaum Telefonnummern –
  `formular_iban_fahrer()` ordnet deshalb auch über den Namen (name_key, `name_aliases`) zu, nur bei genau einem
  aktiven Fahrer. Übernommen am 15.10.: 10 Fahrer. Formular läuft noch; abschalten, wenn der Betreiber es sagt
  (anon-Insert-Policy entfernen, Seite durch Hinweis ersetzen).
- **Revolut-CSV** (seit 2026-10-15): Abrechnung → „Revolut-CSV“ erzeugt eine Sammelüberweisung im Format der
  Revolut-Vorlage (`Name,Recipient type,IBAN,Recipient bank country,Currency,Amount,Payment reference`, CRLF, Punkt).
  Fahrer mit hinterlegter IBAN, IBAN/Inhaber aus `fahrer_bank`; ungeprüfte markiert (`auszahlung_export.bestaetigt` = geprüft,
  seit 18.10.). Betrag änderbar. Jeder Export in
  `auszahlung_export` (`auszahlung_liste`, `auszahlung_export_speichern`); zweimal je Fahrer/Woche nur ausdrücklich.
  Blauer Punkt in der Übersicht mit Ring = schon exportiert. Welches Konto (Serdo/E&E) zahlt, entscheidet das Büro beim Hochladen.
- **Revolut-API (seit 18.10.2026, Sandbox; Produktion erst nach OK des Betreibers)** – nur **Serdo**-Konto, Scopes READ + WRITE,
  **kein PAY**: `revolut-auszahlung` legt nur Payment-Drafts an, freigegeben wird in der Revolut-App.
  Migration `2026-10-18-revolut-zahlungen.sql`, Logik `_shared/revolut-logik.ts` (`node --test scripts/test-revolut-logik.mjs`).
  - Dashboard: Abrechnung → „Revolut-Entwurf“ (nur freigegebene Woche) → Vorschau mit Kontostand/Fehlbetrag, Auswahl, „Entwurf anlegen“,
    „Status“. Betrag = „Du bekommst“ aus der DB (`revolut_kandidaten`), nie aus dem Browser.
  - Rein nur: Bankdaten geprüft, Betrag > 0, nicht schon per Revolut-CSV exportiert, keine aktive Zahlung. Je Woche+Fahrer eine Zeile in
    `revolut_zahlungen` (unique), vorher atomar reserviert (`revolut_reservieren`). `verworfen`/`failed`/`declined` dürfen neu.
  - Referenz `Auszahlung KW42/26 FHR-<nr>`; darüber ordnet `revolut-webhook` die Buchung zu. „Status“ sucht zuerst die Buchung zur
    Referenz und setzt einen verschwundenen Entwurf erst dann auf `verworfen` – sonst droht doppelte Zahlung. Hängt eine Zeile auf
    `reserviert` (Function abgebrochen), in Revolut nachsehen und von Hand klären – nicht einfach löschen.
  - Gegenpartei in `fahrer_bank.revolut_counterparty_id/_account_id/revolut_empfaenger` (Revtag vor IBAN). Trigger
    `fahrer_bank_revolut_zurueck`: jede Änderung an IBAN/Inhaber/BIC/Revtag löscht Gegenpartei + Prüfung.
  - Secrets nur als Edge-Function-Secrets (setzt der Betreiber): `REVOLUT_PRIVATE_KEY`, `REVOLUT_CLIENT_ID`, `REVOLUT_REFRESH_TOKEN`,
    `REVOLUT_ACCOUNT_ID`, `REVOLUT_WEBHOOK_SECRET`, `REVOLUT_ENV` (`sandbox` | `production`). Access-Token je Aufruf, nie gespeichert.
    Einrichten: `scripts/revolut-einrichten.mjs` (zertifikat → link <client-id> → token <code> → pruefen), Redirect
    `hydrafleet.pages.dev/revolut-ok`. Schlüssel in `~/revolut` (0700). Das Skript setzt die Secrets selbst über die Supabase-CLI
    (`~/.hydrafleet-supabase-cli`, einmal `supabase login`) und gibt Token/Secrets nie aus.
  - **Überweisungshistorie** (`2026-10-18-revolut-buchungen.sql`): `revolut_buchungen` spiegelt alle ausgehenden Überweisungen
    seit Kontoeröffnung (Aktion `buchungen_abrufen`, täglich 05:45 per `pg_cron` `revolut-buchungen-taeglich`, Knopf „Revolut abrufen“;
    der erste Abruf holt die Historie über mehrere Läufe, Stand in `revolut_abruf`). Zuordnung `revolut_buchungen_zuordnen()`:
    eigener Entwurf → Referenz `FHR-<nr>` (schlägt die Hand-Zuordnung) → Hand-Zuordnung der Gegenpartei (`revolut_gegenpartei_zuordnung`, null = kein Fahrer) →
    IBAN eines einzigen Fahrers (auch frühere aus dem Verlauf). Nicht zugeordnet: Karte „Revolut-Überweisungen ohne Fahrer“
    im Fahrer-Reiter. Fahrer-Detail „Überweisungen (Revolut)“, Fahrerapp Bankdaten → `fahrer_app_ueberweisungen`.
    Vor jedem Entwurf werden die letzten 14 Tage neu geholt; wer seit der Freigabe der Woche schon Geld bekam
    (`revolut_kandidaten.seit_freigabe_ueberwiesen`, Referenz mit anderer KW zählt nicht), bleibt draußen – außer die Überweisung ist
    als **Vorschuss** markiert (`revolut_buchungen.vorschuss`, `revolut_buchung_vorschuss`, Knopf im Fahrer-Detail). Bar Ausgezahltes
    (Kassabuch) sieht die Sperre NICHT; ältere Wochen zeigen im Dialog deshalb einen Warnhinweis (Entwürfe bewusst für alle Wochen).
  - `revolut-webhook` läuft als einzige Function mit `verify_jwt = false` (Revolut schickt kein Supabase-JWT); Schutz ist die
    HMAC-Signatur (`Revolut-Signature`, max. 5 Min alt). Ohne Secret wird alles mit 401 abgelehnt. Doppelte Events: `revolut_webhook_events`.

## Auszahlung (seit 2026-10-19)

Spec `docs/superpowers/specs/2026-10-18-auszahlung-uebersicht-design.md`, Plan `docs/superpowers/plans/2026-10-18-auszahlung-uebersicht.md`.
Ziel des Betreibers: Großteil über Revolut, kleiner Rest bar. **Eine Stelle rechnet:** `auszahlung_status_basis(woche)`
(nicht direkt aufrufbar) → `auszahlung_status` (Büro), `revolut_kandidaten` (Edge Function, nur *revolut_offen*),
`fahrer_app_auszahlung` (Fahrerapp, **nur Überweisungen – bar kommt in der App nicht vor**).
- Status je Fahrer/Woche: `revolut_offen`, `bar_offen`, `entwurf`, `unterwegs`, `ueberwiesen`, `bar_ok`, `bar_woche`,
  `rest_offen`, `zu_viel`, `schulden`, `nichts`. Weg: `auszahlung_weg` (Hand, je Woche) > geprüfte Bankdaten = revolut > bar.
- Bezahlt = Revolut-Entwurf/-Zahlung + zugeordnete `revolut_buchungen` (ohne Vorschuss; `buchung_fuer_woche`: KW aus der
  Referenz via `referenz_kw`, sonst ab Freigabe) + CSV-Export (nur solange keine Buchung mit gleicher Referenz existiert) + `bar_auszahlungen`.
- Woche gesamt ins Kassabuch übernommen (`quelle = 'abrechnung'`) = damals alles bar → unbezahlte Fahrer `bar_woche`, nie neu auszahlen.
- Bar: `bar_auszahlen(woche, nr)` bucht `kassa_einfuegen(..., 'bar', ...)` (neuer `quelle`-Wert), `bar_rueckgaengig(id)` = Gegenbuchung.
  Trigger `kassa_bar_sperre`: keine Wochenbuchung, sobald es Bar-Zeilen gibt; `kassa_abrechnung_stand` zeigt solche Wochen nicht.
- Rest (`rest_offen`) wird immer bar beglichen – ein zweiter Revolut-Posten je Woche/Fahrer geht wegen `unique(woche, nr)` nicht.
- Dashboard Abrechnung (Redesign 19.10., Plan von Fable): **Auswahl per Häkchen in der Tabelle** (nur Status *revolut_offen*,
  Woche freigegeben, nicht von der Vorschau gesperrt; keine Vorauswahl), Kopf-Häkchen `uwAlle` = alle überweisbaren der gefilterten
  Liste, Filter **„IBAN, nicht überwiesen“** (`azIbanOffen`: IBAN da, Betrag offen, Status revolut_offen/bar_offen/bar_woche/rest_offen),
  Leiste `uwLeiste` (Auswahl, Summe, Kontostand, rot „n mit IBAN noch nicht überwiesen“) mit Knopf **„Überweisen“** `uwGo` → Dialog `uwDialog` (Vorschau, „Entwurf
  anlegen“, Ergebnis). Status-Badges (`uwZelle`, `UW_BADGE`), Filter Alle·Offen·Überwiesen, Rest im ⋯-Menü (`azMenue`, u. a.
  „Revolut-Stand prüfen“ = Aktion status). Je Zeile Knopf **„Überweisen“** (nur dieser Fahrer, `uwDialog([nr])`), bei *bar_woche*
  Knopf **„noch offen“** (`auszahlung_weg_setzen(..,'revolut')` – Kassabuch-Woche nur teilweise bar bezahlt, z. B. KW41; seit 18.10.
  gilt *bar_woche* nur ohne Hand-Umstellung). **„Bankdaten prüfen“** (Leiste + ⋯-Menü, `bpDialog`): alle ungeprüften mit voller
  IBAN, Kontoinhaber ≠ Name / IBAN neu markiert, abhaken → `bank_pruefen` je Fahrer. **Bar/Kassabuch (`bar_auszahlen`, `auszahlung_weg_setzen`, `bar_rueckgaengig`) bleiben
  in der DB, sind aber vorerst ohne UI** (Entscheidung Betreiber 19.10.).
- Test: `PGLITE=<dir> node scripts/test-bankdaten.mjs` (Abschnitt Auszahlungs-Status).

**myPOS ohne Fahrer zuordnen** (seit 19.10., `2026-10-19-mypos-zuordnen.sql`): Karte `mpKarte` in der Abrechnung listet die
Bot-Zeilen `__MYPOS:<Terminal>__` (Status `MYPOS_UNASSIGNED`). `mypos_zuordnen(myposZeile, fahrerZeile)` addiert den Betrag als myPOS-Umsatz
und rechnet `bruttoumsatz_gesamt`, `wir_bekommen`, `prozent_abzug` (`prozent_nach_regel`, wie der Bot), `abzug_gesamt`, `auszahlung` nach
(Prozent als Differenz); die myPOS-Zeile wird `MYPOS_ZUGEORDNET`. Verlauf `mypos_zuordnungen`, `mypos_zuordnung_zurueck` nur solange
die Fahrer-Zeile unverändert ist. Ein Neu-Upload rechnet die Woche neu → Terminal in Notion zuordnen. Test: `scripts/test-mypos-zuordnen.mjs`.
`__…`-Zeilen erscheinen nicht mehr in der Tabelle und zählen nicht zu den Kennzahlen.

## Automatische Abrechnung (seit 2026-10-19, Bolt + Uber; myPOS folgt)

Betreiber 18.10.: „morgen um 5:00 die automatische Abrechnung, als Übersicht rein wie nach einem CSV-Upload“.
Migration `2026-10-18-abrechnung-api-automatisch.sql`.
- `pg_cron` **`montag-frueh`** (`*/5 1-6 * * 1` UTC) ruft `montag_frueh()`, die nach **Wiener** Uhr entscheidet (Zeitumstellung egal):
  04:10 Bolt-Sync, 04:15/04:25/04:40 Uber-Sync (`nur_offene`), 05:00 `abrechnung_api_schreiben(<Vorwoche>)`,
  Wiederholung 05:30/06:00/07:15 falls Bolt/Uber noch fehlen. Die alten Zeitpläne (Bolt 04:00 UTC, Uber 05:00 UTC) bleiben.
- `abrechnung_api_schreiben(woche[, p_probe])` schreibt `api_abrechnung` → `settlements` **nur wenn die Woche noch leer ist**
  (CSV schon da = nichts anfassen) und Bolt + Uber gesynct sind. Konten ohne Fahrer → `WARNUNG_KEIN_FAHRER`. Stand in
  `abrechnung_api_laeufe`. `p_probe := true` rechnet nur (Prüfung KW41: 30.772,14 € vs. CSV 30.770,14 €, bekannte 2-€-Abweichung).
- **myPOS fehlt** (kein API-Zugang, neues myPOS-Konto folgt; die alten Zugangsdaten liegen im Vault, `mypos_transactions_api`,
  brauchen aber `X-Session` aus dem neuen Gateway). Dashboard zeigt `apiBanner`, solange die Woche automatisch und ohne myPOS ist.
  Der normale CSV-Upload überschreibt die Zeilen (Bot-Upsert auf `woche, fahrer_name`) – **vor dem Freigeben hochladen**.
- Auszahlungswerte ohne CSV kommen aus dem Fahrer-Stamm (`fahrer.basis_miete`, `mietmodell`, `prozent_*`).
- **Automatische Freigabe** (seit 19.10., `2026-10-19-abrechnung-api-status.sql`): `montag_frueh()` ruft nach dem Schreiben
  `abrechnung_auto_freigeben(w)` – gibt die Woche als „Automatik“ frei (Fahrer sehen sie in der App, sie ist überweisbar).
  Schon freigegebene Wochen bleiben unberührt.
- **myPOS ohne Fahrer** (seit 19.10., `2026-10-19-mypos-offene-zeilen.sql`): `montag_frueh()` legt nach dem Schreiben über
  `mypos_offene_zeilen(w)` je Terminal ohne Fahrer eine `__MYPOS:<Terminal>__`-Zeile (`MYPOS_UNASSIGNED`) an → Karte „myPOS ohne Fahrer“.
- **Erster Lauf 19.10. (KW42) scheiterte an der abgelaufenen E&E-Uber-Sitzung** (`org_access_denied: session_org_missing`, abends davor
  noch gültig). Nachgeholt um 10:07: Sitzung aus `~/.hydrafleet-uber-profile-ee` neu gespeichert, `uber-sync-aufrufen.js 2026-W42`
  (erst `rate-limited`, nach 3 Min ok), dann `abrechnung_api_schreiben` + `abrechnung_auto_freigeben` von Hand. Ablauf im Notfall genauso.
- **Statuszeile** `azStatus` oben in der Abrechnung (`abrechnung_api_status()`, letzte abgeschlossene Woche in Wien): Bolt, Uber,
  myPOS (Auszug/CSV), Abrechnung, Freigabe – je ✓ mit Uhrzeit, „geplant“ vor dem Lauf, rot ab ca. 3 h nach 05:00.
- **myPOS aus dem Kontoauszug** (seit 18.10., `2026-10-18-mypos-umsaetze.sql`): `mypos_umsaetze` (Woche, Terminal, Summe, Notion-Fahrertext,
  `fahrer_id` über `mypos_fahrer_id()` – Name/`name_key`/Alias, nur eindeutig). `api_abrechnung` nimmt `mypos_summe` aus der CSV,
  sonst aus `mypos_umsaetze`; `abrechnung_api_schreiben` schreibt es mit. Quelle: myPOS-Export `account_transactions_*.xlsx`
  (Spalten „Terminal name“, „Amount“), Terminal → Fahrer aus dem n8n-Webhook `/webhook/mypos-terminals` (gleiche Regeln wie der Bot:
  leerer Text zählt nicht, letzter Eintrag gewinnt). KW42 am 18.10. von Claude importiert (25 Terminals zugeordnet, 4 ohne Fahrer,
  120,88 €). Import künftiger Wochen: noch von Hand (Datei schicken) – Upload im Dashboard fehlt.

## Key Supabase Tables

**Bestehend (altes System, nicht anfassen):**
- `settlements` — Processed driver settlement data per week
- `fahrer` — Driver records (synced from Notion **via n8n**)
- `rechnungen`, `companies`, `customers`, `app_users`, `kassier_zahlungen`

**Neu (Plattform-Spiegel, alle mit RLS, `anon` ohne Rechte):**
- `verbindungen`, `sync_runs` — Zugänge und Laufprotokoll
- `bolt_orders`, `bolt_drivers`, `bolt_vehicles`, `bolt_state_logs`
- `uber_reports`, `uber_drivers`, `uber_vehicles`, `uber_trips`
- `fuhrpark`, `notion_fahrer` — Notion-Lesekopien

**Post & Strafen:** `post_eingang`, `post_ausgang`, `mietverhaeltnisse` (RLS: Büro liest, Fahrer nur über `fahrer_app_strafen`)

**Views (alle `security_invoker = true`):**
`abrechnung_abgleich`, `bolt_abgleich`, `fahrer_uebersicht`, `fuhrpark_uebersicht`, `zuordnung_abgleich`, `verbindungen_status`

**Funktionen:** `verbindung_zugang`, `verbindung_setzen`, `kennzeichen_key`,
`tel_key`, `name_key`, `fuhrpark_ersetzen`, `notion_zuordnung_aktualisieren`,
`settlement_fahrer`, `sync_takt`

## Key n8n Workflows

- **AbrechnungsBot** (`RTeVugetfAjSTPQs`) — CSV settlement processing
- **Fahrer-Sync** (`ERBnlIVSkteL90Bg`) — Notion → Supabase `fahrer` via webhook
- **Full-Sync** (`bCyUwmFeuoG762yC`) — Full Notion → Supabase sync
- **Webhook endpoints:**
  - Dashboard → n8n: `https://n8n.hydrafleet.at/webhook/abrechnung-upload` + `/webhook/invoice`
  - Notion → n8n (fahrer-sync): `https://webhook.hydrafleet.at/webhook/fahrer-sync`

Hinweis: im n8n-MCP sind nur die Workflows sichtbar, bei denen "Available in MCP"
aktiviert ist — aktuell zwei.

## Important Patterns & Gotchas

### Code Style
- Everything is in a single HTML file per page (no build step, no bundler)
- CSS variables for theming (light/dark via `data-theme` attribute; hell = Attribut entfernt)
- Supabase JS client loaded via CDN, initialized lazily
- All German UI labels

### Known Pitfalls
- **Ein Fahrer hat pro Bolt-Firma eine eigene Driver-UUID.** Deshalb gibt es kein
  `fahrer.bolt_driver_uuid`, sondern `bolt_drivers.fahrer_id` (viele Konten → ein Fahrer).
  Gleiches Muster bei `uber_drivers.fahrer_id`.
- **Bolt-Zeitfilter**: `time_range_filter_type: "price_review"`, nicht `created`.
  Mit `created` streuen die Werte über Wochengrenzen.
- **`settlement_fahrer()` nimmt bei gleicher Telefonnummer den aktiven Fahrer**, erst dann die kleinste id
  (Dombaew 633 inaktiv / 639 aktiv).
- **Fahrer entstehen nur über den Fuhrpark in Notion** (Entscheidung Betreiber 12.10.2026): wer dort keinem Auto
  zugeordnet ist, fehlt in `fahrer`, sein Plattform-Konto bleibt „ohne Fahrer“ und der AbrechnungsBot rechnet ihn als
  „UNBEKANNT“ ohne Pauschale. Der Status auf der Notion-Fahrerseite zählt nicht. Abhilfe ist der Eintrag im
  Notion-Fuhrpark, kein Anlegen in HYDRAlink (am 12.10. gebaut und wieder entfernt, Commits 420737b/13d1c17).
- **PostgREST antwortet bei `return=minimal` mit 201 und leerem Body**, nicht 204.
  Immer erst `await r.text()`, dann nur parsen wenn nicht leer.
- **Ubers Abrechnungswoche beginnt Montag ~04:00 Wien**, nicht Mitternacht UTC.
  Ubers Fenster (`GetReportingTimeWindows`) sind **Auszahlungszeiträume, keine Wochen**:
  eine Auszahlung mitten in der Woche teilt sie (KW39: EH 14.09.–25.09. 10:48). Ihre
  Grenzen liefern nur die genaue Uhrzeit des Montagswechsels (±12 h), sonst wird
  Montag 04:00 Wien gerechnet. Kontrolle: `node scripts/uber-sync-aufrufen.js <JJJJ-Wnn> test`
  zeigt Fenster und Ubers Rohfenster, ohne Daten zu schreiben.
- **Uber benennt Berichtsspalten um.** Seit KW40/2026 heißt „An dein Unternehmen gezahlt …“ im Bericht
  „An dich gezahlt …“. Der AbrechnungsBot kennt nur die alte Schreibweise → Uber war in KW40 überall 0.
  Der Upload im Dashboard benennt deshalb die Kopfzeile zurück (`uberKopfAngleichen`). `uber-sync` liest seit
  v8 beide Schreibweisen (`spalte()` in `_shared/uber-logik.ts`).
- **Eine Edge Function lebt höchstens 150 s** (`WORKER_RESOURCE_LIMIT`, Status 546, `sync_runs` bleibt auf
  `laeuft`). Ubers Zahlungsbericht brauchte am 12.10.2026 213 s → KW41 fehlte. Seit v8 wartet `uber-sync` nur
  115 s, endet sonst mit `berichte_noch_nicht_fertig`, und der nächste Lauf nimmt dieselben Berichte wieder auf
  (`berichtWaehlen`: gleicher Typ + gleiches Fenster, höchstens 1 h alt). Deshalb drei Zeitplan-Läufe mit
  `nur_offene`; beide Uber-Konten laufen gleichzeitig. Von Hand: denselben Aufruf nach ein paar Minuten
  wiederholen. Tests: `node --test scripts/test-uber-logik.mjs`.
- **Fahrzeugbilder** (seit 2026-10-07): Ubers Modellbilder je Kennzeichen in `uber_fahrzeuge` (+ Marke, Modell,
  Baujahr, Farbe), Dateien in `img/fahrzeuge/`. Anzeige im Fuhrpark-Reiter (`fpBild`) und in der Fahrerapp
  (Reiter Fahrzeug, `fahrer_app_profil().fahrzeug_bild`). Einmalig geholt mit `scripts/uber-fahrzeugbilder.js`,
  kein laufender Sync – neue Autos brauchen einen neuen Lauf.
- **CSV braucht einen echten RFC-4180-Parser.** Ein Fahrername wie "Ahmed Safa, Beng"
  hat am 14.09. einen ganzen Import zerlegt.
- **Notion-Feld `"Pauschale "` hat ein Leerzeichen am Ende.** Nicht wegkürzen.
- **Notion API**: Datenbanken sind seit Version 2025-09-03 in Datenquellen geteilt.
  `/v1/databases/{id}/query` ist abgekündigt → `/v1/data_sources/{id}/query`.
- **FKs auf `fahrer(id)` brauchen `ON DELETE SET NULL`**, sonst scheitert der
  bestehende n8n-Sync beim Löschen eines Fahrers.
- **Fehlende Daten sind keine Abweichung.** Wird eine Plattform für eine Woche nicht
  gesynct, darf der Abgleich das nicht als Fehlbetrag zeigen — `abrechnung_abgleich`
  prüft deshalb je Woche, ob die Plattform überhaupt Daten hat.
- **Eine Summe kann auf beiden Seiten dieselbe Lücke haben und trotzdem stimmen.**
  Ein nicht zugeordnetes Plattformkonto fehlt sowohl in der API-Summe als auch in der
  Abrechnung. Deshalb zählt `abrechnung_abgleich` Konten ohne Fahrer ausdrücklich mit.
- **Die Uber-Sammelzeile der Organisation** (`uber_reports.umsaetze is null`, in KW38
  −35.556,55 €) ist kein Fahrer und darf nie mitsummiert werden — dasselbe Muster wie
  `__TRANSFER__` in `settlements`.
- **Mobile**: Flex-Items haben `min-width: auto` — 7 Tab-Buttons sprengen 390px.
  Deshalb Burger-Menü. Jede neue Tab-Leiste am Handy prüfen.
- **Dark Mode / Kennzeichen**: `.fz-main b` hat dieselbe Spezifität wie `.kz b`,
  steht aber später im Stylesheet. Darum `span.kz b`. Kommentar im Code nicht entfernen.
- **Duplicate form field names** create arrays instead of strings → sanitize form payloads
- **Fuzzy name matching** (threshold 0.92) im AbrechnungsBot: "unbekannt"-Fehler durch
  Angleichen der Notion-Namen lösen, nicht durch ein Alias-System.
- **JSON in HTML**: Escape `<` und `>` als Unicode-Escapes
- **n8n API updates**: Only `name`, `nodes`, `connections`, `settings`
- **Supabase anon key** is in the frontend (public, RLS-protected) — intentional

### Design Principles
- **Keep it simple** — no overengineering. Always offer the simpler path first.
- **Notion bleibt Stammdaten** (Fahrer, Fuhrpark), **Supabase nur Transaktionen.** Nicht zusammenlegen.
- **Jeder importierte Datensatz trägt die ID des Anbieters als Unique-Key** → Upsert,
  doppelter Import unmöglich.
- **Keine Daten erfinden** (IDs, Endpunkte, Feldnamen). Wenn etwas fehlt: fragen.
- **Iterate fast** — working solutions over lengthy planning

## Deployment

Push to `main` branch → Cloudflare Pages auto-deploys (nur das Frontend).

```bash
git add .
git commit -m "description"
git push origin main
```

Edge Functions und SQL werden **nicht** vom Push deployt — die laufen über den
Supabase-MCP bzw. die CLI. Nach jeder Änderung an einer Function: Repo-Datei und
deployte Fassung wieder angleichen.

## External Services

| Service | Purpose | Access |
|---------|---------|--------|
| Supabase | Database + storage + Edge Functions | `pkxcwfkfaaorwnbdmylg.supabase.co` |
| n8n | Workflow automation | Self-hosted on Hetzner (Docker) |
| Notion | Driver/vehicle master data | Fuhrpark DB, Fahrer DB |
| Bolt | Fleet Integration API | 2 Firmen: EH Limo (262554), Serdo (182009) |
| Uber | Fleet-Portal (Sitzung) | `fleethub.uber.com` |
| Cloudflare Pages | Static hosting | Auto-deploy from GitHub |
| Nginx Proxy Manager | SSL for webhooks | `webhook.hydrafleet.at` |
| Telegram | Driver notifications | Implemented, currently deactivated |
