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
| **Splash Builder** | Designs/edits the public splash page for a deck. |
| **Share Deck** | Public share link + sets which deck is published to each splash site. |
| **Storage** | The "My Uploads" custom-card-art library. |
| **HUD** | Live status of your published pages (`you.mymagicdeck.com` / `.myvintagedeck.com` / `.mycommanderdeck.com`) — up/down + which deck is set. Anchors as a faded desktop widget. |
| **Recycle Bin** | Soft-deleted decks (restore / empty). |
| **System Settings / About** | Small system programs. About = "DECK OS v1 · 2026". |

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

Set in **System Settings → Mode**, or `DeckOS.mode = 'local'`. Personal mode is for running the app
**account-less for yourself**: it hides the account/subdomain programs (Share, HUD, Account, Storage)
from the desktop, and your decks live in this browser via `DeckOS.store`. The deckbuilder, search,
Card Guesser, folders, and any installed mods stay. (Card search/guess still use the public API;
a fully offline/self-hosted build that points `DeckOS.store` at a folder or a private API is the
next step on the roadmap.)

### Mods, and the trust model (roadmap)

Because a program is just `DeckOS.registerProgram(...)`, third-party **mods** are loadable JS that
call it. The intended split:

- **Local / self-hosted → full trust.** It's your machine; a mod is a JS file you load (like a
  userscript). Your PC can have a lamp, a price tracker, whatever — most people's won't.
- **Hosted multi-tenant → sandboxed, opt-in.** Mods run in a sandboxed iframe and talk to the host
  over a narrow `postMessage` capability API, so an installed mod can't read your account or affect
  other users. Cosmetic widgets are easy; deeper tools get a bounded API surface.

The `DeckOS` facade is the stable contract both paths target; keep it versioned so community mods
don't break when the core changes.

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
- Nightly: SQLite online backup (`/srv/scripts/backup-mymagicdeck.sh`) and an off-box `.env`
  copy to the Mac mini.

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

## Related

- Homelab service doc: wiki → *DL380 → Services → Docker → `mymagicdeck-api`*.
- Memory: `project_mymagicdeck.md` (the working log of this app's design decisions).

---
*Updated 2026-06-16 by Claude (Opus 4.8, via Claude Code) — full rewrite for the "Deck OS" mobile shell.*
