"""🌈 สร้าง 'เส้นเดินไฟนีออน' (เส้นเดี่ยว) จากรูปทรงงาน — แบบเดียวกับไฟล์งานจริง

กติกาที่ถอดมาจากไฟล์งานจริง 3 ไฟล์ (SVGneon / TCCNEON110 / GUIDneon):
  • เส้นนีออน = 'เส้นแกนกลาง' ของลายเส้น (เส้นเปิด ไม่ใช่เส้นรอบรูป)
  • ความหนาเส้นที่เขียนแบบ = ความกว้างท่อนีออนจริง (24 pt = 8.5 มม. เป็นค่ามาตรฐานของทีม)
  • แผ่นพื้น = ขยายจากเส้นแกนกลางออกไป ≈ 2 เท่าของความกว้างท่อ  (วัดได้ 2.07 และ 2.16 เท่า)
  • รูหมุดลอย Ø 20 มม.
  • ความยาวไฟ = ผลรวมความยาวเส้นแกนกลาง -> วัตต์ = ยาว(ม.) x 8W x 1.2

ขั้นตอน: รูปทรง -> ภาพขาวดำ -> หาแกนกลาง -> ต่อเป็นเส้นยาว ๆ -> ตัดหนวด -> เกลาโค้ง
         -> คุมรัศมีโค้งขั้นต่ำ (ท่อนีออนดัดแคบกว่านี้ไม่ได้) -> เส้นโค้งเบซิเยร์
"""
import math
import numpy as np
import cv2
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import unary_union


# ─────────────────────────── 1. รูปทรง -> ภาพ ───────────────────────────
def geom_to_mask(geom, px_per_mm=4.0, pad_px=8, max_px=6000.0):
    """วาดรูปทรงลงภาพขาวดำ

    ⚠️ ความละเอียดคือทุกอย่างของงานนี้ — แกนกลางที่ได้ละเอียดได้ไม่เกินพิกเซลที่ป้อนเข้า
       ป้ายยาว 4 ม. ถ้าเพดานอยู่ที่ 4000 px จะเหลือ 1 px = 1 มม. -> เส้นหยาบทันที
       ดัน 6000 px ได้รายละเอียด 0.67 มม. โดยเวลาเพิ่มไม่ถึงเท่าตัว (skeletonize เร็ว)
    """
    b = geom.bounds
    w = b[2] - b[0]; h = b[3] - b[1]
    _long = max(w, h, 1e-6)
    # 🔍 คุมให้ด้านยาวอยู่ในช่วง 3000-6000 px เสมอ ไม่ว่าป้ายจะเล็กหรือใหญ่
    #    (เดิมป้ายเล็กได้แค่ 4 px/มม. = ด้านยาว 2300 px -> รายละเอียดน้อยกว่าป้ายใหญ่เสียอีก)
    ppm = max(float(px_per_mm), 3000.0 / _long)
    ppm = min(ppm, float(max_px) / _long)
    W = int(round(w * ppm)) + pad_px * 2
    H = int(round(h * ppm)) + pad_px * 2
    m = np.zeros((H, W), np.uint8)

    def ring(cs):
        a = np.asarray(cs, dtype=np.float64)
        a[:, 0] = (a[:, 0] - b[0]) * ppm + pad_px
        a[:, 1] = (a[:, 1] - b[1]) * ppm + pad_px
        return np.round(a).astype(np.int32)

    for pg in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom]):
        if pg.geom_type != "Polygon" or pg.is_empty:
            continue
        cv2.fillPoly(m, [ring(pg.exterior.coords)], 255)
        for h2 in pg.interiors:
            cv2.fillPoly(m, [ring(h2.coords)], 0)
    return m, ppm, (b[0] - pad_px / ppm, b[1] - pad_px / ppm)


def stroke_width_mm(mask, ppm):
    """ความหนาลายเส้นเฉลี่ยจริง (มม.) — ใช้ตั้งค่าเริ่มต้นของท่อนีออน + เกณฑ์ตัดหนวด"""
    dt = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    v = dt[dt > 0]
    if v.size == 0:
        return 0.0
    return float(np.percentile(v, 80) * 2.0 / ppm)


