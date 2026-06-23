// IP/compliance surface: the fan-content footer + policy links, the /dmca page, and the upload-rules
// acceptance modal (checkbox gates the Accept button).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:800 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1200);
const r = await p.evaluate(async()=>{ const out={}, $=s=>document.querySelector(s);
  const f=$('#mmd-foot');
  out.footer=!!f && /Fan Content/i.test(f.textContent||'');
  out.footerLinks=!!(f && f.querySelector('a[href="/terms.html"]') && f.querySelector('a[href="/privacy.html"]') && f.querySelector('a[href="/dmca.html"]'));
  // Upload-rules modal: renders, Accept disabled until the checkbox is ticked
  try{ state.user={ username:'tester', uploads_accepted:null }; }catch(e){}
  showUploadRules(()=>{});
  const ov=document.getElementById('upload-rules-ov'); out.rulesModal=!!ov;
  const acc=ov&&ov.querySelector('#ur-accept'), ck=ov&&ov.querySelector('#ur-ck');
  out.acceptGated=!!(acc&&acc.disabled);
  if(ck){ ck.checked=true; ck.onchange(); }
  out.acceptEnabled=!!(acc&&!acc.disabled);
  if(ov)ov.remove();
  return out; });
// The /dmca page itself
const dmca = await p.goto('http://mymagicdeck.com/dmca.html',{waitUntil:'domcontentloaded',timeout:30000});
const html = await p.content();
const dmcaOk = dmca.status()===200 && /Designated Agent/.test(html) && /\{\{DMCA_AGENT_NAME\}\}/.test(html) && /Repeat infringers/i.test(html) && /Fan Content/i.test(html);
console.log(JSON.stringify(r), 'dmcaOk='+dmcaOk);
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.footer && r.footerLinks && r.rulesModal && r.acceptGated && r.acceptEnabled && dmcaOk && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
