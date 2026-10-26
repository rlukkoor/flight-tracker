// Cloudflare Pages Function: GET /api/lookup?cs=UAL123&hex=a1b2c3
// Looks up the flight route (by callsign) and aircraft details (by ICAO hex)
// from adsbdb.com, and caches the answer at the edge for 6 hours.
// Returns raw adsbdb responses: { route, aircraft }. The page normalizes them.

const ADSBDB = "https://api.adsbdb.com/v0/";

async function get(path) {
  try {
    const r = await fetch(ADSBDB + path, { headers: { accept: "application/json" } });
    return await r.json();
  } catch {
    return null;
  }
}

// GET /api/lookup?reg=9V-SMA  ->  { hex }  (aircraft registration to transponder code)
async function regToHex(reg) {
  let hex = null;
  const a = await get("aircraft/" + reg);
  const m = a?.response?.aircraft?.mode_s;
  if (m && /^[0-9a-f]{6}$/i.test(m)) hex = m.toLowerCase();
  if (!hex) {
    try {
      const r = await fetch(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(reg)}`);
      const t = (await r.text()).trim();
      if (/^[0-9a-f]{6}$/i.test(t)) hex = t.toLowerCase();
    } catch {}
  }
  return new Response(JSON.stringify({ hex }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const cs = (url.searchParams.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const hex = (url.searchParams.get("hex") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  const reg = (url.searchParams.get("reg") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10);
  if (reg && !cs && !hex) return regToHex(reg);
  if (!cs && !hex) {
    return new Response(JSON.stringify({ error: "cs or hex required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let cache = null;
  let key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/lookup?cs=${cs}&hex=${hex}`, url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}

  const [route, aircraft] = await Promise.all([
    cs ? get("callsign/" + cs) : null,
    hex ? get("aircraft/" + hex) : null,
  ]);
  const res = new Response(JSON.stringify({ route, aircraft }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=21600" },
  });
  if (cache) context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
