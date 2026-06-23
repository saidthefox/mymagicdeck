// Splash: the deck-list widget includes the sideboard, and the serve-pic-as-splash toggle
// (interactive layout ⇄ saved deck pic) with the header button. (The fixed-canvas experiment
// was reverted; User Layout is the original free/zoom layout.)
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{ width:1100, height:720 } });
const p = await ctx.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);

const IMG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await p.evaluate(({IMG})=>{
  state.user={username:'jake'};
  const mk=(name,oid,tl,mc,cmc)=>({name,oracle_id:oid,id:oid,type_line:tl,mana_cost:mc,cmc,image_uris:{normal:IMG,large:IMG,small:IMG},prices:{usd:'1'}});
  const deck={ id:'tdeck', name:'Frame Test', defaultLayout:'user',
    cards:{ c1:{card:mk('Llanowar Elves','c1','Creature — Elf Druid','{G}',1),qty:2}, c2:{card:mk('Giant Growth','c2','Instant','{G}',1),qty:1} },
    sideboard:{ s1:{card:mk('Naturalize','s1','Instant','{1}{G}',2),qty:2} },
    layout:{ statsOn:{ list:true } } };
  state.decks={ tdeck:deck }; state.currentDeckId='tdeck';
  openSplash(deck,'jake',{edit:true});
},{IMG});
await p.waitForTimeout(400);

// Original free layout is back: .splash-free has an inline transform:scale (not a fixed 1280 frame).
const layout = await p.evaluate(()=>{ const f=document.getElementById('splash-free');
  return { present:!!f, scaled:!!f && /scale\(/.test(f.style.transform), notFixed: !f.classList.contains('framed') }; });

// Deck-list widget includes a Sideboard section.
const sideboard = await p.evaluate(()=>{ const w=document.querySelector('.splash-stat.stat-list'); return !!w && /Sideboard/.test(w.textContent); });

// Right-anchored full-height deck-list rail.
const rail = await p.evaluate(()=>{ splashListRail(true);
  const r=document.querySelector('.splash-stat.stat-list.rail');
  return { present:!!r, anchoredRight: !!r && r.style.right==='0px', fullHeight: !!r && parseFloat(r.style.height)>0 }; });

// Every window gets a reset gear in its title bar.
const resetGear = await p.evaluate(()=>{ if(typeof mgLaunchApp==='function')mgLaunchApp('manapool');
  const bars=[...document.querySelectorAll('.mgw-bar')]; return bars.some(b=>b.querySelector('[data-w="reset"]')); });

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

// A signed-out visitor can spawn widgets locally (Widgets menu present; not an owner; no throw).
const guest = await p.evaluate(()=>{ state.user=null; const d=state.decks.tdeck; d.layout.serveImage=false;
  openSplash(d,'jake',{}); // visit as a guest
  const wrap=document.getElementById('splash-stats-wrap');
  const owner=_splashOwner();
  let threw=false; try{ statsSet('curve',true); }catch(e){ threw=true; }
  const cv=document.querySelector('.splash-stat.stat-curve');
  return { widgetsBtn: !!wrap && !!wrap.querySelector('button') && getComputedStyle(wrap).display!=='none', owner, threw, curve:!!cv, draggable: !!cv && !!cv.getAttribute('onpointerdown'), genBtn: (function(){ try{ statsSet('profile',true); }catch(e){} return !!document.querySelector('.stat-profile .ss-prof-empty .btn'); })() }; });

console.log('guest:', JSON.stringify(guest));
console.log('layout:', JSON.stringify(layout));
console.log('sideboard:', sideboard);
console.log('rail:', JSON.stringify(rail), 'resetGear:', resetGear);
console.log('toggle:', JSON.stringify(toggle));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = layout.present && layout.scaled && layout.notFixed
  && sideboard
  && rail.present && rail.anchoredRight && rail.fullHeight && resetGear
  && toggle.picShown && /Interactive Splash/.test(toggle.labelPic) && toggle.interShown && /Deck Pic/.test(toggle.labelInter) && toggle.serveCtl
  && guest.widgetsBtn && !guest.owner && !guest.threw && guest.curve && guest.draggable && guest.genBtn
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
