# Uber-Sitzung erneuern – Testanleitung (Frist 06.10.2026)

Stand 23.09.2026. Ziel: den Erneuerungsweg einmal echt durchspielen, **solange die
alte Sitzung noch gilt**, und danach ohne Voll-Sync belegen, dass `uber-sync` mit der
neuen Sitzung läuft. Alle Befehle für den Mac, zsh, aus dem Repo-Ordner.

## Was das Skript tut (geprüft, nicht ausgeführt)

`scripts/uber-session-speichern.js <firma> [org_id]`

| Punkt | Befund |
|---|---|
| Browser | Keiner wird gestartet. Das Skript erwartet einen **laufenden** Chromium mit CDP auf `127.0.0.1:9333` (derselbe Port wie `scripts/uber-capture.js`). |
| Profil | `~/.hydrafleet-uber-profile` (aus `uber-capture.js`, gitignoriert), Binary: Playwright „Google Chrome for Testing“ `chromium-1234`. |
| Cookies | `Storage.getCookies` über die Browser-Verbindung, gefiltert auf alle Cookies, deren Domain zu `fleethub.uber.com` passt (also auch `.uber.com`). Als `Cookie`-Header zusammengesetzt. |
| Ablaufdatum | `laeuft_ab` = **früheste** Ablaufzeit aller persistenten Cookies (also evtl. ein kurzlebiges Tracking-Cookie, nicht die Sitzung). |
| Service-Key | aus `.n8n-backup/AbrechnungsBot-v13-20260911.json`: erster `apikey`-Header, dessen JWT-Rolle `service_role` ist. |
| Schreiben | `POST /rest/v1/rpc/verbindung_setzen` mit `p_anbieter='uber'`, `p_firma`, `p_externe_id`, Secret `{cookie, laeuft_ab, gesetzt_am}`. |
| `verbindung_setzen` | Sucht Verbindung per `anbieter + firma`. Gefunden → `vault.update_secret` (**überschreibt sofort**), `status='aktiv'`, `letzter_fehler=null`, `externe_id` bleibt, wenn keine org_id übergeben wird. Nicht gefunden → **legt eine neue Verbindung an**. |
| Fehler | Browser nicht da → `FEHLER: fetch failed`, nichts geschrieben. Keine Cookies → Abbruch, nichts geschrieben. Supabase-Fehler → `FEHLER: Supabase <status>`. Exit-Code 1 in allen Fällen. |

Aktuell in der DB (gelesen 23.09.): genau eine Uber-Verbindung
`02cfb4fd-2557-4d68-9d77-a3f39729fb5b`, `firma = eh_limousinenservice_kg`,
`externe_id = 08fc2f53-6baf-4f9d-9010-b5813895f0b3`, `status = aktiv`,
`letzter_fehler = null`, Secret zuletzt geändert 22.09. 17:33 UTC.
Cron `uber-sync-woechentlich` läuft Montag 05:00 (UTC) mit leerem Body = Voll-Sync der Vorwoche.

## Risiken

1. **Die alte Sitzung wird überschrieben, bevor die neue geprüft ist.** Das Skript
   nimmt jedes Cookie, das zu `fleethub.uber.com` passt – auch wenn das Fenster
   abgemeldet ist oder auf der Login-Seite steht (Uber setzt dort ebenfalls Cookies).
   Dann steht im Vault eine unbrauchbare Sitzung, die alte gültige ist weg, und es gibt
   keine Sicherungskopie. Vorschlag unten (Diff) prüft zuerst gegen Uber.
2. **Falscher Firmenname legt eine zweite Verbindung an.** Tippfehler bei `<firma>` →
   neue aktive Uber-Verbindung ohne `externe_id` → `uber-sync` meldet jeden Montag
   einen Fehler dafür (HTTP 207). Firmenname exakt kopieren: `eh_limousinenservice_kg`.
3. **Nur Sitzungs-Cookies (ohne Ablauf) → Absturz** (`Math.min()` = `Infinity`,
   `toISOString` wirft). Harmlos, weil vor dem Schreiben, aber blockiert.
