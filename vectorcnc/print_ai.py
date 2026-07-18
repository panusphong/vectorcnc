"""
print_ai.py — สร้างไฟล์ .ai สำหรับ "งานพิมพ์" ที่คุณภาพเท่าต้นฉบับ 100%

ทำไมไม่ vectorize:
  ภาพการ์ตูน/โลโก้ที่มี gradient (ไล่สี ไล่เงา) พอเอาไป trace เป็นเวกเตอร์
  สีจะกลายเป็น "แถบสีแบน" เสมอ ไม่มีทางเหมือนต้นฉบับ
  งานพิมพ์ (สติกเกอร์/ฟิล์มกล่องไฟ) ไม่ต้องการเวกเตอร์อยู่แล้ว —
  เครื่องพิมพ์พิมพ์จากภาพ raster ตรง ๆ ได้คมชัดกว่า

วิธีมาตรฐานโรงพิมพ์:
  1. ฝังภาพต้นฉบับความละเอียดเต็มลงใน .ai ที่ "ขนาดจริงเป็นมิลลิเมตร"
  2. ทำ "เส้นไดคัท" (die-cut / CutContour) รอบตัวงาน เป็นเวกเตอร์
     - ใช้ spot color ชื่อ "CutContour" (มาตรฐานที่ RIP ทุกตัวรู้จัก:
       Onyx, Caldera, Flexi, VersaWorks) -> เครื่องตัดสติกเกอร์ตัดตามเส้นนี้
  3. เผื่อขอบ (bleed) ออกนอกภาพนิดหน่อย กันตัดกินเนื้องาน

ได้ไฟล์ .ai (PDF-based) เปิดใน Illustrator ได้ · ภาพเป๊ะ 100% · มีเส้นตัดพร้อมผลิต
"""

import os
import io
import math

PRINT_AI_VERSION = "2026-07-19-smooth144+whitebase-fix+contour-wrap"

MM = 72.0 / 25.4        # มม. -> จุด (PDF point)


# ──────────────────────────────────────────────── หา mask ของตัวงาน (แยกจากพื้นหลัง)
def _subject_mask(im, bg_tol=18):
    """คืน mask (True=ตัวงาน) · รองรับทั้งภาพโปร่ง (alpha) และพื้นขาว"""
    import numpy as np
    im = im.convert("RGBA")
    a = np.array(im)
    alpha = a[:, :, 3]

    def _clear_border(m):
        # ⚠️ บังคับให้ขอบภาพเป็น 'พื้นหลัง' เสมอ (เว้น 2px)
        #    กัน findContours วิ่งตามขอบเฟรมเป็นเส้นตรง (บั๊กเส้นตัดเป็นสี่เหลี่ยม)
        m[:2, :] = False; m[-2:, :] = False; m[:, :2] = False; m[:, -2:] = False
        return m

    if alpha.min() < 250:                       # มี transparency จริง
        return _clear_border(alpha > 20)

    # พื้นทึบ -> เดาสีพื้นจากมุมทั้ง 4 (ส่วนใหญ่คือขาว)
    rgb = a[:, :, :3].astype(int)
    H, W = rgb.shape[:2]
    corners = np.array([rgb[0, 0], rgb[0, W-1], rgb[H-1, 0], rgb[H-1, W-1]])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    return _clear_border(dist > bg_tol)


