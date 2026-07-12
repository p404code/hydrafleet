# Lohn-Spalte Implementation Plan

> **Umsetzung:** Vanilla-JS Single-File-App (`dashboard.html`), kein Test-Framework. Verifikation je Task = manueller Browser-Check + DB-Check via Supabase. Ausführung inline durch Claude direkt (keine Subagenten). Schritte nutzen Checkbox-Syntax.

**Goal:** Eine „Lohn"-Spalte in der Abrechnungen-Ansicht, die als Durchlaufposten die Bar-Auszahlung mindert — manuell inline eingetragen, editierbar nur für 3 User.

**Architecture:** Neue `lohn`-Spalte auf `settlements` (roh gespeichert). Netto-Auszahlung = `auszahlung − lohn` wird nur zur Anzeige/Summen/Ausdruck berechnet; der rohe `auszahlung`-Wert bleibt für „Müssen zahlen" unangetastet. Schreiben per `PATCH` mit dem öffentlichen anon-Key, client-seitig auf eine Namens-Allowlist beschränkt.

**Tech Stack:** HTML/Vanilla JS, Supabase JS Client (CDN), Cloudflare Pages.

## Global Constraints

- Datei ist **`dashboard.html` im Root** — das ist die deployte Datei (nicht `hydrafleet/`).
- Kein Build-Step, keine Frameworks — reines JS, bestehende Muster beibehalten.
- Deutsche UI-Labels.
- `settlements.auszahlung` (roh) darf **nicht** verändert werden — „Müssen zahlen" und AbrechnungsBot bleiben unberührt.
- Editoren-Allowlist (exakt, aus `app_users.name`): `Boyko`, `Bislan`, `Mohamed` (Vergleich case-insensitive).
- Kein Push/Deploy ohne ausdrückliche Freigabe des Users.

---

### Task 1: DB-Migration — Spalte `lohn`

**Files:**
- Create: `migrations/2026-07-12-add-lohn-to-settlements.sql`

- [ ] **Step 1: Migrations-Datei schreiben**

```sql
-- Lohn als Durchlaufposten pro Abrechnung (fahrer_name + woche).
-- Roh gespeichert; Netto-Auszahlung wird im Frontend berechnet.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS lohn numeric DEFAULT 0;
```

- [ ] **Step 2: Migration auf Supabase ausführen**

Via MCP `postgrestRequest` ist DDL nicht möglich → SQL im Supabase SQL-Editor ausführen, ODER prüfen ob ein DDL-Weg verfügbar ist. Nach Ausführung verifizieren:

Run (MCP postgrestRequest GET): `/settlements?select=id,lohn&limit=1`
Expected: Antwort enthält Feld `lohn` (Wert `0` oder `null`).

- [ ] **Step 3: Commit**

```bash
git add migrations/2026-07-12-add-lohn-to-settlements.sql
git commit -m "feat(db): add lohn column to settlements"
```

---

### Task 2: JS-Helper (Netto + Berechtigung)

**Files:**
- Modify: `dashboard.html` (im `<script>`-Block, nahe den anderen Helpern wie `fmt`/`esc`)

**Interfaces:**
- Produces:
  - `LOHN_EDITORS` = `['boyko','bislan','mohamed']`
  - `lohnOf(s) -> number` — `parseFloat(s.lohn) || 0`
  - `netAuszahlung(s) -> number` — `(s.auszahlung || 0) - lohnOf(s)`
  - `canEditLohn() -> boolean` — true wenn `session.name` (lowercase) in `LOHN_EDITORS`

- [ ] **Step 1: Helper einfügen**

```js
const LOHN_EDITORS = ['boyko', 'bislan', 'mohamed'];
function lohnOf(s) { return parseFloat(s.lohn) || 0; }
function netAuszahlung(s) { return (s.auszahlung || 0) - lohnOf(s); }
function canEditLohn() {
  try {
    const sess = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
    return !!sess && LOHN_EDITORS.includes((sess.name || '').toLowerCase());
  } catch (e) { return false; }
}
```

- [ ] **Step 2: Verifizieren (Browser-Konsole)**

