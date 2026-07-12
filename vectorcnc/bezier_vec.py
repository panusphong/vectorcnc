"""bezier_vec.py — vectorize ภาพ raster (JPG/PNG) เป็น "เส้นโค้ง Bézier แท้" เหมือน .ai
ใช้ vtracer (trace_vtracer) -> subpaths line+spline -> SVG (C/L) + DXF (SPLINE/LINE)
ปรับขนาดจริงได้ 3 แบบ: กว้างป้าย / สูงป้าย / สูงตัวอักษร (สเกลทั้งชิ้น ไม่บิดสัดส่วน)
"""
import math
import ezdxf
from . import trace_engine as te

BEZIER_VERSION = "2026-07-12-fitv2-SHARP"   # แก้บั๊กสูตร Bézier fit (residual ตกพจน์ B1/B2) + Newton reparam + corner detect แบบหน้าต่างระยะทาง
# ผลลัพธ์ (วงกลม R150mm): เดิม 93 เส้นโค้ง คลาดเคลื่อน 0.69mm -> ใหม่ 9 เส้นโค้ง คลาดเคลื่อน 0.033mm


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
    # ความหนาเส้นสัมพันธ์กับขนาดงาน (กันเส้นบางจนมองไม่เห็นเมื่อเปิดไฟล์ มม. ที่กว้างมาก)
    # ใช้ stroke ธรรมดา (ไม่ใช้ vector-effect) -> เข้ากันได้ทุกโปรแกรม (บางตัวไม่รองรับ non-scaling-stroke แล้วซ่อนเส้น)
    sw = max(0.5, max(float(W), float(H)) * 0.0018)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.2f}{unit}" height="{H:.2f}{unit}" '
            f'viewBox="0 0 {W:.2f} {H:.2f}">'
            f'<g fill="none" stroke="{stroke}" stroke-width="{sw:.2f}" '
            f'stroke-linejoin="round" stroke-linecap="round">'
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
    # ---- รวมทุก segment เป็น 'B-spline degree-3 เส้นเดียวต่อ contour' (ไม่แตกเป็นชิ้น -> ไม่ยึกยักในทุกโปรแกรม) ----
    # bezier chain -> control points [P0, c1,c2,e, c1,c2,e, ...] + knots มัลติปลิซิตี 3 ที่รอยต่อ (แบบไฟล์โรงงาน)
    ctrl = [tf(start)]; cur = start
    for s in segs:
        if s[0] == 'L':
            e = s[1]
            c1 = (cur[0] + (e[0] - cur[0]) / 3.0, cur[1] + (e[1] - cur[1]) / 3.0)
            c2 = (cur[0] + 2.0 * (e[0] - cur[0]) / 3.0, cur[1] + 2.0 * (e[1] - cur[1]) / 3.0)
            ctrl += [tf(c1), tf(c2), tf(e)]; cur = e
        else:
            ctrl += [tf(s[1]), tf(s[2]), tf(s[3])]; cur = s[3]
    n = len(segs)
    knots = [0, 0, 0, 0]
    for i in range(1, n):
        knots += [i, i, i]
    knots += [n, n, n, n]
    try:
        spl = layout.add_spline(dxfattribs={'layer': layer})
        spl.apply_construction_tool(_BSpline(ctrl, order=4, knots=knots))
    except Exception:
        pts = [tf(start)] + [tf(s[1] if s[0] == 'L' else s[3]) for s in segs]
        layout.add_lwpolyline(pts, close=True, dxfattribs={'layer': layer})


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


def _sp_points(sp, step=0.30):
    """subpath (Bézier/line มม.) -> ชุดจุด polyline สำหรับ shapely"""
    pts = [(float(sp['start'][0]), float(sp['start'][1]))]; cur = pts[0]
    for s in sp['segs']:
        if s[0] == 'L':
            pts.append((float(s[1][0]), float(s[1][1]))); cur = pts[-1]
        else:
            c1, c2, e = s[1], s[2], s[3]
            L = (abs(c1[0]-cur[0])+abs(c1[1]-cur[1])+abs(c2[0]-c1[0])+abs(c2[1]-c1[1])+abs(e[0]-c2[0])+abs(e[1]-c2[1]))
            n = int(min(160, max(3, L / step)))
            for i in range(1, n + 1):
                t = i / float(n); mt = 1 - t
                x = mt*mt*mt*cur[0]+3*mt*mt*t*c1[0]+3*mt*t*t*c2[0]+t*t*t*e[0]
                y = mt*mt*mt*cur[1]+3*mt*mt*t*c1[1]+3*mt*t*t*c2[1]+t*t*t*e[1]
                pts.append((x, y))
            cur = (float(e[0]), float(e[1]))
    return pts


