'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const Fastify  = require('fastify');
const bcrypt   = require('bcrypt');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT || '3002', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'mymagicdeck.db');
const BCRYPT_ROUNDS = 12;

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
      for (const c of cards) {
        if (c.object !== 'card') continue;
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
      // Rebuild FTS from cards table
      db.prepare(`INSERT INTO cards_fts(rowid, name, type_line, oracle_text, keywords)
                  SELECT rowid, name, type_line, oracle_text, keywords FROM cards`).run();
      return cards.filter(c => c.object === 'card').length;
    });

    const count = runUpserts(cards);
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
// Translates a subset of Scryfall syntax into SQLite WHERE clauses
function parseScryfallQuery(q) {
  const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const where = [], params = [], errors = [];
  let ftsTerms = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();

    // Color: c:wubrg or color:wubrg
    const colorM = lower.match(/^(?:c|color):([wubrgmc]+)$/);
    if (colorM) {
      const cols = colorM[1].toUpperCase().split('').filter(x => 'WUBRG'.includes(x));
      for (const col of cols) where.push(`json_each.value = '${col}'`);
      // Use a simple LIKE check per color
      if (cols.length) {
        const checks = cols.map(() => `color_identity LIKE ?`);
        where.push(`(${checks.join(' AND ')})`);
        for (const col of cols) params.push(`%"${col}"%`);
      }
      continue;
    }

    // Color identity: ci:
    const ciM = lower.match(/^(?:ci|identity):([wubrgmc]+)$/);
    if (ciM) {
      const cols = ciM[1].toUpperCase().split('').filter(x => 'WUBRG'.includes(x));
      if (cols.length) {
        const checks = cols.map(() => `color_identity LIKE ?`);
        where.push(`(${checks.join(' AND ')})`);
        for (const col of cols) params.push(`%"${col}"%`);
      }
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

    // Bare keyword/name — goes to FTS
    const clean = tok.replace(/"/g, '').trim();
    if (clean) ftsTerms.push(clean);
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

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function authenticate(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', async () => ({ ok: true }));

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', {
  schema: {
    body: {
      type: 'object',
      required: ['username', 'email', 'password'],
      properties: {
        username: { type: 'string', minLength: 2, maxLength: 32 },
        email:    { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 4, maxLength: 128 },
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
  const { name, cards, sideboard, public: isPublic, splashOwner, splashSite, commander } = req.body;

  if (!name || typeof cards !== 'object') {
    return reply.code(400).send({ error: 'name and cards are required.' });
  }

  // Serialize everything except top-level metadata into data blob
  const dataObj = { cards, sideboard: sideboard || {} };
  if (commander) dataObj.commander = commander;
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
      return reply.code(400).send({ error: 'No valid search terms', object: 'error', details: 'No valid search terms' });
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  scheduleCardRefresh();
});
