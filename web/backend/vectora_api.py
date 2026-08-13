# -*- coding: utf-8 -*-
"""🎨 Vectora API — เมนู 'แปลงภาพเป็นเวกเตอร์' ในหน้าออกแบบป้าย

กติกาของไฟล์นี้ (ตามข้อตกลงกับพี่):
  * แยกไฟล์เด็ดขาด — โค้ดเส้นตัดเดิมใน app.py ห้ามถูกแตะแม้แต่บรรทัดเดียว
  * app.py แค่ include_router เข้ามา 1 บรรทัด · ถ้าโมดูลนี้พังต้องไม่ทำให้แอปเดิมล่ม
  * ทุก endpoint ขึ้นต้นด้วย /api/vec/ ไม่ชนกับของเดิมแน่นอน
"""

import io
import os
import time
import uuid

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image

# 🧵 ย้ายงานหนักออกจาก "เส้นเดินหลัก" ของเซิร์ฟเวอร์
# ⚠️ ต้นเหตุจริงที่ผู้ใช้เจอ (2026-08-13 — "Unexpected token '<' ... is not valid JSON"):
#    endpoint เขียนเป็น async def แต่ข้างในเรียกงานแปลงเวกเตอร์แบบธรรมดา ซึ่งกิน
#    เวลา 1-3 นาที -> ตลอดเวลานั้น event loop ถูกยึดไว้ทั้งเส้น ตอบอะไรไม่ได้เลย
#    Dockerfile ตั้ง WEB_CONCURRENCY=1 และ render.yaml ตั้ง healthCheckPath ไว้
#    -> Render ยิงเช็คสุขภาพแล้วไม่มีใครตอบ = ตัดสินว่าเครื่องตาย -> รีสตาร์ตให้
#    -> คำขอที่กำลังทำอยู่ตายกลางคัน ผู้ใช้ได้หน้า error HTML กลับไปแทน JSON
#    (และระหว่างนั้นคนอื่นทั้งเว็บก็ค้างไปด้วย)
# ✅ โยนงานหนักไปเธรดอื่น -> event loop ว่างตอบเช็คสุขภาพและผู้ใช้คนอื่นได้ตลอด
#    (numpy/OpenCV ปล่อย GIL ระหว่างคำนวณหนักอยู่แล้ว จึงได้ผลจริง)
from starlette.concurrency import run_in_threadpool

try:
    from . import vectora_engine as VE, vectora_export as VX
except Exception:                                   # รันแบบไฟล์เดี่ยว
    import vectora_engine as VE
    import vectora_export as VX

router = APIRouter(prefix="/api/vec", tags=["vectora"])

MAX_BYTES = 30 * 1024 * 1024
CACHE = {}                                          # token -> {res, t, name}
CACHE_TTL = 1800.0
CACHE_MAX = 3          # ⚠️ ผลลัพธ์โหมดผสมก้อนใหญ่มาก เก็บในแรมเยอะ = เซิร์ฟเวอร์แรมหมด
                       #    (ดิสก์เก็บสำรองให้อยู่แล้ว หลุดจากแรมก็กู้กลับได้)
# 💾 สำรองผลลัพธ์ลงดิสก์ด้วย — แคชในแรมหายทุกครั้งที่โปรเซสรีสตาร์ต/deploy
#    (ผู้ใช้เจอจริง 2026-08-11: แปลงเสร็จ กดดาวน์โหลดไม่ได้เพราะ "ผลลัพธ์หมดอายุ")
VEC_DISK = "/tmp/vec_cache"
try:
    os.makedirs(VEC_DISK, exist_ok=True)
except Exception:
    pass


def _disk_put(tok, e):
    try:
        import pickle
        with open(os.path.join(VEC_DISK, "%s.pkl" % tok), "wb") as _f:
            pickle.dump(e, _f)
        now = time.time()
        for _fn in os.listdir(VEC_DISK):
            _p = os.path.join(VEC_DISK, _fn)
            if now - os.path.getmtime(_p) > CACHE_TTL:
                os.unlink(_p)
    except Exception:
        pass


def _disk_get(tok):
    try:
        import pickle, re as _re
        if not _re.fullmatch(r"[0-9a-f]{16}", tok or ""):
            return None
        _p = os.path.join(VEC_DISK, "%s.pkl" % tok)
        if not os.path.exists(_p) or time.time() - os.path.getmtime(_p) > CACHE_TTL:
            return None
        with open(_p, "rb") as _f:
            return pickle.load(_f)
    except Exception:
        return None


