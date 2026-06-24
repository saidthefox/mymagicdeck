// Dicey is activity-aware: while you're interacting he goes calm (idle antics suppressed) and steps aside
// to a corner if he's out in the open; he only roams again after you've been idle.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1000, height:700 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const s=diceyState(); s.on=true; s.mode='all'; diceySave(s); diceyInit(); await wait(120);
  const out={ exists:!!_diceyEl }; if(!_diceyEl) return out;
  diceySay('Oh boy, a game!', 6000); out.spoke = !!_diceyEl.querySelector('.dicey-say');
  _diceyBusyUntil=0;                                              // pretend we've been idle
  document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));   // user does something
  out.active = diceyUserActive();                                 // → now flagged busy
  await wait(30);
  out.hushed = !_diceyEl.querySelector('.dicey-say');            // step-aside hushed his chatter
  const px=_diceyEl.style.left; diceyIdleTick(); await wait(20);
  out.chillWhileActive = (_diceyEl.style.left===px);             // idle antics suppressed while busy
  _diceyBusyUntil=0; out.wakesUp = !diceyUserActive();           // goes lively again once idle
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.exists && r.spoke && r.active && r.hushed && r.chillWhileActive && r.wakesUp && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
