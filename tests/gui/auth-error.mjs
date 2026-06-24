// Auth form must SHOW server errors. Regression guard: doAuth's finally used to call _updateAuthUI(),
// which clears #auth-err — instantly wiping the message the catch just set, so failed sign-ups gave no
// feedback. Here a server-rejected signup (bad username pattern → 400) must leave a visible error.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1280, height:840 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const vis=el=>el&&el.offsetParent!==null; const out={};
  signInClick('signup'); await wait(300); _authMode='signup'; _updateAuthUI(); await wait(120);
  // passes the client checks (non-empty user, has @, ≥8 chars) but the server rejects the username pattern → 400
  [...document.querySelectorAll('#auth-username')].find(vis).value='zz bad!!';
  [...document.querySelectorAll('#auth-email')].find(vis).value='zz_autherr@example.com';
  [...document.querySelectorAll('#auth-password')].find(vis).value='abcd1234';
  const btn=[...document.querySelectorAll('#auth-submit-btn,[onclick="doAuth()"]')].find(vis);
  btn.click(); await wait(1500);
  const errEl=[...document.querySelectorAll('#auth-err')].find(vis)||document.querySelector('#auth-err');
  out.errText = (errEl&&errEl.textContent||'').trim();
  out.btnText = (btn.textContent||'').trim();
  out.btnEnabled = !btn.disabled;
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.errText.length > 0          // an error message is actually visible (the bug: it was wiped to '')
  && r.btnText === 'Create Account'      // button label restored (not stuck on '…')
  && r.btnEnabled
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
