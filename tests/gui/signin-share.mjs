import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1400);
const check = async (mode) => p.evaluate((mode) => {
  // simulate the share-modal link
  if (typeof closeModal === 'function') closeModal('modal-share');
  signInClick(mode);
  const m = document.getElementById('auth-modal-title')?.closest('.modal');
  return { framed: !!(m && m.classList.contains('wm-win') && m.parentElement?.id === 'wm-layer'),
    title: document.getElementById('auth-modal-title')?.textContent, z: m ? (parseInt(getComputedStyle(m).zIndex) || 0) : null,
    siteZ: (parseInt(getComputedStyle(document.getElementById('site-window')).zIndex) || 0) };
}, mode);
console.log('share "Sign in"     →', JSON.stringify(await check('login')));
await p.waitForTimeout(300);
console.log('share "Create acct" →', JSON.stringify(await check('signup')));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
