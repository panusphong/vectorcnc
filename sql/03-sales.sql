-- ═══════════════════════════════════════════════════════════════════
--  คีย์ยอดขาย · Sales Report — ตารางกระจกของแท็บชีตขาย
--
--  ชื่อคอลัมน์ยกมาจาก SALES_HEADERS ในโค้ดเดิม (v34.3) แบบตรงตัว
--  เพื่อให้ซิงค์จากชีตแล้วเทียบกันได้ทันทีโดยไม่ต้องแปลชื่อ
--  (+ 'บริษัทที่ขาย' และ 'ยอดขายก่อน VAT' ที่เพิ่มมาทีหลังในชีตจริง)
--
--  ‼ ช่วงใช้ 2 ระบบคู่กัน: ตารางนี้เป็น "กระจกอ่านอย่างเดียว"
--    ชีตคือแหล่งความจริง ระบบใหม่ห้ามเขียนกลับเด็ดขาด
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create table if not exists app.total_sales (
  _id    bigserial primary key,
  _row   integer not null,                 -- เลขแถวในชีต = คีย์ของการซิงค์
  _hash  text,                             -- ลายนิ้วมือของแถว ใช้ข้ามแถวที่ไม่เปลี่ยน
  _synced_at timestamptz not null default now(),

  "Alert"                    text,
  "รหัสงาน"                   text,
  "วันที่ติดต่อ"                date,
  "ชื่อบริษัท"                 text,
  "ชื่อผู้ติดต่อ"               text,
  "เบอร์ติดต่อ"                text,
  "ประเภทลูกค้า"               text,
  "ลูกค้ามาจากไหน"             text,
  "วิธีติดต่อ"                 text,
  "ชื่อช่อง / Platform"        text,
  "Lead Status"              text,
  "วันที่อัพเดต"               date,
  "หมายเหตุ"                  text,
  "วันที่ปิดการขาย"             date,
  "ผู้ผลิต"                   text,
  "ยอดสั่งซื้อ (Outsource)"     numeric(14,2),
  "ยอดประเมินราคา"             numeric(14,2),
  "เลขที่ QO / IV"             text,
  "ยอดขาย (บาท)"              numeric(14,2),
  "หมายเหตุชำระเงิน"           text,
  "ยอดเรียกเก็บ (บาท)"         numeric(14,2),
  "รับจริง (บาท)"              numeric(14,2),
  "รับขาด (บาท)"               numeric(14,2),

  -- ชำระเต็มจำนวน
  "วันที่โอน"                  date,
  "เลขสลิป"                   text,
  "ยอด (บาท)"                 numeric(14,2),
  -- แบ่งงวด 1–3
  "วันที่โอน งวด 1"            date,
  "เลขสลิป งวด 1"             text,
  "ยอด งวด 1 (บาท)"           numeric(14,2),
  "วันที่โอน งวด 2"            date,
  "เลขสลิป งวด 2"             text,
  "ยอด งวด 2 (บาท)"           numeric(14,2),
  "วันที่โอน งวด 3"            date,
  "เลขสลิป งวด 3"             text,
  "ยอด งวด 3 (บาท)"           numeric(14,2),

  -- คอลัมน์ระบบ
  "Sales Code"               text,
  "Sales Name"               text,
  "Contact ID"               text,
  "Created At"               timestamptz,
  "Updated At"               timestamptz,
  "Created By"               text,
  -- ชีตจริงมีทั้ง 'Create By' (สะกดแบบนี้ ไม่มี d — โค้ดเดิมใช้ 64 จุด)
  -- และ 'Created By' ที่เป็นคอลัมน์ระบบ ต้องมีทั้งคู่ ไม่งั้นข้อมูลหายเงียบ ๆ
  "Create By"                text,

  -- คอลัมน์ที่เพิ่มมาทีหลังในชีตจริง
  "บริษัทที่ขาย"               text,
  "ยอดขายก่อน VAT"            numeric(14,2)
);

create unique index if not exists total_sales_row_uk    on app.total_sales(_row);
create index if not exists total_sales_job_ix           on app.total_sales("รหัสงาน");
create index if not exists total_sales_status_ix        on app.total_sales("Lead Status");
create index if not exists total_sales_closed_ix        on app.total_sales("วันที่ปิดการขาย");
create index if not exists total_sales_company_ix       on app.total_sales("ชื่อบริษัท");

create index if not exists total_sales_code_ix          on app.total_sales("Sales Code");

-- สำหรับฐานข้อมูลที่สร้างไว้ก่อนหน้าและยังไม่มีคอลัมน์นี้
alter table app.total_sales add column if not exists "Create By" text;
create index if not exists total_sales_by_ix2           on app.total_sales("Create By");


-- ═══════════════════════════════════════════════════════════════════
--  บันทึกผลการซิงค์ทุกรอบ — ไว้ตอบว่า "ข้อมูลอัปเดตล่าสุดเมื่อไร"
--  และไล่ย้อนได้ว่ารอบไหนพัง เพราะอะไร
-- ═══════════════════════════════════════════════════════════════════
create table if not exists app.sync_run (
  _id         bigserial primary key,
  source      text not null,               -- ชื่องานซิงค์ เช่น 'sales'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  rows_read   integer default 0,
  rows_new    integer default 0,
  rows_upd    integer default 0,
  rows_same   integer default 0,
  rows_del    integer default 0,
  ms          integer,
  error       text,
  note        text
);

create index if not exists sync_run_src_ix on app.sync_run (source, started_at desc);

-- สถานะล่าสุดของแต่ละงานซิงค์ — ใช้โชว์บนหน้าเว็บ
create or replace view app.v_sync_status as
select distinct on (source)
  source,
  started_at,
  finished_at,
  ok,
  rows_read, rows_new, rows_upd, rows_same, rows_del,
  ms,
  error,
  round(extract(epoch from (now() - finished_at)) / 60.0)::int as นาทีที่แล้ว
from app.sync_run
order by source, started_at desc;


-- ─── สิทธิ์ ──────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema app to service_role;
    grant all on all tables    in schema app to service_role;
    grant all on all sequences in schema app to service_role;
    grant all on all routines  in schema app to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
