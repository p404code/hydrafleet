// Schneidet die Netzwerkaufrufe von fleethub.uber.com mit, waehrend ein Mensch
// im geoeffneten Fenster arbeitet. Ziel: herausfinden, welche Endpunkte die
// Fleet-Oberflaeche benutzt, damit uber-sync sie nachspielen kann.
//
//   node scripts/uber-capture.js [ausgabedatei]
//
// Es wird NUR aufgezeichnet, was an *.uber.com geht. Alles andere wird ignoriert.
// Das Browserprofil liegt in ~/.hydrafleet-uber-profile und bleibt erhalten,
// die Anmeldung ueberlebt also einen Neustart.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = '/Users/pepe/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/' +
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PROFIL = path.join(os.homedir(), '.hydrafleet-uber-profile');
const OUT = process.argv[2] || path.join(os.homedir(), 'Downloads', 'uber-capture.jsonl');
const PORT = 9333;

fs.mkdirSync(PROFIL, { recursive: true });
const schreiber = fs.createWriteStream(OUT, { flags: 'a' });
const notiere = (o) => schreiber.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relevant = (url) => /^https?:\/\/[^/]*\buber\.com\//i.test(url || '');

const chrome = spawn(BIN, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFIL}`,
  '--no-first-run', '--no-default-browser-check',
  'https://fleethub.uber.com/',
], { stdio: 'ignore' });

let id = 0;
const offen = {};
function verbinde(ws) {
  return {
    send: (method, params = {}, sessionId) => new Promise((r) => {
      const i = ++id;
      offen[i] = r;
      ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
    }),
  };
}

async function main() {
  let info;
  for (let i = 0; i < 100; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) {}
    await sleep(200);
  }
  if (!info) { console.error('Browser nicht erreichbar'); process.exit(1); }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = verbinde(ws);

  const anfragen = new Map();   // requestId -> {url, method, headers, postData, sessionId}
  let gezaehlt = 0;

  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && offen[m.id]) { offen[m.id](m); delete offen[m.id]; return; }

    if (m.method === 'Target.attachedToTarget') {
      const s = m.params.sessionId;
      await cdp.send('Network.enable', { maxPostDataSize: 200000 }, s);
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, s);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (!relevant(r.url)) return;
      anfragen.set(m.params.requestId, {
        url: r.url, method: r.method, headers: r.headers,
        postData: r.postData ? String(r.postData).slice(0, 20000) : null,
        sessionId: m.sessionId, typ: m.params.type,
      });
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const a = anfragen.get(m.params.requestId);
      if (!a) return;
      a.status = m.params.response.status;
      a.responseHeaders = m.params.response.headers;
      a.mimeType = m.params.response.mimeType;
      return;
    }
    if (m.method === 'Network.loadingFinished') {
      const a = anfragen.get(m.params.requestId);
      if (!a) return;
      anfragen.delete(m.params.requestId);
      let body = null;
      const magJson = /json|text|csv|javascript/i.test(a.mimeType || '');
      if (magJson && a.typ !== 'Script' && a.typ !== 'Stylesheet') {
        try {
          const r = await cdp.send('Network.getResponseBody', { requestId: m.params.requestId }, a.sessionId);
          if (r.result && r.result.body) body = String(r.result.body).slice(0, 200000);
        } catch (e) {}
      }
      notiere({ ...a, body, zeit: new Date().toISOString() });
      gezaehlt++;
      if (gezaehlt % 10 === 0) console.log(`  ${gezaehlt} Aufrufe mitgeschnitten ...`);
    }
  };

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  console.log('Mitschnitt laeuft. Datei:', OUT);
  console.log('Fenster ist offen - bitte einloggen und die Berichte aufrufen.');
}

chrome.on('exit', () => { console.log('Browser geschlossen, Mitschnitt beendet.'); schreiber.end(); process.exit(0); });
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
