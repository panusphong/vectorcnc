"""นำเข้าไฟล์เวกเตอร์ (.ai/.pdf/.eps/.ps/.svg) -> ไฟล์ตัด

หลักการ:
1) ดึง path เวกเตอร์ "ตรงจากไฟล์" แยกตาม "เลเยอร์ (OCG)" ของ .ai/.pdf
2) auto-ตัดเลเยอร์ขยะทิ้ง (กรอบบอกขนาด/ใบงาน/ภาพพรีวิว/texture ที่ path เยอะผิดปกติ)
3) idealize เส้นทุกเส้น (corner-detect + line-fit + smoothing B-spline)
   -> เนียนกว่าต้นฉบับ (ลบ wobble ที่ติดมาในไฟล์)
4) รวมเป็นไฟล์เดียว ให้สีต่างกันต่อเลเยอร์ (SVG สี / DXF layer)
ถ้าไฟล์แทบไม่มี path (ข้อความสด/ภาพฝัง) -> fallback: เรนเดอร์ + potrace
"""
import os
import tempfile
import subprocess
import numpy as np

VECTOR_EXT = ('.svg', '.ai', '.pdf', '.eps', '.ps')
RENDER_LONGEST_PX = 3200
_BEZ_STEP_PT = 1.2

# สีต่อเลเยอร์ (วนใช้)
_PALETTE = ['#111111', '#2563EB', '#DC2626', '#059669', '#D97706',
            '#7C3AED', '#0891B2', '#DB2777', '#65A30D', '#4B5563']


def is_vector_file(path):
    return os.path.splitext(str(path))[1].lower() in VECTOR_EXT


def _cubic_pt(a, c1, c2, e, t):
    mt = 1.0 - t
    return (mt**3 * a[0] + 3*mt*mt*t * c1[0] + 3*mt*t*t * c2[0] + t**3 * e[0],
            mt**3 * a[1] + 3*mt*mt*t * c1[1] + 3*mt*t*t * c2[1] + t**3 * e[1])


def _closed(r):
    return len(r) >= 3 and abs(r[0][0] - r[-1][0]) < 1.0 and abs(r[0][1] - r[-1][1]) < 1.0


def _regular(ring):
    """idealize เส้น (reuse ตัว regularize ของ trace_engine)"""
    try:
        from . import trace_engine
        return trace_engine._regularize_ring(ring)
    except Exception:
        return ring


# ---------- ดึง path ตาม "เลเยอร์" จาก PDF/AI ----------
def _extract_pdf_layers(path, filetype=None):
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
            cur = None
            sub = []
            for it in dr.get('items', []):
                op = it[0]
                if op in ('l', 'c'):
                    a = (it[1].x, it[1].y)
                    if cur is None or abs(a[0]-cur[0]) > 0.01 or abs(a[1]-cur[1]) > 0.01:
                        if len(sub) >= 2:
                            bucket.append(sub)
                        sub = [a]
                    if op == 'l':
                        sub.append((it[2].x, it[2].y)); cur = (it[2].x, it[2].y)
                    else:
                        c1 = (it[2].x, it[2].y); c2 = (it[3].x, it[3].y); e = (it[4].x, it[4].y)
                        L = (abs(c1[0]-a[0]) + abs(c1[1]-a[1]) + abs(c2[0]-c1[0]) +
                             abs(c2[1]-c1[1]) + abs(e[0]-c2[0]) + abs(e[1]-c2[1]))
                        N = int(min(200, max(4, L / _BEZ_STEP_PT)))
                        for i in range(1, N + 1):
                            sub.append(_cubic_pt(a, c1, c2, e, i / float(N)))
                        cur = e
                elif op == 're':
                    r = it[1]
                    bucket.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])
                elif op == 'qu':
                    q = it[1]
                    bucket.append([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y),
                                   (q.lr.x, q.lr.y), (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)])
            if len(sub) >= 2:
                bucket.append(sub)
        return layers, W, H
    finally:
        doc.close()


def _rings_from_svg(path):
    from svgpathtools import svg2paths2
    paths, attrs, svg_attr = svg2paths2(path)
    xmin = ymin = 1e18; xmax = ymax = -1e18
    rings = []
    for p in paths:
        for sub in p.continuous_subpaths():
            L = sub.length()
            if L < 0.5:
                continue
            N = int(max(4, min(6000, L / 1.2)))
            pts = []
            for i in range(N + 1):
                z = sub.point(i / float(N))
                pts.append((z.real, z.imag))
                xmin = min(xmin, z.real); xmax = max(xmax, z.real)
                ymin = min(ymin, z.imag); ymax = max(ymax, z.imag)
            if len(pts) >= 2:
                rings.append(pts)
    vb = svg_attr.get('viewBox') or svg_attr.get('viewbox')
    if vb:
        v = [float(x) for x in vb.replace(',', ' ').split()]
        W, H = v[2], v[3]
    else:
        W = xmax - xmin if xmax > xmin else 100.0
        H = ymax - ymin if ymax > ymin else 100.0
    return {'(default)': rings}, W, H


# ---------- auto ตัดเลเยอร์ขยะ ----------
def _bbox(r):
    xs = [p[0] for p in r]; ys = [p[1] for p in r]
    return max(xs) - min(xs), max(ys) - min(ys)


