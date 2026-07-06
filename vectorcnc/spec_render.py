"""spec_render.py — สร้าง Spec / BOM Check Sheet ของงานป้าย (มาตรฐาน 4.3 ยกขอบไฟออกหน้า)

Pipeline:
  load_geometry(ai_path, real_w_mm, real_h_mm)  -> geom
  geom_summary(geom)                            -> dict สำหรับ bom.build_cost_sheet
  led_lengths(geom)                             -> (front_m, halo_m)  (ไฟ 2 ระบบ)
  render_all(geom, outdir)                      -> {finished, exploded, led_plan, nesting}
  build_checksheet(ai_path, params, outdir)     -> path ของ KFM_BOM_CheckSheet.html

โครงชั้น (4.3): ① แผ่นหลัง+ยกขอบนอก 5cm · ② ยกขอบ ตัวอักษร+กิ่ง+ใบไม้ 7cm (โบ๋หน้า) ·
              ③ อะคริลิคเฉพาะ ตัวอักษร+กิ่ง+ใบไม้ · ④ คิ้วเจาะโบ๋ 0.7cm
ไฟ 2 ระบบ: หน้า (ในตัวอักษร+ใบไม้+ก้าน concentric) + หลัง halo (รอบขอบวงรี วอร์ม)
Nesting แยก 2 ส่วน: ตัดโลหะ (สแตนเลส) | ตัดอะคริลิค
"""
import os, math, base64
import fitz
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.affinity import translate, scale as _scale
from collections import OrderedDict
from . import bom as _bom
from . import cost as _cost
from . import led as _led

def _ext_len(poly):
    """ความยาวเส้นรอบรูปแบบกัน MultiPolygon/ว่าง"""
    if poly is None or poly.is_empty: return 0.0
    return sum(q.exterior.length for q in (poly.geoms if poly.geom_type=='MultiPolygon' else [poly]))

# ---------------- geometry extraction ----------------
def _cub(a, c1, c2, e, t):
    m = 1 - t
    return (m**3*a[0]+3*m*m*t*c1[0]+3*m*t*t*c2[0]+t**3*e[0],
            m**3*a[1]+3*m*m*t*c1[1]+3*m*t*t*c2[1]+t**3*e[1])

def _flat(sp):
    o = [sp['start']]; cur = sp['start']
    for s in sp['segs']:
        if s[0] == 'L': o.append(s[1]); cur = s[1]
        else:
            for i in range(1, 13): o.append(_cub(cur, s[1], s[2], s[3], i/13))
            cur = s[3]
    return o

def _ext(path):
    doc = fitz.open(path, filetype='pdf') if path.lower().endswith(('.ai', '.pdf')) else fitz.open(path)
    pg = doc[0]; L = OrderedDict()
    for di, dr in enumerate(pg.get_drawings()):
        ly = dr.get('layer') or '(d)'; b = L.setdefault(ly, []); cur = None; sp = None
        def fl():
            if sp and sp['segs']:
                lp = sp['segs'][-1]; lp = lp[1] if lp[0] == 'L' else lp[3]
                sp['closed'] = abs(lp[0]-sp['start'][0]) < 1 and abs(lp[1]-sp['start'][1]) < 1; b.append(sp)
        for it in dr.get('items', []):
            op = it[0]
            if op in ('l', 'c'):
                a = (it[1].x, it[1].y)
                if cur is None or abs(a[0]-cur[0]) > 0.05 or abs(a[1]-cur[1]) > 0.05: fl(); sp = {'start': a, 'segs': [], 'closed': False}
                if op == 'l': e = (it[2].x, it[2].y); sp['segs'].append(('L', e)); cur = e
                else: sp['segs'].append(('C', (it[2].x, it[2].y), (it[3].x, it[3].y), (it[4].x, it[4].y))); cur = (it[4].x, it[4].y)
            elif op == 're':
                fl(); sp = None; cur = None; r = it[1]
                b.append({'start': (r.x0, r.y0), 'closed': True, 'segs': [('L', (r.x1, r.y0)), ('L', (r.x1, r.y1)), ('L', (r.x0, r.y1)), ('L', (r.x0, r.y0))]})
        fl()
    return L

