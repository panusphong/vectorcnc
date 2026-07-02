"""ขั้นที่ 2: แยก mask ต่อสี (แต่ละสี = แต่ละ layer/วัสดุสำหรับ CNC)"""
import cv2
import numpy as np


def detect_bg_label(labels):
    """เดา label พื้นหลัง = สีที่พบมากสุดตามขอบภาพ"""
    border = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    return int(np.bincount(border).argmax())


def color_masks(labels, centers, bg_label=None, min_area=200):
    """
    คืนรายการ (label, สี BGR, mask) ต่อสีที่ไม่ใช่พื้นหลัง
    พร้อมเก็บกวาดเศษ (open) + อุดรูเข็ม (close)
    """
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    out = []
    for i, c in enumerate(centers):
        if i == bg_label:
            continue
        m = (labels == i).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        if cv2.countNonZero(m) > min_area:
            out.append((i, tuple(int(x) for x in c), m))
    return out
