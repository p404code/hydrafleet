# Datenprüfung vor der Fahrerapp — 2026-09-23

Nur gelesen: SQL gegen Supabase `pkxcwfkfaaorwnbdmylg`, Notion über MCP (Datenquellen
Fahrer `e2102b0d-…` und Fuhrpark `5e514b18-…`), Bot-Code aus
`.n8n-backup/berechnung-v15.js`. In Produktion wurde nichts geschrieben, auch nicht in Notion.
Telefonnummern sind unten gekürzt.

**Kurz:** Zwei Befunde aus der Übergabe stimmen nicht. Das betrifft die
**758,70 € von Bislan Madaev** (Punkt 4) und die Aussage, die **Dombaew-Altzeile
liege in Notion** (Punkt 2). Punkt 1 stimmt für 61 von 63 Fahrern ohne Einschränkung.
Punkt 5 ist für KW32–KW36 belegt.

---

## 1. Ist `fahrer.notion_fahrer_id` dieselbe Zahl wie Notion „Fahrer ID“?

**Ergebnis: ja, bei allen 63.** Das ist eine Vollprüfung, keine Stichprobe. Bei zwei Fahrern zeigt die
Nummer aber auf die falsche von zwei Notion-Seiten derselben Person.

- `notion_fahrer.notion_fahrer_id` wird aus `unique_id.number` der Spalte „Fahrer ID“
  gelesen (`supabase/functions/notion-sync/index.ts`, `nummer()`).
- Ich habe live in Notion alle 212 Fahrer-Seiten abgefragt (`SELECT url, "Fahrer ID"`) und
  sie über die Page-ID gegen die 63 aktiven `fahrer`-Zeilen gelegt. Ergebnis: **63/63 gleich**,
  und `notion_fahrer` hat 212 Zeilen mit 212 verschiedenen Nummern.
- Abfrage: `count(*) filter (where n_treffer=1)` = 63, `ohne_nid` = 0.

**Worauf man achten muss:** `fahrer.notion_fahrer_id` kommt **nicht** aus n8n. Den Wert setzt
`notion_zuordnung_aktualisieren()`, per Telefon oder Name, und zwar nur, wo das Feld leer ist
(`migrations/2026-09-22-notion-sync.sql`, Z. 103–135). Wenn es zwei Notion-Seiten mit demselben
Namen oder derselben Nummer gibt, entscheidet dieser Matcher. Zwei Fälle hat er falsch
entschieden. Als Prüfmerkmal dient die Notion-Seite, an der im Fuhrpark („Fahrer aktuell“) das
Auto hängt, das in `fahrer.kennzeichen` steht:

| fahrer | Name | `notion_fahrer_id` | Seite mit dem Auto | Befund |
|---|---|---|---|---|
| 642 | Murad Izrailov | **200** (Angemeldet, hat Telefon) | **245** (W 9911 TX, ohne Telefon) | Die Zeile kommt aus Seite 245, der Matcher hat 200 genommen |
| 1674 | Dschunid Saluev | **253** | **239** (W-5442TX) | gleiche Telefonnummer auf beiden Seiten, `nid desc` → 253 |

Weitere Namensdubletten in Notion, bei denen die ID heute **stimmt**, weil das Auto an der
gewählten Seite hängt: Alaudi Debizov 36/**192**, Aslan Nagaev 27/**191**, Musaitov Alichan
229/**230**, Ali Bijbulatov 228/**251**, Ivan Douchanov **278**/284, Ramzan (yutaev) 19/**292**,
Vakhtang Bisultanov **91**/224.
Ein Risiko bleibt bei **Vakhtang**. Legt n8n seine Zeile neu an, wählt der Matcher 224, denn beide
Seiten tragen dieselbe Nummer und es gilt `order by … nid desc`. Heute steht 91 in der Zeile, und
dort hängt auch W-4123TX.

