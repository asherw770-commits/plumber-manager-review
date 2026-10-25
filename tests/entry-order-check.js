#!/usr/bin/env node
/* Entry order ("סדר הזנה"): ids are random and carry no time, so the order comes from createdAt, and older rows (no createdAt) from their place in the book.
 * Also every place that adds a transaction/task must stamp createdAt.
 *   node tests/entry-order-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };

// 1. old rows: entry order = array order, whatever their random ids look like
const ids = ['xzzzzzzz1111', 'x00000000aaaa', 'xmmmmmmmbbbb', 'xaaaaaaacccc'];
const old = ids.map(id => ({ id }));
const stamp = app.entryStampOf(old);
const order = [...old].sort((a, b) => stamp(b) - stamp(a)).map(r => r.id);
expect(JSON.stringify(order) === JSON.stringify([...ids].reverse()), 'old rows must sort newest-entered first by place in the book: ' + order);

// 2. a row with createdAt is always newer than any old row, and rows with createdAt order by it
const rows = [...old, { id: 'xb', createdAt: 2000 }, { id: 'xa', createdAt: 1000 }];
const st = app.entryStampOf(rows);
const o2 = [...rows].sort((a, b) => st(b) - st(a)).map(r => r.id);
expect(o2[0] === 'xb' && o2[1] === 'xa' && o2.slice(2).join() === [...ids].reverse().join(), 'createdAt rows first (newest first), then old rows: ' + o2);

// 3. every push of a tx/task stamps createdAt right before
const pushes = [...html.matchAll(/state\.(tx|tasks)\.push\((\w+)\)/g)];
expect(pushes.length >= 9, 'expected the known push sites, found ' + pushes.length);
for (const m of pushes) {
  const before = html.slice(Math.max(0, m.index - 80), m.index);
  expect(before.includes(m[2] + '.createdAt = Date.now()'), 'state.' + m[1] + '.push(' + m[2] + ') without createdAt stamp');
}
// 4. nobody parses the id as a timestamp any more
expect(!/parseInt\(m\[1\], 36\)/.test(html), 'id-as-timestamp parsing is back');

if (fails) { console.error('entry-order-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ entry-order-check: סדר הזנה לפי createdAt / מקום בספר, וכל יצירה מוחתמת');
