-- 009: Quick Purchases get (1) a built-in KEY, so standard items are shown in the app language while custom
--      items always keep the exact name the user typed, and (2) an optional explicitly chosen ICON.
-- Run after 008. Safe on an existing DB: adds two nullable columns; the only data change is tagging the ten
-- originally seeded items (Bread, Fish, ...) as built-in. No price, name, transaction, policy or grant is changed.
alter table quick_items add column if not exists key text;
alter table quick_items add column if not exists icon text;
do $$ begin
 alter table quick_items add constraint quick_items_key_ok check(key is null or key ~ '^[a-z_]{1,40}$');
exception when duplicate_object then null; end $$;
do $$ begin
 alter table quick_items add constraint quick_items_icon_ok check(icon is null or char_length(icon) between 1 and 16);
exception when duplicate_object then null; end $$;

update quick_items q set key=v.k
from (values('bread','bread'),('fish','fish'),('chicken','chicken'),('meat','meat'),('rice','rice'),('vegetables','vegetables'),
            ('fruits','fruits'),('milk','milk'),('eggs','eggs'),('other groceries','other_groceries')) v(n,k)
where q.key is null and lower(btrim(q.name))=v.n
  and not exists(select 1 from quick_items o where o.household_id=q.household_id and o.key=v.k);

do $$ begin create unique index if not exists quick_items_hh_key_uq on quick_items(household_id,key) where key is not null;
exception when unique_violation then raise notice 'duplicate built-in quick items already exist; unique index not created'; end $$;

-- create OR update one Quick Purchase. NEVER creates a transaction.
--   k  = built-in key (null for a custom item)      ic = explicitly chosen icon (null = automatic)
-- one row per built-in key and per name (case-insensitive) in a household; safe against double-submit / races.
create or replace function save_quick_item(h uuid, n text, p numeric, k text default null, ic text default null) returns json
language plpgsql security definer set search_path=public,pg_temp as $$
declare nm text:=btrim(coalesce(n,'')); kk text:=nullif(btrim(coalesce(k,'')),''); ii text:=nullif(btrim(coalesce(ic,'')),''); qid uuid; tries int:=0;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if not is_member(h) then raise exception 'not a member of this household' using errcode='42501'; end if;
 if length(nm) not between 1 and 40 then raise exception 'quick purchase name must be 1-40 characters'; end if;
 if p is null or p<0 or p>=1000000000 then raise exception 'invalid price'; end if;
 if kk is not null and kk !~ '^[a-z_]{1,40}$' then raise exception 'invalid quick purchase key'; end if;
 if ii is not null and char_length(ii)>16 then raise exception 'invalid icon'; end if;
 loop
  qid:=null;
  if kk is not null then select q.id into qid from quick_items q where q.household_id=h and q.key=kk limit 1; end if;
  if qid is null then select q.id into qid from quick_items q where q.household_id=h and lower(btrim(q.name))=lower(nm) limit 1; end if;
  if qid is not null then
   update quick_items q set default_price=round(p,2), key=coalesce(q.key,kk), icon=coalesce(ii,q.icon) where q.id=qid;
   return json_build_object('id',qid,'created',false,'updated',true);
  end if;
  begin
   insert into quick_items(household_id,name,default_price,key,icon) values(h,nm,round(p,2),kk,ii) returning quick_items.id into qid;
   return json_build_object('id',qid,'created',true,'updated',false);
  exception when unique_violation then
   tries:=tries+1; if tries>3 then raise; end if;      -- someone added it at the same moment: loop and update theirs
  end;
 end loop;
end $$;
revoke execute on function save_quick_item(uuid,text,numeric,text,text) from public,anon;
grant execute on function save_quick_item(uuid,text,numeric,text,text) to authenticated;

-- new households: same ten starter items as before, now tagged as built-in
create or replace function create_household(hname text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare h uuid; begin
 if auth.uid() is null then raise exception 'not signed in'; end if;
 insert into households(name,created_by) values(hname,auth.uid()) returning id into h;
 insert into members(household_id,user_id,role) values(h,auth.uid(),'owner');
 insert into wallets(household_id,name,is_default) values(h,'Household cash',true),(h,'Bank account',false),(h,'Personal cash',false);
 insert into quick_items(household_id,name,default_price,key) values(h,'Bread',20,'bread'),(h,'Fish',250,'fish'),(h,'Chicken',180,'chicken'),(h,'Meat',300,'meat'),(h,'Rice',40,'rice'),
  (h,'Vegetables',60,'vegetables'),(h,'Fruits',80,'fruits'),(h,'Milk',50,'milk'),(h,'Eggs',60,'eggs'),(h,'Other groceries',50,'other_groceries');
 return h; end $$;
revoke execute on function create_household(text) from public,anon;
grant execute on function create_household(text) to authenticated;
