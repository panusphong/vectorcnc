"""batch.py — แตกไฟล์แต่ละแบบเป็นชิ้น (shapely polygon มม.) สำหรับ Nesting รวมงาน
- SVG  -> parse path ตรง (คมเป๊ะ) สเกลตาม real_width_mm
- DXF  -> อ่าน entity ตรง (มม.จริง)
- รูป  -> trace_engine (prep + trace_color)
"""
import re
import numpy as np
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
from shapely.affinity import scale as _scale


def _poly(pts):
    if len(pts) < 3:
        return None
    p = Polygon(pts)
    if not p.is_valid:
        p = p.buffer(0)
    return p if (p is not None and not p.is_empty and p.area > 0) else None


def _explode(geom, min_area=1.0):
    if geom is None or geom.is_empty:
        return []
    t = geom.geom_type
    if t == 'Polygon':
        return [geom] if geom.area > min_area else []
    if t in ('MultiPolygon', 'GeometryCollection'):
        out = []
        for g in geom.geoms:
            if g.geom_type == 'Polygon' and g.area > min_area:
                out.append(g)
        return out
    return []


def _evenodd(polys):
    """รวม polygon แบบ even-odd (เจาะรูถูก)"""
    if not polys:
        return None
    geom = polys[0]
    for q in polys[1:]:
        try:
            geom = geom.symmetric_difference(q)
        except Exception:
            geom = unary_union([geom, q])
    return geom


def parts_from_svg(path, real_width_mm):
    from svgpathtools import svg2paths2
    paths, attrs, svg_attr = svg2paths2(path)
    vb = svg_attr.get('viewBox') or svg_attr.get('viewbox') or ''
    if vb:
        v = [float(x) for x in re.split(r'[ ,]+', vb.strip()) if x]
        svgw = v[2] if len(v) >= 4 else 1.0
    else:
        w = str(svg_attr.get('width', '') or '')
        svgw = float(re.sub(r'[^\d.]', '', w) or 1.0)
    if svgw <= 0:
        svgw = 1.0
    sc = float(real_width_mm) / svgw
    polys = []
    for p in paths:
        try:
            subs = p.continuous_subpaths()
        except Exception:
            subs = [p]
        for sub in subs:
            try:
                L = sub.length()
            except Exception:
                continue
            if L < 1e-6:
                continue
            N = int(max(12, min(1500, L / 2.0)))
            pts = []
            for i in range(N + 1):
                z = sub.point(i / N)
                pts.append((z.real, z.imag))
            poly = _poly(pts)
            if poly:
                polys.append(poly)
    geom = _evenodd(polys)
    if geom is None:
        return []
    geom = _scale(geom, sc, sc, origin=(0, 0))
    return _explode(geom)


def parts_from_dxf(path, real_width_mm=None):
    import ezdxf
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    polys = []
    for e in msp:
        t = e.dxftype()
        try:
            if t == 'LWPOLYLINE':
                pts = [(pt[0], pt[1]) for pt in e.get_points('xy')]
                poly = _poly(pts)
                if poly:
                    polys.append(poly)
            elif t == 'POLYLINE':
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                poly = _poly(pts)
                if poly:
                    polys.append(poly)
            elif t == 'CIRCLE':
                c = e.dxf.center
                polys.append(Point(c.x, c.y).buffer(float(e.dxf.radius), quad_segs=48))
        except Exception:
            continue
    geom = _evenodd(polys)
    if geom is None:
        return []
    if real_width_mm:
        minx, miny, maxx, maxy = geom.bounds
        w = maxx - minx
        if w > 0 and abs(w - real_width_mm) / real_width_mm > 0.02:
            s = float(real_width_mm) / w
            geom = _scale(geom, s, s, origin=(0, 0))
    return _explode(geom)


def parts_from_image(path, real_width_mm, n_colors=6):
    import cv2
    from . import trace_engine
    work = trace_engine.prep_image(path)
    img = cv2.imread(work)
    if img is None:
        return []
    H, W = img.shape[:2]
    ppm = W / float(real_width_mm) if real_width_mm else 1.0
    traced = trace_engine.trace_color(work, n_colors=n_colors, filter_speckle=8)
    geoms = [_scale(g, 1.0 / ppm, 1.0 / ppm, origin=(0, 0)) for _, g in traced]
    if not geoms:
        return []
    return _explode(unary_union(geoms))


def build_parts(path, filename, real_width_mm):
    """คืน list ของ shapely Polygon (มม.) จากไฟล์ใดๆ"""
    ext = (filename or path or '').lower()
    if ext.endswith('.svg'):
        return parts_from_svg(path, real_width_mm)
    if ext.endswith('.dxf'):
        return parts_from_dxf(path, real_width_mm)
    return parts_from_image(path, real_width_mm)
