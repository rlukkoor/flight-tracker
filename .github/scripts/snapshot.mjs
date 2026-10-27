// Builds the global aircraft snapshot and flight track history, and stores
// both in Cloudflare KV, where the site's functions read them.
// Runs on GitHub Actions because OpenSky doesn't answer Cloudflare's servers.
//
// Sources:
//   OpenSky: one global call, the backbone.
//   adsb.fi: ~70 point queries (250 nm each) over regions where OpenSky has
//            few receivers. Public API, 1 request per second, non commercial.
//
// Required environment variables (GitHub repo secrets):
//   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET, CF_ACCOUNT_ID
// Storage, either:
//   R2 (preferred: no size limit, enough free writes for a 2 minute refresh):
//     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   or Workers KV (original setup, 5 minute refresh):
//     CF_API_TOKEN (Workers KV Storage: Edit), CF_KV_NAMESPACE_ID

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";
const ADSBFI = (lat, lon) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/250`;
const TRACK_HOURS = 20; // long enough for the longest nonstop flights
const FULL_DETAIL_MIN = 120;
const TRACK_DROP_MIN = 30; // forget a flight once it hasn't been seen for this long

// Centers for adsb.fi queries: busy airspace OpenSky covers thinly.
const FILL = [
  // Middle East and Turkey
  [25.3, 55.4], [25.3, 51.6], [24.7, 46.7], [21.7, 39.2], [29.3, 47.9], [31.9, 35.9], [35.7, 51.4],
  [30.1, 31.4], [23.6, 58.3], [41.0, 28.8], [39.9, 32.8],
  // South Asia
  [28.6, 77.1], [19.1, 72.9], [13.0, 77.6], [22.6, 88.4], [17.4, 78.5], [24.9, 67.1], [7.2, 79.9],
  // Southeast Asia
  [1.4, 103.9], [3.1, 101.7], [13.7, 100.7], [-6.1, 106.7], [14.5, 121.0], [10.8, 106.7], [21.2, 105.8],
  [-8.7, 115.2], [16.8, 96.1],
  // East Asia
  [22.3, 113.9], [25.1, 121.2], [31.2, 121.5], [40.1, 116.6], [30.6, 104.0], [34.5, 108.9], [37.5, 126.8],
  [35.6, 139.8], [34.4, 135.2], [43.0, 141.4], [33.6, 130.4],
  // Oceania
  [-33.9, 151.2], [-37.7, 144.8], [-27.4, 153.1], [-31.9, 115.9], [-36.9, 174.8], [-17.7, 177.4],
  // Africa
  [-26.1, 28.2], [-1.3, 36.9], [6.5, 3.3], [9.0, 38.8], [33.4, -7.6], [-33.9, 18.6], [5.6, -0.2],
  // Latin America
  [-23.4, -46.5], [-22.8, -43.2], [-34.8, -58.5], [-33.4, -70.8], [4.7, -74.1], [-12.0, -77.1],
  [9.1, -79.4], [19.4, -99.1], [18.4, -66.0],
  // Ocean edges and islands
  [47.6, -52.7], [64.1, -21.9], [38.7, -27.1], [32.3, -64.7], [28.0, -15.4], [21.3, -157.9],
  [13.5, 144.8], [61.2, -150.0],
  // Russia and Central Asia
  [55.8, 37.6], [43.2, 76.9], [41.3, 69.2], [56.0, 92.9],
];

import { createHash, createHmac } from "node:crypto";

const env = process.env;
const USE_R2 = !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);
const required = ["OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET", "CF_ACCOUNT_ID",
  ...(USE_R2 ? [] : ["CF_API_TOKEN", "CF_KV_NAMESPACE_ID"])];
for (const k of required) {
  if (!env[k]) {
    console.error(`Missing secret: ${k}`);
    process.exit(1);
  }
}
// adsb.fi fill-in queries take about 75 seconds, so they run at most this often;
// in between, the last fill-in results are reused.
const FILL_EVERY_MS = (Number(env.FILL_EVERY_MIN) || 4) * 60_000 - 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const ri = (v) => (v == null ? null : Math.round(v));
const KV = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}/values/`;