def _sweep():
    now = time.time()
    for k in [k for k, v in CACHE.items() if now - v["t"] > CACHE_TTL]:
        CACHE.pop(k, None)
    while len(CACHE) > CACHE_MAX:
        CACHE.pop(min(CACHE, key=lambda k: CACHE[k]["t"]), None)


# ══════════════════════════════════════════════════════════════════
# 🏃 งานเบื้องหลัง — แก้อาการ "แปลงไม่สำเร็จ Unexpected token '<'"
# ⚠️ ต้นเหตุจริง (จับได้ 2026-08-13 หลังลองแก้ผิดทางมาสองรอบ):
#    ตัวหน้าเว็บของโฮสต์ตัดการเชื่อมต่อทิ้งเมื่อคำขอ "เงียบ" นานเกินราว 50 วินาที
#    งานแปลงจริงใช้ 1-3 นาที และไม่มีไบต์ไหนถูกส่งออกเลยระหว่างนั้น -> โดนตัด
#    -> เบราว์เซอร์ได้หน้า error HTML แทน JSON (ผู้ใช้เจอที่ 49-50 วิ ทุกครั้ง ตรงเป๊ะ)
#    วัดแล้วไม่ใช่แรม (ใช้ 551 MB จาก 4 GB) และไม่ใช่ขั้นหลังแปลง (รวมกันแค่ 1.4 วิ)
# ✅ เลิกถือคำขอเดียวยาว ๆ: กดแปลง -> ได้เลขงานกลับทันที -> หน้าเว็บถามความคืบหน้า
#    ทุก 2 วินาที (คำขอละไม่ถึงวินาที ไม่มีทางโดนตัด) -> เสร็จแล้วค่อยรับผลลัพธ์
#    ผลพลอยได้: แถบความคืบหน้าเป็นของจริง ไม่ใช่แถบหลอกที่วิ่งตามเวลา
#    และงานจะนานแค่ไหนก็ได้ — เปิดทางให้ดันความคมได้เต็มที่โดยไม่ชนเพดานเวลา
# ══════════════════════════════════════════════════════════════════
# 💾 สถานะงานเก็บ "ลงดิสก์" ไม่ใช่ในแรมของโปรเซส
# ⚠️ ต้นเหตุของอาการล่าสุด (2026-08-13): ขึ้น "ไม่พบงานนี้" ทั้งที่แถบเพิ่งวิ่งถึง 75%
#    เครื่องเป็น Pro 4 GB (ยืนยันจากหน้า Render แล้ว) จึงไม่ใช่แรมหมดแน่นอน
#    แต่ Dockerfile เขียนไว้เองว่า "เปลี่ยน WEB_CONCURRENCY ได้จาก Environment ของ Render
#    โดยไม่ต้อง build ใหม่ · Pro 4GB -> 2" -> ถ้าตั้งไว้ 2 จะมีโปรเซสแยกกันสองตัว
#    /start ไปตกที่ตัวหนึ่ง (ตารางงานอยู่ในแรมของตัวนั้น) แต่ /status ถูกสลับไปอีกตัว
#    ซึ่งไม่รู้จักงานนี้เลย -> ตอบ "ไม่พบงานนี้" ทันที
# ✅ เก็บลงดิสก์ที่ทุกโปรเซสเห็นร่วมกัน -> จะกี่ worker ก็ตอบถูกหมด และรอดการรีสตาร์ตด้วย
JOB_TTL = 1800.0


def _job_p(job, ext="json"):
    import re as _re
    if not _re.fullmatch(r"[0-9a-f]{16}", job or ""):
        return None
    return os.path.join(VEC_DISK, "job_%s.%s" % (job, ext))


def _job_set(job, **kv):
    try:
        import json as _js
        p = _job_p(job)
        if not p:
            return
        d = _job_get(job) or {}
        d.update(kv)
        with open(p + ".tmp", "w", encoding="utf-8") as f:   # เขียนแล้วสลับชื่อ
            _js.dump(d, f)                                    # กันอ่านเจอไฟล์เขียนค้าง
        os.replace(p + ".tmp", p)
    except Exception:
        pass


def _job_get(job):
    try:
        import json as _js
        p = _job_p(job)
        if not p or not os.path.exists(p):
            return None
        if time.time() - os.path.getmtime(p) > JOB_TTL:
            return None
        with open(p, encoding="utf-8") as f:
            return _js.load(f)
    except Exception:
        return None


