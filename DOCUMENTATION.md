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

### Uploads (authenticated) — custom splash art + library
| Method | Path                                          | Auth | Description                                              |
|--------|-----------------------------------------------|------|----------------------------------------------------------|
| POST   | `/api/uploads/card-art?autocrop=1&name=&oracle=` | Yes | Upload a custom card photo (multipart `file`)        |
| POST   | `/api/uploads/deck-photo`                     | Yes  | Upload a full-deck photo (multipart `file`)              |
| GET    | `/api/uploads`                                | Yes  | The user's upload library + quota                        |
| PATCH  | `/api/uploads/:id`                            | Yes  | Set/confirm which card an upload depicts                 |
| DELETE | `/api/uploads/:id`                            | Yes  | Delete an upload (auto-reverts decks that used it)       |

- **card-art**: best-effort vision pass that (a) checks "is this a Magic card?" — a *confident* non-card → **422**; (b) reads the **card name**; (c) locates the card's **4 corners** (and a bbox fallback). With `autocrop=1` the card is **perspective-deskewed** to straighten a tilted photo (ImageMagick `-distort Perspective` from the corners; falls back to bbox crop, then full frame), then re-encoded to three WebP sizes (small/normal/large, ~63:88). `name`/`oracle` (the card being replaced) auto-label + confirm the upload; otherwise the vision-read name is resolved against the card DB (unconfirmed, user confirms on the page). Returns `{ image_uris, customArt:true, autoCropped, uploadId, cardName, oracleId, confirmed }`.
- **Quota**: 100 `kind='card'` uploads per user (`UPLOAD_LIMIT`); exceeding → **409**. Deck photos don't count.
- **GET /api/uploads** → `{ uploads:[{id,kind,card_name,oracle_id,confirmed,small,normal,large,created_at}], cardCount, limit }`.
- **PATCH** body `{cardName?, oracleId?}` → validates against the card DB, sets `confirmed=1`.
- **DELETE** removes the files + row, then scans the user's decks and reverts any base art (→ default Scryfall image via `oracle_id`), per-copy `arts[i]`, or `deckPhoto` that referenced the deleted image.
- Tracked in the **`uploads`** table (`id,user_id,key,kind,card_name,oracle_id,confirmed,small,normal,large,created_at`).
- **deck-photo**: downsizes to ≤1600px long edge, re-encodes WebP. Returns `{ url }`.
- Images are stored on local disk under `UPLOAD_DIR/<userId>/<uuid>__<size>.webp` and served read-only by nginx at `/u/...`. Uploads are rate-limited per user, size-capped (12 MB), and re-encoded (strips EXIF / embedded payloads). Filenames are server-generated.

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
  - `UPLOAD_DIR` — Default: `<dir of DB_PATH>/uploads` (mount nginx at `/u/` to serve it)
  - `VLM_ENABLED` — Default: `true` (set `false` to skip the vision card-check)
  - `VLM_BASE_URL` — OpenAI-compatible multimodal endpoint. Default: `http://192.168.1.207:8081/v1`
  - `VLM_MODEL` — Default: `local`
  - `VLM_TIMEOUT` — ms before the vision call is abandoned (falls back to smart-crop). Default: `60000`
  - `IMG_GEN_URL` — optional text-to-image endpoint for AI splash backgrounds (e.g. a ComfyUI/SD HTTP wrapper). **Unset = feature dormant** (`/api/splash/bg-generate` returns 503). Contract: `POST {prompt,width,height}` → PNG bytes, or JSON `{image|b64_json}`. `IMG_GEN_TIMEOUT` (ms, default 120000).
  - `UPLOAD_LIMIT` — card-art uploads per user. Default: `100`
  - `PHASH_THRESHOLD` — max Hamming distance for a confident pHash card match. Default: `14`

