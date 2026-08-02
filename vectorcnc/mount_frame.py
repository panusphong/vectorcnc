# -*- coding: utf-8 -*-
"""
mount_frame.py — โครงเหล็กแขวน "ตัวอักษรยกขอบ/ไฟออกหน้า" + เจาะรูยึด/สายไฟต่อตัวอักษร

สำหรับงานผลิตจริง: ตัวอักษรแต่ละตัวยึดกับโครงเหล็กขวาง (1 หรือ 2 เส้น) แล้วแขวนบนป้าย
เพิ่มลงไฟล์ตัด laser ตั้งแต่แรก ต่อ "ตัวอักษรแต่ละตัว":
  - รูน็อตยึดโครง  Ø3 มม.  = 2 รู (ซ้าย-ขวา) ต่อโครง 1 เส้น · อยู่ระดับเดียวกับโครงที่วางขวาง
  - รูร้อยสายไฟ   Ø5 มม.  = 1 รู กลางตัว · หลบขึ้นบน 1 ซม. เหนือขอบโครงเส้นบนสุด

โครงปรับได้: จำนวนเส้น (1/2) · ระดับ (จากล่าง) · ระยะห่างเส้น · เลื่อนซ้าย-ขวา · ระยะห่างจากหลังป้าย
ทุกหน่วย = มิลลิเมตร · พิกัด: origin ซ้ายบน, y ชี้ลง (แบบภาพ/SVG) เหมือน _letter_full_mm
"""
import io
import base64
import math


def split_letters(full, min_area_mm2=100.0):
    """แยกเป็น 'ตัวอักษร/ชิ้น' (connected component) · คืน list ของ shapely Polygon เรียงซ้าย->ขวา"""
    geoms = list(full.geoms) if getattr(full, "geom_type", "") == "MultiPolygon" else [full]
    out = [g for g in geoms if getattr(g, "geom_type", "") == "Polygon"
           and not g.is_empty and g.area >= min_area_mm2]
    out.sort(key=lambda g: g.bounds[0])       # ซ้าย -> ขวา
    return out


def frame_bars(full, bars=1, bar_y_cm=None, gap_cm=20.0, bar_h_mm=15.0):
    """คืนตำแหน่ง Y (กึ่งกลางเส้น) ของโครงขวาง · bar_y_cm = ระดับกึ่งกลางจาก 'ด้านล่าง' (None=อัตโนมัติ 40%)"""
    b = full.bounds; H = b[3] - b[1]
    if bar_y_cm is None:
        cy = b[1] + H * 0.55                  # อัตโนมัติ ~กลางค่อนล่าง
    else:
        cy = b[3] - float(bar_y_cm) * 10.0    # จากล่างขึ้นบน
    n = 2 if int(bars) >= 2 else 1
    if n == 1:
        return [cy]
    g = float(gap_cm) * 10.0
    return [cy - g / 2.0, cy + g / 2.0]        # บน, ล่าง


def letter_holes(letters, bar_ys, bolt_d=3.0, wire_d=5.0, wire_offset_mm=0.0,
                 bar_h_mm=15.0, edge_inset_mm=15.0):
    """คำนวณรูต่อตัวอักษร · คืน dict {bolts:[(x,y,r)...], wires:[(x,y,r)...]}"""
    from shapely.geometry import Point as _Pt
    bolt_r = bolt_d / 2.0; wire_r = wire_d / 2.0
    bolts = []; wires = []

    def _inside(g, x, y):
        try:
            return g.contains(_Pt(x, y))
        except Exception:
            return True

    def _snap_y(g, x, y):
        """ดันจุดให้ 'อยู่ในเนื้ออักษร' จริง ๆ ที่ตำแหน่ง x (ไล่หา y ที่อยู่ในรูปทรง)"""
        lb = g.bounds
        if _inside(g, x, y):
            return y
        best = None; bestd = 1e18
        yy = lb[1] + 3
        while yy < lb[3]:
            if _inside(g, x, yy):
                d = abs(yy - y)
                if d < bestd:
                    bestd = d; best = yy
            yy += max(3.0, (lb[3] - lb[1]) / 40.0)
        return best if best is not None else (lb[1] + lb[3]) / 2.0
    for g in letters:
        lb = g.bounds; lx0, ly0, lx1, ly1 = lb
        cx = (lx0 + lx1) / 2.0; cy = (ly0 + ly1) / 2.0
        lw = lx1 - lx0
        # 🔩 รูน็อต = ที่ 'ระดับคานโครง' ที่พาดผ่านตัวอักษร (ระยะรูขึ้นกับตำแหน่งโครง)
        hit = [by for by in bar_ys if (ly0 - lw * 0.15) <= by <= (ly1 + lw * 0.15)]
        if not hit:                                           # ไม่มีคานพาด -> ใช้กึ่งกลางตัว
            hit = [cy]
        # 📏 ระยะเจาะขั้นต่ำ 25 มม. — ใกล้กว่านี้เนื้อระหว่างรูจะฉีก และไขควงเข้าไม่ได้
        xs = [cx] if (lw < bolt_d * 5 or lw * 0.52 < 25.0) else [cx - lw * 0.26, cx + lw * 0.26]
        for by in hit:
            for xx in xs:
                bolts.append((xx, _snap_y(g, xx, by), bolt_r))
        # รูสายไฟ 1 รู กลางตัว · หลบเหนือคานบนสุดที่พาดผ่าน (ขยับได้ด้วย wire_offset)
        _wref = (min(hit) - float(wire_offset_mm)) if hit else (cy - float(wire_offset_mm))
        wires.append((cx, _snap_y(g, cx, _wref), wire_r))
    return {"bolts": bolts, "wires": wires}


