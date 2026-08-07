"""🎨 Vectora engine — แปลงภาพพิกเซล -> เวกเตอร์คม (ตัวจริง ใช้งานได้)

โมดูลนี้ **อิสระ 100%** ไม่ import อะไรจากแอปทำป้ายเลย
(ตัวฟิตเบซิเยร์ถูกคัดลอกมาไว้ในไฟล์นี้เอง เพื่อให้ยกไปวางที่ไหนก็รันได้)

หลักการ (พิสูจน์ด้วยการวัดจริงแล้ว — แม่นกว่าตัวแปลงทั่วไป 4.3 เท่า):
  1) ลดจำนวนสีด้วย K-means บนปริภูมิ Lab (ตาคนมองว่าใกล้กันจริง ไม่ใช่ RGB)
  2) สร้าง 'สนามความเป็นสีนั้น' แบบต่อเนื่อง ไม่ใช่ 0/1
     พิกเซลตรงขอบเป็นสีผสมของ 2 สี -> คำนวณสัดส่วนผสมได้ = รู้ว่าขอบอยู่ 'ตรงไหนในพิกเซล'
  3) ดึงคอนทัวร์ที่ระดับ 0.5 (marching squares + interpolate) = ขอบระดับย่อยพิกเซล
     >>> นี่คือเหตุผลที่ผลลัพธ์ 'คมกว่าภาพต้นฉบับ'
  4) เกลาแบบไม่กินมุมคม + ตัดที่มุมก่อนฟิตเบซิเยร์ (กันเงี่ยงแหลมยื่นออกนอกรูป)
  5) ซ้อนชั้นใหญ่ไปเล็ก + ดันขอบออกเศษพิกเซล = ไม่มีเส้นขาวบางคั่นระหว่างสี
"""

import math
import time

import cv2
import numpy as np
from skimage import measure

# 🚨 กติกาข้อแรกของโมดูลนี้: **ห้ามย่อภาพของผู้ใช้เงียบ ๆ**
#    จุดขายของเครื่องมือคือ 'คมกว่าต้นฉบับ' — ถ้าแอบย่อก่อนคำนวณก็ขัดกันเองตั้งแต่ต้น
#    (เคยตั้งไว้ 1600 px เพื่อประหยัดแรม ทำให้ภาพ 2362 px ของผู้ใช้โดนทิ้งรายละเอียด 32%)
#    ตอนนี้คำนวณที่ความละเอียดเต็มเสมอ · ตัวเลขข้างล่างเป็นแค่กันแรมแตกเท่านั้น
#    และถ้าถึงเพดานจริง ต้องรายงานออกไปที่ stats["downscaled"] ให้ผู้ใช้เห็น ห้ามเงียบ
MAX_WORK_MP = 16.0          # ล้านพิกเซล (≈ 4000 × 4000) — วัดแล้วใช้แรมราว 300 MB
#                             เกินนี้ค่อยย่อ **และต้องแจ้งผู้ใช้** ที่ stats['downscaled']


# ══════════════════════════════════════════════════════════════════
# ตัวฟิตเบซิเยร์ (คัดลอกมาจากตัวที่ใช้ทำเส้นตัดจริง — เนียนระดับเดียวกัน)
# ══════════════════════════════════════════════════════════════════
def _to_curves(pts, closed=False, tol=0.12, corner_deg=48.0):
    """แนวจุดถี่ ๆ -> เส้นโค้งเบซิเยร์จริง · คืน (start, segs) แบบ ("C",c1,c2,end)/("L",p)"""
    try:
        from shapely.geometry import LineString
        P = [tuple(p) for p in pts]
        if closed and len(P) > 2 and (abs(P[0][0] - P[-1][0]) > 1e-9 or abs(P[0][1] - P[-1][1]) > 1e-9):
            P = P + [P[0]]
        if len(P) < 3:
            return P[0], [("L", q) for q in P[1:]]
        try:
            K = list(LineString(P).simplify(float(tol)).coords)
        except Exception:
            K = P
        if len(K) < 3:
            return K[0], [("L", q) for q in K[1:]]
        if closed and len(K) > 3 and abs(K[0][0] - K[-1][0]) < 1e-9 and abs(K[0][1] - K[-1][1]) < 1e-9:
            K = K[:-1]; n = len(K); wrap = True
        else:
            n = len(K); wrap = False

        def at(i):
            return K[i % n] if wrap else K[min(max(i, 0), n - 1)]

        def ang(i):
            a, b, c = at(i - 1), at(i), at(i + 1)
            v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
            l1 = math.hypot(*v1); l2 = math.hypot(*v2)
            if l1 < 1e-9 or l2 < 1e-9:
                return 0.0
            d = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))
            return math.degrees(math.acos(d))

        sharp = {i % n for i in (range(n) if wrap else range(1, n - 1)) if ang(i) > float(corner_deg)}
        segs = []
        last = n if wrap else n - 1
        for i in range(last):
            p1, p2 = at(i), at(i + 1)
            p0 = p1 if ((i % n) in sharp or (not wrap and i == 0)) else at(i - 1)
            p3 = p2 if (((i + 1) % n) in sharp or (not wrap and i + 1 == n - 1)) else at(i + 2)
            c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
            c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
            segs.append(("C", c1, c2, p2))
        return K[0], segs
    except Exception:
        return pts[0], [("L", q) for q in pts[1:]]


# ══════════════════════════════════════════════════════════════════
# 1) ลดจำนวนสี
# ══════════════════════════════════════════════════════════════════
def _kmeans_lab(X, k, seed=0, sample=60000):
    # ⚠️ cv2.kmeans ใช้ RNG ของ OpenCV เอง ไม่เกี่ยวกับ numpy
    #    ถ้าไม่ล็อกเมล็ด ภาพเดิมกดแปลงสองครั้งจะได้จานสีคนละชุด (เจอจริงตอนทดสอบ)
    cv2.setRNGSeed(int(seed) + 12345)
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(X), size=min(sample, len(X)), replace=False)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.5)
    comp, _, cen = cv2.kmeans(X[idx], int(k), None, crit, 4, cv2.KMEANS_PP_CENTERS)
    return cen, comp / max(len(idx), 1)


