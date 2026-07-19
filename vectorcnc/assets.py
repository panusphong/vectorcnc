"""
assets.py — PDF/AI Asset Extractor
แตก "ของ" ออกจากไฟล์ลูกค้า (PDF / .ai / .eps ที่แปลงเป็น PDF แล้ว)

ปัญหาที่แก้: ลูกค้าส่งเมนู/นามบัตร/โบรชัวร์เป็น PDF มา
กราฟิกต้องเปิดหา โลโก้ → capture → ลากใหม่ใน Illustrator (เสียเวลามาก)

โมดูลนี้:
  1) list_assets(path) -> แตกทุก object: vector cluster / ภาพฝังใน / ข้อความ(+ชื่อฟอนต์)
     พร้อม thumbnail PNG (base64) + ขนาดจริง (mm)
  2) crop_vector(path, page, bbox) -> PDF ที่ครอปเฉพาะ object นั้น
     **คงความเป็นเวกเตอร์ 100%** (ไม่ trace ใหม่) -> เปลี่ยนสกุลเป็น .ai เปิดใน AI ได้เลย
  3) extract_image(path, xref) -> PNG bytes (ส่งต่อไป trace ได้)
"""

ASSETS_VERSION = "2026-07-12-pdf-asset-extract"

import base64
import io
import os

PT2MM = 25.4 / 72.0


# ---------------------------------------------------------------- helpers
def _fitz():
    import fitz  # PyMuPDF
    return fitz


def _b64png(data):
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _rects_close(a, b, gap):
    """สองกรอบใกล้กัน/ซ้อนกันไหม (ขยาย gap pt)"""
    return not (a[2] + gap < b[0] or b[2] + gap < a[0] or
                a[3] + gap < b[1] or b[3] + gap < a[1])


def _union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _cluster(rects, gap):
    """รวมกรอบที่ติดกันเป็นก้อนเดียว (union-find แบบง่าย + วนจนนิ่ง)"""
    boxes = [list(r) + [[i]] for i, r in enumerate(rects)]
    changed = True
    while changed:
        changed = False
        out = []
        for b in boxes:
            hit = None
            for o in out:
                if _rects_close(b[:4], o[:4], gap):
                    hit = o
                    break
            if hit is None:
                out.append(b)
            else:
                u = _union(hit[:4], b[:4])
                hit[0], hit[1], hit[2], hit[3] = u
                hit[4] = hit[4] + b[4]
                changed = True
        boxes = out
    return boxes


def _thumb(page, rect, max_px=260):
    """เรนเดอร์เฉพาะกรอบ -> PNG base64"""
    fitz = _fitz()
    r = fitz.Rect(*rect)
    if r.width < 1 or r.height < 1:
        return ""
    zoom = min(max_px / max(r.width, 1.0), max_px / max(r.height, 1.0), 6.0)
    zoom = max(zoom, 0.3)
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=r, alpha=False)
        return _b64png(pix.tobytes("png"))
    except Exception:
        return ""


