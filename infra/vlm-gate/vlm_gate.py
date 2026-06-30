#!/usr/bin/env python3
"""
vlm-gate — meters + accelerates GPU vision for the homelab, on the always-on Mac Mini.

Sits in front of the llama.cpp VLM (192.168.1.207:8081) so a continuous card-scan stream can't
overload the GPUs, and offloads the cheap CPU vision work off the old DL380.

Endpoints
  /v1/*               transparent OpenAI proxy to the VLM, with:
                        • hard concurrency cap (GATE_MAX_CONCURRENCY, default 1) → fast 503 {busy} on excess
                        • min gap between forwards · circuit breaker
                        • DEDUP: identical-ish frames (held card) reuse the last VLM answer → no GPU call
  POST /deskew        raw image body → {corners, crop_b64}: OpenCV corner-detect + perspective deskew
                        (Phase-2 CPU offload; pHash itself stays in the API so hashes match the index)
  /health             stats

Pure stdlib for the proxy; OpenCV+numpy (venv) power dedup + /deskew. If cv2 is missing, those degrade
off and the plain proxy still runs.
"""
import os, sys, json, time, base64, threading, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT             = int(os.environ.get('GATE_PORT', '8088'))
TARGET           = os.environ.get('GATE_TARGET', 'http://192.168.1.207:8081').rstrip('/')
MAX_CONCURRENCY  = int(os.environ.get('GATE_MAX_CONCURRENCY', '1'))
ACQUIRE_TIMEOUT  = float(os.environ.get('GATE_ACQUIRE_TIMEOUT', '0.25'))
MIN_GAP_MS       = int(os.environ.get('GATE_MIN_GAP_MS', '150'))
UPSTREAM_TIMEOUT = float(os.environ.get('GATE_UPSTREAM_TIMEOUT', '70'))
FAIL_TRIP        = int(os.environ.get('GATE_FAIL_TRIP', '4'))
OPEN_SECS        = float(os.environ.get('GATE_OPEN_SECS', '20'))
DEDUP_TTL        = float(os.environ.get('GATE_DEDUP_TTL', '6'))     # seconds a cached frame answer is reusable
DEDUP_DIST       = int(os.environ.get('GATE_DEDUP_DIST', '6'))      # max aHash Hamming to count as "same frame"
CARD_W, CARD_H   = 672, 936                                         # match the API's CARD_SIZES.large

try:
    import cv2, numpy as np
    CV = True
except Exception as _e:
    CV = False
    print('[gate] OpenCV unavailable — dedup + /deskew disabled:', _e, flush=True)

_sem        = threading.BoundedSemaphore(MAX_CONCURRENCY)
_gap_lock   = threading.Lock(); _last_fwd = [0.0]
_cb_lock    = threading.Lock(); _fail = [0]; _open_until = [0.0]
_dedup_lock = threading.Lock(); _dedup = []   # list of {ahash:int, ts:float, status:int, body:bytes}
_stats      = {'forwarded': 0, 'busy': 0, 'tripped': 0, 'errors': 0, 'deduped': 0, 'deskew': 0}

def _now(): return time.monotonic()
def _circuit_open():
    with _cb_lock: return _now() < _open_until[0]
def _record(ok):
    with _cb_lock:
        if ok: _fail[0] = 0
        else:
            _fail[0] += 1
            if _fail[0] >= FAIL_TRIP: _open_until[0] = _now() + OPEN_SECS; _fail[0] = 0

# ── dedup helpers ─────────────────────────────────────────────────────────────
def _ahash_from_jpeg(raw):
    if not CV: return None
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if img is None: return None
    small = cv2.resize(img, (8, 8), interpolation=cv2.INTER_AREA)
    m = small.mean()
    bits = (small > m).flatten()
    h = 0
    for b in bits: h = (h << 1) | int(b)
    return h
def _hamming(a, b):
    x = a ^ b; d = 0
    while x: x &= x - 1; d += 1
    return d
def _extract_image_bytes(body):
    """Pull the first base64 image out of an OpenAI chat payload."""
    try:
        obj = json.loads(body)
        for msg in obj.get('messages', []):
            c = msg.get('content')
            if isinstance(c, list):
                for part in c:
                    u = (part.get('image_url') or {}).get('url') if isinstance(part, dict) else None
                    if u and ',' in u and u.startswith('data:'):
                        return base64.b64decode(u.split(',', 1)[1])
    except Exception:
        pass
    return None
def _dedup_lookup(ah):
    now = _now()
    with _dedup_lock:
        _dedup[:] = [e for e in _dedup if now - e['ts'] <= DEDUP_TTL]   # expire
        for e in _dedup:
            if _hamming(ah, e['ahash']) <= DEDUP_DIST:
                return e
    return None
def _dedup_store(ah, status, body):
    with _dedup_lock:
        _dedup.append({'ahash': ah, 'ts': _now(), 'status': status, 'body': body})
        if len(_dedup) > 24: _dedup.pop(0)

# ── corner detect + deskew (ported from api/detect_corners.py) ─────────────────
def _order_points(pts):
    pts = pts.reshape(4, 2).astype('float32')
    s = pts.sum(axis=1); diff = np.diff(pts, axis=1)
    return [pts[np.argmin(s)], pts[np.argmin(diff)], pts[np.argmax(s)], pts[np.argmax(diff)]]
