// Shared by the two ways to trigger a Drive backup: the nightly cron
// (api/backup-drive.js, CRON_SECRET) and the admin "🧪 בדוק גיבוי לדרייב
// עכשיו" button in the app (api/backup-drive-run.js, the admin's own
// Firebase login) — one copy of the payload shape, two ways to authorize it.
//
// The file is NOT written with the Drive API: a Google service account has no
// storage quota, so Drive refuses ("Service Accounts do not have storage
// quota") to let it create files even in a folder shared with it — and a
// personal Gmail has no Shared Drives (found live 2.10). Instead the JSON is
// POSTed to a tiny Google Apps Script web app that Asher deploys in HIS OWN
// account (קבצי הוראות/הפעלת-גיבוי-לדרייב.md): it creates the file in the
// folder as him — his ownership, his quota — and prunes backups older than 60
// days. No shared secret to copy around: every request carries a Google-signed
// ID token minted from the service account's own key (target_audience below);
// the script asks Google's tokeninfo endpoint who signed it and accepts only
// that one service-account e-mail (a public value, visible in any share list).
const crypto = require('crypto');

const BACKUP_AUDIENCE = 'plumber-manager-backup';
// Where the Apps Script web app lives (set once it is deployed; the
// BACKUP_WEBAPP_URL env var overrides it).
const DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycby5xZ1k7mD-FO2WJX3QUUngGUzenjRQjpvMFS8K0h1O7YKwxmKrBuSLVU3VNZbuFzac/exec';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// A Google-signed OpenID token for the service account (documented flow: a
// self-signed JWT carrying target_audience, exchanged at the token endpoint).
async function mintIdToken(cred, tokenUrl) {
  tokenUrl = tokenUrl || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: cred.client_email, sub: cred.client_email, aud: 'https://oauth2.googleapis.com/token', target_audience: BACKUP_AUDIENCE, iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claims}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned); sign.end();
  const jwt = `${unsigned}.${b64url(sign.sign(cred.private_key))}`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Google ID-token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const j = await res.json();
  if (!j.id_token) throw new Error('Google did not return an id_token');
  return j.id_token;
}

async function postToWebApp(url, idToken, name, content) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ idToken, name, content }),
    redirect: 'follow', // Apps Script answers a POST with a 302 to the result
    signal: AbortSignal.timeout(25000)
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  if (!j) throw new Error(`הסקריפט בדרייב לא החזיר תשובה תקינה (${res.status}) — כנראה כתובת ה-Web app שגויה או שלא פורסם ל"Anyone": ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  if (!j.ok) throw new Error(`הסקריפט בדרייב סירב: ${j.error || 'שגיאה לא ידועה'}`);
  return j;
}

async function runDriveBackup(db, { url, cred, tokenUrl }) {
  const snap = await db.doc('state/current').get();
  if (!snap.exists) return { skipped: 'אין עדיין נתונים לגבות (state/current לא קיים)' };
  const d = snap.data() || {};

  // Same fields as the client's buildBackupPayload() (index.html) — a
  // restore from this file must be exactly as complete as a manually-
  // downloaded one.
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'cron (backup-drive)',
    version: 1,
    tx: Array.isArray(d.tx) ? d.tx : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    customerMeta: d.customerMeta || {},
    whatsappInbox: Array.isArray(d.whatsappInbox) ? d.whatsappInbox : [],
    dailyNotes: d.dailyNotes || {},
    products: Array.isArray(d.products) ? d.products : [],
    priceList: Array.isArray(d.priceList) ? d.priceList : [],
    priceListSeeded: !!d.priceListSeeded,
    settlements: Array.isArray(d.settlements) ? d.settlements : [],
    googleSheetId: d.googleSheetId || null,
    _deletedIds: Array.isArray(d._deletedIds) ? d._deletedIds : [],
    _deletedAt: d._deletedAt || {}
  };
  // The WhatsApp inbox lives in its own document since the 1.10 split.
  try {
    const inbox = await db.doc('state/inbox').get();
    if (inbox.exists && Array.isArray(inbox.data().items)) payload.whatsappInbox = inbox.data().items;
  } catch (_) {}

  // Israel-local timestamp in the filename, same convention as the manual
  // download ("יהודה-גיבוי-YYYYMMDD-HHMM.json") — the cron itself runs on a
  // fixed UTC clock, so this keeps the name meaningful across DST.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => (parts.find(p => p.type === t) || {}).value || '00';
  const name = `יהודה-גיבוי-${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}.json`;

  const r = await postToWebApp(url, await mintIdToken(cred, tokenUrl), name, JSON.stringify(payload, null, 2));
  return { file: { id: r.id, name: r.name || name }, tx: payload.tx.length, deletedOld: r.deleted || [] };
}

// An alert e-mail from Asher's own Gmail to himself, through the same Apps Script web app
// (action 'mail'). Needs the one-time re-authorization of the script for sending mail; until
// then the call fails (the push + sheet channels still work) and the failure is only logged.
async function mailAlert({ url, cred, tokenUrl }, subject, text) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ idToken: await mintIdToken(cred, tokenUrl), action: 'mail', subject, text }) });
  const out = await res.text();
  let j = null; try { j = JSON.parse(out); } catch (_) {}
  if (!j || !j.ok) throw new Error('mail not sent: ' + (j && j.error || out.slice(0, 120)));
  return j;
}

// Both endpoints need the same two things: the web-app URL and the service-
// account key (FIREBASE_SERVICE_ACCOUNT, already set for Firestore/Sheets).
function backupConfig() {
  const url = process.env.BACKUP_WEBAPP_URL || DEFAULT_WEBAPP_URL;
  let cred = null;
  try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (_) {}
  return url && cred ? { url, cred } : null;
}

module.exports = { runDriveBackup, backupConfig, postToWebApp, mintIdToken, mailAlert };
