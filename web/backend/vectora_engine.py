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
import os
import time

# ══════════════════════════════════════════════════════════════════
# 🧵 จำกัดจำนวนเธรดให้เท่ากับ "โควตา CPU จริง" — ต้องทำก่อน import numpy/cv2
# ══════════════════════════════════════════════════════════════════
# ⚠️ ต้นเหตุตัวจริงของอาการ "แปลงนานเป็นสิบนาที" (จับได้ 2026-08-13 จาก /api/health):
#    เครื่องจริงรายงาน cpu_seen = 32 · cpu_quota = 2.0
#    -> Python/OpenCV/OpenBLAS มองเห็นคอร์ของ "เครื่องแม่" 32 ตัว แล้วเปิดเธรด 32 เส้น
#       ทั้งที่คอนเทนเนอร์ถูกอนุญาตให้ใช้จริงแค่ 2 คอร์
#    -> 32 เธรดแย่งกันวิ่ง กินโควตา (200 ms ต่อรอบ 100 ms) หมดภายในไม่กี่มิลลิวินาที
#       แล้วระบบ "แช่แข็ง" ทั้งคอนเทนเนอร์ตลอดเวลาที่เหลือของรอบนั้น (cgroup throttling)
#    -> งานที่ควรเสร็จใน 1 นาที กลายเป็น 10 นาที · และมองไม่เห็นเลยถ้าไม่วัด
#    หลักฐานยืนยัน: bench_sec (ลูป Python ล้วน เธรดเดียว ไม่แตะ OpenCV) = 0.053 วิ
#    ซึ่ง **เร็วกว่าเครื่องทดสอบของเรา 2.5 เท่า** -> CPU ไม่ได้ช้า แต่ถูกแช่แข็งเป็นช่วง ๆ
# ✅ ตั้งจำนวนเธรดให้เท่าโควตา -> ไม่มีการแย่งกัน ไม่โดนแช่แข็ง
#    ต้องตั้ง env ก่อน import numpy/cv2 เพราะไลบรารีอ่านค่าตอนโหลดครั้งเดียวเท่านั้น
def _cpu_quota_early():
    for p in ("/sys/fs/cgroup/cpu.max",):
        try:
            with open(p) as f:
                q, per = f.read().split()
            if q != "max":
                return max(1, int(float(q) / float(per)))
        except Exception:
            pass
    try:
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as f:
            q = float(f.read().strip())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as f:
            per = float(f.read().strip())
        if q > 0 and per > 0:
            return max(1, int(q / per))
    except Exception:
        pass
    return max(1, int(os.cpu_count() or 2))


_NTHREADS = _cpu_quota_early()
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS",
           # 🦀 RAYON_NUM_THREADS = ตัวที่ **สำคัญที่สุด** สำหรับงานนี้
           #    VTracer เขียนด้วย Rust ใช้ไลบรารี rayon ซึ่งเปิดเธรดตามคอร์ที่ "มองเห็น"
           #    (ตรวจแล้วว่าไบนารีของ vtracer อ่านตัวแปรนี้จริง) — รอบก่อนอลิซตั้งแต่
           #    ของ OpenCV/OpenBLAS จึงยังค้างที่ขั้นไล่เส้นเหมือนเดิม เพราะคนละไลบรารีกัน
           "RAYON_NUM_THREADS"):
    os.environ.setdefault(_v, str(_NTHREADS))

import cv2
import numpy as np
from skimage import measure

try:
    cv2.setNumThreads(_NTHREADS)          # ตัวนี้ตั้งหลัง import ได้ (ไม่ใช่ env)
except Exception:
    pass

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


def mem_limit_mb():
    """🧠 แรมที่เครื่องนี้ 'มีจริง' กี่ MB — อ่านจากโควตาของคอนเทนเนอร์ ไม่ใช่ของเครื่องแม่

    ⚠️ ทำไมต้องมี (2026-08-13): ผู้ใช้เจอ "แปลงไม่สำเร็จ" ซ้ำ ๆ ที่ราว 50-62 วินาที
       ซึ่งตรงกับจังหวะที่แรมพุ่งสูงสุดพอดี (หลังไล่เส้น ก่อนให้คะแนน ~75%)
       และรอบล่าสุดขึ้นว่า "ไม่พบงานนี้" = ตารางงานในแรมหายไปทั้งตาราง
       -> แปลว่า **โปรเซสถูกฆ่าแล้วเกิดใหม่** ไม่ใช่การเชื่อมต่อถูกตัด
       เราวัดได้ว่างานคุณภาพสูงใช้แรมสูงสุดราว 550-750 MB
       ถ้าเครื่องจริงมี 512 MB (เช่นแพลนถูกลดกลับเป็น free โดยการ sync blueprint
       — render.yaml เตือนเรื่องนี้ไว้เองด้วย) ก็ถูกฆ่าตรงจุดนั้นทุกครั้ง
    ✅ จึงต้องไม่เดาว่าเครื่องมีแรมเท่าไหร่ — อ่านค่าจริงแล้วปรับคุณภาพให้พอดีเครื่อง
       เครื่องใหญ่ได้คุณภาพเต็ม · เครื่องเล็กได้งานที่ 'เสร็จจริง' ดีกว่าถูกฆ่ากลางคัน
    """
    for p in ("/sys/fs/cgroup/memory.max",                       # cgroup v2
              "/sys/fs/cgroup/memory/memory.limit_in_bytes"):     # cgroup v1
        try:
            with open(p) as f:
                v = f.read().strip()
            if v and v != "max":
                n = int(v) / 1048576.0
                if 64 <= n <= 262144:                # ค่าบ้า ๆ (ไม่จำกัด) ข้ามไป
                    return n
        except Exception:
            pass
    try:                                             # ไม่มี cgroup -> ใช้แรมเครื่อง
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1048576.0
    except Exception:
        return 2048.0                                # เดาแบบระมัดระวัง


def cpu_quota():
    """⚙️ "แรงม้า CPU ที่ใช้ได้จริง" กี่คอร์ — ไม่ใช่จำนวนคอร์ที่มองเห็น

    ⚠️ บทเรียน 2026-08-13: เครื่องทดสอบกับเครื่องจริงเห็น CPU 2 ตัวเท่ากัน
       แต่เครื่องจริงช้ากว่า 4-10 เท่า · สาเหตุที่เป็นไปได้มากสุดคือ "โควตา CPU"
       (cgroup cpu.max) — เห็น 2 คอร์ แต่ถูกอนุญาตให้ใช้จริงแค่เศษเสี้ยว
       พอใช้เกินโควตาในแต่ละรอบ ระบบจะ "แช่แข็ง" โปรเซสไว้จนหมดรอบ
       ซึ่งทำให้งานคำนวณยาว ๆ ช้าลงแบบทวีคูณ และมองไม่เห็นเลยถ้าไม่วัด
    ✅ อ่านค่าจริงออกมา แล้วเอาไปเลือกคุณภาพ + โชว์ที่ /api/health ให้ตรวจได้
    """
    try:                                             # cgroup v2: "<quota> <period>"
        with open("/sys/fs/cgroup/cpu.max") as f:
            q, p = f.read().split()
        if q != "max":
            return max(0.1, float(q) / float(p))
    except Exception:
        pass
    try:                                             # cgroup v1
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as f:
            q = float(f.read().strip())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as f:
            p = float(f.read().strip())
        if q > 0 and p > 0:
            return max(0.1, q / p)
    except Exception:
        pass
    try:
        return float(os.cpu_count() or 2)
    except Exception:
        return 2.0


def quality_for_mem(mb=None):
    """เลือก 'ความละเอียดภาพทำงาน / ความละเอียดไล่เส้น' ให้พอดีกับแรมที่มีจริง

    ตัวเลขมาจากการวัดจริงกับไฟล์ 554px ของพี่ (แรมสูงสุดตลอดงาน):
      1800px + ไล่เส้น 3200  ->  ~551 MB · 156,269 จุด · ทั้งภาพ 2.54
      2216px + ไล่เส้น 4000  ->  ~750 MB · 208,230 จุด · ทั้งภาพ 2.48   (คมสุด)
    เผื่อที่ว่างให้ระบบอีกราว 25% เสมอ

    ⏱️ ต้องดู "จำนวน CPU" ด้วย ไม่ใช่แรมอย่างเดียว (บทเรียน 2026-08-13):
       เครื่องผู้ใช้เป็น Pro **4 GB แต่ 2 CPU** พอเลือกคุณภาพจากแรมอย่างเดียวเลยได้
       ชุดสูงสุด แล้วงานไปกินเวลาเป็นสิบนาที — ขั้นไล่เส้นของ VTracer เป็นงานเธรดเดียว
       เวลาแปรตามจำนวนพิกเซลตรง ๆ (4000px = 16 ล้านพิกเซล · 3200px = 10.2 ล้าน)
       แรมพอไม่ได้แปลว่าเครื่องเร็วพอ
    """
    mb = float(mem_limit_mb() if mb is None else mb)
    cpu = cpu_quota()                    # แรงม้าที่ใช้ได้จริง ไม่ใช่จำนวนคอร์ที่เห็น
    if cpu < 1.5:
        # 🐌 โควตา CPU น้อยกว่า 1.5 คอร์ — งานคุณภาพสูงจะกินเวลาหลายนาที
        #    ยอมลดความละเอียดลงเพื่อให้ "ใช้งานได้จริง" (พี่สั่ง: อย่าให้นานไป)
        return (1400.0, 2400) if mb >= 1400 else (1200.0, 2000)
    if mb >= 2800 and cpu >= 4:
        return 2400.0, 4000          # เครื่องใหญ่และเร็ว — คุณภาพเต็ม
    if mb >= 2800:
        # แรมเยอะแต่ CPU น้อย (Pro 4 GB / 2 CPU — เครื่องของพี่)
        # ⏱️ วัดจริงบนเครื่อง 2 CPU (เวลาแปลงล้วน ไม่รวมทำไฟล์):
        #    ภาพทำงาน 2216px + ไล่เส้น 3200 -> 71 วิ · ทั้งภาพ 2.51
        #    ภาพทำงาน 1800px + ไล่เส้น 3200 -> 52 วิ · ทั้งภาพ 2.54   ← เลือกอันนี้
        #    เร็วขึ้น 27% แลกกับค่าคลาด 0.03 ซึ่งตาแทบไม่เห็น (พี่สั่ง "อย่าให้นานไป")
        #    ตัวที่กินเวลาคือ "ภาพทำงาน" ไม่ใช่ VTracer — ขั้นแปลงหลัก 52.6 -> 38 วิ
        return 1800.0, 3200
    if mb >= 1400:
        return 1800.0, 3200          # กลาง (Standard 2 GB)
    if mb >= 900:
        return 1500.0, 2600          # เล็ก
    return 1200.0, 2000              # จิ๋ว (free 512 MB) — ขอให้ 'เสร็จจริง' ไว้ก่อน


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
GRAD_STOPS = 96              # จำนวนจุดสีของไล่สี
# 📏 วัดจริงกับพื้นรุ้งของผู้ใช้ (2026-08-10): จำนวน "จุดสีต่อแถบ" คือตัวชี้ขาดความเนียน
#    ไม่ใช่จำนวนแถบ — 28 จุด คลาด 3.40 · 48 จุด 1.94 · 64 จุด 1.61 · 96 จุด 1.40
#    ผู้ใช้เห็น 28 จุดเป็น "คลื่น" ในพื้นไล่สี · 64 จุดคือจุดคุ้มค่าที่สุด (คลาดลดครึ่ง ไฟล์โต 2 เท่า)


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
    # ⚡ ค้นหาจำนวนแถบที่พอดีใช้ตัวอย่างย่อยพอ — ผลเท่ากันแต่เร็วกว่าหลายเท่า
    #    (เคยใช้ครบ 150,000 จุด แล้วเวลาพุ่งจาก 27 เป็น 64 วินาที)
    if len(xf) > 50000:
        _sel = np.linspace(0, len(xf) - 1, 50000).astype(np.int64)
        xf, yf, C = xf[_sel], yf[_sel], C[_sel]
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
    #
    # ⚠️ บทเรียนสำคัญ (ผู้ใช้เจอจริง 2026-08-10): ห้ามเกลี่ยรอยต่อด้วย "ความโปร่งใส"
    #    ครั้งแรกอลิซใช้ <mask> -> cairosvg ไม่รองรับ ไฟล์ PDF เพี้ยนทั้งใบ
    #    ครั้งที่สองใช้สี่เหลี่ยมโปร่งซ้อนกัน -> เกิด "เส้นริ้ว" ทั้งภาพ
    #      เพราะขอบของรูปสองชิ้นที่ชนกันพอดี ตัวเรนเดอร์เกลี่ยขอบให้ทั้งคู่ (ชิ้นละ ~50%)
    #      รวมกันได้แค่ ~75% ไม่ใช่ 100% -> เห็นเป็นเส้นบางคั่นทุกรอยต่อ (160 เส้น!)
    # ✅ วิธีที่ถูก: ซอยถี่ ๆ ไปเลย แล้วให้ **แต่ละแถบทึบ 100%** พร้อมไล่สีที่
    #    "ผสมไว้ล่วงหน้า" ระหว่างแถบข้างเคียง · ทับกันเล็กน้อยได้โดยไม่มีผลข้างเคียง
    #    (ทึบทับทึบ = ไม่มีอะไรเปลี่ยน) รอยต่อจึงหายสนิท และยังเกลี่ยเนียนเหมือนเดิม
    deg = float(np.degrees(np.arctan2(pyv, pxv)))
    off0 = B[0][0]
    # ⚠️ ผู้ใช้ยังเห็น "คลื่นเป็นเส้น" (2026-08-10 รอบสี่)
    #    เพราะแถบที่วาดจริงมีสีคงที่ทั้งแถบในแนว s -> ขอบแถบเป็นขั้นเล็ก ๆ
    #    ตาคนจับขั้นสีระดับ 1-2 หน่วยบนพื้นเรียบได้ (Mach band) จึงเห็นเป็นเส้น
    # ✅ คำนวณจำนวนแถบจาก "ขั้นสีที่ยอมได้" (0.5 หน่วย) ไม่ใช่ตั้งตายตัว
    _dmax = 0.0
    for _q in range(S - 1):
        _dmax = max(_dmax, float(np.abs(B[_q + 1][1] - B[_q][1]).max()))
    NS = int(np.clip(round(1 + (S - 1) * _dmax / 0.8), 24, 180)) if S > 1 else 1
    bands = []
    for j in range(NS):
        a = s0 + (s1 - s0) * j / NS
        b = s0 + (s1 - s0) * (j + 1) / NS
        mid = (a + b) * 0.5
        pos = float(np.clip((mid - c[0]) / max(1e-6, c[1] - c[0]), 0.0, S - 1.0)) if S > 1 else 0.0
        k0 = int(np.clip(np.floor(pos), 0, max(0, S - 2)))
        f = pos - k0
        M = B[k0][1] if S == 1 else (B[k0][1] * (1 - f) + B[k0 + 1][1] * f)
        bands.append({"s0": round(a, 2), "s1": round(b, 2),
                      "stops": _stops_trim(off0, M, tol=2.2)})
    return {"kind": "bands", "err": round(float(err), 2),
            "deg": round(deg, 3), "t0": round(t0, 2), "t1": round(t1, 2),
            "s0": round(s0, 2), "s1": round(s1, 2),
            "bands": bands}


