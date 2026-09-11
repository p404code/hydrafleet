# HYDRAlink Redesign v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neues, ruhiges und mobil-taugliches Dashboard als `dashboard-neu.html` neben der alten Datei, mit identischer Funktionsweise.

**Architecture:** `dashboard-neu.html` ist eine Kopie von `dashboard.html` (main, Commit `62c514e`). Die Logik-Funktionen (Laden, Berechnen, Speichern, Drucken, Rechnungen, Upload) bleiben unverändert. Geändert werden: der `<style>`-Block (neue Tokens, Shell, Tabellen), das Markup der Kopfleiste/Navigation und der Tabs Abrechnung und Kassieren, sowie die drei Render-Funktionen `getData`, `render`, `renderMuessenZahlen` plus kleine Helfer. Das Kassieren-Formular behält seine Element-IDs und wird per DOM-Move in die aufgeklappte Zeile bzw. das Seitenpanel verschoben, damit `submitKassier` unverändert bleibt.

**Tech Stack:** Vanilla HTML/CSS/JS in einer Datei, Supabase-JS per CDN, kein Build. Tests: `node --check` auf dem extrahierten Script plus manuelle Browser-Prüfung über `python3 -m http.server`.

**Spec:** `docs/superpowers/specs/2026-09-10-hydralink-redesign-design.md`

## Global Constraints

- Funktionsweise 1:1: keine Änderung an Berechnung, Supabase-Aufrufen, `saveLohn`, `submitKassier`, `deleteKassier`, `printDriver`, `printAllDrivers`, `shareAsImage`, `exportCSV`, Alias-Logik, `LOHN_EDITORS`, Session-Guard, Rechnungs- und Upload-Logik.
- Eine HTML-Datei, kein Build, kein Framework.
- Alte `dashboard.html` bleibt unangetastet bis zum Go-live-Task.
- Breakpoint 768px. Handy: Bottom-Nav, aufklappbare Zeilen. Desktop: Top-Nav, Seitenpanel.
- Kleinste Zielbreite 320px: keine Abschneidungen, keine horizontalen Scrollbalken.
- Hell ist Standard, Dunkel per Schalter (`data-theme="dark"` auf `<html>`, `localStorage.theme`).
- Zahlen in Monospace mit `font-variant-numeric: tabular-nums`. Auszahlung 2 Dezimalen, MyPOS/Lohn/Pauschale ganze Euro in der Tabelle.
- Branch: `redesign/hydralink-v2`. Nach jedem Task committen.

---

### Task 0: Arbeitskopie und Syntax-Check

**Files:**
- Create: `dashboard-neu.html` (Kopie von `dashboard.html`)
- Create: `scripts/check-dashboard.sh`

**Interfaces:**
- Produces: `scripts/check-dashboard.sh <file>` beendet mit Exit 0, wenn alle Inline-Scripts syntaktisch gültig sind und alle IDs, die im JS per `getElementById('...')` angesprochen werden, im Markup vorkommen.

- [ ] **Step 1: Kopie anlegen**

```bash
cd /Users/pepe/Projects/hydrafleet
cp dashboard.html dashboard-neu.html
```

- [ ] **Step 2: Check-Script schreiben**

```bash
mkdir -p scripts
cat > scripts/check-dashboard.sh <<'EOF'
#!/usr/bin/env bash
# Prüft eine Dashboard-Datei: (1) node --check auf jedem Inline-Script,
# (2) jede ID aus getElementById('…') muss im Markup als id="…" existieren.
set -euo pipefail
FILE="${1:-dashboard-neu.html}"
TMP="$(mktemp -d)"
python3 - "$FILE" "$TMP" <<'PY'
import re, sys, pathlib
html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
for i, s in enumerate(scripts):
    pathlib.Path(sys.argv[2], f"s{i}.js").write_text(s, encoding="utf-8")
ids_used = set(re.findall(r"getElementById\(\s*'([^']+)'\s*\)", html))
ids_def = set(re.findall(r'\bid="([^"]+)"', html))
missing = sorted(i for i in ids_used if i not in ids_def)
if missing:
    print("FEHLENDE IDs im Markup:", ", ".join(missing))
    sys.exit(1)
print(f"{len(scripts)} Inline-Scripts extrahiert, {len(ids_used)} IDs geprüft")
PY
for f in "$TMP"/*.js; do node --check "$f"; done
echo "OK: $FILE"
EOF
chmod +x scripts/check-dashboard.sh
```

- [ ] **Step 3: Check auf der Kopie laufen lassen**

Run: `scripts/check-dashboard.sh dashboard-neu.html`
Expected: `OK: dashboard-neu.html` (Exit 0). Falls IDs als fehlend gemeldet werden, die nur dynamisch erzeugt werden, diese im Script in eine Ausnahmeliste aufnehmen und den Grund als Kommentar notieren.

- [ ] **Step 4: Commit**

```bash
git add dashboard-neu.html scripts/check-dashboard.sh
git commit -m "chore: dashboard-neu.html als Arbeitskopie + Syntax/ID-Check"
```

---

### Task 1: Tokens, Shell und Navigation

**Files:**
- Modify: `dashboard-neu.html` — `<style>`-Block (Tokens `:root` und `[data-theme="dark"]`, Selektoren `body`, `.container`, `.header*`, `.tab-nav`, `.tab-btn`, `.tab-content`, `.filters`, `select`, `input[type="text"]`, `.filter-btn`, `.stats`, `.stat-*`, `.control-*`, `.table-card`, `.table-header`, `table`, `th`, `td`, `.money`, `.status`, `.badge`, `.btn`, `.btn-print`, `.btn-exclude`, `.fahrer-*`, `.alias-banner`, `.excluded-panel`, alle `@media (max-width: 768px)`-Blöcke)
- Modify: `dashboard-neu.html` — Markup `<header class="header">` und `<div class="tab-nav">`
- Modify: `dashboard-neu.html` — `initTheme()`

**Interfaces:**
- Produces: CSS-Klassen, die spätere Tasks nutzen: `.chip`, `.chip.active`, `.chip.lohn`, `.toolbar`, `.hero`, `.hero-big`, `.kpi`, `.kpi-item`, `.data-table`, `.num`, `.zero`, `.neg`, `.pos`, `.dot`, `.dot.neg`, `.detail-row`, `.detail`, `.detail-kv`, `.detail-sec`, `.detail-acts`, `.side-panel`, `.split`, `.split-main`, `.pill`, `.pill.offen|.teilweise|.erledigt`, `.group-row`, `.form-card`, `.seg`, `.seg-btn.active`, `.btn-primary`, `.btn-ghost`, `.hidden`.

- [ ] **Step 1: Token-Block ersetzen**

Im `<style>` den gesamten `:root { … }`- und `[data-theme="dark"] { … }`-Block ersetzen durch:

```css
:root {
    --bg:#FBFBFC; --surface:#FFFFFF; --surface-2:#F1F3F5; --surface-3:#E6E8EB;
    --border:#E6E8EB; --border-strong:#CFD4DA;
    --text:#101418; --text-mut:#6B7280; --text-dim:#B0B6BF;
    --accent:#0B6B4F; --accent-ink:#FFFFFF;
    --accent-faint:rgba(11,107,79,.08); --accent-line:rgba(11,107,79,.35);
    --warn:#B45309; --err:#B42318; --info:#1D4ED8;
    --mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,monospace;
    --sans:-apple-system,"Inter","Segoe UI",system-ui,sans-serif;
    --nav-h:46px; --bottom-nav-h:54px; --panel-w:330px;
    /* Legacy-Aliase, damit unveränderte Bereiche (Rechnungen, Upload, Print, Alias) weiter funktionieren */
    --bg-card:var(--surface); --bg-hover:var(--surface-2); --bg-table-head:var(--surface);
    --border-light:var(--border);
    --text-secondary:var(--text-mut); --text-muted:var(--text-dim);
    --gold:var(--accent); --gold-glow:var(--accent-faint);
    --blue:var(--info); --green:var(--accent); --orange:var(--warn); --red:var(--err);
    --badge-fix-bg:var(--surface-2); --badge-fix:var(--text-mut);
    --badge-f11-bg:var(--surface-2); --badge-f11:var(--text-mut);
    --badge-f12-bg:var(--surface-2); --badge-f12:var(--text-mut);
    --badge-unknown-bg:var(--surface-2); --badge-unknown:var(--text-dim);
    --status-ok-bg:var(--accent-faint); --status-ok:var(--accent);
    --status-warn-bg:color-mix(in srgb,var(--warn) 12%,transparent); --status-warn:var(--warn);
    --status-err-bg:color-mix(in srgb,var(--err) 12%,transparent); --status-err:var(--err);
    --warning-row:color-mix(in srgb,var(--warn) 6%,var(--surface)); --warning-row-hover:color-mix(in srgb,var(--warn) 11%,var(--surface));
    --card-shadow:none; --card-shadow-hover:none;
}
[data-theme="dark"] {
    --bg:#0F1115; --surface:#15181D; --surface-2:#1A1E24; --surface-3:#20252C;
    --border:#23272F; --border-strong:#323843;
    --text:#EDEEF0; --text-mut:#989FA7; --text-dim:#5F666E;
    --accent:#3ECF8E; --accent-ink:#062D1C;
    --accent-faint:rgba(62,207,142,.08); --accent-line:rgba(62,207,142,.35);
    --warn:#E5B454; --err:#F0555D; --info:#7AA2F7;
}
```

