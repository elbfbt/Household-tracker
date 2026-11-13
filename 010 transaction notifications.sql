-- 010: household-only push notifications for new transactions (stage 1).  Run after 009.
-- Adds two server-only tables, one trigger and four functions. No existing table, policy, grant, trigger or
-- accounting function is changed. The trigger only WRITES A ROW in the same database transaction as the new
-- entry (so it exists only if the entry was committed) and can never make the entry fail.
--
--   push_devices          which OneSignal subscription (= one browser/phone) belongs to which signed-in user
--   notification_outbox   one row per new transaction: pending -> sending -> sent | skipped | failed
--
-- LIFE OF A NOTIFICATION
--   pending   queued when the transaction was committed. It STAYS deliverable until it has been processed:
--             closing the app, being offline or a OneSignal outage only delay it.
--   sending   claimed by one run of the Edge Function (a run that died is taken over after 2 minutes;
--             OneSignal idempotency keys make the repeat harmless).
--   sent      OneSignal accepted it for the household's devices.
--   skipped   processed, nothing to deliver: nobody except the creator has a subscribed device.
--   failed    PERMANENT, always with a reason in "error". The only ways to get here:
--               a) OneSignal rejected the request itself as invalid (HTTP 4xx other than 401/403/429);
--               b) 10 delivery attempts failed (network errors, OneSignal 5xx/429, wrong/missing key ...);
--               c) it could not be delivered for 48 hours (see push_claim: too old to be news).
--   (a deleted transaction takes its notification with it)
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
  attempts int not null default 0,                       -- delivery attempts so far
  next_attempt_at timestamptz not null default now(),    -- retry back-off
  done_langs text[] not null default '{}',               -- language batches OneSignal already accepted (never sent again)
  created_at timestamptz not null default now(), claimed_at timestamptz, done_at timestamptz);
create index if not exists notification_outbox_pending_idx on notification_outbox(household_id) where status in('pending','sending');
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

-- WHO is notified about a transaction: the devices of the CURRENT members of its household, grouped by app language.
-- The person who made the entry is NOT notified about their own entry (application rule).
-- This function is the single place that decides recipients - a future per-user notification-preference system
-- (e.g. "also notify me", "mute expenses") only has to change this function.
create or replace function push_targets(h uuid, actor uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_object_agg(x.lang,x.ids),'{}'::jsonb) from
  (select d.lang, jsonb_agg(distinct d.subscription_id) ids
     from members m join push_devices d on d.user_id=m.user_id
    where m.household_id=h
      and (actor is null or m.user_id<>actor)            -- never the creator
    group by d.lang) x
$$;
revoke execute on function push_targets(uuid,uuid) from public,anon,authenticated;
grant execute on function push_targets(uuid,uuid) to service_role;

-- SERVER ONLY (Edge Function, service role). Atomically takes the due notifications of the households the CALLER
-- (already authenticated by the Edge Function) belongs to and returns, for each, the text ingredients and the
-- devices to notify. Household and recipients come from the database only - nothing is supplied by the browser.
-- A row is handed to ONE run at a time: a second/concurrent call gets nothing (no duplicate notifications).
-- A committed transaction's notification never silently disappears: it stays claimable until processed. Only after
-- give_up (48 hours) without a successful delivery is it closed as failed, with the reason recorded.
create or replace function push_claim(caller uuid, batch int default 25, give_up interval default interval '48 hours') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare out jsonb;
begin
 if caller is null then return '[]'::jsonb; end if;
 update notification_outbox o set status='failed', done_at=now(),
        error=coalesce(nullif(o.error,'')||' | ','')||'not delivered within '||give_up::text||' - given up'
  where o.status in('pending','sending') and o.created_at < now()-give_up
    and (o.status='pending' or o.claimed_at < now()-interval '2 minutes')
    and o.household_id in (select m.household_id from members m where m.user_id=caller);
 with due as (
  select o.id from notification_outbox o
   where o.household_id in (select m.household_id from members m where m.user_id=caller)
     and ((o.status='pending' and o.next_attempt_at<=now())
       or (o.status='sending' and o.claimed_at < now()-interval '2 minutes'))        -- a run that died: take over
   order by o.created_at limit greatest(1,least(coalesce(batch,25),100)) for update skip locked),
 c as (
  update notification_outbox o set status='sending', claimed_at=now(), attempts=o.attempts+1
   from due where o.id=due.id
   returning o.id, o.transaction_id, o.household_id, o.created_at, o.attempts, o.done_langs)
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',c.id, 'key_en',c.id, 'key_ar',md5(c.id::text||':ar')::uuid,
   'attempt',c.attempts, 'done_langs',to_jsonb(c.done_langs),
   'type',t.type, 'amount',t.amount, 'category',t.category, 'note',t.note,
   'actor',coalesce(p.name,''),
   'wallet',w.name, 'to_wallet',w2.name,
   'builtin_key',(select q.key from quick_items q where q.household_id=c.household_id and q.key is not null and q.name=t.category limit 1),
   'targets',push_targets(c.household_id,t.user_id)
  ) order by c.created_at),'[]'::jsonb) into out
 from c join transactions t on t.id=c.transaction_id
 left join profiles p on p.id=t.user_id left join wallets w on w.id=t.wallet_id left join wallets w2 on w2.id=t.to_wallet_id;
 return out;
end $$;
revoke execute on function push_claim(uuid,int,interval) from public,anon,authenticated;
grant execute on function push_claim(uuid,int,interval) to service_role;

-- SERVER ONLY. Record the outcome of one run.
--   st = 'sent' | 'skipped' | 'failed' (permanent) | 'retry' (temporary problem: back to pending with a back-off;
--        after 10 attempts it is closed as failed). langs = language batches OneSignal accepted in this run.
--   bad = device ids OneSignal reported as no longer valid -> forgotten.
create or replace function push_done(nid uuid, st text, n int default null, err text default null, bad text[] default null, langs text[] default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare max_attempts constant int:=10;
begin
 update notification_outbox o set
   done_langs=(select coalesce(array_agg(distinct x),'{}') from unnest(o.done_langs||coalesce(langs,'{}')) x),
   recipients=coalesce(o.recipients,0)+coalesce(n,0),
   error=case when err is null then o.error else left(err,500) end,
   status=case when st in('sent','skipped','failed') then st
               when o.attempts>=max_attempts then 'failed' else 'pending' end,
   next_attempt_at=case when st='retry' and o.attempts<max_attempts then now()+least(interval '1 minute'*power(2,o.attempts-1),interval '1 hour') else o.next_attempt_at end,
   done_at=case when st in('sent','skipped','failed') or o.attempts>=max_attempts then now() else null end
  where o.id=nid and o.status='sending';
 update notification_outbox o set error=left(coalesce(o.error,'')||' | gave up after '||max_attempts||' attempts',500)
  where o.id=nid and o.status='failed' and st='retry' and position('gave up' in coalesce(o.error,''))=0;
 if bad is not null and array_length(bad,1)>0 then delete from push_devices where subscription_id=any(bad); end if;
 delete from notification_outbox where done_at < now()-interval '30 days';       -- keep the log small
end $$;
revoke execute on function push_done(uuid,text,int,text,text[],text[]) from public,anon,authenticated;
grant execute on function push_done(uuid,text,int,text,text[],text[]) to service_role;
