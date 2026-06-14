'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Fastify  = require('fastify');
const bcrypt   = require('bcrypt');
const Database = require('better-sqlite3');
const sharp    = require('sharp');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT || '3002', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'mymagicdeck.db');
const BCRYPT_ROUNDS = 12;

// ── Uploads / vision config ────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// MTG card image sizes (px) mirroring Scryfall's small/normal/large (~63:88 aspect).
const CARD_SIZES = { small: [146, 204], normal: [488, 680], large: [672, 936] };

// Local OpenAI-compatible multimodal model (same inference box the agents/rescued-art use).
const VLM_ENABLED  = (process.env.VLM_ENABLED || 'true').toLowerCase() !== 'false';
const VLM_BASE_URL = (process.env.VLM_BASE_URL || 'http://192.168.1.207:8081/v1').replace(/\/+$/, '');
const VLM_MODEL    = process.env.VLM_MODEL || 'local';
const VLM_TIMEOUT  = parseInt(process.env.VLM_TIMEOUT || '60000', 10);

// Optional text-to-image endpoint for AI splash backgrounds (e.g. a local ComfyUI/SD
// HTTP wrapper). Dormant until set: takes {prompt,width,height}, returns PNG bytes or
// JSON {image|b64_json}. No model is configured by default.
const IMG_GEN_URL = process.env.IMG_GEN_URL || '';
const IMG_GEN_TIMEOUT = parseInt(process.env.IMG_GEN_TIMEOUT || '120000', 10);

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Cap the WAL so it auto-truncates instead of growing unbounded after the
// daily full-table refresh (which writes ~40k rows in one transaction).
db.pragma('journal_size_limit = 67108864'); // 64 MB

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS decks (
    id          TEXT    NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL DEFAULT 'Untitled Deck',
    data        TEXT    NOT NULL DEFAULT '{}',
    is_public   INTEGER NOT NULL DEFAULT 0,
    is_splash   INTEGER NOT NULL DEFAULT 0,
    splash_site TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_decks_user        ON decks(user_id);
  CREATE INDEX IF NOT EXISTS idx_decks_splash      ON decks(user_id, is_splash);
`);

// ── Migrations (idempotent) ───────────────────────────────────────────────────
try { db.exec(`ALTER TABLE decks ADD COLUMN splash_site TEXT`); } catch (_) { /* already exists */ }
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_decks_splash_site ON decks(user_id, splash_site)`); } catch (_) { /* already exists */ }

// ── Cards table + FTS5 ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    oracle_id       TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    mana_cost       TEXT,
    cmc             REAL NOT NULL DEFAULT 0,
    type_line       TEXT,
    oracle_text     TEXT,
    colors          TEXT,         -- JSON array e.g. ["W","U"]
    color_identity  TEXT,         -- JSON array
    keywords        TEXT,         -- JSON array
    legalities      TEXT,         -- JSON object
    set_id          TEXT,
    set_name        TEXT,
    rarity          TEXT,
    image_uris      TEXT,         -- JSON object (small/normal/large)
    card_faces      TEXT,         -- JSON array (for DFCs)
    prices          TEXT,         -- JSON object {usd, usd_foil}
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_cards_cmc  ON cards(cmc);
`);

// ── Uploads registry (user image library + quota) ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,                 -- random uid (card) or 'deck_<hex>'
    kind       TEXT    NOT NULL DEFAULT 'card',  -- 'card' | 'deck'
    card_name  TEXT,
    oracle_id  TEXT,
    confirmed  INTEGER NOT NULL DEFAULT 0,
    small      TEXT,
    normal     TEXT,
    large      TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, kind);
`);

const UPLOAD_LIMIT = parseInt(process.env.UPLOAD_LIMIT || '100', 10); // card-art uploads per user

// ── Perceptual-hash index (card identification) ───────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS card_hashes (
    scryfall_id TEXT PRIMARY KEY,
    oracle_id   TEXT,
    name        TEXT,
    set_code    TEXT,
    phash       TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
const PHASH_THRESHOLD = parseInt(process.env.PHASH_THRESHOLD || '14', 10); // max Hamming for a confident match

