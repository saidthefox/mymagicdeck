// "/" opens a Run command palette to launch any program; Enter launches the match; it's suppressed while
// typing in a field; ?run=<id> deep-links straight to a program.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:760 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
await p.evaluate(()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';} });
// press "/" on the page (focus is body)
await p.keyboard.press('/');
await p.waitForTimeout(150);
const opened = await p.evaluate(()=>!!document.getElementById('cmd-palette'));
await p.keyboard.type('mana');
await p.waitForTimeout(150);
const filtered = await p.evaluate(()=>{ const items=[...document.querySelectorAll('.cmdp-item .cmdp-id')].map(e=>e.textContent); return { count:items.length, hasManapool:items.includes('manapool') }; });
await p.keyboard.press('Enter');
await p.waitForTimeout(300);
const launched = await p.evaluate(()=>{ const closed=!document.getElementById('cmd-palette'); const open=(typeof mgwState!=='undefined'&&mgwState.manapool&&mgwState.manapool.s!=='closed')||!!document.querySelector('#modal-prog-manapool.open, #modal-prog-manapool .modal'); return { closed, open }; });
// typing guard: focus the deckbuilder search and press "/" → no palette, "/" goes into the input
await p.evaluate(()=>{ const si=document.getElementById('search-input'); if(si){si.value='';si.focus();} });
await p.keyboard.press('/');
await p.waitForTimeout(120);
const guard = await p.evaluate(()=>({ noPalette:!document.getElementById('cmd-palette'), typed:(document.getElementById('search-input')||{}).value }));
console.log('OPENED',opened,'FILTERED',JSON.stringify(filtered),'LAUNCHED',JSON.stringify(launched),'GUARD',JSON.stringify(guard));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = opened && filtered.hasManapool && launched.closed && launched.open && guard.noPalette && guard.typed==='/' && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
