// Google Sheets access for the live-sync cron (api/sync-sheet.js). Reuses
// the SAME service-account key as Firestore (FIREBASE_SERVICE_ACCOUNT) — no
// second secret. A Google service account is just a regular Google identity;
// it can call any API enabled on the project, as long as (a) the API is
// turned on and (b) for a Drive file like a Sheet, the file is explicitly
// shared with the service account's email. No extra npm package: a service-
// account token exchange is ~20 lines with Node's built-in `crypto`.
const crypto = require('crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let _cachedToken = null, _cachedAt = 0;
async function getSheetsToken(cred) {
  if (_cachedToken && Date.now() < _cachedAt - 60000) return _cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: cred.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned); sign.end();
  const signature = b64url(sign.sign(cred.private_key));
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const j = await res.json();
  _cachedToken = j.access_token;
  _cachedAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _cachedToken;
}

async function batchUpdateSpreadsheet(cred, spreadsheetId, requests) {
  if (!requests || !requests.length) return null;
  const token = await getSheetsToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const res = await fetch(`${base}:batchUpdate`, { method: 'POST', headers, body: JSON.stringify({ requests }) });
  if (!res.ok) throw new Error(`Sheets batchUpdate failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// The app's manual "רענן גיליון" button only ever runs against a sheet IT
// already created (gsCreateSpreadsheet), so every tab name already exists
// there. The server sync points at Asher's PRE-EXISTING "קובץ ניהול פיננסי"
// instead, which only had the two original tabs (ראשי/דשבורד) before 1.10 —
// so a new tab name (הכנסות, משימות, …) has to be created before anything
// can be written or cleared on it, or the Sheets API rejects the range with
// "Unable to parse range" (found live, 1.10: batchClear on 'הכנסות' 400'd).
//
// Also removes the two tabs Asher asked to drop from this specific file
// (1.10c, "בסגנון הזה... תמחק דברים מיותרים") — הצעות ומתוזמנות / מחירון.
// Deliberately a short hardcoded list, not "anything not in desiredNames":
// this function must never delete a tab Asher added himself by hand.
//
// Returns { title: sheetId } for every sheet now present, needed by the
// formatting calls below (merge/color/number-format requests address a
// sheet by its numeric id, not its name).
const LEGACY_REMOVE = ['הצעות ומתוזמנות', 'מחירון'];
async function ensureSheetsExist(cred, spreadsheetId, desiredNames) {
  const token = await getSheetsToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const metaRes = await fetch(`${base}?fields=sheets.properties(sheetId,title)`, { headers });
  if (!metaRes.ok) throw new Error(`Sheets get metadata failed: ${metaRes.status} ${await metaRes.text().catch(() => '')}`);
  const existing = {};
  (await metaRes.json()).sheets.forEach(s => { existing[s.properties.title] = s.properties.sheetId; });

  const missing = desiredNames.filter(n => !(n in existing));
  const toRemove = LEGACY_REMOVE.filter(n => n in existing && !desiredNames.includes(n));
  const requests = [
    ...missing.map(title => ({ addSheet: { properties: { title } } })),
    ...toRemove.map(title => ({ deleteSheet: { sheetId: existing[title] } }))
  ];
  const result = { ...existing };
  toRemove.forEach(title => { delete result[title]; });
  if (!requests.length) return result;
  const res = await batchUpdateSpreadsheet(cred, spreadsheetId, requests);
  (res.replies || []).forEach(r => { if (r.addSheet) result[r.addSheet.properties.title] = r.addSheet.properties.sheetId; });
  return result;
}

// values:batchClear (used by pushSheet below) only clears cell CONTENT —
// never formatting, number formats, or merges. Over many syncs that lets
// cruft accumulate invisibly: a merged cell from some earlier state eats
// every value but its top-left corner, a stray date number-format left on
// a column turns a plain "0" into "30/12/1899" (Asher 1.10d, "הקובץ סופר
// מבולגן" — found live on ראשי's שיעור מעמ column). Unmerging + wiping
// userEnteredFormat sheet-wide before every write gives each sync a truly
// clean slate, so the only formatting that ever shows is the formatting
// this file applies on purpose (header row below, דשבורד's cards).
// 1.10i: returns the request objects instead of executing them — Sheets
// enforces a per-minute write-request quota (hit live once already, with 7
// sheets: "RATE_LIMIT_EXCEEDED... 60 per minute"), so every sheet's reset
// and format now goes out as ONE combined batchUpdate instead of several,
// to stay comfortably under it even if a sync is re-run shortly after.
function resetFormattingRequests(sheetId) {
  return [
    { unmergeCells: { range: { sheetId } } },
    { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat' } }
  ];
}

// `grid` is already a 2-D array of plain values / "=FORMULA" strings — built
// by the app's own _sheetRowsToGrid() (loaded via _loadApp.js), not here, so
// a ראשי row and a live דשבורד formula are converted exactly the way the
// in-app "רענן גיליון" button already does it.
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// 429 / 5xx → one patient retry (Sheets' per-minute write quota); never hangs: 25s per call.
async function fetchRetry(url, init) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) }); }
    catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt < 2) await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
  }
  return res;
}

// Write FIRST, then clear only what the new data no longer covers (rows below, columns to the right).
// Scan 5.10: it used to clear the whole tab before writing, so a failed write left "ראשי" EMPTY and the
// dashboard (formulas over ראשי) showed zeros until the next successful sync. Rows are padded to one width
// so a short row overwrites the long old one instead of leaving its tail cells behind.
async function pushSheet(cred, spreadsheetId, sheetName, grid) {
  const token = await getSheetsToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const width = Math.max(1, ...grid.map(r => r.length));
  const padded = grid.map(r => r.length < width ? r.concat(Array(width - r.length).fill('')) : r);
  const put = await fetchRetry(`${base}/values/${encodeURIComponent(`'${sheetName}'!A1`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers, body: JSON.stringify({ values: padded }) });
  if (!put.ok) throw new Error(`Sheets update ${sheetName} failed: ${put.status} ${await put.text().catch(() => '')}`);
  const ranges = [`'${sheetName}'!A${grid.length + 1}:ZZ`, `'${sheetName}'!${colLetter(width + 1)}1:ZZ`];
  const clear = await fetchRetry(`${base}/values:batchClear`, { method: 'POST', headers, body: JSON.stringify({ ranges }) });
  if (!clear.ok) throw new Error(`Sheets batchClear tail ${sheetName} failed: ${clear.status} ${await clear.text().catch(() => '')}`);
}

// Freeze + bold the header row, with a solid line under it so it reads as
// a header and not just another row — applied to every tab (1.10c, "נוח
// לעין"; the border added in 1.10f, "סידור מלא לרמה נוחה מאוד").
//
// 1.10o (Asher: "תשפר נוחות עבודה"): also freezes the first `freezeCols`
// columns — the identifying ones (date/type/job/customer on the wide
// ledger-shaped sheets) — so scrolling right to see money/status columns
// never loses track of which row you're on. Also sets tabColor if given,
// for at-a-glance navigation among 9 tabs.
function headerRowRequests(sheetId, freezeCols, tabColor) {
  const props = { frozenRowCount: 1 };
  let fields = 'gridProperties.frozenRowCount,rightToLeft';
  if (freezeCols) { props.frozenColumnCount = freezeCols; fields += ',gridProperties.frozenColumnCount'; }
  const sheetProps = { sheetId, gridProperties: props, rightToLeft: true };
  if (tabColor) { sheetProps.tabColor = tabColor; fields += ',tabColor'; }
  return [
    { updateSheetProperties: { properties: sheetProps, fields } },
    { repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.93, green: 0.93, blue: 0.96 },
          borders: { bottom: { style: 'SOLID_MEDIUM', color: { red: 0.6, green: 0.6, blue: 0.65 } } },
          // Sheets' default OVERFLOW_CELL only overflows into an EMPTY
          // neighbor and otherwise clips — but every header cell has text,
          // and a header column auto/explicitly sized to its short DATA
          // (e.g. "שולם בפועל אם חלקי" over a column of mostly "0") is
          // narrower than its own label. Found live (1.10g, PDF export):
          // several header labels ran together unreadably. WRAP forces the
          // label to stay inside its own column, wrapping to a 2nd line
          // instead of spilling — the one wrap strategy that can't bleed.
          wrapStrategy: 'WRAP'
        } },
        fields: 'userEnteredFormat(textFormat,backgroundColor,borders,wrapStrategy)'
    } }
  ];
}
// Auto-fit every column to its content — used for sheets with no explicit
// width table below (DATA_SHEET_COLS' widths are deliberately hand-picked
// instead, precisely because auto-resize sizes a column to its DATA, which
// for a column like "שולם בפועל אם חלקי" is mostly the short text "0" —
// much narrower than the header label itself needs (1.10g).
function autoResizeColumnsRequest(sheetId) {
  return { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 30 } } };
}

