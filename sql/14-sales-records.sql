-- ═══════════════════════════════════════════════════════════════════
--  ตารางรายการขาย "ทุกคอลัมน์" — ให้เหมือนแอปเดิม 100%
--
--  ของเดิม getRecords() ไม่ได้เลือกคอลัมน์ไหนเลย มันคืน "หัวชีตทั้งแถว"
--  แล้วหน้าจอวาดตามนั้น  ระบบใหม่จึงต้องทำแบบเดียวกัน ไม่ใช่เลือกมา 9 ช่อง
--
--  วิธี: ตัวซิงค์จดลำดับหัวคอลัมน์จริงลง app.sheet_headers ทุกรอบ
--        ฟังก์ชันนี้อ่านลำดับนั้นแล้วประกอบ cells[] ตามลำดับชีตเป๊ะ ๆ
--        คอลัมน์ไหนยังไม่มีช่องจริงในตาราง ก็หยิบจาก _extra ให้อัตโนมัติ
--        → เพิ่มคอลัมน์ในชีตวันไหน ตารางขึ้นเองวันนั้น ไม่ต้องแก้โค้ด
--
--  ‼ ทุกฟังก์ชันในไฟล์นี้เป็น stable/immutable ล้วน — อ่านอย่างเดียว
--    ไม่มี temp table ไม่มี DDL เพราะ PostgREST รัน GET ใน read-only tx
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

-- ─── 1) ลำดับหัวคอลัมน์จริงของแต่ละแท็บ (ตัวซิงค์เป็นคนเขียน) ──────
create table if not exists app.sheet_headers (
  source text not null,
  ord    int  not null,
  name   text not null,
  primary key (source, ord)
);
create index if not exists sheet_headers_src_ix on app.sheet_headers (source);


-- ─── 2) คอลัมน์ที่ชีตจริงมีเพิ่มมาทีหลัง แต่ตารางยังไม่มี ────────────
--      (ก่อนหน้านี้ตกไปอยู่ใน _extra แบบไร้ชนิด — วันที่/ตัวเลขเลยเพี้ยน)

--  · PEAK 17 ช่อง
alter table app.total_sales add column if not exists "ยอดขาย PEAK"              numeric(14,2);
alter table app.total_sales add column if not exists "ตรวจยอด"                  text;
alter table app.total_sales add column if not exists "ชื่อลูกค้า PEAK"            text;
alter table app.total_sales add column if not exists "รหัสลูกค้า PEAK"           text;
alter table app.total_sales add column if not exists "สถานะชำระ PEAK"           text;
alter table app.total_sales add column if not exists "รับชำระแล้ว PEAK"          numeric(14,2);
alter table app.total_sales add column if not exists "PEAK เก็บมาแล้ว (งวด)"     text;
alter table app.total_sales add column if not exists "ผลตรวจ PEAK"              text;
alter table app.total_sales add column if not exists "อัปเดต PEAK เมื่อ"          text;
alter table app.total_sales add column if not exists "เลขที่ใบเสนอราคา PEAK"      text;
alter table app.total_sales add column if not exists "สถานะใบเสนอราคา PEAK"      text;
alter table app.total_sales add column if not exists "ยอดใบเสนอราคา PEAK"        numeric(14,2);
alter table app.total_sales add column if not exists "ใบเสนอราคา → ใบแจ้งหนี้"    text;
alter table app.total_sales add column if not exists "สถานะซิงก์ PEAK"           text;
alter table app.total_sales add column if not exists "ลิงก์เอกสาร PEAK"          text;
alter table app.total_sales add column if not exists "เงื่อนไขชำระ PEAK"          text;
alter table app.total_sales add column if not exists "วันเครดิต PEAK"            text;

