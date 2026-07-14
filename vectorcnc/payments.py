"""
payments.py — ระบบรับชำระเงิน 4 ช่องทาง

  1) PayPal        — บัตรเครดิต + PayPal wallet (ต่างชาติ) · ตัดอัตโนมัติทุกเดือน
  2) Omise Card    — บัตรเครดิต/เดบิต ไทย+ต่างชาติ · ตัดอัตโนมัติทุกเดือน
  3) Omise PromptPay — Thai QR · จ่ายเป็นรอบ (ตัดอัตโนมัติไม่ได้ตามกฎ)
  4) Omise Internet Banking — E-Banking ไทย · จ่ายเป็นรอบ
  5) โอนเงิน + อัปโหลดสลิป — แอดมินกดอนุมัติ

🔐 กฎเหล็ก
  - คีย์ทุกตัวอ่านจาก environment variable เท่านั้น (Render → Environment)
  - ห้าม hard-code, ห้าม log, ห้ามส่งกลับ frontend
  - ถ้ายังไม่ตั้งคีย์ ช่องทางนั้นจะ "ไม่ปรากฏ" ให้ลูกค้าเห็นเลย (available() กรองออก)

ENV ที่ต้องตั้ง (ดู docs/Payments_Setup.md)
  PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_MODE(live|sandbox),
  PAYPAL_PLAN_PRO, PAYPAL_PLAN_STUDIO, PAYPAL_WEBHOOK_ID
  OMISE_PUBLIC_KEY, OMISE_SECRET_KEY
  BANK_NAME, BANK_ACCOUNT_NAME, BANK_ACCOUNT_NO, PROMPTPAY_ID
  PAYMENTS_OPEN=1  (สวิตช์เปิดขายจริง — อยู่ใน billing.py)
"""

import os
import json
import base64
import urllib.request
import urllib.parse
import urllib.error

PAYMENTS_VERSION = "2026-07-14-paypal+omise+promptpay+transfer"

TIMEOUT = 25


# ================================================================ helper
def _env(k, d=""):
    return (os.environ.get(k, d) or "").strip()


def _post_json(url, payload, headers=None, auth=None):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if auth:
        tok = base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
        req.add_header("Authorization", "Basic " + tok)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def _post_form(url, fields, auth=None):
    """Omise API v2017 รับ form-encoded (แบบ nested ใช้ a[b]=c)"""
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if auth:
        tok = base64.b64encode(f"{auth}:".encode()).decode()
        req.add_header("Authorization", "Basic " + tok)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def _get(url, auth=None, headers=None):
    req = urllib.request.Request(url)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if auth:
        tok = base64.b64encode(f"{auth}:".encode()).decode()
        req.add_header("Authorization", "Basic " + tok)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


# ================================================================ 1) PayPal
def paypal_ready():
    return bool(_env("PAYPAL_CLIENT_ID") and _env("PAYPAL_SECRET"))


def _paypal_base():
    return ("https://api-m.paypal.com"
            if _env("PAYPAL_MODE", "sandbox").lower() == "live"
            else "https://api-m.sandbox.paypal.com")


def _paypal_token():
    url = _paypal_base() + "/v1/oauth2/token"
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    tok = base64.b64encode(f"{_env('PAYPAL_CLIENT_ID')}:{_env('PAYPAL_SECRET')}".encode()).decode()
    req.add_header("Authorization", "Basic " + tok)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode())["access_token"]


def paypal_plan_id(plan_key):
    """PayPal ต้องสร้าง 'Billing Plan' ไว้ก่อนในหน้าเว็บ PayPal แล้วเอา ID มาใส่ env"""
    return _env("PAYPAL_PLAN_" + plan_key.upper())


def paypal_create_subscription(plan_key, email, ref, return_url, cancel_url):
    """สร้าง subscription -> คืน URL ให้ลูกค้าไปกดอนุมัติ (ตัดบัตรอัตโนมัติทุกเดือน)"""
    pid = paypal_plan_id(plan_key)
    if not pid:
        raise RuntimeError(f"ยังไม่ได้ตั้ง PAYPAL_PLAN_{plan_key.upper()} ใน Render")

    at = _paypal_token()
    body = {
        "plan_id": pid,
        "custom_id": ref,                       # เอาไว้จับคู่กลับมาที่ order ของเรา
        "subscriber": {"email_address": email},
        "application_context": {
            "brand_name": "VectorCNC",
            "user_action": "SUBSCRIBE_NOW",
            "return_url": return_url,
            "cancel_url": cancel_url,
        },
    }
    j = _post_json(_paypal_base() + "/v1/billing/subscriptions", body,
                   headers={"Authorization": "Bearer " + at,
                            "Prefer": "return=representation"})
    link = ""
    for l in j.get("links", []):
        if l.get("rel") == "approve":
            link = l.get("href", "")
            break
    return {"id": j.get("id", ""), "approve_url": link, "status": j.get("status", "")}


