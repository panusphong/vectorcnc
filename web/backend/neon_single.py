# -*- coding: utf-8 -*-
"""💡 neon_single — โมดูล 'นีออนเส้นเดี่ยว (แกนกลาง)' แยกไฟล์อิสระ

กติกาสำคัญของโมดูลนี้ (ตามคำสั่งพี่ 2026-07-29):
  * แยกออกจาก app.py เด็ดขาด — โค้ดเส้นตัดเดิมใน app.py ห้ามถูกแตะแม้แต่นิดเดียว
  * app.py เรียกเข้ามาที่ 'กิ่งนีออนเส้นเดี่ยว' จุดเดียวเท่านั้น
  * ถ้าโมดูลนี้ล้มเหลวไม่ว่ากรณีใด -> คืน ([], []) ให้ app.py ใช้วิธีเดิม (งานห้ามพัง)

หน้าที่:
  * centerline(full)      -> วางเส้นไฟที่ 'แกนกลางความหนาของตัวอักษรจริง' (medial axis)
                             คำนวณจากรูปที่จัดวางแล้ว (หน่วย มม.) เส้นจึงอยู่กึ่งกลาง stroke เสมอ
                             พร้อมวัดความกว้างเนื้ออักษรตลอดแนวต่อชิ้น เทียบท่อไฟจริง 8 มม.
                             ชิ้น 'ก้อนทึบ' (โลโก้/แบดจ์ ไม่ใช่เส้นอักษร) -> เดินไฟตามโครงร่างแทน
  * warn_messages(report) -> สร้างข้อความแจ้งเตือนตอนออกแบบ (💡/🧿/⚠️ ชิ้นที่แคบกว่า 10 มม.)
"""


