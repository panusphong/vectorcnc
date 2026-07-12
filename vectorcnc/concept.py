"""
concept.py — AI Concept Kit (สำหรับเซลล์: ลูกค้าไม่มี idea / ไม่มีโลโก้ / ไม่มีชื่อ)

แก้ปัญหา: ลูกค้ามาแบบว่าง ๆ เซลล์ไม่มีอะไรให้ดู → งานค้าง → กราฟิกเดาเอง → แก้ไม่จบ

โมดูลนี้สร้าง "โลโก้ตัวอย่างที่เป็นเวกเตอร์จริง" ให้เลือกหน้าลูกค้าได้ทันที
  - แปลงข้อความ (ไทย/อังกฤษ) เป็น outline เวกเตอร์จริง (HarfBuzz shaping + fontTools)
  - จัดเป็นเลย์เอาต์มาตรฐานงานป้าย (plain / underline / plate / badge / frame / stacked)
  - ผลลัพธ์เป็น shapely (mm) → ส่งต่อ Producibility Check / ชุดชั้นตัด / Nesting ได้เลย

** ไม่ได้ trace ภาพ — เป็นเวกเตอร์ตั้งแต่ต้น จึงคมและตัดได้จริง **
"""

CONCEPT_VERSION = "2026-07-12-font-vector-concepts"

import os
import math

from shapely.geometry import Polygon, box, Point
from shapely.ops import unary_union
from shapely.affinity import translate, scale as aff_scale


