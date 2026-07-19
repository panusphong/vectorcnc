"""
imposition.py — งานพิมพ์ผลิตซ้ำ (Step-and-Repeat / Gang Run) สำหรับ UV print + Laser cut

ใช้กับงานพิมพ์ชิ้นเล็กจำนวนมาก (เช่น พวงกุญแจ 4 ซม. × 10,000 ชิ้น):
  1) วางชิ้นเดียวกันซ้ำเต็มแผ่นอะคริลิค (วางมากสุดอัตโนมัติ)
  2) ได้ไฟล์พิมพ์ UV (ทั้งแผ่น) + ไฟล์ตัดเลเซอร์ (เส้นตัดทุกชิ้น ตรงตำแหน่งที่พิมพ์)
  3) หมุดพิมพ์-ตัด (registration) 2 แบบ:
       - ccd    : ใส่หมุดกลม 4 มุม (พิมพ์ลงแผ่น) ให้กล้อง CCD ของเลเซอร์อ่านแล้วตัดตรง
       - origin : ไม่มีหมุด — จัดแผ่นชนมุม (0,0) แล้วตัดตามพิกัด DXF

หน่วยทั้งหมด = มิลลิเมตร
พิกัดชิ้น (cut_mm จาก print_ai): origin ซ้ายบนของชิ้น, y ชี้ลง (แบบรูปภาพ/SVG)
"""

import io
import base64
import math

MM = 72.0 / 25.4          # มม. -> จุด PDF


