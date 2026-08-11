"""📦 Vectora export — เขียนผลลัพธ์เป็นไฟล์ 5 นามสกุล

SVG  = เขียนเอง (โค้งเบซิเยร์จริง ไฟล์เล็ก)
PDF / EPS / PNG = แปลงจาก SVG ด้วย cairosvg (เวกเตอร์จริงทั้ง PDF และ EPS)
DXF  = ezdxf · แตกโค้งเป็นเส้นย่อยตามความละเอียดที่ตั้ง + แยกเลเยอร์ตามสี

⚠️ แกน Y: SVG นับลงล่าง แต่ CAD/DXF นับขึ้นบน — ต้องกลับด้านตอนเขียน DXF
   ถ้าลืม ไฟล์ที่เอาเข้าเครื่องตัดจะกลับหัว (เจอบ่อยมากกับงานจริง)
"""

import io
import math


# ─────────────── SVG ───────────────
def _d_of(item):
    if item[0] == "P":
        return "M " + " L ".join("%.3f %.3f" % (x, y) for x, y in item[1]) + " Z"
    st, sg = item[1], item[2]
    d = "M %.3f %.3f " % (st[0], st[1])
    for s in sg:
        if s[0] == "L":
            d += "L %.3f %.3f " % (s[1][0], s[1][1])
        else:
            d += "C %.3f %.3f %.3f %.3f %.3f %.3f " % (s[1][0], s[1][1], s[2][0], s[2][1],
                                                        s[3][0], s[3][1])
    return d + "Z"


def _poly_of(items, tol=0.9):
    """แปลง items (เบซิเยร์) -> รูปทรง shapely พร้อม 'รู' ตามกติกา even-odd"""
    from shapely.geometry import Polygon as _P
    rings = []
    for it in items:
        pts = _flat(it, tol)
        if len(pts) >= 4:
            try:
                g = _P(pts).buffer(0)
                if not g.is_empty:
                    rings.append(g)
            except Exception:
                pass
    if not rings:
        return None
    rings.sort(key=lambda g: -g.area)
    out = rings[0]
    for g in rings[1:]:
        out = out.difference(g) if out.contains(g.representative_point()) else out.union(g)
    return None if out.is_empty else out


def _d_of_poly(g):
    def ring(c):
        return "M " + " L ".join("%.1f %.1f" % (x, y) for x, y in c) + " Z"
    ps = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    d = []
    for p in ps:
        if p.is_empty:
            continue
        d.append(ring(p.exterior.coords))
        for h in p.interiors:
            d.append(ring(h.coords))
    return " ".join(d)


