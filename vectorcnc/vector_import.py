"""นำเข้าไฟล์เวกเตอร์ (.ai/.pdf/.eps/.ps/.svg) -> สร้างไฟล์ตัดคมกริบทันที

กลยุทธ์ (ครอบคลุมทุกเคส + คมระดับ engineering):
- .pdf/.ai/.eps/.ps -> เรนเดอร์หน้าเป็นบิตแมปความละเอียดสูงด้วย PyMuPDF (fitz)
  แล้ว potrace -> Bézier เนียน  (รองรับทั้ง "ข้อความสด (live text)", เส้นเวกเตอร์,
  เอฟเฟกต์ ฯลฯ ที่ get_drawings ปกติมองไม่เห็น — และคมระดับซับพิกเซล)
- .eps/.ps/.ai(PostScript เก่า) -> แปลงเป็น PDF ด้วย Ghostscript ก่อนเรนเดอร์
- .svg -> อ่าน path ตรง (svgpathtools) คมสมบูรณ์ 100%  (ถ้าอ่านไม่ได้ค่อย fallback เรนเดอร์)

import ทั้งหมดแบบ lazy (สตาร์ตเว็บเร็ว)
"""
import os
import tempfile
import subprocess
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

VECTOR_EXT = ('.svg', '.ai', '.pdf', '.eps', '.ps')
RENDER_LONGEST_PX = 3200          # ด้านยาวสุดของบิตแมปที่เรนเดอร์ (คม + คุมแรม/เวลา)


def is_vector_file(path):
    return os.path.splitext(str(path))[1].lower() in VECTOR_EXT


# ---------- helper: sampling + nesting (สำหรับเส้นทาง SVG) ----------
def _cubic_pt(p0, c1, c2, e, t):
    mt = 1.0 - t
    a = mt * mt * mt; b = 3 * mt * mt * t; c = 3 * mt * t * t; d = t * t * t
    return (a * p0[0] + b * c1[0] + c * c2[0] + d * e[0],
            a * p0[1] + b * c1[1] + c * c2[1] + d * e[1])


def _nest(rings, min_area):
    """สร้าง shapely (รูซ้อนถูกชั้น) ด้วย parent-containment (even-odd)"""
    items = []
    for r in rings:
        if len(r) < 3:
            continue
        try:
            fp = Polygon(r).buffer(0)
        except Exception:
            continue
        if fp.is_empty or fp.area < min_area:
            continue
        items.append({'ring': r, 'filled': Polygon(r).buffer(0),
                      'area': fp.area, 'rep': fp.representative_point()})
    if not items:
        return None
    items.sort(key=lambda d: d['area'])
    n = len(items)
    for i in range(n):
        items[i]['parent'] = None
        for j in range(i + 1, n):
            if items[j]['filled'].contains(items[i]['rep']):
                items[i]['parent'] = j
                break
    for k in sorted(range(n), key=lambda k: -items[k]['area']):
        par = items[k]['parent']
        items[k]['solid'] = (par is None) or (not items[par]['solid'])
    polys = []
    for k in range(n):
        if not items[k]['solid']:
            continue
        holes = [items[c]['ring'] for c in range(n)
                 if items[c]['parent'] == k and not items[c]['solid']]
        try:
            poly = Polygon(items[k]['ring'], holes).buffer(0)
            if not poly.is_empty:
                polys.append(poly)
        except Exception:
            continue
    return unary_union(polys) if polys else None


# ---------- PDF/AI/EPS: เรนเดอร์ + potrace (ครอบคลุม + คมกริบ) ----------
def _geom_from_render(path, filetype=None):
    import fitz
    from . import trace_engine
    doc = fitz.open(path, filetype=filetype) if filetype else fitz.open(path)
    try:
        page = doc[0]
        R = page.rect
        W, H = float(R.width), float(R.height)
        if max(W, H) <= 0:
            return None, 0, 0
        sc = RENDER_LONGEST_PX / max(W, H)
        pix = page.get_pixmap(matrix=fitz.Matrix(sc, sc), alpha=False)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        gray = img[..., :3].mean(2) if pix.n >= 3 else img[..., 0]
        ink = (gray < 250).astype(np.uint8) * 255          # ทุกอย่างที่ไม่ใช่ขาว = หมึก
        min_area = max(4.0, pix.width * pix.height * 3e-6)
        geom = trace_engine._mask_to_geom_potrace(ink, min_area)
        return geom, float(pix.width), float(pix.height)
    finally:
        doc.close()


