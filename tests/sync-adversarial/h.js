'use strict';
/* Full-fidelity multi-device harness: REAL saveState / mergeCloudDoc / applySnapshot / _mergeOwnerActions /
 * _saveOwnerActions / applyBackupData / freshenState from index.html, virtual time, fake Firestore. */
const fs = require('fs'), vm = require('vm');
const APP = require('path').join(__dirname, '..', '..');
const { loadApp } = require(APP + '/api/_loadApp');
const HTML = fs.readFileSync(process.env.APP_HTML || APP + '/index.html', 'utf8');

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function extractNested(name, indent) {
  const lines = HTML.split('\n'); const pad = ' '.repeat(indent);
  const i = lines.findIndex(l => l.startsWith(pad + (name.startsWith('async') ? '' : '') + 'function ' + name + '(') || l.startsWith(pad + 'async function ' + name + '('));
  if (i < 0) throw new Error('nested fn not found ' + name);
  let j = i + 1; while (lines[j] !== pad + '}') j++;
  return lines.slice(i, j + 1).join('\n');
}
const APPLY_SNAPSHOT_SRC = extractNested('applySnapshot', 4);
const APPLY_BACKUP_SRC = extractNested('applyBackupData', 2);

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

class World {
  constructor(seed, opts = {}) {
    this.R = rng(seed); this.t = T0; this.timers = []; this.seq = 0; this.docs = new Map(); this.devs = []; this.ver = 0;
    this.opts = opts; this.writes = 0; this.log = [];
    this.lat = opts.lat || [30, 2500];
  }
  rnd() { return this.R(); }
  int(n) { return Math.floor(this.R() * n); }
  pick(a) { return a[this.int(a.length)]; }
  latency() { return this.lat[0] + this.int(this.lat[1] - this.lat[0]); }
  at(t, fn, dev) { const id = ++this.seq; this.timers.push({ t: Math.max(t, this.t), id, fn, dev }); return id; }
  clear(id) { const i = this.timers.findIndex(x => x.id === id); if (i >= 0) this.timers.splice(i, 1); }
  async drain() { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); }
  async runUntil(t) {
    await this.drain();
    for (let guard = 0; guard < 200000; guard++) {
      let bi = -1;
      for (let i = 0; i < this.timers.length; i++) { const x = this.timers[i]; if (x.t <= t && (bi < 0 || x.t < this.timers[bi].t || (x.t === this.timers[bi].t && x.id < this.timers[bi].id))) bi = i; }
      if (bi < 0) break;
      const x = this.timers.splice(bi, 1)[0]; this.t = Math.max(this.t, x.t);
      try { x.fn(); } catch (e) { this.log.push('timer err ' + e.message); }
      await this.drain();
    }
    this.t = Math.max(this.t, t);
    await this.drain();
  }
  async advance(ms) { await this.runUntil(this.t + ms); }
  async go(p) { // drive virtual time until promise p settles
    let done = false, val, err; p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
    await this.drain();
    for (let guard = 0; guard < 100000 && !done; guard++) {
      if (!this.timers.length) { await this.drain(); if (!done) break; }
      let bi = -1; for (let i = 0; i < this.timers.length; i++) { const x = this.timers[i]; if (bi < 0 || x.t < this.timers[bi].t || (x.t === this.timers[bi].t && x.id < this.timers[bi].id)) bi = i; }
      if (bi < 0) break;
      const x = this.timers.splice(bi, 1)[0]; this.t = Math.max(this.t, x.t);
      try { x.fn(); } catch (e) { this.log.push('timer err ' + e.message); }
      await this.drain();
    }
    if (!done) throw new Error('go(): promise never settled');
    if (err) throw err; return val;
  }
  // ── cloud ──
  applySentinels(prev, data, merge) {
    const out = merge ? Object.assign({}, prev || {}) : {};
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__u) { const cur = Array.isArray(out[k]) ? out[k].slice() : []; const have = new Set(cur.map(x => JSON.stringify(x))); v.__u.forEach(x => { if (!have.has(JSON.stringify(x))) { cur.push(JSON.parse(JSON.stringify(x))); have.add(JSON.stringify(x)); } }); out[k] = cur; }
      else if (v && v.__r) { const rm = new Set(v.__r.map(x => JSON.stringify(x))); out[k] = (Array.isArray(out[k]) ? out[k] : []).filter(x => !rm.has(JSON.stringify(x))); }
      else out[k] = JSON.parse(JSON.stringify(v));
    }
    return out;
  }
  cloudWrite(path, data, merge, byDev) {
    const prev = this.docs.get(path);
    const nd = this.applySentinels(prev && prev.data, data, merge);
    const ver = ++this.ver; this.docs.set(path, { data: nd, ver }); this.writes++;
    // notify listeners
    this.devs.forEach(d => d.listeners.filter(l => l.path === path).forEach(l => this.deliver(d, l, path)));
  }
  deliver(d, l, path) {
    if (!d.net) { l.missed = true; return; }
    const ent = this.docs.get(path); if (!ent) return;
    const snapVer = ent.ver, data = JSON.parse(JSON.stringify(ent.data));
    const at = Math.max(this.t + this.latency(), l.lastAt + 1); l.lastAt = at;
    this.at(at, () => { if (!d.net) { l.missed = true; return; } let dd = data; if (this.opts.coalesce) { const cur = this.docs.get(path); if (cur && cur.ver > snapVer) { if (l.deliveredVer >= cur.ver) return; dd = JSON.parse(JSON.stringify(cur.data)); l.deliveredVer = cur.ver; } else l.deliveredVer = snapVer; } if (l.cb) l.cb({ exists: () => true, data: () => dd, metadata: { fromCache: false } }); }, d);
  }
}

