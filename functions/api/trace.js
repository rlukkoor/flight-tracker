// Cloudflare Pages Function: GET /api/trace?hex=a1b2c3
// The aircraft's full track for today from the volunteer ADS-B networks' public
// history files (tar1090/readsb "trace_full" files), trimmed to the current
// flight. Free, and usually covers the whole flight where receivers exist.
// Returns { src, points: [[epochSeconds, lat, lon], ...] }.

const SOURCES = [
  ["adsb.lol", "https://globe.adsb.lol"],
  ["airplanes.live", "https://globe.airplanes.live"],
  ["adsb.fi", "https://globe.adsb.fi"],
];

function json(obj, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}

// Trace files are gzip compressed. Most servers say so in a header (and fetch
// unpacks them); some don't, so check for the gzip magic bytes too.
async function readJson(res) {
  const buf = new Uint8Array(await res.arrayBuffer());
  let bytes = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip")));
    bytes = new Uint8Array(await ds.arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Keep only the current flight: everything after the last time the aircraft
// was on the ground, or after the last "new leg" marker (flag bit 2).
function currentFlight(d) {
  const t0 = Number(d.timestamp) || 0, tr = Array.isArray(d.trace) ? d.trace : [];
  let start = 0;
  for (let i = 0; i < tr.length; i++) {
    const e = tr[i];
    if (e[3] === "ground" && tr[i + 1] && tr[i + 1][3] !== "ground") start = i;
    if (typeof e[6] === "number" && e[6] & 2) start = i;
  }
  const out = [];
  for (let i = start; i < tr.length; i++) {
    const e = tr[i];
    if (typeof e[1] !== "number" || typeof e[2] !== "number") continue;
    out.push([Math.round(t0 + e[0]), Math.round(e[1] * 1e4) / 1e4, Math.round(e[2] * 1e4) / 1e4]);
  }
  // Thin to at most one point every 20 seconds; that's plenty for a map line.
  const thin = [];
  for (const p of out) if (!thin.length || p[0] - thin[thin.length - 1][0] >= 20) thin.push(p);
  return thin;
}

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const hex = (u.searchParams.get("hex") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  if (hex.length !== 6) return json({ error: "hex required" });

  let cache = null, key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/trace?hex=${hex}`, u).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}

  const errors = [];
  for (const [name, base] of SOURCES) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 7000);
    try {
      const r = await fetch(`${base}/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`, {
        headers: { accept: "application/json", referer: `${base}/` },
        signal: ac.signal,
      });
      if (r.status === 404) { errors.push(`${name} has no track today`); continue; }
      if (!r.ok) { errors.push(`${name} ${r.status}`); continue; }
      const points = currentFlight(await readJson(r));
      if (!points.length) { errors.push(`${name} empty`); continue; }
      const res = json({ src: name, points }, 120);
      if (cache) context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
      return res;
    } catch (e) {
      errors.push(`${name} ${e.name === "AbortError" ? "timeout" : "error"}`);
    } finally {
      clearTimeout(to);
    }
  }
  return json({ points: [], error: errors.join(", ") }, 60);
}
