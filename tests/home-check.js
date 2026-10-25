#!/usr/bin/env node
/* The home screen's big number and its curve: the big number is the month's FINAL profit (collected share − expenses − materials) and its curve ends exactly there; the comparison uses the previous month up to the same day,
 * on the newest real backup and on random books.
 *   node tests/home-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 10) console.error('❌ ' + m); } };
const reset = () => vm.runInContext('_reconCache = null; _reconSig = ""; _aliasCache = null;', app);
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
const lastDay = pre => new Date(Number(pre.slice(0, 4)), Number(pre.slice(5, 7)), 0).getDate();
const check = (txs, today, label) => {
  app.state.tx = txs; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {}; reset();
  // 1. a FULL month's profit curve ends exactly at the report's month net (final profit = collected share − expenses − materials)
  for (const pre of [today.slice(0, 7), '2026-09']) {
    const ld = lastDay(pre), series = app.homeNetSeries(pre, ld), rep = app.computeDailyReport(pre + '-' + String(ld).padStart(2, '0'));
    expect(series.length === ld, label + ' ' + pre + ': one point per day');
    expect(Math.abs(series[series.length - 1] - rep.monthNet) < 0.011, `${label} ${pre}: curve end ${series[series.length - 1]} vs month net ${rep.monthNet}`);
  }
  // 2. the comparison: this month so far vs the previous month up to the same day
  const c = app.homeNetCompare(today), rep = app.computeDailyReport(today);
  expect(c.cur.length === Number(today.slice(8, 10)), label + ': one point per day so far');
  expect(Math.abs(c.curNet - rep.monthNet) < 0.011, `${label}: big number ${c.curNet} vs month net ${rep.monthNet}`);
  const prevFull = app.computeDailyReport(c.prevPrefix + '-' + String(lastDay(c.prevPrefix)).padStart(2, '0')).monthNet;
  if (c.prevDay === lastDay(c.prevPrefix)) expect(Math.abs(c.prevNet - prevFull) < 0.011, `${label}: previous month at its last day ${c.prevNet} vs ${prevFull}`);
  expect(Math.abs(c.diff - (c.curNet - c.prevNet)) < 1e-9, label + ': difference');
  const svg = app.homeMonthCurve(today);
  expect(c.cur.length < 2 ? svg === '' : /<svg/.test(svg) && !/NaN|Infinity/.test(svg), label + ': svg is well formed');
};
if (files.length) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  ['2026-09-30', '2026-10-12', '2026-10-31', '2026-03-31'].forEach(t => check(d.tx.map(x => ({ ...x })), t, 'real ' + t));
}
let seed = 9; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = 0; i < 400; i++) {
  const rows = [];
  for (let k = 0; k < 12; k++) {
    const total = Math.round(R() * 5000), partner = R() < .5 ? 'אהרן' : '';
    const t = { id: 'h' + i + '_' + k, type: 'income', total, date: '2026-10-' + String(1 + Math.floor(R() * 12)).padStart(2, '0'), materials: R() < .5 ? Math.round(R() * 300) : 0, whoseCustomer: partner && R() < .5 ? 'partner' : 'mine', partnerName: partner, partnerAmount: partner ? Math.round(R() * total) : 0 };
    const st = ['unpaid', 'partial', 'paid', 'paid'][Math.floor(R() * 4)];
    app.applyTxStage(t, st);
    if (st === 'partial') t.paidAmount = Math.round(R() * total);
    if (st !== 'unpaid') t.paidDate = '2026-10-' + String(1 + Math.floor(R() * 12)).padStart(2, '0');
    if (partner && st !== 'unpaid') t.partnerCollected = t.whoseCustomer === 'partner';
    rows.push(t);
  }
  for (let k = 0; k < 3; k++) rows.push({ id: 'e' + i + '_' + k, type: 'expense', total: Math.round(R() * 900), date: (R() < .5 ? '2026-09-' : '2026-10-') + String(1 + Math.floor(R() * 12)).padStart(2, '0'), category: 'דלק' });
  rows.forEach(t => { if (t.type === 'income' && R() < .3) t.date = '2026-09-' + String(1 + Math.floor(R() * 28)).padStart(2, '0'); });
  check(rows, '2026-10-12', 'random ' + i);
}
if (fails) process.exit(1);
console.log('✅ home-check: הרווח הסופי בדף הבית זהה לרווח הנקי בדוח, והשוואה לחודש הקודם עד אותו תאריך נכונה, על נתונים אמיתיים ואקראיים');
