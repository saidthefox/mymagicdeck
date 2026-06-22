// Cardle (daily clue-reveal): a card template fills in as clues unlock; wrong guesses reveal more;
// solving reveals the real card. API is stubbed (the test container has no JWT secret).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:640, height:820 } })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
const IMG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const playing={ day:'2026-06-22', total:8, startClues:2, revealed:2, clues:['Color: Green','Mana value: 1'], guesses:[], solved:false, done:false, fill:{colors:['G'],cmc:1}, stats:{solved:0,avgClues:0,streak:0} };
const afterWrong={ day:'2026-06-22', total:8, startClues:2, revealed:3, clues:['Color: Green','Mana value: 1','Type: Creature'], guesses:['Llanowar Elves'], solved:false, done:false, fill:{colors:['G'],cmc:1,typeLine:'Creature'}, stats:{solved:0,avgClues:0,streak:0} };
const solved={ day:'2026-06-22', total:8, startClues:2, revealed:3, clues:['Color: Green','Mana value: 1','Type: Creature'], guesses:['Llanowar Elves','Arbor Adherent'], solved:true, done:true, fill:{colors:['G'],cmc:1,typeLine:'Creature',rarity:'uncommon',power:'2',toughness:'2',nameLen:13,first2:'Ar'}, answer:{name:'Arbor Adherent',type:'Creature — Elf',image:IMG}, stats:{solved:1,avgClues:3,streak:1} };
await p.route('**/api/cardle/state', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(playing)}));
let guessN=0;
await p.route('**/api/cardle/guess', r=>{ guessN++; r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(guessN===1?afterWrong:solved)}); });
await p.route('**/api/cards/search**', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{name:'Arbor Adherent'},{name:'Arbor Elf'}]})}));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);

const init = await p.evaluate(async()=>{ state.user={username:'jake'}; try{localStorage.setItem('mmd_token','x');}catch(e){} _cardle={st:null,busy:false};
  const d=document.createElement('div'); d.id='cdt'; document.body.appendChild(d); cardleRender(d); await new Promise(r=>setTimeout(r,300));
  const card=d.querySelector('.cdc-card');
  return { card:!!card, tinted: !!card && /background/.test(card.getAttribute('style')||''), pips:d.querySelectorAll('.cdc-pip').length, clues:d.querySelectorAll('.cd-clue').length, hasInput:!!d.querySelector('#cd-q'), nameUnknown:/\?/.test((d.querySelector('.cdc-name')||{}).textContent||'') }; });

const wrong = await p.evaluate(async()=>{ cardleGuess('Llanowar Elves'); await new Promise(r=>setTimeout(r,300));
  const d=document.getElementById('cdt'); return { clues:d.querySelectorAll('.cd-clue').length, typeFilled:/Creature/.test((d.querySelector('.cdc-type')||{}).textContent||'') }; });

const win = await p.evaluate(async()=>{ cardleGuess('Arbor Adherent'); await new Promise(r=>setTimeout(r,300));
  const d=document.getElementById('cdt'); return { win:!!d.querySelector('.cd-win'), art:!!d.querySelector('.cdc-art img'), name:(d.querySelector('.cdc-name')||{}).textContent, stats:/avg 3/.test((d.querySelector('.cd-stats')||{}).textContent||'') }; });

console.log('init:', JSON.stringify(init));
console.log('wrong:', JSON.stringify(wrong));
console.log('win:', JSON.stringify(win));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = init.card && init.tinted && init.pips>=1 && init.clues===2 && init.hasInput && init.nameUnknown
  && wrong.clues===3 && wrong.typeFilled
  && win.win && win.art && win.name==='Arbor Adherent' && win.stats
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
