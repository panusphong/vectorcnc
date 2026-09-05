-- ═══════════════════════════════════════════════════════════════════
--  Dashboard หน้าแรกของแอปคีย์ยอดขาย — ทำตามของเดิมทุกสูตร
--
--  ทุกสูตรในไฟล์นี้ถอดมาจาก Code.gs v34.3 ของจริง ไม่ได้คิดเอง
--  อ้างอิงบรรทัดไว้ให้ทุกจุด เผื่อวันหลังต้องเทียบว่าตรงกันไหม
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

-- ─── ทะเบียน prefix รหัสงาน → เซลส์ (Code.gs:221–232 CODE_PREFIX) ──
--  ทำเป็นตาราง ไม่ใช่ค่าคงที่ในโค้ด — เพิ่มเซลส์ใหม่แล้วมีผลทันที ไม่ต้อง deploy
--  (ตรงตามเจตนาเดิมที่คอมเมนต์ไว้ Code.gs:297)
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


/* ─── ชื่อเซลส์ของงานหนึ่งใบ ────────────────────────────────────────
 * ลำดับเหมือนของเดิม (Code.gs:4059–4097 getSalesRanking):
 *   1) คอลัมน์ "Create By"  ← ตัวหลัก
 *   2) ถ้าว่าง เดาจาก prefix ของรหัสงาน (เรียงจาก prefix ยาวไปสั้น
 *      เพราะ B2K ต้องชนะ B2 — Code.gs:232 _PREFIX_KEYS)
 *   3) ยังไม่ได้อีก → '(ไม่ระบุ)'
 *
 * ‼ คอลัมน์ "Sales Name" ในชีตจริงว่างเกือบทั้งหมด — อย่าใช้เป็นตัวหลัก */
create or replace function app.sales_owner(p_create_by text, p_job_code text)
returns text language sql immutable as $$
  select coalesce(
    nullif(btrim(coalesce(p_create_by,'')), ''),
    (select p.nickname from app.sales_prefix p
      where upper(coalesce(p_job_code,'')) like p.prefix || '%'
      order by length(p.prefix) desc limit 1),
    '(ไม่ระบุ)');
$$;


/* ─── จัดช่องทาง (Code.gs:4105–4113 _channel3) ─────────────────────
 * ลำดับการตรวจสำคัญมาก — สลับแล้วผลเปลี่ยน */
create or replace function app.sales_channel(p_source text, p_platform text)
returns text language sql immutable as $$
  select case
    when coalesce(p_source,'') like '%สาขา%'
     and btrim(coalesce(p_platform,'')) like 'สาขา%'         then 'สาขา'
    when coalesce(p_source,'') ~* 'b2b'                       then 'B2B'
    when coalesce(p_source,'') like '%ผู้บริหาร%'              then 'ผู้บริหาร'
    when coalesce(p_source,'') ~* 'พาร์ทเนอร์|partner'         then 'Partner'
    else 'Online' end;
$$;


/* ─── ผู้ผลิต (Code.gs:2136 CAMPAIGN.MAKER_RE + 3987–4058 getMixDash) */
create or replace function app.sales_maker(p_maker text)
returns text language sql immutable as $$
  select case
    when btrim(coalesce(p_maker,'')) = ''        then 'unknown'
    when p_maker ~* 'ผลิตเอง|the\s*101'          then 'self'
    else 'out' end;
$$;


-- ─── ฐานคำนวณ: เฉพาะงานที่ปิดการขายแล้ว ────────────────────────────
create or replace view app.v_sales_closed as
select
  t._id,
  t."รหัสงาน"                                             as job_code,
  t."วันที่ปิดการขาย"                                      as close_date,
  t."วันที่ติดต่อ"                                         as contact_date,
  t."ชื่อบริษัท"                                           as company,
  coalesce(t."ยอดขาย (บาท)", 0)                           as amount,
  app.sales_owner(t."Create By", t."รหัสงาน")             as owner,
  app.sales_channel(t."ลูกค้ามาจากไหน", t."ชื่อช่อง / Platform") as channel,
  app.sales_maker(t."ผู้ผลิต")                            as maker_kind,
  t."ผู้ผลิต"                                              as maker,
  t."ชื่อช่อง / Platform"                                  as platform,
  (coalesce(t."ประเภทลูกค้า",'') like '%ใหม่%')            as is_new
from app.total_sales t
where coalesce(t."Lead Status",'') like '%ปิดการขาย%';


