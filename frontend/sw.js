// sw.js — McLarens Nexus Enterprise v5.0
// PWA Service Worker: offline cache + IndexedDB queue + background sync + push
// v6 — FIXES: cache version bump forces old broken SW replacement,
//      guaranteed Response returns, cross-origin skip, redirect:follow

const CACHE  = 'nexus-v8';  // bumped: fixes Response.clone() + redirected response errors
const STATIC = [
  '/index.html',
  '/surveyor-dashboard.html',
  '/hrms-dashboard.html',
  '/manifest.json'
];

// ── Install ───────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => {
        // Use allSettled so one missing file doesn't abort the entire install
        return Promise.allSettled(
          STATIC.map(url =>
            fetch(url, { redirect: 'follow' })
              .then(r => { if (r && r.ok) return c.put(url, r); })
              .catch(() => { /* silently skip unavailable files */ })
          )
        );
      })
      // NOTE: skipWaiting() removed from install. It caused controllerchange
      // → window.location.reload() to fire from chrome-error:// pages.
      // SKIP_WAITING is now sent explicitly from the page only when safe.
  );
});

// ── Activate ──────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(async () => {
        // FIX: Only claim clients on genuine first install (no existing controller).
        // If we always claim(), it fires controllerchange on every SW update,
        // which the dashboard catches and calls window.location.reload() → loop.
        // On updates, the page will pick up the new SW naturally on next navigation.
        const clients = await self.clients.matchAll({ type: 'window' });
        const hasController = clients.some(c => c.url && c.url.length > 0);
        if (!hasController || !self.registration.active) {
          return self.clients.claim();
        }
      })
  );
});

// ── Fetch strategy ────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // SAFETY: never intercept chrome-error://, chrome-extension:// or non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // Skip cross-origin entirely — Google Fonts, CDNs, Cloudflare Workers API
  if (url.origin !== self.location.origin) return;

  // CRITICAL FIX: never intercept HTML document navigation requests.
  // When Cloudflare redirects (e.g. HTTP→HTTPS, trailing slash), the SW was
  // returning the redirected response to the browser, which rejects it because
  // the original navigation request didn't set redirect:'follow'.
  // Letting the browser handle navigations natively avoids this entirely.
  if (e.request.mode === 'navigate') return;

  // Non-GET requests: always go to network, never cache
  if (e.request.method !== 'GET') {
    e.respondWith(
      fetch(e.request, { redirect: 'follow' })
        .catch(() => new Response(
          JSON.stringify({ offline: true, error: 'Network unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // API routes: network-first, queue writes for background sync when offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone(), { redirect: 'follow' })
        .catch(async () => {
          try {
            const body = await e.request.clone().text();
            await queueForSync({
              url:     e.request.url,
              method:  e.request.method,
              headers: Object.fromEntries(e.request.headers),
              body
            });
            await notifyClients({ type: 'OFFLINE_QUEUED', url: e.request.url });
          } catch { /* ignore queueing errors */ }
          return new Response(
            JSON.stringify({ offline: true, queued: true }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // Same-origin static assets: cache-first, network fallback
  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) return cached;

        return fetch(e.request, { redirect: 'follow' })
          .then(r => {
            // FIX: clone BEFORE any consumption. Only cache basic (non-opaque,
            // non-redirected) responses. Never try to clone a redirected response —
            // its body may already be consumed, causing "body is already used".
            if (r && r.ok && r.type === 'basic' && !r.redirected) {
              const toCache = r.clone();
              caches.open(CACHE).then(c => c.put(e.request, toCache));
            }
            return r;
          })
          .catch(async () => {
            // Offline fallback — serve cached page if available
            if (e.request.destination === 'document') {
              const fallback = await caches.match('/index.html');
              if (fallback) return fallback;
              // Last resort: return a minimal offline page
              // This prevents the "Failed to convert value to Response" error
              return new Response(
                '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AB Nexus — Offline</title>' +
                '<meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<style>body{font-family:sans-serif;background:#0a0c0f;color:#e8eaf0;display:flex;' +
                'align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}' +
                'h2{color:#e8a020}p{color:#8892aa;font-size:14px}' +
                'button{margin-top:20px;padding:10px 24px;background:rgba(232,160,32,0.15);' +
                'border:1px solid rgba(232,160,32,0.3);border-radius:8px;color:#e8a020;' +
                'font-size:14px;cursor:pointer}</style></head>' +
                '<body><div><h2>⛯ AB Nexus</h2>' +
                '<p>You\'re offline. Please check your connection.</p>' +
                '<button onclick="location.reload()">Try Again</button></div></body></html>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
              );
            }
            // Non-document offline: return empty 503 (never undefined)
            return new Response('', { status: 503 });
          });
      })
  );
});

// ── Background Sync ───────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'nexus-offline-sync') {
    e.waitUntil(replayQueue());
  }
});

// ── Push Notifications ────────────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'McLarens Nexus', {
      body:    data.body  || 'You have a pending action.',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     data.tag   || 'nexus-notif',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/surveyor-dashboard.html' },
      actions: [
        { action: 'open',    title: 'Open App' },
        { action: 'dismiss', title: 'Dismiss'  }
      ]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = e.notification.data?.url || '/surveyor-dashboard.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(
          c => c.url.includes('surveyor-dashboard') && 'focus' in c
        );
        if (existing) { existing.navigate(url); return existing.focus(); }
        return self.clients.openWindow(url);
      })
  );
});

// ── Message from page → SW ────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'SYNC_NOW')     replayQueue();
});

// ── IndexedDB helpers ────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('nexus-offline-v6', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains('claims_cache')) {
        db.createObjectStore('claims_cache', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}

async function queueForSync({ url, method, headers, body }) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('queue', 'readwrite');
    const req = tx.objectStore('queue').add({
      url, method, headers, body,
      ts: Date.now(), retries: 0
    });
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function replayQueue() {
  const db  = await openDB();
  const all = await new Promise(res => {
    const tx  = db.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => res([]);
  });

  for (const item of all) {
    try {
      const response = await fetch(item.url, {
        method:   item.method,
        headers:  item.headers,
        body:     item.body || undefined,
        redirect: 'follow'
      });
      if (response.ok || response.status === 201 || response.status === 202) {
        const delTx = db.transaction('queue', 'readwrite');
        delTx.objectStore('queue').delete(item.id);
        await notifyClients({ type: 'SYNC_SUCCESS', url: item.url, method: item.method });
      } else if ((item.retries || 0) < 3) {
        const updTx = db.transaction('queue', 'readwrite');
        updTx.objectStore('queue').put({ ...item, retries: (item.retries || 0) + 1 });
      } else {
        const delTx = db.transaction('queue', 'readwrite');
        delTx.objectStore('queue').delete(item.id);
        await notifyClients({ type: 'SYNC_FAILED', url: item.url });
      }
    } catch { /* Network still offline — retry on next sync */ }
  }

  await notifyClients({ type: 'SYNC_COMPLETE', replayed: all.length });
}

async function notifyClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(client => client.postMessage(data));
}