// Push-Mitteilungen: Anmeldungen speichern und alle 15 Minuten nach neuen Warnungen schauen.
// Speicher: Cloudflare KV (Bindung PUSH). Schlüssel:
//   sub:<hash>          → Push-Anmeldung eines Geräts (JSON, mit Einstellung morning: true/false)
//   seen:<art>:<id>     → diese Meldung wurde schon verschickt (läuft automatisch ab)
// Geheimnis: VAPID_PRIVATE_JWK (mit „wrangler secret put“ gesetzt, nie im Code)

import { buildPushHTTPRequest } from "@pushforge/builder";

const TZ = "Europe/Berlin";
const PAGE = "https://leifkr-source.github.io/schoenbuch-wetter/";
// Nur Anmeldungen von der eigenen Seite (und zum Testen lokal) annehmen
const ORIGINS = ["https://leifkr-source.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];
// Nur echte Push-Dienste von Apple, Google, Mozilla und Microsoft
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

async function hash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pushCors(request) {
  const o = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

// POST /push/subscribe, /push/unsubscribe und /push/prefs (Morgen-Briefing an/aus oder abfragen)
export async function handlePush(request, env, pathname) {
  const cors = pushCors(request);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return reply({ error: "Nur POST" }, 405);
  if (!ORIGINS.includes(request.headers.get("Origin"))) return reply({ error: "Herkunft nicht erlaubt" }, 403);

  let sub;
  try { sub = await request.json(); } catch { return reply({ error: "Ungültige Daten" }, 400); }
  let host;
  try { host = new URL(sub.endpoint).hostname; } catch { return reply({ error: "Ungültige Adresse" }, 400); }
  if (!PUSH_HOSTS.test(host)) return reply({ error: "Unbekannter Push-Dienst" }, 400);
  const key = "sub:" + (await hash(sub.endpoint));

  if (pathname === "/push/unsubscribe") {
    await env.PUSH.delete(key);
    return reply({ ok: true });
  }
  if (pathname === "/push/prefs") {
    const cur = await env.PUSH.get(key, "json");
    if (!cur) return reply({ error: "Nicht angemeldet" }, 404);
    if (typeof sub.morning === "boolean") await env.PUSH.put(key, JSON.stringify({ ...cur, morning: sub.morning }));
    return reply({ morning: typeof sub.morning === "boolean" ? sub.morning : !!cur.morning });
  }
  if (!sub.keys?.p256dh || !sub.keys?.auth) return reply({ error: "Schlüssel fehlen" }, 400);
  const prev = await env.PUSH.get(key, "json");
  await env.PUSH.put(key, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, morning: !!prev?.morning }));
  // Begrüßung, damit man sofort sieht, dass es klappt
  await sendTo(env, key, { endpoint: sub.endpoint, keys: sub.keys }, { title: "Warnungen sind an", body: "Du bekommst eine Mitteilung bei Unwetter, Glätte am Morgen und neuen Sperrungen auf der A81.", tag: "hallo" });
  return reply({ ok: true });
}

async function sendTo(env, key, subscription, message) {
  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK: JSON.parse(env.VAPID_PRIVATE_JWK),
    subscription,
    message: { payload: { ...message, url: PAGE }, adminContact: "https://github.com/leifkr-source/schoenbuch-wetter", options: { ttl: 6 * 3600, urgency: "high", topic: message.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } },
  });
  const r = await fetch(endpoint, { method: "POST", headers, body });
  if (!r.ok) console.log("Push", r.status, await r.text().catch(() => ""));
  // Abgemeldete Geräte aufräumen
  if (r.status === 404 || r.status === 410) await env.PUSH.delete(key);
  return r.ok;
}

async function broadcast(env, message, only = () => true) {
  let cursor, sent = 0;
  do {
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    for (const { name } of page.keys) {
      const sub = await env.PUSH.get(name, "json");
      if (sub && only(sub) && (await sendTo(env, name, { endpoint: sub.endpoint, keys: sub.keys }, message).catch(() => false))) sent++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return sent;
}

// Einmal verschicken: merkt sich die Meldung für ttl Sekunden
async function once(env, id, ttl, message, quiet) {
  const k = "seen:" + id;
  if (await env.PUSH.get(k)) return false;
  await env.PUSH.put(k, "1", { expirationTtl: Math.max(60, Math.round(ttl)) });
  if (!quiet) await broadcast(env, message);
  return !quiet;
}

const fmt = (d, o) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, ...o }).format(new Date(d));
// Stunde über formatToParts, weil „de-DE“ sonst „6 Uhr“ liefert
const localHour = (d = new Date()) => +new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(d)).find((p) => p.type === "hour").value;
const localDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(d));

