import crypto from "node:crypto";
import { config } from "@/lib/config";
import { cookie, githubAppConfigured, STATE_COOKIE } from "@/lib/github";

// Start connecting GitHub. Default: install the Goose GitHub App on the repositories the customer picks.
// ?mode=signin: the App is already installed, so only sign in to GitHub to prove access to it.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!githubAppConfigured()) return Response.redirect(new URL("/start?github=unavailable", url), 303);
  const state = crypto.randomBytes(16).toString("base64url");
  const g = config.github;
  const target = url.searchParams.get("mode") === "signin"
    ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(g.clientId)}&state=${state}`
    : `https://github.com/apps/${encodeURIComponent(g.slug)}/installations/new?state=${state}`;
  return new Response(null, { status: 303, headers: [["location", target], ["set-cookie", cookie(req, STATE_COOKIE, state, 600)]] });
}
