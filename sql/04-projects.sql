-- ═══════════════════════════════════════════════════════════════════
--  Projects Management — ตารางกระจกของชีต Project Plan
--  ‼ รันหลัง 03-sales.sql (วิว v_sales_to_projects อ้างถึง app.total_sales)
--
--  ⚠ ตารางนี้ใช้ร่วมกับแอปอื่น — Job Card สั่งผลิต และระบบจองคิวช่างติดตั้ง
--    อ่าน/เขียนแท็บ Projects เดียวกันนี้ ตอนย้ายสองแอปนั้นจะต่อเข้าตารางนี้เลย
--
--  ช่วงใช้ 2 ระบบคู่กัน: เป็นกระจกอ่านอย่างเดียว ชีตคือแหล่งความจริง
-- ═══════════════════════════════════════════════════════════════════
set search_path to app, public;

-- ─── projects  (จากชีท "Projects" · ไฟล์ Project Plan) ───
create table if not exists app.projects (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  "ID"                                                               text,
  "ชื่อลูกค้า"                                   text,
  "แสดงชื่อลูกค้า"                       text,
  "พนักงานขาย"                                   text,
  "Project"                                                          text,
  "กลุ่มงาน"                                         text,
  "จำนวนงานพิมพ์"                          integer,
  "จำนวนงานป้าย"                             integer,
  "ประเภทงาน"                                      text,
  "Owner"                                                            text,
  "Status"                                                           text,
  "ประเภทการจัดส่ง"                    text,
  "ที่อยู่จัดส่ง"                          text,
  "Location maps"                                                    text,
  "Description"                                                      text,
  "Started"                                                          date,
  "Due"                                                              date,
  "วันที่ส่งมอบให้ลูกค้า"  date,
  "Complete"                                                         date,
  "Status JobOrder"                                                  text,
  "เลขที่ Slip ชำระเงิน"                 text,
  "PDF File"                                                         text,
  "acc_result"                                                       text,
  "acc_confirm_date"                                                 date,
  "ผู้ยืนยันรับเงิน"                 text,
  "ชื่อผู้รับ"                                   text,
  "เบอร์ติดต่อ"                                text,
  "ค่าติดตั้งงาน"                          numeric(14,2),
  "Outsource"                                                        text,
  "cover_sheet_url"                                                  text,
  "cover_sheet_date"                                                 date,
  "ภาพ CheckList 1"                                            text,
  "ภาพ CheckList 2"                                            text,
  "ภาพ CheckList 3"                                            text,
  "ภาพหน้างาน 1"                                 text,
  "ภาพหน้างาน 2"                                 text,
  "ภาพหน้างาน 3"                                 text,
  "Image"                                                            text,
  "Image In Progress"                                                text,
  "Image Complete"                                                   text,
  "จำนวนงานย่อยทั้งหมด"        integer,
  "จำนวนตรวจบัญชีแล้ว"           integer,
  "จำนวนเข้าแผนผลิตแล้ว"     integer,
  "ปิดงานย้อนหลัง"                       text,
  "job_code"                                                         text
);

-- ─── requirements  (จากชีท "Requirements" · project ย่อย) ───
create table if not exists app.requirements (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  "requirement_id"                                    text,
  "project_id"                                        text,
  "requirement_name"                                  text,
  "job_type"                                          text,
  "status"                                            text,
  "designer"                                          text,
  "size_w"                                            numeric(14,2),
  "size_h"                                            numeric(14,2),
  "quantity"                                          numeric(14,2),
  "brief_detail"                                      text,
  "work_group"                                        text,
  "Status JobOrder"                                   text,
  "site_check_date"                                   date,
  "meeting_date"                                      date,
  "started_at"                                        date,
  "completed_at"                                      date,
  "cover_sheet_date"                                  date,
  "image"                                             text,
  "acc_result"                                        text,
  "acc_confirm_date"                                  date,
  "ผู้ยืนยันรับเงิน"  text
);

-- ─── img_index  (จากชีทซ่อน "_ImgIndex" · path -> Drive fileId) ───
create table if not exists app.img_index (
  _id   bigserial primary key,
  _row  integer not null,
  _hash text,
  _synced_at timestamptz not null default now(),
  "path"  text,
  "fid"   text
);


