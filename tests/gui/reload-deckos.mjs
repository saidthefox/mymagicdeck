import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 200)); });
p.on('pageerror', e => errs.push('PAGEERROR:' + (e.message || e).toString().slice(0, 200)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(1500);
// Turn on Deck OS (persists deckos_desktop=1), then RELOAD — the failure scenario.
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1200);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);
const r = await p.evaluate(() => {
  const site = document.getElementById('site-window');
  const tb = document.getElementById('wm-taskbar');
  return {
    wmOn: document.body.classList.contains('wm-on'),
    siteFramed: !!(site && site.classList.contains('wm-win')),
    siteParent: site?.parentElement?.id,
    siteH: site ? site.offsetHeight : null,
    siteW: site ? site.offsetWidth : null,
    taskbar: !!tb,
    taskbarHasMMD: tb ? /MyMagicDeck/.test(tb.textContent) : false,
  };
});
console.log('AFTER RELOAD:', JSON.stringify(r));
// Prove the script didn't abort: a program still opens (above MMD) and Sign In works.
await p.evaluate(() => { try { mgLaunchApp('twentyfourty'); } catch (e) {} });
await p.waitForTimeout(500);
const prog = await p.evaluate(() => { const m = document.querySelector('#modal-prog-twentyfourty'); return { hasLcWin: !!document.querySelector('.lc-fs'), taskTwenty: /TWENTY/i.test(document.getElementById('wm-taskbar')?.textContent || '') }; });
console.log('program opens:', JSON.stringify(prog));
await p.screenshot({ path: SHOTS + '/reload-deckos.png' });
console.log('PAGE/CONSOLE ERRORS:', errs.length, errs.slice(0, 8));
await b.close();
