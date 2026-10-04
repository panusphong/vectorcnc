/* ═══════════════════════════════════════════════════════════════════
 *  sql/110-affiliate-leads.sql — 🤝 Lead จากฐาน Affiliate เข้า "คีย์ยอดขาย" อัตโนมัติ (รอบ 222)
 *
 *  ‼ รันใน Supabase ของ CRM Hub (ฐานของเราเอง) — "ไม่ใช่" โปรเจกต์ มดงานการป้าย Affiliate
 *
 *  พี่เอสั่ง 3 ต.ค. 69: "…ดึงข้อมูล เข้ามาสร้าง leads ใน app คีย์ยอดขาย แบบ auto
 *    ทันทีที่มีรายการใหม่ หรือมีการแก้ไขจาก database ก้อนนี้"
 *
 *  ไฟล์นี้ทำ 3 อย่าง (รันซ้ำได้ ไม่พัง · ไม่แตะแถวการขายเดิมแม้แต่แถวเดียว):
 *   ① ตารางใหม่ app.affiliate_lead_link — จับคู่ "lead ของ Affiliate 1 ใบ = ใบขาย 1 ใบ" (กันสร้างซ้ำ)
 *      และจำว่าตัวดึงเคยเขียนค่าอะไรลงช่องไหน ไว้ตัดสินว่า "ช่องไหนเซลส์แก้เองไปแล้ว" (ไม่ทับ)
 *   ② ช่องทาง "Affiliate" ในทะเบียนช่องทาง (ดรอปดาวน์ ชื่อช่อง / Platform ของฟอร์มคีย์ยอดขาย)
 *   ③ ค่าตั้งต้นของตัวดึง (บัญชีกลาง = admin · คำนำหน้ารหัสงาน = AFF) — ไม่ทับค่าที่ตั้งเองไว้แล้ว
 * ═══════════════════════════════════════════════════════════════════ */
set search_path to app, public;

