# -*- coding: utf-8 -*-
"""📐 ไฟล์ที่ "เป็นเวกเตอร์อยู่แล้ว" — อ่านเส้นจริง ไม่ไล่เส้นใหม่

⚠️ ทำไมต้องแยกทางกับเครื่องแปลงภาพ:
   เครื่องแปลงภาพทำงานโดย 'ไล่หาขอบจากเม็ดพิกเซล' ซึ่งเหมาะกับ JPG/PNG
   แต่ .svg .ai .pdf .eps **มีเส้นโค้งจริงเก็บอยู่ในไฟล์แล้ว**
   ถ้าเอาเข้าเครื่องแปลงภาพ ต้องเรนเดอร์เป็นพิกเซลก่อนแล้วค่อยไล่เส้นใหม่
   = เอาของที่คมอยู่แล้วไปทำให้แย่ลง แถมช้ากว่าหลายเท่า

✅ ทางนี้อ่าน path จริงออกมาตรง ๆ แล้วส่งต่อให้ตัวเขียนไฟล์ชุดเดียวกัน
   ได้ SVG / PDF / EPS / DXF / PNG โดย **ไม่เสียความคมแม้แต่นิดเดียว**

วิธีอ่าน: แปลงทุกนามสกุลให้เป็น PDF ก่อน แล้วดึงเส้นด้วย PyMuPDF
   • .svg          -> cairosvg แปลงเป็น PDF (จัดการ transform/group/style ให้ครบ)
   • .pdf / .ai    -> ใช้ได้เลย (.ai สมัยใหม่คือ PDF อยู่แล้ว)
   • .eps / .ps    -> ghostscript แปลงเป็น PDF
   ทำแบบนี้ทางเดียวเหมือนกันหมด ได้ทั้ง 'พิกัดที่ผ่าน transform แล้ว' และ 'สีจริงของแต่ละรูป'
   (เคยลองอ่าน SVG ตรง ๆ ด้วย svgpathtools แล้วได้พิกัดดิบที่ยังไม่คิด transform
    กับไม่มีสีติดมาด้วย — ใช้กับงานจริงไม่ได้)
"""

import math
import os
import subprocess
import tempfile

VEC_EXT = (".svg", ".ai", ".pdf", ".eps", ".ps")
PT_PER_MM = 72.0 / 25.4          # 1 มม. = 2.8346 pt   (ไฟล์เวกเตอร์นับเป็น pt)


def is_vector(name="", raw=b""):
    """ดูจากนามสกุลก่อน · ถ้าไม่มีนามสกุลก็ดมหัวไฟล์เอา (ผู้ใช้เปลี่ยนชื่อไฟล์กันบ่อย)"""
    if os.path.splitext(str(name))[1].lower() in VEC_EXT:
        return True
    h = bytes(raw[:1024]).lstrip()[:400].lower()
    return h.startswith(b"%pdf-") or h.startswith(b"%!ps") or b"<svg" in h


def _to_pdf(raw, name=""):
    ext = os.path.splitext(str(name))[1].lower()
    head = bytes(raw[:400]).lstrip().lower()
    if head.startswith(b"%pdf-"):
        return bytes(raw)                              # .pdf และ .ai ยุคใหม่
    if ext == ".svg" or b"<svg" in head:
        import cairosvg
        return cairosvg.svg2pdf(bytestring=bytes(raw))
    # เหลือ PostScript ล้วน (.eps/.ps/.ai รุ่นเก่า) -> ต้องพึ่ง ghostscript
    src = tempfile.mktemp(suffix=ext or ".eps")
    out = tempfile.mktemp(suffix=".pdf")
    with open(src, "wb") as f:
        f.write(bytes(raw))
    try:
        subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dEPSCrop",
                        "-sDEVICE=pdfwrite", "-o", out, src],
                       check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out, "rb") as f:
            return f.read()
    except FileNotFoundError:
        raise ValueError("ไฟล์ .eps/.ps ต้องใช้ ghostscript ในการอ่าน แต่เครื่องนี้ไม่ได้ติดตั้งไว้ "
                         "— กรุณาบันทึกเป็น .pdf หรือ .svg แล้วอัปโหลดใหม่")
    except Exception:
        raise ValueError("อ่านไฟล์ .eps/.ps นี้ไม่ได้ — กรุณาบันทึกเป็น .pdf หรือ .svg แล้วอัปโหลดใหม่")
    finally:
        for p in (src, out):
            try:
                os.remove(p)
            except Exception:
                pass


def _rgb(v, default=None):
    """สีจาก PyMuPDF มาเป็นทศนิยม 0-1 สามช่อง"""
    if not v:
        return default
    try:
        return tuple(int(round(max(0.0, min(1.0, float(c))) * 255)) for c in tuple(v)[:3])
    except Exception:
        return default