// FTS5 table — content= links to cards so we don't double-store text
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
      name, type_line, oracle_text, keywords,
      content='cards', content_rowid='rowid'
    );
  `);
} catch (_) { /* already exists */ }

// ── Card refresh state ────────────────────────────────────────────────────────
let _cardRefreshState = { status: 'idle', started: null, finished: null, count: 0, error: null };
let _cardRefreshRunning = false;

async function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'mymagicdeck/1.0 (homelab deck builder)', 'Accept': 'application/json' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function refreshCards() {
  if (_cardRefreshRunning) return;
  _cardRefreshRunning = true;
  _cardRefreshState = { status: 'fetching-index', started: Date.now(), finished: null, count: 0, error: null };
  try {
    // 1. Get bulk-data index
    const idx = await httpsGet('https://api.scryfall.com/bulk-data');
    const bulkList = JSON.parse(idx.body).data;
    const oracleEntry = bulkList.find(d => d.type === 'oracle_cards');
    if (!oracleEntry) throw new Error('oracle_cards bulk entry not found');

    _cardRefreshState.status = 'downloading';
    const dl = await httpsGet(oracleEntry.download_uri);
    if (dl.status !== 200) throw new Error(`Download failed: HTTP ${dl.status}`);

    _cardRefreshState.status = 'parsing';
    const cards = JSON.parse(dl.body);

    _cardRefreshState.status = 'upserting';
    const upsert = db.prepare(`
      INSERT INTO cards
        (oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
         keywords, legalities, set_id, set_name, rarity, image_uris, card_faces, prices, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
      ON CONFLICT(oracle_id) DO UPDATE SET
        name=excluded.name, mana_cost=excluded.mana_cost, cmc=excluded.cmc,
        type_line=excluded.type_line, oracle_text=excluded.oracle_text,
        colors=excluded.colors, color_identity=excluded.color_identity,
        keywords=excluded.keywords, legalities=excluded.legalities,
        set_id=excluded.set_id, set_name=excluded.set_name, rarity=excluded.rarity,
        image_uris=excluded.image_uris, card_faces=excluded.card_faces,
        prices=excluded.prices, updated_at=unixepoch()
    `);

    // Rebuild FTS in one transaction — much faster
    const runUpserts = db.transaction((cards) => {
      db.prepare('DELETE FROM cards_fts').run();
      let imported = 0;
      for (const c of cards) {
        if (c.object !== 'card') continue;
        // Skip reversible_card printings (e.g. Secret Lair art variants). They
        // carry no gameplay data — name "X // X", type "Card // Card", empty
        // oracle text, no colors — and merely duplicate the real card, which has
        // its own proper oracle entry. Importing them pollutes search results.
        if (c.layout === 'reversible_card') continue;
        imported++;
        upsert.run(
          c.oracle_id, c.name, c.mana_cost || null,
          c.cmc || 0, c.type_line || null, c.oracle_text || null,
          JSON.stringify(c.colors || []), JSON.stringify(c.color_identity || []),
          JSON.stringify(c.keywords || []), JSON.stringify(c.legalities || {}),
          c.set || null, c.set_name || null, c.rarity || null,
          JSON.stringify(c.image_uris || null),
          c.card_faces ? JSON.stringify(c.card_faces) : null,
          JSON.stringify({ usd: c.prices?.usd || null, usd_foil: c.prices?.usd_foil || null })
        );
      }
      // Purge any reversible rows left over from before this filter existed.
      db.prepare(`DELETE FROM cards WHERE type_line = 'Card // Card'`).run();
      // Rebuild FTS from cards table
      db.prepare(`INSERT INTO cards_fts(rowid, name, type_line, oracle_text, keywords)
                  SELECT rowid, name, type_line, oracle_text, keywords FROM cards`).run();
      return imported;
    });

    const count = runUpserts(cards);
    // Reclaim the WAL after the big rebuild transaction so it doesn't grow unbounded.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best effort */ }
    _cardRefreshState = { status: 'done', started: _cardRefreshState.started, finished: Date.now(), count, error: null };
    app.log.info(`Card refresh complete: ${count} cards`);
  } catch (err) {
    _cardRefreshState = { ..._cardRefreshState, status: 'error', error: err.message, finished: Date.now() };
    app.log.error('Card refresh failed: ' + err.message);
  } finally {
    _cardRefreshRunning = false;
  }
}

// Seed on startup if cards table is empty, then refresh daily
function scheduleCardRefresh() {
  const count = db.prepare('SELECT COUNT(*) as n FROM cards').get().n;
  if (count === 0) {
    app.log.info('Cards table empty — seeding from Scryfall bulk data...');
    refreshCards();
  }
  // Daily refresh at ~3am UTC
  const msUntil3am = (() => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  })();
  setTimeout(() => { refreshCards(); setInterval(refreshCards, 24 * 60 * 60 * 1000); }, msUntil3am);
}

// ── Scryfall query parser ─────────────────────────────────────────────────────
// Build a color WHERE clause for `c:`/`ci:` tokens. Handles the WUBRG letters
// plus `c` (colorless) and `m` (multicolor). Pushes any bind params onto `params`
// in clause order. Returns the SQL fragment, or null if nothing matched.
function colorPredicate(column, letters, params) {
  const upper = letters.toUpperCase();
  const wubrg = upper.split('').filter(x => 'WUBRG'.includes(x));
  const parts = [];
  if (upper.includes('C')) parts.push(`json_array_length(${column}) = 0`);
  if (upper.includes('M')) parts.push(`json_array_length(${column}) >= 2`);
  for (const col of wubrg) { parts.push(`${column} LIKE ?`); params.push(`%"${col}"%`); }
  return parts.length ? `(${parts.join(' AND ')})` : null;
}

// Translates a subset of Scryfall syntax into SQLite WHERE clauses
function parseScryfallQuery(q) {
  const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const where = [], params = [], errors = [];
  let ftsTerms = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();

    // Color: c:wubrg / color:wubrg — also c:c (colorless) and c:m (multicolor)
    const colorM = lower.match(/^(?:c|color):([wubrgmc]+)$/);
    if (colorM) {
      const parts = colorPredicate('colors', colorM[1], params);
      if (parts) where.push(parts);
      continue;
    }

    // Color identity: ci:wubrg / identity:wubrg — also ci:c and ci:m
    const ciM = lower.match(/^(?:ci|identity):([wubrgmc]+)$/);
    if (ciM) {
      const parts = colorPredicate('color_identity', ciM[1], params);
      if (parts) where.push(parts);
      continue;
    }

    // Type: t:creature or type:instant
    const typeM = lower.match(/^(?:t|type):(.+)$/);
    if (typeM) {
      where.push(`type_line LIKE ?`);
      params.push(`%${typeM[1]}%`);
      continue;
    }

    // Oracle text: o: or oracle:
    const oracleM = lower.match(/^(?:o|oracle):(.+)$/);
    if (oracleM) {
      const term = oracleM[1].replace(/"/g, '');
      ftsTerms.push(`oracle_text:"${term}"`);
      continue;
    }

    // Format legality: f:commander
    const formatM = lower.match(/^(?:f|format):(\w+)$/);
    if (formatM) {
      where.push(`json_extract(legalities, '$.${formatM[1]}') IN ('legal','restricted')`);
      continue;
    }

    // CMC: cmc=3, cmc>2, cmc<=4, mv=3 etc
    const cmcM = lower.match(/^(?:cmc|mv|manavalue)(>=|<=|!=|>|<|=)(\d+(?:\.\d+)?)$/);
    if (cmcM) {
      const op = cmcM[1] === '!=' ? '!=' : cmcM[1];
      where.push(`cmc ${op} ?`);
      params.push(parseFloat(cmcM[2]));
      continue;
    }

    // Rarity: r:rare
    const rarityM = lower.match(/^(?:r|rarity):(\w+)$/);
    if (rarityM) {
      where.push(`rarity = ?`);
      params.push(rarityM[1].toLowerCase());
      continue;
    }

    // Bare keyword/name — goes to FTS; wrap in double-quotes so FTS5 treats
    // it as a literal token and special chars (apostrophes, hyphens) don't
    // break the query syntax.
    const clean = tok.replace(/"/g, '').trim();
    if (clean) ftsTerms.push(`"${clean}"`);
  }

  return { where, params, ftsTerms };
}

function cardRowToScryfall(r) {
  return {
    oracle_id:      r.oracle_id,
    name:           r.name,
    mana_cost:      r.mana_cost,
    cmc:            r.cmc,
    type_line:      r.type_line,
    oracle_text:    r.oracle_text,
    colors:         JSON.parse(r.colors || '[]'),
    color_identity: JSON.parse(r.color_identity || '[]'),
    keywords:       JSON.parse(r.keywords || '[]'),
    legalities:     JSON.parse(r.legalities || '{}'),
    set:            r.set_id,
    set_name:       r.set_name,
    rarity:         r.rarity,
    image_uris:     JSON.parse(r.image_uris || 'null'),
    card_faces:     r.card_faces ? JSON.parse(r.card_faces) : undefined,
    prices:         JSON.parse(r.prices || '{}'),
    object:         'card',
  };
}

// ── Fastify instance ──────────────────────────────────────────────────────────
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

app.register(require('@fastify/cors'), {
  origin: true,           // reflect request origin — tighten in prod if desired
  credentials: true,
});

app.register(require('@fastify/jwt'), {
  secret: JWT_SECRET,
  sign: { expiresIn: '30d' },
});

app.register(require('@fastify/multipart'), {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
});

// ── Rate limiter (in-memory, per-IP) ─────────────────────────────────────────
const _rateBuckets = new Map();
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_MAX_AUTH = 20;            // max auth attempts per window

function rateLimitAuth(req, reply, done) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW) {
    bucket = { start: now, count: 0 };
    _rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_MAX_AUTH) {
    reply.code(429).send({ error: 'Too many attempts. Please try again in a few minutes.' });
    return;
  }
  done();
}

// Clean up stale rate limit buckets every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [ip, bucket] of _rateBuckets) {
    if (bucket.start < cutoff) _rateBuckets.delete(ip);
  }
}, 30 * 60 * 1000);

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function authenticate(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ── Upload rate limiter (per user/IP) ──────────────────────────────────────────
const _uploadBuckets = new Map();
const UPLOAD_WINDOW = 15 * 60 * 1000;
const UPLOAD_MAX = 60; // uploads per window

function rateLimitUpload(req, reply, done) {
  const key = req.user?.sub
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip || 'unknown';
  const now = Date.now();
  let bucket = _uploadBuckets.get(key);
  if (!bucket || now - bucket.start > UPLOAD_WINDOW) {
    bucket = { start: now, count: 0 };
    _uploadBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > UPLOAD_MAX) {
    reply.code(429).send({ error: 'Too many uploads. Please slow down and try again shortly.' });
    return;
  }
  done();
}
setInterval(() => {
  const cutoff = Date.now() - UPLOAD_WINDOW;
  for (const [k, b] of _uploadBuckets) if (b.start < cutoff) _uploadBuckets.delete(k);
}, 30 * 60 * 1000);

// ── Vision: is this a Magic card, and where is it? ─────────────────────────────
// Pull a JSON object out of a possibly-fenced / chatty / <think>-wrapped reply.
function _extractJson(text) {
  if (!text) return {};
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : t); } catch { return {}; }
}

function _cardPrompt(expectedName) {
  let p =
    'This image is (supposedly) a single Magic: The Gathering card — any frame/era, including altered, ' +
    'foil, or proxy cards. Return ONLY a JSON object with exactly these keys:\n' +
    '"is_magic_card": true or false,\n' +
    '"confidence": a number 0..1,\n' +
    '"card_name": the card’s printed title exactly as you read it, or null if you cannot read it,\n' +
    '"mana_cost": the mana cost in the top-right, e.g. "2WW" or "{2}{W}{W}", or null,\n' +
    '"corners": the four corners of the card as [[x,y],[x,y],[x,y],[x,y]] in order top-left, top-right, ' +
    'bottom-right, bottom-left, each as fractions 0..1 of the image; or null if you cannot locate them,\n' +
    '"bbox": the card’s bounding box [x,y,w,h] as fractions 0..1 (x,y = top-left corner), or null.';
  if (expectedName) p += `\nContext: the user expects this to be "${expectedName}", but report what you actually see.`;
  return p;
}
function _sanitizeCorners(c) {
  if (!Array.isArray(c) || c.length !== 4) return null;
  const pts = c.map(p => (Array.isArray(p) && p.length >= 2) ? [Number(p[0]), Number(p[1])] : null);
  if (pts.some(p => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  return pts;
}
// Parse "x0,y0,x1,y1,x2,y2,x3,y3" (normalized, TL,TR,BR,BL) from the cropper.
function parseCornersParam(s) {
  if (!s) return null;
  const n = String(s).split(',').map(Number);
  if (n.length !== 8 || n.some(v => !Number.isFinite(v))) return null;
  return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
}

// Returns { verified, isCard, confidence, bbox|null, corners|null, cardName|null }.
// Best-effort: on any failure returns { verified:false } so the caller falls back.
async function verifyAndLocateCard(jpeg, expectedName) {
  if (!VLM_ENABLED) return { verified: false, bbox: null, corners: null, cardName: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VLM_TIMEOUT);
  try {
    const dataUrl = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    const payload = {
      model: VLM_MODEL,
      max_tokens: 400,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: _cardPrompt(expectedName) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    };
    const r = await fetch(`${VLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('VLM HTTP ' + r.status);
    const j = await r.json();
    const obj = _extractJson(j.choices?.[0]?.message?.content || '');
    const isCard = obj.is_magic_card === true || /^(true|yes)$/i.test(String(obj.is_magic_card));
    const confidence = Number(obj.confidence);
    let bbox = Array.isArray(obj.bbox) && obj.bbox.length === 4 ? obj.bbox.map(Number) : null;
    if (bbox && bbox.some(n => !Number.isFinite(n))) bbox = null;
    const corners = _sanitizeCorners(obj.corners);
    const cardName = (typeof obj.card_name === 'string' && obj.card_name.trim()) ? obj.card_name.trim() : null;
    const manaCost = (typeof obj.mana_cost === 'string' && obj.mana_cost.trim()) ? obj.mana_cost.trim() : null;
    return { verified: true, isCard, confidence: Number.isFinite(confidence) ? confidence : 0, bbox, corners, cardName, manaCost };
  } catch (e) {
    app.log.warn('VLM verify failed: ' + e.message);
    return { verified: false, bbox: null, corners: null, cardName: null, manaCost: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── Image processing (sharp): crop to the card and emit the 3 Scryfall sizes ───
const _clamp01 = n => Math.max(0, Math.min(1, n));

// iPhones default to HEIC, which sharp's bundled libvips can't decode. Detect it
// (by mimetype or ISO-BMFF brand) and transcode to JPEG before anything else, so
// both the vision check and sharp get a format they understand.
const _HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
function isHeic(buf, mimetype) {
  if (/heic|heif/i.test(mimetype || '')) return true;
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    return _HEIC_BRANDS.has(buf.toString('latin1', 8, 12).toLowerCase());
  }
  return false;
}
async function toProcessable(buf, mimetype) {
  if (!isHeic(buf, mimetype)) return buf;
  const convert = require('heic-convert');
  const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.92 });
  return Buffer.from(out);
}

