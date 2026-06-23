// 2040 LIVE pairing UI: the 🔗 Live button, the signed-out prompt, and the create / live / done screens.
// (The two-player sync logic is covered server-side in api-smoke; here we check the client surface renders.)
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:520, height:780 }, hasTouch:true })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const $=s=>document.querySelector(s); const out={};
  mgLaunchApp('twentyfourty'); await wait(300);
  out.liveBtn=!!$('[data-tf="live"]');
  $('[data-tf="live"]').click(); await wait(60);
  out.guestPrompt=/sign in/i.test(($('.tf-panel')||{}).textContent||''); // signed-out → invited to sign in
  const x=$('.tf-overlay [data-x]'); if(x)x.click(); await wait(30);
  const body=$('#modal-prog-twentyfourty .modal-body');
  // Create / waiting screen
  _tfLive={ code:'ABCDE', body, st:{ code:'ABCDE', status:'open', role:'host', rev:0, joined:false, opponent:'', games:[], tally:{w:0,l:0,d:0}, result:'D' } };
  tfLiveScreen(body); await wait(30);
  out.openCode=/ABCDE/.test(($('.tf-livecode')||{}).textContent||'');
  out.copyBtns=document.querySelectorAll('.tf-overlay [data-cl],.tf-overlay [data-cc]').length;
  // Live screen with a recorded game
  _tfLive.st={ code:'ABCDE', status:'live', role:'host', rev:2, joined:true, opponent:'Rival', games:[{result:'W'}], tally:{w:1,l:0,d:0}, result:'W' };
  tfLiveScreen(body); await wait(30);
  out.recordBtns=document.querySelectorAll('.tf-overlay [data-g]').length;
  out.vsRival=/Rival/.test(($('.tf-panel')||{}).textContent||'');
  out.score=(($('.tf-livescore')||{}).textContent||'').includes('1');
  out.finBtn=!!$('.tf-overlay [data-fin]');
  // Tournament match: shows round context + a "Confirm result" button (two-sided confirm)
  _tfLive.st={ code:'ABCDE', status:'live', role:'host', rev:3, joined:true, opponent:'Rival', games:[{result:'W'},{result:'L'}], tally:{w:1,l:1,d:0}, result:'D', tourn:'t1', round:2, confirmedMe:false, confirmedOpp:false };
  tfLiveScreen(body); await wait(30);
  const pnl=()=>($('.tf-panel')||{}).textContent||'';
  out.tournCtx=/Tournament · Round 2/.test(pnl());
  out.confirmBtn=/Confirm result/.test(($('.tf-overlay [data-fin]')||{}).textContent||'');
  // After I confirm, the button locks pending the opponent
  _tfLive.st.confirmedMe=true; tfLiveScreen(body); await wait(30);
  out.waitingOpp=/waiting for opponent/i.test(($('.tf-overlay [data-fin]')||{}).textContent||'') && !!($('.tf-overlay [data-fin]')||{}).disabled;
  // Done screen
  _tfLive.st={ code:'ABCDE', status:'done', role:'host', rev:5, joined:true, opponent:'Rival', games:[{result:'W'},{result:'W'}], tally:{w:2,l:0,d:0}, result:'W' };
  tfLiveScreen(body); await wait(30);
  out.doneScreen=/match over/i.test(($('.tf-panel')||{}).textContent||'');
  tfLiveStop();
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.liveBtn && r.guestPrompt && r.openCode && r.copyBtns===2
  && r.recordBtns===3 && r.vsRival && r.score && r.finBtn
  && r.tournCtx && r.confirmBtn && r.waitingOpp && r.doneScreen
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