def _pts_of(items, closed):
    """แปลงชิ้นส่วนเส้นจาก PyMuPDF -> รูปแบบเดียวกับที่เครื่องแปลงภาพใช้"""
    out = []                                            # [(start, segs), ...]
    cur = None
    for it in items:
        op = it[0]
        if op == "l":
            a = (it[1].x, it[1].y); b = (it[2].x, it[2].y)
            if cur is None or _far(cur[1][-1][-1] if cur[1] else cur[0], a):
                if cur:
                    out.append(cur)
                cur = (a, [])
            cur[1].append(("L", b))
        elif op == "c":
            a = (it[1].x, it[1].y)
            c1 = (it[2].x, it[2].y); c2 = (it[3].x, it[3].y); e = (it[4].x, it[4].y)
            if cur is None or _far(cur[1][-1][-1] if cur[1] else cur[0], a):
                if cur:
                    out.append(cur)
                cur = (a, [])
            cur[1].append(("C", c1, c2, e))
        elif op in ("re", "qu"):
            if cur:
                out.append(cur); cur = None
            if op == "re":
                r = it[1]
                q = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
            else:
                z = it[1]
                q = [(z.ul.x, z.ul.y), (z.ur.x, z.ur.y), (z.lr.x, z.lr.y), (z.ll.x, z.ll.y)]
            out.append((q[0], [("L", p) for p in q[1:]] + [("L", q[0])]))
    if cur:
        out.append(cur)
    return out


def _far(a, b, eps=1e-6):
    return abs(a[0] - b[0]) > eps or abs(a[1] - b[1]) > eps


def _flat(start, segs, n=10):
    pts = [tuple(start)]
    for s in segs:
        if s[0] == "L":
            pts.append(tuple(s[1])); continue
        p0 = pts[-1]; c1, c2, p3 = s[1], s[2], s[3]
        for i in range(1, n + 1):
            t = i / float(n); m = 1.0 - t
            pts.append((m**3 * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t**3 * p3[0],
                        m**3 * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t**3 * p3[1]))
    return pts


def _area(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]; x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return 0.5 * a


def _stroke_to_fill(start, segs, w):
    """เส้นที่มีแต่ 'เส้นขอบ' ไม่มีสีถม -> เปลี่ยนเป็นรูปทึบตามความหนาเส้น

    ทำไม: ไฟล์ผลลัพธ์ของเราเก็บเป็น 'รูปทึบ' อย่างเดียว (เข้าเครื่องตัดง่ายกว่า)
    ถ้าปล่อยเส้นขอบไว้เฉย ๆ มันจะหายไปจากผลลัพธ์ทั้งเส้น
    """
    try:
        from shapely.geometry import LineString
        g = LineString(_flat(start, segs, 8)).buffer(max(float(w), 0.1) / 2.0,
                                                     resolution=6, cap_style=2, join_style=1)
        if g.is_empty:
            return []
        gs = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
        return [("P", [(float(x), float(y)) for x, y in p.exterior.coords]) for p in gs]
    except Exception:
        return []


