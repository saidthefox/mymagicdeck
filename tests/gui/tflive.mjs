// 2040 live match renders INSIDE the board (not a trapping overlay): shared life (opponent read-only),
// a live strip with per-game result + finish/confirm + leave, and the linking entry panel.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:520, height:820 }, hasTouch:true })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s); const out={};
  mgLaunchApp('twentyfourty'); await wait(250);
  const body=$('#modal-prog-twentyfourty .modal-body');
  out.liveEntry=!!$('[data-tf="live"]');                          // the 🔗 Live button in the tracker
  // Guest taps Live → the entry panel invites sign-in
  $('[data-tf="live"]').click(); await wait(50);
  out.guestPrompt=/sign in/i.test(($('.tf-panel')||{}).textContent||''); const x=$('.tf-overlay [data-x]'); if(x)x.click(); await wait(20);
  // --- Live match rendered in the board ---
  try{ state.user={ username:'tester', uploads_accepted:1 }; }catch(e){}
  _tfLive={ code:'ABCDE', body, myLife:18, st:{ code:'ABCDE', status:'live', role:'host', opponent:'Rival', games:[{result:'W'}], tally:{w:1,l:0,d:0}, result:'W', startLife:20, myLife:18, oppLife:15, tourn:null, round:null, confirmedMe:false, confirmedOpp:false } };
  lcRender(body); await wait(40);
  out.notTrapped = !$('.tf-overlay') && !!$('.lc-fs');            // no blocking overlay; the board is shown
  out.oppName = /Rival/.test(($('.lc-half')||{}).textContent||'');
  out.lives = [...$$('.lc-life')].map(e=>e.textContent);          // should include 15 (opp) and 18 (me)
  out.oppReadOnly = !!$('.lc-ovbtns.lc-ro') && !$('[data-lc="0"]'); // opponent half synced/read-only
  out.myEditable = !!$('[data-lc="1"]');
  out.recordBtns = $$('[data-lg]').length; out.finBtn = !!$('[data-lfin]'); out.leaveBtn = !!$('[data-lleave]');
  // life adjust (my half) bumps my life locally (+ debounced sync)
  const plus=[...$$('[data-lc="1"]')].find(b=>b.getAttribute('data-d')==='1'); if(plus)plus.click(); await wait(20);
  out.lifeBumped = _tfLive.myLife===19;
  // Waiting (open) state shows the code + cancel in the board strip (still usable)
  _tfLive.st.status='open'; lcRender(body); await wait(20);
  out.waitStrip = /ABCDE/.test(($('.lc-livebar')||{}).textContent||'') && !!$('[data-lcancel]') && !!$('[data-lc="1"]');
  // Tournament match → centered report box (not a strip): round context + Confirm button
  _tfLive.st={ code:'ABCDE', status:'live', role:'host', opponent:'Rival', games:[{result:'W'}], tally:{w:1,l:0,d:0}, result:'W', startLife:20, myLife:18, oppLife:15, tourn:'t1', round:2, confirmedMe:false, confirmedOpp:false };
  lcRender(body); await wait(20);
  out.tournBox = !!$('.lc-tbox'); out.tournCtx = /Round 2/.test(($('.lc-tbox-hd')||{}).textContent||''); out.confirmBtn = /Confirm/.test(($('[data-lfin]')||{}).textContent||'');
  out.mulliganBtn = !!$('[data-tf="mull"]') && !!$('[data-tf="next"]');   // gameplay flow (mulligan + next game) available in tournament mode
  // X → minimize to trophy chip → reopen
  $('[data-tboxmin]').click(); await wait(20);
  out.chip = !!$('.lc-tchip') && !$('.lc-tbox');
  $('[data-tboxmax]').click(); await wait(20);
  out.reopened = !!$('.lc-tbox');
  // Done → result + Done button (in the box)
  _tfLive.min=false; _tfLive.st={ code:'ABCDE', status:'done', role:'host', opponent:'Rival', games:[{result:'W'},{result:'W'}], tally:{w:2,l:0,d:0}, result:'W', tourn:'t1', round:2 };
  lcRender(body); await wait(20);
  out.doneStrip = /reported/i.test(($('.lc-tbox')||{}).textContent||'') && !!$('[data-lleave]');
  tfLiveStop(); lcRender(body);
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.liveEntry && r.guestPrompt && r.notTrapped && r.oppName
  && r.lives.includes('15') && r.lives.includes('18') && r.oppReadOnly && r.myEditable
  && r.recordBtns===3 && r.finBtn && r.leaveBtn && r.lifeBumped
  && r.waitStrip && r.tournBox && r.tournCtx && r.confirmBtn && r.mulliganBtn && r.chip && r.reopened && r.doneStrip
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
