#!/usr/bin/env node
/* Work-type → category (Asher 19.10): the reset (nothing classified by guesswork), the {work text → category} map (one mark covers every job
 * with the same text), the profit-% report re-derived independently, the one-time reset, and the classify link API (token, validation, admin).
 *   node tests/work-category-check.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
let fakeAuth = { good: { uid: 'adm' } };
const FV = { increment: n => ({ __inc: n }), arrayUnion: (...v) => ({ __union: v }) };
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'firebase-admin') return { apps: [1], initializeApp() {}, credential: { cert() {} }, firestore: Object.assign(() => ({}), { FieldValue: FV }), auth: () => ({ verifyIdToken: async t => { if (!fakeAuth[t]) throw new Error('bad'); return fakeAuth[t]; } }) };
  if (r === 'web-push') return { setVapidDetails() {}, sendNotification: async () => {} };
  return orig.call(this, r, ...a);
};
const { loadApp } = require('../api/_loadApp');
const lib = require('../api/_lib');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = loadApp(html);
let fails = 0;
const expect = (c, m) => { if (!c) { fails++; if (fails < 15) console.error('❌ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// ── 1. the key is the same in the app and on the server
for (const s of ['סתימת מטבח', '  סתימת   מטבח ', 'a\tb\nc', '', null, undefined, 'x'.repeat(200), 'סתימה ראשית', 'חבית 1,500 ליטר ']) {
  expect(app.workKey(s) === lib.workKey(s), 'workKey differs for ' + JSON.stringify(s));
}
expect(lib.workKey('x'.repeat(200)).length === 80, 'key is capped');

// ── 2. no guessing; the map decides; a manual mark on one job wins
app.state.priceList = [{ id: 'p1', name: 'סתימת מטבח', category: 'סתימות' }, { id: 'p2', name: 'החלפת דוד', category: 'דודים' }];
app.state.config = {};
expect(app.txWorkCategory({ work: 'סתימת מטבח' }) === null, 'a price-list match alone must not classify any more');
expect(app.txWorkCategory({ work: 'החלפת דוד' }) === null, 'a price-list match alone must not classify any more (2)');
app.state.config = { workTypeMap: { 'סתימת מטבח': 'סתימות', 'constructor': 'x', 'ריק': '' } };
expect(app.txWorkCategory({ work: 'סתימת מטבח' }) === 'סתימות', 'mapped text');
expect(app.txWorkCategory({ work: '  סתימת   מטבח  ' }) === 'סתימות', 'same text with other spacing → same category');
expect(app.txWorkCategory({ work: 'סתימת מטבח ראשית' }) === null, 'a different text is not matched loosely');
expect(app.txWorkCategory({ work: 'ריק' }) === null, 'an unmarked ("") entry is no category');
expect(app.txWorkCategory({ work: 'toString' }) === null && app.txWorkCategory({ work: '__proto__' }) === null, 'object prototype names are not categories');
expect(app.txWorkCategory({ work: 'סתימת מטבח', workCategory: 'אחר' }) === 'אחר', 'a mark on one job wins');
expect(app.txWorkCategory({ work: '' }) === null && app.txWorkCategory(null) === null, 'empty work');

// ── 3. profit % report vs an independent recomputation
function reference(txs) {
  const cat = new Map(); let allMine = 0, allMat = 0, clsMine = 0, clsMat = 0, jobs = 0;
  for (const t of txs) {
    if (t.type !== 'income') continue;
    const st = app.txStage(t); if (!(st === 'unpaid' || st === 'partial' || st === 'paid')) continue;
    const total = Number(t.total) || 0, pa = Number(t.partnerAmount) || 0, mine = app.yehudaShare(t), mat = Number(t.materials) || 0;
    void total; void pa;
    const c = app.txWorkCategory(t) || 'ללא קטגוריה';
    const k = String(t.work || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ללא שם';
    const e = cat.get(c) || { jobs: 0, mine: 0, mat: 0, kinds: new Map() }; cat.set(c, e);
    const kk = e.kinds.get(k) || { jobs: 0, mine: 0, mat: 0 }; e.kinds.set(k, kk);
    for (const o of [e, kk]) { o.jobs++; o.mine += mine; o.mat += mat; }
    allMine += mine; allMat += mat; jobs++;
    if (c !== 'ללא קטגוריה') { clsMine += mine; clsMat += mat; }
  }
  return { cat, allMine, allMat, clsMine, clsMat, jobs };
}
function checkReport(txs, label) {
  const rep = app.workProfitReport(txs), ref = reference(txs);
  expect(rep.all.jobs === ref.jobs && near(rep.all.mine, ref.allMine) && near(rep.all.materials, ref.allMat), `${label}: overall jobs/mine/materials`);
  expect(near(rep.all.net, ref.allMine - ref.allMat), `${label}: overall net`);
  const wantPct = ref.allMine > 0 ? (ref.allMine - ref.allMat) / ref.allMine * 100 : null;
  expect((rep.all.pct === null) === (wantPct === null) && (wantPct === null || near(rep.all.pct, wantPct)), `${label}: weighted % ${rep.all.pct} vs ${wantPct}`);
  expect(near(rep.classified.mine, ref.clsMine) && near(rep.classified.materials, ref.clsMat), `${label}: classified-only totals`);
  expect(rep.cats.length === ref.cat.size, `${label}: category count ${rep.cats.length} vs ${ref.cat.size}`);
  let sumJobs = 0, sumNet = 0;
  for (const c of rep.cats) {
    const r = ref.cat.get(c.cat); if (!r) { expect(false, `${label}: unexpected category ${c.cat}`); continue; }
    expect(c.jobs === r.jobs && near(c.mine, r.mine) && near(c.materials, r.mat) && near(c.net, r.mine - r.mat), `${label}/${c.cat}: totals`);
    expect(c.pct === null ? !(r.mine > 0) : near(c.pct, (r.mine - r.mat) / r.mine * 100), `${label}/${c.cat}: pct`);
    expect(c.kinds.length === r.kinds.size && c.kinds.reduce((a, k) => a + k.jobs, 0) === c.jobs && near(c.kinds.reduce((a, k) => a + k.net, 0), c.net), `${label}/${c.cat}: kinds add up to the category`);
    for (const k of c.kinds) { const rk = r.kinds.get(k.kind); expect(rk && k.jobs === rk.jobs && near(k.mine, rk.mine) && near(k.materials, rk.mat), `${label}/${c.cat}/${k.kind}: kind totals`); }
    sumJobs += c.jobs; sumNet += c.net;
  }
  expect(sumJobs === rep.all.jobs && near(sumNet, rep.all.net), `${label}: categories add up to the overall figure`);
  const noCat = rep.cats.findIndex(c => c.cat === 'ללא קטגוריה');
  expect(noCat === -1 || noCat === rep.cats.length - 1, `${label}: the uncategorised bucket is last`);
  const html = app.workProfitPanelHTML(txs);
  expect(!/NaN|undefined|Infinity/.test(html), `${label}: panel has no NaN/undefined`);
}
// a small hand-made case with known numbers
app.state.config = { workTypeMap: { 'סתימת מטבח': 'סתימות', 'סתימה ראשית': 'סתימות', 'דוד': 'דודים' } };
const hand = [
  { id: 'a', type: 'income', stage: 'paid', work: 'סתימת מטבח', total: 400, materials: 50 },
  { id: 'b', type: 'income', stage: 'unpaid', work: 'סתימת  מטבח', total: 600, materials: 100 },
  { id: 'c', type: 'income', stage: 'paid', work: 'דוד', total: 1000, materials: 700 },
  { id: 'd', type: 'income', stage: 'paid', work: 'משהו אחר', total: 200, materials: 0 },
  { id: 'e', type: 'income', stage: 'scheduled', work: 'דוד', total: 999, materials: 0 }
];
app.state.tx = hand;
const hr = app.workProfitReport(hand);
const sc = hr.cats.find(c => c.cat === 'סתימות'), dd = hr.cats.find(c => c.cat === 'דודים');
expect(sc && sc.jobs === 2 && near(sc.mine, 1000) && near(sc.materials, 150) && near(sc.pct, 85), 'hand case: סתימות 85%');
expect(dd && near(dd.pct, 30), 'hand case: דודים 30%');
expect(near(hr.all.pct, (2200 - 850) / 2200 * 100), 'hand case: weighted overall is total ÷ total, not the mean of percentages');
expect(sc.kinds.length === 1 && sc.kinds[0].kind === 'סתימת מטבח' && sc.kinds[0].jobs === 2, 'hand case: the two spellings are one kind');
checkReport(hand, 'hand');
// the newest real backup, with the real work texts mapped to a few categories by keyword, and random books
const dir = path.join(process.env.HOME || '', 'Downloads');
const real = fs.existsSync('/private/tmp/claude-501/harness/data.json') ? require('/private/tmp/claude-501/harness/data.json') : null;
const rnd = (() => { let x = 12345; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
function run(txs, label) {
  const names = [...new Set(txs.map(t => app.workKey(t.work)).filter(Boolean))];
  const cats = ['סתימות', 'דודים', 'ברזים', 'נזילות'];
  const map = {}; names.forEach(n => { const r = rnd(); if (r < 0.7) map[n] = cats[Math.floor(rnd() * cats.length)]; else if (r < 0.75) map[n] = ''; });
  app.state.config = { workTypeMap: map }; app.state.tx = txs;
  checkReport(txs, label);
  // marking one text moves every job with that text, and only those
  const n = names[0]; if (!n) return;
  const before = txs.filter(t => app.workKey(t.work) !== n).map(t => app.txWorkCategory(t));
  app.state.config = { workTypeMap: { ...map, [n]: 'חדשה' } };
  expect(txs.filter(t => app.workKey(t.work) === n).every(t => app.txWorkCategory(t) === 'חדשה'), `${label}: all jobs of "${n}" follow the mark`);
  expect(JSON.stringify(txs.filter(t => app.workKey(t.work) !== n).map(t => app.txWorkCategory(t))) === JSON.stringify(before), `${label}: other jobs untouched`);
}
if (real) { run(real.tx, 'real'); expect(real.tx.filter(t => t.type === 'income').length > 0, 'real data present'); }
for (let i = 0; i < 40; i++) {
  const words = ['סתימה', 'דוד', 'ברז', 'נזילה', 'חבית', ' ', '1', '150'];
  const txs = Array.from({ length: 60 }, (_, j) => ({ id: 'r' + i + '_' + j, type: rnd() < 0.85 ? 'income' : 'expense', stage: ['paid', 'unpaid', 'partial', 'scheduled', 'cancelled'][Math.floor(rnd() * 5)],
    work: rnd() < 0.05 ? '' : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.5 ? ' ' : '  '),
    total: Math.round(rnd() * 2000), materials: rnd() < 0.3 ? Math.round(rnd() * 900) : 0, whoseCustomer: rnd() < 0.2 ? 'partner' : 'mine', partnerName: rnd() < 0.2 ? 'אהרן' : '', partnerAmount: rnd() < 0.2 ? Math.round(rnd() * 800) : 0, myShareOnly: rnd() < 0.1 }));
  run(txs, 'rand' + i);
}
// nothing earned → no percentage, never NaN
expect(app.marginPctText(0, 0) === '—' && app.marginPctText(-5, 0) === '—' && app.marginPctText(50, 200) === '25.0%', 'marginPctText');

// ── 4. the one-time reset
(async () => {
  const ctx = app;
  const log = { saved: 0, snaps: 0, flag: 0 };
  app.state.config = {}; app.state.products = [{ id: 'p1', name: 'x', category: 'ברזים' }, { id: 'p2', name: 'y', category: '' }];
  app.state.tx = [{ id: 't1', type: 'income', work: 'א', workCategory: 'אחר' }, { id: 't2', type: 'income', work: 'ב' }];
  const vm = require('vm');
  app.isAdmin = () => true; app.snapshotState = () => { log.snaps++; }; app.saveState = () => { log.saved++; }; app.render = () => {}; app.toast = () => {};
  app.saveConfig = async patch => { log.flag++; app.state.config = { ...app.state.config, ...patch }; return true; };
  vm.runInContext('this.resetWorkCategoriesOnce = resetWorkCategoriesOnce;', app);
  await app.resetWorkCategoriesOnce();
  expect(app.state.products.every(p => !p.category), 'reset: every catalog product has no category');
  expect(app.state.tx.every(t => !t.workCategory), 'reset: per-job marks are gone');
  expect(log.snaps === 1 && log.saved === 1 && log.flag === 1, `reset: one undo snapshot, one save, flag written once (${JSON.stringify(log)})`);
  app.state.products[0].category = 'חדש';          // later edits survive: it runs only once
  await app.resetWorkCategoriesOnce();
  expect(app.state.products[0].category === 'חדש' && log.flag === 1, 'reset runs only once');

  // ── 5. the classify link API on a fake Firestore
  const store = new Map();
  const clone = o => JSON.parse(JSON.stringify(o));
  const applyData = (cur, d, merge) => {
    const base = merge ? clone(cur || {}) : {};
    const put = (tgt, key, v) => {
      if (v && v.__inc !== undefined) tgt[key] = (Number(tgt[key]) || 0) + v.__inc;
      else if (v && v.__union) tgt[key] = [...new Set([...(tgt[key] || []), ...v.__union])];
      else if (merge && v && typeof v === 'object' && !Array.isArray(v)) { tgt[key] = tgt[key] && typeof tgt[key] === 'object' ? tgt[key] : {}; Object.keys(v).forEach(k => put(tgt[key], k, v[k])); }
      else tgt[key] = clone(v);
    };
    Object.keys(d).forEach(k => put(base, k, d[k]));
    return base;
  };
  const db = { doc: p => ({ path: p, get: async () => ({ exists: store.has(p), data: () => clone(store.get(p)) }), set: async (d, o) => { store.set(p, applyData(store.get(p), d, !!(o && o.merge))); }, delete: async () => { store.delete(p); } }) };
  const libPath = require.resolve('../api/_lib');
  require.cache[libPath].exports = { ...lib, getDb: () => db };
  delete require.cache[require.resolve('../api/classify.js')];
  const handler = require('../api/classify.js');
  const call = async (method, { query, body, auth } = {}) => { let code = 200, out; const hdr = {}; await handler({ method, query: query || {}, body, headers: auth ? { authorization: 'Bearer ' + auth } : {} }, { setHeader: (k, v) => { hdr[k] = v; }, status: c => ({ json: o => { code = c; out = o; } }) }); return { code, out, hdr }; };
  store.set('state/current', { tx: [
    { type: 'income', work: 'סתימת מטבח', total: 400 }, { type: 'income', work: 'סתימת  מטבח', total: 300 }, { type: 'income', work: 'דוד' },
    { type: 'expense', work: 'דלק' }, { type: 'income', work: '' }, { type: 'income', work: '__proto__' }, { type: 'income', work: '__x__' }],
    priceList: [{ category: 'סתימות' }, { category: 'דודים' }] });
  store.set('state/config', { payBit: '050' });
  store.set('users/adm', { role: 'admin' }); store.set('users/own', { role: 'owner' }); store.set('users/off', { role: 'admin', disabled: true });
  fakeAuth = { good: { uid: 'adm' }, own: { uid: 'own' }, off: { uid: 'off' } };

  let r = await call('POST', { body: { t: 'x' } });
  expect(r.code === 403, 'no link yet → forbidden');
  r = await call('POST', { body: { action: 'create' }, auth: 'own' });
  expect(r.code === 403, 'Yehuda (owner) cannot create the link');
  r = await call('POST', { body: { action: 'create' }, auth: 'off' });
  expect(r.code === 403, 'a suspended admin cannot');
  r = await call('POST', { body: { action: 'create' }, auth: 'nope' });
  expect(r.code === 401, 'bad id token');
  r = await call('POST', { body: { action: 'create' }, auth: 'good' });
  const tok = r.out && r.out.token;
  expect(r.code === 200 && tok && tok.length >= 30 && r.out.names === 2, 'admin creates a link: ' + JSON.stringify(r.out));
  expect(JSON.stringify(r.out).includes('payBit') === false, 'admin answer carries no config');
  r = await call('POST', { body: { action: 'create' }, auth: 'good' });
  expect(r.out.token === tok, 'create twice keeps the same link');

  r = await call('POST', { body: { t: tok } });
  expect(r.code === 200 && r.out.names.length === 2 && r.out.names[0].key === 'סתימת מטבח' && r.out.names[0].count === 2, 'GET lists distinct income texts with counts: ' + JSON.stringify(r.out.names));
  expect(!JSON.stringify(r.out).match(/400|300|total|phone/), 'GET exposes no amounts');
  expect(r.out.cats.join() === 'סתימות,דודים', 'GET offers the price-list groups');
  expect(r.hdr['Cache-Control'] === 'no-store', 'no caching');
  expect((await call('POST', { body: { t: tok + 'x' } })).code === 403 && (await call('POST', { body: {} })).code === 403 && (await call('GET', {})).code === 405, 'wrong / missing token');

  // saving
  r = await call('POST', { body: { t: tok, items: [{ key: 'סתימת מטבח', cat: 'סתימות' }, { key: 'לא קיים', cat: 'סתימות' }, { key: 'דוד', cat: 'קטגוריה לא קיימת' }, { key: '__x__', cat: 'סתימות' }, { key: 'דוד', cat: 5 }] } });
  expect(r.code === 200 && r.out.saved === 1, 'only the valid mark is saved: ' + JSON.stringify(r.out));
  let cfg = store.get('state/config');
  expect(cfg.workTypeMap && cfg.workTypeMap['סתימת מטבח'] === 'סתימות' && Object.keys(cfg.workTypeMap).length === 1 && cfg.payBit === '050', 'config gets the mark and keeps its other fields');
  // the app, reading that config, classifies both spellings
  app.state.config = cfg; app.state.tx = clone(store.get('state/current').tx);
  expect(app.state.tx.filter(t => app.txWorkCategory(t) === 'סתימות').length === 2, 'both spellings follow the server mark in the app');
  // new category
  r = await call('POST', { body: { t: tok, newCat: 'נזילות ואיתור', items: [{ key: 'דוד', cat: 'נזילות ואיתור' }] } });
  cfg = store.get('state/config');
  expect(r.out.saved === 1 && cfg.workCats.includes('נזילות ואיתור') && cfg.workTypeMap['דוד'] === 'נזילות ואיתור' && cfg.workTypeMap['סתימת מטבח'] === 'סתימות', 'new category created and used; earlier mark kept');
  expect(r.out.cats.includes('נזילות ואיתור'), 'new category offered afterwards');
  // unmark
  r = await call('POST', { body: { t: tok, items: [{ key: 'דוד', cat: '' }] } });
  expect(store.get('state/config').workTypeMap['דוד'] === '' && r.out.names.find(n => n.key === 'דוד').cat === '', 'unmark stores an empty category');
  // limits
  for (let i = 0; i < 45; i++) await call('POST', { body: { t: tok, newCat: 'קט' + i } });
  expect(store.get('state/config').workCats.length <= 40, 'category count capped: ' + store.get('state/config').workCats.length);
  expect(!store.get('state/config').workCats.some(c => c.length > 30), 'category names are capped');
  const many = Array.from({ length: 500 }, (_, i) => ({ key: 'סתימת מטבח', cat: 'סתימות' }));
  r = await call('POST', { body: { t: tok, items: many } });
  expect(r.out.saved <= 200, 'batch size capped');
  // bad tokens are counted, then refused
  const q = () => store.get('orderQuota/classify-' + lib.dayIL()) || {};
  expect(q().bad >= 3, 'bad attempts counted: ' + q().bad);
  store.set('orderQuota/classify-' + lib.dayIL(), { ...q(), bad: 300 });
  expect((await call('POST', { body: { t: 'zzz' } })).code === 429 && (await call('POST', { body: { t: tok } })).code === 200, 'after too many bad attempts strangers are refused but the right link still works');
  store.set('orderQuota/classify-' + lib.dayIL(), { bad: 0, writes: 0 });
  // revoke / rotate
  r = await call('POST', { body: { action: 'rotate' }, auth: 'good' });
  expect(r.out.token && r.out.token !== tok && (await call('POST', { body: { t: tok } })).code === 403 && (await call('POST', { body: { t: r.out.token } })).code === 200, 'rotate replaces the link');
  r = await call('POST', { body: { action: 'revoke' }, auth: 'good' });
  expect((await call('POST', { body: { t: r.out.token || 'x' } })).code === 403, 'revoke kills the link');
  expect(store.get('state/config').workTypeMap['סתימת מטבח'] === 'סתימות', 'revoking keeps the saved marks');

  if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
  console.log('work-category-check: OK');
})();