// 1.10f (Asher: "לסדר בטבלאות ממש סידור מלא לרמה נוחה מאוד") — every data
// table (not דשבורד, which has its own fixed layout) gets: ₪/% number
// formats on the columns that are actually money/percent, alternating row
// colors so a long list of עסקאות stays readable, and a frozen bold header
// with a dividing line. Column positions are fixed by toMainRow()'s key
// order in index.html (ראשי/הכנסות/הוצאות share it) and the taskHeaders/
// custHeaders arrays — if those ever reorder, update the indices here too.
//
// 1.10g: `width` is picked to fit the HEADER label (not the data — see the
// comment on wrapStrategy above), in pixels; `wrap` columns additionally
// get WRAP so a long ראשי/משימות הערות note grows the row instead of either
// forcing the column huge or clipping mid-sentence.
// 1.10o: freezeCols keeps the identifying columns (date/type/job/customer
// on the wide ledger sheets; just the name column on the shorter summary
// sheets) visible while scrolling right to the money/status columns.
// tabColor groups the 9 tabs by role at a glance in the tab strip: green
// for the money ledger, orange for the action list, purple/teal for the
// operational lists, yellow for the two partner reports.
const TAB_GREEN  = { red: 0.70, green: 0.88, blue: 0.70 };
const TAB_ORANGE = { red: 0.98, green: 0.78, blue: 0.55 };
const TAB_PURPLE = { red: 0.80, green: 0.75, blue: 0.95 };
const TAB_TEAL   = { red: 0.65, green: 0.85, blue: 0.85 };
const TAB_YELLOW = { red: 0.98, green: 0.90, blue: 0.55 };
const TAB_GRAY   = { red: 0.80, green: 0.80, blue: 0.80 };
const DATA_SHEET_COLS = {
  'מדריך': {
    money: [], percent: [], count: [], wrap: [1],
    widths: [190, 480, 260], freezeCols: 1, tabColor: TAB_GRAY
  },
  'ראשי': {
    money: [7, 8, 10, 11, 18, 19, 20, 21, 22], percent: [9], wrap: [2, 15],
    widths: [95, 85, 220, 150, 150, 120, 80, 95, 105, 85, 90, 110, 100, 100, 100, 280, 90, 100, 95, 140, 90, 95, 130],
    freezeCols: 4, tabColor: TAB_GREEN
  },
  'הכנסות': {
    money: [7, 8, 10, 11, 18, 19, 20, 21, 22], percent: [9], wrap: [2, 15],
    widths: [95, 85, 220, 150, 150, 120, 80, 95, 105, 85, 90, 110, 100, 100, 100, 280, 90, 100, 95, 140, 90, 95, 130],
    freezeCols: 4, tabColor: TAB_GREEN
  },
  'הוצאות': {
    money: [7, 8, 10, 11, 18, 19, 20, 21, 22], percent: [9], wrap: [2, 15],
    widths: [95, 85, 220, 150, 150, 120, 80, 95, 105, 85, 90, 110, 100, 100, 100, 280, 90, 100, 95, 140, 90, 95, 130],
    freezeCols: 4, tabColor: TAB_GREEN
  },
  'משימות': {
    money: [8, 9, 10], percent: [], wrap: [1, 12],
    widths: [80, 220, 140, 140, 110, 95, 85, 100, 100, 90, 100, 100, 250],
    freezeCols: 2, tabColor: TAB_PURPLE
  },
  'לקוחות': {
    money: [3, 4], percent: [], count: [2, 6], wrap: [],
    widths: [170, 120, 95, 105, 100, 105, 110],
    freezeCols: 2, tabColor: TAB_TEAL
  },
  // 1.10h: 6 summary columns (שותף/מס עבודות/.../% שלי) prepended to the
  // same 23-column ראשי layout (hence the money/percent indices below are
  // ראשי's own +6) — see the comment on buildExportSheets' partnerJobsRows.
  'עבודות עם שותפים': {
    money: [2, 3, 4, 13, 14, 16, 17, 24, 25, 26, 27, 28], percent: [5, 15], count: [1], wrap: [8, 21],
    widths: [110, 90, 120, 110, 120, 70, 95, 85, 220, 150, 150, 120, 80, 95, 105, 85, 90, 110, 100, 100, 100, 280, 90, 100, 95, 140, 90, 95, 130],
    freezeCols: 1, tabColor: TAB_YELLOW
  },
  // 1.10j: rows 2-5 are 4 KPI highlight rows reusing column B for a ₪
  // amount (card style, like דשבורד) — tableStartRow pushes the ordinary
  // column-wide count/money formatting below them, so column B can be
  // "count" for the real partner table (row 6+) without the KPI rows'
  // currency amounts fighting it for the same column.
  'עבודות בשותפות': {
    money: [4, 5], percent: [], count: [1], wrap: [],
    widths: [160, 110, 100, 100, 110, 110],
    tableStartRow: 6, kpiRows: [2, 3, 4, 5], kpiValueCol: 1,
    freezeCols: 1, tabColor: TAB_YELLOW
  },
  // 1.10l: 'מדד'/'ערך' (2 cols, like דשבורד) + the same 23-column ראשי
  // layout appended after them (hence +2 on every ראשי index below). Rows 2-5
  // are KPIs (₪ / count / ₪ / count: own customers, then partners) —
  // kpiFormats lets each KPI row pick its own number format instead of all
  // sharing one column-wide pattern. Row 6 is the divider, the ledger spills from row 7.
  'גבייה': {
    money: [9, 10, 12, 13, 20, 21, 22, 23, 24], percent: [11], count: [], wrap: [4, 17],
    widths: [260, 120, 95, 85, 220, 150, 150, 120, 80, 95, 105, 85, 90, 110, 100, 100, 100, 280, 90, 100, 95, 140, 90, 95, 130],
    tableStartRow: 7, kpiRows: [2, 3, 4, 5], kpiValueCol: 1, kpiFormats: [null, 'COUNT', null, 'COUNT'],
    freezeCols: 2, tabColor: TAB_ORANGE
  }
};
const RNG_END = 5000; // same generous headroom as rref() in index.html

