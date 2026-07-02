"""เครื่องยนต์ลากเส้นคุณภาพสูง (v0.3)
- โหมด cutout: VTracer แปลงภาพสี -> เวกเตอร์เนียน (spline) รองรับรู คัดพื้นหลัง รวมสีใกล้กัน
- โหมด lineart: skeletonize ลากแกนกลางเส้น (แก้ปัญหาตัวอักษรเส้นขอบถูกกัดหาย)
VTracer/svgpathtools/skimage = import แบบ lazy (โหลดเฉพาะตอนใช้ -> สตาร์ทเร็ว)
"""
import re
import numpy as np
import cv2
from shapely.geometry import Polygon
from shapely.ops import unary_union


# ---------- helpers ----------
def _hex2rgb(h):
    h = (h or '#000000').strip()
    if h.startswith('#'):
        h = h[1:]
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except Exception:
        return 0, 0, 0


def _translate(t):
    m = re.search(r'translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)', t or '')
    return (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)


def _bg_color(img):
    h, w = img.shape[:2]
    corners = np.array([img[0, 0], img[0, w - 1], img[h - 1, 0], img[h - 1, w - 1]], float)
    return np.median(corners, axis=0)  # BGR


def _close_color(a, b, thr=28):
    return float(np.abs(np.array(a, float) - np.array(b, float)).max()) <= thr


