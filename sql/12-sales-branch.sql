-- ═══════════════════════════════════════════════════════════════════
--  อันดับยอดขายสาขามดงาน — Code.gs:4195–4245 getBranchDash
--  รายชื่อสาขาจาก CHANNELS_SEED กลุ่ม 'สาขาหน้าร้าน' (Code.gs:208–215)
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create table if not exists app.sales_branch (
  code   text primary key,
  name   text not null,
  ord    int  not null default 99,
  active boolean not null default true
);

insert into app.sales_branch (code, name, ord) values
  ('TBY','ไท-บางใหญ่',1),      ('TBB','ไท-บางบัวทอง',2),
  ('TS3','ไท-สุขาภิบาล3',3),   ('TBN','ไท-บางนา',4),
  ('CWT','แจ้งวัฒนะ',5),       ('BRP','บางจากราชพฤกษ์',6),
  ('LPM','โลตัสพลัสมอล์',7),   ('BYC','บางใหญ่ซิตี้',8)
on conflict (code) do nothing;


/* หาว่าแถวนี้เป็นของสาขาไหน — เทียบจากคอลัมน์ "ชื่อช่อง / Platform"
 * ของเดิมเก็บเป็นข้อความอิสระ เช่น "สาขาบางใหญ่ซิตี้" จึงใช้วิธี "มีชื่อสาขาอยู่ในข้อความไหม"
 * ไม่เจอ → 'ไม่ระบุสาขา' (ของเดิมก็มีช่องนี้) */
create or replace function app.sales_branch_of(p_platform text)
returns text language sql stable as $$
  select coalesce(
    (select b.code from app.sales_branch b
      where b.active and coalesce(p_platform,'') like '%' || b.name || '%'
      order by length(b.name) desc limit 1),
    '-');
$$;

create or replace function app.sales_branch_dash(p_month date)
returns json language sql stable as $$
  with cur as (
    select app.sales_branch_of(platform) bc, amount
    from app.v_sales_closed
    where date_trunc('month', close_date) = date_trunc('month', p_month)
  ), prv as (
    select app.sales_branch_of(platform) bc, amount
    from app.v_sales_closed
    where date_trunc('month', close_date)
        = date_trunc('month', p_month) - interval '1 month'
  ), tot as (
    select coalesce(sum(amount),0) t, count(*) n from cur
  ), rows as (
    select b.code, b.name,
           coalesce((select sum(amount) from cur where bc = b.code),0) amt,
           coalesce((select count(*)    from cur where bc = b.code),0) deals,
           coalesce((select sum(amount) from prv where bc = b.code),0) prev
    from app.sales_branch b where b.active
    union all
    select '-', 'ไม่ระบุสาขา',
           coalesce((select sum(amount) from cur where bc = '-'),0),
           coalesce((select count(*)    from cur where bc = '-'),0),
           coalesce((select sum(amount) from prv where bc = '-'),0)
  )
  select json_build_object(
    'total',     (select t from tot),
    'deals',     (select n from tot),
    'prevTotal', (select coalesce(sum(amount),0) from prv),
    'rows', (select coalesce(json_agg(json_build_object(
        'code', code, 'name', name, 'amt', amt, 'deals', deals, 'prev', prev,
        'share',   case when (select t from tot) > 0
                     then round(amt / (select t from tot) * 100, 1) else 0 end,
        'diffPct', case when prev > 0 then round((amt - prev) / prev * 100, 1) else null end
      ) order by amt desc), '[]'::json) from rows)
  );
$$;


/* ─── แถบกิจกรรมล่าสุด — ใครเพิ่ม/แก้อะไรล่าสุด ────────────────────
 * ของเดิมอ่านจากแท็บ ActivityLog ซึ่งเราซิงค์เข้ามาแล้ว */
create or replace function app.sales_activity(p_limit int default 10)
returns json language sql stable as $$
  select coalesce(json_agg(x order by x.t desc), '[]'::json) from (
    select "Time" as t, "Nickname" as who, "Action" as action,
           "รหัสงาน" as job_code, "Company" as company
    from app.activity_log
    where "Time" is not null
    order by "Time" desc
    limit greatest(1, least(coalesce(p_limit,10), 50))
  ) x;
$$;


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
