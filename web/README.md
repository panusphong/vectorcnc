# VectorCNC — Web (ใช้งานจริง)

เว็บแอปจริง: อัปโหลดภาพ → `vectorcnc` engine แปลงเป็นเวกเตอร์ → ดาวน์โหลด SVG พร้อมตัด

```
web/
├─ frontend/index.html      # หน้าเว็บใช้งานได้จริง (อัปโหลด/แปลง/ดาวน์โหลด)
├─ backend/app.py           # FastAPI หุ้ม vectorcnc.pipeline.process
├─ backend/requirements.txt
├─ mockup.html              # ดีไซน์ตัวอย่าง (ไว้ดูทิศทาง/ป้อน Claude Design)
└─ ClaudeDesign_Prompt.md   # prompt สำหรับ gen UI ใน Claude Design
```

## รันจริงบนเครื่องพี่ (3 คำสั่ง)
```bash
cd VectorCNC_App/web/backend
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```
เปิดเบราว์เซอร์: **http://localhost:8000** → อัปโหลดรูป → กด "แปลงเป็นเวกเตอร์" → ดาวน์โหลด SVG
(ทดสอบแล้วในแซนด์บ็อกซ์: ภาพ 金龙 → 3 เลเยอร์ 160 โหนด ลด 91% SVG ใช้ได้จริง)

## API
| Method | Path | รับ | คืน |
|---|---|---|---|
| GET | `/api/health` | – | `{ok:true}` |
| POST | `/api/vectorize` | multipart: `file` (รูป), `n_colors` (2–12) | `{svg, width, height, layers, nodes, reduction_pct, layer_info[], svg_dataurl}` |

CORS เปิดหมด → เว็บ/Claude Design ที่ไหนก็เรียกได้

## เชื่อมกับ Claude Design
1. เอา prompt ใน `ClaudeDesign_Prompt.md` ไปวางใน **Claude Design** → ได้ UI สวย
2. ให้ backend เข้าถึงได้จากภายนอก (ตอนเทส): รัน `ngrok http 8000` → ได้ URL เช่น `https://xxx.ngrok.io`
3. ใน UI ของ Claude Design ให้ปุ่ม "แปลง" ยิง `POST <ngrok_url>/api/vectorize` (FormData: file, n_colors) แล้วเอา `svg` ที่คืนมาแสดง
4. ส่ง **URL ของ design** กลับมาให้อลิซ → อลิซ import + wire ปุ่มเข้ากับ API ให้ครบ

> หรือใช้ `frontend/index.html` ที่ทำไว้ได้เลย (ต่อ API ครบแล้ว) โดยไม่ต้องรอ Claude Design

## ค่าใช้จ่าย (สรุป)
| รายการ | ราคา |
|---|---|
| **Claude Design** | **ฟรี** — รวมในแพ็ก Claude ที่พี่มีอยู่ (Pro ~$20/เดือน) ไม่มีค่าเพิ่ม |
| **การเชื่อม API** | **ฟรี** — HTTP ธรรมดา ไม่มีค่าต่อการเชื่อมต่อ |
| **แปลงภาพ (ต่อรูป)** | **$0** — vectorcnc ใช้อัลกอริทึม CV ไม่เรียก Claude API เลย |
| **โฮสต์ backend** | ฟรี–$5–20/เดือน (Render/Railway/Fly free tier ได้ช่วงเทส) · CPU ล้วน ไม่ต้อง GPU |
| ngrok (เทสชั่วคราว) | ฟรี |

เพิ่มทีหลังถ้าจะทำ Super-Res/OCR ตัวหนังสือ → ค่อยมีค่า GPU (~$0.5–1/ชม.ตามใช้) ตอนนี้ยังไม่ต้อง

**สรุป: ทดสอบของจริงตอนนี้ = แทบฟรี** (Claude Design ฟรี + backend รันบนเครื่องพี่/free tier + ไม่มีค่าต่อภาพ)
