// POST /api/sync-sheet-run — refreshes the Google Sheet right after a change
// in the app (Asher 2.10: payments marked paid in the app kept showing as
// open debts in the sheet until the next day's cron). Called by the app a
// minute after a save reached the cloud. Authorized by the caller's OWN
// Firebase login (an id token whose uid is an admin — or Yehuda in
// direct-write mode — in users/{uid}), never by CRON_SECRET, which stays in
// Vercel's environment variables. The guard in api/_syncCore.js keeps runs
// serialized and at least a minute apart (Sheets write quota), and tells
// the app when to ask again if one is refused.
const admin = require('firebase-admin');
const { getDb } = require('./_lib');
const { runSheetSyncGuarded } = require('./_syncCore');

const MIN_GAP_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured', message: 'FIREBASE_SERVICE_ACCOUNT not set' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) return res.status(401).json({ error: 'unauthorized' });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch (_) { return res.status(401).json({ error: 'unauthorized' }); }
  const userSnap = await db.doc(`users/${uid}`).get();
  const role = userSnap.exists && userSnap.data().disabled !== true ? userSnap.data().role : null;   // a suspended account is nobody
  if (role !== 'admin' && role !== 'owner') return res.status(403).json({ error: 'forbidden' });

  try {
    const result = await runSheetSyncGuarded(db, { minGapMs: MIN_GAP_MS });
    return res.status(200).json({ ok: true, ...result, at: Date.now() });
  } catch (e) {
    console.error('sync-sheet-run failed', e && e.message);
    return res.status(500).json({ error: 'server', message: String(e && e.message || e) });
  }
};
