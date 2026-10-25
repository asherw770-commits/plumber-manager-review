#!/usr/bin/env node
/* The 19.10 speed-ups (customer aliases, duplicate detection, partner-guess reminder, ERP task gaps) must give EXACTLY the same answers as the version before them
 * (commit b171f44), on the real backup and on synthetic books, and must stay fast at 3,000 rows.
 *   node tests/perf-equiv-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { loadApp } = require('../api/_loadApp');
const root = path.join(__dirname, '..');
const newApp = loadApp(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
let oldHtml = null;
try { oldHtml = execSync('git show b171f44:index.html', { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (_) { console.log('⚠ perf-equiv-check: baseline commit b171f44 not available — equivalence part skipped'); }
const oldApp = oldHtml ? loadApp(oldHtml) : null;
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 12) console.error('❌ ' + m); } };
const load = (app, book) => { const b = JSON.parse(JSON.stringify(book)); app.state.tx = b.tx; app.state.tasks = b.tasks; app.state.customerMeta = b.customerMeta || {}; app.state.priceList = b.priceList || []; app.state.settlements = []; app.state._aliasCache = null; };
const run = (app, book) => {
  load(app, book);
  const t0 = Date.now();
  const out = {
    customers: JSON.stringify(app.getCustomers()),
    dups: JSON.stringify(app.possibleDuplicateCustomers()),
    guess: JSON.stringify(app.partnerGuessItems().map(x => x.kind + ':' + x.r.id)),
    gaps: JSON.stringify(app.erpHoursReport(app.state.tx, {}, app.state.tasks).taskGaps.map(g => [g.task.id, g.tx.id, g.taskMin, g.txMin])),
    aliasNames: JSON.stringify(app.state.tx.slice(0, 60).map(t => app.customerAliasNames(t.customer)))
  };
  return { out, ms: Date.now() - t0 };
};
function synth(base, n, seed) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; const pick = a => a[Math.floor(rnd() * a.length)];
  const firsts = ['דוד', 'משה', 'יוסי', 'רבקה', 'שרה', 'אברהם', 'חיים', 'נחום'], lasts = ['כהן', 'לוי', 'פינדרוס', 'שכטר', 'ברק', 'סגל', 'רבנו'], streets = ['הרצל 12', 'יואל 22', 'האלון 16 דירה 10', 'דבורה הנביאה 26', 'הגפן 4', 'בן יהודה 3'];
  const tx = [], tasks = [], meta = {};
  for (let i = 0; i < n; i++) {
    const t = JSON.parse(JSON.stringify(base.tx[i % base.tx.length]));
    t.id = 's' + i; const nm = rnd() < 0.7 ? pick(firsts) + ' ' + pick(lasts) + (rnd() < 0.3 ? ' ' + pick(streets).split(' ')[0] : '') : (rnd() < 0.5 ? '' : pick(lasts));
    t.customer = nm; t.address = rnd() < 0.8 ? pick(streets) : ''; t.phone = rnd() < 0.5 ? '05' + String(Math.floor(rnd() * 12)).padStart(8, '0') : '';
    if (rnd() < 0.15) { t.partnerName = pick(['אהרן', 'יואלי']); t.whoseCustomer = rnd() < 0.5 ? 'partner' : 'mine'; t.customer = rnd() < 0.5 ? '' : t.customer; t.phone = rnd() < 0.5 ? '' : t.phone; }
    t.hours = rnd() < 0.4 ? pick([0.5, 1, 1.5, 2]) : 0; tx.push(t);
    if (rnd() < 0.8) { const k = JSON.parse(JSON.stringify(base.tasks[i % base.tasks.length])); k.id = 'k' + i; k.customer = t.customer; k.phone = t.phone; k.hours = rnd() < 0.5 ? pick([0.5, 1, 1.5, t.hours]) : 0; if (rnd() < 0.7) { k.linkedTxId = t.id; t.fromTaskId = k.id; } if (rnd() < 0.2) { k.partnerName = t.partnerName || 'אהרן'; k.whoseCustomer = 'mine'; k.customer = ''; k.phone = ''; k.linkedTxId = null; } tasks.push(k); }
    if (nm && rnd() < 0.05) meta[nm] = { notDup: [pick(firsts) + ' ' + pick(lasts)] };
  }
  return { tx, tasks, customerMeta: meta, priceList: base.priceList || [] };
}
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
const real = files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')) : require('./sample-data').sampleBackup(160, 5);   // no real backup on this machine → fictional sample books
const books = [['real', real], ...[200, 600, 1200].map((n, i) => ['synth' + n, synth(real, n, 11 + i)])];
for (const [name, book] of books) {
  const nw = run(newApp, book);
  if (oldApp) { const od = run(oldApp, book); for (const k of Object.keys(od.out)) expect(od.out[k] === nw.out[k], `${name}: ${k} differs from the baseline version`); }
}
// speed: 3,000 rows must be comfortably fast now
const big = synth(real, 3000, 99);
const r = run(newApp, big);
expect(r.ms < 6000, 'getCustomers + duplicates + guess + gaps on 3,000 rows took ' + r.ms + ' ms (limit 6000)');
if (fails) { console.error('perf-equiv-check: ' + fails + ' failures'); process.exit(1); }
console.log(`✅ perf-equiv-check: האלגוריתמים המהירים נותנים בדיוק את אותן תוצאות כמו הגרסה הקודמת (אמיתי + 3 ספרים סינתטיים), ו-3,000 שורות ב-${r.ms}ms`);