# ---------------------------------------------------------------- fonts
FONT_DIRS = [
    "/usr/share/fonts", "/usr/local/share/fonts",
    os.path.expanduser("~/.fonts"), os.path.expanduser("~/.local/share/fonts"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts"),
]

# สไตล์ที่เปิดให้เลือก → รายชื่อ family ที่ยอมรับ (เรียงตามความชอบ)
STYLE_PREF = [
    ("bold-modern",  "หนา โมเดิร์น",   ["Kanit", "Prompt", "Mitr", "Poppins", "Montserrat",
                                        "Noto Sans Thai", "Waree", "Loma", "DejaVu Sans"]),
    ("condensed",    "ผอมสูง เท่",     ["Bebas", "Oswald", "Anton", "Kanit", "Umpush",
                                        "TlwgTypo", "DejaVu Sans Condensed"]),
    ("classic",      "คลาสสิก มีเชิง", ["Playfair", "Norasi", "Kinnari", "Noto Serif Thai",
                                        "DejaVu Serif", "Liberation Serif"]),
    ("rounded",      "มน เป็นมิตร",    ["Mitr", "Prompt", "Sarabun", "Garuda", "Poppins",
                                        "Noto Sans Thai"]),
    ("script",       "ลายมือ มีสไตล์", ["Purisa", "Sawasdee", "Charmonman", "Pacifico",
                                        "Kanit"]),
]

_FONT_CACHE = None


def _scan_fonts():
    global _FONT_CACHE
    if _FONT_CACHE is not None:
        return _FONT_CACHE
    files = []
    for d in FONT_DIRS:
        if not os.path.isdir(d):
            continue
        for root, _dirs, fns in os.walk(d):
            for fn in fns:
                if fn.lower().endswith((".ttf", ".otf")):
                    files.append(os.path.join(root, fn))
            if len(files) > 900:
                break
    out = []
    from fontTools.ttLib import TTFont
    for p in files[:900]:
        try:
            f = TTFont(p, lazy=True, fontNumber=0)
            fam = ""
            sub = ""
            for rec in f["name"].names:
                if rec.nameID == 1 and not fam:
                    fam = rec.toUnicode()
                if rec.nameID == 2 and not sub:
                    sub = rec.toUnicode()
            cmap = f.getBestCmap() or {}
            thai = 0x0E01 in cmap
            latin = ord("A") in cmap
            f.close()
            if not (thai or latin):
                continue
            out.append({"path": p, "family": fam or os.path.basename(p),
                        "sub": sub or "", "thai": thai, "latin": latin,
                        "bold": ("bold" in (sub or "").lower()
                                 or "bold" in os.path.basename(p).lower())})
        except Exception:
            continue
    _FONT_CACHE = out
    return out


def _pick(prefs, need_thai):
    """เลือกฟอนต์ตัวแรกที่ตรง preference และรองรับภาษาที่ต้องใช้"""
    fonts = _scan_fonts()
    for want in prefs:
        cands = [f for f in fonts if want.lower() in f["family"].lower()]
        if need_thai:
            cands = [c for c in cands if c["thai"]]
        if not cands:
            continue
        cands.sort(key=lambda c: (0 if c["bold"] else 1, len(c["family"])))
        return cands[0]
    # fallback: อะไรก็ได้ที่รองรับภาษา
    cands = [f for f in fonts if (f["thai"] if need_thai else f["latin"])]
    if not cands:
        return None
    cands.sort(key=lambda c: (0 if c["bold"] else 1, len(c["family"])))
    return cands[0]


def available_styles(text=""):
    """คืนสไตล์ที่ใช้ได้จริงบนเครื่องนี้ (มีฟอนต์รองรับ)"""
    need_thai = _has_thai(text)
    out = []
    for key, label, prefs in STYLE_PREF:
        f = _pick(prefs, need_thai)
        if f:
            out.append({"key": key, "label": label, "font": f["family"]})
    return out


def _has_thai(s):
    return any("฀" <= ch <= "๿" for ch in (s or ""))


# ---------------------------------------------------------------- text -> geometry
def _flatten_d(d, samples_per_seg=14):
    """SVG path d -> list of rings (list of (x,y)) โดยแบ่งโค้งเป็นเส้นตรง"""
    from svgpathtools import parse_path
    try:
        path = parse_path(d)
    except Exception:
        return []
    rings = []
    for sub in path.continuous_subpaths():
        pts = []
        L = sub.length(error=1e-3) or 1.0
        for seg in sub:
            try:
                sl = seg.length(error=1e-3)
            except Exception:
                sl = 1.0
            n = max(3, min(48, int(samples_per_seg * max(sl / max(L, 1e-6), 0.02) * 8) + 3))
            for i in range(n):
                p = seg.point(i / float(n))
                pts.append((p.real, p.imag))
        if len(pts) >= 3:
            rings.append(pts)
    return rings


def _rings_to_geom(rings):
    """รวม ring แบบ even-odd (นอก XOR ใน) -> shapely"""
    polys = []
    for r in rings:
        try:
            p = Polygon(r)
            if not p.is_valid:
                p = p.buffer(0)
            if p.is_empty:
                continue
            polys.append(p)
        except Exception:
            continue
    if not polys:
        return None
    polys.sort(key=lambda p: -p.area)
    g = polys[0]
    for p in polys[1:]:
        try:
            g = g.symmetric_difference(p)
        except Exception:
            continue
    return g


def text_geom(text, font_path, size_mm=100.0, tracking=0.0):
    """
    ข้อความ -> shapely (mm, y ชี้ลง) เวกเตอร์จริง
    ใช้ HarfBuzz จัดวาง (รองรับสระ/วรรณยุกต์ไทยถูกตำแหน่ง)
    """
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen

    tt = TTFont(font_path, fontNumber=0)
    upem = tt["head"].unitsPerEm or 1000
    gs = tt.getGlyphSet()
    order = tt.getGlyphOrder()

    # --- shaping
    runs = []   # (glyph_name, x, y)  หน่วย font units
    try:
        import uharfbuzz as hb
        with open(font_path, "rb") as fh:
            data = fh.read()
        face = hb.Face(data)
        hbf = hb.Font(face)
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(hbf, buf, {"kern": True, "liga": True})
        x = 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            gid = info.codepoint
            gname = order[gid] if gid < len(order) else None
            if gname:
                runs.append((gname, x + pos.x_offset, pos.y_offset))
            x += pos.x_advance + tracking * upem / 100.0
    except Exception:
        # fallback: cmap + advance (อังกฤษพอใช้)
        cmap = tt.getBestCmap() or {}
        hmtx = tt["hmtx"]
        x = 0.0
        for ch in text:
            gn = cmap.get(ord(ch))
            if not gn:
                x += upem * 0.3
                continue
            runs.append((gn, x, 0.0))
            try:
                x += hmtx[gn][0] + tracking * upem / 100.0
            except Exception:
                x += upem * 0.5

    # --- outlines
    rings = []
    for gname, gx, gy in runs:
        try:
            pen = SVGPathPen(gs)
            gs[gname].draw(pen)
            d = pen.getCommands()
        except Exception:
            continue
        if not d:
            continue
        for r in _flatten_d(d):
            # font units (y ขึ้น) -> mm (y ลง)
            rings.append([((px + gx), -(py + gy)) for px, py in r])
    tt.close()

    g = _rings_to_geom(rings)
    if g is None or g.is_empty:
        return None

    # สเกลให้ "ความสูงตัวอักษรจริง" = size_mm
    b = g.bounds
    h = b[3] - b[1]
    if h <= 0:
        return None
    s = float(size_mm) / h
    g = aff_scale(g, xfact=s, yfact=s, origin=(0, 0))
    b = g.bounds
    g = translate(g, -b[0], -b[1])
    return g


# ---------------------------------------------------------------- layouts
def _rrect(x0, y0, x1, y1, r):
    r = max(0.0, min(r, (x1 - x0) / 2 - 0.1, (y1 - y0) / 2 - 0.1))
    if r <= 0.2:
        return box(x0, y0, x1, y1)
    return box(x0 + r, y0, x1 - r, y1).union(box(x0, y0 + r, x1, y1 - r)) \
        .union(Point(x0 + r, y0 + r).buffer(r)).union(Point(x1 - r, y0 + r).buffer(r)) \
        .union(Point(x0 + r, y1 - r).buffer(r)).union(Point(x1 - r, y1 - r).buffer(r))


LAYOUTS = [
    ("plain",     "ตัวอักษรล้วน"),
    ("outline",   "ตัวอักษร + คิ้วรอบ"),
    ("underline", "ตัวอักษร + เส้นใต้"),
    ("plate",     "แผ่นป้าย (ตัวอักษรโบ๋)"),
    ("badge",     "ตราวงกลม"),
    ("frame",     "กรอบสี่เหลี่ยม"),
    ("stacked",   "ชื่อ + คำบรรยาย"),
]


def build_layout(kind, main_g, sub_g=None, cap_mm=100.0):
    """
    ประกอบเลย์เอาต์ -> shapely (mm)
    main_g = ข้อความหลัก (วางที่ 0,0 แล้ว) · sub_g = ข้อความรอง (ถ้ามี)
    """
    if main_g is None or main_g.is_empty:
        return None
    b = main_g.bounds
    W = b[2] - b[0]
    H = b[3] - b[1]
    k = cap_mm / 100.0            # สเกลอ้างอิงตามความสูงตัวอักษร

    if kind == "plain":
        return main_g

    if kind == "outline":
        rim = main_g.buffer(6 * k, join_style=2, mitre_limit=4.0, resolution=12)
        return unary_union([rim.difference(main_g.buffer(2 * k, join_style=2)), main_g])

    if kind == "underline":
        bar = box(b[0], b[3] + 8 * k, b[2], b[3] + 8 * k + 10 * k)
        return unary_union([main_g, bar])

    if kind == "plate":
        pad = 18 * k
        plate = _rrect(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 12 * k)
        return plate.difference(main_g)

    if kind == "badge":
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        # วงกลมล้อมข้อความพอดี (circumscribed) + ระยะขอบ — ไม่ใหญ่เวอร์
        R = 0.5 * math.hypot(W, H) + 24 * k
        ring = Point(cx, cy).buffer(R).difference(Point(cx, cy).buffer(R - 7 * k))
        disc = Point(cx, cy).buffer(R - 14 * k)
        return unary_union([ring, disc.difference(main_g)])

    if kind == "frame":
        pad = 20 * k
        outer = box(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)
        inner = box(b[0] - pad + 7 * k, b[1] - pad + 7 * k,
                    b[2] + pad - 7 * k, b[3] + pad - 7 * k)
        return unary_union([outer.difference(inner), main_g])

    if kind == "stacked":
        parts = [main_g]
        if sub_g is not None and not sub_g.is_empty:
            sb = sub_g.bounds
            sw = sb[2] - sb[0]
            s2 = translate(sub_g, (b[0] + W / 2) - (sb[0] + sw / 2),
                           b[3] + 12 * k - sb[1])
            parts.append(s2)
            parts.append(box(b[0] + W * 0.2, b[3] + 5 * k,
                             b[0] + W * 0.8, b[3] + 5 * k + 2.5 * k))
        return unary_union(parts)

    return main_g


def concept_svg(g, width_px=340, fill="#1f2733", bg="#f4f6fa"):
    """SVG พรีวิว — สีอยู่ใน <style> เพื่อให้ frontend เปลี่ยนสี/ใส่เอฟเฟกต์ไฟได้สด ๆ"""
    if g is None or g.is_empty:
        return ""
    b = g.bounds
    pad = max(b[2] - b[0], b[3] - b[1]) * 0.06 + 2
    x0, y0 = b[0] - pad, b[1] - pad
    W, H = (b[2] - b[0]) + 2 * pad, (b[3] - b[1]) + 2 * pad

    def ring(cs):
        return "M " + " L ".join("%.2f,%.2f" % (x - x0, y - y0) for x, y in cs) + " Z"

    ps = []
    geoms = g.geoms if getattr(g, "geom_type", "") == "MultiPolygon" else [g]
    for p in geoms:
        if getattr(p, "geom_type", "") != "Polygon" or p.is_empty:
            continue
        d = ring(list(p.exterior.coords))
        for r in p.interiors:
            d += " " + ring(list(r.coords))
        ps.append('<path class="cc-art" d="%s" fill-rule="evenodd"/>' % d)
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%dpx" viewBox="0 0 %.2f %.2f">'
            '<style>.cc-bg{fill:%s}.cc-art{fill:%s}</style>'
            '<rect class="cc-bg" width="%.2f" height="%.2f"/>%s</svg>'
            % (width_px, W, H, bg, fill, W, H, "".join(ps)))