def _scale_sub(sp, s):
    def T(p): return (p[0] * s, p[1] * s)
    return {'start': T(sp['start']), 'closed': sp.get('closed', True),
            'segs': [('L', T(x[1])) if x[0] == 'L' else ('C', T(x[1]), T(x[2]), T(x[3])) for x in sp['segs']]}


def _fit_ring_to_sub(ring, tol=0.03, corner_deg=58.0, win_mm=0.9):
    """วงพิกัด (จาก shapely offset) -> subpath เส้นโค้ง Bézier แท้ (SPLINE)

    v2 — แก้ 3 บั๊กที่ทำให้เส้น "เหลี่ยม/หักมุม":
      1) เดิมตรวจมุมจากจุด 3 จุดติดกัน -> โค้งแคบ (รัศมีเล็ก) ถูกมองเป็น 'มุมคม' ผิด ๆ
         => ตอนนี้วัดมุมจากทิศทางเฉลี่ยช่วง ±win_mm (มุมจริงเท่านั้นถึงจะเกิน corner_deg)
      2) เดิมช่วงที่มีจุด < 4 ถูกเขียนเป็น "เส้นตรง" -> เกิดหน้าตัดเหลี่ยม
         => ตอนนี้ฟิต Bézier เสมอ (เว้นแต่เป็นเส้นตรงจริง)
      3) เดิมช่วงปิดวง (จุดสุดท้าย -> จุดแรก) ถูกทิ้ง -> เกิด 'รอยแบน' ตรงตะเข็บ
         => ตอนนี้ปิดวงแบบวน (cyclic) เนียนตลอด
    """
    try:
        import numpy as np
        from shapely.geometry import LineString
        P = np.asarray(ring, dtype=float)
        if len(P) >= 2 and np.allclose(P[0], P[-1]):
            P = P[:-1]
        if len(P) < 4:
            raise ValueError('few')
        # ลดจุดซ้ำเบา ๆ เท่านั้น (คงความละเอียดของโค้งไว้ให้ตัวฟิตทำงาน)
        ls = LineString(np.vstack([P, P[:1]])).simplify(min(tol * 0.25, 0.02),
                                                        preserve_topology=False)
        P = np.asarray(ls.coords, dtype=float)
        if len(P) >= 2 and np.allclose(P[0], P[-1]):
            P = P[:-1]
        n = len(P)
        if n < 4:
            raise ValueError('few2')

        def _u(pts):
            d = np.zeros(len(pts))
            for i in range(1, len(pts)):
                d[i] = d[i-1] + float(np.hypot(*(pts[i]-pts[i-1])))
            return d/d[-1] if d[-1] > 0 else np.linspace(0, 1, len(pts))

        def _bev(b, u):
            b0, c1, c2, b3 = b; mt = 1-u
            return (mt**3)[:, None]*b0 + (3*mt*mt*u)[:, None]*c1 + (3*mt*u*u)[:, None]*c2 + (u**3)[:, None]*b3

        def _nrm(v):
            nn = float(np.hypot(*v))
            return v/nn if nn > 1e-9 else np.array([1.0, 0.0])

        def _fit_one(pts, t1, t2, u=None):
            """least-squares fit cubic Bézier (Schneider)
            !! บั๊กเดิม: residual ตกพจน์ B1*b0 และ B2*b3 -> alpha เพี้ยน 2.3 เท่า
               เส้นโค้งบวมออกนอกรูป -> ตัวฟิตต้องหั่นเป็นเส้นสั้น ๆ นับร้อย
               => ได้ทั้ง 'จุดถี่' และ 'เหลี่ยม/หักมุม'  ตอนนี้แก้ให้ถูกแล้ว """
            if u is None:
                u = _u(pts)
            b0 = pts[0]; b3 = pts[-1]; mt = 1-u
            B0 = mt**3; B1 = 3*mt*mt*u; B2 = 3*mt*u*u; B3 = u**3
            a1 = B1[:, None]*t1; a2 = B2[:, None]*t2
            C00 = float((a1*a1).sum()); C01 = float((a1*a2).sum()); C11 = float((a2*a2).sum())
            R = pts - ((B0 + B1)[:, None]*b0 + (B2 + B3)[:, None]*b3)
            X0 = float((a1*R).sum()); X1 = float((a2*R).sum())
            det = C00*C11 - C01*C01; chord = float(np.hypot(*(b3-b0)))
            if abs(det) < 1e-9 or chord < 1e-9:
                al1 = al2 = max(chord, 1e-6)/3.0
            else:
                al1 = (X0*C11 - C01*X1)/det; al2 = (C00*X1 - X0*C01)/det
            lo, hi = chord*0.02, chord*1.6
            al1 = min(max(al1, lo), hi); al2 = min(max(al2, lo), hi)
            return (b0, b0 + t1*al1, b3 + t2*al2, b3)

        # ทิศเข้า/ออก แบบเฉลี่ยระยะ ~win_mm (กันโค้งแคบถูกมองเป็นมุม)
        def _dir_in(pts, i):
            j = i
            acc = 0.0
            while j > 0 and acc < win_mm:
                acc += float(np.hypot(*(pts[j]-pts[j-1]))); j -= 1
            return _nrm(pts[i]-pts[j]) if j != i else _nrm(pts[i]-pts[max(0, i-1)])

        def _dir_out(pts, i):
            j = i
            acc = 0.0
            m = len(pts)-1
            while j < m and acc < win_mm:
                acc += float(np.hypot(*(pts[j+1]-pts[j]))); j += 1
            return _nrm(pts[j]-pts[i]) if j != i else _nrm(pts[min(m, i+1)]-pts[i])

        def _dbev(b, u, order=1):
            b0, c1, c2, b3 = b; mt = 1-u
            if order == 1:
                return (3*mt*mt)[:, None]*(c1-b0) + (6*mt*u)[:, None]*(c2-c1) + (3*u*u)[:, None]*(b3-c2)
            return (6*mt)[:, None]*(c2-2*c1+b0) + (6*u)[:, None]*(b3-2*c2+c1)

        def _reparam(pts, b, u):
            """Newton-Raphson ดันพารามิเตอร์ให้เข้ารูป -> ฟิตแม่นขึ้นมาก ใช้เส้นโค้งน้อยลงเยอะ"""
            d = _bev(b, u) - pts
            d1 = _dbev(b, u, 1)
            d2 = _dbev(b, u, 2)
            num = (d*d1).sum(1)
            den = (d1*d1).sum(1) + (d*d2).sum(1)
            uu = np.where(np.abs(den) < 1e-12, u, u - num/np.where(np.abs(den) < 1e-12, 1.0, den))
            return np.clip(uu, 0.0, 1.0)

        def _fit_run(pts, t_start=None, t_end=None, depth=0):
            if len(pts) < 2:
                return []
            if len(pts) == 2:
                b0, b3 = pts[0], pts[-1]
                return [(b0, b0 + (b3-b0)/3.0, b0 + 2.0*(b3-b0)/3.0, b3)]
            t1 = t_start if t_start is not None else _dir_out(pts, 0)
            t2 = t_end if t_end is not None else -_dir_in(pts, len(pts)-1)
            u = _u(pts)
            b = _fit_one(pts, t1, t2, u)
            err = np.hypot(*(pts - _bev(b, u)).T)
            # ปรับพารามิเตอร์ซ้ำ 4 รอบ -> ความคลาดเคลื่อนลดลงหลายเท่า ด้วยเส้นโค้งเส้นเดิม
            for _ in range(4):
                if float(err.max()) <= tol:
                    break
                u2 = _reparam(pts, b, u)
                b2 = _fit_one(pts, t1, t2, u2)
                e2 = np.hypot(*(pts - _bev(b2, u2)).T)
                if float(e2.max()) >= float(err.max()):
                    break
                u, b, err = u2, b2, e2
            if float(err.max()) <= tol or depth >= 20 or len(pts) < 4:
                return [b]
            k = int(err.argmax()); k = max(1, min(len(pts)-2, k))
            # จุดแบ่งอยู่กลางโค้ง -> ใช้ทิศสัมผัสต่อเนื่อง (C1) ไม่ให้เกิดหักมุมเทียม
            tm = _nrm(pts[min(k+1, len(pts)-1)] - pts[max(k-1, 0)])
            return (_fit_run(pts[:k+1], t1, -tm, depth+1) +
                    _fit_run(pts[k:], tm, t2, depth+1))

        # ---- หา "มุมจริง" ด้วยหน้าต่างระยะทาง (ไม่ใช่ 3 จุดติดกัน)
        Pw = np.vstack([P[-2:], P, P[:2]])          # ต่อหัวท้ายให้วัดมุมข้ามตะเข็บได้
        corners = []
        for i in range(n):
            k = i + 2
            din = _dir_in(Pw, k)
            dout = _dir_out(Pw, k)
            c = float(np.clip(din @ dout, -1.0, 1.0))
            ang = float(np.degrees(np.arccos(c)))
            if ang > corner_deg:
                corners.append(i)

        Pcl = np.vstack([P, P[:1]])                 # ปิดวง (จุดสุดท้าย = จุดแรก)
        beziers = []
        if not corners:
            # ไม่มีมุมเลย (วงกลม/โค้งล้วน) -> ฟิตวนรอบเดียว ตะเข็บเนียน ไม่มีรอยแบน
            tseam = _nrm(P[1] - P[-1])              # ทิศสัมผัสที่ตะเข็บ (ต่อเนื่อง)
            beziers = _fit_run(Pcl, tseam, -tseam)
        else:
            r = corners[0]
            Q = np.vstack([P[r:], P[:r]])           # หมุนให้เริ่มที่มุมแรก
            cs = [(c - r) % n for c in corners]
            cs = sorted(set(cs))
            Qcl = np.vstack([Q, Q[:1]])
            bounds = cs + [n]                       # ช่วงสุดท้ายวนกลับมาปิดที่มุมแรก
            for a, b in zip(bounds[:-1], bounds[1:]):
                run = Qcl[a:b+1]
                if len(run) < 2:
                    continue
                beziers += _fit_run(run)
        if not beziers:
            raise ValueError('nofit')
        start = (float(beziers[0][0][0]), float(beziers[0][0][1]))
        segs = []
        for (b0, c1, c2, b3) in beziers:
            segs.append(('C', (float(c1[0]), float(c1[1])),
                         (float(c2[0]), float(c2[1])), (float(b3[0]), float(b3[1]))))
        return {'start': start, 'segs': segs, 'closed': True}
    except Exception:
        if len(ring) < 3:
            return None
        segs = [('L', (float(x), float(y))) for x, y in ring[1:]]
        return {'start': (float(ring[0][0]), float(ring[0][1])), 'segs': segs, 'closed': True}


