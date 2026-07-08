"""เครื่องยนต์ลากเส้นคุณภาพสูง (v0.3)
- โหมด cutout: VTracer แปลงภาพสี -> เวกเตอร์เนียน (spline) รองรับรู คัดพื้นหลัง รวมสีใกล้กัน
- โหมด lineart: skeletonize ลากแกนกลางเส้น (แก้ปัญหาตัวอักษรเส้นขอบถูกกัดหาย)
VTracer/svgpathtools/skimage = import แบบ lazy (โหลดเฉพาะตอนใช้ -> สตาร์ทเร็ว)
"""
import re
import math
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


def prep_image(image_path, min_dim=1800, max_dim=3400):
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
        geom = _mask_to_geom_smooth(mask, eps, min_area)
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


# ---------- Potrace : fit เส้นโค้ง Bézier จริง -> ขอบเนียนกริบ ไม่มียึกยัก ----------
def _cubic_pt(p0, c1, c2, e, t):
    mt = 1.0 - t
    a = mt * mt * mt; b = 3 * mt * mt * t; c = 3 * mt * t * t; d = t * t * t
    return (a * p0[0] + b * c1[0] + c * c2[0] + d * e[0],
            a * p0[1] + b * c1[1] + c * c2[1] + d * e[1])


def _sample_potrace_curve(curve):
    """แปลง 1 curve ของ potrace (Bézier/มุม) -> ring จุดหนาแน่นตามความยาวโค้ง (เนียน)"""
    p0 = curve.start_point
    pts = [(p0.x, p0.y)]
    cur = (p0.x, p0.y)
    for seg in curve:
        e = (seg.end_point.x, seg.end_point.y)
        if seg.is_corner:
            c = (seg.c.x, seg.c.y)
            pts.append(c); pts.append(e)
        else:
            c1 = (seg.c1.x, seg.c1.y); c2 = (seg.c2.x, seg.c2.y)
            poly = (abs(c1[0] - cur[0]) + abs(c1[1] - cur[1]) +
                    abs(c2[0] - c1[0]) + abs(c2[1] - c1[1]) +
                    abs(e[0] - c2[0]) + abs(e[1] - c2[1]))
            N = int(min(6000, max(8, poly / 0.4)))   # sample ถี่มาก (chord 0.4px -> เนียนเป๊ะ)
            for i in range(1, N + 1):
                pts.append(_cubic_pt(cur, c1, c2, e, i / float(N)))
        cur = e
    return pts


