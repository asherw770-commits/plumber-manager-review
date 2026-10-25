// GET /api/backup-drive — uploads a full data backup (same shape as the
// in-app "הורד גיבוי עכשיו" file, index.html's buildBackupPayload()) straight
// to a Google Drive folder, once a day, with NO dependency on anyone having
// the app open. Replaces the old client-side auto-download-to-whoever's-
// device behavior (Asher 2.10: "לא ירד לי גיבוי כל יום למחשב אלא יעלה
// לתיקייה ייעודית בדרייב") — the manual "הורד גיבוי עכשיו" button in the app
// is untouched, for an on-demand local copy. The payload/retention logic
// itself lives in api/_backup.js, shared with the admin "בדוק עכשיו" button
// (api/backup-drive-run.js) — this file is just the CRON_SECRET gate.
//
// Triggered by Vercel Cron (vercel.json), same CRON_SECRET/
// FIREBASE_SERVICE_ACCOUNT prerequisites as api/sync-sheet.js. The file is
// written by a small Apps Script web app in Asher's own Google account
// (its URL: DEFAULT_WEBAPP_URL in api/_backup.js) — a service account can't
// create Drive files (no storage quota); see api/_backup.js and
// קבצי הוראות/הפעלת-גיבוי-לדרייב.md.
const { getDb, bearerOk } = require('./_lib');
const { runDriveBackup, backupConfig, mailAlert } = require('./_backup');
const { runIntegrityCheck } = require('./_integrity');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const secret = process.env.CRON_SECRET;
  if (!bearerOk(req.headers.authorization, secret)) return res.status(secret ? 401 : 503).json({ error: secret ? 'unauthorized' : 'not-configured', message: secret ? undefined : 'CRON_SECRET not set' });
  const cfg = backupConfig();
  if (!cfg) return res.status(503).json({ error: 'not-configured', message: 'backup web-app URL not set — see קבצי הוראות/הפעלת-גיבוי-לדרייב.md' });

  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured', message: 'FIREBASE_SERVICE_ACCOUNT not set' });

  // Asher's daily evening reminder ("לשלוח את ההודעה היומית"): a push to his admin devices, on unless switched off in Settings.
  // Rides on this cron (Vercel Hobby allows two crons, each firing at some point inside its hour).
  try {
    const c = await db.doc('state/config').get();
    if (!c.exists || c.data().dailyReminderOn !== false) {
      const { pushToRoles } = require('./_lib');
      await Promise.race([pushToRoles(db, ['admin'], { title: '⏰ לשלוח את ההודעה היומית', body: 'תזכורת יומית', tag: 'daily-message', url: '/#/dashboard' }, { ttl: 43200 }), new Promise(r => setTimeout(r, 12000))]);   // never lets a slow push service eat the backup's time
    }
  } catch (e) { console.error('daily reminder failed', e && e.message); }
  // The integrity watchdog runs FIRST and independently: a failed backup must never also silence it (scan 5.10).
  let integrity; try { integrity = await runIntegrityCheck(db, { mail: (subject, text) => mailAlert(cfg, subject, text) }); } catch (e) { console.error('integrity check failed', e && e.message); integrity = { ok: null, error: String(e && e.message || e).slice(0, 120) }; }
  const status = db.doc('serverState/backup');
  let result, lastErr;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try { result = await runDriveBackup(db, cfg); }
    catch (e) { lastErr = e; console.error('backup-drive attempt ' + (attempt + 1) + ' failed', e && e.message); }
  }
  if (!result) {
    const msg = String(lastErr && lastErr.message || lastErr).slice(0, 300);
    await status.set({ lastError: msg, lastErrorAt: Date.now() }, { merge: true }).catch(() => {});
    try { const { pushToRoles } = require('./_lib'); await pushToRoles(db, ['admin'], { title: '⚠️ הגיבוי הלילי לדרייב נכשל', body: msg.slice(0, 180), tag: 'backup-failed', url: '/#/settings' }, { ttl: 86400 }); } catch (_) {}
    try { await mailAlert(cfg, '⚠️ הגיבוי הלילי לדרייב נכשל', msg); } catch (_) {}
    return res.status(500).json({ error: 'server', message: msg, integrity });
  }
  await status.set({ lastOkAt: Date.now(), lastError: null, name: result.name || null }, { merge: true }).catch(() => {});
  return res.status(200).json({ ok: true, ...result, integrity, at: Date.now() });
};
