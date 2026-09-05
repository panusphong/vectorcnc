-- ═══════════════════════════════════════════════════════════════════
--  ตัวออก "รหัสงาน" ของระบบใหม่ — กันเลขซ้ำที่ระดับโครงสร้าง
--
--  ที่มา: แอปคีย์ยอดขายเดิมออกรหัสซ้ำ (B2K2609/003 โผล่ 2 แถว · 2 ก.ย. 69)
--    v34.2  เชื่อ Script Properties 100% → memo เพี้ยน = แจกเลขซ้ำ
--    v34.3  แก้ถูกทางแล้ว: อ่านของจริงก่อน แล้วห้ามคืนเลขที่มีอยู่
--           แต่ยังเป็น "อ่าน → ตัดสินใจ → เขียน" ซึ่งปลอดภัยได้
--           เพราะมี LockService คลุมอยู่ ถ้าล็อกหลุด/หมดเวลาเมื่อไรก็ซ้ำได้อีก
--
--  ระบบใหม่ยกขึ้นอีกชั้น: ให้ฐานข้อมูลเป็นคนกันเอง
--    · app.job_code เก็บทุกรหัสที่เคยออก โดย code เป็น PRIMARY KEY
--      → ต่อให้โค้ดพลาด ฐานข้อมูลก็ปฏิเสธการใส่ซ้ำ ไม่มีทางเล็ดลอด
--    · จองเลขด้วย INSERT .. ON CONFLICT .. RETURNING = อะตอมมิกในคำสั่งเดียว
--      → ไม่ต้องใช้ล็อกภายนอก ยิงพร้อมกัน 50 คนก็ได้เลขคนละตัว
--    · ถ้าชนจริง ๆ (เช่น มีคนคีย์รหัสมือชนพอดี) ระบบวนหาเลขว่างถัดไปเอง
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;


-- ─── ตัวนับต่อ "หัวรหัส" (prefix + ปีเดือน) ─────────────────────
create table if not exists app.job_code_seq (
  head       text primary key,                 -- เช่น 'B2K2609'
  sep        text        not null default '/', -- ตัวคั่น '/' หรือ '-' (ของเดิมมีทั้งสองแบบ)
  last_no    int         not null default 0,
  updated_at timestamptz not null default now()
);

-- ─── ทะเบียนรหัสที่ออกไปแล้ว — นี่คือด่านที่กันซ้ำจริง ──────────
--  code เป็น PRIMARY KEY → ซ้ำไม่ได้ ต่อให้โค้ดฝั่งไหนพลาดก็ตาม
create table if not exists app.job_code (
  code       text primary key,
  head       text not null,
  no         int  not null,
  module     text,                             -- โมดูลที่ขอ (sales, jobcard, …)
  issued_by  text,                             -- username คนที่ทำให้เกิดรหัสนี้
  issued_at  timestamptz not null default now(),
  note       text
);

create index if not exists job_code_head_ix on app.job_code (head, no);
create index if not exists job_code_at_ix   on app.job_code (issued_at desc);


-- ═══════════════════════════════════════════════════════════════════
--  ขอรหัสงานใหม่ 1 รหัส
--    select app.next_job_code('B2K', 'sales', 'papassorn');
--  คืนค่าเช่น 'B2K2609/004'
--
--  p_yymm ปล่อยว่าง = ใช้ปีเดือนปัจจุบันตามเวลาไทย
-- ═══════════════════════════════════════════════════════════════════
create or replace function app.next_job_code(
  p_prefix    text,
  p_module    text default null,
  p_issued_by text default null,
  p_sep       text default '/',
  p_yymm      text default null
) returns text
language plpgsql
as $$
declare
  v_head  text;
  v_no    int;
  v_code  text;
  v_guard int := 0;
begin
  if coalesce(trim(p_prefix), '') = '' then
    raise exception 'ต้องระบุ prefix ของรหัสงาน';
  end if;

  v_head := upper(trim(p_prefix))
          || coalesce(nullif(trim(p_yymm), ''),
                      to_char(now() at time zone 'Asia/Bangkok', 'YYMM'));

  loop
    v_guard := v_guard + 1;
    if v_guard > 5000 then
      raise exception 'หาเลขว่างของ % ไม่เจอ (ลองแล้ว 5000 ครั้ง)', v_head;
    end if;

    -- จองเลขถัดไป — อะตอมมิกในคำสั่งเดียว ไม่ต้องใช้ล็อกภายนอก
    insert into app.job_code_seq as s (head, sep, last_no)
    values (v_head, coalesce(nullif(p_sep, ''), '/'), 1)
    on conflict (head) do update
      set last_no    = s.last_no + 1,
          updated_at = now()
    returning s.last_no, s.sep into v_no, p_sep;

    v_code := v_head || p_sep || lpad(v_no::text, 3, '0');

    -- ด่านสุดท้าย: PRIMARY KEY เป็นคนกัน ไม่ใช่โค้ด
    -- ถ้าชน (มีคนคีย์มือไว้ก่อน) ก็วนไปขอเลขถัดไปเอง
    begin
      insert into app.job_code (code, head, no, module, issued_by)
      values (v_code, v_head, v_no, p_module, p_issued_by);
      return v_code;
    exception when unique_violation then
      -- ไม่ต้องทำอะไร วนใหม่
    end;
  end loop;
