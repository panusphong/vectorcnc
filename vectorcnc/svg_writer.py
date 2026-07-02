"""ขั้นที่ 6a: เขียน SVG แบบแยก layer ต่อสี — ไฟล์กลางที่ CAD ตัวไหนก็ import ได้
(Fusion 360 / Rhino / SolidWorks / Blender). เฟสถัดไปเพิ่ม writer สำหรับ DXF ด้วย ezdxf."""


def bgr_hex(c):
    return '#%02x%02x%02x' % (int(c[2]), int(c[1]), int(c[0]))


def write_layered(layers, W, H, path):
    """layers = [(name, color_bgr, shapes), ...]"""
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
         f'viewBox="0 0 {W} {H}">']
    for name, color, shapes in layers:
        col = bgr_hex(color)
        s.append(f'  <g id="layer_{name}" data-color="{col}">')
        for kind, d in shapes:
            if kind == 'circle':
                x, y, r = d
                s.append(f'    <circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" '
                         f'fill="none" stroke="{col}"/>')
            else:
                dd = 'M ' + ' L '.join(f'{int(x)},{int(y)}' for x, y in d) + ' Z'
                s.append(f'    <path d="{dd}" fill="none" stroke="{col}"/>')
        s.append('  </g>')
    s.append('</svg>')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(s))
