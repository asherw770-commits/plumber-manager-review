// The Google-Sheet push itself, shared by its two triggers: the daily cron
// (api/sync-sheet.js, CRON_SECRET) and the on-change refresh from the app
// (api/sync-sheet-run.js, the admin's/Yehuda's own Firebase login) — one
// copy of the logic, two ways to authorize running it. Asher 2.10: payments
// marked paid in the app still showed as open debts in the sheet until the
// next day's cron ("הגליון אמור להתעדכן מהאפליקציה") — so the app now asks
// for a refresh a minute after every saved change.
//
// No server-side money logic lives here: it loads the REAL
// buildExportSheets()/_sheetRowsToGrid() straight out of index.html into a
// sandbox (api/_loadApp.js), so this can never disagree with the app.
// Read-only towards Firestore state/current.
const fs = require('fs');
const path = require('path');
const { ensureSheetsExist, pushSheet, formatHeaderRow, formatDataSheet, formatDashboard, applyStatusColors, reorderSheets } = require('./_sheets');
const { loadApp } = require('./_loadApp');

// Asher's existing sheet (see קבצי הוראות/הפעלת-סנכרון-גיליון-חי.md).
// Not a secret — just which file to write to.
const SPREADSHEET_ID = '1DdyyCoD-EnzKet1sHWfVO2vTqEoQl8uWupC3GzDxyrw';

// Asher's reference file only had these tabs — the two below stay out of
// THIS file (still in the .xlsx export and the manual push).
const EXCLUDED_SHEETS = ['הצעות ומתוזמנות', 'מחירון'];

// מדריך first (a legend for anyone opening the file cold), then דשבורד (the
// overview), the ledger, collection, and the rest.
const SHEET_ORDER = ['מדריך', 'דשבורד', 'ראשי', 'הכנסות', 'הוצאות', 'גבייה', 'משימות', 'לקוחות', 'עבודות עם שותפים', 'עבודות בשותפות'];
const STATUS_COLOR_SHEETS = ['ראשי', 'הכנסות', 'הוצאות'];
const DATA_SHEETS = ['מדריך', 'ראשי', 'הכנסות', 'הוצאות', 'גבייה', 'משימות', 'לקוחות', 'עבודות עם שותפים', 'עבודות בשותפות'];

