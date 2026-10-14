# Bankdaten in der Fahrerapp — Implementierungsplan (Teil A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fahrer tragen ihre IBAN in der Fahrerapp ein und bestätigen sie jede Woche; das Büro sieht und pflegt die Bankdaten im Dashboard; die 13 Einträge aus dem öffentlichen Formular werden übernommen.

**Architecture:** Drei Tabellen (`fahrer_bank`, `fahrer_bank_verlauf`, `bank_bestaetigung`) mit RLS „nur Büro liest“; geschrieben wird nur über `security definer`-RPCs, die Fahrer über `mein_fahrer_id()` auf sich selbst beschränken. Die IBAN-Prüfung gibt es zweimal mit denselben Regeln: als Browser-Datei `/bank-logik.js` (Fahrerapp + Dashboard, Node-Test) und als SQL-Funktion `iban_gueltig()` (die Datenbank ist die letzte Instanz). Oberflächen in `fahrer/index.html` und `dashboard.html` nach den vorhandenen Mustern.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Vanilla-JS in Einzel-HTML-Dateien, Node `--test`, PGlite für lokale DB-Tests.

**Spec:** `docs/superpowers/specs/2026-10-15-iban-fahrerapp-design.md`

## Global Constraints

- Teil B (Revolut, Überweisen) wird **nicht** gebaut — keine Tabelle `auszahlungen`, keine Edge Function.
- Schlüssel für Bankdaten ist `notion_fahrer_id` (nicht `fahrer.id`).
- Neue/geänderte IBAN gilt sofort, ohne Büro-Freigabe; jede Änderung landet unveränderlich in `fahrer_bank_verlauf`.
- Bestätigen kann nur der Fahrer selbst (Fahrer-JWT); die Büro-Vorschau sieht alles, kann aber nichts speichern.
- Bestätigt wird nur die neueste freigegebene Woche, nur mit Bankdaten und nur bei „Du bekommst“ > 0.
- Ändert der Fahrer IBAN oder Kontoinhaber, wird die Bestätigung der offenen Woche gelöscht.
- IBAN: Leerzeichen raus, Großbuchstaben, `^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$`, Länge je Land laut Tabelle (sonst 15–34), Prüfziffer mod 97 = 1. BIC optional, `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$`. Revtag optional, `^@?[A-Za-z0-9._-]{2,40}$`, gespeichert mit `@`. Kontoinhaber 2–140 Zeichen.
- `fahrer`, `settlements` und der AbrechnungsBot werden nicht verändert.
- Alle UI-Texte deutsch; Dark/Light über die vorhandenen CSS-Variablen; Fahrerapp auf 390 px ohne seitliches Scrollen.
- Jede Änderung an `dashboard.html`/`fahrer/index.html` erhöht `CACHE_NAME` in `sw.js` um eins.

## Review Focus

1. **IBAN mit Leerzeichen/Kleinbuchstaben/Bindestrichen** („lt12 1000 0111-0100 1000“) → wird normalisiert und angenommen, nicht abgelehnt. (Task 1 + Task 2 testen es.)
2. **Fahrer ändert IBAN nach dem Bestätigen** → Bestätigung der offenen Woche weg, Startkarte fragt erneut. (Task 2 testet es.)
3. **Fahrer mit zwei `settlements`-Zeilen in einer Woche (Alias-Fall)** → Betrag ist die Summe beider. (Task 2 testet es.)
4. **Büro in der Vorschau drückt „Stimmt“/„Speichern“** → abgelehnt mit verständlicher Meldung, nichts gespeichert. (Task 2 testet die RPC, Task 4 sperrt die Knöpfe.)
5. **Gleiche Daten nochmal speichern** → kein neuer Verlaufseintrag, Bestätigung bleibt. (Task 2 testet es.)

---

## Dateien

| Datei | Zweck |
|---|---|
| `bank-logik.js` (neu, Wurzel) | IBAN normalisieren/prüfen/gruppieren/kürzen, BIC/Revtag prüfen — Browser-Global `BankLogik` und `module.exports` |
| `scripts/test-bank-logik.mjs` (neu) | Node-Test der Logik |
| `migrations/2026-10-15-bankdaten.sql` (neu) | Funktionen, Tabellen, RLS, Protokoll, RPCs, View `bank_uebersicht` |
| `migrations/2026-10-15-bankdaten-uebernahme.sql` (neu) | Übernahme aus `fahrer_iban`, RPC `formular_iban_zuordnen`, View `formular_iban_offen` |
| `scripts/test-bankdaten.mjs` (neu) | PGlite-Test beider Migrationen |
| `fahrer/index.html` | Startkarte, Ansicht „Bankdaten“, Formular, Mehr-Eintrag |
| `dashboard.html` | Block „Bankdaten“ im Fahrer-Detail, Filter, Spalte, Büro-Eintrag, offene Formular-Einträge |
| `sw.js` | Cache-Version, `/bank-logik.js` vorladen |
| `CLAUDE.md` | Abschnitt „Bankdaten“ |

---

### Task 1: IBAN-Logik für Browser und Test

**Files:**
- Create: `bank-logik.js`
- Test: `scripts/test-bank-logik.mjs`

**Interfaces:**
- Produces (global `BankLogik` im Browser, `require('../bank-logik.js')` in Node):
  - `norm(s: string): string` — nur A–Z/0–9, groß
  - `ibanFehler(s: string): string` — `''` wenn gültig, sonst deutscher Fehlertext
  - `gruppiert(iban: string): string` — „LT12 1000 0111 0100 1000“
  - `kurz(iban: string): string` — „LT12 •••• 1000“
  - `bicFehler(s: string): string`, `revtagFehler(s: string): string`, `inhaberFehler(s: string): string`

- [ ] **Step 1: Failing test schreiben** — `scripts/test-bank-logik.mjs`:

```js
// node --test scripts/test-bank-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const B = createRequire(import.meta.url)('../bank-logik.js');

test('gueltige IBANs aus mehreren Laendern', () => {
  for (const i of ['AT611904300234573201', 'DE89370400440532013000', 'GB82WEST12345698765432',
                   'LT121000011101001000', 'BG80BNBG96611020345678']) {
    assert.equal(B.ibanFehler(i), '', i);
  }
});
test('Schreibweise egal: Leerzeichen, klein, Bindestrich', () => {
  assert.equal(B.norm(' lt12 1000 0111-0100 1000 '), 'LT121000011101001000');
  assert.equal(B.ibanFehler('lt12 1000 0111-0100 1000'), '');
});
test('kaputte IBANs', () => {
  assert.match(B.ibanFehler(''), /fehlt/);
  assert.match(B.ibanFehler('AT611904300234573202'), /Prüfziffer/);   // letzte Ziffer falsch
  assert.match(B.ibanFehler('AT6119043002345732'), /Länge/);          // AT braucht 20
  assert.match(B.ibanFehler('1234567890123456'), /Ländercode/);
  assert.match(B.ibanFehler('XX00'), /Ländercode|Länge/);
});
test('Anzeige', () => {
  assert.equal(B.gruppiert('LT121000011101001000'), 'LT12 1000 0111 0100 1000');
  assert.equal(B.kurz('LT121000011101001000'), 'LT12 •••• 1000');
});
test('BIC, Revtag, Kontoinhaber', () => {
  assert.equal(B.bicFehler(''), ''); assert.equal(B.bicFehler('revolt21'), ''); assert.equal(B.bicFehler('REVOLT21XXX'), '');
  assert.match(B.bicFehler('REV'), /BIC/);
  assert.equal(B.revtagFehler(''), ''); assert.equal(B.revtagFehler('@max.m'), ''); assert.equal(B.revtagFehler('max_m'), '');
  assert.match(B.revtagFehler('@ m'), /Revtag/);
  assert.match(B.inhaberFehler(' '), /Kontoinhaber/); assert.equal(B.inhaberFehler('Max Muster'), '');
});
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `node --test scripts/test-bank-logik.mjs`
Expected: FAIL — `Cannot find module '../bank-logik.js'`

- [ ] **Step 3: `bank-logik.js` schreiben**

```js
/* IBAN/BIC/Revtag pruefen und anzeigen - gleiche Regeln wie iban_gueltig() in der Datenbank
   (migrations/2026-10-15-bankdaten.sql). Browser: window.BankLogik, Node: module.exports. */
(function (root) {
  const LAENGE = { AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
    GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MT: 31, NL: 18, NO: 15,
    PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, TR: 26, RS: 22, BA: 20, MK: 19, AL: 28, XK: 20, ME: 22, UA: 29,
    GE: 22, AZ: 28 };
  function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function mod97(i) {
    const r = i.slice(4) + i.slice(0, 4);
    let rest = 0;
    for (const c of r) {
      const d = c >= 'A' ? String(c.charCodeAt(0) - 55) : c;
      for (const z of d) rest = (rest * 10 + (z.charCodeAt(0) - 48)) % 97;
    }
    return rest;
  }
  function ibanFehler(s) {
    const i = norm(s);
    if (!i) return 'IBAN fehlt.';
    if (!/^[A-Z]{2}/.test(i)) return 'IBAN beginnt mit dem Ländercode, z. B. AT oder LT.';
    const soll = LAENGE[i.slice(0, 2)];
    if (soll ? i.length !== soll : (i.length < 15 || i.length > 34))
      return 'IBAN hat die falsche Länge' + (soll ? ' (' + i.slice(0, 2) + ': ' + soll + ' Zeichen).' : '.');
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(i)) return 'IBAN enthält ungültige Zeichen.';
    if (mod97(i) !== 1) return 'IBAN stimmt nicht (Prüfziffer) – bitte vergleichen.';
    return '';
  }
  function gruppiert(iban) { return norm(iban).replace(/(.{4})(?=.)/g, '$1 '); }
  function kurz(iban) { const i = norm(iban); return i.length > 8 ? i.slice(0, 4) + ' •••• ' + i.slice(-4) : i; }
  function bicFehler(s) {
    const b = norm(s);
    return !b || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(b) ? '' : 'BIC hat 8 oder 11 Zeichen, z. B. REVOLT21.';
  }
  function revtagFehler(s) {
    const r = String(s == null ? '' : s).trim();
    return !r || /^@?[A-Za-z0-9._-]{2,40}$/.test(r) ? '' : 'Revtag ohne Leerzeichen, z. B. @deinname.';
  }
  function inhaberFehler(s) {
    const n = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    return n.length >= 2 && n.length <= 140 ? '' : 'Kontoinhaber fehlt.';
  }
  const api = { norm, ibanFehler, gruppiert, kurz, bicFehler, revtagFehler, inhaberFehler };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BankLogik = api;
})(this);
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `node --test scripts/test-bank-logik.mjs`
Expected: PASS, 5 Tests. Scheitert eine der „gültigen“ Beispiel-IBANs, Beispiel austauschen — nicht die Prüfung lockern.

