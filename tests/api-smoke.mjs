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
} catch (e) {
  fail('threw: ' + (e && e.message || e));
}

console.log(`\napi-smoke: ${fails} failed.`);
process.exit(fails ? 1 : 0);