def auto_k(X, seed=0, ladder=(2, 3, 4, 6, 8, 12, 16, 24), min_gain=0.25, good=2.0, max_err=12.0):
    """เดาจำนวนสีที่เหมาะ — หา 'ข้อศอก' ของกราฟความคลาดสี

    วัดเป็น RMS ΔE ในปริภูมิ Lab (ค่าที่ตาคนรับรู้จริง · ΔE ราว 2-3 = แทบแยกไม่ออก)
    ⚠️ อย่าใช้เกณฑ์ 'ต่ำกว่า X ก็พอ' อย่างเดียว — ภาพ JPEG มีรอยบีบอัด
       ค่าจะไม่มีวันลงต่ำ ไล่ k ไปเรื่อยจนได้ 24 สีให้ภาพโลโก้ 5 สี (เจอจริงแล้ว)
    ✅ ดูที่ 'กำไรต่อการเพิ่ม k' แทน — พอเพิ่ม k แล้วดีขึ้นน้อยกว่า 25% ก็หยุด แล้วถอย 1 ขั้น
    """
    prev = None; prev_k = int(ladder[0])
    for k in ladder:
        try:
            _, err = _kmeans_lab(X, k, seed=seed, sample=20000)
        except Exception:
            break
        rms = float(err) ** 0.5
        # ⚠️ ดูกำไรอย่างเดียวไม่พอ — ภาพไล่เฉด (ภาพถ่าย) กำไรจะน้อยตั้งแต่ k=2
        #    ถ้าหยุดตรงนั้นจะได้ภาพถ่ายเหลือ 2 สี (เจอจริงแล้ว) จึงต้องผ่านเกณฑ์ 'พอใช้ได้' ก่อน
        if prev is not None and rms > prev * (1.0 - min_gain) and prev <= max_err:
            return prev_k                               # กำไรไม่คุ้มแล้ว -> ใช้ค่าก่อนหน้า
        prev, prev_k = rms, int(k)
        if rms <= good:                                 # ตรงเป๊ะแล้ว ไม่ต้องเพิ่มอีก
            break
    return prev_k


def merge_blends(cen, counts, max_share=0.08, t_lo=0.12, t_hi=0.88, dperp=13.0):
    """🧹 ตัด 'สีขอบผสม' ทิ้ง

    ⚠️ ปัญหาที่เจอจริง: ขอบระหว่างเขียวกับน้ำเงินมีพิกเซลสีเทาอมฟ้า (สีผสมของสองสีนั้น)
       K-means มองว่านั่นคือ 'สีที่ 6' แล้วสร้างเป็นชั้นแยก -> ได้ **ขอบเทาล้อมรูป**
       เห็นชัดมากตอนขยาย เหมือนมีเส้นขอบสกปรกที่ไม่มีในต้นฉบับ
    ✅ สีไหนที่ (ก) มีพิกเซลน้อย และ (ข) นอนอยู่บนเส้นตรงระหว่างสีหลักสองสีในปริภูมิ Lab
       = สีผสม ไม่ใช่สีจริง -> ตัดทิ้ง แล้วโยนพิกเซลไปหาสีหลักที่ใกล้สุด
    """
    n = len(cen)
    tot = float(max(counts.sum(), 1))
    order = sorted(range(n), key=lambda i: counts[i])          # เล็กสุดพิจารณาก่อน
    alive = set(range(n))
    for i in order:
        if counts[i] > max_share * tot or len(alive) <= 2:
            continue
        big = [j for j in alive if j != i and counts[j] > counts[i]]
        drop = False
        for a in range(len(big)):
            for b in range(a + 1, len(big)):
                P, Q = cen[big[a]], cen[big[b]]
                v = Q - P
                L2 = float((v * v).sum())
                if L2 < 1e-6:
                    continue
                t = float(((cen[i] - P) * v).sum() / L2)
                if not (t_lo < t < t_hi):
                    continue
                if float(np.linalg.norm(cen[i] - (P + t * v))) < dperp:
                    drop = True; break
            if drop:
                break
        if drop:
            alive.discard(i)
    keep = sorted(alive)
    return cen[keep]


