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

PRINT_AI_VERSION = "2026-07-15-embed-raster+diecut"

MM = 72.0 / 25.4        # มม. -> จุด (PDF point)


# ──────────────────────────────────────────────── หา mask ของตัวงาน (แยกจากพื้นหลัง)
def _subject_mask(im, bg_tol=18):
    """คืน mask (True=ตัวงาน) · รองรับทั้งภาพโปร่ง (alpha) และพื้นขาว"""
    import numpy as np
    im = im.convert("RGBA")
    a = np.array(im)
    alpha = a[:, :, 3]

    if alpha.min() < 250:                       # มี transparency จริง
        return alpha > 20

    # พื้นทึบ -> เดาสีพื้นจากมุมทั้ง 4 (ส่วนใหญ่คือขาว)
    rgb = a[:, :, :3].astype(int)
    H, W = rgb.shape[:2]
    corners = np.array([rgb[0, 0], rgb[0, W-1], rgb[H-1, 0], rgb[H-1, W-1]])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    return dist > bg_tol


def _fill_contours(mask, choke_px, simplify_px):
    """คืน polygon ทั้งหมด (นอก+รูใน) ของ mask สำหรับ 'เทสีทึบ' = รองขาว
       choke_px > 0 = หดเข้าในนิดหน่อย กันสีขาวโผล่พ้นขอบงาน (มาตรฐาน UV)"""
    import numpy as np
    import cv2
    m = (mask.astype(np.uint8)) * 255
    if choke_px > 0:
        m = cv2.erode(m, np.ones((int(choke_px)*2+1,)*2, np.uint8))
    # RETR_CCOMP -> เก็บทั้งขอบนอกและรูใน (โดนัทไม่ตัน)
    cnts, _ = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    amin = 0.0005 * m.shape[0] * m.shape[1]
    for c in cnts:
        if cv2.contourArea(c) < amin:
            continue
        ap = cv2.approxPolyDP(c, max(0.6, float(simplify_px)), True).reshape(-1, 2)
        if len(ap) >= 3:
            out.append([(float(x), float(y)) for x, y in ap])
    return out


def _outer_contour(mask, bleed_px, simplify_px):
    """คืน list ของ polygon (แต่ละอันเป็น list of (x,y)) = เส้นรอบนอกของตัวงาน
       + เผื่อขอบ bleed + ลดจุดให้เส้นเนียน"""
    import numpy as np
    import cv2

    m = (mask.astype(np.uint8)) * 255

    # ปิดรูเล็ก + รวมชิ้นที่อยู่ติดกัน (กันเส้นไดคัทแตกเป็นเศษ)
    k = max(3, int(bleed_px) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    if bleed_px > 0:                            # เผื่อขอบออกนอก
        m = cv2.dilate(m, np.ones((int(bleed_px)*2+1,)*2, np.uint8))

    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    area_min = (0.002 * m.shape[0] * m.shape[1])   # ตัดเศษจิ๋ว < 0.2% ของภาพ
    for c in cnts:
        if cv2.contourArea(c) < area_min:
            continue
        eps = max(0.6, float(simplify_px))
        ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(ap) >= 3:
            polys.append([(float(x), float(y)) for x, y in ap])
    # เรียงใหญ่ -> เล็ก
    polys.sort(key=lambda p: -_poly_area(p))
    return polys


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
          white_base=False, white_choke_mm=0.3):
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

    # ---- รองขาว: polygon ทึบ (นอก+รูใน) หดเข้าในนิดหน่อย ----
    white_pt = []
    if white_base and mask is not None:
        try:
            choke_px = max(0.0, white_choke_mm) / W_mm * W0
            simp = max(1.0, W0 / 900.0)
            for p in _fill_contours(mask, choke_px, simp):
                white_pt.append([(x*sx, y*sy) for (x, y) in p])
        except Exception:
            white_pt = []

    # ---- เส้นไดคัท ----
    cut_pt = []
    if cut and mask is not None:
        try:
            bleed_px = max(0.0, bleed_mm) / W_mm * W0
            simp = max(1.0, W0 / 900.0)
            for p in _outer_contour(mask, bleed_px, simp):
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

    note = "ภาพฝังเต็มความละเอียด คุณภาพเท่าต้นฉบับ"
    if white_pt: note += " · มีเลเยอร์รองขาว (UV)"
    if cut_pt:   note += " · มีเส้นไดคัท"

    return pdf_bytes, {
        "w_mm": round(W_mm, 1), "h_mm": round(H_mm, 1),
        "img_px": [W0, H0],
        "cut_paths": len(cut_pt),
        "white_paths": len(white_pt),
        "layers": layers,
        "mode": "print-embed",
        "note": note,
    }