# ---------------------------------------------------------------- main
def list_assets(path, max_pages=6, min_mm=6.0, max_assets=60):
    """
    คืน dict:
      {"pages": n, "page_size_mm": [w,h], "assets": [...]}
    asset = {
      "id", "kind": vector|image|text|page, "page", "bbox"(pt),
      "w_mm","h_mm", "thumb", "label", "vector": bool,
      "info": {...}   # เช่น ฟอนต์ / จำนวนเส้น / dpi
    }
    """
    fitz = _fitz()
    doc = fitz.open(path)
    out = []
    npg = min(len(doc), max_pages)
    psize = [0.0, 0.0]
    aid = 0

    for pno in range(npg):
        page = doc[pno]
        pr = page.rect
        if pno == 0:
            psize = [round(pr.width * PT2MM, 1), round(pr.height * PT2MM, 1)]

        # ---- 1) ทั้งหน้า (ไว้ให้เลือกกรณีอยากได้ทั้งแผ่น)
        aid += 1
        out.append({
            "id": aid, "kind": "page", "page": pno,
            "bbox": [pr.x0, pr.y0, pr.x1, pr.y1],
            "w_mm": round(pr.width * PT2MM, 1), "h_mm": round(pr.height * PT2MM, 1),
            "thumb": _thumb(page, (pr.x0, pr.y0, pr.x1, pr.y1)),
            "label": "หน้า %d (ทั้งหน้า)" % (pno + 1),
            "vector": True, "info": {},
        })

        # ---- 2) ภาพฝังใน (ไม่ซ้ำ xref + มีเพดานกันไฟล์ผลิตซ้ำหลายร้อยชิ้น)
        _seen_xref = set()
        try:
            for im in page.get_images(full=True):
                if len(out) >= max_assets:
                    break
                xref = im[0]
                if xref in _seen_xref:
                    continue
                _seen_xref.add(xref)
                try:
                    rs = page.get_image_rects(xref)
                except Exception:
                    rs = []
                if not rs:
                    continue
                r = rs[0]
                wmm = r.width * PT2MM
                hmm = r.height * PT2MM
                if wmm < min_mm or hmm < min_mm:
                    continue
                iw, ih = int(im[2] or 0), int(im[3] or 0)
                dpi = 0
                if wmm > 0:
                    dpi = int(iw / (wmm / 25.4)) if wmm else 0
                aid += 1
                out.append({
                    "id": aid, "kind": "image", "page": pno, "xref": int(xref),
                    "bbox": [r.x0, r.y0, r.x1, r.y1],
                    "w_mm": round(wmm, 1), "h_mm": round(hmm, 1),
                    "thumb": _thumb(page, (r.x0, r.y0, r.x1, r.y1)),
                    "label": "ภาพ %dx%d px (~%d dpi)" % (iw, ih, dpi),
                    "vector": False,
                    "info": {"px": [iw, ih], "dpi": dpi},
                })
        except Exception:
            pass

        # ---- 3) เวกเตอร์ (เส้น/รูปทรง) -> จับกลุ่ม
        try:
            draws = page.get_drawings()
        except Exception:
            draws = []
        rects = []
        for d in draws:
            r = d.get("rect")
            if r is None:
                continue
            if r.width < 0.4 and r.height < 0.4:
                continue
            # ตัดกรอบที่กินทั้งหน้า (พื้นหลัง)
            if r.width > pr.width * 0.97 and r.height > pr.height * 0.97:
                continue
            rects.append((r.x0, r.y0, r.x1, r.y1))
        if rects:
            # 🛡️ ไฟล์ผลิตซ้ำ (step&repeat) มีหลายร้อยชิ้น -> จำกัดจำนวนก่อนคลัสเตอร์ (กัน O(n²) + OOM)
            if len(rects) > 300:
                rects = sorted(rects, key=lambda r: -((r[2] - r[0]) * (r[3] - r[1])))[:300]
            gap = max(pr.width, pr.height) * 0.012   # ~1.2% ของหน้า
            for cb in _cluster(rects, gap):
                if len(out) >= max_assets:
                    break
                x0, y0, x1, y1 = cb[0], cb[1], cb[2], cb[3]
                wmm = (x1 - x0) * PT2MM
                hmm = (y1 - y0) * PT2MM
                if wmm < min_mm or hmm < min_mm:
                    continue
                aid += 1
                out.append({
                    "id": aid, "kind": "vector", "page": pno,
                    "bbox": [x0, y0, x1, y1],
                    "w_mm": round(wmm, 1), "h_mm": round(hmm, 1),
                    "thumb": _thumb(page, (x0, y0, x1, y1)),
                    "label": "เวกเตอร์ · %d เส้น" % len(cb[4]),
                    "vector": True,
                    "info": {"paths": len(cb[4])},
                })

        # ---- 4) ข้อความ (บอกฟอนต์ให้กราฟิกพิมพ์ตามได้)
        try:
            td = page.get_text("dict")
        except Exception:
            td = {"blocks": []}
        for blk in td.get("blocks", []):
            if len(out) >= max_assets:
                break
            if blk.get("type", 1) != 0:
                continue
            bb = blk.get("bbox")
            if not bb:
                continue
            wmm = (bb[2] - bb[0]) * PT2MM
            hmm = (bb[3] - bb[1]) * PT2MM
            if wmm < min_mm or hmm < 3.0:
                continue
            txt = ""
            fonts = set()
            sz = 0.0
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    txt += sp.get("text", "")
                    f = sp.get("font", "")
                    if f:
                        fonts.add(f)
                    sz = max(sz, float(sp.get("size", 0) or 0))
                txt += " "
            txt = " ".join(txt.split())
            if not txt:
                continue
            aid += 1
            out.append({
                "id": aid, "kind": "text", "page": pno,
                "bbox": [bb[0], bb[1], bb[2], bb[3]],
                "w_mm": round(wmm, 1), "h_mm": round(hmm, 1),
                "thumb": _thumb(page, (bb[0], bb[1], bb[2], bb[3])),
                "label": (txt[:40] + ("…" if len(txt) > 40 else "")),
                "vector": True,
                "info": {"text": txt, "fonts": sorted(fonts),
                         "size_pt": round(sz, 1)},
            })

    doc.close()

    # เรียง: เวกเตอร์ก่อน (มีค่าที่สุด) แล้วภาพ แล้วข้อความ แล้วทั้งหน้า
    order = {"vector": 0, "image": 1, "text": 2, "page": 3}
    out.sort(key=lambda a: (order.get(a["kind"], 9), -(a["w_mm"] * a["h_mm"])))
    return {"pages": npg, "page_size_mm": psize, "assets": out,
            "truncated": len(out) >= max_assets}


