// Exodia screensaver: on desktop, Dicey tiles programs next to MyMagicDeck, goes gold at the finale, and
// puts EVERYTHING back (closes windows + reverts skin) when the user returns.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1240, height:820 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
await p.evaluate(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  if(!document.body.classList.contains('deckos'))deckosToggle(); await wait(300);
  const s=diceyState(); s.on=true; s.mode='all'; diceySave(s); diceyInit(); await wait(150);
  diceyBeginSummon();
});
await p.waitForTimeout(8500);
const r = await p.evaluate(()=>{
  const out={ wmDuring:Object.keys(wmWins).length, opened:(_summon?_summon.opened.length:0), summonActive:!!_summon };
  if(_summon) diceySummonFinale();
  out.gold = document.body.classList.contains('theme-gold');
  diceyDesummon();
  out.afterGold = document.body.classList.contains('theme-gold');
  out.summonNull = _summon===null;
  out.wmAfter = Object.keys(wmWins).length;
  return out;
});
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.opened>=2 && r.summonActive && r.gold && !r.afterGold && r.summonNull && r.wmAfter < r.wmDuring && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
