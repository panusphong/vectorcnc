"""ทำเส้นตัดให้ 'เนียนกริบ' พอสำหรับ CNC จริง
หลักการที่ถูกต้อง:
  1) ขยาย+เบลอ-threshold  -> ขอบ sub-pixel เนียน (ลบขั้นบันได)
  2) approxPolyDP บนภาพเนียน -> ได้ anchor ที่เส้นตรง 'ตรงเป๊ะ' + จับมุมจริง
  3) ต่อ anchor เป็นโค้ง Catmull-Rom->Bezier: ช่วงตรง=ตรง, ช่วงโค้ง=ลื่น,
     มุมคม (มุมเลี้ยวมาก) = คงคม ไม่ปัดมน
"""
import cv2
import numpy as np


def upscale_smooth_mask(mask, scale=5, sigma=None):
    H, W = mask.shape
    big = cv2.resize(mask, (W * scale, H * scale), interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), sigma if sigma else scale * 1.2)
    _, big = cv2.threshold(big, 127, 255, cv2.THRESH_BINARY)
    return big


def _turn_deg(a, b, c):
    """มุมเลี้ยวที่จุด b (องศา) 0=ตรง, ค่ามาก=หักมุม"""
    v1 = b - a
    v2 = c - b
    n1 = np.hypot(*v1)
    n2 = np.hypot(*v2)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    cosv = np.clip((v1 @ v2) / (n1 * n2), -1, 1)
    return float(np.degrees(np.arccos(cosv)))


def _bezier_segment(p1, c1, c2, p2, n=16):
    t = np.linspace(0, 1, n, endpoint=False).reshape(-1, 1)
    mt = 1 - t
    return (mt**3) * p1 + 3 * (mt**2) * t * c1 + 3 * mt * (t**2) * c2 + (t**3) * p2


def corner_aware_path(anchors, corner_deg=48, k=1.0):
    """anchors (Nx2) เส้นปิด -> (svg_path_str, polyline_for_render)
    เส้นตรงคงตรง / โค้งลื่น / มุมคมคงคม"""
    P = anchors.astype(np.float64)
    n = len(P)
    is_corner = [_turn_deg(P[(i - 1) % n], P[i], P[(i + 1) % n]) > corner_deg for i in range(n)]
    dparts = [f"M {P[0,0]*k:.2f},{P[0,1]*k:.2f}"]
    poly = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        # ถ้าปลายเป็นมุมคม -> ตัดแรงดึง tangent ให้เป็นเส้นตรงเข้า/ออกมุม
        c1 = p1 if is_corner[i] else p1 + (p2 - p0) / 6.0
        c2 = p2 if is_corner[(i + 1) % n] else p2 - (p3 - p1) / 6.0
        dparts.append(f"C {c1[0]*k:.2f},{c1[1]*k:.2f} {c2[0]*k:.2f},{c2[1]*k:.2f} {p2[0]*k:.2f},{p2[1]*k:.2f}")
        poly.append(_bezier_segment(p1, c1, c2, p2, 16))
    dparts.append("Z")
    return " ".join(dparts), np.vstack(poly)


def crisp_paths(mask, scale=5, eps_frac=0.0022, corner_deg=48,
                min_area_native=40, out_scale=1.0):
    """
    mask(native) -> [(svg_path, render_polyline_bigpx, is_hole), ...], big_mask
    """
    big = upscale_smooth_mask(mask, scale=scale)
    cnts, hier = cv2.findContours(big, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    min_area_big = min_area_native * scale * scale
    out = []
    for c, h in zip(cnts, hier[0]):
        if cv2.contourArea(c) < min_area_big:
            continue
        ap = cv2.approxPolyDP(c, eps_frac * cv2.arcLength(c, True), True).reshape(-1, 2)
        if len(ap) < 3:
            continue
        path, poly = corner_aware_path(ap, corner_deg=corner_deg, k=out_scale)
        out.append((path, poly, h[3] != -1))
    return out, big
