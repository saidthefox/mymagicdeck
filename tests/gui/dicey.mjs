// Dicey — d20 desktop helper: first-visit intro (new/returning), guided tour, help panel
// (launcher + search + roll), and on/off toggle. The d20 shows no number until it rolls.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:960, height:700 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1800);

// First-visit intro: fresh browser (no dicey_seen) → intro asks new vs returning.
const intro = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  try{ DeckOS.store.set('dicey',{on:true,x:240,y:240}); DeckOS.store.remove('dicey_seen'); }catch(e){}
  if(_diceyEl){_diceyEl.remove();_diceyEl=null;} _diceyOpen=false; _diceyGreeted=false;
  diceyInit(); await new Promise(r=>setTimeout(r,850));
  const out={ noNumber:(getComputedStyle(document.querySelector('.dicey-face')).opacity==='0'), introNew:!!document.querySelector('[data-i="new"]'), introRet:!!document.querySelector('[data-i="ret"]') };
  document.querySelector('[data-i="new"]').click(); await new Promise(r=>setTimeout(r,60));
  out.askTour=!!document.querySelector('[data-t="go"]');
  document.querySelector('[data-t="go"]').click(); await new Promise(r=>setTimeout(r,250));
  out.tourBubble=!!document.querySelector('.dicey-bubble [data-skip]'); out.tourActed=!!document.querySelector('.dicey-tip');
  diceyTourEnd(); await new Promise(r=>setTimeout(r,60)); out.tourStopped=!document.querySelector('.dicey-bubble');
  // Dicey leaves a pinned "init.note" with the cave-wall d20 + "Dicey was here".
  try{ DeckOS.store.set('notes',[]); }catch(e){} diceyLeaveNote();
  const notes=(DeckOS.store.get('notes')||[]); const nn=notes.find(n=>n.title==='init.note');
  out.note = !!nn && /Dicey was here/.test(nn.body||'') && /░/.test(nn.body||'') && nn.pinned===true;
  return out; });

// Help panel + roll + toggle (returning visitor: seen set, no intro).
const r = await p.evaluate(async()=>{ try{ DeckOS.store.set('dicey_seen',1); }catch(e){}
  if(_diceyEl){_diceyEl.remove();_diceyEl=null;} _diceyOpen=false; _diceyGreeted=true; diceyInit(); await new Promise(r=>setTimeout(r,150));
  const $=s=>document.querySelector(s), out={};
  out.present=!!$('#dicey .dicey-die');
  $('#dicey .dicey-die').click(); await new Promise(r=>setTimeout(r,80));
  out.panel=!!$('.dicey-bubble'); out.apps=document.querySelectorAll('.dicey-app[data-dapp]').length; out.roll=!!$('.dicey-roll'); out.replay=!!$('[data-tour]');
  $('.dicey-search').value='cardle'; $('.dicey-search').dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,40));
  out.filtered=[...document.querySelectorAll('.dicey-app[data-dapp]')].filter(b=>b.style.display!=='none').length;
  $('.dicey-roll').click(); await new Promise(r=>setTimeout(r,950));
  out.face=parseInt(($('.dicey-face')||{}).textContent||'0'); out.faceShown=getComputedStyle($('.dicey-face')).opacity!=='0';
  diceyToggle(); out.gone=!$('#dicey'); diceyToggle(); out.back=!!$('#dicey .dicey-die');
  return out; });

console.log('intro:', JSON.stringify(intro));
console.log('panel:', JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = intro.noNumber && intro.introNew && intro.introRet && intro.askTour && intro.tourBubble && intro.tourStopped && intro.note
  && r.present && r.panel && r.apps>=8 && r.roll && r.replay && r.filtered===1 && r.face>=1 && r.face<=20 && r.faceShown && r.gone && r.back
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
