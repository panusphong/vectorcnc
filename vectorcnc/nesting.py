"""Deep Nesting (จัดวางชิ้นตามรูปจริง) — raster bottom-left-fill + FFT collision
v2: full-geometry (วางลายครบทุกเส้นในทุกชิ้น) + จูนแพคแน่นขึ้น (เลือกแนวหมุนที่ฟิตสุด)
ใช้ numpy + scipy + shapely (+ ezdxf, opencv)
"""
import math
import numpy as np
import cv2
from scipy.signal import fftconvolve
from shapely.affinity import rotate as _rotate, translate as _translate
import ezdxf

NESTING_VERSION = "2026-07-10-multi-zones"   # + nest_multi: หลายไฟล์รวมแผ่น แยกโซน+เส้นกั้น+ป้าย


def _raster(poly, res):
    minx, miny, maxx, maxy = poly.bounds
    w = max(1, int(np.ceil((maxx - minx) / res)))
    h = max(1, int(np.ceil((maxy - miny) / res)))
    m = np.zeros((h, w), np.float32)
    def draw(ring, val):
        pts = np.array([[(x - minx) / res, (y - miny) / res] for x, y in ring.coords], np.int32)
        cv2.fillPoly(m, [pts], val)
    draw(poly.exterior, 1)
    for r in poly.interiors:
        draw(r, 0)
    return m


def _place(occ, mask):
    grows, gcols = occ.shape
    h, w = mask.shape
    if h > grows or w > gcols:
        return None
    conv = fftconvolve(occ, mask[::-1, ::-1], mode='valid')
    ys, xs = np.where(conv < 0.5)
    if len(ys) == 0:
        return None
    i = np.lexsort((xs, ys))[0]
    return int(ys[i]), int(xs[i])


