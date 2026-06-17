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
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1200);
// Seed a deck + open the Splash Builder in edit mode, then trigger Share Image.
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  state.user = state.user || { username: 'tester' };
  newDeck(); addCard(lb, 4);                  // seed currentDeck()
  mgLaunchApp('splash');                       // open Splash Builder as a WM window (frame:true)
  await new Promise(s => setTimeout(s, 500));
  openShareImage();                            // → routes to WM in Deck OS
  await new Promise(s => setTimeout(s, 500));
  const m = document.getElementById('modal-share-image')?.querySelector('.modal') || document.querySelector('.modal.wm-win');
  const si = document.getElementById('share-image-title') ? document.getElementById('share-image-title').closest('.modal') : null;
  const el = si || m;
  return { framed: !!(el && el.classList.contains('wm-win')), parent: el?.parentElement?.id, z: el ? (parseInt(getComputedStyle(el).zIndex) || 0) : null,
    taskbarHasShareImage: /Share Image/.test(document.getElementById('wm-taskbar')?.textContent || '') };
});
console.log('SHARE IMAGE in Deck OS →', JSON.stringify(r));
await p.screenshot({ path: SHOTS + '/shareimg-wm.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 6));
await b.close();
