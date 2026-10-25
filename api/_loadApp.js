// Loads the real top-level functions out of index.html into a sandboxed
// Node context — the SAME technique tests/calc-check.js uses, factored out
// here so the server-side live-sheet sync (api/sync-sheet.js) runs the
// actual app code (buildExportSheets, _sheetRowsToGrid, reportFigures, …)
// instead of a hand-written copy that could quietly drift from it.
// Pure extraction/sandbox plumbing — no money logic lives in this file.
const vm = require('vm');

const CONSTS = /^(const|let) (TX_STAGES|TX_LEGACY_MIRROR|LEGACY_SEED_IDS|VAT_RATE|VAT_MULT|WORK_STOP|NO_CATEGORY|_aliasCache|_reconCache|_clockOffset|_localEdits|TOMBSTONE_CAP|STALE_ROW_GRACE_MS|_STAGE_RANK|_TX_GROUPS|_TASK_GROUPS|WA_TPL_LABELS|COLLECTION_RULE_TEXT|EXPENSE_CATEGORIES|OWNER_EXPENSE_CATEGORIES|FIXED_EXPENSE_CATEGORIES|EXPENSE_CAT_ALIAS|_plStems|_plStemsSig)\b/;

function loadApp(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const js = scripts.find(s => s.includes('function computeStats('));
  if (!js) throw new Error('computeStats not found in the HTML');
  const lines = js.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isFn = /^(async )?function [A-Za-z_$][\w$]*\s*\(/.test(l);
    const isConst = CONSTS.test(l);
    if (!isFn && !isConst) continue;
    const bal = s => (s.match(/[{[(]/g) || []).length - (s.match(/[}\])]/g) || []).length;
    if (bal(l) === 0 && (/[};]\s*(\/\/.*)?$/.test(l))) { out.push(l); continue; }
    let j = i, depth = 0, buf = [];
    for (; j < lines.length; j++) {
      buf.push(lines[j]);
      if (isFn && j > i && lines[j] === '}') break;
      if (isConst) { depth += bal(lines[j]); if (depth <= 0 && /;\s*(\/\/.*)?$/.test(lines[j])) break; }
    }
    out.push(buf.join('\n'));
    i = j;
  }
  const ctx = { console, Date, Math, JSON, Number, String, Array, Object, Set, Map, isNaN, parseFloat, parseInt, Intl,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, toast() {}, render() {} };
  vm.createContext(ctx);
  vm.runInContext(out.join('\n') + '\n;var state = { tx: [], tasks: [], customerMeta: {}, whatsappInbox: [], priceList: [], settlements: [], _deletedIds: [], _deletedAt: {} };', ctx);
  return ctx;
}

module.exports = { loadApp };
