// 2040 per-player X life pad: ✕ toggle swaps the −5/−1/+1/+5 row for a big X with four 90° wedge buttons
// (top=+5 · bottom=−5 · left=−1 · right=+1). Real positional clicks land on the wedge even when they're
// over the big number (the number is click-through). Toggling back restores the buttons.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:430, height:780 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const myHalf = '.lc-half:not(.lc-flip)';
const setup = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  document.querySelectorAll('[class*="dicey"]').forEach(e=>e.remove()); // Dicey floats over the board — out of the way for positional clicks
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const mh='.lc-half:not(.lc-flip)'; const out={};
  mgLaunchApp('twentyfourty'); await wait(220);
  out.toggles = document.querySelectorAll('[data-xtog]').length;
  document.querySelector('[data-xtog="1"]').click(); await wait(60);
  out.padShown = !!document.querySelector(mh+' .lc-xpad');
  out.arms = document.querySelectorAll(mh+' .lc-xarm').length;
  out.otherUntouched = !!document.querySelector('.lc-half.lc-flip .lc-ovbtns') && !document.querySelector('.lc-half.lc-flip .lc-xpad');
  const r=document.querySelector(mh+' .lc-xpad').getBoundingClientRect();
  out.pad={x:r.x,y:r.y,w:r.width,h:r.height};
  out.before=[...document.querySelectorAll('.lc-life')].pop().textContent;
  return out; });
const cx=setup.pad.x+setup.pad.w/2, cy=setup.pad.y+setup.pad.h/2;
// click just ABOVE center → over the big number, inside the TOP wedge → +5
await p.mouse.click(cx, cy - setup.pad.h*0.12); await p.waitForTimeout(80);
const afterPlus = await p.evaluate(()=>[...document.querySelectorAll('.lc-life')].pop().textContent);
// click just LEFT of center → over the number, inside the LEFT wedge → −1
await p.mouse.click(cx - setup.pad.w*0.12, cy); await p.waitForTimeout(80);
const afterMinus = await p.evaluate(()=>[...document.querySelectorAll('.lc-life')].pop().textContent);
const restored = await p.evaluate(async()=>{ const mh='.lc-half:not(.lc-flip)'; document.querySelector('[data-xtog="1"]').click(); await new Promise(r=>setTimeout(r,60)); return !!document.querySelector(mh+' .lc-ovbtns') && !document.querySelector(mh+' .lc-xpad'); });
const r={ ...setup, afterPlus, afterMinus, restored };
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.toggles===2 && r.padShown && r.arms===4 && r.otherUntouched
  && r.before==='20' && r.afterPlus==='25' && r.afterMinus==='24' && r.restored
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
