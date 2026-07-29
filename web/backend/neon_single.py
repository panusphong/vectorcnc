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


def _smooth_path(pts, closed=False, win_mm=1.2):
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
        res = 0.4
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
            out = list(LineString(out).simplify(0.06).coords)
        except Exception:
            pass
        return out
    except Exception:
        return pts


def _vor_centerline(polys, step=0.4):
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
            if blen <= max(3.0, 1.2 * wj):
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


def centerline(full, tube_mm=8.0, clear_mm=1.0):
    """คืน (subs, report)
       subs   = เส้นแกนกลางรูปแบบเดียวกับระบบ ({"start","segs","closed"} หน่วย มม.)
       report = [{"idx","min_mm","med_mm","ok","mode"}] เรียงชิ้นซ้าย->ขวา
       ล้มเหลวเมื่อไหร่ -> ([], []) ให้ผู้เรียก fallback วิธีเดิม (งานห้ามพัง)"""
    try:
        from shapely.geometry import LineString
        b = full.bounds
        W = b[2] - b[0]; H = b[3] - b[1]
        if W < 2.0 or H < 2.0:
            return [], []
        polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
        polys = [p for p in polys if p.geom_type == "Polygon" and not p.is_empty]
        polys.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))   # ซ้าย->ขวา คงที่
        if not polys:
            return [], []

        chains, pieces = _vor_centerline(polys)             # 🧮 แนวอ้างอิงจากขอบเวกเตอร์จริง
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
                    {"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": True})
            elif (not c["loop"]) and len(cc) >= 2:
                piece_paths.setdefault(pid, []).append(
                    {"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": False})

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
            # 🧿 ก้อนทึบ = หนามากเทียบท่อ หรือ 'อักษรเล็กแต่อ้วน' (เนื้อหนา ≥ 42% ของขนาดตัว
            #   และตัวใหญ่พอวางท่อตามโครงร่าง ≥ 2.5 เท่าท่อ — จุดจิ๋ว/ขีดสั้นยังเตือนแบบเดิม)
            _solid = (med > max(25.0, tube_mm * 3.0)) or (med > _bmin * 0.42 and _bmin >= tube_mm * 2.5)
            if _solid:
                for ring in [list(pg.exterior.coords)] + [list(h.coords) for h in pg.interiors]:
                    try:
                        rl = LineString(ring).simplify(0.12); cc = list(rl.coords)   # ตามขอบงานจริง
                    except Exception:
                        cc = ring
                    if len(cc) >= 3:
                        subs.append({"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": True})
                report.append({"idx": i + 1, "min_mm": round(mn, 1), "med_mm": round(med, 1),
                               "ok": True, "mode": "contour"})
            else:
                # 💡 เส้นเดี่ยวที่ 'ตรงตามตัวอักษรทุกตัว': เส้นขอบชุดเดียวกับเส้นคู่ ขยับเข้าครึ่งความหนา
                #    -> เส้นเดียววิ่งไล่ครบทุกส่วนของตัวอักษร (a มีพุง, e มีห่วง) เนียนเท่าขอบ
                #    ช่วงเส้นบางสองฝั่งจะทับกันเป็นเส้นเดียวใต้ท่อ 8 มม. พอดี
                q25 = ws[max(0, int(len(ws) * 0.25))]
                _rr = _inset_rings(pg, q25 * 0.5, tube_mm=tube_mm)
                if _rr:
                    for cc in _rr:
                        subs.append({"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": True})
                else:                                        # กันเหนียว: เส้นแกนกลาง
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
