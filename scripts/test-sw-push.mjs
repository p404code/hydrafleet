// Test des Push-Teils von sw.js (Zahl am App-Symbol, offene App bescheid geben) mit Attrappen.
//   node --test scripts/test-sw-push.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function laden({ fenster = [], mitBadge = true } = {}) {
  const W = { hoerer: {}, gezeigt: [], badge: [], post: [] };
  const nav = mitBadge ? { setAppBadge: async (n) => { W.badge.push(n); }, clearAppBadge: async () => { W.badge.push(0); } } : {};
  const self = {
    addEventListener: (typ, f) => { W.hoerer[typ] = f; },
    registration: { showNotification: async (t, o) => { W.gezeigt.push({ t, ...o }); } },
    skipWaiting: () => {}, navigator: nav,
  };
  const clients = { matchAll: async () => fenster.map((url) => ({ url, postMessage: (m) => W.post.push({ url, ...m }), focus: async () => {} })),
    claim: async () => {}, openWindow: async () => {} };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'),
    { self, clients, caches: {}, fetch: async () => {}, URL, Promise, console });
  W.push = async (daten) => {
    const warte = [];
    W.hoerer.push({ data: { json: () => daten, text: () => JSON.stringify(daten) }, waitUntil: (p) => warte.push(p) });
    await Promise.all(warte);
  };
  return W;
}

test('Push mit Zahl: Benachrichtigung, Zahl am App-Symbol, offene Fahrerapp laedt neu', async () => {
  const W = laden({ fenster: ['https://app.hydrafleet.at/fahrer/#start', 'https://app.hydrafleet.at/dashboard.html'] });
  await W.push({ title: 'HYDRAlink', body: 'Büro: Hallo', ungelesen: 2 });
  assert.equal(W.gezeigt.length, 1);
  assert.equal(W.gezeigt[0].body, 'Büro: Hallo');
  assert.deepEqual(W.badge, [2]);
  assert.deepEqual(W.post, [{ url: 'https://app.hydrafleet.at/fahrer/#start', typ: 'neu' }]);
});

test('Push ohne Zahl (alter Server) laesst das Symbol in Ruhe', async () => {
  const W = laden();
  await W.push({ body: 'Büro: Hallo' });
  assert.equal(W.gezeigt.length, 1);
  assert.deepEqual(W.badge, []);
});

test('Geraet ohne Symbol-Zahl (setAppBadge fehlt): Benachrichtigung trotzdem', async () => {
  const W = laden({ mitBadge: false });
  await W.push({ body: 'Büro: Hallo', ungelesen: 1 });
  assert.equal(W.gezeigt.length, 1);
});
