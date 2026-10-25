#!/usr/bin/env node
/* Guards the live Google-Sheet sync (api/sync-sheet.js, 1.10): it runs the
 * real buildExportSheets()/_sheetRowsToGrid() out of index.html (via
 * api/_loadApp.js) rather than a hand-written copy, specifically so the
 * sheet's numbers can never disagree with the app. That only works if those
 * two functions keep being extractable as clean top-level declarations —
 * this smoke-test catches the day someone edits index.html and breaks that
 * (moves one back inside a closure, renames it, etc.) before it reaches
 * production as a silent sync failure.
 *
 *   node tests/sync-check.js       fixed cases + the newest real backup
 *
 * Run by the same pre-push hook as calc-check.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('../api/_loadApp');

const APP_DIR = path.join(__dirname, '..');

const FIX = [
  { id: 'T1', type: 'income', stage: 'paid', customer: 'לקוח 1', total: 1000, materials: 100, date: '2026-09-05', paidDate: '2026-09-06' },
  { id: 'T4', type: 'income', stage: 'paid', customer: 'לקוח 4', partnerName: 'שלומי', partnerAmount: 400, partnerCollected: false, total: 1000, date: '2026-08-20', paidDate: '2026-08-22' },
  { id: 'T6', type: 'income', stage: 'unpaid', customer: 'לקוח 6', partnerName: 'אהרן', whoseCustomer: 'partner', partnerAmount: 700, total: 1000, date: '2026-09-01' },
  { id: 'E1', type: 'expense', total: 250, date: '2026-09-03', category: 'דלק' },
];
const EXPECT_SHEET_NAMES = ['ראשי', 'הכנסות', 'הוצאות', 'משימות', 'לקוחות', 'דשבורד', 'הצעות ומתוזמנות', 'מחירון'];

function check(label, tx, tasks) {
  const app = loadApp(fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8'));
  if (typeof app.buildExportSheets !== 'function') { console.error(`❌ ${label}: buildExportSheets() didn't load as a top-level function — check it hasn't moved back inside a closure/IIFE in index.html`); return false; }
  if (typeof app._sheetRowsToGrid !== 'function') { console.error(`❌ ${label}: _sheetRowsToGrid() didn't load as a top-level function`); return false; }
  app.state.tx = JSON.parse(JSON.stringify(tx));
  app.state.tasks = JSON.parse(JSON.stringify(tasks || []));
  let sheets;
  try { sheets = app.buildExportSheets(); }
  catch (e) { console.error(`❌ ${label}: buildExportSheets() threw: ${e.message}`); return false; }
  const names = sheets.map(s => s.name);
  const missing = EXPECT_SHEET_NAMES.filter(n => !names.includes(n));
  if (missing.length) { console.error(`❌ ${label}: missing sheet(s): ${missing.join(', ')}`); return false; }
  const main = sheets.find(s => s.name === 'ראשי');
  if (main.rows.length !== tx.filter(t => app.txStage(t) !== 'quote' && app.txStage(t) !== 'scheduled' && app.txStage(t) !== 'cancelled').length) {
    console.error(`❌ ${label}: ראשי row count doesn't match the input transactions`); return false;
  }
  const dash = sheets.find(s => s.name === 'דשבורד');
  const grid = app._sheetRowsToGrid(dash.rows, dash.formulaCols);
  if (!grid.length || !grid.some(row => row.some(cell => typeof cell === 'string' && cell.startsWith('=SUMIF')))) {
    console.error(`❌ ${label}: דשבורד didn't produce any live SUMIF/SUMIFS formula — check reportFigures/pushMetric still build formula strings`); return false;
  }
  // 1.10k: הכנסות/הוצאות/עבודות עם שותפים (ledger) are a single live
  // FILTER() formula each, not individually-pushed rows — catches the day
  // someone reverts to per-row pushing without updating the formula.
  for (const name of ['הכנסות', 'הוצאות', 'עבודות עם שותפים']) {
    const sh = sheets.find(s => s.name === name);
    if (!sh) continue; // 'עבודות עם שותפים' has no rows at all when there are zero partner transactions
    const g = app._sheetRowsToGrid(sh.rows, sh.formulaCols);
    if (!g.some(row => row.some(cell => typeof cell === 'string' && cell.startsWith('=FILTER(')))) {
      console.error(`❌ ${label}: ${name} didn't produce a live FILTER() formula — check buildExportSheets still builds it that way`); return false;
    }
  }
  console.log(`✅ ${label}: ${sheets.length} sheets, ראשי ${main.rows.length} rows, דשבורד has live formulas`);
  return true;
}

function main() {
  let ok = check('נתוני בדיקה קבועים', FIX);
  try {
    const dir = path.join(os.homedir(), 'Downloads');
    const files = fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort();
    if (files.length) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
      if (Array.isArray(data.tx) && data.tx.length) ok = check(`נתונים אמיתיים מ: ${files[files.length - 1]} — ${data.tx.length} עסקאות`, data.tx, data.tasks) && ok;
    } else {
      console.log('⚠️ לא נמצא קובץ גיבוי ב-Downloads — נבדק רק על נתוני הבדיקה');
    }
  } catch (e) { console.log('⚠️ בדיקה על גיבוי אמיתי דולגה:', e.message); }
  if (!ok) process.exit(1);
}
main();
