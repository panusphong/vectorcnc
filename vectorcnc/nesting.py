"""Deep Nesting (จัดวางชิ้นตามรูปจริง) — raster bottom-left-fill + FFT collision
- จัดชิ้นตามรูปจริง (ไม่ใช่กล่องสี่เหลี่ยม) หมุนได้ เว้น gap/margin
- ขึ้นแผ่นใหม่อัตโนมัติ + คำนวณ %การใช้วัสดุ/จำนวนแผ่น
- ออก SVG (พรีวิว/ตัด) + DXF (มม.) ต่อ BOM ได้
ใช้ numpy + scipy + shapely (+ ezdxf, opencv)
"""
import numpy as np
import cv2
from scipy.signal import fftconvolve
from shapely.affinity import rotate as _rot, translate as _tr
import ezdxf


def _raster(poly, res):
    minx, miny, maxx, maxy = poly.bounds
    w = max(1, int(np.ceil((maxx - minx) / res)))
    h = max(1, int(np.ceil((maxy - miny) / res)))
    m = np.zeros((h, w), np.float32)
    ext = np.array([[(x - minx) / res, (y - miny) / res] for x, y in poly.exterior.coords], np.int32)
    cv2.fillPoly(m, [ext], 1)
    for ring in poly.interiors:
        ii = np.array([[(x - minx) / res, (y - miny) / res] for x, y in ring.coords], np.int32)
        cv2.fillPoly(m, [ii], 0)
    return m


def _place_pos(occ, mask):
    """หา (row,col) ล่างซ้ายสุดที่วางได้ (ไม่ชน) ; None ถ้าไม่มีที่"""
    grows, gcols = occ.shape
    h, w = mask.shape
    if h > grows or w > gcols:
        return None
    conv = fftconvolve(occ, mask[::-1, ::-1], mode='valid')   # จำนวนพิกเซลที่ทับ
    free = conv < 0.5
    ys, xs = np.where(free)
    if len(ys) == 0:
        return None
    i = np.lexsort((xs, ys))[0]
    return int(ys[i]), int(xs[i])


def nest(parts, sheet_w, sheet_h, margin=10.0, gap=5.0,
         rotations=(0, 90, 180, 270), res=2.0):
    """parts = [(shapely_polygon_mm, qty), ...]
    คืน dict: sheets=[[placed_polys_mm...]], utilization(%), n_sheets, n_parts, unplaced"""
    grows = int((sheet_h - 2 * margin) / res)
    gcols = int((sheet_w - 2 * margin) / res)
    if grows < 2 or gcols < 2:
        return {'sheets': [], 'utilization': 0, 'n_sheets': 0, 'n_parts': 0, 'unplaced': 0}

    inst = []   # (orig_poly, buffered_poly)
    for poly, qty in parts:
        buf = poly.buffer(gap / 2.0, join_style=2)
        for _ in range(int(qty)):
            inst.append((poly, buf))
    inst.sort(key=lambda t: -t[1].area)   # ชิ้นใหญ่ก่อน

    sheets = [[]]
    occs = [np.zeros((grows, gcols), np.float32)]
    part_area = 0.0
    unplaced = 0

    for orig, buf in inst:
        part_area += orig.area
        best = None   # (sheet_idx, row, col, rot)
        for si in range(len(sheets)):
            for rdeg in rotations:
                bufr = _rot(buf, rdeg, origin='centroid')
                pos = _place_pos(occs[si], _raster(bufr, res))
                if pos and (best is None or pos[0] < best[1] or (pos[0] == best[1] and pos[1] < best[2])):
                    best = (si, pos[0], pos[1], rdeg)
            if best and best[0] == si:
                break   # วางบนแผ่นที่มีอยู่ได้แล้ว
        if best is None:
            # แผ่นใหม่
            sheets.append([])
            occs.append(np.zeros((grows, gcols), np.float32))
            si = len(sheets) - 1
            for rdeg in rotations:
                bufr = _rot(buf, rdeg, origin='centroid')
                pos = _place_pos(occs[si], _raster(bufr, res))
                if pos:
                    best = (si, pos[0], pos[1], rdeg)
                    break
        if best is None:
            unplaced += 1
            continue
        si, row, col, rdeg = best
        bufr = _rot(buf, rdeg, origin='centroid')
        m = _raster(bufr, res)
        h, w = m.shape
        occs[si][row:row + h, col:col + w] = np.maximum(occs[si][row:row + h, col:col + w], m)
        # แปลงชิ้นจริง (ไม่รวม gap) ไปตำแหน่งเดียวกัน
        origr = _rot(orig, rdeg, origin='centroid')
        bx0, by0 = bufr.bounds[0], bufr.bounds[1]
        dx = margin + col * res - bx0
        dy = margin + row * res - by0
        sheets[si].append(_tr(origr, xoff=dx, yoff=dy))

    n = len(sheets)
    util = round(part_area / (n * sheet_w * sheet_h) * 100, 1) if n else 0
    return {'sheets': sheets, 'utilization': util, 'n_sheets': n,
            'n_parts': len(inst), 'unplaced': unplaced}


def sheet_svg(polys, sheet_w, sheet_h, stroke='#0EA5A5'):
    """SVG หนึ่งแผ่น (viewBox = มม.) — Y ชี้ลงแบบภาพ"""
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.1f}mm" height="{sheet_h:.1f}mm" '
         f'viewBox="0 0 {sheet_w:.1f} {sheet_h:.1f}">',
         f'<rect x="0" y="0" width="{sheet_w:.1f}" height="{sheet_h:.1f}" fill="none" stroke="#94a3b8" stroke-width="1"/>',
         f'<g fill="none" stroke="{stroke}" stroke-width="1" stroke-linejoin="round">']
    for poly in polys:
        for ring in [poly.exterior] + list(poly.interiors):
            d = 'M ' + ' L '.join(f'{x:.2f},{y:.2f}' for x, y in ring.coords) + ' Z'
            s.append(f'  <path d="{d}"/>')
    s.append('</g></svg>')
    return '\n'.join(s)


def write_dxf(sheets, path, sheet_w, sheet_h, gap_between=50.0):
    """DXF หน่วยมม. — เรียงแผ่นต่อกันในแกน X (Y ชี้ขึ้นแบบ CAD)"""
    doc = ezdxf.new('R2010')
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for si, polys in enumerate(sheets):
        ox = si * (sheet_w + gap_between)
        ly = 'SHEET_%d' % (si + 1)
        if ly not in doc.layers:
            doc.layers.add(ly)
        msp.add_lwpolyline([(ox, 0), (ox + sheet_w, 0), (ox + sheet_w, sheet_h), (ox, sheet_h)],
                           close=True, dxfattribs={'layer': ly, 'color': 8})
        for poly in polys:
            for ring in [poly.exterior] + list(poly.interiors):
                pts = [(ox + x, sheet_h - y) for x, y in ring.coords]   # flip Y เป็น CAD
                msp.add_lwpolyline(pts, close=True, dxfattribs={'layer': ly})
    doc.saveas(path)
    return path
