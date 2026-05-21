# Müssen-zahlen Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new "Müssen zahlen" tab to `dashboard.html` that lists all driver debts across all weeks and lets logged-in users record collected payments (cash / transfer / offset) with full audit trail.

**Architecture:** Single new Supabase table `kassier_zahlungen` (append-only payment log). All UI lives in `dashboard.html` (vanilla JS, no build step). The "offen" remaining amount is computed at render time from `settlements.auszahlung` minus the sum of recorded payments — the existing settlement calculation is never touched.

**Tech Stack:** Vanilla JS / HTML, Supabase JS client (CDN), no test framework (manual smoke-tests per task).

**Spec:** [docs/superpowers/specs/2026-05-21-muessen-zahlen-tab-design.md](../specs/2026-05-21-muessen-zahlen-tab-design.md)

## Testing approach

This project has no automated tests. Each task ends with a **manual smoke-test scenario** that must be performed in the browser (`open dashboard.html` after a hard reload + login as Boyko/Bislan) before committing. Where possible, tasks isolate one observable behavior so the smoke-test is small.

For DB changes, the smoke-test is "run the SQL in Supabase SQL Editor and confirm no errors + the expected rows exist".

---

## File Structure

**Create:**
- `migrations/2026-05-22-add-kassier-zahlungen.sql` — DB migration (new table + RLS policies)

**Modify:**
- `dashboard.html` — add tab button, content area, modal, JS functions, event handlers (~250 new lines)
- `CLAUDE.md` — update tab count (3→4), add `kassier_zahlungen` to tables list

**Out of scope:** No changes to `index.html`, `setup.sql`, `sw.js`, n8n workflows.

---

## Task 1: Create DB migration for `kassier_zahlungen`

**Files:**
- Create: `migrations/2026-05-22-add-kassier-zahlungen.sql`

- [ ] **Step 1: Write the migration SQL**

Create `migrations/2026-05-22-add-kassier-zahlungen.sql` with this content:

```sql
-- ============================================
-- KASSIER_ZAHLUNGEN: collected payments per driver debt
-- Spec: docs/superpowers/specs/2026-05-21-muessen-zahlen-tab-design.md
-- ============================================

CREATE TABLE IF NOT EXISTS kassier_zahlungen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fahrer_name TEXT NOT NULL,
  woche TEXT NOT NULL,
  betrag NUMERIC(10,2) NOT NULL CHECK (betrag > 0),
  typ TEXT NOT NULL CHECK (typ IN ('bar', 'ueberweisung', 'verrechnet')),
  verrechnet_mit_woche TEXT,
  kassiert_von TEXT NOT NULL,
  kassiert_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  CONSTRAINT verrechnet_requires_woche
    CHECK (typ <> 'verrechnet' OR verrechnet_mit_woche IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_kassier_fahrer_woche
  ON kassier_zahlungen (fahrer_name, woche);

ALTER TABLE kassier_zahlungen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_kassier" ON kassier_zahlungen
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_insert_kassier" ON kassier_zahlungen
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_delete_kassier" ON kassier_zahlungen
  FOR DELETE TO anon USING (true);

-- No UPDATE policy: errors are corrected via delete + re-insert (admin only client-side)
```

- [ ] **Step 2: Run migration in Supabase SQL Editor**

Open https://supabase.com/dashboard/project/pkxcwfkfaaorwnbdmylg/sql, paste the SQL, click "Run".
Expected: "Success. No rows returned."

- [ ] **Step 3: Smoke-test: verify table exists**

In Supabase SQL Editor, run:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'kassier_zahlungen' ORDER BY ordinal_position;
```
Expected: 9 rows (id, fahrer_name, woche, betrag, typ, verrechnet_mit_woche, kassiert_von, kassiert_at, note).

- [ ] **Step 4: Smoke-test: insert + select via anon key**

```sql
INSERT INTO kassier_zahlungen (fahrer_name, woche, betrag, typ, kassiert_von)
VALUES ('__TEST__', 'KW00', 10.00, 'bar', 'Boyko') RETURNING id;

SELECT * FROM kassier_zahlungen WHERE fahrer_name = '__TEST__';

DELETE FROM kassier_zahlungen WHERE fahrer_name = '__TEST__';
```
Expected: insert returns 1 id, select returns 1 row, delete removes it.

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-05-22-add-kassier-zahlungen.sql
git commit -m "db: add kassier_zahlungen table for collected-payment tracking"
```

---

## Task 2: Add tab button + empty content area, reorder tabs

**Files:**
- Modify: `dashboard.html` lines 491–504 (tab nav), line ~702 (after `contentAbrBot`), lines 956–975 (switchTab function)

- [ ] **Step 1: Reorder tab buttons and add new "Müssen zahlen" button**

Replace the entire `<div class="tab-nav">` block (currently lines 491–504) with this new order — Abrechnungen, CSV Upload, Müssen zahlen, Rechnungen:

```html
<div class="tab-nav">
    <button class="tab-btn active" onclick="switchTab('abrechnungen')" id="tabAbrechnungen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
        Abrechnungen
    </button>
    <button class="tab-btn" onclick="switchTab('abrbot')" id="tabAbrBot">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        CSV Upload
    </button>
    <button class="tab-btn" onclick="switchTab('muessenzahlen')" id="tabMuessenZahlen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        Müssen zahlen
    </button>
    <button class="tab-btn" onclick="switchTab('rechnungen')" id="tabRechnungen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Rechnungen
    </button>
</div>
```

- [ ] **Step 2: Add empty content container for new tab**

Locate the closing `</div>` of `<div class="tab-content" id="contentAbrBot">` (around line 702 — find it by searching for `contentAbrBot`). Immediately **after** that closing `</div>` (and before `<div class="tab-content" id="contentRechnungen">`), add:

```html
<div class="tab-content" id="contentMuessenZahlen">
    <div id="mzPlaceholder" style="padding:40px;text-align:center;color:var(--text-muted)">
        Müssen-zahlen Tab — wird in nächsten Schritten gefüllt.
    </div>
</div>
```

- [ ] **Step 3: Extend switchTab() function**

In the `switchTab` function (around line 959), add a new `else if` branch for `muessenzahlen`. Replace the entire function with:

```javascript
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    if (tab === 'rechnungen') {
        document.getElementById('tabRechnungen').classList.add('active');
        document.getElementById('contentRechnungen').classList.add('active');
        if (!reInitialized) { initInvoiceForm(); reInitialized = true; }
    } else if (tab === 'abrbot') {
        document.getElementById('tabAbrBot').classList.add('active');
        document.getElementById('contentAbrBot').classList.add('active');
        initAbrBot();
    } else if (tab === 'muessenzahlen') {
        document.getElementById('tabMuessenZahlen').classList.add('active');
        document.getElementById('contentMuessenZahlen').classList.add('active');
        initMuessenZahlen();
    } else {
        document.getElementById('tabAbrechnungen').classList.add('active');
        document.getElementById('contentAbrechnungen').classList.add('active');
    }
    localStorage.setItem('hydralink_tab', tab);
}
```

- [ ] **Step 4: Add stub `initMuessenZahlen()` function**

Find the line `function switchTab(tab) {` and insert this stub **immediately before** it:

```javascript
let mzInitialized = false;
function initMuessenZahlen() {
    if (mzInitialized) return;
    mzInitialized = true;
    // populated in Task 3+
    console.log('initMuessenZahlen called');
}
```

- [ ] **Step 5: Smoke-test in browser**

Open `dashboard.html` locally (or `python3 -m http.server 8000` and visit `localhost:8000/dashboard.html`). Login as Boyko / 1607. Verify:
1. Tab order is: Abrechnungen | CSV Upload | Müssen zahlen | Rechnungen
2. Click "Müssen zahlen" → placeholder text shows, `initMuessenZahlen called` appears in browser console
3. Click each other tab → still works as before
4. Reload page → last tab restored from localStorage

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "ui: add Müssen-zahlen tab placeholder + reorder tabs"
```

---

## Task 3: Load `kassier_zahlungen` data into memory

**Files:**
- Modify: `dashboard.html` — extend `loadData()` (line ~862), add `KASSIER` global

- [ ] **Step 1: Add `KASSIER` global variable**

Find the line `let NAME_ALIASES = {};` (around line 854). Immediately after it, add:

```javascript
        let KASSIER = []; // all rows from kassier_zahlungen
```

- [ ] **Step 2: Extend loadData() to also fetch kassier_zahlungen**

In the `loadData()` function, find this line:
```javascript
const [settleRes, aliasRes, fahrerRes] = await Promise.all([ client.from('settlements').select('*'), client.from('name_aliases').select('csv_name,fahrer_name'), client.from('fahrer').select('name,mietmodell,basis_miete,prozent_satz,prozent_schwelle,telefon').eq('aktiv', true) ]);
```

Replace it with (adds a fourth fetch):
```javascript
const [settleRes, aliasRes, fahrerRes, kassierRes] = await Promise.all([ client.from('settlements').select('*'), client.from('name_aliases').select('csv_name,fahrer_name'), client.from('fahrer').select('name,mietmodell,basis_miete,prozent_satz,prozent_schwelle,telefon').eq('aktiv', true), client.from('kassier_zahlungen').select('*') ]);
```

Then find the line `WEEKS = [...new Set(SETTLEMENTS.map(s => s.woche).filter(w => w))].sort().reverse();` and **immediately before** that line, add:

```javascript
                    KASSIER = (!kassierRes.error && kassierRes.data) ? kassierRes.data : [];
                    if (kassierRes.error) console.warn('kassier load error:', kassierRes.error);
