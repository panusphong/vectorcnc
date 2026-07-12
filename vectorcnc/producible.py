"""
producible.py — Producibility Checker (ด่านกรอง "ผลิตได้จริงไหม")

ปัญหาที่แก้: ภาพจาก AI (Midjourney/ChatGPT) หรือไฟล์ลูกค้า มักผลิตไม่ได้
— เส้นบางเป็นเส้นผม / ไส้ในจิ๋ว / ชิ้นเล็กเกิน / จุดถี่จนเครื่องดัดกรีดพับ
กราฟิกมารู้ตอนทำไปครึ่งวันแล้ว = เสียเวลาเปล่า

โมดูลนี้ตรวจ "ก่อน" รับงาน แล้วให้:
  - คะแนนความพร้อมผลิต 0-100
  - รายการปัญหา + ตำแหน่ง (mm)
  - ค่าที่ต้องแก้ (เช่น ต้องหนาขึ้นอีก 1.8 mm)
  - autofix() แก้อัตโนมัติเท่าที่ทำได้

หน่วยทั้งหมด = มิลลิเมตร (mm) · Y ชี้ลง (ตามระบบ SVG ของโปรเจกต์)
"""

PRODUCIBLE_VERSION = "2026-07-12-check+autofix"

import math

from shapely.geometry import Polygon, MultiPolygon, Point, box
from shapely.ops import unary_union


# ---------------------------------------------------------------- rules
# ค่าเริ่มต้นอิงงานป้าย/ตัวอักษรโลหะ-อะคริลิค (แก้ได้จาก UI)
DEFAULT_RULES = {
    "min_stroke_mm": 4.0,      # ความหนาเส้น/แขนต่ำสุดที่ตัดแล้วไม่หัก
    "min_part_mm2": 150.0,     # พื้นที่ชิ้นเล็กสุด (~1.5 cm²)
    "min_hole_mm": 5.0,        # ไส้ใน/ช่องเล็กสุด (ดอกกัดเข้าไม่ถึง)
    "min_gap_mm": 3.0,         # ระยะห่างระหว่างชิ้น (ไม่งั้นเชื่อมติดกัน)
    "max_pts_per_100mm": 18.0, # จุดต่อเส้นรอบรูป 100 mm (เครื่องดัดพับ)
    "tool_dia_mm": 6.0,        # ดอกกัด (ใช้เตือนมุมใน)
}

MATERIAL_PRESETS = {
    "acrylic":  {"label": "อะคริลิค",  "min_stroke_mm": 4.0, "min_hole_mm": 5.0,  "min_part_mm2": 150},
    "zinc":     {"label": "ซิ้งค์/โลหะ", "min_stroke_mm": 3.0, "min_hole_mm": 4.0,  "min_part_mm2": 100},
    "plaswood": {"label": "พลาสวูด",   "min_stroke_mm": 6.0, "min_hole_mm": 8.0,  "min_part_mm2": 250},
    "steel":    {"label": "สแตนเลส",   "min_stroke_mm": 2.5, "min_hole_mm": 3.0,  "min_part_mm2": 80},
    "led_box":  {"label": "กล่องไฟ",   "min_stroke_mm": 8.0, "min_hole_mm": 10.0, "min_part_mm2": 400},
}


def rules_for(material="acrylic", override=None):
    r = dict(DEFAULT_RULES)
    p = MATERIAL_PRESETS.get(str(material or "acrylic").lower())
    if p:
        for k, v in p.items():
            if k != "label":
                r[k] = v
    if override:
        for k, v in override.items():
            if k in r and v is not None:
                try:
                    r[k] = float(v)
                except Exception:
                    pass
    return r


# ---------------------------------------------------------------- geometry utils
def _comps(g):
    if g is None or g.is_empty:
        return []
    if getattr(g, "geom_type", "") == "MultiPolygon":
        return [p for p in g.geoms if p.geom_type == "Polygon" and not p.is_empty]
    if getattr(g, "geom_type", "") == "Polygon":
        return [g]
    return []


