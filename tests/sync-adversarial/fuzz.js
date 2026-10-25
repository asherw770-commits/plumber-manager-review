'use strict';
/* node fuzz.js [seeds=100] [first=1]   env: OWNER=1 LIEFI=1 UNDO=1 SKEW=1 DOUBLE=1 PARTIAL=1 APP_HTML=...
 * 3 admins (+ optional owner "Y" via state/owner_actions) on one fake Firestore, virtual time, REAL app code. */
const H = require('./h');
const vm = require('vm');
const SEEDS = Number(process.argv[2]) || 100, FIRST = Number(process.argv[3]) || 1;
const E = process.env;
const cfg = { owner: !!E.OWNER, lieFi: !!E.LIEFI, undo: !!E.UNDO, skew: !!E.SKEW || !!E.SKEWD, double: !!E.DOUBLE, partial: !!E.PARTIAL, devs: Number(E.DEVS) || 3, steps: Number(E.STEPS) || 70 };

const rowSig = t => JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => k[0] !== '_' && k !== 'statusLog').sort()));
const groupSig = t => JSON.stringify([t.stage, Number(t.paidAmount) || 0, (t.receipts || []).length, (t.receipts || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)]);

async function scenario(seed) {
  const W = new H.World(seed, { coalesce: !!E.COAL, lat: E.LAT ? E.LAT.split(',').map(Number) : undefined });
  const names = ['A', 'B', 'C', 'D'].slice(0, cfg.devs);
  const devs = names.map((n, i) => H.makeDevice(W, n, 'admin', { skew: cfg.skew && i === 1 ? (W.pick([-1, 1]) * W.int(3600000 * 5)) : 0, detected: !!E.SKEWD }));
  let Y = null; if (cfg.owner) Y = H.makeDevice(W, 'Y', 'owner', { direct: !!E.DIRECT });
  const all = Y ? devs.concat([Y]) : devs;
  for (const d of all) await W.go(H.boot(d));
  const O = { tx: {}, task: {} };      // oracle
  let curDev = null; const rec = (k, id) => { if (!O[k][id]) { const o = O[k][id] = { events: [], note: null, pay: null, total: null, task: null, deleted: false }; o.events.push = function (e) { Array.prototype.push.call(this, e); (W.ops = W.ops || []).push([e[0] - H.T0, e[1], id, curDev && curDev.name, curDev && curDev.net, curDev && curDev.lieFi]); }; } return O[k][id]; };
  let nid = 1;
  const trueNow = () => W.t;
  const pending = [];                  // promises of saves we do not wait for
  const SAVE = d => { try { const p = d.app.saveState(); pending.push(p); p.catch(() => {}); return p; } catch (e) { W.log.push('save threw ' + e.message); } };
  const steps = cfg.steps;
  for (let i = 0; i < steps; i++) {
    await W.runUntil(W.t + 200 + W.int(90000));
    const d = W.pick(all), app = d.app, s = app.state; curDev = d;
    if (d.alive === false && d.role !== 'owner') { if (W.rnd() < 0.5) await W.go(H.boot(d).then(() => { d.alive = true; })); continue; }
    const r = W.rnd();
    if (r < 0.07) { // network flip
      if (d.net) H.goOffline(d, cfg.lieFi && W.rnd() < 0.5); else await H.goOnline(d);
      continue;
    }
    if (r < 0.10) { // close + reopen
      H.closeApp(d); d.pendingWrites = []; d.alive = false;
      app.state._dirty = false;
      await W.runUntil(W.t + 1000 + W.int(30000));
      await W.go(H.boot(d)); d.alive = true; continue;
    }
    if (!d.net && !d.lieFi && W.rnd() < 0.0) continue;
    if (E.FAIL && W.rnd() < 0.15) d.failNext = 1;
    const isY = d.role === 'owner';
    const rows = s.tx.filter(x => x.type === 'income'), tasks = s.tasks;
    const op = W.rnd();
    const t0 = trueNow();
    const dead = id => { const o = O.tx[id] || O.task[id]; return !!(o && o.events.some(e => e[1] === 'del')); };
    if (!isY && (op < 0.18 || (!rows.length && !tasks.length))) {
      const id = 'x' + (nid++);
      const t = { id, type: 'income', customer: 'c' + id, total: 100 + W.int(900), date: '2026-10-01', work: 'w', notes: '', whoseCustomer: 'mine' };
      app.applyTxStage(t, 'unpaid'); s.tx.push(t); SAVE(d);
      const o = rec('tx', id); o.events.push([t0, 'put']); o.pay = [t0, groupSig(t)]; o.total = [t0, t.total]; o.note = [t0, ''];
    } else if (isY && op < 0.15) {
      const id = 'y' + (nid++);
      const t = { id, type: 'income', customer: 'c' + id, total: 100 + W.int(900), date: '2026-10-01', work: 'w', notes: '', whoseCustomer: 'mine' };
      app.applyTxStage(t, 'unpaid'); s.tx.push(t); SAVE(d);
      const o = rec('tx', id); o.events.push([t0, 'put']); o.pay = [t0, groupSig(t)]; o.total = [t0, t.total]; o.note = [t0, ''];
    } else if (op < 0.24 && !isY) {
      const id = 'k' + (nid++); s.tasks.push({ id, task: 't' + id, status: 'open', kind: 'work' }); SAVE(d);
      const o = rec('task', id); o.events.push([t0, 'put']); o.task = [t0, 'open'];
    } else if (op < 0.50 && rows.length) {            // payment ops
      const t = W.pick(rows); const prev = app.collectedAmount(t); const k = W.rnd(); const before = rowSig(t); if (isY && dead(t.id)) continue;
      if (k < 0.4) { app.setTxStage(t, 'paid'); app.recordReceipt(t, prev); }
      else if (k < 0.6 || !cfg.partial) { app.setTxStage(t, 'unpaid'); app.recordReceipt(t, prev); }
      else { app.setTxStage(t, 'partial'); t.paidAmount = Math.max(1, Math.floor((Number(t.total) || 100) * (0.1 + 0.6 * W.rnd()))); t.paidDate = '2026-10-02'; app.recordReceipt(t, prev); }
      SAVE(d);
      if (rowSig(t) !== before) { const o = rec('tx', t.id); o.events.push([t0, 'put']); o.pay = [t0, groupSig(t)]; }
    } else if (op < 0.62 && rows.length && !isY) {    // note / total edit
      const t = W.pick(rows); const o = rec('tx', t.id); const before = rowSig(t);
      let nn = null, nt = null;
      if (W.rnd() < 0.6) { t.notes = 'n' + i; nn = t.notes; } else { t.total = 100 + W.int(900); nt = t.total; }
      SAVE(d); if (rowSig(t) !== before) { if (nn != null) o.note = [t0, nn]; if (nt != null) o.total = [t0, nt]; o.events.push([t0, 'put']); }
      if (cfg.double && W.rnd() < 0.5) {              // second save within 200 ms
        await W.runUntil(W.t + 5 + W.int(150));
        const t1 = trueNow(); t.notes = 'n' + i + 'b'; SAVE(d); o.note = [t1, t.notes]; o.events.push([t1, 'put']);
      }
    } else if (op < 0.72 && rows.length && !isY) {    // delete (+ optional immediate undo)
      const t = W.pick(rows); const o = rec('tx', t.id);
      app.snapshotState('מחיקה'); app.markDeleted(t.id); s.tx = s.tx.filter(x => x.id !== t.id); SAVE(d); o.events.push([t0, 'del']); o.deleted = true;
      if (cfg.undo && W.rnd() < 0.4) { await W.runUntil(W.t + 200 + W.int(4000)); const t1 = trueNow(); app.globalUndo(); SAVE(d); o.events.push([t1, 'put']); }
    } else if (op < 0.84 && tasks.length) {           // task toggle
      if (isY && tasks.every(x => dead(x.id))) continue; const t = W.pick(tasks.filter(x => !(isY && dead(x.id)))); const done = t.status !== 'done'; t.status = done ? 'done' : 'open'; if (done) t.completedAt = trueNow(); else delete t.completedAt; SAVE(d);
      const o = rec('task', t.id); o.task = [t0, t.status]; o.events.push([t0, 'put']);
    } else if (op < 0.88 && tasks.length && !isY) {   // task delete
      const t = W.pick(tasks); const o = rec('task', t.id); app.markDeleted(t.id); s.tasks = s.tasks.filter(x => x.id !== t.id); SAVE(d); o.events.push([t0, 'del']); o.deleted = true;
    }
  }
  // settle
  for (const d of all) { if (!d.net) await H.goOnline(d); d.lieFi = false; if (d.alive === false) { await W.go(H.boot(d)); d.alive = true; } }
  let quiet = 0, last = W.writes;
  for (let rr = 0; rr < 60 && quiet < 4; rr++) {
    await W.runUntil(W.t + 90000);
    for (const d of all) { if (d.app.state._dirty && !d.app._ownerPushInFlight) { try { await W.go(d.app.saveState()); } catch (_) {} } }
    if (W.writes === last) quiet++; else { quiet = 0; last = W.writes; }
  }
  await W.runUntil(W.t + 300000);
  return { W, all, O, devs };
}

