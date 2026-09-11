// Headless-Screenshot-Tool (CDP, ohne npm-Abhaengigkeiten): node scripts/shot.js <url> <out.png> <breite> <hoehe> [jsToEval] [waitMs]
// Nutzt das Chromium aus dem Playwright-Cache (~/Library/Caches/ms-playwright). Lokal: python3 -m http.server 8080, dann http://localhost:8080/_dev-session.html (setzt Test-Session).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BIN = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const [url, out, w, hgt, evalJs, waitAfter] = process.argv.slice(2);
const port = 9222 + Math.floor(Math.random() * 500);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const chrome = spawn(BIN, ['--headless', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch (e) {} await sleep(100); }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +hgt, deviceScaleFactor: 1, mobile: +w < 800 });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  await sleep(6000);
  if (evalJs) { const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.error('EVAL ERROR', JSON.stringify(r.result.exceptionDetails.exception)); else if (r.result && r.result.result && r.result.result.value !== undefined) console.log('EVAL:', r.result.result.value); await sleep(+(waitAfter || 800)); }
  const errs = await send('Runtime.evaluate', { expression: 'JSON.stringify({w: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, title: document.title})', returnByValue: true });
  console.log('DOC:', errs.result.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', out);
  ws.close(); chrome.kill(); fs.rmSync(udd, { recursive: true, force: true });
}
main().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