def fit_gradient_field(img_rgb, mask, seed=0, ns=GRAD_STOPS, max_px=150000,
                       min_delta=8.0, max_err=6.0, max_bands=28):
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
                             target=float(max_err) * 0.15)
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
        bs = g["bands"]
        S = len(bs)
        if S == 1:
            return _ramp(bs[0]["stops"], tn)
        # ⚡ ห้ามกาง (จำนวนแถบ × จำนวนพิกเซล × 3) เป็นก้อนเดียว
        #    84 แถบ × 400,000 พิกเซล = 800 MB ต่อรอบ และช้ากว่า 2 เท่า (เจอจริง 2026-08-10)
        #    คิดทีละแถบเฉพาะพิกเซลของแถบนั้นพอ -> งานรวมเท่ากับจำนวนพิกเซลเฉย ๆ
        # ⚠️ ต้องคิดแบบเดียวกับที่ "วาดออกมาจริง" เป๊ะ ๆ: แต่ละแถบใช้ไล่สีของตัวเองเต็มช่วง
        #    (เคยเขียนเป็นการเกลี่ยระหว่างศูนย์กลางแถบ -> ค่าคลาดจากของจริงถึง 8 หน่วย
        #     ทำให้ขั้นตอน "ขยายย่านพื้น" ตัดสินผิด)
        a0 = float(bs[0]["s0"]); a1 = float(bs[-1]["s1"])
        sv = xs * pxv + ys * pyv
        k0 = np.clip(((sv - a0) / max(1e-6, (a1 - a0)) * S).astype(np.int32), 0, S - 1)
        out = np.zeros((len(xs), 3), np.float64)
        for k in range(S):
            sel = (k0 == k)
            if not sel.any():
                continue
            out[sel] = _ramp(bs[k]["stops"], tn[sel])
        return out
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


def detail_weight(img_rgb, skip=None):
    """🎯 "พิกเซลไหนสำคัญต่อสายตา" — ใช้ถ่วงน้ำหนักตอนแบ่งโควตาสี

    ⚠️ ต้นเหตุที่เครื่องแปลงของเราเองสีเพี้ยน (ผู้ใช้ทักซ้ำหลายรอบ: โลโก้ไม่ชัด):
       k-means แบ่งสีตาม "จำนวนพิกเซล" ล้วน ๆ · โลโก้ LINEMAN wongnai กว้างไม่กี่ร้อย
       พิกเซลจากภาพ 5 ล้านพิกเซล = 0.01% -> ไม่มีทางได้สีเป็นของตัวเองเลย
       สีทั้งโควตาถูกพื้นกว้าง ๆ กับใบไม้กินไปหมด (วัดจริง: โลโก้ ΔE 11.78)
    ⚠️ ที่เคยลองแล้วไม่ได้ผล: "เพิ่มโควตาสี" 12→20 · โลโก้แย่ลงอีก (11.78 -> 13.22)
       เพราะสีที่เพิ่มก็ถูกแบ่งตามจำนวนพิกเซลอยู่ดี = ไปตกที่พื้นกว้างเหมือนเดิม
    ✅ ต้องแก้ที่ "เกณฑ์การแบ่ง" ไม่ใช่ "จำนวนที่แบ่ง" — ให้พิกเซลที่อยู่ในย่าน
       รายละเอียดสูง (ตัวอักษร ขอบโลโก้) มีน้ำหนักมากกว่าพิกเซลกลางพื้นเรียบ
       แล้ว k-means จะวางสีลงตรงนั้นเอง โดยไม่ต้องเพิ่มโควตาสักสีเดียว

    คืนอาร์เรย์น้ำหนัก (float32) ขนาดเท่าภาพ · skip = ย่านที่ไม่ต้องสน (พื้นไล่สี)
    """
    g = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    # ความ "จอแจ" ของพื้นที่ = ส่วนเบี่ยงเบนมาตรฐานในหน้าต่างเล็ก
    m = cv2.blur(g.astype(np.float32), (7, 7))
    v = cv2.blur((g.astype(np.float32)) ** 2, (7, 7)) - m * m
    d = np.sqrt(np.maximum(v, 0.0))
    d = cv2.GaussianBlur(d, (0, 0), 2.0)
    hi = float(np.percentile(d, 99.0)) or 1.0
    w = np.clip(d / hi, 0.0, 1.0)
    w = 1.0 + float(DETAIL_W) * w                  # พื้นเรียบได้ 1 · ย่านรายละเอียดได้ 1+DETAIL_W
    if skip is not None:
        w[skip] = 1.0                              # พื้นไล่สีมีชั้นของตัวเองแล้ว ไม่ต้องแย่งโควตา
    return w.astype(np.float32)


def quantize(img_rgb, k=8, seed=0, keep=None, seed_sample=200000, grad=False,
             kmin=0, cap=None, wmap=None):
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
    if wmap is not None:
        # 🎯 สุ่มตัวอย่างตาม "น้ำหนักความสำคัญ" แทนการสุ่มเท่ากันทุกพิกเซล
        #    (cv2.kmeans ไม่รับน้ำหนักโดยตรง — การสุ่มตามน้ำหนักให้ผลเทียบเท่า)
        _wv = wmap.reshape(-1)[idx].astype(np.float64)
        _wv /= max(1e-9, _wv.sum())
        take = (idx if len(idx) <= 400000 else
                idx[rng.choice(len(idx), size=400000, replace=False, p=_wv)])
    else:
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
    if grad and len(cen) > 2:
        # ⚠️ ผู้ใช้ชี้จุด: ใบไม้สีเดียวถูกแบ่งเป็นสองเฉด แล้วเกิดปื้นสีหลุดในใบ
        #    โหมดไล่สีข้าม merge_blends ไป (ถูกแล้วสำหรับพื้น) แต่ต้องกันสีซ้ำซ้อนด้วย
        # ✅ รวมสีที่ห่างกันน้อยกว่า 6 หน่วย Lab (ตาคนแทบแยกไม่ออก) เข้าด้วยกัน
        _keep = [0]
        for _i in range(1, len(cen)):
            if min(float(np.linalg.norm(cen[_i] - cen[_j])) for _j in _keep) >= 6.0:
                _keep.append(_i)
        if len(_keep) >= 2:
            cen = cen[np.array(_keep)]
    if grad and HARD_ADD > 0:
        # ══════════════════════════════════════════════════════════════
        # 🎯 เก็บ "สีของชิ้นเล็ก" ที่ k-means มองไม่เห็น — เสนอจากชิ้นส่วนจริงในภาพ
        #
        # ⚠️ ผู้ใช้เจอจริง 2026-08-11: คำ wongnai สีน้ำเงิน (20,131,201) ออกมาจางเป็นเทาฟ้า
        #    เพราะจานสีไม่มีน้ำเงินเลย (สีใกล้สุดห่าง 37.6 หน่วย) — k-means แบ่งตามจำนวนพิกเซล
        #    ตัวอักษรเล็กมีแค่ ~0.1% ของภาพ ไม่มีวันชนะ
        # ⛔ ที่ลองแล้วพัง (อย่าย้อนกลับไปทำ):
        #    เพิ่มโควตาสี 12→18/24/30       -> โลโก้ 10.65→12.14/13.23/12.00 (สีไปลงพื้น/พวงหรีด)
        #    เพิ่มสีจาก "พิกเซลไกลจาน" สุ่มทั้งภาพ -> 10.65→13.67 (ได้แต่สีขอบผสม/แถบไล่สี)
        # ✅ ที่ถูก: หา "ก้อนที่ติดกันในภาพ" ของพิกเซลไกลจาน กร่อนขอบผสมทิ้งก่อน
        #    แล้วให้แต่ละก้อนเสนอ "สีกลาง" ของตัวเอง รับเฉพาะก้อนที่สีเกาะกันแน่น
        #    (ก้อนตัวอักษร = สีเดียวทั้งก้อน · แถบไล่สี/ขอบ = สีกระจาย -> ถูกคัดออกเอง)
        # ══════════════════════════════════════════════════════════════
        try:
            _H9, _W9 = lab.shape[:2]
            _ds9 = int(max(1, round(max(_H9, _W9) / 900.0)))
            _Ld = labf(lab[::_ds9, ::_ds9].reshape(-1, 3)).reshape(
                lab[::_ds9, ::_ds9].shape[:2] + (3,))
            _dd = np.full(_Ld.shape[:2], 1e9, np.float32)
            for _c9 in cen:
                np.minimum(_dd, np.sqrt(((_Ld - _c9) ** 2).sum(2)), out=_dd)
            _hm = (_dd > HARD_D).astype(np.uint8)
            if keep is not None:
                _hm &= keep[::_ds9, ::_ds9].astype(np.uint8)
            _hm = cv2.erode(_hm, np.ones((3, 3), np.uint8))     # ตัดขอบผสมบาง ๆ ทิ้ง
            _nc9, _lb9, _st9, _ = cv2.connectedComponentsWithStats(_hm, 8)
            _prop = []
            for _q9 in range(1, _nc9):
                _a9 = int(_st9[_q9, cv2.CC_STAT_AREA])
                if _a9 < 12:
                    continue
                _m9 = (_lb9 == _q9)
                _md = np.median(_Ld[_m9], axis=0)
                _sp = float(np.sqrt(((_Ld[_m9] - _md) ** 2).sum(1)).mean())
                if _sp <= HARD_TIGHT:
                    _prop.append((_a9, _md))
            _prop.sort(key=lambda z: -z[0])
            _addc = []
            for _a9, _md in _prop:
                _pool = np.vstack([cen] + [np.asarray(z).reshape(1, 3) for z in _addc])                         if _addc else cen
                if float(np.sqrt(((_pool - _md) ** 2).sum(1)).min()) >= 8.0:
                    _addc.append(_md)
                if len(_addc) >= int(HARD_ADD):
                    break
            if _addc:
                cen = np.vstack([cen, np.asarray(_addc, np.float64)])
        except Exception:
            pass
    if (not grad) or GRAD_BLEND_CUT:
        # 🌈 โหมดไล่สี: เดิมข้าม merge_blends เพราะ "สีผสมคือเนื้อไล่สี" — แต่นั่นคือสมัยที่
        #    จานสีนี้ยังต้องรับผิดชอบพื้นไล่สีด้วย ตอนนี้พื้นถูกแยกไปที่ anchor แล้ว
        #    จานนี้เหลือแต่ "ลายเส้น/โลโก้" ซึ่งสีผสม = ขอบเปื้อน ต้องตัดเหมือนโหมดปกติ
        #    (ผู้ใช้เห็นจริง: วงแสงเขียวซีดรอบตัวอักษร wongnai = สีผสมขาว×น้ำเงินที่หลุดมา)
        S = Xf[rng.choice(len(Xf), size=min(int(seed_sample), len(Xf)), replace=False)]
        lb0 = ((S[:, None, :] - cen[None, :, :]) ** 2).sum(2).argmin(1)
        cen = merge_blends(cen, np.bincount(lb0, minlength=len(cen)).astype(np.float64))
    pal_rgb = cv2.cvtColor(unlabf(cen).reshape(1, -1, 3), cv2.COLOR_LAB2RGB).reshape(-1, 3)
    return pal_rgb, lab, cen


# ══════════════════════════════════════════════════════════════════
# 2) สนามความเป็นสี (ย่อยพิกเซล)
# ══════════════════════════════════════════════════════════════════