### Card recognition pipeline (uploads)
- **Corners** come from OpenCV (`api/detect_corners.py`, document-scanner: Canny → largest convex quad → ordered TL,TR,BR,BL), invoked from `detectCornersCV()`. The VLM's corners proved unreliable; it's used only to *read the card name*. The cropper seeds its draggable handles from the CV corners (full-frame fallback).
- **Card identity** uses a **staged cascade** (`cascadeIdentify`), because neither signal is reliable alone on real photos: (1) explicit expected card (splash replace) wins; (2) the VLM-read **name** is fuzzy-matched (Levenshtein) against the card DB — name is ~unique in Magic, so this usually resolves it; (3) a garbled read is disambiguated by **mana cost / CMC**; (4) if several candidates remain, pHash ranks the crop *within those few* (`rankHashAmong` — reliable as a local ranker even though global pHash isn't); (5) otherwise the best fuzzy name is an unconfirmed suggestion, with an `escalateIdentify` stub hook for a future tool-grounded/agentic verifier; (6) no readable name → global `matchHash` as an **unconfirmed suggestion only** (global pHash collides on low-contrast art/photos, so it never auto-confirms). `card_hashes` indexes a 64-bit DCT pHash of every unique Scryfall artwork.
- **Hash index build**: `POST /api/cards/hash-refresh` (fire-and-forget) streams the `unique_artwork` bulk, downloads each small image, hashes it (resumable; only hashes stored, ~1–2 MB); `GET /api/cards/hash-refresh/status` reports progress. The in-memory index loads on boot and after each refresh.

### Deck `data` blob fields (custom art / photo)
- Per-card custom art rides inside the deck JSON: the stored card gets `image_uris` pointed at `/u/...` URLs plus `customArt:true` (and `_origImg` preserved so "Revert to original art" works). No schema change — it persists via the normal deck sync.
- **Per-copy art**: a deck entry (`deck.cards[id] = {card, qty, arts}`) may carry `arts`, an object mapping copy index → `image_uris`, so individual copies of the same card (e.g. 4 different Force of Will photos) can each show different art. The art chooser has an "Apply to: This copy (#N) / All N copies" toggle; "All" sets the base `image_uris` and clears `arts`. Both the splash and the deck-editor render `arts[i]` per copy (copy index parsed from the builder's `cardId_<i>` instance uid).
- **Splash layout** (blob): `defaultLayout` (`'cmc'|'type'|'user'`) sets which order a splash opens in; `layout = {positions:{ '<cardId>_<copyIdx>': {x,y,z} }}` stores the free-drag **User Layout** (each physical copy positioned independently; last-clicked raised via z). Both pass through `PUT /api/decks/:id`.

### Shareable deck image
- **`POST /api/splash/render`** (auth): composites a deck PNG server-side (Scryfall images aren't CORS-enabled, so client-side capture can't export). Body: `{width,height, background (key|#hex|null), cards:[{url,x,y,w,h}] (z-order), overlays:{name,price,list,cmcCurve,typeBreakdown}, meta:{deckName,priceText,list[],curve[],typeSeg[]}}`. Cards are fetched with an **allowlist** (our `/u/...` files + `cards.scryfall.io` only — anti-SSRF), composited via `sharp`, then an SVG overlay (name/price banner, CMC-curve, deck-list panel, type-breakdown bar) is drawn on top. The composer UI snapshots the current splash layout (any mode), lets the user pick a background + toggle overlays, and Download/Share the result.
- **Backgrounds**: placeholder PNGs at `/srv/data/mymagicdeck/uploads/_bg/<key>.png` (served `/u/_bg/...`), generated with ImageMagick. **AI scene backgrounds** (`POST /api/splash/bg-generate`): a constrained prompt builder — closed word-lists only (`BG_SCENES`/`BG_VIBES`, no free text → limits misuse) — plus a hidden server-side "whimsy" modifier (`BG_WHIMSY`, never shown to the user). Calls `IMG_GEN_URL` (dormant/503 until set), saves to `/u/<userId>/bg_*.png`, and the renderer accepts that path as the `background` (validated to the caller's own dir). The diffusion model only makes the *scene*; cards are always composited by our renderer (an LLM can't legibly place specific cards).
- **Header/footer + title**: the rendered image has top+bottom buffer bands totaling 10% (5% each); the deck name renders in the header as "\<name\> by \<author\>". Cards composite into the middle 90%; type-breakdown bar sits in the footer band.
- **Splash layouts**: "Deck pic layout" (tidy grid) and **"Fan layout"** (`fanLayout()`) — a staggered cascade where the vertical step exceeds a card's top-strip height so every card's name + mana cost stays visible (the readability guarantee, done deterministically rather than via the AI).
- `deckPhoto` (deck-level string URL) is passed through by `PUT /api/decks/:id` and rendered as a banner on the splash page.

### Domain Routing
- `mymagicdeck.com` → serves `index.html` (static) + `/api/` (proxy to container)
- `*.mymagicdeck.com` → same static file, but JS detects subdomain and loads splash
- `myvintagedeck.com` / `mycommanderdeck.com` → same static file, JS detects domain and loads site splash

---

## Known Limitations & Technical Debt

1. ~~Search goes directly to Scryfall~~ **(fixed)** — `doSearch()` now queries the local API first (with an `AbortController` + sequence guard to prevent races) and only falls back to `api.scryfall.com` on a genuine local outage (5xx/network), not on a 4xx. Colorless/multicolor (`c:c`, `ci:c`, `c:m`) are handled server-side.
2. **No DB seeding feedback** — Users see no indication when the card database is being populated on first startup.
3. **Deck sync is silent** — `syncDeckToApi()` catches errors to console only; users don't know if sync fails.
4. **Password minimum is 4 characters** — Too weak for production.
5. **No rate limiting** on any endpoint, including auth.
6. **No token refresh** — JWT expires after 30 days with no renewal mechanism.
7. **Duplicate function** — `splashCardTouch()` is defined twice (lines 1511 and 1528).
8. **Price staleness** — Prices refresh daily but there's no UI indicator of when prices were last updated.
9. **No email verification** — Accounts are created without confirming email.
10. **`search-filters` referenced but doesn't exist** — `switchCenterView()` references `document.getElementById('search-filters')` but the element ID is `card-filter-panel`.
