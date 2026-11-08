-- Run third (after schema.sql and 002_analytics.sql). Adds wallets, transfers, edit-conflict detection.
create table wallets(id uuid primary key default gen_random_uuid(), household_id uuid not null references households on delete cascade,
  name text not null, is_default boolean not null default false, created_at timestamptz default now());
alter table wallets enable row level security;
create policy p_w_all on wallets for all using(is_member(household_id)) with check(is_member(household_id));
insert into wallets(household_id,name,is_default) select id,'Household cash',true from households;
insert into wallets(household_id,name) select h.id,n from households h, (values('Bank account'),('Personal cash')) v(n);
alter table transactions add column wallet_id uuid references wallets, add column to_wallet_id uuid references wallets,
  add column updated_at timestamptz not null default now();
update transactions t set wallet_id=(select id from wallets w where w.household_id=t.household_id and w.is_default) where wallet_id is null;
alter table transactions drop constraint transactions_type_check;
alter table transactions add constraint transactions_type_check check(type in('expense','income','withdraw','deposit','transfer'));
alter table transactions add constraint transfer_ok check((type='transfer' and to_wallet_id is not null and to_wallet_id<>wallet_id) or (type<>'transfer' and to_wallet_id is null));

create function tx_before() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' and new.wallet_id is null then
  select id into new.wallet_id from wallets where household_id=new.household_id order by is_default desc, created_at limit 1; end if;
 if not exists(select 1 from wallets where id=new.wallet_id and household_id=new.household_id)
  or (new.to_wallet_id is not null and not exists(select 1 from wallets where id=new.to_wallet_id and household_id=new.household_id))
 then raise exception 'wallet does not belong to this household'; end if;
 if tg_op='UPDATE' then new.updated_at=now(); end if;
 return new; end $$;
create trigger t_tx_before before insert or update on transactions for each row execute function tx_before();

create or replace function create_household(hname text) returns uuid language plpgsql security definer set search_path=public as $$
declare h uuid; begin
 if auth.uid() is null then raise exception 'not signed in'; end if;
 insert into households(name,created_by) values(hname,auth.uid()) returning id into h;
 insert into members(household_id,user_id,role) values(h,auth.uid(),'owner');
 insert into wallets(household_id,name,is_default) values(h,'Household cash',true),(h,'Bank account',false),(h,'Personal cash',false);
 insert into quick_items(household_id,name,default_price) values(h,'Bread',20),(h,'Fish',250),(h,'Chicken',180),(h,'Meat',300),(h,'Rice',40),
  (h,'Vegetables',60),(h,'Fruits',80),(h,'Milk',50),(h,'Eggs',60),(h,'Other groceries',50);
 return h; end $$;

-- Transfers between wallets never count as spending and do not change the total.
create or replace function household_summary(h uuid) returns json language sql stable security definer set search_path=public as $$
select json_build_object(
 'balance', coalesce(sum(case when type in('income','withdraw') then amount when type in('expense','deposit') then -amount else 0 end),0),
 'today', coalesce(sum(amount) filter(where type='expense' and (created_at at time zone 'Africa/Cairo')::date=(now() at time zone 'Africa/Cairo')::date),0),
 'week',  coalesce(sum(amount) filter(where type='expense' and date_trunc('week',created_at at time zone 'Africa/Cairo')=date_trunc('week',now() at time zone 'Africa/Cairo')),0),
 'month', coalesce(sum(amount) filter(where type='expense' and date_trunc('month',created_at at time zone 'Africa/Cairo')=date_trunc('month',now() at time zone 'Africa/Cairo')),0))
 from transactions where household_id=h and is_member(h) $$;

create function wallet_balances(h uuid) returns json language sql stable security definer set search_path=public as $$
select coalesce(json_agg(json_build_object('id',w.id,'name',w.name,'balance',(select coalesce(sum(case
  when t.type in('income','withdraw') and t.wallet_id=w.id then t.amount
  when t.type in('expense','deposit','transfer') and t.wallet_id=w.id then -t.amount
  when t.type='transfer' and t.to_wallet_id=w.id then t.amount else 0 end),0) from transactions t where t.household_id=h)) order by w.is_default desc,w.name),'[]')
from wallets w where w.household_id=h and is_member(h) $$;
grant execute on function wallet_balances to authenticated;
