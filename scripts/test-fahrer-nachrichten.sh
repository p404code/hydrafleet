#!/usr/bin/env bash
# Browser-Test der Fahrerapp (Reiter Nachrichten) mit Attrappen statt Supabase – headless Chromium ueber scripts/shot.js.
#   bash scripts/test-fahrer-nachrichten.sh
# Prueft (test-fahrer-nachrichten.js, test-fahrer-anhaenge.js, test-fahrer-hinweis.js): Banner, Zaehler und App-Symbol bei neuer Buero-Nachricht; Fotos/Sprache anzeigen, senden, aufnehmen; Chat-Layout (Liste scrollt, Feld ueber Tab-Leiste, beim Tippen Leiste weg); Abmelden kuendigt das Push-Abo und leert den Chat-Zustand (Geraet wechselt den Fahrer);
#         Neuzeichnen behaelt den Entwurf; scheitert das Senden nach einem Neuzeichnen, steht der Text im neuen Feld.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=$((8800 + RANDOM % 100))
python3 -m http.server "$PORT" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
OUT="$(mktemp -d)"
for t in test-fahrer-nachrichten test-fahrer-anhaenge test-fahrer-hinweis; do
  node scripts/shot.js "http://localhost:$PORT/fahrer/" "$OUT/x.png" 390 780 "$(cat scripts/$t.js)" 1500 | grep '^EVAL:' | tee "$OUT/$t"
  grep -q '"alle":true' "$OUT/$t" || { echo "FEHLGESCHLAGEN: $t"; exit 1; }
done
echo "Fahrerapp Nachrichten: alle Pruefungen bestanden"
