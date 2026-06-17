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
await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const isl = await (await fetch('/api/cards/named?name=Island')).json();
  const pyro = await (await fetch('/api/cards/named?name=Pyroblast')).json();
  newDeck(); addCard(lb, 4); addCard(isl, 2);
  addSBCard(pyro, 3); addSBCard(lb, 1);   // include Lightning Bolt in SB too (was the collision case)
  switchCenterView('deck');
});
await p.waitForTimeout(600);
const r = await p.evaluate(() => {
  const cols = [...document.querySelectorAll('#mtgo-columns .mtgo-column')];
  const last = cols[cols.length - 1];
  const sb = document.querySelector('#mtgo-columns .mtgo-column[data-col="__sb__"]');
  return {
    colCount: cols.length,
    lastColKey: last?.getAttribute('data-col'),
    lastIsSideboard: last?.getAttribute('data-col') === '__sb__',
    sbHeader: sb?.querySelector('.mtgo-col-header')?.textContent.trim().replace(/\s+/g, ' '),
    sbCardCount: sb ? sb.querySelectorAll('.mtgo-card').length : 0,
  };
});
console.log(JSON.stringify(r));
await p.screenshot({ path: SHOTS + '/deck-sideboard.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
