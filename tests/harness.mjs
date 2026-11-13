// Tiny shared test helpers + a REAL PostgreSQL (embedded binary from npm) with a minimal Supabase shim,
// so the repository's actual migrations, triggers and RLS policies are what gets tested.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MIGRATIONS=['schema.sql','002_analytics.sql','003_wallets_offline.sql','004 fix withdraw.sql','005 integrity security.sql','006 funds members quickitems.sql','007 account deletion quickitems.sql','008 delete fix deleted users.sql','009 quick purchase catalog.sql','010 transaction notifications.sql','011 bank sms import.sql'];
let pass=0,fail=0;const fails=[];
export async function test(name,fn){try{await fn();pass++;console.log('  ok   '+name)}catch(e){fail++;fails.push(name);console.log('  FAIL '+name+'\n       '+String(e&&e.stack||e).split('\n').slice(0,4).join('\n       '))}}
export function eq(a,b,m=''){const x=JSON.stringify(a),y=JSON.stringify(b);if(x!==y)throw new Error(`${m} expected ${y}, got ${x}`)}
export function ok(v,m='assertion failed'){if(!v)throw new Error(m)}
export async function throws(fn,re,m=''){let e=null;try{await fn()}catch(x){e=x}if(!e)throw new Error(`${m} expected an error matching ${re}`);if(re&&!re.test(String(e.message)))throw new Error(`${m} wrong error: ${e.message}`);return e}
export function done(label){console.log(`\n${label}: ${pass} passed, ${fail} failed`);if(fail){console.log('failed: '+fails.join(' | '));process.exitCode=1}return fail}
export const SHIM=`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; grant usage on schema auth to anon,authenticated,service_role;
create table auth.users(id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
create publication supabase_realtime;`;
export async function startDb(){
  const {default:EmbeddedPostgres}=await import('embedded-postgres');const {default:pg}=await import('pg');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ht-pg-')),port=54000+Math.floor(Math.random()*900);
  const srv=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'pw',port,persistent:false,onLog:()=>{},onError:()=>{}});
  await srv.initialise();await srv.start();
  const conn=async()=>{const c=new pg.Client({host:'localhost',port,user:'postgres',password:'pw',database:'postgres'});await c.connect();return c};
  const admin=await conn();await admin.query(SHIM);
  const migrate=async files=>{for(const f of files)await admin.query(fs.readFileSync(path.join(ROOT,f),'utf8')).catch(e=>{throw new Error(`migration "${f}" failed: ${e.message}`)})};
  // run statements exactly like a logged-in browser would: role "authenticated", auth.uid() = uid, RLS on
  const begin=async(c,uid)=>{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||''])};
  const as=async(uid,sql,params=[],c=admin)=>{await begin(c,uid);try{const r=await c.query(sql,params);await c.query('commit');return r}catch(e){await c.query('rollback');throw e}};
  return{admin,conn,migrate,begin,as,stop:async()=>{try{await admin.end()}catch(e){}await srv.stop();fs.rmSync(dir,{recursive:true,force:true})}}}
