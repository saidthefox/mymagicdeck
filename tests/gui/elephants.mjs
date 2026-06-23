// Elephants (Land Game shell + shortened-Magic combat, local-only): haste 3/3 Darksteel War Elephants,
// lands are one-per-turn instant-style combat tricks, attack/target/block by clicking creatures, and a
// bounded priority system (a "stop" is offered only while a player still has their one spell).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:900, height:720 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  mgLaunchApp('landgame'); await new Promise(r=>setTimeout(r,300));
  const out={}, $=s=>document.querySelector(s);
  const fresh=()=>{ _lgM.fmt='elephants'; lgStart('cpu'); _lg.view=0; }; // you=0, cpu=1, your turn
  // Menu
  _lg=null; _lgM.fmt='elephants'; lgRender(_lgBody); await new Promise(r=>setTimeout(r,40));
  out.fmtCard=!!$('[data-fmt="elephants"]'); out.hasCpu=!!$('#lg-cpu'); out.noOnline=!$('#lg-online');
  // Base state: haste, 20 life, named card with keywords
  fresh(); await new Promise(r=>setTimeout(r,40));
  out.combat=_lg.combat===true; out.life=[_lg.players[0].life,_lg.players[1].life]; out.sick=[_lg.players[0].ele.sick,_lg.players[1].ele.sick];
  out.cardName=!!($('.lg-ec-nm')&&/Darksteel War Elephant/.test($('.lg-ec-nm').textContent));
  out.cardKeywords=!!($('.lg-ec-tx')&&/Indestructible.*trample.*haste/i.test($('.lg-ec-tx').textContent));
  out.landText=!!($('.lg-bc-rules')&&/until end of turn|returns at end of turn|Draw a card/i.test([...document.querySelectorAll('.lg-bc-rules')].map(e=>e.textContent).join(' ')));
  // Click your elephant to attack (no Attack button)
  out.noAttackBtn=!$('#lg-attack');
  _lg.players[1].hand=[]; lgClickEle(0); out.clickAttacked=(!!_lg.atk && _lg.atk.by===0 && _lg.mode==='block'); // defender has no trick → straight to block
  // Defender gets a stop BEFORE blocking (combat trick), then blocks
  fresh(); _lg.players[1].hand=['swamp']; _lg.players[0].hand=[]; lgAttack();
  out.defenderStop=(_lg.mode==='respond' && _lg.priority===1);
  lgDoCast('swamp',0); out.afterDefTrick=(_lg.mode==='block'); // their trick resolved, I had no response → block step
  lgDoBlock(true); out.defBlockedLife=_lg.players[1].life;
  // Attacker gets a stop AFTER the block is declared
  fresh(); _lg.players[0].hand=['mountain']; _lg.players[1].hand=[]; lgAttack();
  out.noDefenderStop=(_lg.mode==='block'); // defender has no spell → no stop, straight to block
  lgDoBlock(true); out.attackerStop=(_lg.mode==='respond' && _lg.priority===0);
  lgDoCast('mountain',0); out.trample=_lg.players[1].life; // 6/3 over a 3/3 → 3 tramples → 17
  // No stop once a player has spent their one spell
  fresh(); _lg.players[1].hand=['swamp']; _lg.spent[1]=true; lgAttack(); out.spentNoStop=(_lg.mode==='block');
  // Cast by arming a hand card then clicking a creature
  fresh(); _lg.players[0].hand=['mountain']; lgBeginCast('mountain'); out.armed=(_lg.pendingSpell==='mountain');
  lgClickEle(0); out.clickTargeted=(_lg.players[0].ele.dp===3 && _lg.spent[0]===true);
  // Win by life (unblocked swing for lethal)
  fresh(); _lg.players[1].life=2; _lg.players[1].ele.tapped=true; _lg.players[0].hand=[]; _lg.players[1].hand=[]; lgAttack();
  out.winner=_lg.winner; out.over=_lg.mode;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.fmtCard && r.hasCpu && r.noOnline
  && r.combat && r.life[0]===20 && r.life[1]===20 && r.sick[0]===false && r.sick[1]===false
  && r.cardName && r.cardKeywords && r.landText && r.noAttackBtn && r.clickAttacked
  && r.defenderStop && r.afterDefTrick && r.defBlockedLife===20
  && r.noDefenderStop && r.attackerStop && r.trample===17
  && r.spentNoStop && r.armed && r.clickTargeted
  && r.winner===0 && r.over==='over'
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
