# -*- coding: utf-8 -*-
"""🧬 ชุดภาพทดสอบสังเคราะห์ — ครอบคลุมทุกรูปแบบที่เจอจริง

ทำไมต้องสังเคราะห์เอง: ไล่แก้ทีละไฟล์ที่ผู้ใช้ส่งมาเป็นวิธีที่ผิด
เพราะแก้ให้ไฟล์หนึ่งผ่าน ก็ไปพังกับไฟล์ถัดไป
ชุดนี้สร้างภาพที่ **รู้คำตอบที่ถูกต้องอยู่แล้ว** ครอบคลุมลักษณะที่ทำให้พังได้ทุกแบบ
แล้วให้ vectora_selftest ตรวจทั้งชุดในคราวเดียว

รายการที่ครอบคลุม:
  ring        วงแหวนซ้อน 3 ชั้น (เขียว-ดำ-ขาว)   ⟵ เคส 'ถมใจกลางตัว O'
  counters    ตัวอักษรมีช่องใน A O R B          ⟵ เคส 'ถมช่องตัวอักษร A'
  thin        เส้นบางมาก 2-6 px                 ⟵ เคส 'เส้นขาด/ตัวอักษรแตก'
  tiny_holes  รูเล็กจริงในงานออกแบบ             ⟵ เคส 'รูจริงโดนตัดทิ้ง'
  many_colors 12 สีติดกัน                        ⟵ เคส 'เส้นขาวคั่นสี'
  corners     มุมแหลมหลายแบบ                     ⟵ เคส 'เงี่ยงแหลมยื่นออกนอกรูป'
  upscaled    ไอคอนเล็กถูกขยาย 8 เท่า            ⟵ เคส 'ขอบเป็นขั้นบันได'
  noisy       จุดรบกวน + บีบอัดแรง               ⟵ เคส 'แตกเป็นชิ้นนับพัน'
  alpha       พื้นโปร่ง                          ⟵ เคส 'พื้นโปร่งหาย'
  gradient    ไล่เฉดแบบภาพถ่าย                   ⟵ เคส 'เหลือ 2 สี'

รัน:  python3 vectora_corpus.py /tmp/corpus     (สร้างไฟล์ลงโฟลเดอร์)
"""

import os
import sys

import cv2
import numpy as np
from PIL import Image

G = (46, 164, 52); K = (26, 26, 26); R = (214, 40, 40)
B = (58, 110, 200); Y = (240, 190, 40); W = (255, 255, 255)


def _blank(n=1200, bg=W):
    return np.full((n, n, 3), bg, np.uint8)


