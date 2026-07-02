"""ระดับ 'เนียนกริบสุด' — ดึงเส้นแบบ sub-pixel (marching squares) บน field ที่เบลอ
ให้พิกัดต่ำกว่าพิกเซล -> ลื่นกว่า cv2.findContours (ที่ติดกริดจำนวนเต็ม) มาก
"""
import cv2
import numpy as np
from skimage import measure
from .smooth import corner_aware_path


def _area(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def _smooth_closed(pts, passes=1):
    p = pts.copy()
    for _ in range(passes):
        p = 0.25 * np.roll(p, 1, 0) + 0.5 * p + 0.25 * np.roll(p, -1, 0)
    return p


def ultra_paths(mask, scale=4, blur=2.5, rdp_eps=1.4, corner_deg=40,
                min_area_native=40, presmooth=1, out_scale=1.0):
    """
    mask(native binary) -> [(svg_path, render_poly_bigpx, None), ...], field
    ใช้ sub-pixel contour + corner-aware Bezier
    """
    H, W = mask.shape
    big = cv2.resize(mask, (W * scale, H * scale), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    field = cv2.GaussianBlur(big, (0, 0), blur * scale / 4.0)
    contours = measure.find_contours(field, 127.0)      # sub-pixel, (row,col)=(y,x)
    min_area_big = min_area_native * scale * scale
    out = []
    for c in contours:
        pts = c[:, ::-1].astype(np.float32)             # -> (x,y)
        if len(pts) < 8 or _area(pts) < min_area_big:
            continue
        if presmooth:
            pts = _smooth_closed(pts, presmooth).astype(np.float32)
        ap = cv2.approxPolyDP(pts.reshape(-1, 1, 2), rdp_eps, True).reshape(-1, 2)
        if len(ap) < 3:
            continue
        path, poly = corner_aware_path(ap, corner_deg=corner_deg, k=out_scale)
        out.append((path, poly, None))
    return out, field