def _order_rots(buf, rots, uw, uh):
    """เรียงมุมหมุนโดยเอาแนวที่ใส่ได้เยอะสุด (bbox grid) ไว้ก่อน -> แพคเป็นแถวสม่ำเสมอ"""
    def fit(rd):
        b = _rotate(buf, rd, origin='centroid')
        minx, miny, maxx, maxy = b.bounds
        w, h = maxx - minx, maxy - miny
        if w <= 0 or h <= 0:
            return 0
        return int(uw // w) * int(uh // h)
    return sorted(rots, key=lambda r: -fit(r))


def nest(parts, sheet_w, sheet_h, margin=10.0, gap=5.0,
         rotations=(0, 90, 180, 270), res=2.0):
    """parts = [(footprint_polygon_mm, qty), ...]
    คืน dict: placements=[[{part,rot,dx,dy,cx,cy}...] ต่อแผ่น], utilization, n_sheets, n_parts, unplaced"""
    # จำกัดจำนวนเซลล์กริด -> คุมหน่วยความจำ/เวลา (กัน 502/OOM บนเซิร์ฟเวอร์ฟรี)
    CELL_CAP = 150000
    # ---- auto-fit margin: ถ้าชิ้นใหญ่จนใส่ไม่ได้เพราะขอบ แต่ยัง <= ขนาดแผ่น -> ลด margin ให้พอดี (ตัดชิดขอบ) ----
    try:
        need_w = need_h = 0.0
        for _poly, _q in parts:
            b = _poly.bounds; pw = b[2] - b[0]; ph = b[3] - b[1]
            fit0 = (pw <= sheet_w - 2 * margin) and (ph <= sheet_h - 2 * margin)
            fit90 = (ph <= sheet_w - 2 * margin) and (pw <= sheet_h - 2 * margin)
            if not (fit0 or fit90):                       # ชิ้นนี้ใส่ไม่ได้ด้วย margin ปัจจุบัน
                need_w = max(need_w, min(pw, ph))         # ด้านที่ต้องวางตามแนวกว้างแผ่น
                need_h = max(need_h, max(pw, ph))
        if need_w > 0:
            m_w = (sheet_w - need_w) / 2.0
            m_h = (sheet_h - need_h) / 2.0
            m_fit = max(0.0, min(m_w, m_h) - 0.5)         # เผื่อ 0.5mm
            if m_fit < margin:
                margin = m_fit                            # ลดขอบให้ชิ้นใหญ่สุดใส่ได้
    except Exception:
        pass
    # gap เป็นระยะห่าง 'ระหว่างชิ้น' เท่านั้น ไม่ควรกินพื้นที่ขอบแผ่น (margin) ด้วย
    # -> ขยายกริดใช้งานออก 2*_pad (halo ของ gap ยื่นออกนอกขอบได้ ตัวชิ้นยังอยู่ในแผ่น) ทำให้ชิ้นที่ = พื้นที่ใช้งาน/= ขนาดแผ่น วางได้
    _pad = gap / 2.0
    grows = int(math.ceil((sheet_h - 2 * margin + 2 * _pad) / res))
    gcols = int(math.ceil((sheet_w - 2 * margin + 2 * _pad) / res))
    if grows * gcols > CELL_CAP:
        res = res * math.sqrt(grows * gcols / float(CELL_CAP))
        grows = int(math.ceil((sheet_h - 2 * margin + 2 * _pad) / res))
        gcols = int(math.ceil((sheet_w - 2 * margin + 2 * _pad) / res))
    if grows < 2 or gcols < 2:
        return {'placements': [], 'utilization': 0, 'n_sheets': 0, 'n_parts': 0, 'unplaced': 0}
    uw, uh = sheet_w - 2 * margin + 2 * _pad, sheet_h - 2 * margin + 2 * _pad

    def _bbox_area(p):
        b = p.bounds
        return (b[2] - b[0]) * (b[3] - b[1])

    inst = []   # (part_idx, footprint)
    for idx, (poly, qty) in enumerate(parts):
        for _ in range(int(qty)):
            inst.append((idx, poly))
    inst.sort(key=lambda t: -_bbox_area(t[1]))   # กรอบใหญ่ก่อน (วงแหวนวางก่อน -> เติมชิ้นเล็กในรู)

    # ---- คุมงานไม่ให้ระเบิด (กัน 502/OOM/timeout บน Render ฟรี) เมื่อไฟล์ .ai มีชิ้นเยอะ ----
    MAX_INST = 600          # จำนวนชิ้นรวมสูงสุดที่จะจัดวาง (ที่เหลือ = unplaced ไม่ crash)
    MAX_SHEETS = 40         # เพดานจำนวนแผ่น
    SEARCH_RECENT = 40      # ค้นทุกแผ่น (ย้อนเติมช่องว่างแผ่นแรกๆ เช่น กลางกรอบ -> แพคแน่น ประหยัดแผ่น)
    unplaced = 0
    if len(inst) > MAX_INST:
        unplaced += len(inst) - MAX_INST
        inst = inst[:MAX_INST]

    placements = [[]]
    occs = [np.zeros((grows, gcols), np.float32)]
    part_area = 0.0
    _rcache = {}            # cache raster ต่อ (idx, มุม) -> ไม่ raster ซ้ำทุกครั้ง (เร็วขึ้นมากเมื่อชิ้นซ้ำ)

    def _mask_for(idx, poly, cx, cy, rd):
        key = (idx, rd)
        m = _rcache.get(key)
        if m is None:
            bufr = _rotate(poly.buffer(gap / 2.0, join_style=1), rd, origin=(cx, cy))
            m = _raster(bufr, res)
            _rcache[key] = (m, bufr.bounds[0], bufr.bounds[1])
            return _rcache[key]
        return m

    for idx, poly in inst:
        part_area += poly.area
        c = poly.centroid
        cx, cy = c.x, c.y
        buf = poly.buffer(gap / 2.0, join_style=1)
        rots = _order_rots(buf, rotations, uw, uh)

        best = None   # (sheet, row, col, rot, mask, bx0, by0)
        lo = max(0, len(placements) - SEARCH_RECENT)
        for si in range(lo, len(placements)):
            for rd in rots:
                m, bx0, by0 = _mask_for(idx, poly, cx, cy, rd)
                pos = _place(occs[si], m)
                if pos and (best is None or pos[0] < best[1] or (pos[0] == best[1] and pos[1] < best[2])):
                    best = (si, pos[0], pos[1], rd, m, bx0, by0)
            if best and best[0] == si:
                break
        if best is None and len(placements) < MAX_SHEETS:
            placements.append([])
            occs.append(np.zeros((grows, gcols), np.float32))
            si = len(placements) - 1
            for rd in rots:
                m, bx0, by0 = _mask_for(idx, poly, cx, cy, rd)
                pos = _place(occs[si], m)
                if pos:
                    best = (si, pos[0], pos[1], rd, m, bx0, by0)
                    break
        if best is None:
            unplaced += 1
            continue
        si, row, col, rd, m, bx0, by0 = best
        h, w = m.shape
        occs[si][row:row + h, col:col + w] = np.maximum(occs[si][row:row + h, col:col + w], m)
        placements[si].append({'part': idx, 'rot': rd,
                               'dx': (margin - _pad) + col * res - bx0,
                               'dy': (margin - _pad) + row * res - by0,
                               'cx': cx, 'cy': cy})

    n = len(placements)
    util = round(part_area / (n * sheet_w * sheet_h) * 100, 1) if n else 0
    return {'placements': placements, 'utilization': util, 'n_sheets': n,
            'n_parts': len(inst), 'unplaced': unplaced}


def place_geom(geom, pl):
    """วาง geometry (ลายเต็ม) ตาม transform ของ placement"""
    g = _rotate(geom, pl['rot'], origin=(pl['cx'], pl['cy']))
    return _translate(g, xoff=pl['dx'], yoff=pl['dy'])


# ---------- Bézier path (คุณภาพ Illustrator) ----------
# subpath = {'start':(x,y), 'segs':[('L',pt)|('C',c1,c2,e)], 'closed':bool} · หน่วยมม. Y ชี้ลง
def place_subs(subs, pl):
    """แปลง bezier subpaths ตาม placement (หมุน+เลื่อน) — คงเส้นโค้งจริง ตรงกับ place_geom เป๊ะ"""
    th = math.radians(pl['rot']); cs = math.cos(th); sn = math.sin(th)
    cx, cy, dx, dy = pl['cx'], pl['cy'], pl['dx'], pl['dy']

    def T(p):
        x0 = p[0] - cx; y0 = p[1] - cy
        return (x0 * cs - y0 * sn + cx + dx, x0 * sn + y0 * cs + cy + dy)

    out = []
    for sp in subs:
        segs = []
        for s in sp['segs']:
            segs.append(('L', T(s[1])) if s[0] == 'L' else ('C', T(s[1]), T(s[2]), T(s[3])))
        out.append({'start': T(sp['start']), 'segs': segs, 'closed': sp.get('closed', False)})
    return out


def _sp_d(sp):
    d = ['M %.3f %.3f' % sp['start']]
    for s in sp['segs']:
        if s[0] == 'L':
            d.append('L %.3f %.3f' % s[1])
        else:
            d.append('C %.3f %.3f %.3f %.3f %.3f %.3f' %
                     (s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]))
    if sp.get('closed'):
        d.append('Z')
    return ' '.join(d)


