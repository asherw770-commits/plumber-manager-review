#!/usr/bin/env node
/* Row ids are written raw into HTML attributes all over the UI, so every way rows get INTO the app must drop malformed ids (stored-XSS guard, audit 15.10):
 * the cloud document, Yehuda's queue, the inbox, this device's saved copy and a backup file all go through safeRows.
 *   node tests/safe-id-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const bad = ['x"><img src=x onerror=alert(1)>', "x' onmouseover='alert(1)", 'a b', '', null, undefined, 'x'.repeat(65), '<script>', 'שלום'];
const good = ['x1a2b3c', 'ord_r_abc-123', 'wa_1700000000_ab12', 'pl_001'];
const rows = [...bad, ...good].map(id => ({ id }));
const kept = app.safeRows(rows).map(r => r.id);
expect(kept.join() === good.join(), 'safeRows keeps exactly the well-formed ids: ' + kept);
expect(app.safeRows(null).length === 0 && app.safeRows([null, 5, 'x']).length === 0, 'non-row input is dropped');
// every ingestion point uses it
for (const [name, re] of [['mergeCloudDoc', /const arr = safeRows;/], ['owner queue tasks/tx/deleted', /safeRows\(cp\(cq\.tasks\)\), mTx = safeRows\(cp\(cq\.tx\)\), mDel = safeRows\(cp\(cq\.deleted\)\)/], ['inbox snapshot', /mergeRowsById\(state\.whatsappInbox, safeRows\(d\.items\)\)/], ['inbox from cloud doc', /mergeRowsById\(state\.whatsappInbox, safeRows\(inboxRows\)\)/], ['saved copy on this device', /state\.tx = safeRows\(parsed\.tx\)/], ['backup restore', /const stamp = arr => safeRows\(arr\)/]])
  expect(re.test(html), 'ingestion point not guarded: ' + name);
// the queue's deletion time can never be in the future
expect(/Math\.min\(Number\(x\.at\) \|\| _clockNow\(\), _clockNow\(\)\)/.test(html), 'queue deletion time must be clamped to now');
if (fails) { console.error('safe-id-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ safe-id-check: מזהי שורות זדוניים נחסמים בכל נקודת כניסה (ענן, תור יהודה, תיבת הודעות, עותק מקומי, גיבוי)');
