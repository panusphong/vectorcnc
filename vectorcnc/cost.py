"""cost.py — คิดต้นทุน BOM Check Sheet แบบ "แยกตามประเภทป้าย" (profile-driven)
ประเภทป้าย (4.1–4.5) เป็นตัวตั้งต้น -> sign_profiles ขับว่ามีชิ้นไหนบ้าง
ค่าแรง+Overhead 40% · ค่าความเสียหาย 50% · ราคาจาก material_map.json
"""
import json, os, math
from . import sign_profiles as _prof

MARKUP = {'labor_oh': 0.40, 'damage': 0.50}
OUTDOOR_STRUCT = 0.10
_MAP_PATH = os.path.join(os.path.dirname(__file__), 'material_map.json')


def _load():
    try:
        with open(_MAP_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'map': {}, 'paint': {}}


def _mat(mp, cat):
    m = mp.get(cat, {})
    return (m.get('itemcode', cat), m.get('price', 0) or 0,
            m.get('item_name', cat), (m.get('sheet_m2') or 2.977))


def sheet_cost(area_m2, price, sheet_m2):
    return round(area_m2 / (sheet_m2 or 2.977) * (price or 0), 1)


def strip_cost(length_mm, height_mm, mp, cat='yokkob_strip'):
    m = mp.get(cat, {}); t = m.get('thickness_mm') or 1.0
    rho = m.get('density_kg_mm3') or 7.93e-6; pr = m.get('price') or 120
    kg = length_mm * height_mm * t * rho
    return round(kg, 2), round(kg * pr, 1)


