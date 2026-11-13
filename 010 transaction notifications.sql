-- 010: household-only push notifications for new transactions (stage 1).  Run after 009.
-- Adds two server-only tables, one trigger and four functions. No existing table, policy, grant, trigger or
-- accounting function is changed. The trigger only WRITES A ROW in the same database transaction as the new
-- entry (so it exists only if the entry was committed) and can never make the entry fail.
--
--   push_devices          which OneSignal subscription (= one browser/phone) belongs to which signed-in user
--   notification_outbox   one row per new transaction: pending -> sending -> sent | failed | skipped
-- Neither table is readable or writable from the browser (RLS on, no policies, privileges revoked).

create table if not exists push_devices(
  subscription_id text primary key check(subscription_id ~ '^[0-9a-fA-F-]{20,64}$'),
  user_id uuid not null references profiles(id) on delete cascade,          -- account deleted -> its devices are gone
  lang text not null default 'en' check(lang in('en','ar')),
  updated_at timestamptz not null default now());
create index if not exists push_devices_user_idx on push_devices(user_id);
alter table push_devices enable row level security;
revoke all on push_devices from anon, authenticated;

create table if not exists notification_outbox(
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references transactions(id) on delete cascade,   -- UNIQUE: one notification per transaction, ever
  household_id uuid not null references households(id) on delete cascade,
  status text not null default 'pending' check(status in('pending','sending','sent','failed','skipped')),
  recipients int, error text,
  created_at timestamptz not null default now(), claimed_at timestamptz, done_at timestamptz);
create index if not exists notification_outbox_pending_idx on notification_outbox(household_id) where status='pending';
alter table notification_outbox enable row level security;
revoke all on notification_outbox from anon, authenticated;

-- A new transaction was inserted -> remember that a notification is due. Runs inside the inserting transaction:
-- a rolled-back / rejected entry leaves no row. A retried offline entry (same client_id) inserts nothing, so the
-- trigger does not fire again. Any problem in here is swallowed: notifications must never block money.
create or replace function tx_notify_outbox() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 begin
  insert into notification_outbox(transaction_id,household_id) values(new.id,new.household_id) on conflict (transaction_id) do nothing;
 exception when others then
  raise warning 'notification_outbox: %', sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists tx_notify_outbox on transactions;
create trigger tx_notify_outbox after insert on transactions for each row execute function tx_notify_outbox();

-- This device (OneSignal subscription) now belongs to the signed-in user. Called by the app after login and whenever
-- the subscription changes. A subscription has exactly ONE owner: registering it again moves it (account switch).
create or replace function register_push_device(sub text, lng text default 'en') returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); s text:=lower(btrim(coalesce(sub,'')));
begin
 if me is null then raise exception 'not signed in' using errcode='42501'; end if;
 if s !~ '^[0-9a-f-]{20,64}$' then raise exception 'invalid subscription id'; end if;
 insert into push_devices(subscription_id,user_id,lang) values(s,me,case when lng='ar' then 'ar' else 'en' end)
 on conflict (subscription_id) do update set user_id=excluded.user_id, lang=excluded.lang, updated_at=now();
 -- keep at most 20 devices per account (oldest go first)
 delete from push_devices d where d.user_id=me and d.subscription_id in
  (select subscription_id from push_devices where user_id=me order by updated_at desc offset 20);
end $$;
revoke execute on function register_push_device(text,text) from public,anon;
grant execute on function register_push_device(text,text) to authenticated;

-- Log out / notifications switched off on this device: stop targeting it. Only the owner can remove it.
create or replace function unregister_push_device(sub text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 delete from push_devices where subscription_id=lower(btrim(coalesce(sub,''))) and user_id=auth.uid();
end $$;
revoke execute on function unregister_push_device(text) from public,anon;
grant execute on function unregister_push_device(text) to authenticated;

-- SERVER ONLY (Edge Function, service role). Atomically takes the due notifications of the households the CALLER
-- (already authenticated by the Edge Function) belongs to and returns, for each, the text ingredients and the
-- devices to notify. Household and recipients come from the database only - nothing is supplied by the browser.
-- A row can be claimed once: a second/concurrent call gets nothing (no duplicate notifications).
create or replace function push_claim(caller uuid, max_age interval default interval '15 minutes') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare out jsonb;
begin
 if caller is null then return '[]'::jsonb; end if;
 -- too old to be news (e.g. nobody could deliver it at the time): never send late
 update notification_outbox o set status='skipped', error='expired', done_at=now()
  where o.status='pending' and o.created_at < now()-max_age
    and o.household_id in (select m.household_id from members m where m.user_id=caller);
 with c as (
  update notification_outbox o set status='sending', claimed_at=now()
   where o.status='pending' and o.household_id in (select m.household_id from members m where m.user_id=caller)
   returning o.id, o.transaction_id, o.household_id, o.created_at)
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',c.id, 'key_en',c.id, 'key_ar',md5(c.id::text||':ar')::uuid,
   'type',t.type, 'amount',t.amount, 'category',t.category, 'note',t.note,
   'actor_id',t.user_id, 'actor',coalesce(p.name,''),
   'wallet',w.name, 'to_wallet',w2.name,
   'builtin_key',(select q.key from quick_items q where q.household_id=c.household_id and q.key is not null and q.name=t.category limit 1),
   'targets',coalesce((select jsonb_object_agg(x.lang,x.ids) from
       (select d.lang, jsonb_agg(distinct d.subscription_id) ids
          from members m join push_devices d on d.user_id=m.user_id     -- CURRENT members of THIS household only
         where m.household_id=c.household_id group by d.lang) x),'{}'::jsonb),
   'actor_devices',coalesce((select jsonb_agg(d.subscription_id) from push_devices d where d.user_id=t.user_id),'[]'::jsonb)
  ) order by c.created_at),'[]'::jsonb) into out
 from c join transactions t on t.id=c.transaction_id
 left join profiles p on p.id=t.user_id left join wallets w on w.id=t.wallet_id left join wallets w2 on w2.id=t.to_wallet_id;
 return out;
end $$;
revoke execute on function push_claim(uuid,interval) from public,anon,authenticated;
grant execute on function push_claim(uuid,interval) to service_role;

-- SERVER ONLY. Record the outcome; forget device ids OneSignal reported as no longer valid.
create or replace function push_done(nid uuid, st text, n int default null, err text default null, bad text[] default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update notification_outbox set status=case when st in('sent','failed','skipped') then st else 'failed' end,
   recipients=n, error=left(err,500), done_at=now() where id=nid and status='sending';
 if bad is not null and array_length(bad,1)>0 then delete from push_devices where subscription_id=any(bad); end if;
 delete from notification_outbox where done_at < now()-interval '30 days';       -- keep the log small
end $$;
revoke execute on function push_done(uuid,text,int,text,text[]) from public,anon,authenticated;
grant execute on function push_done(uuid,text,int,text,text[]) to service_role;