def _fill_contours(mask, choke_px, simplify_px, smooth_px=0.0, tol_px=0.0):
    """คืน polygon ทั้งหมด (นอก+รูใน) ของ mask สำหรับ 'เทสีทึบ' = รองขาว
       choke_px > 0 = หดเข้าในนิดหน่อย กันสีขาวโผล่พ้นขอบงาน (มาตรฐาน UV)
       + smooth/simplify = จุดน้อย เรียบ (รองขาวก็ไม่ต้องละเอียดตามหยัก)"""
    import numpy as np
    import cv2
    m = (mask.astype(np.uint8)) * 255
    if choke_px > 0:
        m = cv2.erode(m, np.ones((int(choke_px)*2+1,)*2, np.uint8))

    # ── ทำให้เรียบ + จุดน้อยด้วย shapely (ตรงกับเส้นไดคัท) ──
    try:
        from shapely.geometry import Polygon, MultiPolygon
        from shapely.ops import unary_union
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        amin = 0.0005 * m.shape[0] * m.shape[1]
        ps = []
        for c in cnts:
            c = c.reshape(-1, 2)
            if len(c) >= 3:
                p = Polygon([(float(x), float(y)) for x, y in c])
                if p.is_valid and p.area >= amin:
                    ps.append(p)
        if ps:
            g = unary_union(ps)
            s = float(smooth_px) if smooth_px > 0 else 2.0
            g = g.buffer(s, join_style=1).buffer(-s, join_style=1)   # ลบหยัก
            tol = float(tol_px) if tol_px > 0 else max(1.0, simplify_px * 2.0)
            g = g.simplify(tol, preserve_topology=True)
            parts = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
            out = []
            for p in parts:
                if p.is_empty or p.area < amin:
                    continue
                out.append([(float(x), float(y)) for x, y in p.exterior.coords[:-1]])
            if out:
                return out
    except Exception:
        pass

    # fallback: approxPolyDP หยาบ ๆ
    cnts, _ = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    amin = 0.0005 * m.shape[0] * m.shape[1]
    for c in cnts:
        if cv2.contourArea(c) < amin:
            continue
        ap = cv2.approxPolyDP(c, max(2.0, float(simplify_px) * 2.0), True).reshape(-1, 2)
        if len(ap) >= 3:
            out.append([(float(x), float(y)) for x, y in ap])
    return out


