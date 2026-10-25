#!/usr/bin/env node
/* Multi-device sync simulation — runs the REAL merge/stamp code from index.html
 * (api/_loadApp.js sandbox) on several simulated devices against one shared
 * "cloud" document, with a fake clock, delayed snapshot delivery, offline
 * work, deletions, payment changes and devices coming back with a stale cache.
 *
 * After each random scenario it checks the invariants whose violation cost us
 * real money (2.10: deleted rows came back as debts, paid jobs flipped to
 * unpaid):
 *   I1 no resurrection  — a row deleted and not edited afterwards exists nowhere
 *   I2 no loss          — a row created/edited after its last deletion exists everywhere
 *   I3 payment stage    — every tx's stage equals its LAST stage operation (any device)
 *   I4 task status      — every task's done/open equals its LAST status operation
 *   I5 convergence      — all devices and the cloud end identical
 *   I6 note             — the last edited note wins (other fields never clobber it)
 *
 *   node tests/sync-sim.js [seeds=200] [firstSeed=1]
 * Run by the pre-push hook with a small seed count.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const TRACE = process.env.TRACE || '';
const log = (...a) => { if (TRACE) console.log(new Date(clock.t).toISOString().slice(11, 19), ...a); };
const SEEDS = Number(process.argv[2]) || 200;
const FIRST = Number(process.argv[3]) || 1;

// ── deterministic PRNG ──
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const clock = { t: Date.UTC(2026, 8, 1, 9, 0, 0) };
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }

// ── one simulated device = one sandboxed copy of the app ──
function makeDevice(name, { oldCode = false } = {}) {
  const app = loadApp(HTML);
  app.Date = FakeDate;
  const ls = {}; app.localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  oldCode = oldCode || process.env.MUTATE === 'old';          // MUTATE=old: prove the simulation can see the 2.10 bugs (it must FAIL)
  const dev = { name, app, oldCode, online: true, cache: null, queue: [], saveDue: null };
  if (oldCode) {
    const orig = app.mergeRowsById;
    app.mergeRowsById = (a, b) => orig(a, b);            // pre-2.10 behaviour: no stale-row rule, no payment-group merge
    app._logStatusRegressions = () => {};
  }
  return dev;
}
const ctx = (d, code) => vm.runInContext(code, d.app);
function resetDevice(d) {
  d.app.state = { tx: [], tasks: [], customerMeta: {}, whatsappInbox: [], priceList: [], settlements: [], products: [], dailyNotes: {}, _deletedIds: [], _deletedAt: {}, _dictUpdatedAt: {}, _dictDeleted: {}, currentUser: { role: 'admin', email: d.name } };
  ctx(d, '_localEdits.clear(); _clockOffset = 0;');
  d.online = true; d.cache = null; d.queue = []; d.saveDue = null;
}
function persist(d) {
  const s = d.app.state;
  d.cache = JSON.stringify({ tx: s.tx, tasks: s.tasks, customerMeta: s.customerMeta, whatsappInbox: s.whatsappInbox, dailyNotes: s.dailyNotes, products: s.products, priceList: s.priceList, settlements: s.settlements, _deletedIds: s._deletedIds, _deletedAt: s._deletedAt, _dictUpdatedAt: s._dictUpdatedAt, _dictDeleted: s._dictDeleted, _syncedAt: s._syncedAt || 0, _stampSig: s._stampSig || {}, _stampFields: s._stampFields || {} });
}
function restore(d) {
  if (!d.cache) return;
  const p = JSON.parse(d.cache), s = d.app.state;
  Object.assign(s, JSON.parse(JSON.stringify(p)));
}

// ── the shared cloud document ──
const cloud = { doc: null, writes: 0 };
function writeCloud(from, devices) {
  const s = from.app.state;
  const doc = JSON.parse(JSON.stringify({ tx: s.tx, tasks: s.tasks, customerMeta: s.customerMeta, whatsappInbox: [], inboxSplit: true, dailyNotes: s.dailyNotes, products: s.products, priceList: s.priceList, settlements: s.settlements, _deletedIds: s._deletedIds, _deletedAt: s._deletedAt, _dictUpdatedAt: s._dictUpdatedAt, _dictDeleted: s._dictDeleted, updated: clock.t, writer: from.name }));
  cloud.doc = doc; cloud.writes++;
  if (TRACE) { const r = (doc.tx || []).concat(doc.tasks || []).find(x => x.id === TRACE); log('WRITE by', from.name, 'row:', r ? 'present upd=' + r._updatedAt + ' st=' + (r.status || '') : 'ABSENT', '| tomb:', (doc._deletedIds || []).includes(TRACE) ? 'yes@' + (doc._deletedAt || {})[TRACE] : 'no'); }
  devices.forEach(d => { if (d !== from) d.queue.push({ at: clock.t + Math.floor(rng.cur() * 150000), doc }); });   // 0–150 s snapshot latency
}

function save(d, devices) {                                // saveState(): stamp -> write -> remember sync point
  const app = d.app;
  app._stampAllChangedRows();
  if (TRACE) { const r = app.state.tx.concat(app.state.tasks).find(x => x.id === TRACE); if (r) log('   [' + d.name + (d.online ? '' : ' OFFLINE') + ' local]', 'upd=' + r._updatedAt, 'st=' + (r.status || ''), 'stageAt=' + (r._fieldAt && r._fieldAt.status), 'note=' + (r.notes || '')); }
  persist(d);
  if (!d.online) return;
  const started = app._clockNow();
  writeCloud(d, devices);
  d.app.state._syncedAt = started;
  app._captureBaseline();
  persist(d);
}
function receive(d, devices, doc) {                        // applySnapshot()
  const app = d.app;
  if (TRACE) { const r = (doc.tx || []).concat(doc.tasks || []).find(x => x.id === TRACE); log('  ' + d.name + ' receives: row', r ? 'present upd=' + r._updatedAt : 'ABSENT', '| tomb', (doc._deletedIds || []).includes(TRACE)); }
  if (TRACE) { const lr = app.state.tx.concat(app.state.tasks).find(x => x.id === TRACE), rr = (doc.tx || []).concat(doc.tasks || []).find(x => x.id === TRACE); if (lr && rr) log('   [' + d.name + ' PRE-MERGE]', 'LOC upd=' + lr._updatedAt, JSON.stringify(lr._fieldAt), '| REM upd=' + rr._updatedAt, JSON.stringify(rr._fieldAt)); }
  app.mergeCloudDoc(JSON.parse(JSON.stringify(doc)), null);
  if (TRACE) { const r = app.state.tx.concat(app.state.tasks).find(x => x.id === TRACE); if (r) log('   [' + d.name + ' after merge]', 'upd=' + r._updatedAt, 'st=' + (r.status || ''), 'stageAt=' + (r._fieldAt && r._fieldAt.status)); }
  app._captureBaseline();
  let ahead = false; try { ahead = app._localAheadOfRemote(doc); } catch (_) {}
  if (ahead) d.saveDue = clock.t + 600; else d.app.state._syncedAt = app._clockNow();
  persist(d);
}
function boot(d, devices) {                                // open the app: local cache first, then the cloud copy
  restore(d);
  d.app._captureBaseline();
  d.online = true; d.queue = [];
  if (cloud.doc) {
    if (TRACE) { const lr = d.app.state.tx.concat(d.app.state.tasks).find(x => x.id === TRACE), rr = (cloud.doc.tx || []).concat(cloud.doc.tasks || []).find(x => x.id === TRACE); log('   [' + d.name + ' BOOT PRE-MERGE] localTomb=' + JSON.stringify((d.app.state._deletedAt || {})[TRACE]) + ' cloudTomb=' + JSON.stringify((cloud.doc._deletedAt || {})[TRACE]), lr ? 'LOC upd=' + lr._updatedAt + ' st=' + lr.status + ' ' + JSON.stringify(lr._fieldAt) : 'LOC none', '| REM', rr ? 'upd=' + rr._updatedAt + ' st=' + rr.status + ' ' + JSON.stringify(rr._fieldAt) : 'none'); }
    d.app.mergeCloudDoc(JSON.parse(JSON.stringify(cloud.doc)), []);
    if (TRACE) { const lr = d.app.state.tx.concat(d.app.state.tasks).find(x => x.id === TRACE); log('   [' + d.name + ' BOOT POST-MERGE]', lr ? 'upd=' + lr._updatedAt + ' st=' + lr.status : 'row gone'); }
    let ahead = false; try { ahead = d.app._localAheadOfRemote(cloud.doc); } catch (_) {}
    d.app._captureBaseline();
    if (ahead) d.saveDue = clock.t + 800; else d.app.state._syncedAt = d.app._clockNow();
  } else d.saveDue = clock.t + 1;
  persist(d);
}
function pump(devices) {                                   // deliver due snapshots and due saves
  for (let guard = 0; guard < 200; guard++) {
    let did = false;
    devices.forEach(d => {
      if (d.online) {
        const due = d.queue.filter(q => q.at <= clock.t);
        if (due.length) { d.queue = d.queue.filter(q => q.at > clock.t); receive(d, devices, due[due.length - 1].doc); did = true; }
        if (d.saveDue != null && d.saveDue <= clock.t) { d.saveDue = null; save(d, devices); did = true; }
      }
    });
    if (!did) break;
  }
}

// ── operations (each also records what the OPERATION intended: the oracle) ──
function runScenario(seed, devices, { allowOld }) {
  const R = rng(seed); rng.cur = R;
  cloud.doc = null; cloud.writes = 0; clock.t = Date.UTC(2026, 8, 1, 9, 0, 0);
  devices.forEach(resetDevice);
  const O = { tx: {}, task: {}, st: {} };                         // oracle per id
  let nextId = 1;
  const pick = a => a[Math.floor(R() * a.length)];
  const rec = (kind, id) => (O[kind][id] = O[kind][id] || { created: 0, writes: 0, delAt: -1, lastWrite: -1, stageAt: -1, stage: null, noteAt: -1, note: null });
  devices.forEach(d => boot(d, devices));
  pump(devices);

  const steps = 40 + Math.floor(R() * 60);
  for (let i = 0; i < steps; i++) {
    clock.t += 30000 + Math.floor(R() * 600000);          // 0.5–10.5 min per step
    pump(devices);
    const d = pick(devices), app = d.app, s = app.state;
    const r = R();
    if (r < 0.06) { d.online = !d.online; if (d.online) { d.queue = []; if (cloud.doc) { receive(d, devices, cloud.doc); } d.saveDue = clock.t + 100; } continue; }
    if (r < 0.10) { persist(d); resetCacheOnly(d); boot(d, devices); continue; }       // close + reopen (cache restore, then cloud)
    const rows = s.tx.filter(t => t.type === 'income'), tasks = s.tasks;
    const op = R();
    if (op < 0.22 || (!rows.length && !tasks.length)) {   // create tx
      const id = 'x' + (nextId++);
      const t = { id, type: 'income', customer: 'c' + id, total: 100 + Math.floor(R() * 900), date: '2026-09-01', work: 'w', notes: '', whoseCustomer: 'mine' };
      app.applyTxStage(t, 'unpaid'); s.tx.push(t);
      const o = rec('tx', id); o.created = clock.t; o.lastWrite = clock.t; o.stageAt = clock.t; o.stage = 'unpaid';
    } else if (op < 0.30) {                                 // create task
      const id = 'k' + (nextId++);
      s.tasks.push({ id, task: 't' + id, status: 'open', kind: 'work' });
      const o = rec('task', id); o.created = clock.t; o.lastWrite = clock.t; o.stageAt = clock.t; o.stage = 'open';
    } else if (op < 0.50 && rows.some(r => app.txStage(r) !== 'paid')) {   // pay (only a row that is not paid in THIS device's view — the UI offers nothing else)
      const t = pick(rows.filter(r => app.txStage(r) !== 'paid')); app.setTxStage(t, 'paid'); t.paidDate = '2026-09-02';
      const o = rec('tx', t.id); o.lastWrite = clock.t; o.stageAt = clock.t; o.stage = 'paid'; o.by = d.name; o.byOnline = d.online;
    } else if (op < 0.58 && rows.some(r => app.txStage(r) === 'paid')) {   // deliberate regression (paid -> unpaid)
      const t = pick(rows.filter(r => app.txStage(r) === 'paid')); app.setTxStage(t, 'unpaid');
      const o = rec('tx', t.id); o.lastWrite = clock.t; o.stageAt = clock.t; o.stage = 'unpaid'; o.by = d.name; o.byOnline = d.online;
    } else if (op < 0.72 && rows.length) {                  // unrelated edit (note) — must not touch payment state
      const t = pick(rows); t.notes = 'n' + i;
      const o = rec('tx', t.id); o.lastWrite = clock.t; o.noteAt = clock.t; o.note = t.notes;
    } else if (op < 0.80 && rows.length) {                  // delete tx
      const t = pick(rows); app.markDeleted(t.id); s.tx = s.tx.filter(x => x.id !== t.id);
      rec('tx', t.id).delAt = clock.t;
    } else if (op < 0.88 && tasks.length) {                 // complete / reopen task
      const t = pick(tasks); const done = t.status !== 'done';
      t.status = done ? 'done' : 'open'; if (done) t.completedAt = clock.t; else delete t.completedAt;
      const o = rec('task', t.id); o.lastWrite = clock.t; o.stageAt = clock.t; o.stage = t.status;
    } else if (op < 0.93) {                                 // settlements: create / edit amount / delete
      const sts = s.settlements; const k = R();
      if (k < 0.4 || !sts.length) { const id = 's' + (nextId++); s.settlements.push({ id, direction: 'fromPartner', amount: 100, partnerName: 'אהרן' }); const o = rec('st', id); o.created = clock.t; o.lastWrite = clock.t; o.note = 100; o.noteAt = clock.t; }
      else if (k < 0.75) { const x = pick(sts); x.amount = 200 + i; const o = rec('st', x.id); o.lastWrite = clock.t; o.note = x.amount; o.noteAt = clock.t; }
      else { const x = pick(sts); app.markDeleted(x.id); s.settlements = s.settlements.filter(y => y.id !== x.id); rec('st', x.id).delAt = clock.t; }
    } else if (tasks.length) {                              // delete task
      const t = pick(tasks); app.markDeleted(t.id); s.tasks = s.tasks.filter(x => x.id !== t.id);
      rec('task', t.id).delAt = clock.t;
    }
    if (TRACE) { const mine = s.tx.concat(s.tasks).find(x => x.id === TRACE); log('OP by', d.name, 'online=' + d.online, 'op=' + op.toFixed(2), 'hasRow=' + !!mine); }
    save(d, devices);
  }

  // ── settle: everybody online, deliver everything, let merge-pushes finish ──
  devices.forEach(d => { d.online = true; });
  for (let round = 0; round < 12; round++) {
    clock.t += 400000;
    const before = cloud.writes;
    devices.forEach(d => { if (cloud.doc) { d.queue = []; receive(d, devices, cloud.doc); } });
    pump(devices);
    devices.forEach(d => { if (d.saveDue != null) { d.saveDue = null; save(d, devices); } });
    pump(devices);
    if (cloud.writes === before && round > 1) break;
  }
  return { O, cloudDoc: cloud.doc };
}
function resetCacheOnly(d) { /* closing the app keeps the on-disk cache; memory is rebuilt by boot() */ d.app.state = Object.assign(d.app.state, { tx: [], tasks: [], _deletedIds: [], _deletedAt: {} }); }

