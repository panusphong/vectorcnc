# -*- coding: utf-8 -*-
"""🗺️ vectora_planar — ไล่เส้นแบบ "แผนที่ภูมิภาคระนาบ + ขอบร่วม"

═══════════════════════════════════════════════════════════════════════
ทำไมต้องมีไฟล์นี้ (สรุปที่มา 2026-08-15)
═══════════════════════════════════════════════════════════════════════
วิธีเดิม (VTracer / ไล่สีทีละสีแล้ววางซ้อนกัน) มีข้อจำกัดเชิงโครงสร้าง 3 ข้อ
ที่แก้ด้วยการจูนค่าไม่ได้เลย ไม่ว่าจะจูนกี่รอบ:

  1. ขอบระหว่างสองสีถูกลากขึ้นมา **สองครั้ง คนละเส้น** -> ไม่ตรงกันเป๊ะ
     เกิดรอยต่อบาง ๆ ที่ตาเห็นเป็น "ยึกยือ"
  2. รวมชิ้นสีเดียวกันไม่ได้ เพราะกติกา even-odd ของ SVG หักล้างส่วนที่ซ้อนกัน
     เป็นรูโหว่ (ลองมาแล้ว 3 วิธี พังทั้งหมด)
  3. ชิ้นแตกเป็นเศษนับหมื่น (วัดจริง 10,608 ชิ้นในภาพเดียว)

วิธีนี้ทำแบบที่ Adobe Illustrator Image Trace กับ vectorizer.ai ทำ:
  แบ่งภาพเป็น "ภูมิภาค" ที่ **ไม่ซ้อนกันเลย** ก่อน แล้วขอบระหว่างสองภูมิภาค
  คือ **เส้นเดียว** ลากครั้งเดียว ฟิตครั้งเดียว ทั้งสองฝั่งใช้ร่วมกัน
  -> ไม่มีรอยต่อ ไม่มีเงาแทรก ไม่มี even-odd หักล้าง โดยโครงสร้าง

วัดจริงบนภาพตรา USERS' CHOICE (554 px) เทียบวิธีเดิม:
  จำนวนชิ้น 10,608 -> 114 · ΔE เนื้อสี 2.16 -> 1.97 · ΔE ขอบ 8.49 -> 7.06
  ความคม 573 -> 599 · เฉพาะขั้นนี้ 60 วิ -> 20 วิ

🔒 ใช้เฉพาะโหมดไล่สี (grad=True) เท่านั้น · โหมดปกติไม่แตะแม้แต่บรรทัดเดียว
🔒 พื้นไล่สีใช้ของเดิมเป๊ะ — ไฟล์นี้ทำเฉพาะ "ย่านลาย" (keep)
═══════════════════════════════════════════════════════════════════════
"""
import math
import time
import heapq
import numpy as np
import cv2

try:
    from . import vectora_engine as VE
except Exception:
    import vectora_engine as VE


# ══════════════════════════════════════════════════════════════════
# ค่าตั้ง — ทุกตัวมาจากการวัดจริง อย่าขยับโดยไม่วัด (ดูหมายเหตุท้ายไฟล์)
# ══════════════════════════════════════════════════════════════════
K_COLORS = 20          # จำนวนสีตั้งต้นของย่านลาย
MIN_AREA_FRAC = 1.0 / 200000.0   # ภูมิภาคเล็กกว่านี้ถูกกลืน (สัดส่วนของพื้นที่ภาพ)
DE_MERGE = 22.0        # รวมเพื่อนบ้านที่สีใกล้กันกว่านี้
THIN = 1.4             # เกณฑ์ "วงแหวนเงา" (พื้นที่ ÷ เส้นรอบรูป)
REGUL = 10             # จำนวนรอบเกลาแผนที่ภูมิภาคระดับพิกเซล
REGUL_THR = 5          # ต้องมีเพื่อนบ้านกี่เสียงจาก 8 ถึงจะพลิกตาม
BG_ID = [-1]           # id ของ 'พื้นไล่สีที่รวมเป็นก้อนเดียว' (-1 = ไม่มี)
PAL_SNAP = 1           # ดึงสีทุกชิ้นเข้าจานสีของเอนจิ้น (0 = ใช้สีเฉลี่ยจริง)
CORE_FIT = 2           # กร่อนขอบกี่ชั้นก่อนเฉลี่ยสีของภูมิภาค (0 = ปิด)
CORE_MIN = 12          # ต้องเหลือเนื้อในกี่พิกเซลถึงจะใช้สีใหม่
SNAP_SMALL = 0.0006    # ชิ้นที่เล็กกว่าสัดส่วนนี้ของภาพ ให้ดึงสีเข้าจานเสมอ (0 = ปิด)
# 🧽 กลืนเศษ "สีผสมที่ขอบ" (ดูหมายเหตุยาวใน planar_layers)
# ⛔ ปิดทางเลือก "ยุบตามพื้นที่" ไว้ (0) — วัดจริง 2026-08-18 กับภาพเส้นหนา (test-06)
#    ชิ้นเล็กที่เป็นรายละเอียดจริงถูกกลืนไปด้วย: ชิ้น 119 -> 7 · ΔE ขอบ 14.62 -> 17.62
#    เหลือไว้เฉพาะทาง "ยุบตามความบาง" ซึ่งเจาะจงกับขลิบขอบจริง ๆ และวัดแล้วไม่กระทบภาพอื่น
BLEND_AREA = 0.0       # ชิ้นเล็กกว่าสัดส่วนนี้ของภาพเท่านั้นที่พิจารณา (0 = ปิด)
BLEND_COVER = 0.85     # เพื่อนบ้านสองรายแรกต้องกินขอบรวมกันอย่างน้อยเท่านี้
BLEND_T = 0.18         # สีต้องอยู่ "กลาง ๆ" ระหว่างสองราย ไม่ใช่ชิดปลาย
BLEND_DE = 9.0         # และห่างจากเส้นเชื่อมสองสีไม่เกินนี้ (หน่วย Lab)
BLEND_THIN = 3.0       # พื้นที่ ÷ เส้นรอบรูป ต่ำกว่านี้ = "ขลิบบาง" (0 = ปิด)
BLEND_BIG = 4.0        # ชิ้นบางจะยุบได้ ต่อเมื่อเพื่อนบ้านทั้งสองใหญ่กว่ากี่เท่า
# ⚠️ วัดจริง 2026-08-18: ขลิบซีดรอบวงกลมขาวมีเพื่อนบ้านหลักคลุมขอบแค่ 78%
#    (ที่เหลือคือใบไม้ที่มาแตะ) เกณฑ์ 85% จึงไม่ผ่าน ทั้งที่มันคือขลิบขอบชัด ๆ
BLEND_COVER_THIN = 0.70
SLIVER = 0.0           # ⛔ ปิดไว้ — วัดแล้วกินรายละเอียดจริง (ΔE ขอบ 7.10 -> 7.41)

LOOK = 10              # หน้าต่างหามุม (จุด)
LOOK_MIN = 10
BUDGET = 1.7           # งบขยับตอนเกลา (พิกเซล)
BUDGET_MIN = 1.7
PASSES = 14
TAUBIN = 1             # เกลาแบบไม่หดรูป (ดูหมายเหตุใน smooth_open)
TAU_L = 0.55
TAU_M = -0.58
SUBPIX = 1
OFF_SMOOTH = 2.0       # เกลา "ระยะขยับ" ไม่ใช่ "ตำแหน่งจุด"
OFF_MED = 0            # ⛔ ปิด — วัดแล้ว ΔE ขอบแย่ลง 7.13 -> 7.22
SNAKE_IT = 3           # รอบสลับ "เกลา <-> เกาะขอบจริง"
SNAKE_BD = 1.2
SNAKE_PS = 6
FREE_ENDS = 1          # ปล่อยปลายอิสระ แล้วค่อยเฉลี่ยจุดต่อทีหลัง
FINAL_CAP = 1.4
FINAL_SPAN = 1.8
TOL = 0.4              # ค่าคลาดที่ยอมตอนฟิตเบซิเยร์ (พิกเซลภาพงาน)
CURVE_IT = 2           # รอบ "ฟิตโค้ง -> วัดว่าโค้งเองเกาะขอบไหม -> ฟิตใหม่"

LINE_TOL = 1.2         # เกณฑ์ "ตรง"
LINE_Q = 0.9           # ใช้ควอนไทล์ ไม่ใช่ค่าสูงสุด (ทนรอยบีบอัด JPEG)
LINE_QMAX = 2.5        # แต่จุดหลุดสุดต้องไม่เกินกี่เท่าของเกณฑ์
LINE_MIN = 18          # ช่วงตรงต้องยาวกี่จุด
LINE_MIN2 = 10         # ยกเว้นช่วงที่ถูกขนาบด้วยเส้นตรงทั้งสองข้าง
TURN_MAX = 1.5         # ⚠️ ตัวนี้ละเอียดอ่อนที่สุด — 3.0 ทำให้ตัว O เป็นเหลี่ยม
TRIM_TOL = 0.6         # หดปลายช่วงตรงกลับ กันกลืนมุม
TAPER = 8              # ค่อย ๆ กลืนเข้าหาเส้นตรงที่ปลายช่วง
CORNER_GAP = 14
CORNER_MAX = 8.0
STEP_MAX = 2.5         # รวมเส้นตรงสองท่อนที่ขนานและเยื้องกันนิดเดียว
STEP_ANG = 4.0
STEP_GAP = 24
CIRC_TOL = 1.6         # เกณฑ์ทาบวงกลม
# ⭕ เกณฑ์ "ทาบวงแบบทนจุดหลุด" — วงกลมจริงที่มีจุดสะดุดไม่กี่จุดต้องยังทาบได้
#    ⚠️ วัดจริง 2026-08-17: ขอบในของวงแหวนขอบวงกลมขาว ค่าคลาดสูงสุด 3.55
#       แต่ควอนไทล์ 90 แค่ 0.91 -> คือวงกลมจริงที่มีจุดหลุดไม่กี่จุด
#       เกณฑ์เดิมดูค่าสูงสุดอย่างเดียว จึงไม่ทาบ ปล่อยขอบกระเพื่อมทั้งวง
# ⚠️ เปิดอีกครั้ง 2026-08-18 พร้อมเกณฑ์ความยาวขั้นต่ำ (CIRC_QMIN)
#    เหตุ: พอกลืนขลิบขอบทิ้ง ขอบวงกลมกลายเป็นโซ่เดียวยาว 4,477 จุด ค่าคลาดสูงสุด 2.16
#    ซึ่งเกินเกณฑ์เดิม 1.6 -> ทาบวงไม่ผ่าน -> ตกไปทางหาเส้นตรง ได้ 113 ท่อน = ขั้นบันได
CIRC_Q = 90.0          # ใช้ควอนไทล์นี้แทนค่าสูงสุดในการตัดสิน (0 = ปิด)
CIRC_QMIN = 600        # ใช้เกณฑ์ทนจุดหลุดเฉพาะโซ่ที่ยาวเกินนี้
CIRC_SOFT = 2.5        # โซ่ยาวที่ควอนไทล์ 90 ไม่เกิน CIRC_TOL*ค่านี้ = ฟิตโค้งล้วน
CIRC_MAX = 6.0         # แต่จุดที่หลุดสุดก็ต้องไม่เกินนี้
CIRC_OUT = 0.06        # สัดส่วนจุดหลุดสูงสุดที่ยอมได้
CIRC_RUN = 10          # จุดหลุดต่อกันยาวเกินนี้ = ของจริง (บิ่น/เว้า) ห้ามทาบ
# 🤝 "วงเดียวกัน" ที่ถูกจุดต่อหั่นเป็นหลายท่อน ต้องกลับมาใช้วงกลมวงเดียวกัน
CIRC_SAME = 2.0        # ศูนย์กลาง/รัศมีต่างกันไม่เกินนี้ = วงเดียวกัน
CIRC_MINPTS = 60       # โซ่สั้นกว่านี้ไม่เอามาร่วมตัดสิน
ARC_MIN = 8
ARC_TURN = 6.0
ARC_SPAN = 60
TH_SIG = 0.0           # ⛔ ปิด — เกลาในปริภูมิทิศทาง วัดแล้ว ΔE ขอบ 7.00 -> 9.16
TH_CORNER = 34.0
TH_STEP = 1.0
G1 = 0                 # ⛔ ไม่จำเป็น — _schneider ทำ G1 ให้อยู่แล้วตั้งแต่แรก
LINE_REL = 0.0
DIRS = {}


