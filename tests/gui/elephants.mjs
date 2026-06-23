// Elephants format (Land Game + combat, local-only): playable in the menu (no Online button),
// each player has a 3/3 elephant + 20 life, P1 is summoning-sick turn 1, attacking deals 3,
// and dropping a player to 0 wins. Exercises the combat rules directly (no curtain/CPU timing).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:900, height:700 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  mgLaunchApp('landgame'); await new Promise(r=>setTimeout(r,300));
  const out={};
  // Menu: Elephants is a playable format, and Online is hidden for it (local-only).
  _lg=null; _lgM.fmt='elephants'; lgRender(_lgBody); await new Promise(r=>setTimeout(r,60));
  out.fmtCard=!!document.querySelector('[data-fmt="elephants"]');
  out.hasCpu=!!document.querySelector('#lg-cpu'); out.noOnline=!document.querySelector('#lg-online');
  // Start a local Elephants game (CPU is P2; it's P1's turn so the CPU stays idle while we inspect).
  lgStart('cpu'); await new Promise(r=>setTimeout(r,120));
  out.combat=_lg.combat===true; out.life=[_lg.players[0].life,_lg.players[1].life];
  out.sick=[_lg.players[0].ele.sick,_lg.players[1].ele.sick];
  out.t1NoAttackBtn=!document.querySelector('#lg-attack');   // P1 can't swing turn 1
  lgAttack(); out.sickBlocked=(_lg.players[1].life===20);    // sick elephant deals nothing
  _lg.players[0].ele.sick=false; _lg.attackedThisTurn=false; lgAttack(); out.afterSwing=_lg.players[1].life; // 17
  _lg.players[1].life=2; _lg.attackedThisTurn=false; lgAttack(); out.winner=_lg.winner; out.over=_lg.mode;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.fmtCard && r.hasCpu && r.noOnline
  && r.combat && r.life[0]===20 && r.life[1]===20 && r.sick[0]===true && r.sick[1]===false
  && r.t1NoAttackBtn && r.sickBlocked && r.afterSwing===17 && r.winner===0 && r.over==='over'
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
