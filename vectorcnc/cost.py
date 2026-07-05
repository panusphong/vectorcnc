"""cost.py — คิดต้นทุน BOM Check Sheet (param-driven) ดึงราคาจาก material_map.json
ค่าแรง+Overhead 40% · ค่าความเสียหาย 50%
params: metal_cat, yokkob_outer_cm(5), yokkob_letter_cm(7), install('indoor'/'outdoor'), led_color
"""
import json, os, math

MARKUP = {'labor_oh': 0.40, 'damage': 0.50}
OUTDOOR_STRUCT = 0.10   # โครงเสริมแข็งแรง outdoor = 10% ของค่าโลหะ
_MAP_PATH = os.path.join(os.path.dirname(__file__), 'material_map.json')

def _load():
    try:
        with open(_MAP_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'map': {}, 'paint': {}}

def sheet_cost(cat, area_m2, mp):
    m = mp.get(cat, {}); sh = m.get('sheet_m2') or 2.977; pr = m.get('price') or 0
    return round(area_m2 / sh * pr, 1)

def strip_cost(length_mm, height_mm, mp, cat='yokkob_strip'):
    m = mp.get(cat, {}); t = m.get('thickness_mm') or 1.0
    rho = m.get('density_kg_mm3') or 7.93e-6; pr = m.get('price') or 120
    kg = length_mm * height_mm * t * rho
    return round(kg, 2), round(kg * pr, 1)

