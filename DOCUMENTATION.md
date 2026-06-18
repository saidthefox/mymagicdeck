# MyMagicDeck — Technical Documentation

The technical reference for MyMagicDeck ("Deck OS"): architecture, database schema, the full
API surface, the data pipelines, and deployment. For the product tour read [`README.md`](README.md);
for the maintenance loop read [`AGENTS.md`](AGENTS.md); for the security posture and its rationale
read [`SECURITY.md`](SECURITY.md); for the window-manager design read [`WINDOW-MANAGER.md`](WINDOW-MANAGER.md).

> Keep this file matching the code. When you add a route, column, or env var, update the relevant
> table here in the same commit. (This doc is deliberately written without line-count figures so it
> doesn't drift the moment the files grow.)

## Overview

MyMagicDeck is a Magic: The Gathering deck builder. Users search cards, build decks, view stats,
share decks by URL or public **splash page**, and (on phones) drive the whole thing as a tiny
Windows-95 desktop where every feature is a launchable program and decks are files. Accounts sync
decks, uploads, the folder tree, and the desktop layout across devices.

**Live domains:**
- `mymagicdeck.com` — the deck builder + per-user splash pages at `username.mymagicdeck.com`
- `myvintagedeck.com` — splash page for a featured Vintage deck
- `mycommanderdeck.com` — splash page for a featured Commander deck

---

## Architecture

### Frontend (single-page application)
- **One self-contained file**, [`mymagicdeck/index.html`](mymagicdeck/index.html) — HTML + CSS + JS, **no build step, no frameworks**.
- nginx serves it read-only with `Cache-Control: no-cache`, so edits go live on reload.
- Decks live in `localStorage` for guest/offline use and sync to the API when signed in.
- Card data comes from the local API (search + named lookup), with a Scryfall fallback on a local outage.
- A service worker ([`mymagicdeck/sw.js`](mymagicdeck/sw.js)) + [`manifest.webmanifest`](mymagicdeck/manifest.webmanifest) make it an installable PWA.

### Backend (REST API)
- **Runtime:** Node.js 20 (Alpine Docker image).
- **Framework:** Fastify 5.x (`@fastify/jwt`, `@fastify/cors`, `@fastify/multipart`).
- **Database:** SQLite via `better-sqlite3` (WAL mode, foreign keys on). Synchronous — see the
  event-loop note in [`SECURITY.md`](SECURITY.md).
- **Auth:** JWT (30-day) bearer tokens via `@fastify/jwt`; bcrypt (12 rounds) password hashing.
- **Card data:** bulk-imported from Scryfall `oracle_cards` into SQLite with an FTS5 index.
- **Image work:** `sharp` (resize/encode/composite), ImageMagick (`magick`, perspective deskew),
  OpenCV via `python3`/`detect_corners.py` (card corner detection), `heic-convert` (iPhone HEIC).
- **CORS:** `origin: true` (reflected) — deliberate; auth is bearer-token, not cookies. See [`SECURITY.md`](SECURITY.md).

### Repository layout

```
mymagicdeck/
├── api/                    Fastify + better-sqlite3 backend (Dockerized)
│   ├── server.js           all routes, migrations, pipelines (one file)
│   ├── detect_corners.py   OpenCV document-scanner corner detection
│   ├── Dockerfile          node:20-alpine + imagemagick + py3-opencv + dejavu fonts
│   ├── DEPLOY.md           homelab deployment notes
│   └── package.json
├── mymagicdeck/            the static frontend (served by nginx)
│   ├── index.html          the entire app (Deck OS) — one file
│   ├── sw.js               service worker (PWA offline shell)
│   ├── manifest.webmanifest
│   ├── mods/               example mods + the mod template
│   ├── terms.html / privacy.html
├── agent/                  ops scripts + maintenance-agent tooling
│   ├── verify.sh / rebuild-api.sh / health.sh / preflight.sh
│   ├── playbooks/          step-by-step procedures
│   ├── runtime/            agent runtime (agent.mjs)
│   └── mcp/                optional MCP server exposing the ops as tools
├── tests/
│   ├── run.sh              the regression loop (frontend static + API smoke)
│   ├── frontend-check.mjs  static checks on index.html (node --check, ids, balance)
│   ├── api-smoke.mjs       API smoke tests (run inside the container)
│   └── gui/                Puppeteer GUI tests (per feature) + shots/
├── README.md  AGENTS.md  SECURITY.md  DOCUMENTATION.md  WINDOW-MANAGER.md  CLAUDE.md
```

---

## Database schema

SQLite (WAL). All tables are created idempotently on boot in `server.js`; migrations are
idempotent `ALTER TABLE … / CREATE … IF NOT EXISTS` (never hand-edit the DB file).

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| username | TEXT | unique, case-insensitive (COLLATE NOCASE) |
| email | TEXT | unique, case-insensitive |
| password | TEXT | bcrypt hash (12 rounds) |
| is_admin | INTEGER | 0/1 — set for `ADMIN_USERNAME` (default `jake`) on boot |
| created_at | INTEGER | unix epoch |

### `decks`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | client-generated id |
| user_id | INTEGER | FK → users(id) ON DELETE CASCADE |
| name | TEXT | default `'Untitled Deck'` |
| data | TEXT | JSON blob (see below) |
| is_public | INTEGER | 0/1 — controls share-link visibility |
| is_splash | INTEGER | 0/1 — marks a splash-page deck |
| splash_site | TEXT | `mymagicdeck` \| `myvintagedeck` \| `mycommanderdeck` |
| updated_at | INTEGER | unix epoch |

**Primary key:** `(id, user_id)`. The `data` blob holds `{cards, sideboard, commander?, deckPhoto?,
arts (per-copy art), layout (free-drag positions), defaultLayout, printPref}` — these ride inside
the JSON with no schema change (see the pipelines below).

### `cards`
| Column | Type | Notes |
|--------|------|-------|
| oracle_id | TEXT | PK — Scryfall oracle id |
| name | TEXT | card name |
| mana_cost | TEXT | e.g. `{2}{U}{U}` |
| cmc | REAL | converted mana cost / mana value |
| type_line | TEXT | e.g. `Creature — Human Wizard` |
| oracle_text | TEXT | rules text |
| colors / color_identity / keywords | TEXT | JSON arrays |
| legalities | TEXT | JSON object |
| set_id / set_name / rarity | TEXT | printing info |
| image_uris / card_faces / prices | TEXT | JSON (faces for DFCs) |
| power / toughness | TEXT | for the mobile guess engine |
| edhrec_rank | INTEGER | popularity rank — orders guess candidates |
| updated_at | INTEGER | unix epoch |

`cards_fts` is an FTS5 virtual table over `name, type_line, oracle_text, keywords`, content-linked
to `cards` (no double storage), rebuilt inside the daily refresh transaction.

### Other tables
| Table | Purpose |
|-------|---------|
| `card_hashes` | 64-bit DCT pHash of every unique Scryfall artwork (card identification) |
| `card_printings` | `(oracle_id, set_code)` — set-list custom formats (Middle School, Triple-A Ante) |
| `uploads` | user image library: card-art + deck photos, with resolved card identity + confirm flag + quota |
| `upload_reports` | moderation reports against an upload |
| `user_fs` | per-account Win95 folder tree (one JSON blob) |
| `user_desktop` | per-account desktop layout: mounted widgets + notes (one JSON blob) |
| `password_resets` | sha256 of the emailed token, 1h expiry, single-use |
| `tournaments` / `tournament_subs` / `tournament_rsvps` | events, parameter subscriptions, RSVPs (incl. geo cols) |
| `mail` | async inbox: system / admin / user messages (replies via `from_user`) |
| `battles` | ephemeral Card Duel rooms (reaped after 6h) |
| `errors` | capped ring (≤500) of recent server + client errors (admin-viewable) |

---

## API reference

All routes are under `/api`. **Auth** column: `—` none, `JWT` bearer token, `admin` `x-admin-key`
header (`ADMIN_API_KEY`), `bot` `x-bot-key` header (`BOT_API_KEY`), `soft` optional (reads token if
present, never rejects). Per-IP / per-user rate limits apply to auth, uploads, GPU, reports,
framecheck, and battle routes.

### Health & telemetry
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | — | `{ok:true}` |
| POST | `/api/clientlog` | — | client error beacon (URL is redacted before storage) |
| GET | `/api/admin/errors` | admin | recent server + client errors |

### Auth & account
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | create account (username 2–32, password **8–128**) → `{token, user}` |
| POST | `/api/auth/login` | — | login → `{token, user}` |
| POST | `/api/auth/forgot` | — | request reset — **always 200** (no account-existence leak); emails via Resend if configured |
| POST | `/api/auth/reset` | — | complete reset with the emailed token + new password |
| DELETE | `/api/account` | JWT | permanent delete — **requires current password**; removes decks/uploads/fs/desktop/mail/tournaments/files |

### Decks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/decks` | JWT | all of the user's decks |
| PUT | `/api/decks/:id` | JWT | create/update (upsert) — body includes `cards, sideboard, commander, deckPhoto, layout, defaultLayout, printPref, public, splashOwner, splashSite` |
| DELETE | `/api/decks/:id` | JWT | delete a deck |
| GET | `/api/decks/:id/share` | — | a single public deck by id |
| GET | `/api/users/:username/splash` | — | a user's public splash deck |
| GET | `/api/site/:site/splash` | — | the public splash deck for a site domain |

### Cards
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/cards/search?q=&page=&per_page=` | — | search (Scryfall-syntax subset); **503 `{fallback:true}`** if unseeded |
| GET | `/api/cards/named?name=` | — | exact-then-FTS card lookup |
| GET | `/api/cards/keywords` | — | distinct keyword list (filter typeahead) |
| GET | `/api/cards/prints?oracle=` | — | all paper printings (Scryfall, cached 24h) — powers art/printing swap |
| POST | `/api/cards/guess` | — | mobile guess engine: candidates by color/cmc/type/P-T/name/format, ranked by EDHREC |
| GET | `/api/cards/refresh/status` | — | card-DB refresh status |
| POST | `/api/cards/refresh` | admin | trigger a card-DB refresh |
| GET·POST | `/api/cards/hash-refresh` · `/api/cards/hash-refresh/status` | admin (POST) | build/report the pHash artwork index |
| GET·POST | `/api/cards/printings-refresh` · `/api/cards/printings-refresh/status` | admin (POST) | build/report the printings set-list index |

**Search syntax (Scryfall subset):** `c:`/`color:`, `ci:`/`identity:` (incl. `c` colorless, `m`
multicolor), `t:`/`type:`, `o:`/`oracle:`, `f:`/`format:`, `cmc`/`mv` with `= > < >= <= !=`,
`r:`/`rarity:`, `kw:`/`keyword:`, and bare words (FTS over name/type/oracle/keywords).

### Uploads & moderation
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/uploads/analyze` | JWT | vision pass for the cropper (corners + read name + is-card) — no store, no quota |
| POST | `/api/uploads/card-art?autocrop=1&name=&oracle=` | JWT | upload custom card art (multipart `file`); deskew → 3 WebP sizes → identity cascade |
| POST | `/api/uploads/deck-photo` | JWT | full-deck photo for the splash header (≤1600px WebP) |
| GET | `/api/uploads` | JWT | the user's library + card quota |
| PATCH | `/api/uploads/:id` | JWT | set/confirm which card an upload depicts |
| DELETE | `/api/uploads/:id` | JWT | delete files + row, then auto-revert any decks that used it |
| POST | `/api/uploads/:id/save` | JWT | keep a deck photo in the Gallery (kind `deck`→`deck_saved`); counts toward the limit |
| POST | `/api/uploads/:id/unsave` | JWT | release a saved deck photo (`deck_saved`→`deck`); frees a quota slot |
| POST | `/api/uploads/:id/report` · `/api/uploads/report` | soft | moderation report (by id or by image URL) |
| GET | `/api/admin/reports` | admin | reported uploads, most-reported first |
| POST | `/api/admin/uploads/:id/takedown` | admin | purge an upload (any owner) + revert decks |

- **card-art**: best-effort vision check (a *confident* non-card → **422**), card-name read, and
  corner location; `autocrop=1` perspective-deskews from the corners (bbox crop → full-frame
  fallback), then re-encodes to small/normal/large WebP (~63:88). Quota: `UPLOAD_LIMIT` (default 100)
  `kind='card'` uploads/user; over → **409**. Deck photos don't count. Files are server-named, stored
  at `UPLOAD_DIR/<userId>/<key>__<size>.webp`, served read-only by nginx at `/u/…`. Re-encoding
  strips EXIF / embedded payloads.

### Splash / share rendering
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/splash/render` | soft | composite a deck PNG server-side (`sharp`) — SSRF **allowlist**: `/u/…` files + `cards.scryfall.io` only |
| POST | `/api/splash/bg-generate` | soft | AI scene background from a **closed word-list** prompt — **503** until `IMG_GEN_URL` is set |

### Account-synced shells
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET·PUT | `/api/fs` | JWT | Win95 folder tree (≤200 KB JSON) |
| GET·PUT | `/api/desktop` | JWT | desktop layout: widgets + notes (≤300 KB JSON) |

### Tournaments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST·GET | `/api/tournaments` | JWT (POST) / soft (GET) | create / browse upcoming (filters: format, mode, level, region) |
| GET | `/api/tournaments/mine` | JWT | tournaments I posted |
| GET | `/api/tournaments/:id` | soft | detail + RSVP tallies + my RSVP |
| DELETE | `/api/tournaments/:id` | JWT | delete one I host |
| POST | `/api/tournaments/:id/rsvp` | JWT | set/clear my RSVP (`going`/`maybe`/`no`/`clear`) |
| GET·POST·DELETE | `/api/tournaments/subs` · `/api/tournaments/subs/:id` | JWT | parameter subscriptions (format/mode/region/level/fee/geo) |
| GET | `/api/tournaments/feed` | JWT | upcoming events matching any of my subscriptions |

Posting a tournament fans out **mail** to every (other) user whose subscription matches.

### Mail
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/mail` · `/api/mail/unread` | JWT | inbox / unread count + `is_admin` |
| POST | `/api/mail/:id/read` · `/api/mail/read-all` | JWT | mark read |
| DELETE | `/api/mail/:id` | JWT | delete a message |
| POST | `/api/mail/:id/reply` | JWT | reply to a message that has a sender |
| POST | `/api/mail/feedback` | JWT | feedback / feature request → admins |
| POST | `/api/mail/admin/send` | JWT (admin flag) | send to one user or broadcast |

### Integrations & web tools
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/integrations/status` | — | whether the Discord-bot tournament ingest is configured |
| POST | `/api/integrations/tournament` | bot | the MTG Discord bot posts a tournament (creates it + fans out mail) |
| GET | `/api/web/framecheck?url=` | — | can a URL be iframed? Header-only, **SSRF-guarded** (validates + pins the IP on every redirect hop) |

### Card Duel (online)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/battle/create` | — | new room: a hidden card + clue schedule; returns a per-player token |
| POST | `/api/battle/:code/join` | — | join by code (room caps at 2) |
| GET | `/api/battle/:code` | — | public room state — **the answer is withheld until the round is over** |
| POST | `/api/battle/:code/reveal` · `/api/battle/:code/guess` · `/api/battle/:code/rematch` | — | (token-gated) reveal next clue / guess / new round |

---

## Frontend ("Deck OS")

The desktop builder is a three-panel layout (deck list · search/visual · card detail/stats). On
**mobile** (`max-width:900px`) it reframes as a Windows-95 PC: a desktop with icons, a Start menu, a
taskbar, decks-as-files, account-synced folders, and every feature as a launchable **program**. All
of this is mobile-gated; desktop browsers see the plain builder (plus the optional Level-B WM).

### Extension surface
- **`window.DeckOS`** — the versioned public API (`version '1.0'`): `registerProgram`, `store`
  (swappable key/value), `decks`, `ui`, `mode`/`isLocal`, `widgets`, `calendar`, `notes`, folder
  storage, and mod installation. A "program" is one `DeckOS.registerProgram({id,title,icon,mount})`
  call (or an `MGW_APPS` entry); it gets a Win95 window + Start-menu entry + window states for free.
- **Mods** — two trust tiers (see [`SECURITY.md`](SECURITY.md) and [`mymagicdeck/mods/`](mymagicdeck/mods)):
  *trusted* (`new Function` userscript, full session, explicit opt-in) and *sandboxed*
  (`sandbox="allow-scripts"` iframe over a narrow `postMessage` capability bridge).
- **Personal (local) mode** — runs account-less in this browser; hides the account/subdomain
  programs; decks live in `DeckOS.store`, optionally mirrored to a chosen folder or pointed at a
  self-hosted API base.

### Window management
There are **two presentation layers over one shared program registry (`MGW_APPS`)**:
- **MGW** (`mgw*`) drives the **mobile** shell — full / mini-drag / minimized + the desktop tray.
- **WM** ("Level B", `wm*`) drives **desktop** floating, resizable windows; it has no registry of
  its own and delegates back into `MGW_APPS`. Active when `body.wm-on`.

This is the **blessed end state**, not an unfinished migration: on desktop the `mgw*` lifecycle
functions delegate to `wm*` (via `wmEligible`), so `wm*` owns every desktop window; `mgw*` does the
real work only on mobile. Both paths are load-bearing (MGW = mobile, WM = desktop). Converging mobile
onto `wm*` is possible but deliberately not planned — see [`WINDOW-MANAGER.md`](WINDOW-MANAGER.md).

### Programs
CGG (Card Guesser), Card Duel, Splash Builder, Share Deck, Share Image, Storage (uploads), HUD,
Recycle Bin, System Settings, About, Files, Mail, MyMagicBot, Calendar, Notes, Mana Pool,
TWENTYFOURTY (life counter), The Land Game, Tournaments, and web-shortcut programs.

### Other frontend features
- **Search** — debounced, local-API-first with a Scryfall fallback on a genuine local outage
  (`AbortController` + sequence guard against races).
- **Filter panel** — an interactive card mockup driving color/type/format/CMC/P-T/rarity/keyword filters.
- **Deck visual view** — MTGO-style CMC/type/color columns, drag-reorder, hover-zoom, printings popover.
- **Stats** — counts, average MV, price, mana curve, color pips, type breakdown, format legality.
- **Import/export** — plain text + MTG Arena format; export as text/Arena/JSON.
- **Sharing** — base64 deck in the URL hash, public-link toggle, splash pages, username subdomains.
- **Keyboard** — Ctrl+K search, Ctrl+S save, Ctrl+D toggle view, Esc close.

---

## Pipelines

### Card data
1. **Seed** on first boot if `cards` is empty: download Scryfall `oracle_cards` bulk.
2. **Daily refresh** ~03:00 UTC (`setTimeout` → `setInterval`); manual trigger `POST /api/cards/refresh` (admin).
3. Download → parse → upsert all cards in one transaction → rebuild FTS5 → `wal_checkpoint(TRUNCATE)`.
   Skips `reversible_card` printings (no gameplay data). Status at `/api/cards/refresh/status`.

### Card identification (uploads)
Neither signal is reliable alone on real photos, so identity uses a **staged cascade**
(`cascadeIdentify`): (1) explicit expected card (splash-replace) wins; (2) the VLM-read **name**,
fuzzy-matched (Levenshtein) against the card DB — name is ~unique in Magic; (3) disambiguate a
garbled read by **mana cost / CMC**; (4) if several remain, **pHash ranks the crop within those
few** (`rankHashAmong` — reliable as a local ranker even though global pHash isn't); (5) else the best
fuzzy name as an *unconfirmed* suggestion (with an `escalateIdentify` hook for a future agentic
verifier); (6) no readable name → global `matchHash` as an **unconfirmed suggestion only**. Corners
come from OpenCV (`detect_corners.py`); the VLM is used only to read the name. `card_hashes` indexes
a 64-bit DCT pHash of every unique Scryfall artwork (`POST /api/cards/hash-refresh`).

### Splash / share image (`POST /api/splash/render`)
Composites a deck PNG server-side (Scryfall images aren't CORS-enabled, so client capture can't
export). Background = a key (placeholder PNG under `/u/_bg/`), a `#hex`, an AI scene
(`/u/<sub>/bg_*.png` or the shared guest area), or none. Cards are fetched via an **allowlist**
(`/u/…` files + `cards.scryfall.io`), composited with `sharp`, then an SVG overlay (title/price band,
CMC curve, deck-list panel, type-breakdown bar) is drawn on top — either in fixed header/footer bands
or at user-dragged positions (User Layout). **AI backgrounds** (`/bg-generate`) build a prompt from
closed word-lists (`BG_SCENES`/`BG_VIBES`) + a hidden server-side whimsy modifier, call `IMG_GEN_URL`
(dormant/503 until set), and are rate-limited + globally concurrency-capped to protect the inference box.

---

## Deployment

- **Container:** Docker, `node:20-alpine` + `imagemagick` + `py3-opencv`/`py3-numpy` + DejaVu fonts.
- **Data:** SQLite at `/data/mymagicdeck.db` (host `/srv/data/mymagicdeck`, volume-mounted).
- **Uploads:** `UPLOAD_DIR` (default `<DB dir>/uploads`); mount nginx at `/u/` to serve it read-only.
- **Reverse proxy:** nginx proxies `/api/` to the container on :3002; public via the Cloudflare tunnel.
- **Rebuild after an `api/` change:** `cd /srv/docker && docker compose build mymagicdeck-api && docker compose up -d mymagicdeck-api` (or `agent/rebuild-api.sh`). The static frontend needs no rebuild.
- See [`api/DEPLOY.md`](api/DEPLOY.md) for homelab specifics.

### Environment variables
| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3002` | listen port |
| `JWT_SECRET` | — | **required**; must be ≥32 chars and not the default, or the server refuses to start |
| `ADMIN_API_KEY` | — | gates `/cards/refresh`, `/hash-refresh`, `/printings-refresh`, `/admin/*`; unset → those endpoints 503/disabled |
| `BOT_API_KEY` | — | service key for the Discord-bot tournament ingest; unset → integration 503 |
| `ADMIN_USERNAME` | `jake` | user granted the `is_admin` flag on boot |
| `RESEND_API_KEY` / `RESEND_FROM` | — | password-reset email; dormant until set (forgot still 200s) |
| `APP_BASE_URL` | `https://mymagicdeck.com` | base for reset links |
| `DB_PATH` | `/data/mymagicdeck.db` | SQLite path |
| `UPLOAD_DIR` | `<DB dir>/uploads` | upload storage root |
| `UPLOAD_LIMIT` | `100` | card-art uploads per user |
| `VLM_ENABLED` | `true` | set `false` to skip the vision card-check |
| `VLM_BASE_URL` | `http://192.168.1.207:8081/v1` | OpenAI-compatible multimodal endpoint |
| `VLM_MODEL` / `VLM_TIMEOUT` | `local` / `60000` | model id / ms before falling back to smart-crop |
| `IMG_GEN_URL` / `IMG_GEN_TIMEOUT` | — / `120000` | text-to-image endpoint for AI backgrounds; **unset = feature dormant (503)** |
| `BG_MAX` / `BG_CONCURRENCY` | `6` / `1` | AI-background budget per user / global in-flight cap |
| `PHASH_THRESHOLD` | `14` | max Hamming distance for a confident pHash match |
| `LOG_LEVEL` | `info` | Fastify logger level |

### Domain routing
- `mymagicdeck.com` → static `index.html` + `/api/` (proxied to the container).
- `*.mymagicdeck.com` → the same static file; JS detects the subdomain and loads that user's splash.
- `myvintagedeck.com` / `mycommanderdeck.com` → the same static file; JS detects the domain and loads the site splash.

---

## Testing & maintenance

- **`tests/run.sh`** — the regression loop: `frontend-check.mjs` (static checks on `index.html` —
  `node --check` of the inline script, balanced tags, required element ids, API/PWA wiring) + the
  API smoke tests run inside the container. **Green before every commit.**
- **`tests/gui/`** — Puppeteer GUI tests per feature (run against a live instance).
- **`agent/`** — ops scripts (`verify.sh`, `rebuild-api.sh`, `health.sh`, `preflight.sh`), the
  `playbooks/`, and an optional MCP server. See [`AGENTS.md`](AGENTS.md) for the change→verify→commit loop.

## Known limitations

The security-relevant deferrals (synchronous-SQLite event-loop blocking under high load; no CSP, with
the iframe-sandbox rationale) are tracked with their reasoning in [`SECURITY.md`](SECURITY.md). The
window-manager split (MGW = mobile, WM = desktop) is the **blessed architecture**, not an open item —
see [`WINDOW-MANAGER.md`](WINDOW-MANAGER.md).

---
*Updated 2026-06-18 by Claude (Opus 4.8, via Claude Code) — reconciled with the current codebase
(full API + schema reference, corrected stack/limitations). Keep it matching the code.*