# ─────────────────────────── 2. แกนกลาง -> กราฟ ───────────────────────────
_N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def skeleton(mask):
    from skimage.morphology import skeletonize
    return skeletonize(mask > 0)


def _deg_map(sk):
    s = sk.astype(np.uint8)
    k = np.ones((3, 3), np.uint8); k[1, 1] = 0
    return cv2.filter2D(s, -1, k, borderType=cv2.BORDER_CONSTANT) * s


def trace_chains(sk):
    """เดินตามแกนกลาง -> คืน list ของโซ่พิกเซล (แต่ละโซ่คือเส้นต่อเนื่องระหว่างปม)"""
    H, W = sk.shape
    deg = _deg_map(sk)
    pix = {(y, x) for y, x in zip(*np.nonzero(sk))}
    nodes = {p for p in pix if deg[p] != 2}
    used = set()
    chains = []

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in _N8
                if 0 <= y + dy < H and 0 <= x + dx < W and sk[y + dy, x + dx]]

    for n in nodes:
        for nb in nbrs(n):
            if (n, nb) in used:
                continue
            chain = [n, nb]
            used.add((n, nb)); used.add((nb, n))
            cur, prev = nb, n
            while deg[cur] == 2:
                nx = [q for q in nbrs(cur) if q != prev]
                if not nx:
                    break
                prev, cur = cur, nx[0]
                used.add((prev, cur)); used.add((cur, prev))
                chain.append(cur)
            chains.append(chain)
    # วงปิดที่ไม่มีปมเลย (เช่นตัว O)
    seen = {p for c in chains for p in c}
    for p in pix - seen:
        if p in seen:
            continue
        chain = [p]; seen.add(p); cur = p; prev = None
        while True:
            nx = [q for q in nbrs(cur) if q != prev and (q not in seen or q == chain[0])]
            if not nx:
                break
            prev, cur = cur, nx[0]
            if cur == chain[0]:
                chain.append(cur); break
            seen.add(cur); chain.append(cur)
        if len(chain) > 8:
            chains.append(chain)
    return chains, nodes


# ─────────────────────────── 3. ตัดหนวด + ต่อเส้นยาว ───────────────────────────
def prune_and_join(chains, nodes, ppm, spur_mm):
    """ตัดกิ่งสั้น (หนวดที่เกิดจากปลายเส้น/เซริฟ) แล้วต่อโซ่ที่ไปทางเดียวกันให้เป็นเส้นยาว

    ⚠️ ต้องตัดซ้ำหลายรอบ — ตัดหนวดเส้นหนึ่งออก ปมสามแฉกจะกลายเป็นทางตรง
       แล้วหนวดชั้นถัดไปถึงจะโผล่ให้เห็น (ตัดรอบเดียวจะเหลือ 'ตีนกา' ที่ปลายเส้นทุกตัว)
    """
    spur_px = spur_mm * ppm
    keep = [list(c) for c in chains]
    for _ in range(8):
        ends = {}
        for c in keep:
            ends[c[0]] = ends.get(c[0], 0) + 1
            ends[c[-1]] = ends.get(c[-1], 0) + 1
        out = []
        cut = 0
        for c in keep:
            d0 = ends.get(c[0], 0); d1 = ends.get(c[-1], 0)
            free_end = (d0 == 1) or (d1 == 1)          # ปลายลอย = ไม่ต่อกับใคร
            if free_end and not (d0 == 1 and d1 == 1) and len(c) < spur_px:
                cut += 1
                continue
            out.append(c)
        keep = out
        if not cut:
            break
    if not keep:
        keep = [list(c) for c in chains]

    # ต่อโซ่ที่ปมเดียวกันและทิศทางต่อเนื่องกันที่สุด
    def dirv(c, at_start):
        seg = c[:6] if at_start else c[-6:][::-1]
        a = np.asarray(seg, dtype=float)
        if len(a) < 2:
            return np.array([0.0, 0.0])
        v = a[0] - a[-1]
        n = np.linalg.norm(v)
        return v / n if n > 1e-9 else v

    items = [list(c) for c in keep]
    changed = True
    while changed:
        changed = False
        endmap = {}
        for i, c in enumerate(items):
            endmap.setdefault(c[0], []).append((i, True))
            endmap.setdefault(c[-1], []).append((i, False))
        for p, lst in endmap.items():
            if len(lst) != 2:
                continue
            (i, si), (j, sj) = lst
            if i == j:
                continue
            a, b = items[i], items[j]
            va = dirv(a, si); vb = dirv(b, sj)
            if float(np.dot(va, vb)) > -0.35:      # หักศอกเกินไป -> ไม่ต่อ
                continue
            aa = a[::-1] if si else a
            bb = b if sj else b[::-1]
            items[i] = aa + bb[1:]
            items[j] = None
            items = [x for x in items if x is not None]
            changed = True
            break
    return items


