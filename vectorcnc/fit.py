"""ฟิตเส้นระดับโปร: Schneider least-squares Bezier (Graphics Gems) + แยกมุม + เส้นตรง
ให้เส้นโค้งคลาดเคลื่อนน้อยสุดทางคณิตศาสตร์ + มุมคม + เส้นตรงตรงจริง
ใช้กับ sub-pixel contour (marching squares) -> คม+เนียนสุดแบบไม่ต้องมีโมเดล
"""
import numpy as np
import cv2
from skimage import measure


# ---------- Bezier helpers ----------
def _q(bez, t):
    mt = 1 - t
    return (mt**3)*bez[0] + 3*mt*mt*t*bez[1] + 3*mt*t*t*bez[2] + t**3*bez[3]


def _qprime(bez, t):
    mt = 1 - t
    return 3*mt*mt*(bez[1]-bez[0]) + 6*mt*t*(bez[2]-bez[1]) + 3*t*t*(bez[3]-bez[2])


def _norm(v):
    n = np.hypot(v[0], v[1])
    return v/n if n > 1e-12 else v*0


def _chord_param(pts):
    u = [0.0]
    for i in range(1, len(pts)):
        u.append(u[-1] + np.hypot(*(pts[i]-pts[i-1])))
    u = np.array(u)
    return u/u[-1] if u[-1] > 0 else u


def _gen_bezier(pts, u, t1, t2):
    A = np.zeros((len(pts), 2, 2))
    for i, ui in enumerate(u):
        A[i, 0] = t1 * (3*(1-ui)**2*ui)
        A[i, 1] = t2 * (3*(1-ui)*ui**2)
    C = np.zeros((2, 2)); X = np.zeros(2)
    p0, p3 = pts[0], pts[-1]
    for i, ui in enumerate(u):
        C[0, 0] += A[i, 0] @ A[i, 0]; C[0, 1] += A[i, 0] @ A[i, 1]
        C[1, 0] = C[0, 1];            C[1, 1] += A[i, 1] @ A[i, 1]
        tmp = pts[i] - ((1-ui)**3*p0 + 3*(1-ui)**2*ui*p0 + 3*(1-ui)*ui**2*p3 + ui**3*p3)
        X[0] += A[i, 0] @ tmp; X[1] += A[i, 1] @ tmp
    det = C[0, 0]*C[1, 1] - C[0, 1]*C[1, 0]
    if abs(det) < 1e-12:
        a1 = a2 = np.hypot(*(p3-p0))/3
    else:
        a1 = (X[0]*C[1, 1]-X[1]*C[0, 1])/det
        a2 = (C[0, 0]*X[1]-C[1, 0]*X[0])/det
        seg = np.hypot(*(p3-p0))
        if a1 < 1e-6 or a2 < 1e-6:
            a1 = a2 = seg/3
    return [p0, p0+t1*a1, p3+t2*a2, p3]


def _max_err(pts, bez, u):
    mx, idx = 0.0, len(pts)//2
    for i in range(1, len(pts)-1):
        d = _q(bez, u[i]) - pts[i]
        e = d @ d
        if e > mx:
            mx, idx = e, i
    return mx, idx


def _reparam(pts, bez, u):
    out = []
    for i, ui in enumerate(u):
        d = _q(bez, ui) - pts[i]
        num = d @ _qprime(bez, ui)
        qp = _qprime(bez, ui)
        den = qp @ qp + d @ (6*(1-ui)*(bez[2]-2*bez[1]+bez[0]) + 6*ui*(bez[3]-2*bez[2]+bez[1]))
        out.append(ui if abs(den) < 1e-9 else ui - num/den)
    return np.array(out)


def _fit_cubic(pts, t1, t2, err):
    if len(pts) == 2:
        d = np.hypot(*(pts[1]-pts[0]))/3
        return [[pts[0], pts[0]+t1*d, pts[1]+t2*d, pts[1]]]
    u = _chord_param(pts)
    bez = _gen_bezier(pts, u, t1, t2)
    mx, split = _max_err(pts, bez, u)
    if mx < err:
        return [bez]
    if mx < err*4:
        for _ in range(12):
            u = _reparam(pts, bez, u)
            bez = _gen_bezier(pts, u, t1, t2)
            mx, split = _max_err(pts, bez, u)
            if mx < err:
                return [bez]
    ct = _norm(pts[split-1]-pts[split+1])
    return _fit_cubic(pts[:split+1], t1, ct, err) + _fit_cubic(pts[split:], -ct, t2, err)


def fit_open(pts, err):
    if len(pts) < 3:
        return []
    return _fit_cubic(pts, _norm(pts[1]-pts[0]), _norm(pts[-2]-pts[-1]), err)


# ---------- corner detection on closed contour ----------
def _corners(pts, k=4, deg=42):
    n = len(pts); out = []
    for i in range(n):
        a = pts[(i-k) % n]; b = pts[i]; c = pts[(i+k) % n]
        v1 = _norm(b-a); v2 = _norm(c-b)
        ang = np.degrees(np.arccos(np.clip(v1 @ v2, -1, 1)))
        if ang > deg:
            out.append(i)
    # dedupe จุดมุมที่ติดกัน เก็บตัวแทน
    merged = []
    for i in out:
        if not merged or (i - merged[-1]) > k:
            merged.append(i)
    return merged


def precise_paths(mask, scale=6, blur=2.5, max_err_px=1.6, corner_deg=42,
                  min_area_native=30, out_scale=1.0):
    H, W = mask.shape
    big = cv2.resize(mask, (W*scale, H*scale), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    field = cv2.GaussianBlur(big, (0, 0), blur*scale/4.0)
    contours = measure.find_contours(field, 127.0)
    err = (max_err_px*scale)**2
    min_area = min_area_native*scale*scale
    svg_paths, render = [], []
    for c in contours:
        pts = c[:, ::-1]                       # (x,y), sub-pixel
        if len(pts) < 12:
            continue
        area = 0.5*abs(np.dot(pts[:, 0], np.roll(pts[:, 1], 1)) - np.dot(pts[:, 1], np.roll(pts[:, 0], 1)))
        if area < min_area:
            continue
        cs = _corners(pts, k=max(3, scale//2), deg=corner_deg)
        beziers = []
        if len(cs) >= 2:
            for j in range(len(cs)):
                a, b = cs[j], cs[(j+1) % len(cs)]
                seg = pts[a:b+1] if a < b else np.vstack([pts[a:], pts[:b+1]])
                beziers += fit_open(seg, err)
        else:
            closed = np.vstack([pts, pts[:1]])
            beziers += fit_open(closed, err)
        if not beziers:
            continue
        # -> svg path (มม.) + polyline (render, big-px)
        k = out_scale
        d = [f"M {beziers[0][0][0]*k:.2f},{beziers[0][0][1]*k:.2f}"]
        poly = []
        for bz in beziers:
            d.append(f"C {bz[1][0]*k:.2f},{bz[1][1]*k:.2f} {bz[2][0]*k:.2f},{bz[2][1]*k:.2f} {bz[3][0]*k:.2f},{bz[3][1]*k:.2f}")
            for t in np.linspace(0, 1, 14):
                poly.append(_q(bz, t))
        d.append("Z")
        svg_paths.append(" ".join(d))
        render.append(np.array(poly))
    return svg_paths, render
