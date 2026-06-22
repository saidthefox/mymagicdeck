// Pinned mobile taskbar: quick app-switcher that reserves bounds (full-screen apps sit above it),
// double-height option, switching between open apps, and the Startup selector in System Settings.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{width:780,height:420}, hasTouch:true, isMobile:true, deviceScaleFactor:2 })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(2000);
await p.evaluate(()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  try{ DeckOS.store.set('taskbarPinned',true); DeckOS.store.set('taskbarBig',true); }catch(e){}
  taskbarApply(); mgLaunchApp('manapool'); mgLaunchApp('dicebag'); });
await p.waitForTimeout(400);
const bar = await p.evaluate(()=>{ const bar=document.getElementById('mg-mtask'); if(!bar)return {present:false}; const apps=bar.querySelectorAll('.mg-barwin[data-mgw]'); const b0=apps[0]&&apps[0].getBoundingClientRect();
  return { present:true, hasStart:!!bar.querySelector('#mt-start'), apps:apps.length, bigSquare: !!b0 && Math.abs(b0.width-b0.height)<8 && b0.width<=60, nameHidden: apps[0]?getComputedStyle(apps[0].querySelector('.bw-nm')).display==='none':false }; });

// full-screen app reserves space above the bar
await p.evaluate(()=>mgLaunchApp('landgame')); await p.waitForTimeout(400);
const reserve = await p.evaluate(()=>{ const m=document.querySelector('#modal-prog-landgame .modal'), bar=document.getElementById('mg-mtask'); if(!m||!bar)return {ok:false}; const mr=m.getBoundingClientRect(), br=bar.getBoundingClientRect(); return { barVisible: br.top>=mr.bottom-2 && br.bottom<=innerHeight+1 }; });

// switch back to Mana Pool via the bar
const switched = await p.evaluate(()=>{ const btn=[...document.querySelectorAll('#mg-mtask .mg-barwin[data-mgw]')].find(b=>b.getAttribute('data-mgw')==='manapool'); if(btn)btn.click(); return mgwState['manapool'] && mgwState['manapool'].s==='full'; });

// Startup selector present in System Settings
const startup = await p.evaluate(()=>{ try{ mgLaunchApp('sysset'); }catch(e){} const sel=document.getElementById('ss-startup'); return { present:!!sel, opts: sel?sel.options.length:0, hasCgg: sel?[...sel.options].some(o=>o.value==='cgg'):false }; });

console.log('bar:', JSON.stringify(bar));
console.log('reserve:', JSON.stringify(reserve));
console.log('switched:', switched);
console.log('startup:', JSON.stringify(startup));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = bar.present && bar.hasStart && bar.apps===2 && bar.bigSquare && bar.nameHidden && reserve.barVisible && switched && startup.present && startup.hasCgg && startup.opts>=3 && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
