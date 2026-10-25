#!/usr/bin/env node
/* On a PARTNER's customer, the "paid so far" typed in the forms means MY share received (Asher 5.10: he typed what Shlomi paid
 * him — 1,750 — and the partner screen showed 1,361.11). The forms convert with fieldToPaidAmount / paidAmountToField; this
 * guards that what is typed is exactly what the partner screen then shows, and that it agrees with the partner-payment flow.
 *   node tests/partner-paid-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 10) console.error('❌ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 0.011;

// the incident: 4,500 job, partner's cut 1,000, Yehuda's 3,500; the partner handed over 1,750
const tx = { type: 'income', total: 4500, partnerAmount: 1000, partnerName: 'שלומי', whoseCustomer: 'partner', stage: 'partial', status: 'partial' };
tx.paidAmount = app.fieldToPaidAmount(tx, 1750);
expect(near(tx.paidAmount, 2250), 'typed 1,750 must be stored as 2,250 of the 4,500: ' + tx.paidAmount);
expect(near(app.collectedYehudaShare(tx), 1750), 'the partner screen must show 1,750 received: ' + app.collectedYehudaShare(tx));
expect(near(app.yehudaPending(tx), 1750), 'and 1,750 still to come: ' + app.yehudaPending(tx));
expect(near(app.paidAmountToField(tx), 1750), 'the edit form must show back what was typed');
// my customer (or no partner): the field stays in plain total terms
const mine = { type: 'income', total: 4500, partnerAmount: 1000, whoseCustomer: 'mine', stage: 'partial', paidAmount: 1750 };
expect(app.paidFieldIsMyShare(mine) === false && app.fieldToPaidAmount(mine, 1750) === 1750 && app.paidAmountToField(mine) === 1750, 'my own customer: no conversion');
expect(app.paidFieldIsMyShare({ type: 'income', total: 500, partnerAmount: 0, whoseCustomer: 'partner' }) === false, 'no partner cut: no conversion');
// consistency with the partner-payment flow: it scales the amount by total / my share — same function
const scale = 4500 / 3500; expect(near(1750 * scale, tx.paidAmount), 'must equal the partner-payment flow conversion');
// fuzz: whatever is typed (0..my share) comes back identically on the partner screen
let seed = 11; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = 0; i < 4000; i++) {
  const total = 100 + Math.round(R() * 9000), pa = Math.round(R() * (total - 1));
  const t = { type: 'income', total, partnerAmount: pa, partnerName: 'א', whoseCustomer: 'partner', stage: 'partial' };
  const mineTotal = total - pa, typed = Math.round(R() * mineTotal * 100) / 100;
  t.paidAmount = app.fieldToPaidAmount(t, typed);
  expect(near(app.collectedYehudaShare(t), typed), `typed ${typed} on ${total}/${pa} shows ${app.collectedYehudaShare(t)}`);
  expect(near(app.paidAmountToField(t), typed), 'round trip ' + typed);
  expect(app.collectedAmount(t) <= total + 0.011, 'collected must not exceed the total');
}
// a partial payment must be spelled out in lists: how much, out of how much, what is left
const t1 = { type: 'income', total: 5500, partnerAmount: 2000, partnerName: 'שלומי', whoseCustomer: 'mine', stage: 'partial', status: 'partial', paidAmount: 2500 };
expect(app.partialPaymentText(t1) === 'שולם 2,500₪ מתוך 5,500₪ · נשאר 3,000₪', 'my customer partial: ' + app.partialPaymentText(t1));
expect(/קיבלתי 1,750₪ מתוך 3,500₪ · נשאר 1,750₪ \(החלק שלי\)/.test(app.partialPaymentText(tx)), 'partner customer partial is stated in my share: ' + app.partialPaymentText(tx));
expect(app.partialPaymentText({ type: 'income', total: 500, stage: 'unpaid', status: 'unpaid' }) === '', 'an unpaid job shows no partial text');
expect(app.partialPaymentText({ type: 'income', total: 500, stage: 'paid', status: 'paid' }) === '', 'a paid job shows no partial text');
expect(app.partialPaymentText({ type: 'expense', total: 50, stage: 'paid' }) === '', 'an expense shows no partial text');
// partners tab: the payment dialog can settle HIS customer's job that I collected myself, and the month statement lists both directions
app.state.settlements = [];
const jobHeCollectedByMe = { id: 'j1', type: 'income', customer: 'לקוח א', work: 'דוד', date: '2026-09-10', total: 1000, partnerName: 'שלומי', partnerAmount: 400, whoseCustomer: 'partner', partnerCollected: false, stage: 'paid', status: 'paid', paidDate: '2026-09-10' };
const jobMine = { id: 'j2', type: 'income', customer: 'לקוח ב', work: 'סתימה', date: '2026-09-12', total: 600, partnerName: 'שלומי', partnerAmount: 200, whoseCustomer: 'mine', partnerCollected: false, stage: 'paid', status: 'paid', paidDate: '2026-09-12' };
app.state.tx = [jobHeCollectedByMe, jobMine]; app.state.customerMeta = {};
const items = app.partnerOpenItems('שלומי', 'toPartner');
expect(items.length === 2 && items.some(x => x.t.id === 'j1'), 'toPartner must include his customer that I collected: ' + JSON.stringify(items.map(x => [x.t.id, x.open])));
const st = app.buildPartnerMonthStatement('שלומי', '2026-09');
expect(/לקוח א/.test(st) && /לקוח ב/.test(st) && /אני חייב לך/.test(st), 'the month statement must list both directions: ' + st.slice(0, 200));
expect(JSON.stringify(app.partnerStatementMonths('שלומי')) === '["2026-09"]', 'months list');
if (fails) process.exit(1);
console.log('✅ partner-paid-check: מה שמקלידים כ"קיבלתי מהשותף" הוא בדיוק מה שמסך השותפים מראה');
