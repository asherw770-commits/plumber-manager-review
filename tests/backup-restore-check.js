#!/usr/bin/env node
/* Backup → restore must give back EXACTLY what was backed up — in particular the partner settlements (a restore used to tombstone them) — and the xlsx writer must keep
 * every column and never write characters XML cannot hold (audit 19.10).
 *   node tests/backup-restore-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
// the backup/xlsx helpers live inside an IIFE in index.html (indented two spaces): cut them out by name
function slice(name) { const i = html.indexOf('  function ' + name + '('); if (i < 0) throw new Error(name + ' not found'); const j = html.indexOf('\n  }\n', i); return html.slice(i, j + 5); }
const mk = () => {
  const app = loadApp(html);
  app.state.currentUser = { uid: 'u', email: 'a@x', role: 'admin' }; app.state._deletedIds = []; app.state._deletedAt = {};
  Object.assign(app, { isAdmin: () => true, confirm: () => true, alert: m => { app.__alert = m; }, snapshotState() {}, render() {}, toast() {}, saveState: () => Promise.resolve(), _captureBaseline() {}, todayISO: app.todayISO || (() => '2026-10-19') });
  vm.runInContext(slice('buildBackupPayload') + slice('applyBackupData') + ';this.buildBackupPayload=buildBackupPayload;this.applyBackupData=applyBackupData;', app);
  return app;
};
const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (files.length) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const A = mk();
  ['tx', 'tasks', 'customerMeta', 'priceList', 'settlements', 'products', 'whatsappInbox', 'dailyNotes'].forEach(k => { if (data[k] !== undefined) A.state[k] = JSON.parse(JSON.stringify(data[k])); });
  const payload = JSON.parse(JSON.stringify(A.buildBackupPayload()));
  // 1. restore onto a device that already holds the same data (the case that lost the settlements)
  const B = mk();
  ['tx', 'tasks', 'customerMeta', 'priceList', 'settlements', 'products', 'whatsappInbox', 'dailyNotes'].forEach(k => { if (data[k] !== undefined) B.state[k] = JSON.parse(JSON.stringify(data[k])); });
  B.applyBackupData(JSON.parse(JSON.stringify(payload)));
  const tomb = (B.state.settlements || []).filter(s => B.state._deletedIds.includes(s.id)).length;
  expect(tomb === 0, 'restored settlements must not be tombstoned (' + tomb + ' were)');
  expect((B.state.settlements || []).length === (data.settlements || []).length, 'settlement count after restore: ' + (B.state.settlements || []).length + ' vs ' + (data.settlements || []).length);
  // 2. restore onto a fresh device with junk: rows equal (stamps aside)
  const C = mk(); C.state.tx = [{ id: 'zz1', type: 'income', total: 5, date: '2026-10-01', _updatedAt: 5 }]; C.state.tasks = [{ id: 'tz', task: 'junk' }];
  C.applyBackupData(JSON.parse(JSON.stringify(payload)));
  const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c._updatedAt; delete c._fieldAt; delete c._realAt; return c; };
  for (const k of ['tx', 'tasks', 'products', 'priceList', 'settlements']) {
    const a = A.state[k] || [], b = new Map((C.state[k] || []).map(r => [r.id, r]));
    const bad = a.filter(r => !b.has(r.id) || JSON.stringify(strip(r)) !== JSON.stringify(strip(b.get(r.id)))).length;
    expect(bad === 0 && (C.state[k] || []).length === a.length, k + ': ' + bad + ' rows differ / missing after restore');
  }
  expect(!C.state.tx.some(r => r.id === 'zz1') && !C.state.tasks.some(r => r.id === 'tz'), 'rows not in the backup are removed by a restore');
}
// 3. xlsx writer
const app = loadApp(html);
vm.runInContext(slice('_xmlEscape') + slice('_colLetter') + slice('_cellXml') + slice('_sheetXml') + ';this._sheetXml=_sheetXml;this._xmlEscape=_xmlEscape;', app);
const xml = app._sheetXml([{ a: 1 }, { a: 2, b: 'x', c: 'y' }], null);
expect((xml.match(/<row r="1">.*?<\/row>/) || [''])[0].split('<c ').length - 1 === 3, 'header row must hold every column of every row, not only the first row\'s');
expect(app._xmlEscape('a\u0001b\u000bc&<>') === 'abc&amp;&lt;&gt;', 'control characters removed, markup escaped: ' + app._xmlEscape('a\u0001b\u000bc&<>'));
expect(app._xmlEscape('שלום\n\t"x"') === 'שלום\n\t&quot;x&quot;', 'newline / tab / Hebrew kept');
if (fails) { console.error('backup-restore-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ backup-restore-check: גיבוי ← שחזור מחזיר בדיוק את מה שגובה (כולל התחשבנויות שותפים); xlsx שומר את כל העמודות ולא כותב תווים אסורים');
