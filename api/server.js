'use strict';

const path = require('path');
const fs   = require('fs');
const Fastify = require('fastify');
const bcrypt  = require('bcrypt');
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
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_decks_user   ON decks(user_id);
  CREATE INDEX IF NOT EXISTS idx_decks_splash ON decks(user_id, is_splash);
`);

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
    'SELECT id, name, data, is_public, is_splash, updated_at FROM decks WHERE user_id = ?'
  ).all(req.user.sub);

  return rows.map(r => ({
    id:        r.id,
    name:      r.name,
    public:    !!r.is_public,
    splashOwner: r.is_splash ? req.user.username : null,
    updatedAt: r.updated_at,
    ...JSON.parse(r.data),
  }));
});

// ── PUT /api/decks/:id  (create or update a single deck) ─────────────────────
app.put('/api/decks/:id', { preHandler: authenticate }, async (req, reply) => {
  const { id } = req.params;
  const { name, cards, sideboard, public: isPublic, splashOwner } = req.body;

  if (!name || typeof cards !== 'object') {
    return reply.code(400).send({ error: 'name and cards are required.' });
  }

  // Serialize everything except top-level metadata into data blob
  const data = JSON.stringify({ cards, sideboard: sideboard || {} });
  const isSplash = splashOwner ? 1 : 0;

  db.prepare(`
    INSERT INTO decks (id, user_id, name, data, is_public, is_splash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id, user_id) DO UPDATE SET
      name       = excluded.name,
      data       = excluded.data,
      is_public  = excluded.is_public,
      is_splash  = excluded.is_splash,
      updated_at = unixepoch()
  `).run(id, req.user.sub, name, data, isPublic ? 1 : 0, isSplash);

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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
});
