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
const seed = async () => p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const le = await (await fetch('/api/cards/named?name=Llanowar Elves')).json();
  newDeck(); const d = DeckOS.decks.active();
  d.cards = { [getCardId(lb)]: { card: sanitizeCard(lb), qty: 4 }, [getCardId(le)]: { card: sanitizeCard(le), qty: 8 } };
  state.user = state.user || { username: 'tester' };
});
await seed();
// --- DECK OS: launch Splash Builder ---
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1200);
await p.evaluate(() => mgLaunchApp('splash')); await p.waitForTimeout(900);
const dos = await p.evaluate(() => {
  const ov = document.getElementById('splash-overlay');
  return { inWmLayer: ov.parentElement && ov.parentElement.id === 'wm-layer', mgwWin: ov.classList.contains('mgw-win'),
    editing: ov.classList.contains('editing'), hasBar: !!ov.querySelector(':scope > .mgw-bar'),
    editableCards: document.querySelectorAll('#splash-body .splash-card').length };
});
console.log('DECK OS splash →', JSON.stringify(dos));
await p.screenshot({ path: SHOTS + '/splash-fix-deckos.png' });
// --- back to CLASSIC, then Share→Edit (the trap scenario) ---
await p.evaluate(() => { if (typeof wmClose === 'function') wmClose('splash'); });
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1000);
const classic = await p.evaluate(() => {
  editSplashFromShare();
  const ov = document.getElementById('splash-overlay');
  return { parentBody: ov.parentElement === document.body, open: ov.classList.contains('open'),
    display: getComputedStyle(ov).display, editing: ov.classList.contains('editing') };
});
console.log('CLASSIC after Deck OS →', JSON.stringify(classic));
await p.screenshot({ path: SHOTS + '/splash-fix-classic.png' });
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 6));
await b.close();
