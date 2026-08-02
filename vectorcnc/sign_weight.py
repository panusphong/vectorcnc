# -*- coding: utf-8 -*-
"""
sign_weight.py — คำนวณ "น้ำหนักป้าย" และ "ขนาดเหล็กโครงที่ปลอดภัย"

ทำไมต้องมี: ช่างต้องรู้ก่อนติดตั้งว่าป้ายหนักเท่าไหร่ ผนัง/เพดานรับไหวไหม
และโครงเหล็กต้องใช้กี่นิ้ว ถึงจะไม่แอ่นและไม่ล้า

หลักการคิด (อ้างอิงค่ามาตรฐานจริง — ดูตาราง DENSITY / TUBES ด้านล่าง):
  น้ำหนักชั้น = พื้นที่จริงของชั้น (ตร.ม.) × ความหนา (ม.) × ความหนาแน่นวัสดุ (กก./ลบ.ม.)
  + ไฟ LED (ตามความยาวจริงที่วางได้) + หม้อแปลง (ตามวัตต์) + โครงเหล็ก (ตามความยาวจริง)

การเลือกเหล็ก = ตรวจ 2 ด่านตามวิชากลศาสตร์วัสดุ (คานรับน้ำหนักกระจาย รองรับ 2 จุด)
  ด่าน 1 หน่วยแรงดัด  σ = M/S   โดย M = wL²/8      ต้อง ≤ 140 MPa (SS400 คราก 245 หารความปลอดภัย 1.75)
  ด่าน 2 การแอ่นตัว   δ = 5wL⁴/(384·E·I)           ต้อง ≤ L/180 (เกณฑ์งานป้าย)
  โดย  I = (B⁴ − b⁴)/12 ,  S = I/(B/2) ,  E = 200,000 MPa

⚠️ ค่าที่คิดคือ "น้ำหนักตัวป้าย" เท่านั้น — แรงลมของป้ายกลางแจ้งต้องคิดแยกตามพื้นที่หน้าป้าย
   และความสูงติดตั้ง (ระบบจะเตือนไว้ให้ ไม่รวมในตัวเลขนี้)

ทุกหน่วยเข้า/ออก: มม. · ตร.มม. · กก.
"""

# ── ความหนาแน่นวัสดุ (กก./ลบ.ม.) — ค่ามาตรฐานอุตสาหกรรม ──────────────────
DENSITY = {
    "acrylic":   1190.0,   # PMMA (อะคริลิค) — 3 มม. = 3.57 กก./ตร.ม.
    "pvc_foam":   550.0,   # พลาสวูด / PVC foam board — 10 มม. = 5.5 กก./ตร.ม.
    "alu":       2700.0,   # อะลูมิเนียม
    "steel":     7850.0,   # เหล็ก / เหล็กชุบสังกะสี (ซิงค์)
    "stainless": 7930.0,   # สแตนเลส 304
    "pc":        1200.0,   # โพลีคาร์บอเนต
    "wood":       700.0,   # ไม้อัด
}
MAT_TH = {"acrylic": "อะคริลิค", "pvc_foam": "พลาสวูด", "alu": "อะลูมิเนียม",
          "steel": "เหล็กชุบสังกะสี", "stainless": "สแตนเลส", "pc": "โพลีคาร์บอเนต",
          "wood": "ไม้อัด"}

# ── เดา "วัสดุ + ความหนา" จากชื่อชั้นที่ระบบตั้งไว้ (เรียงตามลำดับความจำเพาะ) ──
#    ความหนาที่ระบุในชื่อชั้น (เช่น "อะคริลิคใสรองหลัง 8mm") จะถูกอ่านออกมาใช้แทนค่าเริ่มต้นเสมอ
_RULES = [
    (("สแตนเลส",),                       "stainless", 1.0),
    (("พลาสวูด", "plaswood"),            "pvc_foam", 10.0),
    (("อะลูมิเนียม", "อลูมิเนียม"),        "alu",      2.0),
    (("ไส้อะคริลิคใส", "อะคริลิคใส"),      "acrylic",  5.0),
    (("อะคริลิค", "acrylic"),             "acrylic",  3.0),
    (("คิ้ว",),                          "alu",      1.2),   # คิ้ว/แถบยกขอบ = อลูมิเนียม/สแตนเลสบาง
    (("แผ่นขอบข้าง", "return"),           "steel",    0.8),   # ผนังข้าง (ยกขอบ) เหล็กบาง
    (("แผ่นพื้น", "แผ่นหลัง", "ฐานยึด", "backing"), "steel", 1.0),
    (("โครงแขวน", "โครง"),                "steel",    1.2),
    (("ป้ายพิมพ์", "สติ๊กเกอร์", "พิมพ์"),  "pvc_foam", 3.0),
]
_DEFAULT = ("acrylic", 3.0)


