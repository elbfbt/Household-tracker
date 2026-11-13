// Offline parser check - no network, no database, no key. Shows what the importer WOULD understand.
//   node --no-warnings tools/bank-sms-parse.mjs "BanK-AIAhly" "<paste the SMS text>"
import {parseSms,describe,issuerOf} from '../supabase/functions/bank-sms-import/index.ts';
const [sender,text]=process.argv.slice(2);
if(!sender||!text){console.log('usage: node --no-warnings tools/bank-sms-parse.mjs "<sender>" "<sms text>"');process.exit(2)}
const issuer=issuerOf(sender);
if(!issuer){console.log(JSON.stringify({ok:false,status:'sender_not_supported',sender},null,2));process.exit(1)}
const p=parseSms(text,{issuer});
console.log(JSON.stringify(p.ok?{...p,...describe(p)}:{ok:false,status:'unrecognized_sms',reason:p.reason,rule:p.rule},null,2));
