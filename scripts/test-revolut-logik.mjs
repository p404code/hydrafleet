// node --test scripts/test-revolut-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicKey, createVerify } from 'node:crypto';
import { referenz, auswahl, nameTeilen, counterpartyBody, statusAusTransaktion, clientAssertion, signaturGueltig, hmacHex, wocheGueltig }
  from '../supabase/functions/_shared/revolut-logik.ts';

const K = (x) => ({ notion_fahrer_id: 1, name: 'Anna Fahr', betrag: 100, kontoinhaber: 'Anna Fahr', iban: 'LT121000011101001000', bic: null,
  revtag: null, geprueft: true, counterparty_id: null, counterparty_account_id: null, empfaenger: null, csv_exportiert: 0,
  zahlung_status: null, zahlung_betrag: null, ...x });

test('referenz eindeutig je Woche und Fahrer', () => {
  assert.equal(referenz('2026-W42', 123), 'Auszahlung KW42/26 FHR-123');
  assert.equal(referenz('2026-W07', 5), 'Auszahlung KW7/26 FHR-5');
  assert.ok(wocheGueltig('2026-W42') && !wocheGueltig('2026-42') && !wocheGueltig(null));
});

test('auswahl: nur gepruefte, positive, nicht schon ausgezahlte', () => {
  const r = auswahl([
    K({ notion_fahrer_id: 1, betrag: '450.004' }),
    K({ notion_fahrer_id: 2, name: 'Neg', betrag: -20 }),
    K({ notion_fahrer_id: 3, name: 'Null', betrag: 0 }),
    K({ notion_fahrer_id: 4, name: 'Ohne', iban: null }),
    K({ notion_fahrer_id: 5, name: 'Offen', geprueft: false }),
    K({ notion_fahrer_id: 6, name: 'CSV', csv_exportiert: '50' }),
    K({ notion_fahrer_id: 7, name: 'Entwurf', zahlung_status: 'entwurf' }),
    K({ notion_fahrer_id: 8, name: 'Verworfen', zahlung_status: 'verworfen', betrag: 10 }),
    K({ notion_fahrer_id: 9, name: 'Ab', betrag: 5 }),
    K({ notion_fahrer_id: 10, name: 'App', seit_freigabe_ueberwiesen: '80.5' }),
  ], '2026-W42', [1, 8]);
  assert.deepEqual(r.posten.map((p) => [p.notion_fahrer_id, p.betrag_eur, p.referenz]),
    [[1, 450, 'Auszahlung KW42/26 FHR-1'], [8, 10, 'Auszahlung KW42/26 FHR-8']]);
  assert.equal(r.summe, 460);
  assert.deepEqual(r.uebersprungen.map((u) => [u.notion_fahrer_id, u.grund]), [
    [2, 'negativer Betrag'], [3, 'kein Betrag'], [4, 'keine Bankdaten'], [5, 'Bankdaten ungeprüft'],
    [6, 'schon per Revolut-CSV exportiert'], [7, 'schon bei Revolut (entwurf)'], [9, 'abgewählt'], [10, 'seit Freigabe schon überwiesen (80.50 €)']]);
  assert.equal(auswahl([K({})], '2026-W42').posten.length, 1);   // ohne Auswahl: alle
});

test('counterparty: Revtag vor IBAN, Name geteilt', () => {
  assert.deepEqual(nameTeilen('Sayd Emin Techiev'), { first_name: 'Sayd Emin', last_name: 'Techiev' });
  assert.equal(nameTeilen('Einwort'), null);
  assert.deepEqual(counterpartyBody(K({ revtag: '@anna.f' })), { art: 'revtag', body: { profile_type: 'personal', name: 'Anna Fahr', revtag: 'anna.f' } });
  assert.deepEqual(counterpartyBody(K({ revtag: '@anna.f', bic: 'REVOLT21' }), false), { art: 'iban', body: {
    bank_country: 'LT', currency: 'EUR', iban: 'LT121000011101001000', bic: 'REVOLT21', individual_name: { first_name: 'Anna', last_name: 'Fahr' } } });
  assert.equal(counterpartyBody(K({ kontoinhaber: 'Firma' })).body.company_name, 'Firma');
});

