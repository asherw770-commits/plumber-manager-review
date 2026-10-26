// Shared by the server functions (30.9: customer orders → Yehuda's phone).
// Credentials: FIREBASE_SERVICE_ACCOUNT (the JSON of a Firebase service
// account key), set by Asher in Vercel → Settings → Environment Variables.
// The push (VAPID) key pair is created here on first use and kept in
// Firestore serverSecrets/vapid, which no app user can read (rules deny all).
const admin = require('firebase-admin');
const webpush = require('web-push');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    let cred;
    try { cred = JSON.parse(raw); } catch (_) { return null; }
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

async function getVapid(db) {
  const ref = db.doc('serverSecrets/vapid');
  let snap = await ref.get();
  if (!snap.exists) {
    const keys = webpush.generateVAPIDKeys();
    try { await ref.create({ ...keys, createdAt: Date.now() }); } catch (_) { /* created by a parallel call */ }
    snap = await ref.get();
  }
  return snap.data();
}

// Only the real browser push services: a subscription is data a signed-in user wrote, and the server POSTs to its address.
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|[\w-]+\.googleapis\.com\/fcm|updates\.push\.services\.mozilla\.com|[\w.-]*push\.apple\.com|[\w.-]*\.notify\.windows\.com)\//;
// Send to every subscribed device of the given roles; drop dead subscriptions.
async function pushToRoles(db, roles, payload, opts) {
  const v = await getVapid(db);
  webpush.setVapidDetails('https://plumber-manager-blond.vercel.app', v.publicKey, v.privateKey);
  const subs = await db.collection('pushSubs').where('role', 'in', roles).get();
  let sent = 0;
  // A device stays subscribed after its user is suspended, removed or moved to another role (the role is copied into the subscription when it is made) — check the live profile.
  const profiles = new Map();
  const profileOf = async uid => { if (!uid) return null; if (!profiles.has(uid)) profiles.set(uid, db.doc('users/' + uid).get().then(s => (s.exists ? s.data() : null)).catch(() => undefined)); return profiles.get(uid); };
  await Promise.all(subs.docs.map(async d => {
    const sub = d.data().sub;
    const pr = await profileOf(d.data().uid);
    if (pr !== undefined && (!pr || pr.disabled === true || pr.role !== d.data().role)) { await d.ref.delete().catch(() => {}); return; }   // undefined = the lookup failed: send as before
    if (!sub || typeof sub.endpoint !== 'string' || !PUSH_HOSTS.test(sub.endpoint)) { await d.ref.delete().catch(() => {}); return; }
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: (opts && opts.ttl) || 3600, timeout: 8000 }); sent++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await d.ref.delete().catch(() => {}); }
  }));
  return sent;
}

// Israel date (YYYY-MM-DD) — the per-phone daily limit resets at midnight here.
function dayIL(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
// 05X-XXXXXXX mobile or 0X-XXXXXXX landline, +972 accepted → local form, else ''.
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00972')) d = d.slice(2);
  if (d.startsWith('972')) d = '0' + d.slice(3).replace(/^0/, '');   // +972 (0)50… keeps its trunk zero in some writings
  return /^05\d{8}$/.test(d) || /^07\d{8}$/.test(d) || /^0[2-489]\d{7}$/.test(d) ? d : '';
}
function clean(s, max) { return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ''); }   // a cut in the middle of an emoji leaves half of it: drop it

// The key a job's text is filed under in the work-type → category map (state/config.workTypeMap). The app has the same function (workKey in index.html) — a test keeps them equal.
function workKey(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[\ud800-\udbff]$/, '').trim(); }

// `Authorization: Bearer <secret>` against the cron secret, compared in constant time (hashes first, so even the length does not leak).
function bearerOk(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const h = s => require('crypto').createHash('sha256').update(String(s)).digest();
  return require('crypto').timingSafeEqual(h(header), h('Bearer ' + secret));
}

module.exports = { getDb, getVapid, pushToRoles, dayIL, normPhone, clean, workKey, bearerOk };
