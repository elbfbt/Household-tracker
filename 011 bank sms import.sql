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
  tx_updated_at timestamptz,       -- the linked entry's updated_at as this module last wrote it: equal = never edited since
  unique(household_id, fingerprint));
alter table bank_imports add column if not exists tx_updated_at timestamptz;
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
 -- one bank-SMS operation per household at a time (imports, transfer merges, undos): they can never interleave
 perform pg_advisory_xact_lock(hashtext('bank_sms:'||k.household_id::text));
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
  update bank_imports set transaction_id=tx, tx_updated_at=(select updated_at from transactions where id=tx) where id=imp;
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


-- =====================================================================================================================
-- INTERNAL TRANSFERS between two wallets of the same household (suggest, then confirm - never automatic)
--
-- Member A sends money to member B (or to their own other wallet). A's phone imports an outgoing message (expense on
-- wallet A), B's phone an incoming one (income on wallet B). The two messages share NO identifier: the references
-- differ, the clocks differ, names are masked. So nothing is ever merged automatically. The database only SUGGESTS a
-- pair when ALL of this holds, and a member must confirm it:
--   * same household; one verified outgoing-transfer import and one verified incoming-transfer import;
--   * two different wallets (the wallets come from the import keys - never from names, phone numbers or amounts);
--   * exactly the same amount; message times at most 15 minutes apart (either order);
--   * neither entry edited or deleted since it was imported; neither already part of a confirmed merge;
--   * it is the ONLY possible pairing for both entries (a second candidate on either side = ambiguous = no suggestion);
--   * the pair was not declined or undone before.
-- Confirming replaces the two entries by ONE entry of the app's existing type 'transfer' (wallet A -> wallet B); a
-- transfer is neither income nor expense in every summary. Undo puts back the two original rows exactly.
-- =====================================================================================================================
create table if not exists bank_transfer_merges(
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  out_import_id uuid not null references bank_imports(id) on delete cascade,   -- the outgoing message's import record
  in_import_id  uuid not null references bank_imports(id) on delete cascade,   -- the incoming message's import record
  status text not null check(status in('confirmed','undone','dismissed')),
  out_tx_id uuid not null, in_tx_id uuid not null,   -- ids of the two ORIGINAL entries (no FK: they do not exist while merged)
  transfer_tx_id uuid,                               -- the replacement transfer (no FK: it does not exist after an undo)
  snapshot jsonb,                                    -- the two original rows, complete, + import ids and fingerprints
  decided_by uuid references profiles(id) on delete set null, decided_at timestamptz not null default now(),
  undone_by uuid references profiles(id) on delete set null, undone_at timestamptz,
  constraint bank_transfer_merges_two_imports check(out_import_id<>in_import_id),
  constraint bank_transfer_merges_complete check(status='dismissed' or (snapshot is not null and transfer_tx_id is not null)),
  constraint bank_transfer_merges_pair unique(out_import_id,in_import_id));        -- one decision per pair, ever
-- an import record can be part of at most ONE confirmed merge (as either side)
create unique index if not exists bank_transfer_merges_out_confirmed on bank_transfer_merges(out_import_id) where status='confirmed';
create unique index if not exists bank_transfer_merges_in_confirmed  on bank_transfer_merges(in_import_id)  where status='confirmed';
create index if not exists bank_transfer_merges_hh on bank_transfer_merges(household_id,status);
alter table bank_transfer_merges enable row level security;
revoke all on bank_transfer_merges from anon, authenticated;
grant select on bank_transfer_merges to authenticated;
drop policy if exists p_bank_transfer_merges_sel on bank_transfer_merges;
create policy p_bank_transfer_merges_sel on bank_transfer_merges for select using(is_member(household_id));