async function timedFetch(url, opts = {}, ms = 40_000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(to);
  }
}

/* ---------- OpenSky ---------- */
async function getToken() {
  const r = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`token request failed (${r.status})`);
  return (await r.json()).access_token;
}

async function openSky() {
  const token = await getToken();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await timedFetch(STATES_URL, { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 429) {
        throw Object.assign(new Error(`rate limited, retry after ${r.headers.get("x-rate-limit-retry-after-seconds")}s`), { fatal: true });
      }
      if (!r.ok) throw new Error(`states returned ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.fatal || attempt === 3) throw e;
      console.warn(`OpenSky attempt ${attempt} failed: ${e.message}`);
      await sleep(5000 * attempt);
    }
  }
}

// Row: [hex, callsign, country, lon, lat, alt m, onGround, speed m/s, track, vrate m/s, posTime, squawk, type, reg]
function fromOpenSky(s) {
  return [s[0], (s[1] || "").trim(), s[2] || "", r4(s[5]), r4(s[6]), ri(s[7] ?? s[13]), s[8] ? 1 : 0, r1(s[9]), ri(s[10]), r1(s[11]), s[3] ?? s[4], s[14] || null, null, null];
}

/* ---------- adsb.fi ---------- */
function fromReadsb(a, nowS) {
  const gnd = a.alt_baro === "ground";
  const altFt = gnd ? 0 : typeof a.alt_baro === "number" ? a.alt_baro : a.alt_geom ?? null;
  const vr = a.baro_rate ?? a.geom_rate;
  return [
    a.hex.toLowerCase().replace(/^~/, ""), (a.flight || "").trim(), "", r4(a.lon), r4(a.lat),
    altFt == null ? null : ri(altFt / 3.28084), gnd ? 1 : 0, a.gs == null ? null : r1(a.gs / 1.943844),
    ri(a.track ?? a.true_heading), vr == null ? null : r1(vr / 196.8504),
    Math.round(nowS - (a.seen_pos || 0)), a.squawk || null, a.t || null, a.r || null,
  ];
}

async function adsbFi() {
  const rows = [];
  let ok = 0, failed = 0;
  for (const [lat, lon] of FILL) {
    const t = Date.now();
    try {
      const r = await timedFetch(ADSBFI(lat, lon), { headers: { accept: "application/json" } }, 10_000);
      if (r.status === 429 || r.status === 403) {
        console.warn(`adsb.fi returned ${r.status}, stopping for this run`);
        break;
      }
      if (r.ok) {
        const d = await r.json();
        const nowS = (d.now || Date.now()) / 1000;
        for (const a of d.ac || d.aircraft || []) if (a.hex && a.lat != null && a.lon != null) rows.push(fromReadsb(a, nowS));
        ok++;
      } else failed++;
    } catch {
      failed++;
    }
    await sleep(Math.max(0, 1100 - (Date.now() - t))); // stay under 1 request per second
  }
  console.log(`adsb.fi: ${ok} areas ok, ${failed} failed, ${rows.length} aircraft rows`);
  return rows;
}

/* ---------- Cloudflare R2 (S3 compatible API, AWS Signature Version 4) ---------- */
const sha256 = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
export function signV4({ method, host, path, headers = {}, body = "", accessKey, secretKey, region, service = "s3", now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(h).sort();
  const canonical = [method, path, "", names.map((n) => `${n}:${h[n]}`).join("\n") + "\n", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretKey, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  delete h.host;
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
const R2_HOST = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
async function r2(method, key, body) {
  const path = `/${env.R2_BUCKET}/${encodeURIComponent(key)}`;
  const headers = signV4({
    method, host: R2_HOST, path, body: body || "", region: "auto",
    headers: body ? { "content-type": "application/json" } : {},
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY,
  });
  return timedFetch(`https://${R2_HOST}${path}`, { method, headers, body: body || undefined }, 60_000);
}

/* ---------- storage: R2 when configured, otherwise Workers KV ---------- */
// Returns null when the key doesn't exist yet; throws when the read fails.
async function storeGet(key) {
  if (USE_R2) {
    const r = await r2("GET", key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 read of ${key} failed (${r.status})`);
    return await r.text();
  }
  return kvGet(key);
}
async function storePut(key, body) {
  if (USE_R2) {
    const r = await r2("PUT", key, body);
    if (!r.ok) throw new Error(`R2 write of ${key} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return;
  }
  return kvPut(key, body);
}

/* ---------- Cloudflare KV ---------- */
async function kvGet(key) {
  const r = await timedFetch(KV + key, { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV read failed (${r.status})`);
  return await r.text();
}
async function kvPut(key, body) {
  const r = await timedFetch(KV + key, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "text/plain" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`KV write failed (${r.status}): ${JSON.stringify(j.errors || j)}`);
}

/* ---------- track history ----------
   Text format, so /api/track can find one flight with indexOf instead of
   parsing the whole thing:
     T <baseMinute>
     <hex>|<min>,<lat>,<lon>,<alt>,<gs>;...
   min: minutes after baseMinute. alt: hundreds of feet, or "g" on the ground.
   gs: ground speed in knots. Older files have only min,lat,lon.
   With R2 the history is split into 16 files by the last character of the
   transponder code (tracks/0 ... tracks/f), so the site reads small files. */
const SHARDS = "0123456789abcdef".split("");
export function parseTracks(txt, tracks = new Map()) {
  if (!txt) return tracks;
  const lines = txt.split("\n");
  const base = Number((lines[0] || "").split(" ")[1]) || 0;
  for (let i = 1; i < lines.length; i++) {
    const [hex, pts] = lines[i].split("|");
    if (!hex || !pts) continue;
    tracks.set(hex, pts.split(";").map((p) => {
      const [m, la, lo, al = "", g = ""] = p.split(",");
      return [base + Number(m), la, lo, al, g];
    }));
  }
  return tracks;
}
export function updateTracks(tracks, rows, nowMin) {
  for (const a of rows) {
    const gnd = !!a[6];
    const minute = Math.floor(a[10] / 60) || nowMin;
    const alt = gnd ? "g" : a[5] == null ? "" : String(Math.max(0, Math.round((a[5] * 3.28084) / 100)));
    const gs = a[7] == null ? "" : String(Math.round(a[7] * 1.943844));
    const pt = [minute, a[4].toFixed(2), a[3].toFixed(2), alt, gs];
    const t = tracks.get(a[0]);
    if (!t) { tracks.set(a[0], [pt]); continue; }
    const last = t[t.length - 1];
    // On the ground, keep just one point: the latest. It marks where the next
    // takeoff starts (or where the last flight ended).
    if (gnd && last[3] === "g") { t[t.length - 1] = pt; continue; }
    if (last[0] < minute) t.push(pt);
  }
  const keepFrom = nowMin - TRACK_HOURS * 60;
  const fullFrom = nowMin - FULL_DETAIL_MIN;
  for (const [hex, t] of tracks) {
    // Keep every point from the last 2 hours; thin older ones to one per 15 min,
    // but never drop a ground point or the first point after one (takeoff).
    const kept = [];
    for (const p of t) {
      if (p[0] < keepFrom) continue;
      const prev = kept[kept.length - 1];
      if (p[0] < fullFrom && prev && p[0] - prev[0] < 15 && p[3] !== "g" && prev[3] !== "g") continue;
      kept.push(p);
    }
    if (!kept.length || kept[kept.length - 1][0] < nowMin - TRACK_DROP_MIN) tracks.delete(hex);
    else tracks.set(hex, kept);
  }
  const text = (entries) => {
    let out = `T ${keepFrom}`;
    for (const [hex, t] of entries) out += `\n${hex}|` + t.map((p) => `${p[0] - keepFrom},${p[1]},${p[2]},${p[3] ?? ""},${p[4] ?? ""}`).join(";");
    return out;
  };
  if (!USE_R2) return { tracks: text(tracks) };
  const shards = Object.fromEntries(SHARDS.map((c) => [c, []]));
  for (const e of tracks) (shards[e[0].slice(-1)] || shards["0"]).push(e);
  return Object.fromEntries(SHARDS.map((c) => [`tracks/${c}`, text(shards[c])]));
}

/* ---------- run ---------- */
if (process.env.SNAPSHOT_TEST_ONLY) { /* imported by a test for signV4 */ }
else await run();

async function run() {
const t0 = Date.now();
// The adsb.fi fill-in is slow, so reuse the last one when it's recent enough.
let fill = null;
try { fill = JSON.parse((await storeGet("fill")) || "null"); } catch (e) { console.warn(`fill read: ${e.message}`); }
const fillFresh = fill && Date.now() - fill.at < FILL_EVERY_MS;
// A failed tracks read must never be mistaken for "no history": that used to
// reset every plane's recorded path. Skip updating tracks this run instead.
let oldTracks = [], tracksOk = true;
const readTracks = async () => {
  if (!USE_R2) { oldTracks = [await storeGet("tracks")]; return; }
  oldTracks = await Promise.all(SHARDS.map((c) => storeGet(`tracks/${c}`)));
  // First run after switching to split files: carry over the single old file.
  if (oldTracks.every((t) => t == null)) oldTracks = [await storeGet("tracks")];
};
const [os, fiNew] = await Promise.all([
  openSky().catch((e) => { console.error(`OpenSky failed: ${e.message}`); return null; }),
  fillFresh ? null : adsbFi(),
  readTracks().catch((e) => { tracksOk = false; console.warn(`tracks read failed, keeping history as is: ${e.message}`); }),
]);
if (fiNew) {
  fill = { at: Date.now(), rows: fiNew };
  await storePut("fill", JSON.stringify(fill)).catch((e) => console.warn(`fill write: ${e.message}`));
}
const fi = fill?.rows || [];

const byHex = new Map();
for (const s of os?.states || []) if (s[5] != null && s[6] != null) byHex.set(s[0], fromOpenSky(s));
const osCount = byHex.size;
let added = 0;
for (const a of fi) {
  const cur = byHex.get(a[0]);
  if (!cur) { byHex.set(a[0], a); added++; continue; }
  if (a[10] > cur[10]) { a[2] = cur[2]; byHex.set(a[0], a); } // fresher position, keep OpenSky's country
  else { cur[12] ||= a[12]; cur[13] ||= a[13]; }
}
const ac = [...byHex.values()];
if (ac.length < 500) throw new Error(`only ${ac.length} aircraft, keeping the previous snapshot`);

// "fetched" must stay the first key; /api/states reads it from the start of the string.
const body = JSON.stringify({ fetched: Date.now(), time: os?.time || Math.floor(Date.now() / 1000), ac });
await storePut("snapshot", body);
let tracksNote = "tracks skipped (read failed)";
if (tracksOk) {
  const prev = new Map();
  for (const t of oldTracks) parseTracks(t, prev);
  const files = updateTracks(prev, ac, Math.floor(Date.now() / 60000));
  const bytes = Object.values(files).reduce((n, t) => n + t.length, 0);
  if (!USE_R2 && bytes > 24 * 1024 * 1024) {
    tracksNote = `tracks NOT saved: ${(bytes / 1048576).toFixed(1)} MB is over KV's 25 MB limit; switch to R2`;
  } else {
    await Promise.all(Object.entries(files).map(([k, t]) => storePut(k, t)));
    let pts = 0;
    for (const t of prev.values()) pts += t.length;
    tracksNote = `tracks ${(bytes / 1024).toFixed(0)} KB in ${Object.keys(files).length} file(s), ${prev.size} aircraft, ${pts} points`;
  }
}
console.log(
  `Stored ${ac.length} aircraft (OpenSky ${osCount}, adsb.fi added ${added}${fillFresh ? ", reused" : ""}) in ${USE_R2 ? "R2" : "KV"}, ` +
  `snapshot ${(body.length / 1024).toFixed(0)} KB, ${tracksNote}, in ${((Date.now() - t0) / 1000).toFixed(1)}s`
);
}
