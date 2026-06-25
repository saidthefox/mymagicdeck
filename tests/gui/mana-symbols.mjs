// Mana costs render as Scryfall's official card-symbol SVGs (with text-pip fallback on error).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:700, height:400 } })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e.message||e)));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1200);
const r = await p.evaluate(async()=>{
  const html = parseMana('{2}{W}{U}{B/R}{T}');
  const out = {
    count: (html.match(/<img class="ms"/g)||[]).length,
    urls: [...html.matchAll(/card-symbols\/([^.]+)\.svg/g)].map(m=>m[1]),
    hasFallback: html.includes('onerror="manaImgFail'),
  };
  out.loaded = await new Promise(res=>{ const i=new Image(); i.onload=()=>res(i.naturalWidth>0); i.onerror=()=>res(false); i.src='https://svgs.scryfall.io/card-symbols/R.svg'; setTimeout(()=>res('timeout'),6000); });
  // visual: drop a row of real costs into the page
  const d=document.createElement('div'); d.id='ms-demo'; d.style.cssText='position:fixed;top:20px;left:20px;font-size:22px;background:#161b2e;color:#eee;padding:16px;border-radius:8px;z-index:99999';
  d.innerHTML='Lightning Bolt '+parseMana('{R}')+' &nbsp; Cryptic Command '+parseMana('{1}{U}{U}{U}')+' &nbsp; '+parseMana('{2}{W}{B/R}{X}{T}');
  document.body.appendChild(d); await new Promise(r=>setTimeout(r,1200));
  return out;
});
console.log(JSON.stringify(r));
console.log('PAGE_ERRORS:', errs.length, errs.slice(0,4));
await p.screenshot({ path:'/work/tests/gui/shots/mana-symbols.png', clip:{x:0,y:0,width:700,height:120} });
const ok = r.count===5 && JSON.stringify(r.urls)===JSON.stringify(['2','W','U','BR','T']) && r.hasFallback && r.loaded===true && !errs.length;
console.log('RESULT:', ok?'PASS':'FAIL');
await b.close();
if(!ok) process.exit(1);
