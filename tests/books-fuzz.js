#!/usr/bin/env node
/* Money-engine fuzz: random books (partners, partial payments, settlements, quotes,
 * cancelled/scheduled jobs, expenses …) run through the REAL app code, asserting
 * that every figure the screens show agrees with the row-by-row truth
 * (reconcile(): 7 cross-screen checks) and that per-row money invariants hold:
 *   – collected ≤ total, pending ≥ 0, collected + pending = total
 *   – the partner's share + Yehuda's share = total
 *   – nothing owed to a partner exceeds what was collected for him
 * calc-check.js pins the numbers of REAL data; this finds the odd combinations
 * real data hasn't hit yet.
 *   node tests/books-fuzz.js [sets=1500] [firstSeed=1]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');

const SETS = Number(process.argv[2]) || 1500;
const FIRST = Number(process.argv[3]) || 1;
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
const inCtx = code => vm.runInContext(code, app);

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const PARTNERS = ['אהרן', 'שלומי', 'יואלי', 'כרומגן'];
const CUSTOMERS = ['משה', 'דוד', 'רחל', 'לוי', '', 'חנן', 'מרים'];
const STAGES = ['unpaid', 'unpaid', 'partial', 'paid', 'paid', 'paid', 'quote', 'scheduled', 'cancelled'];

function makeBooks(seed) {
  const R = rng(seed), pick = a => a[Math.floor(R() * a.length)];
  const money = (max) => Math.round(R() * max * 100) / 100;
  const rows = [];
  const n = 8 + Math.floor(R() * 30);
  for (let i = 0; i < n; i++) {
    const id = 'f' + seed + '_' + i;
    if (R() < 0.12) { rows.push({ id, type: 'expense', total: money(900), date: '2026-09-' + String(1 + Math.floor(R() * 28)).padStart(2, '0'), category: 'דלק' }); continue; }
    const total = R() < 0.05 ? 0 : (R() < 0.3 ? Math.round(R() * 20) * 100 : money(9000));
    const partner = R() < 0.5 ? pick(PARTNERS) : '';
    const whose = partner && R() < 0.55 ? 'partner' : 'mine';
    const t = {
      id, type: 'income', total, customer: pick(CUSTOMERS), phone: R() < 0.7 ? '05' + Math.floor(10000000 + R() * 89999999) : '',
      date: '2026-0' + (7 + Math.floor(R() * 4)) + '-' + String(1 + Math.floor(R() * 28)).padStart(2, '0'),
      work: 'עבודה', materials: R() < 0.4 ? money(total * 0.3) : 0, whoseCustomer: whose, notes: '',
      partnerName: partner, partnerAmount: partner ? (R() < 0.15 ? 0 : money(total)) : 0,
    };
    if (t.partnerAmount > t.total) t.partnerAmount = t.total;     // the edit form refuses a partner share above the total
    const stage = pick(STAGES);
    app.applyTxStage(t, stage);
    if (stage === 'paid') { t.paidDate = '2026-09-' + String(1 + Math.floor(R() * 28)).padStart(2, '0'); }
    if (stage === 'partial') { t.paidAmount = Math.min(total, Math.max(0.01, Math.round(R() * total * 100) / 100)); t.paidDate = '2026-09-15'; if (total === 0) app.applyTxStage(t, 'unpaid'); }
    if (partner && (stage === 'paid' || stage === 'partial')) t.partnerCollected = whose === 'partner';
    if (partner && stage === 'paid' && whose === 'mine' && t.partnerCollected === false && R() < 0.4) t.settledPartnerAmount = money(t.partnerAmount);
    rows.push(t);
  }
  return rows;
}

let bad = 0, shown = 0;
const origWarn = console.warn; console.warn = () => {};
for (let seed = FIRST; seed < FIRST + SETS; seed++) {
  const rows = makeBooks(seed);
  app.state.tx = rows; app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {};
  inCtx('_reconCache = null; _reconSig = ""; _aliasCache = null;');
  const problems = [];
  let rec;
  try { rec = app.reconcile(); } catch (e) { problems.push('reconcile threw: ' + e.message); }
  if (rec) rec.checks.filter(c => !c.ok).forEach(c => problems.push(`screens disagree on "${c.name}": truth ${c.truth} vs ` + c.vals.filter(v => Math.abs(v.gap) >= 0.01).map(v => `${v.where}=${v.value}`).join('; ')));
  rows.filter(t => t.type === 'income').forEach(t => {
    const total = Number(t.total) || 0, col = app.collectedAmount(t), pend = app.pendingAmount(t);
    const pipeline = app.isPipelineTx(t);
    const inv = app.txInvariantIssues(t); if (inv.length) problems.push(`${t.id}: invariant ${inv.join(', ')}`);
    if (col < -0.001 || col > total + 0.001) problems.push(`${t.id}: collected ${col} outside 0..${total}`);
    if (pend < -0.001) problems.push(`${t.id}: negative pending ${pend}`);
    if (!pipeline && Math.abs(col + pend - total) > 0.011) problems.push(`${t.id}: collected ${col} + pending ${pend} != total ${total}`);
    if (!pipeline) {
      const mine = app.yehudaShare(t), her = Number(t.partnerAmount) || 0;
      if (Math.abs(mine + her - total) > 0.011) problems.push(`${t.id}: shares ${mine}+${her} != total ${total}`);
      const owed = app.owedToPartnerNow(t);
      if (owed < -0.001) problems.push(`${t.id}: negative owed to partner ${owed}`);
      if (owed > col + 0.011 && t.whoseCustomer !== 'partner') problems.push(`${t.id}: owes the partner ${owed} but only collected ${col}`);
      const yp = app.yehudaPending(t);
      if (yp < -0.001 || yp > total + 0.011) problems.push(`${t.id}: yehudaPending ${yp} outside 0..${total}`);
    }
  });
  if (problems.length) { bad++; if (shown++ < 8) { console.error(`❌ books seed ${seed}: ${problems.length} problem(s)`); problems.slice(0, 3).forEach(p => console.error('    ' + p)); } }
}
console.warn = origWarn;
if (bad) { console.error(`books-fuzz: ${bad} of ${SETS} random books broke a money invariant`); process.exit(1); }
console.log(`✅ books-fuzz: ${SETS} ספרים אקראיים — כל מסכי הכסף מסכימים והסכומים לכל עסקה עקביים`);
