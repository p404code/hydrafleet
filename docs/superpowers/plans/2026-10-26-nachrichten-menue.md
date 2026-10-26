# Fahrer-Nachrichten Teil 2 – Menü, Themen für alle, Gelesen-Anzeige – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Betreiber hat für Teil 1 „nativ“ gewählt). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Büro-Team bedient den Chat in Telegram über ein angeheftetes Knopf-Menü (Nachricht an alle mit Bestätigung, Fahrer finden, Info), jeder Fahrer mit App hat sein Thema von Anfang an, und beide Seiten sehen Zustellung/Gelesen.

**Architecture:** Baut auf Teil 1 auf (gleiche Tabellen, Trigger→pg_net→Edge Function, reine Logik in `_shared/telegram-logik.ts`). Neu: Tabelle `tg_menue` für offene Menü-Schritte, SQL-Funktionen für Fahrerliste/Suche/an-alle, zwei neue Aktionen in `telegram-senden` (`themen`, `gelesen`), Menü- und Knopf-Verarbeitung in `telegram-webhook`.

**Tech Stack:** wie Teil 1 (Postgres/PGlite-Tests, Deno Edge Functions mit Node-Attrappen-Tests, Telegram Bot API: inline_keyboard, callback_query, force_reply, pinChatMessage, setMessageReaction; Vanilla JS + headless-Chromium-Test).

**Spec:** `docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md`, Abschnitt „Teil 2“.

**Hinweis zur Form:** Autor und Umsetzer sind dieselbe Sitzung; der Plan legt Schnittstellen, Prüffälle (mit konkreten Erwartungen) und Dateien fest, der Code entsteht im TDD-Schritt (Test zuerst, rot sehen, dann Code). Abweichung vom Standard-Plan (der Code-Blöcke verlangt) – bewusst, um den Ablauf kurz zu halten.

## Global Constraints
- Alles aus Teil 1 gilt weiter (Notion-Nr. als Schlüssel, Token nie in Fehlern/Logs, nur `TELEGRAM_GRUPPE_ID`, HTML-escape, `verify_jwt` nur beim Webhook aus, Deploy per CLI `--use-api`, Push auf `main` durch den Betreiber).
- Berechtigte Fahrer = `fahrer.aktiv`, `fahrer_app_zugang` nicht gesperrt, Notion-Nr. unter den aktiven eindeutig (heute 54).
- Aus „Allgemein“ wird nur gespeichert: offene Menü-Schritte und die bestätigte Nachricht an alle.
- Telegram-Rate: höchstens 6 neue Themen je Lauf, ≥ 3 s Pause zwischen zwei Themen.
- Nachricht an alle: nur der Klicker darf bestätigen; Entwurf verfällt nach 24 h; doppelte Bestätigung legt nichts doppelt an.

## Review Focus
1. **Doppelklick auf „✅ Senden“** (oder Telegram wiederholt das Update) → Erwartung: jeder Fahrer bekommt die Nachricht genau einmal. Test Task 1 (`tg_an_alle` zweimal) + Task 4.
2. **Jemand anderes antwortet auf die Aufforderung / drückt Senden** → Erwartung: geht nicht raus bzw. „Nur <Name> kann das senden“. Test Task 4.
3. **Antwort auf irgendeine andere Bot-Nachricht in „Allgemein“** → Erwartung: wird nicht gespeichert, nichts passiert. Test Task 2/4.
4. **Themen-Lauf bei Telegram-Rate-Limit (429)** → Erwartung: bricht den Lauf ab, Rest im nächsten Lauf, keine doppelten Themen. Test Task 3.
5. **Fahrer verliert App-Zugang** → Erwartung: kein neues Thema, bekommt keine Nachricht an alle; vorhandenes Thema bleibt. Test Task 1.

## Dateien
| Datei | Änderung |
|---|---|
| `migrations/2026-10-26-nachrichten-menue.sql` (neu) | `an_alle`, Index, `tg_menue`, `tg_fahrer_liste`, `tg_fahrer_suchen`, `tg_an_alle`, `fahrer_app_nachrichten` neu, Trigger gelesen, Cron `themen-pflegen` |
| `scripts/test-nachrichten.mjs` | Teil-2-Prüfungen (lädt beide Migrationen) |
| `supabase/functions/_shared/telegram-logik.ts` (+ Test) | `einordnen` kennt Knopf-Klicks und Antworten in „Allgemein“; Menü-/Vorschau-/Info-Texte, Themen-Link, `pushText` mit „an alle“ |
| `supabase/functions/telegram-senden/index.ts` (+ `scripts/test-telegram-senden.mjs`) | Aktionen `{themen: true}`, `{gelesen: id}` |
| `supabase/functions/telegram-webhook/index.ts` (+ `scripts/test-telegram-webhook.mjs` neu) | Menü-Knöpfe, Aufforderungen, Vorschau/Bestätigen/Abbrechen, Suche |
| `supabase/functions/push-senden/index.ts` | „an alle“ im Push-Text |
| `scripts/telegram-einrichten.mjs` | `allowed_updates` + `callback_query`, Recht „Nachrichten anheften“ prüfen, Schritt `menue` |
| `fahrer/index.html`, `sw.js` (+ Browser-Test) | ✓ / „wird zugestellt“, „an alle“; Cache v59 |
| `CLAUDE.md` | Abschnitt „Nachrichten“ ergänzen |

