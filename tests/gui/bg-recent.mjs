// Display app → AI background → "Recent backgrounds" strip: lists the last 5 generated
// scenes (stubbed here), each downloadable, click sets it as the desktop background.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));}); p.on('pageerror',e=>errs.push('PE:'+e.message));
await p.route('**/api/splash/bg-recent', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({backgrounds:[
  {url:'/u/1/bg_aaa.png',ts:5},{url:'/u/1/bg_bbb.png',ts:4},{url:'/u/1/bg_ccc.png',ts:3},{url:'/u/1/bg_ddd.png',ts:2},{url:'/u/1/bg_eee.png',ts:1}]})}));
await p.route('**/u/1/bg_*.png', r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')}));
await p.goto('http://mymagicdeck.com/',{waitUntil:'domcontentloaded',timeout:30000});
await p.waitForTimeout(1500);
const res = await p.evaluate(async ()=>{
  state.user={username:'jake'}; try{ localStorage.setItem('mmd_token','tok'); }catch(e){}
  const div=document.createElement('div'); div.innerHTML=aiBgHtml(); document.body.appendChild(div);
  wireAiBg(div);
  await new Promise(r=>setTimeout(r,500));
  const tiles=[...div.querySelectorAll('#dbg-recent [data-bgurl]')];
  const dls=[...div.querySelectorAll('#dbg-recent a.dbg-dl')];
  const before=(typeof deskBgGet==='function'?deskBgGet():'');
  tiles[2] && tiles[2].click(); // set the 3rd
  await new Promise(r=>setTimeout(r,200));
  return { tileCount:tiles.length, dlCount:dls.length, dlHasDownload: dls[0]?dls[0].hasAttribute('download'):false,
    firstUrl: tiles[0]&&tiles[0].getAttribute('data-bgurl'), before, afterSet:(typeof deskBgGet==='function'?deskBgGet():'') };
});
console.log(JSON.stringify(res));
const ok = res.tileCount===5 && res.dlCount===5 && res.dlHasDownload && res.afterSet==='/u/1/bg_ccc.png';
console.log('RESULT:', ok?'PASS — 5 tiles, downloadable, click sets bg':'FAIL');
console.log('CONSOLE_ERRORS:', errs.length, errs.slice(0,5));
await b.close();
if(!ok || errs.length) process.exit(1);