def to_svg(res, scale=1.0, background=True):
    W, H = res["size"]
    ow, oh = int(round(W * scale)), int(round(H * scale))
    p = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
         % (ow, oh, W, H)]
    # ══════════════════════════════════════════════════════════════
    # 🌈 นิยามไล่สีเชิงเส้น (โหมด "ภาพไล่สี") — ผู้ใช้สั่ง 2026-08-09
    #    ก้อนไหนที่เอนจิ้นหา 'ระนาบสี' ได้ จะมี L["grad"] ติดมา
    #    -> ออกเป็น <linearGradient> แล้ว fill ด้วย url(#..) แทนสีเดียว
    #    ผลคือไล่สีเนียนต่อเนื่องจริง ไม่ใช่แถบสีแบนเรียงกัน
    #    gradientUnits="userSpaceOnUse" = ใช้พิกัดเดียวกับ path ตรง ๆ ไม่ต้องแปลง
    # ══════════════════════════════════════════════════════════════
    # 🌈🌈 รองรับ "ไล่สีหลายจุด" (วิธีใหม่ 2026-08-10)
    #    ของเดิมออกได้แค่ 2 จุด (หัว-ท้าย) = สมมติว่าสีเปลี่ยนเป็นเส้นตรงล้วน
    #    ภาพไล่เฉดจริงแทบไม่มีอันไหนเป็นเส้นตรง -> คลาดเฉลี่ยถึง 19.7 ระดับสี (วัดจริง)
    #    ตอนนี้ออกได้ถึง 28 จุด + รองรับไล่สีแบบวงกลม (radialGradient) ด้วย
    _defs = []
    _band = {}                                       # ชั้นที่เป็นไล่สีสองมิติ -> เขียนแยกทีหลัง
    for i, L in enumerate(res["layers"]):
        g = L.get("grad")
        if not g:
            continue
        # ══════════════════════════════════════════════════════════════
        # 🌈🌈🌈 ไล่สีสองมิติ (kind="bands") — พื้นสีรุ้งที่ไล่สองทิศพร้อมกัน
        #    แต่ละแถบ = ไล่สีของตัวเอง + มาสก์ไล่ระดับที่เกลี่ยเข้าหาแถบก่อนหน้า
        #    ผลลัพธ์ทางคณิตศาสตร์คือการเกลี่ยเชิงเส้นระหว่างแถบ -> ไม่มีรอยต่อ
        #    ใช้ clipPath ครอบรูปทรงครั้งเดียว แล้ววาง <rect> เต็มผืนเป็นชั้น ๆ
        #    (ถ้าซ้ำ path ทุกแถบ ไฟล์จะบวมเป็นสิบเท่า)
        # ══════════════════════════════════════════════════════════════
        if g.get("kind") == "bands":
            bs = g.get("bands") or []
            for k, b in enumerate(bs):
                body = "".join('<stop offset="%.4f" stop-color="#%02x%02x%02x"/>'
                               % ((float(o),) + tuple(int(v) for v in c)) for o, c in b["stops"])
                # ไล่สีอยู่ในกรอบที่หมุนแล้ว: แกน y ท้องถิ่น = -t  (offset 0 อยู่ที่ t0)
                import math as _mm
                _rd = _mm.radians(float(g["deg"]))
                _ux, _uy = _mm.sin(_rd), -_mm.cos(_rd)
                _t0, _t1 = float(g["t0"]), float(g["t1"])
                _defs.append('<linearGradient id="gb%d_%d" gradientUnits="userSpaceOnUse" '
                             'x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f">%s</linearGradient>'
                             % (i + 1, k, _t0 * _ux, _t0 * _uy, _t1 * _ux, _t1 * _uy, body))
            _band[i] = len(bs)
            continue
        st = g.get("stops")
        if not st:                                   # รูปแบบเดิม 2 จุด (เผื่อไฟล์เก่า)
            st = [[0.0, tuple(g["c1"])], [1.0, tuple(g["c2"])]]
        body = "".join('<stop offset="%.4f" stop-color="#%02x%02x%02x"/>'
                       % ((float(o),) + tuple(int(v) for v in c)) for o, c in st)
        if g.get("kind") == "radial":
            _defs.append('<radialGradient id="g%d" gradientUnits="userSpaceOnUse" '
                         'cx="%s" cy="%s" r="%s">%s</radialGradient>'
                         % (i + 1, g["cx"], g["cy"], g["r"], body))
        else:
            _defs.append('<linearGradient id="g%d" gradientUnits="userSpaceOnUse" '
                         'x1="%s" y1="%s" x2="%s" y2="%s">%s</linearGradient>'
                         % (i + 1, g["x1"], g["y1"], g["x2"], g["y2"], body))
    if _defs:
        p.append('<defs>' + "".join(_defs) + '</defs>')
    if background and res.get("bg"):
        p.append('<rect width="%d" height="%d" fill="#%02x%02x%02x"/>' % ((W, H) + tuple(res["bg"])))
    for i, L in enumerate(res["layers"]):
        d = " ".join(_d_of(it) for it in L["items"])
        if i in _band:
            # ══════════════════════════════════════════════════════════
            # 🌈 ไล่สีสองมิติ — วาดในกรอบที่ "หมุนแล้ว" ทุกอย่างจึงเป็นสี่เหลี่ยมตรง ๆ
            #   · ครอบรูปทรงด้วย clipPath ครั้งเดียว (เขียน path ซ้ำทุกแถบไฟล์จะบวมสิบเท่า)
            #   · แถบ k วางทึบเต็มในช่วงของตัวเอง
            #   · ช่วงคาบเกี่ยวกับแถบก่อนหน้า ซอยเป็น q ชิ้น ไล่ความทึบทีละขั้น
            #     = การเกลี่ยเชิงเส้นระหว่างแถบ (ขั้นละ ~1 ระดับสี ตาไม่เห็น)
            #   ⚠️ ห้ามเปลี่ยนไปใช้ <mask> — cairosvg ไม่รองรับ ไฟล์ PDF/EPS/PNG จะเพี้ยนทั้งใบ
            # ══════════════════════════════════════════════════════════
            # ⚠️ ห้ามใช้ clipPath ที่มี "รู" — cairosvg รวมทุกวงเป็นก้อนเดียว รูจะหายไป
            #    และห้ามเกลี่ยรอยต่อด้วยความโปร่งใส — ขอบสองชิ้นที่ชนกันพอดีจะเกิด "เส้นริ้ว"
            #    (ตัวเรนเดอร์เกลี่ยขอบให้ทั้งคู่ชิ้นละ ~50% รวมกันได้ 75% ไม่ใช่ 100%)
            # ✅ ตัดรูปจริงด้วยเรขาคณิตใน Python · แต่ละแถบทึบ 100% · ให้ทับกันเล็กน้อย
            import math as _m
            from shapely.geometry import Polygon as _P
            g = L["grad"]
            bs = g["bands"]
            rad = _m.radians(float(g["deg"]))
            pxv, pyv = _m.cos(rad), _m.sin(rad)
            ux, uy = pyv, -pxv
            t0, t1 = float(g["t0"]), float(g["t1"])
            M = float(W + H) * 2.0
            D = float(W + H) * 1.5
            ov = max(0.6, (W + H) / 1400.0)          # ทับกันกันเส้นริ้ว (ทึบทับทึบ ไม่มีผลข้างเคียง)
            base = _poly_of(L["items"])
            if base is not None:
                try:                                  # ลดจุดก่อนตัด — เร็วขึ้นหลายเท่า ตาไม่เห็นต่าง
                    # ขอบของชั้นพื้นถูกลายด้านบนทับอยู่ ~4 px อยู่แล้ว ลดจุดได้มากโดยตาไม่เห็น
                    _sm = base.simplify(1.2, preserve_topology=True)
                    if not _sm.is_empty:
                        base = _sm
                except Exception:
                    pass
            for k, b in enumerate(bs):
                a0 = float(b["s0"]) - (D if k == 0 else ov)
                a1 = float(b["s1"]) + (D if k == len(bs) - 1 else ov)
                if base is None:
                    break
                pts = [(a0 * pxv - y * ux, a0 * pyv - y * uy) for y in (-t1 - M, -t0 + M)]
                pts += [(a1 * pxv - y * ux, a1 * pyv - y * uy) for y in (-t0 + M, -t1 - M)]
                try:
                    pc = base.intersection(_P(pts))
                except Exception:
                    continue
                if pc.is_empty:
                    continue
                dd = _d_of_poly(pc)
                if dd:
                    p.append('<path d="%s" fill="url(#gb%d_%d)" fill-rule="evenodd"/>'
                             % (dd, i + 1, k))
            continue
        if L.get("grad"):
            p.append('<path id="c%d" d="%s" fill="url(#g%d)" fill-rule="evenodd"/>'
                     % (i + 1, d, i + 1))
        else:
            p.append('<path id="c%d" d="%s" fill="#%02x%02x%02x" fill-rule="evenodd"/>'
                     % ((i + 1, d) + L["rgb"]))
    p.append('</svg>')
    return "".join(p)


