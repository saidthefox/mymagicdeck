#!/usr/bin/env bash
# Bring up an ISOLATED load-test API instance — separate container, throwaway DB, fake secrets, rate limits
# off, card-refresh skipped. Touches NOTHING in prod (own image, own port 3099, own /srv/data/mmd-loadtest).
set -euo pipefail
IMG=mmd-loadtest-api; CT=mmd-loadtest-api; DATA=/srv/data/mmd-loadtest
SEED_USERS="${SEED_USERS:-1000}"

docker rm -f "$CT" >/dev/null 2>&1 || true
mkdir -p "$DATA"; rm -f "$DATA"/*.db "$DATA"/users.json 2>/dev/null || true

echo "→ building test image from current api/ source…"
docker build -q -t "$IMG" /srv/sites/mymagicdeck/api >/dev/null

echo "→ starting $CT on 127.0.0.1:3099…"
docker run -d --name "$CT" -p 127.0.0.1:3099:3002 \
  -e JWT_SECRET=lt_jwt_secret_local_padding_0123456789abcdefXYZ \
  -e BOT_API_KEY=lt_bot_key_local \
  -e ADMIN_API_KEY=lt_admin_local \
  -e RATE_LIMIT_DISABLED=1 \
  -e SKIP_CARD_REFRESH=1 \
  -e DB_PATH=/data/mmd-loadtest.db \
  -e PORT=3002 -e LOG_LEVEL=error \
  -v "$DATA":/data \
  -v /srv/sites/mymagicdeck/tests/load:/load:ro \
  "$IMG" >/dev/null

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3099/api/health >/dev/null 2>&1; then echo "✅ test API healthy"; break; fi
  if [ "$i" = 30 ]; then echo "❌ never came healthy — docker logs $CT"; exit 1; fi; sleep 1
done

echo "→ seeding $SEED_USERS users…"
docker exec -e SEED_USERS="$SEED_USERS" -e NODE_PATH=/app/node_modules "$CT" node /load/seed.js
echo "ready. run:  node tests/load/run.mjs    teardown:  bash tests/load/down.sh"
