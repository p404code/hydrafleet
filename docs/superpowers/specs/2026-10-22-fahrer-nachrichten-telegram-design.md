# Fahrer-Nachrichten über Telegram – Design

Stand 22.10.2026, freigegeben im Gespräch mit dem Betreiber (Grundlage: seine Notiz
„Telegram ↔ HYDRAlink – Fahrer-Nachrichten“).

## Ziel

Der Fahrer schreibt in der Fahrerapp unter **Nachrichten**. Die Nachricht erscheint in der
**Telegram-Team-Gruppe** mit Kopf (Name, Fahrer-Nr., Kennzeichen, Modell). Das Team bespricht
sich dort ganz normal. Über den Knopf **↩️ Antworten** geht eine Antwort gezielt an genau diesen
Fahrer – in die Fahrerapp, mit Push.

- Fahrer haben mit Telegram nichts zu tun.
- In der Gruppe sind 3–4 Büroleute; **jeder in der Gruppe darf antworten** (keine Freigabeliste).
- **Alle in der Gruppe sehen alles**: Fahrer-Nachricht, Aufforderung, Antwort. Es wird nichts gelöscht.
- Der Bot ist **kein Admin** der Gruppe → Privacy Mode wirkt, der Bot bekommt nur Antworten auf
  seine eigenen Nachrichten und Knopf-Klicks, nicht die Diskussion.

Nicht in diesem Schritt: Fotos, Antworten aus dem Dashboard, Dashboard-Ansicht, App-Store-Version.
Die Tabelle ist so gebaut, dass Dashboard-Antworten später ohne Umbau dazukommen.

## Ablauf

```
Fahrer tippt Text in der App
  → fahrer_app_nachricht_senden()  → nachrichten (richtung 'fahrer', kopf-Snapshot)
  → Trigger (pg_net)               → Edge Function telegram-senden
  → Bot postet in die Gruppe mit [↩️ Antworten], tg_message_id zurück in die Zeile

Team diskutiert in der Gruppe      → Bot sieht es nicht (Privacy Mode)

Jemand tippt ↩️ Antworten          → Telegram → Edge Function telegram-webhook
  → Bot schreibt in die Gruppe: „↩️ Antwort an Max (#123) – @Boyko, schreib deine Antwort:“
    (force_reply + selective, Erwähnung als tg://user?id=…), Zeile in tg_antwort_prompts
Boyko antwortet auf genau diese Bot-Nachricht
  → telegram-webhook: nachrichten (richtung 'team', antwort_auf, team_name)
  → Original-Post wird per editMessageText um „✅ Boyko: fahr zur Werkstatt“ ergänzt, Knopf bleibt
  → Trigger (pg_net) → Edge Function push-senden → Web-Push an alle Abos des Fahrers
Fahrer tippt auf den Push → App öffnet Nachrichten, lädt neu, Antwort ist da
```

Begriff **Aufforderung** (im Code `prompt`): die Bot-Nachricht nach dem Klick auf ↩️. Nur was als
Antwort auf diese Aufforderung geschrieben wird, geht an den Fahrer.

## 1. Datenbank

Migration `migrations/2026-10-22-fahrer-nachrichten.sql`. Wird dem Betreiber vor dem Einspielen gezeigt.

### Tabellen (RLS an, keine direkten Schreibrechte für `anon`/`authenticated`)

**`nachrichten`**

| Spalte | Typ | |
|---|---|---|
| `id` | bigint identity PK | |
| `fahrer_id` | int not null → `fahrer(id)` `on delete set null`* | |
| `richtung` | text check in (`fahrer`, `team`) | |
| `text` | text not null, Länge 1–2000 (nach `btrim`) | |
| `kopf` | jsonb | Snapshot `{name, fahrer_nr, kennzeichen, modell}` beim Senden – die Fahrzeugzuordnung ändert sich |
| `antwort_auf` | bigint null → `nachrichten(id)` | bei Team-Antworten: die Fahrer-Nachricht, deren Knopf geklickt wurde |
| `team_name` | text null | Telegram-Vorname des Antwortenden |
| `tg_message_id` | bigint null | Gruppen-Post des Bots zu einer Fahrer-Nachricht |
| `tg_versuche` | int not null default 0 | Sendeversuche nach Telegram |
| `tg_fehler` | text null | letzter Fehler beim Senden |
| `gelesen_am` | timestamptz null | Fahrer hat die Team-Antwort gesehen |
| `erstellt_am` | timestamptz default now() | |

