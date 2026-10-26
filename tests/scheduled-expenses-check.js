#!/usr/bin/env node
/* Scheduled expenses and spread expenses (Asher 26.10):
 *  - "משכורת לאשר": 2,500₪ on the 2nd of every month from today, entered by itself (once, never again after a delete) + a reminder;
 *  - "משכורת ליחיאל": every second month on the 15th (Oct → Dec → Feb …) as a reminder only;
 *  - insurance paid once is spread over 12 months from October: portions appear as each month arrives, never backwards, and the parts add up to the whole.
 *   node tests/scheduled-expenses-check.js */
const fs = require('fs'), path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const eq = (a, b, m) => expect(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
app.state.currentUser = { role: 'admin', uid: 'u' };
const reset = () => { app.state.tx = []; app.state.tasks = []; app.state._deletedIds = []; app.state._deletedAt = {}; app.state.settlements = []; app.state.customerMeta = {}; };
const asher = { id: 'rec_salary_asher', name: 'משכורת לאשר', category: 'משיכת משכורת', amount: 2500, freq: 'monthly', everyMonths: 1, day: 2, auto: true, remind: true, startFrom: '2026-10-27' };
const yechiel = { id: 'rec_salary_yechiel', name: 'משכורת ליחיאל', category: 'משיכת משכורת', amount: null, freq: 'bimonthly', everyMonths: 2, anchor: '2026-10', day: 15, auto: false, remind: true, startFrom: '2026-10-27' };

// 1. due dates
eq(app.recurringDueDates(asher, '2026-10-27', '2027-01-31'), ['2026-11-02', '2026-12-02', '2027-01-02'], "Asher's salary: the 2nd of every month, starting after today");
eq(app.recurringDueDates(yechiel, '2026-10-27', '2027-04-30'), ['2026-12-15', '2027-02-15', '2027-04-15'], "Yechiel's salary: every second month on the 15th (Oct was already paid → Dec, Feb, Apr)");
eq(app.recurringDueDates(yechiel, '2026-10-01', '2026-10-31'), [], 'October 15th is before the start date: nothing');
eq(app.recurringDueDates({ ...yechiel, startFrom: undefined, anchor: '2026-10' }, '2026-10-01', '2026-10-31'), ['2026-10-15'], 'without a start date October is on the rhythm');
eq(app.recurringDueDates({ id: 'x', day: 31, everyMonths: 1, startFrom: '2026-01-01' }, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], 'day 31 clamps to the month end');
eq(app.recurringDueDates({ id: 'x', everyMonths: 1 }, '2026-01-01', '2026-04-30'), [], 'no due day → nothing');
eq(app.recurringDueDates({ id: 'y', day: 5, freq: 'quarterly', anchor: '2026-01', startFrom: '2026-01-01' }, '2026-01-01', '2026-12-31'), ['2026-01-05', '2026-04-05', '2026-07-05', '2026-10-05'], 'quarterly rhythm');
eq(app.recurringDueDates({ id: 'z', day: 5, freq: 'yearly', anchor: '2025-03', startFrom: '2025-01-01' }, '2026-01-01', '2027-12-31'), ['2026-03-05', '2027-03-05'], 'yearly rhythm');

// 2. the engine
app.state.config = { recurringExpenses: [asher, yechiel] };
reset();
let r = app.runScheduledExpenses('2026-10-28');
expect(r.expenses.length === 0 && r.reminders.map(t => t.id).join() === 'rem_rec_salary_asher_2026-11', 'before the 2nd: a reminder for Nov 2 only, no expense yet: ' + JSON.stringify([r.expenses.length, r.reminders.map(t => t.id)]));
const rem = app.state.tasks[0]; expect(rem.kind === 'reminder' && rem.deadline === '2026-11-02' && rem.status === 'open' && rem.task === 'משכורת לאשר', 'the reminder is a normal open reminder on its due date');
r = app.runScheduledExpenses('2026-11-03');
expect(r.expenses.length === 1 && r.expenses[0].id === 'rec_rec_salary_asher_2026-11' && r.expenses[0].date === '2026-11-02' && r.expenses[0].total === 2500 && r.expenses[0].category === 'משיכת משכורת' && r.expenses[0].stage === 'paid' && r.expenses[0].autoCreated, 'on the 3rd, November salary is entered once, dated the 2nd: ' + JSON.stringify(r.expenses.map(e => [e.id, e.date, e.total])));
r = app.runScheduledExpenses('2026-11-03'); expect(r.expenses.length === 0 && r.reminders.length === 0, 'running again enters nothing twice');
expect(app.state.tasks.some(t => t.id === 'rem_rec_salary_asher_2026-12'), "Asher's December reminder was already made on Nov 3 (35 days ahead)");
r = app.runScheduledExpenses('2026-11-20'); expect(r.reminders.map(t => t.id).join() === 'rem_rec_salary_yechiel_2026-12', "by Nov 20 Yechiel's December 15th reminder appears: " + r.reminders.map(t => t.id));
expect(app.state.tx.length === 1, "Yechiel's salary is a reminder only: no expense was entered for him");
// catching up after a long break enters each missed month, once
reset(); r = app.runScheduledExpenses('2027-01-10'); eq(r.expenses.map(e => e.date), ['2026-11-02', '2026-12-02', '2027-01-02'], 'a device opened after two months enters the missed months');
// a deleted entry is never brought back
app.state._deletedIds = ['rec_rec_salary_asher_2026-12']; app.state.tx = app.state.tx.filter(t => t.id !== 'rec_rec_salary_asher_2026-12'); r = app.runScheduledExpenses('2027-01-10'); expect(r.expenses.length === 0, 'a month the owner deleted is not entered again');
// what was already recorded is not touched
reset(); app.state.tx = [{ id: 'old1', type: 'expense', stage: 'paid', date: '2026-10-05', total: 2500, category: 'שונות', work: 'משכורת לאשר' }];
app.runScheduledExpenses('2026-10-28'); expect(app.state.tx.length === 1 && app.state.tx[0].id === 'old1' && app.state.tx[0].total === 2500 && app.state.tx[0].category === 'שונות', 'the October entry made by hand stays exactly as it was');
// a non-admin never runs it
app.state.currentUser = { role: 'owner', uid: 'o' }; reset(); r = app.runScheduledExpenses('2026-11-03'); expect(!r.expenses.length && !app.state.tx.length, 'only the admin runs the engine'); app.state.currentUser = { role: 'admin', uid: 'u' };
// items with a due day do not also show up as "not entered yet" reminders
expect(app.recurringExpenseGaps([], '2026-11-10', [asher, yechiel]).length === 0, 'engine items are not in the old "expenses not entered" list');

// 3. spreading
reset(); app.state.config = {};
app.state.tx = [{ id: 'ins1', type: 'expense', stage: 'paid', date: '2026-10-06', total: 2286, category: 'ביטוח רכב', work: 'ביטוח חובה' }, { id: 'ins2', type: 'expense', stage: 'paid', date: '2026-10-06', total: 7496, category: 'ביטוח רכב', work: 'ביטוח מקיף' }];
expect(app.spreadExpense('ins1', 12, '2026-10', '2026-10-27') && app.spreadExpense('ins2', 12, '2026-10', '2026-10-27'), 'spread accepted');
const first1 = app.state.tx.find(t => t.id === 'ins1'), first2 = app.state.tx.find(t => t.id === 'ins2');
expect(first1.total === 190.5 && first2.total === 624.67 && first1.spreadTotal === 2286 && first1.spreadMonths === 12 && first1.date === '2026-10-06', 'the first row keeps its date and carries the first portion');
expect(app.state.tx.length === 2, 'on 27.10 nothing else exists yet — no month before it, none ahead');
let made = app.ensureSpreadPortions('2026-12-31'); expect(made.length === 4 && made.every(t => t.date >= '2026-11-06' && t.date <= '2026-12-06'), 'by the end of December: November and December portions of both: ' + made.map(t => t.date));
made = app.ensureSpreadPortions('2026-12-31'); expect(made.length === 0, 'idempotent');
app.ensureSpreadPortions('2027-09-30');
const all1 = app.state.tx.filter(t => t.id === 'ins1' || t.spreadOf === 'ins1'), all2 = app.state.tx.filter(t => t.id === 'ins2' || t.spreadOf === 'ins2');
expect(all1.length === 12 && all2.length === 12, 'twelve portions each');
expect(Math.abs(all1.reduce((s, t) => s + t.total, 0) - 2286) < 1e-9 && Math.abs(all2.reduce((s, t) => s + t.total, 0) - 7496) < 1e-9, 'the portions add up to the whole exactly: ' + all2.reduce((s, t) => s + t.total, 0));
expect(all1.map(t => t.date).sort().join() === ['2026-10-06', '2026-11-06', '2026-12-06', '2027-01-06', '2027-02-06', '2027-03-06', '2027-04-06', '2027-05-06', '2027-06-06', '2027-07-06', '2027-08-06', '2027-09-06'].join(), 'the 6th of twelve consecutive months from October');
expect(all1.every(t => t.category === 'ביטוח רכב' && t.type === 'expense' && t.stage === 'paid'), 'portions keep the category');
// the reports see the monthly portion
const nov = app.computeDailyReport('2026-11-15'), oct = app.computeDailyReport('2026-10-15');
expect(Math.abs(nov.monthExpenses - (190.5 + 624.67)) < 1e-9 && Math.abs(oct.monthExpenses - (190.5 + 624.67)) < 1e-9, `October and November each carry 815.17 of insurance (was 9,782 in October): ${oct.monthExpenses} ${nov.monthExpenses}`);
// a portion the owner deleted is not re-created; undo restores the original
reset(); app.state.tx = [{ id: 'k1', type: 'expense', stage: 'paid', date: '2026-10-06', total: 1200, category: 'ביטוח רכב', work: 'ב' }]; app.spreadExpense('k1', 12, '2026-10', '2026-11-30');
const p2 = app.state.tx.find(t => t.id === 'spread_k1_2'); expect(!!p2, 'November portion exists on 30.11');
app.state.tx = app.state.tx.filter(t => t.id !== 'spread_k1_2'); app.state._deletedIds = ['spread_k1_2']; app.ensureSpreadPortions('2026-11-30'); expect(!app.state.tx.some(t => t.id === 'spread_k1_2'), 'a deleted portion stays deleted');
expect(app.unspreadExpense('k1') && app.state.tx.length === 1 && app.state.tx[0].total === 1200 && !('spreadMonths' in app.state.tx[0]), 'undo: back to one row with the full amount');
expect(!app.spreadExpense('k1', 1, '2026-10') && !app.spreadExpense('k1', 99, '2026-10') && !app.spreadExpense('nope', 12), 'bad inputs are refused');
app.state.tx.push({ id: 'inc1', type: 'income', stage: 'paid', total: 100, date: '2026-10-01' }); expect(!app.spreadExpense('inc1', 12, '2026-10'), 'an income cannot be spread');
// 4. the two one-time setups (what happens when the owner opens the app after this update)
(async () => {
  const vm = require('vm');
  vm.runInContext('this.ensureSalaryItems = ensureSalaryItems; this.migrateInsuranceSpread = migrateInsuranceSpread;', app);
  const saved = []; app.saveConfig = async patch => { saved.push(patch); app.state.config = { ...app.state.config, ...patch }; return true; }; app.snapshotState = () => {}; app.saveState = () => {}; app.render = () => {}; app.toast = () => {};
  reset(); app.state.config = {};
  await app.ensureSalaryItems();
  const items = app.state.config.recurringExpenses;
  expect(saved.length === 1 && items.some(i => i.id === 'rec_salary_asher' && i.amount === 2500 && i.day === 2 && i.auto && i.remind) && items.some(i => i.id === 'rec_salary_yechiel' && i.day === 15 && i.everyMonths === 2 && i.anchor === '2026-10' && !i.auto && i.remind), 'both salaries are added');
  expect(!items.some(i => i.id === 'def_משיכת משכורת') && items.some(i => i.id === 'def_ביטוח רכב'), 'the generic salary item is replaced, the other fixed expenses stay');
  await app.ensureSalaryItems(); expect(saved.length === 1, 'the setup runs once');
  // the insurance: 12 months from October, both rows, once
  app.state.config = {}; saved.length = 0; reset();
  app.state.tx = [{ id: 'xq2gm6pee8sks', type: 'expense', stage: 'paid', date: '2026-10-06', total: 2286, category: 'ביטוח רכב', work: 'ביטוח חובה' }];
  expect(await app.migrateInsuranceSpread() === false && saved.length === 0, 'rows missing on this book → nothing happens, nothing flagged');
  app.state.tx.push({ id: 'x2gj7euo098sk', type: 'expense', stage: 'paid', date: '2026-10-06', total: 7496, category: 'ביטוח רכב', work: 'ביטוח מקיף' });
  expect(await app.migrateInsuranceSpread() === true, 'both insurance rows found → spread');
  const a1 = app.state.tx.find(t => t.id === 'xq2gm6pee8sks'), a2 = app.state.tx.find(t => t.id === 'x2gj7euo098sk');
  expect(a1.spreadMonths === 12 && a2.spreadMonths === 12 && a1.spreadFrom === '2026-10' && a1.spreadTotal === 2286 && a2.spreadTotal === 7496 && saved.length === 1, 'spread over 12 months from October');
  expect(await app.migrateInsuranceSpread() === false, 'once only');
  if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
  console.log('✅ scheduled-expenses-check: משכורת לאשר (2 לחודש, אוטומטי + תזכורת), משכורת ליחיאל (כל חודשיים ב-15, תזכורת), ופיזור ביטוח על 12 חודשים בלי אחורה ובלי כפילויות');
})();
