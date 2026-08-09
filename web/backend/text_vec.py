# -*- coding: utf-8 -*-
"""✍️🎨 สร้าง "ข้อความ" และ "พื้นหลัง" เป็นเวกเตอร์แท้ — ใช้ทำโลโก้แบรนด์ให้จบในหน้าเดียว

ทำไมต้องมีโมดูลนี้
──────────────────
หน้า "แตกชิ้น + เลือก + จัดวาง" เดิมทำได้แค่ 'หยิบของจากไฟล์ลูกค้า' มาวาง
แต่เวลาทำโลโก้แบรนด์จริง ยังขาดอีกสองอย่างที่ต้องไปหาจากโปรแกรมอื่น:
   1) ข้อความ (ชื่อร้าน · เบอร์โทร · คำโปรย) ที่พิมพ์เองได้ เลือกฟอนต์ได้
   2) พื้นหลัง (สีพื้น · ไล่สี · ไฟล์ artwork) ที่จะเป็นหน้ากล่องไฟ/แผ่นรอง
โมดูลนี้เติมสองอย่างนั้น แล้วส่งออกมาเป็น "ชิ้นงานหน้าตาเดียวกับชิ้นที่แตกจากไฟล์"
สายงานเดิมทั้งเส้น (ลากวาง · ย่อขยาย · จัดตำแหน่ง · รวมเป็นเวกเตอร์แท้) จึงใช้ได้ทันที
โดยไม่ต้องแก้อะไรเลย และไม่มีหน้าจอใหม่ให้ผู้ใช้งง

⚠️ กติกาที่ห้ามพลาด — ข้อความไทย
──────────────────────────────
ตัวอักษรไทยวาง 'สระบน/สระล่าง/วรรณยุกต์' ซ้อนบนพยัญชนะ ไม่ใช่เรียงต่อกันแบบอังกฤษ
ถ้าเดินตัวอักษรด้วยความกว้าง (advance) ตรง ๆ อย่างเดียว → สระกับวรรณยุกต์จะหลุดไปอยู่ผิดที่
จึงต้องผ่าน HarfBuzz (uharfbuzz) ซึ่งเป็นตัวจัดวางตัวอักษรตัวเดียวกับที่เบราว์เซอร์ใช้
   ✅ ได้ตำแหน่ง x_offset / y_offset ของสระและวรรณยุกต์ถูกต้องเป๊ะ
   ⛔ ถ้า import uharfbuzz ไม่ได้ โมดูลนี้จะ 'ปฏิเสธข้อความไทย' ไปเลย
      (ยอมให้ผู้ใช้เห็นข้อความเตือน ดีกว่าปล่อยไฟล์ตัดที่สระลอยผิดที่ออกไปโรงงาน)

⚠️ ความคมของเส้น
   เส้นตัวอักษรดึงจาก 'เส้นโค้งเบซิเยร์ในไฟล์ฟอนต์' ตรง ๆ (fontTools) ไม่ผ่านภาพเลยสักขั้น
   -> ขยายกี่เท่าก็คม ไม่มีบันไดพิกเซล ไม่ต้องเทรซกลับ
"""
import io
import os
import re
import base64

_FONT_DIR = None
_CAT = None
_FACE_CACHE = {}


# ══════════════════════════════════════════════════════════════════
#  คลังฟอนต์
# ══════════════════════════════════════════════════════════════════
def font_dir():
    global _FONT_DIR
    if _FONT_DIR:
        return _FONT_DIR
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [
        os.path.join(here, "..", "frontend", "fonts"),
        os.path.join(here, "fonts"),
        os.path.join(here, "..", "..", "web", "frontend", "fonts"),
    ]
    for c in cands:
        c = os.path.abspath(c)
        if os.path.isdir(c):
            _FONT_DIR = c
            return c
    _FONT_DIR = os.path.abspath(cands[0])
    return _FONT_DIR