/* ═══════════════════════════════════════════════════════════════════
 *  การ์ดช่องทาง (กลุ่ม A) — Code.gs:4121–4180 getChannelDash
 * ═══════════════════════════════════════════════════════════════════ */
create or replace function app.sales_channel_dash(
  p_from date, p_to date, p_prev_from date, p_prev_to date
) returns json language sql stable as $$
  with cur as (
    select * from app.v_sales_closed
     where close_date between p_from and p_to
  ), prv as (
    select * from app.v_sales_closed
     where close_date between p_prev_from and p_prev_to
  ), tot as (
    select coalesce(sum(amount),0) t_now,
           (select coalesce(sum(amount),0) from prv) t_prev
    from cur
  ), ch as (
    select k.key,
           coalesce((select sum(amount) from cur where channel = k.key), 0) as amt,
           coalesce((select sum(amount) from prv where channel = k.key), 0) as prev,
           coalesce((select sum(amount) from cur where channel = k.key and is_new), 0) as amt_new,
           coalesce((select sum(amount) from cur where channel = k.key and not is_new), 0) as amt_old
    from (values ('B2B'),('สาขา'),('ผู้บริหาร'),('Online'),('Partner')) k(key)
  )
  select json_build_object(
    'total',      (select t_now  from tot),
    'prevTotal',  (select t_prev from tot),
    'newPct',     case when (select t_now from tot) > 0
                    then round((select coalesce(sum(amount),0) from cur where is_new)
                               / (select t_now from tot) * 100)::int else 0 end,
    'oldPct',     case when (select t_now from tot) > 0
                    then round((select coalesce(sum(amount),0) from cur where not is_new)
                               / (select t_now from tot) * 100)::int else 0 end,
    'channels', (select json_agg(json_build_object(
        'key',     key,
        'amt',     amt,
        'prev',    prev,
        -- share และ diffPct ปัด 1 ตำแหน่ง ตามของเดิม (Code.gs:4168)
        'share',   case when (select t_now from tot) > 0
                     then round(amt / (select t_now from tot) * 100, 1) else 0 end,
        'diffPct', case when prev > 0 then round((amt - prev) / prev * 100, 1) else null end,
        'newPct',  case when amt > 0 then round(amt_new / amt * 100)::int else 0 end,
        'oldPct',  case when amt > 0 then round(amt_old / amt * 100)::int else 0 end,
        'amtNew',  amt_new,
        'amtOld',  amt_old
      ) order by array_position(array['B2B','สาขา','ผู้บริหาร','Online','Partner'], key))
      from ch)
  );
$$;


/* ═══════════════════════════════════════════════════════════════════
 *  อันดับเซลส์ (กลุ่ม C) — Code.gs:4059–4097 getSalesRanking
 * ═══════════════════════════════════════════════════════════════════ */
create or replace function app.sales_ranking(p_day date)
returns json language sql stable as $$
  select json_build_object(
    'day', (select coalesce(json_agg(x order by x.amt desc), '[]'::json) from (
              select owner as nick, sum(amount) as amt, count(*) as deals
              from app.v_sales_closed
              where close_date = p_day and amount <> 0
              group by owner) x),
    'dayTotal', (select coalesce(sum(amount),0) from app.v_sales_closed
                  where close_date = p_day),
    'month', (select coalesce(json_agg(x order by x.amt desc), '[]'::json) from (
              select owner as nick, sum(amount) as amt, count(*) as deals
              from app.v_sales_closed
              where date_trunc('month', close_date) = date_trunc('month', p_day)
                and amount <> 0
              group by owner) x)
  );
$$;


/* ═══════════════════════════════════════════════════════════════════
 *  ผลิตเอง / ส่งออกนอก / ลูกค้าใหม่-เก่า (กลุ่ม D)
 *  Code.gs:3987–4058 getMixDash
 * ═══════════════════════════════════════════════════════════════════ */
