# Bankdaten in der Fahrerapp — Design (Teil A)

**Datum:** 2026-10-15
**Stand:** Entwurf vom Betreiber freigegeben („ja passt … zuerst A“). Teil B (Auszahlen über
Revolut) ist entworfen, aber ausdrücklich **nicht** zu bauen — nur festgehalten, unten.

## Ziel

IBANs der Fahrer sammeln und in HYDRAlink/der Datenbank haben. Der Fahrer sieht und pflegt
seine Bankdaten in der Fahrerapp und bestätigt sie jede Woche. Die Bestätigung ist später die
Voraussetzung für die automatische Auszahlung (Teil B).

Heute: ein öffentliches Formular „REVOLUT BANK DATEN“ (`~/Projects/iban-formular`, Netlify,
ohne Anmeldung) schreibt mit dem anon-Key in `fahrer_iban` — 13 Einträge seit 06.10.2026, alle
Status `neu`, an keinen Fahrer gebunden (nur Name + Telefon).

## Entscheidungen des Betreibers (13.–15.10.)

| Frage | Entscheidung |
|---|---|
| Kein Bestätigen / keine App | Keine Überweisung, Fahrer wird wie bisher bar oder von Hand bezahlt |
| Neue oder geänderte IBAN | **Gilt sofort**, ohne Büro-Freigabe — bewusst so entschieden, obwohl damit jeder mit der PIN eines Fahrers das Ziel des Geldes ändern kann |
| Auslösen der Überweisung (Teil B) | Erst Knopf im Dashboard, später fester Zeitpunkt |
| Betrag (Teil B) | „Du bekommst“ der Woche, nur positiv, vor dem Senden änderbar/abwählbar |
| Zahlende Konten (Teil B) | Revolut Business von **Serdo** und **E&E**; EH nicht |
| Verteilung (Teil B) | Je nach Kontostand; jeder Fahrer ganz von einem Konto, nie geteilt |

## 1. Daten

Schlüssel ist die **Notion-Fahrer-Nr.** (`notion_fahrer_id`) wie bei `fahrer_app_zugang` und
`zuordnung_manuell` — sie bleibt, auch wenn n8n die `fahrer`-Zeile neu anlegt.

**`fahrer_bank`** — aktuelle Bankdaten, eine Zeile je Fahrer:
`notion_fahrer_id` (PK), `kontoinhaber`, `iban` (ohne Leerzeichen, Großbuchstaben), `bic`,
`revtag`, `geaendert_am`, `geaendert_von` (`fahrer` | Büro-Name | `formular`).

**`fahrer_bank_verlauf`** — jede Änderung, nie gelöscht oder geändert (Trigger sperrt wie beim
Kassabuch): `id`, `notion_fahrer_id`, `zeit`, `von`, alte und neue Werte aller vier Felder.

**`bank_bestaetigung`** — je Woche und Fahrer: `woche`, `notion_fahrer_id`, `iban`,
`kontoinhaber` (Momentaufnahme), `betrag` (Momentaufnahme „Du bekommst“ zur Info),
`bestaetigt_am`. PK (`woche`, `notion_fahrer_id`). Ändert der Fahrer danach die IBAN, wird die
Bestätigung der offenen Woche gelöscht und muss neu erfolgen — bestätigt ist immer genau eine IBAN.

RLS auf allen drei: Büro (`is_app_user()`) liest; Fahrer sehen nichts direkt, nur über die RPCs.
Alle drei kommen ins Protokoll (Trigger `protokoll_mitschreiben`).

## 2. Prüfung der IBAN

Im Browser und in der Datenbank gleich: Leerzeichen raus, Großbuchstaben, Länderkennung + 2
Ziffern, Länge je Land (mindestens AT, DE, LT, BG, RO, HR, SK, CZ, HU, PL, SI, IT, ES, FR, NL,
BE, GB, IE, sonst 15–34), **Prüfziffer mod 97 = 1**. BIC optional, 8 oder 11 Zeichen. Revtag
optional, `@` + 2–40 Zeichen wie im Formular. Kontoinhaber Pflicht, 2–140 Zeichen.
Die Prüfung liegt als reine Funktion in einer Datei, die Browser und Test gemeinsam nutzen
(Muster `_shared/post-logik.ts`), und zusätzlich als SQL-Funktion `iban_gueltig()` im RPC.

## 3. Fahrerapp

**Startseite, ganz oben** (vor allem anderen), eine Karte je nach Lage:

| Lage | Karte |
|---|---|
| Keine Bankdaten | „Bankdaten fehlen — damit wir dir überweisen können.“ → **Eintragen** |
| Neueste freigegebene Woche, „Du bekommst“ > 0, nicht bestätigt | „Auszahlung KW41: 662,40 € an LT12 •••• 3456 · Kontoinhaber“ → **Stimmt** · **IBAN ändern** |
| Bestätigt | „KW41 bestätigt · LT12 •••• 3456“ (klein, grün) |
| Betrag ≤ 0 oder keine freigegebene Woche | keine Bestätigungskarte; Bankdaten nur unter „Mehr“ |

