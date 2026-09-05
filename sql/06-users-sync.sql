-- ═══════════════════════════════════════════════════════════════════
--  เตรียม app_users ให้รับข้อมูลจากชีต User ได้ครบ
--  ชีต Login CRM มีคอลัมน์ Mobile และ email ที่ตารางเดิมยังไม่มี
--  (ถ้าไม่เพิ่ม ข้อมูล 2 ช่องนี้จะหายเงียบ ๆ ตอนซิงค์)
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

alter table app.app_users add column if not exists "Mobile" text;
alter table app.app_users add column if not exists "email"  text;

create index if not exists app_users_email_ix  on app.app_users("email");
create index if not exists app_users_mobile_ix on app.app_users("Mobile");

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
