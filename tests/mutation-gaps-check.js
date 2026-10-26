#!/usr/bin/env node
/* Gaps found by the mutation run of 26.10: money code that could be broken without any test noticing. Each case has a hand-derived expectation.
 *   node tests/mutation-gaps-check.js
 * (daily net and counts, settlement allocation, receipts, legacy partner debt, partner forecast, median hour value, collection queue promise/log,
 *  report period boundary, January year boundary of the month comparison, week net comparison, weekly message lines.) */
const fs = require('fs'), path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 20) console.error('❌ ' + m); } };
const eq = (a, b, m) => expect(Math.abs(a - b) < 1e-9, `${m}: got ${a}, wanted ${b}`);
const reset = () => { app.state.tx = []; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {}; app.state.config = {}; };
const inc = o => ({ id: 'i' + Math.random().toString(36).slice(2, 8), type: 'income', stage: 'paid', total: 1000, partnerAmount: 0, materials: 0, hours: 0, whoseCustomer: 'mine', partnerName: '', work: 'עבודה', customer: 'לקוח', ...o });
const exp = o => ({ id: 'e' + Math.random().toString(36).slice(2, 8), type: 'expense', stage: 'paid', total: 100, category: 'דלק', work: 'הוצאה', ...o });

// 1. computeDailyReport — day figures, payment buckets and counts
reset();
const D = '2026-09-10';
app.state.tx = [
  inc({ date: D, paidDate: D, total: 1000, partnerAmount: 200, partnerName: 'אהרן', materials: 50, payment: 'מזומן' }),           // my share 800
  inc({ date: D, paidDate: D, total: 500, payment: 'ביט' }), inc({ date: D, paidDate: D, total: 300, payment: 'העברה' }), inc({ date: D, paidDate: D, total: 200, payment: 'אשראי' }),
  inc({ date: D, paidDate: D, total: 120, payment: "צ'ק" }), inc({ date: D, paidDate: D, total: 80, payment: 'בלי שם' }),
  exp({ date: D, total: 70 }),
  inc({ date: '2026-09-01', stage: 'scheduled', scheduledDate: D, total: 400 }),                                                     // scheduled for D
  inc({ date: '2026-09-11', stage: 'unpaid', total: 999 })                                                                          // another day
];
app.state.tasks = [{ id: 'k1', status: 'open', date: D, kind: 'work', task: 'א' }, { id: 'k2', status: 'open', deadline: D, kind: 'work', task: 'ב' }, { id: 'k3', status: 'open', date: '2026-09-30', deadline: '2026-09-30', kind: 'work', task: 'ג' }, { id: 'k4', status: 'done', date: D, kind: 'work', task: 'ד' }];
let r = app.computeDailyReport(D);
eq(r.dayIncome, 800 + 500 + 300 + 200 + 120 + 80, 'day income (my share)'); eq(r.dayExpenses, 70, 'day expenses'); eq(r.dayMaterials, 50, 'day materials');
eq(r.dayNet, 800 + 500 + 300 + 200 + 120 + 80 - 70 - 50, 'day net = income − expenses − materials');
eq(r.byPayment['מזומן'], 800, 'cash bucket'); eq(r.byPayment['ביט'], 500, 'bit bucket'); eq(r.byPayment['העברה'], 300, 'transfer bucket'); eq(r.byPayment['אשראי'], 200, 'card bucket'); eq(r.byPayment["צ'ק"], 120, 'cheque bucket'); eq(r.byPayment['אחר'], 80, 'other bucket');
expect(r.jobsScheduledToday === 1, 'one job scheduled for the day: ' + r.jobsScheduledToday);
expect(r.jobsCompletedToday === 6, 'six jobs completed/paid that day: ' + r.jobsCompletedToday);
expect(r.openTasksToday.length === 2, 'two open tasks for the day: ' + r.openTasksToday.length);