def _outer_contour(mask, bleed_px, simplify_px, smooth_px=0.0, tol_px=0.0):
    """เส้นไดคัทสำหรับเครื่องตัดสติกเกอร์ — เรียบ + จุดน้อย (ใบมีดวิ่งเร็ว)

    หัวใจ: ไดคัทงานพิมพ์ "ไม่ต้องตามทุกหยักของขอบดำ" — ต้องการเส้นล้อมรอบเรียบ ๆ
      1) รวม+เผื่อขอบ (bleed) ออกนอกงาน
      2) 'ปิดอ่าว' — buffer ออกแล้วหดกลับ (smooth) ทำให้ร่องหยักหายไป เหลือเส้นนุ่ม
      3) simplify แบบระยะจริง (มม.) -> จุดลดจากหลักพันเหลือหลักสิบ
    """
    import numpy as np
    import cv2

    m = (mask.astype(np.uint8)) * 255
    k = max(3, int(bleed_px) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    if bleed_px > 0:
        m = cv2.dilate(m, np.ones((int(bleed_px)*2+1,)*2, np.uint8))

    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_min = (0.002 * m.shape[0] * m.shape[1])
    raw = [c.reshape(-1, 2) for c in cnts if cv2.contourArea(c) >= area_min]
    if not raw:
        return []

    # ── ใช้ shapely ทำให้เส้นเรียบ + จุดน้อย (ถ้าไม่มีก็ fallback approxPolyDP) ──
    try:
        from shapely.geometry import Polygon, MultiPolygon
        from shapely.ops import unary_union
        polys_sh = []
        for c in raw:
            if len(c) >= 3:
                p = Polygon([(float(x), float(y)) for x, y in c])
                if p.is_valid and p.area > 0:
                    polys_sh.append(p)
        g = unary_union(polys_sh)
        s = float(smooth_px) if smooth_px > 0 else max(2.0, bleed_px * 0.9)
        g = g.buffer(s, join_style=1).buffer(-s, join_style=1)   # ปิดอ่าว/ลบหยัก
        tol = float(tol_px) if tol_px > 0 else max(1.5, simplify_px * 2.5)
        g = g.simplify(tol, preserve_topology=True)              # ลดจุด (ระยะจริง)
        parts = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
        out = []
        for p in parts:
            if p.is_empty or p.area < area_min:
                continue
            out.append([(float(x), float(y)) for x, y in p.exterior.coords[:-1]])
        if out:
            out.sort(key=lambda q: -_poly_area(q))
            return out
    except Exception:
        pass

    # fallback: approxPolyDP หยาบ ๆ (จุดน้อย)
    polys = []
    for c in raw:
        eps = max(2.5, float(simplify_px) * 2.5)
        ap = cv2.approxPolyDP(c.reshape(-1, 1, 2), eps, True).reshape(-1, 2)
        if len(ap) >= 3:
            polys.append([(float(x), float(y)) for x, y in ap])
    polys.sort(key=lambda p: -_poly_area(p))
    return polys


def _contour_wrap(mask, bleed_px, W, H):
    """เส้นตัด 'ทรงกล่องไฟล้อมตามทรง' — envelope เรียบมน ก้อนเดียว คลุมทั้งงาน
       (สำหรับเลเซอร์ตัดขอบอะคริลิคหน้ากล่องไฟ หลังพิมพ์ UV)
       ต่างจากไดคัท: เชื่อมทุกส่วน + กลืนก้านบาง + โค้งมน = ขอบกล่องเรียบ ไม่แนบตัวงาน"""
    import numpy as np
    import cv2
    m = (mask.astype(np.uint8)) * 255
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return []
    try:
        from shapely.geometry import Polygon, MultiPolygon
        from shapely.ops import unary_union
        polys = []
        for c in cnts:
            c = c.reshape(-1, 2)
            if len(c) >= 3:
                p = Polygon([(float(x), float(y)) for x, y in c])
                if p.is_valid and p.area > 4:
                    polys.append(p)
        if not polys:
            return []
        full = unary_union(polys)
        size = max(W, H, 1.0)
        r = max(bleed_px, size * 0.06)            # เชื่อมทุกส่วนเป็นก้อนเดียว
        def outer(g):
            ps = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
            ps = [q for q in ps if q and not q.is_empty]
            if not ps:
                return None
            u = unary_union([Polygon(q.exterior) for q in ps])
            if isinstance(u, MultiPolygon):
                u = max(u.geoms, key=lambda a: a.area)
            return u
        g = outer(full.buffer(r, join_style=1).buffer(-r, join_style=1)) or full
        o = size * 0.035
        g = outer(g.buffer(-o, join_style=1).buffer(o * 1.15, join_style=1)) or g   # กลืนก้านบาง
        s = size * 0.02
        g = outer(g.buffer(s, join_style=1).buffer(-s, join_style=1)) or g          # โค้งมน
        if bleed_px > 0:
            g = g.buffer(bleed_px, join_style=1)                                     # เผื่อขอบ
        g = g.simplify(max(0.6, size * 0.004))
        if not g.is_valid:
            g = g.buffer(0)
            g = outer(g) or g
        if g.is_empty:
            return []
        return [[(float(x), float(y)) for x, y in g.exterior.coords[:-1]]]
    except Exception:
        return []


def _poly_area(p):
    a = 0.0
    n = len(p)
    for i in range(n):
        x1, y1 = p[i]; x2, y2 = p[(i+1) % n]
        a += x1*y2 - x2*y1
    return abs(a) / 2.0


def _round_path_pts(pts, r_px):
    """ลบมุมแหลมให้โค้งมนนิด ๆ (เส้นไดคัทสวย เครื่องตัดวิ่งนุ่ม)"""
    if r_px <= 0 or len(pts) < 3:
        return None
    out = []
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[(i-1) % n]
        x1, y1 = pts[i]
        x2, y2 = pts[(i+1) % n]
        v1 = (x0-x1, y0-y1); v2 = (x2-x1, y2-y1)
        l1 = math.hypot(*v1) or 1; l2 = math.hypot(*v2) or 1
        r = min(r_px, l1/2, l2/2)
        a = (x1 + v1[0]/l1*r, y1 + v1[1]/l1*r)
        b = (x1 + v2[0]/l2*r, y1 + v2[1]/l2*r)
        out.append(('L', a)); out.append(('Q', (x1, y1), b))
    return out


# ──────────────────────────────────────────────── ตัวสร้างไฟล์หลัก
def build(image_path, width_mm=300.0, bleed_mm=2.0, cut=True,
          corner_r_mm=0.0, upscale_to=0,
          white_base=False, white_choke_mm=0.3, cut_mode="diecut"):
    """
    สร้าง .ai (PDF) งานพิมพ์

    width_mm       : ความกว้างงานจริง (มม.) — สูงคำนวณตามสัดส่วนภาพ
    bleed_mm       : เผื่อขอบเส้นไดคัทออกนอกภาพ (มม.)
    cut            : ใส่เส้นไดคัท CutContour ไหม
    corner_r_mm    : ลบมุมเส้นไดคัทให้มน (มม.) · 0 = ตามรูปจริง
    upscale_to     : ภาพเล็กกว่านี้ (px) ขยายด้วย LANCZOS ก่อนฝัง · 0 = ไม่ขยาย
    white_base     : ทำเลเยอร์ "รองขาว" (white underbase สำหรับพิมพ์ UV) ไหม
    white_choke_mm : หดรองขาวเข้าใน (มม.) กันขาวโผล่พ้นขอบสี · มาตรฐาน 0.2–0.4

    เลเยอร์ที่ได้ (ล่าง→บน): รองขาว "White" → ภาพสี (CMYK) → เส้นไดคัท "CutContour"
    ทั้ง White และ CutContour เป็น spot color ที่ RIP งานพิมพ์รู้จัก

    return: (pdf_bytes, info_dict)
    """
    from PIL import Image
    import fitz

    im = Image.open(image_path)
    im = im.convert("RGBA") if im.mode in ("P", "LA") else im
    W0, H0 = im.size

    if upscale_to and W0 < upscale_to:
        sc = upscale_to / W0
        im = im.resize((int(W0*sc), int(H0*sc)), Image.LANCZOS)
        W0, H0 = im.size

    W_mm = float(width_mm)
    H_mm = W_mm * H0 / W0
    Wp, Hp = W_mm*MM, H_mm*MM
    sx = Wp / W0; sy = Hp / H0

    mask = None
    if cut or white_base:
        try:
            mask = _subject_mask(im)
        except Exception:
            mask = None

    # ---- รองขาว: polygon ทึบ (นอก+รูใน) หดเข้าในนิดหน่อย + เรียบ จุดน้อย ----
    white_pt = []
    _ppmm = W0 / W_mm
    if white_base and mask is not None:
        try:
            choke_px = max(0.0, white_choke_mm) * _ppmm
            simp = max(1.0, W0 / 900.0)
            for p in _fill_contours(mask, choke_px, simp,
                                    smooth_px=1.5*_ppmm, tol_px=0.5*_ppmm):
                white_pt.append([(x*sx, y*sy) for (x, y) in p])
        except Exception:
            white_pt = []

    # ---- เส้นไดคัท (เรียบ + จุดน้อย สำหรับพิมพ์ + ส่งเข้าเลเซอร์ตัด) ----
    cut_pt = []
    px_per_mm = W0 / W_mm
    if cut and mask is not None:
        try:
            bleed_px = max(0.0, bleed_mm) * px_per_mm
            if str(cut_mode) == "contour":
                # 🏭 ทรงกล่องไฟล้อมทรง — envelope เรียบมน ก้อนเดียว (เลเซอร์ตัดหน้าอะคริลิค)
                paths = _contour_wrap(mask, bleed_px, W0, H0)
            else:
                # ✂️ ไดคัทแนบตัวงาน (สติกเกอร์)
                smooth_px = 2.0 * px_per_mm
                tol_px = 0.5 * px_per_mm
                simp = max(1.0, W0 / 900.0)
                paths = _outer_contour(mask, bleed_px, simp, smooth_px=smooth_px, tol_px=tol_px)
            for p in paths:
                cut_pt.append([(x*sx, y*sy) for (x, y) in p])
        except Exception:
            cut_pt = []

    # ═══ ประกอบ PDF (ลำดับวาด = ลำดับเลเยอร์ ล่าง→บน) ═══
    doc = fitz.open()
    page = doc.new_page(width=Wp, height=Hp)

    # 1) รองขาว (ล่างสุด) — spot "White" · พิมพ์หมึกขาวก่อน แล้วค่อยพิมพ์สีทับ
    if white_pt:
        sh = page.new_shape()
        for p in white_pt:
            sh.draw_polyline(p + [p[0]])
        # เทสีขาว + ขอบขาวบาง ๆ (RIP แยกด้วยชื่อ separation "White")
        sh.finish(fill=(1, 1, 1), color=(1, 1, 1), width=0.1,
                  closePath=True, even_odd=True)
        sh.commit()

    # 2) ภาพสีต้นฉบับเต็มหน้า (raster ความละเอียดเต็ม = คุณภาพต้นฉบับ 100%)
    buf = io.BytesIO()
    (im if im.mode == "RGBA" else im.convert("RGB")).save(buf, "PNG")
    page.insert_image(fitz.Rect(0, 0, Wp, Hp), stream=buf.getvalue())

    # 3) เส้นไดคัท (บนสุด) — spot "CutContour" 0.25pt สีชมพูมาตรฐานโรงพิมพ์
    corner_r_pt = max(0.0, corner_r_mm) * MM
    if cut_pt:
        sh = page.new_shape()
        for p in cut_pt:
            if corner_r_pt > 0:
                seq = _round_path_pts(p, corner_r_pt)
                if seq:
                    sh.draw_polyline([seq[0][1]] + [s[-1] for s in seq]);
                else:
                    sh.draw_polyline(p + [p[0]])
            else:
                sh.draw_polyline(p + [p[0]])
        sh.finish(color=(0.93, 0.0, 0.55), width=0.25, closePath=True)
        sh.commit()

    layers = []
    if white_pt: layers.append("White (รองขาว)")
    layers.append("Artwork (ภาพสี)")
    if cut_pt:   layers.append("CutContour (ไดคัท)")

    pdf_bytes = doc.tobytes()
    doc.close()

    # ── เส้นไดคัทสำหรับ "เลเซอร์ตัดหลังพิมพ์" -> DXF + SVG (หน่วยมม. ขนาดจริง) ──
    #    (พิกัดเป็น pt อยู่แล้ว แปลงกลับเป็น มม. = /MM)
    cut_dxf_b64 = ""; cut_svg = ""
    if cut_pt:
        cut_mm = [[(x / MM, y / MM) for (x, y) in p] for p in cut_pt]
        try:
            cut_dxf_b64 = _cut_dxf(cut_mm)
        except Exception:
            cut_dxf_b64 = ""
        try:
            cut_svg = _cut_svg(cut_mm, W_mm, H_mm)
        except Exception:
            cut_svg = ""

    note = "ภาพฝังเต็มความละเอียด คุณภาพเท่าต้นฉบับ"
    if white_pt: note += " · มีเลเยอร์รองขาว (UV)"
    if cut_pt:   note += " · เส้นไดคัทเรียบ (พิมพ์ + เลเซอร์ตัด)"

    return pdf_bytes, {
        "w_mm": round(W_mm, 1), "h_mm": round(H_mm, 1),
        "img_px": [W0, H0],
        "cut_paths": len(cut_pt),
        "cut_points": sum(len(p) for p in cut_pt),   # จำนวนจุดรวม (ยิ่งน้อย = เครื่องตัดเร็ว)
        "white_paths": len(white_pt),
        "layers": layers,
        "cut_dxf_b64": cut_dxf_b64,                   # ↴ ส่งเข้าเลเซอร์ได้เลย
        "cut_svg": cut_svg,
        "mode": "print-embed",
        "note": note,
    }


def _cut_dxf(cut_mm):
    """เส้นไดคัท -> DXF (LWPOLYLINE ปิด, เลเยอร์ CutContour) หน่วยมม. · base64"""
    import ezdxf, io, base64
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4                       # 4 = มิลลิเมตร
    if "CutContour" not in doc.layers:
        doc.layers.add("CutContour", color=6)        # ม่วงชมพู = เส้นตัด (มาตรฐาน)
    msp = doc.modelspace()
    for p in cut_mm:
        if len(p) >= 3:
            msp.add_lwpolyline(p, close=True, dxfattribs={"layer": "CutContour"})
    s = io.StringIO(); doc.write(s)
    return base64.b64encode(s.getvalue().encode("utf-8")).decode()


def _cut_svg(cut_mm, w_mm, h_mm):
    """เส้นไดคัท -> SVG (หน่วยมม.) เส้นบางสีชมพู ไม่มีพื้น = เปิด LightBurn/Illustrator ตัดได้เลย"""
    d = ""
    for p in cut_mm:
        if len(p) < 3:
            continue
        d += "M %.2f %.2f " % p[0] + " ".join("L %.2f %.2f" % q for q in p[1:]) + " Z "
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" '
            'viewBox="0 0 %.1f %.1f">'
            '<path d="%s" fill="none" stroke="#ec008c" stroke-width="0.25"/></svg>'
            % (w_mm, h_mm, w_mm, h_mm, d.strip()))