--  · ติดตามเก็บเงิน 14 ช่อง (COLLECTION_HEADERS)
alter table app.total_sales add column if not exists "สถานะเก็บเงิน"             text;
alter table app.total_sales add column if not exists "วันส่งมอบ/ติดตั้ง"          date;
alter table app.total_sales add column if not exists "วันนัดวางบิล"              date;
alter table app.total_sales add column if not exists "วันวางบิลจริง"             date;
alter table app.total_sales add column if not exists "วันครบกำหนดชำระ"           date;
alter table app.total_sales add column if not exists "เลขใบแจ้งหนี้ Peak"         text;
alter table app.total_sales add column if not exists "ผู้ติดตามเก็บเงิน"          text;
alter table app.total_sales add column if not exists "วันติดตามล่าสุด"            date;
alter table app.total_sales add column if not exists "หมายเหตุติดตาม"            text;
alter table app.total_sales add column if not exists "วันเตือนล่าสุด"             date;
alter table app.total_sales add column if not exists "เหตุผลที่ยังไม่ได้เงิน"       text;
alter table app.total_sales add column if not exists "นัดติดตามครั้งถัดไป"        date;
alter table app.total_sales add column if not exists "ยอดที่ลูกค้ารับปาก"          numeric(14,2);
alter table app.total_sales add column if not exists "จำนวนครั้งที่ติดตาม"         integer;

--  · สำรองค่าเดิมก่อนแก้ตาม PEAK 5 ช่อง (ยอดขายก่อน VAT มีอยู่แล้ว)
--
--  ‼ 2 ช่องแรกหัวชีตยาวเกิน 63 ไบต์ (ไทยตัวละ 3 ไบต์) PostgreSQL ตัดหางทิ้งเงียบ ๆ
--    ถ้าปล่อยให้มันตัดเอง จะได้ชื่อครึ่ง ๆ กลาง ๆ อย่าง "ยอดขายเดิม (ก่อนแก้ตาม "
--    เลยตั้งชื่อสั้นเองให้จบ แล้วผูกกลับกับหัวชีตเต็มใน v_sales_cols
drop  table if exists app._noop_ignore;
alter table app.total_sales drop column if exists "ยอดขายเดิม (ก่อนแก้ตาม ";
alter table app.total_sales drop column if exists "ยอดเรียกเก็บเดิม (ก่อน";
alter table app.total_sales add column if not exists "ยอดขายเดิม"        numeric(14,2);
alter table app.total_sales add column if not exists "ยอดเรียกเก็บเดิม"  numeric(14,2);
alter table app.total_sales add column if not exists "รับจริงเดิม (ก่อนแก้)"        numeric(14,2);
alter table app.total_sales add column if not exists "รับขาดเดิม (ก่อนแก้)"         numeric(14,2);
alter table app.total_sales add column if not exists "แก้ยอดตาม PEAK เมื่อ"        text;

--  · ตรวจการเปลี่ยนแปลง 3 ช่อง
alter table app.total_sales add column if not exists "ลายเซ็นข้อมูล PEAK"         text;
alter table app.total_sales add column if not exists "ตรวจครั้งถัดไป"             text;
alter table app.total_sales add column if not exists "จำนวนครั้งที่ตรวจ"           integer;


-- ─── 3) แปลงค่าเป็นข้อความสำหรับแสดงผล — ถอดจาก _disp() code.gs:1749 ──
--      วันที่ → dd/MM/yyyy · เวลา → dd/MM/yyyy HH:mm · ตัวเลข → คั่นหลักพัน
--      ‼ ตัดสินจาก "ชนิดของคอลัมน์" ไม่ใช่หน้าตาของค่า
--        (ไม่งั้นเบอร์โทร 0812345678 จะกลายเป็น 812,345,678)
create or replace function app.disp(p_val text, p_type text)
returns text language sql immutable as $$
  select case
    when p_val is null or p_val = '' then ''
    when p_type in ('numeric','integer','bigint','smallint','double precision','real')
         and p_val ~ '^-?\d+(\.\d+)?$'
      then btrim(to_char(p_val::numeric,
             case when p_val::numeric = trunc(p_val::numeric)
                  then 'FM999,999,999,990' else 'FM999,999,999,990.00' end))
    when p_type = 'date' and p_val ~ '^\d{4}-\d{2}-\d{2}'
      then to_char(p_val::date, 'DD/MM/YYYY')
    when p_type like 'timestamp%' and p_val ~ '^\d{4}-\d{2}-\d{2}'
      then to_char((p_val::timestamptz) at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI')
    else p_val
  end;
$$;


-- ─── 3.5) ทะเบียน prefix รหัสงาน → เซลส์ ─────────────────────────────
--  ปกติสร้างไว้แล้วใน 11-sales-dashboard.sql
--  ใส่ซ้ำที่นี่เพื่อให้ไฟล์นี้รันเดี่ยว ๆ ได้ ไม่ต้องจำว่ารันไฟล์ไหนไปแล้วบ้าง
--  (on conflict do nothing → รันซ้ำกี่ครั้งก็ไม่ทับของเดิม)
create table if not exists app.sales_prefix (
  prefix   text primary key,
  username text not null,
  nickname text not null
);

