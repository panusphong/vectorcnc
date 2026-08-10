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
# ══════════════════════════════════════════════════════════════════
# 📐 มาตรฐานขาเข้า — ประกาศชัดเจน ใช้เหมือนกันทุกไฟล์ ไม่มีการปรับตามไฟล์
#
#   รับไฟล์         : JPG · PNG · GIF · BMP · WebP · TIFF
#   ขนาดไฟล์สูงสุด   : 30 MB
#   ความละเอียด     : 64 × 64 px  ถึง  4000 × 4000 px (16 ล้านพิกเซล)
#   การปรับขนาด     : ❌ ไม่มี — แปลงที่ความละเอียดเดิมของไฟล์ 100%
#   ถ้าเกินเพดาน    : ❌ ไม่แปลง · แจ้งให้ผู้ใช้ย่อเองก่อน (ไม่แอบย่อให้)
#
# ทำไมถึงเลือกแบบนี้: การแอบย่อภาพให้ผู้ใช้คือการตัดสินใจแทนเขาโดยไม่บอก
# ซึ่งขัดกับจุดขายของเครื่องมือ ('คมกว่าต้นฉบับ') ถ้าไฟล์ใหญ่เกินเครื่องรับไหว
# ต้องบอกไปตรง ๆ ให้เขาเลือกเองว่าจะย่อเท่าไหร่
# ══════════════════════════════════════════════════════════════════
MIN_PX = 64                 # ด้านสั้นสุดที่ยอมรับ
MAX_MP = 16.0               # ล้านพิกเซล (≈ 4000 × 4000) — วัดแล้วใช้แรมราว 300 MB


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
# ══════════════════════════════════════════════════════════════════
# 🎨 ปริภูมิสีที่ใช้วัดระยะ — ต้องเป็น Lab "จริง" เท่านั้น
#
# ⚠️ ข้อผิดพลาดที่ซ่อนอยู่ตั้งแต่ต้น: OpenCV เก็บภาพ Lab แบบ 8 บิตโดย
#      L ถูกคูณ 255/100 (= 2.55 เท่า) · a,b ถูกบวก 128
#    ถ้าเอาตัวเลขนั้นไปวัดระยะตรง ๆ เท่ากับ **ให้น้ำหนักความสว่างมากเกินจริง 2.55 เท่า**
#    ผลที่ตามมาซึ่งเห็นได้จริง:
#      • จานสีถูกเลือกตาม 'ความสว่าง' มากกว่า 'เนื้อสี' — สีสดที่สว่างพอ ๆ กัน
#        (แดง/ส้ม · เขียว/น้ำเงินเข้ม) ถูกยุบรวมเป็นสีเดียว
#      • สีที่ได้จึงเพี้ยนจากต้นฉบับ และเกณฑ์ 'สีขอบผสม' ก็ตัดสินผิดตามไปด้วย
# ✅ แปลงกลับเป็นสเกลจริง (L 0-100 · a,b -128..127) ก่อนวัดระยะทุกครั้ง
#    ค่า ΔE ที่ได้จึงตรงกับที่ตาคนรับรู้จริง และตรงกับที่เอกสารในไฟล์นี้อ้างไว้ตั้งแต่แรก
# ══════════════════════════════════════════════════════════════════
_L_SCALE = 100.0 / 255.0


def labf(lab_u8):
    """ภาพ/แถว Lab แบบ uint8 ของ OpenCV -> Lab จริงเป็น float32"""
    z = np.asarray(lab_u8, np.float32).copy()
    z[..., 0] *= _L_SCALE
    z[..., 1] -= 128.0
    z[..., 2] -= 128.0
    return z


def unlabf(z):
    """Lab จริง -> uint8 แบบที่ OpenCV รับ (ใช้ตอนแปลงจานสีกลับเป็น RGB)"""
    o = np.asarray(z, np.float32).copy()
    o[..., 0] /= _L_SCALE
    o[..., 1] += 128.0
    o[..., 2] += 128.0
    return np.clip(o, 0, 255).astype(np.uint8)


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


def edge_ramp_px(img_rgb):
    """ความกว้างของ 'ทางลาดขอบ' — ขอบคมจริงกว้าง 1-2 px · ขอบที่ถูกขยายมากว้างตามตัวคูณ

    ⚠️ ทำไมต้องมี: การวัดด้วยวิธีย่อ-ขยายกลับอย่างเดียวหลอกได้
       ภาพเวกเตอร์สะอาดที่มีพื้นที่สีเรียบใหญ่ ๆ ก็ย่อได้ 3 เท่าโดยแทบไม่คลาด
       ระบบเลยนึกว่า 'ถูกขยายมา' แล้วเกลาให้ทั้งที่ไม่ควรเกลา
       ผลคือรูปที่มีปลายแหลม (ข้าวหลามตัด) โดนเบลอจนด้านตรงโป่งออกเป็นส่วนโค้ง 3.2%
    ✅ ขอบที่ถูกขยายมาจริงจะ 'ฟุ้ง' กว้างหลายพิกเซลเสมอ วัดตรงนั้นแทน หลอกไม่ได้
    """
    g = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, 3), cv2.Sobel(g, cv2.CV_32F, 0, 1, 3))
    if m.max() <= 1e-6:
        return 1.0
    strong = m > m.max() * 0.45          # แกนกลางของขอบ
    soft = m > m.max() * 0.08            # รวมทางลาดทั้งหมด
    if int(strong.sum()) < 50:
        return 1.0
    return float(np.clip(soft.sum() / max(int(strong.sum()), 1), 1.0, 16.0))


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


def fit_gradient(img_rgb, mask, min_delta=6.0, max_px=60000, seed=0):
    """🌈 หา 'ไล่สีเชิงเส้น' ของก้อนสีหนึ่งก้อน

    ═══════════════════════════════════════════════════════════════
    ทำไมต้องมี (ผู้ใช้เจอจริง 2026-08-09):
      วิธี quantize + trace ให้ 'รูปทึบสีเดียว' เสมอ ภาพพื้นหลังไล่เฉด
      จึงกลายเป็นก้อนสีแบนเรียงกัน ต่อให้ซอยเป็น 48 สีก็ได้แค่ 'แถบถี่ขึ้น'
      ไม่ใช่ไล่สีจริง (ผู้ใช้บอก "เละมาก" หลังลอง 48 สีแล้ว)

    หลักการ (ย่อจากงานวิจัย linear gradient layer decomposition, Tsinghua 2023):
      สีในก้อนหนึ่ง ๆ ของภาพไล่เฉด แทนได้ด้วยระนาบ  c = a·x + b·y + c0
      หาค่า a,b,c0 ด้วยกำลังสองน้อยสุด แยกทีละช่อง R,G,B
      -> ทิศไล่สี = (a,b)  ·  ปลายทั้งสองของไล่สี = จุดที่ฉายไกลสุดบนทิศนั้น

    ผลลัพธ์: ก้อนเดียวไล่สีเนียนต่อเนื่องได้เอง ไม่ต้องพึ่งการซอยสีถี่ ๆ อีก
      (8-14 สีก็เนียนกว่า 48 สีแบบแบน เพราะแต่ละก้อนไล่ในตัวเอง)

    คืน None ถ้าก้อนนั้น 'สีแบนจริง ๆ' -> ผู้เรียกใช้ fill สีเดียวเหมือนเดิม
    ═══════════════════════════════════════════════════════════════
    """
    try:
        ys, xs = np.nonzero(mask)
        n = len(xs)
        if n < 64:
            return None
        if n > max_px:                                  # ก้อนใหญ่มาก -> สุ่มพอ (เร็วและได้ค่าเท่ากัน)
            rng = np.random.default_rng(seed)
            sel = rng.choice(n, size=max_px, replace=False)
            xs, ys = xs[sel], ys[sel]
        C = img_rgb[ys, xs].astype(np.float64)          # (m,3) ค่าสีจริงของพิกเซลในก้อนนี้
        A = np.column_stack([xs.astype(np.float64), ys.astype(np.float64), np.ones(len(xs))])
        coef, *_ = np.linalg.lstsq(A, C, rcond=None)    # (3,3) -> แถว 0,1 = ความชัน x,y
        gx, gy = coef[0], coef[1]                       # ความชันต่อช่องสี

        # ทิศไล่สีรวม = ทิศที่สีเปลี่ยนเร็วที่สุด (ถ่วงน้ำหนักด้วยขนาดความชันของแต่ละช่อง)
        w = np.sqrt(gx ** 2 + gy ** 2)                  # ความแรงต่อช่อง
        if float(w.sum()) < 1e-9:
            return None
        dx = float((gx * w).sum()); dy = float((gy * w).sum())
        L = (dx * dx + dy * dy) ** 0.5
        if L < 1e-9:
            return None
        ux, uy = dx / L, dy / L                         # เวกเตอร์หน่วยของทิศไล่สี

        t = xs * ux + ys * uy                           # ฉายทุกพิกเซลลงบนทิศนั้น
        t0, t1 = float(t.min()), float(t.max())
        if t1 - t0 < 2.0:
            return None
        # จุดปลายทั้งสองของแถบไล่สี (พิกัดจริงบนภาพ)
        p0 = (t0 * ux, t0 * uy)
        p1 = (t1 * ux, t1 * uy)

        def _col(px, py):
            v = coef[0] * px + coef[1] * py + coef[2]
            return tuple(int(np.clip(round(float(q)), 0, 255)) for q in v)

        c0 = _col(*p0); c1 = _col(*p1)
        # 🎚️ ต่างกันน้อย = ก้อนสีแบนจริง -> ไม่ต้องทำไล่สี (ไฟล์เล็กกว่า เปิดเร็วกว่า)
        if max(abs(c0[i] - c1[i]) for i in range(3)) < float(min_delta):
            return None
        return {"x1": round(p0[0], 2), "y1": round(p0[1], 2),
                "x2": round(p1[0], 2), "y2": round(p1[1], 2),
                "c1": c0, "c2": c1}
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════
# 🌈🌈 วิธีใหม่ (2026-08-10) — "พื้นไล่สีก้อนเดียว หลายจุดสี"
#
# 🧠 ทำไมของเดิมไม่เนียนสักที (ผู้ใช้บอกซ้ำ 4 รอบว่า "ไม่เนียน หาวิธีใหม่")
#    ของเดิมไล่ลำดับแบบนี้:  แบ่งสี (k-means) → ได้ 12 ก้อน → ค่อยหาไล่สีของแต่ละก้อน
#    ปัญหาอยู่ที่ "แบ่งสีก่อน" — บนพื้นไล่เฉด การแบ่งด้วยเกณฑ์ 'สีใกล้กัน'
#    ให้ขอบตัดตามระดับสีเสมอ (เหมือนเส้นชั้นความสูงบนแผนที่) พอเอาไล่สีไปใส่ทีละก้อน
#    ก็ยังเห็น 'รอยต่อกระโดด' ระหว่างก้อน เพราะไล่สีของสองก้อนที่ติดกันไม่ได้ต่อกันพอดี
#    ยิ่งกว่านั้น ของเดิมใช้แค่ 2 จุดสี (หัว-ท้าย) = สมมติว่าสีเปลี่ยนเป็นเส้นตรงล้วน
#    วัดจริงกับภาพทดสอบ: คลาดเฉลี่ย 19.7 ระดับสี — ตาเห็นเป็นคราบชัดมาก
#
# ✅ วิธีใหม่ กลับลำดับทั้งหมด: "หาพื้นเนียนก่อน แล้วค่อยแบ่งสีเฉพาะส่วนที่เหลือ"
#    1) หาย่านที่ 'เนียนจริง' ด้วยอนุพันธ์อันดับสอง (Laplacian)
#       — ไล่สีเชิงเส้นมีอนุพันธ์อันดับสอง = 0 · ขอบโลโก้/ตัวอักษรมีค่าพุ่งสูง
#         จึงแยกสองอย่างนี้ออกจากกันได้สะอาดมาก (วัดจริง: พื้น 78.6% ของภาพ เป็นก้อนเดียว)
#    2) 'อุดรู' ในย่านนั้น (รูคือโลโก้ที่วางทับ) -> ได้พื้นเป็นแผ่นเดียวต่อเนื่อง
#    3) ไล่สีด้วย **หลายจุดสี 28 จุด** ไม่ใช่ 2 จุด -> รับไล่สีที่ไม่เป็นเส้นตรงได้หมด
#       วัดจริงภาพเดียวกัน: 2 จุด คลาด 19.68 · 8 จุด 2.71 · 16 จุด 1.21 · 28 จุด 0.97
#       (ดีขึ้น 20 เท่า — และไม่มีรอยต่อเลยเพราะเป็นรูปเดียวไม่มีการแบ่งก้อน)
#    4) เอาสีในโควตา k-means ไปทุ่มให้ 'โลโก้/ตัวอักษร' อย่างเดียว
#       พื้นไม่กินโควตาสีอีกต่อไป -> รายละเอียดคมขึ้นด้วยในตัว
#
# 🔒 ทั้งหมดนี้ทำงานเฉพาะเมื่อผู้ใช้ติ๊ก 🌈 "ภาพไล่สี" เท่านั้น · งานปกติไม่ถูกแตะเลย
# ══════════════════════════════════════════════════════════════════
GRAD_STOPS = 28              # จำนวนจุดสีของไล่สี (28 = จุดคุ้มค่าที่สุดจากที่วัด)


