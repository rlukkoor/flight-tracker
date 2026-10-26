# Flight Tracker

Live global map of commercial flights.

```
index.html                              the app
functions/api/states.js                 serves the latest global snapshot from KV
functions/api/lookup.js                 aircraft details and fallback routes (adsbdb), cached 6 hours
functions/api/track.js                  up to 20 hours of positions for one aircraft, from KV
functions/api/flight.js                 FlightAware schedule, times and gates (optional, needs AEROAPI_KEY)
functions/api/live.js                   relay for the zoomed in live feed when the browser can't reach it
airlines.json                           airline names and codes (OpenFlights), for logos
scheduler/                              Cloudflare Worker that starts the snapshot job every 5 minutes
airports.json                           airport names and coordinates (OurAirports), loaded on first click
favicon.svg, apple-touch-icon.png       site icons
.github/workflows/opensky-snapshot.yml  the snapshot job (started by the scheduler)
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
8. **Start the scheduler:** create a fine grained GitHub token (Settings, Developer settings, Fine grained tokens) for this repo only, with the permission Actions: Read and write. Then:
   ```
   cd scheduler
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```
9. **Optional, FlightAware times:** sign up for AeroAPI's Personal tier, copy the API key, and run `npx wrangler pages secret put AEROAPI_KEY --project-name flight-tracker`, then redeploy. Lookups are cached 10 minutes per flight and capped at 30 a day (change with `AEROAPI_DAILY_LIMIT`), which stays inside the free $5 a month.

## Notes

* Basemap: paste a CARTO basemaps key into `CARTO_KEY` at the top of the script in `index.html`, or leave it empty for keyless Esri tiles.
* GitHub's own scheduler is best effort and often late, so the Cloudflare scheduler worker starts the job instead. GitHub's schedule remains as an hourly backup.
* GitHub pauses the hourly backup schedule after 60 days with no commits. The Cloudflare scheduler isn't affected.
* Credits: about 310 OpenSky calls a day at 4 credits each uses about 1,250 of your 4,000.
* Each run also makes about 70 adsb.fi queries, paced at one per second as its terms require, to fill regions OpenSky covers thinly. No free source covers mid ocean.
* KV: each run writes two keys (snapshot, tracks), about 625 writes a day, plus up to 30 for the FlightAware counter, against the free tier's 1,000.
* Airline logos load from pics.avs.io, falling back to images.kiwi.com.
* AeroAPI's Personal tier is for personal or academic use only.
* Data sources are free for non commercial use. Check each provider's terms before using it inside a business product.
* URLs are shareable: `#zoom/lat/lon/hex` restores the view and selected plane.