insert into app.sales_prefix (prefix, username, nickname) values
  ('QW','papassorn','แว่น'),      ('QN','Ratanaporn','นวล'),
  ('QZ','Zomzom','ส้ม'),          ('QU','cutdistation','ใบเตย'),
  ('QP','Chananchida','ภา'),      ('QA','ArisaFrame','เฟรม'),
  ('QJ','Namna','น้ำ'),           ('QS','Sopa','หนู'),
  ('QL','Pim salil','พิม'),       ('QR','NeeTS3','นี'),
  ('B2E','chotika','พลอย'),       ('B2G','Kunlakarn.c','กุ๊งกิ๊ง'),
  ('B2P','Porntip.tia','ปัท'),    ('QB','Annrawin9449','แอน'),
  ('QD','Chavisa','มิ้น'),        ('QG','Jiraporn','ปูเป้'),
  ('PA','admin','เอ'),            ('QE','Gampla','แก้ม'),
  ('QT','tartawan11','ต้าร์'),    ('QH','Amonrat_18','แนน'),
  ('B2K','punwadee.t','มิ้งค์'),  ('TATON','Taton','ต้น')
on conflict (prefix) do nothing;


-- ─── 4) ชื่อเล่นที่แสดงบนตาราง — ถอดจาก _rankNick() code.gs:4555 ──────
--      "(แว่น) Papassorn" → แว่น · ไม่มีวงเล็บก็ใช้ทั้งก้อน
--      ว่างทั้งช่อง → เดาจากคำนำหน้ารหัสงาน (ตาราง sales_prefix)
create or replace function app.sales_nick(p_create_by text, p_job_code text)
returns text language sql stable as $$
  select coalesce(
    nullif(btrim(coalesce((regexp_match(coalesce(p_create_by,''), '^\((.+?)\)'))[1], '')), ''),
    nullif(btrim(coalesce(p_create_by,'')), ''),
    (select p.nickname from app.sales_prefix p
      where upper(coalesce(p_job_code,'')) like p.prefix || '%'
      order by length(p.prefix) desc limit 1),
    '(ไม่ระบุ)');
$$;


-- ─── 5) รูปพนักงานขาย — ถอดจาก _saleAvatars() + _driveImg() code.gs:3695 ──
--      ชีต User เก็บรูปเป็นลิงก์ Drive / ไอดีเปล่า ๆ / สูตร =IMAGE("…")
--      แปลงเป็น lh3.googleusercontent.com/d/<id> ที่ <img> โหลดได้ตรง ๆ
create or replace function app.drive_img(p text)
returns text language sql immutable as $$
  select case
    when coalesce(btrim(p),'') = '' then ''
    when (regexp_match(p, '/d/([-\w]{20,})'))[1]     is not null
      then 'https://lh3.googleusercontent.com/d/' || (regexp_match(p, '/d/([-\w]{20,})'))[1]
    when (regexp_match(p, '[?&]id=([-\w]{20,})'))[1] is not null
      then 'https://lh3.googleusercontent.com/d/' || (regexp_match(p, '[?&]id=([-\w]{20,})'))[1]
    when btrim(p) ~ '^[-\w]{25,}$'
      then 'https://lh3.googleusercontent.com/d/' || btrim(p)
    when btrim(p) ~* '^https?://' then btrim(p)
    else ''
  end;
$$;

/* ชื่อเล่น → URL รูป  (ชื่อเล่นซ้ำกันเอาคนแรก) */
create or replace function app.sales_avatars()
returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(nick, url), '{}'::jsonb) from (
    select distinct on (btrim("Nickname"))
           btrim("Nickname") as nick, app.drive_img("Impage") as url
    from app.app_users
    where coalesce(btrim("Nickname"),'') <> ''
      and coalesce(app.drive_img("Impage"),'') <> ''
    order by btrim("Nickname"), _id
  ) x;
$$;


