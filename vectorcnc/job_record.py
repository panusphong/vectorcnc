"""job_record.py — สร้าง 'บันทึกงาน' ต่อ job (metadata) สำหรับเก็บลง Google Drive + JobRegistry Sheet
รองรับค้นหา/filter ตาม เวลา · เซลล์ · ลูกค้า
"""
import json, os, datetime

# คอลัมน์ของ JobRegistry (Google Sheet index)
REGISTRY_COLUMNS = [
    'created_at', 'job_id', 'sales', 'customer', 'sign_type', 'size_cm', 'material',
    'install', 'led_color', 'yokkob_outer_cm', 'yokkob_letter_cm', 'wire',
    'material_cost', 'labor_oh', 'damage', 'total', 'led_total_m', 'transformer',
    'drive_folder_url', 'note',
]

def build_record(job_id, sales, customer, params, cost, files=None, note=''):
    """รวม metadata ของ job 1 ใบ · files = {check_sheet,finished,exploded,led_plan,nesting,dxf_metal,dxf_acrylic,drive_folder}"""
    p = cost.get('params', {}); led = cost.get('led', {})
    wtype = 'VCT' if p.get('install') == 'outdoor' else 'THW'
    return {
        'created_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'job_id': job_id, 'sales': sales or '', 'customer': customer or '',
        'sign_type': cost.get('sign_type'),
        'size_cm': f"{params.get('real_width_cm')}x{params.get('real_height_cm')}",
        'material': p.get('metal_cat'), 'install': p.get('install'), 'led_color': p.get('led_color'),
        'yokkob_outer_cm': p.get('yokkob_outer_cm'), 'yokkob_letter_cm': p.get('yokkob_letter_cm'),
        'wire': f"{wtype} {params.get('wire_gauge','2.5')} x {params.get('wire_length_m','?')}m",
        'material_cost': cost['material'], 'labor_oh': cost['labor'], 'damage': cost['damage'],
        'total': cost['total'], 'led_total_m': led.get('total_m'),
        'transformer': (led.get('transformer') or {}).get('name'),
        'files': files or {}, 'note': note,
        'rows': cost['rows'], 'inventory_payload': cost.get('inventory_payload', []),
    }

def registry_row(rec):
    """แถวเดียวสำหรับ append ลง JobRegistry Sheet (ตามลำดับ REGISTRY_COLUMNS)"""
    f = rec.get('files', {})
    return [rec['created_at'], rec['job_id'], rec['sales'], rec['customer'], rec['sign_type'],
            rec['size_cm'], rec['material'], rec['install'], rec['led_color'],
            rec['yokkob_outer_cm'], rec['yokkob_letter_cm'], rec['wire'],
            rec['material_cost'], rec['labor_oh'], rec['damage'], rec['total'],
            rec['led_total_m'], rec['transformer'], f.get('drive_folder', ''), rec['note']]

def save_manifest(rec, outdir):
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, 'manifest.json')
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=2)
    return p

def drive_folder_path(rec):
    """โครงโฟลเดอร์ใน Drive: SaaiTech_Jobs/{YYYY-MM}/{jobid}_{customer}"""
    ym = rec['created_at'][:7]
    cust = (rec['customer'] or 'nocust').replace('/', '-')[:40]
    return f"SaaiTech_Jobs/{ym}/{rec['job_id']}_{cust}"
