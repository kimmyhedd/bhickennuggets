// Version-aware caching service worker (self-contained logic)
// Behavior:
// - Always fetch /version.txt with no-cache
// - If new version differs: purge old caches, pre-cache new, notify clients to reload
// - If same version: serve from versioned cache (cache-first)
// - If offline (version fetch fails): keep serving cached assets

const CACHE_PREFIX = 'slopeplusweb-cache-v';
const VERSION_FILE = '/version.txt';
// Core assets to pre-cache (add build + patches + templatedata)
const PRECACHE_PATHS = [
  '/index.html',
  '/style.css',
  // Build
  '/Build/SlopePlusWeb.asm.code.unityweb',
  '/Build/SlopePlusWeb.asm.framework.unityweb',
  '/Build/SlopePlusWeb.asm.memory.unityweb',
  '/Build/SlopePlusWeb.data.unityweb',
  '/Build/SlopePlusWeb.json',
  '/Build/SlopePlusWeb.wasm.code.unityweb',
  '/Build/SlopePlusWeb.wasm.framework.unityweb',
  '/Build/UnityLoader.js',
  // Patches
  '/Patches/mobile.js',
  '/Patches/settings.js',
  '/Patches/freezegame.js',
  // TemplateData
  '/TemplateData/style.css',
  '/TemplateData/UnityProgress.js',
  '/TemplateData/favicon.ico',
  '/TemplateData/fullscreen.png',
  '/TemplateData/progressEmpty.Dark.png',
  '/TemplateData/progressFull.Dark.png',
  '/TemplateData/progressLogo.Dark.png',
  '/TemplateData/webgl-logo.png'
];

let currentVersion = null;           // Version this SW is serving
let hasCheckedVersion = false;       // Avoid repeated checks per navigation cycle
let handlingMismatch = false;        // Prevent duplicate reload notifications

async function fetchVersion() {
  try {
    const res = await fetch(VERSION_FILE, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Non-OK version response');
    const txt = (await res.text()).trim();
    return txt;
  } catch (e) {
    console.warn('[SW] Version fetch failed (offline?):', e);
    return null; // Unknown (offline)
  }
}

async function openVersionCache(version) {
  return caches.open(CACHE_PREFIX + version);
}

async function precache(version) {
  const cache = await openVersionCache(version);
  for (const path of PRECACHE_PATHS) {
    try {
      await cache.add(path);
    } catch (e) {
      console.warn('[SW] Failed to cache', path, e);
    }
  }
}

async function cleanupOldCaches(keepVersion) {
  const names = await caches.keys();
  await Promise.all(
    names.filter(n => n.startsWith(CACHE_PREFIX) && !n.endsWith(keepVersion))
         .map(n => caches.delete(n))
  );
}

async function ensureVersionChecked() {
  if (hasCheckedVersion) return { status: 'cached' };
  hasCheckedVersion = true;
  const newVersion = await fetchVersion();
  if (newVersion === null) {
    // Offline / unknown -> keep serving whatever we have
    return { status: 'unknown' };
  }
  if (!currentVersion) {
    // First install / activation path: set & possibly precache (if not already)
    currentVersion = newVersion;
    // If cache missing, precache
    const existing = await caches.open(CACHE_PREFIX + currentVersion);
    // Quick heuristic: test one core file
    const testResp = await existing.match('/index.html');
    if (!testResp) await precache(currentVersion);
    return { status: 'same' };
  }
  if (newVersion !== currentVersion) {
    // Version mismatch
    await cleanupOldCaches(newVersion); // Remove old first (safe if new fails later)
    await precache(newVersion);
    currentVersion = newVersion;
    notifyClientsVersionUpdate();
    return { status: 'different' };
  }
  return { status: 'same' };
}

async function notifyClientsVersionUpdate() {
  if (handlingMismatch) return;
  handlingMismatch = true;
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clientsList) {
    c.postMessage({ type: 'VERSION_UPDATE' });
  }
}

// Install: fetch version & pre-cache
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const version = await fetchVersion();
    if (version) {
      currentVersion = version;
      await precache(version);
    }
    self.skipWaiting();
  })());
});

// Activate: cleanup old caches
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (currentVersion) await cleanupOldCaches(currentVersion);
    await self.clients.claim();
  })());
});

// Fetch strategy
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Force a re-check if developer appends ?vcheck
  if (url.searchParams.has('vcheck')) {
    hasCheckedVersion = false;
  }

  // Always network (no-cache) for version.txt so it appears in Network panel
  if (url.pathname === VERSION_FILE) {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(event.request, { cache: 'no-cache' });
          return resp;
        } catch {
          return new Response(currentVersion || '', { status: 200 });
        }
      })()
    );
    return;
  }

  event.respondWith((async () => {
    // Ensure version check once per SW lifetime (not only navigations) so version.txt fetch is visible
    if (!hasCheckedVersion) {
      await ensureVersionChecked();
    }

    // Serve from version cache if available
    if (currentVersion) {
      const cache = await caches.open(CACHE_PREFIX + currentVersion);
      const cached = await cache.match(event.request);
      if (cached) return cached;
    }

    // Network fallback
    try {
      const net = await fetch(event.request);
      if (net.ok && currentVersion && PRECACHE_PATHS.some(p => event.request.url.endsWith(p))) {
        const cache = await caches.open(CACHE_PREFIX + currentVersion);
        cache.put(event.request, net.clone());
      }
      return net;
    } catch (e) {
      // Offline fallback search any version cache
      const names = await caches.keys();
      for (const n of names) {
        if (!n.startsWith(CACHE_PREFIX)) continue;
        const cache = await caches.open(n);
        const match = await cache.match(event.request);
        if (match) return match;
      }
      throw e;
    }
  })());
});

// Message API (optional future extension)
self.addEventListener('message', evt => {
  if (!evt.data) return;
  if (evt.data.type === 'FORCE_VERSION_CHECK') {
    hasCheckedVersion = false;
    ensureVersionChecked();
  }
});