- [ ] **Step 2: Shell- und Navigations-CSS ersetzen**

Die bestehenden Regeln für `body`, `.container`, `.header`, `.header-left`, `.header-logo`, `.header-text*`, `.typewriter-cursor`, `@keyframes blink`, `.header-actions*`, `.tab-nav`, `.tab-btn*`, `.tab-content*` löschen und stattdessen einfügen:

```css
body { font-family: var(--sans); background: var(--bg); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; font-size: 13px; line-height: 1.4; }
.container { max-width: 1320px; margin: 0 auto; padding: 0 0 48px; }
.hidden { display: none !important; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
/* Kopfleiste (Desktop) */
.header { position: sticky; top: 0; z-index: 50; height: var(--nav-h); display: flex; align-items: center; gap: 18px; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border); }
.header-left { display: flex; align-items: center; gap: 8px; }
.header-logo { display: none; }
.header-text h1 { font-size: 14px; font-weight: 800; letter-spacing: -.3px; margin: 0; }
.header-text h1 .hydra { color: var(--text); }
.header-text h1 .link { font-weight: 400; color: var(--text-mut); }
.typewriter-cursor { display: none; }
.header-text p { display: none; }
.header-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.header-actions button { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 5px 10px; font-size: 12px; color: var(--text-mut); cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: inherit; }
.header-actions button:hover { background: var(--surface-2); color: var(--text); }
.header-actions button svg { width: 14px; height: 14px; }
.header-actions .divider { display: none; }
.header-actions .btn-logout:hover { color: var(--err); }
/* Tabs: Desktop in der Kopfleiste, Handy als Leiste unten */
.tab-nav { display: flex; gap: 4px; }
.tab-btn { border: none; background: transparent; padding: 6px 12px; border-radius: 7px; font-size: 13px; font-weight: 500; color: var(--text-mut); cursor: pointer; display: flex; align-items: center; gap: 6px; font-family: inherit; }
.tab-btn svg { width: 15px; height: 15px; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { background: var(--surface-2); color: var(--text); font-weight: 600; }
.tab-content { display: none; }
.tab-content.active { display: block; animation: fadeIn .15s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 768px) {
    .container { padding-bottom: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom) + 16px); }
    .header { padding: 0 12px; }
    .tab-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; height: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: var(--surface); border-top: 1px solid var(--border); gap: 0; }
    .tab-btn { flex: 1; flex-direction: column; gap: 3px; padding: 6px 2px; border-radius: 0; font-size: 10.5px; }
    .tab-btn.active { background: transparent; color: var(--text); font-weight: 700; }
    .tab-btn svg { width: 18px; height: 18px; }
}
```

- [ ] **Step 3: Gemeinsame Bausteine ergänzen**

Direkt nach dem Block aus Step 2 einfügen (ersetzt die alten Regeln für `.filters`, `select`, `input[type="text"]`, `.filter-btn*`, `.stats`, `.stat-*`, `.control-*`, `.table-card`, `.table-header`, `table`, `th`, `td`, `.money`, `.status`, `.badge`, `.btn`, `.btn-print`, `.btn-exclude`, `.fahrer-*`, `.alias-banner`, `.excluded-panel*`, die gelöscht werden):

```css
/* Kopfbereich eines Tabs */
.hero { padding: 14px 20px 10px; background: var(--surface); border-bottom: 1px solid var(--border); }
.hero-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.hero-top .week-pick { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.hero-top .week-pick select { font-size: 18px; font-weight: 700; border: none; background: transparent; padding: 0; color: var(--text); font-family: inherit; cursor: pointer; }
.hero-top .week-range { color: var(--text-mut); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hero-big { text-align: right; }
.hero-big b { display: block; font-size: 30px; font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.6px; color: var(--accent); line-height: 1.1; }
.hero-big.err b { color: var(--err); }
.hero-big small { color: var(--text-mut); font-size: 11.5px; }
.kpi { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 10px; }
.kpi-item { background: var(--surface-2); border-radius: 8px; padding: 7px 10px; min-width: 0; }
.kpi-item small { display: block; font-size: 10px; color: var(--text-mut); text-transform: uppercase; letter-spacing: .04em; }
.kpi-item b { font-size: 14px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.kpi-item b.err { color: var(--err); }
.kpi-item b.ok { color: var(--accent); }
.kpi-item .konto { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; font-family: var(--mono); color: var(--text); }
/* Filterleiste */
.toolbar { position: sticky; top: var(--nav-h); z-index: 40; display: flex; gap: 6px; align-items: center; padding: 8px 20px; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.toolbar .sp { flex: 1; }
.search { flex: 0 0 240px; min-width: 0; height: 32px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); padding: 0 10px 0 30px; font-size: 13px; color: var(--text); font-family: inherit; outline: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238a8f98' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 9px center; }
.search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-faint); }
.chip { flex: none; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 11.5px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; white-space: nowrap; }
.chip:hover { background: var(--surface-2); }
.chip.active { background: var(--text); color: var(--bg); border-color: var(--text); }
.chip.lohn.active { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.chip.excluded.active { background: var(--err); border-color: var(--err); color: #fff; }
.chip .cnt { opacity: .7; }
select.chip { appearance: auto; }
.hint { padding: 6px 20px 0; font-size: 11.5px; color: var(--text-mut); }
.hint b { color: var(--accent); }
/* Tabelle */
.split { display: flex; align-items: flex-start; }
.split-main { flex: 1; min-width: 0; }
.data-table { width: 100%; border-collapse: collapse; background: var(--surface); table-layout: fixed; }
.data-table th { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); padding: 8px 8px; border-bottom: 1px solid var(--border); font-weight: 600; white-space: nowrap; overflow: hidden; cursor: pointer; user-select: none; }
.data-table th.sorted { color: var(--text); }
.data-table th:first-child, .data-table td:first-child { text-align: left; padding-left: 20px; }
.data-table th:last-child, .data-table td:last-child { padding-right: 20px; }
.data-table td { padding: 9px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-mut); font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 12.5px; }
.data-table td:first-child { font-family: var(--sans); font-weight: 500; color: var(--text); cursor: pointer; }
.data-table td.pay { font-weight: 700; color: var(--text); }
.data-table td.neg, .neg { color: var(--err) !important; }
.data-table td.zero { color: var(--text-dim); }
.data-table tr.selected td { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.data-table tr.warning td:first-child { color: var(--warn); }
.data-table td.empty { text-align: center; padding: 32px; color: var(--text-mut); font-family: var(--sans); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 7px; vertical-align: middle; }
.dot.neg { background: var(--err); }
.dot.warn { background: var(--warn); }
.fahrer-korr { display: inline-block; font-size: 10.5px; color: var(--text-mut); margin-left: 6px; }
.fahrer-korr.neg { color: var(--err); }
/* Detail: Zeile (Handy) oder Panel (Desktop) */
.detail-row td { white-space: normal; font-family: var(--sans); text-align: left; background: var(--surface-2); padding: 10px 20px 14px; cursor: default; }
.side-panel { width: var(--panel-w); flex: none; position: sticky; top: calc(var(--nav-h) + 49px); border-left: 1px solid var(--border); background: var(--surface); padding: 16px 18px; min-height: 300px; }
.side-panel .placeholder { color: var(--text-mut); font-size: 12.5px; padding-top: 40px; text-align: center; }
.detail h4 { margin: 0; font-size: 16px; }
.detail .sub { color: var(--text-mut); font-size: 11.5px; margin-bottom: 10px; }
.detail .pay { font-size: 24px; font-weight: 700; color: var(--accent); font-family: var(--mono); font-variant-numeric: tabular-nums; margin: 4px 0 10px; }
.detail .pay.neg { color: var(--err); }
.detail-sec { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); margin: 12px 0 4px; }
.detail-kv { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-bottom: 1px dotted var(--border); font-size: 12px; }
.detail-kv span:first-child { color: var(--text-mut); }
.detail-kv span:last-child { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.detail-kv.strong span:last-child { font-weight: 700; }
.detail-lohn { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--surface-2); border-radius: 8px; padding: 8px 10px; margin-top: 12px; font-size: 12px; }
.detail-row .detail-lohn { background: var(--surface); }
.detail-lohn input { width: 100px; height: 30px; border: 1px solid var(--border-strong); border-radius: 6px; text-align: right; padding: 0 8px; background: var(--surface); color: var(--text); font-family: var(--mono); font-size: 13px; }
.detail-acts { display: flex; gap: 6px; margin-top: 12px; }
.btn-primary, .btn-ghost { flex: 1; text-align: center; padding: 8px 10px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
.btn-primary { background: var(--text); color: var(--bg); }
.btn-primary.ok { background: var(--accent); color: var(--accent-ink); }
.btn-ghost { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
.btn-ghost.danger { color: var(--err); }
/* Kassieren */
.group-row td { background: var(--surface-2); color: var(--text-mut); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; padding: 5px 20px; font-family: var(--sans); text-align: left; cursor: default; }
.group-row td .num { float: right; }
.pill { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; font-family: var(--sans); font-weight: 600; }
.pill.offen { background: var(--status-err-bg); color: var(--err); }
.pill.teilweise { background: var(--status-warn-bg); color: var(--warn); }
.pill.erledigt { background: var(--status-ok-bg); color: var(--accent); }
.form-card { margin-top: 8px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px; }
.form-card label { display: block; font-size: 11.5px; color: var(--text-mut); margin-top: 8px; }
.form-card input, .form-card select { width: 100%; height: 36px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 10px; background: var(--surface); color: var(--text); font-family: inherit; font-size: 14px; box-sizing: border-box; }
.form-card input#mzModalBetrag { font-family: var(--mono); font-size: 18px; text-align: right; height: 40px; }
.form-card .warn-box { font-size: 12px; color: var(--err); background: var(--status-err-bg); border-radius: 6px; padding: 6px 10px; margin-top: 8px; }
.hist-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; padding: 4px 0; border-bottom: 1px dotted var(--border); }
.hist-row span:first-child { color: var(--text-mut); }
.hist-row .num { font-weight: 600; }
.hist-row button { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 12px; padding: 0 4px; }
.hist-row button:hover { color: var(--err); }
/* Banner, Excluded, allgemeine Buttons (unveränderte Handler) */
.btn { padding: 6px 10px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit; }
.btn:hover { background: var(--surface-2); }
.alias-banner { display: none; align-items: center; justify-content: space-between; gap: 10px; margin: 10px 20px 0; padding: 8px 12px; border-radius: 8px; background: var(--status-warn-bg); color: var(--warn); font-size: 12.5px; }
.excluded-panel { display: none; margin: 10px 20px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.excluded-panel.show { display: block; }
.excluded-panel h3 { font-size: 12px; margin: 0 0 6px; color: var(--text-mut); }
.excluded-list { display: flex; flex-wrap: wrap; gap: 6px; }
.excluded-item { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; background: var(--surface-2); font-size: 12px; }
.excluded-item button { border: none; background: none; color: var(--err); cursor: pointer; font-size: 13px; }
.money.pos { color: var(--accent); } .money.neg { color: var(--err); }
@media (max-width: 768px) {
    .hero { padding: 10px 12px 8px; }
    .hero-top { flex-direction: column; align-items: flex-start; gap: 4px; }
    .hero-big { text-align: left; }
    .hero-big b { font-size: 24px; }
    .kpi { grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
    .kpi-item.desktop-only { display: none; }
    .toolbar { padding: 8px 12px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    .toolbar::-webkit-scrollbar { display: none; }
    .search { flex: 1 1 120px; height: 34px; }
    .chip { height: 34px; }
    .toolbar .desktop-only, .side-panel { display: none; }
    .hint { padding: 6px 12px 0; }
    .data-table th:first-child, .data-table td:first-child { padding-left: 12px; }
    .data-table th:last-child, .data-table td:last-child { padding-right: 12px; }
    .data-table td { padding: 9px 3px; font-size: 12px; }
    .data-table th { padding: 6px 3px; letter-spacing: .03em; }
    .detail-row td { padding: 10px 12px 14px; }
    .group-row td { padding: 5px 12px; }
    .alias-banner, .excluded-panel { margin: 10px 12px 0; }
}
```

