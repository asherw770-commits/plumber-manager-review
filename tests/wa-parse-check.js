#!/usr/bin/env node
/* WhatsApp template parser regression lock (scan 5.10). ~220 real-world message shapes run through the REAL parseWaTemplate.
 * Cases listed in tests/wa-parse-known-gaps.json are KNOWN limitations (the parser leaves them to Asher's confirmation);
 * anything else failing is a regression. When a gap is fixed, delete its id from the json.
 *   node tests/wa-parse-check.js [--update]   (--update rewrites the known-gaps list from the current failures)
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const ctx = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
const L=(...a)=>a.join('\n');
const P = ctx.parseWaTemplate;
const base=(over={})=>{const o={cust:'שם לקוח: דוד כהן',addr:'כתובת: הרצל 12 ירושלים',phone:'טלפון: 050-123-4567',work:'סוג עבודה: סתימה',total:'סכום: 350',done:'בוצע',paid:'שולם: מזומן',...over};return Object.values(o).filter(x=>x!=null).join('\n');};
const cases=[];
const add=(id,cat,text,expect,note)=>cases.push({id,cat,text,expect,note});
// ---------- sanity ----------
add('S01','sanity',base(),{template:'mine',customer:'דוד כהן',phone:'0501234567',total:350,myShare:350,done:true,paid:true,paidMethod:'מזומן',work:'סתימה',address:'הרצל 12 ירושלים'});
add('S02','sanity',L('שם השותף: אהרן','סוג עבודה: ניקוז','עלות ללקוח: 9,500','מגיע לי: 1,500','בוצע','שולם: לא'),{template:'partner',partnerName:'אהרן',total:9500,myShare:1500,partnerAmount:8000,done:true,paid:false,whoseCustomer:'partner'});
add('S03','sanity',L('שם לקוח: משה פרץ','טלפון: 0521112222','סוג עבודה: ביוב','סכום כולל: 3000','שותף מבצע: שלומי','מגיע לשותף: 2000','בוצע','שולם: לא'),{template:'mine-with-partner',partnerName:'שלומי',total:3000,myShare:1000,partnerAmount:2000});
// ---------- amount formats ----------
const A=(id,v,exp,note)=>add(id,'amount',base({total:'סכום: '+v}),{total:exp},note);
A('A01','1,500',1500);A('A02','1500₪',1500);A('A03','1500 ש"ח',1500);A('A04','₪1,500',1500);
A('A05','1.500',1500,'dot thousands');A('A06','1500.50',1500.5);A('A07','2 אלף',2000,'אלף');A('A08','אלף',1000,'אלף word');
A('A09','2k',2000,'k');A('A10','1.5 אלף',1500);A('A11','350+100',450,'sum');A('A12','1 500',1500,'space thousands');
A('A13','1,5',null,'ambiguous comma -> should not be 15');A('A14','כ-350',350);A('A15','350-400',null,'range ambiguous');
A('A16','350 או 400',null,'ambiguous');A('A17','350 + מע"מ',350);A('A18','\u0663\u0665\u0660',350,'arabic-indic digits');A('A19','שלוש מאות',300,'words');
A('A20','0',0,'zero');A('A21','-',null);A('A22','?',null);A('A23','350 ₪ (כולל חומרים)',350);A('A24','1,500,000',1500000);A('A25','350‏',350,'RLM after number');
A('A26','‏350',350,'RLM before number');A('A27','3 5 0',350,'spaces in number');A('A28','350 שקל',350);A('A29','12,500',12500);A('A30','1,500 שח + 200 חומרים',1500);
A('A31','תלוי',null);A('A32','לא ידוע',null);A('A33','0501234567',null,'phone typed in amount');A('A34','3,5',null,'3,5 ambiguous');A('A35','1,250.75',1250.75);
// ---------- label formats ----------
const LB=(id,label,exp,note)=>add(id,'label',L(label.cust,'כתובת: הרצל 12','טלפון: 050-123-4567',label.work,label.total,'בוצע','שולם: מזומן'),exp,note);
const mk=(c,w,t)=>({cust:c,work:w,total:t});
LB('L01',mk('*שם לקוח:* דוד כהן','*סוג עבודה:* סתימה','*סכום:* 350'),{customer:'דוד כהן',work:'סתימה',total:350},'WhatsApp bold');
LB('L02',mk('- שם לקוח: דוד כהן','- סוג עבודה: סתימה','- סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'bullets');
LB('L03',mk('• שם לקוח: דוד כהן','• סוג עבודה: סתימה','• סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'bullets');
LB('L04',mk('👤 שם לקוח: דוד כהן','🔧 סוג עבודה: סתימה','💰 סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'emoji prefix');
LB('L05',mk('‏שם לקוח: דוד כהן','‏סוג עבודה: סתימה','‏סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'RLM line start');
LB('L06',mk('‎שם לקוח: דוד כהן','‎סוג עבודה: סתימה','‎סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'LRM line start');
LB('L07',mk('‫שם לקוח: דוד כהן‬','‫סוג עבודה: סתימה‬','‫סכום: 350‬'),{customer:'דוד כהן',work:'סתימה',total:350},'RLE/PDF');
LB('L08',mk('שם לקוח - דוד כהן','סוג עבודה - סתימה','סכום - 350'),{customer:'דוד כהן',work:'סתימה',total:350},'dash instead of colon');
LB('L09',mk('שם לקוח דוד כהן','סוג עבודה סתימה','סכום 350'),{customer:'דוד כהן',work:'סתימה',total:350},'no colon');
LB('L10',mk('שם הלקוח: דוד כהן','סוג העבודה: סתימה','סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350});
LB('L11',mk('לקוח: דוד כהן','עבודה: סתימה','סה"כ: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'short labels (older doc template)');
LB('L12',mk('שם לקוח : דוד כהן','סוג עבודה : סתימה','סכום : 350'),{customer:'דוד כהן',work:'סתימה',total:350},'space before colon');
LB('L13',mk('שם לקוח:דוד כהן','סוג עבודה:סתימה','סכום:350'),{customer:'דוד כהן',work:'סתימה',total:350});
LB('L14',mk('שם לקוח: דוד  כהן','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'double space in name');
LB('L15',mk('שם לקוח: דוד כהן‏','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'trailing RLM in customer name');
LB('L16',mk('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן',work:'סתימה',total:350},'NBSP in name');
LB('L17',mk('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום ששולם: 200'),{customer:'דוד כהן',work:'סתימה',total:null},'label "סכום ששולם" is not the job total');
LB('L18',mk('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום חומרים: 80'),{customer:'דוד כהן',work:'סתימה',total:null},'label "סכום חומרים"');
LB('L19',mk('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום לפני מע"מ: 350'),{total:350});
LB('L20',mk('שם לקוח: דוד כהן​','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן'},'ZWSP in name');
LB('L21',mk('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן'},'control');
LB('L22',mk('שם לקוח: ‎דוד כהן','סוג עבודה: סתימה','סכום: 350'),{customer:'דוד כהן'},'LRM at start of value');
// ---------- phone ----------
const PH=(id,v,exp,note)=>add(id,'phone',base({phone:'טלפון: '+v}),{phone:exp},note);
PH('P01','+972-50-123-4567','0501234567','normalised?');
PH('P02','972501234567','0501234567');
PH('P03','050 123 4567','0501234567');
PH('P04','050.123.4567','0501234567','dots');
PH('P05','050-1234567','0501234567');
PH('P06','‎050-123-4567','0501234567','LRM inside');
PH('P07','‎0501234567‎','0501234567');
PH('P08','050-123-456','', 'too short: must not guess');
PH('P09','05O1234567','','letter O');
PH('P10','0501234567 / 0527654321','0501234567','two phones');
PH('P11','02-5551234','025551234','landline');
PH('P12','(050) 123-4567','0501234567','parentheses');
PH('P13','050 12 34 567','0501234567','grouping 3-2-2-3');
PH('P14','050-12-34-567','0501234567','grouping');
PH('P15','+972 50 123 4567','0501234567');
PH('P16','אין','', 'no phone');
PH('P17','0501234567 (אשתו)','0501234567');
PH('P18','\u0660\u0665\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667','0501234567','arabic digits');
PH('P19','054-1234567','0541234567');
PH('P20','1-800-123-456','','1800 numbers');
add('P21','phone',base({phone:'טלפון: אין',notes:'הערות: השכן 052-7654321 יפתח'}),{phone:''},'neighbor phone in notes must not become customer phone');
add('P22','phone',base({phone:null,notes:'הערות: להתקשר לאשתו 052-7654321'}),{phone:''},'phone in notes only');
add('P23','phone',base({phone:'טלפון:'}),{phone:''},'blank phone');
add('P24','phone',L(base({phone:null}),'0501234567'),{phone:'0501234567'},'free line phone');
add('P25','phone',base({phone:'טלפון: +972501234567'}),{phone:'0501234567'},'+972 stored raw');
// ---------- done / paid ----------
const DN=(id,line,exp,note)=>add(id,'done',base({done:line}),exp,note);
DN('D01','בוצע',{done:true});DN('D02','בוצע /',{done:true});DN('D03','/ לביצוע',{done:false});
DN('D04','בוצע / לביצוע',{done:null},'both left = unknown');
DN('D05','בוצע בשעה 10:30',{done:true},'colon in time');
DN('D06','בוצע: כן',{done:true});DN('D07','בוצע: לא',{done:false});
DN('D08','לביצוע: מחר',{done:false});DN('D09','לביצוע: כשהלקוח יהיה מוכן',{done:false},'"מוכן" contains כן');
DN('D10','בוצע: לא סיימתי עדיין',{done:false},'לא סיימתי');
DN('D11','לביצוע: לא סיימתי, חוזר מחר',{done:false});
DN('D12','בוצע חלקית',{done:false},'partial');
DN('D13','בוצע 7.9',{done:true,doneDate:'2026-09-07'},'date of work');
DN('D14','בוצע אתמול',{done:true},'yesterday');
DN('D15','בוצע ✅',{done:true});
DN('D16','✅ בוצע',{done:true});
DN('D17','בוצע: אוטוטו',{done:false});
DN('D18','לביצוע: הסתיים',{done:false},'contradictory');
DN('D19','בוצע: טרם',{done:false});
DN('D20','לא בוצע',{done:false});
DN('D21','עדיין לא בוצע',{done:false});
DN('D22','בוצע בחלקו, ממשיכים מחר',{done:false});
DN('D23','לביצוע - צריך לקנות חלק, אכן',{done:false},'"אכן" contains כן');
const PD=(id,v,exp,note)=>add(id,'paid',base({paid:'שולם: '+v}),exp,note);
PD('Y01','כן',{paid:true});PD('Y02','לא',{paid:false});PD('Y03','מזומן',{paid:true,paidMethod:'מזומן'});
PD('Y04','ביט',{paid:true,paidMethod:'ביט'});PD('Y05','200',{paid:'partial',paidAmount:200});
PD('Y06','חלקי 200',{paid:'partial',paidAmount:200});PD('Y07','350',{paid:true},'full amount = paid in full, not partial');
PD('Y08','יעביר בביט מחר',{paid:false},'future promise');PD('Y09','ממתין להעברה',{paid:false},'waiting');
PD('Y10','עדיין לא, יעביר בהעברה',{paid:false});PD('Y11','לא שילם עדיין',{paid:false});
PD('Y12','✅',{paid:true});PD('Y13','וי',{paid:true});PD('Y14','V',{paid:true});
PD('Y15','אשראי',{paid:true,paidMethod:'אשראי'});PD('Y16','צ\'ק לשבוע הבא',{paid:false},'post-dated cheque');
PD('Y17','0',{paid:false},'zero');PD('Y18','-',{paid:null});PD('Y19','שולם חצי',{paid:'partial'},'half');
PD('Y20','ישלם במזומן',{paid:false},'will pay cash');PD('Y21','לא. הוא אמר שיעביר בביט',{paid:false});
PD('Y22','חלקי, 200 מתוך 350',{paid:'partial',paidAmount:200});PD('Y23','200 מזומן והשאר בביט',{paid:true},'two methods');
PD('Y24','בהעברה בנקאית',{paid:true,paidMethod:'העברה'});PD('Y25','כן (ביט)',{paid:true,paidMethod:'ביט'});
PD('Y26','שולם 350 מזומן',{paid:true});PD('Y27','אין',{paid:false});
add('Y28','paid',base({paid:'לא שולם'}),{paid:false},'fused negative');
add('Y29','paid',base({paid:'לא שולם - יעביר בביט'}),{paid:false});
add('Y30','paid',base({paid:'שולם'}),{paid:null},'bare label');
add('Y31','paid',base({paid:'שילם: כן'}),{paid:true},'שילם label variant');
add('Y32','paid',base({paid:'תשלום: מזומן'}),{paid:true},'תשלום label variant (older doc template)');
// ---------- hours ----------
const HR=(id,v,exp,note)=>add(id,'hours',base({hours:'זמן עבודה: '+v}),{hours:exp},note);
HR('H01','שעה',1);HR('H02','שעתיים',2);HR('H03','שעתיים וחצי',2.5);HR('H04','שעה ורבע',1.25);HR('H05','3 שעות',3);
HR('H06','3 שעות ו-30 דקות',3.5);HR('H07','45 דקות',0.75);HR('H08','1:30',1.5);HR('H09','1.30',1.5,'1.30 as h.mm');
HR('H10','10:00-12:00',2,'time range');HR('H11','09:00-11:30',2.5);HR('H12','שעה וחצי',1.5);HR('H13','חצי שעה',0.5);
HR('H14','כשעתיים',2);HR('H15','2.5',2.5);HR('H16','2,5',2.5);HR('H17','שלוש שעות',3);HR('H18','יום שלם',null,'full day');
HR('H19','שעה ו-20 דקות',1.33);HR('H20','90 דקות',1.5);
// ---------- partner ----------
add('R01','partner',L('שם לקוח: דוד','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: אין','מגיע לשותף: 0','בוצע'),{partnerName:'',template:'mine'},'no partner written as "אין"');
add('R02','partner',L('שם לקוח: דוד','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: -','מגיע לשותף: ','בוצע'),{partnerName:'',template:'mine'},'dash');
add('R03','partner',L('שם לקוח: דוד','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: אני','בוצע'),{partnerName:'',template:'mine'},'"אני"');
add('R04','partner',L('שם לקוח: דוד','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: אהרון','מגיע לשותף: 600','בוצע'),{partnerName:'אהרן'},'spelling variant');
add('R05','partner',L('שם השותף: אהרן','סוג עבודה: ניקוז','עלות ללקוח: 2000','בוצע'),{myShare:null,partnerAmount:0},'partner job, "מגיע לי" missing: my share must NOT silently = whole price');
add('R06','partner',L('שם השותף: אהרן','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי:','בוצע'),{myShare:null},'blank מגיע לי');
add('R07','partner',L('שם השותף: אהרן','סוג עבודה: ניקוז','עלות ללקוח: 300','מגיע לי: 400','בוצע'),{total:400},'myShare>total');
add('R08','partner',L('שם לקוח: דוד','טלפון: 0501112222','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: שלומי','מגיע לשותף:','בוצע'),{partnerAmount:null},'partner named, amount blank');
add('R09','partner',L('שם לקוח: דוד','טלפון: 0501112222','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: שלומי','מגיע לשותף: 1200','בוצע'),{myShare:null},'partner amount > total');
add('R10','partner',L('שם לקוח: דוד','טלפון: 0501112222','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע:','מגיע לשותף: 400','בוצע'),{partnerAmount:400,partnerName:'שלומי'},'amount without partner name');
add('R11','partner',L('שם השותף: כרומגן','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי: 500','בוצע'),{partnerName:'כרומגן',partnerAmount:1500});
add('R12','partner',L('שם השותף: של אהרן','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי: 500','בוצע'),{partnerName:'אהרן'});
add('R13','partner',L('שם השותף: אהרן','סוג עבודה: ניקוז','סכום: 2000','מגיע לי: 500','בוצע'),{template:'partner',total:2000,myShare:500},'partner with "סכום"');
add('R14','partner',L('שם השותף: אהרן','סוג עבודה: ניקוז','עלות ללקוח: 2,000 (כולל חומרים)','מגיע לי: 1,000','בוצע'),{partnerAmount:1000});
add('R15','partner',L('שם לקוח: דוד','טלפון: 0501112222','סוג עבודה: סתימה','סכום: 1000','מגיע לי: 400','בוצע'),{template:'partner'},'"מגיע לי" w/ customer & phone but no partner name');
add('R16','partner',L('שם השותף: אהרן ','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי: 500','בוצע'),{partnerName:'אהרן'},'trailing space');
add('R17','partner',L('שם השותף: אהרן (הצינור)','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי: 500','בוצע'),{partnerName:'אהרן'},'parenthetical');
add('R18','partner',L('שם השותף: אהרן + שלומי','סוג עבודה: ניקוז','עלות ללקוח: 2000','מגיע לי: 500','בוצע'),{partnerName:'אהרן'},'two partners');
add('R19','partner',L('שם לקוח: דוד','טלפון: 0501112222','סוג עבודה: סתימה','סכום כולל: 1000','שותף מבצע: שלומי','מגיע לשותף: 400','בוצע','שולם: כן'),{myShare:600,partnerAmount:400,paid:true});
// ---------- multi / structure ----------
add('M01','multi',L(base(),'','שם לקוח: משה לוי','טלפון: 0529998888','סוג עבודה: ברז','סכום: 200','בוצע','שולם: לא'),{__multi:true},'two jobs in one message');
add('M02','multi',L('סכום: 350','סכום: 400'),null,'two amounts only');
add('M03','multi',L('[12/09/2026, 14:32] יהודה: שם לקוח: דוד כהן','כתובת: הרצל 12','סוג עבודה: סתימה','סכום: 350','בוצע'),{customer:'דוד כהן'},'WA export header on first line');
add('M04','multi',L('יהודה קליין','שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע'),{customer:'דוד כהן'},'sender line noise');
add('M05','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה'),null,'only 2 labels -> not template');
add('M06','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350'),{done:null},'no done line');
add('M07','multi',L('ביטול! התעלמו מההודעה הקודמת','שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע'),null,'cancel + template');
add('M08','multi',L('תיקון','שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 400','בוצע'),{total:400},'correction message');
add('M09','multi',L('שם לקוח: דוד כהן','כתובת: הרצל 12','טלפון: 0501234567','סוג עבודה: סתימה','סכום: 350','סכום: 450','בוצע'),{total:450},'two סכום lines (second is correction?)');
add('M10','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: ','סכום: 350','בוצע'),{total:350},'blank first then value');
add('M11','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','הערות: נא לגבות במזומן','בוצע','שולם: לא'),{notes:'נא לגבות במזומן'});
add('M12','multi',L('שם לקוח: דוד כהן','כתובת: הרצל 12 ירושלים','סוג עבודה: סתימה','סכום: 350','בוצע','','לקוחה הדקל 7 דירה 23'),{address:'הרצל 12 ירושלים'},'second address in free line');
add('M13','multi',L('דוד כהן','הרצל 12','סוג עבודה: סתימה','סכום: 350','בוצע'),{customer:'דוד כהן'},'name without label');
add('M14','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','תזכורת להפיק חשבונית: כן'),{needsInvoice:true});
add('M15','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','חשבונית: לא צריך'),{needsInvoice:false});
add('M16','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','חשבונית: אין צורך'),{needsInvoice:false},'אין צורך');
add('M17','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','חשבונית: הופקה'),{needsInvoice:false},'invoice already issued');
add('M18','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','תזכורת להפיק חשבונית: ללא'),{needsInvoice:false},'ללא');
add('M19','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','תזכורת להפיק חשבונית: לא רלוונטי'),{needsInvoice:false},'לא רלוונטי');
add('M20','multi',L('שם לקוח: דוד כהן','סוג עבודה: סתימה','סכום: 350','בוצע','חשבונית: -'),{needsInvoice:false},'dash');
// emoji/odd chars in name/work
add('E01','misc',base({cust:'שם לקוח: דוד כהן 🙏'}),{customer:'דוד כהן'},'emoji in name');
add('E02','misc',base({cust:'שם לקוח: דוד כהן (חדש)'}),{customer:'דוד כהן'},'parenthetical in name');
add('E03','misc',base({cust:'שם לקוח: ד"ר כהן'}),{customer:'ד"ר כהן'},'gershayim');
add('E04','misc',base({cust:'שם לקוח: מסעדת הים'}),{customer:'מסעדת הים'});
add('E05','misc',base({cust:'שם לקוח: דוד: כהן'}),{customer:'דוד: כהן'},'colon inside value');
add('E06','misc',base({work:'סוג עבודה: סתימה: מטבח 10:30'}),{work:'סתימה: מטבח 10:30'},'colon in work');
add('E07','misc',base({addr:'כתובת: הרצל 12, דירה 4: קומה 2'}),{address:'הרצל 12, דירה 4: קומה 2'});
add('E08','misc',base({cust:'שם לקוח: דוד כהן',addr:'כתובת: הרצל 12 דירה 3'}),{address:'הרצל 12 דירה 3'});
add('E09','misc','שם לקוח: דוד כהן\r\nסוג עבודה: סתימה\r\nסכום: 350\r\nבוצע',{customer:'דוד כהן',total:350,done:true},'CRLF');
add('E10','misc','שם לקוח: דוד כהן סוג עבודה: סתימה סכום: 350 בוצע',{customer:'דוד כהן',total:350},'U+2028 line sep');
add('E11','misc','שם לקוח: דוד כהן סוג עבודה: סתימה סכום: 350',{customer:'דוד כהן',total:350},'U+2029');
add('E12','misc',base({total:'סכום: 350',notes:'הערות: דחוף!!!'}),{notes:'דחוף!!!'});
add('E13','misc',base({cust:'שם לקוח: ‏דוד כהן‏'}),{customer:'דוד כהן'},'RLM both sides name');
add('E14','misc',base({cust:'שם לקוח: דוד כהן‎'}),{customer:'דוד כהן'},'LRM trailing name');
add('E15','misc',base({cust:'שם לקוח: ⁧דוד כהן⁩'}),{customer:'דוד כהן'},'RLI/PDI isolates');
add('E16','misc',base({addr:'כתובת: ‏הרצל 12‏'}),{address:'הרצל 12'},'RLM address');
add('E17','misc',base({work:'סוג עבודה: ‏סתימה'}),{work:'סתימה'},'RLM work');
add('E18','misc','﻿שם לקוח: דוד כהן\nסוג עבודה: סתימה\nסכום: 350\nבוצע',{customer:'דוד כהן',total:350},'BOM first line');
add('E19','misc','‏שם לקוח: דוד כהן\n‏סוג עבודה: סתימה\n‏סכום: 350\n‏בוצע',{customer:'דוד כהן',total:350,done:true},'RLM before every line');
add('E20','misc','שם לקוח: דוד כהן\nסוג עבודה: סתימה\nסכום: 350\n‏בוצע',{done:true},'RLM before בוצע');
add('E21','misc','שם לקוח: דוד כהן\nסוג עבודה: סתימה\nסכום: 350\n✅ בוצע',{done:true},'emoji before בוצע');
add('E22','misc','שם לקוח: דוד כהן\nסוג עבודה: סתימה\nסכום: 350\nבוצע.',{done:true},'period');
// run
const sub = (a, e) => { if (e === null || typeof e !== 'object') return Object.is(a, e) || a === e; return Object.keys(e).every(k => { if (k === '__multi' || k === 'doneDate') return true; return sub(a ? a[k] : undefined, e[k]); }); };
const failed = [];
for (const c of cases) {
  let out = null; try { out = P(c.text); } catch (e) { out = { __err: String(e) }; }
  let ok = c.expect === null ? out === null : (out !== null && sub(out, c.expect));
  if (c.expect && c.expect.__multi) ok = false;
  if (!ok) failed.push(c.id);
}
const kgPath = path.join(__dirname, 'wa-parse-known-gaps.json');
if (process.argv.includes('--update')) { fs.writeFileSync(kgPath, JSON.stringify(failed.sort(), null, 1)); console.log('known gaps updated:', failed.length); process.exit(0); }
const known = new Set(fs.existsSync(kgPath) ? JSON.parse(fs.readFileSync(kgPath, 'utf8')) : []);
const regress = failed.filter(id => !known.has(id));
if (regress.length) { console.error('❌ wa-parse-check: regressions in cases ' + regress.join(', ')); process.exit(1); }
console.log(`✅ wa-parse-check: ${cases.length - failed.length}/${cases.length} תבניות וואטסאפ נקראות נכון (${failed.length} מגבלות מוכרות), אין נסיגה`);
