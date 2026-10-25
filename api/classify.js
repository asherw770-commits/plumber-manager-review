// /api/classify — lets Yehuda tell the app which category each kind of job belongs to (Asher 19.10).
//   POST {t}                    → the distinct work names (with counts), the category list and what is already marked
//   POST {t, items:[{key,cat}], newCat?}  → saves his marks (cat '' = unmark) into state/config.workTypeMap
// The secret travels in the request body and in the page's URL fragment (#t=…), never in a query string, so it stays out of server and proxy logs.
//   POST (Authorization: Bearer <id token of an admin>) {action:'status'|'create'|'rotate'|'revoke'} → Asher manages the link
// The link carries a random secret (serverSecrets/classifyLink, which no app user can read). It exposes only the work texts
// and the category names — never amounts, customers or phones — and can be revoked or replaced at any time. The marks are
// written with the Admin SDK into the config doc the app already reads, so rules do not change. Every job with the same
// text (workKey) gets the category: the app looks the category up by that key.
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getDb, dayIL, clean, workKey } = require('./_lib');

const MAX_ITEMS = 200, MAX_CATS = 40, CAT_LEN = 30, DAILY_WRITES = 3000, DAILY_BAD = 300;
const BAD_KEY = k => !k || /^__.*__$/.test(k);

const catOf = v => clean(v, CAT_LEN);
// Everything the page may offer: the price list's groups, categories added so far, and the ones already used in the map.
function allCats(state, cfg) {
  const set = new Set();
  (Array.isArray(state.priceList) ? state.priceList : []).forEach(p => { const c = p && catOf(p.category); if (c) set.add(c); });
  (Array.isArray(cfg.workCats) ? cfg.workCats : []).forEach(c => { c = catOf(c); if (c) set.add(c); });
  Object.values(cfg.workTypeMap && typeof cfg.workTypeMap === 'object' ? cfg.workTypeMap : {}).forEach(c => { c = typeof c === 'string' ? catOf(c) : ''; if (c) set.add(c); });
  return [...set];
}
function namesOf(state) {
  const m = new Map();
  (Array.isArray(state.tx) ? state.tx : []).forEach(t => {
    if (!t || t.type !== 'income') return;
    const k = workKey(t.work);
    if (BAD_KEY(k)) return;
    m.set(k, (m.get(k) || 0) + 1);
  });
  return m;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function loadAll(db) {
  const [st, cf] = await Promise.all([db.doc('state/current').get(), db.doc('state/config').get()]);
  return { state: st.exists ? (st.data() || {}) : {}, cfg: cf.exists ? (cf.data() || {}) : {} };
}
function view(state, cfg) {
  const map = cfg.workTypeMap && typeof cfg.workTypeMap === 'object' ? cfg.workTypeMap : {};
  const names = [...namesOf(state)].map(([key, count]) => ({ key, count, cat: typeof map[key] === 'string' ? map[key] : '' }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'he'));
  return { names, cats: allCats(state, cfg) };
}

async function bump(db, field) {
  const ref = db.doc('orderQuota/classify-' + dayIL());
  const snap = await ref.get();
  const n = snap.exists ? (Number(snap.data()[field]) || 0) : 0;
  return { ref, n };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured' });
  try {
    if (/^Bearer /.test(req.headers.authorization || '')) return await adminCall(req, res, db);
    return await publicCall(req, res, db);
  } catch (e) { console.error('classify failed', e && e.message); return res.status(500).json({ error: 'server' }); }
};

async function checkToken(db, t, res) {
  const snap = await db.doc('serverSecrets/classifyLink').get();
  const tok = snap.exists ? snap.data().token : '';
  if (typeof t === 'string' && tok && safeEq(t, tok)) return true;   // a right link always works — strangers' bad guesses can never lock Yehuda out
  const { ref, n } = await bump(db, 'bad');
  if (n >= DAILY_BAD) { res.status(429).json({ error: 'limit' }); return null; }   // only bounds the write cost of the counter; a 192-bit secret can not be guessed anyway
  await ref.set({ bad: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
  res.status(403).json({ error: 'forbidden' });
  return null;
}

async function publicCall(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!(await checkToken(db, String(b.t || ''), res))) return;
  if (!Array.isArray(b.items) && b.newCat == null) {
    const { state, cfg } = await loadAll(db);
    return res.status(200).json({ ok: true, ...view(state, cfg) });
  }
  const { ref: qref, n } = await bump(db, 'writes');
  if (n >= DAILY_WRITES) return res.status(429).json({ error: 'limit' });
  const { state, cfg } = await loadAll(db);
  const names = namesOf(state);
  let cats = allCats(state, cfg);
  const patch = {};
  const upd = { updated: Date.now(), updatedBy: 'classify-link' };
  const nc = b.newCat != null ? catOf(b.newCat) : '';
  if (nc && !cats.includes(nc)) {
    if (cats.length >= MAX_CATS) return res.status(400).json({ error: 'too-many-cats' });
    upd.workCats = admin.firestore.FieldValue.arrayUnion(nc);
    cats = [...cats, nc];
  }
  let saved = 0;
  (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS).forEach(it => {
    const k = workKey(it && it.key), c = it && typeof it.cat === 'string' ? catOf(it.cat) : null;
    if (c === null || BAD_KEY(k) || !names.has(k)) return;
    if (c !== '' && !cats.includes(c)) return;
    patch[k] = c; saved++;
  });
  if (saved) { upd.workTypeMap = patch; upd.workTypeMapAt = Date.now(); }
  if (saved || upd.workCats) {
    await db.doc('state/config').set(upd, { merge: true });
    await qref.set({ writes: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
  }
  const fresh = saved || upd.workCats ? await loadAll(db) : { state, cfg };
  return res.status(200).json({ ok: true, saved, ...view(fresh.state, fresh.cfg) });
}

async function adminCall(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(req.headers.authorization.slice(7))).uid; }
  catch (_) { return res.status(401).json({ error: 'unauthorized' }); }
  const u = await db.doc('users/' + uid).get();
  if (!u.exists || u.data().disabled === true || u.data().role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const action = String((req.body && req.body.action) || 'status');
  const lref = db.doc('serverSecrets/classifyLink');
  let snap = await lref.get();
  if (action === 'revoke') { if (snap.exists) await lref.delete(); return res.status(200).json({ ok: true, token: '' }); }
  if (action === 'create' || action === 'rotate') {
    if (!snap.exists || action === 'rotate') {
      await lref.set({ token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now(), createdBy: uid });
      snap = await lref.get();
    }
  }
  const { state, cfg } = await loadAll(db);
  const v = view(state, cfg);
  return res.status(200).json({ ok: true, token: snap.exists ? snap.data().token : '', names: v.names.length, marked: v.names.filter(n => n.cat).length, cats: v.cats });
}