def _open(raw, name=""):
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        raise HTTPException(400, "เปิดไฟล์ภาพนี้ไม่ได้ — รองรับ JPG · PNG · GIF · BMP · WebP · TIFF")
    return im


def _rgba(im):
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        return np.asarray(im.convert("RGBA"))
    return np.asarray(im.convert("RGB"))


def _ratio(w, h):
    from math import gcd
    g = gcd(int(w), int(h)) or 1
    a, b = int(w) // g, int(h) // g
    if a > 40 or b > 40:                             # เศษส่วนสวย ๆ อ่านง่ายกว่า
        r = w / float(h)
        best = min(((abs(r - x / y), x, y) for x in range(1, 21) for y in range(1, 21)))
        a, b = best[1], best[2]
    return "%d : %d" % (a, b)


def _colors(arr):
    """นับ 'สีหลัก' ไม่ใช่สีดิบ

    ⚠️ นับสีดิบใช้ไม่ได้: โลโก้ 5 สีที่เซฟเป็น JPEG จะนับได้ 6,076 สี
       (รอยบีบอัด + ขอบเกลี่ยสี) แล้วระบบจะเตือนผิดว่า 'นี่คือภาพถ่าย'
    ✅ ปัดเป็นช่อง 16 ระดับต่อช่องสี แล้วนับเฉพาะช่องที่มีพิกเซลตั้งแต่ 0.05% ขึ้นไป
       วัดจริง: โลโก้ 67 · ภาพถ่าย 544 · ไฟล์เวกเตอร์แท้ 5
    """
    a = arr[:, :, :3] if arr.ndim == 3 else np.dstack([arr] * 3)
    q = (a >> 4).astype(np.int32)
    key = (q[:, :, 0] << 8) | (q[:, :, 1] << 4) | q[:, :, 2]
    cnt = np.bincount(key.ravel(), minlength=4096)
    return int((cnt >= key.size * 0.0005).sum()), int((cnt > 0).sum())


def _blur_pct(arr):
    """สัดส่วนพิกเซล 'ขอบเบลอ' — ยิ่งสูง ยิ่งมีข้อมูลย่อยพิกเซลให้ใช้ ผลลัพธ์ยิ่งคม"""
    import cv2
    g = cv2.cvtColor(arr[:, :, :3] if arr.ndim == 3 else arr, cv2.COLOR_RGB2GRAY)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    m = np.hypot(gx, gy)
    edge = m > (m.max() * 0.08 if m.max() > 0 else 1)
    if not edge.any():
        return 0.0
    soft = edge & (m < m.max() * 0.55)
    return round(float(soft.sum()) / float(edge.sum()) * 100.0, 1)