def _npoints(g):
    n = 0
    for p in _comps(g):
        n += len(p.exterior.coords) - 1
        for r in p.interiors:
            n += len(r.coords) - 1
    return n


def _perimeter(g):
    tot = 0.0
    for p in _comps(g):
        tot += p.exterior.length
        for r in p.interiors:
            tot += r.length
    return tot


def narrowest(g, hi=None, iters=17):
    """
    ความกว้างของ "จุดที่แคบที่สุด" ในรูปทรง (mm)
    วิธี: opening (กัดเข้า r แล้วขยายกลับ r) — ถ้ามีแขน/เส้นบางกว่า 2r มันจะหายไป
    binary search หา r ที่เล็กสุดที่เริ่มมีเนื้อหาย -> ความแคบสุด = 2r
    ตรวจได้ทั้ง "แขนบางในชิ้นเดียวกัน" (ไม่ใช่แค่ชิ้นเล็ก)
    """
    if g is None or g.is_empty:
        return 0.0
    A = g.area
    if A <= 0:
        return 0.0
    b = g.bounds
    if hi is None:
        hi = max(b[2] - b[0], b[3] - b[1]) * 0.55 + 1.0
    eps = max(A * 0.002, 1.0)      # เนื้อที่หายเกินนี้ = ถือว่าบางจริง
    lo = 0.0
    for _ in range(iters):
        mid = (lo + hi) * 0.5
        if mid <= 1e-4:
            break
        try:
            op = g.buffer(-mid, join_style=2).buffer(mid, join_style=2)
            loss = A - (op.area if (op is not None and not op.is_empty) else 0.0)
        except Exception:
            loss = A
        if loss > eps:
            hi = mid
        else:
            lo = mid
    return lo * 2.0


# ชื่อเดิม (เผื่อโค้ดอื่นเรียก)
min_width = narrowest


