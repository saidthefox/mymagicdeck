// Interactions icon shifts through the holding-hands emoji set; each shuffle differs from the current,
// and MGW_APPS.interactions.icon reflects the live value.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:600, height:500 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(()=>{
  const out={}; const prev=MGW_APPS.interactions.icon; const seq=[];
  for(let i=0;i<10;i++){ ixShuffleIcon(); seq.push(MGW_APPS.interactions.icon); }
  out.allValid = seq.every(x=>IX_ICONS.includes(x));
  out.noAdjacentRepeat = seq.every((x,i)=> i===0 ? x!==prev : x!==seq[i-1]);
  out.distinct = new Set(seq).size;
  out.iconReflects = MGW_APPS.interactions.icon === seq[seq.length-1];
  out.startMenuReroll = (()=>{ const a=MGW_APPS.interactions.icon; mtaskStartMenu(); const m=MGW_APPS.interactions.icon; mtaskStartMenu(); return m!==a; })();
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.allValid && r.noAdjacentRepeat && r.distinct>=3 && r.iconReflects && r.startMenuReroll && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
