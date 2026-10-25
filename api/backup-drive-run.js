// POST /api/backup-drive-run — the SAME Drive backup as the nightly cron
// (api/backup-drive.js / api/_backup.js), but triggered on demand from the
// app's own "🧪 בדוק גיבוי לדרייב עכשיו" button in Settings. Authorized by
// the caller's OWN Firebase login (an id token, verified here, whose uid
// must be an admin in users/{uid}) — NOT by CRON_SECRET, which protects the
// scheduled job and never needs to leave Vercel's environment variables or
// be typed into a browser (Asher 2.10: "לא רוצה דרך הטרמינל... שתעשה
// בעצמך").
const admin = require('firebase-admin');
const { getDb } = require('./_lib');
const { runDriveBackup, backupConfig, mailAlert } = require('./_backup');
const { runIntegrityCheck } = require('./_integrity');

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
  if (!userSnap.exists || userSnap.data().disabled === true || userSnap.data().role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'רק אשר (admin) יכול להפעיל את זה' });

  // { pushTest: true } → a test notification to the admin's own devices (checks that push reaches them), no backup.
  if (req.body && req.body.pushTest) {
    try {
      const { pushToRoles } = require('./_lib');
      const sent = await pushToRoles(db, ['admin'], { title: '🔔 התראת בדיקה', body: 'אם אתה רואה את זה — ההתראות מהאפליקציה מגיעות למכשיר הזה', tag: 'push-test', url: '/#/settings' }, { ttl: 3600 });
      return res.status(200).json({ ok: true, sent });
    } catch (e) { return res.status(500).json({ error: 'push', message: String(e && e.message || e) }); }
  }
  const cfg = backupConfig();
  if (!cfg) return res.status(503).json({ error: 'not-configured', message: 'כתובת הסקריפט של הגיבוי עוד לא הוגדרה — ראה קבצי הוראות/הפעלת-גיבוי-לדרייב.md' });

  // { mailTest: true } → only sends a short test e-mail through the Apps Script (checks the alert channel), no backup.
  if (req.body && req.body.mailTest) {
    try { await mailAlert(cfg, '✅ בדיקת מייל התראות — אפליקציית יהודה', 'אם קיבלת את זה, התראות הבדיקה הלילית יגיעו גם למייל.'); return res.status(200).json({ ok: true, mailed: true }); }
    catch (e) { return res.status(500).json({ error: 'mail', message: String(e && e.message || e) }); }
  }
  try {
    const result = await runDriveBackup(db, cfg);
    // Dry run of the nightly integrity watchdog (the real one only runs from the cron); it can never fail the backup.
    let integrity; try { integrity = await runIntegrityCheck(db, { write: false }); } catch (e) { console.error('integrity check failed', e && e.message); integrity = { ok: null, error: String(e && e.message || e).slice(0, 120) }; }
    return res.status(200).json({ ok: true, ...result, integrity, at: Date.now() });
  } catch (e) {
    console.error('backup-drive-run failed', e && e.message);
    return res.status(500).json({ error: 'server', message: String(e && e.message || e) });
  }
};