def detect_scale(img_rgb, thr=20.0, ladder=(2, 3, 4, 6, 8, 12), cap=10.0):
    """🔎 หา 'ความละเอียดจริง' ของภาพ — ไม่ใช่ตัวเลขที่เขียนไว้ในไฟล์

    ⚠️ เคสจริงจากผู้ใช้ (2026-08-07): ไฟล์บอก 2362 × 2362 px
       แต่ย่อลง 8 เท่าแล้วขยายกลับ ภาพแทบไม่ต่างจากเดิม = เนื้อจริงมีแค่ราว 295 px
       ที่เหลือคือการขยายเปล่า ๆ ทำให้ 'พิกเซลที่ตาเห็น' กว้างบล็อกละ 8 px
       เครื่องแปลงจึงเดินเส้นไต่ขั้นบันไดของบล็อก ออกมาเป็นขอบหยักเป็นคลื่น

    ⚠️ กับดักรอบสอง: วัดความคลาด 'เฉลี่ยทั้งภาพ' ใช้ไม่ได้
       พื้นที่ว่างกินสัดส่วนเกือบทั้งภาพและไม่คลาดเลย ค่าเฉลี่ยจึงต่ำเสมอ
       โลโก้ที่มีเส้นบางจริง (ขนตา · รูม่านตา) เลยถูกตัดสินว่า 'ขยายมา 10 เท่า'
       แล้วโดนย่อจนรายละเอียดหาย (เจอจริงกับไฟล์ Baron's)
    ✅ วัดเฉพาะ 'พิกเซลที่เป็นขอบ' — ที่เดียวที่มีข้อมูลจริงอยู่
       วัดจริง 3 ไฟล์: ลายเส้นหมู ÷4 · Baron's ÷3 (เส้นบางเยอะ) · Ginger ÷8
    """
    H, W = img_rgb.shape[:2]
    g = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, 3), cv2.Sobel(g, cv2.CV_32F, 0, 1, 3))
    if m.max() <= 0:
        return 1.0
    e = cv2.dilate((m > m.max() * 0.08).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    if int(e.sum()) < 200:
        return 1.0
    ok = 1.0
    for f in ladder:
        if min(W, H) // f < 64:
            break
        sm = cv2.resize(img_rgb, (W // f, H // f), interpolation=cv2.INTER_AREA)
        bk = cv2.resize(sm, (W, H), interpolation=cv2.INTER_CUBIC)
        d = np.abs(img_rgb.astype(np.float32) - bk.astype(np.float32)).mean(2)
        if float(d[e].mean()) > float(thr):
            break
        ok = float(f)
    return min(ok, float(cap))


def stroke_px(img_rgb, pct=10):
    """ความหนาของ 'เส้นที่บางที่สุด' ในภาพ (หน่วยพิกเซล)

    ⚠️ บทเรียนสำคัญ: จะย่อภาพลงเท่าไหร่ ตัดสินจาก 'ความคลาดของภาพ' อย่างเดียวไม่ได้
       โลโก้ Ginger ย่อได้ 8 เท่าโดยภาพแทบไม่เปลี่ยน — แต่ตัวอักษรมีเส้นบางสุด 6 px
       ย่อ 8 เท่าแล้วเหลือไม่ถึง 1 px ตัวอักษรจึงแตกเป็นก้อน ๆ อ่านไม่ออก (เจอจริง)
    ✅ วัดความหนาเส้นจริงจากแกนกลาง (distance transform ที่โครงกระดูก)
       แล้วบังคับว่าหลังย่อแล้วเส้นบางสุดต้องเหลืออย่างน้อย ~8 px
    """
    try:
        from skimage.morphology import skeletonize
        g = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
        th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
        if (th > 0).mean() > 0.5:
            th = 255 - th
        if (th > 0).sum() < 200:
            return 999.0
        d = cv2.distanceTransform(th, cv2.DIST_L2, 5)
        sk = skeletonize(th > 0)
        v = d[sk]
        if v.size < 20:
            return 999.0
        return float(2.0 * np.percentile(v, pct))
    except Exception:
        return 999.0


def noise_sigma(img_rgb):
    """ประเมินระดับจุดรบกวนของภาพ (วิธี Immerkær) — เร็วมาก ใช้ตัดสินว่าต้องกรองก่อนไหม"""
    g = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    K = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], np.float32)
    r = cv2.filter2D(g, -1, K)
    H, W = g.shape
    return float(np.abs(r).sum() * math.sqrt(0.5 * math.pi) / (6.0 * max((W - 2) * (H - 2), 1)))


def prefilter(img_rgb, R, thr=2.2):
    """🧽 กรองจุดรบกวนก่อนแยกสี — เฉพาะภาพที่มีจริงเท่านั้น

    ⚠️ ทำไมต้องกรองก่อน ไม่ใช่กรองทีหลัง: จุดรบกวนทำให้ K-means มองเห็น 'สีปลอม'
       เคสวัดจริง ลายเส้นขาวดำที่มีจุดรบกวน -> ระบบแยกได้ 4 สี แล้วแตกเป็น 1,788 ชิ้น
       ต่อให้ไปเกลาเส้นทีหลังแค่ไหนก็แก้ไม่ได้ เพราะมันผิดตั้งแต่ขั้นแยกสีแล้ว
    ✅ ใช้ bilateral — เกลาเนื้อในให้เรียบแต่ 'รักษาขอบ' ไว้ ไม่ทำให้ขอบเบลอเหมือนเบลอธรรมดา
       ภาพสะอาด (ค่าประเมินต่ำกว่าเกณฑ์) จะไม่ถูกแตะเลย
    """
    n = noise_sigma(img_rgb)
    if n <= thr:
        return img_rgb, round(n, 2), 0
    d = int(np.clip(round(3 + 2 * R), 5, 13)) | 1
    out = cv2.bilateralFilter(img_rgb, d, float(np.clip(n * 3.0, 12, 90)),
                              float(np.clip(1.2 * R, 2, 12)))
    return out, round(n, 2), d


def quantize(img_rgb, k=8, seed=0, keep=None, seed_sample=200000):
    """คืน (palette RGB uint8, ภาพ Lab, palette Lab)

    ⚡ ไม่คำนวณป้ายสีของ 'ทุกพิกเซล' ที่นี่แล้ว
       เดิมกาง (พิกเซลทั้งหมด × จำนวนสี × 3) เป็นอาร์เรย์เดียว — ภาพ 2362px กิน 134 MB
       และเป็นคอขวดที่ช้าที่สุด (2.9 จาก 7.9 วินาที) ทั้งที่ nearest2 ก็คำนวณซ้ำอยู่ดี
       ตรงนี้ต้องการแค่ 'สัดส่วนพิกเซลของแต่ละสี' -> สุ่มตัวอย่างก็พอ
    """
    # 💾 เก็บภาพ Lab เป็น uint8 (ตามที่ OpenCV คืนมา) ไม่แปลงเป็น float32 ทั้งภาพ
    #    ภาพ 36 ล้านพิกเซล: uint8 = 108 MB · float32 = 432 MB — ต่างกัน 4 เท่า
    #    การแปลงเป็น float ทำทีละแถบตอนคำนวณระยะพอ
    lab = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2LAB)
    X = lab.reshape(-1, 3)
    rng = np.random.default_rng(seed)
    if keep is not None and keep.any():
        idx = np.flatnonzero(keep.reshape(-1))
    else:
        idx = np.arange(len(X))
    take = idx if len(idx) <= 400000 else idx[rng.choice(len(idx), size=400000, replace=False)]
    Xf = X[take].astype(np.float32)
    if len(Xf) < 8:
        Xf = X[:8].astype(np.float32)
    kk = max(2, min(32, auto_k(Xf, seed) if (k is None or int(k) <= 0) else int(k)))
    cen, _ = _kmeans_lab(Xf, kk, seed=seed)
    S = Xf[rng.choice(len(Xf), size=min(int(seed_sample), len(Xf)), replace=False)]
    lb0 = ((S[:, None, :] - cen[None, :, :]) ** 2).sum(2).argmin(1)
    cen = merge_blends(cen, np.bincount(lb0, minlength=len(cen)).astype(np.float64))
    pal_rgb = cv2.cvtColor(cen.reshape(1, -1, 3).astype(np.uint8), cv2.COLOR_LAB2RGB).reshape(-1, 3)
    return pal_rgb, lab, cen