def build_cost_sheet(g, led, sign_type='4.3', qty_sets=1, params=None):
    """g=geom_summary · led=plan_two_systems() · params=พารามิเตอร์ต่อ job"""
    params = params or {}
    metal_cat = params.get('metal_cat', 'metal_stainless')
    yo = float(params.get('yokkob_outer_cm', 5.0))
    yl = float(params.get('yokkob_letter_cm', 7.0))
    install = params.get('install', 'indoor')
    led_color = params.get('led_color', 'วอร์มไวท์ 3000K')
    D = _load(); mp = D.get('map', {}); paint = D.get('paint', {})
    ssm = mp.get(metal_cat, {}); ss_code = ssm.get('itemcode', 'RAWSUS0001'); ss_pr = ssm.get('price', 4100)
    ss_name = ssm.get('item_name', 'โลหะ')
    strip_code = mp.get('yokkob_strip', {}).get('itemcode', 'RAWSUS0009')
    acr = mp.get('acrylic_P433', {}); acr_code = acr.get('itemcode', 'RAWACR0004'); acr_pr = acr.get('price', 1075)
    rib = mp.get('led_ribbon_warm', {}); rib_code = rib.get('itemcode', 'ELCRIB0012'); rib_pr = rib.get('price', 290)
    tf = led.get('transformer', {})
    rows = []
    def R(no, name, size, matname, code, up, qty, cost):
        rows.append({'no': no, 'name': name, 'size': size, 'material': matname, 'itemcode': code,
                     'unit_price': up, 'qty': qty, 'cost': (round(cost, 1) if cost != '' else '')})
    # 1 แผ่นหลัง + ยกขอบนอก
    c1 = sheet_cost(metal_cat, g['back_area_m2'], mp)
    R('1', 'แผ่นหลัง (วงรี)', f"{g['width_mm']:.0f}x{g['height_mm']:.0f} mm", ss_name, ss_code, f"{ss_pr:,} บ./แผ่น", f"{g['back_area_m2']:.4f} m2", c1)
    kg5, c5 = strip_cost(g['outer_perim_mm'], yo*10, mp)
    R('', f'ยกขอบรอบนอก {yo:g} cm', f"รอบ {g['outer_perim_mm']:.0f} mm", 'ม้วนโลหะ', strip_code, '120 บ./กก.', f"{kg5} kg", c5)
    # 2 แผ่นฐาน
    c2 = sheet_cost(metal_cat, g['floor_area_m2'], mp)
    R('2', 'แผ่นฐาน (พื้นตัวอักษร)', f"{g['floor_area_m2']:.3f} m2", ss_name, ss_code, f"{ss_pr:,} บ./แผ่น", f"{g['floor_area_m2']:.4f} m2", c2)
    # 3 คิ้ว + ยกขอบตัวอักษร
    c3 = sheet_cost(metal_cat, g['kiew_area_m2'], mp)
    R('3', 'คิ้ว (เต็มพื้นที่)', f"{g['kiew_area_m2']:.3f} m2", ss_name, ss_code, f"{ss_pr:,} บ./แผ่น", f"{g['kiew_area_m2']:.4f} m2", c3)
    kg7, c7 = strip_cost(g['letter_perim_mm'], yl*10, mp)
    R('', f'ยกขอบ ตัวอักษร+กิ่ง+ใบไม้ {yl:g} cm', f"รอบ {g['letter_perim_mm']:.0f} mm", 'ม้วนโลหะ', strip_code, '120 บ./กก.', f"{kg7} kg", c7)
    # 4 อะคริลิค (silhouette)
    c4 = round(g['acrylic_area_m2'] / (acr.get('sheet_m2') or 2.984) * acr_pr, 1)
    R('4', 'หน้าอะคริลิค (ตัดรอบนอก silhouette)', f"{g['acrylic_area_m2']:.3f} m2", acr.get('item_name', 'อะคริลิค P433'), acr_code, f"{acr_pr:,} บ./แผ่น", f"{g['acrylic_area_m2']:.4f} m2", c4)
    # 4b พ่นสี (ถ้าไม่ใช่สแตนเลส)
    paint_cost = 0
    if metal_cat != 'metal_stainless':
        parea = g['back_area_m2'] + g['kiew_area_m2']
        prate = paint.get('rate_per_m2', 500); paint_cost = round(parea * prate, 1)
        R('', 'พ่นสี (โลหะไม่ใช่สแตนเลส)', f"{parea:.3f} m2 x {prate}", 'สี (1L/3m2)', 'PAINT', f"{prate} บ./m2", f"{parea:.3f} m2", paint_cost)
    # 5-6 ไฟ 2 ระบบ
    total_m = led.get('total_m', 0.0); rolls = max(1, math.ceil(total_m / (rib.get('roll_m') or 25)))
    wp = ' (กันน้ำ)' if install == 'outdoor' else ''
    R('5', f'ไฟออกหน้า{wp} — {led_color}', f"{led.get('front_m',0):.2f} m / {led.get('front_w',0):.0f}W / >=9000 Lux",
      'ไฟริบบิ้น' + wp, rib_code, f"{rib_pr} บ./ม้วน", f"รวม {total_m:.2f} m", rolls * rib_pr)
    R('6', f'ไฟออกหลัง halo{wp} (แผ่นฐาน รอบขอบ)', f"{led.get('halo_m',0):.2f} m / {led.get('halo_w',0):.0f}W",
      'ไฟริบบิ้น' + wp, rib_code, '(ม้วนเดียวกัน)', f"{rolls} ม้วน", '')
    # 7 หม้อแปลง
    R('7', tf.get('name', 'หม้อแปลง'), f"{led.get('need_w',0):.0f}W (โหลด {led.get('total_w',0):.0f}W x1.25)",
      f"Mean Well {tf.get('series','LRS')}" + wp, tf.get('itemcode', 'ELCPOS0017'), f"{tf.get('price','-')} บ./ตัว*", '1 ตัว', tf.get('price', 0))
    # 8 โครงเสริม outdoor
    if install == 'outdoor':
        metal_sub = c1 + c5 + c2 + c3 + c7 + paint_cost
        struct = round(metal_sub * OUTDOOR_STRUCT, 1)
        R('8', 'โครงเสริมแข็งแรง (Outdoor)', f"+{int(OUTDOOR_STRUCT*100)}% ของค่าโลหะ", 'งานโครง/ยึด', 'STRUCT', f"{int(OUTDOOR_STRUCT*100)}%", '1 งาน', struct)
    # 9 สายไฟเมน (หม้อแปลง->ป้าย) — ชนิดตาม install (outdoor=VCT, indoor=THW), เบอร์+ระยะ user กรอก
    wtype = 'vct' if install == 'outdoor' else 'thw'
    gauge = str(params.get('wire_gauge', '2.5'))
    wlen = float(params.get('wire_length_m', 5.0))
    wm = mp.get(f'wire_{wtype}_{gauge}', {})
    wrate = wm.get('price', 28 if wtype == 'vct' else 11)
    R('9', f"สายไฟเมน {wtype.upper()} {gauge} (หม้อแปลง->ป้าย)", f"{wlen:g} m",
      wm.get('item_name', f'{wtype.upper()} {gauge}'), wm.get('itemcode', 'ELCWIR*'),
      f"{wrate} บ./m", f"{wlen:g} m", round(wlen * wrate, 1))
    material = round(sum(r['cost'] for r in rows if r['cost'] != ''))
    labor = round(material * MARKUP['labor_oh']); damage = round(material * MARKUP['damage'])
    total = material + labor + damage
    return {'sign_type': sign_type, 'qty_sets': qty_sets, 'rows': rows, 'material': material,
            'labor': labor, 'damage': damage, 'total': total, 'markup': MARKUP, 'led': led,
            'params': {'metal_cat': metal_cat, 'yokkob_outer_cm': yo, 'yokkob_letter_cm': yl,
                       'install': install, 'led_color': led_color},
            'inventory_payload': [{'itemcode': r['itemcode'], 'qty_text': r['qty'], 'role': r['name'], 'qty_sets': qty_sets}
                                  for r in rows if r['itemcode'] not in ('', 'dynamic', 'PAINT', 'STRUCT')]}
