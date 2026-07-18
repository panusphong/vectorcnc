"""
job_packet.py — "กาว" ปิดงานเซลล์คนเดียว

  1) quote_html(job)   -> ใบเสนอราคา + ยืนยันแบบ (HTML A4 พร้อมพิมพ์เป็น PDF)
                          ภาษาไทยเป๊ะด้วยฟอนต์ Prompt · มีภาพแบบบนผนัง + ขนาด + ราคา
                          + เงื่อนไข + ช่องเซ็นอนุมัติ  -> ส่งลูกค้าปิดการขาย

  2) packet_zip(job, files) -> ซองงานเข้าโรงงาน (.zip)
                          รวมทุกไฟล์ที่โรงงานต้องใช้ในชุดเดียว:
                          ไฟล์ตัด DXF · ไฟล์พิมพ์ .ai · สเปคชีต · BOM · ใบปะหน้า (Job No.)
                          -> โรงงานเปิดซองเดียว ผลิตได้เลย ไม่ต้องถามกลับ

ทั้งคู่ประกอบจากข้อมูลที่เซลล์กรอก/สร้างไว้แล้ว — ไม่ต้องกรอกซ้ำ
"""

import io
import re
import html
import base64
import zipfile
import datetime

JOB_PACKET_VERSION = "2026-07-15-quote+packet"

FONT = "https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;600;700;800&display=swap"


def _esc(s):
    return html.escape(str(s or ""))


def _money(v):
    try:
        return "{:,.0f}".format(float(v))
    except Exception:
        return str(v or "-")


def _today():
    return datetime.datetime.now().strftime("%d/%m/%Y")


def gen_job_no(prefix="VC"):
    return prefix + datetime.datetime.now().strftime("-%y%m%d-%H%M")


