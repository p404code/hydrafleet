// Extrahiert weekRange aus dashboard-neu.html und prüft bekannte Wochen.
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || 'dashboard.html', 'utf8');
const match = html.match(/function weekRange\(woche\)[\s\S]*?\n        }\n/);
if (!match) { console.error('FAIL: weekRange nicht gefunden'); process.exit(1); }
const weekRange = new Function(match[0] + '; return weekRange;')();
const cases = [['2026-W37', '7. – 13. Sept 2026'], ['2026-W01', '29. Dez – 4. Jän 2026'], ['2026-W16', '13. – 19. Apr 2026'], ['2026-W37k', ''], ['', '']];
let fail = 0;
for (const [input, want] of cases) { const got = weekRange(input); if (got !== want) { console.error('FAIL', input, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); fail++; } }
if (fail) process.exit(1); console.log('weekRange OK');