// 2. allocateOldestFirst — a payment spread over the oldest open items first
const it = (open, id) => ({ t: { id }, open });
let parts = app.allocateOldestFirst([it(100, 'a'), it(50, 'b'), it(70, 'c')], 120);
expect(parts.length === 2 && parts[0].amount === 100 && parts[1].amount === 20, 'allocation 120 over 100/50/70: ' + JSON.stringify(parts.map(p => p.amount)));
parts = app.allocateOldestFirst([it(100, 'a'), it(50, 'b')], 500); expect(parts.length === 2 && parts[0].amount === 100 && parts[1].amount === 50, 'allocation never exceeds what is open');
expect(app.allocateOldestFirst([it(100, 'a')], 0.004).length === 0, 'a sub-agora payment allocates nothing');
parts = app.allocateOldestFirst([it(0.1, 'a'), it(0.2, 'b'), it(0.3, 'c')], 0.6); eq(parts.reduce((s, p) => s + p.amount, 0), 0.6, 'float-safe allocation of 0.1+0.2+0.3');
parts = app.allocateOldestFirst([it(333.33, 'a'), it(100, 'b')], 400); expect(parts[0].amount === 333.33 && parts[1].amount === 66.67, 'cents survive: ' + JSON.stringify(parts.map(p => p.amount)));

// 3. recordReceipt
let t = inc({ stage: 'partial', total: 1000, paidAmount: 333.33, date: '2026-09-01', paidDate: '2026-09-02', payment: 'ביט' });
app.recordReceipt(t, 0); expect(t.receipts.length === 1 && t.receipts[0].amount === 333.33 && t.receipts[0].date === '2026-09-02' && t.receipts[0].method === 'ביט', 'first receipt: ' + JSON.stringify(t.receipts));
t.paidAmount = 700; app.recordReceipt(t, 333.33); expect(t.receipts.length === 2 && t.receipts[1].amount === 366.67 && t.receipts[1].date === app.todayISO(), 'second receipt is the delta, dated today: ' + JSON.stringify(t.receipts[1]));
t = inc({ stage: 'paid', total: 500, paidDate: '2026-09-05' }); app.recordReceipt(t, 200);   // old row with money but no log: gets a backfilled entry first
expect(t.receipts.length === 2 && t.receipts[0].backfilled && t.receipts[0].amount === 200 && t.receipts[1].amount === 300, 'backfill + delta: ' + JSON.stringify(t.receipts));
t = inc({ stage: 'unpaid', total: 500 }); app.recordReceipt(t, 0); expect(!t.receipts, 'no change in collected → no receipt');

// 4. owedToPartnerNow — legacy rows and who collected
const mine = o => inc({ total: 1000, partnerAmount: 400, partnerName: 'אהרן', ...o });
eq(app.owedToPartnerNow(mine({ stage: 'paid', partnerCollected: null, partnerPending: true })), 400, 'legacy: my customer, paid, partnerPending → owed');
eq(app.owedToPartnerNow(mine({ stage: 'paid', partnerCollected: null, partnerPending: false })), 0, 'legacy: my customer, paid, not pending → not owed');
eq(app.owedToPartnerNow(mine({ stage: 'partial', paidAmount: 500, partnerCollected: false })), 200, 'I collected half → owe half of his cut');
eq(app.owedToPartnerNow(mine({ stage: 'paid', partnerCollected: false, settledPartnerAmount: 150 })), 250, 'settled part is deducted');
eq(app.owedToPartnerNow(mine({ stage: 'paid', partnerCollected: true })), 0, 'he collected → I owe nothing');
eq(app.owedToPartnerNow(mine({ stage: 'paid', whoseCustomer: 'partner', partnerCollected: null, partnerPending: true })), 0, "legacy flag does not make a partner's customer a debt");
eq(app.owedToPartnerNow(mine({ stage: 'paid', whoseCustomer: 'partner', partnerCollected: false })), 400, "partner's customer that I collected myself → owed");
eq(app.owedToPartnerNow(mine({ stage: 'paid', partnerAmount: 0, partnerCollected: false })), 0, 'no partner amount → 0');
eq(app.owedToPartnerNow(mine({ type: 'expense', stage: 'paid', partnerCollected: false })), 0, 'an expense owes nothing');
// partnerCutStillToCome — a forecast on money not collected yet
eq(app.partnerCutStillToCome(mine({ stage: 'partial', paidAmount: 500 })), 200, 'forecast: 400 cut, half collected → 200 to come');
eq(app.partnerCutStillToCome(mine({ stage: 'unpaid' })), 400, 'forecast: nothing collected → whole cut');
eq(app.partnerCutStillToCome(mine({ stage: 'paid' })), 0, 'forecast: all collected → 0');
eq(app.partnerCutStillToCome(mine({ stage: 'unpaid', whoseCustomer: 'partner' })), 0, "no forecast on a partner's customer");
eq(app.partnerCutStillToCome(mine({ stage: 'unpaid', partnerName: '' })), 0, 'no partner name → 0');
eq(app.partnerCutStillToCome(mine({ type: 'expense' })), 0, 'expense → 0');

