#!/usr/bin/env node
/* Adversarial multi-device sync scenarios found by the 19.10 audit (real saveState / merge / owner queue / undo / restore code over a virtual-time fake Firestore, tests/sync-adversarial/h.js):
 * Yehuda's cancel is not undone by his own earlier version; Ctrl+Z on a not-yet-synced deletion keeps the row; an automatic queue merge is not on the undo stack;
 * a new row survives a reload + a concurrent full-document write; Yehuda's older payment state never beats Asher's newer one; a restored row is not
 * dropped by the clock skew; plus a randomized matrix (devices, offline, lie-fi, undo, skew, Yehuda's queue) that must end with zero lost rows.
 *   node tests/sync-adversarial-check.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const dir = path.join(__dirname, 'sync-adversarial');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const run = (file, args, env) => execFileSync('node', [path.join(dir, file), ...(args || [])], { cwd: dir, env: { ...process.env, ...(env || {}) }, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
const has = (out, re, n, m) => { const c = (out.match(new RegExp(re.source, 'g')) || []).length; expect(c >= (n || 1), m + ' — expected ' + re + ' (got ' + c + ')\n' + out.slice(-400)); };
has(run('oq1b.js'), /Yehuda final stage: unpaid \| Admin stage: unpaid \| cloud: unpaid/, 1, 'Yehuda cancels a payment');
has(run('oq2.js'), /Yehuda final: open \| Admin: open \| cloud: open/, 1, 'Yehuda re-opens a task');
has(run('undo1.js'), /A rows \[ 'x1' \] B rows \[ 'x1' \] cloud \[ 'x1' \]/, 2, 'Undo of an unsynced deletion (offline and fast online)');
has(run('undo2.js'), /P:paid, X:unpaid/, 3, 'Undo after an automatic queue merge keeps Yehuda\'s payment');
has(run('repro_overwrite_drop10.js'), /cloud rows: c0,R/, 1, 'A new row survives a reload and a concurrent full-document write');
has(run('oq3.js'), /cloud: paid/, 1, 'Yehuda\'s older partial must not beat Asher\'s newer "paid"');
has(run('keep1.js'), /cloud: X:paid/, 1, 'A payment from the queue for a row that came back (undo)');
has(run('restore2.js'), /cloud: B edit AFTER the restore/, 2, 'Restore with a fast / slow device clock');
for (const [env, seeds] of [[{ COAL: '1' }, '40'], [{ COAL: '1', OWNER: '1' }, '40'], [{ COAL: '1', UNDO: '1' }, '40'], [{ COAL: '1', LIEFI: '1', DOUBLE: '1', PARTIAL: '1' }, '40'], [{ OWNER: '1', LIEFI: '1', DOUBLE: '1', PARTIAL: '1', UNDO: '1', DEVS: '4', STEPS: '100' }, '30']]) {
  const out = run('fuzz.js', [seeds, '1'], env).trim().split('\n').pop();
  expect(/failing=0\b/.test(out), 'random matrix ' + JSON.stringify(env) + ': ' + out);
}
if (fails) { console.error('sync-adversarial-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ sync-adversarial-check: תרחישי סנכרון עוינים (ביטול של יהודה, בטל על מחיקה, מיזוג תור אוטומטי, טעינה מחדש, שחזור עם סטיית שעון) + מטריצה אקראית — שום שורה לא אבדה ושום מצב תשלום ישן לא ניצח');
