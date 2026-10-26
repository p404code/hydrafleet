# Fahrer-Nachrichten über Telegram – Design

Stand 24.10.2026, freigegeben im Gespräch mit dem Betreiber (Grundlage: seine Notiz
„Telegram ↔ HYDRAlink – Fahrer-Nachrichten“ vom 22.10., danach umgestellt auf **ein Thema je Fahrer**,
weil mit mehreren Fahrern gleichzeitig hin und her geschrieben wird).

## Ziel

Ein **Chat zwischen Fahrer und Büro**. Der Fahrer schreibt in der Fahrerapp unter **Nachrichten**.
Im Büro läuft das Gespräch in der **Telegram-Team-Gruppe**, dort hat **jeder Fahrer sein eigenes Thema**
(Telegram „Topics“). Alles, was das Team in diesem Thema schreibt, geht an den Fahrer – in die App, mit Push.

```
Team-Gruppe
├─ # Allgemein                              ← interne Absprache, geht an niemanden
├─ 🚕 Max Mustermann · #123 · W-1234TX
├─ 🚕 Ali Yilmaz · #87 · W-5521TX
└─ …

Im Thema „Max Mustermann“:
  Bot:    Max: Ich hab Problem mit den Reifen
  Boyko:  Welcher Reifen?                    → an Max
  Bot:    Max: vorne links
  Stefan: Fahr zur Werkstatt Müller          → an Max
```

Festgelegt vom Betreiber:
- Fahrer haben mit Telegram nichts zu tun.
- In der Gruppe sind 3–4 Büroleute; **jeder in der Gruppe darf antworten** (keine Freigabeliste).
- Alle in der Gruppe sehen alles. Es wird nichts gelöscht.
- **Regel fürs Team: Im Fahrer-Thema schreiben = an den Fahrer schreiben.** Interne Absprache in „Allgemein“.

Nicht in diesem Schritt: Fotos (in beide Richtungen), Antworten aus dem Dashboard, Dashboard-Ansicht,
„gelesen“-Anzeige in Telegram, App-Store-Version. Die Tabelle ist so gebaut, dass Dashboard-Antworten später
ohne Umbau dazukommen.

## Ablauf

```
Fahrer tippt Text in der App
  → fahrer_app_nachricht_senden()   → nachrichten (richtung 'fahrer', kopf-Snapshot)
  → Trigger (pg_net)                → Edge Function telegram-senden
  → Thema des Fahrers holen (gibt es keins: anlegen + Kopf-Post)
  → Bot postet „Max: <Text>“ ins Thema, tg_message_id zurück in die Zeile

Teammitglied schreibt im Thema       → Telegram → Edge Function telegram-webhook
  → Thema → Fahrer, nachrichten (richtung 'team', team_name), Reaktion 👍 auf die Telegram-Nachricht
  → Trigger (pg_net)                → Edge Function push-senden → Web-Push an alle Abos des Fahrers
Fahrer tippt auf den Push → App öffnet Nachrichten, lädt neu, Antwort ist da

Nachricht in „Allgemein“ oder außerhalb der Gruppe → verworfen, nie gespeichert
```

Das 👍 zeigt dem Team: die Nachricht ist beim Fahrer angekommen (in der Datenbank, Push ausgelöst).
Fehlt es, ist sie nicht angekommen.

## 1. Datenbank

Migration `migrations/2026-10-22-fahrer-nachrichten.sql`. Wird dem Betreiber vor dem Einspielen gezeigt.

### Tabellen (RLS an, keine direkten Schreibrechte für `anon`/`authenticated`)

**`nachrichten`**