# ---------- Shape regularization: มุมจริง + fit เส้นตรง (แทนมือคน) ----------
def _detect_corners(P, win=7, ang_deg=30.0):
    """คืน index ของ 'มุมจริง' (ทิศเปลี่ยนเกิน ang_deg และเป็น local max)"""
    n = len(P)
    ang = np.zeros(n)
    for i in range(n):
        a = P[(i - win) % n]; b = P[i]; c = P[(i + win) % n]
        v1 = b - a; v2 = c - b
        n1 = float(np.hypot(v1[0], v1[1])); n2 = float(np.hypot(v2[0], v2[1]))
        if n1 < 1e-6 or n2 < 1e-6:
            continue
        cs = max(-1.0, min(1.0, float(np.dot(v1, v2)) / (n1 * n2)))
        ang[i] = np.degrees(np.arccos(cs))
    half = max(1, win // 2)
    cor = []
    for i in range(n):
        if ang[i] > ang_deg and ang[i] >= max(ang[(i + j) % n] for j in range(-half, half + 1)):
            cor.append(i)
    return sorted(set(cor))


def _smooth_open(seg, smooth_px=0.35):
    """fit smoothing B-spline บนช่วงโค้ง (เปิด) -> เฉลี่ย noise เป็นเส้นโค้งลื่น
    clamp ปลายทั้งสองให้ต่อเนื่องกับ segment ข้างเคียง"""
    if len(seg) < 7:
        return [(float(p[0]), float(p[1])) for p in seg[:-1]]
    try:
        from scipy.interpolate import splprep, splev
        tck, u = splprep([seg[:, 0], seg[:, 1]], s=len(seg) * (smooth_px ** 2), k=3)
        arclen = float(np.hypot(*(seg[1:] - seg[:-1]).T).sum())
        M = int(min(4000, max(12, arclen / 0.35)))    # chord ~0.3 มม. -> เนียนระดับตัด
        uu = np.linspace(0, 1, M)
        xs, ys = splev(uu, tck)
        xs[0], ys[0] = seg[0]; xs[-1], ys[-1] = seg[-1]
        return [(float(a), float(b)) for a, b in zip(xs[:-1], ys[:-1])]
    except Exception:
        return [(float(p[0]), float(p[1])) for p in seg[:-1]]


def _smooth_closed(P, smooth_px=0.35):
    """smoothing B-spline แบบวงปิด (สำหรับวงที่ไม่มีมุม เช่น o / จุด i)"""
    n = len(P)
    if n < 10:
        r = [(float(p[0]), float(p[1])) for p in P]; r.append(r[0]); return r
    try:
        from scipy.interpolate import splprep, splev
        tck, u = splprep([P[:, 0], P[:, 1]], s=n * (smooth_px ** 2), k=3, per=True)
        Pc = np.vstack([P, P[0]])
        arclen = float(np.hypot(*(Pc[1:] - Pc[:-1]).T).sum())
        M = int(min(6000, max(24, arclen / 0.35)))
        uu = np.linspace(0, 1, M)
        xs, ys = splev(uu, tck)
        r = [(float(a), float(b)) for a, b in zip(xs, ys)]; r.append(r[0]); return r
    except Exception:
        r = [(float(p[0]), float(p[1])) for p in P]; r.append(r[0]); return r


def _fit_ellipse_ring(P, tol_frac=0.005, tol_abs=1.0):
    """ถ้า ring ทั้งวงเป็นวงรี/วงกลม -> แทนด้วยวงรีคณิตเป๊ะ (คืน None ถ้าไม่ใช่)"""
    if len(P) < 12:
        return None
    pts = np.asarray(P, np.float32)
    try:
        (cx, cy), (MA, ma), angle = cv2.fitEllipse(pts)
    except Exception:
        return None
    a = MA / 2.0; b = ma / 2.0
    if a <= 1 or b <= 1 or max(a, b) / min(a, b) > 6:
        return None
    th = np.radians(angle); ct = np.cos(th); st = np.sin(th)
    dx = pts[:, 0] - cx; dy = pts[:, 1] - cy
    xe = dx * ct + dy * st; ye = -dx * st + dy * ct
    dev = np.abs(np.sqrt((xe / a) ** 2 + (ye / b) ** 2) - 1.0) * min(a, b)
    if float(dev.max()) > max(tol_abs, tol_frac * max(a, b)):
        return None
    ang_pt = np.arctan2(ye / b, xe / a)          # ต้องครอบเกือบ 360° จึงจะเป็นวงรีจริง
    if float(ang_pt.max() - ang_pt.min()) < np.radians(300):
        return None
    per = np.pi * (3 * (a + b) - np.sqrt((3 * a + b) * (a + 3 * b)))
    N = int(min(4000, max(60, per / 0.5)))
    t = np.linspace(0, 2 * np.pi, N)
    X = cx + a * np.cos(t) * ct - b * np.sin(t) * st
    Y = cy + a * np.cos(t) * st + b * np.sin(t) * ct
    out = [(float(x), float(y)) for x, y in zip(X, Y)]
    out.append(out[0])
    return out


def _fit_circle_seg(seg, tol_abs=0.6, tol_frac=0.004):
    """ถ้า segment เป็นอาร์ควงกลม -> คืนจุดอาร์คเป๊ะ (คืน None ถ้าไม่ใช่)"""
    if len(seg) < 6:
        return None
    x = seg[:, 0]; y = seg[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(x))]; bb = x * x + y * y
    try:
        sol, _, _, _ = np.linalg.lstsq(A, bb, rcond=None)
    except Exception:
        return None
    cx, cy, cc = sol; R2 = cc + cx * cx + cy * cy
    if R2 <= 1:
        return None
    R = np.sqrt(R2)
    d = np.abs(np.hypot(x - cx, y - cy) - R)
    L = float(np.hypot(x[-1] - x[0], y[-1] - y[0]))
    if float(d.max()) > max(tol_abs, tol_frac * L):
        return None
    a0 = np.arctan2(y[0] - cy, x[0] - cx)
    a1 = np.arctan2(y[-1] - cy, x[-1] - cx)
    am = np.arctan2(y[len(y) // 2] - cy, x[len(x) // 2] - cx)

    def _uw(ang, ref):
        while ang - ref > np.pi: ang -= 2 * np.pi
        while ang - ref < -np.pi: ang += 2 * np.pi
        return ang
    a1u = _uw(a1, a0); amu = _uw(am, a0)
    if not (min(a0, a1u) <= amu <= max(a0, a1u)):
        a1u = a1u - 2 * np.pi if a1u > a0 else a1u + 2 * np.pi
    arclen = abs(a1u - a0) * R
    N = int(min(3000, max(8, arclen / 0.5)))
    t = np.linspace(a0, a1u, N)
    return [(float(cx + R * np.cos(tt)), float(cy + R * np.sin(tt))) for tt in t]


def _regularize_ring(ring, line_abs=0.6, line_frac=0.004, min_len=12.0):
    """ช่วงระหว่างมุมที่ 'ตรงจริง' -> แทนด้วยเส้นตรงเป๊ะ (least-squares/ระยะตั้งฉาก),
    ช่วงโค้ง -> คงจุดเดิม (เนียนจาก potrace). ลบอาการส่ายของเส้นตรงจากขอบ raster"""
    P = np.asarray(ring, dtype=float)
    if len(P) > 1 and np.hypot(P[0][0] - P[-1][0], P[0][1] - P[-1][1]) < 1e-6:
        P = P[:-1]
    n = len(P)
    if n < 14:
        return ring
    cor = _detect_corners(P)
    if len(cor) < 2:
        e = _fit_ellipse_ring(P)        # ทั้งวงโค้ง -> ลอง fit วงรีเป๊ะก่อน
        if e is not None:
            return e
        return _smooth_closed(P)        # ไม่ใช่วงรี -> spline ปิด
    out = []
    m = len(cor)
    for k in range(m):
        a = cor[k]; b = cor[(k + 1) % m]
        seg = P[a:b + 1] if b > a else np.vstack([P[a:], P[:b + 1]])
        if len(seg) < 3:
            out.append((float(P[a][0]), float(P[a][1]))); continue
        v = seg[-1] - seg[0]; L = float(np.hypot(v[0], v[1]))
        straight = False
        if L > min_len:
            dist = np.abs(v[0] * (seg[:, 1] - seg[0][1]) - v[1] * (seg[:, 0] - seg[0][0])) / L
            if float(dist.max()) < max(line_abs, line_frac * L):
                straight = True
        if straight:
            out.append((float(seg[0][0]), float(seg[0][1])))   # ตรง -> เส้นตรงเป๊ะ
        else:
            out.extend(_smooth_open(seg))                       # โค้ง -> smoothing spline (ปลอดภัย ไม่เพี้ยน)
    if len(out) < 3:
        return ring
    out.append(out[0])
    return out


def _potrace_nest(rings, min_area):
    """สร้าง shapely (มีรูซ้อนถูกชั้น) จาก ring หลายวง ด้วย parent-containment"""
    items = []
    for r in rings:
        if len(r) < 3:
            continue
        try:
            fp = Polygon(r).buffer(0)
        except Exception:
            continue
        if fp.is_empty or fp.area < min_area:
            continue
        items.append({'ring': r, 'filled': Polygon(r).buffer(0),
                      'area': fp.area, 'rep': fp.representative_point()})
    if not items:
        return None
    items.sort(key=lambda d: d['area'])           # เล็ก -> ใหญ่
    n = len(items)
    for i in range(n):
        items[i]['parent'] = None
        for j in range(i + 1, n):                 # หา parent = วงเล็กสุดที่ครอบ
            if items[j]['filled'].contains(items[i]['rep']):
                items[i]['parent'] = j
                break
    for k in sorted(range(n), key=lambda k: -items[k]['area']):   # ใหญ่ -> เล็ก
        par = items[k]['parent']
        items[k]['solid'] = (par is None) or (not items[par]['solid'])
    polys = []
    for k in range(n):
        if not items[k]['solid']:
            continue
        holes = [items[c]['ring'] for c in range(n)
                 if items[c]['parent'] == k and not items[c]['solid']]
        try:
            poly = Polygon(items[k]['ring'], holes).buffer(0)
            if not poly.is_empty:
                polys.append(poly)
        except Exception:
            continue
    return unary_union(polys) if polys else None


def _resample_uniform(pts, step=1.0):
    """แซมป์ใหม่ให้ระยะห่างเท่ากัน ~step px (ก่อน low-pass ตามเส้น)"""
    P = np.asarray(pts, float)
    if len(P) < 4:
        return P
    seg = np.hypot(*(P[1:] - P[:-1]).T)
    d = np.concatenate([[0.0], np.cumsum(seg)])
    if d[-1] < 2 * step:
        return P
    n = max(12, int(d[-1] / step))
    u = np.linspace(0, d[-1], n, endpoint=False)
    x = np.interp(u, d, P[:, 0]); y = np.interp(u, d, P[:, 1])
    return np.stack([x, y], 1)


def _smooth_ring(pts, sigma_px=3.0):
    """Gaussian low-pass ตามแนวเส้นปิด — ลบ ripple/JPEG noise โดยไม่ดึงรูปเพี้ยน"""
    try:
        from scipy.ndimage import gaussian_filter1d
    except Exception:
        return pts
    P = _resample_uniform(pts, 1.0)
    if len(P) < max(12, int(sigma_px * 3)):
        return pts
    x = gaussian_filter1d(P[:, 0], sigma_px, mode='wrap')
    y = gaussian_filter1d(P[:, 1], sigma_px, mode='wrap')
    return np.stack([x, y], 1)


def _mask_to_geom_potrace(mask, min_area):
    """mask (สี=nonzero) -> shapely geom ขอบ Bézier เนียน ด้วย potrace
    หมายเหตุ: potracer มองพิกเซล 0/False เป็น foreground -> ต้องกลับขั้ว (mask==0)"""
    import potrace
    m = np.asarray(mask)
    if m.dtype != np.uint8:
        m = m.astype(np.uint8)
    H, W = m.shape[:2]
    # อัปสเกลให้ด้านยาว ~3200px (ลดขนาดขั้นบันไดพิกเซลบนเส้นโค้งลาด) + เบลอลบ aliasing
    up = min(4.0, max(1.0, 4000.0 / max(H, W)))
    if up > 1.01:
        m = cv2.resize(m, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    m = cv2.bilateralFilter(m, 9, 60, 60)             # ลบ noise ขอบ (JPEG) รักษาขอบคม
    m = cv2.GaussianBlur(m, (0, 0), sigmaX=up * 0.8)  # เบลอบางๆ ลบ aliasing แต่ไม่ทำให้เพี้ยน
    _, m = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
    bw = (m == 0)                                     # potracer: 0/False = foreground
    if bw.all() or (~bw).all():
        return None
    turd = int(max(2, (min_area * up * up) ** 0.5))
    # opttolerance 2.0 + alphamax 1.3 = fit โค้ง Bézier ยาวเนียนที่สุด (ไม่มียึกยักแม้ซูม)
    path = potrace.Bitmap(bw).trace(turdsize=turd, alphamax=1.3, opttolerance=0.4)
    _sig = max(2.0, min(6.0, max(H, W) / 500.0))   # ระดับ low-pass ตามความละเอียด (ลบ ripple)
    rings = []
    for c in path:
        r = [(x / up, y / up) for x, y in _sample_potrace_curve(c)]
        r = _smooth_ring(r, _sig)                  # ลบระลอก JPEG โดยไม่เพี้ยนรูป
        rings.append([(float(a), float(b)) for a, b in r])
    return _potrace_nest(rings, min_area)


def _mask_to_geom_smooth(mask, eps, min_area):
    """ใช้ potrace (Bézier เนียนที่สุด) ถ้ามี; ถ้าไม่มี fallback เป็น approxPolyDP+Chaikin"""
    try:
        g = _mask_to_geom_potrace(mask, min_area)
        if g is not None and not g.is_empty:
            return g
    except Exception:
        pass
    return _mask_to_geom(mask, eps, min_area)


# ---------- โหมด Bézier : เก็บเส้นโค้งจาก potrace (คุณภาพ Illustrator) ----------
def _potrace_curve_to_subpath(curve, up=1.0):
    """potrace curve -> subpath {start,segs:[('L',pt)|('C',c1,c2,e)],closed} (เก็บ Bézier)"""
    p0 = curve.start_point
    start = (p0.x / up, p0.y / up)
    segs = []
    for s in curve:
        e = (s.end_point.x, s.end_point.y)
        if s.is_corner:
            c = (s.c.x, s.c.y)
            segs.append(('L', (c[0] / up, c[1] / up)))
            segs.append(('L', (e[0] / up, e[1] / up)))
        else:
            c1 = (s.c1.x, s.c1.y); c2 = (s.c2.x, s.c2.y)
            segs.append(('C', (c1[0] / up, c1[1] / up),
                         (c2[0] / up, c2[1] / up), (e[0] / up, e[1] / up)))
    return {'start': start, 'segs': segs, 'closed': True}


def _mask_to_subpaths(mask, min_area):
    """mask (สี=nonzero) -> subpaths Bézier ด้วย potrace (prep เหมือน _mask_to_geom_potrace)"""
    import potrace
    m = np.asarray(mask)
    if m.dtype != np.uint8:
        m = m.astype(np.uint8)
    H, W = m.shape[:2]
    up = min(4.0, max(1.0, 4000.0 / max(H, W)))
    if up > 1.01:
        m = cv2.resize(m, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    m = cv2.bilateralFilter(m, 9, 60, 60)
    m = cv2.GaussianBlur(m, (0, 0), sigmaX=up * 0.8)
    _, m = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
    bw = (m == 0)
    if bw.all() or (~bw).all():
        return []
    turd = int(max(2, (min_area * up * up) ** 0.5))
    path = potrace.Bitmap(bw).trace(turdsize=turd, alphamax=1.3, opttolerance=0.4)
    subs = []
    for c in path:
        sp = _potrace_curve_to_subpath(c, up)
        if len(sp['segs']) >= 2:
            subs.append(sp)
    return subs


def trace_color_bezier(image_path, n_colors=6, filter_speckle=8):
    """คืน [(bgr, [subpaths])] ต่อสี — เก็บ Bézier ของ potrace (ไม่ sample เป็น polyline)"""
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    H, W = img.shape[:2]
    sm = cv2.bilateralFilter(img, 7, 45, 45)
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
            mm = dk < bestd
            bestd = np.where(mm, dk, bestd)
            best = np.where(mm, k, best)
    labels = best.reshape(H, W)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    bg = int(np.bincount(border, minlength=K).argmax())

    min_area = max(40.0, W * H * 8e-6)
    ker = np.ones((3, 3), np.uint8)
    items = []
    for k in range(K):
        if k == bg:
            continue
        mask = (labels == k).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, ker)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, ker)
        subs = _mask_to_subpaths(mask, min_area)
        if subs:
            c = centers[k]
            items.append(((int(c[0]), int(c[1]), int(c[2])), subs))
    return items



# ---------- โหมด Bézier เนียน infinite : potrace -> smooth (ลบ ripple) -> fit Bézier แท้ ----------
def _resample_open(pts, step=1.0):
    P = np.asarray(pts, float)
    if len(P) < 3: return P
    seg = np.hypot(*(P[1:]-P[:-1]).T); d = np.concatenate([[0.0], np.cumsum(seg)])
    if d[-1] < 2*step: return P
    n = max(6, int(d[-1]/step))
    u = np.linspace(0, d[-1], n)
    return np.stack([np.interp(u,d,P[:,0]), np.interp(u,d,P[:,1])], 1)


def _smooth_open(pts, sigma):
    try:
        from scipy.ndimage import gaussian_filter1d
    except Exception:
        return np.asarray(pts, float)
    P = _resample_open(pts, 1.0)
    if len(P) < max(6, int(sigma*3)): return P
    a = P.copy()
    a[:,0] = gaussian_filter1d(P[:,0], sigma, mode="nearest")
    a[:,1] = gaussian_filter1d(P[:,1], sigma, mode="nearest")
    a[0] = P[0]; a[-1] = P[-1]
    return a


def _is_straight(P, abs_tol=0.7, frac=0.004):
    v = P[-1]-P[0]; L = float(np.hypot(v[0], v[1]))
    if L < 9: return False
    d = np.abs(v[0]*(P[:,1]-P[0,1]) - v[1]*(P[:,0]-P[0,0])) / L
    return float(d.max()) < max(abs_tol, frac*L)


def _mask_to_smooth_subpaths(mask, min_area):
    """mask -> subpaths Bézier ที่ ลบ ripple แล้ว fit เส้นโค้งคณิตศาสตร์ (Schneider) = คมกริบทุกซูม"""
    import potrace
    from . import bezier_fit
    m = np.asarray(mask)
    if m.dtype != np.uint8:
        m = m.astype(np.uint8)
    H, W = m.shape[:2]
    up = min(4.0, max(1.0, 4000.0 / max(H, W)))
    if up > 1.01:
        m = cv2.resize(m, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    m = cv2.bilateralFilter(m, 9, 60, 60)
    m = cv2.GaussianBlur(m, (0, 0), sigmaX=up * 0.8)
    _, m = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
    bw = (m == 0)
    if bw.all() or (~bw).all():
        return []
    turd = int(max(2, (min_area * up * up) ** 0.5))
    path = potrace.Bitmap(bw).trace(turdsize=turd, alphamax=1.3, opttolerance=0.4)
    sig = max(1.1, min(3.0, max(H, W) / 900.0))
    subs = []
    for c in path:
        # 1) แซมป์ทุก segment เป็นจุดถี่ (px source)
        cur = (c.start_point.x, c.start_point.y)
        pts = [(cur[0] / up, cur[1] / up)]
        for seg in c:
            e = (seg.end_point.x, seg.end_point.y)
            if seg.is_corner:
                pts.append((seg.c.x / up, seg.c.y / up)); pts.append((e[0] / up, e[1] / up))
            else:
                c1 = (seg.c1.x, seg.c1.y); c2 = (seg.c2.x, seg.c2.y)
                L = (abs(c1[0]-cur[0]) + abs(c1[1]-cur[1]) + abs(c2[0]-c1[0]) + abs(c2[1]-c1[1]) +
                     abs(e[0]-c2[0]) + abs(e[1]-c2[1]))
                N = int(min(600, max(6, L / 1.0)))
                for i in range(1, N + 1):
                    tt = i / float(N); mt = 1 - tt
                    pts.append(((mt**3*cur[0] + 3*mt*mt*tt*c1[0] + 3*mt*tt*tt*c2[0] + tt**3*e[0]) / up,
                                (mt**3*cur[1] + 3*mt*mt*tt*c1[1] + 3*mt*tt*tt*c2[1] + tt**3*e[1]) / up))
            cur = e
        # 2) smooth วง (ลบ ripple) — ทำงานบนอาเรย์เดียว
        P = _smooth_ring(pts, sig)
        P = np.asarray(P, float)
        if len(P) < 6:
            continue
        # 3) หามุมจริงจากเรขาคณิต (ไม่พึ่ง corner ของ potrace)
        win = int(max(4, sig * 3)); cor = _detect_corners(P, win=win, ang_deg=30.0)
        if len(cor) < 2:
            sp = bezier_fit.fit_ring(P, max_error=0.6)   # ทั้งวงโค้ง (o, จุด)
            if sp and len(sp['segs']) >= 2:
                subs.append(sp)
            continue
        start = (float(P[cor[0]][0]), float(P[cor[0]][1]))
        segs = []; m = len(cor)
        for k in range(m):
            a = cor[k]; b = cor[(k + 1) % m]
            span = P[a:b + 1] if b > a else np.vstack([P[a:], P[:b + 1]])
            if len(span) < 3:
                segs.append(('L', (float(P[b][0]), float(P[b][1])))); continue
            if _is_straight(span, abs_tol=1.2):
                segs.append(('L', (float(span[-1][0]), float(span[-1][1]))))   # ก้านตรง = ตรงเป๊ะ
            else:
                for cseg in bezier_fit.fit_segments(span, max_error=0.55):     # โค้ง = Bézier ทาบแน่น
                    segs.append(cseg)
        if len(segs) >= 2:
            subs.append({'start': start, 'segs': segs, 'closed': True})
    return subs


def trace_color_smooth_bezier(image_path, n_colors=6, filter_speckle=8):
    """คืน [(bgr, [subpaths Bézier เนียน])] — คุณภาพเส้นตัดระดับ .ai (โค้งคณิตศาสตร์ ไม่มี ripple)"""
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    H, W = img.shape[:2]
    sm = cv2.bilateralFilter(img, 7, 45, 45)
    K = int(max(2, min(n_colors, 10)))
    sw = 600
    small = cv2.resize(sm, (sw, max(1, int(sw * H / W))), interpolation=cv2.INTER_AREA) if W > sw else sm
    Z = small.reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
    _, _, centers = cv2.kmeans(Z, K, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    centers = centers.astype(np.float32)
    flat = sm.reshape(-1, 3).astype(np.float32)
    best = np.zeros(flat.shape[0], np.int32); bestd = None
    for k in range(K):
        dk = ((flat - centers[k]) ** 2).sum(1)
        if bestd is None: bestd = dk
        else:
            mm = dk < bestd; bestd = np.where(mm, dk, bestd); best = np.where(mm, k, best)
    labels = best.reshape(H, W)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    bg = int(np.bincount(border, minlength=K).argmax())
    min_area = max(40.0, W * H * 8e-6)
    ker = np.ones((3, 3), np.uint8)
    items = []
    for k in range(K):
        if k == bg:
            continue
        mask = (labels == k).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, ker)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, ker)
        subs = _mask_to_smooth_subpaths(mask, min_area)
        if subs:
            c = centers[k]
            items.append(((int(c[0]), int(c[1]), int(c[2])), subs))
    return items

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


# ---------- Regularize vtracer output: ตรง=ตรงเป๊ะ · โค้ง=Bézier เนียน (ลบ ripple) ----------
def _sample_subpath(sp, step=1.2):
    """subpath (vtracer) -> ชุดจุดถี่ตามเส้นจริง (px) สำหรับวิเคราะห์ความตรง/โค้ง"""
    cur = (float(sp['start'][0]), float(sp['start'][1]))
    pts = [cur]
    for s in sp['segs']:
        if s[0] == 'L':
            e = (float(s[1][0]), float(s[1][1]))
            d = float(np.hypot(e[0] - cur[0], e[1] - cur[1]))
            n = int(max(1, d / step))
            for i in range(1, n + 1):
                t = i / float(n)
                pts.append((cur[0] + (e[0] - cur[0]) * t, cur[1] + (e[1] - cur[1]) * t))
            cur = e
        else:
            c1, c2, e = s[1], s[2], s[3]
            poly = (abs(c1[0]-cur[0]) + abs(c1[1]-cur[1]) + abs(c2[0]-c1[0]) + abs(c2[1]-c1[1]) +
                    abs(e[0]-c2[0]) + abs(e[1]-c2[1]))
            n = int(min(1200, max(4, poly / step)))
            for i in range(1, n + 1):
                pts.append(_cubic_pt(cur, c1, c2, e, i / float(n)))
            cur = (float(e[0]), float(e[1]))
    return pts


def _seg_is_straight_cubic(p0, c1, c2, e, tol=0.9):
    """cubic นี้ 'เกือบตรง' ไหม — control point เกาะคอร์ด (start->end) ในระยะ tol px
    และไม่ยื่นเกินปลาย (กัน S-curve/overshoot). ถ้าใช่ -> แทนด้วยเส้นตรงได้เป๊ะ"""
    ax, ay = float(p0[0]), float(p0[1]); bx, by = float(e[0]), float(e[1])
    vx, vy = bx - ax, by - ay
    L = (vx*vx + vy*vy) ** 0.5
    if L < 1e-6:
        return False
    nx, ny = -vy / L, vx / L            # normal
    for c in (c1, c2):
        cx, cy = float(c[0]) - ax, float(c[1]) - ay
        if abs(cx*nx + cy*ny) > tol:    # ระยะตั้งฉากจากคอร์ด
            return False
        t = (cx*vx + cy*vy) / (L*L)     # ตำแหน่งตามแนวคอร์ด
        if t < -0.25 or t > 1.25:
            return False
    return True


def _merge_collinear(start, segs, tol=0.6):
    """รวมเส้นตรงต่อเนื่องที่อยู่แนวเดียวกันเป็นเส้นเดียว (DXF สะอาด ไม่มีจุดหักปลอม)"""
    out = []
    cur = start
    for s in segs:
        if s[0] == 'L' and out and out[-1][0] == 'L':
            a = cur_pts[-2]; b = out[-1][1]; c = s[1]
            vx, vy = b[0]-a[0], b[1]-a[1]; L = (vx*vx+vy*vy)**0.5
            if L > 1e-6:
                nx, ny = -vy/L, vx/L
                if abs((c[0]-a[0])*nx + (c[1]-a[1])*ny) <= tol:   # c อยู่แนวเดียว a->b
                    out[-1] = ('L', s[1]); cur_pts[-1] = s[1]; continue
        out.append(s)
        cur_pts.append(s[-1])
    return out


def _snap_axis(start, segs, ang_deg=3.5, max_dev=8.0, closed=True):
    """ดัดเส้นตรงที่ 'เกือบ' แนวนอน/แนวตั้ง ให้ตรงเป๊ะตามแกน (ลบอาการยึกยัก/บิดเบี้ยว)
    - snap เฉพาะ segment 'L' ที่ทำมุมกับแกน <= ang_deg องศา และเบี่ยง <= max_dev px
    - เส้นทแยงจริง (เช่น ขา A/V/W) มุมมาก -> ไม่แตะ
    - segment ปิดรูป (กลับมาที่จุดเริ่ม) -> ไม่แตะ เพื่อคงการปิดรูป"""
    if not segs:
        return segs
    thr = math.tan(math.radians(ang_deg))
    ax, ay = float(start[0]), float(start[1])
    sx, sy = ax, ay
    out = []
    for s in segs:
        if s[0] == 'L':
            ex, ey = float(s[1][0]), float(s[1][1])
            is_close = closed and abs(ex - ax) < 1.0 and abs(ey - ay) < 1.0
            if not is_close:
                dx, dy = ex - sx, ey - sy
                adx, ady = abs(dx), abs(dy)
                if adx > 1e-6 or ady > 1e-6:
                    if ady <= max_dev and ady <= adx * thr:      # เกือบแนวนอน -> ปรับ y ให้ตรง
                        ey = sy
                    elif adx <= max_dev and adx <= ady * thr:    # เกือบแนวตั้ง -> ปรับ x ให้ตรง
                        ex = sx
            out.append(('L', (ex, ey)))
            sx, sy = ex, ey
        else:
            out.append(s)
            sx, sy = float(s[3][0]), float(s[3][1])
    return out


def _regularize_subpath(sp, tol=0.9, **_):
    """ทำให้ 'ตรง=ตรงเป๊ะ' โดยไม่แตะเส้นโค้งของ vtracer (คงความแนบต้นฉบับ ไม่มีโก่ง):
    - segment โค้งที่ 'เกือบตรง' -> แทนด้วย LINE เป๊ะ
    - segment โค้งจริง -> เก็บ cubic เดิมของ vtracer ทั้งดุ้น (ไม่ resample/smooth/refit)
    - เส้นตรงที่เกือบแนวนอน/แนวตั้ง -> snap ให้ตรงตามแกนเป๊ะ (ลบยึกยัก)"""
    segs_in = sp.get('segs') or []
    if not segs_in:
        return sp
    prev = sp['start']
    raw = []
    for s in segs_in:
        if s[0] == 'C':
            if _seg_is_straight_cubic(prev, s[1], s[2], s[3], tol):
                raw.append(('L', s[3]))
            else:
                raw.append(s)
            prev = s[3]
        else:
            raw.append(s); prev = s[1]
    closed = sp.get('closed', True)
    # รวมเส้นตรงแนวเดียวกัน
    global cur_pts
    cur_pts = [sp['start']]
    merged = _merge_collinear(sp['start'], raw, tol=max(0.5, tol*0.7))
    # snap แนวนอน/แนวตั้ง แล้วรวมเส้นแนวเดียวกันซ้ำ (fuse ที่เพิ่งตรงกัน)
    snapped = _snap_axis(sp['start'], merged, closed=closed)
    cur_pts = [sp['start']]
    snapped = _merge_collinear(sp['start'], snapped, tol=max(0.5, tol*0.7))
    return {'start': sp['start'], 'segs': snapped, 'closed': closed}
def trace_vtracer(image_path, n_colors=6, corner_threshold=58, filter_speckle=2,
                  length_threshold=2.5, splice_threshold=45, path_precision=6,
                  regularize=True):
    """คืน [(bgr, [subpaths])] — ใช้ vtracer (VisionCortex) คุณภาพเส้นตัดระดับมืออาชีพ
    เส้นตรง = ตรงจริง · โค้ง = spline เนียน · มุม = คม · ขนาดพิกัด = px ต้นฉบับ"""
    import tempfile, re
    import vtracer
    from svgpathtools import parse_path
    from . import analyze
    # อ่าน + วางบนพื้นขาวทึบ (กัน alpha ทำ threshold เพี้ยน)
    img = analyze.load_image(image_path)
    if img is None:
        import cv2 as _cv; img = _cv.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    import cv2 as _cv
    # ---- เตรียมภาพ: binarize ครอบคลุม เก็บเส้นบาง/จาง + เชื่อมรอยขาดจาก JPEG ----
    g = img
    if g.ndim == 3:
        g = _cv.cvtColor(g, _cv.COLOR_BGR2GRAY)
    # supersample: อัปสเกลภาพเล็ก/กลางให้ด้านยาว ~2600px ก่อน trace
    # -> ขอบ diagonal/โค้ง เนียนตรงขึ้น (ลด stair-step ของ JPEG) + เส้นบางไม่หลุด
    _long = max(g.shape[:2])
    if _long < 2600:
        _sc = 2600.0 / float(_long)
        g = _cv.resize(g, None, fx=_sc, fy=_sc, interpolation=_cv.INTER_CUBIC)
    g = _cv.bilateralFilter(g, 7, 45, 45)
    # พื้นหลัง = สว่างเด่นที่ขอบ -> ตั้ง threshold ให้จับเส้นที่เข้มกว่าพื้นเล็กน้อย (เก็บเส้นจาง)
    border = np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])
    bg = float(np.median(border))
    if bg >= 128:                       # พื้นสว่าง วัตถุเข้ม
        thr = max(40.0, bg - 45.0); mask = (g < thr).astype(np.uint8) * 255
    else:                               # พื้นเข้ม วัตถุสว่าง
        thr = min(215.0, bg + 45.0); mask = (g > thr).astype(np.uint8) * 255
    k = _cv.getStructuringElement(_cv.MORPH_ELLIPSE, (5, 5))
    mask = _cv.morphologyEx(mask, _cv.MORPH_CLOSE, k)   # เชื่อมรอยขาด/ปิดปลายเส้นเรียว
    mask = _cv.morphologyEx(mask, _cv.MORPH_CLOSE, _cv.getStructuringElement(_cv.MORPH_ELLIPSE, (3, 3)))
    canvas = np.full(mask.shape, 255, np.uint8); canvas[mask > 0] = 0   # ดำบนขาว
    tf = tempfile.mktemp(suffix='.png'); _cv.imwrite(tf, canvas)
    outsvg = tempfile.mktemp(suffix='.svg')
    vtracer.convert_image_to_svg_py(
        tf, outsvg, colormode='binary', mode='spline', hierarchical='stacked',
        filter_speckle=int(filter_speckle), corner_threshold=int(corner_threshold),
        length_threshold=float(length_threshold), splice_threshold=int(splice_threshold),
        path_precision=int(path_precision))
    svg = open(outsvg, encoding='utf-8').read()
    subs = []
    for pm in re.finditer(r'<path\b([^>]*?)/>', svg, re.S):
        tag = pm.group(1)
        dm = re.search(r'd="([^"]+)"', tag)
        if not dm:
            continue
        tx = ty = 0.0; sx = sy = 1.0
        tt = re.search(r'translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)', tag)
        if tt:
            tx = float(tt.group(1)); ty = float(tt.group(2))
        sc = re.search(r'scale\(\s*([-\d.eE]+)(?:[ ,]+([-\d.eE]+))?', tag)
        if sc:
            sx = float(sc.group(1)); sy = float(sc.group(2)) if sc.group(2) else sx
        def X(pt, sx=sx, sy=sy, tx=tx, ty=ty):
            return (pt.real * sx + tx, pt.imag * sy + ty)
        try:
            path = parse_path(dm.group(1))
        except Exception:
            continue
        for sub in path.continuous_subpaths():
            if len(sub) < 1:
                continue
            segs = []
            st = X(sub[0].start)
            for seg in sub:
                cn = type(seg).__name__
                if cn == 'Line':
                    segs.append(('L', X(seg.end)))
                elif cn == 'CubicBezier':
                    segs.append(('C', X(seg.control1), X(seg.control2), X(seg.end)))
                elif cn == 'QuadraticBezier':
                    c1 = seg.start + (2.0 / 3.0) * (seg.control - seg.start)
                    c2 = seg.end + (2.0 / 3.0) * (seg.control - seg.end)
                    segs.append(('C', X(c1), X(c2), X(seg.end)))
                elif cn == 'Arc':
                    for t in (0.25, 0.5, 0.75, 1.0):
                        segs.append(('L', X(seg.point(t))))
            if segs:
                subs.append({'start': st, 'segs': segs, 'closed': True})
    if not subs:
        raise ValueError('vtracer ไม่พบรูปทรง')
    if regularize:
        tol = max(0.6, min(1.4, max(canvas.shape) / 1200.0))   # เกณฑ์ 'เกือบตรง' ตามความละเอียด
        reg = []
        for sp in subs:
            try:
                reg.append(_regularize_subpath(sp, tol=tol))
            except Exception:
                reg.append(sp)                                 # กันพลาด: คงเส้นเดิมไว้ ไม่ให้หาย
        subs = [s for s in reg if s and s.get('segs')]
        if not subs:
            subs = reg
    return [((0, 0, 0), subs)]


