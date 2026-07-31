"""
VectorCNC API — FastAPI หุ้ม vectorcnc.pipeline.process
รัน:  cd web/backend  &&  pip install -r requirements.txt  &&  uvicorn app:app --host 0.0.0.0 --port 8000
เปิด: http://localhost:8000            (หน้าเว็บ frontend)
API : POST http://localhost:8000/api/vectorize   (multipart: file, n_colors)
CORS เปิดหมด -> Claude Design / เว็บที่ไหนก็เรียกได้
"""
import os, sys, tempfile, base64, re, json, traceback
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import (JSONResponse, FileResponse, PlainTextResponse,
                               Response, HTMLResponse, RedirectResponse)
import datetime as _dt

# ให้ import แพ็กเกจ vectorcnc (อยู่ที่ราก VectorCNC_App)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
# หมายเหตุ: ไม่ import vectorcnc ที่นี่ (opencv โหลดหนัก ~นาที บนเครื่องฟรี)
# ใช้ lazy import ในตัว handler แทน -> แอปเปิด port ทันที health check ผ่าน

app = FastAPI(title="VectorCNC API", version="1.0")
app.add_middleware(GZipMiddleware, minimum_size=800)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)

FRONTEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "index.html")


def hexcolor(c):
    try:
        b, g, r = int(c[0]), int(c[1]), int(c[2])   # vectorcnc ใช้ BGR
        return '#%02x%02x%02x' % (r, g, b)
    except Exception:
        return '#8CA0C6'


def _psd_ok():
    try:
        import psd_tools  # noqa
        return True
    except Exception:
        return False


@app.get("/api/health")
def health():
    try:
        from vectorcnc import trace_engine
        eng = getattr(trace_engine, "ENGINE_VERSION", "OLD(no-version)")
    except Exception as e:
        eng = "import-error: " + str(e)
    try:
        from vectorcnc import bezier_vec
        bez = getattr(bezier_vec, "BEZIER_VERSION", "OLD(no-version)")
    except Exception as e:
        bez = "import-error: " + str(e)
    try:
        from vectorcnc import nesting as _nst
        nst = getattr(_nst, "NESTING_VERSION", "OLD(no-version)")
    except Exception as e:
        nst = "import-error: " + str(e)
    def _v(mod, attr):
        try:
            m = __import__("vectorcnc." + mod, fromlist=[mod])
            return getattr(m, attr, "OLD")
        except Exception as e:
            return "import-error: " + str(e)[:60]
    return {"ok": True, "service": "VectorCNC",
            "version": "9.37-dxf-clean-tiny-slivers",
            "build": "2026-07-31-c",
        "build_note": "ฐาน -31a + เส้นเดี่ยว = แกนกลางกลางเนื้อ (เบซิเยร์เนียนกริบ) · ถอยเป็นเส้นตัดตัดช่องในถ้าโมดูลไม่ให้ผล",
            "sign_types": len(SIGN_TYPES),                   # 15 (มีทรงเรขาคณิต กลม/เหลี่ยม/วงรี)
            "arm_mount": "on",
            "mount_frame": "on",  # โครงแขวน + เจาะรู
            "led_ribbon": "on",   # วางเส้นไฟ LED + คำนวณหม้อแปลง                               # แขนยึด none/top2/side1/side2 + เพลท 10cm
            "design_to_wall": "on",                          # ออกแบบเสร็จ -> ส่งเข้าจำลองผนังทันที
            "app_lock": "on" if _app_locked() else "off",   # 🔒 บล็อกคนนอก (ตั้ง APP_LOCK=1)
            "face_art_3d": "on",                             # รูปพิมพ์จริงบนหน้า 3D (กล่องไฟล้อมทรง)
            "step_repeat": "on",                             # งานพิมพ์ผลิตซ้ำ + ตัดเลเซอร์ตามหมุด
            "engine": eng, "bezier": bez, "nesting": nst, "psd": _psd_ok(),
            "assets": _v("assets", "ASSETS_VERSION"),
            "producible": _v("producible", "PRODUCIBLE_VERSION"),
            "concept": _v("concept", "CONCEPT_VERSION"),
            # ── โมดูลใหม่ (ใช้เช็คว่า deploy โค้ดล่าสุดหรือยัง) ──
            "print_ai": _v("print_ai", "PRINT_AI_VERSION"),
            "job_packet": _v("job_packet", "JOB_PACKET_VERSION"),
            "billing": _v("billing", "BILLING_VERSION"),
            "auth": "hmac" if _v("auth", "AUTH_VERSION") != "OLD" else "OLD",
            "color_engine": "vtracer-cp8-clip" if hasattr(
                __import__("vectorcnc.trace_engine", fromlist=["trace_engine"]),
                "trace_color_vtracer") else "OLD-posterize",
            "contour_box": "on" if "8" in SIGN_TYPES and SIGN_TYPES.get("8", {}).get("wrap") else "OLD"}


def _enhance_image(inp, tmp):
    """✨ ปรับคุณภาพภาพ (auto·ปลอดภัย): ลด noise เก็บขอบ + ขยายรูปเล็ก + unsharp + พื้นขาวสะอาด
       ใช้ร่วมกันทั้งตอน vectorize และตอนสร้างไฟล์ .ai · คืน path ไฟล์ใหม่ (ถ้าพลาด คืน inp เดิม)"""
    try:
        import cv2 as _cv, numpy as _np
        im = _cv.imread(inp, _cv.IMREAD_COLOR)
        if im is None:
            return inp
        lng = max(im.shape[:2])
        # 1) ลด noise คุณภาพสูง เก็บขอบคม (adaptive ตามขนาดภาพ)
        if lng < 2500:
            im = _cv.fastNlMeansDenoisingColored(im, None, 6, 6, 7, 21)
        else:
            im = _cv.bilateralFilter(im, 7, 50, 50)
        # 2) ขยายภาพเล็ก/กลาง -> เป้า ~2200px (stepped LANCZOS = คมกว่าการขยายทีเดียว)
        target = 2200.0
        if lng < 1800:
            sc = min(target / lng, 4.0); cur = 1.0
            while cur * 2 <= sc:
                im = _cv.resize(im, None, fx=2, fy=2, interpolation=_cv.INTER_LANCZOS4); cur *= 2
            if sc / cur > 1.02:
                im = _cv.resize(im, None, fx=sc / cur, fy=sc / cur, interpolation=_cv.INTER_LANCZOS4)
        # 3) unsharp mask -> ขอบคมชัด รายละเอียดเด้ง
        _blur = _cv.GaussianBlur(im, (0, 0), 2.0)
        im = _cv.addWeighted(im, 1.5, _blur, -0.5, 0)
        # 4) bilateral รอบสอง -> เก็บขอบ ลด noise ที่ unsharp อาจเน้นขึ้น
        im = _cv.bilateralFilter(im, 7, 55, 55)
        # 5) พื้นหลังขาวสะอาด (คอนทราสต์เบา) เฉพาะภาพพื้นสว่าง
        gray = _cv.cvtColor(im, _cv.COLOR_BGR2GRAY)
        brd = _np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
        bgv = float(_np.median(brd))
        if bgv >= 150:
            lo, hi = float(_np.percentile(gray, 4)), max(bgv - 4, 60.0)
            im = _np.clip((im.astype(_np.float32) - lo) * (255.0 / max(20.0, hi - lo)), 0, 255).astype(_np.uint8)
        enh = os.path.join(tmp, "enhanced.png"); _cv.imwrite(enh, im)
        return enh
    except Exception:
        return inp


@app.post("/api/vectorize")
async def vectorize(
    file: UploadFile = File(...),
    n_colors: int = Form(6),
    real_width_mm: float = Form(1200.0),
    kerf_mm: float = Form(3.0),
    tool_mm: float = Form(6.0),
    tabs: int = Form(0),
    mode: str = Form("auto"),
    size_by: str = Form("width"),
    size_value_mm: float = Form(0.0),
    enhance: int = Form(0),
):
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    out_svg = os.path.join(tmp, "cut.svg")
    out_dxf = os.path.join(tmp, "cut.dxf")
    data = await file.read()
    with open(inp, "wb") as f:
        f.write(data)
    # ---- .PSD/.PSB -> composite เป็น PNG (พื้นขาว) แล้วเข้าเครื่องยนต์ตัดเหมือนรูปภาพ ----
    if str(inp).lower().endswith((".psd", ".psb")):
        try:
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None
            pim = Image.open(inp); pim.thumbnail((3200, 3200))
            pim = pim.convert("RGBA")
            flat = Image.new("RGB", pim.size, (255, 255, 255))
            flat.paste(pim, mask=pim.split()[3])       # วางบนพื้นขาว (คงรูปทรงจริง)
            png = os.path.join(tmp, "psd_flat.png"); flat.save(png); inp = png
        except Exception as e:
            return JSONResponse({"error": "อ่านไฟล์ PSD ไม่ได้: " + str(e)}, status_code=400)
    _isimg = str(inp).lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"))
    # ---- ✨ ปรับคุณภาพภาพก่อนแปลง (auto·ปลอดภัย): ขยายรูปเล็ก + ลด noise เก็บขอบ + คอนทราสต์เบา ----
    if _isimg and int(enhance):
        inp = _enhance_image(inp, tmp)
    # ---- raster + "ตัดชิ้น" -> vtracer (เส้นตรง=line, โค้ง=spline, มุมคม) คุณภาพเวกเตอร์มืออาชีพ ----
    if _isimg and str(mode).lower() == "cutout":
        try:
            from vectorcnc import bezier_vec
            bz = bezier_vec.vectorize_bezier(inp, real_width_mm=float(real_width_mm),
                                             n_colors=max(2, min(12, int(n_colors))), dxf_out=out_dxf,
                                             size_by=str(size_by), size_value_mm=float(size_value_mm),
                                             kerf_mm=float(kerf_mm), tool_mm=float(tool_mm))
            dxf_b64 = ""
            try:
                with open(out_dxf, "rb") as f:
                    dxf_b64 = base64.b64encode(f.read()).decode()
            except Exception:
                pass
            return {
                "svg": bz["svg_px"], "svg_mm": bz["svg_mm"], "svg_fit": bz.get("svg_fit"), "dxf_base64": dxf_b64,
                "width": 0, "height": 0, "width_mm": bz["width_mm"], "height_mm": bz["height_mm"],
                "letter_height_mm": bz.get("letter_height_mm"), "size_by": bz.get("size_by"),
                "layers": bz["layers"], "rings": bz["rings"], "layer_info": [{"color": "#2563EB"}],
                "detected": {"kind": "logo", "notes": bz["engine"] + " — เส้นตรงตรง โค้งเนียน มุมคม"},
                "used_mode": "cutout", "engine": bz["engine"],
            }
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=400)
    try:
        from vectorcnc import pipeline   # lazy: โหลด opencv เฉพาะตอนใช้งานจริง
        rep = pipeline.process_cnc(
            inp, out_svg, out_dxf,
            n_colors=max(2, min(12, int(n_colors))),
            real_width_mm=float(real_width_mm), kerf_mm=float(kerf_mm),
            tool_mm=float(tool_mm), tabs=int(tabs),
            mode=(str(mode).lower() if str(mode).lower() in ("lineart", "cutout", "auto") else "auto"),
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    W, H = rep["size_px"]
    Wmm, Hmm = rep["size_mm"]
    dxf_b64 = ""
    try:
        with open(out_dxf, "rb") as f:
            dxf_b64 = base64.b64encode(f.read()).decode()
    except Exception:
        pass
    return {
        "svg": rep["svg_px"],       # แสดงผล (สเกลตาม pane)
        "svg_mm": rep["svg_mm"],    # ดาวน์โหลด SVG (มม.จริง เข้า Fusion ได้)
        "dxf_base64": dxf_b64,      # ดาวน์โหลด DXF
        "width": W, "height": H,
        "width_mm": Wmm, "height_mm": Hmm,
        "layers": rep["n_layers"],
        "rings": rep["n_rings"],
        "layer_info": [{"color": c} for c in rep["layer_colors"]],
        "detected": rep.get("detected"),
        "used_mode": rep.get("mode"),
        "engine": rep.get("engine"),
    }


DESIGN_SYS = (
    "คุณเป็นดีไซเนอร์ป้าย/โลโก้สำหรับงานตัด CNC/เลเซอร์. "
    "สร้างงานเป็น SVG ที่ตัดได้จริง: พื้นหลังขาว, รูปทรง/ตัวอักษรทึบสีเข้มคอนทราสต์สูง, "
    "เส้นหนาชัด ไม่บางเกินไป, ใช้ <text> ตัวหนา หรือรูปทรงเรขาคณิตเรียบง่าย, มี viewBox เสมอ. "
    "ห้ามใช้ gradient/รูปภาพภายนอก/ฟิลเตอร์. ห้ามใช้เครื่องหมาย & ในข้อความ (เขียน and แทน) "
    "และต้องเป็น XML ที่ถูกต้อง. ตอบกลับเป็นโค้ด SVG อย่างเดียว ห้ามมีคำอธิบายอื่น."
)


def _extract_svg(text):
    m = re.search(r"<svg[\s\S]*?</svg>", text or "", re.IGNORECASE)
    return m.group(0) if m else ""


@app.post("/api/design")
async def design(brief: str = Form(...), style: str = Form(""), width_mm: float = Form(600.0)):
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
    if not key:
        return JSONResponse(
            {"error": "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน Render → Environment"},
            status_code=400)
    model = os.environ.get("DESIGN_MODEL", "claude-sonnet-4-6")
    prompt = (
        "ออกแบบงานป้าย/โลโก้ตามบรีฟนี้: \"%s\". สไตล์: %s. "
        "งานกว้างจริงราว %.0f มม. จัดองค์ประกอบให้พอดีกรอบ. "
        "ส่งกลับเป็น SVG โค้ดอย่างเดียว." % (brief, style or "เรียบ โมเดิร์น", width_mm)
    )
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=key)
        msg = client.messages.create(
            model=model, max_tokens=4000, system=DESIGN_SYS,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") for b in msg.content
                       if getattr(b, "type", "") == "text")
        svg = _extract_svg(text)
        if not svg:
            return JSONResponse({"error": "โมเดลไม่ได้คืน SVG"}, status_code=400)
        return {"svg": svg, "model": model}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/nest")
async def nest_ep(
    file: UploadFile = File(...),
    qty: int = Form(10),
    real_width_mm: float = Form(300.0),
    real_height_mm: float = Form(0.0),
    sheet_w: float = Form(1220.0),
    sheet_h: float = Form(2440.0),
    margin: float = Form(10.0),
    gap: float = Form(5.0),
    n_colors: int = Form(6),
    parts_mode: str = Form("parts"),
):
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        import cv2
        from shapely.ops import unary_union
        from shapely.geometry import Polygon
        from shapely.affinity import scale as _scale, translate as _tr
        from vectorcnc import trace_engine, nesting, vector_import

        is_vec = vector_import.is_vector_file(inp)
        bez_pieces = None
        if is_vec:
            # ไฟล์เวกเตอร์ (.ai/.pdf/.svg) -> แยกทุกชิ้น เก็บ "เส้นโค้ง Bézier จริง" (ตัดคมระดับ Illustrator)
            bez_pieces = vector_import.full_pieces_mm(inp, real_width_mm)
            bez_pieces = [pc for pc in bez_pieces if pc["poly"].area > 4.0]
            if not bez_pieces:
                return JSONResponse({"error": "อ่านเวกเตอร์ไม่ได้ / ไม่พบรูปทรงสำหรับจัดวาง"}, status_code=400)
            full_mm = unary_union([pc["poly"] for pc in bez_pieces])
        else:
            # ภาพ raster -> ใช้เครื่องยนต์ vtracer (เส้นโค้ง Bézier + snap เส้นตรง) ให้ Nesting เนียนกริบ
            try:
                bez_pieces = trace_engine.bezier_pieces_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
                bez_pieces = [pc for pc in (bez_pieces or []) if pc["poly"].area > 4.0]
            except Exception:
                bez_pieces = None
            if bez_pieces:
                full_mm = unary_union([pc["poly"] for pc in bez_pieces])
            else:
                bez_pieces = None
                polys = trace_engine.nest_shapes_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
                if not polys:
                    return JSONResponse({"error": "แปลงภาพไม่พบรูปทรงสำหรับจัดวาง"}, status_code=400)
                full_mm = unary_union(polys)
        bb = full_mm.bounds
        pw, ph = round(bb[2] - bb[0], 1), round(bb[3] - bb[1], 1)

        # ----- ผู้ใช้กำหนด 'สูงชิ้น' เอง -> ยืด/หดแกน Y ให้สูงเป๊ะ (ล็อกสัดส่วน=ส่งค่าตามอัตราส่วน sy≈1) -----
        try:
            _rh = float(real_height_mm)
        except Exception:
            _rh = 0.0
        if _rh > 1.0 and ph > 0.5 and abs(_rh - ph) > 0.15:
            sy = _rh / (bb[3] - bb[1]); y0 = bb[1]

            def _sy(p):
                return (p[0], y0 + (p[1] - y0) * sy)

            def _scale_sub(sp):
                ns = {"start": _sy(sp["start"]), "segs": []}
                for s in sp["segs"]:
                    if s[0] == "L":
                        ns["segs"].append(("L", _sy(s[1])))
                    else:
                        ns["segs"].append(("C", _sy(s[1]), _sy(s[2]), _sy(s[3])))
                for _k in sp:
                    if _k not in ("start", "segs"):
                        ns[_k] = sp[_k]
                return ns

            if bez_pieces is not None:
                for pc in bez_pieces:
                    pc["poly"] = _scale(pc["poly"], xfact=1.0, yfact=sy, origin=(0, y0))
                    pc["subs"] = [_scale_sub(sp) for sp in pc.get("subs", [])]
            full_mm = _scale(full_mm, xfact=1.0, yfact=sy, origin=(0, y0))
            bb = full_mm.bounds
            pw, ph = round(bb[2] - bb[0], 1), round(bb[3] - bb[1], 1)

        res = max(2.0, min(sheet_w, sheet_h) / 500.0)
        whole = str(parts_mode).lower() == "whole"
        _split_dbg = None

        if bez_pieces is not None:
            # -------- เวกเตอร์/ราสเตอร์(vtracer): จัดวางเส้นโค้ง Bézier จริง (สมูท) แยกสี --------
            if whole:
                # ทั้งป้าย = ตัด 'เฉพาะกรอบนอกสุด' (เส้นรอบนอกของป้าย) เป็นแผ่นเดียว
                def _sub_area(sp):
                    xs = [sp['start'][0]]; ys = [sp['start'][1]]
                    for s in sp['segs']:
                        p = s[1] if s[0] == 'L' else s[3]
                        xs.append(p[0]); ys.append(p[1])
                    n = len(xs); a = 0.0
                    for i in range(n):
                        j = (i + 1) % n; a += xs[i]*ys[j] - xs[j]*ys[i]
                    return abs(a) / 2.0
                outer = None; outer_meta = None; best_a = -1.0
                for pc in bez_pieces:
                    for sp in pc.get("subs", []):
                        a = _sub_area(sp)
                        if a > best_a:
                            best_a = a; outer = sp
                            outer_meta = (pc.get("color", "#2563EB"), pc.get("rgb", (37, 99, 235)), pc.get("layer", "(default)"))
                if outer is None:
                    return JSONResponse({"error": "ไม่พบกรอบนอกของป้าย"}, status_code=400)
                hull = full_mm.convex_hull
                if hull.geom_type != "Polygon":
                    hull = full_mm.envelope
                groups = [([outer], outer_meta[0], outer_meta[1], outer_meta[2])]
                nest_pieces = [{"poly": hull, "groups": groups}]
                qn = max(1, min(80, int(qty)))
                r = nesting.nest([(hull, qn)], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res)
            else:
                # แยกชิ้นย่อย -> แตกเป็น 'ชิ้นแยกจริง' ด้วย raster even-odd + connected components (ทนทาน ไม่ล้ม)
                import numpy as _np

                def _subpts(sp):
                    pts = [sp['start']]; cur = sp['start']
                    for s in sp['segs']:
                        if s[0] == 'L':
                            pts.append(s[1]); cur = s[1]
                        else:
                            c1, c2, e = s[1], s[2], s[3]
                            L = abs(c1[0]-cur[0])+abs(c1[1]-cur[1])+abs(c2[0]-c1[0])+abs(c2[1]-c1[1])+abs(e[0]-c2[0])+abs(e[1]-c2[1])
                            nn = int(min(40, max(3, L / 0.6)))
                            for i in range(1, nn + 1):
                                t = i / float(nn); mt = 1 - t
                                pts.append((mt*mt*mt*cur[0]+3*mt*mt*t*c1[0]+3*mt*t*t*c2[0]+t*t*t*e[0],
                                            mt*mt*mt*cur[1]+3*mt*mt*t*c1[1]+3*mt*t*t*c2[1]+t*t*t*e[1]))
                            cur = e
                    return pts

                allsub = []
                for pc in bez_pieces:
                    col = pc.get("color", "#2563EB"); rgb = pc.get("rgb", (37, 99, 235)); lay = pc.get("layer", "CUT")
                    for sp in pc.get("subs", []):
                        allsub.append((sp, col, rgb, lay, _subpts(sp)))
                allx = [q[0] for _, _, _, _, ps in allsub for q in ps]
                ally = [q[1] for _, _, _, _, ps in allsub for q in ps]
                nest_pieces = []; _split_dbg = {"nlab": 0, "err": ""}
                try:
                    mnx, mny, mxx, mxy = min(allx), min(ally), max(allx), max(ally)
                    RES = max(0.4, min(mxx - mnx, mxy - mny) / 1000.0)
                    Wn = int((mxx - mnx) / RES) + 6; Hn = int((mxy - mny) / RES) + 6
                    def _tp(p): return [int((p[0] - mnx) / RES + 3), int((p[1] - mny) / RES + 3)]
                    ppx = [_np.array([_tp(q) for q in ps], _np.int32) for _, _, _, _, ps in allsub]
                    mask = _np.zeros((Hn, Wn), _np.uint8)
                    for pp in ppx:
                        cm = _np.zeros((Hn, Wn), _np.uint8); cv2.fillPoly(cm, [pp], 1); mask ^= cm   # even-odd
                    nlab, lab = cv2.connectedComponents(mask)
                    _split_dbg["nlab"] = int(nlab)
                    if nlab > 2:
                        ker = _np.ones((5, 5), _np.uint8)
                        gbl = {}                                     # label -> {layer: {subs,color,rgb}}
                        for (sp, col, rgb, lay, ps), pp in zip(allsub, ppx):
                            lm = _np.zeros((Hn, Wn), _np.uint8); cv2.polylines(lm, [pp], True, 1, 2); lm = cv2.dilate(lm, ker)
                            vals = lab[lm > 0]; vals = vals[vals > 0]
                            L = int(_np.bincount(vals).argmax()) if len(vals) else 0
                            if L == 0:
                                continue
                            g = gbl.setdefault(L, {}).setdefault(lay, {"subs": [], "color": col, "rgb": rgb})
                            g["subs"].append(sp)
                        for L in range(1, nlab):
                            if L not in gbl:
                                continue
                            _fc = cv2.findContours((lab == L).astype(_np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            cnts = _fc[0] if len(_fc) == 2 else _fc[1]   # รองรับ OpenCV 3.x/4.x
                            if not cnts:
                                continue
                            cc = max(cnts, key=cv2.contourArea)
                            if cv2.contourArea(cc) < 2:
                                continue
                            fp = Polygon([(mnx + (pt[0][0] - 3) * RES, mny + (pt[0][1] - 3) * RES) for pt in cc]).buffer(0)
                            if fp.is_empty or fp.geom_type != "Polygon":
                                continue
                            groups = [(g["subs"], g["color"], g["rgb"], ly) for ly, g in gbl[L].items()]
                            nest_pieces.append({"poly": fp, "groups": groups})
                except Exception as _e:
                    import traceback as _tb
                    nest_pieces = []; _split_dbg["err"] = str(_e) + " | " + _tb.format_exc()[-300:]
                _split_dbg["pieces"] = len(nest_pieces)
                if not nest_pieces:
                    # แยกไม่ได้ (ลายเชื่อมกันทั้งชิ้น) -> ตกลงเป็นทั้งป้าย 1 ชิ้น (ไม่ error)
                    grp = {}
                    for pc in bez_pieces:
                        gg = grp.setdefault(pc.get("layer", "(default)"), {"subs": [], "color": pc.get("color", "#2563EB"), "rgb": pc.get("rgb", (37, 99, 235))})
                        gg["subs"].extend(pc["subs"])
                    hull = full_mm.convex_hull
                    if hull.geom_type != "Polygon":
                        hull = full_mm.envelope
                    nest_pieces = [{"poly": hull, "groups": [(g["subs"], g["color"], g["rgb"], ly) for ly, g in grp.items()]}]
                qn = max(1, min(int(qty), max(1, 600 // len(nest_pieces))))  # ทำตาม qty จริง (เพดานรวม ~600)
                res_p = max(3.0, min(sheet_w, sheet_h) / 360.0)     # กริดถูกจำกัดซ้ำใน nest() (กัน 502/OOM)
                r = nesting.nest([(p["poly"], qn) for p in nest_pieces], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res_p, rotations=(0, 90))
            sheets_items = []; sheets_labels = []
            for sheet in r["placements"]:
                items = []; labs = []
                for pl in sheet:
                    try:
                        pc = nest_pieces[pl["part"]]
                        for subs, color, rgb, layer in pc["groups"]:
                            ts = nesting.place_subs(subs, pl)
                            items.append((ts, color, rgb, layer))   # (subs, color_hex, rgb, layer)
                        b = nesting.place_geom(pc["poly"], pl).bounds  # กรอบชิ้นจริงหลังวาง (x0,y0,x1,y1)
                        labs.append((b[0], b[1], b[2], b[3]))
                    except Exception:
                        continue                                    # ข้ามชิ้นมีปัญหา ไม่ล้มทั้งงาน
                sheets_items.append(items); sheets_labels.append(labs)
            svgs = [nesting.sheet_svg_bezier(it, float(sheet_w), float(sheet_h), labels=lb)
                    for it, lb in zip(sheets_items, sheets_labels)]
            dxf_path = os.path.join(tmp, "nest.dxf")
            # DXF แบบ BLOCK+INSERT (เล็ก+เร็ว) — ใช้ geometry ต้นฉบับต่อชิ้น + ตำแหน่งจาก nest
            piece_groups = [p["groups"] for p in nest_pieces]
            nesting.write_dxf_bezier_blocks(piece_groups, r["placements"], dxf_path,
                                            float(sheet_w), float(sheet_h))
            n_pieces = len(nest_pieces)
        else:
            # -------- ภาพ raster (JPG/PNG): เส้นจากการ trace (polyline) --------
            if whole:
                foot = full_mm.convex_hull
                if foot.geom_type != "Polygon":
                    foot = full_mm.envelope
                mnx, mny = foot.bounds[0], foot.bounds[1]
                foot = _tr(foot, xoff=-mnx, yoff=-mny)
                full = _tr(full_mm, xoff=-mnx, yoff=-mny).simplify(0.12, preserve_topology=True)
                qn = max(1, min(80, int(qty)))
                r = nesting.nest([(foot, qn)], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res)
                parts_ref = [full]
            else:
                pieces = list(full_mm.geoms) if full_mm.geom_type == "MultiPolygon" else [full_mm]
                pieces = [p for p in pieces if p.area > 4.0]
                if not pieces:
                    return JSONResponse({"error": "ไม่พบชิ้นย่อยสำหรับจัดวาง"}, status_code=400)
                pieces.sort(key=lambda p: -p.area)
                pieces = pieces[:40]                       # เพดานชิ้น กัน timeout/OOM บนคลาวด์ฟรี
                pieces = [p.simplify(0.12, preserve_topology=True) for p in pieces]   # ลดจุด (~0.12mm) -> DXF เล็ก, nest เร็ว
                qn = max(1, min(int(qty), max(1, 500 // len(pieces))))
                res_p = max(4.0, min(sheet_w, sheet_h) / 300.0)   # กริดหยาบขึ้น = เร็วขึ้น
                r = nesting.nest([(p, qn) for p in pieces], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res_p, rotations=(0, 90))
                parts_ref = pieces
            sheets_geoms = [[nesting.place_geom(parts_ref[pl["part"]], pl) for pl in sheet] for sheet in r["placements"]]
            def _labs(gs):
                lb = []
                for g in gs:
                    try:
                        b = g.bounds; lb.append((b[0], b[1], b[2], b[3]))
                    except Exception:
                        pass
                return lb
            svgs = [nesting.sheet_svg(gs, float(sheet_w), float(sheet_h), labels=_labs(gs)) for gs in sheets_geoms]
            dxf_path = os.path.join(tmp, "nest.dxf")
            nesting.write_dxf(sheets_geoms, dxf_path, float(sheet_w), float(sheet_h))
            n_pieces = len(parts_ref)

        with open(dxf_path, "rb") as f:
            dxf_b64 = base64.b64encode(f.read()).decode()
        return {
            "n_sheets": r["n_sheets"], "utilization": r["utilization"], "unplaced": r["unplaced"],
            "sheet_w": sheet_w, "sheet_h": sheet_h, "part_mm": [pw, ph], "qty": qn,
            "mode": str(parts_mode).lower(), "pieces": n_pieces,
            "sheets_svg": svgs, "dxf_base64": dxf_b64, "split_dbg": _split_dbg,
        }
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _ai_filled_svg(items, width_mm, clip_subs=None):
    """สร้าง SVG 'ระบายสีเต็ม' (artwork เวกเตอร์) จาก items=[(bgr, subs)] — หน่วย มม. ขนาดจริง
       แต่ละสี = compound path (fill-rule evenodd -> รูตรงกลางโปร่ง) เรียงพื้นที่ใหญ่ไว้หลัง
       clip_subs = เงารวมของงาน -> ตัดสี/เงาที่ล้นออกนอกเส้น outline ทิ้ง"""
    # bbox รวมทุก sub (px)
    mnx = mny = 1e18; mxx = mxy = -1e18
    def _pts(sp):
        yield sp['start']
        for s in sp['segs']:
            if s[0] == 'L':
                yield s[1]
            else:
                yield s[1]; yield s[2]; yield s[3]
    for _bgr, subs in items:
        for sp in subs:
            for (x, y) in _pts(sp):
                if x < mnx: mnx = x
                if y < mny: mny = y
                if x > mxx: mxx = x
                if y > mxy: mxy = y
    if mxx <= mnx or mxy <= mny:
        raise ValueError("ไม่พบรูปทรงเวกเตอร์จากภาพ")
    Wpx = mxx - mnx; Hpx = mxy - mny
    ppm = Wpx / float(width_mm) if width_mm else 1.0
    if ppm <= 0: ppm = 1.0
    Wmm = round(Wpx / ppm, 1); Hmm = round(Hpx / ppm, 1)

    def _tx(p):
        return ((p[0] - mnx) / ppm, (p[1] - mny) / ppm)

    def _d(sp):
        s0 = _tx(sp['start']); d = ['M %.3f %.3f' % s0]
        for s in sp['segs']:
            if s[0] == 'L':
                p = _tx(s[1]); d.append('L %.3f %.3f' % p)
            else:
                c1 = _tx(s[1]); c2 = _tx(s[2]); e = _tx(s[3])
                d.append('C %.3f %.3f %.3f %.3f %.3f %.3f' % (c1[0], c1[1], c2[0], c2[1], e[0], e[1]))
        d.append('Z'); return ' '.join(d)

    def _area(subs):
        a = 0.0
        for sp in subs:
            pts = [sp['start']] + [(s[1] if s[0] == 'L' else s[3]) for s in sp['segs']]
            n = len(pts); s = 0.0
            for i in range(n):
                j = (i + 1) % n; s += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
            a += abs(s) / 2.0
        return a

    order = sorted(range(len(items)), key=lambda i: -_area(items[i][1]))   # ใหญ่ก่อน (อยู่หลัง)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{Wmm:.1f}mm" height="{Hmm:.1f}mm" '
           f'viewBox="0 0 {Wmm:.1f} {Hmm:.1f}">']

    # 🎯 clipPath = เงารวมของงาน -> สีที่ล้นออกนอกขอบถูกตัดทิ้ง (เงาไม่หลุด outline)
    clip_attr = ""
    if clip_subs:
        cd = ' '.join(_d(sp) for sp in clip_subs if sp.get('segs'))
        if cd:
            out.append(f'<defs><clipPath id="art_clip"><path d="{cd}"/></clipPath></defs>')
            clip_attr = ' clip-path="url(#art_clip)"'

    total_subs = 0
    out.append(f'<g{clip_attr}>')
    for oi, i in enumerate(order):
        bgr, subs = items[i]
        col = bgr if isinstance(bgr, str) else hexcolor(bgr)
        dd = ' '.join(_d(sp) for sp in subs if sp.get('segs'))
        if not dd:
            continue
        total_subs += len(subs)
        out.append(f'<g id="สี{oi+1}_{col}"><path fill="{col}" fill-rule="evenodd" stroke="none" d="{dd}"/></g>')
    out.append('</g></svg>')
    return '\n'.join(out), Wmm, Hmm, total_subs


@app.post("/api/draft-ai")
async def draft_ai(file: UploadFile = File(...), n_colors: int = Form(4),
                   width_mm: float = Form(600.0), engine: str = Form("auto"),
                   white_base: int = Form(0), cut_contour: int = Form(1),
                   cut_mode: str = Form("diecut")):
    """ดราฟท์ภาพ (ถ่าย/AI/โหลดเน็ต) -> ไฟล์เวกเตอร์ .ai (PDF-based) ให้กราฟิคเปิดใน Illustrator ทำต่อ
       - เวกเตอร์คมชัดระดับโลโก้ · แยกสีเป็น path คนละชั้น · ขนาดจริงตามงาน"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import trace_engine, vector_import
        eng = str(engine or "auto").lower()
        nc = max(2, min(8, int(n_colors)))
        used = eng

        # ═══ 🖨️ โหมดงานพิมพ์: ฝังภาพต้นฉบับ + เส้นไดคัท -> คุณภาพเท่าต้นฉบับ 100% ═══
        #     (ภาพมี gradient/ไล่สี ที่ vectorize แล้วเพี้ยน — งานพิมพ์ไม่ต้อง vectorize)
        if eng == "print":
            if vector_import.is_vector_file(inp):
                return JSONResponse({"error": "ไฟล์นี้เป็นเวกเตอร์อยู่แล้ว ใช้โหมดปกติได้เลย"},
                                    status_code=400)
            from vectorcnc import print_ai as PA
            _cm = str(cut_mode or "diecut").lower()
            pdf_bytes, info = PA.build(
                inp, width_mm=float(width_mm),
                bleed_mm=(3.0 if _cm == "contour" else 2.0),
                cut=bool(int(cut_contour)),
                corner_r_mm=(0.0 if _cm == "contour" else 1.0),
                upscale_to=2000,          # ภาพเล็ก -> ขยายก่อนฝัง กันพิมพ์ใหญ่แตก
                white_base=bool(int(white_base)), white_choke_mm=0.3,
                cut_mode=_cm)
            return {"ai_base64": base64.b64encode(pdf_bytes).decode(),
                    "w_mm": info["w_mm"], "h_mm": info["h_mm"],
                    "layers": len(info.get("layers", [])),
                    "paths": info["cut_paths"],
                    "cut_dxf_base64": info.get("cut_dxf_b64", ""),   # ↴ เข้าเลเซอร์ตัด
                    "cut_svg": info.get("cut_svg", ""),
                    "used_engine": "print", "print_info": info,
                    "svg_preview": ""}
        # ---- ไฟล์เวกเตอร์ (.ai/.pdf/.svg/.eps) : ใช้ path จริงเลย ไม่ต้อง trace ----
        if vector_import.is_vector_file(inp):
            pcs = vector_import.full_pieces_mm(inp, float(width_mm))
            grp = {}
            order_c = []
            for pc in pcs:
                c = pc.get("color", "#333333")
                if c not in grp:
                    grp[c] = []; order_c.append(c)
                grp[c].extend(pc.get("subs", []))
            items = [(c, grp[c]) for c in order_c if grp[c]]
            if not items:
                return JSONResponse({"error": "อ่านเวกเตอร์ไม่ได้ / ไม่พบรูปทรง"}, status_code=400)
            svg, Wmm, Hmm, npaths = _ai_filled_svg(items, float(width_mm))
            import cairosvg
            pdf_bytes = cairosvg.svg2pdf(bytestring=svg.encode("utf-8"))
            return {"ai_base64": base64.b64encode(pdf_bytes).decode(), "w_mm": Wmm, "h_mm": Hmm,
                    "layers": len(items), "paths": npaths, "used_engine": "vector",
                    "svg_preview": svg if len(svg) < 400000 else ""}
        if eng == "auto":
            # เลือกอัตโนมัติ: ลายเส้น/ขาวดำ -> potrace คมกริบ (ไม่มีเงาเทา) · สีเรียบหลายสี -> color engine
            try:
                from vectorcnc import analyze
                dec = analyze.analyze(inp)
                if dec.get("kind") == "lineart" or float(dec.get("colorful", 0)) < 25 or int(dec.get("ndom", 2)) <= 2:
                    used = "mono"
                else:
                    used = "color"
                    nc = max(2, min(8, int(dec.get("n_colors", nc)) if int(dec.get("n_colors", nc)) >= 2 else nc))
            except Exception:
                used = "color"
        items = None; clip_subs = None
        if used == "mono":
            items = trace_engine.trace_potrace(inp, n_colors=2)
        else:
            # 🎨 สีสด+เนียน: VTracer color+spline (cp=8 สีตรงต้นฉบับ) + clip เง��ไม่ให้หลุด outline
            try:
                items, clip_subs = trace_engine.trace_color_vtracer(
                    inp, color_precision=8, layer_difference=16, filter_speckle=6,
                    clip_to_silhouette=True)
            except Exception:
                items = None
            if not items:
                try:
                    items = trace_engine.trace_color_smooth_bezier(inp, n_colors=nc)
                except Exception:
                    items = None
            if not items:
                items = trace_engine.trace_potrace(inp, n_colors=2); used = "mono"
        if not items:
            return JSONResponse({"error": "แปลงภาพเป็นเวกเตอร์ไม่สำเร็จ"}, status_code=400)
        svg, Wmm, Hmm, npaths = _ai_filled_svg(items, float(width_mm), clip_subs=clip_subs)
        import cairosvg
        pdf_bytes = cairosvg.svg2pdf(bytestring=svg.encode("utf-8"))
        ai_b64 = base64.b64encode(pdf_bytes).decode()
        return {"ai_base64": ai_b64, "w_mm": Wmm, "h_mm": Hmm,
                "layers": len(items), "paths": npaths, "used_engine": used,
                "svg_preview": svg if len(svg) < 400000 else ""}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _extrude_stl(poly, thickness_mm):
    """extrude รูปเงา (polygon + รูใน) เป็น solid mesh watertight -> STL binary (สำหรับ Fusion 360 / เครื่องพิมพ์ 3D)"""
    import numpy as np
    import mapbox_earcut as earcut
    import struct
    from shapely.geometry.polygon import orient
    t = float(thickness_mm)
    polys = list(poly.geoms) if poly.geom_type == "MultiPolygon" else [poly]
    tris = []
    for pg in polys:
        pg = pg.simplify(0.25, preserve_topology=True)   # ลดจุด -> STL เล็กลง (คงรูป ~0.25mm)
        if pg.is_empty or pg.geom_type != "Polygon":
            continue
        pg = orient(pg, 1.0)   # ขอบนอก CCW / รูใน CW -> normals หันออกนอกสม่ำเสมอ (กัน mesh กลับด้าน/มองไม่เห็น)
        ext = np.array(pg.exterior.coords)[:-1]
        if len(ext) < 3:
            continue
        holes = [np.array(h.coords)[:-1] for h in pg.interiors if len(h.coords) > 3]
        V = ext.copy(); ends = [len(ext)]
        for h in holes:
            V = np.vstack([V, h]); ends.append(len(V))
        try:
            idx = earcut.triangulate_float64(V.reshape(-1, 2).astype(np.float64),
                                             np.array(ends, dtype=np.uint32)).reshape(-1, 3)
        except Exception:
            continue
        for a, b, c in idx:
            A, B, C = V[a], V[b], V[c]
            tris.append(((A[0], A[1], 0.0), (C[0], C[1], 0.0), (B[0], B[1], 0.0)))       # ล่าง (normal ลง)
            tris.append(((A[0], A[1], t), (B[0], B[1], t), (C[0], C[1], t)))             # บน (normal ขึ้น)
        for ring in [ext] + holes:                                                       # ผนังข้าง
            n = len(ring)
            for i in range(n):
                p0 = ring[i]; p1 = ring[(i + 1) % n]
                b0 = (p0[0], p0[1], 0.0); b1 = (p1[0], p1[1], 0.0)
                u0 = (p0[0], p0[1], t); u1 = (p1[0], p1[1], t)
                tris.append((b0, b1, u1)); tris.append((b0, u1, u0))

    def _nrm(a, b, c):
        ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
        vx, vy, vz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
        nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
        L = (nx*nx+ny*ny+nz*nz) ** 0.5 or 1.0
        return nx/L, ny/L, nz/L
    buf = bytearray(b"VectorCNC 3D export".ljust(80, b"\0")) + struct.pack("<I", len(tris))
    for a, b, c in tris:
        nx, ny, nz = _nrm(a, b, c)
        buf += struct.pack("<12fH", nx, ny, nz, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], 0)
    return bytes(buf), len(tris)


@app.post("/api/export-3d")
async def export_3d(file: UploadFile = File(...), width_mm: float = Form(600.0),
                    height_mm: float = Form(0.0), thickness_mm: float = Form(30.0),
                    n_colors: int = Form(6)):
    """แปลงไฟล์งาน (ภาพ/เวกเตอร์) -> โมเดล 3 มิติ STL (extrude ตามความหนา) ส่งเข้า Fusion 360 / เครื่องพิมพ์ 3D"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        full = _letter_full_mm(inp, float(width_mm), float(height_mm), int(n_colors))
        if full.is_empty:
            return JSONResponse({"error": "ไม่พบรูปทรงสำหรับสร้าง 3 มิติ"}, status_code=400)
        stl, nfac = _extrude_stl(full, max(0.5, float(thickness_mm)))
        b = full.bounds
        return {"stl_base64": base64.b64encode(stl).decode(),
                "w_mm": round(b[2]-b[0], 1), "h_mm": round(b[3]-b[1], 1),
                "thickness_mm": round(float(thickness_mm), 1), "facets": nfac}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _extrude_layers_3d(full, rec, trimw_mm=10.0, trim_out=True, depth_mm=50.0, fmt="stl"):
    """สร้างโมเดล 3 มิติ 'หลายชั้นจริง' ตามโครงป้าย (แผ่นหลัง + ผนังยกขอบ + อะคริลิคหน้า + คิ้ว)
       -> ไฟล์ STL / OBJ / 3MF / GLB (import เข้า Fusion 360 / Rhino / Blender / เครื่องพิมพ์ 3D ได้ทันที)
       คืน (bytes, จำนวนชิ้น)"""
    import trimesh
    scene = trimesh.Scene()
    T_BASE, T_ACR, T_KIM, T_WALL = 3.0, 5.0, 10.0, 3.0

    def _polys(g):
        if g is None or getattr(g, "is_empty", True):
            return []
        return list(g.geoms) if g.geom_type == "MultiPolygon" else ([g] if g.geom_type == "Polygon" else [])

    def _add(g, h, z, name):
        for pg in _polys(g):
            try:
                pg2 = pg.simplify(0.3, preserve_topology=True)
                if pg2.is_empty or pg2.geom_type != "Polygon":
                    continue
                m = trimesh.creation.extrude_polygon(pg2, height=max(0.6, float(h)))
                m.apply_translation([0.0, 0.0, float(z)])
                scene.add_geometry(m, node_name=name)
            except Exception:
                pass
    depth_mm = max(6.0, float(depth_mm))
    _add(full, T_BASE, 0.0, "back_plate")                               # แผ่นหลัง (ฐานยึด)
    try:
        _add(full.difference(full.buffer(-T_WALL)), depth_mm, T_BASE, "return_wall")   # ผนังยกขอบรอบตัว
    except Exception:
        pass
    topz = T_BASE + depth_mm
    for L in rec.get("layers", []):
        kind = L.get("kind", "solid"); off = float(L["off"])
        base = _mbuf(full, off)
        if base is None or base.is_empty:
            continue
        if kind == "frame":                                             # คิ้ว = กรอบบนสุด
            band = trimw_mm if trimw_mm > 0 else float(L.get("band", 10.0))
            if trim_out:
                o2 = _mbuf(full, off + band); g = o2.difference(base) if base is not None else o2
            else:
                i2 = _mbuf(full, off - band); g = base.difference(i2) if (i2 is not None and not i2.is_empty) else base
            _add(g, T_KIM, topz, "kim_trim")
        elif kind == "base":
            continue                                                    # เป็นแผ่นหลังแล้ว
        else:                                                           # อะคริลิคหน้า (ใต้คิ้ว)
            _add(base, T_ACR, topz - T_ACR, "acrylic_face")
    if not scene.geometry:
        raise ValueError("no geometry to extrude")
    data = scene.export(file_type=fmt)
    if isinstance(data, str):
        data = data.encode("utf-8")
    return bytes(data), len(scene.geometry)


@app.post("/api/export-3d-layered")
async def export_3d_layered(file: UploadFile = File(...), sign_type: str = Form("1"),
                            real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                            return_depth_cm: float = Form(5.0), trim_width_cm: float = Form(1.0),
                            trim_dir: str = Form("out"), n_colors: int = Form(6), fmt: str = Form("stl")):
    """แปลงงานเวกเตอร์ -> โมเดล 3 มิติ 'หลายชั้น' (STL/OBJ/3MF) พร้อมใช้ใน Fusion 360 / โปรแกรม 3D ทุกตัว"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        rec = SIGN_TYPES.get(str(sign_type))
        if not rec:
            return JSONResponse({"error": "ไม่รู้จักแบบป้ายนี้"}, status_code=400)
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        if full.is_empty:
            return JSONResponse({"error": "ไม่พบรูปทรงสำหรับสร้าง 3 มิติ"}, status_code=400)
        depth_mm = (float(return_depth_cm) * 10.0) if float(return_depth_cm) > 0 else float(rec.get("depth_cm", 5.0)) * 10.0
        trim_out = (str(trim_dir) != "in")
        want = ["stl", "obj", "3mf"] if str(fmt) == "all" else [str(fmt)]
        out = {}; nb = 0
        for f_ in want:
            data, nb = _extrude_layers_3d(full, rec, trimw_mm=float(trim_width_cm) * 10.0,
                                          trim_out=trim_out, depth_mm=depth_mm, fmt=f_)
            out[f_.replace("3mf", "tmf") + "_base64"] = base64.b64encode(data).decode()
        b = full.bounds
        return {"bodies": nb, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                "depth_mm": round(depth_mm, 1), **out}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)
    finally:
        try:
            import shutil as _sh; _sh.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


# ==================== ชุดชั้นตัดตามแบบป้าย 1-7 (auto multi-layer offset) ====================
# off = ค่าเผื่อ 'มม.' จากไซซ์เต็ม (บวก=ขยายออก, ลบ=หดเข้า) · walls = ความสูงผนัง(ซม.) ไว้บอกช่าง(ดัดขอบ)
# kind: "solid"=ตัดเต็มแผ่น · "frame"=กรอบเจาะโบ๋ (band=ความกว้างคิ้ว มม.) · depth_cm=ความลึกตัว(สำหรับภาพ 3 มิติ)
SIGN_TYPES = {
    # 🟦 แผ่นแบนชิ้นเดียว ตัดตามทรง — ไม่ยกขอบ/ไม่มีคิ้ว/ไม่มีไฟ (งานพื้นฐาน ถูกสุด)
    #    ชั้นตัด = 1 ชั้น (หน้าแผ่น) · depth = ความหนาแผ่น (สำหรับภาพ 3 มิติเท่านั้น) · ไม่มี walls
    "20": {"name": "ตัวอักษร/โลโก้ แบน (ไม่ยกขอบ)", "depth_cm": 0.5, "flat": True, "allow_text": True,
           "layers": [{"name": "หน้าแผ่นแบน", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)}],
           "walls": []},
    # 🅰️ ตัวอักษรยกขอบไฟออกหน้า — 'ตัดแยกทีละตัว' (per_letter) เหมือนงานจริง ไม่เชื่อมเป็นก้อนเดียว
    "1": {"name": "ตัวอักษรยกขอบไฟออกหน้า (มีคิ้ว)", "depth_cm": 5.0, "per_letter": True, "allow_text": True,
          "layers": [{"name": "คิ้วหน้า", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "อะคริลิคตู้ไฟ", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}, {"name": "ยกขอบใน", "h": 2.0}]},
    "2": {"name": "ตัวอักษรยกขอบไฟออกหน้า (ไม่มีคิ้ว)", "depth_cm": 5.0, "per_letter": True, "allow_text": True,
          "layers": [{"name": "หน้าอะคริลิค", "off": 1.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "ไส้อะคริลิคใส", "off": -1.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 0.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "3": {"name": "ตัวอักษรไฟออกรอบ", "depth_cm": 7.0, "edge_lit": True, "glow_color": "#eaf2ff",
          "layers": [{"name": "หน้าอะคริลิค", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบใน", "h": 2.0}, {"name": "ยกขอบอะคริลิค", "h": 7.0}]},
    # 🔦 กล่องไฟฉลุหน้า (สี่เหลี่ยม/วงกลม) — หน้ากล่องเป็นโลหะเต็มแผ่น "ฉลุโบ๋ทะลุเฉพาะรูป logo"
    #    รองหลังด้วยอะคริลิคขาวนม 3mm (ตัดเป็นสี่เหลี่ยมตามพื้นที่ logo — ไม่ต้องตัดตามรูป) · ไฟด้านใน แสงลอดเฉพาะ logo
    "4": {"name": "กล่องไฟสี่เหลี่ยม ฉลุหน้า", "depth_cm": 5.0, "box_shape": "rect", "box_pad_cm": 4.0, "punch_face": True,
          "layers": [{"name": "หน้าโลหะฉลุ logo", "off": 0.0, "kind": "punch", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "อะคริลิคขาวนม 3mm (รองหลัง)", "off": 0.0, "kind": "backing", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 0.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "21": {"name": "กล่องไฟวงกลม ฉลุหน้า", "depth_cm": 5.0, "box_shape": "circle", "box_pad_cm": 4.0, "punch_face": True,
           "layers": [{"name": "หน้าโลหะฉลุ logo", "off": 0.0, "kind": "punch", "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "อะคริลิคขาวนม 3mm (รองหลัง)", "off": 0.0, "kind": "backing", "color": "#dc2626", "rgb": (220, 38, 38)},
                      {"name": "แผ่นพื้น", "off": 0.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "6": {"name": "งานยกขอบ", "depth_cm": 2.5,
          "layers": [{"name": "ซิ้งค์", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)}],
          "walls": [{"name": "ยกขอบ", "h": 2.5}, {"name": "ขากลางยกลอย", "h": 2.5}]},
    "7": {"name": "งานยกขอบ มีไส้", "depth_cm": 2.5,
          "layers": [{"name": "หน้าซิ้งค์", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "ไส้พลาสวูด", "off": -1.6, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)}],
          "walls": [{"name": "ยกขอบ", "h": 2.5}]},
    # 🆕 กล่องไฟล้อมตามทรง — ขอบนอกวิ่งตาม "เงารวม" ของทั้งแบบ (ไม่ใช่สี่เหลี่ยม/วงกลม)
    #    wrap=True -> เชื่อมตัวอักษร/องค์ประกอบเป็นก้อนเดียวก่อน แล้วล้อมด้วยคิ้ว + ยกขอบ
    # หน้า = อะคริลิคขาวขุ่น P433 (โปร่งแสง) ตัดเป็น "แผ่นเต็มตามทรง" ชิ้นเดียว
    #        แล้ว "จบด้วยงานพิมพ์ UV / ติดสติกเกอร์" เท่านั้น — ไม่ตัดเส้นตัวอักษรข้างใน
    "8": {"name": "กล่องไฟล้อมตามทรง 1 หน้า", "depth_cm": 5.0, "wrap": True, "wrap_bridge_cm": 4.5,
          "face_finish": "print", "face_material": "acrylic_P433",
          "layers": [{"name": "คิ้วล้อมทรง", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                     {"name": "แผ่นพื้นตามทรง", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบตามทรง", "h": 5.0}]},
    "9": {"name": "กล่องไฟล้อมตามทรง 2 หน้า", "depth_cm": 10.0, "wrap": True, "wrap_bridge_cm": 4.5,
          "face_finish": "print", "face_material": "acrylic_P433",
          "layers": [{"name": "คิ้วล้อมทรง", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
          "walls": [{"name": "ยกขอบตามทรง", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    # 🆕 กล่องไฟทรงเรขาคณิต — หน้าเป็นรูปทรง กลม/สี่เหลี่ยม/วงรี (ไม่ล้อมทรงงาน) หน้าจบด้วยงานพิมพ์ UV
    #    box_shape: circle | rect | oval · box_pad_cm = ระยะเผื่อรอบงานถึงขอบกล่อง
    "10": {"name": "กล่องไฟทรงกลม 1 หน้า", "depth_cm": 5.0, "box_shape": "circle", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วทรงกลม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "11": {"name": "กล่องไฟทรงกลม 2 หน้า", "depth_cm": 10.0, "box_shape": "circle", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วทรงกลม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
           "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    "12": {"name": "กล่องไฟสี่เหลี่ยม 1 หน้า", "depth_cm": 5.0, "box_shape": "rect", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วสี่เหลี่ยม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "13": {"name": "กล่องไฟสี่เหลี่ยม 2 หน้า", "depth_cm": 10.0, "box_shape": "rect", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วสี่เหลี่ยม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
           "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    "14": {"name": "กล่องไฟวงรี 1 หน้า", "depth_cm": 5.0, "box_shape": "oval", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้ววงรี", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "15": {"name": "กล่องไฟวงรี 2 หน้า", "depth_cm": 10.0, "box_shape": "oval", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้ววงรี", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -2.5, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
           "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    # 🆕 อักษรยกขอบไฟออกหน้า + โครงแขวน — ตัวอักษรแยกชิ้น ยึดกับโครงแขวน (โชว์ภาพด้านหลังมีโครง)
    "16": {"name": "อักษรยกขอบไฟออกหน้า + โครงแขวน", "depth_cm": 5.0, "mount_frame": True,
           "layers": [{"name": "คิ้วหน้า", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิค", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}, {"name": "ยกขอบใน", "h": 2.0}]},
    # 🆕 นีออนเฟล็กซ์ — เส้นไฟตามทรงงาน + แผ่นอะคริลิคใสรองหลัง 8mm ล้อมทรง (+3cm รอบตัว)
    "17": {"name": "นีออนเฟล็กซ์", "depth_cm": 1.5, "neon": True, "neon_margin_cm": 5.0, "acrylic_mm": 8.0,
           "layers": [{"name": "นีออนเฟล็กซ์ (เส้นไฟ)", "off": 0.0, "kind": "neon", "color": "#00e5ff", "rgb": (0, 229, 255)},
                      {"name": "อะคริลิคใสรองหลัง 8mm", "off": 30.0, "kind": "solid", "color": "#93c5fd", "rgb": (147, 197, 253)}],
           "walls": []},
    # 🆕 กล่องไฟอะคริลิค ไฟออกรอบ — กล่องสี่เหลี่ยม หน้าอะคริลิคขาวพิมพ์ (โลโก้+ข้อความ) ขอบเรืองแสงรอบ
    #     แขวนเพดาน/ติดผนัง (เลือก arm) · กว้าง(real_width) + ลึก(return_depth) ปรับได้ · พิมพ์ Text ลงกล่องได้
    "18": {"name": "กล่องไฟอะคริลิค ไฟออกรอบ", "depth_cm": 10.0, "box_shape": "rect", "box_pad_cm": 4.0,
           "face_finish": "print", "face_material": "acrylic_P433", "edge_lit": True, "glow_color": "#fff3c4",
           "allow_text": True, "no_trim": True,        # ไม่มีคิ้ว — อะคริลิคทั้งใบ ไฟออกทุกด้าน
           "layers": [{"name": "หน้าอะคริลิคขาวพิมพ์ (เต็มหน้า)", "off": 0.0, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ (ลึกกล่อง)", "h": 10.0}]},
    # 🆕 ตัวอักษรยกขอบไฟออกหลัง (halo / backlit) — อักษรทึบยกขอบ ยึดลอยจากผนัง · LED ส่องออกหลัง เรืองบนผนังรอบตัวอักษร
    "19": {"name": "ตัวอักษรยกขอบไฟออกหลัง", "depth_cm": 5.0, "back_lit": True, "glow_color": "#eaf2ff", "standoff_cm": 2.5,
           "layers": [{"name": "หน้าอักษร (ทึบ)", "off": 0.0, "kind": "solid", "color": "#334155", "rgb": (51, 65, 85)},
                      {"name": "แผ่นหลัง/ฐานยึด (LED ส่องหลัง)", "off": 0.5, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ (returns)", "h": 5.0}]},
    # 🆕 งานไดคัทตามทรง ไม่มีไฟ (CNC/เลเซอร์ ตัดตามรูปตัวอักษร-โลโก้)
    "22": {"name": "พลาสวูดไดคัท อักษร/โลโก้ ไม่มีไฟ 1 layer", "depth_cm": 1.0, "flat": True, "no_light": True, "allow_text": True,
           "layers": [{"name": "พลาสวูด 10mm ไดคัทตามทรง", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)}],
           "walls": []},
    "23": {"name": "พลาสวูดไดคัท อักษร/โลโก้ ไม่มีไฟ 2 layer", "depth_cm": 2.0, "flat": True, "no_light": True, "allow_text": True,
           "layers": [{"name": "ชั้นบน พลาสวูด 10mm (อักษร/โลโก้)", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "ชั้นรอง พลาสวูด 10mm (ฐานเผื่อขอบ 1.5cm)", "off": 15.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": []},
    "24": {"name": "อะคริลิคไดคัท อักษร/โลโก้ ไม่มีไฟ 1 layer", "depth_cm": 0.5, "flat": True, "no_light": True, "allow_text": True,
           "layers": [{"name": "อะคริลิค 5mm ไดคัทตามทรง", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)}],
           "walls": []},
    "25": {"name": "อะคริลิคไดคัท อักษร/โลโก้ ไม่มีไฟ 2 layer", "depth_cm": 1.0, "flat": True, "no_light": True, "allow_text": True,
           "layers": [{"name": "ชั้นบน อะคริลิค 5mm (อักษร/โลโก้)", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "ชั้นรอง อะคริลิค 5mm (ฐานเผื่อขอบ 1.5cm)", "off": 15.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": []},
    # 🧍 สแตนดี้ (Standee) — แผ่นตั้งพื้น พิมพ์หน้า + ขาตั้งพับหลัง · ไม่มีไฟ
    "26": {"name": "สแตนดี้ สี่เหลี่ยม", "depth_cm": 1.0, "flat": True, "no_light": True, "standee": True,
           "box_shape": "rect", "box_pad_cm": 0.0, "allow_text": True,
           "face_finish": "print", "face_material": "พลาสวูด 5mm / ฟิวเจอร์บอร์ด 5mm (พิมพ์หน้า)",
           "layers": [{"name": "แผ่นสแตนดี้ (พิมพ์หน้า) ไดคัทสี่เหลี่ยม", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "ขาตั้งหลัง (พับ) + ลิ้นล็อก", "off": 0.0, "kind": "standee_leg", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": []},
    "27": {"name": "สแตนดี้ ล้อมตามทรง", "depth_cm": 1.0, "flat": True, "no_light": True, "standee": True,
           "standee_pad_cm": 1.5, "allow_text": True,
           "face_finish": "print", "face_material": "พลาสวูด 5mm / ฟิวเจอร์บอร์ด 5mm (พิมพ์หน้า)",
           "layers": [{"name": "แผ่นสแตนดี้ (พิมพ์หน้า) ไดคัทตามทรง", "off": 15.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "ขาตั้งหลัง (พับ) + ลิ้นล็อก", "off": 0.0, "kind": "standee_leg", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": []},
}


def _geom_box(full, shape="rect", pad_mm=30.0):
    """สร้าง 'กล่องไฟทรงเรขาคณิต' ครอบงาน — กลม/สี่เหลี่ยม/วงรี (แทนเงารวมของตัวงาน)"""
    import math as _m
    from shapely.geometry import box as _sbox, Point as _Pt
    from shapely import affinity as _aff
    b = full.bounds
    cx = (b[0] + b[2]) / 2.0; cy = (b[1] + b[3]) / 2.0
    w = b[2] - b[0]; h = b[3] - b[1]
    if shape == "circle":
        r = _m.hypot(w, h) / 2.0 + pad_mm
        return _Pt(cx, cy).buffer(r, resolution=96)
    if shape == "oval":
        a = w / 2.0 + pad_mm; bb = h / 2.0 + pad_mm
        unit = _Pt(0, 0).buffer(1.0, resolution=96)
        return _aff.translate(_aff.scale(unit, xfact=a, yfact=bb, origin=(0, 0)), cx, cy)
    return _sbox(b[0] - pad_mm, b[1] - pad_mm, b[2] + pad_mm, b[3] + pad_mm)   # rect


def _geom_box_fit(full, shape, pad_mm, target_w_mm, target_h_mm=0.0):
    """สร้างกล่องทรงเรขาคณิต แล้วสเกลให้ 'กว้างกล่อง' = ค่าผู้ใช้ · ถ้าตั้ง 'สูงกล่อง' ด้วย -> สเกลแกนตั้งแยกอิสระ
       (เช่น กล่อง 145×50 ซม. โดยโลโก้คงสัดส่วนของมันเอง)"""
    g = _geom_box(full, shape, pad_mm)
    try:
        bb = g.bounds; cw = bb[2] - bb[0]
        if cw > 1.0 and float(target_w_mm) > 1.0 and abs(cw - float(target_w_mm)) > 1.0:
            from shapely import affinity as _aff
            s = float(target_w_mm) / cw
            g = _aff.scale(g, xfact=s, yfact=s, origin=(bb[0], bb[1]))
    except Exception:
        pass
    try:
        bb2 = g.bounds; ch = bb2[3] - bb2[1]
        if float(target_h_mm) > 1.0 and ch > 1.0 and abs(ch - float(target_h_mm)) > 1.0:
            from shapely import affinity as _aff2
            g = _aff2.scale(g, xfact=1.0, yfact=float(target_h_mm) / ch, origin=(bb2[0], bb2[1]))
    except Exception:
        pass
    return g


def _punch_fit_in_box(logo, box_g, pad_mm):
    """🔦 กล่องฉลุ: ย่อ/ขยาย + จัดกึ่งกลาง logo ให้อยู่ 'ในกล่องพอดี' เว้นขอบ pad_mm รอบด้าน
       (กล่องถูกสเกลตามความกว้างที่ผู้ใช้ตั้ง — logo ต้องสเกลตามด้วย ไม่งั้นล้นขอบ)"""
    try:
        from shapely import affinity as _aff
        bb = box_g.bounds; lb = logo.bounds
        aw = (bb[2] - bb[0]) - 2.0 * pad_mm; ah = (bb[3] - bb[1]) - 2.0 * pad_mm
        lw = lb[2] - lb[0]; lh = lb[3] - lb[1]
        if aw <= 1 or ah <= 1 or lw <= 0 or lh <= 0:
            return logo
        s = min(aw / lw, ah / lh)
        g = _aff.scale(logo, xfact=s, yfact=s, origin=(lb[0], lb[1]))
        gb = g.bounds
        g = _aff.translate(g, xoff=(bb[0] + bb[2]) / 2 - (gb[0] + gb[2]) / 2,
                              yoff=(bb[1] + bb[3]) / 2 - (gb[1] + gb[3]) / 2)
        # ทรงโค้ง (วงกลม/วงรี): มุม bbox อาจโผล่นอกทรง -> ย่อซ้ำจนอยู่ในกล่องจริง
        try:
            inner = box_g.buffer(-max(1.0, pad_mm * 0.6), join_style=1)
            n = 0
            while (not g.within(inner)) and n < 24:
                gb = g.bounds; cx = (gb[0] + gb[2]) / 2; cy = (gb[1] + gb[3]) / 2
                g = _aff.scale(g, xfact=0.96, yfact=0.96, origin=(cx, cy))
                n += 1
        except Exception:
            pass
        return g
    except Exception:
        return logo


def _smooth_cut(geom, r_mm=0.45):
    """🧈 รีด 'คลื่นพิกเซล' ออกจากรูปที่ได้จากการ trace ภาพ (ขนาดคลื่น ≈ 1 พิกเซลของต้นฉบับ)
       วิธี: ปิด-เปิดทางสัณฐาน (buffer +r → −2r → +r) = ลบทั้ง 'ตุ่มนูน' และ 'รอยบุ๋ม' ที่เล็กกว่า r
       เหลือเฉพาะรูปทรงจริง · คลาดเคลื่อน ≤ r (0.45 มม. บนป้าย 1.5 เมตร = ต่ำกว่าความละเอียดเครื่องตัด)"""
    if geom is None or geom.is_empty or float(r_mm) <= 0:
        return geom
    try:
        import numpy as _np
        from shapely.geometry import Polygon as _P2, LinearRing as _LR
        from shapely.ops import unary_union as _uu3
        r = float(r_mm)
        step = max(0.12, r * 0.45)                      # ระยะสุ่มจุดตามความยาวเส้น
        sig = max(1.2, r / step)                        # ความแรงรีด (หน่วย = จำนวนจุด)
        half = int(max(2, round(sig * 2.5)))
        w = _np.exp(-0.5 * (_np.arange(-half, half + 1) / sig) ** 2); w = w / w.sum()

        def _sm(ring):
            ls = _LR(ring)
            L = ls.length
            if L < r * 8:                               # ชิ้นเล็กมาก -> ไม่รีด (กันรูปหาย)
                return list(ring)
            n = max(24, int(L / step))
            pts = _np.array([ls.interpolate(i * L / n).coords[0] for i in range(n)])
            ext = _np.vstack([pts[-half:], pts, pts[:half]])   # วนปิด -> ไม่มีรอยต่อ
            sx = _np.convolve(ext[:, 0], w, 'valid'); sy = _np.convolve(ext[:, 1], w, 'valid')
            return list(zip(sx, sy))
        out = []
        for pg in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom]):
            if pg.geom_type != "Polygon" or pg.is_empty:
                continue
            try:
                ex = _sm(pg.exterior.coords)
                hs = []
                for h in pg.interiors:
                    hh = _sm(h.coords)
                    if len(hh) >= 4:
                        hs.append(hh)
                q = _P2(ex, hs).buffer(0)
                if q is not None and not q.is_empty:
                    out.append(q)
            except Exception:
                out.append(pg)
        if not out:
            return geom
        g = _uu3(out)
        return g if (g is not None and not g.is_empty) else geom
    except Exception:
        return geom


def _punch_logo_clean(logo, min_area_mm2=1.0, min_width_mm=0.15, smooth_mm=0.0):
    """🔦 ทำความสะอาด logo สำหรับ 'ฉลุโบ๋' บนหน้าโลหะ — คุณภาพไฟล์ตัดต้องผลิตได้จริง
       - ทิ้งเศษจิ๋ว (< min_area) และชิ้นบางเกินฉลุ (< min_width) ที่เครื่องตัดทำไม่ได้/หลุดร่วง
       - simplify เบา ๆ ลบจุดหยักจากการ trace ภาพ -> เส้น CNC วิ่งลื่น ขอบเนียน
       คืน (logo_สะอาด, จำนวนเศษที่ทิ้ง)"""
    if logo is None or logo.is_empty:
        return logo, 0
    g, drop = _clean_layer(logo, min_area_mm2=min_area_mm2, min_width_mm=min_width_mm)
    if g is None or g.is_empty:
        return logo, 0                                # เศษทั้งหมด? -> คงของเดิมไว้ (กันไฟล์ว่าง)
    if float(smooth_mm) > 0:            # ⚠️ ปิดเป็นค่าเริ่มต้น — simplify ทำให้รูปคลาดจากเส้นดิบ (รายละเอียดหาย)
        try:
            g2 = g.simplify(float(smooth_mm), preserve_topology=True)
            if g2 is not None and not g2.is_empty:
                g = g2
        except Exception:
            pass
    try:
        g = g.buffer(0)                                # ซ่อม self-intersection ที่อาจเกิดจาก simplify
    except Exception:
        pass
    return g, drop


def _punch_min_stroke(logo, min_w_mm=1.2):
    """💪 เพิ่มความหนาชิ้นบาง (เช่นตัวอักษรจิ๋ว) ให้ถึงขั้นต่ำที่ฉลุได้จริง — รูปทรงแทบไม่เปลี่ยน
       คืน (logo_ปรับแล้ว, จำนวนชิ้นที่ถูกเพิ่มความหนา)"""
    try:
        from shapely.ops import unary_union as _uu
        gs = list(logo.geoms) if logo.geom_type == "MultiPolygon" else [logo]
        out = []; nfix = 0
        for g in gs:
            if g.is_empty:
                continue
            _w = 0.1                                    # วัดความหนาต่ำสุดโดยกัดเข้า (พอถึง min ก็หยุด)
            while _w < float(min_w_mm):
                try:
                    if g.buffer(-_w / 2.0).is_empty:
                        break
                except Exception:
                    break
                _w += 0.1
            if _w < float(min_w_mm):                    # บางกว่าขั้นต่ำ -> พองออกให้ถึง (ขอบมน = เส้นเนียนขึ้นด้วย)
                try:
                    g2 = g.buffer((float(min_w_mm) - _w) / 2.0, join_style=1).buffer(0)
                    if g2 is not None and not g2.is_empty:
                        g = g2; nfix += 1
                except Exception:
                    pass
            out.append(g)
        if not out:
            return logo, 0
        return _uu(out), nfix
    except Exception:
        return logo, 0


def _wrap_silhouette(full, bridge_mm):
    """เชื่อมองค์ประกอบทั้งหมดให้เป็น 'เงารวมก้อนเดียว' สำหรับกล่องไฟล้อมตามทรง
       - buffer ออก แล้วหดกลับ = สะพานเชื่อมช่องว่างระหว่างตัวอักษร/ชิ้นส่วน
       - เก็บเฉพาะขอบนอก (ไม่เอารูใน) = ทรงกล่องเรียบต่อเนื่อง
       - simplify นิดหน่อย = ขอบเนียน เครื่องตัด/ดัดวิ่งนุ่ม"""
    try:
        from shapely.geometry import Polygon, MultiPolygon
        from shapely.ops import unary_union

        def _outer(geo):
            """เก็บเฉพาะขอบนอก (อุดรูใน) + คืนก้อนใหญ่สุดก้อนเดียว"""
            polys = list(geo.geoms) if isinstance(geo, MultiPolygon) else [geo]
            polys = [p for p in polys if p and not p.is_empty]
            if not polys:
                return None
            u = unary_union([Polygon(p.exterior) for p in polys])
            if isinstance(u, MultiPolygon):
                u = max(u.geoms, key=lambda a: a.area)
            return u

        b = full.bounds
        size = max(b[2] - b[0], b[3] - b[1], 1.0)
        r = max(float(bridge_mm), size * 0.06)      # bridge ปรับตามขนาดงาน (>=6% ของด้านยาว)
        RND = 1                                      # join_style=1 = โค้งมน (กันเดือยแหลม)

        # 1) CLOSE — เชื่อมทุกส่วนของงาน (ตัว+ตะเกียบ+ชาม) ให้ติดกันเป็นก้อนเดียว
        g = full.buffer(r, join_style=RND).buffer(-r, join_style=RND)
        solid = _outer(g) or full

        # 2) OPEN — กลืน "แขน/ก้านบาง" ที่ยื่นออกมา (เช่น ปลายตะเกียบ) ให้ envelope เรียบ
        o = size * 0.035
        g2 = solid.buffer(-o, join_style=RND).buffer(o * 1.15, join_style=RND)
        solid = _outer(g2) or solid

        # 3) SMOOTH รอบสุดท้าย — โค้งมนทั้งเข้า-ออก ลบรอยหยัก/เดือย/เส้นไขว้
        #    (เว้าลึก ๆ ที่ทำให้คิ้ว offset แล้วเส้นทับกัน จะถูกลบ)
        s = size * 0.02
        solid = solid.buffer(s, join_style=RND).buffer(-s, join_style=RND)
        solid = _outer(solid) or solid
        solid = solid.buffer(-s * 0.5, join_style=RND).buffer(s * 0.5, join_style=RND)
        solid = _outer(solid) or solid

        # simplify พอประมาณ + ทำให้ valid (buffer(0) ซ่อมเส้นตัดกันเอง)
        solid = solid.simplify(max(0.5, size * 0.004))
        if not solid.is_valid:
            solid = solid.buffer(0)
            solid = _outer(solid) or solid
        return solid if (solid and not solid.is_empty) else full
    except Exception:
        return full


_TYPE_EN = {
    "พลาสวูดไดคัท อักษร/โลโก้ ไม่มีไฟ 1 layer": "Plaswood Die-cut Letters/Logo · No Light · 1 Layer",
    "พลาสวูดไดคัท อักษร/โลโก้ ไม่มีไฟ 2 layer": "Plaswood Die-cut Letters/Logo · No Light · 2 Layers",
    "อะคริลิคไดคัท อักษร/โลโก้ ไม่มีไฟ 1 layer": "Acrylic Die-cut Letters/Logo · No Light · 1 Layer",
    "อะคริลิคไดคัท อักษร/โลโก้ ไม่มีไฟ 2 layer": "Acrylic Die-cut Letters/Logo · No Light · 2 Layers",
    "ไฟออกหน้า มีคิ้ว": "Front-lit · with Trim (Kim)",
    "ไฟออกหน้า ไม่มีคิ้ว": "Front-lit · no Trim",
    "สแตนดี้ สี่เหลี่ยม": "Standee · Rectangular Board (printed + fold-out leg)",
    "สแตนดี้ ล้อมตามทรง": "Standee · Contour Die-cut (printed + fold-out leg)",
    "ตัวอักษรยกขอบไฟออกหน้า (มีคิ้ว)": "Front-lit Built-up Letters (with Trim) · cut per letter",
    "ตัวอักษรยกขอบไฟออกหน้า (ไม่มีคิ้ว)": "Front-lit Built-up Letters (no Trim) · cut per letter",
    "ตัวอักษรไฟออกรอบ": "Edge-lit Letters (light all around)",
    "กล่องไฟฉลุหน้า": "Light Box · Cut-out Face",
    "กล่องไฟสี่เหลี่ยม ฉลุหน้า": "Rect Light Box · Punched Face",
    "กล่องไฟวงกลม ฉลุหน้า": "Round Light Box · Punched Face",
    "ตัวอักษร/โลโก้ แบน (ไม่ยกขอบ)": "Flat Letters/Logo (no return)",
    "อักษรยกขอบไฟออกหน้า + โครงแขวน": "Front-lit Raised Letters + Hanging Frame",
    "นีออนเฟล็กซ์": "Neon Flex + Clear Acrylic Backing",
    "กล่องไฟอะคริลิค ไฟออกรอบ": "Edge-lit Acrylic Light Box (glow all sides)",
    "ตัวอักษรยกขอบไฟออกหลัง": "Halo-lit Raised Letters (back-lit)",
    "กล่องไฟ 2 หน้า": "Light Box · Double-Face",
    "งานยกขอบ": "Fabricated Return (Metal)",
    "งานยกขอบ มีไส้": "Fabricated Return · with Core",
    "กล่องไฟล้อมตามทรง 1 หน้า": "Contour Light Box · Single-Face",
    "กล่องไฟล้อมตามทรง 2 หน้า": "Contour Light Box · Double-Face",
    "กล่องไฟทรงกลม 1 หน้า": "Round Light Box · Single-Face",
    "กล่องไฟทรงกลม 2 หน้า": "Round Light Box · Double-Face",
    "กล่องไฟสี่เหลี่ยม 1 หน้า": "Rectangle Light Box · Single-Face",
    "กล่องไฟสี่เหลี่ยม 2 หน้า": "Rectangle Light Box · Double-Face",
    "กล่องไฟวงรี 1 หน้า": "Oval Light Box · Single-Face",
    "กล่องไฟวงรี 2 หน้า": "Oval Light Box · Double-Face",
}


def _en_type(th):
    return _TYPE_EN.get(str(th), str(th))


def _dxf_layer(name):
    """ชื่อเลเยอร์ให้ปลอดภัยกับ DXF — ห้ามมี < > / \\ " : ; ? * | = ` และช่องว่าง
       (ezdxf/AutoCAD จะ error ถ้ามีอักขระต้องห้าม เช่น '/' ใน 'Printed / Acrylic Face')"""
    s = str(name)
    for ch in '<>/\\":;?*|=`':
        s = s.replace(ch, "")
    s = s.replace("·", "").replace(" ", "_")
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_") or "CUT"


def _en_layer(n):
    n = str(n)
    # 🧱 ป้ายหลายวัสดุ: ชื่อชั้นขึ้นต้นด้วยแท็กกลุ่ม (B_ · C_) -> คงแท็กไว้ แปลเฉพาะชื่อชั้น
    import re as _re9
    _mt = _re9.match(r"^([B-H])_(.+)$", n)
    if _mt:
        return "%s_%s" % (_mt.group(1), _en_layer(_mt.group(2)))
    if "งานพิมพ์ / สติ๊กเกอร์" in n:
        return "PRINT / STICKER (no metal cut)"
    if "แผ่นขอบข้าง" in n:
        return "Side Return Plates (fold)"
    if "ขาตั้งหลัง" in n:
        return "Standee Fold-out Leg + Lock Tab"
    if "แผ่นสแตนดี้" in n:
        return "Standee Board (printed face)"
    if "ไดคัทตามทรง" in n:
        return "Die-cut Contour Plate"
    if "ชั้นบน" in n:
        return "Top Layer (Letters/Logo)"
    if "ชั้นรอง" in n:
        return "Backing Layer (+1.5cm margin)"
    if "โลหะฉลุ" in n:
        return "Punched Metal Face"
    if "ขาวนม" in n:
        return "Milky Acrylic 3mm Backing"
    if "แผ่นแบน" in n:
        return "Flat Face Plate"
    if "คิ้ว" in n:
        return "Contour Trim (Kim)" if "ล้อมทรง" in n else "Trim Face (Kim)"
    if "อะคริลิคขาว" in n and "พิมพ์" in n:
        return "Acrylic P433 White Face (Print)"
    if "หน้าพิมพ์" in n:
        return "Printed Acrylic Face"
    if "พลาสวูด" in n:
        return "Plaswood Core"
    if "ไส้" in n and "อะคริลิค" in n:
        return "Clear Acrylic Core"
    if "อะคริลิค" in n and "ยกขอบ" in n:
        return "Acrylic Return"
    if "อะคริลิค" in n:
        return "Acrylic Face"
    if "ซิ้งค์" in n:
        return "Zinc Face"
    if "แผ่นพื้น" in n:
        return "Back Plate"
    if n.startswith("ยกขอบ"):
        if "ใน" in n:
            return "Inner Return"
        if "นอก" in n:
            return "Outer Return"
        return "Return"
    if "ขากลาง" in n:
        return "Floating Stud"
    if "แผงกลาง" in n:
        return "Center LED Panel"
    return n


def _en_wall(n):
    return _en_layer(n)


def _piece_poly_with_holes(pc):
    """🕳️ ประกอบ 'รูใน' กลับให้ชิ้นเวกเตอร์ — full_pieces_mm คืน poly แบบตัน (รูอยู่ใน subs)
       ใช้กติกา even-odd (XOR วงแหวนทั้งหมดของ drawing เดียวกัน) = ตรงกับการ fill ของไฟล์ .ai/PDF"""
    from shapely.geometry import Polygon
    try:
        rings = []
        for sp in pc.get("subs", []):
            if not sp.get("closed"):
                continue
            pts = [tuple(sp["start"])]
            for seg in sp.get("segs", []):
                if seg[0] == "L":
                    pts.append(tuple(seg[1]))
                elif seg[0] == "C":                     # flatten เบซิเยร์ (ละเอียดพอสำหรับ geometry ops)
                    p0 = pts[-1]; c1, c2, p3 = seg[1], seg[2], seg[3]
                    for i in range(1, 17):
                        t = i / 16.0; mt = 1.0 - t
                        pts.append((mt*mt*mt*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t*t*t*p3[0],
                                    mt*mt*mt*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t*t*t*p3[1]))
            if len(pts) >= 4:
                _sa = 0.0                                # ทิศทางวง (signed area) จากจุดดิบ — ก่อน buffer(0) ซึ่งจะปรับทิศ
                for _i in range(len(pts) - 1):
                    _sa += pts[_i][0] * pts[_i + 1][1] - pts[_i + 1][0] * pts[_i][1]
                pg = Polygon(pts).buffer(0)
                if pg is not None and not pg.is_empty and pg.area > 0.5:
                    rings.append((pg, _sa > 0))
        if len(rings) <= 1:
            return pc["poly"]
        # 🧭 ประกอบตาม 'ทิศทางวงแหวน' (มาตรฐาน AI/PDF): วงกลับทิศ + อยู่ในเนื้อ = รู · ทิศเดียวกัน/ซ้อนกัน = เนื้อ (union)
        #    (ห้ามใช้ XOR ล้วน — ชิ้นซ้อนกันแบบ nonzero จะกัดกันเองจนรูปเพี้ยน)
        rings.sort(key=lambda t: -abs(t[0].area))
        g = None; g_ccw = None
        for pg, ccw in rings:
            if g is None:
                g = pg; g_ccw = ccw
                continue
            try:
                _inside = g.contains(pg.representative_point())
            except Exception:
                _inside = False
            if _inside and (ccw != g_ccw):
                g = g.difference(pg)                    # รูใน (วงกลับทิศ ในเนื้อ)
            else:
                g = g.union(pg)                         # เนื้อเพิ่ม/ชิ้นซ้อน
        g = g.buffer(0)
        return g if (g is not None and not g.is_empty) else pc["poly"]
    except Exception:
        return pc["poly"]


def _sticker_groups(pieces, W, H):
    """🧩 จัดชิ้นเป็น 'กลุ่มคำ/ข้อความ' — คลิกครั้งเดียวได้ทั้งประโยค (ไม่ต้องคลิกทีละตัวอักษร)
       เกณฑ์: อยู่แถวเดียวกัน (Y ซ้อน >40%) และห่างกันไม่เกิน 0.6 × ความสูงตัวอักษร
       คืน list ของ list-ของ-index"""
    n = len(pieces)
    if n <= 1:
        return [[i] for i in range(n)]
    bb = [p.bounds for p in pieces]
    par = list(range(n))

    def _find(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a

    def _join(a, b):
        ra, rb = _find(a), _find(b)
        if ra != rb:
            par[rb] = ra
    # 🔗 รวมชิ้นเป็น 'คำ' เมื่อ: ขนาดใกล้กัน + อยู่ระดับเดียวกัน + ชิดกัน (เทียบกับขนาดตัวเอง)
    for i in range(n):
        hi = bb[i][3] - bb[i][1]
        for j in range(i + 1, n):
            hj = bb[j][3] - bb[j][1]
            _mn = min(hi, hj); _mx = max(hi, hj)
            if _mn <= 0 or _mx / _mn > 1.6:                 # ขนาดต่างกันมาก (โลโก้ vs ตัวอักษร) -> คนละกลุ่ม
                continue
            _ov = min(bb[i][3], bb[j][3]) - max(bb[i][1], bb[j][1])
            if _ov < _mn * 0.25:                            # ไม่ได้อยู่บรรทัดเดียวกัน
                continue
            _gx = max(bb[i][0], bb[j][0]) - min(bb[i][2], bb[j][2])
            if _gx <= _mn * 0.55:                           # ชิดกันพอที่จะเป็นคำเดียวกัน
                _join(i, j)
    # 🇹🇭 รอบเก็บตก: สระ/วรรณยุกต์/จุด (ชิ้นเล็กลอยอยู่ 'บน-ล่าง' ของคำ) -> ผูกเข้ากับคำที่อยู่ใต้/เหนือมัน
    _bag0 = {}
    for i in range(n):
        _bag0.setdefault(_find(i), []).append(i)
    _cores = [g for g in _bag0.values() if len(g) >= 2 or (bb[g[0]][3] - bb[g[0]][1]) > 0]
    for i in range(n):
        _hi = bb[i][3] - bb[i][1]; _wi = bb[i][2] - bb[i][0]
        if len(_bag0.get(_find(i), [])) > 1:
            continue                                        # อยู่ในคำแล้ว
        _best = None; _bd = 1e18
        for g in _cores:
            if _find(i) == _find(g[0]) or len(g) < 2:
                continue
            gx0 = min(bb[j][0] for j in g); gx1 = max(bb[j][2] for j in g)
            gy0 = min(bb[j][1] for j in g); gy1 = max(bb[j][3] for j in g)
            _gh = gy1 - gy0
            if _hi > _gh * 0.85:                            # ไม่ใช่ชิ้นเล็ก -> ข้าม
                continue
            _cx = (bb[i][0] + bb[i][2]) / 2.0
            if _cx < gx0 - _wi or _cx > gx1 + _wi:          # ต้องอยู่ในช่วงแนวนอนของคำ
                continue
            _dy = (gy0 - bb[i][3]) if bb[i][3] < gy0 else ((bb[i][1] - gy1) if bb[i][1] > gy1 else 0.0)
            if _dy > _gh * 0.75:                            # ห่างเกินไป (คนละบรรทัด)
                continue
            if _dy < _bd:
                _bd = _dy; _best = g
        if _best is not None:
            _join(_best[0], i)
    _bag = {}
    for i in range(n):
        _bag.setdefault(_find(i), []).append(i)
    groups = list(_bag.values())
    groups.sort(key=lambda g: (min(bb[i][1] for i in g), min(bb[i][0] for i in g)))
    return groups


def _merge_touching(pieces, tol=0.6):
    """🧩 จับ 'ชิ้นที่ติดกัน/แทบติดกัน' ให้อยู่กลุ่มเดียวกัน — คืนเป็น list ของ index

    เอนจิ้น trace มักซอยขอบบนของตัวอักษรออกเป็นแถบบาง ๆ หลายชิ้น (4–10 ตร.มม.)
    ต้องนับเป็นชิ้นเดียวกับตัวอักษร ไม่งั้นเลือกจ่ายวัสดุได้ไม่ครบ

    ⚠️ ห้ามแก้รูปทรง: เดิมเคยรวมด้วย buffer(+r).buffer(-r) แล้วมันกัดมุมเว้า
       ทำให้ตัวอักษร 'แหว่ง' — ตอนนี้เก็บเส้นต้นฉบับไว้ 100% แค่บอกว่าใครอยู่กลุ่มไหน"""
    n = len(pieces)
    if n <= 1:
        return [[i] for i in range(n)]
    par = list(range(n))

    def _f(i):
        while par[i] != i:
            par[i] = par[par[i]]; i = par[i]
        return i
    bb = [p.bounds for p in pieces]
    ar = [p.area for p in pieces]
    # 🛡️ รวมได้เฉพาะเมื่อ 'ฝ่ายใดฝ่ายหนึ่งเป็นชิ้นเล็ก' (เศษขอบจาก trace) — ตัวอักษรเต็มตัว 2 ตัวจะไม่มีวันถูกดูดรวมกัน
    _big = max(ar) if ar else 1.0
    _small = max(4.0, _big * 0.06)
    for i in range(n):
        for j in range(i + 1, n):
            if ar[i] >= _small and ar[j] >= _small:
                continue
            # ตัดคู่ที่กรอบห่างเกิน tol ออกก่อน (เร็ว)
            if (bb[i][0] - bb[j][2] > tol or bb[j][0] - bb[i][2] > tol
                    or bb[i][1] - bb[j][3] > tol or bb[j][1] - bb[i][3] > tol):
                continue
            try:
                if pieces[i].distance(pieces[j]) <= tol:
                    a, b = _f(i), _f(j)
                    if a != b:
                        par[a] = b
            except Exception:
                pass
    bag = {}
    for i in range(n):
        bag.setdefault(_f(i), []).append(i)
    # ✅ คืนเป็น 'กลุ่มของ index' — ไม่แตะรูปทรงเลยแม้แต่จุดเดียว
    #    (เคยลองรวมด้วย buffer(+r).buffer(-r) แล้วมันกัดมุมเว้าของตัวอักษรแหว่ง — ห้ามทำเด็ดขาด)
    cl = sorted(bag.values(), key=lambda idx: (round(min(pieces[k].bounds[0] for k in idx), 1),
                                               round(min(pieces[k].bounds[1] for k in idx), 1)))
    return cl


def _sticker_map_svg(box_g, pieces, sel, groups=None, raw_subs=None):
    """🏷️ แผนที่ชิ้นบนหน้ากล่อง (คลิกเลือกเป็นสติ๊กเกอร์): กล่อง + ทุกชิ้นมี data-pi กดสลับได้
       ชิ้นที่เลือก = แดง (สติ๊กเกอร์ ไม่ตัด) · ไม่เลือก = น้ำเงินเข้ม (ฉลุตามปกติ)"""
    try:
        b = box_g.bounds; W = b[2] - b[0]; H = b[3] - b[1]
        if W <= 1 or H <= 1:
            return ""

        def _pd(pg):
            s = ""
            for r in [pg.exterior] + list(pg.interiors):
                pts = list(r.coords)
                s += "M " + " L ".join("%.1f %.1f" % (x - b[0], y - b[1]) for x, y in pts) + " Z "
            return s
        _grp = groups if groups else [[i] for i in range(len(pieces))]
        _lw = max(0.6, W * 0.0012)
        out = ['<svg id="stkSvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %.1f %.1f" style="width:100%%;height:auto;display:block;touch-action:none">' % (W, H)]
        # 🥇 ชั้นล่างสุด = 'เส้นดิบจากเอนจิ้น' วาดแบบเดียวกับไฟล์เส้นตัดที่ออกจากปุ่มเป๊ะ
        #    fill="none" + stroke อย่างเดียว -> ไม่ต้องตัดสินว่าอันไหนรู จึงไม่มีทางแหว่ง
        _drew_raw = False
        try:
            if raw_subs:
                from vectorcnc import nesting as _ns9
                # 📐 บีบเส้นให้อยู่ในกรอบภาพเสมอ — กันงานล้นขอบแผนที่ (เช่นอักษรยกขอบไฟออกหน้า)
                #    เส้นดิบอาจกว้าง/สูงกว่ารูปที่ใช้ตีกรอบเล็กน้อย ถ้าวาดตรง ๆ จะโผล่ออกนอกกรอบ
                _ax = []; _ay = []
                for _sp in raw_subs:
                    _pts9 = [_sp["start"]]
                    for _g in _sp["segs"]:
                        _pts9.extend(_g[1:])          # รวม 'จุดควบคุมโค้ง' ด้วย ไม่งั้นโค้งยังปูดออกนอกกรอบได้
                    for _q in _pts9:
                        _ax.append(_q[0]); _ay.append(_q[1])
                _k9 = 1.0; _ox = b[0]; _oy = b[1]
                if _ax:
                    _aw = max(_ax) - min(_ax); _ah = max(_ay) - min(_ay)
                    if _aw > 0.01 and _ah > 0.01:
                        _k9 = min(1.0, W / _aw, H / _ah)
                        _ox = min(_ax) - (W - _aw * _k9) / (2.0 * _k9)
                        _oy = min(_ay) - (H - _ah * _k9) / (2.0 * _k9)

                def _T9(_pt):
                    return ((_pt[0] - _ox) * _k9, (_pt[1] - _oy) * _k9)
                _p9 = []
                for _sp in raw_subs:
                    _n9 = {"start": _T9(_sp["start"]),
                           "segs": [("L", _T9(s[1])) if s[0] == "L" else
                                    ("C", _T9(s[1]), _T9(s[2]), _T9(s[3])) for s in _sp["segs"]],
                           "closed": _sp.get("closed", True)}
                    _p9.append('<path d="%s"/>' % _ns9._sp_d(_n9))
                if _p9:
                    out.append('<g fill="none" stroke="#334155" stroke-width="%.2f" stroke-linejoin="round" '
                               'stroke-linecap="round">%s</g>' % (max(0.8, W * 0.0022), "".join(_p9)))
                    _drew_raw = True
        except Exception:
            _drew_raw = False
        # สำรอง: ถ้าไม่มีเส้นดิบ ค่อยวาดจากรูปทรง (ทีละชิ้น ห้ามรวม path — evenodd จะหักล้างกัน)
        if not _drew_raw:
            try:
                for _bp in (box_g.geoms if box_g.geom_type == "MultiPolygon" else [box_g]):
                    if _bp.geom_type == "Polygon" and not _bp.is_empty:
                        out.append('<path d="%s" fill="#334155" fill-rule="evenodd" stroke="#0f172a" stroke-width="%.1f"/>'
                                   % (_pd(_bp), _lw))
            except Exception:
                pass
        for _gi, _g in enumerate(_grp):
            _on = any(i in sel for i in _g)
            _xs = [pieces[i].bounds[0] for i in _g] + [pieces[i].bounds[2] for i in _g]
            _ys = [pieces[i].bounds[1] for i in _g] + [pieces[i].bounds[3] for i in _g]
            _pad = max(2.0, W * 0.004)
            # 🖱️ คลิกครั้งเดียว = ทั้งกลุ่ม (ทั้งคำ) · data-pis = รายการ index ในกลุ่ม
            out.append('<g data-pis="%s" data-gi="%d" style="cursor:pointer">' % (",".join(str(i) for i in _g), _gi))
            out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" opacity="%s" rx="%.1f"/>'
                       % (min(_xs) - b[0] - _pad, min(_ys) - b[1] - _pad,
                          (max(_xs) - min(_xs)) + _pad * 2, (max(_ys) - min(_ys)) + _pad * 2,
                          "#ef4444" if _on else "#38bdf8", "0.14" if _on else "0.0", _pad))
            # ⚠️ ต้องวาด 'ชิ้นละ path' เท่านั้น — ห้ามต่อ d ของหลายชิ้นเข้าด้วยกัน
            #    เพราะ fill-rule="evenodd" จะหักล้างกันตรงที่ชิ้นซ้อนกัน ทำให้ตัวอักษร 'แหว่ง'
            #    (รูปทรงไม่ได้ผิด — เป็นการวาดผิดล้วน ๆ)
            # ✅ ถ้าวาดเส้นดิบเป็นชั้นฐานแล้ว: ชั้นนี้เป็นแค่ 'พื้นที่กด + ไฮไลต์' เท่านั้น
            #    ไม่ทับรูปงาน จึงไม่มีทางทำให้ตัวอักษรเปลี่ยนรูป
            for i in _g:
                if i < len(pieces):
                    if _drew_raw:
                        out.append('<path d="%s" fill="%s" fill-opacity="%s" stroke="none"/>'
                                   % (_pd(pieces[i]), "#ef4444" if _on else "#000000", "0.30" if _on else "0.001"))
                    else:
                        out.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.1f" opacity="0.92"/>'
                                   % (_pd(pieces[i]), "#ef4444" if _on else "#334155",
                                      "#b91c1c" if _on else "#0f172a", _lw))
            out.append('<title>%s</title></g>'
                       % ("สติ๊กเกอร์ (ไม่ตัด) — คลิกเพื่อกลับไปตัด" if _on
                          else "คลิก 1 ครั้ง = ทั้งคำนี้เป็นสติ๊กเกอร์ (ไม่ตัด)"))
        out.append('</svg>')
        return "".join(out)
    except Exception:
        return ""


class _SkipFallback(Exception):
    """สัญญาณ: เส้นทางหลัก (vtracer) ได้ผลแล้ว -> ข้ามเส้นทางสำรอง"""
    pass


def _vtrace_full_mm(img_path, real_width_mm):
    """🏆 trace ด้วย 'เอนจิ้นเดียวกับปุ่ม แปลงเป็นเส้นตัด' (vtracer Bézier — โค้งเนียน มุมคม เส้นตรงตรงจริง)
       -> sample โค้งถี่ ~1px -> ประกอบ รู/ชิ้นซ้อนในรู แบบ parity (ลึกคู่=เนื้อ · ลึกคี่=รู เช่น หัวแพะในรูวงหยัก)
       คืน (Multi)Polygon ขนาด มม. (สเกล bbox กว้าง = real_width_mm) · คืน None ถ้าไม่สำเร็จ"""
    import math as _m
    from vectorcnc import trace_engine as _te
    from shapely.geometry import Polygon as _Pg
    from shapely.ops import unary_union as _uu
    from shapely.prepared import prep as _prep
    # 🎯 ใช้ 'เอนจิ้นเดียวกับปุ่มแปลงเป็นเส้นตัด' เป๊ะ ๆ = potrace ก่อน · vtracer เป็นตัวสำรอง
    #    ⚠️ เดิมเรียก vtracer ตรง ๆ (ทั้งที่ปุ่มใช้ potrace) -> ขอบตัวอักษรคนละแบบ
    #       เป็นที่มาของ 'รอยตัดบนหัวตัวอักษร' ที่ปุ่มแปลงไม่เคยมี
    layers = None
    try:
        layers = _te.trace_potrace(img_path, n_colors=2)
        _TRACE_ENG["mode"] = "potrace-button"
    except Exception:
        layers = None
    if not layers:
        layers = _te.trace_vtracer(img_path, n_colors=2)
        _TRACE_ENG["mode"] = "vtracer-button"
    rings = []
    for _col, _subs in (layers or []):
        for _sp in _subs:
            _pts = [_sp['start']]; _cur = _sp['start']
            for _s in _sp['segs']:
                if _s[0] == 'L':
                    _pts.append(_s[1]); _cur = _s[1]
                else:
                    _p1, _p2, _p3 = _s[1], _s[2], _s[3]
                    _ln = (_m.hypot(_p1[0] - _cur[0], _p1[1] - _cur[1]) + _m.hypot(_p2[0] - _p1[0], _p2[1] - _p1[1])
                           + _m.hypot(_p3[0] - _p2[0], _p3[1] - _p2[1]))
                    # 🔬 sample โค้งถี่ (~0.45px) — ใช้เฉพาะสร้าง 'รูปทรง' สำหรับ buffer ทำคิ้ว/ยกขอบ
                    #    เส้นดิบที่ส่งออกไฟล์ตัดไม่ถูกแตะ (เก็บแยกใน _RAW_SUBS) — คมเท่าปุ่มเสมอ
                    #    ยิ่งถี่ = polygon เกาะเส้นโค้งจริงแม่นขึ้น -> ชั้นที่ offset ออกมาเนียนตามไปด้วย
                    _ns = max(10, min(320, int(_ln / 0.45) + 2))
                    for _i2 in range(1, _ns + 1):
                        _t = _i2 / _ns; _mt = 1.0 - _t
                        _pts.append((_mt**3 * _cur[0] + 3 * _mt * _mt * _t * _p1[0] + 3 * _mt * _t * _t * _p2[0] + _t**3 * _p3[0],
                                     _mt**3 * _cur[1] + 3 * _mt * _mt * _t * _p1[1] + 3 * _mt * _t * _t * _p2[1] + _t**3 * _p3[1]))
                    _cur = _p3
            if len(_pts) >= 4:
                rings.append(_pts)
    if not rings:
        return None
    _xs = [p[0] for r in rings for p in r]; _ys = [p[1] for r in rings for p in r]
    _minx = min(_xs); _wpx = max(1e-6, max(_xs) - _minx); _miny = min(_ys)
    _k = float(real_width_mm) / _wpx
    # 🏆 เก็บ 'เส้นโค้งดิบ' จากเอนจิ้น (แปลงเป็น มม. พิกัดเดียวกับ polygon) — ใช้ทำไฟล์ตัดตรง ๆ เหมือนปุ่ม
    try:
        _rawsubs = []
        for _col, _subs in (layers or []):
            for _sp in _subs:
                _rawsubs.append({"start": ((_sp['start'][0] - _minx) * _k, (_sp['start'][1] - _miny) * _k),
                                 "closed": _sp.get('closed', True),
                                 "segs": [(("L", ((s[1][0] - _minx) * _k, (s[1][1] - _miny) * _k)) if s[0] == 'L' else
                                           ("C", ((s[1][0] - _minx) * _k, (s[1][1] - _miny) * _k),
                                            ((s[2][0] - _minx) * _k, (s[2][1] - _miny) * _k),
                                            ((s[3][0] - _minx) * _k, (s[3][1] - _miny) * _k)))
                                          for s in _sp['segs']]})
        _RAW_SUBS["subs"] = _rawsubs
    except Exception:
        _RAW_SUBS["subs"] = None
    Ps = []
    for r in rings:
        try:
            _p = _Pg([((x - _minx) * _k, (y - _miny) * _k) for x, y in r])
            if not _p.is_valid:
                _p = _p.buffer(0)
            if _p is None or _p.is_empty:
                continue
            if _p.geom_type == 'MultiPolygon':
                _p = max(_p.geoms, key=lambda q: q.area)
            # 📌 กฎ: 'วาดเส้นตัดให้ได้ตามต้นแบบ' — ห้ามทิ้งชิ้นงานของลูกค้าเด็ดขาด
            #    เก็บทุกวงที่เป็นรูปทรงจริง · กันเฉพาะวงที่พังจนไม่มีพื้นที่ (เศษคำนวณ ไม่ใช่ชิ้นงาน)
            if _p.area > 0.001:
                Ps.append(_p)
        except Exception:
            continue
    if not Ps:
        return None
    # 🗑️ ทิ้ง 'กรอบหน้ากระดาษ/พื้นหลัง' ที่ติดมากับไฟล์ (เช่น composed_vector.pdf มีขอบหน้าเป็นวัตถุ)
    #    กรอบนี้ร้ายมาก: มันครอบตัวอักษรทุกตัว -> ตอนประกอบรูปทรงจะนับตัวอักษรเป็น 'รู' ทั้งหมด
    #    -> ตัวอักษรแหว่ง/เพี้ยน + มีเส้นตัดกรอบเกินมาในไฟล์
    #    เงื่อนไข: กินพื้นที่เกือบทั้งภาพ + เป็นสี่เหลี่ยม + มีชิ้นอื่นอยู่ข้างในหลายชิ้น
    try:
        _bx = [p.bounds for p in Ps]
        _X0 = min(b[0] for b in _bx); _Y0 = min(b[1] for b in _bx)
        _X1 = max(b[2] for b in _bx); _Y1 = max(b[3] for b in _bx)
        _AA = max(1e-6, (_X1 - _X0) * (_Y1 - _Y0))
        _drop = set()
        for _i9, _p9 in enumerate(Ps):
            _b9 = _bx[_i9]
            _a9 = (_b9[2] - _b9[0]) * (_b9[3] - _b9[1])
            if _a9 < _AA * 0.85:
                continue
            _rect = _p9.area >= _a9 * 0.90          # เต็มกรอบ = สี่เหลี่ยม (ไม่ใช่ตัวอักษร)
            _inside = sum(1 for _j9, _q9 in enumerate(Ps)
                          if _j9 != _i9 and _b9[0] <= _bx[_j9][0] and _b9[2] >= _bx[_j9][2]
                          and _b9[1] <= _bx[_j9][1] and _b9[3] >= _bx[_j9][3])
            if _rect and _inside >= 3:
                _drop.add(_i9)
        if _drop and len(_drop) < len(Ps):
            _keepP = [p for i, p in enumerate(Ps) if i not in _drop]
            # ตัดออกจาก 'เส้นดิบ' ด้วย เพื่อไม่ให้กรอบไปโผล่ในไฟล์ตัด
            try:
                _rs9 = _RAW_SUBS.get("subs")
                if _rs9 and len(_rs9) == len(Ps):
                    _RAW_SUBS["subs"] = [s for i, s in enumerate(_rs9) if i not in _drop]
                elif _rs9:
                    _nk = []
                    for _s9 in _rs9:
                        _pt = [_s9["start"]] + [t[-1] for t in _s9["segs"]]
                        _sx0 = min(p[0] for p in _pt); _sy0 = min(p[1] for p in _pt)
                        _sx1 = max(p[0] for p in _pt); _sy1 = max(p[1] for p in _pt)
                        if (_sx1 - _sx0) * (_sy1 - _sy0) < _AA * 0.85:
                            _nk.append(_s9)
                    if _nk:
                        _RAW_SUBS["subs"] = _nk
            except Exception:
                pass
            Ps = _keepP
            _TRACE_ENG["frame_dropped"] = len(_drop)
    except Exception:
        pass
    _order = sorted(range(len(Ps)), key=lambda i: -Ps[i].area)
    _reps = [Ps[i].representative_point() for i in range(len(Ps))]
    _preps = {}
    _parent = [-1] * len(Ps); _depth = [0] * len(Ps)
    for _pos, _i in enumerate(_order):
        _best = -1; _ba = None
        for _j in _order[:_pos]:
            if Ps[_j].area <= Ps[_i].area or not Ps[_j].envelope.contains(_reps[_i]):
                continue
            if _j not in _preps:
                _preps[_j] = _prep(Ps[_j])
            if _preps[_j].contains(_reps[_i]) and (_ba is None or Ps[_j].area < _ba):
                _best = _j; _ba = Ps[_j].area
        # 🩹 กันตัวอักษร 'แหว่ง': เดิมตัดสินว่าเป็น 'รู' จากจุดตัวแทนจุดเดียว
        #    เศษขอบที่เอนจิ้นซอยออกมา (ทับขอบตัวอักษรบางส่วน) จุดตัวแทนก็อยู่ในตัวอักษร
        #    -> ถูกนับเป็นรู -> เจาะทะลุเป็นรอยแหว่งตรงขอบบน (และย้ายที่ทุกครั้งตามการ trace)
        #    ✅ ของจริง 'รู' ต้องอยู่ข้างในทั้งชิ้น · ถ้าล้นออกนอกขอบแม้แต่นิดเดียว = เนื้องาน ไม่ใช่รู
        if _best >= 0:
            try:
                _pb9 = Ps[_best].bounds
                _PH = _pb9[3] - _pb9[1]                       # ความสูงตัวอักษรแม่
                _hb9 = Ps[_i].bounds
                _hh = _hb9[3] - _hb9[1]; _hw = _hb9[2] - _hb9[0]
                _tolH = max(0.6, _PH * 0.035)                 # 3.5% ของความสูงตัวอักษร
                # 🔎 'ช่องในตัวอักษรจริง' (เช่น ช่องกลาง อ ล ก) มีลักษณะชัดเจน 3 ข้อ:
                #    (1) อยู่ข้างในทั้งชิ้น — ล้นออกนอกขอบแม้แต่นิดเดียว = เนื้องาน
                #    (2) อยู่ลึกเข้าไป ไม่แนบขอบตัวอักษร
                #    (3) ไม่ใช่แถบบางแบน ๆ — เศษจากการ trace ขอบจะบางมาก (สูงไม่กี่ มม.)
                #    ถ้าผิดข้อใดข้อหนึ่ง = เนื้องาน ไม่ใช่ช่อง -> ห้ามเจาะทะลุ (ตัวอักษรจะแหว่ง)
                if (not _preps[_best].contains(Ps[_i])
                        or Ps[_best].exterior.distance(Ps[_i]) < _tolH
                        or min(_hh, _hw) < _PH * 0.05
                        or Ps[_i].area < Ps[_best].area * 0.004):
                    _best = -1
            except Exception:
                pass
        _parent[_i] = _best; _depth[_i] = 0 if _best < 0 else _depth[_best] + 1
    _out = []; _used = 0; _lost = []
    for _i in range(len(Ps)):
        if _depth[_i] % 2 == 0:
            _hs = [list(Ps[_j].exterior.coords) for _j in range(len(Ps)) if _parent[_j] == _i]
            try:
                _pg2 = _Pg(list(Ps[_i].exterior.coords), _hs).buffer(0)
            except Exception:
                _lost.append(("สร้างรูปทรงไม่สำเร็จ", Ps[_i].area)); continue
            # 📌 ห้ามทิ้งชิ้นงานของลูกค้า — จุดจิ๋ว/สระ/accent เล็ก ๆ ก็คือเนื้องานจริง
            #    เดิมทิ้งชิ้นที่ < 3 ตร.มม. (≈ ⌀2 มม.) ซึ่งกินรายละเอียดจริงของงานได้
            if _pg2 is not None and not _pg2.is_empty and _pg2.area > 0.001:
                _out.append(_pg2); _used += 1 + len(_hs)
            else:
                _lost.append(("รูปทรงพังจนไม่มีพื้นที่", Ps[_i].area))
    # 🧭 บันทึกไว้รายงานให้ผู้ใช้เห็น: เข้ามากี่เส้น · ใช้จริงกี่เส้น · หายกี่เส้น เพราะอะไร
    try:
        _TRACE_ENG["rings_in"] = len(Ps)
        _TRACE_ENG["rings_used"] = _used
        _TRACE_ENG["rings_lost"] = _lost[:6]
        _TRACE_ENG["holes"] = sum(1 for _d in _depth if _d % 2 == 1)
    except Exception:
        pass
    if not _out:
        return None
    _u = _uu(_out)
    if _u is None or _u.is_empty:
        return None
    # 🧈 รีดคลื่นพิกเซล — เฉพาะภาพ raster เท่านั้น (เวกเตอร์แท้ไม่ต้องรีด · เส้นดิบคมอยู่แล้ว)
    _sm = float(_CUT_SMOOTH.get("mm", 0.0))
    if _sm > 0:
        _u2 = _smooth_cut(_u, _sm)
        if _u2 is not None and not _u2.is_empty:
            _RAW_SUBS["subs"] = None                     # รูปเปลี่ยนแล้ว -> เส้นดิบใช้ไม่ได้
            return _u2
    return _u


def _letter_full_mm(inp, real_width_mm, real_height_mm, n_colors):
    """คืน shapely polygon 'รูปเงาตัวอักษร/โลโก้' (รวมรูใน) ที่ขนาดจริง มม. (Y ลง)"""
    # ⚡ ไฟล์เดิม + ขนาดเดิม + ค่าเนียนเดิม = รูปทรง/เส้นดิบ/สถานะเอนจิ้น เดิมเป๊ะ ->
    #    จำครบชุดแล้วคืนทันที (ผู้ใช้สลับประเภทป้ายของไฟล์เดิมบ่อยมาก งานอ่านไฟล์ซ้ำหายทั้งก้อน)
    #    ห้ามจำครึ่ง ๆ: ต้องคืน _RAW_SUBS และ _TRACE_ENG ให้เหมือนตอนคำนวณจริงทุกช่อง
    import copy as _cpc
    try:
        _ckf = (_file_sha1(inp), round(float(real_width_mm), 3), round(float(real_height_mm), 3),
                int(n_colors), float(_CUT_SMOOTH.get("mm", 0.0)))
        _hitf = _LFM_CACHE["map"].get(_ckf)
    except Exception:
        _ckf = None; _hitf = None
    if _hitf is not None:
        _RAW_SUBS["subs"] = _cpc.deepcopy(_hitf["raw_subs"])
        for _kk in ("mode", "rings_in", "rings_used", "rings_lost", "holes", "frame_dropped"):
            _TRACE_ENG[_kk] = _cpc.deepcopy(_hitf["trace"].get(_kk))
        return _hitf["full"]
    from shapely.ops import unary_union
    from shapely.affinity import scale as _scale
    from vectorcnc import trace_engine, vector_import
    if vector_import.is_vector_file(inp):
        # 🎯 เงาสำหรับ geometry: เรนเดอร์เวกเตอร์ที่ DPI สูง แล้ว trace ตาม 'ภาพจริง'
        #    (ไฟล์ AI ใช้สีขาวทาทับเป็น knockout บ่อย — geometry ล้วนอ่านสีไม่ได้ จะได้ก้อนตัน/เพี้ยน)
        #    เวกเตอร์คุม DPI ได้เอง -> 4000px = คมระดับผลิตจริง (±0.3 มม.)
        full = None
        # 🥇 เส้นทางที่ 1 (ดีที่สุด): ไฟล์เวกเตอร์ -> ดึง 'เส้นโค้งจริงในไฟล์' มาใช้เป็นเส้นตัดตรง ๆ
        #    (แบบเดียวกับที่ปุ่มแปลงเป็นเส้นตัดทำกับไฟล์ .ai — ไม่ trace เลย ตัวหนังสือเล็กจึงโค้งเนียน 100%)
        _file_subs = None; _file_ref = None
        try:
            _fp = vector_import.full_pieces_mm(inp, float(real_width_mm))
            _fs2 = []; _fx0 = _fy0 = 1e18; _fx1 = _fy1 = -1e18
            for _pc in (_fp or []):
                _pp0 = _pc.get("poly")
                if _pp0 is not None and not _pp0.is_empty and _pp0.area > 4.0:
                    _pb0 = _pp0.bounds                  # 📐 อ้างอิงตำแหน่งจาก 'เนื้องานที่มองเห็น' (ไม่รวม clip/เส้นซ่อน)
                    _fx0 = min(_fx0, _pb0[0]); _fy0 = min(_fy0, _pb0[1])
                    _fx1 = max(_fx1, _pb0[2]); _fy1 = max(_fy1, _pb0[3])
                for _sp in (_pc.get("subs") or []):
                    if _sp.get("segs"):
                        _fs2.append({"start": _sp["start"], "closed": _sp.get("closed", True), "segs": _sp["segs"]})
            if len(_fs2) >= 3 and _fx1 > _fx0 and _fy1 > _fy0:
                _file_subs = _fs2; _file_ref = (_fx0, _fy0, _fx1, _fy1)
        except Exception:
            _file_subs = None; _file_ref = None
        # 🎯 ============ ไฟล์เวกเตอร์: ใช้ 'เส้นในไฟล์' เป็นตัวหลักไปเลย ============
        #    ปุ่ม 'แปลงเป็นเส้นตัด' อ่านไฟล์ .ai/.pdf ตรง ๆ (ไม่ trace) แล้วได้เส้นครบทุกเส้นอยู่แล้ว
        #    เดิมตรงนี้กลับไปแรสเตอร์ + trace ก่อน แล้วค่อยมาเทียบว่าจะรับเส้นในไฟล์ไหม
        #    ทางอ้อมนั้นคือต้นเหตุทั้งหมด: แรสเตอร์กินดีเทลหาย (หมี/ก้นหอย/ตัวอักษรริม)
        #    แล้ว 'รูปที่ใช้จัดวาง' กับ 'เส้นที่วาด' ก็กลายเป็นคนละชุดจนงานล้นออกนอกแผ่น
        #    ตอนนี้เอาเส้นในไฟล์เป็นทั้ง 'รูป' และ 'เส้น' ชุดเดียวกัน = ได้แบบเดียวกับปุ่มเป๊ะ
        if _file_subs and _file_ref:
            try:
                _pl9 = [_piece_poly_with_holes(pc) for pc in (_fp or [])
                        if pc.get("poly") is not None and not pc["poly"].is_empty and pc["poly"].area > 4.0]
                _fu9 = unary_union(_pl9) if _pl9 else None
                if _fu9 is not None and not _fu9.is_empty:
                    _gb9 = _fu9.bounds
                    _sc9 = (_gb9[2] - _gb9[0]) / max(1e-6, (_file_ref[2] - _file_ref[0]))
                    _RAW_SUBS["subs"] = _subs_affine(_file_subs, _sc9,
                                                     _gb9[0] - _file_ref[0] * _sc9,
                                                     _gb9[1] - _file_ref[1] * _sc9)
                    _TRACE_ENG["mode"] = "file-vector"
                    _TRACE_ENG["rings_in"] = len(_file_subs)
                    _TRACE_ENG["rings_used"] = len(_file_subs)
                    _TRACE_ENG["holes"] = 0
                    full = _fu9
            except Exception:
                full = None
        # 🏆 สำรอง: อ่านเส้นในไฟล์ไม่สำเร็จ -> ค่อยแรสเตอร์ + trace (ของเดิม ไม่แตะ)
        try:
            if full is not None and not full.is_empty:
                raise _SkipFallback()
            import fitz as _fzv
            _dv = _fzv.open(inp); _pgv = _dv[0]
            # 🔍 7200px: เส้นขนแมวในโลโก้ (เช่น เกลียวเขาแพะ กว้าง ~0.08 มม.) ได้ 2-3 พิกเซล -> ไม่ขาดเป็นท่อน
            _zv = max(1.0, min(20.0, 7200.0 / max(1.0, _pgv.rect.width)))
            _pixv = _pgv.get_pixmap(matrix=_fzv.Matrix(_zv, _zv), alpha=False)
            _vpng = inp + ".vtrace.png"; _pixv.save(_vpng); _dv.close()
            _sv0 = _CUT_SMOOTH.get("mm", 0.0)
            _CUT_SMOOTH["mm"] = 0.0            # 📐 ต้นทางเป็นเวกเตอร์ -> ไม่มีคลื่นพิกเซล ไม่ต้องรีด (คงเส้นดิบไว้ใช้)
            try:
                full = _vtrace_full_mm(_vpng, float(real_width_mm))
            finally:
                _CUT_SMOOTH["mm"] = _sv0
        except _SkipFallback:
            pass                                   # ✅ ได้เส้นจากไฟล์แล้ว — ไม่ต้องแรสเตอร์
        except Exception:
            full = None
        try:
            if full is not None and not full.is_empty:
                raise _SkipFallback()                     # ✅ ได้ผลแล้ว -> ข้ามเส้นทางสำรอง (render+CCOMP)
            import fitz as _fz, cv2 as _cv, numpy as _np
            from shapely.geometry import Polygon as _Pg
            _d = _fz.open(inp); _pg0 = _d[0]
            _z = 8000.0 / max(1.0, _pg0.rect.width)      # 🔍 8000px (2 เท่าเดิม) — เส้นบาง/แยกชิ้นชัด ไม่ขาดเป็นช่วง
            _z = max(1.5, min(_z, 24.0))
            _pixhi = _pg0.get_pixmap(matrix=_fz.Matrix(_z, _z), alpha=False)
            _im = _np.frombuffer(_pixhi.samples, dtype=_np.uint8).reshape(_pixhi.height, _pixhi.width, _pixhi.n)
            _d.close()
            _gray = _cv.cvtColor(_im[:, :, :3], _cv.COLOR_RGB2GRAY)
            _mask = ((_gray < 165) * 255).astype(_np.uint8)   # เกณฑ์กลาง anti-alias -> เส้นคั่นบางไม่ละลายหาย
            # 🌳 CCOMP hierarchy = รองรับชิ้นซ้อนในรูกี่ชั้นก็ได้ (หัวแพะในรูวงหยัก ฯลฯ) — engine เดิมทิ้งชั้นใน
            _cnts, _hier = _cv.findContours(_mask, _cv.RETR_CCOMP, _cv.CHAIN_APPROX_NONE)
            _mmpp = float(real_width_mm) / max(1, _pixhi.width)
            _amin_px = max(8.0, 0.8 / (_mmpp * _mmpp))   # เกณฑ์เศษ = 0.8 ตร.มม. จริง (ไม่ผูกกับ DPI)

            def _ring_mm(_c):
                """contour px -> วงแหวน มม. เนียนแบบเวกเตอร์:
                   1) Gaussian วนปิดที่ความละเอียดเต็ม -> ลบรอยบันไดพิกเซล (σ~1.3px เล็กกว่าดีเทลจริงมาก)
                   2) ลดจุด -> fit Bézier (smooth_ring) -> sample กลับเป็นจุดถี่ ~0.25มม.
                   ⚠️ เดิมคืน dict ของ smooth_ring ตรงๆ -> Polygon ใช้ไม่ได้ -> ระบบหล่นไปใช้จุดพิกเซลดิบ = เส้นยึกยัก"""
                _arr = _c[:, 0, :].astype(float)
                if len(_arr) < 3:
                    return None
                if len(_arr) >= 11:
                    _k = 4; _sig = 1.3
                    _w = _np.exp(-0.5 * (_np.arange(-_k, _k + 1) / _sig) ** 2); _w = _w / _w.sum()
                    _xx = _np.convolve(_np.r_[_arr[-_k:, 0], _arr[:, 0], _arr[:_k, 0]], _w, 'valid')
                    _yy = _np.convolve(_np.r_[_arr[-_k:, 1], _arr[:, 1], _arr[:_k, 1]], _w, 'valid')
                    _arr = _np.c_[_xx, _yy]
                _st = max(1, len(_arr) // 1200); _arr = _arr[::_st]
                _pts = [(float(_x) * _mmpp, float(_y) * _mmpp) for _x, _y in _arr]
                if len(_pts) < 3:
                    return None
                try:
                    from vectorcnc import curvefit as _cf
                    _r = _cf.smooth_ring(_pts, err=0.10, corner_deg=26, dedup=0.02)
                    if _r and isinstance(_r, dict) and _r.get("segs"):
                        _out = [_r["start"]]; _c0 = _r["start"]
                        for _sg in _r["segs"]:
                            _p1, _p2, _p3 = _sg[1], _sg[2], _sg[3]
                            _ln = (_np.hypot(_p1[0] - _c0[0], _p1[1] - _c0[1]) + _np.hypot(_p2[0] - _p1[0], _p2[1] - _p1[1])
                                   + _np.hypot(_p3[0] - _p2[0], _p3[1] - _p2[1]))
                            _ns = max(6, min(48, int(_ln / 0.25) + 2))
                            for _ii in range(1, _ns + 1):
                                _t = _ii / _ns; _mt = 1.0 - _t
                                _out.append((_mt**3 * _c0[0] + 3 * _mt * _mt * _t * _p1[0] + 3 * _mt * _t * _t * _p2[0] + _t**3 * _p3[0],
                                             _mt**3 * _c0[1] + 3 * _mt * _mt * _t * _p1[1] + 3 * _mt * _t * _t * _p2[1] + _t**3 * _p3[1]))
                            _c0 = _p3
                        if len(_out) >= 4:
                            return _out
                except Exception:
                    pass
                return _pts

            _polys = []
            if _hier is not None:
                _hier = _hier[0]

                def _lvl(_i):
                    """ความลึกของวงในผังชั้น: 0 = ขอบนอก · 1 = รู · 2 = ชิ้นที่อยู่ในรู · 3 = รูของชิ้นนั้น"""
                    _d = 0; _p = _hier[_i][3]
                    while _p != -1 and _d < 64:
                        _d += 1; _p = _hier[_p][3]
                    return _d
                for _i, _c in enumerate(_cnts):
                    # 🐻 ============ เก็บ 'ชิ้นที่อยู่ในรู' ด้วย (parity: คู่ = เนื้อ · คี่ = รู) ============
                    #    เดิมเอาเฉพาะขอบนอกสุด (ชั้น 0) เท่านั้น -> อะไรที่ซ้อนลึกกว่านั้นถูกทิ้งหมด
                    #    โลโก้ After You: จานหยัก(0) -> วงในเป็นรู(1) -> ตัวหมีอยู่ในรู(2) -> ก้นหอยเป็นรูของหมี(3)
                    #    ชั้น 2 กับ 3 จึงหายเกลี้ยง = 'หมีหาย' และตัวหนังสือเล็กที่ซ้อนในกรอบก็หายด้วย
                    #    ซ้ำร้าย พอรูปไม่ครบ ตัวตรวจ 'เส้นโค้งจริงในไฟล์' เทียบไม่ผ่าน 90% เลยถูกปัดทิ้งตามไปอีก
                    if (_lvl(_i) % 2) == 1 or _cv.contourArea(_c) < _amin_px:
                        continue                          # ชั้นคี่ = รู (ถูกใส่เป็น hole ของแม่อยู่แล้ว)
                    _ext = _ring_mm(_c)
                    if not _ext:
                        continue
                    _holes = []
                    _j = _hier[_i][2]
                    while _j != -1:
                        if _cv.contourArea(_cnts[_j]) >= _amin_px:
                            _hh = _ring_mm(_cnts[_j])
                            if _hh:
                                _holes.append(_hh)
                        _j = _hier[_j][0]
                    _pg = _Pg(_ext, _holes).buffer(0)
                    if _pg is None or _pg.is_empty or _pg.area <= 3.0:
                        continue
                    if _pg.area < 12.0:                  # 🧹 เศษเส้นบางจิ๋ว (เกิดจากเส้นคั่นในแบบ) -> ทิ้ง
                        try:
                            if _pg.buffer(-0.18).is_empty:
                                continue
                        except Exception:
                            pass
                    _polys.append(_pg)
            if _polys:
                full = unary_union(_polys)
        except _SkipFallback:
            pass                                        # ✅ vtracer สำเร็จ — ใช้ผลนั้นเลย
        except Exception:
            full = None
        # 🥇 ถ้าอ่านเส้นจากไฟล์ได้ -> ใช้ 'เส้นในไฟล์' เป็นเส้นตัด (คมกว่า trace ทุกกรณี)
        #    จัดพิกัดให้ตรงกับรูปทรงที่ใช้คำนวณ (bbox เดียวกัน) แล้วแทนที่เส้นดิบของ vtracer
        if _file_subs and _file_ref and full is not None and not full.is_empty:
            try:
                _fb = _file_ref                          # ✅ ใช้กรอบ 'เนื้องานจริง' -> ทับกันสนิท ไม่เหลื่อม
                _gb = full.bounds
                _sc3 = (_gb[2] - _gb[0]) / max(1e-6, (_fb[2] - _fb[0]))
                _sc3y = (_gb[3] - _gb[1]) / max(1e-6, (_fb[3] - _fb[1]))
                if abs(_sc3y - _sc3) / max(1e-6, _sc3) < 0.03:          # สัดส่วนต้องตรงกัน
                    _cand = _subs_affine(_file_subs, _sc3,
                                         _gb[0] - _fb[0] * _sc3, _gb[1] - _fb[1] * _sc3)
                    # ✅ ตรวจ 'ทับกันจริงไหม' — สุ่มจุดบนเส้น เทียบกับรูปทรงที่เห็นจริง
                    #    (ไฟล์รวมชิ้น composed_vector.pdf มีเนื้อหานอกกรอบครอบซ่อนอยู่ -> ต้องไม่เอา ไม่งั้นได้ตัวซ้อนเหลื่อม)
                    from shapely.prepared import prep as _prep3
                    from shapely.geometry import Point as _Pt3
                    _tol3 = max(1.5, (_gb[2] - _gb[0]) * 0.004)
                    _pk = _prep3(full.buffer(_tol3))
                    _hit = 0; _tot = 0
                    for _sp in _cand[::max(1, len(_cand) // 120)]:
                        _an = [_sp["start"]] + [s[-1] for s in _sp["segs"]]
                        for _p3 in _an[::max(1, len(_an) // 6)]:
                            _tot += 1
                            if _pk.intersects(_Pt3(_p3[0], _p3[1])):
                                _hit += 1
                    _ratio = (_hit / float(_tot)) if _tot else 0.0
                    if _ratio >= 0.90:                                   # เส้นอยู่บนรูปจริง ≥90% -> ใช้ได้
                        _RAW_SUBS["subs"] = _cand
                        _TRACE_ENG["mode"] = "file-vector"
            except Exception:
                pass
        if full is None or full.is_empty:               # fallback: เส้นทางเวกเตอร์ตรง (แบบเดิม)
            pcs = vector_import.full_pieces_mm(inp, real_width_mm)
            pcs = [pc for pc in pcs if pc["poly"].area > 4.0]
            if not pcs:
                raise ValueError("อ่านเวกเตอร์ไม่ได้")
            full = unary_union([_piece_poly_with_holes(pc) for pc in pcs])
    else:
        # 🏆 เส้นทางหลัก (รูปภาพ): เอนจิ้นเดียวกับปุ่ม 'แปลงเป็นเส้นตัด' + ประกอบรูแบบ parity (ชิ้นในรูไม่หาย)
        full = None
        try:
            full = _vtrace_full_mm(inp, float(real_width_mm))
        except Exception:
            full = None
        if full is None or full.is_empty:
            pcs = None
            try:
                pcs = trace_engine.bezier_pieces_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
                pcs = [pc for pc in (pcs or []) if pc["poly"].area > 4.0]
            except Exception:
                pcs = None
            if pcs:
                full = unary_union([pc["poly"] for pc in pcs])
            else:
                polys = trace_engine.nest_shapes_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
                if not polys:
                    raise ValueError("แปลงภาพไม่พบรูปทรง")
                full = unary_union(polys)
    try:
        _rh = float(real_height_mm)
    except Exception:
        _rh = 0.0
    b = full.bounds
    ph = b[3] - b[1]
    if _rh > 1.0 and ph > 0.5 and abs(_rh - ph) > 0.15:
        full = _scale(full, xfact=1.0, yfact=_rh / ph, origin=(0, b[1]))
    if _ckf is not None:
        try:
            _cache_put(_LFM_CACHE, _ckf, {
                "full": full,                                   # shapely แก้ค่าในตัวไม่ได้ -> แชร์ได้
                "raw_subs": _cpc.deepcopy(_RAW_SUBS.get("subs")),
                "trace": {_kk: _cpc.deepcopy(_TRACE_ENG.get(_kk))
                          for _kk in ("mode", "rings_in", "rings_used", "rings_lost", "holes", "frame_dropped")}})
        except Exception:
            pass
    return full


def _mbuf(geom, d):
    """offset เส้นแบบ 'มุมฉาก' (mitre) — ไม่ปัดมุมมน · ลดจุดบนโค้ง (resolution ต่ำ) เพื่อเครื่องดัดไม่กรีดถี่
       🔒 ค่าเดิมของระบบ (mitre_limit 4.0 · resolution 12) — ห้ามแก้
          เคยลองลดเป็น 2.0/24 เพื่อกันหนามที่มุม แต่มันเปลี่ยนมุมของ 'ทุกประเภทป้าย' พร้อมกัน
          ตอนนี้จัดการหนาม/ห่วงที่ _fix_offset_geom แทน ซึ่งแตะเฉพาะชั้นที่ offset จริง ๆ"""
    if geom is None or geom.is_empty or abs(float(d)) < 1e-9:
        return geom
    return geom.buffer(float(d), join_style=2, mitre_limit=4.0, resolution=12)


def _clean_layer(geom, min_area_mm2=30.0, min_width_mm=1.8):
    """เก็บกวาดชั้นที่ 'หด' แล้วแตกเป็นเศษ (เช่น อะคริลิค −0.25 ซม. บนลายเส้นบาง)
       - ทิ้งชิ้นที่เล็กเกิน (เศษขยะในไฟล์ตัด)
       - ทิ้งชิ้นที่บางเกินจนตัดไม่ได้จริง
       คืน (geom_สะอาด, จำนวนเศษที่ทิ้ง)"""
    if geom is None or geom.is_empty:
        return geom, 0
    from shapely.ops import unary_union
    gs = list(geom.geoms) if getattr(geom, "geom_type", "") == "MultiPolygon" else [geom]
    keep, drop = [], 0
    r = float(min_width_mm) / 2.0
    for p in gs:
        if getattr(p, "geom_type", "") != "Polygon" or p.is_empty:
            continue
        if p.area < float(min_area_mm2):
            drop += 1
            continue
        try:                                   # บางเกิน -> กัดเข้าแล้วหายหมด
            if p.buffer(-r, join_style=2).is_empty:
                drop += 1
                continue
        except Exception:
            pass
        keep.append(p)
    if not keep:
        return geom, 0                         # ถ้าลบหมดก็คืนของเดิม (ปลอดภัยกว่า)
    return (unary_union(keep) if len(keep) > 1 else keep[0]), drop


def _poly_to_subs(geom, tol=0.04):
    """polygon/multipolygon -> list ของ bezier subs ทุกวง (นอก+รูใน)
       tol = ความคลาดเคลื่อนสูงสุด (มม.) — ตัวฟิต v2 ให้ทั้ง 'จุดน้อย' และ 'เนียน' พร้อมกัน
       (วงกลม R150: 9 เส้นโค้ง คลาดเคลื่อน 0.03 มม. · ของเดิม 93 เส้น คลาดเคลื่อน 0.69 มม.)"""
    from vectorcnc import bezier_vec
    subs = []
    if geom is None or geom.is_empty:
        return subs
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    for pg in polys:
        if pg.geom_type != "Polygon" or pg.is_empty:
            continue
        rings = [list(pg.exterior.coords)] + [list(h.coords) for h in pg.interiors]
        for ring in rings:
            if len(ring) < 4:
                continue
            # 🧹 กันวงเศษ/จุดซ้อน (contour จิ๋วผิดปกติ) เข้าไฟล์ตัด — เครื่องตัดจะเบิร์น/ค้างจุด
            _xs = [p[0] for p in ring]; _ys = [p[1] for p in ring]
            if (max(_xs) - min(_xs)) < 2.0 and (max(_ys) - min(_ys)) < 2.0:   # ก้อนจิ๋วทุกด้าน (เส้นเรียวยาวจริงยังผ่าน)
                continue
            try:
                sp = bezier_vec._fit_ring_to_sub(ring, tol=float(tol))
            except Exception:
                sp = None
            if sp:
                subs.append(sp)
    return subs


_FIXSTAT = {"chips": 0, "holes": 0}      # นับเศษ/รูจิ๋วที่เก็บกวาดออก (ไว้แจ้งผู้ใช้)
# 🔒 โหมดปลอดภัย = ปิดของใหม่ทั้งหมด กลับไปใช้เส้นทางเดิมของระบบเป๊ะ ๆ
#    (ไม่เกลาเส้น · ไม่กวาดเศษ · ไม่ใช้กลุ่มวัสดุ) — เปิดไว้เป็นค่าเริ่มต้น
_SAFE = {"on": False}


def _fix_offset_geom(geom, ref_w_mm=600.0, band_mm=0.0):
    if _SAFE["on"]:
        return geom                       # 🔒 โหมดปลอดภัย: ไม่แตะรูปเลย
    """🩹 เก็บงานรูปที่ได้จากการ offset (คิ้ว/แผ่นพื้น/อะคริลิคหด) ให้ 'เนียนกริบ พร้อมตัด'

    อาการที่แก้ (เกิดจากคณิตศาสตร์ของการขยาย-หดเส้น ไม่ใช่ความละเอียดของภาพ):
      1) เส้นตัดกันเอง / วนเป็นห่วงเล็ก ๆ ที่มุมแหลม (swallowtail) — เห็นเป็น 'หยดน้ำ' ตรงมุม
      2) หนามแหลมยาวจากการต่อมุมแบบ mitre ที่มุมแคบมาก
      3) วง/รูเศษจิ๋วที่เหลือค้าง เมื่อลายบางกว่า 2 เท่าของระยะ offset (เช่น วงกลมซ้อนวงกลมใน 'ณ')
      4) สะเก็ด/สลิเวอร์บางเฉียบที่เครื่องตัดเดินไม่ได้

    วิธี: buffer(0) แก้เส้นตัดกัน -> opening ลบหนาม/สลิเวอร์ -> closing ปิดรูเข็ม -> ทิ้งวงจิ๋ว
    ถ้าผลลัพธ์เพี้ยนเกิน 3% ของพื้นที่ -> คืนของเดิม (ปลอดภัยไว้ก่อน ห้ามรูปเปลี่ยน)
    """
    if geom is None or geom.is_empty:
        return geom
    from shapely.geometry import Polygon as _Pg7
    from shapely.ops import unary_union as _uu7
    W = max(50.0, float(ref_w_mm or 600.0))
    # ระยะเก็บงาน: ต้องเล็กพอที่ 'ตัวหนังสือเล็ก ๆ' จะไม่หาย แต่ใหญ่พอลบห่วง/หนามที่มุม (0.20–0.45 มม.)
    eps = max(0.20, min(0.45, W * 0.0006))
    if band_mm > 0:
        eps = min(eps, band_mm * 0.15)          # อย่าให้ใหญ่จนกินคิ้วบาง ๆ
    _wmin = 0.30                                # ครึ่งหนึ่งของความกว้างต่ำสุดที่ตัดจริงได้ (0.6 มม.)
    RJ = dict(join_style=1, resolution=16)                          # มุมมน = ไม่มีหนาม
    # 📌 กฎ: ห้ามกินชิ้นงานของลูกค้า — ใช้เกณฑ์ 'เครื่องตัดทำไม่ได้จริง' เท่านั้น
    #    เดิม 4.0 ตร.มม. (≈ ⌀2.3 มม.) ใหญ่เกินไป · จุด/รูเล็กในตัวอักษรจริงก็โดนกิน
    #    0.5 ตร.มม. ≈ ⌀0.8 มม. = เล็กกว่าลำเลเซอร์/ดอกกัดทุกตัว จึงเป็นเศษคำนวณแน่นอน
    _amin = 0.5                                                     # ตร.มม. เล็กกว่านี้ = เศษ ตัดจริงไม่ได้
    try:
        g = geom.buffer(0)                                          # 1) แก้เส้นตัดกันเอง (swallowtail)
        if g is None or g.is_empty:
            return geom
        out = []
        for p in (g.geoms if g.geom_type == "MultiPolygon" else [g]):
            if p.geom_type != "Polygon" or p.is_empty:
                continue
            # 2) ทิ้ง 'ชิ้นเศษ' — เล็กเกิน หรือบางกว่า 2·eps ทั้งชิ้น (หยดน้ำ/สะเก็ดจากการ offset)
            if p.area < _amin:
                _FIXSTAT["chips"] += 1
                continue
            try:
                if p.buffer(-_wmin, **RJ).is_empty:
                    _FIXSTAT["chips"] += 1
                    continue
            except Exception:
                pass
            # 3) ทิ้ง 'รูจิ๋ว' ในชิ้น (เช่น วงกลมซ้อนวงกลมใน ณ) — เก็บเฉพาะรูที่ตัดได้จริง
            holes = []
            for h in p.interiors:
                try:
                    hp = _Pg7(h)
                    if hp.area >= _amin and not hp.buffer(-_wmin, **RJ).is_empty:
                        holes.append(h)
                    else:
                        _FIXSTAT["holes"] += 1
                except Exception:
                    holes.append(h)
            q = _Pg7(p.exterior, holes).buffer(0)
            # 4) opening 'ทีละชิ้น' — ลบหนาม/ห่วงที่มุมแหลม · ทำทีละชิ้นจึงไม่มีทางเชื่อมชิ้นอื่นเข้าด้วยกัน
            #    ⚠️ ห้ามทำ closing รวม — มันจะดูดตัวอักษรที่อยู่ใกล้กันติดเป็นก้อนเดียว
            try:
                q2 = q.buffer(-eps, **RJ).buffer(eps, **RJ)
                if (q2 is not None and not q2.is_empty
                        and q2.geom_type in ("Polygon", "MultiPolygon")
                        and abs(q2.area - q.area) <= max(6.0, q.area * 0.06)):
                    q = q2
            except Exception:
                pass
            if q is not None and not q.is_empty:
                out.append(q)
        if not out:
            return geom.buffer(0)
        g2 = _uu7(out) if len(out) > 1 else out[0]
        # 4b) กวาดรอบสอง — opening อาจตัดคอคอดจนเกิด 'เศษใหม่' ขึ้นมาอีก ต้องเก็บให้เกลี้ยง
        try:
            _f2 = [p for p in (g2.geoms if g2.geom_type == "MultiPolygon" else [g2])
                   if p.geom_type == "Polygon" and not p.is_empty and p.area >= _amin
                   and not p.buffer(-_wmin, **RJ).is_empty]
            if _f2:
                g2 = _uu7(_f2) if len(_f2) > 1 else _f2[0]
        except Exception:
            pass
        # 5) กันพลาด: พื้นที่ต้องเปลี่ยนน้อยมาก (รูปทรงจริงห้ามเพี้ยน)
        #    หมายเหตุ: 'จำนวนชิ้นเพิ่ม' เป็นเรื่องปกติ — คอคอดที่บางกว่าดอกกัดจะถูกตัดขาดตามความจริง
        if g2 is None or g2.is_empty or abs(g2.area - geom.area) > max(25.0, geom.area * 0.02):
            return geom.buffer(0)
        return g2
    except Exception:
        try:
            return geom.buffer(0)
        except Exception:
            return geom


_RASTER_SRC = {"path": None, "w_mm": 0.0}     # ภาพต้นทาง + ขนาดจริง (ไว้ทำ offset แบบเดียวกับปุ่มแปลง)


def _offset_subs_like_button(off_mm):
    """🥇 ทำชั้นขยาย/หด 'ด้วยวิธีเดียวกับปุ่มแปลงเป็นเส้นตัด' เป๊ะ ๆ

    หลักการที่พี่ชี้: ปุ่มแปลงคมเพราะ potrace อ่าน 'ภาพ' แล้วให้เส้นโค้งเนียนมาเลย
    ดังนั้นชั้นคิ้ว/แผ่นพื้น/อะคริลิค ก็ควรทำแบบเดียวกัน:
        ขยาย/หด 'ที่ตัวภาพ' (dilate/erode) -> ส่งเข้า potrace -> ได้เส้นโค้งเนียนเท่าปุ่ม
    แทนที่จะไปขยายรูปทรงเรขาคณิตแล้วฟิตโค้งใหม่ (ซึ่งทำให้เส้นโย้)
    คืน list ของ subs (มม.) หรือ None ถ้าทำไม่ได้
    """
    import os as _os9, tempfile as _tf9
    try:
        import cv2 as _cv9, numpy as _np9
        from vectorcnc import trace_engine as _te9
        _src = _RASTER_SRC.get("path"); _wmm = float(_RASTER_SRC.get("w_mm") or 0)
        if not _src or not _os9.path.exists(_src) or _wmm <= 0:
            return None
        _im = _cv9.imdecode(_np9.fromfile(_src, dtype=_np9.uint8), _cv9.IMREAD_COLOR)
        if _im is None:
            return None
        _g = _cv9.cvtColor(_im, _cv9.COLOR_BGR2GRAY)
        # ขยายภาพให้ด้านยาว ~3000px ก่อน (ยิ่งละเอียด ขอบยิ่งเนียน · ตรงกับที่ปุ่มทำ)
        _L = max(_g.shape[:2]); _TG = 3000.0
        if _L < _TG:
            _s = _TG / float(_L)
            _g = _cv9.resize(_g, None, fx=_s, fy=_s, interpolation=_cv9.INTER_CUBIC)
        _bd = _np9.concatenate([_g[0], _g[-1], _g[:, 0], _g[:, -1]])
        _bg = float(_np9.median(_bd))
        _m = ((_g < max(40.0, _bg - 45.0)) if _bg >= 128 else (_g > min(215.0, _bg + 45.0)))
        _m = (_m.astype(_np9.uint8) * 255)
        _ppm = _g.shape[1] / _wmm                       # พิกเซลต่อมิลลิเมตร
        _r = int(round(abs(float(off_mm)) * _ppm))
        if _r >= 1:
            _k = _cv9.getStructuringElement(_cv9.MORPH_ELLIPSE, (_r * 2 + 1, _r * 2 + 1))
            _m = _cv9.dilate(_m, _k) if float(off_mm) > 0 else _cv9.erode(_m, _k)
        if not _m.any():
            return None
        _pad = max(4, _r + 4)
        _m = _cv9.copyMakeBorder(_m, _pad, _pad, _pad, _pad, _cv9.BORDER_CONSTANT, value=0)
        # 🧹 ลบไฟล์ชั่วคราวทิ้งเสมอ (ดิสก์เซิร์ฟเวอร์เต็ม = worker ตาย = ต่อ backend ไม่ได้)
        _it = None
        with _tf9.TemporaryDirectory(prefix="vcnc_offb_") as _dir9:
            _tmp = _os9.path.join(_dir9, "off.png")
            _cv9.imwrite(_tmp, 255 - _m)                # วัตถุ = ดำ · พื้น = ขาว (เหมือนภาพงานปกติ)
            del _m, _g
            try:
                _it = _te9.trace_potrace(_tmp, n_colors=2)
            except Exception:
                _it = None
        if not _it:
            return None
        _subs = []
        for _c9, _ss in _it:
            _subs.extend(_ss)
        if not _subs:
            return None
        return _subs                                    # (พิกัดพิกเซล — ผู้เรียกจัดตำแหน่งเอง)
    except Exception:
        return None


def _offset_subs_from_geom(geom, off_mm, px_per_mm=5.0):
    """🥈 วิธีเดียวกับ _offset_subs_like_button แต่ 'เริ่มจากรูปทรง' แทนภาพต้นฉบับ

    ใช้ตอนที่ชั้นนั้นไม่ได้กินพื้นที่ทั้งภาพ — เช่น ป้ายที่แยกวัสดุหลายกลุ่ม
    (กลุ่ม A = ตัวหลัก · กลุ่ม B = "ร้านผลไม้" พลาสวูด) ซึ่งใช้ภาพต้นฉบับทั้งใบไม่ได้
    เพราะจะได้เส้นของ 'ทุกชิ้น' มาปนกัน

    วาดรูปทรงลงภาพขาวดำละเอียด -> dilate/erode ตามระยะ offset -> potrace
    ได้เส้นโค้งเนียนแบบเดียวกับปุ่มแปลงเป็นเส้นตัด แทนการ buffer แล้วฟิตโค้งใหม่ (ซึ่งโย้)
    คืน subs พิกัดพิกเซล (ผู้เรียกใช้ _fit_subs_to จัดตำแหน่งต่อ) หรือ None
    """
    import os as _o8, tempfile as _t8
    try:
        if geom is None or geom.is_empty:
            return None
        import cv2 as _cv8, numpy as _np8
        from vectorcnc import trace_engine as _te8
        _b8 = geom.bounds
        _w8 = _b8[2] - _b8[0]; _h8 = _b8[3] - _b8[1]
        if _w8 <= 0 or _h8 <= 0:
            return None
        # ความละเอียด: 5 px/มม. = ละเอียด 0.2 มม. ซึ่งเกินพอสำหรับงานป้าย
        #    (potrace ฟิตเส้นโค้งระดับต่ำกว่าพิกเซลอยู่แล้ว) · คุมด้านยาวไม่เกิน 3000 px
        #    ⚠️ อย่าดันเลข 2 ตัวนี้ขึ้นโดยไม่จับเวลา — งานตัดแยกทีละตัวเรียกฟังก์ชันนี้
        #    หลายสิบครั้งต่อหนึ่งงาน ต้นทุนคูณกันทันที
        _ppm = float(px_per_mm)
        _ppm = min(_ppm, 3000.0 / max(_w8, _h8))
        if _ppm < 1.5:
            return None
        _pad = int(round(abs(float(off_mm)) * _ppm)) + 6
        _W8 = int(round(_w8 * _ppm)) + _pad * 2
        _H8 = int(round(_h8 * _ppm)) + _pad * 2
        if _W8 < 8 or _H8 < 8 or _W8 * _H8 > 60_000_000:
            return None
        _m8 = _np8.zeros((_H8, _W8), _np8.uint8)

        def _ring(cs):
            a = _np8.asarray(cs, dtype=_np8.float64)
            a[:, 0] = (a[:, 0] - _b8[0]) * _ppm + _pad
            # ⚠️ ห้ามพลิกแกน Y — พิกัดงานในระบบนี้มาจาก potrace อยู่แล้ว (Y ชี้ลงเหมือนภาพ)
            #    ถ้าพลิก เส้นที่ได้จะกลับหัว แล้ว _fit_subs_to จะวางทับผิดที่ทั้งชั้น
            a[:, 1] = (a[:, 1] - _b8[1]) * _ppm + _pad
            return _np8.round(a).astype(_np8.int32)

        for _pg in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom]):
            if _pg.geom_type != "Polygon" or _pg.is_empty:
                continue
            _cv8.fillPoly(_m8, [_ring(_pg.exterior.coords)], 255)
            for _in in _pg.interiors:                      # รูใน (เช่น รูตัว อ) ต้องเจาะจริง
                _cv8.fillPoly(_m8, [_ring(_in.coords)], 0)
        if not _m8.any():
            return None
        _r8 = int(round(abs(float(off_mm)) * _ppm))
        if _r8 >= 1:
            _k8 = _cv8.getStructuringElement(_cv8.MORPH_ELLIPSE, (_r8 * 2 + 1, _r8 * 2 + 1))
            _m8 = _cv8.dilate(_m8, _k8) if float(off_mm) > 0 else _cv8.erode(_m8, _k8)
        if not _m8.any():
            return None
        # 🧹 ไฟล์ชั่วคราวต้องลบทิ้งเสมอ — งานตัดแยกทีละตัวเรียกฟังก์ชันนี้หลายสิบครั้ง/งาน
        #    ถ้าปล่อยค้างไว้ ดิสก์ของเซิร์ฟเวอร์จะเต็มแล้ว worker ตาย -> หน้าเว็บขึ้น "Failed to fetch"
        with _t8.TemporaryDirectory(prefix="vcnc_off_") as _dir8:
            _tmp8 = _o8.path.join(_dir8, "offg.png")
            _cv8.imwrite(_tmp8, 255 - _m8)                 # วัตถุ = ดำ · พื้น = ขาว
            del _m8                                        # คืนแรมของภาพก่อนเข้า potrace
            try:
                _it8 = _te8.trace_potrace(_tmp8, n_colors=2)
            except Exception:
                _it8 = None
        if not _it8:
            return None
        _subs8 = []
        for _c8, _ss8 in _it8:
            _subs8.extend(_ss8)
        return _subs8 or None
    except Exception:
        return None


# 📊 นับชิ้นที่ได้เส้น 'คมกริบ' vs ที่ด่านตรวจตีกลับ + ⏱️ งบเวลาของงานนี้
#    ⚠️ การขยายที่ภาพ + potrace กินเวลา/แรมมาก (ป้าย 8 ตัวอักษร ~8 วินาที)
#    ถ้าป้ายซับซ้อนหรือมีหลายกลุ่มวัสดุ อาจใช้เวลาจนเซิร์ฟเวอร์ตัดสาย (502/504)
#    -> ตั้งงบเวลาไว้ พอหมดงบให้ถอยไปใช้วิธีเดิมทันที 'ได้ไฟล์ช้ากว่าไม่ได้ไฟล์เลย'
_SHARPSTAT = {"ok": 0, "reject": 0, "skip": 0, "t0": 0.0, "budget": 8.0,
              "calls": 0, "max_calls": 48}
# 📏 ขนาดจริงของ logo ที่วางลงหน้ากล่องแบบพิมพ์ (ตัววาดภาพ 3 มิติคำนวณแล้วเขียนกลับมาให้)
_ARTFIT = {"w_mm": 0.0, "h_mm": 0.0}


def _subs_probe(subs, n=10):
    """สุ่มจุดตลอด 'เส้นโค้งจริง' (ไม่ใช่แค่ปลายเส้น) — ใช้ตรวจสอบเส้นตัด"""
    import numpy as _np
    _o = []
    for _s in subs or []:
        _cur = _s.get("start")
        if _cur is None:
            continue
        _o.append(tuple(_cur))
        for _t in _s.get("segs", []):
            if len(_t) == 3:
                _p1, _p2, _p3 = _t
                for _i in range(1, n + 1):
                    _u = _i / float(n); _v = 1.0 - _u
                    _o.append((_v ** 3 * _cur[0] + 3 * _v * _v * _u * _p1[0] + 3 * _v * _u * _u * _p2[0] + _u ** 3 * _p3[0],
                               _v ** 3 * _cur[1] + 3 * _v * _v * _u * _p1[1] + 3 * _v * _u * _u * _p2[1] + _u ** 3 * _p3[1]))
                _cur = _p3
            else:
                _o.append(tuple(_t[-1])); _cur = _t[-1]
    return _np.asarray(_o) if _o else None


def _sharp_offset(seed_geom, off_mm, target_geom):
    """🥇 เส้นตัดคมกริบของชั้นที่ 'ขยาย/หด' — ทำแบบเดียวกับปุ่มแปลงเป็นเส้นตัด
       (ขยายที่ภาพ -> potrace) แล้ว **ตรวจสอบก่อนใช้จริง**

    ⚠️ กฎเหล็ก: ถ้าเส้นที่ได้ไม่ทับรูปทรงเป้าหมาย (สเกล/ตำแหน่งเพี้ยน) ต้องคืน None
       ให้ผู้เรียกถอยไปใช้วิธีเดิม — 'ห้ามส่งเส้นที่ยังพิสูจน์ไม่ได้ออกไปเป็นไฟล์ตัด'
    """
    try:
        if target_geom is None or target_geom.is_empty:
            return None
        # ⏱️ หมดงบเวลา หรือเรียกครบเพดานแล้ว -> ถอยทันที
        #    ไม่งั้นป้ายที่มีตัวอักษรเยอะจะทำให้เซิร์ฟเวอร์ตาย แล้วผู้ใช้ไม่ได้ไฟล์เลยสักไฟล์
        import time as _tm
        if (_SHARPSTAT.get("calls", 0) >= _SHARPSTAT.get("max_calls", 48)
                or (_SHARPSTAT.get("t0")
                    and (_tm.time() - _SHARPSTAT["t0"]) > _SHARPSTAT.get("budget", 8.0))):
            _SHARPSTAT["skip"] = _SHARPSTAT.get("skip", 0) + 1
            return None
        _SHARPSTAT["calls"] = _SHARPSTAT.get("calls", 0) + 1
        _raw = _offset_subs_from_geom(seed_geom, off_mm)
        if not _raw:
            return None
        _fit = _fit_subs_to(_raw, target_geom)
        if not _fit:
            return None
        _p = _subs_probe(_fit)
        if _p is None or len(_p) < 8:
            return None
        _tb = target_geom.bounds
        _bw = _tb[2] - _tb[0]; _bh = _tb[3] - _tb[1]
        if _bw <= 0 or _bh <= 0:
            return None
        # 1) กรอบต้องตรง — คลาดได้ไม่เกิน 0.4% ของด้าน (หรือ 0.5 มม.)
        _tol = max(0.5, min(_bw, _bh) * 0.004)
        if (abs(_p[:, 0].min() - _tb[0]) > _tol or abs(_p[:, 0].max() - _tb[2]) > _tol
                or abs(_p[:, 1].min() - _tb[1]) > _tol or abs(_p[:, 1].max() - _tb[3]) > _tol):
            return None
        # 2) เส้นต้องเกาะขอบรูปทรงเป้าหมายจริง
        #    วัดที่เปอร์เซ็นไทล์ 98 ไม่ใช่ค่าสูงสุด — เพราะ 'มุม' ของสองวิธีต่างกันโดยธรรมชาติ
        #    (ขยายที่ภาพ = มุมมน · buffer = มุมแหลม) ซึ่งเป็นจุดส่วนน้อยและไม่ใช่ความผิดพลาด
        import numpy as _np2
        from shapely.geometry import Point as _Pt2
        _bd = target_geom.boundary
        _step = max(1, len(_p) // 400)                    # สุ่มพอประมาณ ไม่ถ่วงเวลา
        _d = _np2.asarray([_bd.distance(_Pt2(float(_q[0]), float(_q[1]))) for _q in _p[::_step]])
        if len(_d) < 8:
            return None
        if float(_np2.percentile(_d, 98)) > max(0.6, min(_bw, _bh) * 0.006):
            _SHARPSTAT["reject"] = _SHARPSTAT.get("reject", 0) + 1
            return None
        _SHARPSTAT["ok"] = _SHARPSTAT.get("ok", 0) + 1
        return _fit
    except Exception:
        return None


def _fit_subs_to(subs, target_geom):
    """จัดเส้นที่ได้จากภาพ ให้ทับ 'ตำแหน่ง+ขนาดจริง' ของชั้นนั้นเป๊ะ (สเกลเท่ากันทั้ง 2 แกน)"""
    if not subs or target_geom is None or target_geom.is_empty:
        return None
    _x0 = _y0 = 1e18; _x1 = _y1 = -1e18
    for s in subs:
        for p in [s["start"]] + [t[-1] for t in s["segs"]]:
            _x0 = min(_x0, p[0]); _y0 = min(_y0, p[1])
            _x1 = max(_x1, p[0]); _y1 = max(_y1, p[1])
    if _x1 <= _x0 or _y1 <= _y0:
        return None
    b = target_geom.bounds
    sx = (b[2] - b[0]) / (_x1 - _x0); sy = (b[3] - b[1]) / (_y1 - _y0)
    if abs(sy - sx) / max(1e-6, sx) > 0.05:            # สัดส่วนเพี้ยน -> ไม่ใช้ (กันรูปบิด)
        return None
    # 📐 ยึด 'แกนกว้าง' เป็นหลัก — ความกว้างต้องตรงเป๊ะกับที่ผู้ใช้กำหนดเสมอ
    #    (เฉลี่ย 2 แกนจะทำให้กว้างคลาดไป 1–2 มม.)
    s0 = sx
    # จัดกึ่งกลางแนวตั้งให้กรอบพอดี (ส่วนต่างแนวตั้งน้อยมาก < 0.3%)
    _ty = b[1] - _y0 * s0 + ((b[3] - b[1]) - (_y1 - _y0) * s0) / 2.0
    return _subs_affine(subs, s0, b[0] - _x0 * s0, _ty)


def _cut_subs_offset(geom, ref_w_mm=600.0, clean=True):
    if _SAFE["on"]:
        return _poly_to_subs(geom, tol=0.04)   # 🔒 โหมดปลอดภัย: เส้นเดิมของระบบ 100%
    """✂️ เส้นตัดของ 'ชั้นที่ขยาย/หดจากรูปต้น' (คิ้ว · แผ่นพื้น · อะคริลิคหด)

    ปัญหาเดิม: รูปต้นถูก sample เป็นจุดถี่ ~0.5 มม. → shapely.buffer คำนวณ normal
    ทีละท่อนสั้น ๆ ได้ขอบเป็น 'ขั้นบันไดจิ๋ว' → ตัวฟิตโค้ง tol 0.04 มม. ไล่ตามขั้นบันได
    เป๊ะ ๆ เลยได้เส้นจุดเยอะ ยึกยัก (ต่างจากชั้น off=0 ที่ใช้เส้นโค้งดิบจากเอนจิ้นตรง ๆ)

    วิธีแก้: รีดคลื่นระดับต่ำกว่าความละเอียดเครื่องออกก่อน แล้วฟิตโค้งด้วย tol ที่
    สมมาตรกับขนาดงานจริง → เส้นเนียน จุดน้อย แต่ยังอยู่ในพิกัดความเผื่อ (< 0.25 มม.)
    ถ้ารีดแล้วรูปเพี้ยน/หาย → ถอยกลับไปใช้เส้นเดิมทันที (ห้ามเส้นหาย)"""
    if geom is None or geom.is_empty:
        return []
    W = max(50.0, float(ref_w_mm or 600.0))
    # 🎯 คมที่สุด: รีดเบา + ฟิตโค้งละเอียด (เกาะรูปแม่นระดับ 0.10 มม. — เครื่องตัดเดินได้ลื่น)
    r = max(0.18, min(0.42, W * 0.0005))      # แรงรีดคลื่น (มม.)
    tol = max(0.04, min(0.12, W * 0.00014))   # ความคลาดเคลื่อนตอนฟิตโค้ง (มม.)
    # 🧮 รูปที่ 'สร้างเอง' (สี่เหลี่ยม/ขาตั้ง/กล่องเรขาคณิต) จุดน้อยอยู่แล้ว -> ส่งออกตรง ๆ คมกว่า
    try:
        _npt = sum(len(p.exterior.coords) + sum(len(h.coords) for h in p.interiors)
                   for p in (geom.geoms if geom.geom_type == "MultiPolygon" else [geom])
                   if p.geom_type == "Polygon")
        if _npt <= 64:
            return _poly_to_subs(geom, tol=0.02)
    except Exception:
        pass
    # 📐 รูปทรง 'เส้นตรงล้วน' (กรอบคิ้วสี่เหลี่ยม · แถบขอบข้าง · ขาตั้ง) ห้ามเอาไปฟิตเป็นเส้นโค้ง
    #    เดิมเช็คแค่ 'จำนวนจุดดิบ' — แต่ buffer โปรยจุดถี่ไว้บนเส้นตรงจนเกิน 64 จุด
    #    กรอบสี่เหลี่ยมเลยหลุดไปเข้าตัวฟิตโค้ง แล้วออกมาเป็นเส้นโย้ (วัดได้เบี้ยว 10-18 มม.)
    #    ✅ วิธีที่ถูก: ลดจุดที่อยู่บนเส้นตรงเดียวกันทิ้งก่อน ถ้าเหลือจุดน้อย + พื้นที่ไม่เปลี่ยน
    #       = เป็นรูปเรขาคณิตแน่นอน -> ส่งเส้นตรงออกไปตรง ๆ คมกริบ 100%
    #    ⚠️ บทเรียน 2 ข้อจากการวัดจริง:
    #       1) 'พื้นที่ไม่เปลี่ยน' ใช้ไม่ได้ — มุมที่ถูกตัดกับที่ถูกเติมหักล้างกัน
    #          พื้นที่เท่าเดิมทั้งที่รูปเพี้ยน 4.79 มม.
    #       2) hausdorff_distance ของ shapely วัดจาก 'จุดยอด' เท่านั้น จุดของรูปที่ลดแล้ว
    #          อยู่บนรูปเดิมอยู่แล้วเสมอ จึงได้ค่าต่ำหลอกตา (0.039 มม. ทั้งที่เพี้ยน 4.79 มม.)
    #    ✅ วิธีที่ใช้จริง: ลดจุดด้วยค่าเผื่อจิ๋ว 0.005 มม.
    #       เส้นตรงแท้ ๆ จุดอยู่บนเส้นเดียวกันเป๊ะ -> ลดได้หมดแม้ค่าเผื่อจิ๋ว
    #       ส่วนโค้งของตัวอักษร -> ลดแทบไม่ได้ จึงไม่มีทางหลุดเข้ามา
    try:
        _sm0 = geom.simplify(0.005, preserve_topology=True)
        if _sm0 is not None and not _sm0.is_empty and geom.area > 0:
            _n2 = sum(len(p.exterior.coords) + sum(len(h.coords) for h in p.interiors)
                      for p in (_sm0.geoms if _sm0.geom_type == "MultiPolygon" else [_sm0])
                      if p.geom_type == "Polygon")
            # พื้นที่ที่ 'ไม่ทับกัน' ระหว่างรูปเดิมกับรูปที่ลดจุด ต้องแทบเป็นศูนย์
            _dif = geom.symmetric_difference(_sm0).area
            if _n2 <= 64 and _dif <= geom.area * 0.00002:
                return _poly_to_subs(_sm0, tol=0.02)
    except Exception:
        pass
    # 🔒 ชั้นที่ 'ตัดตามรูปตรง ๆ' (off = 0 · งานพิมพ์ · สติ๊กเกอร์) = ส่งเส้นต้นฉบับออกไปเลย
    #    ห้ามรีด ห้ามเกลา ห้ามลบชิ้น — ไม่งั้นตัวอักษรจะโดนกัดมุมจนแหว่ง
    if not clean:
        try:
            return _poly_to_subs(geom.buffer(0), tol=0.04)
        except Exception:
            return _poly_to_subs(geom, tol=0.04)
    # 🩹 ชั้นที่ขยาย/หด: แก้ห่วง/หนาม/วงเศษ (ของที่ 'เกิดใหม่' จากการ offset เท่านั้น) แล้วฟิตโค้ง
    geom = _fix_offset_geom(geom, W)
    base = _poly_to_subs(geom, tol=0.04)      # เส้นแบบเดิม (ไว้เทียบ/ถอยกลับ)
    try:
        g2 = _smooth_cut(geom, r)
        if g2 is None or g2.is_empty:
            return base
        # 🛡️ ตรวจว่า 'ไม่เพี้ยน/ไม่หาย': พื้นที่ต้องใกล้เดิม และจำนวนชิ้นต้องเท่าเดิม
        _n1 = len(geom.geoms) if geom.geom_type == "MultiPolygon" else 1
        _n2 = len(g2.geoms) if g2.geom_type == "MultiPolygon" else 1
        if _n2 < _n1 or abs(g2.area - geom.area) > max(20.0, geom.area * 0.02):
            return base
        subs = _poly_to_subs(g2, tol=tol)
        # 🛡️ ชั้นที่ตัดตามรูปตรง ๆ (clean=False) ห้ามวงหายแม้แต่วงเดียว · ชั้น offset ยอมได้ ≤10%
        if not subs or len(subs) < (len(base) if not clean else len(base) * 0.9):
            return base
        return subs
    except Exception:
        return base


def _spec_sheet_svg(out_layers):
    """สเปคชีต: วางแต่ละชั้น 'แยกกัน' แนวนอน + เส้นจับขนาด กว้าง×สูง (นอกชิ้น) + ชื่อชั้น/ค่าเผื่อ"""
    from vectorcnc import nesting

    def _esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def _bbox(subs):
        mnx = mny = 1e18; mxx = mxy = -1e18
        for sp in subs:
            pts = [sp["start"]]
            for s in sp["segs"]:
                pts.append(s[1]) if s[0] == "L" else pts.extend([s[1], s[2], s[3]])
            for (x, y) in pts:
                mnx = min(mnx, x); mny = min(mny, y); mxx = max(mxx, x); mxy = max(mxy, y)
        return mnx, mny, mxx, mxy

    metas = []; Smax = 1.0
    for L in out_layers:
        b = _bbox(L["subs"]); w = b[2] - b[0]; h = b[3] - b[1]
        metas.append({"L": L, "b": b, "w": w, "h": h}); Smax = max(Smax, w, h)
    fs = max(6.0, Smax * 0.028)
    dimL = fs * 3.6; dimB = fs * 3.2; titleH = fs * 3.0; gapY = fs * 3.8
    lw = max(0.6, Smax * 0.0022); aw = fs * 0.55; cd = "#dc2626"
    maxW = max(m["w"] for m in metas)
    parts = []; cursor = fs * 0.6
    for mi, m in enumerate(metas):
        L = m["L"]; b = m["b"]; w = m["w"]; h = m["h"]
        px = dimL; py = cursor + titleH; dx = px - b[0]; dy = py - b[1]   # วางเรียงบน->ล่าง (แนวตั้ง)

        def T(p, _dx=dx, _dy=dy):
            return (p[0] + _dx, p[1] + _dy)
        # เส้นคั่นบางๆ ระหว่างชั้น
        if mi > 0:
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#e2e8f0" stroke-width="%.2f"/>' % (0, cursor - gapY * 0.45, dimL + maxW + fs, cursor - gapY * 0.45, lw))
        parts.append('<g fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round">' % (L["color"], lw))
        for sp in L["subs"]:
            nsp = {"start": T(sp["start"]),
                   "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                   "closed": sp.get("closed", True)}
            parts.append('<path d="%s"/>' % nesting._sp_d(nsp))
        parts.append('</g>')
        off = L["off"]; oc = "full" if abs(off) < 1e-6 else ("%+.2f cm" % (off / 10.0))
        parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s"/>' % (px + fs * 0.4, py - titleH * 0.5, fs * 0.5, L["color"]))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">%s (%s)</text>'
                     % (px + fs * 1.3, py - titleH * 0.35, fs * 1.15, L["color"], _esc(_en_layer(L["name"])), oc))
        # เส้นสูง (ซ้าย)
        xh = px - fs * 1.3; y0 = py; y1 = py + h
        parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xh, y0, xh, y1, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y0 + aw, xh, y0, xh + aw * 0.6, y0 + aw, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y1 - aw, xh, y1, xh + aw * 0.6, y1 - aw, cd, lw))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f cm</text>'
                     % (xh - fs * 0.55, (y0 + y1) / 2, fs * 0.9, cd, xh - fs * 0.55, (y0 + y1) / 2, h / 10.0))
        # เส้นกว้าง (ล่าง)
        yw = py + h + fs * 1.3; xx0 = px; xx1 = px + w
        parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xx0, yw, xx1, yw, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx0 + aw, yw - aw * 0.6, xx0, yw, xx0 + aw, yw + aw * 0.6, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx1 - aw, yw - aw * 0.6, xx1, yw, xx1 - aw, yw + aw * 0.6, cd, lw))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle">%.1f cm</text>'
                     % ((xx0 + xx1) / 2, yw + fs * 1.1, fs * 0.9, cd, w / 10.0))
        cursor = py + h + dimB + gapY
    Wt = dimL + maxW + fs * 2.0; Ht = cursor
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    svg += parts; svg.append('</svg>')
    return '\n'.join(svg)


def _art_data_uri(path, max_px=1400):
    """crop รูปงานให้เหลือเฉพาะตัวงาน (ตัดพื้นขาว/โปร่ง) -> data URI (PNG) ไว้แปะบนหน้า 3 มิติ"""
    # ⚡ งานหนัก (เรนเดอร์+ครอป+ย่อ+encode หลายวินาที) แต่ไฟล์เดิม+ความละเอียดเดิม = ผลเดิมเป๊ะ
    try:
        _ck9 = (_file_sha1(path), int(max_px))
        _hit9 = _ARTURI_CACHE["map"].get(_ck9)
        if _hit9 is not None:
            return _hit9
    except Exception:
        _ck9 = None
    from PIL import Image
    import io as _io, base64 as _b64, numpy as _np
    # 🖼️ ไฟล์เวกเตอร์ (.ai/.pdf/.eps/.svg) เปิดด้วย PIL ตรง ๆ ไม่ได้ -> เดิมจะ error เงียบ ๆ
    #    ผลคือกล่องไฟแบบ 'พิมพ์หน้า' ได้หน้าเปล่า งานออกแบบไม่เข้าไปในกล่องเลย
    #    -> เรนเดอร์หน้าแรกเป็นภาพก่อน แล้วค่อยครอป/ย่อเหมือนเดิม
    _src = path
    try:
        from vectorcnc import vector_import as _vi9
        if _vi9.is_vector_file(path):
            import fitz as _fz9
            _d9 = _fz9.open(path); _p9 = _d9[0]
            _z9 = max(1.0, min(8.0, float(max_px) * 1.6 / max(1.0, _p9.rect.width)))
            _pm9 = _p9.get_pixmap(matrix=_fz9.Matrix(_z9, _z9), alpha=True)
            _src = _io.BytesIO(_pm9.tobytes("png")); _d9.close()
    except Exception:
        _src = path
    im = Image.open(_src).convert("RGBA")
    a = _np.asarray(im)
    rgb = a[:, :, :3]; alpha = a[:, :, 3]
    mask = ((rgb.min(axis=2) < 245) | (alpha < 250)) & (alpha > 12)   # ไม่ใช่ขาว/ไม่โปร่ง
    ys, xs = _np.where(mask)
    if len(xs) and len(ys):
        im = im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    if max(im.size) > max_px:
        sc = max_px / float(max(im.size))
        im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
    buf = _io.BytesIO(); im.save(buf, "PNG")
    _uri9 = "data:image/png;base64," + _b64.b64encode(buf.getvalue()).decode()
    if _ck9 is not None:
        _cache_put(_ARTURI_CACHE, _ck9, _uri9)
    return _uri9


# 🪙 พื้นผิวสแตนเลส (gradient เมทัลลิก): (สีอ่อน, สีกลาง, สีเข้ม, แฮร์ไลน์?)
_METAL_TEX = {
    "silver_mirror":   ("#f4f7fa", "#c7cfd9", "#8d97a4", False),
    "silver_hairline": ("#e4e9ee", "#c9d1d9", "#a4adb8", True),
    "gold_mirror":     ("#fbe9a6", "#dcb44e", "#a57b1f", False),
    "gold_hairline":   ("#f0d78b", "#d6b254", "#b08a30", True),
    "rose_mirror":     ("#f8d3bd", "#e2a586", "#b97c5c", False),
    "rose_hairline":   ("#efc7b0", "#dba283", "#bc8464", True),
}


_TEXIMG_CACHE = {}
_TRACE_ENG = {"mode": ""}   # 🧭 บอกว่าไฟล์ตัดล่าสุดใช้เอนจิ้นตัวไหน (โชว์ในกล่องเตือนหน้าเว็บ)
_CUT_SMOOTH = {"mm": 0.0}   # 🧈 รีดคลื่นเส้นตัด (มม.) — ค่าเริ่มต้น 0 = 'เหมือนปุ่มแปลงเป็นเส้นตัดเป๊ะ' (ผู้ใช้เปิดเองได้)
# 🏆 เส้นโค้ง Bézier 'ดิบ' จากเอนจิ้น (หน่วย มม. · พิกัดเดียวกับ polygon ที่ trace ได้)
#    ใช้ส่งเข้าไฟล์ตัดโดยตรงเหมือนปุ่ม 'แปลงเป็นเส้นตัด' — ไม่ผ่านการแตกจุด+ฟิตใหม่ (ซึ่งทำให้เส้นเละ)
_RAW_SUBS = {"subs": None}


# ⚡ ============ แคชกันงานซ้ำ (แก้ 502 — ไม่ลดจุดในรูปแม้แต่จุดเดียว) ============
#    หลักการ: อินพุตเดิมทุกไบต์ + ค่าตั้งเดิมทุกตัว -> ผลลัพธ์เดิมเป๊ะ จึงจำไว้ตอบซ้ำได้ทันที
#    (เบราว์เซอร์ยิงซ้ำหลัง 502 / ผู้ใช้สลับประเภทป้ายของไฟล์เดิม = งานซ้ำทั้งนั้น)
#    เก็บจำกัดจำนวน (FIFO) กันแรมบาน · แคชอยู่ต่อ worker (คำขอใน worker เดียวกันวิ่งทีละคำขอ)
_LAYERSET_CACHE = {"keys": [], "map": {}, "cap": 4}    # ผลลัพธ์ทั้งคำขอ /api/layer-set
_LFM_CACHE = {"keys": [], "map": {}, "cap": 4}         # รูปทรง + เส้นดิบ + สถานะเอนจิ้น ต่อไฟล์
_ARTURI_CACHE = {"keys": [], "map": {}, "cap": 6}      # ภาพงาน (data URI) ต่อไฟล์×ความละเอียด


def _cache_put(C, key, val):
    try:
        if key in C["map"]:
            return
        C["map"][key] = val; C["keys"].append(key)
        while len(C["keys"]) > int(C.get("cap", 4)):
            _old = C["keys"].pop(0); C["map"].pop(_old, None)
    except Exception:
        pass


def _file_sha1(path):
    import hashlib as _hl
    h = _hl.sha1()
    with open(path, "rb") as _f:
        for _ch in iter(lambda: _f.read(1 << 20), b""):
            h.update(_ch)
    return h.hexdigest()



def _dedup_subs(subs, tol=0.08):
    """🧹 ลบ 'เส้นซ้อนทับ' ในไฟล์ตัด — ไฟล์ .ai มักมีชิ้นเดียวกันซ้อนกัน (fill 1 ชิ้น + stroke อีกชิ้น)
       เครื่องตัดจะเดินซ้ำที่เดิม 2 รอบ (ไหม้/เสียเวลา) · เทียบด้วยลายเซ็นพิกัด (ปัดเป็นช่อง tol มม.)"""
    out = []; seen = set()
    for sp in (subs or []):
        try:
            _an = [sp["start"]] + [s[-1] for s in sp["segs"]]
            if len(_an) < 2:
                continue
            _xs = [p[0] for p in _an]; _ys = [p[1] for p in _an]
            _k = (len(sp["segs"]),
                  round(min(_xs) / tol), round(min(_ys) / tol),
                  round(max(_xs) / tol), round(max(_ys) / tol),
                  round(sum(_xs) / len(_xs) / tol), round(sum(_ys) / len(_ys) / tol))
            if _k in seen:
                continue
            seen.add(_k); out.append(sp)
        except Exception:
            out.append(sp)
    return out


def _subs_affine(subs, s, tx, ty):
    """เลื่อน/ย่อขยาย subpath ทั้งชุด (uniform) — ใช้ตามการจัดวาง logo ในกล่อง"""
    def T(p):
        return (p[0] * s + tx, p[1] * s + ty)
    out = []
    for sp in (subs or []):
        try:
            out.append({"start": T(sp["start"]), "closed": sp.get("closed", True),
                        "segs": [(("L", T(x[1])) if x[0] == "L" else ("C", T(x[1]), T(x[2]), T(x[3])))
                                 for x in sp["segs"]]})
        except Exception:
            continue
    return out


def _tex_swatch_clean(uri):
    """🪵 ครอป swatch วัสดุอัตโนมัติที่ 'ฝั่งเซิร์ฟเวอร์': ตัดหัวข้อ/ฉลาก/พื้นเทาในรูปแค็ตตาล็อกออก
       เหลือเฉพาะ 'เนื้อวัสดุ' (บริเวณที่มีสีจัด เช่น ลายไม้/ทอง) — ตัวหนังสือขาว-ดำ + พื้นเทา sat ต่ำ จึงถูกตัด
       ทำงานกับพื้นผิวที่ผู้ใช้บันทึกไว้แล้วด้วย (ไม่ต้องอัปโหลดใหม่)"""
    if not uri or not str(uri).startswith("data:image"):
        return uri, 1.0
    _k = hash(uri)
    if _k in _TEXIMG_CACHE:
        return _TEXIMG_CACHE[_k]
    out = uri; _aspect = 1.0
    try:
        import base64 as _b64, io as _io, numpy as _np
        from PIL import Image as _Im
        _b = str(uri).split(",", 1)[1]
        im = _Im.open(_io.BytesIO(_b64.b64decode(_b))).convert("RGB")
        a = _np.asarray(im).astype(_np.int16)
        sat = a.max(2) - a.min(2)                      # ความจัดของสี: เนื้อไม้/ทอง สูง · เทา/ขาว/ดำ ต่ำ
        m = (sat > 20).astype(_np.float32)
        H, W = m.shape

        def _run(prof):
            """ช่วงต่อเนื่องที่ยาวสุดซึ่ง 'มีเนื้อวัสดุ' (เทียบกับค่าสูงสุดของโปรไฟล์เอง -> ยืดหยุ่นทุกรูป)"""
            thr = max(0.12, float(prof.max()) * 0.55)
            on = prof >= thr
            best = (0, -1); s = None
            for i, v in enumerate(on):
                if v and s is None:
                    s = i
                elif (not v) and s is not None:
                    if i - s > best[1] - best[0]:
                        best = (s, i - 1)
                    s = None
            if s is not None and len(on) - s > best[1] - best[0]:
                best = (s, len(on) - 1)
            return best
        y0, y1 = _run(m.mean(1)); x0, x1 = _run(m.mean(0))
        if not (y1 - y0 > H * 0.06 and x1 - x0 > W * 0.06):
            x0 = int(W * 0.20); x1 = int(W * 0.80); y0 = int(H * 0.20); y1 = int(H * 0.80)
        iy = max(1, int((y1 - y0) * 0.06)); ix = max(1, int((x1 - x0) * 0.06))   # หดขอบกันเส้นกรอบ/เงา
        y0 += iy; y1 -= iy; x0 += ix; x1 -= ix
        if x1 - x0 > 12 and y1 - y0 > 12:
            im = im.crop((x0, y0, x1, y1))
        w2, h2 = im.size                               # ⚠️ ไม่บังคับจัตุรัส (แถบวัสดุมักเตี้ย) — คงสัดส่วนไว้ปูเป็น tile
        if max(w2, h2) > 460:
            _s3 = 460.0 / max(w2, h2)
            im = im.resize((max(8, int(w2 * _s3)), max(8, int(h2 * _s3))), _Im.LANCZOS)
        _bo = _io.BytesIO(); im.save(_bo, "JPEG", quality=88)
        out = "data:image/jpeg;base64," + _b64.b64encode(_bo.getvalue()).decode()
        _aspect = float(im.size[1]) / max(1.0, float(im.size[0]))
    except Exception:
        out = uri; _aspect = 1.0
    _TEXIMG_CACHE[_k] = (out, _aspect)
    if len(_TEXIMG_CACHE) > 24:
        _TEXIMG_CACHE.pop(next(iter(_TEXIMG_CACHE)))
    return out, _aspect


def _metal_defs(tex, S, tex_img=""):
    """คืน (defs_svg, fill_url, hairline?) สำหรับพื้นผิวโลหะ · tex ไม่รู้จัก -> (None,None,False)
       tex_img: data URI รูป swatch วัสดุ (พื้นผิวที่ผู้ใช้เพิ่มเอง เช่น ลายไม้) -> ปูเป็น pattern เต็มหน้า"""
    if tex_img and str(tex_img).startswith("data:image"):
        tex_img, _ar = _tex_swatch_clean(tex_img)       # 🪵 ตัดหัวข้อ/ฉลากในรูปแค็ตตาล็อกออกก่อนปูลาย (+ สัดส่วน h/w)
        _tw = max(240.0, S * 0.95)                     # 🔁 tile ใหญ่พอไม่เห็นรอยต่อ แต่ยังเป็นลายซ้ำ (ไม่ยืดรูปยักษ์)
        _th = max(40.0, _tw * float(_ar or 1.0))       # คงสัดส่วนรูปจริง -> ลายไม้ไม่ยืดบิด
        d = ('<defs><pattern id="mtxg" patternUnits="userSpaceOnUse" width="%.1f" height="%.1f">'
             '<image href="%s" xlink:href="%s" x="0" y="0" width="%.1f" height="%.1f" preserveAspectRatio="none"/>'
             '</pattern></defs>' % (_tw, _th, tex_img, tex_img, _tw, _th))
        return d, "url(#mtxg)", False
    t = _METAL_TEX.get(str(tex or ""))
    if not t:
        return "", None, False
    lo, mid, hi_dark, hairline = t
    # 🪙 โลหะจริงสะท้อนแบบ 'แถบ' — ครึ่งบนรับแสงฟ้า ครึ่งล่างรับเงาพื้น + มีเส้นขอบฟ้าคาดกลาง
    #    ใส่ stop ถี่ขึ้น + ไฮไลต์คมช่วงบน = ดูเป็นสแตนเลสจริง ไม่ใช่ไล่สีเรียบ ๆ
    d = ('<defs><linearGradient id="mtxg" x1="0%" y1="0%" x2="18%" y2="100%">'
         '<stop offset="0" stop-color="{lo}"/>'
         '<stop offset="0.07" stop-color="#ffffff" stop-opacity="0.95"/>'
         '<stop offset="0.14" stop-color="{lo}"/>'
         '<stop offset="0.28" stop-color="{md}"/>'
         '<stop offset="0.40" stop-color="{lo}"/>'
         '<stop offset="0.485" stop-color="#ffffff"/>'          # เส้นขอบฟ้า (สะท้อนคม)
         '<stop offset="0.52" stop-color="{dk}"/>'
         '<stop offset="0.62" stop-color="{md}"/>'
         '<stop offset="0.74" stop-color="{dk}"/>'
         '<stop offset="0.86" stop-color="{md}"/>'
         '<stop offset="0.95" stop-color="{lo}"/>'
         '<stop offset="1" stop-color="{md}"/>'
         '</linearGradient>').format(lo=lo, md=mid, dk=hi_dark)
    if hairline:
        # ✨ แฮร์ไลน์จริง = ขนแมวถี่มาก ไม่สม่ำเสมอ (มี noise) — ไม่ใช่เส้นเท่ากันเป๊ะ
        _lh = max(1.6, S * 0.0022)
        d += ('<pattern id="mtxh" width="6" height="%.2f" patternUnits="userSpaceOnUse">'
              '<rect width="6" height="%.2f" fill="none"/>'
              '<line x1="0" y1="%.2f" x2="6" y2="%.2f" stroke="rgba(255,255,255,0.42)" stroke-width="%.2f"/>'
              '<line x1="0" y1="%.2f" x2="6" y2="%.2f" stroke="rgba(0,0,0,0.16)" stroke-width="%.2f"/>'
              '<line x1="0" y1="%.2f" x2="6" y2="%.2f" stroke="rgba(255,255,255,0.18)" stroke-width="%.2f"/>'
              '</pattern>'
              '<filter id="mtxn" x="0" y="0" width="100%%" height="100%%">'
              '<feTurbulence type="fractalNoise" baseFrequency="0.9 0.02" numOctaves="2" result="n"/>'
              '<feColorMatrix in="n" type="saturate" values="0"/>'
              '<feComponentTransfer><feFuncA type="linear" slope="0.16"/></feComponentTransfer>'
              '</filter>') % (_lh, _lh,
                              _lh * 0.18, _lh * 0.18, _lh * 0.16,
                              _lh * 0.52, _lh * 0.52, _lh * 0.13,
                              _lh * 0.80, _lh * 0.80, _lh * 0.10)
    else:
        # 💎 ผิวเงา = 3 ชั้นซ้อน ให้เหมือนโลหะขัดเงาจริง
        #    (1) ไฮไลต์ดวงไฟนุ่ม  (2) แถบสะท้อนเฉียงคม  (3) ขอบสว่าง (fresnel) รอบชิ้น
        d += ('<radialGradient id="mtxs" cx="30%" cy="18%" r="58%">'
              '<stop offset="0" stop-color="#ffffff" stop-opacity="0.62"/>'
              '<stop offset="0.30" stop-color="#ffffff" stop-opacity="0.20"/>'
              '<stop offset="0.65" stop-color="#ffffff" stop-opacity="0.04"/>'
              '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
              '</radialGradient>'
              '<linearGradient id="mtxb" x1="0%" y1="0%" x2="100%" y2="60%">'
              '<stop offset="0.30" stop-color="#ffffff" stop-opacity="0"/>'
              '<stop offset="0.40" stop-color="#ffffff" stop-opacity="0.42"/>'
              '<stop offset="0.445" stop-color="#ffffff" stop-opacity="0.85"/>'
              '<stop offset="0.49" stop-color="#ffffff" stop-opacity="0.30"/>'
              '<stop offset="0.58" stop-color="#ffffff" stop-opacity="0"/>'
              '</linearGradient>')
    d += '</defs>'
    return d, "url(#mtxg)", hairline


def _ov_paint(tex, tex_img, S, idx):
    """พื้นผิวของ 'กลุ่มวัสดุย่อย' ในป้ายเดียวกัน — id ไม่ชนกับพื้นผิวตัวหลัก (ใช้ได้หลายกลุ่มพร้อมกัน)"""
    pid = "movtx%d" % int(idx)
    try:
        if tex_img and str(tex_img).startswith("data:image"):
            img, _ar = _tex_swatch_clean(tex_img)
            _tw = max(180.0, S * 0.6); _th = max(30.0, _tw * float(_ar or 1.0))
            d = ('<defs><pattern id="%s" patternUnits="userSpaceOnUse" width="%.1f" height="%.1f">'
                 '<image href="%s" xlink:href="%s" x="0" y="0" width="%.1f" height="%.1f" '
                 'preserveAspectRatio="none"/></pattern></defs>' % (pid, _tw, _th, img, img, _tw, _th))
            return d, "url(#%s)" % pid
        t = _METAL_TEX.get(str(tex or ""))
        if t:
            lo, mid, dk, _hl = t
            d = ('<defs><linearGradient id="%s" x1="0%%" y1="0%%" x2="100%%" y2="100%%">'
                 '<stop offset="0" stop-color="%s"/><stop offset="0.3" stop-color="%s"/>'
                 '<stop offset="0.55" stop-color="%s"/><stop offset="0.78" stop-color="%s"/>'
                 '<stop offset="1" stop-color="%s"/></linearGradient></defs>'
                 % (pid, lo, mid, lo, dk, mid))
            return d, "url(#%s)" % pid
    except Exception:
        pass
    return "", None


def _notes_overlay_svg(svg_str, notes):
    """🗒️ ทับโน้ต/ข้อความอิสระจากหน้าออกแบบ ลงบนภาพ SVG (ใบสั่งผลิต/พิมพ์) — พิกัด 0-1 เทียบทั้งภาพ"""
    import re as _re
    if not svg_str or not notes:
        return svg_str
    m = _re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg_str)
    if not m:
        return svg_str
    Wv = float(m.group(1)); Hv = float(m.group(2))

    def esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    out = []
    for n in notes:
        try:
            txt = str(n.get("text") or "").strip()
            if not txt:
                continue
            tx = float(n.get("tx", 0.5)) * Wv; ty = float(n.get("ty", 0.5)) * Hv
            lines = txt.split("\n")
            if str(n.get("kind") or "") == "txt":       # 🅰 ข้อความอิสระ
                fs = max(8.0, float(n.get("fs", 0.032)) * Wv)
                col = str(n.get("col") or "#0f172a")
                ts = "".join('<tspan x="%.1f" dy="%s">%s</tspan>'
                             % (tx, ('0' if i == 0 else '%.1f' % (fs * 1.25)), esc(l)) for i, l in enumerate(lines))
                # วาด 2 ชั้น: ขอบขาวก่อน แล้วตัวหนังสือทับ (ไม่พึ่ง paint-order — เรนเดอร์ตรงกันทุกโปรแกรม)
                out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="none" '
                           'stroke="#ffffff" stroke-width="%.1f" stroke-linejoin="round" opacity="0.9">%s</text>'
                           % (tx, ty + fs * 0.9, fs, fs * 0.18, ts))
                out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">%s</text>'
                           % (tx, ty + fs * 0.9, fs, col, ts))
            else:                                       # 📌 โน้ต + เส้นชี้
                nx = float(n.get("nx", 0.5)) * Wv; ny = float(n.get("ny", 0.5)) * Hv
                fs = max(8.0, Wv * 0.016)
                out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#f59e0b" stroke-width="%.1f" stroke-dasharray="%.1f %.1f"/>'
                           % (nx, ny, tx, ty, Wv * 0.0022, Wv * 0.006, Wv * 0.004))
                out.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#ef4444" stroke="#ffffff" stroke-width="%.1f"/>'
                           % (tx, ty, Wv * 0.008, Wv * 0.002))
                bw = max(len(l) for l in lines) * fs * 0.62 + fs * 1.2
                bh = fs * 1.5 * len(lines) + fs * 0.9
                out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#fffbe6" stroke="#f59e0b" stroke-width="%.1f" opacity="0.96"/>'
                           % (nx, ny, bw, bh, fs * 0.35, Wv * 0.0018))
                ts = "".join('<tspan x="%.1f" dy="%s">%s</tspan>'
                             % (nx + fs * 0.6, ('0' if i == 0 else '%.1f' % (fs * 1.5)), esc(l)) for i, l in enumerate(lines))
                out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="600" fill="#334155">%s</text>'
                           % (nx + fs * 0.6, ny + fs * 1.35, fs, ts))
        except Exception:
            continue
    return svg_str.replace("</svg>", "".join(out) + "</svg>")


def _armdim_h(out, spans, y, fs, lw, aw, col="#dc2626"):
    """📏 เส้นจับระยะแนวนอนของแขนแขวน — [(x0, x1, ค่าเป็นซม., ชื่อ), ...]
       ช่างเอาไปเจาะรูฝ้า/คานได้ตรงโดยไม่ต้องวัดเอง"""
    for _x0, _x1, _val, _nm in spans:
        if _val < 0.3 or abs(_x1 - _x0) < fs * 0.8:      # สั้นเกินกว่าจะเขียนตัวเลขได้ -> ข้าม
            continue
        out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                   % (_x0, y, _x1, y, col, lw))
        for _xx, _sg in ((_x0, 1.0), (_x1, -1.0)):
            out.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>'
                       % (_xx + aw * 0.6 * _sg, y - aw * 0.4, _xx, y, _xx + aw * 0.6 * _sg, y + aw * 0.4, col, lw))
        _m = (_x0 + _x1) / 2.0
        out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#fff" opacity="0.9"/>'
                   % (_m - fs * 1.9, y - fs * 1.02, fs * 3.8, fs * 0.86, fs * 0.13))
        out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" '
                   'fill="%s" text-anchor="middle">%s %.1f cm</text>' % (_m, y - fs * 0.36, fs * 0.68, col, _nm, _val))


def _armdim_v(out, spans, x, fs, lw, aw, col="#dc2626"):
    """📏 เส้นจับระยะแนวตั้งของแขนแขวน (แขนยื่นจากด้านข้าง 2 ตัว)"""
    for _y0, _y1, _val, _nm in spans:
        if _val < 0.3 or abs(_y1 - _y0) < fs * 0.8:
            continue
        out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                   % (x, _y0, x, _y1, col, lw))
        for _yy, _sg in ((_y0, 1.0), (_y1, -1.0)):
            out.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>'
                       % (x - aw * 0.4, _yy + aw * 0.6 * _sg, x, _yy, x + aw * 0.4, _yy + aw * 0.6 * _sg, col, lw))
        _m = (_y0 + _y1) / 2.0
        _rot = ' transform="rotate(-90 %.1f %.1f)"' % (x, _m)
        out.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#fff" opacity="0.9"%s/>'
                   % (x - fs * 1.9, _m - fs * 0.44, fs * 3.8, fs * 0.86, fs * 0.13, _rot))
        out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" '
                   'fill="%s" text-anchor="middle"%s>%s %.1f cm</text>'
                   % (x, _m + fs * 0.2, fs * 0.68, col, _rot, _nm, _val))


def _iso3d_svg(full, rec, perimeter_cm, inner_bore=None, face_color=None, side_color=None, art_href="",
               mount="none", arm_len_cm=30.0, plate_cm=10.0, arm_side="right",
               arm_adjust="fixed", arm_travel_cm=0.0, arm_edge_cm=20.0, arm_gap_cm=0.0,
               leg_h_cm=70.0, leg_span_cm=0.0, caster_mm=75.0, caster_lock=True, art_adj=None, metal_tex="", arm_color="", metal_tex_img="",
               metal_tex_scope="face", sticker_geom=None, bore_subs=None, art_geom=None,
               mat_overlays=None, mat_cut=None):
    """ภาพ 3 มิติ (extrude oblique) — เห็นผนังข้าง(ยกขอบ)ตั้งฉากแผ่นหลัง + คิ้วเจาะโบ๋โชว์ช่อง + เส้นบอกมิติ สูง/กว้าง/ลึก
       art_href: ถ้าใส่ data URI ของรูปงาน -> แปะรูปพิมพ์จริงบน 'หน้า' (กล่องไฟล้อมทรง = จบด้วยงานพิมพ์)
       mount: none / top2 (แขนยื่นลงจากบน 2) / side1 / side2 (แขนยื่นจากข้าง) · เหล็กกล่อง 1 นิ้ว + เพลท plate_cm"""
    import math

    def _esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    b = full.bounds; W = b[2] - b[0]; H = b[3] - b[1]; S = max(W, H, 1.0)
    # 🧱 หลายวัสดุในป้ายเดียว: พื้นที่ของ 'กลุ่มวัสดุอื่น' ต้องไม่ถูกดันหนาตามตัวหลัก
    #    (เช่น ตัวหลักไฟออกหน้า 50 มม. แต่ "ร้านผลไม้" เป็นพลาสวูด 10 มม.)
    #    -> เจาะพื้นที่กลุ่มออกจาก 'ตัวที่วาด' ก่อน แล้วค่อยวาดทับด้วยความหนาของกลุ่มเอง
    #    ⚠️ กรอบภาพ/มิติ ยังใช้ full เต็มใบเหมือนเดิม — ไม่กระทบไฟล์ตัด
    _drawg = full
    if mat_cut is not None and not mat_cut.is_empty:
        try:
            _dg9 = full.difference(mat_cut.buffer(0.15, join_style=2))
            if (not _dg9.is_empty) and _dg9.area > full.area * 0.02:
                _drawg = _dg9
        except Exception:
            _drawg = full
    polys = [p for p in (list(_drawg.geoms) if _drawg.geom_type == "MultiPolygon" else [_drawg])
             if p.geom_type == "Polygon" and not p.is_empty]
    D = float(rec.get("depth_cm", 5.0)) * 10.0
    ang = math.radians(30); dvx = D * math.cos(ang); dvy = -D * math.sin(ang)
    fs = max(6.0, S * 0.032); lw = max(0.6, S * 0.003); cd = "#dc2626"
    padL = fs * 4.2; padT = fs * 3.0 + abs(dvy); padR = fs * 2.5 + dvx + S * 0.16; padB = fs * 4.8
    # 🦾 เผื่อพื้นที่สำหรับ "แขนยึด + เพลท" (ก่อนคำนวณ ox/oy)
    _mount = str(mount or "none").lower()
    _aL = max(0.0, float(arm_len_cm)) * 10.0
    _plate = max(1.0, float(plate_cm)) * 10.0
    _armpad = _aL + _plate + fs * 2.2
    _aside = "left" if str(arm_side).lower() == "left" else "right"
    # 🖨️ กล่องไฟ 2 หน้า -> โชว์ "หน้า 2 (พิมพ์กลับด้าน/ฟลิป)" คู่กัน (เผื่อพื้นที่ขวา)
    _is2face = bool(art_href) and ("2 หน้า" in str(rec.get("name", "")))
    if _is2face:
        padR += W * 0.78 + fs * 5.0
    if _mount == "floor":                     # 🦿 ขาตั้งพื้น + ล้อเลื่อน -> เผื่อพื้นที่ด้านล่าง
        padB += max(0.0, float(leg_h_cm)) * 10.0 + float(caster_mm) + fs * 4.6
        padL += fs * 3.2
    elif _mount in ("top2", "letterframe"):
        padT += _armpad
    elif _mount in ("side1", "side2"):        # แขนแนวนอน ซ้าย/ขวาของภาพ
        if _aside == "left":
            padL += _armpad
        else:
            padR += _armpad
    # 📏 จับระยะ 'ตัวอักษร/โลโก้' ทุกกลุ่ม — จัดกลุ่มตามแถว (Y ซ้อนกัน = แถวเดียวกัน) แล้ววางตัวเลข 'นอกตัวป้าย'
    _dimg = []
    try:
        # ✅ ใช้ได้ทุกประเภทป้าย: กล่องฉลุ -> วัดจากรูฉลุ · ป้ายอื่น ๆ -> วัดจากตัวอักษร/โลโก้เอง
        _src_pieces = []
        _dim_src = None; _dim_isart = False
        if inner_bore is not None and not inner_bore.is_empty:
            _dim_src = (inner_bore.geoms if inner_bore.geom_type == "MultiPolygon" else [inner_bore])
        elif art_geom is not None and not art_geom.is_empty:      # กล่องไฟทรงเรขาคณิต -> ใช้รูปงานจริงที่วางในกล่อง
            _dim_src = (art_geom.geoms if art_geom.geom_type == "MultiPolygon" else [art_geom])
        elif art_href and rec.get("box_shape"):
            # 🖨️ กล่องไฟ 'หน้าพิมพ์': งานเป็นภาพ ไม่ใช่รูปทรง — คำนวณกรอบที่ภาพจะถูกวางจริง
            #    (สูตรเดียวกับตอนวาด) เพื่อให้จับระยะได้เหมือนกล่องฉลุหน้าทุกประการ
            from shapely.geometry import box as _bxD
            _ARTIN0 = max(2.0, S * 0.004) if bool(rec.get("no_trim") or rec.get("edge_lit")) else 14.0
            _iaD = full.buffer(-_ARTIN0)
            if _iaD is not None and not _iaD.is_empty:
                _abD = _iaD.bounds
                _cxD = (_abD[0] + _abD[2]) / 2.0; _cyD = (_abD[1] + _abD[3]) / 2.0
                _bwD = _abD[2] - _abD[0]; _bhD = _abD[3] - _abD[1]
                if rec.get("box_shape") in ("circle", "oval"):
                    _bwD *= 0.68; _bhD *= 0.68
                _arD = float((art_adj or {}).get("ar", 0) or 0)
                _sD = float((art_adj or {}).get("s", 1.0) or 1.0)
                if art_adj:
                    _twD = float(art_adj.get("w_mm", 0) or 0); _thD = float(art_adj.get("h_mm", 0) or 0)
                    if (_twD > 1.0 or _thD > 1.0) and _arD > 0 and _bwD > 0.1 and _bhD > 0.1:
                        _fhD = min(_bhD, _bwD / _arD)
                        if _fhD > 0.1:
                            _sD = (_thD / _fhD) if _thD > 1.0 else (_twD / (_fhD * _arD))
                            _sD = max(0.02, min(20.0, _sD))
                    _cxD += float(art_adj.get("dx", 0.0)); _cyD += float(art_adj.get("dy", 0.0))
                _bwD *= _sD; _bhD *= _sD
                if _arD > 0:                       # preserveAspectRatio="meet" -> ได้ขนาดจริงตามสัดส่วนงาน
                    _fhD = min(_bhD, _bwD / _arD); _bwD = _fhD * _arD; _bhD = _fhD
                _dim_src = [_bxD(_cxD - _bwD / 2.0, _cyD - _bhD / 2.0, _cxD + _bwD / 2.0, _cyD + _bhD / 2.0)]
                _dim_isart = True
        elif not rec.get("wrap"):
            _dim_src = polys                                       # อักษรยกขอบ/แบน/ไดคัท ฯลฯ
        for _pg0 in (_dim_src or []):
            if getattr(_pg0, "geom_type", "") == "Polygon" and not _pg0.is_empty and _pg0.area > 20.0:
                _src_pieces.append(_pg0.bounds)
        if _src_pieces:
            _src_pieces.sort(key=lambda q: (q[1], q[0]))
            for _bb0 in _src_pieces:
                _put = False
                for _gp in _dimg:
                    _ov = min(_gp[3], _bb0[3]) - max(_gp[1], _bb0[1])
                    _hh0 = min(_gp[3] - _gp[1], _bb0[3] - _bb0[1])
                    if _hh0 > 0 and _ov > _hh0 * 0.45:              # ซ้อนแนวตั้ง >45% = แถวเดียวกัน
                        _gp[0] = min(_gp[0], _bb0[0]); _gp[1] = min(_gp[1], _bb0[1])
                        _gp[2] = max(_gp[2], _bb0[2]); _gp[3] = max(_gp[3], _bb0[3])
                        _put = True; break
                if not _put:
                    _dimg.append([_bb0[0], _bb0[1], _bb0[2], _bb0[3]])
            # ✂ แยกกลุ่มตามช่องว่างแนวนอน (เช่น โลโก้วงกลม ห่างจากคำ -> คนละกลุ่ม)
            _dim2 = []
            for _gp in _dimg:
                _mem = [q for q in _src_pieces
                        if min(_gp[3], q[3]) - max(_gp[1], q[1]) > 0 and q[0] >= _gp[0] - 1 and q[2] <= _gp[2] + 1]
                _mem.sort(key=lambda q: q[0])
                # เกณฑ์ช่องว่าง = 0.45 × ความสูงเฉลี่ยของชิ้นในแถว (ตัวอักษรในคำเดียวกันชิดกว่านี้ -> ไม่แยก)
                _avh = (sum(q[3] - q[1] for q in _mem) / len(_mem)) if _mem else H
                _gapT = max(W * 0.02, _avh * 0.45)
                _cl = []
                for _q in _mem:
                    if _cl and _q[0] - _cl[-1][2] <= _gapT:
                        _c9 = _cl[-1]
                        _cl[-1] = [min(_c9[0], _q[0]), min(_c9[1], _q[1]), max(_c9[2], _q[2]), max(_c9[3], _q[3])]
                    else:
                        _cl.append([_q[0], _q[1], _q[2], _q[3]])
                _dim2 += _cl if _cl else [_gp]
            _dimg = [g for g in _dim2 if (g[2] - g[0]) > W * 0.015 and (g[3] - g[1]) > H * 0.02]
            # ข้ามกลุ่มที่ ≈ ทั้งป้าย (ซ้ำกับเส้นบอกขนาดกล่องอยู่แล้ว)
            #   ⚠️ ยกเว้น 'กรอบงานพิมพ์บนหน้ากล่อง' — ต่อให้เต็มหน้าก็ยังต้องบอกขนาด
            #      เพราะเป็นคนละอย่างกับขนาดกล่อง (ช่างต้องรู้ว่างานพิมพ์กว้าง×สูงเท่าไหร่)
            if not _dim_isart:
                _dimg = [g for g in _dimg if not ((g[2] - g[0]) > W * 0.95 and (g[3] - g[1]) > H * 0.95)]
            _dimg.sort(key=lambda g: (g[1], g[0]))
            _dimg = _dimg[:6]
    except Exception:
        _dimg = []
    if _dimg:                                             # เผื่อพื้นที่นอกป้ายสำหรับเส้นบอกระยะ
        #  +2 แถว/คอลัมน์ สำหรับ 'ระยะห่างขอบ 4 ด้าน' ที่ย้ายออกมาไว้นอกกรอบ (ห้ามทับตัวงาน)
        padB += (len(_dimg) + 3) * fs * 1.9
        padR += fs * 11.0
    ox = -b[0] + padL; oy = -b[1] + padT
    faceFill = face_color or "#c9cdd4"; wallFill = side_color or "#9aa1ac"; edge = "#3f4753"; boreFill = "#eef1f5"
    _edgelit = bool(rec.get("edge_lit"))
    _backlit = bool(rec.get("back_lit"))
    if _edgelit:                                       # 💡 ไฟออกรอบ = อะคริลิคทั้งใบ ไฟส่องออกทุกด้าน -> ผนังข้างเรืองแสง
        wallFill = "#fbe6b8"; edge = "#e6c672"

    def F(p):
        return (p[0] + ox, p[1] + oy)

    def Bk(p):
        return (p[0] + ox + dvx, p[1] + oy + dvy)

    def ringd(ring, tf):
        pts = [tf(p) for p in ring]
        return "M %.2f %.2f " % pts[0] + " ".join("L %.2f %.2f" % q for q in pts[1:]) + " Z"

    def faced(pg, tf):
        d = ringd(list(pg.exterior.coords), tf)
        for h in pg.interiors:
            d += " " + ringd(list(h.coords), tf)
        return d
    parts = []
    # 🔆 เปิดกลุ่ม 'ตัวป้าย' — แสงไฟ (ออกหน้า/ออกหลัง/ออกรอบ) ต้องเรืองจากกลุ่มนี้เท่านั้น
    #    ห้ามเรืองจากพื้นหลังสี่เหลี่ยม หรือจากเส้นบอกมิติ/ตัวเลข ซึ่งไม่ใช่ชิ้นงานจริง
    #    (ฝั่งหน้าเว็บใส่ filter ที่ #w3dBody ตัวเดียว -> ได้ฮาโลตามรูปตัวอักษรเป๊ะ)
    parts.append('<g id="w3dBody">')
    # 🪙 พื้นผิวสแตนเลส (เงา/แฮร์ไลน์) — ใช้กับ 'ผิวโลหะ' (หน้ากล่องฉลุ หรือหน้าป้ายปกติ)
    _mtxd, _mtxfill, _mtxhair = _metal_defs(metal_tex, S, metal_tex_img)
    if _mtxd:
        parts.append(_mtxd)
    # 🎯 ขอบเขตพื้นผิว: face=เฉพาะหน้า · side=เฉพาะแผ่นข้าง · all=ทั้งตัว
    _scopeT = str(metal_tex_scope or "face").lower()
    _texFace = _mtxfill if _scopeT in ("face", "all") else None
    _texSide = _mtxfill if _scopeT in ("side", "all") else None
    if _texSide and not _edgelit:
        wallFill = _texSide
    if _edgelit:                                      # 💡 แสงฟุ้งรอบทั้งกล่อง (ไฟออกทุกด้าน) — วาดไว้ 'หลังสุด'
        _gc = rec.get("glow_color", "#fff3c4")
        parts.append('<defs><filter id="w3dHalo" x="-60%%" y="-60%%" width="220%%" height="220%%"><feGaussianBlur stdDeviation="%.1f"/></filter>'
                     '<filter id="w3dGlow" x="-45%%" y="-45%%" width="190%%" height="190%%"><feGaussianBlur stdDeviation="%.1f"/></filter></defs>'
                     % (max(6.0, S * 0.05), max(3.0, S * 0.022)))
        for pg in polys:                               # ฮาโลรอบกล่อง (หน้า+ลึก) ให้แสงเรืองออกทุกด้าน
            parts.append('<path d="%s" fill="%s" filter="url(#w3dHalo)" opacity="0.55"/>' % (faced(pg, F), _gc))
            parts.append('<path d="%s" fill="%s" filter="url(#w3dHalo)" opacity="0.40"/>' % (faced(pg, Bk), _gc))
    if _backlit and not _edgelit:                      # 💡 ไฟออกหลัง (halo) — เรืองเฉพาะด้านหลังตกกระทบผนังรอบตัวอักษร · หน้าอักษรทึบ
        _gcb = rec.get("glow_color", "#eaf2ff")
        parts.append('<defs><filter id="w3dHaloB" x="-80%%" y="-80%%" width="260%%" height="260%%"><feGaussianBlur stdDeviation="%.1f"/></filter></defs>'
                     % max(8.0, S * 0.07))
        for pg in polys:                               # ฮาโลด้านหลัง (Bk) = แสงเรืองบนผนังรอบอักษร (ไล่โทน 2 ชั้น)
            parts.append('<path d="%s" fill="%s" filter="url(#w3dHaloB)" opacity="0.60"/>' % (faced(pg, Bk), _gcb))
            parts.append('<path d="%s" fill="%s" filter="url(#w3dHaloB)" opacity="0.32"/>' % (faced(pg, Bk), _gcb))
    for pg in polys:                                   # ผนังข้าง (ขอบที่เห็น)
        cen = pg.centroid; cx, cy = cen.x, cen.y
        ring = list(pg.exterior.coords)
        for i in range(len(ring) - 1):
            A = ring[i]; Bp = ring[i + 1]
            ex = Bp[0] - A[0]; ey = Bp[1] - A[1]; nx, ny = ey, -ex
            mx, my = (A[0] + Bp[0]) / 2, (A[1] + Bp[1]) / 2
            if (mx - cx) * nx + (my - cy) * ny < 0:
                nx, ny = -nx, -ny
            if nx * dvx + ny * dvy > 1e-6:
                Af = F(A); Bf = F(Bp); Bb = Bk(Bp); Ab = Bk(A)
                _qd = 'M %.2f %.2f L %.2f %.2f L %.2f %.2f L %.2f %.2f Z' % (Af[0], Af[1], Bf[0], Bf[1], Bb[0], Bb[1], Ab[0], Ab[1])
                parts.append('<path class="w3d-side" d="%s" fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                             % (_qd, wallFill, edge, lw))
                if _texSide and _mtxhair:              # ✨ แฮร์ไลน์บนแผ่นข้าง (เมื่อ scope คลุมด้านข้าง)
                    parts.append('<path d="%s" fill="url(#mtxh)"/>' % _qd)
                # 💡 แสงเงาตามทิศผนัง (แสงส่องบน-ซ้าย) — ชั้นทับโปร่งใส 'ไม่ใส่ class' จึงอยู่รอดแม้ client ย้อมสีทับ
                _nl = math.hypot(nx, ny) or 1.0
                _dot = (nx / _nl) * (-0.45) + (ny / _nl) * (-0.89)
                if _dot > 0.12:
                    parts.append('<path d="%s" fill="#ffffff" opacity="%.2f"/>' % (_qd, min(0.26, 0.05 + 0.20 * _dot)))
                elif _dot < -0.10:
                    parts.append('<path d="%s" fill="#0b1220" opacity="%.2f"/>' % (_qd, min(0.30, 0.08 + 0.22 * (-_dot))))
    if art_href:                                       # 🖨️ กล่องไฟหน้าพิมพ์: คิ้ว 1cm รอบตัว + artwork หดเข้า >1cm
        _notrim = bool(rec.get("no_trim") or _edgelit)  # ไม่มีคิ้ว -> หน้าพิมพ์เต็ม ไม่มีขอบคิ้วเทา
        _KIM = 0.0 if _notrim else 10.0
        _ARTIN = max(2.0, S * 0.004) if _notrim else 14.0   # ไม่มีคิ้ว = พิมพ์เกือบเต็มหน้า (ไม่เว้นกรอบขาว)
        kimFill = "#fffdf5" if _notrim else "#a9b4c4"   # ไม่มีคิ้ว = หน้าอะคริลิคขาวเรืองแสงเต็มหน้า
        try:
            _ik = _drawg.buffer(-_KIM) if _KIM > 0 else _drawg
            _ia = _drawg.buffer(-_ARTIN)
        except Exception:
            _ik = None; _ia = None
        _ikp = ([] if _ik is None or _ik.is_empty else (list(_ik.geoms) if _ik.geom_type == "MultiPolygon" else [_ik]))
        _iap = ([] if _ia is None or _ia.is_empty else (list(_ia.geoms) if _ia.geom_type == "MultiPolygon" else [_ia]))
        _kimcls = "w3d-face" if _notrim else "w3d-kim"   # ไม่มีคิ้ว = หน้าเต็ม=อะคริลิค(ย้อมสีหน้า) · มีคิ้ว = แถบนี้คือคิ้ว(ย้อมสีคิ้ว)
        for pg in polys:                               # คิ้ว = เต็มหน้า (สีคิ้ว) — จะเห็นขอบ 1cm รอบตัว
            parts.append('<path class="%s" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (_kimcls, faced(pg, F), kimFill, edge, lw))
        for pg in _ikp:                                # หน้าใน (หลังคิ้ว) = อะคริลิค (ย้อมสีหน้าอะคริลิคได้)
            parts.append('<path class="w3d-face" d="%s" fill="#ffffff" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (faced(pg, F), edge, lw * 0.7))
        if _iap:                                       # artwork วางในหน้า · ไม่ล้นออกนอกทรง
            _clip = "".join('<path d="%s"/>' % faced(pg, F) for pg in _iap)
            parts.append('<defs><clipPath id="w3dArt" clip-rule="evenodd">%s</clipPath></defs>' % _clip)
            _ab = _ia.bounds
            _cx = (_ab[0] + _ab[2]) / 2.0; _cy = (_ab[1] + _ab[3]) / 2.0
            _bw = _ab[2] - _ab[0]; _bh = _ab[3] - _ab[1]
            _shp = rec.get("box_shape")
            if _shp in ("circle", "oval"):             # วงกลม/วงรี -> วางในกรอบสี่เหลี่ยมที่อยู่ในวง (กันล้น)
                _bw *= 0.68; _bh *= 0.68
            if art_adj:                                # 🎯 ผู้ใช้ปรับ logo ในกล่อง: ย่อ/ขยาย + เลื่อนตำแหน่ง
                try:
                    _s = float(art_adj.get("s", 1.0)) or 1.0
                    # 📏 ผู้ใช้กำหนดขนาด logo เป็น ซม. (เช่น สูง 26.2 ซม.)
                    #    รูปถูกวางแบบ preserveAspectRatio="meet" -> ขนาดจริงคือด้านที่ 'พอดีก่อน'
                    #    จึงคำนวณขนาดที่วางได้จริงก่อน แล้วค่อยหาสเกลที่ทำให้ได้ ซม. ตามสั่งเป๊ะ
                    _tw9 = float(art_adj.get("w_mm", 0) or 0); _th9 = float(art_adj.get("h_mm", 0) or 0)
                    _ar9 = float(art_adj.get("ar", 0) or 0)
                    if (_tw9 > 1.0 or _th9 > 1.0) and _ar9 > 0 and _bw > 0.1 and _bh > 0.1:
                        _fh9 = min(_bh, _bw / _ar9); _fw9 = _fh9 * _ar9
                        if _fh9 > 0.1:
                            _s = (_th9 / _fh9) if _th9 > 1.0 else (_tw9 / _fw9)
                            _s = max(0.02, min(20.0, _s))
                            _ARTFIT["w_mm"] = round(_fw9 * _s, 1); _ARTFIT["h_mm"] = round(_fh9 * _s, 1)
                    _bw *= _s; _bh *= _s
                    _cx += float(art_adj.get("dx", 0.0)); _cy += float(art_adj.get("dy", 0.0))
                except Exception:
                    pass
            _x0 = _cx - _bw / 2.0; _y0 = _cy - _bh / 2.0
            _ix, _iy = F((_x0, _y0))
            parts.append('<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" '
                         'preserveAspectRatio="xMidYMid meet" clip-path="url(#w3dArt)"/>'
                         % (art_href, art_href, _ix, _iy, _bw, _bh))
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), edge, lw))
    else:
        _punch = bool(rec.get("punch_face"))
        # 🔦 กล่องฉลุ: หน้ากล่อง = แผ่นโลหะ (ย้อมด้วยสี 'ขอบ/คิ้ว' -> class w3d-kim) · รู logo = อะคริลิคเรืองแสง (สี 'หน้าอะคริลิค')
        # 🎨 ป้ายที่มี 'คิ้ว' (มี inner_bore = เจาะโชว์อะคริลิคตรงกลาง) -> แถบหน้าที่เห็นคือ 'คิ้ว'
        #    ต้องย้อมด้วยสี "ขอบ/คิ้ว" (class w3d-kim) ไม่ใช่สีหน้าอะคริลิค — เดิมย้อมผิดช่อง
        _hasKim = bool(inner_bore is not None and not inner_bore.is_empty
                       and any(L.get("kind") == "frame" for L in rec.get("layers", [])))
        _faceCls = "w3d-kim" if (_punch or _hasKim) else "w3d-face"
        _faceFillUse = (side_color or "#c9cdd4") if _punch else faceFill
        if _texFace:                                   # 🪙 เลือกพื้นผิวสแตนเลส -> ผิวโลหะเป็น gradient เมทัลลิก (ตาม scope)
            _faceFillUse = _texFace
        for pg in polys:                               # หน้าปกติ (ไม่มีรูปพิมพ์)
            parts.append('<path class="%s" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (_faceCls, faced(pg, F), _faceFillUse, edge, lw))
        if _texFace and _mtxhair:                      # ✨ แฮร์ไลน์: เส้นขนแมว + เกรนสุ่มทับบนผิว
            for pg in polys:
                parts.append('<path d="%s" fill="url(#mtxh)" fill-rule="evenodd"/>' % faced(pg, F))
            for pg in polys:
                parts.append('<path d="%s" fill="#ffffff" fill-rule="evenodd" filter="url(#mtxn)" opacity="0.5"/>'
                             % faced(pg, F))
        elif _texFace:                                 # 💎 ผิวเงา: ไฮไลต์ดวงไฟ + แถบสะท้อนเฉียง + ขอบสว่าง
            for pg in polys:
                parts.append('<path d="%s" fill="url(#mtxs)" fill-rule="evenodd"/>' % faced(pg, F))
            for pg in polys:
                parts.append('<path d="%s" fill="url(#mtxb)" fill-rule="evenodd"/>' % faced(pg, F))
            for pg in polys:                           # ขอบสว่างบาง ๆ (fresnel) — ทำให้ชิ้นดูมีมิติ
                parts.append('<path d="%s" fill="none" stroke="#ffffff" stroke-opacity="0.55" '
                             'stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), lw * 0.9))
        # ✨ เงาสะท้อนเฉียง (specular sheen) — ผิวหน้าดูเป็นวัสดุจริงแบบ product mockup (ไม่ใส่ class -> รอดจากการย้อมสีฝั่ง client)
        parts.append('<defs><linearGradient id="w3dSheen" x1="0" y1="0" x2="1" y2="1">'
                     '<stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>'
                     '<stop offset="0.28" stop-color="#ffffff" stop-opacity="0.05"/>'
                     '<stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>'
                     '<stop offset="0.78" stop-color="#0b1220" stop-opacity="0.05"/>'
                     '<stop offset="1" stop-color="#0b1220" stop-opacity="0.10"/></linearGradient></defs>')
        for pg in polys:
            parts.append('<path d="%s" fill="url(#w3dSheen)" fill-rule="evenodd"/>' % faced(pg, F))
    # 🧱 กลุ่มวัสดุอื่นในป้ายเดียวกัน (เช่น "ร้านผลไม้" = พลาสวูด 10 มม. สีขาว) — วาดทับด้วยสี+ความหนาของตัวเอง
    for _ovi, _ov in enumerate(mat_overlays or []):
        try:
            _og = _ov.get("geom")
            if _og is None or _og.is_empty:
                continue
            _of = _ov.get("fill") or "#f5f5f4"
            _owall = _shade_hex(_of, 0.72)          # สีผนังข้าง = สีวัสดุของกลุ่มเอง (เข้มลง) ไม่ใช่เทากลาง
            # 🎨 พื้นผิวของกลุ่มนี้ (สแตนเลส/ลายไม้/ลามิเนต ที่ผู้ใช้เลือกเอง) — id ไม่ชนกับตัวหลัก
            _ovd, _ovf = _ov_paint(_ov.get("tex"), _ov.get("tex_img"), S, _ovi)
            if _ovd:
                parts.append(_ovd)
            if _ovf:
                _of = _ovf
            _od = max(2.0, float(_ov.get("depth_mm") or 10.0))
            _ovx = _od * math.cos(ang); _ovy = -_od * math.sin(ang)

            def _Fo(p, _dx=_ovx, _dy=_ovy):                 # หน้าแผ่นของกลุ่มนี้ (ยกขึ้นตามความหนาตัวเอง)
                return (p[0] + ox + _dx, p[1] + oy + _dy)
            _ops = list(_og.geoms) if _og.geom_type == "MultiPolygon" else [_og]
            # ผนังข้าง (ความหนาวัสดุ) — ลากจากฐานขึ้นหน้าแผ่น
            for pg in _ops:
                if pg.geom_type != "Polygon" or pg.is_empty:
                    continue
                _co = list(pg.exterior.coords)
                for _i7 in range(len(_co) - 1):
                    _a = _co[_i7]; _b = _co[_i7 + 1]
                    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f L %.1f %.1f Z" fill="%s" '
                                 'fill-opacity="0.92" stroke="none"/>'
                                 % (_a[0] + ox, _a[1] + oy, _b[0] + ox, _b[1] + oy,
                                    _Fo(_b)[0], _Fo(_b)[1], _Fo(_a)[0], _Fo(_a)[1], _owall))
            for pg in _ops:
                if pg.geom_type == "Polygon" and not pg.is_empty:
                    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>'
                                 % (faced(pg, _Fo), _of, "#64748b", lw * 0.7))
            # ป้ายชี้บอกวัสดุ
            _b8 = _og.bounds; _q0 = _Fo((_b8[0], _b8[1])); _q1 = _Fo((_b8[2], _b8[3]))
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#7c3aed" '
                         'stroke-width="%.2f" stroke-dasharray="%.1f %.1f" rx="%.1f"/>'
                         % (_q0[0] - fs * 0.22, _q0[1] - fs * 0.22, (_q1[0] - _q0[0]) + fs * 0.44,
                            (_q1[1] - _q0[1]) + fs * 0.44, lw * 1.3, fs * 0.32, fs * 0.22, fs * 0.18))
            _tx = _q1[0] + fs * 0.8; _ty = _q1[1] + fs * 1.4
            _lb = "%s · หนา %.1f ซม." % (_esc(_ov.get("label") or "วัสดุแยก"), _od / 10.0)
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#7c3aed" stroke-width="%.2f"/>'
                         % (_q1[0], _q1[1], _tx, _ty, lw))
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#faf5ff" '
                         'stroke="#7c3aed" stroke-width="%.2f"/>'
                         % (_tx, _ty - fs * 0.95, len(_lb) * fs * 0.44 + fs * 0.7, fs * 1.35, fs * 0.28, lw * 0.9))
            parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" '
                         'fill="#6d28d9">%s</text>' % (_tx + fs * 0.35, _ty + fs * 0.05, fs * 0.8, _lb))
        except Exception:
            pass
    if sticker_geom is not None and not sticker_geom.is_empty:   # 🏷️ ชิ้นสติ๊กเกอร์ (ไม่ตัด) — พิมพ์/ติดดำบนหน้ากล่อง
        for pg in (sticker_geom.geoms if sticker_geom.geom_type == "MultiPolygon" else [sticker_geom]):
            if pg.geom_type == "Polygon" and not pg.is_empty:
                parts.append('<path class="w3d-stick" d="%s" fill="#15181d" fill-rule="evenodd" opacity="0.92"/>' % faced(pg, F))
        # 📍 ชี้ตำแหน่งสติ๊กเกอร์บนตัวป้าย: กรอบประ + เส้นชี้ + ป้ายบอกขนาด/ตำแหน่งจริง (ซม.)
        try:
            _sb = sticker_geom.bounds
            _p0 = F((_sb[0], _sb[1])); _p1 = F((_sb[2], _sb[3]))
            _bw = _p1[0] - _p0[0]; _bh = _p1[1] - _p0[1]
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#ef4444" '
                         'stroke-width="%.2f" stroke-dasharray="%.1f %.1f" rx="%.1f"/>'
                         % (_p0[0] - fs * 0.25, _p0[1] - fs * 0.25, _bw + fs * 0.5, _bh + fs * 0.5,
                            lw * 1.4, fs * 0.35, fs * 0.25, fs * 0.2))
            _lx = _p1[0] + fs * 1.2; _ly = max(fs * 2.6, _p0[1] - fs * 1.0)
            # ตำแหน่งจริงบนป้าย: วัดจากมุมซ้าย-บนของตัวป้าย (ซม.)
            _fx = (_sb[0] - b[0]) / 10.0; _fy = (_sb[1] - b[1]) / 10.0
            _txt = ("Sticker (ไม่ตัด) %.1f×%.1f ซม. · จากซ้าย %.1f ซม. · จากบน %.1f ซม."
                    % ((_sb[2] - _sb[0]) / 10.0, (_sb[3] - _sb[1]) / 10.0, _fx, _fy))
            _tw2 = len(_txt) * fs * 0.42 + fs
            _Wt0 = padL + W + dvx + padR                  # กว้างภาพรวม -> กันป้ายล้นขอบขวา
            if _lx + _tw2 > _Wt0 - fs * 0.5:
                _lx = max(fs * 0.5, _Wt0 - fs * 0.5 - _tw2)
                _ly = max(fs * 2.4, _p0[1] - fs * 2.2)
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#fff1f2" stroke="#ef4444" stroke-width="%.2f"/>'
                         % (_lx, _ly - fs * 1.05, _tw2, fs * 1.5, fs * 0.25, lw))
            parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#b91c1c">%s</text>'
                         % (_lx + fs * 0.4, _ly + fs * 0.1, fs * 0.78, _esc(_txt)))
            # เส้นชี้ + จุดแดง วาดหลังป้าย -> ชี้จากป้ายไปยังตำแหน่งสติ๊กเกอร์จริงเสมอ
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#ef4444" stroke-width="%.2f"/>'
                         % (min(_lx + _tw2 * 0.5, _p1[0] + fs * 1.2), _ly + fs * 0.45,
                            (_p0[0] + _p1[0]) / 2.0, _p0[1], lw * 1.2))
            parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#ef4444"/>' % ((_p0[0] + _p1[0]) / 2.0, _p0[1], lw * 2.2))
        except Exception:
            pass
    # 🔦 รูฉลุจาก 'เส้นตัดจริง' (subs) — ตรงกับไฟล์ .ai 100% (เขาเกลียว/เส้นบางไม่หาย)
    _bore_d = ""
    if bore_subs:
        try:
            _pp = []
            for _sp in bore_subs:
                _c0 = F(_sp["start"]); _pp.append("M %.2f %.2f" % _c0)
                for _sg in _sp["segs"]:
                    if _sg[0] == "L":
                        _pp.append("L %.2f %.2f" % F(_sg[1]))
                    else:
                        _a = F(_sg[1]); _b2 = F(_sg[2]); _c2 = F(_sg[3])
                        _pp.append("C %.2f %.2f %.2f %.2f %.2f %.2f" % (_a[0], _a[1], _b2[0], _b2[1], _c2[0], _c2[1]))
                _pp.append("Z")
            _bore_d = " ".join(_pp)
        except Exception:
            _bore_d = ""
    if _bore_d:
        _pbF = face_color or "#fff3c4"
        _pblur = max(5.0, S * 0.014)
        parts.append('<defs><filter id="w3dPunchGlow" x="-60%%" y="-60%%" width="220%%" height="220%%">'
                     '<feGaussianBlur stdDeviation="%.1f"/></filter>'
                     '<filter id="w3dPunchGlow2" x="-150%%" y="-150%%" width="400%%" height="400%%">'
                     '<feGaussianBlur stdDeviation="%.1f"/></filter></defs>' % (_pblur, _pblur * 3.0))
        parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" opacity="0.5" filter="url(#w3dPunchGlow2)"/>' % (_bore_d, _pbF))
        parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" opacity="0.9" filter="url(#w3dPunchGlow)"/>' % (_bore_d, _pbF))
        parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (_bore_d, _pbF, edge, lw * 0.5))
    elif inner_bore is not None and not inner_bore.is_empty:   # คิ้วเจาะโบ๋ = ช่องจม
        _punch2 = bool(rec.get("punch_face"))
        ip = list(inner_bore.geoms) if inner_bore.geom_type == "MultiPolygon" else [inner_bore]
        if _punch2:
            # 💡 แสงไฟออกหน้า 'เฉพาะโลโก้ที่ฉลุ' — ฮาโลฟุ้งรอบรู + เนื้อรูเรืองสว่าง (อะคริลิคขาวนม + ไฟด้านใน)
            _pbF = face_color or "#fff3c4"
            _pblur = max(5.0, S * 0.014)
            parts.append('<defs><filter id="w3dPunchGlow" x="-60%%" y="-60%%" width="220%%" height="220%%">'
                         '<feGaussianBlur stdDeviation="%.1f"/></filter>'
                         '<filter id="w3dPunchGlow2" x="-150%%" y="-150%%" width="400%%" height="400%%">'
                         '<feGaussianBlur stdDeviation="%.1f"/></filter></defs>' % (_pblur, _pblur * 3.0))
            for pg in ip:                              # 🌟 บลูมชั้นนอก (ฟุ้งกว้าง นุ่มแบบไฟจริง)
                if pg.geom_type == "Polygon" and not pg.is_empty:
                    parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" opacity="0.5" filter="url(#w3dPunchGlow2)"/>' % (faced(pg, F), _pbF))
            for pg in ip:                              # ชั้นฮาโล (เบลอฟุ้งออกนอกรู)
                if pg.geom_type == "Polygon" and not pg.is_empty:
                    parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" opacity="0.9" filter="url(#w3dPunchGlow)"/>' % (faced(pg, F), _pbF))
            for pg in ip:                              # เนื้อรู logo (สว่าง · ย้อมสีด้วย swatch หน้าอะคริลิค)
                if pg.geom_type == "Polygon" and not pg.is_empty:
                    parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (faced(pg, F), _pbF, edge, lw * 0.6))
        else:
            for pg in ip:
                if pg.geom_type == "Polygon" and not pg.is_empty:
                    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (faced(pg, F), boreFill, edge, lw * 0.8))
    if _edgelit:                                       # 💡 ไฟออกรอบ: เส้นขอบกล่องบางๆ (ไม่มีคิ้ว/ไม่มีกรอบในหน้า) — แสงฟุ้งอยู่ 'ด้านนอก' (ฮาโลหลังสุด)
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="#e6c672" stroke-width="%.2f" stroke-linejoin="round" opacity="0.55"/>' % (faced(pg, F), max(1.0, S * 0.004)))
    # 🔆 ปิดกลุ่ม 'ตัวป้าย' — ตั้งแต่บรรทัดนี้ลงไปเป็นเส้นบอกมิติ/ตัวเลข/โน้ต ซึ่ง 'ห้ามเรืองแสง'
    parts.append('</g>')
    aw = fs * 0.55
    xh = padL - fs * 1.7; y0 = padT; y1 = padT + H       # สูง (ซ้าย)
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xh, y0, xh, y1, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y0 + aw, xh, y0, xh + aw * 0.6, y0 + aw, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y1 - aw, xh, y1, xh + aw * 0.6, y1 - aw, cd, lw))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f cm</text>' % (xh - fs * 0.6, (y0 + y1) / 2, fs * 0.95, cd, xh - fs * 0.6, (y0 + y1) / 2, H / 10.0))
    yw = padT + H + fs * 1.4; xx0 = padL; xx1 = padL + W  # กว้าง (ล่าง)
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xx0, yw, xx1, yw, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx0 + aw, yw - aw * 0.6, xx0, yw, xx0 + aw, yw + aw * 0.6, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx1 - aw, yw - aw * 0.6, xx1, yw, xx1 - aw, yw + aw * 0.6, cd, lw))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle">%.1f cm</text>' % ((xx0 + xx1) / 2, yw + fs * 1.1, fs * 0.95, cd, W / 10.0))
    cF = F((b[2], b[1])); cB = Bk((b[2], b[1]))          # ลึก/ยกขอบ (แนวเยื้อง)
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (cF[0], cF[1], cB[0], cB[1], cd, lw))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">Return ~%.1f cm</text>' % ((cF[0] + cB[0]) / 2 + fs * 0.3, (cF[1] + cB[1]) / 2 - fs * 0.3, fs * 0.9, cd, D / 10.0))
    # 📏 เส้นบอกระยะ 'ตัวอักษร/โลโก้' — กว้างวางใต้ป้าย · สูงวางขวาป้าย (ตัวเลขอยู่นอกตัวป้ายทั้งหมด ไม่รกหน้างาน)
    if _dimg:
        _dc = "#0d9488"; _dlw = max(0.5, lw * 0.85); _dfs = fs * 0.8
        _yBase = padT + H + fs * 2.6
        for _i9, _g9 in enumerate(_dimg):
            _x0d, _x1d = _g9[0] + ox, _g9[2] + ox
            _yd = _yBase + (_i9 + 1) * fs * 1.75
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f" opacity="0.5"/>'
                         % (_x0d, _g9[3] + oy, _x0d, _yd, _dc, _dlw * 0.8, fs * 0.25, fs * 0.2))
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f" opacity="0.5"/>'
                         % (_x1d, _g9[3] + oy, _x1d, _yd, _dc, _dlw * 0.8, fs * 0.25, fs * 0.2))
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (_x0d, _yd, _x1d, _yd, _dc, _dlw))
            for _xa, _sg in ((_x0d, 1), (_x1d, -1)):
                parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>'
                             % (_xa + _sg * aw * 0.7, _yd - aw * 0.4, _xa, _yd, _xa + _sg * aw * 0.7, _yd + aw * 0.4, _dc, _dlw))
            parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle">%s: กว้าง %.1f ซม.</text>'
                         % ((_x0d + _x1d) / 2, _yd - fs * 0.28, _dfs, _dc,
                            ("โลโก้" if _i9 == 0 and (_g9[2] - _g9[0]) < W * 0.45 else "แถว %d" % (_i9 + 1)),
                            (_g9[2] - _g9[0]) / 10.0))
            # สูง — วางนอกป้ายด้านขวา
            _xr = padL + W + dvx + fs * 1.2 + (_i9 % 2) * fs * 2.6
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f" opacity="0.45"/>'
                         % (_g9[2] + ox, _g9[1] + oy, _xr, _g9[1] + oy, _dc, _dlw * 0.8, fs * 0.25, fs * 0.2))
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f" opacity="0.45"/>'
                         % (_g9[2] + ox, _g9[3] + oy, _xr, _g9[3] + oy, _dc, _dlw * 0.8, fs * 0.25, fs * 0.2))
            parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (_xr, _g9[1] + oy, _xr, _g9[3] + oy, _dc, _dlw))
            parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">สูง %.1f ซม.</text>'
                         % (_xr - fs * 0.3, (_g9[1] + _g9[3]) / 2 + oy, _dfs, _dc, _xr - fs * 0.3, (_g9[1] + _g9[3]) / 2 + oy, (_g9[3] - _g9[1]) / 10.0))
        # 📐 ระยะขอบ 4 ด้าน (ซ้าย · ขวา · บน · ล่าง) ของกลุ่มแรก — ช่างต้องรู้ว่าวางงานห่างขอบเท่าไหร่
        #    ⚠️ ต้องวาง 'นอกตัวป้าย' เสมอ — ห้ามลากทับหน้างาน ไม่งั้นบังแบบจนดูไม่รู้เรื่อง
        #    ใช้หลักเขียนแบบจริง: เส้นช่วย (witness line) ยิงออกจากขอบ แล้วเส้นวัดอยู่นอกกรอบ
        try:
            _g0 = _dimg[0]
            _cc = "#7c3aed"; _clw = max(0.5, lw * 0.8)
            _dash = ' stroke-dasharray="%.1f %.1f" opacity="0.5"' % (fs * 0.25, fs * 0.2)

            def _lab9(_x, _y, _t, _rot=""):
                parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#ffffff" '
                             'opacity="0.9"%s/>' % (_x - fs * 1.85, _y - fs * 0.55, fs * 3.7, fs * 0.86, fs * 0.13, _rot))
                parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" '
                             'fill="%s" text-anchor="middle"%s>%s</text>'
                             % (_x, _y + fs * 0.12, fs * 0.66, _cc, _rot, _t))

            # ── ซ้าย/ขวา: เส้นวัดอยู่ 'ใต้ป้าย' ถัดจากแถวจับระยะโลโก้
            _yc = _yBase + (len(_dimg) + 1) * fs * 1.75 + fs * 0.5
            for _nm, _x0, _x1, _val in (("ห่างขอบซ้าย", b[0] + ox, _g0[0] + ox, (_g0[0] - b[0]) / 10.0),
                                        ("ห่างขอบขวา", _g0[2] + ox, b[2] + ox, (b[2] - _g0[2]) / 10.0)):
                if _val < 0.15 or abs(_x1 - _x0) < fs * 0.6:
                    continue
                for _wx in (_x0, _x1):        # เส้นช่วย ลากลงจากใต้ป้ายถึงเส้นวัด (ไม่ทับตัวงาน)
                    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"%s/>'
                                 % (_wx, b[3] + oy, _wx, _yc, _cc, _clw * 0.8, _dash))
                parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                             % (_x0, _yc, _x1, _yc, _cc, _clw))
                for _xx, _sg in ((_x0, 1.0), (_x1, -1.0)):
                    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>'
                                 % (_xx + aw * 0.6 * _sg, _yc - aw * 0.4, _xx, _yc,
                                    _xx + aw * 0.6 * _sg, _yc + aw * 0.4, _cc, _clw))
                _lab9((_x0 + _x1) / 2.0, _yc - fs * 0.62, "%s %.1f ซม." % (_nm, _val))

            # ── บน/ล่าง: เส้นวัดอยู่ 'ขวาป้าย' ถัดจากคอลัมน์จับระยะโลโก้
            #    ⚠️ กล่องไฟ 2 หน้า มีแผ่นพรีวิว 'Face 2' วางอยู่ทางขวา ต้องเลยมันไปอีก ไม่งั้นทับกัน
            _xc = padL + W + dvx + fs * 1.2 + fs * 2.6 * 2 + fs * 1.6
            if _is2face:
                _xc += W * 0.78 + fs * 5.0
            for _nm, _y0, _y1, _val in (("ห่างขอบบน", b[1] + oy, _g0[1] + oy, (_g0[1] - b[1]) / 10.0),
                                        ("ห่างขอบล่าง", _g0[3] + oy, b[3] + oy, (b[3] - _g0[3]) / 10.0)):
                if _val < 0.15 or abs(_y1 - _y0) < fs * 0.6:
                    continue
                # เส้นช่วยแบบ 'ขีดสั้น' 2 ท่อน — ไม่ลากยาวข้ามของอื่นให้รก (มาตรฐานงานเขียนแบบ)
                for _wy in (_y0, _y1):
                    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"%s/>'
                                 % (b[2] + ox, _wy, b[2] + ox + fs * 1.1, _wy, _cc, _clw * 0.8, _dash))
                    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"%s/>'
                                 % (_xc - fs * 1.1, _wy, _xc, _wy, _cc, _clw * 0.8, _dash))
                parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                             % (_xc, _y0, _xc, _y1, _cc, _clw))
                for _yy, _sg in ((_y0, 1.0), (_y1, -1.0)):
                    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>'
                                 % (_xc - aw * 0.4, _yy + aw * 0.6 * _sg, _xc, _yy,
                                    _xc + aw * 0.4, _yy + aw * 0.6 * _sg, _cc, _clw))
                _mid9 = (_y0 + _y1) / 2.0
                _lab9(_xc, _mid9, "%s %.1f ซม." % (_nm, _val),
                      ' transform="rotate(-90 %.1f %.1f)"' % (_xc, _mid9))
        except Exception:
            pass
    # 🦿 ขาตั้งพื้น + ล้อเลื่อน (กล่องไฟเคลื่อนย้ายได้) — ขาคู่ 2 ข้าง + คานล่าง + ล้อ 4 ตัว
    arm_parts = []
    if _mount == "floor":
        _lh = max(5.0, float(leg_h_cm)) * 10.0          # ความสูงขา (พื้นถึงใต้กล่อง)
        _cd9 = max(20.0, float(caster_mm))              # เส้นผ่านศูนย์กลางล้อ
        _lsp = max(0.0, float(leg_span_cm)) * 10.0      # ระยะห่างขา 2 ข้าง (0 = อัตโนมัติ)
        if _lsp < 10.0 or _lsp > W * 0.98:
            _lsp = W * 0.62
        _lt = max(14.0, S * 0.030)                      # ความหนาเสา (เหล็กกล่อง)
        _stC = (arm_color or "").strip() or (side_color or "") or "#8b93a0"
        _stD = "#4b525d"
        _cx9 = (b[0] + b[2]) / 2.0
        _lxs = [_cx9 - _lsp / 2.0, _cx9 + _lsp / 2.0]
        _yTop = F((b[0], b[3]))[1]                      # ใต้กล่อง (ระนาบหน้า)
        _yBeam = _yTop + _lh                            # คานล่าง
        _yFloor = _yBeam + _cd9                         # พื้น

        def _post(_x, _dx=0.0):
            _px = F((_x, b[3]))[0] + _dx
            return ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" stroke="%s" '
                    'stroke-width="%.2f"/>' % (_px - _lt / 2.0, _yTop, _lt, _lh, _lt * 0.12, _stC, _stD, lw), _px)
        # เสาคู่หลัง (เยื้องตามความลึกกล่อง) วาดก่อนให้ดูมีมิติ
        for _x in _lxs:
            _s9, _ = _post(_x, dvx)
            arm_parts.append(_s9.replace(_stC, _shade_hex(_stC, 0.72)))
        _pxs = []
        for _x in _lxs:
            _s9, _px = _post(_x); arm_parts.append(_s9); _pxs.append(_px)
        # คานล่างเชื่อมขา (เหล็กกล่องนอน) + คานเยื้องหลัง
        arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                         % (_pxs[0] - _lt * 1.6 + dvx, _yBeam - _lt * 0.5 + dvy * 0.0,
                            (_pxs[1] - _pxs[0]) + _lt * 3.2, _lt * 0.86, _lt * 0.12,
                            _shade_hex(_stC, 0.72), _stD, lw))
        arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                         % (_pxs[0] - _lt * 1.6, _yBeam - _lt * 0.5, (_pxs[1] - _pxs[0]) + _lt * 3.2,
                            _lt * 0.86, _lt * 0.12, _stC, _stD, lw))
        # 🛞 ล้อเลื่อน 4 ตัว (หน้า 2 · หลัง 2) + แป้นล้อ + เบรกล็อก
        _wr = _cd9 / 2.0
        for _dxq, _sc in ((dvx, 0.72), (0.0, 1.0)):
            for _px in _pxs:
                _wx9 = _px + _dxq
                arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="1.5" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                                 % (_wx9 - _lt * 0.62, _yBeam + _lt * 0.36, _lt * 1.24, _lt * 0.30,
                                    _shade_hex(_stC, _sc * 0.9), _stD, lw * 0.8))
                arm_parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                                 % (_wx9, _yFloor - _wr, _wr, _shade_hex("#2b3038", _sc), "#1b1f26", lw * 0.9))
                arm_parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                                 % (_wx9, _yFloor - _wr, _wr * 0.34, _shade_hex("#c9ced6", _sc), "#7d858f", lw * 0.7))
                if caster_lock and _dxq == 0.0:          # คันเบรก (เฉพาะล้อหน้า ให้เห็นชัด)
                    arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="1.2" fill="#ef4444" stroke="#b91c1c" stroke-width="%.2f"/>'
                                     % (_wx9 - _wr * 0.16, _yFloor - _wr * 0.30, _wr * 1.05, _wr * 0.26, lw * 0.6))
        # พื้นห้อง
        arm_parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#94a3b8" stroke-width="%.2f"/>'
                         % (padL * 0.4, _yFloor, padL + W + dvx + fs * 1.5, _yFloor, lw * 1.4))
        # 📏 จับระยะ: สูงขา · สูงรวม · ระยะห่างขา (วางนอกตัวกล่องทั้งหมด)
        _xdim = padL - fs * 3.2
        _armdim_v(arm_parts, [(_yTop, _yBeam, _lh / 10.0, "สูงขา"),
                              (F((b[0], b[1]))[1], _yFloor, (H + _lh + _cd9) / 10.0, "สูงรวม")],
                  _xdim, fs, lw, aw, col="#0d9488")
        # 📏 'จากพื้น (ล้อ) ถึงใต้ตัวป้าย' — ตัวเลขที่ช่างกับลูกค้าถามบ่อยที่สุด
        #    ว่าป้ายจะลอยสูงจากพื้นเท่าไหร่ (= สูงขา + ขนาดล้อ) วางไว้คนละฝั่งกับชุดบน ไม่ทับกัน
        _armdim_v(arm_parts, [(_yTop, _yFloor, (_lh + _cd9) / 10.0, "พื้นถึงใต้ป้าย")],
                  padL + W + dvx + fs * 1.6, fs, lw, aw, col="#0d9488")
        _armdim_h(arm_parts, [(_pxs[0], _pxs[1], _lsp / 10.0, "ระยะห่างขา")],
                  _yFloor + fs * 1.9, fs, lw, aw, col="#0d9488")
        arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" '
                         'fill="#0d9488" text-anchor="middle">ขาตั้ง 2 ข้าง + คานล่าง · ล้อเลื่อน Ø%.0f มม. 4 ตัว%s</text>'
                         % (padL + W / 2.0, _yFloor + fs * 3.4, fs * 0.82, _cd9,
                            " (มีเบรก 2 ตัว)" if caster_lock else ""))
    # 🦾 แขนยึด + เพลท 10cm (เหล็กกล่อง 1 นิ้ว) — วาดในระนาบภาพ ให้เห็นชัดว่าติดตั้งยังไง
    if _mount in ("top2", "side1", "side2", "letterframe"):
        tw = 25.0
        # 🦾 สีแขนยึด: เลือกเองได้ (arm_color) · ไม่เลือก -> วิ่งตามพื้นผิว/สีกล่องไฟ (metal_tex > side_color > เหล็กมาตรฐาน)
        # 🦾 แขน: ตามพื้นผิวโลหะ preset ได้ แต่ 'ไม่เอา' ลาย custom (ไม้/ลามิเนต) มาติดแขน -> ใช้สีเหล็ก/สีข้างแทน
        _armF = (arm_color or "").strip() or ("" if metal_tex_img else (_mtxfill or "")) or (side_color or "") or "#8b93a0"
        steel = _armF; steelD = "#5b626d"; plateC = _armF; bolt = "#5b626d"; surf = _armF

        def _tube(p1, p2, w):
            vx, vy = p2[0] - p1[0], p2[1] - p1[1]; Ln = math.hypot(vx, vy) or 1.0
            nx, ny = -vy / Ln, vx / Ln; hw = w / 2.0
            return ('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f L %.1f %.1f Z" fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                    % (p1[0]+nx*hw, p1[1]+ny*hw, p2[0]+nx*hw, p2[1]+ny*hw,
                       p2[0]-nx*hw, p2[1]-ny*hw, p1[0]-nx*hw, p1[1]-ny*hw, steel, steelD, lw))

        def _plate_at(cx, cy):
            hw = _plate / 2.0; ins = hw - 18.0
            s = ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                 % (cx-hw, cy-hw, _plate, _plate, _plate*0.06, plateC, steelD, lw))
            for bx, by in ((-ins, -ins), (ins, -ins), (-ins, ins), (ins, ins)):
                s += '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="%s" stroke-width="%.2f"/>' % (cx+bx, cy+by, 4.5, bolt, lw*0.8)
            return s

        def _plate_flat(cx, cy):
            # เพลทเรียบ ติดแนบฝ้าเพดาน — มองด้านหน้าเห็นเป็นแถบแนวนอนบาง (ไม่ใช่แผ่นหันหน้า)
            pw = _plate; ph = max(7.0, _plate * 0.20)
            s = ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2.5" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                 % (cx - pw / 2.0, cy - ph / 2.0, pw, ph, plateC, steelD, lw))
            s += '<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (cx - pw / 2.0, cy - ph / 2.0, cx + pw / 2.0, cy - ph / 2.0, "#eef2f7", lw * 0.6)
            for bx in (-pw * 0.30, pw * 0.30):   # หัวน็อตยึดฝ้า (จุดเล็ก)
                s += '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#eef2f7" stroke="%s" stroke-width="%.2f"/>' % (cx + bx, cy, 3.0, bolt, lw * 0.7)
            return s

        def _plate_flat_v(cx, cy):
            # เพลทเรียบ แนบผนัง (แขนยื่นจากผนังซ้าย/ขวา) — มองด้านหน้าเห็นเป็นแถบแนวตั้งบาง
            ph = _plate; pw = max(7.0, _plate * 0.20)
            s = ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2.5" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                 % (cx - pw / 2.0, cy - ph / 2.0, pw, ph, plateC, steelD, lw))
            _edge = (cx - pw / 2.0) if _aside == "right" else (cx + pw / 2.0)   # ขอบด้านที่แนบผนัง
            s += '<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (_edge, cy - ph / 2.0, _edge, cy + ph / 2.0, "#eef2f7", lw * 0.6)
            for by in (-ph * 0.30, ph * 0.30):   # หัวน็อตยึดผนัง
                s += '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#eef2f7" stroke="%s" stroke-width="%.2f"/>' % (cx, cy + by, 3.0, bolt, lw * 0.7)
            return s

        midY = (b[1] + b[3]) / 2.0
        specs = []
        if _mount == "letterframe":
            # 🔩 โครงยึด = 'คานคู่แนวนอน' (บน-ล่าง) พาดกลางอักษร + ปิดหัวท้าย + 2 แขน (ซ้าย-ขวา) ยื่นขึ้น
            # 📏 มาตรฐาน: ขอบโครงซ้าย-ขวา ไม่เกินขอบนอกตัวอักษร -> หดเข้าข้างละ _fin (กันตัวโค้ง C/O ที่ปลายเกิน)
            _fin = (b[2] - b[0]) * 0.02 + min(W, H) * 0.03
            fx0, fx1 = b[0] + _fin, b[2] - _fin
            _cyc = (b[1] + b[3]) / 2.0                     # กลางแนวตั้งของอักษร
            _fgap = H * 0.38                               # ระยะคานบน-ล่าง (สูงเฟรม)
            fy0, fy1 = _cyc - _fgap / 2.0, _cyc + _fgap / 2.0   # คานบน / คานล่าง (mm)
            _FW = (fx1 - fx0) / 10.0; _FH = (fy1 - fy0) / 10.0  # กว้างเฟรม / สูงเฟรม (ซม.)
            P00 = F((fx0, fy0)); P10 = F((fx1, fy0)); P11 = F((fx1, fy1)); P01 = F((fx0, fy1))
            for pa, pb in ((P00, P10), (P01, P11), (P00, P01), (P10, P11)):   # คานบน+ล่าง + ปิดหัวท้าย
                arm_parts.append(_tube(pa, pb, tw * 0.75))
            _edge = max(0.0, float(arm_edge_cm)) * 10.0    # ระยะแขนจากขอบซ้าย/ขวา
            _axL = min(fx1 - 1.0, max(fx0, fx0 + _edge)); _axR = max(fx0 + 1.0, min(fx1, fx1 - _edge))
            for _ax in (_axL, _axR):                        # 2 แขน ซ้าย-ขวา จากคานบนขึ้น
                a = F((_ax, fy0)); specs.append((a, (a[0], a[1] - _aL)))
            _cy = min(w[1] for _a, w in specs)
            arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                             % (padL * 0.5, _cy - 5.0, (padL + W + dvx) - padL * 0.5, 5.0, "#e2e8f0", surf, lw * 0.8))
            arm_parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                             % (padL * 0.5, _cy, padL + W + dvx, _cy, surf, lw * 1.6))
            # 📏 จับระยะ: ความสูงแขน (ซ้าย) + ขนาดเฟรมนอก + ระยะแขนจากขอบ
            _aLx = F((_axL, fy0))[0]
            arm_parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (_aLx - fs * 1.4, _cy, _aLx - fs * 1.4, P00[1], "#dc2626", lw))
            arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#dc2626" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">แขน %.0f cm</text>' % (_aLx - fs * 1.9, (_cy + P00[1]) / 2, fs * 0.8, _aLx - fs * 1.9, (_cy + P00[1]) / 2, _aL / 10.0))
            arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#2563eb" text-anchor="middle">คานคู่ยึดอักษร กว้าง %.0f &#215; สูง %.0f cm &#183; แขนห่างขอบ %.0f cm</text>' % ((P00[0] + P10[0]) / 2, P01[1] + fs * 1.4, fs * 0.82, _FW, _FH, float(arm_edge_cm)))
        elif _mount == "top2":
            _isround = str(rec.get("box_shape") or "") in ("circle", "oval")
            _fxs = (0.40, 0.60) if _isround else (0.30, 0.70)   # ทรงกลม/วงรี -> แขนชิด center กล่อง
            # 📏 ผู้ใช้กำหนด 'ระยะห่างระหว่างแขน 2 ข้าง' เป็น ซม. ได้ (วัดกึ่งกลางแขนถึงกึ่งกลางแขน)
            #    ช่างต้องรู้เลขนี้เพื่อเจาะรูฝ้า/คานให้ตรง — คุมไม่ให้เกินตัวกล่อง (เหลือขอบ 3 ซม.)
            _gap = max(0.0, float(arm_gap_cm or 0.0)) * 10.0
            _gapmax = max(20.0, W - 60.0)
            if _gap > 10.0:
                _gap = min(_gap, _gapmax)
                _fxs = (0.5 - _gap / (2.0 * W), 0.5 + _gap / (2.0 * W))
            _axs = []
            for fx in _fxs:
                _ax = b[0] + W * fx; _ty = b[1]; _axs.append(_ax)
                try:                                            # แตะ 'ผิวบนสุด' ของกล่องจริง (กันแขนลอยเหนือวงกลม)
                    from shapely.geometry import LineString as _LS
                    _it = full.intersection(_LS([(_ax, b[1] - 10.0), (_ax, b[3] + 10.0)]))
                    if _it is not None and not _it.is_empty:
                        _ty = _it.bounds[1]
                except Exception:
                    _ty = b[1]
                # 🦾 ยึดที่ 'กึ่งกลางความลึกด้านบนกล่อง' (เลื่อน +dvx/2,+dvy/2) -> แขนสมดุลซ้าย-ขวาเหนือกล่องจริง
                _af = F((_ax, _ty)); a = (_af[0] + dvx / 2.0, _af[1] + dvy / 2.0)
                specs.append((a, (a[0], a[1] - _aL)))
            _cy = min(w[1] for _a, w in specs)
            # ฝ้าเพดาน = แถบทึบบางแนวนอน (เพลทเรียบแนบด้านล่างฝ้า)
            arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                             % (padL * 0.5, _cy - 5.0, (padL + W + dvx) - padL * 0.5, 5.0, "#e2e8f0", surf, lw * 0.8))
            arm_parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                             % (padL * 0.5, _cy, padL + W + dvx, _cy, surf, lw * 1.6))
            # 📏 จับระยะแขนแนวนอน: ห่างกันเท่าไหร่ + ห่างขอบซ้าย/ขวาเท่าไหร่
            if len(_axs) == 2:
                _gy = _cy + _plate * 0.85
                _P = lambda _x: F((_x, b[1]))[0] + dvx / 2.0
                _armdim_h(arm_parts, [(_P(b[0]), _P(_axs[0]), (_axs[0] - b[0]) / 10.0, "ถึงขอบซ้าย"),
                                      (_P(_axs[0]), _P(_axs[1]), abs(_axs[1] - _axs[0]) / 10.0, "ระยะห่างแขน"),
                                      (_P(_axs[1]), _P(b[2]), (b[2] - _axs[1]) / 10.0, "ถึงขอบขวา")],
                          _gy, fs, lw, aw)
        else:                                  # side1/side2 — แขนแนวนอน "ทางซ้าย/ขวาของภาพ" (คู่ขนาน)
            _avx = (-_aL) if _aside == "left" else _aL
            _ex = b[0] if _aside == "left" else b[2]
            if _mount == "side1":
                atts = [F((_ex, midY))]
            else:                              # side2 = แขนคู่ ขนานกัน (บน + ล่าง) ยื่นออกด้านข้าง
                _gapV = max(0.0, float(arm_gap_cm or 0.0)) * 10.0   # 📏 ระยะห่างแขนบน-ล่าง (ผู้ใช้กำหนดได้)
                _fys = (0.30, 0.70)
                if _gapV > 10.0:
                    _gapV = min(_gapV, max(20.0, H - 60.0))
                    _fys = (0.5 - _gapV / (2.0 * H), 0.5 + _gapV / (2.0 * H))
                atts = [F((_ex, b[1] + H * _fys[0])), F((_ex, b[1] + H * _fys[1]))]
                _ays = [b[1] + H * _fys[0], b[1] + H * _fys[1]]   # 📏 เก็บไว้จับระยะ
            for a in atts:
                specs.append((a, (a[0] + _avx, a[1])))
            _wx = atts[0][0] + _avx                       # ตำแหน่งผนัง (ปลายแขน)
            _wy0 = min(w[1] for _a, w in specs) - _plate * 0.8
            _wy1 = max(w[1] for _a, w in specs) + _plate * 0.8
            _wsx = _wx + (_plate * 0.10 if _aside == "right" else -_plate * 0.10)
            # ผนัง = แถบทึบบางแนวตั้ง (เพลทแนบด้านในผนัง)
            arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>'
                             % (min(_wx, _wsx), _wy0, abs(_wsx - _wx), _wy1 - _wy0, "#e2e8f0", surf, lw * 0.8))
            arm_parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>'
                             % (_wx, _wy0, _wx, _wy1, surf, lw * 1.6))
            # 📏 จับระยะแขนแนวตั้ง (แขนข้าง 2 ตัว): ห่างกันเท่าไหร่ + ห่างขอบบน/ล่างเท่าไหร่
            if _mount == "side2" and len(_ays) == 2:
                # ⚠️ ต้องอยู่ 'นอกทุกอย่าง' — เลยแนวผนังออกไปอีก ไม่ทับกล่องและไม่ทับแขน
                _gx9 = _wx + (-fs * 1.9 if _aside == "left" else fs * 1.9)
                _Q = lambda _y: F((_ex, _y))[1]
                _armdim_v(arm_parts, [(_Q(b[1]), _Q(_ays[0]), (_ays[0] - b[1]) / 10.0, "ถึงขอบบน"),
                                      (_Q(_ays[0]), _Q(_ays[1]), abs(_ays[1] - _ays[0]) / 10.0, "ระยะห่างแขน"),
                                      (_Q(_ays[1]), _Q(b[3]), (b[3] - _ays[1]) / 10.0, "ถึงขอบล่าง")],
                          _gx9, fs, lw, aw)
        _adj = str(arm_adjust).lower() == "adjustable"

        def _lerp(pp, qq, t):
            return (pp[0] + (qq[0] - pp[0]) * t, pp[1] + (qq[1] - pp[1]) * t)
        for a, w in specs:
            if _adj:
                # แขนนอก (outer) + แขนใน (สอดอยู่ข้างใน เลื่อนเข้า-ออกได้)
                arm_parts.append(_tube(a, _lerp(a, w, 0.60), tw))          # โครงนอก (กว้าง)
                arm_parts.append(_tube(_lerp(a, w, 0.44), w, tw * 0.58))   # โครงใน (แคบ · เลื่อนได้)
            else:
                arm_parts.append(_tube(a, w, tw))
            arm_parts.append(_plate_flat(w[0], w[1]) if _mount in ("top2", "letterframe") else _plate_flat_v(w[0], w[1]))
        _lab = ("Adjustable +/-%.0f cm (telescopic)" % float(arm_travel_cm)) if _adj else "Fixed"
        arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#475569">Mount arm ~%.0f cm &#183; Plate %.0f&#215;%.0f cm &#183; %s</text>'
                         % (padL, padT + H + padB - fs * 0.8, fs * 0.82, _aL / 10.0, _plate / 10.0, _plate / 10.0, _lab))

    # 🖨️ หน้า 2 (พิมพ์กลับด้าน/ฟลิป) — โชว์คู่กับหน้า 1 สำหรับกล่องไฟ 2 หน้า
    if _is2face:
        iw = W * 0.72; ih = H * 0.72
        _armgap = _armpad if (_mount in ("side1", "side2") and _aside == "right") else 0.0
        ix = padL + W + dvx + _armgap + fs * 3.0     # เลื่อนขวาให้พ้นแขน (ถ้าแขนออกขวา)
        iy = padT + (H - ih) * 0.5                    # กึ่งกลางแนวตั้ง
        cxm = ix + iw / 2.0
        arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0d9488" text-anchor="middle">&#8644;</text>'
                         % ((padL + W + dvx + ix) / 2.0, padT + H * 0.5, fs * 1.8))
        arm_parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="#ffffff" stroke="%s" stroke-width="%.2f"/>'
                         % (ix, iy, iw, ih, iw * 0.03, edge, lw))
        arm_parts.append('<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" preserveAspectRatio="xMidYMid meet"/>'
                         % (art_href, art_href, ix, iy, iw, ih))
        arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a" text-anchor="middle">Face 2 &#183; &#3627;&#3633;&#3609;&#3629;&#3637;&#3585;&#3604;&#3657;&#3634;&#3609; (&#3629;&#3656;&#3634;&#3609;&#3629;&#3629;&#3585;&#3611;&#3585;&#3605;&#3636;)</text>'
                         % (cxm, iy - fs * 0.6, fs * 0.95))
        arm_parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" fill="#64748b" text-anchor="middle">&#3614;&#3636;&#3617;&#3614;&#3660; 2 &#3604;&#3657;&#3634;&#3609; &#183; &#3629;&#3632;&#3588;&#3619;&#3636;&#3621;&#3636;&#3585; / &#3612;&#3657;&#3634; 3P / &#3652;&#3623;&#3609;&#3636;&#3621;</text>'
                         % (cxm, iy + ih + fs * 1.3, fs * 0.8))

    Wt = padL + W + dvx + padR; Ht = padT + H + padB
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    # 🎬 ฉากสตูดิโอ: พื้นหลังไล่โทน + สปอตไลท์นวล + เงาตกพื้นใต้ป้าย (product mockup)
    _shx = padL + (W + dvx) / 2.0; _shy = padT + H + max(10.0, fs * 0.55)
    _shrx = (W + dvx) * 0.56; _shry = max(8.0, S * 0.045)
    svg.append('<defs><linearGradient id="w3dBgG" x1="0" y1="0" x2="0" y2="1">'
               '<stop offset="0" stop-color="#fbfcfe"/><stop offset="0.62" stop-color="#eef2f7"/>'
               '<stop offset="1" stop-color="#dde5ee"/></linearGradient>'
               '<radialGradient id="w3dSpot" cx="0.5" cy="0.26" r="0.8">'
               '<stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>'
               '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
               '<filter id="w3dShad" x="-60%" y="-180%" width="220%" height="460%">'
               '<feGaussianBlur stdDeviation="' + ('%.1f' % max(4.0, S * 0.02)) + '"/></filter></defs>')
    svg.append('<rect x="0" y="0" width="%.1f" height="%.1f" fill="url(#w3dBgG)"/>' % (Wt, Ht))
    svg.append('<rect x="0" y="0" width="%.1f" height="%.1f" fill="url(#w3dSpot)"/>' % (Wt, Ht))
    svg.append('<ellipse cx="%.1f" cy="%.1f" rx="%.1f" ry="%.1f" fill="#0f172a" opacity="0.15" filter="url(#w3dShad)"/>' % (_shx, _shy, _shrx, _shry))
    svg.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a">%s</text>' % (padL, fs * 1.3, fs * 1.05, _esc(_en_type(rec["name"]))))
    svg += arm_parts       # แขนอยู่หลังป้าย (วาดก่อน)
    svg += parts; svg.append('</svg>')
    return "\n".join(svg)


def _exploded_svg(out_layers, rec, perimeter_cm):
    """ภาพ 3 มิติแบบ exploded (oblique) — วางชั้นซ้อนตามความลึก + เส้นบอกมิติ (สูง/ลึก/คิ้ว) + ป้ายชั้น
       เลียนแบบภาพสเปคโรงงาน: หน้า(คิ้ว)อยู่หน้าสุด ... แผ่นพื้นอยู่หลังสุด"""
    from vectorcnc import nesting

    def _esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def _bbox(subs):
        mnx = mny = 1e18; mxx = mxy = -1e18
        for sp in subs:
            pts = [sp["start"]]
            for s in sp["segs"]:
                pts.append(s[1]) if s[0] == "L" else pts.extend([s[1], s[2], s[3]])
            for (x, y) in pts:
                mnx = min(mnx, x); mny = min(mny, y); mxx = max(mxx, x); mxy = max(mxy, y)
        return mnx, mny, mxx, mxy

    N = len(out_layers)
    gmnx = gmny = 1e18; gmxx = gmxy = -1e18
    for L in out_layers:
        b = _bbox(L["subs"])
        gmnx = min(gmnx, b[0]); gmny = min(gmny, b[1]); gmxx = max(gmxx, b[2]); gmxy = max(gmxy, b[3])
    Wd = gmxx - gmnx; Hd = gmxy - gmny; S = max(Wd, Hd, 1.0)
    step = S * 0.16                       # ระยะเยื้องต่อชั้น
    dvx = step * 0.95; dvy = -step * 0.62   # ทิศเยื้อง (ขวา-ขึ้น) = oblique
    fs = max(6.0, S * 0.032); lw = max(0.5, S * 0.0028); cd = "#dc2626"
    padL = fs * 4.0; padT = fs * 2.2; padR = S * 0.28 + N * abs(dvx); padB = fs * 4.5

    # canvas: front layer (index N-1 drawn last/front) at base origin; back layers shifted by +dv
    def place(sp, k):
        ox = padL + (N - 1 - k) * dvx - gmnx
        oy = padT + (N - 1 - k) * (-dvy) - gmny   # ชั้นหลัง = สูงขึ้น (เยื้องขึ้น)
        def T(p):
            return (p[0] + ox, p[1] + oy)
        return {"start": T(sp["start"]),
                "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                "closed": sp.get("closed", True)}

    Wt = padL + Wd + (N - 1) * dvx + padR
    Ht = padT + Hd + (N - 1) * (-dvy) + padB
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    # วาดจากหลัง(แผ่นพื้น) -> หน้า(คิ้ว)  (index 0 = หน้าสุด ใน recipe) => วาด k=0 หลังสุด? recipe[0]=คิ้ว(หน้า)
    order = list(range(N - 1, -1, -1))    # วาดแผ่นพื้น(ท้าย recipe) ก่อน ... คิ้ว(หัว recipe) ทีหลัง = อยู่หน้า
    for k in order:
        L = out_layers[k]
        fillc = "rgba(148,163,184,0.16)" if L.get("kind") != "frame" else "none"
        out.append('<g fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round">' % (fillc, L["color"], lw))
        for sp in L["subs"]:
            out.append('<path d="%s"/>' % nesting._sp_d(place(sp, k)))
        out.append('</g>')
        # ป้ายชั้น (มุมขวาบนของชั้น)
        b = _bbox(L["subs"])
        lx = b[2] + (N - 1 - k) * dvx - gmnx + padL + fs * 0.5
        ly = b[1] + (N - 1 - k) * (-dvy) - gmny + padT + fs * 1.2
        off = L["off"]; oc = "ไซซ์เต็ม" if abs(off) < 1e-6 else ("%+.2f ซม." % (off / 10.0))
        knote = " · กรอบเจาะโบ๋" if L.get("kind") == "frame" else ""
        out.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s"/>' % (lx - fs * 0.6, ly - fs * 0.35, fs * 0.32, L["color"]))
        out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#334155">%s (%s)%s</text>'
                   % (lx, ly, fs * 0.82, _esc(L["name"]), oc, knote))
    # เส้นบอกมิติ "สูง" (ซ้ายสุด ของชั้นหน้า)
    aw = fs * 0.55
    x_h = padL - fs * 1.6; y0 = padT; y1 = padT + Hd
    out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (x_h, y0, x_h, y1, cd, lw))
    out.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (x_h - aw * 0.6, y0 + aw, x_h, y0, x_h + aw * 0.6, y0 + aw, cd, lw))
    out.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (x_h - aw * 0.6, y1 - aw, x_h, y1, x_h + aw * 0.6, y1 - aw, cd, lw))
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f cm</text>'
               % (x_h - fs * 0.6, (y0 + y1) / 2, fs * 0.95, cd, x_h - fs * 0.6, (y0 + y1) / 2, Hd / 10.0))
    # เส้นบอก "ลึก" (แนวเยื้อง) + ความสูงผนัง
    depth_cm = float(rec.get("depth_cm", 5.0))
    dx0 = padL + Wd * 0.5; dy0 = padT + Hd + fs * 1.2
    dxe = dx0 + (N - 1) * dvx; dye = dy0 + (N - 1) * (-dvy)
    out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f"/>' % (dx0, dy0, dxe, dye, cd, lw, fs * 0.4, fs * 0.3))
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">ลึก ~%.1f cm</text>' % ((dx0 + dxe) / 2 + fs * 0.3, (dy0 + dye) / 2 + fs * 1.1, fs * 0.9, cd, depth_cm))
    # ชื่อแบบ + เส้นรอบรูป
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a">%s</text>' % (padL, fs * 1.2, fs * 1.05, _esc(rec["name"])))
    ws = " · ".join("%s %g ซม." % (w["name"], w["h"]) for w in rec.get("walls", []) if w.get("h", 0) > 0)
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" fill="#64748b">ผนัง (แผ่นม้วน พับตามเส้นรอบรูป %.1f ซม. — ไม่ต้องตัด): %s</text>' % (padL, Ht - fs * 1.0, fs * 0.72, perimeter_cm, _esc(ws)))
    out.append('</svg>')
    return '\n'.join(out)


def _layerset_cut_svg(out_layers, wall_strips):
    """SVG 'ไฟล์ตัดแยก layer' — วางแต่ละชั้นเรียงข้างกัน (เหมือน DXF) สีต่อชั้น + แถบยกขอบ · พร้อมนำเข้า LightBurn/Illustrator/Nesting"""
    from vectorcnc import nesting

    def _bbox(subs):
        mnx = mny = 1e18; mxx = mxy = -1e18
        for sp in subs:
            pts = [sp["start"]]
            for s in sp["segs"]:
                pts.append(s[1]) if s[0] == "L" else pts.extend([s[1], s[2], s[3]])
            for (x, y) in pts:
                mnx = min(mnx, x); mny = min(mny, y); mxx = max(mxx, x); mxy = max(mxy, y)
        return mnx, mny, mxx, mxy

    metas = [(L, _bbox(L["subs"])) for L in out_layers]
    Smax = max([1.0] + [max(b[2] - b[0], b[3] - b[1]) for _, b in metas] + [s[1] for s in wall_strips] + [s[2] for s in wall_strips])
    gap = Smax * 0.12; fs = max(6.0, Smax * 0.028); lw = max(0.6, Smax * 0.0022)
    topPad = fs * 2.2
    maxH = max([b[3] - b[1] for _, b in metas] + [s[2] for s in wall_strips] + [1.0])
    parts = []; cursor = fs
    for L, b in metas:
        w = b[2] - b[0]; h = b[3] - b[1]; dx = cursor - b[0]; dy = topPad - b[1]

        def T(p, _dx=dx, _dy=dy):
            return (p[0] + _dx, p[1] + _dy)
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s">%s</text>' % (cursor, topPad - fs * 0.6, fs * 0.9, L["color"], _en_layer(L["name"])))
        parts.append('<g fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round" stroke-linecap="round">' % (L["color"], lw))
        for sp in L["subs"]:
            nsp = {"start": T(sp["start"]),
                   "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                   "closed": sp.get("closed", True)}
            parts.append('<path d="%s"/>' % nesting._sp_d(nsp))
        parts.append('</g>')
        cursor += w + gap
    for (nm, Lmm, Hmm) in wall_strips:
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#d97706">%s (fold)</text>' % (cursor, topPad - fs * 0.6, fs * 0.9, _en_wall(nm)))
        parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#f59e0b" stroke-width="%.2f"/>' % (cursor, topPad, Lmm, Hmm, lw))
        cursor += Lmm + gap
    Wt = cursor + fs; Ht = topPad + maxH + fs
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">%s</svg>'
            % (Wt, Ht, Wt, Ht, "".join(parts)))


def _ortho_views_svg(full, rec, depth_mm, inner_bore=None, face_color=None, side_color=None, metal_tex="", metal_tex_img="",
                     metal_tex_scope="face"):
    """📐 มุมมองมาตรฐานงานผลิต: Top View / Front View / Side View (orthographic)
       ใช้คู่กับภาพ Perspective (3 มิติหลัก) — โชว์ในหน้าออกแบบ + ใบสั่งผลิต"""
    b = full.bounds; W = b[2] - b[0]; H = b[3] - b[1]; D = max(10.0, float(depth_mm or 50.0))
    S = max(W, H, 1.0)
    PW, PH, GAP, PAD, LBL = 380.0, 300.0, 34.0, 22.0, 30.0
    _mtxd, _mtxfill, _mtxhair = _metal_defs(metal_tex, S, metal_tex_img)
    _punch = bool(rec.get("punch_face"))
    _scopeV = str(metal_tex_scope or "face").lower()
    _texFv = _mtxfill if _scopeV in ("face", "all") else None
    _texSv = _mtxfill if _scopeV in ("side", "all") else None
    metal = _texFv or ((side_color or "#c9cdd4") if _punch else (face_color or "#c9cdd4"))
    wall = _texSv or side_color or "#9aa1ac"; glow = face_color or "#fff3c4"
    edge = "#3f4753"; cd = "#dc2626"; fsL = 15.0; fsD = 12.5

    def ring(coords, s, tx, ty):
        return "M " + " L ".join("%.1f %.1f" % (x * s + tx, y * s + ty) for x, y in coords) + " Z"

    def poly_d(g, s, tx, ty):
        out = []
        for p in (list(g.geoms) if g.geom_type == "MultiPolygon" else [g]):
            if p.is_empty:
                continue
            d = ring(list(p.exterior.coords), s, tx, ty)
            for h in p.interiors:
                d += " " + ring(list(h.coords), s, tx, ty)
            out.append(d)
        return " ".join(out)

    TW = PW * 4 + GAP * 3 + PAD * 2; TH = PH + PAD * 2 + LBL + 26     # 📐 4 มุมมอง: Top · Front · Side · Back
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f">' % (TW, TH, TW, TH),
             '<rect width="%.0f" height="%.0f" fill="#f8fafc"/>' % (TW, TH)]
    if _mtxd:
        parts.append(_mtxd)

    def panel(i, title):
        px = PAD + i * (PW + GAP); py = PAD + LBL
        parts.append('<rect x="%.0f" y="%.0f" width="%.0f" height="%.0f" rx="8" fill="#ffffff" stroke="#e2e8f0"/>' % (px, py, PW, PH))
        parts.append('<text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="%.0f" font-weight="800" fill="#0f172a">%s</text>' % (px + 4, py - 8, fsL, title))
        return px, py

    def dims(px, py, txt):
        parts.append('<text x="%.0f" y="%.0f" font-family="Prompt,Arial" font-size="%.0f" font-weight="700" fill="%s" text-anchor="middle">%s</text>' % (px + PW / 2, py + PH + 18, fsD, cd, txt))

    # ── Top View: กว้าง × ลึก ──
    px, py = panel(0, "Top View (มองบน)")
    s = min((PW - 70) / W, (PH - 80) / D)
    rw = W * s; rd = D * s; rx = px + (PW - rw) / 2; ry = py + (PH - rd) / 2
    parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="1.4"/>' % (rx, ry, rw, rd, wall, edge))
    parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="1"/>' % (rx, ry, rw, max(3.0, rd * 0.18), metal, edge))
    dims(px, py, "กว้าง %.0f × ลึก %.0f ซม." % (W / 10.0, D / 10.0))

    # ── Front View: รูปทรงจริง (หน้าตรง) ──
    px, py = panel(1, "Front View (หน้าตรง)")
    s = min((PW - 70) / W, (PH - 80) / H)
    tx = px + (PW - W * s) / 2 - b[0] * s; ty = py + (PH - H * s) / 2 - b[1] * s
    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="1.4"/>' % (poly_d(full, s, tx, ty), metal, edge))
    if _texFv and _mtxhair:
        parts.append('<path d="%s" fill="url(#mtxh)" fill-rule="evenodd"/>' % poly_d(full, s, tx, ty))
    if inner_bore is not None and not inner_bore.is_empty:
        parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="0.9"/>' % (poly_d(inner_bore, s, tx, ty), glow, edge))
    dims(px, py, "กว้าง %.0f × สูง %.0f ซม." % (W / 10.0, H / 10.0))

    # ── Side View: ลึก × สูง ──
    px, py = panel(2, "Side View (ด้านข้าง)")
    s = min((PW - 70) / D, (PH - 80) / H)
    rd = D * s; rh = H * s; rx = px + (PW - rd) / 2; ry = py + (PH - rh) / 2
    parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="1.4"/>' % (rx, ry, rd, rh, wall, edge))
    parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="1"/>' % (rx, ry, max(3.0, rd * 0.18), rh, metal, edge))
    dims(px, py, "ลึก %.0f × สูง %.0f ซม." % (D / 10.0, H / 10.0))

    # ── Back View: ด้านหลัง (แผ่นหลัง + จุดยึด/ทางเข้าสายไฟ) — กลับซ้าย-ขวา ──
    px, py = panel(3, "Back View (ด้านหลัง)")
    s = min((PW - 70) / W, (PH - 80) / H)
    _bw = W * s; _bh = H * s
    _bx = px + (PW - _bw) / 2; _by = py + (PH - _bh) / 2
    parts.append('<g transform="translate(%.1f,%.1f) scale(-1,1) translate(%.1f,%.1f)">'
                 % (_bx + _bw, _by, -(_bx) - 0.0, -(_by)))
    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="1.4"/>'
                 % (poly_d(full, s, _bx - b[0] * s, _by - b[1] * s), "#cbd5e1", edge))
    parts.append('</g>')
    # จุดยึด 4 มุม + ทางเข้าสายไฟกลางล่าง
    for _fx, _fy in ((0.18, 0.20), (0.82, 0.20), (0.18, 0.80), (0.82, 0.80)):
        parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#ffffff" stroke="%s" stroke-width="1.2"/>'
                     % (_bx + _bw * _fx, _by + _bh * _fy, max(3.0, PW * 0.012), edge))
    parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="3" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/>'
                 % (_bx + _bw * 0.44, _by + _bh - max(10.0, PH * 0.055), _bw * 0.12, max(8.0, PH * 0.045)))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.0f" fill="#92400e" text-anchor="middle">สายไฟเข้า</text>'
                 % (_bx + _bw * 0.50, _by + _bh - max(1.0, PH * 0.012), fsD * 0.85))
    dims(px, py, "แผ่นหลัง %.0f × %.0f ซม. · จุดยึด 4 จุด" % (W / 10.0, H / 10.0))

    parts.append('</svg>')
    return "".join(parts)


def _led_color_card_svg(led_color, glow_mode="front"):
    """💡 ตัวอย่าง 'สีไฟที่ลูกค้าเลือก' — แถบไล่โทน + จุดตัวอย่างแสงจริง + ชื่อ/อุณหภูมิสี"""
    import re as _re2
    _txt = str(led_color or "Warm White 3000K")
    _k = ""
    _m = _re2.search(r"(\d{3,5})\s*K", _txt)
    if _m:
        _k = _m.group(1)
    _MAP = {"2700": "#ff9e3d", "3000": "#ffb45e", "4000": "#ffd9a0", "5000": "#fff3dc",
            "6500": "#dfeaff", "8000": "#b9d4ff", "11000": "#93bbff"}
    _c = _MAP.get(_k, "#ffb45e")
    if "RGB" in _txt.upper():
        _c = "#c084fc"
    W2, H2 = 460.0, 190.0
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f">' % (W2, H2, W2, H2),
         '<defs><radialGradient id="lcG" cx="0.5" cy="0.5" r="0.5">'
         '<stop offset="0" stop-color="%s" stop-opacity="1"/>'
         '<stop offset="0.55" stop-color="%s" stop-opacity="0.55"/>'
         '<stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
         '<linearGradient id="lcBar" x1="0" y1="0" x2="1" y2="0">'
         '<stop offset="0" stop-color="#ff9e3d"/><stop offset="0.25" stop-color="#ffb45e"/>'
         '<stop offset="0.45" stop-color="#ffd9a0"/><stop offset="0.62" stop-color="#fff3dc"/>'
         '<stop offset="0.78" stop-color="#dfeaff"/><stop offset="1" stop-color="#93bbff"/>'
         '</linearGradient></defs>' % (_c, _c, _c),
         '<rect width="%.0f" height="%.0f" rx="10" fill="#0b1220"/>' % (W2, H2),
         '<circle cx="118" cy="86" r="74" fill="url(#lcG)"/>',
         '<circle cx="118" cy="86" r="30" fill="%s"/>' % _c,
         '<text x="212" y="60" font-family="Prompt,Arial" font-size="21" font-weight="800" fill="#ffffff">%s</text>'
         % str(_txt).replace("&", "&amp;").replace("<", "&lt;")[:26],
         '<text x="212" y="86" font-family="Prompt,Arial" font-size="14" fill="#94a3b8">ตัวอย่างสีแสงที่ลูกค้าเลือก</text>']
    # แถบไล่โทน + เครื่องหมายตำแหน่งอุณหภูมิสี
    p.append('<rect x="212" y="102" width="224" height="16" rx="8" fill="url(#lcBar)"/>')
    try:
        _kk = float(_k or 3000)
        _pos = max(0.0, min(1.0, (_kk - 2700.0) / (11000.0 - 2700.0)))
        p.append('<polygon points="%.1f,98 %.1f,98 %.1f,124" fill="#ffffff"/>'
                 % (212 + 224 * _pos - 6, 212 + 224 * _pos + 6, 212 + 224 * _pos))
    except Exception:
        pass
    p.append('<text x="212" y="140" font-family="Prompt,Arial" font-size="11" fill="#64748b">2700K วอร์ม</text>')
    p.append('<text x="436" y="140" font-family="Prompt,Arial" font-size="11" fill="#64748b" text-anchor="end">11000K ฟ้าเย็น</text>')
    p.append('<text x="212" y="166" font-family="Prompt,Arial" font-size="12.5" fill="#cbd5e1">โหมดไฟ: %s</text>'
             % {"front": "ออกหน้า", "back": "ออกหลัง", "around": "ออกรอบ", "off": "ไม่มีไฟ"}.get(str(glow_mode), "ออกหน้า"))
    p.append('</svg>')
    return "".join(p)


def _front_sign_svg(full, rec, inner_bore=None, face_color=None, art_href="", frame_top_cm=0.0, sticker_geom=None,
                    bore_subs=None, art_adj=None,
                    side_color=None, metal_tex="", metal_tex_img="", metal_tex_scope="face"):
    """ภาพป้าย 'หน้าตรง' แบบ 3 มิติเบา ๆ (เงานุ่ม + คิ้ว/งานพิมพ์) พื้นโปร่ง — เอาไปวางบนผนังได้เลย
       frame_top_cm > 0 = วาด 'โครงเหล็กแขวน' (คานเพดาน + แขน 2 ข้าง สแตนเลส) เหนือป้าย (เฉพาะป้ายมีโครง)"""
    b = full.bounds; W = b[2] - b[0]; H = b[3] - b[1]; S = max(W, H, 1.0)
    pad = S * (0.012 if float(frame_top_cm) <= 0 else 0.08)   # วางผนัง = pad ~1% ให้ภาพ ≈ ตัวป้าย (ขนาด/สัดส่วนตรง)
    ftop = max(0.0, float(frame_top_cm)) * 10.0
    polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]

    def d(poly):
        s = ""
        for r in [poly.exterior] + list(poly.interiors):
            pts = list(r.coords)
            if not pts:
                continue
            s += "M " + " L ".join("%.2f %.2f" % (x - b[0] + pad, y - b[1] + pad + ftop) for (x, y) in pts) + " Z "
        return s

    def P(g):
        if g is None or g.is_empty:
            return []
        return list(g.geoms) if g.geom_type == "MultiPolygon" else [g]

    edge = "#3f4753"; lw = max(0.8, S * 0.0022); faceFill = face_color or "#eef4ff"
    _punchF = bool(rec.get("punch_face"))
    # 🪙 พื้นผิวโลหะ: ใช้กับหน้ากล่องฉลุ + แขนยึดสแตนเลส (ถ้าไม่เลือกพื้นผิว -> แขน = สแตนเลสเงินแฮร์ไลน์)
    _fmtxd, _fmtxfill, _fmtxhair = _metal_defs(metal_tex, S, metal_tex_img)
    _scopeF = str(metal_tex_scope or "face").lower()
    _ftexF = _fmtxfill if _scopeF in ("face", "all") else None
    _amtxd, _amtxfill, _ = ("", None, False)
    if not _fmtxfill:
        _amtxd, _amtxfill, _ = _metal_defs("silver_hairline", S)
    parts = ['<defs><filter id="fsh" x="-30%%" y="-30%%" width="160%%" height="160%%">'
             '<feDropShadow dx="0" dy="%.1f" stdDeviation="%.1f" flood-color="#0f172a" flood-opacity="0.32"/></filter></defs>'
             % (S * 0.022, S * 0.02)]
    if _fmtxd:
        parts.append(_fmtxd)
    elif _amtxd:
        parts.append(_amtxd)
    _steelFill = ((_fmtxfill if not metal_tex_img else None) or _amtxfill or "#c7cfd9")   # แขนยึด/คาน: ไม่ใช้ลาย custom
    if ftop > 0:                                       # 🔩 โครงแขวน (หน้าตรง) — คานเพดาน + แขน 2 ข้าง 'สแตนเลส'
        tw = max(8.0, S * 0.018); steel = _steelFill; steelD = "#5b626d"; surf = _steelFill; plateC = _steelFill
        cyb = pad * 0.5
        _isround = str(rec.get("box_shape") or "") in ("circle", "oval")
        _fxs = (0.40, 0.60) if _isround else (0.30, 0.70)   # ทรงกลม/วงรี -> แขนชิด center
        parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>' % (pad * 0.4, cyb - tw * 0.4, W + 2 * pad - pad * 0.8, tw * 0.8, surf, steelD, lw))
        for fx in _fxs:
            sx = b[0] + fx * W; _ty = b[1]
            try:                                            # แขนแตะ 'ผิวบนสุด' ของกล่องจริง (ไม่ลอย)
                from shapely.geometry import LineString as _LS
                _it = full.intersection(_LS([(sx, b[1] - 10.0), (sx, b[3] + 10.0)]))
                if _it is not None and not _it.is_empty:
                    _ty = _it.bounds[1]
            except Exception:
                _ty = b[1]
            ax = sx - b[0] + pad; armbot = (_ty - b[1]) + pad + ftop
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" stroke="%s" stroke-width="%.2f"/>' % (ax - tw / 2, cyb, tw, armbot - cyb + tw, steel, steelD, lw))
            parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="2" fill="%s" stroke="%s" stroke-width="%.2f"/>' % (ax - tw * 1.1, cyb - tw * 0.9, tw * 2.2, tw * 0.9, plateC, steelD, lw))
    parts.append('<g filter="url(#fsh)">')
    if art_href:                                       # หน้าพิมพ์
        # 🆕 ไม่มีคิ้ว (กล่องไฟอะคริลิคไฟออกรอบ / edge-lit) = หน้าพิมพ์เต็มใบ ไม่มีแถบคิ้วเทา ไม่เว้นขอบขาว
        _notrim = bool(rec.get("no_trim") or rec.get("edge_lit"))
        _kg = 0.0 if _notrim else 10.0                 # ความกว้างคิ้ว (มม.)
        _ag = max(1.5, S * 0.003) if _notrim else 14.0 # ระยะเว้น artwork จากขอบ (ไม่มีคิ้ว = เกือบเต็มขอบ)
        _baseFill = "#fffdf5" if _notrim else "#a9b4c4"
        _ik = full if _kg <= 0 else full.buffer(-_kg); _ia = full.buffer(-_ag)
        for pg in polys:                               # ฐานหน้า: ไม่มีคิ้ว=ขาวเรืองเต็มหน้า · มีคิ้ว=แถบเทา
            parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), _baseFill, edge, lw))
        if _kg > 0:                                    # พื้นขาวด้านใน — เฉพาะแบบมีคิ้ว
            for pg in P(_ik):
                parts.append('<path d="%s" fill="#ffffff" fill-rule="evenodd"/>' % d(pg))
        iap = P(_ia)
        if iap:
            parts.append('<defs><clipPath id="fArt" clip-rule="evenodd">%s</clipPath></defs>'
                         % "".join('<path d="%s"/>' % d(pg) for pg in iap))
            ab = _ia.bounds; cx = (ab[0] + ab[2]) / 2.0; cy = (ab[1] + ab[3]) / 2.0
            bw = ab[2] - ab[0]; bh = ab[3] - ab[1]
            if rec.get("box_shape") in ("circle", "oval"):
                bw *= 0.68; bh *= 0.68
            # 📐 ต้องใช้ 'ขนาด/ตำแหน่ง logo' ชุดเดียวกับภาพ 3 มิติเป๊ะ ๆ
            #    เดิมภาพหน้าตรงยืด artwork เต็มกรอบเสมอ -> พอส่งเข้าหน้าจำลองผนัง
            #    ตัวอักษรเลยชิดขอบ ไม่ตรงกับแบบที่ออกแบบไว้ด้านบน
            if art_adj:
                try:
                    _s = float(art_adj.get("s", 1.0)) or 1.0
                    _tw = float(art_adj.get("w_mm", 0) or 0); _th = float(art_adj.get("h_mm", 0) or 0)
                    _ar = float(art_adj.get("ar", 0) or 0)
                    if (_tw > 1.0 or _th > 1.0) and _ar > 0 and bw > 0.1 and bh > 0.1:
                        _fh = min(bh, bw / _ar)
                        if _fh > 0.1:
                            _s = max(0.02, min(20.0, (_th / _fh) if _th > 1.0 else (_tw / (_fh * _ar))))
                    bw *= _s; bh *= _s
                    cx += float(art_adj.get("dx", 0.0)); cy += float(art_adj.get("dy", 0.0))
                except Exception:
                    pass
            x0 = cx - bw / 2.0 - b[0] + pad; y0 = cy - bh / 2.0 - b[1] + pad
            parts.append('<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" '
                         'preserveAspectRatio="xMidYMid meet" clip-path="url(#fArt)"/>'
                         % (art_href, art_href, x0, y0, bw, bh))
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.2f"/>' % (d(pg), edge, lw))
    else:                                              # หน้าตัน (ตัวอักษร/ไม่พิมพ์) + คิ้วเจาะโบ๋
        # 🔦 กล่องฉลุ: หน้า = โลหะ (สแตนเลส/สีขอบ) · รู logo = อะคริลิคเรืองแสงวอร์ม — ห้ามสลับ!
        _mainFill = (_ftexF or side_color or "#c7cfd9") if _punchF else (_ftexF or faceFill)
        for pg in polys:
            parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), _mainFill, edge, lw))
        if _punchF and _ftexF and _fmtxhair:           # ✨ ลายแฮร์ไลน์บนหน้าโลหะ
            for pg in polys:
                parts.append('<path d="%s" fill="url(#mtxh)" fill-rule="evenodd"/>' % d(pg))
        _bd2 = ""
        if bore_subs:                                  # 🔦 รูฉลุจากเส้นตัดจริง (ตรงกับไฟล์ .ai)
            try:
                _q = []
                for _sp in bore_subs:
                    _s0 = (_sp["start"][0] - b[0] + pad, _sp["start"][1] - b[1] + pad + ftop)
                    _q.append("M %.2f %.2f" % _s0)
                    for _sg in _sp["segs"]:
                        if _sg[0] == "L":
                            _q.append("L %.2f %.2f" % (_sg[1][0] - b[0] + pad, _sg[1][1] - b[1] + pad + ftop))
                        else:
                            _q.append("C %.2f %.2f %.2f %.2f %.2f %.2f" % (
                                _sg[1][0] - b[0] + pad, _sg[1][1] - b[1] + pad + ftop,
                                _sg[2][0] - b[0] + pad, _sg[2][1] - b[1] + pad + ftop,
                                _sg[3][0] - b[0] + pad, _sg[3][1] - b[1] + pad + ftop))
                    _q.append("Z")
                _bd2 = " ".join(_q)
            except Exception:
                _bd2 = ""
        if _bd2:
            _pbF = face_color or "#ffd98a"
            parts.append('<defs><filter id="fsPGlow" x="-60%%" y="-60%%" width="220%%" height="220%%">'
                         '<feGaussianBlur stdDeviation="%.1f"/></filter></defs>' % max(4.0, S * 0.012))
            parts.append('<path d="%s" fill="%s" fill-rule="evenodd" opacity="0.9" filter="url(#fsPGlow)"/>' % (_bd2, _pbF))
            parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (_bd2, _pbF, edge, lw * 0.5))
        elif inner_bore is not None and not inner_bore.is_empty:
            if _punchF:                                # 💡 แสงวอร์มออกเฉพาะรู logo (ฮาโลฟุ้ง + เนื้อรูสว่าง)
                _pbF = face_color or "#ffd98a"
                parts.append('<defs><filter id="fsPGlow" x="-60%%" y="-60%%" width="220%%" height="220%%">'
                             '<feGaussianBlur stdDeviation="%.1f"/></filter></defs>' % max(4.0, S * 0.012))
                for pg in P(inner_bore):
                    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" opacity="0.9" filter="url(#fsPGlow)"/>' % (d(pg), _pbF))
                for pg in P(inner_bore):
                    parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), _pbF, edge, lw * 0.6))
            else:
                for pg in P(inner_bore):
                    parts.append('<path d="%s" fill="#eef1f5" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), edge, lw * 0.8))
    if sticker_geom is not None and not sticker_geom.is_empty:   # 🏷️ ชิ้นสติ๊กเกอร์ดำ (ไม่ตัด) บนหน้ากล่อง
        for pg in P(sticker_geom):
            parts.append('<path d="%s" fill="#15181d" fill-rule="evenodd" opacity="0.92"/>' % d(pg))
    parts.append('</g>')
    Wt = W + 2 * pad; Ht = H + 2 * pad + ftop
    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'width="%.1f" height="%.1f" viewBox="0 0 %.1f %.1f">%s</svg>' % (Wt, Ht, Wt, Ht, "".join(parts)))


def _skeleton_from_geom(full):
    """หา 'เส้นแกนกลาง' (centerline) จาก 'รูปเรขาคณิตตัวอักษร' (full) โดยตรง
       ใช้ได้แม้ไม่มีไฟล์ภาพ (เช่น ป้ายที่พิมพ์จากข้อความ) -> LED เส้นเดียวเดินตามรูปตัวอักษร"""
    import numpy as np
    from skimage.morphology import skeletonize
    from PIL import Image, ImageDraw
    b = full.bounds; fw = b[2] - b[0]; fh = b[3] - b[1]
    if fw <= 0 or fh <= 0:
        return []
    # ให้ 'ด้านสั้น' มีพิกเซลพอ (สแกนแกนตัวอักษรคม) แต่จำกัดด้านยาวไม่ให้ใหญ่เกิน
    RES = 300.0 / max(1e-6, min(fw, fh))
    if max(fw, fh) * RES > 2800:
        RES = 2800.0 / max(fw, fh)
    Wpx = max(2, int(fw * RES)); Hpx = max(2, int(fh * RES))
    img = Image.new("L", (Wpx, Hpx), 0); dr = ImageDraw.Draw(img)
    def _dp(poly):
        try:
            ext = [((x - b[0]) * RES, (y - b[1]) * RES) for (x, y) in poly.exterior.coords]
            if len(ext) >= 3:
                dr.polygon(ext, fill=255)
            for ring in poly.interiors:
                ip = [((x - b[0]) * RES, (y - b[1]) * RES) for (x, y) in ring.coords]
                if len(ip) >= 3:
                    dr.polygon(ip, fill=0)
        except Exception:
            pass
    geoms = list(getattr(full, "geoms", [full]))
    for g in geoms:
        if getattr(g, "geom_type", "") == "Polygon":
            _dp(g)
    a = np.array(img); mask = a > 128
    if not mask.any():
        return []
    sk = skeletonize(mask)
    return _trace_skeleton_mask(sk, full)

def _skeleton_subs(inp, full):
    """หา 'เส้นแกนกลาง' (centerline) ของลายเส้นภาพ -> polylines (subs) สำหรับนีออนเส้นเดี่ยว
       จัดตำแหน่ง/สเกลให้ตรงกับ full (กรอบเดียวกัน) · ถ้าไม่มีภาพ/สกัดไม่ได้ ใช้จากรูปตัวอักษรแทน"""
    import numpy as np
    from PIL import Image
    from skimage.morphology import skeletonize
    if not inp:
        return _skeleton_from_geom(full)
    im = Image.open(inp).convert("L")
    W, H = im.size
    scl = 1400.0 / max(W, H) if max(W, H) > 1400 else 1.0   # ลดขนาดกันช้า
    if scl < 1.0:
        im = im.resize((max(1, int(W * scl)), max(1, int(H * scl))), Image.LANCZOS); W, H = im.size
    a = np.array(im); mask = a < 128
    sk = skeletonize(mask)
    _r = _trace_skeleton_mask(sk, full)
    return _r if _r else _skeleton_from_geom(full)

def _trace_skeleton_mask(sk, full):
    """เดินตาม skeleton (bool array) -> subs (polylines) map เข้ากรอบ full"""
    import numpy as np
    from shapely.geometry import LineString
    fg = set(map(tuple, np.argwhere(sk)))
    if not fg:
        return []

    def nbrs(r, c):
        o = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if (dr or dc) and (r + dr, c + dc) in fg:
                    o.append((r + dr, c + dc))
        return o
    deg = {p: len(nbrs(*p)) for p in fg}
    nodes = set(p for p in fg if deg[p] != 2)
    visited = set(); raw = []
    starts = list(nodes) if nodes else [next(iter(fg))]
    for s in starts:
        for n in nbrs(*s):
            if (s, n) in visited:
                continue
            path = [s]; prev, cur = s, n; visited.add((s, n)); visited.add((n, s))
            while True:
                path.append(cur)
                if cur in nodes and cur != s:
                    break
                nx = [q for q in nbrs(*cur) if q != prev]
                if not nx:
                    break
                prev, cur = cur, nx[0]; visited.add((prev, cur)); visited.add((cur, prev))
            if len(path) >= 2:
                raw.append([(c, r) for (r, c) in path])   # (x=col, y=row)
    # วงปิด (ตัวอักษร O, รูใน) ที่ไม่มีปลาย/แยก — เดินตามลูปที่ยังไม่เยี่ยม
    for s in fg:
        for n in nbrs(*s):
            if (s, n) in visited:
                continue
            path = [s]; prev, cur = s, n; visited.add((s, n)); visited.add((n, s)); guard = 0
            while cur != s and guard < len(fg) + 5:
                guard += 1; path.append(cur)
                nx = [q for q in nbrs(*cur) if q != prev]
                if not nx:
                    break
                prev, cur = cur, nx[0]; visited.add((prev, cur)); visited.add((cur, prev))
            path.append(s)
            if len(path) >= 4:
                raw.append([(c, r) for (r, c) in path])
    if not raw:
        return []
    # จัดกรอบให้ตรงกับ full (map bbox -> bbox)
    xs = [p[0] for pl in raw for p in pl]; ys = [p[1] for pl in raw for p in pl]
    rxmin, rxmax, rymin, rymax = min(xs), max(xs), min(ys), max(ys)
    rw = max(1e-6, rxmax - rxmin); rh = max(1e-6, rymax - rymin)
    fb = full.bounds; fw = fb[2] - fb[0]; fh = fb[3] - fb[1]

    def mp(p):
        return (fb[0] + (p[0] - rxmin) / rw * fw, fb[1] + (p[1] - rymin) / rh * fh)
    tol = max(fw, fh) * 0.004
    spur = max(fw, fh) * 0.018   # ตัด 'หนวด/สปูร์' สั้นๆ ที่มุมตัวอักษร ให้เส้นเรียบเหมือนไฟออกหน้า
    subs = []
    for pl in raw:
        pts = [mp(p) for p in pl]
        try:
            ls = LineString(pts).simplify(tol)
            if ls.length < spur and len(pl) < 6:   # เส้นสั้นมาก + จุดน้อย = สปูร์ → ทิ้ง
                continue
            cc = list(ls.coords)
        except Exception:
            cc = pts
        if len(cc) >= 2:
            subs.append({"start": cc[0], "segs": [("L", q) for q in cc[1:]], "closed": False})
    return subs


def _neon_sign_svg(neon_full, acrylic, color="#00e5ff", neon_subs=None, tube_mm=None):
    """ภาพนีออนเฟล็กซ์ 'หน้าตรง' — เส้นไฟเรืองสีตามทรงงาน + แผ่นอะคริลิคใสรองหลัง (ล้อมทรง) พื้นโปร่ง"""
    b = acrylic.bounds; W = b[2] - b[0]; H = b[3] - b[1]; S = max(W, H, 1.0); pad = S * 0.09

    def d(poly):
        s = ""
        for r in [poly.exterior] + list(poly.interiors):
            pts = list(r.coords)
            if not pts:
                continue
            s += "M " + " L ".join("%.2f %.2f" % (x - b[0] + pad, y - b[1] + pad) for (x, y) in pts) + " Z "
        return s

    def P(g):
        if g is None or g.is_empty:
            return []
        return list(g.geoms) if g.geom_type == "MultiPolygon" else [g]

    tube = max(5.0, S * 0.014); glow = tube * 2.4
    if tube_mm:                                     # 💡 เส้นเดี่ยว: ท่อหนาเท่าของจริง (มม.) — เห็นชน/ล้นตั้งแต่ออกแบบ
        tube = float(tube_mm); glow = tube * 2.2
    parts = ['<defs><filter id="ng" x="-45%%" y="-45%%" width="190%%" height="190%%"><feGaussianBlur stdDeviation="%.1f"/></filter>'
             '<filter id="sh2" x="-30%%" y="-30%%" width="160%%" height="160%%"><feDropShadow dx="0" dy="%.1f" stdDeviation="%.1f" flood-color="#0f172a" flood-opacity="0.30"/></filter></defs>'
             % (tube * 0.85, S * 0.02, S * 0.02)]
    # แผ่นอะคริลิคใส (ล้อมทรง +3cm) — โปร่งแสง เห็นขอบ
    parts.append('<g filter="url(#sh2)">')
    for pg in P(acrylic):
        parts.append('<path d="%s" fill="#cfe8ff" fill-opacity="0.32" stroke="#7bb8e8" stroke-width="%.2f" stroke-linejoin="round"/>' % (d(pg), max(1.0, S * 0.003)))
    parts.append('</g>')

    def _subsd(subs):
        s = ""
        for sp in subs:
            st = sp["start"]; s += "M %.2f %.2f " % (st[0] - b[0] + pad, st[1] - b[1] + pad)
            for seg in sp["segs"]:
                if seg[0] == "L":
                    q = seg[1]; s += "L %.2f %.2f " % (q[0] - b[0] + pad, q[1] - b[1] + pad)
                else:
                    c1, c2, e = seg[1], seg[2], seg[3]
                    s += "C %.2f %.2f %.2f %.2f %.2f %.2f " % (c1[0]-b[0]+pad, c1[1]-b[1]+pad, c2[0]-b[0]+pad, c2[1]-b[1]+pad, e[0]-b[0]+pad, e[1]-b[1]+pad)
        return s
    nd = _subsd(neon_subs) if neon_subs else "".join(d(pg) for pg in P(neon_full))
    parts.append('<g fill="none" stroke="%s" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" filter="url(#ng)"><path stroke-width="%.2f" d="%s"/></g>' % (color, glow, nd))   # เรือง
    parts.append('<g fill="none" stroke="%s" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="%.2f" d="%s"/></g>' % (color, tube, nd))                                  # เส้นไฟ
    parts.append('<g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"><path stroke-width="%.2f" d="%s"/></g>' % (max(1.4, tube * 0.34), nd))     # แกนขาว
    # 🔩 จุดเจาะยึดผนัง (4 มุม) + 🔌 จุดสายไฟออก (กึ่งกลางล่าง) — บนแผ่นอะคริลิค
    ab = acrylic.bounds; cx = (ab[0] + ab[2]) / 2.0; ins = min(W, H) * 0.07 + 10.0
    rr = max(3.0, S * 0.008); mlw = max(1.0, S * 0.0022)
    # ✅ บังคับจุดหมุด/สายไฟให้อยู่ 'ในแผ่น' เสมอ (เผื่อขอบ = รัศมีรู + 6mm) — กันหลุดขอบแผ่น contour
    from shapely.geometry import Point as _PT
    try:
        _safe = acrylic.buffer(-(rr + 6.0))
        if _safe.is_empty:
            _safe = acrylic
    except Exception:
        _safe = acrylic
    try:
        _ctd = _safe.representative_point()
    except Exception:
        _ctd = acrylic.centroid

    def _snap_in(px, py):                                # ดึงเข้าหาใจกลางจนอยู่ในแผ่น
        try:
            if _safe.contains(_PT(px, py)):
                return px, py
            for _i in range(1, 25):
                t = _i / 24.0
                nx = px + (_ctd.x - px) * t; ny = py + (_ctd.y - py) * t
                if _safe.contains(_PT(nx, ny)):
                    return nx, ny
            return _ctd.x, _ctd.y
        except Exception:
            return px, py

    def _SC(x, y):
        return (x - b[0] + pad, y - b[1] + pad)
    for (mx, my) in ((ab[0] + ins, ab[1] + ins), (ab[2] - ins, ab[1] + ins),
                     (ab[0] + ins, ab[3] - ins), (ab[2] - ins, ab[3] - ins)):
        mx, my = _snap_in(mx, my)
        sx, sy = _SC(mx, my)
        parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#ffffff" stroke="#334155" stroke-width="%.2f"/>'
                     '<path d="M %.1f %.1f L %.1f %.1f M %.1f %.1f L %.1f %.1f" stroke="#334155" stroke-width="%.2f"/>'
                     % (sx, sy, rr, mlw, sx - rr, sy, sx + rr, sy, sx, sy - rr, sx, sy + rr, mlw * 0.7))
    _wxm, _wym = _snap_in(cx, ab[3] - ins)              # รูสายไฟออก กึ่งกลางล่าง (ในแผ่น)
    wx, wy = _SC(_wxm, _wym)
    parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fee2e2" stroke="#e11d48" stroke-width="%.2f"/>' % (wx, wy, rr * 1.3, mlw))
    _fz = max(9.0, S * 0.022)                            # legend
    _ly = H + 2 * pad - pad * 0.30
    parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="#334155" stroke-width="%.2f"/>'
                 '<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" fill="#334155">&#3619;&#3641;&#3648;&#3592;&#3634;&#3632;&#3618;&#3638;&#3604;&#3612;&#3609;&#3633;&#3591; &#216;6</text>'
                 % (pad, _ly - _fz * 0.32, rr, mlw, pad + rr * 1.8, _ly, _fz))
    parts.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fee2e2" stroke="#e11d48" stroke-width="%.2f"/>'
                 '<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" fill="#334155">&#3619;&#3641;&#3626;&#3634;&#3618;&#3652;&#3615;&#3629;&#3629;&#3585; &#216;10</text>'
                 % (pad + W * 0.42, _ly - _fz * 0.32, rr * 1.3, mlw, pad + W * 0.42 + rr * 2.2, _ly, _fz))
    # 📐 จับระยะ: แผ่นรองหลัง (แดง) + ตัวงานเส้นไฟ (เขียวหัวเป็ด) — ตัวเลขลากย้ายได้ที่หน้าเว็บ
    _fz2 = max(10.0, S * 0.026); _dlw = max(0.8, S * 0.0016)
    def _arr_h(x1, x2, y, col):
        a = min(6.0, (x2 - x1) * 0.18)
        return ('<path d="M %.1f %.1f L %.1f %.1f" stroke="%s" stroke-width="%.2f"/>'
                '<path d="M %.1f %.1f l %.1f %.1f l 0 %.1f z M %.1f %.1f l %.1f %.1f l 0 %.1f z" fill="%s"/>'
                % (x1, y, x2, y, col, _dlw, x1, y, a, -a * 0.45, a * 0.9, x2, y, -a, -a * 0.45, a * 0.9, col))
    def _arr_v(x, y1, y2, col):
        a = min(6.0, (y2 - y1) * 0.18)
        return ('<path d="M %.1f %.1f L %.1f %.1f" stroke="%s" stroke-width="%.2f"/>'
                '<path d="M %.1f %.1f l %.1f %.1f l %.1f 0 z M %.1f %.1f l %.1f %.1f l %.1f 0 z" fill="%s"/>'
                % (x, y1, x, y2, col, _dlw, x, y1, -a * 0.45, a, a * 0.9, x, y2, -a * 0.45, -a, a * 0.9, col))
    try:
        nb = neon_full.bounds
        # แผ่นรองหลัง: กว้าง (ใต้แผ่น) + สูง (ซ้าย)
        _yW = pad + H + pad * 0.34
        parts.append(_arr_h(pad, pad + W, _yW, '#dc2626'))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#dc2626" text-anchor="middle">%.1f &#3595;&#3617;.</text>'
                     % (pad + W / 2, _yW - _fz2 * 0.45, _fz2, W / 10.0))
        _xH = pad * 0.40
        parts.append(_arr_v(_xH, pad, pad + H, '#dc2626'))
        parts.append('<text font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#dc2626" text-anchor="middle" transform="translate(%.1f %.1f) rotate(-90)">%.1f &#3595;&#3617;.</text>'
                     % (_fz2, _xH - _fz2 * 0.45, pad + H / 2, H / 10.0))
        # ตัวงานเส้นไฟ: กว้าง (เหนือ art) + สูง (ขวา)
        ax1, ay1 = nb[0] - b[0] + pad, nb[1] - b[1] + pad
        ax2, ay2 = nb[2] - b[0] + pad, nb[3] - b[1] + pad
        _yA = max(pad * 0.5, ay1 - pad * 0.28)
        parts.append(_arr_h(ax1, ax2, _yA, '#0d9488'))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#0d9488" text-anchor="middle">%.1f &#3595;&#3617;.</text>'
                     % ((ax1 + ax2) / 2, _yA - _fz2 * 0.40, _fz2, (nb[2] - nb[0]) / 10.0))
        _xA = min(W + 2 * pad - pad * 0.35, ax2 + pad * 0.30)
        parts.append(_arr_v(_xA, ay1, ay2, '#0d9488'))
        parts.append('<text font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#0d9488" text-anchor="middle" transform="translate(%.1f %.1f) rotate(-90)">%.1f &#3595;&#3617;.</text>'
                     % (_fz2, _xA + _fz2 * 0.85, (ay1 + ay2) / 2, (nb[3] - nb[1]) / 10.0))
    except Exception:
        pass
    Wt = W + 2 * pad; Ht = H + 2 * pad
    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'width="%.1f" height="%.1f" viewBox="0 0 %.1f %.1f">%s</svg>' % (Wt, Ht, Wt, Ht, "".join(parts)))


def _neon_led_info(neon_full, color="#00e5ff", neon_subs=None, watt_per_m=8.0, volt=12.0, spare=1.3, W=760.0):
    """LED ของงานนีออนเฟล็กซ์ = 'เดินตามเส้นนีออน' (ตรงกับภาพ Perspective) + คำนวณกำลังไฟ/หม้อแปลง
       double = เส้นตามขอบทรง · single = แกนกลาง (skeleton)"""
    import math

    def _P(g):
        if g is None or g.is_empty:
            return []
        return list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    # ความยาวเส้นไฟ (มม.)
    if neon_subs:
        length_mm = 0.0
        for sp in neon_subs:
            px, py = sp["start"]
            for seg in sp["segs"]:
                q = seg[1] if seg[0] == "L" else seg[3]
                length_mm += math.hypot(q[0] - px, q[1] - py); px, py = q
    else:
        length_mm = sum(pg.length for pg in _P(neon_full))
    total_m = length_mm / 1000.0
    watts = total_m * float(watt_per_m)
    amps = watts / max(1.0, float(volt))
    transformer_w = int(math.ceil((watts * float(spare)) / 10.0) * 10)
    # พรีวิว: พื้นเข้ม + เส้นไฟตามแนวนีออน (เหมือน Perspective)
    b = neon_full.bounds; bw = b[2] - b[0]; bh = b[3] - b[1]; S = max(bw, bh, 1.0); pad = S * 0.07
    sc = W / max(bw, 1.0); Wt = (bw + 2 * pad) * sc; Ht = (bh + 2 * pad) * sc

    def _mp(x, y):
        return ((x - b[0] + pad) * sc, (y - b[1] + pad) * sc)

    def _dpoly(pg):
        s = ""
        for r in [pg.exterior] + list(pg.interiors):
            pts = list(r.coords)
            if pts:
                s += "M " + " L ".join("%.2f %.2f" % _mp(x, y) for (x, y) in pts) + " Z "
        return s

    def _dsubs(subs):
        s = ""
        for sp in subs:
            s += "M %.2f %.2f " % _mp(*sp["start"])
            for seg in sp["segs"]:
                q = seg[1] if seg[0] == "L" else seg[3]
                s += "L %.2f %.2f " % _mp(*q)
        return s
    nd = _dsubs(neon_subs) if neon_subs else "".join(_dpoly(pg) for pg in _P(neon_full))
    tw = max(2.0, S * 0.012 * sc)
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1f" height="%.1f" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    parts.append('<rect x="0" y="0" width="%.1f" height="%.1f" fill="#0f1522"/>' % (Wt, Ht))
    parts.append('<defs><filter id="ngl" x="-40%%" y="-40%%" width="180%%" height="180%%"><feGaussianBlur stdDeviation="%.1f"/></filter></defs>' % (tw * 0.9))
    parts.append('<g fill="none" stroke="%s" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" filter="url(#ngl)"><path stroke-width="%.2f" d="%s"/></g>' % (color, tw * 2.3, nd))
    parts.append('<g fill="none" stroke="%s" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="%.2f" d="%s"/></g>' % (color, tw, nd))
    parts.append('<g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"><path stroke-width="%.2f" d="%s"/></g>' % (max(1.0, tw * 0.32), nd))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#fbbf24">LED นีออน (เดินตามเส้น) · ยาว %.2f ม. · %.0f W · %.2f A (Ø12V) · หม้อแปลง %d W</text>'
                 % (pad * sc, Ht - pad * sc * 0.4, max(9.0, S * 0.02 * sc), total_m, watts, amps, transformer_w))
    parts.append('</svg>')
    return {"total_m": round(total_m, 2), "watts": round(watts), "amps": round(amps, 2),
            "transformer_w": transformer_w, "pitch_cm": 0, "preview_svg": "".join(parts),
            "neon": True}


def _svg_inline_group(svg_text, x, y, w, h, prefix="d0"):
    """🧩 ฝัง SVG อีกอันเข้าไปใน SVG หลัก แบบ 'เวกเตอร์แท้' (ไม่แปลงเป็นรูป)

    เปิดใน Illustrator แล้วคลิกเลือกทีละชิ้นได้ · แก้สีได้ · ขยายกี่เท่าก็ไม่แตก
    (ต่างจากการฝังเป็น <image> PNG ซึ่งเป็นรูปตายตัว แก้อะไรไม่ได้)

    เรื่องที่ต้องระวัง: ทั้ง 2 ไฟล์อาจตั้งชื่อ id ซ้ำกัน (gradient/filter/clipPath)
    ถ้าฝังดื้อ ๆ สีจะเพี้ยนเพราะไปอ้าง id ผิดตัว -> ต้องเติมคำนำหน้าให้ id ทุกตัวก่อน
    """
    import re as _re
    if not svg_text:
        return ""
    s = str(svg_text)
    m = _re.search(r'<svg[^>]*>', s)
    if not m:
        return ""
    head = m.group(0)
    body = s[m.end():]
    body = _re.sub(r'</svg>\s*$', '', body.strip())
    # ขนาดพื้นที่วาดต้นทาง (viewBox) ไว้คำนวณอัตราย่อ/ขยาย
    vb = _re.search(r'viewBox\s*=\s*"([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)"', head)
    if vb:
        vx, vy, vw, vh = (float(vb.group(i)) for i in (1, 2, 3, 4))
    else:
        vx = vy = 0.0
        vw = float((_re.search(r'width\s*=\s*"([\d.]+)', head) or [0, "100"])[1])
        vh = float((_re.search(r'height\s*=\s*"([\d.]+)', head) or [0, "100"])[1])
    if vw <= 0 or vh <= 0:
        return ""
    # 🔑 เติมคำนำหน้าให้ id ทุกตัว + ทุกที่ที่อ้างถึง (url(#id) และ href="#id")
    ids = set(_re.findall(r'\bid\s*=\s*"([^"]+)"', body))
    for _i in ids:
        _n = "%s_%s" % (prefix, _i)
        body = body.replace('id="%s"' % _i, 'id="%s"' % _n)
        body = body.replace('url(#%s)' % _i, 'url(#%s)' % _n)
        body = body.replace('href="#%s"' % _i, 'href="#%s"' % _n)
        body = body.replace('xlink:href="#%s"' % _i, 'xlink:href="#%s"' % _n)
    sc = min(float(w) / vw, float(h) / vh)             # ย่อให้พอดีช่อง คงสัดส่วนเดิม
    ox = float(x) + (float(w) - vw * sc) / 2.0
    oy = float(y) + (float(h) - vh * sc) / 2.0
    return ('<g transform="translate(%.3f %.3f) scale(%.6f) translate(%.3f %.3f)">%s</g>'
            % (ox, oy, sc, -vx, -vy, body))


def _layerset_ai_svg(out_layers, art_href="", art_bounds=None, design_href=""):
    """SVG สำหรับบันทึกเป็น .ai — แยกแต่ละชั้นโครงสร้างเป็น 'กลุ่ม/เลเยอร์' ชัดเจน (Illustrator เลือกแยกได้)
       + พาเนล 'งานพิมพ์' (ภาพจริง) วางไว้เป็นเลเยอร์แรก · เรียงข้างกันไม่ทับ"""
    from vectorcnc import nesting

    def _bbox(subs):
        mnx = mny = 1e18; mxx = mxy = -1e18
        for sp in subs:
            pts = [sp["start"]]
            for s in sp["segs"]:
                pts.append(s[1]) if s[0] == "L" else pts.extend([s[1], s[2], s[3]])
            for (x, y) in pts:
                mnx = min(mnx, x); mny = min(mny, y); mxx = max(mxx, x); mxy = max(mxy, y)
        return mnx, mny, mxx, mxy

    metas = [(L, _bbox(L["subs"])) for L in out_layers]
    Smax = max([1.0] + [max(b[2] - b[0], b[3] - b[1]) for _, b in metas])
    gap = Smax * 0.14; fs = max(6.0, Smax * 0.03); lw = max(0.6, Smax * 0.0024)
    topPad = fs * 2.4
    maxH = max([b[3] - b[1] for _, b in metas] + [1.0])
    parts = []; cursor = fs
    # 🧊 เลเยอร์ 'แบบที่ออกแบบเสร็จแล้ว' — ป้ายประกอบเต็มตัว พร้อมขาตั้ง/ล้อ/แขน + เส้นจับระยะ
    #    ช่างเปิดไฟล์ .ai แล้วเห็นทันทีว่าของจริงหน้าตายังไง ไม่ต้องเปิดหน้าเว็บดูคู่กัน
    #    ปิดเลเยอร์นี้ใน Illustrator ก่อนส่งเข้าเครื่องตัดได้ (ไม่ปนกับชั้นตัด)
    if design_href:
        _dh = maxH; _dw = maxH * 0.78
        _inner = _svg_inline_group(design_href, cursor, topPad, _dw, _dh, prefix="dsn")
        if _inner:
            parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#7c3aed">DESIGN (assembled preview)</text>'
                         % (cursor, topPad - fs * 0.6, fs * 0.9))
            parts.append('<g id="DESIGN" inkscape:groupmode="layer" inkscape:label="DESIGN (assembled preview)">'
                         + _inner + '</g>')
            cursor += _dw + gap
    # 🖨️ เลเยอร์งานพิมพ์ (ภาพจริง) — วางเป็นพาเนลแรก
    if art_href and art_bounds is not None:
        aw = art_bounds[2] - art_bounds[0]; ah = art_bounds[3] - art_bounds[1]
        sc = maxH / ah if ah > 0 else 1.0
        pw = aw * sc; ph = maxH
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="#0d9488">PRINT ARTWORK</text>' % (cursor, topPad - fs * 0.6, fs * 0.9))
        parts.append('<g id="PRINT" inkscape:groupmode="layer" inkscape:label="PRINT ARTWORK">'
                     '<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" preserveAspectRatio="xMidYMid meet"/></g>'
                     % (art_href, art_href, cursor, topPad, pw, ph))
        cursor += pw + gap
    # 🔩 แต่ละชั้นโครงสร้าง = คนละเลเยอร์ (เติมสีจาง + เส้นขอบสีชั้น)
    for L, b in metas:
        w = b[2] - b[0]; h = b[3] - b[1]; dx = cursor - b[0]; dy = topPad - b[1]

        def T(p, _dx=dx, _dy=dy):
            return (p[0] + _dx, p[1] + _dy)
        lyname = _en_layer(L["name"])
        L = dict(L); L["subs"] = _dedup_subs(L.get("subs"))     # 🧹 กันเส้นซ้อนหลุดเข้าไฟล์ .ai
        _isprint = (L.get("kind") == "print")
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s">%s</text>' % (cursor, topPad - fs * 0.6, fs * 0.9, L["color"], lyname))
        if _isprint:
            # 🖨️ เลเยอร์งานพิมพ์/สติ๊กเกอร์ = 'ตัวหนังสือทึบสีดำ' พร้อมพิมพ์จริง
            #    รวมทุกเส้นเป็น path เดียว + fill-rule evenodd -> รูในตัวอักษร (ช่อง อ/ย/ู) โปร่งถูกต้อง ไม่ตัน
            parts.append('<g id="PRINT_%s" inkscape:groupmode="layer" inkscape:label="%s" fill="#000000" fill-rule="evenodd" stroke="none">'
                         % (_dxf_layer(lyname), lyname))
            _dall = []
            for sp in L["subs"]:
                nsp = {"start": T(sp["start"]),
                       "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                       "closed": True}
                _dall.append(nesting._sp_d(nsp))
            if _dall:
                parts.append('<path d="%s"/>' % " ".join(_dall))
            parts.append('</g>')
            cursor += w + gap
            continue
        # ✂️ ชั้นเส้นตัด = 'เส้นเปล่า' ล้วน ๆ ห้ามใส่พื้น (fill)
        #    ถ้าใส่ทั้งพื้นและเส้น ตอนแปลงลง .ai จะแตกเป็น 2 object ทับกัน
        #    ช่างเปิดใน Illustrator แล้วเจอเส้นซ้อน แยกออกมาได้ 2-3 ก้อน ต้องมานั่งเดาว่าอันไหนใช้ได้
        #    เส้นเปล่า = 1 ชิ้น 1 เส้นปิด เอาไปตัดได้เลย (คิ้วเป็นวงแหวน จึงมี 2 เส้น = นอก+ใน ถูกต้อง)
        parts.append('<g id="CUT_%s" inkscape:groupmode="layer" inkscape:label="%s" fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round">'
                     % (_dxf_layer(lyname), lyname, L["color"], lw))
        for sp in L["subs"]:
            nsp = {"start": T(sp["start"]),
                   "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                   "closed": sp.get("closed", True)}
            parts.append('<path d="%s"/>' % nesting._sp_d(nsp))
        parts.append('</g>')
        cursor += w + gap
    Wt = cursor + fs; Ht = topPad + maxH + fs
    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
            'width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">%s</svg>'
            % (Wt, Ht, Wt, Ht, "".join(parts)))


# 🖨️ ============ ไฟล์งานพิมพ์หน้ากล่องไฟ (UV / สติ๊กเกอร์) ============
_PRINT_MODES = {
    "uv": {"th": "พิมพ์ UV ลงแผ่นโดยตรง", "en": "UV Direct Print",
           "bleed": 0.0, "cutname": "TrimLine (แนวตัดแผ่น)", "cutcol": "#0d9488",
           "note": "พิมพ์ UV ลงบนแผ่นอะคริลิค/พลาสวูดโดยตรง · ไม่มีเลย์เยอร์กาว · เผื่อขอบ 0 มม. (ตัดตามเส้น TrimLine)"},
    "sticker": {"th": "พิมพ์สติ๊กเกอร์ + ไดคัท", "en": "Printed Sticker + Die-cut",
                "bleed": 3.0, "cutname": "CutContour (เส้นไดคัทสติ๊กเกอร์)", "cutcol": "#ff00ff",
                "note": "พิมพ์สติ๊กเกอร์แล้วไดคัทตามเส้น CutContour · เผื่อตก (bleed) 3 มม. รอบชิ้น · ลามิเนตกันแดดก่อนติด"},
}


# วัสดุที่ 'พิมพ์ลงผิว' ได้ ต่อประเภทป้าย (ใช้เขียนในบล็อกข้อมูลของไฟล์งานพิมพ์)
_PRINT_MAT = {
    "22": "พลาสวูด (พิมพ์ UV ลงผิวได้)", "23": "พลาสวูด 2 ชั้น (พิมพ์ UV ลงผิวได้)",
    "24": "อะคริลิค (พิมพ์ UV ลงผิวได้)", "25": "อะคริลิค 2 ชั้น (พิมพ์ UV ลงผิวได้)",
    "20": "แผ่นแบน ไดคัท (พิมพ์ UV ลงผิวได้)",
}


def _print_file_svg(art_href, bounds, mode="uv", title="", material="", extra_subs=None):
    """ไฟล์งานพิมพ์ 'ขนาดจริง 1:1 (มม.)' สำหรับหน้ากล่องไฟ
       - เลเยอร์ ARTWORK  = ภาพงานพิมพ์วางเต็มหน้าป้าย (ขนาดจริง)
       - เลเยอร์ BLEED    = กรอบเผื่อตก (สติ๊กเกอร์ 3 มม. · UV 0 มม.)
       - เลเยอร์ CutContour/TrimLine = เส้นไดคัท/เส้นตัดแผ่น (สปอตสีชมพูตามมาตรฐานโรงพิมพ์)
       - เลเยอร์ INFO     = บล็อกข้อมูลงาน (ขนาด · วิธีพิมพ์ · วัสดุ)"""
    from vectorcnc import nesting
    M = _PRINT_MODES.get(str(mode or "uv").lower(), _PRINT_MODES["uv"])
    x0, y0, x1, y1 = [float(v) for v in bounds]
    W = max(1.0, x1 - x0); H = max(1.0, y1 - y0)
    bl = float(M["bleed"])
    PAD = max(24.0, min(W, H) * 0.09)             # ขอบกระดาษรอบชิ้นงาน
    INFO = max(34.0, min(W, H) * 0.14)            # แถบข้อมูลด้านล่าง
    TW = W + bl * 2 + PAD * 2
    TH = H + bl * 2 + PAD * 2 + INFO
    ax = PAD + bl; ay = PAD + bl                  # มุมซ้ายบนของ 'ตัวงานจริง'
    fs = max(4.0, min(W, H) * 0.030)
    lw = max(0.25, min(W, H) * 0.0016)
    P = ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
         'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
         'width="%.2fmm" height="%.2fmm" viewBox="0 0 %.2f %.2f">' % (TW, TH, TW, TH)]
    P.append('<rect x="0" y="0" width="%.2f" height="%.2f" fill="#ffffff"/>' % (TW, TH))
    # 1) ARTWORK — ขนาดจริง 1:1
    if art_href:
        P.append('<g id="ARTWORK" inkscape:groupmode="layer" inkscape:label="ARTWORK (1:1)">'
                 '<image href="%s" xlink:href="%s" x="%.3f" y="%.3f" width="%.3f" height="%.3f" '
                 'preserveAspectRatio="none"/></g>' % (art_href, art_href, ax, ay, W, H))
    # 2) BLEED — กรอบเผื่อตก (เฉพาะสติ๊กเกอร์)
    if bl > 0:
        P.append('<g id="BLEED" inkscape:groupmode="layer" inkscape:label="BLEED %.0fmm">'
                 '<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="none" stroke="#94a3b8" '
                 'stroke-width="%.2f" stroke-dasharray="%.2f %.2f"/></g>'
                 % (bl, ax - bl, ay - bl, W + bl * 2, H + bl * 2, lw, fs * 0.6, fs * 0.4))
    # 3) CutContour / TrimLine — เส้นไดคัท (ตามรูปจริงถ้ามี ไม่งั้นเป็นกรอบสี่เหลี่ยม)
    P.append('<g id="CutContour" inkscape:groupmode="layer" inkscape:label="%s" fill="none" '
             'stroke="%s" stroke-width="%.2f">' % (M["cutname"], M["cutcol"], max(0.3, lw * 1.6)))
    _drew = False
    if extra_subs:
        for sp in extra_subs:
            try:
                nsp = {"start": (sp["start"][0] - x0 + ax, sp["start"][1] - y0 + ay),
                       "segs": [("L", (s[1][0] - x0 + ax, s[1][1] - y0 + ay)) if s[0] == "L"
                                else ("C", (s[1][0] - x0 + ax, s[1][1] - y0 + ay),
                                      (s[2][0] - x0 + ax, s[2][1] - y0 + ay),
                                      (s[3][0] - x0 + ax, s[3][1] - y0 + ay)) for s in sp["segs"]],
                       "closed": sp.get("closed", True)}
                P.append('<path d="%s"/>' % nesting._sp_d(nsp)); _drew = True
            except Exception:
                pass
    if not _drew:
        P.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f"/>' % (ax, ay, W, H))
    P.append('</g>')
    # 4) INFO — บล็อกข้อมูลงาน (ไม่ต้องพิมพ์ · ลบทิ้งได้)
    iy = PAD + bl * 2 + H + PAD * 0.55
    P.append('<g id="INFO" inkscape:groupmode="layer" inkscape:label="INFO (do not print)">')
    P.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="#cbd5e1" stroke-width="%.2f"/>'
             % (PAD, iy - fs * 1.1, TW - PAD, iy - fs * 1.1, lw))
    P.append('<text x="%.2f" y="%.2f" font-family="Prompt,Arial" font-size="%.2f" font-weight="800" fill="#0f172a">%s · %s</text>'
             % (PAD, iy + fs * 0.9, fs * 1.25, _xesc(M["th"]), _xesc(M["en"])))
    P.append('<text x="%.2f" y="%.2f" font-family="Prompt,Arial" font-size="%.2f" fill="#334155">'
             'ขนาดงานจริง %.1f × %.1f ซม. · เผื่อตก %.0f มม. · %s</text>'
             % (PAD, iy + fs * 2.4, fs, W / 10.0, H / 10.0, bl, _xesc(material or "-")))
    P.append('<text x="%.2f" y="%.2f" font-family="Prompt,Arial" font-size="%.2f" fill="#64748b">%s</text>'
             % (PAD, iy + fs * 3.7, fs * 0.9, _xesc(M["note"])))
    if title:
        P.append('<text x="%.2f" y="%.2f" font-family="Prompt,Arial" font-size="%.2f" fill="#64748b" text-anchor="end">%s</text>'
                 % (TW - PAD, iy + fs * 0.9, fs * 0.95, _xesc(title)))
    P.append('</g></svg>')
    return "".join(P)


def _xesc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _mount_plate_files(plate_cm=10.0, arm="side1"):
    """ไฟล์ตัด 'เพลทยึด' 10cm เจาะ 4 รู (ตามจำนวนแขน) -> DXF + SVG (มม.) เข้าเลเซอร์/CNC ทำเพลทจริง"""
    import ezdxf, io, base64
    P = float(plate_cm) * 10.0
    n = 1 if str(arm) == "side1" else 2
    hole_r = 5.0; ins = P / 2.0 - 18.0; gap = 30.0
    doc = ezdxf.new(); doc.header["$INSUNITS"] = 4
    for nm, col in (("Plate", 5), ("Holes", 1)):
        if nm not in doc.layers:
            doc.layers.add(nm, color=col)
    msp = doc.modelspace()
    for k in range(n):
        ox = k * (P + gap)
        msp.add_lwpolyline([(ox, 0), (ox + P, 0), (ox + P, P), (ox, P)], close=True, dxfattribs={"layer": "Plate"})
        cx, cy = ox + P / 2, P / 2
        for bx, by in ((-ins, -ins), (ins, -ins), (-ins, ins), (ins, ins)):
            msp.add_circle((cx + bx, cy + by), hole_r, dxfattribs={"layer": "Holes"})
    s = io.StringIO(); doc.write(s)
    dxf = base64.b64encode(s.getvalue().encode("utf-8")).decode()
    W = n * P + (n - 1) * gap
    p = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (W, P, W, P)]
    for k in range(n):
        ox = k * (P + gap)
        p.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#ec008c" stroke-width="0.3"/>' % (ox, 0, P, P))
        cx, cy = ox + P / 2, P / 2
        for bx, by in ((-ins, -ins), (ins, -ins), (-ins, ins), (ins, ins)):
            p.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="#ec008c" stroke-width="0.3"/>' % (cx + bx, cy + by, hole_r))
    p.append('</svg>')
    return {"dxf_base64": dxf, "svg": "".join(p), "count": n, "plate_cm": float(plate_cm)}



# ══════════════════════════════════════════════════════════════════════════════
# 🏭 ประกอบ "ไฟล์สั่งผลิต" (.ai + ไฟล์งานพิมพ์) จากค่าที่คำนวณไว้แล้ว
#    ใช้ร่วมกัน 2 ทาง แล้วได้ไฟล์เหมือนกันเป๊ะทุกไบต์:
#      (1) กดปุ่มแสดงแบบ 3 มิติ พร้อมสร้างไฟล์ในคำขอเดียว (ค่าเริ่มต้นเดิมของระบบ)
#      (2) กดปุ่ม 'สร้างไฟล์ตัดสั่งผลิต (.ai)' ทีหลัง -> ดึงค่าที่เก็บไว้มาประกอบทันที
#         ไม่คำนวณเส้นตัดใหม่ ไม่ปั้นภาพ 3 มิติใหม่ (พี่สั่งไว้ 2026-07-30)
#    ⚠️ เนื้อโค้ดข้างในยกมาจากของเดิมทั้งดุ้น ห้ามแก้ — ไฟล์สั่งผลิตต้องไม่เปลี่ยนแม้แต่ไบต์เดียว
# ══════════════════════════════════════════════════════════════════════════════
_PRODCACHE = {"map": {}, "order": [], "cap": 3}      # 🧺 ค่าที่คำนวณไว้รอกดสร้างไฟล์ (เก็บ 3 งานล่าสุด)


def _prod_files(B):
    inp = B["inp"]; rec = B["rec"]; sign_type = B["sign_type"]
    real_width_mm = B["real_width_mm"]; face_print = B["face_print"]
    out_layers = B["out_layers"]; full = B["full"]; svg3d = B["svg3d"]
    _sticker_geom = B["sticker_geom"]; _punch_raw_subs = B["punch_raw_subs"]
    _RAW_SUBS = {"subs": B["raw_subs"]}
    warns = []
    # 🅰️ .ai — แยกเลเยอร์โครงสร้างชัด + เลเยอร์งานพิมพ์ (Illustrator เปิดเลือกแยกได้)
    ai_b64 = ""
    try:
        # ภาพพิมพ์ในไฟล์ผลิต .ai = ความละเอียดสูง (พิมพ์จริงได้) เฉพาะป้ายหน้าพิมพ์
        _art_ai = (_art_data_uri(inp, max_px=2600) if rec.get("face_finish") == "print" else "")
        # 🖨️ เลเยอร์ 'งานพิมพ์/สติ๊กเกอร์' — ชิ้นที่ไม่ตัด (พิมพ์+ไดคัทสติ๊กเกอร์) แยกออกมาในไฟล์เดียวกัน
        _ai_extra = []
        try:
            if _sticker_geom is not None and not _sticker_geom.is_empty:
                # 🖨️ งานพิมพ์: ใช้รูปทรงจริง (รวมรูในตัวอักษร) -> ตัวหนังสือทึบดำ อ่านออก ไม่เละ
                _ss = _cut_subs_offset(_sticker_geom, float(real_width_mm), clean=False)
                if _punch_raw_subs:                       # ใช้เส้นดิบถ้ามี (คมกว่า)
                    from shapely.prepared import prep as _pp4
                    from shapely.geometry import Point as _Pt4
                    _pk4 = _pp4(_sticker_geom.buffer(1.0)); _rs4 = []
                    for _sp4 in (_RAW_SUBS.get("subs") or []):
                        _an4 = [_sp4["start"]] + [s[-1] for s in _sp4["segs"]]
                        _st4 = max(1, len(_an4) // 8)
                        if any(_pk4.intersects(_Pt4(p[0], p[1])) for p in _an4[::_st4]):
                            _rs4.append(_sp4)
                    if _rs4:
                        _ss = _rs4
                if _ss:
                    _sb4 = _sticker_geom.bounds
                    _ai_extra.append({"name": "งานพิมพ์ / สติ๊กเกอร์ (ไม่ตัดโลหะ)", "off": 0.0, "kind": "print",
                                      "color": "#e11d48", "rgb": (225, 29, 72), "subs": _ss,
                                      "w_mm": round(_sb4[2] - _sb4[0], 1), "h_mm": round(_sb4[3] - _sb4[1], 1)})
        except Exception:
            pass
        # 🧊 แนบ 'แบบที่ออกแบบเสร็จแล้ว' (ป้ายประกอบเต็มตัว + ขา/ล้อ/แขน + เส้นจับระยะ)
        #    ส่ง SVG ดิบเข้าไปเลย -> ฝังเป็นเวกเตอร์แท้ในไฟล์ .ai (ไม่ใช่รูปฝัง)
        ai_svg = _layerset_ai_svg(out_layers + _ai_extra, art_href=_art_ai,
                                  art_bounds=full.bounds, design_href=(svg3d or ""))
        import cairosvg as _cs
        ai_b64 = base64.b64encode(_cs.svg2pdf(bytestring=ai_svg.encode("utf-8"))).decode()
    except Exception:
        ai_b64 = ""
    # 🖨️ ============ ไฟล์งานพิมพ์หน้ากล่องไฟ (แยกไฟล์ · ขนาดจริง 1:1) ============
    #     เลือกได้ตั้งแต่ตอนออกแบบว่า 'พิมพ์ UV' หรือ 'พิมพ์สติ๊กเกอร์ + ไดคัท'
    print_b64 = ""; print_info = {}
    _pmode = str(face_print or "uv").lower()
    try:
        _face_is_print = (rec.get("face_finish") == "print")
        _has_sticker = (_sticker_geom is not None and not _sticker_geom.is_empty)
        # 🖨️ เปิดไฟล์งานพิมพ์ให้ 'ทุกประเภทป้าย' — กล่องไฟพิมพ์หน้า · ไดคัทพลาสวูด/อะคริลิค พิมพ์ลงผิว/ติดสติ๊กเกอร์
        if _pmode not in ("none", "off") and full is not None and not full.is_empty:
            _M = _PRINT_MODES.get(_pmode, _PRINT_MODES["uv"])
            if _has_sticker and not _face_is_print:
                # เลือกเฉพาะบางชิ้นเป็นสติ๊กเกอร์ -> พิมพ์เฉพาะชิ้นนั้น (ทึบดำ พร้อมไดคัท)
                _pb = _sticker_geom.bounds
                _phref = ""
                _pcut = _cut_subs_offset(_sticker_geom, float(real_width_mm), clean=False)
                _pmat = "สติ๊กเกอร์พิมพ์ + ไดคัทตามรูป (เฉพาะชิ้นที่เลือก)"
            else:
                # พิมพ์เต็มหน้างาน -> ใช้รูปงานจริงความละเอียดสูง + เส้นตัด/ไดคัทตามทรงงาน
                _pb = full.bounds
                _phref = _art_data_uri(inp, max_px=3200)
                _pcut = _cut_subs_offset(full, float(real_width_mm), clean=False)
                _pmat = str(rec.get("face_material", "")) or _PRINT_MAT.get(str(sign_type), "ตามสเปควัสดุหน้างาน")
                if _pmode == "sticker":
                    _pmat = "สติ๊กเกอร์พิมพ์ + ลามิเนตกันแดด (ติดทับผิว %s)" % _pmat
            _psvg = _print_file_svg(_phref, _pb, mode=_pmode,
                                    title="VectorCNC · %s" % str(rec.get("name", "")),
                                    material=_pmat, extra_subs=_pcut)
            import cairosvg as _cs2
            print_b64 = base64.b64encode(_cs2.svg2pdf(bytestring=_psvg.encode("utf-8"))).decode()
            print_info = {"mode": _pmode, "label_th": _M["th"], "label_en": _M["en"],
                          "bleed_mm": _M["bleed"], "cut_layer": _M["cutname"],
                          "w_cm": round((_pb[2] - _pb[0]) / 10.0, 1),
                          "h_cm": round((_pb[3] - _pb[1]) / 10.0, 1),
                          "material": _pmat, "note": _M["note"]}
            warns.append("🖨️ ไฟล์งานพิมพ์: %s · ขนาดจริง %.1f × %.1f ซม. · เผื่อตก %.0f มม. · เลเยอร์ %s"
                         % (_M["th"], print_info["w_cm"], print_info["h_cm"], _M["bleed"], _M["cutname"]))
    except Exception as _e5:
        print_b64 = ""; print_info = {"error": str(_e5)}
    return ai_b64, print_b64, print_info, warns


@app.post("/api/layer-set")
async def layer_set(file: UploadFile = File(...), sign_type: str = Form("1"),
                    real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                    return_depth_cm: float = Form(0.0), trim_width_cm: float = Form(1.0),
                    trim_dir: str = Form("out"), face_color: str = Form(""),
                    side_color: str = Form(""), n_colors: int = Form(6),
                    arm: str = Form("none"), arm_len_cm: float = Form(30.0),
                    arm_side: str = Form("right"), arm_adjust: str = Form("fixed"),
                    arm_travel_cm: float = Form(0.0), neon_color: str = Form("#00e5ff"),
                    neon_line: str = Form("double"), neon_plate: str = Form("contour"),
                    neon_margin_cm: float = Form(5.0),
                    frame_bars: int = Form(1), frame_level_cm: float = Form(-1.0),
                    frame_gap_cm: float = Form(20.0), frame_x_cm: float = Form(0.0),
                    frame_standoff_cm: float = Form(5.0), wire_offset_cm: float = Form(0.0),
                    led_pitch_cm: float = Form(6.0), arm_edge_cm: float = Form(20.0),
                    arm_gap_cm: float = Form(0.0),
                    leg_h_cm: float = Form(70.0), leg_span_cm: float = Form(0.0),
                    caster_mm: float = Form(75.0), caster_lock: str = Form('1'),
                    logo_scale: float = Form(100.0), logo_dx_cm: float = Form(0.0),
                    logo_dy_cm: float = Form(0.0), metal_tex: str = Form(""), arm_color: str = Form(""),
                    metal_tex_img: str = Form(""), metal_tex_scope: str = Form("face"),
                    box_h_cm: float = Form(0.0), sticker_idx: str = Form(""),
                    cut_smooth_mm: float = Form(0.0), face_print: str = Form("uv"),
                    make_ai: str = Form("1"), only_ai: str = Form("0"),
                    material_groups: str = Form(""),
                    logo_w_cm: float = Form(0.0), logo_h_cm: float = Form(0.0),
                    safe_mode: str = Form("0")):
    """ออก 'ชุดชั้นตัด' อัตโนมัติตามแบบป้าย 1-7 — ขยาย/หดเส้นต่อชั้นตามค่าเผื่อ แยก layer/สี ตามวัสดุ
       return_depth_cm > 0 = กำหนดความหนายกขอบ (ความลึกตัว) เอง เช่น 2.5/5/7.5/10 หรือ 3"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    _body9 = await file.read()
    with open(inp, "wb") as f:
        f.write(_body9)
    # ⚡ คำขอซ้ำเป๊ะ (ไฟล์เดิมทุกไบต์ + ค่าตั้งเดิมทุกช่อง) -> ตอบจากแคชทันที
    #    นี่คือเกราะกันเคส 502: เบราว์เซอร์/ผู้ใช้กดซ้ำ งานหนักไม่ถูกคำนวณใหม่อีกรอบ
    try:
        import hashlib as _hl9
        _rck = (_hl9.sha1(_body9).hexdigest(), str(sign_type), float(real_width_mm), float(real_height_mm),
                float(return_depth_cm), float(trim_width_cm), str(trim_dir), str(face_color), str(side_color),
                int(n_colors), str(arm), float(arm_len_cm), str(arm_side), str(arm_adjust), float(arm_travel_cm),
                str(neon_color), str(neon_line), str(neon_plate), float(neon_margin_cm),
                int(frame_bars), float(frame_level_cm), float(frame_gap_cm), float(frame_x_cm),
                float(frame_standoff_cm), float(wire_offset_cm), float(led_pitch_cm), float(arm_edge_cm),
                float(arm_gap_cm), float(leg_h_cm), float(leg_span_cm), float(caster_mm), str(caster_lock),
                float(logo_scale), float(logo_dx_cm), float(logo_dy_cm), str(metal_tex), str(arm_color),
                str(metal_tex_img), str(metal_tex_scope), float(box_h_cm), str(sticker_idx),
                float(cut_smooth_mm), str(face_print), str(material_groups),
                float(logo_w_cm), float(logo_h_cm), str(safe_mode), str(make_ai), str(only_ai))
        _pk = _rck[:-2]                       # 🧺 กุญแจ 'ชุดค่าที่คำนวณไว้' (ไม่รวม 2 ช่องโหมดท้ายสุด)
        _rhit = _LAYERSET_CACHE["map"].get(_rck)
        if _rhit is not None:
            return _rhit
        # 🏭 ปุ่ม 'สร้างไฟล์ตัดสั่งผลิต (.ai)' -> ดึงค่าที่เก็บไว้มาประกอบไฟล์ทันที
        #    ไม่คำนวณเส้นตัดใหม่ ไม่ปั้นภาพ 3 มิติใหม่ · ถ้าไม่มีค่าเก็บไว้ (รีสตาร์ท/ค่าตั้งเปลี่ยน)
        #    จะตกไปทางปกติที่คำนวณครบเหมือนเดิม -> ไม่มีทางสร้างไฟล์ไม่ได้
        if str(only_ai) == "1":
            _bnd = _PRODCACHE["map"].get(_pk)
            if _bnd is not None:
                _CUT_SMOOTH["mm"] = max(0.0, min(2.0, float(cut_smooth_mm or 0.0)))
                _ai9, _pr9, _pi9, _w9 = _prod_files(_bnd)
                return JSONResponse({"ok": True, "from_cache": True, "ai_base64": _ai9,
                                     "print_base64": _pr9, "print_info": _pi9, "warns": _w9})
    except Exception:
        _rck = None; _pk = None
    del _body9
    try:
        _CUT_SMOOTH["mm"] = max(0.0, min(2.0, float(cut_smooth_mm or 0.0)))   # 🧈 ความเนียนเส้นตัด (ผู้ใช้ตั้ง)
        # 🔒 เลิกใช้ 'โหมดปลอดภัย' แล้ว — เส้นทางปกติผ่านด่านตรวจคุณภาพเส้นตัดอยู่แล้ว
        #    ปิดตายไว้ ห้ามเปิดจากภายนอก (ยังรับพารามิเตอร์ไว้กันหน้าเว็บเวอร์ชันเก่ายิงมาแล้วพัง)
        _SAFE["on"] = False
        rec = SIGN_TYPES.get(str(sign_type))
        if not rec:
            return JSONResponse({"error": "ไม่รู้จักแบบป้ายนี้"}, status_code=400)
        # กำหนดความหนายกขอบเอง -> override ความลึก 3 มิติ + ความสูงผนังหลัก (ยกขอบนอก, ไม่แตะ 'ยกขอบใน')
        try:
            _rd = float(return_depth_cm)
        except Exception:
            _rd = 0.0
        if _rd > 0:
            import copy as _copy
            rec = _copy.deepcopy(rec)
            rec["depth_cm"] = _rd
            for _w in rec.get("walls", []):
                _nm = str(_w.get("name", ""))
                if _nm.startswith("ยกขอบ") and "ใน" not in _nm:
                    _w["h"] = _rd
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        _raw_b0 = (full.bounds if (full is not None and not full.is_empty) else None)   # 📌 ตำแหน่งอ้างอิงของ 'เส้นดิบ'
        # 🥇 จำภาพต้นทาง + ขนาดจริง ไว้ทำชั้นขยาย/หด 'ด้วยวิธีเดียวกับปุ่มแปลงเป็นเส้นตัด'
        try:
            _RASTER_SRC["path"] = inp
            _RASTER_SRC["w_mm"] = float(_raw_b0[2] - _raw_b0[0]) if _raw_b0 else float(real_width_mm)
        except Exception:
            _RASTER_SRC["path"] = None
        # 🖼️ ============ ภาพแบน (FLAT) — ก๊อบเก็บไว้ก่อนขึ้นรูปทรงใด ๆ ทั้งสิ้น ============
        #    หลักการ: การตัดฉลุ = วางแผ่นบาง ๆ แล้วดูที่ 'เส้น' อย่างเดียว
        #    เก็บเส้นทุกเส้นตามขนาดจริง (กว้าง×สูง ที่ผู้ใช้กำหนด) ไว้ 1 ชุด แล้วใช้ชุดนี้ตลอด
        #    ส่วนรูปทรง (รู/เนื้อ/คิ้ว/ยกขอบ) ค่อยไปประกอบทีหลัง ไม่ย้อนกลับมาแตะภาพแบนนี้
        _FLAT = {"subs": None, "w_mm": 0.0, "h_mm": 0.0, "bounds": _raw_b0}
        try:
            import copy as _cpf
            _rs0 = _RAW_SUBS.get("subs")
            if _rs0 and _raw_b0:
                _FLAT["subs"] = _cpf.deepcopy(_rs0)
                _FLAT["w_mm"] = round(_raw_b0[2] - _raw_b0[0], 2)
                _FLAT["h_mm"] = round(_raw_b0[3] - _raw_b0[1], 2)
        except Exception:
            _FLAT["subs"] = None
        _prewarn = []; _ART_AR = 0.0
        # 🆕 กล่องไฟล้อมตามทรง: เชื่อมเป็นเงารวมก้อนเดียวก่อน (ทุกชั้นล้อมทรงเดียวกัน)
        if rec.get("wrap"):
            full = _wrap_silhouette(full, float(rec.get("wrap_bridge_cm", 3.0)) * 10.0)
        # 🆕 กล่องไฟทรงเรขาคณิต: แทนเงางานด้วยรูปทรง กลม/สี่เหลี่ยม/วงรี (ครอบงาน)
        elif rec.get("box_shape"):
            _punch_logo = full if rec.get("punch_face") else None   # 🔦 เก็บรูป logo ไว้ฉลุโบ๋หน้ากล่อง
            _pl_b0 = (_punch_logo.bounds if _punch_logo is not None else None)   # bbox ก่อนจัดวาง (ไว้คำนวณ transform ของเส้นดิบ)
            try:                       # 🖼️ เก็บสัดส่วนงานศิลป์ไว้ (กล่องแบบพิมพ์หน้าใช้กำหนดขนาด logo เป็น ซม.)
                _ab0 = full.bounds
                _ART_AR = ((_ab0[2] - _ab0[0]) / (_ab0[3] - _ab0[1])) if (_ab0[3] - _ab0[1]) > 0.01 else 0.0
            except Exception:
                _ART_AR = 0.0
            # 📏 ขนาดที่ผู้ใช้กรอก = 'ขนาดนอกสุดของกล่องที่ผลิตจริง' ซึ่งรวมคิ้วที่ยื่นออกนอกแล้ว
            #    ถ้าเอาไปตั้งให้ตัวกล่องเปล่า ๆ คิ้วจะบวกทับออกไปอีกข้างละ 1 ความกว้างคิ้ว
            #    (กรอก 45 ซม. คิ้ว 1 ซม. -> ได้ 47 ซม.) จึงต้องหักส่วนที่คิ้วยื่นออกก่อนเสมอ
            _box_grow = 0.0
            try:
                if (str(trim_dir or "out").lower() != "in"):
                    _tw0 = max(0.0, float(trim_width_cm or 0.0)) * 10.0
                    for _L0 in rec.get("layers", []):
                        # ⚠️ off/band ในตาราง SIGN_TYPES เป็น 'มิลลิเมตร' อยู่แล้ว ห้ามคูณ 10 ซ้ำ
                        #    นับเฉพาะชั้น 'คิ้ว' ที่เห็นจากด้านหน้าและเป็นตัวกำหนดขนาดนอกจริง
                        #    (แผ่นพื้นด้านหลังยื่นเกิน 1 มม. ไม่นับ เพราะมองไม่เห็นและไม่ใช่ขนาดป้าย)
                        if _L0.get("kind") != "frame":
                            continue
                        _o0 = float(_L0.get("off", 0.0))
                        _b0 = _tw0 if _tw0 > 0 else float(_L0.get("band", 10.0))
                        _box_grow = max(_box_grow, _o0 + _b0)
            except Exception:
                _box_grow = 0.0
            _tw_box = max(20.0, float(real_width_mm) - 2.0 * _box_grow)
            # 📏 ความสูงกล่อง: หน้าเว็บส่งมา 2 ชื่อ แล้วแต่ประเภทป้าย
            #    box_h_cm      -> กล่องฉลุหน้า
            #    real_height_mm -> กล่องแบบพิมพ์หน้า (1 หน้า / 2 หน้า)
            #    เดิมอ่านแค่ box_h_cm ตัวเดียว -> กล่องแบบพิมพ์เลยไม่เคยได้ความสูงที่ผู้ใช้กรอก
            #    (กรอก 100 ซม. แต่ได้ 96.1 ซม. เพราะปล่อยให้สูงตามสัดส่วนภาพแทน)
            _h_in = float(box_h_cm or 0.0) * 10.0
            if _h_in <= 1.0:
                _h_in = float(real_height_mm or 0.0)
            _th_box = (max(20.0, _h_in - 2.0 * _box_grow) if _h_in > 1.0 else 0.0)
            if _box_grow > 0.05:      # ⚠️ ยังไม่มีตัวแปร warns ตรงนี้ — พักไว้ก่อน แล้วค่อยเติมทีหลัง
                _prewarn.append("📐 กล่อง: หักคิ้วที่ยื่นออกนอกข้างละ %.1f ซม. แล้ว — ขนาดนอกสุดที่ผลิตจริง "
                                "= %.1f ซม. ตรงตามที่กรอก" % (_box_grow / 10.0, float(real_width_mm) / 10.0))
            full = _geom_box_fit(full, rec["box_shape"], float(rec.get("box_pad_cm", 3.0)) * 10.0, _tw_box,
                                 _th_box)                            # 📐 ผู้ใช้กำหนด กว้าง×สูง กล่องเองได้อิสระ
            if _punch_logo is not None:                              # ✂ ย่อ logo ให้อยู่ในกล่องพอดี (กล่องถูกสเกลตามผู้ใช้)
                _punch_logo = _punch_fit_in_box(_punch_logo, full, float(rec.get("box_pad_cm", 3.0)) * 10.0)
        warns = list(_prewarn)                           # 📐 คำเตือนที่เกิดตอนขึ้นรูปกล่อง (ก่อนมีตัวแปร warns)
        _FIXSTAT["chips"] = 0; _FIXSTAT["holes"] = 0     # 🧹 เริ่มนับเศษที่เก็บกวาดของงานนี้
        # 📊 ต้องรีเซ็ตทุกครั้ง ห้ามค้างข้ามงาน · ⏱️ เริ่มจับงบเวลาของงานนี้
        import time as _tm0
        _SHARPSTAT["ok"] = 0; _SHARPSTAT["reject"] = 0; _SHARPSTAT["skip"] = 0
        _SHARPSTAT["calls"] = 0; _SHARPSTAT["t0"] = _tm0.time()
        # 🎯 ผู้ใช้ปรับ logo ในกล่องเอง: ย่อ/ขยาย (%) + เลื่อน ซ้าย-ขวา/ขึ้น-ลง (ซม.)
        _laS = max(0.1, float(logo_scale or 100.0) / 100.0)
        # 📏 กำหนด 'ขนาดจริงของ logo บนหน้ากล่อง' เป็น ซม. ได้เลย (ลูกค้าสั่งสูง 40 ซม. = ได้ 40.0 เป๊ะ)
        #    ใส่ค่าใดค่าหนึ่งก็พอ — อีกด้านคำนวณตามสัดส่วนเดิมให้อัตโนมัติ · ใส่ทั้งคู่ = ยึด 'สูง'
        _logo_wh = [0.0, 0.0]; _ART_TGT = None
        try:
            _lw_t = float(logo_w_cm or 0.0) * 10.0; _lh_t = float(logo_h_cm or 0.0) * 10.0
            # 🖨️ กล่องไฟ 'หน้าพิมพ์' (ไม่ได้ฉลุ): งานศิลป์ถูกวางเป็นรูปบนหน้ากล่อง ไม่มีรูปทรง logo ให้วัด
            #    -> ส่งขนาดเป้าหมาย + สัดส่วนงาน เข้าไปให้ตัววาดภาพ 3 มิติคำนวณสเกลเอง (ได้ ซม. เป๊ะ)
            if (_lw_t > 1.0 or _lh_t > 1.0) and _punch_logo is None and rec.get("box_shape") \
                    and float(_ART_AR or 0) > 0:
                _ART_TGT = {"w_mm": _lw_t, "h_mm": _lh_t, "ar": float(_ART_AR)}
            if (_lw_t > 1.0 or _lh_t > 1.0) and _punch_logo is not None and not _punch_logo.is_empty:
                _lb0 = _punch_logo.bounds
                _lw0 = _lb0[2] - _lb0[0]; _lh0 = _lb0[3] - _lb0[1]
                if _lh_t > 1.0 and _lh0 > 0.01:
                    _laS = _lh_t / _lh0
                elif _lw_t > 1.0 and _lw0 > 0.01:
                    _laS = _lw_t / _lw0
                _laS = max(0.02, min(20.0, _laS))
                _logo_wh = [round(_lw0 * _laS / 10.0, 1), round(_lh0 * _laS / 10.0, 1)]
                warns.append("📏 ขนาด logo บนหน้ากล่อง = %.1f × %.1f ซม. (ตามที่กำหนด)" % (_logo_wh[0], _logo_wh[1]))
        except Exception:
            pass
        _laDX = float(logo_dx_cm or 0.0) * 10.0; _laDY = float(logo_dy_cm or 0.0) * 10.0
        _art_adj = ({"s": _laS, "dx": _laDX, "dy": _laDY}
                    if (abs(_laS - 1.0) > 0.005 or abs(_laDX) > 0.5 or abs(_laDY) > 0.5 or _ART_TGT) else None)
        if _ART_TGT and _art_adj:
            _art_adj.update(_ART_TGT)          # 📏 ขนาด logo เป็น ซม. บนหน้ากล่องแบบพิมพ์
        _ARTFIT["w_mm"] = 0.0; _ARTFIT["h_mm"] = 0.0
        try:
            if _punch_logo is not None and _art_adj:
                from shapely import affinity as _aff
                _plb = _punch_logo.bounds
                _pcx = (_plb[0] + _plb[2]) / 2.0; _pcy = (_plb[1] + _plb[3]) / 2.0
                _punch_logo = _aff.translate(_aff.scale(_punch_logo, xfact=_laS, yfact=_laS, origin=(_pcx, _pcy)),
                                             xoff=_laDX, yoff=_laDY)
        except Exception:
            pass
        # 🌈 นีออนเฟล็กซ์: full = เส้นงาน (นีออน) · อะคริลิคใส = ล้อมทรง (contour) + ระยะเผื่อ
        _neon = bool(rec.get("neon")); _acrylic = None; _neon_full = full
        if _neon:
            _nmg = max(0.0, float(neon_margin_cm)) * 10.0     # ระยะเผื่ออะคริลิครอบตัวงาน (มม.)
            try:
                _acrylic = _wrap_silhouette(full, 45.0).buffer(_nmg, join_style=1)
            except Exception:
                _acrylic = full.buffer(_nmg, join_style=1)
            if str(neon_plate).lower() in ("rect", "rectangle", "4", "square"):   # 🔲 ตัดเป็นแผ่น 4 เหลี่ยม (ครอบ bbox + เผื่อขอบ)
                from shapely.geometry import box as _box
                _ab = _acrylic.bounds
                _acrylic = _box(_ab[0], _ab[1], _ab[2], _ab[3])
        base_area = full.area
        # คิ้ว: ความหนา (ซม.) + ทิศทาง ('out'=ขยายออกนอกตัวต้น (มาตรฐานงานจริง) / 'in'=หดเข้า)
        TRIMW = float(trim_width_cm) * 10.0 if float(trim_width_cm) > 0 else 0.0
        TRIM_OUT = (str(trim_dir or "out").lower() != "in")
        bore_geom = None; frame_outer = None
        try:
            _punch_logo
        except NameError:
            _punch_logo = None
        out_layers = []
        # 🧭 รายงานเอนจิ้นที่ใช้จริง (จะได้รู้ทันทีว่าไฟล์เอนจิ้นบนเซิร์ฟเวอร์เป็นรุ่นไหน)
        try:
            if _TRACE_ENG.get("frame_dropped"):
                warns.append("🗑️ ตัด 'กรอบหน้ากระดาษ' ที่ติดมากับไฟล์ออก %d เส้น — "
                             "กรอบนี้ทำให้ตัวอักษรถูกนับเป็นรูจนแหว่ง และมีเส้นตัดเกินในไฟล์"
                             % _TRACE_ENG["frame_dropped"])
                _TRACE_ENG["frame_dropped"] = 0
            # 🧭 รายงาน 'ทุกครั้ง' ว่าใช้เอนจิ้นตัวไหน + เส้นเข้า/ออกเท่าไหร่
            #    เดิมรายงานเฉพาะ 2 กรณี ทำให้ตอนใช้ potrace เงียบสนิท ตรวจสอบไม่ได้เลยว่าเกิดอะไรขึ้น
            _eng9 = _TRACE_ENG.get("mode", "")
            _ENGN = {"file-vector": "🥇 เส้นโค้งจริงในไฟล์ .ai/.pdf (ไม่ trace เลย — คมที่สุด)",
                     "potrace-button": "potrace (ตัวเดียวกับปุ่ม 'แปลงเป็นเส้นตัด')",
                     "vtracer-button": "⚠️ vtracer (ตัวสำรอง — potrace ทำงานไม่สำเร็จ)"}
            _ri = int(_TRACE_ENG.get("rings_in", 0) or 0)
            _ru = int(_TRACE_ENG.get("rings_used", 0) or 0)
            _msg9 = "🧭 เอนจิ้นเส้นตัด: %s" % (_ENGN.get(_eng9) or (_eng9 or "ไม่ทราบ"))
            if _ri:
                _msg9 += " · อ่านเส้นได้ %d เส้น (เนื้อ %d · รู %d) → ใช้จริง %d เส้น" % (
                    _ri, _ri - int(_TRACE_ENG.get("holes", 0) or 0),
                    int(_TRACE_ENG.get("holes", 0) or 0), _ru)
                if _ru < _ri:
                    _msg9 += " · ⚠️ หายไป %d เส้น" % (_ri - _ru)
            warns.append(_msg9)
            for _why, _ar in (_TRACE_ENG.get("rings_lost") or []):
                warns.append("   ↳ เส้นที่หาย: %s (พื้นที่ %.1f ตร.มม. ≈ ⌀%.1f มม.)"
                             % (_why, _ar, 2.0 * (max(0.0, _ar) / 3.14159) ** 0.5))
            for _k9 in ("mode", "rings_in", "rings_used", "rings_lost", "holes"):
                _TRACE_ENG[_k9] = "" if _k9 == "mode" else 0
        except Exception:
            pass
        # 🔦 คุณภาพไฟล์ตัดกล่องฉลุ: ล้างเศษจิ๋ว/ชิ้นบางเกินฉลุ + ลบขอบหยักจาก trace ก่อนเจาะ
        if _punch_logo is not None:
            # ✂️ กล่องฉลุ = 'ตัดฉลุบนแผ่นแบน' เท่านั้น -> ไม่แก้รูปใด ๆ ทั้งสิ้น (เหมือนประเภทอักษรแบน 100%)
            #    เดิม: ล้างเศษ + เพิ่มความหนา + simplify -> รายละเอียดหาย/เส้นเพี้ยน · ตอนนี้แค่ 'เตือน' อย่างเดียว
            _pdrop = 0; _nthick = 0
            try:
                _chk, _pdrop = _punch_logo_clean(_punch_logo, min_area_mm2=1.0, min_width_mm=0.15, smooth_mm=0.0)
                _, _nthick = _punch_min_stroke(_punch_logo, min_w_mm=1.2)
            except Exception:
                pass
            # 🛡️ ข้อความเตือนต้องไม่มีวันทำให้ 'สร้างไฟล์ไม่ได้' — ห่อไว้เสมอ
            try:
                if _pdrop:
                    warns.append("ℹ️ มีชิ้นจิ๋วกว่า 1 ตร.มม. %d ชิ้น (ยังอยู่ในไฟล์ตัดครบ) — ถ้าไม่ต้องการ กดเลือกเป็นสติ๊กเกอร์ได้" % _pdrop)
                if _nthick:
                    # ⚠️ ต้องใช้ %% เมื่อจะพิมพ์เครื่องหมายเปอร์เซ็นต์ในสตริงที่ format — ไม่งั้น ValueError ทั้งคำขอ
                    warns.append("⚠️ ชิ้น/ตัวอักษร %d ชิ้น เส้นบางกว่า 1.2 มม. — ฉลุโลหะจริงอาจขาด (ไฟล์ตัดคงรูปเดิมไว้ 100%% ตามต้นฉบับ)" % _nthick)
            except Exception:
                pass
            _pdrop = 0; _nthick = 0          # ไม่ได้แก้รูป -> เส้นดิบใช้ได้เต็มที่
            try:                                        # ⚠️ รูในตัวอักษร (counter เช่น a o ฿) = เหล็กก้อนกลางจะหลุดตอนฉลุ
                _pl = list(_punch_logo.geoms) if _punch_logo.geom_type == "MultiPolygon" else [_punch_logo]
                _nctr = sum(len(p.interiors) for p in _pl if p.geom_type == "Polygon")
                if _nctr:
                    warns.append("พบ 'รูในตัวอักษร' %d จุด (เช่น ช่องใน a/o) — เหล็กก้อนกลางจะหลุดตอนฉลุ "
                                 "ต้องเพิ่มสะพานเชื่อม (stencil bridge) ในไฟล์ก่อนตัด หรือยึดด้วยอะคริลิคด้านหลัง" % _nctr)
            except Exception:
                pass
        # 🏷️ สติ๊กเกอร์: ชิ้นที่ผู้ใช้คลิกเลือก 'ไม่ตัด' (เช่น ตัวหนังสือไทยติดสติ๊กเกอร์ดำ) — แยกออกจากไฟล์ตัดทุกชั้น
        _sticker_geom = None; _stick_pieces = []; _stick_sel = set()
        # 🗺️ เส้นดิบสำหรับ 'วาดแผนที่ชิ้น' — ต้องอยู่พิกัดเดียวกับที่แผนที่ใช้
        #    กล่องไฟฉลุหน้า: logo ถูก 'ย่อ/ขยาย + ย้าย' เข้าไปวางในกล่องแล้ว (บรรทัด 4814/4856)
        #    แต่ _FLAT/_RAW_SUBS ยังเป็นพิกัดของงานต้นฉบับก่อนจัดวาง
        #    ถ้าเอามาวาดตรง ๆ เส้นจะไปอยู่คนละที่/คนละขนาดกับกรอบภาพ -> เห็นเป็น 'เส้นตัดหายไป'
        #    จึงต้องแปลงด้วย transform ชุดเดียวกับที่ใช้ทำไฟล์ตัดจริง (บรรทัด 5152-5155)
        _MAP_SUBS = None
        try:
            _rs9 = _RAW_SUBS.get("subs")
            if _rs9 and _pl_b0 and _punch_logo is not None and not _punch_logo.is_empty:
                _b9 = _punch_logo.bounds
                _s9 = (_b9[2] - _b9[0]) / max(1e-6, (_pl_b0[2] - _pl_b0[0]))
                _MAP_SUBS = _subs_affine(_rs9, _s9, _b9[0] - _pl_b0[0] * _s9, _b9[1] - _pl_b0[1] * _s9)
                # 🎯 บีบให้พอดีกรอบ logo อีกรอบ (เหตุผลเดียวกับเส้นรูฉลุ — กันภาพในแผนที่บวมหลุดกรอบ)
                _mx = []; _my = []
                for _s6 in _MAP_SUBS:
                    for _q6 in [_s6["start"]] + [_g6[-1] for _g6 in _s6["segs"]]:
                        _mx.append(_q6[0]); _my.append(_q6[1])
                if _mx and _my:
                    _mw = max(_mx) - min(_mx); _mh = max(_my) - min(_my)
                    _bw6 = _b9[2] - _b9[0]; _bh6 = _b9[3] - _b9[1]
                    if _mw > 0.01 and _mh > 0.01:
                        _s6f = min(_bw6 / _mw, _bh6 / _mh)
                        if abs(_s6f - 1.0) > 0.002:
                            _MAP_SUBS = _subs_affine(
                                _MAP_SUBS, _s6f,
                                _b9[0] + (_bw6 - _mw * _s6f) / 2.0 - min(_mx) * _s6f,
                                _b9[1] + (_bh6 - _mh * _s6f) / 2.0 - min(_my) * _s6f)
        except Exception:
            _MAP_SUBS = None
        if _punch_logo is not None:
            try:
                _pl2 = list(_punch_logo.geoms) if _punch_logo.geom_type == "MultiPolygon" else [_punch_logo]
                _pl2 = sorted([p for p in _pl2 if p.geom_type == "Polygon" and not p.is_empty],
                              key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))   # ลำดับคงที่ทุกครั้ง
                _stick_pieces = _pl2
                for _tk2 in str(sticker_idx or "").split(","):
                    _tk2 = _tk2.strip()
                    if _tk2.isdigit() and int(_tk2) < len(_pl2):
                        _stick_sel.add(int(_tk2))
                if _stick_sel:
                    from shapely.ops import unary_union as _uu2
                    _sticker_geom = _uu2([_pl2[i] for i in sorted(_stick_sel)])
                    _keep2 = [p for i, p in enumerate(_pl2) if i not in _stick_sel]
                    _punch_logo = _uu2(_keep2) if _keep2 else None
                    warns.append("🏷️ แยกเป็นสติ๊กเกอร์ (ไม่อยู่ในไฟล์ตัด) %d ชิ้น — โชว์บนหน้ากล่องเป็นงานติดสติ๊กเกอร์" % len(_stick_sel))
            except Exception:
                _sticker_geom = None
        # 🧱 ============ ป้ายเดียว หลายวัสดุ (material groups) ============
        #    ผู้ใช้แตะ 'คำ' บนแผนที่ชิ้น แล้วจ่ายประเภทป้าย/วัสดุคนละแบบให้คำนั้น
        #    เช่น "ลูกก้อ" = อักษรยกขอบไฟออกหน้า · "ร้านผลไม้" = พลาสวูด 10 มม. ไดคัท ไม่มีไฟ
        #    → กลุ่มที่ถูกจ่ายวัสดุจะถูก 'หักออก' จากตัวหลัก แล้วสร้างชุดชั้นตัดของตัวเองแยกต่างหาก
        _mat_pieces = _stick_pieces
        if not _mat_pieces:
            try:
                _mp0 = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
                # ⚠️ ห้ามกรองด้วยพื้นที่แรง ๆ — ขอบบนของตัวอักษรมักถูกเอนจิ้นแยกเป็นชิ้นบาง ๆ (4–10 ตร.มม.)
                #    ถ้ากรองทิ้ง แผนที่จะโชว์ตัวอักษร 'หัวแหว่ง' และจ่ายวัสดุได้ไม่ครบชิ้น
                # 🔒 เก็บ 'เส้นต้นฉบับ' ไว้ทั้งหมด ไม่แก้รูปทรงเลย — แค่จัดกลุ่มว่าชิ้นไหนเป็นตัวเดียวกัน
                _mat_pieces = sorted([p for p in _mp0 if p.geom_type == "Polygon" and not p.is_empty and p.area > 0.5],
                                     key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))
            except Exception:
                _mat_pieces = []
        # 🧩 คลัสเตอร์ = 'ตัวอักษร 1 ตัว' (ตัว + เศษขอบที่ติดกัน) — ใช้บังคับให้จ่ายวัสดุครบทั้งตัวเสมอ
        _mat_clust = [[i] for i in range(len(_mat_pieces))]
        try:
            if _mat_pieces:
                _fb1 = full.bounds
                _mat_clust = _merge_touching(_mat_pieces,
                                             tol=min(4.0, max(0.8, (_fb1[3] - _fb1[1]) * 0.05)))
        except Exception:
            _mat_clust = [[i] for i in range(len(_mat_pieces))]
        # 🗺️ แผนที่ให้ผู้ใช้ 'แตะคำ' เลือกชิ้น (สร้างก่อนหักกลุ่มออก — index ต้องตรงกับที่ผู้ใช้เห็น)
        _mat_map_svg = ""
        try:
            if len(_mat_pieces) > 1:
                _mgsel = set()
                for _g0 in (json.loads(material_groups) if str(material_groups or "").strip() else []):
                    for _v0 in (_g0.get("pieces") or []):
                        _mgsel.add(int(_v0))
                _fb9 = full.bounds
                # 🧩 จัดกลุ่ม 'คำ' โดยมองแต่ละคลัสเตอร์ (ตัวอักษร + เศษขอบที่ติดกัน) เป็นหน่วยเดียว
                #    ใช้ 'กรอบรวมของคลัสเตอร์' คิดกลุ่มเท่านั้น — รูปทรงที่วาดยังเป็นเส้นต้นฉบับ 100%
                from shapely.geometry import box as _bxC
                _cbox = [_bxC(min(_mat_pieces[k].bounds[0] for k in cl),
                              min(_mat_pieces[k].bounds[1] for k in cl),
                              max(_mat_pieces[k].bounds[2] for k in cl),
                              max(_mat_pieces[k].bounds[3] for k in cl)) for cl in _mat_clust]
                _cgrp = _sticker_groups(_cbox, _fb9[2] - _fb9[0], _fb9[3] - _fb9[1])
                _wgrp = [sorted({i for c in g for i in _mat_clust[c]}) for g in _cgrp]
                # 🖼️ วาดจาก 'ภาพแบน' ที่ก๊อบเก็บไว้ตั้งแต่ต้น — เหมือนไฟล์เส้นตัดจากปุ่มเป๊ะ
                _mat_map_svg = _sticker_map_svg(full, _mat_pieces, _mgsel, _wgrp,
                                                raw_subs=(_MAP_SUBS or _FLAT.get("subs") or _RAW_SUBS.get("subs")))
        except Exception:
            _mat_map_svg = ""
        _mat_groups = []          # [{tag,name,rec,geom,idx}]
        try:
            _mgspec = json.loads(material_groups) if str(material_groups or "").strip() else []
        except Exception:
            _mgspec = []
        # 🛡️ กันเคสร้ายแรง: กลุ่มวัสดุเก็บไว้เป็น 'หมายเลขชิ้น' — ถ้าจำนวนชิ้นของงานเปลี่ยน
        #    (เปลี่ยนไฟล์ / เปลี่ยนขนาด / อัปเดตระบบ) หมายเลขจะชี้ผิดชิ้น แล้วไป 'หักชิ้นผิด'
        #    ออกจากตัวป้าย -> ตัวอักษรแหว่งทั้งภาพ 3 มิติและไฟล์ตัด · ต้องทิ้งกลุ่มที่ไม่ตรงเสมอ
        _mg_drop = 0
        if _mgspec:
            _ok = []
            for _gs in _mgspec:
                _n_at = int(_gs.get("pieces_n") or 0)
                if _n_at and _n_at != len(_mat_pieces):
                    _mg_drop += 1
                    continue
                _ok.append(_gs)
            _mgspec = _ok
            if _mg_drop:
                warns.append("⚠️ ยกเลิกกลุ่มวัสดุเก่า %d กลุ่ม — จำนวนชิ้นของงานเปลี่ยนไปแล้ว "
                             "(หมายเลขชิ้นไม่ตรง) กรุณาแตะเลือกคำแล้วจ่ายวัสดุใหม่" % _mg_drop)
        if _mgspec and _mat_pieces:
            from shapely.ops import unary_union as _uug
            _used = set()
            for _gi, _gs in enumerate(_mgspec[:8]):
                try:
                    _idx = [int(v) for v in (_gs.get("pieces") or []) if 0 <= int(v) < len(_mat_pieces)]
                    # 🔑 สำคัญที่สุด: ขยายให้ครบ 'ทั้งตัวอักษร' เสมอ
                    #    เอนจิ้นซอยขอบบนตัวอักษรเป็นชิ้นเล็ก ๆ — ถ้าหักออกแค่บางชิ้น
                    #    ตัวอักษรที่เหลือจะ 'แหว่ง' ทั้งภาพ 3 มิติและไฟล์ตัด
                    try:
                        _pick = set(_idx)
                        for _cl in _mat_clust:
                            if _pick & set(_cl):
                                _pick |= set(_cl)
                        _idx = sorted(_pick)
                    except Exception:
                        pass
                    _idx = [v for v in _idx if v not in _used]
                    _grec = SIGN_TYPES.get(str(_gs.get("type") or ""))
                    if not _idx or not _grec:
                        continue
                    _used.update(_idx)
                    import copy as _cpg
                    _grec = _cpg.deepcopy(_grec)
                    # 📏 ความหนาที่ผู้ใช้กรอก (มม.) ต้องมาก่อนเสมอ — ใช้ทั้งภาพ 3 มิติ · ผนังข้าง · ใบสั่งผลิต
                    _thk_mm = 0.0
                    try:
                        _thk_mm = float(_gs.get("thick_mm") or 0)
                    except Exception:
                        _thk_mm = 0.0
                    if _thk_mm <= 0:
                        _thk_mm = float(_gs.get("depth_cm") or 0) * 10.0
                    if _thk_mm > 0:
                        _grec["depth_cm"] = _thk_mm / 10.0
                        for _w9 in _grec.get("walls", []):
                            if str(_w9.get("name", "")).startswith("ยกขอบ"):
                                _w9["h"] = _thk_mm / 10.0
                    _mat_groups.append({"tag": chr(66 + len(_mat_groups)),          # B, C, D...
                                        "name": str(_gs.get("name") or ("กลุ่ม %d" % (_gi + 1))),
                                        "rec": _grec, "idx": sorted(_idx),
                                        "geom": _uug([_mat_pieces[i] for i in sorted(_idx)]),
                                        "color": (str(_gs.get("color") or "").strip() or "#f5f5f4"),
                                        "tex": str(_gs.get("tex") or ""), "tex_img": str(_gs.get("tex_img") or ""),
                                        "material": str(_gs.get("material") or "")})
                except Exception:
                    continue
        # 🔎 ตรวจ 'ตั้งแต่ไฟล์ต้นทาง' ว่ารูปงานมีรอยแหว่งมาก่อนแล้วหรือไม่ (ก่อนระบบแตะอะไรทั้งสิ้น)
        #    ถ้าเจอตรงนี้ = ปัญหาอยู่ที่ไฟล์/ขั้นตอนรวมไฟล์ ไม่ใช่ขั้นตอนทำเส้นตัด
        try:
            from shapely.geometry import Polygon as _PgD
            _dp = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
            _notch = 0
            for _p in _dp:
                if _p.geom_type != "Polygon":
                    continue
                _pb = _p.bounds; _ph = _pb[3] - _pb[1]
                for _h in _p.interiors:
                    _hb = _PgD(_h).bounds
                    # รูที่ 'ชิดขอบบน/ล่างของชิ้นตัวเอง' = รอยแหว่ง ไม่ใช่ช่องในตัวอักษร
                    if _ph > 0 and (min(_hb[1] - _pb[1], _pb[3] - _hb[3]) < _ph * 0.04):
                        _notch += 1
            if _notch:
                warns.append("🔎 ตรวจไฟล์ต้นทาง: พบรอยแหว่งติดขอบตัวอักษร %d จุด "
                             "**ตั้งแต่ในไฟล์ที่อัปโหลด** (ก่อนระบบทำเส้นตัด) — "
                             "แนะนำใช้ไฟล์ .ai ต้นฉบับแทนไฟล์ที่ผ่านการรวมเวกเตอร์" % _notch)
            else:
                warns.append("🔎 ตรวจไฟล์ต้นทาง: รูปงานสมบูรณ์ ไม่มีรอยแหว่ง ✅")
        except Exception:
            pass
        _FULL0 = full            # 📐 รูปเต็มของป้าย (ทุกวัสดุรวมกัน) — ห้ามแก้ ห้ามหัก เด็ดขาด
        # ✅ แยกงานแบบ 'หยิบชิ้นออกมา' ไม่ใช่ 'ตัดออกจากแบบรวม'
        #    กลุ่ม A = รวมเฉพาะชิ้นที่ยังไม่ถูกจ่ายวัสดุ · กลุ่ม B/C/D = รวมเฉพาะชิ้นของตัวเอง
        #    ⛔ ห้ามใช้ difference() กับแบบรวมอีก — เคยทำแล้วมันไปกัดตัวอักษรแหว่งทั้งใบ
        # ⛔ ยังไม่ได้เลือกพื้นที่ = ฟีเจอร์นี้ต้อง 'ไม่ทำงานเลย' · แบบหลักต้องเหมือนไม่มีฟีเจอร์นี้อยู่
        _A_geom = full
        if not _mat_groups:
            _mat_ov = []
        if _mat_groups and _mat_pieces:
            try:
                from shapely.ops import unary_union as _uug2
                _taken = set()
                for g in _mat_groups:
                    _taken.update(g["idx"])
                _keepA = [p for i, p in enumerate(_mat_pieces) if i not in _taken]
                if _keepA:
                    _A_geom = _uug2(_keepA) if len(_keepA) > 1 else _keepA[0]
                if _punch_logo is not None:
                    _pk = [p for i, p in enumerate(_stick_pieces) if i not in _taken] if _stick_pieces else None
                    if _pk:
                        _punch_logo = _uug2(_pk) if len(_pk) > 1 else _pk[0]
            except Exception:
                _A_geom = full
            warns.append("🧱 ป้ายนี้มี %d วัสดุ: A · %s + %s"
                         % (len(_mat_groups) + 1, rec.get("name", ""),
                            " + ".join("%s · %s (%s)" % (g["tag"], g["name"], g["rec"].get("name", ""))
                                       for g in _mat_groups)))
        _use_raw_punch = None                       # 🏆 เส้นตัด logo แบบ 'เส้นโค้งดิบ' (ถ้าใช้ได้)
        _punch_raw_subs = None                      # 🔦 เส้นรูฉลุ (ชุดเดียวกับไฟล์ตัด) ไว้วาดภาพ 3 มิติ
        # 🔁 สร้างชุดชั้นตัด 'ทีละกลุ่มวัสดุ' — A = ตัวหลัก · B/C/D = กลุ่มที่จ่ายวัสดุเอง
        _MAIN_FULL, _MAIN_REC = full, rec
        #    กลุ่ม A ใช้ _A_geom (ชิ้นที่ยังไม่ถูกจ่ายวัสดุ) — ตัว full ยังเป็นแบบเต็มไม่ถูกแตะ
        _builds = [("", rec, _A_geom)] + [(g["tag"] + "_", g["rec"], g["geom"]) for g in _mat_groups]
        for _btag, _brec, _bfull in _builds:
          full = _bfull; rec = _brec
          if full is None or full.is_empty:
            continue
          # 📐 ============ กล่องไฟแบบพิมพ์หน้า: วัดจาก 'ขอบนอกคิ้ว' ไม่ใช่ 'ช่องโชว์ในคิ้ว' ============
          #    ช่างยึดขนาดนอกของคิ้วเป็นหลัก (กรอก 65x100 = ขอบนอกคิ้ว)
          #      อะคริลิคหน้า = ขอบนอกคิ้ว − 0.25 ซม./ด้าน  -> 64.5 x 99.5
          #      แผ่นพื้นหลัง = ขอบนอกคิ้ว + 0.10 ซม./ด้าน  -> 65.2 x 100.2
          #    แต่ 'full' คือช่องโชว์ในคิ้ว (65 − คิ้ว 1 ซม. สองข้าง = 63x98)
          #    ถ้าทดจาก full ตรง ๆ จะได้ 62.94x97.94 / 63.2x98.2 = เล็กกว่าของจริงทั้งคู่
          #    -> ต้องบวก 'ความกว้างคิ้ว' กลับเข้าไปก่อน ให้กลับไปอยู่ที่ขอบนอกคิ้วเสียก่อน
          #    ⚠️ ใช้เฉพาะกล่องไฟพิมพ์หน้า (face_finish=print) เท่านั้น
          #       ประเภทตัวอักษร (1/16) ใช้ระบบเดิมที่ถูกอยู่แล้ว ห้ามแตะ
          _TRIM_OUT_MM = 0.0
          try:
              if TRIM_OUT and rec.get("face_finish") == "print":
                  for _Lf in rec.get("layers", []):
                      if _Lf.get("kind") == "frame":
                          _bandf = TRIMW if TRIMW > 0 else float(_Lf.get("band", 10.0))
                          _TRIM_OUT_MM = max(_TRIM_OUT_MM, float(_Lf.get("off", 0.0)) + _bandf)
          except Exception:
              _TRIM_OUT_MM = 0.0
          # 🖨️ บอกช่างพิมพ์ให้ชัด: อาร์ตต้องอยู่ในระยะโชว์ ไม่งั้นคิ้วทับแล้วตัวหนังสือหาย
          try:
              if _btag == "" and _TRIM_OUT_MM > 0.05:
                  _fb7 = full.bounds
                  _sw7 = _fb7[2] - _fb7[0]; _sh7 = _fb7[3] - _fb7[1]
                  warns.append("🖨️ งานพิมพ์หน้ากล่อง — ระยะโชว์ (ที่ตามองเห็น) = %.1f × %.1f ซม. · "
                               "แผ่นอะคริลิคที่พิมพ์จริง = %.1f × %.1f ซม. → "
                               "จัดตัวหนังสือให้อยู่ใน 'ระยะโชว์' แล้วลากพื้นหลังเลยออกไปจนสุดขอบแผ่น "
                               "(คิ้วทับข้างละ %.1f ซม. อาร์ตที่ล้ำเข้าไปจะหายใต้คิ้ว)"
                               % (_sw7 / 10.0, _sh7 / 10.0,
                                  (_sw7 + 2.0 * (_TRIM_OUT_MM - 2.5)) / 10.0,
                                  (_sh7 + 2.0 * (_TRIM_OUT_MM - 2.5)) / 10.0,
                                  _TRIM_OUT_MM / 10.0))
          except Exception:
              pass
          for L in ([] if _neon else rec["layers"]):
              off = float(L["off"]); kind = L.get("kind", "solid")
              if kind != "frame" and _TRIM_OUT_MM > 0.05:
                  off += _TRIM_OUT_MM                 # เลื่อนฐานอ้างอิงจาก 'ช่องโชว์' ไปที่ 'ขอบนอกคิ้ว'
              _use_raw_punch = None
              base = _mbuf(full, off)                 # ชั้นตามค่าเผื่อ (มุมฉาก)
              if base is None or base.is_empty:
                  continue
              if kind == "punch" and _punch_logo is not None:
                  # 🔦 หน้าโลหะฉลุ: แผ่นเต็มทรงกล่อง 'เจาะโบ๋ทะลุ' ตามรูป logo — แสงลอดเฉพาะ logo
                  g = base.difference(_punch_logo)
                  if g.is_empty:
                      g = base
                  if bore_geom is None:
                      bore_geom = _punch_logo; frame_outer = base   # ให้ภาพ 3 มิติโชว์รูโบ๋ตาม logo
                  # 🏆 ใช้ 'เส้นโค้งดิบจากเอนจิ้น' เป็นเส้นตัดของ logo (คมเท่าปุ่มแปลงเป็นเส้นตัด 100%)
                  #    เงื่อนไข: ไม่มีชิ้นถูกตัดทิ้ง/พองความหนา และไม่มีสติ๊กเกอร์ -> รูปตรงกับเส้นดิบเป๊ะ
                  try:
                      _rs = _RAW_SUBS.get("subs")
                      if _rs and _pl_b0 and abs(off) < 0.01:
                          _b1 = _punch_logo.bounds
                          _sx = (_b1[2] - _b1[0]) / max(1e-6, (_pl_b0[2] - _pl_b0[0]))
                          _tx = _b1[0] - _pl_b0[0] * _sx; _ty = _b1[1] - _pl_b0[1] * _sx
                          # 🎯 เอา 'รูปที่เห็นบนหน้ากล่อง' มาทำเส้นตัดตรง ๆ — ไม่คำนวณสเกลใหม่
                          #    _punch_logo คือรูปที่ถูกย่อ/จัดวางลงกล่องเรียบร้อยแล้ว (พิกัดเดียวกับกล่อง)
                          #    แปลงรูปนี้เป็นเส้นตัดเลย = ไม่มีทางเหลื่อม/ล้น/เละ เหมือนกล่องไฟปกติ
                          #    (เดิมเอาเส้นดิบมาคูณสเกลใหม่จาก bbox ก่อน/หลังจัดวาง -> คลาดเมื่อไหร่ก็เละเมื่อนั้น)
                          # 🥇 ใช้ 'เส้นโค้งดิบจากเอนจิ้น' ชุดเดียวกับที่ป้ายแบน/กล่องไฟปกติใช้
                          #    (ของเดิมเอา 'รูปทรงที่คำนวณใหม่' มาแปลงกลับเป็นเส้น -> เส้นโค้งกลายเป็นคอร์ดตรง
                          #     มุมแหลมเกิดเงี่ยง เห็นชัดที่แผงคอ/ปากแกะ = อาการ 'ฉลุหน้ารวน')
                          #    _MAP_SUBS = เส้นดิบที่ถูกย่อ/จัดวางลงกล่องด้วย transform ชุดเดียวกันแล้ว
                          _rawL = None
                          try:
                              if _MAP_SUBS:
                                  _cx = []; _cy = []
                                  for _s7 in _MAP_SUBS:
                                      for _q7 in [_s7["start"]] + [_g7[-1] for _g7 in _s7["segs"]]:
                                          _cx.append(_q7[0]); _cy.append(_q7[1])
                                  if _cx and _cy:
                                      _b7 = _punch_logo.bounds
                                      _lw7 = max(1e-6, _b7[2] - _b7[0]); _lh7 = max(1e-6, _b7[3] - _b7[1])
                                      _in7 = (min(_cx) >= _b7[0] - 1.0 and min(_cy) >= _b7[1] - 1.0
                                              and max(_cx) <= _b7[2] + 1.0 and max(_cy) <= _b7[3] + 1.0)
                                      _fill7 = (((max(_cx) - min(_cx)) / _lw7) >= 0.97
                                                and ((max(_cy) - min(_cy)) / _lh7) >= 0.97)
                                      if _in7 and _fill7:
                                          _rawL = _MAP_SUBS          # ✅ ลงกรอบพอดี -> ใช้เส้นดิบได้
                          except Exception:
                              _rawL = None
                          if not _rawL:
                              _rawL = _poly_to_subs(_punch_logo, tol=0.04)   # ⏪ ของเดิมเป๊ะ (กันงานพัง)
                          # ✂️ ตัดฉลุบนแผ่นแบน = ส่ง 'เส้นดิบทุกเส้น' ออกเลย (เหมือนประเภทอักษรแบน 100%)
                          #    คัดออกเฉพาะชิ้นที่ผู้ใช้เลือกเป็น 'สติ๊กเกอร์' เท่านั้น
                          _keepR = _rawL
                          if _sticker_geom is not None and not _sticker_geom.is_empty:
                              from shapely.prepared import prep as _prep2
                              from shapely.geometry import Point as _Pt2
                              _stk2 = _prep2(_sticker_geom.buffer(1.0))
                              _keepR = []
                              for _sp2 in _rawL:
                                  _an2 = [_sp2["start"]] + [s[-1] for s in _sp2["segs"]]
                                  _st2 = max(1, len(_an2) // 8)
                                  if any(_stk2.intersects(_Pt2(p[0], p[1])) for p in _an2[::_st2]):
                                      continue                        # เส้นของชิ้นสติ๊กเกอร์ -> ไม่ตัด
                                  _keepR.append(_sp2)
                          _boxS = _poly_to_subs(base, tol=0.04)      # ขอบกล่อง (สี่เหลี่ยม/วงกลม) เนียนอยู่แล้ว
                          if _keepR and _boxS:
                              _use_raw_punch = _boxS + _keepR
                              _punch_raw_subs = _keepR               # 🔦 ใช้วาด 'รูฉลุ' ในภาพ 3 มิติ ให้ตรงกับไฟล์ตัดเป๊ะ
                              warns.append("✂️ เส้นตัด logo = เส้นโค้งดิบจากเอนจิ้น (คมเท่าปุ่มแปลงเป็นเส้นตัด) %d เส้น" % len(_keepR))
                  except Exception:
                      pass
              elif kind == "backing" and _punch_logo is not None:
                  # 🥛 อะคริลิคขาวนม 3mm รองหลัง: ตัดเป็น 'สี่เหลี่ยมตามพื้นที่ logo' (+เผื่อขอบ 2 ซม.) — ไม่ตัดตามรูป
                  from shapely.geometry import box as _bx2
                  lb = _punch_logo.bounds
                  g = _bx2(lb[0] - 20.0, lb[1] - 20.0, lb[2] + 20.0, lb[3] + 20.0).intersection(base)
                  if g.is_empty:
                      g = base
              elif kind == "standee_leg":
                  # 🧍 ขาตั้งสแตนดี้: สามเหลี่ยมพับหลัง สูง ~45% ของงาน + ลิ้นล็อกล่าง (ตัดจากแผ่นเดียวกัน)
                  from shapely.geometry import Polygon as _Pg9, box as _bx9
                  from shapely.ops import unary_union as _uu9
                  _sb9 = full.bounds
                  _sw9 = _sb9[2] - _sb9[0]; _sh9 = _sb9[3] - _sb9[1]
                  _lh9 = max(200.0, min(900.0, _sh9 * 0.55))   # สูงขาตั้ง (20–90 ซม.)
                  _lw9 = max(150.0, min(_sw9 * 0.85, _lh9 * 0.62))   # ฐานขาตั้ง ~62% ของความสูง (ตั้งไม่ล้ม)
                  _hg9 = max(20.0, _lh9 * 0.05)                # แถบพับติดหลังแผ่น
                  _ox9 = _sb9[0]; _oy9 = _sb9[3] + 40.0        # วางใต้ตัวงาน (ไม่ทับ · ตัดจากแผ่นเดียวกัน)
                  _tri = _Pg9([(_ox9, _oy9 + _lh9),                       # มุมพับซ้าย (ติดแผ่น)
                               (_ox9 + _lw9, _oy9 + _lh9),                # มุมพับขวา (ติดแผ่น)
                               (_ox9 + _lw9 * 0.72, _oy9),                # ปลายเท้าขวา
                               (_ox9 + _lw9 * 0.28, _oy9)])               # ปลายเท้าซ้าย (ฐานกว้าง ไม่ล้ม)
                  _hin = _bx9(_ox9, _oy9 + _lh9, _ox9 + _lw9, _oy9 + _lh9 + _hg9)
                  _tab = _bx9(_ox9 + _lw9 * 0.32, _oy9 + _lh9 + _hg9,
                              _ox9 + _lw9 * 0.68, _oy9 + _lh9 + _hg9 * 2.0)        # ลิ้นล็อก
                  g = _uu9([_tri, _hin, _tab])
              elif kind == "frame":
                  band = TRIMW if TRIMW > 0 else float(L.get("band", 10.0))
                  # 🅰️ ตัดแยกทีละตัว: คิ้วต้องไม่กว้างจนตัวติดกันเป็น 'กล่องไฟล้อมตามทรง'
                  if rec.get("per_letter") and TRIM_OUT:
                      try:
                          from vectorcnc import mount_frame as _MFL0
                          _lts0 = _MFL0.split_letters(full)
                          if len(_lts0) > 1:
                              _gapmin = 1e18
                              for _i0 in range(len(_lts0)):
                                  for _j0 in range(_i0 + 1, len(_lts0)):
                                      _d0 = _lts0[_i0].distance(_lts0[_j0])
                                      if _d0 > 0.01:
                                          _gapmin = min(_gapmin, _d0)
                              if _gapmin < 1e17:
                                  _bcap = max(1.5, _gapmin * 0.42)
                                  if band > _bcap:
                                      warns.append("🅰️ ตัดแยกทีละตัว: ลดคิ้วจาก %.1f ซม. เหลือ %.1f ซม. "
                                                   "เพื่อไม่ให้ตัวอักษรเชื่อมติดกันเป็นกล่องเดียว"
                                                   % (band / 10.0, _bcap / 10.0))
                                      band = _bcap
                      except Exception:
                          pass
                  if TRIM_OUT:
                      o2 = _mbuf(full, off + band)    # ขอบนอกคิ้ว = ตัวต้น + ความหนาคิ้ว
                      i2 = base                        # ช่องกลาง = ตัวต้น (โชว์อะคริลิค) · รูใน(ไส้)จัดการโดย difference
                  else:
                      o2 = base
                      i2 = _mbuf(full, off - band)
                  g = o2 if (i2 is None or i2.is_empty) else o2.difference(i2)
                  if g.is_empty:
                      g = o2
                  # 🩹 คิ้ว = จุดที่เกิดห่วง/หนาม/วงเศษมากที่สุด -> เก็บงานทันทีก่อนใช้ต่อ
                  g = _fix_offset_geom(g, float(real_width_mm), band_mm=band)
                  # ⚠️ ลายบางกว่า 2 เท่าของคิ้ว -> ช่องกลางถูกกินหมด (คิ้วชนกันเอง) แจ้งให้ลดคิ้ว
                  try:
                      if i2 is not None and not i2.is_empty:
                          _thin = full.difference(_mbuf(_mbuf(full, -band * 0.5), band * 0.5))
                          if (not _thin.is_empty) and _thin.area > full.area * 0.02:
                              warns.append("⚠️ บางจุดของลายบางกว่าคิ้ว %.1f ซม. — ช่องกลางคิ้วจะตีบ "
                                           "แนะนำลดคิ้วลง หรือขยายป้ายให้ใหญ่ขึ้น" % (band / 10.0))
                  except Exception:
                      pass
                  if bore_geom is None:
                      bore_geom = i2; frame_outer = o2
                  # 🅰️ งานตัดแยกทีละตัวอักษร: คิ้วของแต่ละตัวต้องไม่เชื่อมติดกันเป็นก้อนเดียว
                  if rec.get("per_letter"):
                      try:
                          # 🅰️ ใช้ 'ตัวแยกตัวอักษร' ตัวเดียวกับประเภท 16 (อักษรยกขอบ + โครงแขวน) เป๊ะ ๆ
                          from vectorcnc import mount_frame as _MFL
                          _lts = _MFL.split_letters(full)
                          _acc = []
                          for _lt in _lts:
                              _oOff = (off + band) if TRIM_OUT else off
                              _iOff = off if TRIM_OUT else (off - band)
                              _o = _mbuf(_lt, _oOff)
                              _i = _mbuf(_lt, _iOff)
                              _gg = _o if (_i is None or _i.is_empty) else _o.difference(_i)
                              if _gg is None or _gg.is_empty:
                                  continue
                              # 🥇 คมกริบ: ขยาย/หด 'ที่ภาพของตัวอักษรตัวนี้' แล้ว potrace (เหมือนปุ่มแปลงเส้นตัด)
                              #    ไม่ใช่ buffer เรขาคณิตแล้วฟิตโค้งใหม่ ซึ่งทำให้เส้นโย้
                              _shp = None
                              try:
                                  _ro = _sharp_offset(_lt, _oOff, _o)
                                  _ri = _sharp_offset(_lt, _iOff, _i) \
                                      if (_i is not None and not _i.is_empty) else []
                                  if _ro and (_ri or _i is None or _i.is_empty):
                                      _shp = list(_ro) + list(_ri or [])
                              except Exception:
                                  _shp = None
                              _acc += _shp if _shp else _cut_subs_offset(
                                  _fix_offset_geom(_gg, float(real_width_mm), band_mm=band), float(real_width_mm))
                          if _acc:
                              _use_raw_punch = _acc     # ใช้เส้นชุดนี้เป็นเส้นตัดของชั้นนี้ (แยกตัวจริง)
                      except Exception:
                          pass
              else:
                  g = base
                  # 🅰️ ตัดแยกทีละตัวอักษร (ชั้น solid ที่มีค่าเผื่อ) -> ไม่ให้ตัวติดกันกลายเป็นชิ้นเดียว
                  if rec.get("per_letter") and abs(off) > 0.01:
                      try:
                          # 🅰️ ใช้ 'ตัวแยกตัวอักษร' ตัวเดียวกับประเภท 16 (อักษรยกขอบ + โครงแขวน) เป๊ะ ๆ
                          from vectorcnc import mount_frame as _MFL
                          _lts = _MFL.split_letters(full)
                          _acc = []
                          # 🔤 ============ กู้ตัวอักษรเล็กในชั้น 'หดเข้า' (เช่น อะคริลิค -0.25 ซม.) ============
                          #    หลักการช่างจริง: แผ่นหลัง/คิ้ว ตัดตัวอักษรตัวนี้ได้ -> อะคริลิคก็ต้องตัดได้
                          #    ตัวเล็ก (เช่น 'Dessert Cafe' สูง 2-3 ซม.) โดนหดเต็มค่าแล้ว 'หายทั้งตัว' หรือแตกเป็นเศษ
                          #    เดิม: ข้ามตัวนั้นไปเงียบ ๆ -> ชั้นอะคริลิคของตัวเล็กหายจากไฟล์ตัด
                          #    ใหม่: ลดค่าหด 'เฉพาะตัวที่จะหาย' ทีละครึ่ง จนตัวนั้นรอด (สุดทางคือเท่าตัวจริง 100%)
                          #    ⚠️ ตัวที่หดได้ตามปกติ เดินโค้ดเส้นเดิมทุกบรรทัด -> ไฟล์ตัดเดิมไม่ขยับแม้แต่ไบต์เดียว
                          def _ok9(_gp, _bp):
                              if _gp is None or _gp.is_empty:
                                  return False
                              try:
                                  if _gp.area < _bp.area * 0.10:      # เหลือแต่เศษกระจาย = ไม่รอด
                                      return False
                                  if _gp.buffer(-0.4, join_style=2).is_empty:   # บางกว่า 0.8 มม. ทั้งชิ้น = ตัดไม่ได้จริง
                                      return False
                              except Exception:
                                  pass
                              return True
                          _rescued = 0; _resmin = off
                          for _lt in _lts:
                              _gg = _mbuf(_lt, off)
                              _offL = off
                              if not _ok9(_gg, _lt):
                                  _try9 = off
                                  while abs(_try9) > 0.62:            # ลดครึ่งไปเรื่อย ๆ (ต่ำสุด ~0.6 มม.)
                                      _try9 = _try9 * 0.5
                                      _g29 = _mbuf(_lt, _try9)
                                      if _ok9(_g29, _lt):
                                          _gg = _g29; _offL = _try9
                                          break
                                  else:
                                      _gg = _lt; _offL = 0.0          # เล็กจริง -> ใช้เท่าตัวจริง (เหมือนแผ่นหลัง)
                                  _rescued += 1
                                  if abs(_offL) < abs(_resmin):
                                      _resmin = _offL
                              if _gg is None or _gg.is_empty:
                                  continue
                              _shp = None                 # 🥇 คมกริบแบบเดียวกับปุ่มแปลงเส้นตัด
                              try:
                                  _shp = _sharp_offset(_lt, _offL, _gg)
                              except Exception:
                                  _shp = None
                              _acc += _shp if _shp else _cut_subs_offset(_gg, float(real_width_mm))
                          if _rescued:
                              warns.append("🔤 กู้ตัวอักษรเล็กในชั้น '%s' %d ตัว: ตัวที่หดเต็มค่า %.2f ซม. แล้วจะหาย "
                                           "ระบบลดค่าหดให้อัตโนมัติเฉพาะตัวนั้น (ต่ำสุดเหลือ %.2f ซม.) — "
                                           "แผ่นหลัง/คิ้วตัดตัวนี้ได้ อะคริลิคจึงตัดได้ด้วย ไม่หายอีกแล้ว"
                                           % (L["name"], _rescued, off / 10.0, _resmin / 10.0))
                          if _acc:
                              _use_raw_punch = _acc
                      except Exception:
                          pass
              # 📌 กฎ: ห้ามลบชิ้นงานของลูกค้า — หน้าที่เราคือ 'วาดเส้นตัดตามต้นแบบ' เท่านั้น
              #    ชั้นที่หดเข้า (เช่น อะคริลิค −0.25 ซม.) อาจมีชิ้นเล็ก/บางจนตัดยาก
              #    -> ไม่ลบทิ้งแล้ว แค่ 'นับแล้วเตือน' ให้ช่างตัดสินใจเอง (เดิมลบเงียบ ๆ)
              junk = 0
              if off < -0.01:
                  try:
                      _keepg, junk = _clean_layer(g)      # ใช้แค่ 'จำนวน' ไม่เอารูปที่ถูกลบ
                  except Exception:
                      junk = 0
              if g is None or g.is_empty:
                  continue
              # 🏆 หลักการ: 'ตัดฉลุบนแผ่นแบน = ดูที่เส้นอย่างเดียว' — ชั้นที่ค่าเผื่อ 0 ใช้เส้นดิบทุกเส้น
              #    ไม่ต้องตัดสินว่าอันไหนรู อันไหนเนื้อ (รูปทรงเอาไว้ประกอบตอนทำคิ้ว/ยกขอบเท่านั้น)
              if (_use_raw_punch is None and abs(off) < 0.01
                      and kind in ("solid", "print", "wallplate", "backing")
                      and not rec.get("wrap") and not rec.get("box_shape") and _raw_b0):
                  try:
                      _rs2 = _FLAT.get("subs") or _RAW_SUBS.get("subs")   # 🖼️ ใช้ภาพแบนที่เก็บไว้ก่อน
                      if _rs2:
                          _bn = full.bounds
                          _s2 = (_bn[2] - _bn[0]) / max(1e-6, (_raw_b0[2] - _raw_b0[0]))
                          _s2y = (_bn[3] - _bn[1]) / max(1e-6, (_raw_b0[3] - _raw_b0[1]))
                          if abs(_s2y - _s2) / max(1e-6, _s2) < 0.02:      # สเกลเท่ากันทั้ง 2 แกน (ไม่บิดสัดส่วน)
                              _use_raw_punch = _subs_affine(_rs2, _s2, _bn[0] - _raw_b0[0] * _s2,
                                                            _bn[1] - _raw_b0[1] * _s2)
                              if _use_raw_punch:
                                  warns.append("✂️ ชั้น '%s' ใช้เส้นโค้งดิบจากเอนจิ้น (คมเท่าปุ่มแปลงเป็นเส้นตัด) %d เส้น"
                                               % (L["name"], len(_use_raw_punch)))
                  except Exception:
                      _use_raw_punch = None
              # 🏆 ลำดับคุณภาพเส้นตัด:
              #    1) เส้นโค้งดิบจากเอนจิ้น (ชั้น off=0) — คมที่สุด เท่าปุ่มแปลงเป็นเส้นตัด
              #    2) ชั้นที่ขยาย/หด (คิ้ว·แผ่นพื้น·อะคริลิค) — รีดคลื่น buffer แล้วฟิตโค้ง (เนียน จุดน้อย)
              # 🥇 ชั้นขยาย/หด: ทำแบบ 'ปุ่มแปลงเป็นเส้นตัด' — ขยายที่ภาพ แล้ว trace ใหม่
              #    ได้เส้นโค้งเนียนจาก potrace โดยตรง (ไม่ต้องฟิตใหม่ = ไม่โย้)
              if (_use_raw_punch is None and abs(off) > 0.01 and kind in ("solid", "frame")
                      and not rec.get("wrap") and not rec.get("box_shape")):
                  try:
                      # 🖼️ ป้ายวัสดุเดียว = ขยายที่ 'ภาพต้นฉบับ' ได้เลย (คมที่สุด)
                      # 🧱 ป้ายแยกหลายวัสดุ = ภาพต้นฉบับมีชิ้นของกลุ่มอื่นปนอยู่
                      #     -> ต้องขยายจาก 'รูปทรงของบิลด์นี้' แทน มิฉะนั้นเส้นของกลุ่มอื่นจะหลุดเข้ามา
                      if _mat_groups:
                          def _mk(_v, _tg, _seed=full):
                              return _sharp_offset(_seed, _v, _tg)
                      else:
                          def _mk(_v, _tg):
                              return _fit_subs_to(_offset_subs_like_button(_v), _tg)
                      _rb = _mk(off if kind != "frame" else (off + band), g if kind != "frame" else o2)
                      if _rb and kind == "frame":
                          _ri = _mk(off, i2)                       # ขอบในของคิ้ว
                          if _ri:
                              _rb = _rb + _ri
                          else:
                              _rb = None
                      if _rb:
                          _use_raw_punch = _rb
                  except Exception:
                      pass
              if _use_raw_punch:
                  subs = _use_raw_punch                     # 🥇 เส้นโค้งดิบจากเอนจิ้น — คมที่สุด ไม่แตะ
              else:
                  # 🧈 ทุกชั้น ทุกประเภทป้าย: ฟิตโค้งเนียน
                  #    ชั้นที่ 'ขยาย/หด' เท่านั้นที่กวาดเศษได้ — ชั้นที่ตัดตามรูปตรง ๆ (off=0) ห้ามลบชิ้นใด ๆ
                  #    (สระ/วรรณยุกต์/จุดเล็ก ๆ คือเนื้องานจริง ไม่ใช่เศษจากการ offset)
                  # 📐 กล่องไฟทรงเรขาคณิต (สี่เหลี่ยม/กลม/วงรี) = รูปที่ระบบสร้างเองจากตัวเลข
                  #    ไม่ต้องเกลาและ 'ห้ามฟิตเป็นเส้นโค้ง' — เดิมกรอบคิ้วสี่เหลี่ยมถูกฟิตโค้ง
                  #    จนขอบโย้ วัดได้เบี้ยวถึง 7.6-12.9 มม. ทั้งที่ควรเป็นเส้นตรงเป๊ะ
                  _isgeo = bool(rec.get("box_shape")) and kind in ("solid", "frame", "backing")
                  subs = _cut_subs_offset(g, float(real_width_mm),
                                          clean=(False if _isgeo else
                                                 (abs(off) > 0.01 or kind in ("frame", "punch", "backing"))))
              subs = _dedup_subs(subs)                     # 🧹 ไฟล์ตัดสะอาด: ไม่มีเส้นซ้อนให้เครื่องเดินซ้ำ
              if not subs:
                  continue
              b = g.bounds
              out_layers.append({"name": _btag + L["name"], "off": off, "kind": kind,
                                 "color": L["color"], "rgb": L["rgb"], "grp": (_btag[:-1] or "A"),
                                 "subs": subs, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                                 "junk": junk})
        # 📊 รายงานคุณภาพเส้นตัด — พี่จะได้เห็นว่าชิ้นไหนได้เส้นคมกริบแล้ว ชิ้นไหนยังใช้วิธีเดิม
        try:
            if _SHARPSTAT.get("ok") or _SHARPSTAT.get("reject") or _SHARPSTAT.get("skip"):
                _msg = ("✂️ เส้นตัดคมกริบ (ขยายที่ภาพ + potrace) %d ชิ้น · ตรวจไม่ผ่าน %d ชิ้น"
                        % (int(_SHARPSTAT.get("ok", 0)), int(_SHARPSTAT.get("reject", 0))))
                if _SHARPSTAT.get("skip"):
                    _msg += (" · ข้ามเพราะหมดงบเวลา %d ชิ้น (งานซับซ้อน — ชิ้นที่ข้ามใช้เส้นวิธีเดิม)"
                             % int(_SHARPSTAT["skip"]))
                warns.append(_msg)
        except Exception:
            pass
        full, rec = _MAIN_FULL, _MAIN_REC      # 🔙 คืนตัวหลักให้ขั้นตอนถัดไป (3 มิติ · มุมมอง · ใบสั่งผลิต)
        # 🧱 แผ่นขอบข้าง (return) — ชิ้นตัดจริงของผนังข้าง: แถบกว้าง = ความลึกกล่อง/ตัวป้าย
        try:
            _wallsH = [w for w in rec.get("walls", []) if str(w.get("name", "")).startswith("ยกขอบ")]
            if (not _neon) and _wallsH and (not rec.get("flat")) and full is not None and not full.is_empty:
                import math as _m2
                from shapely.geometry import box as _bx3
                from shapely.ops import unary_union as _uu3
                _D = float(rec.get("depth_cm", 5.0)) * 10.0
                _fb2 = full.bounds; _fw2 = _fb2[2] - _fb2[0]; _fh2 = _fb2[3] - _fb2[1]
                if rec.get("box_shape") == "rect":       # กล่องเหลี่ยม = 4 แถบ (บน/ล่าง = กว้าง · ซ้าย/ขวา = สูง)
                    _lens = [_fw2, _fw2, _fh2, _fh2]
                else:                                    # ทรงอื่น/ตามรูปอักษร = เส้นรอบรูปรวม แบ่งท่อนละ ≤150ซม.
                    _per = float(full.exterior.length if full.geom_type == "Polygon"
                                 else sum(g.exterior.length for g in full.geoms))
                    _nseg = max(1, int(_m2.ceil(_per / 1500.0)))
                    _lens = [_per / _nseg] * _nseg
                _y3 = 0.0; _sgs3 = []
                for _ln3 in _lens:
                    _sgs3.append(_bx3(0.0, _y3, max(10.0, _ln3), _y3 + _D)); _y3 += _D + 12.0
                _wallg = _uu3(_sgs3)
                _ws3 = _poly_to_subs(_wallg, tol=0.04)
                if _ws3:
                    _wb3 = _wallg.bounds
                    out_layers.append({"name": "แผ่นขอบข้าง (return) กว้าง %.0f ซม. × %d ท่อน" % (_D / 10.0, len(_lens)),
                                       "off": 0.0, "kind": "wallplate", "color": "#f59e0b", "rgb": (245, 158, 11),
                                       "subs": _ws3, "w_mm": round(_wb3[2] - _wb3[0], 1), "h_mm": round(_wb3[3] - _wb3[1], 1)})
        except Exception:
            pass
            if junk:
                warns.append("%s: ลบเศษที่แตกจากการหดเส้น %d ชิ้น (ลายเส้นบางเกินไป)"
                             % (_en_layer(L["name"]), junk))
        _neon_subs = None
        if _neon:                                   # 🌈 นีออน: เส้นไฟ (ตามลายเส้นภาพ) + แผ่นอะคริลิคใส (ล้อมทรง)
            if str(neon_line).lower() == "single":
                # 💡 กติกาสุดท้าย (พี่สั่ง 2026-07-30): "เส้นตัดสร้างแบบไหน ก็สร้างแบบนั้น
                #    แค่ใส่เส้นนีออน 8 มม. เข้าไปแทน" -> ใช้ 'เส้นตัดชุดเดียวกันเป๊ะ' เป็นแนวเดินไฟ
                #    ไม่คำนวณแกนกลางใหม่ · ไม่สร้างรูปทรงใหม่ -> ตำแหน่ง/สเกล/ความเนียน = เท่าเส้นตัด 100%
                try:
                    import copy as _cpn
                    _neon_subs = None
                    # 🥇 ทางหลัก: แกนกลางกลางเนื้ออักษร (โมดูลแยก neon_single.py — รับรูปที่จัดวางแล้ว
                    #    ตำแหน่ง/สเกลตรงเสมอ) · เส้นออกเป็นเบซิเยร์จริงแบบเดียวกับเส้นตัด (เนียนกริบ)
                    try:
                        import neon_single as _NS
                        _rsm0 = None
                        try:                                    # 🎯 ส่ง 'เส้นโค้งดิบของแบบ' (จัดลงกรอบแล้ว) ให้โมดูล
                            _rs_p = _RAW_SUBS.get("subs")       #    โลโก้/ภาพวาด จะได้วิ่งตามเส้นแบบเป๊ะ (ชุดเดียวกับเส้นตัด)
                            if _rs_p:
                                _nx = []; _ny = []
                                for _sp in _rs_p:
                                    for _q in [_sp["start"]] + [(_g[1] if _g[0] == "L" else _g[3]) for _g in _sp["segs"]]:
                                        _nx.append(_q[0]); _ny.append(_q[1])
                                if _nx and _ny:
                                    _rw = max(_nx) - min(_nx); _rh = max(_ny) - min(_ny)
                                    _fb = full.bounds
                                    _fw = _fb[2] - _fb[0]; _fh = _fb[3] - _fb[1]
                                    if _rw > 0.01 and _rh > 0.01 and _fw > 0.01 and _fh > 0.01:
                                        _sc0 = min(_fw / _rw, _fh / _rh)
                                        _c0 = _subs_affine(_cpn.deepcopy(_rs_p), _sc0,
                                                           _fb[0] + (_fw - _rw * _sc0) / 2.0 - min(_nx) * _sc0,
                                                           _fb[1] + (_fh - _rh * _sc0) / 2.0 - min(_ny) * _sc0)
                                        _cx = []; _cy = []
                                        for _sp in _c0:
                                            for _q in [_sp["start"]] + [(_g[1] if _g[0] == "L" else _g[3]) for _g in _sp["segs"]]:
                                                _cx.append(_q[0]); _cy.append(_q[1])
                                        if (_cx and min(_cx) >= _fb[0] - 1.0 and max(_cx) <= _fb[2] + 1.0
                                                and min(_cy) >= _fb[1] - 1.0 and max(_cy) <= _fb[3] + 1.0):
                                            _rsm0 = _c0         # ✅ ลงกรอบพอดี (การ์ดเดียวกับที่ใช้แก้กล่องฉลุหน้า)
                        except Exception:
                            _rsm0 = None
                        _neon_subs, _nrep = _NS.centerline(full, tube_mm=8.0, clear_mm=1.0, raw_subs=_rsm0)
                        if _neon_subs:
                            for _w in _NS.warn_messages(_nrep, tube_mm=8.0, clear_mm=1.0):
                                warns.append(_w)
                    except Exception:
                        _neon_subs = None
                    _from_module = bool(_neon_subs)
                    _rs_n = None if _from_module else _RAW_SUBS.get("subs")
                    if _rs_n:
                        # ⚠️ เส้นดิบอยู่ 'พิกัดงานต้นฉบับ' -> ต้องย้ายมาลงกรอบที่จัดวางแล้วก่อน
                        #    (วิธีเดียวกับที่แก้กล่องไฟฉลุหน้า: สเกลเท่ากันสองแกน + จัดกึ่งกลาง + ตรวจกรอบ)
                        _nx = []; _ny = []
                        for _sp in _rs_n:
                            for _q in [_sp["start"]] + [(_g[1] if _g[0] == "L" else _g[3]) for _g in _sp["segs"]]:
                                _nx.append(_q[0]); _ny.append(_q[1])
                        if _nx and _ny:
                            _rw = max(_nx) - min(_nx); _rh = max(_ny) - min(_ny)
                            _fb = full.bounds
                            _fw = _fb[2] - _fb[0]; _fh = _fb[3] - _fb[1]
                            if _rw > 0.01 and _rh > 0.01 and _fw > 0.01 and _fh > 0.01:
                                _sc = min(_fw / _rw, _fh / _rh)
                                _cand = _subs_affine(_cpn.deepcopy(_rs_n), _sc,
                                                     _fb[0] + (_fw - _rw * _sc) / 2.0 - min(_nx) * _sc,
                                                     _fb[1] + (_fh - _rh * _sc) / 2.0 - min(_ny) * _sc)
                                _cx = []; _cy = []
                                for _sp in _cand:
                                    for _q in [_sp["start"]] + [(_g[1] if _g[0] == "L" else _g[3]) for _g in _sp["segs"]]:
                                        _cx.append(_q[0]); _cy.append(_q[1])
                                if (_cx and min(_cx) >= _fb[0] - 1.0 and max(_cx) <= _fb[2] + 1.0
                                        and min(_cy) >= _fb[1] - 1.0 and max(_cy) <= _fb[3] + 1.0):
                                    _neon_subs = _cand          # ✅ ลงกรอบพอดี = เส้นเดียวกับเส้นตัดเป๊ะ
                    if _neon_subs and not _from_module:
                        # ✂️ ตัด 'ช่องในตัวอักษร' ออก เหลือเส้นรอบนอกชิ้นละเส้น (แบบตัว a ที่พี่อนุมัติ)
                        try:
                            from shapely.geometry import Polygon as _Pg3
                            _rows = []
                            for _sp in _neon_subs:
                                _pp = [_sp["start"]] + [(_g[1] if _g[0] == "L" else _g[3]) for _g in _sp["segs"]]
                                _gp = None
                                try:
                                    _gp = _Pg3(_pp)
                                    if not _gp.is_valid:
                                        _gp = _gp.buffer(0)
                                    if _gp is not None and (_gp.is_empty or _gp.area <= 0.2):
                                        _gp = None
                                except Exception:
                                    _gp = None
                                _rows.append((_sp, _gp, (_gp.representative_point() if _gp is not None else None)))
                            _keep = []; _cut = 0
                            for _i, (_sp, _gp, _rp) in enumerate(_rows):
                                if _gp is None:
                                    _keep.append(_sp); continue
                                _depth = 0
                                for _j, (_s2, _g2, _r2) in enumerate(_rows):
                                    if _i == _j or _g2 is None:
                                        continue
                                    if _g2.area > _gp.area * 1.0001:
                                        try:
                                            if _g2.contains(_rp):
                                                _depth += 1
                                        except Exception:
                                            pass
                                if _depth % 2:                 # ชั้นคี่ = ช่องใน -> ตัด
                                    _cut += 1
                                else:                          # ชั้นคู่ = ขอบนอกของชิ้น -> เก็บ
                                    _keep.append(_sp)
                            if _keep and _cut:
                                _neon_subs = _keep
                                warns.append("✂️ ตัดช่องในตัวอักษรออก %d เส้น — เหลือเส้นรอบนอกชิ้นละเส้นเดียว "
                                             "(ชิ้นที่อยู่ในช่อง เช่น ตัวโลโก้ในตรา ไม่ถูกตัด)" % _cut)
                        except Exception:
                            pass
                        warns.append("💡 นีออนเส้นเดี่ยว: เดินไฟตาม 'เส้นตัดชุดเดียวกัน' ครบ %d เส้น "
                                     "· ท่อไฟ 8 มม. · ร่องเซาะ CNC บนแผ่นรองหลังเดินตามเส้นนี้ (ดอกกัด 9-10 มม.)"
                                     % len(_neon_subs))
                    elif not _neon_subs:
                        _neon_subs = _poly_to_subs(full, tol=0.05)   # ถอย: ใช้รูปงานที่จัดวางแล้ว (ตำแหน่งถูกแน่)
                except Exception:
                    _neon_subs = None
            _ns = _neon_subs if _neon_subs else _poly_to_subs(full, tol=0.05)
            if _ns:
                _nb = full.bounds
                out_layers.append({"name": "นีออนเฟล็กซ์ (เส้นไฟ)", "off": 0.0, "kind": "neon",
                                   "color": str(neon_color or "#00e5ff"), "rgb": (0, 229, 255),
                                   "subs": _ns, "w_mm": round(_nb[2] - _nb[0], 1), "h_mm": round(_nb[3] - _nb[1], 1)})
                # 🛠️ ร่องเซาะ CNC (ลึก ~4mm) = แนวเส้นนีออน — เข้า .ai เป็นเลเยอร์แยกสำหรับเครื่องเซาะ
                out_layers.append({"name": "เซาะร่อง CNC (ลึก 4mm)", "off": 0.0, "kind": "groove",
                                   "color": "#d946ef", "rgb": (217, 70, 239),
                                   "subs": _ns, "w_mm": round(_nb[2] - _nb[0], 1), "h_mm": round(_nb[3] - _nb[1], 1)})
            if _acrylic is not None and not _acrylic.is_empty:
                _as = _cut_subs_offset(_acrylic, float(real_width_mm))
                if _as:
                    _ab = _acrylic.bounds
                    out_layers.append({"name": "อะคริลิคใสรองหลัง 8mm", "off": 30.0, "kind": "solid",
                                       "color": "#93c5fd", "rgb": (147, 197, 253),
                                       "subs": _as, "w_mm": round(_ab[2] - _ab[0], 1), "h_mm": round(_ab[3] - _ab[1], 1)})
        if not out_layers:
            return JSONResponse({"error": "สร้างชั้นตัดไม่สำเร็จ"}, status_code=400)
        # 🧹 รายงานการเก็บกวาดเส้นตัด (เศษ/ห่วง/รูจิ๋วจากการขยาย-หดเส้น — ตัดจริงไม่ได้อยู่แล้ว)
        try:
            if _FIXSTAT["chips"] or _FIXSTAT["holes"]:
                warns.append("🧹 เก็บกวาดเส้นตัด: ลบเศษ/ห่วงที่มุม %d ชิ้น · รูจิ๋วตัดไม่ได้ %d รู "
                             "(เล็กกว่า 4 ตร.มม. หรือบางกว่า 0.6 มม. — เครื่องตัดทำไม่ได้จริง)"
                             % (_FIXSTAT["chips"], _FIXSTAT["holes"]))
        except Exception:
            pass
        # 🖨️ กล่องไฟล้อมตามทรง: หน้า = อะคริลิคขาว P433 ตัดเป็นแผ่นเต็มตามทรง แล้วจบด้วยงานพิมพ์
        if rec.get("face_finish") == "print":
            warns.append("หน้าอะคริลิคขาว P433 = ตัดเป็นแผ่นเต็มตามทรงชิ้นเดียว "
                         "แล้วจบด้วยงานพิมพ์ UV / ติดสติกเกอร์ — ไม่ตัดเส้นตัวอักษรข้างใน")
        # 📐 ขนาดนอกจริงของตัวป้าย = เฉพาะชั้นที่ 'ประกอบเป็นตัวป้าย' (ตัดแถบขอบข้าง/ขาตั้ง/งานพิมพ์ ออก)
        _outer_wh = [0.0, 0.0]
        try:
            _skip_kind = ("wallplate", "standee_leg", "print")
            _ow = [L for L in out_layers if L.get("kind") not in _skip_kind]
            if _mat_groups and _ow:
                # 🧱 หลายวัสดุ: ขนาดนอกสุดจริง = กรอบรวมของ 'ทุกชั้นตัดของทุกกลุ่ม' (รวมคิ้วด้วย)
                #    ⚠️ ห้ามใช้ _FULL0 (รูปงานก่อนบวกคิ้ว) — จะรายงานเล็กกว่าจริง แล้วขนาดไม่ตรงที่กรอก
                _x0 = _y0 = 1e18; _x1 = _y1 = -1e18
                for _L in _ow:
                    for _sp in _L["subs"]:
                        for _p in [_sp["start"]] + [s[-1] for s in _sp["segs"]]:
                            _x0 = min(_x0, _p[0]); _y0 = min(_y0, _p[1])
                            _x1 = max(_x1, _p[0]); _y1 = max(_y1, _p[1])
                if _x1 > _x0:
                    _outer_wh = [round(_x1 - _x0, 1), round(_y1 - _y0, 1)]
                else:
                    _fb8 = _FULL0.bounds
                    _outer_wh = [round(_fb8[2] - _fb8[0], 1), round(_fb8[3] - _fb8[1], 1)]
            elif _ow:
                _outer_wh = [round(max(float(L.get("w_mm") or 0.0) for L in _ow), 1),
                             round(max(float(L.get("h_mm") or 0.0) for L in _ow), 1)]
            else:
                _fb0 = full.bounds
                _outer_wh = [round(_fb0[2] - _fb0[0], 1), round(_fb0[3] - _fb0[1], 1)]
        except Exception:
            _outer_wh = [0.0, 0.0]
        # bbox รวม (ชั้นที่ขยายสุด)
        allb = [full.buffer(max(0.0, float(L["off"])), join_style=1).bounds for L in rec["layers"]]
        MNX = min(b[0] for b in allb); MNY = min(b[1] for b in allb)
        MXX = max(b[2] for b in allb); MXY = max(b[3] for b in allb)
        perimeter = round(full.length / 10.0, 1)  # ซม.

        # preview = สเปคชีต แยกชั้น + เส้นจับขนาดต่อชิ้น · + ภาพ 3 มิติ exploded มีมิติ
        from vectorcnc import nesting
        svg = _spec_sheet_svg(out_layers)
        try:
            body3d = frame_outer if (frame_outer is not None and not frame_outer.is_empty) else full
            # 🧱 หลายวัสดุ: ภาพ 3 มิติ/ใบเสนอ ต้องเห็น 'ป้ายเต็มใบ' ทุกกลุ่ม
            #    กลุ่ม B/C/D วาดทับด้วย 'สีวัสดุของตัวเอง' + ความหนาของตัวเอง (เช่น พลาสวูดขาว 10 มม.)
            _mat_ov = []
            _mat_cut = None
            if _mat_groups:
                try:
                    from shapely.ops import unary_union as _uu3d
                    body3d = _uu3d([body3d] + [g["geom"] for g in _mat_groups])   # กรอบภาพต้องคลุมทุกกลุ่ม
                    # 🧱 พื้นที่ที่ 'ไม่ใช่ความหนาของตัวหลัก' — เจาะออกจากตัวที่วาด 3 มิติ
                    #    เพื่อให้กลุ่มพลาสวูด 10 มม. หนา 10 มม. จริง ไม่ใช่ 50 มม. ตามตัวหลัก
                    _mat_cut = _uu3d([g["geom"] for g in _mat_groups])
                except Exception:
                    pass
                for _g3 in _mat_groups:
                    _mat_ov.append({"geom": _g3["geom"], "fill": _g3.get("color") or "#f5f5f4",
                                    "tex": _g3.get("tex", ""), "tex_img": _g3.get("tex_img", ""),
                                    "depth_mm": float(_g3["rec"].get("depth_cm", 1.0)) * 10.0,
                                    "label": "%s · %s" % (_g3["name"], _g3["rec"].get("name", ""))})
            # 🎯 ============ ฉลุหน้า: วาดรูโบ๋จาก 'รูปทรงที่จัดวางแล้ว' เหมือนกล่องไฟปกติ ============
            #    กล่องไฟปกติ (พิมพ์หน้า) ไม่มีปัญหาเส้นเละเลย เพราะวาดจากรูปทรงที่ถูกจัดวางลงกล่องแล้วตรง ๆ
            #    แต่ฉลุหน้าเอา 'เส้นดิบ' มาคำนวณสเกลใหม่อีกรอบ (จาก bbox ก่อนจัดวาง เทียบ หลังจัดวาง)
            #    ถ้าสองค่านั้นคลาดกัน เส้นจะเละ/ล้นออกนอกป้าย — ทั้งที่ไฟล์ตัดถูกต้องอยู่แล้ว
            #    -> ตรวจก่อนใช้: เส้นดิบต้องทับกรอบรูโบ๋จริงภายใน 1% เท่านั้น ไม่งั้นทิ้ง ใช้รูปทรงแทน
            try:
                if _punch_raw_subs and bore_geom is not None and not bore_geom.is_empty:
                    _bx = []; _by = []
                    for _s7 in _punch_raw_subs:
                        for _q7 in [_s7["start"]] + [_g7[-1] for _g7 in _s7["segs"]]:
                            _bx.append(_q7[0]); _by.append(_q7[1])
                    if _bx:
                        _gb7 = bore_geom.bounds
                        _dw = abs((max(_bx) - min(_bx)) - (_gb7[2] - _gb7[0]))
                        _dh = abs((max(_by) - min(_by)) - (_gb7[3] - _gb7[1]))
                        _ref = max(1e-6, _gb7[2] - _gb7[0])
                        if (_dw / _ref) > 0.01 or (_dh / _ref) > 0.01 \
                                or min(_bx) < _gb7[0] - _ref * 0.01 or max(_bx) > _gb7[2] + _ref * 0.01:
                            warns.append("🛠️ ภาพ 3 มิติ: เส้นรูโบ๋ไม่ทับกรอบป้าย -> วาดจากรูปทรงที่จัดวางแล้วแทน "
                                         "(แบบเดียวกับกล่องไฟปกติ) · ไฟล์ตัดไม่ถูกแตะ")
                            _punch_raw_subs = None
            except Exception:
                _punch_raw_subs = None
            _art = ""
            if rec.get("face_finish") == "print":       # กล่องไฟล้อมทรง = จบด้วยงานพิมพ์ -> โชว์รูปจริงบนหน้า
                try: _art = _art_data_uri(inp)
                except Exception: _art = ""
            # 🖨️ หน้าพิมพ์ (face_finish=print) = แผ่นเต็มพิมพ์รูป -> ไม่มีคิ้วเจาะโบ๋มาทับรูป
            _bore = None if rec.get("face_finish") == "print" else bore_geom
            if _neon:                                   # 🌈 นีออน: เส้นไฟเรือง + อะคริลิคใส (แทนภาพ 3 มิติปกติ)
                svg3d = _neon_sign_svg(_neon_full, _acrylic, color=str(neon_color or "#00e5ff"), neon_subs=_neon_subs,
                                       tube_mm=(8.0 if (str(neon_line).lower() == "single" and _neon_subs) else None))
            else:
                # ป้ายอักษร + โครงแขวน -> ใช้ 'โครงยึดตัวอักษร' (เฟรมหลังอักษร + แขนขึ้น) ไม่ใช่แขนกล่องไฟ
                _m3d = "letterframe" if rec.get("mount_frame") else str(arm or "none")
                svg3d = _iso3d_svg(body3d, rec, perimeter, inner_bore=_bore,
                                   face_color=(face_color or None), side_color=(side_color or None),
                                   art_href=_art, mount=_m3d, arm_len_cm=float(arm_len_cm),
                                   plate_cm=10.0, arm_side=str(arm_side or "right"),
                                   arm_adjust=str(arm_adjust or "fixed"), arm_travel_cm=float(arm_travel_cm),
                                   arm_edge_cm=float(arm_edge_cm), arm_gap_cm=float(arm_gap_cm),
                                   leg_h_cm=float(leg_h_cm), leg_span_cm=float(leg_span_cm),
                                   caster_mm=float(caster_mm),
                                   caster_lock=str(caster_lock or '1') not in ('0','off','false'),
                                   art_adj=_art_adj, sticker_geom=_sticker_geom,
                                   metal_tex=str(metal_tex or ""), arm_color=str(arm_color or ""),
                                   metal_tex_img=str(metal_tex_img or ""), metal_tex_scope=str(metal_tex_scope or "face"),
                                   bore_subs=_punch_raw_subs, mat_overlays=_mat_ov, mat_cut=_mat_cut)
        except Exception:
            svg3d = ""
        # 📐 มุมมองมาตรฐาน Top / Front / Side (คู่กับ Perspective ด้านบน)
        try:
            _vd = (float(return_depth_cm) * 10.0) if float(return_depth_cm) > 0 else float(rec.get("depth_cm", 5.0)) * 10.0
            svg_views = _ortho_views_svg(_FULL0, rec, _vd, inner_bore=bore_geom,
                                         face_color=(face_color or None), side_color=(side_color or None),
                                         metal_tex=str(metal_tex or ""), metal_tex_img=str(metal_tex_img or ""),
                                         metal_tex_scope=str(metal_tex_scope or "face"))
        except Exception:
            svg_views = ""
        # 🔩 ไฟล์ตัดเพลทยึด 10cm (เจาะ 4 รู) — ส่งเข้าเลเซอร์/CNC ทำเพลทจริง
        mount_plate = {}
        if str(arm or "none").lower() in ("top2", "side1", "side2"):
            try:
                mount_plate = _mount_plate_files(10.0, str(arm))
            except Exception:
                mount_plate = {}

        # 📦 ส่งออกเฉพาะ .ai (ชุดชั้นตัด แยกเลเยอร์) — เลิกสร้าง DXF/SVG แล้ว (เร็วขึ้น + ไฟล์เบา)
        # ⚡ เดิมยังนั่ง 'สร้างเอกสาร DXF เต็มใบ' (วนเพิ่มทุกเส้นเข้า ezdxf) แล้วโยนทิ้งเพราะไม่ส่งออก
        #    งานละเอียด (เส้นเป็นหมื่น) เสียเวลาฟรีหลายวินาที = หนึ่งในต้นเหตุ 502
        #    -> ตัดการสร้างทิ้งทั้งก้อน เหลือเฉพาะ 'รายการชิ้นยกขอบ' ที่หน้าเว็บใช้จริง (ค่าเดิมเป๊ะ)
        # ชิ้นตัด 'ยกขอบ' (ผนังตั้งฉากแผ่นหลัง) = แถบแบน ยาว=เส้นรอบรูป × สูง=ความสูงผนัง (ตัดแล้วพับ/ดัด)
        wall_pieces = []
        peri_mm = float(full.length)
        for w in rec.get("walls", []):
            nm = str(w.get("name", "")); hh = float(w.get("h", 0)) * 10.0
            if hh <= 0 or not nm.startswith("ยกขอบ"):
                continue
            Lmm = peri_mm
            wall_pieces.append({"name": nm, "name_en": _en_wall(nm), "length_cm": round(Lmm / 10.0, 1), "height_cm": round(hh / 10.0, 1)})
        dxf_b64 = ""
        # 📄 SVG ชุดชั้นตัด (หน่วย มม. · ตำแหน่งจริงซ้อนกัน · แยก <g> ต่อชั้น เปิดใน LightBurn/Illustrator ได้)
        svg_cut = ""
        try:
            from vectorcnc import nesting as _nsv
            _ab = [1e18, 1e18, -1e18, -1e18]
            for _L in out_layers:
                for _sp in _L["subs"]:
                    _pt = [_sp["start"]] + [s[-1] for s in _sp["segs"]]
                    for _p in _pt:
                        _ab[0] = min(_ab[0], _p[0]); _ab[1] = min(_ab[1], _p[1])
                        _ab[2] = max(_ab[2], _p[0]); _ab[3] = max(_ab[3], _p[1])
            if _ab[2] > _ab[0]:
                _Wv = _ab[2] - _ab[0] + 4.0; _Hv = _ab[3] - _ab[1] + 4.0
                _gs = []
                for _L in out_layers:
                    _dd = []
                    for _sp in _L["subs"]:
                        _n = {"start": (_sp["start"][0] - _ab[0] + 2.0, _sp["start"][1] - _ab[1] + 2.0),
                              "segs": [("L", (s[1][0] - _ab[0] + 2.0, s[1][1] - _ab[1] + 2.0)) if s[0] == "L" else
                                       ("C", (s[1][0] - _ab[0] + 2.0, s[1][1] - _ab[1] + 2.0),
                                        (s[2][0] - _ab[0] + 2.0, s[2][1] - _ab[1] + 2.0),
                                        (s[3][0] - _ab[0] + 2.0, s[3][1] - _ab[1] + 2.0)) for s in _sp["segs"]],
                              "closed": _sp.get("closed", True)}
                        _dd.append('<path d="%s"/>' % _nsv._sp_d(_n))
                    if _dd:
                        _gs.append('<g id="%s" inkscape:groupmode="layer" inkscape:label="%s" '
                                   'fill="none" stroke="%s" stroke-width="0.25">%s</g>'
                                   % (_dxf_layer(_L["name"]), _en_layer(_L["name"]), _L["color"], "".join(_dd)))
                svg_cut = ('<svg xmlns="http://www.w3.org/2000/svg" '
                           'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
                           'width="%.2fmm" height="%.2fmm" viewBox="0 0 %.2f %.2f">%s</svg>'
                           % (_Wv, _Hv, _Wv, _Hv, "".join(_gs)))
        except Exception:
            svg_cut = ""
        # 🖼️ ภาพหน้าตรง (3D เบา ๆ พื้นโปร่ง) — เอาไปวางบนผนังในหน้าจำลองผนัง
        svg_face = ""
        try:
            if _neon:
                svg_face = _neon_sign_svg(_neon_full, _acrylic, color=str(neon_color or "#00e5ff"), neon_subs=_neon_subs,
                                          tube_mm=(8.0 if (str(neon_line).lower() == "single" and _neon_subs) else None))
            else:
                # ภาพวางผนัง = 'ตัวป้ายสะอาด' (ไม่ฝังแขน/โครง) -> ขนาด+สัดส่วนตรง ไม่บีบเพี้ยน
                # (แขน/โครง ทำเป็น overlay ปรับขยับแยกในหน้าจำลองผนัง)
                svg_face = _front_sign_svg(body3d, rec, inner_bore=_bore, art_adj=_art_adj,
                                           face_color=(face_color or None), art_href=_art, frame_top_cm=0.0,
                                           side_color=(side_color or None), metal_tex=str(metal_tex or ""),
                                           metal_tex_img=str(metal_tex_img or ""), metal_tex_scope=str(metal_tex_scope or "face"),
                                           sticker_geom=_sticker_geom, bore_subs=_punch_raw_subs)
        except Exception:
            svg_face = ""
        # 🔩 ป้ายอักษร + โครงแขวน -> ภาพด้านหลังมีโครงยึด (แยกเป็นอีกภาพ พร้อมจับระยะ)
        svg_back = ""; frame_info = {}
        if rec.get("mount_frame"):
            try:
                from vectorcnc import mount_frame as MF
                _mf = MF.build(full, bars=max(1, int(frame_bars)),
                               bar_y_cm=(None if float(frame_level_cm) < 0 else float(frame_level_cm)),
                               gap_cm=float(frame_gap_cm), frame_x_cm=float(frame_x_cm),
                               standoff_cm=float(frame_standoff_cm), wire_offset_cm=float(wire_offset_cm),
                               arm_len_cm=float(arm_len_cm), arm_edge_cm=float(arm_edge_cm))
                if not _mf.get("error"):
                    svg_back = _mf.get("back_svg", "")
                    frame_info = {"letters": _mf.get("letters", 0), "bolts": _mf.get("bolts", 0),
                                  "wires": _mf.get("wires", 0), "bars": _mf.get("bars", 0)}
            except Exception:
                svg_back = ""
        # 🏭 ค่าที่ต้องใช้ประกอบไฟล์สั่งผลิต — เก็บเป็นชุดเดียว (ใช้ทั้งตอนสร้างเลย และตอนกดสร้างทีหลัง)
        _BND = {"inp": inp, "rec": rec, "sign_type": sign_type, "real_width_mm": real_width_mm,
                "face_print": face_print, "out_layers": out_layers, "full": full, "svg3d": svg3d,
                "sticker_geom": _sticker_geom, "punch_raw_subs": _punch_raw_subs,
                "raw_subs": _RAW_SUBS.get("subs")}
        ai_b64 = ""; print_b64 = ""; print_info = {}
        if str(make_ai) == "0":
            # 🎨 โหมดแสดงแบบ: ยังไม่ประกอบไฟล์ — เก็บค่าไว้รอปุ่ม 'สร้างไฟล์ตัดสั่งผลิต (.ai)'
            try:
                if _pk is not None:
                    _cache_put(_PRODCACHE, _pk, _BND)
            except Exception:
                pass
        else:
            ai_b64, print_b64, print_info, _wprod = _prod_files(_BND)
            warns.extend(_wprod)
        # ⚡ LED layout (โชว์รายละเอียดไฟในผลลัพธ์กลางจอ) — 🌈 นีออน: เดินไฟตามเส้นนีออน
        # 🔌 เฉพาะ 'งานมีไฟ' เท่านั้น — งานแบน/ยกขอบ (ไม่มีไฟ) ข้ามการเดินไฟ LED
        #    งานมีไฟ = นีออน / edge-lit / back-lit / ชื่อประเภทมีคำว่า 'ไฟ' (ไฟออกหน้า·กล่องไฟ ฯลฯ)
        _has_light = bool(_neon or rec.get("edge_lit") or rec.get("back_lit")
                          or ("ไฟ" in str(rec.get("name", "")))) and not rec.get("no_light")
        led_info = {}
        try:
            if not _has_light:
                _led = None                              # งานไม่มีไฟ -> ไม่ทำแผนเดินไฟ
            elif _neon:
                _led = _neon_led_info(full, color=str(neon_color or "#00e5ff"), neon_subs=_neon_subs,
                                      watt_per_m=8.0, volt=12.0)
            elif rec.get("back_lit"):
                # 🆕 ไฟออกหลัง (halo) = LED เส้นเดียวตามแกนกลางตัวอักษร — หาแกนจาก 'รูปตัวอักษร' เป็นหลัก (แม่นกว่าจากภาพ)
                try:
                    _bsub2 = _skeleton_from_geom(full)
                except Exception:
                    _bsub2 = None
                if not _bsub2:
                    try:
                        _bsub2 = _skeleton_subs(inp, full)
                    except Exception:
                        _bsub2 = None
                _led = _neon_led_info(full, color=str(rec.get("glow_color") or "#eaf2ff"), neon_subs=_bsub2,
                                      watt_per_m=12.0, volt=12.0)
            else:
                from vectorcnc import mount_frame as _MF3
                _led = _MF3.led_layout(full, pitch_cm=float(led_pitch_cm), watt_per_m=12.0, volt=12.0)
            if _led:
                led_info = {"total_m": _led["total_m"], "watts": _led["watts"], "amps": _led["amps"],
                            "transformer_w": _led["transformer_w"], "pitch_cm": _led.get("pitch_cm", 6),
                            "preview_svg": _led["preview_svg"]}
        except Exception:
            led_info = {}

        _resp9 = {"type_name": rec["name"], "type_name_en": _en_type(rec["name"]), "sign_type": str(sign_type),
                "perimeter_cm": perimeter,
                "layers": [{"name": L["name"], "name_en": _en_layer(L["name"]), "off_cm": round(L["off"]/10.0, 3),
                            "kind": L.get("kind", "solid"), "color": L["color"], "w_mm": L["w_mm"], "h_mm": L["h_mm"],
                            "junk": L.get("junk", 0)} for L in out_layers],
                "walls": rec["walls"], "wall_pieces": wall_pieces, "warns": warns,
                "svg_preview": svg, "svg_3d": svg3d, "svg_views": svg_views, "svg_cut": svg_cut, "dxf_base64": dxf_b64,
                "ai_base64": ai_b64, "svg_back": svg_back, "frame_info": frame_info,
                "svg_face": svg_face, "led": led_info,
                # 🖼️ ต้องส่ง 'เส้นดิบจากเอนจิ้น' เข้าไปด้วยเสมอ — ให้มองเป็นภาพแบน ๆ ภาพเดียว
                #    แล้วลากเส้นตัดออกมาตรง ๆ (เหมือนแผนที่กลุ่มวัสดุที่ทำถูกอยู่แล้ว)
                #    ถ้าไม่ส่ง จะตกไปทางสำรองที่วาดเป็น 'ก้อนทึบสีเทาเข้ม'
                #    -> พื้นกลายเป็นดำ และชิ้นที่อยู่ในรู (เช่น ตัวหมีในวงกลม) หายไปทั้งชิ้น
                "sticker_map_svg": (_sticker_map_svg(full, _stick_pieces, _stick_sel,
                                                     _sticker_groups(_stick_pieces, full.bounds[2] - full.bounds[0],
                                                                     full.bounds[3] - full.bounds[1]),
                                                     raw_subs=(_MAP_SUBS or _FLAT.get("subs") or _RAW_SUBS.get("subs")))
                                    if (rec.get("punch_face") and _stick_pieces) else ""),
                "sticker_sel": sorted(_stick_sel),
                # 🧱 แผนที่ชิ้น สำหรับ 'จ่ายวัสดุคนละแบบในป้ายเดียว' (แตะคำเดียว = ทั้งคำ) — ใช้ได้ทุกประเภทป้าย
                # 📏 ขนาดจริงของ logo บนหน้ากล่อง (ซม.) — ให้หน้าเว็บเติมกลับในช่องกรอก
                "logo_w_cm": (_logo_wh[0] or round(_ARTFIT.get("w_mm", 0) / 10.0, 1) or
                              (round((_punch_logo.bounds[2] - _punch_logo.bounds[0]) / 10.0, 1)
                               if _punch_logo is not None and not _punch_logo.is_empty else 0)),
                "logo_h_cm": (_logo_wh[1] or round(_ARTFIT.get("h_mm", 0) / 10.0, 1) or
                              (round((_punch_logo.bounds[3] - _punch_logo.bounds[1]) / 10.0, 1)
                               if _punch_logo is not None and not _punch_logo.is_empty else 0)),
                # 🖼️ ภาพแบนที่เก็บไว้ก่อนขึ้นรูปทรง (ไว้ตรวจว่าเส้นครบตั้งแต่ต้น)
                "flat_lines": len(_FLAT.get("subs") or []),
                "flat_w_cm": round(_FLAT.get("w_mm", 0) / 10.0, 1),
                "flat_h_cm": round(_FLAT.get("h_mm", 0) / 10.0, 1),
                "mat_map_svg": _mat_map_svg, "mat_pieces": len(_mat_pieces),
                "mat_groups": [{"tag": g["tag"], "name": g["name"], "type_name": g["rec"].get("name", ""),
                                "pieces": g["idx"], "material": g["material"],
                                "depth_cm": g["rec"].get("depth_cm", 0)} for g in _mat_groups],
                # 📐 ขนาดนอกจริงของ 'ตัวป้าย' (ไม่รวมแผ่นขอบข้าง/ขาตั้ง/งานพิมพ์ ที่วางแยกเป็นชิ้นตัด)
                #    ⚠️ ห้ามใช้ max(w_mm) ของทุกเลเยอร์ — แถบขอบข้างยาวเป็นเมตร จะทำให้ชดเชยขนาดเพี้ยน
                "outer_w_mm": _outer_wh[0], "outer_h_mm": _outer_wh[1],
                "print_base64": print_b64, "print_info": print_info,     # 🖨️ ไฟล์งานพิมพ์ UV / สติ๊กเกอร์
                "mount": str(arm or "none"), "arm_len_cm": float(arm_len_cm),
                "mount_plate": mount_plate}
        if _rck is not None:
            _cache_put(_LAYERSET_CACHE, _rck, _resp9)   # ⚡ จำผลไว้ตอบคำขอซ้ำทันที
        return _resp9
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _job_sheet_html(meta, type_name, type_name_en, Wcm, Hcm, persp_svg, back_svg, led, bom_rows, frame_info, cut_rows=None, cut_img="", views_svg=""):
    """ประกอบ 'ใบสั่งผลิต / แบบยืนยันลูกค้า' เป็น HTML พร้อมพิมพ์ (Thai ผ่าน Google Fonts)"""
    def esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    led = led or {}
    kpis = ""
    if led:
        for n, l in [("%.2f ม." % led.get("total_m", 0), "ความยาว"), ("%.0f W" % led.get("watts", 0), "กำลังไฟ"),
                     ("%.1f A" % led.get("amps", 0), "กระแส"), ("%d W" % led.get("transformer_w", 0), "หม้อแปลง")]:
            kpis += '<div class="b"><div class="n">%s</div><div class="l">%s</div></div>' % (n, l)
    bom = "".join('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>'
                  % (esc(a), esc(b), esc(c), esc(d)) for (a, b, c, d) in bom_rows)
    frame_card = ""
    if back_svg:
        fi = frame_info or {}
        chips = ('<span class="chip">ตัวอักษร %s ชิ้น</span><span class="chip"><span class="dot" style="background:#2563eb"></span>รูน็อต &#216;3 · %s รู</span>'
                 '<span class="chip"><span class="dot" style="background:#e11d48"></span>รูสายไฟ &#216;5 · %s รู</span><span class="chip">โครงเหล็กกล่อง 1 นิ้ว · standoff 5 ซม.</span>'
                 % (fi.get("letters", "-"), fi.get("bolts", "-"), fi.get("wires", "-")))
        frame_card = ('<div class="card"><div class="ct"><span class="no">2</span>โครงเหล็กแขวนป้าย (มุมมองด้านหลัง)</div>'
                      '<div class="cbody"><div class="imgwrap">%s</div><div style="margin-top:8px">%s</div></div></div>' % (back_svg, chips))
    led_card = ""
    if led:
        _ltype = "LED Ribbon (เส้นยืด)" if meta.get("led_type") == "Ribbon" else "LED Module 3030"
        led_card = ('<div class="card"><div class="ct"><span class="no">3</span>การวางไฟ LED + คำนวณกำลังไฟ</div>'
                    '<div class="cbody"><div class="imgwrap dark">%s</div><div class="kpi">%s</div>'
                    '<table><tr><th>รายการ</th><th>สเปค</th></tr>'
                    '<tr><td>ชนิดไฟ LED</td><td class="r">%s · 12V · IP65</td></tr>'
                    '<tr><td>สีไฟ</td><td class="r">%s</td></tr>'
                    '<tr><td>ความยาวเส้นไฟรวม</td><td class="r">%.2f เมตร</td></tr>'
                    '<tr><td>ระยะห่างแต่ละช่อง (pitch)</td><td class="r">%s ซม.</td></tr>'
                    '<tr><td>ระยะวางจากขอบข้าง</td><td class="r">%s ซม.</td></tr>'
                    '<tr><td>สายไฟเมน</td><td class="r">%s</td></tr>'
                    '<tr><td>หม้อแปลง</td><td class="r">Switching 12V %d W (spare ~30%%)</td></tr></table></div></div>'
                    % (led.get("preview_svg", ""), kpis, esc(_ltype), esc(meta.get("led_color", "Warm White 3000K")),
                       led.get("total_m", 0), meta.get("led_pitch_cm", 6), meta.get("led_edge_cm", 3),
                       esc(meta.get("wire", "VCT 2×1.5 mm²")), led.get("transformer_w", 0)))
    # 🖨️ งานพิมพ์ (ถ้ามี) + 🗂️ nesting (ถ้ากดมาก่อน)
    print_card = ""
    if meta.get("print_spec"):
        print_card = ('<div class="card full"><div class="ct"><span class="no">4</span>งานพิมพ์ (Artwork · หน้าอะคริลิคพิมพ์)</div>'
                      '<div class="cbody"><div style="font-size:13px;color:#334155">พิมพ์บน: <b>%s</b> · จบด้วยพิมพ์ UV / ติดสติกเกอร์ · คุมสีตามไฟล์ต้นฉบับ</div></div></div>'
                      % esc(meta.get("print_spec")))
    nest_card = ""
    if meta.get("nesting_b64"):
        nest_card = ('<div class="card full"><div class="ct"><span class="no">5</span>ภาพจัดเรียงชั้นตัดวัตถุดิบ (Nesting)</div>'
                     '<div class="cbody"><div class="imgwrap"><img src="data:image/png;base64,%s" style="max-width:100%%;max-height:360px"/></div></div></div>'
                     % meta.get("nesting_b64"))
    # 📐 Cut Layers — ชิ้นตัดแยกชั้น + allowance + ขนาดตัดต่อชิ้น (ครบทุกชั้นเหมือนหน้าออกแบบ)
    cut_card = ""
    if cut_rows:
        crows = "".join(
            '<tr><td><span class="dot" style="background:%s;border-radius:2px"></span>&nbsp;<b>%s</b> <span style="color:#94a3b8;font-size:11px">(%s)</span></td>'
            '<td class="r" style="color:#4f46e5">%s</td><td class="r">%s</td><td>%s</td></tr>'
            % (c[5], esc(c[0]), esc(c[1]), esc(c[2]), esc(c[3]), esc(c[4])) for c in cut_rows)
        cut_card = ('<div class="card full"><div class="ct"><span class="no">C</span>ชิ้นตัดแยกชั้น (Cut Layers) · allowance + ขนาดตัดต่อชิ้น</div>'
                    '<div class="cbody"><table><tr><th>Layer</th><th class="r">Allowance</th><th class="r">ขนาดตัด (W&#215;H)</th><th>วัสดุ</th></tr>%s</table>'
                    '<div style="font-size:11px;color:#64748b;margin-top:6px">* allowance = ค่าเผื่อขอบต่อชั้น (+ ขยายออก / &#8722; หดเข้า) · ขนาดตัด = กรอบนอกของชิ้นนั้น สำหรับสั่งตัด/Nesting</div></div></div>' % crows)
    # 📐 ภาพไฟล์ตัด (เส้นตัดทุกชั้นรวม) — โชว์ในใบสั่งผลิต
    cutimg_card = ""
    if cut_img:
        cutimg_card = ('<div class="card"><div class="ct"><span class="no">✂</span>ภาพไฟล์ตัด (Cut Lines · ทุกชั้น)</div>'
                       '<div class="cbody"><div class="imgwrap">%s</div></div></div>' % cut_img)
    # 📐 มุมมอง Top / Front / Side (คู่กับ Perspective ด้านบน)
    views_card = ""
    if views_svg:
        views_card = ('<div class="card big3d"><div class="ct"><span class="no">4</span>มุมมองมาตรฐาน — Top · Front · Side · Back View</div>'
                      '<div class="cbody"><div class="imgwrap">%s</div></div></div>' % views_svg)
    # 💡 ตัวอย่างสีไฟที่ลูกค้าเลือก
    ledcol_card = ""
    try:
        _lc = str(meta.get("led_color") or "")
        if _lc:
            ledcol_card = ('<div class="card"><div class="ct"><span class="no">5</span>สีไฟที่ลูกค้าเลือก</div>'
                           '<div class="cbody"><div class="imgwrap dark">%s</div></div></div>'
                           % _led_color_card_svg(_lc, meta.get("glow_mode", "front")))
    except Exception:
        ledcol_card = ""
    # จัดวันที่ส่งมอบให้อ่านง่าย (YYYY-MM-DD -> DD/MM/YYYY)
    _dv = str(meta.get("delivery") or "").strip()
    try:
        if _dv and len(_dv) >= 10 and _dv[4] == "-" and _dv[7] == "-":
            _dv = "%s/%s/%s" % (_dv[8:10], _dv[5:7], _dv[0:4])
    except Exception:
        pass
    html = _JOB_SHEET_CSS
    html = html.replace("__TITLE__", esc(type_name))
    for k, v in {"__JOBNO__": meta.get("job_no", "JOB-XXXX"), "__DATE__": meta.get("date", ""),
                 "__DELIV__": esc(_dv or "— ยังไม่ระบุ —"),
                 "__CUST__": esc(meta.get("customer", "-")), "__TYPE__": esc(type_name), "__TYPEEN__": esc(type_name_en),
                 "__SIZE__": "%d × %d ซม." % (Wcm, Hcm), "__SALES__": esc(meta.get("sales", "-")),
                 "__GRAPHIC__": esc(meta.get("graphic", "-")),
                 "__MATERIAL__": esc(meta.get("material", "-")),
                 "__PERSP__": persp_svg, "__VIEWS__": views_card, "__LEDCOLOR__": ledcol_card,
                 "__FRAME__": frame_card, "__LED__": led_card, "__CUTIMG__": cutimg_card,
                 "__PRINT__": print_card, "__NEST__": nest_card, "__CUT__": cut_card, "__BOM__": bom}.items():
        html = html.replace(k, str(v))
    return html


_JOB_SHEET_CSS = '''<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ใบสั่งผลิต · __TITLE__</title>
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Prompt,sans-serif;background:#e7ebf2;color:#1e293b;padding:16px;font-size:13.5px}
/* 📄 A3 แนวนอน (420×297มม.) — จบหน้าเดียว */
.sheet{width:1560px;max-width:100%;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(30,41,59,.14)}
.hd{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.hd h1{font-size:22px;font-weight:800}.hd .sub{font-size:13px;opacity:.8;margin-top:2px}.hd .meta{text-align:right;font-size:13px;line-height:1.7}
.badge{display:inline-block;background:#22d3ee;color:#083344;font-weight:700;padding:3px 12px;border-radius:20px;font-size:13px}
.info{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#e2e8f0}
.info .c{background:#f8fafc;padding:10px 16px}.info .k{font-size:11.5px;color:#64748b;text-transform:uppercase;letter-spacing:.4px}.info .v{font-size:15.5px;font-weight:700;color:#0f172a;margin-top:2px}
.body{padding:14px 18px}
.card{border:1px solid #e2e8f0;border-radius:11px;overflow:hidden;background:#fff}
.ct{display:flex;align-items:center;gap:8px;padding:9px 12px;font-weight:700;font-size:14.5px;border-bottom:1px solid #eef2f7}
.ct .no{width:22px;height:22px;border-radius:6px;background:#1e3a5f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex:none}
.cbody{padding:10px 12px}.imgwrap{background:#f1f5f9;border-radius:8px;padding:6px;text-align:center}.imgwrap svg{max-width:100%;height:auto;max-height:230px}.imgwrap.dark{background:#0f1522}
.big3d .imgwrap svg{max-height:300px}
/* 🖼️ แถวบน: แบบ 3 มิติ (กว้าง 2 ส่วน) + ภาพหน้างาน + ภาพอ้างอิง อยู่คู่กัน */
.toprow{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;align-items:start;margin-bottom:12px}
.toprow .site{min-height:118px}
/* 📐 แถวกลาง: 4 มุมมอง (กว้าง 3 ส่วน) + ตัวอย่างสีไฟ (1 ส่วน) */
.midrow{display:grid;grid-template-columns:3fr 1fr;gap:12px;align-items:start;margin-bottom:12px}
.midrow .imgwrap svg{max-height:210px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 9px;border-bottom:1px solid #eef2f7;text-align:left}th{background:#f8fafc;color:#475569;font-weight:600;font-size:12px;text-transform:uppercase}td.r{text-align:right;font-weight:700;color:#0f172a}
.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:8px 0}.kpi .b{background:#f0f9ff;border:1px solid #bae6fd;border-radius:9px;padding:8px;text-align:center}.kpi .b .n{font-size:17px;font-weight:800;color:#0369a1}.kpi .b .l{font-size:11px;color:#64748b}
.chip{display:inline-flex;align-items:center;gap:5px;background:#f1f5f9;border-radius:6px;padding:4px 10px;font-size:12.5px;margin:2px 3px 2px 0}.dot{width:11px;height:11px;border-radius:50%;display:inline-block}
/* 🧱 กริด 3 คอลัมน์ — จัดการ์ดทุกใบให้แน่น จบหน้าเดียว (เรนเดอร์ชัวร์กว่า column-count) */
.masonry{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-items:start}
.masonry .card{width:auto}
.site{border:2px dashed #cbd5e1;border-radius:10px;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;gap:6px;background:#f8fafc;cursor:pointer}
.site:hover{border-color:#22d3ee;color:#0891b2}
#siteImg{max-width:100%;border-radius:8px;display:none;margin-top:2px}
.editnote{min-height:88px;border:1px dashed #cbd5e1;border-radius:8px;padding:8px 10px;font-size:13.5px;line-height:1.7;outline:none;color:#1e293b;white-space:pre-wrap}
.editnote:empty:before{content:attr(data-ph);color:#94a3b8}
.editnote:focus{border-color:#22d3ee;background:#f0fdff}
.foot{border-top:2px solid #e2e8f0;padding:14px 22px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.sign{text-align:center}.sign .line{border-top:1.5px solid #94a3b8;margin:28px 12px 6px}.sign .r{font-size:12.5px;color:#64748b}
.note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:9px 12px;font-size:12.5px;margin:0 22px 14px}
.expbar{position:fixed;top:12px;right:12px;display:flex;gap:8px;z-index:99}
.pbtn{background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:9px 15px;font-family:Prompt;font-weight:700;cursor:pointer;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.2)}
.pbtn.pdf{background:#dc2626}.pbtn.jpg{background:#0d9488}
@media print{
  html,body{background:#fff;padding:0;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;height:auto;overflow:hidden}
  .sheet{box-shadow:none;border-radius:0;
    /* 📄 บังคับ 1 หน้า A3 แนวนอน เสมอ: กว้างเต็มพื้นที่พิมพ์ · ย่อทั้งแผ่นด้วย --fit (คำนวณจาก JS) */
    width:1560px;transform:scale(var(--fit,1));transform-origin:top left}
  .expbar{display:none}
  .card,.big3d{break-inside:avoid;page-break-inside:avoid}
  .masonry{gap:9px}
}
@page{size:A3 landscape;margin:6mm}
</style></head><body>
<div class="expbar" id="expbar">
  <button class="pbtn pdf" onclick="savePDF()">📄 บันทึก PDF (A3)</button>
  <button class="pbtn jpg" onclick="saveJPG()">🖼️ บันทึก JPG</button>
  <button class="pbtn" onclick="window.print()">🖨️ พิมพ์</button>
</div>
<div class="sheet">
  <div class="hd"><div><h1>ใบสั่งผลิตป้าย / แบบยืนยันลูกค้า</h1><div class="sub">Production Spec Sheet &amp; Customer Confirmation · __TYPEEN__</div></div>
    <div class="meta"><span class="badge">DRAFT · รออนุมัติ</span><br>เลขที่งาน <b>__JOBNO__</b><br>วันที่ออกแบบ <b>__DATE__</b><br>กำหนดส่งมอบ <b>__DELIV__</b></div></div>
  <div class="info">
    <div class="c"><div class="k">ลูกค้า</div><div class="v">__CUST__</div></div>
    <div class="c"><div class="k">ประเภทป้าย</div><div class="v">__TYPE__</div></div>
    <div class="c"><div class="k">ขนาดรวม</div><div class="v">__SIZE__</div></div>
    <div class="c"><div class="k">วัสดุหลัก</div><div class="v">__MATERIAL__</div></div>
    <div class="c"><div class="k">กำหนดส่งมอบ</div><div class="v">__DELIV__</div></div>
    <div class="c"><div class="k">เซลล์ / กราฟิก</div><div class="v" style="font-size:12.5px">👤 __SALES__<br><span style="color:#475569">🎨 __GRAPHIC__</span></div></div></div>
  <div class="body">
    <!-- 🖼️ แถวบน: แบบงานออกแบบ (3 มิติ) + ภาพหน้างานจริง + ภาพอ้างอิง — วางคู่กันให้เทียบได้ทันที -->
    <div class="toprow">
      <div class="card big3d"><div class="ct"><span class="no">1</span>ภาพ 3 มิติ (Perspective View) · พร้อมโครง + จับระยะ · วัสดุหลัก __MATERIAL__</div><div class="cbody"><div class="imgwrap">__PERSP__</div></div></div>
      <div class="card"><div class="ct"><span class="no">2</span>ภาพหน้างานจริง / จุดติดตั้ง</div><div class="cbody">
        <label for="siteFile"><div class="site" id="siteBox"><div style="font-size:26px">📷</div><div>คลิกแนบภาพหน้างาน</div><div style="font-size:10px">ถ่ายจุดติดตั้งจริง</div></div></label>
        <input type="file" id="siteFile" accept="image/*" style="display:none">
        <img id="siteImg" alt="ภาพหน้างาน">
      </div></div>
      <div class="card"><div class="ct"><span class="no">3</span>ภาพอ้างอิง (แบบ/ตัวอย่างงาน)</div><div class="cbody">
        <label for="refFile"><div class="site" id="refBox"><div style="font-size:26px">🖼️</div><div>คลิกแนบภาพอ้างอิง</div><div style="font-size:10px">แบบลูกค้า / งานเดิม</div></div></label>
        <input type="file" id="refFile" accept="image/*" style="display:none">
        <img id="refImg" alt="ภาพอ้างอิง" style="max-width:100%;border-radius:8px;display:none;margin-top:2px">
      </div></div>
    </div>
    <!-- 📐 แถวกลาง: 4 มุมมองมาตรฐาน + ตัวอย่างสีไฟ -->
    <div class="midrow">
      __VIEWS__
      __LEDCOLOR__
    </div>
    <div class="masonry">
      __CUTIMG__
      __FRAME__
      __LED__
      __CUT__
      __PRINT__
      __NEST__
      <div class="card"><div class="ct"><span class="no">B</span>รายละเอียดวัตถุดิบ / สเปค (BOM)</div><div class="cbody"><table><tr><th>ชิ้นส่วน</th><th>วัสดุ</th><th>สเปค</th><th>หมายเหตุ</th></tr>__BOM__</table></div></div>
      <div class="card"><div class="ct"><span class="no">✎</span>รายละเอียดเพิ่มเติม / หมายเหตุ (พิมพ์ได้)</div><div class="cbody"><div class="editnote" contenteditable="true" data-ph="คลิกเพื่อพิมพ์รายละเอียดเพิ่มเติม เช่น สี Pantone · วิธีติดตั้ง · เงื่อนไข/กำหนดพิเศษ ..."></div></div></div>
    </div>
  </div>
  <div class="note">⚠️ กรุณาตรวจสอบ ข้อความ / ขนาด / สี / ตำแหน่งติดตั้ง ให้ถูกต้องก่อนเซ็นอนุมัติ — เมื่ออนุมัติแล้วเข้าสู่การผลิตทันที</div>
  <div class="foot"><div class="sign"><div class="line"></div><div class="r">ผู้ออกแบบ / เซลล์</div></div><div class="sign"><div class="line"></div><div class="r">ผู้อนุมัติผลิต (โรงงาน)</div></div><div class="sign"><div class="line"></div><div class="r">ลูกค้าอนุมัติแบบ · วันที่</div></div></div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script>
var JOBNO="__JOBNO__";
// 📷 แนบภาพหน้างาน + 🖼️ ภาพอ้างอิง (ฝั่ง client — ติดไปกับ PDF/JPG/พิมพ์ ด้วย)
(function(){
  function hook(fid,iid,bid){var sf=document.getElementById(fid);if(!sf)return;
    sf.onchange=function(){var f=this.files&&this.files[0];if(!f)return;var r=new FileReader();
      r.onload=function(){var im=document.getElementById(iid);im.src=r.result;im.style.display='block';
        var b=document.getElementById(bid);if(b)b.style.display='none';};r.readAsDataURL(f);};}
  hook('siteFile','siteImg','siteBox'); hook('refFile','refImg','refBox');
})();
function _busy(b){var e=document.getElementById('expbar');if(e)e.style.opacity=b?.4:1;}
// 📄 บังคับ A3 แนวนอน '1 แผ่นเสมอ' — พื้นที่พิมพ์ 408×285มม. : ถ้าเนื้อหาสูงเกินสัดส่วน ให้ย่อทั้งแผ่นพอดีหน้า
function _fitOnePage(){
  try{
    var sh=document.querySelector('.sheet'); if(!sh)return 1;
    var W=1560.0, targetH=W*(285.0/408.0);            // สูงสุดที่ 1 หน้า A3 รับได้ (ตามสัดส่วนพื้นที่พิมพ์ 408×285มม.)
    var h=sh.scrollHeight||sh.offsetHeight||1;
    var fit=Math.min(1.0, targetH/h);
    document.documentElement.style.setProperty('--fit', String(fit));
    return fit;
  }catch(e){ return 1; }
}
// 📏 ย่อเนื้อหาให้พอดี 1 หน้า A3 'ก่อนแคปภาพ' (ใช้กับ PDF/JPG) แล้วคืนสภาพ
function _fitForCapture(on){
  var sh=document.querySelector('.sheet'); if(!sh)return 1;
  if(!on){ sh.style.transform=''; sh.style.transformOrigin=''; sh.style.width=''; return 1; }
  var W=1560.0, targetH=W*(285.0/408.0);
  var h=sh.scrollHeight||sh.offsetHeight||1;
  var f=Math.min(1.0, targetH/h);
  if(f<0.999){ sh.style.width=W+'px'; sh.style.transformOrigin='top left'; sh.style.transform='scale('+f+')'; }
  return f;
}
window.addEventListener('beforeprint', _fitOnePage);
window.addEventListener('load', _fitOnePage);
function _cap(cb){_busy(true);
  var fr=(document.fonts&&document.fonts.ready)?document.fonts.ready:Promise.resolve();
  fr.then(function(){return new Promise(function(r){setTimeout(r,150);});}).then(function(){
    var _f=_fitForCapture(true);                       // 📄 A3 แนวนอน 1 แผ่นเสมอ
    var _sh=document.querySelector('.sheet');
    var _opt={scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false};
    if(_f<0.999){ _opt.width=Math.ceil(1560*_f); _opt.height=Math.ceil((_sh.scrollHeight||1)*_f);
                  _opt.windowWidth=1560; }
    setTimeout(function(){
      html2canvas(_sh,_opt)
        .then(function(cv){_fitForCapture(false);_busy(false);cb(cv);})
        .catch(function(e){_fitForCapture(false);_busy(false);alert('สร้างภาพไม่ได้: '+e);});
    },80);
  });}
function saveJPG(){_cap(function(cv){var a=document.createElement('a');a.href=cv.toDataURL('image/jpeg',.92);a.download='JobSheet_'+JOBNO+'.jpg';a.click();});}
function savePDF(){_cap(function(cv){var J=(window.jspdf||{}).jsPDF;if(!J){alert('โหลดตัวสร้าง PDF ไม่ได้ — ลองใช้ปุ่มพิมพ์แทน');return;}
  var pdf=new J({orientation:'landscape',unit:'mm',format:'a3'});var pw=420,ph=297,m=6;
  var iw=cv.width,ih=cv.height;var r=Math.min((pw-2*m)/iw,(ph-2*m)/ih);var w=iw*r,h=ih*r;
  pdf.addImage(cv.toDataURL('image/jpeg',.94),'JPEG',(pw-w)/2,(ph-h)/2,w,h);pdf.save('JobSheet_'+JOBNO+'.pdf');});}
</script>
</body></html>'''


@app.post("/api/job-sheet")
async def job_sheet(file: UploadFile = File(...), sign_type: str = Form("1"),
                    real_width_mm: float = Form(600.0), customer: str = Form(""),
                    job_no: str = Form(""), sales: str = Form(""),
                    return_depth_cm: float = Form(0.0), n_colors: int = Form(6),
                    arm: str = Form("none"), arm_len_cm: float = Form(30.0),
                    leg_h_cm: float = Form(70.0), leg_span_cm: float = Form(0.0),
                    caster_mm: float = Form(75.0), caster_lock: str = Form("1"),
                    led_pitch_cm: float = Form(6.0), led_watt_per_m: float = Form(12.0),
                    led_volt: float = Form(12.0), led_color: str = Form("Warm White 3000K"),
                    frame_bars: int = Form(1), frame_level_cm: float = Form(-1.0),
                    frame_gap_cm: float = Form(20.0), frame_x_cm: float = Form(0.0),
                    frame_standoff_cm: float = Form(5.0), wire_offset_cm: float = Form(0.0),
                    material: str = Form(""), led_type: str = Form("module"),
                    wire_type: str = Form("indoor"), print_spec: str = Form(""),
                    delivery_date: str = Form(""), nesting_b64: str = Form(""), graphic: str = Form(""),
                    logo_scale: float = Form(100.0), logo_dx_cm: float = Form(0.0),
                    logo_dy_cm: float = Form(0.0), metal_tex: str = Form(""), arm_color: str = Form(""),
                    face_color: str = Form(""), side_color: str = Form(""),
                    neon_color: str = Form("#00e5ff"), neon_line: str = Form("double"),
                    neon_plate: str = Form("contour"), neon_margin_cm: float = Form(5.0),
                    metal_tex_img: str = Form(""), metal_tex_scope: str = Form("face"),
                    design_notes: str = Form(""), box_h_cm: float = Form(0.0), sticker_idx: str = Form(""),
                    cut_smooth_mm: float = Form(0.0), face_print: str = Form("uv"),
                    material_groups: str = Form(""),
                    logo_w_cm: float = Form(0.0), logo_h_cm: float = Form(0.0)):
    """สร้าง 'ใบสั่งผลิต / แบบยืนยันลูกค้า' (HTML พร้อมพิมพ์ PDF) รวม 3D + โครง + LED + BOM"""
    import datetime as _dt
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        _CUT_SMOOTH["mm"] = max(0.0, min(2.0, float(cut_smooth_mm or 0.0)))   # 🧈 ความเนียนเส้นตัด (ผู้ใช้ตั้ง)
        # 🔒 เลิกใช้ 'โหมดปลอดภัย' แล้ว — เส้นทางปกติผ่านด่านตรวจคุณภาพเส้นตัดอยู่แล้ว
        #    ปิดตายไว้ ห้ามเปิดจากภายนอก (ยังรับพารามิเตอร์ไว้กันหน้าเว็บเวอร์ชันเก่ายิงมาแล้วพัง)
        _SAFE["on"] = False
        rec = SIGN_TYPES.get(str(sign_type))
        if not rec:
            return JSONResponse({"error": "ไม่รู้จักแบบป้ายนี้"}, status_code=400)
        # 📏 ความลึกที่ผู้ใช้ตั้ง (เช่น 10 ซม.) -> ใช้ในภาพ 3 มิติ/Return/ผนังกล่อง ให้ตรงกับหน้าออกแบบ
        try:
            _rd = float(return_depth_cm)
        except Exception:
            _rd = 0.0
        if _rd > 0:
            import copy as _copy
            rec = _copy.deepcopy(rec)
            rec["depth_cm"] = _rd
            for _w in rec.get("walls", []):
                _nm = str(_w.get("name", ""))
                if _nm.startswith("ยกขอบ") and "ใน" not in _nm:
                    _w["h"] = _rd
        full = _letter_full_mm(inp, float(real_width_mm), 0.0, int(n_colors))
        if rec.get("wrap"):
            full = _wrap_silhouette(full, float(rec.get("wrap_bridge_cm", 3.0)) * 10.0)
        elif rec.get("box_shape"):
            _punch_logo = full if rec.get("punch_face") else None   # 🔦 เก็บรูป logo ไว้ฉลุโบ๋หน้ากล่อง
            full = _geom_box_fit(full, rec["box_shape"], float(rec.get("box_pad_cm", 3.0)) * 10.0, float(real_width_mm),
                                 float(box_h_cm or 0.0) * 10.0)
            if _punch_logo is not None:                              # ✂ ย่อ logo ให้อยู่ในกล่องพอดี
                _punch_logo = _punch_fit_in_box(_punch_logo, full, float(rec.get("box_pad_cm", 3.0)) * 10.0)
        try:
            _punch_logo
        except NameError:
            _punch_logo = None
        # 🎯 ผู้ใช้ปรับ logo ในกล่องเอง (ตรงกับหน้าออกแบบ)
        _laS = max(0.1, float(logo_scale or 100.0) / 100.0)
        # 📏 ขนาด logo เป็น ซม. (ต้องคิดแบบเดียวกับหน้าออกแบบเป๊ะ ๆ ใบสั่งผลิตจะได้ตรงกัน)
        try:
            _lw_t2 = float(logo_w_cm or 0.0) * 10.0; _lh_t2 = float(logo_h_cm or 0.0) * 10.0
            if (_lw_t2 > 1.0 or _lh_t2 > 1.0) and _punch_logo is not None and not _punch_logo.is_empty:
                _lb2 = _punch_logo.bounds
                _lw2 = _lb2[2] - _lb2[0]; _lh2 = _lb2[3] - _lb2[1]
                if _lh_t2 > 1.0 and _lh2 > 0.01:
                    _laS = _lh_t2 / _lh2
                elif _lw_t2 > 1.0 and _lw2 > 0.01:
                    _laS = _lw_t2 / _lw2
                _laS = max(0.02, min(20.0, _laS))
        except Exception:
            pass
        _laDX = float(logo_dx_cm or 0.0) * 10.0; _laDY = float(logo_dy_cm or 0.0) * 10.0
        _art_adj = ({"s": _laS, "dx": _laDX, "dy": _laDY}
                    if (abs(_laS - 1.0) > 0.005 or abs(_laDX) > 0.5 or abs(_laDY) > 0.5) else None)
        if _punch_logo is not None and _art_adj:
            try:
                from shapely import affinity as _aff
                _plb = _punch_logo.bounds
                _pcx = (_plb[0] + _plb[2]) / 2.0; _pcy = (_plb[1] + _plb[3]) / 2.0
                _punch_logo = _aff.translate(_aff.scale(_punch_logo, xfact=_laS, yfact=_laS, origin=(_pcx, _pcy)),
                                             xoff=_laDX, yoff=_laDY)
            except Exception:
                pass
        if _punch_logo is not None:                    # 🔦 ล้างเศษจิ๋ว + ขอบหยัก + เพิ่มความหนาขั้นต่ำ ให้ตรงกับหน้าออกแบบ
            _punch_logo, _ = _punch_logo_clean(_punch_logo)
            _punch_logo, _ = _punch_min_stroke(_punch_logo, min_w_mm=1.2)
        # 🏷️ สติ๊กเกอร์ (ไม่ตัด) — ลำดับชิ้นเดียวกับหน้าออกแบบ
        _sticker_geom = None; _stick_n = 0
        if _punch_logo is not None and str(sticker_idx or "").strip():
            try:
                _pl2 = list(_punch_logo.geoms) if _punch_logo.geom_type == "MultiPolygon" else [_punch_logo]
                _pl2 = sorted([p for p in _pl2 if p.geom_type == "Polygon" and not p.is_empty],
                              key=lambda p: (round(p.bounds[0], 1), round(p.bounds[1], 1)))
                _sel2 = set(int(t) for t in str(sticker_idx).split(",") if t.strip().isdigit() and int(t) < len(_pl2))
                if _sel2:
                    from shapely.ops import unary_union as _uu2
                    _sticker_geom = _uu2([_pl2[i] for i in sorted(_sel2)])
                    _keep2 = [p for i, p in enumerate(_pl2) if i not in _sel2]
                    _punch_logo = _uu2(_keep2) if _keep2 else None
                    _stick_n = len(_sel2)
            except Exception:
                _sticker_geom = None
        b = full.bounds; Wcm = round((b[2] - b[0]) / 10.0); Hcm = round((b[3] - b[1]) / 10.0)
        # perspective 3D
        fo = None; bore = None
        if _punch_logo is not None:
            fo = full; bore = _punch_logo               # 🔦 กล่องฉลุ: ตัวกล่อง + รูโบ๋ตาม logo
        for L in ([] if _punch_logo is not None else rec["layers"]):
            if L.get("kind") == "frame":
                fo = _mbuf(full, float(L["off"]) + 10.0); bore = _mbuf(full, float(L["off"])); break
        body3d = fo if (fo is not None and not fo.is_empty) else full
        _art = _art_data_uri(inp) if rec.get("face_finish") == "print" else ""
        _bore = None if rec.get("face_finish") == "print" else bore
        _nsub = None
        if rec.get("neon"):
            # 🌈 นีออน: ใช้ 'ภาพนีออนเรืองแสง' ตัวเดียวกับหน้าออกแบบ (ไม่ใช่ perspective เส้นเทา)
            _nmg = max(0.0, float(neon_margin_cm)) * 10.0
            try:
                _acr = _wrap_silhouette(full, 45.0).buffer(_nmg, join_style=1)
            except Exception:
                _acr = full.buffer(_nmg, join_style=1)
            if str(neon_plate).lower() in ("rect", "rectangle", "4", "square"):
                from shapely.geometry import box as _box
                _ab = _acr.bounds; _acr = _box(_ab[0], _ab[1], _ab[2], _ab[3])
            if str(neon_line).lower() == "single":
                try:
                    _nsub = _skeleton_subs(inp, full)
                except Exception:
                    _nsub = None
            try:
                persp = _neon_sign_svg(full, _acr, color=str(neon_color or "#00e5ff"), neon_subs=_nsub)
            except Exception:
                persp = ""
        else:
            try:
                persp = _iso3d_svg(body3d, rec, round(full.length / 10.0, 1), inner_bore=_bore, art_href=_art,
                                   mount=str(arm or "none"), arm_len_cm=float(arm_len_cm), plate_cm=10.0,
                                   leg_h_cm=float(leg_h_cm), leg_span_cm=float(leg_span_cm),
                                   caster_mm=float(caster_mm),
                                   caster_lock=str(caster_lock or "1") not in ("0", "off", "false"),
                                   art_adj=_art_adj, metal_tex=str(metal_tex or ""),
                                   face_color=(face_color or None), side_color=(side_color or None),
                                   arm_color=str(arm_color or ""), metal_tex_img=str(metal_tex_img or ""),
                                   metal_tex_scope=str(metal_tex_scope or "face"), sticker_geom=_sticker_geom)
            except Exception:
                persp = ""
        # frame back (type ที่มีโครงแขวน)
        back_svg = ""; frame_info = {}
        if rec.get("mount_frame"):
            try:
                from vectorcnc import mount_frame as MF
                _mf = MF.build(full, bars=max(1, int(frame_bars)),
                               bar_y_cm=(None if float(frame_level_cm) < 0 else float(frame_level_cm)),
                               gap_cm=float(frame_gap_cm), frame_x_cm=float(frame_x_cm),
                               standoff_cm=float(frame_standoff_cm), wire_offset_cm=float(wire_offset_cm))
                if not _mf.get("error"):
                    back_svg = _mf.get("back_svg", "")
                    frame_info = {"letters": _mf.get("letters", 0), "bolts": _mf.get("bolts", 0), "wires": _mf.get("wires", 0)}
            except Exception:
                back_svg = ""
        # LED layout — 🌈 นีออน: เดินไฟตามเส้นนีออน (ตรงกับ Perspective) · อื่นๆ: วางตามขอบอักษร
        # 🔌 เฉพาะงานมีไฟ — งานแบน/ยกขอบ (ไม่มีไฟ) ไม่ต้องเดินไฟ LED ในใบสั่งผลิต
        _has_light = bool(rec.get("neon") or rec.get("edge_lit") or rec.get("back_lit")
                          or ("ไฟ" in str(rec.get("name", "")))) and not rec.get("no_light")
        led = None
        try:
            if not _has_light:
                led = None
            elif rec.get("neon"):
                led = _neon_led_info(full, color=str(neon_color or "#00e5ff"), neon_subs=_nsub,
                                     watt_per_m=float(led_watt_per_m), volt=float(led_volt))
            elif rec.get("back_lit"):
                # 🆕 ไฟออกหลัง (halo) = เดินไฟ LED 'เส้นเดียว' ตามแกนกลางตัวอักษร — หาแกนจาก 'รูปตัวอักษร' เป็นหลัก
                try:
                    _bsub = _skeleton_from_geom(full)
                except Exception:
                    _bsub = None
                if not _bsub:
                    try:
                        _bsub = _skeleton_subs(inp, full)
                    except Exception:
                        _bsub = None
                led = _neon_led_info(full, color=str(rec.get("glow_color") or "#eaf2ff"), neon_subs=_bsub,
                                     watt_per_m=float(led_watt_per_m), volt=float(led_volt))
            else:
                from vectorcnc import mount_frame as MF
                led = MF.led_layout(full, pitch_cm=float(led_pitch_cm), watt_per_m=float(led_watt_per_m), volt=float(led_volt))
        except Exception:
            led = None
        # 🧱 วัสดุหลัก
        _MATN = {"acrylic": "อะคริลิค", "plaswood": "พลาสวูด (Plaswood)", "zinc": "ซิ้งค์ (สังกะสี)",
                 "stainless_silver": "สแตนเลสเงิน (เงา)", "stainless_gold": "สแตนเลสทอง (ไทเทเนียม)",
                 "stainless_rose": "สแตนเลสโรสโกลด์",
                 "acrylic_5mm": "อะคริลิค 5 มม.", "acrylic_8mm": "อะคริลิค 8 มม.", "acrylic_10mm": "อะคริลิค 10 มม.",
                 "plaswood_5mm": "พลาสวูด 5 มม.", "plaswood_10mm": "พลาสวูด 10 มม.",
                 "zinc_1mm": "ซิงค์ 1 มม.", "alu_07mm": "อลูมิเนียม 0.7 มม.",
                 "stainless_silver_hairline": "สแตนเลสเงิน (แฮร์ไลน์)",
                 "stainless_gold_mirror": "สแตนเลสทอง (เงา)", "stainless_gold_hairline": "สแตนเลสทอง (แฮร์ไลน์)",
                 "stainless_rose_mirror": "สแตนเลสโรสโกลด์ (เงา)", "stainless_rose_hairline": "สแตนเลสโรสโกลด์ (แฮร์ไลน์)"}
        _matn = _MATN.get(str(material), str(material)) if material else "ตามสเปควัสดุ"
        _ledtypen = "LED Module 3030" if str(led_type) == "module" else "LED Ribbon (เส้นยืด)"
        _edge_cm = round(float(led_pitch_cm) / 2.0, 1)
        _wiren = "VCT 2×1.5 mm² (Indoor)" if str(wire_type) == "indoor" else "สายกันน้ำ Outdoor 2×1.5 mm² (VCT-G/YY)"
        # BOM จากชั้นวัสดุ + LED + หม้อแปลง + งานพิมพ์
        bom = []
        # 🧱 ป้ายหลายวัสดุ -> ขึ้นหัวข้อกลุ่ม A แล้วต่อด้วยกลุ่ม B/C/D ที่จ่ายวัสดุเอง
        try:
            _mg_js = json.loads(material_groups) if str(material_groups or "").strip() else []
        except Exception:
            _mg_js = []
        _mg_js = [g for g in _mg_js if SIGN_TYPES.get(str(g.get("type") or ""))]
        _bp = "A · " if _mg_js else ""
        for L in rec["layers"]:
            _isface = (L.get("kind") != "frame" and "แผ่นพื้น" not in L["name"])
            _mm = _matn if _isface else "ตามสเปควัสดุ"
            bom.append((_bp + L["name"], _mm,
                        ("%+.1f ซม." % (float(L["off"]) / 10.0)) if abs(float(L["off"])) > 1e-6 else "เต็มทรง", ""))
        for _gi, _g in enumerate(_mg_js[:8]):
            _grec = SIGN_TYPES.get(str(_g.get("type")))
            _tag = chr(66 + _gi)
            _thk = _g.get("thick_mm") or (float(_g.get("depth_cm") or 0) * 10.0)
            _gmat = "%s%s" % (_grec.get("name", ""), (" · หนา %g มม." % float(_thk)) if _thk else "")
            for L in _grec.get("layers", []):
                bom.append(("%s · %s (%s)" % (_tag, L["name"], _g.get("name", "")), _gmat,
                            ("%+.1f ซม." % (float(L["off"]) / 10.0)) if abs(float(L["off"])) > 1e-6 else "เต็มทรง",
                            "แยกวัสดุจากตัวหลัก · เลเยอร์ .ai ขึ้นต้น %s_" % _tag))
        if rec.get("face_finish") == "print":
            _pm0 = _PRINT_MODES.get(str(face_print or "uv").lower(), _PRINT_MODES["uv"])
            bom.append(("หน้าอะคริลิคพิมพ์", (print_spec or "อะคริลิคขาวขุ่น P433"), "3mm / 5mm",
                        "%s · เผื่อตก %.0f มม." % (_pm0["th"], _pm0["bleed"])))
        if led:
            bom.append(("ไฟ LED", "%s · 12V · IP65" % _ledtypen,
                        "%.2f ม. · %.0f W · ช่อง %s ซม. · ห่างขอบ %s ซม." % (led["total_m"], led["watts"], led_pitch_cm, _edge_cm), led_color))
            bom.append(("หม้อแปลง", "Switching PSU", "12V %d W" % led["transformer_w"], "มี spare ~30%"))
            bom.append(("สายไฟเมน", _wiren, "ทนกระแส ~15A", str(wire_type)))
        if rec.get("mount_frame"):
            bom.append(("โครงแขวน", "เหล็กกล่องชุบ 1 นิ้ว", "standoff %s ซม." % frame_standoff_cm, "เจาะรูน็อต/สายไฟ"))
        # 🦿 ขาตั้งพื้น + ล้อเลื่อน — ลง BOM ให้ฝ่ายจัดซื้อสั่งของได้ทันที
        if str(arm or "").lower() == "floor":
            try:
                _lh9 = max(5.0, float(leg_h_cm)); _cm9 = max(20.0, float(caster_mm))
                _lk9 = str(caster_lock or "1") not in ("0", "off", "false")
                _sp9 = float(leg_span_cm or 0)
                bom.append(("ขาตั้ง (เสา)", "เหล็กกล่องชุบ 1 นิ้ว", "สูง %.0f ซม. × 2 ต้น" % _lh9,
                            "ระยะห่างขา %s" % ("%.0f ซม." % _sp9 if _sp9 > 1 else "อัตโนมัติ")))
                bom.append(("ขาตั้ง (คานล่าง)", "เหล็กกล่องชุบ 1 นิ้ว", "เชื่อมยึดขา 2 ต้น", "รองรับแป้นล้อ"))
                bom.append(("ล้อเลื่อน", "ล้อ PU แป้นหมุน", "Ø%.0f มม. × 4 ตัว" % _cm9,
                            "มีเบรก 2 ตัว" if _lk9 else "ไม่มีเบรก"))
                bom.append(("น็อตยึดล้อ", "สกรูเกลียวปล่อย/น็อต", "ชุดละ 4 ตัว × 4 ล้อ", "พร้อมแหวนรอง"))
            except Exception:
                pass
        # 📐 Cut layers — ชิ้นตัดแยกชั้น + allowance + ขนาดตัดต่อชิ้น (ให้ตรงกับพรีวิวหน้าออกแบบ)
        cut_rows = []
        _cut_layers = []     # เก็บ geometry แต่ละชั้นไว้วาด 'ภาพไฟล์ตัด' รวม
        _neon_js = bool(rec.get("neon"))
        for L in ([] if _neon_js else rec["layers"]):
            off = float(L["off"]); kind = L.get("kind", "solid")
            g = None
            try:
                if kind == "punch" and _punch_logo is not None:          # 🔦 หน้าโลหะฉลุโบ๋ logo
                    g = full.difference(_punch_logo)
                    if g.is_empty:
                        g = full
                elif kind == "backing" and _punch_logo is not None:      # 🥛 อะคริลิคสี่เหลี่ยมตามพื้นที่ logo
                    from shapely.geometry import box as _bx3
                    lb = _punch_logo.bounds
                    g = _bx3(lb[0] - 20.0, lb[1] - 20.0, lb[2] + 20.0, lb[3] + 20.0).intersection(full)
                elif kind == "frame":
                    g = _mbuf(full, off + float(L.get("band", 10.0)))   # ขอบนอกคิ้ว
                elif kind == "standee_leg":                             # 🧍 ขาตั้งสแตนดี้ (ชิ้นแยก)
                    from shapely.geometry import box as _bxL
                    _fbL = full.bounds
                    _lhL = max(200.0, min(900.0, (_fbL[3] - _fbL[1]) * 0.55))
                    _lwL = max(150.0, min((_fbL[2] - _fbL[0]) * 0.85, _lhL * 0.62))
                    g = _bxL(0.0, 0.0, _lwL, _lhL * 1.12)
                else:
                    g = _mbuf(full, off)
                if g is None or g.is_empty:
                    g = full
                cb = g.bounds
                _cw = round((cb[2] - cb[0]) / 10.0, 1); _ch = round((cb[3] - cb[1]) / 10.0, 1)
            except Exception:
                _cw, _ch = Wcm, Hcm
            _al = ("%+.2f ซม." % (off / 10.0)) if abs(off) > 1e-6 else "เต็มทรง"
            _isface = (kind != "frame" and "แผ่นพื้น" not in L["name"])
            _mmn = _matn if _isface else "ตามสเปควัสดุ"
            cut_rows.append((_en_layer(L["name"]), L["name"], _al, "%.1f × %.1f ซม." % (_cw, _ch), _mmn, L.get("color", "#64748b")))
            try:                                                     # 📐 เก็บเส้นตัดชั้นนี้ไว้ทำภาพ
                if g is not None and not g.is_empty:
                    _subs = _poly_to_subs(g, tol=0.05)
                    if _subs:
                        gb = g.bounds
                        _cut_layers.append({"name": L["name"], "off": off, "kind": kind,
                                            "color": L.get("color", "#64748b"), "rgb": L.get("rgb", (100, 116, 139)),
                                            "subs": _subs, "w_mm": round(gb[2]-gb[0], 1), "h_mm": round(gb[3]-gb[1], 1)})
            except Exception:
                pass
        try:
            cut_img = _spec_sheet_svg(_cut_layers) if _cut_layers else ""
        except Exception:
            cut_img = ""
        # 🧱 แผ่นขอบข้าง (return) = ชิ้นตัดจริง (แถบกว้าง = ความลึก) — ลงใบสั่งผลิตด้วย
        try:
            _wallsH2 = [w for w in rec.get("walls", []) if str(w.get("name", "")).startswith("ยกขอบ")]
            if _wallsH2 and (not rec.get("flat")) and (not rec.get("neon")):
                import math as _m3
                _D2 = float(rec.get("depth_cm", 5.0)) * 10.0
                _fb3 = full.bounds; _fw3 = (_fb3[2] - _fb3[0]) / 10.0; _fh3 = (_fb3[3] - _fb3[1]) / 10.0
                if rec.get("box_shape") == "rect":
                    _wtxt = "บน-ล่าง %.0f×%.0f ซม. ×2 · ซ้าย-ขวา %.0f×%.0f ซม. ×2" % (_fw3, _D2 / 10.0, _fh3, _D2 / 10.0)
                else:
                    _per2 = float(full.exterior.length if full.geom_type == "Polygon"
                                  else sum(g.exterior.length for g in full.geoms)) / 10.0
                    _n2 = max(1, int(_m3.ceil(_per2 / 150.0)))
                    _wtxt = "รวมยาว %.0f ซม. แบ่ง %d ท่อน × กว้าง %.0f ซม." % (_per2, _n2, _D2 / 10.0)
                cut_rows.append(("Side Return Plates", "แผ่นขอบข้าง (return)", "พับ/ดัดขึ้นรูป", _wtxt, _matn, "#f59e0b"))
        except Exception:
            pass
        if _stick_n:
            cut_rows.append(("Sticker (no cut)", "🏷️ สติ๊กเกอร์ดำ (ไม่ตัด)", "งานติดสติ๊กเกอร์",
                             "%d ชิ้น" % _stick_n, "สติ๊กเกอร์ตัดไดคัท สีดำ", "#0f172a"))
        if _neon_js:                                            # 🌈 นีออน: เส้นไฟ + ร่องเซาะ CNC + อะคริลิคใสรองหลัง
            nb = full.bounds; _nw = round((nb[2]-nb[0])/10.0, 1); _nh = round((nb[3]-nb[1])/10.0, 1)
            cut_rows.append(("Neon Flex (line)", "นีออนเฟล็กซ์ (เส้นไฟ)", "แนวเส้น", "%.1f × %.1f ซม." % (_nw, _nh), "LED Neon Flex 12V", "#00e5ff"))
            cut_rows.append(("CNC Groove 4mm", "เซาะร่อง CNC (ลึก 4mm)", "ลึก 4 mm", "%.1f × %.1f ซม." % (_nw, _nh), "ร่องเซาะเครื่อง CNC", "#d946ef"))
            try:
                _acj = _wrap_silhouette(full, 45.0).buffer(float(rec.get("neon_margin_cm", 3.0)) * 10.0, join_style=1)
                ab = _acj.bounds; _aw = round((ab[2]-ab[0])/10.0, 1); _ah = round((ab[3]-ab[1])/10.0, 1)
                cut_rows.append(("Clear Acrylic 8mm", "อะคริลิคใสรองหลัง 8mm", "+%.0f ซม." % float(rec.get("neon_margin_cm", 3.0)), "%.1f × %.1f ซม." % (_aw, _ah), "อะคริลิคใส 8 mm", "#93c5fd"))
            except Exception:
                pass
        meta = {"customer": customer or "-", "job_no": job_no or ("JOB-%s" % _dt.datetime.now().strftime("%Y%m%d-%H%M")),
                "sales": sales or "-", "graphic": graphic or "-", "date": _dt.datetime.now().strftime("%d/%m/%Y"), "led_color": led_color,
                "material": _matn, "led_type": ("Module" if str(led_type) == "module" else "Ribbon"),
                "led_pitch_cm": led_pitch_cm, "led_edge_cm": _edge_cm, "wire": _wiren,
                "print_spec": ((("%s · " % _PRINT_MODES.get(str(face_print or "uv").lower(), _PRINT_MODES["uv"])["th"])
                                if rec.get("face_finish") == "print" else "")
                               + (print_spec or ("อะคริลิคขาว P433 3/5mm" if rec.get("face_finish") == "print" else ""))),
                "delivery": delivery_date, "nesting_b64": nesting_b64}
        # 📐 มุมมอง Top / Front / Side ประกอบใบสั่งผลิต
        try:
            _vd2 = (float(return_depth_cm) * 10.0) if float(return_depth_cm) > 0 else float(rec.get("depth_cm", 5.0)) * 10.0
            views_svg = _ortho_views_svg(full, rec, _vd2, inner_bore=bore,
                                         face_color=(face_color or None), side_color=(side_color or None),
                                         metal_tex=str(metal_tex or ""), metal_tex_img=str(metal_tex_img or ""),
                                         metal_tex_scope=str(metal_tex_scope or "face"))
        except Exception:
            views_svg = ""
        # 🗒️ โน้ต/ข้อความอิสระ จากหน้าออกแบบ -> ทับลงภาพ 3 มิติหลักในใบสั่งผลิต (ติดไปตอนพิมพ์/PDF/JPG ด้วย)
        if design_notes:
            try:
                import json as _json
                persp = _notes_overlay_svg(persp, _json.loads(design_notes))
            except Exception:
                pass
        html = _job_sheet_html(meta, rec["name"], _en_type(rec["name"]), Wcm, Hcm, persp, back_svg, led, bom, frame_info, cut_rows, cut_img=cut_img, views_svg=views_svg)
        return {"html": html, "w_cm": Wcm, "h_cm": Hcm,
                "led": (led and {k: led[k] for k in ("total_m", "watts", "amps", "transformer_w")}) or {}}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _mat_of(nm):
    """จัดกลุ่มชื่อชั้น -> 'วัสดุ' (ไว้รวมแผ่นตามวัสดุ)"""
    n = str(nm)
    if "คิ้ว" in n:
        return "คิ้ว"
    if "พลาสวูด" in n:
        return "ไส้พลาสวูด"
    if "ไส้" in n and "อะคริลิค" in n:
        return "ไส้อะคริลิคใส"
    if "อะคริลิค" in n:
        return "อะคริลิค"
    if "ซิ้งค์" in n:
        return "ซิ้งค์"
    if "แผ่นพื้น" in n:
        return "แผ่นพื้น"
    return n


@app.post("/api/nest-layerset")
async def nest_layerset(request: Request):
    """หลายไฟล์ × แตกชั้นตามแบบป้าย -> รวม 'ตามวัสดุ' -> จัดวางแยกแผ่นต่อวัสดุ (คิ้วรวมแผ่น/อะคริลิครวมแผ่น/แผ่นพื้นรวมแผ่น)
       เลือกประเภทป้าย (1-7) ได้ต่อไฟล์ · ยกขอบ = แถบพับ รวมเป็นวัสดุหนึ่ง"""
    tmp = tempfile.mkdtemp()
    try:
        form = await request.form()
        meta = json.loads(form.get("meta") or "{}")
        fmeta = meta.get("files", [])
        sheet_w = float(meta.get("sheet_w", 1220)); sheet_h = float(meta.get("sheet_h", 2440))
        margin = float(meta.get("margin", 10)); gap = float(meta.get("gap", 5))
        divider_gap = float(meta.get("divider_gap", 14))
        from shapely.geometry import box as _box
        from vectorcnc import nesting
        PALETTE = [("#2563EB", (37, 99, 235)), ("#16a34a", (22, 163, 74)), ("#dc2626", (220, 38, 38)),
                   ("#9333ea", (147, 51, 234)), ("#ea580c", (234, 88, 12)), ("#0891b2", (8, 145, 178)),
                   ("#ca8a04", (202, 138, 4)), ("#db2777", (219, 39, 119)), ("#4f46e5", (79, 70, 229)),
                   ("#0d9488", (13, 148, 136))]
        MAT_ORDER = ["คิ้ว", "อะคริลิค", "ไส้อะคริลิคใส", "ไส้พลาสวูด", "ซิ้งค์", "แผ่นพื้น", "ยกขอบ (แถบพับ)"]
        mats = {}      # material -> [{label,color,rgb, piece:{poly,groups}, qty}]
        nfiles = 0
        for i, fm in enumerate(fmeta):
            up = form.get("file%d" % i)
            if up is None:
                continue
            fn = fm.get("name") or getattr(up, "filename", "f%d" % i)
            p = os.path.join(tmp, "in%d_%s" % (i, os.path.basename(str(fn))))
            with open(p, "wb") as fo:
                fo.write(await up.read())
            rec = SIGN_TYPES.get(str(fm.get("sign_type", "1")))
            if not rec:
                continue
            full = _letter_full_mm(p, float(fm.get("real_width_mm", 600)), float(fm.get("real_height_mm", 0)), int(fm.get("n_colors", 6)))
            color, rgb = PALETTE[nfiles % len(PALETTE)]
            label = fm.get("label") or chr(65 + nfiles)
            qty = max(1, int(fm.get("qty", 1)))
            nfiles += 1
            TW = float(meta.get("trim_width_cm", 1.0)) * 10.0
            TOUT = (str(meta.get("trim_dir", "out")).lower() != "in")
            for L in rec["layers"]:
                off = float(L["off"]); kind = L.get("kind", "solid")
                base = _mbuf(full, off)               # มุมฉาก (mitre) ไม่ปัดมน
                if base is None or base.is_empty:
                    continue
                if kind == "frame":
                    band = TW if TW > 0 else float(L.get("band", 10.0))
                    if TOUT:
                        o2 = _mbuf(full, off + band); i2 = base    # คิ้วขยายออกนอกตัวต้น
                    else:
                        o2 = base; i2 = _mbuf(full, off - band)
                    g = o2 if (i2 is None or i2.is_empty) else o2.difference(i2)
                    if g.is_empty:
                        g = o2
                else:
                    g = base
                mat = _mat_of(L["name"]); enmat = _en_layer(mat)
                # แตกชั้นเป็น 'ชิ้นย่อย' (ตัวอักษร/รูปแยกชิ้น) เพื่อ nest แพคชิด ไม่ใช่ทั้งป้ายก้อนเดียว
                comps = list(g.geoms) if getattr(g, "geom_type", "") == "MultiPolygon" else [g]
                comp_pieces = []
                for cg in comps:
                    if getattr(cg, "geom_type", "") != "Polygon" or cg.is_empty or cg.area < 4.0:
                        continue
                    csubs = _poly_to_subs(cg, tol=0.04)
                    if not csubs:
                        continue
                    comp_pieces.append({"poly": cg, "groups": [(csubs, color, rgb, enmat)]})
                if not comp_pieces:
                    continue
                mats.setdefault(mat, []).append({"label": label, "color": color, "rgb": rgb, "pieces": comp_pieces, "qty": qty})
            # ยกขอบ = แถบพับ (สี่เหลี่ยม ยาว=เส้นรอบรูป × สูง=ความสูงผนัง)
            peri = float(full.length)
            for w in rec.get("walls", []):
                nm = str(w.get("name", "")); hh = float(w.get("h", 0)) * 10.0
                if hh <= 0 or not nm.startswith("ยกขอบ"):
                    continue
                rectp = _box(0, 0, peri, hh)
                rsub = [{"start": (0, 0), "segs": [("L", (peri, 0)), ("L", (peri, hh)), ("L", (0, hh)), ("L", (0, 0))], "closed": True}]
                mats.setdefault("ยกขอบ (แถบพับ)", []).append(
                    {"label": "%s·%s" % (label, nm), "color": color, "rgb": rgb,
                     "pieces": [{"poly": rectp, "groups": [(rsub, color, rgb, "Return")]}], "qty": qty})
        if not mats:
            return JSONResponse({"error": "ไม่พบชิ้นงานจากไฟล์ที่ส่งมา"}, status_code=400)

        out_mats = []
        keys = sorted(mats.keys(), key=lambda m: MAT_ORDER.index(m) if m in MAT_ORDER else 99)
        for mat in keys:
            items = mats[mat]
            files_M = [{"label": it["label"], "name": it["label"], "color": it["color"], "rgb": it["rgb"],
                        "nest_pieces": it["pieces"], "qty": it["qty"]} for it in items]
            r = nesting.nest_multi(files_M, sheet_w, sheet_h, margin=margin, gap=gap, divider_gap=divider_gap)
            svgs = [nesting.sheet_svg_zones(s, sheet_w, sheet_h) for s in r["sheets"]]
            cpath = os.path.join(tmp, "mat_%s.dxf" % _mat_of(mat).replace("/", "_").replace(" ", "_"))
            nesting.write_dxf_zones(r["global_pieces"], r["placements"],
                                    [s["dividers"] for s in r["sheets"]], [s["zones"] for s in r["sheets"]],
                                    cpath, sheet_w, sheet_h)
            with open(cpath, "rb") as fo:
                dxf_b64 = base64.b64encode(fo.read()).decode()
            out_mats.append({"material": mat, "n_sheets": r["n_sheets"], "utilization": r["utilization"],
                             "unplaced": r["unplaced"], "pieces": sum(len(it["pieces"]) * it["qty"] for it in items),
                             "sheets_svg": svgs, "dxf_base64": dxf_b64})
        return {"sheet_w": sheet_w, "sheet_h": sheet_h, "n_files": nfiles,
                "materials": out_mats}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _build_pieces_multi(inp, real_width_mm, real_height_mm, parts_mode, n_colors, sheet_w, sheet_h):
    """สร้าง nest_pieces (list ของ {poly, groups}) จากไฟล์เดียว — ตรรกะเดียวกับ /api/nest
       รองรับ .ai/.pdf/.svg (เวกเตอร์) + .png/.jpg/.psd (raster->trace) · โหมด whole/parts"""
    import cv2
    import numpy as _np
    from shapely.ops import unary_union
    from shapely.geometry import Polygon
    from shapely.affinity import scale as _scale
    from vectorcnc import trace_engine, vector_import

    is_vec = vector_import.is_vector_file(inp)
    bez_pieces = None
    if is_vec:
        bez_pieces = vector_import.full_pieces_mm(inp, real_width_mm)
        bez_pieces = [pc for pc in bez_pieces if pc["poly"].area > 4.0]
        if not bez_pieces:
            raise ValueError("อ่านเวกเตอร์ไม่ได้ / ไม่พบรูปทรง")
        full_mm = unary_union([pc["poly"] for pc in bez_pieces])
    else:
        try:
            bez_pieces = trace_engine.bezier_pieces_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
            bez_pieces = [pc for pc in (bez_pieces or []) if pc["poly"].area > 4.0]
        except Exception:
            bez_pieces = None
        if bez_pieces:
            full_mm = unary_union([pc["poly"] for pc in bez_pieces])
        else:
            polys = trace_engine.nest_shapes_mm(inp, float(real_width_mm), max(2, min(12, int(n_colors))))
            if not polys:
                raise ValueError("แปลงภาพไม่พบรูปทรง")
            bez_pieces = []
            for pg in polys:
                if pg.area <= 4.0:
                    continue
                ring = list(pg.exterior.coords)
                sub = {"start": (ring[0][0], ring[0][1]),
                       "segs": [("L", (x, y)) for x, y in ring[1:]], "closed": True}
                bez_pieces.append({"poly": pg, "subs": [sub], "color": "#2563EB", "rgb": (37, 99, 235), "layer": "CUT"})
            full_mm = unary_union([pc["poly"] for pc in bez_pieces])

    bb = full_mm.bounds
    pw, ph = round(bb[2] - bb[0], 1), round(bb[3] - bb[1], 1)
    try:
        _rh = float(real_height_mm)
    except Exception:
        _rh = 0.0
    if _rh > 1.0 and ph > 0.5 and abs(_rh - ph) > 0.15:
        sy = _rh / (bb[3] - bb[1]); y0 = bb[1]

        def _sy(p):
            return (p[0], y0 + (p[1] - y0) * sy)

        def _scale_sub(sp):
            ns = {"start": _sy(sp["start"]), "segs": []}
            for s in sp["segs"]:
                ns["segs"].append(("L", _sy(s[1])) if s[0] == "L" else ("C", _sy(s[1]), _sy(s[2]), _sy(s[3])))
            for _k in sp:
                if _k not in ("start", "segs"):
                    ns[_k] = sp[_k]
            return ns

        for pc in bez_pieces:
            pc["poly"] = _scale(pc["poly"], xfact=1.0, yfact=sy, origin=(0, y0))
            pc["subs"] = [_scale_sub(sp) for sp in pc.get("subs", [])]
        full_mm = _scale(full_mm, xfact=1.0, yfact=sy, origin=(0, y0))
        bb = full_mm.bounds
        pw, ph = round(bb[2] - bb[0], 1), round(bb[3] - bb[1], 1)

    whole = str(parts_mode).lower() == "whole"
    if whole:
        def _sub_area(sp):
            xs = [sp["start"][0]]; ys = [sp["start"][1]]
            for s in sp["segs"]:
                p = s[1] if s[0] == "L" else s[3]
                xs.append(p[0]); ys.append(p[1])
            n = len(xs); a = 0.0
            for i in range(n):
                j = (i + 1) % n; a += xs[i] * ys[j] - xs[j] * ys[i]
            return abs(a) / 2.0
        outer = None; outer_meta = None; best = -1.0
        for pc in bez_pieces:
            for sp in pc.get("subs", []):
                a = _sub_area(sp)
                if a > best:
                    best = a; outer = sp
                    outer_meta = (pc.get("color", "#2563EB"), pc.get("rgb", (37, 99, 235)), pc.get("layer", "CUT"))
        if outer is None:
            raise ValueError("ไม่พบกรอบนอก")
        hull = full_mm.convex_hull
        if hull.geom_type != "Polygon":
            hull = full_mm.envelope
        return [{"poly": hull, "groups": [([outer], outer_meta[0], outer_meta[1], outer_meta[2])]}], pw, ph

    # parts: raster even-odd split
    def _subpts(sp):
        pts = [sp["start"]]; cur = sp["start"]
        for s in sp["segs"]:
            if s[0] == "L":
                pts.append(s[1]); cur = s[1]
            else:
                c1, c2, e = s[1], s[2], s[3]
                L = abs(c1[0]-cur[0])+abs(c1[1]-cur[1])+abs(c2[0]-c1[0])+abs(c2[1]-c1[1])+abs(e[0]-c2[0])+abs(e[1]-c2[1])
                nn = int(min(40, max(3, L / 0.6)))
                for i in range(1, nn + 1):
                    t = i / float(nn); mt = 1 - t
                    pts.append((mt*mt*mt*cur[0]+3*mt*mt*t*c1[0]+3*mt*t*t*c2[0]+t*t*t*e[0],
                                mt*mt*mt*cur[1]+3*mt*mt*t*c1[1]+3*mt*t*t*c2[1]+t*t*t*e[1]))
                cur = e
        return pts
    allsub = []
    for pc in bez_pieces:
        col = pc.get("color", "#2563EB"); rgb = pc.get("rgb", (37, 99, 235)); lay = pc.get("layer", "CUT")
        for sp in pc.get("subs", []):
            allsub.append((sp, col, rgb, lay, _subpts(sp)))
    allx = [q[0] for _, _, _, _, ps in allsub for q in ps]
    ally = [q[1] for _, _, _, _, ps in allsub for q in ps]
    nest_pieces = []
    try:
        mnx, mny, mxx, mxy = min(allx), min(ally), max(allx), max(ally)
        RES = max(0.4, min(mxx - mnx, mxy - mny) / 1000.0)
        Wn = int((mxx - mnx) / RES) + 6; Hn = int((mxy - mny) / RES) + 6

        def _tp(p):
            return [int((p[0] - mnx) / RES + 3), int((p[1] - mny) / RES + 3)]
        ppx = [_np.array([_tp(q) for q in ps], _np.int32) for _, _, _, _, ps in allsub]
        mask = _np.zeros((Hn, Wn), _np.uint8)
        for pp in ppx:
            cm = _np.zeros((Hn, Wn), _np.uint8); cv2.fillPoly(cm, [pp], 1); mask ^= cm
        nlab, lab = cv2.connectedComponents(mask)
        if nlab > 2:
            ker = _np.ones((5, 5), _np.uint8); gbl = {}
            for (sp, col, rgb, lay, ps), pp in zip(allsub, ppx):
                lm = _np.zeros((Hn, Wn), _np.uint8); cv2.polylines(lm, [pp], True, 1, 2); lm = cv2.dilate(lm, ker)
                vals = lab[lm > 0]; vals = vals[vals > 0]
                L = int(_np.bincount(vals).argmax()) if len(vals) else 0
                if L == 0:
                    continue
                g = gbl.setdefault(L, {}).setdefault(lay, {"subs": [], "color": col, "rgb": rgb})
                g["subs"].append(sp)
            for L in range(1, nlab):
                if L not in gbl:
                    continue
                _fc = cv2.findContours((lab == L).astype(_np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                cnts = _fc[0] if len(_fc) == 2 else _fc[1]
                if not cnts:
                    continue
                cc = max(cnts, key=cv2.contourArea)
                if cv2.contourArea(cc) < 2:
                    continue
                fp = Polygon([(mnx + (pt[0][0] - 3) * RES, mny + (pt[0][1] - 3) * RES) for pt in cc]).buffer(0)
                if fp.is_empty or fp.geom_type != "Polygon":
                    continue
                groups = [(g["subs"], g["color"], g["rgb"], ly) for ly, g in gbl[L].items()]
                nest_pieces.append({"poly": fp, "groups": groups})
    except Exception:
        nest_pieces = []
    if not nest_pieces:
        grp = {}
        for pc in bez_pieces:
            gg = grp.setdefault(pc.get("layer", "CUT"), {"subs": [], "color": pc.get("color", "#2563EB"), "rgb": pc.get("rgb", (37, 99, 235))})
            gg["subs"].extend(pc["subs"])
        hull = full_mm.convex_hull
        if hull.geom_type != "Polygon":
            hull = full_mm.envelope
        nest_pieces = [{"poly": hull, "groups": [(g["subs"], g["color"], g["rgb"], ly) for ly, g in grp.items()]}]
    return nest_pieces, pw, ph


@app.post("/api/nest-multi")
async def nest_multi_ep(request: Request):
    """หลายไฟล์รวมแผ่นเดียว — แยกโซนต่อไฟล์ + เส้นกั้น + ป้ายรหัส · คืน SVG/DXF รวม/DXF รายไฟล์/PDF"""
    tmp = tempfile.mkdtemp()
    try:
        form = await request.form()
        meta = json.loads(form.get("meta") or "{}")
        fmeta = meta.get("files", [])
        sheet_w = float(meta.get("sheet_w", 1220)); sheet_h = float(meta.get("sheet_h", 2440))
        margin = float(meta.get("margin", 10)); gap = float(meta.get("gap", 5))
        divider_gap = float(meta.get("divider_gap", 14))
        from vectorcnc import nesting
        PALETTE = [("#2563EB", (37, 99, 235)), ("#16a34a", (22, 163, 74)), ("#dc2626", (220, 38, 38)),
                   ("#9333ea", (147, 51, 234)), ("#ea580c", (234, 88, 12)), ("#0891b2", (8, 145, 178)),
                   ("#ca8a04", (202, 138, 4)), ("#db2777", (219, 39, 119)), ("#4f46e5", (79, 70, 229)),
                   ("#0d9488", (13, 148, 136))]
        files = []
        for i, fm in enumerate(fmeta):
            up = form.get("file%d" % i)
            if up is None:
                continue
            fn = fm.get("name") or getattr(up, "filename", "f%d" % i)
            p = os.path.join(tmp, "in%d_%s" % (i, os.path.basename(str(fn))))
            with open(p, "wb") as fo:
                fo.write(await up.read())
            color, rgb = PALETTE[len(files) % len(PALETTE)]
            label = fm.get("label") or chr(65 + len(files))
            try:
                nps, pw, ph = _build_pieces_multi(
                    p, float(fm.get("real_width_mm", 300)), float(fm.get("real_height_mm", 0)),
                    fm.get("mode", "parts"), int(fm.get("n_colors", 6)), sheet_w, sheet_h)
            except Exception as e:
                return JSONResponse({"error": "ไฟล์ %s: %s" % (fn, e)}, status_code=400)
            files.append({"label": label, "name": str(fn), "color": color, "rgb": rgb,
                          "nest_pieces": nps, "qty": max(1, int(fm.get("qty", 1)))})
        if not files:
            return JSONResponse({"error": "ไม่พบไฟล์ที่จัดวางได้"}, status_code=400)
        r = nesting.nest_multi(files, sheet_w, sheet_h, margin=margin, gap=gap, divider_gap=divider_gap)
        svgs = [nesting.sheet_svg_zones(s, sheet_w, sheet_h) for s in r["sheets"]]
        cpath = os.path.join(tmp, "nest_multi.dxf")
        nesting.write_dxf_zones(r["global_pieces"], r["placements"],
                                [s["dividers"] for s in r["sheets"]], [s["zones"] for s in r["sheets"]],
                                cpath, sheet_w, sheet_h)
        with open(cpath, "rb") as fo:
            combined_b64 = base64.b64encode(fo.read()).decode()
        per_file_dxf = []
        for fl in r["file_layouts"]:
            if not fl["pieces"]:
                continue
            fp = os.path.join(tmp, "file_%s.dxf" % fl["label"])
            nesting.write_dxf_bezier_blocks(fl["pieces"], fl["placements"], fp, sheet_w, sheet_h)
            with open(fp, "rb") as fo:
                per_file_dxf.append({"label": fl["label"], "name": fl["name"],
                                     "dxf_base64": base64.b64encode(fo.read()).decode()})
        pdf_b64 = ""
        try:
            import cairosvg
            import fitz
            pdf = fitz.open()
            for sv in svgs:
                src = fitz.open("pdf", cairosvg.svg2pdf(bytestring=sv.encode()))
                pdf.insert_pdf(src)
            ppath = os.path.join(tmp, "preview.pdf"); pdf.save(ppath); pdf.close()
            with open(ppath, "rb") as fo:
                pdf_b64 = base64.b64encode(fo.read()).decode()
        except Exception:
            pdf_b64 = ""
        return {"n_sheets": r["n_sheets"], "utilization": r["utilization"], "unplaced": r["unplaced"],
                "sheet_w": sheet_w, "sheet_h": sheet_h, "per_file": r["per_file"],
                "sheets_svg": svgs, "dxf_combined_base64": combined_b64,
                "per_file_dxf": per_file_dxf, "pdf_base64": pdf_b64}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


@app.post("/api/nest-batch")
async def nest_batch(request: Request):
    """รวมไฟล์หลายงาน (จาก CRM) -> nest รวม -> คืนจำนวนแผ่น + per-job area + DXF
    Auth: header X-API-Key == env VECTORCNC_API_KEY"""
    key = os.environ.get("VECTORCNC_API_KEY", "")
    if key and (request.headers.get("x-api-key") or "") != key:
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    try:
        form = await request.form()
        meta = json.loads(form.get("meta") or "{}")
        items = meta.get("items", [])
        sheet_w = float(meta.get("sheet_w", 1220)); sheet_h = float(meta.get("sheet_h", 2440))
        margin = float(meta.get("margin", 10)); gap = float(meta.get("gap", 5))
        tmp = tempfile.mkdtemp()
        from vectorcnc import batch, nesting

        parts, part_job = [], []
        MAX_INST = 55
        for i, it in enumerate(items):
            up = form.get("file%d" % i)
            if up is None:
                continue
            fn = it.get("filename") or getattr(up, "filename", "f%d" % i)
            p = os.path.join(tmp, "in%d_%s" % (i, os.path.basename(str(fn))))
            with open(p, "wb") as f:
                f.write(await up.read())
            try:
                pieces = batch.build_parts(p, fn, float(it.get("real_width_mm", 600)))
            except Exception as e:
                return JSONResponse({"ok": False, "error": "ไฟล์ %s: %s" % (fn, e)}, status_code=400)
            qty = max(1, int(it.get("qty", 1)))
            job = it.get("job_card_no") or it.get("job_id") or ("job%d" % i)
            for pc in pieces:
                for _ in range(qty):
                    if len(parts) >= MAX_INST:
                        break
                    parts.append((pc, 1)); part_job.append(job)

        if not parts:
            return JSONResponse({"ok": False, "error": "ไม่พบชิ้นงานจากไฟล์ที่ส่งมา"}, status_code=400)

        res = max(2.5, min(sheet_w, sheet_h) / 340.0)
        r = nesting.nest(parts, sheet_w, sheet_h, margin=margin, gap=gap, res=res, rotations=(0, 90))

        job_area, placed_by_job, total_area = {}, {}, 0.0
        for sheet in r["placements"]:
            for pl in sheet:
                a = parts[pl["part"]][0].area
                j = part_job[pl["part"]]
                job_area[j] = job_area.get(j, 0.0) + a
                placed_by_job[j] = placed_by_job.get(j, 0) + 1
                total_area += a
        per_job, seen = [], {}
        for j in part_job:
            if j in seen:
                continue
            seen[j] = 1
            per_job.append({"job_card_no": j, "placed": placed_by_job.get(j, 0),
                            "area_ratio": round(job_area.get(j, 0.0) / total_area, 4) if total_area else 0})

        sheets_geoms = [[nesting.place_geom(parts[pl["part"]][0], pl) for pl in s] for s in r["placements"]]
        svgs = [nesting.sheet_svg(gs, sheet_w, sheet_h) for gs in sheets_geoms]
        dxf_path = os.path.join(tmp, "batch.dxf")
        nesting.write_dxf(sheets_geoms, dxf_path, sheet_w, sheet_h)
        with open(dxf_path, "rb") as f:
            dxf_b64 = base64.b64encode(f.read()).decode()

        return {"ok": True, "n_sheets": r["n_sheets"], "utilization": r["utilization"],
                "unplaced": r["unplaced"], "sheet_w": sheet_w, "sheet_h": sheet_h,
                "n_parts": len(parts), "per_job": per_job,
                "sheets_svg": svgs, "dxf_base64": dxf_b64}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@app.post("/api/step-repeat")
async def step_repeat(file: UploadFile = File(...),
                      piece_w_mm: float = Form(40.0),
                      sheet_w_mm: float = Form(600.0),
                      sheet_h_mm: float = Form(1200.0),
                      gap_mm: float = Form(3.0),
                      margin_mm: float = Form(8.0),
                      reg_mode: str = Form("ccd"),
                      qty: int = Form(0),
                      white_base: int = Form(0),
                      cut_mode: str = Form("diecut")):
    """งานพิมพ์ผลิตซ้ำ (step-and-repeat) — วางชิ้นเดียวซ้ำเต็มแผ่น
       -> ไฟล์พิมพ์ .ai (ทั้งแผ่น พร้อมพิมพ์ UV) + ไฟล์ตัดเลเซอร์ DXF/SVG (ตรงตำแหน่ง + หมุด)
       reg_mode: ccd = ใส่หมุดกล้องอ่าน · origin = จัดชนมุม (0,0) ตัดตามพิกัด"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import print_ai as PA, imposition as IMP
        pw_mm = float(piece_w_mm)
        # ชิ้นเดียว: เส้นตัด (cut_mm) + ไฟล์พิมพ์ชิ้น (ไม่มีเส้นตัด — เส้นตัดไปอยู่ไฟล์เลเซอร์)
        _pc, info = PA.build(inp, width_mm=pw_mm, cut=True,
                             white_base=bool(int(white_base)), cut_mode=str(cut_mode))
        cut = info.get("cut_mm") or []
        if not cut:
            return JSONResponse({"error": "หาเส้นตัดของชิ้นไม่ได้ (ภาพควรมีพื้นโปร่ง/ขอบชัด)"},
                                status_code=400)
        pdf_art, _ = PA.build(inp, width_mm=pw_mm, cut=False,
                              white_base=bool(int(white_base)))
        # normalize เส้นตัด -> origin 0,0 + ขนาด footprint จริงของชิ้น
        xs = [x for p in cut for x, y in p]; ys = [y for p in cut for x, y in p]
        mnx, mny = min(xs), min(ys)
        cut = [[(x - mnx, y - mny) for x, y in p] for p in cut]
        pw = max(x for p in cut for x, y in p); ph = max(y for p in cut for x, y in p)
        SW, SH = float(sheet_w_mm), float(sheet_h_mm)
        gap, mg = float(gap_mm), float(margin_mm)
        plan = IMP.plan_grid(pw, ph, SW, SH, gap, mg); plan["cut"] = cut
        if plan["per"] <= 0:
            return JSONResponse({"error": "ชิ้นใหญ่กว่าแผ่น วางไม่ได้ — ลดขนาดชิ้น หรือเพิ่มขนาดแผ่น"},
                                status_code=400)
        pos = IMP.positions(plan, SW, SH, gap)
        marks = IMP.reg_marks(SW, SH)
        rm = str(reg_mode or "ccd").lower()
        print_pdf = IMP.build_print_pdf(pdf_art, plan, pos, SW, SH, rm, marks)
        cut_dxf = IMP.build_cut_dxf(plan, pos, SW, SH, rm, marks)
        cut_svg = IMP.build_cut_svg(plan, pos, SW, SH, rm, marks)
        prev = IMP.preview_svg(plan, pos, SW, SH, rm, marks, _art_data_uri(inp))
        summ = IMP.summarize(plan["per"], int(qty))
        return {"per_sheet": plan["per"], "cols": plan["cols"], "rows": plan["rows"],
                "rot": plan["rot"], "piece_w": round(pw, 1), "piece_h": round(ph, 1),
                "sheet_w": SW, "sheet_h": SH, "reg_mode": rm, "summary": summ,
                "ai_base64": base64.b64encode(print_pdf).decode(),   # ไฟล์พิมพ์ .ai ทั้งแผ่น
                "cut_dxf_base64": cut_dxf, "cut_svg": cut_svg, "preview_svg": prev,
                "note": "ไฟล์ .ai = พิมพ์ UV ทั้งแผ่น · DXF/SVG = เข้าเลเซอร์ตัด (ตรงตำแหน่ง"
                        + (" + หมุดกล้อง)" if rm == "ccd" else " · จัดชนมุม 0,0)")}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]},
                            status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/mount-frame")
async def mount_frame_ep(file: UploadFile = File(...),
                         real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                         bars: int = Form(1), bar_y_cm: float = Form(0.0), gap_cm: float = Form(20.0),
                         frame_x_cm: float = Form(0.0), standoff_cm: float = Form(5.0),
                         wire_offset_cm: float = Form(0.0), n_colors: int = Form(6)):
    """โครงเหล็กแขวนตัวอักษรยกขอบ/ไฟออกหน้า — เจาะรูน็อต Ø3 (2 รู/ตัว/โครง ระดับโครง) + รูสายไฟ Ø5
       (1 รู/ตัว กลางตัว 1cm เหนือโครง) ลงไฟล์ตัด laser + ภาพมองจากด้านหลัง · โครงปรับ ระดับ/ห่าง/ซ้ายขวา/ระยะหลัง"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import mount_frame as MF
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        r = MF.build(full, bars=int(bars),
                     bar_y_cm=(None if float(bar_y_cm) <= 0 else float(bar_y_cm)),
                     gap_cm=float(gap_cm), frame_x_cm=float(frame_x_cm),
                     standoff_cm=float(standoff_cm), wire_offset_cm=float(wire_offset_cm))
        if r.get("error"):
            return JSONResponse({"error": r["error"]}, status_code=400)
        return {"cut_dxf_base64": r["cut_dxf"], "cut_svg": r["cut_svg"], "back_svg": r["back_svg"],
                "letters": r["letters"], "bolts": r["bolts"], "wires": r["wires"], "bars": r["bars"],
                "w_mm": r["w_mm"], "h_mm": r["h_mm"],
                "note": "ไฟล์ตัดมีรูน็อต Ø3 (ระดับโครง) + รูสายไฟ Ø5 (1cm เหนือโครง) ต่อทุกตัวอักษร"}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/led-layout")
async def led_layout_ep(file: UploadFile = File(...),
                        real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                        pitch_cm: float = Form(6.0), watt_per_m: float = Form(12.0),
                        volt: float = Form(12.0), spare: float = Form(1.3), n_colors: int = Form(6)):
    """วางเส้นไฟ LED Ribbon ในตัวงาน (ไฟออกหน้า/หลัง/กล่องไฟ) + คำนวณความยาว/กระแส/หม้อแปลง"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import mount_frame as MF
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        r = MF.led_layout(full, pitch_cm=float(pitch_cm), watt_per_m=float(watt_per_m),
                          volt=float(volt), spare=float(spare))
        return {"segments": r["segments"], "total_m": r["total_m"], "watts": r["watts"],
                "amps": r["amps"], "transformer_w": r["transformer_w"], "pitch_cm": r["pitch_cm"],
                "preview_svg": r["preview_svg"],
                "note": "เผื่อหม้อแปลง %d%% · เลือกหม้อแปลงมาตรฐานที่ใหญ่พอ" % int((float(spare) - 1) * 100)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# 🚧 SELL_MODE — สวิตช์เปิดหน้าขาย (ยังไม่เปิดขาย -> ปิดไว้ก่อน)
#    0 (ค่าเริ่มต้น) = / คือตัวแอปเหมือนเดิม · /welcome ปิด 404
#    1              = / คือหน้าขาย · ตัวแอปอยู่ที่ /app
#    เปิดตอนพร้อมขายจริง: ตั้ง env  SELL_MODE=1  ใน Render
def _sell_mode():
    return str(os.environ.get("SELL_MODE", "0")).lower() in ("1", "true", "yes", "on")


# 🔒 APP_LOCK — บล็อกคนนอกเข้าตัวแอปตรง ๆ (พิมพ์ URL เอง)
#    0 (ค่าเริ่มต้น) = เปิดเหมือนเดิม (deploy ได้ไม่กระทบใคร)
#    1              = ต้องมีตั๋ว SSO (?t=) / คีย์ (?k=,?ak=) / คุกกี้เข้าถึง เท่านั้น
#                     ไม่มี = เจอหน้า "เฉพาะทีมงาน" (403) · ทีมเข้าผ่าน CRM Hub ได้ปกติ
def _app_locked():
    return str(os.environ.get("APP_LOCK", "0")).lower() in ("1", "true", "yes", "on")


def _gate_ok(request: Request) -> bool:
    """ผ่านประตูไหม = ถือตั๋ว SSO ถูกต้อง / คีย์ภายใน-แอดมิน / คุกกี้เข้าถึงที่เคยเข้าถูก"""
    from vectorcnc import auth as A
    if _role_of(request) in ("internal", "admin"):        # ① ตั๋ว SSO (?t= / header)
        return True
    q = request.query_params                              # ② คีย์ภายใน / แอดมิน
    ik = _internal_key(); ak = _admin_key()
    if ik and str(request.headers.get("X-Internal-Key") or q.get("k", "")) == str(ik):
        return True
    if ak and str(q.get("ak", "")) == str(ak):
        return True
    ck = request.cookies.get("vc_acc", "")               # ③ คุกกี้เข้าถึง (ตั้งหลังเข้าถูก/หลัง login)
    if ck and A.role_of(ck) in ("internal", "admin", "user"):
        return True
    return False


def _gate_page():
    """ยังไม่ได้เข้าสู่ระบบ -> ส่งไปหน้า /login (สมาชิกภายในต้อง login ทุกครั้งก่อนเข้าใช้)"""
    return RedirectResponse("/login", status_code=302)


def _serve_app(request: Request, path=None):
    """ส่งตัวแอป + ตั้ง/ต่ออายุคุกกี้เข้าถึง เพื่อคลิกเมนู/รีเฟรชแล้วไม่หลุด"""
    from vectorcnc import auth as A
    resp = FileResponse(path or FRONTEND)
    try:
        tok = _token_of(request)
        if tok and A.role_of(tok) in ("internal", "admin", "user"):
            resp.set_cookie("vc_acc", tok,
                            httponly=True, samesite="lax", secure=True)
        elif _gate_ok(request):                          # เข้าด้วยคีย์ -> ออกคุกกี้เซ็นให้
            try:
                resp.set_cookie("vc_acc", A.sign_internal("team", "internal", 12),
                                httponly=True, samesite="lax", secure=True)
            except Exception:
                pass
    except Exception:
        pass
    return resp


@app.get("/")
def home(request: Request):
    """หน้าแรก

    SELL_MODE=0 (ตอนนี้) -> ตัวแอปเลย เหมือนเดิมทุกอย่าง ทีมงานเข้า ?u= ได้ปกติ
    SELL_MODE=1          -> หน้าขาย (ตัวแอปย้ายไป /app)
    """
    if _sell_mode():
        if request.query_params.get("t"):          # ถือตั๋ว SSO -> เข้าแอปตรง
            q = str(request.url.query)
            return RedirectResponse("/app" + ("?" + q if q else ""), status_code=302)
        landing = os.path.join(os.path.dirname(FRONTEND), "landing.html")
        if os.path.exists(landing):
            return FileResponse(landing)

    if _app_locked() and not _gate_ok(request):    # 🔒 บล็อกคนนอกเข้าตรง ๆ
        return _gate_page()
    if os.path.exists(FRONTEND):
        return _serve_app(request)
    return {"msg": "VectorCNC API running. POST /api/vectorize"}


@app.get("/login")
def login_page():
    """หน้า Login (username/password ตรวจกับ Table: user ใน CRM Hub)"""
    p = os.path.join(os.path.dirname(FRONTEND), "login.html")
    if os.path.exists(p):
        return FileResponse(p)
    return JSONResponse({"error": "login.html not found"}, status_code=404)


def _crm_hub_url():
    """URL Apps Script (CRM Hub) ฝั่ง server — ตั้งใน Render env: CRM_HUB_URL=.../exec"""
    return (os.environ.get("CRM_HUB_URL", "") or "").strip()


@app.post("/api/login")
async def api_login(request: Request, username: str = Form(""), password: str = Form(""),
                    mobile: str = Form(""), email: str = Form("")):
    """ตรวจ Username/Password กับ Table: user (CRM Hub) -> ออกโทเคน + คุกกี้เข้าถึง"""
    from vectorcnc import auth as A
    u = (username or "").strip(); pw = (password or "")
    if not u or not pw:
        return JSONResponse({"ok": False, "error": "missing"}, status_code=400)
    hub = _crm_hub_url()
    if not hub:
        return JSONResponse({"ok": False, "error": "no_crm_url",
                             "msg": "ยังไม่ได้ตั้ง CRM_HUB_URL ที่เซิร์ฟเวอร์"}, status_code=503)
    try:
        import urllib.request as _u, urllib.parse as _up, json as _json
        qs = _up.urlencode({"api": "auth", "user": u, "pass": pw, "mobile": mobile, "email": email})
        with _u.urlopen(hub + ("&" if "?" in hub else "?") + qs, timeout=15) as r:
            j = _json.loads(r.read().decode("utf-8", "ignore") or "{}")
    except Exception as e:
        return JSONResponse({"ok": False, "error": "crm_unreachable", "detail": str(e)[:120]}, status_code=502)
    if not j.get("ok"):
        err = j.get("error", "bad_credentials")
        msg = {"not_paid": "บัญชีนี้ยังไม่ชำระเงิน", "bad_credentials": "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"}.get(err, err)
        return JSONResponse({"ok": False, "error": err, "msg": msg}, status_code=401)
    perm = str(j.get("permission", "")).strip().lower()
    if perm.startswith("admin"):                       # admin / administrator
        role = "admin"
    elif perm in ("", "user", "customer", "ลูกค้า"):     # ลูกค้าภายนอก
        role = "user"
    else:                                              # staff / team / พนักงาน ฯลฯ = ทีมงานภายใน
        role = "internal"
    tok = A.sign(str(j.get("email") or u), str(j.get("plan") or "pro"), days=30, role=role)
    # 👤 ชื่อเล่น/ชื่อจริงจาก CRM Hub — ส่งกลับให้หน้าเว็บเก็บไว้ใช้ในสถิติ
    #    CRM Hub อาจตั้งชื่อคีย์ไม่เหมือนกัน จึงลองหลายชื่อ · ไม่มีก็ปล่อยว่าง (ไม่พังแน่นอน)
    _nick = str(j.get("nickname") or j.get("nick") or j.get("ชื่อเล่น") or "").strip()
    _full = str(j.get("fullname") or j.get("name") or j.get("full_name")
                or j.get("ชื่อ") or j.get("ชื่อจริง") or "").strip()
    _redir = "/app?u=" + _upq(u)
    if _nick:
        _redir += "&nn=" + _upq(_nick)          # ส่งชื่อไปกับลิงก์ด้วย เผื่อเปิดคนละแท็บ
    if _full:
        _redir += "&fn=" + _upq(_full)
    resp = JSONResponse({"ok": True, "username": u, "nickname": _nick or u,
                         "fullname": _full, "role": role, "redirect": _redir})
    try:
        resp.set_cookie("vc_acc", tok, httponly=True, samesite="lax", secure=True)
    except Exception:
        pass
    return resp


def _upq(s):
    import urllib.parse as _up
    return _up.quote(str(s or ""))


@app.get("/app")
def app_page(request: Request):
    """ตัวแอป (ใช้ได้ทั้งสองโหมด — ลิงก์ /app จะได้ไม่พังตอนสลับ SELL_MODE)"""
    if _app_locked() and not _gate_ok(request):    # 🔒 บล็อกคนนอกเข้าตรง ๆ
        return _gate_page()
    if os.path.exists(FRONTEND):
        return _serve_app(request)
    return JSONResponse({"error": "index.html not found"}, status_code=404)


# ============ BOM Check Sheet (upload + params -> Check Sheet + BOM + record) ============
CHECKSHEET_PAGE = os.path.join(os.path.dirname(FRONTEND), "checksheet.html")

@app.get("/checksheet")
def checksheet_page(request: Request):
    if _app_locked() and not _gate_ok(request):    # 🔒 บล็อกคนนอก
        return _gate_page()
    if os.path.exists(CHECKSHEET_PAGE):
        return _serve_app(request, CHECKSHEET_PAGE)
    return {"msg": "checksheet.html missing"}

@app.post("/api/checksheet")
async def api_checksheet(
    file: UploadFile = File(...),
    sales: str = Form(""), customer: str = Form(""), job_id: str = Form(""),
    sign_type: str = Form("4.3"),
    real_width_cm: float = Form(80.0), real_height_cm: float = Form(45.0),
    metal_cat: str = Form("metal_stainless"),
    yokkob_outer_cm: float = Form(5.0), yokkob_letter_cm: float = Form(7.0),
    led_color: str = Form("วอร์มไวท์ 3000K"), install: str = Form("indoor"),
    wire_gauge: str = Form("2.5"), wire_length_m: float = Form(5.0), qty_sets: int = Form(1),
):
    import tempfile, time, traceback, shutil
    try:
        from vectorcnc import spec_render, job_record
        suf = os.path.splitext(file.filename or "")[1].lower() or ".ai"
        tf = tempfile.NamedTemporaryFile(delete=False, suffix=suf)
        tf.write(await file.read()); tf.close()
        params = {
            "real_width_cm": real_width_cm, "real_height_cm": real_height_cm,
            "sign_type": sign_type, "metal_cat": metal_cat,
            "yokkob_outer_cm": yokkob_outer_cm, "yokkob_letter_cm": yokkob_letter_cm,
            "led_color": led_color, "install": install,
            "wire_gauge": wire_gauge, "wire_length_m": wire_length_m, "qty_sets": qty_sets,
        }
        jid = job_id or ("JOB-" + time.strftime("%Y%m%d-%H%M%S"))
        outdir = tempfile.mkdtemp()
        outp, cost = spec_render.build_checksheet(tf.name, params=params, outdir=outdir,
                                                  job_name=(customer or "job"), job_id=jid)
        html = open(outp, encoding="utf-8").read()
        files = {"check_sheet": "KFM_CheckSheet.html", "drive_folder": ""}
        rec = job_record.build_record(jid, sales, customer, params, cost, files=files)
        # เก็บ manifest + ไฟล์ไว้ใน outputs กลาง (ให้ Apps Script ดึงไปเซฟ Drive)
        job_record.save_manifest(rec, outdir)
        payload = {
            "folder_path": job_record.drive_folder_path(rec),
            "row": job_record.registry_row(rec),
            "columns": job_record.REGISTRY_COLUMNS,
        }
        try: shutil.rmtree(outdir, ignore_errors=True)
        except Exception: pass
        return {"ok": True, "job_id": jid, "html": html,
                "cost": {k: cost[k] for k in ("material", "labor", "damage", "total")},
                "led": {"total_m": cost["led"]["total_m"], "transformer": cost["led"]["transformer"]["name"]},
                "drive_payload": payload}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e), "trace": traceback.format_exc()[-900:]}, status_code=400)


# ================= วัดขนาดตัวอักษรจากพื้นที่หน้าร้าน (สำหรับทีมขาย) =================
MEASURE_PAGE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "measure.html")


@app.get("/measure")
def measure_page(request: Request):
    if _app_locked() and not _gate_ok(request):    # 🔒 บล็อกคนนอก
        return _gate_page()
    if os.path.exists(MEASURE_PAGE):
        return _serve_app(request, MEASURE_PAGE)
    return {"msg": "measure.html not found"}


@app.post("/api/measure")
async def api_measure(
    file: UploadFile = File(...),
    area_w_cm: float = Form(...),
    area_h_cm: float = Form(...),
):
    """ทั้งภาพ = พื้นที่ -> วัด กว้าง×สูง บล็อกอักษร, สูงตัวอักษรที่สูงสุด, ระยะขอบ (ซม.)"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import measure as _measure
        return _measure.measure(inp, float(area_w_cm), float(area_h_cm))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/cutout")
async def api_cutout(file: UploadFile = File(...)):
    """ตัดพื้นหลังออก -> คืน PNG โปร่งใส (base64) สำหรับวางบนผนังให้สวย"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        import cv2
        from vectorcnc import measure as _measure
        bgra = _measure.cutout_rgba(inp)               # BGRA (alpha เนียน + GrabCut)
        ok, buf = cv2.imencode(".png", bgra)
        if not ok:
            return JSONResponse({"error": "encode png ไม่ได้"}, status_code=400)
        import base64 as _b64
        return {"png": "data:image/png;base64," + _b64.b64encode(buf.tobytes()).decode()}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/rasterize")
async def api_rasterize(file: UploadFile = File(...), max_px: int = Form(2000)):
    """แปลงไฟล์เวกเตอร์ (.ai/.pdf/.eps/.ps/.svg) -> PNG โปร่งใส (ตัดขอบว่าง) สำหรับวางบนผนัง+สเกล
    เหมือน JPG แต่คมกว่า (มาจากเวกเตอร์)"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.ai")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        import numpy as np, cv2, base64 as _b64
        ext = os.path.splitext(inp)[1].lower()
        mpx = max(400, min(4000, int(max_px)))
        img = None
        if ext in (".psd", ".psb"):
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None                       # กัน DecompressionBomb (PSD ใหญ่)
            pim = Image.open(inp)                               # composite (รวมทุกเลเยอร์)
            pim.thumbnail((mpx, mpx))                           # ย่อก่อน convert -> ประหยัด RAM
            img = cv2.cvtColor(np.array(pim.convert("RGBA")), cv2.COLOR_RGBA2BGRA)
        elif ext == ".svg":
            import cairosvg
            png_bytes = cairosvg.svg2png(url=inp, output_width=mpx)
            img = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
        else:
            import fitz
            src = inp
            if ext in (".eps", ".ps"):
                try:
                    from vectorcnc import vector_import as _vi
                    src = _vi._to_pdf_via_gs(inp)
                except Exception:
                    src = inp
            doc = fitz.open(src)
            page = doc[0]
            r = page.rect
            sc = mpx / max(1.0, max(r.width, r.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(sc, sc), alpha=True)
            img = cv2.imdecode(np.frombuffer(pix.tobytes("png"), np.uint8), cv2.IMREAD_UNCHANGED)
        if img is None:
            return JSONResponse({"error": "render ไฟล์ไม่ได้"}, status_code=400)
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
        elif img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        H, W = img.shape[:2]
        alpha = img[:, :, 3]
        if int(alpha.min()) < 250:                      # มี transparency จริง -> ใช้ alpha
            mask = alpha > 8
        else:                                           # ทึบ -> ถือว่าพื้นขาว = โปร่ง
            gray = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
            mask = gray < 245
            img[:, :, 3] = np.where(mask, 255, 0).astype(np.uint8)
        ys, xs = np.where(mask)
        if len(xs) and len(ys):
            pad = 2
            x0 = max(0, int(xs.min()) - pad); y0 = max(0, int(ys.min()) - pad)
            x1 = min(W - 1, int(xs.max()) + pad); y1 = min(H - 1, int(ys.max()) + pad)
            img = img[y0:y1 + 1, x0:x1 + 1]
        ok, buf = cv2.imencode(".png", img)
        if not ok:
            return JSONResponse({"error": "encode png ไม่ได้"}, status_code=400)
        return {"png": "data:image/png;base64," + _b64.b64encode(buf.tobytes()).decode(),
                "w": int(img.shape[1]), "h": int(img.shape[0])}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/ai-split")
async def api_ai_split(file: UploadFile = File(...), max_px: int = Form(1600), frac: float = Form(0.02)):
    """แตกไฟล์เวกเตอร์รวม (.ai/.pdf/.svg) เป็น 'ชิ้นย่อย' ตามกลุ่มที่แยกกัน (หลาย artboard + กลุ่มในหน้า)
    -> คืน list PNG โปร่งใสต่อชิ้น ให้ผู้ใช้เลือก/ลบได้"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.ai")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        import numpy as np, cv2, base64 as _b64
        ext = os.path.splitext(inp)[1].lower()
        mpx = max(500, min(3200, int(max_px)))
        fr = max(0.006, min(0.06, float(frac)))
        rasters = []                                    # [(page_index, BGRA image)]
        pieces = []
        if ext in (".psd", ".psb"):
            # PSD: ทำ composite (เบา/ทน) ก่อนเสมอ -> แล้วค่อยลองแตกเลเยอร์ (เฉพาะไฟล์เล็ก กัน OOM/segfault)
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None                # กัน DecompressionBomb error (PSD ใหญ่)
            _fsz = 0
            try:
                _fsz = os.path.getsize(inp)
            except Exception:
                _fsz = 0
            comp = None                                  # composite (BGRA) ย่อแล้ว = ตัวสำรองที่การันตี
            try:
                _pim = Image.open(inp); _pim.thumbnail((mpx, mpx))
                comp = cv2.cvtColor(np.array(_pim.convert("RGBA")), cv2.COLOR_RGBA2BGRA)
            except Exception:
                comp = None
            if _fsz < 25 * 1024 * 1024:                  # แตกเลเยอร์เฉพาะ PSD ไม่ใหญ่ (psd-tools กิน RAM)
                try:
                    from psd_tools import PSDImage
                    psd = PSDImage.open(inp)
                    _canvas = float(max(1, psd.width) * max(1, psd.height))
                    for ly in list(psd)[:40]:
                        try:
                            if hasattr(ly, "is_visible") and not ly.is_visible():
                                continue
                            try:                          # ข้ามเลเยอร์พื้นหลังเต็มแคนวาส (ไม่ใช่ชิ้นที่อยากได้ + กิน RAM หนัก)
                                _bb = ly.bbox
                                if max(0, _bb[2] - _bb[0]) * max(0, _bb[3] - _bb[1]) > 0.88 * _canvas:
                                    continue
                            except Exception:
                                pass
                            lim = ly.topil()             # เร็วกว่า composite() ~36x + ข้าม bg = peak RAM ต่ำ กัน OOM/timeout
                            if lim is None:
                                continue
                            lim.thumbnail((mpx, mpx))    # ย่อใน PIL ก่อนแปลง numpy -> ลด peak RAM ~40% กัน OOM
                            crop = cv2.cvtColor(np.array(lim.convert("RGBA")), cv2.COLOR_RGBA2BGRA)
                            del lim
                            if crop.size == 0 or int(crop[:, :, 3].max()) == 0:
                                continue
                            _ys, _xs = np.where(crop[:, :, 3] > 8)
                            if len(_xs) and len(_ys):
                                crop = crop[int(_ys.min()):int(_ys.max()) + 1, int(_xs.min()):int(_xs.max()) + 1]
                            h0, w0 = crop.shape[:2]
                            if h0 * w0 < 64:
                                continue
                            if max(h0, w0) > mpx:
                                _r = mpx / float(max(h0, w0))
                                crop = cv2.resize(crop, (max(1, int(w0 * _r)), max(1, int(h0 * _r))))
                            ok, buf = cv2.imencode(".png", crop)
                            if ok:
                                pieces.append({"png": "data:image/png;base64," + _b64.b64encode(buf.tobytes()).decode(),
                                               "w": int(crop.shape[1]), "h": int(crop.shape[0]),
                                               "page": 0, "area": int(crop.shape[0] * crop.shape[1])})
                        except Exception:
                            continue
                except Exception:
                    pieces = []
            if len(pieces) >= 2:
                pieces.sort(key=lambda p: -p["area"]); pieces = pieces[:24]
                return {"count": len(pieces), "pieces": pieces}
            pieces = []                                  # ไม่ได้เลเยอร์ -> จับกลุ่มเชิงพื้นที่จาก composite
            if comp is None:
                return JSONResponse({"error": "อ่านไฟล์ PSD ไม่ได้ (ไฟล์อาจใหญ่หรือซับซ้อนเกินไปสำหรับเซิร์ฟเวอร์)"}, status_code=400)
            rasters.append((0, comp))
        elif ext == ".svg":
            import cairosvg
            png = cairosvg.svg2png(url=inp, output_width=mpx)
            im = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_UNCHANGED)
            rasters.append((0, im))
        else:
            import fitz
            src = inp
            if ext in (".eps", ".ps"):
                try:
                    from vectorcnc import vector_import as _vi
                    src = _vi._to_pdf_via_gs(inp)
                except Exception:
                    src = inp
            doc = fitz.open(src)
            for pno in range(min(doc.page_count, 12)):
                pg = doc[pno]; r = pg.rect
                sc = mpx / max(1.0, max(r.width, r.height))
                im = cv2.imdecode(np.frombuffer(pg.get_pixmap(matrix=fitz.Matrix(sc, sc), alpha=True).tobytes("png"), np.uint8), cv2.IMREAD_UNCHANGED)
                rasters.append((pno, im))
        for pno, img in rasters:
            if img is None:
                continue
            if img.ndim == 2:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
            elif img.shape[2] == 3:
                img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
            H, W = img.shape[:2]
            a = img[:, :, 3]
            if int(a.min()) < 250:
                mask = (a > 8).astype(np.uint8)
            else:
                mask = (cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY) < 245).astype(np.uint8)
                img[:, :, 3] = mask * 255
            k = max(3, int(min(H, W) * fr))
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))       # ใหญ่ = ใช้ 'จับกลุ่ม' ตัวอักษรเป็นก้อนเดียว
            kerS = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))      # เล็ก = ใช้ทำ mask ชิ้น (ไม่กวาดของข้างเคียง)
            dil = cv2.dilate(mask, ker)
            n, lab, st, ce = cv2.connectedComponentsWithStats(dil, 8)
            for i in range(1, n):
                if st[i, cv2.CC_STAT_AREA] < 0.003 * H * W:
                    continue
                x, y, w, h = st[i, 0], st[i, 1], st[i, 2], st[i, 3]
                pad = 4
                x0 = max(0, x - pad); y0 = max(0, y - pad)
                x1 = min(W, x + w + pad); y1 = min(H, y + h + pad)
                crop = img[y0:y1, x0:x1].copy()
                # ✂ mask ด้วยกลุ่มจริงของชิ้น (dilate เล็ก 5px กัน halo เท่านั้น) — ของข้างเคียงไม่ติดมาอีก
                lm = cv2.dilate((lab[y0:y1, x0:x1] == i).astype(np.uint8), kerS)
                crop[:, :, 3] = (crop[:, :, 3] * (lm > 0)).astype(np.uint8)
                ok, buf = cv2.imencode(".png", crop)
                if ok:
                    pieces.append({"png": "data:image/png;base64," + _b64.b64encode(buf.tobytes()).decode(),
                                   "w": int(crop.shape[1]), "h": int(crop.shape[0]),
                                   "page": pno, "area": int(w * h)})
        pieces.sort(key=lambda p: -p["area"])
        pieces = pieces[:24]
        return {"count": len(pieces), "pieces": pieces}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/measure_parts")
async def api_measure_parts(
    file: UploadFile = File(...),
    area_w_cm: float = Form(...),
    area_h_cm: float = Form(...),
):
    """แยกวัด logo/ตัวอักษร + รวมทั้งป้าย ตาม scale ผนัง (ทั้งภาพ = ผนัง)"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import measure as _measure
        return _measure.measure_parts(inp, float(area_w_cm), float(area_h_cm))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# ==================================================================
#  PHASE 1A — PDF ASSET EXTRACTOR  (แตกของจากไฟล์ลูกค้า)
# ==================================================================
_ASSET_STORE = {}          # token -> path ของไฟล์ที่อัปไว้ (ใช้ซ้ำตอนกดเลือกชิ้น)


@app.post("/api/extract-assets")
async def extract_assets(file: UploadFile = File(...), split_gap: float = Form(0.0)):
    """อัป PDF/.ai -> แตกทุก object (เวกเตอร์ / ภาพฝังใน / ข้อความ+ฟอนต์) พร้อมพรีวิว
       กราฟิกกดเลือกชิ้นที่ต้องการ -> ได้ .ai คงเวกเตอร์ทันที (ไม่ต้อง trace ใหม่)"""
    import uuid
    tmp = tempfile.mkdtemp()
    name = file.filename or "in.pdf"
    inp = os.path.join(tmp, name)
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import assets as _as
        low = name.lower()
        if not low.endswith((".pdf", ".ai", ".eps", ".ps")):
            return JSONResponse({"error": "รองรับเฉพาะ PDF / .ai / .eps"}, status_code=400)
        # .ai/.eps แบบ PostScript -> แปลงเป็น PDF ก่อน (ghostscript)
        target = inp
        try:
            import fitz
            fitz.open(inp).close()
        except Exception:
            import subprocess
            pdfp = os.path.join(tmp, "conv.pdf")
            subprocess.run(["gs", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite",
                            "-sOutputFile=" + pdfp, inp], check=True, timeout=90)
            target = pdfp
        # 🛡️ กันไฟล์ "แผ่นผลิตซ้ำ" (step&repeat หลายร้อยชิ้น) — ไม่ใช่ไฟล์ลูกค้าที่ควรแตกชิ้น
        #    ถ้าปล่อยเข้า list_assets จะต้อง composite ภาพหลายร้อยครั้ง -> server ล่ม/timeout
        try:
            import fitz
            _d = fitz.open(target); _p0 = _d[0]
            try:
                _n_inst = len(_p0.get_image_info())        # จำนวน "ครั้ง" ที่วางภาพบนหน้า
            except Exception:
                _n_inst = len(_p0.get_images(full=True))
            _big = os.path.getsize(target) > 10 * 1024 * 1024
            _d.close()
            if _n_inst > 40 or (_big and _n_inst > 12):
                import shutil as _sh; _sh.rmtree(tmp, ignore_errors=True)
                return JSONResponse({
                    "error": "ไฟล์นี้เป็น 'แผ่นจัดวางผลิตซ้ำ' (มีชิ้นงานหลายร้อยชิ้นบนแผ่นเดียว) "
                             "— เครื่องมือแตกไฟล์ใช้กับ 'ไฟล์งานลูกค้าชิ้นเดียว' (เมนู/นามบัตร/โบรชัวร์)",
                    "hint": "ถ้าต้องการผลิตซ้ำ ใช้เมนู '🏭 งานพิมพ์ผลิตซ้ำ (Step & Repeat)' โดยใส่ไฟล์ชิ้นเดียว"
                }, status_code=400)
        except Exception:
            pass
        rep = _as.list_assets(target, split_gap=float(split_gap or 0.0))
        tok = uuid.uuid4().hex[:16]
        _ASSET_STORE[tok] = target
        rep["token"] = tok
        rep["filename"] = name
        return rep
    except Exception as e:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)


def _crop_clean_strict(path, page_no, bbox, pad_pt=1.0):
    """✂ ครอปชิ้นเวกเตอร์แบบ 'ต้นฉบับ 100%' — ใช้ redaction ลบเฉพาะของนอกกรอบ (เส้น/ข้อความ/ภาพข้างเคียง)
       ชิ้นในกรอบไม่ถูกแตะเลย: path เดิม · รูโบ๋ (even-odd) เดิม · ฟอนต์เดิม · ความคมเท่าไฟล์ลูกค้า
       คืน (pdf_bytes|None)"""
    import fitz
    doc = fitz.open(path)
    try:
        page = doc[page_no]
        r = fitz.Rect(*bbox)
        r.x0 -= pad_pt; r.y0 -= pad_pt; r.x1 += pad_pt; r.y1 += pad_pt
        r = r & page.rect
        if r.is_empty:
            return None
        pr = page.rect
        for a in [fitz.Rect(pr.x0, pr.y0, pr.x1, r.y0), fitz.Rect(pr.x0, r.y1, pr.x1, pr.y1),
                  fitz.Rect(pr.x0, r.y0, r.x0, r.y1), fitz.Rect(r.x1, r.y0, pr.x1, r.y1)]:
            if a.is_valid and not a.is_empty and a.width > 0.5 and a.height > 0.5:
                page.add_redact_annot(a)
        # 🧮 นับ 'เนื้อของชิ้นนี้' ไว้ก่อน (เส้นที่อยู่ในกรอบทั้งเส้น) เอาไว้ตรวจว่าลบแล้วชิ้นเสียหายไหม
        def _own(pg):
            n = 0
            try:
                for _g in pg.get_drawings():
                    _r = _g["rect"]
                    if r.x0 - 1 <= _r.x0 and _r.x1 <= r.x1 + 1 and r.y0 - 1 <= _r.y0 and _r.y1 <= r.y1 + 1:
                        n += 1
            except Exception:
                pass
            return n
        _n0 = _own(page)
        # ✂️ ============ ลบของชิ้นอื่นที่ 'คร่อมขอบกรอบ' ออกด้วย ============
        #    งานลูกค้าวางหลายชิ้นบนแผ่นเดียว (เคสจริง: 57 ชิ้น)
        #    IF_COVERED ลบเฉพาะเส้นที่อยู่นอกกรอบ 'ทั้งเส้น' เท่านั้น
        #    เส้นของชิ้นข้าง ๆ ที่พาดคร่อมขอบกรอบจึงถูกเก็บไว้ทั้งเส้น ติดมากับชิ้นนี้ด้วย
        #    พอเอาไปวาง+ย่อขยายตามขนาดชิ้น ของที่ติดมาก็ถูกขยายตาม -> เห็นเป็นเส้นซ้อนทับโลโก้
        #    IF_TOUCHED ลบทุกเส้นที่ 'แตะ' พื้นที่นอกกรอบ = ตัดของชิ้นอื่นออกได้จริง
        #    เนื้อของชิ้นนี้อยู่ในกรอบทั้งหมดอยู่แล้ว (กรอบมาจากตัวชิ้นเอง + เผื่อขอบ 1 pt) จึงไม่ถูกแตะ
        _done = False
        for _mode in ("touched", "covered"):
            try:
                _snap = fitz.open("pdf", doc.tobytes())          # สำเนาไว้ถอยกลับถ้าพัง
            except Exception:
                _snap = None
            try:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_REMOVE,
                    graphics=(fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED if _mode == "touched"
                              else fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED))
            except Exception:
                if _mode == "covered":
                    try:
                        page.apply_redactions()
                    except Exception:
                        pass
                continue
            # ✅ ตรวจว่าเนื้อของชิ้นนี้ยังอยู่ครบ — หายเกิน 20% ถือว่าลบแรงไป ถอยไปใช้ IF_COVERED
            if _mode == "covered" or _n0 <= 0 or _own(page) >= _n0 * 0.80:
                _done = True
                break
            if _snap is not None:
                doc.close(); doc = _snap; page = doc[page_no]
        page.set_cropbox(r)
        buf = doc.tobytes(garbage=4, deflate=True, clean=True)
        return buf
    finally:
        doc.close()


@app.post("/api/compose-vector")
async def compose_vector(request: Request):
    """🧩 รวม 'ชิ้นเวกเตอร์ที่เลือก + จัดวาง' เป็น PDF เวกเตอร์แท้ — ไม่ raster เลย เส้นคมเท่าต้นฉบับ 100%
       body: {token, items:[{page, bbox:[x0,y0,x1,y1](pt), x_mm,y_mm,w_mm,h_mm}]}
       -> {ai_base64, width_mm, height_mm}  (เปิดต่อเป็นไฟล์เวกเตอร์ในทุกเครื่องมือ ไม่ต้อง trace)"""
    body = await request.json()
    tok = str(body.get("token", ""))
    items = (body.get("items") or [])[:40]
    if not items:
        return JSONResponse({"error": "ยังไม่ได้เลือกชิ้น"}, status_code=400)
    try:
        import fitz, base64 as _b64
        from vectorcnc import assets as _as
        MMPT = 72.0 / 25.4
        pad = 5.0                                       # เผื่อขอบ 5 มม.
        # 🧮 ทำความสะอาดพิกัด: ทิ้งชิ้นขนาดผิดปกติ + เลื่อนให้เริ่มที่ 0 (กันชิ้นตกนอกหน้ากระดาษจนหายไป)
        good = []
        for it in items:
            try:
                w = float(it.get("w_mm") or 0); h = float(it.get("h_mm") or 0)
                x = float(it.get("x_mm") or 0); y = float(it.get("y_mm") or 0)
                if w > 0.5 and h > 0.5 and w == w and h == h and x == x and y == y:
                    it["x_mm"] = x; it["y_mm"] = y; it["w_mm"] = w; it["h_mm"] = h
                    good.append(it)
            except Exception:
                continue
        if not good:
            return JSONResponse({"error": "พิกัดชิ้นไม่ถูกต้อง"}, status_code=400)
        items = good
        _ox = min(float(it["x_mm"]) for it in items); _oy = min(float(it["y_mm"]) for it in items)
        for it in items:
            it["x_mm"] = float(it["x_mm"]) - _ox; it["y_mm"] = float(it["y_mm"]) - _oy
        maxx = max(float(it["x_mm"]) + float(it["w_mm"]) for it in items) + pad
        maxy = max(float(it["y_mm"]) + float(it["h_mm"]) for it in items) + pad
        out = fitz.open()
        pg = out.new_page(width=maxx * MMPT, height=maxy * MMPT)
        n_ok = 0; fails = []
        for it in items:
            try:
                # 🖼️ ชิ้นภาพ (เช่น ตัวหนังสือไทย PNG) -> ฝังเป็นภาพใน PDF ตรงตำแหน่ง (ไม่ทำให้ชิ้นเวกเตอร์อื่นเสียความคม)
                if it.get("png"):
                    import base64 as _b642
                    _dat = str(it["png"]).split(",", 1)[1]
                    _r2 = fitz.Rect(float(it["x_mm"]) * MMPT, float(it["y_mm"]) * MMPT,
                                    (float(it["x_mm"]) + float(it["w_mm"])) * MMPT,
                                    (float(it["y_mm"]) + float(it["h_mm"])) * MMPT)
                    pg.insert_image(_r2, stream=_b642.b64decode(_dat), keep_proportion=False)
                    n_ok += 1
                    continue
                # 🧩 รองรับชิ้นจาก 'หลายไฟล์' — แต่ละชิ้นพก token ของไฟล์ตัวเอง (ไม่มีก็ใช้ token กลาง)
                _tk = str(it.get("token") or tok)
                path = _ASSET_STORE.get(_tk)
                if not path or not os.path.exists(path):
                    fails.append("ไฟล์ต้นทางหมดอายุ (เซิร์ฟเวอร์รีสตาร์ต) — ลากไฟล์เข้ามาใหม่")
                    continue
                # ✂ ครอปชิ้นแบบ redaction (ลบของนอกกรอบ · ชิ้นในกรอบ = ต้นฉบับ 100% ทั้ง path/รูโบ๋/ฟอนต์)
                pbytes = _crop_clean_strict(path, int(it.get("page", 0)),
                                            [float(v) for v in it["bbox"]], pad_pt=1.0)
                if not pbytes:                          # ไม่มีเส้นเวกเตอร์ (เช่นชิ้นภาพฝังใน) -> ครอปแบบ exact
                    pbytes = _as.crop_vector(path, int(it.get("page", 0)),
                                             [float(v) for v in it["bbox"]], pad_pt=1.0, mode="exact")
                pdoc = fitz.open("pdf", pbytes)
                r = fitz.Rect(float(it["x_mm"]) * MMPT, float(it["y_mm"]) * MMPT,
                              (float(it["x_mm"]) + float(it["w_mm"])) * MMPT,
                              (float(it["y_mm"]) + float(it["h_mm"])) * MMPT)
                pg.show_pdf_page(r, pdoc, 0)             # ✅ ฝังเวกเตอร์สะอาดเฉพาะชิ้น (ไม่ raster)
                pdoc.close()
                n_ok += 1
            except Exception as _e2:
                fails.append(str(_e2)[:90])
                continue
        if not n_ok:
            return JSONResponse({"error": "รวมชิ้นไม่สำเร็จ: " + ("; ".join(fails[:3]) or "?")}, status_code=400)
        data = out.tobytes(garbage=4, deflate=True, clean=True)
        out.close()
        return {"ai_base64": _b64.b64encode(data).decode(),
                "width_mm": round(maxx, 1), "height_mm": round(maxy, 1),
                "count": n_ok, "requested": len(items), "fails": fails[:5]}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)


@app.post("/api/compose-assets")
async def compose_assets(request: Request):
    """รวม 'ชิ้นย่อยที่เลือก + จัดวาง' จากไฟล์ .ai/PDF -> ภาพเดียว (PNG ความละเอียดสูง)
       body: {token, items:[{page,bbox:[x0,y0,x1,y1], x_mm,y_mm,w_mm,h_mm}], dpi?}
       -> {png_base64, width_mm, height_mm}  (เอาไปสร้างแบบตามประเภทป้ายต่อ)"""
    body = await request.json()
    tok = str(body.get("token", ""))
    path = _ASSET_STORE.get(tok)
    if not path or not os.path.exists(path):
        return JSONResponse({"error": "ไฟล์หมดอายุ กรุณาลากไฟล์ใหม่"}, status_code=400)
    items = body.get("items", []) or []
    if not items:
        return JSONResponse({"error": "ยังไม่ได้เลือกชิ้น"}, status_code=400)
    try:
        from vectorcnc import assets as _as
        from PIL import Image
        import io, base64 as _b64
        dpi = float(body.get("dpi", 300) or 300)
        pxmm = dpi / 25.4
        maxx = max(float(it["x_mm"]) + float(it["w_mm"]) for it in items)
        maxy = max(float(it["y_mm"]) + float(it["h_mm"]) for it in items)
        W = max(2, int(round(maxx * pxmm))); H = max(2, int(round(maxy * pxmm)))
        if W * H > 60_000_000:                         # กันภาพใหญ่เกิน (server ล่ม)
            _sc = (60_000_000 / (W * H)) ** 0.5; pxmm *= _sc; W = int(W * _sc); H = int(H * _sc)
        canvas = Image.new("RGBA", (W, H), (255, 255, 255, 0))
        for it in items:
            try:
                png = _as.render_region_png(path, int(it.get("page", 0)), it["bbox"], dpi=int(dpi))
                im = Image.open(io.BytesIO(png)).convert("RGBA")
                tw = max(1, int(round(float(it["w_mm"]) * pxmm))); th = max(1, int(round(float(it["h_mm"]) * pxmm)))
                im = im.resize((tw, th), Image.LANCZOS)
                canvas.alpha_composite(im, (int(round(float(it["x_mm"]) * pxmm)), int(round(float(it["y_mm"]) * pxmm))))
            except Exception:
                continue
        flat = Image.new("RGB", canvas.size, (255, 255, 255))
        flat.paste(canvas, mask=canvas.split()[3])
        buf = io.BytesIO(); flat.save(buf, "PNG")
        return {"png_base64": _b64.b64encode(buf.getvalue()).decode(),
                "width_mm": round(maxx, 1), "height_mm": round(maxy, 1)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]}, status_code=400)


@app.post("/api/extract-asset")
async def extract_asset(request: Request):
    """เลือก asset 1 ชิ้น -> คืนไฟล์ .ai (เวกเตอร์) หรือ PNG (ถ้าเป็นภาพ)
       body JSON: {token, page, bbox:[x0,y0,x1,y1], kind, xref}"""
    body = await request.json()
    tok = str(body.get("token", ""))
    path = _ASSET_STORE.get(tok)
    if not path or not os.path.exists(path):
        return JSONResponse({"error": "ไฟล์หมดอายุ กรุณาอัปโหลดใหม่"}, status_code=400)
    try:
        from vectorcnc import assets as _as
        kind = str(body.get("kind", "vector"))
        page = int(body.get("page", 0))
        bbox = [float(v) for v in body.get("bbox", [0, 0, 100, 100])]
        if kind == "image":
            png = _as.extract_image(path, int(body.get("xref", 0)))
            return {"kind": "image",
                    "png_base64": base64.b64encode(png).decode(),
                    "note": "ภาพ raster — ส่งเข้า 'ดราฟท์ .ai' เพื่อแปลงเป็นเวกเตอร์"}
        pdf = _as.crop_vector(path, page, bbox)
        return {"kind": "vector",
                "ai_base64": base64.b64encode(pdf).decode(),
                "w_mm": round((bbox[2] - bbox[0]) * 25.4 / 72.0, 1),
                "h_mm": round((bbox[3] - bbox[1]) * 25.4 / 72.0, 1),
                "note": "เวกเตอร์ต้นฉบับ 100% (ไม่ได้ trace ใหม่)"}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ==================================================================
#  PHASE 1B — PRODUCIBILITY CHECKER  (ด่านกรอง "ผลิตได้จริงไหม")
# ==================================================================
@app.post("/api/check-producible")
async def check_producible(file: UploadFile = File(...),
                           real_width_mm: float = Form(600.0),
                           real_height_mm: float = Form(0.0),
                           material: str = Form("acrylic"),
                           min_stroke_mm: float = Form(0.0),
                           min_hole_mm: float = Form(0.0),
                           min_gap_mm: float = Form(0.0),
                           n_colors: int = Form(6)):
    """ตรวจไฟล์ว่า 'ตัดได้จริงไหม' ก่อนรับงาน -> คะแนน 0-100 + จุดที่ต้องแก้ + พรีวิววงแดง"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import producible as PR
        ov = {}
        if float(min_stroke_mm) > 0: ov["min_stroke_mm"] = float(min_stroke_mm)
        if float(min_hole_mm) > 0:   ov["min_hole_mm"] = float(min_hole_mm)
        if float(min_gap_mm) > 0:    ov["min_gap_mm"] = float(min_gap_mm)
        R = PR.rules_for(material, ov)
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        rep = PR.check(full, rules=R)
        rep["svg"] = PR.report_svg(full, rep.get("marks", []))
        rep["material"] = material
        rep["materials"] = [{"key": k, "label": v["label"]}
                            for k, v in PR.MATERIAL_PRESETS.items()]
        return rep
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/autofix")
async def api_autofix(file: UploadFile = File(...),
                      real_width_mm: float = Form(600.0),
                      real_height_mm: float = Form(0.0),
                      material: str = Form("acrylic"),
                      min_stroke_mm: float = Form(0.0),
                      min_hole_mm: float = Form(0.0),
                      min_gap_mm: float = Form(0.0),
                      bold_mm: float = Form(-1.0),
                      n_colors: int = Form(6)):
    """แก้อัตโนมัติ -> คืน .ai + .svg ที่ผลิตได้ + คะแนนก่อน/หลัง"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import producible as PR, concept as CC
        ov = {}
        if float(min_stroke_mm) > 0: ov["min_stroke_mm"] = float(min_stroke_mm)
        if float(min_hole_mm) > 0:   ov["min_hole_mm"] = float(min_hole_mm)
        if float(min_gap_mm) > 0:    ov["min_gap_mm"] = float(min_gap_mm)
        R = PR.rules_for(material, ov)
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        before = PR.check(full, rules=R)
        bm = None if float(bold_mm) < 0 else float(bold_mm)
        fixed, log = PR.autofix(full, rules=R, bold_mm=bm)
        after = PR.check(fixed, rules=R)
        svg_mm = CC.concept_svg_mm(fixed)
        ai_b64 = ""
        try:
            import cairosvg
            ai_b64 = base64.b64encode(
                cairosvg.svg2pdf(bytestring=svg_mm.encode("utf-8"))).decode()
        except Exception:
            pass
        b = fixed.bounds
        return {"log": log,
                "before": {"score": before["score"], "verdict": before["verdict"],
                           "issues": len(before["issues"])},
                "after": {"score": after["score"], "verdict": after["verdict"],
                          "issues": [i["title"] for i in after["issues"]]},
                "svg": PR.report_svg(fixed, after.get("marks", [])),
                "svg_mm": svg_mm, "ai_base64": ai_b64,
                "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# ==================================================================
#  PHASE 2 — SALES BRIEF  (บรีฟรับงานมาตรฐาน — ตัดเวลาถามกลับ)
# ==================================================================
BRIEF_FIELDS = [
    ("customer",   "ชื่อลูกค้า / บริษัท",      True,  "text",   ""),
    ("shop_name",  "ข้อความบนป้าย (ชื่อร้าน)", True,  "text",   ""),
    ("sign_type",  "ประเภทป้าย (1–7)",         True,  "sign",   ""),
    ("width_cm",   "ความกว้าง (ซม.)",          True,  "num",    ""),
    ("height_cm",  "ความสูง (ซม.)",            False, "num",    "เว้นได้ถ้าให้สเกลตามสัดส่วน"),
    ("return_cm",  "ความหนายกขอบ (ซม.)",       True,  "num",    "2.5 / 5 / 7.5 / 10 หรือระบุเอง"),
    ("material",   "วัสดุหน้า",                True,  "mat",    ""),
    ("qty",        "จำนวน (ชุด)",              True,  "num",    ""),
    ("install",    "ติดตั้งที่ไหน / อย่างไร",  True,  "text",   "ผนังปูน / กระจก / โครงเหล็ก / แขวน"),
    ("power",      "ไฟฟ้าถึงจุดติดตั้งหรือยัง", False, "text",  "จำเป็นถ้าเป็นป้ายมีไฟ"),
    ("deadline",   "กำหนดส่ง",                 True,  "text",   ""),
    ("budget",     "งบประมาณ",                 False, "text",   ""),
    ("artwork",    "ไฟล์ต้นแบบที่ลูกค้าให้มา", True,  "text",   ".ai / .pdf / ภาพ / ไม่มีเลย"),
    ("note",       "หมายเหตุ",                 False, "text",   ""),
]


# ==================================================================
#  🔒 ตารางราคา/ต้นทุนบริษัท — เสิร์ฟเฉพาะคนใน (ห้ามฝังใน frontend)
# ==================================================================
# ⚠️⚠️ กติกาความปลอดภัย — ปิดตายเป็นค่าเริ่มต้น (fail-closed) ⚠️⚠️
#
#  บทเรียนที่เคยพลาดมาแล้ว 2 รอบ:
#    รอบ 1: ใช้ VECTORCNC_API_KEY มาแยกคนใน/คนนอก -> ทีมงานโดนตัดเมนู
#    รอบ 2: "ถ้ายังไม่ตั้งคีย์ ให้ผ่านทุกคน" -> คนนอกทั้งอินเทอร์เน็ตเห็นตารางต้นทุนบริษัท
#
#  กติกาใหม่ ไม่มีสวิตช์ให้ลืมกดอีก:
#    ❌ ไม่มีคีย์ = คนนอก เสมอ ไม่มีข้อยกเว้น
#    ✅ ทีมงานเข้าด้วย  ?k=<INTERNAL_KEY>  ครั้งเดียว แล้วเบราว์เซอร์จำให้
#
#  ผลข้างเคียงที่ตั้งใจ: ถ้าลืมตั้ง INTERNAL_KEY ใน Render
#    -> ทีมงานจะไม่เห็นเมนูภายใน (รู้ตัวทันที แก้ได้ใน 1 นาที)
#    -> ดีกว่าปล่อยให้ต้นทุนบริษัทหลุดออกไปโดยไม่มีใครรู้

#  ทางเข้าของทีมงานมี 2 แบบ
#    ① 🎫 ตั๋ว SSO จาก CRM Hub  (แนะนำ — พนักงานไม่ต้องทำอะไรเลย)
#         CRM Hub เซ็นตั๋วด้วย APP_SECRET ให้ทีละคน ผูกกับอีเมล หมดอายุ 12 ชม.
#         พนักงานลาออก -> ถอดออกจาก CRM Hub -> วันรุ่งขึ้นตั๋วหมดอายุเอง
#    ② 🔑 คีย์รวม ?k=<INTERNAL_KEY>  (สำรอง — ใช้ตอน CRM Hub ล่ม)

def _token_of(request: Request) -> str:
    return (request.headers.get("X-User-Token")
            or request.query_params.get("t")
            or request.cookies.get("vc_acc", "")   # 🍪 โทเคนจากการ login ผ่านฟอร์ม (vc_acc)
            or "")


def _role_of(request: Request) -> str:
    """อ่านบทบาทจากตั๋ว SSO · คืน 'admin' / 'internal' / '' """
    from vectorcnc import auth as A
    return A.role_of(_token_of(request))


def _internal_key():
    return os.environ.get("INTERNAL_KEY", "")


def _is_internal(request: Request):
    """คนใน = ตั๋ว SSO ถูกต้อง หรือ INTERNAL_KEY ถูกต้อง

    🚧 ตอนยังไม่เปิดขาย (SELL_MODE=0): เว็บนี้ยังเป็นเครื่องมือใช้กันเองในทีม
       -> ให้ผ่านทุกคน (ทีมงานเข้าผ่าน CRM Hub ด้วย ?u= ได้เหมือนเดิม เห็นเมนูครบ)
       ยังไม่มีคนนอกเข้ามา เพราะยังไม่ประกาศขาย + robots.txt ปิด Google ไว้

    🔒 พอเปิดขาย (SELL_MODE=1): กลับเป็น fail-closed ทันที
       -> ไม่มีตั๋ว/ไม่มีคีย์ = คนนอก ไม่มีข้อยกเว้น
    """
    if _role_of(request) in ("internal", "admin"):
        return True                      # ① ตั๋วจาก CRM Hub

    key = _internal_key()                # ② คีย์รวม
    if key:
        got = (request.headers.get("X-Internal-Key")
               or request.query_params.get("k") or "")
        if got and str(got) == str(key):
            return True

    return not _sell_mode()              # ③ ยังไม่เปิดขาย -> ทีมใช้กันเองได้ปกติ


def _admin_key():
    return os.environ.get("ADMIN_KEY", "")


def _is_admin(request: Request):
    """แอดมิน = ตั๋ว SSO role=admin · ADMIN_KEY ถูกต้อง · หรือ ?u=admin (เฉพาะตอนยังไม่เปิดขาย)

    ⚠️ ?u=admin ปลอมได้ (ใครก็พิมพ์เอง) — ยอมรับเฉพาะตอน SELL_MODE=0
       ซึ่งเป็นช่วงที่ยังใช้กันในทีม เข้าผ่าน CRM Hub เท่านั้น
       พอตั้ง SELL_MODE=1 -> ปิดเองอัตโนมัติ ต้องใช้ตั๋ว SSO หรือ ADMIN_KEY
    """
    if _role_of(request) == "admin":
        return True

    key = _admin_key()
    if key:
        got = (request.headers.get("X-Admin-Key")
               or request.query_params.get("ak") or "")
        if got and str(got) == str(key):
            return True

    # ยังไม่เปิดขาย -> เชื่อ ?u=admin จาก CRM Hub ได้
    if not _sell_mode():
        u = str(request.query_params.get("u", "")).strip().lower()
        if u in ("admin", "administrator"):
            return True

    return False


@app.get("/api/security-check")
def api_security_check():
    """เช็กว่าตั้งคีย์ครบหรือยัง — เปิดดูได้ทุกคน แต่ไม่บอกค่าคีย์ บอกแค่ว่า 'ตั้งแล้ว/ยัง'"""
    from vectorcnc import auth as A, billing as B
    ok_int = bool(_internal_key())
    ok_adm = bool(_admin_key())
    ok_sec = A.secret_is_set()
    return {
        "internal_key": "✅ ตั้งแล้ว" if ok_int else "❌ ยังไม่ตั้ง — ทีมงานจะไม่เห็นเมนูภายใน",
        "admin_key":    "✅ ตั้งแล้ว" if ok_adm else "❌ ยังไม่ตั้ง — เข้าหน้าสถิติ/อนุมัติสลิปไม่ได้",
        "app_secret":   "✅ ตั้งแล้ว" if ok_sec else "❌ ยังไม่ตั้ง — ลูกค้าจะหลุด login ทุกครั้งที่ deploy",
        "payments_open": B.PAYMENTS_OPEN,
        "all_ok": ok_int and ok_adm and ok_sec,
    }


@app.get("/api/whoami")
def api_whoami(request: Request):
    """บอก frontend ว่าเป็น 'คนใน / แอดมิน / คนนอก' — ใช้ซ่อนเมนู"""
    from vectorcnc import billing as B, auth as A
    internal = _is_internal(request)
    admin = _is_admin(request) and internal

    if admin:
        plan = "admin"
    elif internal:
        plan = "internal"
    else:
        # 💳 คนนอก: อ่านสิทธิ์จากโทเคนที่ได้ตอนจ่ายเงิน (ปลอมไม่ได้ เพราะเซ็นด้วย APP_SECRET)
        tok = (request.headers.get("X-User-Token")
               or request.query_params.get("t") or "")
        p = A.verify(tok)
        plan = (p or {}).get("p", "free")
        if plan not in B.PLANS or plan in ("internal", "admin"):
            plan = "free"          # ⚠️ กันคนยัด plan=admin มาในโทเคนของตัวเอง

    hidden = []
    if not internal:
        hidden = B.INTERNAL_ONLY
    elif not admin:
        hidden = ["stats"]                  # คนในธรรมดา -> ไม่เห็นสถิติ

    return {"internal": internal, "is_admin": admin, "plan": plan,
            "plan_label": B.PLANS[plan]["label"],
            "email": (A.verify(request.headers.get("X-User-Token", "")) or {}).get("e", ""),
            "features": B.PLANS[plan]["features"],
            "payments_open": B.PAYMENTS_OPEN,
            "hidden": hidden}


@app.get("/api/plans")
def api_plans():
    """ตารางแพ็กเกจสาธารณะ (ให้หน้า Landing/Pricing เรนเดอร์)"""
    from vectorcnc import billing as B
    return {"plans": B.public_plans(), "features": B.FEATURES,
            "features_en": B.FEATURES_EN,
            "payments_open": B.PAYMENTS_OPEN,     # 💳 ยังไม่ต่อ payment -> ปุ่ม Upgrade ปิด
            "contact_email": B.CONTACT_EMAIL}


@app.get("/welcome")
def welcome_page():
    """หน้าขาย — ปิดไว้จนกว่าจะพร้อมขายจริง (ตั้ง SELL_MODE=1)"""
    if not _sell_mode():
        return JSONResponse({"error": "not_open",
                             "msg": "ยังไม่เปิดขาย"}, status_code=404)
    p = os.path.join(os.path.dirname(FRONTEND), "landing.html")
    if os.path.exists(p):
        return FileResponse(p)
    return JSONResponse({"error": "landing.html not found"}, status_code=404)


# ==================================================================== 🔍 SEO
#  ตั้ง env SITE_URL ให้เป็นโดเมนจริงเมื่อย้ายออกจาก onrender.com
def _site_url():
    return os.environ.get("SITE_URL", "https://vectorcnc.onrender.com").rstrip("/")


@app.get("/robots.txt", response_class=PlainTextResponse)
def robots_txt():
    """บอก Google ว่าเก็บอะไรได้ / ห้ามเก็บอะไร
       ⚠️ /api/* ห้าม index เด็ดขาด — มีตารางราคา/ข้อมูลภายในอยู่"""
    site = _site_url()

    # 🚧 ยังไม่เปิดขาย -> ห้าม Google เก็บทั้งเว็บ (กันหน้าเครื่องมือภายในโผล่ในผลค้นหา)
    if not _sell_mode():
        return "User-agent: *\nDisallow: /\n"

    return (
        "User-agent: *\n"
        "Allow: /$\n"
        "Allow: /welcome\n"
        "Allow: /app\n"
        "Disallow: /api/\n"
        "Disallow: /jobs\n"
        "Disallow: /admin/\n"
        "Disallow: /pay\n"
        "Disallow: /*?t=\n"          # 🔒 ตั๋ว SSO ห้าม index เด็ดขาด
        "Disallow: /*?k=\n"
        "Disallow: /*?ak=\n"
        "Disallow: /*?u=\n"
        "\n"
        # 🤖 GEO — เปิดให้ "AI ค้นหา" เก็บข้อมูลได้ (ChatGPT · Claude · Perplexity · Gemini · Meta)
        #    ยุคนี้ลูกค้าถาม AI ก่อน Google ถ้าปิดบอทพวกนี้ = AI ไม่รู้จักเรา ไม่แนะนำเราเลย
        + "".join(
            "User-agent: %s\n"
            "Allow: /$\n"
            "Allow: /welcome\n"
            "Allow: /llms.txt\n"
            "Disallow: /api/\n"
            "Disallow: /admin/\n"
            "\n" % _bot
            for _bot in (
                "GPTBot", "OAI-SearchBot", "ChatGPT-User",      # OpenAI / ChatGPT
                "ClaudeBot", "Claude-SearchBot", "Claude-User",  # Anthropic / Claude
                "PerplexityBot", "Perplexity-User",              # Perplexity
                "Google-Extended",                               # Gemini / AI Overviews
                "Applebot-Extended",                             # Apple Intelligence
                "meta-externalagent",                            # Meta AI
                "Amazonbot", "cohere-ai", "CCBot",
            )
        )
        + f"Sitemap: {site}/sitemap.xml\n"
    )


@app.get("/llms.txt", response_class=PlainTextResponse)
def llms_txt():
    """📄 llms.txt — มาตรฐานใหม่สำหรับ 'AI ค้นหา' (GEO / AEO)
       บอก AI ตรง ๆ ว่าเว็บนี้คืออะไร ทำอะไรได้ ใช้ยังไง เพื่อให้ AI ตอบลูกค้าถูก
       และอ้างอิงเราเวลามีคนถามว่า 'มีโปรแกรมทำไฟล์ตัดป้ายมั้ย'"""
    site = _site_url()
    if not _sell_mode():
        return "# VectorCNC\n\n> ยังไม่เปิดให้บริการสาธารณะ\n"
    return f"""# VectorCNC

> เครื่องมือออนไลน์สำหรับช่างทำป้ายและโรงงาน CNC / เลเซอร์ ในประเทศไทย
> อัปโหลดโลโก้หรือภาพ แล้วได้ไฟล์ตัดพร้อมผลิตทันที (.ai / SVG / DXF)
> ไม่ต้องติดตั้งโปรแกรม ใช้ผ่านเว็บได้เลย · ทดลองใช้ฟรี · ภาษาไทยเต็มระบบ

VectorCNC แก้ปัญหาที่ช่างป้ายไทยเจอทุกวัน: ลูกค้าส่งโลโก้มาเป็น JPG เบลอ ๆ
แล้วช่างต้องนั่งไล่ Pen Tool ใน Illustrator เป็นชั่วโมงกว่าจะได้เส้นตัด
VectorCNC ทำให้เสร็จใน 2 นาที พร้อมชั้นตัดครบทุกชิ้นตามประเภทป้าย

## ทำอะไรได้บ้าง

- **แปลงภาพเป็นเส้นตัด**: JPG / PNG / PSD / AI / PDF / EPS / SVG → เส้นโค้งเบซิเยร์คมระดับผลิตจริง
  ใช้เอนจิ้น potrace คุณภาพเทียบ Image Trace ของ Illustrator ขยายเป็นป้ายกี่เมตรก็ไม่แตก
- **ชุดชั้นตัดอัตโนมัติ 26 ประเภทป้าย**: ตัวอักษรยกขอบไฟออกหน้า (มีคิ้ว / ไม่มีคิ้ว) · ไฟออกหลัง ·
  ไฟออกรอบ · กล่องไฟฉลุหน้า · กล่องไฟล้อมทรง / กลม / เหลี่ยม / วงรี · นีออนเฟล็กซ์ ·
  พลาสวูด-อะคริลิคไดคัท · ตัวอักษรโลหะไม่มีไฟ · สแตนดี้สี่เหลี่ยม / ล้อมตามทรง
  ระบบคำนวณคิ้ว แผ่นพื้น ผนังยกขอบ และรูร้อยสายให้เองตามความหนาวัสดุที่กรอก
- **ป้ายเดียวหลายวัสดุ**: ลากเลือกเฉพาะคำ แล้วจ่ายวัสดุ / ความหนา / สี คนละแบบให้แต่ละส่วนได้
  (เช่น ชื่อร้านเป็นอะคริลิคไฟออกหน้า ส่วนคำโปรยเป็นพลาสวูด 10 มม. สีขาว) ในไฟล์เดียว
- **ภาพ 3 มิติเสนอลูกค้า**: พื้นผิวสแตนเลสเงา / แฮร์ไลน์ / ทอง / โรสโกลด์ / ดำด้าน
  อัปโหลดลายไม้-ลามิเนตเองได้ · จำลองไฟออกหน้า-หลัง-รอบ อุณหภูมิสี 2700K–11000K
- **ใบสั่งผลิต A3 แผ่นเดียว**: ภาพ 3 มิติ + Top / Front / Side / Back View + BOM แยกวัสดุ + แผน LED
- **ไฟล์งานพิมพ์ 1:1**: สร้างไฟล์พิมพ์ UV หรือสติ๊กเกอร์ไดคัทขนาดจริง พร้อมเลเยอร์ CutContour
- **จัดวางลงแผ่น (nesting)** คำนวณจำนวนแผ่นที่ต้องใช้ และ **จำลองป้ายบนผนัง** ตามสเกลจริง

## คำถามที่พบบ่อย

**ใช้ยังไง** — เปิด {site} → อัปโหลดไฟล์ → กรอกขนาดป้ายจริงเป็นเซนติเมตร →
เลือกประเภทป้ายกับวัสดุ → กดสร้างไฟล์สั่งผลิต → ได้ .ai แยกเลเยอร์ทุกชั้นตัด

**รองรับไฟล์อะไรบ้าง** — นำเข้า: JPG PNG PSD AI PDF EPS SVG · ส่งออก: .ai SVG DXF STL

**ต้องติดตั้งโปรแกรมไหม** — ไม่ต้อง ใช้ผ่านเบราว์เซอร์ ทำงานบนมือถือและแท็บเล็ตได้

**ไฟล์ที่ได้เข้าเครื่องอะไรได้** — CypCut / เลเซอร์ไฟเบอร์ (DXF) · LightBurn (SVG) ·
เราท์เตอร์ CNC · Illustrator / CorelDRAW (.ai) · เครื่องพิมพ์ UV (PDF 1:1)

**เหมาะกับใคร** — ร้านป้าย โรงงานตัดเลเซอร์ ช่างอะคริลิค นักออกแบบกราฟิก
เอเจนซี่ที่ต้องส่งไฟล์ให้โรงงาน และเจ้าของธุรกิจที่อยากได้ป้ายหน้าร้าน

**ราคา** — ทดลองใช้ฟรี ไม่ต้องใช้บัตรเครดิต

**ให้บริการที่ไหน** — ออนไลน์ทั่วประเทศไทย อินเทอร์เฟซภาษาไทย หน่วยเป็นเซนติเมตร/มิลลิเมตร

## ลิงก์

- หน้าหลัก: {site}/
- เริ่มใช้งาน: {site}/app
- แผนผังเว็บ: {site}/sitemap.xml
"""


@app.get("/sitemap.xml")
def sitemap_xml():
    site = _site_url()
    if not _sell_mode():                      # 🚧 ยังไม่เปิดขาย -> sitemap ว่าง
        return Response(content='<?xml version="1.0" encoding="UTF-8"?>\n'
                                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>\n',
                        media_type="application/xml")
    today = _dt.datetime.utcnow().strftime("%Y-%m-%d")
    pages = [
        (f"{site}/",        "1.0", "weekly"),   # หน้าแรก = หน้าขาย
        (f"{site}/welcome", "0.9", "weekly"),   # หน้าเดิม (ยังเปิดอยู่ กันลิงก์เก่าพัง)
        (f"{site}/app",     "0.7", "monthly"),  # ตัวแอป
    ]
    items = ""
    for loc, pri, freq in pages:
        items += (
            "  <url>\n"
            f"    <loc>{loc}</loc>\n"
            f"    <lastmod>{today}</lastmod>\n"
            f"    <changefreq>{freq}</changefreq>\n"
            f"    <priority>{pri}</priority>\n"
            f'    <xhtml:link rel="alternate" hreflang="th" href="{loc}?lang=th"/>\n'
            f'    <xhtml:link rel="alternate" hreflang="en" href="{loc}?lang=en"/>\n'
            f'    <xhtml:link rel="alternate" hreflang="x-default" href="{loc}"/>\n'
            "  </url>\n"
        )
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f"{items}"
        "</urlset>\n"
    )
    return Response(content=xml, media_type="application/xml")


@app.get("/api/price-catalog")
def api_price_catalog(request: Request):
    """ตารางราคาจริง — คนนอกเรียกได้ก็ได้แค่ 403"""
    if not _is_internal(request):
        return JSONResponse(
            {"error": "forbidden",
             "msg": "เมนูประเมินราคาเปิดให้เฉพาะทีมงานภายในเท่านั้น"},
            status_code=403)
    from vectorcnc import price_catalog as PC
    return PC.get_catalog()


# 🪵 ============ ไดคัท พลาสวูด / อะคริลิค — เปิดให้ 'จบผิว' ได้ครบ ============
#    ไม่เพิ่มรายการประเภทป้าย — ใช้รายการเดิม 4 ตัว (1 layer / 2 layer × พลาสวูด / อะคริลิค)
#    แค่เปิด 'ความสามารถ' ให้ครบ:
#      • พิมพ์ UV ลงผิววัสดุโดยตรง  หรือ  ติดสติ๊กเกอร์ทับ  (เลือกที่แผงงานพิมพ์บนผิววัสดุ)
#      • ทำสีได้ (พ่นสี/ย้อมสีดูก่อนผลิต) ทั้งพลาสวูดและอะคริลิค
#      • ทำงานได้ทั้งแบบ 1 layer และ 2 layer — ชั้นรองก็พิมพ์/ทำสีได้เหมือนกัน
for _k9, _mat9 in (("22", "พลาสวูด 10mm"), ("23", "พลาสวูด 10mm"),
                   ("24", "อะคริลิค 5mm"), ("25", "อะคริลิค 5mm")):
    _r9 = SIGN_TYPES.get(_k9)
    if not _r9:
        continue
    _r9["face_finish"] = "print"          # -> โผล่แผง 'งานพิมพ์บนผิววัสดุ' + ออกไฟล์พิมพ์ 1:1
    _r9["face_material"] = _mat9
    _r9["allow_text"] = True
    for _L9 in _r9.get("layers", []):     # ทุกชั้น (รวมชั้นรองของแบบ 2 layer) พิมพ์/ทำสีได้
        _L9["finish"] = "print"

# 🧱 ============ +1 รายการเดียวตามที่สั่ง: งานตกแต่งผนัง ซ่อนไฟหลัง ============
#    พลาสวูดไดคัท พิมพ์ UV / สติ๊กเกอร์ + ซ่อนไฟหลัง (halo) — แสงเลียบผนัง มองจากหน้าไม่เห็นเส้นไฟ
#    ชั้นรอง (spacer) เล็กกว่าตัวงาน 2.5 ซม. -> ซ่อนอยู่ด้านหลัง ไม่โผล่ให้เห็น
SIGN_TYPES["28"] = {
    "name": "พลาสวูดซ่อนไฟหลัง ไดคัท พิมพ์ UV / สติ๊กเกอร์ (ตกแต่งผนัง)",
    "depth_cm": 4.0, "flat": True, "allow_text": True,
    "face_finish": "print", "face_material": "พลาสวูด 10mm",
    "glow_color": "#fff3c4",
    "walls": [{"name": "ระยะลอยจากผนัง (ซ่อนไฟ)", "h": 4.0}],
    "layers": [
        {"name": "ชั้นหน้า พลาสวูด 10mm ไดคัท (พิมพ์ UV / สติ๊กเกอร์)", "off": 0.0, "kind": "solid",
         "finish": "print", "color": "#2563EB", "rgb": (37, 99, 235)},
        {"name": "ชั้นรอง spacer ซ่อนไฟ (เล็กกว่า 2.5 ซม. — มองจากหน้าไม่เห็น)", "off": -25.0,
         "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)},
    ],
}


@app.get("/api/sign-types")
def api_sign_types():
    """รายการแบบป้าย 1-7 (ไว้ให้หน้าจำลองผนังเลือก)"""
    return {"types": [{"key": k, "label": v["name"], "label_en": _en_type(v["name"]),
                       "depth_cm": v.get("depth_cm", 5),
                       "has_trim": any(L.get("kind") == "frame" for L in v["layers"])}
                      for k, v in SIGN_TYPES.items()]}


@app.get("/api/brief-fields")
def brief_fields():
    """โครงบรีฟรับงาน — ให้ frontend เรนเดอร์ฟอร์ม"""
    from vectorcnc import producible as PR
    return {
        "fields": [{"key": k, "label": l, "required": r, "type": t, "hint": h}
                   for k, l, r, t, h in BRIEF_FIELDS],
        "sign_types": [{"key": k, "label": v["name"], "label_en": _en_type(v["name"])}
                       for k, v in SIGN_TYPES.items()],
        "materials": [{"key": k, "label": v["label"]}
                      for k, v in PR.MATERIAL_PRESETS.items()],
    }


@app.post("/api/brief")
async def api_brief(request: Request):
    """รับค่าบรีฟ -> ให้คะแนนความครบ + บอกช่องที่ขาด + สรุปเป็นเอกสารส่งกราฟิก"""
    data = await request.json()
    vals = data.get("values", {}) or {}
    miss = []
    filled = 0
    for k, label, req, _t, _h in BRIEF_FIELDS:
        v = str(vals.get(k, "") or "").strip()
        if v:
            filled += 1
        elif req:
            miss.append(label)
    score = int(round(100.0 * filled / len(BRIEF_FIELDS)))
    ready = (len(miss) == 0)

    st = str(vals.get("sign_type", "") or "")
    stn = SIGN_TYPES.get(st, {}).get("name", "")
    lines = []
    lines.append("JOB BRIEF — %s" % (vals.get("customer") or "-"))
    lines.append("=" * 46)
    for k, label, _r, _t, _h in BRIEF_FIELDS:
        v = str(vals.get(k, "") or "").strip()
        if k == "sign_type" and stn:
            v = "%s · %s (%s)" % (v, stn, _en_type(stn))
        lines.append("%-26s : %s" % (label, v or "— ยังไม่ระบุ —"))
    lines.append("")
    lines.append("ความครบของบรีฟ: %d%%  (%s)"
                 % (score, "พร้อมส่งกราฟิก ✓" if ready else "ยังขาด: " + ", ".join(miss)))
    return {"score": score, "ready": ready, "missing": miss,
            "sign_type_name": stn, "text": "\n".join(lines)}


# ==================================================================
#  PHASE 3 — AI CONCEPT KIT  (ลูกค้าไม่มี idea / ไม่มีโลโก้)
# ==================================================================
NAME_SYS = ("คุณเป็นนักตั้งชื่อแบรนด์ไทยที่เข้าใจงานป้าย ตอบเป็น JSON เท่านั้น "
            "รูปแบบ: {\"names\":[{\"name\":\"...\",\"why\":\"...\"}]} "
            "ชื่อต้องสั้น (ไม่เกิน 14 ตัวอักษร) ออกเสียงง่าย และ 'ตัดเป็นตัวอักษรป้ายได้สวย' "
            "คือไม่มีตัวอักษรบางเรียวหรือรายละเอียดจุกจิก")


@app.post("/api/concept-names")
async def concept_names(request: Request):
    """เจนชื่อร้านให้เซลล์เสนอลูกค้าหน้างาน (ใช้ Claude ถ้ามี key · ไม่มีก็ใช้คลังคำสำรอง)"""
    d = await request.json()
    biz = str(d.get("biz", "shop"))
    tone = str(d.get("tone", "โมเดิร์น"))
    detail = str(d.get("detail", ""))
    lang = str(d.get("lang", "both"))
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
    if key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=key)
            p = ("ธุรกิจ: %s · โทน: %s · ภาษา: %s · รายละเอียดเพิ่ม: %s\n"
                 "ขอชื่อร้าน 10 ชื่อ พร้อมเหตุผลสั้น ๆ ว่าทำไมเหมาะกับป้าย" %
                 (biz, tone, lang, detail or "-"))
            msg = client.messages.create(
                model=os.environ.get("DESIGN_MODEL", "claude-sonnet-4-6"),
                max_tokens=1200, system=NAME_SYS,
                messages=[{"role": "user", "content": p}])
            txt = "".join(getattr(b, "text", "") for b in msg.content
                          if getattr(b, "type", "") == "text")
            m = re.search(r"\{[\s\S]*\}", txt)
            if m:
                js = json.loads(m.group(0))
                names = js.get("names", [])
                if names:
                    return {"names": names[:12], "source": "ai"}
        except Exception:
            pass
    from vectorcnc import concept as CC
    return {"names": CC.name_ideas(biz, tone, lang, 10), "source": "fallback"}


@app.get("/api/concept-styles")
def concept_styles(text: str = ""):
    from vectorcnc import concept as CC
    return {"styles": CC.available_styles(text), "layouts":
            [{"key": k, "label": l} for k, l in CC.LAYOUTS]}


@app.post("/api/concept")
async def api_concept(request: Request):
    """สร้างโลโก้เวกเตอร์จริงหลายแบบ (สไตล์ฟอนต์ × เลย์เอาต์) + ตรวจผลิตได้เลยในตัว"""
    d = await request.json()
    name = str(d.get("name", "")).strip()
    if not name:
        return JSONResponse({"error": "ยังไม่ได้ใส่ชื่อร้าน"}, status_code=400)
    sub = str(d.get("sub", "")).strip()
    cap = float(d.get("cap_mm", 200) or 200)
    styles = d.get("styles") or None
    layouts = d.get("layouts") or None
    material = str(d.get("material", "acrylic"))
    try:
        from vectorcnc import concept as CC, producible as PR
        R = PR.rules_for(material)
        cs = CC.generate(name, sub=sub, styles=styles, layouts=layouts, cap_mm=cap)
        if not cs:
            return JSONResponse({"error": "สร้างคอนเซปต์ไม่สำเร็จ (ไม่พบฟอนต์ที่รองรับ)"},
                                status_code=400)
        out = []
        for c in cs:
            rep = PR.check(c["geom"], rules=R)
            out.append({k: c[k] for k in
                        ("id", "style", "style_label", "font", "layout",
                         "layout_label", "w_mm", "h_mm", "svg")}
                       | {"score": rep["score"], "verdict": rep["verdict"],
                          "issues": [i["title"] for i in rep["issues"]]})
        out.sort(key=lambda c: -c["score"])
        return {"concepts": out, "count": len(out)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)


# ==================================================================
#  📊 ANALYTICS — สถิติการเข้าใช้งาน (สะสม)
# ==================================================================
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

_AN_LOCK = threading.Lock()
def _an_dbpath():
    """ที่เก็บสถิติในเครื่อง — เลือก 'ที่ที่รอดจากการ deploy' ก่อนเสมอ
       บน Render ถ้าต่อ Persistent Disk ไว้ที่ /var/data ข้อมูลจะอยู่ถาวร
       ถ้าไม่มี disk -> /tmp (หายตอน deploy) แต่ยังมี Google Sheet เป็นตัวถาวรสำรองอยู่"""
    _env = os.environ.get("ANALYTICS_DB", "").strip()
    if _env:
        return _env
    for _d in (os.environ.get("DATA_DIR", "").strip(), "/var/data", "/data", "/tmp"):
        if not _d:
            continue
        try:
            os.makedirs(_d, exist_ok=True)
            _t = os.path.join(_d, ".wtest")
            with open(_t, "w") as _f:
                _f.write("1")
            os.remove(_t)
            return os.path.join(_d, "vectorcnc_stats.db")
        except Exception:
            continue
    return "/tmp/vectorcnc_stats.db"


_AN_DB = _an_dbpath()
_AN_PERSIST = not _AN_DB.startswith("/tmp")     # True = รอด deploy · False = อาศัย Google Sheet
TZ7 = timezone(timedelta(hours=7))          # เวลาไทย

# ⬇ Google Sheet (Apps Script /exec) — เก็บสถิติถาวร ไม่หายตอน deploy
#   ฝังไว้ตรงนี้เลย ไม่ต้องตั้ง env บน Render (ถ้าอยากเปลี่ยน ตั้ง env ANALYTICS_WEBHOOK ทับได้)
ANALYTICS_SHEET_URL = ("https://script.google.com/macros/s/"
                       "AKfycbwY0lih8PDlfgM4eA6EQr36dVv3e7xgOMU9WW9fAlV_Qry2b41-HFqPAykpXTUeZ39Q/exec")


def _an_conn():
    c = sqlite3.connect(_AN_DB, timeout=8)
    c.execute("""CREATE TABLE IF NOT EXISTS ev(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, day TEXT, sid TEXT, account TEXT, ev TEXT,
        page TEXT, menu TEXT, ref TEXT, refhost TEXT,
        device TEXT, browser TEXT, dur INTEGER DEFAULT 0)""")
    c.execute("CREATE INDEX IF NOT EXISTS i_day ON ev(day)")
    c.execute("CREATE INDEX IF NOT EXISTS i_sid ON ev(sid)")
    # 👤 ชื่อจริง/ชื่อเล่น ของคนที่ล็อกอินผ่าน CRM Hub — เพิ่มทีหลังแบบไม่ทำลายข้อมูลเดิม
    #    (ฐานข้อมูลเก่าที่ยังไม่มี 2 คอลัมน์นี้จะถูกเติมให้อัตโนมัติ แถวเดิมเป็นค่าว่าง)
    for _col in ("nick", "fullname"):
        try:
            c.execute("ALTER TABLE ev ADD COLUMN %s TEXT DEFAULT ''" % _col)
        except Exception:
            pass          # มีอยู่แล้ว = ไม่ต้องทำอะไร
    return c


def _ocr_prep(img):
    """เตรียมภาพก่อนอ่าน: ขาวดำ + ปรับแสงเงา + ขยายให้ตัวอักษรใหญ่พอ
       ภาพถ่ายจากมือถือมักเอียง/มีเงา/ความละเอียดต่ำ — ขั้นนี้ช่วยได้เยอะ"""
    import cv2 as _cv, numpy as _np
    g = _cv.cvtColor(img, _cv.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = g.shape[:2]
    if max(h, w) < 1600:                       # ตัวเล็กเกิน -> ขยายก่อน อ่านแม่นขึ้นชัดเจน
        s = 1600.0 / max(h, w)
        g = _cv.resize(g, None, fx=s, fy=s, interpolation=_cv.INTER_CUBIC)
    g = _cv.bilateralFilter(g, 7, 45, 45)      # ลด noise แต่คงขอบตัวอักษร
    # แสงไม่สม่ำเสมอ (เงามือ/แสงข้าง) -> ปรับเฉพาะจุด
    g = _cv.adaptiveThreshold(g, 255, _cv.ADAPTIVE_THRESH_GAUSSIAN_C, _cv.THRESH_BINARY, 41, 15)
    return g


def _ocr_cloud(raw):
    """🌩️ Cloud OCR — ใช้เมื่อ Tesseract อ่านไม่ออก (ลายมือ)
       เปิดใช้โดยตั้ง env: OCR_API_URL (+ OCR_API_KEY)
       รูปแบบที่รองรับ: Google Cloud Vision images:annotate
       ไม่ได้ตั้ง = ข้ามไปเฉย ๆ ไม่มีค่าใช้จ่าย ไม่พัง"""
    url = (os.environ.get("OCR_API_URL") or "").strip()
    key = (os.environ.get("OCR_API_KEY") or "").strip()
    if not url:
        return None
    try:
        import urllib.request as _u, json as _j, base64 as _b
        body = _j.dumps({"requests": [{"image": {"content": _b.b64encode(raw).decode()},
                                       "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                                       "imageContext": {"languageHints": ["th", "en"]}}]}).encode()
        full = url + (("&" if "?" in url else "?") + "key=" + key if key else "")
        req = _u.Request(full, data=body, headers={"Content-Type": "application/json"})
        with _u.urlopen(req, timeout=25) as r:
            j = _j.loads(r.read().decode("utf-8", "ignore") or "{}")
        t = (((j.get("responses") or [{}])[0].get("fullTextAnnotation") or {}).get("text") or "")
        return t or None
    except Exception:
        return None


@app.post("/api/ocr-text")
async def api_ocr_text(file: UploadFile = File(...), psm: int = Form(6)):
    """📷 อ่านข้อความจากภาพ -> ส่งกลับเป็นบรรทัด ๆ ให้เอาไปวางบนกระดานออกแบบ
       ลำดับ: tesseract (ฟรี บนเซิร์ฟเวอร์) -> ถ้าอ่านไม่ออกและตั้ง Cloud ไว้ จึงค่อยเรียก Cloud
       อ่านผิดได้ ผู้ใช้แก้ต่อเองในกระดานได้ทันที"""
    try:
        raw = await file.read()
        if not raw:
            return {"ok": False, "error": "empty", "msg": "ไม่พบไฟล์ภาพ"}
        import cv2 as _cv, numpy as _np
        img = _cv.imdecode(_np.frombuffer(raw, _np.uint8), _cv.IMREAD_COLOR)
        if img is None:
            return {"ok": False, "error": "bad_image", "msg": "เปิดไฟล์ภาพไม่ได้ (รองรับ JPG/PNG)"}
        text = ""; eng = ""
        try:
            import pytesseract
            prep = _ocr_prep(img)
            _cfg = "--psm %d" % max(1, min(13, int(psm or 6)))
            for _lang in ("tha+eng", "eng"):          # ไทย+อังกฤษก่อน · ไม่มีโมเดลไทยค่อยถอยเป็น eng
                try:
                    text = pytesseract.image_to_string(prep, lang=_lang, config=_cfg) or ""
                    eng = "tesseract:" + _lang
                    if text.strip():
                        break
                except Exception:
                    continue
        except Exception:
            text = ""
        _lines = [s.strip() for s in str(text or "").splitlines() if s.strip()]
        # อ่านไม่ออก (หรือได้แต่ขยะสั้น ๆ) -> ลอง Cloud ถ้าพี่เปิดไว้
        if len("".join(_lines)) < 4:
            _c = _ocr_cloud(raw)
            if _c:
                _lines = [s.strip() for s in _c.splitlines() if s.strip()]
                eng = "cloud"
        _lines = _lines[:24]                          # ป้ายจริงไม่เกินนี้ กันขยะยาว
        return {"ok": True, "engine": eng or "none", "lines": _lines,
                "text": "\n".join(_lines),
                "msg": ("อ่านได้ %d บรรทัด — ตรวจแก้ได้เลยก่อนสร้างแบบ" % len(_lines)) if _lines
                       else "อ่านข้อความไม่ออก (ลายมือหวัดหรือภาพไม่ชัด) — พิมพ์เองได้เลย"}
    except Exception as e:
        return {"ok": False, "error": "ocr_failed", "msg": "อ่านภาพไม่สำเร็จ: %s" % str(e)[:90]}


@app.post("/api/track")
async def api_track(request: Request):
    """บันทึก event: visit / menu / heartbeat / leave"""
    try:
        d = await request.json()
    except Exception:
        return {"ok": False}
    now = datetime.now(TZ7)
    row = (now.isoformat(timespec="seconds"), now.strftime("%Y-%m-%d"),
           str(d.get("sid", ""))[:40], str(d.get("account", "guest"))[:60],
           str(d.get("ev", "visit"))[:20], str(d.get("page", ""))[:80],
           str(d.get("menu", ""))[:80], str(d.get("ref", ""))[:200],
           str(d.get("refhost", ""))[:80], str(d.get("device", ""))[:20],
           str(d.get("browser", ""))[:40], int(d.get("dur", 0) or 0),
           str(d.get("nick", ""))[:60], str(d.get("fullname", ""))[:80])   # 👤 ชื่อเล่น · ชื่อจริง
    ok_local = True
    try:
        with _AN_LOCK:
            c = _an_conn()
            c.execute("INSERT INTO ev(ts,day,sid,account,ev,page,menu,ref,refhost,device,browser,dur,nick,fullname)"
                      " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            c.commit()
            c.close()
    except Exception:
        ok_local = False        # ⚠️ เขียนในเครื่องพลาด ก็ยังต้องยิงเข้าชีตอยู่ดี

    _push_sheet(row)                       # ยิงเข้าชีตแบบ background (ไม่หน่วงหน้าเว็บ)
    return {"ok": True, "local": ok_local}


def _sheet_hook():
    """URL Apps Script — ล้างช่องว่าง/ขึ้นบรรทัดใหม่ที่ติดมาตอน copy-paste ใส่ Render
       (ถ้ามี \n ปนอยู่ urllib จะโยน InvalidURL ทันที -> เขียนชีตไม่ได้เลย)"""
    u = os.environ.get("ANALYTICS_WEBHOOK", "") or ANALYTICS_SHEET_URL or ""
    return "".join(str(u).split())          # ตัด space/tab/newline ทั้งหมด


def _push_sheet(row, blocking=False):
    """ยิง event เข้า Google Sheet (Apps Script)
       - เดิม timeout 3 วิ -> Apps Script ตอบไม่ทัน (มี redirect) -> ไม่มีแถวลงชีต
       - ตอนนี้ ยิงใน background thread + timeout 25 วิ + ตาม redirect เอง"""
    hook = _sheet_hook()
    if not hook:
        return False, "ไม่ได้ตั้ง ANALYTICS_WEBHOOK"

    payload = {"api": "hit",                       # ⚠️ ต้องมี — ไม่งั้น Apps Script ตอบ "unknown api: undefined"
               "sid": row[2], "account": row[3], "u": row[3], "ev": row[4], "page": row[5],
               "menu": row[6], "refhost": row[8] or row[7], "ref": row[8] or row[7],
               "device": row[9], "browser": row[10], "dur": row[11]}

    def _go():
        import urllib.request
        import urllib.parse
        import urllib.error
        # ── วิธีหลัก: POST + JSON body (ไม่ต้องยัดภาษาไทยลง URL -> Google ไม่ตีกลับ 400)
        try:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                hook, data=data, method="POST",
                headers={"Content-Type": "text/plain;charset=utf-8",
                         "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read(400).decode("utf-8", "ignore")
            if '"ok":true' in body.replace(" ", ""):
                return True, "ok (POST)"
            err_post = "POST ตอบผิดปกติ: " + body[:150]
        except Exception as e:
            err_post = "POST %s: %s" % (type(e).__name__, e)
        # ── สำรอง: GET (ตัดภาษาไทยออกจาก URL กัน 400)
        try:
            safe = {"api": "hit", "sid": row[2], "u": row[3], "ev": row[4],
                    "page": row[5], "device": row[9], "browser": row[10],
                    "dur": row[11],
                    "menu": urllib.parse.quote(str(row[6] or ""), safe=""),
                    "ref": urllib.parse.quote(str(row[8] or row[7] or ""), safe="")}
            url = hook + ("&" if "?" in hook else "?") + urllib.parse.urlencode(safe)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read(400).decode("utf-8", "ignore")
            if '"ok":true' in body.replace(" ", ""):
                return True, "ok (GET fallback)"
            msg = err_post + " | GET ตอบผิดปกติ: " + body[:120]
        except Exception as e:
            msg = err_post + " | GET %s: %s" % (type(e).__name__, e)
        print("[analytics] push failed:", msg, flush=True)
        return False, msg

    if blocking:
        return _go()
    threading.Thread(target=lambda: _go(), daemon=True).start()
    return True, "sent"


@app.get("/api/track-test")
def api_track_test():
    """ทดสอบว่าเขียนลง Google Sheet ได้จริงไหม + บอกสาเหตุถ้าไม่ได้"""
    now = datetime.now(TZ7)
    row = (now.isoformat(timespec="seconds"), now.strftime("%Y-%m-%d"),
           "TEST", "test", "visit", "/", "ทดสอบระบบสถิติ", "", "(ทดสอบ)",
           "desktop", "Test", 0)
    hook = _sheet_hook()
    ok, detail = _push_sheet(row, blocking=True)
    hint = ""
    if not ok:
        d = str(detail)
        if "InvalidURL" in d or "control characters" in d:
            hint = "URL ใน ANALYTICS_WEBHOOK มีตัวขึ้นบรรทัด/ช่องว่างปน — ลบแล้ววางใหม่ให้เป็นบรรทัดเดียว"
        elif "401" in d or "403" in d or "sign in" in d.lower():
            hint = "Apps Script ยังไม่เปิดสาธารณะ — Deploy ใหม่โดยตั้ง Who has access = Anyone"
        elif "HTTP Error 400" in d:
            hint = ("Apps Script ยังไม่มีฟังก์ชัน doPost — ต้องเอาโค้ด Analytics.gs ตัวใหม่ไปวาง "
                    "แล้ว Deploy > Manage deployments > New version")
        elif "500" in d:
            hint = "โค้ดใน Apps Script พัง — เปิด Apps Script > Executions ดู error"
        elif "timed out" in d.lower():
            hint = "Apps Script ตอบช้าเกินไป — ลองกดซ้ำอีกครั้ง"
        else:
            hint = "เช็ก Deploy > Manage deployments ว่าเป็น Web app / Anyone และกด New version แล้ว"
    return {"ok": bool(ok),
            "hook_len": len(hook),
            "hook_ok": hook.startswith("https://script.google.com/") and hook.endswith("/exec"),
            "hook_tail": hook[-14:] if hook else "",
            "detail": str(detail)[:400],
            "hint": hint,
            "msg": ("✅ เขียนลงชีตสำเร็จ — ไปดูแท็บ Events ได้เลย" if ok
                    else "❌ เขียนลงชีตไม่สำเร็จ")}


_AN_CACHE = {"t": 0.0, "data": None}


def _stats_from_sheet(days):
    """อ่านสถิติสะสมจาก Google Sheet (แหล่งจริง — ไม่หายตอน deploy)"""
    # ใช้ _sheet_hook() ตัวเดียวกับฝั่งเขียน (ล้าง space/tab/newline ที่ติดมาตอนวางใน Render)
    hook = _sheet_hook()
    if not hook:
        return None
    import time as _t
    if _AN_CACHE["data"] and (_t.time() - _AN_CACHE["t"]) < 60:
        return _AN_CACHE["data"]
    try:
        import urllib.request
        import urllib.parse
        u = hook + ("&" if "?" in hook else "?") + urllib.parse.urlencode(
            {"api": "stats", "days": int(days)})
        # User-Agent + timeout ยาวขึ้น (Apps Script cold start / ชีตแถวเยอะ อ่านช้าได้) + ตาม redirect googleusercontent
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 (VectorCNC-Stats)"})
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
        j = json.loads(body)
        if j.get("ok"):
            j["source"] = "sheet"
            _AN_CACHE["t"] = _t.time()
            _AN_CACHE["data"] = j
            return j
        print("[analytics] read: sheet ตอบแต่ ok=false ->", str(body)[:160], flush=True)
    except Exception as e:
        print("[analytics] read failed:", repr(e)[:200], flush=True)
    return None


@app.get("/api/stats")
def api_stats(request: Request, days: int = 30, fresh: int = 0):
    """สรุปสถิติสะสม — 🔒 แอดมินเท่านั้น
       fresh=1 = ไม่ใช้แคช (ปุ่ม ↻ รีเฟรช)"""
    if not (_is_internal(request) and _is_admin(request)):
        return JSONResponse(
            {"ok": False, "error": "forbidden",
             "msg": "สถิติการเข้าใช้งานเปิดให้เฉพาะผู้ดูแลระบบ"},
            status_code=403)
    if fresh:
        _AN_CACHE["data"] = None
        _AN_CACHE["t"] = 0.0
    j = _stats_from_sheet(days)
    if j:
        return j
    try:
        with _AN_LOCK:
            c = _an_conn()
            q = c.execute
            tot_acc = q("SELECT COUNT(DISTINCT account) FROM ev WHERE account<>''").fetchone()[0]
            tot_ses = q("SELECT COUNT(DISTINCT sid) FROM ev").fetchone()[0]
            tot_view = q("SELECT COUNT(*) FROM ev WHERE ev='visit'").fetchone()[0]
            today = datetime.now(TZ7).strftime("%Y-%m-%d")
            t_ses = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE day=?", (today,)).fetchone()[0]
            t_acc = q("SELECT COUNT(DISTINCT account) FROM ev WHERE day=? AND account<>''",
                      (today,)).fetchone()[0]
            # เวลาเฉลี่ยต่อเซสชัน (วินาที) — ใช้ dur สูงสุดที่รายงานมาต่อ sid
            rows = q("SELECT sid, MAX(dur) FROM ev GROUP BY sid HAVING MAX(dur)>0").fetchall()
            durs = [r[1] for r in rows]
            avg_dur = int(sum(durs) / len(durs)) if durs else 0
            tot_dur = int(sum(durs))
            since = (datetime.now(TZ7) - timedelta(days=max(1, int(days)))).strftime("%Y-%m-%d")
            daily = [{"day": r[0], "sessions": r[1], "accounts": r[2]} for r in q(
                "SELECT day, COUNT(DISTINCT sid), COUNT(DISTINCT account) FROM ev "
                "WHERE day>=? GROUP BY day ORDER BY day", (since,)).fetchall()]
            menus = [{"name": r[0], "n": r[1]} for r in q(
                "SELECT menu, COUNT(*) FROM ev WHERE ev='menu' AND menu<>'' "
                "GROUP BY menu ORDER BY 2 DESC LIMIT 15").fetchall()]
            refs = [{"name": r[0] or "(เข้าตรง / พิมพ์ URL)", "n": r[1]} for r in q(
                "SELECT refhost, COUNT(DISTINCT sid) FROM ev WHERE ev='visit' "
                "GROUP BY refhost ORDER BY 2 DESC LIMIT 12").fetchall()]
            devs = [{"name": r[0] or "?", "n": r[1]} for r in q(
                "SELECT device, COUNT(DISTINCT sid) FROM ev WHERE ev='visit' "
                "GROUP BY device ORDER BY 2 DESC").fetchall()]
            # 👤 ชื่อเล่น/ชื่อจริง: เอาค่าล่าสุดที่ไม่ว่างของแต่ละบัญชี (บางครั้งเข้ามาก่อนล็อกอิน)
            accs = [{"name": r[0], "sessions": r[1], "last": r[2], "sec": r[3] or 0,
                     "nick": r[4] or "", "fullname": r[5] or ""} for r in q(
                "SELECT account, COUNT(DISTINCT sid), MAX(ts), SUM(dur),"
                "       MAX(CASE WHEN IFNULL(nick,'')<>'' THEN nick END),"
                "       MAX(CASE WHEN IFNULL(fullname,'')<>'' THEN fullname END) FROM ev "
                "WHERE account<>'' GROUP BY account ORDER BY 2 DESC LIMIT 20").fetchall()]
            _who = {a["name"]: a for a in accs}
            recent = [{"ts": r[0], "account": r[1], "ev": r[2], "menu": r[3],
                       "ref": r[4], "device": r[5], "dur": r[6],
                       # ถ้าแถวนี้ยังไม่มีชื่อ ให้ยืมชื่อจากบัญชีเดียวกันที่เคยบันทึกไว้
                       "nick": (r[7] or (_who.get(r[1], {}) or {}).get("nick", "")),
                       "fullname": (r[8] or (_who.get(r[1], {}) or {}).get("fullname", ""))}
                      for r in q(
                "SELECT ts,account,ev,menu,refhost,device,dur,IFNULL(nick,''),IFNULL(fullname,'') FROM ev "
                "ORDER BY id DESC LIMIT 40").fetchall()]
            # 🛒 กรวยขาย: เข้าหน้าขาย -> เลื่อนดู -> กดทดลองใช้ (ตัวเลขที่พี่อยากเห็น)
            _land = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE page='landing' AND ev='visit'").fetchone()[0]
            _s50 = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE page='landing' AND menu='scroll_50'").fetchone()[0]
            _s100 = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE page='landing' AND menu='scroll_100'").fetchone()[0]
            _trial = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE ev='trial_click'").fetchone()[0]
            _trial_n = q("SELECT COUNT(*) FROM ev WHERE ev='trial_click'").fetchone()[0]
            _t_land = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE page='landing' AND ev='visit' AND day=?",
                        (today,)).fetchone()[0]
            _t_trial = q("SELECT COUNT(DISTINCT sid) FROM ev WHERE ev='trial_click' AND day=?",
                         (today,)).fetchone()[0]
            _lt = [{"ts": r[0], "menu": r[1], "ref": r[2], "device": r[3]} for r in q(
                "SELECT ts,menu,refhost,device FROM ev WHERE ev='trial_click' "
                "ORDER BY id DESC LIMIT 30").fetchall()]
            funnel = {"landing_visits": _land, "scroll_50": _s50, "scroll_100": _s100,
                      "trial_clicks_people": _trial, "trial_clicks_total": _trial_n,
                      "today_landing": _t_land, "today_trial": _t_trial,
                      "convert_pct": round(100.0 * _trial / _land, 1) if _land else 0.0,
                      "recent_trials": _lt}
            c.close()
        return {"ok": True, "source": "local", "persist": _AN_PERSIST, "db": _AN_DB,
                "funnel": funnel, "totals": {
                    "accounts": tot_acc, "sessions": tot_ses, "views": tot_view,
                    "avg_sec": avg_dur, "total_sec": tot_dur,
                    "today_sessions": t_ses, "today_accounts": t_acc},
                "daily": daily, "menus": menus, "refs": refs, "devices": devs,
                "accounts": accs, "recent": recent}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


def _rings_of_geom(g, bx, by, tol=0.0, min_area=1.0):
    """shapely -> [{ext:[[x,y]..], holes:[[...]]}] เลื่อนให้เริ่มที่ 0,0"""
    out = []
    if g is None or getattr(g, "is_empty", True):
        return out
    if tol > 0:
        try:
            g = g.simplify(tol, preserve_topology=True)
        except Exception:
            pass
    gs = list(g.geoms) if getattr(g, "geom_type", "") == "MultiPolygon" else [g]
    for p in gs:
        if getattr(p, "geom_type", "") != "Polygon" or p.is_empty or p.area < min_area:
            continue
        out.append({
            "ext": [[round(x - bx, 2), round(y - by, 2)] for x, y in p.exterior.coords],
            "holes": [[[round(x - bx, 2), round(y - by, 2)] for x, y in r.coords]
                      for r in p.interiors if abs(r.length) > 1.0],
        })
    return out


# ลำดับการวาด (หลัง -> หน้า) ของแต่ละชั้น
_Z_ORDER = {"แผ่นพื้น": 0, "ไส้": 1, "แผงกลาง": 1, "อะคริลิค": 2, "ซิ้งค์": 2, "คิ้ว": 3}


def _z_of(name):
    n = str(name)
    for k, v in _Z_ORDER.items():
        if k in n:
            return v
    return 2


@app.post("/api/geom3d")
async def api_geom3d(file: UploadFile = File(...),
                     real_width_mm: float = Form(600.0),
                     real_height_mm: float = Form(0.0),
                     n_colors: int = Form(6),
                     max_pts: int = Form(6000),
                     sign_type: str = Form(""),
                     trim_width_cm: float = Form(1.0),
                     trim_dir: str = Form("out")):
    """ส่ง 'รูปทรงจริง' (วงนอก+รูใน หน่วย มม.) ให้ frontend เรนเดอร์ 3 มิติแบบหมุนได้สด ๆ
       ถ้าระบุ sign_type (1-7) จะส่ง 'ชั้นโครงสร้าง' (คิ้ว / หน้า / แผ่นพื้น) มาด้วย
       -> จำลองผนังจะเห็นป้ายจริงตามแบบ (มีคิ้ว / ไม่มีคิ้ว / กล่องไฟ ฯลฯ)"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))

        # ---- ชั้นโครงสร้างตามแบบป้าย 1-9 (ถ้าเลือก)
        rec = SIGN_TYPES.get(str(sign_type)) if sign_type else None
        # 🆕 กล่องไฟล้อมตามทรง -> เชื่อมเป็นเงารวมก้อนเดียวก่อนสร้างโครง 3 มิติ
        if rec and rec.get("wrap"):
            full = _wrap_silhouette(full, float(rec.get("wrap_bridge_cm", 3.0)) * 10.0)
        # 🆕 กล่องไฟทรงเรขาคณิต (กลม/สี่เหลี่ยม/วงรี · type 10-15,18) -> ใช้ 'กล่องทึบ' เป็นรูปทรง (กันหน้าโบ๋ตอนทำ 3D)
        elif rec and rec.get("box_shape"):
            full = _geom_box_fit(full, rec["box_shape"], float(rec.get("box_pad_cm", 3.0)) * 10.0, float(real_width_mm))
        layers_out = []
        outer = full
        if rec:
            TRIMW = float(trim_width_cm) * 10.0 if float(trim_width_cm) > 0 else 0.0
            TOUT = (str(trim_dir or "out").lower() != "in")
            fb = full.bounds
            for L in rec["layers"]:
                off = float(L["off"])
                kind = L.get("kind", "solid")
                base = _mbuf(full, off)
                if base is None or base.is_empty:
                    continue
                if kind == "frame":
                    band = TRIMW if TRIMW > 0 else float(L.get("band", 10.0))
                    if TOUT:
                        o2 = _mbuf(full, off + band); i2 = base
                    else:
                        o2 = base; i2 = _mbuf(full, off - band)
                    g = o2 if (i2 is None or i2.is_empty) else o2.difference(i2)
                    if g.is_empty:
                        g = o2
                    if o2.area > outer.area:
                        outer = o2
                else:
                    g = base
                    if g.area > outer.area:
                        outer = g
                layers_out.append({"name": L["name"], "en": _en_layer(L["name"]),
                                   "kind": kind, "z": _z_of(L["name"]),
                                   "color": L.get("color", "#c9ced6"),
                                   "geom": g})
            layers_out.sort(key=lambda x: x["z"])

        b = outer.bounds
        W = b[2] - b[0]
        H = b[3] - b[1]
        tol0 = max(W, H) * 0.0008
        if layers_out:
            for L in layers_out:
                L["polys"] = _rings_of_geom(L.pop("geom"), b[0], b[1], tol=tol0 * 2.0)
            layers_out = [L for L in layers_out if L["polys"]]

        full = outer          # ผนังข้าง (extrusion) วิ่งตามชั้นนอกสุด
        polys = list(full.geoms) if getattr(full, "geom_type", "") == "MultiPolygon" else [full]

        def _cnt(gs):
            n = 0
            for p in gs:
                n += len(p.exterior.coords)
                for r in p.interiors:
                    n += len(r.coords)
            return n

        # ลดจุดจนพอไหวสำหรับเรนเดอร์สด (ภาพพรีวิวเท่านั้น — ไฟล์ตัดไม่เกี่ยว)
        tol = max(W, H) * 0.0008
        gs = polys
        for _ in range(8):
            if _cnt(gs) <= int(max_pts):
                break
            tol *= 1.6
            gs2 = []
            for p in polys:
                q = p.simplify(tol, preserve_topology=True)
                if q.geom_type == "Polygon" and not q.is_empty:
                    gs2.append(q)
                elif q.geom_type == "MultiPolygon":
                    gs2.extend([x for x in q.geoms if not x.is_empty])
            gs = gs2 or gs
        out = []
        for p in gs:
            if getattr(p, "geom_type", "") != "Polygon" or p.is_empty or p.area < 1.0:
                continue
            ext = [[round(x - b[0], 2), round(y - b[1], 2)] for x, y in p.exterior.coords]
            holes = []
            for r in p.interiors:
                if abs(r.length) < 1.0:
                    continue
                holes.append([[round(x - b[0], 2), round(y - b[1], 2)] for x, y in r.coords])
            out.append({"ext": ext, "holes": holes})
        if not out:
            return JSONResponse({"error": "ไม่พบรูปทรง"}, status_code=400)
        res = {"polys": out, "w_mm": round(W, 1), "h_mm": round(H, 1),
               "points": _cnt(gs)}
        if rec:
            res["layers"] = layers_out
            res["type_name"] = rec["name"]
            res["type_en"] = _en_type(rec["name"])
            res["depth_cm"] = rec.get("depth_cm", 5)
            res["has_trim"] = any(L.get("kind") == "frame" for L in layers_out)
        return res
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/perspective")
async def api_perspective(file: UploadFile = File(...),
                          real_width_mm: float = Form(600.0),
                          real_height_mm: float = Form(0.0),
                          return_cm: float = Form(5.0),
                          face_color: str = Form("#cfd4dc"),
                          side_color: str = Form(""),
                          bg: str = Form("#0f1319"),
                          label: str = Form(""),
                          n_colors: int = Form(6)):
    """ภาพ perspective จาก 'รูปทรงจริง' ของไฟล์งาน — ผนังข้างวิ่งตามรูปตัวอักษร (ไม่ใช่กล่องแปะรูป)"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import concept as CC
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        face = face_color or "#cfd4dc"
        side = side_color or _shade_hex(face, 0.72)
        svg = CC.perspective_svg(full, depth_mm=float(return_cm) * 10.0,
                                 face=face, side=side, bg=(bg or "#0f1319"),
                                 label=label, width_px=900)
        b = full.bounds
        return {"svg3d": svg, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                "depth_cm": float(return_cm)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/concept-3d")
async def concept_3d(request: Request):
    """ภาพ perspective ของคอนเซปต์ที่เลือก — เห็นขอบด้านข้างตามความหนายกขอบที่ user กำหนด"""
    d = await request.json()
    name = str(d.get("name", "")).strip()
    if not name:
        return JSONResponse({"error": "ยังไม่ได้ใส่ชื่อร้าน"}, status_code=400)
    sub = str(d.get("sub", "")).strip()
    style = str(d.get("style", "bold-modern"))
    layout = str(d.get("layout", "plain"))
    cap = float(d.get("cap_mm", 200) or 200)
    ret_cm = float(d.get("return_cm", 5) or 0)
    face = str(d.get("face_color", "") or "#cfd4dc")
    side = str(d.get("side_color", "") or "")
    bg = str(d.get("bg", "") or "#0f1319")
    label = str(d.get("label", "") or "")
    try:
        from vectorcnc import concept as CC
        cs = CC.generate(name, sub=sub, styles=[style], layouts=[layout], cap_mm=cap)
        if not cs:
            return JSONResponse({"error": "สร้างไม่สำเร็จ"}, status_code=400)
        g = cs[0]["geom"]
        if not side:
            side = _shade_hex(face, 0.72)      # สีข้าง = สีหน้าเข้มลง (ถ้าไม่ระบุ)
        svg = CC.perspective_svg(g, depth_mm=ret_cm * 10.0, face=face, side=side,
                                 bg=bg, label=label)
        b = g.bounds
        return {"svg3d": svg, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                "depth_cm": ret_cm, "font": cs[0]["font"]}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-600:]},
                            status_code=400)


def _shade_hex(hx, k):
    """ทำสีให้เข้ม/สว่างขึ้น k เท่า (ใช้ทำสีขอบข้างจากสีหน้า)"""
    try:
        h = str(hx).lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        f = lambda v: max(0, min(255, int(round(v * float(k)))))
        return "#%02x%02x%02x" % (f(r), f(g), f(b))
    except Exception:
        return "#98a0ac"


@app.post("/api/concept-use")
async def concept_use(request: Request):
    """เลือกคอนเซปต์ 1 อัน -> ได้ .ai + .svg (mm) เอาไปเข้าชุดชั้นตัด / Nesting ต่อได้ทันที"""
    d = await request.json()
    name = str(d.get("name", "")).strip()
    sub = str(d.get("sub", "")).strip()
    style = str(d.get("style", "bold-modern"))
    layout = str(d.get("layout", "plain"))
    cap = float(d.get("cap_mm", 200) or 200)
    fill = str(d.get("fill", "") or "#000000")
    try:
        from vectorcnc import concept as CC
        cs = CC.generate(name, sub=sub, styles=[style], layouts=[layout], cap_mm=cap)
        if not cs:
            return JSONResponse({"error": "สร้างไม่สำเร็จ"}, status_code=400)
        g = cs[0]["geom"]
        svg_mm = CC.concept_svg_mm(g, fill=fill)
        ai_b64 = ""
        try:
            import cairosvg
            ai_b64 = base64.b64encode(
                cairosvg.svg2pdf(bytestring=svg_mm.encode("utf-8"))).decode()
        except Exception:
            pass
        return {"svg_mm": svg_mm, "ai_base64": ai_b64,
                "w_mm": cs[0]["w_mm"], "h_mm": cs[0]["h_mm"], "font": cs[0]["font"]}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ══════════════════════════════════════════════════════════════════
#  💳 ระบบรับชำระเงิน — PayPal / บัตร / พร้อมเพย์ / E-Banking / โอนเงิน
# ══════════════════════════════════════════════════════════════════
#  โครง:  checkout -> ได้ ref + ทางไปจ่าย
#         จ่ายเสร็จ -> webhook (หรือแอดมินอนุมัติสลิป) -> activate ในชีต
#         ผู้ใช้ได้ token (HMAC) เก็บใน localStorage -> /api/whoami อ่านสิทธิ์จาก token
#
#  🔐 คีย์ทุกตัวอยู่ใน Render → Environment เท่านั้น
#     ช่องทางที่ยังไม่ตั้งคีย์ จะไม่ปรากฏให้ลูกค้าเห็น

def _billing_hook():
    return (os.environ.get("BILLING_WEBHOOK", "") or "").strip()


def _billing_key():
    return (os.environ.get("BILLING_KEY", "") or "").strip()


def _sheet_post(api: str, **kw):
    """ยิงคำสั่งไปที่ Apps Script (Billing.gs) — POST + JSON body"""
    hook = _billing_hook()
    if not hook:
        return {"ok": False, "error": "ยังไม่ได้ตั้ง BILLING_WEBHOOK"}
    import urllib.request
    body = dict(kw)
    body["api"] = api
    body["key"] = _billing_key()
    req = urllib.request.Request(hook, data=json.dumps(body).encode("utf-8"),
                                 method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _sheet_get(api: str, **kw):
    hook = _billing_hook()
    if not hook:
        return {"ok": False, "error": "ยังไม่ได้ตั้ง BILLING_WEBHOOK"}
    import urllib.request, urllib.parse
    q = dict(kw)
    q["api"] = api
    q["key"] = _billing_key()
    url = hook + ("&" if "?" in hook else "?") + urllib.parse.urlencode(q)
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _price_of(plan_key: str, currency: str = "THB"):
    from vectorcnc import billing as B
    P = B.PLANS.get(plan_key) or {}
    return P.get("price_usd", 0) if currency == "USD" else P.get("price_thb", 0)


def _base_url(request: Request):
    return os.environ.get("SITE_URL", "").rstrip("/") or str(request.base_url).rstrip("/")


# ---------------------------------------------------------------- ช่องทางที่เปิดใช้
@app.get("/api/pay-methods")
def api_pay_methods(lang: str = "th"):
    from vectorcnc import billing as B, payments as PY
    if not B.PAYMENTS_OPEN:
        return {"open": False, "methods": [],
                "msg": "ระบบชำระเงินกำลังจะเปิดเร็ว ๆ นี้"}
    return {"open": True,
            "methods": PY.available(lang),
            "omise_public_key": PY.omise_public_key()}   # คีย์ public เปิดเผยได้


# ---------------------------------------------------------------- เริ่มจ่าย
@app.post("/api/checkout")
async def api_checkout(request: Request):
    """สร้างคำสั่งซื้อ 1 รายการ -> คืนวิธีไปจ่ายตามช่องทางที่เลือก"""
    from vectorcnc import billing as B, payments as PY, auth as A

    if not B.PAYMENTS_OPEN:
        return JSONResponse({"error": "closed",
                             "msg": "ระบบชำระเงินยังไม่เปิด"}, status_code=403)

    d = await request.json()
    email = str(d.get("email", "")).strip().lower()
    plan = str(d.get("plan", "pro")).strip().lower()
    method = str(d.get("method", "")).strip().lower()

    if "@" not in email:
        return JSONResponse({"error": "อีเมลไม่ถูกต้อง"}, status_code=400)
    if plan not in ("pro", "studio"):
        return JSONResponse({"error": "แพ็กเกจไม่ถูกต้อง"}, status_code=400)

    ref = A.order_ref()
    base = _base_url(request)
    thb = _price_of(plan, "THB")
    usd = _price_of(plan, "USD")

    try:
        # ---- PayPal: subscription ตัดอัตโนมัติ
        if method == "paypal":
            r = PY.paypal_create_subscription(
                plan, email, ref,
                return_url=f"{base}/pay/done?ref={ref}",
                cancel_url=f"{base}/pay?cancel=1")
            _sheet_post("record_pay", ref=ref, email=email, plan=plan,
                        provider="paypal", amount=usd, currency="USD",
                        status="pending", charge_id=r["id"])
            return {"ref": ref, "kind": "redirect", "url": r["approve_url"]}

        # ---- บัตรเครดิต (Omise) — frontend ส่ง card token มาให้
        if method == "card":
            tok = str(d.get("card_token", "")).strip()
            if not tok:
                return JSONResponse({"error": "ไม่มี card token"}, status_code=400)
            cus = PY.omise_create_customer(email, tok)
            chg = PY.omise_charge_customer(cus.get("id", ""), thb, ref,
                                           f"VectorCNC {plan}")
            paid = (chg.get("status") == "successful")
            _sheet_post("record_pay", ref=ref, email=email, plan=plan,
                        provider="card", amount=thb, currency="THB",
                        status="paid" if paid else "failed",
                        charge_id=chg.get("id", ""))
            if not paid:
                return JSONResponse({"error": "ตัดบัตรไม่สำเร็จ",
                                     "detail": chg.get("failure_message", "")},
                                    status_code=402)
            # ตั้งตารางตัดเงินเดือนถัดไป
            try:
                sch = PY.omise_create_schedule(cus.get("id", ""), thb, ref)
            except Exception:
                sch = {}
            _sheet_post("activate", email=email, plan=plan, provider="card",
                        sub_id=sch.get("id", ""), customer_id=cus.get("id", ""),
                        amount=thb, currency="THB", days=30, ref=ref,
                        auto_renew=True)
            return {"ref": ref, "kind": "done",
                    "token": A.sign(email, plan, days=31)}

        # ---- พร้อมเพย์ (Thai QR)
        if method == "promptpay":
            r = PY.omise_promptpay(thb, ref)
            _sheet_post("record_pay", ref=ref, email=email, plan=plan,
                        provider="promptpay", amount=thb, currency="THB",
                        status="pending", charge_id=r["charge_id"])
            return {"ref": ref, "kind": "qr", "qr_url": r["qr_url"],
                    "charge_id": r["charge_id"], "amount": thb,
                    "expires_at": r.get("expires_at", "")}

        # ---- E-Banking
        if method == "ebanking":
            bank = str(d.get("bank", "")).strip()
            if not bank:
                return JSONResponse({"error": "ยังไม่ได้เลือกธนาคาร"}, status_code=400)
            r = PY.omise_internet_banking(bank, thb, ref,
                                          return_uri=f"{base}/pay/done?ref={ref}")
            _sheet_post("record_pay", ref=ref, email=email, plan=plan,
                        provider="ebanking", amount=thb, currency="THB",
                        status="pending", charge_id=r["charge_id"])
            return {"ref": ref, "kind": "redirect", "url": r["authorize_uri"]}

        # ---- โอนเงิน + สลิป
        if method == "transfer":
            _sheet_post("record_pay", ref=ref, email=email, plan=plan,
                        provider="transfer", amount=thb, currency="THB",
                        status="await_slip")
            return {"ref": ref, "kind": "transfer",
                    "bank": PY.bank_info(), "amount": thb,
                    "msg": f"โอนแล้วใส่เลขอ้างอิง {ref} ในหมายเหตุ แล้วอัปโหลดสลิป"}

        return JSONResponse({"error": "ไม่รู้จักช่องทาง: " + method}, status_code=400)

    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=400)


# ---------------------------------------------------------------- เช็กสถานะ QR
@app.get("/api/pay-status")
def api_pay_status(ref: str = "", charge_id: str = "", email: str = "",
                   plan: str = "pro"):
    """หน้า QR เรียกซ้ำทุก 3 วิ จนกว่าจะ successful"""
    from vectorcnc import payments as PY, auth as A
    if not charge_id:
        return {"status": "unknown"}
    try:
        c = PY.omise_get_charge(charge_id)
        st = c.get("status", "")
        if st == "successful":
            _sheet_post("activate", email=email, plan=plan, provider="promptpay",
                        amount=(c.get("amount", 0) / 100.0), currency="THB",
                        days=30, ref=ref, auto_renew=False)
            return {"status": "successful", "token": A.sign(email, plan, days=31)}
        return {"status": st}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ---------------------------------------------------------------- อัปโหลดสลิป
@app.post("/api/slip")
async def api_slip(ref: str = Form(...), email: str = Form(...),
                   plan: str = Form("pro"), file: UploadFile = File(...)):
    """ลูกค้าอัปโหลดสลิป -> เก็บ base64 ลงชีต -> รอแอดมินกดอนุมัติ"""
    raw = await file.read()
    if len(raw) > 4 * 1024 * 1024:
        return JSONResponse({"error": "ไฟล์ใหญ่เกิน 4 MB"}, status_code=400)

    # ย่อรูปก่อนเก็บ (ชีตมีลิมิตช่องละ 50,000 ตัวอักษร)
    try:
        from PIL import Image
        import io
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        im.thumbnail((720, 720))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=62)
        raw = buf.getvalue()
    except Exception:
        pass

    b64 = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    if len(b64) > 48000:
        b64 = ""          # ใหญ่เกิน -> ไม่เก็บรูป แต่ยังบันทึกรายการไว้

    r = _sheet_post("record_pay", ref=ref, email=email.strip().lower(), plan=plan,
                    provider="transfer", amount=_price_of(plan, "THB"),
                    currency="THB", status="pending", slip_url=b64,
                    note="รอตรวจสลิป")
    if not r.get("ok"):
        return JSONResponse({"error": r.get("error", "บันทึกไม่สำเร็จ")}, status_code=400)
    return {"ok": True, "ref": ref,
            "msg": "ได้รับสลิปแล้ว แอดมินจะตรวจสอบและเปิดสิทธิ์ให้ภายใน 24 ชั่วโมง"}


# ---------------------------------------------------------------- Webhook
@app.post("/api/webhook/paypal")
async def wh_paypal(request: Request):
    from vectorcnc import payments as PY
    raw = (await request.body()).decode("utf-8", "ignore")

    # ⚠️ ห้ามเชื่อ body ลอย ๆ — ต้องให้ PayPal ยืนยันลายเซ็นก่อน
    if not PY.paypal_verify_webhook(dict(request.headers), raw):
        return JSONResponse({"error": "signature invalid"}, status_code=400)

    try:
        ev = json.loads(raw or "{}")
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)

    et = ev.get("event_type", "")
    res = ev.get("resource", {}) or {}
    ref = res.get("custom_id", "") or ""
    email = ((res.get("subscriber") or {}).get("email_address", "") or "").lower()

    if et in ("BILLING.SUBSCRIPTION.ACTIVATED", "PAYMENT.SALE.COMPLETED"):
        plan = "pro"
        pid = res.get("plan_id", "")
        if pid and pid == PY.paypal_plan_id("studio"):
            plan = "studio"
        _sheet_post("activate", email=email, plan=plan, provider="paypal",
                    sub_id=res.get("id", ""), amount=_price_of(plan, "USD"),
                    currency="USD", days=31, ref=ref, auto_renew=True)

    elif et in ("BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED",
                "BILLING.SUBSCRIPTION.SUSPENDED"):
        _sheet_post("cancel", email=email)

    return {"ok": True}


@app.post("/api/webhook/omise")
async def wh_omise(request: Request):
    """Omise ส่ง event มา -> เราไปถามสถานะจริงจาก API อีกที (กันของปลอม)"""
    from vectorcnc import payments as PY
    try:
        ev = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)

    if ev.get("key") not in ("charge.complete", "charge.create"):
        return {"ok": True, "skipped": ev.get("key", "")}

    cid = (ev.get("data") or {}).get("id", "")
    if not cid:
        return {"ok": True}

    try:
        c = PY.omise_get_charge(cid)          # ← ยืนยันกับ Omise เอง
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    if c.get("status") != "successful":
        return {"ok": True, "status": c.get("status", "")}

    meta = c.get("metadata") or {}
    ref = meta.get("ref", "")
    _sheet_post("record_pay", ref=ref, provider="omise",
                amount=(c.get("amount", 0) / 100.0), currency="THB",
                status="paid", charge_id=cid)
    return {"ok": True}


# ---------------------------------------------------------------- แอดมิน: สลิปรออนุมัติ
@app.get("/api/admin/payments")
def admin_payments(request: Request):
    if not (_is_internal(request) and _is_admin(request)):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    from vectorcnc import payments as PY
    return {"pending": _sheet_get("pending").get("items", []),
            "recent": _sheet_get("payments").get("items", [])[:60],
            "providers": PY.status()}


@app.post("/api/admin/approve")
async def admin_approve(request: Request):
    if not (_is_internal(request) and _is_admin(request)):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    d = await request.json()
    ref = str(d.get("ref", ""))
    if str(d.get("action", "approve")) == "reject":
        return _sheet_post("reject_slip", ref=ref, by="admin",
                           reason=str(d.get("reason", "สลิปไม่ถูกต้อง")))
    return _sheet_post("approve_slip", ref=ref, by="admin",
                       days=int(d.get("days", 30)))


# ---------------------------------------------------------------- หน้าเว็บ
@app.get("/pay")
def pay_page():
    if not _sell_mode():
        return JSONResponse({"error": "not_open",
                             "msg": "ยังไม่เปิดขาย"}, status_code=404)
    p = os.path.join(os.path.dirname(FRONTEND), "checkout.html")
    if os.path.exists(p):
        return FileResponse(p)
    return JSONResponse({"error": "checkout.html not found"}, status_code=404)


@app.get("/pay/done", response_class=HTMLResponse)
def pay_done(ref: str = ""):
    return f"""<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ชำระเงินสำเร็จ · VectorCNC</title>
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;600;800&display=swap" rel="stylesheet">
<style>body{{font-family:Prompt,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;
background:#f8fafc;color:#0f172a;text-align:center}}
.c{{background:#fff;padding:44px 40px;border-radius:18px;box-shadow:0 4px 24px rgba(0,0,0,.06);max-width:420px}}
h1{{font-size:24px;margin:14px 0 8px}} p{{color:#64748b;margin:0 0 22px;line-height:1.6}}
a{{display:inline-block;background:#0d9488;color:#fff;text-decoration:none;font-weight:700;
padding:12px 26px;border-radius:10px}} code{{background:#f1f5f9;padding:2px 8px;border-radius:6px}}</style>
</head><body><div class="c">
<div style="font-size:52px">✅</div>
<h1>ชำระเงินสำเร็จ</h1>
<p>เลขอ้างอิง <code>{ref}</code><br>
ระบบเปิดสิทธิ์ให้เรียบร้อยแล้ว<br>
<span style="font-size:13px">Payment complete — your plan is now active.</span></p>
<a href="/">เข้าใช้งาน / Launch app</a>
</div></body></html>"""


@app.get("/admin/payments")
def admin_pay_page():
    p = os.path.join(os.path.dirname(FRONTEND), "admin_payments.html")
    if os.path.exists(p):
        return FileResponse(p)
    return JSONResponse({"error": "admin_payments.html not found"}, status_code=404)


# ══════════════════════════════════════════════════════════════════
#  📄 "กาว" ปิดงานเซลล์คนเดียว — ใบเสนอราคา + ซองงานเข้าโรงงาน
# ══════════════════════════════════════════════════════════════════
@app.post("/api/quote")
async def api_quote(request: Request):
    """ใบเสนอราคา + ยืนยันแบบ (HTML A4 พร้อมพิมพ์เป็น PDF) — ประกอบจากข้อมูลที่เซลล์กรอกแล้ว"""
    try:
        job = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    from vectorcnc import job_packet as JP
    if not job.get("job_no"):
        job["job_no"] = JP.gen_job_no()
    html_str = JP.quote_html(job)
    return {"ok": True, "job_no": job["job_no"],
            "html_base64": base64.b64encode(html_str.encode("utf-8")).decode(),
            "filename": "ใบเสนอราคา_" + JP._safe(job.get("customer", "")) + ".html"}


@app.post("/api/job-packet")
async def api_job_packet(request: Request):
    """ซองงานเข้าโรงงาน (.zip) — รวมไฟล์ตัด/พิมพ์/BOM/สเปค/ใบปะหน้า ในชุดเดียว"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    from vectorcnc import job_packet as JP
    job = body.get("job") or {}
    files = body.get("files") or {}
    if not job.get("job_no"):
        job["job_no"] = JP.gen_job_no()
    try:
        zip_bytes, fname, manifest = JP.packet_zip(job, files)
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-500:]},
                            status_code=400)
    return {"ok": True, "job_no": job["job_no"], "filename": fname,
            "manifest": manifest,
            "zip_base64": base64.b64encode(zip_bytes).decode()}