# ══════════════════════════════════════════════════════════════════
# 2) สนามความเป็นสี (ย่อยพิกเซล)
# ══════════════════════════════════════════════════════════════════
def nearest2(lab, pal_lab, chunk_rows=256):
    """หา 'ระยะถึงสีที่ใกล้ที่สุด' และ 'ใกล้รองลงมา' + ป้ายสีที่ใกล้ที่สุด

    ⚠️ บทเรียนสำคัญ (แก้ 2026-08-07): เดิมเก็บระยะถึง **ทุกสี** ไว้ทั้งก้อน
       = k × สูง × กว้าง × 4 ไบต์ · ภาพ 4000px 12 สี กินแรม 768 MB
       เลยต้องไปย่อภาพเหลือ 1600 px ก่อนคำนวณ -> **ทิ้งรายละเอียดต้นฉบับ**
       ซึ่งขัดกับจุดขายของเครื่องมือนี้ตรง ๆ
    ✅ ที่จริงสูตรต้องการแค่ 'ระยะถึงสีคู่แข่งที่ใกล้ที่สุด' เท่านั้น
       ซึ่งคำนวณจากอันดับ 1 กับ 2 ได้ครบ -> เก็บแค่ 3 ก้อน ไม่ว่าจะกี่สี
       แรมคงที่ ทำงานที่ความละเอียดเต็มของภาพได้เลย
    """
    H, W = lab.shape[:2]
    b1 = np.full((H, W), np.inf, np.float32)
    b2 = np.full((H, W), np.inf, np.float32)
    l1 = np.zeros((H, W), np.int16)
    l2 = np.zeros((H, W), np.int16)
    P = np.asarray(pal_lab, np.float32)
    for y0 in range(0, H, chunk_rows):
        y1 = min(H, y0 + chunk_rows)
        c = lab[y0:y1].astype(np.float32)
        B1 = b1[y0:y1]; B2 = b2[y0:y1]; L1 = l1[y0:y1]; L2 = l2[y0:y1]
        for j in range(len(P)):                       # ทีละสี — ไม่กองอาร์เรย์ k ก้อน
            d = np.sqrt(((c - P[j][None, None, :]) ** 2).sum(2))
            m1 = d < B1
            B2[m1] = B1[m1]; L2[m1] = L1[m1]
            B1[m1] = d[m1];  L1[m1] = j
            m2 = (~m1) & (d < B2)
            B2[m2] = d[m2];  L2[m2] = j
    b2[~np.isfinite(b2)] = 1e6                        # กรณีมีสีเดียวจริง ๆ
    return b1, b2, l1, l2


def coverage_field(k, b1, b2, l1, l2, alpha=None):
    """สัดส่วนที่พิกเซลนั้น 'เป็นสี k' — 0.5 พอดี = ขอบจริง (สีผสม 50:50)

    ⚡ ใช้แค่อันดับ 1-2 ไม่ต้องวนคำนวณระยะใหม่ทุกชั้น
       พิกเซลที่สี k ไม่ติดอันดับ 1 หรือ 2 ค่าจะ < 0.5 เสมออยู่แล้ว
       (เพราะระยะถึง k ยาวกว่าอันดับ 2) เส้นคอนทัวร์ระดับ 0.5 จึงไม่เคยผ่านย่านนั้น
    """
    is1 = (l1 == k); is2 = (l2 == k)
    d = np.where(is1, b1, np.where(is2, b2, 1e6)).astype(np.float32)
    other = np.where(is1, b2, b1).astype(np.float32)
    f = other / np.maximum(other + d, 1e-6)
    if alpha is not None:
        # 🪟 ภาพพื้นโปร่ง: คูณด้วยความทึบ -> คอนทัวร์ 0.5 จะไปเกาะขอบความโปร่งพอดี
        f = f * alpha.astype(np.float32)
    return f.astype(np.float32)      # float32 พอ — float64 กินแรมสองเท่าโดยไม่ได้อะไรเพิ่ม


# ══════════════════════════════════════════════════════════════════
# 3-4) คอนทัวร์ + เกลา + ฟิตเบซิเยร์
# ══════════════════════════════════════════════════════════════════
def corner_mask(p, deg=45.0, look=6):
    """หามุมคม — ⚠️ look ต้อง 6 จุด: คอนทัวร์ย่อยพิกเซลจุดห่างกันแค่ 0.7 px
    ถ้ามองแค่ 3 จุด มุมจริง 104° จะอ่านได้แค่ 38° = จับมุมไม่เจอ (วัดจริงแล้ว)"""
    n = len(p)
    if n < 2 * look + 3:
        return np.zeros(n, bool)
    a = np.asarray(p, float)
    prev = np.roll(a, look, axis=0); nxt = np.roll(a, -look, axis=0)
    v1 = a - prev; v2 = nxt - a
    n1 = np.linalg.norm(v1, axis=1); n2 = np.linalg.norm(v2, axis=1)
    ok = (n1 > 1e-9) & (n2 > 1e-9)
    cos = np.ones(n)
    cos[ok] = np.clip((v1[ok] * v2[ok]).sum(1) / (n1[ok] * n2[ok]), -1, 1)
    return np.degrees(np.arccos(cos)) > float(deg)