# ---------- โหมด cutout : VTracer ----------
def trace_color(image_path, n_colors=6, filter_speckle=4):
    """คืน [(color_bgr, shapely_geom)] ต่อสี  (คัดพื้นหลัง + รวมสีใกล้กันเหลือ n_colors)"""
    import os
    import tempfile
    import vtracer
    from svgpathtools import svg2paths

    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    bg = _bg_color(img)

    tmp = tempfile.mktemp(suffix='.svg')
    vtracer.convert_image_to_svg_py(
        image_path, tmp, colormode='color', hierarchical='cutout', mode='spline',
        filter_speckle=int(max(1, filter_speckle)), color_precision=6,
        corner_threshold=60, path_precision=6,
    )
    paths, attrs = svg2paths(tmp)
    try:
        os.remove(tmp)
    except Exception:
        pass

    items = []  # (bgr, geom)
    for p, a in zip(paths, attrs):
        r, g, b = _hex2rgb(a.get('fill', '#000000'))
        bgr = (b, g, r)
        if _close_color(bgr, bg):          # ทิ้งพื้นหลัง
            continue
        tx, ty = _translate(a.get('transform', ''))
        polys = []
        for sub in p.continuous_subpaths():
            L = sub.length()
            if L < 3:
                continue
            N = int(max(8, min(1200, L / 4)))
            pts = [(sub.point(i / N).real + tx, sub.point(i / N).imag + ty) for i in range(N + 1)]
            if len(pts) < 4:
                continue
            poly = Polygon(pts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area <= 0:
                continue
            polys.append(poly)
        if not polys:
            continue
        geom = polys[0]
        for q in polys[1:]:
            geom = geom.symmetric_difference(q)   # even-odd -> เจาะรูให้ถูก
        if geom and not geom.is_empty:
            items.append((bgr, geom))

    if not items:
        return []
    return _cluster_colors(items, n_colors)


def _cluster_colors(items, k):
    cols = np.array([it[0] for it in items], np.float32)
    k = int(max(1, min(k, len(items))))
    if k >= len(items):
        labels = list(range(len(items)))
        centers = cols
    else:
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, lab, centers = cv2.kmeans(cols, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
        labels = lab.flatten().tolist()
    out = []
    for gi in range(k):
        geoms = [items[i][1] for i in range(len(items)) if labels[i] == gi]
        if not geoms:
            continue
        merged = unary_union(geoms)
        c = centers[gi]
        out.append(((int(c[0]), int(c[1]), int(c[2])), merged))
    return out


# ---------- โหมด lineart : skeletonize ----------
def trace_lineart(image_path, max_dim=2000, smooth=2, simplify_px=1.2,
                  min_spur=10, min_path_px=14):
    """คืน (rings, (W,H))  · rings = [(coords_px, closed_bool)] แกนกลางเส้น (ตัดหนวด+สมูท)"""
    from skimage.morphology import skeletonize

    gray = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(image_path)
    H0, W0 = gray.shape[:2]
    scale = 1.0
    if max(H0, W0) > max_dim:
        scale = max_dim / float(max(H0, W0))
        gray = cv2.resize(gray, (int(W0 * scale), int(H0 * scale)), interpolation=cv2.INTER_AREA)

    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    sk = skeletonize(bw > 0)

    ys, xs = np.nonzero(sk)
    pts = _prune_spurs(set(zip(xs.tolist(), ys.tolist())), min_spur)

    rings = []
    for path in _trace_skeleton(pts):
        if len(path) < 2:
            continue
        if _polylen(path) < min_path_px:            # ตัดเศษ/จุดเล็ก
            continue
        closed = (tuple(path[0]) == tuple(path[-1])) and len(path) > 3
        arr = _rdp(path, simplify_px, closed)
        for _ in range(int(smooth)):
            arr = _chaikin(arr, closed)
        arr = arr / scale if scale != 1.0 else arr        # กลับสเกล px เดิม
        coords = [(float(x), float(y)) for x, y in arr]
        if len(coords) >= 2:
            rings.append((coords, bool(closed)))
    return rings, (W0, H0)


_NB8 = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def _nbrs(p, pts):
    x, y = p
    return [(x + dx, y + dy) for dx, dy in _NB8 if (x + dx, y + dy) in pts]


def _polylen(path):
    a = np.asarray(path, np.float32)
    return float(np.sqrt(((a[1:] - a[:-1]) ** 2).sum(1)).sum()) if len(a) > 1 else 0.0


def _prune_spurs(pts, min_len, iters=2):
    """ลบกิ่งปลายสั้น (หนวด) ออกจากเส้นโครง"""
    pts = set(pts)
    for _ in range(int(iters)):
        deg = {p: len(_nbrs(p, pts)) for p in pts}
        remove = set()
        for e in [p for p in pts if deg[p] == 1]:
            branch, prev, cur = [e], None, e
            while True:
                nb = [n for n in _nbrs(cur, pts) if n != prev]
                if len(nb) != 1:
                    break
                nxt = nb[0]
                if deg.get(nxt, 0) >= 3:
                    break
                branch.append(nxt)
                prev, cur = cur, nxt
                if len(branch) > min_len:
                    break
            if len(branch) <= min_len:
                remove.update(branch)
        if not remove:
            break
        pts = pts - remove
    return pts


def _trace_skeleton(pts):
    """เดินเส้นโครง 1px -> รายการ polyline (พิกัด (x,y))"""
    pts = set(pts)
    if not pts:
        return []

    def neighbors(p):
        return _nbrs(p, pts)

    deg = {p: len(neighbors(p)) for p in pts}
    used = set()   # frozenset ของ edge

    def walk(a, b):
        path = [a, b]
        used.add(frozenset((a, b)))
        prev, cur = a, b
        while deg.get(cur, 0) == 2:
            nxts = [n for n in neighbors(cur) if n != prev and frozenset((cur, n)) not in used]
            if not nxts:
                break
            nx = nxts[0]
            used.add(frozenset((cur, nx)))
            path.append(nx)
            prev, cur = cur, nx
        return path

    paths = []
    for node in [p for p in pts if deg[p] != 2]:      # เริ่มจากปลาย/แยก
        for n in neighbors(node):
            if frozenset((node, n)) not in used:
                paths.append(walk(node, n))
    for p in list(pts):                                # วงปิดที่เหลือ (deg2 ล้วน)
        for n in neighbors(p):
            if frozenset((p, n)) not in used:
                path = walk(p, n)
                if path[0] != path[-1]:
                    path.append(path[0])
                paths.append(path)
    return paths


def _rdp(path, eps, closed):
    a = np.array(path, np.int32).reshape(-1, 1, 2)
    out = cv2.approxPolyDP(a, float(max(0.3, eps)), bool(closed)).reshape(-1, 2).astype(np.float32)
    return out if len(out) >= 2 else np.array(path, np.float32)


def _chaikin(pts, closed):
    p = np.asarray(pts, np.float32)
    if len(p) < 3:
        return p
    seq = np.vstack([p, p[0]]) if closed else p
    q = []
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        q.append(0.75 * a + 0.25 * b)
        q.append(0.25 * a + 0.75 * b)
    q = np.array(q, np.float32)
    if not closed:
        q = np.vstack([p[0], q, p[-1]])
    return q
