#!/usr/bin/env node
/* A task's money must read the same everywhere (Asher 5.10: the total typed in the edit form was 2,900 but the card showed a
 * stale hidden "my share" of 2,200). Guards: with no partner the whole amount is mine and the card/banner show it; a
 * saved no-partner task never carries a leftover share; random combinations obey the same rules.
 *   node tests/task-money-check.js
 */
const fs = require('fs');
const path = require('path');
const { loadApp } = require('../api/_loadApp');
const app = loadApp(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 10) console.error('❌ ' + m); } };

// the exact incident: the form posts the new total next to the old hidden share
let n = app.normalizeTaskMoney({ partnerName: '', cost: 2900, myShare: 2200, partnerAmount: 0 });
expect(n.cost === 2900 && n.myShare === 2900 && n.partnerAmount === 0, 'stale hidden share must be replaced by the total: ' + JSON.stringify(n));
expect(app.taskAmountMine({ partnerName: '', cost: 2900, myShare: 2200 }) === 2900, 'the card must show the total, not the stale share');
// amount known only as "my share" (total left empty) is kept, not lost
n = app.normalizeTaskMoney({ partnerName: '', cost: 0, myShare: 2200, partnerAmount: 0 });
expect(n.cost === 2200 && n.myShare === 2200, 'an amount known only as my share must be preserved: ' + JSON.stringify(n));
// with a partner nothing is touched and the card shows my share
n = app.normalizeTaskMoney({ partnerName: 'אהרן', cost: 3500, myShare: 1000, partnerAmount: 2500 });
expect(n.myShare === 1000 && n.partnerAmount === 2500 && n.cost === 3500, 'a partnered task must stay as entered');
expect(app.taskAmountMine({ partnerName: 'אהרן', cost: 3500, myShare: 1000, partnerAmount: 2500 }) === 1000, 'partnered card shows my share');
// consistency detector
expect(app.taskMoneyIssues({ partnerName: '', cost: 2900, myShare: 2200 }).length === 1, 'the incident state must be flagged');
expect(app.taskMoneyIssues({ partnerName: '', cost: 2900, myShare: 2900 }).length === 0, 'a consistent task must not be flagged');
expect(app.taskMoneyIssues({ partnerName: 'אהרן', cost: 3500, myShare: 1000, partnerAmount: 2500 }).length === 0, 'a consistent partnered task must not be flagged');
expect(app.taskMoneyIssues({ partnerName: 'אהרן', cost: 3500, myShare: 1000, partnerAmount: 2000 }).length === 1, 'a partnered split that does not add up must be flagged');
// random combinations: after normalising, no-partner tasks always read consistently
let seed = 7; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let i = 0; i < 3000; i++) {
  const t = { partnerName: R() < 0.5 ? '' : (R() < 0.5 ? 'אהרן' : '  '), cost: R() < 0.2 ? 0 : Math.round(R() * 9000), myShare: R() < 0.3 ? 0 : Math.round(R() * 9000), partnerAmount: R() < 0.5 ? 0 : Math.round(R() * 5000) };
  const norm = app.normalizeTaskMoney(t);
  if (!String(t.partnerName).trim()) {
    expect(norm.partnerAmount === 0 && norm.myShare === norm.cost, 'no-partner normalisation: ' + JSON.stringify(t) + ' → ' + JSON.stringify(norm));
    expect(app.taskMoneyIssues({ ...t, ...norm }).length === 0, 'normalised no-partner task must be consistent: ' + JSON.stringify(t));
    const expected = t.cost > 0 ? t.cost : t.myShare;
    expect(app.taskAmountMine(t) === expected, 'card amount for no-partner ' + JSON.stringify(t) + ' = ' + app.taskAmountMine(t) + ' expected ' + expected);
  }
}
if (fails) process.exit(1);
console.log('✅ task-money-check: סכום משימה נקרא אותו דבר בטופס, בכרטיס ובהודעות — גם עם ערך ישן מוסתר');