function makeDevice(world, name, role, o = {}) {
  const app = loadApp(HTML);
  const dev = { name, role, app, world, net: true, skew: o.skew || 0, listeners: [], ls: {}, pendingWrites: [] };
  const W = world;
  // clock
  const skewNow = () => W.t + dev.skew;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(skewNow()); } static now() { return skewNow(); } }
  app.Date = FakeDate;
  app.TextEncoder = TextEncoder; app.Promise = Promise; app.Error = Error; app.Boolean = Boolean; app.RegExp = RegExp; app.Symbol = Symbol; app.encodeURIComponent = encodeURIComponent;
  app.setTimeout = (f, ms) => W.at(W.t + (ms || 0), f, dev);
  app.clearTimeout = id => W.clear(id);
  app.setInterval = () => 0;
  app.navigator = { get onLine() { return dev.net || !!dev.lieFi; } };
  app.location = { search: '', pathname: '/', protocol: 'file:', origin: 'file://', reload() {} };
  app.confirm = () => true; app.alert = () => {}; app.render = () => {}; app.toast = () => {}; app.applyRoleUI = () => {}; app.refreshSyncIndicator = () => {};
  app.localStorage = { getItem: k => (k in dev.ls ? dev.ls[k] : null), setItem: (k, v) => { dev.ls[k] = String(v); }, removeItem: k => { delete dev.ls[k]; } };
  app.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], activeElement: null, addEventListener() {}, visibilityState: 'visible' };
  app.window = app.window || {};
  const mkSnap = ent => ({ exists: () => !!ent, data: () => ent ? JSON.parse(JSON.stringify(ent.data)) : undefined });
  const hangForever = () => new Promise(() => {});
  app.window.fb = {
    db: {}, auth: { currentUser: { uid: 'u-' + name } },
    doc: (db, ...a) => ({ path: a.join('/') }),
    collection: (db, ...a) => ({ path: a.join('/') }),
    arrayUnion: (...v) => ({ __u: v }), arrayRemove: (...v) => ({ __r: v }),
    setDoc: (ref, data, opts) => {
      if (dev.failNext && ref.path === 'state/current') { dev.failNext--; return new Promise((_, rej) => W.at(W.t + W.latency(), () => rej(new Error('transient')), dev)); }
      const merge = !!(opts && opts.merge);
      const payload = JSON.parse(JSON.stringify(data, (k, v) => v === undefined ? null : v));
      // arrayUnion sentinels survive JSON roundtrip as plain objects {__u:[...]}
      return new Promise((res, rej) => {
        if (!dev.net) { if (dev.lieFi) { dev.pendingWrites.push({ ref, payload, merge, res }); } else rej(new Error('offline')); return; }
        W.at(W.t + W.latency(), () => { W.cloudWrite(ref.path, payload, merge, dev); res(); }, dev);
      });
    },
    updateDoc: (ref, data) => new Promise((res, rej) => {
      if (!dev.net) { rej(new Error('offline')); return; }
      const payload = JSON.parse(JSON.stringify(data));
      W.at(W.t + W.latency(), () => { W.cloudWrite(ref.path, payload, true, dev); res(); }, dev);
    }),
    getDoc: ref => new Promise((res, rej) => {
      if (!dev.net) { rej(new Error('offline')); return; }
      W.at(W.t + W.latency(), () => { if (!dev.net) { rej(new Error('offline')); return; } res(mkSnap(W.docs.get(ref.path))); }, dev);
    }),
    onSnapshot: (ref, cb) => { const l = { path: ref.path, cb, lastAt: 0, missed: false }; dev.listeners.push(l); if (W.docs.has(ref.path)) W.deliver(dev, l, ref.path); return () => { l.cb = null; }; },
    getDocs: () => Promise.resolve({ forEach() {} }), deleteDoc: () => Promise.resolve(),
  };
  vm.runInContext("var LS_KEY='pm', _saveInFlight=null, _saveQueued=false, _saveGen=0, _managerToastShown=false, _ownerPushInFlight=null, _ownerPushQueued=false, _saveRetryTimer=null, CLIENT_VERSION=3, SUPER_ADMIN_UID='x';", app);
  vm.runInContext(APPLY_SNAPSHOT_SRC.replace('function applySnapshot', 'var applySnapshot = function'), app);
  vm.runInContext(APPLY_BACKUP_SRC.replace('function applyBackupData', 'var applyBackupData = function'), app);
  app.state.currentUser = { uid: 'u-' + name, email: name + '@t', role, name };
  app.state.undoStack = [];
  app.state.config = { yehudaDirect: !!o.direct };
  dev.ctx = code => vm.runInContext(code, app);
  dev.setOffset = off => vm.runInContext('_clockOffset = ' + off, app);
  if (o.detected) dev.setOffset(-dev.skew);
  dev.now = () => vm.runInContext('_clockNow()', app);
  // quiet noisy console
  app.console = { log() {}, info() {}, warn() {}, error(...a) { if (process.env.APPERR) console.error('[app err ' + name + ']', ...a); }, debug() {} };
  world.devs.push(dev);
  return dev;
}

