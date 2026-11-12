-- 004: withdraw / deposit are MOVES between two wallets (source -> destination), exactly like a transfer.
-- NOTE: this file was missing from the repository although the README and migrations 005-007 depend on it
-- (the app always sends to_wallet_id for withdraw/deposit, and 006's tx_effect() treats them as moves, but
-- 003's constraint rejects that). It was reconstructed from that behaviour. Run it on a FRESH project after 003.
-- If your database already has the original 004 it is safe to run again: it modifies NO rows, and the
-- constraint is only replaced when it is still the 003 version.
do $$ begin
 if exists(select 1 from pg_constraint where conrelid='public.transactions'::regclass and conname='transfer_ok'
           and pg_get_constraintdef(oid) not like '%withdraw%') then
  alter table transactions drop constraint transfer_ok;
  alter table transactions add constraint transfer_ok check(
    (type in('transfer','withdraw','deposit') and to_wallet_id is not null and to_wallet_id<>wallet_id)
    or (type in('income','expense') and to_wallet_id is null)) not valid;  -- not valid: old rows are left untouched
 end if;
end $$;

-- total = income - expenses. Moves between wallets never change the total and never count as spending.
create or replace function household_summary(h uuid) returns json language sql stable security definer set search_path=public,pg_temp as $$
select json_build_object(
 'balance', coalesce(sum(case when type='income' then amount when type='expense' then -amount else 0 end),0),
 'today', coalesce(sum(amount) filter(where type='expense' and (created_at at time zone 'Africa/Cairo')::date=(now() at time zone 'Africa/Cairo')::date),0),
 'week',  coalesce(sum(amount) filter(where type='expense' and date_trunc('week',created_at at time zone 'Africa/Cairo')=date_trunc('week',now() at time zone 'Africa/Cairo')),0),
 'month', coalesce(sum(amount) filter(where type='expense' and date_trunc('month',created_at at time zone 'Africa/Cairo')=date_trunc('month',now() at time zone 'Africa/Cairo')),0))
 from transactions where household_id=h and is_member(h) $$;

-- per-wallet balance: income + / expense - on its wallet; withdraw, deposit, transfer: - source, + destination
create or replace function wallet_balances(h uuid) returns json language sql stable security definer set search_path=public,pg_temp as $$
select coalesce(json_agg(json_build_object('id',w.id,'name',w.name,'balance',(select coalesce(sum(case
  when t.type='income' and t.wallet_id=w.id then t.amount
  when t.type='expense' and t.wallet_id=w.id then -t.amount
  when t.type in('withdraw','deposit','transfer') then (case when t.wallet_id=w.id then -t.amount else 0 end)+(case when t.to_wallet_id=w.id then t.amount else 0 end)
  else 0 end),0) from transactions t where t.household_id=h)) order by w.is_default desc,w.name),'[]')
from wallets w where w.household_id=h and is_member(h) $$;
grant execute on function household_summary(uuid), wallet_balances(uuid) to authenticated;