# ---------------------------------------------------------------- checks
def check(geom, rules=None, material="acrylic"):
    """
    geom = shapely Polygon/MultiPolygon หน่วย mm
    คืน dict: {score, verdict, issues[], stats{}, marks[]}
    """
    R = rules if isinstance(rules, dict) and "min_stroke_mm" in rules else rules_for(material, rules)
    issues = []
    marks = []          # จุดที่ต้องวงแดง [{x,y,r,type}]

    if geom is None or geom.is_empty:
        return {"score": 0, "verdict": "fail",
                "issues": [{"sev": "error", "code": "empty",
                            "title": "ไม่พบรูปทรงปิดในไฟล์",
                            "detail": "ไฟล์นี้ไม่มีเส้นที่ตัดได้เลย — อาจเป็นภาพไล่เฉด/ภาพถ่าย หรือเส้นไม่ปิด",
                            "fix": "ใช้ภาพที่เป็นสีทึบ ตัดพื้นหลังออก หรือให้กราฟิกลากเส้นใหม่"}],
                "stats": {}, "marks": []}

    comps = _comps(geom)
    total_area = sum(p.area for p in comps)
    b = geom.bounds
    W = b[2] - b[0]
    H = b[3] - b[1]

    # ---------- 1) เส้น/แขนบางเกินไป ----------
    ms = float(R["min_stroke_mm"])
    r = ms / 2.0
    thin_area = 0.0
    thin_regions = 0
    worst_w = None
    try:
        opened = geom.buffer(-r, join_style=2).buffer(r, join_style=2)
        thin = geom.difference(opened) if (opened is not None and not opened.is_empty) else geom
        for t in _comps(thin):
            if t.area < 1.0:
                continue
            thin_area += t.area
            thin_regions += 1
            c = t.representative_point()
            marks.append({"x": c.x, "y": c.y,
                          "r": max(3.0, math.sqrt(t.area)), "type": "thin"})
    except Exception:
        pass

    worst_w = narrowest(geom)

    if thin_regions > 0 or worst_w < ms:
        need = max(0.0, ms - worst_w)
        scale = (ms / worst_w) if worst_w > 0.05 else 0.0
        fix = "เพิ่มความหนาอีก ~%.1f mm (ปุ่ม 'แก้อัตโนมัติ' จะขยายให้)" % (need + 0.2)
        if scale > 1.02:
            fix += " · หรือขยายขนาดงานขึ้น ~%.0f%%" % ((scale - 1) * 100)
        issues.append({
            "sev": "error" if worst_w < ms * 0.6 else "warn",
            "code": "thin",
            "title": "เส้น/แขนบางเกินไป (%d จุด)" % max(thin_regions, 1),
            "detail": "จุดแคบสุดที่วัดได้ %.1f mm · ต้องการอย่างน้อย %.1f mm — ตัดแล้วหัก/บิดง่าย"
                      % (worst_w, ms),
            "fix": fix,
            "need_bold_mm": round(need + 0.2, 2),
            "scale_suggest": round(scale, 2),
        })

    # ---------- 2) ชิ้นเล็กเกินไป ----------
    tiny = [p for p in comps if p.area < float(R["min_part_mm2"])]
    if tiny:
        for p in tiny[:40]:
            c = p.representative_point()
            marks.append({"x": c.x, "y": c.y, "r": 4.0, "type": "tiny"})
        issues.append({
            "sev": "warn", "code": "tiny_part",
            "title": "ชิ้นเล็กเกินไป %d ชิ้น" % len(tiny),
            "detail": "เล็กกว่า %.0f mm² — หลุดร่วงตอนตัด เก็บงานยาก"
                      % float(R["min_part_mm2"]),
            "fix": "ลบทิ้ง (แก้อัตโนมัติ) หรือรวมกับชิ้นข้างเคียง",
            "count": len(tiny),
        })

    # ---------- 3) ไส้ใน / ช่องเล็กเกินไป ----------
    mh = float(R["min_hole_mm"])
    bad_holes = 0
    for p in comps:
        for ring in p.interiors:
            try:
                hp = Polygon(ring)
                if hp.is_empty:
                    continue
                hw = narrowest(hp)
                if hw < mh:
                    bad_holes += 1
                    c = hp.representative_point()
                    marks.append({"x": c.x, "y": c.y,
                                  "r": max(2.5, hw), "type": "hole"})
            except Exception:
                continue
    if bad_holes:
        issues.append({
            "sev": "warn", "code": "small_hole",
            "title": "ช่อง/ไส้ในเล็กเกินไป %d ช่อง" % bad_holes,
            "detail": "แคบกว่า %.1f mm — ดอกกัด Ø%.0f mm เข้าไม่ถึง และคิ้วจะปิดทับ"
                      % (mh, float(R["tool_dia_mm"])),
            "fix": "ขยายช่องให้กว้างขึ้น หรืออุดทิ้ง (แก้อัตโนมัติจะอุดให้)",
            "count": bad_holes,
        })

    # ---------- 4) ชิ้นชิดกันเกินไป ----------
    mg = float(R["min_gap_mm"])
    close_pairs = 0
    n = len(comps)
    if 1 < n <= 120:
        for i in range(n):
            for j in range(i + 1, n):
                try:
                    d = comps[i].distance(comps[j])
                except Exception:
                    continue
                if 1e-9 < d < mg:
                    close_pairs += 1
                    if close_pairs <= 30:
                        c = comps[i].centroid
                        c2 = comps[j].centroid
                        marks.append({"x": (c.x + c2.x) / 2, "y": (c.y + c2.y) / 2,
                                      "r": 4.0, "type": "gap"})
    if close_pairs:
        issues.append({
            "sev": "warn", "code": "close_gap",
            "title": "ชิ้นชิดกันเกินไป %d คู่" % close_pairs,
            "detail": "ห่างน้อยกว่า %.1f mm — ตัดแล้วเชื่อมติดกัน/ขาดไม่สวย" % mg,
            "fix": "ขยับให้ห่างขึ้น หรือขยายขนาดงานทั้งชิ้น",
            "count": close_pairs,
        })

    # ---------- 5) จุดถี่เกิน (เครื่องดัด/พับ) ----------
    pts = _npoints(geom)
    per = _perimeter(geom)
    dens = (pts / per * 100.0) if per > 1 else 0.0
    if dens > float(R["max_pts_per_100mm"]):
        issues.append({
            "sev": "warn", "code": "dense_pts",
            "title": "จุดบนเส้นถี่เกินไป",
            "detail": "%.1f จุด/100 mm (ควร ≤ %.0f) — เครื่องดัดจะกรีดพับถี่ ขอบเป็นเหลี่ยม"
                      % (dens, float(R["max_pts_per_100mm"])),
            "fix": "ลดจุดอัตโนมัติ (simplify) — ปุ่ม 'แก้อัตโนมัติ'",
            "density": round(dens, 1),
        })

    # ---------- 6) เรขาคณิตเสีย ----------
    if not geom.is_valid:
        issues.append({
            "sev": "warn", "code": "invalid",
            "title": "เส้นซ้อน/ตัดกันเอง",
            "detail": "รูปทรงมีเส้นตัดกันเอง — CAM บางตัวจะตัดผิด",
            "fix": "ซ่อมอัตโนมัติได้ (แก้อัตโนมัติ)",
        })

    # ---------- 7) ชิ้นเยอะผิดปกติ (ภาพถ่าย/ไล่เฉด) ----------
    if n > 400:
        issues.append({
            "sev": "error", "code": "too_many",
            "title": "ชิ้นย่อยเยอะผิดปกติ (%d ชิ้น)" % n,
            "detail": "มักเกิดจากภาพถ่าย/ภาพไล่เฉด/ภาพ AI ที่มี noise — ป้ายทำแบบนี้ไม่ได้",
            "fix": "ให้ลูกค้าส่งไฟล์เวกเตอร์ หรือให้กราฟิกลากใหม่จากภาพต้นแบบ",
            "count": n,
        })

    # ---------- คะแนน ----------
    score = 100
    for it in issues:
        score -= 28 if it["sev"] == "error" else 11
    score = max(0, min(100, score))
    verdict = "pass" if score >= 85 else ("fix" if score >= 55 else "fail")

    stats = {
        "parts": n,
        "points": pts,
        "perimeter_mm": round(per, 1),
        "area_mm2": round(total_area, 1),
        "bbox_mm": [round(W, 1), round(H, 1)],
        "min_width_mm": round(worst_w, 2),
        "pt_density": round(dens, 1),
        "rules": {k: round(float(v), 2) for k, v in R.items()},
    }
    return {"score": score, "verdict": verdict, "issues": issues,
            "stats": stats, "marks": marks[:120]}