test('status aus Revolut-Transaktion', () => {
  assert.equal(statusAusTransaktion('created'), 'pending');
  assert.equal(statusAusTransaktion('COMPLETED'), 'completed');
  assert.equal(statusAusTransaktion('reverted'), 'reverted');
  assert.equal(statusAusTransaktion('irgendwas'), null);
});

test('client assertion: RS256, mit PKCS#8 und PKCS#1 (LibreSSL)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rv-'));
  execFileSync('openssl', ['genrsa', '-out', join(d, 'k8.pem'), '2048'], { stdio: 'ignore' });
  execFileSync('openssl', ['rsa', '-in', join(d, 'k8.pem'), '-traditional', '-out', join(d, 'k1.pem')], { stdio: 'ignore' });
  for (const f of ['k8.pem', 'k1.pem']) {
    const pem = readFileSync(join(d, f), 'utf8');
    const jwt = await clientAssertion(pem, 'cid-1', 'hydrafleet.pages.dev', 1000);
    const [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'hydrafleet.pages.dev', sub: 'cid-1', aud: 'https://revolut.com', exp: 1300 });
    const v = createVerify('RSA-SHA256'); v.update(h + '.' + p);
    assert.ok(v.verify(createPublicKey(pem), Buffer.from(s, 'base64url')), f);
  }
});

test('webhook-signatur', async () => {
  const body = '{"event":"TransactionCreated"}', ts = '1760000000000';
  const sig = 'v1=' + await hmacHex('geheim', `v1.${ts}.${body}`);
  assert.equal(await signaturGueltig('geheim', sig, ts, body, 1760000000000 + 1000), true);
  assert.equal(await signaturGueltig('geheim', 'v1=alt,' + sig, ts, body, 1760000000000), true);   // Schluesselwechsel
  assert.equal(await signaturGueltig('geheim', sig, ts, body + ' ', 1760000000000), false);
  assert.equal(await signaturGueltig('anders', sig, ts, body, 1760000000000), false);
  assert.equal(await signaturGueltig('geheim', sig, ts, body, 1760000000000 + 6 * 60 * 1000), false);   // zu alt
  assert.equal(await signaturGueltig('geheim', null, ts, body), false);
});

test('buchung aus revolut-transaktion', async () => {
  const { gegenparteienKarte, buchungAusTransaktion } = await import('../supabase/functions/_shared/revolut-logik.ts');
  const k = gegenparteienKarte([{ id: 'cp1', name: 'Anna Fahr', accounts: [{ id: 'acc1', iban: 'lt12 1000 0111 0100 1000' }] }, { id: 'cp2', name: 'Bert' }]);
  const tx = { id: 't1', type: 'transfer', state: 'completed', created_at: '2026-10-13T08:00:00Z', completed_at: '2026-10-13T08:01:00Z',
    reference: 'Auszahlung KW41 FHR-101', legs: [{ leg_id: 'l1', account_id: 'src', amount: -450.004, currency: 'EUR', description: 'To Anna Fahr',
      counterparty: { id: 'cp1', account_id: 'acc1', account_type: 'external' } }] };
  assert.deepEqual(buchungAusTransaktion(tx, k), { id: 't1', typ: 'transfer', state: 'completed', erstellt_am: '2026-10-13T08:00:00Z',
    abgeschlossen_am: '2026-10-13T08:01:00Z', konto_id: 'src', betrag: 450, waehrung: 'EUR', referenz: 'Auszahlung KW41 FHR-101',
    beschreibung: 'To Anna Fahr', gegen_counterparty_id: 'cp1', gegen_account_id: 'acc1', gegen_name: 'Anna Fahr', gegen_iban: 'LT121000011101001000' });
  // Revolut-intern (kein Konto in der Liste): Name ueber die Gegenpartei, sonst aus der Beschreibung
  assert.equal(buchungAusTransaktion({ ...tx, legs: [{ ...tx.legs[0], counterparty: { id: 'cp2' } }] }, k).gegen_name, 'Bert');
  assert.equal(buchungAusTransaktion({ ...tx, legs: [{ ...tx.legs[0], counterparty: null, description: 'To Cem Neu' }] }, k).gegen_name, 'Cem Neu');
  assert.equal(buchungAusTransaktion({ ...tx, legs: [{ ...tx.legs[0], amount: 20 }] }, k), null);     // Eingang
  assert.equal(buchungAusTransaktion({ ...tx, type: 'card_payment' }, k), null);                     // keine Ueberweisung
});