- [ ] **Step 4: Print-, Alias-, Rechnungs- und Upload-Regeln behalten**

Alle übrigen Selektoren (`.print-*`, `.alias-*`, `.re-*`, `.abr-*`, `.mz-modal-inner`, `.skeleton-*`, `.re-toast`, `@media print`, `button:focus-visible`) unverändert lassen. Nur den Selektor `button:focus-visible, .tab-btn:focus-visible, .filter-btn:focus-visible { … var(--gold) }` auf `… { outline: none; box-shadow: 0 0 0 2px var(--accent-line); }` ändern.

- [ ] **Step 5: Kopfleiste und Tabs im Markup umbauen**

Den Block `<header class="header"> … </header>` und `<div class="tab-nav"> … </div>` ersetzen durch:

```html
<header class="header">
    <div class="header-left">
        <div class="header-text"><h1 id="brandTitle"><span class="hydra">HYDRA</span><span class="link">link</span></h1></div>
    </div>
    <div class="tab-nav">
        <button class="tab-btn active" onclick="switchTab('abrechnungen')" id="tabAbrechnungen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
            Abrechnung
        </button>
        <button class="tab-btn" onclick="switchTab('muessenzahlen')" id="tabMuessenZahlen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            Kassieren
        </button>
        <button class="tab-btn" onclick="switchTab('abrbot')" id="tabAbrBot">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload
        </button>
        <button class="tab-btn" onclick="switchTab('rechnungen')" id="tabRechnungen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            Rechnungen
        </button>
    </div>
    <div class="header-actions">
        <button class="theme-toggle" id="themeToggle" title="Theme wechseln">
            <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            <span id="themeText">Dark</span>
        </button>
        <button class="btn-logout" id="logoutBtn" title="Abmelden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            <span id="sessionName">Abmelden</span>
        </button>
    </div>
</header>
```

Hinweis: Die Tab-Reihenfolge ist neu (Abrechnung, Kassieren, Upload, Rechnungen). `switchTab` nutzt IDs, keine Reihenfolge, bleibt also unverändert.

- [ ] **Step 6: Typewriter entfernen, Theme-Standard hell, Benutzername anzeigen**

Im `DOMContentLoaded`-Handler die Zeile `// Typewriter (function(){ … tH()})();` komplett löschen (die `.hydra`/`.link`-Spans sind jetzt statisch befüllt).

`initTheme` ersetzen durch:

```js
function initTheme() { const saved = localStorage.getItem('theme'); const html = document.documentElement; if (saved === 'dark') { html.setAttribute('data-theme', 'dark'); updateThemeUI(true); } else { html.removeAttribute('data-theme'); updateThemeUI(false); } }
```

Direkt nach `initTheme();` im `DOMContentLoaded`-Handler ergänzen:

```js
try { const sess = JSON.parse(localStorage.getItem('hydralink_session') || 'null'); if (sess && sess.name) document.getElementById('sessionName').textContent = sess.name; } catch (e) {}
```

- [ ] **Step 7: Check und Sichtprüfung**

Run: `scripts/check-dashboard.sh dashboard-neu.html`
Expected: `OK`.

Run: `python3 -m http.server 8080 --directory /Users/pepe/Projects/hydrafleet` und `http://localhost:8080/dashboard-neu.html` öffnen (vorher über `index.html` einloggen, Session liegt in localStorage).
Expected: Kopfleiste oben mit HYDRAlink, vier Tabs, Theme-Schalter, Benutzername. In den DevTools auf 390px schalten: Tabs als Leiste unten, Inhalt scrollt darüber, nichts verdeckt. Seite ist hell; Theme-Schalter wechselt auf dunkel und zurück. Tabs Abrechnung/Kassieren sehen noch alt aus (das ist ok, kommt in Task 2 und 3), müssen aber funktionieren.

- [ ] **Step 8: Commit**

```bash
git add dashboard-neu.html
git commit -m "redesign v2: tokens, kopfleiste, bottom-nav, hell als standard"
```

---

### Task 2: Tab Abrechnung

**Files:**
- Modify: `dashboard-neu.html` — Markup `<div class="tab-content active" id="contentAbrechnungen"> … </div><!-- end contentAbrechnungen -->`
- Modify: `dashboard-neu.html` — JS: State-Variablen, `getData`, `render`, `toggleSort`, `updateSortUI`, `DOMContentLoaded`-Listener, neue Funktionen `weekRange`, `detailHtml`, `selectDriver`, `isMobile`

**Interfaces:**
- Consumes: CSS-Klassen aus Task 1; bestehende Funktionen `fmt`, `esc`, `lohnOf`, `netAuszahlung`, `canEditLohn`, `saveLohn`, `printDriver`, `excludeDriver`, `openAliasModal`.
- Produces: `weekRange(woche: string): string` (z.B. `"7. – 13. Sept 2026"`), `isMobile(): boolean`, `selectDriver(name: string|null)`, `detailHtml(s, editLohn): string`. Task 3 nutzt `isMobile` und dieselbe Detail-Mechanik.

- [ ] **Step 1: Markup des Abrechnungs-Tabs ersetzen**

Alles zwischen `<div class="tab-content active" id="contentAbrechnungen">` und `<!-- end contentAbrechnungen -->` ersetzen durch:

```html
<div class="tab-content active" id="contentAbrechnungen">
    <div class="hero">
        <div class="hero-top">
            <div class="week-pick">
                <select id="weekFilter"><option value="">Laden...</option></select>
                <span class="week-range"><span id="weekRange"></span> · <span id="statFahrer">--</span> Fahrer</span>
            </div>
            <div class="hero-big"><b id="statAuszahlung">--</b><small>Auszahlungen (tatsächlich)</small></div>
        </div>
        <div class="kpi">
            <div class="kpi-item"><small>Zu kassieren</small><b class="err" id="statKassieren">--</b></div>
            <div class="kpi-item"><small>Bei uns bleibt</small><b id="statBleibt">--</b><div class="hidden" id="statBleibtSub"></div></div>
            <div class="kpi-item"><small>Probleme</small><b id="statProbleme">--</b></div>
            <div class="kpi-item desktop-only"><small>Ausgeschlossen</small><b id="statExcluded">0</b></div>
            <div class="kpi-item desktop-only"><small>Eingänge am Konto</small>
                <div class="konto"><span>Bolt <span id="statBoltTransfer">--</span></span><span>Uber <span id="statUberTransfer">--</span></span><span>MyPOS <span id="statMyposTransfer">--</span></span><span id="statTransferTotal" class="hidden"></span></div>
            </div>
        </div>
    </div>
    <div class="toolbar">
        <input type="text" class="search" id="searchInput" placeholder="Fahrer suchen">
        <button class="chip active" id="allFilter">Alle</button>
        <button class="chip" id="warningFilter">Schulden</button>
        <button class="chip" id="warnOnlyFilter">Warnung</button>
        <button class="chip lohn" id="lohnFilter">Lohn eingetragen <span class="cnt" id="lohnCount">0</span></button>
        <button class="chip excluded" id="excludedFilter">Ausgeschl. <span class="cnt" id="excludedCount">0</span></button>
        <div class="sp"></div>
        <button class="btn desktop-only" id="printAllBtn">Alle drucken</button>
        <button class="btn desktop-only" id="exportBtn">Export</button>
        <button class="btn" id="refreshBtn" title="Neu laden">↺</button>
    </div>
    <div class="hint hidden" id="lohnHint"></div>
    <div class="alias-banner" id="aliasBanner">
        <span><strong id="aliasBannerCount">0</strong> Fahrer ohne Zuordnung in dieser Woche</span>
        <button class="btn" onclick="openAliasModal()">Jetzt zuordnen →</button>
    </div>
    <div class="excluded-panel" id="excludedPanel">
        <h3>Ausgeschlossene Fahrer</h3>
        <div class="excluded-list" id="excludedList"></div>
    </div>
    <div class="split">
        <div class="split-main">
            <table class="data-table" id="abrTable">
                <colgroup><col style="width:31%"><col style="width:12%"><col style="width:16%"><col style="width:13%"><col style="width:28%"></colgroup>
                <thead><tr>
                    <th data-sort="name" id="sortName">Fahrer</th>
                    <th data-sort="mypos" id="sortMypos">MyPOS</th>
                    <th data-sort="lohn" id="sortLohn">Lohn</th>
                    <th data-sort="miete" id="sortMiete">Pausch.</th>
                    <th data-sort="payout" id="sortPayout">Auszahlung</th>
                </tr></thead>
                <tbody id="tableBody"><tr><td colspan="5" class="empty">Laden…</td></tr></tbody>
            </table>
            <div class="hidden" id="tableCount"></div>
        </div>
        <aside class="side-panel" id="detailPanel"><div class="placeholder">Fahrer anklicken für Details</div></aside>
    </div>
</div><!-- end contentAbrechnungen -->
```

- [ ] **Step 2: State erweitern und Helfer einfügen**

Die Zeile `let week = '', search = '', warn = false, showExcluded = false, sortBy = 'name_asc';` ersetzen durch:

```js
let week = '', search = '', warn = false, warnOnly = false, lohnOnly = false, showExcluded = false, sortBy = 'name_asc', selectedDriver = null;
function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
function weekRange(woche) {
    const m = /^(\d{4})-W(\d{2})$/.exec(woche || '');
    if (!m) return '';
    const year = parseInt(m[1], 10), wk = parseInt(m[2], 10);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = jan4.getUTCDay() || 7;
    const monday = new Date(jan4.getTime() - (dow - 1) * 86400000 + (wk - 1) * 7 * 86400000);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const MON = ['Jän', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sept', 'Okt', 'Nov', 'Dez'];
    const d = x => x.getUTCDate() + '.';
    if (monday.getUTCMonth() === sunday.getUTCMonth()) return d(monday) + ' – ' + d(sunday) + ' ' + MON[sunday.getUTCMonth()] + ' ' + sunday.getUTCFullYear();
    return d(monday) + ' ' + MON[monday.getUTCMonth()] + ' – ' + d(sunday) + ' ' + MON[sunday.getUTCMonth()] + ' ' + sunday.getUTCFullYear();
}
function fmtInt(n) { return Math.round(parseFloat(n) || 0).toLocaleString('de-AT'); }
```

- [ ] **Step 3: Test für weekRange schreiben und laufen lassen**

Datei `scripts/test-weekrange.js` anlegen:

```js
// Extrahiert weekRange aus dashboard-neu.html und prüft bekannte Wochen.
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || 'dashboard-neu.html', 'utf8');
const src = html.match(/function weekRange\(woche\)[\s\S]*?\n}\n/)[0];
const weekRange = new Function(src + '; return weekRange;')();
const cases = [['2026-W37', '7. – 13. Sept 2026'], ['2026-W01', '29. Dez – 4. Jän 2026'], ['2026-W16', '13. – 19. Apr 2026'], ['', '']];
let fail = 0;
for (const [input, want] of cases) { const got = weekRange(input); if (got !== want) { console.error('FAIL', input, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); fail++; } }
if (fail) process.exit(1); console.log('weekRange OK');
```

Run: `node scripts/test-weekrange.js dashboard-neu.html`
Expected: `weekRange OK`. (Vor Step 2 schlägt der Test mit "Cannot read properties of null" fehl, weil die Funktion fehlt.)

- [ ] **Step 4: getData ersetzen**

```js
function getData() {
    let data = SETTLEMENTS.filter(function(s) {
        const isWarnStatus = !!(s.status && s.status.indexOf('WARNUNG') >= 0);
        const isExcluded = excludedDrivers.includes(s.fahrer_name);
        return s.woche === week && s.fahrer_name && s.fahrer_name !== '__TRANSFER__'
            && s.fahrer_name.toLowerCase().indexOf(search) >= 0
            && (!warn || s.auszahlung < 0)
            && (!warnOnly || isWarnStatus)
            && (!lohnOnly || lohnOf(s) > 0)
            && !isExcluded;
    });
    const num = f => (a, b) => (f(b) || 0) - (f(a) || 0);
    const sorters = {
        name_asc: (a, b) => (a.fahrer_name || '').localeCompare(b.fahrer_name || ''),
        name_desc: (a, b) => (b.fahrer_name || '').localeCompare(a.fahrer_name || ''),
        payout_desc: num(s => s.auszahlung), payout_asc: (a, b) => num(s => s.auszahlung)(b, a),
        mypos_desc: num(s => s.mypos_summe), mypos_asc: (a, b) => num(s => s.mypos_summe)(b, a),
        lohn_desc: num(lohnOf), lohn_asc: (a, b) => num(lohnOf)(b, a),
        miete_desc: num(s => s.miete), miete_asc: (a, b) => num(s => s.miete)(b, a)
    };
    data.sort(sorters[sortBy] || sorters.name_asc);
    return data;
}
```

- [ ] **Step 5: toggleSort und updateSortUI ersetzen**

```js
function toggleSort(col) {
    const defaults = { name: 'name_asc', payout: 'payout_desc', mypos: 'mypos_desc', lohn: 'lohn_desc', miete: 'miete_desc' };
    const cur = sortBy.split('_');
    if (cur[0] === col) { sortBy = col + '_' + (cur[1] === 'asc' ? 'desc' : 'asc'); } else { sortBy = defaults[col] || 'name_asc'; }
    updateSortUI(); render();
}
function updateSortUI() {
    const labels = { name: 'Fahrer', mypos: 'MyPOS', lohn: 'Lohn', miete: 'Pausch.', payout: 'Auszahlung' };
    const cur = sortBy.split('_');
    document.querySelectorAll('#abrTable th[data-sort]').forEach(function(th) {
        const col = th.dataset.sort;
        const on = col === cur[0];
        th.classList.toggle('sorted', on);
        th.textContent = labels[col] + (on ? (cur[1] === 'asc' ? ' ↑' : ' ↓') : '');
    });
}
```

- [ ] **Step 6: detailHtml und selectDriver einfügen (vor `render`)**

```js
function detailHtml(s, editLohn) {
    const korr = parseFloat(s.korrektur) || 0;
    const net = netAuszahlung(s);
    const kv = (k, v, cls) => '<div class="detail-kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><span>' + v + '</span></div>';
    return '<div class="detail" data-detail="' + esc(s.fahrer_name) + '">'
        + '<h4>' + esc(s.fahrer_name) + '</h4>'
        + '<div class="sub">' + esc(s.telefon || '–') + ' · Modell ' + esc(s.mietmodell || '–') + (s.status && s.status.indexOf('WARNUNG') >= 0 ? ' · <span class="neg">' + esc(s.status) + '</span>' : '') + '</div>'
        + '<div class="pay' + (net < 0 ? ' neg' : '') + '">' + fmt(net) + ' €</div>'
        + '<div class="detail-sec">Einnahmen brutto</div>'
        + kv('Bolt', fmt(s.bolt_brutto)) + kv('Uber', fmt(s.uber_fahrpreis)) + kv('MyPOS', fmt(s.mypos_summe)) + kv('Gesamt', fmt(s.bruttoumsatz_gesamt), 'strong')
        + '<div class="detail-sec">Netto</div>'
        + kv('Bolt Auszahlung', fmt(s.bolt_auszahlung)) + kv('Uber Auszahlung', fmt(s.uber_auszahlung)) + kv('Wir bekommen', fmt(s.wir_bekommen), 'strong')
        + '<div class="detail-sec">Abzüge</div>'
        + kv('Pauschale', fmt(s.miete)) + kv('Prozent', fmt(s.prozent_abzug)) + kv('Abzug gesamt', fmt(s.abzug_gesamt), 'strong')
        + (korr !== 0 ? '<div class="detail-sec">Korrektur</div>' + kv(esc(s.korrektur_note || 'Korrektur'), (korr > 0 ? '+' : '') + fmt(korr)) : '')
        + '<div class="detail-lohn"><span>Lohn bereits überwiesen</span>'
        + (editLohn ? '<input type="number" step="0.01" class="lohn-input" data-lohn-id="' + s.id + '" value="' + (lohnOf(s) || '') + '" placeholder="0">' : '<b class="num">' + (lohnOf(s) ? fmt(lohnOf(s)) : '–') + '</b>')
        + '</div>'
        + kv('Auszahlung vor Lohn', fmt(s.auszahlung)) + kv('Netto nach Lohn', fmt(net), 'strong')
        + '<div class="detail-acts"><button class="btn-primary" data-print="' + esc(s.fahrer_name) + '">Drucken / WhatsApp</button><button class="btn-ghost danger" data-exclude="' + esc(s.fahrer_name) + '">Ausschließen</button></div>'
        + '</div>';
}
function selectDriver(name) { selectedDriver = (selectedDriver === name) ? null : name; render(); }
```