---

### Task 1: Datenbank Teil 2
**Interfaces (Produces):**
- `nachrichten.an_alle boolean`; Unique `(tg_message_id, fahrer_nr) where richtung='team'` (alter Index `nachrichten_team_tg_einmal` weg).
- `tg_menue(prompt_message_id bigint PK, art 'alle'|'suche', tg_user_id bigint, tg_name text, entwurf text, vorschau_message_id bigint, erstellt_am)`.
- `tg_fahrer_liste() → (fahrer_nr int, name text, kennzeichen text, modell text)` – berechtigte Fahrer, sortiert nach Name.
- `tg_fahrer_suchen(p_q text) → (fahrer_nr, name, kennzeichen, thread_id)` – Name (ilike, Wortanfang egal), Nr. exakt, Kennzeichen über `kennzeichen_key`; max. 8; nur berechtigte.
- `tg_an_alle(p_text text, p_team_name text, p_tg_message_id bigint) → int` – Zeilen für alle berechtigten Fahrer, `on conflict do nothing`, liefert Anzahl neu angelegter.
- `fahrer_app_nachrichten(p_fahrer_id)` → zusätzlich `zugestellt boolean` (fahrer: `tg_message_id is not null`; team: true), `an_alle boolean`.
- Trigger `nachrichten_gelesen_melden`: `gelesen_am` null→Wert, `richtung='team'`, nicht `an_alle`, `tg_message_id` gesetzt → POST `telegram-senden` `{gelesen: id}`; schluckt Fehler.
- Cron `themen-pflegen` `*/5 * * * *` → POST `telegram-senden` `{themen: true}` nur wenn ein berechtigter Fahrer ohne `tg_themen`-Zeile existiert.
- Rechte: alle neuen Funktionen/Tabellen nur `service_role`; `fahrer_app_nachrichten` wieder für `authenticated`.

- [ ] Prüfungen in `scripts/test-nachrichten.mjs` (zweite Migration nach der ersten einspielen, zweimal):
  - `tg_fahrer_liste` liefert Anna/Bert/Cem (Zugang), nicht inaktive Zeile, nicht gesperrten Zugang (neuer Testfahrer mit `gesperrt=true`) → `[101,102,103]`.
  - `tg_fahrer_suchen('anna')` → Nr. 101; `('102')` → 102; `('w1111')` (Kennzeichen ohne Strich) → 101; `('xyz')` → leer; gesperrter Fahrer nie.
  - `tg_an_alle('Kontrolle', 'Boyko', 900)` → 3; nochmal → 0; Zeilen haben `an_alle`, `team_name`, `richtung='team'`; Trigger hat 3× `push-senden` gerufen.
  - Anna liest `fahrer_app_nachrichten()`: eigene Nachricht ohne `tg_message_id` → `zugestellt=false`, mit → true; an-alle-Zeile `an_alle=true`.
  - `gelesen` durch Anna → Trigger ruft `telegram-senden` mit `{gelesen: id}` für Team-Nachrichten mit `tg_message_id`, nicht für die an-alle-Zeile.
  - Cron-Job `themen-pflegen` existiert; `authenticated` darf `tg_fahrer_liste`/`tg_an_alle`/`tg_menue` nicht.
- [ ] Rot sehen (Migration fehlt), Migration schreiben, grün, Commit, Betreiber zeigen + einspielen, Live-Prüfung (Index, Cron, Rechte).

### Task 2: Telegram-Logik Teil 2
**Produces:** `einordnen(update, gruppeId, botId)` liefert zusätzlich
`{art:'knopf', id, daten, von:{id,name}, message_id}` (callback_query aus der Gruppe) und
`{art:'allgemein_antwort', antwort_auf, text, von:{id,name}, message_id}` (Text in „Allgemein“ als Antwort auf eine Nachricht des Bots `botId`).
Außerdem `menueText()`, `menueKnoepfe()` (inline_keyboard: `menue:alle`, `menue:suche`, `menue:info`), `infoText()`,
`aufforderung(art, name, userId)` (HTML mit `tg://user?id=` Erwähnung), `vorschau(text, anzahl)`, `vorschauKnoepfe(promptId)` (`alle:ok:<id>`, `alle:nein:<id>`),
`themaLink(gruppeId, threadId)` (`-1004453022013`, 13 → `https://t.me/c/4453022013/13`), `pushText(name, text, anAlle)`.
- [ ] Tests zuerst: Knopf aus fremdem Chat → ignorieren; Knopf aus Gruppe → `knopf`; Antwort in „Allgemein“ auf Bot-Nachricht → `allgemein_antwort`; Antwort auf Menschen-Nachricht oder ohne Antwort → ignorieren (grund `allgemein`); Themen-Nachricht unverändert `team`; Link-Format; Escape in Vorschau; `pushText('Boyko','x',true)` → `Boyko (an alle): x`.
- [ ] Rot, Code, grün, Commit.

