// CGG card redesign: Type — Subtype line (dash not tappable), Keywords zone, art-area gesture legend, and
// every zone has tap/double/long-press. Long-press opens the shared picker; a suggestion auto-fills subtype.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:420, height:820 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);

const init = await p.evaluate(()=>{ mgWire(); mgRender(); mgArt('building'); return {
  type:document.getElementById('mg-type-label').textContent, sub:document.getElementById('mg-sub-label').textContent,
  kw:document.getElementById('mg-kw').textContent, dash:!!document.querySelector('.mg-typedash'),
  legend:/Hold/.test(document.getElementById('mg-art').textContent) && /Double-tap/.test(document.getElementById('mg-art').textContent) }; });

const tapType = await p.evaluate(()=>{ document.getElementById('mg-type-label').click(); return new Promise(r=>setTimeout(()=>r(MG_TYPES[mgState.ti]),300)); });

async function hold(id){ await p.evaluate(i=>{ const el=document.getElementById(i); const r=el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+3,clientY:r.top+3})); }, id); await p.waitForTimeout(620); }
async function close(){ await p.evaluate(()=>{ const pk=document.getElementById('cm-picker'); if(pk)pk.remove(); }); }

await hold('mg-sub-label'); const subPick = await p.evaluate(()=>!!document.getElementById('cm-picker')); await close();
await hold('mg-edge-l'); const colorPick = await p.evaluate(()=>!!document.getElementById('cm-picker') && [...document.querySelectorAll('#cm-picker .cm-picker-item')].some(e=>e.textContent==='Multicolor')); await close();
await hold('mg-mana'); const manaPick = await p.evaluate(()=>!!document.getElementById('cm-picker')); await close();
await hold('mg-pow'); const powPick = await p.evaluate(()=>!!document.getElementById('cm-picker')); await close();
await hold('mg-kw'); const kwPick = await p.evaluate(()=>!!document.getElementById('cm-picker')); await close();

const fill = await p.evaluate(()=>{ mgGuess.cands=[{name:'Serra Angel',typeLine:'Creature — Angel',power:'4',toughness:'4',manaCost:'{3}{W}{W}'}]; mgGuess.idx=0; mgShowGuess();
  return { type:document.getElementById('mg-type-label').textContent, sub:document.getElementById('mg-sub-label').textContent }; });

console.log(JSON.stringify({ init, tapType, subPick, colorPick, manaPick, powPick, kwPick, fill }));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,3));
const ok = init.type==='Type' && init.sub==='Subtype' && init.kw==='Keywords' && init.dash && init.legend
  && tapType==='Artifact' && subPick && colorPick && manaPick && powPick && kwPick
  && fill.type==='Creature' && fill.sub==='Angel' && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
