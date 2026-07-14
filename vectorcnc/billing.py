"""
billing.py — แพ็กเกจ / สิทธิ์การใช้งาน / โควตา

แนวคิด: ทุกอย่างอยู่ใน PLANS จุดเดียว
  - ผู้ใช้ "ภายใน" (login ผ่าน CRM Hub)  -> plan = "internal" -> ฟรีทุกเมนู ไม่จำกัด
  - ผู้ใช้ "ภายนอก" (Google Sign-in)     -> free / pro / studio / enterprise

การเช็กสิทธิ์ต้องทำที่ backend เท่านั้น (frontend ซ่อนปุ่มได้ แต่กันคนโกงไม่ได้)
"""

BILLING_VERSION = "2026-07-14-plans-v1"

UNLIMITED = -1

# ---------------------------------------------------------------- ฟีเจอร์ทั้งหมดในระบบ
FEATURES = {
    "vectorize":  "⚡ แปลงเป็นเส้นตัด",
    "manual":     "📖 คู่มือ",
    "dl_svg":     "⬇ ดาวน์โหลด SVG",
    "dl_dxf":     "⬇ ดาวน์โหลด DXF",
    "layer_set":  "🏭 ชุดชั้นตัด + 3 มิติ",
    "nesting":    "▦ Nesting",
    "nest_multi": "🗂 Nesting หลายไฟล์",
    "intake":     "🚀 Intake Studio",
    "wall":       "📐 จำลองผนัง + ประเมินราคา",
    "stl":        "🧊 STL / Fusion 360",
    "checksheet": "📋 BOM Check Sheet",
    "stats":      "📊 สถิติการเข้าใช้งาน",
}

ALL = list(FEATURES.keys())

# 🔒 ฟีเจอร์ที่ "ห้ามคนนอกใช้เด็ดขาด" — มีต้นทุน/โครงสร้างราคาจริงของบริษัทอยู่ข้างใน
#    ต่อให้จ่ายแพงสุดก็ไม่เปิดให้ (internal / admin เท่านั้น)
INTERNAL_ONLY = ["wall", "checksheet", "stats"]


# ---------------------------------------------------------------- แพ็กเกจ
PLANS = {
    # 🏠 พนักงานบริษัท (เข้าผ่าน CRM Hub) — ฟรีทุกเมนู ไม่จำกัด
    "internal": {
        "label": "ภายในบริษัท",
        "price_usd": 0, "price_thb": 0,
        "public": False,                  # ไม่โชว์ในหน้าราคา
        "features": ALL,
        "quota": {},                      # ไม่นับอะไรเลย
        "watermark": False,
        "max_nest_files": UNLIMITED,
    },
    # 👑 แอดมิน (พี่ + ทีมดูแลระบบ)
    "admin": {
        "label": "ผู้ดูแลระบบ",
        "price_usd": 0, "price_thb": 0,
        "public": False,
        "features": ALL,
        "quota": {},
        "watermark": False,
        "max_nest_files": UNLIMITED,
    },

    # ---- ลูกค้าภายนอก ----
    "free": {
        "label": "Free",
        "price_usd": 0, "price_thb": 0,
        "public": True,
        "features": ["vectorize", "manual", "dl_svg"],
        "quota": {"vectorize": 5},        # 5 ครั้ง / เดือน
        "watermark": True,                # ไฟล์มีลายน้ำ
        "max_nest_files": 0,
    },
    "pro": {
        "label": "Pro",
        "price_usd": 19, "price_thb": 690,
        "public": True,
        "features": ["vectorize", "manual", "dl_svg", "dl_dxf",
                     "layer_set", "nesting", "intake", "checksheet"],
        "quota": {},
        "watermark": False,
        "max_nest_files": 1,
    },
    "studio": {
        "label": "Studio",
        "price_usd": 49, "price_thb": 1790,
        "public": True,
        "features": ["vectorize", "manual", "dl_svg", "dl_dxf", "layer_set",
                     "nesting", "nest_multi", "intake", "stl"],
        "quota": {},
        "watermark": False,
        "max_nest_files": 10,
    },
    "enterprise": {
        "label": "Enterprise",
        "price_usd": 0, "price_thb": 0,   # ติดต่อ
        "public": True,
        "contact": True,
        # ⚠️ ไม่รวม INTERNAL_ONLY — คนนอกจ่ายเท่าไหร่ก็ไม่ได้เห็นต้นทุนบริษัท
        "features": [f for f in ALL if f not in ("wall", "checksheet", "stats")],
        "quota": {},
        "watermark": False,
        "max_nest_files": UNLIMITED,
    },
}

