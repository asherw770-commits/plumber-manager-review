#!/usr/bin/env node
/* Copy-to-WhatsApp messages keep their usual shape; within the partners' collection, Aharon's jobs come LAST (he has many) —
 * after every other partner, in the same section, same header.
 *   node tests/messages-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const mk = (o) => { const t = { type: 'income', date: '2026-09-10', total: 1000, work: 'עבודה', ...o }; app.applyTxStage(t, 'unpaid'); return t; };
app.state.tx = [
  mk({ id: 'a1', customer: 'לקוח של אהרן 1', partnerName: 'אהרן', partnerAmount: 500, whoseCustomer: 'partner' }),
  mk({ id: 'a2', customer: 'לקוח של אהרון 2', partnerName: 'אהרון', partnerAmount: 400, whoseCustomer: 'partner' }),
  mk({ id: 's1', customer: 'לקוח של שלומי', partnerName: 'שלומי', partnerAmount: 300, whoseCustomer: 'partner' }),
  mk({ id: 'y1', customer: 'לקוח של יואלי', partnerName: 'יואלי', partnerAmount: 300, whoseCustomer: 'partner' }),
  mk({ id: 'm1', customer: 'לקוח שלי', whoseCustomer: 'mine' })
];
app.state.tasks = []; app.state.settlements = []; app.state.customerMeta = {};
vm.runInContext('_reconCache = null; _reconSig = ""; _aliasCache = null;', app);
for (const [name, fn] of [['morning', app.buildMorning], ['weekly', app.buildMotzash]]) {
  const msg = fn();
  const pos = n => msg.indexOf(n);
  expect(pos('לקוח של שלומי') > 0 && pos('לקוח של יואלי') > 0 && pos('לקוח של אהרן 1') > 0 && pos('לקוח של אהרון 2') > 0, name + ': all partner jobs appear');
  expect(pos('לקוח של שלומי') < pos('לקוח של אהרן 1') && pos('לקוח של יואלי') < pos('לקוח של אהרן 1'), name + ': other partners come before Aharon');
  expect(pos('לקוח של שלומי') < pos('לקוח של אהרון 2') && pos('לקוח של יואלי') < pos('לקוח של אהרון 2'), name + ': the spelling "אהרון" also goes last');
  expect(pos('לקוח שלי') < pos('לקוח של שלומי'), name + ': my own customers stay first, as before');
  expect(!/גבייה מאהרן/.test(msg), name + ': no separate Aharon block — the message keeps its usual shape');
}
if (fails) process.exit(1);
console.log('✅ messages-check: בהודעות להעתקה אהרן מופיע אחרון בין השותפים, באותו מבנה כמו קודם');