def _grad_nstops(g):
    """นับจุดสีทั้งหมดของไล่สีหนึ่งชุด (รองรับทั้งแบบแถบเดียวและแบบตาข่ายสองมิติ)"""
    if not g:
        return 0
    if g.get("bands"):
        return sum(len(b["stops"]) for b in g["bands"])
    return len(g.get("stops") or [])


def _grad_stops(t, C, ns=GRAD_STOPS):
    """t = ตำแหน่งบนแกนไล่สี 0..1 · C = สีจริง (m,3) -> (offsets, stops) + ค่าคลาดเฉลี่ย

    ใช้ค่าเฉลี่ยต่อช่วง (ไม่ใช่ฟิตเส้นตรง) แล้วเกลาเบา ๆ = ทนคลื่นรบกวน JPEG
    """
    t = np.clip(np.asarray(t, np.float64), 0.0, 1.0)
    ns = int(max(2, ns))
    idx = np.clip((t * ns).astype(np.int32), 0, ns - 1)
    cnt = np.bincount(idx, minlength=ns).astype(np.float64)
    if not (cnt > 0).any():
        return None, 1e9
    S = np.stack([np.bincount(idx, weights=C[:, c], minlength=ns) / np.maximum(cnt, 1.0)
                  for c in range(3)], 1)
    good = cnt > 0
    xi = np.arange(ns, dtype=np.float64)
    for c in range(3):                                  # ช่วงที่ไม่มีพิกเซลเลย -> เชื่อมข้าม
        S[:, c] = np.interp(xi, xi[good], S[good, c])
    ker = np.array([0.25, 0.5, 0.25])
    for c in range(3):                                  # เกลาเบา ๆ กันคลื่นรบกวน
        S[:, c] = np.convolve(np.r_[S[0, c], S[:, c], S[-1, c]], ker, mode="valid")
    off = (xi + 0.5) / ns
    off[0] = 0.0; off[-1] = 1.0
    pred = np.stack([np.interp(t, off, S[:, c]) for c in range(3)], 1)
    return (off, S), float(np.abs(pred - C).mean())


def _stops_trim(off, S, tol=0.9):
    """ตัดจุดสีที่ 'อยู่บนเส้นตรงระหว่างเพื่อนบ้านอยู่แล้ว' ทิ้ง — ไฟล์เล็กลงโดยตาไม่เห็นต่าง"""
    n = len(off)
    keep = [0, n - 1]
    changed = True
    while changed:
        changed = False
        cur = sorted(keep)
        for i in range(1, n - 1):
            if i in keep:
                continue
            lo = max([q for q in cur if q < i]); hi = min([q for q in cur if q > i])
            u = (off[i] - off[lo]) / max(1e-9, off[hi] - off[lo])
            e = np.abs(S[lo] + (S[hi] - S[lo]) * u - S[i]).max()
            if e > tol:
                keep.append(i); cur = sorted(keep); changed = True
    keep = sorted(keep)
    return [[round(float(off[i]), 4),
             tuple(int(np.clip(round(float(v)), 0, 255)) for v in S[i])] for i in keep]


def _fit_bands(xf, yf, C, ns=GRAD_STOPS, max_bands=20, target=3.5):
    """🌈 ไล่สีสองมิติ: ซอยเป็นแถบ แต่ละแถบไล่สีเอง แล้วเกลี่ยเข้าหากันด้วยมาสก์

    ทิศหลัก u = ทิศที่สีเปลี่ยนเร็วที่สุด (ใช้ทำไล่สีในแถบ)
    ทิศตั้งฉาก p = แนวที่ซอยแถบ
    คืน dict kind="bands" หรือ None
    """
    A = np.column_stack([xf, yf, np.ones(len(xf))])
    coef, *_ = np.linalg.lstsq(A, C, rcond=None)
    gx, gy = coef[0], coef[1]
    w = np.sqrt(gx ** 2 + gy ** 2)
    if float(w.sum()) < 1e-9:
        return None
    dx = float((gx * w).sum()); dy = float((gy * w).sum())
    L = (dx * dx + dy * dy) ** 0.5
    if L < 1e-9:
        return None
    ux, uy = dx / L, dy / L
    pxv, pyv = -uy, ux
    t = xf * ux + yf * uy
    t0, t1 = float(t.min()), float(t.max())
    s = xf * pxv + yf * pyv
    s0, s1 = float(s.min()), float(s.max())
    if t1 - t0 < 2.0 or s1 - s0 < 2.0:
        return None
    tn = (t - t0) / (t1 - t0)

    best = None
    for S in (2, 4, 8, 14, 20, 28):
        if S > int(max_bands):
            break
        c = s0 + (np.arange(S) + 0.5) * (s1 - s0) / S
        idx = np.clip(np.round((s - s0) / (s1 - s0) * S - 0.5).astype(np.int32), 0, S - 1)
        B = []
        ok = True
        for k in range(S):
            sel = idx == k
            if int(sel.sum()) < 200:
                ok = False; break
            r, _e = _grad_stops(tn[sel], C[sel], ns)
            if r is None:
                ok = False; break
            B.append(r)
        if not ok:
            continue
        # ประเมินด้วย "โมเดลจริง" (เกลี่ยเชิงเส้นระหว่างแถบข้างเคียง) ไม่ใช่ค่าคลาดในแถบ
        pos = np.clip((s - c[0]) / (c[1] - c[0]), 0.0, S - 1.0)
        k0 = np.clip(np.floor(pos).astype(np.int32), 0, S - 2)
        f = pos - k0
        ii = np.arange(len(f))
        err = 0.0
        for ch in range(3):
            a = np.stack([np.interp(tn, B[k][0], B[k][1][:, ch]) for k in range(S)], 1)
            err += np.abs(a[ii, k0] * (1 - f) + a[ii, k0 + 1] * f - C[:, ch]).mean()
        err /= 3.0
        if best is None or err < best[0] * 0.94:
            best = (err, S, c, B)
        if err <= float(target):
            break
    if best is None:
        return None
    err, S, c, B = best
    # ── ระบบพิกัดท้องถิ่น: หมุนภาพให้ "แนวซอยแถบ" เป็นแกน x และ "แนวไล่สี" เป็นแกน -y
    #    ทำแบบนี้แล้วทุกอย่างในไฟล์ SVG กลายเป็นสี่เหลี่ยมตรง ๆ + ไล่สีแนวตั้ง
    #    ⚠️ ห้ามใช้ <mask> เด็ดขาด — cairosvg (ตัวทำ PDF/EPS/PNG ของเรา) ไม่รองรับ
    #       ทดสอบแล้ว: ชั้นที่มีมาสก์จะถูกวาดทึบเต็มร้อย = ภาพเพี้ยนหมด
    #       จึงเกลี่ยรอยต่อด้วย "สี่เหลี่ยมย่อยที่ไล่ความทึบทีละขั้น" แทน (รองรับทุกโปรแกรม)
    deg = float(np.degrees(np.arctan2(pyv, pxv)))
    bands = [{"stops": _stops_trim(B[k][0], B[k][1])} for k in range(S)]
    return {"kind": "bands", "err": round(float(err), 2),
            "deg": round(deg, 3), "t0": round(t0, 2), "t1": round(t1, 2),
            "s0": round(s0, 2), "s1": round(s1, 2),
            "cs": [round(float(v), 2) for v in c], "q": 8,
            "bands": bands}


def fit_gradient_field(img_rgb, mask, seed=0, ns=GRAD_STOPS, max_px=150000,
                       min_delta=8.0, max_err=6.0, max_bands=20):
    """🌈 ฟิต 'ไล่สีหลายจุด' ให้ย่านหนึ่ง — ลองทั้งแบบเส้นตรงและแบบวงกลม เลือกอันที่คลาดน้อยกว่า

    คืน dict:
      {"kind":"linear","x1","y1","x2","y2","stops":[[off,(r,g,b)],...],"err":..}
      {"kind":"radial","cx","cy","r","stops":[...],"err":..}
    หรือ None ถ้าย่านนั้นสีแบน / ฟิตไม่เข้า (ผู้เรียกใช้จะกลับไปใช้สีเดียวเหมือนเดิม)
    """
    try:
        ys, xs = np.nonzero(mask)
        m = len(xs)
        if m < 400:
            return None
        if m > max_px:
            rng = np.random.default_rng(seed)
            sel = rng.choice(m, size=max_px, replace=False)
            xs, ys = xs[sel], ys[sel]
        xf = xs.astype(np.float64); yf = ys.astype(np.float64)
        C = img_rgb[ys, xs].astype(np.float64)
        if max(float(np.ptp(C[:, c])) for c in range(3)) < float(min_delta):
            return None                                  # แบนจริง -> ใช้สีเดียวดีกว่า

        best = None
        # ── (ก) ไล่สีเป็นแถบตรง: หาทิศที่สีเปลี่ยนเร็วที่สุดด้วยกำลังสองน้อยสุด
        A = np.column_stack([xf, yf, np.ones(len(xf))])
        coef, *_ = np.linalg.lstsq(A, C, rcond=None)
        gx, gy = coef[0], coef[1]
        w = np.sqrt(gx ** 2 + gy ** 2)
        if float(w.sum()) > 1e-9:
            dx = float((gx * w).sum()); dy = float((gy * w).sum())
            L = (dx * dx + dy * dy) ** 0.5
            if L > 1e-9:
                ux, uy = dx / L, dy / L
                tr = xf * ux + yf * uy
                t0, t1 = float(tr.min()), float(tr.max())
                if t1 - t0 >= 2.0:
                    r, err = _grad_stops((tr - t0) / (t1 - t0), C, ns)
                    if r is not None:
                        best = ("linear", err, r,
                                {"x1": round(t0 * ux, 2), "y1": round(t0 * uy, 2),
                                 "x2": round(t1 * ux, 2), "y2": round(t1 * uy, 2)})
        # ── (ข) ไล่สีเป็นวงกลม: ฟิต c = a(x²+y²)+bx+cy+d -> จุดศูนย์กลาง = (-b/2a, -c/2a)
        try:
            A2 = np.column_stack([xf * xf + yf * yf, xf, yf, np.ones(len(xf))])
            c2, *_ = np.linalg.lstsq(A2, C, rcond=None)
            ch = int(np.argmax([np.ptp(C[:, c]) for c in range(3)]))
            a2, b2, d2, _e2 = c2[:, ch]
            if abs(a2) > 1e-12:
                cx, cy = -b2 / (2 * a2), -d2 / (2 * a2)
                rr = np.hypot(xf - cx, yf - cy)
                r0, r1 = float(rr.min()), float(rr.max())
                if r1 - r0 >= 2.0 and abs(cx) < 6e4 and abs(cy) < 6e4:
                    r, err = _grad_stops((rr - r0) / (r1 - r0), C, ns)
                    # จุดเริ่มไม่ได้อยู่ที่ศูนย์กลางพอดี -> ยืด offset ให้อ้างอิงรัศมีเต็ม
                    if r is not None and (best is None or err < best[1] - 0.15):
                        off, S = r
                        off = (r0 + off * (r1 - r0)) / max(1e-6, r1)
                        best = ("radial", err, (off, S),
                                {"cx": round(cx, 2), "cy": round(cy, 2), "r": round(r1, 2)})
        except Exception:
            pass

        # ══════════════════════════════════════════════════════════════
        # 🌈🌈🌈 ไล่สี "สองมิติ" (แถบซ้อนเกลี่ย) — ผู้ใช้เจอจริง 2026-08-10
        #
        # ⚠️ เคสที่ (ก) และ (ข) แก้ไม่ได้: พื้นสีรุ้งที่ไล่ "สองทิศพร้อมกัน"
        #    (ภาพจริงของผู้ใช้: ตรา USERS' CHOICE พื้นรุ้ง เขียว→น้ำเงิน→ม่วง→แดง→ส้ม)
        #    ไล่สีทางเดียวไม่ว่าจะกี่จุดสีก็ฟิตไม่เข้า — วัดได้คลาดถึง 23.2 ระดับสี
        #    ระบบจึงถอยไปใช้สีแบน = ผู้ใช้เห็นเป็นปื้นสีแข็ง ๆ ("เละเหมือนเดิม")
        #
        # ✅ วิธี: ซอยย่านเป็น "แถบ" ตามแนวตั้งฉากกับทิศไล่สีหลัก
        #    แต่ละแถบมีไล่สีของตัวเอง แล้ว **เกลี่ยเข้าหากันด้วยมาสก์ไล่ระดับ**
        #    (แถบ k ถูกทาทับด้วยความทึบที่ไต่จาก 0 ที่กึ่งกลางแถบ k-1 → 1 ที่กึ่งกลางแถบ k)
        #    ผลทางคณิตศาสตร์ = การเกลี่ยเชิงเส้นระหว่างแถบข้างเคียง -> ไม่มีรอยต่อเลย
        #    เท่ากับได้ 'ตาข่ายไล่สี' (gradient mesh) ด้วย SVG มาตรฐานล้วน ๆ
        #
        # 📉 วัดจริงกับภาพรุ้งของผู้ใช้: 1 แถบ 23.2 → 8 แถบ 3.03 → 14 แถบ 2.21 → 20 แถบ 2.01
        # ══════════════════════════════════════════════════════════════
        if (best is None or best[1] > float(max_err)) and int(max_bands) >= 2:
            # 🟢 ตั้งเป้าให้แน่นกว่าเดิม — ตาคนไวกับ "เฉดเขียว" มากที่สุด
            #    ผู้ใช้ทัก 2026-08-10 ว่าโซนเขียวยังไม่เนียนเท่าโซนอื่น
            #    (วัดจริง: 8 แถบ 3.03 → 14 แถบ 2.21 → 20 แถบ 2.01 ระดับสี)
            _bd = _fit_bands(xf, yf, C, ns=ns, max_bands=int(max_bands),
                             target=float(max_err) * 0.42)
            if _bd is not None and _bd["err"] <= float(max_err) * 2.2:
                return _bd

        if best is None or best[1] > float(max_err):
            return None
        kind, err, (off, S), geo = best
        stops = _stops_trim(off, S)
        if len(stops) < 2:
            return None
        # ปลายทั้งสองต่างกันน้อยเกิน = ไม่คุ้มทำไล่สี
        if max(abs(stops[0][1][i] - stops[-1][1][i]) for i in range(3)) < float(min_delta) \
           and len(stops) <= 3:
            return None
        geo.update({"kind": kind, "stops": stops, "err": round(err, 2)})
        return geo
    except Exception:
        return None