- [ ] **Step 7: render ersetzen**

```js
function render() {
    const data = getData();
    const all = SETTLEMENTS.filter(function(s) { return s.woche === week && s.fahrer_name !== '__TRANSFER__' && !excludedDrivers.includes(s.fahrer_name); });
    const warnCount = all.filter(function(s) { return (s.status && s.status.indexOf('WARNUNG') >= 0) || s.auszahlung < 0; }).length;
    const totalAbzug = data.reduce(function(a,s) { return a + (s.abzug_gesamt || 0); }, 0);
    const totalMieten = data.reduce(function(a,s) { return a + (s.miete || 0); }, 0);
    const totalProzent = data.reduce(function(a,s) { return a + (s.prozent_abzug || 0); }, 0);
    const auszahlungPositiv = data.reduce(function(a,s) { var n = netAuszahlung(s); return a + (n > 0 ? n : 0); }, 0);
    const auszahlungNegativ = data.reduce(function(a,s) { var n = netAuszahlung(s); return a + (n < 0 ? Math.abs(n) : 0); }, 0);
    document.getElementById('statFahrer').textContent = data.length;
    document.getElementById('weekRange').textContent = weekRange(week);
    document.getElementById('statBleibt').textContent = fmt(totalAbzug);
    document.getElementById('statBleibtSub').textContent = fmt(totalMieten) + ' Mieten + ' + fmt(totalProzent) + ' %';
    document.getElementById('statAuszahlung').textContent = fmt(auszahlungPositiv) + ' €';
    document.getElementById('statKassieren').textContent = fmt(auszahlungNegativ);
    document.getElementById('statProbleme').textContent = warnCount;
    document.getElementById('statExcluded').textContent = excludedDrivers.length;
    var transferRow = SETTLEMENTS.find(function(s) { return s.woche === week && s.fahrer_name === '__TRANSFER__'; });
    var boltTransfer = transferRow ? (transferRow.bolt_auszahlung || 0) : data.reduce(function(a,s) { return a + (s.bolt_auszahlung || 0); }, 0);
    var uberTransfer = transferRow ? (transferRow.uber_auszahlung || 0) : data.reduce(function(a,s) { return a + (s.uber_auszahlung || 0); }, 0);
    var myposTransfer = transferRow ? (transferRow.mypos_summe || 0) : data.reduce(function(a,s) { return a + (s.mypos_summe || 0); }, 0);
    document.getElementById('statBoltTransfer').textContent = fmtInt(boltTransfer);
    document.getElementById('statUberTransfer').textContent = fmtInt(uberTransfer);
    document.getElementById('statMyposTransfer').textContent = fmtInt(myposTransfer);
    document.getElementById('statTransferTotal').textContent = fmt(boltTransfer + uberTransfer + myposTransfer);
    document.getElementById('tableCount').textContent = ' (' + data.length + ')';
    const lohnRows = all.filter(function(s) { return lohnOf(s) > 0; });
    document.getElementById('lohnCount').textContent = lohnRows.length;
    const hint = document.getElementById('lohnHint');
    if (lohnOnly) { hint.textContent = ''; hint.innerHTML = 'Zeigt <b>' + data.length + ' Fahrer</b> mit eingetragenem Lohn, Summe Lohn <b class="num">' + fmt(data.reduce(function(a,s){ return a + lohnOf(s); }, 0)) + ' €</b>.'; hint.classList.remove('hidden'); } else { hint.classList.add('hidden'); }
    const noMatchCount = all.filter(function(s) { return s.status && s.status.indexOf('WARNUNG_KEIN_FAHRER') >= 0; }).length;
    const aliasBannerEl = document.getElementById('aliasBanner');
    aliasBannerEl.style.display = noMatchCount > 0 ? 'flex' : 'none';
    if (noMatchCount > 0) { document.getElementById('aliasBannerCount').textContent = noMatchCount; }
    const tbody = document.getElementById('tableBody');
    const panel = document.getElementById('detailPanel');
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">Keine Einträge</td></tr>'; panel.innerHTML = '<div class="placeholder">Keine Einträge</div>'; return; }
    const editLohn = canEditLohn();
    const mobile = isMobile();
    if (selectedDriver && !data.some(function(s) { return s.fahrer_name === selectedDriver; })) selectedDriver = null;
    tbody.innerHTML = data.map(function(s) {
        const isWarn = (s.status && s.status.indexOf('WARNUNG') >= 0) || s.auszahlung < 0;
        const net = netAuszahlung(s);
        const korr = parseFloat(s.korrektur) || 0;
        const dot = s.status && s.status.indexOf('WARNUNG') >= 0 ? 'warn' : (s.auszahlung < 0 ? 'neg' : '');
        const sel = selectedDriver === s.fahrer_name;
        const cell = function(v) { const n = parseFloat(v) || 0; return '<td class="' + (n === 0 ? 'zero' : '') + '">' + fmtInt(n) + '</td>'; };
        return '<tr class="' + (isWarn ? 'warning' : '') + (sel ? ' selected' : '') + '" data-row="' + esc(s.fahrer_name) + '">'
            + '<td title="' + esc(s.fahrer_name) + '"><span class="dot ' + dot + '"></span>' + esc(s.fahrer_name) + (korr !== 0 ? '<span class="fahrer-korr ' + (korr > 0 ? 'pos' : 'neg') + '" title="' + esc(s.korrektur_note || '') + '">Korr ' + (korr > 0 ? '+' : '') + fmt(korr) + '</span>' : '') + '</td>'
            + cell(s.mypos_summe) + cell(lohnOf(s)) + cell(s.miete)
            + '<td class="pay' + (net < 0 ? ' neg' : '') + '">' + fmt(net) + '</td>'
            + '</tr>'
            + (sel && mobile ? '<tr class="detail-row"><td colspan="5">' + detailHtml(s, editLohn) + '</td></tr>' : '');
    }).join('');
    if (!mobile) {
        const s = selectedDriver ? data.find(function(x) { return x.fahrer_name === selectedDriver; }) : null;
        panel.innerHTML = s ? detailHtml(s, editLohn) : '<div class="placeholder">Fahrer anklicken für Details</div>';
    }
}
```

- [ ] **Step 8: Event-Listener im DOMContentLoaded anpassen**

Die bestehenden Zeilen `document.getElementById('sortName').addEventListener(…)` und `document.getElementById('sortPayout').addEventListener(…)` löschen und stattdessen:

```js
document.querySelectorAll('#abrTable th[data-sort]').forEach(function(th) { th.addEventListener('click', function() { toggleSort(th.dataset.sort); }); });
document.getElementById('allFilter').addEventListener('click', function() { warn = false; warnOnly = false; lohnOnly = false; ['warningFilter','warnOnlyFilter','lohnFilter'].forEach(function(id) { document.getElementById(id).classList.remove('active'); }); this.classList.add('active'); render(); });
document.getElementById('warnOnlyFilter').addEventListener('click', function() { warnOnly = !warnOnly; this.classList.toggle('active', warnOnly); document.getElementById('allFilter').classList.toggle('active', !warn && !warnOnly && !lohnOnly); render(); });
document.getElementById('lohnFilter').addEventListener('click', function() { lohnOnly = !lohnOnly; this.classList.toggle('active', lohnOnly); if (lohnOnly) { sortBy = 'lohn_desc'; updateSortUI(); } document.getElementById('allFilter').classList.toggle('active', !warn && !warnOnly && !lohnOnly); render(); });
window.matchMedia('(max-width: 768px)').addEventListener('change', function() { render(); });
```

Den bestehenden `warningFilter`-Listener so ändern, dass er zusätzlich `document.getElementById('allFilter').classList.toggle('active', !warn && !warnOnly && !lohnOnly);` vor `render()` ausführt.

Den bestehenden Klick-Delegations-Block auf `tableBody` ersetzen durch einen, der auch das Panel abdeckt:

