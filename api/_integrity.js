// Nightly integrity watchdog — runs inside the backup cron (no extra cron: the
// Hobby plan limits them). It compares tonight's data to last night's snapshot
// (kept in serverState/integrity, admin SDK only) and to the app's own books
// check, and alerts on anything that should never happen silently:
//   • rows disappeared (tx / tasks count dropped)
//   • a payment went BACK (paid → unpaid / partial) with no deliberate-regression
//     entry in the row's statusLog — the 2.10 "paid customers returned" class
//   • a task went done → open
//   • "old" rows appeared: new ids whose update stamp is older than last night's
//     snapshot — the 2.10 "stale device resurrected deleted rows" class
//   • the app's own reconcile() found gaps between screens
// Alerts go to the admin's phone/computer as a push (when push is enabled) and
// are shown in the sheet's מדריך tab, so they can't pass unseen.
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./_loadApp');

const RANK = { u: 0, p: 1, d: 2 };           // unpaid / partial / paid
const SNAP_DOC = 'serverState/integrity';

function summarize(app, d) {
  const stg = t => { if (t.type !== 'income') return 'x'; const st = app.txStage(t); return st === 'paid' ? 'd' : st === 'partial' ? 'p' : st === 'unpaid' ? 'u' : 'x'; };
  const tx = {}, tasks = {};
  (Array.isArray(d.tx) ? d.tx : []).forEach(t => { if (t && t.id) tx[t.id] = [stg(t), Number(t._updatedAt) || 0]; });
  (Array.isArray(d.tasks) ? d.tasks : []).forEach(t => { if (t && t.id) tasks[t.id] = [t.status === 'done' ? 'd' : 'o', Number(t._updatedAt) || 0]; });
  return { tx, tasks };
}

// Pure comparison — exported for the tests.
function compare(prev, now, rows, at, tomb) {
  const alerts = [];
  const prevTx = Object.keys(prev.tx || {}), prevTasks = Object.keys(prev.tasks || {});
  const gone = prevTx.filter(id => !(id in now.tx)).length, goneT = prevTasks.filter(id => !(id in now.tasks)).length;
  // A deliberate delete always leaves a tombstone (_deletedIds). Rows that vanished WITHOUT one are suspicious at any count
  // (scan 5.10: five paid jobs could disappear below the percentage threshold without an alert).
  const tombSet = new Set(tomb || []);
  const goneNoTomb = prevTx.filter(id => !(id in now.tx) && !tombSet.has(id)).length;
  if (goneNoTomb && !(gone > Math.max(3, Math.floor(prevTx.length * 0.05)))) alerts.push(`${goneNoTomb} עסקאות נעלמו מאתמול בלי מחיקה מכוונת (בלי סימון מחיקה)`);
  if (gone > Math.max(3, Math.floor(prevTx.length * 0.05))) alerts.push(`נעלמו ${gone} עסקאות מאז אתמול (היו ${prevTx.length}, יש ${Object.keys(now.tx).length})`);
  if (goneT > Math.max(5, Math.floor(prevTasks.length * 0.1))) alerts.push(`נעלמו ${goneT} משימות מאז אתמול`);
  const rowById = Object.fromEntries((rows.tx || []).map(t => [t.id, t]));
  const unexplained = [];
  Object.entries(now.tx).forEach(([id, [s]]) => {
    const p = (prev.tx || {})[id]; if (!p || p[0] === 'x' || s === 'x') return;
    if (RANK[s] < RANK[p[0]]) {
      const log = ((rowById[id] || {}).statusLog || []).some(e => Number(e.at) >= Number(prev.at || 0));   // a deliberate regression leaves a trail
      if (!log) unexplained.push(id);
    }
  });
  if (unexplained.length) alerts.push(`${unexplained.length} עסקאות חזרו אחורה בתשלום בלי פעולה מכוונת: ` + unexplained.slice(0, 3).map(id => (rowById[id] && (rowById[id].customer || rowById[id].work)) || id).join(' · '));
  const reopened = Object.entries(now.tasks).filter(([id, [s]]) => (prev.tasks || {})[id] && prev.tasks[id][0] === 'd' && s === 'o').length;
  if (reopened > 2) alerts.push(`${reopened} משימות שבוצעו חזרו ל"פתוח" מאז אתמול`);
  const revived = Object.entries(now.tx).filter(([id, [, upd]]) => !(id in (prev.tx || {})) && upd && upd < Number(prev.at || 0) - 300000).length
    + Object.entries(now.tasks).filter(([id, [, upd]]) => !(id in (prev.tasks || {})) && upd && upd < Number(prev.at || 0) - 300000).length;
  if (revived) alerts.push(`${revived} שורות "ישנות" הופיעו בענן מאז אתמול (חותמת עדכון ישנה) — כנראה מכשיר עם גרסה ישנה החזיר אותן`);
  return alerts;
}

