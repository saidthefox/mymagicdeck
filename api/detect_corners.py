#!/usr/bin/env python3
"""Document-scanner style card-corner detector.

Usage: python3 detect_corners.py <image_path>
Prints JSON: {"corners": [[x,y],[x,y],[x,y],[x,y]] | null} with the card's four
corners as fractions (0..1) of the image, ordered top-left, top-right,
bottom-right, bottom-left. Best-effort: prints {"corners": null} on any trouble.
"""
import sys
import json


def order_points(pts):
    import numpy as np
    pts = pts.reshape(4, 2).astype("float32")
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)  # y - x
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return [tl, tr, br, bl]


def detect(path):
    import cv2
    import numpy as np
    img = cv2.imread(path)
    if img is None:
        return None
    H, W = img.shape[:2]
    if H == 0 or W == 0:
        return None
    img_area = float(W * H)

    # Work on a downscaled copy for speed; coords are normalized so scale is irrelevant.
    scale = 1000.0 / max(W, H)
    small = cv2.resize(img, (int(W * scale), int(H * scale))) if scale < 1 else img.copy()
    sh, sw = small.shape[:2]
    s_area = float(sw * sh)

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    v = float(np.median(gray))
    edges = cv2.Canny(gray, int(max(0, 0.66 * v)), int(min(255, 1.33 * v)))
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)

    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:12]

    # Score each candidate quad: prefer card-shaped (aspect ~0.72, either orientation)
    # and larger. A low area floor lets a zoomed-out (small-in-frame) card through,
    # while the aspect preference avoids grabbing stray background rectangles.
    AREA_FLOOR = 0.04
    CARD_AR = 0.717  # MTG card width/height

    def score(quad):
        pts = order_points(np.array(quad))
        tl, tr, br, bl = pts
        w = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2.0
        h = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2.0
        if w < 8 or h < 8:
            return -1, None
        ar = w / h
        aspect_pen = min(abs(ar - CARD_AR), abs(ar - 1.0 / CARD_AR))
        qarea = cv2.contourArea(np.array(pts, dtype="float32")) / s_area
        if qarea < AREA_FLOOR:
            return -1, None
        return qarea - aspect_pen * 2.5, pts  # area, penalized by how un-card-shaped it is

    best, best_score = None, -1
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        cand = None
        if len(approx) == 4 and cv2.isContourConvex(approx):
            cand = approx
        elif cv2.contourArea(c) >= AREA_FLOOR * s_area:
            # Not a clean quad (rounded/occluded corners) — try its tightest rotated rect.
            cand = cv2.boxPoints(cv2.minAreaRect(c))
        if cand is None:
            continue
        sc, pts = score(cand)
        if sc > best_score:
            best_score, best = sc, pts

    if best is None:
        return None
    return [[float(p[0]) / sw, float(p[1]) / sh] for p in best]


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"corners": None}))
        return
    try:
        corners = detect(sys.argv[1])
    except Exception:
        corners = None
    print(json.dumps({"corners": corners}))


if __name__ == "__main__":
    main()
