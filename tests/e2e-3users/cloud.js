// Shared fake Firestore + the real api/order.js, over HTTP, for a 3-browser end-to-end test.
const http = require('http'), fs = require('fs'), path = require('path');
const APP = path.join(__dirname, '..', '..');
const store = new Map();            // path -> {data, rev}
let REV = 1;
const log = [];
const clone = o => JSON.parse(JSON.stringify(o));
const isSent = v => v && typeof v === 'object' && v.__op;
function applyWrite(cur, data, merge) {
  const out = merge && cur ? clone(cur) : {};
  for (const [k, v] of Object.entries(data)) {
    if (isSent(v) && v.__op === 'arrayUnion') {
      const arr = Array.isArray(out[k]) ? out[k] : [];
      for (const x of v.values) if (!arr.some(y => JSON.stringify(y) === JSON.stringify(x))) arr.push(x);
      out[k] = arr;
    } else if (isSent(v) && v.__op === 'arrayRemove') {
      const arr = Array.isArray(out[k]) ? out[k] : [];
      out[k] = arr.filter(y => !v.values.some(x => JSON.stringify(x) === JSON.stringify(y)));
    } else if (isSent(v) && v.__op === 'increment') out[k] = (Number(out[k]) || 0) + v.n;
    else if (merge && v && typeof v === 'object' && !Array.isArray(v) && !isSent(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = applyWrite(out[k], v, true);   // real Firestore merges nested maps
    else out[k] = v;
  }
  return out;
}
function put(p, data, merge) { const cur = store.get(p); const nd = applyWrite(cur && cur.data, data, merge); store.set(p, { data: nd, rev: ++REV }); return nd; }
const colDocs = (name, where) => [...store.entries()].filter(([p]) => p.startsWith(name + '/') && !p.slice(name.length + 1).includes('/'))
  .filter(([, v]) => (where || []).every(w => { const x = v.data[w[0]]; return w[1] === '==' ? x === w[2] : true; }))
  .map(([p, v]) => ({ id: p.slice(name.length + 1), data: v.data, rev: v.rev }));
// ── Admin-SDK-like db for api/order.js ──
function adminDb() {
  const mkDoc = p => ({ id: p.split('/').pop(), path: p,
    get: async () => { const v = store.get(p); return { exists: !!v, data: () => v && clone(v.data), id: p.split('/').pop() }; },
    set: async (d, o) => { put(p, clone(d), o && o.merge); } });
  const q = (name, wh) => ({ where: (f, op, v) => q(name, wh.concat([[f, op, v]])), get: async () => { const ds = colDocs(name, wh); return { size: ds.length, docs: ds.map(d => ({ id: d.id, data: () => d.data })), forEach: f => ds.forEach(d => f({ id: d.id, data: () => d.data })) }; } });
  return {
    collection: name => ({ ...q(name, []), doc: id => mkDoc(name + '/' + (id || ('auto' + Math.random().toString(36).slice(2, 10)))) }),
    doc: p => mkDoc(p),
    runTransaction: async fn => fn({ get: async ref => ref.get(), set: (ref, d, o) => { put(ref.path, clone(d), o && o.merge); } }),
  };
}
const Module = require('module');
const _load = Module._load;
Module._load = function (r, ...a) {   // api/classify.js uses these Admin SDK helpers
  if (r === 'firebase-admin') return { apps: [1], firestore: Object.assign(() => ({}), { FieldValue: { increment: n => ({ __op: 'increment', n }), arrayUnion: (...values) => ({ __op: 'arrayUnion', values }) } }), auth: () => ({ verifyIdToken: async () => ({ uid: 'u-admin' }) }) };
  return _load.call(this, r, ...a);
};
const libPath = require.resolve(APP + '/api/_lib.js');
function dayIL(ts = Date.now()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); }
const _libSrc = fs.readFileSync(APP + '/api/_lib.js', 'utf8'); const normPhone = new Function(_libSrc.slice(_libSrc.indexOf('function normPhone'), _libSrc.indexOf('function clean')) + '; return normPhone;')();
function clean(s, max) { return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max); }
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { getDb: () => adminDb(), pushToRoles: async (db, roles, payload) => { log.push(['push', roles, payload.title]); }, dayIL, normPhone, clean, workKey: s => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 80) } };
const orderHandler = require(APP + '/api/order.js');
const classifyHandler = require(APP + '/api/classify.js');
// ── seed ──
const seed = process.env.SEED ? JSON.parse(fs.readFileSync(process.env.SEED, 'utf8')) : require('../sample-data').sampleBackup(240, 7);   // fictional books unless SEED=<backup.json> is given
function reset(direct) {
  store.clear(); REV = 1; log.length = 0;
  const cur = { ...seed, inboxSplit: true, whatsappInbox: [], updated: Date.now() };
  delete cur.exportedAt; delete cur.exportedBy; delete cur.version;
  put('state/current', cur); put('state/inbox', { items: seed.whatsappInbox || [] });
  put('state/config', { yehudaDirect: !!direct, minClientVersion: 0 });
  put('users/u-admin', { name: 'מנהל מערכת', role: 'admin', email: 'a@x' }); put('users/u-owner', { name: 'יהודה', role: 'owner', email: 'y@x' }); put('users/u-manager', { name: 'יחיאל', role: 'manager', email: 'm@x' });
}
reset(false);
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); });
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = req.url.split('?')[0]; const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u === '/api/order') {
      const b = await body(req); let code = 0, out;
      await orderHandler({ method: 'POST', body: b, headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} }, { status: c => ({ json: o => { code = c; out = o; } }) });
      return send(code || 200, out || {});
    }
    if (u === '/api/classify') {   // the real api/classify.js on the fake cloud; the admin "Bearer" call is accepted for u-admin
      const b = await body(req); let code = 0, out;
      await classifyHandler({ method: 'POST', body: b, headers: req.headers.authorization ? { authorization: req.headers.authorization } : {}, socket: {} }, { setHeader() {}, status: c => ({ json: o => { code = c; out = o; } }) });
      return send(code || 200, out || {});
    }
    if (u === '/reset') { const b = await body(req); reset(b.direct); return send(200, { ok: 1 }); }
    if (u === '/log') return send(200, log);
    if (u === '/dump') { const o = {}; store.forEach((v, k) => { if (!k.startsWith('orderPhotos/')) o[k] = v.data; }); return send(200, o); }
    const b = await body(req);
    if (u === '/get') { const v = store.get(b.path); return send(200, { exists: !!v, data: v && v.data, rev: v ? v.rev : 0 }); }
    if (u === '/set') { put(b.path, b.data, b.merge); return send(200, { ok: 1 }); }
    if (u === '/update') { if (!store.has(b.path)) return send(404, { error: 'not-found' }); put(b.path, b.data, true); return send(200, { ok: 1 }); }
    if (u === '/delete') { store.delete(b.path); REV++; return send(200, { ok: 1 }); }
    if (u === '/docs') { const ds = colDocs(b.coll, b.where); return send(200, { docs: ds.map(d => ({ id: d.id, data: d.data })), rev: Math.max(0, ...ds.map(d => d.rev)), n: ds.length, REV }); }
    send(404, { error: 'unknown' });
  } catch (e) { console.error(e); send(500, { error: String(e) }); }
}).listen(8766, '127.0.0.1', () => console.log('cloud on 8766'));