/* ─── ① ตารางจับคู่ ──────────────────────────────────────────────── */
create table if not exists app.affiliate_lead_link (
  lead_id         uuid primary key,                  /* leads.id ของฐาน Affiliate */
  state           text        not null default 'creating',
                  /* creating = กำลังสร้าง · linked = ผูกกับใบขายแล้ว · skipped = ยังไม่สร้าง (draft/สแปม)
                     gone = ใบขายถูกลบในคีย์ยอดขายแล้ว (ไม่สร้างกลับ) · error = ทำไม่สำเร็จ รอบหน้าลองใหม่ */
  reason          text,
  sales_row       integer,                           /* app.total_sales._row */
  job_code        text,                              /* รหัสงานของใบขาย */
  row_created_at  timestamptz,                       /* "Created At" ของใบขาย — ใช้ยืนยันว่าเป็นใบเดิม */
  owner           text,                              /* ชื่อผู้ใช้ที่เป็นเจ้าของตอนล่าสุดที่ตัวดึงตั้งให้ */
  claimer_key     text,                              /* คนรับ lead ใน Affiliate (line:… / uid:… / name:…) */
  claimer_label   text,
  src_status      text,                              /* สถานะล่าสุดในฐาน Affiliate */
  src_updated_at  timestamptz,                       /* leads.updated_at ล่าสุดที่ทำไปแล้ว */
  src             jsonb,                             /* สำเนา lead เท่าที่ใช้ (ไม่มีไฟล์ใบเสร็จ/ยอดเงินรับ) */
  applied         jsonb       not null default '{}'::jsonb,   /* ช่อง → ค่าที่ตัวดึงเขียนไว้ล่าสุด */
  kept            jsonb       not null default '[]'::jsonb,   /* ช่องที่เซลส์แก้เองแล้ว (ไม่ทับ) */
  via             text,                              /* webhook · poll · backfill · remap */
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists affiliate_lead_link_upd_ix   on app.affiliate_lead_link (updated_at desc);
create index if not exists affiliate_lead_link_row_ix   on app.affiliate_lead_link (sales_row);
create index if not exists affiliate_lead_link_job_ix   on app.affiliate_lead_link (job_code);
create index if not exists affiliate_lead_link_state_ix on app.affiliate_lead_link (state);


/* ─── ② ช่องทาง "Affiliate" ─────────────────────────────────────────
 *  ‼ เลขแถวของ "ของที่เกิดในระบบใหม่" ต้อง ≥ 900000000 (ของกลาง — ดู sql/83)
 *  ‼ กลุ่ม = 'อื่นๆ' ตรงกับ channelGroup('Affiliate') ของแอป (ยาม tools/test-channels.js เทียบข้อนี้)
 *  ‼ มีชื่อนี้อยู่แล้ว (เคยเพิ่มเองที่ทะเบียนกลาง) = ข้าม ไม่เพิ่มซ้ำ                     */
do $$
declare
  has_no     boolean;
  has_active boolean;
  v_row      integer;
  v_no       integer;
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'app' and table_name = 'channels') then
    raise notice 'ข้าม: ยังไม่มีตาราง app.channels ในฐานนี้';
    return;
  end if;
  if exists (select 1 from app.channels where lower(btrim("Channel")) = 'affiliate') then
    raise notice 'มีช่องทาง Affiliate อยู่แล้ว — ไม่เพิ่มซ้ำ';
    return;
  end if;

  select exists (select 1 from information_schema.columns
                  where table_schema = 'app' and table_name = 'channels' and column_name = 'No')
    into has_no;
  select exists (select 1 from information_schema.columns
                  where table_schema = 'app' and table_name = 'channels' and column_name = '_app_active')
    into has_active;

  select greatest(coalesce(max(_row), 0), 899999999) + 1 into v_row from app.channels;
  /* ช่องที่ใส่ = ชุดเดียวกับที่หน้าทะเบียนกลางใส่ตอนกดเพิ่มช่องทาง (modules/registry) */
  insert into app.channels (_row, "Group", "Channel")
  values (v_row, 'อื่นๆ', 'Affiliate');

  if has_no then
    execute 'select coalesce(max("No"), 0) + 1 from app.channels where _row <> $1' into v_no using v_row;
    execute 'update app.channels set "No" = $1 where _row = $2' using v_no, v_row;
  end if;
  if has_active then
    execute 'update app.channels set "_app_active" = true, "_app_created_by" = ''sql/110'', '
         || '"_app_created_at" = now(), "_app_updated_by" = ''sql/110'', "_app_updated_at" = now() '
         || 'where _row = $1' using v_row;
  end if;
end $$;


/* ─── ③ ค่าตั้งต้นของตัวดึง — on conflict do nothing = ไม่ทับค่าที่พี่เอตั้งไว้เอง ─── */
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'app' and table_name = 'settings') then
    insert into app.settings (key, value, updated_by)
    values ('affiliate_sync',
            '{"enabled": true, "poolUser": "admin", "jobPrefix": "AFF", "claimers": {}}'::jsonb,
            'sql/110')
    on conflict (key) do nothing;
  else
    raise notice 'ข้าม: ยังไม่มีตาราง app.settings (รัน sql/45 ก่อน)';
  end if;
end $$;


/* ─── สิทธิ์ service_role (บล็อกเดียวกับไฟล์อื่น ห้ามลืม) ───────────────
 *  ‼ ขาดบล็อกนี้ = ตารางใหม่มีจริงแต่ PostgREST มองไม่เห็น                 */
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

/* ─── ผลตรวจ — ต้องได้ ✅ ทั้ง 3 บรรทัด ─────────────────────────────── */
select 'ตารางจับคู่ app.affiliate_lead_link' as "รายการ",
       case when exists (select 1 from information_schema.tables
                          where table_schema = 'app' and table_name = 'affiliate_lead_link')
            then '✅ พร้อมใช้' else '🔴 ยังไม่มี' end as "ผล"
union all
select 'ช่องทาง Affiliate ในทะเบียนช่องทาง',
       case when exists (select 1 from app.channels where lower(btrim("Channel")) = 'affiliate')
            then '✅ พร้อมใช้' else '🔴 ยังไม่มี' end
union all
select 'ค่าตั้งต้นตัวดึง (affiliate_sync)',
       case when exists (select 1 from app.settings where key = 'affiliate_sync')
            then '✅ พร้อมใช้' else '🔴 ยังไม่มี' end;
