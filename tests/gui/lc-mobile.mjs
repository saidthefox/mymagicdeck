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
  const top = halves[0], bot = halves[1], life = top && top.querySelector('.lc-life');
  return {
    modalW: modal ? Math.round(modal.getBoundingClientRect().width) : null,
    modalH: modal ? Math.round(modal.getBoundingClientRect().height) : null,
    halves: halves.length,
    topFlipped: top ? getComputedStyle(top).transform : null,
    lifeFontPx: life ? Math.round(parseFloat(getComputedStyle(life).fontSize)) : null,
    resetCtl: document.querySelector('#modal-prog-twentyfourty .lc-side [data-lcreset]')?.textContent.trim() || null,
    startCtls: [...document.querySelectorAll('#modal-prog-twentyfourty .lc-side [data-lcstart]')].map(x => x.textContent.trim()).join(','),
    topStepsAtEdge: top ? (top.querySelector('.lc-ovbtns').getBoundingClientRect().top < top.querySelector('.lc-life').getBoundingClientRect().top) : null,
    ovBtns: top ? top.querySelectorAll('.lc-ovbtns button').length : 0,
  };
});
console.log(JSON.stringify(m, null, 0));
// Tap a + on the bottom (me) half and confirm it changes (dispatch to avoid touch-actionability flake).
const meLife = await p.evaluate(() => {
  const life = () => document.querySelectorAll('#modal-prog-twentyfourty .lc-half')[1].querySelector('.lc-life').textContent; // re-query: lcRender rebuilds the body on each tap
  const before = life();
  document.querySelectorAll('#modal-prog-twentyfourty .lc-half')[1].querySelector('.lc-ovbtns button:nth-child(3)').click();
  return before + '→' + life();
});
console.log('me life on + tap:', meLife);
await p.screenshot({ path: SHOTS + '/lc-mobile.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
