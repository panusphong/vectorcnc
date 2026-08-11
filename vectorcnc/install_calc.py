# -*- coding: utf-8 -*-
"""
install_calc.py — คำนวณ "งานติดตั้งป้าย" ตามมาตรฐานจริง
   แรงลม → แรงที่จุดยึด → เลือกพุก → ออก BOQ ที่ต่างกันจริงตามประเภทป้าย

═══════════════════════════════════════════════════════════════════════════
ทำไมต้องมีไฟล์นี้ (ผู้ใช้สั่ง 2026-08-11):
   ของเดิม BOQ ออกมา "เหมือนกันหมดทุกประเภทป้าย" และเลือกขนาดพุกด้วยเงื่อนไข
   บรรทัดเดียว (M10 ถ้า ≤60 กก. ไม่งั้น M12) ซึ่งไม่ได้คิดแรงลม ไม่ได้คิดชนิดผนัง
   ไม่ได้คิดความสูงติดตั้ง และไม่ได้คิดโมเมนต์จากป้ายที่ยื่นออกจากผนัง
   -> ตัวเลขไม่มีที่มา ใช้ยืนยันกับลูกค้า/วิศวกรไม่ได้

ทุกค่าคงที่ในไฟล์นี้มี "ที่มา" กำกับไว้ทุกบรรทัด ถ้าไม่มีที่มา = ห้ามใส่
═══════════════════════════════════════════════════════════════════════════

หน่วยภายในไฟล์: เมตร · ตร.ม. · กก. · kN · kPa
"""

import math

G = 9.80665                       # m/s² — ความเร่งโน้มถ่วง


# ══════════════════════════════════════════════════════════════════════════
# 1) แรงลม
# ══════════════════════════════════════════════════════════════════════════
# 📕 กฎกระทรวง ฉบับที่ 6 (พ.ศ. 2527) ออกตาม พ.ร.บ. ควบคุมอาคาร ข้อ 17
#    หน่วยแรงลมขั้นต่ำ "ตามกฎหมายไทย" — ต้องใช้เป็นค่าพื้นเสมอ ห้ามคิดต่ำกว่านี้
#    (กก./ตร.ม. ตามความสูงจากระดับพื้นดิน)
LAW_WIND_KGSQM = [(10.0, 50.0), (20.0, 80.0), (40.0, 120.0), (1e9, 160.0)]

# 📗 มยผ. 1311-50 (กรมโยธาธิการและผังเมือง) — หน่วยแรงลมอ้างอิง q = ½ρV²
#    กลุ่มพื้นที่ตามความเร็วลมอ้างอิง V50
WIND_ZONE = {
    "central": {"th": "ภาคกลาง/กรุงเทพฯ และปริมณฑล", "v50": 25.0, "tf": 1.00},
    "north_low": {"th": "ภาคเหนือตอนล่าง/ชายแดน ตอ.-ตต.", "v50": 27.0, "tf": 1.00},
    "north_up": {"th": "ภาคเหนือตอนบน", "v50": 29.0, "tf": 1.00},
    "south_e": {"th": "ชายฝั่งตะวันออกภาคใต้", "v50": 25.0, "tf": 1.20},
    "south_w": {"th": "เพชรบุรี/ชายฝั่งตะวันตกภาคใต้", "v50": 25.0, "tf": 1.08},
}
RHO_AIR = 1.25                    # กก./ลบ.ม. — มยผ. 1311-50
CG_SIGN = 2.35                    # ตัวประกอบเนื่องจากลมกระโชก "ป้ายและกำแพงอิสระ" — มยผ. 1311-50
CG_CLAD = 2.50                    # ตัวประกอบสำหรับผนัง/ชิ้นส่วนรอง (cladding)
CP_FACE = 1.20                    # ค่าสัมประสิทธิ์หน่วยแรงลม กลางผนัง
CP_EDGE = 1.80                    # ขอบ/มุมอาคาร (สอดคล้อง cf = 1.80 ของ EN 1991-1-4 §7.4.3)
IW_NORMAL = 1.00                  # ตัวประกอบความสำคัญ ระดับปกติ (ULS) — มยผ. 1311-50


def _ce(height_m, terrain="B"):
    """ตัวประกอบเนื่องจากสภาพภูมิประเทศ Ce — มยผ. 1311-50
       A = พื้นที่โล่ง · B = ชานเมือง/ในเมือง (งานป้ายส่วนใหญ่คือ B)"""
    z = max(1.0, float(height_m))
    if str(terrain).upper() == "A":
        return max(0.9, (z / 10.0) ** 0.20)
    return max(0.7, 0.7 * (z / 12.0) ** 0.30)


