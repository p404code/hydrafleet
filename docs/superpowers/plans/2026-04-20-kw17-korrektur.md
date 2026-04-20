# KW17-Korrektur Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einmalige Korrektur des KW16-Abrechnungsfehlers über ein neues `korrektur`-Feld in `settlements`, eingetragen via wegwerfbarem Einmal-Tool, angezeigt als zusätzliche Zeile auf dem Fahrerbeleg.

**Architecture:** Additive DB-Änderung (2 nullable Spalten in `settlements`). n8n bleibt unverändert — Korrektur wird nach regulärer KW17-Berechnung per UPDATE nachgeschrieben. Einmal-Tool `korrektur-kw16.html` ist standalone (nicht im Dashboard verlinkt), parst die korrekte KW16-CSV, berechnet Delta pro Fahrer, schreibt nach Review in KW17-Zeilen. Dashboard zeigt Korrektur konditional (nur wenn != 0) in Print-Modal, CSV-Export und PDF.

**Tech Stack:** Supabase (PostgreSQL), Vanilla JS (kein Build-Tool), Supabase JS SDK via CDN, HTML5 File API, n8n (unverändert).

**Testing-Hinweis:** Das Projekt hat kein Test-Framework. Statt automatisierter Tests verwenden wir pro Task **manuelle Verifikation** mit expliziten erwarteten Ergebnissen (Browser-Konsole, Supabase-SQL-Editor, visuelle Dashboard-Prüfung). Jede Verifikation ist so formuliert, dass der Entwickler sie in 1-2 Minuten durchführen kann.

**Risiko-Constraint:** Produktionskritisches System. Alle Änderungen müssen additiv und rollback-fähig sein. Bestehender Normalbetrieb muss bit-identisch bleiben, wenn `korrektur == 0`.

---

## File Structure

| File | Aktion | Verantwortung |
|---|---|---|
| `setup.sql` | Modify | Append ALTER TABLE für neue Korrektur-Spalten |
| `migrations/2026-04-20-add-korrektur-columns.sql` | Create | Standalone Migration, einmalig in Supabase ausführen |
| `dashboard.html` | Modify | Print-Modal HTML + printDriver/printAllDrivers/exportCSV konditional |
| `korrektur-kw16.html` | Create | Einmal-Tool, standalone, isoliert |
| `docs/superpowers/plans/2026-04-20-kw17-korrektur.md` | (dieses File) | — |

**Abhängigkeiten:** Task 1 (DB) muss vor Task 6-10 (Tool) laufen. Dashboard-Änderungen (Task 2-5) sind unabhängig und können parallel laufen.

---

## Task 1: DB-Migration — `korrektur` und `korrektur_note` Spalten

**Files:**
- Create: `migrations/2026-04-20-add-korrektur-columns.sql`
- Modify: `setup.sql` (append documentation block)

- [ ] **Step 1: Migration-Datei schreiben**

Erstelle `migrations/2026-04-20-add-korrektur-columns.sql`:

```sql
-- ============================================
-- KW17-Korrektur: Add korrektur + korrektur_note to settlements
-- Date: 2026-04-20
-- Reason: KW16/2026 falsche CSV hochgeladen, Korrektur in KW17
-- Rollback: ALTER TABLE settlements DROP COLUMN korrektur, DROP COLUMN korrektur_note;
-- ============================================

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS korrektur NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS korrektur_note TEXT;

-- Sanity-Check
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'settlements'
  AND column_name IN ('korrektur', 'korrektur_note');
```

- [ ] **Step 2: `setup.sql` aktualisieren (nur Dokumentation)**

Am Ende von `setup.sql` folgenden Block anhängen:

```sql
-- ============================================
-- SETTLEMENTS: Korrektur-Feld (eingeführt 2026-04-20, KW16-Fehler)
-- Migration separat: migrations/2026-04-20-add-korrektur-columns.sql
-- ============================================
-- ALTER TABLE settlements
--   ADD COLUMN IF NOT EXISTS korrektur NUMERIC(10,2) DEFAULT 0,
--   ADD COLUMN IF NOT EXISTS korrektur_note TEXT;
```

- [ ] **Step 3: Migration in Supabase ausführen**

Anleitung für den User (NICHT automatisch ausführen — kritische DB):
1. Supabase Dashboard → SQL Editor öffnen
2. Inhalt von `migrations/2026-04-20-add-korrektur-columns.sql` einfügen
3. "Run" drücken
4. Erwartete Ausgabe: 2 Zeilen mit `korrektur` (numeric, default 0, nullable: YES) und `korrektur_note` (text, null default, nullable: YES)

- [ ] **Step 4: Verifikation — bestehende Settlements nicht kaputt**

Im Supabase SQL Editor:

```sql
SELECT woche, fahrer_name, auszahlung, korrektur, korrektur_note
FROM settlements
WHERE woche = '2026-W16'
LIMIT 5;
```

Erwartet: `korrektur = 0` für alle Zeilen, `korrektur_note = NULL`. `auszahlung` unverändert.

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-04-20-add-korrektur-columns.sql setup.sql
git commit -m "db: add korrektur + korrektur_note columns to settlements"
```

---

## Task 2: Print-Modal HTML — konditionale Korrektur-Sektion

**Files:**
- Modify: `dashboard.html` (print-modal HTML, Zeilen 785-792)

- [ ] **Step 1: Korrektur-Sektion ins Print-Modal einfügen**

In `dashboard.html` nach Zeile 792 (nach `</div>` der Abzüge-Sektion, aber innerhalb `<div class="print-body">`), vor der schließenden `</div>` der print-body, folgende Sektion hinzufügen:

Genauer: Die Zeilen 785-792 sehen so aus:
```html
                <div class="print-section">
                    <h3>Abzüge</h3>
                    <table class="print-table">
                        <tr><td>Miete</td><td id="printMiete"></td></tr>
                        <tr><td>Prozent-Abzug</td><td id="printProzent"></td></tr>
                        <tr class="total"><td>Abzug Gesamt</td><td id="printAbzug"></td></tr>
                    </table>
                </div>
```

Direkt danach (vor `</div>` der print-body in Zeile 793) einfügen:

```html
                <div class="print-section" id="printKorrekturSection" style="display:none;">
                    <h3>Korrektur</h3>
                    <table class="print-table">
                        <tr><td id="printKorrekturLabel">Korrektur</td><td id="printKorrektur"></td></tr>
                    </table>
                </div>
```

- [ ] **Step 2: Verifikation — Markup existiert aber ist unsichtbar**

1. Browser öffnen, Dashboard laden (lokal oder live)
2. DevTools Console: `document.getElementById('printKorrekturSection').style.display`
3. Erwartet: `"none"`
4. Auf einen Fahrer klicken → Print-Modal öffnet → Korrektur-Sektion NICHT sichtbar
5. Normale Ansicht der restlichen Sektionen bit-identisch zu vorher

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "ui: add hidden korrektur section to print modal"
```

---

## Task 3: `printDriver()` füllt Korrektur konditional

**Files:**
- Modify: `dashboard.html` Zeile 878 (`function printDriver(name)`)