def read_vector(raw, name="", max_paths=40000):
    """อ่านไฟล์เวกเตอร์ -> โครงสร้างเดียวกับผลลัพธ์ของเครื่องแปลงภาพ

    คืน dict: layers · size · bg · stats   (ตัวเขียนไฟล์ทุกนามสกุลใช้ได้เลยโดยไม่ต้องแก้)
    """
    import time
    t0 = time.time()
    import fitz

    pdf = _to_pdf(raw, name)
    doc = fitz.open("pdf", pdf)
    if doc.page_count < 1:
        raise ValueError("ไฟล์นี้ไม่มีหน้าให้อ่าน")
    page = doc[0]
    R = page.rect
    W, H = float(R.width), float(R.height)
    if W <= 1 or H <= 1:
        raise ValueError("ขนาดหน้ากระดาษในไฟล์ผิดปกติ (%.1f × %.1f)" % (W, H))

    try:
        draws = page.get_drawings()
    except Exception:
        draws = []

    groups = {}                 # สี -> [items]
    order = []
    n_fill = n_stroke = 0
    for dr in draws:
        if not isinstance(dr, dict):
            continue
        fill = _rgb(dr.get("fill"))
        strk = _rgb(dr.get("color"))
        subs = _pts_of(dr.get("items", []), bool(dr.get("closePath")))
        if not subs:
            continue
        if fill is not None:
            col = fill; n_fill += 1
            items = [("B", (float(s[0][0] - R.x0), float(s[0][1] - R.y0)),
                      [_shift(g, R.x0, R.y0) for g in s[1]]) for s in subs if s[1]]
        elif strk is not None:
            col = strk; n_stroke += 1
            wid = float(dr.get("width") or 1.0)
            items = []
            for s in subs:
                for it in _stroke_to_fill(s[0], s[1], wid):
                    items.append(("P", [(x - R.x0, y - R.y0) for x, y in it[1]]))
        else:
            continue
        if not items:
            continue
        # ⚠️ ห้ามรวมทุกอย่างที่สีเดียวกันเข้าด้วยกันข้ามลำดับ!
        #    เคสจริง (โลโก้ YN smile): มีของสีขาวถูกวาดไว้ 'ก่อน' พื้นหลัง และมี 'ฟันขาว'
        #    ถูกวาดทีหลังพื้นหลัง — พอรวมสีขาวเป็นก้อนเดียว ทั้งก้อนถูกยกไปไว้ตำแหน่งแรก
        #    แล้วสี่เหลี่ยมพื้นหลังก็ทับฟันหายทั้งตัว (เห็นชัดตอนเรนเดอร์เทียบ)
        # ✅ รวมเฉพาะที่สีเดียวกันและ 'ติดกันตามลำดับ' เท่านั้น — ลำดับหน้า-หลังจึงตรงกับไฟล์เป๊ะ
        if order and order[-1] == col:
            groups[len(order) - 1].extend(items)
        else:
            order.append(col); groups[len(order) - 1] = list(items)
        if sum(len(v) for v in groups.values()) > int(max_paths):
            break

    if not groups:
        raise ValueError("ไม่พบรูปทรงเวกเตอร์ในไฟล์นี้ — ถ้าเป็นไฟล์ที่ฝังภาพถ่ายไว้ข้างใน "
                         "ให้ส่งออกเป็น JPG/PNG แล้วใช้เมนูแปลงภาพแทน")

    layers = []
    for li, col in enumerate(order):
        its = groups[li]
        area = 0.0
        for it in its:
            pts = it[1] if it[0] == "P" else _flat(it[1], it[2], 6)
            area += abs(_area(pts))
        layers.append({"rgb": tuple(col), "n": len(its), "area": area, "items": its})
    # 🚫 ห้ามเรียงตามขนาด! — ต่างจากงานไล่เส้นจากภาพ
    #    ไฟล์เวกเตอร์มี 'ลำดับการวางทับ' ของมันเองอยู่แล้ว (อะไรอยู่หน้า อะไรอยู่หลัง)
    #    ถ้าเรียงใหม่ตามพื้นที่ ของที่ควรอยู่หน้าจะถูกดันไปอยู่หลัง
    #    เคสจริง (โลโก้ YN smile): ฟันขาวมีพื้นที่รวม 2.39 ล้าน มากกว่าสี่เหลี่ยมพื้นหลัง 2.25 ล้าน
    #    พอเรียงตามขนาด ฟันเลยถูกวาดก่อนแล้วโดนพื้นหลังทับจนหายทั้งตัว
    #    ✅ คงลำดับตามไฟล์เสมอ (PyMuPDF คืนมาจากล่างขึ้นบนอยู่แล้ว)

    nodes = sum(len(it[2]) if it[0] == "B" else len(it[1]) for L in layers for it in L["items"])
    stats = {
        "source": "vector",                       # 👈 ฝั่งหน้าจอใช้ตัวนี้ตัดสินว่าจะบอกผู้ใช้ว่าอะไร
        "traced": False,                          #    ไม่ได้ไล่เส้นใหม่ = ไม่มีการเสียความคม
        "colors": len(layers), "shapes": sum(len(L["items"]) for L in layers),
        "nodes": int(nodes), "work_px": [int(math.ceil(W)), int(math.ceil(H))],
        "scale": 1.0, "full_res": True, "downscaled": None, "resized": False,
        "fills": n_fill, "strokes": n_stroke,
        "pt_size": [round(W, 2), round(H, 2)],
        "mm_size": [round(W / PT_PER_MM, 2), round(H / PT_PER_MM, 2)],
        "mm_per_px": round(1.0 / PT_PER_MM, 6),   # ทำให้ DXF ออกมาขนาดจริงตามไฟล์ต้นฉบับ
        "seconds": round(time.time() - t0, 3),
        "ext": os.path.splitext(str(name))[1].lower() or "?",
    }
    return {"layers": layers, "size": (int(math.ceil(W)), int(math.ceil(H))),
            "bg": None, "stats": stats}


def _shift(g, dx, dy):
    if g[0] == "L":
        return ("L", (g[1][0] - dx, g[1][1] - dy))
    return ("C", (g[1][0] - dx, g[1][1] - dy), (g[2][0] - dx, g[2][1] - dy),
            (g[3][0] - dx, g[3][1] - dy))


# ══════════════════════════════════════════════════════════════════
# 🧩 แยก "ชิ้นงาน" ออกจากไฟล์ — สำหรับหน้าออกแบบป้าย
#
# ⚠️ ปัญหาจากงานจริง (ไฟล์ลูกค้า YN smile · 2026-08-09):
#    ระบบเดิมหาขอบป้ายจาก **ความต่างของสีในภาพ** ซึ่งพังสองชั้นกับไฟล์แบบนี้
#      1) มีสี่เหลี่ยมพื้นหลังคลุมทั้งใบ -> จับได้แค่กรอบสี่เหลี่ยม ไม่ใช่ตัวงาน
#      2) โลโก้รูปฟันเป็น **สีขาวบนพื้นขาว** -> ไม่มีความต่างสีให้จับเลย
# ✅ ไฟล์เวกเตอร์เก็บ 'เส้นขอบของฟัน' ไว้ครบอยู่แล้ว — สีไม่เกี่ยวเลย
#    อ่าน path จริงออกมาเป็นชิ้น ๆ ปัญหาทั้งสองข้อหายไปพร้อมกัน
#    แล้วให้ผู้ใช้ **จิ้มเลือกเองว่าจะเอาชิ้นไหนไปตัด** ไม่ใช่บังคับเป็นกรอบสี่เหลี่ยม
# ══════════════════════════════════════════════════════════════════
def _poly(item, n=12):
    from shapely.geometry import Polygon
    pts = item[1] if item[0] == "P" else _flat(item[1], item[2], n)
    if len(pts) < 3:
        return None
    try:
        g = Polygon(pts)
        if not g.is_valid:
            g = g.buffer(0)
        return g if (not g.is_empty and g.area > 1e-9) else None
    except Exception:
        return None


