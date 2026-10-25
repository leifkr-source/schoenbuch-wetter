// Schönbuch Wetter – Backend (Cloudflare Worker)
// Holt Daten von Quellen, die keinen direkten Abruf aus dem Browser erlauben (CORS)
// oder erst aufbereitet werden müssen, speichert sie kurz zwischen (für alle Nutzer
// gemeinsam) und gibt sie als JSON an die Webseite weiter.

import { handlePush, checkAndNotify } from "./push.js";

const HOME = { lat: 48.6386, lon: 9.0117 }; // Holzgerlingen
const UA = { "User-Agent": "schoenbuch-wetter (https://github.com/leifkr-source/schoenbuch-wetter)" };

const ROUTES = {
  // DWD Pollenflug-Gefahrenindex, wird einmal täglich gegen 11 Uhr aktualisiert
  "/pollen": { maxAge: 3600, load: () => passThrough("https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json") },
  // Baustellen und Sperrungen: Autobahn GmbH (A81, A8, A831) und MobiData BW (Landes-, Kreis-, Gemeindestraßen)
  "/verkehr": { maxAge: 900, load: loadVerkehr },
  // Meldungen von holzgerlingen.de (nur Überschrift und Link)
  "/stadt": { maxAge: 3600, load: loadStadt },
  // Polizeimeldungen für Holzgerlingen aus dem Presseportal (nur Überschrift und Link)
  "/polizei": { maxAge: 900, load: loadPolizei },
  // Schönbuchbahn ab Holzgerlingen und Anschlüsse ab Böblingen, Echtzeit vom VVS (EFA)
  "/bahn": { maxAge: 60, load: loadBahn },
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

async function get(url, type = "json") {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} antwortet mit ${r.status}`);
  return type === "json" ? r.json() : r.text();
}

async function passThrough(url) {
  return get(url, "text");
}

// Entfernung in km (für kleine Abstände genau genug)
function km(lat, lon) {
  const dy = (lat - HOME.lat) * 111.2;
  const dx = (lon - HOME.lon) * 111.2 * Math.cos((HOME.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function firstPoint(geom) {
  let c = geom && geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) ? { lon: +c[0], lat: +c[1] } : null;
}

// Linienverlauf vereinfachen (höchstens 24 Punkte, 4 Nachkommastellen ≈ 10 m) für die Karte
function simplify(geom) {
  if (!geom) return null;
  let line = geom.coordinates;
  if (geom.type === "Point") line = [line];
  else if (geom.type === "MultiLineString" || geom.type === "Polygon") line = line[0];
  else if (geom.type === "MultiPolygon") line = line[0][0];
  if (!Array.isArray(line) || !line.length) return null;
  const step = Math.max(1, Math.ceil(line.length / 24));
  const pts = line.filter((_, i) => i % step === 0 || i === line.length - 1);
  return pts.map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]);
}

// Straßennummer erkennen, z. B. „L1184 Holzgerlingen-Herrenberg“ → „L1184“
function roadOf(...texts) {
  for (const t of texts) {
    const m = String(t || "").match(/\b([ABLK])\s?(\d{1,4})\b/);
    if (m) return m[1] + m[2];
  }
  return "Ortsstraßen";
}

// „Ende: 30.09.27 um 00:00 Uhr“ → ISO-Zeit
function parseEnde(lines) {
  const m = (lines || []).join(" ").match(/Ende: (\d\d)\.(\d\d)\.(\d\d) um (\d\d):(\d\d)/);
  return m ? `20${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00` : null;
}

/* ---------- Verkehr ---------- */
async function loadVerkehr() {
  const now = Date.now(), soon = now + 14 * 864e5;
  const aktiv = (von, bis) => (!von || Date.parse(von) <= soon) && (!bis || Date.parse(bis) >= now);
  const items = [];

  // Autobahn GmbH des Bundes
  const roads = ["A81", "A8", "A831"];
  const services = ["closure", "roadworks", "warning"];
  const results = await Promise.allSettled(
    roads.flatMap((road) => services.map((s) => get(`https://verkehr.autobahn.de/o/autobahn/${road}/services/${s}`).then((d) => d[s] || [])))
  );
  const seenIds = new Set();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const x of r.value) {
      const lat = +x.coordinate?.lat, lon = +x.coordinate?.long;
      if (!(km(lat, lon) <= 15)) continue;
      const bis = parseEnde(x.description);
      if (!aktiv(x.startTimestamp, bis)) continue;
      const art = x.display_type === "WARNING" ? "warnung" : x.display_type === "CLOSURE" || x.isBlocked === "true" ? "sperrung" : "baustelle";
      const info = (x.description || []).filter((l) => l && !/^(Zeitraum|Beginn|Ende|Länge|\(Ende|Die Baustelle)/.test(l) && !/^\d\d\.\d\d\.\d\d /.test(l));
      if (seenIds.has(x.identifier)) continue;
      seenIds.add(x.identifier);
      items.push({
        quelle: "Autobahn",
        strasse: roadOf(x.title),
        art,
        titel: x.title.replace(/\s*\|\s*/, ": "),
        richtung: (x.subtitle || "").trim(),
        info: info[info.length - 1] || "",
        von: x.startTimestamp || null,
        bis,
        km: Math.round(km(lat, lon) * 10) / 10,
        geo: simplify(x.geometry) || [[lon, lat]],
      });
    }
  }

  // MobiData BW (Lizenz: Datenlizenz Deutschland – Namensnennung 2.0)
  try {
    const d = await get("https://api.mobidata-bw.de/datasets/traffic/roadworks/roadworks_geojson.json");
    for (const f of d.features || []) {
      const p = firstPoint(f.geometry);
      if (!p || !(km(p.lat, p.lon) <= 8)) continue;
      const x = f.properties || {};
      if (!aktiv(x.starttime, x.endtime)) continue;
      const street = x.street && x.street !== "Gemeindestraße" ? x.street : "";
      items.push({
        quelle: "MobiData BW",
        strasse: roadOf(x.street, x.description),
        art: x.type === "ROAD_CLOSED" ? "sperrung" : "baustelle",
        titel: (x.description || "Baustelle").replace(/^keine Beschreibung vorhanden\s*/i, ""),
        richtung: street,
        info: "",
        von: x.starttime || null,
        bis: x.endtime || null,
        km: Math.round(km(p.lat, p.lon) * 10) / 10,
        geo: simplify(f.geometry),
      });
    }
  } catch {}

  // Doppelte Einträge (gleicher Titel) zusammenfassen, Sperrungen zuerst, dann nach Entfernung
  const seen = new Set();
  const order = { sperrung: 0, warnung: 1, baustelle: 2 };
  const list = items
    .sort((a, b) => order[a.art] - order[b.art] || a.km - b.km)
    .filter((x) => {
      const k = x.titel + "|" + x.richtung;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  return { stand: new Date().toISOString(), quellen: ["Autobahn GmbH des Bundes", "Verkehrsministerium BW / MobiData BW (dl-de/by-2-0)"], eintraege: list };
}

/* ---------- Stadt Holzgerlingen ---------- */
async function loadStadt() {
  const base = "https://www.holzgerlingen.de";
  const html = await get(`${base}/de/index.php`, "text");
  const re = /wOpenURL\('(\/de\/aktuelles\/meldungen\/[^']+)'[\s\S]*?class="listEntryTitle"><a [^>]*>([^<]+)<\/a>/g;
  const seen = new Set(), list = [];
  for (const m of html.matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    list.push({ titel: decode(m[2]).trim(), link: base + m[1] });
  }
  return { stand: new Date().toISOString(), quelle: "Stadt Holzgerlingen", eintraege: list.slice(0, 8) };
}