- [ ] **Step 1: Logik für Korrektur-Anzeige in `printDriver` einbauen**

Finde in `dashboard.html` Zeile 878. Die Funktion endet mit:
```
document.getElementById('printOverlay').classList.add('show');
```

**Direkt vor** `document.getElementById('printOverlay').classList.add('show');` folgende Zeilen einfügen:

```javascript
const korrekturEl = document.getElementById('printKorrekturSection');
const korrVal = parseFloat(driver.korrektur) || 0;
if (korrVal !== 0) {
    const note = driver.korrektur_note || 'Korrektur';
    document.getElementById('printKorrekturLabel').textContent = note;
    document.getElementById('printKorrektur').textContent = (korrVal > 0 ? '+' : '') + fmt(korrVal);
    korrekturEl.style.display = '';
} else {
    korrekturEl.style.display = 'none';
}
```

Konkrete Vorgehensweise: Zeile 878 enthält die komplette Funktion in einer Zeile (minified-style). Die Einfügung passiert vor dem letzten `document.getElementById('printOverlay').classList.add('show');` innerhalb der Funktion. Verwende den Edit-Tool mit folgendem old_string/new_string (den letzten `document.getElementById('printPayoutBox')...` + `document.getElementById('printOverlay').classList.add('show');` als Anker):

- [ ] **Step 2: Verifikation — Korrektur wird nur bei != 0 angezeigt**

1. Supabase SQL Editor:
   ```sql
   -- Test-Fahrer mit Korrektur versehen (KW16 oder eine beliebige existierende Woche)
   UPDATE settlements
   SET korrektur = 25.00, korrektur_note = 'Test-Korrektur'
   WHERE woche = '2026-W16' AND fahrer_name = '<irgendein-existierender-name>';
   ```
2. Dashboard neu laden, KW16 wählen, Fahrer anklicken
3. Erwartet: Print-Modal zeigt Sektion "Test-Korrektur" mit Wert "+25,00 €"
4. Bei einem Fahrer ohne Korrektur: Sektion unsichtbar (Display-Check: `document.getElementById('printKorrekturSection').style.display === 'none'`)
5. Test-Zeile zurücksetzen:
   ```sql
   UPDATE settlements SET korrektur = 0, korrektur_note = NULL
   WHERE woche = '2026-W16' AND fahrer_name = '<irgendein-existierender-name>';
   ```

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "ui: show korrektur in print modal when non-zero"
```

---

## Task 4: `printAllDrivers()` — Korrektur im Batch-Druck

**Files:**
- Modify: `dashboard.html` Zeile 880 (`function printAllDrivers()`)

- [ ] **Step 1: Korrektur-Sektion in Template-String einbauen**

In der Template-String-Konstruktion innerhalb von `printAllDrivers` gibt es eine `.map(function(d, i) {...})` — am Ende der HTML-Generierung (nach der "Abzüge"-Sektion) eine konditionale Korrektur-Sektion anhängen.

Finde in Zeile 880 den Teilstring:
```
<tr class="total"><td>Abzug Gesamt</td><td>' + fmt(d.abzug_gesamt) + '</td></tr></table></div>
```

Ersetze mit:
```
<tr class="total"><td>Abzug Gesamt</td><td>' + fmt(d.abzug_gesamt) + '</td></tr></table></div>' + ((parseFloat(d.korrektur) || 0) !== 0 ? '<div class="print-section"><h3>Korrektur</h3><table class="print-table"><tr><td>' + esc(d.korrektur_note || 'Korrektur') + '</td><td>' + ((parseFloat(d.korrektur) || 0) > 0 ? '+' : '') + fmt(d.korrektur) + '</td></tr></table></div>' : '') + '
```

Beachte: Der abschließende `'` + neue Zeile schließt den Template-Teil ab und der Rest der ursprünglichen Zeichenkette folgt normal weiter.

- [ ] **Step 2: Verifikation — Batch-Druck zeigt Korrektur bei betroffenen Fahrern**