def _nest(polys):
    """จัดชั้นในชั้นนอก — วงที่อยู่ในวงอื่นจำนวน 'คี่' ชั้น คือรู (คิ้วตัว e, a, ช่องตัว O)"""
    from shapely.geometry import Polygon
    idx = sorted(range(len(polys)), key=lambda i: -polys[i].area)
    depth = [0] * len(polys)
    parent = [-1] * len(polys)
    for a in range(len(idx)):
        i = idx[a]
        rep = polys[i].representative_point()
        for b in range(a):
            j = idx[b]
            if polys[j].contains(rep):
                parent[i] = j                       # พ่อคือวงที่เล็กที่สุดที่ยังคลุมอยู่
        if parent[i] >= 0:
            depth[i] = depth[parent[i]] + 1
    out = []
    for i in range(len(polys)):
        if depth[i] % 2 == 1:
            continue                                 # เป็นรู เดี๋ยวไปเจาะให้พ่อ
        holes = [polys[j] for j in range(len(polys)) if parent[j] == i and depth[j] % 2 == 1]
        g = polys[i]
        for h in holes:
            try:
                g = g.difference(h)
            except Exception:
                pass
        if not g.is_empty and g.area > 1e-9:
            out.append(g)
    return out


def _d_of_poly(g, prec=2):
    """shapely -> เส้น d ของ SVG (มีรูด้วย ใช้ fill-rule evenodd)"""
    def ring(c):
        pts = list(c)
        return ("M " + " L ".join("%.*f %.*f" % (prec, x, prec, y) for x, y in pts) + " Z")
    gs = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    d = []
    for p in gs:
        d.append(ring(p.exterior.coords))
        for r in p.interiors:
            d.append(ring(r.coords))
    return " ".join(d)


def pieces(raw, name="", real_width_mm=0.0, bg_cover=0.82, min_frac=2e-5):
    """แตกไฟล์เวกเตอร์เป็น "ชิ้น" ที่เลือกได้ทีละชิ้น

    คืน dict: pieces[] · size · mm_per_unit · stats
      แต่ละชิ้น: id · rgb · d (เส้นสำหรับวาดบนหน้าจอ) · bbox · w_mm · h_mm · area_mm2
                 kind = "bg" (พื้นหลัง ปิดไว้ก่อน) หรือ "shape"
    """
    res = read_vector(raw, name)
    W, H = res["size"]
    page = float(W) * float(H)
    mmpu = (float(real_width_mm) / float(W)) if real_width_mm else (1.0 / PT_PER_MM)
    out = []
    for L in res["layers"]:
        polys = [g for g in (_poly(it) for it in L["items"]) if g is not None]
        if not polys:
            continue
        for g in _nest(polys):
            if g.area < page * float(min_frac):
                continue                              # เศษจิ๋ว ไม่ใช่ชิ้นงาน
            x0, y0, x1, y1 = g.bounds
            cover = ((x1 - x0) * (y1 - y0)) / max(page, 1e-9)
            boxy = g.area / max((x1 - x0) * (y1 - y0), 1e-9)     # เต็มกรอบแค่ไหน (1.0 = สี่เหลี่ยม)
            # 🎯 พื้นหลัง = สี่เหลี่ยมเกือบเต็มหน้า · ต้องเข้าทั้งสองเงื่อนไข
            #    (ถ้าดูแค่ 'ใหญ่' อย่างเดียว ตัวอักษรยาว ๆ ที่กว้างเกือบเต็มหน้าจะโดนตัดทิ้งด้วย)
            kind = "bg" if (cover >= float(bg_cover) and boxy >= 0.9) else "shape"
            out.append({"rgb": tuple(L["rgb"]), "d": _d_of_poly(g),
                        "bbox": [round(v, 2) for v in (x0, y0, x1, y1)],
                        "w_mm": round((x1 - x0) * mmpu, 2), "h_mm": round((y1 - y0) * mmpu, 2),
                        "area_mm2": round(g.area * mmpu * mmpu, 2),
                        "holes": sum(len(p.interiors) for p in
                                     (g.geoms if g.geom_type == "MultiPolygon" else [g])),
                        "kind": kind})
    out.sort(key=lambda p: -p["area_mm2"])
    for i, p in enumerate(out):
        p["id"] = "s%d" % (i + 1)
    st = dict(res["stats"])
    st.update({"pieces": len(out), "bg_pieces": sum(1 for p in out if p["kind"] == "bg")})
    return {"pieces": out, "size": [W, H], "mm_per_unit": mmpu,
            "mm_size": [round(W * mmpu, 2), round(H * mmpu, 2)], "stats": st}


# ══════════════════════════════════════════════════════════════════
# 🏗️ สร้างงานจริงจากชิ้นที่ผู้ใช้เลือก
#    A) ไดคัทแยกชิ้น  — แต่ละชิ้น = 1 ชิ้นตัด (เก็บรูข้างในครบ)
#    B) กล่องไฟล้อมทรง — รวมชิ้นแล้วขยายออกเป็นขอบซิงค์
#       ทรงที่เลือกได้: สี่เหลี่ยม · ล้อมตามทรง · ผสม
#       "ผสม" คือแบบที่ใบสั่งงานจริงใช้: ฝั่งที่เป็นตัวหนังสือเป็นสี่เหลี่ยมตรง
#       ส่วนชิ้นที่ยื่นออกมา (รูปฟัน) ให้ขอบอ้อมตามทรงของมัน
# ══════════════════════════════════════════════════════════════════
def _from_d(d):
    """เส้น d ที่เราเขียนเอง (M..L..Z ล้วน) -> shapely"""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    rings = []
    for chunk in d.split("M"):
        chunk = chunk.strip().rstrip("Z").strip()
        if not chunk:
            continue
        nums = [float(v) for v in chunk.replace("L", " ").split()]
        pts = list(zip(nums[0::2], nums[1::2]))
        if len(pts) >= 3:
            rings.append(Polygon(pts).buffer(0))
    if not rings:
        return None
    rings.sort(key=lambda g: -g.area)
    g = rings[0]
    for h in rings[1:]:
        g = g.difference(h) if g.contains(h.representative_point()) else g.union(h)
    return g if not g.is_empty else None


