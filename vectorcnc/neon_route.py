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
    ppm = max(float(px_per_mm), min(3000.0, float(max_px)) / _long)
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

    items = [list(c) for c in keep if len(c) >= 2]
    if not items:
        return []

    # ══════════════════════════════════════════════════════════════════════
    # 🔗 เชื่อมที่ 'จุดตัด' — หัวใจของความเนียน
    #
    # ⚠️ ของเดิมต่อได้เฉพาะปมที่มีเส้นมาชนพอดี 2 เส้น
    #    แต่ลายมือ/ตัวเขียนมีจุดไขว้ (X) และสามแฉก (Y) เต็มไปหมด
    #    ปมพวกนั้นเลยถูกปล่อยขาด -> เส้นถูกหั่นเป็นท่อนสั้น ๆ แล้วเกลาแยกกันคนละที
    #    ผลคือ 'ปลายเส้นไม่บรรจบกัน' (วัดจริงบนคำว่า Eleca bar: ห่างเฉลี่ย 3.15 มม.)
    #    ซึ่งคือสิ่งที่เห็นเป็นรอยสะดุด/หางแมวตรงจุดเชื่อมในภาพพรีวิว
    #
    # ✅ วิธีใหม่ 3 ชั้น:
    #    1) ปมที่อยู่ติด ๆ กันหลายพิกเซล -> ยุบเป็น 'ปมเดียว' แล้วดึงปลายทุกเส้นมาชนจุดนั้นเป๊ะ
    #    2) ที่ปมเดียวกัน จับคู่เส้นที่ 'พุ่งทะลุตรงกันที่สุด' (มุมตรงข้ามกันมากสุด) แล้วต่อเป็นเส้นเดียว
    #       -> จุดไขว้ X กลายเป็นเส้นตรง 2 เส้นวิ่งผ่านกัน เหมือนที่ช่างเดินท่อจริง
    #    3) เส้นที่จับคู่ไม่ได้ ก็ยังชนปมพอดี ไม่มีช่องว่างหลงเหลือ
    # ══════════════════════════════════════════════════════════════════════
    tol = max(1.8, 0.9 * ppm)              # ปมห่างกันไม่เกินนี้ = ปมเดียวกัน (มม. -> พิกเซล)

    def _cluster(its, t):
        """จัดกลุ่มปลายเส้นที่อยู่ตำแหน่งเดียวกัน -> (ends, P, groups)"""
        en = []
        for i, c in enumerate(its):
            en.append((i, 0, float(c[0][0]), float(c[0][1])))
            en.append((i, 1, float(c[-1][0]), float(c[-1][1])))
        Q = np.asarray([[e[2], e[3]] for e in en], dtype=float)
        par = list(range(len(en)))

        def _f(x):
            while par[x] != x:
                par[x] = par[par[x]]; x = par[x]
            return x

        def _u(x, y):
            rx, ry = _f(x), _f(y)
            if rx != ry:
                par[ry] = rx
        try:
            from scipy.spatial import cKDTree as _KD
            for x, y in _KD(Q).query_pairs(t):
                _u(x, y)
        except Exception:
            for x in range(len(Q)):
                for y in range(x + 1, len(Q)):
                    if abs(Q[x, 0] - Q[y, 0]) <= t and abs(Q[x, 1] - Q[y, 1]) <= t:
                        _u(x, y)
        gr = {}
        for k in range(len(en)):
            gr.setdefault(_f(k), []).append(k)
        return en, Q, gr

    # ── ชั้น 0: ยุบ 'สะพานสั้นระหว่างสองปม' — หัวใจของจุดไขว้ (X) ──
    #    เวลาลายเส้นสองเส้นตัดกันแบบเฉียง แกนกลางจะไม่ออกมาเป็นกากบาทจุดเดียว
    #    แต่เป็นสามแฉกสองอันเชื่อมด้วย 'สะพาน' สั้น ๆ ตรงกลาง
    #    ผลคือทั้งสองเส้นแย่งสะพานกัน มีแค่เส้นเดียวได้ทะลุ อีกเส้นถูกตัดขาดตรงนั้น
    #    (นี่คือรอยที่พี่วงตรงคานขวางของ ff ในคำว่า coffee)
    #    ✅ ยุบสะพานทิ้ง ให้ทั้ง 4 แขนมาเจอกันที่จุดเดียว แล้วค่อยจับคู่ทะลุตรง -> ผ่านได้ทั้งคู่
    #    ความยาวสะพาน = ประมาณ 'ความหนาลายเส้น' เพราะสะพานคือช่วงที่แกนกลางวิ่งอยู่ในเนื้อที่ทับกัน
    #    (spur_mm ถูกตั้งไว้ = ความหนา x 0.75 -> ย้อนกลับได้)
    bridge_px = max(3.0, spur_px / 0.75 * 3.2)
    for _round in range(3):
        _en, _Q, _gr = _cluster(items, tol)
        deg = {}
        for _g in _gr.values():
            for k in _g:
                deg[k] = len(_g)
        kof0 = {(_en[k][0], _en[k][1]): k for k in range(len(_en))}
        drop = set(); merge = []
        for i, c in enumerate(items):
            if len(c) > bridge_px:
                continue
            k0 = kof0.get((i, 0)); k1 = kof0.get((i, 1))
            if k0 is None or k1 is None:
                continue
            if deg.get(k0, 0) >= 3 and deg.get(k1, 0) >= 3:
                drop.add(i); merge.append((k0, k1))
        if not drop:
            break
        # ดึงปลายของ 'สองปมที่สะพานเชื่อมอยู่' มารวมเป็นจุดเดียวกัน แล้วทิ้งสะพาน
        _root = {}
        for r, v in _gr.items():
            for k in v:
                _root[k] = r
        _mp = {}
        for k0, k1 in merge:
            _mp.setdefault(_root[k0], set()).add(_root[k1])
            _mp.setdefault(_root[k1], set()).add(_root[k0])
        seen_r = set()
        for r0 in list(_mp):
            if r0 in seen_r:
                continue
            stack = [r0]; comp = set()
            while stack:
                r = stack.pop()
                if r in comp:
                    continue
                comp.add(r); seen_r.add(r)
                stack.extend(_mp.get(r, ()))
            ks = [k for r in comp for k in _gr[r]]
            cy = float(np.mean([_Q[k, 0] for k in ks]))
            cx = float(np.mean([_Q[k, 1] for k in ks]))
            for k in ks:
                i, side = _en[k][0], _en[k][1]
                if i in drop:
                    continue
                if side == 0:
                    items[i][0] = (cy, cx)
                else:
                    items[i][-1] = (cy, cx)
        items = [c for i, c in enumerate(items) if i not in drop]
        if not items:
            return []

    ends, P, groups = _cluster(items, tol)

    # ── ดึงปลายทุกเส้นมาชน 'จุดกลางปม' ให้ตรงกันเป๊ะ ──
    for _g in groups.values():
        if len(_g) < 2:
            continue
        cy = float(np.mean([P[k, 0] for k in _g]))
        cx = float(np.mean([P[k, 1] for k in _g]))
        for k in _g:
            i, side = ends[k][0], ends[k][1]
            if side == 0:
                items[i][0] = (cy, cx)
            else:
                items[i][-1] = (cy, cx)

    # ══════════════════════════════════════════════════════════════════
    # ชั้น 2: จับคู่ 'ทะลุตรง' ที่ปมเดียวกัน — เลือก 'ชุดที่ดีที่สุดทั้งปม' ไม่ใช่ทีละคู่
    #
    # ⚠️ บทเรียนจากภาพจริง (คำว่า coffee ตรงคานขวางของ ff):
    #    การไล่จับคู่ทีละคู่จากคะแนนดีสุด (greedy) ทำให้บางปมจับผิดเส้น —
    #    คู่ที่ดีที่สุด 'คู่เดียว' ไปกินปลายที่คู่อื่นต้องใช้ เหลือคู่ที่เหลือต้องจับมั่ว
    #    ✅ ปมหนึ่งมีปลายไม่กี่เส้น -> ลองทุกวิธีจับคู่แล้วเลือกชุดที่รวมแล้วดีที่สุดไปเลย
    #
    # ⚠️ บทเรียนที่ 2 (ห่วงเล็กของตัว E):
    #    ถ้าปล่อยให้ 'หัวกับท้ายของเส้นเดียวกัน' จับคู่กันเอง ห่วงจะกลายเป็นเกาะปิด
    #    ลอยอยู่ข้างเส้นหลัก ปลายท่อโผล่เป็นติ่ง — ของจริงช่างเดินท่อเข้าไปในห่วงแล้ววนออก
    #    ✅ ใส่ค่าปรับหนักให้การจับคู่ตัวเอง จะเลือกก็ต่อเมื่อไม่มีทางอื่นจริง ๆ
    # ══════════════════════════════════════════════════════════════════
    _wins = [max(2.0, 1.5 * ppm), max(3.0, 3.0 * ppm), max(5.0, 6.0 * ppm)]   # ดูทิศหลายระยะ

    def _dirs(i, side):
        """ทิศที่เส้นพุ่ง 'ออกจากปม' วัดหลายระยะ — ระยะสั้นไวต่อสัญญาณรบกวน ระยะยาวไวต่อความโค้ง"""
        c = np.asarray(items[i], dtype=float)
        seg = c if side == 0 else c[::-1]
        if len(seg) < 2:
            return [np.zeros(2)] * len(_wins)
        d = np.linalg.norm(np.diff(seg, axis=0), axis=1)
        s = np.concatenate([[0.0], np.cumsum(d)])
        out = []
        for w in _wins:
            j = int(np.searchsorted(s, min(w, s[-1])))
            j = min(max(j, 1), len(seg) - 1)
            v = seg[j] - seg[0]
            n = float(np.linalg.norm(v))
            out.append(v / n if n > 1e-9 else np.zeros(2))
        return out

    _dcache = {}

    def _cost(ka, kb):
        """ต้นทุนการต่อ: 0 = วิ่งทะลุตรงเป๊ะ · 2 = หักกลับทางเดิม

        ⚠️ **ห้ามคืน None เด็ดขาด** — นี่คือกุญแจที่ทำให้ใช้ได้กับทุกฟอนต์
           ของเดิมถ้ามุมหักเกินเกณฑ์จะ 'ไม่ต่อ' ผลคือปมที่มีแขนเลขคู่กลับเหลือปลายลอย
           ทั้งที่ตามทฤษฎีกราฟมันต้องจับคู่ได้ครบ -> เกิดรอยขาดกลางลายเส้น
           และเกณฑ์มุมที่ 'พอดี' กับฟอนต์หนึ่ง จะพังกับอีกฟอนต์เสมอ (ตั้งเท่าไหร่ก็ไม่ครบ 100%)
        ✅ เปลี่ยนเป็น 'ค่าปรับ' แทน 'ข้อห้าม' — มุมหักแรงก็ยังต่อได้ แต่เป็นทางเลือกสุดท้าย
           ตัวเลือกว่าจะจับคู่ไหนยังใช้มุมตัดสินเหมือนเดิม แค่ไม่ปล่อยให้เหลือปลายลอยโดยไม่จำเป็น
        """
        ia, sa = ends[ka][0], ends[ka][1]
        ib, sb = ends[kb][0], ends[kb][1]
        if ia == ib and sa == sb:
            return None                      # ปลายเดียวกันเป๊ะ — ไม่ใช่คู่
        for k, (i, s) in ((ka, (ia, sa)), (kb, (ib, sb))):
            if k not in _dcache:
                _dcache[k] = _dirs(i, s)
        va, vb = _dcache[ka], _dcache[kb]
        dd = [float(np.dot(va[t], vb[t])) for t in range(len(_wins))]
        m = sum(dd) / len(dd)
        c = 1.0 + m                          # 0 = ทะลุตรง · 2 = หักกลับทางเดิม
        if m > -0.20:
            c += 5.0                         # ⚠️ หักศอก — ยอมได้ แต่ต้องเป็นทางเลือกสุดท้าย
        if ia == ib:
            c += 1.0                         # 🚫 ค่าปรับ 'จับคู่ตัวเอง' (กันห่วงกลายเป็นเกาะปิด)
        return c

    def _best_match(keys):
        """จับคู่แขนในปมนี้ให้ 'ครบมากที่สุดเท่าที่เป็นไปได้' แล้วค่อยเลือกชุดที่เนียนที่สุด

        📐 หลักที่ใช้ (ทฤษฎีกราฟ — จริงกับทุกฟอนต์ ไม่ต้องจูนค่า):
           ปมที่มีแขน 'เลขคู่'  -> จับคู่ได้ครบ ไม่เหลือปลายลอยเลย
           ปมที่มีแขน 'เลขคี่'  -> เหลือปลายลอยได้ 1 เส้นเท่านั้น (เลี่ยงไม่ได้จริง ๆ)
           ปลายลอยที่เกินจากนี้ = รอยขาดที่เราทำหล่นเอง ไม่ใช่รูปทรงของตัวอักษร
        """
        allow = {}
        for _a in range(len(keys)):
            for _b in range(_a + 1, len(keys)):
                c = _cost(keys[_a], keys[_b])
                if c is not None:
                    allow[(keys[_a], keys[_b])] = c
                    allow[(keys[_b], keys[_a])] = c
        best = [0, 0.0, []]

        def rec(rem, pairs, tot):
            if len(rem) < 2:
                if len(pairs) > best[0] or (len(pairs) == best[0] and tot < best[1] - 1e-12):
                    best[0] = len(pairs); best[1] = tot; best[2] = list(pairs)
                return
            a = rem[0]; rest = rem[1:]
            rec(rest, pairs, tot)                       # ทางเลือก: ไม่จับคู่ a
            for b in rest:
                c = allow.get((a, b))
                if c is None:
                    continue
                pairs.append((a, b))
                rec([q for q in rest if q != b], pairs, tot + c)
                pairs.pop()
        rec(list(keys), [], 0.0)
        return best[2]

    partner = {}
    for _g in groups.values():
        if len(_g) < 2:
            continue
        if len(_g) <= 8:
            pr = _best_match(_g)
        else:                                # ปมใหญ่ผิดปกติ -> ถอยไปไล่ทีละคู่ (กันเวลาบาน)
            cand = sorted(((c, a, b) for a in _g for b in _g if a < b
                           for c in [_cost(a, b)] if c is not None), key=lambda t: t[0])
            pr = []; seen = set()
            for c, a, b in cand:
                if a in seen or b in seen:
                    continue
                seen.add(a); seen.add(b); pr.append((a, b))
        for ka, kb in pr:
            partner[ka] = kb; partner[kb] = ka

    # ── ชั้น 3: เดินตามคู่ที่จับได้ ร้อยเป็นเส้นยาว ──
    kof = {(ends[k][0], ends[k][1]): k for k in range(len(ends))}
    used = [False] * len(items)
    out = []

    def _walk(i0, side0):
        """เริ่มจากปลาย (i0,side0) ที่เป็น 'ต้นทาง' แล้วไล่ต่อไปจนสุด"""
        seq = []
        i, side = i0, side0
        while True:
            if used[i]:
                break
            used[i] = True
            c = items[i] if side == 0 else items[i][::-1]
            seq = (seq + c[1:]) if seq else list(c)
            k = kof.get((i, 1 - side))
            nk = partner.get(k) if k is not None else None
            if nk is None:
                break
            ni, ns = ends[nk][0], ends[nk][1]
            if used[ni]:
                break
            i, side = ni, ns
        return seq

    for k in range(len(ends)):             # เริ่มจาก 'ปลายอิสระ' ก่อน (เส้นเปิด)
        if k in partner:
            continue
        i, side = ends[k][0], ends[k][1]
        if used[i]:
            continue
        s = _walk(i, side)
        if len(s) >= 2:
            out.append(s)
    for i in range(len(items)):            # ที่เหลือคือวงปิด — เริ่มจากจุดไหนก็ได้
        if not used[i]:
            s = _walk(i, 0)
            if len(s) >= 2:
                out.append(s)
    return out if out else items


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


