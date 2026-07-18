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
    return {"ok": True, "service": "VectorCNC", "version": "7.3-analytics+wall3d",
            "build": "2026-07-12-sharp-curves+wall-3d-sign+usage-analytics",
            "engine": eng, "bezier": bez, "nesting": nst, "psd": _psd_ok(),
            "assets": _v("assets", "ASSETS_VERSION"),
            "producible": _v("producible", "PRODUCIBLE_VERSION"),
            "concept": _v("concept", "CONCEPT_VERSION")}


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
        try:
            import cv2 as _cv, numpy as _np
            im = _cv.imread(inp, _cv.IMREAD_COLOR)
            if im is not None:
                lng = max(im.shape[:2])
                im = _cv.medianBlur(im, 3)                       # ลบ speckle/จุด noise (สำคัญกับรูปเบลอ/JPEG)
                if lng < 1000:                                   # รูปเล็ก -> ขยายคมด้วย LANCZOS
                    sc = 1500.0 / lng
                    im = _cv.resize(im, None, fx=sc, fy=sc, interpolation=_cv.INTER_LANCZOS4)
                im = _cv.bilateralFilter(im, 9, 75, 75)          # ลด noise เก็บขอบคม
                gray = _cv.cvtColor(im, _cv.COLOR_BGR2GRAY)      # ปรับพื้นหลังให้ขาวสะอาด (คอนทราสต์เบา)
                brd = _np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
                bgv = float(_np.median(brd))
                if bgv >= 150:
                    lo, hi = float(_np.percentile(gray, 4)), max(bgv - 4, 60.0)
                    im = _np.clip((im.astype(_np.float32) - lo) * (255.0 / max(20.0, hi - lo)), 0, 255).astype(_np.uint8)
                enh = os.path.join(tmp, "enhanced.png"); _cv.imwrite(enh, im); inp = enh
        except Exception:
            pass
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


def _ai_filled_svg(items, width_mm):
    """สร้าง SVG 'ระบายสีเต็ม' (artwork เวกเตอร์) จาก items=[(bgr, subs)] — หน่วย มม. ขนาดจริง
       แต่ละสี = compound path (fill-rule evenodd -> รูตรงกลางโปร่ง) เรียงพื้นที่ใหญ่ไว้หลัง"""
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
    total_subs = 0
    for oi, i in enumerate(order):
        bgr, subs = items[i]
        col = bgr if isinstance(bgr, str) else hexcolor(bgr)
        dd = ' '.join(_d(sp) for sp in subs if sp.get('segs'))
        if not dd:
            continue
        total_subs += len(subs)
        out.append(f'<g id="สี{oi+1}_{col}"><path fill="{col}" fill-rule="evenodd" stroke="none" d="{dd}"/></g>')
    out.append('</svg>')
    return '\n'.join(out), Wmm, Hmm, total_subs