Nebenbei aufgefallen, ohne Einfluss auf die ID: `fahrer.kennzeichen` ist teils veraltet
(Alaudi Debizov W 5549 TX, das in Notion Bahaa Nasef gehört; Elbanhawy W-7298TX, in Notion
Batyr Yevloev; Musikhanov W 4923 TX und Ali Harun W-5625TX, die es im Fuhrpark nicht mehr gibt).

**Was zu tun ist:**
- Das Büro legt in Notion je Person **eine** Seite fest und löscht die zweite oder benennt sie
  eindeutig um. Mindestens nötig bei Murad Izrailov (200/245) und Dschunid Saluev (239/253).
  Danach die `notion_fahrer_id` dieser zwei Zeilen neu setzen. Das ist ein Schreibvorgang und
  erst nach der Entscheidung dran.
- Solange das nicht passiert ist, gilt als Anmelde-ID die Nummer in `fahrer.notion_fahrer_id`,
  also Murad FHR-200 und Dschunid FHR-253. Das Büro muss genau diese Nummer herausgeben,
  **nicht** die der Notion-Seite mit dem Auto.

## 2. Das Dombaew-Duplikat (`fahrer` 633 und 639, Nr. 93)

| | **633 (Altzeile)** | **639 (aktuell)** |
|---|---|---|
| name | Aslam**b**ek Dombaew | Aslan**b**ek Dombaew |
| telefon | …9939 | …9939 (gleich) |
| kennzeichen | **W-937BTX** | **W-4115TX** |
| mietmodell / basis_miete | f11 / 450 | f12 / 500 |
| erstellt_am | 2026-01-05 23:31:40.91 | 2026-01-05 23:31:40.93 |
| Bolt-/Uber-Konten | 0 / 0 | 1 / 1 (Uber `365424ed…`) |
| `settlements` unter dem Namen | W19–W22 (f11, 450) | W02 … W38, seit W23 durchgehend (f12, 500) |

**633 ist die Altzeile.** In Notion gibt es **keine** Altzeile, die man löschen könnte:
- Es gibt genau eine Fahrer-Seite Nr. 93, „Aslanbek Dombaew“. Die Suche nach „Aslambek“ findet nur diese.
- Am Fuhrpark-Eintrag W-4115TX (RAV4, E&E, f12, 500) hängt als „Fahrer aktuell“ Seite 93.
- W-937BTX gibt es in Notion **nur in der Mypos-Datenbank** (Terminalname), im Fuhrpark nicht.

`fahrer` 633 hat also keine Quelle mehr in Notion. Die Zeile ist ein Überbleibsel in Supabase,
das der n8n-Fahrer-Sync nicht aufräumt. Das Innere dieses Workflows (`ERBnlIVSkteL90Bg`) ist über
MCP nicht einsehbar. Admin-Plan §5 Schritt 1 („Dombaew-Altzeile **in Notion** löschen“) ist
deshalb nicht umsetzbar.

Folgefehler: `settlement_fahrer()` nimmt bei gleicher Nummer die kleinste ID. Deshalb hängt
die Abrechnung von W38 an 633 („nur Abrechnung“) und das Uber-Konto an 639 („nur Plattform“).
Beide Zeilen stehen in `abrechnung_abgleich` mit 1.391,42 €. Geld fehlt dadurch nicht.

**Was zu tun ist:** In Notion nichts. Der Betreiber entscheidet, ob `fahrer` 633 **gelöscht**
oder auf `aktiv = false` gesetzt wird (ein Schreibzugriff auf `fahrer`, den ich nicht gemacht
habe). Löschen ist sicher: Die FKs stehen auf `ON DELETE SET NULL`, an 633 hängen keine
Plattformkonten, und der Bot liest nur `aktiv = true`. Danach prüfen, ob n8n die Zeile wieder
anlegt. Laut Notion dürfte das nicht passieren.

## 3. Drei Uber-Konten ohne `fahrer_id`

Alle drei liegen im KW38-Bericht. Der Cent-Abgleich mit `settlements.uber_fahrpreis` belegt
aber nur, **welche Abrechnungszeile** aus dem Konto entstanden ist. Die Person dahinter belegt
er nicht. Den Fahrer verrät erst `settlements.telefon`, das der Bot aus der gefundenen
`fahrer`-Zeile übernimmt (`berechnung-v15.js`, Z. 553).

