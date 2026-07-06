"""raster_geom.py — แปลงภาพ JPG/PNG เป็น geometry dict (แบบเดียวกับ spec_render.load_geometry)
เพื่อให้ Check Sheet รับภาพบิตแมปได้เหมือน .ai/.pdf

ขั้นตอน:
  1) ตัดพื้นหลังออกอัตโนมัติ (alpha / สีขอบ + GrabCut) -> เหลือเฉพาะตัวป้าย
  2) แยกชั้นตามสี (cv2.kmeans) -> คลัสเตอร์สีที่ใหญ่สุด = แผ่นฐาน · ที่เหลือ = ตัวอักษร/กราฟิก
  3) แปลงเป็น polygon (shapely) + normalize ให้ป้ายกว้าง = disp_w

คืน dict คีย์เดียวกับ load_geometry: OVAL, BG, LET, LEAF, RINGS, KW, WLEAF, W, H, u2mm, real_w_mm, real_h_mm
(LEAF/RINGS/KW/WLEAF = [] เพราะเป็นชั้นเฉพาะแบบ 4.3 — ภาพทั่วไปใช้ ฐาน + หน้าอักษร พอ)
"""
import numpy as np
import cv2
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.affinity import translate, scale as _scale

MAX_DIM = 1100          # ย่อภาพใหญ่ก่อนประมวลผล (เร็ว)
MIN_AREA_FRAC = 0.0008  # ชิ้นเล็กกว่านี้ (เทียบพื้นที่ภาพ) ทิ้ง


# ---------------- background removal ----------------
def remove_background(bgr, alpha=None):
    """คืน mask โฟร์กราวด์ (uint8 0/255) — ตัดพื้นหลังออก เหลือเฉพาะตัวป้าย"""
    h, w = bgr.shape[:2]
    if alpha is not None and alpha.max() > 0:
        m = (alpha > 25).astype('uint8') * 255
    else:
        # ประเมินสีพื้นหลังจากขอบภาพ (มุม/ขอบ)
        edges = np.concatenate([bgr[0, :], bgr[-1, :], bgr[:, 0], bgr[:, -1]], axis=0).astype(np.float32)
        bg = np.median(edges, axis=0)
        dist = np.linalg.norm(bgr.astype(np.float32) - bg, axis=2)
        thr = max(28.0, float(np.percentile(dist, 55)))
        m = (dist > thr).astype('uint8') * 255
        # GrabCut ปรับให้เนียน (ถ้าภาพไม่เล็กเกิน)
        try:
            gc = np.where(m > 0, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype('uint8')
            gc[:2, :] = cv2.GC_BGD; gc[-2:, :] = cv2.GC_BGD; gc[:, :2] = cv2.GC_BGD; gc[:, -2:] = cv2.GC_BGD
            bgdM = np.zeros((1, 65), np.float64); fgdM = np.zeros((1, 65), np.float64)
            cv2.grabCut(bgr, gc, None, bgdM, fgdM, 3, cv2.GC_INIT_WITH_MASK)
            m = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype('uint8')
        except Exception:
            pass
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    # เก็บเฉพาะ component ใหญ่
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m); amin = MIN_AREA_FRAC * h * w
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= amin:
            keep[lab == i] = 255
    return keep


def _fill(mask):
    """เติมรูใน -> silhouette ทึบ (แผ่นฐาน)"""
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(mask)
    cv2.drawContours(out, cnts, -1, 255, cv2.FILLED)
    return out


def _polys(mask, min_area, simplify=0.004):
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        if cv2.contourArea(c) < min_area:
            continue
        eps = simplify * cv2.arcLength(c, True)
        c = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(c) < 3:
            continue
        p = Polygon([(float(x), float(y)) for x, y in c]).buffer(0)
        if not p.is_empty and p.area > min_area:
            for g in (p.geoms if p.geom_type == 'MultiPolygon' else [p]):
                if g.area > min_area:
                    out.append(Polygon(g.exterior.coords))
    return out


