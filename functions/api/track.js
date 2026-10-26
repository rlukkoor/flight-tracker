// Cloudflare Pages Function: GET /api/track?hex=a1b2c3
// Returns up to 4 hours of positions for one aircraft from the track history
// the GitHub Action keeps in KV: { points: [[epochSeconds, lat, lon], ...] }

let txt = null;
let at = 0;

export async function onRequestGet({ request, env }) {
  const hex = (new URL(request.url).searchParams.get("hex") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  const out = (obj, status = 200, maxAge = 60) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
    });
  if (hex.length !== 6) return out({ error: "hex required" }, 400, 0);
  if (!env.FLIGHTS_KV) return out({ points: [] }, 200, 0);

  if (!txt || Date.now() - at > 60_000) {
    const t = await env.FLIGHTS_KV.get("tracks", { cacheTtl: 60 });
    if (t) { txt = t; at = Date.now(); }
  }
  if (!txt) return out({ points: [] });

  // Find this aircraft's line without parsing the whole file.
  const i = txt.indexOf(`\n${hex}|`);
  if (i < 0) return out({ points: [] });
  const end = txt.indexOf("\n", i + 1);
  const line = txt.slice(i + 8, end < 0 ? undefined : end);
  const base = Number(txt.slice(2, txt.indexOf("\n")));
  const points = line.split(";").map((p) => {
    const [m, la, lo] = p.split(",");
    return [(base + Number(m)) * 60, Number(la), Number(lo)];
  });
  return out({ points });
}
