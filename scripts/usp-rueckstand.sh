#!/bin/bash
# Holt BEREITS ABGESCHLOSSENE Zustellungen erneut aus dem USP und schickt sie an HYDRAlink.
# Nur Zustellungen, die usp-bot.sh laut Log abgeschlossen hat ("Abgeschlossen: <ID>") -
# alles andere wird uebersprungen (usp-bot.sh holt sie regulaer, inkl. Telegram).
#   --liste          nur zaehlen/auflisten, nichts laden
#   --eine <ID>      genau eine Zustellung
#   --alle           alle abgeschlossenen
set -u
PROXY="http://localhost:9999"
LOG="/var/log/usp-bot.log"
URL="https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/post-eingang"
ANON="$(cat /root/.supabase-anon-key)"
KEY="$(cat /root/.post-eingang-key)"
NS='xmlns:aa="http://reference.e-government.gv.at/namespace/zustellung/autoabholung/phase2/20181206#"'
MODUS="${1:---liste}"

soap() { curl -s "$PROXY/soap" -X POST -H "Content-Type: application/soap+xml" --max-time 60 --data-raw "$1" | tr -d '\n\r'; }

ids_alle() {
  local start=0 limit=50 alle="" seite
  while :; do
    seite=$(soap "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:QueryDeliveriesRequest aa:Version=\"2.4.0-004\" $NS><aa:AllDeliveries><aa:Paging><aa:Start>$start</aa:Start><aa:Limit>$limit</aa:Limit></aa:Paging></aa:AllDeliveries></aa:QueryDeliveriesRequest></env:Body></env:Envelope>" \
      | grep -oP '(?:[\w:]*DeliveryID)>\K[^<]+')
    [ -z "$seite" ] && break
    alle="$alle"$'\n'"$seite"
    [ "$(echo "$seite" | grep -c .)" -lt "$limit" ] && break
    start=$((start + limit))
  done
  echo "$alle" | grep . | sort -u
}

eine() {
  local ID="$1"
  if ! grep -q "Abgeschlossen: $ID" "$LOG"; then echo "SKIP (nicht abgeschlossen): $ID"; return 0; fi
  local D; D=$(soap "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:GetDeliveryRequest aa:Version=\"2.4.0-004\" $NS><aa:DeliveryID>$ID</aa:DeliveryID></aa:GetDeliveryRequest></env:Body></env:Envelope>")
  local SENDER SUBJECT TS ATT FN TMP HTTP
  SENDER=$(echo "$D" | grep -oP '(?:[\w:]*FullName)>\K[^<]+' | head -1)
  SUBJECT=$(echo "$D" | grep -oP '(?:[\w:]*Subject)>\K[^<]+' | head -1)
  TS=$(echo "$D" | grep -oP '(?:[\w:]*DeliveryTimestamp)>\K[^<]+' | head -1)
  ATT=$(echo "$D" | grep -oP '(?:[\w:]*AttachmentID)>\K[^<]+' | grep -v '^$' | tail -1)
  FN=$(echo "$D" | grep -oP '(?:[\w:]*FileName)>\K[^<]+\.pdf' | head -1); FN="${FN:-dokument.pdf}"
  if [ -z "$ATT" ]; then echo "FEHLER keine AttachmentID: $ID"; return 1; fi
  TMP="/tmp/rueck_${ID}.pdf"
  curl -s "$PROXY/attachment?delivery_id=$ID&attachment_id=$ATT" -o "$TMP" --max-time 60
  if [ ! -s "$TMP" ]; then echo "FEHLER Download: $ID"; rm -f "$TMP"; return 1; fi
  HTTP=$(curl -s -o /tmp/rueck_antwort.json -w "%{http_code}" --max-time 180 -X POST "$URL" \
    -H "Authorization: Bearer $ANON" -H "x-post-key: $KEY" \
    -F "datei=@$TMP;type=application/pdf;filename=$FN" \
    --form-string "delivery_id=$ID" --form-string "usp_absender=$SENDER" \
    --form-string "usp_betreff=$SUBJECT" --form-string "zugestellt_am=$TS" --form-string "quelle=usp")
  echo "HTTP $HTTP $ID | $SENDER | $SUBJECT | $(head -c 200 /tmp/rueck_antwort.json)"
  rm -f "$TMP" /tmp/rueck_antwort.json
}

case "$MODUS" in
  --liste) IDS=$(ids_alle); echo "USP gesamt: $(echo "$IDS" | grep -c .)";
           echo "davon abgeschlossen laut Log: $(for i in $IDS; do grep -q "Abgeschlossen: $i" "$LOG" && echo x; done | grep -c x)";;
  --eine)  eine "$2";;
  --alle)  for i in $(ids_alle); do eine "$i"; sleep 2; done;;
  *) echo "Aufruf: $0 --liste | --eine <DeliveryID> | --alle"; exit 1;;
esac