Dashboard laden, in der Konsole `canEditLohn()` und `netAuszahlung({auszahlung:400,lohn:100})` aufrufen.
Expected: `canEditLohn()` = true wenn als Boyko/Bislan/Mohamed eingeloggt, sonst false; `netAuszahlung(...)` = `300`.

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat: add lohn/net helpers and editor allowlist"
```

---

### Task 3: Tabellen-Spalte „Lohn" + Netto-Auszahlung + Inline-Edit

**Files:**
- Modify: `dashboard.html` — Tabellen-Header (Abrechnungen-Tab), `render()` (Zeilen-Template + leerer Zustand `colspan`), Event-Handler-Bereich.

**Interfaces:**
- Consumes: `lohnOf`, `netAuszahlung`, `canEditLohn`, bestehende `fmt`, `esc`, `getSupabase`, globales `SETTLEMENTS`, `render`.
- Produces: `saveLohn(id, value)` — PATCH + lokales Update + Re-Render.

- [ ] **Step 1: Header-Zelle „Lohn" ergänzen**

Im Abrechnungen-Tabellen-Header eine `<th>Lohn</th>` zwischen „Abzug" und der Aktions-Spalte einfügen. Genaue Stelle beim Umsetzen an der bestehenden Header-Zeile ausrichten.

- [ ] **Step 2: `colspan` der Leer-Zustände erhöhen**

In `render()` und `loadData()` die `colspan="10"` der „Keine Einträge"/„Keine Daten"-Zeilen auf `colspan="11"` erhöhen.

- [ ] **Step 3: Auszahlungs-Zelle auf Netto + neue Lohn-Zelle**

Im Zeilen-Template von `render()`:
- Die Auszahlungs-Zelle `fmt(s.auszahlung)` → `fmt(netAuszahlung(s))`, Vorzeichen-Farbe an `netAuszahlung(s)` binden.
- Bei `lohnOf(s) > 0` unter der Auszahlung ein kleiner Hinweis analog zum „Korr:"-Badge: `−<lohn> Lohn`.
- Neue Lohn-Zelle vor der Aktions-Zelle:

```js
// innerhalb der Row-Map, `s` = settlement:
var _lohn = lohnOf(s);
var _lohnCell = canEditLohn()
  ? '<td class="right"><input type="number" step="0.01" class="lohn-input" data-lohn-id="'+s.id+'" value="'+(_lohn||'')+'" placeholder="0" style="width:72px;text-align:right"></td>'
  : '<td class="right">'+(_lohn ? fmt(_lohn) : '–')+'</td>';
```

`_lohnCell` an der richtigen Position in den Zeilen-String einsetzen.

- [ ] **Step 4: `saveLohn` + Event-Delegation**

```js
async function saveLohn(id, rawVal) {
  const val = parseFloat(String(rawVal).replace(',', '.')) || 0;
  const row = SETTLEMENTS.find(function(s){ return s.id === id; });
  if (!row) return;
  const prev = row.lohn;
  row.lohn = val;               // optimistisch
  render();
  try {
    const client = getSupabase();
    const { error } = await client.from('settlements').update({ lohn: val }).eq('id', id);
    if (error) throw error;
  } catch (e) {
    row.lohn = prev;            // rollback
    render();
    alert('Lohn konnte nicht gespeichert werden: ' + (e.message || e));
  }
}
```

Event-Delegation im Init-Bereich (einmalig, `tableBody`):

```js
document.getElementById('tableBody').addEventListener('change', function(e){
  const el = e.target;
  if (el && el.classList.contains('lohn-input')) {
    saveLohn(parseInt(el.getAttribute('data-lohn-id'), 10), el.value);
  }
});
// Enter -> blur (löst change aus)
document.getElementById('tableBody').addEventListener('keydown', function(e){
  if (e.key === 'Enter' && e.target && e.target.classList.contains('lohn-input')) { e.target.blur(); }
});
```

- [ ] **Step 5: Verifizieren (Browser + DB)**

1. Als Boyko: bei einem Fahrer der aktuellen Woche einen Lohn eintragen, Enter → Auszahlung-Zelle sinkt um den Betrag, „−X Lohn"-Hinweis erscheint.
2. DB prüfen (MCP GET `/settlements?id=eq.<id>&select=id,lohn,auszahlung`): `lohn` gesetzt, `auszahlung` unverändert.
3. Lohn so hoch setzen, dass Netto negativ → Zelle rot.
4. Als Musa einloggen → statt Input nur Text/`–`, kein Editieren.

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: lohn column with inline edit and net payout in Abrechnungen table"
```

---

### Task 4: Summen oben auf Netto

**Files:**
- Modify: `dashboard.html` — Summen-Berechnung in `render()` (`auszahlungPositiv`/`auszahlungNegativ`).

**Interfaces:**
- Consumes: `netAuszahlung`.

- [ ] **Step 1: Summen umstellen**

In `render()`:

```js
const auszahlungPositiv = data.reduce(function(a,s){ var n = netAuszahlung(s); return a + (n > 0 ? n : 0); }, 0);
const auszahlungNegativ = data.reduce(function(a,s){ var n = netAuszahlung(s); return a + (n < 0 ? Math.abs(n) : 0); }, 0);
```

(„Bleibt/Abzug"-Summen `totalAbzug`/`totalMieten`/`totalProzent` bleiben unverändert — Lohn ist kein Abzug im rechtlichen Sinn.)

- [ ] **Step 2: Verifizieren**

Woche mit mind. einem Lohn öffnen. „Auszahlung gesamt" = Summe der Netto-Positiven, „zu kassieren" = Summe der Netto-Negativen. Ohne Löhne identisch zu vorher.

- [ ] **Step 3: „Müssen zahlen" gegenprüfen**

„Müssen zahlen"-Tab öffnen: Beträge unverändert (basieren weiter auf rohem `auszahlung`). Ein nur durch Lohn negativer Fahrer taucht dort **nicht** auf.

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat: cash summaries use net payout (after lohn)"
```

---

### Task 5: Ausdruck, WhatsApp & CSV-Export

**Files:**
- Modify: `dashboard.html` — `printDriver`, `printAllDrivers`, WhatsApp-Text-Funktion (falls vorhanden), `exportCSV`.

**Interfaces:**
- Consumes: `lohnOf`, `netAuszahlung`, `fmt`.

- [ ] **Step 1: `printDriver` — Lohn-Zeile + Netto**

Im Abzüge-Block: nach `printAbzug` eine Lohn-Zeile nur bei `lohnOf(driver) > 0` einblenden (analog zur bestehenden `printKorrekturSection`-Logik: eigenes Element ein-/ausblenden). Finale Auszahlung `printPayout` = `fmt(netAuszahlung(driver))`, Box-Klasse pos/neg an `netAuszahlung(driver)`.

- [ ] **Step 2: `printAllDrivers` — Lohn-Zeile + Netto**

Im generierten HTML pro Fahrer: im Abzüge-`<table>` bei `lohnOf(d) > 0` eine Zeile `Lohn (bereits überwiesen) | −<lohn>` ergänzen; `print-payout-value` und Positiv/Negativ-Filter (`d.auszahlung > 0`) auf `netAuszahlung(d)` umstellen.

- [ ] **Step 3: WhatsApp-Text (falls vorhanden)**

Nach einer WhatsApp-/Share-Text-Funktion suchen (`grep -ni "whatsapp\|wa.me\|share" dashboard.html`). Falls vorhanden: Lohn-Zeile bei `lohn>0` und Netto-Auszahlung analog ergänzen. Falls nicht vorhanden: Schritt entfällt (im Commit vermerken).

- [ ] **Step 4: `exportCSV` — Spalten Lohn & Netto**

Header um `'Lohn','Netto'` erweitern und pro Zeile `lohnOf(s)` sowie `netAuszahlung(s)` anhängen (nach den bestehenden Feldern, vor/nach Korrektur konsistent einordnen).

- [ ] **Step 5: Verifizieren**

1. Fahrer mit `lohn>0` drucken (Einzel + „Alle drucken") → Lohn-Zeile sichtbar, finale Auszahlung = Netto.
2. Fahrer mit `lohn=0` → keine Lohn-Zeile.
3. CSV exportieren → Spalten „Lohn" und „Netto" korrekt befüllt.

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: show lohn line + net payout in print, whatsapp and csv export"
```

---

## Self-Review

**Spec-Abdeckung:**
- Datenmodell `lohn`-Spalte → Task 1 ✅
- Netto-Berechnung/Helper → Task 2 ✅
- Inline-UI + Editor-Gate → Task 3 ✅
- Summen auf Netto, „Müssen zahlen" roh → Task 4 ✅
- Ausdruck/WhatsApp/CSV → Task 5 ✅
- Re-Upload-Sicherheit → durch Datenmodell (Spalte nicht im AbrechnungsBot-Payload) gegeben; in Task 3 Step 5.2 wird `auszahlung` als unverändert geprüft. Optionaler Zusatz-Check: nach echtem CSV-Re-Upload bleibt `lohn` erhalten (manuell, wenn eine Test-Woche verfügbar ist).

**Platzhalter:** Keine offenen TODOs im Code; „falls vorhanden" bei WhatsApp ist ein bewusster, verifizierbarer Zweig (Task 5 Step 3).

**Typ-Konsistenz:** `lohnOf`/`netAuszahlung`/`canEditLohn`/`saveLohn` durchgängig gleich benannt und verwendet.
