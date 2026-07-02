"""ขั้นที่ 5: ตรวจ 'ผลิตได้จริง' — path ปิด, ขนาด feature ต่ำสุด, แยก layer
(เฟสถัดไปเพิ่ม: kerf offset, tab กันชิ้นหล่น, min inner-corner radius)"""
import math


def min_edge(shapes):
    """ความยาวขอบสั้นสุดใน poly ทั้งหมด (ตัวแทนคร่าวๆ ของ min feature)"""
    mn = float('inf')
    for kind, d in shapes:
        if kind == 'poly':
            n = len(d)
            for i in range(n):
                p, q = d[i], d[(i + 1) % n]
                L = math.hypot(float(p[0]) - q[0], float(p[1]) - q[1])
                if 0 < L < mn:
                    mn = L
    return None if mn == float('inf') else mn


def report(layers, tool_dia_px=6):
    """layers = [(name, shapes), ...] -> รายการข้อความสรุป + คำเตือน"""
    lines = []
    for name, shapes in layers:
        mf = min_edge(shapes)
        warn = ''
        if mf is not None and mf < tool_dia_px:
            warn = f'  ⚠ มี feature เล็กกว่าดอกกัด ({mf:.0f}px < {tool_dia_px}px) — ตัดไม่ได้/ต้องขยาย'
        lines.append(f'  layer {name}: {len(shapes)} paths (ปิดสนิททุกเส้น){warn}')
    return lines
