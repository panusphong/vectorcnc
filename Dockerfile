# VectorCNC — deploy ทั้งเว็บ (backend + frontend + engine) เป็นบริการเดียว
FROM python:3.11-slim

# ระบบไลบรารีที่ opencv-headless / scikit-image ต้องใช้
# + ghostscript สำหรับแปลง .eps/.ps/.ai(PostScript) -> PDF ก่อนดึงเวกเตอร์
# + ฟอนต์ไทย/ละติน สำหรับ AI Concept Kit (สร้างโลโก้เวกเตอร์จากฟอนต์)
# + tesseract-ocr (+ โมเดลไทย/อังกฤษ) สำหรับอ่านข้อความจากภาพที่ลูกค้าส่งมา
#   -> เอาข้อความมาวางบนกระดานออกแบบให้แก้ไขต่อได้ ไม่ต้องพิมพ์เองทั้งหมด
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgomp1 ghostscript \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
      tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng \
      fonts-thai-tlwg fonts-noto-core fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ติดตั้ง dependencies ก่อน (แคช layer)
COPY web/backend/requirements.txt ./req.txt
RUN pip install --no-cache-dir -r req.txt

# ══════════════════════════════════════════════════════════════════
# ✂️ อบโมเดลตัดพื้นหลังลงในอิมเมจตั้งแต่ตอน build
# ⚠️ ถ้าไม่ทำ: ดิสก์ของ Render เป็นชั่วคราว ทุกครั้งที่ deploy/รีสตาร์ต โมเดล 179 MB
#    จะถูกโหลดใหม่ตอนผู้ใช้กดปุ่มครั้งแรก = ผู้ใช้คนแรกรอ 10-20 วิ แถมถ้าเน็ตขาไม่ถึง
#    GitHub จะตัดพื้นหลังด้วยโมเดลไม่ได้เลย
# ✅ อบไว้ในอิมเมจ = พร้อมใช้ทันทีทุกครั้ง ไม่พึ่งเน็ตตอนรัน
# 🛟 || true เพื่อว่าถ้าโหลดไม่สำเร็จตอน build ก็ยัง build ผ่าน (ระบบมีทางสำรองอยู่แล้ว)
ENV REMBG_HOME=/opt/rembg
RUN python -c "from rembg import new_session; new_session('isnet-general-use')" || true

# ก๊อป engine + เว็บ
COPY vectorcnc ./vectorcnc
COPY web ./web

WORKDIR /app/web/backend
ENV PORT=8000
# 👷 จำนวน worker = จำนวนงานที่ทำ 'พร้อมกันจริง ๆ' ได้
#    งานสร้างไฟล์ตัดกิน CPU เต็ม ๆ และเป็น async def -> 1 worker = ทำได้ทีละ 1 คน คนอื่นเข้าคิว
#    วัดจริง: 3 คนยิงพร้อมกันบน 1 worker -> คนที่ 3 รอ 12.98 วิ ทั้งที่งานตัวเองใช้ 4.4 วิ
#    ตั้งเท่าจำนวน CPU ของแพ็กเกจ (Render Pro Plus = 4 CPU / 8 GB)
#    แรมที่ใช้จริง ~250 MB ต่อ worker -> 4 workers ≈ 1 GB จาก 8 GB (เหลือเฟือ)
#    เปลี่ยนค่าได้จาก Environment ของ Render โดยไม่ต้อง build ใหม่: WEB_CONCURRENCY
# ⚠️ ตั้งตามแรมของแพ็กเกจจริง: งานเวกเตอร์หนักกินแรม ~1.3GB/คำขอ (วัดจริง 2026-07-29)
#    free/starter (512MB) -> 1 worker ก็ยังไม่พอสำหรับงานใหญ่ (ต้องอัปเกรดแผน)
#    Standard 2GB -> 1 · Pro 4GB -> 2 · Pro Plus 8GB -> 4 (ปรับที่ Environment ของ Render ได้ ไม่ต้อง build ใหม่)
# ⚠️ เพิ่มเติมหลังใส่ตัวตัดพื้นหลัง (2026-08-18): แต่ละ worker ที่เคยเรียกตัดพื้นหลัง
#    จะอมโมเดลไว้ในแรมของตัวเองราว 350-450 MB (โหลดครั้งเดียวแล้วค้างไว้ให้เร็ว)
#    -> Pro 4GB ตั้งได้ไม่เกิน 2 · Pro Plus 8GB ตั้งได้ 4 เหมือนเดิม
#    ถ้าไม่อยากให้กินแรม ตั้ง CUTOUT_MODEL=u2netp (โมเดลเล็ก 4.7 MB) แทนได้
ENV WEB_CONCURRENCY=1
# โฮสต์ (Render/Railway/Fly) จะ inject $PORT ให้เอง
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers ${WEB_CONCURRENCY} --timeout-keep-alive 65
