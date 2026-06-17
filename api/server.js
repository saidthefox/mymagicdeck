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
// Fail closed: a default/weak JWT secret lets anyone forge a session for any account.
if (JWT_SECRET === 'change-me-in-production' || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is unset, default, or too weak (<32 chars). Set a strong MYMAGICDECK_JWT_SECRET. Refusing to start.');
  process.exit(1);
}
// Admin key for maintenance endpoints (card/hash refresh). If unset, those
// endpoints are disabled over HTTP entirely (the daily auto-refresh still runs
// internally via scheduleCardRefresh, so this only locks down the manual triggers).
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const BOT_API_KEY = process.env.BOT_API_KEY || ''; // service key for the Discord bot integration (in /srv/docker/.env)
// Password-reset email (Resend). Dormant until RESEND_API_KEY is set: the forgot
// endpoint still 200s (no account-existence leak) but no mail goes out.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM    = process.env.RESEND_FROM || 'MyMagicDeck <noreply@mymagicdeck.com>';
const APP_BASE_URL   = (process.env.APP_BASE_URL || 'https://mymagicdeck.com').replace(/\/+$/, '');
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

// Migration: columns the mobile "guess" engine needs (power/toughness to filter,
// edhrec_rank to rank by popularity). ADD COLUMN throws if it already exists — ignore.
for (const [col, type] of [['power', 'TEXT'], ['toughness', 'TEXT'], ['edhrec_rank', 'INTEGER']]) {
  try { db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`); } catch (_) { /* exists */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_cards_edhrec ON cards(edhrec_rank)');

// Per-user "filesystem" for the Win95 desktop: folder tree + deck→folder map, as
// one JSON blob synced across devices. {folders:[{id,name,parent}], deckFolder:{}}
db.exec(`CREATE TABLE IF NOT EXISTS user_fs (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);`);
// Per-account desktop layout: mounted widgets + notes (so a pinned layout follows the
// account across log-out / log-in / browsers, not just one device's localStorage).
db.exec(`CREATE TABLE IF NOT EXISTS user_desktop (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);`);

// oracle_id → every set it's been printed in (for set-list formats like
// Middle School / Alpha-to-Alliances-Ante that Scryfall doesn't track as legalities).
db.exec(`CREATE TABLE IF NOT EXISTS card_printings (
  oracle_id TEXT NOT NULL,
  set_code  TEXT NOT NULL,
  PRIMARY KEY (oracle_id, set_code)
) WITHOUT ROWID;`);
db.exec('CREATE INDEX IF NOT EXISTS idx_printings_set ON card_printings(set_code)');

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

  CREATE TABLE IF NOT EXISTS upload_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id   INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    reporter    INTEGER,                       -- user id if logged in, else null
    reason      TEXT,
    ip          TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_reports_upload ON upload_reports(upload_id);

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  TEXT    PRIMARY KEY,           -- sha256 of the emailed token
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
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

// Card Duel — ephemeral online battle rooms (no account needed; code + per-player token).
db.exec(`CREATE TABLE IF NOT EXISTS battles (
  code        TEXT PRIMARY KEY,
  target_name TEXT NOT NULL,
  state       TEXT NOT NULL,          -- JSON: { clues, revealed, guesses, scores, players, status, winner, target }
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
)`);
// Reap rooms older than 6h.
setInterval(() => { try { db.prepare('DELETE FROM battles WHERE updated_at < ?').run(Math.floor(Date.now()/1000) - 6*3600); } catch (_) {} }, 30*60*1000);

// App-level error monitoring — a capped ring of recent server + client errors (admin-viewable).
db.exec(`CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  kind TEXT NOT NULL,        -- 'server' | 'client'
  where_ TEXT, message TEXT, stack TEXT, ua TEXT
)`);
function recordError(kind, f) {
  try {
    db.prepare('INSERT INTO errors (kind, where_, message, stack, ua) VALUES (?,?,?,?,?)').run(
      kind, (f.where || '').slice(0, 300), (f.message || '').slice(0, 1000), (f.stack || '').slice(0, 4000), (f.ua || '').slice(0, 300));
    db.prepare('DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 500)').run();
  } catch (_) {}
}

// ── Tournaments ────────────────────────────────────────────────────────────────
// Posters create tournaments (with match parameters); players create subscriptions
// (the parameters they want). The feed matches the two. Events flow to the Calendar
// + a desktop widget on the frontend. Param schema is intentionally simple (v1) —
// format / mode / region / level / entry fee / date — and can grow later.
db.exec(`CREATE TABLE IF NOT EXISTS tournaments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'Other',   -- Modern, Commander, Standard, Pioneer, Legacy, Pauper, Limited, Other
  mode        TEXT NOT NULL DEFAULT 'in-person',-- 'online' | 'in-person'
  region      TEXT DEFAULT '',                  -- free text (city/state, or 'Online')
  date        TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  time        TEXT DEFAULT '',
  level       TEXT NOT NULL DEFAULT 'casual',   -- 'casual' | 'competitive' | 'pro'
  entry_fee   REAL DEFAULT 0,
  url         TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tournaments_date ON tournaments(date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tournaments_host ON tournaments(host_id)');
db.exec(`CREATE TABLE IF NOT EXISTS tournament_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT 'My subscription',
  formats     TEXT DEFAULT '',                  -- CSV of formats; '' = any
  mode        TEXT NOT NULL DEFAULT 'any',       -- 'online' | 'in-person' | 'any'
  region      TEXT DEFAULT '',                  -- substring match; '' = any
  level       TEXT NOT NULL DEFAULT 'any',       -- 'any' | 'casual' | 'competitive' | 'pro'
  max_entry   REAL,                             -- NULL = any
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tsubs_user ON tournament_subs(user_id)');
// Geo columns (added later): tournaments get a geocoded venue; subs get free-typed
// regions + an optional radius-around-a-point. Geocoding happens client-side (Photon);
// we just store the structured result and match on it.
for (const [col, type] of [['lat','REAL'],['lon','REAL'],['address','TEXT'],['country','TEXT'],['state','TEXT'],['proxies','INTEGER DEFAULT 0'],['source',"TEXT DEFAULT ''"]]) {
  try { db.exec(`ALTER TABLE tournaments ADD COLUMN ${col} ${type}`); } catch (_) { /* exists */ }
}
for (const [col, type] of [['regions','TEXT'],['center_lat','REAL'],['center_lon','REAL'],['center_label','TEXT'],['radius','REAL'],['radius_unit','TEXT'],['proxies',"TEXT DEFAULT 'any'"]]) {
  try { db.exec(`ALTER TABLE tournament_subs ADD COLUMN ${col} ${type}`); } catch (_) { /* exists */ }
}
// RSVPs: one row per (tournament, user). status: going | maybe | no.
db.exec(`CREATE TABLE IF NOT EXISTS tournament_rsvps (
  tournament_id INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tournament_id, user_id)
)`);

// ── Mail (async inbox): system/subscription mail + admin messages. No user→user yet. ──
db.exec(`CREATE TABLE IF NOT EXISTS mail (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  from_kind  TEXT NOT NULL DEFAULT 'system',   -- 'system' | 'admin'
  from_label TEXT DEFAULT '',
  subject    TEXT NOT NULL,
  body       TEXT DEFAULT '',
  link       TEXT DEFAULT '',                  -- e.g. 'tournament:42' → opens that page client-side
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mail_user ON mail(user_id, is_read)');
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch (_) { /* exists */ }
try { db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(process.env.ADMIN_USERNAME || 'jake'); } catch (_) {}
function isAdminUser(id) { try { const r = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id); return !!(r && r.is_admin); } catch (_) { return false; } }
function mailSend(userId, { from_kind = 'system', from_label = '', subject, body = '', link = '' }) {
  try { db.prepare('INSERT INTO mail (user_id, from_kind, from_label, subject, body, link) VALUES (?,?,?,?,?,?)')
    .run(userId, from_kind, String(from_label).slice(0, 60), String(subject).slice(0, 160), String(body).slice(0, 4000), String(link).slice(0, 200)); } catch (_) {}
}

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
         keywords, legalities, set_id, set_name, rarity, image_uris, card_faces, prices,
         power, toughness, edhrec_rank, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
      ON CONFLICT(oracle_id) DO UPDATE SET
        name=excluded.name, mana_cost=excluded.mana_cost, cmc=excluded.cmc,
        type_line=excluded.type_line, oracle_text=excluded.oracle_text,
        colors=excluded.colors, color_identity=excluded.color_identity,
        keywords=excluded.keywords, legalities=excluded.legalities,
        set_id=excluded.set_id, set_name=excluded.set_name, rarity=excluded.rarity,
        image_uris=excluded.image_uris, card_faces=excluded.card_faces,
        prices=excluded.prices, power=excluded.power, toughness=excluded.toughness,
        edhrec_rank=excluded.edhrec_rank, updated_at=unixepoch()
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
          JSON.stringify({ usd: c.prices?.usd || null, usd_foil: c.prices?.usd_foil || null }),
          c.power ?? c.card_faces?.[0]?.power ?? null,
          c.toughness ?? c.card_faces?.[0]?.toughness ?? null,
          Number.isInteger(c.edhrec_rank) ? c.edhrec_rank : null
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

// Real client IP for rate-limit keys + abuse logs. The chain is
// client → Cloudflare → nginx → app. Cloudflare sets CF-Connecting-IP
// (authoritative; clients can't forge it through CF). nginx appends the real
// peer to the RIGHT of X-Forwarded-For, so the rightmost XFF entry is the
// trustworthy one — the *leftmost* is attacker-supplied and must never be used
// as a key (it let anyone get a fresh bucket per request and bypass every limit).
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) { const p = String(xff).split(',').map(s => s.trim()).filter(Boolean); if (p.length) return p[p.length - 1]; }
  return req.ip || 'unknown';
}