Die IBAN erscheint in Vierergruppen; auf der Karte gekürzt, in der Ansicht „Bankdaten“ voll.

**Mehr → Bankdaten:** zeigt Kontoinhaber, IBAN, BIC, Revtag und „zuletzt geändert am“;
**Ändern** öffnet das Formular (gleiche Felder wie das öffentliche Formular, Prüfung wie oben,
Fehler direkt am Feld). Nach dem Speichern zurück zur Startseite, wo die Bestätigung offen ist.

Büro-Vorschau (`?vorschau=<fahrer_id>`) zeigt die Karten, Knöpfe sind gesperrt wie bisher.

**RPCs** (Fahrer-JWT, immer nur der eigene Fahrer über `fahrer_app_ziel`/`mein_fahrer_id`):
- `fahrer_app_bank()` → aktuelle Bankdaten + Bestätigungsstand der neuesten freigegebenen Woche
- `fahrer_bank_setzen(kontoinhaber, iban, bic, revtag)` → prüft, schreibt `fahrer_bank` und
  `fahrer_bank_verlauf`, löscht die Bestätigung der offenen Woche
- `bank_bestaetigen(woche)` → nur die neueste freigegebene Woche, nur wenn Bankdaten da sind
  und „Du bekommst“ > 0; schreibt die Momentaufnahme

## 4. Dashboard

Reiter **Fahrer → App**, je Fahrer im Detail ein Block „Bankdaten“: IBAN, Kontoinhaber,
zuletzt geändert (von wem), Bestätigung der neuesten Woche (ja/nein), Verlauf aufklappbar.
In der Fahrerliste ein Filter „Bankdaten fehlen“ und eine Spalte „KW bestätigt“.
Das Büro kann Bankdaten für einen Fahrer eintragen oder ändern (gleiche Prüfung,
`geaendert_von` = Büro-Name) — z. B. für die Übernahme. Bestätigen kann nur der Fahrer.

## 5. Übernahme aus dem Formular

Einmalig: die Einträge aus `fahrer_iban` über die Telefonnummer (`tel_key`) dem aktiven
Fahrer zuordnen und als `fahrer_bank` übernehmen (`geaendert_von = 'formular'`), nur wenn die
IBAN die Prüfung besteht; je Fahrer der neueste Eintrag. Was nicht eindeutig passt, bleibt in
`fahrer_iban` und erscheint im Dashboard als „aus Formular, nicht zugeordnet“ mit Knopf
„Fahrer zuordnen“. `fahrer_iban` bleibt als Rohdaten erhalten.

Das öffentliche Formular wird abgeschaltet, sobald die App-Version läuft und die Fahrer
Bescheid wissen — der Betreiber sagt, wann. Danach: anon-Insert-Policy auf `fahrer_iban`
entfernen, Netlify-Seite durch einen Hinweis „Bankdaten jetzt in der App“ ersetzen.

## 6. Abnahme

1. RPC-Tests lokal (PGlite): fremder Fahrer kann nichts lesen/setzen, ungültige IBAN wird
   abgelehnt (falsche Prüfziffer, falsche Länge), Änderung schreibt Verlauf und löscht die
   offene Bestätigung, Bestätigen ohne Bankdaten/bei Betrag ≤ 0/für alte Woche scheitert,
   Verlauf ist nicht änderbar.
2. IBAN-Prüfung mit echten Beispielen (AT, DE, LT) und je einem kaputten.
3. Fahrerapp auf 390 px, hell und dunkel: alle vier Kartenlagen, Formular mit Fehlern.
4. Dashboard: Block Bankdaten, Filter, Büro-Eintrag.
5. Übernahme: Anzahl übernommen / nicht zugeordnet stimmt mit `fahrer_iban` überein.

## 7. Nicht in Teil A

Überweisen, Revolut, Kontostände; Benachrichtigung bei IBAN-Änderung; Büro-Freigabe neuer IBANs.

---

## Teil B — Auszahlen über Revolut (festgehalten, nicht bauen)

- Reiter **Auszahlungen** unter Abrechnung: je Woche alle Fahrer mit „Du bekommst“ > 0, Betrag
  änderbar, IBAN bestätigt ja/nein, Konto Serdo/E&E, Haken zum Abwählen.
- Kontostände beider Revolut-Konten live; Verteilung: jeder Fahrer ganz von einem Konto, kein
  Konto überzogen, verschiebbar; was nicht passt, bleibt offen und markiert.
- Knopf **Auszahlungen senden** → Edge Function legt je Konto einen **Zahlungsentwurf** an
  (Gegenpartei bei Bedarf anlegen), der Betreiber schickt ihn in der Revolut-App ab.
  `/pay` (direkt) nur mit Company-Tarif — später.
- Tabelle `auszahlungen` (Woche, Fahrer, Betrag, Konto, IBAN, Revolut-IDs, Status), nie zweimal
  je Woche und Fahrer; Status von Revolut nachziehen.
- Zugang je Revolut-Konto (Zertifikat + Zustimmung) im Vault; Einrichtungsanleitung für den Betreiber.
- Später: fester Zeitpunkt statt Knopf.
