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
from fastapi.responses import JSONResponse, FileResponse

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
    return {"ok": True, "service": "VectorCNC", "version": "4.8-iso3d+wallstrip",
            "build": "2026-07-11-extrude3d-sidewalls+wall-cut-strips+dims", "engine": eng, "bezier": bez,
            "nesting": nst, "psd": _psd_ok()}


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
        col = hexcolor(bgr)
        dd = ' '.join(_d(sp) for sp in subs if sp.get('segs'))
        if not dd:
            continue
        total_subs += len(subs)
        out.append(f'<g id="สี{oi+1}_{col}"><path fill="{col}" fill-rule="evenodd" stroke="none" d="{dd}"/></g>')
    out.append('</svg>')
    return '\n'.join(out), Wmm, Hmm, total_subs


@app.post("/api/draft-ai")
async def draft_ai(file: UploadFile = File(...), n_colors: int = Form(4),
                   width_mm: float = Form(600.0), engine: str = Form("auto")):
    """ดราฟท์ภาพ (ถ่าย/AI/โหลดเน็ต) -> ไฟล์เวกเตอร์ .ai (PDF-based) ให้กราฟิคเปิดใน Illustrator ทำต่อ
       - เวกเตอร์คมชัดระดับโลโก้ · แยกสีเป็น path คนละชั้น · ขนาดจริงตามงาน"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        from vectorcnc import trace_engine
        eng = str(engine or "auto").lower()
        nc = max(2, min(8, int(n_colors)))
        used = eng
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


def _poly_to_subs(geom):
    """polygon/multipolygon -> list ของ bezier subs (เนียน) ทุกวง (นอก+รูใน)"""
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
                sp = bezier_vec._fit_ring_to_sub(ring, tol=0.03)
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
    fs = max(6.0, Smax * 0.03)
    dimL = fs * 3.2; dimB = fs * 3.0; titleH = fs * 2.6
    gapX = Smax * 0.14; lw = max(0.5, Smax * 0.0025); aw = fs * 0.5; cd = "#dc2626"
    maxH = max(m["h"] for m in metas)
    parts = []; cursor = fs * 0.5
    for m in metas:
        L = m["L"]; b = m["b"]; w = m["w"]; h = m["h"]
        px = cursor + dimL; py = titleH; dx = px - b[0]; dy = py - b[1]

        def T(p, _dx=dx, _dy=dy):
            return (p[0] + _dx, p[1] + _dy)
        parts.append('<g fill="none" stroke="%s" stroke-width="%.2f" stroke-linejoin="round">' % (L["color"], lw))
        for sp in L["subs"]:
            nsp = {"start": T(sp["start"]),
                   "segs": [("L", T(s[1])) if s[0] == "L" else ("C", T(s[1]), T(s[2]), T(s[3])) for s in sp["segs"]],
                   "closed": sp.get("closed", True)}
            parts.append('<path d="%s"/>' % nesting._sp_d(nsp))
        parts.append('</g>')
        off = L["off"]; oc = "เต็ม" if abs(off) < 1e-6 else ("%+.2f ซม." % (off / 10.0))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">%s (%s)</text>'
                     % (px, titleH - fs * 0.7, fs * 0.95, L["color"], _esc(L["name"]), oc))
        # เส้นสูง (ซ้าย)
        xh = px - fs * 1.2; y0 = py; y1 = py + h
        parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xh, y0, xh, y1, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y0 + aw, xh, y0, xh + aw * 0.6, y0 + aw, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xh - aw * 0.6, y1 - aw, xh, y1, xh + aw * 0.6, y1 - aw, cd, lw))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f ซม.</text>'
                     % (xh - fs * 0.55, (y0 + y1) / 2, fs * 0.85, cd, xh - fs * 0.55, (y0 + y1) / 2, h / 10.0))
        # เส้นกว้าง (ล่าง)
        yw = py + h + fs * 1.2; xx0 = px; xx1 = px + w
        parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xx0, yw, xx1, yw, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx0 + aw, yw - aw * 0.6, xx0, yw, xx0 + aw, yw + aw * 0.6, cd, lw))
        parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx1 - aw, yw - aw * 0.6, xx1, yw, xx1 - aw, yw + aw * 0.6, cd, lw))
        parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="700" fill="%s" text-anchor="middle">%.1f ซม.</text>'
                     % ((xx0 + xx1) / 2, yw + fs * 1.1, fs * 0.85, cd, w / 10.0))
        cursor = px + w + gapX
    Wt = cursor + fs * 0.5; Ht = titleH + maxH + dimB + fs
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    svg += parts; svg.append('</svg>')
    return '\n'.join(svg)


def _iso3d_svg(full, rec, perimeter_cm, inner_bore=None):
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
    faceFill = "#c9cdd4"; wallFill = "#9aa1ac"; edge = "#3f4753"; boreFill = "#eef1f5"

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
                parts.append('<path d="M %.2f %.2f L %.2f %.2f L %.2f %.2f L %.2f %.2f Z" fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                             % (Af[0], Af[1], Bf[0], Bf[1], Bb[0], Bb[1], Ab[0], Ab[1], wallFill, edge, lw))
    for pg in polys:                                   # หน้า (คิ้ว/หน้า)
        parts.append('<path d="%s" fill="%s" fill-rule="evenodd" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>' % (faced(pg, F), faceFill, edge, lw))
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
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f ซม.</text>' % (xh - fs * 0.6, (y0 + y1) / 2, fs * 0.95, cd, xh - fs * 0.6, (y0 + y1) / 2, H / 10.0))
    yw = padT + H + fs * 1.4; xx0 = padL; xx1 = padL + W  # กว้าง (ล่าง)
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (xx0, yw, xx1, yw, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx0 + aw, yw - aw * 0.6, xx0, yw, xx0 + aw, yw + aw * 0.6, cd, lw))
    parts.append('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" stroke-width="%.2f"/>' % (xx1 - aw, yw - aw * 0.6, xx1, yw, xx1 - aw, yw + aw * 0.6, cd, lw))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle">%.1f ซม.</text>' % ((xx0 + xx1) / 2, yw + fs * 1.1, fs * 0.95, cd, W / 10.0))
    cF = F((b[2], b[1])); cB = Bk((b[2], b[1]))          # ลึก/ยกขอบ (แนวเยื้อง)
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f"/>' % (cF[0], cF[1], cB[0], cB[1], cd, lw))
    parts.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">ยกขอบ ~%.1f ซม.</text>' % ((cF[0] + cB[0]) / 2 + fs * 0.3, (cF[1] + cB[1]) / 2 - fs * 0.3, fs * 0.9, cd, D / 10.0))
    Wt = padL + W + dvx + padR; Ht = padT + H + padB
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%.1fmm" height="%.1fmm" viewBox="0 0 %.1f %.1f">' % (Wt, Ht, Wt, Ht)]
    svg.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a">%s</text>' % (padL, fs * 1.3, fs * 1.05, _esc(rec["name"])))
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
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s" text-anchor="middle" transform="rotate(-90 %.1f %.1f)">%.1f ซม.</text>'
               % (x_h - fs * 0.6, (y0 + y1) / 2, fs * 0.95, cd, x_h - fs * 0.6, (y0 + y1) / 2, Hd / 10.0))
    # เส้นบอก "ลึก" (แนวเยื้อง) + ความสูงผนัง
    depth_cm = float(rec.get("depth_cm", 5.0))
    dx0 = padL + Wd * 0.5; dy0 = padT + Hd + fs * 1.2
    dxe = dx0 + (N - 1) * dvx; dye = dy0 + (N - 1) * (-dvy)
    out.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="%s" stroke-width="%.2f" stroke-dasharray="%.1f %.1f"/>' % (dx0, dy0, dxe, dye, cd, lw, fs * 0.4, fs * 0.3))
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="%s">ลึก ~%.1f ซม.</text>' % ((dx0 + dxe) / 2 + fs * 0.3, (dy0 + dye) / 2 + fs * 1.1, fs * 0.9, cd, depth_cm))
    # ชื่อแบบ + เส้นรอบรูป
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" font-weight="800" fill="#0f172a">%s</text>' % (padL, fs * 1.2, fs * 1.05, _esc(rec["name"])))
    ws = " · ".join("%s %g ซม." % (w["name"], w["h"]) for w in rec.get("walls", []) if w.get("h", 0) > 0)
    out.append('<text x="%.1f" y="%.1f" font-family="Prompt,Arial" font-size="%.1f" fill="#64748b">ผนัง (แผ่นม้วน พับตามเส้นรอบรูป %.1f ซม. — ไม่ต้องตัด): %s</text>' % (padL, Ht - fs * 1.0, fs * 0.72, perimeter_cm, _esc(ws)))
    out.append('</svg>')
    return '\n'.join(out)


@app.post("/api/layer-set")
async def layer_set(file: UploadFile = File(...), sign_type: str = Form("1"),
                    real_width_mm: float = Form(600.0), real_height_mm: float = Form(0.0),
                    n_colors: int = Form(6)):
    """ออก 'ชุดชั้นตัด' อัตโนมัติตามแบบป้าย 1-7 — ขยาย/หดเส้นต่อชั้นตามค่าเผื่อ แยก layer/สี ตามวัสดุ"""
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "in.png")
    with open(inp, "wb") as f:
        f.write(await file.read())
    try:
        rec = SIGN_TYPES.get(str(sign_type))
        if not rec:
            return JSONResponse({"error": "ไม่รู้จักแบบป้ายนี้"}, status_code=400)
        full = _letter_full_mm(inp, float(real_width_mm), float(real_height_mm), int(n_colors))
        base_area = full.area
        out_layers = []
        for L in rec["layers"]:
            off = float(L["off"]); kind = L.get("kind", "solid")
            outer = full if abs(off) < 1e-6 else full.buffer(off, join_style=1, resolution=48)
            if outer.is_empty:
                continue
            if kind == "frame":
                # คิ้ว = กรอบเจาะโบ๋: แถบระหว่างขอบนอก กับ ขอบในที่หดเข้าตามความกว้างคิ้ว
                band = float(L.get("band", 10.0))
                inner = full.buffer(off - band, join_style=1, resolution=48)
                g = outer if (inner.is_empty) else outer.difference(inner)
                if g.is_empty:
                    g = outer
            else:
                g = outer
            subs = _poly_to_subs(g)
            if not subs:
                continue
            b = g.bounds
            out_layers.append({"name": L["name"], "off": off, "kind": kind, "color": L["color"], "rgb": L["rgb"],
                               "subs": subs, "w_mm": round(b[2] - b[0], 1), "h_mm": round(b[3] - b[1], 1)})
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
            _band = next((float(L.get("band", 10.0)) for L in rec["layers"] if L.get("kind") == "frame"), 0.0)
            _bore = full.buffer(-_band, join_style=1, resolution=48) if _band > 0 else None
            svg3d = _iso3d_svg(full, rec, perimeter, inner_bore=_bore)
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
            lyname = 'CUT_' + str(L["name"])
            if lyname not in doc.layers:
                lay = doc.layers.add(lyname)
                try: lay.rgb = L["rgb"]
                except Exception: pass
            for sp in L["subs"]:
                try:
                    nesting._add_contour_dxf(msp, sp, lyname, tf=_tf)
                except Exception:
                    pass
            off = L["off"]; oc = "เต็ม" if abs(off) < 1e-6 else ("%+.2f cm" % (off / 10.0))
            try:
                t = msp.add_text("%s (%s)" % (L["name"], oc), dxfattribs={'layer': 'LABEL', 'height': th})
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
            ly = 'WALL_' + nm
            if ly not in doc.layers:
                lay = doc.layers.add(ly)
                try: lay.rgb = (245, 158, 11)
                except Exception: pass
            msp.add_lwpolyline([(cursor, 0), (cursor + Lmm, 0), (cursor + Lmm, hh), (cursor, hh)],
                               close=True, dxfattribs={'layer': ly})
            try:
                t = msp.add_text("%s (พับ) ยาว %.0f x สูง %.0f mm" % (nm, Lmm, hh), dxfattribs={'layer': 'LABEL', 'height': th})
                t.set_placement((cursor, hh + th * 0.6))
            except Exception:
                pass
            wall_pieces.append({"name": nm, "length_cm": round(Lmm / 10.0, 1), "height_cm": round(hh / 10.0, 1)})
            cursor += Lmm + gap
        dxf_path = os.path.join(tmp, "layerset.dxf")
        doc.saveas(dxf_path)
        with open(dxf_path, "rb") as fo:
            dxf_b64 = base64.b64encode(fo.read()).decode()

        return {"type_name": rec["name"], "sign_type": str(sign_type),
                "perimeter_cm": perimeter,
                "layers": [{"name": L["name"], "off_cm": round(L["off"]/10.0, 3), "kind": L.get("kind", "solid"),
                            "color": L["color"], "w_mm": L["w_mm"], "h_mm": L["h_mm"]} for L in out_layers],
                "walls": rec["walls"], "wall_pieces": wall_pieces,
                "svg_preview": svg, "svg_3d": svg3d, "dxf_base64": dxf_b64}
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


@app.get("/")
def home():
    if os.path.exists(FRONTEND):
        return FileResponse(FRONTEND)
    return {"msg": "VectorCNC API running. POST /api/vectorize"}


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
