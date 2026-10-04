-- ══════════════════════════════════════════════════════════════════
--  112 — การ์ดแอปภายนอก 2 ใบ: "ระบบจัดตารางสาขา" (branchplan) · "ระบบจองคิว LED" (ledqueue)
--
--  🔴 พี่เอสั่ง 4 ต.ค. 69 (คำต่อคำ):
--    "ระบบจัดตารางสาขา https://script.google.com/macros/s/AKfycbytnB-…/exec
--     ระบบจองคิว LED https://script.google.com/macros/s/AKfycbxJVR10…/exec
--     เพิ่ม app card หน้า CRM Hub ให้ด้วยนะ"
--
--  ไฟล์นี้ทำอย่างเดียว (ไม่มีตารางใหม่ · ไม่มีช่องใหม่ · ไม่ลบอะไร · รันซ้ำได้)
--    ติ๊กแอป 2 ตัวนี้ให้กลุ่มสิทธิ์  administrator · sales · sale support
--    (3 กลุ่มที่กติกาเดิมของระบบให้ "เห็นทุกแอป" — พี่เอไม่ได้จำกัดกลุ่มสำหรับ 2 การ์ดนี้)
--    ‼ ไม่รันไฟล์นี้: การ์ดขึ้นเฉพาะผู้ใช้ admin และ namna
--    ‼ กลุ่มอื่น (บัญชี · planning · กราฟิค ฯลฯ) ไม่ถูกแตะ — เปิดเพิ่ม/ปิดได้เองที่
--      แอป "ทะเบียนกลาง" → สิทธิ์เข้าแอป โดยไม่ต้องแก้โค้ดหรือรัน SQL อีก
-- ══════════════════════════════════════════════════════════════════
set search_path to app, public;

do $$
declare
  k text;
  n_in int;
begin
  if to_regclass('app.app_access_group') is null then
    raise notice '⚠️ ยังไม่มีตาราง app.app_access_group — ต้องรัน sql/89-app-access-control.sql ก่อน';
    return;
  end if;

  foreach k in array array['branchplan', 'ledqueue'] loop
    update app.app_access_group
       set apps = array_append(apps, k)
     where perm_key in ('administrator', 'sales', 'sale support')
       and not (k = any(apps));

    select count(*) into n_in from app.app_access_group where k = any(apps);
    raise notice 'สิทธิ์การ์ด %: ติ๊กอยู่ % กลุ่ม', k, n_in;
  end loop;
end $$;