def _auto_free(sel, gain=0.07):
    """เดาให้ว่าชิ้นไหนควร 'ล้อมตามทรง' — คือชิ้นที่ **ยื่นพ้นกลุ่ม** ออกไป

    ⚠️ อย่าใช้ 'ชิ้นที่สูงกว่าเพื่อน' เป็นเกณฑ์ — ตัวอักษรสูงอย่าง Y N l ก็เข้าเกณฑ์ด้วย
       ผลคือขอบกล่องไฟหยักเป็นขั้นบันไดตามหัวตัวอักษร (เห็นชัดตอนลองกับไฟล์จริง)
    ✅ ถามว่า 'ถ้าเอาชิ้นนี้ออก กรอบรวมเล็กลงเยอะไหม' — เล็กลงเยอะ = ชิ้นนี้ยื่นออกไปคนเดียว
       รูปฟันเข้าเกณฑ์ · ตัวอักษรที่อยู่ในบล็อกเดียวกันไม่เข้า
    """
    if len(sel) < 3:
        return []
    def bb(ps):
        return (min(p["bbox"][0] for p in ps), min(p["bbox"][1] for p in ps),
                max(p["bbox"][2] for p in ps), max(p["bbox"][3] for p in ps))
    X0, Y0, X1, Y1 = bb(sel)
    A = max((X1 - X0) * (Y1 - Y0), 1e-9)
    out = []
    for p in sel:
        rest = [q for q in sel if q is not p]
        if not rest:
            continue
        x0, y0, x1, y1 = bb(rest)
        if 1.0 - ((x1 - x0) * (y1 - y0)) / A > float(gain):
            out.append(p["id"])
    return out


def build(pieces_res, keep_ids, mode="dicut", margin_mm=0.0, shape="hybrid",
          free_ids=None, simplify_mm=0.0):
    """คืน dict: parts[] (แต่ละชิ้นมี d + ขนาดมม.) · outline_d · stats"""
    from shapely.ops import unary_union
    from shapely.geometry import box
    mmpu = float(pieces_res["mm_per_unit"])
    upmm = 1.0 / mmpu if mmpu else 1.0                # 1 มม. คิดเป็นกี่หน่วยในไฟล์
    keep = set(keep_ids or [])
    sel = [p for p in pieces_res["pieces"] if p["id"] in keep]
    if not sel:
        raise ValueError("ยังไม่ได้เลือกชิ้นไหนเลย")
    geos = {}
    for p in sel:
        g = _from_d(p["d"])
        if g is not None and not g.is_empty:
            geos[p["id"]] = g
    if not geos:
        raise ValueError("ชิ้นที่เลือกอ่านเป็นรูปทรงไม่ได้")
    m = float(margin_mm) * upmm

    if mode == "dicut":
        parts = []
        for p in sel:
            g = geos.get(p["id"])
            if g is None:
                continue
            if m > 0:
                g = g.buffer(m, join_style=1, resolution=8)
            if float(simplify_mm) > 0:
                g = g.simplify(float(simplify_mm) * upmm, preserve_topology=True)
            x0, y0, x1, y1 = g.bounds
            parts.append({"id": p["id"], "rgb": p["rgb"], "d": _d_of_poly(g),
                          "w_mm": round((x1 - x0) * mmpu, 2), "h_mm": round((y1 - y0) * mmpu, 2),
                          "area_mm2": round(g.area * mmpu * mmpu, 2),
                          "holes": sum(len(q.interiors) for q in
                                       (g.geoms if g.geom_type == "MultiPolygon" else [g]))})
        return {"mode": "dicut", "parts": parts, "outline_d": "",
                "stats": {"parts": len(parts),
                          "area_mm2": round(sum(p["area_mm2"] for p in parts), 1)}}

    # ── กล่องไฟ / ป้ายล้อมทรง ──
    free = set(free_ids) if free_ids is not None else set(_auto_free(sel))
    inner = [g for i, g in geos.items() if i not in free]
    outer = [g for i, g in geos.items() if i in free]
    if shape == "rect" or not inner and not outer:
        g = unary_union(list(geos.values()))
        x0, y0, x1, y1 = g.bounds
        out = box(x0 - m, y0 - m, x1 + m, y1 + m)
    elif shape == "shape":
        out = unary_union([g.buffer(m, join_style=1, resolution=12) for g in geos.values()])
    else:                                              # ผสม: กรอบตรง + อ้อมชิ้นที่ยื่นออกมา
        gs = []
        if inner:
            u = unary_union(inner); x0, y0, x1, y1 = u.bounds
            gs.append(box(x0 - m, y0 - m, x1 + m, y1 + m))
        for g in outer:
            gs.append(g.buffer(m, join_style=1, resolution=12))
        out = unary_union(gs) if gs else None
    if out is None or out.is_empty:
        raise ValueError("สร้างขอบไม่สำเร็จ")
    if float(simplify_mm) > 0:
        out = out.simplify(float(simplify_mm) * upmm, preserve_topology=True)
    if out.geom_type == "MultiPolygon":
        out = max(out.geoms, key=lambda g: g.area)
    x0, y0, x1, y1 = out.bounds
    return {"mode": "outline", "shape": shape, "free_ids": sorted(free),
            "outline_d": _d_of_poly(out),
            "parts": [{"id": p["id"], "rgb": p["rgb"], "d": p["d"]} for p in sel],
            "stats": {"w_mm": round((x1 - x0) * mmpu, 2), "h_mm": round((y1 - y0) * mmpu, 2),
                      "area_mm2": round(out.area * mmpu * mmpu, 1),
                      "perimeter_mm": round(out.length * mmpu, 1),
                      "margin_mm": float(margin_mm), "wrapped": len(free)}}