# ---------------------------------------------------------------- autofix
def autofix(geom, rules=None, material="acrylic", bold_mm=None, simplify=True):
    """
    แก้อัตโนมัติเท่าที่ปลอดภัย:
      1) ซ่อมเรขาคณิตเสีย (buffer 0)
      2) อุดช่อง/ไส้ในที่เล็กเกิน
      3) ลบชิ้นจิ๋ว
      4) ขยายความหนา (bold) ให้ถึงขั้นต่ำ — ค่าเริ่มต้นคำนวณให้เอง
      5) ลดจุดบนเส้น (simplify)
    คืน (geom_fixed, log[])
    """
    R = rules if isinstance(rules, dict) and "min_stroke_mm" in rules else rules_for(material, rules)
    log = []
    g = geom
    if g is None or g.is_empty:
        return g, ["ไม่มีรูปทรง"]

    # 1) ซ่อม
    if not g.is_valid:
        try:
            g = g.buffer(0)
            log.append("ซ่อมเส้นซ้อน/ตัดกันเอง")
        except Exception:
            pass

    # 4) ขยายความหนา
    ms = float(R["min_stroke_mm"])
    if bold_mm is None:
        worst = narrowest(g)
        bold_mm = max(0.0, ms - worst) + (0.2 if worst < ms else 0.0)
    bold_mm = float(bold_mm)
    if bold_mm > 0.05:
        try:
            g = g.buffer(bold_mm / 2.0, join_style=2, mitre_limit=4.0, resolution=12)
            log.append("เพิ่มความหนา +%.1f mm (ให้ถึงขั้นต่ำ %.1f mm)" % (bold_mm, ms))
        except Exception:
            pass

    # 2) อุดช่องเล็ก
    mh = float(R["min_hole_mm"])
    keep = []
    filled = 0
    for p in _comps(g):
        ints = []
        for ring in p.interiors:
            try:
                hp = Polygon(ring)
                if narrowest(hp) >= mh:
                    ints.append(ring)
                else:
                    filled += 1
            except Exception:
                ints.append(ring)
        keep.append(Polygon(p.exterior, ints))
    if filled:
        log.append("อุดช่อง/ไส้ในที่เล็กเกิน %d ช่อง" % filled)
    g = unary_union(keep) if keep else g

    # 3) ลบชิ้นจิ๋ว
    mp = float(R["min_part_mm2"])
    parts = [p for p in _comps(g) if p.area >= mp]
    removed = len(_comps(g)) - len(parts)
    if removed > 0 and parts:
        g = unary_union(parts)
        log.append("ลบชิ้นจิ๋วทิ้ง %d ชิ้น" % removed)

    # 5) ลดจุด
    if simplify:
        per = _perimeter(g)
        pts = _npoints(g)
        dens = (pts / per * 100.0) if per > 1 else 0.0
        if dens > float(R["max_pts_per_100mm"]):
            try:
                g2 = g.simplify(0.15, preserve_topology=True)
                if g2 is not None and not g2.is_empty:
                    n2 = _npoints(g2)
                    log.append("ลดจุดบนเส้น %d → %d จุด (−%d%%)"
                               % (pts, n2, int(100 * (1 - n2 / max(pts, 1)))))
                    g = g2
            except Exception:
                pass

    if not log:
        log.append("ไฟล์นี้ผ่านเกณฑ์อยู่แล้ว — ไม่ต้องแก้")
    return g, log