-- tx_before() (008), unchanged except ONE added condition (marked): the rule "an entry can only be created for
-- yourself" does not apply while bank_transfer_confirm / bank_transfer_undo are replacing entries. Those two
-- functions are the only place that sets app.bank_transfer_merge, for the duration of their own statements; like the
-- existing app.deleting_user / app.bypass_balance switches it cannot be set through the API. Needed because the
-- member who confirms is not always the member who made the original entry, and an undo must give each original
-- entry back to its original creator.
create or replace function tx_before() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if auth.uid() is not null and new.user_id is distinct from auth.uid()
     and coalesce(current_setting('app.bank_transfer_merge',true),'')<>'on' then          -- <- the added condition
   raise exception 'cannot create a transaction for another user' using errcode='42501'; end if;
  if new.created_at>now()+interval '10 minutes' then new.created_at:=now(); end if;
  if new.wallet_id is null then
   select id into new.wallet_id from wallets where household_id=new.household_id order by is_default desc,created_at limit 1; end if;
 else
  if new.id is distinct from old.id or new.household_id is distinct from old.household_id
     or new.created_at is distinct from old.created_at or new.type is distinct from old.type or new.client_id is distinct from old.client_id
     or (new.user_id is distinct from old.user_id and not (new.user_id is null and (
          old.user_id::text=coalesce(current_setting('app.deleting_user',true),'')
          or not exists(select 1 from profiles where id=old.user_id)))) then
   raise exception 'immutable transaction field changed' using errcode='42501'; end if;
 end if;
 if not exists(select 1 from wallets where id=new.wallet_id and household_id=new.household_id)
  or (new.to_wallet_id is not null and not exists(select 1 from wallets where id=new.to_wallet_id and household_id=new.household_id))
 then raise exception 'wallet does not belong to this household' using errcode='42501'; end if;
 new.updated_at:=now();
 return new; end $$;
revoke execute on function tx_before() from public,anon,authenticated;

-- INTERNAL: imported transfer entries of household h that are still exactly as imported and not merged.
-- The rule list names the VERIFIED transfer rules only; a new verified transfer rule must be added here too.
create or replace function bank_transfer_eligible(h uuid)
returns table(import_id uuid, dir text, tx_id uuid, user_id uuid, wallet_id uuid, amount numeric, at timestamptz)
language sql stable security definer set search_path=public,pg_temp as $$
 select i.id, case when i.kind='transfer_out' then 'out' else 'in' end, t.id, t.user_id, t.wallet_id, t.amount, t.created_at
 from bank_imports i join transactions t on t.id=i.transaction_id
 where i.household_id=h and t.household_id=h and t.to_wallet_id is null
   and ((i.kind='transfer_out' and t.type='expense' and i.rule in('nbe.instapay_out.ar','vfc.sent.ar'))
     or (i.kind='transfer_in'  and t.type='income'  and i.rule in('nbe.instapay_in.ar','vfc.received.ar')))
   and i.tx_updated_at is not null and t.updated_at=i.tx_updated_at          -- any edit of the entry moves updated_at
   and not exists(select 1 from bank_transfer_merges m where m.status='confirmed' and (m.out_import_id=i.id or m.in_import_id=i.id)) $$;

-- INTERNAL: the suggestions = pairs that meet every condition and are the only possible pairing on both sides.
create or replace function bank_transfer_pairs(h uuid) returns table(out_import uuid, in_import uuid)
language sql stable security definer set search_path=public,pg_temp as $$
 with e as (select * from bank_transfer_eligible(h)),
 p as (select o.import_id o_id, i.import_id i_id from e o join e i
        on o.dir='out' and i.dir='in' and o.wallet_id<>i.wallet_id and o.amount=i.amount
       and i.at between o.at-interval '15 minutes' and o.at+interval '15 minutes')
 select p.o_id, p.i_id from p
 where (select count(*) from p x where x.o_id=p.o_id)=1 and (select count(*) from p x where x.i_id=p.i_id)=1
   and not exists(select 1 from bank_transfer_merges m where m.out_import_id=p.o_id and m.in_import_id=p.i_id) $$;