/* ---------- Polizei (Presseportal) ---------- */
async function loadPolizei() {
  const xml = await get("https://www.presseportal.de/rss/polizei/r/Holzgerlingen.rss2", "text");
  const list = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => (m[1].match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || "";
    list.push({
      titel: decode(tag("title")).replace(/^POL-LB:\s*/, "").trim(),
      link: tag("link").trim(),
      datum: tag("pubDate") ? new Date(tag("pubDate")).toISOString() : null,
    });
  }
  return { stand: new Date().toISOString(), quelle: "Polizeipräsidium Ludwigsburg via presseportal.de", eintraege: list.slice(0, 6) };
}

/* ---------- Schönbuchbahn und Anschlüsse in Böblingen (VVS) ---------- */
async function departures(stop, keep, limit = 40) {
  const d = await get(`https://www3.vvs.de/mngvvs/XML_DM_REQUEST?outputFormat=rapidJSON&type_dm=any&name_dm=${stop}&mode=direct&useRealtime=1&limitDeparture=${limit}&SpEncId=0`);
  const now = Date.now();
  const abfahrten = [], infos = new Map();
  for (const e of d.stopEvents || []) {
    const t = e.transportation || {};
    if (!keep(t)) continue;
    const plan = e.departureTimePlanned, est = e.departureTimeEstimated || null;
    if (Date.parse(est || plan) < now - 60e3) continue;
    abfahrten.push({
      linie: t.number,
      ersatz: /SEV|Bus/i.test(t.product?.name || "") || /^R46E$/.test(t.number || ""),
      ziel: (t.destination?.name || "").replace(/\s+(Bf|Bahnhof|ZOB|Hauptbahnhof)$/, "").replace(/\s*\(.*\)$/, ""),
      plan,
      echt: est,
      verspaetung: est ? Math.round((Date.parse(est) - Date.parse(plan)) / 60e3) : null,
      ausfall: !!e.isCancelled || (e.realtimeStatus || []).includes("TRIP_CANCELLED"),
      gleis: e.location?.properties?.platform || "",
    });
    for (const i of e.infos || []) {
      const l = i.infoLinks?.[0];
      if (l && !infos.has(i.id)) infos.set(i.id, { titel: l.subtitle || l.urlText || l.title, text: (l.content || "").trim() });
    }
  }
  return { abfahrten, hinweise: [...infos.values()] };
}

