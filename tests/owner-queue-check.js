#!/usr/bin/env node
/* Yehuda's queue compaction: only the newest version of each row and the latest deletion per id survive — never fewer rows, never an older version. 
 *   node tests/owner-queue-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const q = { tasks: [], tx: [], deleted: [] };
for (let v = 0; v < 40; v++) for (let r = 0; r < 20; r++) { q.tasks.push({ id: 'k' + r, status: v === 39 ? 'done' : 'open', v, _updatedAt: 1000 + v }); q.tx.push({ id: 't' + r, total: 100 + v, v, _updatedAt: 1000 + v }); }
q.deleted.push({ id: 'k1', at: 5 }, { id: 'k1', at: 9 }, { id: 'k2', at: 7 });
const c = app.compactOwnerQueue(q);
expect(q.tasks.length === 800 && c.tasks.length === 20 && c.tx.length === 20, 'one entry per row: ' + c.tasks.length + '/' + c.tx.length);
expect(c.tasks.every(r => r.v === 39 && r.status === 'done') && c.tx.every(r => r.v === 39), 'the newest version of every row is kept');
expect(c.deleted.length === 2 && c.deleted.find(x => x.id === 'k1').at === 9, 'latest deletion per id');
// out-of-order arrival: the greatest _updatedAt wins, not the last position
const o = app.compactOwnerQueue({ tasks: [{ id: 'a', _updatedAt: 9, n: 'new' }, { id: 'a', _updatedAt: 3, n: 'old' }], tx: [], deleted: [] });
expect(o.tasks.length === 1 && o.tasks[0].n === 'new', 'newest by _updatedAt, whatever the order');
// junk is dropped, nothing else is touched
const j = app.compactOwnerQueue({ tasks: [null, { x: 1 }, { id: 'ok', _updatedAt: 1 }], tx: 'nope', deleted: [{ at: 1 }] });
expect(j.tasks.length === 1 && j.tx.length === 0 && j.deleted.length === 0, 'junk entries dropped');
expect(app.compactOwnerQueue(null).tasks.length === 0, 'null queue');
if (fails) { console.error('owner-queue-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ owner-queue-check: ניקוי תור יהודה משאיר רק את הגרסה העדכנית של כל שורה ואת המחיקה האחרונה');