```js
function detailActions(e) {
    const print = e.target.closest('[data-print]');
    if (print) { printDriver(print.dataset.print); return true; }
    const exclude = e.target.closest('[data-exclude]');
    if (exclude) { excludeDriver(exclude.dataset.exclude); selectedDriver = null; return true; }
    return false;
}
document.getElementById('tableBody').addEventListener('click', function(e) {
    if (detailActions(e)) return;
    if (e.target.closest('.detail-row')) return;
    const row = e.target.closest('tr[data-row]');
    if (row) selectDriver(row.dataset.row);
});
document.getElementById('detailPanel').addEventListener('click', detailActions);
['tableBody', 'detailPanel'].forEach(function(id) {
    const el = document.getElementById(id);
    el.addEventListener('change', function(e) { const t = e.target; if (t && t.classList && t.classList.contains('lohn-input')) { saveLohn(parseInt(t.getAttribute('data-lohn-id'), 10), t.value); } });
    el.addEventListener('keydown', function(e) { if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('lohn-input')) { e.target.blur(); } });
});
```

Die alten `tableBody`-`change`/`keydown`-Listener (zwei Zeilen) löschen, da sie oben ersetzt sind.

- [ ] **Step 9: updateExcludedUI prüfen**

`updateExcludedUI` setzt `excludedCount`, `excludedPanel` (`show`-Klasse) und `excludedList`. Diese IDs existieren weiterhin. Falls die Funktion `excludedFilter.classList.toggle('active', …)` nutzt, bleibt das kompatibel mit `.chip.active`. Keine Änderung nötig; nur `statExcluded` wird jetzt in `render()` gesetzt.

- [ ] **Step 10: Check, Test, Sichtprüfung**

Run: `scripts/check-dashboard.sh dashboard-neu.html && node scripts/test-weekrange.js dashboard-neu.html`
Expected: beides OK.

Browser, Desktop: Kopf zeigt KW-Auswahl, Datum, Fahreranzahl, große Auszahlung, fünf Kennzahlen. Tabelle hat fünf Spalten; Klick auf Spaltentitel sortiert (Pfeil); Klick auf Fahrer füllt das Seitenpanel; Drucken öffnet das Print-Modal wie bisher (mit WhatsApp-Button); Lohn-Feld (als Boyko eingeloggt) speichert bei Enter und die Auszahlung in der Zeile ändert sich. Chip "Lohn eingetragen" filtert und zeigt die Hinweiszeile. Chip "Ausgeschl." öffnet das Panel wie bisher.
Browser, 390px und 320px: keine Abschneidung, Auszahlung vollständig, Klick auf Fahrer klappt die Detailzeile auf, zweiter Klick schließt sie. Vergleich mit `dashboard.html` für dieselbe Woche: Auszahlungen (tatsächlich), Zu kassieren, Bei uns bleibt und die Auszahlung pro Fahrer sind identisch.

- [ ] **Step 11: Commit**

```bash
git add dashboard-neu.html scripts/test-weekrange.js
git commit -m "redesign v2: abrechnung mit 5 spalten, detailzeile/panel, lohn-chip, sortierung"
```

---

### Task 3: Tab Kassieren

**Files:**
- Modify: `dashboard-neu.html` — Markup `<div class="tab-content" id="contentMuessenZahlen"> … </div>` und Modal `<div class="print-overlay" id="mzModalOverlay"> … </div>`
- Modify: `dashboard-neu.html` — JS: `renderMuessenZahlen`, `openKassierModal`, `closeKassierModal`, `renderHistoryHtml`, `initMuessenZahlen`, neue Variable `mzSelected`

**Interfaces:**
- Consumes: `getOpenDebts`, `isOldErledigt`, `submitKassier`, `deleteKassier`, `TYP_LABEL`, `fmt`, `esc`, `weekRange`, `isMobile` (Task 2).
- Produces: `openKassierModal(fahrer, woche)` verschiebt das Formular-Element `#mzForm` in den Detailbereich und zeigt es; `closeKassierModal()` versteckt es. Signaturen bleiben, damit `submitKassier` unverändert `closeKassierModal()` aufruft.

- [ ] **Step 1: Markup des Kassieren-Tabs ersetzen**

```html
<div class="tab-content" id="contentMuessenZahlen">
    <div class="hero">
        <div class="hero-top">
            <div class="week-pick">
                <span style="font-size:18px;font-weight:700">Kassieren</span>
                <select class="chip" id="mzWeekFilter"><option value="">Letzte 4 Wochen</option></select>
            </div>
            <div class="hero-big err"><b id="mzTotalOffen">--</b><small id="mzSummary">Noch offen</small></div>
        </div>
        <div class="kpi">
            <div class="kpi-item"><small>Diese Woche kassiert</small><b class="ok" id="mzKassiertWoche">--</b></div>
            <div class="kpi-item"><small>Teilweise</small><b id="mzTeilCount">--</b></div>
            <div class="kpi-item"><small>Erledigt</small><b id="mzErlCount">--</b></div>
        </div>
    </div>
    <div class="toolbar" id="mzToolbar">
        <input type="text" class="search" id="mzSearchInput" placeholder="Fahrer suchen">
        <button class="chip active" data-mz-status="alle">Alle</button>
        <button class="chip" data-mz-status="offen">Offen</button>
        <button class="chip" data-mz-status="teilweise">Teilweise</button>
        <button class="chip" data-mz-status="erledigt">Erledigt</button>
        <div class="sp"></div>
        <label class="chip desktop-only"><input type="checkbox" id="mzShowAllWeeks"> Alle Wochen</label>
        <label class="chip desktop-only"><input type="checkbox" id="mzShowOld"> Alte erledigte (&gt;60 Tage)</label>
        <span class="hidden" id="mzCount"></span>
    </div>
    <div class="split">
        <div class="split-main">
            <table class="data-table" id="mzTable">
                <colgroup><col style="width:34%"><col style="width:16%"><col style="width:16%"><col style="width:18%"><col style="width:16%"></colgroup>
                <thead><tr><th>Fahrer</th><th>Schuld</th><th>Kassiert</th><th>Offen</th><th>Status</th></tr></thead>
                <tbody id="mzTableBody"></tbody>
            </table>
        </div>
        <aside class="side-panel" id="mzPanel"><div class="placeholder">Fahrer anklicken zum Kassieren</div></aside>
    </div>
</div>
```

Das alte Modal `<div class="print-overlay" id="mzModalOverlay"> … </div>` ersetzen durch das Formular, das anfangs versteckt am Ende des `.container` liegt (IDs identisch zum alten Modal):

```html
<div class="form-card hidden" id="mzForm" data-fahrer="" data-woche="" data-offen="0">
    <div id="mzModalOverlay" class="hidden"></div>
    <div style="font-size:12px;color:var(--text-mut)"><span id="mzModalFahrer">—</span> · <span id="mzModalWoche">—</span> · offen <strong id="mzModalOffen">—</strong></div>
    <label>Betrag (€)<input type="number" id="mzModalBetrag" step="0.01" min="0.01"></label>
    <label>Art<select id="mzModalTyp"><option value="bar">Bar</option><option value="ueberweisung">Überweisung</option><option value="verrechnet">Verrechnet mit Woche…</option></select></label>
    <label id="mzModalVerrechnetLabel" class="hidden">Verrechnet mit Woche<select id="mzModalVerrechnetWoche"></select></label>
    <label>Notiz (optional)<input type="text" id="mzModalNote" maxlength="200"></label>
    <div id="mzModalWarn" class="warn-box hidden"></div>
    <div id="mzModalError" class="warn-box hidden"></div>
    <div class="detail-acts"><button class="btn-primary ok" id="mzModalSaveBtn">Speichern</button><button class="btn-ghost" id="mzModalCancelBtn">Abbrechen</button></div>
</div>
```

Hinweis: `submitKassier` liest `fahrer/woche` aus `document.getElementById('mzModalOverlay').dataset`. Damit das ohne Änderung an `submitKassier` funktioniert, setzt `openKassierModal` diese `dataset`-Werte weiterhin auf `#mzModalOverlay` (das jetzt ein leeres, verstecktes Div im Formular ist).

- [ ] **Step 2: openKassierModal / closeKassierModal ersetzen**

```js
let mzSelected = null; // "fahrer|woche"
function mzTarget() {
    if (isMobile()) return document.querySelector('#mzTableBody .detail-row .mz-form-slot');
    return document.querySelector('#mzPanel .mz-form-slot');
}
function openKassierModal(fahrer, woche) {
    const debt = getOpenDebts().find(d => d.fahrer_name === fahrer && d.woche === woche);
    if (!debt) return;
    mzSelected = fahrer + '|' + woche;
    renderMuessenZahlen();
    document.getElementById('mzModalFahrer').textContent = fahrer;
    document.getElementById('mzModalWoche').textContent = woche;
    document.getElementById('mzModalOffen').textContent = fmt(debt.offen);
    document.getElementById('mzModalBetrag').value = debt.offen.toFixed(2);
    document.getElementById('mzModalTyp').value = 'bar';
    document.getElementById('mzModalNote').value = '';
    document.getElementById('mzModalWarn').classList.add('hidden');
    document.getElementById('mzModalError').classList.add('hidden');
    document.getElementById('mzModalVerrechnetLabel').classList.add('hidden');
    const vSel = document.getElementById('mzModalVerrechnetWoche');
    vSel.innerHTML = WEEKS.filter(w => w !== woche).map(w => '<option value="' + w + '">' + w + '</option>').join('');
    const overlay = document.getElementById('mzModalOverlay');
    overlay.dataset.fahrer = fahrer; overlay.dataset.woche = woche; overlay.dataset.offen = debt.offen;
    const form = document.getElementById('mzForm');
    const slot = mzTarget();
    if (slot) { slot.appendChild(form); form.classList.remove('hidden'); setTimeout(() => document.getElementById('mzModalBetrag').focus(), 50); }
}
function closeKassierModal() {
    const form = document.getElementById('mzForm');
    form.classList.add('hidden');
    document.querySelector('.container').appendChild(form);
}
```

