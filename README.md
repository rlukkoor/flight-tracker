# Flight Tracker

Live global map of commercial flights.

```
index.html                              the app
functions/api/states.js                 serves the latest global snapshot from KV
functions/api/lookup.js                 aircraft details and fallback routes (adsbdb), cached 6 hours
functions/api/track.js                  up to 20 hours of positions for one aircraft, from KV
functions/api/flight.js                 FlightAware schedule, times and gates (optional, needs AEROAPI_KEY)
functions/api/config.js                 public settings for the page (CARTO_KEY)
functions/api/live.js                   relay for the zoomed in live feed when the browser can't reach it
airlines.json                           airline names and codes (OpenFlights), for logos
scheduler/                              Cloudflare Worker that starts the snapshot job every 5 minutes
airports.json                           airport names and coordinates (OurAirports), loaded on first click
navaids.json                            radio navigation aid coordinates (OurAirports), for reading filed routes
favicon.svg, apple-touch-icon.png       site icons
.github/workflows/opensky-snapshot.yml  the snapshot job (started by the scheduler)
.github/scripts/snapshot.mjs            fetches OpenSky + adsb.fi, writes snapshot and track history to KV
```

OpenSky doesn't answer Cloudflare's servers and doesn't allow browser requests from other sites, so a scheduled GitHub Action fetches it and stores the result in Cloudflare R2 (or Workers KV). The site reads from there. A separate live feed (adsb.lol, airplanes.live) updates every 5 seconds straight from the browser when you zoom in, and always follows the selected plane.

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
9. **Recommended, R2 storage for a 2 minute refresh:** KV's free plan allows 1,000 writes a day and 25 MB per value, which limits refreshes to every 5 minutes and caps the track history. R2's free plan has no such limits for this use. Cloudflare asks for a payment method to turn R2 on, but usage here stays inside the free tier.
   1. Dashboard, R2, enable it, then `npx wrangler r2 bucket create flight-tracker`
   2. Pages project, Settings, Bindings, add an R2 bucket binding: variable name `FLIGHTS_R2`, bucket `flight-tracker`
   3. R2, Manage API tokens, Create API token, permission Object Read & Write, limited to the `flight-tracker` bucket. Copy the Access Key ID and Secret Access Key.
   4. GitHub repo secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` set to `flight-tracker`
   5. Redeploy the site, then redeploy the scheduler (`cd scheduler && npx wrangler deploy`), which now runs every 2 minutes
   Keep the KV binding: the FlightAware usage counter still lives there.
10. **Optional, FlightAware times:** sign up for AeroAPI's Personal tier, copy the API key, and run `npx wrangler pages secret put AEROAPI_KEY --project-name flight-tracker`, then redeploy. Lookups are cached 15 minutes per flight and capped at 900 a month (about $4.50, change with `AEROAPI_MONTHLY_LIMIT`) and 30 a day (`AEROAPI_DAILY_LIMIT`), so usage stays inside the free $5. Past either limit the page falls back to its own estimates until the next UTC day or month. When you click a flight that's out of receiver range (over an ocean, say), the site also loads FlightAware's recorded track. On the Personal tier that has ground receiver positions plus oceanic position reports where FlightAware gets them, but not satellite (Aireon) positions, which are Premium only. A track counts as 3 lookups (`AEROAPI_TRACK_UNITS`); check AeroAPI's per-query price table and lower it if tracks cost less.

## Notes

* Basemap: add your CARTO basemaps key as the `CARTO_KEY` environment variable in the Pages project settings (Production), then redeploy. Without it the map uses keyless Esri tiles. `index.html` never needs editing.
* GitHub's own scheduler is best effort and often late, so the Cloudflare scheduler worker starts the job instead. GitHub's schedule remains as an hourly backup.
* GitHub pauses the hourly backup schedule after 60 days with no commits. The Cloudflare scheduler isn't affected.
* Credits: at every 2 minutes, about 720 OpenSky calls a day at 4 credits each uses about 2,900 of your 4,000.
* Each run also makes about 70 adsb.fi queries, paced at one per second as its terms require, to fill regions OpenSky covers thinly. No free source covers mid ocean.
* Storage: with R2, each run writes 2 or 3 objects, about 2,000 writes a day against R2's free 1 million a month. With KV only, keep the scheduler at every 5 minutes (about 625 writes a day of the free 1,000), and note the track history stops saving if it passes 25 MB.
* The adsb.fi fill-in queries take about 75 seconds, so they run at most every 4 minutes (`FILL_EVERY_MIN`) and are reused in between.
* Airline logos load from pics.avs.io, falling back to images.kiwi.com.
* AeroAPI's Personal tier is for personal or academic use only.
* Data sources are free for non commercial use. Check each provider's terms before using it inside a business product.
* URLs are shareable: `#zoom/lat/lon/hex` restores the view and selected plane.
