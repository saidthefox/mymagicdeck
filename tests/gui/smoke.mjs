// Headless GUI smoke test — drives the locally-served page (mymagicdeck.com → 127.0.0.1)
// through Chromium, capturing console/page errors and screenshots for review.
import { chromium } from 'playwright';
const URL = 'http://mymagicdeck.com/';
const SHOTS = '/work/tests/gui/shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('pageerror: ' + (e.message || e).toString().slice(0, 200)));

const step = async (name, fn) => { try { await fn(); console.log('OK   ' + name); } catch (e) { console.log('FAIL ' + name + ' — ' + e.message.slice(0, 160)); } };
const shot = n => page.screenshot({ path: SHOTS + '/' + n + '.png' }).catch(() => {});

await step('load page', async () => { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(2500); });
console.log('TITLE: ' + await page.title());
await shot('01-classic');

await step('toggle Deck OS', async () => { await page.click('#deckos-toggle', { timeout: 8000 }); await page.waitForTimeout(2000); });
await shot('02-deckos-desktop');
// Minimize the MyMagicDeck window to reveal the desktop icons.
await step('minimize MyMagicDeck', async () => { await page.click('#site-min', { timeout: 8000 }); await page.waitForTimeout(900); });
await shot('02b-desktop-revealed');
const iconCount = await page.locator('.mg-deskicons .mg-icon').count();
console.log('DESKTOP ICONS visible: ' + iconCount);

// Open a registered program, close it, reopen it (the reopen bug class).
await step('open Calendar', async () => { await page.click('.mg-icon[data-app="calendar"]', { timeout: 8000 }); await page.waitForTimeout(900); });
await shot('03-calendar-open');
await step('close Calendar', async () => { await page.click('.mgw-win:has(.cal-grid) [data-w="close"]', { timeout: 5000 }); await page.waitForTimeout(600); });
await step('REOPEN Calendar', async () => { await page.click('.mg-icon[data-app="calendar"]', { timeout: 8000 }); await page.waitForTimeout(900);
  if (!(await page.isVisible('.mgw-win:has(.cal-grid) .cal-grid'))) throw new Error('calendar did not reopen'); });
await shot('04-calendar-reopened');
await step('close Calendar again', async () => { await page.click('.mgw-win:has(.cal-grid) [data-w="close"]', { timeout: 5000 }); await page.waitForTimeout(400); });

await step('open The Land Game + Start', async () => { await page.click('.mg-icon[data-app="landgame"]', { timeout: 8000 }); await page.waitForTimeout(500); await page.click('#lg-start', { timeout: 5000 }); await page.waitForTimeout(700); });
await shot('05-landgame');
await step('Land Game: play a land', async () => { await page.click('.mgw-win:has(.lg-wrap) .lg-card', { timeout: 5000 }); await page.waitForTimeout(600); });
await shot('05b-landgame-played');
await step('close Land Game', async () => { await page.click('.mgw-win:has(.lg-wrap) [data-w="close"]', { timeout: 5000 }); await page.waitForTimeout(400); });

await step('open MyMagicBot', async () => { await page.click('.mg-icon[data-app="mymagicbot"]', { timeout: 8000 }); await page.waitForTimeout(700); });
await shot('06-mymagicbot');
await step('close MyMagicBot', async () => { await page.click('.mgw-win:has(.t-wrap) [data-w="close"]', { timeout: 5000 }).catch(()=>{}); await page.waitForTimeout(300); });

await step('open TWENTYFOURTY + tap +', async () => { await page.click('.mg-icon[data-app="twentyfourty"]', { timeout: 8000 }); await page.waitForTimeout(500); await page.click('.mgw-win:has(.lc-wrap) .lc-step[data-d="1"]', { timeout: 5000 }); await page.waitForTimeout(400); });
await shot('07-twentyfourty');

await page.waitForTimeout(500);
console.log('CONSOLE_ERRORS: ' + errors.length);
errors.slice(0, 25).forEach(e => console.log('  - ' + e));
await browser.close();