\* CLAUDE.md: FKs auf `fahrer(id)` brauchen `ON DELETE SET NULL`, sonst scheitert der n8n-Sync beim
Löschen eines Fahrers. Deshalb ist `fahrer_id` **nullable** mit `on delete set null` (statt not null);
die RPCs schreiben immer einen Wert.

Index auf `(fahrer_id, erstellt_am desc)`.

**`tg_antwort_prompts`**: `prompt_message_id bigint PK`, `nachricht_id → nachrichten(id) on delete cascade`,
`tg_user_id bigint not null`, `erstellt_am timestamptz default now()`.
Aufforderungen älter als 7 Tage räumt der Nachhol-Lauf weg.

**`push_abos`**: `id bigint identity PK`, `fahrer_id → fahrer(id) on delete cascade`, `endpoint text unique not null`,
`p256dh text not null`, `auth text not null`, `erstellt_am timestamptz default now()`.

Lesen: `nachrichten` für `is_app_user()` (Dashboard später). `tg_antwort_prompts` und `push_abos`: kein Lesen
außer `service_role`. Fahrer lesen nur über RPCs.

**Protokoll:** kein Trigger. Die Regel „neue Tabelle mit Büro-Schreibzugriff → Trigger“ greift nicht – das Büro
schreibt hier nicht (nur Fahrer-RPCs und `service_role`).

### RPCs (Muster `fahrer_app_*`, `security definer`, `search_path = public`)

- **`fahrer_app_nachrichten(p_fahrer_id int default null)`** → die letzten 50 Nachrichten von
  `fahrer_app_ziel(p_fahrer_id)`, älteste zuerst: `id, richtung, text, team_name, erstellt_am, gelesen_am`.
  Fahrer: immer die eigene ID (fremde `p_fahrer_id` wird ignoriert), Büro: Vorschau.
- **`fahrer_app_nachricht_senden(p_text text)`** → `id`.
  Nur der Fahrer selbst (`mein_fahrer_id()` nicht null **und** nicht `is_app_user()`) – aus der Vorschau
  wird abgelehnt. Text getrimmt, 1–2000 Zeichen. **Spam-Limit: höchstens 10 Nachrichten in 10 Minuten.**
  `kopf` aus `fahrer_app_profil(null)` (nicht neu joinen – `kennzeichen_key()` steckt dort schon drin).
- **`fahrer_app_nachrichten_gelesen()`** → setzt `gelesen_am = now()` auf alle ungelesenen Team-Antworten
  des Fahrers. Nur Fahrer selbst.
- **`fahrer_app_push_abo(p_endpoint, p_p256dh, p_auth)`** → Upsert auf `endpoint` (ein Gerät, das den
  Fahrer wechselt, hängt danach am neuen). Nur Fahrer selbst. Endpoint muss mit `https://` beginnen.

Ungelesene Antworten für den Badge kommen aus `fahrer_app_nachrichten` (Team-Zeilen mit `gelesen_am is null`).

### Trigger und Zeitplan (pg_net, Key aus Vault `service_role_key` wie die Syncs)

- `after insert` auf `nachrichten` mit `richtung = 'fahrer'` → `net.http_post` an `telegram-senden`, Body `{id}`.
- `after insert` auf `nachrichten` mit `richtung = 'team'` → `net.http_post` an `push-senden`, Body `{id}`.
- Der Trigger darf das Speichern nie blockieren: Fehler werden geschluckt (`raise warning`), die Nachricht
  steht in jedem Fall in der Datenbank.
- **Nachhol-Lauf** `pg_cron` `nachrichten-nachholen` alle 5 Minuten: Fahrer-Nachrichten ohne `tg_message_id`,
  älter als 2 Minuten, `tg_versuche < 5` → erneut an `telegram-senden`. Räumt außerdem alte Aufforderungen weg.

## 2. Edge Functions

Reine Logik in `supabase/functions/_shared/telegram-logik.ts`, Tests `node --test scripts/test-telegram-logik.mjs`
(Muster wie `post-logik.ts`):
HTML-Escape, Kopf-Format, Text der Aufforderung, Ergänzung „✅ Name: Text“ mit 4096-Grenze, `antw:<id>` lesen,
Update einordnen (Klick / Antwort auf Aufforderung / ignorieren).

### `telegram-senden` (verify_jwt an, nur `service_role`, sonst 403)

1. Zeile laden; `richtung = 'fahrer'` und `tg_message_id is null`, sonst nichts tun (doppelter Aufruf ist harmlos).
2. `tg_versuche + 1`.
3. `sendMessage` an `TELEGRAM_GRUPPE_ID`, `parse_mode: HTML`, alles escaped:
   ```
   🚕 <b>Max Mustermann</b> · #123
   W-1234TX · Toyota Corolla

   Ich hab Problem mit den Reifen
   ```
   Inline-Knopf `↩️ Antworten`, `callback_data: antw:<id>`.
   Fehlt das Auto im Kopf, entfällt die zweite Zeile.
