#!/usr/bin/env node
/* The audit-log entry the app writes must fit the shape firestore.rules allows (a drift would silently switch the change log off for the session):
 *   node tests/rules-shape-check.js
 */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const m = rules.match(/match \/auditLog\/\{entryId\}[\s\S]*?hasOnly\(\[([^\]]*)\]\)/);
expect(!!m, 'auditLog hasOnly list not found in the rules');
const allowed = new Set((m ? m[1] : '').split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean));
// keys the client can put on an entry: the diff entry (kind,id,op,label,changes) + the bulk form + what _auditAfterSave adds
const written = new Set(['kind', 'id', 'op', 'label', 'changes']);
const bulk = html.match(/kind: 'bulk', id: '-', op: 'bulk', label: [^}]*?count: entries\.length, sample:/);
expect(!!bulk, 'bulk audit entry shape changed — update the rules and this test');
['count', 'sample'].forEach(k => written.add(k));
const add = html.match(/const entry = \{ \.\.\.e, at, by: u\.uid, byName: [^}]*role: [^}]*cv: CLIENT_VERSION \}/);
expect(!!add, 'audit entry construction changed — update the rules and this test');
['at', 'by', 'byName', 'role', 'cv'].forEach(k => written.add(k));
expect(/if \(state\._auditVia\) entry\.via = state\._auditVia;/.test(html), 'via is added to entries');
written.add('via');
for (const k of written) expect(allowed.has(k), 'the app writes "' + k + '" but the rules do not allow it');
for (const k of allowed) expect(written.has(k), 'the rules allow "' + k + '" that the app never writes (keep the list tight)');
expect(/request\.resource\.data\.get\('role', ''\) == role\(\)/.test(rules), 'rules: the role in the entry must be the real role');
if (fails) { console.error('rules-shape-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ rules-shape-check: רשומת יומן השינויים שהאפליקציה כותבת תואמת לכללים');