def _law_min_kpa(height_m):
    """หน่วยแรงลมขั้นต่ำตามกฎกระทรวง ฉ.6 ข้อ 17 (คืน kPa)"""
    h = max(0.0, float(height_m))
    for lim, kg in LAW_WIND_KGSQM:
        if h <= lim:
            return kg * G / 1000.0
    return LAW_WIND_KGSQM[-1][1] * G / 1000.0


def wind_pressure(height_m=3.0, outdoor=True, zone="central", terrain="B", at_edge=False):
    """หน่วยแรงลมออกแบบ (kPa) — คืน dict พร้อม 'ที่มา' ให้พิมพ์ลงใบสเปกได้

    ป้ายในร่ม: ไม่มีแรงลม (มาตรฐานแรงลมทุกฉบับใช้กับผิวภายนอกเท่านั้น)
    ป้ายกลางแจ้ง: ใช้ค่าที่ "มากกว่า" ระหว่าง (ก) กฎกระทรวง ฉ.6  (ข) มยผ. 1311-50
    """
    if not outdoor:
        return {"kpa": 0.0, "kgsqm": 0.0, "indoor": True,
                "note": "ป้ายในร่ม — ไม่คิดแรงลม (มาตรฐานแรงลมใช้กับผิวภายนอกอาคารเท่านั้น)"}
    z = WIND_ZONE.get(str(zone), WIND_ZONE["central"])
    v = float(z["v50"])
    q = 0.5 * RHO_AIR * v * v / 1000.0            # kPa
    ce = _ce(height_m, terrain)
    cg = CG_CLAD if at_edge else CG_SIGN
    cp = CP_EDGE if at_edge else CP_FACE
    p_std = IW_NORMAL * q * ce * cg * cp * float(z["tf"])
    p_law = _law_min_kpa(height_m)
    p = max(p_std, p_law)
    src = ("กฎกระทรวง ฉ.6 ข้อ 17 (ค่าขั้นต่ำตามกฎหมาย)" if p_law >= p_std
           else "มยผ. 1311-50")
    return {"kpa": round(p, 3), "kgsqm": round(p * 1000.0 / G, 1), "indoor": False,
            "q_kpa": round(q, 3), "ce": round(ce, 3), "cg": cg, "cp": cp,
            "zone": z["th"], "v50": v, "governed_by": src,
            "note": ("แรงลมออกแบบ %.0f กก./ตร.ม. ที่ความสูง %.1f ม. · %s · "
                     "q=%.2f kPa (V50 %.0f m/s) × Ce %.2f × Cg %.2f × Cp %.2f — เกณฑ์ที่คุม: %s"
                     % (p * 1000.0 / G, float(height_m), z["th"], q, v, ce, cg, cp, src))}


# ══════════════════════════════════════════════════════════════════════════
# 2) พุกยึดผนัง
# ══════════════════════════════════════════════════════════════════════════
# 📘 ตารางพุกเคมี (injection anchor) — fischer FIS V Plus + เกลียว FIS A เกรด 5.8
#    ค่าที่ใช้คือ Nperm / Vperm = "แรงที่ยอมให้ใช้งาน" ตาม EN 1992-4:2018
#    (มีตัวประกอบความปลอดภัยฝังอยู่แล้ว — ห้ามหารซ้ำด้วย 4 อีก มิฉะนั้นจะอนุรักษ์เกินจริง 4 เท่า)
#    คอนกรีต C20/25 · hef = ระยะฝังมาตรฐาน
ANCHORS = [
    # ขนาด  hef  hmin  cmin  smin  Tinst  N_uncracked  N_cracked  V     (kN)
    {"size": "M8",  "hef": 80,  "hmin": 110, "cmin": 40, "smin": 40, "tq": 10,
     "n_unc": 9.0,  "n_cr": 5.3,  "v": 6.3,  "drill": 10},
    {"size": "M10", "hef": 90,  "hmin": 120, "cmin": 45, "smin": 50, "tq": 20,
     "n_unc": 13.8, "n_cr": 8.1,  "v": 9.7,  "drill": 12},
    {"size": "M12", "hef": 110, "hmin": 140, "cmin": 45, "smin": 60, "tq": 40,
     "n_unc": 20.5, "n_cr": 12.8, "v": 14.3, "drill": 14},
    {"size": "M16", "hef": 125, "hmin": 170, "cmin": 50, "smin": 65, "tq": 60,
     "n_unc": 32.7, "n_cr": 18.0, "v": 26.9, "drill": 18},
]

