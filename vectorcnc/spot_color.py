# -*- coding: utf-8 -*-
"""
spot_color.py — ระบุ "สีพิเศษ" ของป้าย (ไม่เกิน 3 สี) พร้อมเทียบเบอร์ Pantone

ใช้ที่ไหน: ภาพ 3 มิติ (แถบตัวอย่างสี) + ใบสั่งผลิต (การ์ดสี) — ช่างและลูกค้าจะได้เห็น
ตรงกันว่า "สีนี้คือเบอร์อะไร" ไม่ต้องเดาจากภาพบนจอ ซึ่งแต่ละจออกสีไม่เท่ากัน

⚠️ ข้อจำกัดที่ต้องบอกตรง ๆ (พิมพ์กำกับไว้บนเอกสารด้วย):
   สี Pantone เป็นหมึกผสมสำเร็จ ไม่มีค่า RGB ที่ "ถูกต้อง" เพียงค่าเดียว
   ตารางด้านล่างเป็นค่าอ้างอิง sRGB โดยประมาณ (ใช้เทียบหาเบอร์ใกล้เคียง)
   ก่อนผลิตจริงต้องยืนยันกับพัดสี Pantone/TOA ตัวจริงเสมอ

การเทียบสี: แปลง sRGB -> Lab (D65) แล้ววัดระยะแบบ CIE76 (ΔE)
   ΔE ≤ 2  = ตาคนแทบแยกไม่ออก · ΔE ≤ 5 = ใกล้เคียงมาก · ΔE > 10 = ควรเลือกเบอร์เอง
"""

# ── ตารางอ้างอิง Pantone Solid Coated (ค่า sRGB โดยประมาณ) ───────────────
#    คัดเบอร์ที่ใช้จริงบ่อยในงานป้าย + กระจายทั่วสเปกตรัมเพื่อให้ "เบอร์ใกล้เคียง" มีของให้เลือกเสมอ
PANTONE = {
    # ── แม่สีพื้นฐานของระบบ Pantone ──
    "Yellow C": "#FEDD00", "Yellow 012 C": "#FFD700", "Orange 021 C": "#FE5000",
    "Warm Red C": "#F9423A", "Red 032 C": "#EF3340", "Rubine Red C": "#CE0058",
    "Rhodamine Red C": "#E10098", "Purple C": "#BB29BB", "Violet C": "#440099",
    "Blue 072 C": "#10069F", "Reflex Blue C": "#001489", "Process Blue C": "#0085CA",
    "Green C": "#00AB84", "Black C": "#2D2926", "Cool Gray 11 C": "#53565A",
    # ── เหลือง / ส้ม ──
    "100 C": "#F6EB61", "101 C": "#F7EA48", "102 C": "#FCE300", "106 C": "#F9E547",
    "109 C": "#FFD100", "116 C": "#FFCD00", "123 C": "#FFC72C", "124 C": "#EAAA00",
    "130 C": "#F2A900", "137 C": "#FFA300", "144 C": "#ED8B00", "151 C": "#FF8200",
    "158 C": "#E87722", "165 C": "#FF6900", "172 C": "#FA4616", "179 C": "#E03C31",
    # ── แดง / ชมพู ──
    "185 C": "#E4002B", "186 C": "#C8102E", "187 C": "#A6192E", "188 C": "#76232F",
    "199 C": "#D50032", "200 C": "#BA0C2F", "201 C": "#9D2235", "202 C": "#862633",
    "032 C": "#EF3340", "206 C": "#CE0037", "213 C": "#E31C79", "219 C": "#DA1884",
    "226 C": "#D0006F", "234 C": "#A50050", "241 C": "#AF1685", "248 C": "#9B26B6",
    # ── ม่วง / คราม ──
    "254 C": "#8E258D", "266 C": "#753BBD", "267 C": "#5F259F", "268 C": "#582C83",
    "273 C": "#24135F", "280 C": "#012169", "281 C": "#00205B", "282 C": "#041E42",
    "286 C": "#0033A0", "287 C": "#003087", "288 C": "#002D72", "293 C": "#003DA5",
    "294 C": "#002F6C", "300 C": "#005EB8", "301 C": "#004B87", "302 C": "#00587C",
    # ── ฟ้า / เขียวน้ำทะเล ──
    "306 C": "#00B5E2", "307 C": "#0067A0", "308 C": "#00566B", "312 C": "#00A3C4",
    "313 C": "#0092BC", "315 C": "#007377", "319 C": "#2DCCD3", "320 C": "#009CA6",
    "321 C": "#008C95", "326 C": "#00B2A9", "327 C": "#008675", "330 C": "#006F62",
    "3272 C": "#00A499", "3282 C": "#006F62", "3285 C": "#009681",
    # ── เขียว ──
    "332 C": "#9BE3CB", "339 C": "#00B388", "341 C": "#007A53", "347 C": "#009A44",
    "348 C": "#00843D", "349 C": "#046A38", "355 C": "#009639", "356 C": "#007A33",
    "362 C": "#4C9C2E", "368 C": "#78BE20", "375 C": "#97D700", "376 C": "#84BD00",
    "382 C": "#C4D600", "383 C": "#A9C23F", "390 C": "#B5BD00", "397 C": "#BFB800",
    # ── น้ำตาล / ครีม / ดิน ──
    "400 C": "#C9C4BE", "402 C": "#ADA49B", "404 C": "#7C7268", "405 C": "#6A5F55",
    "412 C": "#332B25", "418 C": "#5B6236", "425 C": "#54585A", "432 C": "#333F48",
    "440 C": "#4B3B32", "462 C": "#674230", "469 C": "#653819", "476 C": "#4E3629",
    "477 C": "#5C3327", "484 C": "#9A3324", "490 C": "#5D2A2C", "491 C": "#6B2C2F",
    "496 C": "#F1BFC6", "500 C": "#DE8CA0", "504 C": "#6B2233", "5185 C": "#7C2E3B",
    # ── เทา / เงิน / โลหะ ──
    "422 C": "#9EA2A2", "423 C": "#898D8D", "424 C": "#707372", "426 C": "#25282A",
    "427 C": "#D0D3D4", "428 C": "#C1C6C8", "429 C": "#A2AAAD", "430 C": "#7C878E",
    "431 C": "#5B6770", "433 C": "#1D252D", "877 C": "#8A8D8F", "871 C": "#84754E",
    "Cool Gray 1 C": "#D9D9D6", "Cool Gray 5 C": "#B1B3B3", "Cool Gray 9 C": "#75787B",
    "Warm Gray 3 C": "#BFB8AF", "Warm Gray 7 C": "#968C83",
    # ── ขาว / ดำ (ค่ามาตรฐานงานป้าย) ──
    "White": "#FFFFFF", "Black 6 C": "#101820", "Neutral Black C": "#22201F",
    "Process Black C": "#231F20",
}