def _dim_labels_svg(labels, sheet_w, sheet_h):
    """วาด 'เส้นจับระยะ' กว้าง (ด้านบน) × สูง (ด้านข้าง) พร้อมหัวลูกศร + ตัวเลข ต่อแต่ละชิ้น
    labels = list ของ (x0, y0, x1, y1) = กรอบชิ้น (มม., แกน SVG Y ลง)"""
    if not labels:
        return []
    smin = min(sheet_w, sheet_h)
    col = '#dc2626'
    out = []
    for (x0, y0, x1, y1) in labels:
        w = x1 - x0; h = y1 - y0
        if w <= 1 or h <= 1:
            continue
        fs = max(smin * 0.011, min(smin * 0.05, min(w, h) * 0.09))
        lw = max(0.4, fs * 0.09)          # ความหนาเส้นจับระยะ
        off = min(fs * 1.5, min(w, h) * 0.16)   # เยื้องเข้าจากขอบชิ้น
        aw = fs * 0.55                    # ขนาดหัวลูกศร
        yW = y0 + off                     # เส้นกว้าง (ใกล้ขอบบน ในชิ้น)
        xH = x0 + off                     # เส้นสูง (ใกล้ขอบซ้าย ในชิ้น)

        def _txt(x, y, s, rot=None):
            tr = f' transform="rotate({rot} {x:.1f} {y:.1f})"' if rot is not None else ''
            c = (f'x="{x:.1f}" y="{y:.1f}" font-family="Prompt, Arial, sans-serif" font-size="{fs:.1f}" '
                 f'font-weight="700" text-anchor="middle" dominant-baseline="central"{tr}')
            return (f'<text {c} fill="none" stroke="#ffffff" stroke-width="{fs*0.28:.1f}" stroke-linejoin="round">{s}</text>'
                    f'<text {c} fill="{col}">{s}</text>')

        # ---- กว้าง (แนวนอน ใกล้ขอบบน) ----
        out.append(f'<line x1="{x0:.1f}" y1="{yW:.1f}" x2="{x1:.1f}" y2="{yW:.1f}" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(f'<path d="M {x0+aw:.1f} {yW-aw*0.6:.1f} L {x0:.1f} {yW:.1f} L {x0+aw:.1f} {yW+aw*0.6:.1f}" fill="none" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(f'<path d="M {x1-aw:.1f} {yW-aw*0.6:.1f} L {x1:.1f} {yW:.1f} L {x1-aw:.1f} {yW+aw*0.6:.1f}" fill="none" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(_txt((x0 + x1) / 2.0, yW - fs * 0.75, '%.1f ซม.' % (w / 10.0)))

        # ---- สูง (แนวตั้ง ใกล้ขอบซ้าย) ----
        out.append(f'<line x1="{xH:.1f}" y1="{y0:.1f}" x2="{xH:.1f}" y2="{y1:.1f}" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(f'<path d="M {xH-aw*0.6:.1f} {y0+aw:.1f} L {xH:.1f} {y0:.1f} L {xH+aw*0.6:.1f} {y0+aw:.1f}" fill="none" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(f'<path d="M {xH-aw*0.6:.1f} {y1-aw:.1f} L {xH:.1f} {y1:.1f} L {xH+aw*0.6:.1f} {y1-aw:.1f}" fill="none" stroke="{col}" stroke-width="{lw:.2f}"/>')
        out.append(_txt(xH + fs * 0.75, (y0 + y1) / 2.0, '%.1f ซม.' % (h / 10.0), rot=-90))
    return out


def sheet_svg_bezier(items, sheet_w, sheet_h, stroke='#0EA5A5', labels=None):
    """items = list ของ (subs, color_hex) ต่อชิ้นบนแผ่น — เส้นโค้ง Bézier จริง แยกสีต่อเลเยอร์
    labels = list ของ (cx, cy, w_mm, h_mm) เพื่อพิมพ์ขนาด กว้าง×สูง ของแต่ละชิ้น"""
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.1f}mm" height="{sheet_h:.1f}mm" '
         f'viewBox="0 0 {sheet_w:.1f} {sheet_h:.1f}">',
         f'<rect x="0" y="0" width="{sheet_w:.1f}" height="{sheet_h:.1f}" fill="none" stroke="#94a3b8" stroke-width="1"/>']
    for it in items:
        subs = it[0]; col = it[1] if len(it) > 1 and it[1] else stroke
        s.append(f'<g fill="none" stroke="{col}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round">')
        for sp in subs:
            if len(sp['segs']) < 1:
                continue
            s.append(f'  <path d="{_sp_d(sp)}"/>')
        s.append('</g>')
    s.extend(_dim_labels_svg(labels, sheet_w, sheet_h))
    s.append('</svg>')
    return '\n'.join(s)


def write_dxf_bezier(sheets_items, path, sheet_w, sheet_h, gap_between=50.0):
    """DXF หน่วยมม. — SPLINE(โค้ง)+LINE(ตรง) · แยกเลเยอร์ CUT_<ชื่อ> คนละสี ต่อแหล่งเลเยอร์
    sheets_items = list ต่อแผ่น ของ (subs, rgb, layer_name)"""
    doc = ezdxf.new('R2010')
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for si, items in enumerate(sheets_items):
        ox = si * (sheet_w + gap_between)
        bl = 'SHEET_%d' % (si + 1)
        if bl not in doc.layers:
            doc.layers.add(bl)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': bl, 'color': 8})

        def tf(p):
            return (ox + p[0], sheet_h - p[1])   # flip Y (ระบบ CAD)

        for it in items:
            subs = it[0]
            rgb = it[2] if len(it) > 2 else None
            lname = it[3] if len(it) > 3 and it[3] else 'CUT'
            lyname = 'CUT_' + str(lname)
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                if rgb:
                    try: lay.rgb = rgb
                    except Exception: pass
            for sp in subs:
                # flatten ทั้ง subpath เป็น LWPOLYLINE เดียว (เล็ก+เร็ว) — โค้ง sample chord ~0.3mm
                cur = sp['start']; pts = [tf(cur)]
                for s in sp['segs']:
                    if s[0] == 'L':
                        pts.append(tf(s[1])); cur = s[1]
                    else:
                        c1, c2, e = s[1], s[2], s[3]
                        L = (abs(c1[0]-cur[0]) + abs(c1[1]-cur[1]) + abs(c2[0]-c1[0]) + abs(c2[1]-c1[1]) +
                             abs(e[0]-c2[0]) + abs(e[1]-c2[1]))
                        N = int(min(100, max(4, L / 0.3)))
                        for i in range(1, N + 1):
                            t = i / float(N); mt = 1.0 - t
                            x = mt*mt*mt*cur[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t*t*t*e[0]
                            y = mt*mt*mt*cur[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t*t*t*e[1]
                            pts.append(tf((x, y)))
                        cur = e
                if len(pts) >= 2:
                    msp.add_lwpolyline(pts, close=bool(sp.get('closed', True)),
                                       dxfattribs={'layer': lyname})
    doc.saveas(path)
    return path


def _add_contour_dxf(layout, sp, layer, tf=None):
    """เขียน 1 คอนทัวร์เป็นสไปลน์ปิด degree-3 เส้นเดียว (มาตรฐานไฟล์ตัดโรงงาน/laser fiber)
    - ตรงล้วน -> LWPOLYLINE ปิด · มีโค้ง -> B-spline ปิดเส้นเดียว (เส้นตรง = cubic คุมจุดบนคอร์ด = ตรงเป๊ะ)"""
    import ezdxf.path as _ep
    from ezdxf.math import BSpline as _BSpline
    if tf is None:
        tf = lambda p: (p[0], p[1])
    segs = sp.get('segs') or []
    if not segs:
        return
    start = sp['start']
    if not any(s[0] == 'C' for s in segs):
        pts = [tf(start)] + [tf(s[1]) for s in segs]
        layout.add_lwpolyline(pts, close=True, dxfattribs={'layer': layer}); return
    p = _ep.Path(tf(start)); cur = start
    for s in segs:
        if s[0] == 'L':
            e = s[1]
            c1 = (cur[0] + (e[0]-cur[0])/3.0, cur[1] + (e[1]-cur[1])/3.0)
            c2 = (cur[0] + 2.0*(e[0]-cur[0])/3.0, cur[1] + 2.0*(e[1]-cur[1])/3.0)
            p.curve4_to(tf(e), tf(c1), tf(c2)); cur = e
        else:
            p.curve4_to(tf(s[3]), tf(s[1]), tf(s[2])); cur = s[3]
    p.close()
    items = list(_ep.to_bsplines_and_vertices(p))
    single = (len(items) == 1)
    for item in items:
        if isinstance(item, _BSpline):
            spl = layout.add_spline(dxfattribs={'layer': layer})
            spl.apply_construction_tool(item)
            if single:
                spl.closed = True
        else:
            vs = [(v[0], v[1]) for v in item]
            if len(vs) >= 2:
                layout.add_lwpolyline(vs, close=single, dxfattribs={'layer': layer})


def write_dxf_bezier_blocks(pieces, placements, path, sheet_w, sheet_h, gap_between=50.0):
    """DXF ขนาดเล็กด้วย BLOCK+INSERT — นิยาม 1 บล็อกต่อชิ้น (spline เต็มคุณภาพ) แล้ว INSERT ซ้ำ
    pieces[i]   = list ของ (subs, color, rgb, layer_name)  (geometry ต้นฉบับ ยังไม่ transform)
    placements  = [[{part,rot,dx,dy,cx,cy}, ...] ต่อแผ่น]  (จาก nest())"""
    doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    blocks = {}
    for idx, groups in enumerate(pieces):
        bname = 'PIECE_%d' % idx
        blk = doc.blocks.new(name=bname)
        for grp in groups:
            subs = grp[0]; rgb = grp[2] if len(grp) > 2 else None
            lname = grp[3] if len(grp) > 3 and grp[3] else 'CUT'
            lyname = 'CUT_' + str(lname)
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                if rgb:
                    try: lay.rgb = rgb
                    except Exception: pass
            for sp in subs:
                try:
                    _add_contour_dxf(blk, sp, lyname)           # 1 คอนทัวร์ = 1 สไปลน์ปิด (แบบไฟล์โรงงาน)
                except Exception:
                    cur = sp['start']                            # สำรอง: เขียนทีละ segment
                    for seg in sp['segs']:
                        if seg[0] == 'L':
                            blk.add_line(cur, seg[1], dxfattribs={'layer': lyname}); cur = seg[1]
                        else:
                            blk.add_open_spline([cur, seg[1], seg[2], seg[3]], degree=3,
                                                dxfattribs={'layer': lyname}); cur = seg[3]
        blocks[idx] = bname
    for si, sheet in enumerate(placements):
        ox = si * (sheet_w + gap_between)
        bl = 'SHEET_%d' % (si + 1)
        if bl not in doc.layers:
            doc.layers.add(bl)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': bl, 'color': 8})
        for pl in sheet:
            bname = blocks.get(pl['part'])
            if not bname:
                continue
            th = math.radians(pl['rot']); cs = math.cos(th); sn = math.sin(th)
            cx, cy, dx, dy = pl['cx'], pl['cy'], pl['dx'], pl['dy']
            ix = ox - cs * cx + sn * cy + cx + dx            # ให้ตรงกับ tf(place_subs) เป๊ะ
            iy = sheet_h + sn * cx + cs * cy - cy - dy        # (flip Y = yscale -1, rotation -rot)
            msp.add_blockref(bname, (ix, iy), dxfattribs={
                'rotation': -pl['rot'], 'xscale': 1.0, 'yscale': -1.0})
    doc.saveas(path)
    return path


def _rings(geom):
    """ดึงทุกวง (coords, closed) จาก geometry ใดๆ"""
    if geom is None or geom.is_empty:
        return
    t = geom.geom_type
    if t == 'Polygon':
        yield [(x, y) for x, y in geom.exterior.coords], True
        for r in geom.interiors:
            yield [(x, y) for x, y in r.coords], True
    elif t in ('MultiPolygon', 'GeometryCollection', 'MultiLineString'):
        for g in geom.geoms:
            for r in _rings(g):
                yield r
    elif t == 'LineString':
        yield [(x, y) for x, y in geom.coords], False


def sheet_svg(geoms, sheet_w, sheet_h, stroke='#0EA5A5', labels=None):
    """geoms = list ของ shapely geometry (ลายเต็มแต่ละชิ้น) บนแผ่นเดียว
    labels = list ของ (cx, cy, w_mm, h_mm) เพื่อพิมพ์ขนาด กว้าง×สูง ของแต่ละชิ้น"""
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.1f}mm" height="{sheet_h:.1f}mm" '
         f'viewBox="0 0 {sheet_w:.1f} {sheet_h:.1f}">',
         f'<rect x="0" y="0" width="{sheet_w:.1f}" height="{sheet_h:.1f}" fill="none" stroke="#94a3b8" stroke-width="1"/>',
         f'<g fill="none" stroke="{stroke}" stroke-width="1" stroke-linejoin="round">']
    for g in geoms:
        for coords, closed in _rings(g):
            if len(coords) < 2:
                continue
            d = 'M ' + ' L '.join(f'{x:.2f},{y:.2f}' for x, y in coords) + (' Z' if closed else '')
            s.append(f'  <path d="{d}"/>')
    s.append('</g>')
    s.extend(_dim_labels_svg(labels, sheet_w, sheet_h))
    s.append('</svg>')
    return '\n'.join(s)


def write_dxf(sheets_geoms, path, sheet_w, sheet_h, gap_between=50.0):
    """DXF หน่วยมม. — เรียงแผ่นในแกน X (Y ชี้ขึ้นแบบ CAD) · ลายเต็มทุกชิ้น"""
    doc = ezdxf.new('R2010')
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for si, geoms in enumerate(sheets_geoms):
        ox = si * (sheet_w + gap_between)
        ly = 'SHEET_%d' % (si + 1)
        if ly not in doc.layers:
            doc.layers.add(ly)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': ly, 'color': 8})
        for g in geoms:
            for coords, closed in _rings(g):
                if len(coords) < 2:
                    continue
                pts = [(ox + x, sheet_h - y) for x, y in coords]
                msp.add_lwpolyline(pts, close=closed, dxfattribs={'layer': ly})
    doc.saveas(path)
    return path


# ==================== หลายไฟล์รวมแผ่น: แยกโซนต่อไฟล์ + เส้นกั้น ====================
def nest_multi(files, sheet_w, sheet_h, margin=10.0, gap=5.0, divider_gap=14.0, res=None):
    """จัดวาง 'หลายไฟล์' ลงแผ่นเดียวกันแบบ 'แยกโซนต่อไฟล์ + เส้นกั้น'
    files = list ของ dict:
      { 'label':'A', 'name':'logo.ai', 'color':'#2563EB', 'rgb':(37,99,235),
        'nest_pieces':[ {'poly':shapely, 'groups':[(subs,color,rgb,layer),...]}, ... ],
        'qty':int }
    วิธี: nest แต่ละไฟล์แยกก่อน (ได้ 'บล็อก' ต่อแผ่นเสมือน) -> วางบล็อกซ้อนแนวตั้งลงแผ่นจริง
          ไฟล์ต่างกันมีเส้นกั้นคั่น (layer DIVIDER) + ป้ายรหัสไฟล์ (layer LABEL)
    คืน dict: sheets[], global_pieces[], placements[], file_layouts[], per_file[], n_sheets, utilization, unplaced
    """
    if res is None:
        res = max(3.0, min(sheet_w, sheet_h) / 360.0)
    usable_h = sheet_h - 2 * margin

    global_pieces = []          # index gpi -> groups
    file_layouts = []           # ต่อไฟล์: สำหรับ DXF รายไฟล์
    blocks = []                 # {'fi','y0','y1','pcs':[(gpi,pl,lpi)]}
    unplaced = 0

    for fi, f in enumerate(files):
        nps = f.get('nest_pieces') or []
        qty = max(1, int(f.get('qty', 1)))
        if not nps:
            file_layouts.append({'label': f.get('label', ''), 'name': f.get('name', ''),
                                 'pieces': [], 'placements': []})
            continue
        parts = [(pc['poly'], qty) for pc in nps]
        nf = nest(parts, float(sheet_w), float(sheet_h),
                  margin=float(margin), gap=float(gap), res=res, rotations=(0, 90))
        unplaced += nf.get('unplaced', 0)
        base = len(global_pieces)
        for pc in nps:
            global_pieces.append(pc['groups'])
        file_layouts.append({'label': f.get('label', ''), 'name': f.get('name', ''),
                             'pieces': [pc['groups'] for pc in nps],
                             'placements': nf['placements']})
        for sheet in nf['placements']:
            if not sheet:
                continue
            y0 = 1e18; y1 = -1e18; pcs = []
            for pl in sheet:
                lpi = pl['part']
                b = place_geom(nps[lpi]['poly'], pl).bounds
                if b[1] < y0: y0 = b[1]
                if b[3] > y1: y1 = b[3]
                pcs.append((base + lpi, pl, lpi))
            blocks.append({'fi': fi, 'y0': y0, 'y1': y1, 'pcs': pcs})

    # ---- วางบล็อกซ้อนแนวตั้งลงแผ่นจริง ----
    real = [{'placed': [], 'dividers': [], 'zones': []}]
    cursorY = margin
    last_fi = None
    for blk in blocks:
        bh = blk['y1'] - blk['y0']
        cur = real[-1]
        if cur['placed'] and (cursorY + divider_gap + bh > sheet_h - margin) and bh <= usable_h + 0.5:
            real.append({'placed': [], 'dividers': [], 'zones': []})
            cur = real[-1]; cursorY = margin; last_fi = None
        yshift = cursorY - blk['y0']
        if cur['placed'] and last_fi is not None and last_fi != blk['fi']:
            cur['dividers'].append(cursorY - divider_gap * 0.5)
        f = files[blk['fi']]
        cur['zones'].append((margin + 2.0, cursorY, blk['fi'],
                             (f.get('label', '') + '  ' + f.get('name', '')).strip(), f.get('color', '#2563EB')))
        for (gpi, pl, lpi) in blk['pcs']:
            pl2 = dict(pl); pl2['dy'] = pl['dy'] + yshift; pl2['part'] = gpi
            cur['placed'].append((blk['fi'], gpi, lpi, pl2))
        cursorY += bh + divider_gap
        last_fi = blk['fi']

    # ---- สร้างโครงเรนเดอร์ + สถิติ ----
    out_sheets = []; placements_by_sheet = []
    per_area = {}; per_placed = {}; total_area = 0.0
    for cur in real:
        if not cur['placed']:
            continue
        items = []; labels = []; pls = []
        for (fi, gpi, lpi, pl2) in cur['placed']:
            fcolor = files[fi].get('color', '#2563EB')
            for grp in global_pieces[gpi]:
                items.append((place_subs(grp[0], pl2), fcolor))
            poly = files[fi]['nest_pieces'][lpi]['poly']
            b = place_geom(poly, pl2).bounds
            labels.append((b[0], b[1], b[2], b[3]))
            a = poly.area
            per_area[fi] = per_area.get(fi, 0.0) + a; total_area += a
            per_placed[fi] = per_placed.get(fi, 0) + 1
            pls.append(pl2)
        out_sheets.append({'items': items, 'labels': labels,
                           'dividers': list(cur['dividers']), 'zones': list(cur['zones'])})
        placements_by_sheet.append(pls)

    per_file = []
    for fi, f in enumerate(files):
        per_file.append({'label': f.get('label', ''), 'name': f.get('name', ''),
                         'color': f.get('color', '#2563EB'),
                         'placed': per_placed.get(fi, 0),
                         'area_ratio': round(per_area.get(fi, 0.0) / total_area, 4) if total_area else 0.0})
    n = len(out_sheets)
    util = round(total_area / (n * sheet_w * sheet_h) * 100, 1) if n else 0
    return {'sheets': out_sheets, 'global_pieces': global_pieces,
            'placements': placements_by_sheet, 'file_layouts': file_layouts,
            'per_file': per_file, 'n_sheets': n, 'utilization': util, 'unplaced': unplaced}


def sheet_svg_zones(sheet, sheet_w, sheet_h, stroke='#0EA5A5'):
    """เรนเดอร์ 1 แผ่น (จาก nest_multi) เป็น SVG: เส้นตัดแยกสีต่อไฟล์ + เส้นจับระยะ + เส้นกั้น + ป้ายรหัสไฟล์"""
    smin = min(sheet_w, sheet_h)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.1f}mm" height="{sheet_h:.1f}mm" '
         f'viewBox="0 0 {sheet_w:.1f} {sheet_h:.1f}">',
         f'<rect x="0" y="0" width="{sheet_w:.1f}" height="{sheet_h:.1f}" fill="none" stroke="#94a3b8" stroke-width="1"/>']
    # เส้นตัด (แยกสีต่อไฟล์)
    for (subs, col) in sheet.get('items', []):
        c = col or stroke
        s.append(f'<g fill="none" stroke="{c}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">')
        for sp in subs:
            if len(sp['segs']) < 1:
                continue
            s.append(f'  <path d="{_sp_d(sp)}"/>')
        s.append('</g>')
    # เส้นจับระยะ กว้าง×สูง ต่อชิ้น
    s.extend(_dim_labels_svg(sheet.get('labels'), sheet_w, sheet_h))
    # เส้นกั้นระหว่างไฟล์ (มาร์ค — เส้นประ)
    dlw = max(0.6, smin * 0.0016)
    for y in sheet.get('dividers', []):
        s.append(f'<line x1="{0:.1f}" y1="{y:.1f}" x2="{sheet_w:.1f}" y2="{y:.1f}" '
                 f'stroke="#f59e0b" stroke-width="{dlw:.2f}" stroke-dasharray="{smin*0.02:.1f} {smin*0.012:.1f}"/>')
    # ป้ายรหัสไฟล์ (มุมบนซ้ายของโซน)
    fs = max(smin * 0.016, 7.0)
    for z in sheet.get('zones', []):
        x, y, fi, txt, col = z[0], z[1], z[2], z[3], z[4]
        ty = y + fs * 1.15
        s.append(f'<rect x="{x-1:.1f}" y="{y+2:.1f}" width="{fs*0.85:.1f}" height="{fs*1.35:.1f}" rx="{fs*0.2:.1f}" fill="{col}"/>')
        s.append(f'<text x="{x+fs*0.32:.1f}" y="{ty:.1f}" font-family="Prompt, Arial, sans-serif" '
                 f'font-size="{fs:.1f}" font-weight="800" fill="#ffffff" text-anchor="middle">{_esc(txt[:1])}</text>')
        s.append(f'<text x="{x+fs*1.1:.1f}" y="{ty:.1f}" font-family="Prompt, Arial, sans-serif" '
                 f'font-size="{fs*0.82:.1f}" font-weight="700" fill="{col}">{_esc(txt)}</text>')
    s.append('</svg>')
    return '\n'.join(s)


