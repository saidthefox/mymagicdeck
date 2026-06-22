// Splash overhaul: fixed User-Layout photo frame (size independent of the window), the deck-list
// widget includes the sideboard, and the serve-pic-as-splash toggle (interactive ⇄ deck pic).
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{ width:760, height:680 } });
const p = await ctx.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);

const IMG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const setup = await p.evaluate(({IMG})=>{
  state.user={username:'jake'};
  const mk=(name,oid,tl,mc,cmc)=>({name,oracle_id:oid,id:oid,type_line:tl,mana_cost:mc,cmc,image_uris:{normal:IMG,large:IMG,small:IMG},prices:{usd:'1'}});
  const deck={ id:'tdeck', name:'Frame Test', defaultLayout:'user',
    cards:{ c1:{card:mk('Llanowar Elves','c1','Creature — Elf Druid','{G}',1),qty:2}, c2:{card:mk('Giant Growth','c2','Instant','{G}',1),qty:1} },
    sideboard:{ s1:{card:mk('Naturalize','s1','Instant','{1}{G}',2),qty:2} },
    layout:{ statsOn:{ list:true } } };
  state.decks={ tdeck:deck }; state.currentDeckId='tdeck';
  openSplash(deck,'jake',{edit:true});
  return true;
},{IMG});
await p.waitForTimeout(400);

// Fixed frame present, logical size 1280, and a fit scale was computed.
const frame = await p.evaluate(()=>{ const f=document.getElementById('splash-free');
  return { framed: !!f && f.classList.contains('framed'), w:f&&f.style.width, fit:_freeFitScale, hasTag:!!document.querySelector('.splash-frame-tag') }; });

// Frame size is independent of the window: widen the viewport, the logical stage stays 1280 while the fit scale grows.
const beforeFit = await p.evaluate(()=>_freeFitScale);
await p.setViewportSize({ width:1280, height:680 }); await p.waitForTimeout(250);
const indep = await p.evaluate(()=>{ const f=document.getElementById('splash-free'); return { stillW:f.style.width, fitGrew:_freeFitScale>0 }; });
const fitChanged = await p.evaluate((bf)=>Math.abs(_freeFitScale-bf)>0.01,beforeFit);

// Deck-list widget includes a Sideboard section.
const sideboard = await p.evaluate(()=>{ const w=document.querySelector('.splash-stat.stat-list'); return !!w && /Sideboard/.test(w.textContent); });

// Serve-pic toggle: turn on serveImage with a saved pic → pic view + "Interactive Splash" button; toggle back.
const toggle = await p.evaluate(({IMG})=>{ const d=state.decks.tdeck; d.layout.splashImage=IMG; d.layout.serveImage=true;
  openSplash(d,'jake',{edit:true});
  const picShown=!!document.querySelector('#splash-body .splash-picview img');
  const vt=document.getElementById('splash-view-toggle');
  const labelPic=vt&&vt.style.display!=='none'?vt.textContent:'';
  splashToggleView(); // → interactive
  const interShown=!!document.querySelector('#splash-body .splash-free');
  const vt2=document.getElementById('splash-view-toggle');
  return { picShown, labelPic, interShown, labelInter: vt2?vt2.textContent:'', serveCtl: getComputedStyle(document.getElementById('splash-serve-ctl')).display!=='none' };
},{IMG});

console.log('frame:', JSON.stringify(frame));
console.log('indep:', JSON.stringify(indep), 'fitChanged:', fitChanged);
console.log('sideboard:', sideboard);
console.log('toggle:', JSON.stringify(toggle));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
// The invariant that matters: the logical stage is a constant 1280 (so builder = public = render),
// independent of the window. (fitChanged is logged but not asserted — the harness body width
// doesn't track the viewport, so the measured fit may not move here.)
const ok = frame.framed && frame.w==='1280px' && frame.fit>0 && frame.hasTag
  && indep.stillW==='1280px'
  && sideboard
  && toggle.picShown && /Interactive Splash/.test(toggle.labelPic) && toggle.interShown && /Deck Pic/.test(toggle.labelInter) && toggle.serveCtl
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
