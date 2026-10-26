// Fetches the global OpenSky snapshot and stores it in Cloudflare KV,
// where the site's /api/states function reads it.
// Runs on GitHub Actions because OpenSky doesn't answer Cloudflare's servers.
//
// Required environment variables (GitHub repo secrets):
//   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET
//   CF_ACCOUNT_ID, CF_API_TOKEN (Workers KV Storage: Edit), CF_KV_NAMESPACE_ID

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

const env = process.env;
for (const k of ["OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET", "CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID"]) {
  if (!env[k]) {
    console.error(`Missing secret: ${k}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const ri = (v) => (v == null ? null : Math.round(v));

async function getToken() {
  const r = await fetch(TOKEN_URL, {
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

async function getStates(token) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 40_000);
    try {
      const r = await fetch(STATES_URL, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
      if (r.status === 429) {
        throw Object.assign(new Error(`rate limited, retry after ${r.headers.get("x-rate-limit-retry-after-seconds")}s`), { fatal: true });
      }
      if (!r.ok) throw new Error(`states returned ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.fatal || attempt === 3) throw e;
      console.warn(`attempt ${attempt} failed: ${e.message}`);
      await sleep(5000 * attempt);
    } finally {
      clearTimeout(to);
    }
  }
}

// Same compact row format the page expects:
// [hex, callsign, country, lon, lat, alt m, onGround, speed m/s, track, vrate m/s, posTime, squawk]
function compact(states) {
  const out = [];
  for (const s of states || []) {
    if (s[5] == null || s[6] == null) continue;
    out.push([s[0], (s[1] || "").trim(), s[2] || "", r4(s[5]), r4(s[6]), ri(s[7] ?? s[13]), s[8] ? 1 : 0, r1(s[9]), ri(s[10]), r1(s[11]), s[3] ?? s[4], s[14] || null]);
  }
  return out;
}

async function putKV(body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}/values/snapshot`;
  const r = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "text/plain" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    throw new Error(`KV write failed (${r.status}): ${JSON.stringify(j.errors || j)}`);
  }
}

const t0 = Date.now();
const token = await getToken();
const d = await getStates(token);
const ac = compact(d.states);
if (!ac.length) throw new Error("OpenSky returned no aircraft, keeping the previous snapshot");
// "fetched" must stay the first key; /api/states reads it from the start of the string.
const body = JSON.stringify({ fetched: Date.now(), time: d.time, ac });
await putKV(body);
console.log(`Stored ${ac.length} aircraft (${(body.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
