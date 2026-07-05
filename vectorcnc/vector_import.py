"""นำเข้าไฟล์เวกเตอร์ (.ai/.pdf/.eps/.ps/.svg) -> ไฟล์ตัดคุณภาพ Illustrator

หัวใจ: ดึง "เส้นโค้ง Bézier จริง" จากไฟล์ (control points) แล้ว output เป็น
  - SVG: คำสั่ง C/L/Z (เส้นโค้งจริง) -> เนียน infinite ทุกซูม เหมือนดีไซเนอร์วาด
  - DXF: LWPOLYLINE ละเอียด (chord ~0.08 มม.) -> เนียนระดับเครื่องตัด เข้า CAM ได้ทุกตัว
ไม่ sample เป็น polyline หยาบ, ไม่ดัดรูป (faithful 100% -> ไม่มีทางเพี้ยน)

+ แยกตาม "เลเยอร์ (OCG)" ของ .ai/.pdf, auto-ตัดเลเยอร์ขยะ, แยกชิ้นวางเรียง, สีต่อเลเยอร์
ถ้าไฟล์แทบไม่มี path (ข้อความสด/ภาพฝัง) -> fallback: เรนเดอร์ + potrace
"""
import os
import tempfile
import subprocess
import numpy as np

VECTOR_EXT = ('.svg', '.ai', '.pdf', '.eps', '.ps')
RENDER_LONGEST_PX = 3200
_PALETTE = ['#111111', '#2563EB', '#DC2626', '#059669', '#D97706',
            '#7C3AED', '#0891B2', '#DB2777', '#65A30D', '#4B5563']
_PALETTE_RGB = [(17, 17, 17), (37, 99, 235), (220, 38, 38), (5, 150, 105), (217, 119, 6),
                (124, 58, 237), (8, 145, 178), (219, 39, 119), (101, 163, 13), (75, 85, 99)]


def is_vector_file(path):
    return os.path.splitext(str(path))[1].lower() in VECTOR_EXT


# ---------- subpath = {'start':(x,y), 'segs':[('L',pt) | ('C',c1,c2,e)], 'closed':bool} ----------
def _sp_last(sp):
    if sp['segs']:
        s = sp['segs'][-1]
        return s[1] if s[0] == 'L' else s[3]
    return sp['start']


def _sp_points(sp):
    """จุดทั้งหมด (start+control+end) — สำหรับ bbox / translate"""
    pts = [sp['start']]
    for s in sp['segs']:
        if s[0] == 'L':
            pts.append(s[1])
        else:
            pts.extend([s[1], s[2], s[3]])
    return pts


def _sp_translate(sp, dx, dy):
    def t(p):
        return (p[0] + dx, p[1] + dy)
    ns = []
    for s in sp['segs']:
        ns.append(('L', t(s[1])) if s[0] == 'L' else ('C', t(s[1]), t(s[2]), t(s[3])))
    return {'start': t(sp['start']), 'segs': ns, 'closed': sp.get('closed', False)}


def _sp_svg_d(sp):
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


def _cubic(a, c1, c2, e, t):
    mt = 1 - t
    return (mt**3 * a[0] + 3*mt*mt*t * c1[0] + 3*mt*t*t * c2[0] + t**3 * e[0],
            mt**3 * a[1] + 3*mt*mt*t * c1[1] + 3*mt*t*t * c2[1] + t**3 * e[1])


def _sp_flatten(sp, step):
    """แตกเป็นจุดถี่ (chord ~step pt) สำหรับ DXF LWPOLYLINE"""
    out = [sp['start']]
    cur = sp['start']
    for s in sp['segs']:
        if s[0] == 'L':
            out.append(s[1]); cur = s[1]
        else:
            c1, c2, e = s[1], s[2], s[3]
            L = (abs(c1[0]-cur[0]) + abs(c1[1]-cur[1]) + abs(c2[0]-c1[0]) +
                 abs(c2[1]-c1[1]) + abs(e[0]-c2[0]) + abs(e[1]-c2[1]))
            N = int(min(400, max(2, L / max(0.3, step))))
            for i in range(1, N + 1):
                out.append(_cubic(cur, c1, c2, e, i / float(N)))
            cur = e
    return out


