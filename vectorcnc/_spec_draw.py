"""_spec_draw.py — ฟังก์ชันวาดภาพสำหรับ Check Sheet (finished / exploded / led_plan / nesting)
รับ geom dict จาก spec_render.load_geometry() -> เขียน PNG
ต้องมี cairosvg + shapely
"""
import math
from shapely.geometry import Polygon
from shapely.ops import unary_union


def _png(svg, outpath, width):
    import cairosvg
    cairosvg.svg2png(bytestring=svg.encode('utf-8'), write_to=outpath, output_width=width, background_color='#ffffff')
    return outpath


def _d_front(poly):
    d = ''
    for gg in (poly.geoms if poly.geom_type == 'MultiPolygon' else [poly]):
        d += 'M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in gg.exterior.coords) + ' Z '
        for h in gg.interiors:
            d += 'M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in h.coords) + ' Z '
    return d


def acr_sil(g):
    """รวม ตัวอักษร+กิ่ง+ใบไม้ เป็นเส้นรอบนอกเดียว (silhouette, เติมรูใน) = แนวตัดอะคริลิค/โบ๋น้ำเงิน"""
    u = unary_union(g['LET'] + g['RINGS'] + g['WLEAF']).buffer(3).buffer(-3)
    geoms = u.geoms if u.geom_type == 'MultiPolygon' else [u]
    return [Polygon(gg.exterior.coords) for gg in geoms if not gg.is_empty]


