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
# IDs, die nur dynamisch per innerHTML erzeugt werden (kein statisches Markup):
dynamic_ok = set()
missing = sorted(i for i in ids_used if i not in ids_def and i not in dynamic_ok)
if missing:
    print("FEHLENDE IDs im Markup:", ", ".join(missing))
    sys.exit(1)
print(f"{len(scripts)} Inline-Scripts extrahiert, {len(ids_used)} IDs geprüft")
PY
for f in "$TMP"/*.js; do node --check "$f"; done
echo "OK: $FILE"
