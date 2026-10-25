// POST /api/order — a customer's job request from /order (30.9).
// Saved to Firestore `orders` (+ photos in `orderPhotos`, one doc each), then a
// push notification goes to Yehuda's phone. Basic spam protection: valid
// Israeli phone, max 3 orders per phone per day, hidden honeypot field.
const { getDb, pushToRoles, dayIL, normPhone, clean } = require('./_lib');

const MAX_PHOTOS = 4;
const MAX_VIDEOS = 1;
const MAX_VIDEO_CHARS = 1300000;   // ≈ 15 s re-encoded on the phone (350 kbit/s, no audio) as a data URL
const VIDEO_CHUNK = 600000;        // Firestore documents are capped at 1 MB — a clip is stored in several
const MAX_PHOTO_CHARS = 420000; // ≈ 300KB JPEG as a data URL

const DAILY_CAP = 300;     // orders per day, all customers together (100 could be used up by a handful of addresses — audit 15.10)
const IP_DAILY_CAP = 15;   // per source address per day (mobile carriers put many people behind one address)
const WA_LINK = 'https://wa.me/972534440194';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured' });
  try { return await handle(req, res, db); }
  catch (e) { console.error('order failed', e && e.message); return res.status(500).json({ error: 'server', message: 'משהו השתבש — נסו שוב' }); }
};

// 2001:db8::1 → 8 full groups, so every address of one /64 gets the same key (the compressed form split the same /64 into many keys).
function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map(g => g.replace(/^0+(?=.)/, '').toLowerCase().padStart(4, '0'));
}