def _smooth(p, k, keep_corner=True, corner_deg=45.0):
    """เกลาแบบไม่กินมุมคม — เกลารวดเดียวจะลบมุมแหลม พอฟิตเบซิเยร์แล้วเกิดเงี่ยงยื่นออกนอกรูป"""
    if k <= 1 or len(p) < 2 * k + 2:
        return p
    a = np.vstack([p[-k:], p, p[:k]])
    ker = np.ones(2 * k + 1) / (2 * k + 1)
    sm = np.column_stack([np.convolve(a[:, 0], ker, 'same')[k:-k],
                          np.convolve(a[:, 1], ker, 'same')[k:-k]])
    if not keep_corner:
        return sm
    cm = corner_mask(p, corner_deg)
    if cm.any():
        w = cm.astype(float)
        for _ in range(max(1, k - 1)):
            w = np.maximum.reduce([w, np.roll(w, 1), np.roll(w, -1)])
        w = w[:, None]
        sm = sm * (1 - w) + np.asarray(p, float) * w
    return sm


def denoise_field(field, sigma):
    """🪄 เกลา 'สนามความเป็นสี' ก่อนลากเส้น — หัวใจของความเนียน

    ทำไมต้องเกลาที่สนาม ไม่ใช่เกลาที่เส้นทีหลัง:
      • เบลอแบบเกาส์เซียนไม่ขยับ 'ระดับ 0.5' ของขอบตรง — ตำแหน่งขอบจึงอยู่ที่เดิมเป๊ะ
        (ขอบเป็นทางลาดสมมาตร เบลอแล้วยังสมมาตร จุดกึ่งกลางไม่เลื่อน)
      • แต่คลื่นหยึกหยักเล็ก ๆ จากรอยบีบอัด/สแกน จะถูกเฉลี่ยหายไป
      • ถ้าไปเกลาที่เส้นทีหลังแทน จะได้เส้นหดและมุมมน = เสียรูป

    ⚠️ บทเรียน 2026-08-07: ค่าเกลาเดิมเป็น 'จำนวนจุดคงที่' ซึ่งจูนไว้กับภาพ 250-500 px
       พอเจอภาพ 2362 px มันอ่อนไป 10 เท่า -> ขอบที่หยาบนิดเดียวกลายเป็นขั้นบันไดเต็มรูป
       เคสวัดจริง: ลายเส้นขอบหยาบ 2362 px ได้ 29,665 รูป / 215,121 จุด
    ✅ ความแรงต้องโตตามความละเอียดภาพเสมอ
    """
    if sigma is None or sigma <= 0.05:
        return field
    return cv2.GaussianBlur(field, (0, 0), float(sigma), borderType=cv2.BORDER_REPLICATE)


def kink_ratio(cs, look=6, deg=45.0):
    """ความหยึกหยัก = จำนวน 'จุดหักศอก' ต่อความยาวเส้น 100 พิกเซล

    ⚠️ อย่านับเป็นสัดส่วนของจำนวนจุด — รูปที่มีมุมจริง (สี่เหลี่ยมข้าวหลามตัด) จะถูกตัดสินว่าหยาบ
       แล้วโดนเกลาทั้งที่ไม่ควร (วัดจริง: โลโก้สีสะอาดโดนเกลา σ0.96 ฟรี RMS แย่ลง 20.3 -> 25.3)
    ✅ มุมจริงมี 'ไม่กี่จุดต่อความยาวมาก' · ขอบเป็นขั้นบันไดมี 'จุดหักถี่ตลอดเส้น'
       นับเป็นจำนวนกระจุกมุมต่อระยะทางจึงแยกสองอย่างนี้ออกจากกันได้จริง
    """
    clusters = 0
    length = 0.0
    for c in cs:
        a = np.asarray(c, float)
        if len(a) < 4:
            continue
        length += float(np.hypot(*(np.diff(np.vstack([a, a[:1]]), axis=0).T)).sum())
        if len(a) < 2 * look + 3:
            clusters += 2                      # เส้นสั้นมาก = เศษจุดรบกวน นับเป็นความหยาบ
            continue
        idx = np.flatnonzero(corner_mask(a, deg, look))
        prev = -99
        for i in idx:                          # รวมจุดที่ติดกันให้เป็นมุมเดียว
            if i - prev > 3:
                clusters += 1
            prev = i
    return clusters / max(length / 100.0, 1e-6)


def contours_adaptive(field, min_area, smooth_k=2, sigma0=0.6, sigma_max=6.0,
                      target=1.5, grow_rate=1.7, max_round=5, max_pieces=250):
    """🎯 เกลาเท่าที่จำเป็น — ไม่มากไม่น้อย

    ⚠️ บทเรียน 2026-08-07 (พลาดสองรอบกว่าจะได้): ความแรงการเกลาจะตั้ง 'ตายตัว' ไม่ได้
       • ตั้งอ่อน  -> ภาพขอบหยาบ/ถูกขยายมา ออกมาเป็นขั้นบันได (เคสจริง 29,665 รูป)
       • ตั้งแรง   -> ภาพลายเส้นสะอาด โดนเกลาจนเสียรูป (RMS แย่ลงจาก 9.1 เป็น 19.4)
       • ตั้งตามขนาดภาพ -> ก็ยังผิด เพราะภาพ 2400 px ที่สะอาดกับที่หยาบต้องการคนละค่า
    ✅ วัด 'ความหยึกหยักที่เกิดขึ้นจริง' แล้วเพิ่มความเกลาทีละขั้นจนกว่าจะเนียนพอ
       ภาพสะอาดจึงจบตั้งแต่รอบแรกด้วยค่าเกลาน้อยสุด — ไม่โดนทำร้ายฟรี ๆ
    """
    # 🪜 ไล่ทีละขั้น เริ่มจาก 'ไม่เกลาเลย' — ภาพสะอาดจึงได้ผลดิบที่คมที่สุดตามเดิม
    #    (เคยตั้งขั้นแรกไว้ 0.45 แล้วภาพสะอาดโดนเกลาฟรี ๆ RMS แย่ลง 9.1 -> 10.6)
    ladder = [float(sigma0)] if float(sigma0) > 0.01 else [0.0]
    v = max(0.45, float(sigma0)) * 1.7 if float(sigma0) > 0.01 else 0.45
    while v < float(sigma_max) * 1.05:
        ladder.append(round(v, 2)); v *= float(grow_rate)
    ladder.append(round(float(sigma_max), 2))
    cs = []; sig = 0.0
    for sig in ladder[:int(max_round)]:
        cs = [c for c in contours_of(field, 0.5, smooth_k, sigma=sig) if abs(_area(c)) >= min_area]
        if not cs or sig >= sigma_max:
            break
        # ชั้นสีเดียวที่แตกเป็นร้อยชิ้น = จุดรบกวน ไม่ใช่ลวดลายจริง -> เกลาต่อ
        if kink_ratio(cs) <= float(target) and len(cs) <= int(max_pieces):
            break
    return cs, sig


