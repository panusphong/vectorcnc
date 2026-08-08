# -*- coding: utf-8 -*-
"""🧪 ชุดตรวจถาวรของเครื่องแปลงภาพเป็นเวกเตอร์

ทำไมต้องมี: ระหว่างพัฒนา แก้จุดหนึ่งแล้วไปพังอีกจุดหนึ่งซ้ำ ๆ
  • ตัดเศษเล็กเพื่อลดจุดฝุ่น -> ไปถม **ช่องในตัวอักษร A** ทิ้ง (ผู้ใช้จับได้)
  • เพิ่มความเกลาเพื่อลบขอบหยัก -> ตัวอักษรแตกเป็นก้อน
  • ย่อภาพเพื่อความเร็ว -> รายละเอียดหาย
ตาเปล่ามองไม่ทันทุกเคส จึงต้องมีตัววัดที่รันซ้ำได้

ตัววัดหลัก 4 ตัว (ทุกตัวต้องผ่านพร้อมกัน):
  1. ถมทับ   — พิกเซลที่ต้นฉบับเป็นพื้นหลัง แต่ผลลัพธ์กลายเป็นเนื้อสี  ⟵ จับเคส 'ถมช่องตัวอักษร'
  2. กินหาย  — พิกเซลที่ต้นฉบับเป็นเนื้อสี แต่ผลลัพธ์กลายเป็นพื้นหลัง ⟵ จับเคส 'เส้นขาด/ตัวอักษรแตก'
  3. รู       — จำนวนช่องปิดในผลลัพธ์ ต้องไม่น้อยกว่าต้นฉบับอย่างมีนัย
  4. หยึกหยัก — มุมหักต่อความยาวเส้น 100 px

รัน:  python3 vectora_selftest.py [ไฟล์ภาพ ...]
"""

import io
import sys
import time

import cv2
import numpy as np
from PIL import Image

import vectora_engine as VE
import vectora_export as VX


def _render(res, W, H):
    import cairosvg
    png = cairosvg.svg2png(bytestring=VX.to_svg(res).encode())
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    return cv2.resize(a, (W, H), interpolation=cv2.INTER_AREA)


def _assign(rgb, pal):
    """จับแต่ละพิกเซลเข้าสีที่ใกล้ที่สุดในจานสีของผลลัพธ์ (ปริภูมิ Lab)

    ⚠️ ห้ามเทียบภาพต้นฉบับดิบ ๆ กับผลลัพธ์ตรง ๆ — ภาพที่ขอบฟุ้ง (ถูกขยายมา/เบลอ)
       มีแถบสีกลาง ๆ รอบเส้นกว้างหลายพิกเซล จะถูกนับว่า 'หาย' หรือ 'ถมเกิน' ทั้งที่ถูกต้อง
       (วัดจริง: ลายเส้นหมูรายงานว่ากินหาย 8% ทั้งที่ตาดูตรงเป๊ะ)
    ✅ แปลงทั้งสองฝั่งเป็น 'ป้ายสี' ชุดเดียวกันก่อน แล้วค่อยเทียบ = เทียบของอย่างเดียวกัน
    """
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    P = cv2.cvtColor(np.asarray(pal, np.uint8).reshape(1, -1, 3),
                     cv2.COLOR_RGB2LAB).astype(np.float32).reshape(-1, 3)
    best = None; out = None
    for j in range(len(P)):
        d = ((lab - P[j][None, None, :]) ** 2).sum(2)
        if best is None:
            best, out = d, np.zeros(lab.shape[:2], np.int16)
        else:
            m = d < best
            best = np.where(m, d, best); out[m] = j
    return out


def _holes(mask):
    """นับ 'ช่องปิด' — พื้นที่พื้นหลังที่ถูกเนื้อสีล้อมรอบสนิท (ช่องในตัวอักษร ฯลฯ)"""
    inv = (~mask).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(inv, 8)
    edge = set(lab[0, :].tolist()) | set(lab[-1, :].tolist()) \
        | set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    return sum(1 for i in range(1, n) if i not in edge and st[i, cv2.CC_STAT_AREA] >= 12)


def check(path, verbose=True, tol_px=3):
    src = np.asarray(Image.open(path).convert("RGB"))
    H, W = src.shape[:2]
    t = time.time()
    res = VE.vectorize(src, preset="general")
    dt = time.time() - t
    out = _render(res, W, H)

    pal = [L["rgb"] for L in res["layers"]]
    if not pal:
        print("%-26s ❌ ไม่มีชั้นสีเลย" % path.split("/")[-1]); return False, {}
    a_src, a_out = _assign(src, pal), _assign(out, pal)

    # ชั้นที่มีพื้นที่มากสุด = พื้นหลัง
    bgi = int(np.bincount(a_src.ravel(), minlength=len(pal)).argmax())
    ms, mo = (a_src != bgi), (a_out != bgi)
    k = np.ones((tol_px * 2 + 1,) * 2, np.uint8)           # ยอมคลาดตำแหน่งไม่กี่พิกเซล
    ms_d = cv2.dilate(ms.astype(np.uint8), k) > 0
    mo_d = cv2.dilate(mo.astype(np.uint8), k) > 0
    base = max(int(ms.sum()), 1)
    fill = float((mo & ~ms_d).sum()) / base * 100.0        # ถมทับที่ไม่ควรถม
    eat = float((ms & ~mo_d).sum()) / base * 100.0         # กินเนื้อที่ควรมี
    hs, ho = _holes(ms), _holes(mo)

    pts = []
    for L in res["layers"]:
        for it in L["items"]:
            p = np.asarray(it[1] if it[0] == "P" else [it[1]] + [g[-1] for g in it[2]], float)
            if len(p) >= 10:
                pts.append(p)
    kink = VE.kink_ratio(pts) if pts else 0.0

    hole_ok = ho >= hs - max(1, int(hs * 0.15))
    ok = (fill <= 1.5) and (eat <= 1.5) and hole_ok and (kink <= 3.0)
    if verbose:
        flags = []
        if fill > 1.5: flags.append("ถมทับเกิน")
        if eat > 1.5: flags.append("กินเนื้อหาย")
        if not hole_ok: flags.append("รูหาย")
        if kink > 3.0: flags.append("เส้นหยึกหยัก")
        print("%-24s %s ถมทับ %5.2f%% · กินหาย %5.2f%% · รู %2d/%2d · หยัก %.2f · %d สี %3d รูป · %.1f วิ%s"
              % (path.split("/")[-1], "✅" if ok else "❌", fill, eat, ho, hs, kink,
                 res["stats"]["colors"], res["stats"]["shapes"], dt,
                 ("  ⟵ " + ", ".join(flags)) if flags else ""))
    return ok, dict(fill=fill, eat=eat, holes_out=ho, holes_src=hs, kink=kink)


if __name__ == "__main__":
    files = sys.argv[1:]
    if not files:
        print("ใส่ไฟล์ภาพที่จะตรวจต่อท้ายคำสั่ง")
        sys.exit(0)
    bad = 0
    for f in files:
        try:
            if not check(f)[0]:
                bad += 1
        except Exception as e:
            print("%-26s ❌ พัง: %s" % (f.split("/")[-1], e)); bad += 1
    print("\n%s  (%d/%d ผ่าน)" % ("✅ ผ่านหมด" if not bad else "❌ มีที่ไม่ผ่าน %d" % bad,
                                   len(files) - bad, len(files)))
    sys.exit(1 if bad else 0)
