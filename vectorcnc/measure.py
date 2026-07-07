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
