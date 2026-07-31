# -*- coding: utf-8 -*-
"""💡 neon_single — โมดูล 'นีออนเส้นเดี่ยว (แกนกลาง)' แยกไฟล์อิสระ

กติกาสำคัญของโมดูลนี้ (ตามคำสั่งพี่ 2026-07-29):
  * แยกออกจาก app.py เด็ดขาด — โค้ดเส้นตัดเดิมใน app.py ห้ามถูกแตะแม้แต่นิดเดียว
  * app.py เรียกเข้ามาที่ 'กิ่งนีออนเส้นเดี่ยว' จุดเดียวเท่านั้น
  * ถ้าโมดูลนี้ล้มเหลวไม่ว่ากรณีใด -> คืน ([], []) ให้ app.py ใช้วิธีเดิม (งานห้ามพัง)

หลักการ (ตามที่พี่ชี้ 2026-07-29): เส้นคู่เนียนเพราะใช้ 'เส้นขอบเวกเตอร์จริง' ตรง ๆ
เส้นเดี่ยวจึงคำนวณจากขอบเวกเตอร์จริงเช่นกัน — สร้างแกนกลางด้วย Voronoi ของจุดขอบ
(= เส้นที่ทุกจุดห่างขอบสองฝั่ง 'เท่ากันเป๊ะ' ทางคณิตศาสตร์) ไม่ใช้ภาพพิกเซลเลย
เส้นจึงขนานขอบและเนียนเท่าขอบโดยกำเนิด

หน้าที่:
  * centerline(full)      -> เส้นแกนกลางความหนาอักษรจริง + วัดความกว้างเนื้ออักษรต่อชิ้น
                             ชิ้น 'ก้อนทึบ' (ไม่ใช่เส้นอักษร) -> เดินไฟตามโครงร่างแทน
  * warn_messages(report) -> ข้อความเตือนตอนออกแบบ (💡/🧿/⚠️ ชิ้นที่แคบกว่า 10 มม.)
"""


# 🎛️ สวิตช์โหมดเส้นเดี่ยว
#    False = เดินเส้นด้านนอกตามตัวอักษร/โลโก้ 100% (ใช้เส้นตัดชุดเดิมของ app · เร็วทันที)  ← โหมดที่พี่สั่ง
#    True  = คำนวณแกนกลางกลางเนื้ออักษร (โค้ดด้านล่างทั้งหมด · ช้ากว่า)
_ENABLE_AXIS = False


def _smooth_path(pts, closed=False, win_mm=2.5):
    # 🪄 เกลี่ยเส้นกลางให้นิ่งเหมือนเส้นคู่ (หน้าต่าง 2.5 มม. รีดคลื่นสั่นจากหัวอักษร/ความหนาแกว่ง)
    #    ปลายเส้นตรึงที่เดิม -> จุดต่อยังชนสนิท · รูปทรงรวมไม่เพี้ยน (เลื่อนจากแกนจริง < 1 มม.)
    return _smooth_path_win(pts, closed=closed, win_mm=win_mm)


def _smooth_path_win(pts, closed=False, win_mm=2.5):
    """🪄 เกลี่ยเส้นเบา ๆ (ลบรอยต่อจุดตัวอย่าง) — หน้าต่างเล็กมาก เส้นไม่เพี้ยนจากกึ่งกลาง
       ปลายเส้นตรึงไว้ที่เดิม (จุดต่อทางแยกยังชนกันสนิท)"""
    try:
        import numpy as np
        from shapely.geometry import LineString
        if len(pts) < 3:
            return pts
        P = np.asarray(pts, float)
        seg = np.sqrt(((P[1:] - P[:-1]) ** 2).sum(1))
        L = float(seg.sum())
        if L < 2.0:
            return pts
        s = np.concatenate([[0.0], np.cumsum(seg)])
        res = 0.15
        n = max(8, int(L / res) + 1)
        si = np.linspace(0.0, L, n)
        x = np.interp(si, s, P[:, 0]); y = np.interp(si, s, P[:, 1])
        win = max(3, int(win_mm / res) | 1)
        k = np.ones(win) / win
        if closed:
            xs = np.convolve(np.r_[x[-win:], x, x[:win]], k, "same")[win:-win]
            ys = np.convolve(np.r_[y[-win:], y, y[:win]], k, "same")[win:-win]
        else:
            xs = np.convolve(np.r_[np.full(win, x[0]), x, np.full(win, x[-1])], k, "same")[win:-win]
            ys = np.convolve(np.r_[np.full(win, y[0]), y, np.full(win, y[-1])], k, "same")[win:-win]
            xs[0], ys[0] = x[0], y[0]; xs[-1], ys[-1] = x[-1], y[-1]
        out = list(zip(xs.tolist(), ys.tolist()))
        try:
            out = list(LineString(out).simplify(0.02).coords)
        except Exception:
            pass
        return out
    except Exception:
        return pts