def _extract_subpaths_pdf(path, filetype=None):
    import fitz
    doc = fitz.open(path, filetype=filetype) if filetype else fitz.open(path)
    try:
        page = doc[0]
        R = page.rect
        W, H = float(R.width), float(R.height)
        layers = {}
        for dr in page.get_drawings():
            ly = dr.get('layer') or '(default)'
            bucket = layers.setdefault(ly, [])
            cur = None; sp = None

            def flush():
                if sp and sp['segs']:
                    lp = _sp_last(sp)
                    sp['closed'] = abs(lp[0] - sp['start'][0]) < 1.0 and abs(lp[1] - sp['start'][1]) < 1.0
                    bucket.append(sp)

            for it in dr.get('items', []):
                op = it[0]
                if op in ('l', 'c'):
                    a = (it[1].x, it[1].y)
                    if cur is None or abs(a[0]-cur[0]) > 0.05 or abs(a[1]-cur[1]) > 0.05:
                        flush(); sp = {'start': a, 'segs': [], 'closed': False}
                    if op == 'l':
                        e = (it[2].x, it[2].y); sp['segs'].append(('L', e)); cur = e
                    else:
                        c1 = (it[2].x, it[2].y); c2 = (it[3].x, it[3].y); e = (it[4].x, it[4].y)
                        sp['segs'].append(('C', c1, c2, e)); cur = e
                elif op == 're':
                    flush(); sp = None; cur = None
                    r = it[1]
                    bucket.append({'start': (r.x0, r.y0), 'closed': True, 'segs': [
                        ('L', (r.x1, r.y0)), ('L', (r.x1, r.y1)), ('L', (r.x0, r.y1)), ('L', (r.x0, r.y0))]})
                elif op == 'qu':
                    flush(); sp = None; cur = None
                    q = it[1]
                    bucket.append({'start': (q.ul.x, q.ul.y), 'closed': True, 'segs': [
                        ('L', (q.ur.x, q.ur.y)), ('L', (q.lr.x, q.lr.y)), ('L', (q.ll.x, q.ll.y)), ('L', (q.ul.x, q.ul.y))]})
            flush()
        return layers, W, H
    finally:
        doc.close()


def _extract_subpaths_svg(path):
    from svgpathtools import svg2paths2
    paths, attrs, svg_attr = svg2paths2(path)
    xmin = ymin = 1e18; xmax = ymax = -1e18
    subs = []
    for p in paths:
        for sub in p.continuous_subpaths():
            if sub.length() < 0.5:
                continue
            st = (sub[0].start.real, sub[0].start.imag)
            segs = []
            for seg in sub:
                nm = type(seg).__name__
                if nm == 'Line':
                    segs.append(('L', (seg.end.real, seg.end.imag)))
                elif nm == 'CubicBezier':
                    segs.append(('C', (seg.control1.real, seg.control1.imag),
                                 (seg.control2.real, seg.control2.imag), (seg.end.real, seg.end.imag)))
                elif nm == 'QuadraticBezier':
                    c1 = (st[0] + 2/3*(seg.control.real-st[0]), st[1] + 2/3*(seg.control.imag-st[1]))
                    c2 = (seg.end.real + 2/3*(seg.control.real-seg.end.real),
                          seg.end.imag + 2/3*(seg.control.imag-seg.end.imag))
                    segs.append(('C', c1, c2, (seg.end.real, seg.end.imag)))
                else:  # Arc -> sample
                    N = max(6, int(seg.length() / 2))
                    for i in range(1, N + 1):
                        z = seg.point(i / float(N)); segs.append(('L', (z.real, z.imag)))
                st = _sp_last({'start': st, 'segs': segs})
            sp = {'start': (sub[0].start.real, sub[0].start.imag), 'segs': segs,
                  'closed': bool(sub.isclosed())}
            subs.append(sp)
            for pt in _sp_points(sp):
                xmin = min(xmin, pt[0]); xmax = max(xmax, pt[0]); ymin = min(ymin, pt[1]); ymax = max(ymax, pt[1])
    vb = svg_attr.get('viewBox') or svg_attr.get('viewbox')
    if vb:
        v = [float(x) for x in vb.replace(',', ' ').split()]; W, H = v[2], v[3]
    else:
        W = xmax - xmin if xmax > xmin else 100.0
        H = ymax - ymin if ymax > ymin else 100.0
    return {'(default)': subs}, W, H


def _to_pdf_via_gs(path):
    out = tempfile.mktemp(suffix='.pdf')
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-o', out, path],
                   check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def _npts(layers):
    return sum(len(_sp_points(sp)) for subs in layers.values() for sp in subs)


