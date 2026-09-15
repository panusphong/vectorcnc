"""
sso_gate.py — ด่าน "ต้องเข้าผ่านการ์ด CRM Hub เท่านั้น"

พี่เอสั่ง 13 ก.ย. 69:
  "ในส่วนของ app : Graphic design solution ถ้าเป็นคนนอก ไม่ผ่านการ login
   ที่ app card CRM HUB จะต้องกดเข้าไปใช้งานไม่ได้นะ
   ตอนนี้ เอา link https://vectorcnc.onrender.com/ นี้ไปวางใครก็กดเข้าใช้งานได้หมด"

── 🔴 ทำไมของเดิมกันไม่ได้ ────────────────────────────────────────────
  APP_LOCK ของเดิม (app.py) ค่าเริ่มต้นเป็น "0" = ปิดด่านไว้
  และถึงเปิด ก็แขวนอยู่แค่ 4 เส้น (/ · /app · /checksheet · /measure)
  อีก 82 เส้นพิมพ์ URL ตรง ๆ เข้าได้หมด  ⇒ ด่านต้องอยู่ "ชั้นนอกสุด" คลุมทุกเส้น
  (บทเรียนเดิมของโปรเจกต์: เคยใส่ด่านแค่ที่ทะเบียนโมดูล แล้วพิมพ์ URL ไฟล์ตรง ๆ ยังเข้าได้)

── ระบบทำงานยังไง ────────────────────────────────────────────────────
  ① พนักงานกดการ์ดในหน้ารวมแอป CRM Hub (มีด่าน requireLogin อยู่แล้ว)
  ② CRM Hub ออกตั๋วสุ่ม 32 ไบต์ อายุ 60 วิ ใช้ครั้งเดียว แล้วเด้งมา /sso?t=<ตั๋ว>
  ③ ที่นี่รับตั๋ว แล้ว "ยิงกลับไปถาม CRM Hub" ด้วย POST /api/sso/verify
     พร้อม header X-SSO-Key (เครื่องคุยกับเครื่อง ไม่ผ่านเบราว์เซอร์)
  ④ ผ่าน -> ตั้งคุกกี้เซสชันของเราเอง แล้วเด้งเข้าหน้าหลัก
  ⑤ ทุกเส้นที่เหลือต้องมีคุกกี้นี้ ไม่งั้นเด้งออก

  ‼ สิ่งเดียวที่วิ่งข้ามโดเมนคือ "ค่าสุ่มทึบ" — ไม่มีอีเมล ไม่มีรหัสผ่าน
    ไม่มีคุกกี้ของ CRM Hub ติดมาแม้แต่ตัวเดียว

🔴 ค่าเริ่มต้นคือ "ปฏิเสธ" ทุกทาง (fail-closed):
   ไม่ได้ตั้ง env · CRM Hub ตอบช้า · CRM Hub ล่ม · ตั๋วผิด · ตั๋วซ้ำ ⇒ เข้าไม่ได้
   ห้ามแก้ให้ปล่อยผ่านเวลาเกิด error เด็ดขาด
   (ถ้าเผลอเขียน except: pass แล้วปล่อยเข้า = ประตูเปิดทิ้งไว้ตอนที่ Hub ล่มพอดี)

🔴 ห้ามใส่ค่าลับลงไฟล์นี้ — SSO_SHARED_KEY อ่านจาก environment เท่านั้น
🔴 ห้าม log ค่าตั๋ว (t) และห้าม log ค่าลับ ไม่ว่ากรณีใด
"""

import os
import json
import time
import hmac
import hashlib
import urllib.error
import urllib.request

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware


GATE_VERSION = "2026-09-15-sso-gate"

COOKIE_NAME = "vectorcnc_sid"     # คุกกี้เซสชันของฝั่งนี้เอง (คนละใบกับคุกกี้ CRM Hub)
SESSION_HRS = 12                  # อายุเซสชัน — เท่ากับ auth.sign_internal ของเดิม
VERIFY_TIMEOUT = 8                # วินาที — Hub ตอบช้า ต้องกลายเป็น "ปฏิเสธ" ไม่ใช่ค้าง


