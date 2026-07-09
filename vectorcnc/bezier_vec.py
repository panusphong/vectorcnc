"""bezier_vec.py — vectorize ภาพ raster (JPG/PNG) เป็น "เส้นโค้ง Bézier แท้" เหมือน .ai
ใช้ vtracer (trace_vtracer) -> subpaths line+spline -> SVG (C/L) + DXF (SPLINE/LINE)
ปรับขนาดจริงได้ 3 แบบ: กว้างป้าย / สูงป้าย / สูงตัวอักษร (สเกลทั้งชิ้น ไม่บิดสัดส่วน)
"""
import math
import ezdxf
from . import trace_engine as te


def _shift(sp, ox, oy, sc=1.0):
    """เลื่อน+สเกล subpath (คูณ sc, ลบ ox,oy)"""
    def T(p): return ((p[0] - ox) * sc, (p[1] - oy) * sc)
    out = {'start': T(sp['start']), 'closed': sp.get('closed', True), 'segs': []}
    for s in sp['segs']:
        if s[0] == 'L':
            out['segs'].append(('L', T(s[1])))
        else:
            out['segs'].append(('C', T(s[1]), T(s[2]), T(s[3])))
    return out


def _d(sp):
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


def _bbox(items):
    xs = []; ys = []
    for _, subs in items:
        for sp in subs:
            xs.append(sp['start'][0]); ys.append(sp['start'][1])
            for s in sp['segs']:
                pt = s[-1]            # จุดปลายบนเส้นจริง (ไม่รวม control point ที่พุ่งเกิน)
                xs.append(pt[0]); ys.append(pt[1])
    return min(xs), min(ys), max(xs), max(ys)


def _subpath_height(sp):
    """ความสูง (px) ของ subpath เดียว จากจุดปลายจริง"""
    ys = [sp['start'][1]]
    for s in sp['segs']:
        ys.append(s[-1][1])
    return max(ys) - min(ys)


def _svg(all_subs, W, H, stroke='#2563eb', unit=''):
    body = ''.join(f'<path d="{_d(sp)}"/>' for sp in all_subs if sp['segs'])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.2f}{unit}" height="{H:.2f}{unit}" '
            f'viewBox="0 0 {W:.2f} {H:.2f}">'
            f'<g fill="none" stroke="{stroke}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round">'
            f'{body}</g></svg>')


def _add_contour(layout, sp, tf, layer):
    """เขียน 1 คอนทัวร์เป็น 'สไปลน์ปิด degree-3 เส้นเดียว' (มาตรฐานไฟล์ตัดโรงงาน / laser fiber)
    - คอนทัวร์ตรงล้วน -> LWPOLYLINE ปิด
    - มีโค้ง -> รวมทุก segment เป็น B-spline ปิดเส้นเดียว (เส้นตรงแปลงเป็น cubic คุมจุดบนคอร์ด = ตรงเป๊ะ)
    tf = ฟังก์ชันแปลงพิกัด (เช่น flip Y)"""
    import ezdxf.path as _ep
    from ezdxf.math import BSpline as _BSpline
    segs = sp.get('segs') or []
    if not segs:
        return
    start = sp['start']
    has_curve = any(s[0] == 'C' for s in segs)
    if not has_curve:
        pts = [tf(start)] + [tf(s[1]) for s in segs]
        layout.add_lwpolyline(pts, close=True, dxfattribs={'layer': layer})
        return
    p = _ep.Path(tf(start)); cur = start
    for s in segs:
        if s[0] == 'L':
            e = s[1]
            c1 = (cur[0] + (e[0] - cur[0]) / 3.0, cur[1] + (e[1] - cur[1]) / 3.0)
            c2 = (cur[0] + 2.0 * (e[0] - cur[0]) / 3.0, cur[1] + 2.0 * (e[1] - cur[1]) / 3.0)
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
                spl.closed = True                    # คอนทัวร์เนียนไม่มีมุม = สไปลน์ปิดเส้นเดียว (แบบโรงงาน)
        else:
            vs = [(v[0], v[1]) for v in item]
            if len(vs) >= 2:
                layout.add_lwpolyline(vs, close=single, dxfattribs={'layer': layer})