-- ─── 6) ทะเบียนคอลัมน์ที่จะวาด — ลำดับตามชีตจริง + ชนิดของแต่ละช่อง ──
--      ยังไม่เคยซิงค์ (ทะเบียนว่าง) → ถอยไปใช้ลำดับคอลัมน์ในตารางแทน
--  ‼ ต้อง drop ก่อน — create or replace view เปลี่ยนชื่อ/ลำดับคอลัมน์ไม่ได้
--    (บทเรียนเดิมตอนแก้ v_sales_by_month: มันจะฟ้อง "cannot change name of view column")
drop view if exists app.v_sales_cols cascade;
create view app.v_sales_cols as
with hdr as (select ord, name from app.sheet_headers where source = 'sales'),
     raw as (
       select ord, name from hdr
       union all
       select (row_number() over (order by ordinal_position))::int, column_name
       from information_schema.columns
       where table_schema = 'app' and table_name = 'total_sales'
         and column_name not like '\_%'
         and not exists (select 1 from hdr)
     )
select raw.ord, raw.name,
       coalesce(ic.column_name, raw.name) as col,
       coalesce(ic.data_type, 'text')     as dt
from raw
left join lateral (
  /* จับคู่หัวชีต → ชื่อคอลัมน์จริง
   *   ปกติชื่อตรงกันเป๊ะ  แต่หัวที่ยาวเกิน 63 ไบต์ถูกตั้งชื่อสั้นไว้
   *   จึงยอมให้ "ชื่อคอลัมน์เป็นคำขึ้นต้นของหัวชีต" จับคู่กันได้ด้วย
   *   เอาชื่อที่ยาวที่สุดก่อน กันกรณีมีหลายคอลัมน์ที่ขึ้นต้นเหมือนกัน */
  select c.column_name, c.data_type
  from information_schema.columns c
  where c.table_schema = 'app' and c.table_name = 'total_sales'
    and (c.column_name = raw.name
         or (octet_length(raw.name) > 63
             and c.column_name <> ''
             and raw.name like c.column_name || '%'))
  order by (c.column_name = raw.name) desc, length(c.column_name) desc
  limit 1
) ic on true;


-- ─── 7) ตัวหลัก: คืนตารางทั้งแผง แบบเดียวกับ getRecords() ──────────────
--      { headers[], rows[{row,salesCd,cells[],saleNick,salePhoto}],
--        salespeople[], statusCol, range{} }
create or replace function app.sales_records(
  p_mode  text default 'days',
  p_ym    text default null,
  p_from  date default null,
  p_to    date default null,
  p_days  int  default 10,
  p_sale  text default null,
  p_limit int  default 5000
) returns json language sql stable as $$
  with w as (
    select case
      when p_mode = 'range' and (p_from is not null or p_to is not null) then 'range'
      when p_mode = 'month' and coalesce(p_ym,'') ~ '^\d{4}-\d{2}$'      then 'month'
      else 'days' end as mode
  ),
  win as (
    select w.mode,
      case w.mode when 'range' then p_from
                  when 'month' then (p_ym || '-01')::date
                  else (now() at time zone 'Asia/Bangkok')::date
                       - (greatest(coalesce(p_days,10),1) - 1) end as f,
      case w.mode when 'range' then p_to
                  when 'month' then ((p_ym || '-01')::date + interval '1 month - 1 day')::date
                  else (now() at time zone 'Asia/Bangkok')::date end as t,
      case w.mode when 'month' then p_ym else '' end as ym
    from w
  ),
  av as (select app.sales_avatars() as m),
  sel as (
    select t.*
    from app.total_sales t, win
    where (win.f is null or t."วันที่ติดต่อ" >= win.f)
      and (win.t is null or t."วันที่ติดต่อ" <= win.t)
      and (win.mode = 'month' or t."วันที่ติดต่อ" is not null)
      and (coalesce(btrim(p_sale),'') = ''
           or btrim(coalesce(t."Sales Code",'')) = btrim(p_sale))
    order by t._row desc
    limit greatest(1, least(coalesce(p_limit,5000), 20000))
  ),
  body as (
    select s._row as rr,
           json_build_object(
             'row',       s._row,
             'salesCd',   coalesce(btrim(s."Sales Code"), ''),
             'saleNick',  nk.v,
             'salePhoto', coalesce(av.m ->> nk.v, ''),
             'cells', (
               select coalesce(json_agg(
                        app.disp(coalesce(to_jsonb(s) ->> c.col,
                                          coalesce(s._extra,'{}'::jsonb) ->> c.name),
                                 c.dt) order by c.ord), '[]'::json)
               from app.v_sales_cols c)
           ) as r
    from sel s
    cross join av
    cross join lateral (select app.sales_nick(s."Create By", s."รหัสงาน") as v) nk
  ),
  sp as (
    select distinct on (code) code, name from (
      select btrim(u."Username") as code,
             coalesce(nullif(btrim(u."Nickname"),''), btrim(u."Username")) as name
      from app.app_users u where coalesce(btrim(u."Username"),'') <> ''
      union all
      select btrim(t."Sales Code"),
             coalesce(nullif(btrim(t."Sales Name"),''), btrim(t."Sales Code"))
      from app.total_sales t where coalesce(btrim(t."Sales Code"),'') <> ''
    ) z where code <> '' order by code, name
  )
  select json_build_object(
    'headers',   (select coalesce(json_agg(name order by ord), '[]'::json) from app.v_sales_cols),
    'rows',      (select coalesce(json_agg(r order by rr desc), '[]'::json) from body),
    'salespeople', (select coalesce(json_agg(json_build_object('code',code,'name',name)
                                             order by name), '[]'::json) from sp),
    'statusCol', coalesce((select min(ord) - 1 from app.v_sales_cols where name = 'Lead Status'), -1),
    'range',     (select json_build_object('mode', mode, 'ym', ym,
                          'from', to_char(f,'YYYY-MM-DD'), 'to', to_char(t,'YYYY-MM-DD'))
                  from win)
  );