| Uber-Konto (`driver_uuid`) | Uber-Tel. | Fahrpreis / gezahlt | Zeile in `settlements` W38 (Cent-genau) | Fahrer laut Bot | Notion |
|---|---|---|---|---|---|
| Suleiman Akhmadov `328bbdd4-6909-42f3-8e30-6c3ca4ad86d5` | …6087 | 386,66 / 332,39 | „Suleyman Akhmadov“, Tel. …7275, 386,66 / 332,39 | **2760**, per Fuzzy-Match (≥ 0,92) | **166** Suleyman Akhmadov |
| Bislan Madaev `557a9bfc-882e-408f-91fb-7c4b5aacf198` | …9340 | 348,58 / 232,94 | „Bislan Madaev“, Tel. …0070, 348,58 / 232,94 | **1870 Aslan Abubakarov**, über `name_aliases`: `bislan madaev → Aslan Abubakarov` | keine Seite „Madaev“; 227 = Abubakarov |
| Ossama Eid `4ee57f15-1a2c-4ed6-bcd3-65bc03361b47` | …4884 | 1.073,12 / 775,95 | „Ossama Eid“, Tel. leer, `WARNUNG_KEIN_FAHRER` (auch W37: 78,61) | keiner | **115** Ossama Eid, Angemeldet, **ohne Fahrzeug** |

Die Befunde im Einzelnen:
- **Suleiman → 166 ist belegt.** Die beiden Bolt-Konten „Suleyman Akhmadov“ hängen schon an
  2760, und der Bot rechnet das Uber-Geld seit jeher auf 2760 ab. Die Telefonnummern bei Uber,
  Bolt und Notion unterscheiden sich allerdings alle drei.
- **Bislan Madaev ist nicht belegt.** Er ist nur über einen Alias an Abubakarov gebunden, den
  jemand im Büro angelegt hat. Er fuhr W 204TX (Uber, 23 Fahrten am 19. und 20.09.), dasselbe
  Auto wie Abubakarov (Bolt, 53 Fahrten vom 15. bis 19.09.). Eine eigene Notion-Seite hat er
  nicht. Ob beide dieselbe Person sind, weiss nur das Büro. Siehe Punkt 4.
- **Ossama Eid:** In Notion gibt es ihn (Nr. 115), in `fahrer` aber keine Zeile mit
  `notion_fahrer_id = 115`. Vermutlich legt n8n nur Fahrer an, die im Fuhrpark ein Auto haben:
  Seite 115 hat keine Fuhrpark-Relation, und `fahrer` übernimmt `kennzeichen` und `mietmodell`
  vom Auto. Das ist eine Hypothese, der Workflow `ERBnlIVSkteL90Bg` ist über MCP nicht einsehbar. Eine
  Handzuordnung zu 115 wäre deshalb heute **wirkungslos**, weil der Join in Admin-Plan §3 eine
  aktive `fahrer`-Zeile verlangt. Nebenbei: Er hat zwei Bolt-Konten (`9a757e6b…`, `0ab815e4…`)
  mit 0 Fahrten.

**SQL-Entwurf, NICHT ausgeführt.** Die Tabelle `zuordnung_manuell` gibt es noch nicht
(`to_regclass` = null). Die Einträge kommen in die Migration nach Admin-Plan §3:

```sql
insert into public.zuordnung_manuell (anbieter, driver_uuid, notion_fahrer_id, gesetzt_von) values
  ('bolt', '9877577f-d44a-4c3c-8114-4c701e38547f', 282, 'Migration'),          -- Bestand (Admin-Plan)
  ('uber', '328bbdd4-6909-42f3-8e30-6c3ca4ad86d5', 166, 'Migration'),          -- Suleiman -> Suleyman Akhmadov, belegt
  ('uber', '4ee57f15-1a2c-4ed6-bcd3-65bc03361b47', 115, 'Migration')           -- Ossama Eid; greift erst, wenn fahrer mit nid 115 existiert
  -- ('uber', '557a9bfc-882e-408f-91fb-7c4b5aacf198', 227, 'Migration')        -- Bislan Madaev -> Abubakarov: NUR wenn Büro bestätigt, dass es dieselbe Person ist
on conflict (anbieter, driver_uuid) do nothing;
```

