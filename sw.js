// Service Worker: Push-Mitteilungen und schneller Start / offline
// Strategie:
//  - Seite und Daten: erst das Netz fragen (max. 3 s), sonst die letzte gespeicherte Version
//  - Kartendaten und Icons: sofort aus dem Speicher, im Hintergrund auffrischen
const CACHE = "schoenbuch-v1";
const SHELL = ["./", "index.html", "basemap.json", "manifest.json", "apple-touch-icon.png", "icon.svg"];
const DATA_HOSTS = ["api.brightsky.dev", "api.schoenbuchwetter.workers.dev"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(req, timeout = 3000) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (/\.(json|png|svg)$/.test(url.pathname) && !url.pathname.endsWith("manifest.json")) e.respondWith(staleWhileRevalidate(req));
    else e.respondWith(networkFirst(req));
  } else if (DATA_HOSTS.includes(url.hostname)) {
    e.respondWith(networkFirst(req, 4000));
  }
});

// Push-Mitteilungen
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Schönbuch Wetter", {
    body: d.body || "",
    tag: d.tag,               // gleiche Warnung ersetzt die alte statt sie zu stapeln
    icon: "apple-touch-icon.png",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(self.registration.scope)) { c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