// 5. erpAgg median (odd and even counts) and zero-hour rows
const row = (min, mine) => ({ m: { minutes: min, gross: mine, partner: 0, mine, materials: 0, net: mine } });
let a = app.erpAgg([row(60, 100), row(60, 300), row(60, 200)]); eq(a.medianPerHour, 200, 'median of 100/200/300');
a = app.erpAgg([row(60, 400), row(60, 100), row(60, 200), row(60, 300)]); eq(a.medianPerHour, 250, 'median of 100/200/300/400');
a = app.erpAgg([row(120, 600), row(60, 100)]); eq(a.netPerHour, 700 / 3, 'weighted: total net ÷ total hours'); expect(a.medianPerHour === 200, 'median is per-job: (300 and 100) → 200');
a = app.erpAgg([row(0, 100)]); expect(a.netPerHour === null && a.medianPerHour === null, 'no hours → no figure');

// 6. collection queue — promise date and the last log entry
reset(); const today = app.todayISO(), ago = n => app.isoDaysAgo(n);
app.state.tx = [
  inc({ id: 'q1', stage: 'unpaid', date: ago(10), total: 300, promiseDate: today, collectionLog: [{ at: 1, note: 'ראשון' }, { at: 2, note: 'אחרון' }] }),   // promised for today → still promised
  inc({ id: 'q2', stage: 'unpaid', date: ago(20), total: 900, promiseDate: ago(1) }),                                                              // promise expired → normal
  inc({ id: 'q3', stage: 'unpaid', date: ago(5), total: 100 }),
  inc({ id: 'q4', stage: 'unpaid', date: '', total: 100 }),                                                                                         // no date → not in the queue
  inc({ id: 'q5', stage: 'unpaid', date: today, total: 100 }),                                                                                      // today → not overdue yet
  inc({ id: 'q6', stage: 'unpaid', date: ago(7), total: 100, whoseCustomer: 'partner', partnerName: 'שלמה', partnerAmount: 50 })                   // partner's customer → not Asher's
];
let q = app.collectionQueue(); const byId = Object.fromEntries(q.map(x => [x.t.id, x]));
expect(q.map(x => x.t.id).join() === 'q2,q3,q1', 'queue order: unpromised by days desc, then promised: ' + q.map(x => x.t.id));
expect(byId.q1.promised === today && !byId.q2.promised, 'a promise for today stands, an expired one does not');
expect(byId.q1.attempts === 2 && byId.q1.last && byId.q1.last.note === 'אחרון', 'last log entry is the last one');
expect(!byId.q4 && !byId.q5 && !byId.q6, 'no date / today / partner customer stay out');