@app.post("/api/draft-ai")
async def draft_ai(file: UploadFile = File(...), n_colors: int = Form(4),
                   width_mm: float = Form(600.0), engine: str = Form("auto"),
                   white_base: int = Form(0), cut_contour: int = Form(1)):
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
            pdf_bytes, info = PA.build(
                inp, width_mm=float(width_mm),
                bleed_mm=2.0, cut=bool(int(cut_contour)), corner_r_mm=1.0,
                upscale_to=2000,          # ภาพเล็ก -> ขยายก่อนฝัง กันพิมพ์ใหญ่แตก
                white_base=bool(int(white_base)), white_choke_mm=0.3)
            return {"ai_base64": base64.b64encode(pdf_bytes).decode(),
                    "w_mm": info["w_mm"], "h_mm": info["h_mm"],
                    "layers": len(info.get("layers", [])),
                    "paths": info["cut_paths"],
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
        items = None
        if used == "mono":
            items = trace_engine.trace_potrace(inp, n_colors=2)
        else:
            try:
                items = trace_engine.trace_color_smooth_bezier(inp, n_colors=nc)
            except Exception:
                items = None
            if not items:
                items = trace_engine.trace_potrace(inp, n_colors=2); used = "mono"
        if not items:
            return JSONResponse({"error": "แปลงภาพเป็นเวกเตอร์ไม่สำเร็จ"}, status_code=400)
        svg, Wmm, Hmm, npaths = _ai_filled_svg(items, float(width_mm))
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
    "3": {"name": "ไฟออกรอบ", "depth_cm": 7.0,
          "layers": [{"name": "หน้าอะคริลิค", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบใน", "h": 2.0}, {"name": "ยกขอบอะคริลิค", "h": 7.0}]},
    "4": {"name": "กล่องไฟ 1 หน้า", "depth_cm": 5.0,
          "layers": [{"name": "คิ้ว", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "อะคริลิค", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)},
                     {"name": "แผ่นพื้น", "off": 1.0, "kind": "solid", "color": "#16a34a", "rgb": (22, 163, 74)}],
          "walls": [{"name": "ยกขอบ", "h": 5.0}, {"name": "ยกขอบใน", "h": 2.0}]},
    "5": {"name": "กล่องไฟ 2 หน้า", "depth_cm": 10.0,
          "layers": [{"name": "คิ้ว", "off": 0.0, "kind": "frame", "band": 10.0, "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "อะคริลิค", "off": -2.5, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)}],
          "walls": [{"name": "ยกขอบนอก", "h": 10.0}, {"name": "ยกขอบใน", "h": 2.0}, {"name": "แผงกลางวางไฟ", "h": 0.0}]},
    "6": {"name": "งานยกขอบ", "depth_cm": 2.5,
          "layers": [{"name": "ซิ้งค์", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)}],
          "walls": [{"name": "ยกขอบ", "h": 2.5}, {"name": "ขากลางยกลอย", "h": 2.5}]},
    "7": {"name": "งานยกขอบ มีไส้", "depth_cm": 2.5,
          "layers": [{"name": "หน้าซิ้งค์", "off": 0.0, "kind": "solid", "color": "#2563EB", "rgb": (37, 99, 235)},
                     {"name": "ไส้พลาสวูด", "off": -1.6, "kind": "solid", "color": "#dc2626", "rgb": (220, 38, 38)}],
          "walls": [{"name": "ยกขอบ", "h": 2.5}]},
}


_TYPE_EN = {
    "ไฟออกหน้า มีคิ้ว": "Front-lit · with Trim (Kim)",
    "ไฟออกหน้า ไม่มีคิ้ว": "Front-lit · no Trim",
    "ไฟออกรอบ": "Halo / Back-lit",
    "กล่องไฟ 1 หน้า": "Light Box · Single-Face",
    "กล่องไฟ 2 หน้า": "Light Box · Double-Face",
    "งานยกขอบ": "Fabricated Return (Metal)",
    "งานยกขอบ มีไส้": "Fabricated Return · with Core",
}


def _en_type(th):
    return _TYPE_EN.get(str(th), str(th))


def _en_layer(n):
    n = str(n)
    if "คิ้ว" in n:
        return "Trim Face (Kim)"
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


def _iso3d_svg(full, rec, perimeter_cm, inner_bore=None, face_color=None, side_color=None):
    """ภาพ 3 มิติ (extrude oblique) — เห็นผนังข้าง(ยกขอบ)ตั้งฉากแผ่นหลัง + คิ้วเจาะโบ๋โชว์ช่อง + เส้นบอกมิติ สูง/กว้าง/ลึก"""
    import math

    def _esc(t):
        return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    polys = list(full.geoms) if full.geom_type == "MultiPolygon" else [full]
    b = full.bounds; W = b[2] - b[0]; H = b[3] - b[1]; S = max(W, H, 1.0)
    D = float(rec.get("depth_cm", 5.0)) * 10.0
    ang = math.radians(30); dvx = D * math.cos(ang); dvy = -D * math.sin(ang)
    fs = max(6.0, S * 0.032); lw = max(0.6, S * 0.003); cd = "#dc2626"
    padL = fs * 4.2; padT = fs * 3.0 + abs(dvy); padR = fs * 2.5 + dvx + S * 0.16; padB = fs * 4.8
    ox = -b[0] + padL; oy = -b[1] + padT
    faceFill = face_color or "#c9cdd4"; wallFill = side_color or "#9aa1ac"; edge = "#3f4753"; boreFill = "#eef1f5"

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
    for pg in polys:                                   # หน้า (คิ้ว/หน้า)
        parts.append('<path class="w3d-face" d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), faceFill, edge, lw))
    if inner_bore is not None and not inner_bore.is_empty:   # คิ้วเจาะโบ๋ = ช่องจม
        ip = list(inner_bore.geoms) if inner_bore.geom_type == "MultiPolygon" else [inner_bore]
        for pg in ip:
            if pg.geom_type == "Polygon" and not pg.is_empty:
                parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f"/>' % (faced(pg, F), boreFill, edge, lw * 0.8))
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
    Wt = padL + W + dvx + padR; Ht = padT + H + padB
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    svg.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a">%s</text>' % (padL, fs * 1.3, fs * 1.05, _esc(_en_type(rec["name"]))))
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


@app.post("/api/layer-set")
async def layer_set(file: UploadFile = File(...), sign_type: str = Form("1"),
                    real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                    return_depth_cm: float = Form(0.0), trim_width_cm: float = Form(1.0),
                    trim_dir: str = Form("out"), face_color: str = Form(""),
                    side_color: str = Form(""), n_colors: int = Form(6)):
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
        base_area = full.area
        # คิ้ว: ความหนา (ซม.) + ทิศทาง ('out'=ขยายออกนอกตัวต้น (มาตรฐานงานจริง) / 'in'=หดเข้า)
        TRIMW = float(trim_width_cm) * 10.0 if float(trim_width_cm) > 0 else 0.0
        TRIM_OUT = (str(trim_dir or "out").lower() != "in")
        bore_geom = None; frame_outer = None
        out_layers = []
        warns = []
        for L in rec["layers"]:
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
        if not out_layers:
            return JSONResponse({"error": "สร้างชั้นตัดไม่สำเร็จ"}, status_code=400)
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
            svg3d = _iso3d_svg(body3d, rec, perimeter, inner_bore=bore_geom,
                               face_color=(face_color or None), side_color=(side_color or None))
        except Exception:
            svg3d = ""

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
            lyname = 'CUT_' + _en_layer(L["name"]).replace(" ", "_").replace("·", "").replace("(", "").replace(")", "")
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

        return {"type_name": rec["name"], "type_name_en": _en_type(rec["name"]), "sign_type": str(sign_type),
                "perimeter_cm": perimeter,
                "layers": [{"name": L["name"], "name_en": _en_layer(L["name"]), "off_cm": round(L["off"]/10.0, 3),
                            "kind": L.get("kind", "solid"), "color": L["color"], "w_mm": L["w_mm"], "h_mm": L["h_mm"],
                            "junk": L.get("junk", 0)} for L in out_layers],
                "walls": rec["walls"], "wall_pieces": wall_pieces, "warns": warns,
                "svg_preview": svg, "svg_3d": svg3d, "svg_cut": svg_cut, "dxf_base64": dxf_b64}
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


# 🚧 SELL_MODE — สวิตช์เปิดหน้าขาย (ยังไม่เปิดขาย -> ปิดไว้ก่อน)
#    0 (ค่าเริ่มต้น) = / คือตัวแอปเหมือนเดิม · /welcome ปิด 404
#    1              = / คือหน้าขาย · ตัวแอปอยู่ที่ /app
#    เปิดตอนพร้อมขายจริง: ตั้ง env  SELL_MODE=1  ใน Render
def _sell_mode():
    return str(os.environ.get("SELL_MODE", "0")).lower() in ("1", "true", "yes", "on")


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

    if os.path.exists(FRONTEND):
        return FileResponse(FRONTEND)
    return {"msg": "VectorCNC API running. POST /api/vectorize"}


@app.get("/app")
def app_page():
    """ตัวแอป (ใช้ได้ทั้งสองโหมด — ลิงก์ /app จะได้ไม่พังตอนสลับ SELL_MODE)"""
    if os.path.exists(FRONTEND):
        return FileResponse(FRONTEND)
    return JSONResponse({"error": "index.html not found"}, status_code=404)


# ============ BOM Check Sheet (upload + params -> Check Sheet + BOM + record) ============
CHECKSHEET_PAGE = os.path.join(os.path.dirname(FRONTEND), "checksheet.html")

@app.get("/checksheet")
def checksheet_page():
    if os.path.exists(CHECKSHEET_PAGE):
        return FileResponse(CHECKSHEET_PAGE)
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
def measure_page():
    if os.path.exists(MEASURE_PAGE):
        return FileResponse(MEASURE_PAGE)
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
    return {"types": [{"key": k, "label": v["label"], "label_en": _en_type(v["label"]),
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
        "sign_types": [{"key": k, "label": v["label"], "label_en": _en_type(v["label"])}
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
    stn = SIGN_TYPES.get(st, {}).get("label", "")
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

    payload = {"sid": row[2], "account": row[3], "ev": row[4], "page": row[5],
               "menu": row[6], "refhost": row[8] or row[7], "device": row[9],
               "browser": row[10], "dur": row[11]}

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
    hook = os.environ.get("ANALYTICS_WEBHOOK", "") or ANALYTICS_SHEET_URL
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
        with urllib.request.urlopen(u, timeout=12) as r:
            j = json.loads(r.read().decode("utf-8"))
        if j.get("ok"):
            j["source"] = "sheet"
            _AN_CACHE["t"] = _t.time()
            _AN_CACHE["data"] = j
            return j
    except Exception:
        pass
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

        # ---- ชั้นโครงสร้างตามแบบป้าย 1-7 (ถ้าเลือก)
        rec = SIGN_TYPES.get(str(sign_type)) if sign_type else None
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
            res["type_name"] = rec["label"]
            res["type_en"] = _en_type(rec["label"])
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