-- For the app: the open suggestions and the merges of the last 7 days (which can still be undone from the screen).
create or replace function bank_transfer_candidates(h uuid) returns json
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); own boolean;
begin
 if me is null or not is_member(h) then return json_build_object('candidates','[]'::json,'merged','[]'::json); end if;
 own:=is_owner(h);
 return json_build_object(
  'candidates',(select coalesce(json_agg(x order by x.at desc),'[]') from (
     select p.out_import, p.in_import, o.amount, o.at, o.tx_id out_transaction_id, i.tx_id in_transaction_id,
            (select name from wallets where id=o.wallet_id) from_wallet, (select name from wallets where id=i.wallet_id) to_wallet,
            (select name from profiles where id=o.user_id) from_member, (select name from profiles where id=i.user_id) to_member,
            (own or me=o.user_id or me=i.user_id) can_decide
     from bank_transfer_pairs(h) p join bank_transfer_eligible(h) o on o.import_id=p.out_import
                                   join bank_transfer_eligible(h) i on i.import_id=p.in_import) x),
  'merged',(select coalesce(json_agg(y order by y.decided_at desc),'[]') from (
     select m.id, t.amount, t.created_at at, m.decided_at, t.id transaction_id,
            (select name from wallets where id=t.wallet_id) from_wallet, (select name from wallets where id=t.to_wallet_id) to_wallet,
            (select name from profiles where id=m.decided_by) decided_by,
            (own or me=m.decided_by or me::text in(m.snapshot->'out'->>'user_id',m.snapshot->'in'->>'user_id')) can_undo
     from bank_transfer_merges m join transactions t on t.id=m.transfer_tx_id
     where m.household_id=h and m.status='confirmed' and m.decided_at>now()-interval '7 days') y));
end $$;

-- Confirm a suggestion: ONE atomic operation. Idempotent: confirming a pair that is already merged returns that merge.
create or replace function bank_transfer_confirm(o uuid, i uuid) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); h uuid; io bank_imports; ii bank_imports; m bank_transfer_merges; t_o transactions; t_i transactions;
        tr uuid; upd timestamptz; mid uuid;
begin
 if me is null then raise exception 'not signed in' using errcode='42501'; end if;
 select * into io from bank_imports where id=o; select * into ii from bank_imports where id=i;
 if io.id is null or ii.id is null or io.household_id<>ii.household_id or not is_member(io.household_id) then
  return json_build_object('status','not_found'); end if;
 h:=io.household_id;
 perform pg_advisory_xact_lock(hashtext('bank_sms:'||h::text));          -- no import / merge / undo of this household runs meanwhile
 select * into m from bank_transfer_merges where out_import_id=o and in_import_id=i;
 if found then
  if m.status='confirmed' then return json_build_object('status','already_merged','merge_id',m.id,'transaction_id',m.transfer_tx_id); end if;
  return json_build_object('status','not_eligible','reason','declined_before');
 end if;
 -- locks, in the order every writer uses: wallets (by id), then the two import records, then the two entries
 select * into io from bank_imports where id=o; select * into ii from bank_imports where id=i;
 select * into t_o from transactions where id=io.transaction_id; select * into t_i from transactions where id=ii.transaction_id;
 if t_o.id is null or t_i.id is null then return json_build_object('status','not_eligible','reason','conditions_not_met'); end if;
 perform 1 from wallets where household_id=h and id in(t_o.wallet_id,t_i.wallet_id) order by id for update;
 perform 1 from bank_imports where id in(o,i) order by id for update;
 select * into t_o from transactions where id=io.transaction_id for update;
 select * into t_i from transactions where id=ii.transaction_id for update;
 -- every condition again, now that nothing can change underneath
 if t_o.id is null or t_i.id is null or not exists(select 1 from bank_transfer_pairs(h) p where p.out_import=o and p.in_import=i) then
  return json_build_object('status','not_eligible','reason','conditions_not_met'); end if;
 if not (is_owner(h) or me=t_o.user_id or me=t_i.user_id) then
  raise exception 'only the two members involved or the household owner can decide this' using errcode='42501'; end if;

 perform set_config('app.bypass_balance','on',true); perform set_config('app.bank_transfer_merge','on',true);
 delete from transactions where id in(t_o.id,t_i.id);
 insert into transactions(household_id,user_id,wallet_id,to_wallet_id,type,amount,category,note,created_at)
  values(h,t_o.user_id,t_o.wallet_id,t_i.wallet_id,'transfer',t_o.amount,'Transfer',
         left('Bank SMS · internal transfer'||coalesce(' · ref '||io.reference,'')||coalesce(' · ref '||ii.reference,''),200),t_o.created_at)
  returning id,updated_at into tr,upd;
 perform set_config('app.bypass_balance','off',true); perform set_config('app.bank_transfer_merge','off',true);
 -- no third notification: the two original entries were announced when they were imported
 update notification_outbox set status='skipped',done_at=now(),error='internal transfer merge' where transaction_id=tr;
 update bank_imports set transaction_id=tr, tx_updated_at=upd where id in(o,i);
 insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id,transfer_tx_id,snapshot,decided_by)
  values(h,o,i,'confirmed',t_o.id,t_i.id,tr,
   jsonb_build_object('out',to_jsonb(t_o),'in',to_jsonb(t_i),
    'out_import',jsonb_build_object('id',io.id,'fingerprint',io.fingerprint),'in_import',jsonb_build_object('id',ii.id,'fingerprint',ii.fingerprint)),me)
  returning id into mid;
 return json_build_object('status','merged','merge_id',mid,'transaction_id',tr);
