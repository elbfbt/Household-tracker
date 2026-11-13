// Bank SMS import, end to end without Supabase, OneSignal or a phone:
//   the REAL parser + Edge Function code (supabase/functions/bank-sms-import/index.ts)
//   + REAL PostgreSQL with the repository's migrations (keys, fingerprints, wallets, balance rules, outbox trigger)
//   + the REAL notify-transactions function + a recording stand-in for the OneSignal REST API.
//                                                                     node --no-warnings tests/bank.test.mjs
import fs from 'node:fs';import path from 'node:path';
import {test,eq,ok,throws,done,startDb,MIGRATIONS,ROOT} from './harness.mjs';
import {handle,parseSms,parseAmount,findDate,cleanSms,foldSms,describe,fingerprint,RULES,VERIFIED_RULES,PROVISIONAL_RULES,SENDERS,normSender,issuerOf,cairoToUtc} from '../supabase/functions/bank-sms-import/index.ts';
import {handle as notifyHandle} from '../supabase/functions/notify-transactions/index.ts';

const FX=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/fixtures/bank-sms.json'),'utf8'));
const NOW=Date.parse(FX._now),M=Object.fromEntries(FX.messages.map(m=>[m.id,m]));
const P=(text,issuer='nbe',now=NOW)=>parseSms(text,{issuer,now,provisional:true});           // provisional rules: test-only
const RNOW=Date.parse(FX._real_now),R=Object.fromEntries(FX.real_messages.map(m=>[m.id,m]));
const PR=(text,issuer,now=RNOW)=>parseSms(text,{issuer,now});                                   // exactly what the deployed function does
const nor=(text,reason,issuer)=>{const p=PR(text,issuer);eq([p.ok,p.reason],[false,reason],JSON.stringify(text).slice(0,60)+':')};
const fx=id=>{const m=M[id],p=P(m.text,m.issuer);eq(p,{ok:true,...m.expect},id+':');return p};
const no=(text,reason,issuer='nbe')=>{const p=P(text,issuer);eq([p.ok,p.reason],[false,reason],JSON.stringify(text).slice(0,70)+':')};

console.log('\nBank SMS parser - PROVISIONAL rules (test-only wording, switched off in the deployed function)');
await test('bank card purchase (English + Arabic) → expense; the merchant is kept as written; the balance is never taken as the amount',()=>{
  const a=fx('card_en');eq([a.type,a.amount],['expense',1250.5]);
  eq(describe(a),{category:'CARREFOUR MAADI',note:'Bank SMS · Card · ref 123456789012'});});
await test('ATM withdrawal (English + Arabic, Arabic digits) → withdraw',()=>{const a=fx('atm_en'),b=fx('atm_ar');eq([a.type,b.type,b.amount],['withdraw','withdraw',2000]);eq(describe(a),{category:'Withdraw cash',note:'Bank SMS · ATM'})});
await test('deposit / credit → income; cash paid in at the ATM → deposit',()=>{fx('credit_en');fx('credit_ar');fx('cash_deposit_en');fx('cash_deposit_ar');
  eq(describe(P(M.credit_en.text)),{category:'Add income',note:'From ACME COMPANY · Bank SMS · Bank'});eq(describe(P(M.cash_deposit_en.text)).category,'Cash back to bank')});
await test('bank transfer sent → expense with the recipient; reference kept',()=>{const a=fx('transfer_en'),b=fx('transfer_ar');eq([a.provider,b.provider,b.party],['bank','bank','محمد علي']);
  eq(describe(a),{category:'MOHAMED ALI',note:'Transfer · Bank SMS · Bank · ref FT26317ABC'})});
await test('InstaPay sent / received (English + Arabic) → expense / income, provider "instapay"',()=>{for(const k of ['instapay_out_en','instapay_in_en'])eq(fx(k).provider,'instapay');
  eq(describe(P(M.instapay_in_en.text)),{category:'Add income',note:'From SARA HASSAN · Bank SMS · InstaPay · ref 555666777'})});
await test('Vodafone Cash received / sent (English + Arabic) → income / expense, provider "vodafone_cash"',()=>{for(const k of ['vfcash_in_en','vfcash_out_en'])eq(fx(k).provider,'vodafone_cash')});
await test('refund and reversal (English + Arabic) → income marked as refund / reversal',()=>{fx('refund_en');fx('refund_ar');fx('reversal_en');fx('reversal_ar');
  eq(describe(P(M.refund_en.text)),{category:'Add income',note:'Refund · AMAZON EG · Bank SMS · Card'});eq(describe(P(M.reversal_ar.text)).note,'Reversal · NOON · Bank SMS · Card')});
await test('every rule is exercised by a fixture, and only existing app transaction types are produced',()=>{
  const used=new Set([...FX.messages,...FX.real_messages].map(m=>m.expect.rule));eq(RULES.map(r=>r.id).filter(id=>!used.has(id)),[]);
  eq([...new Set(RULES.map(r=>r.type))].sort(),['deposit','expense','income','withdraw']);eq(new Set(RULES.map(r=>r.id)).size,RULES.length);
  for(const m of FX.messages)eq(P(m.text,null),{ok:true,...m.expect},m.id+' (no issuer filter: still exactly one kind)');
  for(const m of FX.messages)eq(parseSms(m.text,{issuer:m.issuer,now:NOW}).reason,'no_rule_matched',m.id+': a provisional message is NOT recognised by the deployed rule set')});
await test('unknown SMS → not recognised: advert, balance enquiry, plain text with an amount, limit change',()=>{
  no('Enjoy 20% cashback up to EGP 500 when you shop online with your card this weekend!','no_rule_matched');
  no('Your available balance is EGP 12,345.67 as of 12/11/2026','no_rule_matched');no('EGP 250.00 transaction transfer LE 250','no_rule_matched');
  no('عزيزي العميل تم تحديث بياناتكم بنجاح لدى البنك الأهلي المصري','no_rule_matched');no('Dear customer, your card limit is now EGP 50,000.00','no_rule_matched')});
await test('messages about money that are NOT a completed transaction → never imported (one-time code, declined, failed)',()=>{
  no('Your OTP is 482913 for purchase of EGP 1,250.50 at CARREFOUR using card ending 1234','one_time_code');
  no('رمز التحقق 482913 لعملية شراء بمبلغ 250.00 جنيه ببطاقتكم','one_time_code');
  no('Your card ending 1234 was declined for purchase of EGP 900.00 at NOON','declined_or_failed');no('تم رفض عملية شراء بمبلغ 900 جنيه ببطاقتكم رقم 1234','declined_or_failed');
  no('Transfer of EGP 500.00 from your account failed due to insufficient balance','declined_or_failed')});
await test('malformed SMS → not recognised: empty, too short, not text, absurdly long',()=>{
  for(const t of ['','   ','EGP 5','charged'])no(t,'malformed_message');for(const t of [null,undefined,12345,{},['x']])eq(P(t).reason,'malformed_message');no('Your card was charged EGP 10.00 at X '+'z'.repeat(1200),'malformed_message')});
await test('amounts: comma-separated, decimal, plain, EGP / LE / L.E. / جنيه / ج.م before or after, Arabic digits and separators',()=>{
  eq(['1,250.50','2000','0.50','12,345,678.9','1000000','7'].map(parseAmount),[1250.5,2000,0.5,12345678.9,1000000,7]);
  const card=m=>P(`Your card ending 1234 was charged ${m} at SHOP on 12/11/2026`).amount;
  eq(['EGP 1,250.50','EGP1250.5','1,250.50 EGP','LE 1250.50','L.E. 1,250.50','1250.50 L.E'].map(card),[1250.5,1250.5,1250.5,1250.5,1250.5,1250.5]);
  const ar=m=>PR(R.real_debit_card.text.replace('200 EGP',m),'nbe').amount;
  eq(['250.75 جنيه','٢٥٠٫٧٥ جنيه','١٬٢٥٠٫٥٠ جنيها','1250.5 ج.م','3,000 جم','99EGP','7 L.E'].map(ar),[250.75,250.75,1250.5,1250.5,3000,99,7])});
await test('malformed / ambiguous amount → not recognised (never "repaired"); foreign currency → not recognised (never converted)',()=>{
  eq(['1,50','1.500','12,34,567','1,2345','1..5','.5','5.','abc','','0','-5','1 250','1e3'].map(parseAmount),Array(13).fill(null));
  for(const m of ['EGP 1,25.0','EGP 12,34,567','EGP 1.500','EGP 1,250.505'])no(`Your card ending 1234 was charged ${m} at SHOP on 12/11/2026`,'amount_malformed');
  no('Your card ending 1234 was charged at SHOP on 12/11/2026. Available balance EGP 900.00','amount_not_found');
  no('Your card ending 1234 was charged USD 20.00 at AMAZON US on 12/11/2026. Available balance EGP 900.00','unsupported_currency');
  nor(R.real_debit_card.text.replace('200 EGP','20.00 USD'),'structure_mismatch','nbe');nor(R.real_instapay_out.text.replace('1.00 جم','1.00 دولار'),'structure_mismatch','nbe')});
