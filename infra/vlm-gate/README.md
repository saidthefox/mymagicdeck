# vlm-gate

A tiny pure-stdlib Python reverse proxy that sits **in front of the GPU VLM** (llama.cpp on
`192.168.1.207:8081`) and meters access so a continuous card-scan stream can't overload the GPUs.

Runs on the always-on Mac Mini (`192.168.1.109`, Apple Silicon, system Python 3.9).

## What it does
- **Hard concurrency cap** (`GATE_MAX_CONCURRENCY`, default 1): only N `/v1/chat/completions` in flight
  at once. Excess waits `GATE_ACQUIRE_TIMEOUT`s then gets a fast `503 {busy:true}` — never piles onto the GPU.
- **Min gap** between forwards (`GATE_MIN_GAP_MS`) so the card never gets back-to-back hits.
- **Dedup** (`GATE_DEDUP_TTL`, `GATE_DEDUP_DIST`): fingerprints (aHash) the image in each chat request; an
  identical-ish frame seen within the TTL reuses the last VLM answer — so **holding a card steady = one GPU
  call**, not one per frame. Needs OpenCV.
- **`POST /deskew`**: raw image body → `{corners, crop_b64}` via OpenCV corner-detect + perspective warp.
  The API calls this so the per-frame corner/deskew CPU runs on the efficient Mini, not the old DL380.
  (pHash itself stays in the API so hashes stay comparable to the index.)
- **Circuit breaker**: after `GATE_FAIL_TRIP` consecutive upstream errors it opens for `GATE_OPEN_SECS`
  and fails fast, instead of hammering a wedged box.
- Everything else under `/v1/*` passes straight through. `/health` reports stats.

The API points `VLM_BASE_URL` at this gate (`http://192.168.1.109:8088/v1`) and `SCAN_DESKEW_URL` at
`…/deskew`, so **every** GPU consumer (card scan, upload analyze, splash art) is protected with no app
code change, and scan corner/deskew is offloaded to the Mini.

## Dependencies
Proxy + concurrency are pure stdlib. Dedup + `/deskew` need OpenCV in a venv:
```
python3 -m venv ~/vlm-gate/venv && ~/vlm-gate/venv/bin/pip install numpy opencv-python-headless
```
The launchd plist runs `~/vlm-gate/venv/bin/python3`. If cv2 is missing, dedup + /deskew degrade off and the
plain metering proxy still runs.

## Deploy (on the Mini)
```
scp vlm_gate.py jake@192.168.1.109:~/vlm-gate/vlm_gate.py
scp com.saidthefox.vlmgate.plist jake@192.168.1.109:~/Library/LaunchAgents/
ssh jake@192.168.1.109 'launchctl load -w ~/Library/LaunchAgents/com.saidthefox.vlmgate.plist'
```
Logs: `~/vlm-gate/gate.log`. Health: `curl http://192.168.1.109:8088/health`.
Restart after edits: `launchctl kickstart -k gui/$(id -u)/com.saidthefox.vlmgate`.

## Persistence: LaunchAgent vs LaunchDaemon
Installed as a **LaunchAgent** (`~/Library/LaunchAgents/`, starts on login, KeepAlive restarts on crash).
To survive a reboot **without** a login session, convert to a LaunchDaemon (needs sudo):
```
launchctl unload ~/Library/LaunchAgents/com.saidthefox.vlmgate.plist
sudo cp com.saidthefox.vlmgate.daemon.plist /Library/LaunchDaemons/com.saidthefox.vlmgate.plist
sudo launchctl load -w /Library/LaunchDaemons/com.saidthefox.vlmgate.plist
```
(The `.daemon.plist` runs as user `jake` via the `UserName` key.)

## Revert
Point the API back at the GPU directly: remove `VLM_BASE_URL` (or set it to
`http://192.168.1.207:8081/v1`) in `/srv/docker/docker-compose.yml` and `docker compose up -d mymagicdeck-api`.
