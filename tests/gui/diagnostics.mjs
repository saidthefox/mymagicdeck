// Diagnostics program: renders both columns (server + client), shows live client state, and degrades
// gracefully when signed out (prompts to sign in instead of erroring).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:680, height:760 }, hasTouch:true })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s); const out={};
  out.registered = !!(typeof MGW_APPS!=='undefined' && MGW_APPS['diagnostics']); // MGW_APPS is a const, not on window
  mgLaunchApp('diagnostics'); await wait(120);
  out.cols = $$('.diag-col').length;                         // two columns: server + client
  out.hasClientState = /Open programs|Frontmost|Signed in/.test(($('.diag-wrap')||{}).textContent||'');
  out.signedOutNote = /sign in/i.test(($('.diag-note')||{}).textContent||''); // guest sees a prompt, not a crash
  out.refresh = !!$('[data-diag-refresh]');
  // After a Refresh (how a scout reads it), the snapshot reflects the now-open window.
  $('[data-diag-refresh]').click(); await wait(80);
  out.knowsSelf = /Diagnostics/.test(($('.diag-wrap')||{}).textContent||'');
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.registered && r.cols===2 && r.hasClientState && r.signedOutNote && r.refresh && r.knowsSelf && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