create or replace function app.sales_mix_dash(
  p_from date, p_to date, p_prev_from date, p_prev_to date
) returns json language sql stable as $$
  with cur as (select * from app.v_sales_closed where close_date between p_from and p_to),
       prv as (select * from app.v_sales_closed where close_date between p_prev_from and p_prev_to),
       tot as (select coalesce(sum(amount),0) t, count(*) n from cur),
  seg as (
    select s.key, s.label,
      coalesce((select sum(amount) from cur c where
        case s.key when 'self' then c.maker_kind='self'
                   when 'out'  then c.maker_kind='out'
                   when 'unknown' then c.maker_kind='unknown'
                   when 'cNew' then c.is_new
                   else not c.is_new end), 0) as amt,
      coalesce((select count(*) from cur c where
        case s.key when 'self' then c.maker_kind='self'
                   when 'out'  then c.maker_kind='out'
                   when 'unknown' then c.maker_kind='unknown'
                   when 'cNew' then c.is_new
                   else not c.is_new end), 0) as cnt,
      coalesce((select sum(amount) from prv c where
        case s.key when 'self' then c.maker_kind='self'
                   when 'out'  then c.maker_kind='out'
                   when 'unknown' then c.maker_kind='unknown'
                   when 'cNew' then c.is_new
                   else not c.is_new end), 0) as prev
    from (values
      ('self','ผลิตเอง'), ('out','ส่งออกนอก'), ('unknown','ยังไม่ระบุผู้ผลิต'),
      ('cNew','ลูกค้าใหม่'), ('cOld','ลูกค้าเก่า')) s(key,label)
  )
  select json_build_object(
    'total',  (select t from tot),
    'count',  (select n from tot),
    'prevTotal', (select coalesce(sum(amount),0) from prv),
    'cards', (select json_agg(json_build_object(
        'key', key, 'label', label, 'amt', amt, 'count', cnt, 'prev', prev,
        'share',   case when (select t from tot) > 0
                     then round(amt / (select t from tot) * 100)::int else 0 end,
        'diffPct', case when prev > 0 then round((amt - prev) / prev * 100) ::int else null end
      ) order by array_position(array['self','out','unknown','cNew','cOld'], key))
      from seg),
    'outMakers', (select coalesce(json_agg(x order by x.amt desc), '[]'::json) from (
        select maker, sum(amount) amt, count(*) cnt
        from cur where maker_kind = 'out'
        group by maker order by 2 desc limit 6) x)
  );
$$;


/* ═══════════════════════════════════════════════════════════════════
 *  แถบ KPI 7 ใบ (กลุ่ม E) — Code.gs:3578–3635 getDashboard
 *  ทุกคนเห็นตัวเลข "ทั้งบริษัท" เหมือนกัน ไม่กรองตามเจ้าของ (Code.gs:3604)
 * ═══════════════════════════════════════════════════════════════════ */
create or replace function app.sales_kpi(p_today date)
returns json language sql stable as $$
  with m as (
    select date_trunc('month', p_today)::date  as m_start,
           (date_trunc('month', p_today) - interval '1 month')::date as pm_start,
           (date_trunc('month', p_today) - interval '1 day')::date   as pm_end
  ),
  today_c as (
    select coalesce(sum(amount),0) amt, count(*) n
    from app.v_sales_closed where close_date = p_today
  ),
  yest_c as (
    select coalesce(sum(amount),0) amt
    from app.v_sales_closed where close_date = p_today - 1
  ),
  month_c as (
    select coalesce(sum(amount),0) amt
    from app.v_sales_closed, m where close_date between m.m_start and p_today
  ),
  pmonth_c as (
    select coalesce(sum(amount),0) amt
    from app.v_sales_closed, m where close_date between m.pm_start and m.pm_end
  )
  select json_build_object(
    'leadsTotal',  (select count(*) from app.total_sales, m
                     where "วันที่ติดต่อ" between m.m_start and p_today),
    'todayLeads',  (select count(*) from app.total_sales
                     where "วันที่ติดต่อ" = p_today),
    'todayClosed', (select n from today_c),
    'todaySales',  (select amt from today_c),
    'yestSales',   (select amt from yest_c),
    'diffPct',     case when (select amt from yest_c) > 0
                     then round(((select amt from today_c) - (select amt from yest_c))
                                / (select amt from yest_c) * 100)::int
                     when (select amt from today_c) > 0 then 100 else 0 end,
    -- เฉลี่ย/วัน เดือนนี้ = ยอดเดือนนี้ ÷ วันที่ของวันนี้ (Code.gs:3626)
    'avgDayThis',  round((select amt from month_c) / greatest(extract(day from p_today), 1), 2),
    'avgDayPrev',  round((select amt from pmonth_c)
                         / greatest((select extract(day from m.pm_end) from m), 1), 2),
    'avgPerDeal',  case when (select n from today_c) > 0
                     then round((select amt from today_c) / (select n from today_c), 2) else 0 end,
    'topChannel',  (select platform from app.v_sales_closed
                     where close_date = p_today and coalesce(platform,'') <> ''
                     group by platform order by sum(amount) desc limit 1),
    'topChannelAmt', (select coalesce(sum(amount),0) from app.v_sales_closed
                     where close_date = p_today and coalesce(platform,'') <> ''
                     group by platform order by sum(amount) desc limit 1)
  );