**Was zu tun ist:**
1. Das Büro klärt, wer Bislan Madaev ist.
2. Damit Ossama Eid greift, braucht er in Notion ein Fahrzeug („Fahrer aktuell“). Sonst
   bekommt er keine `fahrer`-Zeile. Dann `WARNUNG_KEIN_FAHRER` auflösen. Ob er ein Auto
   mietet, entscheidet der Betreiber.

## 4. Bislan Madaev KW38: „758,70 € Bolt nicht abgerechnet“ — stimmt nicht

**Die 758,70 € sind abgerechnet, und zwar auf „Aslan Abubakarov“.** Der Befund in Übergabe und
Protokoll entsteht im View `abrechnung_abgleich`, der denselben Betrag doppelt zählt.

Die Belege:
- Die 57 Bolt-Aufträge kommen von den Bolt-Konten **„Aslan Abubakarov“** (`59ab9359…` SERDO: 53
  Fahrten, 707,10 €; `58db60b6…` EH Limo: 4 Fahrten, 51,60 €). Beide hängen an `fahrer` 1870.
  Ein Bolt-Konto „Madaev“ gibt es nicht.
- In `settlements` W38 steht „Aslan Abubakarov“ mit `bolt_brutto` **758,70** und
  `bolt_auszahlung` **269,98**.
- Alle Bolt-Aufträge W38 zusammen ergeben **16.990,60 €**. Genau so viel steht als Summe von
  `settlements.bolt_brutto` W38 (ohne `__`-Zeilen). Der View zeigt als API-Summe dagegen 17.749,30,
  das sind 16.990,60 plus 758,70.
- Ursache: Die Zeile „Bislan Madaev“ trägt Abubakarovs Telefonnummer (…0070). Deshalb liefert
  `settlement_fahrer()` auch für sie 1870, und der View hängt die API-Zahlen von 1870 an
  **beide** Abrechnungszeilen.
  Die Zahl 17.749,30 im Protokoll (Abschnitt „Korrektur zu den Bolt-Summen“) ist deshalb falsch.

Bar und Karte, KW38, beide Konten Abubakarov (`bolt_orders`):

| | Fahrten | ride_price | net_earnings | Provision |
|---|---|---|---|---|
| bar | 30 | 352,60 | 289,13 | 63,47 |
| App | 27 | 406,10 | 333,45 | 72,65 |
| **Summe** | **57** | **758,70** | **622,58** | **136,12** |

Trinkgeld 2,50 € (App). Die Auszahlung rechnet sich so: 622,58 minus 352,60 bar =
**269,98** = `bolt_auszahlung`, stimmt auf den Cent.

**Der echte Geldpunkt ist eine doppelte Pauschale.** Beide W38-Zeilen haben `miete = 230`:

| Zeile | bolt_ausz. | uber_ausz. | wir_bekommen | Abzug | auszahlung |
|---|---|---|---|---|---|
| Aslan Abubakarov | 269,98 | 98,62 | 368,60 | 230,00 | 138,60 |
| Bislan Madaev | 0,00 | 232,94 | 232,94 | 230,00 | 2,94 |
| **ausgezahlt** | | | | **460,00** | **141,54** |

Wenn Bislan Madaev Abubakarov ist, wie es der Alias sagt, muss es **eine** Zeile sein.
Nach der Bot-Logik (`berechnung-v15.js` Z. 533–549: `wir_bekommen = bolt_auszahlung +
uber_auszahlung + mypos`; bei `fix` mit `prozent_satz = 0` kein Prozentabzug; `auszahlung =
wir_bekommen − miete`):
`269,98 + 98,62 + 232,94 = 601,54 − 230,00 =` **371,54 €**. Ausgezahlt wurden 141,54 €,
es fehlen also **230,00 € zugunsten des Fahrers**.

