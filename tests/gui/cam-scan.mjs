// Scan-to-deck camera: the 📷 FAB is mobile-only; tapping it opens a consent modal that explains it adds to
// the active deck and saves no photos; Cancel closes it. (The live camera loop needs a real device.)
import { chromium } from 'playwright';
const b = await chromium.launch();

// Desktop: FAB hidden
const dp = await (await b.newContext({ viewport:{ width:1280, height:860 } })).newPage();
const der=[]; dp.on('pageerror',e=>der.push(String(e.message||e)));
await dp.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000}); await dp.waitForTimeout(1100);
const fabDesktop = await dp.evaluate(()=>getComputedStyle(document.getElementById('cam-fab')).display);

// Mobile: FAB visible; consent modal opens + cancels
const mp = await (await b.newContext({ viewport:{ width:420, height:820 }, hasTouch:true })).newPage();
const mer=[]; mp.on('pageerror',e=>mer.push(String(e.message||e)));
await mp.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000}); await mp.waitForTimeout(1200);
const fabMobile = await mp.evaluate(()=>getComputedStyle(document.getElementById('cam-fab')).display);
const consent = await mp.evaluate(()=>{ window.state=window.state||{}; state.user={username:'t'}; localStorage.setItem('mmd_token','x');
  state.decks={d1:{id:'d1',name:'My Deck',cards:{}}}; state.currentDeckId='d1'; camScanOpen();
  const m=document.getElementById('cam-consent');
  return { open:!!m, mentionsNoPhotos:!!(m&&/no photos/i.test(m.textContent)), mentionsDeck:!!(m&&/My Deck/.test(m.textContent)) }; });
const cancelled = await mp.evaluate(()=>{ document.getElementById('cam-no').click(); return !document.getElementById('cam-consent'); });

console.log(JSON.stringify({ fabDesktop, fabMobile, consent, cancelled }));
console.log('PAGE_ERRORS:', der.length+mer.length, [...der,...mer].slice(0,3));
// Unverified guess → "<name>?  👍 👎" confirm bar; 👎 dismisses; same card is debounced (no instant re-prompt).
const confirm = await mp.evaluate(()=>{
  camHandle({ isMagicCard:true, oracleId:'x', cardName:'Black Lotus', verified:false });
  const el=document.getElementById('cam-confirm');
  const shown=el.classList.contains('show'), text=el.textContent, up=!!document.getElementById('cam-yes2'), down=!!document.getElementById('cam-no2');
  document.getElementById('cam-no2').click();
  const dismissed=!el.classList.contains('show');
  camHandle({ isMagicCard:true, oracleId:'x', cardName:'Black Lotus', verified:false });
  return { shown, hasGuess:/Black Lotus\?/.test(text), up, down, dismissed, reprompted:el.classList.contains('show') };
});

// Main/Sideboard toggle in the camera bar
const board = await mp.evaluate(()=>{ window._cam=window._cam||{}; _cam.board='main'; const btn=document.getElementById('cam-board');
  const start=btn.textContent; camToggleBoard(); const side=btn.textContent==='Sideboard'&&_cam.board==='side'&&btn.classList.contains('side');
  camToggleBoard(); return { start, side, back:btn.textContent==='Main'&&_cam.board==='main' }; });

console.log(JSON.stringify({ fabDesktop, fabMobile, consent, cancelled, confirm, board }));
console.log('PAGE_ERRORS:', der.length+mer.length, [...der,...mer].slice(0,3));
const ok = fabDesktop==='none' && fabMobile!=='none' && consent.open && consent.mentionsNoPhotos && consent.mentionsDeck && cancelled
  && confirm.shown && confirm.hasGuess && confirm.up && confirm.down && confirm.dismissed && !confirm.reprompted
  && board.start==='Main' && board.side && board.back
  && !der.length && !mer.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
