import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1100, height: 760 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e).toString().slice(0, 160)));
p.on('dialog', d => d.accept());                       // auto-accept the "replace layout?" confirm
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
const r = await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const isl = await (await fetch('/api/cards/named?name=Island')).json();
  state.user = state.user || { username: 't' };
  newDeck(); addCard(lb, 3); addCard(isl, 3);
  const d = currentDeck(); d.defaultLayout = 'user';
  openSplash(d, 't', { edit: true });
  await new Promise(s => setTimeout(s, 300));
  d.layout = { positions: { MARKER: { x: 999, y: 888, z: 1 } } };   // baseline to detect replace/undo
  // toolbar wrap check
  const sw = document.querySelector('.splash-sort-wrap');
  const wrap = sw ? getComputedStyle(sw).flexWrap : null;
  deckPicLayout();                                                   // confirm auto-accepted
  await new Promise(s => setTimeout(s, 200));
  const afterApply = { hasMarker: !!(d.layout.positions && d.layout.positions.MARKER), keys: Object.keys(d.layout.positions).length, undoDisabled: document.getElementById('splash-undo').disabled };
  splashUndoLayout();
  await new Promise(s => setTimeout(s, 150));
  const afterUndo = { hasMarker: !!(d.layout && d.layout.positions && d.layout.positions.MARKER), undoDisabled: document.getElementById('splash-undo').disabled };
  return { flexWrap: wrap, afterApply, afterUndo };
});
console.log(JSON.stringify(r, null, 1));
await p.screenshot({ path: SHOTS + '/splash-undo.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