# ══════════════════════════════════════════════════════════════════
#  ⚙️ ค่าจาก environment — อ่านทุกครั้งที่เรียก ไม่ cache
#
#  ‼ ตั้งใจไม่อ่านเก็บไว้ตอน import เพราะยามในเครื่อง (tests/) ต้อง
#    สลับค่า env ไปมาเพื่อพิสูจน์ว่า "ไม่ตั้งคีย์ = ปฏิเสธทุกคน"
#    ถ้า cache ไว้ตอน import ยามจะทดสอบข้อนั้นไม่ได้เลย
# ══════════════════════════════════════════════════════════════════
def _shared_key() -> str:
    return (os.environ.get("SSO_SHARED_KEY", "") or "").strip()


def _hub_url() -> str:
    """โดเมน CRM Hub (Railway) ที่ใช้ "ตรวจตั๋ว"

    🔴 ระวังชื่อชนกัน — CRM_HUB_URL ของเดิมใน app.py ไม่ใช่ตัวเดียวกัน!
       ของเดิม (app.py บรรทัด 9533) คือ URL ของ Apps Script (.../exec)
       ที่ /api/login ใช้ตรวจ user/password  ⇒ คนละระบบ คนละหน้าตา URL
       ถ้าเอา CRM_HUB_URL ไปชี้ Railway ตรง ๆ หน้า /login เดิมจะพังทันที

    ⇒ ตัวนี้จึงอ่าน SSO_HUB_URL ก่อน (ตัวใหม่ เฉพาะงาน SSO)
      ไม่ได้ตั้ง -> ค่อยถอยไปใช้ CRM_HUB_URL (เผื่อวันหน้าสองระบบรวมเป็นตัวเดียว)
    """
    u = (os.environ.get("SSO_HUB_URL", "") or "").strip()
    if not u:
        u = (os.environ.get("CRM_HUB_URL", "") or "").strip()
    return u.rstrip("/")


def _pay_lane_open() -> bool:
    """🔓 เปิดเส้นทางของ "ลูกค้าที่จ่ายเงิน" ให้คนนอกเดินได้ไหม

    วันนี้ปิดอยู่จริงทั้งระบบ (billing.PAYMENTS_OPEN=0 · SELL_MODE=0)
      -> /pay ตอบ 404 · /api/checkout ตอบ 403 อยู่แล้วตั้งแต่ก่อนแพตช์นี้
      -> ไม่มีลูกค้าภายนอกคนไหนใช้อยู่ ณ ตอนนี้ ⇒ ปิดไว้ก่อนตามกฎ fail-closed

    วันไหนพี่เอเปิดขายจริง (ตั้ง SELL_MODE=1 + PAYMENTS_OPEN=1)
      ให้ตั้ง SSO_PUBLIC_PAY=1 ด้วย เส้นของลูกค้าจะเปิดให้คนนอกเดินได้
      โดย "เส้นของพนักงานภายในยังปิดเหมือนเดิมทุกเส้น"
    """
    return str(os.environ.get("SSO_PUBLIC_PAY", "0")).lower() in ("1", "true", "yes", "on")


