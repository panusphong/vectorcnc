"""measure.py — วัดขนาดจริงของตัวอักษร/แบบป้าย จาก "ภาพที่ทั้งภาพ = พื้นที่หน้าร้าน"
เซลล์ใส่ พื้นที่ กว้าง×สูง (ซม.) + upload ภาพวางแบบ -> ระบบคืน:
  block_w/h_cm      : กรอบรวมอักษร/โลโก้ทั้งหมด (กว้าง×สูง)
  letter_h_cm       : ความสูงตัวอักษร/ชิ้นที่สูงสุด (cap height โดยประมาณ)
  margin_*_cm       : ระยะขอบจากขอบพื้นที่ถึงอักษร (ซ้าย/ขวา/บน/ล่าง)
สมมติฐาน: ทั้งภาพ = พื้นที่ -> px→cm ตามสัดส่วนภาพต่อพื้นที่ (แกน x,y แยกกัน)
"""
import base64
import numpy as np
import cv2
from . import analyze


def _foreground_mask(path):
    """คืน (mask uint8 0/255, imgBGR) — แยกตัวอักษร/แบบ ออกจากพื้นหลัง
    ใช้ alpha ถ้ามี, ไม่งั้นใช้ระยะสีจากพื้นหลัง(ขอบภาพ)"""
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is not None and raw.ndim == 3 and raw.shape[2] == 4:
        a = raw[:, :, 3]
        if int(a.min()) < 240:                      # มี alpha โปร่งใสจริง
            mask = (a > 24).astype(np.uint8) * 255
            img = analyze.load_image(path)
            return _clean(mask), img
    img = analyze.load_image(path)                  # BGR (composite บนขาว)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.bilateralFilter(g, 7, 45, 45)
    border = np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])
    bg = float(np.median(border))
    # ระยะความสว่างจากพื้นหลัง > 32 = วัตถุ (จับได้ทั้งพื้นสว่าง/พื้นเข้ม)
    diff = np.abs(g.astype(np.int16) - bg)
    mask = (diff > 32).astype(np.uint8) * 255
    return _clean(mask), img


def _clean(mask):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)    # ลบเม็ด noise
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    return mask


def measure(image_path, area_w_cm, area_h_cm, want_preview=True):
    area_w = float(area_w_cm); area_h = float(area_h_cm)
    if area_w <= 0 or area_h <= 0:
        raise ValueError('พื้นที่ กว้าง×สูง ต้องมากกว่า 0')
    mask, img = _foreground_mask(image_path)
    H, W = mask.shape[:2]
    ys, xs = np.nonzero(mask)
    if len(xs) < 10:
        raise ValueError('ไม่พบตัวอักษร/แบบในภาพ (ตรวจว่าพื้นหลังโล่งพอ)')

    ppx = W / area_w        # px ต่อ ซม. แนวนอน
    ppy = H / area_h        # px ต่อ ซม. แนวตั้ง

    mnx, mxx = int(xs.min()), int(xs.max())
    mny, mxy = int(ys.min()), int(ys.max())
    block_w = (mxx - mnx + 1) / ppx
    block_h = (mxy - mny + 1) / ppy

    # ตัวอักษรที่สูงสุด: connected components (กรองเศษเล็ก)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    min_area = W * H * 3e-5
    tall_px = 0; tall_w_px = 0; tall_idx = -1
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < min_area:
            continue
        h = stats[i, cv2.CC_STAT_HEIGHT]
        if h > tall_px:
            tall_px = h; tall_w_px = stats[i, cv2.CC_STAT_WIDTH]; tall_idx = i
    letter_h = (tall_px if tall_px else (mxy - mny + 1)) / ppy
    letter_w = (tall_w_px if tall_w_px else (mxx - mnx + 1)) / ppx

    res = {
        'area_w_cm': round(area_w, 1), 'area_h_cm': round(area_h, 1),
        'block_w_cm': round(block_w, 1), 'block_h_cm': round(block_h, 1),
        'letter_h_cm': round(letter_h, 1), 'letter_w_cm': round(letter_w, 1),
        'margin_left_cm': round(mnx / ppx, 1),
        'margin_right_cm': round((W - 1 - mxx) / ppx, 1),
        'margin_top_cm': round(mny / ppy, 1),
        'margin_bottom_cm': round((H - 1 - mxy) / ppy, 1),
        'img_w_px': W, 'img_h_px': H,
    }
    if want_preview:
        res['preview'] = _preview(img, (mnx, mny, mxx, mxy), stats, tall_idx, res)
    return res


