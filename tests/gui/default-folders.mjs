// New users get default app-folder bubbles: Games / Sites / Comms / Counters with the right programs.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:760 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(()=>{
  DeckOS.store.remove('appfolders'); DeckOS.store.remove('appfolders_seeded');   // simulate a brand-new user
  mgSeedDefaultFolders();
  const f = mgAppFolders(); const by = n => (f.find(x=>x.name===n)||{}).apps||[];
  const out = { count:f.length, names:f.map(x=>x.name),
    games:by('Games'), sites:by('Sites'), comms:by('Comms'), counters:by('Counters') };
  mgSeedDefaultFolders();                                                         // must be a no-op now (flag set)
  out.afterReseed = mgAppFolders().length;
  return out; });
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const ok = r.count===4 && r.afterReseed===4
  && eq(r.names,['Comms','Counters','Games','Sites'])
  && eq(r.games,['landgame','battle','cgg'])
  && eq(r.sites,['web-stonesmtg','web-mtgtop8'])
  && eq(r.comms,['calendar','tournaments','mail'])
  && eq(r.counters,['manapool','twentyfourty','dicebag'])
  && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
