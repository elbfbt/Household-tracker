-- 006: (1) no negative wallets, enforced in the database  (2) owner-only remove member / delete household
--      (3) quick-purchase dedupe RPC  (4) wallet name in stats.  Safe on an existing DB: modifies NO existing rows.
create index if not exists tx_wallet_idx on transactions(wallet_id);
create index if not exists tx_to_wallet_idx on transactions(to_wallet_id) where to_wallet_id is not null;

-- effect of one transaction on wallet w (the single accounting rule, same as wallet_balances())
create or replace function tx_effect(t text, a numeric, w1 uuid, w2 uuid, w uuid) returns numeric language sql immutable as $$
select case
 when t='income'  and w1=w then a
 when t='expense' and w1=w then -a
 when t in('withdraw','deposit','transfer') then (case when w1=w then -a else 0 end)+(case when w2=w then a else 0 end)
 else 0 end $$;

create or replace function wallet_bal(w uuid) returns numeric language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(sum(tx_effect(type,amount,wallet_id,to_wallet_id,w)),0) from transactions where wallet_id=w or to_wallet_id=w $$;

-- BEFORE: lock the affected wallets (id order, own household only) so concurrent spends are serialised, not racing.
create or replace function tx_lock() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare ids uuid[]; h uuid;
begin
 if current_setting('app.bypass_balance',true)='on' then if tg_op='DELETE' then return old; end if; return new; end if;
 if tg_op='DELETE' then h:=old.household_id; ids:=array[old.wallet_id,old.to_wallet_id];
 elsif tg_op='INSERT' then h:=new.household_id; ids:=array[new.wallet_id,new.to_wallet_id];
 else h:=new.household_id; ids:=array[old.wallet_id,old.to_wallet_id,new.wallet_id,new.to_wallet_id]; end if;
 perform 1 from wallets where household_id=h and id=any(ids) order by id for update;
 if tg_op='DELETE' then return old; end if; return new; end $$;

-- AFTER: if this change DECREASED a wallet and the wallet is now negative, reject (whole row => transfers are atomic).
create or replace function tx_balance_check() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare ids uuid[]; w uuid; d numeric; bal numeric; wname text;
 o_w uuid; o_t uuid; n_w uuid; n_t uuid; ot text; oa numeric; nt text; na numeric;
begin
 if current_setting('app.bypass_balance',true)='on' then return null; end if;
 if tg_op<>'INSERT' then o_w:=old.wallet_id; o_t:=old.to_wallet_id; ot:=old.type; oa:=old.amount; end if;
 if tg_op<>'DELETE' then n_w:=new.wallet_id; n_t:=new.to_wallet_id; nt:=new.type; na:=new.amount; end if;
 ids:=array(select distinct x from unnest(array[o_w,o_t,n_w,n_t]) as x where x is not null order by x);
 foreach w in array ids loop
  d:=coalesce(tx_effect(nt,na,n_w,n_t,w),0)-coalesce(tx_effect(ot,oa,o_w,o_t,w),0);
  if d<0 then
   bal:=wallet_bal(w);
   if bal<0 then
    select name into wname from wallets where id=w;
    raise exception 'Insufficient funds. Available balance in %: % EGP.', wname, trim(to_char(bal-d,'FM999999999990.00')) using errcode='P0001';
   end if;
  end if;
 end loop;
 return null; end $$;
drop trigger if exists t_tx_lock on transactions;
create trigger t_tx_lock before insert or update or delete on transactions for each row execute function tx_lock();
drop trigger if exists t_tx_balance on transactions;
create trigger t_tx_balance after insert or update or delete on transactions for each row execute function tx_balance_check();