def _thick_from_name(name):
    """อ่าน 'ความหนา' ที่เขียนไว้ในชื่อชั้น เช่น '8mm' · '10 มม.' -> คืน มม. หรือ None"""
    import re
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:mm|มม\.?|มิล)", str(name), re.I)
    if m:
        try:
            v = float(m.group(1))
            if 0.3 <= v <= 60.0:
                return v
        except Exception:
            pass
    return None


def material_of(name, kind=""):
    """คืน (คีย์วัสดุ, ความหนา มม.) ของชั้นนี้"""
    low = str(name or "")
    mat, th = _DEFAULT
    for keys, k, t in _RULES:
        if any(w in low for w in keys):
            mat, th = k, t
            break
    return mat, (_thick_from_name(low) or th)


def layer_kg(name, area_mm2, kind=""):
    """น้ำหนักของชั้นหนึ่ง (กก.) จากพื้นที่จริงของชั้น"""
    mat, th = material_of(name, kind)
    m3 = (float(area_mm2) * float(th)) / 1.0e9        # มม.² × มม. -> ลบ.ม.
    return mat, th, m3 * DENSITY.get(mat, 1200.0)


# ── ตารางเหล็กกล่องสี่เหลี่ยมจัตุรัสที่หาซื้อได้จริงในไทย (มอก. 107) ──────────
#    kg_m = น้ำหนักต่อเมตร (จากตารางโรงงานที่ขายเป็นท่อน 6 ม. หารด้วย 6 แล้ว)
TUBES = [
    {"label": '1/2"',  "b": 12.7, "t": 1.2, "kg_m": 0.408},
    {"label": '3/4"',  "b": 19.0, "t": 1.2, "kg_m": 0.600},
    {"label": '3/4"',  "b": 19.0, "t": 1.4, "kg_m": 0.733},
    {"label": '1"',    "b": 25.4, "t": 1.2, "kg_m": 0.717},
    {"label": '1"',    "b": 25.4, "t": 1.6, "kg_m": 1.000},
    {"label": '1"',    "b": 25.4, "t": 2.3, "kg_m": 1.510},
    {"label": '1¼"',   "b": 31.8, "t": 1.2, "kg_m": 1.050},
    {"label": '1¼"',   "b": 31.8, "t": 2.3, "kg_m": 1.935},
    {"label": '1½"',   "b": 38.1, "t": 1.2, "kg_m": 1.250},
    {"label": '1½"',   "b": 38.1, "t": 2.3, "kg_m": 2.498},
    {"label": '2"',    "b": 50.8, "t": 1.2, "kg_m": 1.667},
    {"label": '2"',    "b": 50.8, "t": 2.3, "kg_m": 3.213},
]
# 🏬 เบอร์ที่หน้าร้านสต๊อกไว้จริง — ระบบจะเลือกจากนี้เท่านั้น
#    (อยากเพิ่ม/ลดเบอร์ ให้แก้บรรทัดเดียวนี้ ไม่ต้องแตะสูตรคำนวณ)
STOCK = ('3/4"', '1"', '1½"')


def stock_tubes():
    return [t for t in TUBES if t["label"] in STOCK] or list(TUBES)


E_STEEL = 200000.0          # MPa (N/มม.²)
SIGMA_ALLOW = 140.0         # MPa — SS400/มอก.107 คราก ~245 หารความปลอดภัย 1.75
DEFL_RATIO = 180.0          # เกณฑ์แอ่นตัวงานป้าย L/180
G = 9.80665


def tube_check(tube, span_mm, load_kg):
    """ตรวจคานหนึ่งเส้น: คืน dict {ok, sigma, sigma_ok, defl, defl_lim, defl_ok}"""
    L = max(1.0, float(span_mm))
    P = max(0.0, float(load_kg)) * G                  # นิวตันรวมทั้งคาน
    B = float(tube["b"]); b2 = max(0.1, B - 2.0 * float(tube["t"]))
    I = (B ** 4 - b2 ** 4) / 12.0                     # มม.⁴
    S = I / (B / 2.0)                                 # มม.³
    M = P * L / 8.0                                   # N·มม. (w·L²/8 โดย w = P/L)
    sig = M / max(1e-6, S)
    dl = (5.0 * P * L ** 3) / (384.0 * E_STEEL * max(1e-6, I))
    lim = L / DEFL_RATIO
    return {"sigma": sig, "sigma_ok": sig <= SIGMA_ALLOW,
            "defl": dl, "defl_lim": lim, "defl_ok": dl <= lim,
            "ok": (sig <= SIGMA_ALLOW and dl <= lim)}


