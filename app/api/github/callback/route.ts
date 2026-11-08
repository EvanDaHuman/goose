import { cookie, GithubError, githubAppConfigured, installationsForCode, newSessionCookie, readCookie, STATE_COOKIE } from "@/lib/github";

// GitHub sends the customer back here after installing the App (or signing in). The installation id in this
// URL is never trusted: the one-time code proves who the customer is, and GitHub tells us which installations
// of the App that person can access. Only those ids go into the signed session cookie.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const headers: [string, string][] = [["set-cookie", cookie(req, STATE_COOKIE, "", 0)]];
  const back = (status: string) => {
    headers.push(["location", new URL(`/start?github=${status}`, url).toString()]);
    return new Response(null, { status: 303, headers });
  };
  if (!githubAppConfigured()) return back("unavailable");
  const state = url.searchParams.get("state");
  if (!state || state !== readCookie(req, STATE_COOKIE)) return back("expired");
  const code = url.searchParams.get("code");
  if (!code) return back("denied");
  try {
    const { ids, login } = await installationsForCode(code);
    if (!ids.length) return back("noaccess");
    headers.push(["set-cookie", newSessionCookie(req, ids, login)]);
    return back("connected");
  } catch (e) {
    console.error("GitHub callback failed:", e instanceof GithubError ? e.message : e);
    return back("error");
  }
}
