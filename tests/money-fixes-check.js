#!/usr/bin/env node
/* Money-audit fixes of 19.10: an untouched partial payment keeps its stored cents on re-save; "N days ago" is DST-safe; Yehuda's "came in today" is in his own terms.
 *   node tests/money-fixes-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
// 1. paid field round trip
const row = { type: 'income', whoseCustomer: 'partner', total: 900, partnerAmount: 400, paidAmount: 300, stage: 'partial' };
const shown = app.paidAmountToField(row);
expect(app.fieldToPaidAmount(row, shown) !== 300, 'the old round trip did move the amount (that is the bug being guarded): ' + app.fieldToPaidAmount(row, shown));
expect(app.paidFieldUnchanged(row, { ...row }, shown) === true, 'an untouched field is recognised as unchanged');
expect(app.paidFieldUnchanged(row, { ...row }, shown + 1) === false, 'a changed field is recognised');
expect(app.paidFieldUnchanged(row, { ...row, total: 1000 }, shown) === false, 'a changed total is a change');
const row2 = { type: 'income', whoseCustomer: 'partner', total: 5950, partnerAmount: 5900, paidAmount: 4450, stage: 'partial' };
expect(app.paidFieldUnchanged(row2, { ...row2 }, app.paidAmountToField(row2)) === true, 'extreme ratio too');
// 2. DST: 30 days before 3 Nov 2026 23:30 (after the clock change on 25 Oct) is 4 Oct, not 5 Oct
process.env.TZ = 'Asia/Jerusalem';
expect(app.isoDaysAgo(30, new Date(2026, 10, 3, 23, 30)) === '2026-10-04', 'isoDaysAgo across the clock change: ' + app.isoDaysAgo(30, new Date(2026, 10, 3, 23, 30)));
expect(app.isoDaysAgo(0, new Date(2026, 9, 17, 12, 0)) === '2026-10-17' && app.isoDaysAgo(1, new Date(2026, 2, 1, 0, 30)) === '2026-02-28', 'plain cases');
// 3. Yehuda's "came in today"
const today = '2026-10-19';
const tx = [
  { id: 'p', type: 'income', whoseCustomer: 'partner', total: 1000, partnerAmount: 400, receipts: [{ date: today, amount: 1000, method: 'העברה' }], stage: 'paid', paidDate: today },
  { id: 'm', type: 'income', whoseCustomer: 'mine', total: 500, partnerAmount: 0, receipts: [{ date: today, amount: 500 }], stage: 'paid', paidDate: today },
  { id: 'o', type: 'income', whoseCustomer: 'mine', total: 700, receipts: [{ date: '2026-10-18', amount: 700 }], stage: 'paid', paidDate: '2026-10-18' },
  { id: 'e', type: 'expense', total: 90, paidDate: today }
];
const inc = app.ownerIncomeToday(tx, today);
expect(inc.length === 2 && inc.find(x => x.t.id === 'p').amount === 600 && inc.find(x => x.t.id === 'm').amount === 500, 'partner customer counts only my share (600 of 1000), my own customer in full: ' + JSON.stringify(inc.map(x => [x.t.id, x.amount])));
expect(inc.reduce((a, x) => a + x.amount, 0) === 1100, 'sum');
if (fails) { console.error('money-fixes-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ money-fixes-check: שמירה מחדש לא מזיזה אגורות בתשלום חלקי; "30 יום אחורה" תקין גם בשינוי שעון; "נכנס היום" של יהודה בחלק שלו');
