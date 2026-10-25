// Schönbuch Wetter – Backend (Cloudflare Worker)
// Holt Daten von Quellen, die keinen direkten Abruf aus dem Browser erlauben (CORS),
// speichert sie kurz zwischen und gibt sie als JSON an die Webseite weiter.

const SOURCES = {
  // DWD Pollenflug-Gefahrenindex, wird einmal täglich gegen 11 Uhr aktualisiert
  "/pollen": {
    url: "https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json",
    maxAge: 3600, // Sekunden im Zwischenspeicher
  },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "Nur GET erlaubt" }, 405);

    const { pathname } = new URL(request.url);
    if (pathname === "/") return json({ name: "Schönbuch Wetter API", endpoints: Object.keys(SOURCES) });

    const src = SOURCES[pathname];
    if (!src) return json({ error: "Unbekannter Pfad" }, 404);

    // Zwischenspeicher pro Pfad (für alle Nutzer gemeinsam)
    const cache = caches.default;
    const key = new Request(new URL(pathname, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;

    let upstream;
    try {
      upstream = await fetch(src.url, { headers: { "User-Agent": "schoenbuch-wetter" } });
    } catch {
      return json({ error: "Quelle nicht erreichbar" }, 502);
    }
    if (!upstream.ok) return json({ error: `Quelle antwortet mit ${upstream.status}` }, 502);

    const res = json(await upstream.text(), 200, { "Cache-Control": `public, max-age=${src.maxAge}` });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};
