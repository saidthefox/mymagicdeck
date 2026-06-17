import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 820 } });
const p = await ctx.newPage();
const errs = [];
let dialogs = 0;
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
p.on('dialog', d => { dialogs++; d.accept(); });
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const isl = await (await fetch('/api/cards/named?name=Island')).json();
  const pyro = await (await fetch('/api/cards/named?name=Pyroblast')).json();
  state.user = state.user || { username: 't' };
  newDeck(); addCard(lb, 6); addCard(isl, 6); addSBCard(pyro, 4);
  const d = currentDeck(); d.defaultLayout = 'user';
  openSplash(d, 't', { edit: true });
  await new Promise(s => setTimeout(s, 300));
  fanLayout();
  await new Promise(s => setTimeout(s, 200));
  const pos = d.layout.positions;
  const main = Object.entries(pos).filter(([k]) => !k.startsWith('sb_'));
  const sb = Object.entries(pos).filter(([k]) => k.startsWith('sb_')).sort((a, b) => a[1].x - b[1].x);
  const mainMaxBottom = Math.max(...main.map(([, p]) => p.y + 169));
  const sbYs = sb.map(([, p]) => p.y);
  const sbXs = sb.map(([, p]) => p.x);
  const xIncreasing = sbXs.every((x, i) => i === 0 || x > sbXs[i - 1]);
  return {
    mainCount: main.length, sbCount: sb.length,
    sbAllSameY: new Set(sbYs).size === 1,
    sbBelowMain: Math.min(...sbYs) >= mainMaxBottom,
    sbHorizontal: xIncreasing,
    sbXs,
  };
});
console.log(JSON.stringify(r));
console.log('dialogs (want 0):', dialogs);
await p.screenshot({ path: SHOTS + '/fan-sideboard.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
