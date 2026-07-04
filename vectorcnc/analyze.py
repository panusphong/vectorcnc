"""analyze.py — อ่านไฟล์ภาพให้ขาด + วิเคราะห์ชนิด → เลือกเครื่องมือ vector ที่เหมาะสมสุดอัตโนมัติ
รองรับ: JPG/PNG/WEBP/BMP/TIFF/GIF (+ alpha โปร่งใส composite บนขาว)  · SVG/DXF จัดการที่ batch.py
เลือกเครื่องยนต์:
  lineart  — ตัวอักษร/เส้นขอบบาง            -> skeletonize
  cutout   — โลโก้/ป้าย สีเรียบ (1-หลายสี)   -> clean bilevel + contour (คมกริบ)
  photo    — ภาพถ่าย/ไล่เฉด สีเยอะ           -> VTracer color
"""
import numpy as np
import cv2


def load_image(path):
    """อ่านภาพทุกฟอร์แมต -> BGR uint8 (alpha composite บนพื้นขาว)"""
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        try:
            from PIL import Image
            im = Image.open(path).convert('RGBA')
            img = cv2.cvtColor(np.array(im), cv2.COLOR_RGBA2BGRA)
        except Exception:
            raise FileNotFoundError('อ่านไฟล์ภาพไม่ได้: ' + str(path))
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        b, g, r, a = cv2.split(img)
        a = a.astype(np.float32) / 255.0
        w = 255.0 * (1.0 - a)
        out = cv2.merge([(b * a + w).astype(np.uint8),
                         (g * a + w).astype(np.uint8),
                         (r * a + w).astype(np.uint8)])
        return out
    return img[:, :, :3]


def analyze(path):
    """คืน dict: {mode, engine, n_colors, kind, colorful, ndom, residual, ink_frac, stroke_rel, notes}"""
    img = load_image(path)
    H, W = img.shape[:2]
    s = 360
    small = cv2.resize(img, (s, max(1, int(s * H / W))), interpolation=cv2.INTER_AREA) if W > s else img
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    # 1) colorfulness (Hasler–Süsstrunk)
    b, g, r = cv2.split(small.astype(np.float32))
    rg = np.abs(r - g); yb = np.abs(0.5 * (r + g) - b)
    colorful = float(np.sqrt(rg.var() + yb.var()) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))

    # 2) จำนวนสีเด่น + ความเรียบ (residual หลัง quantize)
    Z = small.reshape(-1, 3).astype(np.float32)
    K = 8
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
    _, lab, cen = cv2.kmeans(Z, K, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    lab = lab.flatten()
    counts = np.bincount(lab, minlength=K).astype(np.float32); frac = counts / counts.sum()
    ndom = int((frac > 0.02).sum())
    quant = cen[lab].reshape(small.shape)
    residual = float(np.abs(small.astype(np.float32) - quant).mean())   # ต่ำ = สีเรียบ (vector-like)

    # 3) เส้นบาง? (lineart) — ink thin เมื่อเทียบขนาด
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink_frac = float((bw > 0).mean())
    stroke_rel = 1.0
    try:
        from skimage.morphology import skeletonize
        sk = skeletonize(bw > 0)
        skl = int(sk.sum())
        if skl > 0:
            stroke_px = (bw > 0).sum() / float(skl)      # ความหนาเส้นเฉลี่ย (px)
            stroke_rel = stroke_px / float(min(bw.shape))  # เทียบขนาดภาพ
    except Exception:
        pass

    # ---- ตัดสินใจเลือกเครื่องมือ ----
    kind, mode, engine, notes = '', 'cutout', 'crisp', ''
    if ink_frac < 0.22 and stroke_rel < 0.025 and colorful < 25:
        kind, mode, engine = 'lineart', 'lineart', 'skeleton'
        notes = 'ตัวอักษร/เส้นขอบบาง → โหมดเส้น (ลากแกนกลาง)'
    elif residual > 8.0 and ndom >= 6:
        kind, mode, engine = 'photo', 'cutout', 'photo'
        notes = 'ภาพถ่าย/ไล่เฉด → VTracer (ผลอาจไม่คมเท่าโลโก้ · แนะนำใช้ภาพกราฟิกสีเรียบ)'
    else:
        kind, mode, engine = 'flat', 'cutout', 'crisp'
        notes = ('โลโก้/ป้ายสีเรียบ → เครื่องยนต์คมกริบ (' +
                 ('ขาว-ดำ' if ndom <= 2 else str(ndom) + ' สี') + ')')

    n_colors = int(max(2, min(ndom if ndom >= 2 else 2, 8)))
    return {
        'mode': mode, 'engine': engine, 'n_colors': n_colors, 'kind': kind,
        'colorful': round(colorful, 1), 'ndom': ndom, 'residual': round(residual, 1),
        'ink_frac': round(ink_frac, 3), 'stroke_rel': round(stroke_rel, 4),
        'width': W, 'height': H, 'notes': notes
    }
