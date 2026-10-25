// Service Worker: nur für Push-Mitteilungen, kein Zwischenspeichern der Seite
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