def _pretty(fname):
    """Prompt-Bold.ttf -> 'Prompt Bold' · Oswald-Variable.ttf -> 'Oswald'"""
    n = re.sub(r"\.(ttf|otf)$", "", fname, flags=re.I)
    n = re.sub(r"-(Variable|Regular)$", "", n, flags=re.I)
    n = n.replace("-", " ")
    n = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def catalog(refresh=False):
    """คืนรายการฟอนต์ที่มีในเครื่อง + บอกว่าตัวไหน 'พิมพ์ไทยได้จริง'

    ตรวจไทยจากตาราง cmap ของไฟล์ฟอนต์เอง (ต้องมีทั้งพยัญชนะ ก · สระอิ · วรรณยุกต์เอก)
    ไม่ใช่เดาจากชื่อไฟล์ — ฟอนต์อังกฤษหลายตัวชื่อดูไทยแต่ไม่มีตัวอักษรไทยอยู่จริง
    """
    global _CAT
    if _CAT is not None and not refresh:
        return _CAT
    from fontTools.ttLib import TTFont
    d = font_dir()
    out = []
    try:
        names = sorted(os.listdir(d))
    except Exception:
        names = []
    for fn in names:
        if not fn.lower().endswith((".ttf", ".otf")):
            continue
        p = os.path.join(d, fn)
        try:
            f = TTFont(p, fontNumber=0, lazy=True)
            cm = f.getBestCmap() or {}
            thai = all(ord(c) in cm for c in ("ก", "ิ", "่"))
            latin = all(ord(c) in cm for c in ("A", "a", "1"))
            f.close()
        except Exception:
            continue
        out.append({"file": fn, "name": _pretty(fn), "thai": bool(thai),
                    "latin": bool(latin), "cat": "th" if thai else "en"})
    # ไทยขึ้นก่อนเสมอ (ลูกค้าส่วนใหญ่พิมพ์ไทย) แล้วเรียงตามชื่อ
    out.sort(key=lambda a: (0 if a["thai"] else 1, a["name"].lower()))
    _CAT = out
    return out


def resolve_font(name_or_file):
    """รับได้ทั้งชื่อไฟล์ ('Prompt-Bold.ttf') และชื่อที่คนเรียก ('Prompt Bold')"""
    d = font_dir()
    s = os.path.basename(str(name_or_file or "").strip())
    if s and os.path.exists(os.path.join(d, s)):
        return os.path.join(d, s)
    low = re.sub(r"\s+", "", str(name_or_file or "")).lower()
    for it in catalog():
        if re.sub(r"\s+", "", it["name"]).lower() == low or it["file"].lower() == low:
            return os.path.join(d, it["file"])
    return None


def _face(path):
    """เปิดฟอนต์ครั้งเดียวแล้วจำไว้ (เปิดใหม่ทุกครั้งช้ามาก เพราะไฟล์ไทยตัวละ 100-400 KB)"""
    st = _FACE_CACHE.get(path)
    if st:
        return st
    import uharfbuzz as hb
    from fontTools.ttLib import TTFont
    blob = hb.Blob.from_file_path(path)
    face = hb.Face(blob)
    hbf = hb.Font(face)
    upem = int(face.upem or 1000)
    hbf.scale = (upem, upem)
    tt = TTFont(path, fontNumber=0, lazy=True)
    gs = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    try:
        hh = tt["hhea"]
        asc, desc = float(hh.ascent), float(hh.descent)
    except Exception:
        asc, desc = upem * 0.8, -upem * 0.2
    st = {"hb": hbf, "gs": gs, "order": order, "upem": upem,
          "asc": asc, "desc": desc, "tt": tt, "cmap": tt.getBestCmap() or {}}
    _FACE_CACHE[path] = st
    return st


# ══════════════════════════════════════════════════════════════════
#  ข้อความ -> เส้นโค้งจริง
# ══════════════════════════════════════════════════════════════════
def _glyph_d(gs, gname):
    from fontTools.pens.svgPathPen import SVGPathPen
    try:
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        return pen.getCommands() or ""
    except Exception:
        return ""


