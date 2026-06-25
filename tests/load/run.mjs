// Tournament load-test driver — hits the ISOLATED test API (default :3099), never prod.
// For each stage it spins up a fresh tournament, has the bot create N pairings (real /pairings endpoint),
// then runs every match's full live flow (life taps → deck → game results → both-confirm finish → interactions
// write) concurrently with a capped number of in-flight requests, and reports latency percentiles + errors.
// Sweeping the concurrency cap finds where the single-box / synchronous-SQLite model tips over.
//
//   BASE, BOT_KEY, JWT_SECRET, USERS_FILE, MATCHES, LIFE_TAPS, STAGES (comma list of concurrency caps)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE       = process.env.BASE       || 'http://127.0.0.1:3099';
const BOT_KEY    = process.env.BOT_KEY    || 'lt_bot_key_local';
const JWT_SECRET = process.env.JWT_SECRET || 'lt_jwt_secret_local_padding_0123456789abcdefXYZ';
const USERS_FILE = process.env.USERS_FILE || '/srv/data/mmd-loadtest/users.json';
const MATCHES    = parseInt(process.env.MATCHES   || '200', 10);   // matches per stage (needs 2×MATCHES users)
const LIFE_TAPS  = parseInt(process.env.LIFE_TAPS || '8', 10);     // life pushes per player per match
const STAGES     = (process.env.STAGES || '20,100,300,600').split(',').map(s => parseInt(s.trim(), 10));

const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
if (users.length < 2 * MATCHES) { console.error(`Need ${2*MATCHES} users, have ${users.length}. Seed more or lower MATCHES.`); process.exit(1); }

const b64u = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
function mintToken(u) {                                            // HS256 JWT compatible with @fastify/jwt
  const now = Math.floor(Date.now()/1000);
  const head = b64u(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const body = b64u(JSON.stringify({ sub:u.id, username:u.username, iat:now, exp:now + 86400 }));
  const sig  = b64u(crypto.createHmac('sha256', JWT_SECRET).update(head+'.'+body).digest());
  return head+'.'+body+'.'+sig;
}
users.forEach(u => { u.token = mintToken(u); });

// ── instrumented fetch ────────────────────────────────────────────────────────
let M = {}, ERR = {};
async function req(label, path, { method='POST', token, body, botKey } = {}) {
  const h = {};
  if (body!=null) h['content-type'] = 'application/json';   // empty JSON body → Fastify 400, so only set when sending one
  if (token)  h.authorization = 'Bearer ' + token;
  if (botKey) h['x-bot-key'] = botKey;
  const t = performance.now();
  let status = 0, ok = false, json = null;
  try {
    const r = await fetch(BASE + path, { method, headers:h, body: body!=null ? JSON.stringify(body) : undefined });
    status = r.status; ok = r.ok;
    const txt = await r.text(); try { json = JSON.parse(txt); } catch(_) {}
  } catch (e) { status = 'NETERR'; }
  const ms = performance.now() - t;
  (M[label] = M[label] || []).push(ms);
  if (!ok) { const k = label + ' → ' + status; ERR[k] = (ERR[k]||0) + 1; }
  return { ok, status, json };
}
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.floor(p/100*a.length))]; };

// run `items` through `worker`, never more than `cap` in flight
async function pool(items, cap, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => { while (i < items.length) await worker(items[i++]); });
  await Promise.all(runners);
}

// one full match: life taps → decks → games (host 2-0) → both finish (→ done + interactions row)
async function playMatch(m) {
  const { code, host, guest } = m;
  for (let t = 0; t < LIFE_TAPS; t++) {
    await req('POST /life', `/api/tf/live/${code}/life`, { token: host.token,  body:{ life: 20 - t } });
    await req('POST /life', `/api/tf/live/${code}/life`, { token: guest.token, body:{ life: 20 - (t>>1) } });
  }
  await req('POST /deck', `/api/tf/live/${code}/deck`, { token: host.token,  body:{ deck:'LT Aggro' } });
  await req('POST /deck', `/api/tf/live/${code}/deck`, { token: guest.token, body:{ deck:'LT Control' } });
  await req('POST /game', `/api/tf/live/${code}/game`, { token: host.token, body:{ index:0, result:'me' } });
  await req('POST /game', `/api/tf/live/${code}/game`, { token: host.token, body:{ index:1, result:'me' } });
  await req('POST /finish', `/api/tf/live/${code}/finish`, { token: host.token,  body:{ myDeck:'LT Aggro' } });
  await req('POST /finish', `/api/tf/live/${code}/finish`, { token: guest.token, body:{ myDeck:'LT Control' } });
}