def row_bars(letters):
    """ตรวจ 'แถว' ของตัวอักษร (คลัสเตอร์ตามแกน y) -> คืนระดับคานโครง 1 เส้น/แถว (กลางแถว)"""
    if not letters:
        return []
    items = sorted(((g.bounds[1] + g.bounds[3]) / 2.0, (g.bounds[3] - g.bounds[1])) for g in letters)
    hs = sorted(h for _, h in items)
    mh = hs[len(hs) // 2] if hs else 100.0
    rows = [[items[0][0]]]
    for cy, _h in items[1:]:
        if cy - rows[-1][-1] > mh * 0.7:
            rows.append([cy])
        else:
            rows[-1].append(cy)
    return [sum(r) / len(r) for r in rows]


def _main_letters(letters):
    """แยก 'ตัวหลัก' (ตัวอักษรจริง) ออกจาก 'ชิ้นจิ๋ว' (จุด · สระ · วรรณยุกต์ · เศษลาย)
       ชิ้นจิ๋วต้องไม่มีสิทธิ์กำหนดขนาดเหล็กหรือแบ่งแถว — แต่ต้องได้รูยึดเหมือนกัน"""
    if not letters:
        return [], []
    hs = sorted((g.bounds[3] - g.bounds[1]) for g in letters)
    med = hs[len(hs) // 2]
    amax = max(g.area for g in letters)
    main, small = [], []
    for i, g in enumerate(letters):
        h = g.bounds[3] - g.bounds[1]
        (main if (h >= med * 0.45 and g.area >= amax * 0.02) else small).append(i)
    if not main:
        main, small = list(range(len(letters))), []
    return main, small


def cluster_rows(letters, ov_ratio=0.45, max_rows=5):
    """จัด 'ตัวอักษร' เป็นแถว

    ⚠️ บทเรียน: ถ้าจัดแถวด้วย 'การซ้อนกันในแนวตั้ง' ชิ้นสูงมาก ๆ (เช่น โลโก้วงกลม)
       จะพาดคร่อมทุกบรรทัด แล้วลากทุกตัวมารวมเป็นแถวเดียว -> บรรทัดเล็กหายไปจากโครง
    ✅ จึงจัดจาก 'ระดับกึ่งกลางของตัวหลัก' โดยใช้ความสูงกลาง (median) เป็นตัวตัดแถว
       แล้วค่อยหย่อนชิ้นจิ๋วเข้าแถวที่ใกล้ที่สุดทีหลัง
    """
    if not letters:
        return []
    hs = sorted((g.bounds[3] - g.bounds[1]) for g in letters)
    med = hs[len(hs) // 2]
    gap = max(10.0, med * 0.60)
    order = sorted(range(len(letters)), key=lambda i: (letters[i].bounds[1] + letters[i].bounds[3]) / 2.0)
    rows = []
    for i in order:
        cy = (letters[i].bounds[1] + letters[i].bounds[3]) / 2.0
        if rows and (cy - rows[-1]["cy_last"]) <= gap:
            rows[-1]["idx"].append(i); rows[-1]["cy_last"] = cy
        else:
            rows.append({"idx": [i], "cy_last": cy})
    for r in rows:
        xs = [letters[i].bounds[0] for i in r["idx"]] + [letters[i].bounds[2] for i in r["idx"]]
        r["x0"] = min(xs); r["x1"] = max(xs)
        r["y0"] = min(letters[i].bounds[1] for i in r["idx"])
        r["y1"] = max(letters[i].bounds[3] for i in r["idx"])
        r["cy"] = sum((letters[i].bounds[1] + letters[i].bounds[3]) / 2.0 for i in r["idx"]) / len(r["idx"])
        # 🔍 ในแถวนี้ 'ตัวหลัก' คือตัวที่สูงไม่ต่ำกว่า 40% ของความสูงกลางในแถวเดียวกัน
        #    (จุด · สระ · วรรณยุกต์ ถูกคัดออกจากการกำหนดขนาดเหล็ก แต่ยังได้รูยึดตามปกติ)
        _rh = sorted((letters[i].bounds[3] - letters[i].bounds[1]) for i in r["idx"])
        _rm = _rh[len(_rh) // 2]
        r["main"] = [i for i in r["idx"]
                     if (letters[i].bounds[3] - letters[i].bounds[1]) >= _rm * 0.40] or list(r["idx"])
        r["h_min"] = min((letters[i].bounds[3] - letters[i].bounds[1]) for i in r["main"])
        r["area"] = sum(letters[i].area for i in r["idx"])
        r.pop("cy_last", None)
    rows.sort(key=lambda r: r["y0"])
    # 🖼️ งานที่ไม่ใช่ตัวหนังสือ (ภาพ/ลายเส้น) จะแตกเป็นสิบ ๆ แถว -> โครงรกและผลิตจริงไม่ได้
    #    รวมแถวที่ใกล้กันที่สุดทีละคู่ จนเหลือจำนวนแถวที่ช่างประกอบได้จริง
    while len(rows) > int(max_rows):
        k = min(range(len(rows) - 1), key=lambda i: rows[i + 1]["cy"] - rows[i]["cy"])
        a, b2 = rows[k], rows[k + 1]
        a["idx"] += b2["idx"]
        a["x0"] = min(a["x0"], b2["x0"]); a["x1"] = max(a["x1"], b2["x1"])
        a["y0"] = min(a["y0"], b2["y0"]); a["y1"] = max(a["y1"], b2["y1"])
        a["cy"] = (a["cy"] + b2["cy"]) / 2.0
        _rh = sorted((letters[i].bounds[3] - letters[i].bounds[1]) for i in a["idx"])
        _rm = _rh[len(_rh) // 2]
        a["main"] = [i for i in a["idx"]
                     if (letters[i].bounds[3] - letters[i].bounds[1]) >= _rm * 0.40] or list(a["idx"])
        a["h_min"] = min((letters[i].bounds[3] - letters[i].bounds[1]) for i in a["main"])
        a["area"] = sum(letters[i].area for i in a["idx"])
        rows.pop(k + 1)
    return rows


def plan_frame(full, letters, total_kg=20.0, arm_edge_cm=20.0, max_tube_mm=50.8, max_rows=5):
    """🧠 วางผังโครงเหล็กแบบ 'คิดเอง' — คานต้องพาดทุกตัวอักษร และเลือกขนาดเหล็กให้เหมาะกับตัวอักษร

    หลักที่ใช้ (แบบช่างป้ายจริง):
      1) แยกงานเป็น 'แถว' ก่อน — คนละแถวใช้คานคนละชุด (บรรทัดเล็กใต้ตัวใหญ่ต้องมีคานของตัวเอง)
      2) ในแต่ละแถว วางคานใน 'ช่วงที่ตัวอักษรทุกตัวในแถวมีเนื้อร่วมกัน' -> ยึดได้ครบทุกตัว
      3) ขนาดเหล็กของแถว ต้องซ่อนหลังตัวอักษรได้ = ไม่เกิน 45% ของตัวที่เตี้ยที่สุดในแถว
         (ตัวอักษรสูง 4 ซม. -> เหล็กไม่เกิน 18 มม. = 3/4 นิ้ว · ห้ามยัด 1 นิ้ว)
      4) ตรวจซ้ำทีละตัว: ถ้ายังมีตัวไหนไม่มีคานพาด -> เติมคานให้ตัวนั้นโดยเฉพาะ (ห้ามมีตัวลอย)
      5) เช็คกำลังรับน้ำหนักด้วยสูตรคาน (sign_weight.tube_check) ถ้าไม่ผ่าน -> เพิ่มจุดยึด ไม่ใช่ขยายเหล็ก
    """
    from . import sign_weight as SW
    b = full.bounds
    W = b[2] - b[0]
    A_all = max(1e-6, sum(g.area for g in letters))
    rows = cluster_rows(letters, max_rows=int(max_rows))
    _edge = max(0.0, float(arm_edge_cm)) * 10.0
    plan_rows = []
    import math as _math
    for r in rows:
        L = [letters[i] for i in r.get("main", r["idx"])]     # ใช้ 'ตัวหลัก' หาช่วงเนื้อร่วม
        # ช่วงเนื้อร่วมของทั้งแถว (คานอยู่ในช่วงนี้ = พาดทุกตัวหลักในแถว)
        ct = max(g.bounds[1] for g in L)
        cb = min(g.bounds[3] for g in L)
        band = cb - ct
        rh = r["y1"] - r["y0"]
        # ขนาดเหล็กสูงสุดที่ยัง 'ซ่อนหลังตัวอักษร' ได้ (ดูจากตัวหลักที่เตี้ยที่สุดในแถว)
        max_b = max(12.7, min(float(max_tube_mm), r["h_min"] * 0.45))
        full_span = max(50.0, (r["x1"] - r["x0"]) - 2.0 * min(_edge, (r["x1"] - r["x0"]) * 0.30))
        load = float(total_kg) * (r["area"] / A_all)
        span = full_span
        tube, chk, fits = SW.pick_tube(span, max(0.5, load), max_b_mm=max_b)
        # 🧠 ถ้าเหล็กที่ 'ซ่อนหลังอักษรได้' พาดไม่ไหว -> เพิ่มจุดยึด (ลดช่วงพาด)
        #    ไม่ใช่ขยายเหล็กจนโผล่พ้นตัวอักษร — แอ่นตัวลดตามกำลัง 4 ของช่วงพาด จึงได้ผลกว่ามาก
        n_sup = 2
        if not fits:
            _kgm = max(0.01, load / max(0.05, full_span / 1000.0))
            _ms = SW.max_span(tube, _kgm)
            n_sup = min(8, max(2, int(_math.ceil(full_span / max(100.0, _ms))) + 1))
            span = full_span / max(1, n_sup - 1)
            chk = SW.tube_check(tube, span, max(0.5, load) / max(1, n_sup - 1))
            fits = bool(chk["ok"])
        r["n_sup"] = n_sup
        tb = tube["b"]
        # 📏 คานคู่ใช้เฉพาะ 'ตัวใหญ่พอ' — ตัวอักษรเล็กใช้คานเดี่ยวก็พอ
        #    (ตัวสูง < 6 ซม. ถ้ายัดคานคู่ จะเห็นเหล็ก 2 เส้นอัดกันจนดูรก และไม่ได้ช่วยอะไร)
        if band > tb * 2.4 + 20.0 and r["h_min"] >= 60.0:
            ins = tb * 0.75 + band * 0.10
            bars = [ct + ins, cb - ins]
        elif band > tb * 1.2:                      # ช่วงแคบ -> คานเดี่ยวกลางช่วง
            bars = [(ct + cb) / 2.0]
        else:                                      # ไม่มีเนื้อร่วม -> ใช้กลางแถว แล้วให้ด่านตรวจข้อ 4 เก็บตก
            bars = [(r["y0"] + r["y1"]) / 2.0]
        plan_rows.append({"idx": list(r["idx"]), "y0": r["y0"], "y1": r["y1"],
                          "x0": r["x0"], "x1": r["x1"], "bars": bars, "tube": tube,
                          "chk": chk, "fits": fits, "span_mm": span, "load_kg": load,
                          "h_min": r["h_min"], "rh": rh, "n_sup": r.get("n_sup", 2)})
    # ── ด่านตรวจ: ทุกตัวอักษรต้องมีคานพาดจริง (ไม่ใช่แค่ 'อยู่ในแถว') ─────────
    missed = []
    for i, g in enumerate(letters):
        gy0, gy1 = g.bounds[1], g.bounds[3]
        ok = False
        for pr in plan_rows:
            if any(gy0 - 1.0 <= by <= gy1 + 1.0 for by in pr["bars"]):
                ok = True
                break
        if not ok:
            missed.append(i)
    for i in missed:                               # เติมคานเฉพาะตัวที่ยังลอย (จัดกลุ่มตามระดับกลางตัว)
        g = letters[i]
        cy = (g.bounds[1] + g.bounds[3]) / 2.0
        home = min(plan_rows, key=lambda pr: abs((pr["y0"] + pr["y1"]) / 2.0 - cy)) if plan_rows else None
        if home is None:
            continue
        near = next((by for by in home["bars"] if abs(by - cy) < (g.bounds[3] - g.bounds[1])), None)
        if near is None:
            home["bars"].append(cy)
            home["bars"].sort()
            home["x0"] = min(home["x0"], g.bounds[0]); home["x1"] = max(home["x1"], g.bounds[2])
            home.setdefault("added", 0)
            home["added"] += 1
    # ── เสาตั้งเชื่อมทุกแถวเข้าด้วยกัน + แขนยึดขึ้นเพดาน ───────────────────
    _rowb = max((pr["tube"]["b"] for pr in plan_rows), default=19.0)
    ax_l = b[0] + min(_edge, W * 0.30)
    ax_r = b[2] - min(_edge, W * 0.30)
    if ax_r - ax_l < W * 0.20:
        ax_l, ax_r = b[0] + W * 0.20, b[2] - W * 0.20
    # 🧠 จำนวนเสา/จุดยึด = มากที่สุดเท่าที่แถวไหนต้องการ (แถวที่พาดยาวเป็นตัวกำหนด)
    _ns = max((pr.get("n_sup", 2) for pr in plan_rows), default=2)
    if _ns > 2:
        ax_all = [ax_l + (ax_r - ax_l) * k / float(_ns - 1) for k in range(_ns)]
    else:
        ax_all = [ax_l, ax_r]
    # 🔩 'เหล็กหลัก' = คานบนที่พาดระหว่างจุดยึด — รับน้ำหนักทั้งป้าย จึงต้องคิดจากน้ำหนักรวม
    #    (ห้ามเอาเหล็กของแถวเล็กมาเป็นตัวแทนทั้งโครง — เคยพลาดตรงนี้ ได้ 1/2" ทั้งที่หน่วยแรงเกิน)
    _span_main = abs(ax_all[-1] - ax_all[0]) / max(1, len(ax_all) - 1)
    tube_main, chk_main, fits_main = SW.pick_tube(_span_main, max(0.5, float(total_kg)), min_b_mm=_rowb)
    y_top = min((min(pr["bars"]) for pr in plan_rows), default=b[1])
    y_bot = max((max(pr["bars"]) for pr in plan_rows), default=b[3])
    # 📏 แถวตัวอักษรเล็ก (ตัวหลักเตี้ยกว่า 6 ซม.) ต้องเหลือคานเดียวเสมอ
    #    ถ้าด่านเก็บตกไปเติมคานให้ตัวที่ยังลอย จะกลายเป็น 2 เส้นอัดกันจนดูรกและไม่จำเป็น
    #    ✅ แทนที่จะเพิ่มคาน ให้ 'เลื่อนคานเดียว' ไปที่ระดับที่พาดโดนตัวอักษรได้มากที่สุดแทน
    for pr in plan_rows:
        if pr["h_min"] >= 60.0 or len(pr["bars"]) <= 1:
            continue
        _cand = list(pr["bars"]) + [(letters[i].bounds[1] + letters[i].bounds[3]) / 2.0
                                    for i in pr["idx"]]

        def _hit(by):
            return sum(1 for i in pr["idx"]
                       if letters[i].bounds[1] - 1.0 <= by <= letters[i].bounds[3] + 1.0)
        pr["bars"] = [max(_cand, key=_hit)]
    # 🔒 ปิดหัวท้ายซ้าย-ขวาของทุกแถวที่มีคานคู่ = ได้ 'เฟรมปิด' จริง แข็งแรงและดูเรียบร้อย
    #    (เดิมปล่อยปลายเปิด เห็นเป็นคาน 2 เส้นลอย ๆ ไม่ใช่เฟรม)
    for pr in plan_rows:
        pr["caps"] = []
        if len(pr["bars"]) >= 2:
            _t = pr["tube"]["b"]
            pr["caps"] = [(pr["x0"] + _t / 2.0, min(pr["bars"]), max(pr["bars"])),
                          (pr["x1"] - _t / 2.0, min(pr["bars"]), max(pr["bars"]))]
    # 🔗 แถวที่ไม่โดนเสาหลักพาดผ่าน ต้องมี 'ตัวโยง' ขึ้นไปเกาะแถวบน ไม่งั้นคานแถวนั้นลอย
    for k, pr in enumerate(plan_rows):
        pr["links"] = []
        if k == 0:
            continue
        _up = max(plan_rows[k - 1]["bars"])
        _in = max(20.0, (pr["x1"] - pr["x0"]) * 0.12)
        _cand = [x for x in ax_all if pr["x0"] + 5.0 <= x <= pr["x1"] - 5.0]
        if not _cand:                       # เสาหลักไม่ผ่านแถวนี้ -> โยงที่หัวท้ายของแถวเอง
            _cand = [pr["x0"] + _in, pr["x1"] - _in]
        pr["links"] = [(x, _up, min(pr["bars"])) for x in _cand]
    # ความยาวเหล็กรวม = คานทุกเส้น + เสาตั้ง + ตัวโยงระหว่างแถว + แขน (แขนบวกตอน build)
    len_mm = sum((pr["x1"] - pr["x0"]) * len(pr["bars"]) for pr in plan_rows)
    # 📐 เสาตั้งแต่ละต้น ต้องจบที่ 'คานล่างสุดที่ต้นนั้นเกาะจริง' ไม่ใช่ลากยาวถึงแถวล่างสุดของทั้งป้าย
    #    (ไม่งั้นต้นที่อยู่นอกช่วงแถวล่าง จะมีขาโผล่ห้อยลงมาในที่ว่าง — เจอจริงที่มุมซ้ายล่าง)
    col_span = []
    for _x in ax_all:
        _bot = None
        for pr in plan_rows:
            if pr["x0"] - 1.0 <= _x <= pr["x1"] + 1.0:
                _b2 = max(pr["bars"])
                _bot = _b2 if _bot is None else max(_bot, _b2)
        col_span.append((_x, y_top, _bot if _bot is not None else y_top))
    len_mm += sum(abs(c[2] - c[1]) for c in col_span)
    len_mm += sum(abs(l[2] - l[1]) for pr in plan_rows for l in pr.get("links", []))
    len_mm += sum(abs(c[2] - c[1]) for pr in plan_rows for c in pr.get("caps", []))
    n_bars = sum(len(pr["bars"]) for pr in plan_rows)
    return {"rows": plan_rows, "arm_x": ax_all, "y_top": y_top, "y_bot": y_bot,
            "col_span": col_span,
            "tube": tube_main, "len_mm": len_mm, "bars": n_bars, "rows_n": len(plan_rows),
            "span_mm": max((pr["span_mm"] for pr in plan_rows), default=W),
            "max_b_mm": max((pr["tube"]["b"] for pr in plan_rows), default=25.4),
            "fits": bool(fits_main) and all(pr["fits"] for pr in plan_rows),
            "span_main_mm": _span_main, "chk_main": chk_main, "supports": len(ax_all),
            "added": sum(pr.get("added", 0) for pr in plan_rows)}


def hole_pitch(holes):
    """ระยะเจาะ: ระยะห่างเฉลี่ย/น้อยสุด ระหว่างรูน็อตที่อยู่ระดับเดียวกัน (มม.)"""
    lv = {}
    for (x, y, _r) in holes.get("bolts", []):
        lv.setdefault(round(y / 25.0), []).append(x)
    gaps = []
    for xs in lv.values():
        xs.sort()
        gaps += [xs[i + 1] - xs[i] for i in range(len(xs) - 1) if xs[i + 1] - xs[i] > 1.0]
    if not gaps:
        return {"avg_mm": 0.0, "min_mm": 0.0, "max_mm": 0.0}
    return {"avg_mm": round(sum(gaps) / len(gaps), 1),
            "min_mm": round(min(gaps), 1), "max_mm": round(max(gaps), 1)}


def _circles_dxf(letters, holes):
    """ไฟล์ตัด DXF: เส้นตัดตัวอักษร (CutContour) + รูน็อต (BoltHole Ø3) + รูสายไฟ (WireHole Ø5)"""
    import ezdxf
    doc = ezdxf.new(); doc.header["$INSUNITS"] = 4
    for nm, col in (("CutContour", 6), ("BoltHole", 5), ("WireHole", 3)):
        if nm not in doc.layers:
            doc.layers.add(nm, color=col)
    msp = doc.modelspace()
    fb = letters[0].bounds if letters else (0, 0, 0, 0)
    H = max((g.bounds[3] for g in letters), default=0)   # สำหรับ flip y -> CAD (y-up)

    def Y(y):
        return H - y
    for g in letters:
        for ring in [g.exterior] + list(g.interiors):
            pts = [(x, Y(y)) for (x, y) in list(ring.coords)]
            if len(pts) >= 3:
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "CutContour"})
    for (x, y, r) in holes["bolts"]:
        msp.add_circle((x, Y(y)), r, dxfattribs={"layer": "BoltHole"})
    for (x, y, r) in holes["wires"]:
        msp.add_circle((x, Y(y)), r, dxfattribs={"layer": "WireHole"})
    s = io.StringIO(); doc.write(s)
    return base64.b64encode(s.getvalue().encode("utf-8")).decode()


def _circles_svg(letters, holes, w_mm, h_mm):
    """ไฟล์ตัด SVG (มม.) — ตัวอักษรชมพู · รูน็อตน้ำเงิน · รูสายไฟแดง"""
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">'
         % (w_mm, h_mm, w_mm, h_mm)]
    d = ""
    for g in letters:
        for ring in [g.exterior] + list(g.interiors):
            c = list(ring.coords)
            if len(c) >= 3:
                d += "M %.2f %.2f " % c[0] + " ".join("L %.2f %.2f" % q for q in c[1:]) + " Z "
    p.append('<path d="%s" fill="none" stroke="#ec008c" stroke-width="0.3"/>' % d.strip())
    for (x, y, r) in holes["bolts"]:
        p.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="none" stroke="#2563eb" stroke-width="0.3"/>' % (x, y, r))
    for (x, y, r) in holes["wires"]:
        p.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="none" stroke="#e11d48" stroke-width="0.3"/>' % (x, y, r))
    p.append("</svg>")
    return "".join(p)


def back_view_svg(full, letters, plan, holes, frame_x_mm=0.0, standoff_cm=5.0,
                  W=900.0, arm_len_cm=30.0, arm_edge_cm=20.0, pitch=None):
    """ภาพ 'มองจากด้านหลังป้าย' — โครงตามผังที่คิดไว้ (คานทุกแถว + เสาตั้ง + แขน) + รูเจาะ + ระยะครบ
       ตัวอักษร mirror ซ้าย-ขวา เพราะเป็นมุมมองจากด้านหลังจริง"""
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    sc = W / max(w_mm, 1.0); Hpx = h_mm * sc
    pad = 96
    fx = float(frame_x_mm)

    def X(x):
        return (w_mm - (x - b[0] + fx)) * sc + pad

    def Yv(y):
        return (y - b[1]) * sc + pad
    TOT = W + pad * 2
    HT = Hpx + pad * 2 + 26
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f" '
         'style="width:100%%;height:auto;display:block">' % (TOT, HT, TOT, HT)]
    p.append('<rect x="0" y="0" width="%.0f" height="%.0f" fill="#f8fafc"/>' % (TOT, HT))
    _tt = ("มุมมองด้านหลัง (โครงยึด) · ระยะห่างจากหลังป้าย ~%.0f cm · %d แถว · คาน %d เส้น"
           % (standoff_cm, plan.get("rows_n", 1), plan.get("bars", 0)))
    p.append('<text x="%.0f" y="24" font-family="Prompt,Arial" font-size="15" font-weight="800" fill="#0f172a">%s</text>' % (pad, _tt))
    for g in letters:
        for ring in [g.exterior] + list(g.interiors):
            c = list(ring.coords)
            if len(c) >= 3:
                dd = "M " + " L ".join("%.1f,%.1f" % (X(x), Yv(y)) for (x, y) in c) + " Z"
                p.append('<path d="%s" fill="#e6ebf2" stroke="#94a3b8" stroke-width="1"/>' % dd)
    _RD = "#dc2626"; _BL = "#2563eb"; _GY = "#8b93a0"; _GD = "#5b626d"

    def _dv(x, y0, y1, txt, col):
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x, y0, x, y1, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="11" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%s</text>' % (x - 4, (y0 + y1) / 2, col, x - 4, (y0 + y1) / 2, txt))

    def _dh(x0, x1, y, txt, col):
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x0, y, x1, y, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="11" font-weight="700" fill="%s" text-anchor="middle">%s</text>' % ((x0 + x1) / 2, y - 4, col, txt))
    _ax = [X(v) for v in plan.get("arm_x", [])]
    _ytop = Yv(plan.get("y_top", b[1])); _ybot = Yv(plan.get("y_bot", b[3]))
    _mb = float(plan.get("tube", {}).get("b", 25.4)) * sc
    # 🏗️ เสาตั้ง — จบที่ 'คานล่างสุดที่ต้นนั้นเกาะจริง' (ไม่ลากเลยไปห้อยในที่ว่าง)
    for (_xm, _y1m, _y2m) in (plan.get("col_span") or [(v, plan.get("y_top", b[1]), plan.get("y_bot", b[3]))
                                                       for v in plan.get("arm_x", [])]):
        _xp = X(_xm); _t1 = Yv(_y1m); _t2 = Yv(_y2m)
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#a3aab6" stroke="%s" stroke-width="1"/>'
                 % (_xp - _mb / 2, min(_t1, _t2) - _mb / 2, _mb, abs(_t2 - _t1) + _mb, _GD))
    for r in plan.get("rows", []):                   # 🔗 ตัวโยงแถวล่างขึ้นไปเกาะแถวบน (วาดก่อนคาน)
        for (lx, y_up, y_dn) in r.get("links", []):
            _lw = float(r["tube"]["b"]) * sc
            p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#a3aab6" stroke="%s" stroke-width="1"/>'
                     % (X(lx) - _lw / 2, Yv(y_up), _lw, max(2.0, Yv(y_dn) - Yv(y_up)), _GD))
    for r in plan.get("rows", []):                   # 🔒 ปิดหัวท้ายซ้าย-ขวา = เฟรมปิด (วาดก่อนคาน)
        hh0 = float(r["tube"]["b"]) * sc
        for (cxm, cy1, cy2) in r.get("caps", []):
            _t1 = Yv(cy1); _t2 = Yv(cy2)
            p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="%s" stroke="%s" stroke-width="1"/>'
                     % (X(cxm) - hh0 / 2, min(_t1, _t2) - hh0 / 2, hh0, abs(_t2 - _t1) + hh0, _GY, _GD))
    for r in plan.get("rows", []):                   # คานของแต่ละแถว (ความหนาตามขนาดเหล็กจริงของแถวนั้น)
        hh = float(r["tube"]["b"]) * sc
        x0 = min(X(r["x0"]), X(r["x1"])); x1 = max(X(r["x0"]), X(r["x1"]))
        for by in r["bars"]:
            yy = Yv(by)
            p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="%s" stroke="%s" stroke-width="1"/>'
                     % (x0, yy - hh / 2, x1 - x0, hh, _GY, _GD))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="11" font-weight="700" fill="#0f172a">%s t%.1f</text>'
                 % (x1 + 5, Yv(r["bars"][0]) + 4, r["tube"]["label"], float(r["tube"]["t"])))
        _dh(x0, x1, Yv(max(r["bars"])) + 22, "แถวกว้าง %.0f cm" % ((r["x1"] - r["x0"]) / 10.0), _RD)
        if len(r["bars"]) > 1:
            _dv(x1 + 26, Yv(min(r["bars"])), Yv(max(r["bars"])),
                "%.0f cm" % (abs(max(r["bars"]) - min(r["bars"])) / 10.0), _BL)
    _atop = 16.0
    for _x in _ax:                                   # แขนยึดขึ้นเพดาน
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="1"/>'
                 % (_x - _mb * 0.35, _atop, _mb * 0.7, _ytop - _atop, _GY, _GD))
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#c6ccd6" stroke="%s" stroke-width="1"/>'
                 % (_x - _mb * 1.1, _atop - _mb * 0.5, _mb * 2.2, _mb * 0.6, _GD))
    if _ax:
        _dv(min(_ax) - _mb * 1.6, _atop, _ytop, "แขน %.0f cm" % arm_len_cm, _RD)
        _dh(min(_ax), max(_ax), _atop + _mb * 1.7, "ระยะจุดยึด %.0f cm"
            % (abs(plan["arm_x"][1] - plan["arm_x"][0]) / 10.0), _BL)
    for (x, y, r) in holes["bolts"]:
        p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="%s" stroke-width="1.4"/>' % (X(x), Yv(y), max(3, r * sc), _BL))
    for (x, y, r) in holes["wires"]:
        p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="#e11d48" stroke-width="1.6"/>' % (X(x), Yv(y), max(4, r * sc)))
    ly = Hpx + pad + 22
    p.append('<circle cx="%.0f" cy="%.0f" r="5" fill="#fff" stroke="%s" stroke-width="1.6"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">รูน็อตยึดโครง &#216;3</text>' % (pad + 6, ly, _BL, pad + 18, ly + 4))
    p.append('<circle cx="%.0f" cy="%.0f" r="5" fill="#fff" stroke="#e11d48" stroke-width="1.6"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">รูสายไฟ &#216;5</text>' % (pad + 170, ly, pad + 182, ly + 4))
    p.append('<rect x="%.0f" y="%.0f" width="14" height="8" fill="%s" stroke="%s"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">เหล็กกล่อง (ขนาดตามแถว)</text>' % (pad + 300, ly - 4, _GY, _GD, pad + 320, ly + 4))
    if pitch and pitch.get("avg_mm"):
        p.append('<text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" font-weight="700" fill="#0f172a">ระยะเจาะเฉลี่ย %.1f cm (แคบสุด %.1f cm)</text>'
                 % (pad + 540, ly + 4, pitch["avg_mm"] / 10.0, pitch["min_mm"] / 10.0))
    p.append("</svg>")
    return "".join(p)


