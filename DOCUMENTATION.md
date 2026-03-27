# MyMagicDeck — Technical Documentation

## Overview

MyMagicDeck is a Magic: The Gathering deck builder web application. Users can search for cards, build decks, view deck statistics, share decks via URL or splash pages, and manage multiple decks with cloud sync.

**Live domains:**
- `mymagicdeck.com` — Main deck builder + user splash pages via `username.mymagicdeck.com`
- `myvintagedeck.com` — Splash page for a featured Vintage deck
- `mycommanderdeck.com` — Splash page for a featured Commander deck

---

## Architecture

```
mymagicdeck/
├── mymagicdeck/
│   └── index.html          # Entire frontend: HTML + CSS + JS (~2,400 lines)
├── api/
│   ├── server.js            # Backend API: Fastify + SQLite (~630 lines)
│   ├── package.json         # Node.js dependencies
│   ├── Dockerfile           # Docker build for API container
│   └── DEPLOY.md            # Deployment instructions for homelab
└── .gitignore
```

### Frontend (Single-Page Application)

- **No build step** — one self-contained `index.html` file
- **No frameworks** — vanilla HTML/CSS/JavaScript
- **Storage** — localStorage for offline/guest use, syncs to API when logged in
- **Card data** — fetched from Scryfall API (search) or local API (search + named lookup)

### Backend (REST API)

- **Runtime**: Node.js 20 (Alpine Docker image)
- **Framework**: Fastify 4.x
- **Database**: SQLite via `better-sqlite3` (WAL mode, foreign keys)
- **Auth**: JWT tokens (30-day expiry) via `@fastify/jwt`, bcrypt password hashing
- **Card data**: Bulk-imported from Scryfall oracle_cards, stored in SQLite with FTS5 full-text search
- **CORS**: Open (`origin: true`) — all origins allowed

---

## Database Schema

### `users`
| Column     | Type    | Notes                                   |
|------------|---------|------------------------------------------|
| id         | INTEGER | PK, autoincrement                        |
| username   | TEXT    | Unique, case-insensitive (COLLATE NOCASE)|
| email      | TEXT    | Unique, case-insensitive                 |
| password   | TEXT    | bcrypt hash (12 rounds)                  |
| created_at | INTEGER | Unix epoch                               |

### `decks`
| Column      | Type    | Notes                                       |
|-------------|---------|----------------------------------------------|
| id          | TEXT    | Client-generated ID (timestamp + random)     |
| user_id     | INTEGER | FK → users(id) ON DELETE CASCADE             |
| name        | TEXT    | Default: 'Untitled Deck'                     |
| data        | TEXT    | JSON blob: `{cards, sideboard, commander}`   |
| is_public   | INTEGER | 0/1 — controls share link visibility         |
| is_splash   | INTEGER | 0/1 — marks deck as a splash page deck       |
| splash_site | TEXT    | 'mymagicdeck', 'myvintagedeck', or 'mycommanderdeck' |
| updated_at  | INTEGER | Unix epoch                                   |

**Primary key**: `(id, user_id)` — same deck ID can't belong to two users.

### `cards`
| Column         | Type | Notes                                 |
|----------------|------|----------------------------------------|
| oracle_id      | TEXT | PK — Scryfall oracle ID               |
| name           | TEXT | Card name                             |
| mana_cost      | TEXT | e.g. `{2}{U}{U}`                      |
| cmc            | REAL | Converted mana cost                   |
| type_line      | TEXT | e.g. `Creature — Human Wizard`        |
| oracle_text    | TEXT | Rules text                            |
| colors         | TEXT | JSON array: `["U"]`                   |
| color_identity | TEXT | JSON array: `["U","W"]`               |
| keywords       | TEXT | JSON array: `["Flying","Lifelink"]`   |
| legalities     | TEXT | JSON object: `{standard:"legal",...}` |
| set_id         | TEXT | Set code                              |
| set_name       | TEXT | Set name                              |
| rarity         | TEXT | common/uncommon/rare/mythic           |
| image_uris     | TEXT | JSON: `{small, normal, large}`        |
| card_faces     | TEXT | JSON array (for double-faced cards)   |
| prices         | TEXT | JSON: `{usd, usd_foil}`              |
| updated_at     | INTEGER | Unix epoch                         |