def load_geometry(ai_path, real_w_mm=800.0, real_h_mm=450.0, disp_w=900.0, xmax_raw=2650.0):
    """ดึง geometry ตาม role: OVAL(s-2), BG+LET(a), KW(คิ้ว), RINGS/LEAF, WLEAF(ใบไม้รวม)
    normalize ให้ oval กว้าง = disp_w · เก็บ mm/unit จริงไว้คิด BOM"""
    L = _ext(ai_path)
    def polys(ly):
        out = []
        for sp in L.get(ly, []):
            if not sp.get('closed'): continue
            pts = _flat(sp)
            if len(pts) < 4 or min(x for x, _ in pts) > xmax_raw: continue
            p = Polygon(pts).buffer(0)
            if not p.is_empty and p.area > 40: out.append(p)
        return out
    _s2 = polys('s-2')
    if not _s2:
        _ext_ = os.path.splitext(str(ai_path))[1].lower()
        if _ext_ not in ('.ai', '.pdf'):
            raise ValueError('ไฟล์ Check Sheet ต้องเป็น .ai หรือ .pdf ที่มีเลเยอร์มาตรฐาน 4.3 (s-2, a, คิ้ว) — ไฟล์ที่อัปเป็น ' + (_ext_ or 'รูปภาพ') + ' ซึ่งเป็นภาพแบน ดึงเส้นเวกเตอร์มาคิด BOM ไม่ได้ กรุณาอัปไฟล์เวกเตอร์ที่หน้าหลัก')
        raise ValueError('ไม่พบเลเยอร์ "s-2" (วงรีฐาน) ในไฟล์ — ตรวจว่าไฟล์ .ai/.pdf มีเลเยอร์มาตรฐาน 4.3 ครบ (s-2, a, คิ้ว)')
    OVAL = max(_s2, key=lambda p: p.area)
    A = sorted(polys('a'), key=lambda z: -z.area)
    if not A:
        raise ValueError('ไม่พบเลเยอร์ "a" (ตัวอักษร/หน้าอักษร) ในไฟล์ .ai/.pdf — ต้องมีเลเยอร์มาตรฐาน 4.3')
    BG = A[0]; LET = A[1:]
    KW = polys('คิ้ว'); letU = unary_union(LET)
    LEAF = [p for p in KW if p.intersection(letU).area < 0.30*p.area and p.area < 40000]
    RINGS = [p for p in KW if p.intersection(letU).area < 0.30*p.area and p.area >= 40000]
    mnx, mny, mxx, mxy = OVAL.bounds; sc = disp_w/(mxx-mnx)
    def N(p): return _scale(translate(p, -mnx, -mny), xfact=sc, yfact=sc, origin=(0, 0))
    lg = unary_union([p.buffer(4) for p in LEAF]).buffer(-4)
    WLEAF = [g for g in (lg.geoms if lg.geom_type == 'MultiPolygon' else [lg]) if not g.is_empty]
    return {
        'OVAL': N(OVAL), 'BG': N(BG), 'LET': [N(p) for p in LET], 'LEAF': [N(p) for p in LEAF],
        'RINGS': [N(p) for p in RINGS], 'KW': [N(p) for p in KW], 'WLEAF': [N(_p_from(g, sc, mnx, mny)) for g in WLEAF] if False else _norm_list(WLEAF, sc, mnx, mny),
        'W': disp_w, 'H': (mxy-mny)*sc, 'u2mm': real_w_mm/disp_w,
        'real_w_mm': real_w_mm, 'real_h_mm': real_h_mm,
    }

def _norm_list(polys, sc, mnx, mny):
    return [_scale(translate(p, -mnx, -mny), xfact=sc, yfact=sc, origin=(0, 0)) for p in polys]
def _p_from(g, sc, mnx, mny):  # placeholder (unused)
    return g

