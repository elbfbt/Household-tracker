-- Run after schema.sql. Totals are computed in the database (Cairo time). Transfers are never counted as expenses.
create function range_stats(h uuid, d1 date, d2 date) returns json language sql stable security definer set search_path=public as $$
with t as (select tx.*, p.name pname, (tx.created_at at time zone 'Africa/Cairo')::date d
  from transactions tx join profiles p on p.id=tx.user_id
  where tx.household_id=h and is_member(h) and (tx.created_at at time zone 'Africa/Cairo')::date between d1 and d2)
select json_build_object(
 'income',(select coalesce(sum(amount),0) from t where type='income'),
 'expenses',(select coalesce(sum(amount),0) from t where type='expense'),
 'count',(select count(*) from t where type='expense'),
 'by_cat',(select coalesce(json_agg(x order by x.total desc),'[]') from (select category name,sum(amount) total,count(*) n from t where type='expense' group by 1) x),
 'by_member',(select coalesce(json_agg(x order by x.total desc),'[]') from (select pname name,sum(amount) total,count(*) n from t where type='expense' group by 1) x),
 'daily',(select coalesce(json_agg(x order by x.d),'[]') from (select d,sum(amount) total from t where type='expense' group by d) x),
 'top',(select coalesce(json_agg(y),'[]') from (select category,amount,pname,created_at from t where type='expense' order by amount desc limit 5) y)
) $$;
grant execute on function range_stats to authenticated;
