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
    CELL_CAP = 90000
    grows = int((sheet_h - 2 * margin) / res)
    gcols = int((sheet_w - 2 * margin) / res)
    if grows * gcols > CELL_CAP:
        res = res * math.sqrt(grows * gcols / float(CELL_CAP))
        grows = int((sheet_h - 2 * margin) / res)
        gcols = int((sheet_w - 2 * margin) / res)
    if grows < 2 or gcols < 2:
        return {'placements': [], 'utilization': 0, 'n_sheets': 0, 'n_parts': 0, 'unplaced': 0}
    uw, uh = sheet_w - 2 * margin, sheet_h - 2 * margin

    inst = []   # (part_idx, footprint)
    for idx, (poly, qty) in enumerate(parts):
        for _ in range(int(qty)):
            inst.append((idx, poly))
    inst.sort(key=lambda t: -t[1].area)

    placements = [[]]
    occs = [np.zeros((grows, gcols), np.float32)]
    part_area = 0.0
    unplaced = 0

    for idx, poly in inst:
        part_area += poly.area
        c = poly.centroid
        cx, cy = c.x, c.y
        buf = poly.buffer(gap / 2.0, join_style=1)
        rots = _order_rots(buf, rotations, uw, uh)

        best = None   # (sheet, row, col, rot, bufr, mask)
        for si in range(len(placements)):
            for rd in rots:
                bufr = _rotate(buf, rd, origin=(cx, cy))
                m = _raster(bufr, res)
                pos = _place(occs[si], m)
                if pos and (best is None or pos[0] < best[1] or (pos[0] == best[1] and pos[1] < best[2])):
                    best = (si, pos[0], pos[1], rd, bufr, m)
            if best and best[0] == si:
                break
        if best is None:
            placements.append([])
            occs.append(np.zeros((grows, gcols), np.float32))
            si = len(placements) - 1
            for rd in rots:
                bufr = _rotate(buf, rd, origin=(cx, cy))
                m = _raster(bufr, res)
                pos = _place(occs[si], m)
                if pos:
                    best = (si, pos[0], pos[1], rd, bufr, m)
                    break
        if best is None:
            unplaced += 1
            continue
        si, row, col, rd, bufr, m = best
        h, w = m.shape
        occs[si][row:row + h, col:col + w] = np.maximum(occs[si][row:row + h, col:col + w], m)
        bx0, by0 = bufr.bounds[0], bufr.bounds[1]
        placements[si].append({'part': idx, 'rot': rd,
                               'dx': margin + col * res - bx0,
                               'dy': margin + row * res - by0,
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


def sheet_svg_bezier(subs_list, sheet_w, sheet_h, stroke='#0EA5A5'):
    """subs_list = list ของ [subpath,...] (แต่ละชิ้นบนแผ่น) — เส้นโค้ง Bézier จริง เนียนทุกซูม"""
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.1f}mm" height="{sheet_h:.1f}mm" '
         f'viewBox="0 0 {sheet_w:.1f} {sheet_h:.1f}">',
         f'<rect x="0" y="0" width="{sheet_w:.1f}" height="{sheet_h:.1f}" fill="none" stroke="#94a3b8" stroke-width="1"/>',
         f'<g fill="none" stroke="{stroke}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round">']
    for subs in subs_list:
        for sp in subs:
            if len(sp['segs']) < 1:
                continue
            s.append(f'  <path d="{_sp_d(sp)}"/>')
    s.append('</g></svg>')
    return '\n'.join(s)


def write_dxf_bezier(sheets_subs, path, sheet_w, sheet_h, gap_between=50.0):
    """DXF หน่วยมม. — SPLINE(โค้ง)+LINE(ตรง) · เรียงแผ่นในแกน X (Y ชี้ขึ้นแบบ CAD)"""
    doc = ezdxf.new('R2010')
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for si, subs_list in enumerate(sheets_subs):
        ox = si * (sheet_w + gap_between)
        ly = 'SHEET_%d' % (si + 1)
        if ly not in doc.layers:
            doc.layers.add(ly)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': ly, 'color': 8})

        def tf(p):
            return (ox + p[0], sheet_h - p[1])   # flip Y (ระบบ CAD)

        for subs in subs_list:
            for sp in subs:
                cur = sp['start']
                for s in sp['segs']:
                    if s[0] == 'L':
                        msp.add_line(tf(cur), tf(s[1]), dxfattribs={'layer': ly})
                        cur = s[1]
                    else:
                        msp.add_open_spline([tf(cur), tf(s[1]), tf(s[2]), tf(s[3])],
                                            degree=3, dxfattribs={'layer': ly})
                        cur = s[3]
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