def build(work, keep=None, dom=None, K=16, min_area_frac=1.0 / 40000.0, de_merge=9.0,
          target=140, de_hard=26.0, thin=0.0, seed=0, cen=None, min_area_px=0.0):
    H, W = work.shape[:2]
    t0 = time.time()
    lab = VE.labf(cv2.cvtColor(work, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.uint8))
    rng = np.random.default_rng(seed)
    pool = (np.flatnonzero(keep.reshape(-1)) if keep is not None
            else np.arange(len(lab)))
    if cen is None:
        take = (pool if len(pool) <= 300000
                else pool[rng.choice(len(pool), 300000, replace=False)])
        cen, _ = VE._kmeans_lab(lab[take].astype(np.float32), K, seed=seed)
    cen = np.asarray(cen, np.float32)
    q = np.empty(len(lab), np.int32)
    for s in range(0, len(lab), 400000):
        e = min(len(lab), s + 400000)
        q[s:e] = ((lab[s:e, None, :] - cen[None, :, :]) ** 2).sum(2).argmin(1)
    q = q.reshape(H, W)
    if dom is not None:
        q = np.where(dom, q, -1)

    # ── ขั้น 1: ชิ้นส่วนเชื่อมต่อของแต่ละสี = ภูมิภาค ──────────────────
    reg = np.zeros((H, W), np.int32)
    nxt = 1
    for c in range(len(cen)):
        m = (q == c).astype(np.uint8)
        if not m.any():
            continue
        n, lb = cv2.connectedComponents(m, connectivity=8)
        reg[m > 0] = lb[m > 0] + nxt
        nxt += n
    N = nxt + 1
    n_cc = int(np.unique(reg).size) - 1
    t1 = time.time()

    flat = reg.reshape(-1)
    area = np.bincount(flat, minlength=N).astype(np.float64)
    sums = np.zeros((N, 3), np.float64)
    for ch in range(3):
        sums[:, ch] = np.bincount(flat, weights=lab[:, ch], minlength=N)
    nz = area > 0
    mean = np.zeros((N, 3), np.float64)
    mean[nz] = sums[nz] / area[nz, None]
    area[0] = 0.0                                  # 0 = นอกย่านลาย ห้ามรวมเข้าไป

    # ── กราฟเพื่อนบ้าน + ความยาวขอบร่วม ───────────────────────────────
    def prs(a, b):
        m = (a != b) & (a > 0) & (b > 0)
        x, y = a[m].astype(np.int64), b[m].astype(np.int64)
        return np.minimum(x, y) * N + np.maximum(x, y)

    key = np.concatenate([prs(reg[:, :-1], reg[:, 1:]),
                          prs(reg[:-1, :], reg[1:, :])])
    key, cnt = np.unique(key, return_counts=True)
    adj = [dict() for _ in range(N)]
    for k, c in zip(key.tolist(), cnt.tolist()):
        a, b = divmod(k, N)
        adj[a][b] = c; adj[b][a] = c
    t2 = time.time()

    parent = np.arange(N)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    ver = np.zeros(N, np.int64)

    def union(a, b):
        if area[a] < area[b]:
            a, b = b, a
        parent[b] = a
        w = area[a] + area[b]
        mean[a] = (mean[a] * area[a] + mean[b] * area[b]) / max(1.0, w)
        area[a] = w
        for nb, c in adj[b].items():
            r = find(nb)
            if r == a:
                continue
            adj[a][r] = adj[a].get(r, 0) + c
            adj[r].pop(b, None)
            adj[r][a] = adj[r].get(a, 0) + c
        adj[a].pop(b, None)
        adj[b] = {}
        ver[a] += 1; ver[b] = -1
        return a

    # 2a: กลืนภูมิภาคจิ๋ว (ขอบร่วมยาวสุดชนะ)
    min_area = (float(min_area_px) if min_area_px > 0
                else max(6.0, float(H) * W * min_area_frac))
    order = sorted((r for r in range(1, N) if area[r] > 0), key=lambda r: area[r])
    for r in order:
        if find(r) != r or area[r] >= min_area or not adj[r]:
            continue
        b = find(max(adj[r].items(), key=lambda kv: kv[1])[0])
        if b != r and area[b] > 0:
            union(b, r)
    n_small = sum(1 for r in range(1, N) if find(r) == r and area[r] > 0)

    # 2c: ละลาย "วงแหวนเงา" — ชิ้นที่บาง (พื้นที่ ÷ เส้นรอบรูป ต่ำ) ไม่ใช่รูปทรงจริง
    #     มันคือสีกลางทางระหว่างสองสีที่ถูกไล่เส้นออกมาเป็นชั้นจริง
    #     ยุบเข้าเพื่อนบ้านที่สีใกล้ที่สุด -> เงาหายโดยไม่ต้องไล่ลบทีละอัน
    if thin > 0:
        for _ in range(4):
            cand = []
            for r in range(1, N):
                if find(r) != r or area[r] <= 0 or not adj[r]:
                    continue
                per = float(sum(adj[r].values()))
                if per <= 0 or area[r] / per >= thin:
                    continue
                # 🎯 "บาง" อย่างเดียวไม่พอ — เส้นตัวอักษรเล็กก็บาง ห้ามลบเด็ดขาด
                #    วงแหวนเงาต่างตรง "สีอยู่กึ่งกลางระหว่างสองเพื่อนบ้านที่มันคั่นอยู่"
                nb = {}
                for x, c in adj[r].items():
                    s = find(x)
                    if s != r and area[s] > 0:
                        nb[s] = nb.get(s, 0) + c
                if len(nb) < 2:
                    continue
                top = sorted(nb.items(), key=lambda kv: -kv[1])[:2]
                a1, a2 = top[0][0], top[1][0]
                if top[1][1] < 0.15 * per:
                    continue
                u = mean[a2] - mean[a1]
                L2 = float((u * u).sum())
                if L2 < 1e-6:
                    continue
                v = mean[r] - mean[a1]
                t = float((v * u).sum()) / L2
                perp = float(np.sqrt(max(0.0, (v * v).sum() - t * t * L2)))
                if 0.15 <= t <= 0.85 and perp <= 0.20 * np.sqrt(L2):
                    cand.append((area[r] / per, r, a1 if t < 0.5 else a2))
            if not cand:
                break
            cand.sort(key=lambda z: z[0])
            done = 0
            for _s, r, b in cand:
                if find(r) != r or find(b) != b or b == r or area[b] <= 0:
                    continue
                union(b, r); done += 1
            if not done:
                break
    # 2d: เศษเสี้ยน — บาง **และ** เล็ก = ไม่ใช่รูปทรงจริงแน่นอน กลืนเข้าเพื่อนบ้านที่ขอบยาวสุด
    #     (ตัวอักษรไม่โดน เพราะเส้นตัวอักษรหนา ~8 จุด -> พื้นที่/เส้นรอบรูป ~4 สูงกว่าเกณฑ์มาก)
    if SLIVER > 0:
        for _ in range(3):
            done = 0
            for r in range(1, N):
                if find(r) != r or area[r] <= 0 or not adj[r]:
                    continue
                per = float(sum(adj[r].values()))
                if per <= 0 or area[r] / per >= SLIVER or area[r] >= min_area * SLIVER_A:
                    continue
                b = find(max(adj[r].items(), key=lambda kv: kv[1])[0])
                if b != r and area[b] > 0:
                    union(b, r); done += 1
            if not done:
                break
    n_thin = sum(1 for r in range(1, N) if find(r) == r and area[r] > 0)
    t3 = time.time()

    # 2b: รวมเพื่อนบ้านสีใกล้กัน (agglomerative บน RAG, heap แบบ lazy)
    def de(a, b):
        return float(np.sqrt(((mean[a] - mean[b]) ** 2).sum()))

    heap = []
    roots = [r for r in range(1, N) if find(r) == r and area[r] > 0]
    for r in roots:
        for nb in adj[r]:
            s = find(nb)
            if s > r:
                heapq.heappush(heap, (de(r, s), r, s, ver[r], ver[s]))
    live = len(roots)
    while heap:
        d, a, b, va, vb = heapq.heappop(heap)
        if ver[a] != va or ver[b] != vb or find(a) != a or find(b) != b:
            continue
        if b not in adj[a]:
            continue
        if d > de_merge and (live <= target or d > de_hard):
            break
        root = union(a, b); live -= 1
        for nb in list(adj[root]):
            s = find(nb)
            if s != root:
                lo, hi = min(root, s), max(root, s)
                heapq.heappush(heap, (de(root, s), lo, hi, ver[lo], ver[hi]))
    t4 = time.time()

    lut = np.array([find(i) for i in range(N)], np.int32)
    lut[0] = 0
    reg2 = lut[reg]
    if REGUL > 0:
        reg2 = regularize(reg2, REGUL, REGUL_THR)
    return dict(reg=reg2, mean=mean, area=area, n=live, n_cc=n_cc, n_small=n_small,
                n_thin=n_thin,
                t=(t1 - t0, t2 - t1, t3 - t2, t4 - t3))


def regularize(reg, iters=2, thr=5):
    """เกลา 'แผนที่ภูมิภาค' ระดับพิกเซล — ลบปุ่ม/รอยแหว่งขนาด 1 พิกเซลออกก่อนไล่เส้น

    ⚠️ ที่ตัวอักษรจิ๋วยังหยัก ไม่ใช่เพราะฟิตเส้นไม่ดี แต่เพราะ 'แผนที่ภูมิภาค' หยักเอง
       พิกเซลริมขอบตัวอักษรเป็นสีกลางทาง พอควอนไทซ์เลยพลิกไปมาตามคลื่นรบกวน JPEG
       ต่อให้เกลาเส้นทีหลังแค่ไหน ก็ได้แค่ 'ปุ่มที่เกลาแล้ว' — ต้องลบปุ่มตั้งแต่ตรงนี้
    ✅ โหวตเสียงข้างมากใน 3x3: ถ้าเพื่อนบ้าน >= thr ตัวเป็นภูมิภาคเดียวกันหมด ให้ตามเขา
       เส้นหนา 7 พิกเซลไม่โดนกิน (พิกเซลข้างในมีพวกเยอะกว่า) แต่ปุ่มเดี่ยว ๆ หายเกลี้ยง
    """
    R = reg.copy()
    H, W = R.shape
    for _ in range(int(iters)):
        P = np.zeros((H + 2, W + 2), R.dtype)
        P[1:-1, 1:-1] = R
        P[0, 1:-1] = R[0]; P[-1, 1:-1] = R[-1]
        P[:, 0] = P[:, 1]; P[:, -1] = P[:, -2]
        nb = np.stack([P[a:a + H, b:b + W]
                       for a in (0, 1, 2) for b in (0, 1, 2)
                       if not (a == 1 and b == 1)], -1)          # (H,W,8)
        same = (nb == R[:, :, None]).sum(-1)
        edge = same < 8
        if not edge.any():
            break
        V = nb[edge]                                              # (M,8)
        V = np.sort(V, axis=1)
        best = np.zeros(len(V), R.dtype); cnt = np.zeros(len(V), np.int32)
        run = np.ones(len(V), np.int32); cur = V[:, 0].copy()
        for c in range(1, 8):
            eq = V[:, c] == V[:, c - 1]
            run = np.where(eq, run + 1, 1)
            cur = V[:, c]
            up = run > cnt
            cnt = np.where(up, run, cnt)
            best = np.where(up, cur, best)
        take = (cnt >= thr) & (best != R[edge])
        if not take.any():
            break
        idx = np.flatnonzero(edge.reshape(-1))[take]
        Rf = R.reshape(-1); Rf[idx] = best[take]
        R = Rf.reshape(H, W)
    return R


def half_edges(reg):
    """คืน (SRC, DST, REG) ของครึ่งขอบทุกเส้น — ครึ่งขอบหนึ่งเส้นเป็นของภูมิภาคเดียว"""
    H, W = reg.shape
    Z = np.zeros((1, W), reg.dtype)
    UP = np.vstack([Z, reg]); DN = np.vstack([reg, Z])          # (H+1, W)
    Zc = np.zeros((H, 1), reg.dtype)
    LF = np.hstack([Zc, reg]); RT = np.hstack([reg, Zc])        # (H, W+1)
    S = []; D = []; R = []
    m = UP != DN
    i, j = np.nonzero(m)
    n0 = i.astype(np.int64) * (W + 1) + j; n1 = n0 + 1
    u = UP[m]; d = DN[m]
    k = u > 0; S.append(n0[k]); D.append(n1[k]); R.append(u[k])   # ภูมิภาคอยู่ "บน" -> วิ่งขวา
    k = d > 0; S.append(n1[k]); D.append(n0[k]); R.append(d[k])   # อยู่ "ล่าง" -> วิ่งซ้าย
    m = LF != RT
    i, j = np.nonzero(m)
    n0 = i.astype(np.int64) * (W + 1) + j; n1 = n0 + (W + 1)
    l = LF[m]; r = RT[m]
    k = r > 0; S.append(n0[k]); D.append(n1[k]); R.append(r[k])   # อยู่ "ขวา" -> วิ่งลง
    k = l > 0; S.append(n1[k]); D.append(n0[k]); R.append(l[k])   # อยู่ "ซ้าย" -> วิ่งขึ้น
    return (np.concatenate(S), np.concatenate(D), np.concatenate(R).astype(np.int64))


def junctions(reg):
    """โหนดที่มีภูมิภาคมาชนกัน >= 3 = จุดต่อ (ต้องตรึงไว้ ห้ามเกลาข้าม)"""
    H, W = reg.shape
    P = np.zeros((H + 2, W + 2), reg.dtype); P[1:-1, 1:-1] = reg
    a = P[:-1, :-1]; b = P[:-1, 1:]; c = P[1:, :-1]; d = P[1:, 1:]
    cnt = (1 + (b != a).astype(np.int8)
           + ((c != a) & (c != b)).astype(np.int8)
           + ((d != a) & (d != b) & (d != c)).astype(np.int8))
    return (cnt >= 3).reshape(-1)