- [ ] **Step 5: Commit**

```bash
git add bank-logik.js scripts/test-bank-logik.mjs
git commit -m "bankdaten: iban-pruefung fuer browser und test (bank-logik.js)"
```

---

### Task 2: Datenbank — Tabellen, Prüfung, RPCs

**Files:**
- Create: `migrations/2026-10-15-bankdaten.sql`
- Test: `scripts/test-bankdaten.mjs`

**Interfaces:**
- Consumes (bestehend): `is_app_user()`, `mein_fahrer_id()`, `fahrer_app_ziel(int)`, `settlement_fahrer(text,text)`, `protokoll_schreiben()` (Trigger), Tabellen `fahrer`, `settlements`, `abrechnung_freigaben`.
- Produces:
  - `iban_norm(text) → text`, `iban_gueltig(text) → boolean`
  - Tabellen `fahrer_bank`, `fahrer_bank_verlauf`, `bank_bestaetigung` (Spalten wie unten)
  - `bank_woche() → text` (neueste freigegebene Woche, `2026-W37k` zählt als `W36`)
  - `bank_betrag(p_fahrer_id int, p_woche text) → numeric` (Summe „Du bekommst“, `null` ohne Zeile)
  - `fahrer_app_bank(p_fahrer_id int default null) → table(kontoinhaber, iban, bic, revtag, geaendert_am, woche, betrag, bestaetigt_am, bestaetigt_iban)` — genau eine Zeile für den eigenen Fahrer (Felder null, wenn nichts da)
  - `fahrer_bank_setzen(p_kontoinhaber, p_iban, p_bic default null, p_revtag default null) → void` (nur Fahrer)
  - `bank_bestaetigen(p_woche text) → void` (nur Fahrer)
  - `buero_bank_setzen(p_notion_fahrer_id int, p_kontoinhaber, p_iban, p_bic default null, p_revtag default null) → void` (nur Büro)
  - View `bank_uebersicht(fahrer_id, notion_fahrer_id, name, kontoinhaber, iban, bic, revtag, geaendert_am, geaendert_von, woche, bestaetigt_am, bestaetigt_iban, bestaetigt_betrag, aenderungen)`

- [ ] **Step 1: Failing test schreiben** — `scripts/test-bankdaten.mjs`:

```js
// Datenbank-Test fuer die Bankdaten, lokal in PGlite – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs
//
// Nachbau der benutzten Tabellen/Funktionen (Stand 15.10.2026, nur noetige Spalten), dann die Migrationen.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const basis = process.env.PGLITE;
if (!basis) { console.error('PGLITE fehlt – siehe Kopf dieser Datei.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(basis, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
create function public.is_app_user() returns boolean language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'app_role') in ('admin','user'), false) $$;
create function public.tel_key(t text) returns text language sql immutable as $$
  select case when d like '00%' then substr(d, 3) when d like '0%' then '43' || substr(d, 2) else d end
  from (select regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g') as d) x $$;
create function public.protokoll_schreiben() returns trigger language plpgsql as $$ begin return null; end $$;
create table public.fahrer (id integer primary key, name text not null, telefon text, aktiv boolean default true, notion_fahrer_id integer);
create table public.fahrer_app_zugang (notion_fahrer_id integer primary key, auth_user_id uuid not null, gesperrt boolean default false);
create table public.abrechnung_freigaben (woche text primary key, freigegeben_am timestamptz default now());
create table public.settlements (id serial primary key, woche text, fahrer_name text, telefon text, status text default 'berechnet',
  auszahlung numeric(10,2) default 0, lohn numeric default 0);
create function public.settlement_fahrer(p_telefon text, p_name text) returns integer language sql stable as $$
  select f.id from public.fahrer f
  where (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) or f.name = p_name
  order by (coalesce(p_telefon,'') <> '' and public.tel_key(f.telefon) = public.tel_key(p_telefon)) desc, f.aktiv desc nulls last, f.id
  limit 1 $$;
create function public.mein_fahrer_id() returns integer language sql stable security definer set search_path = public as $$
  select min(f.id) from public.fahrer f
  join public.fahrer_app_zugang z on z.notion_fahrer_id = f.notion_fahrer_id and z.auth_user_id = auth.uid() and not z.gesperrt
  where f.aktiv and coalesce(auth.jwt()->'app_metadata'->>'fahrer_nr', '') ~ '^[0-9]{1,9}$'
    and f.notion_fahrer_id = (auth.jwt()->'app_metadata'->>'fahrer_nr')::integer
  having count(*) = 1 $$;
create function public.fahrer_app_ziel(p_fahrer_id integer) returns integer language sql stable security definer set search_path = public as $$
  select case when p_fahrer_id is not null and public.is_app_user() then (select f.id from public.fahrer f where f.id = p_fahrer_id)
              when public.is_app_user() then null else public.mein_fahrer_id() end $$;
grant usage on schema public, auth to anon, authenticated;

insert into public.fahrer values (1, 'Anna Fahr', '+436601111111', true, 101), (2, 'Bert Fahr', '+436602222222', true, 102),
                                 (3, 'Cem Fahr', '+436603333333', true, 103);
insert into public.fahrer_app_zugang values (101, '00000000-0000-0000-0000-000000000101', false),
                                            (102, '00000000-0000-0000-0000-000000000102', false);
insert into public.abrechnung_freigaben (woche) values ('2026-W40'), ('2026-W41');
insert into public.settlements (woche, fahrer_name, telefon, auszahlung, lohn) values
  ('2026-W41', 'Anna Fahr', '+436601111111', 500, 100),        -- Anna: 400
  ('2026-W41', 'Anna Alias', '+436601111111', 50, 0),          -- zweite Zeile derselben Person: +50
  ('2026-W41', 'Bert Fahr', '+436602222222', 100, 300),        -- Bert: -200
  ('2026-W40', 'Anna Fahr', '+436601111111', 999, 0);
`);
await db.exec(lies('../migrations/2026-10-15-bankdaten.sql'));
const uebernahme = '../migrations/2026-10-15-bankdaten-uebernahme.sql';

