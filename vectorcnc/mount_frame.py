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
        xs = [cx] if lw < bolt_d * 5 else [cx - lw * 0.26, cx + lw * 0.26]
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


def back_view_svg(full, letters, bar_ys, holes, frame_x_mm=0.0, standoff_cm=5.0,
                  bar_h_mm=15.0, W=900.0, arm_len_cm=30.0, arm_edge_cm=20.0):
    """ภาพ 'มองจากด้านหลังป้าย' — ตัวอักษรกลับซ้าย-ขวา (mirror) + เฟรมกรอบสี่เหลี่ยม + 2 แขน + รูเจาะ + จับระยะครบ"""
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    sc = W / max(w_mm, 1.0); Hpx = h_mm * sc
    pad = 90                                       # เผื่อพื้นที่แขน (บน) + เส้นจับระยะ (รอบ)
    def X(x):                      # mirror ซ้าย-ขวา (มองจากหลัง)
        return (w_mm - (x - b[0])) * sc + pad
    def Yv(y):
        return (y - b[1]) * sc + pad
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f" '
         'style="width:100%%;height:auto;display:block">' % (W + pad*2, Hpx + pad*2, W + pad*2, Hpx + pad*2)]
    p.append('<rect x="0" y="0" width="%.0f" height="%.0f" fill="#f8fafc"/>' % (W + pad*2, Hpx + pad*2))
    p.append('<text x="%.0f" y="24" font-family="Prompt,Arial" font-size="15" font-weight="800" fill="#0f172a">มุมมองด้านหลัง (โครงยึด) · ระยะห่างจากหลังป้าย ~%.0f cm</text>' % (pad, standoff_cm))
    # ตัวอักษร (mirror) เป็นเงาจาง
    for g in letters:
        for ring in [g.exterior] + list(g.interiors):
            c = list(ring.coords)
            if len(c) >= 3:
                dd = "M " + " L ".join("%.1f,%.1f" % (X(x), Yv(y)) for (x, y) in c) + " Z"
                p.append('<path d="%s" fill="#e6ebf2" stroke="#94a3b8" stroke-width="1"/>' % dd)
    # 🔩 เฟรม = 'คานคู่แนวนอน' (บน-ล่าง) พาดกลางตัวอักษร + ปิดหัวท้ายซ้าย-ขวา + 2 แขนยื่นขึ้น
    # 📏 มาตรฐาน: 'ขอบโครงซ้าย-ขวา ต้องไม่เกินขอบนอกของตัวอักษร' -> เฟรมกว้างเท่ากรอบอักษรพอดี (ไม่ยื่นออก)
    fx = frame_x_mm; _m = 0.0
    frX0 = X(b[0] + fx); frX1 = X(b[2] + fx)
    fxl = min(frX0, frX1); fxr = max(frX0, frX1); bw = fxr - fxl
    hh = bar_h_mm * sc
    _rt = min(Yv(bar_ys[0]), Yv(bar_ys[1]))                 # คานบน (px)
    _rb = max(Yv(bar_ys[0]), Yv(bar_ys[1]))                 # คานล่าง (px)
    for yy in (_rt, _rb):                                   # คานบน + คานล่าง (แนวนอน) พาดกลางอักษร
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (fxl, yy - hh/2, bw, hh))
    for _ci, xx in enumerate((fxl, fxr)):                   # ปิดหัวท้ายซ้าย-ขวา (อยู่ในขอบอักษร ไม่ยื่นออก)
        _cx = xx if _ci == 0 else (xx - hh)
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (_cx, _rt - hh/2, hh, (_rb - _rt) + hh))
    _epx = float(arm_edge_cm) * 10.0 * sc                   # ระยะแขนจากขอบ (px)
    _axL = min(fxr - hh, fxl + _epx); _axR = max(fxl + hh, fxr - _epx)   # 2 แขน ซ้าย-ขวา (คุมให้อยู่ในเฟรม)
    _atop = 16.0                                            # ปลายแขนบน (ใกล้ขอบบนภาพ)
    for _ax in (_axL, _axR):                                # แขนยึดจากคานบนขึ้นเพดาน
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (_ax - hh*0.35, _atop, hh*0.7, _rt - _atop))
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#c6ccd6" stroke="#5b626d" stroke-width="1"/>' % (_ax - hh*1.1, _atop - hh*0.5, hh*2.2, hh*0.6))
    _FWcm = round(abs(b[2]-b[0])/10.0)                      # กว้างเฟรม = กว้างกรอบอักษร (ไม่เกินขอบ)
    _FHcm = round(abs(bar_ys[1]-bar_ys[0])/10.0)           # สูงเฟรม = ระยะคานบน-ล่าง
    _RD = "#dc2626"; _BL = "#2563eb"

    def _dv(x, y0, y1, txt, col):    # เส้นจับระยะแนวตั้ง + ป้าย (หมุน)
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x, y0, x, y1, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="12" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%s</text>' % (x-4, (y0+y1)/2, col, x-4, (y0+y1)/2, txt))

    def _dh(x0, x1, y, txt, col):    # เส้นจับระยะแนวนอน + ป้าย
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x0, y, x1, y, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="12" font-weight="700" fill="%s" text-anchor="middle">%s</text>' % ((x0+x1)/2, y-4, col, txt))
    _dv(_axL - hh*1.5, _atop, _rt, "แขน %.0f cm" % arm_len_cm, _RD)          # ความสูงแขน (จากคานบนขึ้น)
    _dv(fxr + 22, _rt, _rb, "เฟรมสูง %d cm" % _FHcm, _BL)                     # ระยะคานบน-ล่าง
    _dh(fxl, fxr, _rb + 26, "เฟรมกว้าง %d cm" % _FWcm, _RD)                   # ความกว้างเฟรม
    _dh(fxl, _axL, _atop + hh*1.6, "%.0f cm" % arm_edge_cm, _BL)             # ขอบซ้าย -> แขนซ้าย
    _dh(_axR, fxr, _atop + hh*1.6, "%.0f cm" % arm_edge_cm, _BL)             # แขนขวา -> ขอบขวา
    _dv(fxl - 18, Yv(b[1]), _rt, "ขอบบน %.0f cm" % ((_rt - Yv(b[1]))/sc/10.0), _RD)     # ขอบบนอักษร -> คานบน
    _dv(fxl - 36, _rb, Yv(b[3]), "ขอบล่าง %.0f cm" % ((Yv(b[3]) - _rb)/sc/10.0), _RD)   # คานล่าง -> ขอบล่างอักษร
    # รูน็อต (น้ำเงิน) + รูสายไฟ (แดง)
    for (x, y, r) in holes["bolts"]:
        p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="#2563eb" stroke-width="1.4"/>' % (X(x), Yv(y), max(3, r*sc)))
    for (x, y, r) in holes["wires"]:
        p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="#e11d48" stroke-width="1.6"/>' % (X(x), Yv(y), max(4, r*sc)))
    # legend
    ly = Hpx + pad + 22
    p.append('<circle cx="%.0f" cy="%.0f" r="5" fill="#fff" stroke="#2563eb" stroke-width="1.6"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">รูน็อตยึดโครง Ø3</text>' % (pad+6, ly, pad+18, ly+4))
    p.append('<circle cx="%.0f" cy="%.0f" r="5" fill="#fff" stroke="#e11d48" stroke-width="1.6"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">รูสายไฟ Ø5 (หลบโครง 1cm)</text>' % (pad+190, ly, pad+202, ly+4))
    p.append('<rect x="%.0f" y="%.0f" width="14" height="8" fill="#8b93a0" stroke="#5b626d"/><text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="12" fill="#334155">โครงเหล็กขวาง</text>' % (pad+420, ly-4, pad+440, ly+4))
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
          arm_len_cm=30.0, arm_edge_cm=20.0):
    """ประกอบครบ: คืน dict {cut_dxf, cut_svg, back_svg, letters, bolts, wires}"""
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    letters = split_letters(full)
    if not letters:
        return {"error": "แยกตัวอักษรไม่ได้ (ภาพควรเป็นตัวอักษร/โลโก้แยกชิ้น)"}
    # 🔩 เฟรม = 'คานคู่แนวนอน' (บน-ล่าง) พาดกลางตัวอักษร -> รูน็อตยึด 2 ระดับ
    _H = b[3] - b[1]
    _cyc = (b[1] + b[3]) / 2.0 if bar_y_cm is None else (b[3] - float(bar_y_cm) * 10.0)
    _fgap = _H * 0.38
    try:
        if gap_cm and float(gap_cm) > 0:
            _fgap = min(float(gap_cm) * 10.0, _H * 0.60)
    except Exception:
        pass
    _fgap = max(30.0, _fgap)
    bars_y = [_cyc - _fgap / 2.0, _cyc + _fgap / 2.0]
    holes = letter_holes(letters, bars_y, bolt_d=bolt_d, wire_d=wire_d,
                         wire_offset_mm=float(wire_offset_cm) * 10.0, bar_h_mm=bar_h_mm)
    return {
        "cut_dxf": _circles_dxf(letters, holes),
        "cut_svg": _circles_svg(letters, holes, w_mm, h_mm),
        "back_svg": back_view_svg(full, letters, bars_y, holes,
                                  frame_x_mm=float(frame_x_cm) * 10.0, standoff_cm=standoff_cm,
                                  bar_h_mm=bar_h_mm, arm_len_cm=float(arm_len_cm), arm_edge_cm=float(arm_edge_cm)),
        "letters": len(letters), "bolts": len(holes["bolts"]), "wires": len(holes["wires"]),
        "bars": len(bars_y), "w_mm": round(w_mm, 1), "h_mm": round(h_mm, 1),
    }
