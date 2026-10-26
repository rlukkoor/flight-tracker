# Flight Tracker

Live global map of commercial flights.

```
index.html                              the app
functions/api/states.js                 serves the latest global snapshot from KV
functions/api/lookup.js                 aircraft details and fallback routes (adsbdb), cached 6 hours
functions/api/track.js                  up to 20 hours of positions for one aircraft, from KV
airports.json                           airport names and coordinates (OurAirports), loaded on first click
favicon.svg, apple-touch-icon.png       site icons
.github/workflows/opensky-snapshot.yml  runs every 5 minutes on GitHub
.github/scripts/snapshot.mjs            fetches OpenSky + adsb.fi, writes snapshot and track history to KV
```

OpenSky doesn't answer Cloudflare's servers and doesn't allow browser requests from other sites, so a scheduled GitHub Action fetches it and stores the result in Cloudflare KV. The site reads from there. When you zoom in, a separate live feed (adsb.lol, airplanes.live) updates every 5 seconds straight from the browser.

## Setup

1. **Create the KV namespace:** `npx wrangler kv namespace create flight-tracker` and copy the id it prints.
2. **Bind it to the site:** Cloudflare dashboard, Workers & Pages, your project, Settings, Bindings, add a KV namespace binding. Variable name `FLIGHTS_KV`, namespace `flight-tracker`.
3. **Make a Cloudflare API token:** dashboard, My Profile, API Tokens, Create Token, Custom token. Permission: Account, Workers KV Storage, Edit. Also copy your Account ID from the Workers & Pages overview page.
4. **Push this folder to a public GitHub repo** (scheduled Actions on public repos are free).
5. **Add five repo secrets** under Settings, Secrets and variables, Actions:
   `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_KV_NAMESPACE_ID`
6. **Run it once:** Actions tab, OpenSky snapshot, Run workflow. The log should say "Stored N aircraft".
7. **Redeploy the site:** `npx wrangler pages deploy . --project-name flight-tracker`

## Notes

* Basemap: paste a CARTO basemaps key into `CARTO_KEY` at the top of the script in `index.html`, or leave it empty for keyless Esri tiles.
* GitHub runs scheduled jobs on a best effort basis, so snapshots can arrive a few minutes late. Planes keep moving along their heading in between.
* GitHub pauses scheduled workflows in public repos after 60 days with no commits. Push any small change, or re enable it from the Actions tab.
* Credits: 288 OpenSky calls a day at 4 credits each uses about 1,150 of your 4,000.
* Each run also makes about 70 adsb.fi queries, paced at one per second as its terms require, to fill regions OpenSky covers thinly. No free source covers mid ocean.
* KV: each run writes two keys (snapshot, tracks), about 580 writes a day against the free tier's 1,000.
* Data sources are free for non commercial use. Check each provider's terms before using it inside a business product.
* URLs are shareable: `#zoom/lat/lon/hex` restores the view and selected plane.