// Perspective-deskew target = the large card size.
const [CARD_W, CARD_H] = CARD_SIZES.large;

// Is the (normalized) corner quad usable? In-bounds and covering enough area.
function _quadOK(pts) {
  for (const [x, y] of pts) { if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return false; }
  let area = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4]; area += x1 * y2 - x2 * y1; }
  return Math.abs(area) / 2 >= 0.15;
}
function _runMagick(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('magick', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, err => err ? reject(err) : resolve());
  });
}
// Perspective-correct the card to a flat CARD_W×CARD_H using its 4 corners (normalized, TL,TR,BR,BL).
async function _deskew(baseBuf, pts) {
  const meta = await sharp(baseBuf).metadata();
  const W = meta.width, H = meta.height;
  const src = pts.map(([x, y]) => [Math.round(_clamp01(x) * W), Math.round(_clamp01(y) * H)]);
  const dst = [[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]];
  const cps = src.map((p, i) => `${p[0]},${p[1]} ${dst[i][0]},${dst[i][1]}`).join('  ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-'));
  const inF = path.join(dir, 'in.png'), outF = path.join(dir, 'out.png');
  try {
    await sharp(baseBuf).png().toFile(inF);
    await _runMagick([inF, '-virtual-pixel', 'black',
      '-define', `distort:viewport=${CARD_W}x${CARD_H}+0+0`,
      '-distort', 'Perspective', cps, '+repage', outF]);
    return fs.readFileSync(outF);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// Document-scanner corner detection via OpenCV (api/detect_corners.py). Best-effort:
// returns normalized [[x,y]×4] TL,TR,BR,BL on success, else null. Runs on the
// auto-oriented image so the corners line up with the browser's EXIF-oriented view.
function detectCornersCV(buf) {
  return (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmdcv-'));
    const inF = path.join(dir, 'in.png');
    try {
      await sharp(buf, { failOn: 'none' }).rotate().png().toFile(inF);
      const corners = await new Promise(resolve => {
        execFile('python3', [path.join(__dirname, 'detect_corners.py'), inF],
          { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err) { app.log.warn('CV corner detect failed: ' + err.message); return resolve(null); }
            try { resolve(JSON.parse(stdout).corners || null); } catch { resolve(null); }
          });
      });
      return _sanitizeCorners(corners);
    } catch (e) { app.log.warn('CV corner detect error: ' + e.message); return null; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  })();
}

// ── Perceptual hashing (DCT pHash) for card identification ────────────────────
function _dct1d(vec) {
  const N = vec.length, out = new Float64Array(N);
  for (let u = 0; u < N; u++) {
    let s = 0;
    for (let x = 0; x < N; x++) s += vec[x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    out[u] = s;
  }
  return out;
}
async function pHash(buf) {
  const N = 32;
  const { data, info } = await sharp(buf, { failOn: 'none' }).rotate().grayscale()
    .resize(N, N, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels || 1;
  const px = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) px[i] = data[i * ch];
  const tmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) { const d = _dct1d(px.subarray(y * N, y * N + N)); for (let x = 0; x < N; x++) tmp[y * N + x] = d[x]; }
  const dct = new Float64Array(N * N), col = new Float64Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) col[y] = tmp[y * N + x];
    const d = _dct1d(col);
    for (let y = 0; y < N; y++) dct[y * N + x] = d[y];
  }
  const block = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block.push(dct[y * N + x]);
  const sorted = block.slice(1).sort((a, b) => a - b); // median excludes DC
  const med = sorted[Math.floor(sorted.length / 2)];
  let hi = 0n;
  for (let i = 0; i < 64; i++) hi = (hi << 1n) | (block[i] > med ? 1n : 0n);
  return hi;
}
const _hex64 = hi => hi.toString(16).padStart(16, '0');

// In-memory index of all reference hashes; matched by Hamming distance.
let _hashIndex = [];
function loadHashIndex() {
  try {
    _hashIndex = db.prepare('SELECT name, oracle_id, phash FROM card_hashes').all()
      .map(r => ({ name: r.name, oracle_id: r.oracle_id, hi: BigInt('0x' + r.phash) }));
    app.log.info('pHash index loaded: ' + _hashIndex.length);
  } catch (e) { app.log.warn('hash index load failed: ' + e.message); _hashIndex = []; }
}
async function matchHash(buf) {
  if (!_hashIndex.length) return null;
  let hi; try { hi = await pHash(buf); } catch { return null; }
  let best = null, bestD = 999;
  for (const e of _hashIndex) {
    let x = hi ^ e.hi, d = 0;
    while (x > 0n && d < bestD) { x &= x - 1n; d++; }
    if (d < bestD) { bestD = d; best = e; if (d === 0) break; }
  }
  return best ? { name: best.name, oracle_id: best.oracle_id, distance: bestD } : null;
}

// Stream a URL to a file (avoids buffering large downloads in heap).
function streamDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u, n = 0) => {
      if (n > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'mymagicdeck/1.0 (homelab deck builder)' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return follow(res.headers.location, n + 1); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const f = fs.createWriteStream(destPath);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve()));
        f.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Hash-refresh job: hash every unique artwork from Scryfall's bulk data ──────