### `cards_fts` (FTS5 virtual table)
Full-text search index over `name`, `type_line`, `oracle_text`, `keywords`. Content-linked to `cards` table (no double storage).

---

## API Endpoints

### Health
| Method | Path          | Auth | Description        |
|--------|---------------|------|--------------------|
| GET    | `/api/health` | No   | Returns `{ok:true}`|

### Authentication
| Method | Path                 | Auth | Description                          |
|--------|----------------------|------|--------------------------------------|
| POST   | `/api/auth/register` | No   | Create account (username, email, pw) |
| POST   | `/api/auth/login`    | No   | Login (username, pw) → JWT token     |

**Register body**: `{username, email, password}` — username 2-32 chars, password 4-128 chars.
**Login body**: `{username, password}`
**Response**: `{token, user: {username, email}}`

### Decks (authenticated)
| Method | Path             | Auth | Description                      |
|--------|------------------|------|----------------------------------|
| GET    | `/api/decks`     | Yes  | List all user's decks            |
| PUT    | `/api/decks/:id` | Yes  | Create or update a deck (upsert) |
| DELETE | `/api/decks/:id` | Yes  | Delete a deck                    |

**PUT body**: `{name, cards, sideboard, public, splashOwner, splashSite, commander}`

### Decks (public, no auth)
| Method | Path                          | Auth | Description                              |
|--------|-------------------------------|------|------------------------------------------|
| GET    | `/api/decks/:id/share`        | No   | Get a public deck by ID                  |
| GET    | `/api/users/:username/splash` | No   | Get a user's public splash deck          |
| GET    | `/api/site/:site/splash`      | No   | Get the splash deck for a specific domain|

### Cards
| Method | Path                        | Auth | Description                                        |
|--------|-----------------------------|------|----------------------------------------------------|
| GET    | `/api/cards/search?q=&page=&per_page=` | No | Search cards (Scryfall syntax subset) |
| GET    | `/api/cards/named?name=`    | No   | Lookup card by exact or fuzzy name                 |
| GET    | `/api/cards/refresh/status`  | No   | Card DB refresh status                             |
| POST   | `/api/cards/refresh`         | No   | Trigger manual card DB refresh                     |

**Search returns 503** if card database has not been seeded yet, with `{fallback: true}`.

### Supported Search Syntax (Scryfall subset)
- `c:wubrg` / `color:wubrg` — Color filter
- `ci:wubrg` / `identity:wubrg` — Color identity filter
- `t:creature` / `type:instant` — Type filter
- `o:text` / `oracle:text` — Oracle text search
- `f:commander` / `format:modern` — Format legality
- `cmc=3`, `cmc>2`, `cmc<=4`, `mv=3` — Mana value
- `r:rare` / `rarity:mythic` — Rarity
- Bare words — Full-text search on name, type, oracle text, keywords

---

## Frontend Features

### Core Deck Building
- **3-panel layout**: Deck list (left) | Search/Visual (center) | Card detail/Stats (right)
- **Card search** with debounced input (300ms), Scryfall syntax support
- **Filter panel** — interactive card mockup with color, type, format, CMC, P/T filters
- **Add/remove cards** with quantity controls (+/- buttons)
- **Sideboard** support with collapsible section
- **4-copy rule** enforcement warnings (visual highlight, stats warning)
- **Basic land** exception for the 4-copy rule

### Deck Visual View (MTGO-style)
- Cards displayed as stacked columns sorted by CMC, type, or color
- **Drag and drop** reordering between columns
- **Hover zoom** — ghost overlay at 2.3x with large image, viewport-clamped
- **Set badge** on hover — click to open printings popover
- **Printings popover** — browse all printings of a card, click to swap art
- **Zoom slider** (50%-150%)

### Deck Statistics
- Total/unique card counts
- Average mana value (excluding lands)
- Estimated price (USD)
- Mana curve bar chart (0-7+)
- Color distribution pips
- Type breakdown with percentages
- Format legality check across 8 formats

