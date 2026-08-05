"""🔦 เส้นเดินไฟนีออน 'เส้นเดี่ยว' — หาแกนกลาง **ทีละตัวอักษร** ก่อนรวม

════════════════════════════════════════════════════════════════════════
ทำไมต้องทีละตัว (สรุปจากการวัดจริง 2026-08-05)
────────────────────────────────────────────────────────────────────────
โลโก้ลายมือ (script) ตัวอักษรจะ 'ซ้อนทับกัน' เป็นปกติ
ถ้าเอามารวมเป็นก้อนเดียวก่อน (unary_union) ตรงที่ซ้อนจะกลายเป็นก้อนอ้วน
แล้วแกนกลางของก้อนอ้วนจะ **แตกแขนงเป็นใยแมงมุม** — เส้นไฟเลยมั่ว อ่านไม่ออก

  วัดจริง คำว่า "Coffee" กว้าง 110 ซม.:
     รวมก่อนแล้วหาแกน : 22 ท่อน · ปลายที่ชนกันเป็นปมแตกแขนง 36 จาก 44
     หาแกนทีละตัว     : 11 ท่อน · ปม 15 จาก 22          <-- สะอาดกว่าชัดเจน
  วัดจริง "Eleca bars Coffee Beans" 20 ตัว กว้าง 110 ซม. ท่อ 8 มม.:
     รวมก่อน : 76 ท่อน       ทีละตัว : 59 ท่อน
     ท่อ 8 มม. เต็มลายเส้น 56.2% · ล้นออกนอกตัวอักษร 0.85%

และของจริงก็เป็นแบบนี้ — ป้ายนีออนจริง ท่อของตัว o กับตัว f เป็นคนละเส้น
วางไขว้กันได้ตามปกติ ไม่ต้องเอามาเชื่อมเป็นเส้นเดียว

════════════════════════════════════════════════════════════════════════
เรื่องความเร็ว (สำคัญ)
────────────────────────────────────────────────────────────────────────
neon_route.geom_to_mask จะดันความละเอียดให้ด้านยาว ≥3000 px **เสมอ**
ซึ่งถูกสำหรับงานทั้งใบ แต่ถ้าเรียกทีละตัวอักษร ตัวเดียวก็โดนดันเป็น 3000 px
-> ตัวเดียวใช้เวลา 6 วินาที · 20 ตัว = 95 วินาที (ช้าจนใช้งานจริงไม่ได้)

✅ โมดูลนี้จึงคำนวณความละเอียด **ครั้งเดียวจากงานทั้งใบ** แล้วใช้ค่าเดียวกัน
   กับทุกตัวอักษร -> รายละเอียดเท่าเดิมเป๊ะ แต่เร็วขึ้นหลายสิบเท่า

โมดูลนี้ไม่แก้ neon_route.py แม้แต่บรรทัดเดียว — เรียกใช้ชิ้นส่วนของมันเท่านั้น
"""

import time
import numpy as np
import cv2

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from . import neon_route as NR


# ─────────────── ความละเอียด: คิดครั้งเดียวจากงานทั้งใบ ───────────────
def plan_ppm(full, px_per_mm=4.0, max_px=6000.0):
    b = full.bounds
    _long = max(b[2] - b[0], b[3] - b[1], 1e-6)
    ppm = max(float(px_per_mm), min(3000.0, float(max_px)) / _long)
    return min(ppm, float(max_px) / _long)


def _mask_fixed(geom, ppm, pad_px=8):
    """วาดรูปทรงลงภาพ ด้วยความละเอียดที่กำหนดมา (ไม่ปรับเองเหมือน geom_to_mask)"""
    b = geom.bounds
    W = int(round((b[2] - b[0]) * ppm)) + pad_px * 2
    H = int(round((b[3] - b[1]) * ppm)) + pad_px * 2
    if W < 3 or H < 3 or W * H > 60_000_000:
        return None, None
    m = np.zeros((H, W), np.uint8)

    def ring(cs):
        a = np.asarray(cs, dtype=np.float64)
        a[:, 0] = (a[:, 0] - b[0]) * ppm + pad_px
        a[:, 1] = (a[:, 1] - b[1]) * ppm + pad_px
        return np.round(a).astype(np.int32)

    for pg in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom]):
        if pg.geom_type != "Polygon" or pg.is_empty:
            continue
        cv2.fillPoly(m, [ring(pg.exterior.coords)], 255)
        for h in pg.interiors:
            cv2.fillPoly(m, [ring(h.coords)], 0)
    return m, (b[0] - pad_px / ppm, b[1] - pad_px / ppm)


