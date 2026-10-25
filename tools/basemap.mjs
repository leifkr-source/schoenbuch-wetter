// Baut die Hintergrundkarte (basemap.json) aus OpenStreetMap-Daten.
// Wird nur selten von Hand ausgeführt, die Webseite selbst lädt nichts von OpenStreetMap.
//
//   node tools/basemap.mjs            → lädt die Daten über die Overpass-API und schreibt basemap.json
//   node tools/basemap.mjs <ordner>   → nimmt roads.json, forest.json, places.json aus <ordner>
//
// Daten © OpenStreetMap-Mitwirkende, Lizenz ODbL (Hinweis steht auf der Seite).

import { readFile, writeFile } from "node:fs/promises";

const LAT = 48.6386, LON = 9.0117;          // Holzgerlingen
const BBOX = "48.45,8.74,48.82,9.28";       // etwa 40 × 40 km
const KX = 111.32 * Math.cos((LAT * Math.PI) / 180), KY = 111.32;

const QUERIES = {
  roads: `[out:json][timeout:180];(way["highway"~"^(motorway|trunk|primary|secondary)$"](${BBOX});way["railway"="rail"](${BBOX}););out geom;`,
  forest: `[out:json][timeout:180];(way["landuse"="forest"](${BBOX});way["natural"="wood"](${BBOX});relation["landuse"="forest"](${BBOX});relation["natural"="wood"](${BBOX}););out geom;`,
  places: `[out:json];node["place"~"^(town|village|city)$"](${BBOX});out;`,
};

async function load(name, dir) {
  if (dir) return JSON.parse(await readFile(`${dir}/${name}.json`, "utf8"));
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "User-Agent": "schoenbuch-wetter basemap build" },
    body: new URLSearchParams({ data: QUERIES[name] }),
  });
  if (!r.ok) throw new Error(`Overpass ${name}: ${r.status}`);
  return r.json();
}

// Längen-/Breitengrad → km relativ zu Holzgerlingen (x nach Osten, y nach Norden)
const toKm = ({ lat, lon }) => [(lon - LON) * KX, (lat - LAT) * KY];

// Douglas-Peucker-Vereinfachung
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const round = (pts) => pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);

function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s / 2);
}

const dir = process.argv[2];
const [roads, forest, places] = await Promise.all(["roads", "forest", "places"].map((n) => load(n, dir)));

const out = { center: [LAT, LON], unit: "km", roads: { motorway: [], trunk: [], primary: [], secondary: [], rail: [] }, forest: [], places: [] };


// Äußere Teilstücke einer Relation zu geschlossenen Ringen zusammensetzen
function joinRings(parts) {
  const key = (p) => p.lat.toFixed(7) + "," + p.lon.toFixed(7);
  const open = parts.map((p) => p.slice()), done = [];
  while (open.length) {
    let ring = open.shift();
    let grown = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i], end = key(ring[ring.length - 1]);
        if (key(w[0]) === end) ring = ring.concat(w.slice(1));
        else if (key(w[w.length - 1]) === end) ring = ring.concat(w.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1); grown = true; break;
      }
    }
    done.push(ring);
  }
  return done;
}

// Straßenstücke gleicher Klasse zu langen Linien verbinden, dann vereinfachen
const byClass = {};
for (const e of roads.elements) {
  if (!e.geometry) continue;
  const cls = e.tags.railway === "rail" ? "rail" : e.tags.highway;
  (byClass[cls] ||= []).push(e.geometry);
}
for (const [cls, parts] of Object.entries(byClass)) {
  // zweimal verbinden: einmal vorwärts, einmal mit umgedrehten Linien (verlängert auch am Anfang)
  const merged = joinRings(joinRings(parts).map((l) => l.slice().reverse()));
  for (const l of merged) {
    const line = round(simplify(l.map(toKm), cls === "secondary" ? 0.1 : 0.06));
    if (line.length > 1) out.roads[cls].push(line);
  }
}

const rings = [];
for (const e of forest.elements) {
  if (e.type === "way" && e.geometry) rings.push(e.geometry.map(toKm));
  if (e.type === "relation") {
    const outer = (e.members || []).filter((m) => m.role === "outer" && m.geometry).map((m) => m.geometry);
    for (const r of joinRings(outer)) rings.push(r.map(toKm));
  }
}
for (const r of rings) {
  if (area(r) < 0.15) continue; // kleine Waldstücke weglassen
  // Geschlossene Ringe in zwei Hälften vereinfachen (Anfang = Ende würde sonst alles wegkürzen)
  const mid = Math.floor(r.length / 2);
  const s = round(simplify(r.slice(0, mid + 1), 0.08).concat(simplify(r.slice(mid), 0.08).slice(1)));
  if (s.length > 3) out.forest.push(s);
}

for (const e of places.elements) {
  const [x, y] = toKm(e);
  const rank = e.tags.place === "city" ? 3 : e.tags.place === "town" ? 2 : 1;
  out.places.push([e.tags.name, Math.round(x * 100) / 100, Math.round(y * 100) / 100, rank]);
}

const json = JSON.stringify(out);
await writeFile(new URL("../basemap.json", import.meta.url), json);
const count = (o) => Object.values(o).reduce((s, l) => s + l.reduce((t, p) => t + p.length, 0), 0);
console.log(`basemap.json: ${(json.length / 1024).toFixed(0)} KB, Straßenpunkte ${count(out.roads)}, Waldflächen ${out.forest.length}, Orte ${out.places.length}`);
