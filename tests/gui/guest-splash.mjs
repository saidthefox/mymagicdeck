import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
let toasts = [];
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  state.user = null;                               // GUEST (the friend's situation)
  newDeck(); addCard(lb, 4);
  const d = currentDeck();
  openSplash(d, 'You', { edit: true });            // how the Splash Builder program opens now
  await new Promise(s => setTimeout(s, 300));
  const editing = document.getElementById('splash-overlay').classList.contains('editing');
  const has = sel => !!document.querySelector(sel);
  return {
    editingClass: editing,
    saveBtn: has('#splash-save-layout'),
    statsMenu: has('#splash-stats-wrap'),
    deckPhotoAdd: has('.splash-deckphoto.empty'),
    shareImgBefore: document.getElementById('modal-share-image')?.classList.contains('open') || false,
  };
});
// guest clicks Share image → should NOT open the composer (prompts sign-in)
const shareImgOpened = await p.evaluate(() => { openShareImage(); return document.getElementById('modal-share-image')?.classList.contains('open') || false; });
console.log(JSON.stringify(r), 'shareImgOpensForGuest:', shareImgOpened);
await p.screenshot({ path: SHOTS + '/guest-splash.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
