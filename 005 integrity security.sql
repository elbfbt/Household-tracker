-- 005: integrity + security hardening. Safe on an existing database: changes NO existing rows, only rules.
create or replace function tx_before() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
   raise exception 'cannot create a transaction for another user' using errcode='42501'; end if;
  if new.created_at>now()+interval '10 minutes' then new.created_at:=now(); end if;
  if new.wallet_id is null then
   select id into new.wallet_id from wallets where household_id=new.household_id order by is_default desc,created_at limit 1; end if;
 else
  if new.id<>old.id or new.household_id<>old.household_id or new.user_id<>old.user_id
     or new.created_at<>old.created_at or new.type<>old.type or new.client_id is distinct from old.client_id then
   raise exception 'immutable transaction field changed' using errcode='42501'; end if;
 end if;
 if not exists(select 1 from wallets where id=new.wallet_id and household_id=new.household_id)
  or (new.to_wallet_id is not null and not exists(select 1 from wallets where id=new.to_wallet_id and household_id=new.household_id))
 then raise exception 'wallet does not belong to this household' using errcode='42501'; end if;
 new.updated_at:=now();
 return new; end $$;

drop policy if exists p_tx_upd on transactions;
create policy p_tx_upd on transactions for update
  using(is_member(household_id) and (user_id=auth.uid() or is_owner(household_id)))
  with check(is_member(household_id) and (user_id=auth.uid() or is_owner(household_id)));
drop policy if exists p_w_all on wallets;
create policy p_w_sel on wallets for select using(is_member(household_id));
create policy p_w_ins on wallets for insert with check(is_owner(household_id));
create policy p_w_upd on wallets for update using(is_owner(household_id)) with check(is_owner(household_id));
create policy p_w_del on wallets for delete using(is_owner(household_id));
drop policy if exists p_prof_upd on profiles;
create policy p_prof_upd on profiles for update using(id=auth.uid()) with check(id=auth.uid());

revoke all on audit_log from anon, authenticated; grant select on audit_log to authenticated;
revoke all on profiles,households,members,quick_items,transactions,wallets from anon;
revoke insert,update,delete,truncate on households,members from authenticated;
revoke execute on function create_household(text),join_household(text),household_summary(uuid),range_stats(uuid,date,date),wallet_balances(uuid),is_member(uuid),is_owner(uuid) from public,anon;
revoke execute on function on_signup(),audit(),tx_before() from public,anon,authenticated;
alter function is_member(uuid) set search_path=public,pg_temp;
alter function is_owner(uuid) set search_path=public,pg_temp;
alter function on_signup() set search_path=public,pg_temp;
alter function audit() set search_path=public,pg_temp;
alter function join_household(text) set search_path=public,pg_temp;
alter function create_household(text) set search_path=public,pg_temp;
alter function household_summary(uuid) set search_path=public,pg_temp;
alter function range_stats(uuid,date,date) set search_path=public,pg_temp;
alter function wallet_balances(uuid) set search_path=public,pg_temp;
create index if not exists tx_hh_created_id on transactions(household_id,created_at desc,id);