# ════════════════════════════════════════════════ 1) ใบเสนอราคา (HTML)
def quote_html(job):
    """
    job = {
      job_no, date, company, company_tel, company_addr, logo_b64,
      customer, customer_contact,
      sign_type_name, w_cm, h_cm, material, qty,
      mockup_b64,                       # ภาพแบบบนผนัง (data URI หรือ base64 ล้วน)
      items: [{name, detail, qty, unit_price, amount}],
      subtotal, discount, vat_pct, total,
      note, valid_days, deposit_pct
    }
    """
    j = job or {}
    items = j.get("items") or []
    if not items:
        # ถ้าไม่ส่งรายการมา สร้างจากข้อมูลป้ายหลัก 1 บรรทัด
        items = [{
            "name": j.get("sign_type_name", "ป้าย"),
            "detail": _size_txt(j),
            "qty": j.get("qty", 1),
            "unit_price": j.get("total", 0),
            "amount": j.get("total", 0),
        }]

    rows = ""
    for i, it in enumerate(items, 1):
        rows += (
            "<tr>"
            f"<td class='c'>{i}</td>"
            f"<td><b>{_esc(it.get('name'))}</b>"
            + (f"<div class='dt'>{_esc(it.get('detail'))}</div>" if it.get("detail") else "")
            + "</td>"
            f"<td class='c'>{_esc(it.get('qty', 1))}</td>"
            f"<td class='r'>{_money(it.get('unit_price'))}</td>"
            f"<td class='r'>{_money(it.get('amount'))}</td>"
            "</tr>"
        )

    subtotal = j.get("subtotal")
    if subtotal is None:
        subtotal = sum(float(it.get("amount", 0) or 0) for it in items)
    disc = float(j.get("discount", 0) or 0)
    vat_pct = float(j.get("vat_pct", 7) or 0)
    after = subtotal - disc
    vat = after * vat_pct / 100.0
    total = j.get("total")
    total = (after + vat) if total is None else float(total)

    mock = _data_uri(j.get("mockup_b64"))
    logo = _data_uri(j.get("logo_b64"))
    valid = j.get("valid_days", 7)
    deposit = j.get("deposit_pct", 50)

    sumrows = f"<div class='sr'><span>รวมเป็นเงิน</span><b>{_money(subtotal)}</b></div>"
    if disc > 0:
        sumrows += f"<div class='sr'><span>ส่วนลด</span><b>-{_money(disc)}</b></div>"
    if vat_pct > 0:
        sumrows += f"<div class='sr'><span>VAT {vat_pct:.0f}%</span><b>{_money(vat)}</b></div>"

    return f"""<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ใบเสนอราคา {_esc(j.get('job_no'))}</title>
<link href="{FONT}" rel="stylesheet">
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:'Prompt',sans-serif;color:#1b2a4a;background:#eef1f6;line-height:1.5}}
  .pg{{max-width:820px;margin:16px auto;background:#fff;padding:38px 42px;box-shadow:0 4px 24px rgba(0,0,0,.08)}}
  .top{{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #2563eb;padding-bottom:16px}}
  .co{{display:flex;gap:12px;align-items:center}}
  .co img{{height:46px}}
  .co h1{{font-size:19px;font-weight:800}}
  .co .a{{font-size:11.5px;color:#5a6b8c;margin-top:2px}}
  .qh{{text-align:right}}
  .qh .t{{font-size:22px;font-weight:800;color:#2563eb}}
  .qh .m{{font-size:12px;color:#5a6b8c;margin-top:3px}}
  .meta{{display:flex;justify-content:space-between;margin-top:16px;font-size:13px}}
  .meta .b{{background:#f5f8fc;border:1px solid #e6ecf5;border-radius:10px;padding:10px 14px;min-width:230px}}
  .meta .k{{color:#8a99b5;font-size:11px}}
  .mock{{margin:18px 0;text-align:center;background:#f8fafc;border:1px solid #e6ecf5;border-radius:12px;padding:12px}}
  .mock img{{max-width:100%;max-height:340px;border-radius:8px}}
  .mock .cap{{font-size:11.5px;color:#8a99b5;margin-top:6px}}
  table{{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}}
  th{{background:#2563eb;color:#fff;padding:9px 10px;text-align:left;font-weight:600;font-size:12px}}
  th.c,td.c{{text-align:center}} th.r,td.r{{text-align:right}}
  td{{padding:9px 10px;border-bottom:1px solid #eef1f6;vertical-align:top}}
  .dt{{font-size:11px;color:#8a99b5;margin-top:2px}}
  .sum{{margin-top:12px;margin-left:auto;width:280px}}
  .sr{{display:flex;justify-content:space-between;padding:4px 2px;font-size:13px;color:#5a6b8c}}
  .sr b{{color:#1b2a4a}}
  .tot{{display:flex;justify-content:space-between;padding:11px 14px;margin-top:6px;background:#2563eb;color:#fff;border-radius:10px;font-weight:800;font-size:16px}}
  .cond{{margin-top:22px;font-size:12px;color:#5a6b8c;background:#f8fafc;border:1px solid #e6ecf5;border-radius:10px;padding:13px 16px}}
  .cond b{{color:#1b2a4a}}
  .sign{{display:flex;justify-content:space-between;margin-top:34px;gap:40px}}
  .sign .box{{flex:1;text-align:center}}
  .sign .ln{{border-top:1px dashed #b9c4d8;margin-top:46px;padding-top:6px;font-size:12px;color:#8a99b5}}
  .noprint{{text-align:center;margin:14px}}
  .btn{{font-family:inherit;font-size:14px;font-weight:700;padding:11px 26px;border-radius:10px;border:0;background:#2563eb;color:#fff;cursor:pointer}}
  @media print{{.noprint{{display:none}} body{{background:#fff}} .pg{{box-shadow:none;margin:0;max-width:none}}}}
</style></head><body>

<div class="noprint"><button class="btn" onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button></div>

<div class="pg">
  <div class="top">
    <div class="co">
      {f'<img src="{logo}" alt="">' if logo else ''}
      <div><h1>{_esc(j.get('company','VectorCNC'))}</h1>
      <div class="a">{_esc(j.get('company_addr',''))}{(' · โทร '+_esc(j.get('company_tel'))) if j.get('company_tel') else ''}</div></div>
    </div>
    <div class="qh"><div class="t">ใบเสนอราคา</div>
      <div class="m">QUOTATION</div>
      <div class="m">เลขที่ {_esc(j.get('job_no'))}</div>
      <div class="m">วันที่ {_esc(j.get('date') or _today())}</div>
    </div>
  </div>

  <div class="meta">
    <div class="b"><div class="k">ลูกค้า</div><b>{_esc(j.get('customer','-'))}</b>
      <div style="font-size:12px;color:#5a6b8c">{_esc(j.get('customer_contact',''))}</div></div>
    <div class="b"><div class="k">รายละเอียดงาน</div>
      <b>{_esc(j.get('sign_type_name','ป้าย'))}</b>
      <div style="font-size:12px;color:#5a6b8c">{_size_txt(j)}{(' · '+_esc(j.get('material'))) if j.get('material') else ''}</div></div>
  </div>

  {f'<div class="mock"><img src="{mock}" alt="แบบป้าย"><div class="cap">ภาพจำลองแบบป้ายบนผนังจริง (ตามสเกล)</div></div>' if mock else ''}

  <table>
    <thead><tr><th class="c">#</th><th>รายการ</th><th class="c">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">รวม (บาท)</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>

  <div class="sum">{sumrows}
    <div class="tot"><span>ยอดสุทธิ</span><span>{_money(total)} ฿</span></div>
  </div>

  <div class="cond">
    <b>เงื่อนไข</b><br>
    · ยืนราคา {_esc(valid)} วัน · มัดจำ {_esc(deposit)}% ก่อนเริ่มงาน ส่วนที่เหลือชำระก่อนติดตั้ง<br>
    · ราคานี้รวมค่าผลิต ยังไม่รวมค่าติดตั้ง/ขนส่ง (แจ้งแยกตามหน้างาน)<br>
    {('· '+_esc(j.get('note'))+'<br>') if j.get('note') else ''}
    · แบบและขนาดตามภาพจำลอง — โปรดตรวจสอบก่อนเซ็นอนุมัติ
  </div>

  <div class="sign">
    <div class="box"><div class="ln">ผู้เสนอราคา (เซลล์) / วันที่</div></div>
    <div class="box"><div class="ln">ลูกค้าอนุมัติแบบ + ราคา / วันที่</div></div>
  </div>
</div>
</body></html>"""


