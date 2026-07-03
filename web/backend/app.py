"""
VectorCNC API — FastAPI หุ้ม vectorcnc.pipeline.process
รัน:  cd web/backend  &&  pip install -r requirements.txt  &&  uvicorn app:app --host 0.0.0.0 --port 8000
เปิด: http://localhost:8000            (หน้าเว็บ frontend)
API : POST http://localhost:8000/api/vectorize   (multipart: file, n_colors)
CORS เปิดหมด -> Claude Design / เว็บที่ไหนก็เรียกได้
"""
import os, sys, tempfile, base64, re
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse

# ให้ import แพ็กเกจ vectorcnc (อยู่ที่ราก VectorCNC_App)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
# หมายเหตุ: ไม่ import vectorcnc ที่นี่ (opencv โหลดหนัก ~นาที บนเครื่องฟรี)
# ใช้ lazy import ในตัว handler แทน -> แอปเปิด port ทันที health check ผ่าน

app = FastAPI(title="VectorCNC API", version="1.0")
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


@app.get("/api/health")
def health():
    return {"ok": True, "service": "VectorCNC", "version": "1.0"}


@app.post("/api/vectorize")
async def vectorize(
    file: UploadFile = File(...),
    n_colors: int = Form(6),
    real_width_mm: float = Form(1200.0),
    kerf_mm: float = Form(3.0),
    tool_mm: float = Form(6.0),
    tabs: int = Form(0),
    mode: str = Form("cutout"),
):
    tmp = tempfile.mkdtemp()
    inp = os.path.join(tmp, file.filename or "input.png")
    out_svg = os.path.join(tmp, "cut.svg")
    out_dxf = os.path.join(tmp, "cut.dxf")
    data = await file.read()
    with open(inp, "wb") as f:
        f.write(data)
    try:
        from vectorcnc import pipeline   # lazy: โหลด opencv เฉพาะตอนใช้งานจริง
        rep = pipeline.process_cnc(
            inp, out_svg, out_dxf,
            n_colors=max(2, min(12, int(n_colors))),
            real_width_mm=float(real_width_mm), kerf_mm=float(kerf_mm),
            tool_mm=float(tool_mm), tabs=int(tabs),
            mode=("lineart" if str(mode).lower() == "lineart" else "cutout"),
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
        from vectorcnc import trace_engine, nesting

        work = trace_engine.prep_image(inp)
        img = cv2.imread(work)
        if img is None:
            return JSONResponse({"error": "อ่านภาพไม่ได้"}, status_code=400)
        H, W = img.shape[:2]
        ppm = W / float(real_width_mm) if real_width_mm else 1.0
        traced = trace_engine.trace_color(work, n_colors=max(2, min(12, int(n_colors))), filter_speckle=8)
        geoms = [g for _, g in traced]
        if not geoms:
            return JSONResponse({"error": "แปลงภาพไม่พบรูปทรงสำหรับจัดวาง"}, status_code=400)
        # ลายเต็ม (มม.) + รูปนอก (footprint) ในเฟรมเดียวกัน
        full_mm = unary_union([_scale(g, 1.0 / ppm, 1.0 / ppm, origin=(0, 0)) for g in geoms])
        polys = list(full_mm.geoms) if full_mm.geom_type == "MultiPolygon" else [full_mm]
        base = max(polys, key=lambda p: p.area)
        foot = Polygon(base.exterior)
        minx, miny, mxx, mxy = foot.bounds
        foot = _tr(foot, xoff=-minx, yoff=-miny)
        full = _tr(full_mm, xoff=-minx, yoff=-miny)      # ลายเต็มเฟรมเดียวกับ footprint
        pw, ph = round(mxx - minx, 1), round(mxy - miny, 1)

        qn = max(1, min(80, int(qty)))          # คุมภาระบนเครื่องฟรี
        res = max(2.0, min(sheet_w, sheet_h) / 520.0)
        r = nesting.nest([(foot, qn)], float(sheet_w), float(sheet_h),
                         margin=float(margin), gap=float(gap), res=res)
        sheets_geoms = [[nesting.place_geom(full, pl) for pl in sheet] for sheet in r["placements"]]
        svgs = [nesting.sheet_svg(gs, float(sheet_w), float(sheet_h)) for gs in sheets_geoms]
        dxf_path = os.path.join(tmp, "nest.dxf")
        nesting.write_dxf(sheets_geoms, dxf_path, float(sheet_w), float(sheet_h))
        with open(dxf_path, "rb") as f:
            dxf_b64 = base64.b64encode(f.read()).decode()
        return {
            "n_sheets": r["n_sheets"], "utilization": r["utilization"], "unplaced": r["unplaced"],
            "sheet_w": sheet_w, "sheet_h": sheet_h, "part_mm": [pw, ph], "qty": qn,
            "sheets_svg": svgs, "dxf_base64": dxf_b64,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/")
def home():
    if os.path.exists(FRONTEND):
        return FileResponse(FRONTEND)
    return {"msg": "VectorCNC API running. POST /api/vectorize"}
