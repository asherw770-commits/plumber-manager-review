#!/usr/bin/env node
/* Fresh data before a message leaves the app (Asher 16.10): freshenState waits for a save in progress, pulls the cloud copy, merges it, and reports whether it
 * could reach the cloud; the message is built only afterwards. Offline / timeout → ok:false (the message then says it is not fully current).
 *   node tests/fresh-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
app.setTimeout = setTimeout; app.clearTimeout = clearTimeout;
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const setup = ({ remote, online = true, hang = false }) => {
  app.state.currentUser = { uid: 'u1', role: 'manager' };   // manager: no save, no owner queue — only the pull is under test
  app.state._freshening = null; app.state._dirty = false;
  app.state.tx = [{ id: 'a', type: 'income', total: 500, _updatedAt: 1000 }];
  let calls = 0;
  app.window.fb = { doc: () => ({}), db: {}, getDoc: () => { calls++; return hang ? new Promise(() => {}) : Promise.resolve({ exists: () => !!remote, data: () => remote }); } };
  app.state._applySnapshot = d => vm.runInContext('mergeCloudDoc', app)(d, null);
  app.navigator = { onLine: online };
  return () => calls;
};
(async () => {
  // 1. the newer cloud row is merged BEFORE the text is built
  let calls = setup({ remote: { tx: [{ id: 'a', type: 'income', total: 800, _updatedAt: 5000 }, { id: 'b', type: 'income', total: 300, _updatedAt: 5000 }], tasks: [] } });
  const before = app.state.tx.map(t => t.total).join();
  const r = await app.freshenState();
  const after = app.state.tx.map(t => t.total).sort().join();
  expect(r.ok === true && calls() === 1, 'pull succeeded: ' + JSON.stringify(r));
  expect(before === '500' && after === '300,800', 'cloud rows must be merged before the message is built: ' + before + ' → ' + after);
  // 2. concurrent callers share one pull
  calls = setup({ remote: { tx: [], tasks: [] } });
  await Promise.all([app.freshenState(), app.freshenState(), app.freshenState()]);
  expect(calls() === 1, 'three simultaneous copies share one pull: ' + calls());
  // 3. offline: honest answer, no pull
  calls = setup({ remote: { tx: [], tasks: [] }, online: false });
  const off = await app.freshenState();
  expect(off.ok === false && off.why === 'offline' && calls() === 0, 'offline → ok:false without trying: ' + JSON.stringify(off));
  // 4. the cloud does not answer: gives up after the timeout, never hangs the copy button
  calls = setup({ remote: null, hang: true });
  const t0 = Date.now(); const to = await app.freshenState({ timeoutMs: 300 });
  expect(to.ok === false && Date.now() - t0 < 1500, 'a silent cloud must time out quickly: ' + JSON.stringify(to));
  expect(app.hhmm(new Date(2026, 9, 16, 9, 5).getTime()) === '09:05', 'hhmm');
  // 5. the wiring: every outgoing text is built after a fresh pull and from the current data
  expect(/copyFresh\(buildCurrentMessage/.test(html) && /openWaFresh\(phone, buildCurrentMessage\)/.test(html), 'messages screen copy / send use the fresh path');
  expect(/copyFresh\(buildText/.test(html) && /copyFresh\(\(\) => tmpl\.template\(mkVars\(\)\)/.test(html), 'partner statement and reminder copy use the fresh path');
  expect(/stillOwed\(\)/.test(html), 'a reminder for a debt that was paid meanwhile is stopped');
  expect(/state\._applySnapshot = applySnapshot/.test(html), 'freshenState needs the snapshot merge exposed');
  if (fails) { console.error('fresh-check: ' + fails + ' failures'); process.exit(1); }
  console.log('✅ fresh-check: לפני העתקה/שליחה נמשכים נתונים עדכניים מהענן, ההודעה נבנית אחרי זה, ואין תלייה כשאין חיבור');
})();