def _size_txt(j):
    w = j.get("w_cm"); h = j.get("h_cm")
    if w and h:
        return f"{_esc(w)} × {_esc(h)} ซม."
    return _esc(j.get("size", ""))


def _data_uri(b64):
    if not b64:
        return ""
    b64 = str(b64)
    if b64.startswith("data:"):
        return b64
    return "data:image/png;base64," + b64


# ════════════════════════════════════════════════ 2) ซองงานเข้าโรงงาน (.zip)
def _b64bytes(b64):
    if not b64:
        return None
    b64 = str(b64)
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    try:
        return base64.b64decode(b64)
    except Exception:
        return None


def _safe(name):
    return re.sub(r"[^\w\-.]+", "_", str(name or "job"))[:60]


def packet_zip(job, files):
    """
    job   = ข้อมูลเดียวกับ quote (ใช้ทำใบปะหน้า)
    files = {
      "dxf_b64":   ... ,   # ไฟล์ตัด CNC/เลเซอร์
      "svg_b64":   ... ,   # เส้นตัด SVG (LightBurn)
      "ai_b64":    ... ,   # ไฟล์งานพิมพ์ .ai
      "spec_svg":  "<svg…>",  # สเปคชีตแยกชั้น (string)
      "spec3d_svg":"<svg…>",  # ภาพ 3 มิติ
      "bom":       [ {item, spec, qty, unit}, ... ],  # รายการวัสดุ
    }
    return: (zip_bytes, filename, manifest_list)
    """
    j = job or {}
    fs = files or {}
    jobno = _safe(j.get("job_no") or gen_job_no())
    base = f"{jobno}_{_safe(j.get('customer','job'))}"

    buf = io.BytesIO()
    manifest = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # ใบปะหน้าโรงงาน (อ่านง่าย ไทยเป๊ะ)
        cover = _cover_html(j, fs)
        z.writestr(f"{base}/00_ใบปะหน้า-โรงงาน.html", cover.encode("utf-8"))
        manifest.append("ใบปะหน้าโรงงาน (Job Cover)")

        pairs = [
            ("dxf_b64",  f"{base}/ไฟล์ตัด.dxf",        "ไฟล์ตัด DXF (CypCut/Fiber)"),
            ("svg_b64",  f"{base}/ไฟล์ตัด.svg",        "ไฟล์ตัด SVG (LightBurn)"),
            ("ai_b64",   f"{base}/งานพิมพ์.ai",         "ไฟล์งานพิมพ์ .ai (ฝังภาพ + ไดคัท)"),
        ]
        for key, path, label in pairs:
            raw = _b64bytes(fs.get(key))
            if raw:
                z.writestr(path, raw)
                manifest.append(label)

        if fs.get("spec_svg"):
            z.writestr(f"{base}/สเปคชีต-แยกชั้น.svg", str(fs["spec_svg"]).encode("utf-8"))
            manifest.append("สเปคชีตแยกชั้น (SVG)")
        if fs.get("spec3d_svg"):
            z.writestr(f"{base}/ภาพ3มิติ.svg", str(fs["spec3d_svg"]).encode("utf-8"))
            manifest.append("ภาพ 3 มิติ (SVG)")

        bom = fs.get("bom") or []
        if bom:
            z.writestr(f"{base}/BOM-รายการวัสดุ.html", _bom_html(j, bom).encode("utf-8"))
            manifest.append("BOM รายการวัสดุ")

    return buf.getvalue(), base + ".zip", manifest