// GET-only (doesn't count against the write-request quota) — returns the
// deleteBanding requests needed to clear whatever banding this sheet
// already has, for the caller to fold into its own single batchUpdate.
async function bandingDeleteRequests(cred, spreadsheetId, sheetId) {
  const token = await getSheetsToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const metaRes = await fetch(`${base}?fields=sheets(properties(sheetId),bandedRanges(bandedRangeId,range(sheetId)))`, { headers });
  if (!metaRes.ok) throw new Error(`Sheets get banding failed: ${metaRes.status} ${await metaRes.text().catch(() => '')}`);
  const sheetsMeta = (await metaRes.json()).sheets || [];
  const mine = sheetsMeta.find(s => s.properties.sheetId === sheetId);
  const ids = ((mine && mine.bandedRanges) || []).map(b => b.bandedRangeId);
  return ids.map(bandedRangeId => ({ deleteBanding: { bandedRangeId } }));
}

// Data-sheet formatting: reset (resetFormattingRequests) + header/border/
// RTL (headerRowRequests) + ₪/%/count column formats + zebra-striped rows
// bounded to the real data + content-fit column widths — all ONE
// batchUpdate call per sheet (1.10i, write-quota).
async function formatDataSheet(cred, spreadsheetId, sheetId, sheetName, rowCount) {
  const bandingDeletes = await bandingDeleteRequests(cred, spreadsheetId, sheetId);
  const cols = DATA_SHEET_COLS[sheetName];
  // tableStartRow (1-indexed): a sheet like עבודות בשותפות has a few KPI
  // highlight rows ABOVE its real table, reusing one column for a ₪ amount
  // there — the ordinary column-wide count/money/percent formats below must
  // start after those rows, or they'd fight the KPI rows' own formatting.
  const tableStart = (cols && cols.tableStartRow) || 2;
  const colFmt = (indices, pattern) => (indices || []).map(col => ({
    repeatCell: {
      range: { sheetId, startRowIndex: tableStart - 1, endRowIndex: RNG_END, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  }));
  const widthRequests = cols
    ? cols.widths.map((pixelSize, col) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 }, properties: { pixelSize }, fields: 'pixelSize' } }))
    : [autoResizeColumnsRequest(sheetId)];
  const wrapRequests = (cols && cols.wrap || []).map(col => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: RNG_END, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat.wrapStrategy'
    }
  }));
  // Card-style KPI rows above the real table (עבודות בשותפות — same idea as
  // the 4 headline cards in דשבורד, just reusing one column instead of a
  // dedicated ערך column): bold, bigger, colored, currency-formatted.
  const kpiRequests = (cols && cols.kpiRows || []).flatMap((row, i) => {
    const bg = KPI_COLORS[i] || KPI_COLORS[0];
    const col = cols.kpiValueCol;
    // kpiFormats (optional, per-row): 'COUNT' for a plain count KPI (e.g.
    // גבייה's "מספר עסקאות פתוחות"); anything else/missing defaults to ₪.
    const kind = cols.kpiFormats && cols.kpiFormats[i];
    const pattern = kind === 'COUNT' ? COUNT_FMT : CURRENCY_FMT;
    return [
      { repeatCell: { range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: col },
        cell: { userEnteredFormat: { backgroundColor: bg, textFormat: { bold: true, fontSize: 11 } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)' } },
      { repeatCell: { range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { backgroundColor: bg, textFormat: { bold: true, fontSize: 13 }, numberFormat: { type: 'NUMBER', pattern } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)' } }
    ];
  });
  const requests = [
    ...resetFormattingRequests(sheetId),
    ...bandingDeletes,
    ...headerRowRequests(sheetId, cols && cols.freezeCols, cols && cols.tabColor),
    ...colFmt(cols && cols.money, CURRENCY_FMT),
    ...colFmt(cols && cols.percent, PERCENT_FMT),
    ...colFmt(cols && cols.count, COUNT_FMT),
    ...wrapRequests,
    ...widthRequests,
    ...kpiRequests
  ];
  // A sheet with KPI highlight rows (עבודות בשותפות, גבייה) can't band from
  // row 1 like the others — a banded range's first row always gets
  // headerColor, which would mislabel the KPI row as a header and fight its
  // own bold/colored formatting above. Found live 2.10: this used to skip
  // banding on these sheets ENTIRELY, so גבייה's whole open-debts ledger —
  // the exact kind of long list banding was added for everywhere else — had
  // no zebra-striping at all. Fix: band from tableStart instead (skipping
  // the KPI rows), just without headerColor — tableStart is real DATA here
  // (the first partner slot / first overdue transaction), not a row-1-style
  // header, so it should stripe like any other data row, not get flagged.
  {
    const hasKpi = !!(cols && cols.kpiRows);
    const bandStart = hasKpi ? tableStart - 1 : 0;
    const bandEnd = rowCount + 1;
    // גבייה with zero open debts (everyone paid up) has rowCount===3 (just
    // the 2 KPI rows + divider, tableStart row itself empty) — bandEnd would
    // equal bandStart, an empty range the Sheets API rejects. Nothing to
    // stripe in that case anyway.
    if (rowCount > 0 && bandEnd > bandStart) requests.push({ addBanding: { bandedRange: {
      range: { sheetId, startRowIndex: bandStart, endRowIndex: bandEnd },
      rowProperties: {
        ...(hasKpi ? {} : { headerColor: { red: 0.93, green: 0.93, blue: 0.96 } }),
        firstBandColor: { red: 1, green: 1, blue: 1 },
        secondBandColor: { red: 0.97, green: 0.97, blue: 0.98 }
      }
    } } });
  }
  await batchUpdateSpreadsheet(cred, spreadsheetId, requests);
}
async function formatHeaderRow(cred, spreadsheetId, sheetId) {
  await batchUpdateSpreadsheet(cred, spreadsheetId, [...resetFormattingRequests(sheetId), ...headerRowRequests(sheetId), autoResizeColumnsRequest(sheetId)]);
}

const CURRENCY_FMT = '#,##0" ₪"';
const PERCENT_FMT = '0.0"%"';
const COUNT_FMT = '#,##0';
const TAB_BLUE = { red: 0.68, green: 0.80, blue: 0.95 };
const KPI_COLORS = [
  { red: 0.85, green: 0.94, blue: 0.86 }, // 2: 💰 סה"כ שנכנס — green
  { red: 0.99, green: 0.92, blue: 0.80 }, // 3: 💸 יצא ממני — amber
  { red: 0.85, green: 0.89, blue: 0.98 }, // 4: 💵 רווח נטו — כל העבודות — blue
  { red: 0.82, green: 0.94, blue: 0.92 }  // 5: 🤲 רווח נטו ביד — teal
];
const numFmtRequests = (sheetId, rows, col, pattern) => rows.map(row => ({
  repeatCell: {
    range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 },
    cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
    fields: 'userEnteredFormat.numberFormat'
  }
}));

// The 4 headline-card rows (meta.kpiRows, always [2,3,4,5] — see the
// comment above dashMeta in buildExportSheets) get a colored "card" look:
// bold label, bold larger currency value, a soft background tint per row.
// Every other row gets a plain number format by kind (₪ / % / count) per
// dashMeta, built once in index.html so this file never has to guess a
// row's meaning from its label text.
function dashboardRequests(sheetId, meta) {
  const requests = [...resetFormattingRequests(sheetId), ...headerRowRequests(sheetId, 1, TAB_BLUE)];
  (meta.kpiRows || []).forEach((row, i) => {
    const bg = KPI_COLORS[i] || KPI_COLORS[0];
    const base = { sheetId, startRowIndex: row - 1, endRowIndex: row };
    requests.push({ repeatCell: { range: { ...base, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { backgroundColor: bg, textFormat: { bold: true, fontSize: 11 } } },
      fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
    requests.push({ repeatCell: { range: { ...base, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { backgroundColor: bg, textFormat: { bold: true, fontSize: 14 }, numberFormat: { type: 'NUMBER', pattern: CURRENCY_FMT } } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)' } });
    requests.push({ repeatCell: { range: { ...base, startColumnIndex: 2, endColumnIndex: 3 },
      cell: { userEnteredFormat: { backgroundColor: bg, textFormat: { italic: true, fontSize: 9, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } } },
      fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
  });
  requests.push(...numFmtRequests(sheetId, meta.currencyRows, 1, CURRENCY_FMT));
  requests.push(...numFmtRequests(sheetId, meta.percentRows, 1, PERCENT_FMT));
  requests.push(...numFmtRequests(sheetId, meta.countRows, 1, COUNT_FMT));
  requests.push(...numFmtRequests(sheetId, meta.statusSumRows, 5, CURRENCY_FMT));
  requests.push(...numFmtRequests(sheetId, meta.statusPercentRows, 6, PERCENT_FMT));
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 340 }, fields: 'pixelSize' } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 7 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } });
  return requests;
}
async function formatDashboard(cred, spreadsheetId, sheetId, meta) {
  if (!meta) return formatHeaderRow(cred, spreadsheetId, sheetId);
  await batchUpdateSpreadsheet(cred, spreadsheetId, dashboardRequests(sheetId, meta));
}

// At-a-glance status color, like the app's own שולם/חלקי/לא שולם chips
// (1.10e, Asher: "תסדר... שאני אוכל להשתמש בו במקום האפליקציה" — a plain
// table of numbers doesn't give that glance the way the app's colored
// chips do). Column N (index 13, סטטוס תשלום) is in the same position on
// ראשי/הכנסות/הוצאות — all three built from the same toMainRow() in
// index.html — so one column index covers all three.
const STATUS_COL = 13;
const STATUS_COLORS = {
  'שולם': { red: 0.80, green: 0.93, blue: 0.80 },
  'חלקי': { red: 1.00, green: 0.93, blue: 0.70 },
  'לא שולם': { red: 0.98, green: 0.80, blue: 0.80 }
};
// Rules are cleared and rebuilt every sync (same "clean slate" reasoning
// as resetSheetFormatting — conditional-format rules are a separate thing
// Sheets tracks per-sheet, untouched by a plain cell-format reset, so a
// rule from some earlier state would otherwise sit there forever).
async function applyStatusColors(cred, spreadsheetId, sheetIdsByName, names) {
  const token = await getSheetsToken(cred);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const metaRes = await fetch(`${base}?fields=sheets(properties(sheetId),conditionalFormats)`, { headers });
  if (!metaRes.ok) throw new Error(`Sheets get conditional formats failed: ${metaRes.status} ${await metaRes.text().catch(() => '')}`);
  const sheetsMeta = (await metaRes.json()).sheets || [];
  const requests = [];
  names.forEach(name => {
    const sheetId = sheetIdsByName[name];
    if (sheetId == null) return;
    const found = sheetsMeta.find(s => s.properties.sheetId === sheetId);
    const existingCount = (found && found.conditionalFormats && found.conditionalFormats.length) || 0;
    for (let i = existingCount - 1; i >= 0; i--) requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    Object.entries(STATUS_COLORS).forEach(([text, color]) => {
      requests.push({ addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: STATUS_COL, endColumnIndex: STATUS_COL + 1 }],
          booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: color } }
        }
      } });
    });
  });
  await batchUpdateSpreadsheet(cred, spreadsheetId, requests);
}

// Puts דשבורד first — opening the file should show the overview, not 100+
// ledger rows, the same way opening the app shows "סיכום כספי" before
// anyone scrolls through עסקאות (1.10e, "שאוכל להשתמש בו במקום האפליקציה").
// Any tab not in orderedNames (e.g. Asher's own "עבודות בשותפות") just
// shifts after these — never removed, never reordered relative to itself.
async function reorderSheets(cred, spreadsheetId, orderedNames, sheetIdsByName) {
  const requests = orderedNames
    .map((name, i) => sheetIdsByName[name] != null ? { updateSheetProperties: { properties: { sheetId: sheetIdsByName[name], index: i }, fields: 'index' } } : null)
    .filter(Boolean);
  await batchUpdateSpreadsheet(cred, spreadsheetId, requests);
}

module.exports = { getSheetsToken, ensureSheetsExist, pushSheet, formatHeaderRow, formatDataSheet, formatDashboard, applyStatusColors, reorderSheets };