# ══════════════════════════════════════════════════════════════════
@router.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "ไฟล์ใหญ่เกิน 30 MB")
    im = _open(raw, file.filename or "")
    W, H = im.size
    arr = _rgba(im)
    has_a = arr.ndim == 3 and arr.shape[2] == 4 and int(arr[:, :, 3].min()) < 250
    fmt = (im.format or "?").upper()
    lossy = fmt in ("JPEG", "JPG", "WEBP")
    dpi = im.info.get("dpi") or (0, 0)
    dpi = int(dpi[0]) if dpi and dpi[0] else 0
    uniq, uniq_raw = _colors(arr)
    blur = _blur_pct(arr)
    mp = W * H / 1e6

    notes = []
    if mp < 0.5 and blur >= 12:
        notes.append({"kind": "ok", "th": "ภาพนี้แปลงได้ดี — ถึงจะเล็กแค่ %.2f ล้านพิกเซล แต่มีพิกเซลขอบเบลอ %.1f%% "
                                          "ซึ่งระบบใช้คำนวณตำแหน่งขอบให้ละเอียดกว่าตารางพิกเซล ผลลัพธ์จึงคมกว่าภาพต้นฉบับ" % (mp, blur),
                      "en": "Great candidate — only %.2f MP but %.1f%% soft edge pixels, which the engine uses to place edges "
                            "more precisely than the pixel grid. The result comes out sharper than the source." % (mp, blur)})
    elif blur < 4:
        notes.append({"kind": "warn", "th": "ขอบภาพคมจัด (เบลอแค่ %.1f%%) — เป็นภาพที่ถูกย่อแบบไม่เกลี่ยสี "
                                            "ขอบที่ได้จะเป็นขั้นบันไดตามต้นฉบับ ลองเพิ่มความเนียนที่ตั้งค่าละเอียด" % blur,
                      "en": "Very hard edges (%.1f%% soft) — the source was resized without anti-aliasing, so edges will "
                            "follow its stair-steps. Try raising smoothing in Advanced." % blur})
    if lossy:
        notes.append({"kind": "warn", "th": "เป็นไฟล์ %s — อาจมีรอยด่างรอบขอบจากการบีบอัด ระบบกรองให้แล้วระดับหนึ่ง "
                                            "ถ้ามี PNG ต้นฉบับจะได้ผลสะอาดกว่า" % fmt,
                      "en": "%s file — compression can leave halos around edges. The engine filters some of it; "
                            "an original PNG will come out cleaner." % fmt})
    if mp > VE.MAX_MP:
        notes.insert(0, {"kind": "bad",
            "th": "ภาพใหญ่เกินมาตรฐาน %d × %d px (%.1f ล้านพิกเซล) — เพดานคือ %.0f ล้านพิกเซล "
                  "หรือราว 4000 × 4000 px · กรุณาย่อภาพเองก่อนแล้วอัปโหลดใหม่ "
                  "ระบบไม่ย่อภาพให้เอง เพราะไม่อยากลดความละเอียดต้นฉบับโดยไม่บอก" % (W, H, mp, VE.MAX_MP),
            "en": "Over the standard: %d × %d px (%.1f MP). The ceiling is %.0f MP (about 4000 × 4000 px). "
                  "Please resize it yourself and upload again — the engine will not downscale your "
                  "original without asking." % (W, H, mp, VE.MAX_MP)})
    if min(W, H) < VE.MIN_PX:
        notes.insert(0, {"kind": "bad",
            "th": "ภาพเล็กเกินมาตรฐาน %d × %d px — ต่ำสุดที่รับคือ %d px" % (W, H, VE.MIN_PX),
            "en": "Below the standard: %d × %d px — the minimum is %d px" % (W, H, VE.MIN_PX)})
    if uniq > 200:
        notes.append({"kind": "warn", "th": "ภาพนี้สีเยอะมาก (%s สี) เหมือนภาพถ่าย — งานเวกเตอร์เหมาะกับโลโก้/ลายเส้น "
                                            "ถ้าเป็นภาพถ่ายควรเพิ่มจำนวนสีหรือใช้พรีเซ็ต 'ใช้งานทั่วไป'" % format(uniq, ","),
                      "en": "Very rich in colour (%s tones) — looks photographic. Vectorising suits logos and line art; "
                            "for photos raise the colour count or stay on the General preset." % format(uniq, ",")})

    return {
        "ok": True,
        "name": file.filename or "image",
        "format": fmt, "lossy": lossy,
        "width": W, "height": H, "mp": round(mp, 2),
        "ratio": _ratio(W, H),
        "bytes": len(raw),
        "mode": im.mode, "alpha": has_a,
        "dpi": dpi,
        "colors": uniq,
        "blur_pct": blur,
        "print_in": [round(W / 300.0, 1), round(H / 300.0, 1)],
        "notes": notes,
    }


