-- ═══════════════════════════════════════════════════════════════════
--  หน้าจอ "คีย์ยอดขาย" — วิวและฟังก์ชันค้นหา
--
--  ทำไมต้องมีวิว ไม่ query ตารางตรง ๆ
--    ตาราง total_sales ใช้ชื่อคอลัมน์ภาษาไทยตามชีตเป๊ะ ๆ (ตั้งใจ — จะได้ไล่ย้อนได้)
--    แต่ชื่อไทยใน URL ของ PostgREST ต้อง encode ยาวเหยียดและพลาดง่ายมาก
--    วิวนี้แปลงเป็นชื่ออังกฤษสั้น ๆ ให้ฝั่งเว็บใช้ — ข้อมูลชุดเดียวกัน ไม่ได้ก๊อป
--
--  ‼ อ่านอย่างเดียวทั้งหมด — ช่วงนี้ทีมยังคีย์งานในแอปเดิม
--    ระบบใหม่มีหน้าที่ "ดูและวิเคราะห์" เท่านั้น ยังไม่มีปุ่มบันทึกสักปุ่ม
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

-- ─── รายการขาย รูปแบบที่หน้าเว็บใช้ ────────────────────────────────
create or replace view app.v_sales_list as
select
  t._id,
  t._row,
  t."รหัสงาน"                as job_code,
  t."วันที่ติดต่อ"            as contact_date,
  t."วันที่ปิดการขาย"         as close_date,
  t."ชื่อบริษัท"              as company,
  t."ชื่อผู้ติดต่อ"           as contact_name,
  t."เบอร์ติดต่อ"             as phone,
  t."ประเภทลูกค้า"            as customer_type,
  t."ลูกค้ามาจากไหน"          as lead_source,
  t."ชื่อช่อง / Platform"     as channel,
  t."Lead Status"            as lead_status,
  t."เลขที่ QO / IV"          as doc_no,
  t."ผู้ผลิต"                 as maker,
  t."Sales Name"             as sales_name,
  t."Sales Code"             as sales_code,
  coalesce(t."ยอดขาย (บาท)", 0)        as amount,
  coalesce(t."ยอดเรียกเก็บ (บาท)", 0)  as billed,
  coalesce(t."รับจริง (บาท)", 0)       as received,
  coalesce(t."รับขาด (บาท)", 0)        as shortfall,
  coalesce(t."ยอดสั่งซื้อ (Outsource)", 0) as outsource_cost,
  t."หมายเหตุ"               as note,
  t."หมายเหตุชำระเงิน"        as pay_note,
  t._synced_at,

  -- ช่องค้นหารวม — พิมพ์คำเดียวหาได้ทุกอย่าง
  lower(
    coalesce(t."รหัสงาน",'')        || ' ' ||
    coalesce(t."ชื่อบริษัท",'')      || ' ' ||
    coalesce(t."ชื่อผู้ติดต่อ",'')   || ' ' ||
    coalesce(t."เบอร์ติดต่อ",'')     || ' ' ||
    coalesce(t."เลขที่ QO / IV",'')  || ' ' ||
    coalesce(t."Sales Name",'')     || ' ' ||
    coalesce(t."ผู้ผลิต",'')
  ) as search_text
from app.total_sales t;


-- ─── ค้นหา + แบ่งหน้า ──────────────────────────────────────────────
--  ทำเป็นฟังก์ชันเพราะเงื่อนไขเยอะ และต้องคืน "จำนวนทั้งหมด" มาด้วยรอบเดียว
create or replace function app.sales_search(
  p_q      text default null,
  p_status text default null,
  p_sale   text default null,
  p_from   date default null,
  p_to     date default null,
  p_limit  int  default 50,
  p_offset int  default 0
) returns json
language sql stable as $$
  with f as (
    select * from app.v_sales_list v
    where (p_q      is null or p_q = ''      or v.search_text like '%' || lower(p_q) || '%')
      and (p_status is null or p_status = '' or v.lead_status = p_status)
      and (p_sale   is null or p_sale   = '' or v.sales_name  = p_sale)
      and (p_from   is null or coalesce(v.close_date, v.contact_date) >= p_from)
      and (p_to     is null or coalesce(v.close_date, v.contact_date) <= p_to)
  )
  select json_build_object(
    'total',    (select count(*) from f),
    'amount',   (select coalesce(sum(amount),0)   from f),
    'received', (select coalesce(sum(received),0) from f),
    'billed',   (select coalesce(sum(billed),0)   from f),
    'rows',     (select coalesce(json_agg(x order by x.ord), '[]'::json) from (
                   select f.*, row_number() over (
                            order by coalesce(f.close_date, f.contact_date) desc nulls last, f._row desc
                          ) as ord
                   from f
                   order by coalesce(f.close_date, f.contact_date) desc nulls last, f._row desc
                   limit greatest(1, least(coalesce(p_limit, 50), 500))
                   offset greatest(0, coalesce(p_offset, 0))
                 ) x)
  );
$$;


-- ─── ตัวเลือกในช่องกรอง ────────────────────────────────────────────
create or replace function app.sales_filters() returns json
language sql stable as $$
  select json_build_object(
    'status', (select coalesce(json_agg(s order by s), '[]'::json)
                 from (select distinct lead_status s from app.v_sales_list
                        where coalesce(lead_status,'') <> '') t),
    'sales',  (select coalesce(json_agg(s order by s), '[]'::json)
                 from (select distinct sales_name s from app.v_sales_list
                        where coalesce(sales_name,'') <> '') t)
  );
$$;


-- ─── สรุปรายเดือน ──────────────────────────────────────────────────
create or replace view app.v_sales_by_month as
select to_char(coalesce(close_date, contact_date), 'YYYY-MM') as เดือน,
       count(*)                  as จำนวนงาน,
       sum(amount)               as ยอดขาย,
       sum(received)             as รับจริง,
       sum(amount - received)    as ค้างรับ
from app.v_sales_list
where coalesce(close_date, contact_date) is not null
group by 1
order by 1 desc;


-- ─── สรุปรายพนักงานขาย ─────────────────────────────────────────────
create or replace view app.v_sales_by_person as
select coalesce(nullif(sales_name,''), '(ไม่ระบุ)') as พนักงานขาย,
       count(*)               as จำนวนงาน,
       sum(amount)            as ยอดขาย,
       sum(received)          as รับจริง,
       sum(amount - received) as ค้างรับ
from app.v_sales_list
group by 1
order by 3 desc nulls last;


-- ─── ดัชนีช่วยค้นหา ────────────────────────────────────────────────
create index if not exists total_sales_close_ix   on app.total_sales("วันที่ปิดการขาย");
create index if not exists total_sales_contact_ix on app.total_sales("วันที่ติดต่อ");


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