def concept_svg_mm(g, fill="#000000"):
    """SVG หน่วย mm จริง (เอาไปแปลง .ai / เข้าชุดชั้นตัดได้)"""
    if g is None or g.is_empty:
        return ""
    b = g.bounds
    W, H = b[2] - b[0], b[3] - b[1]
    gg = translate(g, -b[0], -b[1])

    def ring(cs):
        return "M " + " L ".join("%.3f,%.3f" % (x, y) for x, y in cs) + " Z"

    ps = []
    geoms = gg.geoms if getattr(gg, "geom_type", "") == "MultiPolygon" else [gg]
    for p in geoms:
        if getattr(p, "geom_type", "") != "Polygon" or p.is_empty:
            continue
        d = ring(list(p.exterior.coords))
        for r in p.interiors:
            d += " " + ring(list(r.coords))
        ps.append('<path d="%s" fill="%s" fill-rule="evenodd"/>' % (d, fill))
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%.3fmm" height="%.3fmm" '
            'viewBox="0 0 %.3f %.3f">%s</svg>' % (W, H, W, H, "".join(ps)))


# ---------------------------------------------------------------- perspective 3D
def _rings_of(poly):
    rs = [list(poly.exterior.coords)]
    for r in poly.interiors:
        rs.append(list(r.coords))
    return rs