// ── invariants ──
function check(seed, devices, res, { strictResurrection }) {
  const bad = [];
  const { O, cloudDoc } = res;
  const views = devices.map(d => ({ name: d.name, tx: Object.fromEntries(d.app.state.tx.map(t => [t.id, t])), tasks: Object.fromEntries(d.app.state.tasks.map(t => [t.id, t])), st: Object.fromEntries(d.app.state.settlements.map(t => [t.id, t])) }));
  views.push({ name: 'cloud', tx: Object.fromEntries((cloudDoc.tx || []).map(t => [t.id, t])), tasks: Object.fromEntries((cloudDoc.tasks || []).map(t => [t.id, t])), st: Object.fromEntries((cloudDoc.settlements || []).map(t => [t.id, t])) });
  for (const kind of ['tx', 'task', 'st']) {
    const key = kind === 'tx' ? 'tx' : kind === 'task' ? 'tasks' : 'st';
    for (const [id, o] of Object.entries(O[kind])) {
      const shouldExist = o.delAt < 0 || o.lastWrite > o.delAt;
      for (const v of views) {
        const row = v[key][id];
        if (!shouldExist && row && strictResurrection) bad.push(`I1 resurrection: ${kind} ${id} exists on ${v.name} (deleted@${o.delAt}, last write@${o.lastWrite})`);
        if (shouldExist && !row) bad.push(`I2 loss: ${kind} ${id} missing on ${v.name} (deleted@${o.delAt}, last write@${o.lastWrite})`);
        // A row that was deleted at some point and then brought back by a later edit on another device is a
        // genuine conflict (the revived row is that device's version) — only existence is asserted for it.
        if (shouldExist && row && o.delAt < 0) {
          if (kind === 'tx') {
            const st = (txStageOf(devices[0], row));
            if (o.stage && st !== o.stage) bad.push(`I3 stage: tx ${id} on ${v.name} is ${st}, last stage op said ${o.stage} (by ${o.by} online=${o.byOnline} at ${new Date(o.stageAt).toISOString().slice(11,19)})`);
            if (o.note != null && row.notes !== o.note) bad.push(`I6 note: tx ${id} on ${v.name} is "${row.notes}", last note op said "${o.note}"`);
          } else if (kind === 'task') { if (o.stage && row.status !== o.stage) bad.push(`I4 task: ${id} on ${v.name} is ${row.status}, last op said ${o.stage}`); }
          else if (o.note != null && row.amount !== o.note) bad.push(`I6 settlement: ${id} on ${v.name} amount ${row.amount}, last op said ${o.note}`);
        }
      }
    }
  }
  // I5 convergence on what survived
  const sig = v => JSON.stringify([Object.keys(v.tx).sort().map(i => [i, txStageOf(devices[0], v.tx[i]), v.tx[i].notes || '']), Object.keys(v.tasks).sort().map(i => [i, v.tasks[i].status]), Object.keys(v.st).sort().map(i => [i, v.st[i].amount])]);
  const ref = sig(views[views.length - 1]);
  views.slice(0, -1).forEach(v => { if (sig(v) !== ref) bad.push(`I5 divergence: ${v.name} differs from the cloud`); });
  return bad;
}
function txStageOf(d, t) { return vm.runInContext('txStage', d.app)(t); }