# ─────────────────────────── 4. เกลาเส้น + คุมรัศมีโค้ง ───────────────────────────
def chain_to_line(chain, ppm, org, simp_mm=0.25, smooth_mm=1.2, spline=True):
    """โซ่พิกเซล -> เส้นโค้งเนียน (มม.)

    ⚠️ แกนกลางที่ได้จากภาพเป็น 'บันไดพิกเซล' — ถ้าเอาไปฟิตเบซิเยร์ตรง ๆ
       เส้นจะกระเพื่อมเป็นคลื่นเล็ก ๆ ตลอดแนว (เห็นชัดมากตอนซูมและตอนเป็นนีออนจริง)
       เฉลี่ยเคลื่อนที่อย่างเดียวช่วยได้ระดับหนึ่ง แต่จะ 'กินมุม' และยังเหลือคลื่น
    ✅ วิธีที่ได้ผลจริง: ฟิตสไปลน์แบบกำลังสองน้อยสุด โดยตั้งค่าความคลาดที่ยอมได้
       = ครึ่งพิกเซล -> คลื่นจากพิกเซลถูกดูดหายไปหมด แต่รูปทรงจริงไม่ขยับ
    """
    a = np.asarray(chain, dtype=float)[:, ::-1]        # (y,x) -> (x,y)
    a[:, 0] = a[:, 0] / ppm + org[0]
    a[:, 1] = a[:, 1] / ppm + org[1]
    if len(a) < 3:
        return None
    closed = bool(len(a) > 4 and np.hypot(*(a[0] - a[-1])) < 1.5 / ppm)
    # ทิ้งจุดซ้ำ/ชิดกันเกินไป (splprep ไม่ชอบ)
    keep = [0]
    for i in range(1, len(a)):
        if np.hypot(*(a[i] - a[keep[-1]])) > 0.35 / ppm:
            keep.append(i)
    a = a[keep]
    if len(a) < 4:
        return LineString(a) if len(a) >= 2 else None
    sm = None
    if spline:
        try:
            from scipy.interpolate import splprep, splev
            px = 1.0 / ppm
            # ยอมให้เส้นคลาดจากจุดเดิมได้ ~ครึ่งพิกเซล (รวมทุกจุด) = พอดีที่จะกลืนบันไดพิกเซล
            s = len(a) * (px * 0.55) ** 2
            per = 1 if closed else 0
            pts = a[:-1] if (closed and len(a) > 4) else a
            tck, u = splprep([pts[:, 0], pts[:, 1]], s=s, k=3, per=per)
            n = max(24, int(LineString(a).length / max(0.35, px)))
            uu = np.linspace(0, 1, min(n, 4000))
            x, y = splev(uu, tck)
            sm = np.column_stack([x, y])
            if closed:
                sm[-1] = sm[0]
            else:                                  # ปลายเส้นต้องอยู่ที่เดิม (จุดจบของลายเส้น)
                sm[0] = a[0]; sm[-1] = a[-1]
        except Exception:
            sm = None
    if sm is None:                                  # ถอย: เฉลี่ยเคลื่อนที่แบบเดิม
        k = max(3, int(round(smooth_mm * ppm)) | 1)
        pad = np.vstack([np.repeat(a[:1], k, 0), a, np.repeat(a[-1:], k, 0)])
        ker = np.ones(k) / k
        sm = np.column_stack([np.convolve(pad[:, 0], ker, "same"),
                              np.convolve(pad[:, 1], ker, "same")])[k:-k]
        sm[0] = a[0]; sm[-1] = a[-1]
    ls = LineString(sm).simplify(simp_mm)
    return ls if ls.length > 1.0 else None