| Spalte | Typ | |
|---|---|---|
| `id` | bigint identity PK | |
| `fahrer_nr` | int not null | Notion-Fahrer-Nr. (`fahrer.notion_fahrer_id`)* |
| `richtung` | text check in (`fahrer`, `team`) | |
| `text` | text not null, Länge 1–2000 (nach `btrim`) | |
| `kopf` | jsonb null | bei Fahrer-Nachrichten: Snapshot `{name, fahrer_nr, kennzeichen, modell}` – die Fahrzeugzuordnung ändert sich |
| `team_name` | text null | Telegram-Vorname des Teammitglieds |
| `tg_message_id` | bigint null | Fahrer: Post des Bots; Team: Telegram-Nachricht des Teammitglieds |
| `tg_versuche` | int not null default 0 | Sendeversuche nach Telegram (nur Fahrer-Nachrichten) |
| `tg_fehler` | text null | letzter Fehler beim Senden |
| `gelesen_am` | timestamptz null | Fahrer hat die Team-Nachricht gesehen |
| `erstellt_am` | timestamptz default now() | |

\* **Schlüssel ist die Notion-Fahrer-Nr., nicht `fahrer.id`** – wie `fahrer_bank` und `fahrer_app_zugang`.
`fahrer.id` ist nicht stabil (69 Fahrer, ids 626–3127: der n8n-Sync legt Zeilen neu an); an `fahrer.id` gehängt
wären Verlauf und Thema nach einem Full-Sync weg. Kein FK auf `fahrer` (Nr. ist dort nicht eindeutig erzwungen).
Die RPCs rechnen `fahrer_app_ziel()` → `fahrer.notion_fahrer_id` um; ohne Nr. kein Chat (Fahrer ohne Nr.
können sich ohnehin nicht anmelden).

Indizes: `(fahrer_nr, erstellt_am desc)`; **unique `(tg_message_id)` where `richtung = 'team'`** – Telegram
wiederholt einen Webhook, wenn er nicht rechtzeitig 200 bekommt; dieselbe Team-Nachricht darf nur einmal
beim Fahrer landen.

**`tg_themen`** – ein Telegram-Thema je Fahrer

| Spalte | Typ | |
|---|---|---|
| `fahrer_nr` | int PK | Notion-Fahrer-Nr. |
| `thread_id` | bigint unique null | `message_thread_id` des Themas; null = wird gerade angelegt |
| `name` | text | aktueller Themen-Name |
| `kennzeichen` | text | Kennzeichen im Namen (zum Erkennen eines Autowechsels) |
| `erstellt_am` | timestamptz default now() | |

**`push_abos`**: `id bigint identity PK`, `fahrer_nr int not null`, `endpoint text unique not null`,
`p256dh text not null`, `auth text not null`, `erstellt_am timestamptz default now()`.

Lesen: `nachrichten` für `is_app_user()` (Dashboard später). `tg_themen` und `push_abos`: nur `service_role`.
Fahrer lesen nur über RPCs.

**Protokoll:** kein Trigger. Die Regel „neue Tabelle mit Büro-Schreibzugriff → Trigger“ greift nicht – das Büro
schreibt hier nicht über HYDRAlink (nur Fahrer-RPCs und `service_role`). Kommen Dashboard-Antworten, wird er nötig.

### RPCs (Muster `fahrer_app_*`, `security definer`, `search_path = public`)

- **`fahrer_app_nachrichten(p_fahrer_id int default null)`** → die letzten 50 Nachrichten von
  `fahrer_app_ziel(p_fahrer_id)`, älteste zuerst: `id, richtung, text, team_name, erstellt_am, gelesen_am`.
  Fahrer: immer die eigene ID (fremde `p_fahrer_id` wird ignoriert), Büro: Vorschau.
- **`fahrer_app_nachricht_senden(p_text text)`** → `id`.
  Nur der Fahrer selbst (`mein_fahrer_id()` nicht null **und** nicht `is_app_user()`) – aus der Vorschau
  wird abgelehnt. Text getrimmt, 1–2000 Zeichen. **Spam-Limit: höchstens 10 Nachrichten in 10 Minuten.**
  `kopf` aus `fahrer_app_profil(null)` (nicht neu joinen – `kennzeichen_key()` steckt dort schon drin).
- **`fahrer_app_nachrichten_gelesen()`** → setzt `gelesen_am = now()` auf alle ungelesenen Team-Nachrichten
  des Fahrers. Nur Fahrer selbst.