# ══════════════════════════════════════════════════════════════════
@router.post("/convert")
async def convert(file: UploadFile = File(...),
                  preset: str = Form("general"),
                  k: int = Form(0), smooth: int = Form(-1),
                  tol: float = Form(-1.0), gap: float = Form(-1.0),
                  transparent: int = Form(-1),
                  # 🌈 โหมดไล่สี/ภาพถ่าย — ไม่ตัดสีผสม + เพดาน 64 สี (ผู้ใช้สั่ง 2026-08-09)
                  grad: int = Form(0)):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "ไฟล์ใหญ่เกิน 30 MB")
    arr = _rgba(_open(raw, file.filename or ""))

    def _work():                                 # 🧵 ทั้งก้อนนี้ทำในเธรดอื่น (ดูหมายเหตุหัวไฟล์)
        _r = VE.vectorize(arr, preset=preset,
                          k=(int(k) if int(k) > 0 else (0 if preset == "general" else None)),
                          smooth=(int(smooth) if int(smooth) >= 0 else None),
                          tol=(float(tol) if float(tol) >= 0 else None),
                          gap=(float(gap) if float(gap) >= 0 else None),
                          transparent=(None if int(transparent) < 0 else bool(int(transparent))),
                          grad=bool(int(grad or 0)))
        return _r, VX.to_svg(_r)

    try:
        res, svg = await run_in_threadpool(_work)
    except ValueError as e:                     # ผิดมาตรฐานขาเข้า -> บอกผู้ใช้ตรง ๆ
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, "แปลงไม่สำเร็จ: %s" % e)
    _sweep()
    tok = uuid.uuid4().hex[:16]
    CACHE[tok] = {"res": res, "t": time.time(), "name": (file.filename or "image")}
    _disk_put(tok, CACHE[tok])
    # 📄 PDF ไม่ต้องทำเผื่อไว้ตั้งแต่ตอนนี้แล้ว (พี่สั่ง 2026-08-13: "ใช้หลักการพิมพ์
    #    ปกติเลย ไม่ต้องคิดอะไรให้ซับซ้อน") — ตอนกดโหลดค่อยพิมพ์ทีเดียว วัดจริงแค่ 0.9 วิ
    #    ที่เคยต้องทำเผื่อ เพราะสมัยเครื่องแรม 512 MB การกู้ผลลัพธ์ตอนกดโหลดแล้วแรมหมด
    #    ตอนนี้เครื่องเป็น Pro 4 GB — ข้อจำกัดนั้นหมดไป จึงตัดกลไกเผื่อทิ้งทั้งชุด
    #    (ไฟล์ .pdf/.name ที่ค้างอยู่ ถูก _sweep() เก็บกวาดตามอายุอยู่แล้ว)
    st = dict(res["stats"])
    st["svg_bytes"] = len(svg.encode("utf-8"))
    return JSONResponse({"ok": True, "token": tok, "svg": svg, "stats": st,
                         "size": list(res["size"]),
                         # 🤝 โหมดผสม VTracer มีเป็นพันชั้น -> ส่งจานสีแบบไม่ซ้ำพอ (กัน UI พัง)
                         "palette": list(dict.fromkeys(tuple(L["rgb"]) for L in res["layers"]))[:64]})


# ══════════════════════════════════════════════════════════════════
# 🏃 แปลงแบบงานเบื้องหลัง — ทางที่หน้าเว็บใช้จริง (ดูหมายเหตุยาวตรง JOBS)
#    /start  -> ส่งไฟล์ ได้เลขงานกลับทันที (ไม่ถึงวินาที)
#    /status -> ถามความคืบหน้า · เสร็จแล้วได้ผลลัพธ์เต็มก้อนในครั้งเดียว
# ══════════════════════════════════════════════════════════════════
@router.post("/start")
async def start(file: UploadFile = File(...),
                preset: str = Form("general"),
                k: int = Form(0), smooth: int = Form(-1),
                tol: float = Form(-1.0), gap: float = Form(-1.0),
                transparent: int = Form(-1), grad: int = Form(0)):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "ไฟล์ใหญ่เกิน 30 MB")
    arr = _rgba(_open(raw, file.filename or ""))
    name = file.filename or "image"
    job = uuid.uuid4().hex[:16]
    _job_set(job, state="run", pct=2, step="เตรียมภาพ", t0=time.time())

    def _run():
        try:
            _last = [0]

            def _tick(pct, step):                # 📶 ความคืบหน้าจริงจากตัวเครื่องแปลง
                if int(pct) != _last[0]:         # เขียนดิสก์เฉพาะตอนตัวเลขขยับจริง
                    _last[0] = int(pct)
                    _job_set(job, state="run", pct=int(pct), step=step)
            _tick(6, "กำลังทำพื้นไล่สี + ลายเส้นคม")
            _r = VE.vectorize(arr, preset=preset,
                              k=(int(k) if int(k) > 0 else (0 if preset == "general" else None)),
                              smooth=(int(smooth) if int(smooth) >= 0 else None),
                              tol=(float(tol) if float(tol) >= 0 else None),
                              gap=(float(gap) if float(gap) >= 0 else None),
                              transparent=(None if int(transparent) < 0 else bool(int(transparent))),
                              grad=bool(int(grad or 0)), progress=_tick)
            _tick(92, "ประกอบไฟล์เวกเตอร์")
            _s = VX.to_svg(_r)
            _sweep()
            _tk = uuid.uuid4().hex[:16]
            CACHE[_tk] = {"res": _r, "t": time.time(), "name": name}
            _disk_put(_tk, CACHE[_tk])
            _st = dict(_r["stats"]); _st["svg_bytes"] = len(_s.encode("utf-8"))
            # ตัว SVG ก้อนใหญ่เก็บเป็นไฟล์ต่างหาก ไม่ยัดลงไฟล์สถานะ (จะได้อ่าน/เขียนเร็ว)
            with open(os.path.join(VEC_DISK, "%s.svg" % _tk), "w", encoding="utf-8") as _f:
                _f.write(_s)
            _job_set(job, state="done", pct=100, step="เสร็จแล้ว",
                     out={"ok": True, "token": _tk, "stats": _st,
                          "size": list(_r["size"]),
                          "palette": list(dict.fromkeys(
                              tuple(L["rgb"]) for L in _r["layers"]))[:64]})
        except Exception as _e:
            _job_set(job, state="err", msg=str(_e)[:300])

    import threading as _th
    _th.Thread(target=_run, daemon=True).start()
    return JSONResponse({"ok": True, "job": job})


