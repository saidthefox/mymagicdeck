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
await p.evaluate(() => { try { localStorage.removeItem('deckos:manapool'); } catch (e) {} mgLaunchApp('manapool'); });
await p.waitForTimeout(600);
const root = '#modal-prog-manapool';
const tap = async (sel, n) => { for (let i = 0; i < n; i++) { await p.click(root + ' ' + sel); await p.waitForTimeout(120); } };
await tap('[data-add="U"]', 5);
await tap('[data-add="R"]', 3);
await tap('[data-add="G"]', 2);
await tap('[data-add="W"]', 1);
await p.waitForTimeout(400);
await tap('[data-slurp="U"]', 2);   // slurp 2 blue back
await p.waitForTimeout(1200);       // let orbs settle/animate
const counts = await p.evaluate((root) => {
  const get = k => document.querySelector(root + ' [data-count="' + k + '"]')?.textContent;
  return { U: get('U'), R: get('R'), G: get('G'), W: get('W'), B: get('B'), gargs: document.querySelectorAll(root + ' .mp-garg').length, canvas: !!document.querySelector(root + ' canvas') };
}, root);
console.log('counts:', JSON.stringify(counts));
await p.screenshot({ path: SHOTS + '/manapool.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