def snap_to_outline(line, geom, tree=None, pts=None, max_shift_mm=None):
    """🎯 ดึงเส้นให้ไปอยู่ 'กลางเนื้อ' พอดี โดยอ้างจาก **ขอบเส้นเวกเตอร์จริง** ไม่ใช่พิกเซล

    ไอเดีย: แกนกลางจากภาพให้ 'ทาง' ที่ถูก แต่ตำแหน่งกระเพื่อมตามบันไดพิกเซล
            ส่วนขอบตัวอักษรเป็นเส้นโค้งเวกเตอร์ที่เนียนอยู่แล้ว 100%
    วิธี:   ทุกจุดบนเส้น หา 'ขอบสองฝั่งที่ตรงข้ามกัน' แล้วย้ายจุดไปไว้กึ่งกลางของสองฝั่งนั้น
            -> จุดกึ่งกลางของเส้นโค้งเนียนสองเส้น ย่อมเนียนตามไปด้วย
            -> ได้ทั้งความเนียนของเวกเตอร์ และความถูกต้องของแกนกลาง
    """
    try:
        from scipy.spatial import cKDTree
    except Exception:
        return line
    a = np.asarray(line.coords, dtype=float)
    if len(a) < 3 or tree is None or pts is None:
        return line
    d = np.diff(a, axis=0)
    t = np.vstack([d[:1], (d[:-1] + d[1:]) * 0.5, d[-1:]])
    n = np.linalg.norm(t, axis=1, keepdims=True)
    t = t / np.where(n > 1e-9, n, 1.0)
    nrm = np.column_stack([-t[:, 1], t[:, 0]])            # เวกเตอร์ตั้งฉากกับแนวเส้น
    k = min(16, len(pts))
    dist, idx = tree.query(a, k=k)
    out = a.copy()
    lim = float(max_shift_mm) if max_shift_mm else 1e9
    for i in range(len(a)):
        ii = idx[i] if k > 1 else [idx[i]]
        v = pts[ii] - a[i]
        s = v @ nrm[i]                                     # ระยะตามแนวตั้งฉาก (บวก/ลบ = คนละฝั่ง)
        dd = dist[i] if k > 1 else [dist[i]]
        pos = [j for j in range(len(ii)) if s[j] > 1e-6]
        neg = [j for j in range(len(ii)) if s[j] < -1e-6]
        if not pos or not neg:
            continue
        jp = min(pos, key=lambda j: dd[j])
        jn = min(neg, key=lambda j: dd[j])
        mid = (pts[ii[jp]] + pts[ii[jn]]) * 0.5
        if np.hypot(*(mid - a[i])) <= lim:
            out[i] = mid
    # 🔒 ปลายเส้น = จุดที่ไปบรรจบกับเส้นอื่น — ห้ามขยับเด็ดขาด
    #    ตรงปลาย/จุดตัด ขอบทั้งสองฝั่งจะสับสน (มีขอบของเส้นอื่นปนเข้ามา) จุดกึ่งกลางที่คำนวณได้จะเพี้ยน
    #    จึงหรี่แรงดึงลงเหลือ 0 ที่ปลายทั้งสองข้าง แบบไล่ระดับ (ไม่ให้เกิดหักมุมตรงรอยต่อ)
    _n9 = len(a)
    _k9 = max(2, min(_n9 // 3, int(np.ceil(_n9 * 0.06)) + 2))
    w = np.ones(_n9)
    _r9 = np.linspace(0.0, 1.0, _k9 + 1)[1:]
    w[:_k9] = _r9
    w[-_k9:] = _r9[::-1]
    out = a + (out - a) * w[:, None]
    # เกลาเบา ๆ กันจุดกระตุกตรงที่หาคู่ขอบไม่เจอ
    if len(out) >= 5:
        sm = out.copy()
        sm[1:-1] = 0.5 * out[1:-1] + 0.25 * out[:-2] + 0.25 * out[2:]
        sm[0] = out[0]; sm[-1] = out[-1]
        out = sm
    return LineString(out)


def _end_dir(a, side, win_mm=3.0):
    """ทิศที่เส้นพุ่ง 'ออกไปจากปลาย' — ใช้ตัดสินว่าสองเส้นวิ่งชนกันตรง ๆ หรือหักศอก"""
    seg = a[:1] if len(a) < 2 else (a if side == 1 else a[::-1])
    d = np.linalg.norm(np.diff(seg, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(d)])
    j = int(np.searchsorted(s, max(0.0, s[-1] - win_mm)))
    j = min(max(j, 0), len(seg) - 2)
    v = seg[-1] - seg[j]
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else np.zeros(2)


def stitch_ends(lines, tol_mm, dot_max=-0.10):
    """🪡 เย็บปลายเส้นขั้นสุดท้าย — 'จุดเชื่อมต้องตรงและชนกันเป๊ะ'

    ผ่านทุกขั้นตอนเกลาแล้วยังอาจเหลือปลายที่ควรเป็นจุดเดียวกันแต่คลาดกันนิดหน่อย
    (จุดสามแฉกที่เนื้อหนา แกนกลางจะแตกตัวกว้างกว่าที่จับกลุ่มไว้ตอนพิกเซล)
    ขั้นนี้จึงตรวจอีกรอบบน 'เส้นจริงหน่วยมิลลิเมตร':
      • คู่ที่วิ่งทะลุเข้าหากัน -> ต่อเป็นเส้นเดียว (ช่างเดินท่อรวดเดียว ไม่ต้องตัดต่อ)
      • คู่ที่หักศอก -> อย่างน้อยดึงให้ 'ชนจุดเดียวกันเป๊ะ' ไม่ให้เหลือรอยห่าง
    """
    segs = [np.asarray(l.coords, dtype=float) for l in lines
            if l is not None and not l.is_empty and len(l.coords) >= 2]
    if len(segs) < 2:
        return [LineString(s) for s in segs]
    ends = [(i, s) for i in range(len(segs)) for s in (0, 1)]
    P = np.asarray([segs[i][0] if s == 0 else segs[i][-1] for i, s in ends])

    # ── หาคู่ปลายที่ใกล้กันพอจะเป็นจุดเดียวกัน ──
    try:
        from scipy.spatial import cKDTree as _KD
        pairs = list(_KD(P).query_pairs(tol_mm))
    except Exception:
        pairs = [(x, y) for x in range(len(P)) for y in range(x + 1, len(P))
                 if float(np.hypot(*(P[x] - P[y]))) <= tol_mm]
    cand = []
    for x, y in pairs:
        ix, sx = ends[x]; iy, sy = ends[y]
        if ix == iy and sx == sy:
            continue
        d = float(np.hypot(*(P[x] - P[y])))
        dot = float(np.dot(_end_dir(segs[ix], sx), _end_dir(segs[iy], sy)))
        cand.append((d + dot * tol_mm, d, dot, x, y))     # ใกล้ + ตรง = คะแนนดี
    cand.sort(key=lambda t: t[0])

    used = set(); link = {}; weld = []
    for _sc, d, dot, x, y in cand:
        if x in used or y in used:
            continue
        used.add(x); used.add(y)
        if dot <= dot_max and ends[x][0] != ends[y][0]:
            link[x] = y; link[y] = x                       # ต่อเป็นเส้นเดียว
        else:
            weld.append((x, y))                            # แค่ดึงมาชนจุดเดียวกัน

    # ── ดึงคู่ที่ต่อไม่ได้ให้ชนจุดเดียวกันเป๊ะ ──
    for x, y in weld:
        m = (P[x] + P[y]) * 0.5
        for k in (x, y):
            i, s = ends[k]
            if s == 0:
                segs[i][0] = m
            else:
                segs[i][-1] = m

    # ── ร้อยคู่ที่ต่อได้ให้เป็นเส้นเดียว ──
    kof = {(i, s): k for k, (i, s) in enumerate(ends)}
    done = [False] * len(segs)
    out = []
    for k0 in range(len(ends)):
        if k0 in link:
            continue
        i, s = ends[k0]
        if done[i]:
            continue
        acc = None
        while True:
            if done[i]:
                break
            done[i] = True
            a = segs[i] if s == 0 else segs[i][::-1]
            if acc is None:
                acc = a.copy()
            else:
                m = (acc[-1] + a[0]) * 0.5                 # จุดต่อ = กึ่งกลางของสองปลาย
                acc[-1] = m
                acc = np.vstack([acc, a[1:]])
            nk = link.get(kof[(i, 1 - s)])
            if nk is None:
                break
            ni, ns = ends[nk]
            if done[ni]:
                break
            i, s = ni, ns
        if acc is not None and len(acc) >= 2:
            out.append(acc)
    for i in range(len(segs)):                             # วงปิดที่ไม่มีปลายอิสระ
        if not done[i]:
            done[i] = True
            out.append(segs[i])
    return [LineString(s) for s in out if len(s) >= 2]





def open_tiny_loops(lines, tube_mm, clear_ratio=0.95):
    """🔁 ห่วงที่เล็กกว่าท่อ -> 'เดินผ่านตรงไป' แทนการวนรอบ

    ⚠️ นี่คือตำหนิที่เห็นด้วยตาแต่ตัววัดเดิมจับไม่ได้เลย:
       ตาของตัว e · ตัว o · ห่วงของ ff ในฟอนต์ลายมือ มักเล็กกว่าท่อนีออน
       แกนกลางจะวนเข้าไปในห่วงแล้วพับกลับออกมา ระยะห่างขาไป-ขากลับแค่ 1-2 มม.
       ท่อกว้าง 8 มม. สองขานั้นจึงทับกันสนิท กลายเป็น 'ก้อนทึบ' มีรอยตะเข็บ
       -> นี่คือติ่ง/ก้อนที่เห็นในตัว e, o และ ff ทุกตัว

    ของจริงช่างทำยังไง: ท่อดัดวนห่วงเล็กกว่ารัศมีดัดขั้นต่ำไม่ได้อยู่แล้ว
    ช่างจะ 'เดินท่อผ่านไปเลย' ไม่วนห่วง — ตาของตัวอักษรเกิดจากเส้นที่ไขว้กันเอง
    ✅ จึงตรวจว่าเส้นวกกลับมาใกล้ตัวเองในระยะสั้นไหม ถ้าใช่และห่วงนั้นแคบกว่าท่อ
       ให้ตัดช่วงที่วนออก แล้วต่อตรง — เกณฑ์คือ 'ท่อดัดเข้าไปได้จริงไหม' ใช้ได้ทุกฟอนต์
    """
    T = float(tube_mm)
    near = T * float(clear_ratio)              # ขาไป-ขากลับใกล้กว่านี้ = ท่อทับกันสนิท
    maxarc = T * math.pi * 6.0                 # เพดานกันไปแตะห่วงใหญ่ ๆ ของตัวอักษร
    out = []
    for l in lines:
        a = np.asarray(l.coords, dtype=float)
        if len(a) < 12:
            out.append(l); continue
        d = np.linalg.norm(np.diff(a, axis=0), axis=1)
        s = np.concatenate([[0.0], np.cumsum(d)])
        try:
            from scipy.spatial import cKDTree as _KD
            tree = _KD(a)
            pairs = sorted(tree.query_pairs(near))
        except Exception:
            out.append(l); continue
        cand = []
        for i, j in pairs:
            if j <= i:
                continue
            arc = s[j] - s[i]
            chord = float(np.linalg.norm(a[j] - a[i]))
            # 🔑 'ห่วงจริง' ต้องวกกลับมาหาตัวเอง = ทางเดินยาวกว่าระยะตรงหลายเท่า
            #    ถ้าไม่เช็คข้อนี้ ช่วงเส้นตรงธรรมดาจะถูกนับเป็นห่วงหมด (เจอจริง 9,928 จุดปลอม)
            if arc < max(T * 1.2, chord * 2.5):
                continue
            # 📏 ท่อจะวนห่วงนี้ได้ ต้องมีวงกลมขนาดท่อ 'ใส่เข้าไปในห่วง' ได้จริง
            #    ประเมินรัศมีในของห่วงด้วย 2 x พื้นที่ / เส้นรอบรูป (แม่นพอและเร็ว)
            ring = a[i:j + 1]
            if len(ring) < 4:
                continue
            per = float(np.sum(np.linalg.norm(np.diff(ring, axis=0), axis=1))) + \
                  float(np.linalg.norm(ring[0] - ring[-1]))
            x = ring[:, 0]; y = ring[:, 1]
            area = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) * 0.5
            inr = (2.0 * area / per) if per > 1e-9 else 0.0
            if inr >= T * 0.5:                 # ท่อใส่เข้าไปในห่วงได้ -> ห่วงจริง เก็บไว้
                continue
            if arc > maxarc:                   # ห่วงยาวเกินกว่าจะเป็นตาตัวอักษร -> ไม่แตะ
                continue
            cand.append((i, j, arc))
        if not cand:
            out.append(l); continue
        cand.sort(key=lambda t: (t[0], -t[2]))
        keep = np.ones(len(a), dtype=bool)
        last = -1
        for i, j, arc in cand:
            if i <= last:
                continue
            keep[i + 1:j] = False              # ตัดช่วงที่วนห่วงออก เหลือจุดต่อตรง
            last = j
        b = a[keep]
        if len(b) < 4:
            out.append(l); continue
        out.append(LineString(b))
    return out


def cut_impossible_bends(lines, tube_mm, max_turn_deg=100.0, span_mm=3.0):
    """✂️ ตัดเส้นตรงจุดที่ 'ท่อดัดไม่ได้จริง' — ต้นเหตุของติ่ง/ตะขอที่เห็นด้วยตา

    ⚠️ นี่คือจุดที่หลุดสายตามาตลอด: ตัววัดเดิมดูแค่ 'ท่อขาดกลางลายเส้น'
       แต่ตำหนิที่ตาเห็นจริงคือ 'เส้นหักกลับทางเดิม' (วัดได้ 176 องศาในระยะ 2 มม.)
       ท่อยังคลุมเนื้อครบ ตัววัดจึงบอกว่าผ่าน ทั้งที่ตามองเห็นเป็นตะขอชัด ๆ

    เกิดจาก: ตอนจับคู่แขนที่ปม เรายอมให้จับคู่ได้ทุกกรณีเพื่อไม่ให้เหลือปลายลอย
             ถ้าบังเอิญจับคู่แขนสองเส้นที่พุ่งไปทางเดียวกัน เส้นจะพับกลับทันที
    แก้: ท่อนีออนซิลิโคนดัดกลับ 180 องศาในระยะ 3 มม. ไม่ได้อยู่แล้วในความเป็นจริง
         -> ตัดเส้นตรงนั้นเป็นสองท่อน เนื้อยังคลุมครบเท่าเดิม แต่ติ่งหายไป
    """
    out = []
    lim = float(max_turn_deg)
    for l in lines:
        a = np.asarray(l.coords, dtype=float)
        if len(a) < 5:
            out.append(l); continue
        d = np.linalg.norm(np.diff(a, axis=0), axis=1)
        s = np.concatenate([[0.0], np.cumsum(d)])
        if s[-1] < span_mm * 3:
            out.append(l); continue
        cut = []
        for i in range(1, len(a) - 1):
            j0 = int(np.searchsorted(s, max(0.0, s[i] - span_mm)))
            j1 = int(np.searchsorted(s, min(s[-1], s[i] + span_mm)))
            if j0 >= i or j1 <= i:
                continue
            v1 = a[i] - a[j0]; v2 = a[j1] - a[i]
            n1 = np.linalg.norm(v1); n2 = np.linalg.norm(v2)
            if n1 < 1e-9 or n2 < 1e-9:
                continue
            c = float(np.dot(v1, v2) / (n1 * n2))
            if np.degrees(np.arccos(max(-1.0, min(1.0, c)))) > lim:
                cut.append(i)
        if not cut:
            out.append(l); continue
        merged = []                       # รวมจุดตัดที่ติดกันให้เป็นจุดเดียว
        for i in cut:
            if merged and i - merged[-1][-1] <= 3:
                merged[-1].append(i)
            else:
                merged.append([i])
        idx = [int(np.mean(m)) for m in merged]
        prev = 0
        for i in idx:
            if i - prev >= 3:
                out.append(LineString(a[prev:i + 1]))
            prev = i
        if len(a) - prev >= 3:
            out.append(LineString(a[prev:]))
    return [l for l in out if l.length > 0.5]


def _respline(line, keep_mm=0.35):
    """เกลาทั้งเส้นอีกรอบหลังต่อเสร็จ — ปลายล็อกอยู่กับที่ ไม่ขยับ

    ใช้หลังการต่อเส้นเท่านั้น: ตอนต่อ สองท่อนมาชนกันเป็น 'มุม'
    การฟิตสไปลน์ทั้งเส้นทีเดียวจะกลืนมุมนั้นให้เป็นโค้งต่อเนื่อง
    โดยยอมให้เส้นคลาดจากเดิมได้ไม่เกิน keep_mm (เล็กมาก) รูปทรงจึงไม่เปลี่ยน
    """
    a = np.asarray(line.coords, dtype=float)
    if len(a) < 8:
        return line
    closed = bool(np.hypot(*(a[0] - a[-1])) < 1e-6)
    try:
        from scipy.interpolate import splprep, splev
        pts = a[:-1] if (closed and len(a) > 8) else a
        if len(pts) < 8:
            return line
        s = len(pts) * float(keep_mm) ** 2
        tck, u = splprep([pts[:, 0], pts[:, 1]], s=s, k=3, per=1 if closed else 0)
        n = max(48, min(4000, int(line.length / max(0.35, keep_mm))))
        x, y = splev(np.linspace(0, 1, n), tck)
        out = np.column_stack([x, y])
        if closed:
            out[-1] = out[0]
        else:
            out[0] = a[0]; out[-1] = a[-1]
        return LineString(out)
    except Exception:
        return line


def trim_thin_ends(lines, dt, ppm, org, tube_mm, keep_ratio=0.80, max_trim_mm=None, geom_ref=None):
    """✂️ ตัดปลายท่อที่ไปโผล่ตรง 'หางลายเส้นที่เรียวกว่าท่อ'

    ทำไม: ท่อนีออนกว้างคงที่ ถ้าหางตัวอักษรเรียวเหลือ 4 มม. แต่ท่อกว้าง 8 มม.
          ท่อจะล้นออกนอกตัวอักษรเป็นติ่ง — นี่คือ 'หางแมว' ที่เห็นตรงปลายเส้น
    ของจริงช่างจะหยุดท่อตรงจุดที่ลายเส้นยังกว้างพอ ไม่ลากจนสุดปลายแหลม
    ✅ วัดความหนาลายเส้น ณ จุดนั้นจริง ๆ (จาก distance transform) แล้วถอยปลายกลับมา
       จนถึงจุดที่ลายเส้นยังกว้างอย่างน้อย 80% ของท่อ — เป็นกฎเดียวใช้ได้ทุกฟอนต์
       เพราะอ้างจาก 'ความหนาจริงของลายเส้นตรงนั้น' ไม่ใช่ตัวเลขที่ตั้งไว้ล่วงหน้า
    """
    if dt is None:
        return lines
    H, W = dt.shape
    need = float(tube_mm) * float(keep_ratio)
    lim = float(max_trim_mm) if max_trim_mm else float(tube_mm) * 2.0

    def wmm(p):
        x = int(round((p[0] - org[0]) * ppm)); y = int(round((p[1] - org[1]) * ppm))
        if x < 0 or y < 0 or x >= W or y >= H:
            return 0.0
        return float(dt[y, x]) * 2.0 / ppm

    from shapely.geometry import Point as _P
    R = float(tube_mm) * 0.5

    def _over(a, i, j):
        """หัวท่อ 'ยื่นเลยปลายลายเส้น' ไหม — วัดที่ปลายสุดของหัวท่อกลม

        กติกานี้แยกสองเรื่องออกจากกันได้พอดี:
          • ท่อล้นออก 'ด้านข้าง' เพราะกว้างกว่าลายเส้น = เรื่องปกติ ไม่ต้องแก้
          • ท่อล้นออก 'ตามยาว' เลยจุดจบของลายเส้น = ติ่งที่ต้องตัด
        """
        if geom_ref is None:
            return False
        v = a[i] - a[j]
        n = float(np.linalg.norm(v))
        if n < 1e-9:
            return False
        z = a[i] + v / n * R
        return not geom_ref.contains(_P(float(z[0]), float(z[1])))

    out = []
    for l in lines:
        a = np.asarray(l.coords, dtype=float)
        if len(a) < 4 or np.hypot(*(a[0] - a[-1])) < 1e-6:
            out.append(l); continue
        d = np.linalg.norm(np.diff(a, axis=0), axis=1)
        s = np.concatenate([[0.0], np.cumsum(d)])
        i0 = 0
        while i0 < len(a) - 3 and s[i0] < lim and (wmm(a[i0]) < need or _over(a, i0, min(i0 + 3, len(a) - 1))):
            i0 += 1
        i1 = len(a) - 1
        while i1 > i0 + 3 and (s[-1] - s[i1]) < lim and (wmm(a[i1]) < need or _over(a, i1, max(i1 - 3, 0))):
            i1 -= 1
        b = a[i0:i1 + 1]
        out.append(LineString(b) if len(b) >= 2 else l)
    return out


def close_visible_gaps(lines, geom, tube_mm, max_ext_mm=None, step_mm=0.4, dt=None, ppm=1.0, org=(0.0, 0.0)):
    """🩹 ด่านสุดท้าย — 'ไม่ให้มีปลายท่อโผล่กลางลายเส้น' ไม่ว่าฟอนต์ไหน

    ทำไมต้องมีด่านนี้ทั้งที่จับคู่ที่ปมไปแล้ว:
      การจับคู่ทำงานบน 'กราฟของแกนกลาง' ซึ่งดีมาก แต่ยังมีเศษที่หลุดรอดได้อีก 3 ทาง
        1) ปมสามแฉก (เลขคี่) — ทางทฤษฎีต้องเหลือปลาย 1 เส้นเสมอ เลี่ยงไม่ได้
        2) ท่อนสั้นกว่าเกณฑ์ถูกคัดทิ้ง ปลายของเพื่อนบ้านเลยโผล่แทน
        3) หนวดที่ถูกตัด ทำให้ปลายจริงขยับเข้ามาจากขอบลายเส้น
      ทั้งสามทางนี้ 'จูนค่าให้ครบทุกฟอนต์ไม่ได้' เพราะเป็นคนละสาเหตุกัน

    ✅ จึงไม่จูนอีกต่อไป — เปลี่ยนเป็น **ตรวจผลลัพธ์จริงแล้วซ่อม**:
       ปลายไหนยังโผล่อยู่ (ไม่ได้ฝังในท่อเส้นอื่น) ให้ 'เดินต่อไปตามแนวสัมผัส'
       จนกว่าจะชนท่อของเส้นข้างเคียง — เหมือนที่ช่างลากท่อจนชนเส้นถัดไปพอดี
       โดยห้ามเดินออกนอกเนื้อลายเส้นเด็ดขาด (ยื่นเกินตัวอักษรไม่ได้)
    เกณฑ์นี้วัดจากผลลัพธ์ ไม่ได้ผูกกับฟอนต์ จึงใช้ได้เหมือนกันหมดทุกตัว
    """
    segs = [np.asarray(l.coords, dtype=float) for l in lines
            if l is not None and not l.is_empty and len(l.coords) >= 2]
    if not segs:
        return lines
    T = float(tube_mm); R = T * 0.5
    ext = float(max_ext_mm) if max_ext_mm else T * 3.5
    _H = _W = 0
    if dt is not None:
        _H, _W = dt.shape

    def _wmm(p):
        """ความหนาลายเส้นจริง ณ จุดนั้น (มม.) — ใช้ตัดสินว่า 'ตรงนี้วางท่อได้ไหม'"""
        if dt is None:
            return 1e9
        x = int(round((p[0] - org[0]) * ppm)); y = int(round((p[1] - org[1]) * ppm))
        if x < 0 or y < 0 or x >= _W or y >= _H:
            return 0.0
        return float(dt[y, x]) * 2.0 / ppm
    from shapely.geometry import Point as _Pt
    from shapely.strtree import STRtree
    for _round in range(2):
        tubes = [LineString(s).buffer(R, cap_style=1, join_style=1) for s in segs]
        try:
            tree = STRtree(tubes)
        except Exception:
            tree = None
        moved = 0
        for i in range(len(segs)):
            a = segs[i]
            if np.hypot(*(a[0] - a[-1])) < 1e-6:
                continue                                  # วงปิด ไม่มีปลาย
            for side in (0, 1):
                p = a[0] if side == 0 else a[-1]
                q = a[min(4, len(a) - 1)] if side == 0 else a[max(-5, -len(a))]
                pt = _Pt(float(p[0]), float(p[1]))
                if tree is not None:
                    hit = any(int(j) != i and tubes[int(j)].contains(pt)
                              for j in tree.query(pt))
                else:
                    hit = any(j != i and tubes[j].contains(pt) for j in range(len(tubes)))
                if hit:
                    continue                              # ฝังในท่อเส้นอื่นแล้ว = มองไม่เห็น
                v = p - q
                n = float(np.linalg.norm(v))
                if n < 1e-9:
                    continue
                v = v / n
                best = None
                d = step_mm
                while d <= ext:
                    z = p + v * d
                    zp = _Pt(float(z[0]), float(z[1]))
                    if not geom.contains(zp):             # 🚧 ห้ามยื่นออกนอกเนื้อตัวอักษร
                        break
                    if _wmm(z) < T * 0.75:                # 🚧 ลายเส้นเรียวกว่าท่อ -> วางท่อตรงนั้นไม่ได้จริง
                        break
                    if tree is not None:
                        ok = any(int(j) != i and tubes[int(j)].contains(zp)
                                 for j in tree.query(zp))
                    else:
                        ok = any(j != i and tubes[j].contains(zp) for j in range(len(tubes)))
                    if ok:
                        best = z
                        break
                    d += step_mm
                if best is not None:
                    if side == 0:
                        segs[i] = np.vstack([best[None, :], a])
                    else:
                        segs[i] = np.vstack([a, best[None, :]])
                    a = segs[i]; moved += 1
        if not moved:
            break
    return [LineString(s) for s in segs if len(s) >= 2]


def outline_points(geom, step_mm=0.35):
    """สุ่มจุดบน 'ขอบเวกเตอร์' ให้ถี่ — ใช้เป็นตัวอ้างอิงตอนดึงเส้นเข้ากลาง"""
    out = []
    for g in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom]):
        if g.geom_type != "Polygon":
            continue
        for ring in [g.exterior] + list(g.interiors):
            c = np.asarray(ring.coords, dtype=float)
            if len(c) < 2:
                continue
            seg = np.linalg.norm(np.diff(c, axis=0), axis=1)
            for i, L in enumerate(seg):
                m = max(1, int(np.ceil(L / step_mm)))
                for j in range(m):
                    out.append(c[i] + (c[i + 1] - c[i]) * (j / m))
    return np.asarray(out) if out else None


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
    if len(a) < 5:            # 🛡️ เส้นสั้นมาก (สั้นกว่า 5 มม.) — คลายไม่ได้และไม่จำเป็น
        return line           #    (np.convolve โหมด same คืนความยาวเท่าเคอร์เนลถ้าสัญญาณสั้นกว่า -> รูปทรงไม่ตรงกัน)
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
def neon_paths(geom, tube_mm=None, px_per_mm=4.0, spur_ratio=0.75, bend_ratio=1.5,
               snap=True):
    """คืน dict: paths (LineString มม.), tube_mm, length_m, watt, plate (Polygon)"""
    mask, ppm, org = geom_to_mask(geom, px_per_mm)
    sw = stroke_width_mm(mask, ppm)
    tube = float(tube_mm) if tube_mm else max(6.0, min(15.0, round(sw * 0.8)))
    sk = skeleton(mask)
    chains, nodes = trace_chains(sk)
    items = prune_and_join(chains, nodes, ppm, spur_mm=max(sw, 2.0) * spur_ratio)
    r_min = tube * bend_ratio
    # 🎯 ตัวอ้างอิง 'ขอบเวกเตอร์' — เตรียมครั้งเดียว ใช้ดึงทุกเส้นเข้ากลาง
    _tree = _opts = None
    if snap:
        try:
            from scipy.spatial import cKDTree
            _opts = outline_points(geom, step_mm=max(0.2, 0.5 / max(ppm, 1e-6) * 2))
            if _opts is not None and len(_opts) > 8:
                _tree = cKDTree(_opts)
        except Exception:
            _tree = _opts = None
    lines = []
    for c in items:
        ls = chain_to_line(c, ppm, org)
        if ls is None:
            continue
        if _tree is not None:
            ls = snap_to_outline(ls, geom, _tree, _opts, max_shift_mm=max(sw, 2.0))
            ls = ls.simplify(0.15)
        lines.append(relax_tight_bends(ls, r_min))
    # 🪡 เย็บปลายขั้นสุดท้ายก่อนค่อยคัดเศษทิ้ง — ท่อนสั้นที่เป็นสะพานเชื่อมจะได้ถูกดูดรวมไป
    #    ไม่ใช่ถูกโยนทิ้งจนเหลือช่องโหว่ตรงจุดต่อ (นี่คือที่มาของ 'เส้นขาดตรงรอยต่อ' แบบเดิม)
    #    เย็บซ้ำ 3 รอบ: รอบแรกจับได้คู่ที่ดีที่สุดก่อน คู่ที่ถูกเบียดตกไปจะได้โอกาสในรอบถัดไป
    for _ in range(3):
        _n0 = len(lines)
        lines = stitch_ends(lines, tol_mm=max(tube * 0.9, sw * 0.45))
        if len(lines) == _n0:
            break
    lines = [l for l in lines if l.length >= max(8.0, tube * 1.5)]
    # ══════════════════════════════════════════════════════════════════
    # 🎯 'เกลารอยต่อ' — จุดที่ยังเห็นเป็นมุมแหลมอยู่ เกิดจากลำดับการทำงาน ไม่ใช่การจับคู่ผิด
    #
    # ⚠️ ของเดิม: เกลาเส้น -> ดึงเข้ากลางเนื้อ -> **แล้วค่อยต่อเส้น**
    #    แปลว่า 'ช่วงรอยต่อ' ไม่เคยผ่านการดึงเข้ากลางเนื้อเลยสักครั้ง
    #    สองท่อนจึงมาชนกันเป็นมุมแหลม (เห็นชัดที่ห่วงตัว e และคานขวางของ ff)
    # ✅ พอต่อเสร็จแล้ว 'ดึงเข้ากลางเนื้อ + เกลาซ้ำอีกรอบทั้งเส้น'
    #    รอยต่อจะถูกจัดให้อยู่กลางลายเส้นพอดีและโค้งต่อเนื่อง เหมือนเส้นเดียวมาแต่แรก
    if _tree is not None:
        _sm = []
        for l in lines:
            try:
                q = snap_to_outline(l, geom, _tree, _opts, max_shift_mm=max(sw, 2.0) * 0.6)
                q = _respline(q, keep_mm=max(0.30, sw * 0.06))
                _sm.append(q if (q is not None and q.length > 1.0) else l)
            except Exception:
                _sm.append(l)
        lines = _sm
    # ══════════════════════════════════════════════════════════════════
    # 🔎 ด่านตรวจ-ซ่อมขั้นสุดท้าย — 'ตรวจผลลัพธ์จริง' ไม่ใช่จูนค่าเผื่อฟอนต์
    #    เกณฑ์ทั้งหมดต่อไปนี้วัดจากตัวงานที่ออกมาเทียบกับรูปตัวอักษรจริง
    #    จึงใช้ได้เหมือนกันทุกฟอนต์ ไม่มีตัวเลขที่ต้องตั้งใหม่ต่อฟอนต์เลย
    #      1) ปลายท่อล้นออกนอกลายเส้น (หางเรียวกว่าท่อ) -> ถอยปลายกลับ
    #      2) ท่อขาดกลางลายเส้น            -> ยืดปลายไปชนท่อข้างเคียง
    #      3) หักศอกที่รอยต่อ (เกิดใหม่หลังต่อเส้น) -> คลายอีกรอบ
    # ══════════════════════════════════════════════════════════════════
    _dt = None
    try:
        _dt = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
        lines = trim_thin_ends(lines, _dt, ppm, org, tube, geom_ref=geom)
    except Exception:
        _dt = None
    try:
        lines = close_visible_gaps(lines, geom, tube, max_ext_mm=max(tube * 3.5, sw * 3.5),
                                   dt=_dt, ppm=ppm, org=org)
    except Exception:
        pass
    try:
        lines = [relax_tight_bends(l, r_min) for l in lines]
    except Exception:
        pass
    #      4) ห่วงที่เล็กกว่าท่อ (ตาของตัว e/o/ff) -> เดินผ่านตรงไป ไม่วน
    try:
        lines = open_tiny_loops(lines, tube)
        lines = [_respline(l, keep_mm=max(0.30, sw * 0.06)) for l in lines]
    except Exception:
        pass
    #      5) 'ติ่ง/ตะขอ' — เส้นหักกลับทางเดิมจนท่อดัดไม่ได้จริง -> ตัดแยกเป็นสองท่อน
    try:
        lines = cut_impossible_bends(lines, tube)
        lines = [l for l in lines if l.length >= max(6.0, tube * 1.2)]
    except Exception:
        pass
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
        # ══════════════════════════════════════════════════════════════
        # 📏 เลือกความกว้างท่อ 'ตามความหนาลายเส้นจริง' — นี่คือกุญแจที่ทำให้ครบทุกฟอนต์
        #
        # ⚠️ ที่ยังเหลือตำหนิในฟอนต์หนา (Caveat Brush · Pacifico · Kaushan) ไม่ใช่บั๊กของตัวหาแกนกลาง
        #    แต่เป็นเรื่องกายภาพ: ลายเส้นหนา 19 มม. จะเอาท่อ 8 มม. ไปวางให้เต็มไม่ได้จริง ๆ
        #    วัดแล้ว: ท่อ 8 มม. -> ตำหนิ 8 จุด · ท่อ 15 มม. (ตามลายเส้น) -> 0 จุด บนฟอนต์เดียวกัน
        # ✅ จึงวัดความหนาลายเส้นก่อน แล้วขยับท่อขึ้นให้พอดีถ้าท่อที่ขอมาเล็กเกินไป
        #    แล้ว 'บอกผู้ใช้' ว่าเปลี่ยนให้เพราะอะไร ไม่เงียบ ๆ เปลี่ยนเอง
        _tube_req = float(tube_mm or 0.0)
        _tube_use = _tube_req
        _note = None
        try:
            _mk, _pp, _og = geom_to_mask(full, px_per_mm, max_px=900.0)
            _sw = stroke_width_mm(_mk, _pp)
            if _sw > 0 and _tube_req > 0 and _tube_req < _sw * 0.62:
                _tube_use = max(6.0, min(20.0, round(_sw * 0.80)))
                _note = ("🔦 ลายเส้นหนา %.1f มม. — ท่อ %.0f มม. ที่เลือกไว้เล็กเกินไป "
                         "ระบบใช้ท่อ %.0f มม. แทนเพื่อให้ไฟเต็มลายเส้น "
                         "(ถ้าต้องการท่อ %.0f มม. จริง ๆ ให้เลือกแบบเส้นคู่ หรือย่อขนาดป้ายลง)"
                         % (_sw, _tube_req, _tube_use, _tube_req))
        except Exception:
            _tube_use = _tube_req
        r = neon_paths(full, tube_mm=_tube_use, px_per_mm=px_per_mm)
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
        need = float(_tube_use) + 2.0 * float(clear_mm)
        report = []
        parts = [p for p in (full.geoms if full.geom_type == "MultiPolygon" else [full])
                 if p.geom_type == "Polygon" and not p.is_empty]
        parts.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))
        for i, pg in enumerate(parts):
            # ⏱️ รายงานนี้ต้องการแค่ 'ความหนาโดยประมาณ' -> วาดภาพเล็ก ๆ พอ
            #    (เดิมวาดชิ้นละ 3000-6000 px ทำให้ป้ายที่มีหลายชิ้นช้าเป็นวินาที ๆ โดยไม่จำเป็น)
            m2, ppm2, _o2 = geom_to_mask(pg, px_per_mm, max_px=900.0)
            w2 = stroke_width_mm(m2, ppm2)
            report.append({"idx": i + 1, "min_mm": round(w2, 1), "med_mm": round(w2, 1),
                           "ok": bool(w2 >= need), "mode": "center"})
        if _note:
            # 🔔 แจ้งผู้ใช้ผ่านช่องเดียวกับรายงาน — app.py จะเอาไปขึ้นเป็นคำเตือน
            report.append({"idx": 0, "min_mm": 0.0, "med_mm": 0.0, "ok": True,
                           "mode": "note", "note": _note, "tube_mm": float(_tube_use)})
        return subs, report
    except Exception:
        return [], []


def transformer_pick(watt):
    for w in (50, 75, 100, 150, 200, 350, 450):
        if watt <= w * 0.8:
            return w
    return 450