end $$;

-- Decline a suggestion: it is not offered again. Changes no entry.
create or replace function bank_transfer_dismiss(o uuid, i uuid) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); h uuid; io bank_imports; ii bank_imports; m bank_transfer_merges; uo uuid; ui uuid;
begin
 if me is null then raise exception 'not signed in' using errcode='42501'; end if;
 select * into io from bank_imports where id=o; select * into ii from bank_imports where id=i;
 if io.id is null or ii.id is null or io.household_id<>ii.household_id or not is_member(io.household_id) then
  return json_build_object('status','not_found'); end if;
 h:=io.household_id;
 perform pg_advisory_xact_lock(hashtext('bank_sms:'||h::text));
 select * into m from bank_transfer_merges where out_import_id=o and in_import_id=i;
 if found then
  if m.status='confirmed' then return json_build_object('status','not_eligible','reason','already_merged'); end if;
  return json_build_object('status','already_dismissed');
 end if;
 if not exists(select 1 from bank_transfer_pairs(h) p where p.out_import=o and p.in_import=i) then
  return json_build_object('status','not_eligible','reason','conditions_not_met'); end if;
 select * into io from bank_imports where id=o; select * into ii from bank_imports where id=i;
 uo:=io.transaction_id; ui:=ii.transaction_id;
 if not (is_owner(h) or exists(select 1 from transactions where id in(uo,ui) and user_id=me)) then
  raise exception 'only the two members involved or the household owner can decide this' using errcode='42501'; end if;
 insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id,decided_by) values(h,o,i,'dismissed',uo,ui,me);
 return json_build_object('status','dismissed');
end $$;

