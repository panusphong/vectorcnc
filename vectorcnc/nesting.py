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
    # gap เป็นระยะห่าง 'ระหว่างชิ้น' เท่านั้น ไม่ควรกินพื้นที่ขอบแผ่น (margin) ด้วย
    # -> ขยายกริดใช้งานออก 2*_pad (halo ของ gap ยื่นเข้ามาในเขต margin ได้ _pad) ทำให้ชิ้นที่ = พื้นที่ใช้งานพอดี วางได้
    _pad = min(gap / 2.0, margin)
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
    SEARCH_RECENT = 4       # ค้นหาช่องเฉพาะ N แผ่นล่าสุด (ไม่วนทุกแผ่น -> เร็วขึ้นมาก)
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


def sheet_svg_bezier(items, sheet_w, sheet_h, stroke='#0EA5A5'):
    """items = list ของ (subs, color_hex) ต่อชิ้นบนแผ่น — เส้นโค้ง Bézier จริง แยกสีต่อเลเยอร์"""
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


def sheet_svg(geoms, sheet_w, sheet_h, stroke='#0EA5A5'):
    """geoms = list ของ shapely geometry (ลายเต็มแต่ละชิ้น) บนแผ่นเดียว"""
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
    s.append('</g></svg>')
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