# ══════════════════════════════════════════════════════════════════
#  🚪 ทะเบียนเส้นสาธารณะ — ‼ ทุกบรรทัดในนี้คือประตูที่คนนอกเดินเข้าได้จริง
#     เติมเส้นใหม่เข้ามาเมื่อไหร่ ต้องมีเหตุผลกำกับเสมอ
# ══════════════════════════════════════════════════════════════════
PUBLIC_EXACT = {
    "/sso":                 "ประตูรับตั๋วจาก CRM Hub — เส้นนี้แหละที่ตรวจตั๋ว",
    "/no-access":           "หน้าบอกทางว่า 'ต้องเข้าผ่าน CRM Hub'",
    # 🔴 ห้ามปิดเส้นนี้เด็ดขาด — render.yaml ตั้ง healthCheckPath: /api/health ไว้
    #    ถ้าปิด Render จะมองว่าแอปตาย แล้ววนรีสตาร์ทไม่หยุด
    "/api/health":          "Render เรียกเช็คสุขภาพ",
    # 🚪 ประตูล็อกอินเดิม (username/password ตรวจกับ Table: user ของ CRM Hub)
    #    ต้องเปิดไว้ ไม่งั้นคนที่ใช้อยู่ทุกวันนี้จะเข้าไม่ได้เลย = ทำของเดิมพัง
    "/login":               "หน้าล็อกอินเดิม",
    "/api/login":           "ตรวจ user/password เดิม (ออกคุกกี้ vc_acc ให้)",
    "/favicon.ico":         "ไอคอนแท็บ",
    "/robots.txt":          "บอกบอทว่าเก็บอะไรได้ — ตอนนี้สั่ง Disallow: / ทั้งเว็บอยู่แล้ว",
    # 🤖 เครื่องคุยกับเครื่อง — PayPal/Omise ยิงเข้ามาเอง ไม่มีทางมีคุกกี้ของเรา
    #    ‼ สองเส้นนี้มีด่านของตัวเองอยู่แล้วในโค้ดเดิม:
    #      paypal -> PY.paypal_verify_webhook() ตรวจลายเซ็นก่อนเชื่อ body
    #      omise  -> ไม่เชื่อ body เลย ยิงกลับไปถามสถานะจริงจาก Omise API อีกที
    "/api/webhook/paypal":  "webhook PayPal (ตรวจลายเซ็นเองอยู่แล้ว)",
    "/api/webhook/omise":   "webhook Omise (ถามสถานะกลับไปที่ Omise เองอยู่แล้ว)",
}

PUBLIC_PREFIX = (
    # 🔤 ไฟล์ฟอนต์ OFL ที่ฝังมากับแอป — หน้า /login ต้องใช้เรนเดอร์ตัวอักษร
    #    ไม่ใช่ข้อมูลของบริษัท เป็นฟอนต์เปิดที่โหลดจากที่ไหนก็ได้อยู่แล้ว
    "/fonts/",
)

# 💳 เส้นของ "ลูกค้าที่จ่ายเงิน" — เปิดเฉพาะตอนตั้ง SSO_PUBLIC_PAY=1
#    ‼ แยกออกมาเป็นก้อนของตัวเอง เพื่อให้เห็นชัดว่าเส้นไหนของลูกค้า เส้นไหนของพนักงาน
PAY_LANE_EXACT = {
    "/pay":                 "หน้าเลือกช่องทางจ่ายเงิน (checkout.html)",
    "/pay/done":            "หน้าขอบคุณหลังจ่ายสำเร็จ",
    "/welcome":             "หน้าขาย (landing.html)",
    "/api/pay-methods":     "ช่องทางจ่ายที่เปิดใช้",
    "/api/checkout":        "สร้างคำสั่งซื้อ",
    "/api/pay-status":      "หน้า QR ถามสถานะซ้ำทุก 3 วิ",
    "/api/slip":            "ลูกค้าอัปโหลดสลิป",
    "/api/plans":           "ตารางแพ็กเกจสาธารณะ (หน้า landing ใช้เรนเดอร์)",
}


def _is_public(path: str) -> bool:
    """เส้นนี้เปิดให้คนนอกไหม — ‼ เทียบแบบ 'ตรงตัว' ไม่ใช่ startswith ลอย ๆ

    ที่ไม่ใช้ startswith กับทุกเส้น เพราะ "/api/health-secret" จะเผลอผ่านไปด้วย
    ประตูต้องแคบเท่าที่ตั้งใจเปิดจริงเท่านั้น
    """
    if path in PUBLIC_EXACT:
        return True
    if path.startswith(PUBLIC_PREFIX):
        return True
    if _pay_lane_open() and path in PAY_LANE_EXACT:
        return True
    return False


# ══════════════════════════════════════════════════════════════════
#  🎫 เซสชันของ VectorCNC เอง — เซ็นด้วย HMAC จึงปลอมไม่ได้
#     (ท่าเดียวกับ vectorcnc/auth.py ของเดิม แค่คนละคีย์คนละใบ)
# ══════════════════════════════════════════════════════════════════
def _sign(body: str) -> str:
    return hmac.new(_shared_key().encode("utf-8"),
                    body.encode("utf-8"), hashlib.sha256).hexdigest()


