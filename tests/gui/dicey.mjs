// Dicey — the friendly d20 desktop helper: appears, opens a help panel (app launcher + search +
// roll), rolls to a face, and toggles on/off.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:900, height:680 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1800);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  try{ DeckOS.store.set('dicey',{on:true,x:null,y:null}); }catch(e){}
  if(typeof diceyInit==='function')diceyInit(); await new Promise(r=>setTimeout(r,150));
  const $=s=>document.querySelector(s), out={};
  out.present=!!$('#dicey .dicey-die');
  $('#dicey .dicey-die').click(); await new Promise(r=>setTimeout(r,80));
  out.panel=!!$('.dicey-bubble'); out.apps=document.querySelectorAll('.dicey-app').length; out.roll=!!$('.dicey-roll'); out.search=!!$('.dicey-search');
  $('.dicey-search').value='cardle'; $('.dicey-search').dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,40));
  out.filtered=[...document.querySelectorAll('.dicey-app')].filter(b=>b.style.display!=='none').length;
  $('.dicey-roll').click(); await new Promise(r=>setTimeout(r,900));
  out.face=parseInt(($('.dicey-face')||{}).textContent||'0');
  diceyToggle(); out.gone=!$('#dicey');
  diceyToggle(); out.back=!!$('#dicey .dicey-die');
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.present && r.panel && r.apps>=8 && r.roll && r.search && r.filtered===1
  && r.face>=1 && r.face<=20 && r.gone && r.back && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