let _hashState = { status: 'idle', done: 0, started: null, finished: null, error: null };
let _hashRunning = false;
async function refreshHashes() {
  if (_hashRunning) return;
  _hashRunning = true;
  _hashState = { status: 'fetching-index', done: 0, started: Date.now(), finished: null, error: null };
  const tmpFile = path.join(os.tmpdir(), 'mmd-unique-artwork.json');
  try {
    const idx = await httpsGet('https://api.scryfall.com/bulk-data');
    const entry = JSON.parse(idx.body).data.find(d => d.type === 'unique_artwork');
    if (!entry) throw new Error('unique_artwork bulk entry not found');
    _hashState.status = 'downloading';
    await streamDownload(entry.download_uri, tmpFile);

    _hashState.status = 'hashing';
    const existing = new Set(db.prepare('SELECT scryfall_id FROM card_hashes').all().map(r => r.scryfall_id));
    const insert = db.prepare('INSERT OR IGNORE INTO card_hashes (scryfall_id, oracle_id, name, set_code, phash) VALUES (?,?,?,?,?)');
    const { parser } = require('stream-json');
    const { streamArray } = require('stream-json/streamers/StreamArray');
    const stream = fs.createReadStream(tmpFile).pipe(parser()).pipe(streamArray());
    await new Promise((resolve, reject) => {
      stream.on('data', async ({ value: c }) => {
        stream.pause();
        try {
          if (c && c.object === 'card' && !existing.has(c.id)) {
            const img = c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small;
            if (img) {
              const tmpImg = path.join(os.tmpdir(), 'mmdh-' + c.id + '.jpg');
              try {
                await streamDownload(img, tmpImg);
                const hi = await pHash(fs.readFileSync(tmpImg));
                insert.run(c.id, c.oracle_id || null, c.name || null, c.set || null, _hex64(hi));
                _hashState.done++;
              } catch (_) { /* skip this card */ }
              finally { try { fs.rmSync(tmpImg, { force: true }); } catch (_) { } }
              await new Promise(r => setTimeout(r, 40)); // politeness toward Scryfall
            }
          }
        } finally { stream.resume(); }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    _hashState = { ..._hashState, status: 'done', finished: Date.now() };
    loadHashIndex();
    app.log.info('Hash refresh complete: ' + _hashState.done + ' new hashes');
  } catch (err) {
    _hashState = { ..._hashState, status: 'error', error: err.message, finished: Date.now() };
    app.log.error('Hash refresh failed: ' + err.message);
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch (_) { }
    _hashRunning = false;
  }
}

async function processCardImage(buf, bbox, corners) {
  // Materialize the auto-oriented image FIRST so metadata() reports the real
  // (post-rotation) dimensions — phone photos carry EXIF orientation that swaps
  // width/height, which otherwise makes any crop fall outside the image.
  const base = await sharp(buf, { failOn: 'none' }).rotate().toBuffer();
  let cropped = null;

  // 1) Preferred: perspective deskew from the 4 corners (straightens a tilted photo).
  if (corners) {
    try {
      const meta = await sharp(base).metadata();
      const W = meta.width || 0, H = meta.height || 0;
      let pts = corners.map(([x, y]) => [Number(x), Number(y)]);
      if (pts.some(([x, y]) => x > 1.5 || y > 1.5) && W && H) pts = pts.map(([x, y]) => [x / W, y / H]); // pixel→normalized
      if (W && H && _quadOK(pts)) cropped = await _deskew(base, pts);
      else app.log.warn('deskew skipped (bad quad): ' + JSON.stringify(corners));
    } catch (e) { app.log.warn('deskew failed, falling back: ' + e.message); cropped = null; }
  }

  // 2) Fallback: bounding-box crop.
  if (!cropped && bbox) {
    try {
      const meta = await sharp(base).metadata();
      const W = meta.width || 0, H = meta.height || 0;
      let [bx, by, bw, bh] = bbox.map(Number);
      if ([bx, by, bw, bh].some(v => v > 1.5)) { bx /= W; by /= H; bw /= W; bh /= H; }
      let left = Math.round(_clamp01(bx) * W), top = Math.round(_clamp01(by) * H);
      let width = Math.round(_clamp01(bw) * W), height = Math.round(_clamp01(bh) * H);
      if (left >= W) left = 0;
      if (top >= H) top = 0;
      width = Math.min(width, W - left);
      height = Math.min(height, H - top);
      if (W && H && width > 1 && height > 1 && width >= W * 0.15 && height >= H * 0.15) {
        cropped = await sharp(base).extract({ left, top, width, height }).toBuffer();
      }
    } catch (e) { app.log.warn('bbox crop failed, using full frame: ' + e.message); }
  }

  // 3) Last resort: full frame.
  if (!cropped) cropped = base;

  const out = {};
  for (const [size, [w, h]] of Object.entries(CARD_SIZES)) {
    out[size] = await sharp(cropped)
      .resize(w, h, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  }
  return out;
}

// Write a set of {size: buffer} to the user's upload dir; return { key, urls }.
function storeImageSet(userId, sizesObj) {
  const dir = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(8).toString('hex');
  const urls = {};
  for (const [size, b] of Object.entries(sizesObj)) {
    const fname = `${key}__${size}.webp`;
    fs.writeFileSync(path.join(dir, fname), b);
    urls[size] = `/u/${userId}/${fname}`;
  }
  return { key, urls };
}

// ── Card identity resolution for an upload ─────────────────────────────────────
function lookupCardRowByName(name) {
  if (!name) return null;
  let row = db.prepare('SELECT oracle_id, name FROM cards WHERE name = ? COLLATE NOCASE').get(name);
  if (!row) {
    try {
      row = db.prepare(`SELECT c.oracle_id, c.name FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
                        WHERE cards_fts MATCH ? ORDER BY rank LIMIT 1`).get('"' + String(name).replace(/"/g, '') + '"');
    } catch (_) { /* FTS syntax */ }
  }
  return row || null;
}
// Pick the card an upload depicts. An explicit expected card (the one being replaced
// in the deck) is trusted and auto-confirmed; otherwise we resolve the vision guess.
function resolveCardIdentity(visionName, expectedOracle, expectedName) {
  if (expectedOracle || expectedName) {
    let name = expectedName || null, oracle = expectedOracle || null;
    if (oracle && !name) { const r = db.prepare('SELECT name FROM cards WHERE oracle_id = ?').get(oracle); if (r) name = r.name; }
    if (!oracle && name) { const r = lookupCardRowByName(name); if (r) oracle = r.oracle_id; }
    return { cardName: name, oracleId: oracle, confirmed: 1 };
  }
  const r = lookupCardRowByName(visionName);
  if (r) return { cardName: r.name, oracleId: r.oracle_id, confirmed: 0 };
  return { cardName: visionName || null, oracleId: null, confirmed: 0 };
}
// Identity precedence: explicit expected card (confirmed) > confident pHash match
// (confirmed) > VLM-read name guess (unconfirmed) > null.
function resolveIdentity({ expectedName, expectedOracle, match, guessName }) {
  if (expectedOracle || expectedName) return resolveCardIdentity(null, expectedOracle, expectedName);
  if (match && match.distance <= PHASH_THRESHOLD) return { cardName: match.name, oracleId: match.oracle_id, confirmed: 1 };
  return resolveCardIdentity(guessName, null, null);
}

// ── Staged identify cascade ───────────────────────────────────────────────────
// name (read) → fuzzy DB candidates → mana/CMC filter → pHash-rank WITHIN the few
// candidates (reliable even when global pHash isn't) → confidence gate / escalation.
let _nameIndex = [];
function loadNameIndex() {
  try {
    _nameIndex = db.prepare('SELECT oracle_id, name, mana_cost, cmc FROM cards').all()
      .map(r => ({ oracle_id: r.oracle_id, name: r.name, lname: (r.name || '').toLowerCase(), cmc: r.cmc || 0 }));
    app.log.info('name index loaded: ' + _nameIndex.length);
  } catch (e) { app.log.warn('name index load failed: ' + e.message); _nameIndex = []; }
}
function _lev(a, b, cap) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1); cur[0] = i; let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[n];
}
function fuzzyNameCandidates(name, k) {
  if (!name) return [];
  const q = String(name).toLowerCase().trim();
  if (!q) return [];
  const exact = _nameIndex.filter(c => c.lname === q);
  if (exact.length) return exact.slice(0, k).map(c => ({ ...c, exact: true, dist: 0 }));
  const cap = Math.max(2, Math.floor(q.length / 3));
  const scored = [];
  for (const c of _nameIndex) {
    if (Math.abs(c.lname.length - q.length) > cap) continue;
    const d = _lev(q, c.lname, cap);
    if (d <= cap) scored.push({ ...c, dist: d, exact: false });
  }
  scored.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length);
  return scored.slice(0, k);
}
function _cmcFromMana(s) {
  if (!s) return null;
  const toks = String(s).toUpperCase().match(/\d+|\{[^}]+\}|[WUBRGCS]/g);
  if (!toks) return null;
  let cmc = 0;
  for (let t of toks) { t = t.replace(/[{}]/g, ''); if (/^\d+$/.test(t)) cmc += parseInt(t, 10); else if ('WUBRGCS'.includes(t)) cmc += 1; }
  return cmc;
}
// pHash distance to the crop, restricted to a small candidate set (oracle_ids) — sorted.
async function rankHashAmong(cropBuf, oracleSet) {
  if (!_hashIndex.length) return [];
  let hi; try { hi = await pHash(cropBuf); } catch { return []; }
  const byO = new Map();
  for (const e of _hashIndex) {
    if (!oracleSet.has(e.oracle_id)) continue;
    let x = hi ^ e.hi, d = 0; while (x > 0n) { x &= x - 1n; d++; }
    const cur = byO.get(e.oracle_id);
    if (!cur || d < cur.distance) byO.set(e.oracle_id, { oracle_id: e.oracle_id, name: e.name, distance: d });
  }
  return [...byO.values()].sort((a, b) => a.distance - b.distance);
}
// Stub for a future tool-grounded / agentic verifier (Hermes). Returns null = no override.
async function escalateIdentify(ctx) {
  app.log.info('identify-escalation hook (stub): read=' + JSON.stringify(ctx.readName) + ' candidates=' + (ctx.cands ? ctx.cands.length : 0));
  return null;
}
async function cascadeIdentify({ cropBuf, readName, readMana, expectedName, expectedOracle }) {
  // 1. An explicit expected card (splash-edit replace) always wins.
  if (expectedOracle || expectedName) { const r = resolveCardIdentity(null, expectedOracle, expectedName); return { ...r, source: 'expected' }; }
  // 2. Candidates by (fuzzy) name — name is ~unique in Magic, so this usually nails it.
  let cands = fuzzyNameCandidates(readName, 12);
  const exacts = cands.filter(c => c.exact);
  if (exacts.length === 1) return { cardName: exacts[0].name, oracleId: exacts[0].oracle_id, confirmed: 1, source: 'name-exact' };
  // 3. Disambiguate a fuzzy/garbled read by mana cost (CMC).
  const readCmc = _cmcFromMana(readMana);
  if (readCmc != null && cands.length > 1) { const f = cands.filter(c => Math.round(c.cmc) === readCmc); if (f.length) cands = f; }
  if (cands.length === 1) return { cardName: cands[0].name, oracleId: cands[0].oracle_id, confirmed: 1, source: 'name+cost' };
  // 4. Art-grade within the few survivors (pHash as a local ranker — reliable).
  if (cands.length > 1 && cropBuf) {
    const ranked = await rankHashAmong(cropBuf, new Set(cands.map(c => c.oracle_id)));
    if (ranked.length) {
      const best = ranked[0];
      const clear = ranked.length === 1 || best.distance <= ranked[1].distance - 4;
      return { cardName: best.name, oracleId: best.oracle_id, confirmed: clear ? 1 : 0, source: 'name+art' };
    }
  }
  // 5. Best fuzzy guess (unconfirmed) — with an escalation hook for the hard cases.
  if (cands.length) {
    const esc = await escalateIdentify({ cropBuf, readName, readMana, cands }); if (esc) return { ...esc, source: 'escalated' };
    return { cardName: cands[0].name, oracleId: cands[0].oracle_id, confirmed: 0, source: 'name-fuzzy' };
  }
  // 6. No readable name → global pHash, as an UNCONFIRMED suggestion only. Global pHash
  //    is noisy (collisions on low-contrast art / photos), so it never auto-confirms —
  //    only name-corroborated paths above do. The user verifies it on the uploads page.
  if (cropBuf) { const g = await matchHash(cropBuf); if (g && g.distance <= 16) return { cardName: g.name, oracleId: g.oracle_id, confirmed: 0, source: 'phash-global' }; }
  const esc = await escalateIdentify({ cropBuf, readName, readMana, cands: [] }); if (esc) return { ...esc, source: 'escalated' };
  return { cardName: readName || null, oracleId: null, confirmed: 0, source: 'none' };
}

// When an uploaded image is deleted, strip it from the user's decks: base custom
// art reverts to the card's default Scryfall image; per-copy overrides are removed;
// a deck photo using it is cleared. Returns the number of decks changed.
function revertDeletedUploadFromDecks(userId, key) {
  const decks = db.prepare('SELECT id, data FROM decks WHERE user_id = ?').all(userId);
  let count = 0;
  const usesKey = u => typeof u === 'string' && u.includes(key);
  for (const d of decks) {
    let obj; try { obj = JSON.parse(d.data); } catch { continue; }
    let changed = false;
    const fixEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return;
      const c = entry.card;
      if (c && c.image_uris && Object.values(c.image_uris).some(usesKey)) {
        const r = c.oracle_id ? db.prepare('SELECT image_uris FROM cards WHERE oracle_id = ?').get(c.oracle_id) : null;
        c.image_uris = r ? JSON.parse(r.image_uris || 'null') : null;
        delete c.customArt; delete c._origImg; delete c.scryfallId;
        changed = true;
      }
      if (entry.arts && typeof entry.arts === 'object') {
        for (const k of Object.keys(entry.arts)) {
          if (entry.arts[k] && Object.values(entry.arts[k]).some(usesKey)) { delete entry.arts[k]; changed = true; }
        }
        if (Object.keys(entry.arts).length === 0) delete entry.arts;
      }
    };
    for (const k in (obj.cards || {})) fixEntry(obj.cards[k]);
    for (const k in (obj.sideboard || {})) fixEntry(obj.sideboard[k]);
    if (usesKey(obj.deckPhoto)) { delete obj.deckPhoto; changed = true; }
    if (changed) {
      db.prepare('UPDATE decks SET data = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?')
        .run(JSON.stringify(obj), d.id, userId);
      count++;
    }
  }
  return count;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', async () => ({ ok: true }));

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', {
  preHandler: rateLimitAuth,
  schema: {
    body: {
      type: 'object',
      required: ['username', 'email', 'password'],
      properties: {
        username: { type: 'string', minLength: 2, maxLength: 32 },
        email:    { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 8, maxLength: 128 },
      },
    },
  },
}, async (req, reply) => {
  const { username, email, password } = req.body;

  const existing = db.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ?'
  ).get(username, email);

  if (existing) {
    return reply.code(409).send({ error: 'Username or email already taken.' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = db.prepare(
    'INSERT INTO users (username, email, password) VALUES (?, ?, ?)'
  ).run(username, email, hash);

  const user = { id: result.lastInsertRowid, username, email };
  const token = app.jwt.sign({ sub: user.id, username: user.username });
  return { token, user: { username, email } };
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', {
  preHandler: rateLimitAuth,
  schema: {
    body: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string' },
        password: { type: 'string' },
      },
    },
  },
}, async (req, reply) => {
  const { username, password } = req.body;

  const record = db.prepare(
    'SELECT id, username, email, password FROM users WHERE username = ?'
  ).get(username);

  if (!record) {
    return reply.code(401).send({ error: 'Invalid username or password.' });
  }

  const ok = await bcrypt.compare(password, record.password);
  if (!ok) {
    return reply.code(401).send({ error: 'Invalid username or password.' });
  }

  const token = app.jwt.sign({ sub: record.id, username: record.username });
  return { token, user: { username: record.username, email: record.email } };
});

// ── GET /api/decks  (all decks for authenticated user) ────────────────────────
app.get('/api/decks', { preHandler: authenticate }, async (req) => {
  const rows = db.prepare(
    'SELECT id, name, data, is_public, is_splash, splash_site, updated_at FROM decks WHERE user_id = ?'
  ).all(req.user.sub);

  return rows.map(r => ({
    id:          r.id,
    name:        r.name,
    public:      !!r.is_public,
    splashOwner: r.is_splash ? req.user.username : null,
    splashSite:  r.splash_site || null,
    updatedAt:   r.updated_at,
    ...JSON.parse(r.data),
  }));
});

// ── PUT /api/decks/:id  (create or update a single deck) ─────────────────────
app.put('/api/decks/:id', { preHandler: authenticate }, async (req, reply) => {
  const { id } = req.params;
  const { name, cards, sideboard, public: isPublic, splashOwner, splashSite, commander, deckPhoto, layout, defaultLayout } = req.body;

  if (!name || typeof cards !== 'object') {
    return reply.code(400).send({ error: 'name and cards are required.' });
  }

  // Serialize everything except top-level metadata into data blob
  const dataObj = { cards, sideboard: sideboard || {} };
  if (commander) dataObj.commander = commander;
  if (typeof deckPhoto === 'string') dataObj.deckPhoto = deckPhoto; // '' clears it
  if (layout && typeof layout === 'object') dataObj.layout = layout;            // free-drag positions
  if (typeof defaultLayout === 'string') dataObj.defaultLayout = defaultLayout; // 'cmc'|'type'|'user'
  const data = JSON.stringify(dataObj);
  const isSplash = splashOwner ? 1 : 0;
  // Allowed splash sites
  const VALID_SITES = ['mymagicdeck', 'myvintagedeck', 'mycommanderdeck'];
  const site = (splashSite && VALID_SITES.includes(splashSite)) ? splashSite : null;

  db.prepare(`
    INSERT INTO decks (id, user_id, name, data, is_public, is_splash, splash_site, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id, user_id) DO UPDATE SET
      name        = excluded.name,
      data        = excluded.data,
      is_public   = excluded.is_public,
      is_splash   = excluded.is_splash,
      splash_site = excluded.splash_site,
      updated_at  = unixepoch()
  `).run(id, req.user.sub, name, data, isPublic ? 1 : 0, isSplash, site);

  return { ok: true };
});

// ── DELETE /api/decks/:id ─────────────────────────────────────────────────────
app.delete('/api/decks/:id', { preHandler: authenticate }, async (req, reply) => {
  const { id } = req.params;
  const result = db.prepare(
    'DELETE FROM decks WHERE id = ? AND user_id = ?'
  ).run(id, req.user.sub);

  if (result.changes === 0) return reply.code(404).send({ error: 'Not found.' });
  return { ok: true };
});

// ── GET /api/users/:username/splash  (public, no auth needed) ────────────────
app.get('/api/users/:username/splash', async (req, reply) => {
  const { username } = req.params;

  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!user) return reply.code(404).send({ error: 'User not found.' });

  const deck = db.prepare(
    'SELECT id, name, data, is_public FROM decks WHERE user_id = ? AND is_splash = 1 AND is_public = 1'
  ).get(user.id);

  if (!deck) return reply.code(404).send({ error: 'No public splash deck.' });

  return {
    username: user.username,
    deck: {
      id:     deck.id,
      name:   deck.name,
      public: true,
      splashOwner: user.username,
      ...JSON.parse(deck.data),
    },
  };
});

