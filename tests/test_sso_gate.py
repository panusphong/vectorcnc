#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ยามของด่าน SSO — พิสูจน์ว่า "คนนอกเข้าไม่ได้จริง"

รัน:   python3 tests/test_sso_gate.py
       (รันจากรากโปรเจกต์ vectorcnc · ไม่ต้องมี pytest · ไม่ต้องมี fastapi)

── ยามนี้พิสูจน์อะไร ────────────────────────────────────────────────
  ① ไม่มีตั๋ว -> ทุกเส้นที่ต้องล็อกอิน ถูกปฏิเสธ  (ไล่ครบทุกเส้นตามสำมะโน)
  ② ตั๋วถูกต้อง -> เข้าได้
  ③ ตั๋วปลอม / ลายเซ็นผิด / หมดอายุ / ใช้ซ้ำครั้งที่ 2 -> ถูกปฏิเสธ
  ④ ?u=admin · ?admin=1 · ?k= · ?ak= -> ใช้เดาตัวตนไม่ได้แล้ว
  ⑤ /api/health -> ยังเข้าได้โดยไม่ต้องล็อกอิน (Render ต้องใช้เช็คสุขภาพ)
  ⑥ ไฟล์หน้าเว็บ (index/checksheet/measure/admin_payments) พิมพ์ URL ตรง ๆ -> เข้าไม่ได้
  ⑦ ไม่ได้ตั้ง SSO_SHARED_KEY -> ปฏิเสธทุกคน (ไม่ใช่ปล่อยผ่าน)

🔴 ยามนี้ "ไม่ได้ปลอม" การตรวจตั๋ว — มันยก CRM Hub จำลองขึ้นมาเป็น
   เว็บเซิร์ฟเวอร์จริงบน localhost ที่ทำตามสัญญาใน server.js เป๊ะ
   (เก็บ sha256 ไม่เก็บตั๋วดิบ · อายุ 60 วิ · ใช้ครั้งเดียวด้วยคำสั่งเดียว
    · เทียบ X-SSO-Key แบบทนเวลา · ไม่ผ่านตอบ 401 {"ok":false} เหมือนกันหมด)
   ⇒ ตั๋วเดินทางผ่าน HTTP จริง เหมือนตอนขึ้น Render ทุกประการ

‼ ยามนี้ไม่ import app.py ตัวจริง (มันลาก opencv/numpy/rembg มาเป็นนาที)
  แต่มัน import sso_gate.py "ตัวจริง" มาใช้ แล้วแขวนกับ route ครบตามสำมะโน
  ⇒ ตรรกะที่ถูกทดสอบคือของจริงทุกบรรทัด ไม่ใช่ของจำลอง
