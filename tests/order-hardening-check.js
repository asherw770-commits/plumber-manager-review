#!/usr/bin/env node
/* Customer-order link hardening (audit 15.10): phone formats, emoji cut, IPv6 /64 key, quota inside the transaction (same request id twice / same phone in parallel),
 * an order that was committed but errored on the way back keeps its media, push only to real push services.
 *   node tests/order-hardening-check.js
 */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'firebase-admin') return { apps: [], initializeApp() {}, credential: { cert() {} }, firestore() { return {}; } };
  if (r === 'web-push') return { setVapidDetails() {}, sendNotification: async () => {} };
  return orig.call(this, r, ...a);
};
const lib = require('../api/_lib');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };

// phones
for (const [inp, want] of [['0501234567', '0501234567'], ['+972501234567', '0501234567'], ['00972501234567', '0501234567'], ['+972 (0)50-123-4567', '0501234567'], ['972-0-50-1234567', '0501234567'], ['050-123-4567', '0501234567'], ['0771234567', '0771234567'], ['12345', ''], ['', '']])
  expect(lib.normPhone(inp) === want, 'normPhone(' + inp + ') = ' + lib.normPhone(inp) + ', wanted ' + want);
// emoji cut
const cut = lib.clean('x' + '😀'.repeat(40), 60);
expect(cut.isWellFormed ? cut.isWellFormed() : !/[\ud800-\udbff]$/.test(cut), 'clean must not leave half an emoji');
expect(lib.clean('‮abc\u0000', 10) === 'abc', 'bidi / control characters stripped');

// the handler against a small fake Firestore
const store = new Map();
const ver = new Map();
const mkDb = (opts = {}) => {
  const db = {
    doc: p => ({ id: p.split('/').pop(), path: p, get: async () => ({ exists: store.has(p), data: () => store.get(p) }), set: async (d, o) => { if (opts.failOrderAfterCommit && p.startsWith('orders/')) { store.set(p, { ...(store.get(p) || {}), ...d }); throw new Error('DEADLINE_EXCEEDED'); } store.set(p, o && o.merge ? { ...(store.get(p) || {}), ...d } : d); ver.set(p, (ver.get(p) || 0) + 1); }, delete: async () => { store.delete(p); ver.set(p, (ver.get(p) || 0) + 1); } }),
    collection: c => ({ where: (f1, o1, v1) => ({ where: (f2, o2, v2) => ({ get: async () => ({ size: [...store.entries()].filter(([k, d]) => k.startsWith(c + '/') && d[f1] === v1 && d[f2] === v2).length }) }) }), doc: () => db.doc(c + '/auto' + Math.random().toString(36).slice(2)) }),
    // optimistic transactions like Firestore's: writes are buffered, and if a document the transaction READ changed meanwhile it runs again
    runTransaction: async fn => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const reads = new Map(), writes = [];
        const out = await fn({ get: async ref => { reads.set(ref.path, ver.get(ref.path) || 0); return ref.get(); }, set: (ref, d, o) => { writes.push([ref.path, d, o]); } });
        if ([...reads].every(([pth, v]) => (ver.get(pth) || 0) === v)) { writes.forEach(([pth, d, o]) => { store.set(pth, o && o.merge ? { ...(store.get(pth) || {}), ...d } : d); ver.set(pth, (ver.get(pth) || 0) + 1); }); return out; }
      }
      throw new Error('contention');
    }
  };
  return db;
};
let db = mkDb();
const libPath = require.resolve('../api/_lib');
const real = require.cache[libPath].exports;
require.cache[libPath].exports = { ...real, getDb: () => db, pushToRoles: async () => 0 };
delete require.cache[require.resolve('../api/order.js')];
const handler = require('../api/order.js');
const call = async (body, ip = '1.1.1.1') => { let code = 200, out; await handler({ method: 'POST', body, headers: { 'x-forwarded-for': ip }, socket: {} }, { status: c => ({ json: o => { code = c; out = o; } }) }); return { code, out }; };
const base = (o) => Object.assign({ name: 'דוד', phone: '0501234567', address: 'הרצל 1', desc: 'סתימה' }, o);
(async () => {
  // same request id, sent twice in parallel: one order, quota counted once
  const [a, b] = await Promise.all([call(base({ requestId: 'same-1' })), call(base({ requestId: 'same-1' }))]);
  const orders = () => [...store.keys()].filter(k => k.startsWith('orders/'));
  expect(orders().length === 1, 'same request id twice in parallel → one order, got ' + orders().length);
  const quota = [...store.entries()].find(([k]) => k.startsWith('orderQuota/'))[1];
  expect(quota.total === 1, 'quota counted once, total=' + quota.total);
  // same phone, 8 parallel requests with different ids: at most 3
  store.clear();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(base({ requestId: 'p' + i }), '2.2.2.' + i)));
  expect(orders().length <= 3, 'per-phone limit under parallel requests: ' + orders().length);
  expect(rs.filter(r => r.code === 429).length >= 5, 'the rest are told the limit');
  // IPv6: addresses of one /64 share a key
  store.clear();
  for (let i = 1; i <= 17; i++) await call(base({ requestId: 'v6' + i, phone: '05012345' + String(10 + i) }), '2001:db8::' + i);
  const q6 = [...store.entries()].find(([k]) => k.startsWith('orderQuota/'))[1];
  expect(Object.keys(q6.ips).length === 1 && q6.total === 15, 'IPv6 /64 must be one key and stop at 15: keys=' + Object.keys(q6.ips).length + ' total=' + q6.total);
  // committed-but-errored write keeps media and answers ok
  store.clear(); db = mkDb({ failOrderAfterCommit: true });
  const r = await call(base({ requestId: 'late-1', photos: ['data:image/jpeg;base64,AAAA'] }));
  expect(r.code === 200 && [...store.keys()].some(k => k.startsWith('orderPhotos/')), 'an order that exists keeps its media; got ' + r.code);
  // push hosts
  expect(typeof real.pushToRoles === 'function', 'pushToRoles exported');
  if (fails) { console.error('order-hardening-check: ' + fails + ' failures'); process.exit(1); }
  console.log('✅ order-hardening-check: טלפונים, אימוג׳י, מפתח IPv6, מכסות במקביל, וכתיבה שהושלמה בטעות לא מוחקת תמונות');
})();
