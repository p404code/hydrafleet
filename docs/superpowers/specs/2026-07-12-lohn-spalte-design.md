# Design: Lohn-Spalte in Abrechnungen

**Datum:** 2026-07-12
**Status:** Genehmigt (MVP)
**Betrifft:** `dashboard.html` (Root — deployte Datei), `settlements`-Tabelle

## Problem / Ziel

Fahrer bekommen künftig einen Teil ihres Geldes als **offiziellen Lohn per Banküberweisung** aufs Konto. Da dieser Lohn bereits ausbezahlt wurde, muss er als **Durchlaufposten** von der Bar-Auszahlung abgezogen werden. Die bestehende, rechtlich relevante Berechnung (Umsatz, Miete/Pauschale, %-Abzug) bleibt **unverändert**.

```
Netto-Auszahlung (bar) = wir_bekommen − Miete − %Abzug − Lohn
                       = (bisherige auszahlung) − Lohn
```

Beispiel: 1000 Umsatz − 200 Miete − 400 Lohn = **400 €** bar. Kann auch negativ werden (Fahrer zahlt bar drauf).

## Scope (MVP)

- Lohn wird **manuell inline** pro Fahrer/Woche eingetragen.
- **Kein** Abschluss-/Lock-Schritt — Lohn ist sofort persistent und jederzeit editierbar (Variante B).
- **Kein** PDF-Import mit Fuzzy-Matching (bewusst später).
- **Keine** Integration mit „Müssen zahlen".

## Nicht-Ziele

- PDF-Lohn-Import (Fuzzy-Name-Matching) — spätere Iteration.
- „Müssen zahlen"-Integration für Lohn-bedingte Minusbeträge.
- Server-seitige Erzwingung der Schreibrechte (RLS/RPC) — siehe Berechtigung.

## Datenmodell

Neue Spalte auf `settlements`:

```sql
ALTER TABLE settlements ADD COLUMN lohn numeric DEFAULT 0;
```

- Default `0`, nullable (als `0` behandelt).
- Der gespeicherte `auszahlung`-Wert bleibt **roh** (vor Lohn). So bleiben AbrechnungsBot und „Müssen zahlen" unangetastet.
- **Übersteht CSV-Re-Upload:** Der AbrechnungsBot speichert per `POST /settlements?on_conflict=woche,fahrer_name` mit `Prefer: resolution=merge-duplicates`. Beim Konflikt werden nur die **im Payload enthaltenen** Spalten aktualisiert. `lohn` ist nicht im Payload → bleibt erhalten. (Verifiziert am 2026-07-12.)

Migrations-Datei: `migrations/2026-07-12-add-lohn-to-settlements.sql`.

## Berechnung (nur Anzeige, nichts Zusätzliches gespeichert)

Helper:
```js
function netAuszahlung(s) { return (s.auszahlung || 0) - (parseFloat(s.lohn) || 0); }
```

- Wird überall dort verwendet, wo bisher `s.auszahlung` **für den Fahrer sichtbar** war (Tabelle, Ausdruck, WhatsApp, Summen).
- **Ausnahme:** „Müssen zahlen"-Tab und alle Debt-Logik lesen weiterhin den rohen `s.auszahlung` — dort ändert sich nichts.

## UI — Abrechnungen-Tabelle (inline)

Neue Spalte **„Lohn"** zwischen „Abzug" und der Aktions-Spalte (genaue Position beim Umsetzen an bestehendem Header/`colspan` ausrichten).

