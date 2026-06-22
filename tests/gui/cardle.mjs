// Cardle (daily Magic-card Wordle): feedback grid with per-attribute colour coding + hi/lo arrows,
// name autocomplete, and the win reveal. API is stubbed (the test container has no JWT secret).
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{ width:520, height:760 } });
const p = await ctx.newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+(e.message||e)));
const playing={ day:'2026-06-22', max:8, n:1, done:false, solved:false, stats:{played:3,solved:2,solvePct:67,avgGuesses:3.5,streak:1},
  guesses:[ { name:'Llanowar Elves', correct:false, cmc:{v:1,cmp:'hi'}, colors:{v:['G'],m:'exact'}, type:{v:'Creature',m:'exact'}, rarity:{v:'common',cmp:'hi'}, power:{v:1,cmp:'hi'}, toughness:{v:1,cmp:'hi'} } ] };
const won={ day:'2026-06-22', max:8, n:2, done:true, solved:true, answer:{ name:'Arbor Adherent', image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  stats:{played:4,solved:3,solvePct:75,avgGuesses:3,streak:2}, guesses:[ playing.guesses[0], { name:'Arbor Adherent', correct:true, cmc:{v:2,cmp:'eq'}, colors:{v:['G'],m:'exact'}, type:{v:'Creature',m:'exact'}, rarity:{v:'uncommon',cmp:'eq'}, power:{v:2,cmp:'eq'}, toughness:{v:2,cmp:'eq'} } ] };
await p.route('**/api/cardle/state', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(playing)}));
await p.route('**/api/cardle/guess', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(won)}));
await p.route('**/api/cards/search**', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{name:'Arbor Adherent'},{name:'Arbor Elf'},{name:'Arborback Stomper'}]})}));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const init = await p.evaluate(async()=>{ state.user={username:'jake'}; try{localStorage.setItem('mmd_token','x');}catch(e){} _cardle={st:null,busy:false};
  const d=document.createElement('div'); d.id='cdt'; document.body.appendChild(d); cardleRender(d); await new Promise(r=>setTimeout(r,300));
  return { rows:d.querySelectorAll('.cd-grid .cd-row:not(.cd-head)').length, ok:d.querySelectorAll('.cd-cell.ok').length, near:d.querySelectorAll('.cd-cell.near').length, hasInput:!!d.querySelector('#cd-q'), arrows:d.querySelectorAll('.cd-ar').length, stats:/avg 3.5/.test(d.querySelector('.cd-stats').textContent) }; });
// autocomplete + guess → win reveal
const win = await p.evaluate(async()=>{ const d=document.getElementById('cdt'); const q=d.querySelector('#cd-q'); q.value='arbor'; q.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,350)); const sugg=d.querySelectorAll('#cd-sugg [data-nm]').length;
  cardleGuess('Arbor Adherent'); await new Promise(r=>setTimeout(r,300));
  return { sugg, win:!!d.querySelector('.cd-win'), answerImg:!!d.querySelector('.cd-answer img'), aname:(d.querySelector('.cd-aname')||{}).textContent }; });
console.log('init:', JSON.stringify(init));
console.log('win:', JSON.stringify(win));
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
const ok = init.rows===1 && init.ok>=2 && init.near>=1 && init.hasInput && init.arrows>=1 && init.stats
  && win.sugg>=3 && win.win && win.answerImg && win.aname==='Arbor Adherent' && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
