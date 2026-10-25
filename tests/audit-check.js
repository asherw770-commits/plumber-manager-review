#!/usr/bin/env node
/* The change log (auditDiff in index.html): every money change becomes one entry; notes-only edits and no-ops make none;
 * a delete and an add are recorded; the stage is read through txStage (legacy status mirror), not the raw field.
 *   node tests/audit-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const clone = o => JSON.parse(JSON.stringify(o));

const base = [
  { id: 'a', type: 'income', customer: 'דוד', total: 500, status: 'unpaid', stage: 'unpaid', date: '2026-09-01', notes: 'x' },
  { id: 'b', type: 'income', customer: 'משה', total: 900, status: 'paid', stage: 'paid', paidDate: '2026-09-05', date: '2026-09-01' },
  { id: 'c', type: 'expense', customer: '', work: 'דלק', total: 100, date: '2026-09-02' }
];
// nothing changed
expect(app.auditDiff(base, clone(base), 'tx').length === 0, 'identical rows must log nothing');
// notes / address only → nothing
let cur = clone(base); cur[0].notes = 'שונה'; cur[0].address = 'רחוב';
expect(app.auditDiff(base, cur, 'tx').length === 0, 'a notes/address-only edit must not be logged');
// payment: unpaid → paid with date
cur = clone(base); cur[0].stage = 'paid'; cur[0].status = 'paid'; cur[0].paidDate = '2026-10-05';
let d = app.auditDiff(base, cur, 'tx');
expect(d.length === 1 && d[0].op === 'edit' && d[0].id === 'a', 'one edit entry expected: ' + JSON.stringify(d));
expect(d[0].changes.some(c => c.f === 'stage' && c.from === 'unpaid' && c.to === 'paid'), 'stage change must be recorded as unpaid → paid');
expect(d[0].changes.some(c => c.f === 'paidDate' && c.to === '2026-10-05'), 'paidDate must be recorded');
// regression paid → unpaid is the incident class: must show up
cur = clone(base); cur[1].stage = 'unpaid'; cur[1].status = 'unpaid';
d = app.auditDiff(base, cur, 'tx');
expect(d.length === 1 && d[0].changes.some(c => c.f === 'stage' && c.from === 'paid' && c.to === 'unpaid'), 'paid → unpaid must be logged');
// legacy-only status mirror (no stage field) is read through txStage
const legacyBase = [{ id: 'l', type: 'income', total: 300, status: 'paid', date: '2026-09-01' }];
const legacyCur = [{ id: 'l', type: 'income', total: 300, status: 'unpaid', date: '2026-09-01' }];
d = app.auditDiff(legacyBase, legacyCur, 'tx');
expect(d.length === 1 && d[0].changes.some(c => c.f === 'stage'), 'a legacy status change must still be seen as a stage change: ' + JSON.stringify(d));
// amount edit
cur = clone(base); cur[0].total = 550;
d = app.auditDiff(base, cur, 'tx');
expect(d.length === 1 && d[0].changes.length === 1 && d[0].changes[0].f === 'total' && d[0].changes[0].from === 500 && d[0].changes[0].to === 550, 'amount edit must log exactly the total: ' + JSON.stringify(d));
// add + delete
cur = clone(base).slice(0, 2); cur.push({ id: 'n', type: 'income', customer: 'חדש', total: 200, stage: 'unpaid', status: 'unpaid', date: '2026-10-05' });
d = app.auditDiff(base, cur, 'tx');
expect(d.some(e => e.op === 'add' && e.id === 'n'), 'a new row must be logged as add');
expect(d.some(e => e.op === 'delete' && e.id === 'c'), 'a removed row must be logged as delete');
// firestore never accepts undefined / NaN / objects
cur = clone(base); cur[0].total = NaN; cur[0].partnerName = { x: 1 };
const raw = JSON.stringify(app.auditDiff(base, cur, 'tx'));
expect(!/undefined/.test(raw) && !/NaN/.test(raw), 'no NaN/undefined may reach Firestore');
// tasks
const tb = [{ id: 't', status: 'open', customer: 'א', cost: 100 }], tc = [{ id: 't', status: 'done', customer: 'א', cost: 100, completedAt: 1788000000000 }];
d = app.auditDiff(tb, tc, 'task');
expect(d.length === 1 && d[0].changes.some(c => c.f === 'status' && c.to === 'done'), 'task done must be logged');
// new users (needsApproval) never write directly, even when Yehuda's global switch is on
app.state.config = { yehudaDirect: true };
app.state.currentUser = { uid: 'u1', role: 'owner' };
expect(app.ownerDirect() === true, 'an ordinary owner writes directly when the switch is on');
app.state.currentUser = { uid: 'u2', role: 'owner', needsApproval: true };
expect(app.ownerDirect() === false, 'a needsApproval user must go through the queue even with the switch on');
if (fails) process.exit(1);
console.log('✅ audit-check: יומן השינויים רושם כל שינוי כספי (תשלום, סכום, הוספה, מחיקה, חזרה לא שולם) ומתעלם מהערות');