const als = (claims) => db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false); set role authenticated;`);
const raus = () => db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
const ANNA = { sub: '00000000-0000-0000-0000-000000000101', app_metadata: { fahrer_nr: '101' } };
const BERT = { sub: '00000000-0000-0000-0000-000000000102', app_metadata: { fahrer_nr: '102' } };
const BUERO = { sub: '00000000-0000-0000-0000-000000000900', app_metadata: { app_role: 'user', app_name: 'Stefan' } };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const nein = async (sql, p, muster) => assert.rejects(db.query(sql, p), (e) => { assert.match(e.message, muster); return true; });

try {
  // --- Pruefung in SQL wie im Browser
  const g = await q(`select public.iban_gueltig('lt12 1000 0111-0100 1000') a, public.iban_gueltig('AT611904300234573202') b,
                            public.iban_gueltig('AT6119043002345732') c, public.iban_gueltig('DE89370400440532013000') d`);
  assert.deepEqual(g[0], { a: true, b: false, c: false, d: true });

  // --- Anna: noch nichts da -> eine Zeile mit leeren Bankdaten, Betrag 450 (zwei Zeilen), Woche W41
  await als(ANNA);
  let [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.iban, null); assert.equal(a.woche, '2026-W41'); assert.equal(Number(a.betrag), 450);
  await nein(`select public.bank_bestaetigen('2026-W41')`, [], /zuerst Bankdaten/);
  await nein(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573202')`, [], /IBAN ungültig/);
  await nein(`select public.fahrer_bank_setzen(' ', 'AT611904300234573201')`, [], /Kontoinhaber/);
  await nein(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573201', 'REV')`, [], /BIC/);
  await q(`select public.fahrer_bank_setzen('  Anna   Fahr ', 'lt12 1000 0111-0100 1000', 'revolt21', 'anna.f')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.iban, 'LT121000011101001000'); assert.equal(a.kontoinhaber, 'Anna Fahr');
  assert.equal(a.bic, 'REVOLT21'); assert.equal(a.revtag, '@anna.f');
  // Bestaetigen: nur aktuelle Woche
  await nein(`select public.bank_bestaetigen('2026-W40')`, [], /aktuelle Woche/);
  await q(`select public.bank_bestaetigen('2026-W41')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.bestaetigt_iban, 'LT121000011101001000'); assert.ok(a.bestaetigt_am);
  // Gleiche Daten nochmal: kein Verlauf, Bestaetigung bleibt
  await q(`select public.fahrer_bank_setzen('Anna Fahr', 'LT121000011101001000', 'REVOLT21', '@anna.f')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.ok(a.bestaetigt_am, 'Bestaetigung darf bei gleichen Daten bleiben');
  // Fahrer liest Tabellen nicht direkt
  assert.equal((await q('select count(*)::int n from public.fahrer_bank'))[0].n, 0);
  assert.equal((await q('select count(*)::int n from public.fahrer_bank_verlauf'))[0].n, 0);
  // Neue IBAN -> Bestaetigung weg
  await q(`select public.fahrer_bank_setzen('Anna Fahr', 'AT611904300234573201')`);
  [a] = await q('select * from public.fahrer_app_bank()');
  assert.equal(a.bestaetigt_am, null); assert.equal(a.iban, 'AT611904300234573201');
  // Vorschau-Parameter wird fuer Fahrer ignoriert (sieht nur sich)
  [a] = await q('select * from public.fahrer_app_bank(2)');
  assert.equal(a.iban, 'AT611904300234573201');
  await raus();

  // --- Bert: Betrag negativ -> Bestaetigen abgelehnt
  await als(BERT);
  await q(`select public.fahrer_bank_setzen('Bert Fahr', 'DE89370400440532013000')`);
  await nein(`select public.bank_bestaetigen('2026-W41')`, [], /keine Auszahlung/);
  await raus();

  // --- Buero: sieht alles, kann nicht als Fahrer speichern/bestaetigen, kann ueber buero_bank_setzen eintragen
  await als(BUERO);
  await nein(`select public.fahrer_bank_setzen('X Y', 'DE89370400440532013000')`, [], /Fahrerapp/);
  await nein(`select public.bank_bestaetigen('2026-W41')`, [], /Fahrerapp/);
  [a] = await q('select * from public.fahrer_app_bank(1)');         // Vorschau Anna
  assert.equal(a.iban, 'AT611904300234573201');
  await q(`select public.buero_bank_setzen(103, 'Cem Fahr', 'GB82WEST12345698765432')`);
  await nein(`select public.buero_bank_setzen(999, 'Niemand', 'GB82WEST12345698765432')`, [], /Fahrer/);
  const ue = await q('select notion_fahrer_id, iban, geaendert_von, aenderungen from public.bank_uebersicht order by 1');
  assert.deepEqual(ue.map((r) => [r.notion_fahrer_id, r.iban, r.geaendert_von, r.aenderungen]), [
    [101, 'AT611904300234573201', 'fahrer', 2], [102, 'DE89370400440532013000', 'fahrer', 1], [103, 'GB82WEST12345698765432', 'Stefan', 1]]);
  const v = await q('select alt_iban, neu_iban, von from public.fahrer_bank_verlauf where notion_fahrer_id = 101 order by id');
  assert.deepEqual(v.map((r) => [r.alt_iban, r.neu_iban, r.von]),
    [[null, 'LT121000011101001000', 'fahrer'], ['LT121000011101001000', 'AT611904300234573201', 'fahrer']]);
  await raus();

  // --- Ohne Anmeldung: nichts
  await db.exec('set role anon');
  await nein('select * from public.fahrer_bank', [], /permission denied/);
  await nein(`select public.fahrer_bank_setzen('X Y', 'DE89370400440532013000')`, [], /permission denied/);
  await raus();

  // --- Verlauf ist unveraenderlich, auch fuer den Besitzer der Tabelle
  await nein('update public.fahrer_bank_verlauf set von = $1', ['x'], /nicht geändert/);
  await nein('delete from public.fahrer_bank_verlauf', [], /nicht geändert/);

  if (existsSync(new URL(uebernahme, import.meta.url))) {
    // Task 3 haengt hier seine Asserts an
  }
  console.log('OK');
} catch (e) {
  console.error('FEHLER: ' + (e && e.message || e));
  process.exit(1);
}
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run (einmalig vorher `npm i --prefix /tmp/pglite @electric-sql/pglite`): `PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs`
Expected: Abbruch mit `ENOENT … 2026-10-15-bankdaten.sql`

- [ ] **Step 3: Migration schreiben** — `migrations/2026-10-15-bankdaten.sql`:

```sql
-- ============================================================================
-- Bankdaten der Fahrer (Teil A der Spec docs/superpowers/specs/2026-10-15-iban-fahrerapp-design.md)
-- Datum: 2026-10-15
--
-- Fahrer tragen ihre IBAN in der Fahrerapp ein und bestaetigen sie je Woche.
-- Lesen: nur Buero (RLS). Schreiben: nur ueber die RPCs unten.
-- Eine neue IBAN gilt sofort (Entscheidung Betreiber 13.10.) - deshalb wird jede
-- Aenderung unveraenderlich in fahrer_bank_verlauf festgehalten.
-- Schluessel ist die Notion-Fahrer-Nr. (bleibt, wenn n8n die fahrer-Zeile neu anlegt).
--
-- Rollback: drop view bank_uebersicht; drop function fahrer_app_bank, fahrer_bank_setzen,
--   bank_bestaetigen, buero_bank_setzen, bank_schreiben, bank_betrag, bank_woche, iban_gueltig,
--   iban_norm, bank_verlauf_gesperrt; drop table bank_bestaetigung, fahrer_bank_verlauf, fahrer_bank;
-- ============================================================================

create or replace function public.iban_norm(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- Gleiche Regeln wie bank-logik.js: Laenge je Land (sonst 15-34), Pruefziffer mod 97 = 1.
create or replace function public.iban_gueltig(p text) returns boolean
language plpgsql immutable as $$
declare i text := public.iban_norm(p); soll int; r text; d text := ''; c text; k int;
begin
  if i !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return false; end if;
  soll := case substr(i, 1, 2)
    when 'AT' then 20 when 'BE' then 16 when 'BG' then 22 when 'CH' then 21 when 'CY' then 28 when 'CZ' then 24
    when 'DE' then 22 when 'DK' then 18 when 'EE' then 20 when 'ES' then 24 when 'FI' then 18 when 'FR' then 27
    when 'GB' then 22 when 'GR' then 27 when 'HR' then 21 when 'HU' then 28 when 'IE' then 22 when 'IS' then 26
    when 'IT' then 27 when 'LI' then 21 when 'LT' then 20 when 'LU' then 20 when 'LV' then 21 when 'MT' then 31
    when 'NL' then 18 when 'NO' then 15 when 'PL' then 28 when 'PT' then 25 when 'RO' then 24 when 'SE' then 24
    when 'SI' then 19 when 'SK' then 24 when 'TR' then 26 when 'RS' then 22 when 'BA' then 20 when 'MK' then 19
    when 'AL' then 28 when 'XK' then 20 when 'ME' then 22 when 'UA' then 29 when 'GE' then 22 when 'AZ' then 28
    else null end;
  if soll is not null and length(i) <> soll then return false; end if;
  r := substr(i, 5) || substr(i, 1, 4);
  for k in 1..length(r) loop
    c := substr(r, k, 1);
    d := d || case when c ~ '[0-9]' then c else (ascii(c) - 55)::text end;
  end loop;
  return mod(d::numeric, 97) = 1;
end $$;

create table if not exists public.fahrer_bank (
  notion_fahrer_id integer primary key,
  kontoinhaber     text not null check (length(kontoinhaber) between 2 and 140),
  iban             text not null check (iban = public.iban_norm(iban) and public.iban_gueltig(iban)),
  bic              text check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  revtag           text check (revtag is null or revtag ~ '^@[A-Za-z0-9._-]{2,40}$'),
  geaendert_am     timestamptz not null default now(),
  geaendert_von    text not null
);

create table if not exists public.fahrer_bank_verlauf (
  id               bigint generated always as identity primary key,
  notion_fahrer_id integer not null,
  zeit             timestamptz not null default now(),
  von              text not null,
  alt_kontoinhaber text, alt_iban text, alt_bic text, alt_revtag text,
  neu_kontoinhaber text not null, neu_iban text not null, neu_bic text, neu_revtag text
);
create index if not exists fahrer_bank_verlauf_nr on public.fahrer_bank_verlauf (notion_fahrer_id, zeit);

create or replace function public.bank_verlauf_gesperrt() returns trigger language plpgsql as $$
begin
  raise exception 'Der Bankdaten-Verlauf wird nicht geändert oder gelöscht' using errcode = '42501';
end $$;
drop trigger if exists bank_verlauf_gesperrt on public.fahrer_bank_verlauf;
create trigger bank_verlauf_gesperrt before update or delete on public.fahrer_bank_verlauf
  for each row execute function public.bank_verlauf_gesperrt();

create table if not exists public.bank_bestaetigung (
  woche            text not null,
  notion_fahrer_id integer not null,
  iban             text not null,
  kontoinhaber     text not null,
  betrag           numeric(10,2) not null,
  bestaetigt_am    timestamptz not null default now(),
  primary key (woche, notion_fahrer_id)
);

alter table public.fahrer_bank enable row level security;
alter table public.fahrer_bank_verlauf enable row level security;
alter table public.bank_bestaetigung enable row level security;
revoke all on public.fahrer_bank, public.fahrer_bank_verlauf, public.bank_bestaetigung from public, anon, authenticated;
grant select on public.fahrer_bank, public.fahrer_bank_verlauf, public.bank_bestaetigung to authenticated;
drop policy if exists buero_liest on public.fahrer_bank;
drop policy if exists buero_liest on public.fahrer_bank_verlauf;
drop policy if exists buero_liest on public.bank_bestaetigung;
create policy buero_liest on public.fahrer_bank for select to authenticated using (public.is_app_user());
create policy buero_liest on public.fahrer_bank_verlauf for select to authenticated using (public.is_app_user());
create policy buero_liest on public.bank_bestaetigung for select to authenticated using (public.is_app_user());

-- Protokoll (wer hat was geaendert) wie die anderen 12 Tabellen
drop trigger if exists protokoll_mitschreiben on public.fahrer_bank;
create trigger protokoll_mitschreiben after insert or update or delete on public.fahrer_bank
  for each row execute function public.protokoll_schreiben('notion_fahrer_id', 'ohne', '', '');
drop trigger if exists protokoll_mitschreiben on public.bank_bestaetigung;
create trigger protokoll_mitschreiben after insert or update or delete on public.bank_bestaetigung
  for each row execute function public.protokoll_schreiben('woche,notion_fahrer_id', 'ohne', '', '');

-- Neueste freigegebene Woche (2026-W37k zaehlt als W36 wie in fahrer_app_abrechnungen)
create or replace function public.bank_woche() returns text
language sql stable security definer set search_path = public as $$
  select fr.woche from public.abrechnung_freigaben fr
  order by case fr.woche when '2026-W37k' then '2026-W36' else fr.woche end desc limit 1
$$;

-- "Du bekommst" eines Fahrers in einer Woche, ueber alle seine Zeilen (Alias-Fall). null = keine Zeile.
create or replace function public.bank_betrag(p_fahrer_id integer, p_woche text) returns numeric
language sql stable security definer set search_path = public as $$
  select sum(coalesce(s.auszahlung, 0) - coalesce(s.lohn, 0))
  from public.settlements s
  where s.woche = p_woche and s.status = 'berechnet' and s.fahrer_name not like '\_\_%'
    and public.settlement_fahrer(s.telefon, s.fahrer_name) = p_fahrer_id
$$;

-- Einzige Stelle, die fahrer_bank schreibt. Nicht direkt aufrufbar (siehe revoke unten).
create or replace function public.bank_schreiben(p_nr integer, p_kontoinhaber text, p_iban text,
                                                 p_bic text, p_revtag text, p_von text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_iban text := public.iban_norm(p_iban);
  v_inh  text := regexp_replace(btrim(coalesce(p_kontoinhaber, '')), '\s+', ' ', 'g');
  v_bic  text := nullif(public.iban_norm(p_bic), '');
  v_rev  text := nullif(btrim(coalesce(p_revtag, '')), '');
  a public.fahrer_bank; v_war boolean;
begin
  if p_nr is null then raise exception 'Fahrer-Nr. fehlt' using errcode = '22023'; end if;
  if length(v_inh) < 2 or length(v_inh) > 140 then raise exception 'Kontoinhaber fehlt' using errcode = '22023'; end if;
  if not public.iban_gueltig(v_iban) then raise exception 'IBAN ungültig – bitte prüfen' using errcode = '22023'; end if;
  if v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    raise exception 'BIC ungültig (8 oder 11 Zeichen)' using errcode = '22023'; end if;
  if v_rev is not null then
    if v_rev !~ '^@?[A-Za-z0-9._-]{2,40}$' then raise exception 'Revtag ungültig, z. B. @deinname' using errcode = '22023'; end if;
    if left(v_rev, 1) <> '@' then v_rev := '@' || v_rev; end if;
  end if;

  select * into a from public.fahrer_bank where notion_fahrer_id = p_nr for update;
  v_war := a.notion_fahrer_id is not null;
  if v_war and a.kontoinhaber = v_inh and a.iban = v_iban
     and a.bic is not distinct from v_bic and a.revtag is not distinct from v_rev then
    return;   -- nichts geaendert: kein Verlauf, Bestaetigung bleibt
  end if;

  insert into public.fahrer_bank_verlauf (notion_fahrer_id, von, alt_kontoinhaber, alt_iban, alt_bic, alt_revtag,
                                          neu_kontoinhaber, neu_iban, neu_bic, neu_revtag)
  values (p_nr, p_von, a.kontoinhaber, a.iban, a.bic, a.revtag, v_inh, v_iban, v_bic, v_rev);

  insert into public.fahrer_bank (notion_fahrer_id, kontoinhaber, iban, bic, revtag, geaendert_am, geaendert_von)
  values (p_nr, v_inh, v_iban, v_bic, v_rev, now(), p_von)
  on conflict (notion_fahrer_id) do update
    set kontoinhaber = excluded.kontoinhaber, iban = excluded.iban, bic = excluded.bic, revtag = excluded.revtag,
        geaendert_am = now(), geaendert_von = excluded.geaendert_von;

  -- Bestaetigt ist immer genau eine IBAN: Ziel geaendert -> offene Woche neu bestaetigen
  if v_war and (a.iban <> v_iban or a.kontoinhaber <> v_inh) then
    delete from public.bank_bestaetigung where notion_fahrer_id = p_nr and woche = public.bank_woche();
  end if;
end $$;

-- Fahrerapp: eigene Bankdaten + Stand der neuesten freigegebenen Woche (Buero-Vorschau mit p_fahrer_id)
create or replace function public.fahrer_app_bank(p_fahrer_id integer default null)
returns table (kontoinhaber text, iban text, bic text, revtag text, geaendert_am timestamptz,
               woche text, betrag numeric, bestaetigt_am timestamptz, bestaetigt_iban text)
language sql stable security definer set search_path = public as $$
  with z as (select f.id, f.notion_fahrer_id as nr from public.fahrer f where f.id = public.fahrer_app_ziel(p_fahrer_id)),
       w as (select public.bank_woche() as woche)
  select b.kontoinhaber, b.iban, b.bic, b.revtag, b.geaendert_am,
         w.woche, public.bank_betrag(z.id, w.woche), bb.bestaetigt_am, bb.iban
  from z cross join w
  left join public.fahrer_bank b on b.notion_fahrer_id = z.nr
  left join public.bank_bestaetigung bb on bb.notion_fahrer_id = z.nr and bb.woche = w.woche
  where z.nr is not null
$$;

-- Fahrer setzt seine Bankdaten (gilt sofort). Buero/Vorschau: abgelehnt.
create or replace function public.fahrer_bank_setzen(p_kontoinhaber text, p_iban text,
                                                     p_bic text default null, p_revtag text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_id integer := public.mein_fahrer_id(); v_nr integer;
begin
  if v_id is null then raise exception 'Nur in der Fahrerapp möglich' using errcode = '42501'; end if;
  select notion_fahrer_id into v_nr from public.fahrer where id = v_id;
  perform public.bank_schreiben(v_nr, p_kontoinhaber, p_iban, p_bic, p_revtag, 'fahrer');
end $$;

-- Fahrer bestaetigt seine IBAN fuer die neueste freigegebene Woche
create or replace function public.bank_bestaetigen(p_woche text)
returns void language plpgsql security definer set search_path = public as $$
declare v_id integer := public.mein_fahrer_id(); v_nr integer; b public.fahrer_bank; v_betrag numeric;
begin
  if v_id is null then raise exception 'Nur in der Fahrerapp möglich' using errcode = '42501'; end if;
  if p_woche is distinct from public.bank_woche() then
    raise exception 'Nur die aktuelle Woche kann bestätigt werden' using errcode = '22023'; end if;
  select notion_fahrer_id into v_nr from public.fahrer where id = v_id;
  select * into b from public.fahrer_bank where notion_fahrer_id = v_nr;
  if b.notion_fahrer_id is null then raise exception 'Bitte zuerst Bankdaten eintragen' using errcode = '22023'; end if;
  v_betrag := public.bank_betrag(v_id, p_woche);
  if coalesce(v_betrag, 0) <= 0 then raise exception 'Für diese Woche gibt es keine Auszahlung' using errcode = '22023'; end if;
  insert into public.bank_bestaetigung (woche, notion_fahrer_id, iban, kontoinhaber, betrag)
  values (p_woche, v_nr, b.iban, b.kontoinhaber, round(v_betrag, 2))
  on conflict (woche, notion_fahrer_id) do update
    set iban = excluded.iban, kontoinhaber = excluded.kontoinhaber, betrag = excluded.betrag, bestaetigt_am = now();
end $$;

-- Buero traegt Bankdaten fuer einen Fahrer ein (z. B. Uebernahme). Bestaetigen kann nur der Fahrer.
create or replace function public.buero_bank_setzen(p_notion_fahrer_id integer, p_kontoinhaber text, p_iban text,
                                                    p_bic text default null, p_revtag text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein aktiver Fahrer mit Nr. %', p_notion_fahrer_id using errcode = 'P0002'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, p_kontoinhaber, p_iban, p_bic, p_revtag,
                                coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro'));
end $$;

-- Dashboard: je aktivem Fahrer Bankdaten + Bestaetigung der neuesten Woche
create or replace view public.bank_uebersicht with (security_invoker = true) as
select f.id as fahrer_id, f.notion_fahrer_id, f.name,
       b.kontoinhaber, b.iban, b.bic, b.revtag, b.geaendert_am, b.geaendert_von,
       w.woche, bb.bestaetigt_am, bb.iban as bestaetigt_iban, bb.betrag as bestaetigt_betrag,
       (select count(*) from public.fahrer_bank_verlauf v where v.notion_fahrer_id = f.notion_fahrer_id)::integer as aenderungen
from public.fahrer f
cross join (select public.bank_woche() as woche) w
left join public.fahrer_bank b on b.notion_fahrer_id = f.notion_fahrer_id
left join public.bank_bestaetigung bb on bb.notion_fahrer_id = f.notion_fahrer_id and bb.woche = w.woche
where f.aktiv and f.notion_fahrer_id is not null;
revoke all on public.bank_uebersicht from public, anon;
grant select on public.bank_uebersicht to authenticated;

revoke all on function public.bank_schreiben(integer, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.fahrer_app_bank(integer), public.fahrer_bank_setzen(text, text, text, text),
  public.bank_bestaetigen(text), public.buero_bank_setzen(integer, text, text, text, text),
  public.bank_woche(), public.bank_betrag(integer, text) from public, anon;
grant execute on function public.fahrer_app_bank(integer), public.fahrer_bank_setzen(text, text, text, text),
  public.bank_bestaetigen(text), public.buero_bank_setzen(integer, text, text, text, text),
  public.bank_woche(), public.bank_betrag(integer, text) to authenticated;
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs`
Expected: `OK`. Scheitert „Fahrer liest Tabellen nicht direkt“ mit `permission denied` statt 0 Zeilen: das ist auch richtig — dann den Assert auf `nein(…, /permission denied/)` umstellen, nicht die Rechte öffnen.

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-10-15-bankdaten.sql scripts/test-bankdaten.mjs
git commit -m "bankdaten: tabellen, iban-pruefung in sql, rpcs fuer fahrerapp und buero, verlauf unveraenderlich (noch nicht eingespielt)"
```

---

### Task 3: Übernahme aus dem öffentlichen Formular

**Files:**
- Create: `migrations/2026-10-15-bankdaten-uebernahme.sql`
- Modify: `scripts/test-bankdaten.mjs` (Block „Task 3 haengt hier seine Asserts an“)

**Interfaces:**
- Consumes: `bank_schreiben(...)`, `iban_gueltig(text)`, `tel_key(text)`, Tabelle `fahrer_iban(id bigint, erstellt_am, vorname, nachname, telefon, kontoinhaber, iban, bic, revtag, status, notiz)`.
- Produces:
  - Spalte `fahrer_iban.uebernommen_nr integer`
  - View `formular_iban_offen(id, erstellt_am, name, telefon, kontoinhaber, iban_kurz, grund)` — Einträge mit `status = 'neu'`
  - RPC `formular_iban_zuordnen(p_id bigint, p_notion_fahrer_id integer) → void` (nur Büro)

- [ ] **Step 1: Failing Asserts ergänzen** — im Test die Tabelle `fahrer_iban` im Setup anlegen (direkt nach `create table public.settlements …`):

```sql
create table public.fahrer_iban (id bigint primary key, erstellt_am timestamptz default now(), vorname text not null, nachname text not null,
  telefon text, kontoinhaber text not null, iban text not null, bic text, revtag text, status text not null default 'neu', notiz text);
insert into public.fahrer_iban (id, erstellt_am, vorname, nachname, telefon, kontoinhaber, iban, bic, revtag) values
  (1, '2026-10-06', 'Cem', 'Fahr', '0660 3333333', 'Cem Fahr', 'DE89 3704 0044 0532 0130 00', null, null),
  (2, '2026-10-08', 'Cem', 'Fahr', '06603333333', 'Cem Fahr', 'GB82WEST12345698765432', 'westgb2l', 'cem'),  -- neuester gewinnt
  (3, '2026-10-07', 'Unbe', 'Kannt', '0699 0000000', 'Unbe Kannt', 'AT611904300234573201', null, null),       -- kein Fahrer
  (4, '2026-10-07', 'Anna', 'Fahr', '+43 660 1111111', 'Anna Fahr', 'AT611904300234573202', null, null);    -- IBAN kaputt
```

und den Block am Ende ersetzen durch:

```js
  if (existsSync(new URL(uebernahme, import.meta.url))) {
    // vorher: Cem hat (aus dem Buero-Test) GB82…; Uebernahme darf vorhandene Bankdaten NICHT ueberschreiben
    await db.exec(lies(uebernahme));
    let r = await q('select id, status, uebernommen_nr from public.fahrer_iban order by id');
    assert.deepEqual(r.map((x) => [x.id, x.status, x.uebernommen_nr]),
      [[1, 'neu', null], [2, 'neu', null], [3, 'neu', null], [4, 'neu', null]]);
    // Cem neu aufsetzen: Buero-Eintrag weg, damit die Uebernahme greift (Verlauf bleibt, nur fahrer_bank leeren)
    await db.exec(`delete from public.fahrer_bank where notion_fahrer_id = 103`);
    await db.exec(lies(uebernahme));
    r = await q('select id, status, uebernommen_nr from public.fahrer_iban order by id');
    assert.deepEqual(r.map((x) => [x.id, x.status, x.uebernommen_nr]),
      [[1, 'ueberholt', 103], [2, 'uebernommen', 103], [3, 'neu', null], [4, 'neu', null]]);
    const [c] = await q('select iban, bic, revtag, geaendert_von from public.fahrer_bank where notion_fahrer_id = 103');
    assert.deepEqual([c.iban, c.bic, c.revtag, c.geaendert_von], ['GB82WEST12345698765432', 'WESTGB2L', '@cem', 'formular']);

    await als(BUERO);
    const offen = await q('select id, grund from public.formular_iban_offen order by id');
    assert.deepEqual(offen.map((x) => [x.id, x.grund]), [[3, 'kein Fahrer mit dieser Telefonnummer'], [4, 'IBAN ungültig']]);
    await nein('select public.formular_iban_zuordnen(4, 101)', [], /IBAN ungültig/);
    await q('select public.formular_iban_zuordnen(3, 102)');       // Buero ordnet Eintrag 3 Bert zu
    const [b] = await q(`select iban, geaendert_von from public.fahrer_bank where notion_fahrer_id = 102`);
    assert.deepEqual([b.iban, b.geaendert_von], ['AT611904300234573201', 'formular (Stefan)']);
    assert.equal((await q('select count(*)::int n from public.formular_iban_offen'))[0].n, 1);
    await raus();
    await als(ANNA);
    await nein('select public.formular_iban_zuordnen(4, 101)', [], /Nicht autorisiert/);
    await raus();
  }
```

- [ ] **Step 2: Test laufen lassen, muss scheitern**

Run: `PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs`
Expected: unverändert `OK` (Datei existiert noch nicht → Block übersprungen). Dann eine leere Datei `migrations/2026-10-15-bankdaten-uebernahme.sql` anlegen und erneut laufen lassen → `FEHLER: column "uebernommen_nr" does not exist`.

- [ ] **Step 3: Migration schreiben** — `migrations/2026-10-15-bankdaten-uebernahme.sql`:

```sql
-- ============================================================================
-- Bankdaten aus dem oeffentlichen Formular (~/Projects/iban-formular, Tabelle fahrer_iban) uebernehmen
-- Datum: 2026-10-15. Wiederholbar: uebernimmt nur Eintraege mit status 'neu'.
--
-- Zuordnung ueber die Telefonnummer (tel_key) zu genau einem aktiven Fahrer mit Notion-Nr.
-- Je Fahrer gewinnt der neueste gueltige Eintrag; aeltere werden 'ueberholt'.
-- Hat der Fahrer schon Bankdaten (App oder Buero), wird NICHTS ueberschrieben.
-- Der Rest bleibt 'neu' und steht im Dashboard (View formular_iban_offen).
-- ============================================================================

alter table public.fahrer_iban add column if not exists uebernommen_nr integer;

do $$
declare r record;
begin
  for r in
    with treffer as (
      select i.*, (select min(f.notion_fahrer_id) from public.fahrer f
                   where f.aktiv and f.notion_fahrer_id is not null
                     and public.tel_key(i.telefon) <> '' and public.tel_key(f.telefon) = public.tel_key(i.telefon)
                   having count(distinct f.notion_fahrer_id) = 1) as nr
      from public.fahrer_iban i
      where i.status = 'neu' and public.iban_gueltig(i.iban)
    )
    select t.*, row_number() over (partition by t.nr order by t.erstellt_am desc, t.id desc) as rang
    from treffer t
    where t.nr is not null
      and not exists (select 1 from public.fahrer_bank b where b.notion_fahrer_id = t.nr)
    order by t.nr, rang
  loop
    if r.rang = 1 then
      perform public.bank_schreiben(r.nr, r.kontoinhaber, r.iban, r.bic, r.revtag, 'formular');
      update public.fahrer_iban set status = 'uebernommen', uebernommen_nr = r.nr where id = r.id;
    else
      update public.fahrer_iban set status = 'ueberholt', uebernommen_nr = r.nr where id = r.id;
    end if;
  end loop;
end $$;

-- Was das Buero noch zuordnen muss
create or replace view public.formular_iban_offen with (security_invoker = true) as
select i.id, i.erstellt_am, btrim(i.vorname || ' ' || i.nachname) as name, i.telefon, i.kontoinhaber,
       case when length(public.iban_norm(i.iban)) > 8
            then substr(public.iban_norm(i.iban), 1, 4) || ' •••• ' || right(public.iban_norm(i.iban), 4)
            else public.iban_norm(i.iban) end as iban_kurz,
       case when not public.iban_gueltig(i.iban) then 'IBAN ungültig'
            when public.tel_key(i.telefon) = '' then 'keine Telefonnummer'
            when not exists (select 1 from public.fahrer f where f.aktiv and f.notion_fahrer_id is not null
                             and public.tel_key(f.telefon) = public.tel_key(i.telefon)) then 'kein Fahrer mit dieser Telefonnummer'
            else 'Telefonnummer passt zu mehreren Fahrern' end as grund
from public.fahrer_iban i
where i.status = 'neu' and public.is_app_user();
revoke all on public.formular_iban_offen from public, anon;
grant select on public.formular_iban_offen to authenticated;

create or replace function public.formular_iban_zuordnen(p_id bigint, p_notion_fahrer_id integer)
returns void language plpgsql security definer set search_path = public as $$
declare i public.fahrer_iban;
begin
  if not public.is_app_user() then raise exception 'Nicht autorisiert' using errcode = '42501'; end if;
  select * into i from public.fahrer_iban where id = p_id and status = 'neu' for update;
  if i.id is null then raise exception 'Eintrag % nicht offen', p_id using errcode = 'P0002'; end if;
  if not public.iban_gueltig(i.iban) then raise exception 'IBAN ungültig – bitte beim Fahrer nachfragen' using errcode = '22023'; end if;
  if not exists (select 1 from public.fahrer where aktiv and notion_fahrer_id = p_notion_fahrer_id) then
    raise exception 'Kein aktiver Fahrer mit Nr. %', p_notion_fahrer_id using errcode = 'P0002'; end if;
  perform public.bank_schreiben(p_notion_fahrer_id, i.kontoinhaber, i.iban, i.bic, i.revtag,
          'formular (' || coalesce(auth.jwt()->'app_metadata'->>'app_name', 'Büro') || ')');
  update public.fahrer_iban set status = 'uebernommen', uebernommen_nr = p_notion_fahrer_id where id = p_id;
end $$;
revoke all on function public.formular_iban_zuordnen(bigint, integer) from public, anon;
grant execute on function public.formular_iban_zuordnen(bigint, integer) to authenticated;
```

Hinweis zum Test-Setup: `fahrer_iban` hat im Test keine RLS; live hat sie RLS mit nur der anon-Insert-Policy — die View läuft als `security_invoker` und braucht deshalb eine Lese-Policy fürs Büro. Ans Ende der Migration:

```sql
drop policy if exists buero_liest on public.fahrer_iban;
create policy buero_liest on public.fahrer_iban for select to authenticated using (public.is_app_user());
grant select on public.fahrer_iban to authenticated;
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add migrations/2026-10-15-bankdaten-uebernahme.sql scripts/test-bankdaten.mjs
git commit -m "bankdaten: uebernahme aus dem iban-formular (telefon, neuester gewinnt, nichts ueberschreiben), offene eintraege fuers buero"
```

---

### Task 4: Fahrerapp — Startkarte, Bankdaten, Formular

**Files:**
- Modify: `fahrer/index.html` — `<head>` (Script), CSS-Block, `S`, `laden()`, `route()`/`TAB_FOR`/`render()`, `viewStart()`, `viewMehr()`, Click-Handler, neue Funktionen `bankKarte()`, `viewBank()`, `viewBankAendern()`
- Modify: `sw.js` (Cache-Version, `/bank-logik.js` in `PRECACHE_URLS`)

**Interfaces:**
- Consumes: `BankLogik.*` (Task 1), RPCs `fahrer_app_bank`, `fahrer_bank_setzen`, `bank_bestaetigen` (Task 2).
- Produces: Routen `#bank` und `#bank/aendern`; `S.bank` = Zeile aus `fahrer_app_bank` oder `null`; `S.bankFehler` (bool).

- [ ] **Step 1: Script einbinden** — direkt vor der Zeile `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>`:

```html
    <script src="/bank-logik.js"></script>
```

und in `sw.js` `'/bank-logik.js',` nach `'/fahrer/manifest.json',` einfügen, `CACHE_NAME` um eins erhöhen.

- [ ] **Step 2: Laden** — `S` um `bank: null, bankFehler: false` erweitern und in `laden()` nach `S.offen = …` ergänzen (eigener Aufruf, damit eine fehlende Migration die App nicht lahmlegt):

```js
            const bank = await (arg ? sb.rpc('fahrer_app_bank', arg) : sb.rpc('fahrer_app_bank'))
                .then(r => r, e => ({ error: e }));
            S.bankFehler = !!bank.error;
            S.bank = bank.error ? null : ((bank.data || [])[0] || null);
```

- [ ] **Step 3: Routen** — in `route()` die Liste um `'bank'` erweitern, `TAB_FOR` um `bank: 'mehr'`, in `render()` die View-Tabelle um `bank: (a) => a === 'aendern' ? viewBankAendern() : viewBank()`.

- [ ] **Step 4: CSS** — ans Ende des Style-Blocks:

```css
        .bank-karte { margin: 12px 12px 0; padding: 12px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; }
        .bank-karte.offen { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-faint); }
        .bank-karte.ok { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-mut); border-color: var(--border); }
        .bank-karte .t { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mut); }
        .bank-karte .b { font-size: 20px; font-weight: 700; margin: 4px 0 2px; }
        .bank-karte .i { font-size: 13px; overflow-wrap: anywhere; }
        .bank-karte .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        .bank-karte .acts .btn-primary, .bank-karte .acts .btn-ghost { height: 42px; }
        .bank-form { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
        .bank-form input { height: 44px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); color: var(--text); font-size: 15px; font-family: inherit; width: 100%; box-sizing: border-box; }
        .bank-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-faint); }
        .bank-form .feld-fehler { font-size: 11.5px; color: var(--err); min-height: 0; }
        .bank-form .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }
        .bank-iban { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
```

- [ ] **Step 5: Startkarte** — neue Funktion (vor `viewStart`) und in `viewStart()` jeweils als Erstes ins HTML (`return { html: bankKarte() + '<section class="hero">…` für beide Zweige):

```js
        /* Bankdaten-Karte ganz oben auf Start (Spec 2026-10-15, Abschnitt 3) */
        function bankKarte() {
            if (S.bankFehler) return '';
            const b = S.bank;
            const vorschau = S.mode === 'vorschau';
            const dis = vorschau ? ' disabled title="In der Vorschau nicht möglich"' : '';
            if (!b || !b.iban) {
                return '<section class="bank-karte offen"><div class="t">Bankdaten</div>'
                    + '<div class="i" style="margin-top:4px">Bankdaten fehlen – damit wir dir überweisen können.</div>'
                    + '<div class="acts" style="grid-template-columns:1fr"><a class="btn-primary" href="#bank/aendern">Eintragen</a></div></section>';
            }
            const betrag = num(b.betrag);
            if (!b.woche || b.betrag == null || betrag <= 0) return '';
            const iban = '<span class="bank-iban">' + esc(BankLogik.kurz(b.iban)) + '</span>';
            if (b.bestaetigt_am && b.bestaetigt_iban === b.iban) {
                return '<section class="bank-karte ok">' + ICON_CHECK + '<span>' + esc(kw(b.woche)) + ' bestätigt · ' + iban + '</span></section>';
            }
            return '<section class="bank-karte offen"><div class="t">Auszahlung ' + esc(kw(b.woche)) + '</div>'
                + '<div class="b num">' + fmt(betrag) + '</div>'
                + '<div class="i">an ' + iban + ' · ' + esc(b.kontoinhaber) + '</div>'
                + '<div class="acts"><button type="button" class="btn-primary" data-act="bank-ok" data-woche="' + esc(b.woche) + '"' + dis + '>Stimmt</button>'
                + '<a class="btn-ghost" href="#bank/aendern">IBAN ändern</a></div></section>';
        }
```

- [ ] **Step 6: Ansicht „Bankdaten“ und Formular**

```js
        function viewBank() {
            const b = S.bank;
            if (S.bankFehler) return { back: '#mehr', title: 'Bankdaten', html: '<div class="empty"><b>Bankdaten gerade nicht verfügbar.</b><span>Bitte später erneut versuchen.</span></div>' };
            if (!b || !b.iban) return { back: '#mehr', title: 'Bankdaten', html: '<div class="empty"><b>Noch keine Bankdaten.</b><span>Trag deine IBAN ein, damit wir dir überweisen können.</span><a class="btn-primary" href="#bank/aendern" style="margin-top:8px">Eintragen</a></div>' };
            const html = '<div class="group">'
                + kv('Kontoinhaber', esc(b.kontoinhaber))
                + kv('IBAN', '<span class="bank-iban">' + esc(BankLogik.gruppiert(b.iban)) + '</span>')
                + kv('BIC', esc(b.bic || '–'))
                + kv('Revtag', esc(b.revtag || '–'))
                + kv('Zuletzt geändert', b.geaendert_am ? datum(b.geaendert_am) : '–')
                + '</div><div style="padding:12px"><a class="btn-ghost" href="#bank/aendern">Ändern</a></div>'
                + '<div class="note">Eine neue IBAN gilt sofort für deine nächste Auszahlung.</div>';
            return { back: '#mehr', title: 'Bankdaten', html: html };
        }
        function viewBankAendern() {
            const b = S.bank || {};
            const f = (id, label, wert, extra, opt) => '<label class="field"><span class="field-label">' + label + (opt ? ' <span class="opt">(optional)</span>' : '') + '</span>'
                + '<input id="' + id + '" value="' + esc(wert || '') + '" ' + extra + '><span class="feld-fehler" id="' + id + '-f"></span></label>';
            const vorschau = S.mode === 'vorschau';
            const html = '<form class="bank-form" id="bankForm" novalidate>'
                + f('bkInhaber', 'Kontoinhaber', b.kontoinhaber || (S.profil && S.profil.name), 'autocomplete="name" maxlength="140"')
                + f('bkIban', 'IBAN', b.iban ? BankLogik.gruppiert(b.iban) : '', 'autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="42" placeholder="LT12 1000 0111 0100 1000"')
                + f('bkBic', 'BIC', b.bic, 'autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="11"', true)
                + f('bkRevtag', 'Revtag', b.revtag, 'autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="41" placeholder="@deinname"', true)
                + '<span class="feld-fehler" id="bkForm-f"></span>'
                + '<button type="submit" class="btn-primary"' + (vorschau ? ' disabled title="In der Vorschau nicht möglich"' : '') + '>Speichern</button>'
                + '<a class="btn-ghost" href="' + (b.iban ? '#bank' : '#start') + '">Abbrechen</a></form>';
            return { back: b.iban ? '#bank' : '#start', title: b.iban ? 'Bankdaten ändern' : 'Bankdaten eintragen', html: html };
        }
```

- [ ] **Step 7: Mehr-Eintrag** — in `viewMehr()` als erste `<a class="item">` der ersten `.group`:

```js
                + '<a class="item" href="#bank">' + ICON_CASH + '<span class="grow">Bankdaten</span><span style="font-size:12px;color:var(--text-mut)">' + (S.bank && S.bank.iban ? esc(BankLogik.kurz(S.bank.iban)) : 'fehlt') + '</span>' + ICON_CHEV + '</a>'
```

- [ ] **Step 8: Ereignisse** — im vorhandenen `click`-Handler (Kette `else if (act === …)`) ergänzen:

```js
            else if (act === 'bank-ok') { e.preventDefault(); bankBestaetigen(t); }
```

und darunter die Funktionen plus einen `submit`-Listener:

```js
        async function bankNeuLaden() {
            const r = await sb.rpc('fahrer_app_bank').then(x => x, err => ({ error: err }));
            if (!r.error) { S.bank = (r.data || [])[0] || null; S.bankFehler = false; }
        }
        function bankMeldung(err) {
            const m = (err && err.message) || '';
            return /IBAN|BIC|Revtag|Kontoinhaber|Bankdaten|Woche|Auszahlung|Fahrerapp/.test(m) ? m : 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
        }
        async function bankBestaetigen(btn) {
            if (btn.disabled || S.mode === 'vorschau') return;
            btn.disabled = true; btn.textContent = 'Speichere …';
            const { error } = await sb.rpc('bank_bestaetigen', { p_woche: btn.getAttribute('data-woche') }).then(x => x, err => ({ error: err }));
            if (error) { alert(bankMeldung(error)); }
            await bankNeuLaden();
            render();
        }
        document.addEventListener('submit', async function(e) {
            if (!e.target || e.target.id !== 'bankForm') return;
            e.preventDefault();
            if (S.mode === 'vorschau') return;
            const wert = id => document.getElementById(id).value;
            const setz = (id, txt) => { document.getElementById(id + '-f').textContent = txt; };
            const fehler = {
                bkInhaber: BankLogik.inhaberFehler(wert('bkInhaber')),
                bkIban: BankLogik.ibanFehler(wert('bkIban')),
                bkBic: BankLogik.bicFehler(wert('bkBic')),
                bkRevtag: BankLogik.revtagFehler(wert('bkRevtag'))
            };
            Object.keys(fehler).forEach(id => setz(id, fehler[id]));
            setz('bkForm', '');
            const erstes = Object.keys(fehler).find(id => fehler[id]);
            if (erstes) { document.getElementById(erstes).focus(); return; }
            const knopf = e.target.querySelector('button[type=submit]');
            knopf.disabled = true; knopf.textContent = 'Speichere …';
            const { error } = await sb.rpc('fahrer_bank_setzen', {
                p_kontoinhaber: wert('bkInhaber'), p_iban: wert('bkIban'),
                p_bic: wert('bkBic') || null, p_revtag: wert('bkRevtag') || null
            }).then(x => x, err => ({ error: err }));
            if (error) { setz('bkForm', bankMeldung(error)); knopf.disabled = false; knopf.textContent = 'Speichern'; return; }
            await bankNeuLaden();
            location.hash = '#start';
        });
```

- [ ] **Step 9: Ansehen** — lokal wie beim Dashboard: Kopie mit gestubbtem Login ist hier nicht nötig, die Vorschau-Ansicht reicht nicht (Knöpfe gesperrt). Deshalb mit `scripts/shot.js` und einem Eval, der `S` direkt setzt und `render()` ruft:
  - je Lage (keine Bankdaten / offen / bestätigt / Betrag ≤ 0) einen Screenshot bei 390×800 hell und dunkel, dazu `#bank` und `#bank/aendern` mit einer ungültigen IBAN nach Klick auf Speichern.
  - Prüfen: kein seitliches Scrollen (`document.documentElement.scrollWidth <= innerWidth`), Karte steht über der Wochenübersicht.

Konkret (Server im Scratchpad wie in der Sitzung vom 12.10.: `python3 -m http.server` im Repo-Ordner, `_dev-session.html` setzt nur das Dashboard; für die Fahrerapp direkt `http://localhost:<port>/fahrer/` öffnen und per Eval `show('shell'); S.mode='fahrer'; S.profil={name:'Anna Fahr',fahrer_nr:101}; S.abr=[]; S.offen=[]; S.bank={…}; location.hash='#start'; render();` setzen).

- [ ] **Step 10: Prüfen und committen**

Run: `node --test scripts/test-bank-logik.mjs && node -e "require('vm'); const s=require('fs').readFileSync('fahrer/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g).map(x=>x.replace(/<\/?script>/g,'')); s.forEach((c,i)=>{ new (require('vm').Script)(c, {filename:'inline'+i}); }); console.log('syntax ok', s.length)"`
Expected: Tests PASS, `syntax ok`

```bash
git add fahrer/index.html sw.js
git commit -m "fahrerapp: bankdaten - karte ganz oben auf start (eintragen / auszahlung bestaetigen), ansicht und formular unter mehr; cache v+1"
```

---

### Task 5: Dashboard — Bankdaten im Fahrer-Detail

**Files:**
- Modify: `dashboard.html` — `<head>` (Script), `ladeFahrer()`, `fzListe()`, `renderFahrer()` (Zähler + Spalte), Filter-Chips (Zeile ~1287), Tabellenkopf der Fahrerliste, `fzDetailHtml()`, Klick-Handler `fzAppKlick`, neue Funktionen `fzBankHtml()`, `fzBankKlick`, Block „Bankdaten aus dem Formular“ unter den Plattformkonten
- Modify: `sw.js` (Cache-Version)

**Interfaces:**
- Consumes: View `bank_uebersicht`, Tabelle `fahrer_bank_verlauf` (Büro darf lesen), View `formular_iban_offen`, RPCs `buero_bank_setzen`, `formular_iban_zuordnen`, `BankLogik.*`.
- Produces: `FZ_BANK` (Map `notion_fahrer_id → Zeile`), `FB_OFFEN` (Liste), Filter-Wert `fzFilter === 'ohnebank'`.

- [ ] **Step 1: Script einbinden** — vor dem Supabase-CDN-Script in `dashboard.html`: `<script src="/bank-logik.js"></script>`.

- [ ] **Step 2: Laden** — in `ladeFahrer()` zwei weitere `still(…)`-Aufrufe an `Promise.all` hängen (`sb.from('bank_uebersicht').select('*')`, `sb.from('formular_iban_offen').select('*').order('erstellt_am')`), das `.catch` auf 8 Einträge erweitern, danach:

```js
            FZ_BANK = {};
            FZ_BANK_DA = !bank.error;
            if (!bank.error) (bank.data || []).forEach(function (b) { FZ_BANK[b.notion_fahrer_id] = b; });
            FB_OFFEN = fbOffen.error ? [] : (fbOffen.data || []);
```

Deklaration neben `let FZ = [] …`: `let FZ_BANK = {}, FZ_BANK_DA = false, FB_OFFEN = [], fzBankForm = null, fzBankVerlauf = {};`

- [ ] **Step 3: Filter und Spalte** — Chip nach „ohne App“: `<button class="chip" data-fz="ohnebank">Bankdaten fehlen <span class="cnt" id="fzCntOhneBank"></span></button>`; in `fzListe()`: `else if (fzFilter === 'ohnebank') { rows = rows.filter(function (f) { return f.aktiv && !fzBank(f); }); }`; Helfer `function fzBank(f) { const b = f.notion_fahrer_id != null ? FZ_BANK[f.notion_fahrer_id] : null; return b && b.iban ? b : null; }`; in `renderFahrer()` `document.getElementById('fzCntOhneBank').textContent = FZ_BANK_DA ? aktiv.filter(function (f) { return !fzBank(f); }).length : '';`. Spalte „Bank“ im Tabellenkopf nach „App-Status“ und je Zeile `'<td>' + fzBankZelle(f) + '</td>'`, `colspan` der Leer-/Fehlerzeilen von 6 auf 7:

```js
        function fzBankZelle(f) {
            if (!FZ_BANK_DA) return '–';
            const b = fzBank(f);
            if (!b) return '<span class="dot aus"></span>fehlt';
            const best = b.bestaetigt_am && b.bestaetigt_iban === b.iban;
            return '<span class="dot' + (best ? '' : ' warn') + '"></span>' + (best ? esc(String(b.woche || '').replace(/^\d{4}-/, '')) + ' bestätigt' : 'hinterlegt');
        }
```

Auf dem Handy (`isMobile()`) die Spalte weglassen wie die übrigen Zusatzspalten — vorher prüfen, welche Spalten der mobile Zweig in `renderFahrer()` ausgibt, und nur im Desktop-Zweig ergänzen.

- [ ] **Step 4: Block im Detail** — in `fzDetailHtml(f)` nach `fzAppHtml(f) +` einfügen `fzBankHtml(f) +`:

```js
        function fzBankHtml(f) {
            if (!FZ_BANK_DA || f.notion_fahrer_id == null) return '';
            const b = fzBank(f);
            const nr = f.notion_fahrer_id;
            function kv(k, v) { return '<div class="detail-kv"><span>' + k + '</span><span>' + v + '</span></div>'; }
            let html = '<div class="detail-sec">Bankdaten</div>';
            if (fzBankForm === nr) {
                const w = b || {};
                html += '<div class="fz-bank-form" data-fzbankform="' + nr + '">' +
                    '<input type="text" data-bk="inhaber" placeholder="Kontoinhaber" value="' + esc(w.kontoinhaber || f.name || '') + '">' +
                    '<input type="text" data-bk="iban" placeholder="IBAN" value="' + esc(w.iban ? BankLogik.gruppiert(w.iban) : '') + '">' +
                    '<input type="text" data-bk="bic" placeholder="BIC (optional)" value="' + esc(w.bic || '') + '">' +
                    '<input type="text" data-bk="revtag" placeholder="Revtag (optional)" value="' + esc(w.revtag || '') + '">' +
                    '<div class="fz-bank-fehler" data-bkfehler="1"></div>' +
                    '<div class="detail-acts"><button class="btn-primary ok" data-fzbanksave="' + nr + '">Speichern</button>' +
                    '<button class="btn-ghost" data-fzbankzu="1">Abbrechen</button></div></div>';
                return html;
            }
            if (!b) {
                html += kv('IBAN', '<span style="color:var(--text-mut)">fehlt</span>');
            } else {
                const best = b.bestaetigt_am && b.bestaetigt_iban === b.iban;
                html += kv('Kontoinhaber', esc(b.kontoinhaber)) +
                    kv('IBAN', '<span class="num">' + esc(BankLogik.gruppiert(b.iban)) + '</span>') +
                    kv('BIC / Revtag', esc((b.bic || '–') + ' · ' + (b.revtag || '–'))) +
                    kv('Geändert', esc(fmtDatumZeit(b.geaendert_am)) + ' · ' + esc(b.geaendert_von || '')) +
                    kv(esc(b.woche || 'Woche'), best ? 'bestätigt ' + esc(fmtDatumZeit(b.bestaetigt_am)) : '<span style="color:var(--warn)">nicht bestätigt</span>');
                if (b.aenderungen > 1) {
                    const v = fzBankVerlauf[nr];
                    html += v ? '<div class="fz-bank-verlauf">' + v.map(function (x) {
                        return '<div>' + esc(fmtDatumZeit(x.zeit)) + ' · ' + esc(x.von) + ': ' + esc(x.alt_iban ? BankLogik.kurz(x.alt_iban) : '–') + ' → ' + esc(BankLogik.kurz(x.neu_iban)) + '</div>';
                    }).join('') + '</div>' : '<button class="btn-ghost" data-fzbankverlauf="' + nr + '">Verlauf (' + b.aenderungen + ' Änderungen)</button>';
                }
            }
            return html + '<div class="detail-acts"><button class="btn-ghost" data-fzbankauf="' + nr + '">' + (b ? 'Bankdaten ändern' : 'Bankdaten eintragen') + '</button></div>';
        }
```

`fmtDatumZeit` ist der vorhandene Datums-Formatierer des Dashboards — vorher mit `grep -n "function fmtDatum\|function fmtDate\|function datumZeit" dashboard.html` den tatsächlichen Namen nachsehen und einsetzen; gibt es keinen mit Uhrzeit, `new Date(x).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' })` als lokalen Helfer `fzZeit()` anlegen.

CSS ergänzen (bei den `.pk-…`-Regeln):

```css
        .fz-bank-form { display: grid; gap: 6px; }
        .fz-bank-form input { width: 100%; box-sizing: border-box; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 7px 12px; font-size: 13px; color: var(--text); font-family: inherit; }
        .fz-bank-fehler { color: var(--err); font-size: 11.5px; }
        .fz-bank-verlauf { font-size: 11.5px; color: var(--text-mut); display: grid; gap: 3px; margin-top: 6px; }
```

- [ ] **Step 5: Klicks** — am Anfang von `fzAppKlick(e)`:

```js
            const bAuf = e.target.closest('[data-fzbankauf]');
            if (bAuf) { fzBankForm = parseInt(bAuf.dataset.fzbankauf, 10); renderFahrer(); return; }
            if (e.target.closest('[data-fzbankzu]')) { fzBankForm = null; renderFahrer(); return; }
            const bVer = e.target.closest('[data-fzbankverlauf]');
            if (bVer) {
                const nr = parseInt(bVer.dataset.fzbankverlauf, 10);
                const r = await getSupabase().from('fahrer_bank_verlauf').select('zeit,von,alt_iban,neu_iban').eq('notion_fahrer_id', nr).order('zeit', { ascending: false });
                fzBankVerlauf[nr] = r.error ? [] : (r.data || []); renderFahrer(); return;
            }
            const bSave = e.target.closest('[data-fzbanksave]');
            if (bSave) {
                const box = bSave.closest('[data-fzbankform]');
                const w = function (k) { return box.querySelector('[data-bk="' + k + '"]').value; };
                const fehler = BankLogik.inhaberFehler(w('inhaber')) || BankLogik.ibanFehler(w('iban')) || BankLogik.bicFehler(w('bic')) || BankLogik.revtagFehler(w('revtag'));
                if (fehler) { box.querySelector('[data-bkfehler]').textContent = fehler; return; }
                bSave.disabled = true;
                const { error } = await getSupabase().rpc('buero_bank_setzen', { p_notion_fahrer_id: parseInt(bSave.dataset.fzbanksave, 10),
                    p_kontoinhaber: w('inhaber'), p_iban: w('iban'), p_bic: w('bic') || null, p_revtag: w('revtag') || null });
                if (error) { box.querySelector('[data-bkfehler]').textContent = fgFehler(error); bSave.disabled = false; return; }
                fzBankForm = null; delete fzBankVerlauf[parseInt(bSave.dataset.fzbanksave, 10)];
                showReToast('Bankdaten gespeichert', 'success');
                await ladeFahrer(); return;
            }
```

Prüfen, dass `fzAppKlick` `async` ist (Zeile ~2920: `async function fzAppKlick`); sonst `async` ergänzen.

- [ ] **Step 6: Offene Formular-Einträge** — unter der Karte „Plattformkonten ohne Fahrer“ (gleiche `.pk-karte`-Optik) einen Block `id="fbListe"` ins Markup setzen (nach dem schließenden `</div>` von `pkListe`s Karte):

```html
                <div class="pk-karte" id="fbKarte" hidden>
                    <div class="pk-kopf"><h4>Bankdaten aus dem Formular, nicht zugeordnet</h4></div>
                    <div class="pk-liste" id="fbListe"></div>
                </div>
```

und eine Render-Funktion, aufgerufen am Ende von `ladeFahrer()`:

```js
        function renderFormularBank() {
            const karte = document.getElementById('fbKarte');
            karte.hidden = !FB_OFFEN.length;
            if (!FB_OFFEN.length) return;
            const aktive = FZ.filter(function (f) { return f.aktiv && f.notion_fahrer_id != null; })
                .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'de'); });
            document.getElementById('fbListe').innerHTML = FB_OFFEN.map(function (x) {
                return '<div class="pk-card"><div class="pk-card-top"><b>' + esc(x.name) + '</b><span class="num">' + esc(x.iban_kurz) + '</span></div>' +
                    '<div class="pk-meta">' + esc([x.telefon || 'keine Nummer', x.kontoinhaber, x.grund].join(' · ')) + '</div>' +
                    (x.grund === 'IBAN ungültig' ? '' :
                    '<select data-fbsel="' + x.id + '"><option value="">Fahrer wählen …</option>' + aktive.map(function (f) {
                        return '<option value="' + f.notion_fahrer_id + '">' + esc(f.name) + ' · Nr. ' + f.notion_fahrer_id + '</option>'; }).join('') + '</select>' +
                    '<div class="detail-acts"><button class="btn-ghost" data-fbzu="' + x.id + '">Zuordnen</button></div>') + '</div>';
            }).join('');
        }
```

Listener einmalig registrieren (dort, wo `pkListe` seinen Listener bekommt):

```js
            document.getElementById('fbListe').addEventListener('click', async function (e) {
                const b = e.target.closest('[data-fbzu]');
                if (!b || b.disabled) return;
                const sel = document.querySelector('[data-fbsel="' + b.dataset.fbzu + '"]');
                const nr = sel ? parseInt(sel.value, 10) : NaN;
                if (!nr) { alert('Bitte einen Fahrer wählen.'); return; }
                b.disabled = true;
                const { error } = await getSupabase().rpc('formular_iban_zuordnen', { p_id: parseInt(b.dataset.fbzu, 10), p_notion_fahrer_id: nr });
                if (error) { alert('Zuordnen fehlgeschlagen: ' + fgFehler(error)); b.disabled = false; return; }
                showReToast('Bankdaten übernommen', 'success');
                await ladeFahrer();
            });
```

- [ ] **Step 7: Ansehen** — Kopie mit gestubbtem Login im Scratchpad (wie am 12.10.: `forceLogout` leeren, `_dev-session.html`), per Eval `FZ`, `FZ_BANK`, `FZ_BANK_DA = true`, `FB_OFFEN` setzen und `renderFahrer(); renderFormularBank();` — Detail mit Bankdaten (bestätigt / nicht bestätigt / fehlt), Formular mit kaputter IBAN, Filter „Bankdaten fehlen“; 1280 hell und 390 dunkel.

- [ ] **Step 8: Prüfen und committen**

Run: `bash scripts/check-dashboard.sh`
Expected: `OK: dashboard.html`

```bash
git add dashboard.html sw.js
git commit -m "dashboard: bankdaten im fahrer-detail (anzeigen, eintragen, verlauf), filter bankdaten fehlen, spalte bank, offene formular-eintraege zuordnen; cache v+1"
```

---

### Task 6: Einspielen, live prüfen, dokumentieren

**Files:**
- Modify: `CLAUDE.md` (Abschnitt „Bankdaten (seit 2026-10-15)“ nach „Post & Strafen“)

- [ ] **Step 1: Beide Tests ein letztes Mal**

Run: `node --test scripts/test-bank-logik.mjs && PGLITE=/tmp/pglite node scripts/test-bankdaten.mjs`
Expected: PASS / `OK`

- [ ] **Step 2: Migrationen einspielen** — per Supabase-MCP `apply_migration`, Namen `bankdaten` und danach `bankdaten_uebernahme`, Inhalt jeweils die Datei 1:1.

- [ ] **Step 3: Live prüfen (nur lesen)**

```sql
select (select count(*) from public.fahrer_bank) bank,
       (select count(*) from public.fahrer_bank_verlauf) verlauf,
       (select string_agg(status || '=' || n, ', ') from (select status, count(*) n from public.fahrer_iban group by 1) s) formular,
       (select count(*) from public.formular_iban_offen) offen,  -- als postgres: View filtert auf is_app_user() -> 0 ist hier normal
       public.bank_woche() woche,
       public.iban_gueltig('AT611904300234573201') ok_at;
```

Expected: `bank` = Anzahl `uebernommen`, `verlauf` = `bank`, `ok_at` = true. Zusätzlich die Supabase-Advisors (`get_advisors` security) auf neue Warnungen zu den neuen Objekten ansehen.

- [ ] **Step 4: CLAUDE.md** — Abschnitt anlegen:

```markdown
## Bankdaten (seit 2026-10-15)

Spec `docs/superpowers/specs/2026-10-15-iban-fahrerapp-design.md`, Plan `docs/superpowers/plans/2026-10-15-iban-fahrerapp.md`.
- Tabellen `fahrer_bank` (aktuell, je Notion-Nr.), `fahrer_bank_verlauf` (jede Änderung, Trigger sperrt Update/Delete),
  `bank_bestaetigung` (je Woche). Lesen nur Büro; schreiben nur über `fahrer_bank_setzen` / `bank_bestaetigen` (Fahrer)
  und `buero_bank_setzen` / `formular_iban_zuordnen` (Büro), alle über `bank_schreiben()`.
- Neue IBAN gilt sofort (Entscheidung Betreiber); IBAN-/Inhaberwechsel löscht die Bestätigung der offenen Woche.
- IBAN-Prüfung doppelt mit gleichen Regeln: `bank-logik.js` (Browser, `node --test scripts/test-bank-logik.mjs`) und
  `iban_gueltig()` (SQL). DB-Test: `PGLITE=<dir> node scripts/test-bankdaten.mjs`.
- Das öffentliche Formular `~/Projects/iban-formular` (Netlify, `fahrer_iban`) läuft noch; abschalten, wenn der
  Betreiber es sagt (anon-Insert-Policy entfernen, Seite durch Hinweis ersetzen).
- **Teil B (Revolut-Auszahlung) ist nur entworfen — nicht bauen ohne Auftrag.**
```

- [ ] **Step 5: Commit und Push-Hinweis**

```bash
git add CLAUDE.md
git commit -m "doku: bankdaten"
```

Dem Betreiber sagen: Datenbank ist live, Fahrerapp/Dashboard erst nach `! git -C ~/Projects/hydrafleet push origin plattform-anbindung:main`; danach in der Fahrerapp mit einem Test-Zugang einmal eintragen und bestätigen.
