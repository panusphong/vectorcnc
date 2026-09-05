-- ═══════════════════════════════════════════════════════════════════
--  ข้อมูลอ่อนไหว — app.sensitive_rows
--
--  พี่เอตัดสินใจ (4 ก.ย. 2569): "เอาเข้ามาให้หมด"
--  → เลขบัตรประชาชน · เลขบัญชีธนาคาร · ภาพบัตร ปชช. ของช่าง ย้ายเข้าระบบใหม่
--
--  แต่ "เอาเข้ามา" ไม่ได้แปลว่า "กองรวมกับข้อมูลทั่วไป"
--  ข้อมูลพวกนี้อยู่คนละตาราง ด้วยเหตุผล 3 ข้อ:
--
--    1) เผลอ SELECT * แล้วเลขบัตรประชาชนโผล่ในรายงาน/หน้าจอ/log ไม่ได้
--       ตารางแยก = ต้อง join ตั้งใจถึงจะเห็น ไม่มีทางหลุดโดยบังเอิญ
--    2) จำกัดสิทธิ์ระดับตารางได้ตรง ๆ — ปิด anon เด็ดขาด เปิดเฉพาะ service_role
--    3) วันหนึ่งถ้าต้องลบตาม PDPA (ช่างขอให้ลบข้อมูล) ลบตารางเดียวจบ
--       ไม่ต้องไล่แกะ jsonb ทีละแถวว่าช่องไหนเป็นของใคร
--
--  ‼ ฝั่งแอป: ห้ามมีโมดูลไหนอ่านตารางนี้ นอกจากหน้าที่ต้องใช้จริง
--    และต้องเป็นแอดมินเท่านั้น พร้อมบันทึกลง auth_audit ทุกครั้งที่เปิดดู
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create table if not exists app.sensitive_rows (
  _id        bigserial primary key,

  source     text    not null,          -- 'techteam/Skill Matrix ช่าง'
  file_key   text    not null,
  tab        text    not null,
  _row       integer not null,          -- คู่กับ app.sheet_rows(_row) แถวเดียวกัน

  _synced_at timestamptz not null default now(),
  data       jsonb   not null           -- เฉพาะช่องอ่อนไหว
);

create unique index if not exists sensitive_rows_uk  on app.sensitive_rows(source, _row);
create index        if not exists sensitive_rows_src on app.sensitive_rows(file_key, tab);

-- ‼ เปิด RLS โดยไม่สร้าง policy ใด ๆ
--   ผลคือ anon / authenticated อ่านไม่ได้เลยแม้แต่แถวเดียว
--   service_role (ที่เซิร์ฟเวอร์เราใช้) ข้าม RLS ได้ตามปกติ
alter table app.sensitive_rows enable row level security;
alter table app.sensitive_rows force row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on app.sensitive_rows from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on app.sensitive_rows from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on app.sensitive_rows to service_role;
    grant usage, select on all sequences in schema app to service_role;
  end if;
end $$;


-- ─── มุมมองรวม: แถวปกติ + ช่องอ่อนไหว ─────────────────────────────
--  ใช้เฉพาะงานที่ต้องใช้จริง เช่น ทำใบเบิกจ่ายช่าง
create or replace view app.v_sheet_rows_full as
select r.source, r.file_key, r.tab, r._row, r._synced_at,
       r.data || coalesce(s.data, '{}'::jsonb) as data,
       (s._id is not null)                     as มีข้อมูลอ่อนไหว
from app.sheet_rows r
left join app.sensitive_rows s
       on s.source = r.source and s._row = r._row;


-- ─── สรุปว่ามีข้อมูลอ่อนไหวอยู่ที่ไหนบ้าง เท่าไร ────────────────────
--  ตัวนี้ปลอดภัย — บอกแค่ "จำนวน" กับ "ชื่อช่อง" ไม่มีค่าจริงหลุดออกมา
create or replace view app.v_sensitive_summary as
select source, file_key, tab,
       count(*)                                        as แถว,
       (select array_agg(distinct k order by k)
          from app.sensitive_rows s2,
               lateral jsonb_object_keys(s2.data) k
         where s2.source = s.source)                   as ช่องที่เก็บ,
       max(_synced_at)                                 as ซิงค์ล่าสุด
from app.sensitive_rows s
group by source, file_key, tab;


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
