-- 011: Bank SMS import (server side only). Run after 010.
-- Adds two tables and five functions. No existing table, policy, trigger, function or row is changed.
-- An imported bank message becomes a NORMAL row in "transactions" (same types, same wallets, same balance rules,
-- same audit trigger, same notification outbox trigger) - there is no second accounting model.
--
--   bank_import_keys : one row per import key. A key belongs to ONE user, ONE household, ONE SMS sender and the
--                      wallets that sender's messages affect. Only the SHA-256 of the key is stored; the key itself
--                      is shown once, when it is created. The key is what authenticates the phone automation later.
--   bank_imports     : one row per imported bank message (never the message text: only its hash, the parser rule,
--                      the bank reference and the fingerprint). UNIQUE(household_id, fingerprint) is the database
--                      guarantee that one bank transaction can never become two entries - also after the entry was
--                      deleted in the app (the row stays, transaction_id becomes null).
-- Members may READ bank_imports of their household (to tell imported entries from manual ones). Nobody can write
-- either table from the browser; bank_import_keys cannot even be read.

create table if not exists bank_import_keys(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  key_hash text not null unique,
  sender text not null,
  wallet_id uuid references wallets(id) on delete set null,        -- the account the messages are about
  cash_wallet_id uuid references wallets(id) on delete set null,   -- where ATM cash goes / cash deposits come from
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz);
create index if not exists bank_import_keys_user on bank_import_keys(user_id);
alter table bank_import_keys enable row level security;
revoke all on bank_import_keys from anon, authenticated;

create table if not exists bank_imports(
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  key_id uuid references bank_import_keys(id) on delete set null,
  transaction_id uuid references transactions(id) on delete set null,
  fingerprint text not null,
  provider text not null, kind text not null, rule text not null,
  reference text, sms_hash text not null,
  created_at timestamptz not null default now(),
  unique(household_id, fingerprint));
create index if not exists bank_imports_tx on bank_imports(transaction_id);
alter table bank_imports enable row level security;
revoke all on bank_imports from anon, authenticated;
grant select on bank_imports to authenticated;
drop policy if exists p_bank_imports_sel on bank_imports;
create policy p_bank_imports_sel on bank_imports for select using(is_member(household_id));

-- INTERNAL: create a key for user u. Wallets given must belong to the user's household. When no wallet is given the
-- app's own built-ins are used: the wallet named "Bank account" (only if exactly one exists) and the household's
-- default wallet for cash. If the account wallet cannot be determined: error wallet_required (nothing is guessed).
create or replace function bank_import_key_new(u uuid, snd text, w uuid, cw uuid, days int) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare h uuid; n int; k text; s text:=btrim(coalesce(snd,'')); d int:=coalesce(days,365);
begin
 if u is null then raise exception 'not signed in' using errcode='42501'; end if;
 if length(s) not between 2 and 40 then raise exception 'sender must be 2-40 characters'; end if;
 if d not between 1 and 730 then raise exception 'validity must be 1-730 days'; end if;
 select count(*), min(household_id::text)::uuid into n, h from members where user_id=u;
 if n<>1 then raise exception 'the user must belong to exactly one household' using errcode='42501'; end if;
 if w is null then
  select count(*), min(id::text)::uuid into n, w from wallets where household_id=h and lower(btrim(name))='bank account';
  if n<>1 then raise exception 'wallet_required: choose the wallet that represents this bank account'; end if;
 elsif not exists(select 1 from wallets where id=w and household_id=h) then
  raise exception 'wallet does not belong to this household' using errcode='42501'; end if;
 if cw is null then select id into cw from wallets where household_id=h and is_default and id<>w order by created_at limit 1;
 elsif cw=w or not exists(select 1 from wallets where id=cw and household_id=h) then
  raise exception 'cash wallet does not belong to this household' using errcode='42501'; end if;
 if (select count(*) from bank_import_keys where user_id=u and revoked_at is null and expires_at>now())>=10 then
  raise exception 'too many active import keys - revoke one first'; end if;
 k:='htk_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');     -- 244 random bits
 insert into bank_import_keys(user_id,household_id,key_hash,sender,wallet_id,cash_wallet_id,expires_at)
  values(u,h,encode(sha256(convert_to(k,'UTF8')),'hex'),s,w,cw,now()+make_interval(days=>d));
 return json_build_object('key',k,'sender',s,'expires_at',now()+make_interval(days=>d),
  'wallet',(select name from wallets where id=w),'cash_wallet',(select name from wallets where id=cw));