def _esc(t):
    return (str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def write_dxf_zones(global_pieces, placements_by_sheet, dividers_by_sheet, zones_by_sheet,
                    path, sheet_w, sheet_h, gap_between=50.0):
    """DXF รวมทุกแผ่น (BLOCK+INSERT) — CUT_<layer> ต่อชิ้น + DIVIDER (เส้นกั้นมาร์ค) + LABEL (ป้ายรหัสไฟล์ตัวอักษร)"""
    doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    if 'DIVIDER' not in doc.layers:
        _l = doc.layers.add('DIVIDER')
        try: _l.rgb = (245, 158, 11)
        except Exception: pass
    if 'LABEL' not in doc.layers:
        doc.layers.add('LABEL')
    # นิยามบล็อกต่อชิ้น
    blocks = {}
    for idx, groups in enumerate(global_pieces):
        bname = 'PIECE_%d' % idx
        blk = doc.blocks.new(name=bname)
        for grp in groups:
            subs = grp[0]; rgb = grp[2] if len(grp) > 2 else None
            lname = grp[3] if len(grp) > 3 and grp[3] else 'CUT'
            lyname = 'CUT_' + str(lname)
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                if rgb:
                    try: lay.rgb = rgb
                    except Exception: pass
            for sp in subs:
                try:
                    _add_contour_dxf(blk, sp, lyname)
                except Exception:
                    cur = sp['start']
                    for seg in sp['segs']:
                        if seg[0] == 'L':
                            blk.add_line(cur, seg[1], dxfattribs={'layer': lyname}); cur = seg[1]
                        else:
                            blk.add_open_spline([cur, seg[1], seg[2], seg[3]], degree=3,
                                                dxfattribs={'layer': lyname}); cur = seg[3]
        blocks[idx] = bname
    for si, sheet in enumerate(placements_by_sheet):
        ox = si * (sheet_w + gap_between)
        bl = 'SHEET_%d' % (si + 1)
        if bl not in doc.layers:
            doc.layers.add(bl)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': bl, 'color': 8})
        for pl in sheet:
            bname = blocks.get(pl['part'])
            if not bname:
                continue
            th = math.radians(pl['rot']); cs = math.cos(th); sn = math.sin(th)
            cx, cy, dx, dy = pl['cx'], pl['cy'], pl['dx'], pl['dy']
            ix = ox - cs * cx + sn * cy + cx + dx
            iy = sheet_h + sn * cx + cs * cy - cy - dy
            msp.add_blockref(bname, (ix, iy), dxfattribs={
                'rotation': -pl['rot'], 'xscale': 1.0, 'yscale': -1.0})
        # เส้นกั้น (DIVIDER) — flip Y
        for y in (dividers_by_sheet[si] if si < len(dividers_by_sheet) else []):
            msp.add_line((ox, sheet_h - y), (ox + sheet_w, sheet_h - y), dxfattribs={'layer': 'DIVIDER'})
        # ป้ายรหัสไฟล์ (LABEL) — TEXT
        for z in (zones_by_sheet[si] if si < len(zones_by_sheet) else []):
            x, y, txt = z[0], z[1], z[3]
            th_ = max(6.0, min(sheet_w, sheet_h) * 0.016)
            t = msp.add_text(str(txt), dxfattribs={'layer': 'LABEL', 'height': th_})
            try:
                t.set_placement((ox + x, sheet_h - y - th_ * 1.2))
            except Exception:
                t.dxf.insert = (ox + x, sheet_h - y - th_ * 1.2)
    doc.saveas(path)
    return path
