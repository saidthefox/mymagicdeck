// Mobile taskbar focus: with two programs open, tapping an open-but-behind tray icon brings it to FRONT
// (it doesn't minimize), only the frontmost icon is "active", and tapping the frontmost minimizes it.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:430, height:780 }, hasTouch:true })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const out={};
  document.body.classList.remove('wm-on','deckos'); document.body.classList.add('mtask-on'); // mobile pinned-taskbar mode
  mgwLaunch('manapool'); await wait(60); mgwLaunch('twentyfourty'); await wait(60); mtaskRender(); await wait(40);
  const tap=k=>{ const btn=document.querySelector('#mg-mtask .mg-barwin[data-mgw="'+k+'"]'); if(btn)btn.click(); };
  const active=()=>[...document.querySelectorAll('#mg-mtask .mg-barwin.active[data-mgw]')].map(b=>b.getAttribute('data-mgw'));
  out.bothOpen = mgwState.manapool && mgwState.twentyfourty && mgwState.manapool.s==='full' && mgwState.twentyfourty.s==='full';
  out.front1 = mgwFrontKey();                 // twentyfourty (opened last)
  out.active1 = active();                      // exactly one active — the frontmost
  tap('manapool'); await wait(40);             // behind → should come to FRONT (not minimize)
  out.afterBehind = { front: mgwFrontKey(), state: mgwState.manapool.s, active: active() };
  tap('manapool'); await wait(40);             // now frontmost → minimize
  out.afterFront = mgwState.manapool.s;
  tap('manapool'); await wait(40);             // minimized → restore to front
  out.afterRestore = { front: mgwFrontKey(), state: mgwState.manapool.s };
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.bothOpen
  && r.front1==='twentyfourty' && r.active1.length===1 && r.active1[0]==='twentyfourty'
  && r.afterBehind.front==='manapool' && r.afterBehind.state==='full' && r.afterBehind.active.length===1 && r.afterBehind.active[0]==='manapool'
  && r.afterFront==='min'
  && r.afterRestore.front==='manapool' && r.afterRestore.state==='full'
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