end $$;

-- A signed-in user creates a key for THEMSELVES (the user is taken from the login, never from a parameter).
create or replace function bank_import_create_key(sender text, wallet uuid default null, cash_wallet uuid default null, valid_days int default 365) returns json
language sql security definer set search_path=public,pg_temp as $$ select bank_import_key_new(auth.uid(),sender,wallet,cash_wallet,valid_days) $$;

-- A signed-in user revokes all of their own keys (lost phone, key leaked). Returns how many were revoked.
create or replace function bank_import_revoke_keys() returns int
language plpgsql security definer set search_path=public,pg_temp as $$
declare n int;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 update bank_import_keys set revoked_at=now() where user_id=auth.uid() and revoked_at is null;
 get diagnostics n=row_count; return n;
end $$;

-- SERVER ONLY (Edge Function bank-sms-import, service role). Who does this key hash belong to?
-- Returns {ok:false, reason} for unknown / revoked / expired keys and for users who left the household.
create or replace function bank_import_auth(kh text) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare k bank_import_keys;
begin
 select * into k from bank_import_keys where key_hash=kh;
 if not found then return json_build_object('ok',false,'reason','unknown_key'); end if;
 if k.revoked_at is not null then return json_build_object('ok',false,'reason','revoked_key'); end if;
 if k.expires_at<=now() then return json_build_object('ok',false,'reason','expired_key'); end if;
 if not exists(select 1 from members m where m.household_id=k.household_id and m.user_id=k.user_id) then
  return json_build_object('ok',false,'reason','not_a_member'); end if;
 return json_build_object('ok',true,'key_id',k.id,'user_id',k.user_id,'sender',k.sender);
end $$;

