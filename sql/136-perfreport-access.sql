/* ═══════════════════════════════════════════════════════════════════
 *  sql/136-perfreport-access.sql — ติ๊กสิทธิ์เข้าแอป "Report & Ranking" (perfreport)
 *
 *  ‼ พี่เอสั่ง 4 พ.ย. 69: "เพิ่่ม list app ในการจัดการสิทธิ์เข้าถึงให้ครบทุก app ด้วยนะ"
 *    ⇒ core/app-perms.js เพิ่ม 'perfreport' เข้าทะเบียนแอปแล้ว (ขึ้นเป็นคอลัมน์ในทะเบียนกลาง)
 *    ⇒ ไฟล์นี้ติ๊กให้กลุ่มที่ใช้แอปนี้จริง:
 *       administrator · sales · sale support · graphic สาขามดงาน
 *  ‼ เพิ่มอย่างเดียว ไม่ลบของเดิม · รันซ้ำได้ไม่เสียหาย
 *  ‼ แก้ต่อได้เองที่ ทะเบียนกลาง › สิทธิ์เข้าแอป · รายกลุ่ม
 * ═══════════════════════════════════════════════════════════════════ */
do $$
declare n_in int;
begin
  if to_regclass('app.app_access_group') is null then
    raise notice '⚠️ ยังไม่มีตาราง app.app_access_group — ต้องรัน sql/89-app-access-control.sql ก่อน';
    return;
  end if;
  update app.app_access_group
     set apps = array_append(apps, 'perfreport'), updated_by = 'sql/136', updated_at = now()
   where perm_key in ('administrator', 'sales', 'sale support', 'graphic สาขามดงาน')
     and not ('perfreport' = any(apps));
  select count(*) into n_in from app.app_access_group where 'perfreport' = any(apps);
  raise notice 'สิทธิ์แอป Report & Ranking: ติ๊กอยู่ % กลุ่ม', n_in;
end $$;

notify pgrst, 'reload schema';

select perm_key as "กลุ่มสิทธิ์",
       case when 'perfreport' = any(apps) then '✅ เข้า Report & Ranking ได้' else '—' end as "Report & Ranking"
  from app.app_access_group
 order by perm_key;