def _to_pdf_via_gs(path):
    out = tempfile.mktemp(suffix='.pdf')
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
                    '-sDEVICE=pdfwrite', '-o', out, path],
                   check=True, timeout=120,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def _geom_render_any(path):
    ext = os.path.splitext(str(path))[1].lower()
    if ext in ('.pdf', '.ai'):
        try:
            g, W, H = _geom_from_render(path, filetype='pdf')
            if g is not None and not g.is_empty:
                return g, W, H
        except Exception:
            pass
    pdf = _to_pdf_via_gs(path)                    # eps / ps / ai(PostScript)
    try:
        return _geom_from_render(pdf, filetype='pdf')
    finally:
        try:
            os.remove(pdf)
        except Exception:
            pass


# ---------- SVG: อ่าน path ตรง (คมสมบูรณ์ 100%) ----------
def _geom_from_svg(path):
    from svgpathtools import svg2paths2
    paths, attrs, svg_attr = svg2paths2(path)
    xmin = ymin = 1e18; xmax = ymax = -1e18
    rings = []
    for p in paths:
        for sub in p.continuous_subpaths():
            L = sub.length()
            if L < 1:
                continue
            N = int(max(8, min(4000, L / 2.0)))
            pts = []
            for i in range(N + 1):
                z = sub.point(i / float(N))
                pts.append((z.real, z.imag))
                xmin = min(xmin, z.real); xmax = max(xmax, z.real)
                ymin = min(ymin, z.imag); ymax = max(ymax, z.imag)
            if len(pts) >= 3:
                rings.append(pts)
    vb = svg_attr.get('viewBox') or svg_attr.get('viewbox')
    if vb:
        v = [float(x) for x in vb.replace(',', ' ').split()]
        W, H = v[2], v[3]
    else:
        W = xmax - xmin if xmax > xmin else 100.0
        H = ymax - ymin if ymax > ymin else 100.0
    if not rings:
        return None, W, H
    page_area = float(W) * float(H)

    def _area(r):
        try:
            return Polygon(r).buffer(0).area
        except Exception:
            return 0.0

    rings = [r for r in rings if _area(r) < 0.92 * page_area]   # ตัดพื้นหลัง/artboard
    min_area = max(1.0, page_area * 5e-6)
    return _nest(rings, min_area), W, H


# ---------- main ----------
def process_vector(image_path, out_svg_mm, out_dxf=None, real_width_mm=1200.0,
                   kerf_mm=3.0, tool_mm=6.0, min_mm=2.0, round_corners=True, tabs=0):
    """เวกเตอร์ -> ไฟล์ตัด (คืน dict รูปแบบเดียวกับ pipeline.process_cnc)"""
    from . import cnc_export
    ext = os.path.splitext(str(image_path))[1].lower()
    geom = W = H = None
    if ext == '.svg':
        geom, W, H = _geom_from_svg(image_path)
        if geom is None or geom.is_empty:
            geom, W, H = _geom_from_render(image_path)     # fallback เรนเดอร์
    else:
        geom, W, H = _geom_render_any(image_path)
    if geom is None or geom.is_empty or not W or not H:
        raise ValueError('ไม่พบเส้นเวกเตอร์ในไฟล์ (ไฟล์อาจว่าง/เป็นภาพล้วน — ลองบันทึกเป็น PDF อีกครั้ง)')

    ppm = W / float(real_width_mm) if real_width_mm else 1.0
    layers = []
    total = 0
    r2 = cnc_export.process_geom(geom, ppm, kerf_mm=kerf_mm, tool_mm=tool_mm,
                                 min_mm=min_mm, round_corners=round_corners, tabs=tabs)
    if r2:
        layers.append(('L0', '#111111', r2))
        total = len(r2)
    svg_mm = cnc_export.svg_string(layers, W, H, ppm, mm=True)
    svg_px = cnc_export.svg_string(layers, W, H, ppm, mm=False)
    with open(out_svg_mm, 'w', encoding='utf-8') as f:
        f.write(svg_mm)
    if out_dxf:
        cnc_export.write_dxf(layers, out_dxf, ppm, H)
    return {
        'size_px': (int(round(W)), int(round(H))),
        'size_mm': (round(W / ppm, 1), round(H / ppm, 1)),
        'ppm': ppm, 'mode': 'vector', 'engine': 'vector',
        'detected': {'kind': 'vector', 'mode': 'vector', 'engine': 'vector',
                     'notes': 'ดึงจากไฟล์เวกเตอร์ (คมกริบ)'},
        'n_layers': len(layers), 'n_rings': total,
        'svg_mm': svg_mm, 'svg_px': svg_px,
        'layer_colors': [c for n, c, r in layers],
    }
