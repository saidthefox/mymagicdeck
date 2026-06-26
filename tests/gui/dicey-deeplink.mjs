// ?dicey=<id> escort: friendly name (basics→landgame), Dicey moves, opens Deck OS, opens the program,
// and the startup intro stays HIDDEN during the escort — appearing only after he settles.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:740 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/?dicey=basics',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(3500); // mid-escort (folder route)
const mid = await p.evaluate(()=>{ const e=(typeof _diceyEl!=='undefined')&&_diceyEl; const rc=e&&e.getBoundingClientRect();
  return { pos:rc?{x:rc.left,y:rc.top}:null, introUp:!!document.querySelector('.dicey-bubble') }; });
await p.waitForTimeout(8500); // past render-delayed folder route + settle + 1s + intro
const end = await p.evaluate(()=>{ const e=(typeof _diceyEl!=='undefined')&&_diceyEl; const rc=e&&e.getBoundingClientRect();
  return { dicey:!!e, deckos:document.body.classList.contains('deckos'), openedLandgame:!!document.querySelector('.lg-start, .lg-wrap'),
    pos:rc?{x:rc.left,y:rc.top}:null, introUp:!!document.querySelector('.dicey-bubble, .dicey-say') }; });
console.log(JSON.stringify({mid, end}));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const moved = mid.pos && end.pos && (Math.abs(mid.pos.x-end.pos.x)>5 || Math.abs(mid.pos.y-end.pos.y)>5);
const okDesktop = end.dicey && end.deckos && end.openedLandgame && moved && !mid.introUp && end.introUp && !errs.length;
console.log('moved:',moved,'introHiddenMid:',!mid.introUp,'introShownEnd:',end.introUp,'RESULT:', okDesktop?'PASS':'FAIL');

// Mobile: MyMagicDeck is full-screen, so Dicey first PRESSES its minimize button (mouse-hand cursor) to
// reveal the desktop, then opens Basics. Assert the minimize happened, a cursor flourish fired, Basics opened.
const mp = await (await b.newContext({ viewport:{ width:420, height:820 }, hasTouch:true })).newPage();
const merrs=[]; mp.on('pageerror',e=>merrs.push(String(e.message||e)));
let curCount=0; await mp.exposeFunction('noteCur',()=>{curCount++;}); let wasMin=false; await mp.exposeFunction('noteMin',()=>{wasMin=true;});
await mp.addInitScript(()=>{ const iv=setInterval(()=>{ if(typeof window.diceyCursorAt==='function'){ const o=window.diceyCursorAt; window.diceyCursorAt=function(){ try{window.noteCur();}catch(e){} return o.apply(this,arguments); }; clearInterval(iv); } },50); });
await mp.goto('http://mymagicdeck.com/?dicey=basics',{waitUntil:'domcontentloaded',timeout:30000});
await mp.evaluate(()=>{ new MutationObserver(()=>{ if(document.body.classList.contains('pc-deskmode'))window.noteMin(); }).observe(document.body,{attributes:true,attributeFilter:['class']}); });
await mp.waitForTimeout(10500);
const mEnd = await mp.evaluate(()=>({ basics:!!document.querySelector('.lg-start, .lg-wrap') }));
const okMobile = wasMin && curCount>=1 && mEnd.basics && !merrs.length;
console.log('mobile → minimizedMMD:',wasMin,'cursorPresses:',curCount,'basicsOpen:',mEnd.basics,'errs:',merrs.length,'RESULT:', okMobile?'PASS':'FAIL');

await b.close();
if(!(okDesktop && okMobile)) process.exit(1);
