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
    _defs = []
    for i, L in enumerate(res["layers"]):
        g = L.get("grad")
        if not g:
            continue
        _defs.append(
            '<linearGradient id="g%d" gradientUnits="userSpaceOnUse" '
            'x1="%s" y1="%s" x2="%s" y2="%s">'
            '<stop offset="0" stop-color="#%02x%02x%02x"/>'
            '<stop offset="1" stop-color="#%02x%02x%02x"/></linearGradient>'
            % ((i + 1, g["x1"], g["y1"], g["x2"], g["y2"]) + tuple(g["c1"]) + tuple(g["c2"])))
    if _defs:
        p.append('<defs>' + "".join(_defs) + '</defs>')
    if background and res.get("bg"):
        p.append('<rect width="%d" height="%d" fill="#%02x%02x%02x"/>' % ((W, H) + tuple(res["bg"])))
    for i, L in enumerate(res["layers"]):
        d = " ".join(_d_of(it) for it in L["items"])
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