-- SERVER ONLY. Records one parsed bank message as a normal transaction - atomically, exactly once.
--   kh    : SHA-256 of the import key (checked again here; user, household and wallets come from the key row ONLY)
--   p     : what the parser found: type, amount, category, note, at, fingerprint, provider, kind, rule, reference, sms_hash
--   dry   : true = check everything and report what WOULD happen, write nothing
-- Wallets by type (the app's own model):  expense / income -> the key's account wallet
--                                         withdraw -> account wallet -> cash wallet;  deposit -> cash wallet -> account wallet
-- Result status: imported | already_imported | would_import | unauthorized | wallet_required | rejected
--
-- BALANCE RULE. The bank has already carried the transaction out, so an import is NOT refused because the app's
-- wallet holds too little (the app's figure may simply be out of date). For an entry that takes money out of a
-- wallet, this function switches the "Insufficient funds" check off for its ONE insert (app.bypass_balance, the
-- switch tx_balance_check already has, transaction-local) and switches it off again straight afterwards. The wallet
-- then shows the true, possibly negative, balance and the result carries balance_negative = true.
-- Nothing else changes: the trigger, the constraints and RLS are untouched, and everything a user enters in the app
-- is checked exactly as before (so a negative wallet cannot be spent from by hand until it is topped up).
-- The same switch also makes tx_lock() skip its wallet row lock, so the lock is taken HERE, explicitly, in the same
-- order (by id) - imports and manual entries on one wallet are still strictly one after the other.
create or replace function bank_import_commit(kh text, p jsonb, dry boolean default false) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare k bank_import_keys; a json; t text:=p->>'type'; amt numeric; at_ timestamptz; w1 uuid; w2 uuid; imp uuid; tx uuid; ex bank_imports;
        fp text:=p->>'fingerprint'; msg text; neg boolean:=false;
begin
 a:=bank_import_auth(kh);
 if not (a->>'ok')::boolean then return json_build_object('status','unauthorized','reason',a->>'reason'); end if;
 select * into k from bank_import_keys where key_hash=kh;
 if t is null or t not in('expense','income','withdraw','deposit') then return json_build_object('status','rejected','reason','unsupported_type'); end if;
 begin amt:=round((p->>'amount')::numeric,2); at_:=coalesce((p->>'at')::timestamptz,now());
 exception when others then return json_build_object('status','rejected','reason','invalid_value'); end;
 if amt is null or amt<=0 or amt>=10000000000 then return json_build_object('status','rejected','reason','invalid_amount'); end if;
 if fp is null or fp !~ '^[0-9a-f]{64}$' or coalesce(p->>'sms_hash','') !~ '^[0-9a-f]{64}$' then return json_build_object('status','rejected','reason','invalid_fingerprint'); end if;
 -- wallets: only from the key row, and only if they still exist in the key's household
 w1:=(select id from wallets where id=k.wallet_id and household_id=k.household_id);
 if w1 is null then return json_build_object('status','wallet_required','reason','account_wallet_missing'); end if;
 if t in('withdraw','deposit') then
  w2:=(select id from wallets where id=k.cash_wallet_id and household_id=k.household_id and id<>w1);
  if w2 is null then return json_build_object('status','wallet_required','reason','cash_wallet_missing'); end if;
  if t='deposit' then imp:=w1; w1:=w2; w2:=imp; imp:=null; end if;
 end if;
 select * into ex from bank_imports where household_id=k.household_id and fingerprint=fp;
 if found then return json_build_object('status','already_imported','transaction_id',ex.transaction_id); end if;
 if dry then return json_build_object('status','would_import','user_id',k.user_id,
   'wallet',(select name from wallets where id=w1),'to_wallet',(select name from wallets where id=w2),
   'balance_negative',(t<>'income' and wallet_bal(w1)-amt<0)); end if;
 -- the unique index decides races: of two simultaneous identical requests exactly one inserts
 insert into bank_imports(household_id,user_id,key_id,fingerprint,provider,kind,rule,reference,sms_hash)
  values(k.household_id,k.user_id,k.id,fp,left(coalesce(p->>'provider',''),40),left(coalesce(p->>'kind',''),40),left(coalesce(p->>'rule',''),60),
         nullif(left(coalesce(p->>'reference',''),60),''),p->>'sms_hash')
  on conflict(household_id,fingerprint) do nothing returning id into imp;
 if imp is null then
  select * into ex from bank_imports where household_id=k.household_id and fingerprint=fp;
  return json_build_object('status','already_imported','transaction_id',ex.transaction_id); end if;
 -- the wallet lock tx_lock() would take (same rows, same order); held until this request's transaction ends
 perform 1 from wallets where household_id=k.household_id and id=any(array[w1,w2]) order by id for update;
 begin
  -- w1 is the wallet the money leaves (expense, withdraw, deposit). An income only adds money: no bypass needed.
  if t<>'income' then perform set_config('app.bypass_balance','on',true); end if;
  insert into transactions(household_id,user_id,wallet_id,to_wallet_id,type,amount,category,note,created_at)
   values(k.household_id,k.user_id,w1,w2,t,amt,left(coalesce(p->>'category',''),80),left(coalesce(p->>'note',''),200),at_)
   returning id into tx;
  perform set_config('app.bypass_balance','off',true);           -- off again immediately after the one insert
  update bank_imports set transaction_id=tx where id=imp;
  if t<>'income' then neg:=wallet_bal(w1)<0; end if;
 exception when others then
  -- the entry was refused by another of the app's rules: the sub-transaction is rolled back (the switch with it),
  -- the fingerprint row is removed again so the same message can be imported later, nothing is half-written
  get stacked diagnostics msg=message_text;
  perform set_config('app.bypass_balance','off',true);
  delete from bank_imports where id=imp;
  return json_build_object('status','rejected','reason','transaction_refused','detail',left(msg,200));
 end;
 update bank_import_keys set last_used_at=now() where id=k.id;
 return json_build_object('status','imported','transaction_id',tx,'user_id',k.user_id,
   'wallet',(select name from wallets where id=w1),'to_wallet',(select name from wallets where id=w2),'balance_negative',neg);
end $$;

revoke execute on function bank_import_key_new(uuid,text,uuid,uuid,int),bank_import_auth(text),bank_import_commit(text,jsonb,boolean) from public,anon,authenticated;
grant execute on function bank_import_key_new(uuid,text,uuid,uuid,int),bank_import_auth(text),bank_import_commit(text,jsonb,boolean) to service_role;
revoke execute on function bank_import_create_key(text,uuid,uuid,int),bank_import_revoke_keys() from public,anon;
grant execute on function bank_import_create_key(text,uuid,uuid,int),bank_import_revoke_keys() to authenticated;
