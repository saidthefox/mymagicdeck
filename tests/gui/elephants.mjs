// Elephants (Land Game shell + combat, local-only): lands are one-per-turn instant-style spells that
// target a creature; the 3/3 indestructible elephants attack the face, the defender may block, and
// trample carries the excess. P1 is summoning-sick turn 1; win by dropping the opponent to 0 life.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:900, height:700 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  mgLaunchApp('landgame'); await new Promise(r=>setTimeout(r,300));
  const out={}; const $=s=>document.querySelector(s);
  // Menu: Elephants is playable, Online hidden (local-only).
  _lg=null; _lgM.fmt='elephants'; lgRender(_lgBody); await new Promise(r=>setTimeout(r,60));
  out.fmtCard=!!$('[data-fmt="elephants"]'); out.hasCpu=!!$('#lg-cpu'); out.noOnline=!$('#lg-online');
  // Start a local game (CPU is P2; it's P1's turn, so the CPU stays idle while we drive P1).
  lgStart('cpu'); await new Promise(r=>setTimeout(r,80));
  out.combat=_lg.combat===true; out.life=[_lg.players[0].life,_lg.players[1].life];
  out.sick=[_lg.players[0].ele.sick,_lg.players[1].ele.sick];
  out.t1NoAttackBtn=!$('#lg-attack');                                  // P1 summoning-sick turn 1
  // Cast a "land" (Mountain) as an instant — it should ask for a target, then pump +3/+0.
  _lg.players[0].hand=['mountain','island','wastes','swamp','plains']; _lg.castThisTurn=false;
  lgCast('mountain');
  out.targetPrompt=(_lg.mode==='choose' && _lg.choice && _lg.choice.kind==='target');
  lgPick('me');
  out.pump={ dp:_lg.players[0].ele.dp, pow:lgElePow(_lg.players[0].ele), cast:_lg.castThisTurn, gy:_lg.players[0].gy.includes('mountain') };
  // Attack into a possible block: 6/3 attacker, blocker 3/3 → 3 tramples over.
  _lg.players[0].ele.sick=false; _lg.players[0].ele.tapped=false; _lg.attackedThisTurn=false;
  lgAttack();
  out.blockPrompt=(_lg.mode==='choose' && _lg.choice && _lg.choice.kind==='block');
  lgPick('block'); out.trample=_lg.players[1].life;                    // 20 - (6-3) = 17
  // Unblocked: tap the defender so it can't block → full 6 to the face.
  _lg.players[1].ele.tapped=true; _lg.players[0].ele.tapped=false; _lg.attackedThisTurn=false;
  lgAttack(); out.unblocked=_lg.players[1].life;                       // 17 - 6 = 11 (resolves immediately, no prompt)
  // Flying is unblockable by a grounded elephant.
  _lg.players[1].ele.tapped=false; _lg.players[0].ele.tapped=false; _lg.players[0].ele.flying=true; _lg.attackedThisTurn=false;
  lgAttack(); out.flyingThrough=(_lg.players[1].life===5 && _lg.mode!=='choose'); // 11 - 6 = 5, no block prompt
  // End of turn: the +3/+0 (and flying) wear off.
  lgEndTurn(); out.buffWoreOff=(_lg.players[0].ele.dp===0 && _lg.players[0].ele.flying===false);
  // Win by life: drop the opponent to 0.
  _lg.active=0; _lg.players[0].ele={dp:0,dt:0,flying:false,tapped:false,sick:false,exiled:false}; _lg.players[1].life=2; _lg.attackedThisTurn=false;
  lgResolveCombat(0,false); out.winner=_lg.winner; out.over=_lg.mode;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.fmtCard && r.hasCpu && r.noOnline
  && r.combat && r.life[0]===20 && r.life[1]===20 && r.sick[0]===true && r.sick[1]===false && r.t1NoAttackBtn
  && r.targetPrompt && r.pump.dp===3 && r.pump.pow===6 && r.pump.cast===true && r.pump.gy
  && r.blockPrompt && r.trample===17 && r.unblocked===11 && r.flyingThrough
  && r.buffWoreOff && r.winner===0 && r.over==='over'
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