- **`fahrer_app_push_abo(p_endpoint, p_p256dh, p_auth)`** → Upsert auf `endpoint` (ein Gerät, das den
  Fahrer wechselt, hängt danach am neuen). Nur Fahrer selbst. Endpoint muss mit `https://` beginnen.
- **`tg_thema_reservieren(p_fahrer_nr)`** (nur `service_role`) → liefert das bestehende Thema oder legt atomar
  eine Reservierung an (`thread_id null`, `insert … on conflict do nothing`). Nur wer reserviert hat, legt das
  Thema in Telegram an – zwei schnelle Nachrichten eines neuen Fahrers erzeugen nicht zwei Themen.
  Hängt eine Reservierung länger als 2 Minuten, darf sie neu übernommen werden.

Ungelesene Team-Nachrichten für den Badge kommen aus `fahrer_app_nachrichten` (`gelesen_am is null`).

### Trigger und Zeitplan (pg_net, Key aus Vault `service_role_key` wie die Syncs)

- `after insert` auf `nachrichten` mit `richtung = 'fahrer'` → `net.http_post` an `telegram-senden`, Body `{id}`.
- `after insert` auf `nachrichten` mit `richtung = 'team'` → `net.http_post` an `push-senden`, Body `{id}`.
- Der Trigger darf das Speichern nie blockieren: Fehler werden geschluckt (`raise warning`), die Nachricht
  steht in jedem Fall in der Datenbank.
- **Nachhol-Lauf** `pg_cron` `nachrichten-nachholen` alle 5 Minuten: Fahrer-Nachrichten ohne `tg_message_id`,
  älter als 2 Minuten, `tg_versuche < 5` → erneut an `telegram-senden`, **der Reihe nach** (älteste zuerst),
  damit die Reihenfolge im Thema stimmt.

## 2. Edge Functions

Reine Logik in `supabase/functions/_shared/telegram-logik.ts`, Tests `node --test scripts/test-telegram-logik.mjs`
(Muster wie `post-logik.ts`): HTML-Escape, Themen-Name (max. 128 Zeichen), Kopf-Post, Fahrer-Zeile,
Update einordnen (Team-Nachricht in Fahrer-Thema / ignorieren, mit Grund).

### `telegram-senden` (verify_jwt an, nur `service_role`, sonst 403)

1. Zeile laden; `richtung = 'fahrer'` und `tg_message_id is null`, sonst nichts tun (doppelter Aufruf ist harmlos).
   `tg_versuche + 1`.
2. **Thema holen** über `tg_thema_reservieren`. Kein Thema → `createForumTopic` in `TELEGRAM_GRUPPE_ID`:
   Name `🚕 Max Mustermann · #123 · W-1234TX` (ohne Auto: ohne Kennzeichen), danach ein **Kopf-Post** im Thema:
   ```
   🚕 <b>Max Mustermann</b> · #123
   W-1234TX · Toyota Corolla
   Alles, was ihr in diesem Thema schreibt, geht an Max in die App.
   ```
   `thread_id` speichern.
3. **Auto gewechselt** (Kennzeichen im Snapshot ≠ `tg_themen.kennzeichen`): Thema umbenennen
   (`editForumTopic`) und eine Zeile `🚗 Fahrzeug jetzt W-5521TX · Škoda Octavia` ins Thema.
4. Nachricht ins Thema (`message_thread_id`), `parse_mode: HTML`, alles escaped: `<b>Max:</b> Ich hab Problem mit den Reifen`.
5. `tg_message_id` speichern; bei Fehler `tg_fehler` setzen (Nachhol-Lauf versucht es erneut).
   Meldet Telegram, dass das Thema nicht mehr existiert (gelöscht), wird `tg_themen` für den Fahrer
   geleert und beim nächsten Versuch ein neues Thema angelegt. Ein **geschlossenes** Thema wird mit
   `reopenForumTopic` wieder geöffnet.

