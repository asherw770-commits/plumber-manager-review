#!/usr/bin/env node
/* The collection rule (cash at the end of the job / transfer-Bit / cash to the collector's home, no exceptions) is measured by
 * collectionRuleStats; fixed monthly expenses (insurance, mobile, salary draw …) by recurringExpenseGaps.
 *   node tests/collection-rule-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const inc = (o) => ({ type: 'income', whoseCustomer: 'mine', ...o });
const today = '2026-10-05', since = '2026-09-05';

const rows = [
  inc({ id: 'a', date: '2026-09-20', total: 500, stage: 'paid', status: 'paid', paidDate: '2026-09-20' }),                 // same day → on time
  inc({ id: 'b', date: '2026-09-22', total: 700, stage: 'paid', status: 'paid', paidDate: '2026-09-27' }),                 // 5 days later → late
  inc({ id: 'c', date: '2026-09-25', total: 300, stage: 'unpaid', status: 'unpaid' }),                                       // open past the day → breach
  inc({ id: 'd', date: '2026-10-05', total: 400, stage: 'unpaid', status: 'unpaid' }),                                       // today → still allowed
  inc({ id: 'e', date: '2026-09-28', total: 1000, stage: 'partial', status: 'partial', paidAmount: 400, ruleException: true }), // partly open → breach, flagged
  inc({ id: 'f', date: '2026-09-21', total: 900, stage: 'unpaid', status: 'unpaid', whoseCustomer: 'partner' }),             // partner's customer → ignored
  inc({ id: 'g', date: '2026-08-01', total: 100, stage: 'unpaid', status: 'unpaid' }),                                       // before the window → ignored
  inc({ id: 'h', date: '2026-09-26', total: 800, stage: 'quote', status: 'unpaid' }),                                        // quote → ignored
  { type: 'expense', id: 'x', date: '2026-09-26', total: 100, category: 'דלק' }
];
// real rows carry their stage through the shared accessors
rows.forEach(t => { if (t.type === 'income') app.applyTxStage(t, t.stage); });
const r = app.collectionRuleStats(rows, since, today);
expect(r.onTime === 1 && r.late === 1 && r.openBreach === 2 && r.dueToday === 1, 'counts: ' + JSON.stringify(r));
expect(r.exceptions === 1, 'the flagged exception must be counted: ' + r.exceptions);
expect(r.pct === 25, 'percent = on time / (on time + late + open breach) = 1/4: ' + r.pct);
expect(Math.abs(r.openAmount - (300 + 600)) < 0.01 && Math.abs(r.lateAmount - 700) < 0.01, 'amounts: ' + JSON.stringify(r));
expect(app.collectionRuleStats([], since, today).pct === null, 'no jobs → no percentage');

// fixed monthly expenses
const exp = [
  { type: 'expense', id: '1', category: 'ביטוח רכב', total: 540, date: '2026-09-03' },
  { type: 'expense', id: '2', category: 'טלפון', total: 120, date: '2026-09-10' },        // legacy "טלפון" counts as סלולר
  { type: 'expense', id: '3', category: 'סלולר', total: 125, date: '2026-10-02' },        // this month → no gap
  { type: 'expense', id: '4', category: 'דלק', total: 90, date: '2026-10-01' }
];
const gaps = app.recurringExpenseGaps(exp, today);
const names = gaps.map(g => g.category);
expect(!names.includes('סלולר'), 'a category already entered this month must not be listed: ' + names);
expect(names.includes('ביטוח רכב') && gaps.find(g => g.category === 'ביטוח רכב').lastAmount === 540, 'missing insurance must come with last month\'s amount: ' + JSON.stringify(gaps));
expect(names.includes('משיכת משכורת') && gaps.find(g => g.category === 'משיכת משכורת').lastAmount === null, 'a never-entered category is listed without an amount');
expect(app.expenseCategoryKey('טלפון') === 'סלולר' && app.expenseCategoryKey('כלים') === 'כלי עבודה', 'legacy names map to the new ones');
expect(['סלולר', 'ביטוח רכב', 'משיכת משכורת'].every(c => vm.runInContext('EXPENSE_CATEGORIES', app).includes(c)), 'the new categories must be in the shared list');
// user-defined items: yearly (due from its month), quarterly, two items sharing a category
const items = [
  { id: 'y1', name: 'ביטוח רכב שנתי', category: 'ביטוח רכב', amount: 2400, freq: 'yearly', month: 3 },
  { id: 'y2', name: 'אגרת רישוי', category: 'שונות', amount: 800, freq: 'yearly', month: 11 },
  { id: 'q1', name: 'רו"ח רבעוני', category: 'רו״ח', amount: 600, freq: 'quarterly' },
  { id: 'm1', name: 'ארנונה', category: 'שונות', amount: 350, freq: 'monthly' }
];
const e2 = [
  { type: 'expense', id: 'a', category: 'ביטוח רכב', total: 2350, date: '2026-03-10' },              // paid this year already → yearly insurance not due
  { type: 'expense', id: 'b', category: 'רו״ח', total: 600, date: '2026-08-15' },                      // last quarter (Q3) → Q4 still due
  { type: 'expense', id: 'c', category: 'שונות', total: 350, date: '2026-10-02', recurringId: 'm1' }   // tied to the monthly item by id
];
const g2 = app.recurringExpenseGaps(e2, today, items);
const ids = g2.map(g => g.id);
expect(!ids.includes('y1'), 'a yearly item already paid this year is not due: ' + ids);
expect(!ids.includes('y2'), 'a yearly item whose month (November) has not come is not due yet: ' + ids);
expect(ids.includes('q1') && g2.find(g => g.id === 'q1').lastAmount === 600, 'quarterly: due in a new quarter, prefilled with the last amount: ' + JSON.stringify(g2));
expect(!ids.includes('m1'), 'an expense tied by recurringId satisfies its item even when two items share a category: ' + ids);
const g3 = app.recurringExpenseGaps(e2, '2026-11-05', items);
expect(g3.some(g => g.id === 'y2' && g.lastAmount === 800), 'in November the yearly fee is due, prefilled with its usual amount: ' + JSON.stringify(g3.map(g => [g.id, g.lastAmount])));
expect(app.recurringPeriodKey('quarterly', '2026-10-05') === '2026-Q4' && app.recurringPeriodKey('yearly', '2026-10-05') === '2026' && app.recurringPeriodKey('monthly', '2026-10-05') === '2026-10', 'period keys');
// marking a job paid stamps TODAY even when a stale paidDate is left on the row (import / old partial) — else the money lands in the wrong month
{
  const stale = { id: 's', type: 'income', total: 9500, date: '2026-09-07', paidDate: '2026-09-07' };
  app.applyTxStage(stale, 'unpaid');
  app.setTxStage(stale, 'paid');
  expect(stale.paidDate === app.todayISO(), 'a leftover paidDate must be replaced by today when moving to paid: ' + stale.paidDate);
  const already = { id: 'a', type: 'income', total: 100, date: '2026-09-07', paidDate: '2026-09-09' };
  app.applyTxStage(already, 'paid');
  app.setTxStage(already, 'paid');
  expect(already.paidDate === '2026-09-09', 'a job that was already paid keeps its payment date');
}
if (fails) process.exit(1);
console.log('✅ collection-rule-check: כלל הגבייה נמדד נכון (ביום העבודה / באיחור / פתוח) והוצאות קבועות חסרות מזוהות');