### Import/Export
- **Import**: Plain text (`4 Lightning Bolt`) or MTG Arena format
- **Export**: Plain text (grouped by type), MTG Arena format, JSON
- Import resolves card names via local API first, Scryfall fallback
- Section headers (`// Creatures`, `Sideboard`, `[Sideboard]`, `Deck`, `Commander`) recognized

### Sharing & Splash Pages
- **Share URL**: Base64-encoded deck data in URL hash (`#deck=...`)
- **Public link toggle**: Makes deck accessible via `/api/decks/:id/share`
- **Splash pages**: Full-screen deck display with:
  - Commander slot (gold border, auto-detected legendary creature)
  - Type breakdown bar (color-coded segments)
  - Sortable columns (by CMC or type)
  - Zoom slider (60%-160%)
  - Copy list, download .txt, load into builder actions
- **Multi-site splash**: One deck per site (mymagicdeck/myvintagedeck/mycommanderdeck)
- **Username subdomains**: `jake.mymagicdeck.com` → user's splash deck

### Authentication & Sync
- JWT-based auth stored in localStorage (`mmd_token`)
- User avatar with dropdown menu (Share, Sign Out)
- On login: local guest decks are pushed to server, then server decks pulled
- Server wins on conflict (local-only decks preserved if not on server)
- Deck changes sync to server on every save/add/remove (fire-and-forget)

### Keyboard Shortcuts
| Shortcut  | Action                         |
|-----------|--------------------------------|
| Ctrl+K    | Focus search input             |
| Ctrl+S    | Save current deck              |
| Ctrl+D    | Toggle search/deck visual view |
| Escape    | Close modals, splash, menus    |

### Mobile Support
- Responsive layout at ≤900px: single-column with bottom nav (Deck/Search/Card)
- Further simplification at ≤600px: header buttons hidden
- Splash pages: tighter padding, 70% default zoom

---

## Card Data Pipeline

1. **Initial seed**: On first server start, if `cards` table is empty, bulk data is downloaded from Scryfall (`oracle_cards` type, ~30k unique cards)
2. **Daily refresh**: Scheduled at 3:00 AM UTC via `setTimeout` + `setInterval`
3. **Manual trigger**: `POST /api/cards/refresh`
4. **Process**: Download bulk JSON → parse → upsert all cards in one transaction → rebuild FTS5 index
5. **Status tracking**: `GET /api/cards/refresh/status` returns `{status, started, finished, count, error, total}`

---

## Deployment

- **Container**: Docker on Node.js 20 Alpine
- **Data persistence**: SQLite database at `/data/mymagicdeck.db` (volume-mounted)
- **Reverse proxy**: Nginx proxies `/api/` to the container on port 3002
- **Environment variables**:
  - `JWT_SECRET` — Required, must be set in production
  - `DB_PATH` — Default: `/data/mymagicdeck.db`
  - `PORT` — Default: `3002`
  - `LOG_LEVEL` — Default: `info`

### Domain Routing
- `mymagicdeck.com` → serves `index.html` (static) + `/api/` (proxy to container)
- `*.mymagicdeck.com` → same static file, but JS detects subdomain and loads splash
- `myvintagedeck.com` / `mycommanderdeck.com` → same static file, JS detects domain and loads site splash

---

## Known Limitations & Technical Debt

1. **Search goes directly to Scryfall** — `doSearch()` bypasses the local API entirely and hits `api.scryfall.com`. Only `doImport()` and `loadMoreResults()` use the local API. The local card search endpoint exists but isn't the primary search path.
2. **No DB seeding feedback** — Users see no indication when the card database is being populated on first startup.
3. **Deck sync is silent** — `syncDeckToApi()` catches errors to console only; users don't know if sync fails.
4. **Password minimum is 4 characters** — Too weak for production.
5. **No rate limiting** on any endpoint, including auth.
6. **No token refresh** — JWT expires after 30 days with no renewal mechanism.
7. **Duplicate function** — `splashCardTouch()` is defined twice (lines 1511 and 1528).
8. **Price staleness** — Prices refresh daily but there's no UI indicator of when prices were last updated.
9. **No email verification** — Accounts are created without confirming email.
10. **`search-filters` referenced but doesn't exist** — `switchCenterView()` references `document.getElementById('search-filters')` but the element ID is `card-filter-panel`.
