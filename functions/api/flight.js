// Cloudflare Pages Function: GET /api/flight?cs=UAL317
// Scheduled and actual times, gates and status for one flight from FlightAware
// AeroAPI. Only runs when the AEROAPI_KEY secret is set; otherwise the page
// falls back to its own estimates.
//
// Cost control: answers are cached 10 minutes per callsign, and upstream calls
// are capped per day (AEROAPI_DAILY_LIMIT, default 30, counted in FLIGHTS_KV).
// At about $0.005 a call, 30 a day stays inside the Personal tier's free $5.

const BASE = "https://aeroapi.flightaware.com/aeroapi";

function json(obj, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}

const apt = (a) => a && { iata: a.code_iata, icao: a.code_icao || a.code, tz: a.timezone, name: a.name, city: a.city };

// Pick the flight the plane is most likely on right now.
function pick(flights) {
  const now = Date.now();
  const t = (s) => (s ? Date.parse(s) : NaN);
  const enRoute = flights.find((f) => f.actual_off && !f.actual_on);
  if (enRoute) return enRoute;
  let best = null, bestGap = Infinity;
  for (const f of flights) {
    const dep = t(f.actual_out || f.estimated_out || f.scheduled_out);
    if (isNaN(dep)) continue;
    const gap = Math.abs(dep - now);
    if (gap < bestGap) { best = f; bestGap = gap; }
  }
  return best;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.AEROAPI_KEY) return json({ enabled: false });
  const cs = (new URL(request.url).searchParams.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (cs.length < 3) return json({ enabled: true, error: "callsign required" });

  let cache = null, key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/flight?cs=${cs}`, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}

  // Daily cap, so a busy day can't run up a bill.
  const limit = Number(env.AEROAPI_DAILY_LIMIT) || 30;
  const dayKey = `aero:${new Date().toISOString().slice(0, 10)}`;
  let used = 0;
  if (env.FLIGHTS_KV) {
    used = Number(await env.FLIGHTS_KV.get(dayKey)) || 0;
    if (used >= limit) return json({ enabled: true, limited: true });
  }

  let r;
  try {
    r = await fetch(`${BASE}/flights/${encodeURIComponent(cs)}?max_pages=1`, {
      headers: { "x-apikey": env.AEROAPI_KEY, accept: "application/json" },
    });
  } catch (e) {
    return json({ enabled: true, error: `FlightAware unreachable (${e.message})` });
  }
  if (env.FLIGHTS_KV) context.waitUntil(env.FLIGHTS_KV.put(dayKey, String(used + 1), { expirationTtl: 172800 }));
  if (!r.ok) return json({ enabled: true, error: `FlightAware returned ${r.status}` });

  const f = pick((await r.json()).flights || []);
  const flight = f && {
    ident: f.ident, identIata: f.ident_iata, operatorIata: f.operator_iata, status: f.status,
    origin: apt(f.origin), destination: apt(f.destination),
    gateOrigin: f.gate_origin, gateDest: f.gate_destination, termOrigin: f.terminal_origin, termDest: f.terminal_destination,
    out: { sched: f.scheduled_out, est: f.estimated_out, act: f.actual_out },
    off: { sched: f.scheduled_off, est: f.estimated_off, act: f.actual_off },
    on: { sched: f.scheduled_on, est: f.estimated_on, act: f.actual_on },
    in: { sched: f.scheduled_in, est: f.estimated_in, act: f.actual_in },
    depDelay: f.departure_delay, arrDelay: f.arrival_delay,
  };
  const res = json({ enabled: true, flight: flight || null }, 600);
  if (cache) context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