"""

import os
import sys
import json
import time
import hmac
import hashlib
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)                                   # ให้ import vectorcnc ได้
sys.path.insert(0, os.path.join(ROOT, "web", "backend"))   # ให้ import sso_gate ได้

from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.testclient import TestClient

# 🔒 คุกกี้เซสชันตั้ง secure=True (ส่งเฉพาะ https) — ยามจึงต้องคุยผ่าน https
#    ไม่งั้นตัวทดสอบจะทิ้งคุกกี้ทุกใบ แล้วเข้าใจผิดว่า "ตั๋วดีก็ยังเข้าไม่ได้"
HTTPS = "https://testserver"


# ══════════════════════════════════════════════════════════════════
#  📋 สำมะโน route — คัดลอกมาจาก app.py + vectora_api.py ของจริง
#     ‼ เพิ่ม route ใหม่ในแอปเมื่อไหร่ ต้องมาเติมที่นี่ด้วย
#       ไม่งั้นยามจะไม่รู้ว่ามีเส้นใหม่โผล่มาแล้วไม่มีใครกัน
# ══════════════════════════════════════════════════════════════════

# 🚪 เส้นสาธารณะ — คนนอกเข้าได้โดยตั้งใจ (ทุกบรรทัดมีเหตุผลกำกับใน sso_gate.py)
PUBLIC_ROUTES = [
    ("GET",  "/api/health"),          # 🔴 Render เช็คสุขภาพ — ห้ามปิด
    ("GET",  "/login"),               # ประตูล็อกอินเดิม
    ("POST", "/api/login"),           # ตรวจ user/password เดิม
    ("GET",  "/robots.txt"),
    ("GET",  "/fonts/Kanit-Bold.ttf"),
    ("POST", "/api/webhook/paypal"),  # เครื่องคุยกับเครื่อง (ตรวจลายเซ็นเอง)
    ("POST", "/api/webhook/omise"),   # เครื่องคุยกับเครื่อง (ถามกลับ Omise เอง)
]

# 🔒 เส้นที่ต้องล็อกอิน — ทั้งหมดนี้ต้องถูกปฏิเสธเมื่อไม่มีตั๋ว
GATED_PAGES = [                       # หน้าเว็บ -> ต้องเด้งไป /no-access (302)
    "/", "/app", "/checksheet", "/measure", "/welcome",
    "/pay", "/pay/done", "/admin/payments",
    "/llms.txt", "/sitemap.xml",
]
GATED_APIS = [                        # /api/* -> ต้องตอบ 401
    "/api/appinfo", "/api/vectorize", "/api/design", "/api/nest", "/api/draft-ai",
    "/api/export-3d", "/api/export-3d-layered", "/api/layer-set", "/api/job-sheet",
    "/api/nest-layerset", "/api/nest-multi", "/api/nest-batch", "/api/step-repeat",
    "/api/mount-frame", "/api/led-layout", "/api/fonts", "/api/checksheet",
    "/api/measure", "/api/cutout", "/api/rasterize", "/api/ai-split",
    "/api/measure_parts", "/api/extract-assets", "/api/compose-vector",
    "/api/compose-assets", "/api/extract-asset", "/api/text-fonts", "/api/text-asset",
    "/api/bg-asset", "/api/check-producible", "/api/autofix", "/api/security-check",
    "/api/whoami", "/api/plans", "/api/price-catalog", "/api/sign-types",
    "/api/brief-fields", "/api/brief", "/api/concept-names", "/api/concept-styles",
    "/api/concept", "/api/ocr-text", "/api/track", "/api/stats-health",
    "/api/track-test", "/api/stats", "/api/geom3d", "/api/perspective",
    "/api/concept-3d", "/api/concept-use", "/api/pay-methods", "/api/checkout",
    "/api/pay-status", "/api/slip", "/api/admin/payments", "/api/admin/approve",
    "/api/quote", "/api/job-packet",
    # 🎨 Vectora — โมดูลแยกที่ app.py include_router เข้ามา
    #    ‼ บทเรียนเดิม: เคยใส่ด่านแค่ที่ทะเบียนโมดูล แล้วเส้นในโมดูลยังโล่ง
    "/api/vec/cutout", "/api/vec/analyze", "/api/vec/convert", "/api/vec/start",
    "/api/vec/status", "/api/vec/export", "/api/vec/pieces", "/api/vec/art",
    "/api/vec/compose", "/api/vec/vexport", "/api/vec/ping",
]


# ══════════════════════════════════════════════════════════════════
#  🏢 CRM Hub จำลอง — ทำตามสัญญาใน server.js เป๊ะทุกข้อ
# ══════════════════════════════════════════════════════════════════
class FakeHub:
    """ออกตั๋ว + ตรวจตั๋ว แบบเดียวกับ /api/sso/vectorcnc และ /api/sso/verify"""

    TICKET_SECONDS = 60          # 🔴 อายุ 60 วิ — ตรงกับ sql/68-sso-ticket.sql

    def __init__(self, shared_key):
        self.shared_key = shared_key
        self.rows = {}           # ticket_hash -> {username, role, expires_at, used_at}
        self.lock = threading.Lock()

    @staticmethod
    def _hash(raw):
        """🔴 เก็บ hash ไม่เก็บค่าดิบ — ท่าเดียวกับ PasswordHash"""
        return hashlib.sha256(str(raw).encode("utf-8")).hexdigest()

    def issue(self, username, role, age_seconds=None):
        raw = secrets.token_urlsafe(32)          # ค่าสุ่มทึบ 32 ไบต์
        life = self.TICKET_SECONDS if age_seconds is None else age_seconds
        self.rows[self._hash(raw)] = {
            "username": username, "role": role,
            "expires_at": time.time() + life, "used_at": None,
        }
        return raw

    def verify(self, key_sent, ticket):
        """คืน dict ถ้าผ่าน · คืน None ทุกกรณีที่ไม่ผ่าน (ไม่บอกเหตุผล)"""
        want = self.shared_key
        if not want or not key_sent:
            return None
        # ‼ เทียบค่าลับแบบทนเวลา เหมือน crypto.timingSafeEqual ฝั่ง server.js
        if not hmac.compare_digest(str(key_sent), str(want)):
            return None
        if not isinstance(ticket, str) or not (16 <= len(ticket) <= 400):
            return None
        # 🔴 ตรวจ + ปั๊มว่า "ใช้แล้ว" ในคำสั่งเดียว (atomic) — ยิงพร้อมกันก็ผ่านได้ใบเดียว
        with self.lock:
            row = self.rows.get(self._hash(ticket))
            if not row:
                return None
            if row["used_at"] is not None:        # ใช้ไปแล้ว
                return None
            if row["expires_at"] <= time.time():  # หมดอายุ
                return None
            row["used_at"] = time.time()
            return {"username": row["username"], "role": row["role"]}


class _HubHandler(BaseHTTPRequestHandler):
    hub = None

    def do_POST(self):
        if self.path != "/api/sso/verify":
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            body = {}
        who = self.hub.verify(self.headers.get("X-SSO-Key") or "",
                              body.get("ticket") or "")
        if not who:
            out = json.dumps({"ok": False}).encode()
            self.send_response(401)                       # 🔴 ทุกกรณีตอบเหมือนกัน
        else:
            out = json.dumps({"ok": True, **who}).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass                      # เงียบ ๆ ไม่ให้รกจอตอนรันยาม


# ══════════════════════════════════════════════════════════════════
#  🕸️ แอปจำลอง — route ครบตามสำมะโน แล้วแขวน sso_gate ตัวจริงทับ
# ══════════════════════════════════════════════════════════════════
def build_app():
    import sso_gate

    app = Starlette()

    def ok(request):
        return JSONResponse({"ok": True, "hit": request.url.path})

    def txt(request):
        return PlainTextResponse("ok")

    seen = set()
    for m, p in PUBLIC_ROUTES:
        if p.startswith("/fonts/"):
            app.router.add_route("/fonts/{fname}", txt, methods=["GET"])
        else:
            app.router.add_route(p, ok, methods=[m])
        seen.add(p)
    for p in GATED_PAGES:
        app.router.add_route(p, ok, methods=["GET"]); seen.add(p)
    for p in GATED_APIS:
        app.router.add_route(p, ok, methods=["GET", "POST"]); seen.add(p)

    sso_gate.install(app)          # 🔴 ท้ายสุด = ชั้นนอกสุด = คลุมทุกเส้น
    return app


# ══════════════════════════════════════════════════════════════════
#  ✅ ตัวนับผล
# ══════════════════════════════════════════════════════════════════
_pass = [0]
_fail = []


def check(name, cond):
    if cond:
        _pass[0] += 1
    else:
        _fail.append(name)
        print("   ❌ %s" % name)


def blocked(r):
    """ถือว่า 'ถูกปฏิเสธ' = 401/403 หรือเด้งไป /no-access"""
    if r.status_code in (401, 403):
        return True
    if r.status_code in (302, 307) and "/no-access" in (r.headers.get("location") or ""):
        return True
    return False


def main():
    key = secrets.token_hex(32)                 # ค่าลับร่วมของรอบทดสอบนี้ (สุ่มทุกครั้ง)
    hub = FakeHub(key)
    _HubHandler.hub = hub

    srv = ThreadingHTTPServer(("127.0.0.1", 0), _HubHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    hub_url = "http://127.0.0.1:%d" % srv.server_address[1]

    os.environ["SSO_SHARED_KEY"] = key
    os.environ["SSO_HUB_URL"] = hub_url
    os.environ.pop("SSO_PUBLIC_PAY", None)
    os.environ["APP_SECRET"] = secrets.token_hex(32)   # ให้ auth.py เซ็น vc_acc ได้นิ่ง ๆ

    app = build_app()
    import sso_gate

    print("=" * 66)
    print(" ยามด่าน SSO — VectorCNC (Graphic Design Solution)")
    print(" route ในสำมะโน: สาธารณะ %d · ต้องล็อกอิน %d"
          % (len(PUBLIC_ROUTES), len(GATED_PAGES) + len(GATED_APIS)))
    print("=" * 66)

    # ── ① ไม่มีตั๋ว -> ทุกเส้นที่ต้องล็อกอิน ต้องถูกปฏิเสธ ──────────────
    print("\n① ไม่มีตั๋ว — ไล่ทุกเส้นตามสำมะโน")
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        for p in GATED_PAGES:
            r = c.get(p)
            check("หน้า %s ต้องถูกปฏิเสธ (ได้ %d)" % (p, r.status_code), blocked(r))
        for p in GATED_APIS:
            r = c.get(p)
            check("API %s ต้องถูกปฏิเสธ (ได้ %d)" % (p, r.status_code), blocked(r))

        # ⑤ health ต้องเปิดไว้ · เส้นสาธารณะอื่นต้องยังเข้าได้
        print("\n⑤ เส้นสาธารณะ — ต้องยังเข้าได้โดยไม่ต้องล็อกอิน")
        for m, p in PUBLIC_ROUTES:
            r = c.request(m, p)
            check("%s %s ต้องเข้าได้ (ได้ %d)" % (m, p, r.status_code),
                  r.status_code == 200)

        # ── ④ ช่องเดาตัวตนแบบเดิม ต้องใช้ไม่ได้แล้ว ──────────────────
        print("\n④ ช่องเดาตัวตนแบบเดิม — ต้องใช้ไม่ได้แล้ว")
        for q in ("?u=admin", "?u=administrator", "?admin=1",
                  "?k=guess", "?ak=guess", "?t=guess", "?u=admin&ak=1"):
            for p in ("/", "/app", "/admin/payments"):
                r = c.get(p + q)
                check("%s%s ต้องถูกปฏิเสธ (ได้ %d)" % (p, q, r.status_code), blocked(r))
            r = c.get("/api/whoami" + q)
            check("/api/whoami%s ต้องถูกปฏิเสธ (ได้ %d)" % (q, r.status_code), blocked(r))

        # ── ⑥ ไฟล์หน้าเว็บ พิมพ์ URL ตรง ๆ ต้องเข้าไม่ได้ ─────────────
        print("\n⑥ ไฟล์หน้าเว็บ — พิมพ์ URL ตรง ๆ ต้องเข้าไม่ได้")
        for p in ("/", "/app", "/checksheet", "/measure", "/admin/payments", "/welcome"):
            r = c.get(p)
            check("ไฟล์หน้า %s ต้องเข้าไม่ได้" % p, blocked(r))

        # ── ③ ตั๋วปลอม / ลายเซ็นผิด / หมดอายุ ───────────────────────
        print("\n③ ตั๋วที่ไม่ควรผ่าน")
        for bad, why in [("", "ไม่ส่งตั๋วมาเลย"),
                         ("x", "ตั๋วสั้นผิดปกติ"),
                         (secrets.token_urlsafe(32), "ตั๋วที่ Hub ไม่เคยออกให้"),
                         ("A" * 500, "ตั๋วยาวผิดปกติ")]:
            r = c.get("/sso?t=" + bad)
            check("ตั๋ว: %s -> ต้องไม่ได้เซสชัน" % why,
                  "/no-access" in (r.headers.get("location") or ""))

        expired = hub.issue("somchai", "staff", age_seconds=-1)   # ออกมาแล้วหมดอายุทันที
        r = c.get("/sso?t=" + expired)
        check("ตั๋วหมดอายุ -> ต้องไม่ได้เซสชัน",
              "/no-access" in (r.headers.get("location") or ""))

    # ── คุกกี้เซสชันที่ลายเซ็นผิด ต้องไม่ผ่าน ──────────────────────────
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        exp = int(time.time()) + 3600
        c.cookies.set(sso_gate.COOKIE_NAME, "hacker|admin|%d|deadbeef" % exp)
        r = c.get("/")
        check("คุกกี้ลายเซ็นมั่ว -> ต้องถูกปฏิเสธ", blocked(r))

    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        old = int(time.time()) - 10
        body = "somchai|admin|%d" % old
        sig = hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest()
        c.cookies.set(sso_gate.COOKIE_NAME, body + "|" + sig)
        r = c.get("/")
        check("คุกกี้ลายเซ็นถูกแต่หมดอายุ -> ต้องถูกปฏิเสธ", blocked(r))

    # ── ② ตั๋วถูกต้อง -> เข้าได้ ทุกเส้น ────────────────────────────
    print("\n② ตั๋วถูกต้อง — ต้องเข้าได้")
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        raw = hub.issue("somchai", "staff")
        r = c.get("/sso?t=" + raw)
        check("/sso ตั๋วดี -> ต้องเด้งเข้าหน้าหลัก",
              r.status_code == 302 and (r.headers.get("location") or "") == "/")
        check("/sso ตั๋วดี -> ต้องได้คุกกี้เซสชัน",
              sso_gate.COOKIE_NAME in c.cookies)
        check("/sso ตั๋วดี -> ต้องได้คุกกี้ vc_acc ของระบบเดิมด้วย",
              "vc_acc" in c.cookies)

        for p in GATED_PAGES:
            r = c.get(p)
            check("มีตั๋วแล้ว หน้า %s ต้องเข้าได้ (ได้ %d)" % (p, r.status_code),
                  r.status_code == 200)
        for p in GATED_APIS:
            r = c.get(p)
            check("มีตั๋วแล้ว API %s ต้องเข้าได้ (ได้ %d)" % (p, r.status_code),
                  r.status_code == 200)

        # ③ ใช้ตั๋วใบเดิมซ้ำครั้งที่ 2 -> ต้องไม่ผ่าน
        r2 = c.get("/sso?t=" + raw)
        check("ตั๋วใบเดิมใช้ครั้งที่ 2 -> ต้องไม่ผ่าน",
              "/no-access" in (r2.headers.get("location") or ""))

    # ── role=admin จาก Hub ต้องกลายเป็น admin ของแอป ─────────────────
    check("role 'administrator' จาก Hub -> แอปต้องมองเป็น admin",
          sso_gate._app_role("administrator") == "admin")
    check("role 'staff' จาก Hub -> แอปต้องมองเป็น internal",
          sso_gate._app_role("staff") == "internal")
    check("role ว่างจาก Hub -> แอปต้องมองเป็น internal (ไม่ใช่คนนอก)",
          sso_gate._app_role("") == "internal")

    # ── ⑦ ไม่ได้ตั้ง SSO_SHARED_KEY -> ปฏิเสธทุกคน ──────────────────
    print("\n⑦ ไม่ได้ตั้ง SSO_SHARED_KEY — ต้องปฏิเสธทุกคน")
    # 🔴 ข้อสำคัญที่สุดของหัวข้อนี้: "มีเซสชันที่ถูกต้องอยู่แล้ว" ก็ต้องใช้ต่อไม่ได้
    #    ถ้าไม่ทดสอบข้อนี้ ยามจะเขียวหลอก ๆ เพราะตัวทดสอบเปิดใหม่ก็ไม่มีคุกกี้อยู่แล้ว
    #    (ตอนซ้อม "ถอดโค้ดที่แก้ออก" รอบแรก ยามข้อนี้ไม่แดง จึงต้องเติมเข้ามา)
    live = TestClient(app, follow_redirects=False, base_url=HTTPS)
    live.__enter__()
    live.get("/sso?t=" + hub.issue("somchai", "staff"))
    check("(เตรียม) ยังมีคีย์อยู่ -> เซสชันใช้งานได้", live.get("/").status_code == 200)
    vc_only = TestClient(app, follow_redirects=False, base_url=HTTPS)
    vc_only.__enter__()
    vc_only.cookies.set("vc_acc", __import__("vectorcnc.auth", fromlist=["auth"])
                        .sign_internal("somchai", "internal", 12))
    check("(เตรียม) คุกกี้ vc_acc เดิม -> เซสชันใช้งานได้", vc_only.get("/").status_code == 200)

    saved = os.environ.pop("SSO_SHARED_KEY")
    check("ไม่มีคีย์ -> เซสชัน SSO ที่เคยถูกต้อง ต้องใช้ต่อไม่ได้", blocked(live.get("/")))
    check("ไม่มีคีย์ -> คุกกี้ vc_acc เดิม ต้องใช้ต่อไม่ได้เช่นกัน", blocked(vc_only.get("/")))
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        r = c.get("/sso?t=" + hub.issue("somchai", "staff"))
        check("ไม่มีคีย์ -> /sso ต้องไม่ออกเซสชันให้",
              "/no-access" in (r.headers.get("location") or ""))
        for p in ("/", "/app", "/api/whoami", "/admin/payments"):
            check("ไม่มีคีย์ -> %s ต้องถูกปฏิเสธ" % p, blocked(c.get(p)))
        check("ไม่มีคีย์ -> /api/health ต้องยังเข้าได้ (Render จะได้ไม่คิดว่าแอปตาย)",
              c.get("/api/health").status_code == 200)
    os.environ["SSO_SHARED_KEY"] = saved
    check("ตั้งคีย์กลับมา -> เซสชันเดิมใช้ได้อีกครั้ง", live.get("/").status_code == 200)
    live.__exit__(None, None, None)
    vc_only.__exit__(None, None, None)

    # ── CRM Hub ล่ม -> ต้องปฏิเสธ ไม่ใช่ปล่อยผ่าน ────────────────────
    print("\n⑧ CRM Hub ล่ม / ชี้ผิดที่ — ต้องปฏิเสธ ไม่ใช่ปล่อยผ่าน")
    saved_url = os.environ["SSO_HUB_URL"]
    os.environ["SSO_HUB_URL"] = "http://127.0.0.1:1"        # ไม่มีใครฟังพอร์ตนี้
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        r = c.get("/sso?t=" + hub.issue("somchai", "staff"))
        check("Hub ล่ม -> ต้องไม่ออกเซสชันให้",
              "/no-access" in (r.headers.get("location") or ""))
    os.environ["SSO_HUB_URL"] = saved_url

    os.environ["SSO_HUB_URL"] = ""                          # ไม่ได้ตั้ง URL เลย
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        r = c.get("/sso?t=" + hub.issue("somchai", "staff"))
        check("ไม่ได้ตั้ง SSO_HUB_URL -> ต้องไม่ออกเซสชันให้",
              "/no-access" in (r.headers.get("location") or ""))
    os.environ["SSO_HUB_URL"] = saved_url

    # ── คีย์ผิด -> Hub ต้องไม่ยอมรับ ────────────────────────────────
    check("ส่ง X-SSO-Key ผิด -> Hub ต้องปฏิเสธ",
          hub.verify("wrong-key", hub.issue("somchai", "staff")) is None)
    check("ไม่ส่ง X-SSO-Key -> Hub ต้องปฏิเสธ",
          hub.verify("", hub.issue("somchai", "staff")) is None)

    # ── 💳 เส้นลูกค้าที่จ่ายเงิน — เปิดได้เมื่อตั้ง SSO_PUBLIC_PAY=1 ──
    print("\n⑨ เส้นของลูกค้าที่จ่ายเงิน — ปิดเป็นค่าเริ่มต้น เปิดได้ด้วย SSO_PUBLIC_PAY=1")
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        check("ค่าเริ่มต้น /pay ต้องถูกปฏิเสธ", blocked(c.get("/pay")))
        check("ค่าเริ่มต้น /api/checkout ต้องถูกปฏิเสธ", blocked(c.get("/api/checkout")))
    os.environ["SSO_PUBLIC_PAY"] = "1"
    with TestClient(app, follow_redirects=False, base_url=HTTPS) as c:
        check("เปิดเส้นลูกค้าแล้ว /pay ต้องเข้าได้", c.get("/pay").status_code == 200)
        check("เปิดเส้นลูกค้าแล้ว /api/checkout ต้องเข้าได้",
              c.get("/api/checkout").status_code == 200)
        # 🔴 เปิดเส้นลูกค้า ต้องไม่พลอยเปิดเส้นพนักงานภายในไปด้วย
        for p in ("/", "/app", "/checksheet", "/measure",
                  "/admin/payments", "/api/price-catalog", "/api/stats"):
            check("เปิดเส้นลูกค้าแล้ว %s ของพนักงานต้องยังปิดอยู่" % p, blocked(c.get(p)))
    os.environ.pop("SSO_PUBLIC_PAY", None)

    srv.shutdown()

    print("\n" + "=" * 66)
    if _fail:
        print(" 🔴 ผ่าน %d ข้อ · ไม่ผ่าน %d ข้อ" % (_pass[0], len(_fail)))
        for f in _fail[:40]:
            print("    ❌ " + f)
        print("=" * 66)
        return 1
    print(" ✅ ผ่านครบ %d ข้อ — คนนอกเข้าไม่ได้จริง" % _pass[0])
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
