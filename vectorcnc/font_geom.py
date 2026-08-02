"""ดึง 'เส้นโค้งจริงในไฟล์ฟอนต์' ออกมาเป็น shapely (มม.) — ไม่ผ่านภาพเลยสักขั้น

ทำไมต้องทำ: ถ้าเราวาดตัวอักษรลงภาพก่อน ขอบที่ได้จะเป็นบันไดพิกเซลตั้งแต่ต้นทาง
            ต่อให้เกลาทีหลังแค่ไหน ก็เกลาบันไดที่เราสร้างขึ้นมาเอง
            ฟอนต์เก็บตัวอักษรเป็นเส้นโค้งเบซิเยร์อยู่แล้ว -> เอามาใช้ตรง ๆ เนียน 100%
"""
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen


class _RingPen(BasePen):
    """แปลง outline ของ glyph -> วงปิด (แตกเบซิเยร์ละเอียด)"""

    def __init__(self, glyphSet, steps=28):
        super().__init__(glyphSet)
        self.steps = steps
        self.rings = []
        self._cur = []
        self._pt = (0.0, 0.0)

    def _moveTo(self, p):
        if len(self._cur) > 2:
            self.rings.append(self._cur)
        self._cur = [p]; self._pt = p

    def _lineTo(self, p):
        self._cur.append(p); self._pt = p

    def _curveToOne(self, c1, c2, p):
        a = self._pt
        n = self.steps
        for i in range(1, n + 1):
            u = i / n; v = 1.0 - u
            self._cur.append((v**3*a[0] + 3*v*v*u*c1[0] + 3*v*u*u*c2[0] + u**3*p[0],
                              v**3*a[1] + 3*v*v*u*c1[1] + 3*v*u*u*c2[1] + u**3*p[1]))
        self._pt = p

    def _qCurveToOne(self, c, p):
        a = self._pt
        n = self.steps
        for i in range(1, n + 1):
            u = i / n; v = 1.0 - u
            self._cur.append((v*v*a[0] + 2*v*u*c[0] + u*u*p[0],
                              v*v*a[1] + 2*v*u*c[1] + u*u*p[1]))
        self._pt = p

    def _closePath(self):
        if len(self._cur) > 2:
            self.rings.append(self._cur)
        self._cur = []

    def _endPath(self):
        self._closePath()

    def done(self):
        if len(self._cur) > 2:
            self.rings.append(self._cur)
            self._cur = []
        return self.rings


def _rings_to_polys(rings):
    """วงซ้อนกัน -> เนื้อ/รู สลับตามชั้น (nonzero ของฟอนต์ = วงในกลับทิศอยู่แล้ว)"""
    ps = []
    for r in rings:
        if len(r) < 4:
            continue
        try:
            p = Polygon(r)
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty and p.area > 1e-9:
                ps.append(p)
        except Exception:
            continue
    if not ps:
        return None
    acc = None
    for p in ps:
        acc = p if acc is None else acc.symmetric_difference(p)
    return acc


def text_geom(ttf_path, text, width_mm=600.0, tracking=0.0, steps=28):
    """คืน (shapely, ความสูงจริง มม.) — Y ชี้ลงเหมือนระบบพิกัดของแอป"""
    f = TTFont(ttf_path, fontNumber=0, lazy=True)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    upm = float(f["head"].unitsPerEm or 1000)
    hmtx = f["hmtx"]
    parts = []
    x = 0.0
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            x += upm * 0.3
            continue
        try:
            pen = _RingPen(gs, steps=steps)
            gs[gname].draw(pen)
            rings = pen.done()
            g = _rings_to_polys([[(px + x, -py) for px, py in r] for r in rings])
            if g is not None and not g.is_empty:
                parts.append(g)
        except Exception:
            pass
        try:
            adv = hmtx[gname][0]
        except Exception:
            adv = upm * 0.5
        x += float(adv) + float(tracking) * upm
    f.close()
    if not parts:
        return None, 0.0
    g = unary_union(parts)
    b = g.bounds
    w = b[2] - b[0]
    if w <= 0:
        return None, 0.0
    sc = float(width_mm) / w
    from shapely.affinity import scale as _sc, translate as _tr
    g = _sc(g, xfact=sc, yfact=sc, origin=(b[0], b[1]))
    b2 = g.bounds
    return _tr(g, xoff=-b2[0], yoff=-b2[1]), (b2[3] - b2[1])


if __name__ == "__main__":
    import os, sys
    p = sys.argv[1] if len(sys.argv) > 1 else "fonts/Sacramento-Regular.ttf"
    t = sys.argv[2] if len(sys.argv) > 2 else "Champagne"
    g, h = text_geom(p, t, 600.0)
    b = g.bounds
    n = len(g.geoms) if g.geom_type == "MultiPolygon" else 1
    print("%s '%s' -> %s %d ชิ้น · %.1f x %.1f มม. · จุดขอบรวม %d"
          % (os.path.basename(p), t, g.geom_type, n, b[2]-b[0], b[3]-b[1],
             sum(len(q.exterior.coords) + sum(len(r.coords) for r in q.interiors)
                 for q in (g.geoms if g.geom_type == "MultiPolygon" else [g]))))
