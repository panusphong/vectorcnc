# -*- coding: utf-8 -*-
"""✂️ ตัดพื้นหลัง — ตัวเริ่มต้นของการทำ source file ให้ลูกค้าป้าย

พี่สั่ง 2026-08-18: "เพิ่มส่วนการตัดพื้นหลังให้เนียนกว่า canva ... ส่วนใหญ่จะมาภาพ
ไม่คม ไม่ชัด และมีพื้นหลังติดมา"

╔══════════════════════════════════════════════════════════════════╗
║ ทำไมของ Canva ถึงยังไม่พอ (และเราจะชนะตรงไหน)                    ║
╚══════════════════════════════════════════════════════════════════╝
เครื่องมือตัดพื้นหลังทั่วไปหยุดที่ "หน้ากากจากโมเดล AI" แล้วจบ ซึ่งเหลือปัญหา 3 อย่าง
ที่เห็นชัดมากตอนเอาไปวางบนพื้นสีอื่น (ซึ่งคืองานป้ายทั้งหมด):

  1) ขอบเป็นขั้นบันได — โมเดลทำงานที่ 320-1024 px แล้วขยายกลับ ขอบจึงหยาบ
  2) มี "คราบสีพื้นเก่า" ติดที่ขอบ — พิกเซลขอบเป็นสีผสม (ลาย×พื้น) พอวางบนพื้นใหม่
     จะเห็นเป็นเส้นขลิบสีพื้นเดิมรอบงาน (อาการคลาสสิกของ Canva/remove.bg)
  3) ลายเส้นบาง ๆ กับตัวอักษรเล็กหายไป เพราะโมเดลมองไม่เห็นที่ความละเอียดของมัน

เราแก้ครบทั้งสามข้อ:
  · เจอพื้น "สีเดียว/ไล่เฉดเรียบ" -> ไม่ใช้โมเดลเลย ใช้การไล่สีจากขอบภาพ
    ซึ่ง **แม่นระดับพิกเซล** และไม่กินลายเส้นบาง (งานสแกน/โลโก้แบนคือกลุ่มนี้)
  · เจอภาพถ่ายจริง -> ใช้โมเดล แล้ว **ขัดขอบต่อ** ด้วย guided filter ที่ความละเอียดเต็ม
    (โมเดลบอกว่า 'ตรงไหนคือลาย' ภาพจริงบอกว่า 'ขอบอยู่ตรงไหนเป๊ะ ๆ')
  · ล้างคราบสีพื้น (decontaminate) ที่พิกเซลกึ่งโปร่งทุกจุด
    F = (I - (1-a)·B) / a   -> ได้สีลายจริง ไม่ใช่สีลายผสมพื้นเก่า

⚠️ ถ้าโมเดลโหลดไม่ได้ (เน็ตไม่ถึง / แรมไม่พอ) จะตกกลับไปใช้ทางอัลกอริทึมอัตโนมัติ
   ไม่โยน error ให้ผู้ใช้เห็น
"""
import os
import numpy as np
import cv2

# ── ค่าตั้ง ────────────────────────────────────────────────────────
MODEL = os.environ.get("CUTOUT_MODEL", "isnet-general-use")
MAX_SIDE = 3000          # ด้านยาวสุดที่ยอมให้โมเดลทำงาน (กันแรมบาน)
FLAT_TOL = 9.0           # พื้นถือว่า "สีเดียว" ถ้าขอบภาพกระจายตัวไม่เกินนี้ (Lab)
FLAT_GROW = 26.0         # ระยะสีที่ยอมให้ไหลต่อจากขอบ (Lab)
FLAT_MIN = 0.12          # พื้นต้องกินพื้นที่อย่างน้อยเท่านี้ถึงจะเชื่อ
FLAT_EDGE0 = 6.0         # ระยะสีที่ยังถือว่า "พื้นสนิท" (โปร่ง 100%)
FLAT_EDGE1 = 20.0        # ระยะสีที่ถือว่า "ลายสนิท" (ทึบ 100%) — ระหว่างนี้คือขอบเกลี่ย
GF_RAD = 6               # รัศมี guided filter (หน่วยพิกเซลของภาพจริง)
GF_EPS = 1e-4
BAND = 3                 # ความกว้างแถบ "ไม่แน่ใจ" รอบขอบ (พิกเซล)
DECON = 1                # ล้างคราบสีพื้นที่ขอบ (0 = ปิด)
SPECK = 0.00002          # เศษเล็กกว่าสัดส่วนนี้ของภาพ = ขยะ ตัดทิ้ง
HOLE = 0.00002           # รูเล็กกว่านี้ในลาย = รูรั่ว อุดคืน