# 📙 ตัวคูณกำลังตามชนิดผนัง — อ้างอิงสัดส่วนจากตาราง fischer DuoPower
#    (คอนกรีต = 1.00) · ผนังกลวง/ยิปซัมต้องเปลี่ยนชนิดพุก ไม่ใช่แค่ลดค่า
SUBSTRATE = {
    "concrete":  {"th": "คอนกรีต / เสา-คานคอนกรีต", "k": 1.00, "anchor": "chem",
                  "note": "พุกเคมี (injection anchor) ตามตาราง fischer FIS V Plus / Hilti HIT-HY 200"},
    "brick":     {"th": "อิฐมอญตัน / คอนกรีตบล็อกตัน", "k": 0.50, "anchor": "chem_sleeve",
                  "note": "พุกเคมี + ปลอกตะแกรง (sleeve) — ปูนเคมีเปล่าใช้กับผนังก่อไม่ได้"},
    "hollow":    {"th": "อิฐกลวง / บล็อกกลวง", "k": 0.30, "anchor": "chem_sleeve",
                  "note": "ต้องใช้ปลอกตะแกรงเสมอ · ค่ารับน้ำหนักขึ้นกับรุ่นอิฐ ให้ทดสอบดึงหน้างาน"},
    "aac":       {"th": "อิฐมวลเบา (AAC)", "k": 0.30, "anchor": "aac",
                  "note": "ใช้พุกเฉพาะอิฐมวลเบา (เกลียวปล่อยหรือพุกเคมีร่วมปลอก) ห้ามใช้พุกเหล็กตอก"},
    "gypsum":    {"th": "ผนังเบา ยิปซัมบอร์ด", "k": 0.15, "anchor": "stud",
                  "note": "⚠️ ยิปซัมรับน้ำหนักป้ายไม่ได้ — ต้องยึดเข้าโครงคร่าวเหล็ก/ไม้ หรือเสริมแผ่นรองหลัง"},
    "steel":     {"th": "โครงเหล็ก / เสาเหล็ก", "k": 1.00, "anchor": "bolt",
                  "note": "ไม่ใช้พุก — เจาะ/ต๊าปเกลียวหรือเชื่อม คำนวณตาม AISC/EN 1993-1-8"},
}

# 📕 IBC Appendix H111.2 — ป้ายติดผนังก่ออิฐ/คอนกรีต/หิน:
#    ขนาดพุกขั้นต่ำ Ø 3/8 นิ้ว (9.5 มม.) ระยะฝังขั้นต่ำ 5 นิ้ว (127 มม.)
IBC_MIN_DIA_MM = 9.5
IBC_MIN_EMBED_MM = 127.0


def pick_anchor(n_kn, v_kn, substrate="concrete", per_plate=4, cracked=True,
                outdoor=True, enforce_ibc=True):
    """เลือกพุกที่ 'รับแรงจริงได้' — คืน dict พร้อมอัตราการใช้งาน (utilisation)

    n_kn / v_kn = แรงดึง / แรงเฉือน ต่อ "จุดยึด 1 จุด (1 เพลท)" หน่วย kN
    per_plate   = จำนวนพุกต่อเพลท (งานป้ายใช้ 4 เมื่อรับโมเมนต์ · 2 เมื่อเฉือนล้วน)

    เกณฑ์รวมแรงดึง+เฉือน: N/Nperm + V/Vperm ≤ 1.2 (ACI 318-19 §17.8.3)
    """
    sub = SUBSTRATE.get(str(substrate), SUBSTRATE["concrete"])
    k = float(sub["k"])
    npl = max(2, int(per_plate))
    n1 = max(0.0, float(n_kn)) / npl                # แรงต่อพุก 1 ตัว
    v1 = max(0.0, float(v_kn)) / npl
    # 📕 IBC App. H111.2 — ป้ายกลางแจ้งยึดผนังก่อ/คอนกรีต ห้ามใช้พุกเล็กกว่า Ø 3/8" (9.5 มม.)
    #    ต่อให้คำนวณแล้วแรงน้อยมากก็ตาม (กันงานติดตั้งที่ "ผ่านสูตรแต่ไม่ผ่านมาตรฐาน")
    _min_d = (IBC_MIN_DIA_MM if (enforce_ibc and outdoor
                                 and sub["anchor"] in ("chem", "chem_sleeve")) else 0.0)
    for a in ANCHORS:
        if float(a["size"][1:]) < _min_d:
            continue
        cap_n = (a["n_cr"] if cracked else a["n_unc"]) * k
        cap_v = a["v"] * k
        if cap_n <= 0 or cap_v <= 0:
            continue
        util = (n1 / cap_n) + (v1 / cap_v)
        if util <= 1.2:
            _emb = float(a["hef"])
            _warn = []
            if _min_d > 0 and _emb < IBC_MIN_EMBED_MM:
                _warn.append("IBC App.H111.2 กำหนดระยะฝัง ≥ 127 มม. สำหรับป้ายผนังก่ออิฐ/คอนกรีต "
                             "— พุกเคมีให้กำลังพอที่ %d มม. แล้ว แต่ถ้าผู้ตรวจอ้าง IBC ให้เจาะลึกเป็น 127 มม."
                             % int(_emb))
            if not bool(sub["k"] >= 1.0) and sub["anchor"] != "bolt":
                _warn.append("ผนัง%s รับน้ำหนักได้ %.0f%% ของคอนกรีต — แนะนำให้ทดสอบดึงพุก (pull-out test) "
                             "อย่างน้อย 1 จุดก่อนติดตั้งจริง" % (sub["th"], sub["k"] * 100))
            return {"size": a["size"], "hef_mm": a["hef"], "hmin_mm": a["hmin"],
                    "cmin_mm": a["cmin"], "smin_mm": a["smin"], "drill_mm": a["drill"],
                    "torque_nm": a["tq"], "per_plate": npl,
                    "cap_n_kn": round(cap_n, 2), "cap_v_kn": round(cap_v, 2),
                    "use_n_kn": round(n1, 3), "use_v_kn": round(v1, 3),
                    "util": round(util, 2), "ok": True,
                    "kind": sub["anchor"], "substrate": sub["th"], "sub_note": sub["note"],
                    "warn": _warn,
                    "ccr_mm": int(round(1.5 * a["hef"])), "scr_mm": int(round(3.0 * a["hef"]))}
    a = ANCHORS[-1]
    cap_n = (a["n_cr"] if cracked else a["n_unc"]) * k
    cap_v = a["v"] * k
    return {"size": a["size"], "hef_mm": a["hef"], "hmin_mm": a["hmin"],
            "cmin_mm": a["cmin"], "smin_mm": a["smin"], "drill_mm": a["drill"],
            "torque_nm": a["tq"], "per_plate": npl,
            "cap_n_kn": round(cap_n, 2), "cap_v_kn": round(cap_v, 2),
            "use_n_kn": round(n1, 3), "use_v_kn": round(v1, 3),
            "util": round((n1 / max(cap_n, 1e-6)) + (v1 / max(cap_v, 1e-6)), 2), "ok": False,
            "kind": sub["anchor"], "substrate": sub["th"], "sub_note": sub["note"],
            "warn": ["⚠️ แรงเกินกว่าพุกเบอร์ใหญ่สุดในตารางจะรับได้ — ต้องเพิ่มจุดยึด "
                     "หรือให้วิศวกรออกแบบฐานยึดเฉพาะงาน"],
            "ccr_mm": int(round(1.5 * a["hef"])), "scr_mm": int(round(3.0 * a["hef"]))}


