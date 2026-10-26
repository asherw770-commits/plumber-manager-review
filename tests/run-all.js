#!/usr/bin/env node
/* Runs every automated check one after the other (never in parallel — keeps memory low), the same list as the push gate.
 *   node tests/run-all.js            all checks
 *   node tests/run-all.js money      only checks whose file name contains "money"
 * Exit code 1 when any check fails. Checks that need Asher's real backup fall back to fixed cases when the backup is not on the machine. */
const { spawnSync } = require('child_process');
const path = require('path');
const CHECKS = [
  ['calc-check.js', '--ci'], ['sync-check.js'], ['merge-check.js'], ['sync-sim.js', '300'], ['integrity-check.js'], ['books-fuzz.js', '1500'], ['wa-parse-check.js'], ['audit-check.js'],
  ['task-money-check.js'], ['partner-paid-check.js'], ['collection-rule-check.js'], ['partners-accuracy-check.js'], ['order-check.js'], ['messages-check.js'], ['home-check.js'],
  ['ui2-version-check.js'], ['save-wedge-check.js'], ['entry-order-check.js'], ['access-check.js'], ['push-access-check.js'], ['partner-guess-check.js'], ['order-hardening-check.js'],
  ['safe-id-check.js'], ['erp-hours-check.js'], ['work-category-check.js'], ['week-income-check.js'], ['scheduled-expenses-check.js'], ['report-five-check.js'], ['fresh-check.js'], ['owner-queue-check.js'], ['rules-shape-check.js'],
  ['inject-check.js'], ['cron-auth-check.js'], ['audit-26-10-check.js'], ['live-warnings-check.js'], ['mutation-gaps-check.js'], ['perf-equiv-check.js'], ['backup-restore-check.js'], ['money-fixes-check.js'], ['sync-adversarial-check.js']
];
const filter = process.argv[2] || '';
const failed = [];
const inGit = require('fs').existsSync(path.join(__dirname, '..', '.git'));   // calc-check --ci compares with the live version through git; a plain copy runs only its fixed cases
let ran = 0;
for (const [file, ...args] of CHECKS) {
  if (filter && !file.includes(filter)) continue;
  ran++;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--max-old-space-size=1536', path.join(__dirname, file), ...args.filter(a => inGit || a !== '--ci')], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  const ok = r.status === 0;
  console.log(`${ok ? '✔' : '✖'} ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  if (!ok) failed.push(file);
}
console.log(failed.length ? `\n✖ ${failed.length} of ${ran} failed: ${failed.join(', ')}` : `\n✔ all ${ran} checks passed`);
process.exit(failed.length ? 1 : 0);