// Richtung Herrenberg/Gäubahn-Süd, sonst Richtung Stuttgart
const SUED = /Herrenberg|Horb|Hochdorf|Rottweil|Singen|Tuttlingen|Freudenstadt|Eutingen|Gärtringen|Nufringen|Ehningen/;

async function loadBahn() {
  const [hz, bb] = await Promise.all([
    // Holzgerlingen Bahnhof: Schönbuchbahn (RB46) und ihr Ersatzverkehr (R46E)
    departures("de:08115:4193", (t) => /^(RB)?46|^R46/.test(t.number || "")),
    // Böblingen Bahnhof: S1 und Regionalzüge (RE/RB), ohne S60 und Fernverkehr
    departures("de:08115:7100", (t) => t.number === "S1" || /^R[BE]\d/.test(t.number || ""), 60).catch(() => null),
  ]);
  const anschluss = bb && {
    stuttgart: bb.abfahrten.filter((a) => !SUED.test(a.ziel)).slice(0, 4),
    herrenberg: bb.abfahrten.filter((a) => SUED.test(a.ziel)).slice(0, 4),
    hinweise: bb.hinweise.filter((h) => /S1|RE|RB|Gäubahn|Böblingen/i.test(h.titel)).slice(0, 2),
  };
  return { stand: new Date().toISOString(), quelle: "VVS", abfahrten: hz.abfahrten.slice(0, 12), hinweise: hz.hinweise.slice(0, 3), boeblingen: anschluss };
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/push/")) return handlePush(request, env, pathname);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "Nur GET erlaubt" }, 405);

    if (pathname === "/") return json({ name: "Schönbuch Wetter API", endpoints: Object.keys(ROUTES) });

    const route = ROUTES[pathname];
    if (!route) return json({ error: "Unbekannter Pfad" }, 404);

    // Zwischenspeicher pro Pfad (für alle Nutzer gemeinsam)
    const cache = caches.default;
    const key = new Request(new URL(pathname, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;

    let body;
    try {
      body = await route.load();
    } catch (e) {
      return json({ error: "Quelle nicht erreichbar" }, 502);
    }

    const res = json(body, 200, { "Cache-Control": `public, max-age=${route.maxAge}` });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },

  // Alle 15 Minuten: neue Warnungen als Push-Mitteilung verschicken
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env, HOME, loadVerkehr, loadBahn));
  },
};