def _cover_html(j, fs):
    mock = _data_uri((fs or {}).get("mockup_b64") or j.get("mockup_b64"))
    chk = ""
    for k, label in [("dxf_b64", "ไฟล์ตัด DXF"), ("svg_b64", "ไฟล์ตัด SVG"),
                     ("ai_b64", "ไฟล์งานพิมพ์ .ai"), ("spec_svg", "สเปคชีตแยกชั้น"),
                     ("bom", "BOM รายการวัสดุ")]:
        has = bool((fs or {}).get(k))
        chk += f"<li>{'✅' if has else '⬜'} {_esc(label)}</li>"

    return f"""<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
<link href="{FONT}" rel="stylesheet">
<style>
 body{{font-family:'Prompt',sans-serif;color:#1b2a4a;max-width:760px;margin:20px auto;padding:0 20px;line-height:1.55}}
 h1{{font-size:22px;border-bottom:3px solid #2563eb;padding-bottom:10px}}
 .jn{{font-size:15px;color:#2563eb;font-weight:800}}
 .grid{{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}}
 .c{{background:#f5f8fc;border:1px solid #e6ecf5;border-radius:10px;padding:11px 14px}}
 .k{{font-size:11px;color:#8a99b5}} .v{{font-weight:700;font-size:14px}}
 ul{{list-style:none;padding:0;font-size:14px}} li{{padding:4px 0}}
 img{{max-width:100%;max-height:320px;border:1px solid #e6ecf5;border-radius:10px;margin-top:8px}}
 .warn{{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:11px 14px;font-size:12.5px;color:#92400e;margin-top:14px}}
</style></head><body>
<h1>🏭 ใบปะหน้างานเข้าผลิต</h1>
<div class="jn">เลขงาน {_esc(j.get('job_no'))} · วันที่ {_esc(j.get('date') or _today())}</div>
<div class="grid">
  <div class="c"><div class="k">ลูกค้า</div><div class="v">{_esc(j.get('customer','-'))}</div></div>
  <div class="c"><div class="k">เซลล์ผู้สั่ง</div><div class="v">{_esc(j.get('sales','-'))}</div></div>
  <div class="c"><div class="k">ประเภทป้าย</div><div class="v">{_esc(j.get('sign_type_name','-'))}</div></div>
  <div class="c"><div class="k">ขนาด</div><div class="v">{_size_txt(j)}</div></div>
  <div class="c"><div class="k">วัสดุ</div><div class="v">{_esc(j.get('material','-'))}</div></div>
  <div class="c"><div class="k">จำนวน</div><div class="v">{_esc(j.get('qty',1))} ชุด</div></div>
</div>
<h3>ไฟล์ในซองนี้</h3>
<ul>{chk}</ul>
{f'<img src="{mock}" alt="แบบ">' if mock else ''}
<div class="warn">⚠️ โปรดผลิตตามสเปค/ขนาดในไฟล์นี้ · หากพบข้อสงสัยติดต่อเซลล์ผู้สั่งก่อนตัด/พิมพ์</div>
</body></html>"""


def _bom_html(j, bom):
    rows = ""
    for i, b in enumerate(bom, 1):
        rows += (f"<tr><td>{i}</td><td>{_esc(b.get('item'))}</td>"
                 f"<td>{_esc(b.get('spec',''))}</td>"
                 f"<td style='text-align:center'>{_esc(b.get('qty',''))}</td>"
                 f"<td>{_esc(b.get('unit',''))}</td></tr>")
    return f"""<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
<link href="{FONT}" rel="stylesheet">
<style>body{{font-family:'Prompt',sans-serif;max-width:760px;margin:20px auto;padding:0 20px;color:#1b2a4a}}
h1{{font-size:19px}} table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}}
th{{background:#2563eb;color:#fff;padding:8px;text-align:left}} td{{padding:7px 8px;border-bottom:1px solid #eef1f6}}</style>
</head><body>
<h1>📋 BOM — รายการวัสดุ · งาน {_esc(j.get('job_no'))}</h1>
<table><thead><tr><th>#</th><th>วัสดุ/ชิ้นส่วน</th><th>สเปค</th><th>จำนวน</th><th>หน่วย</th></tr></thead>
<tbody>{rows}</tbody></table>
</body></html>"""