-- Undo a confirmed merge: ONE atomic operation that puts back the two ORIGINAL rows - same ids, creator, wallet, type,
-- amount, description, note, time, client id (only updated_at is new: it is the "last changed" stamp devices use to
-- notice a change). The import records are re-pointed, never re-created. Idempotent: a second undo returns the same
-- result. Refused if the transfer was edited or deleted meanwhile (then the two originals are no longer what the
-- household's books contain). An undone pair is not suggested again.
create or replace function bank_transfer_undo(mid uuid) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); h uuid; m bank_transfer_merges; tr transactions; ro transactions; ri transactions; stamp timestamptz;
begin
 if me is null then raise exception 'not signed in' using errcode='42501'; end if;
 select * into m from bank_transfer_merges where id=mid;
 if not found or not is_member(m.household_id) then return json_build_object('status','not_found'); end if;
 h:=m.household_id;
 perform pg_advisory_xact_lock(hashtext('bank_sms:'||h::text));
 select * into m from bank_transfer_merges where id=mid for update;
 if m.status='undone' then return json_build_object('status','already_undone','out_transaction_id',m.out_tx_id,'in_transaction_id',m.in_tx_id); end if;
 if m.status<>'confirmed' then return json_build_object('status','not_eligible','reason','not_merged'); end if;
 ro:=jsonb_populate_record(null::transactions,m.snapshot->'out'); ri:=jsonb_populate_record(null::transactions,m.snapshot->'in');
 if not (is_owner(h) or me=m.decided_by or me=ro.user_id or me=ri.user_id) then
  raise exception 'only the two members involved or the household owner can decide this' using errcode='42501'; end if;
 perform 1 from wallets where household_id=h and id in(ro.wallet_id,ri.wallet_id) order by id for update;
 perform 1 from bank_imports where id in(m.out_import_id,m.in_import_id) order by id for update;
 select * into tr from transactions where id=m.transfer_tx_id for update;
 if not found then return json_build_object('status','not_eligible','reason','transfer_deleted'); end if;
 select tx_updated_at into stamp from bank_imports where id=m.out_import_id;
 if tr.updated_at is distinct from stamp or tr.type<>'transfer' or tr.amount<>ro.amount
    or tr.wallet_id<>ro.wallet_id or tr.to_wallet_id<>ri.wallet_id then
  return json_build_object('status','not_eligible','reason','transfer_changed'); end if;
 if exists(select 1 from transactions where id in(m.out_tx_id,m.in_tx_id)) then
  return json_build_object('status','not_eligible','reason','original_exists'); end if;
 -- a member whose account was deleted meanwhile: their entry comes back the way the app keeps such entries
 if ro.user_id is not null and not exists(select 1 from profiles where id=ro.user_id) then ro.user_id:=null; end if;
 if ri.user_id is not null and not exists(select 1 from profiles where id=ri.user_id) then ri.user_id:=null; end if;

 perform set_config('app.bypass_balance','on',true); perform set_config('app.bank_transfer_merge','on',true);
 delete from transactions where id=tr.id;
 insert into transactions values(ro.*);
 insert into transactions values(ri.*);
 perform set_config('app.bypass_balance','off',true); perform set_config('app.bank_transfer_merge','off',true);
 -- the originals were announced when they were first imported: nothing is sent again
 update notification_outbox set status='skipped',done_at=now(),error='internal transfer merge undone' where transaction_id in(ro.id,ri.id);
 update bank_imports set transaction_id=ro.id, tx_updated_at=(select updated_at from transactions where id=ro.id) where id=m.out_import_id;
 update bank_imports set transaction_id=ri.id, tx_updated_at=(select updated_at from transactions where id=ri.id) where id=m.in_import_id;
 update bank_transfer_merges set status='undone', undone_by=me, undone_at=now() where id=mid;
 return json_build_object('status','undone','out_transaction_id',ro.id,'in_transaction_id',ri.id);
end $$;

revoke execute on function bank_transfer_eligible(uuid),bank_transfer_pairs(uuid) from public,anon,authenticated;
revoke execute on function bank_transfer_candidates(uuid),bank_transfer_confirm(uuid,uuid),bank_transfer_dismiss(uuid,uuid),bank_transfer_undo(uuid) from public,anon;
grant execute on function bank_transfer_candidates(uuid),bank_transfer_confirm(uuid,uuid),bank_transfer_dismiss(uuid,uuid),bank_transfer_undo(uuid) to authenticated;
