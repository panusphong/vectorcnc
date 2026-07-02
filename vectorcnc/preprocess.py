"""ขั้นที่ 1: ล้างภาพ + ลดสีให้แบน (quantize) — เตรียมภาพ AI ให้พร้อม vectorize"""
import cv2
import numpy as np


def denoise(img):
    """ลด noise แต่รักษาขอบคม (สำคัญกับภาพจาก AI ที่มี gradient/เกรน)"""
    return cv2.bilateralFilter(img, 9, 60, 60)


def quantize(img, k=6):
    """
    ลดภาพเหลือ k สีแบน ด้วย k-means
    คืน: (ภาพ quantized, ศูนย์กลางสี BGR uint8 [k,3], แผนที่ label [H,W])
    """
    Z = img.reshape((-1, 3)).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(Z, k, None, crit, 4, cv2.KMEANS_PP_CENTERS)
    centers = np.uint8(centers)
    q = centers[labels.flatten()].reshape(img.shape)
    return q, centers, labels.reshape(img.shape[:2])
