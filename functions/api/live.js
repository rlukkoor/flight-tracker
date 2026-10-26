// Cloudflare Pages Function: GET /api/live?lat=..&lon=..&r=..
// Fallback for the zoomed in live feed when the browser can't reach the
// providers directly. Tries adsb.fi, airplanes.live, then adsb.lol, and
// returns { now, ac, src } with ADSBexchange v2 style aircraft records.

const SOURCES = [
  ["adsb.fi", (la, lo, r) => `https://opendata.adsb.fi/api/v3/lat/${la}/lon/${lo}/dist/${r}`],
  ["airplanes.live", (la, lo, r) => `https://api.airplanes.live/v2/point/${la}/${lo}/${r}`],
  ["adsb.lol", (la, lo, r) => `https://api.adsb.lol/v2/point/${la}/${lo}/${r}`],
];

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const la = Number(u.searchParams.get("lat")), lo = Number(u.searchParams.get("lon"));
  const r = Math.max(5, Math.min(250, Math.round(Number(u.searchParams.get("r")) || 100)));
  if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    return new Response('{"error":"bad position"}', { status: 400, headers: { "content-type": "application/json" } });
  }
  // Round so nearby viewers share a cached answer for a few seconds.
  const LA = la.toFixed(1), LO = lo.toFixed(1);

  let cache = null, key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/live?${LA},${LO},${r}`, u).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}

  const errors = [];
  for (const [name, url] of SOURCES) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch(url(LA, LO, r), { headers: { accept: "application/json" }, signal: ac.signal });
      if (!res.ok) { errors.push(`${name} ${res.status}`); continue; }
      const d = await res.json();
      const out = new Response(JSON.stringify({ now: d.now || Date.now(), ac: d.ac || d.aircraft || [], src: name }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=4" },
      });
      if (cache) context.waitUntil(cache.put(key, out.clone()).catch(() => {}));
      return out;
    } catch (e) {
      errors.push(`${name} ${e.name === "AbortError" ? "timeout" : "error"}`);
    } finally {
      clearTimeout(to);
    }
  }
  return new Response(JSON.stringify({ error: errors.join(", ") }), { status: 502, headers: { "content-type": "application/json" } });
}
