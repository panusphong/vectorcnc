# -*- coding: utf-8 -*-
"""🎨 Vectora API — เมนู 'แปลงภาพเป็นเวกเตอร์' ในหน้าออกแบบป้าย

กติกาของไฟล์นี้ (ตามข้อตกลงกับพี่):
  * แยกไฟล์เด็ดขาด — โค้ดเส้นตัดเดิมใน app.py ห้ามถูกแตะแม้แต่บรรทัดเดียว
  * app.py แค่ include_router เข้ามา 1 บรรทัด · ถ้าโมดูลนี้พังต้องไม่ทำให้แอปเดิมล่ม
  * ทุก endpoint ขึ้นต้นด้วย /api/vec/ ไม่ชนกับของเดิมแน่นอน
"""

import io
import time
import uuid

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image

try:
    from . import vectora_engine as VE, vectora_export as VX
except Exception:                                   # รันแบบไฟล์เดี่ยว
    import vectora_engine as VE
    import vectora_export as VX

router = APIRouter(prefix="/api/vec", tags=["vectora"])

MAX_BYTES = 30 * 1024 * 1024
CACHE = {}                                          # token -> {res, t, name}
CACHE_TTL = 1800.0
CACHE_MAX = 40


def _sweep():
    now = time.time()
    for k in [k for k, v in CACHE.items() if now - v["t"] > CACHE_TTL]:
        CACHE.pop(k, None)
    while len(CACHE) > CACHE_MAX:
        CACHE.pop(min(CACHE, key=lambda k: CACHE[k]["t"]), None)


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
                  transparent: int = Form(-1)):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "ไฟล์ใหญ่เกิน 30 MB")
    arr = _rgba(_open(raw, file.filename or ""))
    try:
        res = VE.vectorize(arr, preset=preset,
                           k=(int(k) if int(k) > 0 else (0 if preset == "general" else None)),
                           smooth=(int(smooth) if int(smooth) >= 0 else None),
                           tol=(float(tol) if float(tol) >= 0 else None),
                           gap=(float(gap) if float(gap) >= 0 else None),
                           transparent=(None if int(transparent) < 0 else bool(int(transparent))))
    except ValueError as e:                     # ผิดมาตรฐานขาเข้า -> บอกผู้ใช้ตรง ๆ
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, "แปลงไม่สำเร็จ: %s" % e)

    svg = VX.to_svg(res)
    _sweep()
    tok = uuid.uuid4().hex[:16]
    CACHE[tok] = {"res": res, "t": time.time(), "name": (file.filename or "image")}
    st = dict(res["stats"])
    st["svg_bytes"] = len(svg.encode("utf-8"))
    return JSONResponse({"ok": True, "token": tok, "svg": svg, "stats": st,
                         "size": list(res["size"]), "palette": [L["rgb"] for L in res["layers"]]})


# ══════════════════════════════════════════════════════════════════
@router.get("/export")
def export(token: str, fmt: str = "svg", scale: float = 2.0, mm_per_px: float = 0.0):
    e = CACHE.get(token)
    if not e:
        raise HTTPException(404, "ผลลัพธ์หมดอายุแล้ว — กดแปลงใหม่อีกครั้งค่ะ")
    fmt = (fmt or "svg").lower()
    if fmt not in VX.EXT:
        raise HTTPException(400, "นามสกุลนี้ยังไม่รองรับ")
    try:
        data = VX.render(e["res"], fmt, png_scale=max(0.25, min(8.0, float(scale))),
                         mm_per_px=(float(mm_per_px) or None))
    except Exception as ex:
        raise HTTPException(500, "สร้างไฟล์ %s ไม่สำเร็จ: %s" % (fmt.upper(), ex))
    base = (e["name"].rsplit(".", 1)[0] or "vector")[:60]
    return Response(content=data, media_type=VX.MIME[fmt],
                    headers={"Content-Disposition": 'attachment; filename="%s.%s"' % (base, VX.EXT[fmt]),
                             "Cache-Control": "no-store"})


@router.get("/ping")
def ping():
    return {"ok": True, "engine": "vectora", "presets": list(VE.PRESETS.keys())}