# ================= FINISHED (perspective, metallic) =================
def draw_finished(g, outpath):
    OVAL, BG, LET, LEAF, RINGS, KW = g['OVAL'], g['BG'], g['LET'], g['LEAF'], g['RINGS'], g['KW']
    W, Hh = g['W'], g['H']; mnx, mny, mxx, mxy = OVAL.bounds
    A = math.radians(22); MM = 2.0; ALL = []
    def iso(x, y, z=0):
        xx = x-mnx; yy = y-mny; p = ((xx-yy)*math.cos(A)+(mxx-mnx), (xx+yy)*math.sin(A)*0.62 - z + (mxy-mny)*0.34); ALL.append(p); return p
    def face(poly, z, fill, st, sw, op=1.0):
        d = ''
        for gg in (poly.geoms if poly.geom_type == 'MultiPolygon' else [poly]):
            d += 'M ' + ' L '.join(f'{iso(x,y,z)[0]:.1f},{iso(x,y,z)[1]:.1f}' for x, y in gg.exterior.coords) + ' Z '
            for h in gg.interiors: d += 'M ' + ' L '.join(f'{iso(x,y,z)[0]:.1f},{iso(x,y,z)[1]:.1f}' for x, y in h.coords) + ' Z '
        return f'<path d="{d}" fill="{fill}" fill-opacity="{op}" fill-rule="evenodd" stroke="{st}" stroke-width="{sw}"/>'
    def wall(coords, zb, zt, fill, op=1.0, st='none', sw=0):
        out = []
        for i in range(len(coords)-1):
            a0 = iso(*coords[i], zb); a1 = iso(*coords[i+1], zb); b1 = iso(*coords[i+1], zt); b0 = iso(*coords[i], zt)
            out.append(f'<path d="M {a0[0]:.1f},{a0[1]:.1f} L {a1[0]:.1f},{a1[1]:.1f} L {b1[0]:.1f},{b1[1]:.1f} L {b0[0]:.1f},{b0[1]:.1f} Z" fill="{fill}" fill-opacity="{op}" stroke="{st}" stroke-width="{sw}"/>')
        return out
    PH = 50*MM; LH = 70*MM
    defs = ('<defs>'
            '<linearGradient id="mface" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0%" stop-color="#eef1f4"/><stop offset="45%" stop-color="#c4ccd5"/><stop offset="100%" stop-color="#9aa4b1"/></linearGradient>'
            '<linearGradient id="mwall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#aeb7c2"/><stop offset="100%" stop-color="#6f7986"/></linearGradient>'
            '<linearGradient id="acr" x1="0" y1="0" x2="0.2" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#dfe7f0"/></linearGradient>'
            '<filter id="ds2" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="0" dy="9" stdDeviation="11" flood-color="#000" flood-opacity="0.22"/></filter></defs>')
    F = []
    F.append(''.join(wall(list(OVAL.exterior.coords), 0, PH, 'url(#mwall)', 1.0, '#5f6874', 0.4)))
    F.append(face(OVAL, PH, 'url(#mface)', '#7a8492', 1.2))
    inr = OVAL.buffer(-14)
    if not inr.is_empty: F.append(face(inr, PH, '#d6dce3', '#98a2ae', 1.0, 0.8))
    RAISE = LET + LEAF + RINGS
    for o in RAISE: F.append(''.join(wall(list(o.exterior.coords), PH, PH+LH, 'url(#mwall)', 1.0, '#5f6874', 0.3)))
    for o in LEAF: F.append(face(o, PH+LH, 'url(#mface)', '#7a8492', 0.9))
    for o in RINGS: F.append(face(o, PH+LH, 'url(#mface)', '#7a8492', 0.8))
    for o in LET: F.append(face(o, PH+LH, 'url(#acr)', '#c7d2df', 1.2))
    for o in KW:
        inn = o.buffer(-13); ring = o if inn.is_empty else o.difference(inn)
        F.append(face(ring, PH+LH+6, '#e9edf1', '#8a94a1', 0.6, 0.5))
    xs = [a for a, b in ALL]; ys = [b for a, b in ALL]; pad = 40
    ox = -min(xs)+pad; oy = -min(ys)+pad; CW = max(xs)-min(xs)+2*pad; CH = max(ys)-min(ys)+2*pad+34
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{CW:.0f}" height="{CH:.0f}" viewBox="0 0 {CW:.0f} {CH:.0f}">{defs}'
           f'<rect width="100%" height="100%" fill="#fff"/><g filter="url(#ds2)" transform="translate({ox:.0f},{oy:.0f})">'
           + ''.join(F) + '</g>'
           f'<text x="{CW/2:.0f}" y="18" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#475569" font-weight="700">&#11012; {g["real_w_mm"]/10:.0f} cm &#11012;</text>'
           f'<text x="16" y="{CH/2:.0f}" font-family="sans-serif" font-size="14" fill="#475569" font-weight="700" transform="rotate(-90 16 {CH/2:.0f})">&#11012; {g["real_h_mm"]/10:.0f} cm &#11012;</text>'
           f'<text x="{CW/2:.0f}" y="{CH-12:.0f}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#334155" font-weight="700">FINISHED PRODUCT (perspective)</text></svg>')
    return _png(svg, outpath, 940)