def perspective_svg(g, depth_mm=50.0, width_px=760,
                    face="#cfd4dc", side="#98a0ac", edge="#5c6470",
                    bg="#0f1319", dims=True, label=""):
    """
    ภาพ perspective (oblique extrude) — เห็น 'ขอบด้านข้าง' ตามความหนายกขอบจริง
    คลาสใน SVG:  .cc-side (ผนังข้าง) · .cc-face (หน้า) · .cc-edge (เส้นขอบ)
    -> frontend เปลี่ยนสี/ใส่เอฟเฟกต์ไฟได้สด ๆ
    """
    if g is None or g.is_empty:
        return ""
    comps = [p for p in (g.geoms if getattr(g, "geom_type", "") == "MultiPolygon" else [g])
             if getattr(p, "geom_type", "") == "Polygon" and not p.is_empty]
    if not comps:
        return ""

    d = max(0.0, float(depth_mm))
    dvx = d * 0.60          # ทิศยื่นออก (ขวา-บน) — มุมมองมาตรฐานงานป้าย
    dvy = -d * 0.42

    b = g.bounds
    W0, H0 = b[2] - b[0], b[3] - b[1]
    m = max(W0, H0)
    fs = max(m * 0.028, 7.0)
    padL = m * 0.085 + fs * 2.6
    padT = m * 0.055 + fs * 1.2
    padB = m * 0.055 + fs * 2.8
    padR = m * 0.03 + (fs * 8.5 if d > 0.01 else fs * 1.2)   # เผื่อป้าย "ยกขอบ x cm"

    x0 = b[0] - padL
    y0 = b[1] + min(0.0, dvy) - padT
    W = W0 + max(0.0, dvx) + padL + padR
    H = H0 + abs(dvy) + padT + padB

    def T(x, y):
        return (x - x0, y - y0)

    def dpath(pts, close=True):
        s = "M " + " L ".join("%.2f,%.2f" % T(px, py) for px, py in pts)
        return s + (" Z" if close else "")

    sw = max(m * 0.0016, 0.35)
    out = []

    # ---- ผนังข้าง (เฉพาะด้านที่คนดูเห็น) + แรเงาตามทิศ (ทำให้ดูมีมิติจริง)
    if d > 0.01:
        lx_, ly_ = 0.45, -0.89          # ทิศแสงหลัก (บน-ขวา)
        quads = []
        for p in comps:
            cx, cy = p.centroid.x, p.centroid.y
            for ring in _rings_of(p):
                n = len(ring)
                for i in range(n - 1):
                    ax, ay = ring[i]
                    bx, by = ring[i + 1]
                    ex, ey = bx - ax, by - ay
                    L = math.hypot(ex, ey)
                    if L < 1e-9:
                        continue
                    nx, ny = ey / L, -ex / L
                    mx, my = (ax + bx) / 2, (ay + by) / 2
                    if (mx - cx) * nx + (my - cy) * ny < 0:
                        nx, ny = -nx, -ny
                    if nx * dvx + ny * dvy <= 1e-6:
                        continue
                    lam = nx * lx_ + ny * ly_                 # -1..1
                    shade = 0.34 * (1.0 - (lam + 1.0) / 2.0)  # 0 (สว่าง) .. 0.34 (มืด)
                    quads.append((((ax, ay), (bx, by),
                                   (bx + dvx, by + dvy), (ax + dvx, ay + dvy)),
                                  (mx - cx) * dvx + (my - cy) * dvy, shade))
        quads.sort(key=lambda q: q[1])                        # ไกล -> ใกล้
        # ผนังทั้งหมด: fill=สีข้าง + stroke สีเดียวกัน (ปิดรอยต่อ ไม่เป็นริ้ว)
        for q, _z, _s in quads:
            out.append('<path class="cc-side" d="%s" fill="%s" stroke="%s" '
                       'stroke-width="%.2f" stroke-linejoin="round"/>'
                       % (dpath(list(q)), side, side, sw * 1.1))
        # เงา: ทับด้วยดำโปร่ง -> ไม่ผูกกับสี เปลี่ยนสีข้างได้อิสระ
        for q, _z, s_ in quads:
            if s_ > 0.015:
                out.append('<path class="cc-shade" d="%s" fill="#000" opacity="%.3f" '
                           'stroke="#000" stroke-opacity="%.3f" stroke-width="%.2f"/>'
                           % (dpath(list(q)), s_, s_, sw * 1.1))

    # ---- หน้าป้าย
    for p in comps:
        dd = " ".join(dpath(r) for r in _rings_of(p))
        out.append('<path class="cc-face" d="%s" fill="%s" fill-rule="evenodd" '
                   'stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                   % (dd, face, edge, sw))

    # ---- เส้นบอกขนาด
    if dims:
        gcol = "#8b95a4"
        lw = max(m * 0.0011, 0.3)
        yb = b[3] + m * 0.048
        xl = b[0] - m * 0.048
        tick = m * 0.012
        out.append('<g class="cc-dim" stroke="%s" stroke-width="%.2f" fill="none" '
                   'stroke-linecap="round">'
                   '<path d="%s"/><path d="%s"/><path d="%s"/><path d="%s"/>'
                   '<path d="%s"/><path d="%s"/></g>'
                   % (gcol, lw,
                      dpath([(b[0], yb), (b[2], yb)], False),
                      dpath([(b[0], yb - tick), (b[0], yb + tick)], False),
                      dpath([(b[2], yb - tick), (b[2], yb + tick)], False),
                      dpath([(xl, b[1]), (xl, b[3])], False),
                      dpath([(xl - tick, b[1]), (xl + tick, b[1])], False),
                      dpath([(xl - tick, b[3]), (xl + tick, b[3])], False)))
        cxw = T((b[0] + b[2]) / 2, yb + fs * 1.25)
        out.append('<text x="%.1f" y="%.1f" font-size="%.1f" fill="%s" text-anchor="middle" '
                   'font-family="system-ui,sans-serif" font-weight="600">%.0f mm</text>'
                   % (cxw[0], cxw[1], fs, gcol, W0))
        cyh = T(xl - fs * 0.55, (b[1] + b[3]) / 2)
        out.append('<text x="%.1f" y="%.1f" font-size="%.1f" fill="%s" text-anchor="middle" '
                   'font-family="system-ui,sans-serif" font-weight="600" '
                   'transform="rotate(-90 %.1f %.1f)">%.0f mm</text>'
                   % (cyh[0], cyh[1], fs, gcol, cyh[0], cyh[1], H0))
        if d > 0.01:
            ex_, ey_ = b[2], b[1]
            out.append('<g class="cc-dim" stroke="%s" stroke-width="%.2f" fill="none" '
                       'stroke-linecap="round"><path d="%s"/></g>'
                       % (gcol, lw, dpath([(ex_, ey_), (ex_ + dvx, ey_ + dvy)], False)))
            px, py = T(ex_ + dvx + m * 0.015, ey_ + dvy + fs * 0.35)
            out.append('<text x="%.1f" y="%.1f" font-size="%.1f" fill="%s" '
                       'font-family="system-ui,sans-serif" font-weight="600">ยกขอบ %s cm</text>'
                       % (px, py, fs, gcol, ("%.1f" % (d / 10.0)).rstrip("0").rstrip(".")))
        if label:
            lx2, ly2 = T(b[0] - m * 0.045, b[3] + m * 0.048 + fs * 2.6)
            out.append('<text x="%.1f" y="%.1f" font-size="%.1f" fill="%s" font-weight="700" '
                       'font-family="system-ui,sans-serif">%s</text>'
                       % (lx2, ly2, fs * 0.95, gcol, _esc(label)))

    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%dpx" viewBox="0 0 %.2f %.2f">'
            '<rect class="cc-bg" width="%.2f" height="%.2f" fill="%s"/>%s</svg>'
            % (width_px, W, H, W, H, bg, "".join(out)))


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ---------------------------------------------------------------- generate
def generate(name, sub="", styles=None, layouts=None, cap_mm=100.0):
    """
    สร้างชุดคอนเซปต์ = สไตล์ฟอนต์ × เลย์เอาต์
    คืน list ของ {id, style, style_label, font, layout, layout_label, svg, geom}
    """
    name = (name or "").strip()
    if not name:
        return []
    need_thai = _has_thai(name) or _has_thai(sub)
    styles = styles or ["bold-modern", "condensed", "rounded", "classic"]
    layouts = layouts or ["plain", "outline", "underline", "plate", "badge", "frame"]

    smap = {k: (lbl, prefs) for k, lbl, prefs in STYLE_PREF}
    out = []
    cid = 0
    for sk in styles:
        if sk not in smap:
            continue
        lbl, prefs = smap[sk]
        f = _pick(prefs, need_thai)
        if not f:
            continue
        try:
            mg = text_geom(name, f["path"], size_mm=cap_mm)
        except Exception:
            mg = None
        if mg is None or mg.is_empty:
            continue
        sg = None
        if sub:
            try:
                sg = text_geom(sub, f["path"], size_mm=cap_mm * 0.32)
            except Exception:
                sg = None
        for lk in layouts:
            llbl = dict(LAYOUTS).get(lk, lk)
            if lk == "stacked" and sg is None:
                continue
            try:
                g = build_layout(lk, mg, sg, cap_mm=cap_mm)
            except Exception:
                g = None
            if g is None or g.is_empty:
                continue
            cid += 1
            b = g.bounds
            out.append({
                "id": cid, "style": sk, "style_label": lbl, "font": f["family"],
                "layout": lk, "layout_label": llbl,
                "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                "svg": concept_svg(g),
                "geom": g,
            })
    return out