def _offset_subs(subs_mm, kerf_mm, tool_mm):
    """ชดเชย kerf + ปัดมุมในตามดอกกัด — แบบ 'ทีละเส้น ตามชั้น (nesting)' เก็บทุกเส้นไว้ครบ.
    สำคัญ: ห้ามรวมทุกเส้นเป็นก้อนทึบเดียว (โมเดลเก่าจับตัวอักษร/เส้นบางที่อยู่ในกรอบเป็น 'รู'
    แล้วดูดหายตอน buffer -> ลายเส้นหายหมด). ที่นี่: เส้นชั้นนอก(คู่)=ขยายออก, เส้นชั้นใน(คี่)=หดเข้า,
    ทำ buffer เฉพาะรูปของตัวเอง ไม่ยุ่งกับเส้นอื่น -> โลโก้ลายเส้น/ตัวอักษรบางอยู่ครบ."""
    from shapely.geometry import Polygon
    d = max(0.0, float(kerf_mm or 0)) / 2.0
    r = max(0.0, float(tool_mm or 0)) / 2.0
    if d <= 0 and r <= 0:
        return subs_mm
    polys, srcs = [], []
    for sp in subs_mm:
        pts = _sp_points(sp, 0.15)   # sample ถี่ขึ้น -> ขอบ offset เนียนกว่า
        if len(pts) >= 3:
            try:
                pg = Polygon(pts).buffer(0)
                if pg and not pg.is_empty and pg.geom_type == 'Polygon':
                    polys.append(pg); srcs.append(sp)
            except Exception:
                polys.append(None); srcs.append(sp)
        else:
            polys.append(None); srcs.append(sp)
    reps = [(p.representative_point() if p is not None else None) for p in polys]
    areas = [(p.area if p is not None else 0.0) for p in polys]

    def _ring_to_sub(ring):
        return _fit_ring_to_sub(ring, tol=0.03)   # ฟิตเป็นเส้นโค้ง Bézier เนียน (SPLINE) แทน polyline — tol ละเอียดขึ้น

    out = []
    for i, p in enumerate(polys):
        if p is None:
            out.append(srcs[i]); continue          # เส้นที่ทำ polygon ไม่ได้ -> คงเดิม (ไม่ทิ้ง)
        # ชั้นความลึก = จำนวนรูปที่ใหญ่กว่าและครอบจุดนี้ไว้ (คู่=ขอบนอก, คี่=รู/ขอบใน)
        depth = 0
        for j, q in enumerate(polys):
            if j == i or q is None or areas[j] <= areas[i]:
                continue
            try:
                if q.contains(reps[i]):
                    depth += 1
            except Exception:
                pass
        sgn = 1.0 if (depth % 2 == 0) else -1.0     # นอก=ขยาย, ใน=หด (ชดเชย kerf ทั้งสองด้าน)
        g = p
        try:
            if d > 0:
                g = g.buffer(sgn * d, join_style=1, resolution=48)   # โค้งกลมละเอียดขึ้น
            if r > 0 and depth % 2 == 0:            # ปัดมุมในเฉพาะรูปทึบชั้นนอก
                g = g.buffer(-r, join_style=1, resolution=48).buffer(r, join_style=1, resolution=48)
        except Exception:
            g = p
        if g is None or g.is_empty:
            out.append(srcs[i]); continue           # หดจนหาย -> คงเส้นเดิมไว้ (ยังตัดได้)
        gs = list(g.geoms) if g.geom_type in ('MultiPolygon', 'GeometryCollection') else [g]
        added = False
        for gg in gs:
            if getattr(gg, 'geom_type', '') != 'Polygon' or gg.is_empty:
                continue
            for ring in [list(gg.exterior.coords)] + [list(h.coords) for h in gg.interiors]:
                s = _ring_to_sub(ring)
                if s:
                    out.append(s); added = True
        if not added:
            out.append(srcs[i])
    return out or subs_mm