# ================= EXPLODED =================
def draw_exploded(g, outpath):
    OVAL, BG, LET, LEAF, RINGS, KW, WLEAF = g['OVAL'], g['BG'], g['LET'], g['LEAF'], g['RINGS'], g['KW'], g['WLEAF']
    mnx, mny, mxx, mxy = OVAL.bounds; A = math.radians(30); MM = 130/70.0; ALL = []
    def iso(x, y, z=0):
        xx = x-mnx; yy = y-mny; p = ((xx-yy)*math.cos(A)+(mxx-mnx), (xx+yy)*math.sin(A) - z + (mxy-mny)*0.42); ALL.append(p); return p
    def facepath(poly, z, f, st, op, sw=1.0):
        d = ''
        for gg in (poly.geoms if poly.geom_type == 'MultiPolygon' else [poly]):
            d += 'M ' + ' L '.join(f'{iso(x,y,z)[0]:.1f},{iso(x,y,z)[1]:.1f}' for x, y in gg.exterior.coords) + ' Z '
            for h in gg.interiors: d += 'M ' + ' L '.join(f'{iso(x,y,z)[0]:.1f},{iso(x,y,z)[1]:.1f}' for x, y in h.coords) + ' Z '
        return f'<path d="{d}" fill="{f}" fill-opacity="{op}" fill-rule="evenodd" stroke="{st}" stroke-width="{sw}"/>'
    def wallf(coords, zb, zt, fw, op, st=None, sw=0.0):
        out = []
        for i in range(len(coords)-1):
            a0 = iso(*coords[i], zb); a1 = iso(*coords[i+1], zb); b1 = iso(*coords[i+1], zt); b0 = iso(*coords[i], zt)
            sa = f' stroke="{st}" stroke-width="{sw}"' if st else ' stroke="none"'
            out.append(f'<path d="M {a0[0]:.1f},{a0[1]:.1f} L {a1[0]:.1f},{a1[1]:.1f} L {b1[0]:.1f},{b1[1]:.1f} L {b0[0]:.1f},{b0[1]:.1f} Z" fill="{fw}" fill-opacity="{op}"{sa}/>')
        return out
    def oline(o, z, st, op=0.9, dash=None, sw=1.1):
        d = 'M ' + ' L '.join(f'{iso(x,y,z)[0]:.1f},{iso(x,y,z)[1]:.1f}' for x, y in o.exterior.coords) + ' Z'
        da = f' stroke-dasharray="{dash}"' if dash else ''
        return f'<path d="{d}" fill="none" stroke="{st}" stroke-width="{sw}" stroke-opacity="{op}"{da}/>'
    def LAB(txt, z, col):
        n = iso(-25, (mxy-mny)/2, z); return f'<text x="{n[0]-14:.0f}" y="{n[1]+5:.0f}" font-family="sans-serif" font-size="14" fill="{col}" font-weight="700" text-anchor="end">{txt}</text>'
    GAP = 300; PL = []; GREY = '#9aa7bd'
    def anchor(z): PL.append(oline(OVAL, z, GREY, 0.4, '4,5', 0.9))
    PH = 50*MM
    PL += wallf(list(OVAL.exterior.coords), 0, PH, '#e79bb0', 0.95, '#e11d48', 0.5)
    PL.append(facepath(OVAL, PH, '#f3b9c8', '#e11d48', 0.97))
    for offp in (OVAL.buffer(-8), OVAL.buffer(-22)):
        if offp.is_empty: continue
        for off in (offp.geoms if offp.geom_type == 'MultiPolygon' else [offp]):
            dd = 'M ' + ' L '.join(f'{iso(x,y,PH)[0]:.1f},{iso(x,y,PH)[1]:.1f}' for x, y in off.exterior.coords) + ' Z'
            PL.append(f'<path d="{dd}" fill="none" stroke="#d97324" stroke-width="2.2" stroke-dasharray="7,5"/>')
    PL.append(LAB('1. BACK PLATE + 5cm EDGE + halo', PH*0.5, '#e11d48'))
    z2 = PH+GAP; RH = 70*MM; anchor(z2)
    BLUE = acr_sil(g)
    for o in BLUE: PL += wallf(list(o.exterior.coords), z2, z2+RH, '#8fb2ea', 0.96, '#1e40af', 0.5)
    for o in BLUE:
        PL.append(oline(o, z2, '#1e40af', 0.6, None, 0.8)); PL.append(oline(o, z2+RH, '#1e3a8a', 1.0, None, 1.4))
    for o in LET + RINGS + WLEAF:
        PL.append(oline(o, z2+RH, '#3b60c4', 0.3, '3,3', 0.5))
    PL.append(LAB('2. RAISED 7cm — hollow follows acrylic silhouette', z2+RH*0.6, '#2563eb'))
    z3 = z2+RH+GAP; GT = 3*MM; anchor(z3)
    for o in acr_sil(g):
        PL += wallf(list(o.exterior.coords), z3, z3+GT, '#cfeeda', 0.5)
        dg = 'M ' + ' L '.join(f'{iso(x,y,z3+GT)[0]:.1f},{iso(x,y,z3+GT)[1]:.1f}' for x, y in o.exterior.coords) + ' Z'
        PL.append(f'<path d="{dg}" fill="#eafaf1" fill-opacity="0.55" stroke="#059669" stroke-width="1.6"/>')
    for o in LET + RINGS + WLEAF:
        PL.append(oline(o, z3+GT, '#8fd3ac', 0.5, '3,3', 0.6))
    PL.append(LAB('3. ACRYLIC — outer silhouette cut (art printed inside)', z3+GT, '#059669'))
    z4 = z3+GT+GAP*0.55; anchor(z4)
    for o in KW:
        inn = o.buffer(-13); ring = o if inn.is_empty else o.difference(inn)
        PL.append(facepath(ring, z4, '#f3b45a', '#c2620a', 0.9, 0.7))
    PL.append(LAB('4. TRIM 0.7cm (hollow center)', z4, '#d97706'))
    def dim(zl, zh, txt, col, off=64):
        a = iso(mxx, mny, zl); b = iso(mxx, mny, zh); x = max(a[0], b[0])+off
        return (f'<line x1="{x:.0f}" y1="{a[1]:.0f}" x2="{x:.0f}" y2="{b[1]:.0f}" stroke="{col}" stroke-width="1.5"/>'
                f'<line x1="{x-6:.0f}" y1="{a[1]:.0f}" x2="{x+6:.0f}" y2="{a[1]:.0f}" stroke="{col}" stroke-width="1.5"/>'
                f'<line x1="{x-6:.0f}" y1="{b[1]:.0f}" x2="{x+6:.0f}" y2="{b[1]:.0f}" stroke="{col}" stroke-width="1.5"/>'
                f'<text x="{x+10:.0f}" y="{(a[1]+b[1])/2+4:.0f}" font-family="sans-serif" font-size="12.5" fill="{col}" font-weight="700">{txt}</text>')
    PL.append(dim(0, PH, 'outer edge 5cm', '#e11d48'))
    PL.append(dim(z2, z2+RH, 'letters 7cm', '#2563eb'))
    xs = [a for a, b in ALL]; ys = [b for a, b in ALL]; padL = 340; padR = 240
    ox = -min(xs)+padL; oy = -min(ys)+55; CW = max(xs)-min(xs)+padL+padR; CH = max(ys)-min(ys)+120
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{CW:.0f}" height="{CH:.0f}" viewBox="0 0 {CW:.0f} {CH:.0f}">'
           f'<rect width="100%" height="100%" fill="#fff"/><g transform="translate({ox:.0f},{oy:.0f})">' + ''.join(PL) + '</g></svg>')
    return _png(svg, outpath, 1080)


