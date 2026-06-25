# Tournament load test

Drives the **full closed-loop tournament flow** (bot creates pairings → players tap life, set decks, report
games, both-confirm finish → interactions ledger write → conclude) against an **isolated** API instance.
Never touches prod: its own image, container, port (3099), throwaway SQLite DB, fake secrets, rate limits
off, card-refresh skipped.

## Run
```bash
bash tests/load/up.sh                 # build test image, start mmd-loadtest-api:3099, seed 1000 users
node tests/load/run.mjs               # default: 200 matches/stage, sweep concurrency 20→600
MATCHES=400 STAGES="50,150,400" node tests/load/run.mjs   # heavier sweep
bash tests/load/down.sh               # stop + wipe
```
Tunables (env): `SEED_USERS` (up.sh), `MATCHES`, `LIFE_TAPS`, `STAGES`, `BASE`.

## Isolation
The test instance relies on two **default-off** env flags in `api/server.js` (prod never sets them, so prod
behaviour is unchanged):
- `RATE_LIMIT_DISABLED=1` — every per-IP limiter becomes a no-op (a single load box would otherwise just
  measure the rate limiter).
- `SKIP_CARD_REFRESH=1` — don't download Scryfall bulk data on an empty DB.

## Reading results
Per stage: req/s, and per-endpoint p50/p95/p99/max latency + error counts. Sweeping the concurrency cap (max
in-flight requests ≈ simultaneous matches) shows where the single-box / synchronous-`better-sqlite3` model
starts queueing. Expect **zero errors** but a **growing latency tail** as concurrency climbs.

## Known constraints surfaced
- `/api/integrations/discord/pairings` caps at **64 pairings per call** — the bot must batch larger rounds
  (the driver does this automatically).