$$;


/* ═══════════════════════════════════════════════════════════════════
 *  แก้ตารางรายการให้ใช้ "ผู้คีย์" ตัวจริง
 *
 *  ‼ รอบก่อนอลิซใช้คอลัมน์ "Sales Name" ซึ่งว่างเกือบทั้งชีต
 *    คอลัมน์พนักงานขายเลยขึ้น "–" ทั้งตาราง
 *    ของจริงแอปเดิมใช้ "Create By" แล้วถ้าว่างค่อยเดาจาก prefix รหัสงาน
 * ═══════════════════════════════════════════════════════════════════ */
/* ‼ ต้อง drop ก่อน — create or replace view เปลี่ยนลำดับ/ชื่อคอลัมน์ไม่ได้
 *   cascade เพราะมีวิวสรุปพึ่งอยู่ เดี๋ยวสร้างคืนให้ครบข้างล่าง */
drop view if exists app.v_sales_list cascade;

create view app.v_sales_list as
select
  t._id, t._row,
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
  t."Create By"              as create_by,
  app.sales_owner(t."Create By", t."รหัสงาน") as owner,   -- ← ตัวที่แสดงบนจอ
  coalesce(t."ยอดขาย (บาท)", 0)        as amount,
  coalesce(t."ยอดเรียกเก็บ (บาท)", 0)  as billed,
  coalesce(t."รับจริง (บาท)", 0)       as received,
  coalesce(t."รับขาด (บาท)", 0)        as shortfall,
  coalesce(t."ยอดสั่งซื้อ (Outsource)", 0) as outsource_cost,
  t."หมายเหตุ"               as note,
  t."หมายเหตุชำระเงิน"        as pay_note,
  t._synced_at,
  lower(
    coalesce(t."รหัสงาน",'')        || ' ' || coalesce(t."ชื่อบริษัท",'')     || ' ' ||
    coalesce(t."ชื่อผู้ติดต่อ",'')   || ' ' || coalesce(t."เบอร์ติดต่อ",'')    || ' ' ||
    coalesce(t."เลขที่ QO / IV",'')  || ' ' || coalesce(t."Sales Name",'')    || ' ' ||
    coalesce(t."Create By",'')      || ' ' || coalesce(t."ผู้ผลิต",'')
  ) as search_text
from app.total_sales t;

/* ตัวกรอง "พนักงานขาย" ต้องใช้ owner ไม่ใช่ sales_name ที่ว่าง */
create or replace function app.sales_filters() returns json
language sql stable as $$
  select json_build_object(
    'status', (select coalesce(json_agg(s order by s), '[]'::json)
                 from (select distinct lead_status s from app.v_sales_list
                        where coalesce(lead_status,'') <> '') t),
    'sales',  (select coalesce(json_agg(s order by s), '[]'::json)
                 from (select distinct owner s from app.v_sales_list
                        where coalesce(owner,'') <> '' and owner <> '(ไม่ระบุ)') t)
  );
$$;

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
      and (p_sale   is null or p_sale   = '' or v.owner       = p_sale)
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


/* สร้างวิวสรุปคืน (ถูก cascade ไปตอน drop) — ใช้ owner แทน sales_name ด้วย */
create or replace view app.v_sales_by_month as
select to_char(coalesce(close_date, contact_date), 'YYYY-MM') as เดือน,
       count(*) as จำนวนงาน, sum(amount) as ยอดขาย, sum(received) as รับจริง,
       sum(amount - received) as ค้างรับ
from app.v_sales_list
where coalesce(close_date, contact_date) is not null
group by 1 order by 1 desc;

create or replace view app.v_sales_by_person as
select owner as พนักงานขาย, count(*) as จำนวนงาน, sum(amount) as ยอดขาย,
       sum(received) as รับจริง, sum(amount - received) as ค้างรับ
from app.v_sales_list
group by 1 order by 3 desc nulls last;


-- ─── ดัชนี ─────────────────────────────────────────────────────────
create index if not exists total_sales_status_ix on app.total_sales("Lead Status");
create index if not exists total_sales_by_ix2    on app.total_sales("Create By");


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
