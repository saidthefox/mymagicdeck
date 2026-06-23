// The Land Game vs Computer: opponent hand stays hidden (card backs, never face-up types),
// the CPU takes its own turn after the human ends theirs, and a win renders the game-over banner.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+e.message));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);

// Settle to a state where it is the human's turn and they can act, clicking through any
// human-facing choice/priority prompts and waiting out CPU timers.
async function settleToHumanTurn(){
  for(let i=0;i<14;i++){
    const st=await p.evaluate(()=>{ const d=document.getElementById('lgtest'); const a=lgActor();
      if(_lg.winner!=null) return {over:true};
      if(a!==_lg.view) return {waiting:true};                                   // CPU acting — wait
      if(_lg.mode==='choose'){ d.querySelector('[data-pick]')?.click(); return {acted:true}; }
      if(_lg.mode==='respond'){ d.querySelector('#lg-pass')?.click(); return {acted:true}; }
      return {humanTurn:true, cast:_lg.castThisTurn };
    });
    if(st.over||st.humanTurn) return st;
    await p.waitForTimeout(800);
  }
  return {timeout:true};
}

const start = await p.evaluate(()=>{
  const div=document.createElement('div'); div.id='lgtest'; document.body.appendChild(div);
  lgRender(div); lgStart('cpu');
  return { hasBacks: !!div.querySelector('.lg-backs'), humanCards: div.querySelectorAll('[data-h]').length, cpu:_lg.cpu, view:_lg.view };
});

await settleToHumanTurn();
const t0 = await p.evaluate(()=>_lg.turn);
await p.evaluate(()=>{ document.getElementById('lgtest').querySelector('[data-h]')?.click(); }); // play a land
await settleToHumanTurn();                                                                              // resolve any human ETB choice
await p.evaluate(()=>{ document.getElementById('lgtest').querySelector('#lg-end')?.click(); });          // end turn → hand to CPU
await p.waitForTimeout(800);
const afterCpu = await settleToHumanTurn();                                                              // wait out the CPU's whole turn
const cpuState = await p.evaluate(()=>({ active:_lg.active, turn:_lg.turn, logHasCpu:_lg.log.some(l=>/\bComputer\b/.test(l)) }));

// Force a winning play for the human and confirm the game-over banner renders.
const win = await p.evaluate(()=>{
  _lg.players[0].field={plains:0,island:0,swamp:0,mountain:0,forest:4,wastes:0};
  _lg.players[1].hand=_lg.players[1].hand.filter(x=>x!=='island'); // CPU can't counter
  _lg.mode='turn'; _lg.active=0; _lg.view=0; _lg.castThisTurn=false; _lg.choice=null; _lg.stack=[];
  if(!_lg.players[0].hand.includes('forest'))_lg.players[0].hand[0]='forest';
  lgRerender(); lgCast('forest');
  return { mode:_lg.mode, winner:_lg.winner, bannerHasWins:/wins!/.test(document.getElementById('lgtest').innerText) };
});

console.log('start:', JSON.stringify(start));
console.log('cpuState:', JSON.stringify(cpuState), 't0:', t0);
console.log('win:', JSON.stringify(win));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = start.hasBacks && start.humanCards===5 && start.cpu===1 && start.view===0
  && cpuState.active===0 && cpuState.logHasCpu && cpuState.turn>t0
  && win.mode==='over' && win.winner===0 && win.bannerHasWins && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
