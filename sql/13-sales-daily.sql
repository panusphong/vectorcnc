-- ═══════════════════════════════════════════════════════════════════
--  Daily Report — ตารางเซลส์ × วันในเดือน แยกลูกค้าเก่า/ใหม่
--
--  โครงตามของเดิม: แถว = เซลส์ (เรียงยอดมาก→น้อย) · คอลัมน์ = วันที่ 1–31
--  แต่ละวันแบ่ง 2 ช่อง "เก่า" กับ "ใหม่" + คอลัมน์รวม 3 ช่องหน้าสุด
--  ปิดท้ายด้วยแถว "รวมทุกคน" และแถว "สะสม" (ยอดสะสมถึงวันนั้น)
-- ═══════════════════════════════════════════════════════════════════

set search_path to app, public;

create or replace function app.sales_daily(p_month date)
returns json language sql stable as $$
  with base as (
    select owner, is_new, amount,
           extract(day from close_date)::int as d
    from app.v_sales_closed
    where date_trunc('month', close_date) = date_trunc('month', p_month)
  ),
  ppl as (
    select owner,
           coalesce(sum(amount) filter (where not is_new), 0) as old_total,
           coalesce(sum(amount) filter (where is_new), 0)     as new_total,
           coalesce(sum(amount), 0)                           as total
    from base group by owner
  ),
  cells as (
    select owner, d,
           coalesce(sum(amount) filter (where not is_new), 0) as o,
           coalesce(sum(amount) filter (where is_new), 0)     as n
    from base group by owner, d
  ),
  daily as (
    select d,
           coalesce(sum(amount) filter (where not is_new), 0) as o,
           coalesce(sum(amount) filter (where is_new), 0)     as n,
           coalesce(sum(amount), 0)                           as t
    from base group by d
  )
  select json_build_object(
    'month', to_char(p_month, 'YYYY-MM'),
    'days',  extract(day from (date_trunc('month', p_month)
                               + interval '1 month - 1 day'))::int,
    'people', (select coalesce(json_agg(json_build_object(
        'nick', p.owner, 'old', p.old_total, 'new', p.new_total, 'total', p.total,
        'cells', (select coalesce(json_object_agg(c.d, json_build_array(c.o, c.n)), '{}'::json)
                    from cells c where c.owner = p.owner)
      ) order by p.total desc), '[]'::json) from ppl p),
    'totals', json_build_object(
      'old',   (select coalesce(sum(old_total),0) from ppl),
      'new',   (select coalesce(sum(new_total),0) from ppl),
      'total', (select coalesce(sum(total),0)     from ppl),
      'byDay', (select coalesce(json_object_agg(d, json_build_array(o, n)), '{}'::json) from daily)
    ),
    -- แถวสะสม: ยอดรวมตั้งแต่ต้นเดือนถึงวันนั้น
    'cumulative', (select coalesce(json_object_agg(d, run), '{}'::json) from (
        select d, sum(t) over (order by d rows between unbounded preceding and current row) as run
        from daily) x)
  );
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on all routines in schema app to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
