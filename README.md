# VectorCNC App — โปรเจกต์แยกอิสระ

> ⚠️ **คนละโปรเจกต์กับ "Saai Tech App" (แอป Kanban ทีม AI)** — อย่าปนกัน

**คืออะไร:** ตัวกลางแปลง ภาพ (จาก AI/มือถือ/สแกน) → เวกเตอร์คุณภาพ CNC → 3D (Fusion 360 ฯลฯ)
โดยไม่ต้องผ่าน Illustrator และไม่ผูกกับ 3D ตัวใดตัวหนึ่ง (ออกไฟล์กลาง SVG/DXF/STEP)
เป้าหมาย: แข่งกับ vectorizer.ai โฟกัสงานป้าย

## ภาษา: Python (แกน) + Rust (VTracer, ความเร็ว) + TypeScript (เว็บ)
รายละเอียดใน `ARCHITECTURE.md`

## โครงสร้าง
```
vectorcnc/        Python package — เครื่องยนต์ (preprocess→segment→vectorize→cnc_rules→svg_writer→pipeline)
fusion_addin/     สคริปต์ Fusion 360 (SVG -> 3D extrude)
examples/         เดโมรันได้จริง
web/              (เฟสถัดไป) หน้าเว็บ
POC_vectorize/    POC เดิม (2 สี) อ้างอิง
Blueprint_Vectorizer_CNC.md   พิมพ์เขียว (คู่แข่ง/license/roadmap)
```

## รันเดโม (พิสูจน์ผล)
```
pip install -r requirements.txt
python examples/run_demo.py
```
ผลล่าสุด (ภาพป้ายหลายสีจำลอง AI):
- **NAIVE trace: 3,580 nodes** (เส้นรก ตาม noise)
- **SMART (แยก layer สี): 66 nodes — ลด 98.2%** วงกลมกลมจริง มุมคม path ปิด
- ระบบ **ตรวจ CNC เตือนเอง** เมื่อเจอ feature เล็กกว่าดอกกัด
- ดู `examples/compare_v2.png`, ไฟล์ผล `examples/output_layered.svg`

## สถานะ: v0.2 — engine หลายสี + แยก layer + ตรวจ CNC ทำงานแล้ว
ถัดไป: แทนตัวอักษรด้วยฟอนต์จริง, DXF+kerf, VTracer(Rust), หน้าเว็บ — ดู `Blueprint_Vectorizer_CNC.md`
