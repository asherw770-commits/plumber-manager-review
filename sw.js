/* Service worker — the app opens instantly and without reception.
   - The page and our own files: served from the saved copy at once, and
     refreshed from the network in the background. When the page itself
     changed, open windows get {type:'pm-update'} and show a "גרסה חדשה —
     רענן" bar; the next open uses the new copy anyway. (Data is not here —
     it comes from Firestore / the app's own local copy.)
   - Firebase SDK (versioned URLs, never change) and fonts: cache first.
   - Everything else (Firestore, auth, Google APIs) is not touched — the data
     itself is kept by the app in localStorage, not here. */
const STALE_SHELL_MS = 6 * 3600 * 1000; // saved page older than this → fetch the new one before opening
const CACHE = 'pm-shell-v1'; // kept across versions — the page copy is refreshed in place
const SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';
const PRECACHE = [
  '/', '/firebase-config.js', '/manifest.json', '/icon-192.png', '/apple-touch-icon.png',
  SDK + 'firebase-app.js', SDK + 'firebase-auth.js', SDK + 'firebase-firestore.js'
];

let _isUpdate = false;                       // true when this worker replaces an older one (not the first install)
self.addEventListener('install', (e) => {
  _isUpdate = !!self.registration.active;
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('pm-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(async () => {
      // An open page still running the OLD code (a stale tab / a phone left open) must not keep
      // merging and saving with it: reload the ones nobody is looking at, and tell the visible
      // ones (they show the "גרסה חדשה — רענן" bar) — 2.10: a stale device re-pushed deleted rows.
      if (!_isUpdate) return;
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach(c => { if (c.visibilityState === 'hidden') c.navigate(c.url).catch(() => {}); else c.postMessage({ type: 'pm-update' }); });
    }));
});

function precacheCss(c, html) {
  const m = /\/ui2\.css\?v=[0-9a-z]+/.exec(html || '');
  return m ? c.add(m[0]).catch(() => {}) : Promise.resolve();
}
function put(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.cache === 'no-store') return;
    // The server functions and the customers' order page are never cached.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/order')) return;
    // All app routes are the same single page — but only the page itself:
    // any other path (a future page, a typo) goes to the network untouched.
    const nav = req.mode === 'navigate';
    if (nav && url.pathname !== '/' && url.pathname !== '/index.html') return;
    const key = nav ? '/' : req;
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key, { ignoreSearch: nav });
      // Copy before `hit` is handed to the page — a used body can't be cloned.
      const hitCopy = hit && nav ? hit.clone() : null;
      // A navigate-mode Request can't take options — fetch the page by URL.
      const fresh = (nav ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req)).then(async (res) => {
        if (!res || !res.ok || res.redirected) return res;   // a redirected answer (/index.html → /) can not be served for a navigation, so it is never saved
        if (hitCopy) {
          const [a, b] = await Promise.all([hitCopy.text(), res.clone().text()]);
          if (a !== b) {
            await c.put(key, res.clone());
            await precacheCss(c, b);   // the new page must not outlive its stylesheet: offline, the new HTML would open unstyled

            const wins = await self.clients.matchAll({ type: 'window' });
            wins.forEach(w => w.postMessage({ type: 'pm-update' }));
            return res;
          }
        }
        await c.put(key, res.clone());
        return res;
      });
      // A device that has been away for a while holds an old app AND an old local
      // data copy. Serving the old page first would run the OLD merge code on
      // that old data (2.10: an old copy pushed rows that had been deleted
      // elsewhere back into the cloud). So when the saved page is older than
      // STALE_SHELL_MS, wait briefly for the network and run the NEW code;
      // otherwise (and offline / slow) keep the instant-open behaviour.
      if (hit && nav) {
        const age = Date.now() - (Date.parse(hit.headers.get('date') || '') || 0);
        if (age > STALE_SHELL_MS) {
          const res = await Promise.race([fresh.catch(() => null), new Promise(r => setTimeout(() => r(null), 4000))]);
          if (res && res.ok) return res;
        }
      }
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh.catch(() => (nav ? c.match('/') : undefined)).then(r => r || Response.error());
    }));
    return;
  }

  if (req.url.startsWith(SDK) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => put(req, res)))
    );
  }
});

// ── Push notifications (30.9): a new customer order → Yehuda's phone. ──
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'הודעה חדשה', body: e.data ? e.data.text() : '' }; }
  if (!d || typeof d !== 'object') d = {};
  e.waitUntil(self.registration.showNotification(d.title || 'יהודה קליין אינסטלציה', {
    body: d.body || '', tag: d.tag || 'pm', renotify: true, dir: 'rtl', lang: 'he',
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/#/dashboard' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url = (e.notification.data && e.notification.data.url) || '/#/dashboard';
  try { if (new URL(url, self.location.origin).origin !== self.location.origin) url = '/#/dashboard'; } catch (_) { url = '/#/dashboard'; }   // only our own pages
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(x => new URL(x.url).origin === self.location.origin);
    if (w) { w.focus(); return w.navigate ? w.navigate(url) : null; }
    return self.clients.openWindow(url);
  }));
});