- **Editoren (Boyko / Bislan / Mohamed):** `<input type="number">` mit aktuellem `lohn`. Bei **Enter oder Blur** → `PATCH /settlements?id=eq.<id>` mit `{ lohn: <wert> }`. Optimistisches Update im lokalen `SETTLEMENTS`-Array, danach betroffene Zellen (Lohn + Auszahlung + Summen) neu rendern.
- **Andere User:** Lohn nur als **Text** (kein Input).
- **„Auszahlung"-Spalte** zeigt `netAuszahlung(s)`, weiterhin pos/neg eingefärbt. Bei `lohn>0` kleiner Hinweis „−X Lohn" (analog zum bestehenden „Korr:"-Badge).
- Leerer/`0`-Lohn: Anzeige wie bisher (kein Hinweis).

## Summen oben (Netto)

Die Kennzahlen „Auszahlung gesamt" (`statAuszahlung`) und „zu kassieren" (`statKassieren`) rechnen mit `netAuszahlung(s)` statt `s.auszahlung`, damit die **Bargeldsummen mit den Löhnen stimmen**.

- `auszahlungPositiv = Σ netAuszahlung(s) für netAuszahlung > 0`
- `auszahlungNegativ = Σ |netAuszahlung(s)| für netAuszahlung < 0`

„Müssen zahlen"-Summen bleiben auf dem rohen Wert.

## Ausdruck / WhatsApp

Im Abzüge-Block (nach Miete/Pauschale und %-Abzug):
- Zeile **„Lohn (bereits überwiesen)"** mit `−<lohn>`, **nur wenn `lohn>0`**.
- Finale „Auszahlung" = `netAuszahlung(s)`.
- Betrifft: `printDriver`, `printAllDrivers` und — falls vorhanden — die WhatsApp-Text-Funktion (beim Umsetzen prüfen und analog ergänzen).
- `exportCSV`: zusätzliche Spalten „Lohn" und „Netto".

## Berechtigung

Allowlist per `session.name` (aus `localStorage.hydralink_session`), case-insensitive:

```js
const LOHN_EDITORS = ['boyko', 'bislan', 'mohamed'];
function canEditLohn() {
  const s = JSON.parse(localStorage.getItem('hydralink_session') || 'null');
  return !!s && LOHN_EDITORS.includes((s.name || '').toLowerCase());
}
```

- Rolle taugt **nicht** als Kriterium: Bislan und Mohamed sind `role=user` wie andere nicht-berechtigte User; nur Boyko ist `admin`.
- **Client-seitiger Gate** (UX): Nicht-Editoren sehen den Lohn nur als Text. Das entspricht dem bestehenden Muster (Kassieren-Schreibvorgänge laufen ebenfalls client-seitig über den öffentlichen anon-Key).
- **Bekannte Grenze:** Keine echte Erzwingung — mit dem anon-Key könnte man `lohn` theoretisch direkt patchen. Für MVP akzeptiert. Spätere Härtung optional via RLS-Policy oder `set_lohn(name, pin, id, betrag)`-RPC (analog `delete_kassier_admin`).

## Betroffene Stellen in `dashboard.html`

- `loadData()` — lädt bereits `select('*')`, `lohn` kommt automatisch mit.
- `render()` — neue Spalte, Auszahlungs-Zelle auf Netto, Summen auf Netto, Editor-Gate.
- Tabellen-Header + leere-Zustand-`colspan` anpassen.
- Neuer Handler für Lohn-Input (PATCH + lokales Update).
- `printDriver`, `printAllDrivers`, ggf. WhatsApp-Text, `exportCSV`.
- Helper `netAuszahlung`, `canEditLohn`, `LOHN_EDITORS`.

## Testplan (manuell)

1. Migration ausführen, Spalte existiert mit Default 0.
2. Als Boyko: Lohn bei einem Fahrer eintragen → Netto-Auszahlung sinkt, Summen aktualisieren sich, DB-Wert gesetzt.
3. Lohn > Auszahlung → Netto negativ, rot, taucht **nicht** in „Müssen zahlen" auf.
4. Als Musa/Adam einloggen → Lohn nur lesbar, kein Input.
5. Ausdruck zeigt „Lohn (bereits überwiesen)" nur bei `lohn>0`, finale Auszahlung = Netto.
6. CSV für die Woche erneut hochladen → `lohn`-Wert bleibt erhalten.
7. „Müssen zahlen"-Tab unverändert (rohe Auszahlung).