@router.get("/status")
def status(job: str):
    J = _job_get(job)
    if not J:
        raise HTTPException(404, "ไม่พบงานนี้ — อาจหมดอายุแล้ว กดแปลงใหม่อีกครั้งค่ะ")
    if J.get("state") == "err":
        raise HTTPException(500, "แปลงไม่สำเร็จ: %s" % J.get("msg", ""))
    if J.get("state") == "done":
        out = dict(J.get("out") or {})
        try:                                     # อ่าน SVG จากไฟล์แล้วส่งไปพร้อมกันทีเดียว
            with open(os.path.join(VEC_DISK, "%s.svg" % out["token"]), encoding="utf-8") as _f:
                out["svg"] = _f.read()
        except Exception:
            raise HTTPException(404, "ผลลัพธ์หมดอายุแล้ว — กดแปลงใหม่อีกครั้งค่ะ")
        return JSONResponse(dict(out, state="done"))
    return JSONResponse({"ok": True, "state": "run", "pct": int(J.get("pct", 5)),
                         "step": J.get("step", ""),
                         "seconds": round(time.time() - float(J.get("t0", time.time())), 1)})


# ══════════════════════════════════════════════════════════════════
@router.get("/export")
def export(token: str, fmt: str = "svg", scale: float = 2.0, mm_per_px: float = 0.0):
    fmt = (fmt or "svg").lower()
    if fmt not in VX.EXT:
        raise HTTPException(400, "นามสกุลนี้ยังไม่รองรับ")
    # 📄 PDF เดินทางเดียวกับนามสกุลอื่นแล้ว — กู้ผลลัพธ์ แล้ว "พิมพ์" ออกมาเป็นหน้ากระดาษ
    #    (พี่สั่ง 2026-08-13: ใช้หลักการพิมพ์ปกติ ไม่ต้องมีทางลัด/ไฟล์เผื่อให้ซับซ้อน)
    e = CACHE.get(token)
    if not e:
        e = _disk_get(token)                     # 💾 แรมโดนล้าง (รีสตาร์ต) -> กู้จากดิสก์
        if e:
            CACHE[token] = e
    if not e:
        raise HTTPException(404, "ผลลัพธ์หมดอายุแล้ว — กดแปลงใหม่อีกครั้งค่ะ")
    try:
        data = VX.render(e["res"], fmt, png_scale=max(0.25, min(8.0, float(scale))),
                         mm_per_px=(float(mm_per_px) or None))
    except MemoryError:
        # 🛟 PNG ใหญ่ + ผลลัพธ์โหมดผสม (เส้น 5 หมื่นจุด) อาจกินแรมเกินเครื่องเซิร์ฟเวอร์
        #    ถอยมาลองขนาดเท่าต้นฉบับก่อนยอมแพ้
        try:
            data = VX.render(e["res"], fmt, png_scale=1.0,
                             mm_per_px=(float(mm_per_px) or None))
        except Exception as ex:
            raise HTTPException(500, "สร้างไฟล์ %s ไม่สำเร็จ (แรมไม่พอ): %s" % (fmt.upper(), ex))
    except Exception as ex:
        import traceback as _tb
        raise HTTPException(500, "สร้างไฟล์ %s ไม่สำเร็จ: %s | %s"
                            % (fmt.upper(), ex, _tb.format_exc()[-300:]))
    base = (e["name"].rsplit(".", 1)[0] or "vector")[:60]
    return Response(content=data, media_type=VX.MIME[fmt],
                    headers={"Content-Disposition": 'attachment; filename="%s.%s"' % (base, VX.EXT[fmt]),
                             "Cache-Control": "no-store"})