# ================= LED PLAN (front concentric + branch; halo note) =================
def draw_led_plan(g, outpath):
    OVAL, LET, LEAF, RINGS = g['OVAL'], g['LET'], g['LEAF'], g['RINGS']; W, Hh = g['W'], g['H']
    def Pf(poly, fill, st, sw, op=1.0):
        return f'<path d="{_d_front(poly)}" fill="{fill}" fill-opacity="{op}" fill-rule="evenodd" stroke="{st}" stroke-width="{sw}"/>'
    def ringL(gg, out, col='#ff7a00', w=2.2):
        for q in (gg.geoms if gg.geom_type == 'MultiPolygon' else [gg]):
            if q.is_empty: continue
            dd = 'M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in q.exterior.coords) + ' Z'
            out.append(f'<path d="{dd}" fill="none" stroke="{col}" stroke-width="{w}" stroke-linejoin="round"/>')
    def ledfill(poly, out, first=8.0, step=34.0):
        placed = False; k = 0
        while k < 14:
            off = poly.buffer(-(first+k*step))
            if off.is_empty or off.area < 1.5: break
            ringL(off, out); placed = True; k += 1
        if not placed:
            for dd in (6, 4, 2.5, 1.3):
                off = poly.buffer(-dd)
                if not off.is_empty and off.area > 0.8: ringL(off, out); break
    q = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{Hh+46:.0f}" viewBox="0 0 {W:.0f} {Hh+46:.0f}"><rect width="100%" height="100%" fill="#fff"/>']
    q.append(Pf(OVAL, '#f7f9fc', '#c3ccd9', 1.2))
    for p in LET+LEAF: q.append(Pf(p, '#eef2f7', '#c7d0dc', 0.8))
    led = []
    for p in LET+LEAF: ledfill(p, led)
    for rp in RINGS:
        dp = 'M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in rp.exterior.coords) + ' Z'
        led.append(f'<path d="{dp}" fill="none" stroke="#ff7a00" stroke-width="2.8" stroke-linejoin="round"/>')
    q += led
    q.append('<g font-family="sans-serif"><rect x="18" y="14" width="252" height="28" rx="7" fill="#fffdf7" stroke="#e2cea5"/>'
             '<line x1="30" y1="28" x2="58" y2="28" stroke="#ff7a00" stroke-width="3"/><text x="66" y="32" font-size="12" fill="#7a4a12">FRONT-LIT (letters + leaves + branch)</text></g>')
    q.append(f'<text x="24" y="{Hh+24:.0f}" font-family="sans-serif" font-size="12.5" fill="#334155" font-weight="700">FRONT-LIT LED — fill letters+leaves + branch vine (back-lit halo is on the base plate)</text>')
    q.append('</svg>')
    return _png('\n'.join(q), outpath, 900)


