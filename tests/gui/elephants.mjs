// Elephants (Land Game shell + Magic-style phases with player-set stops, local-only): haste 3/3 Darksteel
// War Elephants, lands are one-per-turn instant tricks, attack/target/block by clicking creatures, a phase
// bar on the centre line, and per-phase stops that give the opponent priority before that phase.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:900, height:740 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ const cg=document.getElementById('mguess-overlay'); if(cg){cg.classList.remove('open');cg.style.display='none';}
  mgLaunchApp('landgame'); await new Promise(r=>setTimeout(r,300));
  const out={}, $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
  const fresh=()=>{ _lgM.fmt='elephants'; lgStart('cpu'); _lg.view=0; }; // you=0 active, cpu=1
  // Menu
  _lg=null; _lgM.fmt='elephants'; lgRender(_lgBody); await new Promise(r=>setTimeout(r,40));
  out.fmtCard=!!$('[data-fmt="elephants"]'); out.hasCpu=!!$('#lg-cpu'); out.noOnline=!$('#lg-online');
  // Base state — starts at Main 1 (turn-1 draw auto-skipped), haste, named card, empty mana pip
  fresh(); await new Promise(r=>setTimeout(r,40));
  out.combat=_lg.combat===true; out.life=[_lg.players[0].life,_lg.players[1].life]; out.sick=[_lg.players[0].ele.sick,_lg.players[1].ele.sick];
  out.startPhase=_lg.phase; out.startMode=_lg.mode;
  out.cardName=!!($('.lg-ec-nm')&&/Darksteel War Elephant/.test($('.lg-ec-nm').textContent));
  out.cardKeywords=!!($('.lg-ec-tx')&&/Indestructible.*trample.*haste/i.test($('.lg-ec-tx').textContent));
  out.landText=!!($('.lg-bc-rules')&&/until end of turn|returns at end of turn|Draw a card/i.test([...$$('.lg-bc-rules')].map(e=>e.textContent).join(' ')));
  out.costEmpty=(($('.lg-ec-cost')||{}).textContent||'')==='';
  out.phaseCells=$$('.lg-ph').length; out.oneOn=$$('.lg-ph.on').length;
  lgToggleStop('block'); out.stopSet=!!(_lg.stops[0]&&_lg.stops[0].block); out.stopShown=$$('.lg-ph.stop').length>=1; lgToggleStop('block');
  // Attack → (cpu has no trick) → block → damage; no trample through 3/3
  fresh(); _lg.players[1].hand=[]; lgAdvance(); out.atkPhase=(_lg.phase==='attack'&&_lg.mode==='turn');
  lgAttack(); out.blockMode=(_lg.mode==='block'); lgDoBlock(true); out.dmgLife=_lg.players[1].life;
  // Stop: defender flags Block and holds a trick → gets priority before blocking
  fresh(); _lg.players[1].hand=['swamp']; _lg.stops[1]={block:true}; _lg.players[0].hand=[];
  lgAdvance(); lgAttack(); out.stopFires=(_lg.mode==='respond'&&_lg.priority===1);
  lgDoCast('swamp',0); out.afterStopTrick=(_lg.mode==='block'); lgDoBlock(true); out.stopLife=_lg.players[1].life;
  // Active player's own stop: attack → they block → I get a window at Damage to pump for trample
  fresh(); _lg.stops[0]={damage:true}; _lg.players[0].hand=['mountain']; _lg.players[1].hand=[];
  lgAdvance(); lgAttack(); out.oppBlockMode=(_lg.mode==='block'); lgDoBlock(true); // cpu blocks
  out.myDamageStop=(_lg.mode==='respond' && _lg.priority===0); // I get priority before my own combat damage
  lgDoCast('mountain',0); out.pumpTrample=_lg.players[1].life; // 6/3 over 3/3 → 3 tramples → 17
  // Win by life (unblocked lethal)
  fresh(); _lg.players[1].life=2; _lg.players[1].ele.tapped=true; _lg.players[0].hand=[]; _lg.players[1].hand=[];
  lgAdvance(); lgAttack(); out.winner=_lg.winner; out.over=_lg.mode;
  // Cast by arming a hand card then clicking a creature
  fresh(); _lg.players[0].hand=['mountain']; lgBeginCast('mountain'); out.armed=(_lg.pendingSpell==='mountain');
  lgClickEle(0); out.clickCast=(_lg.players[0].ele.dp===3 && _lg.spent[0]===true);
  // Full log renders (no last-N cap), with timestamps
  fresh(); for(let i=0;i<30;i++)_lg.log.push('event '+i); lgRerender();
  const logEl=$('.lg-log'); out.fullLog=!!(logEl && (logEl.innerHTML.match(/event /g)||[]).length===30);
  out.timestamped=/\d\d:\d\d:\d\d/.test((logEl||{}).textContent||'');
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = r.fmtCard && r.hasCpu && r.noOnline
  && r.combat && r.life[0]===20 && r.life[1]===20 && r.sick[0]===false && r.sick[1]===false
  && r.startPhase==='main1' && r.startMode==='turn'
  && r.cardName && r.cardKeywords && r.landText && r.costEmpty
  && r.phaseCells===7 && r.oneOn===1 && r.stopSet && r.stopShown
  && r.atkPhase && r.blockMode && r.dmgLife===20
  && r.stopFires && r.afterStopTrick && r.stopLife===20
  && r.oppBlockMode && r.myDamageStop && r.pumpTrample===17
  && r.winner===0 && r.over==='over'
  && r.armed && r.clickCast && r.fullLog && r.timestamped
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
