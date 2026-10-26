// Flight tracker scheduler: a Cloudflare Worker with a cron trigger that starts
// the GitHub snapshot workflow every 5 minutes. GitHub's own scheduler is
// best effort and often runs late or skips runs; Cloudflare's cron is punctual.
//
// Deploy from this folder:  npx wrangler deploy
// Then add the token:       npx wrangler secret put GITHUB_TOKEN
// (a fine grained GitHub token with Actions: Read and write on the repo)

const WORKFLOW = "opensky-snapshot.yml";

async function dispatch(env) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "flight-tracker-scheduler",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
  });
  if (r.status !== 204) throw new Error(`GitHub dispatch failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return r.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // Visiting the worker's URL just reports that it's alive; it never triggers a run.
  async fetch() {
    return new Response("Flight tracker scheduler: starts the snapshot job every 5 minutes.\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