# ---------------------------------------------------------------- name ideas (fallback)
_BIZ = {
    "cafe":     (["Brew", "Bean", "Roast", "Daily", "Morning", "Cup"],
                 ["คั่ว", "เมล็ด", "อรุณ", "บ้านกาแฟ", "ชงรัก"]),
    "food":     (["Kitchen", "Table", "Spoon", "Flame", "Craft"],
                 ["ครัว", "อิ่ม", "รสเด็ด", "จานโปรด", "เตาไฟ"]),
    "beauty":   (["Glow", "Bloom", "Aura", "Lumi", "Grace"],
                 ["เปล่งประกาย", "ผิวใส", "งามพร้อม", "ลุมิ"]),
    "clinic":   (["Care", "Vital", "Renew", "Pure", "Medi"],
                 ["ใส่ใจ", "ฟื้นฟู", "เวชกร", "สุขภาพดี"]),
    "auto":     (["Motor", "Gear", "Torque", "Drive", "Pit"],
                 ["ช่างยนต์", "เกียร์", "ล้อทอง", "ขับดี"]),
    "shop":     (["House", "Store", "Mart", "Hub", "Corner"],
                 ["บ้าน", "ร้าน", "มุมของ", "ครบครัน"]),
    "hotel":    (["Stay", "Nest", "Haven", "Vista", "Loft"],
                 ["พักใจ", "รังนอน", "วิวดี", "บ้านพัก"]),
    "fitness":  (["Forge", "Iron", "Peak", "Pulse", "Core"],
                 ["เหล็ก", "พลัง", "ยอดเขา", "แกร่ง"]),
}
_SUFFIX_EN = ["Co.", "Studio", "House", "Lab", "& Co", "Works", "Club"]
_SUFFIX_TH = ["สตูดิโอ", "เฮ้าส์", "แล็บ", "คลับ", "โฮม"]


def name_ideas(biz="shop", tone="modern", lang="both", n=10):
    """เจนชื่อร้านแบบไม่ต้องใช้ AI (ใช้เป็น fallback ถ้าไม่มี API key)"""
    en, th = _BIZ.get(str(biz).lower(), _BIZ["shop"])
    out = []
    for i, w in enumerate(en):
        out.append({"name": "%s %s" % (w, _SUFFIX_EN[i % len(_SUFFIX_EN)]),
                    "why": "อ่านง่าย เหมาะกับป้ายตัวอักษรโลหะ"})
    for i, w in enumerate(th):
        out.append({"name": "%s%s" % (w, " " + _SUFFIX_TH[i % len(_SUFFIX_TH)] if i % 2 else ""),
                    "why": "สั้น จำง่าย ตัดเป็นตัวอักษรได้สวย"})
    return out[:n]