def make_session(username: str, role: str) -> str:
    """ออกคุกกี้เซสชัน 1 ใบ — หน้าตา  <user>|<role>|<หมดอายุ>|<ลายเซ็น>"""
    exp = int(time.time()) + SESSION_HRS * 3600
    body = "%s|%s|%d" % (username, role, exp)
    return body + "|" + _sign(body)


def read_session(raw: str):
    """คืน dict ถ้าคุกกี้ถูกต้องและยังไม่หมดอายุ · ไม่งั้นคืน None"""
    # 🔴 ไม่ได้ตั้งคีย์ = เซ็นด้วยค่าว่าง = ใครก็คำนวณลายเซ็นเองได้
    #    ⇒ ต้องปฏิเสธทุกคน ไม่ใช่ปล่อยผ่าน
    if not raw or not _shared_key():
        return None
    try:
        username, role, exp, sig = raw.rsplit("|", 3)
    except ValueError:
        return None
    # ‼ เทียบลายเซ็นแบบทนเวลาเสมอ — เทียบด้วย == จะหยุดที่ตัวอักษรแรกที่ต่าง
    #   เวลาที่ใช้จึงบอกใบ้ได้ว่า "เดาถูกไปกี่ตัวแล้ว" แล้วไล่เดาทีละตัวจนครบได้จริง
    if not hmac.compare_digest(sig, _sign("%s|%s|%s" % (username, role, exp))):
        return None
    try:
        if int(exp) < int(time.time()):
            return None
    except ValueError:
        return None
    return {"username": username, "role": role}


def session_of(request) -> dict:
    """อ่านเซสชันจากคำขอ — ใช้ตัดสินว่า 'ผ่านประตูแล้วหรือยัง'

    รับได้ 2 ใบ (ทั้งคู่เซ็นด้วย HMAC ปลอมไม่ได้):
      ① vectorcnc_sid — เซสชันจากตั๋ว SSO (งานรอบนี้)
      ② vc_acc        — โทเคนเดิมจากการ login ด้วย user/password ที่ /login
                        🔴 ต้องรับด้วย ไม่งั้นคนที่ใช้อยู่ทุกวันนี้เข้าไม่ได้เลย
    """
    # 🔴 ไม่ได้ตั้ง SSO_SHARED_KEY = ด่านยังตั้งไม่เสร็จ ⇒ ปฏิเสธทุกคน
    #    ‼ ต้องเช็คตรงนี้ "ก่อน" ทางเข้าทุกทาง รวมถึงคุกกี้ vc_acc ของระบบเดิมด้วย
    #      ไม่งั้นลืมกรอกคีย์ที่ Render แล้วประตูยังเปิดอยู่อีกบาน โดยไม่มีใครรู้
    #      (กติกาเดียวกับ auth.py: "ถ้ายังไม่ตั้งคีย์ ให้ผ่านทุกคน" คือบทเรียนที่เคยพลาดมาแล้ว)
    if not _shared_key():
        return None

    s = read_session(request.cookies.get(COOKIE_NAME, "") or "")
    if s:
        return s
    try:
        from vectorcnc import auth as A
        tok = request.cookies.get("vc_acc", "") or ""
        p = A.verify(tok) if tok else None
        # ‼ ต้องมี role ที่รู้จักจริง ๆ เท่านั้น — โทเคนที่ไม่มี r ถือว่าไม่ผ่าน
        if p and p.get("r") in ("internal", "admin", "user"):
            return {"username": p.get("e", ""), "role": p.get("r", "")}
    except Exception:
        # 🔴 อ่านโทเคนเดิมไม่ได้ = ไม่ผ่าน (ห้ามปล่อยผ่านเวลา error)
        pass
    return None