_TH_RE = re.compile(r"[฀-๿]")


def has_thai(s):
    return bool(_TH_RE.search(str(s or "")))


def _shape_line(st, line, track_em):
    """คืน (glyphs, width) — glyphs = [(gname, x, y)] ในหน่วยของฟอนต์ (y ชี้ขึ้น)

    ⚠️ ใช้ HarfBuzz เท่านั้น: สระ/วรรณยุกต์ไทยมี advance = 0 แต่มี offset
       ถ้าไม่ผ่านตัวจัดวางนี้ สระจะไปกองอยู่หลังพยัญชนะแทนที่จะซ้อนอยู่ข้างบน
    """
    import uharfbuzz as hb
    buf = hb.Buffer()
    buf.add_str(line)
    buf.guess_segment_properties()
    hb.shape(st["hb"], buf, {"kern": True, "liga": True})
    order = st["order"]
    upem = st["upem"]
    tr = float(track_em) * upem
    gl = []
    x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        gid = int(info.codepoint)
        gname = order[gid] if 0 <= gid < len(order) else None
        if gname:
            gl.append((gname, x + float(pos.x_offset), float(pos.y_offset)))
        adv = float(pos.x_advance)
        x += adv
        if adv > 0:                      # ระยะห่างเพิ่มเฉพาะตัวที่กินความกว้างจริง
            x += tr                      # (สระ/วรรณยุกต์ advance=0 ห้ามบวก ไม่งั้นหลุดตำแหน่ง)
    if gl and tr:
        x -= tr
    return gl, x


def text_svg(text, font_file, size_mm=100.0, color="#111111", tracking=0.0,
             line_gap=1.00, align="center", italic=0.0,
             outline_mm=0.0, outline_color="#ffffff"):
    """คืน (svg_str, mm_per_unit) — ข้อความเป็น <path> เส้นโค้งจริงจากไฟล์ฟอนต์

    size_mm  = ความสูงของ 'ตัวอักษรเต็มบรรทัด' (em) เป็นมิลลิเมตร — คงที่ไม่ว่าจะพิมพ์อะไร
    outline_mm = ขอบรอบตัวอักษร (วาดเป็นเส้นหนารองข้างหลัง แล้วทับด้วยตัวจริง)
    """
    p = resolve_font(font_file)
    if not p:
        raise ValueError("ไม่พบฟอนต์ '%s' ในเครื่อง" % font_file)
    st = _face(p)
    upem = st["upem"]
    if has_thai(text) and not st["cmap"].get(ord("ก")):
        raise ValueError("ฟอนต์ '%s' ไม่มีตัวอักษรไทย — เลือกฟอนต์ในกลุ่ม 'ไทย' นะคะ" % _pretty(os.path.basename(p)))

    lines = [l for l in str(text or "").replace("\r", "").split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        raise ValueError("ยังไม่ได้พิมพ์ข้อความ")

    # ระยะบรรทัด = ระยะที่ไฟล์ฟอนต์กำหนดไว้เอง (asc-desc) คูณตัวปรับของผู้ใช้
    #   ฟอนต์ไทยเผื่อที่ให้สระบน/ล่างไว้แล้ว (1.2-1.6 เท่าของตัวอักษร) -> 1.00 = ระยะเดียวกับที่เห็นในเบราว์เซอร์
    lh = (st["asc"] - st["desc"]) * float(line_gap)
    laid, maxw = [], 1.0
    for ln in lines:
        gl, w = _shape_line(st, ln, tracking)
        laid.append((gl, w))
        maxw = max(maxw, w)

    body = []
    for i, (gl, w) in enumerate(laid):
        dx = (maxw - w) * (0.5 if align == "center" else (1.0 if align == "right" else 0.0))
        base = st["asc"] + i * lh
        for gname, gx, gy in gl:
            d = _glyph_d(st["gs"], gname)
            if not d:
                continue
            body.append('<g transform="translate(%.3f,%.3f) scale(1,-1)"><path d="%s"/></g>'
                        % (gx + dx, base - gy, d))
    if not body:
        raise ValueError("ฟอนต์นี้ไม่มีตัวอักษรที่พิมพ์มาเลย")
    inner = "".join(body)

    mmu = float(size_mm) / float(upem)          # มม. ต่อ 1 หน่วยฟอนต์
    W = maxw + upem * 1.0                       # เผื่อขอบกันเส้นโดนตัด (วัดกรอบจริงทีหลัง)
    H = st["asc"] + lh * (len(laid) - 1) - st["desc"] + upem * 1.0
    ox = upem * 0.5
    oy = upem * 0.5

    layers = []
    if float(outline_mm) > 0:
        sw = float(outline_mm) / mmu * 2.0      # stroke วาดคร่อมเส้น -> ครึ่งเดียวโผล่ออกนอก
        layers.append('<g fill="none" stroke="%s" stroke-width="%.3f" stroke-linejoin="round" '
                      'stroke-linecap="round">%s</g>' % (_hex(outline_color), sw, inner))
    layers.append('<g fill="%s">%s</g>' % (_hex(color), inner))

    skew = (' transform="skewX(%.2f)"' % (-abs(float(italic)))) if float(italic or 0) else ""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%.4fmm" height="%.4fmm" '
           'viewBox="0 0 %.3f %.3f">'
           '<g transform="translate(%.3f,%.3f)"><g%s>%s</g></g></svg>'
           % (W * mmu, H * mmu, W, H, ox, oy, skew, "".join(layers)))
    return svg, mmu


