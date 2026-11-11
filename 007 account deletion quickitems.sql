-- 007: (1) delete-my-account (server-side, no service-role key)  (2) quick-item upsert (create OR update price, never a transaction)
-- Safe on an existing DB: no existing rows are modified. Deleted users' entries are KEPT (creator becomes NULL = "Deleted user").
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.transactions'::regclass and contype='f'
   and conkey=array[(select attnum from pg_attribute where attrelid='public.transactions'::regclass and attname='user_id')] loop
  execute format('alter table public.transactions drop constraint %I',c.conname); end loop;
 for c in select conname from pg_constraint where conrelid='public.households'::regclass and contype='f'
   and conkey=array[(select attnum from pg_attribute where attrelid='public.households'::regclass and attname='created_by')] loop
  execute format('alter table public.households drop constraint %I',c.conname); end loop;
end $$;
alter table transactions alter column user_id drop not null;
alter table transactions add constraint transactions_user_id_fkey foreign key (user_id) references profiles(id) on delete set null;
alter table households add constraint households_created_by_fkey foreign key (created_by) references profiles(id) on delete set null;

-- creator stays immutable (NULL-safe) except for the single case of that user's own account deletion
create or replace function tx_before() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
   raise exception 'cannot create a transaction for another user' using errcode='42501'; end if;
  if new.created_at>now()+interval '10 minutes' then new.created_at:=now(); end if;
  if new.wallet_id is null then
   select id into new.wallet_id from wallets where household_id=new.household_id order by is_default desc,created_at limit 1; end if;
 else
  if new.id is distinct from old.id or new.household_id is distinct from old.household_id
     or new.created_at is distinct from old.created_at or new.type is distinct from old.type or new.client_id is distinct from old.client_id
     or (new.user_id is distinct from old.user_id and not (new.user_id is null and old.user_id::text=current_setting('app.deleting_user',true))) then
   raise exception 'immutable transaction field changed' using errcode='42501'; end if;
 end if;
 if not exists(select 1 from wallets where id=new.wallet_id and household_id=new.household_id)
  or (new.to_wallet_id is not null and not exists(select 1 from wallets where id=new.to_wallet_id and household_id=new.household_id))
 then raise exception 'wallet does not belong to this household' using errcode='42501'; end if;
 new.updated_at:=now();
 return new; end $$;

create or replace function purge_household(h uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform set_config('app.bypass_balance','on',true);
 delete from transactions where household_id=h; delete from quick_items where household_id=h;
 delete from wallets where household_id=h; delete from members where household_id=h;
 delete from households where id=h; delete from audit_log where household_id=h;
 perform set_config('app.bypass_balance','off',true);
end $$;

create or replace function delete_household(h uuid, confirm_name text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare hn text;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_owner(h) then raise exception 'only the household owner can delete the household' using errcode='42501'; end if;
 select name into hn from households where id=h;
 if btrim(coalesce(confirm_name,'')) is distinct from btrim(hn) then raise exception 'confirmation name does not match'; end if;
 perform purge_household(h);
end $$;

create or replace function delete_my_account(confirm_text text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); h uuid;
begin
 if me is null then raise exception 'not signed in' using errcode='42501'; end if;
 if confirm_text is distinct from 'DELETE' then raise exception 'confirmation text must be DELETE'; end if;
 for h in select household_id from members where user_id=me and role='owner' loop
  if exists(select 1 from members where household_id=h and user_id<>me) then
   raise exception 'You own a household that still has other members. Remove them, or delete the household (Household > Delete Household), before deleting your account.'; end if;
 end loop;
 for h in select household_id from members where user_id=me and role='owner' loop perform purge_household(h); end loop;
 perform set_config('app.deleting_user',me::text,true);
 delete from auth.users where id=me;
 perform set_config('app.deleting_user','',true);
end $$;

create or replace function upsert_quick_item(h uuid, n text, p numeric) returns json language plpgsql security definer set search_path=public,pg_temp as $$
declare nm text:=btrim(coalesce(n,'')); qid uuid;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_member(h) then raise exception 'not a member of this household' using errcode='42501'; end if;
 if length(nm) not between 1 and 40 then raise exception 'quick purchase name must be 1-40 characters'; end if;
 if p is null or p<0 or p>=1000000000 then raise exception 'invalid price'; end if;
 select q.id into qid from quick_items q where q.household_id=h and lower(btrim(q.name))=lower(nm) limit 1;
 if found then update quick_items q set default_price=round(p,2) where q.id=qid; return json_build_object('id',qid,'created',false,'updated',true); end if;
 begin
  insert into quick_items(household_id,name,default_price) values(h,nm,round(p,2)) returning quick_items.id into qid;
  return json_build_object('id',qid,'created',true,'updated',false);
 exception when unique_violation then
  select q.id into qid from quick_items q where q.household_id=h and lower(btrim(q.name))=lower(nm) limit 1;
  update quick_items q set default_price=round(p,2) where q.id=qid;
  return json_build_object('id',qid,'created',false,'updated',true);
 end;
end $$;

create or replace function range_stats(h uuid, d1 date, d2 date) returns json language sql stable security definer set search_path=public,pg_temp as $$
with t as (select tx.*, coalesce(p.name,'Deleted user') pname, (select w.name from wallets w where w.id=tx.wallet_id) wname, (tx.created_at at time zone 'Africa/Cairo')::date d
  from transactions tx left join profiles p on p.id=tx.user_id
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

revoke execute on function upsert_quick_item(uuid,text,numeric),delete_my_account(text),delete_household(uuid,text) from public,anon;
grant execute on function upsert_quick_item(uuid,text,numeric),delete_my_account(text),delete_household(uuid,text) to authenticated;
revoke execute on function purge_household(uuid),tx_before() from public,anon,authenticated;
revoke execute on function range_stats(uuid,date,date) from public,anon; grant execute on function range_stats(uuid,date,date) to authenticated;