def led_layout(full, pitch_cm=6.0, watt_per_m=12.0, volt=12.0, spare=1.3, W=900.0):
    """วางเส้นไฟ LED Ribbon ในตัวงาน (แถวแนวนอนเว้นระยะ pitch) + คำนวณความยาว/กระแส/หม้อแปลง
       ใช้ได้กับ ไฟออกหน้า / ไฟออกหลัง / กล่องไฟ — คืน dict สรุป + ภาพพรีวิว"""
    from shapely.geometry import LineString
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    pitch = max(20.0, float(pitch_cm) * 10.0)
    comps = split_letters(full, min_area_mm2=300.0)
    segs = []; total_mm = 0.0; sw_list = []

    def _rings(pg):
        return [pg.exterior] + list(pg.interiors)

    def _plist(gg):
        if gg is None or gg.is_empty:
            return []
        return list(gg.geoms) if gg.geom_type == "MultiPolygon" else [gg]

    def _emit(ring):
        cs = list(ring.coords)
        for i in range(len(cs) - 1):
            segs.append((cs[i][0], cs[i][1], cs[i + 1][0], cs[i + 1][1]))
        return ring.length
    for g in comps:
        try:
            sw = 2.0 * g.area / max(g.length, 1.0)   # ความกว้างเส้นอักษรเฉลี่ย (มม.)
        except Exception:
            sw = 0.0
        if sw > 0:
            sw_list.append(sw)
        # 🔦 วางไฟตามแนวขอบ (contour) ไล่รูปตัวอักษร 'ครบทุกส่วน'
        #    เส้นแรกชิดขอบ (inset เล็ก) -> วิ่งตามขอบทั้งหมด · แล้วไล่เข้าในตามความกว้างเส้น
        inset0 = min(9.0, max(4.0, sw * 0.22)) if sw > 0 else 6.0
        line_gap = max(12.0, min(pitch, (sw * 0.45) if sw > 0 else pitch))
        made = 0; total_len = 0.0; dd = inset0
        while made < 10:
            gi = g.buffer(-dd)
            plist = _plist(gi)
            if not plist:
                break
            for pg in plist:
                for ring in _rings(pg):
                    total_len += _emit(ring)
            made += 1; dd += line_gap
        if made == 0:                                # เส้นบางมาก -> วิ่งตามขอบตัวอักษรจริง (2 ขอบ)
            for ring in _rings(g):
                total_len += _emit(ring)
        total_mm += total_len
    stroke_w_cm = round((sum(sw_list) / len(sw_list)) / 10.0, 1) if sw_list else 0.0
    total_m = total_mm / 1000.0
    watts = total_m * float(watt_per_m)
    amps = (watts / float(volt)) if float(volt) > 0 else 0.0
    need_w = watts * float(spare)
    std = [60, 100, 150, 200, 250, 300, 350, 400, 500]
    ps = next((s for s in std if s >= need_w), int(math.ceil(need_w / 100.0) * 100))
    sc = W / max(w_mm, 1.0); Hpx = h_mm * sc; pad = 40.0

    def X(x):
        return (x - b[0]) * sc + pad

    def Yv(y):
        return (y - b[1]) * sc + pad
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f" '
         'style="width:100%%;height:auto;display:block">' % (W + pad*2, Hpx + pad*2 + 60, W + pad*2, Hpx + pad*2 + 60)]
    p.append('<rect x="0" y="0" width="%.0f" height="%.0f" fill="#0f1522"/>' % (W + pad*2, Hpx + pad*2 + 60))
    for g in comps:
        for ring in [g.exterior] + list(g.interiors):
            c = list(ring.coords)
            if len(c) >= 3:
                dd = "M " + " L ".join("%.1f,%.1f" % (X(x), Yv(y)) for (x, y) in c) + " Z"
                p.append('<path d="%s" fill="#1b2536" stroke="#3a475f" stroke-width="1"/>' % dd)
    for (x0, y0, x1, y1) in segs:
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#ffcf4d" stroke-width="3.2" stroke-linecap="round" opacity="0.95"/>'
                 % (X(x0), Yv(y0), X(x1), Yv(y1)))
    ty = Hpx + pad + 34
    p.append('<text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="15" font-weight="800" fill="#ffcf4d">LED (วางตามขอบอักษร) &#183; ยาว %.2f ม. &#183; %.0f W &#183; %.1f A (@%.0fV) &#183; หม้อแปลง %d W &#183; เส้นอักษรกว้าง ~%.1f cm</text>'
             % (pad, ty, total_m, watts, amps, float(volt), ps, stroke_w_cm))
    p.append("</svg>")
    return {"segments": len(segs), "total_m": round(total_m, 2), "watts": round(watts, 1),
            "amps": round(amps, 2), "transformer_w": ps, "pitch_cm": float(pitch_cm),
            "stroke_w_cm": stroke_w_cm, "preview_svg": "".join(p)}


