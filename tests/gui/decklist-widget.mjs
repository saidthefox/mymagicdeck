// Verify the Deck List desktop widget shows Mainboard + Sideboard sections.
import { chromium } from 'playwright';
const SHOTS = '/work/tests/gui/shots';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 850 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
p.on('pageerror', e => errs.push('PE:' + (e.message || e)));
await p.goto('http://mymagicdeck.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2000);
await p.click('#deckos-toggle', { timeout: 8000 }); await p.waitForTimeout(1200);
await p.click('#site-min', { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(600);
// Seed a deck with mainboard + sideboard, stub a user, open the HUD widget manager.
await p.evaluate(async () => {
  const lb = await (await fetch('/api/cards/named?name=Lightning Bolt')).json();
  const le = await (await fetch('/api/cards/named?name=Llanowar Elves')).json();
  const pb = await (await fetch('/api/cards/named?name=Pyroblast')).json();
  newDeck();
  const d = DeckOS.decks.active(); // seed exactly what the widget reads
  d.cards = { [getCardId(lb)]: { card: sanitizeCard(lb), qty: 4 }, [getCardId(le)]: { card: sanitizeCard(le), qty: 2 } };
  d.sideboard = { [getCardId(pb)]: { card: sanitizeCard(pb), qty: 3 } };
  state.user = state.user || { username: 'tester' };
  widgetMount('decklist'); // widget mounting moved out of Display into the Widgets app
});
await p.waitForTimeout(500);
const text = await p.evaluate(() => { const b = document.querySelector('.os-widget .ow-body'); return b ? b.innerText : '(no widget body)'; });
await p.screenshot({ path: SHOTS + '/decklist-widget.png' });
console.log('--- widget text ---\n' + text);
console.log('Mainboard:', /Mainboard/.test(text), '| Sideboard:', /Sideboard/.test(text), '| Pyroblast:', /Pyroblast/.test(text));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0, 5));
await b.close();