def ring(n=1200):
    """วงแหวนซ้อน 3 ชั้น — ใจกลางต้องเป็นสีขาวเสมอ"""
    a = _blank(n)
    c = n // 2
    cv2.circle(a, (c, c), int(n * .34), G, -1)
    cv2.circle(a, (c, c), int(n * .21), W, -1)
    cv2.circle(a, (c, c), int(n * .21), K, max(2, n // 110))
    cv2.circle(a, (c, c), int(n * .34), K, max(2, n // 140))
    cv2.circle(a, (c, c), int(n * .09), R, -1)         # จุดกลาง (รูปทึบในรู)
    return a


def counters(n=1200):
    """ตัวอักษรที่มีช่องใน — ช่องต้องไม่ถูกถม"""
    a = _blank(n)
    f = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(a, "ABOR", (int(n * .04), int(n * .42)), f, n / 190.0, G, int(n / 26), cv2.LINE_AA)
    cv2.putText(a, "8&%@", (int(n * .04), int(n * .82)), f, n / 190.0, K, int(n / 34), cv2.LINE_AA)
    return a


def thin(n=1200):
    """เส้นบางมาก — ต้องไม่ขาดและไม่หาย"""
    a = _blank(n)
    for i, t in enumerate((2, 3, 4, 6, 9)):
        y = int(n * (.12 + i * .17))
        cv2.line(a, (int(n * .06), y), (int(n * .94), y), K, t, cv2.LINE_AA)
        cv2.circle(a, (int(n * .5), y + int(n * .07)), int(n * .05), G, t, cv2.LINE_AA)
    return a


def tiny_holes(n=1200):
    """รูเล็กแต่เป็นของจริงในแบบ — ห้ามถูกถม"""
    a = _blank(n)
    cv2.rectangle(a, (int(n * .1), int(n * .1)), (int(n * .9), int(n * .9)), G, -1)
    for i in range(5):
        for j in range(5):
            r = 3 + i * 3
            cv2.circle(a, (int(n * (.2 + j * .15)), int(n * (.2 + i * .15))), r, W, -1)
    return a


def many_colors(n=1200):
    """หลายสีติดกัน — ห้ามมีเส้นขาวคั่น"""
    a = _blank(n)
    cols = [G, K, R, B, Y, (120, 60, 160), (0, 150, 150), (255, 130, 40),
            (90, 90, 90), (200, 60, 120), (40, 90, 40), (170, 200, 60)]
    for i, c in enumerate(cols):
        x0 = int(n * i / len(cols)); x1 = int(n * (i + 1) / len(cols))
        cv2.rectangle(a, (x0, 0), (x1, n), c, -1)
    return a


def corners(n=1200):
    """มุมแหลม — ห้ามมีเงี่ยงยื่นออกนอกรูป"""
    a = _blank(n)
    c = n // 2
    for k, (cx, cy, s) in enumerate([(c // 2, c // 2, .18), (c + c // 2, c // 2, .18),
                                     (c // 2, c + c // 2, .18), (c + c // 2, c + c // 2, .18)]):
        p = np.array([[cx, cy - int(n * s)], [cx + int(n * s * (.5 + k * .2)), cy],
                      [cx, cy + int(n * s)], [cx - int(n * s * .35), cy]], np.int32)
        cv2.fillPoly(a, [p], [G, K, R, B][k], cv2.LINE_AA)
    return a


def _shrink_grow(a, f=8, q=None):
    n = a.shape[0]
    s = cv2.resize(a, (n // f, n // f), interpolation=cv2.INTER_AREA)
    return cv2.resize(s, (n, n), interpolation=cv2.INTER_CUBIC)


CASES = {"ring": ring, "counters": counters, "thin": thin, "tiny_holes": tiny_holes,
         "many_colors": many_colors, "corners": corners}


def build(outdir, n=1200):
    os.makedirs(outdir, exist_ok=True)
    made = []
    for name, fn in CASES.items():
        a = fn(n)
        p = os.path.join(outdir, name + ".png")
        Image.fromarray(a).save(p); made.append(p)
    base = counters(n)
    # ถูกขยายมาจากไอคอนเล็ก
    p = os.path.join(outdir, "upscaled.jpg")
    Image.fromarray(_shrink_grow(base, 8)).save(p, quality=88); made.append(p)
    # จุดรบกวน + บีบอัดแรง
    rng = np.random.default_rng(1)
    nz = np.clip(_shrink_grow(ring(n), 4).astype(np.int16) + rng.normal(0, 7, (n, n, 3)), 0, 255)
    p = os.path.join(outdir, "noisy.jpg")
    Image.fromarray(nz.astype(np.uint8)).save(p, quality=60); made.append(p)
    # พื้นโปร่ง
    a = ring(n); rgba = np.dstack([a, np.where((a > 245).all(2), 0, 255).astype(np.uint8)])
    p = os.path.join(outdir, "alpha.png"); Image.fromarray(rgba).save(p); made.append(p)
    # ไล่เฉดแบบภาพถ่าย
    yy, xx = np.mgrid[0:n, 0:n]
    gr = np.stack([(np.sin(xx / 90.) * 70 + 150), (np.cos(yy / 70.) * 60 + 130),
                   ((xx + yy) / 9. % 180 + 50)], -1).astype(np.uint8)
    p = os.path.join(outdir, "gradient.jpg")
    Image.fromarray(cv2.GaussianBlur(gr, (0, 0), 3)).save(p, quality=88); made.append(p)
    return made


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "/tmp/corpus"
    for p in build(d):
        print(p)
