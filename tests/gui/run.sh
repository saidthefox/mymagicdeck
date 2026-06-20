#!/usr/bin/env bash
# Headless GUI regression suite (Playwright in Docker, driving the live local site).
# Heavier than tests/run.sh — run it before pushing UI changes, not on every commit.
# Usage: tests/gui/run.sh            (runs every *.mjs)
#        tests/gui/run.sh smoke lc-mobile   (runs just those, by basename)
# A test "fails" if it throws (non-zero exit) or reports CONSOLE_ERRORS/ERRORS > 0.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (…/mymagicdeck)
IMG=mcr.microsoft.com/playwright:v1.49.1-noble

sel="$*"
docker run --rm --network host --add-host mymagicdeck.com:127.0.0.1 -v "$ROOT":/work "$IMG" bash -c '
  cd /tmp && npm i playwright@1.49.1 >/dev/null 2>&1
  sel="'"$sel"'"; pass=0; fail=0
  for f in /work/tests/gui/*.mjs; do
    n=$(basename "$f" .mjs)
    if [ -n "$sel" ]; then case " $sel " in *" $n "*) ;; *) continue;; esac; fi
    cp "$f" /tmp/t.mjs
    out=$(timeout 80 node /tmp/t.mjs 2>&1); code=$?
    ec=$(echo "$out" | grep -iE "CONSOLE_ERRORS:|ERRORS:" | tail -1 | grep -oE "[0-9]+" | head -1)
    if [ $code -ne 0 ]; then echo "FAIL  $n (exit $code)"; echo "$out" | tail -3 | sed "s/^/        /"; fail=$((fail+1));
    elif [ -n "$ec" ] && [ "$ec" -gt 0 ] 2>/dev/null; then echo "FAIL  $n (console errors: $ec)"; fail=$((fail+1));
    else echo "ok    $n"; pass=$((pass+1)); fi
  done
  echo "──── pass:$pass  fail:$fail ────"
  [ $fail -eq 0 ]
'
