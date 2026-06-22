// Basics menu (format selector + dynamic title) and the online board mapping:
// a redacted server state renders the shared board with the opponent's hand hidden + clocks.
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{ width:760, height:400 }, hasTouch:true, isMobile:true, deviceScaleFactor:2 });
const p = await ctx.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(2000);
await p.evaluate(()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';} try{ mgLaunchApp('landgame'); }catch(e){ try{ MGW_APPS['landgame'].open(); }catch(_){} } });
await p.waitForTimeout(700);

const menu = await p.evaluate(()=>{ const d=document.querySelector('#modal-prog-landgame'); if(!d)return {missing:true}; const t=document.querySelector('#modal-prog-landgame .mgw-ti');
  return { title:t?t.textContent.trim():null, fmtBtns:d.querySelectorAll('[data-fmt]').length, hasCpu:!!d.querySelector('#lg-cpu'), hasOnline:!!d.querySelector('#lg-online'), h3:d.querySelector('.lg-start h3')?.textContent }; });

const testFmt = await p.evaluate(()=>{ const d=document.querySelector('#modal-prog-landgame'); const tb=d&&d.querySelector('[data-fmt="test"]'); if(tb)tb.click();
  return { clicked:!!tb, hasCpu:!!(d&&d.querySelector('#lg-cpu')), placeholder: !!(d&&/Not playable/i.test(d.querySelector('.lg-start')?.innerText||'')) }; });

const titleGame = await p.evaluate(()=>{ const d=document.querySelector('#modal-prog-landgame'); const lb=d&&d.querySelector('[data-fmt="land"]'); if(lb)lb.click(); const cpu=d&&d.querySelector('#lg-cpu'); if(cpu)cpu.click(); return document.querySelector('#modal-prog-landgame .mgw-ti')?.textContent.trim(); });
await p.waitForTimeout(300);

const online = await p.evaluate(()=>{
  const fake={ seat:0, active:0, turn:1, stack:[], priority:0, mode:'turn', status:'playing', winner:null, reason:null, castThisTurn:false, names:['You','Rival'],
    players:[ { hand:['plains','island','swamp','mountain','forest'], deck:25, gy:['wastes'], exile:[], field:{plains:1,island:0,swamp:0,mountain:0,forest:0,wastes:0} },
              { hand:['?','?','?','?','?'], deck:25, gy:[], exile:[], field:{plains:0,island:0,swamp:0,mountain:1,forest:0,wastes:0} } ],
    choice:null, clock:'5m', clocks:{0:300000,1:300000}, log:['— Your turn —'] };
  _lgo={ code:'TEST1', seat:0, clock:'5m', _t:null, _clk:null }; lgoMap(fake); lgRender(_lgBody); const d=_lgBody;
  return { myHand:d.querySelectorAll('.lg-hand .lg-bigcard[data-h]').length, oppBacks:d.querySelectorAll('.lg-handfan.tiny .lg-bigcard.back').length,
    clocks:d.querySelectorAll('[data-clk]').length, divider:!!d.querySelector('.lg-divider'), mode2:_lg.mode2,
    oppLeak: /Swamp|Forest|Island|Mountain|Plains|Wastes/.test(d.querySelector('.lg-handfan.tiny')?.textContent||'') }; });

console.log('menu:', JSON.stringify(menu));
console.log('testFmt:', JSON.stringify(testFmt));
console.log('titleGame:', JSON.stringify(titleGame));
console.log('online:', JSON.stringify(online));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = menu.title==='🏞️Basics' && menu.fmtBtns===2 && menu.hasCpu && menu.hasOnline && menu.h3==='Basics'
  && !testFmt.hasCpu && testFmt.placeholder
  && titleGame==='🏞️Basics — The Land Game'
  && online.myHand===5 && online.oppBacks===5 && online.clocks===2 && online.divider && online.mode2==='online' && !online.oppLeak
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