```

- [ ] **Step 3: Add helper `getOpenDebts()` that aggregates settlements + kassier**

Find the line `function getSupabase() {` (around line 856). Immediately **before** it, add:

```javascript
        /* === MÜSSEN-ZAHLEN HELPERS === */
        // Returns array of debts: {fahrer_name, woche, schuld, kassiert, offen, status, payments, lastPaymentAt}
        // schuld = abs(auszahlung) for negative-payout settlements
        // status: 'offen' (no payments) | 'teilweise' (0 < paid < debt) | 'erledigt' (paid >= debt)
        function getOpenDebts() {
            const debts = SETTLEMENTS
                .filter(s => s.fahrer_name && s.fahrer_name !== '__TRANSFER__' && (s.auszahlung || 0) < 0)
                .map(s => {
                    const schuld = Math.abs(s.auszahlung || 0);
                    const payments = KASSIER.filter(k => k.fahrer_name === s.fahrer_name && k.woche === s.woche);
                    const kassiert = payments.reduce((sum, p) => sum + (parseFloat(p.betrag) || 0), 0);
                    const offen = Math.max(0, schuld - kassiert);
                    let status;
                    if (kassiert <= 0) status = 'offen';
                    else if (kassiert >= schuld) status = 'erledigt';
                    else status = 'teilweise';
                    const lastPaymentAt = payments.length
                        ? payments.map(p => p.kassiert_at).sort().reverse()[0]
                        : null;
                    return {
                        fahrer_name: s.fahrer_name,
                        woche: s.woche,
                        telefon: s.telefon || '',
                        schuld, kassiert, offen, status,
                        payments, lastPaymentAt
                    };
                });
            return debts;
        }
```

- [ ] **Step 4: Make stub `initMuessenZahlen()` log debt summary**

Replace the stub body from Task 2 step 4:

```javascript
let mzInitialized = false;
function initMuessenZahlen() {
    if (mzInitialized) return;
    mzInitialized = true;
    const debts = getOpenDebts();
    console.log('Debts loaded:', debts.length, debts);
    document.getElementById('mzPlaceholder').textContent =
        debts.length + ' Schulden gefunden (siehe console). Rendering kommt in Task 4.';
}
```

- [ ] **Step 5: Smoke-test**

Reload dashboard, login. Click "Müssen zahlen". Verify:
1. Placeholder shows `<N> Schulden gefunden (siehe console). Rendering kommt in Task 4.`
2. Browser console shows array of debt objects with correct `schuld`, `kassiert=0`, `offen=schuld`, `status='offen'` for any current week with negative settlements
3. Manually insert a test payment via SQL Editor:
   ```sql
   INSERT INTO kassier_zahlungen (fahrer_name, woche, betrag, typ, kassiert_von)
   SELECT fahrer_name, woche, ABS(auszahlung)/2, 'bar', 'Boyko'
   FROM settlements WHERE auszahlung < 0 LIMIT 1 RETURNING *;
   ```
   Reload dashboard, open "Müssen zahlen" tab. Verify one debt now shows `kassiert > 0` and `status='teilweise'` in console. Then clean up:
   ```sql
   DELETE FROM kassier_zahlungen WHERE kassiert_von = 'Boyko' AND note IS NULL AND betrag < ABS((SELECT auszahlung FROM settlements WHERE settlements.fahrer_name = kassier_zahlungen.fahrer_name AND settlements.woche = kassier_zahlungen.woche));
   ```
   (Or simpler: note the IDs and DELETE WHERE id IN (...).)

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: load kassier_zahlungen and compute open debts"
```

---

## Task 4: Render Müssen-zahlen table (no filters, no modal yet)

**Files:**
- Modify: `dashboard.html` — replace `mzPlaceholder` div with real table structure, expand `initMuessenZahlen()`

- [ ] **Step 1: Add CSS for status badges**

Find the CSS block — look for `.status.ok` (around line 165 area). After the existing `.status` rules, add:

```css
        .mz-status { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .mz-status.offen { background: #fce8eb; color: #c4364a; }
        .mz-status.teilweise { background: #fff4d6; color: #8a5a00; }
        .mz-status.erledigt { background: #e8f5ee; color: #1a6b4a; }
        [data-theme="dark"] .mz-status.offen { background: rgba(196,54,74,0.18); color: #ff8a9a; }
        [data-theme="dark"] .mz-status.teilweise { background: rgba(138,90,0,0.22); color: #ffd76a; }
        [data-theme="dark"] .mz-status.erledigt { background: rgba(26,107,74,0.22); color: #6ee7a8; }
        .mz-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
        .mz-history { background: var(--bg-table-head); padding: 12px 16px; font-size: 12px; }
        .mz-history table { width: 100%; }
        .mz-history th, .mz-history td { padding: 6px 10px; font-size: 12px; text-align: left; }
        .mz-history th.right, .mz-history td.right { text-align: right; }
```

- [ ] **Step 2: Replace tab content with table scaffold**

Find the existing `<div class="tab-content" id="contentMuessenZahlen">` block (added in Task 2). Replace its entire inner contents with:

```html
<div class="tab-content" id="contentMuessenZahlen">
    <div class="mz-toolbar" id="mzToolbar">
        <!-- filters added in Task 5 -->
        <span id="mzSummary" style="color:var(--text-muted);font-size:13px">Lade...</span>
    </div>
    <div class="table-card">
        <div class="table-header">
            <h2>Müssen zahlen<span id="mzCount"></span></h2>
        </div>
        <table>
            <thead><tr>
                <th>Fahrer</th>
                <th>Woche</th>
                <th class="right">Schuld</th>
                <th class="right">Kassiert</th>
                <th class="right">Offen</th>
                <th>Status</th>
                <th>Letzte Zahlung</th>
                <th class="center">Aktion</th>
            </tr></thead>
            <tbody id="mzTableBody"></tbody>
        </table>
    </div>
</div>
```

- [ ] **Step 3: Add `renderMuessenZahlen()` function**

Locate the `getOpenDebts()` function (added in Task 3 step 3). Immediately after its closing brace, add:

```javascript
        function renderMuessenZahlen() {
            const debts = getOpenDebts();
            // default sort: offen → teilweise → erledigt; within each: newest woche first
            const statusOrder = { offen: 0, teilweise: 1, erledigt: 2 };
            debts.sort((a, b) => {
                const so = statusOrder[a.status] - statusOrder[b.status];
                if (so !== 0) return so;
                return (b.woche || '').localeCompare(a.woche || '');
            });
            document.getElementById('mzCount').textContent = ' (' + debts.length + ')';
            const offenCount = debts.filter(d => d.status === 'offen').length;
            const teilCount = debts.filter(d => d.status === 'teilweise').length;
            const erlCount = debts.filter(d => d.status === 'erledigt').length;
            const totalOffen = debts.reduce((s, d) => s + d.offen, 0);
            document.getElementById('mzSummary').textContent =
                offenCount + ' offen, ' + teilCount + ' teilweise, ' + erlCount + ' erledigt — gesamt offen: ' + fmt(totalOffen);
            const tbody = document.getElementById('mzTableBody');
            if (!debts.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty">Keine Schulden vorhanden</td></tr>';
                return;
            }
            tbody.innerHTML = debts.map(d => {
                const lastDate = d.lastPaymentAt
                    ? new Date(d.lastPaymentAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })
                    : '—';
                return '<tr>'
                    + '<td><div class="fahrer-name">' + esc(d.fahrer_name) + '</div><div class="fahrer-tel">' + esc(d.telefon || '-') + '</div></td>'
                    + '<td>' + esc(d.woche) + '</td>'
                    + '<td class="right"><span class="money neg">' + fmt(d.schuld) + '</span></td>'
                    + '<td class="right">' + fmt(d.kassiert) + '</td>'
                    + '<td class="right"><span class="money ' + (d.offen > 0 ? 'neg' : 'pos') + '">' + fmt(d.offen) + '</span></td>'
                    + '<td><span class="mz-status ' + d.status + '">' + d.status + '</span></td>'
                    + '<td>' + lastDate + '</td>'
                    + '<td class="center">—</td>'
                    + '</tr>';
            }).join('');
        }
```

- [ ] **Step 4: Wire renderer into `initMuessenZahlen()`**

Replace the body of `initMuessenZahlen()` again:

```javascript
let mzInitialized = false;
function initMuessenZahlen() {
    if (!mzInitialized) {
        mzInitialized = true;
        // initial event handlers added in Task 5
    }
    renderMuessenZahlen();
}
```

- [ ] **Step 5: Smoke-test**

Reload, login, click "Müssen zahlen". Verify:
1. Table renders with all debts (one row per `(fahrer_name, woche)` where `auszahlung < 0`)
2. Summary line shows correct totals
3. Status badges colored: red=offen, gold=teilweise, green=erledigt
4. With the test payment from Task 3 step 5 still inserted: one row shows `teilweise` status, kassiert > 0, offen < schuld
5. Switching tabs and back re-renders (no stale state)

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: render müssen-zahlen table with status and totals"
```

---

## Task 5: Add filters (status, search, week, old-erledigt toggle)

**Files:**
- Modify: `dashboard.html` — mz-toolbar HTML, renderMuessenZahlen() filter logic, event handlers

- [ ] **Step 1: Add filter state globals**

Find `let KASSIER = [];` (added in Task 3 step 1). After it, add:

```javascript
        let mzStatusFilter = 'alle'; // 'alle' | 'offen' | 'teilweise' | 'erledigt'
        let mzSearch = '';
        let mzWeek = '';
        let mzShowOldErledigt = false;
```

- [ ] **Step 2: Replace mz-toolbar HTML with filter controls**

Find `<div class="mz-toolbar" id="mzToolbar">` (Task 4 step 2). Replace the entire toolbar div with:

```html
<div class="mz-toolbar" id="mzToolbar">
    <div style="display:flex;gap:4px">
        <button class="filter-btn active" data-mz-status="alle">Alle</button>
        <button class="filter-btn" data-mz-status="offen">Offen</button>
        <button class="filter-btn" data-mz-status="teilweise">Teilweise</button>
        <button class="filter-btn" data-mz-status="erledigt">Erledigt</button>
    </div>
    <input type="text" id="mzSearchInput" placeholder="Fahrer suchen..." style="max-width:200px">
    <select id="mzWeekFilter"><option value="">Alle Wochen</option></select>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer">
        <input type="checkbox" id="mzShowOld"> Alte erledigte (>60 Tage) zeigen
    </label>
    <span id="mzSummary" style="color:var(--text-muted);font-size:13px;margin-left:auto">Lade...</span>
</div>
```

- [ ] **Step 3: Add 60-day cutoff helper**

Inside `getOpenDebts()`, the returned objects already have `lastPaymentAt`. Add this helper right before `function renderMuessenZahlen()`:

```javascript
        function isOldErledigt(debt) {
            if (debt.status !== 'erledigt' || !debt.lastPaymentAt) return false;
            const ageMs = Date.now() - new Date(debt.lastPaymentAt).getTime();
            return ageMs > 60 * 24 * 60 * 60 * 1000;
        }
```

- [ ] **Step 4: Apply filters in `renderMuessenZahlen()`**

Replace the entire `renderMuessenZahlen()` function with:

```javascript
        function renderMuessenZahlen() {
            let debts = getOpenDebts();
            // hide old erledigte unless toggle is on
            if (!mzShowOldErledigt) {
                debts = debts.filter(d => !isOldErledigt(d));
            }
            // status filter
            if (mzStatusFilter !== 'alle') {
                debts = debts.filter(d => d.status === mzStatusFilter);
            }
            // search filter
            if (mzSearch) {
                debts = debts.filter(d => (d.fahrer_name || '').toLowerCase().indexOf(mzSearch) >= 0);
            }
            // week filter
            if (mzWeek) {
                debts = debts.filter(d => d.woche === mzWeek);
            }
            // sort: offen → teilweise → erledigt; within group: newest woche first
            const statusOrder = { offen: 0, teilweise: 1, erledigt: 2 };
            debts.sort((a, b) => {
                const so = statusOrder[a.status] - statusOrder[b.status];
                if (so !== 0) return so;
                return (b.woche || '').localeCompare(a.woche || '');
            });
            document.getElementById('mzCount').textContent = ' (' + debts.length + ')';
            const offenCount = debts.filter(d => d.status === 'offen').length;
            const teilCount = debts.filter(d => d.status === 'teilweise').length;
            const erlCount = debts.filter(d => d.status === 'erledigt').length;
            const totalOffen = debts.reduce((s, d) => s + d.offen, 0);
            document.getElementById('mzSummary').textContent =
                offenCount + ' offen, ' + teilCount + ' teilweise, ' + erlCount + ' erledigt — gesamt offen: ' + fmt(totalOffen);
            const tbody = document.getElementById('mzTableBody');
            if (!debts.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty">Keine Eintraege</td></tr>';
                return;
            }
            tbody.innerHTML = debts.map(d => {
                const lastDate = d.lastPaymentAt
                    ? new Date(d.lastPaymentAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })
                    : '—';
                return '<tr>'
                    + '<td><div class="fahrer-name">' + esc(d.fahrer_name) + '</div><div class="fahrer-tel">' + esc(d.telefon || '-') + '</div></td>'
                    + '<td>' + esc(d.woche) + '</td>'
                    + '<td class="right"><span class="money neg">' + fmt(d.schuld) + '</span></td>'
                    + '<td class="right">' + fmt(d.kassiert) + '</td>'
                    + '<td class="right"><span class="money ' + (d.offen > 0 ? 'neg' : 'pos') + '">' + fmt(d.offen) + '</span></td>'
                    + '<td><span class="mz-status ' + d.status + '">' + d.status + '</span></td>'
                    + '<td>' + lastDate + '</td>'
                    + '<td class="center">—</td>'
                    + '</tr>';
            }).join('');
        }
