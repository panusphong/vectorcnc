# VectorCNC — deploy ทั้งเว็บ (backend + frontend + engine) เป็นบริการเดียว
FROM python:3.11-slim

# ระบบไลบรารีที่ opencv-headless / scikit-image ต้องใช้
# + ghostscript สำหรับแปลง .eps/.ps/.ai(PostScript) -> PDF ก่อนดึงเวกเตอร์
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgomp1 ghostscript \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
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
# โฮสต์ (Render/Railway/Fly) จะ inject $PORT ให้เอง
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT}