# ---------------------------------------------------------------- preview svg
def report_svg(geom, marks, width_px=520):
    """SVG พรีวิว: รูปทรงเทา + วงแดงจุดที่มีปัญหา"""
    if geom is None or geom.is_empty:
        return ""
    b = geom.bounds
    pad = max((b[2] - b[0]), (b[3] - b[1])) * 0.06 + 4
    x0, y0 = b[0] - pad, b[1] - pad
    W, H = (b[2] - b[0]) + 2 * pad, (b[3] - b[1]) + 2 * pad
    if W <= 0 or H <= 0:
        return ""

    def ring(cs):
        return "M " + " L ".join("%.2f,%.2f" % (x - x0, y - y0) for x, y in cs) + " Z"

    paths = []
    for p in _comps(geom):
        d = ring(list(p.exterior.coords))
        for r in p.interiors:
            d += " " + ring(list(r.coords))
        paths.append('<path d="%s" fill="#cfd6e2" stroke="#5b6474" stroke-width="%.2f" fill-rule="evenodd"/>'
                     % (d, max(W, H) * 0.0018))

    COL = {"thin": "#e5484d", "tiny": "#f5a524", "hole": "#8b5cf6", "gap": "#0ea5e9"}
    dots = []
    for m in (marks or []):
        c = COL.get(m.get("type"), "#e5484d")
        rr = max(float(m.get("r", 3.0)), max(W, H) * 0.008)
        dots.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="none" stroke="%s" stroke-width="%.2f" opacity="0.95"/>'
                    % (m["x"] - x0, m["y"] - y0, rr, c, max(W, H) * 0.004))

    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%dpx" viewBox="0 0 %.2f %.2f">'
            '<rect width="%.2f" height="%.2f" fill="#f7f9fc"/>%s%s</svg>'
            % (width_px, W, H, W, H, "".join(paths), "".join(dots)))