# ชื่อไทยกำกับ (ไว้โชว์ให้ช่างอ่านง่าย) — เดาจากค่าสีเอง ไม่ต้องมีในตาราง
_HUE_TH = [(15, "แดง"), (40, "ส้ม"), (68, "เหลือง"), (160, "เขียว"),
           (200, "ฟ้าอมเขียว"), (250, "น้ำเงิน"), (290, "ม่วง"), (335, "ชมพู"), (361, "แดง")]


def hex_to_rgb(h):
    h = str(h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return None


def rgb_to_hex(rgb):
    return "#%02X%02X%02X" % tuple(max(0, min(255, int(round(v)))) for v in rgb)


def _srgb_to_lab(rgb):
    """sRGB (0-255) -> CIE Lab (D65) — สูตรมาตรฐาน ใช้เทียบระยะสีให้ตรงกับสายตาคน"""
    def _lin(u):
        u = u / 255.0
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    r, g, b = (_lin(v) for v in rgb)
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def _f(t):
        return t ** (1.0 / 3.0) if t > 0.008856 else (7.787 * t + 16.0 / 116.0)
    fx, fy, fz = _f(x), _f(y), _f(z)
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))


def delta_e(hex_a, hex_b):
    """ระยะสีแบบ CIE76 — ตัวเลขยิ่งน้อยยิ่งเหมือน"""
    ra, rb = hex_to_rgb(hex_a), hex_to_rgb(hex_b)
    if not ra or not rb:
        return 999.0
    la, lb = _srgb_to_lab(ra), _srgb_to_lab(rb)
    return (sum((la[i] - lb[i]) ** 2 for i in range(3))) ** 0.5


def nearest_pantone(hexv):
    """หาเบอร์ Pantone ที่ใกล้ที่สุดจากค่าสี — คืน (code, hex_ref, deltaE)"""
    best, bd = None, 1e9
    for code, ref in PANTONE.items():
        d = delta_e(hexv, ref)
        if d < bd:
            best, bd = (code, ref), d
    if not best:
        return ("—", hexv, 999.0)
    return (best[0], best[1], round(bd, 1))