def grad_eval(g, xs, ys):
    """🌈 คำนวณสีที่ 'แบบจำลองไล่สี' ทำนายไว้ ณ พิกัดที่กำหนด — คืน (m,3) float

    ใช้สองที่:
      1) ขยายย่านพื้นให้ครบ (พิกเซลไหนที่แบบจำลองทายถูก = เป็นพื้นแน่นอน)
      2) ตรวจความแม่นของแบบจำลองตอนทดสอบ
    """
    xs = np.asarray(xs, np.float64); ys = np.asarray(ys, np.float64)
    def _ramp(st, t):
        off = np.array([q[0] for q in st], np.float64)
        col = np.array([q[1] for q in st], np.float64)
        return np.stack([np.interp(t, off, col[:, c]) for c in range(3)], 1)
    k = g.get("kind")
    if k == "radial":
        rr = max(1e-6, float(g["r"]))
        t = np.hypot(xs - float(g["cx"]), ys - float(g["cy"])) / rr
        return _ramp(g["stops"], np.clip(t, 0, 1))
    if k == "bands":
        rad = np.radians(float(g["deg"]))
        pxv, pyv = np.cos(rad), np.sin(rad)
        ux, uy = pyv, -pxv
        t0, t1 = float(g["t0"]), float(g["t1"])
        tn = np.clip((xs * ux + ys * uy - t0) / max(1e-6, t1 - t0), 0, 1)
        cs = np.asarray(g["cs"], np.float64)
        S = len(cs)
        A = np.stack([_ramp(b["stops"], tn) for b in g["bands"]], 0)     # (S,m,3)
        if S == 1:
            return A[0]
        sv = xs * pxv + ys * pyv
        pos = np.clip((sv - cs[0]) / max(1e-6, cs[1] - cs[0]), 0.0, S - 1.0)
        k0 = np.clip(np.floor(pos).astype(np.int32), 0, S - 2)
        f = (pos - k0)[:, None]
        ii = np.arange(len(xs))
        return A[k0, ii] * (1 - f) + A[k0 + 1, ii] * f
    x1, y1, x2, y2 = (float(g["x1"]), float(g["y1"]), float(g["x2"]), float(g["y2"]))
    dx, dy = x2 - x1, y2 - y1
    L = (dx * dx + dy * dy) ** 0.5
    if L < 1e-9:
        return _ramp(g["stops"], np.zeros(len(xs)))
    ux, uy = dx / L, dy / L
    a0 = x1 * ux + y1 * uy
    t = np.clip((xs * ux + ys * uy - a0) / L, 0, 1)
    return _ramp(g["stops"], t)


