-- ═══════════════════════════════════════════════════════════════════
--  CRM มดงานการป้าย · ติดตั้งฐานข้อมูลส่วนกลาง
--  ▶ รันไฟล์นี้เป็นไฟล์แรกใน Supabase SQL Editor (คัดลอกทั้งไฟล์ → Run)
--
--  ไฟล์นี้สร้างแค่ "ของกลาง" ที่ทุกโมดูลใช้ร่วมกัน
--  ตารางของแต่ละแอปจะตามมาทีหลัง ไฟล์ละโมดูล
-- ═══════════════════════════════════════════════════════════════════

create schema if not exists app;
set search_path to app, public;


-- ─── ผู้ใช้งาน ────────────────────────────────────────────────────
--  ยกโครงจากชีต "User" ใน Login CRM มาตรง ๆ เพื่อให้ย้ายข้อมูลง่าย
--  เพิ่ม PasswordHash (bcrypt) — ช่อง Password เดิมจะถูกล้างทิ้งอัตโนมัติ
--  หลังผู้ใช้ล็อกอินครั้งแรก
create table if not exists app.app_users (
  _id           bigserial primary key,
  "Name"         text,
  "Nickname"     text,
  "Impage"       text,                    -- path รูปโปรไฟล์ (สะกดตามชีตเดิม)
  "Username"     text not null,
  "Password"     text,                    -- ⚠ ชั่วคราวช่วงย้ายระบบเท่านั้น
  "PasswordHash" text,                    -- bcrypt
  "Status"       text default 'Login',    -- 'Login' | 'Logout'
  "Permission"   text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ชื่อผู้ใช้ห้ามซ้ำ (ไม่สนตัวพิมพ์เล็กใหญ่)
create unique index if not exists app_users_username_uk
  on app.app_users (lower("Username"));

create index if not exists app_users_status_ix on app.app_users ("Status");


-- ─── บันทึกการใช้งาน (audit) ─────────────────────────────────────
--  แอปเดิมทั้ง 12 ตัวไม่มีตารางนี้เลย → ตรวจย้อนหลังไม่ได้ว่าใครทำอะไร
--  ระบบใหม่บังคับเขียนทุกเหตุการณ์สำคัญ
create table if not exists app.auth_audit (
  _id       bigserial primary key,
  at        timestamptz not null default now(),
  username  text,
  role      text,
  action    text not null,   -- login_ok · login_fail · open_module · ...
  module    text,
  target    text,
  detail    text,
  ip        text,
  ua        text
);

create index if not exists auth_audit_at_ix       on app.auth_audit (at desc);
create index if not exists auth_audit_user_ix     on app.auth_audit (username, at desc);
create index if not exists auth_audit_action_ix   on app.auth_audit (action, at desc);
create index if not exists auth_audit_module_ix   on app.auth_audit (module, at desc);


-- ─── อัปเดต updated_at ให้อัตโนมัติ ──────────────────────────────
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists app_users_touch on app.app_users;
create trigger app_users_touch before update on app.app_users
  for each row execute function app.touch_updated_at();


-- ─── มุมมองช่วยดูสถานะระบบ ───────────────────────────────────────

-- ใครยังใช้รหัสผ่านแบบข้อความล้วนอยู่บ้าง (ควรเหลือ 0 หลังทุกคนล็อกอินครบ)
create or replace view app.v_users_pending_hash as
select "Username", "Name", "Nickname", "Permission", "Status"
from app.app_users
where coalesce("PasswordHash", '') = ''
order by "Username";

-- สรุปการเข้าใช้ 30 วันล่าสุด แยกตามคนและโมดูล
create or replace view app.v_usage_30d as
select
  username,
  module,
  count(*)                                    as hits,
  max(at)                                     as last_at,
  count(*) filter (where action = 'login_ok') as logins
from app.auth_audit
where at > now() - interval '30 days'
group by 1, 2
order by hits desc;

-- ความพยายามล็อกอินที่ล้มเหลว (ดูว่ามีคนเดารหัสไหม)
create or replace view app.v_login_failures as
select username, ip, count(*) as tries, max(at) as last_try
from app.auth_audit
where action in ('login_fail', 'login_blocked')
  and at > now() - interval '7 days'
group by 1, 2
having count(*) >= 3
order by tries desc;


-- ─── ปิดการเข้าถึงจากภายนอก ──────────────────────────────────────
--  เซิร์ฟเวอร์เราใช้ service_role key ซึ่งข้าม RLS อยู่แล้ว
--  เปิด RLS ไว้เพื่อกันกรณีมีใครเอา anon key ไปยิงตรง
alter table app.app_users  enable row level security;
alter table app.auth_audit enable row level security;
-- ไม่สร้าง policy = anon key อ่านอะไรไม่ได้เลย (ตั้งใจ)


-- ─── ให้สิทธิ์ service_role เข้าถึง schema app ───────────────────
--  ‼ ขาดบล็อกนี้ = ทุกคำสั่งจะได้ 403 "permission denied for schema app"
--    schema ที่เราสร้างเองต้อง grant เอง Supabase ไม่ได้ทำให้อัตโนมัติ
--    เหมือน schema public — บทเรียนจากตอนติดตั้งจริงครั้งแรก
--  ให้เฉพาะ service_role — anon ยังเข้าไม่ได้ตามเจตนาด้านบน
--  ห่อด้วย DO เพราะ PostgreSQL ธรรมดา (เครื่องทดสอบ) ไม่มี role นี้
--  จะได้รันไฟล์เดียวกันได้ทั้งบน Supabase และบนเครื่องตัวเอง
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema app to service_role;
    grant all on all tables    in schema app to service_role;
    grant all on all sequences in schema app to service_role;
    grant all on all routines  in schema app to service_role;

    -- ตาราง/ซีเควนซ์ที่ไฟล์โมดูลสร้างเพิ่มทีหลัง ให้สิทธิ์อัตโนมัติ
    alter default privileges in schema app grant all on tables    to service_role;
    alter default privileges in schema app grant all on sequences to service_role;
    alter default privileges in schema app grant all on routines  to service_role;

    raise notice 'ให้สิทธิ์ service_role เข้า schema app แล้ว';
  else
    raise notice 'ไม่พบ role service_role — ข้ามการ grant (ปกติถ้ารันนอก Supabase)';
  end if;
end $$;

-- บอก PostgREST ให้โหลดโครงสร้างใหม่ทันที ไม่ต้องรอ
notify pgrst, 'reload schema';


-- ═══════════════════════════════════════════════════════════════════
--  เสร็จแล้ว — ขั้นต่อไป:
--    1) นำเข้าผู้ใช้จากชีต User  →  npm run import-users
--    2) เปิดเซิร์ฟเวอร์          →  npm start
-- ═══════════════════════════════════════════════════════════════════