// 7. reportFigures — a month period includes its first and last day and nothing outside
reset();
app.state.tx = [inc({ id: 'r0', date: '2026-09-30', paidDate: '2026-09-30', total: 111 }), inc({ id: 'r1', date: '2026-10-01', paidDate: '2026-10-01', total: 222 }), inc({ id: 'r2', date: '2026-10-31', paidDate: '2026-10-31', total: 444 }), inc({ id: 'r3', date: '2026-11-01', paidDate: '2026-11-01', total: 888 })];
let f = app.reportFigures('m:2026-10'); const sumKeys = JSON.stringify(f);
const fOct = app.reportFigures('m:2026-10'), fSep = app.reportFigures('m:2026-09'), fNov = app.reportFigures('m:2026-11');
const grossOf = x => x.gross !== undefined ? x.gross : (x.income !== undefined ? x.income : (x.collected !== undefined ? x.collected : null));
const pick = x => { for (const k of ['gross', 'income', 'collected', 'revenue', 'received']) if (typeof x[k] === 'number') return x[k]; if (x.F) return pick(x.F); return null; };
expect(pick(fOct) === 666 && pick(fSep) === 111 && pick(fNov) === 888, `month boundaries: Oct ${pick(fOct)} (666), Sep ${pick(fSep)} (111), Nov ${pick(fNov)} (888) ${sumKeys.slice(0, 120)}`);

// 8. homeNetCompare — the previous month across a year boundary and short months
reset(); let c = app.homeNetCompare('2027-01-15'); expect(c.prevPrefix === '2026-12' && c.prevDay === 15, 'January compares with December of the year before: ' + c.prevPrefix);
c = app.homeNetCompare('2026-03-31'); expect(c.prevPrefix === '2026-02' && c.prevDay === 28, 'March 31 compares with Feb 28: ' + c.prevPrefix + ' ' + c.prevDay);
c = app.homeNetCompare('2028-03-31'); expect(c.prevDay === 29, 'leap year Feb 29');
c = app.homeNetCompare('2026-12-05'); expect(c.prevPrefix === '2026-11', 'December → November same year');

// 9. week comparison net figures and the copyable message lines (partners, expense categories)
reset(); const T = '2026-10-22';   // Thursday; week Sun 18.10 → 22.10, last week Sun 11.10 → 15.10
app.state.tx = [
  inc({ date: '2026-10-19', paidDate: '2026-10-19', total: 1000, partnerAmount: 300, partnerName: 'אהרן', materials: 100 }),
  inc({ date: '2026-10-12', paidDate: '2026-10-12', total: 500 }),
  exp({ date: '2026-10-20', total: 80, category: 'דלק' }), exp({ date: '2026-10-21', total: 20, category: 'רכב' }), exp({ date: '2026-10-13', total: 40, category: 'דלק' })
];
const w = app.homeWeekCompare(T);
eq(w.cur.net, 700 - 80 - 20 - 100, 'this week net'); eq(w.prev.net, 500 - 40, 'last week net'); eq(w.netDiff, (700 - 200) - 460, 'netDiff'); expect(w.netPct === Math.round(((700 - 200) - 460) / 460 * 100), 'netPct ' + w.netPct);
const msg = app.buildWeekly(T);
expect(msg.includes('נכנס (עבודות שבוצעו): ' + app.fmt(1000) + '₪') && msg.includes('יצא: ' + app.fmt(300 + 100 + 100) + '₪') && msg.includes('סה"כ רווח: ' + app.fmt(500) + '₪') && msg.includes('שולם בפועל: ' + app.fmt(1000) + '₪') && msg.includes('עוד לא שולם: ' + app.fmt(0) + '₪'), 'message in/out/profit:\n' + msg);
expect(msg.includes('שותפים: ' + app.fmt(300) + '₪ (אהרן ' + app.fmt(300) + '₪)') && msg.includes('הוצאות: ' + app.fmt(100) + '₪') && msg.includes('דלק ' + app.fmt(80) + '₪') && msg.includes('רכב ' + app.fmt(20) + '₪') && msg.includes('חומרים: ' + app.fmt(100) + '₪'), 'message lines for partners / expense categories / materials');
expect(msg.includes('▲') && msg.includes('מול שבוע שעבר'), 'message compares with last week');

