import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
await p.evaluate(() => { try { localStorage.removeItem('mmd_fw_layout_v4'); } catch (e) {} document.getElementById('card-filter-panel')?.classList.remove('collapsed'); if (typeof fwResetLayout === 'function') fwResetLayout(); });
await p.waitForTimeout(600);
const m = await p.evaluate(() => {
  const r = id => { const e = document.getElementById(id); const b = e?.querySelector('.fw-body'); return e ? { w: Math.round(e.offsetWidth), h: Math.round(e.offsetHeight), scrollable: b ? b.scrollHeight > b.clientHeight + 1 : null } : null; };
  return { pt: r('fw-pt'), cmc: r('fw-cmc'), rarity: r('fw-rarity'), format: r('fw-format'), keywords: r('fw-keywords') };
});
console.log(JSON.stringify(m, null, 0));
await p.screenshot({ path: SHOTS + '/fw-layout.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