def nest_shapes_mm(image_path, real_width_mm=300.0, n_colors=6, max_dim=900):
    """ดึง 'รูปทรง footprint' จากภาพ raster แบบเร็ว (สำหรับ Nesting) — ย่อภาพ + threshold +
    findContours + approxPolyDP -> shapely polygons (มม.). เร็วกว่า trace_color ~10 เท่า"""
    from shapely.geometry import Polygon
    try:
        from . import analyze
        img = analyze.load_image(image_path)
    except Exception:
        img = cv2.imread(image_path)
    if img is None:
        return []
    H, W = img.shape[:2]
    if max(H, W) > max_dim:
        sc = max_dim / float(max(H, W))
        img = cv2.resize(img, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]
    ppm = w / float(real_width_mm) if real_width_mm else 1.0   # px ต่อ มม. (ภาพย่อ)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    gray = cv2.medianBlur(gray, 3)
    border = np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
    bg = float(np.median(border))
    if bg >= 128:
        m = (gray < bg - 40).astype(np.uint8) * 255
    else:
        m = (gray > bg + 40).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = w * h * 3e-4
    eps = max(1.0, w / 400.0)
    polys = []
    for cnt in cnts:
        if cv2.contourArea(cnt) < min_area:
            continue
        ap = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2)
        if len(ap) < 3:
            continue
        try:
            pg = Polygon([(float(x) / ppm, float(y) / ppm) for x, y in ap]).buffer(0)
            if not pg.is_empty and pg.area > 4.0:
                polys.append(pg if pg.geom_type == 'Polygon' else max(pg.geoms, key=lambda z: z.area))
        except Exception:
            pass
    polys.sort(key=lambda p: -p.area)
    return polys[:60]


