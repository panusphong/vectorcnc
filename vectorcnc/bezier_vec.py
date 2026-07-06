"""bezier_vec.py — vectorize ภาพ raster (JPG/PNG) เป็น "เส้นโค้ง Bézier แท้" เหมือน .ai
ใช้ potrace (trace_color_bezier) -> subpaths cubic Bézier -> SVG (C) + DXF (SPLINE)
คุณภาพเส้น = ระดับ Illustrator (โค้งคณิตศาสตร์ ไม่ใช่ polygon แซมป์)
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
                for pt in s[1:]:
                    xs.append(pt[0]); ys.append(pt[1])
    return min(xs), min(ys), max(xs), max(ys)


def _svg(all_subs, W, H, stroke='#2563eb', unit=''):
    body = ''.join(f'<path d="{_d(sp)}"/>' for sp in all_subs if sp['segs'])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.2f}{unit}" height="{H:.2f}{unit}" '
            f'viewBox="0 0 {W:.2f} {H:.2f}">'
            f'<g fill="none" stroke="{stroke}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round">'
            f'{body}</g></svg>')


def _dxf(all_subs_mm, Hmm, path):
    """DXF มม. — โค้ง = SPLINE (Bézier แท้), ตรง = LINE · flip Y (CAD)"""
    doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    if 'CUT' not in doc.layers:
        doc.layers.add('CUT')
    def tf(p): return (p[0], Hmm - p[1])
    for sp in all_subs_mm:
        cur = sp['start']
        for s in sp['segs']:
            if s[0] == 'L':
                msp.add_line(tf(cur), tf(s[1]), dxfattribs={'layer': 'CUT'}); cur = s[1]
            else:
                msp.add_open_spline([tf(cur), tf(s[1]), tf(s[2]), tf(s[3])],
                                    degree=3, dxfattribs={'layer': 'CUT'}); cur = s[3]
    doc.saveas(path)
    return path


def vectorize_bezier(image_path, real_width_mm=1200.0, n_colors=6, dxf_out=None):
    """คืน dict: svg_px, svg_mm, dxf_path, width_mm, height_mm, layers, rings
    เส้นโค้ง Bézier แท้ (เหมือน .ai) — ขนาดจริงจาก ppm เป๊ะ"""
    items = te.trace_color_smooth_bezier(image_path, n_colors=max(2, min(12, int(n_colors))))
    if not items:
        raise ValueError('ไม่พบรูปทรงสำหรับแปลงเป็นเส้นตัด')
    mnx, mny, mxx, mxy = _bbox(items)
    Wpx = max(1.0, mxx - mnx); Hpx = max(1.0, mxy - mny)
    ppm = Wpx / float(real_width_mm) if real_width_mm else 1.0    # px ต่อ มม.
    Wmm = Wpx / ppm; Hmm = Hpx / ppm

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
        'layers': len(items), 'rings': nrings, 'engine': 'bezier (potrace)',
    }
