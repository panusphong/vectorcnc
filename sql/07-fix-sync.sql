-- ═══════════════════════════════════════════════════════════════════
--  แก้สิ่งที่พบจริงตอนซิงค์รอบแรก (4 ก.ย. 2569)
--
--  รอบแรกเอาข้อมูลเข้ามาได้ 21,182 แถว แต่มี 4 งานล้ม สาเหตุคนละเรื่องกัน
--  ไฟล์นี้แก้ฝั่งฐานข้อมูล ส่วนฝั่งโค้ดแก้ใน core/sync.js
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;


-- ─── 1) ดัชนีรูป (_ImgIndex) ───────────────────────────────────────
--  อาการ: 23505 duplicate key — path ซ้ำในชีต
--         (Projects_Images/d3bc9ed0.Image In Progress.1782891414160.jpg)
--
--  ตอนออกแบบคิดว่า 1 path = 1 รูป ไม่มีทางซ้ำ — แต่ของจริงซ้ำ
--  เพราะชีตนี้เป็นดัชนีที่เขียนทับกันมาหลายปี ทั้งลบแล้วเพิ่มใหม่
--
--  ‼ กฎเหล็กข้อ 2 ของการซิงค์: "ชีตคือแหล่งความจริง ฐานข้อมูลเป็นกระจก"
--    กระจกต้องสะท้อนของจริงให้ได้ แม้ของจริงจะไม่สวย
--    ถ้าชีตมี path ซ้ำ ฐานข้อมูลก็ต้องรับได้ ไม่ใช่ปฏิเสธทั้งรอบ
--    ตัวกันซ้ำที่แท้จริงคือ _row (1 แถวในชีต = 1 แถวในตาราง) ซึ่งยังอยู่
drop index if exists app.img_index_path_uk;
create index if not exists img_index_path_ix on app.img_index("path");


-- ─── 2) Channel (ช่องทางการขาย) ────────────────────────────────────
--  อาการ: หัวตารางจริงคือ  No | Channel | …
--         ไม่ใช่ Group | Channel | Handle | Active ที่เราเดาไว้
alter table app.channels add column if not exists "No" integer;
create index if not exists channels_no_ix on app.channels("No");


-- ─── 3) ActivityLog ────────────────────────────────────────────────
--  อาการ: หัวตารางจริงคือ
--         Time | Username | Nickname | Action | รหัสงาน | Company | Contact | Phone
--
--  ‼ แท็บนี้ไม่ใช่ "บันทึกการเข้าพบลูกค้า" อย่างที่ชื่อชวนให้คิด
--    แต่เป็น "บันทึกการใช้งานแอป" (ใครกดอะไร เมื่อไหร่ งานไหน)
--    เราเดาจากชื่อ ACT_HEADERS ในโค้ดเดิมซึ่งเป็นของอีกเวอร์ชันหนึ่ง
alter table app.activity_log add column if not exists "Username"  text;
alter table app.activity_log add column if not exists "Nickname"  text;
alter table app.activity_log add column if not exists "Action"    text;
alter table app.activity_log add column if not exists "รหัสงาน"    text;

--  Time ในแท็บนี้เป็นวันที่+เวลาเต็ม ไม่ใช่ข้อความเวลาสั้น ๆ อย่างที่เดาไว้
--  (ตารางยังว่างอยู่ — ยังไม่มีแถวไหนซิงค์เข้ามาสำเร็จ เปลี่ยนชนิดได้ปลอดภัย)
alter table app.activity_log
  alter column "Time" type timestamptz using nullif("Time", '')::timestamptz;

create index if not exists activity_log_time_ix   on app.activity_log("Time");
create index if not exists activity_log_user_ix   on app.activity_log("Username");
create index if not exists activity_log_action_ix on app.activity_log("Action");
create index if not exists activity_log_job_ix    on app.activity_log("รหัสงาน");


-- ─── 4) คีย์ยอดขาย (TotalSales) ────────────────────────────────────
--  อาการ: 22009 time zone displacement out of range: "+020266-04"
--
--  ไม่ต้องแก้ตาราง — เป็นบั๊กฝั่งโค้ด
--  มีช่องหนึ่งเก็บตัวเลขที่ไม่ใช่วันที่ไว้ในคอลัมน์ที่ประกาศเป็นวันที่
--  แปลงแล้วได้ปี ค.ศ. 20266 → JavaScript เขียนเป็น "+020266-04-01T…"
--  PostgreSQL อ่านท่อนหลังเป็นเขตเวลา แล้วปฏิเสธทั้งชุด
--  แก้ที่ core/sync.js แล้ว: วันที่นอกช่วง ค.ศ. 1900–2200 → null
--  (ค่าดิบยังอยู่ครบใน _extra ไม่ได้หายไปไหน)


-- ─── ตรวจของที่ซิงค์เข้ามาแล้ว ─────────────────────────────────────
create or replace view app.v_sync_count as
select 'คีย์ยอดขาย'        as ตาราง, count(*) as แถว from app.total_sales
union all select 'Projects',          count(*) from app.projects
union all select 'Requirements',      count(*) from app.requirements
union all select 'ดัชนีรูป',           count(*) from app.img_index
union all select 'ลูกค้า',             count(*) from app.contacts
union all select 'ช่องทางการขาย',      count(*) from app.channels
union all select 'บันทึกการใช้งาน',    count(*) from app.activity_log
union all select 'Outsource',         count(*) from app.outsource
union all select 'ผู้ใช้',              count(*) from app.app_users
union all select 'ทะเบียนรหัสงาน',     count(*) from app.job_code;


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
