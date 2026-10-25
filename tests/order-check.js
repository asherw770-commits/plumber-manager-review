#!/usr/bin/env node
/* /api/order: photos and ONE short video are accepted, wrong types / oversize are dropped, and a clip is stored in
 * <1MB chunks that put back together to exactly what was sent.
 *   node tests/order-check.js
 */
const path = require('path');
const Module = require('module');
const writes = {}; let pushed = 0; const order = []; let failPhotos = false; let quota = { total: 0, ips: {} };
const fakeDb = {
  collection: () => ({ where: () => ({ where: () => ({ get: async () => ({ size: 0 }) }) }), doc: () => ({ id: 'ord1', set: async v => { order.push('orders/ord1'); writes['orders/ord1'] = v; } }) }),
  doc: p => ({
    path: p,
    get: async () => ({ exists: p === 'orderQuota/2026-10-05' ? true : p in writes, data: () => (p === 'orderQuota/2026-10-05' ? quota : writes[p]) }),
    set: async v => { if (failPhotos && p.startsWith('orderPhotos/')) throw new Error('boom'); order.push(p); writes[p] = v; },
    delete: async () => { delete writes[p]; order.push('del ' + p); }
  }),
  runTransaction: async fn => fn({ get: async ref => ref.get(), set: (ref, v) => { quota = { ...quota, ...v }; } })
};
const lib = { getDb: () => fakeDb, pushToRoles: async () => { pushed++; }, dayIL: () => '2026-10-05', normPhone: p => { const d = String(p).replace(/\D/g, ''); return /^05\d{8}$/.test(d) || /^07\d{8}$/.test(d) ? d : ''; }, clean: (v, n) => String(v || '').trim().slice(0, n) };
const libPath = require.resolve(path.join(__dirname, '..', 'api', '_lib.js'));
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: lib };
const handler = require('../api/order.js');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const call = async body => { const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await handler({ method: 'POST', body, headers: {}, socket: {} }, res); return res; };

(async () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const vid = 'data:video/mp4;base64,' + 'B'.repeat(1250000 - 30);   // ~15 s clip
  const base = { name: 'דוד', phone: '0501234567', address: 'הרצל 1', desc: 'נזילה' };
  let r = await call({ ...base, photos: [jpeg, jpeg, jpeg, jpeg, jpeg], videos: [vid, vid] });
  expect(r.code === 200 && r.body.ok, 'order with photos + video must succeed: ' + JSON.stringify(r.body));
  const o = writes['orders/ord1'];
  expect(o.photoCount === 4, 'at most 4 photos kept, got ' + o.photoCount);
  expect(o.videoCount === 1 && o.videoParts === 3, 'one video kept in 3 parts: ' + o.videoCount + '/' + o.videoParts);
  const parts = [0, 1, 2].map(k => writes[`orderPhotos/ord1_v0_${k}`]);
  expect(parts.every(Boolean) && parts.every(p => p.data.length <= 600000 && p.parts === 3 && p.mime === 'video/mp4'), 'chunks stored under 600k chars with mime');
  expect(parts.map(p => p.data).join('') === vid.slice(vid.indexOf(',') - 0 - ('data:video/mp4;base64'.length) + 'data:video/mp4;base64'.length) || parts.map(p => p.data).join('').length > 0, 'chunks exist');
  expect(('data:video/mp4;base64,' + parts.map(p => p.data).join('')) === vid, 'the chunks must reassemble to exactly the clip that was sent');
  expect(pushed === 1, 'Yehuda must be pushed once');
  expect(order[order.length - 1] === 'orders/ord1' && order.slice(0, -1).every(x => x.startsWith('orderPhotos/')), 'the order document is written AFTER its photos and video: ' + order.join(','));
  for (const k in writes) delete writes[k];
  r = await call({ ...base, photos: ['data:text/html;base64,AAAA'], videos: ['data:video/quicktime;base64,AAAA', 'data:video/mp4;base64,' + 'B'.repeat(1400000), 'javascript:alert(1)'] });
  expect(r.code === 200 && writes['orders/ord1'].photoCount === 0 && writes['orders/ord1'].videoCount === 0, 'wrong types and oversize clips must be dropped: ' + JSON.stringify(writes['orders/ord1']));
  r = await call({ ...base, phone: '123' });
  expect(r.code === 400, 'a bad phone is still rejected');
  // a failed photo write: the customer can retry, nothing is left behind, the quota is given back
  for (const k in writes) delete writes[k]; order.length = 0; quota = { total: 5, ips: {} }; failPhotos = true;
  r = await call({ ...base, photos: [jpeg, jpeg] });
  failPhotos = false;
  expect(r.code === 500 && !writes['orders/ord1'], 'a failed media write must not leave an order behind (code ' + r.code + ')');
  expect(Object.keys(writes).filter(k => k.startsWith('orderPhotos/')).length === 0, 'half-written media are removed');
  expect(quota.total === 5, 'the quota is given back after a failed save: ' + quota.total);
  // retry with the same request id: saved once; the second answer is a no-op
  for (const k in writes) delete writes[k]; order.length = 0; quota = { total: 0, ips: {} };
  r = await call({ ...base, requestId: 'abc123' });
  expect(r.code === 200 && writes['orders/r_abc123'] && writes['orders/r_abc123'].status === 'new', 'first send saves under the request id');
  const before = Object.keys(writes).length;
  r = await call({ ...base, requestId: 'abc123' });
  expect(r.code === 200 && r.body.duplicate === true && Object.keys(writes).length === before, 'same request id again is recognised, no second order');
  // landline / 07 numbers are accepted by the real normaliser
  const lib = require('fs').readFileSync(path.join(__dirname, '..', 'api', '_lib.js'), 'utf8');
  expect(/\^07\\d\{8\}\$/.test(lib), 'api/_lib.js accepts 07x numbers');
  if (fails) process.exit(1);
  console.log('✅ order-check: הזמנה עם תמונות וסרטון קצר נשמרת תקין (חלקים, סוגים, גודל), וקבצים לא תקינים נזרקים');
})();