-- quick purchases: one item per (household, name); safe against double-submit / races
do $$ begin create unique index if not exists quick_items_hh_name_uq on quick_items(household_id, lower(btrim(name)));
exception when unique_violation then raise notice 'duplicate quick items already exist; unique index not created'; end $$;
create or replace function add_quick_item(h uuid, n text, p numeric) returns json language plpgsql security definer set search_path=public,pg_temp as $$
declare nm text:=btrim(coalesce(n,'')); qid uuid;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_member(h) then raise exception 'not a member of this household' using errcode='42501'; end if;
 if length(nm) not between 1 and 40 then raise exception 'quick purchase name must be 1-40 characters'; end if;
 if p is null or p<0 or p>=1000000000 then raise exception 'invalid price'; end if;
 select q.id into qid from quick_items q where q.household_id=h and lower(btrim(q.name))=lower(nm) limit 1;
 if found then return json_build_object('id',qid,'created',false); end if;
 begin
  insert into quick_items(household_id,name,default_price) values(h,nm,round(p,2)) returning quick_items.id into qid;
  return json_build_object('id',qid,'created',true);
 exception when unique_violation then
  select q.id into qid from quick_items q where q.household_id=h and lower(btrim(q.name))=lower(nm) limit 1;
  return json_build_object('id',qid,'created',false);
 end;
end $$;

-- owner-only: remove a member (account + past transactions are kept)
create or replace function remove_member(h uuid, uid uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_owner(h) then raise exception 'only the household owner can remove members' using errcode='42501'; end if;
 if uid=auth.uid() then raise exception 'the owner cannot remove themselves' using errcode='42501'; end if;
 delete from members where household_id=h and user_id=uid and role<>'owner';
 if not found then raise exception 'member not found'; end if;
end $$;

-- owner-only: delete the whole household (must type its exact name). Accounts are never deleted.
create or replace function delete_household(h uuid, confirm_name text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare hn text;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_owner(h) then raise exception 'only the household owner can delete the household' using errcode='42501'; end if;
 select name into hn from households where id=h;
 if btrim(coalesce(confirm_name,'')) is distinct from btrim(hn) then raise exception 'confirmation name does not match'; end if;
 perform set_config('app.bypass_balance','on',true);
 delete from transactions where household_id=h;
 delete from quick_items where household_id=h;
 delete from wallets where household_id=h;
 delete from members where household_id=h;
 delete from households where id=h;
 delete from audit_log where household_id=h;
end $$;

create or replace function range_stats(h uuid, d1 date, d2 date) returns json language sql stable security definer set search_path=public,pg_temp as $$
with t as (select tx.*, p.name pname, (select w.name from wallets w where w.id=tx.wallet_id) wname, (tx.created_at at time zone 'Africa/Cairo')::date d
  from transactions tx join profiles p on p.id=tx.user_id
  where tx.household_id=h and is_member(h) and (tx.created_at at time zone 'Africa/Cairo')::date between d1 and d2)
select json_build_object(
 'income',(select coalesce(sum(amount),0) from t where type='income'),
 'expenses',(select coalesce(sum(amount),0) from t where type='expense'),
 'count',(select count(*) from t where type='expense'),
 'by_cat',(select coalesce(json_agg(x order by x.total desc),'[]') from (select category name,sum(amount) total,count(*) n from t where type='expense' group by 1) x),
 'by_member',(select coalesce(json_agg(x order by x.total desc),'[]') from (select pname name,sum(amount) total,count(*) n from t where type='expense' group by 1) x),
 'daily',(select coalesce(json_agg(x order by x.d),'[]') from (select d,sum(amount) total from t where type='expense' group by d) x),
 'top',(select coalesce(json_agg(y),'[]') from (select category,amount,pname,wname,created_at from t where type='expense' order by amount desc limit 5) y)
) $$;

revoke execute on function add_quick_item(uuid,text,numeric),remove_member(uuid,uuid),delete_household(uuid,text) from public,anon;
grant execute on function add_quick_item(uuid,text,numeric),remove_member(uuid,uuid),delete_household(uuid,text) to authenticated;
revoke execute on function tx_effect(text,numeric,uuid,uuid,uuid),wallet_bal(uuid),tx_lock(),tx_balance_check() from public,anon,authenticated;
revoke execute on function range_stats(uuid,date,date) from public,anon; grant execute on function range_stats(uuid,date,date) to authenticated;
do $$ begin alter publication supabase_realtime add table members; exception when duplicate_object then null; end $$;