def trace(reg):
    """คืน {ภูมิภาค: [วง (ลิสต์ของโหนด)]}"""
    H, W = reg.shape
    S, D, R = half_edges(reg)
    order = np.argsort(R, kind="stable")
    S, D, R = S[order], D[order], R[order]
    bnd = np.searchsorted(R, np.unique(R), side="left").tolist() + [len(R)]
    uniq = np.unique(R).tolist()
    out = {}
    step = {1: 0, -1: 2, (W + 1): 1, -(W + 1): 3}                # 0=ขวา 1=ลง 2=ซ้าย 3=ขึ้น
    for qi, r in enumerate(uniq):
        s0, s1 = bnd[qi], bnd[qi + 1]
        src = S[s0:s1]; dst = D[s0:s1]
        adj = {}
        for e in range(len(src)):
            adj.setdefault(int(src[e]), []).append(e)
        used = np.zeros(len(src), bool)
        loops = []
        for e0 in range(len(src)):
            if used[e0]:
                continue
            loop = []; e = e0
            while not used[e]:
                used[e] = True
                loop.append(int(src[e]))
                v = int(dst[e]); din = step[int(dst[e] - src[e])]
                cand = [x for x in adj.get(v, ()) if not used[x]]
                if not cand:
                    break
                if len(cand) == 1:
                    e = cand[0]
                else:                                    # จุดกากบาท -> เลี้ยวซ้ายไว้ก่อน
                    pri = {(din + 3) % 4: 0, din: 1, (din + 1) % 4: 2, (din + 2) % 4: 3}
                    e = min(cand, key=lambda x: pri.get(step[int(dst[x] - src[x])], 9))
            if len(loop) >= 4:
                loops.append(loop)
        out[int(r)] = loops
    return out


def _pt(n, W):
    return (float(n % (W + 1)), float(n // (W + 1)))


def _bil(img, X, Y):
    """สุ่มค่าภาพแบบ bilinear (X,Y = พิกัดพิกเซล ไม่ใช่พิกัดมุม)"""
    H, W = img.shape[:2]
    x = np.clip(X, 0, W - 1.001); y = np.clip(Y, 0, H - 1.001)
    x0 = np.floor(x).astype(np.int32); y0 = np.floor(y).astype(np.int32)
    fx = (x - x0)[..., None]; fy = (y - y0)[..., None]
    a = img[y0, x0]; b = img[y0, x0 + 1]; c = img[y0 + 1, x0]; d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
            + c * (1 - fx) * fy + d * fx * fy)


def subpixel(P, LA, LB, lab, closed, span=1.6, ns=17, cap=1.25, osm=None,
             lb_local=False):
    if not SUBPIX:
        return P
    """เลื่อนจุดขอบไปที่ 'ตำแหน่งจริงระดับย่อยพิกเซล'

    ⚠️ จุดอ่อนของการไล่ตามตารางมุมพิกเซล: ขอบเป็นขั้นบันไดจำนวนเต็มเสมอ
       ต่อให้เกลาแค่ไหนก็ได้แค่ 'ขั้นบันไดที่เกลาแล้ว' ไม่ใช่ขอบจริง
    ✅ ฉายสีของภาพลงบนแกน A→B แล้วหาจุดที่ข้าม 0.5 ตามแนวตั้งฉาก
       = ตำแหน่งขอบจริงที่ตาเห็น (สิ่งที่ vectorizer.ai เรียกว่า sub-pixel edge)
    """
    if len(P) < 4:
        return P
    T = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    if not closed:
        T[0] = P[1] - P[0]; T[-1] = P[-1] - P[-2]
    n = np.stack([-T[:, 1], T[:, 0]], 1)
    ln = np.hypot(n[:, 0], n[:, 1])
    n = n / np.maximum(ln, 1e-9)[:, None]
    # 🌈 ฝั่งที่เป็นพื้นไล่สี: สีเฉลี่ยของทั้งภูมิภาคใช้ไม่ได้ เพราะสีเปลี่ยนไปทั้งวง
    #    ⚠️ นี่คือเหตุที่ขอบวงกลมขาว "ยึกยือ" — จุดข้าม 0.5 ถูกคำนวณจากสีที่ผิด
    #       และผิดคนละแบบในแต่ละช่วง -> ขอบเลื่อนไปคนละทิศรอบวง
    # ✅ อ่านสีของอีกฝั่งจากภาพจริง ณ จุดนั้น ๆ (ถอยออกไปตามแนวตั้งฉาก)
    if lb_local:
        LBv = _bil(lab, P[:, 0] + n[:, 0] * 3.0 - 0.5, P[:, 1] + n[:, 1] * 3.0 - 0.5)
        LAv = np.broadcast_to(np.asarray(LA, np.float64), LBv.shape)
    else:
        LBv = np.broadcast_to(np.asarray(LB, np.float64), (len(P), 3))
        LAv = np.broadcast_to(np.asarray(LA, np.float64), (len(P), 3))
    u = LBv - LAv
    L2 = (u * u).sum(1)
    if float(np.median(L2)) < 4.0:
        return P
    L2 = np.maximum(L2, 1e-6)
    ts = np.linspace(-span, span, ns)
    X = P[:, 0][:, None] + n[:, 0][:, None] * ts[None, :] - 0.5
    Y = P[:, 1][:, None] + n[:, 1][:, None] * ts[None, :] - 0.5
    S = _bil(lab, X, Y)                                  # (n, ns, 3)
    f = ((S - LAv[:, None, :]) * u[:, None, :]).sum(2) / L2[:, None] - 0.5
    off = np.zeros(len(P))
    mid = ns // 2
    for k in range(1, mid + 1):
        for a, b in ((mid - k, mid - k + 1), (mid + k - 1, mid + k)):
            g0 = f[:, a]; g1 = f[:, b]
            hit = (off == 0.0) & (g0 * g1 < 0)
            if hit.any():
                t = ts[a] + (ts[b] - ts[a]) * (-g0[hit] / (g1[hit] - g0[hit]))
                off[hit] = np.clip(t, -cap, cap)
    # 🎯 เกลา "ระยะที่ต้องขยับ" แทนการเกลา "ตำแหน่งจุด"
    #    ⚠️ เกลาตำแหน่งจุด = ดึงเส้นเข้าด้านใน (หด) -> เส้นหลุดออกจากขอบจริง
    #    ✅ เกลาระยะขยับตามแนวตั้งฉาก = คลื่นรบกวนหายไป แต่ค่าเฉลี่ยยังอยู่ที่ขอบเป๊ะ
    #       (ไม่มีการหดเลยโดยหลักการ เพราะไม่ได้ไปยุ่งกับทิศทางของเส้น)
    # 🩹 ลบ 'ปุ่มเดี่ยว' ด้วยค่ามัธยฐานก่อน — ตัวเกลาแบบเฉลี่ยลบปุ่มไม่ได้ ได้แค่เกลี่ยให้บานออก
    #    (ปุ่ม 1-2 จุดที่หัวตัว I มาจากพิกเซลเดี่ยวในแผนที่ภูมิภาค ค่ามัธยฐานลบทิ้งได้สะอาด)
    if OFF_MED >= 3 and len(off) >= OFF_MED + 2:
        k = int(OFF_MED) | 1
        r = k // 2
        if closed:
            pad = np.concatenate([off[-r:], off, off[:r]])
        else:
            pad = np.concatenate([np.full(r, off[0]), off, np.full(r, off[-1])])
        off = np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)
    sg = OFF_SMOOTH if osm is None else osm
    if sg and sg > 0 and len(off) >= 5:
        rad = max(1, min(int(round(sg * 2)), len(off) - 1))
        w = np.exp(-0.5 * (np.arange(-rad, rad + 1) / float(sg)) ** 2)
        w /= w.sum()
        if closed:
            pad = np.concatenate([off[-rad:], off, off[:rad]])
        else:
            pad = np.concatenate([np.full(rad, off[0]), off, np.full(rad, off[-1])])
        off = np.convolve(pad, w, mode="valid")
    Q = P + n * off[:, None]
    if closed and len(Q) > 1:
        Q[-1] = Q[0]
    return Q


def refine(P, LA, LB, lab, closed, look=None, deg=40.0, free_ends=False,
           lb_local=False):
    """🐍 สลับ "เกลาให้เนียน" กับ "ดึงกลับไปเกาะขอบจริง" ทีละรอบ

    ⚠️ ทำทีเดียวจบไม่พอ: เกาะขอบครั้งเดียวแล้วเกลา = เกลาดึงเส้นหลุดออกจากขอบ
       เกลาก่อนแล้วเกาะครั้งเดียว = ปุ่มขั้นบันไดยังอยู่ครบ (เกลาไม่ทันลบ)
    ✅ สลับกันหลายรอบ + ลดระยะค้นหาลงทุกรอบ -> เส้นทั้งเนียนและอยู่บนขอบจริงพร้อมกัน
       (หลักเดียวกับ active contour / snake ที่งานวิจัยใช้ แต่ทำบนขอบร่วมของเรา)
    """
    Q = np.asarray(P, np.float64)
    n = int(SNAKE_IT)
    if n <= 0 or len(Q) < 6:
        return subpixel(Q, LA, LB, lab, closed, lb_local=lb_local)
    for k in range(n):
        sp = 1.6 if k == 0 else max(0.6, 1.6 - 0.35 * k)
        Q = subpixel(Q, LA, LB, lab, closed, span=sp, cap=min(1.25, sp),
                     lb_local=lb_local)
        bd = SNAKE_BD * (1.0 - 0.12 * k)
        Q = smooth_open(Q, closed, budget=bd, passes=SNAKE_PS, deg=deg, look=look,
                        free_ends=free_ends)
        if closed and len(Q) > 1:
            Q[-1] = Q[0]
    # 🌀 เกลาในปริภูมิทิศทาง — ลบคลื่นของ 'ทิศทาง' ที่การเกลาตำแหน่งลบไม่ได้
    if TH_SIG > 0:
        Q = theta_smooth(Q, closed)
    # 🎯 จังหวะสุดท้าย: ดึงกลับไปเกาะขอบจริงอีกครั้ง (ห้ามเกลาต่อ ไม่งั้นหลุดอีก)
    return subpixel(Q, LA, LB, lab, closed, span=FINAL_SPAN, cap=FINAL_CAP,
                    lb_local=lb_local)


def _corners(P, deg=40.0, look=None):
    look = LOOK if look is None else look
    n = len(P)
    c = np.zeros(n, bool)
    if n < 2 * look + 3:
        return c
    for i in range(look, n - look):
        a = P[i] - P[i - look]; b = P[i + look] - P[i]
        la = math.hypot(*a); lb = math.hypot(*b)
        if la < 1e-9 or lb < 1e-9:
            continue
        d = max(-1.0, min(1.0, float((a[0] * b[0] + a[1] * b[1]) / (la * lb))))
        if math.degrees(math.acos(d)) > deg:
            c[i] = True
    return c


def smooth_open(P, closed, budget=None, passes=None, deg=40.0, look=None,
                free_ends=False):
    """เกลาคลื่นขั้นบันไดพิกเซล — ตรึงมุมจริงไว้เสมอ

    ⚠️ เกลาแบบเฉลี่ยเพื่อนบ้านล้วน ๆ (Laplacian) **หดรูปเข้าด้านใน**ทุกรอบ
       ส่วนโค้งจึงค่อย ๆ หลุดออกจากขอบจริง = อาการ "เส้นหลุดขอบ" ที่เห็น
    ✅ ใช้ Taubin (เกลาเข้า lam แล้วดันกลับออก mu ที่แรงกว่านิดหนึ่ง)
       ได้ผลเกลาเท่าเดิมแต่ **ไม่หด** — เส้นอยู่บนขอบจริงตลอด
    """
    budget = BUDGET if budget is None else budget
    passes = PASSES if passes is None else passes
    A = np.asarray(P, np.float64)
    if len(A) < 5:
        return A
    lock = _corners(A, deg, look)
    if not closed and not free_ends:
        lock[:2] = True; lock[-2:] = True

    def umb(B):
        if closed:
            return 0.5 * (np.roll(B, 1, 0) + np.roll(B, -1, 0)) - B
        m = np.zeros_like(B)
        m[1:-1] = 0.5 * (B[:-2] + B[2:]) - B[1:-1]
        return m

    B = A.copy()
    for _ in range(passes):
        if TAUBIN:
            C = B + TAU_L * umb(B)
            C[lock] = B[lock]
            C2 = C + TAU_M * umb(C)
            C2[lock] = C[lock]
            C = C2
        else:
            C = B + 0.5 * umb(B)
            C[lock] = B[lock]
        d = C - A
        L = np.hypot(d[:, 0], d[:, 1])
        f = np.where(L > budget, budget / np.maximum(L, 1e-9), 1.0)
        B = A + d * f[:, None]
    return B


def _devq(P, i, j, q):
    """เกณฑ์ตรงแบบทนจุดหลุด — ฟิตเส้นตรงที่ดีที่สุดแล้วดูค่าเบี่ยงที่ควอนไทล์ q

    ⚠️ ขอบตัวอักษรในไฟล์ JPEG มีจุดกระเพื่อมเป็นหย่อม ๆ เสมอ (รอยบีบอัด)
       ถ้าตัดสิน 'ตรงหรือไม่' ด้วยจุดที่เบี่ยงมากที่สุดจุดเดียว
       ขอบตรงยาว ๆ จะไม่มีวันผ่านเกณฑ์เลย -> ถูกฟิตเป็นเส้นโค้ง = ขอบเป็นคลื่น
    ✅ ดูที่ควอนไทล์แทน: จุดส่วนใหญ่ตรงก็ถือว่าตรง (จุดหลุดคือรอยบีบอัด ไม่ใช่รูปทรง)
       แล้วดึงทุกจุดเข้าเส้นที่ฟิตได้ -> ขอบตรงสนิทเท่ากับลายเส้นจริง
    """
    Q = P[i:j + 1]
    c = Q.mean(0); V = Q - c
    w, vec = np.linalg.eigh(V.T @ V)
    d = vec[:, int(np.argmax(w))]
    r = np.abs(V[:, 0] * d[1] - V[:, 1] * d[0])
    return float(np.quantile(r, q)), float(r.max())


