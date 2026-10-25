#!/usr/bin/env node
/* Push goes only to devices whose user is still active AND still has the role the subscription was made with
 * (a suspended / removed / re-roled user used to keep getting orders). Uses stubbed firebase-admin / web-push.
 *   node tests/push-access-check.js
 */
const Module = require('module');
const sent = [];
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'firebase-admin') return { apps: [], initializeApp() {}, credential: { cert() {} }, firestore() { return {}; } };
  if (r === 'web-push') return { setVapidDetails() {}, sendNotification: async sub => { sent.push(sub.endpoint); } };
  return orig.call(this, r, ...a);
};
const lib = require('../api/_lib');
const del = [];
const mk = (id, uid, role) => ({ id, data: () => ({ uid, role, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + id } }), ref: { delete: async () => del.push(id) } });
const users = { a: { role: 'owner' }, b: { role: 'owner', disabled: true }, c: { role: 'manager' } };
const db = {
  doc: p => ({ get: async () => { const m = /users\/(.+)/.exec(p); if (m) return { exists: !!users[m[1]], data: () => users[m[1]] }; return { exists: true, data: () => ({ publicKey: 'p', privateKey: 'k' }) }; }, create: async () => {} }),
  collection: () => ({ where: () => ({ get: async () => ({ docs: [mk('s1', 'a', 'owner'), mk('s2', 'b', 'owner'), mk('s3', 'c', 'owner'), mk('s4', 'gone', 'owner')] }) }) })
};
lib.pushToRoles(db, ['owner'], { title: 'x' }).then(n => {
  const ok = n === 1 && sent.join() === 'https://fcm.googleapis.com/fcm/send/s1' && del.join() === 's2,s3,s4';
  if (!ok) { console.error('❌ push-access-check: sent', n, sent, 'deleted', del); process.exit(1); }
  console.log('✅ push-access-check: התראות רק למשתמש פעיל עם אותו תפקיד; מושהה / הוסר / שינה תפקיד — המנוי נמחק');
}).catch(e => { console.error('❌', e); process.exit(1); });
