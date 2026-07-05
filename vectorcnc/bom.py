"""BOM Engine (role-based) — โครงสร้าง BOM ต่อป้าย เพื่อเสียบระบบ Inventory Control
การคิด "ต้นทุน Check Sheet" อยู่ที่ vectorcnc/cost.py (build_cost_sheet)
"""
import json

MATERIALS = {
    'metal_zinc':      {'name': 'ซิงค์ทำสี',   'unit': 'm2'},
    'metal_stainless': {'name': 'สแตนเลส',     'unit': 'm2'},
    'metal_alu':       {'name': 'อะลูมิเนียม', 'unit': 'm2'},
    'plaswood':        {'name': 'พลาสวูด',     'unit': 'm2'},
    'acrylic_P433':    {'name': 'อะคริลิค P433','unit': 'm2'},
    'acrylic_clear':   {'name': 'อะคริลิคใส',   'unit': 'm2'},
    'yokkob_strip':    {'name': 'แถบยกขอบ',     'unit': 'm2'},
    'led_module':      {'name': 'ไฟ LED',       'unit': 'm'},
    'neon_flex':       {'name': 'นีออนเฟล็กซ์', 'unit': 'm'},
}
ROLE_LIBRARY = {
    'คิ้ว': {'role': 'คิ้ว (กรอบหน้า)', 'part': 'frame', 'material': 'metal_default', 'yokkob': True},
    'a':    {'role': 'หน้าอักษร', 'part': 'face', 'material': 'acrylic_P433'},
    'พื้น': {'role': 'แผ่นฐาน', 'part': 'plate', 'material': 'metal_default'},
    's-2':  {'role': 'แผ่นหลัง', 'part': 'plate', 'material': 'metal_default', 'yokkob': True},
    's2':   {'role': 'แผ่นหลัง', 'part': 'plate', 'material': 'metal_default', 'yokkob': True},
}
SIGN_TYPES = {
    '4.1': {'name': 'อักษร/โลโก้ ยกขอบ ไม่มีไฟ', 'default_face_material': 'metal_default', 'led': None},
    '4.2': {'name': 'อักษร/โลโก้ ไฟออกหลัง', 'default_face_material': 'metal_default', 'led': 'back'},
    '4.3': {'name': 'อักษร/โลโก้ ไฟออกหน้า', 'default_face_material': 'acrylic_P433', 'led': 'front'},
    '4.4': {'name': 'ป้ายกล่องไฟ', 'default_face_material': 'acrylic_P433', 'led': 'front'},
    '4.5': {'name': 'ป้ายนีออนเฟล็กซ์', 'default_face_material': 'plaswood', 'led': 'neon'},
}

def _role_for(layer, sign_type):
    low = str(layer).lower().strip()
    for key, r in ROLE_LIBRARY.items():
        if key.lower() in low or low in key.lower():
            return dict(r)
    return {'role': 'หน้า/ชิ้นงาน', 'part': 'face',
            'material': SIGN_TYPES.get(sign_type, {}).get('default_face_material', 'metal_default')}

def build_bom(pieces_geom, sign_type='4.3', qty_sets=1, metal='metal_zinc',
              yokkob_height_cm=5.0, role_overrides=None):
    role_overrides = role_overrides or {}
    lines = {}
    def add(mc, role, part, area_m2=0.0, length_m=0.0, pcs=0):
        if mc == 'metal_default': mc = metal
        k = (mc, role, part)
        ln = lines.setdefault(k, {'material_cat': mc, 'role': role, 'part': part,
                                  'area_m2': 0.0, 'length_m': 0.0, 'pcs': 0})
        ln['area_m2'] += area_m2; ln['length_m'] += length_m; ln['pcs'] += pcs
    for g in pieces_geom:
        r = role_overrides.get(g['layer']) or _role_for(g['layer'], sign_type)
        mat = r.get('material', 'metal_default')
        add(mat, r['role'], r.get('part', 'face'), area_m2=g.get('material_area_m2', g.get('area_m2', 0.0)), pcs=1)
        add(mat, r['role'], r.get('part', 'face'), length_m=g.get('cut_len_m', 0.0))
        if r.get('yokkob') and yokkob_height_cm > 0:
            add('yokkob_strip', 'ยกขอบ (' + r['role'] + ')', 'yokkob',
                area_m2=g.get('perim_outer_m', 0.0) * (yokkob_height_cm / 100.0),
                length_m=g.get('perim_outer_m', 0.0))
    out = []
    for ln in lines.values():
        ln = dict(ln)
        ln['area_m2'] = round(ln['area_m2'], 4); ln['length_m'] = round(ln['length_m'], 3)
        ln['unit'] = MATERIALS.get(ln['material_cat'], {}).get('unit', 'm2')
        ln['material_name'] = MATERIALS.get(ln['material_cat'], {}).get('name', ln['material_cat'])
        ln['total_area_m2'] = round(ln['area_m2'] * qty_sets, 4)
        ln['total_length_m'] = round(ln['length_m'] * qty_sets, 3)
        out.append(ln)
    return {'sign_type': sign_type, 'sign_type_name': SIGN_TYPES.get(sign_type, {}).get('name', sign_type),
            'qty_sets': qty_sets, 'metal': metal, 'lines': out}

def to_inventory_payload(bom):
    items = []
    for ln in bom['lines']:
        qty = ln['total_length_m'] if ln['unit'] == 'm' else ln['total_area_m2']
        if qty <= 0: continue
        items.append({'material_cat': ln['material_cat'], 'unit': ln['unit'], 'qty': qty,
                      'role': ln['role'], 'part': ln['part']})
    return {'sign_type': bom['sign_type'], 'qty_sets': bom['qty_sets'], 'items': items}
