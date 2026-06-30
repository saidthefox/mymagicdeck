// MMD card-box Type + Subtype dropdowns: the type line reads "Type — Subtype"; picking a type sets it and
// constrains the (searchable) subtype list; picking a subtype builds the t: query and finds cards.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1280, height:860 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
await p.evaluate(()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';} });

const init = await p.evaluate(()=>({ type:document.getElementById('cm-type-btn')?.textContent, sub:document.getElementById('cm-sub-btn')?.textContent }));

await p.click('#cm-type-btn'); await p.waitForTimeout(300);
const typeCount = await p.evaluate(()=>document.querySelectorAll('#cm-picker .cm-picker-item').length);
await p.evaluate(()=>{ const it=[...document.querySelectorAll('#cm-picker .cm-picker-item')].find(e=>e.textContent==='Creature'); it&&it.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); });
await p.waitForTimeout(600);

await p.click('#cm-sub-btn'); await p.waitForTimeout(300);
const sub = await p.evaluate(()=>({ searchable:!!document.querySelector('#cm-picker .cm-picker-search'),
  angel:[...document.querySelectorAll('#cm-picker .cm-picker-item')].some(e=>e.textContent==='Angel') }));
// type a filter to confirm search narrows, then pick Angel
await p.fill('#cm-picker .cm-picker-search','ang'); await p.waitForTimeout(200);
const filtered = await p.evaluate(()=>[...document.querySelectorAll('#cm-picker .cm-picker-item')].every(e=>/ang/i.test(e.textContent)||e.textContent==='Any subtype'));
await p.evaluate(()=>{ const it=[...document.querySelectorAll('#cm-picker .cm-picker-item')].find(e=>e.textContent==='Angel'); it&&it.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); });
await p.waitForTimeout(1600);

const after = await p.evaluate(()=>({ type:document.getElementById('cm-type-btn')?.textContent, sub:document.getElementById('cm-sub-btn')?.textContent,
  q:document.getElementById('search-input')?.value, results:document.querySelectorAll('.card-result').length }));

console.log(JSON.stringify({init, typeCount, sub, filtered, after}));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,3));
const ok = init.type==='Type' && init.sub==='Subtype' && typeCount>=8 && sub.searchable && sub.angel && filtered
  && after.type==='Creature' && after.sub==='Angel' && after.q.includes('t:creature') && after.q.includes('t:angel') && after.results>0 && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