def _vor_centerline(polys, step=0.15):
    """🧮 แกนกลางจากขอบเวกเตอร์ตรง ๆ (Voronoi) — ไม่มีพิกเซล ไม่มีรอยหยัก
       คืน (chains, pieces_w)
       chains   = [{"pts": [(x,y)...], "w": [ความกว้าง มม. ...], "piece": iชิ้น(0-based), "loop": bool}]
       pieces_w = {iชิ้น+1: [ความกว้างทุกจุดแกน]} (ก่อนตัดกิ่ง — ใช้ทำสถิติ/เตือน)"""
    import numpy as np
    from scipy.spatial import Voronoi
    import shapely
    from shapely.geometry import LineString

    S = []; ring_id = []; pos_id = []; piece_id = []; ring_n = []
    for pi, pg in enumerate(polys):
        for ring in [pg.exterior] + list(pg.interiors):
            P = np.asarray(ring.coords, float)
            if len(P) < 4:
                continue
            seg = np.sqrt(((P[1:] - P[:-1]) ** 2).sum(1))
            L = float(seg.sum())
            if L < 1.0:
                continue
            m = max(12, int(L / step))
            s = np.concatenate([[0.0], np.cumsum(seg)])
            si = (np.arange(m) + 0.5) / m * L
            X = np.c_[np.interp(si, s, P[:, 0]), np.interp(si, s, P[:, 1])]
            rid = len(ring_n)
            S.append(X)
            ring_id.extend([rid] * m); pos_id.extend(range(m)); piece_id.extend([pi] * m)
            ring_n.append(m)
    if not S:
        return [], {}
    S = np.vstack(S)
    ring_id = np.asarray(ring_id); pos_id = np.asarray(pos_id); piece_id = np.asarray(piece_id)
    vor = Voronoi(S)
    V = vor.vertices
    RP = vor.ridge_points; RV = np.asarray(vor.ridge_vertices)
    ok = (RV[:, 0] >= 0) & (RV[:, 1] >= 0)
    p = RP[:, 0]; q = RP[:, 1]
    ok &= (piece_id[p] == piece_id[q])                      # แกนของชิ้นเดียวกันเท่านั้น
    same = ring_id[p] == ring_id[q]
    n_of = np.asarray(ring_n)
    dpos = np.abs(pos_id[p] - pos_id[q])
    dwrap = np.minimum(dpos, n_of[ring_id[p]] - dpos)
    ok &= ~(same & (dwrap <= 2))                            # จุดขอบติดกัน -> ไม่ใช่แกน
    idx = np.where(ok)[0]
    if not len(idx):
        return [], {}
    mids = 0.5 * (V[RV[idx, 0]] + V[RV[idx, 1]])
    keep = np.zeros(len(idx), bool)                         # ต้องอยู่ 'ใน' ชิ้นนั้นจริง
    for pi, pg in enumerate(polys):
        m = piece_id[p[idx]] == pi
        if m.any():
            keep[m] = shapely.contains_xy(pg, mids[m, 0], mids[m, 1])
    idx = idx[keep]
    if not len(idx):
        return [], {}

    adj = {}; rad = {}; vpiece = {}
    for k in idx:
        a, b = int(RV[k, 0]), int(RV[k, 1])
        pa = int(p[k])
        ra = float(np.sqrt(((V[a] - S[pa]) ** 2).sum()))
        rb = float(np.sqrt(((V[b] - S[pa]) ** 2).sum()))
        rad[a] = min(rad.get(a, 1e9), ra); rad[b] = min(rad.get(b, 1e9), rb)
        adj.setdefault(a, set()).add(b); adj.setdefault(b, set()).add(a)
        vpiece[a] = int(piece_id[pa]); vpiece[b] = int(piece_id[pa])

    pieces_w = {}                                           # สถิติความกว้าง (ก่อนตัดกิ่ง)
    for v, r in rad.items():
        pieces_w.setdefault(vpiece.get(v, -1) + 1, []).append(2.0 * r)

    # ✂️ ตัดกิ่งง่ามหัวมุม: กิ่งจากทางแยกที่สั้นกว่า ~1.2 เท่าความกว้าง ณ ทางแยก
    #    🛡️ ห้ามตัดเกิน 45% ของแกนในชิ้น -> อักษรเล็กไม่หายทั้งตัว
    tot_v = {}
    for v in adj:
        pc = vpiece.get(v, -1)
        tot_v[pc] = tot_v.get(pc, 0) + 1
    rem_v = {}
    for _pass in range(4):
        deg = {v: len(a) for v, a in adj.items()}
        leaves = [v for v, d in deg.items() if d == 1]
        removed = False
        for lf in leaves:
            if lf not in adj or len(adj[lf]) != 1:
                continue
            chain = [lf]; prev = None; cur = lf; blen = 0.0; hit = None
            for _ in range(len(adj) + 5):
                nxt = [u for u in adj.get(cur, ()) if u != prev]
                if not nxt:
                    break
                u = nxt[0]
                blen += float(np.sqrt(((V[u] - V[cur]) ** 2).sum()))
                if len(adj.get(u, ())) >= 3:
                    hit = u; break
                chain.append(u); prev, cur = cur, u
                if blen > 40.0:
                    break
            if hit is None:
                continue
            wj = 2.0 * rad.get(hit, 3.0)
            if blen <= max(4.0, 1.8 * wj):
                pc = vpiece.get(lf, -1)
                if rem_v.get(pc, 0) + len(chain) > 0.45 * tot_v.get(pc, 1):
                    continue
                rem_v[pc] = rem_v.get(pc, 0) + len(chain)
                for v in chain:
                    for u in adj.get(v, ()):
                        adj.get(u, set()).discard(v)
                    adj.pop(v, None)
                removed = True
        if not removed:
            break

    # เดินเก็บเส้น: โซ่ระหว่างโหนด (deg != 2) + วงปิดล้วน (o, รูใน)
    deg = {v: len(a) for v, a in adj.items()}
    nodes = [v for v, d in deg.items() if d != 2]
    visited = set(); chains = []

    def emit(seq, loop):
        if len(seq) < 2:
            return
        pts = [tuple(V[v]) for v in seq]
        try:
            if LineString(pts).length < 1.5:
                return
        except Exception:
            return
        chains.append({"pts": pts, "w": [2.0 * rad.get(v, 0.0) for v in seq],
                       "piece": vpiece.get(seq[len(seq) // 2], -1), "loop": loop})
    for st in nodes:
        for n in list(adj.get(st, ())):
            if (st, n) in visited:
                continue
            seq = [st]; prev, cur = st, n
            visited.add((st, n)); visited.add((n, st))
            for _ in range(len(adj) + 5):
                seq.append(cur)
                if deg.get(cur, 0) != 2 and cur != st:
                    break
                if cur == st:
                    break
                nxt = [u for u in adj.get(cur, ()) if u != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                visited.add((prev, cur)); visited.add((cur, prev))
            emit(seq, False)
    for st in list(adj.keys()):
        for n in list(adj.get(st, ())):
            if (st, n) in visited:
                continue
            seq = [st]; prev, cur = st, n
            visited.add((st, n)); visited.add((n, st))
            guard = 0
            while cur != st and guard < len(adj) + 5:
                guard += 1; seq.append(cur)
                nxt = [u for u in adj.get(cur, ()) if u != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                visited.add((prev, cur)); visited.add((cur, prev))
            seq.append(st)
            if len(seq) >= 4:
                emit(seq, True)
    return chains, pieces_w


def _one_side_offset(chain_pts, chain_w, ring_tree, ring_pts, closed):
    """📏 วิธีเดียวกับเส้นคู่ ตามที่พี่สั่ง: ใช้ 'เส้นขอบจริงข้างเดียว' แล้วขยับเข้าไปครึ่งความหนา
       -> เส้นขนานตามเคิร์ฟของขอบเส้นนั้นเป๊ะ ๆ (ไม่เฉลี่ยขอบสองฝั่ง จึงไม่ส่าย)
       chain_pts/chain_w = แนวอ้างอิงจากแกน Voronoi (ไว้เลือกข้างและความหนา) · ring_* = จุดขอบเวกเตอร์ของชิ้น"""
    try:
        import numpy as np
        if ring_tree is None or len(chain_pts) < 3:
            return chain_pts
        # แตกจุดถี่ ~0.4 มม. + ความหนาต่อจุด
        P = np.asarray(chain_pts, float)
        Wd = np.asarray(chain_w, float)
        seg = np.sqrt(((P[1:] - P[:-1]) ** 2).sum(1))
        L = float(seg.sum())
        if L < 2.0:
            return chain_pts
        s = np.concatenate([[0.0], np.cumsum(seg)])
        n = max(8, int(L / 0.4) + 1)
        si = np.linspace(0.0, L, n)
        X = np.c_[np.interp(si, s, P[:, 0]), np.interp(si, s, P[:, 1])]
        R = np.interp(si, s, Wd) * 0.5                       # ครึ่งความหนา
        # ทำครึ่งความหนาให้นิ่ง (หน้าต่าง ~12 มม.) -> ระยะขยับคงที่ เส้นขนานขอบจริง
        win = max(3, int(12.0 / 0.4) | 1)
        k = np.ones(win) / win
        R = np.convolve(np.r_[np.full(win, R[0]), R, np.full(win, R[-1])], k, "same")[win:-win]
        T = np.zeros_like(X)
        T[1:-1] = X[2:] - X[:-2]; T[0] = X[1] - X[0]; T[-1] = X[-1] - X[-2]
        Ln = np.sqrt((T ** 2).sum(1)); Ln[Ln < 1e-9] = 1.0
        T /= Ln[:, None]
        # เลือก 'ข้าง' เดียวทั้งเส้น: ข้างที่จุดขอบใกล้สุดส่วนใหญ่อยู่
        d1, i1 = ring_tree.query(X)
        B1 = ring_pts[i1]
        cr = T[:, 0] * (B1[:, 1] - X[:, 1]) - T[:, 1] * (B1[:, 0] - X[:, 0])
        side = 1.0 if (cr > 0).sum() >= (cr <= 0).sum() else -1.0
        # ต่อจุด: หา 'จุดขอบข้างที่เลือก' ที่ใกล้สุด แล้ววางจุดใหม่ = ขอบ + ครึ่งความหนา เข้าด้านใน
        kq = min(12, len(ring_pts))
        dk, ik = ring_tree.query(X, k=kq)
        if kq == 1:
            dk = dk[:, None]; ik = ik[:, None]
        out = X.copy()
        for i in range(len(X)):
            found = False
            for j in range(kq):
                b = ring_pts[ik[i, j]]
                c = T[i, 0] * (b[1] - X[i, 1]) - T[i, 1] * (b[0] - X[i, 0])
                if c * side <= 0:
                    continue                                  # คนละข้าง
                dd = float(dk[i, j])
                if dd < 0.25 * R[i] or dd > 2.6 * max(R[i], 0.6):
                    continue                                  # ขอบไกล/ใกล้ผิดปกติ (หัวมุม/ปลาย)
                v = X[i] - b
                nv = float(np.sqrt((v ** 2).sum()))
                if nv < 1e-6:
                    continue
                out[i] = b + v / nv * R[i]                    # ขยับจากขอบเข้ามาครึ่งความหนา
                found = True
                break
            # ไม่เจอขอบข้างที่เลือก (เช่น ปลายสุด) -> คงจุดแกนเดิม
        return [tuple(q) for q in out]
    except Exception:
        return chain_pts


def _inset_rings(pg, half_w, tube_mm=8.0):
    """📏 วิธีของพี่ + เกรดเส้นตัด: เอา 'เส้นขอบแบบเส้นคู่' ขยับเข้าครึ่งความหนาอักษร
       ใช้หลักเดียวกับระบบเส้นตัด:
         * เศษจิ๋วที่แตกจากการหดเส้น -> ลบทิ้ง (แบบเดียวกับ 'ลบเศษที่แตกจากการหดเส้น' ของเส้นตัด)
         * ถ้าหดแล้วเส้นแตกเป็นหลายท่อน (เส้นขาด) -> ลดระยะหดอัตโนมัติจนเส้นต่อเนื่องเหมือนเดิม
         * ขอบโค้งมนความละเอียดสูง + เก็บจุดละเอียดเท่าเส้นตัด"""
    try:
        from shapely.geometry import LineString
        _junk = max(16.0, tube_mm * 2.0)                    # เส้นรอบวงสั้นกว่านี้ = เศษ

        def parts_of(g):
            if g is None or g.is_empty:
                return []
            ps = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
            return [p for p in ps if p.geom_type == "Polygon" and not p.is_empty]

        base = parts_of(pg.buffer(-0.2, join_style=1, quad_segs=10))
        n0 = max(1, len(base))                              # จำนวนท่อนโดยธรรมชาติของชิ้นนี้

        def good(tt):
            ps = parts_of(pg.buffer(-tt, join_style=1, quad_segs=10))
            big = [p for p in ps if p.exterior.length >= _junk]
            if not big:
                return None
            if len(big) > n0:
                return None                                 # แตกท่อนเพิ่ม = เส้นขาด -> ไม่เอา
            return big

        t = max(0.3, float(half_w))
        ps = good(t)
        if ps is None:                                      # ลดระยะหดอัตโนมัติ
            lo, hi = 0.2, t
            for _ in range(12):
                mid = (lo + hi) / 2.0
                if good(mid) is None:
                    hi = mid
                else:
                    lo = mid
            t = max(0.3, lo * 0.9)
            ps = good(t)
            if ps is None:
                ps = parts_of(pg.buffer(-0.3, join_style=1, quad_segs=10))
        rings = []
        for pp in ps:
            for ring in [pp.exterior] + list(pp.interiors):
                if ring.length < _junk:
                    continue                                # 🧹 เศษจิ๋ว/รูจิ๋ว ทิ้ง
                cc = list(LineString(ring.coords).simplify(0.05).coords)
                if len(cc) >= 4:
                    rings.append(cc)
        return rings
    except Exception:
        return []


def _to_curves(pts, closed=False, tol=0.25, corner_deg=55.0):
    """🪄 แปลงแนวจุดถี่ ๆ -> 'เส้นโค้งเบซิเยร์จริง' รูปแบบเดียวกับเส้นตัด (เนียนกริบเท่ากัน)
       - เลือกจุดสำคัญด้วย simplify (คงรูปตามแบบ คลาดไม่เกิน tol มม.)
       - มุมหักคม (> corner_deg) คงความคมไว้ ไม่ปัดให้มน
       - ช่วงที่เหลือร้อยด้วย Catmull-Rom -> cubic bezier (โค้งลื่นต่อเนื่อง)
       คืน (start, segs) รูปแบบ ("C", c1, c2, end) / ("L", p)"""
    import math
    try:
        from shapely.geometry import LineString
        P = [tuple(p) for p in pts]
        if closed and len(P) > 2 and (abs(P[0][0]-P[-1][0]) > 1e-9 or abs(P[0][1]-P[-1][1]) > 1e-9):
            P = P + [P[0]]
        if len(P) < 3:
            return P[0], [("L", q) for q in P[1:]]
        try:                                            # เลือกจุดสำคัญ
            K = list(LineString(P).simplify(float(tol)).coords)
        except Exception:
            K = P
        if len(K) < 3:
            return K[0], [("L", q) for q in K[1:]]
        if closed and len(K) > 3 and (abs(K[0][0]-K[-1][0]) < 1e-9 and abs(K[0][1]-K[-1][1]) < 1e-9):
            K = K[:-1]
            n = len(K); wrap = True
        else:
            n = len(K); wrap = False
        def at(i):
            if wrap:
                return K[i % n]
            return K[min(max(i, 0), n - 1)]
        def ang(i):                                     # มุมหักที่จุด i (องศา)
            a, b, c = at(i - 1), at(i), at(i + 1)
            v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
            l1 = math.hypot(*v1); l2 = math.hypot(*v2)
            if l1 < 1e-9 or l2 < 1e-9:
                return 0.0
            d = max(-1.0, min(1.0, (v1[0]*v2[0] + v1[1]*v2[1]) / (l1*l2)))
            return math.degrees(math.acos(d))
        sharp = set()
        rng = range(n) if wrap else range(1, n - 1)
        for i in rng:
            if ang(i) > float(corner_deg):
                sharp.add(i % n)
        segs = []
        last = n if wrap else n - 1
        for i in range(last):
            p1 = at(i); p2 = at(i + 1)
            # ปลายที่เป็นมุมคม -> ไม่ยืดแขนโค้งข้ามมุม (คมตามแบบ)
            p0 = p1 if ((i % n) in sharp or (not wrap and i == 0)) else at(i - 1)
            p3 = p2 if (((i + 1) % n) in sharp or (not wrap and i + 1 == n - 1)) else at(i + 2)
            c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
            c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
            segs.append(("C", c1, c2, p2))
        return K[0], segs
    except Exception:
        return pts[0], [("L", q) for q in pts[1:]]


def _polys_from_subs(subs, tol=0.05):
    """🎯 สร้างรูปทรงจาก 'เส้นโค้งดิบ' ชุดเดียวกับที่ใช้ทำเส้นตัด — แตกโค้งละเอียด tol มม.
       แบบว่ามาอย่างไร เส้นก็เดินอย่างนั้น ไม่ผ่านรูปที่ถูกแปลง/เกลี่ยมาก่อน"""
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
        rings = []
        for sp in (subs or []):
            pts = [tuple(sp["start"])]
            for g in sp.get("segs", []):
                if g and g[0] != "L" and len(g) >= 4:   # ("C", c1, c2, end) = โค้งเบซิเยร์จริง
                    p0 = pts[-1]; c1, c2, p3 = g[1], g[2], g[3]
                    d = (abs(c1[0]-p0[0]) + abs(c1[1]-p0[1]) + abs(c2[0]-c1[0]) + abs(c2[1]-c1[1])
                         + abs(p3[0]-c2[0]) + abs(p3[1]-c2[1]))
                    n = max(2, min(120, int(d / max(0.01, tol)) + 1))
                    for i in range(1, n + 1):
                        t = i / n; m = 1.0 - t
                        x = (m**3)*p0[0] + 3*(m*m)*t*c1[0] + 3*m*(t*t)*c2[0] + (t**3)*p3[0]
                        y = (m**3)*p0[1] + 3*(m*m)*t*c1[1] + 3*m*(t*t)*c2[1] + (t**3)*p3[1]
                        pts.append((x, y))
                else:                                  # เส้นตรง
                    pts.append(tuple(g[-1]))
        # ปิดวง -> แยกเนื้อ/รู ด้วยการซ้อนกัน (เหมือนที่เส้นตัดทำ)
            if len(pts) >= 4:
                rings.append(pts)
        polys = []
        for r in rings:
            try:
                p = Polygon(r)
                if not p.is_valid:
                    p = p.buffer(0)
                if p is not None and not p.is_empty and p.area > 0.5:
                    polys.append(p)
            except Exception:
                pass
        if not polys:
            return None
        polys.sort(key=lambda p: -p.area)
        solid = []; hole = []
        for i, p in enumerate(polys):
            depth = 0
            try:
                rp = p.representative_point()
                for j, q in enumerate(polys):
                    if j != i and q.area > p.area and q.contains(rp):
                        depth += 1
            except Exception:
                depth = 0
            (hole if (depth % 2) else solid).append(p)
        g = unary_union(solid)
        if hole:
            g = g.difference(unary_union(hole))
        if g is None or g.is_empty:
            return None
        return g
    except Exception:
        return None


def _solid_blob(p, tube_mm=8.0):
    """🎨 'ภาพวาด' (เช่น หัวแกะในโลโก้) ต่างจาก 'เส้นอักษร' ตรงความหนา *แปรผันมาก*
       อักษร = หนาคงที่ทั้งเส้น (หนาสุด/หนาเฉลี่ย ≤ ~1.8 วัดจากงานจริง)
       ภาพวาด = หนาสุดโตกว่าหนาเฉลี่ยมาก (≥ ~1.9) -> ให้เส้นวิ่งตามลายเส้นของภาพ (ตามขอบ)
       ส่วนอักษรลากแกนกลางแบบปากกาเสมอ ไม่ว่าหนาแค่ไหน"""
    try:
        b = p.bounds
        bm = min(b[2] - b[0], b[3] - b[1])
        if bm < tube_mm * 2.2:
            return False
        lo, hi = 0.0, bm
        for _ in range(12):                    # รัศมีในสุด (วงกลมใหญ่สุดที่ยัดลงชิ้นได้)
            mid = (lo + hi) / 2.0
            g = p.buffer(-mid)
            if g is not None and not g.is_empty:
                lo = mid
            else:
                hi = mid
        _wmax = 2.0 * lo
        _per = p.exterior.length + sum(r.length for r in p.interiors)
        _wmean = 2.0 * p.area / max(_per, 0.001)
        return (_wmax > tube_mm * 2.5) and ((_wmax / max(_wmean, 0.001)) > 1.85)
    except Exception:
        return False


def _mid_snap(subs, polys, tube_mm=8.0, step=1.2, iters=2):
    """🧲 ดูดเส้นเข้า 'กึ่งกลางร่องอักษร' เป๊ะ ๆ เทียบกับขอบแบบจริงทั้งสองข้าง
       (แกนจากภาพจะกลางโดยประมาณ -> จุดนี้บังคับกลางจริงทุกจุด เส้นเลยไหลตามแบบ 100%)
       ปลายเส้นคงที่ (ไม่ดูด) · จบแล้วฟิตกลับเป็นเบซิเยร์เนียนเหมือนเดิม"""
    import math
    try:
        from shapely.geometry import LineString, Point
        W = tube_mm * 4.0
        for s in subs:
            try:
                # หา 'ชิ้น' ของเส้นนี้ (ชิ้นที่ครอบจุดมากสุด)
                P0 = [s["start"]]
                for g in s["segs"]:
                    if g[0] == "L":
                        P0.append(g[1])
                    else:
                        p0 = P0[-1]; c1, c2, p3 = g[1], g[2], g[3]
                        for t in (0.25, 0.5, 0.75, 1.0):
                            mt = 1 - t
                            P0.append((mt**3*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t**3*p3[0],
                                       mt**3*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t**3*p3[1]))
                _pc = None; _bestn = 0
                for _q in polys:
                    n = sum(1 for pp in P0[::max(1, len(P0)//10)] if _q.buffer(0.5).contains(Point(pp)))
                    if n > _bestn:
                        _bestn = n; _pc = _q
                if _pc is None:
                    continue
                bnd = _pc.boundary
                _per = _pc.exterior.length + sum(r.length for r in _pc.interiors)
                _wm = 2.0 * _pc.area / max(_per, 0.001)          # ความหนาปกติของเส้นชิ้นนี้
                if _wm < tube_mm * 1.8:
                    continue                                     # เส้นบาง: แกนจากภาพกลางเป๊ะอยู่แล้ว อย่าไปยุ่ง
                # ทำเป็นเส้นถี่คงระยะ ~step มม.
                ls = LineString(P0)
                L = ls.length
                if L < step * 3:
                    continue
                k = max(4, int(L / step))
                P = [(q.x, q.y) for q in (ls.interpolate(i * L / k) for i in range(k + 1))]
                closed = bool(s.get("closed"))
                _gap = int(6.0 / max(step, 0.1)) + 1        # ระยะกันปลาย ~6 มม. (ปลายห้ามขยับ กันเกิดตะขอ)
                for _ in range(iters):
                    Q = list(P)
                    rng = range(len(P)) if closed else range(_gap, len(P) - _gap)
                    for i in rng:
                        a = P[i - 1] if i > 0 else (P[-2] if closed else P[0])
                        b = P[i + 1] if i < len(P) - 1 else (P[1] if closed else P[-1])
                        tx = b[0] - a[0]; ty = b[1] - a[1]
                        tn = math.hypot(tx, ty)
                        if tn < 1e-9:
                            continue
                        nx = -ty / tn; ny = tx / tn
                        ray = LineString([(P[i][0] - nx * W, P[i][1] - ny * W),
                                          (P[i][0] + nx * W, P[i][1] + ny * W)])
                        try:
                            X = bnd.intersection(ray)
                        except Exception:
                            continue
                        hp = []; hm = []
                        pts = ([X] if X.geom_type == "Point" else list(getattr(X, "geoms", [])))
                        for h in pts:
                            if h.geom_type != "Point":
                                continue
                            d = (h.x - P[i][0]) * nx + (h.y - P[i][1]) * ny
                            (hp if d >= 0 else hm).append((abs(d), h))
                        if hp and hm:
                            d1, h1 = min(hp); d2, h2 = min(hm)
                            if (d1 + d2) > _wm * 1.7:            # โซนทางแยก/หัวโป่ง -> อย่าดูด (กันเส้นสะดุ้ง)
                                continue
                            mx = (h1.x + h2.x) / 2.0; my = (h1.y + h2.y) / 2.0
                            if math.hypot(mx - P[i][0], my - P[i][1]) <= tube_mm * 0.9:
                                Q[i] = (P[i][0] + (mx - P[i][0]) * 0.6,     # ขยับนุ่ม ๆ 60% กันเส้นสะดุ้ง
                                        P[i][1] + (my - P[i][1]) * 0.6)
                    P = Q
                # ฟิตกลับเป็นเบซิเยร์ (โค้งจริง เนียนเหมือนเส้นตัด)
                st2, sg2 = _to_curves(_smooth_path_win(P, closed=closed, win_mm=3.0),
                                      closed=closed, tol=0.22, corner_deg=78.0)
                if sg2:
                    s["start"] = st2; s["segs"] = sg2
            except Exception:
                pass
    except Exception:
        pass
    return subs


def _straighten(subs, tol=1.2, min_len=9.0, ax_tol=0.03, ax_min=10.0):
    """📏 เส้นตรงต้องตรงเป๊ะ: ช่วงไหนของเส้นที่แนบคอร์ดตรง (คลาด ≤ tol มม.) -> ยุบเป็นเส้นตรงเดียว
       และเส้นตรงยาวที่เกือบดิ่ง/เกือบระดับ (≤ ~1.3°) -> ดัดให้ดิ่ง/ระดับสนิท (แบบที่กราฟิกจัดเส้น)"""
    import math
    for s in subs:
        try:
            segs = s["segs"]
            if not segs:
                continue
            A = [tuple(s["start"])] + [tuple(g[1] if g[0] == "L" else g[3]) for g in segs]
            out = []
            i = 0
            n = len(segs)
            while i < n:
                best = i
                j = i
                while j < n:                       # ขยายช่วง i..j ให้ไกลสุดที่ยังแนบคอร์ด
                    j += 1
                    x0, y0 = A[i]; x1, y1 = A[j]
                    L = math.hypot(x1 - x0, y1 - y0)
                    if L < 1e-6:
                        break
                    # 📐 เกณฑ์ 'ตรงจริง' แปรผันตามความยาว: ก้านยาวแอ่นน้อยต้องถูกจัดตรง · โค้งอ่อนช่วงสั้นไม่โดนเหมา
                    _te = min(tol, max(0.3, 0.009 * L))
                    ok = True
                    for k in range(i, j):
                        pts = [A[k + 1]]
                        if segs[k][0] == "C":
                            pts += [segs[k][1], segs[k][2]]     # จุดคุมโค้งต้องแนบด้วย (กันโค้งป่อง)
                        for (px, py) in pts:
                            if abs((x1 - x0) * (y0 - py) - (x0 - px) * (y1 - y0)) / L > _te:
                                ok = False; break
                        if not ok:
                            break
                    if not ok:
                        break
                    best = j
                x0, y0 = A[i]; x1, y1 = A[best]
                L = math.hypot(x1 - x0, y1 - y0)
                if best > i and L >= min_len:
                    out.append(("L", A[best])); i = best
                else:
                    out.append(segs[i]); i += 1
            # ดัดแกน: เส้นตรงยาวที่เกือบดิ่ง/ระดับ -> ดิ่ง/ระดับสนิท
            A2 = [tuple(s["start"])]
            for g in out:
                A2.append(tuple(g[1] if g[0] == "L" else g[3]))
            for k, g in enumerate(out):
                if g[0] != "L":
                    continue
                x0, y0 = A2[k]; x1, y1 = A2[k + 1]
                dx = x1 - x0; dy = y1 - y0
                L = math.hypot(dx, dy)
                if L < ax_min:
                    continue
                if abs(dx) <= ax_tol * L:
                    out[k] = ("L", (x0, y1)); A2[k + 1] = (x0, y1)
                elif abs(dy) <= ax_tol * L:
                    out[k] = ("L", (x1, y0)); A2[k + 1] = (x1, y0)
            s["segs"] = out
        except Exception:
            pass
    return subs


def _autotrace_centerline(polys, tube_mm=8.0):
    """🖊️ Centerline Trace แบบเดียวกับเครื่องมือกราฟิก:
       วาดชิ้นงานเป็นภาพ -> skeletonize (แกน 1px) -> autotrace centerline (ฟิตเบซิเยร์ลื่น)
       คืน subs พิกัด มม. เดิมเป๊ะ · ล้มเหลว -> None (ผู้เรียกถอยไปวิธีเดิม)"""
    try:
        import numpy as np
        from PIL import Image, ImageDraw
        from skimage.morphology import skeletonize
        from scipy.ndimage import binary_dilation
        from autotrace import Bitmap, Color
        xs = []; ys = []
        for p in polys:
            b = p.bounds; xs += [b[0], b[2]]; ys += [b[1], b[3]]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        W = x1 - x0; H = y1 - y0
        if W < 2 or H < 2:
            return None
        ppm = min(4.0, 6000.0 / max(W, 1.0), 6000.0 / max(H, 1.0))   # px ต่อ มม. (ละเอียดขึ้น -> เส้นนิ่งขึ้น)
        if ppm < 0.5:
            ppm = 0.5
        pad = 6
        iw = int(W * ppm) + pad * 2; ih = int(H * ppm) + pad * 2
        img = Image.new("L", (iw, ih), 255)
        dr = ImageDraw.Draw(img)
        def _px(pt):
            return ((pt[0] - x0) * ppm + pad, (pt[1] - y0) * ppm + pad)
        for p in polys:
            dr.polygon([_px(q) for q in p.exterior.coords], fill=0)
            for irg in p.interiors:
                dr.polygon([_px(q) for q in irg.coords], fill=255)
        mask = np.asarray(img) < 128
        if not mask.any():
            return None
        sk = skeletonize(mask)
        # ✂️ ตัดกิ่งแตกปลาย: เดินจากปลายกิ่งเข้าหาทางแยก ถ้าสั้นกว่า 1.5×ความกว้างท้องถิ่น -> ลบทิ้ง
        try:
            from scipy.ndimage import distance_transform_edt, convolve
            D = distance_transform_edt(mask)
            K = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])
            for _ in range(6):                          # วนซ้ำ (กิ่งซ้อนกิ่ง)
                nb = convolve(sk.astype(np.uint8), K, mode="constant")
                ends = np.argwhere(sk & (nb == 1))
                if len(ends) == 0:
                    break
                removed_any = False
                for (ey, ex) in ends:
                    chain = [(ey, ex)]
                    py, px = -1, -1; cy, cx = ey, ex
                    for _step in range(int(tube_mm * ppm * 3) + 10):
                        cand = [(cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                                if (dy or dx) and 0 <= cy + dy < sk.shape[0] and 0 <= cx + dx < sk.shape[1]
                                and sk[cy + dy, cx + dx] and (cy + dy, cx + dx) != (py, px)]
                        if len(cand) != 1:
                            break                        # ถึงทางแยก/ตัน
                        py, px = cy, cx; cy, cx = cand[0]
                        nb2 = convolve(sk.astype(np.uint8)[max(0,cy-1):cy+2, max(0,cx-1):cx+2],
                                       K[:cy+2-max(0,cy-1), :cx+2-max(0,cx-1)], mode="constant") if False else None
                        chain.append((cy, cx))
                        deg = sum(1 for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                                  if (dy or dx) and 0 <= cy + dy < sk.shape[0] and 0 <= cx + dx < sk.shape[1]
                                  and sk[cy + dy, cx + dx])
                        if deg >= 3:
                            break                        # (cy,cx) = ทางแยก
                    deg = sum(1 for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                              if (dy or dx) and 0 <= cy + dy < sk.shape[0] and 0 <= cx + dx < sk.shape[1]
                              and sk[cy + dy, cx + dx])
                    if deg >= 3 and len(chain) <= max(4, 1.5 * 2.0 * D[cy, cx]):
                        for (qy, qx) in chain[:-1]:      # ลบกิ่ง (คงจุดทางแยกไว้)
                            sk[qy, qx] = False
                        removed_any = True
                if not removed_any:
                    break
            # 🖊️ ยืดปลายเส้นให้สุดหัวอักษร (แกนกลางหดจากปลายจริงราวครึ่งความหนาเสมอ
            #    เหมือนปากกาต้องลากให้สุดหัว-หางตัวอักษร ไม่ใช่หยุดกลางทาง)
            nb = convolve(sk.astype(np.uint8), K, mode="constant")
            ends = np.argwhere(sk & (nb == 1))
            for (ey, ex) in ends:
                chain = [(ey, ex)]; py, px = -1, -1; cy, cx = ey, ex
                for _step in range(10):                  # เดินย้อนเข้าเส้น หา 'ทิศของปลาย'
                    cand = [(cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                            if (dy or dx) and 0 <= cy + dy < sk.shape[0] and 0 <= cx + dx < sk.shape[1]
                            and sk[cy + dy, cx + dx] and (cy + dy, cx + dx) != (py, px)]
                    if len(cand) != 1:
                        break
                    py, px = cy, cx; cy, cx = cand[0]; chain.append((cy, cx))
                if len(chain) < 3:
                    continue
                vy = float(ey - chain[-1][0]); vx = float(ex - chain[-1][1])
                nrm = (vy * vy + vx * vx) ** 0.5
                if nrm < 1e-6:
                    continue
                vy /= nrm; vx /= nrm
                fy, fx = float(ey), float(ex)
                for _step in range(int(D[ey, ex] * 1.2) + 2):
                    fy += vy; fx += vx
                    qy, qx = int(round(fy)), int(round(fx))
                    if not (0 <= qy < sk.shape[0] and 0 <= qx < sk.shape[1]):
                        break
                    if (not mask[qy, qx]) or D[qy, qx] < 1.6:
                        break                            # ชิดขอบอักษรแล้ว -> พอ (กันทะลุ)
                    sk[qy, qx] = True
        except Exception:
            pass
        sk = binary_dilation(sk)
        rgb = np.stack([np.where(sk, 0, 255).astype(np.uint8)] * 3, -1)
        vec = Bitmap(rgb).trace(centerline=True, background_color=Color(255, 255, 255),
                                error_threshold=2.0, filter_iterations=6)   # ฟิตแนบเส้นจริง (คม) — ความตรงจัดการที่ _straighten
        subs = []
        for path in vec.paths:
            start = None; segs = []; anch = []
            for sp in path.splines:
                P = [((q.x - pad) / ppm + x0, ((ih - 1 - q.y) - pad) / ppm + y0) for q in sp.points]
                if not P:
                    continue
                if start is None:
                    start = P[0]; anch.append(P[0])
                if getattr(sp, "degree", 1) == 3 and len(P) >= 4:
                    segs.append(("C", P[1], P[2], P[3])); anch.append(P[3])
                else:
                    segs.append(("L", P[-1])); anch.append(P[-1])
            if start is None or not segs:
                continue
            L = sum(((anch[i+1][0]-anch[i][0])**2 + (anch[i+1][1]-anch[i][1])**2) ** 0.5
                    for i in range(len(anch)-1))
            closed = not bool(getattr(path, "open", False))
            if L < max(5.0, tube_mm * 0.7) and not closed:
                continue                                   # เศษสั้นกว่า ~ครึ่งท่อ -> ทิ้ง
            subs.append({"start": start, "segs": segs, "closed": closed, "_anch": anch})
        # 🧷 กติกาปากกา: ทุกชิ้นของแบบต้องมีเส้นเสมอ — ชิ้นไหน trace ไม่ติด ถอยเป็นแกน Voronoi เฉพาะชิ้นนั้น
        try:
            from shapely.prepared import prep as _prep
            _pp = [(_prep(p.buffer(0.8)), i) for i, p in enumerate(polys)]
            covered = set()
            for s_ in subs:
                from shapely.geometry import Point as _Pt
                for pt in ([s_["start"]] + s_["_anch"][1::2])[:8]:
                    hit = False
                    for pr, i in _pp:
                        if i not in covered and pr.contains(_Pt(pt)):
                            covered.add(i); hit = True
                    if hit and len(covered) == len(polys):
                        break
            miss = [p for i, p in enumerate(polys) if i not in covered]
            if miss:
                chains, _pc = _vor_centerline(miss)
                for c in chains:
                    cc = _smooth_path(c["pts"], closed=c["loop"], win_mm=1.2)
                    if len(cc) >= (3 if c["loop"] else 2):
                        subs.append(dict(zip(("start", "segs"), _to_curves(cc, closed=c["loop"])),
                                         closed=c["loop"]))
        except Exception:
            pass
        for s_ in subs:
            s_.pop("_anch", None)
        # 🖊️ ลากปลายให้สุดหัวอักษร (พิกัดจริง มม.): ปลายเปิดทุกด้านต้องวิ่งชนหัว/หางตัวอักษร
        #    เหมือนงานดัดท่อจริง — ท่อวิ่งสุดปลายเส้น ไม่หยุดกลางทาง
        try:
            from shapely.geometry import Point as _Pt
            _lim = 1.0                                   # หยุดเมื่อชิดขอบ ~1 มม.
            for s_ in subs:
                if s_.get("closed") or not s_["segs"]:
                    continue
                for _side in (0, 1):
                    if _side == 0:
                        _p0 = s_["start"]
                        _g = s_["segs"][0]
                        _ref = _g[1] if _g[0] == "L" else _g[1]      # c1/จุดถัดไป
                    else:
                        _g = s_["segs"][-1]
                        _p0 = _g[-1]
                        _ref = _g[2] if _g[0] == "C" else (s_["start"] if len(s_["segs"]) == 1
                                                           else s_["segs"][-2][-1])
                    _vx = _p0[0] - _ref[0]; _vy = _p0[1] - _ref[1]
                    _n = (_vx * _vx + _vy * _vy) ** 0.5
                    if _n < 1e-6:
                        continue
                    _vx /= _n; _vy /= _n
                    _pc = None
                    for _q in polys:                     # ชิ้นที่ปลายนี้อยู่ข้างใน
                        if _q.buffer(0.6).contains(_Pt(_p0)):
                            _pc = _q; break
                    if _pc is None:
                        continue
                    _best = None; _t = 0.0
                    while _t < tube_mm * 4.0:            # เดินทีละ 0.6 มม. จนชิดขอบ/หลุดชิ้น
                        _t += 0.6
                        _qp = (_p0[0] + _vx * _t, _p0[1] + _vy * _t)
                        if not _pc.contains(_Pt(_qp)):
                            break
                        if _pc.boundary.distance(_Pt(_qp)) < _lim:
                            _best = _qp; break
                        _best = _qp
                    if _best is None or ((_best[0]-_p0[0])**2 + (_best[1]-_p0[1])**2) < 0.36:
                        continue
                    if _side == 0:
                        s_["segs"].insert(0, ("L", s_["start"]))
                        s_["start"] = _best
                    else:
                        s_["segs"].append(("L", _best))
        except Exception:
            pass
        _straighten(subs)                                # 📏 เส้นตรงต้องตรงเป๊ะ + ดิ่ง/ระดับสนิท (โค้งอ่อนไม่ถูกเหมา)
        return subs if subs else None
    except Exception:
        return None


def _quick_report(polys, tube_mm=8.0, clear_mm=1.0):
    """ประเมินความกว้างชิ้นแบบเร็ว (สำหรับข้อความเตือน) — หาความหนาต่ำสุดด้วยการกัดเข้า"""
    rep = []
    need = tube_mm + 2.0 * clear_mm
    for i, p in enumerate(polys):
        w = 0.0
        try:
            lo, hi = 0.0, tube_mm * 2.0
            for _ in range(12):
                mid = (lo + hi) / 2.0
                g = p.buffer(-mid)
                if g is not None and not g.is_empty:
                    lo = mid
                else:
                    hi = mid
            w = 2.0 * lo
        except Exception:
            w = 0.0
        rep.append({"idx": i + 1, "min_mm": round(w, 1), "med_mm": round(w, 1),
                    "ok": (w + 1e-6) >= need, "mode": "center"})
    return rep


def centerline(full, tube_mm=8.0, clear_mm=1.0, raw_subs=None):
    """คืน (subs, report)
       subs   = เส้นแกนกลางรูปแบบเดียวกับระบบ ({"start","segs","closed"} หน่วย มม.)
       report = [{"idx","min_mm","med_mm","ok","mode"}] เรียงชิ้นซ้าย->ขวา
       ล้มเหลวเมื่อไหร่ -> ([], []) ให้ผู้เรียก fallback วิธีเดิม (งานห้ามพัง)"""
    # 🖊️ กติกาพี่ (2026-07-31): นีออนเส้นเดี่ยว = "เดินเส้นด้านนอกตามตัวอักษร/โลโก้ 100%"
    #    -> คืนว่าง เพื่อให้ app ใช้ 'เส้นตัดชุดเดิมของตัวเอง' (ขอบนอกชิ้นละเส้น) เป็นแนวเดินไฟ
    #    ได้ทั้ง ตรงตามแบบ 100% + เร็วทันที (ไม่รีดภาพ/ไม่ฟิตโค้งใหม่ -> ไม่ 502)
    #    โค้ดแกนกลางด้านล่างคงไว้ทั้งหมด ไม่ได้ลบ (เปิดใช้ใหม่ได้ทันทีถ้าพี่สั่ง)
    if not _ENABLE_AXIS:
        return [], []
    try:
        from shapely.geometry import LineString
        # 🎯 เส้นโค้งดิบของแบบ (ถ้ามี) ใช้เป็น 'แหล่งลายเส้นของชิ้นภาพวาด' เท่านั้น
        #    ห้ามเอามาแทนรูปทรง full เด็ดขาด — full ตัวเดิมตำแหน่ง/สเกลตรงกับเส้นตัดเสมอ
        #    (เส้นดิบบางแบบเป็นเส้นเปิด ประกอบรูปปิดไม่ได้ จะทำชิ้นงานหายทั้งก้อน)
        b = full.bounds
        W = b[2] - b[0]; H = b[3] - b[1]
        if W < 2.0 or H < 2.0:
            return [], []
        polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
        polys = [p for p in polys if p.geom_type == "Polygon" and not p.is_empty]
        polys.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))   # ซ้าย->ขวา คงที่
        if not polys:
            return [], []

        # 🖊️ ทางหลัก (v6): Centerline Trace แบบเครื่องมือกราฟิก — ก้อนทึบเดินโครงร่าง · เส้นอักษรรีดแกนแล้วฟิตโค้ง
        try:
            _blob = [p for p in polys if _solid_blob(p, tube_mm)]
            _strk = [p for p in polys if p not in _blob]
            _subs_at = _autotrace_centerline(_strk, tube_mm) if _strk else []
            if _subs_at or _blob:
                _out = list(_subs_at or [])
                # 🎨 ภาพวาด (เช่น หัวแกะ): ใช้ 'โค้ดเส้นคู่' — เส้นวิ่งตามเส้นโค้งดิบของแบบตรง ๆ
                #    (subpath ชุดเดียวกับที่โหมดเส้นคู่/เส้นตัดใช้ -> เนียนกริบเท่ากันเป๊ะ)
                _rawmatch = []
                if raw_subs and _blob:
                    try:
                        from shapely.geometry import Point as _Pt2
                        for _rs in raw_subs:
                            _pts = [tuple(_rs["start"])] + [tuple(g[1] if g[0] == "L" else g[3])
                                                            for g in _rs["segs"]]
                            _rawmatch.append((_rs, _pts))
                    except Exception:
                        _rawmatch = []
                for _p in _blob:
                    _got = False
                    if _rawmatch:
                        try:                              # subpath ไหนวางอยู่บนขอบชิ้นนี้ -> เป็นลายเส้นของชิ้นนี้
                            _bd = _p.boundary
                            for _rs, _pts in _rawmatch:
                                _smp = _pts[::max(1, len(_pts) // 6)] or _pts
                                if all(_bd.distance(_Pt2(q)) < 0.8 for q in _smp):
                                    _out.append({"start": tuple(_rs["start"]),
                                                 "segs": [tuple(g) for g in _rs["segs"]],
                                                 "closed": bool(_rs.get("closed", True))})
                                    _got = True
                        except Exception:
                            _got = False
                    if not _got:                          # ไม่มีเส้นดิบ (เช่น งานสแกน) -> ตามขอบรูปทรง
                        try:
                            for _ring in [_p.exterior] + list(_p.interiors):
                                _cc = list(_ring.simplify(0.12).coords)
                                if len(_cc) >= 4:
                                    _out.append(dict(zip(("start", "segs"), _to_curves(_cc, closed=True)), closed=True))
                        except Exception:
                            pass
                if _out:
                    return _out, _quick_report(polys, tube_mm, clear_mm)
        except Exception:
            pass
        chains, pieces = _vor_centerline(polys)             # 🧮 ทางถอย: วิธีเดิม (Voronoi)
        if not chains:
            return [], []
        # ดัชนีจุดขอบเวกเตอร์ต่อชิ้น (ไว้ยึดขอบข้างเดียวตามวิธีเส้นคู่)
        import numpy as _np
        from scipy.spatial import cKDTree as _KD
        _rtree = {}
        for _i, _pg in enumerate(polys):
            _bp = []
            for _ring in [_pg.exterior] + list(_pg.interiors):
                _Pr = _np.asarray(_ring.coords, float)
                if len(_Pr) < 2:
                    continue
                _sg = _np.sqrt(((_Pr[1:] - _Pr[:-1]) ** 2).sum(1))
                _Lr = float(_sg.sum())
                if _Lr <= 0:
                    continue
                _sr = _np.concatenate([[0.0], _np.cumsum(_sg)])
                _si = _np.linspace(0.0, _Lr, max(6, int(_Lr / 0.25) + 1))
                _bp.append(_np.c_[_np.interp(_si, _sr, _Pr[:, 0]), _np.interp(_si, _sr, _Pr[:, 1])])
            if _bp:
                _B = _np.vstack(_bp)
                _rtree[_i + 1] = (_KD(_B), _B)
        piece_paths = {}
        for c in chains:
            pid = c["piece"] + 1
            _t, _b = _rtree.get(pid, (None, None))
            _pts = _one_side_offset(c["pts"], c["w"], _t, _b, c["loop"])   # 📏 ขอบข้างเดียว + ขยับครึ่งความหนา
            cc = _smooth_path(_pts, closed=c["loop"], win_mm=1.2)
            if c["loop"] and len(cc) >= 3:
                piece_paths.setdefault(pid, []).append(
                    dict(zip(("start","segs"), _to_curves(cc, closed=True)), closed=True))
            elif (not c["loop"]) and len(cc) >= 2:
                piece_paths.setdefault(pid, []).append(
                    dict(zip(("start","segs"), _to_curves(cc, closed=False)), closed=False))

        report = []; subs = []
        need = tube_mm + 2.0 * clear_mm
        for i, pg in enumerate(polys):
            ws = sorted(pieces.get(i + 1, []))
            if not ws:
                continue
            k = max(0, int(len(ws) * 0.10))                 # ตัดปลายแหลม 10% ล่าง (ปลาย stroke เรียวธรรมชาติ)
            med = ws[len(ws) // 2]; mn = ws[k]
            pbb = pg.bounds
            _bmin = min(pbb[2] - pbb[0], pbb[3] - pbb[1])
            # 🧿 ก้อนทึบ = เทียบ 'สัดส่วน' ไม่ใช่มิลลิเมตรตายตัว (ป้ายใหญ่อักษรหนาต้องยังเป็นเส้นอักษร)
            #   ทึบจริง = เนื้อหนา ≥ 70% ของขนาดตัว (จุด/แผ่นกลม) หรือชิ้นกราฟิกใหญ่เกือบเต็มความสูงงาน
            _solid = (len(pg.interiors) == 0) and ((med > _bmin * 0.70) or (_bmin > 0.55 * min(W, H)))
            if _solid:
                for ring in [list(pg.exterior.coords)] + [list(h.coords) for h in pg.interiors]:
                    try:
                        rl = LineString(ring).simplify(0.12); cc = list(rl.coords)   # ตามขอบงานจริง
                    except Exception:
                        cc = ring
                    if len(cc) >= 3:
                        subs.append(dict(zip(("start","segs"), _to_curves(cc, closed=True)), closed=True))
                report.append({"idx": i + 1, "min_mm": round(mn, 1), "med_mm": round(med, 1),
                               "ok": True, "mode": "contour"})
            else:
                # 💡 กติกาสุดท้าย (พี่สั่ง 2026-07-29): 'ลากเส้นเดียว 8 มม. จริง ๆ เท่านั้น' ทุกชิ้น
                #    = เส้นกึ่งกลางลายเส้น เส้นเดียว (หลักเดียวกับการสร้างเส้นตัด — สูตรเดียว ไม่ซับซ้อน)
                #    อักษรลายเส้นมีช่องใน -> ลูปเดียวตามรูปอักษร · เส้นทึบ -> แกนกลางเส้นเดียว
                subs.extend(piece_paths.get(i + 1, []))
                report.append({"idx": i + 1, "min_mm": round(mn, 1), "med_mm": round(med, 1),
                               "ok": (med + 1e-6) >= need and (mn + 1e-6) >= tube_mm, "mode": "center"})
        if not subs:
            return [], []
        return subs, report
    except Exception:
        return [], []


def warn_messages(report, tube_mm=8.0, clear_mm=1.0):
    """สร้างข้อความแจ้งเตือนตอนออกแบบจาก report ของ centerline() — คืนรายการข้อความ (อาจว่าง)"""
    try:
        if not report:
            return []
        out = []
        need = tube_mm + 2.0 * clear_mm
        bad = [r for r in report if not r["ok"]]
        ctr = [r for r in report if r.get("mode") == "contour"]
        if ctr:
            out.append("🧿 ชิ้นก้อนทึบ (ไม่ใช่เส้นอักษร) %d ชิ้น → เดินไฟตามโครงร่างแทนแกนกลาง: %s"
                       % (len(ctr), " · ".join("ชิ้นที่ %d" % r["idx"] for r in ctr[:6])))
        out.append("💡 นีออนเส้นเดี่ยว: วางเส้นแกนกลาง %d ชิ้น · ท่อไฟ %.0f มม. "
                   "(เกณฑ์เนื้ออักษรต้องกว้าง ≥ %.0f มม. = %.0f + เผื่อข้างละ %.0f) "
                   "· ร่องเซาะ CNC บนแผ่นรองหลังเดินตามเส้นนี้ ใช้ดอกกัด %.0f-%.0f มม. (ท่อ %.0f + เผื่อสอดท่อ)"
                   % (len(report), tube_mm, need, tube_mm, clear_mm,
                      tube_mm + 1.0, tube_mm + 2.0, tube_mm))
        if bad:
            lst = " · ".join("ชิ้นที่ %d กว้าง ~%.0f มม. (แคบสุด %.0f)"
                             % (r["idx"], r["med_mm"], r["min_mm"]) for r in bad[:8])
            if len(bad) > 8:
                lst += " · ..."
            out.append("⚠️ ท่อไฟ %.0f มม. วางจริงไม่ได้ %d ชิ้น — เส้นจะบวมชนกัน/ล้นขอบ: %s "
                       "→ แนะนำ ขยายป้ายให้ใหญ่ขึ้น หรือสลับชิ้นนั้นเป็น 'เส้นคู่ (ตามขอบ)' "
                       "(ระบบยังวาดเส้นให้ครบทุกชิ้นตามสั่ง)" % (tube_mm, len(bad), lst))
        return out
    except Exception:
        return []
