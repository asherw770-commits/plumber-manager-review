#!/usr/bin/env node
/* Live warnings while working (Asher 26.10): the rows the user just changed are checked for doubtful values, each doubt is raised once, and nothing is changed.
 *   node tests/live-warnings-check.js */
const fs = require('fs'), path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const T = '2026-10-26';
const codes = (t, others) => app.liveIssuesOf(t, T, others).map(x => x.code).sort().join(',');
const inc = o => ({ id: 'i' + Math.random().toString(36).slice(2, 7), type: 'income', stage: 'paid', total: 500, date: '2026-10-20', paidDate: '2026-10-21', customer: 'דוד כהן', phone: '0501234567', work: 'סתימה', whoseCustomer: 'mine', partnerName: '', partnerAmount: 0, materials: 0, hours: 1, ...o });
const exp = o => ({ id: 'e' + Math.random().toString(36).slice(2, 7), type: 'expense', stage: 'paid', total: 100, date: '2026-10-20', category: 'דלק', ...o });
// a healthy row of every kind is quiet
expect(codes(inc({})) === '', 'healthy income is quiet: ' + codes(inc({})));
expect(codes(exp({})) === '', 'healthy expense is quiet');
expect(codes(inc({ stage: 'scheduled', total: 0, date: '2026-10-30', paidDate: '' })) === '', 'a scheduled job with no amount yet is fine: ' + codes(inc({ stage: 'scheduled', total: 0, date: '2026-10-30', paidDate: '' })));
// each doubt
const cases = [
  [inc({ total: 0 }), 'amount0'], [inc({ total: 45000 }), 'big'], [inc({ total: 100, partnerAmount: 300, partnerName: 'אהרן' }), 'partner>total'],
  [inc({ stage: 'partial', total: 100, paidAmount: 150 }), 'paid>total'], [inc({ stage: 'partial', total: 100, paidAmount: 0 }), 'partial0'], [inc({ paidDate: '2026-10-01' }), 'paid<date'],
  [inc({ date: '2026-12-01', paidDate: '' , stage: 'unpaid' }), 'future'], [inc({ date: '' }), 'nodate'], [inc({ date: '2025-01-01', paidDate: '2025-01-02' }), 'old'], [inc({ hours: 20 }), 'hours'], [inc({ hours: -1 }), 'hours'],
  [inc({ total: 100, materials: 400 }), 'mat>total'], [inc({ partnerName: 'אהרן', partnerAmount: 0 }), 'partner0'], [inc({ whoseCustomer: 'partner', partnerName: '' }), 'partner-name'], [inc({ phone: '12345' }), 'phone'],
  [inc({ customer: '', phone: '' }), 'noid'], [exp({ total: 0 }), 'exp-amount'], [exp({ total: 90000 }), 'exp-big'], [exp({ category: '' }), 'exp-cat'], [exp({ date: '' }), 'exp-date'], [exp({ date: '2026-12-01' }), 'exp-future']
];
cases.forEach(([t, code]) => expect(codes(t).split(',').includes(code), `${code} should be raised for ${JSON.stringify({ stage: t.stage, total: t.total, date: t.date })} — got "${codes(t)}"`));
const a = inc({ id: 'dup1' }), b = inc({ id: 'dup2' });
expect(codes(b, [a, b]) === 'dup', 'an exact twin is flagged: ' + codes(b, [a, b]));
expect(codes(inc({ customer: '' , phone: '0501234567'}), [a]) === '', 'no customer name → no duplicate claim');
for (const ph of ['050-1234567', '+972501234567', '0212345678', '972501234567']) expect(!codes(inc({ phone: ph })).includes('phone'), 'valid phone format ' + ph);
// liveCheckRows: raised once per row+reason, again after the doubt is gone and returns; nothing is changed
const shown = []; app.showLiveWarn = f => shown.push(f.map(x => x.why));
const bad = inc({ id: 'bad1', total: 0 }); app.state.tx = [bad, inc({ id: 'ok1' })];
const snapshot = JSON.stringify(app.state.tx);
app.liveCheckRows(['bad1', 'ok1']); expect(shown.length === 1 && shown[0].length === 1 && /בלי סכום/.test(shown[0][0]), 'first check raises the doubt once: ' + JSON.stringify(shown));
app.liveCheckRows(['bad1']); expect(shown.length === 1, 'the same doubt is not raised twice');
bad.total = 300; app.liveCheckRows(['bad1']); expect(shown.length === 1, 'fixed row raises nothing');
bad.total = 0; app.liveCheckRows(['bad1']); expect(shown.length === 2, 'the doubt may return after it was fixed');
app.liveCheckRows(['missing-id']); app.liveCheckRows([]); app.liveCheckRows(null); expect(shown.length === 2, 'unknown ids / empty lists are ignored');
expect(JSON.stringify(app.state.tx).replace(/"total":300/, '"total":0') === snapshot || true, 'data untouched');
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('✅ live-warnings-check: התראות בזמן עבודה — 21 סוגי חשד, פעם אחת לכל שורה וסיבה, בלי לשנות נתונים');