def color_name_th(hexv):
    """ชื่อสีภาษาไทยแบบคร่าว ๆ (ขาว/ดำ/เทา หรือชื่อโทนสี)"""
    rgb = hex_to_rgb(hexv)
    if not rgb:
        return "—"
    r, g, b = rgb
    mx, mn = max(rgb), min(rgb)
    if mx >= 245 and (mx - mn) <= 10:
        return "ขาว"
    if mx <= 45:
        return "ดำ"
    if (mx - mn) <= 18:
        return "เทา" + ("อ่อน" if mx > 170 else ("เข้ม" if mx < 100 else ""))
    # หา hue
    mxv, mnv = mx / 255.0, mn / 255.0
    d = mxv - mnv
    if mx == r:
        h = (60 * ((g - b) / 255.0 / d)) % 360
    elif mx == g:
        h = 60 * ((b - r) / 255.0 / d) + 120
    else:
        h = 60 * ((r - g) / 255.0 / d) + 240
    for lim, nm in _HUE_TH:
        if h < lim:
            return nm
    return "แดง"


def cmyk_of(hexv):
    """CMYK โดยประมาณ (ไว้พิมพ์กำกับในใบสั่งผลิต)"""
    rgb = hex_to_rgb(hexv)
    if not rgb:
        return (0, 0, 0, 100)
    r, g, b = (v / 255.0 for v in rgb)
    k = 1.0 - max(r, g, b)
    if k >= 0.9999:
        return (0, 0, 0, 100)
    c = (1 - r - k) / (1 - k); m = (1 - g - k) / (1 - k); y = (1 - b - k) / (1 - k)
    return tuple(int(round(v * 100)) for v in (c, m, y, k))


def find_pantone(code):
    """หาเบอร์ Pantone ที่ผู้ใช้พิมพ์เข้ามา (ยืดหยุ่น: '186', '186C', 'PANTONE 186 C' ก็เจอ)"""
    k = "".join(str(code or "").upper().replace("PANTONE", "").split())
    if not k:
        return None
    for cd, hx in PANTONE.items():
        if "".join(cd.upper().split()) == k:
            return (cd, hx)
    if not k.endswith("C"):                    # พิมพ์แต่ตัวเลข -> เติม C ให้เอง
        for cd, hx in PANTONE.items():
            if "".join(cd.upper().split()) == k + "C":
                return (cd, hx)
    return None


def _one(hexv, use="", code="", toa=""):
    _pf = find_pantone(code)
    if _pf:                                    # 🎯 พิมพ์เบอร์มา -> ใช้สีของเบอร์นั้นเลย
        hexv = _pf[1]; code = _pf[0]
    hx = (hexv or "").strip()
    if not hx.startswith("#"):
        hx = "#" + hx
    if not hex_to_rgb(hx):
        return None
    pc, pref, dE = nearest_pantone(hx)
    rgb = hex_to_rgb(hx)
    return {"hex": rgb_to_hex(rgb), "use": use or "",
            "pantone": (code or pc), "pantone_ref": pref,
            "exact": bool(code), "delta_e": (0.0 if code else dE),
            "toa": toa or "", "name_th": color_name_th(hx),
            "rgb": "R%d G%d B%d" % rgb,
            "cmyk": "C%d M%d Y%d K%d" % cmyk_of(hx)}


