#!/usr/bin/env bash
# Browser-Test der Fahrerapp (Reiter Nachrichten) mit Attrappen statt Supabase – headless Chromium ueber scripts/shot.js.
#   bash scripts/test-fahrer-nachrichten.sh
# Prueft: Chat-Layout (Liste scrollt, Feld ueber Tab-Leiste, beim Tippen Leiste weg); Abmelden kuendigt das Push-Abo und leert den Chat-Zustand (Geraet wechselt den Fahrer);
#         Neuzeichnen behaelt den Entwurf; scheitert das Senden nach einem Neuzeichnen, steht der Text im neuen Feld.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=$((8800 + RANDOM % 100))
python3 -m http.server "$PORT" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
OUT="$(mktemp -d)"
node scripts/shot.js "http://localhost:$PORT/fahrer/" "$OUT/x.png" 390 780 "$(cat scripts/test-fahrer-nachrichten.js)" 1500 | grep '^EVAL:' | tee "$OUT/ergebnis"
grep -q '"alle":true' "$OUT/ergebnis" && echo "Fahrerapp Nachrichten: alle Pruefungen bestanden" || { echo "FEHLGESCHLAGEN"; exit 1; }