```

- [ ] **Step 5: Wire filter event handlers in `initMuessenZahlen()`**

Replace `initMuessenZahlen()` with:

```javascript
let mzInitialized = false;
function initMuessenZahlen() {
    if (!mzInitialized) {
        mzInitialized = true;
        // status chips
        document.getElementById('mzToolbar').addEventListener('click', function(e) {
            const btn = e.target.closest('[data-mz-status]');
            if (!btn) return;
            mzStatusFilter = btn.dataset.mzStatus;
            document.querySelectorAll('[data-mz-status]').forEach(b => b.classList.toggle('active', b === btn));
            renderMuessenZahlen();
        });
        // search
        let mzSearchTimer = null;
        document.getElementById('mzSearchInput').addEventListener('input', function(e) {
            mzSearch = e.target.value.toLowerCase();
            clearTimeout(mzSearchTimer);
            mzSearchTimer = setTimeout(renderMuessenZahlen, 200);
        });
        // week dropdown — populate from existing WEEKS
        const weekSel = document.getElementById('mzWeekFilter');
        weekSel.innerHTML = '<option value="">Alle Wochen</option>' +
            WEEKS.map(w => '<option value="' + w + '">' + w + '</option>').join('');
        weekSel.addEventListener('change', function(e) {
            mzWeek = e.target.value;
            renderMuessenZahlen();
        });
        // old-erledigt toggle
        document.getElementById('mzShowOld').addEventListener('change', function(e) {
            mzShowOldErledigt = e.target.checked;
            renderMuessenZahlen();
        });
    }
    renderMuessenZahlen();
}
```

- [ ] **Step 6: Smoke-test**

Reload, login, click "Müssen zahlen". Verify:
1. Default view: "Alle" chip active, shows all debts (except old erledigte)
2. Click "Offen" → only `status=offen` rows
3. Click "Teilweise" → only teilweise (e.g. the test row from Task 3)
4. Click "Erledigt" → only erledigte
5. Type a partial fahrer name → list narrows (200ms debounce)
6. Pick a week from dropdown → only that week's debts
7. Tick "Alte erledigte zeigen" → if any old erledigte exist, they appear
8. Filters combine correctly (e.g. status=erledigt + search=foo)

- [ ] **Step 7: Commit**

```bash
git add dashboard.html
git commit -m "feat: add filters to müssen-zahlen tab (status, search, week, age-toggle)"
```

---

## Task 6: Add Kassier-eintragen modal (UI only, no submit yet)

**Files:**
- Modify: `dashboard.html` — add modal HTML, "Kassieren eintragen" button in table row

- [ ] **Step 1: Add modal HTML**

Find `<div class="print-overlay" id="aliasOverlay">` (around line 821). **Before** that line, add:

```html
<div class="print-overlay" id="mzModalOverlay">
    <div class="alias-modal-inner" style="max-width:480px">
        <h2 style="margin-bottom:8px;font-size:20px">Kassieren eintragen</h2>
        <p style="color:var(--text-secondary);margin-bottom:20px;font-size:14px">
            <span id="mzModalFahrer">—</span> · <span id="mzModalWoche">—</span> · offen: <strong id="mzModalOffen">—</strong>
        </p>
        <div style="display:flex;flex-direction:column;gap:14px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-secondary)">
                Betrag (€)
                <input type="number" id="mzModalBetrag" step="0.01" min="0.01" style="font-size:18px;padding:10px;font-family:'JetBrains Mono',monospace">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-secondary)">
                Typ
                <select id="mzModalTyp" style="font-size:14px;padding:10px">
                    <option value="bar">Bar</option>
                    <option value="ueberweisung">Überweisung</option>
                    <option value="verrechnet">Verrechnet mit Woche…</option>
                </select>
            </label>
            <label id="mzModalVerrechnetLabel" style="display:none;flex-direction:column;gap:4px;font-size:13px;color:var(--text-secondary)">
                Verrechnet mit Woche
                <select id="mzModalVerrechnetWoche" style="font-size:14px;padding:10px"></select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-secondary)">
                Notiz (optional)
                <input type="text" id="mzModalNote" maxlength="200" style="font-size:14px;padding:10px">
            </label>
            <div id="mzModalWarn" style="display:none;font-size:13px;color:#c4364a;padding:8px 12px;background:#fce8eb;border-radius:6px"></div>
            <div id="mzModalError" style="display:none;font-size:13px;color:#c4364a"></div>
        </div>
        <div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap">
            <button class="btn" id="mzModalSaveBtn" style="background:var(--green);color:#020617;border:none;">Speichern</button>
            <button class="btn" style="background:var(--bg-hover);color:var(--text);border:1px solid var(--border)" id="mzModalCancelBtn">Abbrechen</button>
        </div>
    </div>
