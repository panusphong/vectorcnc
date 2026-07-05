"""ไฟ LED + หม้อแปลง — ความยาวเส้นไฟ -> โหลดวัตต์ -> เลือกหม้อแปลง Mean Well 12V (LRS)
ไฟ 2 ระบบ (4.3): plan_two_systems(front_m, halo_m)
"""
LED_TYPES = {
    'strip_5050':  {'name': 'ไฟเส้น LED 5050 12V', 'volt': 12, 'w_per_m': 14.4},
    'strip_2835':  {'name': 'ไฟเส้น LED 2835 12V', 'volt': 12, 'w_per_m': 9.6},
    'module_3led': {'name': 'โมดูล LED 3 ชิป 12V', 'volt': 12, 'w_per_module': 0.72, 'module_pitch_m': 0.10},
    'module_wp':   {'name': 'โมดูล LED กันน้ำ 12V', 'volt': 12, 'w_per_module': 0.96, 'module_pitch_m': 0.10},
    'neon_flex':   {'name': 'นีออนเฟล็กซ์ 12V', 'volt': 12, 'w_per_m': 8.0},
}
LIGHT_COLORS = [
    ('daylight', 'เดย์ไลท์ (ขาว 6500K)'), ('coolwhite', 'คูลไวท์'),
    ('warmwhite', 'วอร์มไวท์ (3000K)'), ('red', 'แดง'), ('green', 'เขียว'),
    ('blue', 'น้ำเงิน'), ('pink', 'ชมพู'), ('purple', 'ม่วง'),
    ('yellow', 'เหลือง'), ('orange', 'ส้ม'), ('ice', 'ฟ้า'), ('rgb', 'RGB Full Color'),
]
# หม้อแปลง (ItemMaster จริง) — LRS เป็นหลัก
MEANWELL_12V = {
    'LRS': [(50, 'หม้อแปลง LRS 50', 'ELCPOS0013'), (75, 'หม้อแปลง LRS 75', 'ELCPOS0014'),
            (100, 'หม้อแปลง LRS 100', 'ELCPOS0015'), (150, 'หม้อแปลง LRS 150', 'ELCPOS0016'),
            (200, 'หม้อแปลง LRS 200', 'ELCPOS0017'), (350, 'หม้อแปลง LRS 350', 'ELCPOS0018'),
            (450, 'หม้อแปลง LRS 450', 'ELCPOS0020')],
    'RSP': [(75, 'หม้อแปลง RSP 75', 'ELCPOS0009'), (100, 'หม้อแปลง RSP 100', 'ELCPOS0010'),
            (150, 'หม้อแปลง RSP 150', 'ELCPOS0011'), (200, 'หม้อแปลง RSP 200', 'ELCPOS0019'),
            (320, 'หม้อแปลง RSP 320', 'ELCPOS0012')],
    'XLG': [(75, 'หม้อแปลง XLG 75', 'ELCPOS0024'), (100, 'หม้อแปลง XLG 100', 'ELCPOS0025'),
            (150, 'หม้อแปลง XLG 150', 'ELCPOS0026'), (200, 'หม้อแปลง XLG 200', 'ELCPOS0027')],
}
# ราคาหม้อแปลง (ประเมิน — ยืนยัน ItemMaster) : itemcode -> บ./ตัว
TF_PRICE = {'ELCPOS0013': 279, 'ELCPOS0014': 339, 'ELCPOS0015': 390, 'ELCPOS0016': 490,
            'ELCPOS0017': 590, 'ELCPOS0018': 790, 'ELCPOS0020': 890,
            'ELCPOS0009': 420, 'ELCPOS0010': 520, 'ELCPOS0011': 690, 'ELCPOS0019': 820, 'ELCPOS0012': 1150,
            'ELCPOS0024': 560, 'ELCPOS0025': 690, 'ELCPOS0026': 890, 'ELCPOS0027': 1050}
LRS_PRICE = TF_PRICE  # backward compat
LED_RIBBON = {'itemcode': 'ELCRIB0012', 'name': 'ไฟริบบิ้น LED วอร์มไวท์ 3000K',
              'w_per_m': 14.4, 'price_per_roll': 290, 'roll_m': 25}