def _extent(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return (min(xs), min(ys), max(xs), max(ys))


def _auto_keep(layers, W, H):
    names = [ly for ly, rr in layers.items() if rr]
    if len(names) <= 1:
        return set(names)
    counts = {ly: len(layers[ly]) for ly in names}
    med = sorted(counts.values())[len(counts) // 2]
    keep = set()
    for ly in names:
        junk = False
        # (a) จำนวน path มากผิดปกติ (เลเยอร์ catch-all: annotation/preview/texture)
        if counts[ly] > max(20, 6 * med):
            junk = True
        # (b) มีกรอบสี่เหลี่ยมเกือบเต็มหน้า (กรอบบอกขนาด/ใบงาน)
        if not junk:
            for r in layers[ly]:
                bw, bh = _bbox(r)
                if bw > 0.5 * W and bh > 0.5 * H and len(r) <= 8:
                    junk = True; break
        # (c) ชื่อเลเยอร์แนว annotation
        low = str(ly).lower()
        if any(k in low for k in ('dim', 'annot', 'note', 'guide', 'spec', 'ใบงาน', 'text')):
            junk = True
        if not junk:
            keep.add(ly)
    return keep or set(names)


# ---------- fallback: เรนเดอร์ + potrace ----------
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
    return _finish([('L0', '#111111', rings)], W2, H2, ppm, out_svg_mm, out_dxf, 'vector-render')


def _finish(layers, W, H, ppm, out_svg_mm, out_dxf, engine):
    from . import cnc_export
    total = sum(len(rr) for n, c, rr in layers)
    svg_mm = cnc_export.svg_string(layers, W, H, ppm, mm=True)
    svg_px = cnc_export.svg_string(layers, W, H, ppm, mm=False)
    with open(out_svg_mm, 'w', encoding='utf-8') as f:
        f.write(svg_mm)
    if out_dxf:
        cnc_export.write_dxf(layers, out_dxf, ppm, H)
    return {
        'size_px': (int(round(W)), int(round(H))),
        'size_mm': (round(W / ppm, 1), round(H / ppm, 1)),
        'ppm': ppm, 'mode': 'vector', 'engine': engine,
        'detected': {'kind': 'vector', 'mode': 'vector', 'engine': engine,
                     'notes': 'ดึงเวกเตอร์ตรง + idealize เส้น (คมเนียนกว่าต้นฉบับ)'},
        'n_layers': len(layers), 'n_rings': total,
        'svg_mm': svg_mm, 'svg_px': svg_px,
        'layer_colors': [c for n, c, r in layers],
        'used_layers': [n for n, c, r in layers],
    }


def _npts(layers):
    return sum(len(r) for rr in layers.values() for r in rr)


def process_vector(image_path, out_svg_mm, out_dxf=None, real_width_mm=1200.0,
                   kerf_mm=3.0, tool_mm=6.0, min_mm=2.0, round_corners=True, tabs=0):
    """เวกเตอร์ -> ไฟล์ตัด (คืน dict รูปแบบเดียวกับ pipeline.process_cnc)"""
    ext = os.path.splitext(str(image_path))[1].lower()

    layers = None; W = H = 0.0
    try:
        if ext == '.svg':
            layers, W, H = _rings_from_svg(image_path)
        elif ext in ('.pdf', '.ai'):
            layers, W, H = _extract_pdf_layers(image_path, filetype='pdf')
        elif ext in ('.eps', '.ps'):
            pdf = _to_pdf_via_gs(image_path)
            try:
                layers, W, H = _extract_pdf_layers(pdf, filetype='pdf')
            finally:
                try: os.remove(pdf)
                except Exception: pass
    except Exception:
        layers = None

    if layers and _npts(layers) >= 60 and W > 0 and H > 0:
        keep = _auto_keep(layers, W, H)
        # idealize เส้นทุกเลเยอร์ที่เก็บ
        kept = []
        for ly in sorted(keep):
            rr = [_regular(r) for r in layers[ly] if len(r) >= 2]
            rr = [r for r in rr if len(r) >= 2]
            if rr:
                kept.append((str(ly), rr))
        if kept:
            # แยกชิ้น: วางแต่ละเลเยอร์เรียงแนวนอน ไม่ทับกัน (ขนาดจริงคงเดิม)
            boxes = [_extent(rr) for n, rr in kept]
            maxw = max((b[2] - b[0]) for b in boxes) or 1.0
            gap = 0.06 * maxw
            xoff = 0.0; maxh = 0.0
            out_layers = []
            for idx, (name, rr) in enumerate(kept):
                mnx, mny, mxx, mxy = boxes[idx]
                dx = xoff - mnx; dy = -mny
                ringc = []
                for r in rr:
                    tr = [(px + dx, py + dy) for px, py in r]
                    ringc.append((tr, _closed(tr)))
                out_layers.append((name, _PALETTE[idx % len(_PALETTE)], ringc))
                xoff += (mxx - mnx) + gap
                maxh = max(maxh, mxy - mny)
            NW = xoff - gap if len(kept) > 1 else (boxes[0][2] - boxes[0][0])
            NH = maxh if maxh > 0 else H
            ppm = maxw / float(real_width_mm) if real_width_mm else 1.0
            return _finish(out_layers, NW, NH, ppm, out_svg_mm, out_dxf, 'vector')

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


def _to_pdf_via_gs(path):
    out = tempfile.mktemp(suffix='.pdf')
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
                    '-sDEVICE=pdfwrite', '-o', out, path],
                   check=True, timeout=120,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out