# ─────────────── PDF / EPS / PNG (ผ่าน cairosvg) ───────────────
def _cairo(svg, kind, px_scale=1.0):
    import cairosvg
    b = svg.encode("utf-8")
    if kind == "png":
        return cairosvg.svg2png(bytestring=b, scale=float(px_scale))
    if kind == "pdf":
        return cairosvg.svg2pdf(bytestring=b)
    if kind == "eps":
        return cairosvg.svg2eps(bytestring=b)
    raise ValueError(kind)


# ─────────────── DXF ───────────────
def _flat(item, tol=0.15):
    """แตกเป็นแนวจุด — โค้งถูกซอยละเอียดตาม tol (หน่วยพิกเซล)"""
    if item[0] == "P":
        return [tuple(q) for q in item[1]]
    pts = [tuple(item[1])]
    for s in item[2]:
        if s[0] == "L":
            pts.append(tuple(s[1])); continue
        p0 = pts[-1]; c1, c2, p3 = s[1], s[2], s[3]
        d = (math.dist(p0, c1) + math.dist(c1, c2) + math.dist(c2, p3))
        n = max(2, min(96, int(d / max(0.02, tol)) + 1))
        for i in range(1, n + 1):
            t = i / n; m = 1 - t
            pts.append((m**3 * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t**3 * p3[0],
                        m**3 * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t**3 * p3[1]))
    return pts