RISER_CM = 2.0
GAP_LED_ACRYLIC_CM = 5.0
STRIP_LM_PER_M = {'strip_5050': 800.0, 'strip_2835': 600.0, 'module_3led': 500.0,
                  'module_wp': 650.0, 'neon_flex': 400.0}
TARGET_LUX = 9000.0


def led_length_m(area_m2=0.0, row_spacing_cm=5.0, perim_m=0.0, mode='front'):
    rs = max(0.01, row_spacing_cm / 100.0)
    if mode == 'neon':
        return round(perim_m, 3)
    fill = area_m2 / rs
    return round(fill + perim_m * 0.15, 3)


def power(length_m, led_type='strip_5050', n_modules=None):
    t = LED_TYPES.get(led_type, LED_TYPES['strip_5050'])
    if 'w_per_module' in t:
        pitch = t.get('module_pitch_m', 0.10)
        mods = n_modules if n_modules is not None else max(1, round(length_m / pitch))
        w = mods * t['w_per_module']
        return round(w, 1), round(w / t['volt'], 2), mods
    w = length_m * t['w_per_m']
    return round(w, 1), round(w / t['volt'], 2), None


def select_transformer(watts, series='LRS', safety=1.25):
    need = watts * safety
    models = MEANWELL_12V.get(series, MEANWELL_12V['LRS'])
    for cap, name, code in models:
        if cap >= need:
            return {'load_w': round(watts, 1), 'need_w': round(need, 1),
                    'transformer': name, 'itemcode': code, 'count': 1, 'total_w': cap, 'series': series}
    big_cap, big_name, big_code = models[-1]
    count = -(-int(need) // big_cap)
    return {'load_w': round(watts, 1), 'need_w': round(need, 1),
            'transformer': big_name, 'itemcode': big_code, 'count': count,
            'total_w': big_cap * count, 'series': series}


def face_lux(led_len_m, face_area_m2, depth_mm=50.0, led_type='strip_5050'):
    lm = led_len_m * STRIP_LM_PER_M.get(led_type, 800.0)
    depth_factor = min(1.0, 50.0 / max(30.0, depth_mm))
    return lm / max(1e-4, face_area_m2) * depth_factor


def rows_for_brightness(face_area_m2, base_len_m, depth_mm, led_type='strip_5050', target=TARGET_LUX):
    rows = 1
    while face_lux(base_len_m * rows, face_area_m2, depth_mm, led_type) < target and rows < 8:
        rows += 1
    return rows, round(face_lux(base_len_m * rows, face_area_m2, depth_mm, led_type))


def plan_led(area_m2, perim_m, sign_type='4.3', led_type='strip_5050',
             color='daylight', row_spacing_cm=5.0, series='LRS'):
    mode = {'4.2': 'back', '4.5': 'neon'}.get(sign_type, 'front')
    length = led_length_m(area_m2, row_spacing_cm, perim_m, mode)
    w, a, mods = power(length, led_type)
    return {'mode': mode, 'led_type': led_type, 'color': color, 'length_m': length,
            'modules': mods, 'load_w': w, 'amps_12v': a, 'transformer': select_transformer(w, series)}


def plan_two_systems(front_m, halo_m, w_per_m=14.4, series='LRS', safety=1.25):
    """ไฟออกหน้า (ตัวอักษร+ใบไม้+ก้าน) + ไฟออกหลัง halo (รอบขอบวงรี) -> หม้อแปลงตัวเดียว"""
    import math
    fw = front_m * w_per_m; hw = halo_m * w_per_m
    tot_m = front_m + halo_m; tot_w = fw + hw
    tf = select_transformer(tot_w, series, safety)
    tf['price'] = TF_PRICE.get(tf['itemcode'], '-')
    tf['name'] = tf['transformer']; tf['watt'] = tf['total_w']
    rolls = max(1, math.ceil(tot_m / LED_RIBBON['roll_m']))
    return {'front_m': round(front_m, 2), 'front_w': round(fw), 'halo_m': round(halo_m, 2),
            'halo_w': round(hw), 'total_m': round(tot_m, 2), 'total_w': round(tot_w),
            'need_w': round(tot_w * safety), 'riser_cm': RISER_CM, 'gap_cm': GAP_LED_ACRYLIC_CM,
            'target_lux': TARGET_LUX, 'transformer': tf, 'ribbon': dict(LED_RIBBON), 'rolls': rolls}
