// Exodia "special summon" screensaver is DISABLED: diceyCanSummon() returns false and diceyBeginSummon()
// is a no-op — Dicey never scatters windows or goes gold. (Re-enable by removing the early return in
// diceyCanSummon; if you do, restore the original behavioural assertions here.)
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1240, height:820 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  if(!document.body.classList.contains('deckos'))deckosToggle(); await wait(300);
  const s=diceyState(); s.on=true; s.mode='all'; diceySave(s); diceyInit(); await wait(150);
  const wmBefore=Object.keys(wmWins).length;
  const canSummon=diceyCanSummon();
  diceyBeginSummon(); await wait(1500);   // should do nothing
  return { canSummon, summonActive:!!_summon, wmBefore, wmAfter:Object.keys(wmWins).length, gold:document.body.classList.contains('theme-gold') };
});
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.canSummon===false && !r.summonActive && r.wmAfter===r.wmBefore && !r.gold && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