function rateLimitAuth(req, reply, done) {
  const ip = clientIp(req);
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

// Gate for maintenance endpoints: requires the x-admin-key header to match
// ADMIN_API_KEY. If the key isn't configured, the endpoint is disabled (503).
async function adminOnly(req, reply) {
  if (!ADMIN_API_KEY) {
    return reply.code(503).send({ error: 'Maintenance endpoints are disabled.' });
  }
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
}

// ── Upload rate limiter (per user/IP) ──────────────────────────────────────────
const _uploadBuckets = new Map();
const UPLOAD_WINDOW = 15 * 60 * 1000;
const UPLOAD_MAX = 60; // uploads per window

function rateLimitUpload(req, reply, done) {
  const key = req.user?.sub || clientIp(req);
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

// ── AI-background limiter (much stricter than uploads) ─────────────────────────
// Diffusion runs on the 207 box, which brownout-crashes under heavy concurrent
// load. So: a tight per-user budget AND a global in-flight cap so we never fan
// out multiple GPU jobs at once (the image server serializes anyway; this keeps
// requests from piling up and timing out).
const _bgBuckets = new Map();
const BG_WINDOW = 15 * 60 * 1000;
const BG_MAX = parseInt(process.env.BG_MAX || '6', 10);          // per user / 15 min
const BG_CONCURRENCY = parseInt(process.env.BG_CONCURRENCY || '1', 10); // global in-flight
let _bgInFlight = 0;
function rateLimitBgGen(req, reply, done) {
  const key = req.user?.sub || clientIp(req);
  const now = Date.now();
  let bucket = _bgBuckets.get(key);
  if (!bucket || now - bucket.start > BG_WINDOW) { bucket = { start: now, count: 0 }; _bgBuckets.set(key, bucket); }
  bucket.count++;
  if (bucket.count > BG_MAX) {
    reply.code(429).send({ error: 'You’ve generated a lot of backgrounds — please wait a few minutes.' });
    return;
  }
  done();
}
setInterval(() => {
  const cutoff = Date.now() - BG_WINDOW;
  for (const [k, b] of _bgBuckets) if (b.start < cutoff) _bgBuckets.delete(k);
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

// Populate card_printings (oracle_id → set codes) from Scryfall's default_cards
// bulk (one row per printing). Lightweight: no image work, batched inserts.
let _printState = { status: 'idle', done: 0, started: null, finished: null, error: null };
let _printRunning = false;
async function refreshPrintings() {
  if (_printRunning) return;
  _printRunning = true;
  _printState = { status: 'fetching-index', done: 0, started: Date.now(), finished: null, error: null };
  const tmpFile = path.join(os.tmpdir(), 'mmd-default-cards.json');
  try {
    const idx = await httpsGet('https://api.scryfall.com/bulk-data');
    const entry = JSON.parse(idx.body).data.find(d => d.type === 'default_cards');
    if (!entry) throw new Error('default_cards bulk entry not found');
    _printState.status = 'downloading';
    await streamDownload(entry.download_uri, tmpFile);
    _printState.status = 'importing';
    const insert = db.prepare('INSERT OR IGNORE INTO card_printings (oracle_id, set_code) VALUES (?,?)');
    const flush = db.transaction(rows => { for (const r of rows) insert.run(r[0], r[1]); });
    const { parser } = require('stream-json');
    const { streamArray } = require('stream-json/streamers/StreamArray');
    const stream = fs.createReadStream(tmpFile).pipe(parser()).pipe(streamArray());
    let batch = [];
    await new Promise((resolve, reject) => {
      stream.on('data', ({ value: c }) => {
        const oid = c && (c.oracle_id || (c.card_faces && c.card_faces[0] && c.card_faces[0].oracle_id));
        if (oid && c.set) { batch.push([oid, c.set]); _printState.done++; if (batch.length >= 3000) { flush(batch); batch = []; } }
      });
      stream.on('end', () => { try { if (batch.length) flush(batch); resolve(); } catch (e) { reject(e); } });
      stream.on('error', reject);
    });
    _printState = { ..._printState, status: 'done', finished: Date.now() };
    app.log.info('Printings refresh complete: ' + _printState.done + ' printings');
  } catch (err) {
    _printState = { ..._printState, status: 'error', error: err.message, finished: Date.now() };
    app.log.error('Printings refresh failed: ' + err.message);
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch (_) { }
    _printRunning = false;
  }
}
// Custom set-list formats Scryfall doesn't track as legalities.
const CUSTOM_FORMATS = {
  middleschool: {
    sets: ['4ed','chr','ice','hml','all','mir','vis','5ed','wth','tmp','sth','exo','usg','ulg','6ed','uds','mmq','nem','pcy','inv','pls','7ed','apc','ody','tor','jud','ons','lgn','scg','por','p02','ptk','s99','ath','brb','btd','dkm','wc97','wc98','wc99','wc00','wc01','wc02','wc03'],
    banned: ['amulet of quoz','balance','brainstorm','bronze tablet','channel','dark ritual','demonic consultation','flash','goblin recruiter','imperial seal','jeweled bird','mana crypt','mana vault','memory jar',"mind's desire",'mind twist','rebirth','strip mine','tempest efreet','timmerian fiends','tolarian academy','vampiric tutor','windfall',"yawgmoth's bargain","yawgmoth's will"],
  },
  aaa: { // Alpha to Alliances Ante
    sets: ['lea','leb','2ed','ced','cei','arn','atq','3ed','leg','drk','fem','ice','hml','all'],
    banned: [],
  },
};

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

// Fully remove an upload (any owner) — files + row + revert that owner's decks.
// Shared by the owner's DELETE and the admin takedown.
function purgeUpload(row) {
  const dir = path.join(UPLOAD_DIR, String(row.user_id));
  try { for (const f of fs.readdirSync(dir)) { if (f.startsWith(row.key)) fs.rmSync(path.join(dir, f), { force: true }); } }
  catch (_) { /* dir may not exist */ }
  db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
  return revertDeletedUploadFromDecks(row.user_id, row.key);
}

// Soft auth: populate req.user if a valid token is present, but never reject.
async function softAuthenticate(req) {
  try { await req.jwtVerify(); } catch { /* anonymous is fine */ }
}

// Per-IP limiter for abuse-report submissions.
const _reportBuckets = new Map();
const REPORT_WINDOW = 15 * 60 * 1000;
const REPORT_MAX = 20;
function rateLimitReport(req, reply, done) {
  const ip = clientIp(req);
  const now = Date.now();
  let b = _reportBuckets.get(ip);
  if (!b || now - b.start > REPORT_WINDOW) { b = { start: now, count: 0 }; _reportBuckets.set(ip, b); }
  b.count++;
  if (b.count > REPORT_MAX) { reply.code(429).send({ error: 'Too many reports. Try again later.' }); return; }
  done();
}
setInterval(() => { const c = Date.now() - REPORT_WINDOW; for (const [k, b] of _reportBuckets) if (b.start < c) _reportBuckets.delete(k); }, 30 * 60 * 1000);

// Global error handler — record 5xx (real bugs), keep normal 4xx quiet.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status >= 500) {
    app.log.error(err);
    recordError('server', { where: (req.method || '') + ' ' + (req.url || ''), message: err.message, stack: err.stack, ua: req.headers['user-agent'] });
  }
  reply.code(status).send({ error: status >= 500 ? 'Something went wrong.' : (err.message || 'Request failed') });
});

// ── Routes ────────────────────────────────────────────────────────────────────

// Client error beacon (rate-limited, no auth) + admin view.
// Redact sensitive query params (reset token, etc.) before persisting — never store
// a usable secret in the errors log, regardless of what the client sends.
function _scrubUrl(u) {
  return String(u == null ? '' : u).replace(/([?&](?:reset|token|pw|password)=)[^&#\s]*/gi, '$1[redacted]');
}
app.post('/api/clientlog', { preHandler: rateLimitReport }, async (req) => {
  const b = req.body || {};
  recordError('client', { where: _scrubUrl(b.url), message: b.message, stack: b.stack, ua: req.headers['user-agent'] });
  return { ok: true };
});
app.get('/api/admin/errors', { preHandler: adminOnly }, async () => {
  return { errors: db.prepare('SELECT id, ts, kind, where_ AS loc, message, stack FROM errors ORDER BY id DESC LIMIT 100').all() };
});

// Health check
app.get('/api/health', async () => ({ ok: true }));

// ── Tournaments ────────────────────────────────────────────────────────────────
const T_FORMATS = ['Modern', 'Commander', 'Standard', 'Pioneer', 'Legacy', 'Vintage', 'Pauper', 'Limited', 'Other'];
const T_MODES = ['online', 'in-person'];
const T_LEVELS = ['casual', 'competitive', 'pro'];
const _str = (v, max) => String(v == null ? '' : v).slice(0, max);
const _isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const _today = () => new Date().toISOString().slice(0, 10);
const _coord = (v, max) => { const n = Number(v); return (isFinite(n) && Math.abs(n) <= max && v !== '' && v != null) ? n : null; };

// Macro-regions that aren't single geocode entities — resolved against a tournament's state/country.
const MACRO_REGIONS = {
  'east coast': { states: ['Maine','New Hampshire','Vermont','Massachusetts','Rhode Island','Connecticut','New York','New Jersey','Pennsylvania','Delaware','Maryland','Virginia','North Carolina','South Carolina','Georgia','Florida','District of Columbia'] },
  'west coast': { states: ['California','Oregon','Washington'] },
  'central us': { states: ['North Dakota','South Dakota','Nebraska','Kansas','Minnesota','Iowa','Missouri','Wisconsin','Illinois','Indiana','Michigan','Ohio','Oklahoma','Texas'] },
  'midwest': { states: ['North Dakota','South Dakota','Nebraska','Kansas','Minnesota','Iowa','Missouri','Wisconsin','Illinois','Indiana','Michigan','Ohio'] },
  'europe': { countries: ['Albania','Austria','Belgium','Bosnia and Herzegovina','Bulgaria','Croatia','Czechia','Czech Republic','Denmark','Estonia','Finland','France','Germany','Greece','Hungary','Iceland','Ireland','Italy','Latvia','Lithuania','Luxembourg','Malta','Moldova','Montenegro','Netherlands','North Macedonia','Norway','Poland','Portugal','Romania','Serbia','Slovakia','Slovenia','Spain','Sweden','Switzerland','Ukraine','United Kingdom'] },
};
const _macroAliases = { 'east coast us':'east coast','eastcoast':'east coast','west coast us':'west coast','westcoast':'west coast','central united states':'central us','mid west':'midwest','europe (eu)':'europe' };
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function regionMatch(t, regions) {
  const hay = [t.country, t.state, t.address, t.region].map(x => String(x || '').toLowerCase());
  return regions.some(term => {
    const k = (_macroAliases[term] || term);
    const macro = MACRO_REGIONS[k];
    if (macro) {
      if (macro.states && t.state && macro.states.some(s => s.toLowerCase() === String(t.state).toLowerCase())) return true;
      if (macro.countries && t.country && macro.countries.some(c => c.toLowerCase() === String(t.country).toLowerCase())) return true;
      return false;
    }
    return hay.some(h => h && h.includes(term)); // plain substring against the venue's country/state/address
  });
}
function locationMatch(t, sub) {
  if (t.mode === 'online') return true;                       // online events aren't geo-bound
  const regions = String(sub.regions || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const hasRadius = sub.center_lat != null && sub.center_lon != null && sub.radius;
  if (!regions.length && !hasRadius) return true;             // no location constraint = anywhere
  if (regions.length && regionMatch(t, regions)) return true;
  if (hasRadius && t.lat != null && t.lon != null) {
    const km = (sub.radius_unit === 'mi') ? sub.radius * 1.60934 : sub.radius;
    if (haversineKm(t.lat, t.lon, sub.center_lat, sub.center_lon) <= km) return true;
  }
  return false;
}
// Does an upcoming tournament satisfy a subscription's parameters? (matching is in JS — volume is small)
function tournamentMatches(t, sub) {
  const fmts = (sub.formats || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fmts.length && !fmts.includes(t.format)) return false;
  if (sub.mode && sub.mode !== 'any' && t.mode !== sub.mode) return false;
  if (sub.level && sub.level !== 'any' && t.level !== sub.level) return false;
  if (sub.max_entry != null && (t.entry_fee || 0) > sub.max_entry) return false;
  if (sub.proxies === 'yes' && !t.proxies) return false;
  if (sub.proxies === 'no' && t.proxies) return false;
  if (!locationMatch(t, sub)) return false;
  return true;
}

// Create a tournament (poster).
app.post('/api/tournaments', { preHandler: [authenticate, rateLimitReport] }, async (req, reply) => {
  const b = req.body || {};
  const title = _str(b.title, 120).trim();
  if (!title) return reply.code(400).send({ error: 'A title is required.' });
  if (!_isYmd(b.date)) return reply.code(400).send({ error: 'A valid date (YYYY-MM-DD) is required.' });
  const format = T_FORMATS.includes(b.format) ? b.format : 'Other';
  const mode = T_MODES.includes(b.mode) ? b.mode : 'in-person';
  const level = T_LEVELS.includes(b.level) ? b.level : 'casual';
  const url = _str(b.url, 300).trim();
  if (url && !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'URL must start with http:// or https://' });
  const entry = Math.max(0, Math.min(100000, Number(b.entry_fee) || 0));
  const lat = _coord(b.lat, 90), lon = _coord(b.lon, 180);
  const info = db.prepare(
    `INSERT INTO tournaments (host_id, title, format, mode, region, date, time, level, entry_fee, url, notes, lat, lon, address, country, state, proxies)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.sub, title, format, mode, _str(b.region, 120).trim(), b.date, _str(b.time, 40).trim(), level, entry, url, _str(b.notes, 2000),
        lat, lon, _str(b.address, 200).trim(), _str(b.country, 80).trim(), _str(b.state, 80).trim(), b.proxies ? 1 : 0);
  const id = info.lastInsertRowid;
  // Subscription mail: notify anyone (other than the poster) whose subscription matches.
  try {
    const t = { id, title, format, mode, region: _str(b.region, 120).trim(), date: b.date, level, entry_fee: entry, proxies: b.proxies ? 1 : 0,
      lat, lon, address: _str(b.address, 200).trim(), country: _str(b.country, 80).trim(), state: _str(b.state, 80).trim() };
    const notified = new Set();
    for (const s of db.prepare('SELECT * FROM tournament_subs').all()) {
      if (s.user_id === req.user.sub || notified.has(s.user_id)) continue;
      if (tournamentMatches(t, s)) { notified.add(s.user_id);
        mailSend(s.user_id, { from_kind: 'system', from_label: 'Tournaments', subject: 'New '+format+' tournament: '+title,
          body: [t.date + (t.region ? (' · ' + t.region) : ''), level + (entry > 0 ? (' · $' + entry) : '')].join('\n'), link: 'tournament:' + id });
      }
    }
  } catch (e) { app.log.error(e); }
  return { id };
});

// Public browse: upcoming tournaments (optional filters). Soft auth so anyone can look.
app.get('/api/tournaments', { preHandler: softAuthenticate }, async (req) => {
  const q = req.query || {};
  let rows = db.prepare(
    'SELECT id, host_id, title, format, mode, region, date, time, level, entry_fee, url, notes, lat, lon, address, country, state, proxies FROM tournaments WHERE date >= ? ORDER BY date ASC LIMIT 300'
  ).all(_today());
  if (q.format) rows = rows.filter(r => r.format === q.format);
  if (q.mode && q.mode !== 'any') rows = rows.filter(r => r.mode === q.mode);
  if (q.level && q.level !== 'any') rows = rows.filter(r => r.level === q.level);
  if (q.region) { const rq = String(q.region).toLowerCase(); rows = rows.filter(r => [r.region, r.state, r.country, r.address].some(x => String(x || '').toLowerCase().includes(rq))); }
  return { tournaments: rows };
});

// Tournaments I posted.
app.get('/api/tournaments/mine', { preHandler: authenticate }, async (req) => ({
  tournaments: db.prepare('SELECT * FROM tournaments WHERE host_id = ? ORDER BY date ASC').all(req.user.sub),
}));

// Delete one of my tournaments.
app.delete('/api/tournaments/:id', { preHandler: authenticate }, async (req, reply) => {
  const r = db.prepare('DELETE FROM tournaments WHERE id = ? AND host_id = ?').run(req.params.id, req.user.sub);
  if (!r.changes) return reply.code(404).send({ error: 'Not found' });
  return { ok: true };
});

// My subscriptions (the params I want matched).
app.get('/api/tournaments/subs', { preHandler: authenticate }, async (req) => ({
  subs: db.prepare('SELECT * FROM tournament_subs WHERE user_id = ? ORDER BY id DESC').all(req.user.sub),
}));

// Create a subscription.
app.post('/api/tournaments/subs', { preHandler: [authenticate, rateLimitReport] }, async (req, reply) => {
  const b = req.body || {};
  const formats = Array.isArray(b.formats)
    ? b.formats.filter(f => T_FORMATS.includes(f)).join(',')
    : _str(b.formats, 200).split(',').map(s => s.trim()).filter(f => T_FORMATS.includes(f)).join(',');
  const mode = ['any', ...T_MODES].includes(b.mode) ? b.mode : 'any';
  const level = ['any', ...T_LEVELS].includes(b.level) ? b.level : 'any';
  const maxEntry = (b.max_entry === '' || b.max_entry == null) ? null : Math.max(0, Number(b.max_entry) || 0);
  const regions = (Array.isArray(b.regions) ? b.regions : _str(b.regions, 400).split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 20).join(',');
  const cLat = _coord(b.center_lat, 90), cLon = _coord(b.center_lon, 180);
  const hasCenter = cLat != null && cLon != null;
  const radius = hasCenter ? Math.max(1, Math.min(20000, Number(b.radius) || 50)) : null;
  const radiusUnit = b.radius_unit === 'km' ? 'km' : 'mi';
  const proxies = ['yes', 'no'].includes(b.proxies) ? b.proxies : 'any';
  const count = db.prepare('SELECT COUNT(*) n FROM tournament_subs WHERE user_id = ?').get(req.user.sub).n;
  if (count >= 50) return reply.code(400).send({ error: 'Subscription limit reached.' });
  const info = db.prepare(
    'INSERT INTO tournament_subs (user_id, name, formats, mode, level, max_entry, regions, center_lat, center_lon, center_label, radius, radius_unit, proxies) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.sub, _str(b.name, 80).trim() || 'My subscription', formats, mode, level, maxEntry,
        regions, hasCenter ? cLat : null, hasCenter ? cLon : null, hasCenter ? _str(b.center_label, 160).trim() : null, radius, hasCenter ? radiusUnit : null, proxies);
  return { id: info.lastInsertRowid };
});

// Delete a subscription.
app.delete('/api/tournaments/subs/:id', { preHandler: authenticate }, async (req, reply) => {
  const r = db.prepare('DELETE FROM tournament_subs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  if (!r.changes) return reply.code(404).send({ error: 'Not found' });
  return { ok: true };
});

// My feed: upcoming tournaments matching ANY of my subscriptions. Powers the calendar + feed widget.
app.get('/api/tournaments/feed', { preHandler: authenticate }, async (req) => {
  const subs = db.prepare('SELECT * FROM tournament_subs WHERE user_id = ?').all(req.user.sub);
  if (!subs.length) return { tournaments: [], subs: 0 };
  const upcoming = db.prepare(
    'SELECT id, title, format, mode, region, date, time, level, entry_fee, url, notes, lat, lon, address, country, state, proxies FROM tournaments WHERE date >= ? ORDER BY date ASC LIMIT 300'
  ).all(_today());
  return { tournaments: upcoming.filter(t => subs.some(s => tournamentMatches(t, s))), subs: subs.length };
});

// ── Mail ──────────────────────────────────────────────────────────────────────
app.get('/api/mail', { preHandler: authenticate }, async (req) => ({
  mail: db.prepare('SELECT id, from_kind, from_label, subject, body, link, is_read, created_at FROM mail WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.sub),
  unread: db.prepare('SELECT COUNT(*) n FROM mail WHERE user_id = ? AND is_read = 0').get(req.user.sub).n,
  is_admin: isAdminUser(req.user.sub),
}));
app.get('/api/mail/unread', { preHandler: authenticate }, async (req) => ({
  unread: db.prepare('SELECT COUNT(*) n FROM mail WHERE user_id = ? AND is_read = 0').get(req.user.sub).n,
  is_admin: isAdminUser(req.user.sub),
}));
app.post('/api/mail/:id/read', { preHandler: authenticate }, async (req) => {
  db.prepare('UPDATE mail SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub); return { ok: true };
});
app.post('/api/mail/read-all', { preHandler: authenticate }, async (req) => {
  db.prepare('UPDATE mail SET is_read = 1 WHERE user_id = ?').run(req.user.sub); return { ok: true };
});
app.delete('/api/mail/:id', { preHandler: authenticate }, async (req) => {
  db.prepare('DELETE FROM mail WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub); return { ok: true };
});
// Admin: send mail to one user or broadcast to everyone. Gated by the is_admin flag.
app.post('/api/mail/admin/send', { preHandler: [authenticate, rateLimitReport] }, async (req, reply) => {
  if (!isAdminUser(req.user.sub)) return reply.code(403).send({ error: 'Admins only.' });
  const b = req.body || {};
  const subject = _str(b.subject, 160).trim(); if (!subject) return reply.code(400).send({ error: 'Subject required.' });
  const body = _str(b.body, 4000), link = _str(b.link, 200).trim();
  const label = 'Admin' + (req.user.username ? (' · ' + req.user.username) : '');
  let recipients;
  if (b.to === '*' || b.to == null || b.to === '') recipients = db.prepare('SELECT id FROM users').all().map(r => r.id);
  else { const u = db.prepare('SELECT id FROM users WHERE username = ?').get(String(b.to)); if (!u) return reply.code(404).send({ error: 'No such user.' }); recipients = [u.id]; }
  for (const uid of recipients) mailSend(uid, { from_kind: 'admin', from_label: label, subject, body, link });
  return { ok: true, sent: recipients.length };
});

// Single tournament detail (for the mini "tournament page") + RSVP tallies + my RSVP.
app.get('/api/tournaments/:id', { preHandler: softAuthenticate }, async (req, reply) => {
  const t = db.prepare('SELECT id, host_id, title, format, mode, region, date, time, level, entry_fee, url, notes, lat, lon, address, country, state, proxies FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return reply.code(404).send({ error: 'Not found' });
  const counts = { going: 0, maybe: 0, no: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tournament_rsvps WHERE tournament_id = ? GROUP BY status').all(t.id)) if (counts[r.status] != null) counts[r.status] = r.n;
  const mine = req.user ? db.prepare('SELECT status FROM tournament_rsvps WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.sub) : null;
  return { tournament: t, rsvp: counts, myStatus: mine ? mine.status : null };
});

// Set / change / clear my RSVP for a tournament.
app.post('/api/tournaments/:id/rsvp', { preHandler: authenticate }, async (req, reply) => {
  const t = db.prepare('SELECT id FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return reply.code(404).send({ error: 'Not found' });
  const status = req.body && req.body.status;
  if (status === 'clear' || status == null) {
    db.prepare('DELETE FROM tournament_rsvps WHERE tournament_id = ? AND user_id = ?').run(t.id, req.user.sub);
  } else if (['going', 'maybe', 'no'].includes(status)) {
    db.prepare('INSERT INTO tournament_rsvps (tournament_id, user_id, status, updated_at) VALUES (?,?,?,unixepoch()) ON CONFLICT(tournament_id, user_id) DO UPDATE SET status = excluded.status, updated_at = unixepoch()').run(t.id, req.user.sub, status);
  } else {
    return reply.code(400).send({ error: 'Bad status' });
  }
  const counts = { going: 0, maybe: 0, no: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM tournament_rsvps WHERE tournament_id = ? GROUP BY status').all(t.id)) if (counts[r.status] != null) counts[r.status] = r.n;
  return { rsvp: counts, myStatus: status === 'clear' ? null : status };
});

// ── Web shortcut frame check: can a URL be embedded in an iframe? (server-side header
// inspection — the browser can't see X-Frame-Options/CSP blocks). SSRF-guarded. ──────
const { lookup: _dnsLookup } = require('dns').promises;
function _isPrivateIp(ip) {
  if (!ip) return true;
  let s = String(ip).toLowerCase();
  // IPv4-mapped / -compatible IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1) → check the embedded IPv4.
  let m = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) s = m[1];
  else if ((m = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/))) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    s = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
  }
  if (s.includes(':')) {
    // Any non-global IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd')
      || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
  }
  const o = s.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return o[0] === 10 || o[0] === 127 || o[0] === 0
    || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) // CGNAT
    || o[0] >= 224; // multicast / reserved
}
// Validate a single URL: http(s) only, standard ports, public host. Resolves ALL
// addresses and rejects if ANY is private; returns the pinned IP so the caller can
// connect to exactly that address (defeats DNS-rebinding between check and fetch).
async function _guardWebUrl(raw) {
  let url; try { url = new URL(raw); } catch (_) { return { ok: false, reason: 'Not a valid URL.' }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'Only http(s) sites.' };
  if (url.port && !['', '80', '443'].includes(url.port)) return { ok: false, reason: 'That port is not allowed.' };
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'That host is not allowed.' };
  let addrs;
  try { addrs = await _dnsLookup(host, { all: true }); } catch (_) { return { ok: false, reason: 'Could not reach that site.' }; }
  if (!addrs.length || addrs.some(a => _isPrivateIp(a.address))) return { ok: false, reason: 'That host is not allowed.' };
  return { ok: true, url, ip: addrs[0].address, family: addrs[0].family };
}
// Header-only fetch that connects to a PINNED ip (no second DNS resolution), so the
// connection can't be rebound to a private host after _guardWebUrl validated it.
function _fetchHeadPinned(urlObj, ip, family) {
  return new Promise((resolve, reject) => {
    const mod = urlObj.protocol === 'https:' ? https : require('http');
    const req = mod.request(urlObj, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (MyMagicDeck framecheck)', 'Accept': '*/*' },
      servername: urlObj.hostname,                 // TLS SNI stays the real hostname
      lookup: (h, o, cb) => cb(null, ip, family),  // pin the connection to the validated IP
    }, res => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); req.destroy(); });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
// Dedicated limiter so framecheck can't drain (or be drained by) the report budget.
const _fcBuckets = new Map(); const FC_WINDOW = 10 * 60 * 1000; const FC_MAX = 40;
function rateLimitFrameCheck(req, reply, done) {
  const ip = clientIp(req);
  const now = Date.now(); let b = _fcBuckets.get(ip);
  if (!b || now - b.start > FC_WINDOW) { b = { start: now, count: 0 }; _fcBuckets.set(ip, b); }
  if (++b.count > FC_MAX) { reply.code(429).send({ ok: false, reason: 'Too many checks — try again shortly.' }); return; }
  done();
}
setInterval(() => { const c = Date.now() - FC_WINDOW; for (const [k, b] of _fcBuckets) if (b.start < c) _fcBuckets.delete(k); }, 30 * 60 * 1000);

app.get('/api/web/framecheck', { preHandler: rateLimitFrameCheck }, async (req) => { // open to guests; rate-limited + SSRF-guarded (incl. every redirect hop)
  let next = String((req.query || {}).url || '').trim();
  for (let hop = 0; hop < 4; hop++) {
    const g = await _guardWebUrl(next); if (!g.ok) return g;             // re-validate the URL AND every redirect target
    let r; try { r = await _fetchHeadPinned(g.url, g.ip, g.family); }    // connect only to the validated IP
    catch (_) { return { ok: false, reason: 'Could not reach that site.' }; }
    const loc = r.headers['location'];
    if (r.status >= 300 && r.status < 400 && loc) { try { next = new URL(loc, g.url).href; } catch (_) { return { ok: false, reason: 'Bad redirect.' }; } continue; }
    const xfo = (r.headers['x-frame-options'] || '').toLowerCase();
    const csp = (r.headers['content-security-policy'] || '').toLowerCase();
    const fa = (csp.match(/frame-ancestors([^;]*)/) || [, ''])[1].trim();
    const blocked = xfo.includes('deny') || xfo.includes('sameorigin') || (fa && !fa.includes('*'));
    if (blocked) return { ok: false, reason: 'frames-blocked' };
    return { ok: true, finalUrl: g.url.href };
  }
  return { ok: false, reason: 'Too many redirects.' };
});

// ── Discord bot integration ───────────────────────────────────────────────────
// Whether the integration is configured (no secret leaked) — for the MyMagicBot page.
app.get('/api/integrations/status', async () => ({ tournamentIngest: !!BOT_API_KEY }));
// The bot posts a tournament here; it creates the event + fans out subscription mail.
// Auth: a service key in the x-bot-key header (BOT_API_KEY env). Disabled if unset.
async function botOnly(req, reply) {
  if (!BOT_API_KEY) return reply.code(503).send({ error: 'Bot integration is not configured.' });
  if (req.headers['x-bot-key'] !== BOT_API_KEY) return reply.code(403).send({ error: 'Forbidden' });
}
app.post('/api/integrations/tournament', { preHandler: [botOnly, rateLimitReport] }, async (req, reply) => {
  const b = req.body || {};
  const title = _str(b.title, 120).trim();
  if (!title) return reply.code(400).send({ error: 'A title is required.' });
  if (!_isYmd(b.date)) return reply.code(400).send({ error: 'A valid date (YYYY-MM-DD) is required.' });
  const format = T_FORMATS.includes(b.format) ? b.format : 'Other';
  const mode = T_MODES.includes(b.mode) ? b.mode : 'in-person';
  const level = T_LEVELS.includes(b.level) ? b.level : 'casual';
  const url = _str(b.url, 300).trim();
  if (url && !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'URL must start with http:// or https://' });
  const entry = Math.max(0, Math.min(100000, Number(b.entry_fee) || 0));
  const lat = _coord(b.lat, 90), lon = _coord(b.lon, 180);
  const source = ('discord' + (b.source ? (':' + _str(b.source, 60)) : '')).slice(0, 80);
  const info = db.prepare(
    `INSERT INTO tournaments (host_id, title, format, mode, region, date, time, level, entry_fee, url, notes, lat, lon, address, country, state, proxies, source)
     VALUES (0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(title, format, mode, _str(b.region, 120).trim(), b.date, _str(b.time, 40).trim(), level, entry, url, _str(b.notes, 2000),
        lat, lon, _str(b.address, 200).trim(), _str(b.country, 80).trim(), _str(b.state, 80).trim(), b.proxies ? 1 : 0, source);
  const id = info.lastInsertRowid;
  try {
    const t = { id, title, format, mode, region: _str(b.region, 120).trim(), date: b.date, level, entry_fee: entry, proxies: b.proxies ? 1 : 0,
      lat, lon, address: _str(b.address, 200).trim(), country: _str(b.country, 80).trim(), state: _str(b.state, 80).trim() };
    const notified = new Set();
    for (const s of db.prepare('SELECT * FROM tournament_subs').all()) {
      if (notified.has(s.user_id)) continue;
      if (tournamentMatches(t, s)) { notified.add(s.user_id);
        mailSend(s.user_id, { from_kind: 'system', from_label: 'Tournaments (Discord)', subject: 'New ' + format + ' tournament: ' + title,
          body: [t.date + (t.region ? (' · ' + t.region) : ''), level + (entry > 0 ? (' · $' + entry) : '')].join('\n'), link: 'tournament:' + id });
      }
    }
    return { id, notified: notified.size };
  } catch (e) { app.log.error(e); return { id }; }
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', {
  preHandler: rateLimitAuth,
  schema: {
    body: {
      type: 'object',
      required: ['username', 'email', 'password'],
      properties: {
        username: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[A-Za-z0-9_.-]+$' },
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
  return { token, user: { username, email, is_admin: isAdminUser(user.id) } };
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
    'SELECT id, username, email, password, is_admin FROM users WHERE username = ?'
  ).get(username);

  if (!record) {
    return reply.code(401).send({ error: 'Invalid username or password.' });
  }

  const ok = await bcrypt.compare(password, record.password);
  if (!ok) {
    return reply.code(401).send({ error: 'Invalid username or password.' });
  }

  const token = app.jwt.sign({ sub: record.id, username: record.username });
  return { token, user: { username: record.username, email: record.email, is_admin: !!record.is_admin } };
});

// ── Password reset ────────────────────────────────────────────────────────────
const _sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Send the reset email via Resend's REST API (no SDK dependency). Returns false
// if mail isn't configured or the send fails — callers must not leak that.
async function sendResetEmail(to, link) {
  if (!RESEND_API_KEY) { app.log.warn('password reset requested but RESEND_API_KEY unset — email not sent'); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM, to,
        subject: 'Reset your MyMagicDeck password',
        html: `<p>We received a request to reset your MyMagicDeck password.</p>
               <p><a href="${link}">Click here to choose a new password</a>. This link expires in 1 hour.</p>
               <p>If you didn’t request this, you can ignore this email — your password won’t change.</p>`,
      }),
    });
    if (!r.ok) { app.log.warn('Resend send failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { app.log.warn('Resend send error: ' + e.message); return false; }
}

// Request a reset. Always 200 (never reveal whether the account exists).
app.post('/api/auth/forgot', { preHandler: rateLimitAuth }, async (req) => {
  const id = (((req.body || {}).username || (req.body || {}).email || '') + '').trim();
  if (id) {
    const user = db.prepare('SELECT id, email FROM users WHERE username = ? OR email = ?').get(id, id);
    if (user && user.email) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(_sha256(token), user.id, Math.floor(Date.now() / 1000) + 3600);
      await sendResetEmail(user.email, `${APP_BASE_URL}/?reset=${token}`);
    }
  }
  return { ok: true, message: 'If that account exists, a reset link is on its way.' };
});

// Complete a reset with the emailed token + a new password.
app.post('/api/auth/reset', { preHandler: rateLimitAuth }, async (req, reply) => {
  const { token, password } = req.body || {};
  if (!token || typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return reply.code(400).send({ error: 'A valid token and a password (8–128 chars) are required.' });
  }
  const row = db.prepare('SELECT token_hash, user_id, expires_at, used FROM password_resets WHERE token_hash = ?').get(_sha256(token));
  if (!row || row.used || row.expires_at < Math.floor(Date.now() / 1000)) {
    return reply.code(400).send({ error: 'This reset link is invalid or has expired.' });
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used = 0').run(row.user_id); // invalidate other outstanding links
  return { ok: true };
});

// ── DELETE /api/account  (permanent account + data deletion) ──────────────────
// Requires the current password (a stolen token alone can't nuke an account).
// Removes everything tied to the user: decks/uploads/fs/desktop/reset tokens
// cascade from the users row; tournaments/subs/rsvps/mail and on-disk upload
// files are cleared explicitly (no FK cascade on those).
app.delete('/api/account', { preHandler: [authenticate, rateLimitAuth] }, async (req, reply) => {
  const uid = req.user.sub;
  const password = (req.body || {}).password;
  const rec = db.prepare('SELECT password FROM users WHERE id = ?').get(uid);
  if (!rec) return reply.code(404).send({ error: 'Account not found.' });
  if (typeof password !== 'string' || !(await bcrypt.compare(password, rec.password))) {
    return reply.code(403).send({ error: 'Password is incorrect.' });
  }
  // Delete on-disk uploads first (DB rows cascade from the users row below).
  try { fs.rmSync(path.join(UPLOAD_DIR, String(uid)), { recursive: true, force: true }); } catch (_) { /* none */ }
  const purge = db.transaction(() => {
    db.prepare('DELETE FROM mail WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tournament_subs WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tournament_rsvps WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tournaments WHERE host_id = ?').run(uid);
    db.prepare('UPDATE upload_reports SET reporter = NULL WHERE reporter = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid); // cascades decks, uploads, user_fs, user_desktop, password_resets
  });
  purge();
  app.log.warn('account deleted: user ' + uid);
  return { ok: true };
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

// ── POST /api/cards/refresh  (manual trigger, admin-key gated) ────────────────
app.post('/api/cards/refresh', { preHandler: adminOnly }, async (req, reply) => {
  if (_cardRefreshRunning) return reply.code(409).send({ error: 'Refresh already running', state: _cardRefreshState });
  refreshCards(); // fire and forget
  return { ok: true, message: 'Refresh started' };
});

// ── Perceptual-hash index refresh (card identification) ───────────────────────
app.get('/api/cards/hash-refresh/status', async () => ({
  ..._hashState,
  indexed: db.prepare('SELECT COUNT(*) as n FROM card_hashes').get().n,
}));
app.post('/api/cards/hash-refresh', { preHandler: adminOnly }, async (req, reply) => {
  if (_hashRunning) return reply.code(409).send({ error: 'Hash refresh already running', state: _hashState });
  refreshHashes(); // fire and forget
  return { ok: true, message: 'Hash refresh started' };
});
app.get('/api/cards/printings-refresh/status', async () => ({
  ..._printState,
  indexed: db.prepare('SELECT COUNT(*) as n FROM card_printings').get().n,
}));
app.post('/api/cards/printings-refresh', { preHandler: adminOnly }, async (req, reply) => {
  if (_printRunning) return reply.code(409).send({ error: 'Printings refresh already running', state: _printState });
  refreshPrintings(); // fire and forget
  return { ok: true, message: 'Printings refresh started' };
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

// ── POST /api/cards/guess  (mobile "guess my card") ──────────────────────────
// Body: {color:'W'|'U'|'B'|'R'|'G'|'M'|'C', cmc, type, power, toughness, name, exclude:[]}
// Returns candidates matching the given constraints, ranked by edhrec popularity.
function _cardImage(row) {
  let u = null;
  try { u = JSON.parse(row.image_uris || 'null'); } catch (_) {}
  if (!u) { try { const f = JSON.parse(row.card_faces || 'null'); u = f && f[0] && f[0].image_uris; } catch (_) {} }
  if (!u) return { normal: null, art: null };
  return { normal: u.normal || u.large || u.png || null, art: u.art_crop || u.normal || null };
}
app.post('/api/cards/guess', async (req, reply) => {
  const b = req.body || {};
  const where = ["image_uris IS NOT NULL AND image_uris != 'null'"];
  const params = [];
  const color = (b.color || '').toUpperCase();
  if (color === 'C') where.push("colors = '[]'");
  else if (color === 'M') where.push("json_array_length(colors) >= 2");
  else if (['W', 'U', 'B', 'R', 'G'].includes(color)) { where.push('colors LIKE ?'); params.push('%"' + color + '"%'); }
  if (Number.isFinite(b.cmc)) { where.push('cmc = ?'); params.push(Number(b.cmc)); }
  if (b.type) { where.push('type_line LIKE ?'); params.push('%' + String(b.type) + '%'); }
  if (b.power != null && b.power !== '') { where.push('power = ?'); params.push(String(b.power)); }
  if (b.toughness != null && b.toughness !== '') { where.push('toughness = ?'); params.push(String(b.toughness)); }
  if (b.name) { where.push('name LIKE ?'); params.push('%' + String(b.name) + '%'); }
  const FMT_OK = new Set(['standard','pioneer','modern','legacy','vintage','pauper','commander','premodern','oldschool','duel','penny','brawl','predh']);
  const fmt = (b.format || '').toLowerCase();
  if (FMT_OK.has(fmt)) { where.push("json_extract(legalities, '$.' || ?) = 'legal'"); params.push(fmt); }
  else if (CUSTOM_FORMATS[fmt]) {
    const cf = CUSTOM_FORMATS[fmt];
    where.push(`oracle_id IN (SELECT oracle_id FROM card_printings WHERE set_code IN (${cf.sets.map(() => '?').join(',')}))`);
    cf.sets.forEach(s => params.push(s));
    if (cf.banned.length) { where.push(`lower(name) NOT IN (${cf.banned.map(() => '?').join(',')})`); cf.banned.forEach(b2 => params.push(b2)); }
  }
  const exclude = Array.isArray(b.exclude) ? b.exclude.filter(x => typeof x === 'string').slice(0, 200) : [];
  if (exclude.length) where.push('oracle_id NOT IN (' + exclude.map(() => '?').join(',') + ')');
  if (where.length === 1) return { count: 0, candidates: [] }; // need a real constraint to guess
  const cond = where.join(' AND ');
  const all = [...params, ...exclude];
  let rows, count;
  try {
    rows = db.prepare(`SELECT oracle_id, name, mana_cost, cmc, type_line, colors, power, toughness, image_uris, card_faces, edhrec_rank
                       FROM cards WHERE ${cond} ORDER BY edhrec_rank IS NULL, edhrec_rank ASC LIMIT 12`).all(...all);
    count = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ${cond}`).get(...all).n;
  } catch (e) { app.log.warn('guess failed: ' + e.message); return reply.code(500).send({ error: 'guess failed' }); }
  const candidates = rows.map(r => {
    const img = _cardImage(r);
    return { oracleId: r.oracle_id, name: r.name, manaCost: r.mana_cost, cmc: r.cmc, typeLine: r.type_line,
             power: r.power, toughness: r.toughness, edhrecRank: r.edhrec_rank, image: img.normal, art: img.art };
  });
  return { count, candidates };
});

// ── Win95 desktop filesystem (folder tree), synced per account ────────────────
app.get('/api/fs', { preHandler: authenticate }, async (req) => {
  const row = db.prepare('SELECT data FROM user_fs WHERE user_id = ?').get(req.user.sub);
  let data = {}; try { data = JSON.parse(row && row.data || '{}'); } catch (_) {}
  return { data };
});
app.put('/api/fs', { preHandler: authenticate }, async (req, reply) => {
  const data = (req.body || {}).data;
  if (data == null || typeof data !== 'object') return reply.code(400).send({ error: 'data object required' });
  const json = JSON.stringify(data);
  if (json.length > 200000) return reply.code(413).send({ error: 'filesystem too large' });
  db.prepare(`INSERT INTO user_fs (user_id, data, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()`).run(req.user.sub, json);
  return { ok: true };
});

// ── Desktop layout (mounted widgets + notes), synced per account ──────────────
app.get('/api/desktop', { preHandler: authenticate }, async (req) => {
  const row = db.prepare('SELECT data FROM user_desktop WHERE user_id = ?').get(req.user.sub);
  let data = {}; try { data = JSON.parse(row && row.data || '{}'); } catch (_) {}
  return { data };
});
app.put('/api/desktop', { preHandler: authenticate }, async (req, reply) => {
  const data = (req.body || {}).data;
  if (data == null || typeof data !== 'object') return reply.code(400).send({ error: 'data object required' });
  const json = JSON.stringify(data);
  if (json.length > 300000) return reply.code(413).send({ error: 'desktop layout too large' });
  db.prepare(`INSERT INTO user_desktop (user_id, data, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()`).run(req.user.sub, json);
  return { ok: true };
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
  const revertedDecks = purgeUpload(row);
  return { ok: true, revertedDecks };
});

// ── Moderation: report an uploaded image (anyone; rate-limited per IP) ─────────
app.post('/api/uploads/:id/report', { preHandler: [softAuthenticate, rateLimitReport] }, async (req, reply) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM uploads WHERE id = ?').get(id);
  if (!row) return reply.code(404).send({ error: 'Not found.' });
  const reason = (((req.body || {}).reason || '') + '').slice(0, 500);
  const ip = clientIp(req);
  db.prepare('INSERT INTO upload_reports (upload_id, reporter, reason, ip) VALUES (?, ?, ?, ?)')
    .run(id, req.user?.sub || null, reason || null, ip);
  return { ok: true };
});

// ── Moderation: report by image URL (what the public splash UI has on hand) ───
app.post('/api/uploads/report', { preHandler: [softAuthenticate, rateLimitReport] }, async (req, reply) => {
  const url = (((req.body || {}).url || '') + '');
  const reason = (((req.body || {}).reason || '') + '').slice(0, 500);
  const m = url.match(/\/u\/\d+\/([^/?]+)/);            // /u/<userId>/<key>__<size>.<ext>
  if (!m) return reply.code(400).send({ error: 'Not a valid uploaded-image URL.' });
  const key = m[1].split('__')[0];
  const up = db.prepare('SELECT id FROM uploads WHERE key = ?').get(key);
  if (up) {
    const ip = clientIp(req);
    db.prepare('INSERT INTO upload_reports (upload_id, reporter, reason, ip) VALUES (?, ?, ?, ?)')
      .run(up.id, req.user?.sub || null, reason || null, ip);
  }
  return { ok: true }; // don't reveal whether the key matched
});

// ── Admin: list reported uploads (most-reported first) ────────────────────────
app.get('/api/admin/reports', { preHandler: adminOnly }, async () => {
  const rows = db.prepare(`
    SELECT u.id, u.user_id, u.kind, u.card_name, u.normal, u.large, us.username,
           COUNT(r.id) AS reports, MAX(r.created_at) AS last_report,
           (SELECT group_concat(reason, ' | ') FROM upload_reports WHERE upload_id = u.id AND reason IS NOT NULL) AS reasons
    FROM upload_reports r
    JOIN uploads u ON u.id = r.upload_id
    JOIN users us ON us.id = u.user_id
    GROUP BY u.id ORDER BY reports DESC, last_report DESC`).all();
  return { reported: rows };
});

// ── Admin: take down an upload (any owner) — purge files+row, revert decks ─────
app.post('/api/admin/uploads/:id/takedown', { preHandler: adminOnly }, async (req, reply) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  if (!row) return reply.code(404).send({ error: 'Not found.' });
  const revertedDecks = purgeUpload(row);
  db.prepare('DELETE FROM upload_reports WHERE upload_id = ?').run(id);
  app.log.warn(`admin takedown: upload ${id} (user ${row.user_id}, key ${row.key}), reverted ${revertedDecks} decks`);
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
      if ((resolved + path.sep).startsWith(path.resolve(UPLOAD_DIR) + path.sep) && fs.existsSync(resolved)) buf = fs.readFileSync(resolved);
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
app.post('/api/splash/bg-generate', { preHandler: [authenticate, rateLimitBgGen] }, async (req, reply) => {
  const prompt = buildBgPrompt((req.body || {}).slots);
  if (!prompt) return reply.code(400).send({ error: 'Pick a scene from the list.' });
  if (!IMG_GEN_URL) return reply.code(503).send({ error: 'AI backgrounds aren’t enabled yet — coming soon.', enabled: false });
  // Global concurrency cap — protect the brownout-prone GPU box from pile-ups.
  if (_bgInFlight >= BG_CONCURRENCY) {
    return reply.code(429).send({ error: 'The art forge is busy right now — try again in a moment.' });
  }
  _bgInFlight++;
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
  } finally { clearTimeout(timer); _bgInFlight--; }
});

// ── Card Duel (online) ──────────────────────────────────────────────────────
const _battleBuckets = new Map();
function rateLimitBattle(req, reply, done) {
  const ip = clientIp(req);
  const now = Date.now(); let b = _battleBuckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; _battleBuckets.set(ip, b); }
  if (++b.count > 20) { reply.code(429).send({ error: 'Slow down.' }); return; }
  done();
}
function battleNorm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function battleCluesFor(card) {
  const cl = [];
  const C = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
  const cs = (JSON.parse(card.colors || '[]')).map(c => C[c]).filter(Boolean);
  cl.push('Color: ' + (cs.length ? cs.join(' / ') : 'Colorless'));
  cl.push('Mana value: ' + (card.cmc != null ? card.cmc : '?'));
  cl.push('Type: ' + ((card.type_line || '?').split('—')[0].trim()));
  if (card.power != null && card.toughness != null) cl.push('Power / Toughness: ' + card.power + ' / ' + card.toughness);
  if (card.rarity) cl.push('Rarity: ' + card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1));
  if (card.mana_cost) cl.push('Mana cost: ' + card.mana_cost.replace(/[{}]/g, ' ').trim());
  const n = card.name || '';
  cl.push('Name length: ' + n.replace(/[^A-Za-z]/g, '').length + ' letters');
  cl.push('Starts with: ' + n.charAt(0).toUpperCase());
  if (n.length > 2) cl.push('First two letters: ' + n.slice(0, 2));
  return cl;
}
function battlePublic(row) {
  const st = JSON.parse(row.state);
  const over = st.status === 'over';
  return {
    code: row.code, status: st.status, revealed: st.revealed,
    clues: st.clues.slice(0, st.revealed), clueCount: st.clues.length,
    guesses: st.guesses, scores: st.scores, winner: st.winner,
    joined: [!!st.players[0], !!st.players[1]],
    target: over ? { name: row.target_name, image: st.target.image } : null,
    updatedAt: row.updated_at,
  };
}
function battleGet(code) { return db.prepare('SELECT * FROM battles WHERE code = ?').get((code || '').toUpperCase()); }
function battleSave(code, st) {
  db.prepare('UPDATE battles SET state = ?, updated_at = unixepoch() WHERE code = ?').run(JSON.stringify(st), code);
}

app.post('/api/battle/create', { preHandler: rateLimitBattle }, async (req, reply) => {
  const card = db.prepare(`SELECT oracle_id,name,colors,cmc,type_line,power,toughness,rarity,mana_cost,image_uris
                           FROM cards WHERE image_uris IS NOT NULL AND edhrec_rank IS NOT NULL
                           AND type_line NOT LIKE '%//%' ORDER BY RANDOM() LIMIT 1`).get();
  if (!card) return reply.code(503).send({ error: 'Card library not ready.' });
  let code; for (let i = 0; i < 8; i++) { code = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5); if (!battleGet(code)) break; }
  const img = JSON.parse(card.image_uris || 'null'); const token = crypto.randomBytes(12).toString('hex');
  const st = { clues: battleCluesFor(card), revealed: 1, guesses: [], scores: [0, 0], players: [token, null], status: 'waiting', winner: null,
               target: { name: card.name, image: img ? (img.normal || img.large || img.small) : null } };
  db.prepare('INSERT INTO battles (code, target_name, state) VALUES (?,?,?)').run(code, card.name, JSON.stringify(st));
  const row = battleGet(code);
  return { code, token, player: 0, state: battlePublic(row) };
});

app.post('/api/battle/:code/join', { preHandler: rateLimitBattle }, async (req, reply) => {
  const row = battleGet(req.params.code); if (!row) return reply.code(404).send({ error: 'Room not found.' });
  const st = JSON.parse(row.state);
  if (st.players[1]) return reply.code(409).send({ error: 'Room is full.' });
  const token = crypto.randomBytes(12).toString('hex'); st.players[1] = token; st.status = 'playing';
  battleSave(row.code, st);
  return { code: row.code, token, player: 1, state: battlePublic(battleGet(row.code)) };
});

app.get('/api/battle/:code', async (req, reply) => {
  const row = battleGet(req.params.code); if (!row) return reply.code(404).send({ error: 'Room not found.' });
  return battlePublic(row);
});

app.post('/api/battle/:code/reveal', async (req, reply) => {
  const row = battleGet(req.params.code); if (!row) return reply.code(404).send({ error: 'Room not found.' });
  const st = JSON.parse(row.state);
  if ((st.players.indexOf((req.body || {}).token)) < 0) return reply.code(403).send({ error: 'Not a player.' });
  if (st.status !== 'over') st.revealed = Math.min(st.clues.length, st.revealed + 1);
  battleSave(row.code, st);
  return battlePublic(battleGet(row.code));
});

app.post('/api/battle/:code/guess', async (req, reply) => {
  const row = battleGet(req.params.code); if (!row) return reply.code(404).send({ error: 'Room not found.' });
  const st = JSON.parse(row.state);
  const pi = st.players.indexOf((req.body || {}).token);
  if (pi < 0) return reply.code(403).send({ error: 'Not a player.' });
  if (st.status === 'over') return { correct: false, state: battlePublic(row) };
  const g = battleNorm((req.body || {}).guess); if (!g) return reply.code(400).send({ error: 'Empty guess.' });
  const t = battleNorm(row.target_name), tFirst = battleNorm((row.target_name || '').split(/[ ,]/)[0]);
  const correct = g === t || (g.length >= 5 && t.indexOf(g) === 0) || (g.length >= 4 && g === tFirst);
  st.guesses.push({ player: pi, text: String((req.body || {}).guess).slice(0, 60), correct });
  if (st.guesses.length > 100) st.guesses = st.guesses.slice(-100);
  if (correct) { st.status = 'over'; st.winner = pi; st.scores[pi]++; st.revealed = st.clues.length; }
  battleSave(row.code, st);
  return { correct, state: battlePublic(battleGet(row.code)) };
});

app.post('/api/battle/:code/rematch', { preHandler: rateLimitBattle }, async (req, reply) => {
  const row = battleGet(req.params.code); if (!row) return reply.code(404).send({ error: 'Room not found.' });
  const st = JSON.parse(row.state);
  if (st.players.indexOf((req.body || {}).token) < 0) return reply.code(403).send({ error: 'Not a player.' });
  const card = db.prepare(`SELECT name,colors,cmc,type_line,power,toughness,rarity,mana_cost,image_uris
                           FROM cards WHERE image_uris IS NOT NULL AND edhrec_rank IS NOT NULL
                           AND type_line NOT LIKE '%//%' ORDER BY RANDOM() LIMIT 1`).get();
  if (!card) return reply.code(503).send({ error: 'Card library not ready.' });
  const img = JSON.parse(card.image_uris || 'null');
  st.clues = battleCluesFor(card); st.revealed = 1; st.guesses = []; st.status = 'playing'; st.winner = null;
  st.target = { name: card.name, image: img ? (img.normal || img.large || img.small) : null };
  db.prepare('UPDATE battles SET target_name = ?, state = ?, updated_at = unixepoch() WHERE code = ?').run(card.name, JSON.stringify(st), row.code);
  return battlePublic(battleGet(row.code));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  scheduleCardRefresh();
  loadHashIndex();
  loadNameIndex();
});