def _dev(P, i, j):
    """ระยะเบี่ยงสูงสุดของ P[i..j] จากเส้นตรง P[i]-P[j]"""
    a = P[i]; b = P[j]
    d = b - a
    L = math.hypot(d[0], d[1])
    if L < 1e-9:
        return 1e9
    V = P[i:j + 1] - a
    return float(np.abs(V[:, 0] * d[1] - V[:, 1] * d[0]).max() / L)


def _runs(P, a, b, ltol, lmin):
    """หาช่วงที่ 'ตรงจริง' ยาวที่สุดแบบไล่ไปข้างหน้า (ค้นแบบทวีคูณ + แบ่งครึ่ง)"""
    out = []
    i = a
    while i < b:
        if b - i < lmin:
            break
        def okrun0(e):
            if _turn(P, i, e) > TURN_MAX:
                return False
            if LINE_Q > 0:
                q, mx = _devq(P, i, e, LINE_Q)
                return q <= ltol and mx <= ltol * LINE_QMAX
            return _dev(P, i, e) <= ltol
        if not okrun0(i + lmin):
            i += 1; continue
        okrun = okrun0
        lo = i + lmin; step = lmin
        while lo + step <= b and okrun(lo + step):
            lo += step; step *= 2
        hi = min(b, lo + step)
        while lo < hi:                                  # แบ่งครึ่งหาจุดสุดท้ายที่ยังตรง
            m = (lo + hi + 1) // 2
            if okrun(m):
                lo = m
            else:
                hi = m - 1
        out.append((i, lo)); i = lo
    return out


def _circ(Q):
    """ฟิตวงกลมด้วยกำลังสองน้อยสุด (Kåsa) -> (cx, cy, r, ค่าคลาดสูงสุด)"""
    if len(Q) < 8:
        return None
    x = Q[:, 0]; y = Q[:, 1]
    A = np.stack([x, y, np.ones(len(Q))], 1)
    b = x * x + y * y
    try:
        s, *_ = np.linalg.lstsq(A, b, rcond=None)
    except Exception:
        return None
    cx = s[0] / 2.0; cy = s[1] / 2.0
    v = s[2] + cx * cx + cy * cy
    if not np.isfinite(v) or v <= 0:
        return None
    r = math.sqrt(v)
    if not np.isfinite(r) or r > 1e5:
        return None
    d = np.hypot(x - cx, y - cy)
    return cx, cy, r, float(np.abs(d - r).max())


def _fit_ok(Q):
    """ทาบวงกลมแบบทนจุดหลุด -> (cx, cy, r) หรือ None

    ⭕ วงกลมจริงในภาพจริงมักมีจุดสะดุดไม่กี่จุด (คลื่น JPEG · จุดต่อภูมิภาค)
       ถ้าตัดสินด้วย "ค่าคลาดสูงสุด" อย่างเดียว จุดเดียวก็ล้มทั้งวง
       -> ตัดสินด้วยควอนไทล์ แล้วฟิตซ้ำโดยตัดจุดหลุดทิ้ง
    ⚠️ แต่ต้องกันไม่ให้ลบของจริง: ถ้าจุดหลุด "ต่อกันยาว" นั่นคือรูปทรงจริง
       (บิ่น เว้า หยัก) ไม่ใช่เสียงรบกวน -> ห้ามทาบ
    """
    c = _circ(Q)
    if c is None:
        return None
    cx, cy, r, mx = c
    if mx <= CIRC_TOL:
        return (cx, cy, r)
    # 🔒 เกณฑ์ทนจุดหลุดใช้ได้เฉพาะ "ส่วนโค้งยาว ๆ" เท่านั้น
    # ⚠️ วัดจริง 2026-08-17: เปิดให้ทุกเส้น -> เส้นโค้งมือเขียนถูกบังคับให้กลม
    #    baron ΔE 9.05 -> 10.30 · อักษรลายมือ 8.29 -> 9.08
    #    เส้นสั้นที่ "เกือบกลม" มักไม่ใช่วงกลมจริง แค่บังเอิญโค้ง
    # ✅ วงกลมจริงในงานป้าย (ขอบตราวงกลม) ยาวหลักพันจุดเสมอ จึงคัดด้วยความยาวได้
    if CIRC_Q <= 0 or mx > CIRC_MAX or len(Q) < CIRC_QMIN:
        return None
    d = np.abs(np.hypot(Q[:, 0] - cx, Q[:, 1] - cy) - r)
    if float(np.percentile(d, CIRC_Q)) > CIRC_TOL:
        return None
    bad = d > CIRC_TOL
    if float(bad.mean()) > CIRC_OUT:
        return None
    # จุดหลุดที่ต่อกันยาว = รูปทรงจริง ไม่ใช่เสียงรบกวน
    run = best = 0
    for v in bad:
        run = run + 1 if v else 0
        if run > best:
            best = run
    if best > CIRC_RUN:
        return None
    c2 = _circ(Q[~bad])
    if c2 is None:
        return None
    cx, cy, r, _ = c2
    d2 = np.abs(np.hypot(Q[:, 0] - cx, Q[:, 1] - cy) - r)
    if float(np.percentile(d2, CIRC_Q)) > CIRC_TOL or float(d2.max()) > CIRC_MAX:
        return None
    return (cx, cy, r)


def _near_circ(B):
    """เส้นนี้ 'เกือบเป็นวงกลม' ไหม — ใช้ตัดสินว่าจะเลิกหาเส้นตรงในเส้นนี้"""
    c = _circ(B)
    if c is None:
        return False
    cx, cy, r, _ = c
    if r < 40.0 or r > 1e4:
        return False
    d = np.abs(np.hypot(B[:, 0] - cx, B[:, 1] - cy) - r)
    return (float(np.percentile(d, 90)) <= CIRC_TOL * CIRC_SOFT
            and float(d.mean()) <= CIRC_TOL * 0.6)


def _to_circ(B, i, j, closed, n):
    """ถ้าช่วงนี้เป็นส่วนโค้งจริง ดึงจุดเข้าวงกลมพอดี -> โค้งได้สัดส่วนถูกต้อง"""
    c = _fit_ok(B[i:j + 1])
    if c is None:
        return False
    cx, cy, r = c
    a0 = i if (closed or i > 0) else 1
    a1 = j if (closed or j < n - 1) else n - 2
    if a1 < a0:
        return False
    V = B[a0:a1 + 1] - np.array([cx, cy])
    L = np.hypot(V[:, 0], V[:, 1])
    ok = L > 1e-6
    if not ok.all():
        return False
    B[a0:a1 + 1] = np.array([cx, cy]) + V * (r / L)[:, None]
    return True


def _dissolve_blend(reg, res, lim, bg_id=-1, lab=None):
    """ยุบชิ้นจิ๋วที่ 'สีเป็นส่วนผสมของเพื่อนบ้านสองข้าง' เข้ากับข้างที่ใกล้กว่า"""
    n = int(reg.max()) + 1
    if n < 3:
        return reg
    area = np.asarray(res["area"], np.float64)
    mean = np.asarray(res["mean"], np.float64)
    # ⚠️ บั๊กที่ทำให้ทั้งฟังก์ชันนี้ไม่เคยทำงานเลย (เจอ 2026-08-18):
    #    ตาราง area/mean ยาวกว่า reg.max()+1 (build เผื่อช่องไว้) -> np.bincount
    #    โยน ValueError -> ถูก try/except ข้างนอกกลืน = เงียบสนิท ไม่มีอะไรเกิดขึ้น
    #    บทเรียน: except กว้าง ๆ ต้องมีตัววัดผลจริงคู่กันเสมอ ไม่งั้นโค้ดตายโดยไม่รู้ตัว
    m9 = max(n, len(area), len(mean))
    if len(area) < m9:
        area = np.concatenate([area, np.zeros(m9 - len(area))])
    if len(mean) < m9:
        mean = np.concatenate([mean, np.zeros((m9 - len(mean), mean.shape[1]))])
    # นับความยาวขอบที่ติดกันของทุกคู่ (4 ทิศ)
    pairs = {}
    for A, B in ((reg[:, :-1], reg[:, 1:]), (reg[:-1, :], reg[1:, :])):
        d = A != B
        if not d.any():
            continue
        a = A[d].reshape(-1).astype(np.int64)
        b = B[d].reshape(-1).astype(np.int64)
        lo = np.minimum(a, b); hi = np.maximum(a, b)
        k = lo * n + hi
        u, c = np.unique(k, return_counts=True)
        for kk, cc in zip(u.tolist(), c.tolist()):
            pairs[kk] = pairs.get(kk, 0) + int(cc)
    nb = {}
    for kk, cc in pairs.items():
        a, b = divmod(kk, n)
        if a <= 0 or b <= 0:
            continue
        nb.setdefault(a, []).append((cc, b))
        nb.setdefault(b, []).append((cc, a))
    # ══════════════════════════════════════════════════════════════
    # 🎗️ นอกจาก "ชิ้นเล็ก" ให้รวม "ชิ้นบาง" เข้ามาพิจารณาด้วย
    # ⚠️ วัดจริง 2026-08-18 (ผู้ใช้วงขอบวงกลมด้านล่างขวารอบที่สี่):
    #    ระหว่างวงกลมขาวกับพื้นรุ้ง มี "วงแหวนสีเกลี่ย" หนา 3-5 px คั่นอยู่
    #    มันยาวรอบวง (พื้นที่ 11,000 px) จึงไม่เข้าเกณฑ์ 'ชิ้นเล็ก'
    #    ผลคือถูกวาดเป็นชั้นสีเขียวอ่อนของตัวเอง = เห็นเป็น 'ขลิบซีด' รอบวง
    #    และขอบทั้งสองด้านของมันก็สะดุดเป็นบันไดตรงจุดที่ผู้ใช้วงมา
    # ✅ วัดความบางด้วย พื้นที่ ÷ เส้นรอบรูป (วงแหวนหนา 3 px ได้ ~1.5 · วงกลมได้ ~50)
    #    บาง + สีเป็นส่วนผสมของสองข้าง + สองข้างใหญ่กว่ามาก = ขลิบขอบแน่นอน
    # ══════════════════════════════════════════════════════════════
    per = {}
    for r, lst in nb.items():
        per[r] = float(sum(c for c, _ in lst))
    small = [r for r in range(1, n)
             if 0 < area[r] <= lim
             or (BLEND_THIN > 0 and per.get(r, 0) > 0
                 and area[r] / per[r] <= BLEND_THIN)]
    if not small:
        return reg
    lut = np.arange(m9, dtype=np.int64)

    def _root(r):
        while lut[r] != r:
            r = lut[r]
        return r

    hit = 0
    for r in sorted(small, key=lambda q: area[q]):
        ns = sorted(nb.get(r, ()), reverse=True)
        if len(ns) < 2:
            continue
        tot = float(sum(c for c, _ in ns))
        (c1, a1), (c2, a2) = ns[0], ns[1]
        _thin = area[r] > lim
        if _thin and bg_id >= 0 and a1 != bg_id and a2 != bg_id:
            continue                      # ขลิบที่ไม่ได้ติดพื้นไล่สี = ของจริง ห้ามแตะ
        _cov = BLEND_COVER_THIN if _thin else BLEND_COVER
        if tot <= 0 or (c1 + c2) / tot < _cov:
            continue
        a1 = _root(a1); a2 = _root(a2)
        if a1 == a2 or a1 == _root(r) or a2 == _root(r):
            continue
        if area[r] > lim and (area[a1] < area[r] * BLEND_BIG
                              or area[a2] < area[r] * BLEND_BIG):
            continue                      # ชิ้นบางที่เพื่อนบ้านไม่ได้ใหญ่กว่า = ลายจริง
        P, Q, X = mean[a1], mean[a2], mean[r]
        if bg_id >= 0 and lab is not None and (a1 == bg_id or a2 == bg_id):
            # ══════════════════════════════════════════════════════
            # 🎨 พื้นไล่สีถูกรวมเป็นก้อนเดียวไปแล้ว "สีเฉลี่ย" ของมันจึงเป็นสีขุ่น ๆ
            #    ของทั้งพื้นรุ้ง ไม่ใช่สีตรงจุดนั้น -> เทียบส่วนผสมไม่ได้
            # ✅ อ่านสีพื้น "ตรงที่ขลิบนี้แปะอยู่" จากภาพจริงแทน
            # ══════════════════════════════════════════════════════
            _mr = (reg == r).astype(np.uint8)
            _rg9 = (cv2.dilate(_mr, np.ones((5, 5), np.uint8)).astype(bool)
                    & (reg == bg_id))
            if int(_rg9.sum()) < 20:
                continue
            _loc = lab[_rg9].reshape(-1, 3).mean(0)
            if a1 == bg_id:
                P = _loc
            else:
                Q = _loc
        u = Q - P
        L2 = float((u * u).sum())
        if L2 < 25.0:                     # เพื่อนบ้านสองรายสีใกล้กันเกินไป ตัดสินไม่ได้
            continue
        t = float(((X - P) * u).sum()) / L2
        if not (BLEND_T <= t <= 1.0 - BLEND_T):
            continue
        perp = X - (P + u * t)
        if float(np.sqrt((perp * perp).sum())) > BLEND_DE:
            continue
        # ⛔ เคยลอง "ยุบเข้าฝั่งพื้นเสมอ" (2026-08-18) — เลิกใช้
        #    ขอบลายไปอยู่ที่วงในซึ่งเป็นคนละโซ่ ไม่ได้ผ่านการทาบวงกลม
        #    ผลจริง: ขอบกลับหยักเป็นบันไดหนักกว่าเดิมทั้งวง (ดูด้วยตาชัดมาก)
        #    -> ใช้กฎ "ยุบเข้าฝั่งที่สีใกล้กว่า" ตามเดิม
        lut[_root(r)] = a1 if t < 0.5 else a2
        hit += 1
    if not hit:
        return reg
    for r in range(m9):
        lut[r] = _root(r)
    new = lut[reg].astype(reg.dtype)
    # รวมพื้นที่/สีของชิ้นที่ถูกกลืนเข้าไปในเจ้าบ้าน
    w = np.bincount(lut, weights=area, minlength=m9)
    m2 = np.zeros_like(mean)
    for c in range(3):
        m2[:, c] = np.bincount(lut, weights=area * mean[:, c], minlength=m9)
    ok = w > 0
    m2[ok] /= w[ok, None]
    res["mean"] = np.where(ok[:, None], m2, mean)
    res["area"] = np.where(ok, w, area)
    return new


