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
ENV WEB_CONCURRENCY=4
# โฮสต์ (Render/Railway/Fly) จะ inject $PORT ให้เอง
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers ${WEB_CONCURRENCY} --timeout-keep-alive 65