await test('date/time: day/month order, Cairo time incl. summer time, am/pm, 2-digit year, month names, ISO; date only → noon; no date → receipt time',()=>{
  const at=(tail,now=NOW)=>{const p=P(`Your card ending 1234 was charged EGP 10.00 at SHOP ${tail}`,'nbe',now);return p.ok?[p.at,p.date_source]:p.reason};
  eq(at('on 12/11/2026 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 05/11/2026 at 09:05:30'),['2026-11-05T07:05:30.000Z','sms']);
  eq(at('on 12-11-26 02:35 PM'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12/11/2026 12:10 am'),['2026-11-11T22:10:00.000Z','sms']);
  eq(at('on 2026-11-12 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12 Nov 2026 14:35'),['2026-11-12T12:35:00.000Z','sms']);eq(at('on 12-NOV-26'),['2026-11-12T10:00:00.000Z','sms_date_only']);
  eq(at('on 10/11/2026'),['2026-11-10T10:00:00.000Z','sms_date_only']);eq(at('on 12/11 at 14:35'),['2026-11-12T12:35:00.000Z','sms'],'year missing → the year of receipt');
  eq(at('on 31/12 at 23:50',Date.parse('2027-01-01T06:00:00Z')),['2026-12-31T21:50:00.000Z','sms'],'31/12 read on 1 January → last year');
  eq(at('on 15/07/2026 14:35',Date.parse('2026-07-15T16:00:00Z')),['2026-07-15T11:35:00.000Z','sms'],'summer time: Cairo is UTC+3');
  eq(at('today'),[new Date(NOW).toISOString(),'received']);eq(at('at 14:35'),[new Date(NOW).toISOString(),'received'],'a time without a date is not a timestamp');
  eq(new Date(cairoToUtc(2026,1,15,8,0,0)).toISOString(),'2026-01-15T06:00:00.000Z')});
await test('malformed date → not recognised: impossible day/month/time, two different dates, far future, too old',()=>{
  const r=tail=>P(`Your card ending 1234 was charged EGP 10.00 at SHOP ${tail}`).reason;
  eq(['on 32/11/2026','on 12/13/2026','on 31/02/2026','on 00/11/2026','on 12/11/2026 25:10','on 12/11/2026 10:75','on 12/11/2026 13:10 pm'].map(r),Array(7).fill('date_malformed'));
  eq(r('on 12/11/2026, posted 13/11/2026'),'date_ambiguous');eq(r('on 12/11/2027'),'date_in_future');eq(r('on 12/11/2019'),'date_too_old');eq(r('on 01/06/2026'),'date_too_old')});
await test('Arabic text is matched regardless of hamza / diacritics / tatweel / invisible marks; names come back exactly as written',()=>{
  const t=R.real_instapay_in.text,base=PR(t,'nbe');
  const p=PR(t.replace('تم إضافة','تمّ إضـافة').replace('من عبير','من \u200fعبير').replace('قداح رقم','قداح\u200f رقم'),'nbe');eq(p,base,'diacritics, tatweel, direction marks');eq(p.party,'عبير على زين العابدين القصبى قداح','the name keeps its own spelling');
  eq(PR(t.replace('إضافة','اضافة'),'nbe'),base,'hamza or not');eq(PR(R.real_instapay_out.text.replace('إلى','الى'),'nbe').amount,1);
  eq(foldSms('إلى الآلي ABC').length,'إلى الآلي ABC'.length);eq(cleanSms('  a \n\t b  '),'a b')});
await test('providers are not confused: InstaPay ≠ Vodafone Cash ≠ plain bank transfer; a currency or a keyword alone decides nothing',()=>{
  for(const k of ['instapay_out_en','instapay_in_en'])eq(P(M[k].text,'vodafone_cash').reason,'no_rule_matched',k+' with a Vodafone Cash key');
  for(const k of ['vfcash_in_en','vfcash_out_en'])eq(P(M[k].text,'nbe').reason,'no_rule_matched',k+' with a bank key');
  eq([P(M.transfer_en.text).provider,P(M.transfer_ar.text).provider],['bank','bank'],'a transfer without InstaPay wording is never "instapay"');
  eq(P(M.transfer_en.text.replace('A transfer','An InstaPay transfer')).provider,'instapay');
  eq(P('InstaPay: you received EGP 300.00 in your Vodafone Cash wallet from SARA','nbe').ok,false,'InstaPay + Vodafone Cash wording together → nobody claims it');
  eq(P('InstaPay: you received EGP 300.00 in your Vodafone Cash wallet from SARA','vodafone_cash').ok,false);
  eq(P('InstaPay EGP 750.00').reason,'no_rule_matched');eq(P('Vodafone Cash 150 جنيه','vodafone_cash').reason,'no_rule_matched');
  eq(P('SomeBank: purchase EGP 10.00 card','unknown_issuer').reason,'no_rule_matched')});
await test('similar wording, different meaning → the right kind or nothing: ATM vs purchase, refund vs purchase, sent vs received, mixed messages',()=>{
  eq(P('Your card ending 1234 was charged EGP 2,000.00 for ATM withdrawal on 12/11/2026').reason,'amount_not_found','card + charged + ATM: never a purchase, and not a withdrawal without withdrawal wording for the amount');
  eq(P('Purchase of EGP 120.00 at NOON on card ending 1234 was refunded on 10/11/2026').reason,'amount_not_found','a refund is never booked as a purchase');
  eq(P('Refund of EGP 120.00 for reversed transaction at NOON').reason,'no_rule_matched','refund + reversal wording together');
  eq(P('InstaPay: EGP 100.00 was sent and EGP 50.00 received on your account').reason,'no_rule_matched');
  const mixed=P('Your card ending 1234 was charged EGP 100.00 at SHOP. تم سحب نقدي بمبلغ 100 جنيه من ماكينة الصراف');eq([mixed.reason,mixed.rules],['ambiguous_message',['nbe.card_purchase.en','nbe.atm_withdrawal.ar']]);
  const both=P('Your card ending 1234 was charged EGP 100.00 at SHOP. '+R.real_debit_card.text);eq([both.ok,both.reason],[false,'ambiguous_message'],'a provisional and a verified rule both claim it → nobody gets it')});
await test('sender names: known families only; l / I look-alikes are the same sender; fingerprint ignores spacing and digit style',async()=>{
  eq(['BanK-AIAhly','BanK-AlAhly','bank-aiahly','BANK ALAHLY','NBE','VF-Cash','CIB','','AlAhly'].map(issuerOf),['nbe','nbe','nbe','nbe','nbe','vodafone_cash',null,null,null]);
  ok(SENDERS.nbe.includes('BanK-AIAhly'));eq(normSender('BanK-AIAhly'),normSender('BanK-AlAhly'));
  const t=R.real_debit_card.text,p=PR(t,'nbe'),f=await fingerprint(p,t);eq(f,await fingerprint(p,'  '+t.replace(/ /g,'  ').replace('200 EGP','٢٠٠ EGP').replace('2521','٢٥٢١')+'\n'));ok(/^[0-9a-f]{64}$/.test(f.fingerprint)&&/^[0-9a-f]{64}$/.test(f.sms_hash));
  const a=P(M.card_en.text),fa=await fingerprint(a,M.card_en.text);eq(fa.fingerprint,(await fingerprint(a,'completely different wording')).fingerprint,'with a bank reference the reference decides');
  ok(fa.fingerprint!==(await fingerprint({...a,reference:'999'},M.card_en.text)).fingerprint);ok(fa.fingerprint!==(await fingerprint({...a,amount:1},M.card_en.text)).fingerprint)});

console.log('\nBank SMS parser - VERIFIED rules (real production messages)');
const rx=id=>{const m=R[id],p=PR(m.text,m.issuer);eq(p,{ok:true,...m.expect},id+':');eq(describe(p),m.describe,id+' description:');return p};
await test('REAL InstaPay outgoing → expense 1.00, provider instapay, masked recipient kept, reference 456611434599, "11-12 17:24" = 12 Nov 17:24 Cairo, جم = EGP',()=>{
  const p=rx('real_instapay_out');eq([p.type,p.amount,p.provider,p.reference,p.at],['expense',1,'instapay','456611434599','2026-11-12T15:24:00.000Z'])});
await test('REAL InstaPay incoming → income 205.00, provider instapay, sender name (with "على" inside) kept whole, reference 467579444840',()=>{
  const p=rx('real_instapay_in');eq([p.type,p.amount,p.party,p.reference],['income',205,'عبير على زين العابدين القصبى قداح','467579444840'])});
await test('REAL debit card purchase → expense 200 (not the available 11.31), merchant "Mansoura Market 2 D" (spaces normalised), date 12/11/26 21:43, Arabic-Indic hotline digits harmless',()=>{
  const p=rx('real_debit_card');eq([p.type,p.amount,p.provider,p.party,p.at,p.reference],['expense',200,'debit_card','Mansoura Market 2 D','2026-11-12T19:43:00.000Z',''])});
await test('REAL Vodafone Cash incoming → income 1.00 (not the balance 6.93, not a phone number), name kept, phone NOT kept, reference 025712695852, "17:21 26-11-12" parsed',()=>{
  const p=rx('real_vfcash_in');eq([p.type,p.amount,p.provider,p.reference,p.at],['income',1,'vodafone_cash','025712695852','2026-11-12T15:21:00.000Z']);
  ok(!JSON.stringify([p,describe(p)]).includes('01095872700'),'the phone number is not part of the result')});
await test('REAL Vodafone Cash mobile recharge → expense 30 (the amount after "وخصم"; not the balance 4.93, not the advert\'s 100ج), described as Vodafone Cash mobile recharge, receipt time',()=>{
  const p=rx('real_vfcash_recharge');eq([p.type,p.amount,p.kind,p.date_source,describe(p).category],['expense',30,'mobile_recharge','received','Vodafone Cash mobile recharge']);
  eq(PR(R.real_vfcash_recharge.text.replace('وخصم 30','وخصم 31.5'),'vodafone_cash').amount,31.5,'the amount is what left the wallet')});
await test('the five real messages give the same result with or without issuer filter and with the provisional rules on; each is claimed by exactly one rule',()=>{
  for(const m of FX.real_messages)for(const o of [{},{provisional:true},{issuer:m.issuer,provisional:true}])eq(parseSms(m.text,{now:RNOW,...o}),{ok:true,...m.expect},m.id+JSON.stringify(o));
  eq(VERIFIED_RULES.map(r=>r.id),['nbe.instapay_out.ar','nbe.instapay_in.ar','nbe.debit_card_purchase.ar','vfc.received.ar','vfc.mobile_recharge.ar','vfc.sent.ar']);ok(VERIFIED_RULES.every(r=>r.shape&&!r.provisional)&&PROVISIONAL_RULES.every(r=>r.provisional&&!r.shape));
  for(const m of FX.real_messages)eq(PR(m.text,m.issuer==='nbe'?'vodafone_cash':'nbe').reason,'no_rule_matched',m.id+' with the other provider\'s key')});
await test('NEGATIVE balance: the available / current balance is never the amount - if the transaction amount is missing nothing is recognised',()=>{
  const c=R.real_debit_card.text,v=R.real_vfcash_in.text,g=R.real_vfcash_recharge.text;
  eq([PR(c,'nbe').amount,PR(v,'vodafone_cash').amount,PR(g,'vodafone_cash').amount],[200,1,30]);
  nor(c.replace('تم خصم 200 EGP','تم خصم'),'structure_mismatch','nbe');nor(c.replace('200 EGP ',''),'structure_mismatch','nbe');
  nor(v.replace('مبلغ 1.00 جنيه','مبلغ'),'structure_mismatch','vodafone_cash');nor(g.replace('وخصم 30 من محفظتك','من محفظتك'),'structure_mismatch','vodafone_cash');
  eq(PR(c.replace('المتاح11.31EGP','المتاح99,999.99EGP'),'nbe').amount,200);eq(PR(v.replace('6.93','5000'),'vodafone_cash').amount,1);eq(PR(g.replace('4.93','900'),'vodafone_cash').amount,30);
  nor('رصيد حسابك في فودافون كاش الحالي 4.93 جنيه','no_rule_matched','vodafone_cash');nor('المتاح11.31EGP للمزيد اتصل ب ١٩٦٢٣ البنك الاهلي','no_rule_matched','nbe')});
await test('NEGATIVE phone numbers: a wallet / phone number is never the amount and never the description',()=>{
  const v=R.real_vfcash_in.text;nor(v.replace('مبلغ 1.00 جنيه من','مبلغ من'),'structure_mismatch','vodafone_cash');nor(v.replace('1.00 جنيه','01095872700'),'structure_mismatch','vodafone_cash');
  const noName=PR(v.replace('\nالمسجل بإسم محمد اسامه احمد علي حسنين',''),'vodafone_cash');eq([noName.ok,noName.amount,noName.party,describe(noName)],[true,1,'',{category:'Add income',note:'Bank SMS · Vodafone Cash · ref 025712695852'}],'no registered name → no description from the phone number');
  nor('للمزيد اتصل بـ 19623 او 01095872700 فودافون كاش محفظتك','no_rule_matched','vodafone_cash')});
await test('NEGATIVE reference numbers / account / card / hotline numbers: never the amount',()=>{
  const o=R.real_instapay_out.text,i=R.real_instapay_in.text;
  nor(o.replace('بمبلغ 1.00 جم ',''),'structure_mismatch','nbe');nor(i.replace('بمبلغ 205.00 جم ',''),'structure_mismatch','nbe');nor(o.replace('1.00 جم','جم'),'structure_mismatch','nbe');
  eq([PR(o,'nbe').amount,PR(i,'nbe').amount],[1,205]);eq(PR(o.replace('0170','999999'),'nbe').amount,1);eq(PR(R.real_debit_card.text.replace('رقم2521','رقم9999'),'nbe').amount,200);
  nor(o.replace('رقم مرجعي 456611434599 ',''),'structure_mismatch','nbe');nor(R.real_vfcash_in.text.replace('رقم العملية: 025712695852','رقم العملية:'),'structure_mismatch','vodafone_cash')});
await test('NEGATIVE promotional amounts: an advert is never a transaction, and the advert inside a real message is never its amount',()=>{
  const g=R.real_vfcash_recharge.text;eq(PR(g.replace('100ج','5000ج'),'vodafone_cash').amount,30);
  nor('حول فلوس لأي محفظة وزود فرصك تكسب جنيه دهب! وكمان هيجيلك لحد 100ج كاش باك. http://vf.eg/vfcash?id=money_transfer','no_rule_matched','vodafone_cash');
  nor('اشحن رصيدك من فودافون كاش ب 30 جنيه واكسب 100ج كاش باك من محفظتك','no_rule_matched','vodafone_cash');
  nor('تم شحن رصيد موبايلك ب 30 بنجاح. هيجيلك لحد 100ج كاش باك من محفظتك في فودافون كاش','structure_mismatch','vodafone_cash');
  nor('استخدم بطاقة الخصم المباشر عند Mansoura Market واحصل على خصم 200 EGP','no_rule_matched','nbe')});
await test('NEGATIVE unrelated / ambiguous / altered messages → unrecognised: two messages glued together, changed wording, other card type, declined, one-time code',()=>{
  const o=R.real_instapay_out.text,i=R.real_instapay_in.text,c=R.real_debit_card.text;
  nor(o+' '+i,'no_rule_matched','nbe');nor(c+' '+o,'no_rule_matched','nbe');nor(R.real_vfcash_in.text+' '+R.real_vfcash_recharge.text,'no_rule_matched','vodafone_cash');
  nor(c.replace('بطاقة الخصم المباشر','بطاقة الائتمان'),'no_rule_matched','nbe');nor(c.replace('تم خصم','تم رفض خصم'),'declined_or_failed','nbe');nor(o.replace('تم تنفيذ','لم يتم تنفيذ'),'declined_or_failed','nbe');
  nor(o.replace('إلى','الى حساب خارجي لصالح').replace('رقم مرجعي','مرجع'),'structure_mismatch','nbe');nor(i.replace('بمبلغ','قيمته'),'structure_mismatch','nbe');
  nor('رمز التحقق 123456 لتنفيذ تحويل لحظي من حسابكم بمبلغ 1.00 جم','one_time_code','nbe');
  nor('عزيزي العميل تحويل لحظي متاح الان من حسابكم عبر تطبيق انستاباي بحد اقصى 70000 جم','no_rule_matched','nbe');
  nor('EGP 200 جم جنيه تحويل transaction','no_rule_matched','nbe');nor('تم خصم 200 EGP','malformed_message','nbe');nor('تم خصم 200 EGP من الحساب بنجاح','no_rule_matched','nbe')});
await test('real formats: amounts with separators / decimals, Arabic-Indic digits everywhere, malformed amount or date → unrecognised; year roll-over of "MM-DD"',()=>{
  const o=R.real_instapay_out.text,c=R.real_debit_card.text,v=R.real_vfcash_in.text;
  eq(['1,250.00','12500.5','0.75','1,000,000'].map(a=>PR(o.replace('1.00 جم',a+' جم'),'nbe').amount),[1250,12500.5,0.75,1000000]);eq(PR(o.replace('1.00 جم','1.00 جنيه'),'nbe').amount,1);eq(PR(c.replace('200 EGP','1,200.50 EGP'),'nbe').amount,1200.5);
  for(const a of ['1,25','1.500','12,34,567','1..5'])nor(o.replace('1.00 جم',a+' جم'),'amount_malformed','nbe');
  const ar=t=>t.replace(/\d/g,d=>'٠١٢٣٤٥٦٧٨٩'[d]);eq(PR(ar(o),'nbe'),PR(o,'nbe'));eq(PR(ar(c).replace('Mansoura Market ٢','Mansoura Market 2'),'nbe'),PR(c,'nbe'));eq(PR(ar(v).replace(/http\S+/,''),'vodafone_cash'),PR(v,'vodafone_cash'));
  nor(o.replace('يوم 11-12','يوم 13-12'),'date_malformed','nbe');nor(o.replace('يوم 11-12','يوم 02-30'),'date_malformed','nbe');nor(o.replace('17:24','25:24'),'date_malformed','nbe');
  nor(c.replace('12/11/26','32/11/26'),'date_malformed','nbe');nor(c.replace('12/11/26','12/11/27'),'date_in_future','nbe');nor(v.replace('26-11-12','26-13-12'),'date_malformed','vodafone_cash');nor(v.replace('26-11-12','25-11-12'),'date_too_old','vodafone_cash');
  eq(PR(o.replace('يوم 11-12 الساعة 17:24','يوم 12-31 الساعة 23:50'),'nbe',Date.parse('2027-01-01T06:00:00Z')).at,'2026-12-31T21:50:00.000Z','31 December read on 1 January');
  eq(PR(o.replace('يوم 11-12','يوم 11-05'),'nbe').at,'2026-11-05T15:24:00.000Z','MONTH-DAY, not day-month')});

console.log('\nBank SMS parser - VERIFIED rules, second batch of real production messages');
const R2=FX.real_messages.filter(m=>m.id.startsWith('real2_'));
await test('all ten new real messages parse exactly as specified (type, amount, provider, name, reference, time, description)',()=>{eq(R2.length,10);for(const m of R2)rx(m.id);
  eq(R2.map(m=>[m.expect.type,m.expect.amount]),[['expense',105],['income',8.8],['expense',5],['expense',30],['income',9],['expense',1],['expense',182],['expense',20],['expense',200],['expense',800]])});
await test('REAL Vodafone Cash outgoing transfer → expense 105, reference 024986273684, 22 Oct 16:54, described "Vodafone Cash transfer"; the recipient phone number is not kept',()=>{
  const p=rx('real2_vfcash_out');eq([p.type,p.amount,p.provider,p.kind,p.party,p.reference,p.at],['expense',105,'vodafone_cash','transfer_out','','024986273684','2026-10-22T13:54:00.000Z']);
  eq(describe(p),{category:'Vodafone Cash transfer',note:'Transfer · Bank SMS · Vodafone Cash · ref 024986273684'});ok(!JSON.stringify([p,describe(p)]).includes('01064773881'))});
await test('Vodafone Cash outgoing transfer is not confused with mobile recharge (and the reverse); a mixture of both is refused',()=>{
  const o=R.real2_vfcash_out.text,g=R.real2_vfcash_recharge_30.text;eq([PR(o,'vodafone_cash').rule,PR(o,'vodafone_cash').kind],['vfc.sent.ar','transfer_out']);eq([PR(g,'vodafone_cash').rule,PR(g,'vodafone_cash').kind],['vfc.mobile_recharge.ar','mobile_recharge']);
  eq(describe(PR(o,'vodafone_cash')).category,'Vodafone Cash transfer');eq(describe(PR(g,'vodafone_cash')).category,'Vodafone Cash mobile recharge');
  nor(o+' '+g,'no_rule_matched','vodafone_cash');nor(g+' '+o,'no_rule_matched','vodafone_cash');nor(o.replace('تم تحويل 105 جنيه لرقم 01064773881','تم شحن رصيد موبايلك ب 105 بنجاح'),'no_rule_matched','vodafone_cash');
  nor(o+' '+R.real2_vfcash_in_en_name.text,'no_rule_matched','vodafone_cash');nor(R.real2_vfcash_in_en_name.text+' '+o,'no_rule_matched','vodafone_cash')});
await test('"مصاريف الخدمة 0 جنيه" is never the amount and never a transaction; a fee other than 0 has not been verified → refused, nothing guessed',()=>{
  const o=R.real2_vfcash_out.text;eq(PR(o,'vodafone_cash').amount,105);
  nor(o.replace('تم تحويل 105 جنيه لرقم','تم تحويل لرقم'),'structure_mismatch','vodafone_cash');nor(o.replace('105 جنيه ',''),'structure_mismatch','vodafone_cash');
  nor('مصاريف الخدمة 0 جنيه رصيد حسابك فى فودافون كاش الحالي 3.93. رقم العملية 024986273684','no_rule_matched','vodafone_cash');
  nor(o.replace('مصاريف الخدمة 0 جنيه','مصاريف الخدمة 1 جنيه'),'fee_not_verified','vodafone_cash');nor(o.replace('مصاريف الخدمة 0 جنيه','مصاريف الخدمة 0.50 جنيه'),'fee_not_verified','vodafone_cash');
  eq(PR(o.replace('مصاريف الخدمة 0 جنيه','مصاريف الخدمة 0.00 جنيه'),'vodafone_cash').amount,105);nor(o.replace('مصاريف الخدمة 0 جنيه ',''),'no_rule_matched','vodafone_cash')});
await test('phone numbers are never the description and never the amount (outgoing: recipient number; incoming: sender + own wallet number)',()=>{
  for(const id of ['real2_vfcash_out','real2_vfcash_in_en_name','real_vfcash_in']){const p=PR(R[id].text,'vodafone_cash'),all=JSON.stringify([p,describe(p)]);ok(!/01\d{9}/.test(all),id+': no phone number anywhere in the result');ok(p.amount<1000)}
  const o=R.real2_vfcash_out.text;nor(o.replace('105 جنيه لرقم 01064773881','01064773881 جنيه لرقم 105'),'structure_mismatch','vodafone_cash');nor(o.replace('لرقم 01064773881','لرقم 12345'),'structure_mismatch','vodafone_cash');
  eq(PR(o.replace('01064773881','01000000009'),'vodafone_cash').amount,105)});
await test('the Vodafone Cash current balance (3.93 / 8.93 / 0.13 / 8.13) is never the amount, whatever its value',()=>{
  eq(['real2_vfcash_out','real2_vfcash_in_en_name','real2_vfcash_recharge_5','real2_vfcash_recharge_30'].map(id=>PR(R[id].text,'vodafone_cash').amount),[105,8.8,5,30]);
  eq(PR(R.real2_vfcash_out.text.replace('3.93','7,500.25'),'vodafone_cash').amount,105);eq(PR(R.real2_vfcash_out.text.replace('3.93','0'),'vodafone_cash').amount,105);eq(PR(R.real2_vfcash_recharge_5.text.replace('0.13','999'),'vodafone_cash').amount,5);eq(PR(R.real2_vfcash_in_en_name.text.replace('8.93','4000'),'vodafone_cash').amount,8.8);
  nor(R.real2_vfcash_recharge_5.text.replace('وخصم 5 من محفظتك','من محفظتك'),'structure_mismatch','vodafone_cash');nor(R.real2_vfcash_in_en_name.text.replace('مبلغ 8.80 جنيه','مبلغ'),'structure_mismatch','vodafone_cash')});
await test('the advert\'s "100ج" is never the amount (transfer and both recharges), also when the advert changes or disappears',()=>{
  for(const id of ['real2_vfcash_out','real2_vfcash_recharge_5','real2_vfcash_recharge_30']){const m=R[id],a=m.expect.amount;eq(PR(m.text.replace('100ج','9000ج'),'vodafone_cash').amount,a,id);eq(PR(m.text.replace(/ ?حول فلوس[^]*$/,''),'vodafone_cash').amount,a,id+' without advert');ok(a!==100)}
  nor('حول فلوس لأي محفظة وزود فرصك تكسب جنيه دهب! وكمان هيجيلك لحد 100ج كاش باك. رقم العملية 024986273684 فودافون كاش','no_rule_matched','vodafone_cash')});
await test('card ending (2521), available balance (23.35 / 3.35 / 8.35 / 11.31) and hotline (١٩٦٢٣) are never the amount; "الساعه" = "الساعة"; spacing variants',()=>{
  const ids=['real2_card_wekalet_182','real2_card_wekalet_20','real2_card_market_200','real2_card_zainy_800'];eq(ids.map(id=>PR(R[id].text,'nbe').amount),[182,20,200,800]);
  for(const id of ids){const t=R[id].text,a=R[id].expect.amount;nor(t.replace(/تم خصم \d+ EGP/,'تم خصم'),'structure_mismatch','nbe');eq(PR(t.replace('2521','9876'),'nbe').amount,a);eq(PR(t.replace(/المتاح ?[\d.]+EGP/,'المتاح 54,321.00 EGP'),'nbe').amount,a);
    eq(PR(t.replace('١٩٦٢٣','٩٩٩٩٩'),'nbe'),PR(t,'nbe'));eq(PR(t.replace(/ للمزيد[^]*$/,''),'nbe'),PR(t,'nbe'));nor(t.replace(/رقم ?2521/,'رقم 25219'),'structure_mismatch','nbe');nor(t.replace(/ المتاح ?[\d.]+EGP/,''),'structure_mismatch','nbe')}
  const w=R.real2_card_wekalet_182.text;eq(PR(w.replace('الساعه','الساعة'),'nbe'),PR(w,'nbe'));eq(PR(w.replace(/  /g,' '),'nbe'),PR(w,'nbe'));eq(PR(w.replace('رقم 2521  عند WEKALET','رقم2521 عندWEKALET').replace('يوم 09','يوم09').replace('الساعه 15','الساعه15').replace('المتاح 23','المتاح23'),'nbe'),PR(w,'nbe'));
  nor('للمزيد اتصل ب ١٩٦٢٣','no_rule_matched','nbe');nor('بطاقة الخصم المباشر رقم 2521 المتاح 23.35EGP للمزيد إتصل ب ١٩٦٢٣','no_rule_matched','nbe')});
await test('English sender / recipient names work and keep their spelling (InstaPay in, InstaPay out masked, Vodafone Cash in); Arabic names unchanged',()=>{
  eq(['real2_instapay_in_en_name','real2_instapay_out_masked_en','real2_vfcash_in_en_name','real_instapay_in','real_vfcash_in'].map(id=>PR(R[id].text,R[id].issuer).party),['MOHAMED ELGHANDOUR','RAHMA K***** E*****','MOHAMED ELGHANDOUR','عبير على زين العابدين القصبى قداح','محمد اسامه احمد علي حسنين']);
  eq(PR(R.real2_instapay_in_en_name.text.replace('MOHAMED ELGHANDOUR','Sara El-Sayed'),'nbe').party,'Sara El-Sayed');eq(PR(R.real2_vfcash_in_en_name.text.replace('MOHAMED ELGHANDOUR','Mona Ali 2'),'vodafone_cash').party,'Mona Ali 2')});
await test('materially altered / ambiguous versions of the new messages → unrecognised',()=>{
  const o=R.real2_vfcash_out.text,c=R.real2_card_wekalet_182.text,i=R.real2_instapay_in_en_name.text;
  nor(o.replace('تم تحويل','لم يتم تحويل'),'declined_or_failed','vodafone_cash');nor(o.replace('تم تحويل','سيتم تحويل'),'structure_mismatch','vodafone_cash');nor(o.replace('تم تحويل','طلب تحويل'),'no_rule_matched','vodafone_cash');nor(o.replace('رقم العملية 024986273684 :','رقم العملية :'),'structure_mismatch','vodafone_cash');
  nor(o.replace('26-10-22','26-13-22'),'date_malformed','vodafone_cash');nor(o.replace('26-10-22','25-10-22'),'date_too_old','vodafone_cash');nor(o.replace('105 جنيه','105 دولار'),'structure_mismatch','vodafone_cash');nor(o.replace('105 جنيه','1,05 جنيه'),'amount_malformed','vodafone_cash');
  nor(o.replace('لرقم 01064773881','لرقم 01064773881 ولرقم 01000000001'),'structure_mismatch','vodafone_cash');nor(o,'no_rule_matched','nbe');
  nor(c+' '+R.real2_card_wekalet_20.text.replace('تم خصم','وتم تحويل'),'no_rule_matched','nbe');nor(c.replace('عند WEKALET ELMANSOURA','')+'','no_rule_matched','nbe');nor(c.replace('يوم 09/11/26  الساعه 15:23',''),'structure_mismatch','nbe');
  nor(c.replace('تم خصم','تم استرداد'),'no_rule_matched','nbe');nor(i.replace('رقم مرجعي 490012399928','بدون مرجع'),'structure_mismatch','nbe');nor(i+' '+R.real2_instapay_out_masked_en.text,'no_rule_matched','nbe')});

/* ================================================= with the database ================================================= */
console.log('\nBank SMS import (real PostgreSQL + real Edge Functions)');
const db=await startDb();const {admin,as}=db;
const one=async(uid,sql,p)=>(await as(uid,sql,p)).rows[0];
const user=async name=>(await admin.query('insert into auth.users(email,raw_user_meta_data) values($1,$2) returning id',[name+'@t.io',{name}])).rows[0].id;
const sub=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const PROD={SUPABASE_URL:'https://proj.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service-secret',ONESIGNAL_REST_API_KEY:'os_v2_app_testkey'};   // the deployed configuration
const ENV={...PROD,BANK_SMS_PROVISIONAL_RULES:'on'};                                             // test-only: also the provisional rules
const J=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const sent=[],world={notifyDown:false,loseReply:false,authCalls:0,notifyCalls:[]};
const ARGS={bank_import_auth:a=>['select bank_import_auth($1) v',[a.kh]],bank_import_commit:a=>['select bank_import_commit($1,$2,$3) v',[a.kh,JSON.stringify(a.p),!!a.dry]],
  push_claim:a=>['select push_claim($1) v',[a.caller]],push_done:a=>['select push_done($1,$2,$3,$4,$5,$6) v',[a.nid,a.st,a.n,a.err,a.bad,a.langs]]};
async function fakeFetch(url,init={}){
  const h=init.headers||{};
  if(url.includes('/rest/v1/rpc/')){if(h.apikey!=='service-secret'||h.Authorization!=='Bearer service-secret')return J(401,{message:'bad key'});
    const fn=url.split('/rpc/')[1],[sql,params]=ARGS[fn](JSON.parse(init.body));const c=await db.conn();           // own connection per call: requests really run concurrently
    try{await c.query('begin');await c.query('set local role service_role');const r=(await c.query(sql,params)).rows[0].v;await c.query('commit');
      if(fn==='bank_import_commit'&&world.loseReply){world.loseReply=false;throw new Error('connection reset')}
      return new Response(r===null||r===''?'':JSON.stringify(r),{status:200})}
    catch(e){await c.query('rollback').catch(()=>{});if(e.message==='connection reset')throw e;return J(400,{message:e.message})}finally{await c.end()}}
  if(url.endsWith('/functions/v1/notify-transactions')){world.notifyCalls.push(JSON.parse(init.body));if(world.notifyDown)throw new Error('function unreachable');
    return notifyHandle(new Request(url,{method:'POST',headers:h,body:init.body}),PROD,fakeFetch)}
  if(url.endsWith('/auth/v1/user')){world.authCalls++;const m=/^Bearer user:(.+)$/.exec(String(h.Authorization||''));return m?J(200,{id:m[1]}):J(401,{msg:'invalid JWT'})}
  if(url==='https://api.onesignal.com/notifications'){sent.push(JSON.parse(init.body));return J(200,{id:'n1'})}
  throw new Error('unexpected request '+url)}
const logs=[];const _log=console.log,_err=console.error;const quiet=async fn=>{console.log=(...a)=>logs.push(a.join(' '));console.error=(...a)=>logs.push(a.join(' '));try{return await fn()}finally{console.log=_log;console.error=_err}};
// dates in the sample messages → yesterday (Cairo), so the suite does not depend on the day it runs
const YD=(()=>{const d=new Date(Date.now()-86400e3);const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',day:'2-digit',month:'2-digit',year:'numeric'}).formatToParts(d).map(x=>[x.type,x.value]));return{txt:`${p.day}/${p.month}/${p.year}`,y:+p.year,m:+p.month,d:+p.day}})();
const sms=id=>M[id].text.replace(/\d\d\/11\/2026/g,YD.txt);
const post=(key,body,headers)=>quiet(async()=>{const r=await handle(new Request('https://proj.supabase.co/functions/v1/bank-sms-import',{method:'POST',headers:headers||(key?{Authorization:'Bearer '+key}:{}),body:typeof body==='string'?body:JSON.stringify(body)}),ENV,fakeFetch);return{http:r.status,...(await r.json())}});
const imp=(key,id,extra={})=>post(key,{sender:'BanK-AIAhly',text:typeof id==='string'&&M[id]?sms(id):id,...extra});
const txs=async h=>(await admin.query('select t.id,t.type,t.amount::float8 amount,t.category,t.note,t.user_id,t.household_id,t.created_at,w.name wallet,w2.name to_wallet from transactions t join wallets w on w.id=t.wallet_id left join wallets w2 on w2.id=t.to_wallet_id where t.household_id=$1 order by t.updated_at',[h])).rows;
const count=async h=>+(await admin.query('select count(*) n from transactions where household_id=$1',[h])).rows[0].n;
const bal=async(u,h)=>Object.fromEntries((await one(u,'select wallet_balances($1) b',[h])).b.map(w=>[w.name,+w.balance]));
const imports=async h=>(await admin.query('select * from bank_imports where household_id=$1 order by created_at',[h])).rows;
const outbox=async tx=>(await admin.query('select status,recipients,error,attempts from notification_outbox where transaction_id=$1',[tx])).rows[0];
const newKey=async(u,sender='BanK-AIAhly',...rest)=>(await one(u,'select bank_import_create_key($1,$2,$3,$4) k',[sender,rest[0]||null,rest[1]||null,rest[2]||365])).k;

let A,B,WA={},WB={},Ahmed,Mona,Bob,Dad,kA,kMona,kB;
const INS='insert into transactions(household_id,user_id,wallet_id,to_wallet_id,type,amount,category,note) values($1,$2,$3,$4,$5,$6,$7,$8) returning id';
try{
  await db.migrate([...MIGRATIONS]);
  Ahmed=await user('Ahmed');Mona=await user('Mona');Bob=await user('Bob');Dad=await user('Dad');
  A=(await one(Ahmed,"select create_household('Home A') h")).h;B=(await one(Bob,"select create_household('Home B') h")).h;
  const code=async(u,h)=>(await one(u,'select invite_code c from households where id=$1',[h])).c;
  await as(Mona,'select join_household($1)',[await code(Ahmed,A)]);await as(Dad,'select join_household($1)',[await code(Ahmed,A)]);
  for(const w of (await admin.query('select id,name,household_id from wallets')).rows)(w.household_id===A?WA:WB)[w.name]=w.id;
  await as(Ahmed,'select register_push_device($1,$2)',[sub(1),'en']);await as(Mona,'select register_push_device($1,$2)',[sub(3),'ar']);await as(Bob,'select register_push_device($1,$2)',[sub(11),'en']);
  await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',20000,'Add income','']);await as(Ahmed,INS,[A,Ahmed,WA['Household cash'],null,'income',1000,'Add income','']);
  await as(Bob,INS,[B,Bob,WB['Bank account'],null,'income',20000,'Add income','']);
  await admin.query("update notification_outbox set status='sent',done_at=now()");

  await test('migration 011 is additive and can be run twice; existing tables, policies and triggers are untouched',async()=>{
    const snap=async()=>JSON.stringify((await admin.query("select (select json_agg(x order by x) from (select tablename||':'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') x from pg_policies where schemaname='public' and tablename not like 'bank_%') p) pol,(select json_agg(x order by x) from (select tgrelid::regclass||':'||tgname x from pg_trigger where not tgisinternal) t) trg,(select json_agg(x order by x) from (select table_name||'.'||column_name||':'||data_type x from information_schema.columns where table_schema='public' and table_name not like 'bank_%') c) col")).rows[0]);
    const before=await snap();await db.migrate(['011 bank sms import.sql']);const mid=await snap();await db.migrate(['011 bank sms import.sql']);eq(await snap(),mid);eq(mid,before);
    eq((await admin.query("select tablename from pg_tables where schemaname='public' and tablename like 'bank_%' order by 1")).rows.map(r=>r.tablename),['bank_import_keys','bank_imports','bank_transfer_merges'])});
  await test('import key: created by the signed-in user for themselves, shown once, stored only as a hash, bound to the app\'s own wallets',async()=>{
    const k=await newKey(Ahmed);kA=k.key;ok(/^htk_[0-9a-f]{64}$/.test(kA),'key format');eq([k.sender,k.wallet,k.cash_wallet],['BanK-AIAhly','Bank account','Household cash']);
    const row=(await admin.query('select * from bank_import_keys where user_id=$1',[Ahmed])).rows[0];eq([row.user_id,row.household_id,row.wallet_id,row.cash_wallet_id],[Ahmed,A,WA['Bank account'],WA['Household cash']]);
    ok(!JSON.stringify(row).includes(kA)&&/^[0-9a-f]{64}$/.test(row.key_hash),'the key itself is not in the database');ok(row.expires_at>new Date(Date.now()+364*86400e3));
    kMona=(await newKey(Mona)).key;kB=(await newKey(Bob)).key;ok(new Set([kA,kMona,kB]).size===3)});
  await test('keys and server functions are closed to the browser: no reading keys, no calling the server-only functions, no key without login, no foreign wallet',async()=>{
    await throws(()=>as(Ahmed,'select * from bank_import_keys'),/permission denied/);await throws(()=>as(Ahmed,"insert into bank_imports(household_id,fingerprint,provider,kind,rule,sms_hash) values($1,'x','x','x','x','x')",[A]),/permission denied/);
    await throws(()=>as(Ahmed,'select bank_import_auth($1)',['x']),/permission denied/);await throws(()=>as(Ahmed,"select bank_import_commit('x','{}'::jsonb,false)"),/permission denied/);
    await throws(()=>as(Ahmed,"select bank_import_key_new($1,'BanK-AIAhly',null,null,365)",[Mona]),/permission denied/,'cannot mint a key for someone else:');
    await throws(()=>as(null,"select bank_import_create_key('BanK-AIAhly')"),/not signed in|permission denied/);
    await throws(()=>newKey(Ahmed,'BanK-AIAhly',WB['Bank account']),/wallet does not belong/);await throws(()=>newKey(Ahmed,'BanK-AIAhly',WA['Bank account'],WB['Household cash']),/cash wallet does not belong/);
    await throws(()=>newKey(Ahmed,'BanK-AIAhly',null,null,5000),/validity/);await throws(()=>newKey(Ahmed,''),/sender/);
    eq((await as(Bob,'select * from bank_imports')).rows.length,0)});

  console.log('\nSecurity');
  await test('missing / malformed / unknown key → 401 unauthorized; nothing is parsed, nothing is created',async()=>{
    const n=await count(A),body={sender:'BanK-AIAhly',text:sms('card_en')};
    for(const h of [{},{Authorization:''},{Authorization:'Bearer '},{Authorization:'Bearer garbage'},{Authorization:'Bearer htk_123'},{'X-Import-Key':'htk_'+'g'.repeat(64)},{Authorization:'Bearer htk_'+'0'.repeat(64)},{Authorization:'Bearer user:'+Ahmed},{Authorization:'Bearer service-secret'},{Authorization:'Bearer '+kA.toUpperCase()},{Authorization:'Bearer '+kA+'0'}]){
      const r=await post(null,body,h);eq(r,{http:401,ok:false,status:'unauthorized'},JSON.stringify(h))}
    eq([await count(A),(await imports(A)).length],[n,0])});
  await test('expired key, revoked key, key of a member who was removed from the household → 401; a fresh key works again',async()=>{
    const n=await count(A),t=(await newKey(Dad)).key;
    eq((await imp(t,'card_en',{dry_run:true})).status,'would_import');
    await admin.query("update bank_import_keys set expires_at=now()-interval '1 second' where user_id=$1",[Dad]);eq(await imp(t,'card_en'),{http:401,ok:false,status:'unauthorized'},'expired:');
    await admin.query("update bank_import_keys set expires_at=now()+interval '1 day' where user_id=$1",[Dad]);eq((await imp(t,'card_en',{dry_run:true})).status,'would_import');
    eq((await one(Dad,'select bank_import_revoke_keys() n')).n,1);eq(await imp(t,'card_en'),{http:401,ok:false,status:'unauthorized'},'revoked:');
    const t2=(await newKey(Dad)).key;eq((await imp(t2,'card_en',{dry_run:true})).status,'would_import');
    await as(Ahmed,'select remove_member($1,$2)',[A,Dad]);eq(await imp(t2,'card_en'),{http:401,ok:false,status:'unauthorized'},'no longer a member:');
    ok(logs.some(l=>/"reason":"expired_key"/.test(l))&&logs.some(l=>/"reason":"revoked_key"/.test(l))&&logs.some(l=>/"reason":"not_a_member"/.test(l)),'the log tells the three apart, the caller cannot');
    eq(await count(A),n)});
  await test('forged user id / household id / wallet ids in the request are ignored: the entry goes to the key owner\'s own household and bank wallet',async()=>{
    const nA=await count(A),bA=await bal(Ahmed,A);
    const r=await post(kB,{sender:'BanK-AIAhly',text:sms('transfer_ar'),user_id:Ahmed,household_id:A,wallet_id:WA['Household cash'],to_wallet_id:WA['Bank account'],type:'income',amount:999999,key_id:'x'});
    eq([r.http,r.status,r.type,r.amount,r.wallet],[200,'imported','expense',500,'Bank account']);
    const t=(await txs(B)).pop();eq([t.user_id,t.household_id,t.wallet,t.type,t.amount],[Bob,B,'Bank account','expense',500]);
    eq([await count(A),await bal(Ahmed,A)],[nA,bA],'household A is untouched');eq((await as(Ahmed,'select * from bank_imports')).rows.length,0,'A cannot even see B\'s import record')});
  await test('sender / provider not allowed for this key → refused: wrong sender, unknown bank, Vodafone Cash message on a bank key',async()=>{
    const n=await count(A);
    eq(await post(kA,{sender:'CIB',text:sms('card_en')}),{http:403,ok:false,status:'sender_not_allowed'});eq(await post(kA,{sender:'VF-Cash',text:M.vfcash_out_en.text}),{http:403,ok:false,status:'sender_not_allowed'});
    eq(await post(kA,{sender:'BanK-AIAhly',text:M.vfcash_out_en.text}),{http:422,ok:false,status:'unrecognized_sms',reason:'no_rule_matched'},'right sender, other provider\'s wording:');
    eq((await post(kA,{sender:'bank-alahly',text:sms('card_en'),dry_run:true})).status,'would_import','l / I look-alike sender spelling is accepted');
    const kc=(await one(Mona,"select bank_import_create_key('CIB') k")).k.key;eq(await post(kc,{sender:'CIB',text:sms('card_en')}),{http:403,ok:false,status:'sender_not_supported'},'a sender the parser has no rules for:');
    eq(await count(A),n)});
  await test('bad requests → 400 (after authentication), wrong method → 405, unrecognised SMS → 422 with a safe reason; nothing created',async()=>{
    const n=await count(A);
    for(const b of ['not json','[]','{}',{sender:'BanK-AIAhly'},{text:sms('card_en')},{sender:'BanK-AIAhly',text:123},{sender:'BanK-AIAhly',text:'x'.repeat(9000)}])eq((await post(kA,b)).status,'bad_request',JSON.stringify(b).slice(0,40));
    eq((await handle(new Request('https://x/f',{method:'GET'}),ENV,fakeFetch)).status,405);eq((await handle(new Request('https://x/f',{method:'OPTIONS'}),ENV,fakeFetch)).status,200);
    eq(await imp(kA,'Enjoy 20% cashback up to EGP 500 with your card'),{http:422,ok:false,status:'unrecognized_sms',reason:'no_rule_matched'});
    eq((await imp(kA,'Your OTP is 123456 for purchase of EGP 50.00 with card 1234')).reason,'one_time_code');eq((await imp(kA,'Your card ending 1234 was charged EGP 1,25.0 at SHOP')).reason,'amount_malformed');
    eq((await imp(kA,'Your card ending 1234 was charged EGP 10.00 at SHOP on 32/13/2026')).reason,'date_malformed');eq(await count(A),n)});

  console.log('\nTransaction correctness');
  let cardTx;
  await test('card purchase → a normal expense: type, amount, wallet, balance effect, household, creator, description, SMS timestamp, source record',async()=>{
    const b0=await bal(Ahmed,A),n=await count(A);const r=await imp(kA,'card_en');
    eq([r.http,r.ok,r.status,r.provider,r.kind,r.type,r.amount,r.rule,r.wallet,r.to_wallet,r.description,r.date_source],[200,true,'imported','bank_card','card_purchase','expense',1250.5,'nbe.card_purchase.en','Bank account',null,'CARREFOUR MAADI','sms']);
    const t=(await txs(A)).pop();cardTx=t.id;eq(r.transaction_id,t.id);eq(await count(A),n+1);
    eq([t.type,t.amount,t.wallet,t.to_wallet,t.household_id,t.user_id,t.category,t.note],['expense',1250.5,'Bank account',null,A,Ahmed,'CARREFOUR MAADI','Bank SMS · Card · ref 123456789012']);
    eq(t.created_at.toISOString(),new Date(cairoToUtc(YD.y,YD.m,YD.d,14,35,0)).toISOString(),'the time written in the SMS (Cairo)');
    const b1=await bal(Ahmed,A);eq([b1['Bank account'],b1['Household cash']],[b0['Bank account']-1250.5,b0['Household cash']]);
    eq(+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance,b1['Bank account']+b1['Household cash']+b1['Personal cash']);
    const i=(await imports(A)).pop();eq([i.transaction_id,i.user_id,i.provider,i.kind,i.rule,i.reference],[t.id,Ahmed,'bank_card','card_purchase','nbe.card_purchase.en','123456789012']);
    ok(!JSON.stringify(i).includes('CARREFOUR'),'the SMS text is not stored');
    eq((await as(Mona,'select transaction_id,provider from bank_imports where transaction_id=$1',[t.id])).rows,[{transaction_id:t.id,provider:'bank_card'}],'household members can tell it was bank-imported');
    eq((await as(Mona,'select category from transactions where id=$1',[t.id])).rows.length,1,'visible to the household like any entry')});
  await test('ATM withdrawal → withdraw Bank account → Household cash (both balances move, total unchanged); cash deposit → the reverse',async()=>{
    const b0=await bal(Ahmed,A),s0=+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance;
    const r=await imp(kA,'atm_ar');eq([r.status,r.type,r.amount,r.wallet,r.to_wallet,r.description],['imported','withdraw',2000,'Bank account','Household cash','Withdraw cash']);
    let t=(await txs(A)).pop();eq([t.type,t.wallet,t.to_wallet,t.category,t.note,t.user_id],['withdraw','Bank account','Household cash','Withdraw cash','Bank SMS · ATM',Ahmed]);
    let b=await bal(Ahmed,A);eq([b['Bank account'],b['Household cash']],[b0['Bank account']-2000,b0['Household cash']+2000]);eq(+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance,s0);
    const d=await imp(kA,'cash_deposit_en');eq([d.status,d.type,d.wallet,d.to_wallet],['imported','deposit','Household cash','Bank account']);
    t=(await txs(A)).pop();eq([t.type,t.wallet,t.to_wallet,t.category,t.amount],['deposit','Household cash','Bank account','Cash back to bank',3000]);
    b=await bal(Ahmed,A);eq([b['Bank account'],b['Household cash']],[b0['Bank account']+1000,b0['Household cash']-1000])});
  await test('credit / InstaPay received / refund → income on the bank wallet; bank transfer / InstaPay sent → expense; descriptions keep the names',async()=>{
    const b0=await bal(Ahmed,A);const got=[];
    for(const id of ['credit_en','instapay_in_en','refund_en','transfer_ar','instapay_out_en']){const r=await imp(kA,id);eq(r.status,'imported',id);const t=(await txs(A)).pop();got.push([t.type,t.amount,t.wallet,t.category,t.note])}
    eq(got,[['income',15000,'Bank account','Add income','From ACME COMPANY · Bank SMS · Bank'],['income',300,'Bank account','Add income','From SARA HASSAN · Bank SMS · InstaPay · ref 555666777'],
      ['income',120,'Bank account','Add income','Refund · AMAZON EG · Bank SMS · Card'],['expense',500,'Bank account','محمد علي','Transfer · Bank SMS · Bank · ref 778899'],['expense',750,'Bank account','ahmed@instapay','Transfer · Bank SMS · InstaPay · ref 987654321']]);
    eq((await bal(Ahmed,A))['Bank account'],b0['Bank account']+15000+300+120-500-750);
    eq((await one(Ahmed,"select range_stats($1,(now() at time zone 'Africa/Cairo')::date-3,(now() at time zone 'Africa/Cairo')::date) s",[A])).s.by_member[0].name,'Ahmed','counted in the normal statistics under the key owner')});
  await test('an imported entry behaves like a manual one afterwards: creator can edit it (history recorded), another member cannot, creator can delete it',async()=>{
    const r=await imp(kA,'Your card ending 1234 was charged EGP 40.00 at KIOSK on '+YD.txt+' 08:00. Ref 40404040');const id=r.transaction_id;
    eq((await as(Mona,"update transactions set amount=1 where id=$1 returning id",[id])).rows.length,0,'RLS: not the creator, not the owner');
    eq((await as(Ahmed,"update transactions set amount=45,category='Kiosk' where id=$1 returning id",[id])).rows.length,1);
    const a=(await admin.query('select action,actor,(old_row->>\'amount\')::float8 o,(new_row->>\'amount\')::float8 n from audit_log where tx_id=$1',[id])).rows;eq(a,[{action:'UPDATE',actor:Ahmed,o:40,n:45}]);
    await throws(()=>as(Ahmed,"update transactions set type='income' where id=$1",[id]),/immutable/);
    eq((await as(Ahmed,'delete from transactions where id=$1 returning id',[id])).rows.length,1);
    eq((await admin.query('select action from audit_log where tx_id=$1 order by id',[id])).rows.map(x=>x.action),['UPDATE','DELETE'])});
  const ipay=(ref,amount,dir='out')=>{const [dd,mm]=YD.txt.split('/');return dir==='out'?`تم تنفيذ تحويل لحظي من حسابكم رقم 0170 بمبلغ ${amount} جم إلى TEST R***** رقم مرجعي ${ref} يوم ${mm}-${dd} الساعة 10:00 للمزيد اتصل بـ 19623`:`تم إضافة تحويل لحظي لحسابكم رقم 0170 بمبلغ ${amount} جم من TEST SENDER رقم مرجعي ${ref} يوم ${mm}-${dd} الساعة 10:00 للمزيد اتصل بـ 19623`};
  const BA=()=>bal(Ahmed,A).then(b=>b['Bank account']);
  await test('balance: enough money in the wallet → imported, balance_negative false (also in the dry run)',async()=>{
    await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',1000,'Add income','']);const b=await BA();ok(b>=1000);
    const d=await imp(kA,ipay('810000000001','100.00'),{dry_run:true});eq([d.status,d.balance_negative],['would_import',false]);
    const r=await imp(kA,ipay('810000000001','100.00'));eq([r.http,r.status,r.type,r.amount,r.balance_negative],[200,'imported','expense',100,false]);eq(await BA(),b-100)});
  await test('balance: an imported expense larger than the wallet is NOT refused → imported, balance_negative true, the wallet shows the negative balance, no balancing entry is invented',async()=>{
    const n=await count(A),i=(await imports(A)).length,b=await BA(),text=ipay('810000000002','900,000.00');
    const d=await imp(kA,text,{dry_run:true});eq([d.status,d.balance_negative],['would_import',true]);eq([await count(A),await BA()],[n,b],'dry run writes nothing');
    const r=await imp(kA,text);eq([r.http,r.ok,r.status,r.type,r.amount,r.wallet,r.balance_negative],[200,true,'imported','expense',900000,'Bank account',true]);
    eq([await count(A),(await imports(A)).length,await BA()],[n+1,i+1,b-900000],'exactly one entry; nothing else created');ok(await BA()<0);
    const t=(await txs(A)).pop();eq([t.id,t.type,t.amount,t.wallet],[r.transaction_id,'expense',900000,'Bank account']);eq((await outbox(t.id)).status,'sent','notified like any entry');
    const r2=await imp(kA,ipay('810000000003','50.00'));eq([r2.status,r2.balance_negative],['imported',true],'a further bank transaction on the negative wallet is recorded too');eq(await BA(),b-900050)});
  await test('balance: entries made by hand keep the normal rule - expense / transfer / raising an amount on the negative wallet are rejected; the switch does not leak to the user',async()=>{
    const b=await BA(),n=await count(A);ok(b<0);
    await throws(()=>as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',1,'Manual','']),/Insufficient funds\. Available balance in Bank account/);
    await throws(()=>as(Ahmed,INS,[A,Ahmed,WA['Bank account'],WA['Personal cash'],'transfer',1,'Move','']),/Insufficient funds/);
    await throws(()=>as(Mona,INS,[A,Mona,WA['Bank account'],null,'expense',0.01,'Manual','']),/Insufficient funds/);
    const mine=(await txs(A)).filter(t=>t.note.includes('810000000003')).pop();await throws(()=>as(Ahmed,'update transactions set amount=60 where id=$1',[mine.id]),/Insufficient funds/);
    eq([await count(A),await BA()],[n,b]);
    eq((await admin.query("select current_setting('app.bypass_balance',true) v")).rows[0].v||'','','the switch is transaction-local: no session keeps it');
    await throws(()=>as(Ahmed,'select bank_import_commit($1,$2::jsonb,false)',['0'.repeat(64),'{}']),/permission denied/,'a signed-in user cannot call the import function');
    const src=(await admin.query("select prosrc from pg_proc where proname='tx_balance_check'")).rows[0].prosrc;ok(/Insufficient funds/.test(src)&&/bal<0/.test(src),'the balance trigger itself is unchanged')});
  await test('balance: incoming transactions work normally on a negative wallet (balance_negative false) and bring it back; manual spending works again once positive',async()=>{
    const b=await BA();const r=await imp(kA,ipay('810000000004','500.00','in'));eq([r.status,r.type,r.amount,r.balance_negative],['imported','income',500,false]);eq(await BA(),b+500);
    await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',900050,'Add income','']);ok(await BA()>0);
    eq((await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',1,'Manual',''])).rows.length,1);await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',1,'Add income',''])});
  await test('balance: duplicate protection still works after a negative-balance import (resend x1, x10, dry run) → already_imported, balance unchanged',async()=>{
    const n=await count(A),b=await BA();
    for(const ref of ['810000000001','810000000002','810000000003']){const amt=ref.endsWith('1')?'100.00':ref.endsWith('2')?'900,000.00':'50.00';
      eq((await imp(kA,ipay(ref,amt))).status,'already_imported',ref);eq((await Promise.all(Array.from({length:10},()=>imp(kA,ipay(ref,amt))))).map(x=>x.status),Array(10).fill('already_imported'));eq((await imp(kA,ipay(ref,amt),{dry_run:true})).status,'already_imported')}
    eq([await count(A),await BA()],[n,b])});
  await test('balance: concurrent imports cannot race - 12 different imports at once plus manual spending: every import is recorded once, the balance is exact, manual entries never overdraw',async()=>{
    const b0=await BA(),n=await count(A);await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',b0-300,'Reset','']);eq(await BA(),300);
    const jobs=[];for(let i=0;i<12;i++)jobs.push(imp(kA,ipay('82000000'+String(1000+i),'70.00')).then(r=>['imp',r.status,r.balance_negative]));
    for(let i=0;i<8;i++)jobs.push(db.conn().then(c=>db.as(i%2?Mona:Ahmed,INS,[A,i%2?Mona:Ahmed,WA['Bank account'],null,'expense',70,'Manual race',''],c).finally(()=>c.end())).then(()=>['man','ok'],e=>['man',/Insufficient funds/.test(e.message)?'refused':'ERR '+e.message]));
    const res=await Promise.all(jobs),imps=res.filter(x=>x[0]==='imp'),man=res.filter(x=>x[0]==='man');
    eq(imps.map(x=>x[1]),Array(12).fill('imported'));ok(man.every(x=>x[1]==='ok'||x[1]==='refused'),JSON.stringify(man));const okMan=man.filter(x=>x[1]==='ok').length;ok(okMan<=4,'manual entries can use at most the 300 that were there: '+okMan);
    const after=await BA();eq(after,300-12*70-okMan*70,'balance = exactly the sum of what was recorded');eq(await count(A),n+1+12+okMan);
    eq(imps.filter(x=>x[2]===true).length>=12-4,true,'imports that ended below zero say so');
    const rows=(await txs(A)).filter(t=>/ref 82000000\d{4}/.test(t.note));eq([rows.length,new Set(rows.map(t=>t.note)).size],[12,12]);
    await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',b0-after,'Add income','']);eq(await BA(),b0)});
  await test('balance: the import really waits for the wallet lock (a manual entry holding the wallet blocks it; it completes after the release)',async()=>{
    const c=await db.conn();await c.query('begin');await c.query('select 1 from wallets where id=$1 for update',[WA['Bank account']]);
    let done=false;const job=imp(kA,ipay('830000000001','5.00')).then(r=>{done=true;return r});await new Promise(r=>setTimeout(r,400));eq(done,false,'still waiting while the wallet is locked');
    await c.query('commit');await c.end();const r=await job;eq([r.status,done],['imported',true])});
  await test('wallet_required: no wallet is ever picked arbitrarily (cash wallet gone → ATM message refused; bank wallet gone → everything refused; no "Bank account" → no key)',async()=>{
    const n=await count(A),atm='Cash withdrawal of EGP 100.00 from ATM using card ending 1234 on '+YD.txt+' at 07:00';
    await admin.query('update bank_import_keys set cash_wallet_id=null where user_id=$1',[Mona]);
    eq(await imp(kMona,atm),{http:409,ok:false,status:'wallet_required',reason:'cash_wallet_missing',provider:'atm',type:'withdraw'});
    eq((await imp(kMona,'Your card ending 1234 was charged EGP 5.00 at GUM SHOP on '+YD.txt+' 07:01',{dry_run:true})).status,'would_import','purchases need only the bank wallet');
    await admin.query('update bank_import_keys set wallet_id=null where user_id=$1',[Mona]);
    eq((await imp(kMona,'Your card ending 1234 was charged EGP 5.00 at GUM SHOP on '+YD.txt+' 07:01')).reason,'account_wallet_missing');
    await admin.query('update bank_import_keys set wallet_id=$2,cash_wallet_id=$3 where user_id=$1',[Mona,WA['Bank account'],WA['Household cash']]);eq(await count(A),n);
    const Zed=await user('Zed'),Z=(await one(Zed,"select create_household('Home Z') h")).h;await admin.query("update wallets set name='Savings' where household_id=$1 and name='Bank account'",[Z]);
    await throws(()=>newKey(Zed),/wallet_required/);const zw=(await admin.query("select id from wallets where household_id=$1 and name='Savings'",[Z])).rows[0].id;
    eq((await newKey(Zed,'BanK-AIAhly',zw)).wallet,'Savings','an explicitly chosen wallet of the own household is fine')});

  console.log('\nDuplicate prevention');
  await test('same SMS twice → one transaction; the second answer is already_imported and changes nothing',async()=>{
    const n=await count(A),before=JSON.stringify((await txs(A)).find(t=>t.id===cardTx));
    const r=await imp(kA,'card_en');eq(r,{http:200,ok:true,status:'already_imported',transaction_id:cardTx});
    eq([await count(A),JSON.stringify((await txs(A)).find(t=>t.id===cardTx))],[n,before]);
    eq((await post(kA,{sender:'BanK-AIAhly',text:'  '+sms('card_en').replace(/ /g,'   ')+'\n'})).status,'already_imported','spacing differences are the same message')});
  await test('same SMS ten times at the same moment → exactly one transaction, one import record, one outbox row',async()=>{
    const n=await count(A),text='Your card ending 1234 was charged EGP 77.00 at BAKERY on '+YD.txt+' 10:10. Available balance EGP 1.00';
    const rs=await quiet(()=>Promise.all(Array.from({length:10},async()=>{const r=await handle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer '+kA},body:JSON.stringify({sender:'BanK-AIAhly',text})}),ENV,fakeFetch);return(await r.json())})));
    eq(rs.map(r=>r.status).sort(),['already_imported',...Array(8).fill('already_imported'),'imported']);eq(new Set(rs.map(r=>r.transaction_id)).size,1,'all ten name the same transaction');
    eq(await count(A),n+1);const id=rs[0].transaction_id;eq(+(await admin.query('select count(*) n from bank_imports where transaction_id=$1',[id])).rows[0].n,1);eq(+(await admin.query('select count(*) n from notification_outbox where transaction_id=$1',[id])).rows[0].n,1);
    for(let i=0;i<10;i++)eq((await imp(kA,text)).status,'already_imported');eq(await count(A),n+1)});
  await test('retry after a timeout / lost answer: the entry was saved but the caller saw an error → the retry reports already_imported, still one transaction',async()=>{
    const n=await count(A),text='Your card ending 1234 was charged EGP 66.00 at PHARMACY on '+YD.txt+' 12:12. Ref 66006600';
    world.loseReply=true;const r1=await imp(kA,text);eq([r1.http,r1.status],[500,'error']);eq(await count(A),n+1,'it WAS saved');
    const r2=await imp(kA,text);eq([r2.status,r2.transaction_id],['already_imported',(await txs(A)).pop().id]);eq(await count(A),n+1)});
  await test('same bank reference twice (even with different wording) → one transaction; a different reference or amount is a different transaction',async()=>{
    const n=await count(A),t=ref=>`A transfer of EGP 55.00 from your account ending 5678 to OMAR was executed on ${YD.txt}. Ref ${ref}`;
    eq((await imp(kA,t('FT111222'))).status,'imported');eq((await imp(kA,t('FT111222').replace('was executed','was completed successfully'))).status,'already_imported');eq((await imp(kA,t('ft111222'))).status,'already_imported');
    eq((await imp(kA,t('FT111223'))).status,'imported');eq(await count(A),n+2)});
  await test('duplicates across the household: the same message from another member\'s phone (joint account) is not booked twice; another household is separate',async()=>{
    const n=await count(A),nB=await count(B);
    eq(await imp(kMona,'card_en'),{http:200,ok:true,status:'already_imported',transaction_id:cardTx});eq(await count(A),n);
    eq((await imp(kB,'card_en')).status,'imported');eq(await count(B),nB+1)});
  await test('an imported entry that was deleted in the app is NOT re-created when the phone re-sends the SMS',async()=>{
    const text='Your card ending 1234 was charged EGP 33.00 at CAFE on '+YD.txt+' 13:13. Ref 33003300';const r=await imp(kA,text);
    await as(Ahmed,'delete from transactions where id=$1',[r.transaction_id]);const n=await count(A);
    eq(await imp(kA,text),{http:200,ok:true,status:'already_imported',transaction_id:null});eq(await count(A),n)});
  await test('dry run: reports what would happen (parsing, wallets, duplicate state) and writes nothing; the real import afterwards works',async()=>{
    const n=await count(A),i=(await imports(A)).length,text='Refund of EGP 12.00 from BOOKSHOP to your card ending 1234 on '+YD.txt;
    const r=await imp(kA,text,{dry_run:true});eq([r.http,r.ok,r.status,r.dry_run,r.provider,r.kind,r.type,r.amount,r.wallet,r.transaction_id],[200,true,'would_import',true,'bank_card','refund','income',12,'Bank account',undefined]);
    eq([await count(A),(await imports(A)).length],[n,i]);eq((await imp(kA,text)).status,'imported');eq((await imp(kA,text,{dry_run:true})).status,'already_imported');eq(await count(A),n+1)});

  console.log('\nNotification pipeline (existing outbox → notify-transactions → OneSignal)');
  await test('import → the normal outbox row → existing notify-transactions (server call) → OneSignal: household members only, never the key owner, never another household',async()=>{
    sent.length=0;world.notifyCalls.length=0;world.authCalls=0;
    const r=await imp(kA,'Your card ending 1234 was charged EGP 88.00 at SEOUDI MARKET on '+YD.txt+' 15:15. Ref 88008800');
    eq([r.status,r.notification],['imported','triggered']);eq(world.notifyCalls,[{on_behalf_of:Ahmed}]);eq(world.authCalls,0);
    eq(sent.map(s=>[s.include_subscription_ids,s.headings.en,s.contents.en]),[[[sub(3)],'🔔 مصروف جديد','أضاف Ahmed مصروفًا بقيمة 88.00 جنيه: SEOUDI MARKET · Bank SMS · Card · ref 88008800']]);
    const o=await outbox(r.transaction_id);eq([o.status,o.recipients],['sent',1]);
    sent.length=0;eq((await imp(kA,'Your card ending 1234 was charged EGP 88.00 at SEOUDI MARKET on '+YD.txt+' 15:15. Ref 88008800')).status,'already_imported');eq(sent.length,0,'a duplicate notifies nobody')});
  await test('notify-transactions unreachable → the import still succeeds, the notification stays queued and is delivered once by the normal app call',async()=>{
    sent.length=0;world.notifyDown=true;const r=await imp(kA,'InstaPay: you received EGP 21.00 in your account ending 5678 from HODA on '+YD.txt+' 16:16. Reference 21002100');world.notifyDown=false;
    eq([r.status,r.notification,sent.length],['imported','queued',0]);eq((await outbox(r.transaction_id)).status,'pending');
    const call=async u=>{const x=await notifyHandle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer user:'+u,apikey:'anon'},body:'{}'}),ENV,fakeFetch);return x.json()};
    eq((await quiet(()=>call(Bob))).claimed,0);eq((await quiet(()=>call(Mona))).sent,1);eq(sent.map(s=>s.include_subscription_ids),[[sub(3)]]);eq((await quiet(()=>call(Mona))).claimed,0)});
  await test('notify-transactions server call: only the service-role key opens it, a user id is required; a normal user cannot act for someone else',async()=>{
    const nf=async(headers,body)=>quiet(async()=>{const x=await notifyHandle(new Request('https://x/f',{method:'POST',headers,body:JSON.stringify(body)}),ENV,fakeFetch);return{http:x.status,...(await x.json())}});
    eq((await nf({Authorization:'Bearer service-secret'},{})).http,400);eq((await nf({Authorization:'Bearer service-secret'},{on_behalf_of:'not-a-uuid'})).http,400);
    eq((await nf({Authorization:'Bearer service-secret'},{on_behalf_of:Ahmed})).http,200);
    eq((await nf({Authorization:'Bearer service-secreT'},{on_behalf_of:Ahmed})).http,401);eq((await nf({Authorization:'Bearer '+kA},{on_behalf_of:Ahmed})).http,401,'an import key is not a login');
    sent.length=0;const t=(await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',3,'Gum',''])).rows[0].id;
    const r=await nf({Authorization:'Bearer user:'+Bob,apikey:'anon'},{on_behalf_of:Ahmed});eq([r.http,r.claimed,sent.length],[200,0,0],'on_behalf_of from a browser session is ignored');eq((await outbox(t)).status,'pending')});

  console.log('\nReal production messages through the deployed configuration');
  const postReal=(key,m,extra={})=>quiet(async()=>{const r=await handle(new Request('https://proj.supabase.co/functions/v1/bank-sms-import',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({sender:m.sender,text:m.text,...extra})}),PROD,fakeFetch,RNOW);return{http:r.status,...(await r.json())}});
  let kVF;
  await test('the five real messages become the right normal transactions (type, amount, wallet, balance, description, SMS time, source record) and feed the outbox',async()=>{
    kVF=(await newKey(Ahmed,'VF-Cash',WA['Personal cash'],WA['Household cash'])).key;await as(Ahmed,INS,[A,Ahmed,WA['Personal cash'],null,'income',100,'Add income','']);await admin.query("update notification_outbox set status='sent',done_at=now() where status<>'sent'");
    const b0=await bal(Ahmed,A),n=await count(A),got=[];sent.length=0;
    for(const id of ['real_instapay_out','real_instapay_in','real_debit_card','real_vfcash_in','real_vfcash_recharge']){const m=R[id],r=await postReal(m.issuer==='nbe'?kA:kVF,m);eq([r.http,r.status,r.notification],[200,'imported','triggered'],id);
      const t=(await txs(A)).pop();eq(t.id,r.transaction_id);got.push([t.type,t.amount,t.wallet,t.category,t.note,t.user_id===Ahmed,m.expect.date_source==='received'||t.created_at.toISOString()===m.expect.at]);
      const o=await outbox(t.id);eq(o.status,'sent',id+' outbox');const i=(await imports(A)).pop();eq([i.transaction_id,i.provider,i.rule,i.reference],[t.id,m.expect.provider,m.expect.rule,m.expect.reference||null])}
    eq(got,[['expense',1,'Bank account','محمد ا**** ا*** ع** ح**** ا******','Transfer · Bank SMS · InstaPay · ref 456611434599',true,true],
      ['income',205,'Bank account','Add income','From عبير على زين العابدين القصبى قداح · Bank SMS · InstaPay · ref 467579444840',true,true],
      ['expense',200,'Bank account','Mansoura Market 2 D','Bank SMS · Debit card',true,true],
      ['income',1,'Personal cash','Add income','From محمد اسامه احمد علي حسنين · Bank SMS · Vodafone Cash · ref 025712695852',true,true],
      ['expense',30,'Personal cash','Vodafone Cash mobile recharge','Bank SMS · Vodafone Cash',true,true]]);
    const b1=await bal(Ahmed,A);eq([b1['Bank account'],b1['Personal cash'],b1['Household cash']],[b0['Bank account']-1+205-200,b0['Personal cash']+1-30,b0['Household cash']]);eq(await count(A),n+5);
    eq(sent.length,5);ok(sent.every(x=>JSON.stringify(x.include_subscription_ids)===JSON.stringify([sub(3)])),'each one notified the other member only');
    const dump=JSON.stringify([(await imports(A)).map(i=>[i.provider,i.kind,i.rule,i.reference]),(await txs(A)).map(t=>[t.type,t.amount,t.category,t.note])]);   /* stored text only: timestamps / ids contain digit runs by chance */ok(!dump.includes('01095872700'),'the phone number is stored nowhere');ok(!dump.includes('المتاح')&&!dump.includes('كاش باك')&&!dump.includes('19623'),'the SMS text is stored nowhere')});
  await test('resending each real message (once, ten times, with different spacing / digit style) → already_imported, still one transaction each, no new notification',async()=>{
    const n=await count(A);sent.length=0;
    for(const id of ['real_instapay_out','real_instapay_in','real_debit_card','real_vfcash_in','real_vfcash_recharge']){const m=R[id],k=m.issuer==='nbe'?kA:kVF;
      const first=await postReal(k,m);eq([first.http,first.ok,first.status],[200,true,'already_imported'],id);ok(first.transaction_id);
      const rs=await Promise.all(Array.from({length:10},()=>postReal(k,m)));eq(rs.map(x=>x.status),Array(10).fill('already_imported'),id+' x10');
      eq((await postReal(k,{...m,text:'  '+m.text.replace(/ /g,'  ')+' \n'})).status,'already_imported',id+' spacing');eq((await postReal(k,m,{dry_run:true})).status,'already_imported',id+' dry run')}
    eq((await postReal(kA,{...R.real_instapay_out,text:R.real_instapay_out.text.replace('للمزيد اتصل بـ 19623','')})).status,'already_imported','same bank reference, different tail');
    eq([await count(A),sent.length],[n,0])});
  await test('a different transaction is not swallowed: another reference / another balance after an identical purchase → imported; wrong key family → refused',async()=>{
    const n=await count(A);
    eq((await postReal(kA,{...R.real_instapay_out,text:R.real_instapay_out.text.replace('456611434599','456611434600')})).status,'imported');
    eq((await postReal(kVF,{...R.real_vfcash_recharge,text:R.real_vfcash_recharge.text.replace('4.93','0.93').replace('وخصم 30','وخصم 4').replace('ب 30','ب 4')})).status,'imported','second recharge: the balance differs, so the message differs');
    eq(await postReal(kA,{...R.real_vfcash_in,sender:'BanK-AIAhly'}),{http:422,ok:false,status:'unrecognized_sms',reason:'no_rule_matched'});eq((await postReal(kA,R.real_vfcash_in)).status,'sender_not_allowed');eq((await postReal(kVF,R.real_debit_card)).status,'sender_not_allowed');
    eq(await count(A),n+2)});
  await test('deployed configuration: provisional (unverified) wording is refused - nothing is created; altered / ambiguous real messages are refused too',async()=>{
    const n=await count(A);
    for(const m of FX.messages.filter(m=>m.issuer==='nbe')){const r=await postReal(kA,{sender:'BanK-AIAhly',text:m.text});eq([r.http,r.status,r.reason],[422,'unrecognized_sms','no_rule_matched'],m.id)}
    eq((await postReal(kA,{...R.real_debit_card,text:R.real_debit_card.text.replace('تم خصم 200 EGP','تم خصم')})).reason,'structure_mismatch');
    eq((await postReal(kA,{...R.real_instapay_out,text:R.real_instapay_out.text+' '+R.real_instapay_in.text})).status,'unrecognized_sms');
    eq((await postReal(kVF,{...R.real_vfcash_recharge,text:'حول فلوس لأي محفظة وزود فرصك تكسب جنيه دهب! وكمان هيجيلك لحد 100ج كاش باك'})).status,'unrecognized_sms');eq(await count(A),n)});

  console.log('\nSecond batch of real messages through the deployed configuration');
  await test('the ten new real messages become the right normal transactions; phone numbers, balances, fee, advert and hotline are stored nowhere',async()=>{
    await as(Ahmed,INS,[A,Ahmed,WA['Personal cash'],null,'income',500,'Add income','']);await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',2000,'Add income','']);await admin.query("update notification_outbox set status='sent',done_at=now() where status<>'sent'");
    const b0=await bal(Ahmed,A),n=await count(A),ni=(await imports(A)).length;sent.length=0;let bank=0,vf=0;
    for(const m of R2){const r=await postReal(m.issuer==='nbe'?kA:kVF,m);eq([r.http,r.status,r.type,r.amount,r.notification],[200,'imported',m.expect.type,m.expect.amount,'triggered'],m.id);
      const t=(await txs(A)).pop();eq([t.id,t.type,t.amount,t.wallet,t.category,t.note,t.user_id],[r.transaction_id,m.expect.type,m.expect.amount,m.issuer==='nbe'?'Bank account':'Personal cash',m.describe.category,m.describe.note,Ahmed],m.id);
      if(m.expect.date_source==='sms')eq(t.created_at.toISOString(),m.expect.at,m.id+' time');
      const i=(await imports(A)).pop();eq([i.transaction_id,i.provider,i.rule,i.reference],[t.id,m.expect.provider,m.expect.rule,m.expect.reference||null],m.id);
      const d=m.expect.type==='income'?m.expect.amount:-m.expect.amount;if(m.issuer==='nbe')bank+=d;else vf+=d}
    const b1=await bal(Ahmed,A),r2=x=>Math.round(x*100)/100;eq([r2(b1['Bank account']-b0['Bank account']),r2(b1['Personal cash']-b0['Personal cash']),b1['Household cash']],[r2(bank),r2(vf),b0['Household cash']]);eq([r2(bank),r2(vf)],[-1194,-131.2]);
    eq([await count(A),(await imports(A)).length,sent.length],[n+10,ni+10,10],'ten transactions, ten notifications - the 0 fee created nothing');
    const dump=JSON.stringify([(await imports(A)).map(i=>[i.provider,i.kind,i.rule,i.reference]),(await txs(A)).map(t=>[t.type,t.amount,t.category,t.note])]);   /* stored text only: timestamps / ids contain digit runs by chance */for(const x of ['01064773881','01095872700','مصاريف','كاش باك','المتاح','19623','23.35','3.93'])ok(!dump.includes(x),'"'+x+'" must not be stored');
    const words=JSON.stringify((await txs(A)).slice(-10).map(t=>[t.category,t.note]));ok(!/2521|0170|01\d{9}/.test(words),'no card / account / phone number in any description')});
  await test('repeated copies of the new messages (once, ten at once, other spacing) → already_imported; nothing new, no notification',async()=>{
    const n=await count(A);sent.length=0;
    for(const m of R2){const k=m.issuer==='nbe'?kA:kVF;const f=await postReal(k,m);eq([f.http,f.ok,f.status],[200,true,'already_imported'],m.id);
      eq((await Promise.all(Array.from({length:10},()=>postReal(k,m)))).map(x=>x.status),Array(10).fill('already_imported'),m.id+' x10');eq((await postReal(k,{...m,text:' '+m.text.replace(/ +/g,'   ')+'\n'})).status,'already_imported',m.id+' spacing')}
    eq((await postReal(kVF,{...R.real2_vfcash_out,text:R.real2_vfcash_out.text.replace(/ ?حول فلوس[^]*$/,'')})).status,'already_imported','same operation number without the advert');
    eq((await postReal(kA,{...R.real2_card_wekalet_182,text:R.real2_card_wekalet_182.text.replace('الساعه','الساعة')})).status,'imported','(a card SMS has no reference: a different spelling is a different text - documented limit)');
    eq([await count(A),sent.length],[n+1,1])});
  await test('two purchases at the same merchant on the same day (182 and 20) are two transactions; altered / fee-carrying messages create nothing',async()=>{
    const t=(await txs(A)).filter(x=>x.category==='WEKALET ELMANSOURA').map(x=>x.amount).sort((a,b)=>a-b);eq(t,[20,182,182]);const n=await count(A);
    eq(await postReal(kVF,{...R.real2_vfcash_out,text:R.real2_vfcash_out.text.replace('مصاريف الخدمة 0 جنيه','مصاريف الخدمة 1 جنيه').replace('024986273684','024986273999')}),{http:422,ok:false,status:'unrecognized_sms',reason:'fee_not_verified'});
    eq((await postReal(kVF,{...R.real2_vfcash_out,text:R.real2_vfcash_out.text.replace('105 جنيه ','')})).status,'unrecognized_sms');eq((await postReal(kVF,{...R.real2_vfcash_out,text:R.real2_vfcash_out.text+' '+R.real2_vfcash_recharge_5.text})).status,'unrecognized_sms');
    eq((await postReal(kA,{...R.real2_card_zainy_800,text:R.real2_card_zainy_800.text.replace('تم خصم 800 EGP','تم خصم')})).status,'unrecognized_sms');eq((await postReal(kA,{sender:'BanK-AIAhly',text:R.real2_vfcash_out.text})).status,'unrecognized_sms');eq(await count(A),n)});

  console.log('\nInternal transfers between household wallets: suggest, confirm, undo');
  // real message formats, only amount / reference / time vary.  day = day of November 2026, t = "HH:MM" (Cairo)
  const ipOut=(amt,ref,day,t)=>`تم تنفيذ تحويل لحظي من حسابكم رقم 0170 بمبلغ ${amt} جم إلى MONA A**** رقم مرجعي ${ref} يوم 11-${day} الساعة ${t} للمزيد اتصل بـ 19623`;
  const ipIn=(amt,ref,day,t)=>`تم إضافة تحويل لحظي لحسابكم رقم 0170 بمبلغ ${amt} جم من AHMED TEST رقم مرجعي ${ref} يوم 11-${day} الساعة ${t} للمزيد اتصل بـ 19623`;
  const vfIn=(amt,ref,day,t)=>`تم استلام مبلغ ${amt} جنيه من 01095872700؛\nالمسجل بإسم AHMED TEST\nعلى رقم محفظتك 01095872700 بتاريخ ${t} 26-11-${day}.\nرصيدك الحالي: 6.93 جنيه\nرقم العملية: ${ref}\nتقدر تتابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash`;
  const vfOut=(amt,ref,day,t)=>`تم تحويل ${amt} جنيه لرقم 01064773881 مصاريف الخدمة 0 جنيه رصيد حسابك فى فودافون كاش الحالي 3.93.\nتاريخ العملية ${t} 26-11-${day} :\nرقم العملية ${ref} :\nحول فلوس لأي محفظة وزود فرصك تكسب جنيه دهب! وكمان هيجيلك لحد 100ج كاش باك. http://vf.eg/vfcash?id=money_transfer`;
  let kMV;const SND={nbe:'BanK-AIAhly',vf:'VF-Cash'};
  const Zed=await user('Zaki');await as(Zed,'select join_household($1)',[(await one(Ahmed,'select invite_code c from households where id=$1',[A])).c]);   // a third member, never involved
  // -> the import record of the entry that was created
  const put=async(key,sender,text)=>{const r=await postReal(key,{sender,text});if(r.status!=='imported')throw new Error('import: '+JSON.stringify(r));
    const i=(await admin.query('select * from bank_imports where transaction_id=$1',[r.transaction_id])).rows[0];return{imp:i.id,tx:r.transaction_id,fp:i.fingerprint,text,key,sender}};
  const rpcAs=(u,sql,params)=>db.conn().then(c=>db.as(u,sql,params,c).finally(()=>c.end())).then(x=>x.rows[0].r);        // own connection: really concurrent
  const cands=async u=>(await one(u,'select bank_transfer_candidates($1) r',[A])).r;
  const sugg=async(u,o,i)=>(await cands(u)).candidates.filter(c=>c.out_import===o.imp&&c.in_import===i.imp);
  const anyFor=async x=>(await cands(Ahmed)).candidates.filter(c=>c.out_import===x.imp||c.in_import===x.imp).length;
  const confirm=(u,o,i)=>one(u,'select bank_transfer_confirm($1,$2) r',[o.imp,i.imp]).then(x=>x.r);
  const undo=(u,m)=>one(u,'select bank_transfer_undo($1) r',[m]).then(x=>x.r);
  const row=async id=>(await admin.query('select to_jsonb(t) j from transactions t where id=$1',[id])).rows[0]?.j||null;
  const stats=async day=>{const s=(await one(Ahmed,'select range_stats($1,$2,$2) s',[A,'2026-11-'+day])).s;return[+s.income,+s.expenses]};
  const total=async()=>+(await one(Ahmed,'select household_summary($1) s',[A])).s.balance;
  const audits=async id=>(await admin.query('select action,actor,old_row from audit_log where tx_id=$1 order by id',[id])).rows;
  const nImp=async()=>(await imports(A)).length;
  let P1,M1;                                                                  // the pair / merge the following tests share

  await test('suggestion: outgoing from one wallet + incoming on another, same amount, 3 minutes apart (incoming stamped EARLIER, other provider, other reference) → suggested, nothing changed; one side alone → nothing',async()=>{
    kMV=(await newKey(Mona,'VF-Cash',WA['Household cash'],WA['Personal cash'])).key;
    const n0=await count(A);const o=await put(kA,SND.nbe,ipOut('500.00','710000000001','05','10:03'));eq(await anyFor(o),0,'only the outgoing side exists: no suggestion');
    eq((await row(o.tx)).type,'expense','a transfer whose other side is unknown stays an expense (transfer to someone outside)');
    const i=await put(kMV,SND.vf,vfIn('500.00','720000000001','05','10:00'));P1={o,i};
    const c=await sugg(Ahmed,o,i);eq(c.length,1);eq([c[0].amount,c[0].from_wallet,c[0].to_wallet,c[0].from_member,c[0].to_member,c[0].can_decide,c[0].out_transaction_id,c[0].in_transaction_id],[500,'Bank account','Household cash','Ahmed','Mona',true,o.tx,i.tx]);
    eq((await sugg(Mona,o,i))[0].can_decide,true,'the receiving member may decide');eq((await sugg(Zed,o,i))[0].can_decide,false,'a member who is not involved sees it but cannot decide');
    eq([await count(A),(await row(o.tx)).type,(await row(i.tx)).type],[n0+2,'expense','income'],'suggesting changes nothing');
    eq((await cands(Bob)).candidates.length+(await cands(Bob)).merged.length,0,'another household sees nothing');eq((await one(Bob,'select bank_transfer_candidates($1) r',[B])).r.candidates,[])});
  await test('no suggestion: amounts differ by 0.01; 16 minutes apart; same wallet; a card purchase or recharge with the same amount; exactly 15 minutes IS inside',async()=>{
    let o=await put(kA,SND.nbe,ipOut('61.00','710000000010','04','09:00')),i=await put(kMV,SND.vf,vfIn('61.01','720000000010','04','09:00'));eq([await anyFor(o),await anyFor(i)],[0,0],'amount');
    o=await put(kA,SND.nbe,ipOut('62.00','710000000011','04','11:00'));i=await put(kMV,SND.vf,vfIn('62.00','720000000011','04','11:16'));eq([await anyFor(o),await anyFor(i)],[0,0],'16 minutes');
    o=await put(kA,SND.nbe,ipOut('63.00','710000000012','04','13:00'));i=await put(kMona,SND.nbe,ipIn('63.00','710000000013','04','13:01'));eq([await anyFor(o),await anyFor(i)],[0,0],'both keys point at the same wallet');
    const card=await put(kA,SND.nbe,R.real2_card_wekalet_182.text.replace('182 EGP','64 EGP').replace('09/11/26','04/11/26').replace('15:23','15:00'));i=await put(kMV,SND.vf,vfIn('64.00','720000000014','04','15:00'));eq(await anyFor(i),0,'a card purchase is not a transfer');
    o=await put(kA,SND.nbe,ipOut('65.00','710000000015','04','17:00'));i=await put(kMV,SND.vf,vfIn('65.00','720000000015','04','17:15'));eq((await sugg(Ahmed,o,i)).length,1,'15 minutes');
    const o2=await put(kA,SND.nbe,ipOut('66.00','710000000016','04','19:15')),i2=await put(kMV,SND.vf,vfIn('66.00','720000000016','04','19:00'));eq((await sugg(Ahmed,o2,i2)).length,1,'15 minutes, incoming first');
    eq((await one(Ahmed,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp])).r.status,'dismissed');eq((await one(Ahmed,'select bank_transfer_dismiss($1,$2) r',[o2.imp,i2.imp])).r.status,'dismissed')});
  await test('ambiguous → no suggestion and confirm refuses: one outgoing with two possible incoming; two outgoing with one incoming; only amounts match',async()=>{
    const o=await put(kA,SND.nbe,ipOut('250.00','710000000020','06','10:00')),i1=await put(kMV,SND.vf,vfIn('250.00','720000000020','06','10:02'));eq((await sugg(Ahmed,o,i1)).length,1,'unique so far');
    const i2=await put(kVF,SND.vf,vfIn('250.00','720000000021','06','10:05'));eq([await anyFor(o),await anyFor(i1),await anyFor(i2)],[0,0,0],'a second possible incoming appeared');
    const n=await count(A);eq(await confirm(Ahmed,o,i1),{status:'not_eligible',reason:'conditions_not_met'});eq(await confirm(Ahmed,o,i2),{status:'not_eligible',reason:'conditions_not_met'});eq(await count(A),n);
    const oa=await put(kA,SND.nbe,ipOut('260.00','710000000022','06','12:00')),ob=await put(kVF,SND.vf,vfOut('260','720000000022','06','12:04')),ic=await put(kMV,SND.vf,vfIn('260.00','720000000023','06','12:02'));
    eq([await anyFor(oa),await anyFor(ob),await anyFor(ic)],[0,0,0],'two possible outgoing');
    const far=await put(kA,SND.nbe,ipOut('270.00','710000000024','06','14:00')),far2=await put(kMV,SND.vf,vfIn('270.00','720000000024','07','14:00'));eq([await anyFor(far),await anyFor(far2)],[0,0],'same amount a day apart is not a match')});
  await test('edited or deleted entries are never suggested and cannot be confirmed',async()=>{
    const o=await put(kA,SND.nbe,ipOut('320.00','710000000030','07','10:00')),i=await put(kMV,SND.vf,vfIn('320.00','720000000030','07','10:01'));eq((await sugg(Ahmed,o,i)).length,1);
    await as(Ahmed,"update transactions set note=note||' x' where id=$1",[o.tx]);eq(await anyFor(o),0,'edited (even only the note)');eq(await confirm(Ahmed,o,i),{status:'not_eligible',reason:'conditions_not_met'});
    const o2=await put(kA,SND.nbe,ipOut('330.00','710000000031','07','12:00')),i2=await put(kMV,SND.vf,vfIn('330.00','720000000031','07','12:01'));eq((await sugg(Ahmed,o2,i2)).length,1);
    await as(Mona,'delete from transactions where id=$1',[i2.tx]);eq(await anyFor(o2),0,'the other side was deleted');eq(await confirm(Ahmed,o2,i2),{status:'not_eligible',reason:'conditions_not_met'});
    eq((await postReal(i2.key,i2)).status,'already_imported','a deleted import still is not imported twice')});
  await test('who may decide: an uninvolved member cannot confirm; another household gets not_found; the tables and internal functions are closed; the creator rule still holds outside a merge',async()=>{
    const {o,i}=P1,n=await count(A);
    await throws(()=>confirm(Zed,o,i),/only the two members involved or the household owner/);eq(await confirm(Bob,o,i),{status:'not_found'});
    eq((await one(Bob,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp])).r,{status:'not_found'});eq(await confirm(Ahmed,i,o),{status:'not_eligible',reason:'conditions_not_met'},'sides swapped');
    eq(await confirm(Ahmed,{imp:sub(999)},i),{status:'not_found'});
    await throws(()=>as(Mona,"insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id) values($1,$2,$3,'dismissed',$4,$5)",[A,o.imp,i.imp,o.tx,i.tx]),/permission denied/);
    await throws(()=>as(Mona,'update bank_imports set transaction_id=null where id=$1',[o.imp]),/permission denied/);
    await throws(()=>as(Mona,'select * from bank_transfer_pairs($1)',[A]),/permission denied/);await throws(()=>as(Mona,'select * from bank_transfer_eligible($1)',[A]),/permission denied/);
    await throws(()=>as(Mona,INS,[A,Ahmed,WA['Household cash'],null,'income',1,'Fake','']),/cannot create a transaction for another user/);
    eq([await count(A),(await sugg(Ahmed,o,i)).length],[n,1],'nothing changed')});
  await test('confirm (by the receiving member): the two entries become ONE transfer Bank account → Household cash; balances identical; no longer income / expense; import records kept; no notification',async()=>{
    const {o,i}=P1,b0=await bal(Ahmed,A),n0=await count(A),ni=await nImp(),s0=await stats('05'),t0=await total(),ro=await row(o.tx),ri=await row(i.tx);sent.length=0;
    const r=await confirm(Mona,o,i);eq(r.status,'merged');ok(r.merge_id&&r.transaction_id);M1={id:r.merge_id,tx:r.transaction_id,ro,ri};
    eq([await row(o.tx),await row(i.tx),await count(A)],[null,null,n0-1],'the two originals are replaced by one entry');
    const t=await row(r.transaction_id);eq([t.type,t.wallet_id,t.to_wallet_id,+t.amount,t.user_id,t.household_id,t.category,t.note,t.created_at],['transfer',WA['Bank account'],WA['Household cash'],500,Ahmed,A,'Transfer','Bank SMS · internal transfer · ref 710000000001 · ref 720000000001',ro.created_at]);
    eq(await bal(Ahmed,A),b0,'every wallet balance is exactly what it was');eq(await total(),t0,'household total unchanged');
    eq(await stats('05'),[s0[0]-500,s0[1]-500],'the 500 no longer counts as income nor as expense');
    const im=(await admin.query('select id,fingerprint,transaction_id from bank_imports where id=any($1) order by id',[[o.imp,i.imp]])).rows;eq(await nImp(),ni,'no import record added or removed');
    eq(im.map(x=>[x.id,x.fingerprint,x.transaction_id]).sort(),[[o.imp,o.fp,t.id],[i.imp,i.fp,t.id]].sort(),'same import ids and fingerprints, now pointing at the transfer');
    const m=(await admin.query('select * from bank_transfer_merges where id=$1',[r.merge_id])).rows[0];
    eq([m.status,m.out_import_id,m.in_import_id,m.out_tx_id,m.in_tx_id,m.transfer_tx_id,m.decided_by,m.household_id],['confirmed',o.imp,i.imp,o.tx,i.tx,t.id,Mona,A]);ok(m.decided_at instanceof Date);
    eq([m.snapshot.out,m.snapshot.in,m.snapshot.out_import,m.snapshot.in_import],[ro,ri,{id:o.imp,fingerprint:o.fp},{id:i.imp,fingerprint:i.fp}],'the snapshot holds both original rows completely');
    const ob=await outbox(t.id);eq([ob.status,ob.recipients,ob.attempts],['skipped',null,0],'the transfer is never announced');
    const other=await put(kA,SND.nbe,ipOut('1.00','710000000040','08','08:00'));eq([sent.length,(await outbox(other.tx)).status,(await outbox(t.id)).status],[1,'sent','skipped'],'a later run of the notification pipeline sends only the unrelated new entry');
    eq((await cands(Ahmed)).merged.filter(x=>x.id===r.merge_id).map(x=>[x.amount,x.from_wallet,x.to_wallet,x.decided_by,x.can_undo,x.transaction_id]),[[500,'Bank account','Household cash','Mona',true,t.id]]);eq((await sugg(Ahmed,o,i)).length,0)});
  await test('audit history after the merge: one DELETE record per original entry (who merged, the full old row); earlier history of those entries is untouched',async()=>{
    const a=await audits(P1.o.tx),b=await audits(P1.i.tx);eq([a.map(x=>[x.action,x.actor]),b.map(x=>[x.action,x.actor])],[[['DELETE',Mona]],[['DELETE',Mona]]]);
    eq([a[0].old_row,b[0].old_row],[M1.ro,M1.ri]);eq(await audits(M1.tx),[],'the new transfer has no change history yet')});
  await test('idempotent: confirming the merged pair again (same or other member, ten at once) returns the SAME merge; importing either SMS again → already_imported pointing at the transfer',async()=>{
    const {o,i}=P1,n=await count(A),nm=+(await admin.query('select count(*) n from bank_transfer_merges')).rows[0].n;
    const want={status:'already_merged',merge_id:M1.id,transaction_id:M1.tx};eq(await confirm(Mona,o,i),want);eq(await confirm(Ahmed,o,i),want);
    eq(await Promise.all(Array.from({length:10},(_,k)=>rpcAs(k%2?Ahmed:Mona,'select bank_transfer_confirm($1,$2) r',[o.imp,i.imp]))),Array(10).fill(want));
    for(const x of [o,i]){const r=await postReal(x.key,x);eq([r.status,r.transaction_id],['already_imported',M1.tx]);eq((await Promise.all(Array.from({length:5},()=>postReal(x.key,x)))).map(y=>y.status),Array(5).fill('already_imported'))}
    eq([await count(A),+(await admin.query('select count(*) n from bank_transfer_merges')).rows[0].n],[n,nm])});
  await test('race: ten members confirm a NEW pair at the same moment → exactly one merge, one transfer; database rules: an import can be in one confirmed merge only, one decision per pair',async()=>{
    const o=await put(kA,SND.nbe,ipOut('410.00','710000000050','08','10:00')),i=await put(kMV,SND.vf,vfIn('410.00','720000000050','08','10:01')),n=await count(A),b=await bal(Ahmed,A);
    const rs=await Promise.all(Array.from({length:10},(_,k)=>rpcAs(k%2?Ahmed:Mona,'select bank_transfer_confirm($1,$2) r',[o.imp,i.imp])));
    eq(rs.map(x=>x.status).sort(),['merged',...Array(9).fill('already_merged')].sort());eq(new Set(rs.map(x=>x.transaction_id)).size,1);eq(new Set(rs.map(x=>x.merge_id)).size,1);
    eq([await count(A),await bal(Ahmed,A)],[n-1,b]);eq(+(await admin.query("select count(*) n from transactions where type='transfer' and note like '%710000000050%'")).rows[0].n,1);
    const x=await put(kVF,SND.vf,vfIn('411.00','720000000051','08','11:00'));
    await throws(()=>admin.query("insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id,transfer_tx_id,snapshot) values($1,$2,$3,'confirmed',$4,$4,$4,'{}')",[A,o.imp,x.imp,x.tx]),/bank_transfer_merges_out_confirmed/);
    await throws(()=>admin.query("insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id,transfer_tx_id,snapshot) values($1,$2,$3,'confirmed',$4,$4,$4,'{}')",[A,x.imp,i.imp,x.tx]),/bank_transfer_merges_in_confirmed/);
    await throws(()=>admin.query("insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id) values($1,$2,$3,'dismissed',$4,$4)",[A,o.imp,i.imp,x.tx]),/bank_transfer_merges_pair/);
    await throws(()=>admin.query("insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id) values($1,$2,$2,'dismissed',$3,$3)",[A,x.imp,x.tx]),/bank_transfer_merges_two_imports/);
    await throws(()=>admin.query("insert into bank_transfer_merges(household_id,out_import_id,in_import_id,status,out_tx_id,in_tx_id) values($1,$2,$3,'confirmed',$4,$4)",[A,x.imp,o.imp,x.tx]),/bank_transfer_merges_complete/)});
  await test('undo: the two ORIGINAL entries come back exactly (same ids, creator, wallet, type, amount, description, note, time, client id); balances and statistics as before the merge; no notification',async()=>{
    const {o,i}=P1,b0=await bal(Ahmed,A),n0=await count(A),ni=await nImp(),s0=await stats('05'),t0=await total();sent.length=0;
    await throws(()=>undo(Zed,M1.id),/only the two members involved or the household owner/);eq(await undo(Bob,M1.id),{status:'not_found'});eq(await count(A),n0);
    const r=await undo(Ahmed,M1.id);eq(r,{status:'undone',out_transaction_id:o.tx,in_transaction_id:i.tx});
    const ro=await row(o.tx),ri=await row(i.tx),strip=x=>{const{updated_at,...y}=x;return y};
    eq([strip(ro),strip(ri)],[strip(M1.ro),strip(M1.ri)],'every column except the "last changed" stamp is identical to the original row');ok(ro.updated_at>M1.ro.updated_at,'updated_at is new, so every device notices the change');
    eq([await row(M1.tx),await count(A)],[null,n0+1],'the transfer is gone, two entries are back');eq(await bal(Ahmed,A),b0);eq(await total(),t0);eq(await stats('05'),[s0[0]+500,s0[1]+500],'counted as income and expense again');
    const im=(await admin.query('select id,fingerprint,transaction_id from bank_imports where id=any($1)',[[o.imp,i.imp]])).rows;eq(await nImp(),ni,'no import record created or removed by the undo');
    eq(im.map(x=>[x.id,x.fingerprint,x.transaction_id]).sort(),[[o.imp,o.fp,o.tx],[i.imp,i.fp,i.tx]].sort(),'the same import records point at their original entries again');
    const m=(await admin.query('select * from bank_transfer_merges where id=$1',[M1.id])).rows[0];eq([m.status,m.undone_by,m.decided_by,m.out_tx_id,m.in_tx_id,m.transfer_tx_id],['undone',Ahmed,Mona,o.tx,i.tx,M1.tx]);ok(m.undone_at instanceof Date);
    eq([(await outbox(o.tx)).status,(await outbox(i.tx)).status],['skipped','skipped'],'the restored entries are not announced a second time');
    const other=await put(kA,SND.nbe,ipOut('1.00','710000000041','08','08:30'));eq([sent.length,(await outbox(other.tx)).status],[1,'sent'],'only the unrelated new entry is sent')});
  await test('audit history after the undo: merge = DELETE of each original (by Mona), undo = DELETE of the transfer (by Ahmed); the restored entries can be edited and audited normally',async()=>{
    eq((await audits(P1.o.tx)).map(x=>[x.action,x.actor]),[['DELETE',Mona]]);eq((await audits(P1.i.tx)).map(x=>[x.action,x.actor]),[['DELETE',Mona]]);
    const t=await audits(M1.tx);eq(t.map(x=>[x.action,x.actor,x.old_row.type,+x.old_row.amount]),[['DELETE',Ahmed,'transfer',500]]);
    const probe=await put(kA,SND.nbe,ipOut('2.00','710000000042','08','09:00'));await as(Ahmed,"update transactions set category='Edited' where id=$1",[probe.tx]);eq((await audits(probe.tx)).map(x=>x.action),['UPDATE'])});
  await test('after the undo: undo again (once, ten at once) → the same answer, nothing changes; both SMS still → already_imported (original entries); the pair is not suggested or mergeable again',async()=>{
    const {o,i}=P1,n=await count(A),ni=await nImp(),b=await bal(Ahmed,A),want={status:'already_undone',out_transaction_id:o.tx,in_transaction_id:i.tx};
    eq(await undo(Ahmed,M1.id),want);eq(await undo(Mona,M1.id),want);eq(await Promise.all(Array.from({length:10},(_,k)=>rpcAs(k%2?Ahmed:Mona,'select bank_transfer_undo($1) r',[M1.id]))),Array(10).fill(want));
    for(const x of [o,i]){const r=await postReal(x.key,x);eq([r.status,r.transaction_id],['already_imported',x.tx]);eq((await postReal(x.key,x,{dry_run:true})).status,'already_imported')}
    eq((await sugg(Ahmed,o,i)).length,0);eq(await confirm(Ahmed,o,i),{status:'not_eligible',reason:'declined_before'});eq((await one(Ahmed,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp])).r,{status:'already_dismissed'});
    eq([await count(A),await nImp(),await bal(Ahmed,A)],[n,ni,b]);eq((await cands(Ahmed)).merged.filter(x=>x.id===M1.id),[])});
  await test('race: ten undo requests at the same moment → exactly one restores, nine report already_undone; two entries, not twenty',async()=>{
    const o=await put(kVF,SND.vf,vfOut('430','720000000060','08','13:00')),i=await put(kMona,SND.nbe,ipIn('430.00','710000000060','08','13:02'));
    const m=await confirm(Mona,o,i);eq(m.status,'merged','Vodafone Cash → bank, the other direction');const n=await count(A),b=await bal(Ahmed,A);
    const rs=await Promise.all(Array.from({length:10},(_,k)=>rpcAs(k%2?Ahmed:Mona,'select bank_transfer_undo($1) r',[m.merge_id])));
    eq(rs.map(x=>x.status).sort(),['undone',...Array(9).fill('already_undone')].sort());eq([await count(A),await bal(Ahmed,A)],[n+1,b]);
    eq([(await row(o.tx)).type,(await row(i.tx)).type,(await row(o.tx)).wallet_id,(await row(i.tx)).wallet_id],['expense','income',WA['Personal cash'],WA['Bank account']])});
  await test('undo is refused when the merged transfer was edited or deleted meanwhile (the books no longer contain the two originals); import protection stays',async()=>{
    let o=await put(kA,SND.nbe,ipOut('440.00','710000000070','08','15:00')),i=await put(kMV,SND.vf,vfIn('440.00','720000000070','08','15:01')),m=await confirm(Ahmed,o,i);
    await as(Ahmed,'update transactions set amount=441 where id=$1',[m.transaction_id]);let n=await count(A);eq(await undo(Ahmed,m.merge_id),{status:'not_eligible',reason:'transfer_changed'});eq([await count(A),await row(o.tx)],[n,null]);
    o=await put(kA,SND.nbe,ipOut('450.00','710000000071','08','17:00'));i=await put(kMV,SND.vf,vfIn('450.00','720000000071','08','17:01'));m=await confirm(Ahmed,o,i);
    await as(Ahmed,'delete from transactions where id=$1',[m.transaction_id]);n=await count(A);eq(await undo(Ahmed,m.merge_id),{status:'not_eligible',reason:'transfer_deleted'});eq(await count(A),n);
    eq([(await postReal(o.key,o)).status,(await postReal(i.key,i)).status],['already_imported','already_imported']);eq(await confirm(Ahmed,o,i),{status:'already_merged',merge_id:m.merge_id,transaction_id:m.transaction_id})});
  await test('"Not a transfer": the suggestion disappears for everyone, both entries stay as they are, it is not offered again',async()=>{
    const o=await put(kA,SND.nbe,ipOut('460.00','710000000080','08','19:00')),i=await put(kMV,SND.vf,vfIn('460.00','720000000080','08','19:01')),n=await count(A),ro=await row(o.tx),ri=await row(i.tx);
    await throws(()=>one(Zed,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp]),/only the two members involved/);
    eq((await one(Mona,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp])).r,{status:'dismissed'});eq((await one(Ahmed,'select bank_transfer_dismiss($1,$2) r',[o.imp,i.imp])).r,{status:'already_dismissed'});
    eq([(await sugg(Ahmed,o,i)).length,(await sugg(Mona,o,i)).length,await count(A),await row(o.tx),await row(i.tx)],[0,0,n,ro,ri]);eq(await confirm(Ahmed,o,i),{status:'not_eligible',reason:'declined_before'})});
  await test('one member, two own wallets (bank → own Vodafone Cash): suggested and merged the same way; only that member or the owner decides',async()=>{
    const o=await put(kMona,SND.nbe,ipOut('470.00','710000000090','08','21:00')),i=await put(kMV,SND.vf,vfIn('470.00','720000000090','08','20:58'));
    const c=await sugg(Zed,o,i);eq([c.length,c[0].from_member,c[0].to_member,c[0].from_wallet,c[0].to_wallet,c[0].can_decide],[1,'Mona','Mona','Bank account','Household cash',false]);
    await throws(()=>confirm(Zed,o,i),/only the two members involved/);const b=await bal(Ahmed,A);const r=await confirm(Mona,o,i);eq(r.status,'merged');
    const t=await row(r.transaction_id);eq([t.type,t.user_id,t.wallet_id,t.to_wallet_id],['transfer',Mona,WA['Bank account'],WA['Household cash']]);eq(await bal(Ahmed,A),b)});
  await test('negative wallet: a pair whose outgoing side overdrew the wallet can be merged and undone - balances identical each time; manual spending from that wallet stays refused',async()=>{
    const have=(await bal(Ahmed,A))['Bank account'];const big=(Math.floor(have)+700)+'.00';
    const o=await put(kA,SND.nbe,ipOut(big,'710000000095','11','10:00')),i=await put(kMV,SND.vf,vfIn(big,'720000000095','11','10:01'));const b=await bal(Ahmed,A);ok(b['Bank account']<0,'the import overdrew the wallet');
    const r=await confirm(Ahmed,o,i);eq(r.status,'merged');eq(await bal(Ahmed,A),b,'merge: balances identical, still negative');
    await throws(()=>as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',1,'Manual','']),/Insufficient funds/);await throws(()=>as(Mona,INS,[A,Mona,WA['Bank account'],WA['Personal cash'],'transfer',1,'Move','']),/Insufficient funds/);
    eq((await undo(Ahmed,r.merge_id)).status,'undone');eq(await bal(Ahmed,A),b,'undo: balances identical');await throws(()=>as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'expense',1,'Manual','']),/Insufficient funds/);
    eq((await admin.query("select current_setting('app.bypass_balance',true) a,current_setting('app.bank_transfer_merge',true) b")).rows[0],{a:'',b:''},'no switch outlives its operation');
    await as(Ahmed,INS,[A,Ahmed,WA['Bank account'],null,'income',-b['Bank account']+1000,'Add income',''])});
  await test('an import arriving while a confirmation is in progress waits for it; unrelated manual entries are not blocked by suggestions',async()=>{
    const o=await put(kA,SND.nbe,ipOut('480.00','710000000097','11','12:00')),i=await put(kMV,SND.vf,vfIn('480.00','720000000097','11','12:01'));
    const [m,late]=await Promise.all([rpcAs(Ahmed,'select bank_transfer_confirm($1,$2) r',[o.imp,i.imp]),postReal(kVF,{sender:SND.vf,text:vfIn('480.00','720000000098','11','12:03')})]);
    ok(late.status==='imported'&&(m.status==='merged'||m.status==='not_eligible'),JSON.stringify([m,late]));
    const tr=+(await admin.query("select count(*) n from transactions where type='transfer' and note like '%710000000097%'")).rows[0].n;eq(tr,m.status==='merged'?1:0,'either merged before the rival arrived, or refused as ambiguous - never half');
    eq((await as(Mona,INS,[A,Mona,WA['Household cash'],null,'expense',1,'Tea',''])).rows.length,1)});

  console.log('\nLogging and clean-up');
  await test('logs: outcome, rule, reason and hashed identifiers only - never the SMS text, a name, a key or the service key',async()=>{
    const all=logs.join('\n');ok(logs.length>40,'something was logged');
    for(const s of ['CARREFOUR','Mansoura','عبير','حسنين','01095872700','456611434599','025712695852','MOHAMED','ahmed@instapay','SEOUDI','Available balance','card ending',kA,kB,kMona,'service-secret','os_v2_app_testkey','123456789012'])ok(!all.includes(s),'log leaks: '+s.slice(0,12));
    ok(/"status":"imported".*"rule":"nbe\.card_purchase\.en"/.test(all)&&/"status":"already_imported"/.test(all)&&/"status":"unrecognized_sms","reason":"no_rule_matched"/.test(all)&&/"status":"unauthorized","reason":"missing_key"/.test(all))});
  await test('responses never contain keys, hashes, user ids or internal errors',async()=>{
    const r=await imp(kA,'Refund of EGP 2.00 from KIOSK to your card ending 1234 on '+YD.txt+'. Ref 20002000');const s=JSON.stringify(r);
    ok(!s.includes(Ahmed)&&!s.includes(kA)&&!/key_hash|fingerprint|sms_hash|user_id/.test(s),s);
    const bad=await quiet(async()=>{const x=await handle(new Request('https://x/f',{method:'POST',headers:{Authorization:'Bearer '+kA},body:'{}'}),{SUPABASE_URL:'https://proj.supabase.co'},fakeFetch);return{http:x.status,...(await x.json())}});eq(bad,{http:500,ok:false,status:'error'})});
  await test('account deletion and household deletion still work with keys and import records present',async()=>{
    const Sam=await user('Sam'),S=(await one(Sam,"select create_household('Home S') h")).h;const sw=(await admin.query("select id from wallets where household_id=$1 and name='Bank account'",[S])).rows[0].id;
    await as(Sam,INS,[S,Sam,sw,null,'income',500,'Add income','']);const k=(await newKey(Sam)).key;eq((await imp(k,'transfer_ar')).status,'imported');
    await as(Sam,"select delete_my_account('DELETE')");eq((await admin.query('select (select count(*) from bank_import_keys where household_id=$1)::int k,(select count(*) from bank_imports where household_id=$1)::int i,(select count(*) from households where id=$1)::int h',[S])).rows[0],{k:0,i:0,h:0});
    eq(await imp(k,'transfer_ar'),{http:401,ok:false,status:'unauthorized'});
    await as(Mona,"select delete_my_account('DELETE')");eq(await imp(kMona,'card_en'),{http:401,ok:false,status:'unauthorized'});
    eq(+(await admin.query('select count(*) n from bank_imports where household_id=$1 and transaction_id=$2',[A,cardTx])).rows[0].n,1,'the household\'s records stay')});
}catch(e){console.log=_log;console.error=_err;console.log('FATAL',e);process.exitCode=1}
finally{await db.stop()}
done('bank import');