4. **`uber-capture.js` nicht zum Starten benutzen:** es schreibt alle Uber-Anfragen
   samt `Cookie`-Header nach `~/Downloads/uber-capture.jsonl` – Sitzung im Klartext
   auf der Platte. Chrome stattdessen direkt starten (Schritt 1).
5. Solange Chrome mit Port 9333 offen ist, kann jeder lokale Prozess die Cookies lesen.
   Nach dem Test schließen.
6. Schlägt der Verbindungstest mit `sitzung_abgelaufen` fehl, setzt `uber-sync` die
   Verbindung auf `status='fehler'`; der Montags-Cron überspringt sie dann. Ein
   erneuter erfolgreicher Skriptlauf setzt sie wieder auf `aktiv`.

### Minimaler Fix (nicht angewendet)

```diff
--- a/scripts/uber-session-speichern.js
+++ b/scripts/uber-session-speichern.js
@@
   const cookieHeader = cs.map((c) => `${c.name}=${c.value}`).join('; ');
-  const frueheste = Math.min(...cs.filter((c) => c.expires > 0).map((c) => c.expires));
-  const laeuftAb = new Date(frueheste * 1000).toISOString();
+  const ablauf = cs.filter((c) => c.expires > 0).map((c) => c.expires);
+  const laeuftAb = ablauf.length ? new Date(Math.min(...ablauf) * 1000).toISOString() : null;
+
+  // Neue Sitzung bei Uber pruefen, BEVOR die alte im Vault ueberschrieben wird.
+  const probe = await fetch('https://fleethub.uber.com/api/vs-sp-reports-management/GetUserOrganizations?localeCode=de-DE', {
+    method: 'POST',
+    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x', Cookie: cookieHeader,
+      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' },
+    body: '{}',
+  });
+  let pj = null; try { pj = JSON.parse(await probe.text()); } catch {}
+  if (!probe.ok || pj?.status !== 'success')
+    throw new Error(`Neue Sitzung ungueltig (HTTP ${probe.status}) - Vault NICHT geaendert. Im Fenster anmelden.`);
+  if (ORG && !(pj.data || []).some((o) => o.uuid === ORG))
+    throw new Error('org_id gehoert nicht zu dieser Sitzung - Vault NICHT geaendert');
@@
-  console.log('Cookies gespeichert:', cs.length, '| kuerzeste Gueltigkeit bis', laeuftAb.slice(0, 16));
+  console.log('Cookies gespeichert:', cs.length, '| kuerzeste Gueltigkeit bis', (laeuftAb || 'Sitzungsende').slice(0, 16));
```

Die Prüfung nutzt denselben Endpunkt und dieselben Header wie der Testmodus von
`uber-sync` (`GetUserOrganizations`, `x-csrf-token: x`). Ohne diesen Fix gilt Schritt 3
(Sichtprüfung im Fenster) als einzige Absicherung.

## Schritt für Schritt

### 0. Vorher: Zustand notieren (Supabase SQL-Editor, nur lesen)

```sql
select id, firma, externe_id, status, letzter_abruf, letzter_fehler
  from verbindungen where anbieter = 'uber';

select r.start, r.status, r.anzahl, r.fehler
  from sync_runs r join verbindungen v on v.id = r.verbindung_id
 where v.anbieter = 'uber' order by r.start desc limit 5;
```

Erwartet: eine Zeile, `status = aktiv`, `letzter_fehler` leer.

### 1. Browser mit CDP-Port 9333 starten

```zsh
cd ~/Projects/hydrafleet
"$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.hydrafleet-uber-profile" \
  --no-first-run --no-default-browser-check \
  https://fleethub.uber.com/ >/dev/null 2>&1 &
```

Prüfen, dass der Port antwortet:

```zsh
curl -s http://127.0.0.1:9333/json/version | head -5
```

Wenn „Chrome for Testing“ mit diesem Profil schon läuft (ohne Port), erst schließen –
sonst öffnet sich nur ein Tab im alten Prozess ohne CDP.

### 2. Neu anmelden (echte Erneuerung)

Im Fenster bei Uber **abmelden und neu anmelden** (inkl. SMS/2FA). Nur so entsteht
eine neue Sitzung mit neuem Ablaufdatum; ein bloßes Neuladen liefert meist dieselben
Cookies mit dem alten Ablauf 06.10.