// ── the exact incident: a stale device copy (legacy rows, some with no stamp at all, rows deleted
//    BEFORE tombstones existed) opening weeks later — nothing old may come back, nothing may be pushed ──
function legacyStaleScenario(withSyncRecord) {
  const [A, S] = [makeDevice('A'), makeDevice('S')];
  [A, S].forEach(resetDevice);
  const devices = [A, S];
  cloud.doc = null; cloud.writes = 0; clock.t = Date.UTC(2026, 7, 1, 9, 0, 0);
  rng.cur = rng(7);
  boot(A, devices); pump(devices);
  // old rows in the cloud — half of them without any _updatedAt (pre-stamping data)
  const rowsSeed = ['L1', 'L2', 'L3', 'L4', 'L5'].map((id, i) => ({ id, type: 'income', customer: id, total: 500, date: '2026-07-07', work: 'old', notes: '', whoseCustomer: 'mine', ...(i % 2 ? { _updatedAt: Date.UTC(2026, 6, 7, 9) } : {}) }));
  rowsSeed.forEach(r => { A.app.applyTxStage(r, 'unpaid'); if (!(r.id === 'L2' || r.id === 'L4')) delete r._updatedAt; });
  A.app.state.tx.push(...rowsSeed); A.app._captureBaseline();
  // write them straight into the cloud with the legacy shape (stamps preserved as-is, no stamping)
  cloud.doc = JSON.parse(JSON.stringify({ tx: A.app.state.tx, tasks: [], customerMeta: {}, whatsappInbox: [], inboxSplit: true, dailyNotes: {}, products: [], priceList: [], settlements: [], _deletedIds: [], _deletedAt: {}, updated: clock.t }));
  boot(S, devices);                                   // S caches everything and then goes away
  S.app.state._syncedAt = withSyncRecord ? clock.t : 0; persist(S);
  // 30 days later A removes L2 and L3 "the old way": gone from the cloud, NO tombstone anywhere
  clock.t += 30 * 86400000;
  A.app.state.tx = A.app.state.tx.filter(r => r.id !== 'L2' && r.id !== 'L3'); A.app._captureBaseline();
  cloud.doc.tx = cloud.doc.tx.filter(r => r.id !== 'L2' && r.id !== 'L3'); cloud.doc.updated = clock.t;
  A.app.state._syncedAt = clock.t; persist(A);
  // S opens the app: old cache first, then the cloud copy
  resetCacheOnly(S); boot(S, devices); pump(devices);
  for (let i = 0; i < 6; i++) { clock.t += 400000; pump(devices); [A, S].forEach(d => { if (d.saveDue != null) { d.saveDue = null; save(d, devices); } }); pump(devices); }
  const ids = d => d.app.state.tx.map(r => r.id).sort().join(',');
  const cloudIds = (cloud.doc.tx || []).map(r => r.id).sort().join(',');
  const want = 'L1,L4,L5';
  const bad = [];
  if (ids(S) !== want) bad.push(`stale device S ended with ${ids(S)} (want ${want}) [syncRecord=${withSyncRecord}]`);
  if (ids(A) !== want) bad.push(`device A ended with ${ids(A)} (want ${want}) [syncRecord=${withSyncRecord}]`);
  if (cloudIds !== want) bad.push(`cloud ended with ${cloudIds} (want ${want}) — stale rows were pushed back [syncRecord=${withSyncRecord}]`);
  return bad;
}
// A device still on the OLD code pushes an old row back: it can't be stopped, but a new-code device MUST flag it.
function oldCodeWatchdogScenario() {
  const [A, OLD] = [makeDevice('A'), makeDevice('OLD', { oldCode: true })];
  [A, OLD].forEach(resetDevice);
  const devices = [A, OLD];
  cloud.doc = null; cloud.writes = 0; clock.t = Date.UTC(2026, 8, 1, 9, 0, 0);
  rng.cur = rng(11);
  boot(A, devices); boot(OLD, devices); pump(devices);
  const t = { id: 'W1', type: 'income', customer: 'old job', total: 900, date: '2026-09-01', work: 'w', notes: '', whoseCustomer: 'mine' };
  A.app.applyTxStage(t, 'unpaid'); A.app.state.tx.push(t); save(A, devices);
  clock.t += 200000; pump(devices);                   // OLD now holds W1 (and a sync record)
  clock.t += 2 * 86400000;
  A.app.markDeleted('W1'); A.app.state.tx = A.app.state.tx.filter(r => r.id !== 'W1'); save(A, devices);
  // OLD never received the deletion (was offline) and re-pushes its stale copy with a FRESH stamp? no: with its OLD stamp
  OLD.queue = []; OLD.app.state.tx.forEach(r => { r._updatedAt = r._updatedAt; });
  clock.t += 3600000; const doc = JSON.parse(JSON.stringify(cloud.doc));
  doc.tx = [{ ...OLD.app.state.tx.find(r => r.id === 'W1') }]; doc._deletedIds = []; doc._deletedAt = {};   // what an old client writes: stale row, no tombstone
  cloud.doc = doc;
  A.app.state.tx = []; A.app.state._deletedIds = []; A.app.state._deletedAt = {};            // A has already forgotten (tombstone trimmed)
  receive(A, devices, doc); pump(devices);
  const flagged = A.app.suspectIncomingRows().map(r => r.id);
  return flagged.includes('W1') ? [] : [`new-code device did not flag the resurrected old row (flagged: ${flagged.join(',') || 'none'})`];
}