# ══════════════════════════════════════════════════════════════════
# 🧱 ประกอบร่าง — เอาชิ้นที่แยกออกมา มาจัดวางใหม่เป็นป้ายจริง
#
# ทำไมแค่ 'ล้อมรอบของเดิม' ไม่พอ (จากงานจริง YN smile กล่องไฟ 230×85 cm):
#   ในไฟล์ต้นฉบับ ฟันอยู่ชิดตัวอักษร ขนาดหนึ่ง
#   แต่ในกล่องไฟจริง ฟันถูก **ย้ายมาไว้ริมซ้าย + ย่อ/ขยายคนละสัดส่วน**
#   แล้วขอบกล่องต้อง **อ้อมฟันที่ย้ายมาแล้ว** ไม่ใช่อ้อมตำแหน่งเดิมในไฟล์
#   ⇒ ต้องมีขั้น 'จัดวางใหม่' คั่นกลาง ระหว่างแยกชิ้น กับ สร้างขอบ
#
# บทบาทของแต่ละชิ้น (role) — ตัวนี้คือหัวใจ:
#   "outline" = ชิ้นที่ **กำหนดรูปทรงของกล่อง** (รูปฟัน · แผ่นสี่เหลี่ยม)
#   "face"    = ชิ้นที่ **แค่พิมพ์อยู่บนหน้าป้าย** ไม่ทำให้ขอบกล่องเปลี่ยนรูป
#               (ตัวหนังสือ ทำฟัน จัดฟัน · เบอร์โทร)
#   "both"    = เป็นทั้งสองอย่าง
# ทุกพิกัดในขั้นนี้เป็น **มิลลิเมตรจริง** ทั้งหมด คิดขนาดหน้างานได้ตรง ๆ
# ══════════════════════════════════════════════════════════════════
def _place(g, mmpu, x_mm=None, y_mm=None, w_mm=None, h_mm=None,
           flipx=False, flipy=False, rot=0.0):
    """ย้าย/ย่อขยาย/พลิก ชิ้นหนึ่ง -> พิกัดมิลลิเมตรบนผืนงานใหม่"""
    from shapely import affinity
    g = affinity.scale(g, xfact=mmpu, yfact=mmpu, origin=(0, 0))   # หน่วยไฟล์ -> มม.
    x0, y0, x1, y1 = g.bounds
    sw = max(x1 - x0, 1e-9); sh = max(y1 - y0, 1e-9)
    if w_mm and h_mm:
        sx, sy = float(w_mm) / sw, float(h_mm) / sh
    elif w_mm:
        sx = sy = float(w_mm) / sw
    elif h_mm:
        sx = sy = float(h_mm) / sh
    else:
        sx = sy = 1.0
    if sx != 1.0 or sy != 1.0:
        g = affinity.scale(g, xfact=sx, yfact=sy, origin=(x0, y0))
    if flipx or flipy:
        g = affinity.scale(g, xfact=-1 if flipx else 1, yfact=-1 if flipy else 1,
                           origin="center")
    if rot:
        g = affinity.rotate(g, float(rot), origin="center")
    x0, y0, x1, y1 = g.bounds
    if x_mm is not None:
        g = affinity.translate(g, xoff=float(x_mm) - x0)
    if y_mm is not None:
        x0, y0, x1, y1 = g.bounds
        g = affinity.translate(g, yoff=float(y_mm) - y0)
    return g


def _rect(sp):
    from shapely.geometry import box
    g = box(float(sp["x_mm"]), float(sp["y_mm"]),
            float(sp["x_mm"]) + float(sp["w_mm"]), float(sp["y_mm"]) + float(sp["h_mm"]))
    r = float(sp.get("r_mm") or 0)
    if r > 0:
        g = g.buffer(-r, join_style=1).buffer(r, join_style=1, resolution=16)
    return g