def centerline(full, tube_mm=8.0, clear_mm=1.0):
    """คืน (subs, report)
       subs   = เส้นแกนกลางรูปแบบเดียวกับระบบ ({"start","segs","closed"} หน่วย มม.)
       report = [{"idx","min_mm","med_mm","ok","mode"}] เรียงชิ้นซ้าย->ขวา
       ล้มเหลวเมื่อไหร่ -> ([], []) ให้ผู้เรียก fallback วิธีเดิม"""
    try:
        import numpy as np
        from skimage.morphology import medial_axis
        from shapely.geometry import LineString
        from PIL import Image, ImageDraw
        b = full.bounds
        W = b[2] - b[0]; H = b[3] - b[1]
        if W < 2.0 or H < 2.0:
            return [], []
        pxmm = min(3.0, max(1.2, 2600.0 / max(W, H)))       # ~0.33-0.83 มม./พิกเซล
        w = int(W * pxmm) + 9; h = int(H * pxmm) + 9
        img = Image.new("L", (w, h), 0)
        lab = Image.new("I", (w, h), 0)
        dr = ImageDraw.Draw(img); dl = ImageDraw.Draw(lab)
        polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
        polys = [p for p in polys if p.geom_type == "Polygon" and not p.is_empty]
        polys.sort(key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))   # ซ้าย->ขวา คงที่

        def T(pt):
            return ((pt[0] - b[0]) * pxmm + 4.0, (pt[1] - b[1]) * pxmm + 4.0)
        for i, pg in enumerate(polys):
            dr.polygon([T(p) for p in pg.exterior.coords], fill=255)
            dl.polygon([T(p) for p in pg.exterior.coords], fill=i + 1)
            for hole in pg.interiors:
                dr.polygon([T(p) for p in hole.coords], fill=0)
                dl.polygon([T(p) for p in hole.coords], fill=0)
        mask = np.array(img) > 127
        if not mask.any():
            return [], []
        sk, dist = medial_axis(mask, return_distance=True)
        labarr = np.array(lab)
        if not sk.any():
            return [], []
        # ---- เดินตามเส้น skeleton -> เส้นทางพิกัด มม. ตรง ๆ ----
        fg = set(map(tuple, np.argwhere(sk)))

        def nbrs(r, c):
            o = []
            for dr2 in (-1, 0, 1):
                for dc2 in (-1, 0, 1):
                    if (dr2 or dc2) and (r + dr2, c + dc2) in fg:
                        o.append((r + dr2, c + dc2))
            return o
        # ✂️ ตัดกิ่งแขนงปลายเส้น (spur pruning) — แกนกลางของปลายอักษรเหลี่ยม/หัวโค้ง
        #    จะแตกเป็นง่ามสั้น ๆ ยาวประมาณครึ่งความกว้างเส้นอักษรเสมอ (ธรรมชาติของ medial axis)
        #    เกณฑ์: กิ่งที่งอกจากทางแยก แล้วสั้นกว่า ~1.2 เท่าของความกว้างอักษรตรงจุดแยก = ง่าม -> ตัดทิ้ง
        #    กิ่งจริงของตัวอักษร (เช่น แขนตัว F) ยาวกว่าความกว้างเส้นมาก -> ไม่โดนตัด
        _tot_px = {}                                # จำนวนพิกเซลแกนกลางต่อชิ้น (กันตัดจนตัวอักษรหาย)
        for (r0_, c0_) in fg:
            _pid = int(labarr[r0_, c0_])
            _tot_px[_pid] = _tot_px.get(_pid, 0) + 1
        _rem_px = {}
        for _pass in range(4):
            degp = {p: len(nbrs(*p)) for p in fg}
            leaves = [p for p in fg if degp.get(p) == 1]
            removed = False
            for lf in leaves:
                if lf not in fg:
                    continue
                branch = [lf]; prev = None; cur = lf; blen = 0.0; hit = None
                for _ in range(len(fg) + 5):
                    nx = [q for q in nbrs(*cur) if q != prev]
                    if not nx:
                        break                       # เส้นเดี่ยวโดด (จุด/ขีดสั้นทั้งชิ้น) -> ไม่ตัด
                    q = nx[0]
                    if len(nbrs(*q)) >= 3:
                        hit = q; break              # ถึงทางแยก
                    blen += (1.4142 if (q[0]-cur[0] and q[1]-cur[1]) else 1.0)
                    branch.append(q); prev, cur = cur, q
                    if blen / pxmm > 40.0:
                        break                       # ยาวเกินง่ามแน่ ๆ -> เลิกเดิน
                if hit is None:
                    continue
                wj = 2.0 * float(dist[hit[0], hit[1]]) / pxmm     # ความกว้างอักษร ณ จุดแยก (มม.)
                if (blen / pxmm) <= max(3.0, 1.2 * wj):
                    # 🛡️ ห้ามตัดกิ่งเกิน 45% ของเส้นทั้งชิ้น -> อักษรเล็กไม่มีทางถูกตัดจนหายทั้งตัว
                    _pid = int(labarr[lf[0], lf[1]])
                    if _rem_px.get(_pid, 0) + len(branch) > 0.45 * _tot_px.get(_pid, 1):
                        continue
                    _rem_px[_pid] = _rem_px.get(_pid, 0) + len(branch)
                    for p in branch:
                        fg.discard(p)
                    removed = True
            if not removed:
                break
        if not fg:
            return [], []
        deg = {p: len(nbrs(*p)) for p in fg}
        nodes = set(p for p in fg if deg[p] != 2)
        visited = set(); raw = []
        for st in (list(nodes) if nodes else [next(iter(fg))]):
            for n in nbrs(*st):
                if (st, n) in visited:
                    continue
                path = [st]; prev, cur = st, n; visited.add((st, n)); visited.add((n, st)); guard = 0
                while True:
                    path.append(cur)
                    if cur in nodes and cur != st:
                        break
                    if cur == st or guard > len(fg) + 5:
                        break                               # 🛡️ กันวงวนกลับจุดเริ่ม/เดินเกินจำนวนพิกเซล -> ไม่มีทางวนค้าง
                    guard += 1
                    nx = [q for q in nbrs(*cur) if q != prev]
                    if not nx:
                        break
                    prev, cur = cur, nx[0]; visited.add((prev, cur)); visited.add((cur, prev))
                if len(path) >= 2:
                    raw.append(path)
        for st in fg:                                      # วงปิด (O, รูใน)
            for n in nbrs(*st):
                if (st, n) in visited:
                    continue
                path = [st]; prev, cur = st, n; visited.add((st, n)); visited.add((n, st)); guard = 0
                while cur != st and guard < len(fg) + 5:
                    guard += 1; path.append(cur)
                    nx = [q for q in nbrs(*cur) if q != prev]
                    if not nx:
                        break
                    prev, cur = cur, nx[0]; visited.add((prev, cur)); visited.add((cur, prev))
                path.append(st)
                if len(path) >= 4:
                    raw.append(path)
        if not raw:
            return [], []

        def mp(p):                                          # (row,col) พิกเซล -> มม. จริง
            return (b[0] + (p[1] - 4.0) / pxmm, b[1] + (p[0] - 4.0) / pxmm)
        spur = max(6.0, tube_mm * 0.75)                     # ตัดหนวดสั้นตามขนาดท่อจริง
        piece_paths = {}                                    # idx ชิ้น -> [subs ของแกนกลาง]
        pieces = {}                                         # idx ชิ้น -> รายการความกว้าง (มม.)
        for path in raw:
            wid = [2.0 * float(dist[r, c]) / pxmm for (r, c) in path]
            pids = [int(labarr[r, c]) for (r, c) in path]
            _pv = [p for p in pids if p > 0]
            pid_main = max(set(_pv), key=_pv.count) if _pv else 0
            for pid, wv in zip(pids, wid):
                if pid > 0:
                    pieces.setdefault(pid, []).append(wv)
            pts = [mp(p) for p in path]
            try:
                ls = LineString(pts).simplify(0.3)
                if ls.length < spur and len(path) < int(spur * pxmm) + 2:
                    continue                                # หนวดสั้น: นับความกว้างแล้ว ไม่วาด
                cc = list(ls.coords)
            except Exception:
                cc = pts
            if len(cc) >= 2 and pid_main > 0:
                piece_paths.setdefault(pid_main, []).append(
                    {"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": False})
        report = []; subs = []
        need = tube_mm + 2.0 * clear_mm
        for i, pg in enumerate(polys):
            ws = sorted(pieces.get(i + 1, []))
            if not ws:
                continue
            k = max(0, int(len(ws) * 0.10))                 # ตัดปลายแหลม 10% ล่าง (ปลาย stroke เรียวตามธรรมชาติ)
            med = ws[len(ws) // 2]; mn = ws[k]
            pbb = pg.bounds
            _bmin = min(pbb[2] - pbb[0], pbb[3] - pbb[1])
            # 🧿 ชิ้น 'ก้อนทึบ' (ไม่ใช่เส้น stroke): แกนกลางจะแตกเป็นก้านแฉก ใช้ไม่ได้จริง
            #    -> เดินไฟตาม 'โครงร่าง' ของชิ้นแทน (แบบเดียวกับโหมดเส้นคู่ เฉพาะชิ้นนี้)
            # ก้อนทึบ = หนามากเมื่อเทียบท่อ หรือ 'อักษรเล็กแต่อ้วน' (เนื้อหนา ≥ 42% ของขนาดตัว
            #   และตัวใหญ่พอวางท่อตามโครงร่างได้จริง ≥ 2.5 เท่าท่อ — จุดจิ๋ว/ขีดสั้นยังคงเตือนแบบเดิม)
            _solid = (med > max(25.0, tube_mm * 3.0)) or (med > _bmin * 0.42 and _bmin >= tube_mm * 2.5)
            if _solid:
                for ring in [list(pg.exterior.coords)] + [list(h.coords) for h in pg.interiors]:
                    try:
                        rl = LineString(ring).simplify(0.3); cc = list(rl.coords)
                    except Exception:
                        cc = ring
                    if len(cc) >= 3:
                        subs.append({"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": True})
                report.append({"idx": i + 1, "min_mm": round(mn, 1), "med_mm": round(med, 1),
                               "ok": True, "mode": "contour"})
            else:
                subs.extend(piece_paths.get(i + 1, []))
                report.append({"idx": i + 1, "min_mm": round(mn, 1), "med_mm": round(med, 1),
                               "ok": (med + 1e-6) >= need and (mn + 1e-6) >= tube_mm, "mode": "center"})
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
