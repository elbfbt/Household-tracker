-- Household Tracker schema. Run once in Supabase > SQL Editor.
create extension if not exists pgcrypto;

create table profiles(id uuid primary key references auth.users on delete cascade, name text not null default '');
create table households(id uuid primary key default gen_random_uuid(), name text not null,
  invite_code text unique not null default substr(md5(random()::text||clock_timestamp()::text),1,8),
  created_by uuid references profiles(id), created_at timestamptz default now());
create table members(household_id uuid references households on delete cascade, user_id uuid references profiles on delete cascade,
  role text not null default 'member' check(role in('owner','member')), primary key(household_id,user_id));
create table quick_items(id uuid primary key default gen_random_uuid(), household_id uuid not null references households on delete cascade,
  name text not null, default_price numeric(12,2) not null default 0 check(default_price>=0));
create table transactions(id uuid primary key default gen_random_uuid(), client_id uuid unique,
  household_id uuid not null references households on delete cascade,
  user_id uuid not null default auth.uid() references profiles(id),
  type text not null check(type in('expense','income','withdraw','deposit')),
  amount numeric(12,2) not null check(amount>0), category text not null default '', note text not null default '',
  created_at timestamptz not null default now());
create index on transactions(household_id, created_at desc);
create table audit_log(id bigserial primary key, tx_id uuid, household_id uuid, actor uuid, action text, old_row jsonb, new_row jsonb, at timestamptz default now());

create function is_member(h uuid) returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from members where household_id=h and user_id=auth.uid()) $$;
create function is_owner(h uuid) returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from members where household_id=h and user_id=auth.uid() and role='owner') $$;

alter table profiles enable row level security; alter table households enable row level security;
alter table members enable row level security; alter table quick_items enable row level security;
alter table transactions enable row level security; alter table audit_log enable row level security;

create policy p_prof_sel on profiles for select using(id=auth.uid() or exists(select 1 from members a join members b on a.household_id=b.household_id where a.user_id=auth.uid() and b.user_id=profiles.id));
create policy p_prof_upd on profiles for update using(id=auth.uid());
create policy p_hh_sel on households for select using(is_member(id));
create policy p_mem_sel on members for select using(is_member(household_id));
create policy p_qi_all on quick_items for all using(is_member(household_id)) with check(is_member(household_id));
create policy p_tx_sel on transactions for select using(is_member(household_id));
create policy p_tx_ins on transactions for insert with check(is_member(household_id) and user_id=auth.uid());
create policy p_tx_upd on transactions for update using(is_member(household_id) and (user_id=auth.uid() or is_owner(household_id))) with check(is_member(household_id));
create policy p_tx_del on transactions for delete using(is_member(household_id) and (user_id=auth.uid() or is_owner(household_id)));
create policy p_audit_sel on audit_log for select using(is_member(household_id));

create function on_signup() returns trigger language plpgsql security definer set search_path=public as
$$ begin insert into profiles(id,name) values(new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1))); return new; end $$;
create trigger t_signup after insert on auth.users for each row execute function on_signup();

create function audit() returns trigger language plpgsql security definer set search_path=public as
$$ begin
 insert into audit_log(tx_id,household_id,actor,action,old_row,new_row)
 values(coalesce(new.id,old.id), coalesce(new.household_id,old.household_id), auth.uid(), tg_op, to_jsonb(old), to_jsonb(new));
 return coalesce(new,old); end $$;
create trigger t_audit after update or delete on transactions for each row execute function audit();

create function create_household(hname text) returns uuid language plpgsql security definer set search_path=public as
$$ declare h uuid; begin
 if auth.uid() is null then raise exception 'not signed in'; end if;
 insert into households(name,created_by) values(hname,auth.uid()) returning id into h;
 insert into members(household_id,user_id,role) values(h,auth.uid(),'owner');
 insert into quick_items(household_id,name,default_price) values
  (h,'Bread',20),(h,'Fish',250),(h,'Chicken',180),(h,'Meat',300),(h,'Rice',40),
  (h,'Vegetables',60),(h,'Fruits',80),(h,'Milk',50),(h,'Eggs',60),(h,'Other groceries',50);
 return h; end $$;

create function join_household(code text) returns uuid language plpgsql security definer set search_path=public as
$$ declare h uuid; begin
 if auth.uid() is null then raise exception 'not signed in'; end if;
 select id into h from households where invite_code=lower(trim(code));
 if h is null then raise exception 'invalid invitation code'; end if;
 insert into members(household_id,user_id) values(h,auth.uid()) on conflict do nothing;
 return h; end $$;

-- All totals are computed here, never in the browser. Withdrawals/deposits are transfers, not expenses.
create function household_summary(h uuid) returns json language sql stable security definer set search_path=public as
$$ select json_build_object(
 'balance', coalesce(sum(case when type in('income','withdraw') then amount else -amount end),0),
 'today', coalesce(sum(amount) filter(where type='expense' and (created_at at time zone 'Africa/Cairo')::date=(now() at time zone 'Africa/Cairo')::date),0),
 'week',  coalesce(sum(amount) filter(where type='expense' and date_trunc('week',created_at at time zone 'Africa/Cairo')=date_trunc('week',now() at time zone 'Africa/Cairo')),0),
 'month', coalesce(sum(amount) filter(where type='expense' and date_trunc('month',created_at at time zone 'Africa/Cairo')=date_trunc('month',now() at time zone 'Africa/Cairo')),0))
 from transactions where household_id=h and is_member(h) $$;

grant execute on function create_household, join_household, household_summary to authenticated;
alter publication supabase_realtime add table transactions;
