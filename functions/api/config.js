// Cloudflare Pages Function: GET /api/config.js
// Hands the page its public settings, so they live in the Pages project's
// environment variables instead of being pasted into index.html.
//
//   CARTO_KEY  CARTO basemaps key. It's visible to visitors either way (tile
//              URLs carry it), so restrict it to your domain in CARTO.

export function onRequestGet({ env }) {
  const config = { cartoKey: env.CARTO_KEY || "" };
  return new Response(`window.FT_CONFIG = ${JSON.stringify(config)};\n`, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