const persistFn = dev => dev.ctx('_persistLocal');

// boot = handleAuthChange's data path (restore cache -> getDoc -> merge -> baseline -> listener)
async function boot(dev, retry) {
  const app = dev.app, W = dev.world, s = app.state;
  dev.alive = true;
  dev.listeners.forEach(l => l.cb = null); dev.listeners = [];
  if (!retry) {
  // fresh memory
  s.tx = []; s.tasks = []; s.customerMeta = {}; s.whatsappInbox = []; s.dailyNotes = {}; s.products = []; s.priceList = []; s.settlements = []; s._deletedIds = []; s._deletedAt = {}; s._dictUpdatedAt = {}; s._dictDeleted = {}; s._syncedAt = 0; s._dirty = false; s._lastSaveError = null;
  s._bootPending = false; s._bootFailed = false;
  dev.ctx('_localEdits.clear(); _saveInFlight=null; _saveQueued=false; _saveGen=0; _ownerPushInFlight=null; _ownerPushQueued=false; _saveRetryTimer=null;');
  app._restoreLocal();
  if ((s.tx || []).length) { s._bootPending = true; app._captureBaseline(); }
  }
  if (!dev.net) { s._bootFailed = true; app._captureBaseline(); return; }
  const stateRef = app.window.fb.doc(null, 'state', 'current'), inboxRef = app.window.fb.doc(null, 'state', 'inbox');
  let ss, is;
  try { [ss, is] = await Promise.all([app.window.fb.getDoc(stateRef), app.window.fb.getDoc(inboxRef).catch(() => null)]); } catch (e) { s._bootFailed = true; app._captureBaseline(); return; }
  s._bootPending = false; s._bootFailed = false;
  if (ss.exists()) {
    const d = ss.data();
    const inboxRows = is && is.exists() ? (is.data().items || []) : (Array.isArray(d.whatsappInbox) ? d.whatsappInbox : []);
    app.mergeCloudDoc(d, Array.isArray(inboxRows) ? inboxRows : []);
    try { if (app._localAheadOfRemote(d)) { s._dirty = true; app.setTimeout(() => { try { app.saveState(); } catch (_) {} }, 800); } else s._syncedAt = dev.now(); } catch (_) {}
  } else { await app.saveState(); }
  const migrated = 0;
  app._captureBaseline();
  if (dev.role === 'owner' && ss.exists()) {
    const d0 = ss.data();
    [['tasks', d0.tasks], ['tx', d0.tx]].forEach(([k, remoteArr]) => {
      const rm = new Map((Array.isArray(remoteArr) ? remoteArr : []).map(r => [r.id, r]));
      (s[k] || []).forEach(r => { const x = rm.get(r.id); if (r && r.id && (!x || (Number(r._updatedAt) || 0) > (Number(x._updatedAt) || 0))) dev.ctx('_localEdits').set(r.id, Number(r._updatedAt) || app.Date.now()); });
    });
    if (dev.ctx('_localEdits.size')) { s._dirty = true; app.setTimeout(() => { try { app.saveState(); } catch (_) {} }, 500); }
  }
  if (dev.role === 'admin') await app._mergeOwnerActions();
  // listeners
  const lStateEcho = snap => {
    const d = snap.data();
    if (d.writeId && s._lastWriteId && d.writeId === s._lastWriteId) return;
    app.applySnapshot(d, { skipRender: true });
  };
  app.window.fb.onSnapshot(stateRef, lStateEcho);
  app.window.fb.onSnapshot(inboxRef, snap => { const d = snap.data(); if (d.writeId && s._lastWriteId && d.writeId === s._lastWriteId) return; if (!Array.isArray(d.items)) return; s.whatsappInbox = app.mergeRowsById(s.whatsappInbox, app.safeRows(d.items)); app._captureBaseline(); app._persistLocal(); });
  // the app's setInterval(_mergeOwnerActions, 60s)
  if (dev.role === 'admin') { const tick = () => { if (dev.net && dev.alive !== false) { app._mergeOwnerActions(); } dev._tick = app.setTimeout(tick, 60000); }; dev._tick = app.setTimeout(tick, 60000); dev.alive = true; }
}
function closeApp(dev) { dev.alive = false; dev.listeners.forEach(l => l.cb = null); dev.listeners = []; if (dev._tick) dev.world.clear(dev._tick); dev.world.timers = dev.world.timers.filter(x => x.dev !== dev); }
function goOffline(dev, lieFi) { dev.net = false; dev.lieFi = !!lieFi; }
async function goOnline(dev) {
  const W = dev.world, app = dev.app;
  dev.net = true;
  // lie-fi: SDK flushes queued writes in order, blindly
  const pw = dev.pendingWrites; dev.pendingWrites = [];
  pw.forEach(w => { W.at(W.t + W.latency(), () => { W.cloudWrite(w.ref.path, w.payload, w.merge, dev); w.res(); }, dev); });
  dev.listeners.forEach(l => { if (l.missed) { l.missed = false; W.deliver(dev, l, l.path); } });
  // window 'online' handler
  if (!dev.alive) return;
  if (app.state._bootFailed) { await W.go(boot(dev, true)); if (app.state._dirty) { try { app.saveState(); } catch (_) {} } return; }
  if (!pw.length) { if (app.state._dirty) await W.go(app._reconnectMerge()); if (app.state._dirty) { try { app.saveState(); } catch (_) {} } }
}

// helpers to read state
const snapRows = (dev, k) => Object.fromEntries(dev.app.state[k].map(r => [r.id, r]));
const cloudDoc = W => (W.docs.get('state/current') || {}).data || {};

module.exports = { World, makeDevice, boot, closeApp, goOffline, goOnline, snapRows, cloudDoc, rng, T0, HTML, APP, vm };