def _dxf(all_subs_mm, Hmm, path):
    """DXF มม. — 1 คอนทัวร์ = 1 SPLINE ปิด (Bézier แท้ต่อเนื่อง) แบบไฟล์โรงงาน · flip Y (CAD)"""
    doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    if 'CUT' not in doc.layers:
        doc.layers.add('CUT')
    def tf(p): return (p[0], Hmm - p[1])
    for sp in all_subs_mm:
        try:
            _add_contour(msp, sp, tf, 'CUT')
        except Exception:
            cur = sp['start']                       # สำรอง: เขียนทีละ segment
            for s in sp['segs']:
                if s[0] == 'L':
                    msp.add_line(tf(cur), tf(s[1]), dxfattribs={'layer': 'CUT'}); cur = s[1]
                else:
                    msp.add_open_spline([tf(cur), tf(s[1]), tf(s[2]), tf(s[3])],
                                        degree=3, dxfattribs={'layer': 'CUT'}); cur = s[3]
    doc.saveas(path)
    return path


def vectorize_bezier(image_path, real_width_mm=1200.0, n_colors=6, dxf_out=None,
                     size_by='width', size_value_mm=None):
    """คืน dict: svg_px, svg_mm, dxf_path, width_mm, height_mm, letter_height_mm, ...
    ปรับขนาดจริงได้ 3 โหมด (สเกลทั้งชิ้น ไม่บิดสัดส่วน):
      size_by='width'  -> กว้างป้าย = size_value_mm (หรือ real_width_mm)
      size_by='height' -> สูงป้าย  = size_value_mm
      size_by='letter' -> สูงตัวอักษรที่สูงสุด = size_value_mm
    """
    engine_name = 'potrace HQ (illustrator-grade)'
    try:
        items = te.trace_potrace(image_path, n_colors=max(2, min(12, int(n_colors))))   # เครื่องยนต์ potrace เนียนสุด
    except Exception:
        items = te.trace_vtracer(image_path, n_colors=max(2, min(12, int(n_colors))))   # สำรอง
        engine_name = 'vtracer line+spline v3 (ss+straight)'
    if not items:
        raise ValueError('ไม่พบรูปทรงสำหรับแปลงเป็นเส้นตัด')
    mnx, mny, mxx, mxy = _bbox(items)
    Wpx = max(1.0, mxx - mnx); Hpx = max(1.0, mxy - mny)
    letter_px = 1.0
    for _, subs in items:
        for sp in subs:
            letter_px = max(letter_px, _subpath_height(sp))

    mode = (size_by or 'width').lower()
    try:
        val = float(size_value_mm) if size_value_mm not in (None, '', 0) else 0.0
    except Exception:
        val = 0.0
    if val <= 0:                                   # ไม่ได้ระบุค่า -> ใช้ความกว้างจาก real_width_mm
        mode = 'width'; val = float(real_width_mm) if real_width_mm else 1200.0
    if mode == 'height':
        ppm = Hpx / val
    elif mode == 'letter':
        ppm = letter_px / val
    else:
        mode = 'width'; ppm = Wpx / val
    if ppm <= 0:
        ppm = 1.0
    Wmm = Wpx / ppm; Hmm = Hpx / ppm; letter_mm = letter_px / ppm    # px ต่อ มม.

    subs_px = []; subs_mm = []; nrings = 0
    for _, subs in items:
        for sp in subs:
            subs_px.append(_shift(sp, mnx, mny, 1.0))
            subs_mm.append(_shift(sp, mnx, mny, 1.0 / ppm))
            nrings += 1

    svg_px = _svg(subs_px, Wpx, Hpx)
    svg_mm = _svg(subs_mm, Wmm, Hmm, unit='mm')
    if dxf_out:
        _dxf(subs_mm, Hmm, dxf_out)
    return {
        'svg_px': svg_px, 'svg_mm': svg_mm, 'dxf_path': dxf_out,
        'width_mm': round(Wmm, 1), 'height_mm': round(Hmm, 1),
        'letter_height_mm': round(letter_mm, 1), 'size_by': mode,
        'layers': len(items), 'rings': nrings, 'engine': engine_name,
    }
