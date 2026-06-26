// Exodia screensaver: Dicey scatters REAL (mounted) program windows AROUND MyMagicDeck (left untouched),
// goes gold at the finale, and puts everything back (closes windows + reverts skin) when the user returns.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1240, height:820 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const site0 = await p.evaluate(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  if(!document.body.classList.contains('deckos'))deckosToggle(); await wait(300);
  const s=diceyState(); s.on=true; s.mode='all'; diceySave(s); diceyInit(); await wait(150);
  const r=wmWins.site&&wmWins.site.rect; const snap=r?{x:r.x,y:r.y,w:r.w,h:r.h}:null;
  diceyBeginSummon();
  return snap;
});
await p.waitForTimeout(8500);
const r = await p.evaluate((s0)=>{
  const out={ opened:(_summon?_summon.opened.length:0), summonActive:!!_summon };
  // real content mounted in the scattered windows (not empty shells)
  out.anyContent = Object.keys(wmWins).some(k=>{ if(k==='site')return false; const el=wmWins[k]&&wmWins[k].el; const bd=el&&el.querySelector('.modal-body'); return bd && bd.children.length>0; });
  // MyMagicDeck untouched
  const sr=wmWins.site&&wmWins.site.rect; out.siteUnmoved = !!(sr&&s0&&sr.x===s0.x&&sr.y===s0.y&&sr.w===s0.w&&sr.h===s0.h);
  out.wmDuring = Object.keys(wmWins).length;
  if(_summon) diceySummonFinale(); out.gold = document.body.classList.contains('theme-gold');
  diceyDesummon();
  out.afterGold = document.body.classList.contains('theme-gold'); out.summonNull=_summon===null; out.wmAfter=Object.keys(wmWins).length;
  return out;
}, site0);
console.log(JSON.stringify({site0, ...r}));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const ok = r.opened>=2 && r.summonActive && r.anyContent && r.siteUnmoved && r.gold && !r.afterGold && r.summonNull && r.wmAfter<r.wmDuring && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
