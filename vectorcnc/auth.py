"""
auth.py — โทเคนผู้ใช้แบบเซ็นชื่อ (HMAC)

ทำไมต้องมี:
  เดิมเราดูว่าใครเป็นใครจาก ?u=admin ใน URL ซึ่ง "ใครก็พิมพ์เองได้"
  ไฟล์นี้ออกโทเคนที่ปลอมไม่ได้ เพราะต้องรู้ SECRET ถึงจะเซ็นได้

โทเคนหน้าตา:  <payload_b64>.<signature_b64>
  payload = {"e": email, "p": plan, "x": exp_epoch, "r": role}
  signature = HMAC-SHA256(payload, APP_SECRET)

⚠️ APP_SECRET ต้องอยู่ใน Render → Environment เท่านั้น ห้ามใส่ในโค้ด
   ถ้าไม่ตั้ง ระบบจะ generate ชั่วคราวให้ (โทเคนจะหลุดทุกครั้งที่ deploy)
"""

import os
import hmac
import json
import time
import base64
import hashlib
import secrets

AUTH_VERSION = "2026-07-14-hmac-token"

_FALLBACK = secrets.token_hex(32)   # ใช้เมื่อยังไม่ตั้ง APP_SECRET (dev เท่านั้น)


def _secret() -> bytes:
    s = os.environ.get("APP_SECRET", "")
    if not s:
        s = _FALLBACK
    return s.encode("utf-8")


def secret_is_set() -> bool:
    return bool(os.environ.get("APP_SECRET", ""))


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign(email: str, plan: str = "free", days: int = 30, role: str = "user") -> str:
    """ออกโทเคนให้ผู้ใช้ 1 คน"""
    payload = {
        "e": (email or "").strip().lower(),
        "p": plan or "free",
        "r": role or "user",
        "x": int(time.time()) + int(days) * 86400,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()
    return _b64e(raw) + "." + _b64e(sig)


def sign_internal(email: str, role: str = "internal", hours: int = 12) -> str:
    """ตั๋วเข้าใช้งานสำหรับพนักงาน — ออกโดย CRM Hub เท่านั้น

    role = "internal" -> ทีมงาน (เห็นเมนูจำลองผนัง + BOM)
    role = "admin"    -> พี่ + ทีมดูแลระบบ (เห็นสถิติ + หน้าอนุมัติสลิปด้วย)

    อายุสั้น (12 ชม.) โดยตั้งใจ — พนักงานลาออก/ถูกถอดจาก CRM Hub
    วันรุ่งขึ้นตั๋วหมดอายุเอง ไม่ต้องไปเปลี่ยนคีย์ทั้งบริษัท
    """
    r = role if role in ("internal", "admin") else "internal"
    payload = {
        "e": (email or "").strip().lower(),
        "p": r,                      # plan = internal / admin
        "r": r,
        "x": int(time.time()) + int(hours) * 3600,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()
    return _b64e(raw) + "." + _b64e(sig)


def role_of(token: str) -> str:
    """คืน 'admin' / 'internal' / '' (คนนอก)"""
    p = verify(token)
    if not p:
        return ""
    r = p.get("r", "")
    return r if r in ("internal", "admin") else ""


def verify(token: str):
    """คืน payload ถ้าโทเคนถูกต้องและยังไม่หมดอายุ · คืน None ถ้าไม่ผ่าน"""
    if not token or "." not in token:
        return None
    try:
        body_b64, sig_b64 = token.split(".", 1)
        raw = _b64d(body_b64)
        got = _b64d(sig_b64)
    except Exception:
        return None

    want = hmac.new(_secret(), raw, hashlib.sha256).digest()
    if not hmac.compare_digest(got, want):     # ⚠️ ต้องใช้ compare_digest กัน timing attack
        return None

    try:
        p = json.loads(raw.decode("utf-8"))
    except Exception:
        return None

    if int(p.get("x", 0)) < int(time.time()):
        return None                            # หมดอายุ
    return p


def email_of(token: str) -> str:
    p = verify(token)
    return (p or {}).get("e", "")


def plan_of_token(token: str) -> str:
    p = verify(token)
    return (p or {}).get("p", "free")


# ---------------------------------------------------------------- โทเคนใช้ครั้งเดียว (magic link)
def sign_login(email: str, minutes: int = 30) -> str:
    """ลิงก์ยืนยันอีเมล — อายุสั้น ใช้ตอนสมัคร / กู้บัญชี"""
    payload = {"e": (email or "").strip().lower(),
               "k": "login",
               "x": int(time.time()) + int(minutes) * 60}
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()
    return _b64e(raw) + "." + _b64e(sig)


def verify_login(token: str) -> str:
    p = verify(token)
    if not p or p.get("k") != "login":
        return ""
    return p.get("e", "")


# ---------------------------------------------------------------- อ้างอิงคำสั่งซื้อ
def order_ref(prefix: str = "VC") -> str:
    """เลขอ้างอิงคำสั่งซื้อ เช่น VC-7K3F9QX2 (ใช้เป็น note ตอนโอนเงิน)"""
    return prefix + "-" + secrets.token_hex(4).upper()
