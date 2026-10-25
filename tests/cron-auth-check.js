#!/usr/bin/env node
/* The two cron endpoints (daily sheet sync, nightly Drive backup) must refuse anything but the exact cron secret, and refuse everything when no secret is set.
 *   node tests/cron-auth-check.js
 */
const Module = require('module');
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'firebase-admin') return { apps: [1], initializeApp() {}, credential: { cert() {} }, firestore() { return {}; }, auth: () => ({}) };
  if (r === 'web-push') return { setVapidDetails() {}, sendNotification: async () => {} };
  return orig.call(this, r, ...a);
};
const lib = require('../api/_lib');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
expect(lib.bearerOk('Bearer s3cret', 's3cret') === true, 'the right secret passes');
for (const bad of ['Bearer s3cret ', 'bearer s3cret', 'Bearer s3cre', 'Bearer s3cret!', 's3cret', '', undefined, null, 42, 'Bearer ']) expect(lib.bearerOk(bad, 's3cret') === false, 'refused: ' + JSON.stringify(bad));
expect(lib.bearerOk('Bearer ', '') === false && lib.bearerOk('Bearer undefined', undefined) === false && lib.bearerOk('Bearer ', undefined) === false, 'no secret configured → nothing passes');
const call = async (file, secret, header) => {
  if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  delete require.cache[require.resolve(file)];
  let code = 0;
  await require(file)({ method: 'GET', headers: header === undefined ? {} : { authorization: header } }, { status: c => ({ json: () => { code = c; } }) });
  return code;
};
(async () => {
  for (const f of ['../api/sync-sheet.js', '../api/backup-drive.js']) {
    expect(await call(f, 'abc', undefined) === 401, f + ': no header → 401');
    expect(await call(f, 'abc', 'Bearer abd') === 401, f + ': wrong secret → 401');
    expect(await call(f, undefined, 'Bearer abc') === 503, f + ': no secret configured → 503 (fails closed)');
  }
  if (fails) process.exit(1);
  console.log('✅ cron-auth-check: נקודות הקצה של ה-cron דורשות בדיוק את הסוד (השוואה בזמן קבוע) ונסגרות כשאין סוד מוגדר');
})();