### 3. Sichtprüfung vor dem Speichern (wichtig, solange der Fix fehlt)

Im selben Fenster öffnen:
`https://fleethub.uber.com/orgs/08fc2f53-6baf-4f9d-9010-b5813895f0b3/reports`

Die Berichtsliste muss erscheinen, **keine** Anmeldeseite (`auth.uber.com`). Erst dann weiter.

### 4. Sitzung speichern

```zsh
cd ~/Projects/hydrafleet
node scripts/uber-session-speichern.js eh_limousinenservice_kg 08fc2f53-6baf-4f9d-9010-b5813895f0b3
```

Erwartet:

```
Verbindung: 02cfb4fd-2557-4d68-9d77-a3f39729fb5b
Cookies gespeichert: <n> | kuerzeste Gueltigkeit bis <Datum>
```

**Die Verbindungs-ID muss exakt `02cfb4fd-…` sein.** Eine andere ID heißt: neue zweite
Verbindung angelegt (Firmenname falsch) → siehe „Aufräumen“ unten.

### 5. Verbindungstest ohne Voll-Sync

`uber-sync` mit `{"test": true}` holt nur `GetUserOrganizations` und das
Abrechnungsfenster, schreibt **keine** `uber_*`-Daten, nur eine `sync_runs`-Zeile.

```zsh
cd ~/Projects/hydrafleet
SB_KEY="$(node -e 'const d=require("./.n8n-backup/AbrechnungsBot-v13-20260911.json");for(const n of d.nodes)for(const h of (n.parameters?.headerParameters?.parameters||[]))if(h.name==="apikey"&&JSON.parse(Buffer.from(h.value.split(".")[1],"base64")).role==="service_role"){process.stdout.write(h.value);process.exit(0)}process.exit(1)')"
curl -sS -X POST https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/uber-sync \
  -H "Authorization: Bearer $SB_KEY" -H 'Content-Type: application/json' \
  -d '{"test":true}'
unset SB_KEY
```

Erwartet (HTTP 200):

```json
{ "verbindungen": [ { "firma": "eh_limousinenservice_kg", "status": "ok", "test": true,
  "org": "<Firmenname bei Uber>", "fenster": "… (uber)" } ] }
```

- `org` darf **nicht** `null` sein – sonst gehört die org_id nicht zur Sitzung.
- `(uber)` am Fenster heißt, auch `GetReportingTimeWindows` ging durch; `(berechnet)`
  ist ein Rückfall und ein Hinweis, genauer hinzusehen.
- `status: "fehler"` mit `sitzung_abgelaufen` → zurück zu Schritt 2.

### 6. In der Datenbank belegen

```sql
select r.start, r.status, r.anzahl, r.fehler
  from sync_runs r join verbindungen v on v.id = r.verbindung_id
 where v.anbieter = 'uber' order by r.start desc limit 3;
-- oberste Zeile: status = ok, anzahl = 0, fehler = 'nur Verbindungstest'

select id, status, letzter_abruf, letzter_fehler
  from verbindungen where anbieter = 'uber';
-- genau eine Zeile, status = aktiv, letzter_fehler = null
```

Hinweis: Der Testmodus aktualisiert `letzter_abruf` **nicht** – das Datum bleibt beim
letzten Voll-Sync. Das ist kein Fehler.

### 7. Aufräumen

- Chrome-Fenster schließen (Port 9333 wieder zu).
- `ls ~/Downloads/uber-capture.jsonl` – falls vorhanden (von `uber-capture.js`), löschen.
- Falls in Schritt 4 eine **neue** Verbindungs-ID kam: diese Zeile in `verbindungen`
  deaktivieren (`status` auf etwas anderes als `aktiv`) oder löschen, sonst läuft
  `uber-sync` jeden Montag zusätzlich darauf. Das ist ein Schreibvorgang in Produktion –
  bewusst entscheiden.

### 8. Endgültige Bestätigung

Der nächste Montag-Cron (05:00 UTC) macht den Voll-Sync mit der neuen Sitzung. Danach
Schritt 6 wiederholen: neue `sync_runs`-Zeile mit `status = ok`, `anzahl > 0`,
`fehler` leer, und `verbindungen.letzter_abruf` am Montagmorgen.