# 🍃 ค่าฟิตไล่สีของ "ชั้นที่เกิดจากการรวมเฉด" (พวงหรีดเขียว→ฟ้า)
#    แยกออกมาเป็นค่าคงที่เพื่อให้กวาดหาค่าที่ดีที่สุดได้โดยไม่ต้องแตะตรรกะ
RAMP_FIT = {"ns": 32, "err": 3.0, "bands": 12}
SOLID_MIN, SOLID_FILL = 150.0, 0.80
# 🖋️ ตัวคูณ "ระยะเกยขอบ" ของโหมดไล่สี (แก้รอยขาวเศษพิกเซล) — คุมน้ำหนักเส้นตัวอักษรด้วย
GRAD_GAP = 1.3
# ✂️ ความแรงของหน้ากากคมชัดหลังขยายภาพ (0 = ปิด)
SHARP_AMT = 0.0
# 🔁 จำนวนรอบ "ฉายกลับ" ตอนขยายภาพ (0 = ปิด) และอัตราแก้ต่อรอบ
IBP_ITERS, IBP_LAM = 6, 0.7
# ⚡ ยุบทางลาดของขอบให้เป็นขั้นบันได (shock filter) — ทำต่อจากขั้นฉายกลับ
#    รอบ / ความแรงต่อรอบ / ความฟุ้งที่ใช้หาทิศของขอบ (0 รอบ = ปิด)
SHOCK_ITERS, SHOCK_AMT, SHOCK_SIG = 2, 1.0, 1.2
SHOCK_IBP = 2                  # จำนวนรอบ "ฉายกลับ" ที่คั่นหลังยุบขอบแต่ละรอบ (กันเส้นผอม)
VT_DEWOBBLE = 1.0              # งบขยับเส้นตอนลบขั้นบันได (px) · 0 = ปิด
# ── ผลวัดจริง (2026-08-13) — ทำในปริภูมิเวกเตอร์ จึง "ไม่ต้องแลกความคม" เหมือนวิธีที่ภาพ
#     ปิด        ทั้งภาพ 2.54 · คม 502 · ยึกยือ 117.9 · 156,269 จุด
#     งบ 0.35    ทั้งภาพ 2.54 · คม 502 · ยึกยือ 119.5 · 146,189 จุด   (เบาไป)
#     งบ 1.0 ✅  ทั้งภาพ 2.57 · คม 506 · ยึกยือ 116.7 ·  85,489 จุด   ← ความคม "เพิ่มขึ้น"
#     งบ 1.8     ทั้งภาพ 2.61 · คม 501 · ยึกยือ 115.8 ·  61,081 จุด   (เริ่มกินรูปทรง)
# 🎯 จุดสำคัญ: ทุกวิธีที่แก้ "ที่ภาพ" ทำให้ความคมลดลงทั้งหมด (502->393/427/340)
#    แต่วิธีนี้ความคมกลับเพิ่มขึ้นเล็กน้อย เพราะไม่ได้ทำให้ขอบนุ่มลงเลยแม้แต่นิดเดียว
#    แค่ลบรอยหยักความถี่สูงที่มาจากตารางพิกเซล โดยมีคำรับประกันว่าขอบไม่ขยับเกิน 1 px
#    ผลพลอยได้: ไฟล์เล็กลง 45% -> เบราว์เซอร์เปิดเร็วขึ้นมาก ดาวน์โหลดไวขึ้น
VT_SOFT = False                # ป้อน "ภาพก่อนยุบขอบ" ให้ขั้นไล่เส้น (วัดแล้วหัวข้อพัง ปิดไว้)
VT_BLUR = 0.0                  # เกลี่ยภาพก่อนไล่เส้น (px) — ปิดไว้ ดูผลวัดข้างล่าง
# ── ผลวัดชุด "แก้เส้นยึกยือ" (2026-08-13) · ยึกยือยิ่งต่ำยิ่งเรียบ · คมยิ่งสูงยิ่งดี
#  ปัจจุบัน (ยุบขอบเต็ม)   ใบไม้ 3.14 หัวข้อ 4.54 โลโก้ 5.68 | คม 502 | ยึกยือ 117.9
#  ป้อนภาพก่อนยุบขอบ       ใบไม้ 3.35 หัวข้อ 7.48 โลโก้ 5.23 | คม 393 | ยึกยือ  88.3
#  เกลี่ย 0.7 px           ใบไม้ 3.28 หัวข้อ 5.25 โลโก้ 5.25 | คม 427 | ยึกยือ  91.2
#  เกลี่ย 1.4 px           ใบไม้ 3.89 หัวข้อ 7.30 โลโก้ 7.41 | คม 340 | ยึกยือ  84.9
# ⛔ ทุกทางที่ลดความยึกยือ "ต้องจ่ายด้วยความคม" ทั้งหมด — เพราะทั้งคู่มาจากรากเดียวกัน
#    คือ VTracer ไล่เส้นจาก *ภาพแรสเตอร์* ขอบจึงกระโดดทีละพิกเซลเสมอ
#    จะคมก็ต้องขอบแข็ง = เป็นขั้นบันได · จะเรียบก็ต้องขอบนุ่ม = ไม่คม
# ✅ ทางออกจริงอยู่ที่เครื่องแปลงของเราเอง ซึ่งคำนวณตำแหน่งขอบระดับ "ย่อยพิกเซล"
#    จากสัดส่วนสีผสม -> คมและเรียบพร้อมกันโดยธรรมชาติ วัดได้ คม 583 · ยึกยือ 94.9
#    (สูงกว่าโหมดผสมทุกตัว) ติดอยู่เรื่องเดียวคือ "การแบ่งโควตาสี" ทำให้ ΔE ยังสู้ไม่ได้
#    -> งานต่อไปคือแก้การแบ่งโควตาสี ไม่ใช่จูนค่าของ VTracer อีกต่อไป
VT_TIMEOUT = 60.0              # เพดานเวลาของขั้นไล่เส้น (วินาที) เกินแล้วทิ้ง ใช้ผลปกติแทน
#  วัดจริงเมื่อเธรดถูกจำกัดถูกต้อง ขั้นนี้ใช้ ~4-10 วิ · ตั้ง 60 = เผื่อไว้ 6 เท่า
#  ถ้าชนเพดานนี้เมื่อไหร่ แปลว่ามีอะไรผิดปกติที่เครื่อง ไม่ใช่เรื่องปกติของงาน
SHOCK_R = 1                    # รัศมีเพื่อนบ้านที่ดูดเข้าหา (1 = 3x3 · 2 = 5x5 ยุบไวขึ้นเท่าตัว)
WORK_LONG = 0.0                # 0 = เลือกอัตโนมัติตามแรมที่เครื่องมีจริง (quality_for_mem)
#  ⚠️ อย่าตั้งเป็นเลขตายตัวอีก — เครื่องแต่ละแพลนแรมไม่เท่ากัน ตั้งตายตัวแล้วเครื่องเล็ก
#     จะถูกฆ่ากลางงานทุกครั้ง (ผู้ใช้เจอจริง 2026-08-13 ที่ ~75% ของงาน)
#  🔁 เคยตั้ง 1800 เพราะ 2400 วัดแล้วแย่ลง (คลื่นรบกวน JPEG ถูกขยายตาม) — พอมีขั้น
#     "เก็บกวาดพื้นเรียบ" (FLAT_MED) แล้ว ข้อเสียนั้นหายไป วัดใหม่ดีขึ้นทุกช่อง:
#     ใบไม้ 3.14->3.06 · หัวข้อ 4.54->3.94 · โลโก้ 5.68->4.69 · ทั้งภาพ 2.54->2.48
WORK_UP = 4.0                  # เพดาน "ขยายได้กี่เท่า" จากไฟล์ต้นฉบับ
# ⛔ อย่าดันเกิน 4 — วัดจริง 6 และ 8 เท่า: โหมดผสม VTracer แพ้การให้คะแนนแล้วถอยกลับ
#    ชั้นลายธรรมดา (เหลือ 32,885 จุด) ผลเลยพังยกแผง โลโก้ 4.69->8.98 · ทั้งภาพ 2.48->2.97
# 🧽 เก็บกวาดคลื่นรบกวนในย่านเรียบก่อนยุบขอบ (ขนาดหน้าต่าง 0/1 = ปิด, ความแรง 0-1)
FLAT_MED, FLAT_AMT = 7, 1.0
MASK_DROP_D = 150              # ระยะสีที่ถือว่าเป็น "เศษสีมาสก์" แล้วทิ้ง (ผลรวม |ΔR|+|ΔG|+|ΔB|)
# ── ผลวัดจริงกับ real.jpg (554px) · "คม" = ความชันขอบเฉลี่ยที่เรนเดอร์ 4 เท่า ยิ่งสูงยิ่งคม
#  ปิดทั้งชุด        ใบไม้ 3.36 หัวข้อ 7.60 โลโก้ 5.55 ทั้งภาพ 2.66 | คม 377 | 152,681 จุด
#  ยุบรวดเดียว 1 รอบ  ใบไม้ 3.19 หัวข้อ 4.99 โลโก้ 5.99 ทั้งภาพ 2.60 | คม 474
#  ยุบรวดเดียว 2 รอบ  ใบไม้ 3.41 หัวข้อ 4.80 โลโก้ 7.83 ทั้งภาพ 2.62 | คม 533   ← เส้นเริ่มผอม
#  ยุบรวดเดียว 4 รอบ  ใบไม้ 3.84 หัวข้อ 5.34 โลโก้ 9.51 ทั้งภาพ 2.66 | คม 580   ← โลโก้พังชัด
#  สลับฉายกลับ 2 รอบ  ใบไม้ 3.17 หัวข้อ 4.91 โลโก้ 5.51 ทั้งภาพ 2.60 | คม 492   ← โลโก้กลับมา
#  + เก็บกวาด 7 ✅   ใบไม้ 3.19 หัวข้อ 4.63 โลโก้ 5.49 ทั้งภาพ 2.58 | คม 497 | 164,385 จุด
# ⛔ อย่าเพิ่มรอบยุบขอบเป็น 3-4 — คมขึ้นแค่ 2% แต่โลโก้ถอย (5.49→5.76→5.90)
# ⛔ อย่าขยับ layer_difference ของ VTracer หวังลดจุด — 16→24 ทั้งภาพ 2.58→2.83 · 16→32 →2.88
#    (จุดลดเยอะจริง 164k→118k→92k แต่ใบไม้พังเป็นแถบ 3.19→3.88→4.17) · corner 60→30 ก็แย่ลง
# 🎨 โควตาสีของ "ชั้นรายละเอียด" เมื่อพื้นไล่สีถูกแยกออกไปแล้ว
# ⛔ อย่าเพิ่มโควตาสี — วัดจริงกับไฟล์จริง: 12→18 โลโก้ 10.65→12.14 · 12→24 →13.23 · 12→30 →12.00
GRAD_KMIN, GRAD_CAP = 12, 24
# 🎯 ความแรงของการถ่วงน้ำหนัก "ย่านรายละเอียด" ตอนแบ่งโควตาสี (0 = ปิด แบ่งตามจำนวนพิกเซลล้วน)
DETAIL_W = 20.0
# ── ผลวัดจริง (2026-08-13) · เฉพาะ "ชั้นลายของเราเอง" คือทางถอยเมื่อ VTracer ใช้ไม่ได้
#     ปิด (0)   ใบไม้ 6.75 หัวข้อ 6.90 โลโก้ 11.78 | คม 583 | ยึกยือ 94.9
#     แรง 8     ใบไม้ 5.64 หัวข้อ 7.01 โลโก้ 13.62 | คม 577 | ยึกยือ 89.9   ← โลโก้แย่ลง
#     แรง 20 ✅ ใบไม้ 5.86 หัวข้อ 6.51 โลโก้ 11.76 | คม 582 | ยึกยือ 90.1
# ⚠️ ต้องรู้ไว้: โหมดที่ใช้งานจริง (ผสม VTracer) วัดแล้ว **ไม่ขยับเลยแม้แต่ทศนิยมเดียว**
#    (ทั้งภาพ 2.54 · คม 502 · ยึกยือ 117.9 เท่ากันเป๊ะทั้งเปิดและปิด)
#    เพราะชั้นลายถูก VTracer แทนที่ทั้งหมด ตัวนี้จึงช่วยแค่ "ทางถอย" เท่านั้น
# 📌 สรุปบทเรียน: สมมติฐาน "โลโก้เพี้ยนเพราะแบ่งโควตาสีตามจำนวนพิกเซล" — ทดสอบแล้ว **ไม่ใช่**
#    ถ่วงน้ำหนักแรงแค่ไหนโลโก้ก็ไม่ดีขึ้น (11.78 -> 13.62 -> 11.76)
#    ต้นเหตุจริงน่าจะอยู่ที่ "เส้นตัวอักษรกว้าง 2 px ในไฟล์ต้นฉบับ" ซึ่งบางเกินกว่าจะ
#    เก็บรูปทรงได้ครบ ไม่ว่าจะมีสีให้กี่สี — ต้องแก้ที่ขั้นดึงเส้น ไม่ใช่ที่จานสี
INK_LEVEL = False              # ⛔ ตัดตามครึ่งยอด — วัดแล้วแย่ลง (ทั้งภาพ 3.11→3.59 · จุด +37%)
# 🎯 เพิ่มสีตามค่าคลาด: จำนวนสีสูงสุดที่เพิ่มได้ต่อรอบ และระยะที่ถือว่า "ไม่มีสีรองรับ"
# ⛔ ผู้ใช้ตัดสินแล้ว (2026-08-11): ชุดแก้รอบ wongnai ทั้งสามตัวทำภาพรวม "แย่ลง" ในสายตาจริง
#    แม้ตัวเลขบางโซนดีขึ้น — ปิดทั้งชุด กลับไปเวอร์ชันก่อนหน้า (ตัวเลขชุดนั้นคือ
#    ใบไม้ 5.32 · หัวข้อ 8.11 · โลโก้ 10.65 · ทั้งภาพ 3.11 · 13 สี · 28,002 จุด)
#    โค้ดเก็บไว้ครบ เผื่อกลับมาจูนใหม่แบบระวังกว่านี้ แต่ห้ามเปิดโดยไม่ให้ผู้ใช้ดูภาพก่อน
HARD_ADD, HARD_D, HARD_TIGHT = 0, 18.0, 5.0
GRAD_BLEND_CUT = False         # (เคยเปิด: หัวข้อ 8.11→6.01 แต่ผู้ใช้เห็นภาพรวมแย่ลง)
# 🔧 ค่าละเอียดของตัวไล่เส้น VTracer (กวาดหาค่าที่คมที่สุดได้โดยไม่ต้องแตะตรรกะ)
VT_OPTS = {"color_precision": 8, "layer_difference": 16, "filter_speckle": 2,   # วัดจริง 6→2: ใบไม้ 4.16→3.80 · โลโก้ 6.93→6.25 · ทั้งภาพ 2.86→2.78
           "corner_threshold": 60, "path_precision": 8,
           # 〰️ length_threshold = ปุ่มคุม "ความยึกยือ" ของเส้นโดยตรง (ช่วง 3.5-10)
           #    ยิ่งสูง ท่อนโค้งยิ่งยาว เส้นยิ่งเรียบ — ที่ผ่านมาไม่เคยตั้ง ใช้ค่าตั้งต้น 4.0 มาตลอด
           "length_threshold": 4.0, "splice_threshold": 45}
VT_PX = 0    # 0 = เลือกอัตโนมัติตามแรม ·     # วัดจริง 2000→2600→3200→4000: ทั้งภาพ 2.82→2.71→2.66→2.60
                 # เลือก 3200 = คมเกือบสุด แต่ไฟล์/เวลายังไม่บาน (4000 จุดเพิ่ม 37% แลกกับ 0.06)
                 # ความละเอียดที่ป้อนให้ตัวไล่เส้น (ยิ่งสูงยิ่งคม แลกกับเวลา)
VT_BILAT = 0     # 0 = ไม่กรองเลย (ภาพผ่านการคืนความชันขอบมาแล้ว กรองซ้ำ = ลบความคมทิ้ง)
VT_MIX = True                  # 🤝 ชั้นลายใช้ VTracer (จากปุ่ม .ai) + พื้นไล่สีของเรา
GRAD_CORE_FIT = False          # ฟิตไล่สีของชั้นลายจากเนื้อใน (กร่อนขอบผสมทิ้งก่อน)         # ตัด "สีผสม" ในจานรายละเอียดของโหมดไล่สีด้วย               # ตัดเส้นชั้นแบบรักษาปริมาณสี (แก้เส้นบางออกมาจาง)
SLIVER_W = 0.0                 # ความหนาขั้นต่ำของชิ้นงาน (พิกเซลของไฟล์ต้นฉบับ)
IBP_CLAMP = False              # กรอบค่าเพื่อนบ้าน — วัดแล้วแย่ลง (ทั้งภาพ 2.32→2.44) ปิดไว้
EDGE_SPAN = 5                  # ความกว้างละแวกที่ถือว่า "ยังเป็นขอบเดียวกัน" (px)
# ── ผลวัดจริง (2026-08-13) — แก้บั๊ก "กลางขอบไม่เคยถูกยุบ"
#     ปิด (1)   ใบไม้ 3.20 หัวข้อ 4.73 โลโก้ 5.70 ทั้งภาพ 2.57 | คม 506
#     5 ✅      ใบไม้ 3.09 หัวข้อ 4.78 โลโก้ 5.70 ทั้งภาพ 2.54 | คม 518  ← คมสูงสุดที่เคยวัดได้
#     9         ใบไม้ 3.04 หัวข้อ 4.98 โลโก้ 5.62 ทั้งภาพ 2.55 | คม 517  (หัวข้อเริ่มถอย)
IBP_LO, IBP_HI = 12.0, 40.0    # ช่วงอนุพันธ์อันดับสองที่ถือว่า "เป็นขอบจริง"
#    กวาดหาแล้ว: (6,25) โลโก้ 11.89 · (12,40) โลโก้ 11.36 ✅ · (20,60) โลโก้ 15.74 (แรงไปจนขอบแหว่ง)


def spatial_adj(labels, n, keep=None, ds=1):
    """🗺️ วัดว่า "สีคู่ไหนอยู่ติดกันจริงในภาพ" — คืนเมทริกซ์สัดส่วนขอบที่ชนกัน

    ทำไมต้องมี: การรวมเฉดด้วย "ระยะสีใน Lab" อย่างเดียวแยกไม่ออกระหว่าง
      · 6 เฉดของพวงหรีดที่ไล่ต่อกันในใบเดียวกัน  (ควรรวม)
      · สีอื่นที่บังเอิญอยู่ใกล้กันในปริภูมิสี แต่คนละที่ในภาพ (ห้ามรวม)
    ตัวชี้ขาดคือ "ติดกันในภาพ" — เฉดของไล่สีเดียวกันจะแบ่งกันด้วยรอยต่อยาว ๆ
    ส่วนสีคนละชิ้นงานแทบไม่มีขอบร่วมกันเลย

    A[i, j] = สัดส่วนของ 'เส้นขอบสี i' ที่ไปติดกับสี j  (0..1)
    """
    L = labels[::ds, ::ds]
    K = None if keep is None else keep[::ds, ::ds]
    k3 = np.ones((3, 3), np.uint8)
    M = []
    for i in range(n):
        m = (L == i)
        if K is not None:
            m = m & K
        M.append(m)
    A = np.zeros((n, n), np.float64)
    solid = np.zeros(n, bool)
    for i in range(n):
        if not M[i].any():
            continue
        # 🧱 สีนี้มี "ก้อนตันใหญ่" อยู่ด้วยไหม (เช่นสี่เหลี่ยมเขียวของโลโก้ LINEMAN)
        #    ถ้ามี ห้ามเอาไปรวมเป็นเฉดไล่สี — เพราะสีเดียวกันถูกใช้กับงานแบนด้วย
        #    รวมเมื่อไหร่ ก้อนแบนนั้นจะเปลี่ยนสีทันที (วัดจริง: โลโก้ 12.7 → 17.5)
        _nc, _lc, _st, _ = cv2.connectedComponentsWithStats(M[i].astype(np.uint8), 8)
        if _nc > 1:
            _ar = _st[1:, cv2.CC_STAT_AREA].astype(np.float64)
            _bb = (_st[1:, cv2.CC_STAT_WIDTH] * _st[1:, cv2.CC_STAT_HEIGHT]).astype(np.float64)
            _fl = _ar / np.maximum(1.0, _bb)
            if bool(((_ar >= SOLID_MIN) & (_fl >= SOLID_FILL)).any()):
                solid[i] = True
        di = cv2.dilate(M[i].astype(np.uint8), k3).astype(bool)
        rim = di & ~M[i]
        nb = int(rim.sum())
        if nb < 8:
            continue
        for j in range(n):
            if j != i:
                A[i, j] = int((rim & M[j]).sum()) / float(nb)
    return A, solid