4. Hat derselbe Fahrer in den letzten 24 h schon einen Post in der Gruppe: `reply_parameters` auf dessen letzten
   Post (`allow_sending_without_reply: true`), damit der Verlauf sichtbar ist.
5. `tg_message_id` speichern; bei Fehler `tg_fehler` setzen (Nachhol-Lauf versucht es erneut).

### `telegram-webhook` (verify_jwt **aus**, wie `revolut-webhook`)

Schutz: Header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`, sonst 401.
Nur Updates aus `TELEGRAM_GRUPPE_ID`; alles andere → 200 und verwerfen (Telegram soll nicht wiederholen).
Gespeichert wird nur, was eine Antwort an einen Fahrer ist – die Diskussion nie.

**a) Klick `antw:<id>`** (`callback_query`)
- `answerCallbackQuery`.
- Nachricht laden (muss `richtung = 'fahrer'` sein), sonst Hinweis „Nachricht nicht gefunden“.
- `sendMessage` in die Gruppe, als Antwort auf den Original-Post:
  `↩️ Antwort an {Name} (#{nr}) – <a href="tg://user?id={from.id}">{Vorname}</a>, schreib deine Antwort:`
  mit `reply_markup: {force_reply: true, selective: true}` (selective wirkt nur mit Erwähnung).
- Zeile in `tg_antwort_prompts` (`prompt_message_id`, `nachricht_id`, `tg_user_id = from.id`).

**b) Antwort auf eine Aufforderung** (`message` mit `reply_to_message.message_id` in `tg_antwort_prompts`)
- Nur wenn `from.id = tg_user_id` der Aufforderung. Antwortet jemand anderes darauf, wird es ignoriert
  (in der Gruppe bleibt es als normale Nachricht stehen).
- Nur Text; ohne Text (Foto, Sticker) → kurzer Hinweis „Bitte als Text antworten“.
- Insert in `nachrichten`: `richtung 'team'`, `fahrer_id` der Original-Nachricht, `text` (gekürzt auf 2000),
  `antwort_auf`, `team_name = from.first_name`.
- Original-Post per `editMessageText` um `✅ {team_name}: {text}` ergänzen, **`reply_markup` wieder mitgeben**
  (sonst verschwindet der Knopf – er bleibt für weitere Antworten). Würde der Post 4096 Zeichen überschreiten,
  wird die Ergänzung gekürzt („…“); die vollständige Antwort steht ohnehin in der Gruppe und in der App.
- Aufforderungs-Zeile löschen (eine Aufforderung = eine Antwort). **In Telegram wird nichts gelöscht.**

**c) Alles andere** → ignorieren. Auch normale Antworten auf den Fahrer-Post selbst (das ist Diskussion).

### `push-senden` (verify_jwt an, nur `service_role`)

- Team-Antwort laden → alle `push_abos` des Fahrers → Web-Push (VAPID, aes128gcm).
- Inhalt: Titel `HYDRAlink`, Text = „{team_name}: “ + Anfang der Antwort (max. 120 Zeichen),
  URL `/fahrer/#nachrichten`.
- Abo antwortet 404/410 → Abo löschen. Andere Fehler nur loggen.
- Bibliothek für Web-Push wählt der Plan (muss unter Deno/Supabase laufen).

## 3. Zugangsdaten und Einrichtung

