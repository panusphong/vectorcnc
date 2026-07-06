"""sign_profiles.py — โครงสร้างต่อ "ประเภทป้าย" (4.1–4.5) เป็นตัวตั้งต้นของทั้งระบบ
user เลือกประเภทป้ายก่อน -> profile นี้ขับ: การอ่านเลเยอร์ · การวาดภาพ · การคิด BOM

ธง (flags) ต่อประเภท:
  base        : มีแผ่นฐาน/แผ่นหลังโลหะไหม
  base_mat    : วัสดุแผ่นฐาน (metal=ตามที่ user เลือก / plaswood / acrylic_clear)
  frame       : มีคิ้ว (กรอบโลหะหน้าเจาะโบ๋) ไหม  (4.3/4.4)
  face        : หน้าอักษร -> 'metal_solid' | 'acrylic' | 'none'
  backer      : แผ่นรองหลังพิเศษ ('acrylic_clear' สำหรับ halo 4.2) | None
  led         : 'none' | 'halo' | 'front' | 'front+halo' | 'neon'
  yk_outer    : ยกขอบรอบนอก/รอบแผ่นฐาน
  yk_letter   : ยกขอบรอบตัวอักษร
  standoff    : ขาลอย (เว้นระยะจากผนังให้แสง halo ออกหลัง)
  anchors     : พุกยึดผนัง (งานติดผนังไม่มีฐาน)
  box         : ป้ายกล่องไฟ (มีความลึกกล่อง)
  groove      : เซาะร่องวางเส้นนีออน (4.5)
"""

PROFILES = {
    '4.1': {
        'name': 'อักษร/โลโก้ ยกขอบ ไม่มีไฟ', 'short': 'ยกขอบ ไม่มีไฟ',
        'base': False, 'base_mat': 'metal', 'frame': False, 'face': 'metal_solid',
        'backer': None, 'led': 'none', 'yk_outer': False, 'yk_letter': True,
        'standoff': False, 'anchors': True, 'box': False, 'groove': False,
    },
    '4.2': {
        'name': 'อักษร/โลโก้ ไฟออกหลัง (halo)', 'short': 'ไฟออกหลัง halo',
        'base': False, 'base_mat': 'metal', 'frame': False, 'face': 'metal_solid',
        'backer': 'acrylic_clear', 'led': 'halo', 'yk_outer': False, 'yk_letter': True,
        'standoff': True, 'anchors': True, 'box': False, 'groove': False,
    },
    '4.3': {
        'name': 'อักษร/โลโก้ ไฟออกหน้า', 'short': 'ไฟออกหน้า ยกขอบ',
        'base': True, 'base_mat': 'metal', 'frame': True, 'face': 'acrylic',
        'backer': None, 'led': 'front+halo', 'yk_outer': True, 'yk_letter': True,
        'standoff': False, 'anchors': False, 'box': False, 'groove': False,
    },
    '4.4': {
        'name': 'ป้ายกล่องไฟ (light box)', 'short': 'กล่องไฟ',
        'base': True, 'base_mat': 'metal', 'frame': True, 'face': 'acrylic',
        'backer': None, 'led': 'front', 'yk_outer': True, 'yk_letter': False,
        'standoff': False, 'anchors': False, 'box': True, 'groove': False,
    },
    '4.5': {
        'name': 'ป้ายนีออนเฟล็กซ์', 'short': 'นีออนเฟล็กซ์',
        'base': True, 'base_mat': 'plaswood', 'frame': False, 'face': 'none',
        'backer': None, 'led': 'neon', 'yk_outer': True, 'yk_letter': False,
        'standoff': False, 'anchors': False, 'box': False, 'groove': True,
    },
}


def get(sign_type):
    return PROFILES.get(str(sign_type).strip(), PROFILES['4.3'])


def has_front(p): return 'front' in p['led']
def has_halo(p):  return 'halo' in p['led']
def has_neon(p):  return p['led'] == 'neon'