# ══════════════════════════════════════════════════════════════════
#  พื้นหลัง (สีพื้น · ไล่สี · ไฟล์ artwork)
# ══════════════════════════════════════════════════════════════════
def _hex(c, dflt="#000000"):
    s = str(c or "").strip()
    if re.match(r"^#[0-9a-fA-F]{6}$", s) or re.match(r"^#[0-9a-fA-F]{3}$", s):
        return s
    if re.match(r"^[0-9a-fA-F]{6}$", s):
        return "#" + s
    return dflt


def bg_svg(w_mm=200.0, h_mm=100.0, shape="rect", radius_mm=0.0,
           fill="solid", color1="#2563eb", color2="#7c3aed", angle=90.0,
           art_bytes=None, art_mime="image/png", art_fit="cover",
           border_mm=0.0, border_color="#0f172a", opacity=1.0):
    """คืน svg_str ของแผ่นพื้นหลังขนาดจริง (1 หน่วย = 1 มม.)

    art_fit: cover = เต็มแผ่นแบบไม่บิดสัดส่วน (ส่วนเกินถูกตัด) · contain = เห็นทั้งรูป · stretch = ยืดเต็ม
    """
    W = max(1.0, float(w_mm))
    H = max(1.0, float(h_mm))
    r = max(0.0, min(float(radius_mm or 0), min(W, H) / 2.0))
    defs, paint = [], ""

    if fill == "grad":
        a = float(angle or 0) * 3.141592653589793 / 180.0
        import math
        dx, dy = math.cos(a), math.sin(a)
        x1, y1 = 0.5 - dx / 2, 0.5 - dy / 2
        x2, y2 = 0.5 + dx / 2, 0.5 + dy / 2
        defs.append('<linearGradient id="vgg" x1="%.4f" y1="%.4f" x2="%.4f" y2="%.4f">'
                    '<stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>'
                    % (x1, y1, x2, y2, _hex(color1), _hex(color2)))
        paint = "url(#vgg)"
    else:
        paint = _hex(color1)

    if shape == "ellipse":
        body = '<ellipse cx="%.3f" cy="%.3f" rx="%.3f" ry="%.3f"' % (W / 2, H / 2, W / 2, H / 2)
        shape_attr = body
        clip = '<ellipse cx="%.3f" cy="%.3f" rx="%.3f" ry="%.3f"/>' % (W / 2, H / 2, W / 2, H / 2)
    else:
        shape_attr = '<rect x="0" y="0" width="%.3f" height="%.3f" rx="%.3f" ry="%.3f"' % (W, H, r, r)
        clip = '<rect x="0" y="0" width="%.3f" height="%.3f" rx="%.3f" ry="%.3f"/>' % (W, H, r, r)

    parts = ['%s fill="%s" fill-opacity="%.3f"/>' % (shape_attr, paint, max(0.0, min(1.0, float(opacity or 1))))]

    if fill == "art" and art_bytes:
        # 🖼️ ไฟล์ artwork ฝังลงไปในแผ่นเลย (ตัดขอบตามรูปทรงแผ่น) — ผู้ใช้ออกแบบหน้ากล่องไฟเองได้
        b64 = base64.b64encode(art_bytes).decode()
        par = {"cover": 'xMidYMid slice', "contain": 'xMidYMid meet',
               "stretch": 'none'}.get(str(art_fit), 'xMidYMid slice')
        defs.append('<clipPath id="vgc">%s</clipPath>' % clip)
        parts.append('<g clip-path="url(#vgc)"><image x="0" y="0" width="%.3f" height="%.3f" '
                     'preserveAspectRatio="%s" xlink:href="data:%s;base64,%s"/></g>'
                     % (W, H, par, art_mime or "image/png", b64))

    if float(border_mm or 0) > 0:
        bw = float(border_mm)
        parts.append('%s fill="none" stroke="%s" stroke-width="%.3f"/>'
                     % (shape_attr, _hex(border_color), bw))

    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'width="%.4fmm" height="%.4fmm" viewBox="0 0 %.3f %.3f">%s%s</svg>'
            % (W, H, W, H, ("<defs>%s</defs>" % "".join(defs)) if defs else "", "".join(parts)))


