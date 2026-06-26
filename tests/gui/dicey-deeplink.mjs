// ?dicey=<id> escort: friendly-name resolver (basics→landgame), Dicey moves, opens Deck OS, opens the program.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:740 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/?dicey=basics',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1300);
const pos1 = await p.evaluate(()=>{ const e=(typeof _diceyEl!=='undefined')&&_diceyEl; return e?{x:e.getBoundingClientRect().left,y:e.getBoundingClientRect().top}:null; });
await p.waitForTimeout(4000);
const r = await p.evaluate(()=>{ const e=(typeof _diceyEl!=='undefined')&&_diceyEl; const rc=e&&e.getBoundingClientRect();
  return { dicey:!!e, deckos:document.body.classList.contains('deckos'), openedLandgame:!!document.getElementById('modal-prog-landgame'), pos2: rc?{x:rc.left,y:rc.top}:null }; });
console.log(JSON.stringify({pos1, ...r}));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const moved = pos1 && r.pos2 && (Math.abs(pos1.x-r.pos2.x)>5 || Math.abs(pos1.y-r.pos2.y)>5);
const ok = r.dicey && r.deckos && r.openedLandgame && moved && !errs.length;
console.log('moved:', moved, 'RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
