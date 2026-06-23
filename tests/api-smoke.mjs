#!/usr/bin/env node
// API smoke tests — exercise the real endpoints. Designed to run INSIDE the
// mymagicdeck-api container (has fetch + better-sqlite3 + DB_PATH), e.g.:
//   docker cp tests/api-smoke.mjs mymagicdeck-api:/tmp/ && docker exec mymagicdeck-api node /tmp/api-smoke.mjs
// Override the target with BASE=... if running elsewhere.
const BASE = process.env.BASE || 'http://localhost:3002/api';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let fails = 0;
const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); fails++; };
const assert = (c, m) => c ? ok(m) : fail(m);
const J = (p, opt) => fetch(BASE + p, opt).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

console.log('api-smoke: ' + BASE);

try {
  const h = await J('/health');
  assert(h.status === 200 && h.body && h.body.ok, 'GET /health → ok');

  const s = await J('/cards/search?q=' + encodeURIComponent('Lightning Bolt') + '&page=1&per_page=5');
  const names = (s.body && s.body.data || []).map(c => c.name);
  assert(s.status === 200 && names.includes('Lightning Bolt'), 'GET /cards/search finds "Lightning Bolt"');

  // Partial / prefix search: typing part of a name finds it.
  const sp = await J('/cards/search?q=' + encodeURIComponent('Lightning B') + '&per_page=8');
  assert(sp.status === 200 && (sp.body.data || []).some(c => c.name === 'Lightning Bolt'), 'partial search "Lightning B" finds Lightning Bolt');

  // Guest AI analysis is open but strictly rate-limited (429 within a few calls).
  let analyze429 = false;
  for (let i = 0; i < 7; i++) {
    const r = await J('/splash/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deckName: 't', cards: [{ n: 'Forest', q: 1 }] }) });
    if (r.status === 429) { analyze429 = true; break; }
  }
  assert(analyze429, 'guest /splash/analyze is strictly rate-limited (429)');

  const g = await J('/cards/guess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color: 'R', cmc: 1, type: 'Instant' }) });
  assert(g.status === 200 && Array.isArray(g.body.candidates) && g.body.candidates.length > 0, 'POST /cards/guess returns candidates');

  // --- Card Duel battle flow ---
  const c = await J('/battle/create', { method: 'POST' });
  const code = c.body && c.body.code, t1 = c.body && c.body.token;
  assert(c.status === 200 && code && t1 && c.body.state.status === 'waiting', 'POST /battle/create → room (waiting)');

  const jn = await J('/battle/' + code + '/join', { method: 'POST' });
  const t2 = jn.body && jn.body.token;
  assert(jn.status === 200 && t2 && jn.body.state.status === 'playing', 'POST /battle/:code/join → playing');

  const rv = await J('/battle/' + code + '/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t1 }) });
  assert(rv.status === 200 && rv.body.revealed === 2, 'POST /battle/:code/reveal advances clue');

  const wrong = await J('/battle/' + code + '/guess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t2, guess: 'zzzz not a card' }) });
  assert(wrong.status === 200 && wrong.body.correct === false && wrong.body.state.status === 'playing', 'wrong guess → not correct, still playing');

  const nope = await J('/battle/' + code + '/guess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bogus', guess: 'x' }) });
  assert(nope.status === 403, 'guess with bad token → 403');

  // Peek the answer (we're in the container) to test the correct path.
  let answer = null;
  try { const db = require('better-sqlite3')(process.env.DB_PATH || '/data/mymagicdeck.db'); answer = db.prepare('SELECT target_name FROM battles WHERE code=?').get(code).target_name; } catch (_) {}
  if (answer) {
    const right = await J('/battle/' + code + '/guess', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t1, guess: answer }) });
    assert(right.status === 200 && right.body.correct === true && right.body.state.winner === 0 && right.body.state.target.name === answer, 'correct guess → win + answer revealed');
  } else { console.log('  (skipped correct-guess assert: no DB access)'); }

  const nf = await J('/battle/ZZZZZ');
  assert(nf.status === 404, 'GET unknown room → 404');

  // --- error monitoring ---
  const cl = await J('/clientlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'smoke-test-error', stack: 'x', url: 'test' }) });
  assert(cl.status === 200 && cl.body && cl.body.ok, 'POST /clientlog accepts a client error');
  const ak = process.env.ADMIN_API_KEY;
  if (ak) {
    const ae = await J('/admin/errors', { headers: { 'x-admin-key': ak } });
    assert(ae.status === 200 && Array.isArray(ae.body.errors) && ae.body.errors.some(e => e.message === 'smoke-test-error'), 'GET /admin/errors lists logged errors');
    const noauth = await J('/admin/errors');
    assert(noauth.status === 503 || noauth.status === 403, 'GET /admin/errors without key is blocked');
  } else { console.log('  (skipped admin/errors assert: no ADMIN_API_KEY)'); }

  // --- Basics — The Land Game: online PvP ---
  const crypto = require('crypto'); const SEC = process.env.JWT_SECRET;
  if (SEC) {
    const tok = (sub, username) => { const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url'); const p = Buffer.from(JSON.stringify({ sub, username, iat: Math.floor(Date.now()/1000) })).toString('base64url'); return h+'.'+p+'.'+crypto.createHmac('sha256', SEC).update(h+'.'+p).digest('base64url'); };
    const A = tok(990001, 'smoke_A'), B = tok(990002, 'smoke_B'), C = tok(990003, 'smoke_C');
    const Ja = (p, opt, t) => fetch(BASE + p, { ...opt, headers: { ...(opt && opt.body ? { 'content-type':'application/json' } : {}), ...(t ? { authorization:'Bearer '+t } : {}) } }).then(async r => ({ status:r.status, body: await r.json().catch(()=>null) }));
    const cr = await Ja('/lg/create', { method:'POST', body: JSON.stringify({ format:'land', clock:'corr' }) }, A);
    const code = cr.body && cr.body.code;
    assert(cr.status === 200 && code, 'POST /lg/create → match code');
    const jn2 = await Ja('/lg/join', { method:'POST', body: JSON.stringify({ code }) }, B);
    assert(jn2.status === 200 && jn2.body.seat === 1 && jn2.body.state, 'POST /lg/join → seat 1 + state');
    assert(jn2.body.state.players[0].hand.every(x => x === '?'), 'join: opponent hand is redacted (hidden)');
    const ga = await Ja('/lg/' + code, null, A);
    assert(ga.status === 200 && ga.body.seat === 0 && ga.body.state.players[0].hand.some(x => x !== '?') && ga.body.state.players[1].hand.every(x => x === '?'), 'GET /lg/:code → own hand real, opponent hidden');
    const intruder = await Ja('/lg/' + code, null, C);
    assert(intruder.status === 403, 'GET /lg/:code by non-participant → 403');
    const t0 = ga.body.state.players[0].hand.find(x => x !== 'swamp') || ga.body.state.players[0].hand[0]; // avoid Swamp (opens an opponent-discard choice, so the turn wouldn't auto-end yet)
    const mv = await Ja('/lg/' + code + '/move', { method:'POST', body: JSON.stringify({ move:{ type:'play', value:t0 } }) }, A);
    assert(mv.status === 200 && mv.body.state.mode === 'respond' && mv.body.state.priority === 1, 'POST /lg/:code/move play → defender gets a response window');
    const pass = await Ja('/lg/' + code + '/move', { method:'POST', body: JSON.stringify({ move:{ type:'pass' } }) }, B);
    assert(pass.status === 200 && pass.body.state.turn === 2 && pass.body.state.active === 1, 'pass → land resolves and turn auto-ends');
    const wrongTurn = await Ja('/lg/' + code + '/move', { method:'POST', body: JSON.stringify({ move:{ type:'play', value:'plains' } }) }, A);
    assert(wrongTurn.status === 400, 'move out of turn → 400');
    const st = await Ja('/lg/stats', null, A);
    assert(st.status === 200 && typeof st.body.total === 'number', 'GET /lg/stats → totals');
    // matchmaking: two distinct users at same TC pair up
    const D = tok(990004, 'smoke_D'), E = tok(990005, 'smoke_E');
    const q1 = await Ja('/lg/queue', { method:'POST', body: JSON.stringify({ format:'land', clock:'1m' }) }, D);
    const q2 = await Ja('/lg/queue', { method:'POST', body: JSON.stringify({ format:'land', clock:'1m' }) }, E);
    assert(q1.body.queued === true && q2.body.matched === true && q2.body.code, 'matchmaking: second player pairs with the first');
    await Ja('/lg/queue', { method:'DELETE' }, D);

    // --- Cardle (daily card guess) ---
    const F = tok(990600 + Math.floor(Math.random() * 9000), 'smoke_F'); // unique each run → fresh game
    const cst = await Ja('/cardle/state', null, F);
    assert(cst.status === 200 && cst.body.startClues >= 1 && cst.body.startClues <= 3 && cst.body.revealed === cst.body.startClues && !cst.body.answer, 'GET /cardle/state → 1–3 start clues, answer hidden');
    const cw = await Ja('/cardle/guess', { method:'POST', body: JSON.stringify({ name:'Llanowar Elves' }) }, F);
    assert(cw.status === 200 && cw.body.revealed > cst.body.revealed && cw.body.guesses.length === 1 && !cw.body.done, 'wrong guess → reveals one more clue');
    const cbad = await Ja('/cardle/guess', { method:'POST', body: JSON.stringify({ name:'zzzz not a card' }) }, F);
    assert(cbad.status === 404, 'cardle guess of unknown card → 404');
    let cans = null; try { const cdb = require('better-sqlite3')(process.env.DB_PATH || '/data/mymagicdeck.db', { readonly:true }); const o = cdb.prepare('SELECT oracle_id FROM cardle_daily WHERE day=?').get(cst.body.day); cans = cdb.prepare('SELECT name FROM cards WHERE oracle_id=?').get(o.oracle_id).name; } catch (_) {}
    if (cans) {
      const cc = await Ja('/cardle/guess', { method:'POST', body: JSON.stringify({ name: cans }) }, F);
      assert(cc.status === 200 && cc.body.solved && cc.body.done && cc.body.answer && cc.body.answer.name === cans, 'correct guess → solved + answer revealed');
      assert(cc.body.stats && cc.body.stats.solved >= 1 && typeof cc.body.stats.avgClues === 'number', 'cardle stats track avgClues');
    } else { console.log('  (skipped cardle correct-guess assert: no DB access)'); }

    // --- 2040 match history (server sync) ---
    const G = tok(990700 + Math.floor(Math.random()*9000), 'smoke_G'), H2 = tok(990800 + Math.floor(Math.random()*9000), 'smoke_H');
    const tfm = { ts: Date.now(), opponent:'Bob', myDeck:'Mono-U', theirDeck:'Mono-R', notes:'gg', games:[{result:'W',mulligans:1},{result:'L',mulligans:0},{result:'W',mulligans:2}], result:'W' };
    const tfAdd = await Ja('/tf/match', { method:'POST', body: JSON.stringify(tfm) }, G);
    assert(tfAdd.status === 200 && tfAdd.body.id, 'POST /tf/match → id');
    const tfList = await Ja('/tf/matches', null, G);
    assert(tfList.status === 200 && tfList.body.matches.length >= 1 && tfList.body.matches[0].opponent === 'Bob' && tfList.body.matches[0].games.length === 3, 'GET /tf/matches → my match');
    const tfOther = await Ja('/tf/matches', null, H2);
    assert(tfOther.status === 200 && tfOther.body.matches.length === 0, 'tf history is per-account (isolated)');
    const tfBad = await Ja('/tf/match', { method:'POST', body: JSON.stringify({ games:[] }) }, G);
    assert(tfBad.status === 400, 'POST /tf/match with no games → 400');
    const tfDel = await Ja('/tf/match/' + tfAdd.body.id, { method:'DELETE' }, G);
    const tfAfter = await Ja('/tf/matches', null, G);
    assert(tfDel.status === 200 && tfAfter.body.matches.length === 0, 'DELETE /tf/match removes it');
    const tfNoAuth = await Ja('/tf/matches', null, null);
    assert(tfNoAuth.status === 401, 'GET /tf/matches without auth → 401');

    // --- 2040 LIVE (shared match between two accounts) ---
    const LH = tok(991000+Math.floor(Math.random()*9000),'live_host'), LG = tok(991100+Math.floor(Math.random()*9000),'live_guest'), LX = tok(991200+Math.floor(Math.random()*9000),'live_x');
    const lc = await Ja('/tf/live', { method:'POST', body: JSON.stringify({ myDeck:'Mono-U' }) }, LH);
    assert(lc.status === 200 && lc.body.code && lc.body.status === 'open' && lc.body.role === 'host', 'POST /tf/live → open match as host');
    const lcode = lc.body.code;
    const lx = await Ja('/tf/live/' + lcode, null, LX);
    assert(lx.status === 403, 'GET /tf/live/:code by non-participant → 403');
    const lj = await Ja('/tf/live/' + lcode + '/join', { method:'POST', body: JSON.stringify({ myDeck:'Mono-R' }) }, LG);
    assert(lj.status === 200 && lj.body.status === 'live' && lj.body.role === 'guest' && lj.body.opponent === 'live_host', 'join → live; guest sees host as opponent');
    const lxj = await Ja('/tf/live/' + lcode + '/join', { method:'POST', body: JSON.stringify({}) }, LX);
    assert(lxj.status === 409, 'third player join → 409 (full)');
    const g0 = await Ja('/tf/live/' + lcode + '/game', { method:'POST', body: JSON.stringify({ index:0, result:'me' }) }, LH);
    assert(g0.status === 200 && g0.body.games[0].result === 'W' && g0.body.tally.w === 1, 'host records game 0 as a win');
    const g0g = await Ja('/tf/live/' + lcode, null, LG);
    assert(g0g.status === 200 && g0g.body.games[0].result === 'L', 'guest sees that game mirrored as a loss (synced)');
    await Ja('/tf/live/' + lcode + '/game', { method:'POST', body: JSON.stringify({ index:1, result:'them' }) }, LG); // guest: opponent (host) won
    await Ja('/tf/live/' + lcode + '/game', { method:'POST', body: JSON.stringify({ index:2, result:'me' }) }, LH);
    const fin = await Ja('/tf/live/' + lcode + '/finish', { method:'POST', body: JSON.stringify({ notes:'gg' }) }, LH);
    assert(fin.status === 200 && fin.body.status === 'done' && fin.body.result === 'W', 'host finishes → done, host won');
    const hm = await Ja('/tf/matches', null, LH);
    assert(hm.body.matches[0].opponent === 'live_guest' && hm.body.matches[0].result === 'W' && hm.body.matches[0].games.length === 3, 'live match written to host history (vs guest, W)');
    const gm = await Ja('/tf/matches', null, LG);
    assert(gm.body.matches[0].opponent === 'live_host' && gm.body.matches[0].result === 'L', 'same match mirrored into guest history (vs host, L)');
    const e404 = await Ja('/tf/live/ZZZZZ', null, LH);
    assert(e404.status === 404, 'GET unknown live code → 404');

    // --- Upload rules gate + per-user upload disable (IP/compliance hardening) ---
    const ru = 'smoke_up_' + Math.floor(Math.random() * 1e6);
    const reg = await J('/auth/register', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ username: ru, email: ru + '@example.com', password: 'smoketest123' }) });
    if (reg.status === 200 && reg.body && reg.body.token) {
      const UT = reg.body.token;
      assert(reg.body.user && reg.body.user.uploads_accepted === null, 'new user starts with upload terms not accepted');
      const pre = await Ja('/uploads/card-art', { method:'POST' }, UT);
      assert(pre.status === 412 && pre.body && pre.body.needTerms, 'card-art before accepting rules → 412 needTerms');
      const acc = await Ja('/uploads/accept-terms', { method:'POST', body: JSON.stringify({}) }, UT);
      assert(acc.status === 200 && acc.body.accepted_at, 'POST /uploads/accept-terms → accepted_at');
      const post = await Ja('/uploads/card-art', { method:'POST' }, UT);
      assert(post.status === 400, 'after accepting, card-art passes the rules gate (400 no-file, not 412)');
      try {
        const udb = require('better-sqlite3')(process.env.DB_PATH || '/data/mymagicdeck.db');
        udb.prepare('UPDATE users SET uploads_disabled = 1 WHERE username = ?').run(ru);
        udb.close();
        const dis = await Ja('/uploads/card-art', { method:'POST' }, UT);
        assert(dis.status === 403, 'uploads_disabled account → card-art 403');
      } catch (_) { console.log('  (skipped uploads_disabled assert: no DB write access)'); }
    } else { console.log('  (skipped upload-gate asserts: register returned ' + reg.status + ')'); }
  } else { console.log('  (skipped lg online + cardle + tf asserts: no JWT_SECRET)'); }
} catch (e) {
  fail('threw: ' + (e && e.message || e));
}

console.log(`\napi-smoke: ${fails} failed.`);
process.exit(fails ? 1 : 0);
