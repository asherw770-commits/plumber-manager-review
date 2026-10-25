#!/usr/bin/env node
/* "Maybe the partner's customer" reminder (Asher 14.10) + the partner-name display rule: a partner, no customer name, no phone, still marked mine → reminder only;
 * dismissed / already partner / has a name or phone / not a work task / task with an existing transaction → no reminder. Nothing is ever changed by the detector.
 *   node tests/partner-guess-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const tx = o => Object.assign({ id: 't' + Math.random(), type: 'income', partnerName: 'אהרן', customer: '', phone: '', whoseCustomer: 'mine', total: 100 }, o);
const task = o => Object.assign({ id: 'k' + Math.random(), kind: 'work', task: 'עבודה', partnerName: 'אהרן', customer: '', phone: '', whoseCustomer: 'mine', cost: 100 }, o);
const g = (r, k) => app.isPartnerCustomerGuess(r, k);
app.state.tx = []; app.state.tasks = [];
expect(g(tx(), 'tx') && g(task(), 'task'), 'partner + no name (+ no phone or no address) + mine → reminder');
expect(g(tx({ whoseCustomer: undefined }), 'tx'), 'unmarked whoseCustomer counts as mine');
expect(!g(tx({ whoseCustomer: 'partner' }), 'tx'), 'already the partner\'s → no reminder');
expect(!g(tx({ customer: 'דוד' }), 'tx'), 'a name → no reminder');
expect(!g(tx({ phone: '0501234567', address: 'הרצל 1' }), 'tx'), 'phone and address both present → no reminder');
expect(g(tx({ phone: '0501234567', address: '' }), 'tx') && g(tx({ phone: '', address: 'הרצל 1' }), 'tx'), 'no name and no address OR no phone → reminder');
expect(!g(tx({ partnerName: '' }), 'tx') && !g(tx({ partnerName: '  ' }), 'tx'), 'no partner → no reminder');
expect(!g(tx({ partnerGuessOk: true }), 'tx') && !g(tx({ reviewedOk: true }), 'tx'), 'dismissed → no reminder');
expect(!g(tx({ type: 'expense' }), 'tx'), 'expenses never');
expect(!g(task({ kind: 'invoice' }), 'task') && !g(task({ kind: 'reminder' }), 'task'), 'only work tasks');
const linked = tx({ id: 'L1' }); app.state.tx = [linked];
expect(!g(task({ linkedTxId: 'L1' }), 'task'), 'a task whose transaction exists is judged by the transaction');
expect(g(task({ linkedTxId: 'gone' }), 'task'), 'a dangling link does not hide it');
const before = JSON.stringify(app.state.tx);
app.partnerGuessItems();
expect(JSON.stringify(app.state.tx) === before, 'detector must not change data');
// display rule
expect(app.isNamelessPartnerTx(tx({ whoseCustomer: 'partner' })) && !app.isNamelessPartnerTx(tx()) && !app.isNamelessPartnerTx(tx({ whoseCustomer: 'partner', customer: 'x' })), 'nameless partner customer display rule');
if (fails) { console.error('partner-guess-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ partner-guess-check: תזכורת "אולי הלקוח של השותף" רק במקרים הנכונים, בלי לשנות נתונים; כלל התצוגה של לקוח שותף בלי שם');
