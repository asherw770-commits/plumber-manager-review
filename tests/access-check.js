#!/usr/bin/env node
/* Per-user tab access (Asher 14.10): the role's default tabs stay exactly as before; a hand-picked list replaces them; admin is never restricted;
 * admin-only screens can never be granted; dashboard is always on; an admin's preview as someone uses the ?acc= list.
 *   node tests/access-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadApp } = require('../api/_loadApp');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
// the tab tables are plain `const`s the shared loader does not know — run just that block here (as vars, so the test can read them)
{
  const a = html.indexOf('const ACCESS_TABS'), b = html.indexOf('function roleDefaultViews');
  if (a < 0 || b < 0) throw new Error('access tables not found');
  vm.runInContext(html.slice(a, b).replace(/^const /gm, 'var '), app);
}
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; console.error('❌ ' + m); } };
const ALL = ['dashboard', 'tasks', 'collection', 'transactions', 'reports', 'profit', 'erp', 'customers', 'partners', 'products', 'settings', 'messages', 'preview', 'add', 'whatsapp', 'nonsense'];
const views = role => ALL.filter(v => app.canAccessView(role, v));
const as = (user, fn) => { app.state.currentUser = user; try { return fn(); } finally { app.state.currentUser = null; } };

// 1. defaults — exactly what each role had before the feature
app.state.currentUser = null;
expect(views('manager').join() === ['dashboard', 'reports', 'profit', 'erp', 'transactions', 'customers', 'partners'].sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b)).join(), 'manager default changed: ' + views('manager'));
expect(views('owner').join() === ['dashboard', 'tasks', 'collection', 'partners', 'products'].sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b)).join(), 'owner default changed: ' + views('owner'));
expect(['dashboard', 'tasks', 'collection', 'transactions', 'reports', 'profit', 'customers', 'partners', 'products', 'settings', 'messages', 'preview', 'add'].every(v => app.canAccessView('admin', v)), 'admin must reach every screen');
expect(!app.canAccessView('admin', 'whatsapp'), 'whatsapp stays removed');

// 2. a user with a hand-picked list
as({ uid: 'u1', role: 'manager', access: { views: ['collection', 'tasks', 'settings', 'messages', 'bogus'] } }, () => {
  const v = views('manager');
  expect(v.join() === ['dashboard', 'tasks', 'collection'].join(), 'custom list should be dashboard + granted tabs only (no admin-only/unknown): ' + v);
});
as({ uid: 'u2', role: 'owner', access: { views: [] } }, () => expect(views('owner').join() === 'dashboard', 'an empty list leaves only the dashboard: ' + views('owner')));
as({ uid: 'u3', role: 'owner', access: null }, () => expect(views('owner').join() === views('owner').join() && app.canAccessView('owner', 'collection'), 'no access field → role default'));
// a custom list belongs to that user's own role only
as({ uid: 'u4', role: 'owner', access: { views: ['transactions'] } }, () => {
  expect(app.canAccessView('owner', 'transactions') && !app.canAccessView('owner', 'tasks'), 'owner custom list');
  expect(app.canAccessView('manager', 'reports') && app.canAccessView('manager', 'transactions'), 'a different role keeps its own defaults');
});
// 3. admin is never restricted, even with a stray access field
as({ uid: 'a', role: 'admin', access: { views: ['tasks'] } }, () => expect(app.canAccessView('admin', 'settings') && app.canAccessView('admin', 'reports'), 'admin restricted by a stray access field'));

// 4. role default sets
expect(app.roleDefaultViews('admin').length === app.GRANTABLE_VIEWS.length, 'admin default = every grantable tab');
expect(!app.GRANTABLE_VIEWS.some(v => ['settings', 'messages', 'preview', 'add', 'whatsapp'].includes(v)), 'admin-only screens must not be grantable');

// 5. the users section guards itself
expect(/function canManageUsers\(\) \{ return isAdmin\(\); \}/.test(html), 'only admin manages users');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
expect(/get\('disabled', false\) == true \? 'disabled'/.test(rules), 'rules: a suspended account must have no role');
expect(/isSuperUid\(uid\) \|\| \(request\.resource\.data\.role == 'admin' && request\.resource\.data\.get\('disabled', false\) == false\)/.test(rules), 'rules: the super-admin can never be suspended');

if (fails) { console.error('access-check: ' + fails + ' failures'); process.exit(1); }
console.log('✅ access-check: ברירות מחדל של התפקידים לא השתנו; הרשאות לפי לשונית, מסכי מזכיר לא ניתנים, מזכיר לא מוגבל, השהיה בכללים');
