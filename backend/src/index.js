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
  // Nur Sperrungen und gesperrte Ab-/Auffahrten: Autobahn GmbH (A81, A8, A831) und MobiData BW (Landes-, Kreis-, Gemeindestraßen)
  "/verkehr": { maxAge: 900, load: loadVerkehr },
  // Meldungen von holzgerlingen.de (nur Überschrift und Link)
  "/stadt": { maxAge: 3600, load: loadStadt },
  // Polizeimeldungen für Holzgerlingen aus dem Presseportal (nur Überschrift und Link)
  "/polizei": { maxAge: 900, load: loadPolizei },
  // Blaulicht-Meldungen aus Holzgerlingen und Umgebung: Polizei, Bundespolizei, Feuerwehr (Titel, kurzer Anriss, Link)
  "/region": { maxAge: 900, load: loadRegion },
  // Schönbuchbahn ab Holzgerlingen und Anschlüsse ab Böblingen, Echtzeit vom VVS (EFA)
  "/bahn": { maxAge: 60, load: loadBahn },
  // Spritpreise der Tankstellen in Holzgerlingen (TankPuls, MTS-K-Daten, CC BY 4.0)
  "/sprit": { maxAge: 300, load: loadSprit },
  // Nächste Müll-Abholungen laut Stadt Holzgerlingen
  "/muell": { maxAge: 3600, load: loadMuell },
  // Luftqualität an der Messstation Gärtringen (Umweltbundesamt)
  "/luft": { maxAge: 1800, load: loadLuft },
  // UV-Index für Stuttgart (DWD), die nächstgelegene Station der Vorhersage
  "/uv": { maxAge: 3600, load: loadUv },
  // Waldbrandgefahrenindex des DWD, Station Stuttgart (Flughafen), die dem Schönbuch nächste in der Tabelle
  "/waldbrand": { maxAge: 10800, load: loadWaldbrand },
  // Veranstaltungskalender der Stadt: nur als PDF veröffentlicht, daher nur der Link zum aktuellen Monat
  "/termine": { maxAge: 21600, load: loadTermine },
};

// Hochzählen, wenn sich das Antwortformat ändert, damit keine alte Antwort aus dem Zwischenspeicher kommt
const CACHE_VERSION = 3;

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
  const m = (lines || []).join(" ").match(/(?:Ende: |bis zum )(\d\d)\.(\d\d)\.(\d\d) (?:um )?(\d\d):(\d\d)/);
  if (!m) return null;
  const end = m[4] === "24" ? "23:59" : `${m[4]}:${m[5]}`; // „24:00 Uhr“ kommt in den Daten vor
  return `20${m[3]}-${m[2]}-${m[1]}T${end}:00`;
}

// „Die Baustelle ist zu folgenden Zeiträumen gültig: 06.11.26 20:00 bis zum 07.11.26 24:00 Uhr.“ → nächstes Zeitfenster
function nextWindow(lines) {
  const iso = (d, mo, y, h, mi) => `20${y}-${mo}-${d}T${h === "24" ? "23:59" : `${h}:${mi}`}:00`;
  const re = /(\d\d)\.(\d\d)\.(\d\d) (\d\d):(\d\d) bis zum (\d\d)\.(\d\d)\.(\d\d) (\d\d):(\d\d)/g;
  for (const m of (lines || []).join(" ").matchAll(re)) {
    const bis = iso(m[6], m[7], m[8], m[9], m[10]);
    if (Date.parse(bis) >= Date.now()) return { von: iso(m[1], m[2], m[3], m[4], m[5]), bis };
  }
  return null;
}

// Autobahn: wirklich gesperrt? Auch die Dienste „closure“ und „roadworks“ enthalten Abschnitte, auf denen noch
// Fahrstreifen frei sind. Gesperrt ist nur, was keinen Pfeil (offenen Fahrstreifen) hat, oder im Titel „Vollsperrung“ nennt.
function fullyClosed(x) {
  const sym = x.impact?.symbols || [];
  return x.isBlocked === "true" || /vollsperr/i.test(x.title || "") || (sym.includes("CLOSED") && !sym.some((t) => t.startsWith("ARROW")));
}

