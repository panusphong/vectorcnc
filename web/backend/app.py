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
            "build": "2026-07-20-led-along-letter-contour+row-bars+holes-on-letters-at-bar+stroke-width",
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
    "1": {"name": "ไฟออกหน้า มีคิ้ว", "depth_cm": 5.0,
          "layers": [{"name": "คิ้วหน้า", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "อะคริลิคตู้ไฟ", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}, {"name": "ยกขอบใน", "h": 2.0}]},
    "2": {"name": "ไฟออกหน้า ไม่มีคิ้ว", "depth_cm": 5.0,
          "layers": [{"name": "หน้าอะคริลิค", "off": 1.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "ไส้อะคริลิคใส", "off": -1.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 0.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "3": {"name": "ตัวอักษรไฟออกรอบ", "depth_cm": 7.0, "edge_lit": True, "glow_color": "#eaf2ff",
          "layers": [{"name": "หน้าอะคริลิค", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบใน", "h": 2.0}, {"name": "ยกขอบอะคริลิค", "h": 7.0}]},
    "4": {"name": "กล่องไฟฉลุหน้า", "depth_cm": 5.0,
          "layers": [{"name": "คิ้ว", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "หน้าฉลุตัวอักษร", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}, {"name": "ยกขอบใน", "h": 2.0}]},
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
                     {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                     {"name": "แผ่นพื้นตามทรง", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบตามทรง", "h": 5.0}]},
    "9": {"name": "กล่องไฟล้อมตามทรง 2 หน้า", "depth_cm": 10.0, "wrap": True, "wrap_bridge_cm": 4.5,
          "face_finish": "print", "face_material": "acrylic_P433",
          "layers": [{"name": "คิ้วล้อมทรง", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
          "walls": [{"name": "ยกขอบตามทรง", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    # 🆕 กล่องไฟทรงเรขาคณิต — หน้าเป็นรูปทรง กลม/สี่เหลี่ยม/วงรี (ไม่ล้อมทรงงาน) หน้าจบด้วยงานพิมพ์ UV
    #    box_shape: circle | rect | oval · box_pad_cm = ระยะเผื่อรอบงานถึงขอบกล่อง
    "10": {"name": "กล่องไฟทรงกลม 1 หน้า", "depth_cm": 5.0, "box_shape": "circle", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วทรงกลม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "11": {"name": "กล่องไฟทรงกลม 2 หน้า", "depth_cm": 10.0, "box_shape": "circle", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วทรงกลม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
           "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    "12": {"name": "กล่องไฟสี่เหลี่ยม 1 หน้า", "depth_cm": 5.0, "box_shape": "rect", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วสี่เหลี่ยม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "13": {"name": "กล่องไฟสี่เหลี่ยม 2 หน้า", "depth_cm": 10.0, "box_shape": "rect", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้วสี่เหลี่ยม", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
           "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    "14": {"name": "กล่องไฟวงรี 1 หน้า", "depth_cm": 5.0, "box_shape": "oval", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้ววงรี", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)},
                      {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
           "walls": [{"name": "ยกขอบ", "h": 5.0}]},
    "15": {"name": "กล่องไฟวงรี 2 หน้า", "depth_cm": 10.0, "box_shape": "oval", "box_pad_cm": 3.0,
           "face_finish": "print", "face_material": "acrylic_P433",
           "layers": [{"name": "คิ้ววงรี", "off": 0.0, "kind": "frame", "band": 8.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                      {"name": "หน้าอะคริลิคขาว P433 (พิมพ์)", "off": -0.3, "kind": "solid", "finish": "print", "color": "#e5e7eb", "rgb": (229, 231, 235)}],
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


def _geom_box_fit(full, shape, pad_mm, target_w_mm):
    """สร้างกล่องทรงเรขาคณิต แล้วสเกลให้ 'ความกว้างกล่อง' = ค่าที่ผู้ใช้กำหนด (ไม่ใช่ขนาด artwork)"""
    g = _geom_box(full, shape, pad_mm)
    try:
        bb = g.bounds; cw = bb[2] - bb[0]
        if cw > 1.0 and float(target_w_mm) > 1.0 and abs(cw - float(target_w_mm)) > 1.0:
            from shapely import affinity as _aff
            s = float(target_w_mm) / cw
            g = _aff.scale(g, xfact=s, yfact=s, origin=(bb[0], bb[1]))
    except Exception:
        pass
    return g


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
    "ไฟออกหน้า มีคิ้ว": "Front-lit · with Trim (Kim)",
    "ไฟออกหน้า ไม่มีคิ้ว": "Front-lit · no Trim",
    "ตัวอักษรไฟออกรอบ": "Edge-lit Letters (light all around)",
    "กล่องไฟฉลุหน้า": "Light Box · Cut-out Face",
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


def _letter_full_mm(inp, real_width_mm, real_height_mm, n_colors):
    """คืน shapely polygon 'รูปเงาตัวอักษร/โลโก้' (รวมรูใน) ที่ขนาดจริง มม. (Y ลง)"""
    from shapely.ops import unary_union
    from shapely.affinity import scale as _scale
    from vectorcnc import trace_engine, vector_import
    if vector_import.is_vector_file(inp):
        pcs = vector_import.full_pieces_mm(inp, real_width_mm)
        pcs = [pc for pc in pcs if pc["poly"].area > 4.0]
        if not pcs:
            raise ValueError("อ่านเวกเตอร์ไม่ได้")
        full = unary_union([pc["poly"] for pc in pcs])
    else:
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
    return full


def _mbuf(geom, d):
    """offset เส้นแบบ 'มุมฉาก' (mitre) — ไม่ปัดมุมมน · ลดจุดบนโค้ง (resolution ต่ำ) เพื่อเครื่องดัดไม่กรีดถี่"""
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
    from PIL import Image
    import io as _io, base64 as _b64, numpy as _np
    im = Image.open(path).convert("RGBA")
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
    return "data:image/png;base64," + _b64.b64encode(buf.getvalue()).decode()


def _iso3d_svg(full, rec, perimeter_cm, inner_bore=None, face_color=None, side_color=None, art_href="",
               mount="none", arm_len_cm=30.0, plate_cm=10.0, arm_side="right",
               arm_adjust="fixed", arm_travel_cm=0.0, arm_edge_cm=20.0):
    """ภาพ 3 มิติ (extrude oblique) — เห็นผนังข้าง(ยกขอบ)ตั้งฉากแผ่นหลัง + คิ้วเจาะโบ๋โชว์ช่อง + เส้นบอกมิติ สูง/กว้าง/ลึก
       art_href: ถ้าใส่ data URI ของรูปงาน -> แปะรูปพิมพ์จริงบน 'หน้า' (กล่องไฟล้อมทรง = จบด้วยงานพิมพ์)
       mount: none / top2 (แขนยื่นลงจากบน 2) / side1 / side2 (แขนยื่นจากข้าง) · เหล็กกล่อง 1 นิ้ว + เพลท plate_cm"""
    import math

    def _esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
    b = full.bounds; W = b[2] - b[0]; H = b[3] - b[1]; S = max(W, H, 1.0)
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
    if _mount in ("top2", "letterframe"):
        padT += _armpad
    elif _mount in ("side1", "side2"):        # แขนแนวนอน ซ้าย/ขวาของภาพ
        if _aside == "left":
            padL += _armpad
        else:
            padR += _armpad
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
    if _edgelit:                                       # 💡 แสงฟุ้งรอบทั้งกล่อง (ไฟออกทุกด้าน) — วาดไว้ 'หลังสุด'
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
                parts.append('<path class="w3d-side" d="M %.2f %.2f L %.2f %.2f L %.2f %.2f L %.2f %.2f Z" fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                             % (Af[0], Af[1], Bf[0], Bf[1], Bb[0], Bb[1], Ab[0], Ab[1], wallFill, edge, lw))
    if art_href:                                       # 🖨️ กล่องไฟหน้าพิมพ์: คิ้ว 1cm รอบตัว + artwork หดเข้า >1cm
        _notrim = bool(rec.get("no_trim") or _edgelit)  # ไม่มีคิ้ว -> หน้าพิมพ์เต็ม ไม่มีขอบคิ้วเทา
        _KIM = 0.0 if _notrim else 10.0
        _ARTIN = max(2.0, S * 0.004) if _notrim else 14.0   # ไม่มีคิ้ว = พิมพ์เกือบเต็มหน้า (ไม่เว้นกรอบขาว)
        kimFill = "#fffdf5" if _notrim else "#a9b4c4"   # ไม่มีคิ้ว = หน้าอะคริลิคขาวเรืองแสงเต็มหน้า
        try:
            _ik = full.buffer(-_KIM) if _KIM > 0 else full
            _ia = full.buffer(-_ARTIN)
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
            _x0 = _cx - _bw / 2.0; _y0 = _cy - _bh / 2.0
            _ix, _iy = F((_x0, _y0))
            parts.append('<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" '
                         'preserveAspectRatio="xMidYMid meet" clip-path="url(#w3dArt)"/>'
                         % (art_href, art_href, _ix, _iy, _bw, _bh))
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), edge, lw))
    else:
        for pg in polys:                               # หน้าปกติ (ไม่มีรูปพิมพ์)
            parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), faceFill, edge, lw))
    if inner_bore is not None and not inner_bore.is_empty:   # คิ้วเจาะโบ๋ = ช่องจม
        ip = list(inner_bore.geoms) if inner_bore.geom_type == "MultiPolygon" else [inner_bore]
        for pg in ip:
            if pg.geom_type == "Polygon" and not pg.is_empty:
                parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (faced(pg, F), boreFill, edge, lw * 0.8))
    if _edgelit:                                       # 💡 ไฟออกรอบ: เส้นขอบกล่องบางๆ (ไม่มีคิ้ว/ไม่มีกรอบในหน้า) — แสงฟุ้งอยู่ 'ด้านนอก' (ฮาโลหลังสุด)
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="#e6c672" stroke-width="%.2f" stroke-linejoin="round" opacity="0.55"/>' % (faced(pg, F), max(1.0, S * 0.004)))
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
    # 🦾 แขนยึด + เพลท 10cm (เหล็กกล่อง 1 นิ้ว) — วาดในระนาบภาพ ให้เห็นชัดว่าติดตั้งยังไง
    arm_parts = []
    if _mount in ("top2", "side1", "side2", "letterframe"):
        tw = 25.0
        steel = "#8b93a0"; steelD = "#5b626d"; plateC = "#c6ccd6"; bolt = "#5b626d"; surf = "#cbd5e1"

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
            for fx in _fxs:
                _ax = b[0] + W * fx; _ty = b[1]
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
        else:                                  # side1/side2 — แขนแนวนอน "ทางซ้าย/ขวาของภาพ" (คู่ขนาน)
            _avx = (-_aL) if _aside == "left" else _aL
            _ex = b[0] if _aside == "left" else b[2]
            if _mount == "side1":
                atts = [F((_ex, midY))]
            else:                              # side2 = แขนคู่ ขนานกัน (บน + ล่าง) ยื่นออกด้านข้าง
                atts = [F((_ex, b[1] + H * 0.30)), F((_ex, b[1] + H * 0.70))]
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


def _front_sign_svg(full, rec, inner_bore=None, face_color=None, art_href="", frame_top_cm=0.0):
    """ภาพป้าย 'หน้าตรง' แบบ 3 มิติเบา ๆ (เงานุ่ม + คิ้ว/งานพิมพ์) พื้นโปร่ง — เอาไปวางบนผนังได้เลย
       frame_top_cm > 0 = วาด 'โครงเหล็กแขวน' (คานเพดาน + แขน 2 ข้าง) เหนือป้าย (เฉพาะป้ายมีโครง)"""
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
    parts = ['<defs><filter id="fsh" x="-30%%" y="-30%%" width="160%%" height="160%%">'
             '<feDropShadow dx="0" dy="%.1f" stdDeviation="%.1f" flood-color="#0f172a" flood-opacity="0.32"/></filter></defs>'
             % (S * 0.022, S * 0.02)]
    if ftop > 0:                                       # 🔩 โครงเหล็กแขวน (หน้าตรง) — คานเพดาน + แขน 2 ข้าง (หลังป้าย)
        tw = max(8.0, S * 0.018); steel = "#8b93a0"; steelD = "#5b626d"; surf = "#cbd5e1"; plateC = "#c6ccd6"
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
            x0 = cx - bw / 2.0 - b[0] + pad; y0 = cy - bh / 2.0 - b[1] + pad
            parts.append('<image href="%s" xlink:href="%s" x="%.2f" y="%.2f" width="%.2f" height="%.2f" '
                         'preserveAspectRatio="xMidYMid meet" clip-path="url(#fArt)"/>'
                         % (art_href, art_href, x0, y0, bw, bh))
        for pg in polys:
            parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.2f"/>' % (d(pg), edge, lw))
    else:                                              # หน้าตัน (ตัวอักษร/ไม่พิมพ์) + คิ้วเจาะโบ๋
        for pg in polys:
            parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), faceFill, edge, lw))
        if inner_bore is not None and not inner_bore.is_empty:
            for pg in P(inner_bore):
                parts.append('<path d="%s" fill="#eef1f5" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (d(pg), edge, lw * 0.8))
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


def _neon_sign_svg(neon_full, acrylic, color="#00e5ff", neon_subs=None):
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


def _layerset_ai_svg(out_layers, art_href="", art_bounds=None):
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
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s">%s</text>' % (cursor, topPad - fs * 0.6, fs * 0.9, L["color"], lyname))
        parts.append('<g id="CUT_%s" inkscape:groupmode="layer" inkscape:label="%s" fill="%s" fill-opacity="0.14" stroke="%s" stroke-width="%.2f" stroke-linejoin="round">'
                     % (_dxf_layer(lyname), lyname, L["color"], L["color"], lw))
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
                    led_pitch_cm: float = Form(6.0), arm_edge_cm: float = Form(20.0)):
    """ออก 'ชุดชั้นตัด' อัตโนมัติตามแบบป้าย 1-7 — ขยาย/หดเส้นต่อชั้นตามค่าเผื่อ แยก layer/สี ตามวัสดุ
       return_depth_cm > 0 = กำหนดความหนายกขอบ (ความลึกตัว) เอง เช่น 2.5/5/7.5/10 หรือ 3"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
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
        # 🆕 กล่องไฟล้อมตามทรง: เชื่อมเป็นเงารวมก้อนเดียวก่อน (ทุกชั้นล้อมทรงเดียวกัน)
        if rec.get("wrap"):
            full = _wrap_silhouette(full, float(rec.get("wrap_bridge_cm", 3.0)) * 10.0)
        # 🆕 กล่องไฟทรงเรขาคณิต: แทนเงางานด้วยรูปทรง กลม/สี่เหลี่ยม/วงรี (ครอบงาน)
        elif rec.get("box_shape"):
            full = _geom_box_fit(full, rec["box_shape"], float(rec.get("box_pad_cm", 3.0)) * 10.0, float(real_width_mm))
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
        out_layers = []
        warns = []
        for L in ([] if _neon else rec["layers"]):
            off = float(L["off"]); kind = L.get("kind", "solid")
            base = _mbuf(full, off)                 # ชั้นตามค่าเผื่อ (มุมฉาก)
            if base is None or base.is_empty:
                continue
            if kind == "frame":
                band = TRIMW if TRIMW > 0 else float(L.get("band", 10.0))
                if TRIM_OUT:
                    o2 = _mbuf(full, off + band)    # ขอบนอกคิ้ว = ตัวต้น + ความหนาคิ้ว
                    i2 = base                        # ช่องกลาง = ตัวต้น (โชว์อะคริลิค) · รูใน(ไส้)จัดการโดย difference
                else:
                    o2 = base
                    i2 = _mbuf(full, off - band)
                g = o2 if (i2 is None or i2.is_empty) else o2.difference(i2)
                if g.is_empty:
                    g = o2
                if bore_geom is None:
                    bore_geom = i2; frame_outer = o2
            else:
                g = base
            # ⚠️ ชั้นที่หดเข้า (เช่น อะคริลิค −0.25 ซม.) จะทำให้ลายเส้นบางแตกเป็นเศษ -> เก็บกวาดทิ้ง
            junk = 0
            if off < -0.01:
                g, junk = _clean_layer(g)
            if g is None or g.is_empty:
                continue
            subs = _poly_to_subs(g, tol=0.04)       # ฟิต v2: จุดน้อย + เนียนคม (แก้บั๊กสูตร Bézier)
            if not subs:
                continue
            b = g.bounds
            out_layers.append({"name": L["name"], "off": off, "kind": kind, "color": L["color"], "rgb": L["rgb"],
                               "subs": subs, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1),
                               "junk": junk})
            if junk:
                warns.append("%s: ลบเศษที่แตกจากการหดเส้น %d ชิ้น (ลายเส้นบางเกินไป)"
                             % (_en_layer(L["name"]), junk))
        _neon_subs = None
        if _neon:                                   # 🌈 นีออน: เส้นไฟ (ตามลายเส้นภาพ) + แผ่นอะคริลิคใส (ล้อมทรง)
            if str(neon_line).lower() == "single":  # เส้นเดี่ยว = แกนกลาง (skeleton)
                try:
                    _neon_subs = _skeleton_subs(inp, full)
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
                _as = _poly_to_subs(_acrylic, tol=0.08)
                if _as:
                    _ab = _acrylic.bounds
                    out_layers.append({"name": "อะคริลิคใสรองหลัง 8mm", "off": 30.0, "kind": "solid",
                                       "color": "#93c5fd", "rgb": (147, 197, 253),
                                       "subs": _as, "w_mm": round(_ab[2] - _ab[0], 1), "h_mm": round(_ab[3] - _ab[1], 1)})
        if not out_layers:
            return JSONResponse({"error": "สร้างชั้นตัดไม่สำเร็จ"}, status_code=400)
        # 🖨️ กล่องไฟล้อมตามทรง: หน้า = อะคริลิคขาว P433 ตัดเป็นแผ่นเต็มตามทรง แล้วจบด้วยงานพิมพ์
        if rec.get("face_finish") == "print":
            warns.append("หน้าอะคริลิคขาว P433 = ตัดเป็นแผ่นเต็มตามทรงชิ้นเดียว "
                         "แล้วจบด้วยงานพิมพ์ UV / ติดสติกเกอร์ — ไม่ตัดเส้นตัวอักษรข้างใน")
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
            _art = ""
            if rec.get("face_finish") == "print":       # กล่องไฟล้อมทรง = จบด้วยงานพิมพ์ -> โชว์รูปจริงบนหน้า
                try: _art = _art_data_uri(inp)
                except Exception: _art = ""
            # 🖨️ หน้าพิมพ์ (face_finish=print) = แผ่นเต็มพิมพ์รูป -> ไม่มีคิ้วเจาะโบ๋มาทับรูป
            _bore = None if rec.get("face_finish") == "print" else bore_geom
            if _neon:                                   # 🌈 นีออน: เส้นไฟเรือง + อะคริลิคใส (แทนภาพ 3 มิติปกติ)
                svg3d = _neon_sign_svg(_neon_full, _acrylic, color=str(neon_color or "#00e5ff"), neon_subs=_neon_subs)
            else:
                # ป้ายอักษร + โครงแขวน -> ใช้ 'โครงยึดตัวอักษร' (เฟรมหลังอักษร + แขนขึ้น) ไม่ใช่แขนกล่องไฟ
                _m3d = "letterframe" if rec.get("mount_frame") else str(arm or "none")
                svg3d = _iso3d_svg(body3d, rec, perimeter, inner_bore=_bore,
                                   face_color=(face_color or None), side_color=(side_color or None),
                                   art_href=_art, mount=_m3d, arm_len_cm=float(arm_len_cm),
                                   plate_cm=10.0, arm_side=str(arm_side or "right"),
                                   arm_adjust=str(arm_adjust or "fixed"), arm_travel_cm=float(arm_travel_cm),
                                   arm_edge_cm=float(arm_edge_cm))
        except Exception:
            svg3d = ""
        # 🔩 ไฟล์ตัดเพลทยึด 10cm (เจาะ 4 รู) — ส่งเข้าเลเซอร์/CNC ทำเพลทจริง
        mount_plate = {}
        if str(arm or "none").lower() in ("top2", "side1", "side2"):
            try:
                mount_plate = _mount_plate_files(10.0, str(arm))
            except Exception:
                mount_plate = {}

        # DXF: แยกแต่ละชั้น 'วางห่างกัน' แนวนอน (ไม่ทับซ้อน) + คนละ layer/สี + ป้ายชื่อชั้น
        import ezdxf

        def _bbox_subs(subs):
            mnx = mny = 1e18; mxx = mxy = -1e18
            for sp in subs:
                pts = [sp["start"]]
                for s in sp["segs"]:
                    pts.append(s[1]) if s[0] == "L" else pts.extend([s[1], s[2], s[3]])
                for (x, y) in pts:
                    mnx = min(mnx, x); mny = min(mny, y); mxx = max(mxx, x); mxy = max(mxy, y)
            return mnx, mny, mxx, mxy

        doc = ezdxf.new('R2010'); doc.units = ezdxf.units.MM; msp = doc.modelspace()
        if 'LABEL' not in doc.layers:
            doc.layers.add('LABEL')
        metas = [(L, _bbox_subs(L["subs"])) for L in out_layers]
        Smax = max([1.0] + [max(b[2] - b[0], b[3] - b[1]) for _, b in metas])
        gap = Smax * 0.16
        gmaxy = max(b[3] for _, b in metas)      # baseline ร่วม (flip Y = CAD Y ขึ้น)
        th = max(6.0, Smax * 0.03)
        cursor = 0.0
        for L, b in metas:
            w = b[2] - b[0]; h = b[3] - b[1]
            xshift = cursor - b[0]

            def _tf(p, _xs=xshift, _my=gmaxy):
                return (p[0] + _xs, _my - p[1])
            lyname = _dxf_layer('CUT_' + _en_layer(L["name"]))
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                try: lay.rgb = L["rgb"]
                except Exception: pass
            for sp in L["subs"]:
                try:
                    nesting._add_contour_dxf(msp, sp, lyname, tf=_tf)
                except Exception:
                    pass
            off = L["off"]; oc = "full" if abs(off) < 1e-6 else ("%+.2f cm" % (off / 10.0))
            try:
                t = msp.add_text("%s (%s)" % (_en_layer(L["name"]), oc), dxfattribs={'layer': 'LABEL', 'height': th})
                t.set_placement((cursor, gmaxy - b[1] + th * 0.6))
            except Exception:
                pass
            cursor += w + gap
        # ชิ้นตัด 'ยกขอบ' (ผนังตั้งฉากแผ่นหลัง) = แถบแบน ยาว=เส้นรอบรูป × สูง=ความสูงผนัง (ตัดแล้วพับ/ดัด)
        wall_pieces = []
        peri_mm = float(full.length)
        for w in rec.get("walls", []):
            nm = str(w.get("name", "")); hh = float(w.get("h", 0)) * 10.0
            if hh <= 0 or not nm.startswith("ยกขอบ"):
                continue
            Lmm = peri_mm
            ly = 'WALL_' + _en_wall(nm).replace(" ", "_")
            if ly not in doc.layers:
                lay = doc.layers.add(ly)
                try: lay.rgb = (245, 158, 11)
                except Exception: pass
            msp.add_lwpolyline([(cursor, 0), (cursor + Lmm, 0), (cursor + Lmm, hh), (cursor, hh)],
                               close=True, dxfattribs={'layer': ly})
            try:
                t = msp.add_text("%s (fold) L %.0f x H %.0f mm" % (_en_wall(nm), Lmm, hh), dxfattribs={'layer': 'LABEL', 'height': th})
                t.set_placement((cursor, hh + th * 0.6))
            except Exception:
                pass
            wall_pieces.append({"name": nm, "name_en": _en_wall(nm), "length_cm": round(Lmm / 10.0, 1), "height_cm": round(hh / 10.0, 1)})
            cursor += Lmm + gap
        dxf_path = os.path.join(tmp, "layerset.dxf")
        doc.saveas(dxf_path)
        with open(dxf_path, "rb") as fo:
            dxf_b64 = base64.b64encode(fo.read()).decode()
        # SVG 'ไฟล์ตัดแยก layer' — เฉพาะแผ่นตัด (ไม่รวมแถบยกขอบยาวๆ ที่ทำให้ไฟล์กว้างเป็นสิบเมตร)
        svg_cut = _layerset_cut_svg(out_layers, [])
        # 🖼️ ภาพหน้าตรง (3D เบา ๆ พื้นโปร่ง) — เอาไปวางบนผนังในหน้าจำลองผนัง
        svg_face = ""
        try:
            if _neon:
                svg_face = _neon_sign_svg(_neon_full, _acrylic, color=str(neon_color or "#00e5ff"), neon_subs=_neon_subs)
            else:
                # ภาพวางผนัง = 'ตัวป้ายสะอาด' (ไม่ฝังแขน/โครง) -> ขนาด+สัดส่วนตรง ไม่บีบเพี้ยน
                # (แขน/โครง ทำเป็น overlay ปรับขยับแยกในหน้าจำลองผนัง)
                svg_face = _front_sign_svg(body3d, rec, inner_bore=_bore,
                                           face_color=(face_color or None), art_href=_art, frame_top_cm=0.0)
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
        # 🅰️ .ai — แยกเลเยอร์โครงสร้างชัด + เลเยอร์งานพิมพ์ (Illustrator เปิดเลือกแยกได้)
        ai_b64 = ""
        try:
            # ภาพพิมพ์ในไฟล์ผลิต .ai = ความละเอียดสูง (พิมพ์จริงได้) เฉพาะป้ายหน้าพิมพ์
            _art_ai = (_art_data_uri(inp, max_px=2600) if rec.get("face_finish") == "print" else "")
            ai_svg = _layerset_ai_svg(out_layers, art_href=_art_ai, art_bounds=full.bounds)
            import cairosvg as _cs
            ai_b64 = base64.b64encode(_cs.svg2pdf(bytestring=ai_svg.encode("utf-8"))).decode()
        except Exception:
            ai_b64 = ""
        # ⚡ LED layout (โชว์รายละเอียดไฟในผลลัพธ์กลางจอ) — 🌈 นีออน: เดินไฟตามเส้นนีออน
        led_info = {}
        try:
            if _neon:
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
            led_info = {"total_m": _led["total_m"], "watts": _led["watts"], "amps": _led["amps"],
                        "transformer_w": _led["transformer_w"], "pitch_cm": _led.get("pitch_cm", 6),
                        "preview_svg": _led["preview_svg"]}
        except Exception:
            led_info = {}

        return {"type_name": rec["name"], "type_name_en": _en_type(rec["name"]), "sign_type": str(sign_type),
                "perimeter_cm": perimeter,
                "layers": [{"name": L["name"], "name_en": _en_layer(L["name"]), "off_cm": round(L["off"]/10.0, 3),
                            "kind": L.get("kind", "solid"), "color": L["color"], "w_mm": L["w_mm"], "h_mm": L["h_mm"],
                            "junk": L.get("junk", 0)} for L in out_layers],
                "walls": rec["walls"], "wall_pieces": wall_pieces, "warns": warns,
                "svg_preview": svg, "svg_3d": svg3d, "svg_cut": svg_cut, "dxf_base64": dxf_b64,
                "ai_base64": ai_b64, "svg_back": svg_back, "frame_info": frame_info,
                "svg_face": svg_face, "led": led_info,
                "mount": str(arm or "none"), "arm_len_cm": float(arm_len_cm),
                "mount_plate": mount_plate}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-700:]}, status_code=400)


def _job_sheet_html(meta, type_name, type_name_en, Wcm, Hcm, persp_svg, back_svg, led, bom_rows, frame_info, cut_rows=None):
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
    html = _JOB_SHEET_CSS
    html = html.replace("__TITLE__", esc(type_name))
    for k, v in {"__JOBNO__": meta.get("job_no", "JOB-XXXX"), "__DATE__": meta.get("date", ""),
                 "__DELIV__": esc(meta.get("delivery") or "— ยังไม่ระบุ —"),
                 "__CUST__": esc(meta.get("customer", "-")), "__TYPE__": esc(type_name), "__TYPEEN__": esc(type_name_en),
                 "__SIZE__": "%d × %d ซม." % (Wcm, Hcm), "__SALES__": esc(meta.get("sales", "-")),
                 "__MATERIAL__": esc(meta.get("material", "-")),
                 "__PERSP__": persp_svg, "__FRAME__": frame_card, "__LED__": led_card,
                 "__PRINT__": print_card, "__NEST__": nest_card, "__CUT__": cut_card, "__BOM__": bom}.items():
        html = html.replace(k, str(v))
    return html


_JOB_SHEET_CSS = '''<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ใบสั่งผลิต · __TITLE__</title>
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Prompt,sans-serif;background:#eef1f6;color:#1e293b;padding:18px;font-size:13px}
.sheet{max-width:1180px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 40px rgba(30,41,59,.12)}
.hd{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.hd h1{font-size:20px;font-weight:800}.hd .sub{font-size:12px;opacity:.8;margin-top:2px}.hd .meta{text-align:right;font-size:12px;line-height:1.7}
.badge{display:inline-block;background:#22d3ee;color:#083344;font-weight:700;padding:3px 12px;border-radius:20px;font-size:12px}
.info{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e2e8f0}
.info .c{background:#f8fafc;padding:11px 16px}.info .k{font-size:10.5px;color:#64748b;text-transform:uppercase;letter-spacing:.4px}.info .v{font-size:14px;font-weight:700;color:#0f172a;margin-top:2px}
.body{padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
.card{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}.card.full{grid-column:1/-1}
.ct{display:flex;align-items:center;gap:8px;padding:10px 14px;font-weight:700;font-size:13.5px;border-bottom:1px solid #eef2f7}
.ct .no{width:22px;height:22px;border-radius:6px;background:#1e3a5f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}
.cbody{padding:12px 14px}.imgwrap{background:#f1f5f9;border-radius:8px;padding:8px;text-align:center}.imgwrap svg{max-width:100%;height:auto;max-height:360px}.imgwrap.dark{background:#0f1522}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px 9px;border-bottom:1px solid #eef2f7;text-align:left}th{background:#f8fafc;color:#475569;font-weight:600;font-size:11px;text-transform:uppercase}td.r{text-align:right;font-weight:700;color:#0f172a}
.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0}.kpi .b{background:#f0f9ff;border:1px solid #bae6fd;border-radius:9px;padding:9px;text-align:center}.kpi .b .n{font-size:17px;font-weight:800;color:#0369a1}.kpi .b .l{font-size:10px;color:#64748b}
.chip{display:inline-flex;align-items:center;gap:5px;background:#f1f5f9;border-radius:6px;padding:3px 9px;font-size:11.5px;margin:2px 3px 2px 0}.dot{width:11px;height:11px;border-radius:50%;display:inline-block}
.site{border:2px dashed #cbd5e1;border-radius:10px;height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;gap:6px;background:#f8fafc}
.foot{border-top:2px solid #e2e8f0;padding:16px 24px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.sign{text-align:center}.sign .line{border-top:1.5px solid #94a3b8;margin:32px 12px 6px}.sign .r{font-size:11px;color:#64748b}
.note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:9px 12px;font-size:11.5px;margin:0 24px 16px}
.pbtn{position:fixed;top:14px;right:14px;background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:10px 18px;font-family:Prompt;font-weight:700;cursor:pointer;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.2)}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none}.pbtn{display:none}}
</style></head><body>
<button class="pbtn" onclick="window.print()">🖨️ พิมพ์ / บันทึก PDF</button>
<div class="sheet">
  <div class="hd"><div><h1>ใบสั่งผลิตป้าย / แบบยืนยันลูกค้า</h1><div class="sub">Production Spec Sheet &amp; Customer Confirmation · __TYPEEN__</div></div>
    <div class="meta"><span class="badge">DRAFT · รออนุมัติ</span><br>เลขที่งาน <b>__JOBNO__</b><br>วันที่ออกแบบ <b>__DATE__</b><br>กำหนดส่งมอบ <b>__DELIV__</b></div></div>
  <div class="info" style="grid-template-columns:repeat(5,1fr)">
    <div class="c"><div class="k">ลูกค้า</div><div class="v">__CUST__</div></div>
    <div class="c"><div class="k">ประเภทป้าย</div><div class="v">__TYPE__</div></div>
    <div class="c"><div class="k">ขนาดรวม</div><div class="v">__SIZE__</div></div>
    <div class="c"><div class="k">วัสดุหลัก</div><div class="v">__MATERIAL__</div></div>
    <div class="c"><div class="k">เซลล์ผู้ดูแล</div><div class="v">__SALES__</div></div></div>
  <div class="body">
    <div class="card full"><div class="ct"><span class="no">1</span>ภาพ 3 มิติ (Perspective) · พร้อมโครง + จับระยะ · วัสดุหลัก __MATERIAL__</div><div class="cbody"><div class="imgwrap">__PERSP__</div></div></div>
    __FRAME__
    __LED__
    __PRINT__
    __NEST__
    __CUT__
    <div class="card full"><div class="ct"><span class="no">6</span>รายละเอียดวัตถุดิบ / สเปค (BOM)</div><div class="cbody"><table><tr><th>ชิ้นส่วน</th><th>วัสดุ</th><th>สเปค</th><th>หมายเหตุ</th></tr>__BOM__</table></div></div>
    <div class="card full"><div class="ct"><span class="no">7</span>ภาพหน้างานจริง / จุดติดตั้ง</div><div class="cbody"><div class="site"><div style="font-size:30px">📷</div><div>แนบภาพหน้างาน + ทำเครื่องหมายจุดติดตั้ง</div></div></div></div>
  </div>
  <div class="note">⚠️ กรุณาตรวจสอบ ข้อความ / ขนาด / สี / ตำแหน่งติดตั้ง ให้ถูกต้องก่อนเซ็นอนุมัติ — เมื่ออนุมัติแล้วเข้าสู่การผลิตทันที</div>
  <div class="foot"><div class="sign"><div class="line"></div><div class="r">ผู้ออกแบบ / เซลล์</div></div><div class="sign"><div class="line"></div><div class="r">ผู้อนุมัติผลิต (โรงงาน)</div></div><div class="sign"><div class="line"></div><div class="r">ลูกค้าอนุมัติแบบ · วันที่</div></div></div>
</div></body></html>'''


@app.post("/api/job-sheet")
async def job_sheet(file: UploadFile = File(...), sign_type: str = Form("1"),
                    real_width_mm: float = Form(600.0), customer: str = Form(""),
                    job_no: str = Form(""), sales: str = Form(""),
                    return_depth_cm: float = Form(0.0), n_colors: int = Form(6),
                    arm: str = Form("none"), arm_len_cm: float = Form(30.0),
                    led_pitch_cm: float = Form(6.0), led_watt_per_m: float = Form(12.0),
                    led_volt: float = Form(12.0), led_color: str = Form("Warm White 3000K"),
                    frame_bars: int = Form(1), frame_level_cm: float = Form(-1.0),
                    frame_gap_cm: float = Form(20.0), frame_x_cm: float = Form(0.0),
                    frame_standoff_cm: float = Form(5.0), wire_offset_cm: float = Form(0.0),
                    material: str = Form(""), led_type: str = Form("module"),
                    wire_type: str = Form("indoor"), print_spec: str = Form(""),
                    delivery_date: str = Form(""), nesting_b64: str = Form(""),
                    neon_color: str = Form("#00e5ff"), neon_line: str = Form("double"),
                    neon_plate: str = Form("contour"), neon_margin_cm: float = Form(5.0)):
    """สร้าง 'ใบสั่งผลิต / แบบยืนยันลูกค้า' (HTML พร้อมพิมพ์ PDF) รวม 3D + โครง + LED + BOM"""
    import datetime as _dt
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        rec = SIGN_TYPES.get(str(sign_type))
        if not rec:
            return JSONResponse({"error": "ไม่รู้จักแบบป้ายนี้"}, status_code=400)
        full = _letter_full_mm(inp, float(real_width_mm), 0.0, int(n_colors))
        if rec.get("wrap"):
            full = _wrap_silhouette(full, float(rec.get("wrap_bridge_cm", 3.0)) * 10.0)
        elif rec.get("box_shape"):
            full = _geom_box_fit(full, rec["box_shape"], float(rec.get("box_pad_cm", 3.0)) * 10.0, float(real_width_mm))
        b = full.bounds; Wcm = round((b[2] - b[0]) / 10.0); Hcm = round((b[3] - b[1]) / 10.0)
        # perspective 3D
        fo = None; bore = None
        for L in rec["layers"]:
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
                                   mount=str(arm or "none"), arm_len_cm=float(arm_len_cm), plate_cm=10.0)
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
        led = None
        try:
            if rec.get("neon"):
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
                 "stainless_rose": "สแตนเลสโรสโกลด์"}
        _matn = _MATN.get(str(material), str(material)) if material else "ตามสเปควัสดุ"
        _ledtypen = "LED Module 3030" if str(led_type) == "module" else "LED Ribbon (เส้นยืด)"
        _edge_cm = round(float(led_pitch_cm) / 2.0, 1)
        _wiren = "VCT 2×1.5 mm² (Indoor)" if str(wire_type) == "indoor" else "สายกันน้ำ Outdoor 2×1.5 mm² (VCT-G/YY)"
        # BOM จากชั้นวัสดุ + LED + หม้อแปลง + งานพิมพ์
        bom = []
        for L in rec["layers"]:
            _isface = (L.get("kind") != "frame" and "แผ่นพื้น" not in L["name"])
            _mm = _matn if _isface else "ตามสเปควัสดุ"
            bom.append((L["name"], _mm,
                        ("%+.1f ซม." % (float(L["off"]) / 10.0)) if abs(float(L["off"])) > 1e-6 else "เต็มทรง", ""))
        if rec.get("face_finish") == "print":
            bom.append(("หน้าอะคริลิคพิมพ์", (print_spec or "อะคริลิคขาวขุ่น P433"), "3mm / 5mm", "พิมพ์ UV / ติดสติกเกอร์"))
        if led:
            bom.append(("ไฟ LED", "%s · 12V · IP65" % _ledtypen,
                        "%.2f ม. · %.0f W · ช่อง %s ซม. · ห่างขอบ %s ซม." % (led["total_m"], led["watts"], led_pitch_cm, _edge_cm), led_color))
            bom.append(("หม้อแปลง", "Switching PSU", "12V %d W" % led["transformer_w"], "มี spare ~30%"))
            bom.append(("สายไฟเมน", _wiren, "ทนกระแส ~15A", str(wire_type)))
        if rec.get("mount_frame"):
            bom.append(("โครงแขวน", "เหล็กกล่องชุบ 1 นิ้ว", "standoff %s ซม." % frame_standoff_cm, "เจาะรูน็อต/สายไฟ"))
        # 📐 Cut layers — ชิ้นตัดแยกชั้น + allowance + ขนาดตัดต่อชิ้น (ให้ตรงกับพรีวิวหน้าออกแบบ)
        cut_rows = []
        _neon_js = bool(rec.get("neon"))
        for L in ([] if _neon_js else rec["layers"]):
            off = float(L["off"]); kind = L.get("kind", "solid")
            try:
                if kind == "frame":
                    g = _mbuf(full, off + float(L.get("band", 10.0)))   # ขอบนอกคิ้ว
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
                "sales": sales or "-", "date": _dt.datetime.now().strftime("%d/%m/%Y"), "led_color": led_color,
                "material": _matn, "led_type": ("Module" if str(led_type) == "module" else "Ribbon"),
                "led_pitch_cm": led_pitch_cm, "led_edge_cm": _edge_cm, "wire": _wiren,
                "print_spec": (print_spec or ("อะคริลิคขาว P433 3/5mm" if rec.get("face_finish") == "print" else "")),
                "delivery": delivery_date, "nesting_b64": nesting_b64}
        html = _job_sheet_html(meta, rec["name"], _en_type(rec["name"]), Wcm, Hcm, persp, back_svg, led, bom, frame_info, cut_rows)
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
    role = "admin" if str(j.get("permission", "")).lower() == "admin" else "user"
    tok = A.sign(str(j.get("email") or u), str(j.get("plan") or "pro"), days=30, role=role)
    resp = JSONResponse({"ok": True, "username": u, "nickname": j.get("nickname") or u,
                         "role": role, "redirect": "/app?u=" + _upq(u)})
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
        mpx = max(500, min(2600, int(max_px)))
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
            ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
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
                lm = cv2.dilate((lab[y0:y1, x0:x1] == i).astype(np.uint8), ker)
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
async def extract_assets(file: UploadFile = File(...)):
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
        rep = _as.list_assets(target)
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
            or request.query_params.get("t") or "")


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
        "User-agent: GPTBot\n"
        "Allow: /$\n"
        "Allow: /welcome\n"
        "Disallow: /api/\n"
        "\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )


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
_AN_DB = os.environ.get("ANALYTICS_DB",
                        os.path.join(os.environ.get("DATA_DIR", "/tmp"), "vectorcnc_stats.db"))
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
    return c


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
           str(d.get("browser", ""))[:40], int(d.get("dur", 0) or 0))
    ok_local = True
    try:
        with _AN_LOCK:
            c = _an_conn()
            c.execute("INSERT INTO ev(ts,day,sid,account,ev,page,menu,ref,refhost,device,browser,dur)"
                      " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", row)
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
            accs = [{"name": r[0], "sessions": r[1], "last": r[2], "sec": r[3] or 0} for r in q(
                "SELECT account, COUNT(DISTINCT sid), MAX(ts), SUM(dur) FROM ev "
                "WHERE account<>'' GROUP BY account ORDER BY 2 DESC LIMIT 20").fetchall()]
            recent = [{"ts": r[0], "account": r[1], "ev": r[2], "menu": r[3],
                       "ref": r[4], "device": r[5], "dur": r[6]} for r in q(
                "SELECT ts,account,ev,menu,refhost,device,dur FROM ev "
                "ORDER BY id DESC LIMIT 40").fetchall()]
            c.close()
        return {"ok": True, "source": "local", "totals": {
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
