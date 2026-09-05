-- ═══════════════════════════════════════════════════════════════════
--  กระจกรวมของทุกแท็บในทุกไฟล์ชีต — app.sheet_rows
--
--  ทำไมเป็น "ตารางเดียว" ไม่ใช่ตารางละแท็บ
--
--    ระบบเดิมมีชีตกลาง 7 ไฟล์ รวมกันเกิน 60 แท็บ (Job Card ไฟล์เดียว ~20 แท็บ)
--    ถ้าสร้างตารางจริงทีละแท็บ ต้องเขียน DDL 60 ชุด และต้องรู้หัวคอลัมน์ล่วงหน้า
--    ซึ่งเราเพิ่งพิสูจน์ไปแล้วว่า "เดาหัวตารางแล้วผิด" (Channel · ActivityLog)
--
--    ตารางนี้เก็บทั้งแถวเป็น jsonb จึงรับได้ทุกหัวตาราง ไม่ต้องรู้ล่วงหน้าเลย
--    เอาข้อมูลเข้ามาให้ครบก่อน แล้วค่อยยกแท็บที่ใช้งานจริงขึ้นเป็นตารางจริงทีละตัว
--    (แบบเดียวกับที่ทำกับ total_sales · projects · contacts ไปแล้ว)
--
--  ‼ ตารางนี้ไม่ใช่ปลายทางสุดท้าย — เป็นที่พักระหว่างย้าย
--    ตารางไหนที่แอปใหม่ใช้จริง ต้องยกขึ้นเป็นตารางจริงที่มีชนิดข้อมูลและ FK
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create table if not exists app.sheet_rows (
  _id        bigserial primary key,

  source     text    not null,          -- 'projectplan/ProductionJobs' — คีย์ที่คนอ่านรู้เรื่อง
  file_key   text    not null,          -- 'projectplan'
  sheet_id   text    not null,          -- Spreadsheet ID จริง
  tab        text    not null,          -- ชื่อแท็บจริง

  _row       integer not null,          -- เลขแถวในชีต (แถว 1 = หัวตาราง)
  _hash      text,                      -- ลายนิ้วมือ ใช้ข้ามแถวที่ไม่เปลี่ยน
  _synced_at timestamptz not null default now(),

  data       jsonb   not null,          -- ทั้งแถว: { "ชื่อหัวคอลัมน์": ค่า }
  redacted   text[]                     -- ชื่อคอลัมน์ที่ "ตั้งใจไม่เก็บ" (ข้อมูลอ่อนไหว)
);

-- คีย์กันซ้ำตัวจริง: 1 แถวในชีต = 1 แถวในตาราง
create unique index if not exists sheet_rows_uk    on app.sheet_rows(source, _row);
create index        if not exists sheet_rows_src   on app.sheet_rows(file_key, tab);
create index        if not exists sheet_rows_sync  on app.sheet_rows(_synced_at desc);

-- ค้นในเนื้อข้อมูลได้ทุกคอลัมน์โดยไม่ต้องรู้ชื่อคอลัมน์ล่วงหน้า
create index if not exists sheet_rows_gin on app.sheet_rows using gin (data jsonb_path_ops);


-- ─── ทะเบียนแท็บที่เจอ (ผลจากปุ่ม "สำรวจทุกแท็บ") ──────────────────
create table if not exists app.sheet_catalog (
  file_key    text not null,
  sheet_id    text not null,
  tab         text not null,
  file_title  text,
  rows_est    integer,                  -- จำนวนแถวที่ Google บอก (รวมแถวว่าง)
  cols_est    integer,
  headers     text[],                   -- หัวตารางจริงที่อ่านมาได้
  covered_by  text,                     -- ถ้าแท็บนี้มีตารางจริงแล้ว ใส่ชื่องานซิงค์
  mirror      boolean not null default true,   -- false = ไม่ต้องดึงเข้ากระจก
  note        text,
  seen_at     timestamptz not null default now(),
  primary key (file_key, tab)
);


-- ─── สรุปว่ากระจกมีอะไรอยู่บ้าง ────────────────────────────────────
create or replace view app.v_sheet_mirror as
select source, file_key, tab,
       count(*)        as แถว,
       max(_synced_at) as ซิงค์ล่าสุด
from app.sheet_rows
group by source, file_key, tab
order by count(*) desc;


-- ─── แท็บที่สำรวจเจอ แต่ยังไม่ได้ดึงเข้ามา ──────────────────────────
create or replace view app.v_sheet_todo as
select c.file_key, c.tab, c.rows_est, c.cols_est, c.covered_by, c.mirror,
       coalesce(m.แถว, 0) as ดึงมาแล้ว
from app.sheet_catalog c
left join app.v_sheet_mirror m
       on m.file_key = c.file_key and m.tab = c.tab
where c.covered_by is null
order by c.rows_est desc nulls last;


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