# ---------------- summaries ----------------
def geom_summary(g):
    u = g['u2mm']
    def Am(p): return (p.area if hasattr(p, 'area') else 0) * u * u / 1e6
    def Lm(p): return _ext_len(p) * u
    LET, LEAF, RINGS, KW, OVAL, WLEAF = g['LET'], g['LEAF'], g['RINGS'], g['KW'], g['OVAL'], g['WLEAF']
    acr = unary_union(LET + RINGS + WLEAF).buffer(3).buffer(-3)
    return {
        'width_mm': g['real_w_mm'], 'height_mm': g['real_h_mm'],
        'back_area_m2': round(Am(OVAL), 4),
        'outer_perim_mm': round(Lm(OVAL)),
        'floor_area_m2': round(sum(Am(p) for p in LET), 4),
        'kiew_area_m2': round(sum(Am(p) for p in KW), 4),
        'letter_perim_mm': round(sum(Lm(p) for p in (LET + LEAF))),
        'acrylic_area_m2': round(acr.area * u * u / 1e6, 4),
    }

def led_lengths(g):
    """ไฟหน้า (letters+leaves concentric fill + branch/vine) · ไฟหลัง halo (รอบขอบวงรี 2 loop)"""
    u = g['u2mm']; OVAL, LET, LEAF, RINGS = g['OVAL'], g['LET'], g['LEAF'], g['RINGS']
    def fill(poly, first=8, step=34):
        t = 0; k = 0; placed = False
        while k < 14:
            off = poly.buffer(-(first+k*step))
            if off.is_empty or off.area < 1.5: break
            for q in (off.geoms if off.geom_type == 'MultiPolygon' else [off]): t += q.exterior.length
            placed = True; k += 1
        if not placed:
            for d in (6, 4, 2.5, 1.3):
                off = poly.buffer(-d)
                if not off.is_empty and off.area > 0.8:
                    for q in (off.geoms if off.geom_type == 'MultiPolygon' else [off]): t += q.exterior.length
                    break
        return t
    front = (sum(fill(p) for p in LET+LEAF) + sum(p.exterior.length for p in RINGS)/2) * u/1000
    halo = (_ext_len(OVAL.buffer(-8)) + _ext_len(OVAL.buffer(-22))) * u/1000
    return round(front, 2), round(halo, 2)

# ---------------- rendering (SVG -> PNG) ----------------
def _need_cairosvg():
    import cairosvg
    return cairosvg

def render_all(g, outdir):
    """สร้าง finished / exploded / led_plan / nesting (แยกโลหะ-อะคริลิค) เป็น PNG"""
    from ._spec_draw import draw_finished, draw_exploded, draw_led_plan, draw_nesting_split
    os.makedirs(outdir, exist_ok=True)
    paths = {}
    paths['finished'] = draw_finished(g, os.path.join(outdir, 'finished.png'))
    paths['exploded'] = draw_exploded(g, os.path.join(outdir, 'exploded.png'))
    paths['led_plan'] = draw_led_plan(g, os.path.join(outdir, 'led_plan.png'))
    paths['nesting'] = draw_nesting_split(g, os.path.join(outdir, 'nesting.png'))
    return paths

# ---------------- Check Sheet ----------------
def _b64(p):
    return base64.b64encode(open(p, 'rb').read()).decode()

def build_checksheet(ai_path, params=None, outdir='outputs', job_name='KFM', job_id=''):
    """สร้าง BOM Check Sheet เต็มฟอร์ม -> คืน path HTML"""
    params = params or {}
    w = float(params.get('real_width_cm', 80)) * 10.0
    h = float(params.get('real_height_cm', 45)) * 10.0
    ext = os.path.splitext(str(ai_path))[1].lower()
    if ext in ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'):
        from . import raster_geom as _rg
        g = _rg.load_geometry_raster(ai_path, real_w_mm=w, real_h_mm=h, n_colors=int(params.get('n_colors', 4)))
    else:
        g = load_geometry(ai_path, real_w_mm=w, real_h_mm=h)
    gs = geom_summary(g)
    front_m, halo_m = led_lengths(g)
    install = params.get('install', 'indoor')
    series = 'RSP' if install == 'outdoor' else 'LRS'   # outdoor -> หม้อแปลงกันน้ำ
    led_plan = _led.plan_two_systems(front_m, halo_m, series=series)
    cost = _cost.build_cost_sheet(gs, led_plan, sign_type=params.get('sign_type', '4.3'),
                                 qty_sets=int(params.get('qty_sets', 1)), params=params)
    imgs = render_all(g, outdir)
    html = _checksheet_html(imgs, cost, gs, led_plan, job_name, job_id)
    outp = os.path.join(outdir, 'KFM_BOM_CheckSheet.html')
    with open(outp, 'w', encoding='utf-8') as f:
        f.write(html)
    return outp, cost