def paypal_verify_webhook(headers, raw_body):
    """ตรวจว่า webhook มาจาก PayPal จริง (ห้ามเชื่อ body ลอย ๆ)"""
    wid = _env("PAYPAL_WEBHOOK_ID")
    if not wid:
        return False
    try:
        at = _paypal_token()
        body = {
            "auth_algo":         headers.get("paypal-auth-algo", ""),
            "cert_url":          headers.get("paypal-cert-url", ""),
            "transmission_id":   headers.get("paypal-transmission-id", ""),
            "transmission_sig":  headers.get("paypal-transmission-sig", ""),
            "transmission_time": headers.get("paypal-transmission-time", ""),
            "webhook_id":        wid,
            "webhook_event":     json.loads(raw_body or "{}"),
        }
        j = _post_json(_paypal_base() + "/v1/notifications/verify-webhook-signature",
                       body, headers={"Authorization": "Bearer " + at})
        return j.get("verification_status") == "SUCCESS"
    except Exception:
        return False


def paypal_cancel(sub_id, reason="user cancelled"):
    at = _paypal_token()
    _post_json(f"{_paypal_base()}/v1/billing/subscriptions/{sub_id}/cancel",
               {"reason": reason}, headers={"Authorization": "Bearer " + at})
    return True


# ================================================================ 2-4) Omise
OMISE_API = "https://api.omise.co"


def omise_ready():
    return bool(_env("OMISE_SECRET_KEY") and _env("OMISE_PUBLIC_KEY"))


def omise_public_key():
    """คีย์นี้เปิดเผยได้ (ใช้ใน browser ตอน tokenize บัตร) — คีย์ลับห้ามส่งออก"""
    return _env("OMISE_PUBLIC_KEY")


def _osec():
    return _env("OMISE_SECRET_KEY")


def omise_create_customer(email, card_token):
    """เก็บบัตรไว้กับ customer -> ใช้ตัดซ้ำทุกเดือนได้"""
    return _post_form(OMISE_API + "/customers",
                      {"email": email, "card": card_token}, auth=_osec())


def omise_charge_customer(customer_id, amount_thb, ref, desc=""):
    """ตัดบัตรที่ผูกไว้ (สตางค์! Omise ใช้หน่วยสตางค์ 690 บาท = 69000)"""
    return _post_form(OMISE_API + "/charges", {
        "amount": int(round(float(amount_thb) * 100)),
        "currency": "thb",
        "customer": customer_id,
        "description": desc or ref,
        "metadata[ref]": ref,
    }, auth=_osec())


def omise_create_schedule(customer_id, amount_thb, ref, every=1):
    """ตารางตัดเงินอัตโนมัติทุกเดือน (Omise Schedule API)"""
    return _post_form(OMISE_API + "/schedules", {
        "every": int(every),
        "period": "month",
        "on[days_of_month][]": 1,          # ตัดทุกวันที่ 1
        "start_date": "",                  # เว้นว่าง = เริ่มรอบถัดไป
        "charge[customer]": customer_id,
        "charge[amount]": int(round(float(amount_thb) * 100)),
        "charge[currency]": "thb",
        "charge[description]": "VectorCNC subscription " + ref,
    }, auth=_osec())


def omise_promptpay(amount_thb, ref):
    """สร้าง QR PromptPay -> คืน URL รูป QR ให้ลูกค้าสแกน"""
    src = _post_form(OMISE_API + "/sources", {
        "type": "promptpay",
        "amount": int(round(float(amount_thb) * 100)),
        "currency": "thb",
    }, auth=_osec())

    chg = _post_form(OMISE_API + "/charges", {
        "amount": int(round(float(amount_thb) * 100)),
        "currency": "thb",
        "source": src.get("id", ""),
        "metadata[ref]": ref,
        "description": "VectorCNC " + ref,
    }, auth=_osec())

    qr = ""
    try:
        qr = (chg.get("source") or {}).get("scannable_code", {}) \
                                      .get("image", {}).get("download_uri", "")
    except Exception:
        qr = ""
    return {"charge_id": chg.get("id", ""), "qr_url": qr,
            "status": chg.get("status", ""), "expires_at": chg.get("expires_at", "")}


# ธนาคารที่ Omise รองรับ internet banking
OMISE_BANKS = [
    {"code": "internet_banking_bay",  "name": "กรุงศรีอยุธยา (BAY)",   "name_en": "Krungsri"},
    {"code": "internet_banking_bbl",  "name": "กรุงเทพ (BBL)",         "name_en": "Bangkok Bank"},
    {"code": "mobile_banking_scb",    "name": "ไทยพาณิชย์ (SCB)",      "name_en": "SCB"},
    {"code": "mobile_banking_kbank",  "name": "กสิกรไทย (KBank)",      "name_en": "KBank"},
    {"code": "mobile_banking_bay",    "name": "กรุงศรี (mobile)",      "name_en": "Krungsri app"},
    {"code": "mobile_banking_ktb",    "name": "กรุงไทย (KTB)",         "name_en": "Krungthai"},
]


