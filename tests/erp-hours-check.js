#!/usr/bin/env node
/* ERP hour-value report (Asher 15.10): every figure re-derived independently, on the newest real backup and on random books.
 *   node tests/erp-hours-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 12) console.error('❌ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// independent reference: straight loops, no helpers from the app except the stage rule
function reference(txs, period, basis) {
  const out = { jobs: 0, min: 0, mine: 0, mat: 0, byCls: { mine: [0, 0, 0], mineWithPartner: [0, 0, 0], forPartner: [0, 0, 0] }, done: 0, noHours: 0, cut: 0, noAmt: 0 };
  for (const t of txs) {
    if (t.type !== 'income') continue;
    if (period !== 'all' && !String(t.date || '').startsWith(period)) continue;
    const st = app.txStage(t);
    if (basis === 'paid' ? st !== 'paid' : !(st === 'unpaid' || st === 'partial' || st === 'paid')) continue;
    out.done++;
    const total = Number(t.total) || 0, pa = Number(t.partnerAmount) || 0, mat = Number(t.materials) || 0, min = Math.round((Number(t.hours) || 0) * 60);
    if ((t.partnerName || '').trim() && t.whoseCustomer === 'partner' && pa <= 0 && !t.myShareOnly) { out.cut++; continue; }
    if (!(total > 0)) { out.noAmt++; continue; }
    if (!(min > 0)) { out.noHours++; continue; }
    out.jobs++; out.min += min; out.mine += total - pa; out.mat += mat;
    const k = t.whoseCustomer === 'partner' ? 'forPartner' : pa > 0 ? 'mineWithPartner' : 'mine';
    out.byCls[k][0]++; out.byCls[k][1] += min; out.byCls[k][2] += total - pa - mat;
  }
  return out;
}
function check(txs, tasks, label) {
  app.state.tx = txs; app.state.tasks = tasks || [];
  for (const basis of ['done', 'paid']) for (const period of ['all', ...new Set(txs.map(t => String(t.date || '').slice(0, 7)).filter(Boolean))].slice(0, 4)) {
    const rep = app.erpHoursReport(txs, { period, basis }, tasks);
    const ref = reference(txs, period, basis), tag = `${label} ${basis}/${period}`;
    expect(rep.all.jobs === ref.jobs && rep.all.minutes === ref.min, `${tag}: jobs/minutes ${rep.all.jobs}/${rep.all.minutes} vs ${ref.jobs}/${ref.min}`);
    expect(near(rep.all.mine, ref.mine) && near(rep.all.materials, ref.mat) && near(rep.all.net, ref.mine - ref.mat), `${tag}: money totals`);
    // nothing lost: every finished job is either used or listed as excluded, once
    expect(rep.coverage.doneJobs === ref.done && rep.used.length + rep.excluded.noHours.length + rep.excluded.cutUnknown.length + rep.excluded.noAmount.length === ref.done, `${tag}: used + excluded must equal finished jobs`);
    expect(rep.excluded.noHours.length === ref.noHours && rep.excluded.cutUnknown.length === ref.cut && rep.excluded.noAmount.length === ref.noAmt, `${tag}: exclusion counts`);
    // the three classes add up to the whole, per job count, minutes and net
    const cs = Object.values(rep.byClass);
    expect(cs.reduce((a, c) => a + c.jobs, 0) === rep.all.jobs && cs.reduce((a, c) => a + c.minutes, 0) === rep.all.minutes && near(cs.reduce((a, c) => a + c.net, 0), rep.all.net), `${tag}: classes must add up to the total`);
    for (const k of Object.keys(ref.byCls)) expect(rep.byClass[k].jobs === ref.byCls[k][0] && rep.byClass[k].minutes === ref.byCls[k][1] && near(rep.byClass[k].net, ref.byCls[k][2]), `${tag}: class ${k}`);
    // value per hour = total net ÷ total hours (weighted), for the total, every class, partner, category, month
    const grp = [rep.all, ...cs, ...rep.byPartner, ...rep.byCategory, ...rep.byMonth];
    for (const g of grp) expect(g.hours > 0 ? near(g.netPerHour * g.hours, g.net) : g.netPerHour === null, `${tag}: net/hour must be net ÷ hours for ${g.key || 'group'}`);
    expect(near(rep.byPartner.reduce((a, g) => a + g.jobs, 0), rep.all.jobs - rep.byClass.mine.jobs), `${tag}: partner groups cover every partner job`);
    expect(near(rep.byCategory.reduce((a, g) => a + g.net, 0), rep.all.net) && near(rep.byMonth.reduce((a, g) => a + g.net, 0), rep.all.net), `${tag}: category / month groups add up`);
    // each used row: net = total − partner − materials, hours positive
    for (const r of rep.used) expect(near(r.m.net, (Number(r.t.total) || 0) - (Number(r.t.partnerAmount) || 0) - (Number(r.t.materials) || 0)) && r.m.minutes > 0, `${tag}: row money ${r.t.id}`);
    // the shown tx money agrees with yehudaShare
    for (const r of rep.used) expect(near(r.m.mine, app.yehudaShare(r.t)), `${tag}: mine must equal yehudaShare ${r.t.id}`);
    expect(rep.coverage.revenuePct === null || (rep.coverage.revenuePct >= -1e-9 && rep.coverage.revenuePct <= 1 + 1e-9) || ref.mine < 0, `${tag}: coverage percentage out of range`);
  }
}
// real backup
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
let real = 0;
if (files.length) { const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')); app.state.priceList = d.priceList || []; check(d.tx || [], d.tasks || [], 'real'); real = (d.tx || []).length; }
// random books
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
for (let n = 0; n < 300; n++) {
  const txs = [], tasks = [];
  const N = 1 + Math.floor(rnd() * 40);
  for (let i = 0; i < N; i++) {
    const partner = rnd() < 0.4 ? pick(['אהרן', 'יואלי', ' ']) : '';
    const total = pick([0, 100, 350, 800, 1500, 4500, 99.5]);
    const t = { id: 't' + n + '_' + i, type: rnd() < 0.15 ? 'expense' : 'income', date: '2026-0' + (7 + Math.floor(rnd() * 3)) + '-' + String(10 + Math.floor(rnd() * 18)), total, customer: rnd() < 0.5 ? 'לקוח ' + i : '', partnerName: partner, partnerAmount: partner.trim() && rnd() < 0.7 ? Math.min(total, pick([0, 100, 250, 3200])) : 0,
      whoseCustomer: pick(['mine', 'partner', undefined]), materials: rnd() < 0.4 ? pick([0, 20, 50, 500]) : 0, hours: rnd() < 0.6 ? pick([0, 0.1667, 0.3333, 1, 1.5, 2.0833, 8, 12]) : 0, stage: pick(['unpaid', 'partial', 'paid', 'paid', 'quote', 'scheduled', 'cancelled']), myShareOnly: rnd() < 0.2 ? true : undefined };
    t.paidAmount = t.stage === 'partial' ? total / 2 : 0;
    txs.push(t);
    if (rnd() < 0.3) tasks.push({ id: 'k' + n + '_' + i, kind: 'work', linkedTxId: t.id, hours: pick([0, 1, 0.5, t.hours]) });
  }
  app.state.priceList = [];
  check(txs, tasks, 'fuzz' + n);
}
// task / transaction hour mismatch detection
app.state.tx = [{ id: 'a', type: 'income', date: '2026-10-01', total: 500, hours: 1, stage: 'paid' }, { id: 'b', type: 'income', date: '2026-10-02', total: 500, hours: 0, stage: 'paid' }, { id: 'c', type: 'income', date: '2026-10-03', total: 500, hours: 2, stage: 'paid' }];
const gaps = app.erpHoursReport(app.state.tx, {}, [{ id: 'k1', kind: 'work', linkedTxId: 'a', hours: 1.5 }, { id: 'k2', kind: 'work', linkedTxId: 'b', hours: 1 }, { id: 'k3', kind: 'work', linkedTxId: 'c', hours: 2 }]).taskGaps;
expect(gaps.length === 2 && gaps.some(g => g.task.id === 'k1' && g.taskMin === 90 && g.txMin === 60) && gaps.some(g => g.task.id === 'k2' && g.txMin === 0), 'task/tx hour gaps found exactly where they differ');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
expect(!/name: 'hours'[^}]*type: 'number'/.test(html), 'every form that asks for work time must use the hours:minutes widget (a typed 1.30 would be read as 1.3 hours)');
expect(app.fmtHM(90) === '1:30' && app.fmtHM(10) === '0:10' && app.fmtHM(0) === '0:00', 'fmtHM');
expect(app.txMinutes({ hours: 0.1667 }) === 10 && app.txMinutes({ hours: 0.3333 }) === 20 && app.txMinutes({ hours: 2.0833 }) === 125, 'hours → whole minutes');
if (fails) { console.error('erp-hours-check: ' + fails + ' failures'); process.exit(1); }
console.log(`✅ erp-hours-check: דוח שווי שעה — כל מספר מחושב מחדש בנפרד (${real} עסקאות אמיתיות + 300 ספרים אקראיים): סכומים, שעות, חלוקה לסוגים ולשותפים, ואף עבודה לא נעלמת`);