def plate_loads(total_kg, face_area_m2, wind_kpa, supports=2, ecc_m=0.0, arm_len_m=0.0):
    """แรงที่ลงจุดยึดแต่ละจุด (kN)

    · แรงดิ่ง (น้ำหนักป้าย) -> แรงเฉือนที่พุก
    · แรงลม -> แรงดึงออกจากผนัง (คิดโมเมนต์จากระยะยื่นด้วย)
    · ป้ายที่ยื่นจากผนัง (แขน) น้ำหนักตัวเองก็สร้างโมเมนต์ดึงพุกแถวบน
      โมเมนต์ M = W·e ถูกแปลงเป็นคู่แรงบนเพลทสูง h_plate
    """
    ns = max(1, int(supports))
    w_kn = max(0.0, float(total_kg)) * G / 1000.0
    v_per = w_kn / ns                                   # เฉือน (น้ำหนักป้าย)
    f_wind_kn = max(0.0, float(wind_kpa)) * max(0.0, float(face_area_m2))
    n_wind = f_wind_kn / ns                             # ดึงตรง ๆ จากแรงลม
    # โมเมนต์จากระยะยื่น (น้ำหนักป้าย + แรงลม) -> คู่แรงบน/ล่างของเพลท
    e = max(0.0, float(ecc_m)) + max(0.0, float(arm_len_m)) * 0.5
    h_plate = 0.10                                      # เพลทมาตรฐาน 100 มม. -> lever arm
    n_mom = (w_kn * e) / (h_plate * ns) if e > 0 else 0.0
    return {"tension_kn": round(n_wind + n_mom, 3), "shear_kn": round(v_per, 3),
            "wind_force_kn": round(f_wind_kn, 3), "weight_kn": round(w_kn, 3),
            "supports": ns, "ecc_m": round(e, 3),
            "note": ("แรงลมรวม %.2f kN (%.0f กก.) + โมเมนต์จากระยะยื่น %.2f ม. "
                     "-> ดึงต่อจุด %.2f kN · เฉือนต่อจุด %.2f kN"
                     % (f_wind_kn, f_wind_kn * 1000.0 / G, e,
                        n_wind + n_mom, v_per))}


