import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  newDeck(); addCard(lb, 1); addSBCard(lb, 1);          // same card in BOTH zones
  const d = currentDeck(); d.defaultLayout = 'user';
  state.user = state.user || { username: 'tester' };
  openSplash(d, 'tester', { edit: true });
  await new Promise(s => setTimeout(s, 400));
  const keys = [...document.querySelectorAll('#splash-free .splash-card')].map(c => c.dataset.key);
  const pos = [...document.querySelectorAll('#splash-free .splash-card')].map(c => c.style.left + ',' + c.style.top);
  return { keys, uniqueKeys: new Set(keys).size, positions: pos, uniquePositions: new Set(pos).size };
});
console.log('keys:', JSON.stringify(r.keys));
console.log('unique keys:', r.uniqueKeys, 'of', r.keys.length);
console.log('positions:', JSON.stringify(r.positions), 'unique:', r.uniquePositions);
await p.screenshot({ path: SHOTS + '/splash-dupe-key.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
