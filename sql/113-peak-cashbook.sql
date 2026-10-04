-- ══════════════════════════════════════════════════════════════════
--  113 — สมุดเงินสดจาก PEAK (Cash Flow ใหม่ · รอบ 235)
--
--  🔴 พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
--    "เดี๋ยวรื้อ code cash flow ใหม่หมดเลยนะ เขียนขึ้นมาใหม่ ทำให้ดูง่าย เห็นสรุปภาพรวม
--     เจาะลงรายละเอียดได้ ไม่ใช่มาอะไรเยอะแยะไปหมดแบบนี้ไม่ดู เสียเวลา"
--    "พี่ต้องการเห็นยอดเงินในบัญชี ทุกบัญชี ที่เข้าและออกด้วยนะ"
--    + "ดึงจาก peak"
--
--  ที่มาของข้อมูล = งบทดลอง + บัญชีแยกประเภทของ PEAK (อ่านอย่างเดียว · GET)
--  ตัวดึงเบื้องหลัง (core/peak-cashbook.js) เขียนลง 3 ตารางนี้ · หน้าจออ่านจากฐานเท่านั้น ไม่ยิง PEAK ตอนเปิดหน้า
--
--  ① app.peak_ledger_month  งบทดลองรายเดือนของแต่ละกิจการ (1 แถว = 1 กิจการ 1 เดือน)
--  ② app.peak_ledger_acct   รายการเดินบัญชีของแต่ละรหัสบัญชีในเดือนนั้น (1 แถว = 1 รหัสบัญชี)
--  ③ app.peak_cashbook      สรุปที่คิดเสร็จแล้วของเดือนนั้น (หน้าจออ่านตัวนี้ ⇒ เปิดเร็ว)
--
--  ไม่แตะตารางเดิม · ไม่ลบอะไร · รันซ้ำได้
-- ══════════════════════════════════════════════════════════════════
set search_path to app, public;

create table if not exists app.peak_ledger_month (
  biz        text        not null,             -- กิจการ (มดงานการป้าย / The 101)
  ym         text        not null,             -- เดือน yyyy-MM
  tb         jsonb       not null default '[]'::jsonb,   -- งบทดลอง (แถวบัญชี)
  tb_sub     jsonb       not null default '[]'::jsonb,   -- งบทดลองแบบแยกบัญชีย่อย (ถ้า PEAK ส่งให้)
  tb_at      timestamptz,                      -- ถามงบทดลองครั้งล่าสุดเมื่อไหร่
  full_at    timestamptz,                      -- ดึงบัญชีแยกประเภทใหม่ "ทุกรหัส" ครั้งล่าสุดเมื่อไหร่
  pending    integer     not null default 0,   -- เหลืออีกกี่รหัสบัญชีที่ยังดึงไม่ครบ
  err        text,                             -- ข้อความล่าสุดเมื่อดึงไม่สำเร็จ
  updated_at timestamptz not null default now(),
  primary key (biz, ym)
);

create table if not exists app.peak_ledger_acct (
  biz          text        not null,
  ym           text        not null,
  account_code text        not null,
  account_name text,
  n            integer     not null default 0,  -- จำนวนบรรทัด
  sum_debit    numeric     not null default 0,
  sum_credit   numeric     not null default 0,
  ok           boolean     not null default false, -- ยอดรวมตรงกับงบทดลองของเดือนนั้น
  note         text,
  lines        jsonb       not null default '[]'::jsonb,  -- [{d,j,t,dr,cr}] วันที่ · เลขสมุดรายวัน · คำอธิบาย · เดบิต · เครดิต
  fetched_at   timestamptz not null default now(),
  primary key (biz, ym, account_code)
);

create table if not exists app.peak_cashbook (
  biz      text        not null,
  ym       text        not null,
  ok       boolean     not null default false,   -- ตรวจกับงบทดลองแล้วตรงทุกบัญชีเงินสด/ธนาคาร
  head     jsonb       not null default '{}'::jsonb,  -- ยอดสรุป · บัญชี · หมวด
  docs     jsonb       not null default '[]'::jsonb,  -- เอกสารที่มีเงินเข้า/ออก (เจาะลง)
  built_at timestamptz not null default now(),
  primary key (biz, ym)
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema app to service_role;
    grant all on app.peak_ledger_month to service_role;
    grant all on app.peak_ledger_acct  to service_role;
    grant all on app.peak_cashbook     to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
