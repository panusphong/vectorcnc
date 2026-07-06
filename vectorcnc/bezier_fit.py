"""bezier_fit.py — Fit cubic Bézier ทับชุดจุด (Schneider's algorithm)
ใช้อัลกอริทึมเดียวกับ Illustrator/potrace — ได้เส้นโค้งเนียนระดับ infinite (โค้งคณิตศาสตร์แท้)
คู่กับ Gaussian low-pass (ลบ ripple) -> เส้นตัดคมกริบ ไม่มีหยัก ทุกระดับซูม
"""
import numpy as np


def _q(bez, t):
    mt = 1 - t
    return (mt**3 * bez[0] + 3 * mt*mt*t * bez[1] + 3 * mt*t*t * bez[2] + t**3 * bez[3])


def _qprime(bez, t):
    mt = 1 - t
    return (3 * mt*mt * (bez[1]-bez[0]) + 6 * mt*t * (bez[2]-bez[1]) + 3 * t*t * (bez[3]-bez[2]))


def _qprimeprime(bez, t):
    return (6 * (1-t) * (bez[2]-2*bez[1]+bez[0]) + 6 * t * (bez[3]-2*bez[2]+bez[1]))


def _normalize(v):
    n = np.hypot(v[0], v[1])
    return v / n if n > 1e-12 else v


def _chord_param(pts):
    u = [0.0]
    for i in range(1, len(pts)):
        u.append(u[-1] + np.hypot(*(pts[i]-pts[i-1])))
    u = np.array(u)
    return u / u[-1] if u[-1] > 0 else u


def _bezier_pts(pts, u, lt, rt):
    """least-squares หา control point (Schneider) ให้ทาบจุด"""
    A = np.zeros((len(pts), 2, 2))
    for i, t in enumerate(u):
        A[i, 0] = lt * (3 * (1-t)**2 * t)
        A[i, 1] = rt * (3 * (1-t) * t**2)
    C = np.zeros((2, 2)); X = np.zeros(2)
    p0, p3 = pts[0], pts[-1]
    for i, t in enumerate(u):
        a0, a1 = A[i, 0], A[i, 1]
        C[0, 0] += a0.dot(a0); C[0, 1] += a0.dot(a1)
        C[1, 0] += a0.dot(a1); C[1, 1] += a1.dot(a1)
        tmp = pts[i] - _q([p0, p0, p3, p3], t)
        X[0] += a0.dot(tmp); X[1] += a1.dot(tmp)
    det = C[0, 0]*C[1, 1] - C[0, 1]*C[1, 0]
    if abs(det) < 1e-12:
        seg = np.hypot(*(p3-p0)) / 3.0
        return [p0, p0 + lt*seg, p3 + rt*seg, p3]
    a = (X[0]*C[1, 1] - X[1]*C[0, 1]) / det
    b = (C[0, 0]*X[1] - C[1, 0]*X[0]) / det
    seg = np.hypot(*(p3-p0))
    if a < seg*1e-2 or b < seg*1e-2:      # ค่าติดลบ/เล็กไป -> fallback heuristic
        d = seg / 3.0
        return [p0, p0 + lt*d, p3 + rt*d, p3]
    return [p0, p0 + lt*a, p3 + rt*b, p3]


def _max_err(pts, bez, u):
    mx = 0.0; idx = len(pts)//2
    for i, t in enumerate(u):
        d = _q(bez, t) - pts[i]
        e = d[0]*d[0] + d[1]*d[1]
        if e > mx:
            mx = e; idx = i
    return mx, idx


def _reparam(pts, u, bez):
    out = []
    for i, t in enumerate(u):
        d = _q(bez, t) - pts[i]
        d1 = _qprime(bez, t); d2 = _qprimeprime(bez, t)
        num = d[0]*d1[0] + d[1]*d1[1]
        den = d1[0]*d1[0] + d1[1]*d1[1] + d[0]*d2[0] + d[1]*d2[1]
        out.append(t if abs(den) < 1e-12 else t - num/den)
    return np.array(out)


def _fit(pts, lt, rt, err, depth=0):
    if len(pts) < 2:
        return []
    if len(pts) == 2:
        d = np.hypot(*(pts[1]-pts[0])) / 3.0
        return [[pts[0], pts[0] + lt*d, pts[1] + rt*d, pts[1]]]
    u = _chord_param(pts)
    bez = _bezier_pts(pts, u, lt, rt)
    mx, split = _max_err(pts, bez, u)
    if mx < err:
        return [bez]
    if mx < err * 4 and depth < 18:
        for _ in range(6):
            u = _reparam(pts, u, bez)
            bez = _bezier_pts(pts, u, lt, rt)
            mx, split = _max_err(pts, bez, u)
            if mx < err:
                return [bez]
    if split <= 0 or split >= len(pts)-1 or depth > 22:
        d = np.hypot(*(pts[-1]-pts[0])) / 3.0
        return [[pts[0], pts[0] + lt*d, pts[-1] + rt*d, pts[-1]]]
    ct = _normalize(pts[split-1] - pts[split+1])
    left = _fit(pts[:split+1], lt, ct, err, depth+1)
    right = _fit(pts[split:], -ct, rt, err, depth+1)
    return left + right


def fit_ring(points, max_error=0.8):
    """จุดวงปิด -> subpath {start, segs:[('C',c1,c2,e)], closed}
    max_error หน่วยเดียวกับ points (px). เล็ก=ทาบแน่น, ~0.8px = เนียนคมพอดี"""
    P = np.asarray(points, float)
    if len(P) > 1 and np.hypot(*(P[0]-P[-1])) < 1e-6:
        P = P[:-1]
    n = len(P)
    if n < 4:
        return None
    Pc = np.vstack([P, P[0]])                 # ปิดวง
    lt = _normalize(Pc[1] - Pc[0])
    rt = _normalize(Pc[-2] - Pc[-1])
    beziers = _fit(Pc, lt, rt, float(max_error) ** 2)
    if not beziers:
        return None
    segs = []
    for b in beziers:
        segs.append(('C', (float(b[1][0]), float(b[1][1])),
                     (float(b[2][0]), float(b[2][1])),
                     (float(b[3][0]), float(b[3][1]))))
    start = (float(beziers[0][0][0]), float(beziers[0][0][1]))
    return {'start': start, 'segs': segs, 'closed': True}
