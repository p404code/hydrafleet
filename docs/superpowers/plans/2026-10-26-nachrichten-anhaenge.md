# Fahrer-Nachrichten Teil 3 – Fotos und Sprachnachrichten – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (nativ, wie Teil 1/2). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fahrer und Büro tauschen Fotos und Sprachnachrichten aus; Dateien bleiben in Telegram, HYDRAlink kennt nur die `file_id`.

**Architecture:** Neue Edge Functions `anhang-senden` (Fahrer lädt hoch → Telegram) und `anhang` (App holt Datei aus Telegram, mit
Berechtigungsprüfung per RPC im Namen des Aufrufers). `telegram-webhook` speichert Team-Fotos/-Sprache, `push-senden` kennt Anhänge.
App: 📷/🎤 im Eingabefeld, Anzeige per Blob.

**Spec:** `docs/superpowers/specs/2026-10-22-fahrer-nachrichten-telegram-design.md`, Abschnitt „Teil 3“.

**Hinweis zur Form:** wie Teil 2 – Schnittstellen und Prüffälle hier, Code im TDD-Schritt (Test zuerst, rot, dann Code).

## Global Constraints
- Alles aus Teil 1/2 (Notion-Nr., Token nie in Fehlern/Antworten, nur `TELEGRAM_GRUPPE_ID`, HTML-escape, Deploy per CLI, Live nur mit ausdrücklichem OK).
- Keine Datei in Supabase speichern. Höchstens 5 MB je Upload; Sprache höchstens 180 s; Foto längste Seite 1600 px.
- Fahrer sehen nie Namen aus dem Büro (nur „Büro“).
- `anhang-senden`: nur echte Fahrer (Vorschau/Büro → 403); Spam-Limit 10 Nachrichten/10 Min gemeinsam mit Text.

## Review Focus
1. **Fremde Datei abrufen** (Fahrer B ruft `anhang?id=<Annas Nachricht>`) → 404, keine Datei. Test Task 1 + 4.
2. **Token-Leck** über Download-URL oder Fehlermeldung von `anhang` → Antwort enthält nie `api.telegram.org/file/bot`. Test Task 4.
3. **Riesige oder falsche Datei** (50 MB, PDF als „Foto“) → 413/415 ohne Telegram-Aufruf. Test Task 3.
4. **Telegram lehnt M4A als Voice ab** → Fallback `sendAudio`, Fahrer merkt nichts. Test Task 3.
5. **Gerät kann OGG/Opus nicht abspielen** → Dekodier-Fallback, sonst Hinweis statt stummer Fehler. Browser-Test Task 6.

## Tasks
### Task 1: Datenbank
Produces: Spalten `anhang`, `tg_file_id`, `dauer`; Text-Regel; `fahrer_app_nachrichten` + `anhang`, `dauer`; `fahrer_app_anhang(p_id, p_fahrer_id)`.
- [ ] DB-Test zuerst: Anhang-Zeile mit leerem Text erlaubt, ohne Anhang leer verboten, ungültige Art verboten; Anna sieht `anhang`/`dauer`;
  `fahrer_app_anhang` liefert Anna ihre file_id, Bert nichts, Büro mit Vorschau-Id ja, anon verweigert. Rot → Migration → grün → Commit.

### Task 2: Logik
Produces: `einordnen` → `{art:'team', …, anhang?, file_id?, dauer?}` für Foto (größtes `photo`), `voice`, `audio`; Video/Dokument/Sticker
weiter `ohne_text`. `pushText(text, anAlle, anhang?, dauer?)`, `anhangZeile(kopf, art, caption)` (Bildunterschrift), `dauerText(s)` (0:07),
`anhangPruefen(art, mime, groesse, dauer)` → Fehlertext oder null.
- [ ] Tests zuerst (inkl. Caption-Escape, Grenzen 5 MB/180 s, MIME-Liste), rot → Code → grün → Commit.

### Task 3: `anhang-senden` (neu)
Consumes: `fahrer_app_profil` (mit Fahrer-JWT), `telegram-senden {thema}`, Telegram `sendPhoto`/`sendVoice`/`sendAudio`.
Produces: `POST /functions/v1/anhang-senden` multipart (`art`, `datei`, `dauer?`, `text?`) → `200 {id}`; 403 Vorschau/kein Fahrer, 413 zu groß,
415 falscher Typ, 429 Spam.
- [ ] Attrappen-Test zuerst: Foto ok (multipart an Telegram mit thread, Caption), Zeile mit tg_message_id/file_id; Sprache m4a → sendVoice;
  sendVoice 400 → sendAudio; Büro-JWT 403; 6 MB 413; PDF 415; 11. Nachricht 429. Rot → Code → grün → Commit.

### Task 4: `anhang` (neu)
- [ ] Attrappen-Test zuerst: eigene Nachricht → Bytes + Content-Type; fremde → 404; getFile-Fehler → 404 „nicht mehr verfügbar“;
  Antwort/Fehler ohne Token. Rot → Code → grün → Commit.

### Task 5: Webhook + Push
- [ ] Webhook-Test: Team-Foto → Zeile `anhang foto` mit größter file_id und Caption; Voice → `sprache` mit Dauer; Video → Hinweis.
  Push: Anhang-Text. Rot → Code → grün → Commit.

### Task 6: App
- [ ] Browser-Test zuerst: Foto-/Sprach-Blasen (Attrappe für `anhang`), Bildverkleinerung (≤1600, JPEG), Upload ruft `anhang-senden` mit
  FormData, Fehlermeldung bei 429/413; OGG-Fallback-Weiche (`canPlayType` leer → Dekoder-Pfad). 🎤-Leiste: Start/✖/Senden mit Attrappe
  für `MediaRecorder`. Rot → Code → grün; Cache-Bump; Commit.

### Task 7: Live
- [ ] Betreiber-OK → Migration, Deploy `anhang-senden`, `anhang` (beide verify_jwt), `telegram-webhook`, `push-senden`; Smoke-Tests (403/401);
  Betreiber pusht App; Test iPhone + Android: Foto senden/empfangen, Sprache senden/empfangen/abspielen. CLAUDE.md ergänzen.
