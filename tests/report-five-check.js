#!/usr/bin/env node
/* The financial summary is five numbers (Asher 26.10): הכנסות, הוצאות, רווח סופי, נגבה, לגבייה — for the jobs DONE in the chosen period.
 * Their arithmetic must hold (income − expenses = profit, collected + to-collect = income) and every number must match the monthly report / the
 * month table / a plain-loop recomputation, on the newest real backup and on random books.
 *   node tests/report-five-check.js */
const fs = require('fs'), os = require('os'), path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 15) console.error('❌ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
function check(txs, label) {
  app.state.tx = txs; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {}; app.state.config = {};
  const months = [...new Set(txs.map(t => String(t.date || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].slice(-5);
  for (const period of [...months.map(m => 'm:' + m), 'all']) {
    const F = app.reportFigures(period).F, v = app.reportFiveFigures(F);
    // arithmetic of the page
    expect(near(v.income - v.expenses, v.net), `${label} ${period}: income − expenses = profit`);
    expect(near(v.collected + v.toCollect, v.income), `${label} ${period}: collected + to-collect = income`);
    expect(!/NaN|undefined|Infinity/.test(app.reportFiveHTML(F, 'בדיקה')), `${label} ${period}: page has no NaN`);
    // plain loops
    const inP = d => period === 'all' ? true : String(d || '').startsWith(period.slice(2));
    let inc = 0, paid = 0, out = 0;
    for (const t of txs) {
      if (t.type === 'income' && app.isDoneTx(t) && inP(t.date) && (period === 'all' || t.date)) {
        const total = Number(t.total) || 0, pa = Number(t.partnerAmount) || 0, own = t.whoseCustomer === 'partner';
        inc += own ? total - pa : total; paid += own ? app.collectedYehudaShare(t) : app.collectedAmount(t); out += (own ? 0 : ((t.partnerName || '').trim() ? pa : 0)) + (Number(t.materials) || 0);
      }
      if (t.type === 'expense' && inP(t.date) && (period === 'all' || t.date)) out += Number(t.total) || 0;
    }
    expect(near(v.income, inc) && near(v.collected, paid) && near(v.expenses, out), `${label} ${period}: five numbers vs plain loops ${JSON.stringify([v.income, inc, v.collected, paid, v.expenses, out])}`);
    // the monthly report and the month table say the same
    if (period !== 'all') {
      const r = app.computeDailyReport(period.slice(2) + '-01'), b = app.cashPeriodFigures(period.slice(2) + '-01', period.slice(2) + '-31');
      expect(near(v.income, r.monthGross) && near(v.net, r.monthNet) && near(v.expenses, r.monthPartnerCut + r.monthExpenses + r.monthMaterials), `${label} ${period}: equals the monthly report`);
      expect(near(v.collected, b.paidGross) && near(v.toCollect, b.openGross), `${label} ${period}: collected / to-collect equal the month table`);
    }
  }
}
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (files.length) { const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')); check(app.safeRows(d.tx || []), 'real'); }
const { sampleBackup } = require('./sample-data');
for (let i = 0; i < 25; i++) check(sampleBackup(150, 100 + i).tx, 'sample' + i);
// a hand case
check([{ id: 'h1', type: 'income', stage: 'unpaid', date: '2026-10-05', total: 1000, partnerAmount: 300, partnerName: 'אהרן', whoseCustomer: 'mine', materials: 50 },
  { id: 'h2', type: 'income', stage: 'paid', date: '2026-10-06', paidDate: '2026-11-02', total: 600, partnerAmount: 400, partnerName: 'שלמה', whoseCustomer: 'partner', partnerCollected: true },
  { id: 'h3', type: 'expense', stage: 'paid', date: '2026-10-07', total: 120, category: 'דלק' }], 'hand');
{
  const F = app.reportFigures('m:2026-10').F, v = app.reportFiveFigures(F);
  expect(v.income === 1000 + 200 && v.expenses === 300 + 50 + 120 && v.net === 1200 - 470 && v.collected === 200 && v.toCollect === 1000, `hand case: ${JSON.stringify(v)}`);
}
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('✅ report-five-check: סיכום כספי — הכנסות, הוצאות, רווח סופי, נגבה, לגבייה: החשבון מסתדר (הכנסות−הוצאות=רווח, נגבה+לגבייה=הכנסות) ותואם לדוח החודשי ולטבלת החודשים ולחישוב נפרד');