def omise_internet_banking(bank_code, amount_thb, ref, return_uri):
    """E-Banking — คืน URL ให้ redirect ไปหน้าธนาคาร"""
    src = _post_form(OMISE_API + "/sources", {
        "type": bank_code,
        "amount": int(round(float(amount_thb) * 100)),
        "currency": "thb",
    }, auth=_osec())

    chg = _post_form(OMISE_API + "/charges", {
        "amount": int(round(float(amount_thb) * 100)),
        "currency": "thb",
        "source": src.get("id", ""),
        "return_uri": return_uri,
        "metadata[ref]": ref,
        "description": "VectorCNC " + ref,
    }, auth=_osec())

    return {"charge_id": chg.get("id", ""),
            "authorize_uri": chg.get("authorize_uri", ""),
            "status": chg.get("status", "")}


def omise_get_charge(charge_id):
    return _get(f"{OMISE_API}/charges/{charge_id}", auth=_osec())


# ================================================================ 5) โอนเงิน + สลิป
def bank_info():
    """ข้อมูลบัญชีสำหรับหน้าโอนเงิน (ตั้งใน env ทั้งหมด)"""
    return {
        "bank":    _env("BANK_NAME", ""),
        "name":    _env("BANK_ACCOUNT_NAME", ""),
        "account": _env("BANK_ACCOUNT_NO", ""),
        "promptpay": _env("PROMPTPAY_ID", ""),
    }


def transfer_ready():
    b = bank_info()
    return bool(b["bank"] and b["account"])


# ================================================================ รวมช่องทางที่ "พร้อมใช้จริง"
def available(lang="th"):
    """คืนเฉพาะช่องทางที่ตั้งคีย์ครบแล้ว — ช่องที่ยังไม่ตั้งจะไม่โผล่ให้ลูกค้าเห็น"""
    out = []
    TH = (lang != "en")

    if paypal_ready():
        out.append({
            "id": "paypal", "auto": True,
            "label": "PayPal / บัตรเครดิตต่างประเทศ" if TH else "PayPal / International card",
            "note":  "ตัดอัตโนมัติทุกเดือน · ยกเลิกได้ตลอด" if TH else "Auto-renews monthly · cancel anytime",
            "icon": "🅿️", "currency": "USD",
        })

    if omise_ready():
        out.append({
            "id": "card", "auto": True,
            "label": "บัตรเครดิต / เดบิต" if TH else "Credit / debit card",
            "note":  "ตัดอัตโนมัติทุกเดือน · ยกเลิกได้ตลอด" if TH else "Auto-renews monthly · cancel anytime",
            "icon": "💳", "currency": "THB",
        })
        out.append({
            "id": "promptpay", "auto": False,
            "label": "พร้อมเพย์ (Thai QR)" if TH else "PromptPay (Thai QR)",
            "note":  "สแกนจ่าย · ต่ออายุเองทุกเดือน" if TH else "Scan to pay · renew manually",
            "icon": "📱", "currency": "THB",
        })
        out.append({
            "id": "ebanking", "auto": False,
            "label": "E-Banking (โอนผ่านแอปธนาคาร)" if TH else "Internet / mobile banking",
            "note":  "จ่ายผ่านแอปธนาคาร · ต่ออายุเองทุกเดือน" if TH else "Pay via your bank app · renew manually",
            "icon": "🏦", "currency": "THB", "banks": OMISE_BANKS,
        })

    if transfer_ready():
        out.append({
            "id": "transfer", "auto": False,
            "label": "โอนเงิน + แนบสลิป" if TH else "Bank transfer + upload slip",
            "note":  "แอดมินตรวจสลิปแล้วเปิดสิทธิ์ให้ (ภายใน 24 ชม.)" if TH
                     else "Admin verifies the slip and activates your plan (within 24 h)",
            "icon": "🧾", "currency": "THB", "bank": bank_info(),
        })

    return out


def status():
    """สรุปว่าอันไหนพร้อม/ยังไม่พร้อม — ใช้ในหน้าแอดมิน (ไม่เปิดเผยค่าคีย์)"""
    return {
        "paypal":   {"ready": paypal_ready(),
                     "mode": _env("PAYPAL_MODE", "sandbox"),
                     "plan_pro": bool(paypal_plan_id("pro")),
                     "plan_studio": bool(paypal_plan_id("studio"))},
        "omise":    {"ready": omise_ready()},
        "transfer": {"ready": transfer_ready(), "bank": bank_info()},
        "version":  PAYMENTS_VERSION,
    }
