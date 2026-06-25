// Theme system: 5 skins (dark/light/glass/emerald/gold). Each toggles the body class and remaps the
// chrome token --ch-face to a distinct value; the System Settings picker exposes all 5.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:1100, height:740 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1400);
const r = await p.evaluate(()=>{
  const face=()=>getComputedStyle(document.body).getPropertyValue('--ch-face').trim();
  const out={ picker:(typeof displaySettingsHtml==='function')?(displaySettingsHtml().match(/data-themepick="/g)||[]).length:0, themes:{} };
  ['dark','light','glass','emerald','gold'].forEach(t=>{
    themeSet(t);
    const cls = t==='dark' ? !/theme-(light|glass|emerald|gold)/.test(document.body.className)
                           : document.body.classList.contains('theme-'+t);
    out.themes[t] = { cls, face: face() };
  });
  out.persist = (window.DeckOS&&DeckOS.store.get('theme'))||localStorage.getItem('mmd_theme');
  themeSet('dark');
  return out;
});
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
const T=r.themes||{};
const faces=['dark','light','glass','emerald','gold'].map(k=>T[k]&&T[k].face);
const allClsOk=['dark','light','glass','emerald','gold'].every(k=>T[k]&&T[k].cls);
const distinct=new Set(faces).size; // glass/emerald/gold each remap --ch-face; dark/light share win95 grey
const ok = r.picker===5 && allClsOk && distinct>=4 && T.glass.face!==T.dark.face
  && T.emerald.face!==T.dark.face && T.gold.face!==T.dark.face
  && ['dark','light','glass','emerald','gold'].includes(r.persist) && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