# ══════════════════════════════════════════════════════════════════
#  SVG -> PDF เวกเตอร์ + วัดกรอบเนื้อจริง + รูปพรีวิว
# ══════════════════════════════════════════════════════════════════
def svg_to_pdf(svg_str):
    import cairosvg
    return cairosvg.svg2pdf(bytestring=svg_str.encode("utf-8"))


def ink_rect(pdf_bytes, pad_pt=0.35):
    """หา 'กรอบเนื้อจริง' ของหน้า PDF (ตัดที่ว่างรอบ ๆ ทิ้ง)

    ทำไมต้องวัดจากไฟล์: ความกว้างจริงของข้อความขึ้นกับตัวอักษรที่พิมพ์
    คำนวณจากตารางฟอนต์ล้วน ๆ จะพลาดที่หางตัวอักษรที่ยื่นเกิน advance (ฟอนต์คัดลายมือยื่นเยอะมาก)
    """
    import fitz
    d = fitz.open("pdf", pdf_bytes)
    try:
        pg = d[0]
        R = None
        try:
            for g in pg.get_drawings():
                r = g.get("rect")
                if r is None or r.is_empty:
                    continue
                R = r if R is None else (R | r)
        except Exception:
            R = None
        try:
            for im in pg.get_image_info():
                r = fitz.Rect(im["bbox"])
                if not r.is_empty:
                    R = r if R is None else (R | r)
        except Exception:
            pass
        if R is None or R.is_empty:
            return tuple(pg.rect)
        R = fitz.Rect(R.x0 - pad_pt, R.y0 - pad_pt, R.x1 + pad_pt, R.y1 + pad_pt) & pg.rect
        if R.is_empty or R.width < 0.2 or R.height < 0.2:
            return tuple(pg.rect)
        return (R.x0, R.y0, R.x1, R.y1)
    finally:
        d.close()