# ══════════════════════════════════════════════════════════════════
#  🔍 ยิงกลับไปถาม CRM Hub ว่าตั๋วใบนี้จริงไหม
#
#  ‼ ใช้ urllib ของ Python เอง ไม่เพิ่ม dependency ใหม่ใน requirements.txt
#    (ท่าเดียวกับ /api/login ของเดิมที่คุยกับ CRM Hub ด้วย urllib อยู่แล้ว)
#    ตัวเรียกเป็นฟังก์ชันธรรมดา (def ไม่ใช่ async def) -> Starlette พาไปรัน
#    ใน threadpool ให้เอง จึงไม่ไปค้าง event loop ของคนอื่น
# ══════════════════════════════════════════════════════════════════
def verify_ticket(ticket: str):
    """คืน dict {username, role} ถ้าตั๋วผ่าน · คืน None ทุกกรณีที่ไม่ผ่าน

    สัญญาที่ตกลงกับฝั่ง CRM Hub (server.js · POST /api/sso/verify):
      Header : X-SSO-Key: <SSO_SHARED_KEY>  ·  Content-Type: application/json
      Body   : {"ticket": "<ค่าที่ได้จาก ?t=>"}
      ผ่าน   : 200 {"ok":true,"username":"...","role":"..."}
      ไม่ผ่าน: 401 {"ok":false}   ← ทุกกรณีตอบเหมือนกัน ไม่บอกเหตุผล (ตั้งใจ)
    """
    key = _shared_key()
    hub = _hub_url()
    # 🔴 ตั้งค่าไม่ครบ = ตรวจตั๋วไม่ได้อยู่ดี ⇒ ปฏิเสธ ไม่ใช่ปล่อยผ่าน
    if not key or not hub or not ticket:
        return None
    # ‼ ตั๋วจาก CRM Hub คือ randomBytes(32) แปลงเป็น base64url = 43 ตัวอักษร
    #   กันของยาวผิดปกติไว้ก่อน จะได้ไม่เอาขยะไปยิงใส่ Hub
    if len(ticket) < 16 or len(ticket) > 400:
        return None

    body = json.dumps({"ticket": ticket}).encode("utf-8")
    req = urllib.request.Request(
        hub + "/api/sso/verify",
        data=body,
        headers={"Content-Type": "application/json", "X-SSO-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=VERIFY_TIMEOUT) as r:
            if r.status != 200:
                return None
            data = json.loads(r.read().decode("utf-8", "ignore") or "{}")
    except Exception:
        # 🔴 Hub ล่ม / ตอบช้า / ตอบ 401 / ตอบพัง ⇒ ปฏิเสธเสมอ ห้าม fail-open
        #    ‼ log ได้แค่ "พัง" — ห้ามมีค่าตั๋วหรือค่าลับติดไปแม้แต่ตัวเดียว
        print("[sso] ตรวจตั๋วกับ CRM Hub ไม่สำเร็จ — ปฏิเสธไว้ก่อน")
        return None

    if not isinstance(data, dict) or not data.get("ok"):
        return None
    return {"username": str(data.get("username", "") or ""),
            "role": str(data.get("role", "") or "")}


def _app_role(hub_role: str) -> str:
    """แปลง role ที่ CRM Hub ส่งมา -> role ที่แอปนี้รู้จัก

    ‼ แมปแบบเดียวกับ /api/login ของเดิม (app.py) เพื่อให้เมนูที่เห็นเหมือนกันเป๊ะ
      admin* -> admin (เห็นสถิติ + หน้าอนุมัติสลิป)
      อื่น ๆ -> internal (ทีมงาน เห็นเมนูจำลองผนัง + BOM)
    🔴 คนที่เดินผ่านการ์ด CRM Hub มาได้ = พนักงานภายในเสมอ ไม่มีทางเป็น "คนนอก"
    """
    r = (hub_role or "").strip().lower()
    return "admin" if r.startswith("admin") else "internal"


# ══════════════════════════════════════════════════════════════════
#  🚧 ด่านคลุมทุก route — ใส่เป็น middleware ชั้นนอกสุด
# ══════════════════════════════════════════════════════════════════
class SSOGate(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        p = request.url.path

        # ✈️ preflight ของเบราว์เซอร์ — ไม่มีข้อมูลอะไรติดมา และไม่ได้คืนข้อมูลอะไรออกไป
        #    ต้องปล่อยผ่านให้ CORSMiddleware ชั้นในตอบ ไม่งั้น fetch ข้ามโดเมนพังหมด
        if request.method == "OPTIONS":
            return await call_next(request)

        if _is_public(p):
            return await call_next(request)

        if session_of(request):
            return await call_next(request)

        # 🔴 ไม่มีเซสชัน = คนนอก — ไม่บอกรายละเอียดอะไรทั้งสิ้น
        if p.startswith("/api/"):
            return JSONResponse({"ok": False}, status_code=401)
        return RedirectResponse("/no-access", status_code=302)


NO_ACCESS_HTML = """<!doctype html><meta charset="utf-8">
<title>ต้องเข้าผ่าน CRM Hub</title>
<div style="font-family:system-ui,sans-serif;text-align:center;margin-top:90px;color:#334155">
  <div style="font-size:44px">&#128274;</div>
  <h2>ระบบนี้สำหรับพนักงานภายในเท่านั้น</h2>
  <p>กรุณาเข้าใช้งานผ่านการ์ด <b>Graphic Design Solution</b> ในหน้ารวมแอปของ CRM Hub</p>
  <p><a href="{hub}">ไปที่ CRM Hub</a></p>
</div>"""


def _no_access(request):
    hub = _hub_url() or "/"
    return HTMLResponse(NO_ACCESS_HTML.format(hub=hub), status_code=200)


def _sso(request):
    """ประตูรับตั๋ว — GET /sso?t=<ตั๋ว>

    ‼ เส้นนี้เป็นเส้นเดียวที่คนนอกเดินเข้ามาแล้ว "อาจได้เซสชัน"
      ทุกทางที่ไม่ผ่าน เด้งไป /no-access เหมือนกันหมด ไม่บอกว่าผิดเพราะอะไร
    """
    t = request.query_params.get("t", "") or ""
    who = verify_ticket(t)
    if not who:
        return RedirectResponse("/no-access", status_code=302)

    role = _app_role(who["role"])
    res = RedirectResponse("/", status_code=302)
    # ‼ ห้ามให้หน้านี้ถูก cache — มันคือหน้าที่แจกคุกกี้
    res.headers["Cache-Control"] = "no-store"

    res.set_cookie(
        COOKIE_NAME, make_session(who["username"], role),
        httponly=True,          # JavaScript ในหน้าเว็บอ่านไม่ได้
        secure=True,            # ส่งเฉพาะ https
        samesite="lax",         # ต้องเป็น lax ไม่ใช่ strict — เพราะเดินทางมาจากอีกโดเมน
        max_age=SESSION_HRS * 3600,
        path="/",
    )

    # 🔑 ออกคุกกี้ vc_acc ของ "ระบบเดิม" ให้ด้วย
    #    เพื่อให้ _role_of / _is_internal / _is_admin ใน app.py ทำงานเหมือนเดิมเป๊ะ
    #    ⇒ พนักงานที่เข้าผ่านการ์ด เห็นเมนูครบเท่าเดิมทุกเมนู ไม่ต้องแก้หน้าเว็บสักบรรทัด
    try:
        from vectorcnc import auth as A
        res.set_cookie("vc_acc", A.sign_internal(who["username"], role, SESSION_HRS),
                       httponly=True, samesite="lax", secure=True,
                       max_age=SESSION_HRS * 3600, path="/")
    except Exception:
        # ‼ ออกคุกกี้เดิมไม่ได้ ไม่ทำให้การเข้าใช้งานพัง — แค่เมนูภายในอาจไม่ครบ
        print("[sso] ออกคุกกี้ระบบเดิมไม่สำเร็จ")

    return res


def install(app):
    """เรียกท้ายไฟล์ app.py:  install(app)

    🔴 ต้องเรียก "ท้ายสุดจริง ๆ" หลังประกาศ route ครบทุกเส้น (include_router ด้วย)
      middleware ที่เพิ่มทีหลังจะอยู่ชั้นนอกสุด = คลุมทุกเส้นที่ประกาศไปแล้ว
    """
    # ‼ ใช้ add_route ของ Starlette (FastAPI สืบทอดมาให้อยู่แล้ว)
    #   จึงใช้ได้ทั้งกับแอปจริงและกับยามในเครื่องที่รันบน Starlette เปล่า ๆ
    app.router.add_route("/no-access", _no_access, methods=["GET"], name="sso_no_access")
    app.router.add_route("/sso", _sso, methods=["GET"], name="sso_enter")

    app.add_middleware(SSOGate)
    return app
