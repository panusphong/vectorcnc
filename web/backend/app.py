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
    return {"ok": True, "service": "VectorCNC", "version": "2.5-psd-fast",
            "build": "2026-07-09-psd-topil-fast", "engine": eng, "psd": _psd_ok()}


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
):
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    out_svg = os.path.join(tmp, "cut.svg")
    out_dxf = os.path.join(tmp, "cut.dxf")
    data = await file.read()
    with open(inp, "wb") as f:
        f.write(data)
    _isimg = str(inp).lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"))
    # ---- raster + "ตัดชิ้น" -> vtracer (เส้นตรง=line, โค้ง=spline, มุมคม) คุณภาพเวกเตอร์มืออาชีพ ----
    if _isimg and str(mode).lower() == "cutout":
        try:
            from vectorcnc import bezier_vec
            bz = bezier_vec.vectorize_bezier(inp, real_width_mm=float(real_width_mm),
                                             n_colors=max(2, min(12, int(n_colors))), dxf_out=out_dxf,
                                             size_by=str(size_by), size_value_mm=float(size_value_mm))
            dxf_b64 = ""
            try:
                with open(out_dxf, "rb") as f:
                    dxf_b64 = base64.b64encode(f.read()).decode()
            except Exception:
                pass
            return {
                "svg": bz["svg_px"], "svg_mm": bz["svg_mm"], "dxf_base64": dxf_b64,
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
        res = max(2.0, min(sheet_w, sheet_h) / 500.0)
        whole = str(parts_mode).lower() == "whole"

        if bez_pieces is not None:
            # -------- เวกเตอร์/ราสเตอร์(vtracer): จัดวางเส้นโค้ง Bézier จริง (สมูท) แยกสี --------
            if whole:
                # ทั้งป้ายเป็นชิ้นเดียว -> จัดกลุ่ม subs ตามเลเยอร์ (คงสี) แล้วปูซ้ำ
                grp = {}
                for pc in bez_pieces:
                    g = grp.setdefault(pc.get("layer", "(default)"), {"subs": [], "color": pc.get("color", "#2563EB"), "rgb": pc.get("rgb", (37, 99, 235))})
                    g["subs"].extend(pc["subs"])
                hull = full_mm.convex_hull
                if hull.geom_type != "Polygon":
                    hull = full_mm.envelope
                groups = [(g["subs"], g["color"], g["rgb"], ly) for ly, g in grp.items()]
                nest_pieces = [{"poly": hull, "groups": groups}]
                qn = max(1, min(80, int(qty)))
                r = nesting.nest([(hull, qn)], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res)
            else:
                # แยกทุกชิ้นย่อยทุกเลเยอร์ -> แพคชิด (แต่ละชิ้นถือสี/เลเยอร์ของตัวเอง)
                nest_pieces = [{"poly": pc["poly"],
                                "groups": [(pc.get("subs", []), pc.get("color", "#2563EB"), pc.get("rgb", (37, 99, 235)), pc.get("layer", "(default)"))]}
                               for pc in bez_pieces]
                qn = max(1, min(int(qty), max(1, 600 // len(nest_pieces))))  # ทำตาม qty จริง (เพดานรวม ~600)
                res_p = max(3.0, min(sheet_w, sheet_h) / 360.0)     # กริดถูกจำกัดซ้ำใน nest() (กัน 502/OOM)
                r = nesting.nest([(p["poly"], qn) for p in nest_pieces], float(sheet_w), float(sheet_h),
                                 margin=float(margin), gap=float(gap), res=res_p, rotations=(0, 90))
            sheets_items = []
            for sheet in r["placements"]:
                items = []
                for pl in sheet:
                    try:
                        pc = nest_pieces[pl["part"]]
                        for subs, color, rgb, layer in pc["groups"]:
                            ts = nesting.place_subs(subs, pl)
                            items.append((ts, color, rgb, layer))   # (subs, color_hex, rgb, layer)
                    except Exception:
                        continue                                    # ข้ามชิ้นมีปัญหา ไม่ล้มทั้งงาน
                sheets_items.append(items)
            svgs = [nesting.sheet_svg_bezier(it, float(sheet_w), float(sheet_h)) for it in sheets_items]
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
            svgs = [nesting.sheet_svg(gs, float(sheet_w), float(sheet_h)) for gs in sheets_geoms]
            dxf_path = os.path.join(tmp, "nest.dxf")
            nesting.write_dxf(sheets_geoms, dxf_path, float(sheet_w), float(sheet_h))
            n_pieces = len(parts_ref)

        with open(dxf_path, "rb") as f:
            dxf_b64 = base64.b64encode(f.read()).decode()
        return {
            "n_sheets": r["n_sheets"], "utilization": r["utilization"], "unplaced": r["unplaced"],
            "sheet_w": sheet_w, "sheet_h": sheet_h, "part_mm": [pw, ph], "qty": qn,
            "mode": str(parts_mode).lower(), "pieces": n_pieces,
            "sheets_svg": svgs, "dxf_base64": dxf_b64,
        }
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
                    for ly in list(psd)[:40]:
                        try:
                            if hasattr(ly, "is_visible") and not ly.is_visible():
                                continue
                            lim = ly.topil()             # เร็วกว่า composite() ~36x (พิกเซลเลเยอร์ที่ bbox) กัน timeout
                            if lim is None:
                                continue
                            crop = cv2.cvtColor(np.array(lim.convert("RGBA")), cv2.COLOR_RGBA2BGRA)
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