def crop_pdf(pdf_bytes, rect):
    """ตัดหน้าให้เหลือแค่กรอบเนื้อ — ยังเป็นเวกเตอร์ 100% (ไม่ raster ไม่แตะเส้นสักเส้น)

    ⚠️ ตั้งใจ 'สร้างหน้าใหม่แล้ววางของเข้าไป' แทนการตั้ง CropBox
       เพราะหน้าที่มี CropBox เลื่อนออกจากศูนย์ ทำให้พิกัด bbox ที่ส่งต่อไปให้
       ขั้นตอนรวมเวกเตอร์ (ซึ่งครอปด้วย redaction) เพี้ยนไปทั้งชิ้น
       หน้าใหม่มีมุมซ้ายบนที่ (0,0) เสมอ -> พิกัดที่ส่งต่อจึงตรงเสมอ
    """
    import fitz
    src = fitz.open("pdf", pdf_bytes)
    try:
        r = fitz.Rect(*rect)
        out = fitz.open()
        pg = out.new_page(width=r.width, height=r.height)
        pg.show_pdf_page(fitz.Rect(0, 0, r.width, r.height), src, 0, clip=r)
        data = out.tobytes(garbage=4, deflate=True, clean=True)
        out.close()
        return data
    finally:
        src.close()


def preview_png(pdf_bytes, max_px=620):
    """รูปพรีวิวพื้นโปร่ง — ใช้ทั้งบนแถบชิ้นงานและบนกระดานจัดวาง"""
    import fitz
    d = fitz.open("pdf", pdf_bytes)
    try:
        pg = d[0]
        r = pg.rect
        z = max(0.4, min(9.0, float(max_px) / max(1.0, max(r.width, r.height))))
        pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), alpha=True)
        return pix.tobytes("png")
    finally:
        d.close()


PT2MM = 25.4 / 72.0


def make_asset(pdf_bytes, tmpdir, name="asset.pdf", crop=True):
    """แปลง PDF ที่สร้างขึ้น -> 'ชิ้นงาน' หน้าตาเดียวกับที่ /api/extract-assets คืนออกมา
       (เก็บไฟล์ไว้บนดิสก์ให้ token ใช้ครอปตอนรวมเวกเตอร์ได้จริง)"""
    import fitz
    if crop:
        pdf_bytes = crop_pdf(pdf_bytes, ink_rect(pdf_bytes))
    path = os.path.join(tmpdir, name)
    with open(path, "wb") as f:
        f.write(pdf_bytes)
    d = fitz.open(path)
    try:
        r = d[0].rect
        bbox = [r.x0, r.y0, r.x1, r.y1]
        w_mm = round(r.width * PT2MM, 2)
        h_mm = round(r.height * PT2MM, 2)
    finally:
        d.close()
    png = preview_png(pdf_bytes)
    return {"path": path, "page": 0, "bbox": bbox, "w_mm": w_mm, "h_mm": h_mm,
            "png": "data:image/png;base64," + base64.b64encode(png).decode()}


# ── ตรวจตัวเองแบบเร็ว (รันไฟล์นี้ตรง ๆ) ───────────────────────────
if __name__ == "__main__":
    import tempfile, sys
    t = tempfile.mkdtemp()
    txt = sys.argv[1] if len(sys.argv) > 1 else "ทำฟัน ปิ๊ง\n081-234-5678"
    fnt = sys.argv[2] if len(sys.argv) > 2 else "Prompt-Bold.ttf"
    s, mmu = text_svg(txt, fnt, size_mm=100, color="#0f172a")
    a = make_asset(svg_to_pdf(s), t, "t.pdf")
    print("ข้อความ: %.1f x %.1f มม. · %s" % (a["w_mm"], a["h_mm"], a["path"]))
    b = make_asset(svg_to_pdf(bg_svg(300, 120, "rect", 12, "grad")), t, "b.pdf", crop=False)
    print("พื้นหลัง: %.1f x %.1f มม." % (b["w_mm"], b["h_mm"]))
    print("ฟอนต์ในเครื่อง %d ตัว · ไทย %d ตัว"
          % (len(catalog()), sum(1 for x in catalog() if x["thai"])))
