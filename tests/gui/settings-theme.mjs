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
// System Settings: has theme toggle + bg swatches?
await p.evaluate(() => { try { localStorage.removeItem('mmd_theme'); } catch (e) {} mgLaunchApp('sysset'); });
await p.waitForTimeout(500);
const ss = await p.evaluate(() => {
  const root = '#modal-sysset';
  return { themeToggle: !!document.querySelector(root + ' [data-theme]'), bgSwatches: document.querySelectorAll(root + ' [data-bg]').length };
});
console.log('System Settings →', JSON.stringify(ss));
// Toggle light mode from settings
const beforeBg = await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg').trim());
await p.click('#modal-sysset [data-theme]');
await p.waitForTimeout(200);
const afterToggle = await p.evaluate(() => ({ lightClass: document.body.classList.contains('theme-light'), bg: getComputedStyle(document.body).getPropertyValue('--bg').trim() }));
console.log('beforeBg', beforeBg, '→ after light toggle:', JSON.stringify(afterToggle));
// HUD parity (stub a user so HUD renders)
await p.evaluate(() => { state.user = state.user || { username: 'tester' }; mgLaunchApp('hud'); });
await p.waitForTimeout(400);
const hud = await p.evaluate(() => {
  const root = '#modal-hud, #modal-prog-hud';
  const sel = document.querySelector('#modal-hud [data-theme]') || document.querySelector('#modal-prog-hud [data-theme]');
  const bg = document.querySelectorAll('#modal-hud [data-bg], #modal-prog-hud [data-bg]').length;
  return { hudThemeToggle: !!sel, hudThemeChecked: sel ? sel.checked : null, hudBgSwatches: bg };
});
console.log('HUD →', JSON.stringify(hud));
await p.screenshot({ path: SHOTS + '/settings-theme.png' });
// turn light back off
await p.evaluate(() => themeSet('dark'));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
