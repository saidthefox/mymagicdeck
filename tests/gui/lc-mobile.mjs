import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
await p.evaluate(() => {
  const cg = document.getElementById('mguess-overlay'); if (cg) { cg.classList.remove('open'); cg.style.display = 'none'; } // CGG floats by default on mobile; hide for the shot
  try { mgLaunchApp('twentyfourty'); } catch (e) { MGW_APPS['twentyfourty'].open(); }
});
await p.waitForTimeout(700);
const m = await p.evaluate(() => {
  const modal = document.querySelector('#modal-prog-twentyfourty .modal');
  const halves = document.querySelectorAll('#modal-prog-twentyfourty .lc-half');
  const top = halves[0], life = top && top.querySelector('.lc-life');
  const rail = document.querySelector('#modal-prog-twentyfourty .lc-rail');
  const railBtns = rail ? [...rail.querySelectorAll('button')].map(x => x.textContent.trim()) : [];
  return {
    modalW: modal ? Math.round(modal.getBoundingClientRect().width) : null,
    modalH: modal ? Math.round(modal.getBoundingClientRect().height) : null,
    halves: halves.length,
    topFlipped: top ? getComputedStyle(top).transform : null,
    lifeFontPx: life ? Math.round(parseFloat(getComputedStyle(life).fontSize)) : null,
    railOrder: railBtns,
    ovBtns: top ? top.querySelectorAll('.lc-ovbtns button').length : 0,
  };
});
console.log(JSON.stringify(m, null, 0));
// Tap a + on the bottom (me) half and confirm it changes (dispatch to avoid touch-actionability flake).
const meLife = await p.evaluate(() => {
  const before = document.querySelector('#modal-prog-twentyfourty .lc-half:last-child .lc-life').textContent;
  document.querySelector('#modal-prog-twentyfourty .lc-half:last-child .lc-ovbtns button:nth-child(3)').click();
  const after = document.querySelector('#modal-prog-twentyfourty .lc-half:last-child .lc-life').textContent;
  return before + '→' + after;
});
console.log('me life on + tap:', meLife);
await p.screenshot({ path: SHOTS + '/lc-mobile.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