def build_cost_sheet(g, led, sign_type='4.3', qty_sets=1, params=None):
    """g=geom_summary · led=plan_two_systems() · params=พารามิเตอร์ต่อ job
    ประกอบ BOM ตาม 'ประเภทป้าย' (sign_profiles)"""
    params = params or {}
    P = _prof.get(sign_type)
    metal_cat = params.get('metal_cat', 'metal_stainless')
    yo = float(params.get('yokkob_outer_cm', 5.0))
    yl = float(params.get('yokkob_letter_cm', 7.0))
    install = params.get('install', 'indoor')
    led_color = params.get('led_color', 'วอร์มไวท์ 3000K')
    wp = ' (กันน้ำ)' if install == 'outdoor' else ''

    D = _load(); mp = D.get('map', {}); paint = D.get('paint', {})
    base_cat = metal_cat if P['base_mat'] == 'metal' else P['base_mat']
    b_code, b_pr, b_name, b_sheet = _mat(mp, base_cat)
    m_code, m_pr, m_name, m_sheet = _mat(mp, metal_cat)
    strip_code = mp.get('yokkob_strip', {}).get('itemcode', 'RAWSUS0009')
    acr_code, acr_pr, acr_name, acr_sheet = _mat(mp, 'acrylic_P433')
    clr_code, clr_pr, clr_name, clr_sheet = _mat(mp, 'acrylic_clear')
    rib = mp.get('led_ribbon_warm', {}); rib_code = rib.get('itemcode', 'ELCRIB0012')
    rib_pr = rib.get('price', 290) or 290; roll_m = rib.get('roll_m') or 25
    neon = mp.get('neon_flex', {}); neon_code = neon.get('itemcode', 'ELCNEO0001')
    neon_pr = (neon.get('price') or 60)
    tf = led.get('transformer', {}) or {}

    rows = []; metal_rows_cost = [0.0]

    def R(no, name, size, matname, code, up, qty, cost, is_metal=False):
        rows.append({'no': no, 'name': name, 'size': size, 'material': matname, 'itemcode': code,
                     'unit_price': up, 'qty': qty, 'cost': (round(cost, 1) if cost != '' else '')})
        if is_metal and cost != '':
            metal_rows_cost[0] += cost

    no = [0]
    def nx():
        no[0] += 1; return str(no[0])

    # ① แผ่นฐาน / แผ่นหลัง / แผ่นพื้น
    if P['base']:
        c = sheet_cost(g['back_area_m2'], b_pr, b_sheet)
        label = {'plaswood': 'แผ่นพื้น (พลาสวูด)', 'acrylic_clear': 'แผ่นพื้น (อะคริลิค)'}.get(base_cat, 'แผ่นหลัง/ฐาน (โลหะ)')
        R(nx(), label, f"{g['width_mm']:.0f}x{g['height_mm']:.0f} mm", b_name, b_code,
          f"{b_pr:,} บ.", f"{g['back_area_m2']:.4f} m2", c, is_metal=(P['base_mat'] == 'metal'))
        if P['yk_outer']:
            kg, cc = strip_cost(g['outer_perim_mm'], yo * 10, mp)
            R('', f'ยกขอบรอบนอก {yo:g} cm', f"รอบ {g['outer_perim_mm']:.0f} mm", 'ม้วนโลหะ', strip_code,
              '120 บ./กก.', f"{kg} kg", cc, is_metal=True)

    # ② หน้าอักษร
    if P['face'] == 'metal_solid':
        c = sheet_cost(g['floor_area_m2'], m_pr, m_sheet)
        R(nx(), 'หน้าอักษร/โลโก้ (โลหะ ตัน)', f"{g['floor_area_m2']:.3f} m2", m_name, m_code,
          f"{m_pr:,} บ.", f"{g['floor_area_m2']:.4f} m2", c, is_metal=True)
    elif P['face'] == 'acrylic':
        c = round(g['acrylic_area_m2'] / (acr_sheet or 2.984) * acr_pr, 1)
        R(nx(), 'หน้าอะคริลิค (ตัดรอบนอก silhouette)', f"{g['acrylic_area_m2']:.3f} m2", acr_name, acr_code,
          f"{acr_pr:,} บ.", f"{g['acrylic_area_m2']:.4f} m2", c)

    # ③ คิ้ว
    if P['frame'] and g['kiew_area_m2'] > 0:
        c = sheet_cost(g['kiew_area_m2'], m_pr, m_sheet)
        R(nx(), 'คิ้ว (กรอบหน้า เจาะโบ๋)', f"{g['kiew_area_m2']:.3f} m2", m_name, m_code,
          f"{m_pr:,} บ.", f"{g['kiew_area_m2']:.4f} m2", c, is_metal=True)

    # ④ แผ่นรองหลัง (halo 4.2)
    if P['backer'] == 'acrylic_clear':
        area = round(g['acrylic_area_m2'] * 1.15, 4)
        c = round(area / (clr_sheet or 2.984) * (clr_pr or acr_pr), 1)
        R(nx(), 'แผ่นรองหลัง อะคริลิคใส/ขาว (halo)', f"{area:.3f} m2", clr_name, clr_code,
          f"{(clr_pr or acr_pr):,} บ.", f"{area:.4f} m2", c)

    # ⑤ ยกขอบตัวอักษร
    if P['yk_letter']:
        kg, cc = strip_cost(g['letter_perim_mm'], yl * 10, mp)
        R('', f'ยกขอบ ตัวอักษร {yl:g} cm', f"รอบ {g['letter_perim_mm']:.0f} mm", 'ม้วนโลหะ', strip_code,
          '120 บ./กก.', f"{kg} kg", cc, is_metal=True)

    # พ่นสี (โลหะไม่ใช่สแตนเลส)
    paint_cost = 0
    metal_used = (P['face'] == 'metal_solid') or (P['base'] and P['base_mat'] == 'metal') or P['frame']
    if metal_cat != 'metal_stainless' and metal_used:
        parea = round(g['floor_area_m2'] + (g['back_area_m2'] if P['base'] else 0) + g['kiew_area_m2'], 3)
        prate = paint.get('rate_per_m2', 500); paint_cost = round(parea * prate, 1)
        if paint_cost > 0:
            R('', 'พ่นสี (โลหะไม่ใช่สแตนเลส)', f"{parea:.3f} m2 x {prate}", 'สี (1L/3m2)', 'PAINT',
              f"{prate} บ./m2", f"{parea:.3f} m2", paint_cost)

    # ⑥ ไฟ LED
    front_m = round(led.get('front_m', 0.0), 2) if _prof.has_front(P) else 0.0
    if _prof.has_halo(P):
        halo_m = round(led.get('halo_m', 0.0), 2) if sign_type == '4.3' else round(g['letter_perim_mm'] / 1000.0, 2)
    else:
        halo_m = 0.0
    neon_m = round(g['letter_perim_mm'] / 1000.0, 2) if _prof.has_neon(P) else 0.0
    ribbon_total = round(front_m + halo_m, 2)
    rolls = max(1, math.ceil(ribbon_total / roll_m)) if ribbon_total > 0 else 0

    if front_m > 0:
        R(nx(), f'ไฟออกหน้า{wp} — {led_color}', f"{front_m:.2f} m / {led.get('front_w',0):.0f}W",
          'ไฟริบบิ้น' + wp, rib_code, f"{rib_pr} บ./ม้วน", f"รวม {ribbon_total:.2f} m", rolls * rib_pr)
    if halo_m > 0:
        showcost = '' if front_m > 0 else rolls * rib_pr
        R(nx(), f'ไฟออกหลัง halo{wp}', f"{halo_m:.2f} m / {led.get('halo_w',0):.0f}W",
          'ไฟริบบิ้น' + wp, rib_code, f"{rib_pr} บ./ม้วน",
          (f"{rolls} ม้วน" if front_m > 0 else f"รวม {ribbon_total:.2f} m"), showcost)
    if neon_m > 0:
        R(nx(), f'นีออนเฟล็กซ์{wp} — {led_color}', f"{neon_m:.2f} m",
          neon.get('item_name', 'นีออนเฟล็กซ์') + wp, neon_code, f"{neon_pr} บ./m", f"{neon_m:.2f} m",
          round(neon_m * neon_pr, 1))
        R('', 'เซาะร่อง 8mm วางนีออน (routing)', f"{neon_m:.2f} m", 'ค่าแรงเซาะร่อง', 'ROUTE',
          '—', f"{neon_m:.2f} m", round(neon_m * 20, 1))

    # ⑦ หม้อแปลง
    if P['led'] != 'none':
        R(nx(), tf.get('name', 'หม้อแปลง'), f"{led.get('need_w',0):.0f}W",
          f"Mean Well {tf.get('series','LRS')}" + wp, tf.get('itemcode', 'ELCPOS0001'),
          f"{tf.get('price','-')} บ./ตัว", '1 ตัว', tf.get('price', 0) or 0)

    # ⑧ พุกยึดผนัง (งานติดผนัง)
    if P['anchors']:
        R(nx(), 'พุก/สตัดยึดผนัง + กาวโครงสร้าง' + (' + ขาลอย halo' if P['standoff'] else ''),
          'ชุดติดตั้งผนัง', 'ชุดยึด', 'ACC-MOUNT', '—', '1 ชุด', 180)

    # ⑨ โครงเสริม Outdoor
    if install == 'outdoor':
        struct = round(metal_rows_cost[0] * OUTDOOR_STRUCT, 1)
        if struct > 0:
            R(nx(), 'โครงเสริมแข็งแรง (Outdoor)', f"+{int(OUTDOOR_STRUCT*100)}% ของค่าโลหะ",
              'งานโครง/ยึด', 'STRUCT', f"{int(OUTDOOR_STRUCT*100)}%", '1 งาน', struct)

    # ⑩ สายไฟเมน
    if P['led'] != 'none':
        wtype = 'vct' if install == 'outdoor' else 'thw'
        gauge = str(params.get('wire_gauge', '2.5'))
        wlen = float(params.get('wire_length_m', 5.0))
        wm = mp.get('wire_' + wtype + '_' + gauge, {})
        wrate = wm.get('price', 28 if wtype == 'vct' else 11)
        R(nx(), f"สายไฟเมน {wtype.upper()} {gauge} (หม้อแปลง->ป้าย)", f"{wlen:g} m",
          wm.get('item_name', f'{wtype.upper()} {gauge}'), wm.get('itemcode', 'ELCWIR0006'),
          f"{wrate} บ./m", f"{wlen:g} m", round(wlen * wrate, 1))

    material = round(sum(r['cost'] for r in rows if r['cost'] != ''))
    labor = round(material * MARKUP['labor_oh']); damage = round(material * MARKUP['damage'])
    total = material + labor + damage
    led_out = dict(led); led_out['front_m'] = front_m; led_out['halo_m'] = halo_m
    led_out['neon_m'] = neon_m; led_out['total_m'] = round(ribbon_total + neon_m, 2)
    return {'sign_type': sign_type, 'sign_type_name': P['name'], 'profile': P,
            'qty_sets': qty_sets, 'rows': rows, 'material': material,
            'labor': labor, 'damage': damage, 'total': total, 'markup': MARKUP, 'led': led_out,
            'params': {'metal_cat': metal_cat, 'yokkob_outer_cm': yo, 'yokkob_letter_cm': yl,
                       'install': install, 'led_color': led_color},
            'inventory_payload': [{'itemcode': r['itemcode'], 'qty_text': r['qty'], 'role': r['name'], 'qty_sets': qty_sets}
                                  for r in rows if r['itemcode'] not in ('', 'dynamic', 'PAINT', 'STRUCT', 'ROUTE', 'ACC-MOUNT')]}
