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
    const F = tok(990600 + Math.floor(Math.random() * 9000), 'smoke_F'); // unique each run → state.n===0 holds
    const cst = await Ja('/cardle/state', null, F);
    assert(cst.status === 200 && cst.body.day && cst.body.max === 8 && cst.body.n === 0, 'GET /cardle/state → fresh daily game');
    const cg = await Ja('/cardle/guess', { method:'POST', body: JSON.stringify({ name:'Llanowar Elves' }) }, F);
    const last = cg.body && cg.body.guesses && cg.body.guesses[cg.body.guesses.length-1];
    assert(cg.status === 200 && last && last.cmc && ['eq','hi','lo'].includes(last.cmc.cmp) && last.colors && last.type, 'POST /cardle/guess → per-attribute feedback');
    const cbad = await Ja('/cardle/guess', { method:'POST', body: JSON.stringify({ name:'zzzz not a card' }) }, F);
    assert(cbad.status === 404, 'cardle guess of unknown card → 404');
    const csstats = await Ja('/cardle/stats', null, F);
    assert(csstats.status === 200 && typeof csstats.body.played === 'number' && typeof csstats.body.avgGuesses === 'number', 'GET /cardle/stats → totals');
  } else { console.log('  (skipped lg online + cardle asserts: no JWT_SECRET)'); }
} catch (e) {
  fail('threw: ' + (e && e.message || e));
}

console.log(`\napi-smoke: ${fails} failed.`);
process.exit(fails ? 1 : 0);
