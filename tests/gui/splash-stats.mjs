import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const isl = await (await fetch('/api/cards/named?name=Island')).json();
  const tw = await (await fetch('/api/cards/named?name=Time Stretch')).json();
  state.user = state.user || { username: 'tester' };
  newDeck(); addCard(lb, 4); addCard(isl, 6); addCard(tw, 2);
  const d = currentDeck(); d.defaultLayout = 'user';
  openSplash(d, 'tester', { edit: true });
  await new Promise(s => setTimeout(s, 300));
  // turn on every stat widget
  ['name', 'curve', 'types', 'price', 'list'].forEach(id => statsSet(id, true));
  await new Promise(s => setTimeout(s, 200));
  const widgets = [...document.querySelectorAll('#splash-free .splash-stat')].map(w => w.dataset.key);
  // move the deck-list widget and persist
  const listEl = document.querySelector('.splash-stat.stat-list');
  if (listEl) { listEl.style.left = '600px'; listEl.style.top = '40px'; listEl.style.zIndex = '999'; }
  saveUserLayout();
  const savedListPos = d.layout.positions['stat:list'];
  const curveContent = document.querySelector('.stat-curve .ss-curve') ? document.querySelectorAll('.stat-curve .ss-bar').length : 0;
  return { widgets, savedListPos, curveBars: curveContent, hasPrice: !!document.querySelector('.stat-price .ss-price') };
});
console.log(JSON.stringify(r));
await p.screenshot({ path: SHOTS + '/splash-stats.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
