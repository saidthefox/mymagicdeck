// 2040 per-player X life pad: ✕ toggle swaps the −5/−1/+1/+5 row for a big X with 4 tappable arms; an arm
// adjusts that player's life; toggling back restores the buttons. Independent per half.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:430, height:780 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const out={};
  mgLaunchApp('twentyfourty'); await wait(220);
  out.toggles = document.querySelectorAll('[data-xtog]').length;           // both halves have a toggle
  const myHalf = '.lc-half:not(.lc-flip)';
  document.querySelector('[data-xtog="1"]').click(); await wait(60);       // open X on my (bottom) half
  out.padShown = !!document.querySelector(myHalf+' .lc-xpad');
  out.arms = document.querySelectorAll(myHalf+' .lc-xarm').length;
  out.otherUntouched = !!document.querySelector('.lc-half.lc-flip .lc-ovbtns') && !document.querySelector('.lc-half.lc-flip .lc-xpad'); // opponent half still normal
  const life=()=>[...document.querySelectorAll('.lc-life')].pop().textContent;
  out.before = life();
  document.querySelector(myHalf+' .lc-xarm.ne').click(); await wait(60);    // +5
  out.afterPlus = life();
  document.querySelector(myHalf+' .lc-xarm.sw').click(); await wait(60);    // −1
  out.afterMinus = life();
  document.querySelector('[data-xtog="1"]').click(); await wait(60);        // toggle back
  out.restored = !!document.querySelector(myHalf+' .lc-ovbtns') && !document.querySelector(myHalf+' .lc-xpad');
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.toggles===2 && r.padShown && r.arms===4 && r.otherUntouched
  && r.before==='20' && r.afterPlus==='25' && r.afterMinus==='24' && r.restored
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