# ================= NESTING SPLIT (metal | acrylic) =================
def draw_nesting_split(g, outpath):
    """แยกการตัด 2 ส่วน: โลหะ (แผ่นหลัง+ฐาน+คิ้ว) | อะคริลิค (ตัวอักษร+กิ่ง+ใบไม้)"""
    OVAL, LET, KW, RINGS, WLEAF = g['OVAL'], g['LET'], g['KW'], g['RINGS'], g['WLEAF']
    W, Hh = g['W'], g['H']; PANEL = W; PAD = 20
    def grp(polys, fill, st):
        s = ''
        for p in polys: s += f'<path d="{_d_front(p)}" fill="{fill}" fill-opacity="0.5" fill-rule="evenodd" stroke="{st}" stroke-width="1.2"/>'
        return s
    scale = 0.46
    def box(x0, title, sub, content, fill):
        return (f'<g transform="translate({x0},40)">'
                f'<rect x="0" y="0" width="{PANEL*0.5-30:.0f}" height="{Hh*scale+70:.0f}" rx="12" fill="{fill}" stroke="#cbd5e1"/>'
                f'<text x="16" y="26" font-family="sans-serif" font-size="14" font-weight="700" fill="#334155">{title}</text>'
                f'<text x="16" y="44" font-family="sans-serif" font-size="11" fill="#64748b">{sub}</text>'
                f'<g transform="translate(16,54) scale({scale})">{content}</g></g>')
    metal = grp([OVAL], '#fde7ec', '#e11d48') + grp(LET, '#eef2f7', '#64748b') + grp(KW, '#fff3e0', '#d97706')
    _sil = acr_sil(g)
    def line(ps, st, w, op=1.0):
        return ''.join(f'<path d="{_d_front(p)}" fill="none" stroke="{st}" stroke-width="{w}" stroke-opacity="{op}"/>' for p in ps)
    acr = grp(_sil, '#e3f4ec', '#059669') + line(LET + RINGS + WLEAF, '#8fd3ac', 0.8, 0.6)
    CW = PANEL; CH = Hh*scale+130
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{CW:.0f}" height="{CH:.0f}" viewBox="0 0 {CW:.0f} {CH:.0f}">'
           f'<rect width="100%" height="100%" fill="#fff"/>'
           + box(10, 'CUT: METAL (stainless)', 'back plate + floor + trim + edges — DXF #1', metal, '#fffafb')
           + box(PANEL*0.5+10, 'CUT: ACRYLIC (P433)', 'outer silhouette (1 piece), art printed — DXF #2', acr, '#fafffb')
           + f'<text x="16" y="{CH-14:.0f}" font-family="sans-serif" font-size="12" fill="#5a6b8c" font-weight="700">NESTING — metal and acrylic cut on separate sheets (2 DXF)</text></svg>')
    return _png(svg, outpath, 1000)
