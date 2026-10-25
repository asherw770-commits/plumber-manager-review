#!/usr/bin/env node
/* Guards the nightly integrity watchdog (api/_integrity.js): it must stay silent on
 * a healthy night and raise an alert for each class of silent damage we have seen —
 * run end to end against a fake Firestore and the newest real backup.
 *   node tests/integrity-check.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runIntegrityCheck, compare } = require('../api/_integrity');

const dir = path.join(os.homedir(), 'Downloads');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^יהודה-גיבוי-.*\.json$/.test(f)).sort() : [];
if (!files.length) { console.log('⚠️ integrity-check: אין גיבוי ב-Downloads — דולג'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));

function fakeDb(initial) {
  const store = { 'state/current': initial };
  return { store, doc: p => ({ get: async () => ({ exists: p in store, data: () => store[p] }), set: async v => { store[p] = JSON.parse(JSON.stringify(v)); } }) };
}
const clone = o => JSON.parse(JSON.stringify(o));
const pushed = [];
const lib = { pushToRoles: async (db, roles, payload) => { pushed.push(payload); } };
let fails = 0;
const expect = (cond, msg) => { if (!cond) { fails++; console.error('❌ ' + msg); } };

(async () => {
  const origWarn = console.warn; console.warn = () => {};
  // night 1: baseline only
  const db = fakeDb(clone(base));
  let r = await runIntegrityCheck(db, { lib });
  expect(r.ok && !r.alerts.length, 'first night must only record a baseline: ' + JSON.stringify(r.alerts));
  // night 2: nothing changed
  r = await runIntegrityCheck(db, { lib });
  expect(r.ok && !pushed.length, 'an unchanged night must stay silent: ' + JSON.stringify(r.alerts));

  // night 3: the 2.10 incident classes, all at once
  const bad = clone(base);
  const incomeIds = bad.tx.filter(t => t.type === 'income' && (t.status === 'paid' || t.stage === 'paid')).slice(0, 3).map(t => t.id);
  bad.tx.forEach(t => { if (incomeIds.includes(t.id)) { t.stage = 'unpaid'; t.status = 'unpaid'; t.lifecycleStatus = 'completed'; } });            // paid → unpaid, no statusLog
  bad.tx = bad.tx.slice(0, bad.tx.length - 12);                                                                                                     // 12 rows vanish
  bad.tx.push({ id: 'zzold1', type: 'income', customer: 'חוזר מהעבר', total: 800, date: '2026-09-07', stage: 'unpaid', status: 'unpaid', lifecycleStatus: 'completed', _updatedAt: 1788771600000 }); // old stamp, new id
  db.store['state/current'] = bad;
  r = await runIntegrityCheck(db, { lib });
  const text = (r.alerts || []).join(' | ');
  expect(!r.ok, 'a bad night must raise alerts');
  expect(/חזרו אחורה בתשלום/.test(text), 'unexplained payment regression not flagged: ' + text);
  expect(/נעלמו .* עסקאות/.test(text), 'vanished rows not flagged: ' + text);
  expect(/ישנות.* הופיעו/.test(text), 'resurrected old row not flagged: ' + text);
  expect(pushed.length === 1, 'the admin must be pushed exactly once, got ' + pushed.length);

  // a hard data error appearing overnight (negative total / partner share above the total)
  const db4 = fakeDb(clone(base)); await runIntegrityCheck(db4, { lib }); pushed.length = 0;
  const broken = clone(base); const inc0 = broken.tx.find(x => x.type === 'income' && (x.status === 'unpaid' || x.stage === 'unpaid')); inc0.total = 100; inc0.partnerAmount = 900;
  db4.store['state/current'] = broken;
  r = await runIntegrityCheck(db4, { lib });
  expect(/נתונים שגויים חדשים/.test((r.alerts || []).join('|')), 'a new hard data error must be flagged: ' + JSON.stringify(r.alerts));
  // a DELIBERATE regression (statusLog entry) must not alert
  const db2 = fakeDb(clone(base));
  await runIntegrityCheck(db2, { lib }); pushed.length = 0;
  const ok2 = clone(base);
  const one = ok2.tx.find(t => t.type === 'income' && (t.status === 'paid' || t.stage === 'paid'));
  one.stage = 'unpaid'; one.status = 'unpaid'; one.lifecycleStatus = 'completed'; one.statusLog = [{ at: Date.now(), from: 'paid', to: 'unpaid', by: 'asher' }];
  db2.store['state/current'] = ok2;
  r = await runIntegrityCheck(db2, { lib });
  expect(!/חזרו אחורה בתשלום/.test((r.alerts || []).join('|')), 'a deliberate, logged regression must not be flagged');

  // the very first dry run records the baseline
  const db3 = fakeDb(clone(base)); await runIntegrityCheck(db3, { lib, write: false });
  expect(!!db3.store['serverState/integrity'], 'the first dry run must record the baseline');
  // dry run (manual button) never moves the snapshot nor pushes
  const before = JSON.stringify(db2.store['serverState/integrity']);
  pushed.length = 0;
  db2.store['state/current'] = bad;
  r = await runIntegrityCheck(db2, { lib, write: false });
  expect(r.dryRun && JSON.stringify(db2.store['serverState/integrity']) === before && !pushed.length, 'a dry run must not write or push');

  // pure comparison edge: a vanished row WITH a tombstone (deliberate delete) stays quiet, WITHOUT one alerts at any count
  expect(compare({ tx: { a: ['u', 1], b: ['d', 1] }, tasks: {}, at: 5 }, { tx: { a: ['u', 1] }, tasks: {} }, { tx: [] }, 9, ['b']).length === 0, 'a deliberately deleted row (tombstone) must stay quiet');
  expect(compare({ tx: { a: ['u', 1], b: ['d', 1] }, tasks: {}, at: 5 }, { tx: { a: ['u', 1] }, tasks: {} }, { tx: [] }, 9, []).length === 1, 'a row that vanished WITHOUT a tombstone must alert even when it is just one');
  // 5.10 scan: five paid jobs vanishing (below the 5% threshold) used to pass silently
  const db5 = fakeDb(clone(base)); await runIntegrityCheck(db5, { lib }); pushed.length = 0;
  const lost5 = clone(base); lost5.tx = lost5.tx.slice(0, lost5.tx.length - 5);
  db5.store['state/current'] = lost5;
  r = await runIntegrityCheck(db5, { lib });
  expect(/בלי מחיקה מכוונת|נעלמו/.test((r.alerts || []).join('|')), '5 rows vanishing without tombstones must alert: ' + JSON.stringify(r.alerts));
  // ...but five rows deleted on purpose (tombstones) must not
  const db6 = fakeDb(clone(base)); await runIntegrityCheck(db6, { lib });
  const del5 = clone(base); const goneIds = del5.tx.slice(-5).map(t => t.id); del5.tx = del5.tx.slice(0, -5); del5._deletedIds = goneIds;
  db6.store['state/current'] = del5;
  r = await runIntegrityCheck(db6, { lib });
  expect(!(r.alerts || []).some(a => /בלי מחיקה מכוונת/.test(a)), 'deliberate deletes must not alert: ' + JSON.stringify(r.alerts));
  console.warn = origWarn;
  if (fails) process.exit(1);
  console.log('✅ integrity-check: בדיקת התקינות הלילית שקטה בלילה תקין ומתריעה על כל סוגי הנזק (נעלמו שורות / תשלום חזר / שורות ישנות הופיעו / פערים)');
})();