Edge-Function-Secrets (nie im Frontend, nie im Repo, nie im Klartext in Tabellen):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GRUPPE_ID`, `TELEGRAM_WEBHOOK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT` (`mailto:` des Betriebs). Der öffentliche VAPID-Key steht zusätzlich im Frontend (ist öffentlich).

**Betreiber (Boyko):**
1. @BotFather → `/newbot` → Token. Privacy Mode an lassen (Standard).
2. Bot in die Team-Gruppe holen – **nicht** zum Admin machen.
3. Einmal etwas in der Gruppe an den Bot schreiben (z. B. `/start@<botname>`), damit die Gruppen-ID ermittelt werden kann.

**Skript `scripts/telegram-einrichten.mjs`** (Muster `revolut-einrichten.mjs`, Supabase-CLI `~/.hydrafleet-supabase-cli`,
gibt Token/Secrets nie aus):
- `gruppe` – Token von stdin, `getUpdates` → Gruppen-ID (−100…) anzeigen.
- `secrets` – Token, Gruppen-ID, zufälliges Webhook-Secret, VAPID-Schlüsselpaar erzeugen und als Secrets setzen;
  gibt nur den öffentlichen VAPID-Key aus.
- `webhook` – `setWebhook` auf `…/functions/v1/telegram-webhook` mit `secret_token`,
  `allowed_updates: ["message", "callback_query"]`.
- `pruefen` – `getWebhookInfo` + `getMe` (Privacy Mode aktiv?), Ergebnis ohne Geheimnisse.

Das Token des USP-Bots (anderer Bot) ist davon unberührt.

## 4. Fahrerapp (`fahrer/index.html`, `sw.js`)

- Reiter **Nachrichten** freischalten (`#nachrichten`), „bald“ entfernen.
- Chat-Ansicht: eigene Nachrichten rechts, Team links mit Namen darüber, Datum/Uhrzeit klein.
  Eingabefeld unten + Senden (`fahrer_app_nachricht_senden`). Fehlermeldungen in Klartext
  („Zu viele Nachrichten – bitte kurz warten“).
- **Badge** am Reiter mit Zahl der ungelesenen Team-Antworten; beim Öffnen des Reiters
  `fahrer_app_nachrichten_gelesen()`.
- Neu laden bei App-Fokus (`visibilitychange`) und nach Klick auf den Push. Kein Realtime.
- Knopf **„Benachrichtigungen aktivieren“** im Reiter, solange kein Abo besteht: Erlaubnis erst nach dem Tippen,
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
- Alles, was nach Telegram geht, wird HTML-escaped (Name, Kennzeichen, Modell, Text).
- Fahrer liest und schreibt nur eigene Nachrichten, auch mit fremder `p_fahrer_id`.
- Antwort an einen Fahrer nur von der Person, die die Aufforderung ausgelöst hat; `fahrer_id` kommt immer
  aus der Original-Nachricht in der DB, nie aus Telegram-Text.

## 6. Tests

**Automatisch**
- DB (PGlite, berührt die Live-DB nicht, Muster `scripts/test-bankdaten.mjs`): Fahrer B sieht A nicht (auch mit
  fremder `p_fahrer_id`), Vorschau kann nicht senden, Textlänge, Spam-Limit, `gelesen` nur eigene, Push-Abo-Upsert,
  keine direkten Tabellenrechte für `authenticated`.
- `node --test scripts/test-telegram-logik.mjs`: Escape (`<`, `&`, `>` in Name und Text), Kopf mit/ohne Auto,
  `antw:<id>` (gültig, Unsinn), Update-Einordnung (fremde Gruppe, Klick, Antwort des Klickers, Antwort eines anderen,
  Antwort auf den Fahrer-Post, Diskussion), 4096-Grenze.

**Von Hand (nach jedem Schritt)**
1. Fahrer schreibt → Post in der Gruppe mit richtigem Kopf und Knopf.
2. Diskussion in der Gruppe → nichts passiert, nichts gespeichert.
3. ↩️ → Aufforderung mit Erwähnung des Klickers → Antwort → Fahrer bekommt Push und sieht den Text, Post zeigt ✅,
   Knopf ist noch da.
4. Jemand anderes antwortet auf die Aufforderung → geht nicht an den Fahrer.
5. Zwei Fahrer gleichzeitig, zwei Leute antworten → keine Antwort beim falschen Fahrer.
6. Fahrer B kann Nachrichten von A nicht lesen.
7. Push auf iPhone (Home-Bildschirm) und Android; App vom Push aus öffnen.
8. Abgelaufenes Push-Abo wird gelöscht.
9. `telegram-senden` absichtlich scheitern lassen → Nachhol-Lauf schickt nach ≤ 7 Minuten nach.

## Reihenfolge

1. Migration (zeigen, einspielen) + DB-Test
2. Betreiber legt Bot an, holt ihn in die Gruppe → Skript `gruppe` / `secrets` / `webhook`
3. `telegram-senden` + Trigger + Nachhol-Lauf → Test 1, 9
4. `telegram-webhook` → Test 2–5
5. `push-senden` + `sw.js` → Test 7, 8
6. Fahrerapp-Reiter → Test 6 und alles einmal durch
7. CLAUDE.md um einen Abschnitt „Nachrichten“ ergänzen

## Später

- Fotos (z. B. Schaden)
- Antworten direkt aus dem Dashboard (schreibt `richtung 'team'` mit Büro-Namen; dann Protokoll-Trigger nötig)
- App-Store-Version: nur den Push-Kanal auf nativ umstellen
