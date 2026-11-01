// node --test scripts/test-fuhrpark-logik.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fahrerIdsAusRelation, relationBody, notionNachziehen } from '../supabase/functions/_shared/fuhrpark-logik.ts';

const nrJePage = new Map([['aaaa1111bbbb2222cccc3333dddd4444', 101], ['eeee5555ffff6666aaaa7777bbbb8888', 103]]);

test('Fahrer aktuell: Page-IDs mit/ohne Bindestriche, unbekannte weg, keine Doppelten', () => {
  const seite = { properties: { 'Fahrer aktuell': { relation: [
    { id: 'aaaa1111-bbbb-2222-cccc-3333dddd4444' }, { id: 'EEEE5555FFFF6666AAAA7777BBBB8888' },
    { id: 'ffffffff-0000-0000-0000-000000000000' }, { id: 'aaaa1111bbbb2222cccc3333dddd4444' }] } } };
  assert.deepEqual(fahrerIdsAusRelation(seite, nrJePage), [101, 103]);
  assert.deepEqual(fahrerIdsAusRelation({ properties: {} }, nrJePage), []);
});

test('relationBody setzt bzw. leert "Fahrer aktuell"', () => {
  assert.deepEqual(relationBody(['p1', 'p2']), { properties: { 'Fahrer aktuell': { relation: [{ id: 'p1' }, { id: 'p2' }] } } });
  assert.deepEqual(relationBody([]), { properties: { 'Fahrer aktuell': { relation: [] } } });
});

function attrappe(antworten) {
  const erledigt = [], gepatcht = [];
  return {
    erledigt, gepatcht,
    deps: {
      soll: async (keys) => [
        { kennzeichen_key: 'W1TX', notion_page_id: 'pg1', page_ids: ['p101'], seit: 's1' },
        { kennzeichen_key: 'W2TX', notion_page_id: 'pg2', page_ids: [], seit: 's2' },
        { kennzeichen_key: 'W9TX', notion_page_id: null, page_ids: [], seit: 's9' },
      ].filter((z) => !keys || keys.includes(z.kennzeichen_key)),
      patch: async (page, body) => { gepatcht.push([page, body]); return antworten[page] ?? { ok: true, status: 200, text: '' }; },
      erledigt: async (key, seit) => { erledigt.push([key, seit]); },
    },
  };
}

test('Nachziehen: Erfolg streicht aus offen, Notion-Fehler laesst offen, ohne Seite = Fehler', async () => {
  const a = attrappe({ pg2: { ok: false, status: 502, text: 'Bad Gateway' } });
  const r = await notionNachziehen(null, a.deps);
  assert.deepEqual(r.ok, ['W1TX']);
  assert.deepEqual(r.fehler.map((f) => f.key), ['W2TX', 'W9TX']);
  assert.match(r.fehler[0].text, /502/);
  assert.deepEqual(a.erledigt, [['W1TX', 's1']]);   // mit seit: neuere Vormerkung bleibt (Review #2)
  assert.deepEqual(a.gepatcht.map((g) => g[0]), ['pg1', 'pg2']);
});

test('Nachziehen nur fuer genannte Autos; Ausnahme beim Patch wird Fehler, kein Abbruch', async () => {
  const a = attrappe({});
  a.deps.patch = async (page) => { if (page === 'pg1') throw new Error('Netz weg'); return { ok: true, status: 200, text: '' }; };
  const r = await notionNachziehen(['W1TX', 'W2TX'], a.deps);
  assert.deepEqual(r.ok, ['W2TX']);
  assert.match(r.fehler[0].text, /Netz weg/);
});
