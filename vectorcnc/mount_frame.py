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
    top_bar = min(bar_ys)
    bolt_r = bolt_d / 2.0; wire_r = wire_d / 2.0
    bolts = []; wires = []
    for g in letters:
        lb = g.bounds; lx0, ly0, lx1, ly1 = lb
        cx = (lx0 + lx1) / 2.0
        # รูน็อต 2 รู/ตัว/โครง ที่ระดับโครง (ซ้าย-ขวา) — วางในเนื้อตัวอักษร (ไม่หลุดขอบ bbox)
        lw = lx1 - lx0
        for by in bar_ys:
            yy = min(max(by, ly0 + bolt_r + 2), ly1 - bolt_r - 2)   # ให้อยู่ในเนื้อตัวอักษร
            if lw < bolt_d * 5:                                       # ตัวแคบ -> รูเดียวกลาง
                bolts.append((cx, yy, bolt_r))
            else:
                bolts.append((cx - lw * 0.28, yy, bolt_r)); bolts.append((cx + lw * 0.28, yy, bolt_r))
        # รูสายไฟ 1 รู กลางตัว · ระดับเดียวกับรูน็อต (โครงเส้นบน = หลบสายตา) · ขยับขึ้น/ลงได้เอง
        wy = top_bar - float(wire_offset_mm)      # offset > 0 = ขยับขึ้น
        wy = min(max(wy, ly0 + wire_r + 2), ly1 - wire_r - 2)
        wires.append((cx, wy, wire_r))
    return {"bolts": bolts, "wires": wires}


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
    # 🔩 เฟรมกรอบสี่เหลี่ยม (4 ด้าน) ล้อมตัวอักษร + คานขวาง + 2 แขนยื่นขึ้น + จับระยะครบทุกจุด
    fx = frame_x_mm; _m = 40.0
    frX0 = X(b[0] - _m + fx); frX1 = X(b[2] + _m + fx)
    frY0 = Yv(b[1] - _m); frY1 = Yv(b[3] + _m)
    fxl = min(frX0, frX1); fxr = max(frX0, frX1); bw = fxr - fxl
    hh = bar_h_mm * sc
    for (rx, ry, rw, rh) in ((fxl, frY0 - hh/2, bw, hh), (fxl, frY1 - hh/2, bw, hh),
                             (fxl - hh/2, frY0, hh, frY1 - frY0), (fxr - hh/2, frY0, hh, frY1 - frY0)):
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (rx, ry, rw, rh))
    for by in bar_ys:                                       # คานขวางตามระดับรูน็อต
        yy = Yv(by)
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (fxl, yy - hh*0.4, bw, hh*0.8))
    _epx = float(arm_edge_cm) * 10.0 * sc                   # ระยะแขนจากขอบ (px)
    _axL = fxl + _epx; _axR = fxr - _epx                    # 2 แขน ซ้าย-ขวา
    _ay = frY0 - hh/2; _atop = 16.0                         # ปลายแขนบน (ใกล้ขอบบนภาพ)
    for _ax in (_axL, _axR):
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="#8b93a0" stroke="#5b626d" stroke-width="1"/>' % (_ax - hh*0.35, _atop, hh*0.7, _ay - _atop))
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="#c6ccd6" stroke="#5b626d" stroke-width="1"/>' % (_ax - hh*1.1, _atop - hh*0.5, hh*2.2, hh*0.6))
    _FWcm = round((abs(b[2]-b[0]) + 2*_m)/10.0); _FHcm = round((abs(b[3]-b[1]) + 2*_m)/10.0)
    _RD = "#dc2626"; _BL = "#2563eb"

    def _dv(x, y0, y1, txt, col):    # เส้นจับระยะแนวตั้ง + ป้าย (หมุน)
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x, y0, x, y1, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="12" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%s</text>' % (x-4, (y0+y1)/2, col, x-4, (y0+y1)/2, txt))

    def _dh(x0, x1, y, txt, col):    # เส้นจับระยะแนวนอน + ป้าย
        p.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="1.1"/>' % (x0, y, x1, y, col))
        p.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="12" font-weight="700" fill="%s" text-anchor="middle">%s</text>' % ((x0+x1)/2, y-4, col, txt))
    _dv(_axL - hh*1.5, _atop, _ay, "แขน %.0f cm" % arm_len_cm, _RD)          # ความสูงแขน
    _dv(fxr + 22, frY0, frY1, "กรอบสูง %d cm" % _FHcm, _BL)                   # ความสูงเฟรมนอก
    _dh(fxl, fxr, frY1 + 20, "กรอบกว้าง %d cm" % _FWcm, _RD)                  # ความกว้างเฟรมนอก
    _dh(fxl, _axL, _atop + hh*1.6, "%.0f cm" % arm_edge_cm, _BL)             # ขอบซ้าย -> แขนซ้าย
    _dh(_axR, fxr, _atop + hh*1.6, "%.0f cm" % arm_edge_cm, _BL)             # แขนขวา -> ขอบขวา
    _dv(fxl - 18, frY0, Yv(b[1]), "ขอบบน %.0f cm" % ((Yv(b[1]) - frY0)/sc/10.0), _RD)   # กรอบบน -> ขอบบนตัวอักษร
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
    segs = []; total_mm = 0.0
    for g in comps:
        gb = g.bounds; y = gb[1] + pitch * 0.5
        while y < gb[3]:
            try:
                inter = g.intersection(LineString([(gb[0] - 10, y), (gb[2] + 10, y)]))
            except Exception:
                inter = None
            if inter is not None and not inter.is_empty:
                parts = list(inter.geoms) if inter.geom_type == "MultiLineString" else [inter]
                for ls in parts:
                    if getattr(ls, "geom_type", "") == "LineString" and ls.length > 6:
                        cs = list(ls.coords)
                        segs.append((cs[0][0], cs[0][1], cs[-1][0], cs[-1][1]))
                        total_mm += ls.length
            y += pitch
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
    p.append('<text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="15" font-weight="800" fill="#ffcf4d">LED Ribbon &#183; ความยาวรวม %.2f ม. &#183; %.0f W &#183; %.1f A (@%.0fV) &#183; หม้อแปลง %d W</text>'
             % (pad, ty, total_m, watts, amps, float(volt), ps))
    p.append("</svg>")
    return {"segments": len(segs), "total_m": round(total_m, 2), "watts": round(watts, 1),
            "amps": round(amps, 2), "transformer_w": ps, "pitch_cm": float(pitch_cm),
            "preview_svg": "".join(p)}


def build(full, bars=1, bar_y_cm=None, gap_cm=20.0, frame_x_cm=0.0, standoff_cm=5.0,
          bolt_d=3.0, wire_d=5.0, wire_offset_cm=0.0, bar_h_mm=15.0,
          arm_len_cm=30.0, arm_edge_cm=20.0):
    """ประกอบครบ: คืน dict {cut_dxf, cut_svg, back_svg, letters, bolts, wires}"""
    b = full.bounds; w_mm = b[2] - b[0]; h_mm = b[3] - b[1]
    letters = split_letters(full)
    if not letters:
        return {"error": "แยกตัวอักษรไม่ได้ (ภาพควรเป็นตัวอักษร/โลโก้แยกชิ้น)"}
    bars_y = frame_bars(full, bars=bars, bar_y_cm=bar_y_cm, gap_cm=gap_cm, bar_h_mm=bar_h_mm)
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
