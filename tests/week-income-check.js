#!/usr/bin/env node
/* Income and work hours by week (Asher 23.10): weeks run Sunday–Saturday; the figures follow the same cash rules as the monthly report, so
 * a date range covering a whole month must equal computeDailyReport for that month, and the weeks must add up to the range they cover.
 * Hours are re-derived with a plain loop. On the newest real backup and on random books.
 *   node tests/week-income-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 12) console.error('❌ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// ── dates: Sunday-based weeks, no drift over the clock change (25.10.2026), month and year ends, leap day
const dow = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
expect(app.weekStartISO('2026-10-23') === '2026-10-18' && dow('2026-10-18') === 0, 'Friday 23.10.2026 → Sunday 18.10');
expect(app.weekStartISO('2026-10-24') === '2026-10-18', 'Saturday is the last day of the week');
expect(app.weekStartISO('2026-10-25') === '2026-10-25', 'Sunday starts its own week (the day the clocks change)');
expect(app.weekStartISO('2026-10-31') === '2026-10-25' && app.weekStartISO('2026-11-01') === '2026-11-01', 'week across the end of the month');
expect(app.weekStartISO('2027-01-01') === '2026-12-27', 'week across the new year');
expect(app.addDaysISO('2028-02-28', 1) === '2028-02-29' && app.addDaysISO('2028-02-29', 1) === '2028-03-01' && app.addDaysISO('2026-10-24', 1) === '2026-10-25' && app.addDaysISO('2026-03-27', 1) === '2026-03-28', 'addDaysISO');
for (let i = 0, d = '2024-12-20'; i < 900; i++, d = app.addDaysISO(d, 1)) {
  if (app.weekStartISO(d) > d || dow(app.weekStartISO(d)) !== 0 || app.addDaysISO(app.weekStartISO(d), 6) < d) { expect(false, 'week of ' + d + ' is wrong'); break; }
}

const reset = () => app.state && (app.state.settlements = []);
const lastDay = pre => new Date(Number(pre.slice(0, 4)), Number(pre.slice(5, 7)), 0).getDate();
function check(txs, today, label) {
  app.state.tx = txs; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {};
  // 1. a whole month = the monthly report
  const months = [...new Set(txs.map(t => String(t.date || '').slice(0, 7)).concat(txs.map(t => String(t.paidDate || '').slice(0, 7))).filter(m => /^\d{4}-\d{2}$/.test(m)))].slice(-6);
  for (const pre of months) {
    const f = app.cashPeriodFigures(pre + '-01', pre + '-' + String(lastDay(pre)).padStart(2, '0')), r = app.computeDailyReport(pre + '-01');
    expect(near(f.collected, r.monthIncome) && near(f.expenses, r.monthExpenses) && near(f.materials, r.monthMaterials) && near(f.net, r.monthNet), `${label} ${pre}: range ${JSON.stringify([f.collected, f.expenses, f.materials, f.net])} vs report ${JSON.stringify([r.monthIncome, r.monthExpenses, r.monthMaterials, r.monthNet])}`);
  }
  // 2. the weeks add up to the range they cover, and each equals the same range computed directly
  const n = 14, weeks = app.weeklyFigures(today, n), from = weeks[0].start, to = weeks[n - 1].end;
  expect(weeks.length === n && weeks[n - 1].current && weeks.slice(0, -1).every(w => !w.current), `${label}: week list shape`);
  expect(weeks.every((w, i) => dow(w.start) === 0 && w.end === (i === n - 1 ? today : app.addDaysISO(w.start, 6)) && (i === 0 || w.start === app.addDaysISO(weeks[i - 1].start, 7))) && today >= weeks[n - 1].start, `${label}: weeks are consecutive Sunday–Saturday and the last one holds today`);
  const whole = app.cashPeriodFigures(from, to);
  let sum = { collected: 0, partners: 0, gross: 0, expenses: 0, materials: 0, minutes: 0, jobs: 0, noHours: 0, workMine: 0, paid: 0, open: 0, paidGross: 0, openGross: 0 };
  weeks.forEach(w => {
    const d = app.cashPeriodFigures(w.start, w.end);
    for (const k of ['collected', 'partners', 'gross', 'expenses', 'materials', 'net', 'workMine', 'paid', 'open', 'paidGross', 'openGross']) expect(near(w[k], d[k]), `${label} week ${w.start}: ${k} ${w[k]} vs ${d[k]}`);
    for (const k of ['minutes', 'jobs', 'noHours']) expect(w[k] === d[k], `${label} week ${w.start}: ${k} ${w[k]} vs ${d[k]}`);
    for (const k of Object.keys(sum)) sum[k] += w[k];
    expect(near(w.gross - w.partners, w.collected) && near(w.net, w.gross - w.partners - w.expenses - w.materials), `${label} week ${w.start}: נכנס − יצא = ביד`);
    // 3. hours and jobs by a plain loop
    let min = 0, jobs = 0, noh = 0;
    for (const t of txs) { if (t.type !== 'income' || !app.isDoneTx(t)) continue; const dd = t.date || ''; if (dd >= w.start && dd <= w.end) { const m = Math.max(0, Math.round((Number(t.hours) || 0) * 60)); min += m; jobs++; if (!m) noh++; } }
    // WORK-DATE basis (26.10), re-derived with plain loops: every job DONE in the week counts, paid or not — a customer's full total, a partner customer's my-share —
    // and the paid / open split uses the money really received
    let gross = 0, income = 0, partners = 0, paidG = 0, paidMine = 0;
    for (const t of txs) {
      if (t.type !== 'income' || !app.isDoneTx(t) || !(t.date >= w.start && t.date <= w.end)) continue;
      const total = Number(t.total) || 0, pa = Number(t.partnerAmount) || 0, mine = total - pa, partnerOwned = t.whoseCustomer === 'partner';
      gross += partnerOwned ? mine : total; income += mine; partners += partnerOwned ? 0 : pa;
      paidG += partnerOwned ? app.collectedYehudaShare(t) : app.collectedAmount(t); paidMine += app.collectedYehudaShare(t);
    }
    expect(near(w.collected, income) && near(w.partners, partners) && near(w.paid, paidMine) && near(w.open, income - paidMine) && near(w.paidGross, paidG) && near(w.openGross, gross - paidG), `${label} week ${w.start}: income/partners/paid/open vs independent`);
    expect(near(w.gross, gross), `${label} week ${w.start}: נכנס ${w.gross} vs independent ${gross}`);
    expect(w.minutes === min && w.jobs === jobs && w.noHours === noh, `${label} week ${w.start}: hours/jobs ${w.minutes}/${w.jobs}/${w.noHours} vs loop ${min}/${jobs}/${noh}`);
  });
  for (const k of Object.keys(sum)) expect(near(sum[k], whole[k]), `${label}: weeks add up to the range — ${k} ${sum[k]} vs ${whole[k]}`);
  // 4. this week so far vs last week up to the same weekday
  const c = app.homeWeekCompare(today), start = app.weekStartISO(today), d = dow(today);
  expect(c.start === start && c.dow === d && c.prevStart === app.addDaysISO(start, -7) && c.prevTo === app.addDaysISO(c.prevStart, d), `${label}: compare windows`);
  const a = app.cashPeriodFigures(start, today), b = app.cashPeriodFigures(c.prevStart, c.prevTo);
  expect(near(c.cur.collected, a.collected) && near(c.prev.collected, b.collected) && c.cur.minutes === a.minutes && c.prev.minutes === b.minutes, `${label}: compare figures`);
  expect(c.hoursDiff === a.minutes - b.minutes && (c.hoursPct === null ? !(b.minutes > 0) : c.hoursPct === Math.round((a.minutes - b.minutes) / b.minutes * 100)), `${label}: hours diff/pct`);
  expect(near(c.diff, a.collected - b.collected) && (c.pct === null ? !(b.collected > 0.5) : c.pct === Math.round((a.collected - b.collected) / b.collected * 100)), `${label}: money diff/pct`);
  // 5. months: the monthly buckets equal the monthly report; the category table adds up to the monthly expenses; the tab prints no NaN
  const ms = app.monthlyFigures(today, 8);
  expect(ms.length === 8 && ms[7].current && ms[7].key === today.slice(0, 7), `${label}: month list shape`);
  ms.forEach(b => { const r = app.computeDailyReport(b.key + '-01'); expect(near(b.collected, r.monthIncome) && near(b.expenses, r.monthExpenses) && near(b.materials, r.monthMaterials) && near(b.net, r.monthNet), `${label} ${b.key}: month bucket vs report`); });
  const cat = app.expenseMonthTable(ms.map(b => b.key));
  ms.forEach((b, i) => expect(near(cat.reduce((a, c) => a + c.by[i], 0), b.expenses), `${label} ${b.key}: expense categories add up to the month`));
  expect(near(cat.reduce((a, c) => a + c.total, 0), ms.reduce((a, b) => a + b.expenses, 0)), `${label}: category totals`);
  const ck = app.expenseChecks(today);
  expect(ck.total === txs.filter(t => t.type === 'expense').length && ck.noDate.every(t => !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')), `${label}: expense checks`);
  for (const mode of ['months', 'weeks']) expect(!/NaN|undefined|Infinity/.test(app.periodsTabHTML(mode)), `${label}: ${mode} tab is clean`);
  // 6. the copyable message uses the same numbers
  const wc = app.weekSummaryCompare(today), msg = app.buildWeekly(today);
  expect(msg.includes('נכנס (עבודות שבוצעו): ' + app.fmt(wc.cur.gross) + '₪') && msg.includes('סה"כ רווח: ' + app.fmt(wc.cur.net) + '₪') && !/NaN|undefined/.test(msg), `${label}: message carries the week's figures`);
  expect(near(wc.cur.gross - (wc.cur.partners + wc.cur.expenses + wc.cur.materials), wc.cur.net), `${label}: message figures reconcile`);
  if (dow(today) === 0) expect(wc.to === app.addDaysISO(wc.start, 6) && wc.start === app.addDaysISO(app.weekStartISO(today), -7), `${label}: on a Sunday the message covers the week that just ended`);
  else expect(wc.start === app.weekStartISO(today) && wc.to === today, `${label}: message covers this week up to today`);
}
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (files.length) { const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')); const txs = d.tx || (d.data && d.data.tx) || []; for (const today of ['2026-10-12', '2026-10-18', '2026-10-24', '2026-10-25']) check(JSON.parse(JSON.stringify(txs)), today, 'real ' + today); expect(txs.length > 0, 'real backup has transactions'); }
let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const day = () => app.addDaysISO('2026-06-01', Math.floor(rnd() * 150));
for (let i = 0; i < 40; i++) {
  const txs = Array.from({ length: 80 }, (_, j) => {
    const type = rnd() < 0.8 ? 'income' : 'expense', stage = type === 'expense' ? 'paid' : ['paid', 'unpaid', 'partial', 'scheduled', 'cancelled'][Math.floor(rnd() * 5)], date = day();
    return { id: 'r' + i + '_' + j, type, stage, date, paidDate: rnd() < 0.7 ? app.addDaysISO(date, Math.floor(rnd() * 20)) : '', total: Math.round(rnd() * 2000), paidAmount: stage === 'partial' ? Math.round(rnd() * 800) : undefined,
      materials: rnd() < 0.3 ? Math.round(rnd() * 500) : 0, hours: rnd() < 0.6 ? Math.round(rnd() * 80) / 10 : 0, whoseCustomer: rnd() < 0.2 ? 'partner' : 'mine', partnerName: rnd() < 0.2 ? 'אהרן' : '', partnerAmount: rnd() < 0.2 ? Math.round(rnd() * 800) : 0 };
  });
  check(txs, app.addDaysISO('2026-08-01', Math.floor(rnd() * 90)), 'rand' + i);
}
// the current week stops at today (rows dated later are not in it); the message's partner names add up to its "partners" figure; null percentages sort last
{
  const TODAY = '2026-10-26';   // Monday
  app.state.tx = [
    { id: 'f1', type: 'income', stage: 'paid', date: '2026-10-29', paidDate: '2026-10-28', total: 100, partnerAmount: 30, whoseCustomer: 'mine', partnerName: 'אהרן' },
    { id: 'f2', type: 'income', stage: 'paid', date: '2026-10-25', paidDate: '2026-10-25', total: 200, partnerAmount: 100, whoseCustomer: 'mine', partnerName: '' },
    { id: 'f3', type: 'income', stage: 'paid', date: '2026-10-26', paidDate: '2026-10-26', total: 400, partnerAmount: 100, whoseCustomer: 'mine', partnerName: 'אהרן' }];
  const wk = app.weeklyFigures(TODAY, 3), cur = wk[wk.length - 1];
  expect(cur.end === TODAY && cur.collected === 100 + 300 && cur.partners === 200, `current week stops at today: ${JSON.stringify([cur.end, cur.collected, cur.partners])}`);
  const m = app.buildWeekly(TODAY);
  expect(m.includes('שותפים: ' + app.fmt(200) + '₪') && m.includes('אהרן ' + app.fmt(100) + '₪') && m.includes('ללא שם ' + app.fmt(100) + '₪'), 'partner names in the message add up to the partners figure:\n' + m);
  app.state.config = {}; app.state.tx = [
    { id: 'g1', type: 'income', stage: 'paid', date: '2026-10-20', paidDate: '2026-10-20', total: 100, materials: 10, work: 'א' }, { id: 'g2', type: 'income', stage: 'paid', date: '2026-10-20', paidDate: '2026-10-20', total: 0, work: 'ב' },
    { id: 'g3', type: 'income', stage: 'paid', date: '2026-10-20', paidDate: '2026-10-20', total: 100, materials: 50, work: 'ג' }];
  app.state.config = { workTypeMap: { 'א': 'ק1', 'ב': 'ק2', 'ג': 'ק3' } };
  const order = app.workProfitReport(app.state.tx).cats.map(c => c.cat + ':' + c.pct);
  expect(order.join() === 'ק1:90,ק3:50,ק2:null', 'categories with no percentage come last: ' + order);
}
// THE RULE (Asher 26.10): income belongs to the month/week the WORK was done — paid or not; "paid" only splits it. A late payment never moves it.
{
  app.state.config = {}; app.state.tasks = [];
  const job = o => ({ type: 'income', whoseCustomer: 'mine', partnerName: '', partnerAmount: 0, materials: 0, hours: 1, customer: 'לקוח', work: 'עבודה', ...o });
  app.state.tx = [
    job({ id: 'u1', stage: 'unpaid', date: '2026-09-28', total: 1000 }),                                        // done in September, nothing paid yet
    job({ id: 'p1', stage: 'paid', date: '2026-09-29', paidDate: '2026-10-03', total: 500 }),                     // done in September, paid in October
    job({ id: 'p2', stage: 'partial', date: '2026-10-02', paidDate: '2026-10-05', paidAmount: 200, total: 800 }),  // done in October, 200 of 800 in
    job({ id: 'q1', stage: 'quote', date: '2026-09-30', total: 9999 }), job({ id: 'q2', stage: 'scheduled', date: '2026-09-30', total: 9999 }), job({ id: 'q3', stage: 'cancelled', date: '2026-09-30', total: 9999 }),
    { id: 'x1', type: 'expense', stage: 'paid', date: '2026-10-04', total: 100, category: 'דלק' }];
  const sep = app.cashPeriodFigures('2026-09-01', '2026-09-30'), oct = app.cashPeriodFigures('2026-10-01', '2026-10-31');
  expect(sep.collected === 1500 && sep.paid === 500 && sep.open === 1000 && sep.jobs === 2, `September: income 1500 (the unpaid job counts, the October payment does not move the second one): ${JSON.stringify([sep.collected, sep.paid, sep.open, sep.jobs])}`);
  expect(oct.collected === 800 && oct.paid === 200 && oct.open === 600 && oct.expenses === 100 && oct.net === 700, `October: income 800 (paid 200, open 600), expenses 100: ${JSON.stringify([oct.collected, oct.paid, oct.open, oct.expenses, oct.net])}`);
  const rSep = app.computeDailyReport('2026-09-15'), rOct = app.computeDailyReport('2026-10-15');
  expect(rSep.monthIncome === 1500 && rSep.monthPaid === 500 && rSep.monthOpen === 1000 && rSep.monthNet === 1500, 'the monthly report agrees for September');
  expect(rOct.monthIncome === 800 && rOct.monthPaid === 200 && rOct.monthOpen === 600 && rOct.monthNet === 700, 'the monthly report agrees for October');
  const day = app.computeDailyReport('2026-09-28'); expect(day.dayIncome === 1000 && day.dayPaid === 0 && day.dayOpen === 1000, 'a day counts its unpaid job too');
  // paying the open job later changes "paid", never the month
  app.state.tx.find(t => t.id === 'u1').stage = 'paid'; app.state.tx.find(t => t.id === 'u1').paidDate = '2026-11-20';
  const sep2 = app.cashPeriodFigures('2026-09-01', '2026-09-30'), nov = app.cashPeriodFigures('2026-11-01', '2026-11-30');
  expect(sep2.collected === 1500 && sep2.paid === 1500 && sep2.open === 0 && nov.collected === 0, 'a payment in November leaves September income at 1500 (paid now 1500) and November at 0');
  // gross and partner cut: my customer with a partner cut, and a partner's customer
  app.state.tx = [job({ id: 'm1', stage: 'unpaid', date: '2026-10-10', total: 1000, partnerAmount: 300, partnerName: 'אהרן' }), job({ id: 'm2', stage: 'unpaid', date: '2026-10-11', total: 600, partnerAmount: 400, partnerName: 'אהרן', whoseCustomer: 'partner' })];
  const g = app.cashPeriodFigures('2026-10-01', '2026-10-31');
  expect(g.gross === 1000 + 200 && g.partners === 300 && g.collected === 700 + 200 && g.net === 900, `gross = my customer's total + my share of the partner's customer; partners = the cut on mine: ${JSON.stringify([g.gross, g.partners, g.collected])}`);
}
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('✅ week-income-check: הכנסה ושעות לפי שבוע (ראשון–שבת) — טווח של חודש שלם זהה לדוח החודשי, השבועות מסתכמים לטווח, שעות מחושבות מחדש בנפרד, בלי סטייה בשעון חורף (נתונים אמיתיים + 40 ספרים אקראיים)');
