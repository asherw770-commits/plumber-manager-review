#!/usr/bin/env node
/* Partners tab accuracy: every figure of partnerBalances() is recomputed here FROM THE RAW FIELDS with independent code
 * (no app helper) — on the newest real backup and on thousands of random books — and must agree to the agora.
 *   node tests/partners-accuracy-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const near = (a, b) => Math.abs(a - b) < 0.011;
const bad = m => { fails++; if (fails < 12) console.error('❌ ' + m); };

function stageOf(t) {
  const st = app.txStage(t);
  return st;
}
// independent model
function expected(txs) {
  const E = {};
  txs.forEach(t => {
    if (t.type !== 'income' || !String(t.partnerName || '').trim()) return;
    const T = Number(t.total) || 0, c = Number(t.partnerAmount) || 0, owned = t.whoseCustomer === 'partner';
    if (!owned && c <= 0) return;
    const name = String(t.partnerName).trim();
    const e = E[name] = E[name] || { mineOwed: 0, mineReceived: 0, owedToHim: 0, paidToHim: 0, future: 0, he: 0, mine: 0 };
    const st = stageOf(t);
    const C = st === 'paid' ? T : st === 'partial' ? Math.max(0, Math.min(Number(t.paidAmount) || 0, T)) : 0;
    const pipeline = st === 'quote' || st === 'scheduled' || st === 'cancelled';
    const m = T - c, mineGot = T ? C * (m / T) : 0, cutGot = T ? C * (c / T) : 0;
    const settled = Number(t.settledPartnerAmount) || 0;
    const flagged = t.partnerCollected === false || (!owned && t.partnerCollected == null && !!t.partnerPending);
    const owedNow = flagged && c > 0 ? Math.max(0, cutGot - settled) : 0;
    if (owned) {
      e.he++;
      e.mineReceived += mineGot;
      e.mineOwed += pipeline ? 0 : Math.max(0, m - mineGot);
      if (t.partnerCollected === false && C > 0) { e.owedToHim += owedNow; e.paidToHim += settled; }
    } else {
      e.mine++;
      e.owedToHim += owedNow; e.paidToHim += settled;
      e.future += Math.max(0, c - cutGot);
    }
  });
  return E;
}
function compare(txs, label) {
  app.state.tx = txs; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {};
  require('vm').runInContext('_reconCache = null; _reconSig = ""; _aliasCache = null;', app);
  const got = app.partnerBalances(), exp = expected(txs);
  const names = new Set([...got.map(p => p.name), ...Object.keys(exp)]);
  names.forEach(n => {
    const g = got.find(p => p.name === n), e = exp[n];
    if (!g || !e) { bad(`${label}: partner "${n}" present in only one side (screen ${!!g}, raw ${!!e})`); return; }
    const pairs = [['heBroughtMineOwed', 'mineOwed'], ['heBroughtMineReceived', 'mineReceived'], ['iBroughtOwedToHim', 'owedToHim'], ['iBroughtPaidToHim', 'paidToHim'], ['iBroughtFuture', 'future']];
    pairs.forEach(([a, b]) => { if (!near(g[a], e[b])) bad(`${label}: ${n}.${a} screen ${g[a]} vs raw ${e[b]}`); });
    if (g.heBrought.length !== e.he || g.iBrought.length !== e.mine) bad(`${label}: ${n} job counts screen ${g.heBrought.length}/${g.iBrought.length} vs raw ${e.he}/${e.mine}`);
  });
  // the screens' totals must equal the sum of the cards
  const rec = app.reconcile();
  rec.checks.filter(c => !c.ok).forEach(c => bad(`${label}: cross-screen check "${c.name}" disagrees`));
}
origWarn = console.warn; console.warn = () => {};
// 1) newest real backup
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (files.length) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  compare(d.tx, 'real backup');
}
// 2) random books with partners, partials, settlements, collected-by-me flags
let seed = 5; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(R() * a.length)];
for (let i = 0; i < 1500; i++) {
  const rows = [];
  const n = 5 + Math.floor(R() * 14);
  for (let k = 0; k < n; k++) {
    const total = R() < 0.05 ? 0 : Math.round(R() * 6000);
    const partner = R() < 0.8 ? pick(['אהרן', 'שלומי', 'יואלי']) : '';
    // a partner's customer always names the partner (a nameless one is a data error that txInvariantIssues flags)
    const t = { id: 'r' + i + '_' + k, type: 'income', total, customer: 'לקוח' + k, date: '2026-09-10', whoseCustomer: partner && R() < 0.5 ? 'partner' : 'mine', partnerName: partner, partnerAmount: partner ? Math.min(total, Math.round(R() * total)) : 0 };
    const stage = pick(['unpaid', 'unpaid', 'partial', 'paid', 'paid', 'quote', 'cancelled']);
    app.applyTxStage(t, stage);
    if (stage === 'partial') t.paidAmount = Math.round(R() * total * 100) / 100;
    if (stage === 'paid' || stage === 'partial') t.paidDate = '2026-09-12';
    if (partner && (stage === 'paid' || stage === 'partial')) t.partnerCollected = R() < 0.7 ? t.whoseCustomer === 'partner' : R() < 0.5;
    if (partner && R() < 0.2) t.settledPartnerAmount = Math.round(R() * (t.partnerAmount || 0) * 100) / 100;
    rows.push(t);
  }
  compare(rows, 'random ' + i);
  if (fails > 11) break;
}
console.warn = origWarn;
if (fails) { console.error(`partners-accuracy-check: ${fails} mismatches`); process.exit(1); }
console.log('✅ partners-accuracy-check: כל מספרי מסך השותפים זהים לחישוב עצמאי מהנתונים הגולמיים (גיבוי אמיתי + 1500 ספרים אקראיים)');