async function handle(req, res, db) {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots get a fake "ok"
  const name = clean(b.name, 60), address = clean(b.address, 140), desc = clean(b.desc, 1500);
  // Structured address (1.10): floor / apartment / entrance / access notes and
  // the preferred time, next to the one-line address the app already shows.
  const addressDetails = clean(b.addressDetails, 200), when = clean(b.when, 40);
  const a = (b.addr && typeof b.addr === 'object') ? b.addr : {};
  const addr = { city: clean(a.city, 60), street: clean(a.street, 80), num: clean(a.num, 12), entrance: clean(a.entrance, 8), floor: clean(a.floor, 8), apt: clean(a.apt, 8), notes: clean(a.notes, 160), verified: a.verified === true };
  const phone = normPhone(b.phone);
  if (!name || !address || !desc) return res.status(400).json({ error: 'missing', message: 'נא למלא שם, כתובת ותיאור' });
  if (!phone) return res.status(400).json({ error: 'phone', message: 'מספר הטלפון לא תקין' });
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, MAX_PHOTOS)
    .filter(p => typeof p === 'string' && p.length <= MAX_PHOTO_CHARS && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p));
  const videos = (Array.isArray(b.videos) ? b.videos : []).slice(0, MAX_VIDEOS)
    .filter(p => typeof p === 'string' && p.length <= MAX_VIDEO_CHARS && /^data:video\/(mp4|webm);base64,[A-Za-z0-9+/=]+$/.test(p));
  const day = dayIL();
  const ip = String(req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '').split(',')[0].trim();
  // IPv6: one household / phone owns a whole /64, so count that prefix, not the single address.
  let ipKey = ip.replace(/[^0-9a-f.:]/gi, '').slice(0, 45) || 'unknown';
  if (ipKey.includes(':')) ipKey = expandV6(ipKey).slice(0, 4).join(':');
  // A client-made request id makes a retry after a lost answer overwrite instead of duplicating (and never burns the quota twice).
  const rid = String(b.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (rid) {
    const dup = await db.doc(`orders/r_${rid}`).get();
    if (dup.exists) return res.status(200).json({ ok: true, duplicate: true });
  }
  // Quotas: per phone, per source address, and for the whole day — a counter
  // document per day, incremented in a transaction so parallel requests count.
  const same = await db.collection('orders').where('phone', '==', phone).where('day', '==', day).get();
  if (same.size >= 3) return res.status(429).json({ error: 'limit', message: 'כבר התקבלו ממך כמה פניות היום — נחזור אליך בהקדם', wa: WA_LINK });
  const quotaRef = db.doc(`orderQuota/${day}`);
  // Inside the transaction: the same request id twice at once counts once, and the per-phone limit holds under parallel requests too.
  const verdict = await db.runTransaction(async (tx) => {
    // The same request id arriving twice at once: the first one leaves a claim; a claim older than a minute is a leftover (a crash) and is ignored.
    if (rid) {
      const dupDoc = await tx.get(db.doc(`orders/r_${rid}`)); if (dupDoc.exists) return 'dup';
      const claim = await tx.get(db.doc(`orderClaims/${rid}`)); if (claim.exists && Date.now() - Number((claim.data() || {}).at || 0) < 60000) return 'dup';
    }
    const q = await tx.get(quotaRef);
    const d = q.exists ? q.data() : { total: 0, ips: {}, phones: {} };
    const ipCount = (d.ips && d.ips[ipKey]) || 0, phoneCount = (d.phones && d.phones[phone]) || 0;
    if (phoneCount >= 3) return 'phone';
    if (d.total >= DAILY_CAP || ipCount >= IP_DAILY_CAP) return 'cap';
    tx.set(quotaRef, { total: (d.total || 0) + 1, ips: { ...(d.ips || {}), [ipKey]: ipCount + 1 }, phones: { ...(d.phones || {}), [phone]: phoneCount + 1 }, day }, { merge: true });
    if (rid) tx.set(db.doc(`orderClaims/${rid}`), { at: Date.now() });
    return 'ok';
  });
  if (verdict === 'dup') return res.status(200).json({ ok: true, duplicate: true });
  if (verdict === 'phone') return res.status(429).json({ error: 'limit', message: 'כבר התקבלו ממך כמה פניות היום — נחזור אליך בהקדם', wa: WA_LINK });
  if (verdict !== 'ok') return res.status(429).json({ error: 'limit', message: 'הטופס עמוס כרגע — אפשר לכתוב לנו בוואטסאפ', wa: WA_LINK });
  const ref = rid ? db.doc(`orders/r_${rid}`) : db.collection('orders').doc();
  const now = Date.now();
  const written = [];          // photo / video documents, removed again if the order itself cannot be saved
  try {
    // Photos and the clip FIRST, the order last: an order never points at media that failed to save.
    await Promise.all(photos.map((p, i) => { const path = `orderPhotos/${ref.id}_${i}`; written.push(path); return db.doc(path).set({ orderId: ref.id, i, data: p, createdAt: now }); }));
    for (const v of videos) {
      const mime = v.slice(5, v.indexOf(';')), payload = v.slice(v.indexOf(',') + 1);   // only the base64 part is stored; the viewer adds the prefix back
      const parts = Math.ceil(payload.length / VIDEO_CHUNK);
      await Promise.all(Array.from({ length: parts }, (_, k) => { const path = `orderPhotos/${ref.id}_v0_${k}`; written.push(path); return db.doc(path).set({ orderId: ref.id, kind: 'video', mime, part: k, parts, data: payload.slice(k * VIDEO_CHUNK, (k + 1) * VIDEO_CHUNK), createdAt: now }); }));
    }
    await ref.set({ name, phone, address, addressDetails, addr, when, desc, photoCount: photos.length, videoCount: videos.length, videoParts: videos.length ? Math.ceil((videos[0].length - videos[0].indexOf(',') - 1) / VIDEO_CHUNK) : 0, createdAt: now, day, status: 'new' });
  } catch (e) {
    // The write can fail on the way back (a timeout AFTER the commit): look before throwing anything away — an order that exists keeps its media and its quota.
    let saved = false;
    try { saved = (await ref.get()).exists; } catch (_) {}
    if (!saved) {
      if (rid) await db.doc(`orderClaims/${rid}`).delete().catch(() => {});
      // Nothing was saved: give the quota back, drop the media, let the customer retry.
      await Promise.all(written.map(p => db.doc(p).delete().catch(() => {})));
      try { await db.runTransaction(async (tx) => { const q = await tx.get(quotaRef); if (!q.exists) return; const d = q.data(); tx.set(quotaRef, { total: Math.max(0, (d.total || 0) - 1), ips: { ...(d.ips || {}), [ipKey]: Math.max(0, ((d.ips || {})[ipKey] || 0) - 1) }, phones: { ...(d.phones || {}), [phone]: Math.max(0, ((d.phones || {})[phone] || 0) - 1) }, day }, { merge: true }); }); } catch (_) {}
      throw e;
    }
  }
  if (rid) db.doc(`orderClaims/${rid}`).delete().catch(() => {});   // saved: the order itself is now the marker
  // The push must never hold the customer's answer: staff are told in the background (3 s at most).
  try {
    await Promise.race([
      pushToRoles(db, ['owner', 'admin'], { title: '📥 הזמנה חדשה', body: `${name} · ${address}${addressDetails ? ' · ' + addressDetails : ''}${when ? ' · ' + when : ''}\n${desc.slice(0, 90)}`, tag: 'order-' + ref.id, url: '/#/dashboard' }),
      new Promise(r => setTimeout(r, 3000))
    ]);
  } catch (e) { console.error('push failed', e && e.message); } // the order is saved either way
  return res.status(200).json({ ok: true });
}
