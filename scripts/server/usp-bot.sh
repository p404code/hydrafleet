#!/bin/bash
# USP Mein Postkorb - Automatische Abholung HYDRAFLEET
# Läuft stündlich via Cronjob

BOT="<im Server-Original>"
CHAT="<im Server-Original>"
PROXY="http://localhost:9999"
LOG="/var/log/usp-bot.log"
LOCKFILE="/tmp/usp-bot.lock"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# Lock gegen Doppelausführung
if [ -f "$LOCKFILE" ]; then
    LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null)
    if kill -0 "$LOCK_PID" 2>/dev/null; then
        log "WARNUNG: Bereits eine Instanz läuft (PID $LOCK_PID), abbruch."
        exit 1
    fi
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

log "=== USP-Bot gestartet ==="

# Neue Nachrichten abfragen
RESPONSE=$(curl -s "$PROXY/soap" -X POST -H "Content-Type: application/soap+xml" --data-raw '<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header/><env:Body><aa:QueryDeliveriesRequest aa:Version="2.4.0-004" xmlns:aa="http://reference.e-government.gv.at/namespace/zustellung/autoabholung/phase2/20181206#"><aa:NewDeliveriesOnly><aa:Limit>100</aa:Limit></aa:NewDeliveriesOnly></aa:QueryDeliveriesRequest></env:Body></env:Envelope>' --max-time 30 | tr -d '\n\r')

# DeliveryIDs extrahieren
DELIVERY_IDS=$(echo "$RESPONSE" | grep -oP '(?:[\w:]*DeliveryID)>\K[^<]+')
COUNT=$(echo "$DELIVERY_IDS" | grep -c .)

if [ -z "$DELIVERY_IDS" ] || [ "$COUNT" -eq 0 ]; then
    log "Keine neuen Nachrichten"
    exit 0
fi

log "Gefunden: $COUNT neue Zustellung(en)"

# Jede Zustellung verarbeiten
for DELIVERY_ID in $DELIVERY_IDS; do
    log "Verarbeite: $DELIVERY_ID"
    
    # Details abrufen (einzeilig für zuverlässiges grep)
    DETAILS=$(curl -s "$PROXY/soap" -X POST -H "Content-Type: application/soap+xml" --data-raw "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:GetDeliveryRequest aa:Version=\"2.4.0-004\" xmlns:aa=\"http://reference.e-government.gv.at/namespace/zustellung/autoabholung/phase2/20181206#\"><aa:DeliveryID>$DELIVERY_ID</aa:DeliveryID></aa:GetDeliveryRequest></env:Body></env:Envelope>" --max-time 30 | tr -d '\n\r')
    
    # Metadaten extrahieren
    SENDER=$(echo "$DETAILS" | grep -oP '(?:[\w:]*FullName)>\K[^<]+' | head -1)
    SUBJECT=$(echo "$DETAILS" | grep -oP '(?:[\w:]*Subject)>\K[^<]+' | head -1)
    TIMESTAMP=$(echo "$DETAILS" | grep -oP '(?:[\w:]*DeliveryTimestamp)>\K[^<]+' | head -1 | cut -c1-16 | tr 'T' ' ')
    TS_ROH=$(echo "$DETAILS" | grep -oP '(?:[\w:]*DeliveryTimestamp)>\K[^<]+' | head -1)
    
    # PDF Attachment finden (Mailbody ignorieren)
    ATT_ID=$(echo "$DETAILS" | grep -oP '(?:[\w:]*AttachmentID)>\K[^<]+' | grep -v "^$" | tail -1)
    FILENAME=$(echo "$DETAILS" | grep -oP '(?:[\w:]*FileName)>\K[^<]+\.pdf' | head -1)
    ATTCOUNT=$(echo "$DETAILS" | grep -oP '(?:[\w:]*FileName)>\K[^<]+\.pdf' | wc -l)
    
    # Fallback Dateiname
    if [ -z "$FILENAME" ]; then
        FILENAME=$(echo "$DETAILS" | grep -oP '(?:[\w:]*FileName)>\K[^<]+' | grep -iv "mailbody\|body\.txt" | head -1)
    fi
    if [ -z "$FILENAME" ]; then
        FILENAME="dokument.pdf"
        ATTCOUNT=0
    fi

    log "  Absender: $SENDER | Betreff: $SUBJECT | AttachmentID: $ATT_ID | Datei: $FILENAME"
    
    # PDF herunterladen
    PDF_OK=false
    if [ -n "$ATT_ID" ]; then
        TMPFILE="/tmp/${DELIVERY_ID}_${FILENAME}"
        curl -s "$PROXY/attachment?delivery_id=$DELIVERY_ID&attachment_id=$ATT_ID" \
            -o "$TMPFILE" --max-time 60
        
        if [ -s "$TMPFILE" ]; then
            PDF_OK=true
            log "  PDF heruntergeladen: $FILENAME ($(du -h "$TMPFILE" | cut -f1))"
        else
            log "  FEHLER: PDF Download fehlgeschlagen (ATT_ID=$ATT_ID)"
            rm -f "$TMPFILE"
        fi
    else
        log "  FEHLER: Keine AttachmentID gefunden"
        log "  DETAILS-SNIPPET: $(echo "$DETAILS" | head -c 500)"
    fi

    # Nur senden wenn PDF erfolgreich heruntergeladen
    if [ "$PDF_OK" = true ]; then
        # Anhang-Liste für Nachricht
        if [ "$ATTCOUNT" -gt 0 ]; then
            ATTACH_INFO="📎 Anhänge: $ATTCOUNT Datei(en)