def _preview(img, bbox, stats, tall_idx, res):
    """ภาพประกอบ: กรอบพื้นที่(เขียว) · กรอบอักษรรวม(แดง) · ความสูงตัวสูงสุด(น้ำเงิน) + ป้ายเลข"""
    vis = img.copy()
    H, W = vis.shape[:2]
    mnx, mny, mxx, mxy = bbox
    sc = max(1.0, W / 900.0)
    th = max(2, int(round(2 * sc)))
    cv2.rectangle(vis, (1, 1), (W - 2, H - 2), (60, 170, 60), max(2, th))          # พื้นที่ เขียว
    cv2.rectangle(vis, (mnx, mny), (mxx, mxy), (40, 40, 230), th)                   # อักษรรวม แดง
    if tall_idx > 0:
        x = stats[tall_idx, cv2.CC_STAT_LEFT]; y = stats[tall_idx, cv2.CC_STAT_TOP]
        hh = stats[tall_idx, cv2.CC_STAT_HEIGHT]; ww = stats[tall_idx, cv2.CC_STAT_WIDTH]
        cv2.rectangle(vis, (x, y), (x + ww, y + hh), (230, 150, 30), th)            # ตัวสูงสุด น้ำเงิน
    fs = 0.6 * sc

    def label(text, org, color, bg=(255, 255, 255)):
        (tw, tht), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, fs, max(1, int(sc)))
        x0, y0 = org
        cv2.rectangle(vis, (x0 - 3, y0 - tht - 5), (x0 + tw + 3, y0 + 4), bg, -1)
        cv2.putText(vis, text, (x0, y0), cv2.FONT_HERSHEY_SIMPLEX, fs, color, max(1, int(sc)), cv2.LINE_AA)

    label("Block W=%.1f H=%.1f cm" % (res['block_w_cm'], res['block_h_cm']),
          (mnx + 4, max(18, mny - 8)), (40, 40, 230))
    label("Letter H=%.1f cm" % res['letter_h_cm'], (mnx + 4, min(H - 6, mxy + int(20 * sc))), (200, 120, 20))
    label("Area %.0f x %.0f cm" % (res['area_w_cm'], res['area_h_cm']), (6, H - 8), (40, 130, 40))

    ok, buf = cv2.imencode('.png', vis)
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode() if ok else ''


def cutout_rgba(path):
    """ตัดพื้นหลัง -> BGRA (alpha เนียน). ทนพื้นหลังคอนทราสต์ต่ำด้วย GrabCut + color distance"""
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    img = analyze.load_image(path)          # BGR (composite ขาว)
    H, W = img.shape[:2]
    # 1) มี alpha จริง -> ใช้เลย
    if raw is not None and raw.ndim == 3 and raw.shape[2] == 4 and int(raw[:, :, 3].min()) < 240:
        a = raw[:, :, 3].astype(np.uint8)
        return np.dstack([img, _clean(a)])
    # 2) color distance จากสีพื้นหลัง (ขอบภาพ)
    bd = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]]).reshape(-1, 3)
    bcol = np.median(bd, axis=0)
    dist = np.sqrt(((img.astype(np.float32) - bcol) ** 2).sum(2))
    dn = np.clip(dist, 0, 255).astype(np.uint8)
    _t, m_col = cv2.threshold(dn, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m_col = (m_col > 0).astype(np.uint8)
    # 3) GrabCut (rect กลางภาพ) — ช่วยพื้นหลังคอนทราสต์ต่ำ/ลายเยอะ
    m_gc = None
    try:
        gc = np.zeros((H, W), np.uint8)
        rect = (int(W * 0.05), int(H * 0.05), int(W * 0.90), int(H * 0.90))
        cv2.grabCut(img, gc, rect, np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                    4, cv2.GC_INIT_WITH_RECT)
        m_gc = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 1, 0).astype(np.uint8)
    except Exception:
        m_gc = None
    # รวม (union) color-distance + GrabCut -> ไม่ทิ้งตัวอักษร/ชิ้นเล็กที่คอนทราสต์ต่ำ
    mask = m_col
    if m_gc is not None and 0.02 < float(m_gc.mean()) < 0.95:
        mask = ((m_col | m_gc) > 0).astype(np.uint8)
    mask = _clean((mask * 255).astype(np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))  # เชื่อมเส้นตัวอักษร
    # ลบเฉพาะเศษจุดเล็กจิ๋ว (เก็บตัวอักษรไว้ — เกณฑ์ต่ำ)
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n > 1:
        keep = np.zeros_like(mask)
        minA = max(40, H * W * 0.0003)
        for i in range(1, n):
            if st[i, cv2.CC_STAT_AREA] >= minA:
                keep[lab == i] = 255
        mask = keep
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.erode(mask, k3, iterations=1)
    alpha = cv2.GaussianBlur(mask, (0, 0), 1.0)
    return np.dstack([img, alpha])