# ══════════════════════════════════════════════════════════════════
# 🧩 ออกแบบป้ายจากไฟล์เวกเตอร์ (.svg/.ai/.pdf/.eps)
#    ต่างจาก /convert ตรงที่ **ไม่ไล่เส้นใหม่** — อ่าน path จริงแล้วให้ผู้ใช้เลือกชิ้นเอง
# ══════════════════════════════════════════════════════════════════
VCACHE = {}                                          # token -> {"pieces":..., "t":..., "art":{}}


def _vsweep():
    now = time.time()
    for k in [k for k, v in VCACHE.items() if now - v["t"] > CACHE_TTL]:
        VCACHE.pop(k, None)
    while len(VCACHE) > CACHE_MAX:
        VCACHE.pop(min(VCACHE, key=lambda k: VCACHE[k]["t"]), None)


@router.post("/pieces")
async def vec_pieces(file: UploadFile = File(...), width_mm: float = Form(0.0)):
    """อัปไฟล์เวกเตอร์ -> รายการ 'ชิ้น' ที่เลือกได้ทีละชิ้น"""
    import vectora_vector as VV
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(400, "ไฟล์ใหญ่เกิน 30 MB")
    name = file.filename or "art.svg"
    if not VV.is_vector(name, raw):
        raise HTTPException(400, "เมนูนี้รับเฉพาะไฟล์เวกเตอร์ (.svg .ai .pdf .eps) "
                                 "— ถ้าเป็นภาพถ่าย/JPG/PNG ให้ใช้เมนูแปลงภาพเป็นเวกเตอร์แทนค่ะ")
    try:
        P = VV.pieces(raw, name, real_width_mm=float(width_mm or 0))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, "อ่านไฟล์เวกเตอร์ไม่สำเร็จ: %s" % e)
    _vsweep()
    tok = uuid.uuid4().hex[:16]
    VCACHE[tok] = {"pieces": P, "t": time.time(), "name": name, "art": {}}
    G = VV.group_pieces(P)
    return JSONResponse({"ok": True, "token": tok, "size": P["size"],
                         "mm_size": P["mm_size"], "mm_per_unit": P["mm_per_unit"],
                         "pieces": P["pieces"], "groups": G, "stats": P["stats"]})


@router.post("/art")
async def vec_art(token: str = Form(...), key: str = Form("bg1"),
                  file: UploadFile = File(...)):
    """อัปไฟล์ artwork ไว้ใช้เป็นพื้นหลังหน้าป้าย (ภาพ หรือ เวกเตอร์)"""
    import base64
    e = VCACHE.get(token)
    if not e:
        raise HTTPException(404, "งานหมดอายุแล้ว — อัปไฟล์ใหม่อีกครั้งค่ะ")
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(400, "ไฟล์ใหญ่เกิน 30 MB")
    nm = (file.filename or "").lower()
    mime = ("image/jpeg" if nm.endswith((".jpg", ".jpeg")) else
            "image/webp" if nm.endswith(".webp") else "image/png")
    if nm.endswith((".svg", ".pdf", ".ai", ".eps")):
        # เวกเตอร์ -> เรนเดอร์เป็นภาพความละเอียดสูงไว้ใช้เป็นพื้นหลัง (พิมพ์ UV ใช้ได้จริง)
        import vectora_vector as VV, cairosvg
        try:
            if nm.endswith(".svg"):
                raw = cairosvg.svg2png(bytestring=raw, output_width=2400)
            else:
                import fitz
                d = fitz.open("pdf", VV._to_pdf(raw, nm))
                pg = d[0]; r = pg.rect
                sc = 2400.0 / max(1.0, max(r.width, r.height))
                raw = pg.get_pixmap(matrix=fitz.Matrix(sc, sc), alpha=False).tobytes("png")
            mime = "image/png"
        except Exception as ex:
            raise HTTPException(400, "อ่านไฟล์พื้นหลังนี้ไม่ได้: %s" % ex)
    e["art"][key] = {"kind": "image", "mime": mime,
                     "data": base64.b64encode(raw).decode()}
    e["t"] = time.time()
    return {"ok": True, "key": key, "bytes": len(raw), "mime": mime}


