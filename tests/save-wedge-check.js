#!/usr/bin/env node
/* A save made while offline used to leave the cloud saver marked "in flight" for ever (every later save returned at once),
 * and the same happened to Yehuda's queue pusher after a "nothing changed" push. Both must keep working afterwards.
 *   node tests/save-wedge-check.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadApp } = require('../api/_loadApp');
let fails = 0; const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const calls = [];
const mk = role => {
  const app = loadApp(fs.readFileSync(process.env.APP_HTML || path.join(__dirname, '..', 'index.html'), 'utf8'));
  app.navigator = { onLine: true }; app.location = { search: '', pathname: '/' };
  app.setTimeout = (f, ms) => 0; app.clearTimeout = () => {};
  app.window.fb = { doc: (db, ...a) => ({ path: a.join('/') }), setDoc: async (r, d) => { calls.push(role + ' set ' + r.path); }, arrayUnion: (...v) => ({ v }), arrayRemove: (...v) => ({ v }), getDoc: async () => ({ exists: () => false }), db: {} };
  vm.runInContext("var LS_KEY='pm', _saveInFlight=null, _saveQueued=false, _saveGen=0, _managerToastShown=false, _ownerPushInFlight=null, _ownerPushQueued=false, _saveRetryTimer=null, CLIENT_VERSION=3, SUPER_ADMIN_UID='x';", app);
  app.state.currentUser = { uid: 'u-' + role, role, name: role };
  app.state.tx = [{ id: 't1', type: 'income', date: '2026-10-12', customer: 'א', total: 100, stage: 'unpaid' }];
  app.state.tasks = [];
  return app;
};
(async () => {
  // admin: offline save, then online
  const a = mk('admin');
  a.navigator.onLine = false;
  await a.saveState();
  a.state.tx[0].customer = 'ב'; await a.saveState();
  expect(calls.length === 0, 'nothing is written while offline');
  a.navigator.onLine = true;
  a.state.tx[0].customer = 'ג';
  await a.saveState();
  if (a.state._lastSaveError) console.error('save error:', a.state._lastSaveError);
  expect(calls.some(c => c === 'admin set state/current'), 'after reconnecting, the next save reaches the cloud (it used to be blocked until reload): ' + JSON.stringify(calls));
  // owner queue: a push with nothing to send, then a real change
  calls.length = 0;
  const o = mk('owner');
  vm.runInContext('_localEdits.clear()', o);
  await o._saveOwnerActions();                                   // nothing changed → early return
  o.state.tasks.push({ id: 'k1', task: 'x', status: 'done' });
  vm.runInContext("_localEdits.set('k1', _clockNow() + 5)", o);
  await o._saveOwnerActions();
  expect(calls.some(c => c === 'owner set state/owner_actions'), 'a later push after an empty one still reaches the queue: ' + JSON.stringify(calls));
  if (fails) process.exit(1);
  console.log('✅ save-wedge-check: שמירה אחרי חוסר חיבור, ותור העדכונים של יהודה אחרי "אין שינוי", ממשיכים לעבוד');
})();