def pick_tube(span_mm, load_kg, max_b_mm=None, min_b_mm=0.0):
    """เลือกเหล็กกล่องที่เล็กที่สุดที่ 'ผ่านทั้ง 2 ด่าน' และไม่เกินขนาดที่ซ่อนหลังตัวอักษรได้
       คืน (tube, check, fits) — fits=False แปลว่าต้องเพิ่มจุดยึด/ลดช่วงพาด ไม่ใช่เพิ่มขนาดเหล็ก"""
    cand = [t for t in stock_tubes() if t["b"] >= float(min_b_mm) - 0.01]
    if max_b_mm:
        lim = [t for t in cand if t["b"] <= float(max_b_mm) + 0.01]
        if lim:
            cand = lim
    for t in sorted(cand, key=lambda q: (q["b"], q["t"])):
        c = tube_check(t, span_mm, load_kg)
        if c["ok"]:
            return t, c, True
    t = sorted(cand, key=lambda q: (q["b"], q["t"]))[-1] if cand else stock_tubes()[-1]
    return t, tube_check(t, span_mm, load_kg), False


def max_span(tube, load_per_m_kg):
    """ช่วงพาดสูงสุดของเหล็กเส้นนี้ ที่ยังผ่านทั้ง 2 ด่าน (มม.) — ใช้ตัดสินว่าต้องเพิ่มกี่จุดยึด"""
    lo, hi = 100.0, 6000.0
    for _ in range(28):
        mid = (lo + hi) / 2.0
        if tube_check(tube, mid, float(load_per_m_kg) * mid / 1000.0)["ok"]:
            lo = mid
        else:
            hi = mid
    return lo


def estimate(layers, led=None, frame_len_mm=0.0, frame_tube=None, extra_kg=0.0):
    """สรุปน้ำหนักทั้งป้าย
       layers = [{"name":..., "area_mm2":...}, ...]  (พื้นที่จริงของชั้น ไม่ใช่กรอบสี่เหลี่ยม)
       led    = dict จาก mount_frame.led_layout (ใช้ total_m + transformer_w) หรือ None
       คืน dict {parts:[...], total_kg, sheet_kg, led_kg, frame_kg}"""
    parts = []
    sheet = 0.0
    for L in (layers or []):
        a = float(L.get("area_mm2") or 0.0)
        if a <= 0:
            continue
        mat, th, kg = layer_kg(L.get("name", ""), a, L.get("kind", ""))
        if kg <= 0:
            continue
        sheet += kg
        parts.append({"name": L.get("name", ""), "mat": MAT_TH.get(mat, mat),
                      "thick_mm": round(th, 2), "area_m2": round(a / 1.0e6, 3),
                      "kg": round(kg, 2)})
    led_kg = 0.0
    if led:
        try:
            led_kg += float(led.get("total_m") or 0.0) * 0.05          # เส้น LED ~50 กรัม/เมตร
            led_kg += float(led.get("transformer_w") or 0.0) * 0.0045  # หม้อแปลง ~4.5 กรัม/วัตต์
        except Exception:
            led_kg = 0.0
        if led_kg > 0:
            parts.append({"name": "ไฟ LED + หม้อแปลง + สายไฟ", "mat": "อุปกรณ์ไฟฟ้า",
                          "thick_mm": 0.0, "area_m2": 0.0, "kg": round(led_kg, 2)})
    frame_kg = 0.0
    if frame_len_mm and frame_tube:
        frame_kg = (float(frame_len_mm) / 1000.0) * float(frame_tube.get("kg_m") or 0.0)
        if frame_kg > 0:
            parts.append({"name": "โครงเหล็กแขวน %s หนา %.1f มม. ยาวรวม %.1f ม."
                          % (frame_tube.get("label", ""), float(frame_tube.get("t", 0)),
                             float(frame_len_mm) / 1000.0),
                          "mat": "เหล็กกล่อง", "thick_mm": float(frame_tube.get("t", 0)),
                          "area_m2": 0.0, "kg": round(frame_kg, 2)})
    total = sheet + led_kg + frame_kg + max(0.0, float(extra_kg))
    return {"parts": parts, "sheet_kg": round(sheet, 2), "led_kg": round(led_kg, 2),
            "frame_kg": round(frame_kg, 2), "total_kg": round(total, 2)}
