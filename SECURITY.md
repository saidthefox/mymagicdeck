# MyMagicDeck — security posture

Audited 2026-06-16. This is a fan project (MTG deckbuilder); the sensitive data is limited to
email + bcrypt-hashed password + user decks. No payments, no PII beyond email.

## What's in place

- **Auth:** `@fastify/jwt`, 30-day bearer tokens in `Authorization: Bearer` (localStorage), bcrypt
  password hashing. Per-IP rate limits on auth, uploads, GPU endpoints, reports, and battles.
- **CORS = allowlist.** The API only accepts requests from our own origins (apex + `*.mymagicdeck.com`
  subdomains) plus localhost for dev; any other origin is rejected (`api/server.js`, the `origin(origin, cb)`
  callback). Auth is bearer-token (not cookies), so there is no ambient-credential CSRF surface regardless.
- **SQL:** all queries use `better-sqlite3` prepared statements (parameterized) — no string-built SQL.
- **SSRF:** `POST /api/splash/render` fetches only an allowlist (`cards.scryfall.io` + our own `/u/...`).
- **Uploads:** per-user quota + rate limit; moderation reports + admin takedown (`purgeUpload`).
- **Maintenance endpoints** (`/cards/refresh`, `/hash-refresh`, `/printings-refresh`) require
  `x-admin-key` (`ADMIN_API_KEY`).
- **Password reset:** no-leak (`/auth/forgot` always 200), single-use sha256 token, 1h expiry.
- **Card Duel (online):** ephemeral rooms, rate-limited create, per-player random tokens, the answer is
  held server-side and never sent until the round is over, guess text length-capped, room reaped after 6h.
- **Mods — two trust tiers:**
  - *Sandboxed* (default, for untrusted/community mods): runs in a `sandbox="allow-scripts"` iframe
    (opaque origin — no access to the page, cookies, or localStorage); talks to the host only over a
    narrow `postMessage` capability API (read-only sanitized decks, mod-scoped storage, toast, setMeta).
  - *Trusted*: `new Function(code)` userscript model — full session access; opt-in per mod with an explicit
    warning. **Disabled on the public host** (`*.mymagicdeck.com`) — there, only sandboxed mods run. Trusted
    mods are for self-hosted / localhost instances (like a userscript on your own machine).
- **Security headers** (nginx, app blocks): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`. (Set in
  `/srv/docker/nginx/conf.d/default.conf`, outside this repo.)
- **Secrets:** `/srv/docker/.env` (git-ignored), referenced as `${VAR}` in compose; nightly off-box backup.

## Known / deferred (with rationale)

- **No Content-Security-Policy (yet).** The app is one large inline `<script>`, so a strict CSP would need
  `unsafe-inline` today. On the public host the `new Function` trusted-mod path is disabled (sandboxed mods
  only), so untrusted code is confined to the `sandbox="allow-scripts"` iframe. A nonce'd CSP is a future
  hardening step and would require moving the inline handlers/script out of the HTML.
- **Event-loop blocking:** `better-sqlite3` is synchronous and the pHash cascade is CPU-heavy; fine at
  current scale (single host, modest traffic), would need workers/queue at higher load.
- **No app-level error monitoring** (Sentry-style) yet — errors log to a local `errors` table + client log endpoint.
- **Session tokens live in `localStorage`** (bearer, 30-day). Fine given the allowlist CORS + sandboxed mods,
  but moving to HttpOnly-cookie sessions with server-side revocation is a planned hardening step.

## Agent note

Run `tests/run.sh` after any change. When touching auth, uploads, battle, or the mod bridge, re-read
this file and keep the guarantees above intact (especially: parameterized SQL, the SSRF allowlist, the
sandbox capability surface, and not leaking the battle answer early).

---
*Created 2026-06-16 by Claude (Opus 4.8, via Claude Code) — release-readiness security re-check.*