1. SQL: Setze für 2 Test-Fahrer in aktueller Woche `korrektur = 15.50` bzw. `korrektur = -7.25`, für andere lass `korrektur = 0`
2. Dashboard → "Alle drucken" / printAllBtn
3. Druckvorschau: Die 2 Test-Fahrer haben zusätzliche "Korrektur"-Sektion mit "+15,50 €" bzw. "-7,25 €"
4. Andere Fahrer: keine Korrektur-Sektion (Druck-Layout identisch zu vorher)
5. Test-Daten zurücksetzen

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "ui: include korrektur in print-all output when non-zero"
```

---

## Task 5: `exportCSV()` — Korrektur-Spalten

**Files:**
- Modify: `dashboard.html` Zeile 877 (`function exportCSV()`)

- [ ] **Step 1: CSV-Header und -Zeilen um Korrektur-Spalten erweitern**

In Zeile 877 sieht die Funktion so aus:
```javascript
function exportCSV() {
    const data = getData();
    const csv = [['Fahrer','Telefon','Auszahlung','Status','Modell','Miete','Bolt','Uber','MyPOS','Gesamt','Abzug','Prozent']]
        .concat(data.map(function(s) {
            return [s.fahrer_name,s.telefon||'',s.auszahlung,s.status,s.mietmodell,s.miete,s.bolt_brutto,s.uber_fahrpreis,s.mypos_summe,s.bruttoumsatz_gesamt,s.abzug_gesamt,s.prozent_abzug];
        }))
        .map(function(r) { return r.join(';'); })
        .join('\n');
    // ...
}
```

Ersetze so, dass `Korrektur` und `Korrektur_Note` als letzte Spalten **immer** vorhanden sind (aber leer wenn 0):

```javascript
function exportCSV() { const data = getData(); const csv = [['Fahrer','Telefon','Auszahlung','Status','Modell','Miete','Bolt','Uber','MyPOS','Gesamt','Abzug','Prozent','Korrektur','Korrektur_Note']].concat(data.map(function(s) { const k = parseFloat(s.korrektur) || 0; return [s.fahrer_name,s.telefon||'',s.auszahlung,s.status,s.mietmodell,s.miete,s.bolt_brutto,s.uber_fahrpreis,s.mypos_summe,s.bruttoumsatz_gesamt,s.abzug_gesamt,s.prozent_abzug, k !== 0 ? k : '', k !== 0 ? (s.korrektur_note || '') : '']; })).map(function(r) { return r.join(';'); }).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'})); a.download = 'abrechnungen_'+week+'.csv'; a.click(); }
```

- [ ] **Step 2: Verifikation — CSV hat Korrektur-Spalten; Werte nur bei != 0**

1. Dashboard → Export-Button für aktuelle Woche
2. CSV öffnen: Header zeigt `...;Prozent;Korrektur;Korrektur_Note`
3. Fahrer ohne Korrektur: die letzten 2 Felder sind leer (`;;` am Zeilenende)
4. Fahrer mit Korrektur: Beträge erscheinen korrekt
5. Wichtig: semicolon-Delimiter unverändert, keine Zusatz-Newlines

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "ui: add korrektur columns to CSV export"
```

---

## Task 6: Einmal-Tool — HTML-Skeleton + Auth

**Files:**
- Create: `korrektur-kw16.html`

- [ ] **Step 1: Grundgerüst mit PIN-Login**

Erstelle `korrektur-kw16.html` mit folgendem Inhalt:

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KW16 Korrektur-Tool (Einmalig)</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 20px auto; padding: 20px; background: #1a1714; color: #e5e1db; }
    h1 { color: #F5B51B; }
    .warn { background: #4a2c1a; border: 1px solid #d4a012; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
    .step { background: #2a2520; padding: 16px; border-radius: 8px; margin-bottom: 16px; }
    .step h2 { margin-top: 0; color: #F5B51B; font-size: 16px; }
    input, button { padding: 8px 12px; font-size: 14px; border-radius: 6px; border: 1px solid #4a4238; background: #1a1714; color: #e5e1db; }
    button { cursor: pointer; background: #F5B51B; color: #1a1714; font-weight: 600; }
    button:hover { background: #ffc93d; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .danger { background: #c4364a; color: white; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { padding: 8px; border-bottom: 1px solid #4a4238; text-align: left; }
    th { background: #2a2520; position: sticky; top: 0; }
    .num { text-align: right; font-family: monospace; }
    .pos { color: #34D186; }
    .neg { color: #ff6b7a; }
    .hidden { display: none; }
    pre { background: #0d0b08; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; max-height: 300px; }
    #log { background: #0d0b08; padding: 8px; border-radius: 6px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>⚠️ KW16 Korrektur-Tool (Einmalig)</h1>
<div class="warn">
    <strong>Achtung:</strong> Dieses Tool schreibt Korrektur-Beträge in die <code>settlements</code>-Tabelle für KW17.
    Es darf nur nach regulärer KW17-Berechnung verwendet werden. Rollback via
    <code>UPDATE settlements SET auszahlung = auszahlung - korrektur, korrektur = 0, korrektur_note = NULL WHERE woche = '2026-W17';</code>
</div>

<div class="step" id="stepAuth">
    <h2>1. Login</h2>
    <input type="text" id="pinName" placeholder="Name (z.B. Boyko)">
    <input type="password" id="pinCode" placeholder="PIN">
    <button id="btnLogin">Anmelden</button>
    <div id="authMsg"></div>
</div>

<div class="step hidden" id="stepUpload">
    <h2>2. Korrekte KW16-CSVs hochladen</h2>
    <p>Bolt-CSV: <input type="file" id="csvBolt" accept=".csv"></p>
    <p>Uber-CSV: <input type="file" id="csvUber" accept=".csv"></p>
    <p>MyPOS-CSV: <input type="file" id="csvMypos" accept=".csv"></p>
    <p>Quell-Woche: <input type="text" id="srcWoche" value="2026-W16" readonly style="width: 100px;"></p>
    <p>Ziel-Woche (Korrektur wird dort eingetragen): <input type="text" id="dstWoche" value="2026-W17" style="width: 100px;"></p>
    <button id="btnCompute" disabled>Deltas berechnen</button>
</div>

<div class="step hidden" id="stepReview">
    <h2>3. Review Deltas</h2>
    <div id="summaryBox"></div>
    <div id="tableContainer"></div>
    <p style="margin-top: 16px;">
        <button id="btnPreview">SQL-Preview</button>
        <button id="btnWrite" class="danger">In KW17 schreiben</button>
        <button id="btnDownloadLog">Audit-Log herunterladen</button>
    </p>
</div>

<div class="step hidden" id="stepLog">
    <h2>4. Audit-Log</h2>
    <div id="log"></div>
</div>

<script>
const SUPABASE_URL = 'https://pkxcwfkfaaorwnbdmylg.supabase.co';
const SUPABASE_ANON_KEY = ''; // Wird in Task 6 Step 3 gesetzt — aus index.html kopieren
let supa = null;
let currentUser = null;
let logLines = [];

function log(msg) {
    const ts = new Date().toISOString();
    logLines.push(`[${ts}] ${msg}`);
    const el = document.getElementById('log');
    if (el) el.textContent = logLines.join('\n');
    console.log(msg);
}

async function login() {
    const name = document.getElementById('pinName').value.trim();
    const pin = document.getElementById('pinCode').value.trim();
    if (!name || !pin) { document.getElementById('authMsg').textContent = 'Name + PIN nötig'; return; }
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supa.from('app_users').select('name,role').eq('name', name).eq('pin', pin).single();
    if (error || !data) { document.getElementById('authMsg').textContent = 'Login fehlgeschlagen'; return; }
    currentUser = data.name;
    log(`Login OK: ${currentUser} (${data.role})`);
    document.getElementById('stepAuth').classList.add('hidden');
    document.getElementById('stepUpload').classList.remove('hidden');
    document.getElementById('stepLog').classList.remove('hidden');
}

document.getElementById('btnLogin').addEventListener('click', login);
// Compute/write/preview wiring kommt in späteren Tasks
</script>
</body>
</html>
```

- [ ] **Step 2: SUPABASE_ANON_KEY aus index.html übernehmen**

Öffne `index.html`, finde die Zeile mit `SUPABASE_ANON_KEY` oder dem Key-String. Kopiere den Wert und trage ihn in `korrektur-kw16.html` an der markierten Stelle ein.

Konkrete Suche:

```bash
grep -n "anon\|SUPABASE" index.html | head -5
```

Erwartet: eine Zeile mit einem JWT-artigen String. Diesen in `korrektur-kw16.html` als Wert von `SUPABASE_ANON_KEY` eintragen.

- [ ] **Step 3: Verifikation — Login funktioniert**

1. `korrektur-kw16.html` in Browser öffnen (lokal via `file://` oder Cloudflare-Pages-Deploy)
2. Eingabe: Name "Boyko", PIN wie in `app_users`
3. Erwartet: Login-Schritt wird ausgeblendet, Upload-Schritt erscheint
4. Log zeigt "Login OK: Boyko (admin)"
5. Falscher PIN → "Login fehlgeschlagen"

- [ ] **Step 4: Commit**

```bash
git add korrektur-kw16.html
git commit -m "tool: add korrektur-kw16 skeleton with PIN auth"
```

---

## Task 7: Einmal-Tool — CSV-Parser + KW16-Rekalkulation (inline)

**Files:**
- Modify: `korrektur-kw16.html` (Script-Block erweitern)

- [ ] **Step 1: Helper-Funktionen aus `abrechnungsbot-berechnung-fixed.js` kopieren**

Im `<script>`-Block von `korrektur-kw16.html`, direkt nach `let logLines = [];`, folgende Helper einfügen (kopiert aus der n8n-Logik, minimal angepasst):

```javascript
function normalizeName(n) { return (n || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function parseMoney(v) {
    if (!v) return 0;
    let x = String(v).replace(/EUR|€|\u20ac/g, '').trim();
    if (!x) return 0;
    if (x.includes(',') && x.includes('.')) {
        if (x.lastIndexOf(',') > x.lastIndexOf('.')) x = x.replace(/\./g, '').replace(',', '.');
        else x = x.replace(/,/g, '');
    } else if (x.includes(',')) x = x.replace(',', '.');
    return parseFloat(x) || 0;
}
function cleanBOM(t) { return t.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
function detectDelimiter(t) {
    for (const line of t.split('\n')) {
        const s = line.trim(); if (!s) continue;
        const sc = (s.match(/;/g) || []).length, cm = (s.match(/,/g) || []).length;
        if (sc > 2) return ';';
        if (cm > 2) return ',';
    }
    return ',';
}
function parseCSV(text, delim) {
    text = cleanBOM(text);
    const lines = text.split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    let hdr = 0;
    for (let i = 0; i < Math.min(5, lines.length); i++) {
        const parts = lines[i].split(delim).filter(p => p.trim().replace(/"/g, ''));
        if (parts.length >= 3) { hdr = i; break; }
    }
    const headers = lines[hdr].split(delim).map(h => h.trim().replace(/^"|"$/g, '').replace(/^\uFEFF/, ''));
    const rows = [];
    for (let i = hdr + 1; i < lines.length; i++) {
        const line = lines[i].trim(); if (!line) continue;
        const vals = line.split(delim).map(v => v.trim().replace(/^"|"$/g, ''));
        if (vals.length < 2) continue;
        const row = {}; headers.forEach((h, idx) => row[h] = vals[idx] || '');
        rows.push(row);
    }
    return rows;
}
function cleanMyposCSV(t) {
    t = cleanBOM(t);
    const lines = t.split('\n');
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
        const lo = lines[i].toLowerCase();
        if (lo.includes('datum') && lo.includes('betrag') && (lo.includes('terminal') || lo.includes('name des terminals'))) { start = i; break; }
    }
    return lines.slice(start).join('\n');
}
function nameSim(a, b) {
    const s1 = normalizeName(a), s2 = normalizeName(b);
    if (s1 === s2) return 1;
    if (!s1.length || !s2.length) return 0;
    const m = [];
    for (let i = 0; i <= s1.length; i++) {
        m[i] = [i];
        for (let j = 1; j <= s2.length; j++) {
            if (!i) { m[i][j] = j; continue; }
            m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1] + (s1[i-1]===s2[j-1]?0:1));
        }
    }
    return 1 - m[s1.length][s2.length] / Math.max(s1.length, s2.length);
}
```

- [ ] **Step 2: Rekalkulations-Funktion einfügen**

Danach die Rekalkulations-Funktion einfügen:

```javascript
async function readFile(f) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('File read error'));
        r.readAsText(f, 'utf-8');
    });
}

async function computeKw16Correct() {
    const boltFile = document.getElementById('csvBolt').files[0];
    const uberFile = document.getElementById('csvUber').files[0];
    const myposFile = document.getElementById('csvMypos').files[0];
    if (!boltFile || !uberFile) throw new Error('Bolt und Uber CSV sind Pflicht (MyPOS optional)');
    const srcWoche = document.getElementById('srcWoche').value.trim();
    log(`Rekalkulation für ${srcWoche}...`);

    // Load fahrer master data
    const { data: fahrerData, error: fErr } = await supa.from('fahrer')
        .select('name,mietmodell,basis_miete,prozent_satz,prozent_schwelle,telefon')
        .eq('aktiv', true);
    if (fErr) throw fErr;
    const fahrerDict = {};
    for (const f of fahrerData) fahrerDict[f.name] = {
        mietmodell: f.mietmodell || 'fix',
        basis_miete: parseFloat(f.basis_miete) || 0,
        prozent_satz: parseFloat(f.prozent_satz) || 0,
        prozent_schwelle: parseFloat(f.prozent_schwelle) || 1200
    };

    // Load aliases
    const { data: aliasData } = await supa.from('name_aliases').select('csv_name,fahrer_name');
    const aliasDict = {};
    for (const a of (aliasData || [])) aliasDict[normalizeName(a.csv_name)] = a.fahrer_name;

    // Load mypos terminal→fahrer mapping (Notion-synced via fahrer table, NOT available via frontend directly)
    // Fallback: parse MyPOS by terminal only, don't assign if no match — manually fixable later
    // For this one-off tool, we skip MyPOS-terminal→fahrer mapping since it lives in Notion, and instead
    // use the already-processed KW16 mypos_summe from existing settlements as fallback source.
    const { data: existingKw16, error: exErr } = await supa.from('settlements').select('*').eq('woche', srcWoche);
    if (exErr) throw exErr;
    const existingDict = {};
    for (const s of existingKw16) existingDict[s.fahrer_name] = s;

    // Parse Bolt
    const boltRaw = await readFile(boltFile);
    const boltRows = parseCSV(boltRaw, detectDelimiter(boltRaw));
    const boltDict = {};
    for (const row of boltRows) {
        const name = (row['Fahrer:in'] || row['Fahrer/in'] || row['Fahrer'] || row['Driver name'] || row['Driver'] || '').trim();
        if (!name) continue;
        const keys = Object.keys(row);
        let bK = keys.find(k => k.includes('Bruttoverdienst') && k.includes('insgesamt'));
        if (!bK) bK = keys.find(k => k.includes('Bruttoverdienst') && !k.includes('pro Stunde'));
        if (!bK) bK = keys.find(k => k.toLowerCase().includes('gross earnings'));
        let aK = keys.find(k => k.includes('Voraussichtliche Auszahlung'));
        if (!aK) aK = keys.find(k => k.toLowerCase().includes('payout'));
        boltDict[name] = { brutto: parseMoney(bK ? row[bK] : 0), auszahlung: parseMoney(aK ? row[aK] : 0) };
    }

    // Parse Uber
    const uberRaw = await readFile(uberFile);
    const uberRows = parseCSV(uberRaw, detectDelimiter(uberRaw));
    const uberDict = {};
    for (const row of uberRows) {
        const vor = (row['Vorname des Fahrers'] || '').trim();
        const nach = (row['Nachname des Fahrers'] || '').trim();
        const full = `${vor} ${nach}`.trim();
        if (!full) continue;
        let fp = parseMoney(row['An dein Unternehmen gezahlt : Deine Umsätze : Fahrpreis']);
        if (!fp) fp = parseMoney(row['An dein Unternehmen gezahlt:Deine Umsätze:Fahrpreis:Fahrpreis']);
        uberDict[full] = { fahrpreis: fp, auszahlung: parseMoney(row['An dein Unternehmen gezahlt']) };
    }

    // MyPOS: we use existing-settlements mypos_summe because terminal mapping lives in Notion.
    // The falsche-CSV-Fehler in KW16 betraf typischerweise Bolt/Uber, nicht MyPOS. Wenn doch MyPOS betroffen,
    // muss der User das manuell in der Delta-Spalte anpassen (override möglich).

    function findFahrer(name) {
        const nn = normalizeName(name);
        if (aliasDict[nn] && fahrerDict[aliasDict[nn]]) return { key: aliasDict[nn], data: fahrerDict[aliasDict[nn]] };
        if (fahrerDict[name]) return { key: name, data: fahrerDict[name] };
        for (const k of Object.keys(fahrerDict)) if (normalizeName(k) === nn) return { key: k, data: fahrerDict[k] };
        let best = null, score = 0;
        for (const k of Object.keys(fahrerDict)) {
            const sc = nameSim(name, k);
            if (sc >= 0.92 && sc > score) { best = { key: k, data: fahrerDict[k] }; score = sc; }
        }
        return best;
    }

    const correctByFahrer = {};
    const allNames = new Set();
    for (const n of Object.keys(uberDict)) allNames.add(n);
    for (const n of Object.keys(boltDict)) allNames.add(n);

    for (const name of allNames) {
        const fahrer = findFahrer(name);
        const key = fahrer ? fahrer.key : name;
        const bolt = boltDict[name] || { brutto: 0, auszahlung: 0 };
        const uber = uberDict[name] || { fahrpreis: 0, auszahlung: 0 };
        // fallback: use existing mypos_summe from KW16 settlement (since mapping is in Notion)
        const existing = existingDict[key] || {};
        const mypos = parseFloat(existing.mypos_summe) || 0;
        const brutto_gesamt = bolt.brutto + uber.fahrpreis + mypos;
        const wir_bekommen = bolt.auszahlung + uber.auszahlung + mypos;
        let miete = 0, prozent_abzug = 0;
        if (fahrer) {
            miete = fahrer.data.basis_miete;
            if (fahrer.data.mietmodell === 'f11' && brutto_gesamt > 1100) prozent_abzug = (brutto_gesamt - 1100) * 0.10;
            else if (fahrer.data.mietmodell === 'f12' && brutto_gesamt > 1200) prozent_abzug = (brutto_gesamt - 1200) * 0.10;
            else if (fahrer.data.prozent_satz > 0 && brutto_gesamt > fahrer.data.prozent_schwelle)
                prozent_abzug = (brutto_gesamt - fahrer.data.prozent_schwelle) * (fahrer.data.prozent_satz / 100);
        }
        const korrekt_auszahlung = wir_bekommen - miete - prozent_abzug;
        correctByFahrer[key] = { korrekt_auszahlung, brutto_gesamt, wir_bekommen, miete, prozent_abzug, matched: !!fahrer };
    }

    log(`Rekalkulation OK: ${Object.keys(correctByFahrer).length} Fahrer`);
    return { correctByFahrer, existingDict };
}
```

- [ ] **Step 3: Aktivieren des Compute-Buttons wenn beide CSVs da**

Am Ende des Script-Blocks, vor dem schließenden `</script>`:

```javascript
function checkComputeReady() {
    const ok = document.getElementById('csvBolt').files[0] && document.getElementById('csvUber').files[0];
    document.getElementById('btnCompute').disabled = !ok;
}
['csvBolt', 'csvUber', 'csvMypos'].forEach(id => {
    document.getElementById(id).addEventListener('change', checkComputeReady);
});
```

- [ ] **Step 4: Verifikation — Parser liest Test-CSVs**

1. Tool öffnen, einloggen
2. DevTools Console öffnen
3. Eine alte Bolt-CSV (z.B. aus einer früheren Woche, die du lokal hast) uploaden
4. In Console: `await computeKw16Correct()` (manuell aufrufen mit korrekten File-Objekten)
5. Erwartet: kein Fehler, ein Objekt mit `correctByFahrer` und ~50 Einträgen
6. Log-Bereich zeigt "Rekalkulation OK: XX Fahrer"

**Wichtig:** Diese Verifikation macht noch KEIN UPDATE. Nur Rekalkulation im Browser-RAM.

- [ ] **Step 5: Commit**

```bash
git add korrektur-kw16.html
git commit -m "tool: add CSV parser and KW16 recalculation logic"
```

---

## Task 8: Einmal-Tool — Delta-Berechnung + Review-Tabelle

**Files:**
- Modify: `korrektur-kw16.html`

- [ ] **Step 1: Delta-Berechnung und Review-Rendering**

Im `<script>`-Block nach der `computeKw16Correct`-Funktion:

```javascript
let currentDeltas = []; // in-memory state for review

async function renderReview() {
    try {
        const { correctByFahrer, existingDict } = await computeKw16Correct();
        const rows = [];
        for (const [name, existing] of Object.entries(existingDict)) {
            if (name === '__TRANSFER__') continue;
            const ausgezahlt = parseFloat(existing.auszahlung) || 0;
            const korrekt = correctByFahrer[name] ? correctByFahrer[name].korrekt_auszahlung : ausgezahlt;
            const delta = Math.round((korrekt - ausgezahlt) * 100) / 100;
            rows.push({
                fahrer_name: name,
                ausgezahlt: ausgezahlt,
                korrekt: korrekt,
                delta: delta,
                note: 'Nachzahlung KW16 falsche CSV',
                enabled: delta !== 0,
                matched: correctByFahrer[name] ? correctByFahrer[name].matched : false
            });
        }
        // Auch neue Fahrer (in korrekter CSV, aber nicht in existing) hinzufügen
        for (const name of Object.keys(correctByFahrer)) {
            if (!existingDict[name]) {
                const korrekt = correctByFahrer[name].korrekt_auszahlung;
                rows.push({
                    fahrer_name: name,
                    ausgezahlt: 0,
                    korrekt: korrekt,
                    delta: Math.round(korrekt * 100) / 100,
                    note: 'Nachzahlung KW16 (nicht in alter Abrechnung)',
                    enabled: true,
                    matched: correctByFahrer[name].matched
                });
            }
        }
        currentDeltas = rows;
        const totalDelta = rows.filter(r => r.enabled).reduce((a, r) => a + r.delta, 0);
        document.getElementById('summaryBox').innerHTML =
            `<p><strong>Fahrer mit Delta ≠ 0:</strong> ${rows.filter(r => r.delta !== 0).length} von ${rows.length}</p>` +
            `<p><strong>Nettosumme aller aktivierten Deltas:</strong> ${totalDelta.toFixed(2)} € ` +
            `<em>(sollte nahe 0 sein wenn KW16 Netto korrekt ausbezahlt wurde)</em></p>`;
        renderTable();
        document.getElementById('stepReview').classList.remove('hidden');
        log(`Review bereit: ${rows.length} Zeilen, davon ${rows.filter(r=>r.delta!==0).length} mit Delta`);
    } catch (e) {
        log(`FEHLER: ${e.message}`);
        alert('Fehler: ' + e.message);
    }
}

function renderTable() {
    let html = '<table><thead><tr><th>✓</th><th>Fahrer</th><th class="num">Ausgezahlt</th><th class="num">Korrekt</th><th class="num">Delta</th><th>Note</th></tr></thead><tbody>';
    for (let i = 0; i < currentDeltas.length; i++) {
        const r = currentDeltas[i];
        if (r.delta === 0) continue; // hide zero rows (toggle could be added)
        const cls = r.delta > 0 ? 'pos' : 'neg';
        const warn = !r.matched ? ' ⚠' : '';
        html += `<tr><td><input type="checkbox" data-idx="${i}" class="cbEnable" ${r.enabled?'checked':''}></td>` +
            `<td>${r.fahrer_name}${warn}</td>` +
            `<td class="num">${r.ausgezahlt.toFixed(2)}</td>` +
            `<td class="num">${r.korrekt.toFixed(2)}</td>` +
            `<td class="num ${cls}"><input type="number" step="0.01" data-idx="${i}" class="inpDelta" value="${r.delta}" style="width:90px;text-align:right;"></td>` +
            `<td><input type="text" data-idx="${i}" class="inpNote" value="${r.note.replace(/"/g,'&quot;')}" style="width:100%;"></td></tr>`;
    }
    html += '</tbody></table>';
    document.getElementById('tableContainer').innerHTML = html;
    // Wire up edits
    document.querySelectorAll('.cbEnable').forEach(el => el.addEventListener('change', e => {
        currentDeltas[+e.target.dataset.idx].enabled = e.target.checked;
    }));
    document.querySelectorAll('.inpDelta').forEach(el => el.addEventListener('input', e => {
        currentDeltas[+e.target.dataset.idx].delta = parseFloat(e.target.value) || 0;
    }));
    document.querySelectorAll('.inpNote').forEach(el => el.addEventListener('input', e => {
        currentDeltas[+e.target.dataset.idx].note = e.target.value;
    }));
}

document.getElementById('btnCompute').addEventListener('click', renderReview);
```

- [ ] **Step 2: Verifikation — Review-Tabelle rendert**

1. Tool öffnen, einloggen
2. Bolt + Uber (+ optional MyPOS) CSVs für KW16 hochladen (die **korrekten** — nicht die ursprünglich fehlerhaften)
3. "Deltas berechnen" klicken
4. Erwartet: Review-Sektion erscheint, Tabelle zeigt Fahrer mit Delta ≠ 0
5. Summary zeigt Nettosumme
6. Fahrer mit ⚠ = kein Match im fahrer-Table → prüfen ob das gewollt ist
7. Checkbox toggelt "enabled", Delta-Input ist editierbar, Note-Input ist editierbar

- [ ] **Step 3: Commit**

```bash
git add korrektur-kw16.html
git commit -m "tool: add delta computation and review UI"
```

---

## Task 9: Einmal-Tool — SQL-Preview + Idempotentes Schreiben

**Files:**
- Modify: `korrektur-kw16.html`

- [ ] **Step 1: Preview + Write-Funktionen**

Nach `renderTable` im Script-Block:

```javascript
function buildUpdates() {
    const dstWoche = document.getElementById('dstWoche').value.trim();
    const updates = [];
    for (const r of currentDeltas) {
        if (!r.enabled) continue;
        if (r.delta === 0) continue;
        updates.push({
            woche: dstWoche,
            fahrer_name: r.fahrer_name,
            delta: r.delta,
            note: r.note
        });
    }
    return { dstWoche, updates };
}

async function previewSql() {
    const { dstWoche, updates } = buildUpdates();
    if (!updates.length) { alert('Keine aktivierten Deltas'); return; }
    // Check KW17 settlements existieren
    const { data: kw17, error } = await supa.from('settlements').select('fahrer_name,auszahlung,korrektur').eq('woche', dstWoche);
    if (error) { alert('DB-Fehler: ' + error.message); return; }
    const kw17Map = {};
    for (const s of kw17) kw17Map[s.fahrer_name] = s;
    const missing = updates.filter(u => !kw17Map[u.fahrer_name]);
    if (missing.length) {
        alert(`ABORT: ${missing.length} Fahrer haben keine KW17-Zeile: ${missing.map(m=>m.fahrer_name).join(', ')}. Bitte KW17-CSVs zuerst verarbeiten oder diese Fahrer deaktivieren.`);
        return;
    }
    const sql = updates.map(u => {
        const row = kw17Map[u.fahrer_name];
        const alteKorr = parseFloat(row.korrektur) || 0;
        const warn = alteKorr !== 0 ? ` -- WARNUNG: alte Korrektur ${alteKorr} wird überschrieben` : '';
        const noteEsc = u.note.replace(/'/g, "''");
        return `UPDATE settlements SET auszahlung = auszahlung - korrektur + ${u.delta}, korrektur = ${u.delta}, korrektur_note = '${noteEsc}' WHERE woche = '${u.woche}' AND fahrer_name = '${u.fahrer_name.replace(/'/g, "''")}';${warn}`;
    }).join('\n');
    const modal = document.createElement('div');
    modal.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;padding:40px;overflow:auto;';
    modal.innerHTML = `<pre style="background:#1a1714;color:#e5e1db;padding:20px;border-radius:8px;max-width:1000px;margin:0 auto;">${sql.replace(/</g,'&lt;')}</pre><p style="text-align:center;margin-top:16px;"><button onclick="this.parentElement.parentElement.remove()">Schließen</button></p>`;
    document.body.appendChild(modal);
    log(`SQL-Preview: ${updates.length} UPDATEs generiert`);
}

async function writeCorrections() {
    const { dstWoche, updates } = buildUpdates();
    if (!updates.length) { alert('Keine aktivierten Deltas'); return; }

    // Pre-check existence
    const { data: kw17, error: preErr } = await supa.from('settlements').select('fahrer_name,korrektur').eq('woche', dstWoche);
    if (preErr) { alert('DB-Fehler: ' + preErr.message); return; }
    const kw17Map = {};
    for (const s of kw17) kw17Map[s.fahrer_name] = s;
    const missing = updates.filter(u => !kw17Map[u.fahrer_name]);
    if (missing.length) {
        alert(`ABORT: ${missing.length} Fahrer haben keine ${dstWoche}-Zeile`);
        return;
    }
    const existingCorr = updates.filter(u => (parseFloat(kw17Map[u.fahrer_name].korrektur) || 0) !== 0);
    const confirmMsg = `${updates.length} Korrekturen in ${dstWoche} schreiben.` +
        (existingCorr.length ? `\n\n⚠ ${existingCorr.length} Zeilen haben bereits eine Korrektur — wird überschrieben.` : '') +
        `\n\nFortfahren?`;
    if (!confirm(confirmMsg)) { log('Abbruch durch User'); return; }

    log(`START: ${updates.length} UPDATEs...`);
    let ok = 0, err = 0;
    for (const u of updates) {
        const row = kw17Map[u.fahrer_name];
        const alteKorr = parseFloat(row.korrektur) || 0;
        // Idempotent: read current auszahlung, subtract old korrektur, add new delta
        const { data: current, error: readErr } = await supa.from('settlements')
            .select('auszahlung').eq('woche', u.woche).eq('fahrer_name', u.fahrer_name).single();
        if (readErr) { log(`FEHLER read ${u.fahrer_name}: ${readErr.message}`); err++; continue; }
        const newAuszahlung = (parseFloat(current.auszahlung) || 0) - alteKorr + u.delta;
        const { error: upErr } = await supa.from('settlements').update({
            auszahlung: Math.round(newAuszahlung * 100) / 100,
            korrektur: u.delta,
            korrektur_note: u.note
        }).eq('woche', u.woche).eq('fahrer_name', u.fahrer_name);
        if (upErr) { log(`FEHLER update ${u.fahrer_name}: ${upErr.message}`); err++; continue; }
        log(`OK ${u.fahrer_name}: korrektur=${u.delta}, auszahlung=${newAuszahlung.toFixed(2)}`);
        ok++;
    }
    log(`FERTIG: ${ok} OK, ${err} Fehler`);
    alert(`${ok} Korrekturen geschrieben, ${err} Fehler. Siehe Audit-Log.`);
}

document.getElementById('btnPreview').addEventListener('click', previewSql);
document.getElementById('btnWrite').addEventListener('click', writeCorrections);
```

- [ ] **Step 2: Verifikation — SQL-Preview (Dry-Run)**

1. Tool geöffnet mit Review-Tabelle
2. "SQL-Preview" klicken
3. Erwartet: Modal mit SQL-Statements pro Fahrer, Format:
   ```
   UPDATE settlements SET auszahlung = auszahlung - korrektur + 15.50, korrektur = 15.50, korrektur_note = '...' WHERE woche = '2026-W17' AND fahrer_name = '...';
   ```
4. Keine DB-Änderung, keine UPDATE ausgeführt
5. Prüfen in Supabase: `SELECT korrektur FROM settlements WHERE woche = '2026-W17';` → alles noch 0

- [ ] **Step 3: Verifikation — Write in Test-Szenario**

**NICHT auf echter KW17 testen!** Stattdessen:

1. Im Supabase SQL Editor Test-Zeilen anlegen:
   ```sql
   INSERT INTO settlements (woche, fahrer_name, auszahlung, korrektur) VALUES
     ('2026-W99-TEST', 'Test Fahrer 1', 500.00, 0),
     ('2026-W99-TEST', 'Test Fahrer 2', 600.00, 0);
   ```
2. Im Tool: `dstWoche` auf `2026-W99-TEST` setzen (manuell im UI)
3. `currentDeltas` manuell via DevTools Console setzen:
   ```javascript
   currentDeltas = [
     { fahrer_name: 'Test Fahrer 1', ausgezahlt: 500, korrekt: 525, delta: 25, note: 'test', enabled: true, matched: true },
     { fahrer_name: 'Test Fahrer 2', ausgezahlt: 600, korrekt: 590, delta: -10, note: 'test', enabled: true, matched: true }
   ];
   ```
4. "In KW17 schreiben" klicken, Confirm
5. Supabase prüfen:
   ```sql
   SELECT fahrer_name, auszahlung, korrektur, korrektur_note FROM settlements WHERE woche = '2026-W99-TEST';
   ```
6. Erwartet: Fahrer 1 = auszahlung 525, korrektur 25. Fahrer 2 = auszahlung 590, korrektur -10.

- [ ] **Step 4: Verifikation — Idempotenz**

1. Nochmal "In KW17 schreiben" klicken auf denselben Test-Daten
2. Erwartet: Confirm-Dialog zeigt "⚠ 2 Zeilen haben bereits eine Korrektur — wird überschrieben"
3. Bestätigen
4. Supabase prüfen: Werte UNVERÄNDERT (nicht doppelt addiert)

- [ ] **Step 5: Test-Zeilen wegräumen**

```sql
DELETE FROM settlements WHERE woche = '2026-W99-TEST';
```

- [ ] **Step 6: Commit**

```bash
git add korrektur-kw16.html
git commit -m "tool: add SQL preview and idempotent write for korrektur"
```

---

## Task 10: Einmal-Tool — Audit-Log Download

**Files:**
- Modify: `korrektur-kw16.html`

- [ ] **Step 1: Download-Funktion implementieren**

Im Script-Block:

```javascript
function downloadLog() {
    const blob = new Blob([logLines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `korrektur-audit-${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
    a.click();
}
document.getElementById('btnDownloadLog').addEventListener('click', downloadLog);
```

- [ ] **Step 2: Verifikation**

1. Tool benutzen bis Log einige Einträge hat
2. "Audit-Log herunterladen" klicken
3. Erwartet: `.txt` Datei mit allen Log-Zeilen + Zeitstempeln
4. Datei öffnen, Zeilen-Count prüfen

- [ ] **Step 3: Commit**

```bash
git add korrektur-kw16.html
git commit -m "tool: add audit log download"
```

---

## Task 11: End-to-End Verifikation in Test-Umgebung

**Files:** keine Änderung — rein manuelle Verifikation

- [ ] **Step 1: Test-Daten in Supabase einrichten**

```sql
-- 2 Test-Fahrer
INSERT INTO fahrer (name, mietmodell, basis_miete, prozent_satz, prozent_schwelle, telefon, aktiv)
VALUES
  ('Test E2E A', 'fix', 200, 0, 1200, '+43-000-1', true),
  ('Test E2E B', 'f12', 250, 0, 1200, '+43-000-2', true)
ON CONFLICT (name) DO NOTHING;

-- Test-KW16-settlements (simuliert ausgezahlte, falsche Beträge)
INSERT INTO settlements (woche, fahrer_name, bolt_brutto, bolt_auszahlung, uber_fahrpreis, uber_auszahlung, mypos_summe, bruttoumsatz_gesamt, wir_bekommen, mietmodell, miete, prozent_abzug, abzug_gesamt, auszahlung, status)
VALUES
  ('2026-W16-TEST', 'Test E2E A', 800, 700, 200, 180, 50, 1050, 930, 'fix', 200, 0, 200, 730, 'berechnet'),
  ('2026-W16-TEST', 'Test E2E B', 900, 810, 400, 360, 100, 1400, 1270, 'f12', 250, 20, 270, 1000, 'berechnet');

-- Test-KW17-settlements (normal berechnet, ohne Korrektur)
INSERT INTO settlements (woche, fahrer_name, auszahlung, korrektur, status)
VALUES
  ('2026-W17-TEST', 'Test E2E A', 500, 0, 'berechnet'),
  ('2026-W17-TEST', 'Test E2E B', 600, 0, 'berechnet');
```

- [ ] **Step 2: Test-CSV generieren (korrekte KW16-Daten)**

Erstelle lokal eine Mini-Bolt-CSV `/tmp/bolt-test.csv`:

```csv
Fahrer:in;Bruttoverdienst insgesamt;Voraussichtliche Auszahlung
Test E2E A;"900,00";"810,00"
Test E2E B;"1000,00";"900,00"
```

Erstelle Uber-CSV `/tmp/uber-test.csv`:

```csv
Vorname des Fahrers;Nachname des Fahrers;An dein Unternehmen gezahlt : Deine Umsätze : Fahrpreis;An dein Unternehmen gezahlt
Test;E2E A;"200,00";"180,00"
Test;E2E B;"450,00";"405,00"
```

- [ ] **Step 3: Tool ausführen**

1. `korrektur-kw16.html` öffnen, einloggen
2. Beide CSVs hochladen
3. `srcWoche` auf `2026-W16-TEST`, `dstWoche` auf `2026-W17-TEST`
4. "Deltas berechnen"
5. Erwartet:
   - Fahrer A: Ausgezahlt 730, Korrekt ≈ 790 (900+200+50-200=950 wir_bekommen? Nee, 810+180+50=1040... -200 Miete = 840). Genaue Zahl berechnen und mit Tool-Ausgabe vergleichen.
   - Delta wird in Tabelle angezeigt

**Wichtig:** Wenn Delta != erwartet → Tool-Formel-Bug. Dann pausieren und die Differenz debuggen (wahrscheinlich MyPOS-Fallback oder Brutto/Netto-Verwechslung).

- [ ] **Step 4: Schreiben und in Supabase verifizieren**

1. "In KW17 schreiben" → Confirm
2. SQL:
   ```sql
   SELECT fahrer_name, auszahlung, korrektur, korrektur_note FROM settlements WHERE woche = '2026-W17-TEST';
   ```
3. Erwartet: `korrektur` != 0, `auszahlung` = original + delta

- [ ] **Step 5: Dashboard-Anzeige prüfen**

1. Dashboard öffnen, Woche `2026-W17-TEST` wählen (wird im Dropdown erscheinen)
2. Auf Test-Fahrer klicken → Print-Modal zeigt Korrektur-Sektion mit korrekter Note und Betrag
3. Batch-Print: Korrektur-Sektion erscheint nur bei den 2 Test-Fahrern
4. CSV-Export: Korrektur-Spalte gefüllt

- [ ] **Step 6: Rollback testen**

```sql
UPDATE settlements SET auszahlung = auszahlung - korrektur, korrektur = 0, korrektur_note = NULL WHERE woche = '2026-W17-TEST';
SELECT fahrer_name, auszahlung, korrektur FROM settlements WHERE woche = '2026-W17-TEST';
```

Erwartet: `auszahlung` wieder 500 / 600, `korrektur` = 0, `korrektur_note` = NULL.

- [ ] **Step 7: Test-Daten wegräumen**

```sql
DELETE FROM settlements WHERE woche IN ('2026-W16-TEST', '2026-W17-TEST');
DELETE FROM fahrer WHERE name IN ('Test E2E A', 'Test E2E B');
```

- [ ] **Step 8: Commit**

Kein Code-Commit in diesem Task. Stattdessen:

```bash
# Verification passed — nothing to commit
```

---

## Task 12: Rollout-Sequenz ausführen (Produktionseinsatz)

**Files:** keine Code-Änderung — dokumentierte Ausführung

- [ ] **Step 1: Migration in Produktions-Supabase**

1. `migrations/2026-04-20-add-korrektur-columns.sql` im Supabase SQL Editor ausführen
2. Verifikation: `SELECT column_name FROM information_schema.columns WHERE table_name='settlements' AND column_name IN ('korrektur','korrektur_note');` → 2 Zeilen

- [ ] **Step 2: Dashboard + Tool deployen**

```bash
git push origin main
```

Cloudflare Pages baut automatisch. `korrektur-kw16.html` ist **nicht** im Dashboard verlinkt — nur per direkter URL aufrufbar.

- [ ] **Step 3: Baseline-Test Normalbetrieb**

1. Dashboard mit aktueller Woche laden
2. Prüfen: alle Fahrer zeigen Auszahlung wie vorher
3. Einen Fahrer drucken → Print-Modal zeigt **keine** Korrektur-Sektion
4. CSV-Export: Header hat neue `Korrektur`-Spalten, Werte sind leer bei allen Fahrern

**Wenn irgendwas abweicht:** STOP. Kein KW17-Korrekturlauf bevor das geklärt ist.

- [ ] **Step 4: KW17 regulär berechnen**

Normal via AbrBot (n8n) — CSVs hochladen → settlements KW17 werden geschrieben mit `korrektur = 0` (DEFAULT).

Verifikation:
```sql
SELECT COUNT(*), SUM(CASE WHEN korrektur != 0 THEN 1 ELSE 0 END) AS mit_korrektur FROM settlements WHERE woche = '2026-W17';
```
Erwartet: `mit_korrektur = 0`

- [ ] **Step 5: Einmal-Tool anwenden**

1. `https://hydrafleet.at/korrektur-kw16.html` (oder lokal) öffnen
2. Einloggen
3. **KORREKTE** KW16-CSVs hochladen (Bolt + Uber + ggf. MyPOS)
4. `srcWoche = 2026-W16`, `dstWoche = 2026-W17`
5. "Deltas berechnen"
6. Review jeden Fahrer: Ausgezahlt, Korrekt, Delta plausibel?
7. Nettosumme: sollte nahe 0 sein (wenn Gesamt-KW16-Auszahlung in Summe stimmte, wurde nur die Verteilung falsch)
8. "SQL-Preview" prüfen
9. "In KW17 schreiben"
10. "Audit-Log herunterladen" — sichern!

- [ ] **Step 6: Review im Dashboard**

1. Dashboard → KW17
2. Betroffene Fahrer durchklicken — Korrektur-Sektion zeigt Note + Betrag
3. Auszahlung = alter_KW17_Betrag + delta
4. CSV-Export → Korrektur-Spalten gefüllt

- [ ] **Step 7: Versand**

Wenn alles passt: CSV/PDF/WhatsApp an Fahrer wie gewohnt.

- [ ] **Step 8: Notbremse (nur wenn Fehler entdeckt vor Versand)**

```sql
UPDATE settlements
SET auszahlung = auszahlung - korrektur, korrektur = 0, korrektur_note = NULL
WHERE woche = '2026-W17';
```

Dann Ursache klären, Tool erneut anwenden.

- [ ] **Step 9: Nach Einsatz — Tool markieren als erledigt**

Optional: `korrektur-kw16.html` umbenennen zu `_korrektur-kw16-DONE-2026-04-20.html` oder einen Hinweis oben in der Datei hinzufügen:

```html
<!-- ERLEDIGT: angewandt am 2026-04-XX für KW16→KW17. Kann bei Bedarf wiederverwendet werden. -->
```

```bash
git add korrektur-kw16.html
git commit -m "tool: mark korrektur-kw16 as applied"
git push origin main
```

---

## Self-Review Checkliste (am Ende des Plans durchführen)

Vor Abgabe dieses Plans prüfen:

1. **Spec-Coverage:** Jeder Abschnitt der Spec hat einen Task?
   - Schema-Änderung → Task 1 ✓
   - Einmal-Tool Auth/Upload → Task 6 ✓
   - Rekalkulation → Task 7 ✓
   - Review-UI → Task 8 ✓
   - SQL-Preview + idempotentes Schreiben → Task 9 ✓
   - Audit-Log → Task 10 ✓
   - n8n "keine Änderung" → explizit in Intro dokumentiert ✓
   - Dashboard konditional (Print-Modal, printDriver, printAllDrivers, exportCSV) → Task 2-5 ✓
   - Test & Rollout → Task 11 + 12 ✓

2. **Placeholder-Scan:** Keine "TBD", "siehe oben", "analog zu Task N".

3. **Type-Konsistenz:** Feldnamen `korrektur`, `korrektur_note` durchgängig. Element-IDs `printKorrekturSection`, `printKorrektur`, `printKorrekturLabel` konsistent. Variablen `currentDeltas`, `logLines` konsistent.

4. **Risiko-Prinzipien:** Alle DB-Änderungen additiv, n8n unangetastet, Normalbetrieb bit-identisch bei `korrektur=0`, Rollback-Pfad in Task 12 Step 8 dokumentiert.
