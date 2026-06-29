// 2040 match tracker: the deck button shows no clipboard (a green ✓ appears only once a deck is picked),
// and after Start Match a "Quit Game" button sits at the bottom of the right-side button stack — pressing
// it opens a confirm dialog; confirming ends the match (back to Start Match) with nothing saved.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:520, height:820 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1300);

const r = await p.evaluate(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  mgLaunchApp('twentyfourty'); await wait(260);
  const out={};
  // 1) deck button: no clipboard emoji on the board button (unset → just "Deck")
  const dk=document.querySelector('.lc-deckbtn');
  out.deckBtn = dk ? dk.textContent.trim() : null;
  out.deckHasClipboard = !!(dk && dk.textContent.includes('📋'));
  // 2) start a match → Quit Game button appears, after the others (bottom of the right-side column)
  document.querySelector('[data-tf="start"]').click(); await wait(120);
  const track=[...document.querySelectorAll('.tf-track [data-tf]')].map(b=>b.getAttribute('data-tf'));
  out.trackOrder = track;
  out.quitPresent = track.includes('quit');
  out.quitIsLast = track[track.length-1]==='quit';
  // 3) press Quit → a confirm dialog (not an immediate quit)
  document.querySelector('[data-tf="quit"]').click(); await wait(100);
  const panel=document.querySelector('.tf-overlay .tf-panel');
  out.confirmShown = !!(panel && /quit/i.test(panel.textContent));
  out.stillActive = !!document.querySelector('[data-tf="quit"]'); // match not ended yet
  out.hasConfirmBtn = !!document.querySelector('.tf-overlay [data-quit]');
  // 4) confirm → match ends, back to Start Match
  document.querySelector('.tf-overlay [data-quit]').click(); await wait(140);
  out.backToStart = !!document.querySelector('[data-tf="start"]') && !document.querySelector('[data-tf="quit"]');
  return out; });

console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,3));
const ok = r.deckBtn && !r.deckHasClipboard && r.quitPresent && r.quitIsLast
  && r.confirmShown && r.stillActive && r.hasConfirmBtn && r.backToStart && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
