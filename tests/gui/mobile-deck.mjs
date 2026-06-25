// Mobile deckbuilder: the Deck flap renders the Hearthstone-style list (art strip bg, mana pips, big
// name, −/count/+ stepper), the +/− work, and the bottom-nav flaps round-trip without the wide
// deck-visual trap (Search flap returns to card search; the redundant view-toggle is hidden).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:430, height:820 }, deviceScaleFactor:2, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
await p.evaluate(()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const si=document.getElementById('search-input'); si.value='c:g cmc<=3'; si.dispatchEvent(new Event('input',{bubbles:true})); if(typeof performSearch==='function')performSearch(); });
await p.waitForTimeout(2500);
await p.evaluate(()=>{ const r=state.searchResults||[]; for(let i=0;i<6&&i<r.length;i++) addCard(r[i]); if(typeof mobileNav==='function')mobileNav('deck'); });
await p.waitForTimeout(500);
const r = await p.evaluate(()=>{
  const rows=[...document.querySelectorAll('#panel-deck .mob-deck-row')].filter(x=>x.offsetParent!==null);
  const first=rows[0];
  const out={ rows:rows.length, art:first?/url\(/.test(first.getAttribute('style')||''):false,
    pips:first?first.querySelectorAll('.mob-deck-pips .ms, .mob-deck-pips .mana-symbol').length:0,
    steppers:first?first.querySelectorAll('.mob-step').length:0,
    name:first?!!first.querySelector('.mob-deck-name'):false,
    sections:[...document.querySelectorAll('#panel-deck .mob-section-header')].filter(x=>x.offsetParent!==null).length };
  out.ctBefore=first?first.querySelector('.mob-deck-ct').textContent:null;
  const plus=[...first.querySelectorAll('.mob-step')].pop(); plus.click();
  // the list re-renders on qty change → re-query the (new) first visible row rather than the detached node
  const fresh=[...document.querySelectorAll('#panel-deck .mob-deck-row')].filter(x=>x.offsetParent!==null)[0];
  out.ctAfter=fresh?fresh.querySelector('.mob-deck-ct').textContent:null;
  // nav round-trip
  mobileNav('search');
  const dv=document.getElementById('deck-visual-view');
  out.searchShown=document.getElementById('panel-search').offsetParent!==null;
  out.deckHiddenOnSearch=document.getElementById('panel-deck').classList.contains('mobile-hidden');
  out.deckVisualTrapGone=!dv||dv.style.display==='none'||dv.offsetParent===null;
  out.viewToggleHidden=getComputedStyle(document.querySelector('.view-toggle')).display==='none';
  mobileNav('deck');
  out.deckBack=document.getElementById('panel-deck').offsetParent!==null;
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.rows>=4 && r.art && r.pips>=1 && r.steppers===2 && r.name && r.sections>=2
  && r.ctBefore==='1' && r.ctAfter==='2'
  && r.searchShown && r.deckHiddenOnSearch && r.deckVisualTrapGone && r.viewToggleHidden && r.deckBack
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