def bezier_pieces_mm(image_path, real_width_mm=300.0, n_colors=6, max_pieces=60):
    """สร้าง 'ชิ้นสำหรับ Nesting' จากภาพ raster ด้วยเครื่องยนต์ vtracer (เส้นโค้ง Bézier + เส้นตรง snap)
    -> คืน list ของ {poly, subs, color, rgb, layer} หน่วยมม. (Y ชี้ลง) รูปแบบเดียวกับ vector_import
    ทำให้ Nesting ของภาพ raster 'เนียนกริบ' เท่ากับเครื่องยนต์ตัด (เขียน DXF เป็น SPLINE จริง)
    - จับคู่รู (holes) เข้ากับชิ้นแม่อัตโนมัติ (ตัว O/P/R/A ฯลฯ)"""
    from shapely.geometry import Polygon
    layers = trace_vtracer(image_path, n_colors=n_colors)
    subs = []
    for _rgb, sps in (layers or []):
        subs.extend(sps or [])
    if not subs:
        return []
    # bbox รวม (px) จากจุด sample
    xs = []; ys = []
    sampled = []
    for sp in subs:
        pts = _sample_subpath(sp, step=2.0)
        sampled.append(pts)
        for x, y in pts:
            xs.append(x); ys.append(y)
    if not xs:
        return []
    mnx, mny, mxx = min(xs), min(ys), max(xs)
    Wpx = (mxx - mnx) or 1.0
    ppm = Wpx / float(real_width_mm or 1.0) or 1.0

    def S(p):
        return ((p[0] - mnx) / ppm, (p[1] - mny) / ppm)

    def scale_sub(sp):
        segs = [('L', S(s[1])) if s[0] == 'L' else ('C', S(s[1]), S(s[2]), S(s[3])) for s in sp['segs']]
        return {'start': S(sp['start']), 'segs': segs, 'closed': sp.get('closed', True)}

    msubs = [scale_sub(sp) for sp in subs]
    # polygon footprint ต่อ subpath (sample ละเอียดตามโค้ง) สำหรับเช็ค 'รู' + nest
    polys = []
    for sp in msubs:
        pts = _sample_subpath(sp, step=0.8)
        try:
            pg = Polygon(pts).buffer(0)
            polys.append(pg if (pg and not pg.is_empty) else None)
        except Exception:
            polys.append(None)
    order = [i for i, p in enumerate(polys) if p is not None and p.area > 1.0]
    order.sort(key=lambda i: -polys[i].area)     # ใหญ่ก่อน = ชิ้นแม่ก่อนรู
    used = set(); pieces = []
    for i in order:
        if i in used:
            continue
        outer = polys[i]; hole_subs = []; hole_rings = []
        for j in order:
            if j == i or j in used:
                continue
            try:
                if outer.contains(polys[j].representative_point()):
                    used.add(j); hole_subs.append(msubs[j]); hole_rings.append(polys[j])
            except Exception:
                pass
        used.add(i)
        try:
            piece_poly = Polygon(list(outer.exterior.coords),
                                 [list(h.exterior.coords) for h in hole_rings]).buffer(0)
            if piece_poly.is_empty:
                piece_poly = outer
        except Exception:
            piece_poly = outer
        pieces.append({'poly': piece_poly, 'subs': [msubs[i]] + hole_subs,
                       'color': '#2563EB', 'rgb': (37, 99, 235), 'layer': 'CUT'})
        if len(pieces) >= max_pieces:
            break
    return pieces