@router.post("/compose")
async def vec_compose(token: str = Form(...), layout: str = Form("[]"),
                      margin_mm: float = Form(0.0), bleed: int = Form(1),
                      simplify_mm: float = Form(0.0), width_mm: float = Form(0.0),
                      mode: str = Form("box")):
    """ประกอบร่าง -> คืน หน้าป้าย (พรีวิว) + เส้นตัด + กรอบของแต่ละชิ้นไว้ลากบนจอ"""
    import json as _json
    import vectora_vector as VV
    e = VCACHE.get(token)
    if not e:
        raise HTTPException(404, "งานหมดอายุแล้ว — อัปไฟล์ใหม่อีกครั้งค่ะ")
    try:
        LO = _json.loads(layout or "[]")
    except Exception:
        raise HTTPException(400, "รูปแบบผังงานไม่ถูกต้อง")
    P = e["pieces"]
    if float(width_mm or 0) > 0 and abs(float(width_mm) - P["mm_size"][0]) > 0.01:
        # ผู้ใช้เปลี่ยนขนาดจริงของไฟล์ต้นทาง -> คิดสเกลใหม่ทั้งชุด
        k = float(width_mm) / max(P["mm_size"][0], 1e-9)
        P = dict(P); P["mm_per_unit"] = P["mm_per_unit"] * k
        P["mm_size"] = [round(v * k, 2) for v in P["mm_size"]]
    try:
        R = VV.compose(P, LO, margin_mm=float(margin_mm or 0), art=e["art"],
                       bleed_mm=(2.0 if int(bleed) else 0.0),
                       simplify_mm=float(simplify_mm or 0),
                       keep_all=(str(mode) == "dicut"))
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    except Exception as ex:
        raise HTTPException(500, "ประกอบร่างไม่สำเร็จ: %s" % ex)
    e["last"] = R; e["t"] = time.time()
    return JSONResponse({"ok": True, "face_svg": R["face_svg"], "cut_svg": R["cut_svg"],
                         "outline_d": R["outline_d"], "boxes": R["boxes"],
                         "size_mm": R["size_mm"], "origin_mm": R["origin_mm"],
                         "stats": R["stats"]})


@router.get("/vexport")
def vec_export(token: str, kind: str = "cut", fmt: str = "svg", scale: float = 2.0):
    """ดาวน์โหลด: kind = cut (เส้นตัด) หรือ face (งานพิมพ์ UV)"""
    import cairosvg
    e = VCACHE.get(token)
    if not e or not e.get("last"):
        raise HTTPException(404, "ยังไม่มีผลลัพธ์ — กดประกอบร่างก่อนค่ะ")
    R = e["last"]
    svg = R["cut_svg"] if kind == "cut" else R["face_svg"]
    fmt = (fmt or "svg").lower()
    base = "%s_%s" % ((e["name"].rsplit(".", 1)[0] or "sign")[:40], kind)
    if fmt == "svg":
        data = svg.encode("utf-8"); mime = "image/svg+xml"; ext = "svg"
    elif fmt == "pdf":
        data = cairosvg.svg2pdf(bytestring=svg.encode()); mime = "application/pdf"; ext = "pdf"
    elif fmt == "png":
        data = cairosvg.svg2png(bytestring=svg.encode(),
                                scale=max(0.25, min(8.0, float(scale))))
        mime = "image/png"; ext = "png"
    elif fmt == "dxf":
        if kind != "cut":
            raise HTTPException(400, "DXF ใช้กับเส้นตัดเท่านั้น")
        data = _outline_dxf(R); mime = "application/dxf"; ext = "dxf"
    else:
        raise HTTPException(400, "นามสกุลนี้ยังไม่รองรับ")
    return Response(content=data, media_type=mime,
                    headers={"Content-Disposition": 'attachment; filename="%s.%s"' % (base, ext),
                             "Cache-Control": "no-store"})


def _outline_dxf(R):
    """เส้นตัด -> DXF หน่วยมิลลิเมตร · แกน Y กลับด้านให้ถูกทางเครื่องตัด"""
    import ezdxf
    from io import StringIO
    doc = ezdxf.new("R2010"); doc.units = 4          # 4 = มิลลิเมตร
    msp = doc.modelspace()
    ox, oy = R["origin_mm"]; H = R["size_mm"][1]
    for chunk in R["outline_d"].split("M"):
        chunk = chunk.strip().rstrip("Z").strip()
        if not chunk:
            continue
        v = [float(x) for x in chunk.replace("L", " ").split()]
        pts = [(x - ox, H - (y - oy)) for x, y in zip(v[0::2], v[1::2])]
        if len(pts) >= 3:
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "CUT"})
    b = StringIO(); doc.write(b)
    return b.getvalue().encode("utf-8")


@router.get("/ping")
def ping():
    return {"ok": True, "engine": "vectora", "presets": list(VE.PRESETS.keys())}