def circ_consensus(pts):
    """🤝 ท่อนโค้งที่เป็น 'วงกลมวงเดียวกัน' ต้องใช้วงร่วมกัน — แก้ 'รอยสะดุด' ที่จุดต่อ

    ⚠️ วัดจริง 2026-08-17 (ผู้ใช้ทัก "ขอบวงกลมขาวยังยึกยืออยู่เลย" รอบที่สาม):
       ขอบวงกลมขาวถูกจุดต่อหั่นเป็น 6 ท่อน แต่ละท่อนทาบวงกลมของตัวเอง
       ได้รัศมี 584.7 / 584.7 / 584.8 / 584.8 / 584.9 / 585.0 — ต่างกันไม่ถึง 0.3 px
       แต่ศูนย์กลางก็เลื่อนคนละนิด รวมแล้วเห็นเป็น 'ขั้นบันได' ที่รอยต่อ 6 จุดรอบวง
       (ท่อนเดี่ยว ๆ วัดได้เรียบ 0.16 px แต่พอต่อกันจริงเห็นสะดุดชัดด้วยตา)
    ✅ จับท่อนที่ได้วงใกล้กันมารวมกัน ฟิตใหม่ครั้งเดียวจากจุดทั้งหมด แล้วดึงทุกท่อนเข้าวงนั้น
    🔒 ปลายท่อนที่ไปต่อกับเส้นที่ไม่ได้อยู่ในวง ห้ามขยับ (ไม่งั้นรูปแตกเป็นรู)
    """
    if CIRC_SAME <= 0 or len(pts) < 2:
        return
    cand = {}
    for k, P in pts.items():
        if len(P) < CIRC_MINPTS:
            continue
        c = _fit_ok(P)
        if c is not None:
            cand[k] = c
    if len(cand) < 2:
        return
    # โหนดปลาย -> รายการ (โซ่, ตำแหน่งในโซ่) เอาไว้ขยับปลายพร้อมกันทุกเส้น
    ends = {}
    for k in pts:
        if k[0] == k[-1]:
            continue
        ends.setdefault(k[0], []).append((k, 0))
        ends.setdefault(k[-1], []).append((k, -1))
    ks = sorted(cand, key=lambda k: -len(pts[k]))
    used = set()
    for k0 in ks:
        if k0 in used:
            continue
        cx, cy, r = cand[k0]
        grp = [k0]
        used.add(k0)
        for k2 in ks:
            if k2 in used:
                continue
            x2, y2, r2 = cand[k2]
            if abs(r2 - r) <= CIRC_SAME and math.hypot(x2 - cx, y2 - cy) <= CIRC_SAME:
                grp.append(k2)
                used.add(k2)
        if len(grp) < 2:
            continue
        Q = np.concatenate([pts[k] for k in grp], 0)
        c = _circ(Q)
        if c is None:
            continue
        cx, cy, r = c[0], c[1], c[2]
        # 🧲 ดูดท่อนสั้น ๆ ที่นอนอยู่บนวงนี้อยู่แล้วเข้ามาด้วย
        #    ⚠️ วัดจริง: ขอบวงกลมขาวมี 22 ท่อนที่ทาบวงได้ แต่ยังมีท่อนสั้นคั่นอยู่
        #       ท่อนสั้นไม่ถึงเกณฑ์ยาวขั้นต่ำ เลยถูกฟิตอิสระ -> เห็นเป็นขั้นบันไดคั่นเป็นช่วง ๆ
        for k2, P2 in pts.items():
            if k2 in used or len(P2) < 8:
                continue
            d2 = np.abs(np.hypot(P2[:, 0] - cx, P2[:, 1] - cy) - r)
            if float(d2.max()) <= CIRC_TOL:
                grp.append(k2)
                used.add(k2)
        C = np.array([cx, cy])
        for k in grp:
            P = pts[k]
            V = P - C
            L = np.hypot(V[:, 0], V[:, 1])
            ok = L > 1e-6
            if not ok.any():
                continue
            NP = P.copy()
            NP[ok] = C + V[ok] * (r / L[ok])[:, None]
            if k[0] == k[-1]:
                NP[-1] = NP[0]
            pts[k] = NP
        # 🔗 ปลายท่อนคือ "จุดต่อ" ที่เส้นอื่นมาชนด้วย -> ต้องลากเส้นอื่นตามมาให้ตรงจุดเดียวกัน
        #    ⚠️ วัดจริง 2026-08-17: ถ้าไม่ขยับตาม จะเหลือ 'ฟันเลื่อย' เล็ก ๆ ที่จุดต่อรอบวง
        #       (ผู้ใช้เห็นเป็นรอยสะดุด 4-6 จุดรอบขอบวง แม้ตัวเส้นจะกลมสนิทแล้ว)
        for k in grp:
            if k[0] == k[-1]:
                continue
            for idx, nd in ((0, k[0]), (-1, k[-1])):
                q = pts[k][idx]
                for (k2, i2) in ends.get(nd, ()):
                    if k2 == k:
                        continue
                    P2 = pts[k2]
                    if math.hypot(P2[i2][0] - q[0], P2[i2][1] - q[1]) <= CIRC_SAME * 2.0:
                        P2[i2] = q


def _turn(P, i, j):
    """องศาที่เลี้ยวรวมทั้งช่วง (ใช้แยก 'เส้นตรง' ออกจาก 'ส่วนโค้งรัศมีใหญ่')"""
    m = (i + j) // 2
    if m - i < 2 or j - m < 2:
        return 0.0
    a = P[m] - P[i]; b = P[j] - P[m]
    la = math.hypot(*a); lb = math.hypot(*b)
    if la < 1e-9 or lb < 1e-9:
        return 0.0
    d = max(-1.0, min(1.0, float((a[0] * b[0] + a[1] * b[1]) / (la * lb))))
    return math.degrees(math.acos(d))


def _dearc(B, runs):
    """⚠️ กับดักที่ทำให้ 'ไม่โค้งตามสัดส่วน'

    คอร์ดสั้น ๆ บนวงรัศมีใหญ่ก็ 'ตรงพอ' ตามเกณฑ์ค่าคลาด -> ขอบวงกลมถูกซอยเป็นเหลี่ยม
    ตรวจซ้ำอีกชั้น: ถ้าช่วงตรงหลายช่วงเรียงกันแล้ว **เลี้ยวไปทางเดียวกันเรื่อย ๆ**
    นั่นไม่ใช่หลายเส้นตรง แต่คือส่วนโค้งเส้นเดียว -> ยุบรวมแล้วส่งไปทาบวงกลมแทน
    """
    if len(runs) < 2:
        return runs, []
    ang = []
    for (i, j) in runs:
        d = B[j] - B[i]
        ang.append(math.atan2(d[1], d[0]))
    out = []
    k = 0
    while k < len(runs):
        m = k; tot = 0.0; sgn = 0
        while m + 1 < len(runs):
            t = math.degrees(math.atan2(math.sin(ang[m + 1] - ang[m]),
                                        math.cos(ang[m + 1] - ang[m])))
            if abs(t) > 40.0 or abs(t) < 0.5:
                break
            s = 1 if t > 0 else -1
            if sgn and s != sgn:
                break
            sgn = s; tot += abs(t); m += 1
        if m > k and tot >= ARC_TURN and (runs[m][1] - runs[k][0]) >= ARC_SPAN:
            out.append(("arc", runs[k][0], runs[m][1]))   # ยุบเป็นส่วนโค้งเดียว
            k = m + 1
        else:
            out.append(("line", runs[k][0], runs[k][1]))
            k += 1
    return [(a, b) for (t, a, b) in out if t == "line"], [(a, b) for (t, a, b) in out if t == "arc"]


def _isect(p1, d1, p2, d2):
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-6:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
    return (p1[0] + d1[0] * t, p1[1] + d1[1] * t)


