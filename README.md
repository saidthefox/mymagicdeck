# MyMagicDeck — "Deck OS"

A Magic: The Gathering deckbuilder at **[mymagicdeck.com](https://mymagicdeck.com)**, with
shareable per-user **splash pages** on username subdomains. On phones the whole app is
reframed as a tiny **Windows-95 desktop** ("Deck OS v1") where every feature is a launchable
program and your decks are files.

> MTG content © Wizards of the Coast. Card data via [Scryfall](https://scryfall.com).
> Fan project — not affiliated with or endorsed by Wizards.

---

## At a glance

| | |
|---|---|
| **Frontend** | One hand-written file: [`mymagicdeck/index.html`](mymagicdeck/index.html) — vanilla JS/CSS, **no build step**. nginx serves it read-only; edits go live on reload. |
| **Backend** | [`api/server.js`](api/server.js) — Fastify + `better-sqlite3`, runs in Docker as `mymagicdeck-api` on :3002. |
| **Database** | SQLite (WAL) at `/srv/data/mymagicdeck/mymagicdeck.db` (host). Cards, users, decks, uploads, pHash index, FS tree, printings. |
| **Uploads** | `/srv/data/mymagicdeck/uploads/<userId>/…`, served read-only by nginx at `/u/…`. |
| **Public** | `/api/` + the static site on `mymagicdeck.com` and `*.mymagicdeck.com` via the homelab nginx-proxy / Cloudflare tunnel. |

### Working on it

- **Frontend:** edit `mymagicdeck/index.html` and reload — nginx sends `Cache-Control: no-cache` on the app HTML, so changes land immediately. There is no bundler; keep everything in the one file.
- **Backend:** after editing `api/`, rebuild the container:
  ```bash
  cd /srv/docker && docker compose build mymagicdeck-api && docker compose up -d mymagicdeck-api
  ```
- **Secrets** live in `/srv/docker/.env` (git-ignored), referenced as `${VAR}` in `docker-compose.yml` (`JWT_SECRET`, `ADMIN_API_KEY`, `RESEND_API_KEY`, …).
- **Verify a frontend edit** without a browser: extract the inline `<script>` and `node --check` it; the inline JS is large, so a quick brace-balance + `node --check` catches most breakage.

---

## The frontend ("Deck OS")

The desktop builder is a normal three-panel layout (deck list · search · card detail). On
**mobile** (`max-width:900px`) it becomes a Windows-95 PC. All of this is mobile-gated;
the desktop browser is unaffected.

### The PC model

- **Root desktop** (`#pc-desktop`) is the base layer — icons, a Start menu, and a taskbar.
  It renders into `#pc-deskcontent`; floating program windows are direct children of
  `#pc-desktop` so they survive desktop re-renders.
- **The whole site is a program window** (`#site-window`) with its own Win95 title bar.
  Minimize (`_`) sends the entire site to the desktop tray; window (`❐`) shrinks it to a
  draggable mini; the **✦ MyMagicDeck** taskbar button restores it.
- **MGW window manager** (`MGW_APPS` / `mgw*` in `index.html`): the generic host that gives any
  "program" the three window states — **full**, **windowed** (a live, scaled, draggable mini),
  **minimized** (hidden, in the taskbar) — plus a taskbar button and z-order focus
  (`mgUiZ`, last-touched on top). Built-in programs live in `MGW_APPS`; third-party ones register
  through the public `DeckOS` API (below).

### Programs

| Program | What it is |
|---|---|
| **CGG — Card Guesser Game** | A tactile, mobile-only card the player taps to describe (color/CMC/type/P-T/name/format); the engine guesses via rules + EDHREC popularity (no LLM — must be instant). Lives as `mg*` functions; the card face is a real Magic-card frame inside a Win95 program window, and the frame tints to the cycled color. Confirming a guess adds the card to the active deck. |
| **Card Duel** | 2-player guessing battle (`battle*` functions). v1 is **local hot-seat**: a hidden real card is dealt, clues reveal one at a time, both players race to guess; first correct wins the round (scores persist in `DeckOS.store`). **Online async** (words-with-friends style) is a planned drop-in: the same clue schedule keyed off a shared seed in a backend "battle room" — create/join by code, POST guesses, poll state. |
| **2040** | Two-player life & match tracker (`lc*`/`tf*`). Tabletop portrait (opponent flipped 180°) or landscape (two upright halves on a stand); tracks a Bo3 match, and a live/tournament mode syncs the opponent's life + records results. |
| **Cardle** | Daily card mystery — clues reveal one at a time, guess the card (`cardle*`, server-backed daily). |
| **Card Duel** | 2-player guessing battle (`battle*`), local hot-seat + online-by-code. |
| **Mana Pool / Dice Bag / Basics (Land Game)** | Play aids: pool mana, roll dice, and a solitaire land-drop game. |
| **Interactions** | Public, zKillboard-style ledger of matches/decks; trace a winning deck through a tournament. |
| **Match History** | Your own past matches (synced). |
| **Calendar / Tournaments / Mail** | Events, nearby-event finder, and in-app messages/notifications. |
| **Splash Builder** | Designs/edits the public splash page for a deck. |
| **Share Deck** | Public share link + sets which deck is published to each splash site. |
| **Gallery (Storage)** | The "My Uploads" custom-card-art library. |
| **Display (HUD)** | Live status of your published pages (`you.mymagicdeck.com` / `.myvintagedeck.com` / `.mycommanderdeck.com`) — up/down + which deck is set. Anchors as a faded desktop widget. |
| **Widgets / Notes / Documents** | Pin live panels to the desktop, jot notes, browse your files/decks. |
| **MyMagicBot** | The companion Discord bot's info/link program. |
| **Recycle Bin** | Soft-deleted decks (restore / empty). |
| **System Settings / About** | Small system programs. About = "DECK OS v1 · 2026". |

Desktop icons carry hover descriptions; programs group into **folders** (Games/Comms/Counters/Sites); the
File actions (New/Open/Save/Import/Share) live in a **right-edge dock** (long-press to move it); and a pinned
mobile taskbar + a `/`-command palette round out navigation.

The desktop also holds your **decks as file icons** (single-tap = set the "adding-to" deck,
double-tap = open in the builder), **folders** (account-synced tree, drag to nest / bin),
and a toolbar (**New Folder / New Deck**, collapsible into a **File** button).

---

## Extending Deck OS — `window.DeckOS` (programs, mods, personal mode)

`index.html` exposes a small, **versioned public API** so anyone (a human, or an LLM you hand the
file + this README) can add features without spelunking internals.

### Write a program

```js
DeckOS.registerProgram({
  id:    'lamp',                 // unique key
  title: 'Lamp',
  icon:  '💡',
  mount(body){                   // body = the window's content element; render anything
    body.innerHTML = '<p style="padding:16px">A cozy desktop lamp. 🔆</p>';
  },
});
```

That's it — DeckOS builds the Win95 window, adds it to the Start menu's **Programs** list, and it
gets full / windowed-mini / minimized / taskbar behavior for free. (Pass your own `overlay` id
instead of `mount` if you want to supply custom markup.)

Other surface:

| API | What |
|---|---|
| `DeckOS.version` | API version (`'1.0'`). |
| `DeckOS.mode` / `isLocal()` | `'hosted'` or `'local'`. |
| `DeckOS.store` | Swappable key/value storage — `get/set/remove/keys` (default backend: localStorage). Use this for mod data. |
| `DeckOS.decks` | `list()`, `get(id)`, `active()`, `save(id)`. |
| `DeckOS.ui` | `toast(msg)`, `open(programId)`. |

### Personal (local) mode

Set in **System Settings → Mode**, or `DeckOS.mode = 'local'`. Personal mode runs the app
**account-less for yourself**: it hides the account/subdomain programs (Share, HUD, Account, Storage)
from the desktop **and the header sign-in chrome**, and your decks live in this browser via
`DeckOS.store`. The deckbuilder, search, Card Guesser, folders, and installed mods stay.

**Own your data** — System Settings → Storage & backup gives three levels:
- **Export / Import** decks as a JSON file (File System Access API where available, else download) — portable, works everywhere.
- **Folder auto-save** (desktop Chromium): pick a folder once and decks mirror to `decks.json` there on every save (handle persisted in IndexedDB; re-permissioned each session). `DeckOS.store.backend === 'folder'`.
- **Self-hosted API** (advanced): set an API base URL to point the PWA at *your own* MyMagicDeck server (`deckos_api_base`; blank = this site). Reloads on save. Note the bundled API's CORS is an **allowlist** (own origins + localhost), so a cross-origin PWA→API setup needs that allowlist widened for your domain (same-origin self-hosting works as-is).

So a personal instance can run account-less, keep decks in a folder it controls, and talk to its
own backend — the hosted multi-tenant site and a self-hosted personal one are the same code.

### Mods — two trust tiers (disabled on the public host for now)

A program is just `DeckOS.registerProgram(...)`, so a **mod** is loadable JS that calls it. Two tiers exist
(System Settings → **Mods** → paste a `…/mod.js` URL):

- **Sandboxed** (default, recommended): runs in a `sandbox="allow-scripts"` iframe (opaque origin — no access
  to the page, cookies, or localStorage), reaching the host only over a narrow `postMessage` capability API
  (read-only sanitized decks, mod-scoped storage, toast, setMeta).
- **Trusted**: `new Function(code)` userscript model — full session access; opt-in per mod with a warning.

> **On the public host (`*.mymagicdeck.com`) all user apps are currently turned OFF** — neither tier installs
> or loads, and the setting shows "turned off for now" (`DeckOS.userAppsEnabled()` gates it; flip to re-enable).
> Self-hosted / localhost instances keep both tiers. A minimal mod:

```js
DeckOS.registerProgram({ id:'lamp', title:'Lamp', icon:'💡',
  mount(b){ b.innerHTML = '<p style="padding:16px">💡 a cozy desktop lamp</p>'; } });
```

---

## The backend

Fastify + `better-sqlite3`. Highlights (see the wiki doc for the full endpoint list):

- **Auth** — JWT (30-day), bcrypt, per-IP rate limits; **password reset** via Resend email.
- **Cards** — ~36k oracle cards in SQLite + FTS5; Scryfall-syntax search (local-first, Scryfall
  fallback on outage). Extra columns `power`/`toughness`/`edhrec_rank` power the guess engine.
  Daily bulk refresh (admin-gated).
- **Decks** — CRUD + public share + per-site splash decks + username-subdomain pages. The deck
  blob carries `commander`, `deckPhoto`, per-copy art, free-drag `layout`, `defaultLayout`.
- **Custom card art** — photo upload → HEIC convert → OpenCV corner detection → staged ID
  cascade (VLM name → fuzzy DB → mana/CMC → **pHash** within candidates, `card_hashes` index) →
  stored as a deck-bound `image_uris` override.
- **Splash render** (`POST /api/splash/render`) — server-side `sharp` composite (deck over a
  background + SVG overlays) with an SSRF allowlist. **AI backgrounds** (`/bg-generate`) hit the
  homelab image-gen server.
- **Filesystem** (`/api/fs`) — the account-synced folder tree for the desktop.
- **Moderation** — upload reports + admin takedown.
- **Custom formats** — Middle School and Triple-A Ante via a `card_printings` set-list table.

### Operational notes

- API changes need a container rebuild (above); the static frontend does not.
- Maintenance endpoints (`/api/cards/refresh`, `/hash-refresh`, `/printings-refresh`) require
  the `x-admin-key` header (`ADMIN_API_KEY`).
- GPU-backed endpoints (uploads/VLM, AI backgrounds) are rate-limited + concurrency-capped to
  protect the brownout-prone 207 inference box.
- Nightly: SQLite online backup (`/srv/scripts/backup-mymagicdeck.sh`, WAL-safe, 14-day retention) and an
  off-box `.env` copy to the Mac mini. A restore drill (`/srv/scripts/restore-drill-mymagicdeck.sh`) verifies
  the newest backup nightly (integrity + counts). Recovery steps + RPO/RTO: [`RESTORE.md`](RESTORE.md).
- **CORS is an allowlist** (own origins + localhost), not `origin:true`. Auth is bearer-token in
  `localStorage`. See [`SECURITY.md`](SECURITY.md) for the current posture.

---

## Layout

```
mymagicdeck/
├── api/                   Fastify + better-sqlite3 backend (Dockerized)
│   ├── server.js          all routes + migrations
│   └── detect_corners.py  OpenCV document-scanner corner detection
├── mymagicdeck/           the static frontend (served by nginx)
│   ├── index.html         the entire app (Deck OS) — one file
│   ├── terms.html         Terms of Service
│   └── privacy.html       Privacy Policy
├── README.md              this file
└── DOCUMENTATION.md
```

## Maintenance & tests

- **`AGENTS.md`** — operating manual for the AI agent that maintains this app (the change→verify→commit
  loop, architecture map, guardrails, playbooks). Read it first if you're an agent.
- **`agent/`** — ops scripts (`verify.sh`, `rebuild-api.sh`, `health.sh`), step-by-step `playbooks/`,
  and an optional MCP server (`agent/mcp/`) exposing those ops as tools.
- **`tests/run.sh`** — frontend static checks + API smoke tests; the regression loop. Run before committing.
- **`SECURITY.md`** — security posture + the reasoning behind each decision.

## Related

- Homelab service doc: wiki → *DL380 → Services → Docker → `mymagicdeck-api`*.
- Memory: `project_mymagicdeck.md` (the working log of this app's design decisions).

---
*Updated 2026-06-16 by Claude (Opus 4.8, via Claude Code) — full rewrite for the "Deck OS" mobile shell.*