def _detect_corners(img):
    H, W = img.shape[:2]
    if H == 0 or W == 0: return None
    scale = 1000.0 / max(W, H)
    small = cv2.resize(img, (int(W * scale), int(H * scale))) if scale < 1 else img.copy()
    sh, sw = small.shape[:2]; s_area = float(sw * sh)
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    v = float(np.median(gray))
    edges = cv2.dilate(cv2.Canny(gray, int(max(0, .66 * v)), int(min(255, 1.33 * v))), np.ones((5, 5), np.uint8), iterations=2)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:12]
    AREA_FLOOR, CARD_AR = 0.04, 0.717
    def score(quad):
        pts = _order_points(np.array(quad)); tl, tr, br, bl = pts
        w = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2.0
        h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2.0
        if w < 8 or h < 8: return -1, None
        ar = w / h; pen = min(abs(ar - CARD_AR), abs(ar - 1.0 / CARD_AR))
        qa = cv2.contourArea(np.array(pts, dtype='float32')) / s_area
        if qa < AREA_FLOOR: return -1, None
        return qa - pen * 2.5, pts
    best, best_s = None, -1
    for c in cnts:
        peri = cv2.arcLength(c, True); approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        cand = approx if (len(approx) == 4 and cv2.isContourConvex(approx)) else (
            cv2.boxPoints(cv2.minAreaRect(c)) if cv2.contourArea(c) >= AREA_FLOOR * s_area else None)
        if cand is None: continue
        sc, pts = score(cand)
        if sc > best_s: best_s, best = sc, pts
    if best is None: return None
    return [[float(p[0]) / sw, float(p[1]) / sh] for p in best]
def _deskew(img, corners):
    H, W = img.shape[:2]
    src = np.array([[c[0] * W, c[1] * H] for c in corners], dtype='float32')
    dst = np.array([[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]], dtype='float32')
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, M, (CARD_W, CARD_H))

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except Exception: pass
    def _raw(self, code, ctype, data):
        self.send_response(code); self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data))); self.end_headers()
        try: self.wfile.write(data)
        except Exception: pass

    def do_GET(self):
        if self.path in ('/health', '/'):
            return self._json(200, {'ok': True, 'target': TARGET, 'cv': CV, 'max_concurrency': MAX_CONCURRENCY,
                                    'circuit_open': _circuit_open(), 'stats': _stats})
        return self._proxy('GET', None, meter=False)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        if self.path == '/deskew':
            return self._do_deskew(body)
        if '/chat/completions' not in self.path:
            return self._proxy('POST', body, meter=False)
        # ── dedup: same frame held in front of the camera → reuse the last answer, skip the GPU ──
        ah = _ahash_from_jpeg(_extract_image_bytes(body)) if CV else None
        if ah is not None:
            hit = _dedup_lookup(ah)
            if hit is not None:
                _stats['deduped'] += 1
                return self._raw(hit['status'], 'application/json', hit['body'])
        if _circuit_open():
            _stats['tripped'] += 1
            return self._json(503, {'error': 'vlm cooling down (circuit open)', 'busy': True})
        if not _sem.acquire(timeout=ACQUIRE_TIMEOUT):
            _stats['busy'] += 1
            return self._json(503, {'error': 'vlm gate busy', 'busy': True})
        try:
            with _gap_lock:
                wait = (_last_fwd[0] + MIN_GAP_MS / 1000.0) - _now()
                if wait > 0: time.sleep(wait)
                _last_fwd[0] = _now()
            return self._proxy('POST', body, meter=True, dedup_ahash=ah)
        finally:
            _sem.release()

    def _do_deskew(self, body):
        if not CV: return self._json(501, {'error': 'opencv not available'})
        try:
            img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
            if img is None: return self._json(400, {'error': 'bad image'})
            corners = _detect_corners(img)
            crop_b64 = None
            if corners:
                crop = _deskew(img, corners)
                ok, enc = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
                if ok: crop_b64 = base64.b64encode(enc.tobytes()).decode()
            _stats['deskew'] += 1
            return self._json(200, {'corners': corners, 'crop_b64': crop_b64})
        except Exception as e:
            return self._json(500, {'error': str(e)})

    def _proxy(self, method, body, meter=False, dedup_ahash=None):
        req = urllib.request.Request(TARGET + self.path, data=body, method=method)
        for h in ('Content-Type', 'Authorization', 'Accept'):
            v = self.headers.get(h)
            if v: req.add_header(h, v)
        t0 = _now()
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                data = resp.read()
                if meter:
                    _stats['forwarded'] += 1; _record(True)
                    if dedup_ahash is not None and resp.status == 200: _dedup_store(dedup_ahash, resp.status, data)
                    print(f'[gate] fwd {self.path} {resp.status} {int((_now()-t0)*1000)}ms', flush=True)
                self._raw(resp.status, resp.headers.get('Content-Type', 'application/json'), data)
        except urllib.error.HTTPError as e:
            data = e.read()
            if meter: _record(e.code >= 500)
            self._raw(e.code, e.headers.get('Content-Type', 'application/json'), data)
        except Exception as e:
            if meter: _stats['errors'] += 1; _record(False)
            print(f'[gate] upstream error {self.path}: {e}', flush=True)
            self._json(502, {'error': 'vlm upstream unreachable: ' + str(e), 'busy': True})

def main():
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'[gate] vlm-gate :{PORT} → {TARGET} cap={MAX_CONCURRENCY} gap={MIN_GAP_MS}ms cv={CV} '
          f'dedup(ttl={DEDUP_TTL}s,dist={DEDUP_DIST})', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass

if __name__ == '__main__':
    main()