def _checksheet_html(imgs, cost, gs, led, job_name, job_id):
    fin = _b64(imgs['finished']); exp = _b64(imgs['exploded'])
    ledp = _b64(imgs['led_plan']); nest = _b64(imgs['nesting'])
    def tr(r):
        sub = ' style="color:#94a3b8"' if r['no'] == '' else ''
        cost = r['cost'] if r['cost'] != '' else '—'
        return (f'<tr><td class="c"{sub}>{r["no"]}</td><td>{r["name"]}</td><td>{r["size"]}</td>'
                f'<td>{r["material"]}</td><td class="code">{r["itemcode"]}</td>'
                f'<td class="r">{r["unit_price"]}</td><td class="r">{r["qty"]}</td>'
                f'<td class="r money">{cost}</td></tr>')
    tbody = '\n'.join(tr(r) for r in cost['rows'])
    return _TPL.format(
        job=job_name, jobid=job_id, W=gs['width_mm']/10, H=gs['height_mm']/10,
        fin=fin, exp=exp, ledp=ledp, nest=nest, tbody=tbody,
        material=f"{cost['material']:,}", labor_pct=int(cost['markup']['labor_oh']*100),
        labor=f"{cost['labor']:,}", dmg_pct=int(cost['markup']['damage']*100),
        dmg=f"{cost['damage']:,}", total=f"{cost['total']:,}",
        led_line=(f"ไฟ 2 ระบบ — หน้า {led['front_m']}m {led['front_w']}W (ตัวอักษร+ใบไม้+ก้าน หนุน 2cm ห่างอะคริลิค 5cm) · "
                  f"หลัง halo {led['halo_m']}m {led['halo_w']}W (รอบขอบวงรี วอร์ม) · รวม {led['total_m']}m {led['total_w']}W → {led['transformer']['name']}"),
    )