def vectorize_bezier(image_path, real_width_mm=1200.0, n_colors=6, dxf_out=None,
                     size_by='width', size_value_mm=None, kerf_mm=0.0, tool_mm=0.0):
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

    subs_mm = []
    for _, subs in items:
        for sp in subs:
            subs_mm.append(_shift(sp, mnx, mny, 1.0 / ppm))
    # ชดเชย Kerf / ปัดมุมดอก (เฉพาะเมื่อเปิดใช้ — ถ้า 0 คงเส้นโค้งเนียนเดิม)
    if (kerf_mm and float(kerf_mm) > 0) or (tool_mm and float(tool_mm) > 0):
        try:
            subs_mm = _offset_subs(subs_mm, float(kerf_mm or 0), float(tool_mm or 0))
        except Exception:
            pass
    subs_px = [_scale_sub(sp, ppm) for sp in subs_mm]
    nrings = len(subs_mm)

    svg_px = _svg(subs_px, Wpx, Hpx)
    svg_mm = _svg(subs_mm, Wmm, Hmm, unit='mm')
    # ---- preview 'วางทับต้นฉบับ': เส้นตัดในพิกัดภาพต้นฉบับ (ไม่ตัดขอบ) เพื่อเทียบ before/after ให้ตรงเป๊ะ ----
    svg_fit = None
    try:
        _oh = _ow = None
        try:                                            # ใช้ตัวโหลดเดียวกับ trace (อ่านสำเร็จแน่นอน)
            from . import analyze as _an
            _oi = _an.load_image(image_path)
            if _oi is not None:
                _oh, _ow = _oi.shape[:2]
        except Exception:
            pass
        if _ow is None:                                 # fallback: อ่านแบบ path-safe (รองรับชื่อไฟล์ไทย/อักขระพิเศษ)
            try:
                import numpy as _np, cv2 as _cv
                _oi = _cv.imdecode(_np.fromfile(image_path, dtype=_np.uint8), _cv.IMREAD_COLOR)
                if _oi is not None:
                    _oh, _ow = _oi.shape[:2]
            except Exception:
                pass
        if _ow:
            _wh, _ww = getattr(te, 'LAST_WORK_HW', None) or (Hpx, Wpx)
            _sc = (float(_ow) / float(_ww)) if _ww else 1.0
            _raw = []
            for _c, _subs in items:
                for _sp in _subs:
                    _raw.append(_scale_sub(_sp, _sc))   # เทรซในพิกัดงาน -> คูณสเกลกลับเป็นพิกัดภาพต้นฉบับ
            svg_fit = _svg(_raw, _ow, _oh)
    except Exception:
        svg_fit = None
    if dxf_out:
        _dxf(subs_mm, Hmm, dxf_out)
    return {
        'svg_px': svg_px, 'svg_mm': svg_mm, 'svg_fit': svg_fit, 'dxf_path': dxf_out,
        'width_mm': round(Wmm, 1), 'height_mm': round(Hmm, 1),
        'letter_height_mm': round(letter_mm, 1), 'size_by': mode,
        'layers': len(items), 'rings': nrings, 'engine': engine_name,
    }
