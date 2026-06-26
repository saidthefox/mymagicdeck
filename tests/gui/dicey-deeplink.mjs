// ?dicey=<id> deep-link: on load Dicey appears, opens Deck OS, then opens the program.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:740 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/?dicey=manapool',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(4800); // greet(0.4) → deckos(1.7) → open(2.9) + render
const r = await p.evaluate(()=>({
  dicey: !!(typeof _diceyEl!=='undefined' && _diceyEl),
  deckos: document.body.classList.contains('deckos'),
  opened: !!document.getElementById('modal-prog-manapool'),
  openState: (typeof mgwState!=='undefined' && mgwState.manapool) ? mgwState.manapool.s : null,
}));
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.dicey && r.deckos && r.opened && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
