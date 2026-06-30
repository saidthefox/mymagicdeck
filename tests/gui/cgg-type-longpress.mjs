// CGG type spot: tap cycles, but a LONG-PRESS opens the full type picker so you can jump straight to a type.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:420, height:820 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);

const wired = await p.evaluate(()=>{ mgWire(); const el=document.getElementById('mg-type-label'); return !!(el&&el._mg); });
// long-press: pointerdown held >500ms, no pointerup
await p.evaluate(()=>{ const el=document.getElementById('mg-type-label'); const r=el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+5,clientY:r.top+5})); });
await p.waitForTimeout(650);
const picker = await p.evaluate(()=>{ const pk=document.getElementById('cm-picker');
  return { open:!!pk, hasCreature:!!(pk&&[...pk.querySelectorAll('.cm-picker-item')].some(e=>e.textContent==='Creature')) }; });
const picked = await p.evaluate(()=>{ const it=[...document.querySelectorAll('#cm-picker .cm-picker-item')].find(e=>e.textContent==='Creature');
  if(it)it.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
  return { type:MG_TYPES[mgState.ti], label:document.getElementById('mg-type-label').textContent }; });

console.log(JSON.stringify({ wired, picker, picked }));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,3));
const ok = wired && picker.open && picker.hasCreature && picked.type==='Creature' && picked.label==='Creature' && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