Da `submitKassier` und der Betrag-Listener `style.display` auf `mzModalWarn`/`mzModalError`/`mzModalVerrechnetLabel` setzen: in `submitKassier` die drei Stellen `errorEl.style.display = 'none'` → `errorEl.classList.add('hidden')` und `errorEl.style.display = 'block'` → `errorEl.classList.remove('hidden')` ändern (reine Sichtbarkeit, keine Logik). Gleiches im `mzModalTyp`-`change`-Listener (`classList.toggle('hidden', e.target.value !== 'verrechnet')`) und im `mzModalBetrag`-`input`-Listener (`warn.classList.remove('hidden')` / `add('hidden')`).

- [ ] **Step 3: renderHistoryHtml ersetzen**

```js
function renderHistoryHtml(debt) {
    const session = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
    const isAdmin = session && session.role === 'admin';
    if (!debt.payments.length) return '<div class="hist-row"><span>Noch keine Zahlung</span></div>';
    return [...debt.payments].sort((a, b) => (b.kassiert_at || '').localeCompare(a.kassiert_at || '')).map(p => {
        const dt = p.kassiert_at ? new Date(p.kassiert_at).toLocaleDateString('de-AT', { day: 'numeric', month: 'short' }) : '—';
        const typLabel = (TYP_LABEL[p.typ] || p.typ) + (p.typ === 'verrechnet' && p.verrechnet_mit_woche ? ' ' + esc(p.verrechnet_mit_woche) : '');
        const note = p.note ? ' · ' + esc(p.note) : '';
        const del = isAdmin ? '<button data-mz-delete="' + esc(p.id) + '" title="Löschen">🗑</button>' : '';
        return '<div class="hist-row"><span>' + dt + ' · ' + typLabel + ' · ' + esc(p.kassiert_von || '—') + note + '</span><span class="num">' + fmt(p.betrag) + ' ' + del + '</span></div>';
    }).join('');
}
```

- [ ] **Step 4: renderMuessenZahlen ersetzen**

```js
function mzDetailHtml(d) {
    const kv = (k, v, cls) => '<div class="detail-kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><span>' + v + '</span></div>';
    return '<div class="detail">'
        + '<h4>' + esc(d.fahrer_name) + '</h4><div class="sub">' + esc(d.woche) + ' · ' + esc(d.telefon || '–') + '</div>'
        + kv('Schuld', fmt(d.schuld)) + kv('Kassiert', fmt(d.kassiert)) + kv('Offen', '<span class="' + (d.offen > 0 ? 'neg' : '') + '">' + fmt(d.offen) + '</span>', 'strong')
        + '<div class="detail-sec">Zahlungen</div>' + renderHistoryHtml(d)
        + (d.offen > 0 ? '<div class="detail-acts"><button class="btn-primary ok" data-mz-kassier="' + esc(d.fahrer_name) + '|' + esc(d.woche) + '">Kassieren</button></div>' : '')
        + '<div class="mz-form-slot"></div>'
        + '</div>';
}
function renderMuessenZahlen() {
    let debts = getOpenDebts();
    const allInScope = debts.slice();
    if (!mzShowOldErledigt) debts = debts.filter(d => !isOldErledigt(d));
    if (mzStatusFilter !== 'alle') debts = debts.filter(d => d.status === mzStatusFilter);
    if (mzSearch) debts = debts.filter(d => (d.fahrer_name || '').toLowerCase().indexOf(mzSearch) >= 0);
    if (mzWeek) { debts = debts.filter(d => d.woche === mzWeek); }
    else if (!mzShowAllWeeks) { const recentWeeks = WEEKS.slice(0, MZ_DEFAULT_WEEKS); debts = debts.filter(d => recentWeeks.indexOf(d.woche) >= 0); }
    const statusOrder = { offen: 0, teilweise: 1, erledigt: 2 };
    debts.sort((a, b) => { const wo = (b.woche || '').localeCompare(a.woche || ''); if (wo !== 0) return wo; const so = statusOrder[a.status] - statusOrder[b.status]; if (so !== 0) return so; return (a.fahrer_name || '').localeCompare(b.fahrer_name || ''); });
    document.getElementById('mzCount').textContent = ' (' + debts.length + ')';
    const offenList = debts.filter(d => d.offen > 0);
    const totalOffen = debts.reduce((s, d) => s + d.offen, 0);
    document.getElementById('mzTotalOffen').textContent = fmt(totalOffen) + ' €';
    document.getElementById('mzSummary').textContent = 'Noch offen bei ' + offenList.length + ' Fahrer' + (offenList.length === 1 ? '' : 'n');
    document.getElementById('mzTeilCount').textContent = debts.filter(d => d.status === 'teilweise').length;
    document.getElementById('mzErlCount').textContent = debts.filter(d => d.status === 'erledigt').length;
    const weekAgo = Date.now() - 7 * 86400000;
    const kassiertWoche = KASSIER.filter(k => k.kassiert_at && new Date(k.kassiert_at).getTime() >= weekAgo).reduce((s, k) => s + (parseFloat(k.betrag) || 0), 0);
    document.getElementById('mzKassiertWoche').textContent = fmt(kassiertWoche);
    const tbody = document.getElementById('mzTableBody');
    const panel = document.getElementById('mzPanel');
    if (!debts.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">Keine Schulden vorhanden</td></tr>'; panel.innerHTML = '<div class="placeholder">Keine Schulden</div>'; return; }
    const mobile = isMobile();
    if (mzSelected && !debts.some(d => d.fahrer_name + '|' + d.woche === mzSelected)) mzSelected = null;
    let prevWeek = null;
    tbody.innerHTML = debts.map(d => {
        const key = d.fahrer_name + '|' + d.woche;
        const sel = key === mzSelected;
        let html = '';
        if (d.woche !== prevWeek) {
            prevWeek = d.woche;
            const wSum = debts.filter(x => x.woche === d.woche).reduce((s, x) => s + x.offen, 0);
            html += '<tr class="group-row"><td colspan="5">' + esc(d.woche) + ' · ' + weekRange(d.woche) + '<span class="num">offen ' + fmt(wSum) + ' €</span></td></tr>';
        }
        const offCls = d.status === 'erledigt' ? 'pos' : (d.status === 'teilweise' ? 'warn' : 'neg');
        html += '<tr class="' + (sel ? 'selected' : '') + '" data-mz-row="' + esc(key) + '">'
            + '<td title="' + esc(d.fahrer_name) + '">' + esc(d.fahrer_name) + '</td>'
            + '<td>' + fmt(d.schuld) + '</td><td>' + fmt(d.kassiert) + '</td>'
            + '<td class="pay ' + (offCls === 'neg' ? 'neg' : '') + '"' + (offCls === 'warn' ? ' style="color:var(--warn)"' : '') + (offCls === 'pos' ? ' style="color:var(--accent)"' : '') + '>' + fmt(d.offen) + '</td>'
            + '<td><span class="pill ' + d.status + '">' + d.status + '</span></td>'
            + '</tr>';
        if (sel && mobile) html += '<tr class="detail-row"><td colspan="5">' + mzDetailHtml(d) + '</td></tr>';
        return html;
    }).join('');
    if (!mobile) {
        const d = mzSelected ? debts.find(x => x.fahrer_name + '|' + x.woche === mzSelected) : null;
        panel.innerHTML = d ? mzDetailHtml(d) : '<div class="placeholder">Fahrer anklicken zum Kassieren</div>';
    }
    // Formular wieder einhängen, falls es zum aktuell gewählten Eintrag gehört und sichtbar war
    const form = document.getElementById('mzForm');
    if (!form.classList.contains('hidden')) {
        const ov = document.getElementById('mzModalOverlay');
        if (ov.dataset.fahrer + '|' + ov.dataset.woche === mzSelected) { const slot = mzTarget(); if (slot) slot.appendChild(form); } else { closeKassierModal(); }
    }
}
```

- [ ] **Step 5: initMuessenZahlen anpassen**

Im Klick-Listener auf `mzTableBody` den Block `const hBtn = e.target.closest('[data-mz-history]'); …` löschen (Verlauf ist immer sichtbar) und am Ende des Listeners ergänzen:

```js
if (e.target.closest('.detail-row')) return;
const row = e.target.closest('tr[data-mz-row]');
if (row) { mzSelected = (mzSelected === row.dataset.mzRow) ? null : row.dataset.mzRow; closeKassierModal(); renderMuessenZahlen(); }
```

Denselben Listener (Kassieren-Button, Löschen) zusätzlich auf `#mzPanel` registrieren: den Handler in eine benannte Funktion `mzClick(e)` auslegen und `document.getElementById('mzTableBody').addEventListener('click', mzClick); document.getElementById('mzPanel').addEventListener('click', mzClick);` aufrufen.

