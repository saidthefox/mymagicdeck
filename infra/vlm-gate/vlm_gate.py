#!/usr/bin/env python3
"""
vlm-gate — a tiny OpenAI-compatible reverse proxy that sits in front of the GPU VLM
(192.168.1.207:8081) and meters access so a continuous scan stream can never overload it.

Runs on the always-on Mac Mini (Apple Silicon). Pure Python stdlib — no pip deps.

What it adds in front of the GPU:
  • HARD concurrency cap (GATE_MAX_CONCURRENCY, default 1): only N VLM calls in flight at once.
    Anything beyond that waits up to GATE_ACQUIRE_TIMEOUT, then gets a fast 503 {busy:true}
    instead of piling onto the GPUs. This is what stops the meltdown.
  • Minimum gap between forwards (GATE_MIN_GAP_MS) so the card never gets back-to-back hits.
  • Circuit breaker: after GATE_FAIL_TRIP consecutive upstream errors/timeouts it opens for
    GATE_OPEN_SECS and fails fast (503), instead of hammering a wedged box.
  • Passes /v1/* straight through (chat/completions, models, …); the API just points
    VLM_BASE_URL at this gate instead of 207 directly — zero app code change.

Config via env (all optional):
  GATE_PORT=8088  GATE_TARGET=http://192.168.1.207:8081
  GATE_MAX_CONCURRENCY=1  GATE_ACQUIRE_TIMEOUT=0.25  GATE_MIN_GAP_MS=150
  GATE_UPSTREAM_TIMEOUT=70  GATE_FAIL_TRIP=4  GATE_OPEN_SECS=20
"""
import os, sys, json, time, threading, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT             = int(os.environ.get('GATE_PORT', '8088'))
TARGET           = os.environ.get('GATE_TARGET', 'http://192.168.1.207:8081').rstrip('/')
MAX_CONCURRENCY  = int(os.environ.get('GATE_MAX_CONCURRENCY', '1'))
ACQUIRE_TIMEOUT  = float(os.environ.get('GATE_ACQUIRE_TIMEOUT', '0.25'))
MIN_GAP_MS       = int(os.environ.get('GATE_MIN_GAP_MS', '150'))
UPSTREAM_TIMEOUT = float(os.environ.get('GATE_UPSTREAM_TIMEOUT', '70'))
FAIL_TRIP        = int(os.environ.get('GATE_FAIL_TRIP', '4'))
OPEN_SECS        = float(os.environ.get('GATE_OPEN_SECS', '20'))

_sem        = threading.BoundedSemaphore(MAX_CONCURRENCY)
_gap_lock   = threading.Lock()
_last_fwd   = [0.0]            # monotonic time of the last upstream forward
_cb_lock    = threading.Lock()
_fail_count = [0]
_open_until = [0.0]            # circuit-breaker open until this monotonic time
_stats      = {'forwarded': 0, 'busy': 0, 'tripped': 0, 'errors': 0}

def _now(): return time.monotonic()

def _circuit_open():
    with _cb_lock:
        return _now() < _open_until[0]

def _record(ok):
    with _cb_lock:
        if ok:
            _fail_count[0] = 0
        else:
            _fail_count[0] += 1
            if _fail_count[0] >= FAIL_TRIP:
                _open_until[0] = _now() + OPEN_SECS
                _fail_count[0] = 0

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass  # quiet; we log our own one-liners

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except Exception: pass

    def do_GET(self):
        if self.path == '/health' or self.path == '/':
            return self._send_json(200, {'ok': True, 'target': TARGET, 'max_concurrency': MAX_CONCURRENCY,
                                         'circuit_open': _circuit_open(), 'stats': _stats})
        return self._forward('GET', None)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        # Only chat/completions is GPU-heavy and worth metering; pass other POSTs straight through.
        if '/chat/completions' not in self.path:
            return self._forward('POST', body, meter=False)

        if _circuit_open():
            _stats['tripped'] += 1
            return self._send_json(503, {'error': 'vlm upstream cooling down (circuit open)', 'busy': True})

        if not _sem.acquire(timeout=ACQUIRE_TIMEOUT):
            _stats['busy'] += 1
            return self._send_json(503, {'error': 'vlm gate busy', 'busy': True})
        try:
            # space out forwards so the GPU never gets back-to-back hits
            with _gap_lock:
                wait = (_last_fwd[0] + MIN_GAP_MS / 1000.0) - _now()
                if wait > 0: time.sleep(wait)
                _last_fwd[0] = _now()
            return self._forward('POST', body, meter=True)
        finally:
            _sem.release()

    def _forward(self, method, body, meter=False):
        url = TARGET + self.path
        req = urllib.request.Request(url, data=body, method=method)
        for h in ('Content-Type', 'Authorization', 'Accept'):
            v = self.headers.get(h)
            if v: req.add_header(h, v)
        t0 = _now()
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                data = resp.read()
                if meter: _stats['forwarded'] += 1; _record(True)
                self.send_response(resp.status)
                ct = resp.headers.get('Content-Type', 'application/json')
                self.send_header('Content-Type', ct)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                if meter: print(f'[gate] fwd {self.path} {resp.status} {int((_now()-t0)*1000)}ms', flush=True)
        except urllib.error.HTTPError as e:
            data = e.read()
            if meter: _record(e.code >= 500)  # 4xx = client/prompt issue, not an upstream health problem
            self.send_response(e.code)
            self.send_header('Content-Type', e.headers.get('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            if meter: _stats['errors'] += 1; _record(False)
            print(f'[gate] upstream error {self.path}: {e}', flush=True)
            self._send_json(502, {'error': 'vlm upstream unreachable: ' + str(e), 'busy': True})

def main():
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'[gate] vlm-gate on :{PORT} → {TARGET} (max_concurrency={MAX_CONCURRENCY}, '
          f'min_gap={MIN_GAP_MS}ms, breaker={FAIL_TRIP}/{OPEN_SECS}s)', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass

if __name__ == '__main__':
    main()
