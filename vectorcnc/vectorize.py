"""ขั้นที่ 3 (หัวใจ): contour + geometry fitting — ลด node, คืนวงกลม/เส้นตรง/มุมคม"""
import cv2
import numpy as np
import math


def _circle_fill(c):
    """อัตราส่วนพื้นที่ contour เทียบวงกลมล้อม — ทนต่อ noise ขอบดีกว่า 4πA/P²"""
    (x, y), r = cv2.minEnclosingCircle(c)
    a = cv2.contourArea(c)
    return (a / (math.pi * r * r) if r > 0 else 0), (x, y, r)


def fit_mask(mask, eps_frac=0.008, min_area=200, circle_min_area=3000):
    """
    แปลง mask -> รายการ shape:
        ('circle', (cx, cy, r))  หรือ  ('poly', ndarray[[x,y],...])
    คืน (shapes, raw_node_count) — raw = จำนวนจุดถ้า trace ตรงๆ (ไว้เทียบ)
    """
    cnts, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    shapes, raw = [], 0
    for c in cnts:
        if cv2.contourArea(c) < min_area:
            continue
        raw += len(c)
        fill, circ = _circle_fill(c)
        if fill > 0.90 and cv2.contourArea(c) > circle_min_area:
            shapes.append(('circle', circ))
        else:
            ap = cv2.approxPolyDP(c, eps_frac * cv2.arcLength(c, True), True)
            shapes.append(('poly', ap.reshape(-1, 2)))
    return shapes, raw


def count_nodes(shapes):
    return sum(1 if k == 'circle' else len(d) for k, d in shapes)