// ── GET /api/site/:site/splash  (public splash for a specific site) ───────────
// site = 'mymagicdeck' | 'myvintagedeck' | 'mycommanderdeck'
app.get('/api/site/:site/splash', async (req, reply) => {
  const { site } = req.params;
  const VALID_SITES = ['mymagicdeck', 'myvintagedeck', 'mycommanderdeck'];
  if (!VALID_SITES.includes(site)) return reply.code(400).send({ error: 'Unknown site.' });

  const row = db.prepare(
    `SELECT d.id, d.name, d.data, u.username
     FROM decks d JOIN users u ON u.id = d.user_id
     WHERE d.splash_site = ? AND d.is_public = 1
     ORDER BY d.updated_at DESC LIMIT 1`
  ).get(site);

  if (!row) return reply.code(404).send({ error: 'No splash deck set for this site.' });

  return {
    username: row.username,
    deck: {
      id:         row.id,
      name:       row.name,
      public:     true,
      splashSite: site,
      splashOwner: row.username,
      ...JSON.parse(row.data),
    },
  };
});

// ── GET /api/decks/:id/share  (fetch a single public deck by id, no auth) ────
app.get('/api/decks/:id/share', async (req, reply) => {
  const { id } = req.params;
  const row = db.prepare(
    `SELECT d.id, d.name, d.data, d.is_public, d.is_splash, u.username
     FROM decks d JOIN users u ON u.id = d.user_id
     WHERE d.id = ? AND d.is_public = 1`
  ).get(id);

  if (!row) return reply.code(404).send({ error: 'Deck not found or not public.' });

  return {
    username: row.username,
    deck: {
      id:     row.id,
      name:   row.name,
      public: true,
      splashOwner: row.is_splash ? row.username : null,
      ...JSON.parse(row.data),
    },
  };
});