def _extent(subs):
    xs = []; ys = []
    for sp in subs:
        for p in _sp_points(sp):
            xs.append(p[0]); ys.append(p[1])
    return (min(xs), min(ys), max(xs), max(ys))


def _auto_keep(layers, W, H):
    names = [ly for ly, s in layers.items() if s]
    if len(names) <= 1:
        return set(names)
    counts = {ly: len(layers[ly]) for ly in names}
    med = sorted(counts.values())[len(counts) // 2]
    keep = set()
    for ly in names:
        junk = counts[ly] > max(20, 6 * med)
        if not junk:
            for sp in layers[ly]:
                pts = _sp_points(sp)
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                if (max(xs)-min(xs)) > 0.5*W and (max(ys)-min(ys)) > 0.5*H and len(sp['segs']) <= 8:
                    junk = True; break
        low = str(ly).lower()
        if any(k in low for k in ('dim', 'annot', 'note', 'guide', 'spec', 'ใบงาน', 'text')):
            junk = True
        if not junk:
            keep.add(ly)
    return keep or set(names)


def _sp_scale(sp, s):
    """สเกลทุกจุด (start+control+end) ด้วยตัวคูณ s — คงชนิดเซ็กเมนต์ (L/C)"""
    def t(p):
        return (p[0] * s, p[1] * s)
    ns = []
    for x in sp['segs']:
        ns.append(('L', t(x[1])) if x[0] == 'L' else ('C', t(x[1]), t(x[2]), t(x[3])))
    return {'start': t(sp['start']), 'segs': ns, 'closed': sp.get('closed', False)}


def _load_layers(path):
    """คืน (layers, W, H) จากไฟล์เวกเตอร์ทุกชนิด (แชร์กับ nesting/cut)"""
    ext = os.path.splitext(str(path))[1].lower()
    try:
        if ext == '.svg':
            return _extract_subpaths_svg(path)
        if ext in ('.pdf', '.ai'):
            return _extract_subpaths_pdf(path, filetype='pdf')
        if ext in ('.eps', '.ps'):
            pdf = _to_pdf_via_gs(path)
            try:
                return _extract_subpaths_pdf(pdf, filetype='pdf')
            finally:
                try: os.remove(pdf)
                except Exception: pass
    except Exception:
        return None, 0.0, 0.0
    return None, 0.0, 0.0


def full_pieces_mm(path, real_width_mm=300.0):
    """แยกทุกชิ้น (closed subpath) เป็น dict {'poly': footprint(shapely,มม.), 'subs': [bezier subpath มม. Y-down]}
    — สำหรับ Nesting คุณภาพ Illustrator: footprint ละเอียดเพื่อแพคชิด + subs เส้นโค้งจริงเพื่อตัดคม
    """
    from shapely.geometry import Polygon
    layers, W, H = _load_layers(path)
    if not layers or W <= 0 or H <= 0:
        return []
    keep = _auto_keep(layers, W, H)
    if not keep:
        return []
    best = max(keep, key=lambda ly: len(layers[ly]))     # เลเยอร์ละเอียดสุด = คิ้ว/ลายจริง
    ppm = W / float(real_width_mm) if real_width_mm else 1.0
    inv = 1.0 / ppm
    pieces = []
    for sp in layers[best]:
        if not sp.get('closed'):
            continue
        sub_mm = _sp_scale(sp, inv)                       # เส้นโค้งจริง หน่วยมม.
        pts = _sp_flatten(sp, max(0.18, 0.10 * ppm))      # footprint ละเอียด (chord ~0.1px)
        mm = [(x * inv, y * inv) for x, y in pts]
        if len(mm) < 3:
            continue
        try:
            poly = Polygon(mm).buffer(0)
        except Exception:
            continue
        if poly.is_empty or poly.area <= 1.0:
            continue
        if poly.geom_type == 'MultiPolygon':
            poly = max(poly.geoms, key=lambda g: g.area)  # footprint = ชิ้นใหญ่สุด
        pieces.append({'poly': poly, 'subs': [sub_mm]})
    return pieces


def full_geom_mm(path, real_width_mm=300.0):
    """ดึงรูปทรง (shapely, หน่วยมม.) จากไฟล์เวกเตอร์ — สำหรับ Nesting"""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    layers, W, H = _load_layers(path)
    if not layers or W <= 0 or H <= 0:
        return None
    keep = _auto_keep(layers, W, H)
    if not keep:
        return None
    # ใช้เลเยอร์ที่ "ละเอียดสุด" (subpaths มากสุด) เป็นชิ้นตัวแทน -> เก็บลายครบ ไม่ยุบเป็นวงรี
    best = max(keep, key=lambda ly: len(layers[ly]))
    ppm = W / float(real_width_mm) if real_width_mm else 1.0
    polys = []
    for sp in layers[best]:
        if not sp.get('closed'):
            continue
        pts = _sp_flatten(sp, max(0.5, 0.4 * ppm))
        mm = [(x / ppm, y / ppm) for x, y in pts]
        if len(mm) < 3:
            continue
        try:
            p = Polygon(mm).buffer(0)
            if not p.is_empty and p.area > 1.0:
                polys.append(p)
        except Exception:
            pass
    if not polys:
        return None
    if len(polys) == 1:
        return polys[0]
    from shapely.geometry import MultiPolygon
    try:
        return MultiPolygon(polys)          # เก็บทุกชิ้น (ไม่ union) -> render ลายครบ
    except Exception:
        return unary_union(polys)


def _emit_vector(kept, W, H, ppm, out_svg_mm, out_dxf):
    """kept = [(name, color_hex, color_rgb, [subpath])] -> SVG(bezier) + DXF(polyline ละเอียด)"""
    def svg(mm):
        dim = 'width="%.2fmm" height="%.2fmm" ' % (W / ppm, H / ppm) if mm else ''
        s = ['<svg xmlns="http://www.w3.org/2000/svg" %sviewBox="0 0 %.2f %.2f">' % (dim, W, H)]
        for name, col, rgb, subs in kept:
            s.append('<g fill="none" stroke="%s" stroke-width="0.7" stroke-linejoin="round" stroke-linecap="round">' % col)
            for sp in subs:
                s.append('<path d="%s"/>' % _sp_svg_d(sp))
            s.append('</g>')
        s.append('</svg>')
        return '\n'.join(s)
    svg_mm = svg(True); svg_px = svg(False)
    with open(out_svg_mm, 'w', encoding='utf-8') as f:
        f.write(svg_mm)
    if out_dxf:
        import ezdxf
        doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM
        msp = doc.modelspace()

        def tf(p):
            return (p[0] / ppm, (H - p[1]) / ppm)   # -> มม. + flip Y (ระบบ CAD)

        for name, col, rgb, subs in kept:
            lyname = 'CUT_' + str(name)
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                try: lay.rgb = rgb
                except Exception: pass
            for sp in subs:
                cur = sp['start']
                for s in sp['segs']:
                    if s[0] == 'L':
                        msp.add_line(tf(cur), tf(s[1]), dxfattribs={'layer': lyname})
                        cur = s[1]
                    else:
                        # Bézier -> SPLINE จริง (เนียนทุกซูมในโปรแกรม CAD)
                        msp.add_open_spline([tf(cur), tf(s[1]), tf(s[2]), tf(s[3])],
                                            degree=3, dxfattribs={'layer': lyname})
                        cur = s[3]
        doc.saveas(out_dxf)
    total = sum(len(subs) for n, c, r, subs in kept)
    return {
        'size_px': (int(round(W)), int(round(H))),
        'size_mm': (round(W / ppm, 1), round(H / ppm, 1)),
        'ppm': ppm, 'mode': 'vector', 'engine': 'vector',
        'detected': {'kind': 'vector', 'mode': 'vector', 'engine': 'vector',
                     'notes': 'เส้นโค้ง Bézier จริงจากไฟล์ (คุณภาพ Illustrator)'},
        'n_layers': len(kept), 'n_rings': total,
        'svg_mm': svg_mm, 'svg_px': svg_px,
        'layer_colors': [c for n, c, r, s in kept],
        'used_layers': [n for n, c, r, s in kept],
    }


def _emit_render(image_path, out_svg_mm, out_dxf, real_width_mm,
                 kerf_mm, tool_mm, min_mm, round_corners, tabs, filetype=None):
    import fitz
    from . import trace_engine, cnc_export
    doc = fitz.open(image_path, filetype=filetype) if filetype else fitz.open(image_path)
    try:
        page = doc[0]; R = page.rect; W, H = float(R.width), float(R.height)
        sc = RENDER_LONGEST_PX / max(W, H) if max(W, H) > 0 else 1.0
        pix = page.get_pixmap(matrix=fitz.Matrix(sc, sc), alpha=False)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        gray = img[..., :3].mean(2) if pix.n >= 3 else img[..., 0]
        ink = (gray < 250).astype(np.uint8) * 255
        min_area = max(4.0, pix.width * pix.height * 3e-6)
        geom = trace_engine._mask_to_geom_potrace(ink, min_area)
        W2, H2 = float(pix.width), float(pix.height)
    finally:
        doc.close()
    if geom is None or geom.is_empty:
        raise ValueError('ไม่พบเส้นเวกเตอร์ในไฟล์')
    ppm = W2 / float(real_width_mm) if real_width_mm else 1.0
    rings = cnc_export.process_geom(geom, ppm, kerf_mm=kerf_mm, tool_mm=tool_mm,
                                    min_mm=min_mm, round_corners=round_corners, tabs=tabs)
    svg_mm = cnc_export.svg_string([('L0', '#111111', rings)], W2, H2, ppm, mm=True)
    svg_px = cnc_export.svg_string([('L0', '#111111', rings)], W2, H2, ppm, mm=False)
    with open(out_svg_mm, 'w', encoding='utf-8') as f:
        f.write(svg_mm)
    if out_dxf:
        cnc_export.write_dxf([('L0', '#111111', rings)], out_dxf, ppm, H2)
    return {'size_px': (int(W2), int(H2)), 'size_mm': (round(W2/ppm, 1), round(H2/ppm, 1)),
            'ppm': ppm, 'mode': 'vector', 'engine': 'vector-render',
            'detected': {'kind': 'vector', 'mode': 'vector', 'engine': 'vector-render'},
            'n_layers': 1, 'n_rings': len(rings), 'svg_mm': svg_mm, 'svg_px': svg_px,
            'layer_colors': ['#111111']}


def process_vector(image_path, out_svg_mm, out_dxf=None, real_width_mm=1200.0,
                   kerf_mm=3.0, tool_mm=6.0, min_mm=2.0, round_corners=True, tabs=0):
    ext = os.path.splitext(str(image_path))[1].lower()
    layers = None; W = H = 0.0
    try:
        if ext == '.svg':
            layers, W, H = _extract_subpaths_svg(image_path)
        elif ext in ('.pdf', '.ai'):
            layers, W, H = _extract_subpaths_pdf(image_path, filetype='pdf')
        elif ext in ('.eps', '.ps'):
            pdf = _to_pdf_via_gs(image_path)
            try:
                layers, W, H = _extract_subpaths_pdf(pdf, filetype='pdf')
            finally:
                try: os.remove(pdf)
                except Exception: pass
    except Exception:
        layers = None

    if layers and _npts(layers) >= 40 and W > 0 and H > 0:
        keep = _auto_keep(layers, W, H)
        kept_layers = [(ly, layers[ly]) for ly in sorted(keep) if layers[ly]]
        if kept_layers:
            boxes = [_extent(subs) for n, subs in kept_layers]
            maxw = max((b[2] - b[0]) for b in boxes) or 1.0
            gap = 0.06 * maxw
            xoff = 0.0; maxh = 0.0
            out = []
            for idx, (name, subs) in enumerate(kept_layers):
                mnx, mny, mxx, mxy = boxes[idx]
                dx = xoff - mnx; dy = -mny
                tsubs = [_sp_translate(sp, dx, dy) for sp in subs]
                out.append((name, _PALETTE[idx % len(_PALETTE)], _PALETTE_RGB[idx % len(_PALETTE_RGB)], tsubs))
                xoff += (mxx - mnx) + gap
                maxh = max(maxh, mxy - mny)
            NW = xoff - gap if len(kept_layers) > 1 else (boxes[0][2] - boxes[0][0])
            NH = maxh if maxh > 0 else H
            ppm = maxw / float(real_width_mm) if real_width_mm else 1.0
            return _emit_vector(out, NW, NH, ppm, out_svg_mm, out_dxf)

    # fallback: ข้อความสด/ภาพฝัง
    if ext in ('.pdf', '.ai', '.svg'):
        return _emit_render(image_path, out_svg_mm, out_dxf, real_width_mm,
                            kerf_mm, tool_mm, min_mm, round_corners, tabs,
                            filetype='pdf' if ext != '.svg' else None)
    if ext in ('.eps', '.ps'):
        pdf = _to_pdf_via_gs(image_path)
        try:
            return _emit_render(pdf, out_svg_mm, out_dxf, real_width_mm,
                                kerf_mm, tool_mm, min_mm, round_corners, tabs, filetype='pdf')
        finally:
            try: os.remove(pdf)
            except Exception: pass
    raise ValueError('ไม่พบเส้นเวกเตอร์ในไฟล์')