# ───────────────────────────── วางกริด (วางมากสุด) ─────────────────────────────
def plan_grid(piece_w, piece_h, sheet_w, sheet_h, gap=3.0, margin=8.0, allow_rotate=True):
    """คำนวณจำนวนชิ้นต่อแผ่น (ลองหมุน 90° เลือกแบบที่ได้เยอะกว่า)
       คืน: cols, rows, per_sheet, rot, pw, ph (pw/ph = ขนาดชิ้นหลังหมุน)"""
    def _count(pw, ph):
        uw = sheet_w - 2 * margin
        uh = sheet_h - 2 * margin
        if pw <= 0 or ph <= 0 or uw <= 0 or uh <= 0:
            return (0, 0, 0)
        cols = int((uw + gap) // (pw + gap))
        rows = int((uh + gap) // (ph + gap))
        return (max(0, cols), max(0, rows), max(0, cols) * max(0, rows))

    a = _count(piece_w, piece_h)
    b = _count(piece_h, piece_w) if allow_rotate else (0, 0, 0)
    if b[2] > a[2]:
        return {"cols": b[0], "rows": b[1], "per": b[2], "rot": True,
                "pw": piece_h, "ph": piece_w}
    return {"cols": a[0], "rows": a[1], "per": a[2], "rot": False,
            "pw": piece_w, "ph": piece_h}


def positions(plan, sheet_w, sheet_h, gap):
    """ตำแหน่งมุมซ้ายบนของแต่ละชิ้น (มม. · origin ซ้ายบนของแผ่น y ลง) — จัดกึ่งกลางแผ่น"""
    cols, rows, pw, ph = plan["cols"], plan["rows"], plan["pw"], plan["ph"]
    block_w = cols * pw + (cols - 1) * gap if cols else 0
    block_h = rows * ph + (rows - 1) * gap if rows else 0
    x0 = (sheet_w - block_w) / 2.0
    y0 = (sheet_h - block_h) / 2.0
    out = []
    for r in range(rows):
        for c in range(cols):
            out.append((x0 + c * (pw + gap), y0 + r * (ph + gap)))
    return out


# ───────────────────────────── หมุด registration ─────────────────────────────
def reg_marks(sheet_w, sheet_h, inset=10.0, r=3.0):
    """หมุดกลม 4 มุม (มม. · origin ซ้ายบน y ลง) — พิมพ์ลงแผ่น + ใส่ในไฟล์ตัด"""
    return [
        {"x": inset, "y": inset, "r": r},
        {"x": sheet_w - inset, "y": inset, "r": r},
        {"x": inset, "y": sheet_h - inset, "r": r},
        {"x": sheet_w - inset, "y": sheet_h - inset, "r": r},
    ]


# ───────────────────────────── ไฟล์พิมพ์ UV (ทั้งแผ่น) ─────────────────────────────
def build_print_pdf(piece_pdf_bytes, plan, pos, sheet_w, sheet_h,
                    reg_mode="ccd", marks=None):
    """วางชิ้นเดียว (PDF) ซ้ำทั้งแผ่นด้วย show_pdf_page (ใช้ XObject ซ้ำ = ไฟล์เล็ก)
       + พิมพ์หมุด 4 มุม (โหมด ccd) · คืน PDF bytes"""
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=sheet_w * MM, height=sheet_h * MM)
    src = fitz.open("pdf", piece_pdf_bytes)
    pw, ph = plan["pw"], plan["ph"]
    rot = 90 if plan.get("rot") else 0
    aw0, ah0 = src[0].rect.width, src[0].rect.height          # ขนาดรูปงาน (pt)
    aw, ah = (ah0, aw0) if rot else (aw0, ah0)                # สลับถ้าหมุน
    for (x, y) in pos:
        cell = fitz.Rect(x * MM, y * MM, (x + pw) * MM, (y + ph) * MM)
        # 🎯 วางรูปงาน "กึ่งกลางชิ้น" คงสัดส่วน (ไม่ยืด) ให้เห็น artwork ชัดเจน
        if aw > 0 and ah > 0:
            s = min(cell.width / aw, cell.height / ah)
            dw, dh = aw * s, ah * s
            cx, cy = (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2
            rect = fitz.Rect(cx - dw / 2, cy - dh / 2, cx + dw / 2, cy + dh / 2)
        else:
            rect = cell
        try:
            page.show_pdf_page(rect, src, 0, rotate=rot)
        except Exception:
            page.show_pdf_page(rect, src, 0)
    if reg_mode == "ccd":
        for m in (marks or reg_marks(sheet_w, sheet_h)):
            c = fitz.Point(m["x"] * MM, m["y"] * MM)
            page.draw_circle(c, m["r"] * MM, color=(0, 0, 0), fill=(0, 0, 0))
    return doc.tobytes()


# ───────────────────────────── ไฟล์ตัดเลเซอร์ (ทั้งแผ่น) ─────────────────────────────
def _placed_polys(plan, pos, sheet_h):
    """คืน [(x_left,y_top, [poly ของชิ้น (มม. origin ชิ้น y ลง)])...] แปลงเป็นพิกัด CAD y-up
       piece cut = plan['cut'] (list ของ polygon, มม., origin ซ้ายบนชิ้น, y ลง)"""
    cut = plan["cut"]; rot = plan.get("rot")
    pw0, ph0 = plan["pw"], plan["ph"]
    out = []
    for (x, y) in pos:
        polys = []
        for poly in cut:
            pts = []
            for (px, py) in poly:
                if rot:                       # หมุน 90° CW: (px,py) ในชิ้นเดิม -> (ph_orig? ) ใช้สลับ
                    rx, ry = (ph0 - py), px   # หมุนให้พอดีกรอบ pw×ph หลังหมุน
                else:
                    rx, ry = px, py
                sx = x + rx                   # พิกัดบนแผ่น (origin ซ้ายบน y ลง)
                sy = y + ry
                pts.append((sx, sheet_h - sy))  # -> CAD y-up (origin ซ้ายล่าง)
            if len(pts) >= 3:
                polys.append(pts)
        out.append(polys)
    return out


def build_cut_dxf(plan, pos, sheet_w, sheet_h, reg_mode="ccd", marks=None):
    """ไฟล์ตัด DXF (มม. · y-up) — เลเยอร์ CutContour + Registration + Sheet"""
    import ezdxf
    doc = ezdxf.new(); doc.header["$INSUNITS"] = 4         # มม.
    for name, col in (("CutContour", 6), ("Registration", 1), ("Sheet", 8)):
        if name not in doc.layers:
            doc.layers.add(name, color=col)
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (sheet_w, 0), (sheet_w, sheet_h), (0, sheet_h)],
                       close=True, dxfattribs={"layer": "Sheet"})
    for polys in _placed_polys(plan, pos, sheet_h):
        for p in polys:
            msp.add_lwpolyline(p, close=True, dxfattribs={"layer": "CutContour"})
    if reg_mode == "ccd":
        for m in (marks or reg_marks(sheet_w, sheet_h)):
            msp.add_circle((m["x"], sheet_h - m["y"]), m["r"],
                           dxfattribs={"layer": "Registration"})
    s = io.StringIO(); doc.write(s)
    return base64.b64encode(s.getvalue().encode("utf-8")).decode()


