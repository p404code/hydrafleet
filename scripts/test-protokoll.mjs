// Datenbank-Test fuer das Protokoll, lokal in einem eingebauten Postgres (PGlite) – die Live-Datenbank wird nicht beruehrt.
//
//   npm i --prefix /tmp/pglite @electric-sql/pglite        (einmalig, ausserhalb des Repos)
//   PGLITE=/tmp/pglite node scripts/test-protokoll.mjs
//
// Ablauf: Tabellen-Nachbau (test-protokoll-schema.sql) -> Migration -> scripts/test-protokoll.sql (Asserts).
// Bestanden = "OK", sonst die Assert-Meldung und Exit-Code 1.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const basis = process.env.PGLITE;
if (!basis) { console.error('PGLITE fehlt – siehe Kopf dieser Datei.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(join(basis, 'node_modules/@electric-sql/pglite/dist/index.js')).href);

const db = new PGlite();
try {
  await db.exec(lies('./test-protokoll-schema.sql'));
  // set local / set_config(…, true) wirken nur in einer Transaktion
  await db.exec('begin;\n' + lies('../migrations/2026-10-08-protokoll.sql') + '\n' + lies('./test-protokoll.sql') + '\ncommit;');
  const r = await db.query('select count(*)::int as n from public.protokoll');
  console.log('OK – ' + r.rows[0].n + ' Protokollzeilen im Testlauf');
} catch (e) {
  console.error('FEHLER: ' + (e && e.message || e));
  if (e && e.where) console.error(e.where);
  process.exit(1);
}