### `telegram-webhook` (verify_jwt **aus**, wie `revolut-webhook`)

Schutz: Header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`, sonst 401.
Telegram bekommt immer 200, auch für Verworfenes (sonst wiederholt es).

Da der Bot Admin ist, bekommt er **alle** Gruppennachrichten. Gespeichert wird nur, was in ein Fahrer-Thema
geschrieben wurde; alles andere wird verworfen, ohne den Text zu speichern oder zu loggen.

Eine Nachricht ist eine **Team-Nachricht an den Fahrer**, wenn alles zutrifft:
- `chat.id = TELEGRAM_GRUPPE_ID`
- `is_topic_message = true` und `message_thread_id` steht in `tg_themen` (nicht „Allgemein“)
- nicht vom Bot (`from.is_bot = false`), keine Service-Nachricht (Thema angelegt/umbenannt usw.)
- hat `text`

Dann:
- Insert in `nachrichten`: `richtung 'team'`, `fahrer_nr` aus `tg_themen`, `text` (gekürzt auf 2000),
  `team_name = from.first_name`, `tg_message_id = message_id`. Doppelt (gleiche `tg_message_id`) → nichts tun.
- `setMessageReaction` 👍 auf die Nachricht.

Sonderfälle in einem Fahrer-Thema:
- **Ohne Text** (Foto, Sprachnachricht, Sticker) → Bot antwortet im Thema „Fotos und Sprachnachrichten kommen
  noch nicht beim Fahrer an – bitte als Text schreiben.“ (höchstens einmal je 10 Minuten und Thema).
- **Bearbeitete Nachrichten** (`edited_message`) werden nicht abonniert – die Änderung kommt nicht beim Fahrer an.
  Gehört in die Team-Regel: lieber neu schreiben.

`allowed_updates: ["message"]`.

### `push-senden` (verify_jwt an, nur `service_role`)

- Team-Nachricht laden → alle `push_abos` des Fahrers → Web-Push (VAPID, aes128gcm).
- Inhalt: Titel `HYDRAlink`, Text = „{team_name}: “ + Anfang der Nachricht (max. 120 Zeichen),
  URL `/fahrer/#nachrichten`. Mehrere Nachrichten kurz hintereinander ersetzen sich (`tag: 'nachrichten'`).
- Abo antwortet 404/410 → Abo löschen. Andere Fehler nur loggen.
- Bibliothek für Web-Push wählt der Plan (muss unter Deno/Supabase laufen).

## 3. Zugangsdaten und Einrichtung

Edge-Function-Secrets (nie im Frontend, nie im Repo, nie im Klartext in Tabellen):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`, `TELEGRAM_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT` (`mailto:` des Betriebs). Der öffentliche VAPID-Key steht zusätzlich im Frontend (ist öffentlich).

**Betreiber (Boyko):**
1. @BotFather → `/newbot` → Token.
2. In der Team-Gruppe **Themen einschalten** (Gruppeninfo → Bearbeiten → Themen). Telegram macht daraus dabei
   eine Supergruppe; die Gruppen-ID beginnt danach mit −100.
3. Bot in die Gruppe holen und **zum Admin machen**, Rechte: **Themen verwalten** (sonst nichts nötig).
4. Einmal etwas in „Allgemein“ schreiben, damit die Gruppen-ID ermittelt werden kann.
5. Dem Team die Regel sagen: im Fahrer-Thema = an den Fahrer; Absprache in „Allgemein“; nichts nachträglich bearbeiten.

**Skript `scripts/telegram-einrichten.mjs`** (Muster `revolut-einrichten.mjs`, Supabase-CLI `~/.hydrafleet-supabase-cli`,
gibt Token/Secrets nie aus):
- `gruppe` – Token von stdin, `getUpdates` → Gruppen-ID anzeigen, prüfen: Supergruppe mit Themen, Bot ist Admin mit
  „Themen verwalten“.
- `secrets` – Token, Gruppen-ID, zufälliges Webhook-Secret, VAPID-Schlüsselpaar erzeugen und als Secrets setzen;
  gibt nur den öffentlichen VAPID-Key aus.
- `webhook` – `setWebhook` auf `…/functions/v1/telegram-webhook` mit `secret_token`, `allowed_updates: ["message"]`.
- `pruefen` – `getWebhookInfo` + `getChatMember` (Rechte), Ergebnis ohne Geheimnisse.

Das Token des USP-Bots (anderer Bot) ist davon unberührt.

## 4. Fahrerapp (`fahrer/index.html`, `sw.js`)

- Reiter **Nachrichten** freischalten (`#nachrichten`), „bald“ entfernen.
- **Chat-Ansicht**: eigene Nachrichten rechts, Team links mit Vornamen darüber, Uhrzeit klein, Tagestrenner
  („Heute“, „Gestern“, Datum). Eingabefeld unten (mehrzeilig, wächst mit) + Senden. Nach dem Senden erscheint
  die Nachricht sofort; scheitert der Aufruf, bleibt der Text im Feld mit Hinweis
  („Zu viele Nachrichten – bitte kurz warten“, „Keine Verbindung“). Beim Öffnen ans Ende scrollen.
