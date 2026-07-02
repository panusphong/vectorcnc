"""ต่อทุกขั้นเป็นเส้นเดียว: ภาพ -> เวกเตอร์แยก layer + สถิติ + รายงาน CNC"""
import cv2
from . import preprocess, segment, vectorize, cnc_rules, svg_writer, cnc_export


def process(image_path, out_svg, n_colors=6):
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    H, W = img.shape[:2]

    den = preprocess.denoise(img)
    _, centers, labels = preprocess.quantize(den, n_colors)
    bg = segment.detect_bg_label(labels)
    masks = segment.color_masks(labels, centers, bg_label=bg)

    layers, raw_total, smart_total = [], 0, 0
    for lab, color, m in masks:
        shapes, raw = vectorize.fit_mask(m)
        if not shapes:
            continue
        raw_total += raw
        smart_total += vectorize.count_nodes(shapes)
        layers.append((str(lab), color, shapes))

    svg_writer.write_layered(layers, W, H, out_svg)
    rep = cnc_rules.report([(n, s) for n, c, s in layers])
    return {
        'size': (W, H),
        'layers': layers,
        'n_layers': len(layers),
        'raw_nodes': raw_total,
        'smart_nodes': smart_total,
        'reduction_pct': (100 * (raw_total - smart_total) / raw_total) if raw_total else 0,
        'cnc_report': rep,
    }


def process_cnc(image_path, out_svg_mm, out_dxf=None, n_colors=6,
                real_width_mm=1200.0, kerf_mm=3.0, tool_mm=6.0, min_mm=2.0,
                round_corners=True, tabs=0):
    """ไฟล์พร้อมตัด + พร้อม Fusion: สเกลมม.จริง + kerf + ฟิลเล็ตมุม + ตัด feature เล็ก + DXF"""
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)
    H, W = img.shape[:2]
    ppm = W / float(real_width_mm) if real_width_mm else 1.0

    den = preprocess.denoise(img)
    _, centers, labels = preprocess.quantize(den, n_colors)
    bg = segment.detect_bg_label(labels)
    masks = segment.color_masks(labels, centers, bg_label=bg)

    layers, total_rings = [], 0
    for lab, color, m in masks:
        shapes, _ = vectorize.fit_mask(m)
        if not shapes:
            continue
        rings = cnc_export.process_layer(shapes, ppm, kerf_mm=kerf_mm, tool_mm=tool_mm,
                                         min_mm=min_mm, round_corners=round_corners, tabs=tabs)
        if rings:
            layers.append((str(lab), svg_writer.bgr_hex(color), rings))
            total_rings += len(rings)

    svg_mm = cnc_export.svg_string(layers, W, H, ppm, mm=True)
    svg_px = cnc_export.svg_string(layers, W, H, ppm, mm=False)
    with open(out_svg_mm, 'w', encoding='utf-8') as f:
        f.write(svg_mm)
    if out_dxf:
        cnc_export.write_dxf(layers, out_dxf, ppm, H)
    return {
        'size_px': (W, H),
        'size_mm': (round(W / ppm, 1), round(H / ppm, 1)),
        'ppm': ppm,
        'n_layers': len(layers),
        'n_rings': total_rings,
        'svg_mm': svg_mm,
        'svg_px': svg_px,
        'layer_colors': [c for n, c, r in layers],
    }
