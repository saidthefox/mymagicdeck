# vlm-gate

A tiny pure-stdlib Python reverse proxy that sits **in front of the GPU VLM** (llama.cpp on
`192.168.1.207:8081`) and meters access so a continuous card-scan stream can't overload the GPUs.

Runs on the always-on Mac Mini (`192.168.1.109`, Apple Silicon, system Python 3.9).

## What it does
- **Hard concurrency cap** (`GATE_MAX_CONCURRENCY`, default 1): only N `/v1/chat/completions` in flight
  at once. Excess waits `GATE_ACQUIRE_TIMEOUT`s then gets a fast `503 {busy:true}` — never piles onto the GPU.
- **Min gap** between forwards (`GATE_MIN_GAP_MS`) so the card never gets back-to-back hits.
- **Circuit breaker**: after `GATE_FAIL_TRIP` consecutive upstream errors it opens for `GATE_OPEN_SECS`
  and fails fast, instead of hammering a wedged box.
- Everything else under `/v1/*` passes straight through. `/health` reports stats.

The API points `VLM_BASE_URL` at this gate (`http://192.168.1.109:8088/v1`) instead of 207 directly, so
**every** GPU consumer (card scan, upload analyze, splash art) is protected with no app code change.

## Deploy (on the Mini)
```
scp vlm_gate.py jake@192.168.1.109:~/vlm-gate/vlm_gate.py
scp com.saidthefox.vlmgate.plist jake@192.168.1.109:~/Library/LaunchAgents/
ssh jake@192.168.1.109 'launchctl load -w ~/Library/LaunchAgents/com.saidthefox.vlmgate.plist'
```
Logs: `~/vlm-gate/gate.log`. Health: `curl http://192.168.1.109:8088/health`.
Restart after edits: `launchctl kickstart -k gui/$(id -u)/com.saidthefox.vlmgate`.

## Caveat
It's installed as a **LaunchAgent** (starts on login). On a headless Mini, enable auto-login, or convert to a
**LaunchDaemon** in `/Library/LaunchDaemons` (needs sudo) so it starts at boot without a login session.

## Revert
Point the API back at the GPU directly: remove `VLM_BASE_URL` (or set it to
`http://192.168.1.207:8081/v1`) in `/srv/docker/docker-compose.yml` and `docker compose up -d mymagicdeck-api`.
