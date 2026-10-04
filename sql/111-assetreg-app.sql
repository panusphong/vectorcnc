-- ══════════════════════════════════════════════════════════════════
--  111 — การ์ด "ระบบทะเบียนเบอร์โทร และทรัพย์สิน" (แอปภายนอกบน Google Apps Script)
--
--  🔴 พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
--    "เพิ่ม app card อีกในหน้า CRM HUB ให้หน่อยนะ … ชื่อ app ระบบทะเบียนเบอร์โทร และทรัพย์สิน"
--    "ให้เฉพาะ permission : administrator เปิดดูได้เท่านั้นนะ"
--
--  ไฟล์นี้ทำอย่างเดียว (ไม่มีตารางใหม่ · ไม่มีช่องใหม่ · ไม่ลบอะไร · รันซ้ำได้)
--    ติ๊กแอป 'assetreg' ให้กลุ่มสิทธิ์ administrator ในตารางสิทธิ์เข้าแอป
--    ‼ ไม่รันไฟล์นี้: มีแค่ผู้ใช้ admin และ namna ที่เห็นการ์ด (ด่านกันล็อกตัวเองออก)
--      ผู้ใช้อื่นที่เป็น Administrator จะยังไม่เห็นการ์ด จนกว่าจะรัน
--    ‼ กลุ่มอื่น (sales · sale support · บัญชี ฯลฯ) เปิดไม่ได้อยู่แล้วจากด่านในโค้ด
--      (core/app-perms.js ADMIN_PERM_ONLY_APPS) ต่อให้มีคนไปติ๊กในหน้าทะเบียนกลางก็ตาม
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
     set apps = array_append(apps, 'assetreg')
   where perm_key = 'administrator'
     and not ('assetreg' = any(apps));

  select count(*) into n_admin from app.app_access_group
   where perm_key = 'administrator' and 'assetreg' = any(apps);
  select count(*) into n_other from app.app_access_group
   where perm_key <> 'administrator' and 'assetreg' = any(apps);

  raise notice 'สิทธิ์การ์ดระบบทะเบียนเบอร์โทร และทรัพย์สิน: กลุ่ม administrator มี % แถว · กลุ่มอื่นที่ติ๊กไว้ % แถว (ด่านในโค้ดกันอีกชั้น)',
    n_admin, n_other;
end $$;
