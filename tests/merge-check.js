#!/usr/bin/env node
/* Guards the multi-device merge rule (index.html mergeRowsById, dropStale):
 * a row that exists only on a device, and is older than that device's last
 * full sync, was deleted elsewhere and must NOT be pushed back as new
 * (incident 2.10: four old 7.9-import rows came back from a stale device copy
 * and re-appeared as open debts). Genuine offline rows must survive.
 *   node tests/merge-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');

const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
const vm = require('vm');
const inCtx = (code) => vm.runInContext(code, app); // top-level const/let live in the page's script scope, not as properties
if (typeof app.mergeRowsById !== 'function') { console.error('❌ mergeRowsById did not load as a top-level function'); process.exit(1); }

const DAY = 86400000, now = Date.now();
const remote = [{ id: 'a', _updatedAt: now - 5 * DAY }, { id: 'b', _updatedAt: now - 2 * DAY }, { id: 'c', _updatedAt: now - DAY }];
let fails = 0;
function run(label, local, synced, want, opts) {
  app.state._syncedAt = synced; app.state._deletedIds = []; app.state._deletedAt = {};
  const out = app.mergeRowsById(local, remote, opts || { dropStale: true }).map(r => r.id).sort().join(',');
  if (out !== want) { fails++; console.error(`❌ ${label}: got ${out}, want ${want}`); }
}
const stale = { id: 'stale', type: 'income', total: 2000, date: '2026-09-07', _updatedAt: 1788771600000 };
const origWarn = console.warn; console.warn = () => {};
run('legacy cache: stale + unstamped rows dropped, fresh kept', [...remote, stale, { id: 'nostamp' }, { id: 'fresh', _updatedAt: now - 60000 }], 0, 'a,b,c,fresh');
run('synced 1h ago: older local-only row dropped, newer kept', [...remote, { id: 'old', _updatedAt: now - 2 * DAY }, { id: 'new', _updatedAt: now - 1000 }], now - 3600000, 'a,b,c,new');
run('offline row made after the last sync survives', [...remote, { id: 'off', _updatedAt: now - 4 * DAY }], now - 6 * DAY, 'a,b,c,off');
inCtx("_localEdits.set('protected', 1)");
run('an in-session edit is protected', [...remote, { id: 'protected', _updatedAt: 1 }], now, 'a,b,c,protected');
inCtx("_localEdits.delete('protected')");
const many = Array.from({ length: 9 }, (_, i) => ({ id: 'm' + i, _updatedAt: 1 }));
run('mass "stale" looks like a cloud problem: keep everything', [...remote, ...many], now, ['a', 'b', 'c', ...many.map(r => r.id)].sort().join(','));
app.state._syncedAt = now;
if (app.mergeRowsById([stale, { id: 'fresh', _updatedAt: now }], [], { dropStale: true }).length !== 2) { fails++; console.error('❌ an empty cloud copy must never drop local rows'); }
run('without dropStale (products/priceList/inbox) behaviour is unchanged', [...remote, stale], now, 'a,b,c,stale', {});
const m = app.mergeRowsById([{ id: 'a', v: 'local', _updatedAt: now }], remote, { dropStale: true });
if (m.find(r => r.id === 'a').v !== 'local') { fails++; console.error('❌ newer local copy of the same id must still win'); }

// ── payment-regression trail (_logStatusRegressions / recentRegressions) ──
app.state.currentUser = { role: 'admin', email: 'asher@test' };
const base = [
  { id: 'p1', type: 'income', total: 500, stage: 'paid', status: 'paid', lifecycleStatus: 'paid', paidDate: '2026-09-01' },
  { id: 'p2', type: 'income', total: 500, stage: 'unpaid', status: 'unpaid', lifecycleStatus: 'completed' },
  { id: 'p3', type: 'income', total: 500, stage: 'partial', status: 'partial', lifecycleStatus: 'completed', paidAmount: 200 },
];
const cur = JSON.parse(JSON.stringify(base));
cur[0].stage = 'unpaid'; cur[0].status = 'unpaid'; cur[0].lifecycleStatus = 'completed';           // paid -> unpaid (regression)
cur[1].stage = 'paid'; cur[1].status = 'paid'; cur[1].lifecycleStatus = 'paid';                    // unpaid -> paid (progress)
cur[2].paidAmount = 100;                                                                           // partial stays partial (not a stage regression)
app._logStatusRegressions(base, cur);
if (!(cur[0].statusLog && cur[0].statusLog.length === 1 && cur[0].statusLog[0].from === 'paid' && cur[0].statusLog[0].to === 'unpaid' && cur[0].statusLog[0].by === 'asher@test')) { fails++; console.error('❌ paid→unpaid must leave a statusLog entry (from/to/by)'); }
if (cur[1].statusLog || cur[2].statusLog) { fails++; console.error('❌ progress / unchanged stage must not be logged'); }
app.state.tx = cur;
const rr = app.recentRegressions(72).map(t => t.id).join(',');
if (rr !== 'p1') { fails++; console.error('❌ recentRegressions should flag only p1, got ' + rr); }
cur[0].statusLog[0].at = Date.now() - 5 * DAY;
if (app.recentRegressions(72).length !== 0) { fails++; console.error('❌ a regression older than 72h must not be flagged'); }

// ── old-device watchdog (_noteSuspectIncoming / suspectIncomingRows) ──
const store = {}; app.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
app.state._syncedAt = now; app.state._deletedIds = []; app.state.tx = [{ id: 'have', _updatedAt: 1 }]; app.state.tasks = [];
app._noteSuspectIncoming('tx', app.state.tx, [
  { id: 'have', _updatedAt: 1 },                                  // already local -> ignore
  { id: 'old1', customer: 'לקוח ישן', _updatedAt: now - 3 * DAY },  // new to us + old stamp -> suspect
  { id: 'fresh1', customer: 'חדש', _updatedAt: now - 1000 },        // new + fresh stamp -> legit
]);
app.state.tx = [...app.state.tx, { id: 'old1' }, { id: 'fresh1' }];
let sus = app.suspectIncomingRows().map(r => r.id).join(',');
if (sus !== 'old1') { fails++; console.error('❌ watchdog should flag only the old-stamped incoming row, got: ' + sus); }
app.state._syncedAt = 0; delete store.pm_suspectIncoming;
app._noteSuspectIncoming('tx', [], [{ id: 'old2', _updatedAt: 5 }]);
if (app.suspectIncomingRows().length) { fails++; console.error('❌ without a sync record the watchdog must stay silent'); }
store.pm_suspectDismissed = JSON.stringify(['old1']); store.pm_suspectIncoming = JSON.stringify({ old1: { kind: 'tx', label: 'x', at: 1 } });
if (app.suspectIncomingRows().length) { fails++; console.error('❌ a dismissed suspect must not show again'); }

// ── one shared "real debt" definition for the collection messages ──
app.state.tx = [];
const debt = (o) => ({ type: 'income', stage: 'unpaid', status: 'unpaid', lifecycleStatus: 'completed', whoseCustomer: 'mine', total: 500, date: '2026-09-01', ...o });
const okDebt = app.isRealCollectionDebt(debt({})), zero = app.isRealCollectionDebt(debt({ total: 0 })), promised = app.isRealCollectionDebt(debt({ promiseDate: '2999-01-01' }));
if (!(okDebt && !zero && !promised)) { fails++; console.error(`❌ isRealCollectionDebt: normal=${okDebt} zero=${zero} promised=${promised}`); }

// ── field-level merge ──
const T = 1000000;
const cloudRow = { id: 'r', notes: 'cloud note', stage: 'paid', status: 'paid', _updatedAt: T + 50, _fieldAt: { notes: T + 50, stage: T, status: T } };
const deviceRow = { id: 'r', notes: '', stage: 'unpaid', status: 'unpaid', _updatedAt: T + 100, _fieldAt: { notes: T + 10 } };
const hyb = app.mergeRowFields(deviceRow, cloudRow, inCtx('_TX_GROUPS'));
if (!(hyb.stage === 'paid' && hyb.status === 'paid')) { fails++; console.error('❌ a payment made earlier must survive a later, unrelated edit of the same row: ' + hyb.stage); }
if (hyb.notes !== 'cloud note') { fails++; console.error('❌ the newer note must survive: ' + hyb.notes); }
if (!(hyb._updatedAt > deviceRow._updatedAt && hyb._updatedAt > cloudRow._updatedAt && hyb._realAt === T + 100)) { fails++; console.error('❌ a hybrid needs a push stamp newer than both, and must remember the real edit time'); }
const restored = { id: 'r', notes: 'from backup', stage: 'unpaid', status: 'unpaid', _updatedAt: T + 900, _fieldAt: { notes: T + 900, stage: T + 900, status: T + 900 } };
const afterRestore = app.mergeRowFields(restored, cloudRow, inCtx('_TX_GROUPS'));
if (!(afterRestore.notes === 'from backup' && afterRestore.stage === 'unpaid')) { fails++; console.error('❌ a restored row (every field stamped now) must beat the cloud version field by field'); }
// a deletion is judged by the real edit time, not by a hybrid's push stamp
app.state._deletedIds = ['r']; app.state._deletedAt = { r: T + 120 }; app.state._syncedAt = 0;
const kept = app.mergeRowsById([deviceRow], [cloudRow], { groups: inCtx('_TX_GROUPS') }).length;
if (kept !== 0) { fails++; console.error('❌ a hybrid of two versions older than the deletion must not revive the row'); }
// ── hard data errors (txInvariantIssues) ──
const mk = o => ({ type: 'income', total: 500, date: '2026-09-01', whoseCustomer: 'mine', stage: 'unpaid', status: 'unpaid', lifecycleStatus: 'completed', ...o });
const expectIssue = (label, t, re) => { const i = app.txInvariantIssues(t).join('|'); if (!re.test(i)) { fails++; console.error(`❌ invariant "${label}" not caught: ${i || 'none'}`); } };
if (app.txInvariantIssues(mk({})).length) { fails++; console.error('❌ a healthy transaction must raise no issue'); }
expectIssue('negative total', mk({ total: -5 }), /שלילי/);
expectIssue('partner share above total', mk({ partnerName: 'אהרן', partnerAmount: 900 }), /גדול מהסכום/);
expectIssue('paid more than total (partial)', mk({ stage: 'partial', status: 'partial', paidAmount: 900 }), /יותר מהסכום/);
expectIssue('partial without an amount', mk({ stage: 'partial', status: 'partial', paidAmount: 0 }), /בלי סכום ששולם/);
expectIssue("partner's customer without a partner", mk({ whoseCustomer: 'partner' }), /בלי שם שותף/);
expectIssue('done job without a date', mk({ date: '' }), /אין תאריך/);
if (app.txInvariantIssues(mk({ stage: 'quote', status: undefined, lifecycleStatus: 'quote', partnerAmount: 9999, partnerName: 'x' })).length) { fails++; console.error('❌ a quote is not held to money invariants'); }
console.warn = origWarn;
if (fails) process.exit(1);
console.log('✅ merge-check: מיזוג (8) + יומן חזרה-בתשלום (4) + שומר שורות ישנות (3) + הגדרת חוב אמיתי (1) עברו');