// Morgen-Briefing: Wetter heute, Glätte, Schönbuchbahn und Anschluss, A81 – in einer Mitteilung
async function morningBriefing({ lat, lon }, loadVerkehr, loadBahn) {
  const today = localDay(Date.now()), yesterday = localDay(Date.now() - 864e5);
  const [wx, bahn, verkehr] = await Promise.allSettled([
    fetch(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${yesterday}&last_date=${today}T23:00&tz=${TZ}`).then((r) => r.json()),
    loadBahn(),
    loadVerkehr(),
  ]);
  const parts = [];
  let title = "Guten Morgen";
  if (wx.status === "fulfilled") {
    const all = wx.value.weather || [];
    const day = (k) => all.filter((x) => localDay(x.timestamp) === k && localHour(x.timestamp) >= 7 && localHour(x.timestamp) <= 21);
    const hrs = day(today), prev = day(yesterday);
    const now = all.find((x) => localDay(x.timestamp) === today && localHour(x.timestamp) === localHour());
    const hi = Math.max(...hrs.map((x) => x.temperature));
    const wet = (x) => (x.precipitation || 0) >= 0.1 || (x.precipitation_probability || 0) >= 60;
    const firstWet = hrs.findIndex(wet);
    let rain;
    if (firstWet === -1) rain = "trocken";
    else if (firstWet === 0) { const dry = hrs.findIndex((x) => !wet(x)); rain = dry === -1 ? "Regen den ganzen Tag" : `Regen bis etwa ${localHour(hrs[dry].timestamp)} Uhr`; }
    else rain = `trocken bis ${localHour(hrs[firstWet].timestamp)} Uhr`;
    if (now) title = `Guten Morgen: ${Math.round(now.temperature)} °C, ${rain}`;
    let line = `Höchstens ${Math.round(hi)} °C`;
    if (prev.length >= 6) {
      const diff = Math.round(hi - Math.max(...prev.map((x) => x.temperature)));
      if (Math.abs(diff) >= 2) line += `, ${Math.abs(diff)} Grad ${diff > 0 ? "wärmer" : "kälter"} als gestern`;
    }
    parts.push(line + ".");
    const morning = all.filter((x) => localDay(x.timestamp) === today && localHour(x.timestamp) >= 5 && localHour(x.timestamp) <= 8);
    if (morning.length && Math.min(...morning.map((x) => x.temperature)) <= 0.5) parts.push("Scheibe kratzen, evtl. glatt.");
  }
  if (bahn.status === "fulfilled") {
    const b = bahn.value, soon = (a) => Date.parse(a.echt || a.plan) < Date.now() + 2 * 36e5;
    const hz = b.abfahrten.filter(soon);
    const bad = hz.filter((a) => a.ausfall || a.verspaetung >= 5).length;
    const s1 = (b.boeblingen?.stuttgart || []).filter((a) => a.ausfall || a.verspaetung >= 5).length;
    let t = hz.some((a) => a.ersatz) ? "Schönbuchbahn: Ersatzbus" : bad ? `Schönbuchbahn: ${bad}× verspätet/Ausfall` : "Schönbuchbahn pünktlich";
    if (s1) t += `, Anschluss Stuttgart verspätet`;
    parts.push(t + ".");
  }
  if (verkehr.status === "fulfilled") {
    const n = (verkehr.value.eintraege || []).filter((x) => x.strasse === "A81" && x.art === "sperrung" && x.km <= 10 && (!x.von || Date.parse(x.von) <= Date.now())).length;
    parts.push(n ? `A81: ${n} Sperrung${n > 1 ? "en" : ""} bei Böblingen.` : "A81 ohne Sperrungen.");
  }
  return { title, body: parts.join(" "), tag: "morgen" };
}

// Zeitgesteuert (Cron), alle 15 Minuten
export { morningBriefing };
export async function checkAndNotify(env, { lat, lon }, loadVerkehr, loadBahn) {
  if (!env.PUSH || !env.VAPID_PRIVATE_JWK) return;
  // Beim allerersten Lauf nur merken, was es schon gibt, damit nicht alte Meldungen auf einmal kommen
  const first = !(await env.PUSH.get("init"));
  const log = [];

  // 1. DWD-Warnungen
  try {
    const r = await fetch(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`);
    const { alerts = [] } = await r.json();
    for (const a of alerts) {
      if (a.severity === "minor" && !/glätte|glatteis|frost/i.test(a.event_de || "")) continue; // leichte Warnungen nur bei Glätte
      const until = a.expires ? fmt(a.expires, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
      const ttl = a.expires ? (Date.parse(a.expires) - Date.now()) / 1000 + 3600 : 86400;
      if (await once(env, "alert:" + (a.alert_id || a.id), ttl, { title: a.headline_de || a.event_de, body: (a.event_de || "") + (until ? ` bis ${until} Uhr` : ""), tag: "alert" + (a.id || "") }, first)) log.push("alert");
    }
  } catch {}

  // 2. Glätte morgen früh (abends zwischen 18 und 21 Uhr prüfen)
  const h = localHour();
  if (h >= 18 && h < 21) {
    try {
      const tomorrow = localDay(Date.now() + 864e5);
      const r = await fetch(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${localDay(Date.now())}T18:00&last_date=${tomorrow}T09:00&tz=${TZ}`);
      const { weather = [] } = await r.json();
      const morning = weather.filter((x) => localDay(x.timestamp) === tomorrow && localHour(x.timestamp) >= 5 && localHour(x.timestamp) <= 8);
      const night = weather.filter((x) => Date.parse(x.timestamp) < Date.parse(morning[0]?.timestamp || 0));
      if (morning.length) {
        const minT = Math.min(...morning.map((x) => x.temperature));
        const wet = night.reduce((s, x) => s + (x.precipitation || 0), 0) >= 0.1;
        if (minT <= 0.5) {
          const msg = wet
            ? { title: `Glättegefahr morgen früh (${Math.round(minT)} °C)`, body: "Nach Niederschlag in der Nacht können Straßen und Scheiben vereist sein. Mehr Zeit einplanen." }
            : { title: `Morgen früh Scheibe kratzen (${Math.round(minT)} °C)`, body: "Plan fünf Minuten extra ein oder leg heute Abend eine Abdeckung auf." };
          if (await once(env, "ice:" + tomorrow, 2 * 86400, { ...msg, tag: "ice" }, false)) log.push("ice");
        }
      }
    } catch {}
  }

  // 3. Neue Sperrungen auf der A81 in der Nähe (bis 10 km), die jetzt gelten oder in den nächsten 24 h beginnen
  try {
    const { eintraege = [] } = await loadVerkehr();
    for (const x of eintraege) {
      if (x.strasse !== "A81" || x.art !== "sperrung" || x.km > 10) continue;
      if (x.von && Date.parse(x.von) > Date.now() + 864e5) continue;
      const when = x.bis ? `bis ${fmt(x.bis, { day: "numeric", month: "short" })}` : "";
      const ttl = x.bis ? (Date.parse(x.bis) - Date.now()) / 1000 + 86400 : 30 * 86400;
      const id = "a81:" + (await hash(x.titel + "|" + x.richtung + "|" + (x.von || "")));
      if (await once(env, id, ttl, { title: `Sperrung ${x.titel}`, body: [x.richtung, when].filter(Boolean).join(", "), tag: "a81" }, first)) log.push("a81");
    }
  } catch {}

  // 4. Morgen-Briefing Mo–Fr um 6:30 Uhr, nur an Geräte, die es eingeschaltet haben
  const wd = fmt(Date.now(), { weekday: "short" });
  const min = +fmt(Date.now(), { minute: "numeric" });
  if (!["Sa", "So"].includes(wd) && h === 6 && min >= 30 && min < 45) {
    try {
      const msg = await morningBriefing({ lat, lon }, loadVerkehr, loadBahn);
      if (!(await env.PUSH.get("seen:morning:" + localDay(Date.now())))) {
        await env.PUSH.put("seen:morning:" + localDay(Date.now()), "1", { expirationTtl: 2 * 86400 });
        await broadcast(env, msg, (s) => s.morning);
        log.push("morning");
      }
    } catch {}
  }

  if (first) await env.PUSH.put("init", new Date().toISOString());
  return log;
}