-- ─── ดัชนี ───────────────────────────────────────────────────────────
create unique index if not exists projects_row_uk       on app.projects(_row);
create unique index if not exists requirements_row_uk   on app.requirements(_row);
create unique index if not exists img_index_row_uk      on app.img_index(_row);

create index if not exists projects_id_ix        on app.projects("ID");
create index if not exists projects_status_ix    on app.projects("Status");
create index if not exists projects_sales_ix     on app.projects("พนักงานขาย");
create index if not exists projects_complete_ix  on app.projects("Complete");
create index if not exists projects_jobcode_ix   on app.projects(job_code);
create index if not exists projects_customer_ix  on app.projects("ชื่อลูกค้า");

-- FK จริงของงานย่อย → โปรเจกต์แม่ (สิ่งที่ชีตทำไม่ได้)
create index if not exists requirements_pid_ix   on app.requirements(project_id);
create index if not exists requirements_status_ix on app.requirements(status);
create unique index if not exists img_index_path_uk on app.img_index(path);


-- ─── มุมมอง: โปรเจกต์ + จำนวนงานย่อยจริง ──────────────────────────────
--  เดิมแอปต้องเขียนตัวเลขนับกลับลงชีต (จำนวนงานย่อยทั้งหมด ฯลฯ) เพราะอ่านชีตช้า
--  ใน SQL นับสดได้เลย ไม่ต้องเขียนกลับ ไม่มีทางเพี้ยน
create or replace view app.v_projects_with_reqs as
select
  p.*,
  coalesce(r.total, 0)      as req_total,
  coalesce(r.acc_done, 0)   as req_acc_done,
  coalesce(r.job_done, 0)   as req_job_done,
  coalesce(r.print_cnt, 0)  as req_print,
  coalesce(r.sign_cnt, 0)   as req_sign
from app.projects p
left join (
  select
    project_id,
    count(*)                                                          as total,
    count(*) filter (where acc_result = 'ได้รับเงินแล้ว')               as acc_done,
    count(*) filter (where "Status JobOrder" = 'เข้าแผนผลิตแล้ว')       as job_done,
    count(*) filter (where work_group = 'กลุ่มงานพิมพ์')                as print_cnt,
    count(*) filter (where work_group = 'กลุ่มงานป้าย')                 as sign_cnt
  from app.requirements
  group by project_id
) r on r.project_id = p."ID";


-- ─── มุมมอง: สายงานจากการขาย → โปรเจกต์ ───────────────────────────────
--  ตอบคำถามที่เดิมตอบไม่ได้: "lead ใบนี้เปิดโปรเจกต์ไปกี่ใบแล้ว"
create or replace view app.v_sales_to_projects as
select
  s."รหัสงาน"                as job_code,
  s."ชื่อบริษัท"              as customer,
  s."วันที่ปิดการขาย"          as closed_at,
  s."ยอดขาย (บาท)"           as sale_amount,
  count(p.*)                as project_count,
  count(p.*) filter (where p."Status" = 'Complete') as project_done
from app.total_sales s
left join app.projects p on p.job_code = s."รหัสงาน"
where coalesce(s."รหัสงาน", '') <> ''
group by 1,2,3,4;


-- ─── ฟังก์ชัน: แกะรหัสงานจากคอลัมน์ Project ────────────────────────────
--  ยกตรรกะมาจากแอป "จองคิวช่างติดตั้ง" (_pdCodesFromProjectName)
--  รองรับรูปแบบจริงทั้ง 2 รุ่น: QU7/140 · B2G7/019-1 · QZ2608/084 · QW2608-059
create or replace function app.extract_job_code(p_name text)
returns text language sql immutable as $$
  select (regexp_match(
    upper(regexp_replace(coalesce(p_name, ''), '[\s\u200b]', '', 'g')),
    '([A-Z][A-Z0-9]{0,9}[/-][0-9]{1,5}(?:-[0-9]{1,3})?)'
  ))[1]
  where upper(coalesce(p_name, '')) !~ '^(IV|QO)[-/]';
$$;


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