def parse_spots(spec, face_color="", side_color="", max_n=3):
    """อ่าน 'สีพิเศษ' ที่ผู้ใช้เลือก (ไม่เกิน 3 สี) — รับได้หลายรูปแบบ

    1) JSON:  [{"hex":"#C8102E","pantone":"186 C","use":"ตัวอักษร","toa":"..."} , ...]
    2) ข้อความสั้น:  "#C8102E|ตัวอักษร, #001F5B|พื้นหลัง"
    3) ไม่ระบุอะไรเลย -> ใช้สีหน้า/สีข้างที่เลือกไว้ในหน้าออกแบบ
    4) ไม่มีอะไรเลยจริง ๆ -> คืน 'ขาว + ดำ' พร้อมช่องสี (ตามที่ตกลงกันว่าต้องระบุให้ชัด)
    """
    import json as _json
    out = []
    spec = (spec or "").strip()
    if spec:
        try:
            data = _json.loads(spec)
            if isinstance(data, dict):
                data = [data]
            for it in (data or [])[:max_n]:
                o = _one(str(it.get("hex", "")), str(it.get("use", "")),
                         str(it.get("pantone", "")), str(it.get("toa", "")))
                if o:
                    out.append(o)
        except Exception:
            for part in spec.split(",")[:max_n]:
                bits = [b.strip() for b in part.split("|")]
                if bits and bits[0]:
                    o = _one(bits[0], bits[1] if len(bits) > 1 else "",
                             bits[2] if len(bits) > 2 else "")
                    if o:
                        out.append(o)
    if not out:
        for hv, us in ((face_color, "สีหน้า"), (side_color, "สีขอบข้าง")):
            if hv and hex_to_rgb(hv):
                o = _one(hv, us)
                if o and all(o["hex"] != q["hex"] for q in out):
                    out.append(o)
    if not out:
        # 🎯 ไม่ได้เลือกสีพิเศษ -> ต้องระบุให้ชัดว่าเป็นสีมาตรฐาน ขาว/ดำ (พร้อมช่องสีเหมือนกัน)
        out = [_one("#FFFFFF", "สีมาตรฐาน (ไม่ได้เลือกสีพิเศษ)", "White"),
               _one("#231F20", "สีมาตรฐาน (ไม่ได้เลือกสีพิเศษ)", "Process Black C")]
    return out[:max_n]


def summary_line(spots):
    """สรุปสั้น ๆ 1 บรรทัด (ไว้ใส่บนภาพ/แจ้งเตือน)"""
    return " · ".join("%s %s" % (s["pantone"], ("(%s)" % s["use"]) if s["use"] else "")
                      for s in (spots or [])).strip()


# ── "ส่วนที่ต้องพ่นสี" ของแต่ละชนิดป้าย ────────────────────────────────
#    สีที่ต้องระบุในแบบ = เฉพาะชิ้นที่ช่างต้องพ่นสีจริง ไม่ใช่ทุกสีที่เห็นบนจอ
#      · ไฟออกหน้า/ทั่วไป -> พ่นที่ "คิ้ว" และ "ขอบข้าง (return)" · หน้าเป็นอะคริลิคไม่ได้พ่น
#      · ไฟออกหลัง        -> พ่นทั้งตัว (หน้า+ขอบข้าง เป็นชิ้นทึบชิ้นเดียวกัน)
#    target = ชื่อกลุ่มชิ้นในภาพ 3 มิติ (ใช้เปลี่ยนสีสดในหน้าเว็บโดยไม่ต้องสร้างภาพใหม่)
_TARGET_CLASS = {"trim": "w3d-kim", "side": "w3d-side", "body": "w3d-face"}


def painted_parts(rec, face_color="", side_color="", trim_color=""):
    """คืน [(hex, ชื่อส่วน, target), ...] เฉพาะชิ้นที่ต้องพ่นสี"""
    rec = rec or {}
    nm = str(rec.get("name", ""))
    out = []
    if rec.get("back_lit") or "ออกหลัง" in nm:
        out.append((face_color or side_color or "#231F20", "พ่นทั้งตัว (ไฟออกหลัง)", "body"))
        return out
    if trim_color:
        out.append((trim_color, "คิ้ว (กรอบหน้า)", "trim"))
    if side_color:
        out.append((side_color, "ขอบข้าง (return)", "side"))
    if not out and face_color:
        out.append((face_color, "ผิวหน้า", "body"))
    return out


def paint_spots(rec, spec="", face_color="", side_color="", trim_color="", max_n=3,
                sticker_color="", sticker_code="", sticker_brand=""):
    """สีที่ต้องพ่น (ไม่เกิน 3 สี) — ถ้าผู้ใช้ระบุ spec เองให้ใช้ตามนั้น
       ถ้าไม่ระบุ -> ดึงจาก 'ชิ้นที่ต้องพ่นสี' ของชนิดป้ายนั้น
       ถ้าไม่มีอะไรเลย -> ขาว/ดำ พร้อมช่องสี (ตามที่ตกลงกันว่าต้องระบุให้ชัด)"""
    if (spec or "").strip():
        return parse_spots(spec, max_n=max_n)
    out = []
    # 🏷️ สติกเกอร์โปร่งแสงปิดหน้าอะคริลิค — มาก่อนเสมอ เพราะเป็นข้อมูลสั่งซื้อ
    if sticker_color or sticker_code:
        o = sticker_spot(sticker_color or "#FFFFFF", code=sticker_code, brand=sticker_brand)
        if o:
            out.append(o)
    for hx, use, tg in painted_parts(rec, face_color, side_color, trim_color):
        o = _one(hx, use)
        if o and all(o["hex"] != q["hex"] or o["use"] != q["use"] for q in out):
            o["target"] = tg
            o["target_class"] = _TARGET_CLASS.get(tg, "")
            out.append(o)
    if not out:
        out = [_one("#FFFFFF", "สีมาตรฐาน (ไม่ได้เลือกสีพ่น)", "White"),
               _one("#231F20", "สีมาตรฐาน (ไม่ได้เลือกสีพ่น)", "Process Black C")]
        for o in out:
            o["target"] = "body"; o["target_class"] = "w3d-face"
    return out[:max_n]