def min_radius(line, step=2.0):
    """รัศมีโค้งต่ำสุดของเส้น (มม.) — ใช้เช็คว่าท่อนีออนดัดตามได้จริงไหม"""
    a = np.asarray(line.coords)
    if len(a) < 3:
        return 1e9
    d = np.linalg.norm(np.diff(a, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(d)])
    if s[-1] < 3 * step:
        return 1e9
    t = np.arange(0, s[-1], step)
    x = np.interp(t, s, a[:, 0]); y = np.interp(t, s, a[:, 1])
    if len(t) < 3:
        return 1e9
    dx = np.gradient(x); dy = np.gradient(y)
    ddx = np.gradient(dx); ddy = np.gradient(dy)
    num = (dx * dx + dy * dy) ** 1.5
    den = np.abs(dx * ddy - dy * ddx)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(den > 1e-9, num / den, 1e9)
    return float(np.percentile(r, 1))


def _local_radius(a, step_idx=1):
    """รัศมีโค้งที่จุดละจุด (มม.) จากสามจุดติดกัน"""
    n = len(a)
    r = np.full(n, 1e9)
    if n < 3:
        return r
    p0 = a[:-2]; p1 = a[1:-1]; p2 = a[2:]
    A = np.linalg.norm(p1 - p0, axis=1)
    B = np.linalg.norm(p2 - p1, axis=1)
    C = np.linalg.norm(p2 - p0, axis=1)
    cross = np.abs((p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1])
                   - (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0]))
    with np.errstate(divide="ignore", invalid="ignore"):
        rr = np.where(cross > 1e-9, A * B * C / (2.0 * cross), 1e9)
    r[1:-1] = rr
    return r


def relax_tight_bends(line, r_min, rounds=40, step_mm=1.0):
    """คลาย 'เฉพาะจุดที่โค้งแคบเกินท่อนีออนดัดได้' — ไม่ไปแตะช่วงที่ดีอยู่แล้ว

    ท่อนีออนซิลิโคนดัดในระนาบได้จำกัด ถ้าแบบมีมุมแคบกว่านั้น ช่างต้องมาดัดฝืน
    เส้นจะย่นและไฟด้านในจะบี้ -> ต้องคลายให้ตั้งแต่ตอนออกแบบ
    """
    a = np.asarray(line.coords, dtype=float)
    if len(a) < 5:
        return line
    # เพิ่มความถี่จุดให้พอคลายได้
    d = np.linalg.norm(np.diff(a, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(d)])
    if s[-1] > step_mm * 3:
        t = np.arange(0, s[-1], step_mm)
        a = np.column_stack([np.interp(t, s, a[:, 0]), np.interp(t, s, a[:, 1])])
    closed = np.allclose(a[0], a[-1])
    for _ in range(rounds):
        r = _local_radius(a)
        bad = r < r_min
        if not bad.any():
            break
        w = np.zeros(len(a))
        w[bad] = 1.0
        # ลามความช่วยเหลือไปยังเพื่อนบ้าน ไม่ให้เกิดรอยหยัก
        w = np.convolve(w, np.ones(5) / 5.0, mode="same")
        w = np.clip(w, 0, 1) * 0.6
        b = a.copy()
        lap = np.zeros_like(a)
        lap[1:-1] = 0.5 * (a[:-2] + a[2:]) - a[1:-1]
        b += lap * w[:, None]
        if not closed:
            b[0] = a[0]; b[-1] = a[-1]
        a = b
    return LineString(a)