def _bez_chain(item, s, H):
    """คืนลิสต์ของโค้งเบซิเยร์ (จุดควบคุม 4 จุด) — พิกัดแปลงเป็นหน่วย/แกนของ DXF แล้ว"""
    from ezdxf.math import Vec3
    if item[0] == "P":
        return None
    def T(p):
        return Vec3(p[0] * s, (H - p[1]) * s, 0)
    out = []
    cur = T(item[1])
    for g in item[2]:
        if g[0] == "L":                     # เส้นตรง = เบซิเยร์ที่จุดควบคุมอยู่บนเส้น
            e = T(g[1])
            out.append((cur, cur.lerp(e, 1 / 3), cur.lerp(e, 2 / 3), e)); cur = e
        else:
            e = T(g[3])
            out.append((cur, T(g[1]), T(g[2]), e)); cur = e
    return out or None


def to_dxf(res, mm_per_px=None, tol=0.15, curves=True):
    """DXF แยกเลเยอร์ตามสี

    ⚠️ แกน Y: SVG นับลงล่าง · CAD นับขึ้นบน — ต้องกลับด้าน ไม่งั้นไฟล์เข้าเครื่องตัดกลับหัว
    ✅ เขียนเป็น SPLINE (โค้งจริง) ไม่ใช่เส้นย่อยเป็นหมื่นจุด
       ทดสอบแล้ว: โลโก้ 5 สี แบบเส้นย่อย 490 KB · แบบโค้งจริง ~25 KB และเครื่องเดินเนียนกว่า
    """
    import ezdxf
    from ezdxf.math import bezier_to_bspline, Bezier4P
    W, H = res["size"]
    s = float(mm_per_px) if mm_per_px else 1.0
    doc = ezdxf.new("R2010", setup=True)
    msp = doc.modelspace()
    for i, L in enumerate(res["layers"]):
        r, g, b = L["rgb"]
        name = "COLOR_%d_%02X%02X%02X" % (i + 1, r, g, b)
        if name not in doc.layers:
            doc.layers.add(name).rgb = (r, g, b)
        for it in L["items"]:
            done = False
            if curves:
                try:
                    ch = _bez_chain(it, s, H)
                    if ch and len(ch) >= 1:
                        bs = bezier_to_bspline([Bezier4P(c) for c in ch])
                        sp = msp.add_spline(dxfattribs={"layer": name})
                        sp.apply_construction_tool(bs)
                        sp.closed = True
                        done = True
                except Exception:
                    done = False
            if not done:
                pts = _flat(it, tol)
                if len(pts) < 3:
                    continue
                msp.add_lwpolyline([(x * s, (H - y) * s) for x, y in pts],
                                   close=True, dxfattribs={"layer": name})
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


# ─────────────── หน้าบ้าน ───────────────
EXT = {"svg": "svg", "pdf": "pdf", "eps": "eps", "png": "png", "dxf": "dxf"}
MIME = {"svg": "image/svg+xml", "pdf": "application/pdf", "eps": "application/postscript",
        "png": "image/png", "dxf": "application/dxf"}


def render(res, fmt, png_scale=2.0, mm_per_px=None, background=True):
    fmt = (fmt or "svg").lower()
    if fmt == "dxf":
        return to_dxf(res, mm_per_px=mm_per_px)
    svg = to_svg(res, background=background)
    if fmt == "svg":
        return svg.encode("utf-8")
    return _cairo(svg, fmt, px_scale=png_scale)
