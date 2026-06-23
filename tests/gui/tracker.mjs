// 2040 match tracker: Start → Mulligan/Next Game (records per-game result) → Finish Match
// (end screen: opponent, decks, editable mulligans, notes) → saved to local history.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:520, height:760 }, hasTouch:true })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  try{ DeckOS.store.set('tf_matches',[]); }catch(e){}
  mgLaunchApp('twentyfourty'); await new Promise(r=>setTimeout(r,300));
  const $=s=>document.querySelector(s); const wait=()=>new Promise(r=>setTimeout(r,60)); const out={};
  out.idleStart=!!$('[data-tf="start"]');
  $('[data-tf="start"]').click(); await wait();
  out.afterStart={ mull:!!$('[data-tf="mull"]'), next:!!$('[data-tf="next"]'), finishHidden:!$('[data-tf="finish"]') };
  $('[data-tf="mull"]').click(); $('[data-tf="mull"]').click();
  out.mull2=/\(2\)/.test($('[data-tf="mull"]').textContent);
  $('[data-tf="next"]').click(); await wait(); $('.tf-wld [data-r="W"]').click(); await wait();
  out.afterNext={ game2:/Game 2/.test($('.tf-game').textContent), finishShown:!!$('[data-tf="finish"]'), mullReset:/\(0\)/.test($('[data-tf="mull"]').textContent) };
  $('[data-tf="finish"]').click(); await wait(); $('.tf-wld [data-r="L"]').click(); await wait();
  out.endScreen={ opp:!!$('#tf-opp'), mrows:document.querySelectorAll('.tf-mrow').length };
  $('#tf-opp').value='Bob'; $('#tf-theirdeck').value='Mono-Red';
  $('[data-save]').click(); await wait();
  const list=DeckOS.store.get('tf_matches')||[]; const m=list[0]||{};
  out.saved={ n:list.length, opp:m.opponent, theirDeck:m.theirDeck, res:m.result, g1mull:(m.games&&m.games[0]||{}).mulligans, games:(m.games||[]).length };
  $('[data-tf="history"]').click(); await wait(); out.hist=document.querySelectorAll('.tf-hist-row').length;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.idleStart && r.afterStart.mull && r.afterStart.next && r.afterStart.finishHidden && r.mull2
  && r.afterNext.game2 && r.afterNext.finishShown && r.afterNext.mullReset
  && r.endScreen.opp && r.endScreen.mrows===2
  && r.saved.n===1 && r.saved.opp==='Bob' && r.saved.theirDeck==='Mono-Red' && r.saved.res==='D' && r.saved.g1mull===2 && r.saved.games===2
  && r.hist===1 && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
