// GET /api/sync-sheet — the daily safety-net push of the app's data into
// Asher's "קובץ ניהול פיננסי" Google Sheet (דשבורד numbers are LIVE Sheets
// formulas reading ראשי, so the file keeps calculating on its own). Triggered
// by Vercel Cron (vercel.json), "always updating, even with nobody in the
// app". Since 2.10 the sheet ALSO refreshes about a minute after every saved
// change in the app (api/sync-sheet-run.js) — this daily run just guarantees
// nothing stays stale if that ever fails. All the actual work lives in
// api/_syncCore.js, shared by both triggers.
const { getDb, bearerOk } = require('./_lib');
const { runSheetSyncGuarded } = require('./_syncCore');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  // Vercel sets this header automatically for cron-triggered requests when
  // CRON_SECRET is configured. Fail closed: with no secret set yet, this
  // endpoint refuses every call rather than running open to the internet.
  const secret = process.env.CRON_SECRET;
  if (!bearerOk(req.headers.authorization, secret)) return res.status(secret ? 401 : 503).json({ error: secret ? 'unauthorized' : 'not-configured', message: secret ? undefined : 'CRON_SECRET not set' });

  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured', message: 'FIREBASE_SERVICE_ACCOUNT not set' });

  // Dead-man switch: the nightly Drive backup must have succeeded within the last 30h, else tell Asher.
  try {
    const b = await db.doc('serverState/backup').get();
    const okAt = b.exists ? Number(b.data().lastOkAt) || 0 : 0;
    if (okAt && Date.now() - okAt > 30 * 3600 * 1000) {
      const { pushToRoles } = require('./_lib');
      await pushToRoles(db, ['admin'], { title: '⚠️ אין גיבוי לדרייב מעל 30 שעות', body: 'הגיבוי הלילי לא הצליח. בדוק בהגדרות ← "בדוק גיבוי לדרייב עכשיו".', tag: 'backup-stale', url: '/#/settings' }, { ttl: 86400 });
    }
  } catch (e) { console.error('backup dead-man check failed', e && e.message); }
  try {
    const result = await runSheetSyncGuarded(db);
    return res.status(200).json({ ok: true, ...result, at: Date.now() });
  } catch (e) {
    console.error('sync-sheet failed', e && e.message);
    return res.status(500).json({ error: 'server', message: String(e && e.message || e) });
  }
};