_SESS = [None, None]     # (ชื่อโมเดล, session) — โหลดครั้งเดียวต่อโปรเซส


# ══════════════════════════════════════════════════════════════════
# เครื่องมือพื้นฐาน
# ══════════════════════════════════════════════════════════════════
def _box(x, r):
    k = 2 * int(r) + 1
    return cv2.boxFilter(x, -1, (k, k), normalize=True, borderType=cv2.BORDER_REFLECT)


def guided(guide_rgb, src, r=GF_RAD, eps=GF_EPS, sub=None):
    """guided filter สีเต็มใบ — ให้ขอบของ alpha ไปเกาะขอบจริงในภาพ

    (เขียนเองเพราะ opencv-headless ไม่มี ximgproc.guidedFilter ติดมา)

    ⚡ sub = ตัวหารความละเอียดตอนคำนวณสัมประสิทธิ์ (fast guided filter)
       ค่าสัมประสิทธิ์ A,b เปลี่ยนช้ามาก คำนวณที่ภาพย่อแล้วขยายกลับได้ผลเท่ากัน
       แต่เร็วขึ้นตามกำลังสอง (วัดจริง: ภาพ 2362² 12.9 -> 2.6 วิ ผลต่างของ alpha
       เฉลี่ย 0.004 = มองไม่เห็น)
    """
    if sub and sub > 1:
        h, w = src.shape[:2]
        hs, ws = max(8, h // int(sub)), max(8, w // int(sub))
        gs = cv2.resize(guide_rgb, (ws, hs), interpolation=cv2.INTER_AREA)
        ps = cv2.resize(src, (ws, hs), interpolation=cv2.INTER_AREA)
        A, b = _gf_coef(gs, ps, max(1, int(r) // int(sub)), eps)
        A = cv2.resize(A, (w, h), interpolation=cv2.INTER_LINEAR)
        b = cv2.resize(b, (w, h), interpolation=cv2.INTER_LINEAR)
        I = guide_rgb.astype(np.float32) / 255.0
        return np.clip((A * I).sum(2) + b, 0.0, 1.0)
    A, b = _gf_coef(guide_rgb, src, r, eps)
    I = guide_rgb.astype(np.float32) / 255.0
    return np.clip((A * I).sum(2) + b, 0.0, 1.0)


def _gf_coef(guide_rgb, src, r=GF_RAD, eps=GF_EPS):
    I = guide_rgb.astype(np.float32) / 255.0
    p = src.astype(np.float32)
    mI = np.stack([_box(I[:, :, c], r) for c in range(3)], 2)
    mp = _box(p, r)
    mIp = np.stack([_box(I[:, :, c] * p, r) for c in range(3)], 2)
    cov = mIp - mI * mp[:, :, None]
    var = np.empty((I.shape[0], I.shape[1], 3, 3), np.float32)
    for a in range(3):
        for b in range(a, 3):
            v = _box(I[:, :, a] * I[:, :, b], r) - mI[:, :, a] * mI[:, :, b]
            var[:, :, a, b] = v
            var[:, :, b, a] = v
    var += np.eye(3, dtype=np.float32) * eps
    A = np.linalg.solve(var, cov[..., None])[..., 0]
    b = mp - (A * mI).sum(2)
    return (np.stack([_box(A[:, :, c], r) for c in range(3)], 2).astype(np.float32),
            _box(b, r).astype(np.float32))


def _lab(img_rgb):
    return cv2.cvtColor(img_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)


# ══════════════════════════════════════════════════════════════════
# ทาง A — พื้นสีเดียว/ไล่เฉดเรียบ (สแกน · โลโก้แบน · ภาพจากเน็ตพื้นขาว)
# ══════════════════════════════════════════════════════════════════
def _grow(band):
    """เก็บเฉพาะส่วนของหน้ากากที่ 'ต่อถึงขอบภาพ' — สีพื้นที่อยู่ในลายจะไม่ถูกลบ"""
    n, lbl = cv2.connectedComponents(band.astype(np.uint8), 4)
    if n <= 1:
        return None
    edge = set(np.unique(np.concatenate(
        [lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]])).tolist())
    edge.discard(0)
    if not edge:
        return None
    return np.isin(lbl, np.array(sorted(edge), np.int32))


def flat_alpha(img_rgb, holes=True):
    """คืน alpha 0..1 ถ้าภาพนี้ 'พื้นเป็นสีเดียว' จริง — ไม่ใช่ก็คืน None

    ทำไมไม่ใช้โมเดลกับกลุ่มนี้: โมเดลถูกฝึกกับ 'วัตถุในภาพถ่าย' พอเจอลายเส้นบาง 1 px
    หรือตัวอักษรเล็ก มันมองเป็นเสียงรบกวนแล้วลบทิ้ง — งานป้ายเสียหายทันที
    ส่วนการไล่สีจากขอบภาพให้ผลระดับพิกเซล ไม่มีทางกินลายที่สีต่างจากพื้น
    """
    H, W = img_rgb.shape[:2]
    lab = _lab(img_rgb)
    b = max(2, int(round(min(H, W) * 0.01)))
    ring = np.concatenate([lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
                           lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])
    p2 = np.percentile(ring, 2, axis=0)
    p98 = np.percentile(ring, 98, axis=0)
    spread = float(np.sqrt(((p98 - p2) ** 2).sum()))
    if spread > FLAT_TOL:
        return None, spread
    # ══════════════════════════════════════════════════════════════
    # 🔁 ไล่สีพื้นแบบ "หลายชั้น" — ไม่ใช่สีเดียวจบ
    # ⚠️ วัดจริง 2026-08-18: ไฟล์ GINGER FARM เป็น "แผ่นเทา (230) ในกรอบขาวบาง ๆ"
    #    ถ้าเก็บสีจากขอบภาพอย่างเดียวจะได้แค่ขาว แล้วแผ่นเทาถูกนับเป็นลาย
    #    -> ตัดพื้นหลังแล้วยังมีกล่องเทาติดมาเต็ม ๆ (ผู้ใช้เห็นว่า "ตัดไม่ออก")
    # ✅ ไล่เป็นชั้น: ตัดสีขอบก่อน -> ดูว่าติดกับอะไรต่อ -> ถ้าสีนั้นเรียบและเป็นผืนใหญ่
    #    ก็คือพื้นอีกชั้น -> ตัดต่อ (กรอบซ้อนกี่ชั้นก็ไล่ได้หมด)
    # 🔒 หยุดทันทีถ้าสีถัดไป "ไม่เรียบ" (= ลายจริง) หรือผืนเล็กเกินไป
    # ══════════════════════════════════════════════════════════════
    bases = [np.median(ring, axis=0)]
    d = np.sqrt(((lab - bases[0]) ** 2).sum(2))
    bg = _grow(d <= FLAT_GROW)
    if bg is None or float(bg.mean()) < 0.01:
        return None, spread
    for _ in range(3):
        k = np.ones((5, 5), np.uint8)
        nxt = (cv2.dilate(bg.astype(np.uint8), k).astype(bool) & ~bg)
        if nxt.sum() < 200:
            break
        v = lab[nxt]
        p2 = np.percentile(v, 15, axis=0); p9 = np.percentile(v, 85, axis=0)
        if float(np.sqrt(((p9 - p2) ** 2).sum())) > FLAT_TOL * 1.6:
            break                       # สีถัดไปไม่เรียบ = ลายจริง หยุด
        b2 = np.median(v, axis=0)
        if min(float(np.sqrt(((b2 - q) ** 2).sum())) for q in bases) < FLAT_GROW:
            break                       # สีเดิม ไม่มีชั้นใหม่
        d2 = np.sqrt(((lab - b2) ** 2).sum(2))
        add = _grow((d2 <= FLAT_GROW) | bg)
        if add is None:
            break
        gain = float(add.mean()) - float(bg.mean())
        if gain < 0.02:
            break
        bases.append(b2)
        bg = add
        d = np.minimum(d, d2)
    if float(bg.mean()) < FLAT_MIN:
        return None, spread
    # ══════════════════════════════════════════════════════════════
    # 🎚️ ความโปร่งระดับเศษพิกเซล — วัดจาก "ระยะถึงสีพื้นที่ใกล้ที่สุดจริง ๆ"
    # ⚠️ วัดจริง 2026-08-18: เดิมวัดจากสีตั้งต้นสีเดียว แผ่นเทา (ห่างขาว 22 หน่วย)
    #    จึงได้ความทึบ 0.76 ทั้งที่มันคือพื้น -> ตัดแล้วยังมีกล่องเทาติดมา
    # ✅ เก็บ "สีพื้นที่มีอยู่จริง" มาเป็นกลุ่ม แล้ววัดระยะถึงกลุ่มที่ใกล้สุด
    #    พิกเซลพื้นได้ 0 สนิท · พิกเซลขอบเกลี่ยได้ค่ากลาง ๆ ตามสัดส่วนที่ผสมจริง
    # ══════════════════════════════════════════════════════════════
    v = lab[bg].reshape(-1, 3).astype(np.float32)
    if len(v) > 40000:
        v = v[np.linspace(0, len(v) - 1, 40000).astype(np.int64)]
    K = 4 if len(v) >= 400 else 1
    try:
        _, _, cen = cv2.kmeans(v, K, None,
                               (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0),
                               3, cv2.KMEANS_PP_CENTERS)
    except Exception:
        cen = np.asarray(bases, np.float32)
    dm = np.min(np.stack([np.sqrt(((lab - c) ** 2).sum(2)) for c in cen], 0), 0)
    a = np.clip((dm - FLAT_EDGE0) / max(1e-6, FLAT_EDGE1 - FLAT_EDGE0), 0.0, 1.0)
    # ══════════════════════════════════════════════════════════════
    # 🕳️ พื้นที่ "สีพื้นเดียวกันแต่ถูกลายล้อมไว้" — เจาะทิ้งด้วยหรือไม่
    # ⚠️ วัดจริง 2026-08-18: โลโก้ GINGER FARM เป็นรูปบ้าน พื้นเทาที่อยู่ 'ในบ้าน'
    #    ไม่ต่อถึงขอบภาพ จึงถูกเก็บไว้ทั้งผืน = ตัดพื้นหลังแล้วยังมีแผ่นเทาค้างกลางโลโก้
    # ✅ งานป้ายต้องการให้เจาะ (ตัวอักษรกลวง ไส้ตัว o โปร่ง) จึงตั้งต้นเป็นเจาะ
    #    holes=False เมื่อไหร่ที่อยากได้ลายทึบทั้งชิ้น (เช่นสติ๊กเกอร์ตัดเป็นแผ่น)
    # 🔒 ไม่ว่ากรณีไหน "สีที่ไม่ใช่สีพื้น" จะทึบเสมอ — ลายจริงไม่มีทางหาย
    # ══════════════════════════════════════════════════════════════
    if holes:
        a[~bg & (dm > FLAT_EDGE0)] = np.clip(
            (dm[~bg & (dm > FLAT_EDGE0)] - FLAT_EDGE0)
            / max(1e-6, FLAT_EDGE1 - FLAT_EDGE0), 0.0, 1.0)
    else:
        a[~bg] = 1.0                       # ไม่เจาะ: นอกย่านพื้น = ลายเสมอ
    return a.astype(np.float32), spread


# ══════════════════════════════════════════════════════════════════
# ทาง B — โมเดล AI (ภาพถ่ายจริง · ป้ายถ่ายมา · สินค้า · คน)
# ══════════════════════════════════════════════════════════════════
def _session(name=None):
    name = name or MODEL
    if _SESS[0] != name:
        from rembg import new_session
        _SESS[1] = new_session(name)
        _SESS[0] = name
    return _SESS[1]


def ai_alpha(img_rgb, model=None):
    """คืน alpha 0..1 จากโมเดล (คืน None ถ้าโมเดลใช้ไม่ได้)"""
    try:
        from rembg import remove
        from PIL import Image
        H, W = img_rgb.shape[:2]
        s = min(1.0, float(MAX_SIDE) / max(H, W))
        src = img_rgb if s >= 1.0 else cv2.resize(
            img_rgb, (max(1, int(W * s)), max(1, int(H * s))), interpolation=cv2.INTER_AREA)
        out = remove(Image.fromarray(src), session=_session(model),
                     only_mask=True, post_process_mask=False)
        a = np.asarray(out, np.float32) / 255.0
        if a.ndim == 3:
            a = a[:, :, 0]
        if a.shape[:2] != (H, W):
            a = cv2.resize(a, (W, H), interpolation=cv2.INTER_CUBIC)
        return np.clip(a, 0.0, 1.0)
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════
# ขัดขอบ + ล้างคราบสีพื้น (หัวใจที่ทำให้ชนะของสำเร็จรูป)
# ══════════════════════════════════════════════════════════════════
def polish(img_rgb, a, band=BAND, decon=DECON):
    """a หยาบ -> a คมและเกาะขอบจริง + ล้างสีพื้นเก่าออกจากพิกเซลกึ่งโปร่ง"""
    H, W = img_rgb.shape[:2]
    r = max(2, int(round(GF_RAD * max(H, W) / 1000.0)))
    ref = guided(img_rgb, a, r=r, eps=GF_EPS,
                 sub=max(1, int(round(max(H, W) / 1200.0))))
    # ยืดคอนทราสต์ของ alpha ในแถบขอบ -> ขอบคมขึ้นแต่ยังนุ่มระดับเศษพิกเซล
    ref = np.clip((ref - 0.5) * 1.9 + 0.5, 0.0, 1.0)
    # จุดที่ 'แน่ใจ' ตั้งแต่แรก ห้ามให้เปลี่ยนใจ
    hard = (a > 0.92)
    soft = (a < 0.08)
    k = np.ones((2 * int(band) + 1,) * 2, np.uint8)
    ref[cv2.erode(hard.astype(np.uint8), k).astype(bool)] = 1.0
    ref[cv2.erode(soft.astype(np.uint8), k).astype(bool)] = 0.0

    rgb = img_rgb.astype(np.float32)
    if decon:
        # 🧼 ล้างคราบ: ประมาณ 'สีพื้นตรงนั้น' จากพิกเซลพื้นที่อยู่ใกล้ที่สุด
        #    แล้วถอดส่วนของพื้นออกจากพิกเซลกึ่งโปร่ง
        bgm = (ref < 0.05)
        if bgm.any() and (~bgm).any():
            B = rgb.copy()
            B[~bgm] = 0.0
            wsum = _box(bgm.astype(np.float32), max(4, r * 3))
            for c in range(3):
                B[:, :, c] = _box(B[:, :, c], max(4, r * 3))
            wsum = np.maximum(wsum, 1e-4)
            B /= wsum[:, :, None]
            mid = (ref > 0.02) & (ref < 0.98)
            if mid.any():
                aa = np.maximum(ref[mid], 0.15)[:, None]
                F = (rgb[mid] - (1.0 - aa) * B[mid]) / aa
                rgb[mid] = np.clip(F, 0, 255)
    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8),
                     (ref * 255.0 + 0.5).astype(np.uint8)])
    return out


