-- 008: (1) deleting a transaction is never an "insufficient funds" error
--      (2) an account removed from the Supabase dashboard also leaves its entries behind as "Deleted user"
-- Run after 007. Safe on an existing DB: modifies NO existing rows, RLS policies and grants are unchanged.

-- (1) ROOT CAUSE of "Could not save: Insufficient funds. Available balance in Personal cash ...":
-- tx_balance_check() (006) also ran AFTER DELETE. Deleting an entry that had put money INTO a wallet (an income,
-- or the destination side of a transfer / withdraw / deposit) lowers that wallet, so when the money had already
-- been spent the DELETE itself was rejected with the message meant for new spending. Who created the row is
-- irrelevant - it only looked related to deleted accounts because their old top-ups are what people clean up.
--
-- Removing a record is not spending. The funds rule keeps applying to everything that takes money OUT:
-- INSERT (expense / transfer / withdraw / deposit) and UPDATE (raising an amount, changing wallets).
-- tx_lock() still row-locks the wallets on DELETE, so a delete and a concurrent spend are still serialised.
-- If the deletion leaves a wallet below zero the balance simply shows the truth, and that wallet cannot be
-- spent from again until it is topped up (any further decrease of a negative wallet is still rejected).
create or replace function tx_balance_check() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare ids uuid[]; w uuid; d numeric; bal numeric; wname text;
 o_w uuid; o_t uuid; n_w uuid; n_t uuid; ot text; oa numeric; nt text; na numeric;
begin
 if tg_op='DELETE' then return null; end if;
 if current_setting('app.bypass_balance',true)='on' then return null; end if;
 if tg_op='UPDATE' then o_w:=old.wallet_id; o_t:=old.to_wallet_id; ot:=old.type; oa:=old.amount; end if;
 n_w:=new.wallet_id; n_t:=new.to_wallet_id; nt:=new.type; na:=new.amount;
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

-- (2) creator stays immutable. The ONLY allowed change is user_id -> NULL while that user's profile is being
-- deleted: either through delete_my_account() (007) or because the profile row no longer exists (the account
-- was deleted from the Supabase dashboard; previously that deletion failed with "immutable transaction field
-- changed"). A client can never use this: while the profile exists the creator still cannot be changed.
-- Also fixes a NULL-logic hole in 007: when app.deleting_user had never been set in the session the comparison
-- evaluated to NULL instead of false, so "update transactions set user_id=null" by the creator/owner was NOT
-- rejected and could turn a living member's entry into "Deleted user". coalesce() closes it.
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

revoke execute on function tx_balance_check(),tx_before() from public,anon,authenticated;