# ─────────────────────────── 5. ตัวหลัก ───────────────────────────
def neon_paths(geom, tube_mm=None, px_per_mm=4.0, spur_ratio=0.75, bend_ratio=1.5):
    """คืน dict: paths (LineString มม.), tube_mm, length_m, watt, plate (Polygon)"""
    mask, ppm, org = geom_to_mask(geom, px_per_mm)
    sw = stroke_width_mm(mask, ppm)
    tube = float(tube_mm) if tube_mm else max(6.0, min(15.0, round(sw * 0.8)))
    sk = skeleton(mask)
    chains, nodes = trace_chains(sk)
    items = prune_and_join(chains, nodes, ppm, spur_mm=max(sw, 2.0) * spur_ratio)
    r_min = tube * bend_ratio
    lines = []
    for c in items:
        ls = chain_to_line(c, ppm, org)
        if ls is None or ls.length < max(8.0, tube * 1.5):
            continue
        lines.append(relax_tight_bends(ls, r_min))
    total = sum(l.length for l in lines) / 1000.0
    plate = unary_union([l.buffer(tube * 2.0, cap_style=1, join_style=1) for l in lines])
    plate = plate.buffer(tube * 0.8).buffer(-tube * 0.8)          # เกลาให้ขอบไหลลื่น
    return {"paths": lines, "tube_mm": tube, "stroke_mm": sw,
            "length_m": total, "watt": total * 8.0 * 1.2,
            "r_min_mm": min([min_radius(l) for l in lines] or [0]),
            "plate": plate, "mask_ppm": ppm}


def centerline_subs(full, tube_mm=8.0, clear_mm=1.0, px_per_mm=4.0):
    """🔌 หน้าบ้านสำหรับ app.py — คืน (subs, report) รูปแบบเดียวกับ neon_single.centerline()

    subs = เส้นโค้งเบซิเยร์ในหน่วย มม. ({"start","segs","closed"})
    ล้มเหลว -> ([], []) ให้ผู้เรียกถอยไปวิธีเดิม (งานห้ามพัง)
    """
    try:
        if full is None or full.is_empty:
            return [], []
        r = neon_paths(full, tube_mm=tube_mm, px_per_mm=px_per_mm)
        if not r["paths"]:
            return [], []
        try:                                    # ใช้ตัวฟิตเบซิเยร์ตัวเดียวกับโมดูลเดิม -> สไตล์เส้นเหมือนกัน
            from neon_single import _to_curves
        except Exception:
            try:
                from web.backend.neon_single import _to_curves
            except Exception:
                _to_curves = None
        subs = []
        for ls in r["paths"]:
            pts = [tuple(p) for p in np.asarray(ls.coords)]
            closed = bool(len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-6
                          and abs(pts[0][1] - pts[-1][1]) < 1e-6)
            if _to_curves is not None:
                st, segs = _to_curves(pts, closed=closed)
                if segs:
                    subs.append({"start": st, "segs": segs, "closed": closed})
                continue
            segs = [("L", p) for p in pts[1:]]
            if segs:
                subs.append({"start": pts[0], "segs": segs, "closed": closed})
        if not subs:
            return [], []
        # รายงานความเป็นไปได้จริง: ท่อกว้าง tube_mm ต้องมีเนื้อรองรับ tube+เผื่อข้างละ clear
        need = float(tube_mm) + 2.0 * float(clear_mm)
        report = []
        parts = [p for p in (full.geoms if full.geom_type == "MultiPolygon" else [full])
                 if p.geom_type == "Polygon" and not p.is_empty]
        parts.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))
        for i, pg in enumerate(parts):
            m2, ppm2, _o2 = geom_to_mask(pg, px_per_mm)
            w2 = stroke_width_mm(m2, ppm2)
            report.append({"idx": i + 1, "min_mm": round(w2, 1), "med_mm": round(w2, 1),
                           "ok": bool(w2 >= need), "mode": "center"})
        return subs, report
    except Exception:
        return [], []


def transformer_pick(watt):
    for w in (50, 75, 100, 150, 200, 350, 450):
        if watt <= w * 0.8:
            return w
    return 450