def assemble(pieces_res, layout, margin_mm=0.0, simplify_mm=0.0, canvas=None,
             keep_all=False):
    """ประกอบชิ้น + รูปทรงที่เพิ่มเอง -> ขอบกล่อง 1 เส้น + ชั้นหน้าป้าย

    layout = [{"id":"s3", "role":"outline", "x_mm":0, "y_mm":0, "h_mm":850, "flipx":False},
              {"shape":"rect", "role":"outline", "x_mm":300,"y_mm":120,"w_mm":1700,"h_mm":610,
               "rgb":[168,170,150]},
              {"id":"s7", "role":"face", "x_mm":420, "y_mm":230, "h_mm":180}]
    คืน: outline_d · faces[] · size_mm · stats
    """
    from shapely.ops import unary_union
    mmpu = float(pieces_res["mm_per_unit"])
    src = {p["id"]: p for p in pieces_res["pieces"]}
    body = []; faces = []; boxes = []
    for it in layout:
        role = (it.get("role") or "outline").lower()
        if it.get("shape") == "rect":
            g = _rect(it); rgb = tuple(it.get("rgb") or (230, 230, 230))
        else:
            p = src.get(it.get("id"))
            if p is None:
                continue
            g0 = _from_d(p["d"])
            if g0 is None:
                continue
            g = _place(g0, mmpu, it.get("x_mm"), it.get("y_mm"), it.get("w_mm"), it.get("h_mm"),
                       bool(it.get("flipx")), bool(it.get("flipy")), float(it.get("rot") or 0))
            rgb = tuple(it.get("rgb") or p["rgb"])
        if g is None or g.is_empty:
            continue
        if role in ("outline", "both"):
            body.append(g)
        if role in ("face", "both"):
            faces.append({"id": it.get("id") or "rect", "rgb": rgb, "d": _d_of_poly(g)})
        bx0, by0, bx1, by1 = g.bounds
        boxes.append({"key": it.get("key"), "role": role,
                      "kind": "rect" if it.get("shape") == "rect" else "piece",
                      "x_mm": round(bx0, 2), "y_mm": round(by0, 2),
                      "w_mm": round(bx1 - bx0, 2), "h_mm": round(by1 - by0, 2)})
    if not body:
        raise ValueError("ยังไม่มีชิ้นไหนถูกตั้งให้เป็น 'ตัวกำหนดรูปทรงกล่อง' เลย")
    out = unary_union(body)
    m = float(margin_mm)
    if m > 0:
        # ⚠️ ขยาย-หด กลับ ทำให้รอยต่อระหว่างชิ้นเชื่อมเป็นเนื้อเดียว ไม่มีรอยบากคม
        out = out.buffer(m, join_style=1, resolution=16)
    if float(simplify_mm) > 0:
        out = out.simplify(float(simplify_mm), preserve_topology=True)
    gap = 0
    if out.geom_type == "MultiPolygon":
        # ⚠️ ไดคัทแยกชิ้น ต้องเก็บ **ทุกก้อน** (56 ตัวอักษรคือ 56 ชิ้นตัด ไม่ใช่ก้อนเดียว)
        #    ส่วนกล่องไฟต้องเป็นก้อนเดียว ถ้าหลุดออกจากกันแปลว่าวางไม่ชนกัน ต้องเตือน
        parts = sorted(out.geoms, key=lambda g: -g.area)
        if not keep_all:
            out = parts[0]
            gap = len(parts) - 1
    x0, y0, x1, y1 = out.bounds
    return {"outline_d": _d_of_poly(out, 3), "faces": faces, "boxes": boxes,
            "parts_n": (len(out.geoms) if out.geom_type == "MultiPolygon" else 1),
            "size_mm": [round(x1 - x0, 2), round(y1 - y0, 2)],
            "origin_mm": [round(x0, 2), round(y0, 2)],
            "canvas_mm": canvas or [round(x1, 2), round(y1, 2)],
            "stats": {"w_mm": round(x1 - x0, 2), "h_mm": round(y1 - y0, 2),
                      "area_mm2": round(out.area, 1), "perimeter_mm": round(out.length, 1),
                      "holes": (sum(len(g.interiors) for g in out.geoms)
                                if out.geom_type == "MultiPolygon" else len(out.interiors)),
                      "parts": (len(out.geoms) if out.geom_type == "MultiPolygon" else 1),
                      "detached": gap,
                      "margin_mm": m, "faces": len(faces), "body": len(body)}}


