// Cloudflare Pages Function: GET /api/track?hex=a1b2c3
// Up to 20 hours of positions for one aircraft from the history the snapshot
// job keeps in R2 (split into tracks/0 ... tracks/f by the code's last
// character) or in Workers KV (one "tracks" value).
// Returns { points: [[epochSeconds, lat, lon, altitudeFt, groundSpeedKt, onGround], ...] }
// Altitude and speed are null for points recorded before they were stored.

const cache = new Map(); // file name -> { txt, at }

async function load(env, name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.txt;
  let txt = null;
  if (env.FLIGHTS_R2) {
    const o = await env.FLIGHTS_R2.get(name);
    txt = o ? await o.text() : null;
  } else if (env.FLIGHTS_KV) {
    txt = await env.FLIGHTS_KV.get(name, { cacheTtl: 60 });
  }
  if (txt) cache.set(name, { txt, at: Date.now() });
  return txt || hit?.txt || null;
}

function find(txt, hex) {
  const i = txt.indexOf(`\n${hex}|`);
  if (i < 0) return null;
  const end = txt.indexOf("\n", i + 1);
  const line = txt.slice(i + 8, end < 0 ? undefined : end);
  const base = Number(txt.slice(2, txt.indexOf("\n")));
  return line.split(";").map((p) => {
    const [m, la, lo, al, g] = p.split(",");
    const gnd = al === "g";
    return [(base + Number(m)) * 60, Number(la), Number(lo),
      gnd ? 0 : al ? Number(al) * 100 : null, g ? Number(g) : null, gnd ? 1 : 0];
  });
}

export async function onRequestGet({ request, env }) {
  const hex = (new URL(request.url).searchParams.get("hex") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  const out = (obj, status = 200, maxAge = 60) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
    });
  if (hex.length !== 6) return out({ error: "hex required" }, 400, 0);
  if (!env.FLIGHTS_R2 && !env.FLIGHTS_KV) return out({ points: [] }, 200, 0);

  let txt = env.FLIGHTS_R2 ? await load(env, `tracks/${hex.slice(-1)}`) : null;
  if (!txt) txt = await load(env, "tracks"); // KV, or R2 before the split
  return out({ points: (txt && find(txt, hex)) || [] });
}
