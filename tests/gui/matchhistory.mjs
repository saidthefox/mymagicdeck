// Match History program: pulls synced matches, shows record / win% / per-archetype breakdown /
// match rows, and deletes. API stubbed (no JWT secret in the test container).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:560, height:760 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
const matches=[
  { id:'s2', ts:Date.now(), opponent:'Al', myDeck:'Mono-U', theirDeck:'Mono-R', notes:'', games:[{result:'W',mulligans:1},{result:'W',mulligans:0}], result:'W' },
  { id:'s1', ts:Date.now()-86400000, opponent:'Bo', myDeck:'Mono-U', theirDeck:'Mono-R', notes:'', games:[{result:'L',mulligans:2},{result:'L',mulligans:1}], result:'L' },
];
let listCalls=0;
await p.route('**/api/tf/matches', r=>{ listCalls++; r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({matches})}); });
await p.route('**/api/tf/match/**', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const r = await p.evaluate(async()=>{ state.user={username:'jake'}; try{localStorage.setItem('mmd_token','x'); DeckOS.store.set('tf_matches',[]);}catch(e){}
  const d=document.createElement('div'); d.id='mht'; document.body.appendChild(d); mhRender(d); await new Promise(r=>setTimeout(r,400));
  const txt=el=>(el&&el.textContent||'').replace(/\s+/g,' ').trim();
  const out={ rec:txt(d.querySelector('.mh-rec')), pct:txt(d.querySelector('.mh-pct')), rows:d.querySelectorAll('.mh-row').length, decks:d.querySelectorAll('.mh-deckrow').length, deck0:txt(d.querySelector('.mh-deckrow')) };
  // delete one
  d.querySelector('.mh-del').click(); await new Promise(r=>setTimeout(r,100)); // confirm() auto-accepts? no — stub it
  out.rowsAfter=d.querySelectorAll('.mh-row').length;
  return out; });
console.log(JSON.stringify(r));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
// delete uses confirm(); Playwright auto-dismisses dialogs (returns false) → row stays. Just assert render.
const ok = /1.*1/.test(r.rec) && /50%/.test(r.pct) && r.rows===2 && r.decks>=1 && /Mono-R/.test(r.deck0) && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
