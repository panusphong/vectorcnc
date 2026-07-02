"""
vectorcnc — เครื่องยนต์แปลง ภาพ -> เวกเตอร์คุณภาพ CNC -> ไฟล์กลาง (SVG/DXF)
โฟกัสงานป้าย: เรขาคณิตที่ 'ผลิตได้จริง' ไม่ใช่แค่ 'เหมือนภาพ'

โมดูล:
  preprocess  — ล้างภาพ + quantize สี
  segment     — แยก mask ต่อสี (ต่อวัสดุ/layer)
  vectorize   — contour + geometry fitting (ลด node, วงกลม/มุมคม)
  cnc_rules   — ตรวจผลิตได้ (path ปิด, min feature, แยก layer)
  svg_writer  — เขียน SVG แบบแยก layer (ต่อ 3D ตัวไหนก็ได้)
  pipeline    — ต่อทุกขั้นเป็นเส้นเดียว
"""
__version__ = "0.2.0"
