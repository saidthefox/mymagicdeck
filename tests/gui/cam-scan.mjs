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
const ok = fabDesktop==='none' && fabMobile!=='none' && consent.open && consent.mentionsNoPhotos && consent.mentionsDeck && cancelled && !der.length && !mer.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