// 10. second round (survivors of the re-run): the other cheque spellings, the day counts, partner rows that are not partner rows, task kinds in the hours gap list, empty message lines
reset(); const D2 = '2026-09-12';
app.state.tx = [
  inc({ date: D2, paidDate: D2, total: 10, payment: 'צק' }), inc({ date: D2, paidDate: D2, total: 20, payment: 'שיק' }), inc({ date: D2, paidDate: D2, total: 40, payment: 'צ׳ק' }),
  inc({ id: 'c-only', date: D2, stage: 'unpaid', completedDate: D2, total: 1 }),                                    // completed that day (completedDate), not paid
  inc({ id: 'sch-other', date: D2, stage: 'scheduled', scheduledDate: '2026-09-20', total: 1 }),                               // scheduled for another day: not "scheduled today", not completed
  inc({ id: 'sch-unpaid', date: '2026-09-01', stage: 'unpaid', scheduledDate: D2, total: 1 }),                                 // scheduledDate = D2 but already done: not scheduled
  exp({ date: D2, total: 5, partnerName: 'אהרן' })                                                                             // an expense that carries a partner name is not a partner job
];
r = app.computeDailyReport(D2);
eq(r.byPayment["צ'ק"], 70, 'all three cheque spellings land in the cheque bucket');
expect(r.jobsScheduledToday === 0, 'scheduledDate on a done job / a scheduled job for another day are not "scheduled today": ' + r.jobsScheduledToday);
expect(r.jobsCompletedToday === 4, 'completed today = three paid + the one completed that day (a scheduled job dated today is not done): ' + r.jobsCompletedToday);
expect(app.partnerBalances().length === 0, 'expense with a partner name and income without one create no partner');
let ag = app.erpAgg([row(0, 100)]); expect(ag.grossPerHour === null && ag.minePerHour === null, 'no hours → no per-hour figures at all');
const tk = { id: 'k1', kind: 'invoice', hours: 3, linkedTxId: 't1' }, tk2 = { id: 'k2', hours: 2, linkedTxId: 't1' };
app.state.tx = [inc({ id: 't1', hours: 1, date: '2026-09-12' })];
let gaps = app.erpHoursReport(app.state.tx, {}, [tk, tk2]).taskGaps; expect(gaps.length === 1 && gaps[0].task.id === 'k2', 'a non-work task (invoice) is not compared with the job hours: ' + gaps.map(g => g.task.id));
app.state.tx = [inc({ id: 'dup', hours: 1, date: '2026-09-12' }), inc({ id: 'dup', hours: 5, date: '2026-09-12' })];
gaps = app.erpHoursReport(app.state.tx, {}, [{ id: 'k3', hours: 1, linkedTxId: 'dup' }]).taskGaps; expect(gaps.length === 0, 'with duplicate ids the FIRST row is the one compared');
reset(); app.state.tx = [inc({ date: '2026-10-20', paidDate: '2026-10-20', total: 100 })];
const noExp = app.buildWeekly('2026-10-22'); expect(!noExp.includes('הוצאות:') && !noExp.includes('שותפים:') && !noExp.includes('חומרים:'), 'a week with no expenses / partners / materials prints no such lines:\n' + noExp);

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('✅ mutation-gaps-check: נטו יומי וספירות, פיזור תשלום על חובות, קבלות, חוב ישן לשותף, תחזית שותף, חציון שווי שעה, תור גבייה (הבטחה/יומן), גבולות תקופה, ינואר→דצמבר, השוואת שבוע והודעה שבועית');
