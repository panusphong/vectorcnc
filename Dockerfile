# ═══════════════════════════════════════════════════════════════════
#  Dockerfile — VectorCNC / Graphic Design Solution   (Render: runtime docker)
#
#  🔴 ทำไมต้องมีไฟล์นี้ (15 ก.ย. 69)
#     Render ขึ้น: error: failed to read dockerfile: open Dockerfile: no such
#     file or directory  ⇒ ในที่เก็บโค้ด (GitHub panusphong/vectorcnc) ไม่มี
#     ไฟล์ Dockerfile อยู่เลยสักไฟล์ (ตรวจแล้ว 167 ไฟล์ ไม่มีจริง ๆ)
#     แต่ render.yaml สั่งไว้ว่า dockerfilePath: ./Dockerfile
#     ⇒ Render โคลนโค้ดสำเร็จ แล้วหาไฟล์ที่จะ build ไม่เจอ ⇒ Deploy failed
#
#  ‼ วางไฟล์นี้ที่ "รากของที่เก็บโค้ด" เท่านั้น (ระดับเดียวกับ render.yaml)
#    ชื่อไฟล์ต้องเป็น  Dockerfile  เป๊ะ ๆ — ไม่มีนามสกุล ไม่มี .txt ต่อท้าย
#
#  คำสั่งรันของแอปนี้ (เขียนไว้ในหัว web/backend/app.py บรรทัด 3):
#    cd web/backend && pip install -r requirements.txt && uvicorn app:app
# ═══════════════════════════════════════════════════════════════════
FROM python:3.10-slim-bookworm

# ── ① ไลบรารีระดับระบบที่แพ็กเกจ Python ในโปรเจคนี้ "ต้องมี" ──────────
#    opencv-python-headless → libglib2.0-0
#    cairosvg               → libcairo2
#    pytesseract            → tesseract-ocr (+ ภาษาไทย)
#    subprocess gs (app.py:9994) → ghostscript
#    uharfbuzz / fonttools  → ใช้ฟอนต์ระบบเป็นตัวสำรอง
#    ‼ ติดตั้งแล้วล้างแคช apt ทิ้งในชั้นเดียวกัน — ไม่งั้นอิมเมจบวมฟรี ๆ
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 \
      libsm6 \
      libxext6 \
      libxrender1 \
      libgomp1 \
      libcairo2 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libgdk-pixbuf-2.0-0 \
      shared-mime-info \
      ghostscript \
      potrace \
      tesseract-ocr \
      tesseract-ocr-tha \
      tesseract-ocr-eng \
      fonts-dejavu-core \
      fonts-thai-tlwg \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ── ② ติดตั้งแพ็กเกจก่อนคัดลอกโค้ด ─────────────────────────────────
#    ก๊อป requirements.txt มาก่อนไฟล์อื่น ⇒ แก้โค้ดแล้ว build รอบหน้า
#    ไม่ต้องลงแพ็กเกจใหม่ทั้งหมด (Render มีแคชชั้นให้)
COPY web/backend/requirements.txt /app/web/backend/requirements.txt
RUN pip install --upgrade pip && \
    pip install -r /app/web/backend/requirements.txt

# ── ③ คัดลอกโค้ดทั้งโปรเจค ────────────────────────────────────────
COPY . /app

# ── ④ ที่เก็บข้อมูลถาวร ───────────────────────────────────────────
#    render.yaml ต่อดิสก์ไว้ที่ /var/data และตั้ง DATA_DIR=/var/data
#    สร้างไว้ให้ด้วย เผื่อรันที่อื่นที่ไม่มีดิสก์
ENV DATA_DIR=/var/data
RUN mkdir -p /var/data

# ── ⑤ ให้ import ได้ทั้ง "แพ็กเกจ vectorcnc" ที่ราก และโมดูลข้าง app.py ──
#    app.py:17 ใส่รากเข้า sys.path เองอยู่แล้ว แต่ตั้งซ้ำกันพลาด
ENV PYTHONPATH=/app:/app/web/backend

WORKDIR /app/web/backend

# ── ⑥ Render ส่งพอร์ตมาทาง $PORT — ห้าม hardcode 8000 ──────────────
#    healthCheckPath ใน render.yaml คือ /api/health (app.py:236)
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --timeout-keep-alive 75"]
