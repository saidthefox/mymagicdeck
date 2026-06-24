// Interactions program renders (feed + tournament filter); 2040 Deck button opens the deck picker.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:560, height:760 }, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  const wait=ms=>new Promise(r=>setTimeout(r,ms)); const $=s=>document.querySelector(s); const out={};
  out.registered = !!(typeof MGW_APPS!=='undefined' && MGW_APPS['interactions']);
  mgLaunchApp('interactions'); await wait(500);
  out.wrap=!!$('.ix-wrap'); out.filter=!!$('.ix-filter'); out.body=!!$('.ix-body');
  out.feedRendered = !!($('.ix-body') && ($('.ix-row')||$('.ix-empty')));   // either rows or the empty-state message
  // 2040 Deck button → picker
  mgLaunchApp('twentyfourty'); await wait(300);
  out.deckBtn = !!$('.lc-deckbtn');
  if($('.lc-deckbtn'))$('.lc-deckbtn').click(); await wait(80);
  out.picker = /Deck you/i.test(($('.tf-panel')||{}).textContent||'');
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.registered && r.wrap && r.filter && r.body && r.feedRendered && r.deckBtn && r.picker && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