_TPL = '''<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BOM Check Sheet — {job}</title>
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:'Prompt',sans-serif;background:#eef1f6;color:#1e293b;padding:26px;line-height:1.5}}
.sheet{{max-width:1000px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);overflow:hidden}}
.hd{{background:linear-gradient(135deg,#0f766e,#0891b2);color:#fff;padding:22px 28px}}
.hd h1{{font-size:22px;font-weight:700}}.hd .sub{{opacity:.9;font-size:13px;margin-top:3px;font-weight:300}}
.hd .tags{{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}}
.tag{{background:rgba(255,255,255,.18);padding:4px 11px;border-radius:20px;font-size:12px;font-weight:500}}
.sec{{padding:22px 28px;border-bottom:1px solid #eef2f7}}
.sec h2{{font-size:15px;font-weight:600;color:#0f766e;margin-bottom:12px;display:flex;align-items:center;gap:8px}}
.sec h2::before{{content:'';width:4px;height:16px;background:#0891b2;border-radius:3px}}
.finish{{background:linear-gradient(180deg,#fafcff,#eef4fb);text-align:center;padding:20px}}
.finish img{{max-width:72%;border-radius:12px}}
.imgcard{{border:1px solid #e6ebf2;border-radius:12px;overflow:hidden;background:#fff;margin-bottom:16px}}
.imgcard .cap{{font-size:12px;font-weight:600;color:#475569;padding:8px 12px;background:#f8fafc;border-bottom:1px solid #eef2f7}}
.imgcard img{{width:100%;display:block}}
table{{width:100%;border-collapse:collapse;font-size:12.5px}}
th{{background:#0f766e;color:#fff;padding:9px 8px;text-align:left;font-weight:500;font-size:11.5px}}
td{{padding:8px;border-bottom:1px solid #eef2f7;vertical-align:top}}
td.c{{text-align:center;font-weight:600;color:#0891b2}}.r{{text-align:right}}.money{{font-weight:600}}
.code{{font-family:monospace;font-size:11px;color:#0891b2;background:#ecfeff;padding:2px 6px;border-radius:5px}}
tr:nth-child(even) td{{background:#fbfdff}}
.sum{{margin-top:14px;background:#f8fafc;border-radius:12px;padding:16px 18px}}
.sr{{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}}
.sr.tot{{border-top:2px solid #0f766e;margin-top:8px;padding-top:12px;font-size:18px;font-weight:700;color:#0f766e}}
.muted{{color:#64748b}}.plus{{color:#c2410c;font-weight:600}}.note{{font-size:11.5px;color:#64748b;margin-top:8px;font-weight:300}}
</style></head><body><div class="sheet">
<div class="hd"><h1>BOM Check Sheet — {job}</h1>
<div class="sub">ป้ายตัวอักษรไฟออกหน้า ยกขอบ (กลุ่ม 4.3) · {jobid}</div>
<div class="tags"><span class="tag">ขนาด {W:.0f}×{H:.0f} cm</span><span class="tag">ยกขอบ 5+7 cm</span><span class="tag">ไฟหน้า+หลัง halo</span><span class="tag">สแตนเลสทอง</span></div></div>
<div class="sec finish"><h2 style="justify-content:center">ภาพสินค้าประกอบเสร็จ (Finished Product)</h2>
<img src="data:image/png;base64,{fin}"></div>
<div class="sec"><h2>ภาพแยกชั้น · การวางไฟ · Nesting (แยกโลหะ/อะคริลิค)</h2>
<div class="imgcard"><div class="cap">แยกชั้นประกอบ — ① แผ่นหลัง+ขอบ5cm+halo · ② ยกขอบ ตัวอักษร+กิ่ง+ใบไม้ 7cm (โบ๋หน้า) · ③ อะคริลิคเฉพาะ ตัวอักษร+กิ่ง+ใบไม้ · ④ คิ้วเจาะโบ๋ 0.7cm</div><img src="data:image/png;base64,{exp}"></div>
<div class="imgcard"><div class="cap">แนวการวางไฟ LED — ไฟหน้า (ตัวอักษร+ใบไม้+ก้าน) · ไฟหลัง halo อยู่ที่แผ่นฐาน</div><img src="data:image/png;base64,{ledp}"></div>
<div class="imgcard"><div class="cap">Nesting การตัด — แยก 2 ส่วน: ตัดโลหะ (สแตนเลส) | ตัดอะคริลิค (คนละไฟล์)</div><img src="data:image/png;base64,{nest}"></div></div>
<div class="sec"><h2>รายการวัสดุ (BOM) — เชื่อม ItemMaster</h2>
<table><thead><tr><th>No.</th><th>รายการ</th><th>ขนาด/สเปก</th><th>วัสดุ</th><th>ItemCode</th><th class="r">ราคา/หน่วย</th><th class="r">ปริมาณ</th><th class="r">฿</th></tr></thead>
<tbody>{tbody}</tbody></table>
<div class="sum">
<div class="sr"><span class="muted">รวมค่าวัสดุ (Material)</span><span class="money">{material} ฿</span></div>
<div class="sr"><span class="muted">ค่าแรง + Overhead ({labor_pct}% ของค่าวัสดุ)</span><span class="plus">+ {labor} ฿</span></div>
<div class="sr"><span class="muted">ค่าความเสียหาย ({dmg_pct}% ของค่าวัสดุ)</span><span class="plus">+ {dmg} ฿</span></div>
<div class="sr tot"><span>รวมต้นทุนทั้งหมด (ต่อ 1 ชุด)</span><span>{total} ฿</span></div></div>
<div class="note">{led_line}</div>
<div class="note">* ราคา/หน่วยดึงจาก ItemMaster · หม้อแปลง LRS ราคาประเมิน (ยืนยัน ItemMaster) · Nesting โลหะ/อะคริลิคตัดคนละแผ่น</div></div>
<div class="sec" style="text-align:center;color:#94a3b8;font-size:11px;border:none">Saai Tech · Graphic Design Solution · มาตรฐานงานยกขอบไฟออกหน้า 4.3</div>
</div></body></html>'''