def merge_ramp(pal_lab, pal_rgb, gap=18.0, resid=5.0, min_n=3, adj=None, amin=0.18,
               solid=None):
    """🍃 รวม "เฉดที่เป็นเส้นไล่สีเดียวกัน" ให้เหลือสีเดียว — ทำ *ก่อน* ติดป้ายสีให้พิกเซล

    ⚠️ บทเรียนสำคัญ (ผู้ใช้ชี้จุด 2026-08-11 · อลิซพลาดมา 2 รอบ):
       พวงหรีดที่ไล่เขียว→ฟ้าถูก k-means หั่นเป็น 6 เฉด (วัดจริง แต่ละเฉดกินใบ 15-20%)
       ใบหนึ่งใบจึงมีรอยต่อแข็ง ๆ กลางใบ = "สีหลุด" ที่ผู้ใช้เห็น
       อลิซเคยแก้ด้วยการ "ใส่ไล่สีให้ทีละเฉดที่ถูกหั่นแล้ว" -> แย่ลงทั้ง 2 ครั้ง
       เพราะแต่ละเฉดเป็นก้อนเล็กกระจัดกระจาย แบบจำลองจับได้แต่คลื่นรบกวน

    ✅ ลำดับที่ถูกคือ "รวมก่อน แล้วค่อยไล่สี" (หลักเดียวกับที่ใช้แก้พื้นหลังสำเร็จ)
       รวมตั้งแต่ตอนนี้ -> ขั้นติดป้ายสีมองพวงหรีดเป็นก้อนเดียว ไม่มีรอยต่อภายในตั้งแต่ต้น
       แล้วชั้นนั้นค่อยไปฟิตไล่สีสองมิติทีหลัง (ก้อนใหญ่ ฟิตได้แม่น)

    เกณฑ์รวม (ต้องเข้าทั้งสามข้อ ป้องกันรวมมั่ว):
      · ห่างกันน้อย  — ระยะระหว่างเฉดติดกัน ≤ gap
      · เรียงเป็นเส้น — ระยะจากเส้นที่ฟิต ≤ resid  (เฉดของไล่สีจะเรียงเป็นเส้นตรงใน Lab)
      · มีอย่างน้อย min_n เฉด — 2 เฉดถือว่าเป็นคนละสีจริง ไม่ใช่ไล่สี
    """
    n = len(pal_lab)
    if n < min_n + 1:
        return pal_lab, pal_rgb, []
    P = np.asarray(pal_lab, np.float64)
    used = np.zeros(n, bool)
    groups = []
    order = np.argsort(P[:, 0])                      # เรียงตามความสว่าง — ไล่สีมักเรียงตามนี้
    for a in order:
        if used[a] or (solid is not None and solid[a]):
            continue
        g = [a]
        while True:
            cur = P[g[-1]]
            best, bd = -1, 1e9
            for b in range(n):
                if used[b] or b in g or (solid is not None and solid[b]):
                    continue
                d = float(np.linalg.norm(P[b] - cur))
                # 🗺️ เกณฑ์ข้อที่สาม: ต้อง "ติดกันจริงในภาพ" กับสมาชิกตัวใดตัวหนึ่งของกลุ่ม
                if adj is not None:
                    ok = max(max(float(adj[q, b]), float(adj[b, q])) for q in g)
                    if ok < amin:
                        continue
                if d < bd:
                    best, bd = b, d
            if best < 0 or bd > gap:
                break
            # ตรวจความเป็นเส้นตรงของกลุ่มถ้าเติมตัวนี้เข้าไป
            cand = g + [best]
            if len(cand) >= 3:
                Q = P[cand]; c = Q.mean(0)
                u, sv, vt = np.linalg.svd(Q - c, full_matrices=False)
                r = float(np.sqrt(((Q - c) - np.outer((Q - c) @ vt[0], vt[0])) ** 2).sum(1).max())
                if r > resid:
                    break
            g = cand
        if len(g) >= min_n:
            for q in g:
                used[q] = True
            groups.append(sorted(g))
    if not groups:
        return pal_lab, pal_rgb, []
    keep, newlab, newrgb, merged = [], [], [], []
    ing = {}
    for gi, g in enumerate(groups):
        for q in g:
            ing[q] = gi
    done = set()
    for i in range(n):
        if i in ing:
            gi = ing[i]
            if gi in done:
                continue
            done.add(gi)
            g = groups[gi]
            newlab.append(P[g].mean(0))
            newrgb.append(np.asarray(pal_rgb, np.float64)[g].mean(0))
            merged.append(len(newlab) - 1)
        else:
            newlab.append(P[i]); newrgb.append(np.asarray(pal_rgb, np.float64)[i])
    return (np.asarray(newlab, np.float64),
            np.asarray(np.clip(np.round(newrgb), 0, 255), np.uint8), merged)

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



def drop_weak_specks(field, cs, min_area, conf=0.62):
    """🧹 ตัด 'จุดด่างปลอม' ที่เกิดจากรอยบีบอัด JPEG รอบตัวอักษร/ขอบคมทิ้ง

    ⚠️ ผู้ใช้ชี้จุด 2026-08-11: มีปื้นเทา/ดำเล็ก ๆ โผล่บนพื้นขาว (ข้าง ' ของ USERS' ·
       หลังตัว E · ใบไม้ปลอมบนพื้นหลัง) หลังจากอลิซลดเกณฑ์ชิ้นเล็กสุดลง 55%
       เพื่อเก็บตัวอักษรจิ๋วไว้ — ตัวอักษรจิ๋วรอด แต่รอยด่างบีบอัดก็รอดมาด้วย

    ✅ อย่าตัดด้วย "ขนาด" อย่างเดียว (ตัวอักษรจิ๋วก็เล็กเหมือนกัน) ให้ดู "ความมั่นใจ"
       ลายจริง: ข้างในเป็นสีนั้นเต็ม ๆ -> ค่าสนามใกล้ 1
       รอยด่างบีบอัด: เป็นสีก้ำกึ่ง -> ค่าสนามค้างแถว 0.5-0.6
       ตัดเฉพาะชิ้นที่ "เล็กกว่าเกณฑ์เดิม และ ไม่มั่นใจ" เท่านั้น
    """
    if not cs:
        return cs
    H, W = field.shape[:2]
    out = []
    for c in cs:
        a = np.asarray(c, float)
        ar = _area(a)
        if ar <= 0 or abs(ar) >= float(min_area) or len(a) < 4:
            out.append(c); continue                    # รู หรือ ชิ้นใหญ่พอ -> เก็บ
        x0 = max(0, int(np.floor(a[:, 0].min())) - 1); x1 = min(W, int(np.ceil(a[:, 0].max())) + 2)
        y0 = max(0, int(np.floor(a[:, 1].min())) - 1); y1 = min(H, int(np.ceil(a[:, 1].max())) + 2)
        if x1 - x0 < 3 or y1 - y0 < 3:
            out.append(c); continue
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(m, [np.round(a - [x0, y0]).astype(np.int32)], 1)
        if m.sum() < 3:
            out.append(c); continue
        if float(field[y0:y1, x0:x1][m > 0].mean()) >= float(conf):
            out.append(c)                              # มั่นใจว่าเป็นลายจริง -> เก็บ
    return out

def ink_level(field, lo=0.30, hi=0.50):
    """🖋️ หา 'ระดับเส้นชั้น' ที่ทำให้พื้นที่ของรูปเท่ากับปริมาณสีจริงในสนาม

    ⚠️ ปัญหาที่ผู้ใช้เห็น (2026-08-11): โลโก้ wongnai ออกมา "จาง" ทั้งที่ต้นฉบับน้ำเงินเข้ม
       เพราะเส้นหนาแค่ ~2 px ในไฟล์ 554 px ค่าความเป็นสีสูงสุดกลางเส้นจึงไม่ถึง 1.0
       พอตัดที่ 0.5 ตายตัว เส้นที่ได้จะบางกว่าของจริงมาก -> ตอนวาดโดนเกลี่ยกับพื้นขาว = จาง
       (วัดได้ว่าเส้นบางลงทั้งภาพ 4-5% ซึ่งไม่มีผลกับก้อนใหญ่ แต่ฆ่าเส้นบางทิ้งเลย)
    ✅ ใช้หลัก "ปริมาณสีต้องไม่หาย": พื้นที่ของรูปที่ได้ ต้องเท่ากับผลรวมความเป็นสีของสนาม
       ก้อนใหญ่ขอบคม -> ได้ 0.5 เท่าเดิมเป๊ะ · เส้นบาง -> ระดับลดลงเอง เส้นจึงหนาเท่าของจริง
       จำกัดไม่ต่ำกว่า lo กัน 'ชั้นที่จาง ๆ ทั้งชั้น' บวมจนกลืนชั้นอื่น
    """
    m = field[field > 0.2]
    if m.size < 16:
        return float(hi)
    pk = float(np.percentile(m, 99.0))
    if pk >= 0.90:
        return float(hi)                 # ชั้นนี้มีเนื้อเต็ม ๆ อยู่ -> ตัดครึ่งตามเดิม
    return float(np.clip(0.5 * pk, lo, hi))