# ══════════════════════════════════════════════════════════════════════════
# 3) ค่าคงที่วัสดุสิ้นเปลือง (มีที่มาทุกตัว)
# ══════════════════════════════════════════════════════════════════════════
# 📗 Kobelco Welding — ปริมาณธูปเชื่อม (SMAW) ต่อเมตรของรอยเชื่อมฟิลเลต
#    ท่อเหล็กกล่องผนังบาง 1.2-2.3 มม. ใช้ขาเชื่อม 3 มม. => 0.08 กก./ม.
WELD_KG_PER_M = {3: 0.08, 4: 0.14, 5: 0.22, 6: 0.31}
# 📗 Swift Supplies — ซิลิโคนหลอด 300 มล. บีด 6×6 มม. ได้ 8.3 ม. (ยังไม่เผื่อเสีย)
SIL_M_PER_TUBE = 8.3
SIL_WASTE = 1.15                    # เผื่อของเสีย 15% ตามที่ตารางระบุ
# 📗 สเปรย์กันสนิม 400 มล. ทา 2 เที่ยว ได้ราว 1 ตร.ม. (YourSprayPaints)
SPRAY_M2_PER_CAN = 1.0
# 📘 NEC 334.30 — ระยะรองรับสายสูงสุด 1.4 ม. · ปฏิบัติงานจริงในตู้ป้ายรัดทุก 300 มม.
TIE_SPACING_M = 0.30
# 📘 NEC 600.5(B) — วงจรป้าย ≤ 20 A และเป็น continuous load คิด 125%
CIRCUIT_A = 20.0
CONT_FACTOR = 1.25


def _tube_perimeter_m(tube):
    """เส้นรอบรูปหน้าตัดเหล็กกล่อง (ม.) — ใช้คิดความยาวรอยเชื่อมต่อ 1 รอยต่อ"""
    b = float((tube or {}).get("b") or 25.4)
    return 4.0 * b / 1000.0


# ══════════════════════════════════════════════════════════════════════════
# 4) BOQ — แยกตามประเภทป้ายจริง
# ══════════════════════════════════════════════════════════════════════════
def sign_profile(rec):
    """อ่าน 'ลักษณะงาน' จากตาราง SIGN_TYPES -> ใช้ตัดสินว่าต้องใช้ของอะไรบ้าง"""
    r = rec or {}
    lit = not bool(r.get("no_light"))
    return {
        "lit": lit,
        "per_letter": bool(r.get("per_letter")),          # ตัวอักษรแยกชิ้น
        "box": bool(r.get("box_shape")) or bool(r.get("wrap")),
        "two_face": "2 หน้า" in str(r.get("name", "")),
        "flat": bool(r.get("flat")),
        "neon": bool(r.get("neon")),
        "back_lit": bool(r.get("back_lit")),
        "edge_lit": bool(r.get("edge_lit")),
        "standee": bool(r.get("standee")),
        "mount_frame": bool(r.get("mount_frame")),
        "punch": bool(r.get("punch_face")),
        "depth_cm": float(r.get("depth_cm") or 0.0),
        "name": str(r.get("name", "")),
    }


