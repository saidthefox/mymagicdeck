#!/usr/bin/env bash
# MyMagicDeck test runner. Static frontend checks (host) + API smoke tests (in the container).
# Usage: tests/run.sh
set -uo pipefail
cd "$(dirname "$0")"
rc=0

echo "── frontend ──────────────────────────────"
node frontend-check.mjs || rc=1

echo
echo "── docs ──────────────────────────────────"
node doc-check.mjs || rc=1

echo
echo "── api (mymagicdeck-api container) ───────"
if docker ps --format '{{.Names}}' | grep -q '^mymagicdeck-api$'; then
  docker cp api-smoke.mjs mymagicdeck-api:/tmp/api-smoke.mjs >/dev/null 2>&1
  docker exec -e NODE_PATH=/app/node_modules mymagicdeck-api node /tmp/api-smoke.mjs || rc=1
else
  echo "  ! mymagicdeck-api container not running — skipping API tests"
fi

echo
[ $rc -eq 0 ] && echo "ALL GREEN ✅" || echo "FAILURES ❌"
exit $rc