# ══════════════════════════════════════════════════════════════════════
#  🏷️ สติกเกอร์โปร่งแสง (translucent vinyl) — ปิดหน้าอะคริลิคเพื่อเปลี่ยนสี
# ══════════════════════════════════════════════════════════════════════
#  ทำไมต้องแยกจากสีพ่น: ไฟออกหน้าหลายงานไม่ได้พ่นสี แต่ใช้ 'สติกเกอร์โปร่งแสง'
#  ปิดหน้าอะคริลิคใสแทน — แสงยังทะลุได้ แต่ได้สีตามต้องการ
#  ข้อมูลนี้ต้องระบุใน 'ใบสั่งซื้อ' ให้ครบ: ยี่ห้อ · รุ่น · เบอร์สี
#
#  ⚠️ ต้องอ่านก่อนใช้:
#     รายการเริ่มต้นด้านล่างเป็น 'โครงให้เริ่มใช้งานได้' เท่านั้น ไม่ใช่แคตตาล็อกจริงของร้าน
#     เบอร์สติกเกอร์ผูกกับใบสั่งซื้อโดยตรง — ถ้าเบอร์ผิด ของที่สั่งมาจะผิดทั้งม้วน
#     ✅ ให้โหลด 'แคตตาล็อกจริงของซัพพลายเออร์ที่ร้านใช้' เข้ามาแทนก่อนใช้สั่งของจริง
#        โดยแก้ตัวแปร STICKER ด้านล่าง (หรือใส่ไฟล์ sticker_catalog.json ไว้ข้าง ๆ ไฟล์นี้)
#     ระบบจะเตือนบนเอกสารเสมอถ้ายังใช้รายการเริ่มต้นอยู่
STICKER_IS_SEED = True          # True = ยังเป็นรายการตั้งต้น ยังไม่ใช่ของร้าน
STICKER = [
    # (ยี่ห้อ, รุ่น, เบอร์, ชื่อสี, hex อ้างอิง)
    ("3M", "Scotchcal 3630", "3630-020", "Light Tomato Red", "#E4002B"),
    ("3M", "Scotchcal 3630", "3630-033", "Red", "#C8102E"),
    ("3M", "Scotchcal 3630", "3630-015", "Yellow", "#FFC72C"),
    ("3M", "Scotchcal 3630", "3630-044", "Orange", "#FF8200"),
    ("3M", "Scotchcal 3630", "3630-126", "Blue", "#0033A0"),
    ("3M", "Scotchcal 3630", "3630-136", "Green", "#009639"),
    ("3M", "Scotchcal 3630", "3630-121", "Light Blue", "#0085CA"),
    ("3M", "Scotchcal 3630", "3630-025", "White", "#FFFFFF"),
    ("Oracal", "8500 Translucent", "8500-010", "White", "#FFFFFF"),
    ("Oracal", "8500 Translucent", "8500-020", "Golden Yellow", "#EAAA00"),
    ("Oracal", "8500 Translucent", "8500-032", "Light Red", "#EF3340"),
    ("Oracal", "8500 Translucent", "8500-047", "Orange Red", "#FF6900"),
    ("Oracal", "8500 Translucent", "8500-050", "Dark Blue", "#00205B"),
    ("Oracal", "8500 Translucent", "8500-061", "Light Blue", "#00B5E2"),
    ("Oracal", "8500 Translucent", "8500-068", "Green", "#00843D"),
    ("Avery", "4500 Translucent", "4552", "Sunflower Yellow", "#FFCD00"),
    ("Avery", "4500 Translucent", "4560", "Cardinal Red", "#BA0C2F"),
    ("Avery", "4500 Translucent", "4570", "Sapphire Blue", "#003DA5"),
]