def fit_chain(P, closed, tol=0.35, deg=40.0):
    """แนวจุด -> [seg] แบบ ("C",c1,c2,end)/("L",p)  (เริ่มที่ P[0] เสมอ)

    ✅ ของใหม่: ดึง "ช่วงที่ตรงจริง" ออกมาเป็นเส้นตรงเส้นเดียวก่อน
       แล้วให้สองเส้นตรงที่ชนกัน **ตัดกันเป็นมุมแหลมจริง**
       (เดิมฟิตเป็นโค้งหมด -> ขอบตรงยังกระเพื่อม มุมถูกลบมน = ตาเห็นว่า "ไม่คม")
    """
    # 🔎 ปรับความแรงของการเกลาให้พอดีกับ "ขนาดของชิ้นงานตรงนั้น"
    #    ⚠️ ตัวอักษรจิ๋ว (LINEMAN) เส้นหนาแค่ ~7 จุด ถ้าเกลาด้วยงบเดียวกับขอบวงกลมใหญ่
    #       ตัวอักษรจะบวมเสียรูป · และหน้าต่างหามุมกว้าง 10 จุดก็กินไปทั้งตัวอักษร
    _L = len(P)
    _bd = float(np.clip(_L / 26.0, BUDGET_MIN, BUDGET))
    _lk = int(np.clip(_L // 10, LOOK_MIN, LOOK))
    B = smooth_open(P, closed, budget=_bd, deg=deg, look=_lk)
    n = len(B)
    if n < 4:
        return [("L", (float(q[0]), float(q[1]))) for q in B[1:]]
    # ⭕ ลองทาบทั้งเส้นด้วยวงกลมก่อน — ถ้าเข้า แปลว่านี่คือส่วนโค้งจริง
    #    ดึงจุดเข้าวงกลมให้พอดี แล้วข้ามขั้นหาเส้นตรงไปเลย
    #    ⚠️ ไม่ทำข้อนี้ = ส่วนโค้งรัศมีใหญ่ (ขอบวงกลมขาว) ถูกซอยเป็นเหลี่ยม ๆ
    #       เพราะคอร์ดสั้น ๆ บนวงรัศมีใหญ่ "ตรงพอ" ตามเกณฑ์ค่าคลาด
    if CIRC_TOL > 0 and _to_circ(B, 0, n - 1, closed, n):
        runs = []
    elif CIRC_SOFT > 0 and n >= CIRC_QMIN and _near_circ(B):
        # ══════════════════════════════════════════════════════════
        # 🌙 "เกือบวงกลม แต่ไม่ใช่วงกลมเป๊ะ" — ห้ามซอยเป็นเส้นตรง
        # ⚠️ วัดจริง 2026-08-18 (ผู้ใช้วงขอบล่างขวารอบที่ห้า):
        #    ขอบวงกลมขาวมีจุดปูดจริงอยู่ช่วงหนึ่ง (ต้นฉบับก็ปูด) ค่าคลาดสูงสุด 2.16
        #    -> ทาบวงกลมไม่ผ่าน -> ตกไปทางหาเส้นตรง ได้ 113 ท่อน
        #    ตรงที่ปูด ทิศเลี้ยวสลับ ตัวรวมส่วนโค้งจึงตัดตอน เหลือเป็นขั้นบันได
        # ✅ ถ้าเส้นทั้งเส้น "นอนอยู่บนวงกลมเกือบหมด" ให้ฟิตเป็นโค้งล้วน
        #    จุดที่ปูดยังอยู่ครบตามต้นฉบับ แต่ออกมาเป็นส่วนโค้งนุ่ม ไม่ใช่บันได
        # ══════════════════════════════════════════════════════════
        runs = []
    else:
        runs, arcs = _dearc(B, _runs(B, 0, n - 1, LINE_TOL,
                                     max(8, min(LINE_MIN, n // 6))))
        # 🔎 ด่านที่สอง: ช่วงสั้น ๆ ที่ "ขนาบด้วยเส้นตรงทั้งสองข้าง" ก็คือเส้นตรงเหมือนกัน
        #    ⚠️ ขอบบนของตัว I ยาวแค่ ~30 จุด ไม่ถึงเกณฑ์ยาวขั้นต่ำ -> ถูกฟิตเป็นโค้ง
        #       เลยลอกรอยบิ่น 1 พิกเซลออกมา (ผู้ใช้วงหัวตัว I มา)
        #    ⛔ แต่จะลดเกณฑ์ยาวขั้นต่ำทั้งกระดานไม่ได้ — วัดแล้วท้องตัว O กลายเป็นเหลี่ยม
        #       เพราะคอร์ดสั้นบนวงกลมก็ 'ตรง' ตามเกณฑ์
        #    ✅ จึงยอมเฉพาะช่วงที่ถูกขนาบด้วยเส้นตรงที่ยืนยันแล้วทั้งสองข้างเท่านั้น
        if LINE_MIN2 > 0 and len(runs) >= 2:
            add = []
            for (p, q) in zip(runs[:-1], runs[1:]):
                a, b = p[1], q[0]
                if b - a < LINE_MIN2:
                    continue
                if _turn(B, a, b) > TURN_MAX:
                    continue
                if LINE_Q > 0:
                    qq, mx = _devq(B, a, b, LINE_Q)
                    if qq > LINE_TOL or mx > LINE_TOL * LINE_QMAX:
                        continue
                elif _dev(B, a, b) > LINE_TOL:
                    continue
                add.append((a, b))
            if closed and len(runs) >= 2:
                a, b = runs[-1][1], n - 1
                a2, b2 = 0, runs[0][0]
                if (b - a) + (b2 - a2) >= LINE_MIN2:
                    pass          # ช่องว่างคร่อมจุดเริ่ม — ปล่อยให้ตัวฟิตโค้งจัดการ
            if add:
                runs = sorted(runs + add)
        for (i, j) in arcs:                    # ยุบแล้วดึงเข้าวงกลมทันที
            _to_circ(B, i, j, False, n)
    # 📏 ช่วงที่ตรง -> ฟิตเส้นตรงที่ "ดีที่สุด" (total least squares) แล้วดึงจุดเข้าเส้น
    #    ถ้าใช้เส้นเชื่อมหัว-ท้ายเฉย ๆ เส้นจะเยื้องออกจากแนวจริงได้ถึงค่าความคลาดที่ยอม
    #    -> ขอบขยับทั้งแถบ · ฟิตแบบนี้ค่าคลาดลดลงครึ่งหนึ่งและเส้นตรงสนิทเท่ากัน
    # 🧱 รวมเส้นตรงสองท่อนที่ "ขนานกันและเยื้องกันนิดเดียว" ให้เป็นท่อนเดียว
    #    ⚠️ เจอต้นเหตุจริงจากการกางภาพต้นทางดู: ขอบบนตัวอักษรในไฟล์ JPEG มี
    #       'เงาสะท้อนขอบ' (ringing) โผล่เป็นก้อนดำที่มุมบนซ้าย-ขวา
    #       แผนที่ภูมิภาคจึงมีขั้น 1-2 พิกเซลกลางขอบบน -> ขอบตรงถูกหั่นเป็นสองท่อน
    #       ทั้งที่มันคือขอบตรงเส้นเดียว (ผู้ใช้วงหัวตัว I มาสองรอบ)
    #    ✅ ถ้าสองท่อนขนานกัน (< STEP_ANG องศา) และเยื้องกันไม่เกิน STEP_MAX พิกเซล
    #       ถือว่าเป็นเส้นเดียวที่ถูกรอยบีบอัดทำให้ขาด -> รวมแล้วฟิตใหม่ทีเดียว
    if STEP_MAX > 0 and len(runs) >= 2:
        for _ in range(6):
            out2 = [runs[0]]
            merged = False
            for (i2, j2) in runs[1:]:
                i1, j1 = out2[-1]
                if i2 - j1 <= STEP_GAP:
                    d1 = B[j1] - B[i1]; d2 = B[j2] - B[i2]
                    l1 = math.hypot(*d1); l2 = math.hypot(*d2)
                    if l1 > 1e-9 and l2 > 1e-9:
                        cs = abs(float((d1 @ d2) / (l1 * l2)))
                        v = B[i2] - B[i1]
                        off = abs(float((v[0] * d1[1] - v[1] * d1[0]) / l1))
                        v2 = B[j2] - B[i1]
                        off2 = abs(float((v2[0] * d1[1] - v2[1] * d1[0]) / l1))
                        if (cs >= math.cos(math.radians(STEP_ANG))
                                and max(off, off2) <= STEP_MAX):
                            out2[-1] = (i1, j2); merged = True; continue
                out2.append((i2, j2))
            runs = out2
            if not merged:
                break
    # ✂️ หดปลายช่วงตรงกลับก่อน — กันไม่ให้ 'กลืนมุม/ปลายตัวอักษร' เข้ามาในเส้นตรง
    #    ⚠️ เกณฑ์ทนจุดหลุดยอมให้มีจุดเบี่ยงได้บ้าง จุดพวกนั้นมักอยู่ที่ 'ปลายช่วง'
    #       ซึ่งก็คือมุมจริงหรือปลายตัวอักษร -> เส้นตรงลากทะลุไป = มุมถูกตัดเฉียง
    #       (ตรงกับที่ผู้ใช้วง: หัวตัว I บิ่น · ปลายบนตัว C ถูกตัด · มุมล่างขวาตัว E แหว่ง)
    trim = []
    _lmin = min(LINE_MIN, LINE_MIN2) if LINE_MIN2 > 0 else LINE_MIN
    for (i, j) in runs:
        a, b = i, j
        for _ in range(200):
            if b - a < _lmin:
                break
            Q = B[a:b + 1]; c = Q.mean(0); V = Q - c
            w, vec = np.linalg.eigh(V.T @ V)
            d = vec[:, int(np.argmax(w))]
            r = np.abs(V[:, 0] * d[1] - V[:, 1] * d[0])
            if r[0] > TRIM_TOL:
                a += 1; continue
            if r[-1] > TRIM_TOL:
                b -= 1; continue
            break
        if b - a >= _lmin:
            trim.append((a, b))
    runs = trim
    for (i, j) in runs:
        Q = B[i:j + 1]
        c = Q.mean(0)
        V = Q - c
        w, vec = np.linalg.eigh(V.T @ V)
        d = vec[:, int(np.argmax(w))]
        a0, a1 = (i if i > 0 else 1), (j if j < n - 1 else n - 2)
        if a1 >= a0:
            R = B[a0:a1 + 1] - c
            PR = c + np.outer(R @ d, d)
            # 🪶 ค่อย ๆ กลืนเข้าหาเส้นตรงที่ปลายช่วง แทนการตัดกึก
            #    (ตัดกึก = เกิดขั้นบันไดตรงรอยต่อระหว่างช่วงตรงกับช่วงโค้ง)
            m = a1 - a0 + 1
            wgt = np.ones(m)
            k = min(TAPER, m // 2)
            if k > 0:
                ramp = np.linspace(0.0, 1.0, k + 2)[1:-1]
                wgt[:k] = ramp; wgt[-k:] = ramp[::-1]
            B[a0:a1 + 1] = B[a0:a1 + 1] * (1 - wgt)[:, None] + PR * wgt[:, None]
    pieces = []                                  # (kind, i, j)
    cur = 0
    for (i, j) in runs:
        if i > cur:
            pieces.append(("c", cur, i))
        pieces.append(("l", i, j)); cur = j
    if cur < n - 1:
        pieces.append(("c", cur, n - 1))
    if not pieces:
        pieces = [("c", 0, n - 1)]
    # ⭕ ช่วงที่ยังเป็นโค้ง ลองทาบวงกลมทีละช่วง (ปลายใบไม้ · ท้องตัว C · วงส้ม)
    if CIRC_TOL > 0:
        for kind, i, j in pieces:
            if kind == "c" and j - i >= ARC_MIN:
                _to_circ(B, i, j, False, n)

    # 📐 มุมแหลม: เส้นตรงสองเส้นที่คั่นด้วยช่วงสั้น ๆ -> ลากให้ไปตัดกันจริง
    pts = {}
    for k in range(len(pieces) - 2):
        a, b, c = pieces[k], pieces[k + 1], pieces[k + 2]
        if a[0] == "l" and c[0] == "l" and b[0] == "c" and (b[2] - b[1]) <= CORNER_GAP:
            p1 = B[a[1]]; d1 = B[a[2]] - B[a[1]]
            p2 = B[c[1]]; d2 = B[c[2]] - B[c[1]]
            q = _isect(p1, d1, p2, d2)
            if q is not None and math.hypot(q[0] - B[b[1]][0], q[1] - B[b[1]][1]) < CORNER_MAX:
                pts[k] = q

    segs = []
    skip = set()
    for k, (kind, i, j) in enumerate(pieces):
        if k in skip:
            continue
        if k - 1 in pts and kind == "c":
            continue                                     # ช่วงมุมถูกแทนด้วยจุดตัดแล้ว
        if kind == "l":
            if k in pts:                                 # ตามด้วยมุมแหลม
                q = pts[k]
                segs.append(("L", (float(q[0]), float(q[1]))))
                skip.add(k + 1)
                continue
            segs.append(("L", (float(B[j][0]), float(B[j][1]))))
            continue
        sub = B[i:j + 1]
        if len(sub) < 4:
            segs += [("L", (float(q[0]), float(q[1]))) for q in sub[1:]]
            continue
        sg = VE._schneider(sub, VE._end_tan(sub, 4, True), VE._end_tan(sub, 4, False),
                           float(tol))
        segs += (sg if sg else [("L", (float(q[0]), float(q[1]))) for q in sub[1:]])
    # ปลายทางต้องเป็นจุดต่อเป๊ะเสมอ (ห้ามคลาด ไม่งั้นเกิดรอยแยกกับเส้นข้างเคียง)
    if segs:
        e = segs[-1][-1]
        if abs(e[0] - B[-1][0]) > 1e-9 or abs(e[1] - B[-1][1]) > 1e-9:
            segs.append(("L", (float(B[-1][0]), float(B[-1][1]))))
    return segs


def rev_segs(start, segs):
    """กลับทิศชุดเส้นโค้ง — คืน (start2, segs2)"""
    pts = [start]
    for s in segs:
        pts.append(s[-1])
    out = []
    for i in range(len(segs) - 1, -1, -1):
        s = segs[i]
        if s[0] == "C":
            out.append(("C", s[2], s[1], pts[i]))
        else:
            out.append(("L", pts[i]))
    return pts[-1], out


def _flank(reg, n0, n1):
    """คืน (ภูมิภาคฝั่งซ้ายของทิศเดิน, ฝั่งขวา) ของครึ่งขอบ n0->n1"""
    H, W = reg.shape
    d = n1 - n0
    i = n0 // (W + 1); j = n0 % (W + 1)

    def px(a, b):
        return int(reg[a, b]) if 0 <= a < H and 0 <= b < W else 0
    if d == 1:
        return px(i - 1, j), px(i, j)
    if d == -1:
        i = n1 // (W + 1); j = n1 % (W + 1)
        return px(i, j), px(i - 1, j)
    if d == (W + 1):
        return px(i, j), px(i, j - 1)
    i = n1 // (W + 1); j = n1 % (W + 1)
    return px(i, j - 1), px(i, j)


def build_paths(reg, tol=None, deg=40.0, mean=None, lab=None):
    """ไล่เส้นทั้งภาพเป็น 3 จังหวะ (ต้องแยกจังหวะ ไม่งั้นจุดต่อจะไม่ตรงกัน)

    1) เก็บ 'ขอบร่วม' ทุกเส้น แล้วดัดให้เกาะขอบจริง — **ปล่อยปลายอิสระ**
    2) จุดต่อ (จุดที่ >=3 ภูมิภาคชนกัน): เฉลี่ยตำแหน่งปลายจากทุกเส้นที่มาชนกันที่นั่น
       แล้วบังคับให้ทุกเส้นใช้ค่าเดียวกัน -> ยังปิดสนิท แต่ไม่ถูกตรึงที่มุมพิกเซลอีกต่อไป
    3) ค่อยฟิตเป็นเส้นโค้ง
    ⚠️ เดิมตรึงปลายไว้ที่ 'มุมพิกเซลจำนวนเต็ม' ทุกจุด -> ทุกจุดต่อคลาดได้ถึง 0.7 px
       และเกลาไม่ได้เลย = ที่เห็นว่า 'เส้นหลุดขอบ' กับ 'สะดุดเป็นเหลี่ยม' ตรงรอยต่อ
    """
    tol = TOL if tol is None else tol
    H, W = reg.shape
    J = junctions(reg)
    loops = trace(reg)
    plan = {}                                  # ภูมิภาค -> [[ (key, fwd), ... ] ต่อวง ]
    pts = {}                                   # key -> ndarray จุดที่ดัดแล้ว
    for r, lps in loops.items():
        rows = []
        for lp in lps:
            n = len(lp)
            jj = [i for i in range(n) if J[lp[i]]]
            if jj:
                chains = [[lp[i % n] for i in range(a, b + 1)]
                          for a, b in zip(jj, jj[1:] + [jj[0] + n])]
            else:
                chains = [lp + [lp[0]]]
            row = []
            for ch in chains:
                cl0 = (len(ch) > 2 and ch[0] == ch[-1] and len(set(ch)) > 2
                       and not J[ch[0]])
                if cl0:
                    rot = min(range(len(ch) - 1), key=lambda i: ch[i])
                    f = [ch[(rot + i) % (len(ch) - 1)] for i in range(len(ch) - 1)]
                    f = f + [f[0]]
                    b = f[::-1]
                    fwd = tuple(f) <= tuple(b)
                    key = tuple(f) if fwd else tuple(b)
                else:
                    fwd = tuple(ch) <= tuple(ch[::-1])
                    key = tuple(ch) if fwd else tuple(ch[::-1])
                row.append((key, fwd))
                if key not in pts:
                    P = np.array([_pt(nd, W) for nd in key], np.float64)
                    cl = (key[0] == key[-1])
                    if mean is not None and lab is not None and len(key) > 2:
                        a, b = _flank(reg, key[0], key[1])
                        if a > 0 and b > 0 and a != b:
                            _bg = (a == BG_ID[0] or b == BG_ID[0])
                            if b == BG_ID[0]:
                                _la, _lb = mean[a], mean[b]
                            elif a == BG_ID[0]:
                                _la, _lb = mean[b], mean[a]
                                # กลับด้าน -> ต้องกลับทิศเส้นด้วยถึงจะถอยออกถูกฝั่ง
                                P = P[::-1].copy()
                            else:
                                _la, _lb = mean[a], mean[b]
                            P = refine(P, _la, _lb, lab, cl,
                                       look=int(np.clip(len(P) // 10, LOOK_MIN, LOOK)),
                                       free_ends=FREE_ENDS, lb_local=_bg)
                            if a == BG_ID[0]:
                                P = P[::-1].copy()
                    pts[key] = P
            rows.append(row)
        plan[r] = rows

    # ── จังหวะ 2: เฉลี่ยตำแหน่งจุดต่อให้ทุกเส้นที่มาชนกันใช้ค่าเดียวกัน ──
    acc = {}
    for key, P in pts.items():
        if key[0] == key[-1]:
            continue
        for nd, q in ((key[0], P[0]), (key[-1], P[-1])):
            a = acc.setdefault(nd, [np.zeros(2), 0])
            a[0] += q; a[1] += 1
    fix = {nd: (v[0] / v[1]) for nd, v in acc.items() if v[1] > 0}
    for key, P in pts.items():
        if key[0] == key[-1]:
            continue
        if key[0] in fix:
            P[0] = fix[key[0]]
        if key[-1] in fix:
            P[-1] = fix[key[-1]]

    # ── จังหวะ 2.5: ท่อนที่เป็นวงกลมวงเดียวกัน ให้ใช้วงร่วมกัน ──
    try:
        circ_consensus(pts)
    except Exception:
        pass

    # ── จังหวะ 3: ฟิตเส้นโค้ง (เส้นละครั้งเดียว ใช้ร่วมกันสองฝั่ง) ──
    cache = {}
    for k, P in pts.items():
        cl = (k[0] == k[-1])
        sg = fit_chain(P, cl, tol, deg)
        # 🔁 ตรวจ "ตัวเส้นโค้งเอง" ว่าเกาะขอบจริงไหม แล้วฟิตใหม่
        #    ⚠️ ที่ผ่านมาเราดัดแค่ 'แนวจุดที่ใช้ฟิต' ให้เกาะขอบ — แต่เส้นโค้งที่ฟิตออกมา
        #       คลาดจากแนวจุดได้อีกตามค่า tol (0.4-0.8 px) ตรงกลางช่วงโค้งจะหลุดออกไปเสมอ
        #    ✅ กางเส้นโค้งออกเป็นจุด -> วัดว่าหลุดขอบเท่าไหร่ -> ดึงกลับ -> ฟิตใหม่
        #       ได้เส้นที่ 'ตัวมันเอง' อยู่บนขอบ ไม่ใช่แค่จุดตั้งต้น
        if CURVE_IT > 0 and mean is not None and lab is not None and len(k) > 2:
            a, b = _flank(reg, k[0], k[1])
            if a > 0 and b > 0 and a != b:
                e0 = tuple(P[0]); e1 = tuple(P[-1])
                for _ in range(int(CURVE_IT)):
                    F = _flatten(e0, sg, 1.0)
                    if len(F) < 8:
                        break
                    F = subpixel(F, mean[a], mean[b], lab, cl,
                                 span=1.0, cap=0.8, osm=max(2.0, OFF_SMOOTH))
                    F[0] = e0
                    if cl:
                        F[-1] = e0
                    else:
                        F[-1] = e1
                    sg = fit_chain(F, cl, tol, deg)
        if G1:
            _, sg = g1_join(tuple(P[0]), sg)
        cache[k] = sg
    items = {}
    for r, rows in plan.items():
        its = []
        for row in rows:
            start = None; segs = []
            for (key, fwd) in row:
                s0 = tuple(pts[key][0]); sg = cache[key]
                if not fwd:
                    s0, sg = rev_segs(s0, sg)
                if start is None:
                    start = s0
                elif (abs(s0[0] - _lastp(start, segs)[0]) > 1e-6
                      or abs(s0[1] - _lastp(start, segs)[1]) > 1e-6):
                    segs.append(("L", s0))
                segs += sg
            if start is not None and segs:
                its.append(("B", start, segs))
        if its:
            items[r] = its
    return items, len(cache), len(cache)


def _lastp(start, segs):
    return segs[-1][-1] if segs else start


def _resample(P, closed, step=1.0):
    A = np.asarray(P, np.float64)
    d = np.hypot(*(np.diff(A, axis=0).T))
    s = np.concatenate([[0.0], np.cumsum(d)])
    if s[-1] < step * 3:
        return A
    m = max(4, int(round(s[-1] / step)))
    t = np.linspace(0.0, s[-1], m + 1)
    return np.stack([np.interp(t, s, A[:, 0]), np.interp(t, s, A[:, 1])], 1)


def theta_smooth(P, closed, sig=None, corner=None):
    """เกลา 'ทิศทางของเส้น' แทนการเกลา 'ตำแหน่งจุด'

    ⚠️ อาการ "เส้นไม่เนียน" ที่ตาเห็น คือทิศทางของเส้นสั่นไปมา (θ กระเพื่อม)
       ต่อให้ตำแหน่งจุดคลาดแค่ 0.2 px ถ้าทิศทางสั่น ตาก็เห็นเป็นคลื่นทันที
       การเกลาตำแหน่งลดการสั่นได้ช้ามาก และแลกมาด้วยการหดรูป
    ✅ แปลงเส้นเป็น "มุมของทิศทาง เทียบกับระยะทางที่เดินมา" แล้วเกลาสัญญาณนั้นตรง ๆ
       มุมหักจริง (> TH_CORNER) กันไว้ไม่ให้เกลาข้าม แล้วค่อยประกอบเส้นกลับ
       -> ได้เส้นที่ทิศทางเปลี่ยนอย่างนุ่มนวลจริง (นี่คือนิยามของ 'เนียน')
    """
    sig = TH_SIG if sig is None else sig
    corner = TH_CORNER if corner is None else corner
    if sig <= 0:
        return np.asarray(P, np.float64)
    A = _resample(P, closed, TH_STEP)
    n = len(A)
    if n < 8:
        return np.asarray(P, np.float64)
    v = np.diff(A, axis=0)
    L = np.hypot(v[:, 0], v[:, 1])
    ok = L > 1e-9
    if not ok.all():
        A = A[np.concatenate([[True], ok])]
        v = np.diff(A, axis=0); L = np.hypot(v[:, 0], v[:, 1])
        n = len(A)
        if n < 8:
            return np.asarray(P, np.float64)
    th = np.unwrap(np.arctan2(v[:, 1], v[:, 0]))
    dth = np.degrees(np.abs(np.diff(th)))
    cut = [0] + [int(i) + 1 for i in np.flatnonzero(dth > corner)] + [len(th)]
    cut = sorted(set(cut))
    rad = max(1, int(round(sig * 2)))
    w = np.exp(-0.5 * (np.arange(-rad, rad + 1) / float(sig)) ** 2); w /= w.sum()
    out = th.copy()
    for a, b in zip(cut[:-1], cut[1:]):
        seg = th[a:b]
        if len(seg) < 3:
            continue
        pad = np.concatenate([np.full(rad, seg[0]), seg, np.full(rad, seg[-1])])
        out[a:b] = np.convolve(pad, w, mode="valid")
    Q = np.empty_like(A)
    Q[0] = A[0]
    Q[1:] = A[0] + np.cumsum(np.stack([L * np.cos(out), L * np.sin(out)], 1), 0)
    # ปิดค่าคลาดที่ปลาย: เกลี่ยเป็นเส้นตรงตลอดความยาว (ไม่ทำให้เกิดคลื่นใหม่)
    tgt = A[0] if closed else A[-1]
    err = tgt - Q[-1]
    Q += np.outer(np.linspace(0.0, 1.0, len(Q)), err)
    if closed:
        Q[-1] = Q[0]
    return Q


def _flatten(start, segs, step=1.0):
    """กางเส้นโค้งออกเป็นแนวจุด (ตัวโค้งจริง ไม่ใช่แนวจุดที่ใช้ฟิต)"""
    P = [np.array(start, float)]
    cur = np.array(start, float)
    for sg in segs:
        if sg[0] == "L":
            e = np.array(sg[1], float)
            m = max(1, int(np.hypot(*(e - cur)) / step))
            for k in range(1, m + 1):
                P.append(cur + (e - cur) * (k / m))
            cur = e
        else:
            c1 = np.array(sg[1], float); c2 = np.array(sg[2], float)
            e = np.array(sg[3], float)
            L = (np.hypot(*(c1 - cur)) + np.hypot(*(c2 - c1)) + np.hypot(*(e - c2)))
            m = max(2, min(400, int(L / step)))
            for k in range(1, m + 1):
                t = k / m; u = 1 - t
                P.append(u**3 * cur + 3*u*u*t * c1 + 3*u*t*t * c2 + t**3 * e)
            cur = e
    return np.array(P)


def g1_join(start, segs, deg=34.0):
    """ทำให้รอยต่อระหว่างเบซิเยร์สองท่อน 'ทิศทางตรงกัน'

    ⚠️ ฟิตทีละท่อนแยกกัน ทิศทางที่รอยต่อไม่ตรงกันเป๊ะ -> เกิดหักมุมจาง ๆ ทุกรอยต่อ
       เส้นโค้งยาวหนึ่งเส้นมีรอยต่อเป็นสิบ = ตาเห็นเป็น 'คลื่น' ทั้งที่จุดไม่ได้คลาดเลย
    ✅ ที่รอยต่อที่ไม่ใช่มุมจริง ดึงจุดควบคุมสองข้างให้อยู่บนเส้นตรงเดียวกัน (คงความยาวเดิม)
    """
    if not segs:
        return start, segs
    pts = [start] + [s[-1] for s in segs]
    S = [list(s) for s in segs]
    for i in range(len(S) - 1):
        a, b = S[i], S[i + 1]
        if a[0] != "C" or b[0] != "C":
            continue
        p = np.array(pts[i + 1], float)
        u = p - np.array(a[2], float)                 # ทิศขาเข้า
        w2 = np.array(b[1], float) - p                # ทิศขาออก
        lu = float(np.hypot(*u)); lw = float(np.hypot(*w2))
        if lu < 1e-9 or lw < 1e-9:
            continue
        cs = float((u @ w2) / (lu * lw))
        if cs < math.cos(math.radians(deg)):
            continue                                  # มุมจริง ปล่อยไว้
        t = (u / lu + w2 / lw)
        lt = float(np.hypot(*t))
        if lt < 1e-9:
            continue
        t /= lt
        a[2] = tuple(p - t * lu)
        b[1] = tuple(p + t * lw)
    return start, [tuple(s) for s in S]


def planar_layers(img_rgb, keep, seed=0, progress=None, pal_lab=None, stroke=0.0,
                  snap=None):
    """ทางเข้าหลัก — คืน list ของชั้นสี (พิกัดหน่วยภาพงาน) ของ "ย่านลาย"

    img_rgb : ภาพที่ผ่านการเตรียมของเอนจิ้นแล้ว (ขยาย + ฉายกลับ + ยุบขอบ)
    keep    : หน้ากากย่านลาย (True = ไม่ใช่พื้นไล่สี)
    คืน []  ถ้าทำไม่ได้ -> ผู้เรียกใช้ชั้นเดิมต่อได้ทันที
    """
    def _pg(p, s):
        if progress is not None:
            try:
                progress(p, s)
            except Exception:
                pass
    H, W = img_rgb.shape[:2]
    _pg(56, "แบ่งภาพเป็นภูมิภาค")
    # 🎨 ใช้จานสีที่เอนจิ้นเลือกไว้แล้ว (auto_k) แทนการตั้ง 20 สีตายตัว
    #    ⚠️ วัดจริง 2026-08-16: ภาพลายเส้นขาวดำถูกบังคับ 20 สี -> เส้นบางกลายเป็น
    #       ปื้นเทาหลายเฉด ค่าคลาดที่ขอบพุ่ง 21 -> 36 (ตราสมอ)
    #    เอนจิ้นเลือกสีมาแล้วอย่างเหมาะสมกับภาพนั้น ๆ ใช้ของเดิมดีที่สุด
    _cen = None
    if pal_lab is not None and len(pal_lab) >= 2:
        _cen = np.asarray(pal_lab, np.float32)
    # 📏 เกณฑ์ชิ้นจิ๋วต้องผูกกับ "ความหนาเส้นจริงในภาพ" ไม่ใช่สัดส่วนพื้นที่ตายตัว
    #    เส้นหนา s พิกเซล ยาว s พิกเซล มีพื้นที่ s² -> เกณฑ์ต้องต่ำกว่านั้นมาก
    _map = (max(6.0, (float(stroke) * 0.30) ** 2) if stroke and stroke > 0 else 0.0)
    res = build(img_rgb, keep=keep, dom=None, K=K_COLORS,
                min_area_frac=MIN_AREA_FRAC, de_merge=DE_MERGE,
                target=10 ** 9, thin=THIN, seed=seed, cen=_cen, min_area_px=_map)
    reg = res["reg"]
    if reg is None or int(reg.max()) <= 0:
        return []
    # ══════════════════════════════════════════════════════════════
    # ══════════════════════════════════════════════════════════════
    # 🔗 รวม "พื้นไล่สี" ทุกก้อนเป็นก้อนเดียวก่อนไล่เส้น
    # ⚠️ วัดจริง 2026-08-17: พื้นรุ้งถูกแบ่งเป็น 11 ภูมิภาคที่มาแตะขอบวงกลมขาว
    #    ขอบวงยาว 5,740 จุด แต่มีจุดต่อ 21 จุด -> ถูกหั่นเป็น 21 ท่อน ฟิตแยกกัน
    #    แต่ละท่อนได้วงกลมของตัวเอง ไม่ตรงกัน -> รัศมีแกว่ง ±25 px (ต้นฉบับ ±5)
    #    = อาการ "ขอบวงกลมยึกยือ" ที่ผู้ใช้ทักซ้ำ
    # ✅ ยังไงพื้นไล่สีก็ถูกทิ้งอยู่แล้ว (ปล่อยชั้นไล่สีเดิมโชว์) ไม่มีเหตุผลต้องแยก
    #    พอรวมเป็นก้อนเดียว จุดต่อหายหมด ขอบวงเป็นเส้นปิดเส้นเดียว
    #    -> ตัวทาบวงกลมจับได้ทั้งวง = กลมจริง
    # ══════════════════════════════════════════════════════════════
    BG_ID[0] = -1
    n0 = int(reg.max()) + 1
    _ins = np.bincount(reg.reshape(-1), weights=keep.reshape(-1).astype(np.float64),
                       minlength=n0)
    _tot = np.bincount(reg.reshape(-1), minlength=n0)
    _fr = _ins / np.maximum(_tot, 1)
    _bg = [r for r in range(1, n0) if _tot[r] > 0 and _fr[r] < 0.5]
    if len(_bg) > 1:
        _tgt = max(_bg, key=lambda r: _tot[r])
        _lut = np.arange(n0, dtype=reg.dtype)
        for r in _bg:
            _lut[r] = _tgt
        reg = _lut[reg]
        res["reg"] = reg
        _w = np.array([_tot[r] for r in _bg], np.float64)
        res["mean"][_tgt] = (res["mean"][_bg] * _w[:, None]).sum(0) / max(1.0, _w.sum())
        res["area"][_tgt] = float(_w.sum())
        BG_ID[0] = int(_tgt)
    # ══════════════════════════════════════════════════════════════
    # 🧽 กลืน "ขลิบสีเกลี่ย" ที่คั่นระหว่างลายกับพื้นไล่สี
    # ⚠️ วัดจริง 2026-08-18 (ผู้ใช้วงขอบวงกลมล่างขวารอบที่สี่):
    #    ระหว่างวงกลมขาวกับพื้นรุ้ง มีวงแหวนสีเกลี่ยหนา 3-5 px คั่นอยู่ (พื้นที่ 4,063 px)
    #    ถูกวาดเป็นชั้นเขียวอ่อนของตัวเอง = เห็นเป็น "ขลิบซีด" รอบวง และขอบสองด้าน
    #    ของมันสะดุดเป็นบันได · พอกลืนทิ้ง: ค่าเบี่ยงจากวงกลม sd 1.72 -> 1.36
    #    จุดที่เพี้ยนเกิน 2 px ลดจาก 24.3% เหลือ 2.6%
    # 🔒 ทำเฉพาะขลิบที่ "ติดกับพื้นไล่สีที่จะถูกทิ้งอยู่แล้ว" เท่านั้น
    #    ⛔ เคยเปิดให้ทุกขลิบ -> ภาพเส้นหนา (test-06) ชิ้น 119 -> 23 · ΔE 14.62 -> 16.70
    #       เพราะขอบเกลี่ยของเส้นหนาก็ 'บาง + เป็นสีผสม' เหมือนกัน แต่มันคือของจริง
    #    ✅ ผูกกับพื้นไล่สีจึงปลอดภัย: ภาพลายเส้นไม่มีพื้นไล่สี (BG_ID = -1) = ไม่ถูกแตะเลย
    # ══════════════════════════════════════════════════════════════
    lab = VE.labf(cv2.cvtColor(img_rgb, cv2.COLOR_RGB2LAB).reshape(-1, 3)
                  ).reshape(H, W, 3).astype(np.float64)
    if BLEND_THIN > 0 and BG_ID[0] >= 0:
        try:
            reg = _dissolve_blend(reg, res, float(BLEND_AREA) * H * W, BG_ID[0], lab)
            res["reg"] = reg
        except Exception:
            pass
    _pg(66, "ไล่ขอบร่วม")
    # ══════════════════════════════════════════════════════════════
    # 🎯 เอาสีจาก "เนื้อใน" ของภูมิภาค ไม่ใช่ทั้งก้อน
    # ⚠️ วัดจริง 2026-08-17 (ผู้ใช้วงโลโก้เล็ก LINEMAN/wongnai ว่า "ยังไม่ชัด"):
    #    ตัวอักษร "nai" ในวงส้ม สูงจริงแค่ ~8 px ในไฟล์ต้นฉบับ ขอบเกลี่ยกินเกือบทั้งตัว
    #    ค่าเฉลี่ยทั้งก้อนจึงเป็น "ขาวผสมส้ม" = สีครีม (245,213,176) แทนที่จะเป็นขาว
    #    -> ตาเห็นเป็นตัวหนังสือจาง ๆ ไม่คม ทั้งที่รูปทรงถูกแล้ว
    # ✅ กร่อนขอบทิ้งก่อนแล้วค่อยเฉลี่ย = ได้สีจริงของตัวอักษร (ขาว)
    #    ก้อนที่เล็กจนกร่อนแล้วไม่เหลือ ใช้ค่าเดิม (ไม่เสี่ยง)
    # ══════════════════════════════════════════════════════════════
    if CORE_FIT > 0:
        try:
            _in = np.ones(reg.shape, bool)
            for _ in range(int(CORE_FIT)):
                _e = _in.copy()
                for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1),
                               (-1, -1), (-1, 1), (1, -1), (1, 1)):
                    _s = np.roll(np.roll(reg, dy, 0), dx, 1)
                    _e &= (_s == reg)
                _e[0, :] = _e[-1, :] = _e[:, 0] = _e[:, -1] = False
                _in = _e
            _n9 = int(reg.max()) + 1
            _idx = reg[_in].reshape(-1)
            _cnt = np.bincount(_idx, minlength=_n9).astype(np.float64)
            _sum = np.stack([np.bincount(_idx, weights=lab[:, :, _c][_in],
                                         minlength=_n9) for _c in range(3)], 1)
            _ok = _cnt >= CORE_MIN
            if _ok.any():
                _m2 = res["mean"].copy()
                _m2[_ok] = _sum[_ok] / _cnt[_ok, None]
                res["mean"] = _m2
        except Exception:
            pass
    items, _, _ = build_paths(reg, mean=res["mean"], lab=lab)
    if not items:
        return []
    _pg(80, "ประกอบชั้นสี")
    # 🚮 ทิ้งภูมิภาคที่อยู่บนพื้นไล่สีเป็นหลัก — ปล่อยให้ชั้นไล่สีเดิมโชว์
    #    (เราไล่เส้นทั้งภาพเพื่อให้ "ขอบวงนอก" เป็นขอบร่วมจริง ไม่ใช่ขอบของหน้ากาก
    #     ซึ่งเป็นเหตุที่ขอบวงกลมขาวเคยหยักเป็นปุ่ม ๆ)
    n = int(reg.max()) + 1
    ins = np.bincount(reg.reshape(-1), weights=keep.reshape(-1).astype(np.float64),
                      minlength=n)
    tot = np.bincount(reg.reshape(-1), minlength=n)
    frac = ins / np.maximum(tot, 1)
    # 🎨 ดึงสีของทุกชิ้นเข้าจานสีของเอนจิ้น — ห้ามมีสีนอกจาน
    #    ⚠️ เดิมใช้ "สีเฉลี่ยของภูมิภาค" ตรง ๆ -> ภาพลายเส้นขาวดำได้ 239 สี
    #       เส้นบางที่เกลี่ยขอบกลายเป็นปื้นเทาหลายเฉด (เห็นชัดที่ตราสมอ)
    #    ✅ สแนปเข้าจานที่เอนจิ้นเลือกไว้ = สีสะอาด เท่าที่ภาพมีจริง
    _mean = res["mean"]
    _snap = PAL_SNAP if snap is None else snap
    if pal_lab is not None and len(pal_lab) >= 2:
        _p = np.asarray(pal_lab, np.float64)
        _d = ((_mean[:, None, :] - _p[None, :, :]) ** 2).sum(2)
        _sn = _p[_d.argmin(1)]
        if _snap:
            _mean = _sn
        elif SNAP_SMALL > 0:
            # ══════════════════════════════════════════════════════
            # 🔍 ภาพที่มีพื้นไล่สีจริง ห้ามสแนปทั้งกระดาน (วัดแล้วพื้นรุ้งเสียเฉด)
            #    แต่ "ชิ้นจิ๋ว" ต่างออกไป — เล็กจนขอบเกลี่ยกินเกือบทั้งชิ้น
            #    ค่าเฉลี่ยจึงเป็นสีผสม ไม่ใช่สีจริง (ตัว nai ในวงส้ม ได้สีครีมแทนขาว)
            # ✅ สแนปเฉพาะชิ้นที่เล็กกว่าเกณฑ์ = ตัวอักษร/โลโก้จิ๋วได้สีจริงคืนมา
            #    พื้นไล่สีก้อนใหญ่ไม่ถูกแตะเลย
            # ══════════════════════════════════════════════════════
            _lim = float(SNAP_SMALL) * H * W
            _sm = np.asarray(res["area"], np.float64) <= _lim
            if _sm.any():
                _mean = _mean.copy()
                _mean[_sm] = _sn[_sm]
    rgbs = cv2.cvtColor(VE.unlabf(_mean.astype(np.float32)).reshape(-1, 1, 3),
                        cv2.COLOR_LAB2RGB).reshape(-1, 3)
    area = res["area"]
    out = []
    for r in sorted(items, key=lambda x: -area[x]):
        if r < len(frac) and frac[r] < 0.5:
            continue
        out.append({"rgb": tuple(int(v) for v in rgbs[r]),
                    "items": items[r], "n": int(area[r]),
                    "area": float(area[r])})
    return out


# ══════════════════════════════════════════════════════════════════
# 📓 บันทึกสิ่งที่ลองแล้ว "ไม่ผ่าน" — อย่ารื้อมาทำซ้ำ (วัดจริงทุกข้อ)
# ══════════════════════════════════════════════════════════════════
# ⛔ ปิดตัวยุบขอบ (shock filter) ของเอนจิ้น  : ΔE ขอบ 7.00 -> 8.11 · คม 602 -> 568
# ⛔ เกลาในปริภูมิทิศทาง (theta-s)          : ΔE ขอบ 7.00 -> 9.16
#    (ค่าคลาดสะสมที่ปลายเส้น พอเกลี่ยกลับทำให้กลางเส้นเบี้ยวทั้งเส้น)
# ⛔ บังคับ G1 ที่รอยต่อเบซิเยร์             : ผลเหมือนเดิมทุกไบต์
#    (_schneider ใช้ทิศร่วมกันสองฝั่งตอนผ่าช่วงอยู่แล้ว)
# ⛔ ลบปุ่มด้วยค่ามัธยฐานบนระยะขยับ          : ΔE ขอบ 7.13 -> 7.22
# ⛔ ลบ "เศษเสี้ยน" (บาง+เล็ก)              : ΔE ขอบ 7.10 -> 7.41 · คม 597 -> 591
# ⛔ ลดเกณฑ์ยาวขั้นต่ำของเส้นตรงทั้งกระดาน   : หัวตัว I หายจริง แต่ท้องตัว O เป็นเหลี่ยม
# ⛔ เกลาแผนที่ภูมิภาคที่เกณฑ์ 4 เสียง        : ตัวอักษรบิดเป็นหัวลูกศร ΔE 13.55
# ⛔ ดันความละเอียดงานเป็น 3300 px          : ตัวตรวจพื้นไล่สีเปลี่ยนพฤติกรรมหมด
#    (ย่านลายเหลือ 5% จาก 33%) เทียบกันไม่ได้
# ⛔ ปรับความแรงเกลาตามขนาดชิ้นงาน          : ตัวอักษรเล็กแตกกว่าเดิม
#    (ตัวอักษรเล็กต้องการการเกลา "มาก" ไม่ใช่ "น้อย")
# ⚠️ TURN_MAX คือค่าที่ละเอียดอ่อนที่สุด — 3.0 ช่วยขาตัว E แต่ทำตัว O เป็นเหลี่ยม
#    เพราะส่วนโค้งรัศมี R ยาว L เลี้ยว 57.3*L/R องศา · R=340 L=18 ได้ 3.0 พอดี