- **Neu laden**: alle 15 Sekunden, solange der Reiter offen und die App sichtbar ist; außerdem bei App-Fokus
  (`visibilitychange`) und nach Klick auf den Push. Kein Realtime.
- **Badge** am Reiter mit Zahl der ungelesenen Team-Nachrichten (beim Start und bei App-Fokus geladen);
  beim Öffnen des Reiters `fahrer_app_nachrichten_gelesen()`.
- Leer-Zustand: „Schreib uns – das Büro antwortet hier.“
- Knopf **„Benachrichtigungen aktivieren“** über dem Chat, solange kein Abo besteht: Erlaubnis erst nach dem Tippen,
  dann `pushManager.subscribe` (VAPID-Public-Key) → `fahrer_app_push_abo`.
  iPhone ohne Home-Bildschirm-Installation (kein `standalone`): stattdessen Hinweis
  „Teilen → Zum Home-Bildschirm, dann hier aktivieren“. Abgelehnt: kurzer Hinweis, wo man es in den Einstellungen ändert.
- **Vorschau** (Dashboard-User): lesen ja, Eingabefeld und Push-Knopf ausgeblendet.
- `sw.js` (gemeinsam mit dem Dashboard, Scope `/`): `push` → `showNotification`; `notificationclick` →
  offenes Fahrerapp-Fenster fokussieren und auf `/fahrer/#nachrichten` stellen, sonst öffnen. Cache-Version erhöhen.
- Design: bestehende Tokens und Regeln der Fahrerapp, keine neuen Farben/Schatten.

## 5. Sicherheit

- Kein Bot-Token, kein Service-Key, kein privater VAPID-Key im Frontend.
- DB → Functions nur mit `service_role` (Gateway prüft die Signatur, Function prüft die Rolle).
- Telegram → Function nur mit `secret_token`, nur die eine Gruppen-ID.
- Der Bot sieht als Admin alle Gruppennachrichten: verarbeitet und gespeichert werden nur Nachrichten in
  Fahrer-Themen; „Allgemein“ wird weder gespeichert noch geloggt.
- Alles, was nach Telegram geht, wird HTML-escaped (Name, Kennzeichen, Modell, Text).
- Fahrer liest und schreibt nur eigene Nachrichten, auch mit fremder `p_fahrer_id`.
- Welcher Fahrer eine Team-Nachricht bekommt, entscheidet allein `tg_themen` (Thema → Fahrer), nie Telegram-Text.

## 6. Tests

**Automatisch**
- DB (PGlite, berührt die Live-DB nicht, Muster `scripts/test-bankdaten.mjs`): Fahrer B sieht A nicht (auch mit
  fremder `p_fahrer_id`), Vorschau kann nicht senden, Textlänge, Spam-Limit, `gelesen` nur eigene, Push-Abo-Upsert,
  `tg_thema_reservieren` zweimal → eine Reservierung, doppelte Team-`tg_message_id` → eine Zeile,
  keine direkten Tabellenrechte für `authenticated`.
