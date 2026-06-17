// Verify the Mainboard section header in the builder deck panel.
import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
// Seed real cards into a fresh deck via the app's own addCard().
await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const le = await (await fetch('/api/cards/named?name=Llanowar Elves')).json();
  if (typeof newDeck === 'function') newDeck();
  addCard(lb, 3); addCard(le, 2);
});
await p.waitForTimeout(600);
const hdr = await p.locator('#mainboard-toggle').isVisible();
const badge = await p.locator('#mainboard-count-badge').textContent();
await p.screenshot({ path: SHOTS + '/mb-01-expanded.png' });
await p.click('#mainboard-toggle'); await p.waitForTimeout(400);
const hidden = await p.locator('#deck-sections').evaluate(el => el.classList.contains('hidden'));
await p.screenshot({ path: SHOTS + '/mb-02-collapsed.png' });
console.log('MAINBOARD header visible:', hdr);
console.log('MAINBOARD count badge:', badge);
console.log('collapse hides #deck-sections:', hidden);
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