</div>
```

- [ ] **Step 2: Replace `—` action cell with "Kassieren eintragen" button**

In `renderMuessenZahlen()`, change the last cell template from:
```javascript
                    + '<td class="center">—</td>'
```
to:
```javascript
                    + '<td class="center">' + (d.offen > 0 ? '<button class="btn-print" data-mz-kassier="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Kassieren eintragen">💰</button>' : '<span style="color:var(--text-muted)">✓</span>') + '</td>'
```

- [ ] **Step 3: Add `openKassierModal()` function**

Right after `isOldErledigt()` (added in Task 5 step 3), add:

```javascript
        function openKassierModal(fahrer, woche) {
            const debt = getOpenDebts().find(d => d.fahrer_name === fahrer && d.woche === woche);
            if (!debt) return;
            document.getElementById('mzModalFahrer').textContent = fahrer;
            document.getElementById('mzModalWoche').textContent = woche;
            document.getElementById('mzModalOffen').textContent = fmt(debt.offen);
            document.getElementById('mzModalBetrag').value = debt.offen.toFixed(2);
            document.getElementById('mzModalTyp').value = 'bar';
            document.getElementById('mzModalNote').value = '';
            document.getElementById('mzModalWarn').style.display = 'none';
            document.getElementById('mzModalError').style.display = 'none';
            document.getElementById('mzModalVerrechnetLabel').style.display = 'none';
            // populate verrechnet weeks (all known weeks except current)
            const vSel = document.getElementById('mzModalVerrechnetWoche');
            vSel.innerHTML = WEEKS.filter(w => w !== woche).map(w => '<option value="' + w + '">' + w + '</option>').join('');
            // store current target on modal for submit
            document.getElementById('mzModalOverlay').dataset.fahrer = fahrer;
            document.getElementById('mzModalOverlay').dataset.woche = woche;
            document.getElementById('mzModalOverlay').dataset.offen = debt.offen;
            document.getElementById('mzModalOverlay').classList.add('show');
            setTimeout(() => document.getElementById('mzModalBetrag').focus(), 50);
        }
        function closeKassierModal() {
            document.getElementById('mzModalOverlay').classList.remove('show');
        }
```

- [ ] **Step 4: Wire modal events**

Inside `initMuessenZahlen()`, after the `mzShowOld` change listener, add:

```javascript
        // table row "Kassieren eintragen" button
        document.getElementById('mzTableBody').addEventListener('click', function(e) {
            const btn = e.target.closest('[data-mz-kassier]');
            if (!btn) return;
            const [fahrer, woche] = btn.dataset.mzKassier.split('|');
            openKassierModal(fahrer, woche);
        });
        // type select toggles verrechnet-woche field + amount warning
        document.getElementById('mzModalTyp').addEventListener('change', function(e) {
            document.getElementById('mzModalVerrechnetLabel').style.display = e.target.value === 'verrechnet' ? 'flex' : 'none';
        });
        // amount > offen warning
        document.getElementById('mzModalBetrag').addEventListener('input', function(e) {
            const offen = parseFloat(document.getElementById('mzModalOverlay').dataset.offen) || 0;
            const v = parseFloat(e.target.value) || 0;
            const warn = document.getElementById('mzModalWarn');
            if (v > offen + 0.01) {
                warn.textContent = 'Betrag ist höher als offener Rest (' + fmt(offen) + '). Bitte Notiz hinterlassen.';
                warn.style.display = 'block';
            } else {
                warn.style.display = 'none';
            }
        });
        document.getElementById('mzModalCancelBtn').addEventListener('click', closeKassierModal);
        // save button wired in Task 7
```

- [ ] **Step 5: Smoke-test**

Reload, login, "Müssen zahlen" tab. For any row with `offen > 0`:
1. Click 💰 button → modal opens
2. Header shows fahrer · woche · offen
3. Betrag is pre-filled with the offen amount
4. Typ select shows "Bar" by default
5. Change Typ to "Verrechnet mit Woche…" → week dropdown appears
6. Change Typ back to "Bar" → week dropdown hides
7. Type a betrag larger than offen → red warning appears
8. Reduce betrag → warning disappears
9. Click "Abbrechen" → modal closes
10. Rows where `offen <= 0` show a ✓ instead of the button

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "ui: add kassieren-modal scaffold (open/close, validation only)"
```