// Abfahrten und Auffahrten verständlich benennen, statt mit dem Namen der Baumaßnahme
function closureLabel(x, info) {
  const sub = (x.subtitle || "").trim(), first = info[0] || "";
  const as = sub.match(/AS (.+?)\s*\((.*)\)/);
  const kind = /^Abfahrt/.test(first) ? "Abfahrt" : /Auffahrt/.test(first) ? "Auffahrt" : /Abfahrt/.test(first) ? "Abfahrt" : "";
  if (kind && as) return { titel: `${kind} ${as[1]} gesperrt`, richtung: as[2] };
  if (kind) return { titel: `${first.replace(/^Von .* nach /, "")} gesperrt`, richtung: "" };
  const between = first.match(/hinter AS (.+?) und (?:[\d.]+ km vor )?(?:AS |AK )?(.+?)(?: nach .*)?$/);
  if (!x.title.includes("|") && between) return { titel: `Zwischen ${between[1]} und ${between[2]} gesperrt`, richtung: sub };
  if (x.title.includes("|")) return { titel: x.title.replace(/\s*\|\s*/, ": "), richtung: sub };
  return { titel: x.title, richtung: sub };
}

/* ---------- Verkehr ---------- */
async function loadVerkehr() {
  const now = Date.now(), soon = now + 3 * 864e5; // nur was jetzt gilt oder in den nächsten 3 Tagen beginnt
  const aktiv = (von, bis) => (!von || Date.parse(von) <= soon) && (!bis || Date.parse(bis) >= now);
  const items = [];

  // Autobahn GmbH des Bundes
  const roads = ["A81", "A8", "A831"];
  const services = ["closure", "roadworks"];
  const results = await Promise.allSettled(
    roads.flatMap((road) => services.map((s) => get(`https://verkehr.autobahn.de/o/autobahn/${road}/services/${s}`).then((d) => d[s] || [])))
  );
  const seenIds = new Set();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const x of r.value) {
      const lat = +x.coordinate?.lat, lon = +x.coordinate?.long;
      if (!(km(lat, lon) <= 15)) continue;
      const win = nextWindow(x.description);
      const von = x.startTimestamp || win?.von || null, bis = win?.bis || parseEnde(x.description);
      if (!aktiv(von, bis)) continue;
      if (!fullyClosed(x)) continue; // nur echte Sperrungen, keine Baustellen mit freien Fahrstreifen
      const info = (x.description || []).filter((l) => l && !/^(Zeitraum|Beginn|Ende|Länge|\(Ende|Die Baustelle)/.test(l) && !/^\d\d\.\d\d\.\d\d /.test(l));
      if (seenIds.has(x.identifier)) continue;
      seenIds.add(x.identifier);
      items.push({
        quelle: "Autobahn",
        strasse: roadOf(x.title),
        art: "sperrung",
        ...closureLabel(x, info),
        info: info[info.length - 1] || "",
        von,
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
      if (x.type !== "ROAD_CLOSED" || !aktiv(x.starttime, x.endtime)) continue;
      const street = x.street && x.street !== "Gemeindestraße" ? x.street : "";
      items.push({
        quelle: "MobiData BW",
        strasse: roadOf(x.street, x.description),
        art: "sperrung",
        titel: (x.description || "Sperrung").replace(/^keine Beschreibung vorhanden\s*/i, ""),
        richtung: street,
        info: "",
        von: x.starttime || null,
        bis: x.endtime || null,
        km: Math.round(km(p.lat, p.lon) * 10) / 10,
        geo: simplify(f.geometry),
      });
    }
  } catch {}

  // Doppelte Einträge (gleicher Titel, z. B. mehrere Bauphasen) zusammenfassen: die früheste zählt; nach Entfernung
  const seen = new Set();
  const list = items
    .sort((a, b) => (a.von || "").localeCompare(b.von || ""))
    .filter((x) => {
      const k = x.titel + "|" + x.richtung;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.km - b.km);
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

/* ---------- Aus der Region (Presseportal / news aktuell) ---------- */
// Nach dem Auftrag „Lokale Meldungen“ (scripts/fetch-news.mjs), hier im Worker statt als GitHub Action
const REGION_FEEDS = [
  // Ortsfeeds des Presseportals (liefern Meldungen aller Dienststellen zu diesem Ort)
  ...["Holzgerlingen", "Böblingen", "Sindelfingen", "Weil im Schönbuch", "Altdorf", "Schönaich", "Waldenbuch", "Ehningen", "Hildrizhausen"]
    .map((o) => `https://www.presseportal.de/rss/polizei/r/${encodeURIComponent(o)}.rss2`),
  "https://www.presseportal.de/rss/dienststelle_116091.rss2", // Bundespolizeiinspektion Stuttgart (Bahnhöfe)
  "https://www.presseportal.de/rss/dienststelle_164917.rss2", // Feuerwehr Böblingen
];
const REGION_PLACES = ["Holzgerlingen", "Altdorf", "Weil im Schönbuch", "Hildrizhausen", "Schönaich", "Waldenbuch", "Ehningen",
  "Böblingen", "Sindelfingen", "Dagersheim", "Darmsheim", "Maichingen", "Magstadt", "Schönbuch"];
const PLACE_RE = new RegExp(`(?<![\\wäöüß])(${REGION_PLACES.join("|")})(?![\\wäöüß])`, "i");
// Nur Dienststellen, die für den Kreis Böblingen zuständig sind (es gibt z. B. mehrere „Altdorf“)
const SENDER = [[/^POL-LB\b/i, "Polizei"], [/^BPOLI S\b/i, "Bundespolizei"], [/^FW[ -]/i, "Feuerwehr"]];

function plain(s = "") {
  return decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function loadRegion() {
  const cutoff = Date.now() - 7 * 864e5, seen = new Set(), items = [];
  const feeds = await Promise.allSettled(REGION_FEEDS.map((u) => get(u, "text")));
  for (const f of feeds) {
    if (f.status !== "fulfilled") continue;
    for (const m of f.value.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
      const tag = (n) => (m[0].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i")) || [])[1] || "";
      const link = plain(tag("link")), raw = plain(tag("title")), date = new Date(plain(tag("pubDate")));
      if (!link || seen.has(link) || isNaN(date) || date < cutoff) continue;
      const sender = SENDER.find(([re]) => re.test(raw));
      if (!sender) continue;
      const title = raw.replace(/^(POL-LB|BPOLI S|FW [^:]+)\s*:\s*/i, "");
      const text = plain(tag("description"));
      const hit = title.match(PLACE_RE) || text.slice(0, 400).match(PLACE_RE);
      if (!hit) continue;
      seen.add(link);
      const place = REGION_PLACES.find((p) => p.toLowerCase() === hit[1].toLowerCase()) || hit[1];
      let teaser = text.replace(/^[^(]*\(ots\)\s*-\s*/i, "").replace(/(Rückfragen bitte an|Original-Content von):[\s\S]*$/i, "").trim();
      if (teaser.length > 160) teaser = teaser.slice(0, teaser.lastIndexOf(" ", 160)) + " …";
      items.push({
        source: sender[1],
        place,
        title: title.replace(new RegExp(`^${place}\\s*[:/-]\\s*`, "i"), ""),
        teaser,
        date: date.toISOString(),
        url: link,
      });
    }
  }
  items.sort((a, b) => b.date.localeCompare(a.date));
  return { updated: new Date().toISOString(), attribution: "Quelle: Presseportal.de / news aktuell – Original-Content der jeweiligen Behörde", items: items.slice(0, 15) };
}

/* ---------- Spritpreise (TankPuls, Lesen ohne Schlüssel; Quellenangabe Pflicht) ---------- */
async function loadSprit() {
  const stationen = new Map();
  await Promise.all(["e10", "diesel"].map(async (fuel) => {
    const d = await get(`https://api.tankpuls.de/api/search/cheapest?minLat=48.61&minLng=8.97&maxLat=48.67&maxLng=9.05&fuel=${fuel}&limit=20`);
    for (const x of d.items || []) {
      if (!/holzgerlingen/i.test(x.city || "")) continue;
      const st = stationen.get(x.id) || { marke: (x.brandName || x.name || "").trim(), strasse: (x.street || "").trim(), e10: null, diesel: null, offen: x.status === "open" };
      st[fuel] = x.priceCents ? x.priceCents / 1000 : null;
      stationen.set(x.id, st);
    }
  }));
  return { stand: new Date().toISOString(), quelle: "MTS-K über tankerkoenig.de, CC BY 4.0 · TankPuls", stationen: [...stationen.values()] };
}

/* ---------- Müllkalender ---------- */
// Abholtermine von holzgerlingen.de: für die ganze Stadt gleich (120- und 240-Liter-Tonnen), keine Adresse nötig
const MONATE = [/^Januar/, /^Februar/, /^M.{0,8}rz/, /^April/, /^Mai/, /^Juni/, /^Juli/, /^August/, /^September/, /^Oktober/, /^November/, /^Dezember/];
const MUELL_ARTEN = [[/^Bio/, "Bioabfall"], [/^Restm/, "Restmüll"], [/^Altpapier/, "Altpapier"], [/^Elektro/, "Elektroschrott"]]; // Wertstoffe bewusst nicht (Leifs Wunsch)

function parseAbholtermine(html, jahr) {
  const start = html.search(/Terminübersicht|Termin.{0,8}bersicht/);
  const tokens = html.slice(start < 0 ? 0 : start).replace(/<(script|style)[\s\S]*?<\/\1>/g, "").split(/<[^>]+>/).map((t) => t.trim()).filter(Boolean);
  const out = [];
  let monat = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (out.length && /^zur.{0,8}ck$/i.test(t)) break;
    const m = MONATE.findIndex((re) => re.test(t) && t.length <= 12);
    if (m >= 0) { monat = m; continue; }
    if (monat >= 0 && /^\d\d$/.test(t)) {
      const art = MUELL_ARTEN.find(([re]) => re.test(tokens[i + 1] || ""));
      if (art) { out.push({ datum: `${jahr}-${String(monat + 1).padStart(2, "0")}-${t}`, art: art[1] }); i++; }
    }
  }
  return out;
}

// Die Seite nennt kein Jahr und ignoriert ?y=, sie zeigt immer ihre aktuelle Liste. Damit nicht im Januar die alten
// Termine als neue gelten: Jahr von Hand hochsetzen, sobald die Stadt die neuen Termine veröffentlicht hat.
const MUELL_JAHR = 2026;
async function loadMuell() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
  if (+today.slice(0, 4) !== MUELL_JAHR) return { eintraege: [] };
  const html = await get("https://www.holzgerlingen.de/de/verwaltung-politik/abfallwirtschaft/abholtermine.php", "text");
  const liste = parseAbholtermine(html, MUELL_JAHR);
  return { quelle: "Stadt Holzgerlingen", eintraege: liste.filter((x) => x.datum >= today).slice(0, 8) };
}

/* ---------- Luftqualität ---------- */
const LUFT_STOFFE = { 1: "Feinstaub (PM10)", 3: "Ozon", 5: "Stickstoffdioxid", 9: "Feinstaub (PM2,5)" };
const LUFT_STUFEN = ["sehr gut", "gut", "mäßig", "schlecht", "sehr schlecht"];
async function loadLuft() {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
  const d = await get(`https://luftdaten.umweltbundesamt.de/api/air-data/v4/airquality/json?date_from=${day}&time_from=1&date_to=${day}&time_to=24&station=313&lang=de`);
  const rows = Object.entries(d.data?.["313"] || {}).filter(([, v]) => v[1] != null);
  if (!rows.length) return { index: null };
  const [zeit, v] = rows[rows.length - 1];
  const stoffe = v.slice(3).filter((c) => Array.isArray(c));
  const worst = stoffe.reduce((a, b) => (b[2] > (a?.[2] ?? -1) ? b : a), null);
  return { stand: zeit, index: v[1], stufe: LUFT_STUFEN[v[1]] || "", stoff: worst ? LUFT_STOFFE[worst[0]] || "" : "", station: "Gärtringen", quelle: "Umweltbundesamt mit Daten der Messnetze der Länder und des Bundes" };
}

/* ---------- UV-Index ---------- */
async function loadUv() {
  const d = await get("https://opendata.dwd.de/climate_environment/health/alerts/uvi.json");
  const c = (d.content || []).find((x) => x.city === "Stuttgart");
  return { heute: c?.forecast?.today ?? null, morgen: c?.forecast?.tomorrow ?? null, stand: d.last_update };
}

/* ---------- Waldbrandgefahr ---------- */
const WBI_STUFEN = ["", "sehr gering", "gering", "mittel", "hoch", "sehr hoch"];
async function loadWaldbrand() {
  const html = await get("https://www.dwd.de/DWD/warnungen/agrar/wbx/wbx_tab_alle_BW.html", "text");
  const row = html.match(/Stuttgart \(Flughafen\)<\/td>([\s\S]*?)<\/tr>/);
  const werte = row ? [...row[1].matchAll(/>(\d)<\/td>/g)].map((m) => +m[1]) : [];
  return { heute: werte[0] ?? null, morgen: werte[1] ?? null, stufe: WBI_STUFEN[werte[0]] || "", station: "Stuttgart (Flughafen)", quelle: "Deutscher Wetterdienst" };
}

/* ---------- Veranstaltungen ---------- */
async function loadTermine() {
  const base = "https://www.holzgerlingen.de", seite = `${base}/de/aktuelles/veranstaltungskalender/`;
  const html = await get(seite, "text");
  const monat = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", month: "long" }).format(new Date());
  const jahr = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date());
  const m = html.match(new RegExp(`href="([^"]*${monat}${jahr}[^"]*\\.pdf)"`, "i"));
  return { monat, pdf: m ? base + m[1] : null, seite };
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
    const key = new Request(new URL(pathname + "?v=" + CACHE_VERSION, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;

    let body;
    try {
      body = await route.load(env);
    } catch (e) {
      return json({ error: "Quelle nicht erreichbar" }, 502);
    }

    const res = json(body, 200, { "Cache-Control": `public, max-age=${route.maxAge}` });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },

  // Alle 15 Minuten: neue Warnungen als Push-Mitteilung verschicken
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env, HOME, loadVerkehr, loadBahn, loadMuell));
  },
};