# ---------------- main ----------------
def load_geometry_raster(img_path, real_w_mm=800.0, real_h_mm=450.0, disp_w=900.0,
                         n_colors=4, remove_bg=True):
    raw = cv2.imread(img_path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise ValueError('อ่านไฟล์ภาพไม่ได้ (รองรับ JPG/PNG)')
    alpha = None
    if raw.ndim == 2:
        bgr = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    elif raw.shape[2] == 4:
        alpha = raw[:, :, 3]; bgr = raw[:, :, :3]
    else:
        bgr = raw[:, :, :3]
    # ย่อภาพ
    h, w = bgr.shape[:2]; sc0 = min(1.0, MAX_DIM / max(h, w))
    if sc0 < 1.0:
        bgr = cv2.resize(bgr, (int(w * sc0), int(h * sc0)), interpolation=cv2.INTER_AREA)
        if alpha is not None:
            alpha = cv2.resize(alpha, (int(w * sc0), int(h * sc0)), interpolation=cv2.INTER_AREA)
    h, w = bgr.shape[:2]; amin = MIN_AREA_FRAC * h * w

    fg = remove_background(bgr, alpha) if remove_bg else np.full((h, w), 255, 'uint8')
    if int((fg > 0).sum()) < amin:
        raise ValueError('หาตัวป้ายในภาพไม่เจอ (ภาพอาจไม่มีวัตถุชัด หรือพื้นหลังกลืนกับป้าย)')

    # แผ่นฐาน = silhouette ทึบของโฟร์กราวด์
    sil = _fill(fg)
    base_polys = _polys(sil, amin * 3, simplify=0.003)
    if not base_polys:
        raise ValueError('สร้างรูปทรงป้ายจากภาพไม่ได้')
    OVAL = max(base_polys, key=lambda p: p.area)

    # แยกสีด้วย kmeans เฉพาะโฟร์กราวด์
    LET = []
    ys, xs = np.where(fg > 0)
    if len(xs) > 50:
        K = int(max(2, min(n_colors, 6)))
        samp = bgr[ys, xs].astype(np.float32)
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
        _, labels, centers = cv2.kmeans(samp, K, None, crit, 3, cv2.KMEANS_PP_CENTERS)
        labels = labels.flatten()
        lab_img = np.full((h, w), -1, np.int32); lab_img[ys, xs] = labels
        areas = [int((labels == k).sum()) for k in range(K)]
        base_k = int(np.argmax(areas))            # คลัสเตอร์ใหญ่สุด = สีแผ่นฐาน
        kk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        for k in range(K):
            if k == base_k:
                continue
            mk = ((lab_img == k) & (fg > 0)).astype('uint8') * 255
            mk = cv2.morphologyEx(mk, cv2.MORPH_OPEN, kk)
            mk = cv2.morphologyEx(mk, cv2.MORPH_CLOSE, kk)
            LET += _polys(mk, amin, simplify=0.006)
    if not LET:                                    # เผื่อภาพสีเดียว: ใช้ silhouette เป็นหน้า
        LET = [OVAL]

    # normalize -> ป้ายกว้าง = disp_w (เหมือน load_geometry)
    mnx, mny, mxx, mxy = OVAL.bounds; sc = disp_w / (mxx - mnx)

    def N(p):
        return _scale(translate(p, -mnx, -mny), xfact=sc, yfact=sc, origin=(0, 0))

    return {
        'OVAL': N(OVAL), 'BG': N(OVAL),
        'LET': [N(p) for p in LET],
        'LEAF': [], 'RINGS': [], 'KW': [], 'WLEAF': [],
        'W': disp_w, 'H': (mxy - mny) * sc, 'u2mm': real_w_mm / disp_w,
        'real_w_mm': real_w_mm, 'real_h_mm': real_h_mm,
        'source': 'raster',
    }