---

## Task 7: Submit kassier — INSERT to Supabase

**Files:**
- Modify: `dashboard.html` — `submitKassier()` function + wire save button

- [ ] **Step 1: Add `submitKassier()` function**

Right after `closeKassierModal()` (added in Task 6 step 3), add:

```javascript
        async function submitKassier() {
            const overlay = document.getElementById('mzModalOverlay');
            const fahrer = overlay.dataset.fahrer;
            const woche = overlay.dataset.woche;
            const betrag = parseFloat(document.getElementById('mzModalBetrag').value);
            const typ = document.getElementById('mzModalTyp').value;
            const note = document.getElementById('mzModalNote').value.trim() || null;
            const verrechnetMitWoche = typ === 'verrechnet'
                ? document.getElementById('mzModalVerrechnetWoche').value
                : null;
            const errorEl = document.getElementById('mzModalError');
            errorEl.style.display = 'none';
            // validation
            if (!betrag || betrag <= 0) {
                errorEl.textContent = 'Betrag muss größer als 0 sein.';
                errorEl.style.display = 'block';
                return;
            }
            if (typ === 'verrechnet' && !verrechnetMitWoche) {
                errorEl.textContent = 'Bei Verrechnung bitte eine Woche auswählen.';
                errorEl.style.display = 'block';
                return;
            }
            const session = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
            if (!session || !session.name) {
                errorEl.textContent = 'Session abgelaufen. Bitte neu einloggen.';
                errorEl.style.display = 'block';
                return;
            }
            const saveBtn = document.getElementById('mzModalSaveBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Speichere...';
            try {
                const client = getSupabase();
                const { data, error } = await client.from('kassier_zahlungen').insert({
                    fahrer_name: fahrer,
                    woche: woche,
                    betrag: betrag,
                    typ: typ,
                    verrechnet_mit_woche: verrechnetMitWoche,
                    kassiert_von: session.name,
                    note: note
                }).select();
                if (error) throw error;
                // append to local cache so we don't need full reload
                if (data && data[0]) KASSIER.push(data[0]);
                closeKassierModal();
                renderMuessenZahlen();
            } catch (err) {
                console.error('Kassier insert error:', err);
                errorEl.textContent = 'Fehler beim Speichern: ' + (err.message || err);
                errorEl.style.display = 'block';
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Speichern';
            }
        }
```

- [ ] **Step 2: Wire save button**

Inside `initMuessenZahlen()`, replace the comment `// save button wired in Task 7` with:

```javascript
        document.getElementById('mzModalSaveBtn').addEventListener('click', submitKassier);
```

- [ ] **Step 3: Smoke-test — full kassieren flow**

Reload, login as Boyko, "Müssen zahlen" tab.

Pre-check: pick a debt row, note its `Schuld`, `Kassiert`, `Offen` values.

Test 3a — full cash payment:
1. Click 💰 on a row with `status=offen`
2. Leave betrag = full offen amount, typ = Bar
3. Note: "Test full payment"
4. Click Speichern
5. Modal closes, row updates: `Kassiert = Schuld`, `Offen = 0`, `Status = erledigt`, "Letzte Zahlung" shows today
6. Confirm in Supabase Editor: `SELECT * FROM kassier_zahlungen ORDER BY kassiert_at DESC LIMIT 1;` shows the row with `kassiert_von='Boyko'`

Test 3b — partial payment:
1. Click 💰 on another row with `status=offen`
2. Reduce betrag to half the offen amount, typ = Überweisung
3. Click Speichern
4. Row updates: status → teilweise, kassiert = half, offen = half

Test 3c — verrechnung:
1. Click 💰 on yet another row
2. Typ = "Verrechnet mit Woche…", pick a different week, betrag = full offen
3. Click Speichern
4. Row → erledigt

Test 3d — overpayment warning:
1. Click 💰 on a remaining offen row
2. Set betrag higher than offen → red warning shows
3. Click Speichern anyway (with a note) → succeeds, row becomes erledigt and `kassiert > schuld`

Test 3e — error handling:
1. Click 💰, clear betrag (empty) → click Speichern → red error "Betrag muss größer als 0 sein."
2. Set typ=verrechnet without picking a week (use console to clear it) → error appears

Cleanup after testing:
```sql
DELETE FROM kassier_zahlungen WHERE kassiert_von = 'Boyko' AND note LIKE 'Test%';
-- (or by id list)
```

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat: insert kassier_zahlungen with validation and session user"
```

---

## Task 8: Expandable history per debt row

**Files:**
- Modify: `dashboard.html` — add expandable row, history rendering

- [ ] **Step 1: Add history toggle button to action cell**

In `renderMuessenZahlen()`, change the action cell from:
```javascript
                    + '<td class="center">' + (d.offen > 0 ? '<button class="btn-print" data-mz-kassier="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Kassieren eintragen">💰</button>' : '<span style="color:var(--text-muted)">✓</span>') + '</td>'
```
to:
```javascript
                    + '<td class="center">'
                    + (d.offen > 0 ? '<button class="btn-print" data-mz-kassier="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Kassieren eintragen">💰</button>' : '<span style="color:var(--text-muted)">✓</span>')
                    + (d.payments.length ? ' <button class="btn-print" data-mz-history="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Historie zeigen">📜</button>' : '')
                    + '</td>'
                    + '</tr>'
                    + (d.payments.length ? '<tr class="mz-history-row" id="mzh_' + esc(d.fahrer_name).replace(/[^a-z0-9]/gi,'_') + '_' + esc(d.woche) + '" style="display:none"><td colspan="8" class="mz-history">' + renderHistoryHtml(d) + '</td></tr>' : ''
```

Then **remove the trailing `</tr>`** that was at the end of the original row template — because we now add it manually plus the optional history row. Final row template snippet should end with `+ '');` (the final close before `}).join('')`).

Specifically, the full corrected row template inside `.map(d => { ... })` should look like:
```javascript
                return '<tr>'
                    + '<td><div class="fahrer-name">' + esc(d.fahrer_name) + '</div><div class="fahrer-tel">' + esc(d.telefon || '-') + '</div></td>'
                    + '<td>' + esc(d.woche) + '</td>'
                    + '<td class="right"><span class="money neg">' + fmt(d.schuld) + '</span></td>'
                    + '<td class="right">' + fmt(d.kassiert) + '</td>'
                    + '<td class="right"><span class="money ' + (d.offen > 0 ? 'neg' : 'pos') + '">' + fmt(d.offen) + '</span></td>'
                    + '<td><span class="mz-status ' + d.status + '">' + d.status + '</span></td>'
                    + '<td>' + lastDate + '</td>'
                    + '<td class="center">'
                        + (d.offen > 0 ? '<button class="btn-print" data-mz-kassier="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Kassieren eintragen">💰</button>' : '<span style="color:var(--text-muted)">✓</span>')
                        + (d.payments.length ? ' <button class="btn-print" data-mz-history="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" title="Historie zeigen">📜</button>' : '')
                    + '</td>'
                    + '</tr>'
                    + (d.payments.length
                        ? '<tr class="mz-history-row" data-mz-history-row="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '" style="display:none"><td colspan="8" class="mz-history">' + renderHistoryHtml(d) + '</td></tr>'
                        : '');