async function stage(cap, idx) {
  M = {}; ERR = {};
  const tourn = `LT_${idx}_${Date.now()}`;
  // bot creates the pairings (real endpoint) → tf_live rows tagged with tourn/round
  const pairings = [];
  for (let k = 0; k < MATCHES; k++) {
    pairings.push({ tmatch: 'm' + k, a_discord: users[2*k].discord, b_discord: users[2*k+1].discord });
  }
  const codeFor = {};
  for (let off = 0; off < pairings.length; off += 64) {     // bot endpoint caps at 64 pairings/call → batch
    const pr = await req('POST /pairings', '/api/integrations/discord/pairings', { botKey: BOT_KEY, body:{ tourn, round:1, pairings: pairings.slice(off, off+64) } });
    (pr.json?.created || []).forEach(c => { codeFor[c.tmatch] = c.code; });
  }
  const matches = [];
  for (let k = 0; k < MATCHES; k++) { const code = codeFor['m'+k]; if (code) matches.push({ code, host: users[2*k], guest: users[2*k+1] }); }
  if (!matches.length) { console.error('  no matches created — check bot key / discord linkage'); return; }

  const wall0 = performance.now();
  await pool(matches, cap, playMatch);
  await req('POST /conclude', `/api/integrations/discord/tournament/${tourn}/conclude`, { botKey: BOT_KEY });
  const wallMs = performance.now() - wall0;

  const labels = Object.keys(M);
  const totalReq = labels.reduce((s,l)=>s+M[l].length, 0);
  const errCount = Object.values(ERR).reduce((s,n)=>s+n, 0);
  console.log(`\n━━ stage ${idx}: concurrency ${cap} · ${matches.length} matches · ${totalReq} reqs in ${(wallMs/1000).toFixed(1)}s · ${(totalReq/(wallMs/1000)).toFixed(0)} req/s · errors ${errCount} (${(100*errCount/totalReq).toFixed(2)}%)`);
  console.log('   endpoint        n     p50    p95    p99    max  (ms)');
  for (const l of labels.sort()) { const a=M[l]; console.log('   '+l.padEnd(14)+String(a.length).padStart(5)+pct(a,50).toFixed(0).padStart(7)+pct(a,95).toFixed(0).padStart(7)+pct(a,99).toFixed(0).padStart(7)+Math.max(...a).toFixed(0).padStart(7)); }
  if (errCount) { console.log('   errors:'); for (const [k,n] of Object.entries(ERR)) console.log('     '+k+' ×'+n); }
  return { cap, totalReq, wallMs, errCount, p99all: pct(labels.flatMap(l=>M[l]), 99) };
}

(async () => {
  console.log(`Load test → ${BASE}  (${users.length} users, ${MATCHES} matches/stage, ${LIFE_TAPS} life taps/player)`);
  const h = await req('GET /health', '/api/health', { method:'GET' });
  if (!h.ok) { console.error('test API not healthy at ' + BASE); process.exit(1); }
  const summary = [];
  for (let i = 0; i < STAGES.length; i++) summary.push(await stage(STAGES[i], i+1));
  console.log('\n════ summary ════');
  console.log(' concurrency   reqs   req/s   p99(ms)   err%');
  for (const s of summary.filter(Boolean)) console.log('  '+String(s.cap).padStart(8)+String(s.totalReq).padStart(8)+(s.totalReq/(s.wallMs/1000)).toFixed(0).padStart(8)+s.p99all.toFixed(0).padStart(10)+(100*s.errCount/s.totalReq).toFixed(2).padStart(8));
})();