DEFAULT_PLAN = "free"

# 🛡️ กันพลาด: ถ้าวันหลังมีคนเผลอใส่ wall/checksheet/stats ให้แพ็กเกจสาธารณะ
#    โค้ดจะดึงออกให้อัตโนมัติ (ต้นทุนบริษัทไม่มีวันหลุด)
for _k, _P in PLANS.items():
    if _P.get("public"):
        _P["features"] = [f for f in _P["features"] if f not in INTERNAL_ONLY]


# ---------------------------------------------------------------- helper
def plan_of(user):
    """user = dict จาก Sheet · คืนชื่อแพ็กเกจที่ 'ใช้ได้จริงตอนนี้'"""
    if not user:
        return DEFAULT_PLAN
    p = str(user.get("plan") or DEFAULT_PLAN).lower()
    if p not in PLANS:
        p = DEFAULT_PLAN
    # หมดอายุ -> ตกกลับเป็น free (ยกเว้น internal/admin ที่ไม่มีวันหมด)
    if p not in ("internal", "admin"):
        st = str(user.get("status") or "active").lower()
        if st in ("canceled", "expired", "past_due"):
            return DEFAULT_PLAN
    return p


def can(user, feature):
    """มีสิทธิ์ใช้ฟีเจอร์นี้ไหม"""
    return feature in PLANS[plan_of(user)]["features"]


def quota_limit(user, feature):
    """โควตาต่อเดือน · -1 = ไม่จำกัด"""
    q = PLANS[plan_of(user)].get("quota") or {}
    return q.get(feature, UNLIMITED)


def quota_left(user, feature, used):
    lim = quota_limit(user, feature)
    if lim == UNLIMITED:
        return UNLIMITED
    return max(0, lim - int(used or 0))


def watermark(user):
    return bool(PLANS[plan_of(user)].get("watermark"))


def max_nest_files(user):
    return PLANS[plan_of(user)].get("max_nest_files", 0)


def entitlements(user, usage=None):
    """สรุปสิทธิ์ทั้งหมดของ user (ให้ frontend เอาไปซ่อน/โชว์ปุ่ม)"""
    usage = usage or {}
    p = plan_of(user)
    P = PLANS[p]
    q = {}
    for f, lim in (P.get("quota") or {}).items():
        used = int(usage.get(f, 0))
        q[f] = {"limit": lim, "used": used, "left": max(0, lim - used)}
    return {
        "plan": p,
        "plan_label": P["label"],
        "internal": p in ("internal", "admin"),
        "is_admin": p == "admin",
        "features": P["features"],
        "locked": [f for f in ALL if f not in P["features"]],
        "quota": q,
        "watermark": bool(P.get("watermark")),
        "max_nest_files": P.get("max_nest_files", 0),
    }


def public_plans():
    """ตารางราคา (สำหรับหน้า Pricing)"""
    out = []
    for k, P in PLANS.items():
        if not P.get("public"):
            continue
        out.append({
            "key": k, "label": P["label"],
            "price_usd": P["price_usd"], "price_thb": P["price_thb"],
            "contact": bool(P.get("contact")),
            "features": [{"key": f, "label": FEATURES[f]} for f in P["features"]],
            "locked": [{"key": f, "label": FEATURES[f]}
                       for f in ALL if f not in P["features"]],
            "quota": P.get("quota") or {},
            "watermark": bool(P.get("watermark")),
        })
    return out


def upgrade_needed(feature):
    """ต้องอัปเป็นแพ็กเกจไหนถึงจะใช้ฟีเจอร์นี้ได้ (ตัวถูกที่สุด)"""
    order = ["free", "pro", "studio", "enterprise"]
    for k in order:
        if feature in PLANS[k]["features"]:
            return k
    return "enterprise"
