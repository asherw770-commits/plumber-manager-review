#!/usr/bin/env node
/* Mutation testing for the money engine (not part of the push gate — takes ~30+ minutes).
 * It copies the repo to a scratch folder, breaks ONE operator at a time inside the chosen money functions of index.html
 * (+ ↔ -, * → /, < ↔ <=, > ↔ >=, && ↔ ||, === ↔ !==) and runs the money tests. A mutant that no test notices ("survived") means a gap in the tests
 * (or an equivalent change). Survivors are written to the report.
 *   node tests/mutation-run.js [maxMutants=120] [seed=1] [outDir=/tmp/mutation] [onlyIndexes=1,5,9]
 * Runs one node process at a time (RAM-friendly). */
const fs = require('fs'), path = require('path'), { spawnSync, execSync } = require('child_process');
const root = path.join(__dirname, '..');
const MAX = Number(process.argv[2]) || 120, SEED = Number(process.argv[3]) || 1, OUT = path.resolve(process.argv[4] || '/tmp/mutation');
const FUNCS = ['yehudaShare', 'collectedAmount', 'pendingAmount', 'collectedYehudaShare', 'collectedPartnerShare', 'cashDateOf', 'isDoneTx', 'txCountsInGross', 'yehudaPending', 'owedToPartnerNow', 'partnerCutStillToCome', 'txMoney', 'txMinutes',
  'computeDailyReport', 'homeNetSeries', 'homeNetCompare', '_bucketFigures', 'cashPeriodFigures', 'weeklyFigures', 'monthlyFigures', '_weekCompare', 'weekSummaryCompare', 'weekStartISO', 'addDaysISO', 'expenseMonthTable', 'workProfitReport', 'marginPct',
  'partnerBalances', 'collectionQueue', 'erpHoursReport', 'erpAgg', 'buildWeekly', 'recordReceipt', 'allocateOldestFirst', 'collectionRuleStats', 'reportFigures'];
