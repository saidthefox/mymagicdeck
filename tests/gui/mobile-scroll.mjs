// Mobile deckos: the deck panel scrolls internally (not the page); pinned taskbar reserves its height;
// "start minimized" setting persists.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:420, height:820 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  if(!document.body.classList.contains('deckos')&&typeof deckosToggle==='function')deckosToggle(); await wait(150);
  try{ DeckOS.store.set('taskbarPinned',true); }catch(e){} if(typeof taskbarApply==='function')taskbarApply(); await wait(120);
  document.body.classList.remove('pc-deskmode','site-windowed');
  if(typeof mobileNav==='function')mobileNav('deck'); await wait(120);
  const out={};
  out.wmOff = !document.body.classList.contains('wm-on');
  out.mtaskOn = document.body.classList.contains('mtask-on');
  out.reserve = getComputedStyle(document.body).paddingBottom;            // expect ~40px (= --mtask-h)
  out.appDisplay = getComputedStyle(document.getElementById('app')).display; // 'flex'
  const pb=document.querySelector('#panel-deck .panel-body');
  out.overflowY = pb?getComputedStyle(pb).overflowY:'(none)';
  if(pb){ const big=document.createElement('div'); big.style.height='3000px'; pb.appendChild(big);
    out.scrollable = pb.scrollHeight > pb.clientHeight + 100;
    pb.scrollTop=400; out.scrolled = pb.scrollTop>0;
    out.pageStill = (window.scrollY||0)===0; }
  osStartMinSet(true); out.startMinPersist = osStartMinGet()===true; osStartMinSet(false);
  return out;
});
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.wmOff && r.mtaskOn && /\dpx/.test(r.reserve) && parseFloat(r.reserve)>=30 && r.appDisplay==='flex'
  && r.overflowY==='auto' && r.scrollable && r.scrolled && r.pageStill && r.startMinPersist && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