def build_cut_svg(plan, pos, sheet_w, sheet_h, reg_mode="ccd", marks=None):
    """ไฟล์ตัด SVG (มม. · origin ซ้ายบน y ลง เพื่อเปิดดู/LightBurn) — เส้นตัดชมพู + หมุดดำ"""
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" '
             'viewBox="0 0 %.1f %.1f">' % (sheet_w, sheet_h, sheet_w, sheet_h)]
    parts.append('<rect x="0" y="0" width="%.1f" height="%.1f" fill="none" '
                 'stroke="#94a3b8" stroke-width="0.4"/>' % (sheet_w, sheet_h))
    rot = plan.get("rot"); pw0, ph0 = plan["pw"], plan["ph"]
    d = ""
    for (x, y) in pos:
        for poly in plan["cut"]:
            pts = []
            for (px, py) in poly:
                rx, ry = ((ph0 - py), px) if rot else (px, py)
                pts.append((x + rx, y + ry))
            if len(pts) >= 3:
                d += "M %.2f %.2f " % pts[0] + " ".join("L %.2f %.2f" % q for q in pts[1:]) + " Z "
    parts.append('<path d="%s" fill="none" stroke="#ec008c" stroke-width="0.25"/>' % d.strip())
    if reg_mode == "ccd":
        for m in (marks or reg_marks(sheet_w, sheet_h)):
            parts.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="#000"/>'
                         % (m["x"], m["y"], m["r"]))
    parts.append("</svg>")
    return "".join(parts)


# ───────────────────────────── พรีวิว (ภาพย่อทั้งแผ่น) ─────────────────────────────
def preview_svg(plan, pos, sheet_w, sheet_h, reg_mode="ccd", marks=None, art_href=""):
    """พรีวิวทั้งแผ่น — กรอบชิ้น + รูปงาน (ถ้ามี) + หมุด · ไว้โชว์ใน UI"""
    W = 900.0; sc = W / sheet_w; H = sheet_h * sc
    pw, ph = plan["pw"], plan["ph"]
    rw, rh = pw * sc, ph * sc
    p = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
         'style="width:100%%;height:auto;display:block" viewBox="0 0 %.0f %.0f">' % (W, H)]
    # ฝังรูปงาน "ครั้งเดียว" ใน <defs> แล้วอ้างอิงซ้ำด้วย <use> (กันไฟล์บวมเป็น GB)
    if art_href:
        p.append('<defs><image id="pcimg" href="%s" xlink:href="%s" width="%.2f" height="%.2f" '
                 'preserveAspectRatio="xMidYMid meet"/></defs>' % (art_href, art_href, rw, rh))
    p.append('<rect x="0" y="0" width="%.1f" height="%.1f" fill="#fff" stroke="#334155" stroke-width="1.5"/>'
             % (W, H))
    for (x, y) in pos:
        rx, ry = x * sc, y * sc
        if art_href:
            p.append('<use href="#pcimg" xlink:href="#pcimg" x="%.1f" y="%.1f"/>' % (rx, ry))
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" '
                 'stroke="#ec008c" stroke-width="0.7"/>' % (rx, ry, rw, rh))
    if reg_mode == "ccd":
        for m in (marks or reg_marks(sheet_w, sheet_h)):
            p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#000"/>'
                     % (m["x"] * sc, m["y"] * sc, max(2.0, m["r"] * sc)))
    p.append("</svg>")
    return "".join(p)


# ───────────────────────────── สรุปจำนวนแผ่น ─────────────────────────────
def summarize(per_sheet, total_qty):
    """คำนวณจำนวนแผ่นที่ต้องใช้สำหรับทั้งออเดอร์"""
    per_sheet = max(0, int(per_sheet)); total_qty = max(0, int(total_qty))
    if per_sheet <= 0:
        return {"per_sheet": 0, "sheets": 0, "last_sheet": 0, "made": 0, "over": 0}
    sheets = int(math.ceil(total_qty / per_sheet)) if total_qty else 0
    made = sheets * per_sheet
    last = total_qty - (sheets - 1) * per_sheet if sheets else 0
    return {"per_sheet": per_sheet, "sheets": sheets,
            "last_sheet": last, "made": made, "over": made - total_qty}