```

- [ ] **Step 2: Add `renderHistoryHtml()` function**

Right before `function renderMuessenZahlen()`, add:

```javascript
        const TYP_LABEL = { bar: 'Bar', ueberweisung: 'Überweisung', verrechnet: 'Verrechnet' };
        function renderHistoryHtml(debt) {
            const session = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
            const isAdmin = session && session.role === 'admin';
            const rows = [...debt.payments].sort((a, b) =>
                (b.kassiert_at || '').localeCompare(a.kassiert_at || '')
            ).map(p => {
                const dt = p.kassiert_at
                    ? new Date(p.kassiert_at).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : '—';
                const typLabel = (TYP_LABEL[p.typ] || p.typ) + (p.typ === 'verrechnet' && p.verrechnet_mit_woche ? ' (' + esc(p.verrechnet_mit_woche) + ')' : '');
                const noteHtml = p.note ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + esc(p.note) + '</div>' : '';
                const delBtn = isAdmin
                    ? '<button class="btn-print" data-mz-delete="' + esc(p.id) + '" title="Löschen" style="color:#c4364a">🗑</button>'
                    : '';
                return '<tr>'
                    + '<td class="right" style="font-family:monospace;font-weight:600">' + fmt(p.betrag) + '</td>'
                    + '<td>' + typLabel + '</td>'
                    + '<td>' + esc(p.kassiert_von || '—') + '</td>'
                    + '<td>' + dt + noteHtml + '</td>'
                    + '<td class="center">' + delBtn + '</td>'
                    + '</tr>';
            }).join('');
            return '<table><thead><tr><th class="right">Betrag</th><th>Typ</th><th>Wer</th><th>Wann / Notiz</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
        }