# ─────────────── แกนกลางของ 'หนึ่งชิ้น' ───────────────
def piece_lines(pg, ppm, tube_mm, snap=True, bend_ratio=1.5):
    mask, org = _mask_fixed(pg, ppm)
    if mask is None or not mask.any():
        return [], 0.0
    sw = NR.stroke_width_mm(mask, ppm)
    sk = NR.skeleton(mask)
    chains, nodes = NR.trace_chains(sk)
    items = NR.prune_and_join(chains, nodes, ppm, spur_mm=max(sw, 2.0) * 0.75)
    tree = opts = None
    if snap:
        try:
            from scipy.spatial import cKDTree
            opts = NR.outline_points(pg, step_mm=max(0.2, 1.0 / max(ppm, 1e-6)))
            if opts is not None and len(opts) > 8:
                tree = cKDTree(opts)
        except Exception:
            tree = opts = None
    out = []
    for c in items:
        ls = NR.chain_to_line(c, ppm, org)
        if ls is None or ls.length < max(8.0, float(tube_mm) * 1.5):
            continue
        if tree is not None:
            ls = NR.snap_to_outline(ls, pg, tree, opts, max_shift_mm=max(sw, 2.0))
            ls = ls.simplify(0.15)
        out.append(NR.relax_tight_bends(ls, float(tube_mm) * bend_ratio))
    return out, sw


# ─────────────── หน้าบ้านสำหรับ app.py ───────────────
def centerline_subs(full, pieces=None, tube_mm=8.0, clear_mm=1.0,
                    px_per_mm=4.0, max_px=6000.0, budget_s=25.0, max_pieces=400):
    """คืน (subs, report) รูปแบบเดียวกับ neon_route.centerline_subs

    pieces = รายชิ้น 'ก่อนรวม' (ตัวอักษรแยกตัว) · ไม่ส่งมา -> แตกจาก full เท่าที่แยกได้
    """
    try:
        if full is None or full.is_empty:
            return [], []
        src = [p for p in (pieces or []) if p is not None and not p.is_empty]
        if not src:
            src = [p for p in (full.geoms if isinstance(full, MultiPolygon) else [full])
                   if p.geom_type == "Polygon" and not p.is_empty]
        if not src or len(src) > int(max_pieces):
            return [], []
        src.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))

        ppm = plan_ppm(full, px_per_mm=px_per_mm, max_px=max_px)
        try:
            from neon_single import _to_curves
        except Exception:
            try:
                from .neon_single import _to_curves
            except Exception:
                _to_curves = None

        t0 = time.time()
        subs = []
        report = []
        rmin_all = []
        done = 0
        for i, pg in enumerate(src):
            if time.time() - t0 > float(budget_s):
                report.append({"idx": 0, "mode": "note", "ok": False, "min_mm": 0.0, "med_mm": 0.0,
                               "note": ("⏱️ งานนี้ชิ้นเยอะ (%d ชิ้น) — คำนวณเส้นไฟทันเวลาแค่ %d ชิ้น "
                                        "ที่เหลือใช้วิธีรวมทั้งใบแทน" % (len(src), done))})
                return [], []                      # ไม่ทันจริง -> ให้ผู้เรียกถอยไปวิธีเดิมทั้งชุด
            try:
                lines, sw = piece_lines(pg, ppm, tube_mm)
            except Exception:
                lines, sw = [], 0.0
            done += 1
            if not lines:
                continue
            for ls in lines:
                pts = [tuple(q) for q in np.asarray(ls.coords)]
                if len(pts) < 2:
                    continue
                closed = bool(len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-6
                              and abs(pts[0][1] - pts[-1][1]) < 1e-6)
                if _to_curves is not None:
                    st, sg = _to_curves(pts, closed=closed)
                    if sg:
                        subs.append({"start": st, "segs": sg, "closed": closed})
                        continue
                subs.append({"start": pts[0], "segs": [("L", q) for q in pts[1:]],
                             "closed": closed})
                rmin_all.append(NR.min_radius(ls))
            need = float(tube_mm) + 2.0 * float(clear_mm)
            report.append({"idx": i + 1, "min_mm": round(sw, 1), "med_mm": round(sw, 1),
                           "ok": bool(sw >= need), "mode": "center"})
        if not subs:
            return [], []
        report.append({"idx": 0, "mode": "note", "ok": True, "min_mm": 0.0, "med_mm": 0.0,
                       "note": ("🔦 เดินไฟแบบ 'ทีละตัวอักษร' %d ชิ้น -> %d ท่อน "
                                "(ท่อของแต่ละตัวเป็นคนละเส้น วางไขว้กันได้ตามงานจริง) "
                                "· ใช้เวลา %.1f วินาที" % (len(src), len(subs), time.time() - t0))})
        return subs, report
    except Exception:
        return [], []
