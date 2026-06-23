// Window-manager focus (clicking a buried window's taskbar button raises it above MMD), Cardle's
// taller default window, and Dicey's persistent hop-platforms (+ the off switch).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:800 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,140));}); p.on('pageerror',e=>errs.push('PE:'+e.message));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const out={};
  if(!document.body.classList.contains('wm-on')){ try{ deckosToggle&&deckosToggle(); }catch(e){} } await wait(200);
  try{ DeckOS.store.remove('wm:rect:cardle'); }catch(e){}
  wmOpenSite(); await wait(120); mgLaunchApp('cardle'); await wait(250);
  const cEl=()=>wmWins.cardle&&wmWins.cardle.el, sEl=()=>wmWins.site&&wmWins.site.el;
  // Cardle opens tall enough to show the full card (default rect, no saved size).
  out.cardleH = wmWins.cardle.rect.h;     // viewport 800 → min(760, 752) ≈ 752
  // Focus the site (MMD) on top, then click Cardle's taskbar button → Cardle must come forward.
  wmFocus('site'); await wait(60); out.siteOnTop = (+sEl().style.zIndex > +cEl().style.zIndex);
  wmTaskClick('cardle'); await wait(60);
  out.cardleRaised = (+cEl().style.zIndex > +sEl().style.zIndex) && wmFocusedKey==='cardle';
  // Even if a window grabbed a stray huge z, focus still beats it.
  sEl().style.zIndex='99999'; wmFocus('cardle'); await wait(20);
  out.beatsStrayZ = (+cEl().style.zIndex > 99999);
  // Dicey persistent platforms.
  try{ diceyInit(); }catch(e){} await wait(60);
  const s=diceyState(); s.platforms=true; diceySave(s);
  const plat=diceyBuildPlatform({hop:false});
  out.platMade = !!plat && document.querySelectorAll('.dicey-pf').length===1;
  out.platThin = plat && (parseFloat(plat.style.height) <= 12);
  await wait(4600); out.platPersists = document.querySelectorAll('.dicey-pf').length===1; // old behaviour faded at 4s
  diceyClearPlatforms(); out.platCleared = document.querySelectorAll('.dicey-pf').length===0;
  // Off switch: building is a no-op when disabled.
  const s2=diceyState(); s2.platforms=false; diceySave(s2);
  out.offNoop = (diceyBuildPlatform({hop:false})===null) && document.querySelectorAll('.dicey-pf').length===0;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.cardleH>=700 && r.siteOnTop && r.cardleRaised && r.beatsStrayZ
  && r.platMade && r.platThin && r.platPersists && r.platCleared && r.offNoop
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