### Task 3: `telegram-senden` – Themen-Lauf und Gelesen
**Produces:** `{themen: true}` → `200 {angelegt, umbenannt, rest}`; `{gelesen: id}` → setzt 👀 auf `tg_message_id` der Team-Nachricht (nur `richtung='team'`, nicht `an_alle`).
- [ ] Tests (Attrappen-Harness erweitern): 10 Fahrer ohne Thema → ein Lauf legt 6 an (Kopf-Post je Thema), Pause zwischen Themen (Zeitgeber in der Attrappe), Rest 4; zweiter Lauf legt 4 an; dritter 0. Telegram antwortet 429 beim 3. Thema → Lauf endet mit `angelegt: 2`, keine Reservierung bleibt hängen. Fahrer mit Thema und anderem Kennzeichen → umbenannt. `{gelesen}` → `setMessageReaction` mit 👀 auf richtige message_id; an-alle-Zeile → kein Aufruf.
- [ ] Rot, Code, grün, Commit, Deploy (CLI), Smoke (403 ohne service_role).

### Task 4: `telegram-webhook` – Menü
**Consumes:** `einordnen` (Task 2), `tg_menue`, `tg_fahrer_suchen`, `tg_an_alle` (Task 1).
Ablauf: Knopf `menue:alle|suche` → `answerCallbackQuery`, Aufforderung (force_reply selective) → `tg_menue` (Art, Klicker). `menue:info` → Info-Text.
Antwort auf Aufforderung (`allgemein_antwort`, `tg_menue` passt, gleicher Nutzer): `alle` → Entwurf speichern, Vorschau mit Knöpfen (`vorschau_message_id`); `suche` → Treffer-Knöpfe (url) oder „Kein Fahrer gefunden“, Zeile löschen.
Knopf `alle:ok:<id>` vom Klicker → `tg_an_alle(entwurf, name, prompt_message_id)` → Vorschau ersetzen durch „✅ An n Fahrer geschickt (von Name)“, Zeile löschen; anderer Nutzer → `answerCallbackQuery` „Nur Name kann das senden“; abgelaufen/unbekannt → „Abgelaufen – bitte neu über das Menü“. `alle:nein:<id>` → „✖ Abgebrochen“.
- [ ] Neuer Test `scripts/test-telegram-webhook.mjs` (Attrappen wie beim Senden-Test, Secret-Header): ganzer Ablauf an alle (2 Fahrer → 2 Zeilen über `tg_an_alle`), Doppelklick ✅ → keine zweiten Zeilen, fremder Bestätiger, fremder Antwortender, Suche mit/ohne Treffer, Abbrechen, Antwort auf andere Bot-Nachricht ignoriert, Team-Nachricht im Thema weiter wie Teil 1 (👍).
- [ ] Rot, Code, grün, Commit, Deploy (`--no-verify-jwt`), Smoke (401).

### Task 5: `push-senden` + Einrichtungsskript
- [ ] `push-senden` liest `an_alle` und nutzt `pushText(name, text, an_alle)` (Test in Task 2 deckt den Text). Deploy.
- [ ] Skript: `allowed_updates: ["message","callback_query"]`; Gruppenprüfung verlangt zusätzlich `can_pin_messages`; neuer Schritt `menue` (sendMessage Menü in „Allgemein“ + `pinChatMessage` ohne Benachrichtigung). Prüfung: ohne Token sauber abbrechen. Commit.
- [ ] Betreiber: Bot-Recht „Nachrichten anheften“ geben; dann `einrichten --gruppe …` (Webhook mit callback_query) und `menue` ausführen (Token wie bisher).

### Task 6: Fahrerapp
- [ ] Browser-Test zuerst: eigene Nachricht `zugestellt:false` → „wird zugestellt“, `true` → „✓“ hinter der Uhrzeit; Team-Nachricht `an_alle:true` → Name „Boyko · an alle“. Rot, Code, grün; Cache v59; Commit.

### Task 7: Live und Doku
- [ ] Themen-Lauf beobachten (nach ~45 Min 54 Themen, `select count(*) from tg_themen where thread_id is not null`).
- [ ] Betreiber testet Menü: an alle (Bestätigen und Abbrechen), Fahrer finden, Info; Gelesen 👀 mit Testgerät.
- [ ] CLAUDE.md „Nachrichten“ ergänzen; Commit; Betreiber pusht.