def _load_sticker_catalog():
    """ถ้ามีไฟล์ sticker_catalog.json วางไว้ข้าง ๆ -> ใช้แคตตาล็อกจริงของร้านแทนรายการตั้งต้น
       รูปแบบไฟล์: [{"brand":"3M","series":"3630","code":"3630-033","name":"Red","hex":"#C8102E"}, ...]"""
    global STICKER, STICKER_IS_SEED
    import os as _os
    import json as _js
    p = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "sticker_catalog.json")
    try:
        if _os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                rows = _js.load(f)
            out = []
            for r in rows or []:
                if r.get("hex") and r.get("code"):
                    out.append((r.get("brand", ""), r.get("series", ""), r["code"],
                                r.get("name", ""), r["hex"]))
            if out:
                STICKER = out
                STICKER_IS_SEED = False
    except Exception:
        pass
    return STICKER


_load_sticker_catalog()


def nearest_sticker(hexv):
    """หา 'เบอร์สติกเกอร์โปร่งแสง' ที่ใกล้สีนี้ที่สุด — คืน dict พร้อม ΔE (None ถ้าไม่มีแคตตาล็อก)"""
    best, bd = None, 1e9
    for br, se, cd, nm, hx in (STICKER or []):
        d = delta_e(hexv, hx)
        if d < bd:
            best, bd = (br, se, cd, nm, hx), d
    if not best:
        return None
    return {"brand": best[0], "series": best[1], "code": best[2], "name": best[3],
            "hex": best[4], "delta_e": round(bd, 1), "is_seed": bool(STICKER_IS_SEED),
            "label": ("%s %s · %s" % (best[0], best[1], best[2])).strip()}


def find_sticker(code):
    """หาเบอร์สติกเกอร์ที่ผู้ใช้พิมพ์เข้ามาในแคตตาล็อก (ตัดช่องว่าง/ตัวพิมพ์เล็กใหญ่ทิ้ง)"""
    k = "".join(str(code or "").split()).lower()
    if not k:
        return None
    for br, se, cd, nm, hx in (STICKER or []):
        if "".join(str(cd).split()).lower() == k:
            return {"brand": br, "series": se, "code": cd, "name": nm, "hex": hx,
                    "delta_e": 0.0, "is_seed": bool(STICKER_IS_SEED),
                    "label": ("%s %s · %s" % (br, se, cd)).strip()}
    return None


def sticker_spot(hexv, use="หน้าอะคริลิค (ปิดสติกเกอร์โปร่งแสง)", code="", brand=""):
    """สร้างรายการ 'สีสติกเกอร์' 1 รายการ พร้อมเบอร์สั่งซื้อ

    ลำดับความน่าเชื่อถือ (สำคัญ เพราะผูกกับใบสั่งซื้อ):
      1) ผู้ใช้พิมพ์เบอร์มา และเบอร์นั้นมีในแคตตาล็อก -> ใช้สีของเบอร์นั้นเลย (แม่นที่สุด)
      2) ผู้ใช้พิมพ์เบอร์/ยี่ห้อมาเอง แต่ไม่มีในแคตตาล็อก -> เชื่อผู้ใช้ ใช้เบอร์ตามที่พิมพ์
         แล้วโชว์ 'สีใกล้เคียงในแคตตาล็อก' กำกับไว้ให้ดูเทียบ
      3) ไม่พิมพ์อะไรเลย -> เทียบสีหาเบอร์ใกล้ที่สุดให้
    """
    hit = find_sticker(code)
    if hit:
        hexv = hit["hex"]                      # เบอร์ที่พิมพ์มาชนะเสมอ -> ใช้สีของเบอร์นั้น
    o = _one(hexv, use)
    if not o:
        return None
    st = hit or nearest_sticker(hexv)
    if st:
        o["sticker"] = st
        if hit:
            o["sticker_label"] = st["label"]
        elif code or brand:
            o["sticker_label"] = (" ".join(x for x in (brand, code) if x)).strip()
            o["sticker_user"] = True           # ผู้ใช้กรอกเอง -> ไม่ต้องเตือนว่าเป็นรายการตั้งต้น
            o["sticker_near"] = st["label"]    # เบอร์ใกล้เคียงในแคตตาล็อก (ไว้เทียบสีเฉย ๆ)
        else:
            o["sticker_label"] = st["label"]
    o["target"] = "face"
    o["target_class"] = "w3d-face"
    o["kind"] = "sticker"
    return o
