-- ═══════════════════════════════════════════════════════════════════
--  แก้ชื่อเซลส์บนอันดับ/แดชบอร์ด ให้ตัดวงเล็บออกเหมือนแอปเดิม
--
--  อาการ: อันดับขึ้นว่า "(กุ๊งกิ๊ง) กุลกานต์ จึงวงศ์ไพบูลย์" ทั้งก้อน
--         วงกลมรูปเลยได้อักษรย่อเป็น "(" และจับคู่รูปจากชีต User ไม่ติด
--         เพราะในชีต User ชื่อเล่นเก็บว่า "กุ๊งกิ๊ง" เฉย ๆ
--
--  ต้นเหตุ: app.sales_owner() ใช้ค่า "Create By" ทั้งก้อน
--           แต่ของเดิม _rankNick() (code.gs:4555) ดึงเฉพาะในวงเล็บหน้าสุด
--             var m = s.match(/^\((.+?)\)/);  if (m) return m[1].trim();
--
--  แก้ที่ sales_owner ที่เดียว → อันดับ · Daily · สาขา · สรุปรายคน ตรงกันหมด
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create or replace function app.sales_owner(p_create_by text, p_job_code text)
returns text language sql stable as $$
  select coalesce(
    /* 1) "(กุ๊งกิ๊ง) กุลกานต์ จึงวงศ์ไพบูลย์" → กุ๊งกิ๊ง   ← ตัวหลัก */
    nullif(btrim(coalesce(
      (regexp_match(coalesce(p_create_by,''), '^\((.+?)\)'))[1], '')), ''),
    /* 2) ไม่มีวงเล็บ → ใช้ทั้งก้อน */
    nullif(btrim(coalesce(p_create_by,'')), ''),
    /* 3) ว่างเลย → เดาจากคำนำหน้ารหัสงาน (ยาวชนะสั้น B2K ต้องไม่แพ้ B2E) */
    (select p.nickname from app.sales_prefix p
      where upper(coalesce(p_job_code,'')) like p.prefix || '%'
      order by length(p.prefix) desc limit 1),
    '(ไม่ระบุ)');
$$;


/* ─── จับคู่รูปให้ยืดหยุ่นขึ้น ────────────────────────────────────────
 *  ชีต User อาจเก็บชื่อเล่นได้หลายแบบ — "กุ๊งกิ๊ง" · "(กุ๊งกิ๊ง) กุลกานต์" · ว่าง
 *  ทำ key ไว้ทุกแบบที่เป็นไปได้ จะได้ไม่พลาดเพราะพิมพ์ไม่เหมือนกัน
 *    · ชื่อเล่นตามที่กรอก
 *    · ชื่อเล่นที่ตัดวงเล็บออกแล้ว
 *    · Username (เผื่อ Create By เก็บเป็น username)
 *  ‼ ใส่ตัวที่ "แม่นกว่า" ทีหลัง เพราะ jsonb || ให้ตัวหลังชนะ */
create or replace function app.sales_avatars()
returns jsonb language sql stable as $$
  with u as (
    select
      app.drive_img("Impage")                                     as url,
      btrim(coalesce("Nickname",''))                              as nick,
      btrim(coalesce(
        (regexp_match(coalesce("Nickname",''), '^\((.+?)\)'))[1], '')) as nick_paren,
      btrim(coalesce("Username",''))                              as uname,
      _id
    from app.app_users
  ),
  k as (
    select url, uname      as key, 1 as pri from u where uname <> ''      and coalesce(url,'') <> ''
    union all
    select url, nick_paren,        2        from u where nick_paren <> '' and coalesce(url,'') <> ''
    union all
    select url, nick,              3        from u where nick <> ''       and coalesce(url,'') <> ''
  )
  select coalesce(jsonb_object_agg(key, url), '{}'::jsonb) from (
    select distinct on (key) key, url from k order by key, pri desc
  ) z;
$$;


/* ─── ตรวจสภาพรูปพนักงาน — เอาไว้ดูว่าทำไมรูปไม่ขึ้น ─────────────────
 *  คืนทีละคน: ชื่อเล่น · ค่าดิบในช่อง Impage · URL ที่แปลงได้
 *  ถ้า url ว่างแต่ raw มีค่า = รูปเก็บเป็นแบบที่แปลงไม่ได้ (เช่น รูปลอยในเซลล์) */
create or replace function app.sales_avatar_check()
returns table (nickname text, username text, raw text, url text)
language sql stable as $$
  select btrim(coalesce("Nickname",'')), btrim(coalesce("Username",'')),
         left(coalesce("Impage",''), 120), app.drive_img("Impage")
  from app.app_users
  order by 1;
$$;


do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on all routines in schema app to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
