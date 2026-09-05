-- ═══════════════════════════════════════════════════════════════════
--  ตารางกระจกของชีตที่เหลือ — ให้ครบทั้ง 5 ไฟล์ที่ระบบเดิมใช้
--
--  ไฟล์ชีตทั้งหมดที่พบใน CONFIG ของแอปเดิม
--    1. Sales Report Tracking  1jWTrSzwMKwj78xVA9gMj3cxizFxs18Pr-q0MJ8CjQ_M
--         TotalSales · Channel · ActivityLog · Presence
--    2. Login CRM              10NgAH66TDVrDBKW5s8uugBeKUi3-UozeEN7iO1-61n4
--         User  ← ‼ ไม่ซิงค์ (ดูเหตุผลท้ายไฟล์)
--    3. Contacts               1oiN3wzd33fu4rwWlFZHm6a9fBzDI59sudFGqoBAY3mY
--         Contacts
--    4. Project Plan           1Fyr8sxgqjPPSFpteYzgvw5isffxmOH0sRroPyNPNl1s
--         Projects · Requirements · _ImgIndex
--    5. CalPrice_1             1r0sV6o_AzUQh5N4bSyEy-3Cdl8MionfmDAt1-FrEhP8
--         รายชื่อ Outsource
--
--  ‼ ทุกตารางมี _extra jsonb — เก็บคอลัมน์ในชีตที่เรายังไม่ได้จับคู่ไว้
--    ระบบเดิมทำข้อมูลหายเงียบ ๆ บ่อยเพราะไม่มีใครรู้ว่ามีคอลัมน์นั้นอยู่
--    ตารางนี้จะไม่ทิ้งอะไรเลย ต่อให้ยังไม่รู้ว่าจะใช้ทำอะไร
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

-- ─── เพิ่ม _extra ให้ตารางที่สร้างไปแล้ว ────────────────────────
alter table app.total_sales  add column if not exists _extra jsonb;
alter table app.projects     add column if not exists _extra jsonb;
alter table app.requirements add column if not exists _extra jsonb;
alter table app.img_index    add column if not exists _extra jsonb;


-- ─── Contacts (ฐานลูกค้ากลาง) ───────────────────────────────────
--  โค้ดเดิมอ่านหัวตารางแบบไดนามิก ไม่ได้ประกาศรายการไว้
--  จึงจับคู่เฉพาะช่องที่แอปใช้จริง (จาก _ctCard) ที่เหลือลง _extra
create table if not exists app.contacts (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  _extra jsonb,

  "ID"                    text,
  "First Name"            text,
  "Last Name"             text,
  "Title"                 text,
  "Email"                 text,
  "Company"               text,
  "แสดงชื่อบริษัท"          text,
  "Phone"                 text,
  "Address"               text,
  "TaxID"                 text,
  "เงื่อนไขการชำระเงิน"      text,
  "Business Group"        text,
  "From Channel"          text,
  "Status"                text,
  "Create By"             text,
  "Created At"            timestamptz
);

create unique index if not exists contacts_row_uk    on app.contacts(_row);
create index if not exists contacts_id_ix            on app.contacts("ID");
create index if not exists contacts_phone_ix         on app.contacts("Phone");
create index if not exists contacts_company_ix       on app.contacts("Company");
create index if not exists contacts_name_ix          on app.contacts("First Name");


-- ─── Channel (ช่องทางการขาย) ────────────────────────────────────
create table if not exists app.channels (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  _extra jsonb,

  "Group"   text,
  "Channel" text,
  "Handle"  text,
  "Active"  text
);
create unique index if not exists channels_row_uk on app.channels(_row);
create index if not exists channels_name_ix       on app.channels("Channel");


-- ─── รายชื่อ Outsource (ผู้ผลิต) ─────────────────────────────────
--  หัวตารางในไฟล์ CalPrice_1 ไม่ได้ประกาศในโค้ด → เก็บลง _extra ทั้งหมด
--  ตั้งใจให้ยืดหยุ่น เพราะเป็นตารางอ้างอิงเล็ก ๆ ที่หัวคอลัมน์เปลี่ยนบ่อย
create table if not exists app.outsource (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  _extra jsonb
);
create unique index if not exists outsource_row_uk on app.outsource(_row);


-- ─── ActivityLog (บันทึกการเข้าพบลูกค้า) ─────────────────────────
--  หัวตารางจาก ACT_HEADERS ในโค้ดเดิม
create table if not exists app.activity_log (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  _extra jsonb,

  "ActivityID" text,
  "Company"    text,
  "Contact"    text,
  "Phone"      text,
  "Sale"       text,
  "Kind"       text,
  "VisitNo"    integer,
  "Date"       date,
  "Time"       text,
  "Note"       text,
  "Photo1"     text,
  "Photo2"     text,
  "Photo3"     text,
  "Photo4"     text,
  "Done"       text,
  "CreatedAt"  timestamptz,
  "CreatedBy"  text
);
create unique index if not exists activity_log_row_uk on app.activity_log(_row);
create index if not exists activity_log_sale_ix       on app.activity_log("Sale", "Date");
create index if not exists activity_log_company_ix    on app.activity_log("Company");


-- ═══════════════════════════════════════════════════════════════════
--  ‼ ทำไมไม่ซิงค์แท็บ User จากไฟล์ Login CRM
--
--  เพราะ "ผู้ใช้" ย้ายมาอยู่ในระบบใหม่เต็มตัวแล้ว (โมดูลจัดการผู้ใช้)
--    · รหัสผ่านถูกแปลงเป็น bcrypt แล้ว ชีตยังเก็บเป็นข้อความล้วน
--    · ถ้าซิงค์ทับ = PasswordHash หายทันที ทุกคนล็อกอินไม่ได้
--    · การเพิ่ม/ปิดบัญชีทำผ่านหน้าเว็บใหม่แล้ว ชีตไม่ใช่แหล่งความจริงอีกต่อไป
--
--  แท็บ Presence (สถานะออนไลน์) ก็ไม่ซิงค์ — เป็นข้อมูลชั่วคราวของแอปเดิม
--  ระบบใหม่มี auth_audit ที่ละเอียดกว่าอยู่แล้ว
-- ═══════════════════════════════════════════════════════════════════


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