```

- [ ] **Step 3: Wire history-toggle event handler**

Inside `initMuessenZahlen()`, extend the existing `mzTableBody` click handler so it handles both kassier and history buttons:

```javascript
        document.getElementById('mzTableBody').addEventListener('click', function(e) {
            const kBtn = e.target.closest('[data-mz-kassier]');
            if (kBtn) {
                const [fahrer, woche] = kBtn.dataset.mzKassier.split('|');
                openKassierModal(fahrer, woche);
                return;
            }
            const hBtn = e.target.closest('[data-mz-history]');
            if (hBtn) {
                const key = hBtn.dataset.mzHistory;
                const row = document.querySelector('[data-mz-history-row="' + key.replace(/"/g, '\\"') + '"]');
                if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
                return;
            }
        });
```

(Replace the simpler existing handler from Task 6 step 4.)

- [ ] **Step 4: Smoke-test**

Reload, login. Use SQL Editor to insert 2-3 test payments for one driver/week:
```sql
INSERT INTO kassier_zahlungen (fahrer_name, woche, betrag, typ, kassiert_von, note)
SELECT fahrer_name, woche, 20.00, 'bar', 'Bislan', 'Test rate 1' FROM settlements WHERE auszahlung < 0 LIMIT 1;
INSERT INTO kassier_zahlungen (fahrer_name, woche, betrag, typ, kassiert_von, note)
SELECT fahrer_name, woche, 30.00, 'ueberweisung', 'Musa', 'Test rate 2' FROM settlements WHERE auszahlung < 0 LIMIT 1;
```

Reload dashboard, Müssen-zahlen tab:
1. Row with payments shows the 📜 history button next to 💰
2. Click 📜 → history table appears below the row showing 2+ entries, newest first
3. Each entry shows: Betrag, Typ, Wer (Bislan/Musa), Wann + Notiz
4. Click 📜 again → history hides
5. As Bislan (non-admin): no 🗑 buttons in history
6. As Boyko (admin): 🗑 buttons visible (action wired in Task 9)

Cleanup test rows.

- [ ] **Step 5: Commit**

```bash
git add dashboard.html
git commit -m "feat: expandable payment history per debt with role-aware delete button"
```

---

## Task 9: Admin-only delete of a payment

**Files:**
- Modify: `dashboard.html` — `deleteKassier()` function + event wiring

- [ ] **Step 1: Add `deleteKassier()` function**

Right after `submitKassier()` (Task 7 step 1), add:

```javascript
        async function deleteKassier(id) {
            const session = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
            if (!session || session.role !== 'admin') {
                alert('Nur Admin darf Zahlungen löschen.');
                return;
            }
            if (!confirm('Diese Zahlung wirklich löschen? Aktion kann nicht rückgängig gemacht werden.')) return;
            try {
                const client = getSupabase();
                const { error } = await client.from('kassier_zahlungen').delete().eq('id', id);
                if (error) throw error;
                KASSIER = KASSIER.filter(k => k.id !== id);
                renderMuessenZahlen();
            } catch (err) {
                console.error('Kassier delete error:', err);
                alert('Fehler beim Löschen: ' + (err.message || err));
            }
        }
```

- [ ] **Step 2: Wire delete button click**

Extend the `mzTableBody` click handler inside `initMuessenZahlen()` to also handle delete clicks. The handler must check **history rows too** — those are inside `<tbody>` already, so the existing listener captures them. Replace the handler body with:

```javascript
        document.getElementById('mzTableBody').addEventListener('click', function(e) {
            const kBtn = e.target.closest('[data-mz-kassier]');
            if (kBtn) {
                const [fahrer, woche] = kBtn.dataset.mzKassier.split('|');
                openKassierModal(fahrer, woche);
                return;
            }
            const hBtn = e.target.closest('[data-mz-history]');
            if (hBtn) {
                const key = hBtn.dataset.mzHistory;
                const row = document.querySelector('[data-mz-history-row="' + key.replace(/"/g, '\\"') + '"]');
                if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
                return;
            }
            const dBtn = e.target.closest('[data-mz-delete]');
            if (dBtn) {
                deleteKassier(dBtn.dataset.mzDelete);
                return;
            }
        });
```

- [ ] **Step 3: Smoke-test**

Pre-condition: have at least one test payment in `kassier_zahlungen`.

Test as Boyko (admin):
1. Open Müssen-zahlen tab, expand history of a row with payments
2. Click 🗑 next to a payment → confirm dialog appears
3. Click "Cancel" → nothing happens
4. Click 🗑 again, confirm → payment disappears from history, row updates (offen recalculated, status may change back to teilweise/offen)
5. Verify in Supabase: row gone

Test as Bislan (non-admin):
1. Logout, login as Bislan / 1607
2. Open Müssen-zahlen tab, expand history
3. No 🗑 buttons visible
4. (Belt-and-suspenders) In console run `deleteKassier('<some-id>')` → alert "Nur Admin..."

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat: admin-only delete of kassier_zahlungen with confirm dialog"
```

---

## Task 10: Update CLAUDE.md and final integration smoke-test

**Files:**
- Modify: `CLAUDE.md` lines 29–35 (dashboard tabs), line 38 (key tables list)

- [ ] **Step 1: Update tab list in CLAUDE.md**

Open `CLAUDE.md`. Replace the section starting at "The dashboard (`dashboard.html`) has 3 tabs:" through the AbrBot bullet with:

```markdown
The dashboard (`dashboard.html`) has 4 tabs:

1. **Abrechnungen** — Driver settlement overview per week. Filters by week/driver/status. Shows earnings, deductions, payout per driver. Print/share individual settlements via WhatsApp.
2. **CSV Upload** (AbrBot) — Upload Bolt/Uber/MyPOS CSVs per week. Triggers n8n webhook for processing.
3. **Müssen zahlen** — Cross-week view of all driver debts (where `settlements.auszahlung < 0`). Users record collected payments (cash/transfer/offset) into `kassier_zahlungen`; "offen" amount is computed live as `abs(auszahlung) − Σ payments`. Existing settlement calculation is never touched. Admin (role=admin) can delete payment entries. Erledigte debts older than 60 days are hidden by default.
4. **Rechnungen** — Invoice creation and archive. Company cards, line items, VAT handling, sequential auto-numbering (HF-YYYY-NNNN). PDF storage in Supabase.
```

- [ ] **Step 2: Add kassier_zahlungen to key tables list**

In CLAUDE.md, find the "Key Supabase Tables" section. After the `customers` line, add:
```markdown
- `kassier_zahlungen` — Collected-payment log per driver debt (fahrer_name + woche → many payments). Append + delete only; no update.
```

- [ ] **Step 3: Full integration smoke-test**

This is the regression check: confirm no existing feature broke.

Pre-condition: clean state (no test rows in `kassier_zahlungen`).

Run through:
1. **Login flow**: logout, login as Boyko, dashboard loads ✓
2. **Abrechnungen tab**: weekly filter works, "Müssen zahlen" *button-filter* still works (toggles negative-payout rows for current week only), "Alle drucken" works, Export works
3. **CSV Upload tab**: opens, file picker shows (don't actually upload)
4. **Müssen zahlen tab**: shows all debts cross-week, filters work, default hides old erledigte
5. **Rechnungen tab**: opens, archive lists invoices
6. **Korrektur tool** (`korrektur-kw16.html`): still loads independently (separate page)
7. **Logout → login as Bislan** → no admin features visible in Müssen-zahlen history
8. **End-to-end**: as Boyko, kassieren eintragen (cash, full amount) on one row → status erledigt → expand history → see entry "Boyko" → delete → status reverts → row disappears from list (no payments + no schuld_change). Actually wait: status reverts to `offen` and offen=schuld again. Good.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Müssen-zahlen tab and kassier_zahlungen table"
```

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feature/muessen-zahlen-tab
gh pr create --title "Müssen-zahlen tab: collect & track driver debts" --body "$(cat <<'EOF'
## Summary
- New tab "Müssen zahlen" between CSV Upload and Rechnungen
- New table `kassier_zahlungen` (append + admin-delete only)
- Cross-week debt list with status filter (offen/teilweise/erledigt)
- Modal to record payments: Bar / Überweisung / Verrechnet mit Woche
- Expandable per-row history; admin can delete entries
- Erledigte debts >60 days hidden by default (toggle to show)
- **Existing settlement calculation is NOT touched** — "offen" is computed at render time

## Migration
`migrations/2026-05-22-add-kassier-zahlungen.sql` — must be run in Supabase SQL Editor before merge

## Test plan
- [ ] DB migration ran cleanly in Supabase
- [ ] Login as Boyko / Bislan / Musa works
- [ ] Tab order: Abrechnungen | CSV Upload | Müssen zahlen | Rechnungen
- [ ] Old "Müssen zahlen" filter button in Abrechnungen tab still works
- [ ] Kassieren eintragen: Bar, Überweisung, Verrechnung
- [ ] Status changes correctly: offen → teilweise → erledigt
- [ ] Non-admin sees no delete button
- [ ] Admin can delete; row recomputes
- [ ] 60-day cutoff: old erledigte hidden by default, toggle reveals them
- [ ] CSV Upload + Rechnungen + Korrektur tool unaffected

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (writer's pass)

- **Spec coverage:** Each spec requirement maps to a task — data model (Task 1), tab placement & order (Task 2), debt aggregation (Task 3), table rendering (Task 4), filters incl. 60-day cutoff (Task 5), modal incl. amount-override warning (Task 6), submit with session user (Task 7), expandable history (Task 8), admin delete (Task 9), docs (Task 10).
- **Calculation isolation:** No task writes to `settlements.auszahlung` or `korrektur` — verified by re-reading each insert/update statement. Only `kassier_zahlungen` is mutated.
- **Backwards compatibility:** Old Abrechnungen-tab "Müssen zahlen" filter button is explicitly preserved (Task 10 smoke-test).
- **Type/name consistency:** Globals `KASSIER`, `mzStatusFilter`, `mzSearch`, `mzWeek`, `mzShowOldErledigt`; helpers `getOpenDebts`, `isOldErledigt`, `renderHistoryHtml`; user-facing `renderMuessenZahlen`, `initMuessenZahlen`, `openKassierModal`, `closeKassierModal`, `submitKassier`, `deleteKassier`. All used consistently across tasks.
- **Test approach adapted:** No automated tests in repo → each task ends with a defined manual smoke-test scenario before commit.