def denoise(a, H, W):
    """ตัดเศษจุดลอย + อุดรูรั่วเล็ก ๆ ในลาย (ทั้งคู่เกิดจากโมเดลไม่แน่ใจ)"""
    m = (a > 0.5).astype(np.uint8)
    lim = max(8.0, SPECK * H * W)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m, 8)
    drop = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] < lim]
    if drop:
        a = a.copy()
        a[np.isin(lbl, np.array(drop, np.int32))] = 0.0
        m = (a > 0.5).astype(np.uint8)
    lim2 = max(8.0, HOLE * H * W)
    n2, lbl2, st2, _ = cv2.connectedComponentsWithStats(1 - m, 4)
    edge = set(np.unique(np.concatenate([lbl2[0], lbl2[-1], lbl2[:, 0], lbl2[:, -1]])).tolist())
    fill = [i for i in range(1, n2)
            if i not in edge and st2[i, cv2.CC_STAT_AREA] < lim2]
    if fill:
        a = a.copy()
        a[np.isin(lbl2, np.array(fill, np.int32))] = 1.0
    return a


# ══════════════════════════════════════════════════════════════════
# ทางเข้าหลัก
# ══════════════════════════════════════════════════════════════════
def cutout(img_rgb, mode="auto", model=None, decon=None, band=None, holes=True):
    """ตัดพื้นหลัง -> (RGBA uint8, dict อธิบายว่าทำอะไรไป)

    mode : "auto" (ตัดสินเอง) · "flat" (บังคับทางพื้นสีเดียว) · "ai" (บังคับโมเดล)
    """
    img_rgb = np.ascontiguousarray(img_rgb[:, :, :3])
    H, W = img_rgb.shape[:2]
    info = {"w": W, "h": H}
    a = None
    if mode in ("auto", "flat"):
        a, spread = flat_alpha(img_rgb, holes=holes)
        info["bg_spread"] = round(float(spread), 1)
        if a is not None:
            info["mode"] = "flat"
            info["why"] = "พื้นเป็นสีเดียว (กระจายตัว %.1f) — ไล่สีจากขอบภาพ แม่นระดับพิกเซล" % spread
    if a is None and mode in ("auto", "ai"):
        a = ai_alpha(img_rgb, model)
        if a is not None:
            info["mode"] = "ai"
            info["model"] = model or MODEL
            info["why"] = "ภาพถ่าย/พื้นซับซ้อน — ใช้โมเดลแยกวัตถุ แล้วขัดขอบด้วยภาพจริง"
    if a is None:
        # 🛟 โมเดลใช้ไม่ได้และพื้นก็ไม่เรียบ -> ยังต้องได้ผลลัพธ์ ไม่ใช่ error
        a, spread = flat_alpha(img_rgb, holes=holes)
        if a is None:
            lab = _lab(img_rgb)
            base = np.median(np.concatenate(
                [lab[0], lab[-1], lab[:, 0], lab[:, -1]]), axis=0)
            d = np.sqrt(((lab - base) ** 2).sum(2))
            a = np.clip((d - 12.0) / 24.0, 0.0, 1.0).astype(np.float32)
            info["mode"] = "fallback"
            info["why"] = "โมเดลใช้ไม่ได้ตอนนี้ — ใช้การเทียบสีกับขอบภาพแทน"
    a = denoise(np.asarray(a, np.float32), H, W)
    out = polish(img_rgb, a,
                 band=(BAND if band is None else band),
                 decon=(DECON if decon is None else decon))
    al = out[:, :, 3]
    info["kept_pct"] = round(100.0 * float((al > 127).mean()), 1)
    info["soft_px"] = int(((al > 8) & (al < 248)).sum())
    ys, xs = np.nonzero(al > 16)
    if len(xs):
        info["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return out, info


def trim(rgba, pad=0):
    """ตัดขอบโปร่งรอบนอกทิ้ง — ไฟล์เล็กลงและเอาไปวางง่ายขึ้น"""
    al = rgba[:, :, 3]
    ys, xs = np.nonzero(al > 8)
    if not len(xs):
        return rgba
    x0 = max(0, int(xs.min()) - pad); x1 = min(rgba.shape[1], int(xs.max()) + 1 + pad)
    y0 = max(0, int(ys.min()) - pad); y1 = min(rgba.shape[0], int(ys.max()) + 1 + pad)
    return np.ascontiguousarray(rgba[y0:y1, x0:x1])