def build(full, bars=1, bar_y_cm=None, gap_cm=20.0, frame_x_cm=0.0, standoff_cm=5.0,
          bolt_d=3.0, wire_d=5.0, wire_offset_cm=0.0, bar_h_mm=15.0,
          arm_len_cm=30.0, arm_edge_cm=20.0, total_kg=20.0, max_tube_mm=50.8):
    """ประกอบครบ: วางผังโครงแบบคิดเอง -> เจาะรู -> วาดภาพหลัง
       คืน dict {cut_dxf, cut_svg, back_svg, letters, bolts, wires, tube, rows, frame_len_mm, ...}"""
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    letters = split_letters(full)
    if not letters:
        return {"error": "แยกตัวอักษรไม่ได้ (ภาพควรเป็นตัวอักษร/โลโก้แยกชิ้น)"}
    plan = plan_frame(full, letters, total_kg=float(total_kg),
                      arm_edge_cm=float(arm_edge_cm), max_tube_mm=float(max_tube_mm))
    bars_y = [by for r in plan["rows"] for by in r["bars"]]
    holes = letter_holes(letters, bars_y, bolt_d=bolt_d, wire_d=wire_d,
                         wire_offset_mm=float(wire_offset_cm) * 10.0, bar_h_mm=bar_h_mm)
    pitch = hole_pitch(holes)
    # ความยาวเหล็กรวม = คาน + เสาตั้ง + แขน 2 ข้าง
    _len = float(plan["len_mm"]) + 2.0 * float(arm_len_cm) * 10.0
    _rowtxt = " · ".join("แถว %d: %s t%.1f" % (i + 1, r["tube"]["label"], float(r["tube"]["t"]))
                         for i, r in enumerate(plan["rows"]))
    _note = "โครง %d แถว · %s · ระยะเจาะเฉลี่ย %.1f ซม." % (plan["rows_n"], _rowtxt, pitch["avg_mm"] / 10.0)
    if not plan["fits"]:
        _note += " · ⚠️ ช่วงพาดยาวไป ควรเพิ่มจุดยึด"
    return {
        "cut_dxf": _circles_dxf(letters, holes),
        "cut_svg": _circles_svg(letters, holes, w_mm, h_mm),
        "back_svg": back_view_svg(full, letters, plan, holes,
                                  frame_x_mm=float(frame_x_cm) * 10.0, standoff_cm=standoff_cm,
                                  arm_len_cm=float(arm_len_cm), arm_edge_cm=float(arm_edge_cm),
                                  pitch=pitch),
        "letters": len(letters), "bolts": len(holes["bolts"]), "wires": len(holes["wires"]),
        "bars": plan["bars"], "rows": plan["rows_n"], "w_mm": round(w_mm, 1), "h_mm": round(h_mm, 1),
        "tube": {"label": plan["tube"]["label"], "b": plan["tube"]["b"],
                 "t": plan["tube"]["t"], "kg_m": plan["tube"]["kg_m"]},
        "tubes": [{"row": i + 1, "label": r["tube"]["label"], "t": r["tube"]["t"],
                   "b": r["tube"]["b"], "span_cm": round(r["span_mm"] / 10.0, 1),
                   "load_kg": round(r["load_kg"], 2), "letter_h_cm": round(r["h_min"] / 10.0, 1),
                   "ok": bool(r["fits"])} for i, r in enumerate(plan["rows"])],
        "frame_len_mm": round(_len, 1), "span_mm": round(plan["span_mm"], 1),
        "max_b_mm": plan["max_b_mm"], "pitch": pitch, "fits": plan["fits"],
        "added_bars": plan.get("added", 0), "note": _note,
    }