`mzWeekFilter` wird in `initMuessenZahlen` befüllt: `weekSel.innerHTML = '<option value="">Letzte 4 Wochen</option>' + WEEKS.map(w => '<option value="' + w + '">' + w + '</option>').join('');`.

Ergänzen: `window.matchMedia('(max-width: 768px)').addEventListener('change', function() { if (mzInitialized) renderMuessenZahlen(); });`

- [ ] **Step 6: Check und Sichtprüfung**

Run: `scripts/check-dashboard.sh dashboard-neu.html`
Expected: `OK`.

Browser, Desktop: Kopf zeigt "Noch offen" rot mit Anzahl, drei Kennzahlen. Tabelle nach Wochen gruppiert mit Wochensumme. Klick auf Fahrer füllt das Panel (Schuld/Kassiert/Offen, Zahlungen mit Kassierer). Klick "Kassieren" zeigt das Formular im Panel; Betrag ist vorbelegt; Art "Verrechnet" blendet die Wochenwahl ein; Betrag über offen zeigt die Warnung; Speichern legt eine Zahlung an (in Supabase `kassier_zahlungen` sichtbar), Formular verschwindet, Zeile und Kopf aktualisieren sich. Als Admin: 🗑 fragt nach und löscht wie bisher.
Browser, 390px: Detail klappt in der Zeile auf, Formular erscheint darunter, Tastatur verdeckt nichts Wichtiges, keine horizontale Verschiebung. Als Nicht-Admin: kein 🗑.

- [ ] **Step 7: Commit**

```bash
git add dashboard-neu.html
git commit -m "redesign v2: kassieren mit wochengruppen, detail und inline-formular"
```

---

### Task 4: Upload und Rechnungen umfärben

**Files:**
- Modify: `dashboard-neu.html` — CSS-Regeln `.abr-*`, `.re-*`, `.alias-*`, `.print-modal`, `.print-overlay`, `.mz-modal-inner` (nur Farben/Radien/Schatten), Markup unverändert

**Interfaces:**
- Consumes: Tokens aus Task 1.
- Produces: nichts Neues.

- [ ] **Step 1: Farb- und Schattenwerte in den unveränderten Bereichen auf Tokens umstellen**

Im `<style>` innerhalb der Regeln für `.abr-*`, `.re-*`, `.alias-*`, `.print-*`: jede feste Farbe (`#F5B51B`, `#020617`, `rgba(245,181,27,…)`, `#fce8eb`, `#c4364a`) durch das passende Token ersetzen: Gold-Akzente → `var(--accent)`, Gold-Glow → `var(--accent-faint)`, dunkler Button-Text → `var(--accent-ink)`, Fehlerflächen → `var(--status-err-bg)`, Fehlertext → `var(--err)`. `box-shadow`-Werte mit Blur > 4px auf `none` setzen. `border-radius` über 12px auf 10px reduzieren. Keine Änderung an `display`, `grid`, `flex`, Breiten, IDs, Klassen.

Run (Kontrolle, dass keine Gold-Farbe übrig ist): `grep -n -i "F5B51B\|245,181,27" dashboard-neu.html`
Expected: keine Treffer außer eventuell im Logo-SVG der Print-Ansicht.

- [ ] **Step 2: Tab Upload bei 390px prüfen**

Browser, 390px, Tab Upload: drei Datei-Felder untereinander, Wochenauswahl, Checkliste und Start-Button sichtbar, kein horizontales Scrollen. Falls ein Element breiter als der Bildschirm ist, für diesen Selektor in den `@media (max-width: 768px)`-Block `max-width: 100%; box-sizing: border-box;` ergänzen.

- [ ] **Step 3: Tab Rechnungen bei 390px und Desktop prüfen**

Browser: Firmenkarten, Positionen hinzufügen/entfernen, Vorschau, Archiv-Suche funktionieren. Eine Test-Rechnung nicht absenden (n8n erzeugt echte Nummern). Bei 390px kein horizontales Scrollen; Tabellen im Archiv dürfen innerhalb ihres Containers scrollen (`overflow-x: auto` auf `.re-archive-table-wrap` oder dem vorhandenen Wrapper).

- [ ] **Step 4: Check und Commit**

Run: `scripts/check-dashboard.sh dashboard-neu.html`
Expected: `OK`.

```bash
git add dashboard-neu.html
git commit -m "redesign v2: upload und rechnungen auf neue tokens umgefaerbt"
```

---

### Task 5: Modals, Dunkel-Theme, Abnahme, Preview

**Files:**
- Modify: `dashboard-neu.html` — CSS `.print-overlay`, `.print-modal`, `.alias-modal-inner`, `.skeleton-*`
- Modify: `index.html` — Link zur neuen Version (nur ein zusätzlicher Button unter dem Login, keine Logikänderung)
- Modify: `CLAUDE.md` — Abschnitt "Repo Structure" um `dashboard-neu.html` und `scripts/` ergänzen

**Interfaces:**
- Consumes: alles Vorige.
- Produces: Vorschau-URL `https://<branch>.hydrafleet.pages.dev/dashboard-neu.html` (Cloudflare Branch-Preview) für den Parallelbetrieb.

- [ ] **Step 1: Print-, Alias-Modal und Skeleton auf Tokens**

Regeln `.print-overlay { background: rgba(0,0,0,.55); }`, `.print-modal { background: var(--surface); color: var(--text); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }`, `.alias-modal-inner { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }`, `.skeleton-bar { background: var(--surface-3); }` setzen bzw. die vorhandenen Werte entsprechend ersetzen. Die Druckansicht (`@media print`) bleibt schwarz auf weiß und unverändert.

- [ ] **Step 2: Dunkel-Theme durchklicken**

Browser: Theme auf Dunkel schalten, alle vier Tabs, Detailzeile/Panel, Kassieren-Formular, Print-Modal, Alias-Modal prüfen. Jede Fläche muss lesbaren Kontrast haben (kein dunkler Text auf dunkler Fläche). Gefundene Stellen: fester Farbwert durch Token ersetzen.

- [ ] **Step 3: Abnahme-Checkliste aus der Spec abarbeiten**

Für dieselbe Woche in `dashboard.html` und `dashboard-neu.html`:
- Auszahlungen (tatsächlich), Zu kassieren, Bei uns bleibt, Probleme identisch.
- Zufällig drei Fahrer: Auszahlung, MyPOS, Lohn, Pauschale identisch; Print-Ansicht identisch.
- Export-CSV beider Versionen per `diff` vergleichen: identisch.
- Lohn speichern (Boyko), Kassieren eintragen und als Admin löschen, Ausschließen und wieder aufnehmen, Alias zuordnen: alles funktioniert in der neuen Version.
- 320px, 390px, Desktop, hell und dunkel: keine Abschneidung, kein horizontales Scrollen.

Run: `scripts/check-dashboard.sh dashboard-neu.html && node scripts/test-weekrange.js dashboard-neu.html`
Expected: OK.

- [ ] **Step 4: Login-Seite verlinken und Doku**

In `index.html` unter dem Login-Button einen Link `<a href="dashboard-neu.html" class="link-neu">Neue Ansicht testen</a>` einfügen, der nur nach erfolgreichem Login sichtbar sein muss (die Session-Prüfung in `dashboard-neu.html` leitet sonst zurück). In `CLAUDE.md` unter "Repo Structure" ergänzen:

```
dashboard-neu.html  — Redesign v2 (Parallelbetrieb, siehe docs/superpowers/specs/2026-09-10-hydralink-redesign-design.md)
scripts/            — check-dashboard.sh (Syntax/ID-Check), test-weekrange.js
```

- [ ] **Step 5: Commit und Push, Preview-URL an den User**

```bash
git add dashboard-neu.html index.html CLAUDE.md
git commit -m "redesign v2: modals, dunkel-theme, preview-link, doku"
git push -u origin redesign/hydralink-v2
```

Cloudflare Pages baut den Branch automatisch. Preview-URL im Cloudflare-Dashboard unter Deployments nachsehen und dem User geben. Parallelbetrieb ca. eine Woche.

---

### Task 6: Go-live (erst nach Freigabe durch den User)

**Files:**
- Rename: `dashboard.html` → `dashboard-alt.html`
- Rename: `dashboard-neu.html` → `dashboard.html`
- Modify: `index.html` (Link auf `dashboard-neu.html` entfernen), `CLAUDE.md`

- [ ] **Step 1: Umbenennen**

```bash
git mv dashboard.html dashboard-alt.html
git mv dashboard-neu.html dashboard.html
```

- [ ] **Step 2: Link und Doku anpassen**

In `index.html` den Link "Neue Ansicht testen" entfernen. In `CLAUDE.md`: `dashboard.html — Main dashboard (Redesign v2)`, `dashboard-alt.html — vorherige Version, Rückfall, nicht verlinkt`.

- [ ] **Step 3: Check, Commit, Merge**

Run: `scripts/check-dashboard.sh dashboard.html`
Expected: `OK`.

```bash
git commit -am "redesign v2 live: dashboard.html ersetzt, alte version als dashboard-alt.html"
git checkout main && git merge --no-ff redesign/hydralink-v2 && git push origin main
```

Rollback-Pfad: `git mv dashboard.html dashboard-neu.html && git mv dashboard-alt.html dashboard.html && git commit -m "rollback redesign v2" && git push origin main`.
