#!/usr/bin/env node
/* Money-calculation gate (Asher 29.9 — "דיוק מלא").
 *
 *   node tests/calc-check.js            fixed cases only
 *   node tests/calc-check.js --ci       + old-vs-new on real data (pre-push hook)
 *
 * 1) FIXED CASES — a small hand-computed data set (every scenario the money
 *    rules distinguish). Each figure is asserted to the agorot.
 * 2) OLD vs NEW — every money figure is computed by the code now live
 *    (origin/main) and by the code being pushed (HEAD), on the newest daily
 *    backup in ~/Downloads and on the fixed data. Any difference blocks the
 *    push. After Asher approves a deliberate change:  ALLOW_CHANGE=1 git push
 *
 * The app is one HTML file; this loads its top-level functions (and the few
 * constants they use) into a sandbox — nothing touches the DOM or Firebase.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { loadApp } = require('../api/_loadApp');

const APP_DIR = path.join(__dirname, '..');

// ── Fixed data (hand-computed expectations in the comments) ──
const FIX = [
  { id: 'T1', type: 'income', stage: 'paid', customer: 'לקוח 1', total: 1000, materials: 100, date: '2026-09-05', paidDate: '2026-09-06' },
  { id: 'T2', type: 'income', stage: 'unpaid', customer: 'לקוח 2', total: 800, materials: 50, date: '2026-09-10' },
  { id: 'T3', type: 'income', stage: 'partial', paidAmount: 300, customer: 'לקוח 3', total: 900, date: '2026-09-12', paidDate: '2026-09-12' },
  { id: 'T4', type: 'income', stage: 'paid', customer: 'לקוח 4', partnerName: 'שלומי', partnerAmount: 400, partnerCollected: false, total: 1000, date: '2026-08-20', paidDate: '2026-08-22' },
  { id: 'T5', type: 'income', stage: 'partial', paidAmount: 450, customer: 'לקוח 5', partnerName: 'שלומי', partnerAmount: 300, partnerCollected: false, settledPartnerAmount: 100, total: 900, date: '2026-09-15', paidDate: '2026-09-15' },
  { id: 'T6', type: 'income', stage: 'unpaid', customer: 'לקוח 6', partnerName: 'אהרן', whoseCustomer: 'partner', partnerAmount: 700, total: 1000, date: '2026-09-01' },
  { id: 'T7', type: 'income', stage: 'paid', customer: 'לקוח 7', partnerName: 'אהרן', whoseCustomer: 'partner', partnerAmount: 800, partnerCollected: true, total: 1200, date: '2026-08-10', paidDate: '2026-08-12' },
  { id: 'T8', type: 'income', stage: 'partial', paidAmount: 500, customer: 'לקוח 8', partnerName: 'אהרן', whoseCustomer: 'partner', partnerAmount: 600, partnerCollected: false, total: 1000, date: '2026-09-20', paidDate: '2026-09-20' },
  { id: 'T9', type: 'income', stage: 'quote', customer: 'לקוח 9', total: 2000, date: '2026-09-25' },
  { id: 'T10', type: 'income', stage: 'cancelled', customer: 'לקוח 10', total: 500, date: '2026-09-26' },
  { id: 'T11', type: 'income', stage: 'scheduled', customer: 'לקוח 11', total: 700, date: '2026-09-28' },
  { id: 'T12', type: 'income', stage: 'partial', paidAmount: 300, customer: 'לקוח 12', total: 900, date: '2026-08-25', paidDate: '2026-09-02' },
  { id: 'E1', type: 'expense', total: 250, date: '2026-09-03', category: 'דלק' },
  { id: 'E2', type: 'expense', total: 120, date: '2026-08-15', category: 'כלים' },
];
const EXPECT = [
  // per row: [id, collectedYehudaShare, yehudaPending, owedToPartnerNow, partnerCutStillToCome]
  ['row', 'T1', 1000, 0, 0, 0], ['row', 'T2', 0, 800, 0, 0], ['row', 'T3', 300, 600, 0, 0],
  ['row', 'T4', 600, 0, 400, 0], ['row', 'T5', 300, 450, 50, 150], ['row', 'T6', 0, 300, 0, 0],
  ['row', 'T7', 400, 0, 0, 0], ['row', 'T8', 200, 200, 300, 0],
  ['row', 'T9', 0, 0, 0, 0], ['row', 'T10', 0, 0, 0, 0], ['row', 'T11', 0, 0, 0, 0], ['row', 'T12', 300, 600, 0, 0],
  // all-time
  ['stats.paidYehuda', 3100], ['stats.pendingTotal', 2950], ['stats.totalExpenses', 370], ['stats.totalMaterials', 150], ['stats.netExpected', 5380],
  // cash basis per month
  ['month 2026-09 income', 2100], ['month 2026-09 net', 1700], ['month 2026-09 materials', 150], ['month 2026-09 expenses', 250], ['month 2026-09 gross', 2550], ['month 2026-09 partnerCut', 450],
  ['month 2026-08 income', 1000], // T12's 300 is NOT here — it arrived 2.9 (partial payment by cash date) ['month 2026-08 net', 880], ['month 2026-08 materials', 0], ['month 2026-08 expenses', 120], ['month 2026-08 gross', 1000], ['month 2026-08 partnerCut', 400],
  // partners screen
  ['partner שלומי owedToHim', 450], ['partner שלומי paidToHim', 100], ['partner שלומי future', 150],
  ['partner אהרן owesMe', 500], ['partner אהרן received', 600], ['partner אהרן owedToHim', 300],
  // סיכום כספי — full summary panels (restored 30.9)
  ['report.gross', 3650], ['report.partnerCut', 550], ['report.mine', 3100], ['report.materials', 150], ['report.expenses', 370],
  ['report.totalIn', 3650], ['report.totalOut', 1070], ['report.net', 2580], ['report.snapNet', 2580], ['report.kpiNet', 2580],
  ['report.pipeMine', 2300], ['report.pipePartners', 500], ['report.openBalance', 2950],
  // מאזן רווח והפסד (1.10): jobs done in the period, full amounts — T1..T8 + T12
  ['report.allMine', 5500], ['report.allMinePaid', 3050], ['report.allMineOpen', 2450],       // T1 T2 T3 T4 T5 T12 · collected 1000+0+300+1000+450+300
  ['report.allPartners', 1100], ['report.allPartnersPaid', 600], ['report.allPartnersOpen', 500], // my share 300+400+400 · collected 0+400+200
  ['report.allIn', 6600], ['report.allToPartners', 700], ['report.allOut', 1220],               // partners' cut on my jobs: T4 400 + T5 300
  ['report.allNet', 5380], ['report.handNet', 2580],                                            // = stats.netExpected · = report.net
  // reconciliation
  ['recon gaps', 0], ['recon gaps with a dateless paid row', 3], // נגבה + רווח נקי + השורה עצמה
];

const LABELS = {}; // row id → "customer · work · date" for readable reports
function figures(app, rows) {
  const clone = JSON.parse(JSON.stringify(rows));
  clone.forEach(t => { LABELS[t.id] = [t.customer || t.partnerName, t.work, t.date].filter(Boolean).join(' · ') || t.id; });
  app.state.tx = clone; app.state.tasks = []; app.state.customerMeta = {}; app._reconCache = null; app._aliasCache = null;
  const f = {};
  const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
  // These four are load-bearing for the whole gate (partner balances, customer
  // debts, the money summary, the reconciliation check itself) — if the HTML
  // extraction ever fails to pull one in (a rename, a brace pattern the
  // regex-based loader in loadApp() doesn't recognize), that's exactly the
  // kind of silent gap the gate exists to catch, not something to skip past.
  const has = n => {
    if (typeof app[n] === 'function') return true;
    console.error(`⛔ שער: הפונקציה ${n} לא נטענה מה-HTML — נבדק כאילו לא קיימת, זה עצמו כשל`);
    process.exitCode = 1;
    return false;
  };
  clone.forEach(t => {
    f[`row ${t.id} stage`] = app.txStage(t);
    if (t.type !== 'income') return;
    f[`row ${t.id} collectedMine`] = r2(app.collectedYehudaShare(t));
    f[`row ${t.id} pending`] = r2(app.yehudaPending(t));
    f[`row ${t.id} owedToPartner`] = r2(app.owedToPartnerNow(t));
    f[`row ${t.id} partnerFuture`] = r2(app.partnerCutStillToCome(t));
  });
  const all = app.computeStats('all');
  ['paidYehuda', 'pendingTotal', 'totalExpenses', 'totalMaterials', 'totalPartnersPending', 'totalPartnersPaid', 'netExpected'].forEach(k => { f['stats.' + k] = r2(all[k]); });
  app.getAllMonths().forEach(m => {
    const d = app.computeDailyReport(`${m}-01`);
    f[`month ${m} income`] = r2(d.monthIncome); f[`month ${m} net`] = r2(d.monthNet); f[`month ${m} materials`] = r2(d.monthMaterials);
    f[`month ${m} expenses`] = r2(d.monthExpenses); f[`month ${m} gross`] = r2(d.monthGross); f[`month ${m} partnerCut`] = r2(d.monthPartnerCut);
    const s = app.computeStats(m);
    f[`statsMonth ${m} paidYehuda`] = r2(s.paidYehuda); f[`statsMonth ${m} pendingTotal`] = r2(s.pendingTotal); f[`statsMonth ${m} netExpected`] = r2(s.netExpected);
  });
  if (has('partnerBalances')) app.partnerBalances().forEach(p => {
    f[`partner ${p.name} owedToHim`] = r2(p.iBroughtOwedToHim); f[`partner ${p.name} paidToHim`] = r2(p.iBroughtPaidToHim);
    f[`partner ${p.name} future`] = r2(p.iBroughtFuture); f[`partner ${p.name} owesMe`] = r2(p.heBroughtMineOwed); f[`partner ${p.name} received`] = r2(p.heBroughtMineReceived);
  });
  if (has('getCustomers')) {
    const debt = {};
    clone.filter(t => app.isOpenDebtTx(t)).forEach(t => { const c = app.canonicalCustomer ? app.canonicalCustomer(t.customer) : (t.customer || ''); debt[c] = (debt[c] || 0) + app.yehudaPending(t); });
    Object.entries(debt).forEach(([c, v]) => { f[`customer ${c || '(בלי שם)'} owes`] = r2(v); });
  }
  if (has('reportFigures')) { const F = app.reportFigures('all').F; ['gross', 'partnerCut', 'mine', 'materials', 'expenses', 'totalIn', 'totalOut', 'net', 'snapNet', 'kpiNet', 'pipeMine', 'pipePartners', 'openBalance', 'allMine', 'allMinePaid', 'allMineOpen', 'allPartners', 'allPartnersPaid', 'allPartnersOpen', 'allIn', 'allToPartners', 'allOut', 'allNet', 'handNet'].forEach(k => { if (k in F) f['report.' + k] = r2(F[k]); }); }
  if (has('reconcile')) { const r = app.reconcile(); f['recon gaps'] = r.gaps; r.checks.forEach(c => { f['recon ' + c.name] = c.truth; }); }
  return f;
}

function runFixed(app) {
  const f = figures(app, FIX);
  const fails = [];
  const eq = (label, got, want) => { if (Math.abs((Number(got) || 0) - want) > 0.005) fails.push(`${label}: קיבלתי ${got}, צריך ${want}`); };
  EXPECT.forEach(e => {
    if (e[0] === 'row') {
      const [, id, cm, pend, owe, fut] = e;
      eq(`${id} נגבה (שלי)`, f[`row ${id} collectedMine`], cm); eq(`${id} חייבים לי`, f[`row ${id} pending`], pend);
      eq(`${id} חייב לשותף`, f[`row ${id} owedToPartner`], owe); eq(`${id} לשותף בעתיד`, f[`row ${id} partnerFuture`], fut);
    } else if (e[0] === 'recon gaps with a dateless paid row') {
      const g = figures(app, FIX.concat([{ id: 'X1', type: 'income', stage: 'paid', customer: 'בלי תאריך', total: 300, date: '', paidDate: '' }]))['recon gaps'];
      eq(e[0], g, e[1]);
    } else eq(e[0], f[e[0]], e[1]);
  });
  // legacy rows (before the single `stage` field) map to the same stage
  const legacy = [[{ type: 'income', status: 'paid' }, 'paid'], [{ type: 'income', status: 'partial', lifecycleStatus: 'completed' }, 'partial'],
    [{ type: 'income', status: 'unpaid', lifecycleStatus: 'quote' }, 'quote'], [{ type: 'income', lifecycleStatus: 'completed' }, 'unpaid'], [{ type: 'expense' }, 'paid']];
  legacy.forEach(([t, want]) => { const got = app.txStage(t); if (got !== want) fails.push(`txStage(${JSON.stringify(t)}): ${got} ≠ ${want}`); });
  return fails;
}

function compare(label, a, b) {
  const diffs = [];
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => {
    if (!(k in a) || !(k in b)) return; // a figure only one version knows — not a change
    const x = a[k], y = b[k];
    const same = typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 0.005 : x === y;
    const nice = k.replace(/^row (\S+)/, (_, id) => `עסקה "${LABELS[id] || id}"`);
    if (!same) diffs.push(`${label} · ${nice}: היה ${x} → עכשיו ${y}`);
  });
  return diffs;
}

function newestBackup() {
  const dir = path.join(os.homedir(), 'Downloads');
  try {
    const files = fs.readdirSync(dir).filter(n => /גיבוי.*\.json$/.test(n)).map(n => path.join(dir, n));
    files.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
    // Skip the demo copy's backups (sample data, exported by demo@example.com).
    return files.find(f => { try { return !/demo@/.test(JSON.parse(fs.readFileSync(f, 'utf8')).exportedBy || ''); } catch (_) { return false; } }) || null;
  } catch (_) { return null; }
}

function main() {
  const ci = process.argv.includes('--ci');
  const git = cmd => execSync(cmd, { cwd: APP_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const newHtml = ci ? git('git show HEAD:index.html') : fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const app = loadApp(newHtml);
  const fails = runFixed(app);
  // Until the 6.10 switch-off of the legacy status fields: switching them off
  // (what saveState then does to every row) must not move any figure.
  if (newHtml.includes('const TX_LEGACY_MIRROR = true;')) {
    const flip = loadApp(newHtml.replace('const TX_LEGACY_MIRROR = true;', 'const TX_LEGACY_MIRROR = false;'));
    const after = JSON.parse(JSON.stringify(FIX)); after.forEach(t => flip.applyTxStage(t, flip.txStage(t)));
    compare('מעבר 6.10', figures(app, FIX), figures(flip, after)).forEach(d => fails.push(d));
  }
  console.log(fails.length ? `❌ מקרים קבועים: ${fails.length} כשלים` : `✅ מקרים קבועים: ${EXPECT.length} בדיקות עברו`);
  fails.forEach(x => console.log('   ' + x));
  let diffs = [];
  if (ci) {
    let oldHtml = null;
    try { git('git fetch -q origin main'); oldHtml = git('git show origin/main:index.html'); } catch (_) { console.log('⚠️ אין גרסה חיה להשוואה — מדלג'); }
    if (oldHtml) {
      const old = loadApp(oldHtml);
      diffs = diffs.concat(compare('נתוני בדיקה', figures(old, FIX), figures(app, FIX)));
      const bk = newestBackup();
      if (bk) {
        const data = JSON.parse(fs.readFileSync(bk, 'utf8'));
        diffs = diffs.concat(compare('נתונים אמיתיים', figures(old, data.tx || []), figures(app, data.tx || [])));
        console.log(`   (נתונים אמיתיים מ: ${path.basename(bk)} — ${(data.tx || []).length} עסקאות)`);
      } else console.log('⚠️ לא נמצא קובץ גיבוי ב-Downloads — ההשוואה רק על נתוני הבדיקה');
      console.log(diffs.length ? `❌ ${diffs.length} מספרים השתנו לעומת הגרסה החיה:` : '✅ אף מספר לא השתנה לעומת הגרסה החיה');
      diffs.slice(0, 60).forEach(x => console.log('   ' + x));
      if (diffs.length > 60) console.log(`   … ועוד ${diffs.length - 60}`);
    }
  }
  const allow = process.env.ALLOW_CHANGE === '1';
  if (fails.length || (diffs.length && !allow)) {
    if (diffs.length && !fails.length) console.log('\n⛔ העדכון נעצר. אחרי אישור של אשר: ALLOW_CHANGE=1 git push');
    process.exit(1);
  }
  if (diffs.length && allow) console.log('⚠️ השינויים אושרו (ALLOW_CHANGE=1) — ממשיך');
  else if (allow && ci) console.log('   (ALLOW_CHANGE=1 היה מוגדר, אבל לא היה צורך בו — אף מספר לא השתנה)');
}
main();