// ── GET /api/cards/refresh/status ─────────────────────────────────────────────
app.get('/api/cards/refresh/status', async () => ({
  ..._cardRefreshState,
  total: db.prepare('SELECT COUNT(*) as n FROM cards').get().n,
}));

// ── POST /api/cards/refresh  (manual trigger, no auth for convenience) ────────
app.post('/api/cards/refresh', async (req, reply) => {
  if (_cardRefreshRunning) return reply.code(409).send({ error: 'Refresh already running', state: _cardRefreshState });
  refreshCards(); // fire and forget
  return { ok: true, message: 'Refresh started' };
});

// ── Perceptual-hash index refresh (card identification) ───────────────────────
app.get('/api/cards/hash-refresh/status', async () => ({
  ..._hashState,
  indexed: db.prepare('SELECT COUNT(*) as n FROM card_hashes').get().n,
}));
app.post('/api/cards/hash-refresh', async (req, reply) => {
  if (_hashRunning) return reply.code(409).send({ error: 'Hash refresh already running', state: _hashState });
  refreshHashes(); // fire and forget
  return { ok: true, message: 'Hash refresh started' };
});

// ── GET /api/cards/search?q=...&page=1&per_page=40 ───────────────────────────
app.get('/api/cards/search', async (req, reply) => {
  const q = (req.query.q || '').trim();
  if (!q) return reply.code(400).send({ error: 'q is required' });

  const page    = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(175, parseInt(req.query.per_page || '40', 10));
  const offset  = (page - 1) * perPage;

  const total = db.prepare('SELECT COUNT(*) as n FROM cards').get().n;
  if (total === 0) {
    // No local data yet — tell frontend to fall back to Scryfall
    return reply.code(503).send({ error: 'Card database not yet seeded', fallback: true });
  }

  try {
    const { where, params, ftsTerms } = parseScryfallQuery(q);

    let rows;
    const limit = perPage + 1; // fetch one extra to know if there's a next page

    if (ftsTerms.length) {
      // FTS path
      const ftsQuery = ftsTerms.join(' ');
      const ftsWhere = where.length ? 'AND ' + where.join(' AND ') : '';
      const sql = `
        SELECT c.* FROM cards_fts
        JOIN cards c ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ?
        ${ftsWhere}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `;
      rows = db.prepare(sql).all(ftsQuery, ...params, limit, offset);
    } else if (where.length) {
      // Filter-only path (no text terms)
      const sql = `SELECT * FROM cards WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`;
      rows = db.prepare(sql).all(...params, limit, offset);
    } else {
      // Query parsed to no usable predicate — return an empty result set rather
      // than a 400, so the frontend shows "no results" instead of falling back
      // to Scryfall and hammering its rate limit.
      return { object: 'list', total_cards: 0, has_more: false, next_page: null, data: [] };
    }

    const hasMore = rows.length > perPage;
    if (hasMore) rows.pop();

    return {
      object:   'list',
      total_cards: rows.length,
      has_more: hasMore,
      next_page: hasMore ? `/api/cards/search?q=${encodeURIComponent(q)}&page=${page + 1}&per_page=${perPage}` : null,
      data: rows.map(cardRowToScryfall),
    };
  } catch (err) {
    app.log.warn('Card search error: ' + err.message);
    // Let the frontend fall back to Scryfall
    return reply.code(500).send({ error: err.message, fallback: true });
  }
});

// ── GET /api/cards/named?name=...&fuzzy=1 ────────────────────────────────────
app.get('/api/cards/named', async (req, reply) => {
  const name = (req.query.name || req.query.fuzzy || '').trim();
  if (!name) return reply.code(400).send({ error: 'name is required' });

  const total = db.prepare('SELECT COUNT(*) as n FROM cards').get().n;
  if (total === 0) return reply.code(503).send({ error: 'Card database not yet seeded', fallback: true });

  // Exact match first
  let row = db.prepare('SELECT * FROM cards WHERE name = ? COLLATE NOCASE').get(name);
  if (!row) {
    // FTS fallback
    try {
      const results = db.prepare(`
        SELECT c.* FROM cards_fts
        JOIN cards c ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ? ORDER BY rank LIMIT 1
      `).get(name);
      row = results;
    } catch (_) {}
  }
  if (!row) return reply.code(404).send({ object: 'error', details: `No card found named "${name}"` });
  return cardRowToScryfall(row);
});

