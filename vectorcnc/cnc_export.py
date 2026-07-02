"""CNC post-processing + export (พร้อมตัด + พร้อม Fusion)
- สเกลจริงเป็นมม.  - kerf offset ชดเชยดอกกัด  - ปัดมุม (fillet ~รัศมีดอก)
- ตัด feature เล็กเกินดอก  - ลด node  - tabs สะพานกันชิ้นหล่น
- export DXF (LWPOLYLINE ปิดลูป, หน่วยมม.) + SVG (มม.จริง)
ใช้ Shapely + ezdxf
"""
import numpy as np
from shapely.geometry import Polygon, Point, LineString
from shapely.ops import unary_union
import ezdxf


def _shape_to_poly(kind, d):
    if kind == 'circle':
        x, y, r = d
        return Point(float(x), float(y)).buffer(float(r), quad_segs=64)
    pts = [(float(x), float(y)) for x, y in d]
    if len(pts) < 3:
        return None
    p = Polygon(pts)
    if not p.is_valid:
        p = p.buffer(0)
    return p if (p is not None and not p.is_empty and p.area > 0) else None


def _iter_polys(geom):
    if geom is None or geom.is_empty:
        return
    t = geom.geom_type
    if t == 'Polygon':
        yield geom
    elif t == 'MultiPolygon':
        for g in geom.geoms:
            if g.area > 0:
                yield g


def process_layer(shapes, ppm, kerf_mm=3.0, tool_mm=6.0, min_mm=2.0,
                  simplify_mm=0.3, round_corners=True, tabs=0, tab_mm=6.0):
    """คืน list ของ ring: (coords[px], closed_bool) พร้อมผ่าน CNC post"""
    kerf_px = kerf_mm * ppm / 2.0
    tool_r = tool_mm * ppm / 2.0
    min_px = min_mm * ppm
    simp_px = max(0.1, simplify_mm * ppm)
    tab_px = tab_mm * ppm

    polys = []
    for kind, d in shapes:
        p = _shape_to_poly(kind, d)
        if p:
            polys.append(p)
    if not polys:
        return []
    merged = unary_union(polys)

    out = []
    for poly in _iter_polys(merged):
        if poly.area < (min_px * min_px):
            continue
        g = poly
        if round_corners and tool_r > 0.5:
            g = g.buffer(-tool_r, join_style=1).buffer(tool_r, join_style=1)   # opening: ปัดมุมนอก + ลบก้อยเล็ก
            g = g.buffer(tool_r, join_style=1).buffer(-tool_r, join_style=1)   # closing: ปัดมุมใน
        if kerf_px > 0:
            g = g.buffer(kerf_px, join_style=1)                                # ชดเชยดอกกัดออกนอกครึ่งดอก
        for gg in _iter_polys(g):
            gg = gg.simplify(simp_px, preserve_topology=True)
            rings = [gg.exterior] + list(gg.interiors)
            for ring in rings:
                coords = [(float(x), float(y)) for x, y in ring.coords]
                if len(coords) < 4:
                    continue
                if tabs and tab_px > 0:
                    for seg in _apply_tabs(coords, tabs, tab_px):
                        out.append((seg, False))
                else:
                    out.append((coords, True))
    return out


def process_geom(geom, ppm, kerf_mm=3.0, tool_mm=6.0, min_mm=2.0,
                 simplify_mm=0.3, round_corners=True, tabs=0, tab_mm=6.0):
    """รับ shapely geom (มีรูได้) -> ring ผ่าน CNC post เหมือน process_layer
    ใช้กับผลจาก VTracer (โหมด cutout)"""
    if geom is None or geom.is_empty:
        return []
    if not geom.is_valid:
        geom = geom.buffer(0)
    kerf_px = kerf_mm * ppm / 2.0
    tool_r = tool_mm * ppm / 2.0
    min_px = min_mm * ppm
    simp_px = max(0.1, simplify_mm * ppm)
    tab_px = tab_mm * ppm

    out = []
    for poly in _iter_polys(geom):
        if poly.area < (min_px * min_px):
            continue
        g = poly
        if round_corners and tool_r > 0.5:
            g = g.buffer(-tool_r, join_style=1).buffer(tool_r, join_style=1)
            g = g.buffer(tool_r, join_style=1).buffer(-tool_r, join_style=1)
        if kerf_px > 0:
            g = g.buffer(kerf_px, join_style=1)
        for gg in _iter_polys(g):
            gg = gg.simplify(simp_px, preserve_topology=True)
            for ring in [gg.exterior] + list(gg.interiors):
                coords = [(float(x), float(y)) for x, y in ring.coords]
                if len(coords) < 4:
                    continue
                if tabs and tab_px > 0:
                    for seg in _apply_tabs(coords, tabs, tab_px):
                        out.append((seg, False))
                else:
                    out.append((coords, True))
    return out


def _apply_tabs(coords, count, tab_px):
    line = LineString(coords)
    total = line.length
    if count < 1 or total <= tab_px * count * 2.5:
        return [coords]
    step = total / count
    tabspans = [(i * step, i * step + tab_px) for i in range(count)]
    N = max(240, len(coords) * 3)
    segs, cur = [], []
    for k in range(N + 1):
        dist = total * k / N
        pt = line.interpolate(dist)
        in_tab = any(a <= dist <= b for a, b in tabspans)
        if in_tab:
            if len(cur) >= 2:
                segs.append(cur)
            cur = []
        else:
            cur.append((pt.x, pt.y))
    if len(cur) >= 2:
        segs.append(cur)
    return segs if segs else [coords]


def svg_string(layers, W, H, ppm=None, mm=False):
    """layers = [(name, color_hex, rings)] · rings = [(coords, closed)]"""
    dim = ''
    if mm and ppm:
        dim = f'width="{W/ppm:.2f}mm" height="{H/ppm:.2f}mm" '
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" {dim}viewBox="0 0 {W} {H}">']
    for name, col, rings in layers:
        stroke = col if (isinstance(col, str) and col.startswith('#')) else '#0EA5A5'
        s.append(f'<g fill="none" stroke="{stroke}" stroke-width="0.7" '
                 f'stroke-linejoin="round" stroke-linecap="round">')
        for coords, closed in rings:
            d = 'M ' + ' L '.join(f'{x:.2f},{y:.2f}' for x, y in coords) + (' Z' if closed else '')
            s.append(f'  <path d="{d}"/>')
        s.append('</g>')
    s.append('</svg>')
    return '\n'.join(s)


def write_dxf(layers, path, ppm, H):
    """DXF หน่วยมม. · flip Y ให้เป็นระบบพิกัด CAD (y ขึ้น) · ปิดลูปด้วย LWPOLYLINE"""
    doc = ezdxf.new('R2010')
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for name, col, rings in layers:
        ly = 'CUT_' + str(name)
        if ly not in doc.layers:
            doc.layers.add(ly)
        for coords, closed in rings:
            mmpts = [(x / ppm, (H - y) / ppm) for x, y in coords]
            msp.add_lwpolyline(mmpts, close=closed, dxfattribs={'layer': ly})
    doc.saveas(path)
    return path
