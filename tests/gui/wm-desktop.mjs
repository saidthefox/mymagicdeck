import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
// Fresh layout so the centered default applies, then enter Deck OS.
await p.evaluate(() => { try { DeckOS.store.remove('wm:rect:site'); } catch (e) {} });
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1400);
const site = await p.evaluate(() => { const w = wmWins.site; const r = w && w.rect; const cx = r ? Math.round(r.x + r.w / 2) : null; return { rect: r, centerX: cx, viewMid: Math.round(innerWidth / 2) }; });
console.log('SITE rect:', JSON.stringify(site.rect), 'centerX≈', site.centerX, 'viewMid', site.viewMid);
await p.screenshot({ path: SHOTS + '/wm-centered.png' });
// Open a second window, then Show Desktop.
await p.evaluate(() => mgLaunchApp('twentyfourty')); await p.waitForTimeout(700);
const before = await p.evaluate(() => Object.fromEntries(Object.entries(wmWins).map(([k, w]) => [k, w.state])));
await p.click('.wm-showdesk', { timeout: 5000 }); await p.waitForTimeout(500);
const after = await p.evaluate(() => Object.fromEntries(Object.entries(wmWins).map(([k, w]) => [k, w.state])));
await p.click('.wm-showdesk', { timeout: 5000 }); await p.waitForTimeout(500);
const restored = await p.evaluate(() => Object.fromEntries(Object.entries(wmWins).map(([k, w]) => [k, w.state])));
console.log('states before:', JSON.stringify(before), '\n after show-desktop:', JSON.stringify(after), '\n after toggle back:', JSON.stringify(restored));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