- `node --test scripts/test-telegram-logik.mjs`: Escape (`<`, `&`, `>` in Name und Text), Themen-Name mit/ohne Auto
  und Kürzung auf 128, Update-Einordnung (fremde Gruppe, „Allgemein“, unbekanntes Thema, Bot selbst,
  Service-Nachricht, Foto ohne Text, gültige Team-Nachricht).

**Von Hand (nach jedem Schritt)**
1. Neuer Fahrer schreibt → Thema mit richtigem Namen und Kopf-Post, Nachricht darin.
2. Derselbe Fahrer schreibt nochmal → gleiches Thema.
3. Teammitglied schreibt im Thema → 👍, Fahrer bekommt Push und sieht den Text mit Vornamen.
4. Nachricht in „Allgemein“ → nichts passiert, nichts gespeichert.
5. 3 Fahrer, je 3× hin und her, zwei Leute antworten → jede Antwort beim richtigen Fahrer, Reihenfolge stimmt.
6. Fahrer B kann Nachrichten von A nicht lesen.
7. App offen lassen → Antwort erscheint binnen 15 Sekunden ohne Push-Klick.
8. Push auf iPhone (Home-Bildschirm) und Android; App vom Push aus öffnen.
9. Abgelaufenes Push-Abo wird gelöscht.
10. Thema in Telegram schließen → nächste Fahrer-Nachricht öffnet es wieder.
11. `telegram-senden` absichtlich scheitern lassen → Nachhol-Lauf schickt nach ≤ 7 Minuten nach.

## Reihenfolge

1. Migration (zeigen, einspielen) + DB-Test
2. Betreiber legt Bot an, schaltet Themen ein, macht den Bot zum Admin → Skript `gruppe` / `secrets` / `webhook`
3. `telegram-senden` + Trigger + Nachhol-Lauf → Test 1, 2, 10, 11
4. `telegram-webhook` → Test 3–5
5. `push-senden` + `sw.js` → Test 8, 9
6. Fahrerapp-Reiter → Test 6, 7 und alles einmal durch
7. CLAUDE.md um einen Abschnitt „Nachrichten“ ergänzen

## Später

- Fotos und Sprachnachrichten (beide Richtungen, z. B. Schaden)
- „Gelesen“ in Telegram anzeigen (z. B. 👀, wenn der Fahrer die Nachricht geöffnet hat)
- Antworten und Themen direkt aus dem Dashboard (schreibt `richtung 'team'` mit Büro-Namen; dann Protokoll-Trigger nötig)
- Büro schreibt einem Fahrer zuerst, der noch kein Thema hat (Thema aus dem Dashboard anlegen)
- App-Store-Version: nur den Push-Kanal auf nativ umstellen

---

# Teil 2: Menü, Themen für alle, Gelesen-Anzeige (26.10.2026)

Vom Betreiber am 26.10. freigegeben, nachdem Teil 1 live war. Reihenfolge danach: Fotos, dann Sprachnachrichten (eigene Entwürfe).

## Themen für alle Fahrer
- Jeder **aktive Fahrer mit App-Zugang** (nicht gesperrt, Notion-Nr. eindeutig – heute 54) bekommt ein Thema, auch ohne eigene
  Nachricht. Fahrer ohne App-Zugang nicht (sie könnten nichts lesen).
- Lauf `themen-pflegen` (pg_cron alle 5 Min → `telegram-senden` `{themen: true}`): legt fehlende Themen an (Kopf-Post wie in Teil 1),
  benennt bei Autowechsel um. Telegram erlaubt ~20 Nachrichten/Min in einer Gruppe → höchstens 6 neue Themen je Lauf mit Pause;
  der erste Durchgang dauert ~45 Min. Der Lauf ruft die Function nur, wenn es etwas zu tun gibt.