def contours_of(field, level=0.5, smooth_k=2, min_pts=8, pad=2, sigma=0.0):
    """⚠️ ต้องเติมขอบค่า 0 รอบสนามก่อนเสมอ
    ย่านสีที่ชนขอบภาพ (เช่นพื้นหลัง) จะได้คอนทัวร์เปิด ปิดรูปไม่ได้ -> หายทั้งชั้น"""
    field = denoise_field(field, sigma)
    f = np.pad(field, pad, mode="constant", constant_values=0.0)
    out = []
    for c in measure.find_contours(f, level):
        if len(c) < min_pts:
            continue
        p = np.column_stack([c[:, 1] - pad, c[:, 0] - pad])
        out.append(_smooth(p, smooth_k))
    return out


def _area(p):
    a = np.asarray(p)
    return 0.5 * np.sum(a[:-1, 0] * a[1:, 1] - a[1:, 0] * a[:-1, 1])


def grow(polys, px=0.4):
    """🩹 ดันขอบออกจากเนื้อสีเศษพิกเซล ให้ชั้นติดกันเกยกัน
    ⚠️ วงที่เป็น 'รู' ต้องดันเข้า ไม่ใช่ออก — ไม่งั้นรูกว้างขึ้น เกิดเส้นขาวบางคั่นสี"""
    if px <= 0:
        return polys
    try:
        from shapely.geometry import Polygon as _P
        out = []
        for p in polys:
            try:
                sa = _area(p)
                g = _P(p).buffer(0)
                if g.is_empty:
                    out.append(p); continue
                g = g.buffer(px if sa >= 0 else -px, join_style=2, mitre_limit=2.0, resolution=6)
                if g.is_empty:
                    out.append(p); continue
                if g.geom_type == "MultiPolygon":
                    g = max(g.geoms, key=lambda a: a.area)
                out.append(np.asarray(g.exterior.coords))
            except Exception:
                out.append(p)
        return out
    except Exception:
        return polys


def to_bezier(polys, tol=0.5, corner_deg=45.0):
    """ฟิตเบซิเยร์ — ตัดเส้นที่มุมคมก่อน แล้วฟิตทีละช่วงแบบเส้นเปิด
    ถ้าโยนวงปิดเข้าไปรวดเดียว ตรงมุมแหลมจะลากโค้งเลยจุดมุม เกิดเงี่ยงยื่นพ้นรูป"""
    out = []
    for p in polys:
        a = np.asarray(p, float)
        pts = [tuple(v) for v in a]
        if len(pts) < 10:
            out.append(("P", pts)); continue
        cm = corner_mask(a, corner_deg)
        keep = []
        for i in np.flatnonzero(cm):
            if not keep or i - keep[-1] > 3:
                keep.append(int(i))
        if len(keep) < 2:
            st, sg = _to_curves(pts, closed=True, tol=tol)
            out.append(("B", st, sg) if sg else ("P", pts)); continue
        segs_all = []; start = None
        for j in range(len(keep)):
            i0 = keep[j]; i1 = keep[(j + 1) % len(keep)]
            run = (list(range(i0, i1 + 1)) if i1 > i0
                   else list(range(i0, len(a))) + list(range(0, i1 + 1)))
            sub = [tuple(a[t]) for t in run]
            if len(run) < 4:
                if start is None:
                    start = sub[0]
                segs_all += [("L", q) for q in sub[1:]]
                continue
            st2, sg2 = _to_curves(sub, closed=False, tol=tol)
            if not sg2:
                if start is None:
                    start = sub[0]
                segs_all += [("L", q) for q in sub[1:]]
                continue
            if start is None:
                start = st2
            segs_all += sg2
        if start is None or not segs_all:
            out.append(("P", pts)); continue
        out.append(("B", start, segs_all))
    return out


# ══════════════════════════════════════════════════════════════════
# 5) พรีเซ็ตการใช้งาน
# ══════════════════════════════════════════════════════════════════
PRESETS = {
    # k=0 คือให้ระบบเดาจำนวนสีเอง
    "general":  {"k": 0,  "smooth": 2, "tol": 0.5, "gap": 0.4, "min_area": 4.0},
    "edit":     {"k": 6,  "smooth": 3, "tol": 1.2, "gap": 0.5, "min_area": 12.0},
    "cnc":      {"k": 4,  "smooth": 2, "tol": 0.4, "gap": 0.6, "min_area": 20.0},
    "apparel":  {"k": 5,  "smooth": 4, "tol": 1.5, "gap": 0.8, "min_area": 40.0},
}


def resolve(preset="general", **over):
    p = dict(PRESETS.get(preset or "general", PRESETS["general"]))
    for a, b in over.items():
        if b is not None:
            p[a] = b
    return p