Sind es zwei verschiedene Personen, ist der Alias falsch. Dann wurde Bislan Madaev Abubakarovs
230-€-Pauschale abgezogen. Was er selbst zahlen müsste, lässt sich nicht ablesen, weil es ihn in
Notion nicht gibt.

Dazu gehört auch: Laut Notion fährt W 204TX (550 €, f12) noch **Ramzan Alibekov**. `fahrer` 679 hat
bis W37k Pauschale 550 gezahlt, **in W38 hat er keine Abrechnungszeile**. In KW38 hat also niemand die
550 € für W 204TX gezahlt.

**Was der Betreiber entscheidet:**
- Ist Bislan Madaev dieselbe Person wie Abubakarov? Wenn ja: 230,00 € Gutschrift in KW38, zum
  Beispiel als `korrektur`, und die Frage aus Punkt 6 zur Pauschale. Wenn nein: den Alias löschen,
  ihn in Notion anlegen und seine Woche neu rechnen.
- Eine „Nachverrechnung der 758,70 €“ entfällt.

## 5. Bolt-Wochenverschiebung bis KW36 — belegt

`bolt_orders` reicht zurück bis **KW32** (erster Auftrag 02.08.2026 22:01 UTC). Abgeglichen
wurde je Fahrer der Wert `ride_price + cancellation_fee` gegen `settlements.bolt_brutto` (Fahrer
über `bolt_drivers.fahrer_id` und `settlement_fahrer()`), einmal gegen dieselbe Woche, einmal gegen
die Folgewoche:

| Umsatzwoche (API) | Fahrer | cent-genau, gleiche Woche | cent-genau, Folgewoche | API-Summe | settlements der Folgewoche |
|---|---|---|---|---|---|
| KW32 | 30 | 0 | **28** (W33) | 16.017,30 | 16.024,50 |
| KW33 | 29 | 0 | **28** (W34) | 16.064,40 | 16.064,40 |
| KW34 | 28 | 0 | **27** (W35) | 15.497,90 | 15.696,60 |
| KW35 | 33 | 0 | **32** (W36) | 15.554,30 | 15.551,30 |
| KW36 | 35 | 0 | **32** (**W37k**), 0 in W37 | 19.426,90 | 18.998,48 |
| KW37 | 35 | **35** | 0 | 17.579,00 | = W37 17.579,00 |
| KW38 | 30 | **30** | 0 | 16.990,60 | = W38 16.990,60 |

**Belegt:** KW32–KW36 stehen jeweils eine Woche zu spät in `settlements`. KW37 und KW38
stimmen. Die Umsätze von KW36 stehen unter **`2026-W37k`**. Die Commit-Nachricht von `4885cb0`
sagt dagegen „auf 2026-W36k umbenannt“, in der DB steht aber W37k.
Für die Wochen vor KW32 gibt es keine API-Daten. Das Importdatum passt aber lückenlos zum
selben Muster. Bei **jeder** Woche von W02 bis W36 liegt `min(created_at)` in der Wiener
ISO-Woche, die das Label nennt. Die Umsätze stammen also jeweils aus der Vorwoche. Ab W37 liegt
der Import in der Woche nach dem Label.
Das betrifft die ganze Abrechnungszeile (Uber und myPOS eingeschlossen), nicht nur Bolt, weil
das Label beim Upload vergeben wird. Mit Uber lässt es sich nicht gegenprüfen: `uber_reports`
hat nur W38.

Commit `4885cb0` (11.09.2026) stellt nur die Vorauswahl im Upload-Dialog von „laufende Woche“
auf „ISO-Vorwoche“ um. Die alte Formel ergab 2026 dieselben Nummern wie ISO. Der Fehler lag also
in der Vorauswahl, nicht in der Berechnung der Wochennummer.