# ---------------------------------------------------------------- crop
def crop_vector(path, page_no, bbox, pad_pt=2.0, mode="clean"):
    """
    ครอปเฉพาะกรอบที่เลือก -> PDF bytes (คงความเป็นเวกเตอร์)
    เปลี่ยนสกุลเป็น .ai แล้วเปิดใน Illustrator ได้เลย

    mode="clean" (ค่าเริ่มต้น) — วาดใหม่เฉพาะเส้นเวกเตอร์ในกรอบ
        → ไฟล์เล็ก · ไม่มีภาพ raster ติดมา · path แก้ไขได้ใน AI
    mode="exact" — ฝังหน้าต้นฉบับแล้วครอป (เหมือนเป๊ะ แต่ไฟล์ใหญ่ อาจติดภาพมาด้วย)
    """
    fitz = _fitz()
    src = fitz.open(path)
    page = src[page_no]
    r = fitz.Rect(*bbox)
    r.x0 -= pad_pt
    r.y0 -= pad_pt
    r.x1 += pad_pt
    r.y1 += pad_pt
    r = r & page.rect

    if mode == "clean":
        try:
            draws = [d for d in page.get_drawings()
                     if d.get("rect") is not None and (d["rect"] & r).is_valid
                     and not (d["rect"] & r).is_empty]
        except Exception:
            draws = []
        if draws:
            out = fitz.open()
            np_ = out.new_page(width=page.rect.width, height=page.rect.height)
            sh = np_.new_shape()
            for d in draws:
                drew = False
                for it in d.get("items", []):
                    try:
                        op = it[0]
                        if op == "l":
                            sh.draw_line(it[1], it[2]); drew = True
                        elif op == "c":
                            sh.draw_bezier(it[1], it[2], it[3], it[4]); drew = True
                        elif op == "re":
                            sh.draw_rect(it[1]); drew = True
                        elif op == "qu":
                            sh.draw_quad(it[1]); drew = True
                    except Exception:
                        continue
                if not drew:
                    continue
                try:
                    sh.finish(
                        color=d.get("color"), fill=d.get("fill"),
                        width=float(d.get("width") or 0),
                        closePath=bool(d.get("closePath", True)),
                        even_odd=bool(d.get("even_odd", False)),
                        fill_opacity=float(d.get("fill_opacity", 1) or 1),
                        stroke_opacity=float(d.get("stroke_opacity", 1) or 1),
                    )
                except Exception:
                    try:
                        sh.finish(color=d.get("color"), fill=d.get("fill"))
                    except Exception:
                        pass
            sh.commit()
            np_.set_cropbox(r)          # artboard = เฉพาะโลโก้
            buf = out.tobytes(garbage=4, deflate=True, clean=True)
            out.close()
            src.close()
            return buf

    # exact / ไม่มีเส้นเวกเตอร์ -> ฝังหน้าแล้วครอป
    out = fitz.open()
    np_ = out.new_page(width=r.width, height=r.height)
    np_.show_pdf_page(fitz.Rect(0, 0, r.width, r.height), src, page_no, clip=r)
    buf = out.tobytes(garbage=4, deflate=True, clean=True)
    out.close()
    src.close()
    return buf


def extract_image(path, xref):
    """ดึงภาพฝังในออกมาเป็น PNG bytes"""
    fitz = _fitz()
    doc = fitz.open(path)
    try:
        pix = fitz.Pixmap(doc, int(xref))
        if pix.n - pix.alpha >= 4:          # CMYK -> RGB
            pix = fitz.Pixmap(fitz.csRGB, pix)
        data = pix.tobytes("png")
    finally:
        doc.close()
    return data


def render_region_png(path, page_no, bbox, dpi=300):
    """เรนเดอร์กรอบที่เลือกเป็น PNG ความละเอียดสูง (ใช้ trace ต่อได้)"""
    fitz = _fitz()
    doc = fitz.open(path)
    try:
        page = doc[page_no]
        r = fitz.Rect(*bbox) & page.rect
        z = float(dpi) / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(z, z), clip=r, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()