def measure_parts(image_path, area_w_cm, area_h_cm):
    """แยกวัดเป็นส่วนๆ (logo/ตัวอักษร) + รวมทั้งป้าย ตาม scale ผนัง
    ใช้ horizontal projection แบ่งแถบตามช่องว่างแนวนอน"""
    aw = float(area_w_cm); ah = float(area_h_cm)
    if aw <= 0 or ah <= 0:
        raise ValueError('พื้นที่ผนัง กว้าง×สูง ต้อง > 0')
    mask, img = _foreground_mask(image_path)
    H, W = mask.shape[:2]
    ys, xs = np.nonzero(mask)
    if len(xs) < 10:
        raise ValueError('ไม่พบป้ายในภาพ')
    ppx = W / aw; ppy = H / ah

    def pack(x0, y0, x1, y1, name=None):
        return {'name': name, 'fx': float(x0) / W, 'fy': float(y0) / H,
                'fw': float(x1 - x0 + 1) / W, 'fh': float(y1 - y0 + 1) / H,
                'w_cm': round((x1 - x0 + 1) / ppx, 1), 'h_cm': round((y1 - y0 + 1) / ppy, 1)}

    overall = pack(int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), 'รวมทั้งป้าย')
    # แบ่งแถบตามแนวนอน (ช่องว่างระหว่าง logo กับ ตัวอักษร)
    rowsum = (mask > 0).sum(axis=1).astype(float)
    on = rowsum > max(1.0, rowsum.max() * 0.02)
    bands = []; i = 0
    while i < H:
        if on[i]:
            j = i
            while j < H and on[j]:
                j += 1
            bands.append([i, j]); i = j
        else:
            i += 1
    merged = []
    for b in bands:
        if merged and (b[0] - merged[-1][1]) < 0.04 * H:
            merged[-1][1] = b[1]
        else:
            merged.append(b[:])
    bands = [b for b in merged if (b[1] - b[0]) > 0.02 * H]
    parts = []
    for (y0, y1) in bands:
        yy, xx = np.nonzero(mask[y0:y1])
        if len(xx) < 10:
            continue
        parts.append(pack(int(xx.min()), int(y0 + yy.min()), int(xx.max()), int(y0 + yy.max())))
    if len(parts) >= 2:
        parts.sort(key=lambda p: p['fy'])
        parts[0]['name'] = 'โลโก้/กราฟิก'
        parts[-1]['name'] = 'ตัวอักษร'
        for k in range(1, len(parts) - 1):
            parts[k]['name'] = 'ส่วนที่ %d' % (k + 1)
    elif len(parts) == 1:
        parts[0]['name'] = 'ป้าย'
    return {'area_w_cm': round(aw, 1), 'area_h_cm': round(ah, 1), 'overall': overall, 'parts': parts}