const TESTS = [['mutation-gaps-check.js'], ['calc-check.js'], ['books-fuzz.js', '300'], ['partners-accuracy-check.js'], ['partner-paid-check.js'], ['task-money-check.js'], ['collection-rule-check.js'], ['home-check.js'], ['erp-hours-check.js'], ['week-income-check.js'], ['work-category-check.js'], ['money-fixes-check.js'], ['messages-check.js'], ['audit-check.js']];
// scratch copy of the tracked files
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
execSync(`git ls-files -co --exclude-standard -z | rsync -a --from0 --files-from=- ./ "${OUT}/"`, { cwd: root });   // the working tree: committed + new files
const htmlPath = path.join(OUT, 'index.html'), orig = fs.readFileSync(htmlPath, 'utf8');
// function ranges: "function name(" at column 0 until the next line that is exactly "}"
const lines = orig.split('\n'), starts = [];
FUNCS.forEach(n => { const i = lines.findIndex(l => new RegExp('^(async )?function ' + n.replace(/[$]/g, '\\$') + '\\s*\\(').test(l)); if (i >= 0) { let j = i; while (j < lines.length && lines[j] !== '}') j++; if (lines[i].includes('{') && /\}\s*$/.test(lines[i]) && j > i + 400) j = i; starts.push({ name: n, from: i, to: Math.min(j, lines.length - 1) }); } });
const OPS = [['+', '-'], ['-', '+'], ['*', '/'], ['<=', '<'], ['>=', '>'], ['<', '<='], ['>', '>='], ['&&', '||'], ['||', '&&'], ['===', '!=='], ['!==', '===']];
function candidates(fn) {   // [{line, col, from, to}] — scans code only (skips strings, template literals, comments, regex-looking slashes)
  const out = [];
  for (let li = fn.from; li <= fn.to; li++) {
    const s = lines[li]; let i = 0, q = null;
    while (i < s.length) {
      const c = s[i], n2 = s.substr(i, 2), n3 = s.substr(i, 3);
      if (q) { if (c === '\\') { i += 2; continue; } if (c === q) q = null; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
      if (n2 === '//') break;
      if (n2 === '/*') { const e = s.indexOf('*/', i + 2); if (e < 0) break; i = e + 2; continue; }
      let hit = null;
      for (const [a, b] of OPS) if (s.substr(i, a.length) === a) { hit = [a, b]; break; }
      if (hit) {
        const [a, b] = hit, prev = s.slice(0, i).trimEnd().slice(-1), next = s.substr(i + a.length, 1);
        const binary = (a === '+' || a === '-') ? /[\w)\]]/.test(prev) && next !== a && next !== '=' && s[i - 1] !== a && s[i + 1] !== '>' : true;
        const notArrowOrAssign = !((a === '<' || a === '>') && (next === '=' || next === '>' || s[i - 1] === '=' || s[i - 1] === '-' || s[i - 1] === '<' || s[i - 1] === '>' || s[i - 1] === '?' || next === '<')) && !(a === '*' && (s[i - 1] === '/' || next === '/' || next === '=')) && !(a === '=' || next === '=' && (a === '+' || a === '-'));
        if (binary && notArrowOrAssign && !(a === '<' && /[A-Za-z]/.test(next)) && !(a === '>' && /^[a-z]/.test(s.slice(i + 1, i + 2)) && false)) out.push({ line: li, col: i, from: a, to: b });
        i += a.length; continue;
      }
      i++;
    }
  }
  return out;
}
let all = []; starts.forEach(fn => candidates(fn).forEach(c => all.push({ ...c, fn: fn.name })));
let s = SEED; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
let picked = all.slice(0, MAX);
if (process.argv[5]) { const only = new Set(process.argv[5].split(',').map(Number)); picked = picked.filter((_, i) => only.has(i + 1)); }   // re-run chosen mutants (1-based, as numbered in a previous run)
console.log(`functions found: ${starts.length}/${FUNCS.length}; mutation candidates: ${all.length}; running ${picked.length}`);
const run = () => { for (const [f, ...a] of TESTS) { const r = spawnSync(process.execPath, ['--max-old-space-size=1024', path.join(OUT, 'tests', f), ...a], { cwd: OUT, timeout: 90000, encoding: 'utf8' }); if (r.status !== 0) return f; } return null; };
const baseline = run(); if (baseline) { console.error('baseline fails on ' + baseline); process.exit(2); }
const survivors = [], killed = [], invalid = [];
picked.forEach((m, k) => {
  const L = lines.slice(); L[m.line] = L[m.line].slice(0, m.col) + m.to + L[m.line].slice(m.col + m.from.length);
  fs.writeFileSync(htmlPath, L.join('\n'));
  const label = `${m.fn}:${m.line + 1} "${m.from}"→"${m.to}"  ${lines[m.line].trim().slice(0, 90)}`;
  const code = [...L.join('\n').matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes('function computeStats('));
  try { new Function(code); } catch (e) { invalid.push(label); console.log(`[${k + 1}/${picked.length}] invalid  (syntax) ${label.slice(0, 100)}`); return; }
  const t0 = Date.now(); const by = run();
  if (by === null) survivors.push(label); else killed.push(label + '  ← ' + by);
  console.log(`[${k + 1}/${picked.length}] ${by === null ? 'SURVIVED' : 'killed  '} ${((Date.now() - t0) / 1000).toFixed(0)}s ${label.slice(0, 120)}`);
});
fs.writeFileSync(htmlPath, orig);
const rep = `# Mutation run\nmutants run: ${picked.length - invalid.length} (+${invalid.length} skipped as invalid) · killed: ${killed.length} · survived: ${survivors.length}\n\n## Survivors (no test noticed)\n${survivors.map(x => '- ' + x).join('\n') || '(none)'}\n\n## Killed\n${killed.map(x => '- ' + x).join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'mutation-report.md'), rep); console.log(`\nkilled ${killed.length}, survived ${survivors.length} → ${path.join(OUT, 'mutation-report.md')}`);