// Returns { skipped } when there's no state yet, else { tx, sheets }.
async function runSheetSync(db) {
  // The server runs in UTC, the business in Israel: local dates (a task finished at 00:30, "days since") must come out as the app shows them.
  process.env.TZ = 'Asia/Jerusalem';
  const snap = await db.doc('state/current').get();
  if (!snap.exists) return { skipped: 'no state/current doc yet' };
  const d = snap.data() || {};

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = loadApp(html);
  // The same row filter the app applies on the way in (ids, typed fields, objects in text fields): this path reads Firestore directly, and a crafted cell
  // would become a formula in Asher's spreadsheet.
  app.state.tx = app.safeRows(d.tx);
  app.state.tasks = app.safeRows(d.tasks);
  app.state.customerMeta = app.cleanCustomerMeta(d.customerMeta);
  app.state.priceList = app.safeRows(d.priceList);
  app.state.settlements = app.safeRows(d.settlements);

  // The nightly integrity watchdog's verdict (api/_integrity.js) is shown in the guide tab.
  try { const ig = await db.doc('serverState/integrity').get(); if (ig.exists) { const g = ig.data(); app.state._integrity = { checkedAt: g.checkedAt, ok: !!g.ok, alerts: g.alerts || [], history: g.history || [] }; } } catch (_) {}
  // Never mirror an emptied / shrunken book into the financial sheet: the sync would clear every row below the short grid.
  // Refuse when there are no transactions, or far fewer than the nightly integrity check last saw (a shrink over 5%).
  try {
    const ig = await db.doc('serverState/integrity').get();
    const seen = ig.exists ? Number((ig.data() || {}).tx) || 0 : 0;
    if (app.state.tx.length === 0 || (seen >= 20 && app.state.tx.length < seen * 0.95)) return { skipped: 'tx count ' + app.state.tx.length + ' is suspiciously low (integrity saw ' + seen + ') — sheet left untouched' };
  } catch (_) {}
  const sheets = app.buildExportSheets().filter(s => !EXCLUDED_SHEETS.includes(s.name));
  const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const sheetIds = await ensureSheetsExist(cred, SPREADSHEET_ID, sheets.map(s => s.name));
  for (const sh of sheets) {
    const sheetId = sheetIds[sh.name];
    // The clean-slate reset (unmerge + wipe old formatting) happens INSIDE
    // formatDashboard/formatDataSheet/formatHeaderRow, folded into that same
    // single batchUpdate call — see resetFormattingRequests in _sheets.js
    // (Sheets' per-minute write-request quota).
    const grid = (sh.rows && sh.rows.length) ? app._sheetRowsToGrid(sh.rows, sh.formulaCols) : [sh.headers || []];
    await pushSheet(cred, SPREADSHEET_ID, sh.name, grid);
    if (sheetId == null) continue; // shouldn't happen — ensureSheetsExist just created/confirmed it
    // rowCountHint: הכנסות/הוצאות/עבודות עם שותפים/גבייה push a single live
    // FILTER() formula instead of individual rows, so sh.rows.length is
    // always small — rowCountHint carries the REAL expected row count so
    // banding still covers the rows the formula actually spills into.
    if (sh.name === 'דשבורד') await formatDashboard(cred, SPREADSHEET_ID, sheetId, sh.meta);
    else if (DATA_SHEETS.includes(sh.name)) await formatDataSheet(cred, SPREADSHEET_ID, sheetId, sh.name, sh.rowCountHint != null ? sh.rowCountHint : ((sh.rows && sh.rows.length) || 0));
    else await formatHeaderRow(cred, SPREADSHEET_ID, sheetId);
  }
  await applyStatusColors(cred, SPREADSHEET_ID, sheetIds, STATUS_COLOR_SHEETS);
  await reorderSheets(cred, SPREADSHEET_ID, SHEET_ORDER, sheetIds);

  return { tx: app.state.tx.length, sheets: sheets.map(s => s.name) };
}

// One sync at a time, and not more often than minGapMs: each run costs ~30
// Sheets write requests against a 60/minute quota (a burst of app saves
// must never trip it), and two overlapping runs would write the same cells
// twice. State lives in serverState/sheetSync (admin SDK only). When a run
// is refused, retryInMs tells the caller when to ask again — the change it
// wanted to push is NOT lost, just deferred.
async function runSheetSyncGuarded(db, { minGapMs = 0 } = {}) {
  const ref = db.doc('serverState/sheetSync');
  const verdict = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const v = s.exists ? s.data() : {};
    const now = Date.now();
    if (v.runningUntil && v.runningUntil > now) return { go: false, why: 'busy', retryInMs: v.runningUntil - now + 2000 };
    if (minGapMs && v.lastEndAt && now - v.lastEndAt < minGapMs) return { go: false, why: 'recent', retryInMs: minGapMs - (now - v.lastEndAt) + 2000 };
    tx.set(ref, { runningUntil: now + 55000, lastStartAt: now }, { merge: true });
    return { go: true };
  });
  if (!verdict.go) return { deferred: verdict.why, retryInMs: verdict.retryInMs };
  try {
    const result = await runSheetSync(db);
    await ref.set({ runningUntil: 0, lastEndAt: Date.now(), lastError: null }, { merge: true });
    return result;
  } catch (e) {
    await ref.set({ runningUntil: 0, lastEndAt: Date.now(), lastError: String(e && e.message || e).slice(0, 500) }, { merge: true }).catch(() => {});
    throw e;
  }
}

module.exports = { runSheetSync, runSheetSyncGuarded };