$$;


-- ─── 8) ค้นทั้งชีต — ถอดจาก findRecords() FIND_COLS/FIND_MAX code.gs:1625 ──
--      ค้น 7 คอลัมน์ ไม่สนตัวพิมพ์ ผลไม่เกิน 60 แถว
create or replace function app.sales_find(p_q text, p_sale text default null,
                                          p_max int default 60)
returns json language sql stable as $$
  with q as (select btrim(coalesce(p_q,'')) as s,
                    greatest(1, least(coalesce(p_max,60), 200)) as mx),
  av as (select app.sales_avatars() as m),
  sel as (
    select t.* from app.total_sales t, q
    where length(q.s) >= 2
      and (coalesce(btrim(p_sale),'') = ''
           or btrim(coalesce(t."Sales Code",'')) = btrim(p_sale))
      and (t."รหัสงาน"            ilike '%'||q.s||'%'
        or t."เลขที่ QO / IV"      ilike '%'||q.s||'%'
        or t."ชื่อบริษัท"          ilike '%'||q.s||'%'
        or t."ชื่อผู้ติดต่อ"        ilike '%'||q.s||'%'
        or t."เบอร์ติดต่อ"         ilike '%'||q.s||'%'
        or t."ชื่อลูกค้า PEAK"      ilike '%'||q.s||'%'
        or t."ชื่อช่อง / Platform" ilike '%'||q.s||'%')
    order by t._row desc
    limit (select mx from q)
  ),
  body as (
    select s._row as rr,
           json_build_object(
             'row', s._row,
             'salesCd', coalesce(btrim(s."Sales Code"),''),
             'saleNick', nk.v,
             'salePhoto', coalesce(av.m ->> nk.v, ''),
             'cells', (select coalesce(json_agg(
                          app.disp(coalesce(to_jsonb(s) ->> c.col,
                                            coalesce(s._extra,'{}'::jsonb) ->> c.name),
                                   c.dt) order by c.ord), '[]'::json)
                       from app.v_sales_cols c)
           ) as r
    from sel s cross join av
    cross join lateral (select app.sales_nick(s."Create By", s."รหัสงาน") as v) nk
  )
  select json_build_object(
    'q',      (select s from q),
    'rows',   (select coalesce(json_agg(r order by rr desc), '[]'::json) from body),
    'capped', (select count(*) >= (select mx from q) from body)
  );
$$;


-- ─── 9) รายละเอียดแถวเดียว (ใช้ตอนกดดู/แก้ไข) ───────────────────────
create or replace function app.sales_row(p_row int)
returns json language sql stable as $$
  select coalesce(
    (select (to_jsonb(t) - '_extra' || coalesce(t._extra,'{}'::jsonb))
     from app.total_sales t where t._row = p_row),
    '{}'::jsonb)::json;
$$;


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