**Was zu tun ist:** Es fehlt kein Geld, nur die Beschriftung ist falsch. Für die Fahrerapp v1
(die letzten 3 freigegebenen Wochen, offene Beträge ab KW37) betrifft das nur **`2026-W37k`
= Umsatzwoche KW36**. Das muss in der App so heissen oder vor der Freigabe umbenannt werden.
Ob alte Labels in `settlements` umgeschrieben werden, entscheidet der Betreiber. Mein Vorschlag:
nicht umschreiben, sondern in der Anzeige vermerken.

## 6. W 755 TX / W 580CTX und die Pauschale von Abubakarov — noch nicht korrigiert

Notion-Fuhrpark, heute live abgefragt:

| Kennzeichen | Fahrer aktuell (Notion) | Pauschale | fährt laut Plattform KW38 |
|---|---|---|---|
| W 755 TX (Corolla 20) | Khozhakhmed Visaitov (271) | 240 fix | **Aslan Nagaev** (Bolt 45, Uber 120 Fahrten) |
| W 580CTX (Prius+) | Aslan Nagaev (191) | 200 fix | **Khozhakhmed Visaitov** (Bolt 24, Uber 82) |
| SW-88FTX (Audi A4, FA. „Abgemeldet“) | Aslan Abubakarov (227) | 230 fix | niemand |
| W 204TX (Corolla 23) | **Ramzan Alibekov** (202) | 550 f12 | Abubakarov (Bolt 53) und Bislan Madaev (Uber 23) |

**Beide Punkte sind unverändert falsch.** Neu hinzu kommt: W 204TX ist in Notion noch Ramzan
Alibekov zugeordnet. Die Korrektur für Abubakarov heisst also nicht nur „Pauschale 550“, sondern
das Fahrzeug W 204TX **von Alibekov auf Abubakarov umhängen** und SW-88FTX lösen.

Und: `fahrer` 649 (Visaitov) hat `basis_miete` **230**, der Fuhrpark sagt für W 755 TX aber 240.
Die Abrechnungen W36–W38 zogen 230 ab. `fahrer` ist hier also schon gegenüber Notion veraltet.
Die Zahl im Protokoll („zahlt 240“) stimmt damit nicht mit dem tatsächlich abgezogenen Betrag.
Nach dem Tausch zahlt Nagaev 240 statt 200 (+40 €/Woche) und Visaitov 200 statt 230 (−30 €/Woche).

**Was zu tun ist (Büro, in Notion):** W 755 TX → Nagaev, W 580CTX → Visaitov, W 204TX →
Abubakarov, SW-88FTX lösen. Danach prüfen, ob n8n `fahrer.kennzeichen` und `basis_miete`
nachzieht. Beim Visaitov-Wert 230 statt 240 hat es das offenbar nicht getan. Ob rückwirkend
nachverrechnet wird, entscheidet der Betreiber.

---

### Verwendete Abfragen (Auszug)

- P1: Join `fahrer` × `notion_fahrer` über `notion_fahrer_id` mit Zählung der Treffer über
  Telefon und Name; Notion-SQL `SELECT url, "Fahrer ID"` auf `collection://e2102b0d-…`;
  Fuhrpark `SELECT Kennzeichen, "Fahrer aktuell" … WHERE "Fahrer aktuell" IS NOT NULL`, per VALUES
  gegen `fahrer.kennzeichen`.
- P2: `select … from fahrer where id in (633,639)`, `settlements where fahrer_name ilike '%dombae%'`,
  `pg_get_functiondef('settlement_fahrer')`.
- P3/P4: `uber_drivers ⋈ uber_reports where fahrer_id is null`, `name_aliases`,
  `bolt_orders group by payment_method` für die beiden Abubakarov-UUIDs,
  `sum(bolt_api_brutto) from abrechnung_abgleich` (17.749,30) gegen `sum(ride_price+cancellation_fee)
  from bolt_orders where woche='2026-W38'` (16.990,60).
- P5: `bolt_orders ⋈ bolt_drivers` je Woche und Fahrer gegen `settlements` (gleiche Woche und
  Folgewoche); `to_char(min(created_at) at time zone 'Europe/Vienna','IYYY-"W"IW')` je Label.