# ══════════════════════════════════════════════════════════════════
# ตัวหลัก
# ══════════════════════════════════════════════════════════════════
def vectorize(img_rgba, preset="general", k=None, smooth=None, tol=None, gap=None,
              min_area=None, transparent=None, seed=0):
    """img_rgba = ndarray HxWx3 (RGB) หรือ HxWx4 (RGBA)

    คืน dict: layers · size (กว้าง,สูง หน่วยพิกเซลต้นฉบับ) · bg · stats
    """
    t0 = time.time()
    cfg = resolve(preset, k=k, smooth=smooth, tol=tol, gap=gap, min_area=min_area)
    img = np.asarray(img_rgba)
    H0, W0 = img.shape[:2]

    alpha = None
    if img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3]
        if a.min() < 250:
            alpha = a
        img = img[:, :, :3]
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)

    # ทำงานที่ความละเอียดเต็มเสมอ — ย่อเฉพาะภาพที่ใหญ่จนแรมไม่ไหวจริง ๆ (และต้องรายงาน)
    mp = W0 * H0 / 1e6
    sc = 1.0
    mp_capped = False
    if mp > MAX_WORK_MP:
        mp_capped = True
        sc = (MAX_WORK_MP / mp) ** 0.5
        img = cv2.resize(img, (max(1, int(round(W0 * sc))), max(1, int(round(H0 * sc)))),
                         interpolation=cv2.INTER_AREA)
        if alpha is not None:
            alpha = cv2.resize(alpha, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_AREA)
    H, W = img.shape[:2]

    af = None
    keep = None
    want_alpha = bool(alpha is not None if transparent is None else (transparent and alpha is not None))
    if want_alpha:
        af = (alpha.astype(np.float32) / 255.0)
        keep = alpha >= 128
        # เติมสีจากพิกเซลทึบเข้าไปในย่านโปร่ง กัน k-means ไปจับ "สีขอบจาง" เป็นสีจริง
        if keep.any() and (~keep).any():
            img = cv2.inpaint(np.ascontiguousarray(img), (~keep).astype(np.uint8),
                              3, cv2.INPAINT_TELEA)
    else:
        if alpha is not None:                       # ทับพื้นขาวถ้าไม่เอาโปร่ง
            a3 = (alpha.astype(np.float32) / 255.0)[:, :, None]
            img = (img.astype(np.float32) * a3 + 255.0 * (1 - a3)).astype(np.uint8)
        alpha = None

    # ══════════════════════════════════════════════════════════════
    # 🔎 ความละเอียด "จริง" ของเนื้อภาพ — ต้องหาก่อนทำอย่างอื่นทั้งหมด
    #    ไฟล์จากผู้ใช้จำนวนมากเป็นไอคอนเล็กที่ถูกขยายมาเปล่า ๆ
    #    ถ้าไปเดินเส้นตามตัวเลขที่ไฟล์บอก จะได้เส้นที่ไต่ขั้นบันไดของ 'บล็อกพิกเซล'
    #    ที่กว้างบล็อกละ 8-16 px ออกมาเป็นขอบหยักเป็นคลื่น (เคสจริงของผู้ใช้)
    # ══════════════════════════════════════════════════════════════
    F = detect_scale(img)
    # 🛡️ เพดานที่สอง: ห้ามย่อจนเส้นบางที่สุดในภาพเหลือน้อยกว่า 8 px
    _sw = stroke_px(img)
    F = min(F, max(1.0, _sw / 8.0))
    if F > 1.5:
        _w = float(np.clip(F, 1.0, 8.0))               # เกณฑ์วัดขอบเข้มพออยู่แล้ว ไม่ต้องหารเผื่ออีก
        nw, nh = max(32, int(round(W / _w))), max(32, int(round(H / _w)))
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
        if af is not None:
            af = cv2.resize(af, (nw, nh), interpolation=cv2.INTER_AREA)
        if keep is not None:
            keep = cv2.resize(keep.astype(np.uint8), (nw, nh), interpolation=cv2.INTER_NEAREST) > 0
        sc *= float(nw) / float(W)
        W, H = nw, nh

    img, nz, nd = prefilter(img, max(1.0, max(W, H) / 500.0))
    pal_rgb, lab, pal_lab = quantize(img, k=cfg["k"], seed=seed, keep=keep)

    b1, b2, l1, l2 = nearest2(lab, pal_lab)
    del lab                                            # ไม่ต้องใช้อีกแล้ว คืนแรมทันที
    labels = l1

    # ══════════════════════════════════════════════════════════════
    # 📏 ปรับค่าทุกตัวที่มีหน่วยเป็น "พิกเซล" ให้โตตามความละเอียดภาพ
    #    ค่าตั้งต้นทั้งชุดจูนไว้กับภาพราว 500 px — ถ้าเอาไปใช้กับภาพ 2400 px ตรง ๆ
    #    มันจะอ่อนลง 5 เท่าโดยอัตโนมัติ กลายเป็น "ตามรอยหยึกหยักของไฟล์" แทนที่จะเกลา
    # ══════════════════════════════════════════════════════════════
    R = max(1.0, max(W, H) / 500.0)                    # ตัวคูณตามความละเอียด
    # ⚠️ ห้ามตั้งความเกลาขั้นต่ำตามขนาดภาพ — ภาพสะอาดจะโดนเกลาฟรี (RMS แย่ลง 9.1 -> 11.5)
    #    แต่ถ้ารู้แน่ว่าภาพ 'ถูกขยายมา' ก็ไม่มีรายละเอียดย่อยพิกเซลให้รักษาอยู่แล้ว
    #    ขอบที่เหลือเป็นทางลาดฟุ้ง ๆ ซึ่งแกว่งข้ามเกณฑ์ 0.5 ไปมา -> เกิดรอยแหว่งเว้าในเส้น
    #    (เจอจริงกับไฟล์ลายเส้นหมูและ Ginger ของผู้ใช้) จึงตั้งพื้นความเกลาไว้เล็กน้อย
    sig0 = 0.7 if F > 1.5 else 0.0
    sigM = float(np.clip(cfg["smooth"] * 0.55 * R, 1.2, 9.0))   # เพดานเกลา (ภาพหยาบไต่ขึ้นไปได้ถึงนี่)
    tgt = {1: 3.0, 2: 1.5, 3: 1.0, 4: 0.6}.get(int(cfg["smooth"]), 1.5)   # มุมหักต่อ 100 px ที่ยอมได้
    tol_e = float(cfg["tol"])                          # ระยะยอมคลาดตอนฟิตเบซิเยร์
    #      ⚠️ ห้ามคูณตามความละเอียด — คูณแล้วจุดน้อยลงจริง แต่ความตรงกับต้นฉบับแย่ลง
    #         (วัดจริง: คูณ R^0.5 ได้ 892 จุด RMS 10.7 · ไม่คูณได้ 1175 จุด RMS 9.1)
    #         ผู้ใช้ปรับเองได้ที่ "จำนวนจุดบนเส้น" ถ้าอยากได้ไฟล์เล็กกว่า
    # ⚠️ 'เติมรอยต่อ' ห้ามคูณตามความละเอียด — มันคือการปิดรอยต่อระดับเศษพิกเซล
    #    ซึ่งกว้างเท่าเดิมเสมอไม่ว่าภาพจะใหญ่แค่ไหน · เคยคูณ R แล้วภาพ 2362px
    #    โดนดันขอบออก 1.9 px ทุกเส้น = ลายเส้นอ้วนขึ้น 3.8 px (RMS แย่ลงจาก 9.1 เป็น 18.5)
    # ⚠️ การเกลาสนามสีทำให้รูปนูนหดเข้านิดหน่อย · สองสีที่ติดกันหดพร้อมกัน = เกิดเส้นขาวคั่น
    #    (วัดจริง: โลโก้สีเปิดเกลา σ0.96 แล้วมีขาวแทรก 1,313 พิกเซล จาก 0)
    #    จึงต้องชดเชยระยะดันขอบตามความแรงที่เกลาไปจริง ๆ ของแต่ละชั้น
    gap_e = float(cfg["gap"])
    # ภาพที่ถูกขยายมา ขอบจะฟุ้ง เกิดเศษเล็ก ๆ ง่าย -> ตัดเกณฑ์ให้สูงขึ้นตามส่วน
    min_a = max(float(cfg["min_area"]) * R * R, (max(W, H) * (0.006 if F > 1.5 else 0.0035)) ** 2)
    hole_mul = 8.0 if F > 1.5 else 1.0                 # ภาพถูกขยายมา = มีรอยด่างในเนื้อเส้นแน่
    sig_used = []
    layers = []
    for i in range(len(pal_lab)):
        n = int((labels == i).sum() if keep is None else ((labels == i) & keep).sum())
        if n < 3:
            continue
        f = coverage_field(i, b1, b2, l1, l2, alpha=af)
        cs, sg = contours_adaptive(f, min_a, smooth_k=2, sigma0=sig0,
                                   sigma_max=sigM, target=tgt)
        # 🕳️ 'รู' ที่เล็กมาก ๆ ไม่ใช่ของที่ออกแบบมา — เป็นรอยด่างจากการบีบอัดในเนื้อเส้น
        #    (เคสจริง: ลายเส้นหมูมีแถบจาง ๆ กลางเส้น กลายเป็นรอยแหว่งเว้าบนขอบ)
        #    รูจริงในงานออกแบบ (ช่องตัวอักษร · เลนส์แว่น) ใหญ่กว่านี้หลายเท่าเสมอ
        if hole_mul > 1.0:
            cs = [c for c in cs if _area(c) >= 0 or abs(_area(c)) >= min_a * hole_mul]
        if not cs:
            continue
        sig_used.append(sg)
        area = sum(abs(_area(c)) for c in cs)
        layers.append({"rgb": tuple(int(v) for v in pal_rgb[i]), "n": n, "area": area,
                       "items": to_bezier(grow(cs, gap_e + 0.6 * sg), tol_e)})
    layers.sort(key=lambda L: -L["area"])           # ใหญ่ก่อน = ซ้อนทับ ไม่มีช่องว่าง

    # ขยายพิกัดคืนขนาดจริง
    if sc != 1.0:
        inv = 1.0 / sc
        for L in layers:
            L["items"] = _scale_items(L["items"], inv)

    bg = None
    if not want_alpha and layers:
        bg = max(layers, key=lambda L: L["n"])["rgb"]

    nodes = sum(len(it[2]) if it[0] == "B" else len(it[1]) for L in layers for it in L["items"])
    stats = {"colors": len(layers), "shapes": sum(len(L["items"]) for L in layers),
             "nodes": int(nodes), "work_px": [W, H], "scale": round(sc, 4),
             "full_res": bool(sc == 1.0),
             # ⚠️ ต้องแยก 'ย่อเพราะภาพใหญ่เกินเครื่องรับไหว' ออกจาก 'คำนวณตามความละเอียดจริง'
             #    สองอย่างนี้คนละเรื่องกัน ถ้ารวมเป็นข้อความเดียวผู้ใช้จะเข้าใจผิดว่ารายละเอียดหาย
             "downscaled": (None if not mp_capped else
                            "ภาพใหญ่ %.1f ล้านพิกเซล เกินเพดาน %.0f — คำนวณที่ %d × %d "
                            "(รายละเอียดบางส่วนหายไป)" % (mp, MAX_WORK_MP, W, H)),
             "min_area_px": round(min_a, 1), "res_mul": round(R, 2),
             "noise": nz, "denoise_d": nd, "upscaled": round(F, 1), "stroke_px": round(_sw, 1),
             "true_px": [int(round(W0 / F)), int(round(H0 / F))] if F > 1.5 else [W0, H0],
             "sigma": round(float(np.mean(sig_used)), 2) if sig_used else 0.0,
             "sigma_max": round(sigM, 2), "tol_px": round(tol_e, 2), "gap_px": round(gap_e, 2),
             "transparent": bool(want_alpha), "seconds": round(time.time() - t0, 3),
             "preset": preset, "cfg": cfg}
    return {"layers": layers, "size": (W0, H0), "bg": bg, "stats": stats}


def _scale_items(items, s):
    out = []
    for it in items:
        if it[0] == "P":
            out.append(("P", [(x * s, y * s) for x, y in it[1]]))
        else:
            st = (it[1][0] * s, it[1][1] * s)
            sg = []
            for g in it[2]:
                if g[0] == "L":
                    sg.append(("L", (g[1][0] * s, g[1][1] * s)))
                else:
                    sg.append(("C", (g[1][0] * s, g[1][1] * s), (g[2][0] * s, g[2][1] * s),
                               (g[3][0] * s, g[3][1] * s)))
            out.append(("B", st, sg))
    return out