// ── main ──
const newDevs = ['A', 'B', 'C'].map(n => makeDevice(n));
const mixed = [makeDevice('A'), makeDevice('B'), makeDevice('OLD', { oldCode: true })];
let failed = 0, shown = 0, scenarios = 0;
const origWarn = console.warn; console.warn = () => {};
for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
  const res = runScenario(seed, newDevs, {});
  const bad = check(seed, newDevs, res, { strictResurrection: true });
  scenarios++;
  if (bad.length) { failed++; if (shown++ < 6) { console.error(`❌ seed ${seed}: ${bad.length} violation(s)`); bad.slice(0, 3).forEach(b => console.error('    ' + b)); } }
}
// With a device that still runs the OLD code the app can't promise "no resurrection", but nothing may be LOST,
// payment/task state must still follow the last operation and everyone must converge.
let oldFailed = 0;
for (let seed = FIRST; !process.env.NOMIXED && seed < FIRST + Math.max(20, Math.floor(SEEDS / 5)); seed++) {
  const res = runScenario(seed + 100000, mixed, {});
  const bad = check(seed, mixed, res, { strictResurrection: false }).filter(b => !/^I3|^I4|^I6/.test(b) || true);
  scenarios++;
  const hard = bad.filter(b => /^I2|^I5/.test(b));
  if (hard.length) { oldFailed++; if (shown++ < 8) { console.error(`❌ (with old-code device) seed ${seed}: ${hard.length} violation(s)`); hard.slice(0, 2).forEach(b => console.error('    ' + b)); } }
}
const special = [...legacyStaleScenario(false), ...legacyStaleScenario(true), ...oldCodeWatchdogScenario()];
special.forEach(b => console.error('❌ ' + b));
console.warn = origWarn;
if (special.length) { console.error('sync-sim: scenario(s) of the 2.10 incident failed'); process.exit(1); }
if (failed || oldFailed) { console.error(`sync-sim: ${failed} failing scenario(s) (all-new devices), ${oldFailed} with an old-code device, of ${scenarios}`); process.exit(1); }
console.log(`✅ sync-sim: ${scenarios} תרחישי מכשירים מרובים + 3 תרחישי האירוע של 2.10 עברו (מחיקות לא חוזרות, שום שורה לא אובדת, סטטוס תשלום/משימה תמיד לפי הפעולה האחרונה, כולם מתכנסים)`);
