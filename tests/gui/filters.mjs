// Verify the new filter widgets drive the search query string.
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
// Ensure the filter panel is visible (it's in the search center view, open by default).
await p.evaluate(() => { document.getElementById('card-filter-panel')?.classList.remove('collapsed'); });
await p.waitForTimeout(300);
const q = () => p.inputValue('#search-input');
// New chips
await p.click('.cfp-chip[data-type="battle"]'); await p.waitForTimeout(150);
await p.click('.cfp-chip[data-type="snow"]'); await p.waitForTimeout(150);
await p.click('.cfp-chip[data-rarity="special"]'); await p.waitForTimeout(150);
await p.click('.cfp-chip[data-format="oldschool"]'); await p.waitForTimeout(150);
console.log('after chips, query:', await q());
// Keyword typeahead (non-curated): type "Cascade" and fire change
await p.fill('#kw-typeahead', 'Cascade');
await p.dispatchEvent('#kw-typeahead', 'change');
await p.waitForTimeout(300);
console.log('after typeahead, query:', await q());
console.log('extra chip present:', await p.locator('#kw-extra-chips .cfp-chip[data-keyword="cascade"]').count());
const dlOpts = await p.locator('#kw-datalist option').count();
console.log('datalist options loaded:', dlOpts);
await p.screenshot({ path: SHOTS + '/filters-01.png' });
// Toggle the cascade extra chip off by clicking it
await p.click('#kw-extra-chips .cfp-chip[data-keyword="cascade"]'); await p.waitForTimeout(200);
console.log('after removing cascade, query:', await q());
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