def boq(rec=None, total_kg=0.0, face_area_m2=0.0, perimeter_m=0.0,
        frame_len_m=0.0, frame_tube=None, supports=2, bolts=0, wires=0,
        letters=0, led_m=0.0, transformer_w=0, arm=None,
        outdoor=True, substrate="concrete", install_h_m=3.0, zone="central",
        mount="none", depth_cm=0.0, anchor=None, wind=None):
    """🧾 BOQ อุปกรณ์สิ้นเปลืองงานติดตั้ง — ออกเฉพาะของที่ป้ายแบบนี้ต้องใช้จริง

    ทุกบรรทัดมี note บอกที่มาของจำนวน (คิดจากอะไร × เท่าไหร่) ให้ช่างตรวจย้อนได้
    """
    p = sign_profile(rec)
    o = []

    def add(name, qty, unit, note, tag=""):
        if qty and float(qty) > 0:
            q = float(qty)
            o.append({"name": name, "qty": (int(q) if q.is_integer() else round(q, 2)),
                      "unit": unit, "note": note, "tag": tag})

    _sup = max(1, int(supports or 1))
    _kg = max(0.0, float(total_kg))
    _wet = bool(outdoor)
    sub = SUBSTRATE.get(str(substrate), SUBSTRATE["concrete"])
    _std = bool(p["standee"])

    # ── (ก) ยึดเข้าผนัง/เพดาน — ขึ้นกับชนิดผนังและแรงจริง ──────────────────
    if not _std:
        a = anchor or {}
        _n_anch = int(a.get("per_plate") or 4) * _sup
        _sz = a.get("size") or "M10"
        if sub["anchor"] == "chem":
            add("พุกเคมี %s + เกลียว + แหวน + น็อต (ฝัง %s มม.)"
                % (_sz, a.get("hef_mm", 90)), _n_anch, "ชุด",
                "จุดยึด %d จุด × %d ตัว/เพลท · รับดึง %.2f/ตัว (พิกัด %.2f kN) · เจาะ Ø%s มม. ขัน %s N·m"
                % (_sup, int(a.get("per_plate") or 4), a.get("use_n_kn", 0),
                   a.get("cap_n_kn", 0), a.get("drill_mm", "-"), a.get("torque_nm", "-")), "anchor")
            add("หลอดปูนเคมี (injection) 300-345 มล.",
                max(1, int(math.ceil(_n_anch / 12.0))), "หลอด",
                "1 หลอดฉีดได้ราว 12 รู ที่ระยะฝัง %s มม." % a.get("hef_mm", 90), "anchor")
        elif sub["anchor"] == "chem_sleeve":
            add("พุกเคมี %s + ปลอกตะแกรง (sleeve) + เกลียว" % _sz, _n_anch, "ชุด",
                "%s — ปูนเคมีเปล่าใช้กับผนังก่อไม่ได้ ต้องมีปลอกตะแกรง" % sub["th"], "anchor")
            add("หลอดปูนเคมี (injection) 300-345 มล.",
                max(1, int(math.ceil(_n_anch / 8.0))), "หลอด",
                "ผนังก่อกินปูนมากกว่าคอนกรีต — 1 หลอดต่อ 8 รู", "anchor")
        elif sub["anchor"] == "aac":
            add("พุกอิฐมวลเบาโดยเฉพาะ (เกลียวปล่อย/พุกไนลอนยาว)", _n_anch, "ชุด",
                "%s — ห้ามใช้พุกเหล็กตอก จะทำให้อิฐแตก" % sub["th"], "anchor")
        elif sub["anchor"] == "stud":
            add("สกรูยึดโครงคร่าว + แผ่นรองหลังไม้อัด/เหล็ก", _n_anch, "ชุด",
                "%s — ต้องยึดเข้าโครงคร่าว ห้ามยึดกับแผ่นยิปซัมโดยตรง" % sub["th"], "anchor")
        else:                                        # steel
            add("สลักเกลียว %s เกรด 8.8 + แหวนสปริง + น็อต" % _sz, _n_anch, "ชุด",
                "ยึดเข้าโครงเหล็กเดิม — เจาะ/ต๊าปเกลียว ไม่ใช้พุก", "anchor")
        _pl_t = 4 if _kg <= 60 else 6
        add("เพลทเหล็กยึดผนัง 100×100×%d มม. (ชุบกันสนิม)" % _pl_t, _sup, "แผ่น",
            "1 แผ่นต่อ 1 จุดยึด · หนา %d มม. ตามน้ำหนักป้าย %.1f กก." % (_pl_t, _kg), "anchor")

    # ── (ข) ยึดตัวป้ายเข้าโครง — ต่างกันตามชนิดงาน ─────────────────────────
    if p["per_letter"] or p["back_lit"]:
        # 📗 อุตสาหกรรมป้าย: ตัวอักษรยึดด้วย stud/เกลียวหลังตัว ตัวละ 2 จุดขึ้นไป
        _ns = max(2, int(round(2 + (letters or 0) * 0.0)))
        add("สตัดเกลียว (mounting stud) M5/M6 + น็อตหลังผนัง",
            int(max(1, letters) * _ns), "ตัว",
            "ตัวอักษร %d ตัว × %d จุด/ตัว (ต่ำกว่านี้ตัวอักษรจะหมุน)" % (max(1, letters), _ns), "letter")
        if p["back_lit"]:
            add("ตัวเว้นระยะ (standoff) 25-40 มม.", int(max(1, letters) * _ns), "ตัว",
                "ป้ายไฟออกหลังต้องเว้นผนัง ให้แสงกระจายหลังตัวอักษร", "letter")
        add("แม่แบบเจาะ (template) พิมพ์ 1:1", 1, "ชุด",
            "ตัวอักษรแยกชิ้น ต้องมีแม่แบบเจาะ ไม่งั้นแนวเบี้ยว", "letter")
    if bolts:
        add("สกรู/น็อต M3 + แหวน (ยึดชิ้นงานเข้าโครง)", int(math.ceil(bolts * 1.1)), "ตัว",
            "รูน็อตในแบบ %d รู + เผื่อเสียหาย 10%%" % int(bolts), "frame")

    # ── (ค) งานไฟฟ้า — เฉพาะป้ายมีไฟ (NEC Art.600) ─────────────────────────
    if p["lit"] and (led_m or transformer_w):
        _wire_m = max(frame_len_m, perimeter_m) * 1.2 + float(install_h_m) + 3.0
        add("สายไฟ VCT 2×1.5 ตร.มม.%s" % (" (กันน้ำ)" if _wet else ""),
            math.ceil(_wire_m), "เมตร",
            "เดินตามโครง %.1f ม. × 1.2 + ลงจุดจ่ายไฟ %.1f ม. + เผื่อ 3 ม."
            % (max(frame_len_m, perimeter_m), float(install_h_m)), "elec")
        if wires:
            add("ยางกันน้ำ/grommet รูสายไฟ", int(wires), "ตัว",
                "1 ตัวต่อ 1 รูสายไฟ — กันสายบาดกับขอบเหล็ก", "elec")
            if _wet:
                add("ข้อต่อสายไฟกันน้ำ IP65", int(wires), "ตัว",
                    "ป้ายกลางแจ้ง = wet location ตาม NEC 600.9(D)", "elec")
        if transformer_w:
            _nps = max(1, int(math.ceil(float(transformer_w) / 300.0)))
            add("กล่องกันน้ำใส่หม้อแปลง" if _wet else "กล่องพักสายใส่หม้อแปลง", _nps, "ใบ",
                "หม้อแปลงรวม %d W (ไม่เกิน 300 W/กล่อง)" % int(transformer_w), "elec")
            _amp = float(transformer_w) * CONT_FACTOR / 220.0
            add("เบรกเกอร์ %dA + สวิตช์ตัดตอน (disconnect) ล็อกได้" %
                max(6, int(math.ceil(_amp / 2.0) * 2)), 1, "ชุด",
                "NEC 600.6(A)(1): ต้องมี disconnect ในระยะสายตา · โหลด %d W × 1.25 = %.1f A"
                % (int(transformer_w), _amp), "elec")
            add("สายดิน (bonding) ทองแดง ≥ 2.0 ตร.มม. (14 AWG)",
                math.ceil(max(frame_len_m, perimeter_m) + 3.0), "เมตร",
                "NEC 600.7(B): ต้อง bond โลหะทุกชิ้นของป้ายเข้าสายดิน", "elec")
        if _wet:
            add("เบรกเกอร์กันดูด (RCD/GFCI) 30 mA", 1, "ชุด",
                "ป้ายกลางแจ้ง/ที่ชื้น — NEC 600.10(C)", "elec")
        if led_m:
            add("เคเบิลไทร์ 200 มม.", int(math.ceil(float(led_m) / TIE_SPACING_M)), "เส้น",
                "รัดทุก %.0f ซม. ตลอดแนวไฟ %.1f ม. (NEC 334.30 กำหนดไม่เกิน 1.4 ม.)"
                % (TIE_SPACING_M * 100, float(led_m)), "elec")
        add("เทปพันสายไฟ", max(1, int(math.ceil((int(wires) + 4) / 20.0))), "ม้วน",
            "1 ม้วนต่อจุดต่อสาย 20 จุด", "elec")

    # ── (ง) งานโครงเหล็ก — เฉพาะงานที่มีโครง ───────────────────────────────
    if frame_len_m > 0 and not p["flat"] and not _std:
        _leg = 3 if float((frame_tube or {}).get("t") or 1.2) <= 2.5 else 4
        _joints = max(2, int(round(frame_len_m / 0.6)))       # รอยต่อเฉลี่ยทุก 60 ซม.
        _weld_m = _joints * _tube_perimeter_m(frame_tube)
        add("ลวดเชื่อม %d มม." % (2 if _leg <= 3 else 3),
            round(_weld_m * WELD_KG_PER_M[_leg], 2), "กก.",
            "รอยต่อ %d จุด × เส้นรอบรูปท่อ %.0f มม. = เชื่อม %.1f ม. × %.2f กก./ม. (ขา %d มม. · Kobelco)"
            % (_joints, _tube_perimeter_m(frame_tube) * 1000, _weld_m,
               WELD_KG_PER_M[_leg], _leg), "steel")
        add("ใบตัดไฟเบอร์ 4 นิ้ว", max(1, int(math.ceil(frame_len_m / 8.0))), "ใบ",
            "เหล็กยาวรวม %.1f ม. — ประมาณ 1 ใบต่อ 8 ม. (ปรับตามของจริงหน้างานได้)" % frame_len_m, "steel")
        _paint_m2 = frame_len_m * _tube_perimeter_m(frame_tube)
        add("สีกันสนิม (สเปรย์ 400 มล.)",
            max(1, int(math.ceil(_paint_m2 / SPRAY_M2_PER_CAN))), "กระป๋อง",
            "ผิวเหล็ก %.2f ตร.ม. (ยาว %.1f ม. × รอบรูป %.0f มม.) · 1 กระป๋อง = 1 ตร.ม. ที่ 2 เที่ยว"
            % (_paint_m2, frame_len_m, _tube_perimeter_m(frame_tube) * 1000), "steel")

    # ── (จ) กันน้ำ — เฉพาะกล่องไฟ/งานกลางแจ้ง ──────────────────────────────
    if perimeter_m > 0 and (p["box"] or p["edge_lit"]) and not _std:
        _need_m = perimeter_m * (2.0 if p["two_face"] else 1.0) * SIL_WASTE
        add("ซิลิโคนกันน้ำ (ยาแนวขอบกล่อง)",
            max(1, int(math.ceil(_need_m / SIL_M_PER_TUBE))), "หลอด",
            "เส้นรอบรูป %.1f ม.%s × เผื่อเสีย 15%% = %.1f ม. · 1 หลอด 300 มล. บีด 6×6 มม. ได้ 8.3 ม."
            % (perimeter_m, " × 2 หน้า" if p["two_face"] else "", _need_m), "seal")
    if _wet and (p["box"] or p["edge_lit"]) and p["lit"]:
        _weep = max(2, int(math.ceil(perimeter_m / 1.0)))
        add("รูระบายน้ำ (weep hole) Ø6-10 มม. ที่ขอบล่าง", _weep, "รู",
            "NEC 600.9(D): ป้ายในที่เปียกต้องมีรูระบายน้ำ — เจาะที่จุดต่ำสุด ทุก ~1 ม.", "seal")

    # ── (ฉ) เฉพาะทาง ───────────────────────────────────────────────────────
    if p["neon"]:
        add("คลิปยึดเส้นนีออนเฟล็กซ์", int(math.ceil(max(led_m, 1.0) / 0.15)), "ตัว",
            "เส้นนีออนต้องยึดถี่ทุก 15 ซม. ไม่งั้นเส้นตกท้องช้าง", "neon")
        add("กาวซิลิโคนใส (ยึดเส้นนีออนกับแผ่นรอง)",
            max(1, int(math.ceil(max(led_m, 1.0) / 8.0))), "หลอด",
            "แนวไฟ %.1f ม. · 1 หลอดยึดได้ราว 8 ม." % max(led_m, 1.0), "neon")
    if _std:
        add("ขาตั้งพับหลัง (easel back) + เทปกาวสองหน้า", 1, "ชุด",
            "สแตนดี้ตั้งพื้น ไม่มีงานยึดผนัง", "standee")
    if arm and arm.get("n"):
        add("ค้ำยันเฉียง (bracing) แขนยื่น", int(arm["n"]), "ชุด",
            "แขนยื่น %d ต้น ยาว %.0f ซม. — IBC App.H112.1 กำหนดมุมค้ำ ≥ 45°"
            % (int(arm["n"]), float(arm.get("len_cm") or 0)), "steel")
    if p["punch"]:
        add("เทปกาวสองหน้า VHB 12 มม. (ยึดอะคริลิครองหลัง)",
            max(1, int(math.ceil(perimeter_m / 30.0))), "ม้วน",
            "ติดอะคริลิครองหลังแผ่นฉลุ · ม้วนละ 30 ม. · 3M: กดแรง ≥ 100 kPa และครบกำลังที่ 72 ชม.", "seal")

    add("ถุงมือ/ใบเจียร/วัสดุสิ้นเปลืองหน้างาน", 1, "ชุด", "เหมารวมต่อ 1 งานติดตั้ง", "misc")
    return o