function check(res, seed) {
  const { W, all, O } = res; const bad = [];
  const cd = H.cloudDoc(W);
  const views = all.map(d => ({ name: d.name, tx: Object.fromEntries(d.app.state.tx.map(t => [t.id, t])), tasks: Object.fromEntries(d.app.state.tasks.map(t => [t.id, t])) }));
  views.push({ name: 'cloud', tx: Object.fromEntries((cd.tx || []).map(t => [t.id, t])), tasks: Object.fromEntries((cd.tasks || []).map(t => [t.id, t])) });
  for (const [kind, key] of [['tx', 'tx'], ['task', 'tasks']]) {
    for (const [id, o] of Object.entries(O[kind])) {
      const ev = o.events.slice().sort((a, b) => a[0] - b[0]); const last = ev[ev.length - 1];
      const should = last[1] === 'put';
      for (const v of views) {
        const row = v[key][id];
        if (!should && row) bad.push(`RESURRECT ${kind} ${id} on ${v.name} (last event del@${last[0] - H.T0})`);
        if (should && !row) bad.push(`LOSS ${kind} ${id} missing on ${v.name} (last put@${last[0] - H.T0}, ev=${ev.map(e => e[1][0] + (e[0] - H.T0)).join(',')})`);
        if (should && row && !o.deleted) {
          if (kind === 'tx') {
            if (o.note && row.notes !== o.note[1]) bad.push(`NOTE ${id} on ${v.name}: ${JSON.stringify(row.notes)} want ${JSON.stringify(o.note[1])}`);
            if (o.total && row.total !== o.total[1]) bad.push(`TOTAL ${id} on ${v.name}: ${row.total} want ${o.total[1]}`);
            if (o.pay && groupSig(row) !== o.pay[1]) bad.push(`PAY ${id} on ${v.name}: ${groupSig(row)} want ${o.pay[1]} (op@${o.pay[0] - H.T0})`);
          } else if (o.task && row.status !== o.task[1]) bad.push(`TASK ${id} on ${v.name}: ${row.status} want ${o.task[1]}`);
        }
      }
    }
  }
  const sig = v => JSON.stringify([Object.keys(v.tx).sort().map(i => [i, v.tx[i].total, v.tx[i].notes || '', groupSig(v.tx[i])]), Object.keys(v.tasks).sort().map(i => [i, v.tasks[i].status])]);
  const ref = sig(views[views.length - 1]);
  views.slice(0, -1).forEach(v => { if (sig(v) !== ref) bad.push(`DIVERGE ${v.name} != cloud`); });
  return bad;
}

(async () => {
  let failed = 0, byKind = {}; const shown = [];
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    let res;
    try { res = await scenario(seed); } catch (e) { console.log('seed', seed, 'EXC', e.stack.split('\n').slice(0, 3).join(' | ')); failed++; continue; }
    const bad = check(res, seed);
    if (bad.length) { failed++; bad.forEach(b => { const k = b.split(' ')[0]; byKind[k] = (byKind[k] || 0) + 1; }); if (shown.length < 6) { shown.push(seed); console.log(`seed ${seed}: ${bad.length} violations`); bad.slice(0, 4).forEach(b => console.log('   ' + b)); } }
  }
  console.log(`cfg=${JSON.stringify(cfg)} seeds=${SEEDS} failing=${failed}`, JSON.stringify(byKind));
})();