// opts.write === false → a dry run (the manual "בדוק עכשיו" button): reports alerts, never moves the snapshot or pushes —
// except the very first time, when there is no snapshot yet: then it records the baseline so tomorrow's comparison has something to compare to.
async function runIntegrityCheck(db, opts) {
  const write = !(opts && opts.write === false);
  const snap = await db.doc('state/current').get();
  if (!snap.exists) return { ok: true, skipped: 'no state' };
  const d = snap.data() || {};
  const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
  app.state.tx = Array.isArray(d.tx) ? d.tx : []; app.state.tasks = Array.isArray(d.tasks) ? d.tasks : [];
  app.state.customerMeta = d.customerMeta || {}; app.state.settlements = Array.isArray(d.settlements) ? d.settlements : [];
  const now = summarize(app, d);
  const ref = db.doc(SNAP_DOC);
  const prevDoc = await ref.get();
  const prevData = prevDoc.exists ? prevDoc.data() : null;
  const at = Date.now();
  const alerts = prevData && prevData.snapshot ? compare({ ...prevData.snapshot, at: prevData.checkedAt }, now, { tx: app.state.tx }, at, d._deletedIds) : [];
  try {
    const rec = app.reconcile();
    if (rec.gaps) alerts.push(`בדיקת ההתאמה הפנימית מצאה ${rec.gaps} פערים בין המסכים` + (rec.checks.filter(c => !c.ok).length ? ': ' + rec.checks.filter(c => !c.ok).map(c => c.name).join(', ') : ''));
  } catch (e) { alerts.push('בדיקת ההתאמה הפנימית נכשלה: ' + String(e && e.message || e).slice(0, 80)); }
  // Hard data errors (api: txInvariantIssues in index.html) — alert on any that are NEW since last night.
  const inv = [];
  app.state.tx.forEach(t => app.txInvariantIssues(t).forEach(i => inv.push(t.id + '|' + i)));
  app.state.tasks.forEach(t => (app.taskMoneyIssues ? app.taskMoneyIssues(t) : []).forEach(i => inv.push('t:' + t.id + '|' + i)));
  const prevInv = new Set((prevData && prevData.inv) || []);
  const newInv = inv.filter(k => !prevInv.has(k));
  if (prevData && newInv.length) {
    const byId = Object.fromEntries(app.state.tx.concat(app.state.tasks).map(t => [t.id, t]));
    alerts.push(`${newInv.length} נתונים שגויים חדשים בעסקאות: ` + newInv.slice(0, 3).map(k => { const [id0, why] = k.split('|'); const id = id0.replace(/^t:/, ''); const t = byId[id] || {}; return (t.customer || t.work || id) + ' — ' + why; }).join(' · '));
  }
  const history = ((prevData && prevData.history) || []).filter(h => at - h.at < 7 * 86400000);
  if (alerts.length) history.push({ at, alerts });
  if (!write && prevData) return { ok: !alerts.length, alerts, dryRun: true, tx: Object.keys(now.tx).length, tasks: Object.keys(now.tasks).length };
  await ref.set({ snapshot: now, inv, checkedAt: at, ok: !alerts.length, alerts, history, tx: Object.keys(now.tx).length, tasks: Object.keys(now.tasks).length });
  if (alerts.length && write) {
    let delivered = { push: 0, mail: false };
    try { const { pushToRoles } = (opts && opts.lib) || require('./_lib'); delivered.push = await pushToRoles(db, ['admin'], { title: '⚠️ בדיקת תקינות לילית', body: alerts.slice(0, 3).join('\n').slice(0, 220), tag: 'integrity', url: '/#/dashboard' }, { ttl: 86400 }) || 0; }
    catch (e) { console.error('integrity push failed', e && e.message); }
    if (opts && opts.mail) { try { await opts.mail('⚠️ בדיקת תקינות לילית — יהודה קליין אינסטלציה', alerts.join('\n')); delivered.mail = true; } catch (e) { console.error('integrity mail failed', e && e.message); } }
    // Recorded so the app can say "the alert reached no one" instead of silence.
    await ref.set({ alertDelivered: { ...delivered, at: Date.now() } }, { merge: true }).catch(() => {});
  }
  return { ok: !alerts.length, alerts, tx: Object.keys(now.tx).length, tasks: Object.keys(now.tasks).length };
}

module.exports = { runIntegrityCheck, compare, summarize };