def install_spec(rec=None, total_kg=0.0, face_area_m2=0.0, perimeter_m=0.0,
                 frame_len_m=0.0, frame_tube=None, supports=2, bolts=0, wires=0,
                 letters=0, led_m=0.0, transformer_w=0, arm=None,
                 outdoor=True, substrate="concrete", install_h_m=3.0, zone="central",
                 terrain="B", at_edge=False, mount="none", depth_cm=0.0):
    """🎯 ทางเข้าเดียว: คืน (wind, loads, anchor, boq) ครบชุดสำหรับใบสเปก"""
    w = wind_pressure(height_m=install_h_m, outdoor=outdoor, zone=zone,
                      terrain=terrain, at_edge=at_edge)
    _arm_m = float((arm or {}).get("len_cm") or 0.0) / 100.0
    ld = plate_loads(total_kg, face_area_m2, w["kpa"], supports=supports,
                     ecc_m=max(0.0, float(depth_cm) / 200.0), arm_len_m=_arm_m)
    _per = 4 if (_arm_m > 0 or float(depth_cm) > 6.0) else 2
    an = pick_anchor(ld["tension_kn"], ld["shear_kn"], substrate=substrate,
                     per_plate=_per, cracked=True, outdoor=outdoor)
    items = boq(rec=rec, total_kg=total_kg, face_area_m2=face_area_m2,
                perimeter_m=perimeter_m, frame_len_m=frame_len_m, frame_tube=frame_tube,
                supports=supports, bolts=bolts, wires=wires, letters=letters,
                led_m=led_m, transformer_w=transformer_w, arm=arm, outdoor=outdoor,
                substrate=substrate, install_h_m=install_h_m, zone=zone,
                mount=mount, depth_cm=depth_cm, anchor=an, wind=w)
    return {"wind": w, "loads": ld, "anchor": an, "boq": items}
