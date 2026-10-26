// Cloudflare Pages Function: GET /api/flight?cs=UAL317
// Scheduled and actual times, gates and status for one flight from FlightAware
// AeroAPI. Only runs when the AEROAPI_KEY secret is set; otherwise the page
// falls back to its own estimates.
//
// Cost control, so usage stays inside the Personal tier's free $5 a month:
//   * answers are cached 15 minutes per callsign, so repeat clicks are free
//   * one page of results per call (max_pages=1), about $0.005 each
//   * a monthly ceiling (AEROAPI_MONTHLY_LIMIT, default 900 calls, about $4.50,
//     leaving room for the few calls KV's eventual consistency can let through)
//   * a daily limit (AEROAPI_DAILY_LIMIT, default 30) so one busy day can't use
//     up the whole month
// Usage is counted in FLIGHTS_KV under one key. Without that binding, no calls
// are made at all, since there would be no way to enforce the ceiling.

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

// Usage limits. Months and days are counted in UTC, the same way AeroAPI bills.
// A flight lookup counts as 1 unit. A track counts as AEROAPI_TRACK_UNITS
// (default 3), on the cautious side; check AeroAPI's per-query price table and
// adjust if tracks cost less.
async function reserve(context, units) {
  const { env } = context;
  const monthly = Number(env.AEROAPI_MONTHLY_LIMIT) || 900;
  const daily = Number(env.AEROAPI_DAILY_LIMIT) || 30;
  const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7);
  let u = {};
  try { u = JSON.parse((await env.FLIGHTS_KV.get("aero-usage")) || "{}"); } catch {}
  if (u.month !== month) u = { month, m: 0, day: today, d: 0 };
  if (u.day !== today) { u.day = today; u.d = 0; }
  if (u.m + units > monthly) return { limited: "month" };
  if (u.d + units > daily) return { limited: "day" };
  return {
    commit() {
      u.m += units; u.d += units;
      context.waitUntil(env.FLIGHTS_KV.put("aero-usage", JSON.stringify(u)));
    },
  };
}

// GET /api/flight?track=<fa_flight_id>: FlightAware's recorded positions for one
// flight, including satellite (space-based ADS-B) positions over oceans.
async function track(context, faId) {
  const { request, env } = context;
  let cache = null, key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/fatrack?id=${encodeURIComponent(faId)}`, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}
  const res0 = await reserve(context, Number(env.AEROAPI_TRACK_UNITS) || 3);
  if (res0.limited) return json({ enabled: true, limited: res0.limited });
  let r;
  try {
    r = await fetch(`${BASE}/flights/${encodeURIComponent(faId)}/track`, {
      headers: { "x-apikey": env.AEROAPI_KEY, accept: "application/json" },
    });
  } catch (e) {
    return json({ enabled: true, error: `FlightAware unreachable (${e.message})` });
  }
  res0.commit();
  if (!r.ok) return json({ enabled: true, error: `FlightAware returned ${r.status}` });
  const d = await r.json();
  // [epochSeconds, lat, lon, altitudeFt, groundspeedKt, heading, source]
  const points = (d.positions || [])
    .filter((p) => p.latitude != null && p.longitude != null && p.update_type !== "P")
    .map((p) => [Math.round(Date.parse(p.timestamp) / 1000), p.latitude, p.longitude,
      p.altitude != null ? p.altitude * 100 : null, p.groundspeed ?? null, p.heading ?? null, p.update_type || null]);
  const res = json({ enabled: true, points }, 600);
  if (cache) context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.AEROAPI_KEY) return json({ enabled: false });
  if (!env.FLIGHTS_KV) return json({ enabled: true, error: "FLIGHTS_KV binding missing, so usage can't be capped" });
  const params = new URL(request.url).searchParams;
  const faId = (params.get("track") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 80);
  if (faId) return track(context, faId);
  const cs = (params.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (cs.length < 3) return json({ enabled: true, error: "callsign required" });

  let cache = null, key = null;
  try {
    cache = caches.default;
    key = new Request(new URL(`/__cache/flight?cs=${cs}`, request.url).toString());
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {}

  const slot = await reserve(context, 1);
  if (slot.limited) return json({ enabled: true, limited: slot.limited });

  let r;
  try {
    r = await fetch(`${BASE}/flights/${encodeURIComponent(cs)}?max_pages=1`, {
      headers: { "x-apikey": env.AEROAPI_KEY, accept: "application/json" },
    });
  } catch (e) {
    return json({ enabled: true, error: `FlightAware unreachable (${e.message})` });
  }
  slot.commit();
  if (!r.ok) return json({ enabled: true, error: `FlightAware returned ${r.status}` });

  const f = pick((await r.json()).flights || []);
  const flight = f && {
    faId: f.fa_flight_id || null, ident: f.ident, identIata: f.ident_iata, operatorIata: f.operator_iata, status: f.status,
    origin: apt(f.origin), destination: apt(f.destination),
    gateOrigin: f.gate_origin, gateDest: f.gate_destination, termOrigin: f.terminal_origin, termDest: f.terminal_destination,
    out: { sched: f.scheduled_out, est: f.estimated_out, act: f.actual_out },
    off: { sched: f.scheduled_off, est: f.estimated_off, act: f.actual_off },
    on: { sched: f.scheduled_on, est: f.estimated_on, act: f.actual_on },
    in: { sched: f.scheduled_in, est: f.estimated_in, act: f.actual_in },
    depDelay: f.departure_delay, arrDelay: f.arrival_delay,
    registration: f.registration || null, aircraftType: f.aircraft_type || null,
    // AeroAPI gives filed altitude in hundreds of feet (350 = 35,000 ft)
    filedAlt: f.filed_altitude ? (f.filed_altitude < 1000 ? f.filed_altitude * 100 : f.filed_altitude) : null,
    filedSpeed: f.filed_airspeed || null, progress: f.progress_percent ?? null,
  };
  const res = json({ enabled: true, flight: flight || null }, 900);
  if (cache) context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