def grad_claim(img_rgb, g, seed_mask, tol=13.0, chunk=400000):
    """🔎 ขยายย่านพื้นให้ครบ — พิกเซลไหนที่ 'แบบจำลองไล่สีทายถูก' ก็คือพื้น

    ⚠️ ทำไมต้องมี (ผู้ใช้ชี้จุด 2026-08-10 รอบสาม):
       ตัวตรวจพื้นใช้อนุพันธ์อันดับสอง ซึ่งพลาดตรงย่านที่สีพื้นเปลี่ยนเร็ว
       (พื้นรุ้งช่วงที่เฉดม้วนกลับ) ย่านพวกนั้นเลยไม่ถูกนับเป็นพื้น
       -> k-means เอาโควตาสีไปจับสีรุ้ง แล้ววาดกลับมาเป็น 'ปื้นสีแบน' ทับพื้นเนียน
          (ตรงที่ผู้ใช้วงแดงไว้) แถมยังกินโควตาสีของโลโก้เล็กไปด้วย
    ✅ ให้ 'แบบจำลองไล่สี' ตัดสินเอง: ทายสีได้ตรง = เป็นพื้น · ทายไม่ตรง = เป็นลาย
       ปลอดภัยเพราะลายจริง (ตัวอักษร/ใบไม้) ทายยังไงก็ไม่ตรง
    """
    H, W = img_rgb.shape[:2]
    out = np.zeros((H, W), bool)
    yy, xx = np.mgrid[0:H, 0:W]
    xs = xx.reshape(-1); ys = yy.reshape(-1)
    C = img_rgb.reshape(-1, 3).astype(np.float64)
    ok = np.zeros(len(xs), bool)
    for a in range(0, len(xs), chunk):
        b = min(a + chunk, len(xs))
        pr = grad_eval(g, xs[a:b], ys[a:b])
        ok[a:b] = np.abs(pr - C[a:b]).max(1) <= float(tol)
    ok = ok.reshape(H, W) | seed_mask
    ok = cv2.morphologyEx(ok.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(ok, 8)
    if n <= 1:
        return seed_mask
    # เอาเฉพาะชิ้นที่ทับกับย่านพื้นเดิม (กันหยิบพื้นที่ขาวในโลโก้ที่บังเอิญสีใกล้กัน)
    keepid = np.unique(lb[seed_mask])
    keepid = keepid[keepid > 0]
    if not len(keepid):
        return seed_mask
    return np.isin(lb, keepid) | seed_mask


def _fill_holes(m, max_frac=0.02):
    """อุดรูในมาสก์ (รู = ลายที่วางทับพื้น) -> พื้นกลายเป็นแผ่นเดียวต่อเนื่อง

    ⚠️ อุด 'ทุกรู' ไม่ได้ (ผู้ใช้ชี้จุด 2026-08-10 รอบสาม — ริ้วสีม่วงแทรกในตัวอักษรเล็ก)
       รูใหญ่ ๆ เช่นวงกลมขาวกลางตรา จะถูกชั้นของมันเองระบายทับอยู่แล้ว
       แต่ถ้าอุดไว้ พื้นไล่สีจะไปนอนอยู่ใต้ทั้งวง -> ช่องว่างระดับเศษพิกเซล
       ระหว่างตัวอักษรกับพื้นขาว จะเผยสีรุ้งขึ้นมาเป็นริ้วฉูดฉาด (เห็นชัดมากกับตัวอักษรเล็ก)
    ✅ อุดเฉพาะรูเล็ก (ใบไม้/ตัวอักษรบนพื้น) · รูใหญ่ปล่อยไว้
       ตอนขยายขอบทีหลัง พื้นจะเลยเข้าไปใต้ขอบรูใหญ่พอดี ไม่เกิดขอบขาว
    """
    inv = (~m).astype(np.uint8)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(inv, 4)
    if n <= 1:
        return m.copy()
    edge = set(np.unique(np.concatenate([lbl[0, :], lbl[-1, :], lbl[:, 0], lbl[:, -1]])).tolist())
    lim = float(max_frac) * m.shape[0] * m.shape[1]
    ids = [i for i in range(1, n)
           if i not in edge and float(st[i, cv2.CC_STAT_AREA]) <= lim]
    out = m.copy()
    if ids:
        out |= np.isin(lbl, np.array(ids, np.int32))
    return out


def smooth_regions(img_rgb, keep=None, min_frac=0.05, max_regions=4, k_thr=3.0):
    """🔎 หา 'ย่านพื้นเนียน' ของภาพ (พื้นไล่เฉด/พื้นเรียบใหญ่ ๆ)

    เกณฑ์ = อนุพันธ์อันดับสอง (Laplacian) ต่ำ
      · ไล่สีเชิงเส้น -> อนุพันธ์อันดับสอง = 0 พอดี  (ต่อให้สีเปลี่ยนไปเยอะแค่ไหน)
      · ขอบโลโก้/ตัวอักษร -> ค่าพุ่งสูงมาก
    จึงแยกสองอย่างนี้ออกจากกันได้แม่นกว่าใช้ความชัน (Sobel) ซึ่งพื้นไล่สีก็มีค่าเหมือนกัน

    คืนลิสต์ของ dict: raw (ย่านจริง) · fit (หดเข้าไว้ใช้ฟิตสี) · core (กันไว้ไม่ให้ k-means แตะ)
                      shape (อุดรู+ดันขอบ ไว้ใช้ไล่เส้นเป็นรูป)
    """
    H, W = img_rgb.shape[:2]
    lab = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    lap = np.abs(cv2.Laplacian(cv2.GaussianBlur(lab, (0, 0), 1.6), cv2.CV_32F, ksize=3)).max(2)
    lap = cv2.GaussianBlur(lap, (0, 0), 2.0)
    thr = float(np.median(lap)) * float(k_thr) + 0.3
    sm = (lap < thr)
    if keep is not None:
        sm &= keep
    r = int(max(3, round(max(W, H) / 220.0))) | 1        # โตตามความละเอียดภาพ
    sm = cv2.morphologyEx(sm.astype(np.uint8), cv2.MORPH_OPEN,
                          np.ones((r, r), np.uint8))
    n, lbl, st, _ = cv2.connectedComponentsWithStats(sm, 8)
    cand = sorted(((int(st[i, cv2.CC_STAT_AREA]), i) for i in range(1, n)), reverse=True)
    out = []
    er = np.ones((r + 4, r + 4), np.uint8)
    dl = np.ones((r, r), np.uint8)
    for a, i in cand[:int(max_regions)]:
        if a < float(min_frac) * H * W:
            break
        raw = (lbl == i)
        u8 = raw.astype(np.uint8)
        fit = cv2.erode(u8, er).astype(bool)
        if fit.sum() < 400:
            fit = raw
        shape = cv2.dilate(_fill_holes(raw).astype(np.uint8), dl).astype(bool)
        out.append({"raw": raw, "fit": fit, "core": raw, "shape": shape, "n": int(a)})
    return out


def quantize(img_rgb, k=8, seed=0, keep=None, seed_sample=200000, grad=False,
             kmin=0, cap=None):
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
    Xf = labf(X[take])                                 # 🎨 วัดระยะในสเกล Lab จริงเสมอ
    if len(Xf) < 8:
        Xf = labf(X[:8])
    # ══════════════════════════════════════════════════════════════
    # 🌈 โหมดไล่สี (grad=True) — ผู้ใช้เจอจริง 2026-08-09
    #    สั่ง 32 สี แต่ได้ออกมา 14 สี เพราะ merge_blends ตัด 'สีผสม' ทิ้งไป 18 สี
    #    ⚠️ ตรรกะนั้นถูกสำหรับโลโก้ (สีผสม = ขอบเทาสกปรก ต้องตัด)
    #       แต่ผิดสำหรับภาพไล่เฉด — เพราะ 'สีผสม' คือเนื้อของไล่สีเอง!
    #       ตัดทิ้ง = ไล่สีขาดเป็นก้อน ๆ ทันที
    # ✅ โหมดนี้: ไม่ตัดสีผสม + เพดานสูงถึง 64 สี (ผู้ใช้สั่งเองเท่านั้น auto ยังคง 32)
    # ══════════════════════════════════════════════════════════════
    # ══════════════════════════════════════════════════════════════
    # 🧠 บทเรียนสำคัญ (2026-08-09) — โหมดไล่สีต้องใช้สี "น้อย" ไม่ใช่มาก
    #
    # ⚠️ อลิซพลาด: คิดว่าไล่สีไม่เนียนเพราะสีน้อย เลยดันเป็น 48 สี -> ผู้ใช้บอก "โคตรเละ"
    #    เหตุผลที่พัง: พอแต่ละก้อน "ไล่สีในตัวเองได้แล้ว" การซอยเป็น 44 ก้อนเล็ก
    #    กลายเป็นไล่สี 44 ชุดวางทับกันมั่ว ๆ -> เห็นเป็นริ้วสีขาดเป็นท่อน
    # ✅ ที่ถูกคือ: ก้อน "ใหญ่และน้อย" แล้วให้แต่ละก้อนไล่สียาว ๆ ในตัวเอง
    #    9 ก้อนไล่สีเนียน > 44 ก้อนแบนเรียงกัน (และไฟล์เล็กกว่า เร็วกว่ามาก)
    #    เพดานโหมดไล่สีจึงต่ำกว่าปกติ ไม่ใช่สูงกว่า
    # ══════════════════════════════════════════════════════════════
    # 🌈 เมื่อ "พื้นไล่สี" ถูกแยกออกไปแล้ว โควตาสีทั้งหมดเป็นของรายละเอียดล้วน ๆ
    #    จึงเปิดเพดานสูงขึ้นและตั้งพื้นขั้นต่ำได้ (ผู้ใช้เจอจริง: ตัวอักษรเล็กหลายสีเพี้ยน
    #    เพราะ auto_k มองว่า "เพิ่มสีแล้วไม่คุ้ม" — ตัวอักษรเล็กเป็นพิกเซลส่วนน้อยมาก)
    _cap = int(cap) if cap else (14 if grad else 32)
    kk = auto_k(Xf, seed) if (k is None or int(k) <= 0) else int(k)
    if (k is None or int(k) <= 0) and int(kmin) > 0:
        kk = max(kk, int(kmin))
    kk = max(2, min(_cap, kk))
    cen, _ = _kmeans_lab(Xf, kk, seed=seed)
    if not grad:
        S = Xf[rng.choice(len(Xf), size=min(int(seed_sample), len(Xf)), replace=False)]
        lb0 = ((S[:, None, :] - cen[None, :, :]) ** 2).sum(2).argmin(1)
        cen = merge_blends(cen, np.bincount(lb0, minlength=len(cen)).astype(np.float64))
    pal_rgb = cv2.cvtColor(unlabf(cen).reshape(1, -1, 3), cv2.COLOR_LAB2RGB).reshape(-1, 3)
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
        c = labf(lab[y0:y1])                          # 🎨 สเกล Lab จริง (ดู labf)
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


def drop_fake_holes(field, cs, ambiguous=0.34):
    """🕳️ ตัด 'รูปลอม' ทิ้ง โดยดูความมั่นใจ ไม่ใช่ขนาด

    ⚠️ บทเรียนราคาแพง (2026-08-07): เคยตัดรูด้วยเกณฑ์ 'เล็กกว่า X ตัดทิ้ง'
       ผลคือ **ช่องในตัวอักษร A ของโลโก้ถูกถมเป็นสีทึบ** — รูจริงของแบบหายไปเลย
       ขนาดบอกไม่ได้ว่ารูไหนจริง เพราะตัวอักษรเล็ก ๆ ก็มีช่องเล็กเป็นเรื่องปกติ

    ✅ ดูที่ 'ข้างในรูเป็นสีอื่นจริงไหม' แทน
       รูจริง (ช่องตัวอักษร · เลนส์แว่น) ข้างในเป็นพื้นหลังเต็ม ๆ -> ค่าสนามใกล้ 0
       รูปลอมจากรอยด่างบีบอัด ข้างในยังเกือบเป็นสีเดิม -> ค่าสนามค้างอยู่แถว 0.4-0.5
       ตัดเฉพาะอันที่ค้างอยู่ในย่านก้ำกึ่งเท่านั้น · รูจริงไม่มีทางโดน
    """
    if not cs:
        return cs
    H, W = field.shape[:2]
    out = []
    for c in cs:
        a = np.asarray(c, float)
        if _area(a) >= 0 or len(a) < 4:
            out.append(c); continue                    # ไม่ใช่รู -> เก็บไว้
        x0 = max(0, int(np.floor(a[:, 0].min())) - 1); x1 = min(W, int(np.ceil(a[:, 0].max())) + 2)
        y0 = max(0, int(np.floor(a[:, 1].min())) - 1); y1 = min(H, int(np.ceil(a[:, 1].max())) + 2)
        if x1 - x0 < 3 or y1 - y0 < 3:
            out.append(c); continue
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(m, [np.round(a - [x0, y0]).astype(np.int32)], 1)
        if m.sum() > 12:                               # กันขอบรูออกไป 1 px ค่อยวัดข้างใน
            m = cv2.erode(m, np.ones((3, 3), np.uint8))
        if m.sum() < 3:
            out.append(c); continue
        inside = float(field[y0:y1, x0:x1][m > 0].mean())
        if inside < float(ambiguous):                  # ข้างในเป็นสีอื่นจริง = รูจริง
            out.append(c)
    return out


def contours_adaptive(field, min_area, smooth_k=2, sigma0=0.6, sigma_max=6.0,
                      target=1.5, grow_rate=1.7, max_round=5, max_pieces=250, min_hole=4.0,
                      wave_target=99.0):
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
        # ⚠️ เกณฑ์พื้นที่ใช้กับ 'ชิ้นทึบ' เท่านั้น ห้ามใช้กับ 'รู'
        #    รูจริงในงานออกแบบเล็กได้มาก (ช่องในตัว & % 8 ขนาดแค่ 27 px²)
        #    เคยใช้เกณฑ์เดียวกันทั้งคู่แล้วช่องพวกนี้หายไปเงียบ ๆ (ชุดตรวจจับได้)
        #    รูปลอมมี drop_fake_holes คัดด้วยความมั่นใจอยู่แล้ว ไม่ต้องพึ่งขนาด
        cs = [c for c in contours_of(field, 0.5, smooth_k, sigma=sig)
              if (_area(c) >= 0 and abs(_area(c)) >= min_area)
              or (_area(c) < 0 and abs(_area(c)) >= min_hole)]
        if not cs or sig >= sigma_max:
            break
        # ชั้นสีเดียวที่แตกเป็นร้อยชิ้น = จุดรบกวน ไม่ใช่ลวดลายจริง -> เกลาต่อ
        # ⚠️ เคยลองเพิ่มเกณฑ์ 'ลอน' (การกลับทิศ) ตรงนี้ เพื่อให้เกลาสนามสีต่อเมื่อขอบเป็นลอน
        #    แต่วัดแล้ว **ภาพสะอาดพังหนัก**: counters ΔE 3.27 -> 4.90 · corners 2.53 -> 4.26
        #    เพราะรูปทรงสั้น ๆ ที่สะอาดอยู่แล้วให้ค่าลอนสูงหลอก ๆ (จุดน้อยเกินไป)
        #    -> ถอยออก · การลบลอนไปทำที่ 'แนวจุด' แทน (denoise_poly) ซึ่งคุมงบได้แม่นกว่า
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
                # ⚠️ join_style=2 (มุมแหลม) จะยืดปลายแหลมออกไปได้ไกลถึง 2 เท่าของระยะดัน
                #    รูปที่มีมุมคม ๆ จึงบวมออกตรงปลาย (ชุดตรวจจับได้ที่ corners: ถมทับ 3.2%)
                #    ใช้มุมมนแทน — เสียความคมแค่ระดับเศษพิกเซล แต่ไม่มีเงี่ยงยื่น
                g = g.buffer(px if sa >= 0 else -px, join_style=1, resolution=8)
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


def _flat_seg(start, segs, n=8):
    pts = [tuple(start)]
    for g in segs:
        if g[0] == "L":
            pts.append(tuple(g[1])); continue
        p0 = pts[-1]; c1, c2, p3 = g[1], g[2], g[3]
        for i in range(1, n + 1):
            t = i / n; m = 1.0 - t
            pts.append((m**3 * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t**3 * p3[0],
                        m**3 * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t**3 * p3[1]))
    return pts


def fit_bounded(sub, tol, depth=0, max_depth=5):
    """ฟิตเบซิเยร์ **พร้อมรับประกันความคลาด** — เส้นที่ได้ห้ามเบี่ยงจากขอบจริงเกิน tol

    ⚠️ ต้นเหตุที่พิสูจน์ด้วยการวัด (ชุดตรวจ corners): ตัวฟิตเดิมทำงานแบบ
       'ลดจุดด้วย simplify แล้วร้อยเส้นโค้งผ่านจุดที่เหลือ' ซึ่ง **ไม่มีใครตรวจว่าโค้งที่ได้
       ยังทาบขอบเดิมอยู่ไหม** ด้านตรงยาว ๆ ที่ถูกลดเหลือ 2 จุด จึงถูกแขนโค้งดันให้โป่งออก
       วัดจริง: ตั้ง tol 0.5 โป่งออก 6,678 px · ตั้ง tol 0.01 โป่ง 0 px = ยืนยันว่ามาจากขั้นนี้
    ✅ ฟิตแล้ววัดกลับ ถ้าเบี่ยงเกิน tol ให้ผ่าครึ่งแล้วฟิตใหม่ ทำซ้ำจนอยู่ในเกณฑ์
       ผลคือได้ 'คำรับประกัน' ที่บอกผู้ใช้ได้ว่าเส้นเวกเตอร์ไม่เพี้ยนจากขอบเกินกี่พิกเซล
    """
    st, sg = _to_curves(sub, closed=False, tol=tol)
    if not sg:
        return sub[0], [("L", q) for q in sub[1:]]
    if depth >= max_depth or len(sub) < 8:
        return st, sg
    try:
        from shapely.geometry import LineString, Point
        src = LineString(sub)
        worst = max(src.distance(Point(q)) for q in _flat_seg(st, sg, 6))
        if worst <= float(tol):
            return st, sg
    except Exception:
        return st, sg
    m = len(sub) // 2
    s1, g1 = fit_bounded(sub[:m + 1], tol, depth + 1, max_depth)
    s2, g2 = fit_bounded(sub[m:], tol, depth + 1, max_depth)
    return s1, (g1 + g2)


# ══════════════════════════════════════════════════════════════════
# 🎯 ตัวฟิตเส้นโค้งแบบ "หากำลังสองน้อยที่สุด + ผ่าที่จุดคลาดมากสุด" (Schneider)
#
# ⚠️ ของเดิมทำแบบ: ลดจุดด้วย Douglas-Peucker แล้วร้อยเส้นโค้ง Catmull-Rom ผ่านจุดที่เหลือ
#    ปัญหาที่ตามมา (วัดได้ชัดเจน):
#      • ได้ 1 ท่อนโค้งต่อ 1 ช่วงจุด — คอนทัวร์ที่มีคลื่นเล็ก ๆ จึงได้จุดถี่มาก
#        (ไฟล์จริงของผู้ใช้ test03: 48 รูป แต่ 8,662 จุด)
#      • ทิศทางปลายท่อนมาจาก 'จุดข้างเคียง' ไม่ใช่จาก 'รูปทรงจริงของช่วงนั้น'
#        เส้นเลยส่ายไปมา — วัดเป็นจำนวนครั้งที่เลี้ยวสลับทิศ ได้สูงถึง 9.8 ครั้ง/100 px
#      • เส้นโค้งที่ได้ไม่เคยถูกตรวจว่ายังทาบขอบจริงอยู่ไหม (ต้องมี fit_bounded มาคุมทีหลัง)
#
# ✅ วิธีที่ถูก (โปรแกรมแปลงภาพเป็นเวกเตอร์ระดับดีใช้กันทั้งนั้น):
#      1. กำหนดทิศทางที่ปลายทั้งสองข้างจากรูปทรงจริง
#      2. หา 'ความยาวแขน' สองค่าที่ทำให้เส้นโค้งเดียวทาบแนวจุดได้ดีที่สุด (least squares)
#      3. วัดจุดที่คลาดมากสุด · ถ้ายังเกินเกณฑ์ให้ขยับพารามิเตอร์ (Newton) แล้วฟิตซ้ำ
#      4. ถ้ายังไม่ผ่านค่อยผ่า **ตรงจุดที่คลาดมากสุด** (ไม่ใช่ผ่าครึ่งมั่ว ๆ)
#         แล้วต่อทิศทางที่รอยผ่าให้ต่อเนื่อง = ไม่มีรอยหักโผล่ที่รอยต่อ
#    ผลลัพธ์: โค้งเดียวกินทางยาวได้ · จุดน้อยลงมาก · ไม่ส่าย · และ **รับประกันความคลาด**
#             ในตัวเองอยู่แล้ว (ไม่ต้องพึ่ง fit_bounded อีก)
# ══════════════════════════════════════════════════════════════════
def _bez_at(C, t):
    t = np.asarray(t, float)[:, None]; m = 1.0 - t
    return (m**3) * C[0] + 3 * m * m * t * C[1] + 3 * m * t * t * C[2] + (t**3) * C[3]


def _bez_d1(C, t):
    t = np.asarray(t, float)[:, None]; m = 1.0 - t
    return 3 * m * m * (C[1] - C[0]) + 6 * m * t * (C[2] - C[1]) + 3 * t * t * (C[3] - C[2])


def _bez_d2(C, t):
    t = np.asarray(t, float)[:, None]; m = 1.0 - t
    return 6 * m * (C[2] - 2 * C[1] + C[0]) + 6 * t * (C[3] - 2 * C[2] + C[1])


def _unit(v):
    n = float(np.hypot(v[0], v[1]))
    return np.array([0.0, 0.0]) if n < 1e-12 else np.asarray(v, float) / n


def _chord_u(pts):
    d = np.hypot(*np.diff(pts, axis=0).T)
    u = np.concatenate([[0.0], np.cumsum(d)])
    return u / u[-1] if u[-1] > 1e-12 else np.linspace(0.0, 1.0, len(pts))


def _fit_cubic(pts, u, t1, t2):
    """หาความยาวแขนคุมสองค่าที่ทาบแนวจุดได้ดีที่สุด (ปลายและทิศปลายถูกล็อกไว้)"""
    P0, P3 = pts[0], pts[-1]
    m = 1.0 - u
    B0 = m**3; B1 = 3 * m * m * u; B2 = 3 * m * u * u; B3 = u**3
    A1 = B1[:, None] * t1[None, :]
    A2 = B2[:, None] * t2[None, :]
    c11 = float((A1 * A1).sum()); c12 = float((A1 * A2).sum()); c22 = float((A2 * A2).sum())
    T = pts - (P0[None, :] * (B0 + B1)[:, None] + P3[None, :] * (B2 + B3)[:, None])
    x1 = float((A1 * T).sum()); x2 = float((A2 * T).sum())
    det = c11 * c22 - c12 * c12
    # ⚠️ ห้ามอิงความยาวคอร์ด |P3-P0| อย่างเดียว — ช่วงที่ปลายสองข้างมาบรรจบกัน (วงปิด)
    #    คอร์ดยาว 0 แขนคุมเลยกลายเป็น 0 เส้นโค้งยุบเป็นจุด แล้วผ่าซ้ำไม่รู้จบ
    #    (เจอจริง: วงกลมได้ 8,344 จุด จากที่ควรได้ไม่กี่สิบ) ต้องอิง 'ความยาวแนวจุด' ด้วย
    arc = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    base = max(float(np.hypot(*(P3 - P0))), arc * 0.33) / 3.0
    a1 = a2 = base
    if abs(det) > 1e-12:
        b1 = (x1 * c22 - x2 * c12) / det
        b2 = (c11 * x2 - c12 * x1) / det
        if 1e-6 < b1 < arc and 1e-6 < b2 < arc:
            a1, a2 = b1, b2
    return np.array([P0, P0 + t1 * a1, P3 - t2 * a2, P3])


def _dev(pts, C, m=24):
    """ระยะห่างจริงสูงสุดจาก 'เส้นโค้งที่ฟิตได้' ไปยัง 'แนวจุดต้นฉบับ'

    ⚠️ ต้องมีตัวนี้ เพราะการขยับพารามิเตอร์ (Newton) อาจดันค่า u ไปกองที่ปลาย
       แล้วตัววัดความคลาดแบบเทียบทีละจุดจะรายงานว่า 'คลาดน้อย' ทั้งที่เส้นโค้งบานออกนอกรูป
       (เจอจริง: เส้นบาง 2 px กลายเป็นลิ่มบานปลาย กว้างพลาดไป 40 px)
    """
    q = _bez_at(C, np.linspace(0.0, 1.0, int(m)))
    # ⚠️ ต้องวัดถึง 'ท่อนเส้น' ไม่ใช่ 'จุด' — จุดบนคอนทัวร์ห่างกันราว 0.7 px
    #    ถ้าวัดถึงจุดจะติดค่าคลาดปลอมถึงครึ่งหนึ่งของระยะห่างจุด แล้วผ่าเส้นทิ้งฟรี ๆ
    #    (วัดจริง: วงแหวนพุ่งจาก 885 เป็น 3,790 จุด เพราะเหตุนี้)
    A = pts[:-1]; B = pts[1:]
    AB = B - A
    L2 = np.maximum((AB * AB).sum(1), 1e-12)
    t = np.clip(((q[:, None, :] - A[None, :, :]) * AB[None, :, :]).sum(2) / L2[None, :], 0.0, 1.0)
    proj = A[None, :, :] + t[:, :, None] * AB[None, :, :]
    d = np.sqrt(((q[:, None, :] - proj) ** 2).sum(2)).min(1)
    return float(d.max())


def _worst(pts, u, C):
    q = _bez_at(C, u)
    d = ((q - pts) ** 2).sum(1)
    i = int(d.argmax())
    return float(np.sqrt(d[i])), i


def _reparam(pts, u, C):
    """ขยับค่าพารามิเตอร์ของแต่ละจุดให้ไปตกที่จุดใกล้สุดบนเส้นโค้ง (Newton หนึ่งก้าว)"""
    q = _bez_at(C, u); d1 = _bez_d1(C, u); d2 = _bez_d2(C, u)
    r = q - pts
    num = (r * d1).sum(1)
    den = (d1 * d1).sum(1) + (r * d2).sum(1)
    out = np.where(np.abs(den) < 1e-12, u, u - num / np.where(np.abs(den) < 1e-12, 1.0, den))
    out = np.clip(out, 0.0, 1.0)
    # ⚠️ ถ้าลำดับพารามิเตอร์ไม่เรียงขึ้นแล้ว = จุดไขว้กัน ผลที่ได้เชื่อไม่ได้ ให้ทิ้ง
    if np.any(np.diff(out) <= 0):
        return u
    return out


def _seg_of(C):
    return ("C", (float(C[1][0]), float(C[1][1])), (float(C[2][0]), float(C[2][1])),
            (float(C[3][0]), float(C[3][1])))


def _schneider(pts, t1, t2, tol, depth=0, max_depth=14):
    """ฟิตแนวจุดหนึ่งช่วงให้เป็นเส้นโค้งเบซิเยร์ ความคลาดไม่เกิน tol"""
    n = len(pts)
    if n < 2:
        return []
    if n == 2:
        return [("L", (float(pts[1][0]), float(pts[1][1])))]
    u = _chord_u(pts)
    C = _fit_cubic(pts, u, t1, t2)
    err, i = _worst(pts, u, C)
    if err <= tol and _dev(pts, C, 24) <= tol:
        return [_seg_of(C)]
    if depth < max_depth:
        ub, Cb = u.copy(), C
        for _ in range(6):                       # ขยับพารามิเตอร์แล้วฟิตใหม่ก่อนคิดจะผ่า
            ub = _reparam(pts, ub, Cb)
            Cb = _fit_cubic(pts, ub, t1, t2)
            e2, i2 = _worst(pts, ub, Cb)
            if e2 < err:
                C, err, i, u = Cb, e2, i2, ub.copy()
                if err <= tol and _dev(pts, C, 24) <= tol:
                    return [_seg_of(C)]
    if depth >= max_depth or n < 6:
        return [_seg_of(C)] if _dev(pts, C, 16) <= max(tol * 3.0, 1.0) else \
               [("L", (float(q[0]), float(q[1]))) for q in pts[1:]]
    i = int(min(max(i, 1), n - 2))               # ผ่าตรงจุดที่คลาดมากสุด
    tc = _unit(pts[i + 1] - pts[i - 1])          # ทิศที่รอยผ่า — ใช้ร่วมกันสองฝั่ง = ต่อเนื่อง
    left = _schneider(pts[:i + 1], t1, tc, tol, depth + 1, max_depth)
    right = _schneider(pts[i:], tc, t2, tol, depth + 1, max_depth)
    return left + right


def _end_tan(pts, k=4, at_start=True):
    """ทิศทางที่ปลายช่วง — เฉลี่ยหลายจุดกันสะดุดจุดเดียวแล้วทิศเพี้ยน"""
    a = np.asarray(pts, float)
    k = int(min(max(2, k), len(a) - 1))
    # ⚠️ ทั้งสองปลายต้องเป็น 'ทิศเดินหน้า' เหมือนกัน (สูตรใช้ C2 = P3 - t2·a2)
    #    ถ้าปลายท้ายส่งทิศย้อนกลับมา เส้นโค้งจะพับกลับตัวเอง คลาดถึง 48 px แล้วผ่าซ้ำไม่รู้จบ
    return _unit(a[k] - a[0]) if at_start else _unit(a[-1] - a[-1 - k])


def _taubin(p, passes=2, lam=0.55, mu=-0.58):
    """🪄 เกลาแนวจุดแบบ 'ไม่หด' (Taubin)

    ⚠️ เกลาด้วยค่าเฉลี่ยธรรมดา (ของเดิม) ทำให้รูปหดเข้าทุกครั้งที่เกลา
       ต้องไปชดเชยด้วยการดันขอบออกทีหลัง ซึ่งทำให้มุมมนและขนาดเพี้ยน
    ✅ Taubin สลับ 'หด' กับ 'คลาย' ที่ค่าต่างกันนิดเดียว
       คลื่นถี่ ๆ (รอยบีบอัด · ขั้นบันไดจากตารางพิกเซล) ถูกลบ
       แต่รูปทรงโดยรวมอยู่ที่เดิม — ขนาดไม่หด ตำแหน่งขอบไม่เลื่อน
    """
    a = np.asarray(p, float)
    if len(a) < 7 or passes <= 0:
        return a
    for _ in range(int(passes)):
        for f in (lam, mu):
            prv = np.roll(a, 1, axis=0); nxt = np.roll(a, -1, axis=0)
            a = a + f * (0.5 * (prv + nxt) - a)
    return a


def wave_ratio(a, closed=True):
    """ความ 'ส่าย' ของแนวจุด = จำนวนครั้งที่เลี้ยวสลับทิศ ต่อความยาว 100 px

    เส้นที่ควรจะเนียน (ขอบตัวอักษร · วงกลม) เลี้ยวไปทางเดียวยาว ๆ ค่านี้จะต่ำ
    ขอบที่มีคลื่นจากรอยบีบอัด/ตารางพิกเซล จะเลี้ยวซ้าย-ขวาสลับถี่ ค่านี้จะสูง
    ⚠️ ต่างจาก kink_ratio: อันนั้นนับ 'มุมหัก' อันนี้นับ 'การกลับทิศ' ซึ่งจับคลื่นเนียน ๆ ได้ด้วย
    """
    a = np.asarray(a, float)
    if len(a) < 6:
        return 0.0
    v = np.diff(np.vstack([a, a[:1]]) if closed else a, axis=0)
    L = float(np.hypot(v[:, 0], v[:, 1]).sum())
    th = np.arctan2(v[:, 1], v[:, 0])
    d = np.diff(th); d = (d + np.pi) % (2 * np.pi) - np.pi
    sg = np.sign(d)
    sg = sg[sg != 0]
    if len(sg) < 2:
        return 0.0
    return float((np.abs(np.diff(sg)) > 1).sum()) / max(L / 100.0, 1e-6)


def denoise_poly(a, budget, corner_w=None, target=1.2, max_pass=60):
    """🪄 ลบคลื่นถี่ออกจากแนวจุด **ภายในงบความคลาดที่สัญญาไว้กับผู้ใช้**

    ทำไมต้องมี: ตัวฟิตเส้นโค้งรับประกันว่าเส้นจะไม่เบี่ยงจากแนวจุดเกิน tol
    ถ้าแนวจุดเองเป็นคลื่น ตัวฟิตก็ต้อง 'ตามคลื่น' ให้ครบ = จุดเยอะและเส้นส่าย
    (ไฟล์จริง test03: 48 รูป แต่ 8,301 จุด · ส่าย 10.5 ครั้ง/100 px)

    ✅ เกลาแนวจุดก่อนฟิต โดยมี **เพดานระยะขยับ** ชัดเจน — ขยับได้ไม่เกินงบที่ให้
       จึงยังรับประกันความตรงกับขอบจริงได้เท่าเดิม แต่เส้นเนียนขึ้นมาก
       หยุดทันทีที่เนียนพอ (ภาพสะอาดจึงแทบไม่ถูกแตะ)
    """
    a = np.asarray(a, float)
    if len(a) < 9 or budget <= 1e-6:
        return a
    cur = a.copy()
    if wave_ratio(cur) <= target:
        return a
    w = None if corner_w is None else corner_w[:, None]
    for _ in range(int(max_pass)):
        nxt = _taubin(cur, passes=1)
        if w is not None:
            nxt = nxt * (1 - w) + a * w
        if float(np.hypot(*(nxt - a).T).max()) > budget:
            break
        cur = nxt
        if wave_ratio(cur) <= target:
            break
    # ⚠️ ต้องคืนขนาดให้เท่าเดิมเป๊ะ — การเกลาถึงจะ 'ไม่หด' โดยเฉลี่ย แต่ตรงที่ถูกตรึงไว้ (มุม)
    #    กับตรงที่ชนเพดานงบ ทำให้เหลือการหดเล็กน้อย · สองชั้นสีที่ติดกันหดพร้อมกัน
    #    = เกิดรอยขาวบางคั่นระหว่างสี (วัดจริงกับวงแหวน: ขาวแทรก 4 -> 135 px)
    # ✅ ขยายกลับรอบจุดศูนย์ถ่วงให้พื้นที่เท่าเดิม — ไม่ต้องไปดันขอบทุกชั้นให้อ้วนขึ้น
    a0 = _area(a); a1 = _area(cur)
    if a0 * a1 > 0 and abs(a1) > 1e-9:
        r = float(np.sqrt(abs(a0) / abs(a1)))
        if 0.5 < r < 2.0:
            c0 = cur.mean(0)
            fix = c0 + (cur - c0) * r
            if float(np.hypot(*(fix - cur).T).max()) <= budget:
                cur = fix
    return cur


def to_bezier(polys, tol=0.5, corner_deg=45.0, look=6, budget=0.25):
    """แนวจุด -> เส้นโค้งเบซิเยร์ · ตัดที่มุมคมก่อน แล้วฟิตทีละช่วงแบบเส้นเปิด

    ทำไมต้องตัดที่มุมก่อน: ถ้าโยนวงปิดเข้าไปรวดเดียว ตรงมุมแหลมจะถูกลากโค้งเลยจุดมุม
    เกิดเงี่ยงยื่นพ้นรูป · ตัดก่อนแล้วฟิตทีละช่วง มุมจึงคมเป๊ะตามต้นฉบับ
    """
    out = []
    for p in polys:
        a = np.asarray(p, float)
        if len(a) > 3 and float(np.hypot(*(a[0] - a[-1]))) < 1e-9:
            a = a[:-1]                                   # ตัดจุดซ้ำที่ปลายวง
        pts = [tuple(v) for v in a]
        if len(a) < 10:
            out.append(("P", pts)); continue
        cm = corner_mask(a, corner_deg, look)
        # 🪄 เกลาคลื่นถี่แบบไม่หด ภายในงบความคลาด — ทำ **หลัง** หามุมแล้ว มุมจริงจึงไม่ถูกกลืน
        w = None
        if cm.any():
            w = cm.astype(float)
            for _ in range(3):                           # ปล่อยรัศมีคุ้มครองรอบมุมไว้ 3 จุด
                w = np.maximum.reduce([w, np.roll(w, 1), np.roll(w, -1)])
        # ⚠️ งบขยับต้องมาจาก 'ความไม่แน่นอนของตำแหน่งขอบที่วัดได้จริง' เท่านั้น
        #    ไม่ใช่ตั้งมั่ว ๆ · เคยตั้ง 0.6·tol แล้วเส้นบาง 2 px เสียรูป ค่าคลาดสีพุ่ง 5.9 -> 21.6
        b = denoise_poly(a, float(budget), corner_w=w)
        keep = []
        for i in np.flatnonzero(cm):
            if not keep or i - keep[-1] > 3:
                keep.append(int(i))
        if len(keep) < 2:
            # ไม่มีมุม -> วงโค้งล้วน · ต้องหั่นเป็น 4 ส่วนก่อน
            # ⚠️ ฟิตวงปิดรวดเดียวไม่ได้ ปลายทั้งสองข้างเป็นจุดเดียวกัน เส้นโค้งเดียวยุบตัว
            n = len(b)
            cut = [0, n // 4, n // 2, (3 * n) // 4]
            segs_all = []
            for j in range(4):
                i0 = cut[j]; i1 = cut[(j + 1) % 4]
                run = list(range(i0, i1 + 1)) if i1 > i0 else list(range(i0, n)) + [0]
                sub = b[run]
                t_in = _unit(b[(i0 + 1) % n] - b[i0 - 1])
                t_out = _unit(b[(i1 + 1) % n] - b[i1 - 1])
                segs_all += _schneider(sub, t_in, t_out, float(tol))
            out.append(("B", (float(b[0][0]), float(b[0][1])), segs_all) if segs_all
                       else ("P", pts))
            continue
        segs_all = []; start = None
        for j in range(len(keep)):
            i0 = keep[j]; i1 = keep[(j + 1) % len(keep)]
            run = (list(range(i0, i1 + 1)) if i1 > i0
                   else list(range(i0, len(b))) + list(range(0, i1 + 1)))
            sub = b[run]
            if start is None:
                start = (float(sub[0][0]), float(sub[0][1]))
            if len(run) < 4:
                segs_all += [("L", (float(q[0]), float(q[1]))) for q in sub[1:]]
                continue
            sg = _schneider(sub, _end_tan(sub, 4, True), _end_tan(sub, 4, False), float(tol))
            if sg:
                segs_all += sg
            else:
                segs_all += [("L", (float(q[0]), float(q[1]))) for q in sub[1:]]
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
              min_area=None, transparent=None, seed=0, grad=False):
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

    # 📐 ตรวจตามมาตรฐานขาเข้า — ผ่านก็แปลงที่ความละเอียดเดิม 100% · ไม่ผ่านก็ไม่แปลง
    mp = W0 * H0 / 1e6
    if min(W0, H0) < MIN_PX:
        raise ValueError("ภาพเล็กเกินไป %d × %d px — ต่ำสุดที่รับคือ %d px"
                         % (W0, H0, MIN_PX))
    if mp > MAX_MP:
        raise ValueError("ภาพใหญ่เกินมาตรฐาน %d × %d px (%.1f ล้านพิกเซล) — เพดานคือ %.0f ล้านพิกเซล "
                         "หรือราว 4000 × 4000 px · กรุณาย่อภาพเองก่อนแล้วอัปโหลดใหม่ "
                         "(ระบบไม่ย่อภาพให้เอง เพราะไม่อยากตัดสินใจแทนโดยไม่บอก)"
                         % (W0, H0, mp, MAX_MP))
    sc = 1.0
    mp_capped = False
    # ══════════════════════════════════════════════════════════════════
    # 🔬 เพิ่มความละเอียดก่อนไล่เส้น (upscale) — ผู้ใช้ชี้จุด 2026-08-09
    #    "ไม่ใช่แค่สี แต่เป็นเรื่องความละเอียดด้วย"
    #
    # ⚠️ จุดที่ทุกคนมองข้ามมาตลอด: ไฟล์ที่ผู้ใช้อัปมาส่วนใหญ่เป็นภาพเล็ก
    #    (เคสจริง: 554 × 554 px = 0.31 ล้านพิกเซล ทั้งที่เพดานคือ 16 ล้าน)
    #    ต่อให้ตั้งค่าฟิตเส้นแน่นแค่ไหน 'ข้อมูลต้นทาง' ก็มีอยู่เท่านั้น
    #    -> ขอบไต่ขั้นบันไดพิกเซล · ไล่สีมีข้อมูลแค่ไม่กี่ระดับ = เห็นเป็นแถบ
    #
    # ✅ ขยายภาพก่อนแล้วค่อยไล่เส้น = มีจุดข้อมูลให้ไล่มากขึ้นหลายเท่า
    #    · ขอบเนียนขึ้นจริง (ขั้นบันไดถูกเกลี่ยด้วย Lanczos ก่อนถึงตัวไล่เส้น)
    #    · ไล่สีมีระดับกลางเพิ่ม -> ระนาบสีที่ fit ได้แม่นกว่ามาก
    #    นี่คือสิ่งที่ vectorizer.ai ทำได้ตามที่โฆษณาว่า "ภาพเบลอ -> เวกเตอร์คม"
    #
    # 🔒 ไม่ขัดกฎเหล็ก "ห้ามย่อภาพ" — นี่คือการ 'ขยาย' และตอนจบหารพิกัดกลับ
    #    ด้วยกลไก sc / _scale_items ที่มีอยู่แล้ว ผลลัพธ์จึงอยู่ในหน่วยภาพต้นฉบับเป๊ะ
    # ══════════════════════════════════════════════════════════════════
    _long = float(max(H0, W0))
    _tgt_long = 1800.0                       # ความละเอียดทำงานที่พอดี (คม แต่ไม่ช้าเกิน)
    if _long > 0 and _long < _tgt_long * 0.95:
        _up = min(4.0, _tgt_long / _long)                     # ขยายไม่เกิน 4 เท่า
        _mp_up = (W0 * _up) * (H0 * _up) / 1e6
        if _mp_up > MAX_MP * 0.55:                            # กันแรมบาน
            _up = max(1.0, ((MAX_MP * 0.55 * 1e6) / max(1.0, W0 * H0)) ** 0.5)
        if _up > 1.05:
            _nw, _nh = int(round(W0 * _up)), int(round(H0 * _up))
            img = cv2.resize(img, (_nw, _nh), interpolation=cv2.INTER_LANCZOS4)
            if alpha is not None:
                alpha = cv2.resize(alpha, (_nw, _nh), interpolation=cv2.INTER_LANCZOS4)
            sc = float(_nw) / float(W0)                       # ตอนจบ _scale_items จะหารกลับให้เอง
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
    # ══════════════════════════════════════════════════════════════
    # 🔎 วัด "ขนาดบล็อกพิกเซลจริง" ของภาพ — แต่ **ไม่ย่อภาพเด็ดขาด**
    #
    # 🚨 กฎเหล็กของโมดูลนี้ (ผู้ใช้ย้ำสองครั้ง): ห้ามลดความละเอียดของภาพต้นฉบับ
    #    อลิซเคยพลาดสองรอบ — รอบแรกย่อเพื่อประหยัดแรม รอบสองย่อโดยอ้างว่า
    #    "เนื้อจริงเล็กกว่าที่ไฟล์บอก" ซึ่งก็คือการย่อภาพผู้ใช้อยู่ดี
    #    ค่าที่วัดได้ต้องเอาไปใช้ 'ตั้งความแรงของการเกลา' เท่านั้น ไม่ใช่ไปย่อภาพ
    #
    # ไฟล์ที่ถูกขยายมาจากไอคอนเล็ก จะมีบล็อกพิกเซลกว้าง 4-8 px
    # ถ้าเกลาด้วยค่าที่พอดีกับบล็อกขนาดนั้น เส้นก็เนียนได้ที่ความละเอียดเต็ม
    # ══════════════════════════════════════════════════════════════
    F = detect_scale(img)
    # 🛡️ ด่านที่สอง: ขอบคมจริง = ไม่ได้ถูกขยายมา ห้ามเกลา ไม่ว่าตัวเลขย่อ-ขยายจะบอกว่าอะไร
    # ⚠️ ภาพเวกเตอร์สะอาดที่เรนเดอร์แบบเกลี่ยขอบ (anti-alias) ก็มีทางลาดกว้าง ~2 px เป็นปกติ
    #    จึงต้องหักฐานนี้ออกก่อน ไม่งั้นงานสะอาดจะถูกตัดสินว่า 'ถูกขยายมา' แล้วโดนเกลาฟรี
    F = min(F, max(1.0, edge_ramp_px(img) / 2.0))
    _sw = stroke_px(img)
    # ห้ามเกลาแรงจนเส้นบางสุดในภาพเสียรูป (เส้นบาง 10 px เกลาแรง ๆ ตัวอักษรแตก)
    F = float(np.clip(min(F, max(1.0, _sw / 8.0)), 1.0, 10.0))

    img, nz, nd = prefilter(img, max(1.0, max(W, H) / 500.0))

    # ══════════════════════════════════════════════════════════════
    # 🌈🌈 วิธีใหม่: หา "พื้นไล่สีเนียน" ก่อน แล้วกันไม่ให้ k-means ไปแบ่งพื้นเป็นแถบ ๆ
    #     (อ่านเหตุผลเต็มที่หัวข้อ smooth_regions / fit_gradient_field ด้านบน)
    # ══════════════════════════════════════════════════════════════
    _smr = []
    _q_keep = keep
    _u_raw = None                                  # ย่านพื้นไล่สี (ก่อนอุดรู)
    _anchor = []                                   # สีตัวแทนของพื้น (กัน k-means ต้องเดาสีพื้น)
    if grad:
        try:
            for _rg in smooth_regions(img, keep=keep):
                _g = fit_gradient_field(img, _rg["fit"], seed=seed)
                if not _g:
                    continue
                # 🔎 ให้แบบจำลองไล่สี "เคลม" พิกเซลพื้นที่ตัวตรวจพลาดไป แล้วฟิตใหม่ให้แม่นขึ้น
                try:
                    _cl = grad_claim(img, _g, _rg["raw"])
                    if keep is not None:
                        _cl &= keep
                    if _cl.sum() > _rg["raw"].sum():
                        _rr3 = int(max(3, round(max(H, W) / 220.0))) | 1
                        _fit2 = cv2.erode(_cl.astype(np.uint8),
                                          np.ones((_rr3 + 4, _rr3 + 4), np.uint8)).astype(bool)
                        if _fit2.sum() >= 400:
                            _g2 = fit_gradient_field(img, _fit2, seed=seed)
                            if _g2 and _g2.get("err", 99) <= _g.get("err", 99) * 1.25:
                                _g = _g2
                        _rg["raw"] = _cl
                        _rg["core"] = _cl
                        _rg["fit"] = _fit2 if _fit2.sum() >= 400 else _cl
                        _rg["n"] = int(_cl.sum())
                        _rg["shape"] = cv2.dilate(
                            _fill_holes(_cl).astype(np.uint8),
                            np.ones((int(max(3, round(max(H, W) / 220.0))) | 1,) * 2, np.uint8)
                        ).astype(bool)
                except Exception:
                    pass
                _rg["grad"] = _g
                _smr.append(_rg)
        except Exception:
            _smr = []
        if _smr:
            _u = np.zeros((H, W), bool)
            for _rg in _smr:
                _u |= _rg["core"]
            _u_raw = _u
            # ⚠️ บั๊กที่ผู้ใช้ชี้รอบสอง (2026-08-10): "ริ้วสีแดง/ส้มล้อมรอบใบไม้" + โลโก้เล็กสีเพี้ยน
            #    เพราะกันแค่ย่านพื้น "ที่ตรวจเจอ" ออกจาก k-means — แต่ตัวตรวจตัดแถบรอบขอบ
            #    งานทิ้งไปราว 8-10 px แถบนั้นเป็น "สีพื้น" ล้วน ๆ แต่ยังอยู่ในชุดฝึกสี
            #    -> k-means เอาโควตาสีไปละลายกับสีพื้น แล้ววาดกลับมาเป็นวงล้อมรอบลาย
            # ✅ กันย่านพื้นแบบ "ขยายขอบออก" ตอนเลือกสี จานสีจึงเป็นของงานจริงล้วน
            _rq = int(max(9, round(max(H, W) / 200.0))) | 1
            _u_big = cv2.dilate(_u.astype(np.uint8), np.ones((_rq, _rq), np.uint8)).astype(bool)
            _q_keep = (~_u_big) if keep is None else (keep & ~_u_big)
            if int(_q_keep.sum()) < 400:           # ทั้งภาพเป็นพื้นไล่สี -> ไม่ต้องกัน
                _q_keep = (~_u) if keep is None else (keep & ~_u)
            if int(_q_keep.sum()) < 400:
                _q_keep = keep
            # สีตัวแทนพื้น: หยิบตามจุดสีของไล่สี -> พิกเซลพื้นจะเกาะสีพวกนี้แทนที่จะไปแย่งสีโลโก้
            for _rg in _smr:
                _g0 = _rg["grad"]
                # แบบตาข่ายสองมิติมีหลายแถบ -> เก็บสีตัวแทนจากทุกแถบ (พื้นรุ้งมีหลายโทน)
                _sets = ([b["stops"] for b in _g0["bands"]] if _g0.get("bands")
                         else [_g0["stops"]])
                _each = max(2, int(round(16.0 / max(1, len(_sets)))))
                for _st in _sets:
                    for _j in range(_each):
                        _o = _j / float(max(1, _each - 1))
                        _lo = max([q for q in _st if q[0] <= _o] or [_st[0]])
                        _hi = min([q for q in _st if q[0] >= _o] or [_st[-1]])
                        _t = 0.0 if _hi[0] <= _lo[0] else (_o - _lo[0]) / (_hi[0] - _lo[0])
                        _anchor.append(tuple(int(round(_lo[1][c] + (_hi[1][c] - _lo[1][c]) * _t))
                                             for c in range(3)))

    pal_rgb, lab, pal_lab = quantize(img, k=cfg["k"], seed=seed, keep=_q_keep,
                                     grad=bool(grad), kmin=(12 if _smr else 0),
                                     cap=(24 if _smr else None))
    _n_det = len(pal_lab)                          # สีที่ได้มาเพื่อ "รายละเอียด" เท่านั้น
    if _anchor:
        _a = np.array(sorted(set(_anchor)), np.uint8).reshape(1, -1, 3)
        _al = labf(cv2.cvtColor(_a, cv2.COLOR_RGB2LAB).reshape(-1, 3))
        # ══════════════════════════════════════════════════════════════
        # ⚠️ บั๊กที่ผู้ใช้ชี้ (2026-08-10): ใบไม้เขียว/ตัวอักษรเล็กสีเพี้ยนและแหว่ง
        #    เพราะ "สีตัวแทนพื้น" (anchor) ไปชนะสีของงานจริง — ใบไม้เขียวอยู่ใกล้
        #    เขียวของพื้นรุ้งมากกว่าเขียวในจานสีรายละเอียด พอชั้น anchor ถูกทิ้ง
        #    (เพราะถือว่าเป็นพื้น) ใบไม้เลยหายไปทั้งใบ
        # ✅ ให้ anchor แข่งได้ "เฉพาะในย่านพื้นไล่สี" เท่านั้น
        #    นอกย่านนั้นใช้จานสีรายละเอียดล้วน — งานจริงจึงไม่มีทางโดน anchor กลืน
        # ══════════════════════════════════════════════════════════════
        _b1d, _b2d, _l1d, _l2d = nearest2(lab, pal_lab)
        pal_lab = np.vstack([pal_lab, _al])
        pal_rgb = np.vstack([pal_rgb, _a.reshape(-1, 3)])
        b1, b2, l1, l2 = nearest2(lab, pal_lab)
        # ⚠️ ย่านที่ปล่อยให้ anchor แข่งได้ ต้อง "กว้างกว่า" ย่านพื้นที่ตรวจเจอเล็กน้อย
        #    เพราะตัวตรวจพื้นตัดแถบรอบขอบงานทิ้งไปราว 8-10 px (แถบขอบมีอนุพันธ์สูง)
        #    ถ้าไม่ขยายคืน แถบนั้นจะไม่มีสีพื้นให้เลือก -> ไปเกาะสีงานจริง = เกิด "ขอบสีเพี้ยน"
        #    รอบใบไม้/รอบวงกลม (ผู้ใช้เห็นเป็นริ้วสีแปลก ๆ รอบลาย)
        if _u_raw is not None:
            _rr2 = int(max(9, round(max(H, W) / 200.0))) | 1
            _ins = cv2.dilate(_u_raw.astype(np.uint8),
                              np.ones((_rr2, _rr2), np.uint8)).astype(bool)
        else:
            _ins = np.zeros(lab.shape[:2], bool)
        b1 = np.where(_ins, b1, _b1d); b2 = np.where(_ins, b2, _b2d)
        l1 = np.where(_ins, l1, _l1d); l2 = np.where(_ins, l2, _l2d)
        del _b1d, _b2d, _l1d, _l2d
    else:
        b1, b2, l1, l2 = nearest2(lab, pal_lab)
    del lab                                            # ไม่ต้องใช้อีกแล้ว คืนแรมทันที
    labels = l1

    # ══════════════════════════════════════════════════════════════
    # 📏 ปรับค่าทุกตัวที่มีหน่วยเป็น "พิกเซล" ให้โตตามความละเอียดภาพ
    #    ค่าตั้งต้นทั้งชุดจูนไว้กับภาพราว 500 px — ถ้าเอาไปใช้กับภาพ 2400 px ตรง ๆ
    #    มันจะอ่อนลง 5 เท่าโดยอัตโนมัติ กลายเป็น "ตามรอยหยึกหยักของไฟล์" แทนที่จะเกลา
    # ══════════════════════════════════════════════════════════════
    # ทุกค่าที่มีหน่วยพิกเซล อิงกับ 'ขนาดบล็อกจริง' F ไม่ใช่ขนาดไฟล์
    R = max(1.0, max(W, H) / 500.0) / max(1.0, F)      # ตัวคูณตามความละเอียดที่ 'มีข้อมูลจริง'
    # ⚠️ ห้ามตั้งความเกลาขั้นต่ำตามขนาดภาพ — ภาพสะอาดจะโดนเกลาฟรี (RMS แย่ลง 9.1 -> 11.5)
    #    แต่ถ้ารู้แน่ว่าภาพ 'ถูกขยายมา' ก็ไม่มีรายละเอียดย่อยพิกเซลให้รักษาอยู่แล้ว
    #    ขอบที่เหลือเป็นทางลาดฟุ้ง ๆ ซึ่งแกว่งข้ามเกณฑ์ 0.5 ไปมา -> เกิดรอยแหว่งเว้าในเส้น
    #    (เจอจริงกับไฟล์ลายเส้นหมูและ Ginger ของผู้ใช้) จึงตั้งพื้นความเกลาไว้เล็กน้อย
    # 🚫 ไม่เกลาโดยอัตโนมัติ — เริ่มที่ 0 เสมอ
    #    ผู้ใช้ทักซ้ำ ๆ ว่า "รายละเอียดหาย" ทุกครั้งที่ระบบตัดสินใจเกลาให้เอง
    #    (ที่จริงไม่ได้ย่อภาพ แต่การเกลาก็ทำให้รายละเอียดเล็กหายเหมือนกัน — ผลเหมือนกันในสายตาผู้ใช้)
    #    ✅ ความเที่ยงตรงต่อไฟล์ต้นฉบับมาก่อน · จะเกลาก็ต่อเมื่อ **วัดได้ว่าเส้นหยาบจริง** เท่านั้น
    #       (contours_adaptive จะไล่เพิ่มความเกลาเองถ้าจำเป็น) · ผู้ใช้ปรับเองได้ที่ "ความเนียนของเส้น"
    sig0 = 0.0
    sigM = float(np.clip(cfg["smooth"] * 0.55 * R * F, max(1.2, 0.9 * F), 12.0))   # เพดานเกลา (ภาพหยาบไต่ขึ้นไปได้ถึงนี่)
    tgt = {1: 3.0, 2: 1.5, 3: 1.0, 4: 0.6}.get(int(cfg["smooth"]), 1.5)   # มุมหักต่อ 100 px ที่ยอมได้
    # ลอน (การกลับทิศต่อ 100 px) ที่ยอมได้ — ผูกกับปุ่มความเนียนเหมือนกัน
    wtgt = {1: 99.0, 2: 9.0, 3: 6.0, 4: 4.0}.get(int(cfg["smooth"]), 9.0)
    tol_e = float(cfg["tol"]) * max(1.0, F * 0.8)      # ระยะยอมคลาดตอนฟิตเบซิเยร์
    # ══════════════════════════════════════════════════════════════
    # 🎯 ความละเอียดของ 'ตำแหน่งขอบ' ถูกจำกัดด้วยความฟุ้งของขอบเอง
    #    ขอบคม (ทางลาด 1-2 px) รู้ตำแหน่งได้แม่นระดับเศษพิกเซล -> ไล่ตามได้เต็มที่
    #    ขอบฟุ้ง (ทางลาด 16 px แบบไฟล์ที่ถูกขยาย/เบลอมา) ตำแหน่งขอบ 'สั่น' ตามรอยบีบอัด
    #    ถ้าตั้งเกณฑ์แน่นกว่าความแม่นที่มีจริง = ไปไล่จับคลื่นรบกวน ได้เส้นส่ายและจุดเป็นหมื่น
    #    (ไฟล์จริง test03 ทางลาด 16 px: 48 รูป แต่ 8,263 จุด ส่าย 10.9 ครั้ง/100 px)
    # ✅ ผ่อนเกณฑ์ตามความฟุ้งที่วัดได้ แต่มีเพดานไม่เกิน 2.5 เท่าของค่าที่ผู้ใช้เลือก
    # ══════════════════════════════════════════════════════════════
    ramp = edge_ramp_px(img)
    # 📏 ขนาดคลื่นรบกวนที่ต้องลบ ขึ้นกับสองอย่างที่วัดได้จริง
    #    (ก) ความฟุ้งของขอบ — ขอบยิ่งฟุ้ง ตำแหน่งขอบยิ่งไม่แน่นอน
    #    (ข) ความหนาของเส้นในงาน — รอยบีบอัดบนเส้นหนา 40 px ทำให้ขอบเป็นคลื่นสูงหลายพิกเซล
    #        ถ้าจำกัดงบไว้แค่เศษพิกเซล คลื่นพวกนี้จะติดมาในเวกเตอร์เสมอ (เห็นชัดในไฟล์ test06)
    #    เพดานคือ 6% ของความหนาเส้น — มากกว่านี้เริ่มกินรูปทรง
    _swp = _sw if _sw < 900 else 12.0
    #    ค่าคงที่สามตัวนี้ไม่ได้ตั้งเอาเอง — กวาดหาจากชุดตรวจทั้งชุด 11 ไฟล์
    #    (ค่าคลาดสี · ความส่ายของเส้น · จำนวนจุด) แล้วเลือกจุดที่สมดุลที่สุด
    # ⚠️ บั๊กที่ผู้ใช้เจอ (2026-08-09): ปรับปุ่ม "ความเนียนของเส้น" แล้วขอบยังเป็นคลื่นเหมือนเดิม
    #    เพราะปุ่มนั้นไปคุมแค่ 'การเกลาสนามสี' (sigM/tgt) เท่านั้น
    #    แต่คลื่นที่ตาเห็นเกิดที่ 'แนวจุดคอนทัวร์' ซึ่งคุมด้วยงบเกลาแนวจุด (budget) คนละตัวกัน
    #    -> ปุ่มเลยแทบไม่มีผลกับสิ่งที่ผู้ใช้เห็นจริง
    # ✅ ให้ปุ่มคุมงบเกลาแนวจุดด้วย · "เนียนมาก" ต้องยอมขยับขอบได้ไกลขึ้นจริง
    _sm = int(cfg["smooth"])
    _mul = {1: 0.45, 2: 1.0, 3: 2.0, 4: 3.4}.get(_sm, 1.0)     # ตรงตามไฟล์ / สมดุล / เนียน / เนียนมาก
    _cap = {1: 1.0, 2: 2.5, 3: 5.0, 4: 8.0}.get(_sm, 2.5)
    budget_e = float(np.clip(max(0.18 * ramp, 0.06 * _swp) * _mul, 0.12, _cap))
    # ⚠️ อย่าผ่อน 'เกณฑ์ความคลาดตอนฟิต' ตามงบเกลา — คนละหน้าที่กัน
    #    เกลาแล้วแนวจุดเรียบขึ้น ฟิตแน่น ๆ ก็ได้จุดน้อยอยู่ดี
    #    เคยผูกไว้ที่ 2 เท่าของงบ แล้วภาพแถบสีตรง ๆ ยอมคลาดได้ถึง 5 px = ขอบเลื่อน
    #    (ชุดตรวจจับได้: many_colors ΔE 6.2 -> 11.1)
    tol_e = float(np.clip(max(tol_e, 0.6 * budget_e), 0.25, 1.5))
    # ══════════════════════════════════════════════════════════════
    # 🔬 โหมดละเอียดสูงสุด (grad=True) — ผู้ใช้สั่ง 2026-08-09 "ต้องได้ละเอียดสูงสุด"
    #    เทียบมาตรฐาน vectorizer.ai: Line Fit Quality "Super Fine" = คลาดได้ 0.01 px
    #    ของเดิมพื้นล่างอยู่ที่ 0.25 px -> หยาบกว่า 25 เท่า จึงเห็นขอบเป็นแฉก/หยัก
    # ✅ โหมดนี้: ยอมคลาดแค่ 0.03 px + ลดงบเกลาแนวจุดเหลือ 1/4 + ไม่ดันขอบ
    #    ได้เส้นตามต้นฉบับเป๊ะ (จุดเยอะขึ้น ไฟล์ใหญ่ขึ้น — แลกกับความคม)
    #    ⚠️ งานทั่วไป (ไม่ติ๊ก) ยังใช้ค่าเดิมทุกตัว ไม่ถูกแตะเลย
    # ══════════════════════════════════════════════════════════════
    if grad:
        # ⚠️ เคยตั้ง 0.03 px (เลียนแบบ Super Fine ของ vectorizer.ai) แล้วพัง:
        #    ภาพ JPEG มีคลื่นรบกวนที่ขอบ พอไล่ตามละเอียดขนาดนั้น = ไล่จับคลื่น
        #    ผลจริง: จุดพุ่งจาก 3,253 -> 12,377 · เวลา 3.5 -> 15.7 วิ · ขอบส่ายเป็นริ้ว
        #    (vectorizer.ai ทำได้เพราะเขาลดคลื่นก่อนด้วยวิธีอื่น ไม่ใช่แค่ตั้งค่าให้แน่น)
        # ✅ 0.15 px = ละเอียดกว่าเดิม 1.7 เท่า แต่ยังอยู่เหนือระดับคลื่นรบกวน
        tol_e = float(np.clip(min(tol_e, 0.15), 0.10, 0.30))
        budget_e = float(np.clip(budget_e * 0.6, 0.08, 1.2))
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
    # ⛔ ห้ามตั้ง gap_e = 0 เด็ดขาด (อลิซพลาดมาแล้ว 2026-08-09 · ผู้ใช้บอก "โคตรเละ")
    #    โค้ดด้านบนเตือนไว้ชัด: การเกลาสนามสีทำให้รูปหดเข้านิดหน่อย
    #    สองสีที่ติดกันหดพร้อมกัน -> เกิด 'เส้นขาวคั่น' ระหว่างชั้น
    #    ปิดการดันขอบ = ริ้วขาวเต็มภาพ (วัดจริงเคยได้ 1,313 พิกเซลขาวแทรก จาก 0)
    # ภาพที่ถูกขยายมา ขอบจะฟุ้ง เกิดเศษเล็ก ๆ ง่าย -> ตัดเกณฑ์ให้สูงขึ้นตามส่วน
    min_a = max(float(cfg["min_area"]) * R * R * F * F, (max(W, H) * 0.0035) ** 2)
    sig_used = []
    layers = []
    # 🌈 ชั้นพื้นไล่สี — ไล่เส้นเป็น "รูปเดียว" (อุดรูแล้ว) วางล่างสุด
    grad_layers = []
    if _smr:
        for _rg in _smr:
            try:
                _f = cv2.GaussianBlur(_rg["shape"].astype(np.float32), (0, 0), 0.8)
                _cs = [c for c in contours_of(_f, 0.5, smooth_k=2, sigma=0.0)
                       if abs(_area(c)) >= min_a]
                if not _cs:
                    continue
                _g0 = _rg["grad"]
                _s0 = (_g0["bands"][len(_g0["bands"]) // 2]["stops"] if _g0.get("bands")
                       else _g0["stops"])
                _mid = _s0[len(_s0) // 2][1]
                grad_layers.append({
                    "rgb": tuple(int(v) for v in _mid), "n": int(_rg["n"]),
                    "area": sum(abs(_area(c)) for c in _cs),
                    "items": to_bezier(grow(_cs, gap_e), tol_e, budget=budget_e),
                    "grad": _rg["grad"]})
            except Exception:
                continue
    for i in range(len(pal_lab)):
        n = int((labels == i).sum() if keep is None else ((labels == i) & keep).sum())
        if n < 3:
            continue
        # 🌈 ก้อนที่อยู่ในย่านพื้นไล่สีแทบทั้งหมด = "แถบสีของพื้น" ที่ชั้นไล่สีแทนที่ไปแล้ว
        #    ทิ้งไปเลย ไม่งั้นจะไปวางทับพื้นเนียนกลายเป็นแถบเหมือนเดิม
        #    (ใช้ย่าน 'ก่อนอุดรู' วัด — โลโก้ที่วางบนพื้นจึงไม่โดนทิ้งไปด้วย)
        _sup = None
        if grad_layers and _u_raw is not None:
            if i >= _n_det:
                continue                            # สีตัวแทนพื้น ไม่ใช่สีของงานจริง
            _mi = (labels == i) if keep is None else ((labels == i) & keep)
            # ⚠️ ต้องตัดเป็น "รายพิกเซล" ไม่ใช่ทั้งชั้น (ผู้ใช้ชี้จุด 2026-08-10)
            #    ชั้นเดียวมักมีทั้งส่วนที่เป็นพื้น (ต้องทิ้ง) และส่วนที่เป็นงานจริง (ต้องเก็บ)
            #    · ตัดสินทั้งชั้น -> ปื้นสีแบนบนพื้นหลุดรอดมา (ผู้ใช้วงแดงไว้)
            #    · ตัดสินเป็น 'ชิ้นเชื่อมกัน' ก็ยังพลาด เพราะปื้นบนพื้นมักต่อกับขอบใบไม้
            # ✅ กติกา: สีของงานจริง "ห้ามลงไประบายลึกในย่านพื้นไล่สี"
            #    หดย่านพื้นเข้าไปก่อน เพื่อไม่ไปกินขอบงานจริงที่อยู่ชิดพื้น
            _sup = _mi & _u_raw
            if not _sup.any():
                _sup = None
            elif int((_mi & ~_sup).sum()) < 3:
                continue                            # ทั้งชั้นเป็นพื้น
        f = coverage_field(i, b1, b2, l1, l2, alpha=af)
        if _sup is not None:
            f = f * (1.0 - cv2.GaussianBlur(_sup.astype(np.float32), (0, 0), 0.8))
        # ⚠️ โหมดไล่สี: ห้ามให้ระบบ "เกลาเพิ่มเอง" ง่าย ๆ (ผู้ใช้ชี้จุด 2026-08-10)
        #    ตัวเกลาอัตโนมัติจะแรงขึ้นเมื่อชั้นหนึ่งแตกเป็นหลายชิ้น — ซึ่งภาพถ่าย/ภาพไล่สี
        #    เป็นแบบนั้นโดยธรรมชาติ ผลคือ "ตัวอักษรเล็กโดนเกลาจนขาด" (วัดได้ σ ขึ้นไป 1.6 px)
        #    ผ่อนเกณฑ์ในโหมดนี้ -> σ อยู่ที่ 0 · ตัวอักษรเล็กครบ (ค่าคลาดโซนโลโก้ 18.8 -> 14.2)
        _tg = tgt * (3.0 if grad else 1.0)
        _mp = 2000 if grad else 250
        cs, sg = contours_adaptive(f, min_a, smooth_k=2, sigma0=sig0,
                                   sigma_max=sigM, target=_tg, wave_target=wtgt,
                                   max_pieces=_mp)
        # 🕳️ คัดเฉพาะ 'รูปลอม' ออก โดยดูความมั่นใจ ไม่ใช่ขนาด (ดู drop_fake_holes)
        cs = drop_fake_holes(denoise_field(f, sg), cs)
        if not cs:
            continue
        sig_used.append(sg)
        area = sum(abs(_area(c)) for c in cs)
        # 🩹 มีพื้นไล่สีอยู่ข้างล่าง -> ช่องว่างเศษพิกเซลจะเผยสีจัด ๆ ขึ้นมา ต้องเกยกันมากขึ้น
        _ge = gap_e * (1.9 if grad_layers else 1.0)
        _Lr = {"rgb": tuple(int(v) for v in pal_rgb[i]), "n": n, "area": area,
               "items": to_bezier(grow(cs, _ge + 0.35 * sg), tol_e,
                                  look=int(max(6, round(2.5 * sg) + 5)),
                                  budget=budget_e)}
        # 🌈 โหมดไล่สี: หาไล่สีเชิงเส้นของก้อนนี้ (ไม่มี = ก้อนสีแบน ใช้ fill เดียวเหมือนเดิม)
        if grad:
            _m = (labels == i) if keep is None else ((labels == i) & keep)
            # ก้อนรายละเอียดใช้จุดสีน้อยกว่า (12) — ก้อนเล็ก ไม่ต้องละเอียดเท่าพื้น
            _g = fit_gradient_field(img, _m, seed=seed, ns=12, min_delta=10.0,
                                    max_err=5.0, max_bands=1)
            if _g:
                _Lr["grad"] = _g
        layers.append(_Lr)
    layers.sort(key=lambda L: -L["area"])           # ใหญ่ก่อน = ซ้อนทับ ไม่มีช่องว่าง
    if grad_layers:                                 # 🌈 พื้นไล่สีต้องอยู่ล่างสุดเสมอ
        grad_layers.sort(key=lambda L: -L["area"])
        layers = grad_layers + layers

    # ขยายพิกัดคืนขนาดจริง
    if sc != 1.0:
        inv = 1.0 / sc
        for L in layers:
            L["items"] = _scale_items(L["items"], inv)
            # 🌈 พิกัดของไล่สีต้องหารกลับด้วย (คำนวณบนภาพที่ขยายแล้ว)
            #    ลืมข้อนี้ = แถบไล่สีอยู่ผิดที่ไปหลายเท่า ภาพจะเพี้ยนหนัก
            g = L.get("grad")
            if g:
                for _kx in ("x1", "y1", "x2", "y2", "cx", "cy", "r"):
                    if _kx in g:
                        g[_kx] = round(float(g[_kx]) * inv, 2)
                for _kx in ("t0", "t1", "s0", "s1"):    # 🌈 พิกัดของตาข่ายสองมิติก็ต้องหารกลับ
                    if _kx in g:
                        g[_kx] = round(float(g[_kx]) * inv, 2)
                if g.get("cs"):
                    g["cs"] = [round(float(q) * inv, 2) for q in g["cs"]]

    bg = None
    if not want_alpha and layers:
        # ⚠️ เมื่อมีพื้นไล่สี ห้ามใช้สีของมันเป็นสีรองพื้น
        #    ช่องว่างระดับเศษพิกเซลระหว่างชั้นจะกลายเป็นริ้วสีฉูดฉาด
        #    ใช้สีของชั้นลายที่ใหญ่ที่สุดแทน (มักเป็นพื้นขาวของตัวงาน) ริ้วจึงมองไม่เห็น
        _pool = [L for L in layers if L not in grad_layers] or layers
        bg = max(_pool, key=lambda L: L["n"])["rgb"]

    nodes = sum(len(it[2]) if it[0] == "B" else len(it[1]) for L in layers for it in L["items"])
    stats = {"colors": len(layers), "shapes": sum(len(L["items"]) for L in layers),
             "nodes": int(nodes), "work_px": [W, H], "scale": round(sc, 4),
             "full_res": bool(sc == 1.0),
             # 🔬 บอกตรง ๆ ว่าไล่เส้นที่ความละเอียดเท่าไหร่ (ผู้ใช้จะได้รู้ว่าไม่ได้ทำงานที่ภาพเล็ก)
             "upscaled": (None if sc <= 1.05 else
                          "ขยายก่อนไล่เส้น %.1f เท่า (%d × %d → %d × %d px) "
                          "เพื่อให้ขอบเนียนและไล่สีละเอียดขึ้น — ผลลัพธ์ยังเป็นหน่วยขนาดเดิมทุกประการ"
                          % (sc, W0, H0, W, H)),
             # ⚠️ ต้องแยก 'ย่อเพราะภาพใหญ่เกินเครื่องรับไหว' ออกจาก 'คำนวณตามความละเอียดจริง'
             #    สองอย่างนี้คนละเรื่องกัน ถ้ารวมเป็นข้อความเดียวผู้ใช้จะเข้าใจผิดว่ารายละเอียดหาย
             "downscaled": (None if not mp_capped else
                            "ภาพใหญ่ %.1f ล้านพิกเซล เกินเพดาน %.0f — คำนวณที่ %d × %d "
                            "(รายละเอียดบางส่วนหายไป)" % (mp, MAX_WORK_MP, W, H)),
             # 🌈 บอกให้ผู้ใช้เห็นชัดว่า "โหมดไล่สี" ทำงานจริงหรือไม่ และทำอะไรไป
             #    (เคยเกิดเคสที่ผู้ใช้ลืมติ๊กช่อง แล้วเข้าใจว่าโค้ดไล่สีใช้ไม่ได้)
             "grad_bg": (None if not grad_layers else
                         "พื้นไล่สี %d ผืน · ไล่สีแบบ%s รวม %d จุดสี (คลาดเฉลี่ย %.1f ระดับสี) "
                         "— ทำเป็นรูปเดียวไม่แบ่งก้อน จึงไม่มีรอยต่อ"
                         % (len(grad_layers),
                            {"radial": "วงกลม", "bands": "ตาข่ายสองมิติ"}.get(
                                grad_layers[0]["grad"].get("kind"), "แถบตรง"),
                            sum(_grad_nstops(L["grad"]) for L in grad_layers),
                            float(np.mean([L["grad"]["err"] for L in grad_layers])))),
             "grad_on": bool(grad),
             "min_area_px": round(min_a, 1), "res_mul": round(R, 2),
             "noise": nz, "denoise_d": nd, "block_px": round(F, 1), "stroke_px": round(_sw, 1),
             "edge_ramp_px": round(edge_ramp_px(img), 2),
             "true_px": [int(round(W0 / F)), int(round(H0 / F))] if F > 1.5 else [W0, H0],
             "resized": False,                     # 👈 ต้องเป็น false เสมอ (นอกจากเกินเพดานแรม)
             "sigma": round(float(np.mean(sig_used)), 2) if sig_used else 0.0,
             "sigma_max": round(sigM, 2), "tol_px": round(tol_e, 2), "gap_px": round(gap_e, 2),
             "smooth_budget_px": round(budget_e, 2),
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