# ══════════════════════════════════════════════════════════════════
# 🖨️ หน้ากล่องไฟ = อะคริลิคพิมพ์ UV — ต้องออกแบบเองได้
#
# โจทย์จากงานจริง: หน้ากล่องไม่ใช่แค่ 'สีพื้น' เดียว แต่เป็นงานออกแบบเต็มใบ
#   • พื้นหลังอาจเป็น **ไฟล์ artwork** ที่ลูกค้า/เซลส์เตรียมมา (ภาพ หรือ เวกเตอร์)
#   • หรือเป็น **แถบสีหลายแถบ** วางซ้อนกัน (เขียวบน + ครีมล่าง)
#   • ข้อความแต่ละก้อนต้องขยับ/เปลี่ยนสี/เปลี่ยนขนาดแยกกันได้
#     ('ทำฟัน จัดฟัน' กับ '094-982-6442' คนละก้อน คนละสี คนละขนาด)
#   • โลโก้ที่แยกมาจากไฟล์ ก็วางลงหน้าป้ายได้
#
# 🔑 กติกาที่ห้ามพลาด: **งานพิมพ์ต้องถูกตัดให้พอดีรูปกล่องเสมอ**
#    ถ้าไม่ครอบ (clip) ตามขอบกล่อง เวลาพิมพ์จริงจะเลยขอบอะคริลิคออกไป
#    ที่นี่จึงครอบด้วยรูปทรงกล่องที่คำนวณได้ทุกครั้ง ไม่ใช่ครอบด้วยสี่เหลี่ยม
#
# ออกมา 2 ไฟล์ที่ใช้คนละที่ — ห้ามรวมกัน:
#    cut_svg   -> เส้นตัด (อะคริลิค + ขอบซิงค์)     ขนาดจริงหน่วยมม.
#    face_svg  -> งานพิมพ์ UV หน้าป้าย (ครอบตามทรงแล้ว) ขนาดจริงหน่วยมม.
# ══════════════════════════════════════════════════════════════════
def _esc(t):
    return (str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _art_node(art, x, y, w, h, fit="cover"):
    """พื้นหลังที่เป็นไฟล์ artwork -> node สำหรับวางใต้สุดของหน้าป้าย"""
    import base64
    kind = (art.get("kind") or "image").lower()
    if kind == "image":
        b = art.get("data")
        b64 = b if isinstance(b, str) else base64.b64encode(b).decode()
        par = {"cover": "xMidYMid slice", "contain": "xMidYMid meet",
               "stretch": "none"}.get(fit, "xMidYMid slice")
        return ('<image x="%.2f" y="%.2f" width="%.2f" height="%.2f" '
                'preserveAspectRatio="%s" href="data:%s;base64,%s"/>'
                % (x, y, w, h, par, art.get("mime") or "image/png", b64))
    return art.get("svg") or ""


def compose(pieces_res, layout, margin_mm=0.0, art=None, bleed_mm=0.0,
            simplify_mm=0.0, font="Garuda", keep_all=False):
    """ประกอบร่าง + ออกแบบหน้าป้าย -> ไฟล์ตัด + ไฟล์พิมพ์ UV

    layout เพิ่มชนิดได้อีก 2 แบบนอกจาก id/rect:
      {"art":"bg1", "role":"face", "fit":"cover"}                       พื้นหลังจากไฟล์ artwork
      {"text":"ทำฟัน จัดฟัน", "role":"face", "x_mm":..,"y_mm":..,
       "size_mm":220, "rgb":[255,255,255], "align":"center", "bold":True}
    art = {"bg1": {"kind":"image","mime":"image/jpeg","data": <bytes|base64>}}
    """
    base = [it for it in layout if not it.get("art") and not it.get("text")]
    A = assemble(pieces_res, base, margin_mm=margin_mm, simplify_mm=simplify_mm,
                 keep_all=bool(keep_all))
    ox, oy = A["origin_mm"]
    W, H = A["size_mm"]
    d = A["outline_d"]

    cut = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<svg xmlns="http://www.w3.org/2000/svg" width="%.2fmm" height="%.2fmm" '
           'viewBox="%.2f %.2f %.2f %.2f">'
           '<path d="%s" fill="none" stroke="#000000" stroke-width="0.5"/></svg>'
           % (W, H, ox, oy, W, H, d))

    head = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<svg xmlns="http://www.w3.org/2000/svg" width="%.2fmm" height="%.2fmm" '
            'viewBox="%.2f %.2f %.2f %.2f">' % (W, H, ox, oy, W, H),
            '<defs><clipPath id="boxclip"><path d="%s"/></clipPath></defs>' % d,
            '<g clip-path="url(#boxclip)">']
    # 🪜 ลำดับชั้นของหน้าป้าย — ตายตัว ไม่ขึ้นกับลำดับที่ผู้ใช้ใส่เข้ามา
    #    พื้นรอง -> ไฟล์ artwork -> แถบสี/ชิ้นโลโก้ -> ข้อความ (บนสุดเสมอ)
    #    ถ้าปล่อยให้เรียงตามที่ผู้ใช้ใส่ แถบสีที่เพิ่มทีหลังจะทับตัวหนังสือหาย
    L0 = ['<path d="%s" fill="#ffffff"/>' % d] if float(bleed_mm) > 0 else []
    L1 = []; L3 = []
    for it in layout:
        if (it.get("role") or "face").lower() not in ("face", "both"):
            continue
        if it.get("art"):
            a = (art or {}).get(it["art"])
            if a:
                L1.append(_art_node(a, ox, oy, W, H, it.get("fit") or "cover"))
        elif it.get("text"):
            sz = float(it.get("size_mm") or 100)
            rgb = tuple(it.get("rgb") or (0, 0, 0))
            al = {"left": "start", "center": "middle", "right": "end"}.get(
                it.get("align") or "left", "start")
            L3.append('<text x="%.2f" y="%.2f" font-family="%s" font-size="%.2f" '
                      'font-weight="%s" fill="#%02x%02x%02x" text-anchor="%s" '
                      'letter-spacing="%.2f">%s</text>'
                      % (float(it.get("x_mm") or 0), float(it.get("y_mm") or 0) + sz * 0.78,
                         _esc(it.get("font") or font), sz,
                         "bold" if it.get("bold") else "normal", rgb[0], rgb[1], rgb[2],
                         al, float(it.get("track_mm") or 0), _esc(it["text"])))
    L2 = ['<path d="%s" fill="#%02x%02x%02x"/>' % ((f["d"],) + tuple(f["rgb"]))
          for f in A["faces"]]
    body = head + L0 + L1 + L2 + L3 + ['</g></svg>']
    face = "".join(body)
    st = dict(A["stats"])
    st.update({"texts": sum(1 for it in layout if it.get("text")),
               "art_bg": sum(1 for it in layout if it.get("art")),
               "bleed_mm": float(bleed_mm)})
    return {"cut_svg": cut, "face_svg": face, "outline_d": d, "boxes": A.get("boxes", []),
            "size_mm": [W, H], "origin_mm": [ox, oy], "stats": st}