- Fahrerliste mit Kopf kommt aus der DB (`tg_fahrer_liste()`, nur service_role, gleicher Fuhrpark-Join wie `fahrer_app_profil`).

## Menü in „Allgemein“
Angeheftete Bot-Nachricht mit drei Knöpfen (eingerichtet per `scripts/telegram-einrichten.mjs menue`):

- **📢 Nachricht an alle Fahrer** → Bot: „Schreib die Nachricht an alle Fahrer:“ (Antwortfeld nur beim Klicker, force_reply +
  selective mit Erwähnung) → Antwort → Vorschau „An 54 Fahrer senden? „…““ mit **[✅ Senden] [✖ Abbrechen]** → nur der Klicker darf
  bestätigen (andere: „Nur <Name> kann das senden“) → je Fahrer eine Zeile `nachrichten` (`richtung 'team'`, `an_alle = true`) →
  Push an jeden → Bot ersetzt die Vorschau durch „✅ An 54 Fahrer geschickt (von <Name>)“. In die Themen wird nichts kopiert.
  Entwürfe verfallen nach 24 h.
- **🔎 Fahrer finden** → Bot: „Name, Fahrer-Nr. oder Kennzeichen?“ → Antwort → bis zu 8 Treffer als Knöpfe mit Link ins Thema
  (`https://t.me/c/<Gruppen-ID ohne -100>/<thread>`); keine Treffer → „Kein Fahrer gefunden“.
- **ℹ️ So funktioniert's** → Bot antwortet mit den Regeln (Thema = an den Fahrer, „Allgemein“ intern, 👍 angekommen, 👀 gelesen,
  Bearbeiten kommt nicht an, Fotos/Sprache noch nicht).

Gespeichert wird aus „Allgemein“ nur: offene Menü-Schritte (`tg_menue`: Bot-Nachricht, Art, Telegram-Nutzer, Entwurf) und die
bestätigte Nachricht an alle. Alles andere in „Allgemein“ bleibt wie bisher unbeachtet. Webhook bekommt zusätzlich `callback_query`
(nur aus der Gruppe). Bot braucht zusätzlich das Admin-Recht **„Nachrichten anheften“**.

## Gelesen-Anzeige
- **Telegram:** Öffnet der Fahrer den Chat (`fahrer_app_nachrichten_gelesen`), ersetzt der Bot die Reaktion 👍 auf jeder dadurch
  gelesenen Team-Nachricht durch 👀 (Trigger auf `gelesen_am` → `telegram-senden` `{gelesen: id}`). Nicht bei Nachrichten an alle.
- **App:** unter eigenen Nachrichten „✓“ sobald sie in der Gruppe steht (`tg_message_id` gesetzt), sonst „wird zugestellt“.
  Nachrichten an alle tragen „an alle“ neben dem Namen. „Büro hat gelesen“ gibt es nicht (Telegram meldet das Bots nicht).

## Datenbank (Migration `2026-10-26-nachrichten-menue.sql`)
- `nachrichten.an_alle boolean not null default false`; Unique-Index Team-Nachrichten neu auf `(tg_message_id, fahrer_nr)`.
- `tg_menue(prompt_message_id bigint PK, art text check in ('alle','suche'), tg_user_id bigint, tg_name text, entwurf text,
  vorschau_message_id bigint, erstellt_am)` – RLS an, nur service_role.
- `tg_fahrer_liste()` → `(fahrer_nr, name, kennzeichen, modell)` der berechtigten Fahrer; `tg_fahrer_suchen(q)` → bis 8 Treffer mit
  `thread_id`; `tg_an_alle(p_text, p_team_name, p_tg_message_id)` legt die Zeilen atomar an und liefert die Anzahl (nur service_role,
  doppelter Aufruf mit gleicher `tg_message_id` legt nichts doppelt an).
- `fahrer_app_nachrichten` liefert zusätzlich `zugestellt` und `an_alle`.
- Trigger `nachrichten_gelesen_melden` (after update of `gelesen_am`), Cron `themen-pflegen`.
