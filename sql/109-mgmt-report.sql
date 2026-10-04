-- ══════════════════════════════════════════════════════════════════
--  109 — แอป Management Report (สุขภาพองค์กรหน้าเดียว)
--
--  🔴 พี่เอสั่ง 3 ต.ค. 69 (คำต่อคำ):
--    "มาทำ app Management Report ให้พี่ด้วย โดยนำ ทุก app ใน CRM Hub มาสร้างเป็น Dash board
--     ที่มีสรุปจบทุกอย่างในหน้าเดียว เพื่อตรวจสอบสุขภาพองค์กร …"
--    "อย่าลืม เพิ่ม ใน app card หน้า crm hub ด้วยนะ และในส่วนนี้ คนที่เปิดดูได้มีแค่
--     permission : administrator เท่านั้น"
--
--  ไฟล์นี้ทำ 2 อย่าง (ไม่มีตารางใหม่ · ไม่มีช่องใหม่ · รันซ้ำได้)
--   ① ติ๊กแอป 'mgmt' ให้กลุ่มสิทธิ์ administrator ในตารางสิทธิ์เข้าแอป
--      ‼ ไม่รันไฟล์นี้: มีแค่ผู้ใช้ admin และ namna ที่เปิดได้ (ด่านกันล็อกตัวเองออก)
--        ผู้ใช้อื่นที่เป็น Administrator จะยังไม่เห็นการ์ด จนกว่าจะรัน
--      ‼ กลุ่มอื่น (sales · sale support · บัญชี ฯลฯ) เปิดไม่ได้อยู่แล้วจากด่านในโค้ด
--        (core/app-perms.js ADMIN_PERM_ONLY_APPS) ต่อให้มีคนไปติ๊กในหน้าทะเบียนกลางก็ตาม
--   ② ใส่ค่าตั้งต้นของแอป (งบโฆษณา) ลงตารางกลาง app.settings คีย์ 'mgmt_config'
--      ‼ มีแถวนี้อยู่แล้ว = ไม่แตะ (ค่าที่แก้จากหน้าแอปไม่ถูกทับ)
--      งบตามที่พี่เอให้ไว้: www.101printhouse.com 75,000 · www.the101.co.th 75,000 ·
--      Facebook 150,000 · TikTok 50,000 บาทต่อเดือน
-- ══════════════════════════════════════════════════════════════════
set search_path to app, public;

do $$
declare
  n_admin int;
  n_other int;
begin
  if to_regclass('app.app_access_group') is null then
    raise notice '⚠️ ยังไม่มีตาราง app.app_access_group — ต้องรัน sql/89-app-access-control.sql ก่อน';
    return;
  end if;

  update app.app_access_group
     set apps = array_append(apps, 'mgmt')
   where perm_key = 'administrator'
     and not ('mgmt' = any(apps));

  select count(*) into n_admin from app.app_access_group
   where perm_key = 'administrator' and 'mgmt' = any(apps);
  select count(*) into n_other from app.app_access_group
   where perm_key <> 'administrator' and 'mgmt' = any(apps);

  raise notice 'สิทธิ์แอป Management Report: กลุ่ม administrator มี % แถว · กลุ่มอื่นที่ติ๊กไว้ % แถว (ด่านในโค้ดกันอีกชั้น)',
    n_admin, n_other;
end $$;

do $$
begin
  if to_regclass('app.settings') is null then
    raise notice '⚠️ ยังไม่มีตาราง app.settings (sql/45) — แอปจะใช้ค่าตั้งต้นในโค้ดไปก่อน บันทึกค่าตั้งจากหน้าแอปยังไม่ได้';
    return;
  end if;

  insert into app.settings (key, value, updated_by)
  values ('mgmt_config', '{
    "ads": [
      { "key": "web101print", "name": "www.101printhouse.com", "group": "web",    "budget": 75000,  "match": ["101print", "printhouse"] },
      { "key": "webthe101",   "name": "www.the101.co.th",      "group": "web",    "budget": 75000,  "match": ["the101"] },
      { "key": "fb",          "name": "Facebook / Instagram",  "group": "fb",     "budget": 150000, "match": [] },
      { "key": "tiktok",      "name": "TikTok",                "group": "tiktok", "budget": 50000,  "match": [] }
    ]
  }'::jsonb, 'sql/109')
  on conflict (key) do nothing;

  raise notice 'ค่าตั้งแอป Management Report: มีแถว mgmt_config แล้ว';
end $$;

notify pgrst, 'reload schema';