def contours_adaptive(field, min_area, smooth_k=2, sigma0=0.6, sigma_max=6.0,
                      target=1.5, grow_rate=1.7, max_round=5, max_pieces=250, min_hole=4.0,
                      wave_target=99.0, fine_below=0, level=0.5):
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
        cs = [c for c in contours_of(field, level, smooth_k, sigma=sig, fine_below=fine_below)
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


def contours_of(field, level=0.5, smooth_k=2, min_pts=8, pad=2, sigma=0.0, fine_below=0):
    """⚠️ ต้องเติมขอบค่า 0 รอบสนามก่อนเสมอ
    ย่านสีที่ชนขอบภาพ (เช่นพื้นหลัง) จะได้คอนทัวร์เปิด ปิดรูปไม่ได้ -> หายทั้งชั้น"""
    field = denoise_field(field, sigma)
    f = np.pad(field, pad, mode="constant", constant_values=0.0)
    out = []
    for c in measure.find_contours(f, level):
        if len(c) < min_pts:
            continue
        p = np.column_stack([c[:, 1] - pad, c[:, 0] - pad])
        # 🔎 ชิ้นเล็ก (ใบไม้ · ตัวอักษรจิ๋ว) เกลาน้อยลง 1 ขั้น — ไม่งั้นรายละเอียดถูกลบตั้งแต่ต้นทาง
        #    ชิ้นใหญ่ยังเกลาเท่าเดิม จำนวนจุด/เวลาจึงไม่บาน (เกลาน้อยทั้งภาพ: จุด +70% เวลา ×2)
        #    ⚠️ เปิดเฉพาะโหมดไล่สี (fine_below > 0) — งานปกติต้องได้ผลเท่าเดิมทุกจุด
        _k9 = smooth_k
        if int(fine_below) > 0 and len(p) <= int(fine_below):
            _k9 = max(1, int(smooth_k) - 1)
        out.append(_smooth(p, _k9))
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


def _shock_rgb(img_rgb, w, iters=2, amt=1.0, sig=1.2, r=1):
    """⚡ ทำให้ "ทางลาดของขอบ" กลับเป็น "ขั้นบันได" (shock filter — Osher & Rudin)

    ทำไมต้องมี (2026-08-13 — พี่ตีกลับว่า "นี่คือคมแล้วเหรอ ทำใหม่ ไม่ผ่าน"):
      ที่ผ่านมาเราวัดคุณภาพด้วย ΔE เทียบไฟล์ต้นฉบับ 554 px ซึ่ง "เบลออยู่แล้ว"
      ตัวชี้วัดนั้นจึงให้รางวัลกับการ *เก็บรอยเบลอไว้ให้ครบ* — ยิ่งลอกทางลาดของ
      ขอบมาเหมือนเท่าไหร่ คะแนนยิ่งดี แต่สายตาคนอ่านว่า "ไม่คม" เพราะ VTracer
      ไปไล่เส้นทางลาดนั้นออกมาเป็นชั้นสีกลาง ๆ หลายชั้นซ้อนกัน = ขอบฟุ้ง
      ตัวนี้ตัดสินใจแทน: พิกเซลในทางลาดต้องเลือกข้าง ไม่อยู่กลางทาง

    หลักการ: ที่อนุพันธ์อันดับสอง > 0 (ฝั่งเว้า = ด้านมืดของขอบ) ให้ดูดเข้าหา
    เพื่อนบ้านที่มืดที่สุด · < 0 (ฝั่งนูน) ดูดเข้าหาเพื่อนบ้านที่สว่างที่สุด
    ทำซ้ำไม่กี่รอบ ทางลาดกว้าง 3-4 px จะยุบเป็นขอบคม 1 px

    🛡️ ห้ามสร้างสีใหม่: ไม่ได้ใช้ erode/dilate แยกทีละช่องสี (แบบนั้นเอา R ต่ำสุด
       จากพิกเซลหนึ่ง G ต่ำสุดจากอีกพิกเซล = ได้สีที่ไม่มีอยู่จริงในภาพ ขอบสองสี
       จะเกิดเส้นสีแปลกปลอมคั่นกลาง) แต่เลือก "พิกเซลเพื่อนบ้าน" ด้วยความสว่าง
       แล้วคัดลอก RGB ของพิกเซลนั้นมาทั้งชุด -> ทุกสีที่ออกมามีอยู่ในภาพจริงเสมอ

    w : น้ำหนักต่อพิกเซล (h,w,1) — ใช้ตัวเดียวกับขั้นฉายกลับ คือ "แรงเฉพาะที่มี
        ขอบจริง" ย่านไล่สีนุ่ม ๆ อนุพันธ์อันดับสอง ~0 จึงไม่โดนแตะเลย
    r : รัศมีเพื่อนบ้าน — 1 คือดูรอบตัว 3x3 (ยุบทางลาดได้รอบละ 1 px)
        ทางลาดหลังขยายภาพกว้าง 3-4 px ถ้าใช้ r=1 ต้องวนหลายรอบกว่าจะยุบหมด
        ซึ่งกัดเส้นบางให้ผอมไปด้วย · r=2 กระโดดทีเดียว 2 px จบเร็วกว่า เสียหายน้อยกว่า

    💾 ทำงาน "ทับที่เดิม" บน float32 ที่ส่งเข้ามา และไล่ทีละช่องสี — ภาพทำงาน
       1800x1800 ถ้าจับทั้งสามช่องพร้อมกันต้องใช้ก้อนละ 39 MB หลายก้อนซ้อน
       (วัดจริง: ขั้นนี้เคยดันแรมพุ่งชั่วขณะถึง 186 MB) ทำทีละช่องเหลือราว 1/3
    """
    F = img_rgb if img_rgb.dtype == np.float32 else img_rgb.astype(np.float32)
    h, w_ = F.shape[:2]
    r = max(1, int(r))
    n = (2 * r + 1) ** 2
    w1 = w[:, :, 0] if w.ndim == 3 else w
    for _ in range(int(iters)):
        # 🛡️ ต้องหนีบให้อยู่ในช่วง 0-255 ก่อนทุกรอบ — ขั้นฉายกลับดันค่าล้นออกนอกช่วงได้
        #    ถ้าปล่อยไว้ ขั้นนี้จะไป "เลือกเพื่อนบ้านที่สว่าง/มืดที่สุด" ซึ่งก็คือค่าล้นนั้นเอง
        #    แล้วแพร่มันออกไปทั่วขอบ (วัดจริงตอนลืมหนีบ: หัวข้อ 4.63 -> 5.91 · โลโก้ 5.49 -> 5.79)
        np.clip(F, 0, 255, out=F)
        g = cv2.cvtColor(F.astype(np.uint8), cv2.COLOR_RGB2GRAY)
        gs = cv2.GaussianBlur(g.astype(np.float32), (0, 0), sig)
        lap = cv2.Laplacian(gs, cv2.CV_32F, ksize=3)
        del gs
        gp = cv2.copyMakeBorder(g, r, r, r, r, cv2.BORDER_REPLICATE)
        del g
        # หา "เพื่อนบ้านมืดสุด/สว่างสุด" แบบเดินสะสม ไม่กองทุกชั้นไว้พร้อมกัน
        # (r=2 คือ 25 ชั้น · ภาพ 1800x1800 = 81 MB ถ้ากองไว้ — เครื่อง Render มี 512 MB)
        # ⚠️ ต้องตั้งค่าเริ่มจาก "เพื่อนบ้านหมายเลข 0" ไม่ใช่พิกเซลตรงกลาง — เคยตั้งจาก
        #    ตรงกลางแต่ให้หมายเลขเป็น 0 ผลคือพิกเซลที่ตัวเองมืด/สว่างที่สุดอยู่แล้ว
        #    จะถูกชี้ไปที่เพื่อนบ้านมุมบนซ้ายแทน = ภาพเลื่อนเฉียง 1 px ทั้งย่านขอบ
        #    (วัดจริงตอนพลาด: หัวข้อ 4.63 -> 5.73 · โลโก้ 5.49 -> 5.61)
        vmin = gp[0:h, 0:w_].copy(); imin = np.zeros((h, w_), np.uint8)
        vmax = vmin.copy(); imax = np.zeros((h, w_), np.uint8)
        for i in range(1, n):
            dy, dx = divmod(i, 2 * r + 1)
            v = gp[dy:dy + h, dx:dx + w_]
            m = v < vmin
            vmin[m] = v[m]; imin[m] = i
            m = v > vmax
            vmax[m] = v[m]; imax[m] = i
        sel = np.where(lap > 0, imin, imax)
        del gp, vmin, vmax, imin, imax, lap
        aw = (float(amt) * w1)
        for _ch in range(F.shape[2]):                 # ทีละช่องสี = แรมชั่วขณะเหลือ 1/3
            Cp = cv2.copyMakeBorder(F[:, :, _ch], r, r, r, r, cv2.BORDER_REPLICATE)
            tg = np.empty((h, w_), np.float32)
            for i in range(n):
                dy, dx = divmod(i, 2 * r + 1)
                m = (sel == i)
                if m.any():
                    tg[m] = Cp[dy:dy + h, dx:dx + w_][m]
            del Cp
            tg -= F[:, :, _ch]
            tg *= aw
            F[:, :, _ch] += tg
            del tg
        del sel, aw
    np.clip(F, 0, 255, out=F)
    return F


def _vt_items(img_rgb, px=2000, cp=8, ld=16, spk=2, cor=60, pp=8, bilat=0,
              progress=None, lth=4.0, spl=45):
    """🔪 ไล่เส้นด้วย VTracer เอง — คุมขั้นเตรียมภาพเองทั้งหมด เพื่อ "ความคมสูงสุด"

    ⚠️ ทำไมไม่เรียกผ่าน trace_engine (ผู้ใช้ขอความคมสุด ๆ 2026-08-11):
       ตัวนั้นย่อ/ขยายภาพเป็น 2000 px ซ้ำอีกครั้ง แล้วยัง bilateral filter ทับอีกชั้น
       ภาพของเราผ่านการขยาย + คืนความชันขอบมาแล้ว การกรองซ้ำ = ลบความคมที่อุตส่าห์ทำมา
    ✅ ตัวนี้: ปรับขนาดครั้งเดียวด้วย LANCZOS · ไม่กรองเลย · ความละเอียดพิกัดสูงขึ้น
       แล้วหารพิกัดกลับมาที่สเกลภาพทำงานให้เรียบร้อย (ผู้เรียกใช้ได้พิกัดตรงเลย)
    คืน [((b,g,r), [subpath...])] เรียงตามลำดับซ้อนของ VTracer เหมือน trace_engine เป๊ะ
    """
    import re as _re
    import tempfile as _tf
    import vtracer
    from svgpathtools import parse_path
    H0, W0 = img_rgb.shape[:2]
    L0 = max(H0, W0)
    _px = int(max(L0, px))                        # ห้ามย่อลง — ย่อ = ทิ้งรายละเอียดทิ้งเปล่า ๆ
    if _px != L0:
        _sc = float(_px) / float(L0)
        _im = cv2.resize(img_rgb, (int(round(W0 * _sc)), int(round(H0 * _sc))),
                         interpolation=cv2.INTER_LANCZOS4)
    else:
        _im = img_rgb
    if bilat and int(bilat) > 0:
        _im = cv2.bilateralFilter(_im, 5, int(bilat), int(bilat))
    _f = float(W0) / float(_im.shape[1])           # ตัวคูณกลับสู่สเกลภาพทำงาน
    _p1 = _tf.mktemp(suffix=".png")
    _p2 = _tf.mktemp(suffix=".svg")
    cv2.imwrite(_p1, cv2.cvtColor(_im, cv2.COLOR_RGB2BGR))
    del _im
    # ══════════════════════════════════════════════════════════════
    # ⏱️ เรียก VTracer ใน "โปรเซสลูก" พร้อมนาฬิกาจับเวลา — กันค้างถาวร
    # ══════════════════════════════════════════════════════════════
    # ⚠️ ปัญหาที่ผู้ใช้เจอซ้ำ ๆ: แถบค้างที่ 55% เป็นสิบนาที
    #    55% คือจุดที่อยู่ "ข้างใน" VTracer ซึ่งเป็นโค้ด Rust — เรียกแล้วสั่งหยุดไม่ได้เลย
    #    ต่อให้ผู้ใช้ปิดหน้าเว็บ งานก็ยังวิ่งกินเครื่องต่อไปจนจบ
    # ✅ ย้ายไปโปรเซสลูก -> สั่งฆ่าได้จริงเมื่อเกินเวลา
    #    และจังหวะที่เรียกตัวนี้ ชั้นลายแบบปกติ "คำนวณเสร็จอยู่ในมือแล้ว"
    #    เกินเวลาเมื่อไหร่จึงแค่ทิ้ง VTracer แล้วใช้ผลปกติ = ผู้ใช้ได้งานเสมอ ไม่มีค้าง
    #    (บวกกับตั้ง RAYON_NUM_THREADS ให้พอดีโควตาแล้ว ปกติจะไม่แตะเพดานนี้เลย)
    _code = ("import vtracer,sys;a=sys.argv;"
             "vtracer.convert_image_to_svg_py(a[1],a[2],colormode='color',mode='spline',"
             "hierarchical='stacked',filter_speckle=int(a[3]),color_precision=int(a[4]),"
             "layer_difference=int(a[5]),corner_threshold=int(a[6]),path_precision=int(a[7]),"
             "length_threshold=float(a[8]),splice_threshold=int(a[9]))")
    _env = dict(os.environ)
    _env["RAYON_NUM_THREADS"] = str(_NTHREADS)       # ย้ำอีกชั้นให้โปรเซสลูกแน่ ๆ
    import subprocess as _sp, sys as _sys
    try:
        _sp.run([_sys.executable, "-c", _code, _p1, _p2, str(int(spk)), str(int(cp)),
                 str(int(ld)), str(int(cor)), str(int(pp)),
                 str(float(lth)), str(int(spl))],
                timeout=float(VT_TIMEOUT), env=_env, check=True,
                stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)
    except Exception:
        for _q in (_p1, _p2):                        # เก็บกวาดแล้วโยนต่อ
            try:
                os.unlink(_q)
            except Exception:
                pass
        raise                                        # ผู้เรียกจะถอยไปใช้ชั้นลายปกติเอง
    svg = open(_p2, encoding="utf-8").read()
    for _q in (_p1, _p2):
        try:
            os.unlink(_q)
        except Exception:
            pass
    out = []
    # 📶 ขั้นแยกเส้นจาก SVG ใช้เวลาพอควรเมื่อมีเส้นเป็นแสนจุด — รายงานความคืบหน้าด้วย
    _pl = list(_re.finditer(r'<path\b([^>]*?)/>', svg, _re.S))
    _np = max(1, len(_pl))
    for _i9, pm in enumerate(_pl):
        if progress is not None and (_i9 % 200) == 0:
            try:
                progress(100.0 * _i9 / _np, "แยกเส้นลายละเอียด %d/%d" % (_i9, _np))
            except Exception:
                pass
        tag = pm.group(1)
        dm = _re.search(r'd="([^"]+)"', tag)
        fm = _re.search(r'fill="#([0-9a-fA-F]{6})"', tag)
        if not dm or not fm:
            continue
        hx = fm.group(1)
        r_, g_, b_ = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
        tx = ty = 0.0
        sx = sy = 1.0
        tt = _re.search(r'translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)', tag)
        if tt:
            tx, ty = float(tt.group(1)), float(tt.group(2))
        sm = _re.search(r'scale\(\s*([-\d.eE]+)(?:[ ,]+([-\d.eE]+))?', tag)
        if sm:
            sx = float(sm.group(1)); sy = float(sm.group(2)) if sm.group(2) else sx

        def X(pt, sx=sx, sy=sy, tx=tx, ty=ty, f=_f):
            return ((pt.real * sx + tx) * f, (pt.imag * sy + ty) * f)

        try:
            path = parse_path(dm.group(1))
        except Exception:
            continue
        subs = []
        for sub in path.continuous_subpaths():
            if len(sub) < 1:
                continue
            segs = []
            for seg in sub:
                cn = type(seg).__name__
                if cn == "Line":
                    segs.append(("L", X(seg.end)))
                elif cn == "CubicBezier":
                    segs.append(("C", X(seg.control1), X(seg.control2), X(seg.end)))
                elif cn == "QuadraticBezier":
                    c1 = seg.start + (2.0 / 3.0) * (seg.control - seg.start)
                    c2 = seg.end + (2.0 / 3.0) * (seg.control - seg.end)
                    segs.append(("C", X(c1), X(c2), X(seg.end)))
                elif cn == "Arc":
                    for t in (0.25, 0.5, 0.75, 1.0):
                        segs.append(("L", X(seg.point(t))))
            if segs:
                subs.append({"start": X(sub[0].start), "segs": segs, "closed": True})
        if subs:
            out.append(((b_, g_, r_), _vt_deband(subs) if VT_DEWOBBLE > 0 else subs))
    return out


def _vt_deband(subs):
    """〰️ ลบ "ขั้นบันไดระดับพิกเซล" ออกจากเส้นที่ VTracer ไล่มา — ทำในปริภูมิเวกเตอร์

    ⚠️ ทำไมต้องทำตรงนี้ ไม่ใช่ที่ภาพ (บทเรียน 2026-08-13 · ผู้ใช้ทัก "ใบไม้ยึกยือมาก"):
       VTracer ไล่เส้นจาก *ภาพแรสเตอร์* ขอบจึงกระโดดทีละพิกเซลเสมอ
       ทุกวิธีที่ลองแก้ "ที่ภาพ" ต้องจ่ายด้วยความคมทั้งหมด วัดมาแล้วทั้งชุด:
         ป้อนภาพก่อนยุบขอบ  ยึกยือ 117.9->88.3  แต่ความคม 502->393
         เกลี่ย 0.7 px      ยึกยือ 117.9->91.2  แต่ความคม 502->427
       เพราะทั้งคู่คือ "ทำให้ขอบนุ่มลง" ซึ่งขัดกับสิ่งที่ผู้ใช้ต้องการโดยตรง
    ✅ ทำที่ "ตัวเส้น" แทน: คลี่เส้นโค้งเป็นแนวจุด -> เกลาแบบไม่กินมุมคม
       -> ฟิตกลับเป็นเบซิเยร์โดยมี "คำรับประกันความคลาด" ไม่เกิน VT_DEWOBBLE พิกเซล
       ตำแหน่งขอบจึงแทบไม่ขยับ (ต่ำกว่าครึ่งพิกเซล) = ความชันของขอบไม่เปลี่ยนเลย
       แต่รอยหยักความถี่สูงที่มาจากตารางพิกเซลถูกลบทิ้ง = เส้นเรียบขึ้นจริง
    """
    out = []
    for sp in subs:
        pts = [sp["start"]]
        for sg in sp["segs"]:                       # คลี่เป็นแนวจุด (เบซิเยร์ -> 6 ช่วง)
            if sg[0] == "L":
                pts.append(sg[1])
            else:
                p0 = pts[-1]; c1, c2, p3 = sg[1], sg[2], sg[3]
                for i in range(1, 7):
                    t = i / 6.0; u = 1.0 - t
                    pts.append((u*u*u*p0[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p3[0],
                                u*u*u*p0[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p3[1]))
        P = np.asarray(pts, np.float64)
        if len(P) < 10:                             # เส้นสั้นมาก เกลาแล้วเสียรูป ปล่อยไว้
            out.append(sp); continue
        if np.hypot(*(P[0] - P[-1])) < 1e-6:
            P = P[:-1]
        try:
            # แรงเกลาโตตามงบที่ให้ — งบมาก = คลื่นใหญ่ก็ลบได้ (ไม่ใช่แค่ขั้นบันไดพิกเซล)
            _k = int(max(1, round(float(VT_DEWOBBLE) * 3.0)))
            Q = _smooth(P, _k, keep_corner=True, corner_deg=42.0)
            d = np.hypot(*(Q - P).T)                # 🔒 บังคับไม่ให้ขยับเกินงบที่ตั้งไว้
            m = d > float(VT_DEWOBBLE)
            if m.any():
                Q[m] = P[m] + (Q[m] - P[m]) * (float(VT_DEWOBBLE) / d[m])[:, None]
            st, sg2 = fit_bounded(np.vstack([Q, Q[:1]]), float(VT_DEWOBBLE))
            if sg2:
                out.append({"start": (float(st[0]), float(st[1])),
                            "segs": [(g[0],) + tuple((float(q[0]), float(q[1]))
                                                     for q in g[1:]) for g in sg2],
                            "closed": True})
                continue
        except Exception:
            pass
        out.append(sp)
    return out


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
              min_area=None, transparent=None, seed=0, grad=False, progress=None):
    """img_rgba = ndarray HxWx3 (RGB) หรือ HxWx4 (RGBA)

    คืน dict: layers · size (กว้าง,สูง หน่วยพิกเซลต้นฉบับ) · bg · stats
    progress = ฟังก์ชัน (เปอร์เซ็นต์, ข้อความ) สำหรับรายงานความคืบหน้าจริงให้หน้าเว็บ
               (ไม่ส่งมาก็ได้ — โค้ดเดิมทุกที่เรียกโดยไม่ส่ง จึงไม่กระทบอะไรเลย)
    """
    def _pg(p, s):
        if progress is not None:
            try:
                progress(p, s)
            except Exception:
                pass
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
    # 🔒 ดันความละเอียดเฉพาะโหมดไล่สีเท่านั้น — โหมดปกติจูนมาทั้งชุดตรวจ 11 ไฟล์แล้ว
    #    และมีข้อตกลงว่าต้องได้ผลเหมือนเดิมเป๊ะ (reg.py เทียบ md5) ห้ามขยับเด็ดขาด
    _wl, _vtpx = quality_for_mem()
    if float(WORK_LONG) > 0:                 # ตั้งค่าเองทับได้ (ใช้ตอนทดสอบ/วัดผล)
        _wl = float(WORK_LONG)
    _tgt_long = _wl if grad else 1800.0
    #  ⚠️ อย่าขยับขึ้น 2400 — ทดสอบแล้วแย่ลงทุกตัว (คลื่นรบกวน JPEG ถูกขยายตาม)
    #     วัดจริง: โลโก้ 12.8→15.7 · ใบไม้ 2.91→3.33 · ทั้งภาพ 2.19→2.93 · เวลา 61→75 วิ
    if _long > 0 and _long < _tgt_long * 0.95:
        _up = min(float(WORK_UP), _tgt_long / _long)          # เพดานการขยาย
        _mp_up = (W0 * _up) * (H0 * _up) / 1e6
        if _mp_up > MAX_MP * 0.55:                            # กันแรมบาน
            _up = max(1.0, ((MAX_MP * 0.55 * 1e6) / max(1.0, W0 * H0)) ** 0.5)
        if _up > 1.05:
            _nw, _nh = int(round(W0 * _up)), int(round(H0 * _up))
            img0u = np.ascontiguousarray(img)
            img0f = img.astype(np.float32)
            img = cv2.resize(img, (_nw, _nh), interpolation=cv2.INTER_LANCZOS4)
            if alpha is not None:
                alpha = cv2.resize(alpha, (_nw, _nh), interpolation=cv2.INTER_LANCZOS4)
            sc = float(_nw) / float(W0)                       # ตอนจบ _scale_items จะหารกลับให้เอง
            # ⛔ หน้ากากคมชัดธรรมดา (unsharp) — วัดแล้วแย่ลง ปิดไว้ อย่ารื้อมาใช้อีก
            #    แรง 0.4 → โลโก้ 12.20 · ข้อความ 7.20 · ใบไม้ 3.57 · ทั้งภาพ 2.63
            #    แรง 0.8 → โลโก้ 11.53 · ข้อความ 6.70 · ใบไม้ 3.42 · ทั้งภาพ 2.58
            #    เพราะมัน "เดา" ว่าขอบควรชันแค่ไหน แล้วสร้างขอบเว่อร์ที่ไม่มีในไฟล์จริง
            # ✂️ คืนความชันของขอบที่หายไปตอนขยาย (ผู้ใช้ทักซ้ำว่า "ไม่คม/เบลอ")
            #    ไฟล์เล็กถูกขยาย 3 เท่า -> ขอบเดิมกว้าง 1 px กลายเป็นทางลาดกว้าง 3 px
            #    ขั้นหาเส้นขอบใช้จุดตัด 0.5 ของทางลาดนั้น ยิ่งลาดกว้างตำแหน่งยิ่งไม่แน่นอน
            #    จึงหักคืนด้วยหน้ากากคมชัดที่ 'จูนขนาดตามความฟุ้งที่วัดได้จริง' ไม่ใช่ค่าตายตัว
            # 🔁 คืนรายละเอียดด้วยการ "ฉายกลับ" (iterative back-projection)
            #    ต่างจากหน้ากากคมชัดตรงที่ไม่ได้เดาว่าขอบควรชันแค่ไหน แต่บังคับเงื่อนไขจริง:
            #    "ถ้าย่อภาพที่ขยายแล้วกลับลงมา ต้องได้ต้นฉบับเป๊ะ" แล้วไล่แก้ส่วนต่างทีละรอบ
            #    จึงไม่เกิดขอบเว่อร์ (overshoot) แบบหน้ากากคมชัด — ข้อมูลมาจากไฟล์จริงล้วน ๆ
            _pg(10, "คืนความคมของขอบ")
            if IBP_ITERS > 0 and grad:
                # 🔒 เปิดเฉพาะโหมดไล่สี — โหมดปกติจูนมาทั้งชุดตรวจ 11 ไฟล์แล้ว ห้ามขยับเงียบ ๆ
                # ⚠️ วัดจริง: ถ้าฉายกลับ "ทั้งภาพ" โลโก้ดีขึ้น (12.69→11.66) แต่พื้นไล่สี
                #    กับใบไม้แย่ลงชัด (2.92→3.54) เพราะการคืนความชันไปคืนคลื่นรบกวน JPEG
                #    ในย่านที่สีควรเปลี่ยนอย่างนุ่มนวลด้วย -> เกิดริ้วบนไล่สี
                # ✅ จึงใส่ให้ "เฉพาะย่านที่มีขอบจริง" — วัดด้วยอนุพันธ์อันดับสอง
                #    ไล่สีเชิงเส้นมีอนุพันธ์อันดับสอง ~0 · ขอบตัวอักษรสูงมาก แยกกันได้สะอาด
                _lp = np.abs(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
                                           .astype(np.float32), cv2.CV_32F, ksize=3))
                _w = np.clip((_lp - IBP_LO) / max(1e-6, IBP_HI - IBP_LO), 0.0, 1.0)
                # 🎯 แผ่น้ำหนักให้คลุม "ทั้งความกว้างของขอบ" ก่อนเกลี่ย
                # ⚠️ บั๊กที่ซ่อนมาตลอด (จับได้ 2026-08-13 จากภาพซูมที่พี่ส่งมา):
                #    เราใช้ค่าสัมบูรณ์ของอนุพันธ์อันดับสอง ซึ่ง ณ "กลางขอบพอดี" มันข้ามศูนย์
                #    ค่าจึงเกือบ 0 -> น้ำหนักเกือบ 0 -> พิกเซลกลางขอบ **ไม่เคยถูกยุบเลย**
                #    แต่พิกเซลกลางขอบคือพิกเซล "สีกลางทาง" ระหว่างสองสีพอดี
                #    ผลคือทุกชิ้นงานมีวงแหวนสีกลางบาง ๆ ล้อมรอบ แล้ว VTracer ก็ไล่เส้น
                #    วงแหวนนั้นออกมาเป็นชั้นจริง -> ตัวอักษรมีเงาเทาล้อม ใบไม้มีขอบเขียวจาง
                #    = สาเหตุที่ผู้ใช้บอกว่า "ตัวอักษรก็ไม่คม ขอบก็ไม่คม" มาตลอด
                # ✅ เอาค่าสูงสุดในละแวกใกล้ ๆ มาแทน -> แถบขอบทั้งแถบได้น้ำหนักเต็ม
                #    รวมถึงพิกเซลกลางขอบที่เคยถูกข้าม -> มันถูกบังคับให้เลือกข้างด้วย
                _w = cv2.dilate(_w, cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE, (EDGE_SPAN | 1, EDGE_SPAN | 1)))
                _w = cv2.GaussianBlur(_w, (0, 0), 1.5)[:, :, None]
                # 🛡️ กันขอบเว่อร์ (ringing): บังคับให้ทุกค่าอยู่ในช่วง "ต่ำสุด-สูงสุดของเพื่อนบ้าน"
                #    ของภาพขยายตั้งต้นเสมอ -> สร้างสีใหม่ที่ไม่มีอยู่รอบ ๆ ไม่ได้เลย
                #    (ไม่ใส่ตัวนี้จะเกิด "เส้นเขียวอมฟ้าบาง ๆ" ตรงรอยต่อพื้นน้ำเงินกับวงขาว)
                #    ใช้ช่วงค่าจาก "ไฟล์ต้นฉบับก่อนขยาย" (ขยายแบบไม่เกลี่ย) ไม่ใช่จากภาพที่ขยายแล้ว
                #    เพราะภาพที่ขยายแล้วถูกเกลี่ยจนช่วงค่าแคบลง ถ้าเอามาเป็นกรอบจะล็อกความคมไว้เท่าเดิม
                # 💾 สร้างเฉพาะตอนเปิดใช้จริง — สองก้อนนี้คือ float32 เต็มขนาดภาพขยาย
                #    (ภาพ 1800x1800 = ก้อนละ 39 MB) เดิมสร้างทุกครั้งทั้งที่ IBP_CLAMP
                #    ปิดอยู่ = ทิ้ง 78 MB ฟรี ๆ บนเครื่องที่มีแรม 512 MB
                _lo = _hi = None
                if IBP_CLAMP:
                    _k3 = np.ones((3, 3), np.uint8)
                    _lo = cv2.resize(cv2.erode(img0u, _k3), (_nw, _nh),
                                     interpolation=cv2.INTER_NEAREST).astype(np.float32)
                    _hi = cv2.resize(cv2.dilate(img0u, _k3), (_nw, _nh),
                                     interpolation=cv2.INTER_NEAREST).astype(np.float32)
                def _ibp(_U, _n):
                    for _ in range(int(_n)):
                        _D = cv2.resize(_U, (W0, H0), interpolation=cv2.INTER_AREA)
                        _E = img0f - _D
                        if float(np.abs(_E).mean()) < 0.35:
                            break
                        _U += (IBP_LAM * _w) * cv2.resize(_E, (_nw, _nh),
                                                          interpolation=cv2.INTER_LANCZOS4)
                        if IBP_CLAMP:
                            np.clip(_U, _lo, _hi, out=_U)
                    return _U

                # 🧽 เก็บกวาด "คลื่นรบกวน JPEG" ในย่านที่ควรเรียบ ก่อนจะไปยุบขอบ
                #    ถ้าไม่ทำ: รอยด่างจาง ๆ รอบตัวอักษรจะถูกยุบให้ "คมขึ้น" ไปด้วย
                #    กลายเป็นคราบเป็นรูปเป็นร่างในพื้นขาว แล้ว VTracer ก็ไล่เส้นมันออกมาจริง ๆ
                #    ใช้น้ำหนักกลับด้าน (1 - _w) -> ขอบจริงไม่โดนแตะแม้แต่นิดเดียว
                if FLAT_MED >= 3:
                    _fm = cv2.medianBlur(img, int(FLAT_MED) | 1).astype(np.float32)
                    _fw = (1.0 - _w) * float(FLAT_AMT)
                    img = np.clip(img.astype(np.float32) * (1.0 - _fw)
                                  + _fm * _fw, 0, 255).astype(np.uint8)
                    del _fm, _fw
                _U = _ibp(img.astype(np.float32), IBP_ITERS)
                # ⚡ ยุบทางลาดของขอบให้เป็นขั้นบันได (ดูหมายเหตุยาวใน _shock_rgb)
                #    ใช้น้ำหนัก _w ตัวเดียวกับขั้นฉายกลับ -> พื้นไล่สีไม่โดนแตะ
                #
                # 🔗 ทำไมต้องสลับ "ยุบขอบ -> ฉายกลับ" ทีละรอบ ไม่ใช่ยุบรวดเดียวจบ:
                #    วัดจริง (ยุบรวดเดียว) 1 รอบ โลโก้ 5.99 · 2 รอบ 7.83 · 3 รอบ 8.74
                #    เพราะเส้นตัวอักษรบาง ๆ ถูก "ไสให้ผอมลง" เรื่อย ๆ ทุกรอบ — ไหล่ของ
                #    ทางลาดโดนดูดไปเป็นพื้นขาว รอบแล้วรอบเล่า จนเส้นบางกว่าของจริง
                #    การฉายกลับคั่นกลางบังคับเงื่อนไข "ย่อกลับแล้วต้องได้ต้นฉบับ" อีกครั้ง
                #    -> ขอบยังชันขึ้นได้ แต่ความหนา/น้ำหนักหมึกของเส้นถูกดึงกลับที่เดิม
                _pg(18, "ยุบขอบให้เป็นขั้นบันได")
                _img_soft = None
                if VT_SOFT:
                    # 🧊 เก็บภาพ "ก่อนยุบขอบ" ไว้ให้ขั้นไล่เส้นใช้
                    #    ⚠️ ขั้นยุบขอบบังคับให้ทุกพิกเซลเลือกข้าง = ขอบกลายเป็นขั้นบันได
                    #       ระดับพิกเซล VTracer ไล่เส้นตามขั้นบันไดนั้น -> เส้น "ยึกยือ"
                    #       (ผู้ใช้ทัก 2026-08-13: ใบไม้ยึกยือมาก) วัดจริง ยึกยือ 117.9
                    #    ✅ ภาพก่อนยุบขอบยังเก็บ "สัดส่วนสีผสม" ที่ขอบไว้ครบ ซึ่งเป็นข้อมูล
                    #       ระดับย่อยพิกเซล -> ไล่เส้นออกมาได้ทั้งคมและเรียบ
                    #    ส่วนภาพที่ยุบขอบแล้วยังใช้กับเครื่องแปลงหลักเหมือนเดิม
                    _img_soft = np.clip(_U, 0, 255).astype(np.uint8)
                if SHOCK_ITERS > 0:
                    for _ in range(int(SHOCK_ITERS)):
                        _U = _shock_rgb(_U, _w, iters=1, amt=SHOCK_AMT,
                                        sig=SHOCK_SIG, r=SHOCK_R)
                        _U = _ibp(_U, SHOCK_IBP)
                img = np.clip(_U, 0, 255).astype(np.uint8)
                del _U, _w, _lp, _lo, _hi, _ibp
                import gc as _gc9
                _gc9.collect()
            if SHARP_AMT > 0:
                _sg = float(np.clip(edge_ramp_px(img) / 2.6, 0.7, 3.0))
                _bl = cv2.GaussianBlur(img, (0, 0), _sg)
                img = np.clip(img.astype(np.float32) * (1.0 + SHARP_AMT)
                              - _bl.astype(np.float32) * SHARP_AMT, 0, 255).astype(np.uint8)
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
    _ins = None                                    # ย่านพื้น (ขยายขอบแล้ว)
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
                _all = ([b["stops"] for b in _g0["bands"]] if _g0.get("bands")
                        else [_g0["stops"]])
                # ⚠️ อย่าเก็บสีตัวแทนจากทุกแถบ (96 แถบ × 2 = 192 สี!) จานสีจะบวมจนไปแย่ง
                #    พิกเซลของลายจริง — ผู้ใช้เห็นเป็นตัวอักษรเล็กเพี้ยน (วัดได้แย่ลง 13.6 -> 15.4)
                #    เอาแค่พอครอบคลุมช่วงสีของพื้น ~6 แถบ × 4 จุด = 24 สี ก็พอ
                _pick = 6
                if len(_all) > _pick:
                    _idx = [int(round(q * (len(_all) - 1) / (_pick - 1))) for q in range(_pick)]
                    _sets = [_all[q] for q in _idx]
                else:
                    _sets = _all
                _each = max(2, int(round(24.0 / max(1, len(_sets)))))
                for _st in _sets:
                    for _j in range(_each):
                        _o = _j / float(max(1, _each - 1))
                        _lo = max([q for q in _st if q[0] <= _o] or [_st[0]])
                        _hi = min([q for q in _st if q[0] >= _o] or [_st[-1]])
                        _t = 0.0 if _hi[0] <= _lo[0] else (_o - _lo[0]) / (_hi[0] - _lo[0])
                        _anchor.append(tuple(int(round(_lo[1][c] + (_hi[1][c] - _lo[1][c]) * _t))
                                             for c in range(3)))

    # 🎯 โหมดไล่สี: แบ่งโควตาสีตาม "ความสำคัญต่อสายตา" ไม่ใช่ตามจำนวนพิกเซล
    #    (ดูเหตุผลยาวใน detail_weight — โลโก้เล็ก ๆ เคยไม่ได้สีเลยเพราะพิกเซลน้อย)
    _wmap = None
    if grad and _smr and DETAIL_W > 0:
        try:
            _wmap = detail_weight(img, skip=_u_raw)
        except Exception:
            _wmap = None
    pal_rgb, lab, pal_lab = quantize(img, k=cfg["k"], seed=seed, keep=_q_keep,
                                     grad=bool(grad),
                                     kmin=(GRAD_KMIN if _smr else 0),
                                     cap=(GRAD_CAP if _smr else None),
                                     wmap=_wmap)
    # 🍃 รวมเฉดที่เป็นเส้นไล่สีเดียวกัน (พวงหรีดเขียว→ฟ้า) ให้เหลือสีเดียว ก่อนติดป้ายสี
    _ramp = []
    # ⚠️ วัดจริง 2026-08-11 (รอบแรก ตัดสินด้วยระยะสีอย่างเดียว = ล้มเหลว):
    #    เกณฑ์แน่น (ระยะ ≤14) ไม่มีกลุ่มไหนเข้าเกณฑ์เลย · เกณฑ์หลวม (≥16) รวมเลยเถิด
    #    สี 14→9 · ใบไม้ 2.92→3.21 · ทั้งภาพ 2.18→2.39
    # ✅ รอบสอง 2026-08-11 ทำครบตามแผน "ติดป้ายสี -> วัดการติดกันจริงในภาพ -> รวม -> ติดป้ายใหม่"
    #    (โค้ดอยู่ครบด้านบน: spatial_adj + merge_ramp(adj=..., solid=...) ใช้งานได้จริง)
    # ⛔ แต่ **วัดแล้วแย่ลงทุกทาง** จึงปิดไว้ — ตัวเลขจริงจากภาพตรา USERS' CHOICE:
    #       ฐาน (ไม่รวม)             โลโก้ 12.69 · ใบไม้ 2.92 · ทั้งภาพ 2.18 · 14 สี · 23,182 จุด
    #       รวม + ไล่สีเส้นตรง        โลโก้ 17.53 · ใบไม้ 3.21 · ทั้งภาพ 2.39 ·  9 สี · 18,714 จุด
    #       รวม + บังคับไล่สีสองมิติ  โลโก้ 17.53 · ใบไม้ 4.64 · ทั้งภาพ 2.91 (ฟิตไม่เข้า -> สีแบน)
    # 🔍 สาเหตุที่แก้ไม่ได้ที่ชั้น "จานสี" (พิสูจน์ด้วยภาพเทียบแล้ว):
    #    (1) พวงหรีดเป็น "วงแหวน" สีไล่ไปตามส่วนโค้ง ไม่มีไล่สีมาตรฐานของ SVG
    #        (เส้นตรง/วงกลม/แถบสองมิติ) ที่ฟิตวงแหวนได้ — ค่าคลาดที่ดีที่สุดคือ 7.7
    #        ซึ่งแย่กว่าการปล่อยให้เป็น 6 เฉดแยกกันเสียอีก
    #    (2) สี (54,187,98) ถูกใช้ร่วมกันระหว่าง "ปลายเขียวของพวงหรีด" กับ
    #        "สี่เหลี่ยมเขียวตันของโลโก้ LINEMAN" — พอรวมเป็นเฉดไล่สี สี่เหลี่ยมนั้นเปลี่ยนสีทันที
    #        (ลองกันด้วยตัวตรวจ "ก้อนตัน" แล้ว แยกไม่ออก เพราะเป็นป้ายสีเดียวกันจริง ๆ)
    # ➡️ ถ้าจะเอาให้ได้จริง ต้องแยกป้ายสีตาม "ชิ้นส่วนในภาพ" ก่อน (คนละสีแม้ค่าสีเท่ากัน)
    #    ซึ่งขั้นติดป้ายสี (nearest2) ปัจจุบันแสดงแทนไม่ได้ — เป็นงานรื้อโครงสร้างอีกชั้น
    if grad and len(pal_lab) >= 4 and False:
        try:
            _dsm = int(max(1, round(max(H, W) / 450.0)))
            _lb0 = nearest2(np.ascontiguousarray(lab[::_dsm, ::_dsm]), pal_lab)[2]
            _adj, _sol = spatial_adj(_lb0, len(pal_lab),
                                     keep=(None if _q_keep is None else _q_keep[::_dsm, ::_dsm]))
            pal_lab, pal_rgb, _ramp = merge_ramp(pal_lab, pal_rgb, adj=_adj, solid=_sol)
            del _lb0, _adj, _sol
        except Exception:
            _ramp = []
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
            # ⚠️ ย่านนี้ต้อง "แคบ" (ผู้ใช้เจอจริง 2026-08-10): ถ้ากว้างไป สีตัวแทนพื้นจะไปชนะ
            #    พิกเซลของใบไม้ที่อยู่ชิดขอบวง -> เกิด "ปื้นสีน้ำเงินหลุด" กลางใบ
            #    วัดจริง: 9 px -> 5 px ค่าคลาดโลโก้ 14.7->12.2 · ใบไม้ 3.9->3.4 · ทั้งภาพ 2.9->2.6
            _rr2 = int(max(3, round(max(H, W) / 900.0))) | 1
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
    # 🔎 โหมดไล่สี: ลดเกณฑ์ "ชิ้นเล็กสุดที่ยอมเก็บ" ลง เพื่อไม่ให้ตัวอักษรจิ๋วหายไป
    #    (โลโก้ wongnai ในไฟล์ 554 px สูงจริงแค่ ~9 px เส้นหนา 1 px)
    if grad:
        min_a *= 0.45
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
                _gl9 = {
                    "rgb": tuple(int(v) for v in _mid), "n": int(_rg["n"]),
                    "area": sum(abs(_area(c)) for c in _cs),
                    "items": to_bezier(grow(_cs, gap_e), tol_e, budget=budget_e),
                    "grad": _rg["grad"]}
                # 🤝 เผื่อโหมดผสม VTracer: เตรียม "รูปทรงยืดขอบ" ไว้อีกชุด (เข้าใต้ขอบงาน ~10px)
                #    ชั้นลาย VTracer ไม่ถมแถบรอบขอบงานเหมือนชั้นลายเดิม ต้องให้พื้นมุดเข้าไปปิดแทน
                #    ⚠️ ใช้เฉพาะเมื่อ VTracer ชนะจริงเท่านั้น — ชุดปกติห้ามยืด (วัดแล้ว
                #    ใบไม้พัง 2.96→5.12 เพราะพื้นที่ยืดออกไปโผล่รอบขอบลายเดิม)
                if VT_MIX and grad:
                    try:
                        _rq9 = int(max(3, round(max(H, W) / 150.0))) | 1
                        _shv = cv2.dilate(_rg["shape"].astype(np.uint8),
                                          np.ones((_rq9, _rq9), np.uint8)).astype(bool)
                        _fv = cv2.GaussianBlur(_shv.astype(np.float32), (0, 0), 0.8)
                        _csv = [c for c in contours_of(_fv, 0.5, smooth_k=2, sigma=0.0)
                                if abs(_area(c)) >= min_a]
                        if _csv:
                            _gl9["_items_v"] = to_bezier(grow(_csv, gap_e), tol_e,
                                                         budget=budget_e)
                    except Exception:
                        pass
                grad_layers.append(_gl9)
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
            # ⚠️ ยังเหลือ "ชิ้นหลง" เกาะอยู่บนพื้น ตรงแถบรอบขอบงาน (ผู้ใช้วงไว้ 2026-08-10)
            #    แถบนั้นไม่ได้ถูกนับเป็นพื้น สีของลายจึงลงไประบายได้ กลายเป็นปื้น/ใบไม้ปลอม
            # ✅ ตัด "ทีละชิ้น": ชิ้นไหนอยู่ในย่านพื้น (ขยายขอบแล้ว) เกิน 85% = ไม่ใช่ลายจริง
            #    ลายจริงเช่นใบไม้จะยื่นเข้าไปในตัวงานลึก จึงไม่มีทางเข้าเกณฑ์นี้
            try:
                _nc, _lb, _stt, _ = cv2.connectedComponentsWithStats(
                    np.ascontiguousarray((_mi & ~_sup).astype(np.uint8)), 8)
                if _nc > 1:
                    _bad = []
                    for _c in range(1, _nc):
                        _ar = float(_stt[_c, cv2.CC_STAT_AREA])
                        if _ar < 4 or _ar > 0.02 * H * W:
                            continue
                        _cm = (_lb == _c)
                        if _ins is None:
                            break
                        if float((_cm & _ins).sum()) / _ar >= 0.85:
                            _bad.append(_c)
                    if _bad:
                        _sup = _sup | np.isin(_lb, np.array(_bad, np.int32))
            except Exception:
                pass
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
                                   max_pieces=_mp, fine_below=(420 if grad else 0),
                                   level=(ink_level(f) if (grad and INK_LEVEL) else 0.5))
        # 🕳️ คัดเฉพาะ 'รูปลอม' ออก โดยดูความมั่นใจ ไม่ใช่ขนาด (ดู drop_fake_holes)
        _fd9 = denoise_field(f, sg)
        cs = drop_fake_holes(_fd9, cs)
        # 🧹 โหมดไล่สี: เกณฑ์ชิ้นเล็กถูกลดลง 55% เพื่อเก็บตัวอักษรจิ๋ว
        #    -> ต้องกรอง "จุดด่างจากรอยบีบอัด" ออกด้วย ไม่งั้นได้ปื้นเทาโผล่บนพื้นขาว
        if grad:
            cs = drop_weak_specks(_fd9, cs, min_a / 0.45)
            # 🪒 ตัด "เส้นริ้วบาง" ทิ้ง — ชิ้นที่ยาวแต่บางกว่าเส้นจริงในงาน
            #    เกิดจากขอบเว่อร์เล็ก ๆ ตรงรอยต่อสองสีจัด แล้วถูกจับเป็นสีที่สามบาง ๆ
            #    (ผู้ใช้จะเห็นเป็น "เส้นเขียวอมฟ้า" เลียบขอบวงกลมขาวกับพื้นน้ำเงิน)
            #    ความหนาเฉลี่ยของรูปปิด ≈ 2·พื้นที่/เส้นรอบรูป — เส้นจริงบางสุดยังหนากว่านี้มาก
            if SLIVER_W > 0:
                _cs2 = []
                for _c in cs:
                    _pa = abs(_area(_c))
                    _pe = float(np.abs(np.diff(np.vstack([_c, _c[:1]]), axis=0)).sum())
                    if _pe > 1e-6 and (2.0 * _pa / _pe) < SLIVER_W * max(1.0, sc)                        and _pa < min_a * 40.0:
                        continue
                    _cs2.append(_c)
                cs = _cs2
        if not cs:
            continue
        sig_used.append(sg)
        area = sum(abs(_area(c)) for c in cs)
        # 🩹 มีพื้นไล่สีอยู่ข้างล่าง -> ช่องว่างเศษพิกเซลจะเผยสีจัด ๆ ขึ้นมา ต้องเกยกันมากขึ้น
        _ge = gap_e * (GRAD_GAP if grad_layers else 1.0)
        _Lr = {"rgb": tuple(int(v) for v in pal_rgb[i]), "n": n, "area": area,
               "items": to_bezier(grow(cs, _ge + 0.35 * sg), tol_e,
                                  look=int(max(6, round(2.5 * sg) + 5)),
                                  budget=budget_e)}
        # 🌈 โหมดไล่สี: หาไล่สีเชิงเส้นของก้อนนี้ (ไม่มี = ก้อนสีแบน ใช้ fill เดียวเหมือนเดิม)
        if grad:
            _m = (labels == i) if keep is None else ((labels == i) & keep)
            # ก้อนรายละเอียดใช้จุดสีน้อยกว่า (12) — ก้อนเล็ก ไม่ต้องละเอียดเท่าพื้น
            # 🍃 ลายที่ไล่สีในตัวเอง (เช่นพวงหรีดเขียว->ฟ้า) ต้องใช้ไล่สีสองมิติด้วย
            #    ไม่งั้น k-means จะซอยเป็นหลายเฉด แล้วเกิด "สีหลุด" เป็นปื้นกลางใบ
            # ⚠️ อย่าเปิดไล่สีสองมิติให้ชั้นลาย — ทดสอบ 2 รอบแล้วแย่ลงทั้งคู่
            #    (ใบไม้ 2.91→3.40 · ทั้งภาพ 2.19→2.43) ชั้นลายเป็นก้อนเล็ก แบบจำลองไล่สีจับเสียงรบกวน
            # 🍃 ชั้นที่เกิดจากการ "รวมเฉดไล่สี" -> ต้องได้ไล่สีจริง (ก้อนใหญ่ ฟิตแม่น)
            #    ชั้นสีเดียวธรรมดายังใช้ค่าเดิม (ไล่สีทางเดียว 12 จุด) เหมือนเดิมทุกประการ
            # 🍂 ฟิตจาก "เนื้อใน" เท่านั้น — กร่อนขอบทิ้งก่อน 1-2 px
            #    พิกเซลขอบเป็นสีผสม (ใบ×พื้นขาว = เขียวซีด) ถ้าปล่อยเข้าไป
            #    ไล่สีของใบจะถูกลากให้ "ปลายใบซีด" เห็นเป็นปื้นจาง ๆ ที่ปลายใบทุกใบ
            if GRAD_CORE_FIT:
                _er9 = int(max(1, round(max(H, W) / 900.0)))
                _mc = cv2.erode(_m.astype(np.uint8),
                                np.ones((2 * _er9 + 1,) * 2, np.uint8)).astype(bool)
                if int(_mc.sum()) >= 400:
                    _m = _mc
            if i in _ramp:
                _g = fit_gradient_field(img, _m, seed=seed, ns=RAMP_FIT["ns"],
                                        min_delta=6.0, max_err=RAMP_FIT["err"],
                                        max_bands=RAMP_FIT["bands"])
            else:
                _g = fit_gradient_field(img, _m, seed=seed, ns=12, min_delta=10.0,
                                        max_err=5.0, max_bands=1)
            if _g:
                _Lr["grad"] = _g
        layers.append(_Lr)
    layers.sort(key=lambda L: -L["area"])           # ใหญ่ก่อน = ซ้อนทับ ไม่มีช่องว่าง
    if grad_layers:                                 # 🌈 พื้นไล่สีต้องอยู่ล่างสุดเสมอ
        grad_layers.sort(key=lambda L: -L["area"])
        layers = grad_layers + layers

    # ══════════════════════════════════════════════════════════════
    # 🤝 โหมดผสม (ผู้ใช้สั่ง 2026-08-11): เอาจุดแข็งของปุ่ม ".ai ให้กราฟิค" (VTracer —
    #    โลโก้คม ใบไม้ครบ) มาแทน "ชั้นลายเส้น" ของโหมดไล่สี ส่วน "พื้นไล่สี" ยังใช้
    #    ตาข่ายไล่สีสองมิติของเราซึ่งทำได้ดีอยู่แล้ว = ได้ข้อดีของทั้งสองปุ่มในไฟล์เดียว
    #
    # วิธี: ทาสีมาสก์พิเศษ (magenta) ทับย่านพื้นไล่สี แล้วส่งภาพให้ VTracer ไล่เส้น
    #    - แผ่น magenta เต็มจอถูกตัวกรอง "แผ่นพื้นหลัง" ของ trace_engine ทิ้งเอง
    #    - เศษสีที่เปื้อน magenta (ขอบเกลี่ยขาว↔magenta ที่ริมวง) คัดทิ้งด้วยกติกาสี
    #    - พิกัด VTracer อยู่บนภาพที่มันขยายเป็น 2000 px เอง -> คูณกลับเป็นพิกัดภาพทำงาน
    #    ชั้นที่ได้วางตามลำดับซ้อนของ VTracer (ห้าม sort ตามพื้นที่ — ลำดับคือการซ้อนทับจริง)
    # 🔒 ทำเฉพาะโหมดไล่สี + ภาพไม่มีช่องโปร่ง · พังเมื่อไหร่ถอยกลับชั้นลายเดิมอัตโนมัติ
    # ══════════════════════════════════════════════════════════════
    _vt_used = False
    if grad and VT_MIX and keep is None:
        try:
            # ⚠️ ห้ามใส่ import ของ vectorcnc.trace_engine ตรงนี้อีก — _vt_items เรียก
            #    vtracer เองโดยตรง ไม่ได้ใช้ trace_engine เลย แต่ถ้า import แล้วพัง
            #    (เช่นสภาพแวดล้อมไหนไม่มีแพ็กเกจนั้น) except ด้านล่างจะกลืนทั้งบล็อก
            #    -> โหมดผสม VTracer ปิดเงียบ ๆ ทั้งก้อน โดยไม่มีใครรู้
            _im9 = np.ascontiguousarray(
                _img_soft if (VT_SOFT and _img_soft is not None
                              and _img_soft.shape == img.shape) else img)
            # 〰️ เกลี่ยบาง ๆ เฉพาะภาพที่ส่งให้ขั้นไล่เส้น (ไม่แตะเครื่องแปลงหลัก)
            # ⚠️ ผู้ใช้ทัก 2026-08-13: "ใบไม้ยึกยือมาก" · ขอบวงกลมขาวเป็นปุ่ม ๆ ไม่กลม
            #    ต้นเหตุ: ขั้นยุบขอบบังคับทุกพิกเซลให้เลือกข้าง ขอบจึงเป็น "ขั้นบันได"
            #    ระดับพิกเซลเป๊ะ ๆ แล้ว VTracer ไล่เส้นตามขั้นบันไดนั้นออกมาตรง ๆ
            #    ลองป้อนภาพก่อนยุบขอบแทน -> เรียบขึ้นจริง (ยึกยือ 117.9 -> 88.3)
            #    แต่หัวข้อพังยับ (4.54 -> 7.48) เพราะเสียความคมที่อุตส่าห์ทำมา
            # ✅ ทางที่ได้ทั้งสองอย่าง: ยุบขอบให้ "เลือกข้างถูก" ก่อน แล้วเกลี่ยกลับบาง ๆ
            #    ความชันของขอบยังสูงอยู่ (กว้าง ~1 px) แต่ตำแหน่งขอบกลับมาต่อเนื่อง
            #    ไม่กระโดดทีละพิกเซล -> เส้นที่ไล่ออกมาจึงเรียบ โดยไม่เสียความคม
            if VT_BLUR > 0:
                _im9 = cv2.GaussianBlur(_im9, (0, 0), float(VT_BLUR))
            _MK_C = None
            if _u_raw is not None:
                # 🩷 ทาสีมาสก์ทับ "เนื้อใน" ของพื้นไล่สี (ไม่แตะแถบรอบขอบงาน ~8-10 px)
                #    - VTracer ไม่ต้องเสียโควตาสีให้พื้นรุ้ง -> ลาย/โลโก้ได้สีเต็ม ๆ (วัดจริง
                #      โลโก้ 11.98 -> ~6.9 ต่างกันเกือบเท่าตัว)
                #    - ขอบงานยังถูกไล่เส้นกับพิกเซลจริง -> ขอบวงกลมเรียบตามต้นฉบับ
                #      (เคยทามาสก์ทับถึงขอบ -> ขอบวงเป็นขั้นบันไดตามรอยหยักของมาสก์)
                #    เศษแถบรอบขอบที่เหลือ ถูกกติกา "ส่วนที่มองเห็นจมในย่านพื้น" ตัดทิ้งเอง
                # ขยายถึงใต้ขอบงานด้วยหัวกลม + เกลาขอบมาสก์ให้เป็นเส้นโค้งเรียบ
                # (มาสก์ดิบขอบหยึกหยัก -> VTracer จะลอกรอยหยักนั้นไปเป็นขอบงานจริง)
                _rq8 = int(max(3, round(max(H, W) / 220.0))) | 1
                _mk9 = cv2.dilate(_u_raw.astype(np.uint8),
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_rq8, _rq8)))
                _mk9 = (cv2.GaussianBlur(_mk9.astype(np.float32), (0, 0),
                                         max(1.5, _rq8 / 3.0)) > 0.5)
                # 🎯 สีมาสก์ต้องเป็นสีที่ "ไม่มีอยู่ในภาพนี้เลย" — เดิมตั้งตายตัวเป็นม่วงแดง
                #    ผลคือขอบมาสก์ถูก VTracer ไล่เส้นออกมาเป็นชั้นสีม่วงแดงจริง ๆ แล้วโผล่
                #    เป็นเส้นม่วงบาง ๆ ตรงมุมภาพ (เห็นชัดขึ้นมากหลังใส่ขั้นยุบขอบ เพราะ
                #    ขอบมาสก์ก็ถูกทำให้คมไปด้วย) จึงเลือกจากมุมลูกบาศก์สีที่ไกลจากสีในภาพสุด
                _sm9 = img[::7, ::7].reshape(-1, 3).astype(np.float32)
                _cand9 = [(255, 0, 255), (0, 255, 0), (0, 255, 255), (255, 0, 0),
                          (0, 0, 255), (255, 255, 0)]
                _MK_C = max(_cand9, key=lambda c: float(
                    np.abs(_sm9 - np.float32(c)).sum(1).min()))
                del _sm9
                _im9 = _im9.copy(); _im9[_mk9] = _MK_C
            _pg(55, "ไล่เส้นลายละเอียด")
            _its9 = _vt_items(_im9, px=(VT_PX if VT_PX > 0 else _vtpx),
                              progress=(lambda p, t: _pg(55 + int(p * 0.25), t)),
                              cp=VT_OPTS["color_precision"],
                              lth=VT_OPTS.get("length_threshold", 4.0),
                              spl=VT_OPTS.get("splice_threshold", 45),
                              ld=VT_OPTS["layer_difference"],
                              spk=VT_OPTS["filter_speckle"],
                              cor=VT_OPTS["corner_threshold"],
                              pp=VT_OPTS["path_precision"], bilat=VT_BILAT)
            _f9 = 1.0                              # _vt_items คืนพิกัดสเกลภาพทำงานมาแล้ว
            # ย่านพื้นไล่สี (ขยายถึงใต้ขอบงาน) สำหรับตัดสินว่า path ไหนคือ "แถบสีของพื้น"
            _ds9 = 4
            _bg9 = None
            if _u_raw is not None:
                _rq8 = int(max(3, round(max(H, W) / 220.0))) | 1
                _bg9 = cv2.dilate(_u_raw.astype(np.uint8),
                                  np.ones((_rq8, _rq8), np.uint8))[::_ds9, ::_ds9].astype(bool)
            _newL = []
            _pend9 = []                              # (layer, rings) รอตัดสินว่าเป็นแถบพื้นไหม
            for _col9, _subs9 in _its9:
                _b9, _g9, _r9c = int(_col9[0]), int(_col9[1]), int(_col9[2])
                # 🚫 ทิ้งชั้นที่เป็น "สีมาสก์" (และสีที่เพี้ยนออกมาจากขอบมาสก์เล็กน้อย)
                #    ไม่งั้นจะได้เส้นสีแปลกปลอมทับงานจริง
                if _MK_C is not None and (abs(_r9c - _MK_C[0]) + abs(_g9 - _MK_C[1])
                                          + abs(_b9 - _MK_C[2])) <= MASK_DROP_D:
                    continue
                _itl9 = []
                _ar9 = 0.0
                _rings9 = []
                for _sp9 in _subs9:
                    _st9 = (float(_sp9["start"][0]) * _f9, float(_sp9["start"][1]) * _f9)
                    _sg9 = []
                    _pts9 = [_st9]
                    for _s9 in _sp9["segs"]:
                        if _s9[0] == "L":
                            _e9 = (float(_s9[1][0]) * _f9, float(_s9[1][1]) * _f9)
                            _sg9.append(("L", _e9))
                        else:
                            _e9 = (float(_s9[3][0]) * _f9, float(_s9[3][1]) * _f9)
                            _sg9.append(("C",
                                         (float(_s9[1][0]) * _f9, float(_s9[1][1]) * _f9),
                                         (float(_s9[2][0]) * _f9, float(_s9[2][1]) * _f9),
                                         _e9))
                        _pts9.append(_e9)
                    if len(_sg9) < 2:
                        continue
                    _a9 = 0.0
                    for _q9 in range(len(_pts9) - 1):
                        _a9 += (_pts9[_q9][0] * _pts9[_q9 + 1][1]
                                - _pts9[_q9 + 1][0] * _pts9[_q9][1])
                    _ar9 += abs(_a9) * 0.5
                    _itl9.append(("B", _st9, _sg9))
                    _rings9.append(np.round(np.asarray(_pts9, np.float64) / _ds9)
                                   .astype(np.int32))
                if not _itl9:
                    continue
                _pend9.append(({"rgb": (_r9c, _g9, _b9), "n": int(max(1, _ar9)),
                                "area": float(_ar9), "items": _itl9}, _rings9))
            # 🗑️ ตัด "แถบสีแบนของพื้น" ที่พื้นไล่สีของเราแทนที่ไปแล้ว
            #    VTracer วางชั้นแบบซ้อนทับ (ชั้นล่างไม่มีรู) -> ต้องดูเฉพาะ "ส่วนที่มองเห็นจริง"
            #    ของแต่ละชั้น (ส่วนที่ไม่ถูกชั้นบนทับ): ไล่จากบนลงล่าง สะสมย่านที่ถูกทับไว้
            #    ชั้นไหนส่วนที่มองเห็นจมในย่านพื้น ≥85% (หรือมองไม่เห็นเลย) = แถบพื้น ทิ้ง
            if _bg9 is not None and _pend9:
                _cov9 = np.zeros(_bg9.shape, bool)
                _drop9 = [False] * len(_pend9)
                for _q9 in range(len(_pend9) - 1, -1, -1):
                    _acc9 = np.zeros(_bg9.shape, bool)
                    for _rg9 in _pend9[_q9][1]:
                        _t9 = np.zeros(_bg9.shape, np.uint8)
                        cv2.fillPoly(_t9, [_rg9], 1)
                        _acc9 ^= _t9.astype(bool)
                    _vis9 = _acc9 & ~_cov9
                    _cov9 |= _acc9
                    _nv9 = int(_vis9.sum())
                    # ⚠️ ชิ้นจิ๋ว (ตัวอักษร wongnai) เล็กกว่าตะแกรงย่อ 4x -> ราสเตอร์ได้ 0 ช่อง
                    #    ห้ามถือว่า "มองไม่เห็น" แล้วทิ้ง (เคยทิ้ง โลโก้พัง 6.9 -> 12.0)
                    #    ตัดสินได้เฉพาะชิ้นที่มีเนื้อบนตะแกรงจริง ≥ 4 ช่องเท่านั้น
                    if _nv9 >= 4:
                        if int((_vis9 & _bg9).sum()) >= 0.85 * _nv9:
                            _drop9[_q9] = True
                    elif int(_acc9.sum()) >= 4:
                        if int((_acc9 & _bg9).sum()) >= 0.85 * int(_acc9.sum()):
                            _drop9[_q9] = True
                _newL = [_pend9[_q9][0] for _q9 in range(len(_pend9)) if not _drop9[_q9]]
            else:
                _newL = [_z9[0] for _z9 in _pend9]
            # 🧵 รวมชั้น "สีเดียวกันที่อยู่ติดกันในลำดับซ้อน" เป็นชั้นเดียว
            #    (ปลอดภัยต่อการซ้อนทับ 100% — สลับเฉพาะชิ้นที่ไม่มีใครคั่นกลาง)
            #    VTracer คืนมาเป็นพัน path จำนวนชั้นจะบวมโดยไม่จำเป็น
            if _newL:
                _mg9 = [_newL[0]]
                for _L9 in _newL[1:]:
                    if _L9["rgb"] == _mg9[-1]["rgb"]:
                        _mg9[-1]["items"].extend(_L9["items"])
                        _mg9[-1]["area"] += _L9["area"]
                        _mg9[-1]["n"] += _L9["n"]
                    else:
                        _mg9.append(_L9)
                # ⚖️ ตัดสินด้วยการวัด ไม่ใช่เดา: เรนเดอร์ทั้งสองแบบแล้วเทียบกับภาพจริง
                #    - ลายเส้นสีแบน (โลโก้/ตราจริง)  -> VTracer ชนะขาด (วัดจริง โลโก้ 10.7->6.9)
                #    - ลายที่ "ไล่สีในตัวเอง" (พวงหรีดไล่เฉด) -> VTracer หั่นเป็นแถบแบน แพ้ชัด
                #      (วัดจริงกับภาพทดสอบ: ทั้งภาพ 2.29 -> 4.19 แย่เกือบเท่าตัว)
                #    จึงต้องลองทั้งคู่แล้วเลือกตัวที่คลาดน้อยกว่าจริง (+~8 วิ แลกกับไม่พลาดเลย)
                try:
                    import vectora_export as _VX9
                except Exception:
                    from . import vectora_export as _VX9
                def _err9(_ly9):
                    # 🧠 วาดด้วยตัววาดของเราเอง ไม่ผ่าน cairosvg
                    #    เดิมสร้างสตริง SVG ~9 MB แล้วให้ cairosvg กางเป็นวัตถุ Python
                    #    ทั้งก้อน — ทำสองรอบ (ของเก่า/ของใหม่) แค่เพื่อ "ให้คะแนน" เท่านั้น
                    #    แรมพุ่งจนเครื่องจริงถูกฆ่าโปรเซส (ผู้ใช้เจอ 2026-08-13:
                    #    หน้าเว็บขึ้น "Unexpected token '<'" = ได้หน้า error HTML กลับมา)
                    # 🏃 ให้คะแนนที่ภาพเล็กลงครึ่งหนึ่ง — ขั้นนี้แค่ "เทียบว่าแบบไหนตรงกว่า"
                    #    ไม่ได้เอาภาพไปใช้ต่อ · วัดจริงบนเครื่อง 2 CPU: 22.0 วิ -> 6.5 วิ
                    #    (ต้องวาดสองรอบ ของเก่า/ของใหม่ จึงคุ้มมาก) ผลตัดสินไม่เปลี่ยน
                    _sc9 = 280.0 / max(W, H)
                    _pg9 = _VX9.raster_png({"layers": _ly9, "size": (W, H), "bg": None,
                                            "stats": {}}, px_scale=_sc9)
                    _o9 = cv2.imdecode(np.frombuffer(_pg9, np.uint8), cv2.IMREAD_COLOR)
                    _rf9 = cv2.resize(cv2.cvtColor(img, cv2.COLOR_RGB2BGR),
                                      (_o9.shape[1], _o9.shape[0]))
                    _L1 = cv2.cvtColor(_o9, cv2.COLOR_BGR2LAB).astype(np.float32)
                    _L2 = cv2.cvtColor(_rf9, cv2.COLOR_BGR2LAB).astype(np.float32)
                    return float(np.sqrt(((_L1 - _L2) ** 2).sum(2)).mean())
                _glv9 = [dict(_g9x, items=_g9x.get("_items_v", _g9x["items"]))
                         for _g9x in grad_layers]
                for _g9x in _glv9:
                    _g9x.pop("_items_v", None)
                _pg(82, "ให้คะแนนแล้วเลือกแบบที่ดีกว่า")
                _eo9 = _err9(layers)
                _en9 = _err9(_glv9 + _mg9)
                if _en9 <= _eo9 * 0.97:
                    layers = _glv9 + _mg9
                    _vt_used = True
        except Exception:
            pass                                    # VTracer ไม่พร้อม -> ใช้ชั้นลายเดิม
    for _L in layers:
        _L.pop("_items_v", None)
    # ขยายพิกัดคืนขนาดจริง
    _pg(88, "ปรับพิกัดกลับขนาดจริง")
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
                for _bd in (g.get("bands") or []):
                    for _kx in ("s0", "s1"):
                        if _kx in _bd:
                            _bd[_kx] = round(float(_bd[_kx]) * inv, 2)

    bg = None
    if not want_alpha and layers:
        # ⚠️ เมื่อมีพื้นไล่สี ห้ามใช้สีของมันเป็นสีรองพื้น
        #    ช่องว่างระดับเศษพิกเซลระหว่างชั้นจะกลายเป็นริ้วสีฉูดฉาด
        #    ใช้สีของชั้นลายที่ใหญ่ที่สุดแทน (มักเป็นพื้นขาวของตัวงาน) ริ้วจึงมองไม่เห็น
        _pool = [L for L in layers if L not in grad_layers] or layers
        bg = max(_pool, key=lambda L: L["n"])["rgb"]

    nodes = sum(len(it[2]) if it[0] == "B" else len(it[1]) for L in layers for it in L["items"])
    # 🤝 ชั้นลายจาก VTracer มาเป็นพัน path (ซ้อนสีสลับกัน) — จำนวน "สี" ที่คนอยากรู้
    #    คือสีไม่ซ้ำ ไม่ใช่จำนวนชั้น (2,476 ชั้น แต่สีจริง ~30)
    stats = {"colors": (len(set(tuple(L["rgb"]) for L in layers)) if _vt_used else len(layers)), "shapes": sum(len(L["items"]) for L in layers),
             "nodes": int(nodes), "work_px": [W, H], "scale": round(sc, 4),
             "full_res": bool(sc == 1.0),
             # 🧠 แรมที่เครื่องมีจริง + คุณภาพที่เลือกให้พอดีเครื่อง — ไว้ตรวจตอนมีปัญหา
             #    (ถ้าค่านี้ขึ้น 512 ทั้งที่จ่ายแพลน Pro แปลว่าแพลนถูกลดกลับจริง)
             "mem_mb": int(mem_limit_mb()), "work_long": int(_wl), "trace_px": int(_vtpx),
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