- $FILENAME"
        else
            ATTACH_INFO="📎 Anhänge: 1 Datei(en)
- $FILENAME"
        fi

        MSG="📬 HYDRAFLEET USP POSTKORB
━━━━━━━━━━━━━━━━━━━━━━

📄 Neue behördliche Zustellung

🏛️ Absender: $SENDER
📋 Betreff: $SUBJECT
📅 Zugestellt: $TIMESTAMP
🔖 ID: ${DELIVERY_ID:0:8}...

$ATTACH_INFO

━━━━━━━━━━━━━━━━━━━━━━
⚡ Automatisch abgeholt von USP-Bot"

        # Textnachricht senden
        curl -s -X POST "https://api.telegram.org/bot$BOT/sendMessage" \
            -H "Content-Type: application/json" \
            -d "{\"chat_id\":\"$CHAT\",\"text\":\"$MSG\"}" > /dev/null

        # PDF senden
        curl -s -X POST "https://api.telegram.org/bot$BOT/sendDocument" \
            -F "chat_id=$CHAT" \
            -F "document=@$TMPFILE;filename=$FILENAME" > /dev/null
        
        log "  Telegram gesendet: Text + PDF"
        # HYDRAlink (Post & Strafen) - darf Telegram/CloseDelivery nie blockieren
        if [ -r /root/.post-eingang-key ] && [ -r /root/.supabase-anon-key ]; then
            HL=$(curl -s -o /dev/null -w "%{http_code}" --max-time 180 -X POST \
                "https://pkxcwfkfaaorwnbdmylg.supabase.co/functions/v1/post-eingang" \
                -H "Authorization: Bearer $(cat /root/.supabase-anon-key)" \
                -H "x-post-key: $(cat /root/.post-eingang-key)" \
                -F "datei=@$TMPFILE;type=application/pdf;filename=$FILENAME" \
                --form-string "delivery_id=$DELIVERY_ID" --form-string "usp_absender=$SENDER" \
                --form-string "usp_betreff=$SUBJECT" --form-string "zugestellt_am=$TS_ROH" \
                --form-string "quelle=usp" || true)
            log "  HYDRAlink: HTTP $HL"
        fi
        rm -f "$TMPFILE"
    else
        # Fehlermeldung an Telegram damit man es mitbekommt
        curl -s -X POST "https://api.telegram.org/bot$BOT/sendMessage" \
            -H "Content-Type: application/json" \
            -d "{\"chat_id\":\"$CHAT\",\"text\":\"⚠️ USP-Bot: Zustellung von $SENDER ($SUBJECT) konnte nicht mit PDF geladen werden. Bitte manuell prüfen!\"}" > /dev/null
        log "  WARNUNG: Telegram ohne PDF gesendet - nur Fehlermeldung"
    fi
    
    # Als gelesen markieren
    CLOSE_RESP=$(curl -s "$PROXY/soap" -X POST -H "Content-Type: application/soap+xml" --data-raw "<?xml version=\"1.0\"?><env:Envelope xmlns:env=\"http://www.w3.org/2003/05/soap-envelope\"><env:Body><aa:CloseDeliveryRequest aa:Version=\"2.4.0-004\" xmlns:aa=\"http://reference.e-government.gv.at/namespace/zustellung/autoabholung/phase2/20181206#\"><aa:DeliveryID>$DELIVERY_ID</aa:DeliveryID></aa:CloseDeliveryRequest></env:Body></env:Envelope>" --max-time 30)
    
    if echo "$CLOSE_RESP" | grep -qi "error\|fault"; then
        log "  WARNUNG: CloseDelivery möglicherweise fehlgeschlagen"
    fi
    
    log "  Abgeschlossen: $DELIVERY_ID"
done

log "=== USP-Bot fertig: $COUNT Zustellung(en) verarbeitet ==="
