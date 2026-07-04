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


def prep_image(image_path, min_dim=1500, max_dim=3400):
    """เตรียมภาพให้คมก่อน trace: อัปสเกลภาพเล็ก + ลด noise รักษาขอบ (bilateral)
    คืน path ไฟล์ที่เตรียมแล้ว (ถ้าไม่ต้องแก้ คืน path เดิม). สเกล mm ไม่เพี้ยนเพราะ
    ppm = W/real_width_mm ปรับตาม W ที่เปลี่ยนไปเอง."""
    import tempfile
    try:
        from . import analyze
        img = analyze.load_image(image_path)          # รองรับทุกฟอร์แมต + alpha
    except Exception:
        img = cv2.imread(image_path)
    if img is None:
        return image_path
    H, W = img.shape[:2]
    f = 1.0
    if max(H, W) < min_dim:
        f = min_dim / float(max(H, W))          # ภาพเล็ก -> ขยายให้ VTracer เห็นรายละเอียด
    elif max(H, W) > max_dim:
        f = max_dim / float(max(H, W))          # ภาพใหญ่มาก -> ย่อ คุมแรม
    if abs(f - 1.0) > 1e-3:
        interp = cv2.INTER_CUBIC if f > 1 else cv2.INTER_AREA
        img = cv2.resize(img, (int(W * f), int(H * f)), interpolation=interp)
    img = cv2.medianBlur(img, 3)                # ลบ noise เม็ดเล็ก/JPEG
    img = cv2.bilateralFilter(img, 7, 55, 55)   # ลด noise แต่ยังคงขอบคม
    tmp = tempfile.mktemp(suffix='.png')
    cv2.imwrite(tmp, img)
    return tmp


# ---------- โหมด cutout : เครื่องยนต์คมชัด (clean bilevel + supersample + contour + smooth) ----------
def trace_color(image_path, n_colors=6, filter_speckle=8):
    """คืน [(bgr, geom)] ต่อสี — ล้างเป็นบิเลเวลสะอาด + quantize + contour + Chaikin
    ให้ขอบเนียนกริบสำหรับโลโก้/ป้าย (แทน VTracer ที่ไล่ตาม noise พิกเซล)"""
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    H, W = img.shape[:2]
    sm = cv2.bilateralFilter(img, 7, 45, 45)          # กัน JPEG noise ก่อน quantize

    # quantize สี (เร็ว: kmeans บนภาพย่อ -> assign เต็มภาพแบบ nearest center)
    K = int(max(2, min(n_colors, 10)))
    sw = 600
    small = cv2.resize(sm, (sw, max(1, int(sw * H / W))), interpolation=cv2.INTER_AREA) if W > sw else sm
    Z = small.reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
    _, _, centers = cv2.kmeans(Z, K, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    centers = centers.astype(np.float32)

    flat = sm.reshape(-1, 3).astype(np.float32)
    best = np.zeros(flat.shape[0], np.int32)
    bestd = None
    for k in range(K):
        dk = ((flat - centers[k]) ** 2).sum(1)
        if bestd is None:
            bestd = dk
        else:
            m = dk < bestd
            bestd = np.where(m, dk, bestd)
            best = np.where(m, k, best)
    labels = best.reshape(H, W)

    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    bg = int(np.bincount(border, minlength=K).argmax())   # พื้นหลัง = label เด่นที่ขอบ

    min_area = max(40.0, W * H * 8e-6)
    eps = max(1.0, W / 1600.0)
    ker = np.ones((3, 3), np.uint8)

    items = []
    for k in range(K):
        if k == bg:
            continue
        mask = (labels == k).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, ker)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, ker)
        geom = _mask_to_geom(mask, eps, min_area)
        if geom is not None and not geom.is_empty:
            c = centers[k]
            items.append(((int(c[0]), int(c[1]), int(c[2])), geom))
    return items


def _chaikin_ring(pts, it=2):
    a = np.asarray(pts, np.float32)
    if len(a) < 3:
        return a
    for _ in range(int(it)):
        s = np.vstack([a, a[0]])
        q = np.empty((2 * (len(s) - 1), 2), np.float32)
        q[0::2] = 0.75 * s[:-1] + 0.25 * s[1:]
        q[1::2] = 0.25 * s[:-1] + 0.75 * s[1:]
        a = q
    return a


def _mask_to_geom(mask, eps, min_area):
    """mask -> shapely geom (มีรู) ผ่าน findContours + approxPolyDP + Chaikin (ขอบเนียน)"""
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts or hier is None:
        return None
    hier = hier[0]
    polys = []
    for i, c in enumerate(cnts):
        if hier[i][3] != -1:                    # ข้ามรู (ดึงจาก child ของ outer)
            continue
        if cv2.contourArea(c) < min_area:
            continue
        ext = _chaikin_ring(cv2.approxPolyDP(c, eps, True).reshape(-1, 2), 2)
        if len(ext) < 3:
            continue
        holes = []
        ch = hier[i][2]
        while ch != -1:
            hc = cnts[ch]
            if cv2.contourArea(hc) >= min_area:
                hr = _chaikin_ring(cv2.approxPolyDP(hc, eps, True).reshape(-1, 2), 2)
                if len(hr) >= 3:
                    holes.append([(float(x), float(y)) for x, y in hr])
            ch = hier[ch][0]
        try:
            poly = Polygon([(float(x), float(y)) for x, y in ext], holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly and not poly.is_empty and poly.area > 0:
                polys.append(poly)
        except Exception:
            continue
    return unary_union(polys) if polys else None


# ---------- โหมด photo : VTracer (สำหรับภาพถ่าย/ไล่เฉด) ----------
def trace_photo(image_path, n_colors=6, filter_speckle=8):
    """VTracer color -> [(bgr, geom)] เหมาะกับภาพถ่าย/ภาพไล่เฉด"""
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
        corner_threshold=80, path_precision=8,
    )
    paths, attrs = svg2paths(tmp)
    try:
        os.remove(tmp)
    except Exception:
        pass
    items = []
    for p, a in zip(paths, attrs):
        r, g, b = _hex2rgb(a.get('fill', '#000000'))
        bgr = (b, g, r)
        if _close_color(bgr, bg):
            continue
        tx, ty = _translate(a.get('transform', ''))
        polys = []
        for sub in p.continuous_subpaths():
            L = sub.length()
            if L < 3:
                continue
            N = int(max(10, min(2400, L / 2.5)))
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
            geom = geom.symmetric_difference(q)
        if geom and not geom.is_empty:
            items.append((bgr, geom))
    return _cluster_colors(items, n_colors) if items else []


def _cluster_colors(items, k):
    cols = np.array([it[0] for it in items], np.float32)
    k = int(max(1, min(k, len(items))))
    if k >= len(items):
        labels = list(range(len(items))); centers = cols
    else:
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, lab, centers = cv2.kmeans(cols, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
        labels = lab.flatten().tolist()
    out = []
    for gi in range(k):
        geoms = [items[i][1] for i in range(len(items)) if labels[i] == gi]
        if not geoms:
            continue
        c = centers[gi]
        out.append(((int(c[0]), int(c[1]), int(c[2])), unary_union(geoms)))
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
