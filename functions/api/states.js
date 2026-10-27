// Cloudflare Pages Function: GET /api/states
// Fetches the global OpenSky snapshot, compacts it, and caches it so every
// viewer shares one upstream call per TTL window.
//
// Environment variables (Pages project > Settings > Variables and Secrets):
//   OPENSKY_CLIENT_ID      OpenSky API client id     (optional, strongly recommended)
//   OPENSKY_CLIENT_SECRET  OpenSky API client secret (optional, strongly recommended)
//   OPENSKY_TTL            Seconds between upstream refreshes (optional)
//                          Defaults: 90 with credentials, 900 without.
//
// Credit math: a global states/all call costs 4 credits.
//   Registered account: 4,000 credits/day  -> 90s TTL uses ~3,840/day
//   Active feeder:      8,000 credits/day  -> 45s TTL is safe
//   Anonymous:            400 credits/day  -> 900s TTL uses ~384/day

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

// Module scope survives between requests within the same isolate.
let token = null;
let tokenExp = 0;
let mem = null; // { fetched, time, ac }
let body = null; // prebuilt JSON string for mem
let bodyKey = "";
let retryAfter = 0;
let inflight = null;
let lastError = null;

async function getToken(env) {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`OpenSky token request failed (${r.status})`);
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 1800) * 1000;
  return token;
}

const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const ri = (v) => (v == null ? null : Math.round(v));

// OpenSky state vector indices:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 lon, 6 lat, 7 baro_alt m, 8 on_ground, 9 velocity m/s, 10 true_track,
// 11 vertical_rate m/s, 12 sensors, 13 geo_alt m, 14 squawk, 15 spi, 16 source
function compact(states) {
  const out = [];
  for (const s of states || []) {
    if (s[5] == null || s[6] == null) continue;
    out.push([
      s[0],
      (s[1] || "").trim(),
      s[2] || "",
      r4(s[5]),
      r4(s[6]),
      ri(s[7] ?? s[13]),
      s[8] ? 1 : 0,
      r1(s[9]),
      ri(s[10]),
      r1(s[11]),
      s[3] ?? s[4],
      s[14] || null,
    ]);
  }
  return out;
}

async function refresh(env, auth) {
  const call = async () => {
    const headers = { accept: "application/json" };
    if (auth) headers.authorization = `Bearer ${await getToken(env)}`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 25_000);
    try {
      return await fetch(STATES_URL, { headers, signal: ac.signal });
    } catch (e) {
      retryAfter = Date.now() + 60_000;
      throw new Error(e.name === "AbortError" ? "OpenSky timed out" : `OpenSky unreachable (${e.message})`);
    } finally {
      clearTimeout(to);
    }
  };
  let r = await call();
  if (r.status === 401 && auth) {
    token = null; // token revoked or expired early, retry once
    r = await call();
  }
  if (r.status === 429) {
    const wait = Number(r.headers.get("x-rate-limit-retry-after-seconds")) || 600;
    retryAfter = Date.now() + wait * 1000;
    throw new Error(`OpenSky rate limit reached, retrying in ${Math.round(wait / 60)} min`);
  }
  if (r.status >= 500) {
    // 52x codes mean OpenSky's server didn't answer Cloudflare in time.
    retryAfter = Date.now() + 60_000;
    throw new Error(`OpenSky server not responding (${r.status}), retrying in 1 min`);
  }
  if (!r.ok) throw new Error(`OpenSky returned ${r.status}`);
  const d = await r.json();
  return { fetched: Date.now(), time: d.time, ac: compact(d.states) };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

// Stored mode: a scheduled GitHub Action writes the snapshot to R2 (FLIGHTS_R2
// binding) or Workers KV (FLIGHTS_KV), since OpenSky doesn't answer Cloudflare's
// servers directly. R2 is preferred: it allows a refresh every 2 minutes.
let kvBody = null;
let kvAt = 0;
async function fromKV(env) {
  const r2 = !!env.FLIGHTS_R2;
  const every = Number(env.SNAPSHOT_EVERY) || (r2 ? 120 : 300);
  if (!kvBody || Date.now() - kvAt > (r2 ? 15_000 : 30_000)) {
    const txt = r2
      ? await env.FLIGHTS_R2.get("snapshot").then((o) => (o ? o.text() : null))
      : await env.FLIGHTS_KV.get("snapshot", { cacheTtl: 60 });
    if (txt) {
      kvBody = txt;
      kvAt = Date.now();
    }
  }
  if (!kvBody) return json({ error: "No snapshot yet. Run the OpenSky snapshot action once on GitHub." }, 503);
  const fetched = Number((kvBody.slice(0, 40).match(/"fetched":(\d+)/) || [])[1] || 0);
  const lateMin = Math.round((Date.now() - fetched) / 60000);
  const stale = Date.now() - fetched > every * 3000;
  return new Response(`{"ttl":${every},"auth":true,"source":"stored",${kvBody.slice(1)}`, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-stale": stale ? "1" : "0",
      ...(stale ? { "x-upstream-error": `Snapshot job last ran ${lateMin} min ago` } : {}),
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (env.FLIGHTS_R2 || env.FLIGHTS_KV) return fromKV(env);
  const auth = !!(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET);
  const ttl = Number(env.OPENSKY_TTL) || (auth ? 90 : 900);
  const now = Date.now();

  // Shared edge cache (per Cloudflare data center) backs up the isolate cache.
  let cache = null;
  let key = null;
  try {
    cache = caches.default;
    key = new Request(new URL("/__cache/opensky-states", request.url).toString());
  } catch {}

  if (!mem && cache) {
    try {
      const hit = await cache.match(key);
      if (hit) mem = await hit.json();
    } catch {}
  }

  const fresh = mem && now - mem.fetched < ttl * 1000;
  if (!fresh && now >= retryAfter) {
    if (!inflight) inflight = refresh(env, auth).finally(() => (inflight = null));
    try {
      mem = await inflight;
      lastError = null;
      if (cache) {
        const copy = new Response(JSON.stringify(mem), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
        });
        context.waitUntil(cache.put(key, copy).catch(() => {}));
      }
    } catch (e) {
      lastError = String(e.message || e);
      if (!mem) return json({ error: lastError }, 502);
    }
  }

  if (!mem) {
    const wait = Math.max(1, Math.ceil((retryAfter - now) / 1000));
    return json({ error: lastError || "OpenSky unavailable" }, 503, { "retry-after": String(wait) });
  }

  const k = `${mem.fetched}|${ttl}|${auth}`;
  if (k !== bodyKey) {
    body = JSON.stringify({ fetched: mem.fetched, time: mem.time, ttl, auth, ac: mem.ac });
    bodyKey = k;
  }
  const stale = now - mem.fetched > ttl * 1000 + 5000;
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-stale": stale ? "1" : "0",
      ...(stale && lastError ? { "x-upstream-error": lastError } : {}),
    },
  });
}