end $$;


-- ═══════════════════════════════════════════════════════════════════
--  จดรหัสที่ "คีย์มือ" หรือ "ย้ายมาจากชีตเดิม" เข้าทะเบียน
--  เพื่อให้ตัวออกเลขรู้ว่าเลขนี้ถูกใช้ไปแล้ว จะได้ไม่แจกซ้ำ
--    select app.claim_job_code('B2K2609/003', 'sales', 'ย้ายจากชีต');
--  คืน true = จดใหม่สำเร็จ · false = มีอยู่แล้ว
-- ═══════════════════════════════════════════════════════════════════
create or replace function app.claim_job_code(
  p_code   text,
  p_module text default null,
  p_note   text default null
) returns boolean
language plpgsql
as $$
declare
  v_code text := upper(trim(p_code));
  v_head text;
  v_no   int;
  m      text[];
begin
  if v_code = '' then return false; end if;

  -- แยก 'B2K2609/003' → หัว 'B2K2609' · ตัวคั่น '/' · เลข 3
  m := regexp_match(v_code, '^(.*?)([-/])0*([0-9]+)$');
  if m is null then
    -- รูปแบบแปลก จดไว้เฉย ๆ ไม่ต้องยุ่งกับตัวนับ
    insert into app.job_code (code, head, no, module, note)
    values (v_code, v_code, 0, p_module, p_note)
    on conflict (code) do nothing;
    return found;
  end if;

  v_head := m[1];
  v_no   := m[3]::int;

  insert into app.job_code (code, head, no, module, note)
  values (v_code, v_head, v_no, p_module, p_note)
  on conflict (code) do nothing;

  if not found then return false; end if;

  -- ดันตัวนับขึ้นให้ไม่ต่ำกว่าของจริง — กันแจกเลขทับของที่มีอยู่
  insert into app.job_code_seq as s (head, sep, last_no)
  values (v_head, m[2], v_no)
  on conflict (head) do update
    set last_no    = greatest(s.last_no, excluded.last_no),
        updated_at = now();

  return true;
end $$;


-- ═══════════════════════════════════════════════════════════════════
--  ตรวจสุขภาพเลขรัน — เทียบ "ตัวนับ" กับ "ของจริงในทะเบียน"
--  (เทียบเท่าปุ่ม 🔢 ตรวจเลขรันเดือนนี้ ในแอปเดิม แต่เชื่อถือได้กว่า
--   เพราะทะเบียนคือแหล่งความจริงเดียว ไม่ใช่ memo ที่เพี้ยนได้)
-- ═══════════════════════════════════════════════════════════════════
create or replace view app.v_job_seq_status as
select
  s.head,
  s.sep,
  s.last_no                              as ตัวนับ,
  coalesce(max(c.no), 0)                 as ในทะเบียน,
  count(c.code)                          as จำนวนรหัส,
  greatest(s.last_no, coalesce(max(c.no), 0)) + 1 as เลขถัดไป,
  (s.last_no < coalesce(max(c.no), 0))   as ตัวนับต่ำกว่าจริง,
  s.updated_at
from app.job_code_seq s
left join app.job_code c on c.head = s.head
group by s.head, s.sep, s.last_no, s.updated_at
order by s.head;


-- ทะเบียนกันซ้ำด้วย PRIMARY KEY อยู่แล้ว วิวนี้จึงควรว่างเสมอ
-- ถ้ามีแถวโผล่ขึ้นมา = มีคนเข้าไปแก้ข้อมูลตรง ๆ ต้องรีบดู
create or replace view app.v_job_code_dup as
select upper(code) as code, count(*) as n
from app.job_code
group by upper(code)
having count(*) > 1;


-- ─── สิทธิ์ (ตามหลักเดียวกับ 01-core.sql) ────────────────────────
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