// ── POST /api/uploads/card-art?autocrop=1  (custom card art for splash pages) ──
// Auth required. Verifies the image is a Magic card (best-effort), optionally
// auto-crops to the card, and stores small/normal/large WebP. Returns an
// image_uris override the client merges onto the stored card.
app.post('/api/uploads/card-art', { preHandler: [authenticate, rateLimitUpload] }, async (req, reply) => {
  const userId = req.user.sub;
  // Quota: count only card-art uploads.
  const cardCount = db.prepare("SELECT COUNT(*) n FROM uploads WHERE user_id = ? AND kind = 'card'").get(userId).n;
  if (cardCount >= UPLOAD_LIMIT) {
    return reply.code(409).send({ error: `Upload limit reached (${UPLOAD_LIMIT}). Delete some from My Uploads first.` });
  }

  const autocrop = String(req.query.autocrop ?? '1') !== '0' && String(req.query.autocrop ?? 'true') !== 'false';
  const expectedName = (req.query.name || '').toString().trim() || null;
  const expectedOracle = (req.query.oracle || '').toString().trim() || null;

  let data;
  try { data = await req.file(); } catch (e) { return reply.code(400).send({ error: 'Upload failed: ' + e.message }); }
  if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
  if (!/^image\//.test(data.mimetype || '')) return reply.code(400).send({ error: 'File must be an image.' });

  let buf;
  try { buf = await data.toBuffer(); }
  catch (e) {
    if (data.file?.truncated) return reply.code(413).send({ error: 'Image is too large (max 12 MB).' });
    return reply.code(400).send({ error: 'Could not read upload.' });
  }
  if (data.file?.truncated) return reply.code(413).send({ error: 'Image is too large (max 12 MB).' });

  try { buf = await toProcessable(buf, data.mimetype); }
  catch (e) { app.log.warn('image decode/convert failed: ' + e.message); return reply.code(400).send({ error: 'Could not read this image. Please upload a JPEG, PNG, or HEIC photo.' }); }

  try { await sharp(buf).metadata(); }
  catch { return reply.code(400).send({ error: 'Unsupported or corrupt image.' }); }

  const guessName = (req.query.guess || '').toString().trim() || null;
  let readMana = (req.query.mana || '').toString().trim() || null;
  const clientCorners = parseCornersParam(req.query.corners);

  // If the client sends manually-adjusted corners (the cropper), trust them and skip
  // the vision call — it already ran during /analyze. Otherwise run the auto vision gate.
  let corners = null, bbox = null, visionName = guessName;
  if (clientCorners) {
    corners = clientCorners;
  } else {
    const v = await verifyAndLocateCard(buf, expectedName);
    if (v.verified && v.isCard === false && v.confidence >= 0.7) {
      return reply.code(422).send({ error: "That doesn't look like a Magic card. Try a clearer, straight-on photo of the card." });
    }
    visionName = guessName || v.cardName;
    readMana = readMana || v.manaCost;
    corners = autocrop ? v.corners : null;
    bbox = autocrop ? v.bbox : null;
  }

  let sizes;
  try { sizes = await processCardImage(buf, bbox, corners); }
  catch (e) { app.log.warn('card image processing failed: ' + e.message); return reply.code(400).send({ error: 'Could not process image.' }); }

  // Identify via the staged cascade (name → cmc → pHash-within-candidates → escalate).
  const { key, urls } = storeImageSet(userId, sizes);
  const id = await cascadeIdentify({ cropBuf: sizes.normal, readName: visionName, readMana, expectedName, expectedOracle });
  const row = db.prepare(`INSERT INTO uploads (user_id, key, kind, card_name, oracle_id, confirmed, small, normal, large)
    VALUES (?, ?, 'card', ?, ?, ?, ?, ?, ?)`).run(
    userId, key, id.cardName, id.oracleId, id.confirmed, urls.small, urls.normal, urls.large);

  return {
    image_uris: urls, customArt: true, autoCropped: !!(corners || bbox),
    uploadId: row.lastInsertRowid, cardName: id.cardName, oracleId: id.oracleId, confirmed: !!id.confirmed,
    idSource: id.source || null,
  };
});

// ── POST /api/uploads/analyze  (vision pass for the cropper — no store/quota) ──
// Returns the suggested corners (to seed the draggable handles), the read card
// name, and the is-card check. The actual crop happens later via /card-art with
// the user-adjusted corners.
app.post('/api/uploads/analyze', { preHandler: [authenticate, rateLimitUpload] }, async (req, reply) => {
  const expectedName = (req.query.name || '').toString().trim() || null;
  const expectedOracle = (req.query.oracle || '').toString().trim() || null;
  let data;
  try { data = await req.file(); } catch (e) { return reply.code(400).send({ error: 'Upload failed: ' + e.message }); }
  if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
  if (!/^image\//.test(data.mimetype || '')) return reply.code(400).send({ error: 'File must be an image.' });
  let buf;
  try { buf = await data.toBuffer(); } catch { return reply.code(413).send({ error: 'Image is too large (max 12 MB).' }); }
  if (data.file?.truncated) return reply.code(413).send({ error: 'Image is too large (max 12 MB).' });
  try { buf = await toProcessable(buf, data.mimetype); }
  catch { return reply.code(400).send({ error: 'Could not read this image. Please upload a JPEG, PNG, or HEIC photo.' }); }
  try { await sharp(buf).metadata(); }
  catch { return reply.code(400).send({ error: 'Unsupported or corrupt image.' }); }

  // Corners from OpenCV (reliable); name/is-card from the VLM. Run in parallel.
  const [v, cvCorners] = await Promise.all([
    verifyAndLocateCard(buf, expectedName),
    detectCornersCV(buf),
  ]);
  const id = resolveCardIdentity(v.cardName, expectedOracle, expectedName);
  return {
    isMagicCard: v.isCard !== false,
    confidence: v.confidence || 0,
    corners: cvCorners,   // OpenCV document-scanner corners (VLM corners were unreliable)
    bbox: v.bbox,
    cardName: id.cardName, oracleId: id.oracleId, confirmed: !!id.confirmed,
    manaCost: v.manaCost || null,
  };
});

// ── POST /api/uploads/deck-photo  (full-deck photo for the splash header) ──────
app.post('/api/uploads/deck-photo', { preHandler: [authenticate, rateLimitUpload] }, async (req, reply) => {
  let data;
  try { data = await req.file(); } catch (e) { return reply.code(400).send({ error: 'Upload failed: ' + e.message }); }
  if (!data) return reply.code(400).send({ error: 'No file uploaded.' });
  if (!/^image\//.test(data.mimetype || '')) return reply.code(400).send({ error: 'File must be an image.' });

  let buf;
  try { buf = await data.toBuffer(); }
  catch { return reply.code(413).send({ error: 'Image is too large (max 12 MB).' }); }
  if (data.file?.truncated) return reply.code(413).send({ error: 'Image is too large (max 12 MB).' });

  try { buf = await toProcessable(buf, data.mimetype); }
  catch (e) { app.log.warn('deck-photo decode/convert failed: ' + e.message); return reply.code(400).send({ error: 'Could not read this image. Please upload a JPEG, PNG, or HEIC photo.' }); }

  let out;
  try {
    out = await sharp(buf, { failOn: 'none' }).rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
  } catch { return reply.code(400).send({ error: 'Could not process image.' }); }

  const userId = req.user.sub;
  const dir = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const key = 'deck_' + crypto.randomBytes(8).toString('hex');
  const fname = key + '.webp';
  fs.writeFileSync(path.join(dir, fname), out);
  const url = `/u/${userId}/${fname}`;
  db.prepare(`INSERT INTO uploads (user_id, key, kind, small, normal, large) VALUES (?, ?, 'deck', ?, ?, ?)`)
    .run(userId, key, url, url, url);
  return { url };
});

// ── GET /api/uploads  (the user's image library + quota) ──────────────────────
app.get('/api/uploads', { preHandler: authenticate }, async (req) => {
  const rows = db.prepare(`SELECT id, kind, card_name, oracle_id, confirmed, small, normal, large, created_at
    FROM uploads WHERE user_id = ? ORDER BY created_at DESC, id DESC`).all(req.user.sub);
  return {
    uploads: rows.map(r => ({ ...r, confirmed: !!r.confirmed })),
    cardCount: rows.filter(r => r.kind === 'card').length,
    limit: UPLOAD_LIMIT,
  };
});

// ── PATCH /api/uploads/:id  (set/confirm which card an upload depicts) ─────────
app.patch('/api/uploads/:id', { preHandler: authenticate }, async (req, reply) => {
  const userId = req.user.sub, id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM uploads WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return reply.code(404).send({ error: 'Not found.' });
  let { cardName, oracleId } = req.body || {};
  if (oracleId) {
    const c = db.prepare('SELECT name FROM cards WHERE oracle_id = ?').get(oracleId);
    if (!c) return reply.code(400).send({ error: 'Unknown card.' });
    cardName = c.name;
  } else if (cardName) {
    const c = lookupCardRowByName(cardName);
    if (c) { oracleId = c.oracle_id; cardName = c.name; }
  }
  db.prepare('UPDATE uploads SET card_name = ?, oracle_id = ?, confirmed = 1 WHERE id = ? AND user_id = ?')
    .run(cardName || null, oracleId || null, id, userId);
  return { ok: true, cardName: cardName || null, oracleId: oracleId || null, confirmed: true };
});

// ── DELETE /api/uploads/:id  (remove files + row, auto-revert decks) ──────────
app.delete('/api/uploads/:id', { preHandler: authenticate }, async (req, reply) => {
  const userId = req.user.sub, id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return reply.code(404).send({ error: 'Not found.' });
  const dir = path.join(UPLOAD_DIR, String(userId));
  try {
    for (const f of fs.readdirSync(dir)) { if (f.startsWith(row.key)) fs.rmSync(path.join(dir, f), { force: true }); }
  } catch (_) { /* dir may not exist */ }
  db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(id, userId);
  const revertedDecks = revertDeletedUploadFromDecks(userId, row.key);
  return { ok: true, revertedDecks };
});

// ── Shareable deck-sheet renderer ─────────────────────────────────────────────
const BG_DIR = path.join(UPLOAD_DIR, '_bg'); // placeholder/share backgrounds, served at /u/_bg/<key>.png
const _xmlEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Fetch a card image for compositing. Allowlist: our own /u/ files + cards.scryfall.io (anti-SSRF).
async function _loadShareCardBuf(url, cache) {
  if (cache.has(url)) return cache.get(url);
  let buf = null;
  try {
    if (typeof url === 'string' && url.startsWith('/u/')) {
      const resolved = path.resolve(path.join(UPLOAD_DIR, url.replace(/^\/u\//, '')));
      if (resolved.startsWith(path.resolve(UPLOAD_DIR)) && fs.existsSync(resolved)) buf = fs.readFileSync(resolved);
    } else if (typeof url === 'string') {
      const u = new URL(url);
      if (u.protocol === 'https:' && u.hostname === 'cards.scryfall.io') {
        const tmp = path.join(os.tmpdir(), 'shr-' + crypto.randomBytes(6).toString('hex'));
        await streamDownload(url, tmp);
        buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
      }
    }
  } catch (_) { buf = null; }
  cache.set(url, buf); return buf;
}

// Build an SVG overlay for the enabled text/stat elements (composited on top).
function buildOverlaySVG(geo, overlays, meta) {
  overlays = overlays || {}; meta = meta || {};
  const { W, H, bandH, contentTop, contentH } = geo;
  const parts = [];
  const FONT = 'DejaVu Sans, sans-serif';
  // Header band: deck title "<name> by <author>" (always rendered if name is on).
  if (overlays.name && meta.deckName) {
    const title = meta.deckName + (meta.author ? ' by ' + meta.author : '');
    const fs = Math.max(20, Math.min(Math.round(bandH * 0.5), 64));
    const cy = Math.round(bandH * 0.66);
    parts.push(`<text x="${Math.round(W / 2)}" y="${cy}" text-anchor="middle" font-family="${FONT}" font-size="${fs}" font-weight="bold" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(2, Math.round(fs / 16))}" paint-order="stroke">${_xmlEsc(title)}</text>`);
    if (overlays.price && meta.priceText)
      parts.push(`<text x="${W - 24}" y="${cy}" text-anchor="end" font-family="${FONT}" font-size="${Math.round(fs * 0.55)}" fill="#eaeaea" stroke="#000000" stroke-width="2" paint-order="stroke">${_xmlEsc(meta.priceText)}</text>`);
  }
  // CMC curve — top-left of the content area.
  if (overlays.cmcCurve && Array.isArray(meta.curve) && meta.curve.length) {
    const cwid = 230, chgt = 120, x0 = 24, y0 = contentTop + 14;
    const max = Math.max(1, ...meta.curve.map(c => c.count));
    const bw = cwid / meta.curve.length;
    parts.push(`<rect x="${x0 - 8}" y="${y0 - 8}" width="${cwid + 16}" height="${chgt + 28}" rx="8" fill="rgba(0,0,0,0.45)"/>`);
    meta.curve.forEach((c, i) => {
      const bh = Math.round((chgt - 16) * c.count / max);
      const bx = x0 + i * bw;
      parts.push(`<rect x="${bx + 3}" y="${y0 + (chgt - 16) - bh}" width="${bw - 6}" height="${bh}" fill="#7de0a0"/>`);
      parts.push(`<text x="${bx + bw / 2}" y="${y0 + chgt + 6}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="#cfcfcf">${_xmlEsc(c.label)}</text>`);
    });
  }
  // Deck list — top-right of the content area.
  if (overlays.list && Array.isArray(meta.list) && meta.list.length) {
    const colCount = meta.list.length > 30 ? 2 : 1, perCol = Math.ceil(meta.list.length / colCount);
    const lineH = 22, padX = 14, colW = 240, panelW = colW * colCount + padX, py = contentTop + 14;
    const panelH = Math.min(perCol * lineH + 36, contentH - 28);
    const px = W - panelW - 18;
    parts.push(`<rect x="${px}" y="${py}" width="${panelW}" height="${panelH}" rx="8" fill="rgba(0,0,0,0.55)"/>`);
    parts.push(`<text x="${px + padX}" y="${py + 24}" font-family="${FONT}" font-size="16" font-weight="bold" fill="#fff">Deck list</text>`);
    meta.list.forEach((ln, i) => {
      const col = Math.floor(i / perCol), row = i % perCol;
      const lx = px + padX + col * colW, ly = py + 46 + row * lineH;
      if (ly < py + panelH - 6) parts.push(`<text x="${lx}" y="${ly}" font-family="${FONT}" font-size="14" fill="#e0e0e0">${_xmlEsc(ln)}</text>`);
    });
  }
  // Type breakdown — in the footer band.
  if (overlays.typeBreakdown && Array.isArray(meta.typeSeg) && meta.typeSeg.length) {
    const total = meta.typeSeg.reduce((s, t) => s + t.count, 0) || 1;
    const barH = Math.max(24, Math.min(38, bandH - 10));
    const y = contentTop + contentH + Math.round((bandH - barH) / 2);
    const x0 = 20, barW = W - 40; let x = x0;
    parts.push(`<rect x="${x0}" y="${y}" width="${barW}" height="${barH}" rx="6" fill="rgba(0,0,0,0.4)"/>`);
    for (const t of meta.typeSeg) {
      const w = barW * t.count / total;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barH}" fill="${/^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : '#555'}"/>`);
      if (w > 42) parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${(y + barH * 0.66).toFixed(0)}" text-anchor="middle" font-family="${FONT}" font-size="16" fill="#fff">${_xmlEsc(t.label)} ${t.count}</text>`);
      x += w;
    }
  }
  if (!parts.length) return null;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
}

// ── POST /api/splash/render  → composited PNG of the deck ─────────────────────
app.post('/api/splash/render', { preHandler: [authenticate, rateLimitUpload] }, async (req, reply) => {
  const b = req.body || {};
  const W = Math.min(4000, Math.max(200, parseInt(b.width) || 1000));
  const ch = Math.min(5400, Math.max(200, parseInt(b.height) || 1400)); // card-content height
  const bandH = Math.round(ch / 18);                                     // header == footer; bands total 10% of the image
  const H = ch + bandH * 2;                                              // full canvas (content + header + footer)
  const cards = Array.isArray(b.cards) ? b.cards.slice(0, 400) : [];

  let base;
  const bg = b.background;
  // A user-generated background (AI scene) lives under the caller's own upload dir.
  if (typeof bg === 'string' && bg.startsWith('/u/')) {
    const userRoot = path.resolve(path.join(UPLOAD_DIR, String(req.user.sub))) + path.sep;
    const resolved = path.resolve(path.join(UPLOAD_DIR, bg.replace(/^\/u\//, '')));
    if (resolved.startsWith(userRoot) && fs.existsSync(resolved)) base = sharp(resolved).resize(W, H, { fit: 'cover' });
  }
  if (!base && bg && /^[a-z0-9_-]+$/i.test(bg)) {
    const bp = path.join(BG_DIR, bg + '.png');
    if (fs.existsSync(bp)) base = sharp(bp).resize(W, H, { fit: 'cover' });
  }
  if (!base) {
    const color = (typeof bg === 'string' && /^#[0-9a-f]{3,8}$/i.test(bg)) ? bg : '#0e1116';
    base = sharp({ create: { width: W, height: H, channels: 4, background: color } });
  }
  let img = await base.png().toBuffer();

  const cache = new Map();
  const comps = [];
  for (const c of cards) {
    if (!c || typeof c.url !== 'string') continue;
    const buf = await _loadShareCardBuf(c.url, cache);
    if (!buf) continue;
    let left = Math.round(c.x || 0), top = Math.round(c.y || 0) + bandH; // offset cards into the content band
    if (left < 0 || top < 0 || left >= W || top >= H) continue;
    let w = Math.max(1, Math.round(c.w || 100)), h = Math.max(1, Math.round(c.h || 140));
    if (left + w > W) w = W - left;
    if (top + h > H) h = H - top;
    if (w < 1 || h < 1) continue;
    try { comps.push({ input: await sharp(buf).resize(w, h, { fit: 'fill' }).png().toBuffer(), left, top }); } catch (_) { }
  }
  if (comps.length) img = await sharp(img).composite(comps).png().toBuffer();

  const svg = buildOverlaySVG({ W, H, bandH, contentTop: bandH, contentH: ch }, b.overlays || {}, b.meta || {});
  if (svg) { try { img = await sharp(img).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer(); } catch (e) { app.log.warn('overlay render failed: ' + e.message); } }

  reply.header('Content-Type', 'image/png');
  reply.header('Cache-Control', 'no-store');
  return reply.send(img);
});

// ── AI splash background generation (constrained prompts; dormant until IMG_GEN_URL) ──
// Closed word-lists only — the user can't enter free text, which limits misuse. A hidden
// "whimsy" modifier is appended server-side (never shown to the user).
const BG_SCENES = {
  desert: 'a vast open desert', forest: 'a deep green forest', 'random-biome': 'a strange unexpected biome',
  ascii: 'retro green ASCII art on black', tokyo: 'the neon streets of Tokyo', space: 'deep outer space',
  underwater: 'a calm underwater seascape', mountains: 'snowy mountain peaks', city: 'a sprawling cityscape',
  void: 'an endless empty void', dream: 'a surreal dreamscape', swamp: 'a murky swamp',
  volcano: 'a smoldering volcano', library: 'an ancient library', tavern: 'a cozy fantasy tavern',
  meadow: 'a sunny wildflower meadow', cosmos: 'a swirling galaxy',
};
const BG_VIBES = {
  none: '', cozy: 'cozy', epic: 'epic and grand', eerie: 'eerie', cheerful: 'cheerful',
  mysterious: 'mysterious', chaotic: 'chaotic', serene: 'serene and calm', retro: 'retro',
};
const BG_WHIMSY = [
  'rendered loosely and simply, gestural not photorealistic, with one delightfully out-of-place detail',
  'as a minimal, playful sketch — charmingly a little bit wrong, not realistic',
  'in a naive doodly style with flat shapes and an unexpected whimsical twist',
  'simple and a touch silly, gestured-at rather than detailed, definitely not photoreal',
];
function buildBgPrompt(slots) {
  slots = slots || {};
  const scene = BG_SCENES[slots.scene];
  if (!scene) return null; // scene must be from the list
  const vibe = BG_VIBES[(slots.vibe || 'none')] || '';
  const whimsy = BG_WHIMSY[Math.floor(Math.random() * BG_WHIMSY.length)];
  return `A background scene of ${scene}${vibe ? `, ${vibe}` : ''}. ${whimsy}. ` +
    `An empty backdrop with no playing cards and no text, leaving room to place cards on top.`;
}
app.post('/api/splash/bg-generate', { preHandler: [authenticate, rateLimitUpload] }, async (req, reply) => {
  const prompt = buildBgPrompt((req.body || {}).slots);
  if (!prompt) return reply.code(400).send({ error: 'Pick a scene from the list.' });
  if (!IMG_GEN_URL) return reply.code(503).send({ error: 'AI backgrounds aren’t enabled yet — coming soon.', enabled: false });
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), IMG_GEN_TIMEOUT);
  try {
    const r = await fetch(IMG_GEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
    });
    if (!r.ok) throw new Error('image-gen HTTP ' + r.status);
    let buf;
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('image/')) buf = Buffer.from(await r.arrayBuffer());
    else { const j = await r.json(); const b64 = j.image || j.b64_json || j.base64 || j.data?.[0]?.b64_json || j.data?.[0]?.base64; if (!b64) throw new Error('no image in response'); buf = Buffer.from(b64, 'base64'); }
    const dir = path.join(UPLOAD_DIR, String(req.user.sub)); fs.mkdirSync(dir, { recursive: true });
    const fname = 'bg_' + crypto.randomBytes(8).toString('hex') + '.png';
    await sharp(buf).png().toFile(path.join(dir, fname));
    return { url: '/u/' + req.user.sub + '/' + fname };
  } catch (e) {
    app.log.warn('bg-generate failed: ' + e.message);
    return reply.code(502).send({ error: 'Scene generation failed. Try again.' });
  } finally { clearTimeout(timer); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  scheduleCardRefresh();
  loadHashIndex();
  loadNameIndex();
});
