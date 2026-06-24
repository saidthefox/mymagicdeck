// Mobile Start menu: a flyout opened then dismissed must NOT reappear open on the next open, and launching
// a program closes the menu. (Regression: _smCats persisted across reopens on mobile.)
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:430, height:780 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const out={};
  document.body.classList.remove('wm-on','deckos'); document.body.classList.add('mtask-on');
  mtaskStartMenu(); await wait(60);                                   // open
  out.opened = !!document.getElementById('mt-startmenu');
  const cat = document.querySelector('#mt-startmenu .mg-smcat[data-cat]');
  out.hasCat = !!cat;
  if(cat){ cat.click(); await wait(40); out.flyoutOpened = cat.classList.contains('open'); }
  mtaskStartMenu(); await wait(40);                                   // toggle closed
  out.closed = !document.getElementById('mt-startmenu');
  mtaskStartMenu(); await wait(60);                                   // reopen
  out.reopenedClean = !document.querySelector('#mt-startmenu .mg-smcat.open');   // no stale-open flyout
  // launching a program closes the menu
  const item = document.querySelector('#mt-startmenu .mg-smitem[data-app]');
  out.hasItem = !!item;
  if(item){ item.click(); await wait(80); out.closedOnLaunch = !document.getElementById('mt-startmenu'); }
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.opened && r.hasCat && r.flyoutOpened && r.closed && r.reopenedClean && r.hasItem && r.closedOnLaunch && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
